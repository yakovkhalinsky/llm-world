"""Two residents never stand inside each other, or in anything else.

`tools/crowd_check.js` runs the page's own placing and spacing
(`page3d/crowd.js` place and space, on `walk.js`) on a crowded day built
from a fresh seed-42 estate — nine on the playground, three on a two-seat
bench, four at a table, five on one path tile, six out of one door at
once, and two groups meeting head-on — and on made-up scenes (a passer-by
at a lamp from every side, a head-on pair a little to the wrong side, a
one-wide corridor, ten at a bench in a nook, fifteen at a lamp in a dead
end, a resident by a shop's stall or a wall's corner, centres on a wall's
edge, the walk to a lamp or a tree and back by walls and water, a child
following a guardian onto a tile with a pole, a trunk, a table or a
bench). It judges them with an oracle of its own — the walls from the
ground, each fixture's drawn body where the state puts it — never with
the clearAt or okAt it is checking. It needs Node, so this skips without
it.

The other tests prove the check can fail, each on a mutant of the page:
spacing taken out; keeping right taken out; the fixture keep-out taken
out of clearAt, or only out of the per-frame push; and a push that
ignores what the ground allows; a walk round a pole that ignores the walls,
or goes round only on the way back; a child's follow whose end legs skip
the detour; a stall with no body; a box's corner measured square; an
edge guard that says yes to everything.

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
    """crowd.js whose per-frame push forgets every fixture's body (the
    lamp-post case): placing still keeps them."""
    return _swap(src, "            t = Walk.keepOut(K, t, b[0], c + 0.5, "
                 "y + 0.5, b[1], m + BODY_GAP, x, z);\n", "")


def _no_frame_table(src):
    """crowd.js whose per-frame push has no body for a table (the café
    table case: the resident stands off the table's cell); placing still
    keeps clear of it."""
    return _swap(src, "table: [0, 0.41]", "table: [0, 0]")


def _centre_only(src):
    """crowd.js whose per-frame push keeps only a body's centre out of the
    walls, not its edge (someone grazing a wall pushed into it)."""
    return _swap(src, "Walk.groundKeepOuts(grid, K, t, x, z, m, home, 1)",
                 "Walk.groundKeepOuts(grid, K, t, x, z, 0, home, 1)")


def _no_round_pole(src):
    """crowd.js whose walk to a lamp's or a tree's place runs straight
    through the pole or the trunk."""
    return _swap(src, "      if (Walk.around && fixAt) {", "      if (false) {")


def _around_no_walls(src):
    """walk.js whose bend round a pole takes the first way round, however
    deep it runs into a wall or the water."""
    return _swap(src, "  function around(route, cx, cz, rho, grid, m) {\n",
                 "  function around(route, cx, cz, rho, grid, m) {\n"
                 "    grid = null;\n")


def _round_end_only(src):
    """crowd.js whose walk goes round the pole only at the place it walks
    to, not at the one it leaves (out from a lamp, through the pole)."""
    return _swap(src, "[[scx, scy], [tcx, tcy]].forEach",
                 "[[tcx, tcy]].forEach")


def _no_frame_shop(src):
    """crowd.js whose per-frame push has no body for a shop's stall."""
    return _swap(src, "shop: [0, 0.45]", "shop: [0, 0]")


def _box_square(src):
    """walk.js measuring the way out of a box square (the larger of the two
    offsets), not round: a body off a corner is let in nearer."""
    return _swap(src, "    return Math.sqrt(ox * ox + oz * oz);\n  }",
                 "    return Math.max(ox, oz);\n  }")


def _cell_open_always(src):
    """walk.js whose edge guard says every centre is on open ground."""
    return _swap(src, "    var cx = Math.floor(x), cz = Math.floor(z);\n"
                 "    if (cx < 0",
                 "    return true;\n"
                 "    var cx = Math.floor(x), cz = Math.floor(z);\n"
                 "    if (cx < 0")


def _no_overflow_ok(src):
    """crowd.js whose standers past a full bench's places go wherever
    the packing puts them, walls or no walls."""
    return _swap(src, "        return okAt(Walk, grid, fixAt, x, z, b.cx, b.cy);\n",
                 "        return true;\n")


def _no_table_keep(src):
    """crowd.js that lets a body stand anywhere on a table's cell — the
    live picture of someone standing inside a café table."""
    return _swap(src, "table: 0.42,", "table: 0,")


def _not_facing(src):
    """crowd.js whose people at a table look wherever they last walked."""
    return _swap(src, "    if (!f || f.kind !== 'table') return null;\n",
                 "    return null;\n")


def _no_beside(src):
    """crowd.js that records who a child is with but leaves them wherever
    the tile's packing put them."""
    return _swap(src,
                 "    placeBeside(Walk, grid, fixAt, people, groups, keys, out);\n",
                 "    for (var q = 0; q < n; q++) {\n"
                 "      if (people[q].with == null || people[q].in) continue;\n"
                 "      for (var q2 = 0; q2 < n; q2++)\n"
                 "        if (people[q2].id === people[q].with) out.with[q] = q2;\n"
                 "    }\n")


def _no_follow(src):
    """crowd.js whose children walk their own way, not their guardian's."""
    sig = "  function follow(lead, leadFrom, own, ownFrom, Walk, grid, fixAt) {\n"
    return _swap(src, sig, sig + "    return own;\n")


def _follow_plain_ends(src):
    """crowd.js whose follow is the one before the fix: the guardian's
    route with the child's two ends put on it, the end legs neither bent
    round a pole or a trunk nor checked against the child's own route."""
    src = _swap(src, "    if (Walk && Walk.around && fixAt) {\n      /* every pole",
                "    if (false) {\n      /* every pole")
    return _swap(src, "    if (got.into > Math.max(mine.into, 0) + FOLLOW_TOL ||\n",
                 "    if (false && got.into > Math.max(mine.into, 0) + FOLLOW_TOL ||\n")


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

    def test_a_child_stands_and_walks_beside_their_guardian(self):
        out = self._run().stdout
        self.assertIn("families: 4 children beside a guardian", out)
        self.assertIn("1 walking with one", out)

    def test_a_child_left_where_the_tile_packed_them_fails(self):
        out = self._mutant(_no_beside, CROWD, "PAGE3D_CROWD")
        self.assertIn("not beside them", out)

    def test_a_child_walking_their_own_way_fails(self):
        out = self._mutant(_no_follow, CROWD, "PAGE3D_CROWD")
        self.assertIn("cells from their guardian", out)

    def test_a_child_following_into_a_pole_fails(self):
        # #10 review: the follow's end legs skipped #12's detour, and a
        # child walked 0.19 into a tree trunk here
        out = self._mutant(_follow_plain_ends, CROWD, "PAGE3D_CROWD")
        self.assertRegex(out, r"FAIL follow-walk: a child following .* "
                         r"runs 0\.\d+ into the (tree|lamp)@")

    def test_the_scenes_ran(self):
        out = self._run().stdout
        for tag in ("lamp", "table-passer", "shop-passer", "box-corner",
                    "wall-edge", "pole-walk", "follow-walk", "head-on", "corridor",
                    "bench-nook 20", "lamp-dead-end 15", "shop-door 8"):
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

    def test_people_at_a_table_stand_beside_it_facing_it(self):
        out = self._run().stdout
        self.assertIn("at tables (beside, facing)", out)
        self.assertNotIn(" 0 at tables", out)

    def test_someone_inside_a_table_fails(self):
        out = self._mutant(_no_table_keep, CROWD, "PAGE3D_CROWD")
        self.assertIn("FAIL table: resident", out)
        # whichever table the seed put people at, by its cell
        self.assertRegex(out, r"inside the table@\d+,\d+")

    def test_someone_not_facing_the_table_fails(self):
        out = self._mutant(_not_facing, CROWD, "PAGE3D_CROWD")
        self.assertIn("does not face it", out)

    def test_a_push_into_the_lamp_post_fails(self):
        out = self._mutant(_no_frame_keep, CROWD, "PAGE3D_CROWD")
        self.assertIn("FAIL lamp: ", out)
        self.assertIn("into the lamp@2,2", out)

    def test_a_push_into_the_cafe_table_fails(self):
        out = self._mutant(_no_frame_table, CROWD, "PAGE3D_CROWD")
        self.assertIn("FAIL table-passer: 7 pushed", out)
        self.assertIn("into the table@3,2", out)

    def test_a_push_of_an_edge_into_a_wall_fails(self):
        out = self._mutant(_centre_only, CROWD, "PAGE3D_CROWD")
        self.assertIn("into a wall or the water", out)

    def test_a_walk_through_the_pole_fails(self):
        out = self._mutant(_no_round_pole, CROWD, "PAGE3D_CROWD")
        self.assertIn("FAIL lamp-walk", out)
        self.assertIn("FAIL tree-walk", out)

    def test_a_walk_round_the_pole_into_a_wall_fails(self):
        out = self._mutant(_around_no_walls, WALK, "PAGE3D_WALK")
        self.assertIn("FAIL pole-walk: the walk round the", out)
        self.assertIn("deeper into a wall than the plain leg", out)

    def test_a_walk_out_through_the_pole_fails(self):
        out = self._mutant(_round_end_only, CROWD, "PAGE3D_CROWD")
        self.assertIn("FAIL lamp-walk: a walk from", out)
        self.assertIn("FAIL tree-walk: a walk from", out)

    def test_a_push_into_the_stall_fails(self):
        out = self._mutant(_no_frame_shop, CROWD, "PAGE3D_CROWD")
        self.assertIn("FAIL shop-passer: 7 pushed", out)
        self.assertIn("into the shop@3,2", out)

    def test_a_push_in_at_a_corner_fails(self):
        out = self._mutant(_box_square, WALK, "PAGE3D_WALK")
        self.assertIn("FAIL box-corner: ", out)

    def test_an_edge_guard_that_says_yes_fails(self):
        out = self._mutant(_cell_open_always, WALK, "PAGE3D_WALK")
        self.assertIn("FAIL wall-edge: a centre at 2,2.5 is on open ground", out)
        self.assertIn("FAIL wall-edge: a centre off the map", out)

    def test_bench_overflow_in_the_wall_fails(self):
        out = self._mutant(_no_overflow_ok, CROWD, "PAGE3D_CROWD")
        self.assertIn("FAIL bench-nook: ", out)
        self.assertIn("into a wall", out)

    def test_a_push_that_ignores_the_ground_fails(self):
        out = self._mutant(_ignore_ok, WALK, "PAGE3D_WALK")
        self.assertIn("into a wall or the water", out)
        # caught by the seed-42 walk when it brushes the pond or a wall,
        # and always by the dead-end scene, which corners a walker there
        # (the layout decides whether the live walk comes near either)
        self.assertRegex(out, r"FAIL (walking|lamp-dead-end).*into a wall")


if __name__ == "__main__":
    unittest.main()
