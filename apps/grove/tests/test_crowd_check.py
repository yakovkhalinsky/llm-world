"""Two creatures never stand inside each other, in a trunk or in the water.

`tools/crowd_check.js` runs the page's own resting and spacing
(`forest.js` restSpots, figure and space, on `walk.js`) on a crowded grove
built from a real one (`tools/crowd_scene.js`): six creatures of mixed
sizes in one cell, four beside a standing trunk, the flyers together, four
walking the same way and two pairs meeting head-on; and on made-up glades
(a creature beside a trunk, one in a trunk's quarter, one on a bank, each
brushed by a walker from every side; a head-on pair a little to the wrong
side; a flyer past the edge). It judges them with an oracle of its own —
the water from the snapshot's cells, each trunk a disk where the page
draws it — never with the clearAt it is checking. It needs Node, so this
skips without it.

The other tests prove the check can fail, each on a mutant of the page:
spacing taken out; keeping right taken out; the trunk keep-out taken out
of the per-frame push; and a push that ignores what the ground allows.
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
FOREST = os.path.join(ROOT, "grove", "page3d", "forest.js")


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


def _ignore_ok(src):
    """walk.js whose separate pushes wherever, ground or no ground."""
    return _swap(src, "      if (ok && !ok(k, nx, nz)) return false;\n", "")


def _no_trunk_keep(src):
    """forest.js whose per-frame push forgets the trunks."""
    return _swap(src, "      if (dx * dx + dz * dz < T[i + 2] * T[i + 2]) "
                 "return false;\n", "")


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

    def _mutant(self, fn, src_path, env_name):
        with open(src_path) as f:
            src = f.read()
        path = os.path.join(self.dir.name, fn.__name__ + ".js")
        with open(path, "w") as f:
            f.write(fn(src))
        run = self._run({env_name: path})
        self.assertEqual(run.returncode, 1, run.stdout)
        return run.stdout

    def test_the_scenes_ran(self):
        out = self._run().stdout
        self.assertIn("scenes: trunk ", out)
        for tag in ("in-trunk", "bank", "head-on", "edge"):
            self.assertIn("; " + tag + " ", out)

    def test_without_spacing_the_check_fails(self):
        out = self._mutant(_no_spacing, WALK, "PAGE3D_WALK")
        self.assertIn("FAIL resting", out)
        self.assertIn("FAIL walking", out)

    def test_without_keeping_right_the_check_fails(self):
        out = self._mutant(_no_keep_right, WALK, "PAGE3D_WALK")
        self.assertIn("FAIL head-on: the walkers did not pass on their own right",
                      out)

    def test_a_push_into_a_trunk_fails(self):
        out = self._mutant(_no_trunk_keep, FOREST, "GROVE_FOREST")
        self.assertIn("FAIL trunk: ", out)
        self.assertIn("FAIL in-trunk: ", out)

    def test_a_push_that_ignores_the_ground_fails(self):
        out = self._mutant(_ignore_ok, WALK, "PAGE3D_WALK")
        self.assertIn("into the water", out)
        self.assertIn("flyers drawn off the map", out)


if __name__ == "__main__":
    unittest.main()
