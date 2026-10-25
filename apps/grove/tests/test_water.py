"""Every grove has water: a creek across the whole map and at least one
pond, on every seed, with the land still one piece (fords), the same on
every run; the desert's map is untouched; and a thirsty creature walks to
the water and drinks, the same way every time."""

import json
import os
import subprocess
import sys
import unittest

from grove import gen, rules
from grove import world as W
from grove.engine import animals

from tests.helpers import ROOT

SEEDS = range(0, 48)


def _make(seed):
    return gen.generate(seed)


class WaterOnEverySeed(unittest.TestCase):
    def test_creek_and_pond_on_every_seed(self):
        for seed in SEEDS:
            st = _make(seed)
            size, cells = st["size"], st["cells"]
            creek = [(x, y) for y in range(size) for x in range(size)
                     if cells[y][x].get("water") == "creek"]
            ponds = [(x, y) for y in range(size) for x in range(size)
                     if cells[y][x].get("water") == "pond"]
            with self.subTest(seed=seed):
                self.assertEqual(len(st["creeks"]), 1)
                path = st["creeks"][0]
                # source edge to mouth: it spans the map one way or the other
                xs = {p[0] for p in path}
                ys = {p[1] for p in path}
                self.assertTrue({0, size - 1} <= xs or {0, size - 1} <= ys,
                                path[:3])
                self.assertGreaterEqual(len(creek), size - 4)
                self.assertGreaterEqual(len(ponds), 1)
                for x, y in creek + ponds:
                    self.assertEqual(cells[y][x]["terrain"], "water")
                # creek steps are edge to edge, never a diagonal gap
                for (x0, y0), (x1, y1) in zip(path, path[1:]):
                    self.assertEqual(abs(x0 - x1) + abs(y0 - y1), 1)

    def test_land_is_one_piece(self):
        for seed in SEEDS:
            st = _make(seed)
            with self.subTest(seed=seed):
                parts = gen.land_parts(st["cells"], st["size"])
                self.assertEqual(len(parts), 1)
                fords = [1 for row in st["cells"] for c in row
                         if c.get("ford")]
                self.assertGreaterEqual(len(fords), 1)
                for row in st["cells"]:
                    for c in row:
                        if c.get("ford"):
                            self.assertNotEqual(c["terrain"], "water")

    def test_same_water_every_run(self):
        for seed in (1, 42, 99):
            a = json.dumps(_make(seed), sort_keys=True)
            b = json.dumps(_make(seed), sort_keys=True)
            self.assertEqual(a, b)

    def test_seeds_differ(self):
        self.assertNotEqual(_make(1)["creeks"], _make(2)["creeks"])

    def test_desert_gets_no_creek(self):
        # in a fresh interpreter: other tests reload the rules, and the
        # world's live aliases of the pack must be the desert's own
        code = ("import json; from grove import gen\n"
                "print(json.dumps([gen.generate(s, biome='desert')"
                " for s in (1, 2, 42)]))")
        out = subprocess.run([sys.executable, "-c", code], cwd=ROOT,
                             env=dict(os.environ, PYTHONPATH=ROOT),
                             check=True, stdout=subprocess.PIPE, text=True)
        for st in json.loads(out.stdout):
            self.assertNotIn("creeks", st)
            for row in st["cells"]:
                for c in row:
                    self.assertNotIn("ford", c)
                    self.assertNotIn("water", c)
        self.assertEqual(rules.active_biome(), "grove")


class Drinking(unittest.TestCase):
    def test_grazers_and_hunters_drink(self):
        for sp in ("rabbit", "deer", "fox", "boar", "wolf"):
            spec = rules.R["animals"].get(sp)
            if spec is None:
                continue
            self.assertGreater(spec.get("drink_every", 0), 0, sp)

    def test_shore_is_land_beside_water(self):
        st = _make(42)
        shore = animals.shore_cells(st)
        self.assertTrue(shore)
        size = st["size"]
        for x, y in shore:
            self.assertNotEqual(st["cells"][y][x]["terrain"], "water")
            self.assertTrue(any(
                W.in_bounds(size, x + dx, y + dy)
                and st["cells"][y + dy][x + dx]["terrain"] == "water"
                for dx in (-1, 0, 1) for dy in (-1, 0, 1)))

    def test_creatures_drink_the_same_way_every_run(self):
        from grove import sim
        runs = []
        for _ in range(2):
            w = _make(42)
            drank = []
            for _ in range(30):
                sim.tick(w)
                drank.append(sorted(
                    (a["sp"], a["x"], a["y"]) for a in w["animals"].values()
                    if a.get("drank") == w["tick"]))
            runs.append(drank)
        self.assertEqual(runs[0], runs[1])
        self.assertTrue(any(runs[0]), "nobody drank in thirty weeks")
        size = w["size"]
        for week in runs[0]:
            for sp, x, y in week:
                self.assertTrue(any(
                    W.in_bounds(size, x + dx, y + dy)
                    and w["cells"][y + dy][x + dx]["terrain"] == "water"
                    for dx in (-1, 0, 1) for dy in (-1, 0, 1)), (sp, x, y))


if __name__ == "__main__":
    unittest.main()
