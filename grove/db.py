"""SQLite persistence: world snapshot, stats, events, chronicle, cache.

Chronicle rows: (tick, kind, source, text) where kind holds the event's
stable signature (`record` dedupes on it) — or 'rename' for voice lines.
source: 'raw' event dumps (data, not for display), 'template', 'llm',
'voice'. The whole world state is one JSON blob (row id=1).
"""

import json
import os
import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS world   (id INTEGER PRIMARY KEY, json TEXT, tick INTEGER);
CREATE TABLE IF NOT EXISTS stats   (tick INTEGER, json TEXT);
CREATE TABLE IF NOT EXISTS chron   (id INTEGER PRIMARY KEY AUTOINCREMENT,
                                    tick INTEGER, kind TEXT, source TEXT, text TEXT);
CREATE INDEX IF NOT EXISTS chron_kind ON chron (kind);
CREATE TABLE IF NOT EXISTS cache   (narr TEXT, line TEXT, slot INTEGER,
                    used INTEGER,
                    PRIMARY KEY (narr, slot));
CREATE TABLE IF NOT EXISTS bio     (oid INTEGER, tick INTEGER, key TEXT,
                                    id INTEGER PRIMARY KEY AUTOINCREMENT);
CREATE INDEX IF NOT EXISTS bio_oid ON bio (oid);
CREATE TABLE IF NOT EXISTS vec     (key TEXT PRIMARY KEY, tick INTEGER,
                                    text TEXT, vec TEXT, dim INTEGER);
CREATE TABLE IF NOT EXISTS proposals (id INTEGER PRIMARY KEY AUTOINCREMENT,
                                    week INTEGER, status TEXT, rule TEXT,
                                    value REAL, why TEXT, verdict TEXT);
"""


class DB:
    def __init__(self, path):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self.path = path
        self.con = sqlite3.connect(path, timeout=30, check_same_thread=False)
        self.con.executescript(SCHEMA)
        self.con.commit()

    def close(self):
        try:
            self.con.commit()
            self.con.close()
        except sqlite3.Error:
            pass

    # -- world ------------------------------------------------------------
    def save_world(self, world):
        blob = json.dumps(world, separators=(",", ":"))
        self.con.execute(
            "INSERT OR REPLACE INTO world (id, json, tick) VALUES (1, ?, ?)",
            (blob, world["tick"]))
        self.con.commit()

    def load_world(self):
        row = self.con.execute("SELECT json FROM world WHERE id = 1").fetchone()
        return json.loads(row[0]) if row else None

    # -- stats ------------------------------------------------------------
    def add_stats(self, tick, pops, plant_pops):
        self.con.execute(
            "INSERT INTO stats (tick, json) VALUES (?, ?)",
            (tick, json.dumps({"pop": pops, "plants": plant_pops})))
        self.con.commit()

    def history(self, limit=48):
        rows = self.con.execute(
            "SELECT tick, json FROM stats ORDER BY tick DESC LIMIT ?",
            (limit,)).fetchall()
        return [(t, json.loads(j)) for t, j in reversed(rows)]

    # -- raw events (data/debug, not rendered) ------------------------------
    def add_events(self, events):
        self.con.executemany(
            "INSERT INTO chron (tick, kind, source, text) VALUES (?, 'raw', 'raw', ?)",
            [(e["tick"], json.dumps(e, separators=(",", ":"))) for e in events])
        self.con.commit()

    # -- chronicle lines ----------------------------------------------------
    def record(self, key, tick, text, source="template"):
        """Insert the line for an event signature once; return the row id."""
        row = self.con.execute("SELECT id FROM chron WHERE kind = ? LIMIT 1",
                               (key,)).fetchone()
        if row is None:
            cur = self.con.execute(
                "INSERT INTO chron (tick, kind, source, text) "
                "VALUES (?, ?, ?, ?)", (tick, key, source, text))
            self.con.commit()
            return cur.lastrowid
        return row[0]

    def update_text(self, key, text):
        """Replace a pending template line with the LLM's version."""
        cur = self.con.execute(
            "UPDATE chron SET text = ?, source = 'llm' "
            "WHERE kind = ? AND source != 'raw'", (text, key))
        self.con.commit()

    def add_line(self, tick, kind, text, source="voice"):
        cur = self.con.execute(
            "INSERT INTO chron (tick, kind, source, text) VALUES (?, ?, ?, ?)",
            (tick, kind, source, text))
        self.con.commit()
        return cur.lastrowid

    def chronicle(self, tail=50):
        return self.con.execute(
            "SELECT id, tick, kind, source, text FROM chron "
            "WHERE source != 'raw' ORDER BY id DESC LIMIT ?",
            (tail,)).fetchall()[::-1]

    def chronicle_all(self):
        return self.con.execute(
            "SELECT id, tick, kind, source, text FROM chron "
            "WHERE source != 'raw' ORDER BY id").fetchall()

    def chronicle_lines(self, n=8):
        """Renderable lines (raw events excluded, no consecutive
        repeats), NEWEST FIRST — feeds read top-down from the latest."""
        rows = self.con.execute(
            "SELECT tick, source, text FROM chron WHERE source != 'raw' "
            "ORDER BY id DESC LIMIT 60").fetchall()
        out, seen = [], set()
        for tick, source, text in rows:
            norm = text.strip().lower()
            if norm in seen:
                continue
            seen.add(norm)
            out.append((tick, source, text))
            if len(out) >= n:
                break
        return out

    # -- biographies --------------------------------------------------------
    def add_bio(self, oid, key, tick):
        self.con.execute(
            "INSERT INTO bio (oid, tick, key) VALUES (?, ?, ?)",
            (oid, tick, key))
        self.con.commit()

    def add_amendment(self, week, status, rule, value, why, verdict):
        self.con.execute(
            "INSERT INTO proposals (week, status, rule, value, why, "
            "verdict) VALUES (?, ?, ?, ?, ?, ?)",
            (week, status, rule, value, (why or "")[:200],
             (verdict or "")[:200]))
        self.con.commit()

    # -- the world's own constitution, persisted across restarts -----------
    def override_path(self, data_dir):
        import os
        return os.path.join(data_dir, "world_rules.json")

    def save_override(self, data_dir, rules_mod):
        path = self.override_path(data_dir)
        with open(path, "w") as f:
            json.dump(rules_mod.R, f, indent=1, sort_keys=True,
                      default=str)

    def bio(self, oid):
        rows = self.con.execute(
            "SELECT b.tick, c.text FROM bio b "
            "JOIN chron c ON c.kind = b.key WHERE b.oid = ? "
            "AND c.source != 'raw' ORDER BY b.tick, b.id", (oid,)).fetchall()
        return [{"tick": t, "text": tx} for t, tx in rows]

    # -- llm narration cache -----------------------------------------------
    def cache_get(self, narr):
        """Serve one of up to three stored renderings, round-robin."""
        rows = self.con.execute(
            "SELECT line, slot, used FROM cache WHERE narr = ? "
            "ORDER BY used, slot", (narr,)).fetchall()
        if not rows:
            return None
        line, slot, used = rows[0]
        nxt = (max(r[2] for r in rows) + 1) if len(rows) > 1 else used + 1
        self.con.execute("UPDATE cache SET used = ? WHERE narr = ? AND slot = ?",
                         (nxt, narr, slot))
        self.con.commit()
        return line

    def cache_set(self, narr, text):
        """Store up to three distinct renderings per story-signature."""
        have = self.con.execute(
            "SELECT COUNT(*) FROM cache WHERE narr = ?", (narr,)).fetchone()[0]
        if have >= 3:
            dup = self.con.execute(
                "SELECT 1 FROM cache WHERE narr = ? AND line = ?",
                (narr, text)).fetchone()
            if dup:
                return
            self.con.execute(
                "DELETE FROM cache WHERE narr = ? AND slot = ("
                "SELECT slot FROM cache WHERE narr = ? ORDER BY used ASC "
                "LIMIT 1)", (narr, narr))
        self.con.execute(
            "INSERT INTO cache (narr, line, slot, used) VALUES (?, ?, ?, 0)",
            (narr, text, have))
        self.con.commit()