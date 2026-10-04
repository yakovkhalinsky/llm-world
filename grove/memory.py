"""Ask the grove: a memory-keeper that answers from the world's own
chronicle. nomic-embed-text (local, small, idle until now) indexes the
chronicle lines; a question retrieves excerpts; the soul-tier model
answers from them in two gentle sentences. Everything stays local."""

import json
import re
import urllib.request

EMBED_MODEL = "nomic-embed-text"
BATCH = 160

ASK_SYSTEM = (
    "You are the memory-keeper of a small forest world. A visitor asked "
    "a question; you are given chronicle excerpts (with the week they "
    "belong to) and a brief digest of the world now. Answer from THOSE "
    "alone if possible: one to two complete sentences, at least eight "
    "words, warm and plain, no inventions. If the world's records say "
    "nothing about it, say so gently and offer what is known nearby."
)

ASK_SCHEMA = {
    "type": "object",
    "properties": {"answer": {"type": "string"}},
    "required": ["answer"],
}


def embed(llm, texts, timeout=150.0):
    """Embeddings from the local nomic model; list of float-vectors or
    None on any failure. The timeout must survive a chat call that
    holds the ollama runner before ours starts."""
    payload = {"model": EMBED_MODEL, "input": list(texts)}
    req = urllib.request.Request(
        llm.host + "/api/embed", data=json.dumps(payload).encode(),
        method="POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode()).get("embeddings")
    except Exception:
        return None


def ensure_index(db, llm, limit=BATCH):
    """Index chronicle lines not yet in the vector table, in batches
    the local embedder can actually carry. Returns lines embedded."""
    have = {r[0] for r in db.con.execute("SELECT key FROM vec").fetchall()}
    rows = db.con.execute(
        "SELECT kind, tick, text FROM chron WHERE source != 'raw' "
        "ORDER BY id DESC LIMIT 400").fetchall()
    todo = [(k, t, tx) for k, t, tx in rows if k not in have][:limit]
    if not todo:
        return 0
    CHUNK = 32            # 160-line batches fail on this box; 32 hold
    inserted = 0
    for start in range(0, len(todo), CHUNK):
        chunk = todo[start:start + CHUNK]
        vecs = embed(llm, [tx for _k, _t, tx in chunk])
        if not vecs or len(vecs) != len(chunk):
            vecs = embed(llm, [tx for _k, _t, tx in chunk],
                         timeout=200.0)     # one retry, deeper patience
        if not vecs or len(vecs) != len(chunk):
            continue      # this batch can wait; the rest keeps indexing
        for (k, t, tx), v in zip(chunk, vecs):
            db.con.execute(
                "INSERT OR REPLACE INTO vec (key, tick, text, vec, dim) "
                "VALUES (?, ?, ?, ?, ?)",
                (k, t, tx, json.dumps([round(x, 4) for x in v]), len(v)))
        db.con.commit()
        inserted += len(chunk)
    return inserted


def recall(db, llm, question, top=5, rows=None):
    """The most relevant chronicle lines for a question: [{tick, text}].
    rows: pre-fetched (key, tick, text, vec) tuples — a locked caller
    hands them over so the slow embed runs with no lock held."""
    if rows is None:
        rows = db.con.execute(
            "SELECT key, tick, text, vec FROM vec").fetchall()
    qv = embed(llm, [question])
    if not qv or not qv[0]:
        return []
    q = qv[0]
    out = []
    for key, tick, text, blob in rows:
        try:
            v = json.loads(blob)
        except json.JSONDecodeError:
            continue
        d = sum(a * b for a, b in zip(q, v)) \
            / (sum(a * a for a in q) ** 0.5 + 1e-9) \
            / (sum(b * b for b in v) ** 0.5 + 1e-9)
        out.append((d, tick, text))
    out.sort(reverse=True)
    return [{"tick": t, "text": tx} for _d, t, tx in out[:top]]