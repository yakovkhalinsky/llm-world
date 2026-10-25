"""Two creatures never stand inside each other.

`tools/crowd_check.js` runs the page's own spacing (`walk.js` pack,
separate and clearAt; `forest.js` restSpots and figure) on a crowded grove
built from a real one (`tools/crowd_scene.js`): six creatures of mixed
sizes in one cell, four beside a standing trunk, the flyers together, four
walking the same way and two pairs meeting head-on. It checks where they
rest and every frame of the walks. It needs Node, so this skips without
it.

The second test proves the check can fail: with spacing taken out of
walk.js (pack leaves everyone on the cell's middle, separate moves
nobody) the same grove must be reported as overlapping.
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest

from grove import web

from tests.helpers import ROOT, make_grove

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
        tmp, data, g, lock, runner = make_grove(7, 6)
        try:
            state = web.snapshot(g, runner, lock)
        finally:
            g.db.con.close()
            tmp.cleanup()
        cls.dir = tempfile.TemporaryDirectory()
        cls.snap = os.path.join(cls.dir.name, "state.json")
        with open(cls.snap, "w") as f:
            json.dump(state, f)

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def _run(self, env=None):
        return subprocess.run(
            [NODE, CHECK, self.snap], cwd=ROOT,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            timeout=180, env=dict(os.environ, **(env or {})))

    def test_a_crowd_keeps_its_distance(self):
        run = self._run()
        self.assertEqual(run.returncode, 0, "crowd_check failed:\n" + run.stdout)
        self.assertIn("crowd check ok", run.stdout)
        # the scene really is crowded, or the check proves nothing
        self.assertIn('"crowd"', run.stdout)
        self.assertIn('"headOn"', run.stdout)

    def test_without_spacing_the_check_fails(self):
        with open(WALK) as f:
            src = f.read()
        path = os.path.join(self.dir.name, "walk_mutant.js")
        with open(path, "w") as f:
            f.write(_no_spacing(src))
        run = self._run({"PAGE3D_WALK": path})
        self.assertEqual(run.returncode, 1, run.stdout)
        self.assertIn("FAIL resting", run.stdout)
        self.assertIn("FAIL walking", run.stdout)


if __name__ == "__main__":
    unittest.main()
