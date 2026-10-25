"""Two residents never stand inside each other.

`tools/crowd_check.js` runs the page's own spacing (`walk.js` pack,
separate and clearAt; `page3d/crowd.js`) on a crowded day built from a
fresh seed-42 estate — nine on the playground, three on a two-seat bench,
four at a table, five on one path tile, six out of one door at once, and
two groups meeting head-on — and checks the snapshot and every frame of
the walks. It needs Node, so this skips without it.

The second test proves the check can fail: with spacing taken out of
walk.js (pack leaves everyone on the tile's middle, separate moves
nobody) the same scene must be reported as overlapping.

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

    def test_without_spacing_the_check_fails(self):
        with open(WALK) as f:
            src = f.read()
        with tempfile.NamedTemporaryFile("w", suffix=".js",
                                         delete=False) as f:
            f.write(_no_spacing(src))
            mutant = f.name
        try:
            run = self._run({"PAGE3D_WALK": mutant})
        finally:
            os.unlink(mutant)
        self.assertEqual(run.returncode, 1, run.stdout)
        self.assertIn("FAIL snapshot", run.stdout)
        self.assertIn("FAIL walking", run.stdout)


if __name__ == "__main__":
    unittest.main()
