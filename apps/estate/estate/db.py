"""SQLite persistence: the whole estate as one blob, plus its census.

One row holds the world; one row a day holds the census the sparklines and
the gate read. Every write commits immediately, so a kill costs at most the
day in flight — Grove's rule, and the reason its own restarts were safe.

A column added later arrives by `_migrate`, because `CREATE TABLE IF NOT
EXISTS` leaves an older table alone and a world must be able to read itself
back (b52).
"""

import json
import os
import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS world (id INTEGER PRIMARY KEY, json TEXT, day INTEGER);
CREATE TABLE IF NOT EXISTS stats (day INTEGER, json TEXT);
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

    # -- the estate -------------------------------------------------------
    def save_world(self, world):
        blob = json.dumps(world, separators=(",", ":"))
        self.con.execute(
            "INSERT OR REPLACE INTO world (id, json, day) VALUES (1, ?, ?)",
            (blob, world["day"]))
        self.con.commit()

    def load_world(self):
        row = self.con.execute("SELECT json FROM world WHERE id = 1").fetchone()
        return json.loads(row[0]) if row else None

    # -- the census -------------------------------------------------------
    def add_stats(self, day, census):
        self.con.execute("INSERT INTO stats (day, json) VALUES (?, ?)",
                         (day, json.dumps(census)))
        self.con.commit()

    def history(self, limit=64):
        rows = self.con.execute(
            "SELECT day, json FROM stats ORDER BY day DESC LIMIT ?",
            (limit,)).fetchall()
        return [(d, json.loads(j)) for d, j in reversed(rows)]
