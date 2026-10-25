"""Every grove has water: a creek across the whole map and one or two
ponds, on every seed and every map size that has room, with the land still
one piece four ways (fords), the same on every run; the desert's map is
untouched; and a thirsty creature walks to the water and drinks, the same
way every time."""

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
SIZES = range(4, 31)
POND_ROOM = 7           # from seven cells across, every map has a pond


def _flat(size=20, water=((10, 10),)):
    """A bare, flat world of soil with water only where it is put, and no
    grass, plants or creatures, so nothing but thirst moves a creature."""
    w = W.new_state(1, size)
    w["cells"] = [[{"terrain": "soil", "elev": 0.5, "fert": 0.5,
                    "moisture": 0.5, "grass": 0.0, "mushroom": 0,
                    "carcass": 0} for _ in range(size)] for _ in range(size)]
    for x, y in water:
        w["cells"][y][x]["terrain"] = "water"
        w["cells"][y][x]["water"] = "pond"
    w["tick"] = 5
    return w


def _touches(cells, size, x, y, pick):
    return any(W.in_bounds(size, x + dx, y + dy)
               and pick(cells[y + dy][x + dx])
               for dx in (-1, 0, 1) for dy in (-1, 0, 1))


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
                self.assertIn(len(gen.ponds(cells, size)), (1, 2))
                for x, y in creek + ponds:
                    self.assertEqual(cells[y][x]["terrain"], "water")
                # creek steps are edge to edge, never a diagonal gap
                for (x0, y0), (x1, y1) in zip(path, path[1:]):
                    self.assertEqual(abs(x0 - x1) + abs(y0 - y1), 1)

    def test_one_or_two_ponds_that_are_ponds(self):
        # the pack says one or two ponds: that many separate ponds, dug, on
        # every seed at the small, default and large sizes; no other water
        # is called a pond, and no pond runs into the creek or a ford
        for size in (8, 12, 16, 24, 32):
            for seed in range(0, 120 if size <= 24 else 30):
                st = gen.generate(seed, size)
                cells = st["cells"]
                found = gen.ponds(cells, size)
                with self.subTest(size=size, seed=seed):
                    self.assertIn(len(found), (1, 2))
                    for y in range(size):
                        for x in range(size):
                            c = cells[y][x]
                            if c["terrain"] == "water":
                                self.assertIn(c.get("water"),
                                              ("creek", "pond"))
                            if c.get("water") == "pond":
                                self.assertFalse(_touches(
                                    cells, size, x, y, gen._running))

    def test_dig_pond_never_gives_up_where_there_is_room(self):
        # the old digger gave up on a fifth of the 16-cell maps; now it
        # shrinks its asks, and only a map with no room at all has none
        gr = rules.R["gen"]
        for seed in range(0, 60):
            st = gen.generate(seed, 16)
            cells, size = st["cells"], 16
            before = len(gen.ponds(cells, size))
            got = gen.dig_pond(cells, size, W.rng_for(seed, 0, "more"), gr)
            with self.subTest(seed=seed):
                if got is None:
                    continue
                self.assertEqual(len(gen.ponds(cells, size)), before + 1)
                self.assertEqual(len(gen.land_parts(cells, size)), 1)

    def test_every_size_generates(self):
        # the smallest maps used to crash on the creek's edge margin
        for size in SIZES:
            for seed in range(0, 12):
                st = gen.generate(seed, size)
                cells = st["cells"]
                with self.subTest(size=size, seed=seed):
                    self.assertEqual(len(cells), size)
                    self.assertEqual(len(st["creeks"]), 1)
                    path = st["creeks"][0]
                    xs = {p[0] for p in path}
                    ys = {p[1] for p in path}
                    self.assertTrue({0, size - 1} <= xs
                                    or {0, size - 1} <= ys)
                    self.assertEqual(len(gen.land_parts(cells, size)), 1)
                    n = len(gen.ponds(cells, size))
                    self.assertLessEqual(n, 2)
                    if size >= POND_ROOM:
                        self.assertGreaterEqual(n, 1)
                    for a in st["animals"].values():
                        self.assertNotEqual(
                            cells[a["y"]][a["x"]]["terrain"], "water")
                    for p in st["plants"].values():
                        self.assertNotEqual(
                            cells[p["y"]][p["x"]]["terrain"], "water")

    def test_cli_new_at_the_smallest_sizes(self):
        import tempfile
        for size in (4, 5, 6, 7):
            with tempfile.TemporaryDirectory() as d:
                out = subprocess.run(
                    [sys.executable, "-m", "grove", "--data", d, "new",
                     "--seed", "3", "--size", str(size)],
                    cwd=ROOT, env=dict(os.environ, PYTHONPATH=ROOT),
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    text=True)
                self.assertEqual(out.returncode, 0, out.stderr)
                self.assertIn(f"{size}×{size}", out.stdout)

    def test_a_map_too_small_is_refused(self):
        # a 1×1 map divided by zero; it is refused, the CLI says so
        with self.assertRaises(ValueError):
            gen.generate(3, 1)
        self.assertEqual(gen.generate(3, gen.MIN_SIZE)["size"], gen.MIN_SIZE)
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            out = subprocess.run(
                [sys.executable, "-m", "grove", "--data", d, "new",
                 "--seed", "3", "--size", "1"],
                cwd=ROOT, env=dict(os.environ, PYTHONPATH=ROOT),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.assertEqual(out.returncode, 2, out.stderr)
            self.assertIn("at least 2×2", out.stderr)

    def test_land_is_one_piece_four_ways(self):
        # the page walks four ways and never cuts a corner between two
        # water cells, so the land must join up four ways, at every size
        for size in list(SIZES) + [32, 40, 48]:
            for seed in range(0, 24 if size <= 30 else 10):
                st = gen.generate(seed, size)
                cells = st["cells"]
                land = {(x, y) for y in range(size) for x in range(size)
                        if cells[y][x]["terrain"] != "water"}
                start = min(land, key=lambda p: (p[1], p[0]))
                seen, todo = {start}, [start]
                while todo:
                    x, y = todo.pop()
                    for n in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                        if n in land and n not in seen:
                            seen.add(n)
                            todo.append(n)
                with self.subTest(size=size, seed=seed):
                    self.assertEqual(len(seen), len(land))

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


class WetMeadows(unittest.TestCase):
    """The damp hollows stay open grazing: no tree is planted in one, and
    none but the shore tree may seed or come back from the bank there."""

    def test_hollows_are_planted_without_trees(self):
        kinds = {sp: s["kind"] for sp, s in rules.R["plants"].items()}
        damp = trees_in_damp = 0
        for seed in range(1, 31):
            st = gen.generate(seed)
            cells = st["cells"]
            damp += sum(1 for row in cells for c in row if c.get("damp"))
            for p in st["plants"].values():
                c = cells[p["y"]][p["x"]]
                if c.get("damp") and kinds[p["sp"]] == "tree":
                    trees_in_damp += 1
        self.assertGreater(damp, 0)
        self.assertEqual(trees_in_damp, 0)

    def test_only_the_shore_tree_roots_in_a_hollow(self):
        from grove.engine import plants
        P = rules.R["plants"]
        wet, dry = {"terrain": "soil", "damp": 1}, {"terrain": "soil"}
        self.assertTrue(plants._waterlogged(wet, P["pine"]))
        self.assertTrue(plants._waterlogged(wet, P["birch"]))
        self.assertFalse(plants._waterlogged(wet, P["willow"]))
        self.assertFalse(plants._waterlogged(wet, P["fern"]))
        self.assertFalse(plants._waterlogged(wet, P["berry"]))
        for sp in P:
            self.assertFalse(plants._waterlogged(dry, P[sp]))


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

    def test_shore_cache_follows_the_world(self):
        # two worlds in the same week never share a shore list
        a, b = _flat(water=((3, 3),)), _flat(water=((15, 15),))
        sa = animals.shore_cells(a)
        sb = animals.shore_cells(b)
        self.assertIn((2, 2), sa)
        self.assertNotIn((2, 2), sb)
        self.assertIn((14, 14), sb)
        self.assertEqual(animals.shore_cells(a), sa)
        # a fresh grid at the same week (a loaded copy) is looked at anew
        c = json.loads(json.dumps(b))
        c["cells"][3][3]["terrain"] = "water"
        self.assertIn((2, 2), animals.shore_cells(c))

    def test_thirsty_creature_walks_to_the_nearest_shore(self):
        spec = dict(rules.R["animals"]["rabbit"])
        every, reach = spec["drink_every"], spec.get("drink_reach", 8)
        w = _flat()
        # the shore is the ring around (10, 10); from (10, 4) the nearest
        # is five steps off, and the tie breaks on row, then column: (9, 9)
        a = W.new_animal(1, "rabbit", 10, 4)
        a["thirst"] = every
        self.assertTrue(animals._go_drink(w, a, spec, 1))
        self.assertEqual((a["x"], a["y"]), (9, 4))   # toward (9, 9)
        a = W.new_animal(1, "rabbit", 10, 4)
        a["thirst"] = every
        self.assertTrue(animals._go_drink(w, a, spec, 3))
        self.assertEqual((a["x"], a["y"]), (9, 6))
        # not thirsty yet, too far to see the water, or already there
        for pos, thirst in (((10, 4), every - 1),
                            ((10, 10 - 2 - reach), every),
                            ((9, 9), every)):
            a = W.new_animal(1, "rabbit", *pos)
            a["thirst"] = thirst
            self.assertFalse(animals._go_drink(w, a, spec, 2), pos)
            self.assertEqual((a["x"], a["y"]), pos)

    def test_a_thirsty_creature_with_nothing_to_eat_goes_and_drinks(self):
        # the whole week, not only the helper: a lone rabbit on bare ground
        # seven steps from a pond walks straight there and drinks
        w = _flat()
        a = W.new_animal(1, "rabbit", 10, 2)
        a["thirst"] = rules.R["animals"]["rabbit"]["drink_every"]
        a["hunger"] = 0.0
        w["animals"] = {1: a}
        w["next_id"] = 2
        path = []
        for week in range(6, 12):
            w["tick"] = week
            animals._update_animals(w, [])
            path.append((a["x"], a["y"]))
            if a.get("drank"):
                break
        self.assertTrue(a.get("drank"), path)
        self.assertTrue(_touches(w["cells"], 20, a["x"], a["y"],
                                 lambda c: c["terrain"] == "water"), path)
        ys = [y for _, y in path]
        self.assertEqual(ys, sorted(ys), path)     # never back the way

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
