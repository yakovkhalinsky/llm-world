"""Nobody walks through a step.

The shop's front (its stall, on the cell before its door) and every
door's step are one step high, and a figure over one stands on it, rising
onto it on a ramp rather than walking through it. `tools/step_check.js`
runs the page's own `steps` and `lift` (`page3d/crowd.js`) on walk.js
routes into and out of every door of a fresh seed-42 estate, and judges
them with an oracle of its own — each step's footprint from the doors and
the shop fixture, at the size world.js draws it. It needs Node, so this
skips without it.

The other tests prove the check can fail, each on a mutant of the page:
no lift at all (the old feet in the step), a lift with no ramp (a jump),
and the old waist-high stall. And world.js really draws and stands people
on what crowd.js says.

Run from `apps/estate`:

    python3 -m unittest discover -s tests
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import types
import unittest

from estate import gen, web

from test_walk_check import _state_payload

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
CHECK = os.path.join(ROOT, "tools", "step_check.js")
CROWD = os.path.join(ROOT, "estate", "page3d", "crowd.js")
WORLD = os.path.join(ROOT, "estate", "page3d", "world.js")


def _swap(src, old, new):
    assert src.count(old) == 1, old
    return src.replace(old, new)


def _no_lift(src):
    """crowd.js whose figures keep their feet on the ground everywhere."""
    return _swap(src, "    var best = 0;\n    if (!st) return 0;\n",
                 "    var best = 0;\n    return 0;\n")


def _no_ramp(src):
    """crowd.js that pops a figure onto a step with no ramp before it."""
    return _swap(src, "  var RAMP = 0.22;\n", "  var RAMP = 0.001;\n")


def _tall_stall(src):
    """crowd.js with the old waist-high stall's height."""
    return _swap(src, "  var STEP_H = 0.06;\n", "  var STEP_H = 0.59;\n")


@unittest.skipUnless(NODE, "node is not installed")
class StepCheckTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        world = gen.generate(42)
        cls.tmp = tempfile.TemporaryDirectory()
        cls.ground = os.path.join(cls.tmp.name, "ground.json")
        cls.state = os.path.join(cls.tmp.name, "state.json")
        with open(cls.ground, "w") as f:
            json.dump(web.ground(types.SimpleNamespace(world=world)), f)
        with open(cls.state, "w") as f:
            json.dump(_state_payload(world), f)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def _run(self, env=None):
        return subprocess.run(
            [NODE, CHECK, self.ground, self.state], cwd=ROOT,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            timeout=180, env=dict(os.environ, **(env or {})))

    def _mutant(self, fn):
        with open(CROWD) as f:
            src = f.read()
        path = os.path.join(self.tmp.name, fn.__name__ + ".js")
        with open(path, "w") as f:
            f.write(fn(src))
        run = self._run({"PAGE3D_CROWD": path})
        self.assertEqual(run.returncode, 1, run.stdout)
        return run.stdout

    def test_nobody_walks_through_a_step(self):
        run = self._run()
        self.assertEqual(run.returncode, 0, "step_check failed:\n" + run.stdout)
        self.assertIn("step check ok", run.stdout)
        # the shop's stall and every door are steps, and the walks really
        # cross them, or the check proves nothing
        m = re.search(r"steps: (\d+) drawn", run.stdout)
        self.assertGreaterEqual(int(m.group(1)), 4)
        m = re.search(r"(\d+) frames over a step", run.stdout)
        self.assertGreater(int(m.group(1)), 1000)

    def test_feet_in_the_step_fail(self):
        out = self._mutant(_no_lift)
        self.assertIn("FAIL scan: a foot", out)
        self.assertIn("FAIL walking: feet", out)
        self.assertIn("shop stall", out)

    def test_a_jump_onto_the_step_fails(self):
        out = self._mutant(_no_ramp)
        self.assertIn("a jump, not a ramp", out)
        self.assertIn("in one frame", out)

    def test_the_old_tall_stall_fails(self):
        out = self._mutant(_tall_stall)
        self.assertIn("FAIL drawn: a step 0.59 high", out)


class WorldUsesTheStepsTest(unittest.TestCase):
    """world.js draws the steps at crowd.js's height and stands people on
    them through crowd.js's lift — what the check runs is what is drawn."""

    @classmethod
    def setUpClass(cls):
        with open(WORLD) as f:
            cls.src = f.read()

    def test_steps_are_drawn_one_step_high(self):
        self.assertIn("const STEP_H = Crowd ? Crowd.STEP_H : 0.06;", self.src)
        self.assertEqual(self.src.count(
            "addBox(g, stepMat, doorW + 0.24, STEP_H, 0.34,"), 1)
        self.assertEqual(self.src.count(
            "addBox(g, stepMat, 0.34, STEP_H, doorW + 0.24,"), 1)
        self.assertIn("addBox(g, wood.mat, 0.9, STEP_H, 0.9, 0, STEP_H / 2, 0);",
                      self.src)
        self.assertNotIn("0.85, 0.5, 0.85", self.src)

    def test_figures_stand_on_the_lift(self):
        self.assertIn("Crowd.lift(stepList, x, z)", self.src)
        self.assertIn("stepList = Crowd ? Crowd.steps(ground, st.fixtures)",
                      self.src)
        self.assertIn("dummy.position.set(x, footY + 0.36 * s + bob, z);",
                      self.src)
        self.assertIn("dummy.position.set(x, footY + 0.82 * s + bob, z);",
                      self.src)
        self.assertNotIn("WALK_Y + 0.36 * s", self.src)
        # the gait lifts a foot, never sinks it below the ground
        self.assertIn("(1 + Math.sin(now * 0.009 + i * 1.7)) * 0.02 * s",
                      self.src)

    def test_people_at_a_table_face_it(self):
        self.assertIn("Crowd.faceTable(crowdFix, p.x, p.y, x, z)", self.src)


if __name__ == "__main__":
    unittest.main()
