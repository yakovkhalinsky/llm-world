"""The grove's water as the page draws it, through `tools/water_check.js`
on real groves' snapshots — and the check itself, against pages that draw
the water wrong.

Yakov: "the water in the grove isn't continuous". The creek's cells were
always one stream four ways, but the page laid a sheet per cell turned
down the flow, so every bend left a turned square with dark corners, and
a ford's ground rose out of the creek with a faint sheet on the stones.
The check holds the page to one stream: each kind of water a single
surface at one level covering its cells whole, edge to edge, a ripple
with no seams running source to mouth, and the floor under the water all
the way down, fords too; and with the ford's stones under the creek,
nothing the sim grows there stands under it.

Each mutant below is a wrong `water.js` the check must reject, and each
asserts the failure it should be caught by. The check's world.js lint
reads source, so it has no mutants here.

Needs Node; skipped without it."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest

from tests.helpers import ROOT, snapshot_of

NODE = shutil.which("node")
CHECK = os.path.join(ROOT, "tools", "water_check.js")
WATER = os.path.join(ROOT, "grove", "page3d", "water.js")
WORLD = os.path.join(ROOT, "grove", "page3d", "world.js")

# the live grove's seed, the issue's, and a spread; then other sizes
SEEDS = [9338, 42, 7, 1234, 5555] + list(range(1, 31))
SIZES = [(42, 12), (7, 16), (5555, 32)]


@unittest.skipUnless(NODE, "node is not installed")
class WaterCheckTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        cls.snaps = []
        for seed, size in [(s, None) for s in SEEDS] + SIZES:
            st = snapshot_of(seed, size)
            p = os.path.join(cls.dir.name, "s%d_%s.json" % (seed, size))
            with open(p, "w") as f:
                json.dump(st, f)
            cls.snaps.append((seed, size, p, st))
        cls.snap = cls.snaps[0][2]
        cls.state = cls.snaps[0][3]
        cls.legacy = cls.write("legacy.json", cls.legacy_world(cls.state))
        cls.fordy = cls.write("fordy.json", cls.ford_plants(cls.state))

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    @classmethod
    def write(cls, name, st):
        p = os.path.join(cls.dir.name, name)
        with open(p, "w") as f:
            json.dump(st, f)
        return p

    @staticmethod
    def legacy_world(st):
        """A world from before creeks: no creek, and two cells of water
        that touch only at a corner (and a third at another corner)."""
        st = json.loads(json.dumps(st))
        n = st["size"]
        st.pop("creeks", None)
        for c in st["cells"]:
            if c[0] == "w" or c[6]:
                c[0], c[6] = "s", ""
        for x, y in ((3, 3), (4, 4), (5, 3)):
            c = st["cells"][y * n + x]
            c[0], c[6] = "w", ""
        return st

    @staticmethod
    def ford_plants(st):
        """The sim grows plants on fords (the live grove has an old pine on
        each of its two): a pine, a mushroom and a carcass on every ford."""
        st = json.loads(json.dumps(st))
        n = st["size"]
        for i, c in enumerate(st["cells"]):
            if c[6] == "f":
                st["plants"].append({"id": 900000 + i, "sp": "pine",
                                     "x": i % n, "y": i // n, "st": "old",
                                     "el": 1, "b": 0, "n": None})
                c[3], c[4] = 1, 1
        return st

    def run_check(self, snap=None, water=None, world=None):
        env = dict(os.environ)
        if water:
            env["GROVE_WATER"] = water
        if world:
            env["GROVE_WORLD"] = world
        return subprocess.run([NODE, CHECK, snap or self.snap], env=env,
                              capture_output=True, text=True, timeout=60)

    def mutant(self, src_path, *edits):
        with open(src_path) as f:
            src = f.read()
        for old, new in edits:
            self.assertEqual(src.count(old), 1, old)
            src = src.replace(old, new)
        path = os.path.join(self.dir.name, "mutant_" +
                            os.path.basename(src_path))
        with open(path, "w") as f:
            f.write(src)
        return path

    def rejects(self, phrase, snap=None, water=(), *more):
        r = self.run_check(snap, self.mutant(WATER, *water))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        for p in (phrase,) + more:
            self.assertIn(p, r.stdout)
        return r

    # -- the real page ---------------------------------------------------
    def test_every_groves_creek_is_one_stream_on_the_page(self):
        for seed, size, p, _st in self.snaps:
            with self.subTest(seed=seed, size=size):
                r = self.run_check(p)
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                rep = json.loads(r.stdout)
                self.assertGreaterEqual(rep["creeks"], 1)
                self.assertGreaterEqual(rep["ponds"], 1)
                self.assertGreater(rep["fords"], 0)
                self.assertEqual(rep["seams"], 0)
                self.assertLess(rep["floorMaxOnCreeks"], 0)

    def test_nothing_on_a_ford_stands_under_the_creek(self):
        r = self.run_check(self.fordy)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        rep = json.loads(r.stdout)
        self.assertGreaterEqual(rep["standingOnFords"], 3)
        self.assertGreaterEqual(rep["standLowest"], 0)

    def test_world_js_passes_the_lint(self):
        r = self.run_check(world=WORLD)
        self.assertNotIn("lint:", r.stdout)

    def test_water_touching_at_a_corner_is_joined(self):
        r = self.run_check(self.legacy)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(json.loads(r.stdout)["diagonalJoins"], 2)

    # -- snapshots that are wrong ----------------------------------------
    def test_rejects_a_creek_that_steps_by_a_corner(self):
        st = json.loads(json.dumps(self.state))
        path = st["creeks"][0]
        k = next(k for k in range(1, len(path) - 1)
                 if path[k - 1][0] != path[k + 1][0]
                 and path[k - 1][1] != path[k + 1][1])
        del path[k]
        self.rejects("a creek steps by a corner",
                     snap=self.write("corner.json", st))

    # -- pages that draw the water wrong ---------------------------------
    def test_rejects_a_sheet_per_cell_turned_down_the_flow(self):
        # the squares turned (as the old sheets were at every bend)
        self.rejects(
            "a cell of water is not covered whole by its own surface",
            water=[("[[x, z], [x, z + 1], [x + 1, z], [x + 1, z + 1]]",
                    "[[x + 0.5, z - 0.2], [x - 0.2, z + 0.5], "
                    "[x + 1.2, z + 0.5], [x + 0.5, z + 1.2]]")])

    def test_rejects_a_ford_not_drawn(self):
        self.rejects(
            "a cell of water is not covered whole by its own surface (ford",
            water=[("if (!K[i]) continue;",
                    "if (!K[i] || K[i] === FORD) continue;")])

    def test_rejects_a_ford_risen_out_of_the_creek(self):
        self.rejects("the floor rises out of a creek",
                     water=[("var FORD_BED = -0.08;",
                             "var FORD_BED = 0.142;")])

    def test_rejects_a_ripple_per_cell(self):
        self.rejects("a seam in a creek's ripple", water=[(
            "        s.pos.push(p[0], p[1]);\n"
            "        var uv = uvOf(fr, p[0], p[1]);",
            "        s.pos.push(p[0], p[1]);\n"
            "        var uv = uvOf(fr, p[0] - x, p[1] - z);")])

    def test_rejects_a_wedge_off_the_creeks_ripple(self):
        # a creek pinched at a bend, so its cells meet at a corner and a
        # wedge joins them: the wedge's uv is held to the squares' it meets
        st = json.loads(json.dumps(self.state))
        n = st["size"]
        path = st["creeks"][0]
        k = next(k for k in range(1, len(path) - 1)
                 if path[k - 1][0] != path[k + 1][0]
                 and path[k - 1][1] != path[k + 1][1])
        c = st["cells"][path[k][1] * n + path[k][0]]
        c[0], c[6] = "s", ""
        pinched = self.write("pinched.json", st)
        base = self.run_check(pinched)
        self.assertGreaterEqual(json.loads(base.stdout)["diagonalJoins"], 1)
        self.assertEqual(json.loads(base.stdout)["seams"], 0)
        self.rejects("a seam in a creek's ripple", pinched, [(
            "      s.pos.push(p[0], p[1]);\n"
            "      var uv = uvOf(fr, p[0], p[1]);",
            "      s.pos.push(p[0], p[1]);\n"
            "      var uv = uvOf(fr, p[0] + 0.1, p[1]);")])

    def test_rejects_a_ripple_running_upstream(self):
        self.rejects("a creek's ripple runs upstream", water=[(
            "< 0 ? -1 : 1;", "< 0 ? 1 : -1;")])

    def test_rejects_corners_left_unjoined(self):
        self.rejects("water touching only at a corner is not joined",
                     snap=self.legacy,
                     water=[("var WEDGE = 0.35;", "var WEDGE = 0;")])

    def test_rejects_wedges_over_dry_land(self):
        # a wedge reaching over half a dry cell: both the size and the
        # probes a quarter in from each corner catch it
        for w in ("0.6", "0.9"):
            with self.subTest(wedge=w):
                self.rejects("water drawn over dry land", self.legacy,
                             [("var WEDGE = 0.35;", "var WEDGE = %s;" % w)],
                             "a corner's wedge is not under half a cell")

    def test_rejects_drawn_points_at_two_levels(self):
        self.rejects("a point of water off the one level", water=[(
            "position[k * 3 + 1] = Y;", "position[k * 3 + 1] = Y + (k % 4) * 0.01;")])

    def test_rejects_normals_not_up(self):
        self.rejects("a normal of the water not straight up", water=[(
            "normal[k * 3 + 1] = 1;", "normal[k * 3 + 2] = 1;")])

    def test_rejects_an_index_past_the_points(self):
        self.rejects("an index past the points", water=[(
            ": new Uint16Array(s.idx)",
            ": new Uint16Array(s.idx.map(function (j) { return j + 1; }))")])

    def test_rejects_a_plant_standing_on_a_fords_stones(self):
        self.rejects("something stands under the water", self.fordy, [(
            "return Math.max(floor(x, z), Y);", "return floor(x, z);")])

if __name__ == "__main__":
    unittest.main()
