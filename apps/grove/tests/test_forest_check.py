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
CHECK = os.path.join(ROOT, "tools", "forest_check.js")
FOREST = os.path.join(ROOT, "grove", "page3d", "forest.js")


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

    def test_a_forest_on_its_paths_fails(self):
        src = open(FOREST).read()
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
