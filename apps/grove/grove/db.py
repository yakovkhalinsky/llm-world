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
                                    value REAL, was REAL, why TEXT,
                                    verdict TEXT);
"""


class DB:
    def __init__(self, path):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self.path = path
        self.con = sqlite3.connect(path, timeout=30, check_same_thread=False)
        self.con.executescript(SCHEMA)
        self._migrate()
        self.con.commit()

    def _migrate(self):
        """Columns added since a world was last opened. `IF NOT EXISTS`
        leaves an older table alone, so they arrive here."""
        have = {r[1] for r in
                self.con.execute("PRAGMA table_info(proposals)").fetchall()}
        if "was" not in have:                 # what an amendment replaced
            self.con.execute("ALTER TABLE proposals ADD COLUMN was REAL")

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

    def add_amendment(self, week, status, rule, value, why, verdict,
                      was=None):
        """`was` is the value in force when the amendment was made — the
        live ruleset moves on, so an amended rule's old value cannot be
        recovered from it afterwards."""
        self.con.execute(
            "INSERT INTO proposals (week, status, rule, value, was, why, "
            "verdict) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (week, status, rule, value, was, (why or "")[:200],
             (verdict or "")[:200]))
        self.con.commit()

    # -- the world's own constitution, persisted across restarts -----------
    def override_path(self, data_dir):
        import os
        return os.path.join(data_dir, "world_rules.json")

    def save_override(self, data_dir, rules_mod):
        """The world's constitution, written whole and written at once.

        Keys go out as strings — JSON has no others — which also settles
        the one crash this could have: a mixed int/str table makes
        `sort_keys` raise, and the raise arrived mid-write, so the file was
        left truncated and the world could not read its own constitution
        back. A world that had just been told its amendment was applied
        would lose it on the next waking. Written to a neighbour and moved
        into place, so the file is either the old law or the new one."""
        path = self.override_path(data_dir)
        tmp = path + ".tmp"

        def strkeys(node):
            if isinstance(node, dict):
                return {str(k): strkeys(v) for k, v in node.items()}
            if isinstance(node, (list, tuple)):
                return [strkeys(v) for v in node]
            return node

        with open(tmp, "w") as f:
            json.dump(strkeys(rules_mod.R), f, indent=1, sort_keys=True,
                      default=str)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)

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
        """Store up to three distinct renderings per story-signature.
        The duplicate check runs at every level (an identical line never
        occupies a second slot, so a read never serves it twice in one
        round-robin sweep); at capacity the evicted slot is reused."""
        dup = self.con.execute(
            "SELECT 1 FROM cache WHERE narr = ? AND line = ?",
            (narr, text)).fetchone()
        if dup:
            return
        have = self.con.execute(
            "SELECT COUNT(*) FROM cache WHERE narr = ?", (narr,)).fetchone()[0]
        if have >= 3:
            slot = self.con.execute(
                "SELECT slot FROM cache WHERE narr = ? "
                "ORDER BY used ASC, slot ASC LIMIT 1",
                (narr,)).fetchone()[0]
            self.con.execute("DELETE FROM cache WHERE narr = ? AND slot = ?",
                             (narr, slot))
        else:
            slot = have
        self.con.execute(
            "INSERT INTO cache (narr, line, slot, used) VALUES (?, ?, ?, 0)",
            (narr, text, slot))
        self.con.commit()