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
CREATE TABLE IF NOT EXISTS cache   (key TEXT PRIMARY KEY, text TEXT);
"""


class DB:
    def __init__(self, path):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self.path = path
        self.con = sqlite3.connect(path, timeout=30)
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
        rows = self.con.execute(
            "SELECT tick, source, text FROM chron WHERE source != 'raw' "
            "ORDER BY id DESC LIMIT ?", (n,)).fetchall()
        return rows[::-1]

    # -- llm narration cache -----------------------------------------------
    def cache_get(self, key):
        row = self.con.execute(
            "SELECT text FROM cache WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    def cache_set(self, key, text):
        self.con.execute(
            "INSERT OR REPLACE INTO cache (key, text) VALUES (?, ?)", (key, text))
        self.con.commit()