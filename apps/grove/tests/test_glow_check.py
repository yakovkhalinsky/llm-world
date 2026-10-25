"""Tonight's glowing mushroom rings, through `tools/glow_check.js` on real
groves' snapshots — and the check itself, against choosers that are wrong.

Each mutant below is a wrong `glow.js` the check must reject, and each
asserts the failure it should be caught by, so every clause of the check
has a mutant that only passes if the clause is gone.

Needs Node; skipped without it."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest

from grove import web

from tests.helpers import ROOT, make_grove

NODE = shutil.which("node")
CHECK = os.path.join(ROOT, "tools", "glow_check.js")
GLOW = os.path.join(ROOT, "grove", "page3d", "glow.js")
SHARE = "var SHARE = 0.33;"
DRAW = "var h = score(ring.key, night);"
FALLBACK = "if (!lit.length && best) lit.push(best);"
CARRY = ("        if (wasLit) { lit.push(ring); continue; }\n"
         "        if (stood) continue;\n")

# (seed, week) of groves whose mushrooms stand two weeks running, each
# with rings that a week's growth rekeys (so without the carry some would
# flip in the dark); the first is the one the mutants run on
WEEKS = [(7, 30), (7, 5), (3, 27), (42, 32), (2, 28)]


def snapshots(seed, week):
    """The grove's state at `week` and a week on, as /api/state sends."""
    tmp, data, g, lock, runner = make_grove(seed, week)
    try:
        a = web.snapshot(g, runner, lock)
        g.step()
        b = web.snapshot(g, runner, lock)
    finally:
        g.db.con.close()
        tmp.cleanup()
    return a, b


@unittest.skipUnless(NODE, "node is not installed")
class GlowCheckTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        cls.snaps = []
        for seed, week in WEEKS:
            a, b = snapshots(seed, week)
            pa = os.path.join(cls.dir.name, "s%d_%d.json" % (seed, week))
            pb = os.path.join(cls.dir.name, "s%d_%d_next.json" % (seed, week))
            for p, s in ((pa, a), (pb, b)):
                with open(p, "w") as f:
                    json.dump(s, f)
            cls.snaps.append((pa, pb, a, b))
        cls.snap, cls.next, cls.state, _ = cls.snaps[0]

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def run_check(self, glow=None, snap=None, nxt=None):
        env = dict(os.environ)
        if glow:
            env["GROVE_GLOW"] = glow
        return subprocess.run(
            [NODE, CHECK, snap or self.snap, nxt or self.next], env=env,
            capture_output=True, text=True, timeout=120)

    def mutant(self, *edits):
        with open(GLOW) as f:
            src = f.read()
        for old, new in edits:
            self.assertEqual(src.count(old), 1, old)
            src = src.replace(old, new)
        path = os.path.join(self.dir.name, "glow_mutant.js")
        with open(path, "w") as f:
            f.write(src)
        return path

    def rejects(self, phrase, *edits):
        r = self.run_check(self.mutant(*edits))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn(phrase, r.stdout)

    # -- the real glow.js ------------------------------------------------
    def test_the_groves_have_many_rings_both_weeks(self):
        for _pa, _pb, a, b in self.snaps:
            for s in (a, b):
                mush = [c for c in s["cells"] if c and c[3]]
                self.assertGreater(len(mush), 20)

    def test_the_page_lights_about_one_ring_in_three(self):
        for pa, pb, _a, _b in self.snaps:
            r = self.run_check(snap=pa, nxt=pb)
            self.assertEqual(r.returncode, 0, pa + r.stdout + r.stderr)
            rep = json.loads(r.stdout)
            self.assertTrue(rep["serverFieldMatch"])
            self.assertGreaterEqual(rep["rings"], 20)
            self.assertGreater(rep["litShare"], 0.3)
            self.assertLess(rep["litShare"], 0.36)

    def test_a_weeks_rebuild_in_the_dark_flips_no_ring(self):
        """The page rebuilds its rings every week; through a night the
        lit set is carried, so a surviving ring keeps its state. Without
        the carry these same weeks flip some (the test has teeth)."""
        flips_without = 0
        for pa, pb, _a, _b in self.snaps:
            rep = json.loads(self.run_check(snap=pa, nxt=pb).stdout)
            c = rep["carry"]
            self.assertGreater(c["survivingRingNights"], 0, pa)
            self.assertEqual(c["flips"], 0, pa)
            self.assertEqual(c["lostCells"], 0, pa)
            flips_without += c["flipsWithoutCarry"]
        self.assertGreater(flips_without, 100)

    # -- choosers that are wrong ----------------------------------------
    def test_rejects_every_ring_lit(self):
        self.rejects("most nights light one ring or every ring",
                     (SHARE, "var SHARE = 1.0;"))

    def test_rejects_one_ring_a_night(self):
        self.rejects("most nights light one ring or every ring",
                     (SHARE, "var SHARE = 0;"))

    def test_rejects_a_key_blind_draw(self):
        # every ring draws the same: all lit, or only the fallback
        self.rejects("most nights light one ring or every ring",
                     (DRAW, "var h = score(0, night);"))

    def test_rejects_a_rota(self):
        # each ring lit every fourth night
        self.rejects("lit tonight predicts lit", (
            DRAW, "var h = (hash01(ring.key, 4241) + (night | 0) * 0.25) % 1;"))

    def test_rejects_a_first_ring_fallback(self):
        self.rejects("fallback is not the ring closest to passing",
                     (FALLBACK, "if (!lit.length && all.length) lit.push(all[0]);"))

    def test_rejects_the_old_share_025(self):
        self.rejects("lit share is not about one in three",
                     (SHARE, "var SHARE = 0.25;"))

    def test_rejects_share_040(self):
        self.rejects("lit share is not about one in three",
                     (SHARE, "var SHARE = 0.40;"))

    def test_rejects_a_lit_ring_missing_its_last_cell(self):
        self.rejects("a lit ring has a dark cell", (
            "for (var j = 0; j < lit[q].cells.length; j++)",
            "for (var j = 0; j < lit[q].cells.length - 1; j++)"))

    def test_rejects_a_dark_night(self):
        # a share so low that most nights pass no ring, and no fallback
        self.rejects("light none", (FALLBACK, ""),
                     (SHARE, "var SHARE = 0.001;"))

    def test_rejects_a_field_unlike_the_servers(self):
        self.rejects("differ from the server",
                     ("var REACH = 2.6;", "var REACH = 3.2;"))

    def test_rejects_a_random_choice(self):
        self.rejects("not deterministic", (DRAW, "var h = Math.random();"))

    def test_rejects_the_same_rings_every_night(self):
        self.rejects("every night lights the same rings",
                     (DRAW, "var h = score(ring.key, 0);"))

    def test_rejects_glow_far_from_a_lit_ring(self):
        # unlit cells painted as sources
        self.rejects("glows far from a lit ring", (
            "if (!litCell[s]) continue;",
            "if (!litCell[s] && s % 5) continue;"))

    def test_rejects_light_on_a_cell_with_no_mushroom(self):
        self.rejects("lights a cell with no mushroom", (
            "    var mushCell = new Uint8Array(N * N);\n",
            "    for (var z = 0; z < N * N; z++) {\n"
            "      if (!isMush(cells, z)) { litCell[z] = 1; break; }\n"
            "    }\n"
            "    var mushCell = new Uint8Array(N * N);\n"))

    def test_rejects_touching_rings(self):
        # four neighbours: diagonal mushrooms split into touching rings
        self.rejects("rings touch", (
            "if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;",
            "if (nx < 0 || ny < 0 || nx >= N || ny >= N || (dx && dy)) continue;"))

    def test_rejects_a_rebuild_without_the_carry(self):
        self.rejects("a surviving ring flips in the dark", (CARRY, ""))

    def test_rejects_a_rebuild_that_never_carries(self):
        self.rejects("a surviving ring flips in the dark", (
            "var carry = prev && dark > DARK_ON ? prev : null;",
            "var carry = null;"))

    def test_rejects_a_rebuild_that_carries_by_day(self):
        self.rejects("the daytime rebuild is not a fresh choice", (
            "var carry = prev && dark > DARK_ON ? prev : null;",
            "var carry = prev;"))


    def test_rejects_light_on_an_unlit_ring(self):
        self.rejects("a cell outside the lit rings is lit", (
            "    var mushCell = new Uint8Array(N * N);\n",
            "    if (all.length) all[0].cells.forEach(function (z) { litCell[z] = 1; });\n"
            "    var mushCell = new Uint8Array(N * N);\n"))

    def test_rejects_a_carried_ring_losing_a_cell(self):
        self.rejects("a lit cell still standing goes dark mid-night", (
            "for (var j = 0; j < lit[q].cells.length; j++)",
            "for (var j = 0; j < lit[q].cells.length - (carry ? 1 : 0); j++)"))

    def test_rejects_a_ring_lit_every_night(self):
        self.rejects("a ring is lit far from one night in three", (
            DRAW, "var h = r === 0 ? 0 : score(ring.key, night);"))

    def test_rejects_a_draw_that_is_not_the_score(self):
        # as fair as the real one, but not the draw `score` documents
        self.rejects("lit rings are not the ones whose draw is under SHARE",
                     (DRAW, "var h = score(ring.key, night + 1);"))

    def test_rejects_a_wrong_mushroom_map(self):
        self.rejects("mushCell is not the mushroom cells", (
            "if (isMush(cells, i)) mushCell[i] = 1;",
            "if (isMush(cells, i) && i % 2) mushCell[i] = 1;"))

    def test_rejects_lone_mushrooms_in_no_ring(self):
        self.rejects("mushroom cell in no ring", (
            "      out.push(ring);", "      if (ring.cells.length > 1) out.push(ring);"))

    def test_rejects_a_ring_cell_with_no_mushroom(self):
        self.rejects("ring cell has no mushroom", (
            "      out.push(ring);",
            "      ring.cells.push(ring.key % N ? ring.key - 1 : ring.key + 1);\n"
            "      out.push(ring);"))

    def test_rejects_a_cell_in_two_rings(self):
        self.rejects("cell in two rings", (
            "      out.push(ring);", "      ring.cells.push(ring.key);\n      out.push(ring);"))

    def test_rejects_a_ring_keyed_off_its_first_cell(self):
        self.rejects("ring key is not its first cell", (
            "var ring = { key: i, cells: [] };", "var ring = { key: i + 1, cells: [] };"))


if __name__ == "__main__":
    unittest.main()
