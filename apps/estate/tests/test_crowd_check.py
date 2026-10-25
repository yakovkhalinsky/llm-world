"""Two residents never stand inside each other, or in anything else.

`tools/crowd_check.js` runs the page's own placing and spacing
(`page3d/crowd.js` place and space, on `walk.js`) on a crowded day built
from a fresh seed-42 estate — nine on the playground, three on a two-seat
bench, four at a table, five on one path tile, six out of one door at
once, and two groups meeting head-on — and on made-up scenes (a passer-by
at a lamp from every side, a head-on pair a little to the wrong side, a
one-wide corridor, ten at a bench in a nook, fifteen at a lamp in a dead
end). It judges them with an oracle of its own — the walls from the
ground, each fixture's drawn body where the state puts it — never with
the clearAt or okAt it is checking. It needs Node, so this skips without
it.

The other tests prove the check can fail, each on a mutant of the page:
spacing taken out; keeping right taken out; the fixture keep-out taken
out of clearAt, or only out of the per-frame push; and a push that
ignores what the ground allows.

Run from `apps/estate`:

    python3 -m unittest discover -s tests
"""

import json
import os
import shutil
import subprocess
import tempfile
import types
import unittest

from estate import gen, web

from test_walk_check import _state_payload

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
CHECK = os.path.join(ROOT, "tools", "crowd_check.js")
WALK = os.path.join(ROOT, "..", "shared", "page3d", "walk.js")
CROWD = os.path.join(ROOT, "estate", "page3d", "crowd.js")


def _no_spacing(src):
    """walk.js with pack and separate reduced to doing nothing."""
    pack = "  function pack(rs, cx, cz, opts) {\n"
    sep = "  function separate(F, n, opts) {\n"
    assert pack in src and sep in src
    src = src.replace(pack, pack + (
        "    var xs = rs.map(function () { return cx; });\n"
        "    var zs = rs.map(function () { return cz; });\n"
        "    return { xs: xs, zs: zs, placed: rs.map(function () "
        "{ return true; }) };\n"))
    return src.replace(sep, sep + (
        "    for (var q = 0; q < n; q++) { F.x[q] = F.rx[q]; "
        "F.z[q] = F.rz[q]; }\n    return 0;\n"))


def _swap(src, old, new):
    assert src.count(old) == 1, old
    return src.replace(old, new)


def _no_keep_right(src):
    """walk.js whose oncoming walkers do not keep right: no lean, no
    mirrored push for a pair a little on the wrong side."""
    src = _swap(src, "        if (k > 0) {\n", "        if (false) {\n")
    return _swap(src, "        if (dot < -0.3 && side > 0 && "
                 "side * d < WRONG_SIDE * (r[a] + r[b])) {\n",
                 "        if (false) {\n")


def _no_keep(src):
    """walk.js whose clearAt has no fixture keep-out."""
    return _swap(src, "    if (keep > 0 && home >= 0 && g.solid[home]) {\n",
                 "    if (false) {\n")


def _ignore_ok(src):
    """walk.js whose separate pushes wherever, ground or no ground."""
    return _swap(src, "      if (ok && !ok(k, nx, nz)) return false;\n", "")


def _no_frame_keep(src):
    """crowd.js whose per-frame push forgets the fixture keep-out (the
    lamp-post case): placing still keeps it."""
    return _swap(src, "SP.keep[k] = keep;", "SP.keep[k] = 0;")


@unittest.skipUnless(NODE, "node is not installed")
class CrowdCheckTest(unittest.TestCase):
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

    def test_a_crowd_keeps_its_distance(self):
        run = self._run()
        self.assertEqual(run.returncode, 0, "crowd_check failed:\n" + run.stdout)
        self.assertIn("crowd check ok", run.stdout)
        # the scene really is crowded, or the check proves nothing
        self.assertIn('"play"', run.stdout)
        self.assertIn('"door"', run.stdout)
        self.assertIn('"runA"', run.stdout)

    def _mutant(self, fn, src_path, env_name):
        with open(src_path) as f:
            src = f.read()
        path = os.path.join(self.tmp.name, fn.__name__ + ".js")
        with open(path, "w") as f:
            f.write(fn(src))
        run = self._run({env_name: path})
        self.assertEqual(run.returncode, 1, run.stdout)
        return run.stdout

    def test_the_scenes_ran(self):
        out = self._run().stdout
        for tag in ("lamp", "head-on", "corridor", "bench-nook 10",
                    "lamp-dead-end 15"):
            self.assertIn(tag, out)

    def test_without_spacing_the_check_fails(self):
        out = self._mutant(_no_spacing, WALK, "PAGE3D_WALK")
        self.assertIn("FAIL snapshot", out)
        self.assertIn("FAIL walking", out)

    def test_without_keeping_right_the_check_fails(self):
        out = self._mutant(_no_keep_right, WALK, "PAGE3D_WALK")
        self.assertIn("FAIL head-on: the walkers did not pass on their own right",
                      out)

    def test_without_the_fixture_keep_out_the_check_fails(self):
        out = self._mutant(_no_keep, WALK, "PAGE3D_WALK")
        self.assertIn("into the table@", out)
        self.assertIn("FAIL lamp-dead-end", out)

    def test_a_push_into_the_lamp_post_fails(self):
        out = self._mutant(_no_frame_keep, CROWD, "PAGE3D_CROWD")
        self.assertIn("FAIL lamp: ", out)
        self.assertIn("into the lamp@2,2", out)

    def test_a_push_that_ignores_the_ground_fails(self):
        out = self._mutant(_ignore_ok, WALK, "PAGE3D_WALK")
        self.assertIn("into a wall or the water", out)
        self.assertIn("FAIL walking", out)


if __name__ == "__main__":
    unittest.main()
