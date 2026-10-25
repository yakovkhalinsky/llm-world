"""The page draws a thinned forest — paths from the fords, clearings, open
banks, at most one standing tree a cell — and fades the trees between the
camera and the creature it looks at. `tools/forest_check.js` checks both on
a real grove; a mutant that lets trees back onto the paths must fail it.
It needs Node, so this skips without it."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest

from grove import web

from tests.helpers import ROOT, make_grove

NODE = shutil.which("node")


def _read(p):
    with open(p) as f:
        return f.read()

CHECK = os.path.join(ROOT, "tools", "forest_check.js")
FOREST = os.path.join(ROOT, "grove", "page3d", "forest.js")
WORLD = os.path.join(ROOT, "grove", "page3d", "world.js")


@unittest.skipUnless(NODE, "node is not installed")
class ForestCheckTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        cls.snaps = []
        for seed, steps in ((42, 20), (7, 6), (3, 0)):
            tmp, data, g, lock, runner = make_grove(seed, steps)
            try:
                state = web.snapshot(g, runner, lock)
            finally:
                g.db.con.close()
                tmp.cleanup()
            p = os.path.join(cls.dir.name, "state-%d.json" % seed)
            with open(p, "w") as f:
                json.dump(state, f)
            cls.snaps.append(p)

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def _run(self, snap, env=None):
        return subprocess.run(
            [NODE, CHECK, snap], cwd=ROOT, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, timeout=120,
            env=dict(os.environ, **(env or {})))

    def test_the_forest_is_thinned_and_sees_through(self):
        for snap in self.snaps:
            run = self._run(snap)
            self.assertEqual(run.returncode, 0, run.stdout)
            self.assertIn("forest check ok", run.stdout)

    def test_the_router_reaches_all_land_at_every_size(self):
        # the sim's land is one piece four ways; the page's router, four
        # ways round the trunks, must reach all of it on every map
        bad = []
        for size in (12, 16, 24, 32):
            for seed in (1, 5, 9, 13, 17):
                tmp, data, g, lock, runner = make_grove(seed, 0, size)
                try:
                    state = web.snapshot(g, runner, lock)
                finally:
                    g.db.con.close()
                    tmp.cleanup()
                p = os.path.join(self.dir.name, "s-%d-%d.json" % (size, seed))
                with open(p, "w") as f:
                    json.dump(state, f)
                run = self._run(p)
                if "the router cannot reach" in run.stdout:
                    bad.append((size, seed, run.stdout))
        self.assertEqual(bad, [])

    def _mutant(self, src, old, new, name):
        self.assertIn(old, src)
        p = os.path.join(self.dir.name, name)
        with open(p, "w") as f:
            f.write(src.replace(old, new, 1))
        return p

    def test_the_page_drawing_every_tree_fails(self):
        # world.js drawing the whole forest, not the drawList: the trees
        # drawn would no longer be the trunks the creatures walk round
        src = _read(WORLD)
        for old, new in (
                ("const list = Forest.drawList(st);",
                 "const list = st.plants || [];"),
                ("    for (const p of list) {\n",
                 "    for (const p of (st.plants || [])) {\n")):
            p = self._mutant(src, old, new, "world_mutant.js")
            run = self._run(self.snaps[0], {"WORLD_JS": p})
            self.assertNotEqual(run.returncode, 0, (old, run.stdout))
            self.assertIn("buildPlants", run.stdout)

    def test_a_drawlist_that_keeps_every_plant_fails(self):
        src = _read(FOREST)
        p = self._mutant(src, "&& !!shown[p.id];", ";", "forest_list.js")
        run = self._run(self.snaps[0], {"FOREST_JS": p})
        self.assertNotEqual(run.returncode, 0, run.stdout)
        self.assertIn("drawList", run.stdout)

    def test_a_forest_on_its_paths_fails(self):
        src = _read(FOREST)
        line = "        if (Z.path[key] || Z.clear[key] || standing[key]) return;\n"
        self.assertIn(line, src)
        mutant = src.replace(line, "        if (standing[key]) return;\n", 1)
        p = os.path.join(self.dir.name, "forest_mutant.js")
        with open(p, "w") as f:
            f.write(mutant)
        failed = 0
        for snap in self.snaps:
            failed += self._run(snap, {"FOREST_JS": p}).returncode != 0
        self.assertGreater(failed, 0)


if __name__ == "__main__":
    unittest.main()
