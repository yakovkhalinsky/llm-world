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


def _sweep(seed, days):
    """Run `days` days at `seed`, checking every phase end.

    What is counted is who sits: residents whose `where.fixture` is the
    bench and who are on its cell, which is exactly who the views draw
    seated. A walker whose phase ran out on the bench's cell is not sitting
    on it (`where.fixture` is None) and the renderers stand them past the
    end of the bench, so they are not counted; an earlier version of this
    test counted the cell, and passed at seed 42 over 60 days only because
    no two walkers happened to stop beside a full bench.
    """
    w = gen.generate(seed)
    cap = rules.R["fixtures"]["bench"]["capacity"]
    benches = {f["id"]: (f["x"], f["y"]) for f in w["fixtures"].values()
               if f["kind"] == "bench"}
    overflow = []
    phase_of = {"now": None}

    def snap(label):
        seated = {}
        for r in w["residents"].values():
            where = r["where"]
            fid = where.get("fixture")
            if where["mode"] != "at" or fid not in benches:
                continue
            if (where["x"], where["y"]) == benches[fid]:
                seated[fid] = seated.get(fid, 0) + 1
        for fid, n in seated.items():
            if n > cap:
                overflow.append((seed, w["day"], label, fid, n))

    phases = residents.PHASES
    orig_drain = residents.drain
    orig_update = residents.update_residents

    def drain(world, phase):
        # the end of the previous phase; the first drain is the start of
        # the day, and the previous night was already recorded
        if phase != phases[0]:
            snap(phase_of["now"])
        phase_of["now"] = phase
        return orig_drain(world, phase)

    def update(world, evs):
        out = orig_update(world, evs)
        snap(phases[-1])               # the end of night
        return out

    residents.drain = drain
    residents.update_residents = update
    try:
        for _ in range(days):
            sim.tick(w)
    finally:
        residents.drain = orig_drain
        residents.update_residents = orig_update
    return overflow


class NoBenchOverflowTest(unittest.TestCase):
    """Every phase end over 200 days at four seeds.

    This is the instrument that found both bugs: the state at the end of a
    phase is what both pages draw, and a bench there must never hold more
    residents than it has seats. Seed 42 over 60 days found the chooser
    piling onto a bench (up to six); seed 1 at day 77 found the stayer —
    resident 135 kept bench 78 from the morning without being counted, and
    two more sat down beside them in the afternoon.
    """

    SEEDS = (1, 7, 42, 99)
    DAYS = 200

    def test_no_bench_holds_more_people_than_it_seats(self):
        for seed in self.SEEDS:
            with self.subTest(seed=seed):
                overflow = _sweep(seed, self.DAYS)
                self.assertEqual(overflow, [], "benches over capacity: "
                                 + repr(overflow[:10]))


if __name__ == "__main__":
    unittest.main()
