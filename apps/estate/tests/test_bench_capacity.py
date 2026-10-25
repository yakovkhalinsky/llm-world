"""A bench seats two, and the estate must not put three on it.

The congestion term (`capacity / (capacity + k·occupancy)`) is deliberately
soft for most places: a busy playground is worse, not closed. A bench is a
seat, so generation marks it `hard_capacity` and the chooser refuses it
once it is full; a passing walker can still stand on the cell, and the
renderers stand anyone without a seat clearly past the end of it.

Before the fix the soft term alone let up to six residents occupy a
two-seat bench at the end of a phase, which the 3D view drew as people on
the bench. These tests pin the chooser and the sim.

Run from `apps/estate`:

    python3 -m unittest discover -s tests
"""

import random
import unittest

from estate import gen, rules, sim
from estate.engine import residents


def _bench_fixture(w, perimeter=False):
    return next(f for f in w["fixtures"].values()
                if f["kind"] == "bench" and bool(f.get("perimeter")) == perimeter)


class FullBenchTest(unittest.TestCase):
    def setUp(self):
        self.w = gen.generate(42)
        self.cap = rules.R["fixtures"]["bench"]["capacity"]
        self.bench = _bench_fixture(self.w)

    def _utility(self, occupants):
        f = {"kind": "bench", "x": self.bench["x"], "y": self.bench["y"],
             "condition": 1.0, "occupants": list(range(occupants)),
             "perimeter": False}
        c = {"kind": "bench", "x": f["x"], "y": f["y"], "fixture": f,
             "unit": None}
        r = {"where": {"mode": "at", "x": f["x"], "y": f["y"]},
             "habit": {}, "role": "adult", "household": 0}
        return residents._utility(self.w, r, c, "rest", "afternoon",
                                  random.Random(3))

    def test_a_bench_with_a_free_seat_is_considered(self):
        self.assertIsNotNone(self._utility(self.cap - 1))

    def test_a_full_bench_is_not_chosen(self):
        self.assertIsNone(self._utility(self.cap))

    def test_an_overfull_bench_is_not_chosen(self):
        self.assertIsNone(self._utility(self.cap + 3))


class NoBenchOverflowTest(unittest.TestCase):
    """Sixty days at seed 42, checked at every phase end.

    This is the instrument that found the bug: the state at the end of a
    phase is what both pages draw, and a bench cell there must never hold
    more residents than the bench has seats.
    """

    def test_no_bench_cell_holds_more_people_than_it_seats(self):
        w = gen.generate(42)
        seats = {(f["x"], f["y"]): rules.R["fixtures"]["bench"]["capacity"]
                 for f in w["fixtures"].values() if f["kind"] == "bench"}
        overflow = []

        def snap():
            at = {}
            for r in w["residents"].values():
                where = r["where"]
                if where["mode"] != "at":
                    continue
                cell = (where["x"], where["y"])
                if cell in seats:
                    at[cell] = at.get(cell, 0) + 1
            for cell, n in at.items():
                if n > seats[cell]:
                    overflow.append((w["day"], cell, n))

        phases = residents.PHASES
        orig_drain = residents.drain
        orig_update = residents.update_residents

        def drain(world, phase):
            # the end of the previous phase; the first drain is the start of
            # the day, and the previous night was already recorded
            if phase != phases[0]:
                snap()
            return orig_drain(world, phase)

        def update(world, evs):
            out = orig_update(world, evs)
            snap()                      # the end of night
            return out

        residents.drain = drain
        residents.update_residents = update
        try:
            for _ in range(60):
                sim.tick(w)
        finally:
            residents.drain = orig_drain
            residents.update_residents = orig_update
        self.assertEqual(overflow, [], "bench cells over capacity: "
                         + repr(overflow[:10]))


if __name__ == "__main__":
    unittest.main()
