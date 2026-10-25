"""The weekday: the school run, the school day and work
(`estate/engine/daytime.py`).

What is pinned here:

- **attendance** — on a school day every pupil on the roll is at school by
  the end of the school morning, and nobody is at school at the weekend;
- **supervision on the run** — no young child is ever out alone, home
  alone, or left inside the fence after the school has shut, over several
  seeds and every phase (the `tools/family_check.py` measure, with its
  "left at school" line), and the check bites when nobody collects;
- **the layout** — the gate is within an older child's range of every
  front door, and the stop and the gate are joined by walkable ground;
- **the shape of the day** — workers are away through the shift and home
  by evening, and nobody is at school or at work at night;
- **determinism** — the same seed lives the same weekdays, phase records
  and all.

Run from `apps/estate`:

    python3 -m unittest discover -s tests
"""

import json
import os
import sys
import unittest
from unittest import mock

from estate import gen, rules, sim, web
from estate import world as W
from estate.engine import daytime, residents

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import family_check  # noqa: E402


def _watching(w, days, watch):
    residents.PHASE_WATCHERS.append(watch)
    try:
        for _ in range(days):
            sim.tick(w)
    finally:
        residents.PHASE_WATCHERS.remove(watch)


class AttendanceTest(unittest.TestCase):
    def test_every_pupil_is_at_school_on_a_school_morning(self):
        w = gen.generate(42)
        seen = []

        def watch(w, phase):
            if phase != "morning":
                return
            pupils = [r for r in w["residents"].values()
                      if daytime.is_pupil(r)]
            here = [r for r in pupils if r["where"]["mode"] == "school"]
            seen.append((w["day"], daytime.school_day(w),
                         len(pupils), len(here)))

        _watching(w, 21, watch)
        school = [s for s in seen if s[1]]
        weekend = [s for s in seen if not s[1]]
        self.assertEqual(len(school), 15)
        self.assertEqual(len(weekend), 6)
        for day, _, pupils, here in school:
            self.assertGreater(pupils, 0)
            self.assertEqual(here, pupils, f"day {day}")
        for day, _, _, here in weekend:
            self.assertEqual(here, 0, f"day {day}")

    def test_the_roll_counts_today(self):
        w = gen.generate(42)
        rolls = []

        def watch(w, phase):
            if phase == "night":
                rolls.append((daytime.school_day(w), daytime.roll(w)))

        _watching(w, 7, watch)
        for open_, roll in rolls:
            self.assertEqual(roll["in_now"], 0)
            self.assertEqual(roll["away_now"], 0)
            if open_:
                self.assertEqual(roll["in_today"], roll["enrolled"])
            else:
                self.assertEqual(roll["in_today"], 0)


class SupervisionTest(unittest.TestCase):
    SEEDS = (42, 7, 1)
    DAYS = 60

    def _measure(self, seeds, days):
        tally, cases = family_check.new_tally(), []
        for s in seeds:
            _watching(gen.generate(s), days,
                      lambda w, phase: family_check.look(w, phase,
                                                         tally, cases))
        return tally, cases

    def test_no_young_child_is_unminded_on_the_school_run(self):
        tally, cases = self._measure(self.SEEDS, self.DAYS)
        self.assertGreater(tally["young_school"], 500)   # it was exercised
        self.assertEqual(tally["out_alone"], 0, cases[:5])
        self.assertEqual(tally["home_alone"], 0, cases[:5])
        self.assertEqual(tally["left_at_school"], 0, cases[:5])
        self.assertEqual(tally["older_out_of_bounds"], 0)

    def test_nobody_collecting_is_caught(self):
        """Take the pickup away and the check has to fail."""
        with mock.patch.object(daytime, "collectors", lambda w, phase: {}):
            tally, _ = self._measure((42,), 14)
        self.assertGreater(tally["left_at_school"], 0)

    def test_young_pupils_walk_in_with_a_guardian(self):
        """At the end of the run every young pupil is either inside the
        fence or still beside a guardian (never on the path alone)."""
        w = gen.generate(42)
        young = rules.R["families"]["young_under"]
        bad = []

        def watch(w, phase):
            if phase != rules.R["school"]["run"] or not daytime.school_day(w):
                return
            for r in w["residents"].values():
                if daytime.is_pupil(r) and r["age"] < young \
                        and r["where"]["mode"] != "school":
                    bad.append((w["day"], r["id"], r["where"]["mode"]))

        _watching(w, 14, watch)
        self.assertEqual(bad, [])


def _renumber(w, rid):
    """Give a resident the next free id, so they come *after* everyone
    else in the phase's turn order — as an older brother or sister who
    grew into a guardian comes *before* the little one they collect."""
    r = w["residents"].pop(str(rid))
    new = w["next_id"]
    w["next_id"] += 1
    r["id"] = new
    w["residents"][str(new)] = r
    hh = w["households"][str(r["household"])]
    hh["members"] = [new if m == rid else m for m in hh["members"]]
    return new


class CollectedTest(unittest.TestCase):
    """A child collected at the gate lives the rest of that phase in the
    collector's party. A collector whose turn comes *before* the child's
    (a lower id: on seed 1 an older sister turned eighteen in year three
    and became the carer) used to leave the child a turn of their own,
    and the child walked home alone and sat in the flat by themselves —
    2 of 8 seeds failed family_check from the third year on."""

    def test_a_child_after_their_collector_in_the_order_is_minded(self):
        w = gen.generate(42)
        hh = w["households"]["129"]
        kid = next(m for m in hh["members"]
                   if 5 <= w["residents"][str(m)]["age"] < 10)
        kid = _renumber(w, kid)
        tally, cases = family_check.new_tally(), []
        seen = []

        def watch(w, phase):
            family_check.look(w, phase, tally, cases)
            seen.append(w["residents"][str(kid)]["where"]["mode"])

        _watching(w, 14, watch)
        self.assertIn("school", seen)            # the run was exercised
        self.assertEqual(tally["home_alone"], 0, cases[:5])
        self.assertEqual(tally["out_alone"], 0, cases[:5])

    def test_without_the_rule_the_child_goes_home_alone(self):
        """The same world with the collected child given back a turn of
        their own: the check has to fail."""
        w = gen.generate(42)
        hh = w["households"]["129"]
        kid = next(m for m in hh["members"]
                   if 5 <= w["residents"][str(m)]["age"] < 10)
        kid = _renumber(w, kid)
        tally, cases = family_check.new_tally(), []
        orig_live = residents._live

        def live(w, party, cand, phase, line, fetch=()):
            orig_live(w, party, cand, phase, line, fetch)
            # what the old loop did: the fetched child got a turn anyway
            for k in fetch:
                if k["where"]["mode"] == "at":
                    orig_live(w, [k], cand, phase, line, ())

        with mock.patch.object(residents, "_live", live):
            _watching(w, 14, lambda w, phase: family_check.look(
                w, phase, tally, cases))
        self.assertGreater(tally["home_alone"] + tally["out_alone"], 0)


class LayoutTest(unittest.TestCase):
    def _rect(self, b):
        return {(x, y) for y in range(b["y"], b["y"] + b["h"])
                for x in range(b["x"], b["x"] + b["w"])}

    def test_the_shop_and_the_playground_stand_apart(self):
        """Not shoulder to shoulder: open paving all round each, an open
        middle between them, and still in an older child's range of every
        door (they go to both alone)."""
        rng = rules.R["families"]["older_range"]
        for seed in (42, 7, 1, 2, 3):
            w = gen.generate(seed)
            cells = w["cells"]
            shop = next(b for b in w["buildings"].values()
                        if b["kind"] == "shop")
            play = {(x, y) for y, row in enumerate(cells)
                    for x, c in enumerate(row) if c["site"] == "play"}
            sh = self._rect(shop)
            gap = min(abs(a[0] - b[0]) for a in sh for b in play)
            self.assertGreaterEqual(gap, 4, seed)
            fixed = {(f["x"], f["y"]): f["kind"]
                     for f in w["fixtures"].values()}
            for area, own in ((sh, "shop"), (play, "playground")):
                ring = {(x + dx, y + dy) for x, y in area
                        for dx in (-1, 0, 1) for dy in (-1, 0, 1)} - area
                for x, y in ring:
                    self.assertNotIn(cells[y][x]["site"],
                                     ("building", "water"), (seed, own))
                    self.assertIn(fixed.get((x, y), own), (own,),
                                  (seed, own, x, y))
            for kind in ("shop", "playground"):
                f = next(f for f in w["fixtures"].values()
                         if f["kind"] == kind)
                for b in w["buildings"].values():
                    if b["kind"] != "block":
                        continue
                    d = abs(b["door"][0] - f["x"]) + abs(b["door"][1] - f["y"])
                    self.assertLessEqual(d, rng, (seed, kind, b["name"]))

    def test_a_plan_that_spreads_them_too_far_says_so(self):
        f = dict(rules.R["families"], older_range=3)
        with mock.patch.dict(rules.R, {"families": f}):
            with self.assertRaisesRegex(ValueError, "older_range"):
                gen.generate(42)

    def test_the_gate_is_in_range_of_every_door(self):
        rng = rules.R["families"]["older_range"]
        for seed in (42, 7, 1, 2, 3):
            w = gen.generate(seed)
            g = daytime.gate(w)
            self.assertIsNotNone(g)
            self.assertIsNotNone(daytime.stop(w))
            for b in w["buildings"].values():
                if b["kind"] != "block":
                    continue
                d = abs(b["door"][0] - g["x"]) + abs(b["door"][1] - g["y"])
                self.assertLessEqual(d, rng, (seed, b["name"]))

    def test_the_stop_and_the_gate_are_joined(self):
        w = gen.generate(42)
        g, s = daytime.gate(w), daytime.stop(w)
        r = {"where": {"mode": "at", "x": s["x"], "y": s["y"],
                       "fixture": None}, "side": None}
        self.assertTrue(residents._route_walk(w, r, g["x"], g["y"], 200))

    def test_the_school_is_a_school(self):
        w = gen.generate(42)
        b = daytime.school_building(w)
        self.assertEqual(b["kind"], "school")
        self.assertFalse([u for u in w["units"].values()
                          if u["building"] == b["id"]])
        self.assertTrue(daytime.yard_spots(w))


class DayShapeTest(unittest.TestCase):
    def test_work_and_school_end_by_evening(self):
        w = gen.generate(42)
        bad, away = [], []

        def watch(w, phase):
            modes = [r["where"]["mode"] for r in w["residents"].values()]
            if phase in ("evening", "night"):
                if "school" in modes or "away" in modes:
                    bad.append((w["day"], phase))
            if phase == "morning" and daytime.school_day(w):
                away.append(modes.count("away"))
            if not daytime.school_day(w) and phase != "dawn":
                if "away" in modes or "school" in modes:
                    bad.append((w["day"], phase, "weekend"))

        _watching(w, 14, watch)
        self.assertEqual(bad, [])
        self.assertTrue(away and min(away) > 0)

    def test_the_jobs_are_a_share_of_working_age(self):
        w = gen.generate(42)
        ages = rules.R["people"]["ages"]
        adults = [r for r in w["residents"].values()
                  if ages["adult"] <= r["age"] < ages["elder"]]
        workers = [r for r in adults if daytime.is_worker(w, r)]
        self.assertTrue(0 < len(workers) < len(adults))


class DeterminismTest(unittest.TestCase):
    def _run(self):
        w = gen.generate(42)
        for _ in range(9):
            sim.tick(w)
        return (json.dumps(w["residents"], sort_keys=True),
                json.dumps(w.get("day_phases"), sort_keys=True))

    def test_the_same_seed_lives_the_same_weekdays(self):
        self.assertEqual(self._run(), self._run())

    def test_the_view_gets_the_phases(self):
        w = gen.generate(42)
        for _ in range(3):
            sim.tick(w)
        ph = web._phases(w)
        self.assertEqual(ph["order"], list(residents.PHASES))
        self.assertEqual(set(ph["at"]), set(residents.PHASES))
        self.assertEqual(set(ph["at"]["morning"]), set(w["residents"]))

if __name__ == "__main__":
    unittest.main()
