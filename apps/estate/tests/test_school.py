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
from estate.engine import daytime, families, residents

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


class YardTest(unittest.TestCase):
    """#14 review: the yard had 24 spots, and a turn by count (`inside %
    24`) put the 25th to 27th pupils on cells already taken."""

    def _pupils(self, w, n):
        out = []
        for i in range(n):
            rid = w["next_id"]; w["next_id"] += 1
            r = W.new_resident(rid, None, 8)
            r["where"] = {"mode": "in", "unit": None, "x": 0, "y": 0,
                          "fixture": None}
            w["residents"][str(rid)] = r
            out.append(r)
        return out

    def _held(self, w):
        held = {}
        for r in w["residents"].values():
            if r["where"]["mode"] == "school":
                p = (r["where"]["x"], r["where"]["y"])
                held[p] = held.get(p, 0) + 1
        return held

    def test_the_yard_holds_the_most_ever_enrolled(self):
        w = gen.generate(42)
        per = rules.R["school"]["per_yard_cell"]
        spots = daytime.yard_spots(w)
        cells = set(spots)
        self.assertEqual(len(spots), len(cells) * per)
        # 28 is the most in at once across 8 seeds x 3 years
        # (family_check's max_in_school); the yard holds that with room
        self.assertGreaterEqual(len(spots), 28)
        for r in w["residents"].values():
            r["where"]["mode"] = "in"
        for k in self._pupils(w, len(spots)):
            daytime._enter(w, k)
        held = self._held(w)
        self.assertEqual(set(held), cells)
        self.assertEqual(set(held.values()), {per})

    def test_the_yard_fills_evenly(self):
        w = gen.generate(42)
        for r in w["residents"].values():
            r["where"]["mode"] = "in"
        cells = set(daytime.yard_spots(w))
        for k in self._pupils(w, len(cells) + 3):
            daytime._enter(w, k)
            held = self._held(w)
            self.assertLessEqual(max(held.values()) - min(
                held.get(c, 0) for c in cells), 1)

    def test_no_cell_is_over_its_share_over_a_term(self):
        t = family_check.new_tally()

        def watch(w, phase):
            family_check.look(w, phase, t)
        w = gen.generate(6)                # the seed that reached 27
        _watching(w, 28, watch)
        self.assertGreater(t["max_in_school"], 0)
        self.assertEqual(t["yard_over"], 0)


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


# ------------------------------------------------- the defensive branches
#
# The #14 review found nine branches that could be cut with nothing
# failing (its mutants). Each is pinned here at the function it lives in,
# with the situation that needs it built by hand: most never arise in a
# natural run, which is why the long checks could not see them.

def _school_day(w):
    while not daytime.school_day(w):
        w["day"] += 1
    return w


def _home(w, r, unit):
    b = w["buildings"][str(unit["building"])]
    r["where"] = {"mode": "in", "unit": unit["id"], "x": b["door"][0],
                  "y": b["door"][1], "fixture": None}
    r["side"] = None


def _households(w, guardians=1, toddler=None, pupil=None):
    """(household, guardians, young) for every household with at least
    `guardians` guardians and young children; `toddler`/`pupil` ask for a
    young child below school age, or of it."""
    out = []
    for hid in sorted(w["households"], key=int):
        hh = w["households"][hid]
        gs = sorted((g for g in families.members(w, hh)
                     if families.is_guardian(g)), key=lambda r: r["id"])
        ys = sorted(families.young_in(w, hh), key=lambda r: r["id"])
        if len(gs) < guardians or not ys:
            continue
        if toddler and not any(not daytime.is_pupil(k) for k in ys):
            continue
        if pupil and not any(daytime.is_pupil(k) for k in ys):
            continue
        out.append((hh, gs, ys))
    return out


class DefensiveBranchTest(unittest.TestCase):
    def setUp(self):
        self.w = _school_day(gen.generate(42))

    def _one(self, **kw):
        found = _households(self.w, **kw)
        if not found:
            self.skipTest(f"seed 42 has no household with {kw}")
        return found[0]

    def test_a_guardian_with_a_bus_to_catch_is_not_the_minder(self):
        """`families.plan`'s first key: the parent who is off to work is
        never left minding, however little their own needs press."""
        w = self.w
        hh, (a, b, *_), kids = self._one(guardians=2)
        unit = w["units"][str(hh["unit"])]
        for r in [a, b] + kids:
            _home(w, r, unit)
        press = {a["id"]: 0.0, b["id"]: 9.0}     # `a` the less pressed
        leads = families.plan(w, lambda g: press.get(g["id"], 5.0),
                              busy=lambda g: g is a)
        self.assertNotIn(a["id"], leads)
        self.assertEqual(sorted(k["id"] for k in leads[b["id"]]),
                         [k["id"] for k in kids])
        # and with nobody busy the less pressed one minds
        leads = families.plan(w, lambda g: press.get(g["id"], 5.0))
        self.assertIn(a["id"], leads)

    def test_nobody_is_left_at_school_or_at_work_overnight(self):
        """`daytime.overnight`: whoever a day left at school or away (a
        world saved mid-day) starts the next day at home."""
        w = self.w
        hh, gs, kids = self._one(pupil=True)
        unit = w["units"][str(hh["unit"])]
        k = next(k for k in kids if daytime.is_pupil(k))
        g = gs[0]
        k["where"] = {"mode": daytime.SCHOOL, "unit": unit["id"],
                      "x": 1, "y": 1, "fixture": None}
        g["where"] = {"mode": daytime.AWAY, "unit": unit["id"],
                      "x": 1, "y": 1, "fixture": None}
        daytime.overnight(w)
        door = list(w["buildings"][str(unit["building"])]["door"])
        for r in (k, g):
            self.assertEqual(r["where"]["mode"], "in")
            self.assertEqual(r["where"]["unit"], unit["id"])
            self.assertEqual([r["where"]["x"], r["where"]["y"]], door)

    def test_a_child_at_school_is_not_unattended(self):
        """`families.unattended`: a child inside the fence is with the
        teachers; the same child out alone is not."""
        w = self.w
        hh, gs, kids = self._one(pupil=True)
        unit = w["units"][str(hh["unit"])]
        for r in families.members(w, hh):
            _home(w, r, unit)
        k = next(k for k in kids if daytime.is_pupil(k))
        k["where"] = {"mode": daytime.SCHOOL, "unit": unit["id"],
                      "x": 1, "y": 1, "fixture": None}
        self.assertNotIn(k["id"], [c["id"] for c, _ in
                                   families.unattended(w)])
        k["where"] = dict(k["where"], mode="at")
        self.assertIn(k["id"], [c["id"] for c, _ in families.unattended(w)])

    def test_a_duty_walk_goes_the_shortest_way(self):
        """`_go_to`: a walk to the gate or the stop is made by the way
        anyone knows (`_route_walk`), never by feel (`_walk`)."""
        w = self.w
        r = next(r for r in w["residents"].values()
                 if r["where"]["mode"] == "in")
        g = daytime.gate(w)
        c = {"kind": "school", "x": g["x"], "y": g["y"], "fixture": g,
             "unit": None, "duty": "run"}
        with mock.patch.object(residents, "_route_walk",
                               return_value=True) as route, \
                mock.patch.object(residents, "_walk",
                                  return_value=True) as feel:
            residents._go_to(w, r, c, budget=rules.R["engine"]["scan"])
        route.assert_called_once()
        feel.assert_not_called()

    def test_a_guardian_away_at_work_collects_nobody(self):
        """`daytime.collectors`: the carer is away, so the guardian at home
        fetches the children; with every guardian away nobody does (and the
        children wait inside the fence)."""
        w = self.w
        hh, (a, b, *_), kids = self._one(guardians=2, pupil=True)
        unit = w["units"][str(hh["unit"])]
        for r in families.members(w, hh):
            _home(w, r, unit)
        young = [k for k in kids if daytime.is_pupil(k)]
        for k in young:
            k["where"] = {"mode": daytime.SCHOOL, "unit": unit["id"],
                          "x": 1, "y": 1, "fixture": None}
        carer = daytime.carer(w, hh)
        other = b if carer is a else a
        carer["where"] = {"mode": daytime.AWAY, "unit": unit["id"],
                          "x": 1, "y": 1, "fixture": None}
        got = daytime.collectors(w, "afternoon")
        self.assertNotIn(carer["id"], got)
        self.assertEqual([k["id"] for k in got[other["id"]]],
                         [k["id"] for k in young])
        other["where"] = dict(carer["where"])
        got = daytime.collectors(w, "afternoon")
        self.assertFalse(any(k["id"] in [y["id"] for y in young]
                             for ks in got.values() for k in ks), got)

    def test_a_carer_with_a_child_at_home_all_day_does_not_go_to_work(self):
        """`daytime.shift`: the carer of a child too young for school has
        no shift, job or not; with the young all at school the carer works
        school hours."""
        w = self.w
        hh, gs, kids = self._one(toddler=True)
        adult = rules.R["people"]["ages"]["adult"]
        with mock.patch.object(daytime, "is_worker",
                               lambda w, r: r["age"] >= adult):
            carer = daytime.carer(w, hh)
            self.assertEqual(daytime.shift(w, carer), ())
            for k in kids:
                if not daytime.is_pupil(k):
                    k["age"] = law_age = rules.R["school"]["ages"][0]
                    self.assertTrue(daytime.is_pupil(k), law_age)
            self.assertEqual(daytime.shift(w, carer),
                             tuple(rules.R["work"]["school_hours"]))

    def test_nobody_takes_a_child_on_the_bus(self):
        """`daytime.duty`: the commute is for a worker on their own; a
        worker minding a child this phase does not walk them to the bus."""
        w = self.w
        hh, gs, kids = self._one(toddler=True)
        toddler = next(k for k in kids if not daytime.is_pupil(k))
        lead = gs[0]
        phase = rules.R["work"]["commute"]
        with mock.patch.object(daytime, "commuting",
                               lambda w, r, phase: r is lead):
            alone = daytime.duty(w, [lead], phase, ())
            minding = daytime.duty(w, [lead, toddler], phase, ())
        self.assertEqual(alone and alone["duty"], "commute")
        self.assertIsNone(minding)

    def test_a_pupil_who_has_been_today_is_not_due_again(self):
        """`daytime.due_at_school`: a pupil home already today (schooled)
        is not sent back on the run."""
        w = self.w
        k = next(r for r in w["residents"].values() if daytime.is_pupil(r))
        run = rules.R["school"]["run"]
        k["schooled"] = None
        self.assertTrue(daytime.due_at_school(w, k, run))
        k["schooled"] = w["day"]
        self.assertFalse(daytime.due_at_school(w, k, run))
        k["schooled"] = w["day"] - 1
        self.assertTrue(daytime.due_at_school(w, k, run))


class PickupTimeTest(unittest.TestCase):
    def test_no_pickup_is_ever_made_at_night(self):
        """The duty walk is budgeted at `engine.scan` steps whatever the
        walker's mobility or the stairs (residents `_live`), which is safe
        only because the children are fetched by day: the gate is a few
        path cells from every door. Pin that no collection falls at
        night (or at dawn, before the school has opened)."""
        real, seen = daytime.collectors, {}

        def spy(w, phase):
            got = real(w, phase)
            if got:
                seen[phase] = seen.get(phase, 0) + 1
            return got

        with mock.patch.object(daytime, "collectors", spy):
            for seed in (42, 6):
                w = gen.generate(seed)
                for _ in range(14):
                    sim.tick(w)
        self.assertGreater(seen.get("afternoon", 0), 0, seen)
        self.assertEqual(set(seen) - {"afternoon", "evening"}, set(), seen)


class BusStopTest(unittest.TestCase):
    def test_the_queue_waits_round_the_shelter(self):
        """Commuters wait on the open cells round the stop, spread evenly,
        not all on the shelter's cell (#14 review: 40 on one cell)."""
        w = gen.generate(42)
        s = daytime.stop(w)
        spots = daytime.stop_spots(w)
        self.assertGreaterEqual(len(spots), 4)
        self.assertNotIn((s["x"], s["y"]), spots)
        fixed = {(f["x"], f["y"]) for f in w["fixtures"].values()}
        for x, y in spots:
            self.assertLessEqual(max(abs(x - s["x"]), abs(y - s["y"])), 1)
            self.assertTrue(W.passable(w, x, y))
            self.assertNotIn((x, y), fixed)
        worst = []

        def watch(w, phase):
            away = [(r["where"]["x"], r["where"]["y"])
                    for r in w["residents"].values()
                    if r["where"]["mode"] == daytime.AWAY]
            if not away:
                return
            per = {p: away.count(p) for p in set(away)}
            self.assertLessEqual(set(per), set(spots))
            worst.append((max(per.values()), -(-len(away) // len(spots))))

        _watching(w, 7, watch)
        self.assertTrue(worst)
        for most, fair in worst:
            self.assertLessEqual(most, fair)

    def test_the_bus_drops_them_where_they_waited(self):
        """Off the bus at the spot they waited on, round the shelter —
        never on the shelter's own cell, which the page draws solid
        (#14 follow-up)."""
        import copy
        w = gen.generate(42)
        s = daytime.stop(w)
        spots = set(daytime.stop_spots(w))
        seen = []

        def watch(w, phase):
            if phase == "afternoon" and not seen and any(
                    r["where"]["mode"] == daytime.AWAY
                    for r in w["residents"].values()):
                seen.append(copy.deepcopy(w))
        _watching(w, 7, watch)
        self.assertTrue(seen)
        w = seen[0]
        away = {rid: (r["where"]["x"], r["where"]["y"])
                for rid, r in w["residents"].items()
                if r["where"]["mode"] == daytime.AWAY}
        self.assertTrue(away)
        for rid in away:
            self.assertNotIn("evening", daytime.shift(w, w["residents"][rid]))
        daytime.begin(w, "evening")
        for rid, was in away.items():
            r = w["residents"][rid]
            at = (r["where"]["x"], r["where"]["y"])
            self.assertEqual(r["where"]["mode"], "at", rid)
            self.assertEqual(at, was, rid)
            self.assertIn(at, spots, rid)
            self.assertNotEqual(at, (s["x"], s["y"]), rid)


class FamilyCheckTest(unittest.TestCase):
    def test_a_cell_over_its_share_is_a_failure(self):
        """`yard_over` counts toward the check's verdict (#14 follow-up)."""
        t = family_check.new_tally()
        self.assertEqual(family_check.failures(t), 0)
        t["yard_over"] = 1
        self.assertGreater(family_check.failures(t), 0)


class HashSeedTest(unittest.TestCase):
    def test_the_same_seed_lives_the_same_days_in_another_process(self):
        """The jobs and the days are drawn from the seed (`W.rng_for`),
        never from the process's own `hash()` salt: two interpreters with
        different PYTHONHASHSEEDs live the same week."""
        import subprocess
        code = ("import json, hashlib\n"
                "from estate import gen, sim\n"
                "from estate.engine import daytime\n"
                "w = gen.generate(42)\n"
                "for _ in range(7):\n"
                "    sim.tick(w)\n"
                "jobs = sorted(int(r['id']) for r in w['residents'].values()"
                " if daytime.has_job(w, r))\n"
                "blob = json.dumps([w['residents'], w.get('day_phases')],"
                " sort_keys=True)\n"
                "print(json.dumps([jobs,"
                " hashlib.sha256(blob.encode()).hexdigest()]))\n")
        root = os.path.join(os.path.dirname(__file__), "..")
        outs = []
        for salt in ("0", "4242"):
            env = dict(os.environ, PYTHONHASHSEED=salt)
            run = subprocess.run([sys.executable, "-c", code], cwd=root,
                                 env=env, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True,
                                 timeout=300)
            self.assertEqual(run.returncode, 0, run.stderr)
            outs.append(json.loads(run.stdout))
        self.assertGreater(len(outs[0][0]), 0)
        self.assertEqual(outs[0], outs[1])


if __name__ == "__main__":
    unittest.main()
