"""The creatures' routing, through `tools/route_check.js` on a real
grove's snapshot — and the check itself, against routers that are wrong.

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
CHECK = os.path.join(ROOT, "tools", "route_check.js")
FOREST = os.path.join(ROOT, "grove", "page3d", "forest.js")
HEAD = "function route(Walk, grid, fx, fz, tx, tz) {"


@unittest.skipUnless(NODE, "node is not installed")
class RouteCheckTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp, data, g, lock, runner = make_grove(7, 6)
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

    def run_check(self, forest=None):
        env = dict(os.environ)
        if forest:
            env["GROVE_FOREST"] = forest
        return subprocess.run([NODE, CHECK, self.snap], env=env,
                              capture_output=True, text=True, timeout=120)

    def mutant(self, body):
        with open(FOREST) as f:
            src = f.read()
        self.assertEqual(src.count(HEAD), 1)
        path = os.path.join(self.dir.name, "forest_mutant.js")
        with open(path, "w") as f:
            f.write(src.replace(HEAD, HEAD + "\n" + body))
        return path

    def test_the_snapshot_has_walkers(self):
        moved = [a for a in self.state["animals"]
                 if (a["px"], a["py"]) != (a["x"], a["y"])
                 and a["sp"] not in self.state["biome"]["flyers"]]
        self.assertTrue(moved, "nothing walked this week; pick another seed")

    def test_the_routes_go_round(self):
        r = self.run_check()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        rep = json.loads(r.stdout)
        self.assertEqual(rep["failureCount"], 0)
        self.assertGreater(rep["routes"], 0)
        self.assertGreater(rep["trunks"], 0)

    def test_a_router_that_walks_straight_fails(self):
        r = self.run_check(self.mutant(
            "var s = Walk.straight(fx, fz, tx, tz);"
            "return { route: s, fallback: false, points: s.n };"))
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn("the detour went through a trunk", r.stdout)

    def test_a_router_that_always_gives_up_fails(self):
        r = self.run_check(self.mutant(
            "return { route: Walk.straight(fx, fz, tx, tz), fallback: true };"))
        self.assertEqual(r.returncode, 1, r.stdout)


if __name__ == "__main__":
    unittest.main()
