"""The estate's edge: the footpath and the benches that furnish it.

The added benches moved out of the courtyard to the band beside the ring
road, and the path they face is what makes the walk out to them a walk
rather than a lawn crossing. These pin that contract against generation:
the courtyard's original seven keep their places, the ten new ones carry
the `perimeter` mark, and every one of them stands on the band beside a
path cell.

Run from `apps/estate`:

    python3 -m unittest discover -s tests
"""

import unittest

from estate import gen, rules


class PerimeterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.w = gen.generate(42)
        cls.rw = rules.R["gen"]["road_width"]
        cls.edge = cls.rw * 2
        cls.far_x = cls.w["width"] - cls.rw * 2 - 1
        cls.far_y = cls.w["height"] - cls.rw * 2 - 1
        cls.benches = [f for f in cls.w["fixtures"].values()
                       if f["kind"] == "bench"]

    def path_at(self, x, y):
        return self.w["cells"][y][x]["site"] == "path"

    def test_courtyard_benches_are_unchanged(self):
        courtyard = [f for f in self.benches if not f.get("perimeter")]
        self.assertEqual(len(courtyard), rules.R["gen"]["benches"])

    def test_perimeter_benches_are_placed(self):
        outer = [f for f in self.benches if f.get("perimeter")]
        self.assertEqual(len(outer), rules.R["gen"]["perimeter_benches"])

    def test_each_perimeter_bench_is_beside_the_path(self):
        for f in self.benches:
            if not f.get("perimeter"):
                continue
            self.assertTrue(
                self.edge <= f["x"] <= self.far_x
                and self.edge <= f["y"] <= self.far_y,
                f"bench at {f['x']},{f['y']} is not on the outer band")
            self.assertTrue(
                any(self.path_at(f["x"] + dx, f["y"] + dy)
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))),
                f"bench at {f['x']},{f['y']} has no path beside it")
            self.assertNotEqual(self.w["cells"][f["y"]][f["x"]]["site"],
                                "path")

    def test_the_footpath_is_a_ring(self):
        for x in (self.edge + 1, (self.edge + self.far_x) // 2,
                  self.far_x - 1):
            self.assertEqual(self.w["cells"][self.edge + 1][x]["site"],
                             "path")
            self.assertEqual(self.w["cells"][self.far_y - 1][x]["site"],
                             "path")
        for y in (self.edge + 2, (self.edge + self.far_y) // 2,
                  self.far_y - 2):
            self.assertEqual(self.w["cells"][y][self.edge + 1]["site"],
                             "path")
            self.assertEqual(self.w["cells"][y][self.far_x - 1]["site"],
                             "path")


if __name__ == "__main__":
    unittest.main()
