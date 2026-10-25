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

from tests.helpers import ROOT, make_grove, snapshot_of

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

    # maps the router once lost land on (two trunks on a diagonal across a
    # one-cell neck), kept so the fix stays tested whatever the sweep holds
    SEALED = ((5, 119), (6, 23), (6, 41), (24, 709), (24, 952))
    SWEEP = ((5, 1, 121), (6, 1, 101), (8, 1, 41), (12, 1, 41),
             (16, 1, 41), (24, 1, 61), (32, 1, 21))

    def _maps(self, maps, name):
        p = os.path.join(self.dir.name, name)
        with open(p, "w") as f:
            for size, seed in maps:
                st = snapshot_of(seed, size)
                st["tag"] = "%d/%d" % (size, seed)
                f.write(json.dumps(st) + "\n")
        return p

    def _reach(self, p, env=None):
        return subprocess.run(
            [NODE, CHECK, "--reach", p], cwd=ROOT, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, timeout=120,
            env=dict(os.environ, **(env or {})))

    def test_the_router_reaches_all_land_on_many_maps(self):
        # the sim's land is one piece four ways; the page's router, four
        # ways round the trunks, must reach all of it on every map: a sweep
        # of a few hundred fresh maps, small to large, made in-process and
        # checked in one Node run, plus the maps that once came apart
        maps = list(self.SEALED) + [(size, seed) for size, a, b in self.SWEEP
                                    for seed in range(a, b)]
        run = self._reach(self._maps(maps, "maps.jsonl"))
        self.assertEqual(run.returncode, 0, run.stdout)
        self.assertIn("router reach: %d of %d maps whole"
                      % (len(maps), len(maps)), run.stdout)

    def test_trunks_that_seal_land_off_fail(self):
        # without unseal the drawn trunks cut those maps apart again
        src = _read(FOREST)
        p = self._mutant(src, "  unseal(st, ids);\n", "", "forest_sealed.js")
        run = self._reach(self._maps(self.SEALED, "sealed.jsonl"),
                          {"FOREST_JS": p})
        self.assertNotEqual(run.returncode, 0, run.stdout)
        for size, seed in self.SEALED:
            self.assertIn("%d/%d: the router cannot reach" % (size, seed),
                          run.stdout)

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
                 "    for (const p of (st.plants || [])) {\n"),
                # the loop still over the list, the list topped up behind it
                ("    const n = list.length;\n",
                 "    const n = list.length;\n"
                 "    list.push(...Object.values(plantById));\n"),
                ("    const n = list.length;\n",
                 "    const n = list.length;\n    list.splice(0, 0, ...[]);\n")):
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

    def test_a_batch_that_drops_past_its_capacity_fails(self):
        # the ghost batches start at 32: a batch that stops adding at its
        # capacity, or grows without copying what it had, loses trees
        src = _read(FOREST)
        for old, new, want in (
                ("if (b.n >= b.cap) grow();", "if (b.n >= b.cap) return;",
                 "batch 32+1: n is 32, want 33"),
                ("      b.mesh.instanceMatrix.array.set(\n"
                 "        old.instanceMatrix.array.subarray(0, had * 16));\n",
                 "", "batch 32+1: 32 of 33 matrices lost"),
                ("        b.mesh.instanceColor.array.set(\n"
                 "          old.instanceColor.array.subarray(0, had * 3));\n",
                 "", "batch 32+1: 32 of 33 colours lost")):
            p = self._mutant(src, old, new, "forest_batch.js")
            run = self._run(self.snaps[0], {"FOREST_JS": p})
            self.assertNotEqual(run.returncode, 0, (old, run.stdout))
            self.assertIn(want, run.stdout)

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
