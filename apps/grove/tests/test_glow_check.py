"""Tonight's glowing mushroom rings, through `tools/glow_check.js` on a
real grove's snapshot — and the check itself, against choosers that are
wrong.

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
SHARE = "var SHARE = 0.25;"


@unittest.skipUnless(NODE, "node is not installed")
class GlowCheckTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp, data, g, lock, runner = make_grove(7, 10)
        try:
            cls.state = web.snapshot(g, runner, lock)
        finally:
            g.db.con.close()
            tmp.cleanup()
        cls.dir = tempfile.TemporaryDirectory()
        cls.snap = os.path.join(cls.dir.name, "state.json")
        with open(cls.snap, "w") as f:
            json.dump(cls.state, f)

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def run_check(self, glow=None):
        env = dict(os.environ)
        if glow:
            env["GROVE_GLOW"] = glow
        return subprocess.run([NODE, CHECK, self.snap], env=env,
                              capture_output=True, text=True, timeout=120)

    def mutant(self, old, new):
        with open(GLOW) as f:
            src = f.read()
        self.assertEqual(src.count(old), 1)
        path = os.path.join(self.dir.name, "glow_mutant.js")
        with open(path, "w") as f:
            f.write(src.replace(old, new))
        return path

    def test_the_grove_has_several_rings(self):
        mush = [c for c in self.state["cells"] if c and c[3]]
        self.assertGreater(len(mush), 8)

    def test_the_page_lights_about_one_ring_in_four(self):
        r = self.run_check()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        rep = json.loads(r.stdout)
        self.assertTrue(rep["serverFieldMatch"])
        self.assertGreaterEqual(rep["rings"], 4)
        self.assertGreater(rep["litShare"], 0.15)
        self.assertLess(rep["litShare"], 0.4)

    def test_the_check_fails_lighting_every_ring(self):
        r = self.run_check(self.mutant(SHARE, "var SHARE = 1.0;"))
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn("one in four", r.stdout)

    def test_the_check_fails_a_dark_night(self):
        # a share so low that most nights pass no ring, and no fallback
        path = self.mutant("if (!lit.length && best) lit.push(best);", "")
        with open(path) as f:
            src = f.read()
        with open(path, "w") as f:
            f.write(src.replace(SHARE, "var SHARE = 0.001;"))
        r = self.run_check(path)
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn("light none", r.stdout)

    def test_the_check_fails_a_field_unlike_the_servers(self):
        r = self.run_check(self.mutant("var REACH = 2.6;",
                                       "var REACH = 3.2;"))
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn("differ from the server", r.stdout)

    def test_the_check_fails_a_random_choice(self):
        r = self.run_check(self.mutant(
            "var h = hash01(all[r].key, (night | 0) * 7919 + 4241);",
            "var h = Math.random();"))
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn("not deterministic", r.stdout)


if __name__ == "__main__":
    unittest.main()
