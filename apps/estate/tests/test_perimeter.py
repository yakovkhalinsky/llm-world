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

import random
import unittest

from estate import gen, rules
from estate.engine import places, residents


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


class PerimeterBonusChooserTest(unittest.TestCase):
    """The bonus belongs to the place's *base*, before wear and crowding.

    These are chooser tests, not arithmetic on a table: two benches stand on
    the same cell, so shade, lamplight and distance are identical and the
    only difference is the perimeter mark. That makes the comparison the
    one the chooser actually makes.
    """

    @classmethod
    def setUpClass(cls):
        cls.w = gen.generate(42)
        cls.pbench = next(
            f for f in cls.w["fixtures"].values()
            if f["kind"] == "bench" and f.get("perimeter"))
        cls.cap = rules.R["fixtures"]["bench"]["capacity"]

    def _utility(self, perimeter, need="quiet", phase="night",
                 condition=1.0, occupants=0):
        # the same cell for both benches: only the mark differs
        f = {"kind": "bench", "x": self.pbench["x"], "y": self.pbench["y"],
             "condition": condition, "occupants": [0] * occupants,
             "perimeter": perimeter}
        c = {"kind": "bench", "x": f["x"], "y": f["y"], "fixture": f,
             "unit": None}
        r = {"where": {"mode": "at", "x": f["x"], "y": f["y"]},
             "habit": {}, "role": "adult", "household": 0}
        return residents._utility(self.w, r, c, need, phase,
                                  random.Random(7))

    def test_a_perimeter_bench_beats_an_identical_courtyard_bench(self):
        for need in ("rest", "company", "quiet"):
            with self.subTest(need=need):
                self.assertGreater(
                    self._utility(True, need=need),
                    self._utility(False, need=need))

    def test_a_worn_perimeter_bench_does_not_beat_a_fresh_courtyard_one(self):
        """Condition scales the bonus: a seat at 5% is not an edge draw."""
        for need in ("rest", "company", "quiet"):
            with self.subTest(need=need):
                self.assertLess(
                    self._utility(True, need=need, condition=0.05),
                    self._utility(False, need=need, condition=1.0))

    def test_a_full_perimeter_bench_is_not_offered_at_all(self):
        """Congestion scales it, and a seat's capacity is hard: at capacity
        the edge bench is not a worse bench, it is no bench, so the chooser
        refuses it rather than pretending it still draws."""
        for need in ("rest", "company", "quiet"):
            with self.subTest(need=need):
                self.assertIsNone(
                    self._utility(True, need=need, occupants=self.cap))
                self.assertIsNotNone(
                    self._utility(False, need=need, occupants=0))

    def test_congestion_shrinks_the_bonus_itself(self):
        """The gap between an edge seat and a plain one narrows as the seat
        fills — the bonus is inside the congestion term, not beside it."""
        for need in ("rest", "company", "quiet"):
            with self.subTest(need=need):
                fresh = (places.effective("bench", need, 1.0, 0,
                                          {"perimeter": True})
                         - places.effective("bench", need, 1.0, 0,
                                            {"perimeter": False}))
                busy = (places.effective("bench", need, 1.0, 1,
                                         {"perimeter": True})
                        - places.effective("bench", need, 1.0, 1,
                                           {"perimeter": False}))
                self.assertLess(busy, fresh)

    def test_the_restore_matches_the_base_that_drew_the_resident(self):
        """`_satisfy` restores the same base the chooser weighed, bonus and
        all, so a resident lured out for quiet is not met with a bench's
        bare 0.18 on arrival."""
        full = (rules.R["engine"]["need_max"]
                * rules.R["engine"]["arrive_restore"])
        got = {}
        for perimeter in (True, False):
            f = {"id": 1, "kind": "bench", "x": self.pbench["x"],
                 "y": self.pbench["y"], "condition": 1.0, "occupants": [],
                 "perimeter": perimeter, "stock": None, "use_total": 0}
            c = {"kind": "bench", "x": f["x"], "y": f["y"], "fixture": f,
                 "unit": None}
            r = {"id": 1, "needs": {"quiet": 4.0}, "habit": {},
                 "where": {"mode": "at", "x": f["x"], "y": f["y"]}}
            residents._satisfy(self.w, r, c, "quiet", "night")
            got[perimeter] = 4.0 - r["needs"]["quiet"]
        self.assertAlmostEqual(got[True], full * (0.18 + 0.18))
        self.assertAlmostEqual(got[False], full * 0.18)
        self.assertGreater(got[True], got[False])


if __name__ == "__main__":
    unittest.main()
