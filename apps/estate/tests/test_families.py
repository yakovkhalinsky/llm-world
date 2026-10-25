"""Families: no young child is ever out on the estate without a guardian
from their household beside them, or left alone in the flat.

The rules live in `estate/engine/families.py` and read every number from
`rules.R["families"]`. The invariant is checked the way `tools/family_check.py`
measures it, at the end of every phase (`residents.PHASE_WATCHERS`), over
several seeds and more than a year, so the year turn's births, ageing and
deaths are crossed. The mutant takes the rule out and must fail the same
check, so the invariant is shown to be able to fail. The edge cases pin the
single parent, the newly arrived family, the guardian who dies or leaves,
the baby born while everyone is out, the sixteen-year-old sibling, and the
10-15s' limited independence.

Run from `apps/estate`:

    python3 -m unittest discover -s tests
"""

import os
import random
import sys
import unittest
from unittest import mock

from estate import gen, rules, sim, web
from estate import world as W
from estate.engine import families, households, residents

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import family_check  # noqa: E402


def _measure(seeds, days, world=None):
    tally = family_check.new_tally()
    cases = []

    def watch(w, phase):
        family_check.look(w, phase, tally, cases)

    residents.PHASE_WATCHERS.append(watch)
    try:
        for s in seeds:
            w = world if world is not None else gen.generate(s)
            for _ in range(days):
                sim.tick(w)
    finally:
        residents.PHASE_WATCHERS.remove(watch)
    return tally, cases


def _family_with_young(w):
    for hid in sorted(w["households"], key=int):
        hh = w["households"][hid]
        if families.young_in(w, hh) and [
                r for r in families.members(w, hh) if families.is_guardian(r)]:
            return hh
    raise AssertionError("no household with a young child on this seed")


def _out(r, x, y):
    r["where"] = {"mode": "at", "x": x, "y": y, "fixture": None}


def _home(r, hh):
    r["where"] = {"mode": "in", "unit": hh["unit"], "x": 0, "y": 0,
                  "fixture": None}


def _add(w, hh, age):
    rid = w["next_id"]; w["next_id"] += 1
    r = W.new_resident(rid, hh["id"], age)
    r["name"] = f"Test{rid}"
    _home(r, hh)
    w["residents"][str(rid)] = r
    hh["members"].append(rid)
    return r


class ThresholdTest(unittest.TestCase):
    def test_the_threshold_is_a_named_rule(self):
        f = rules.R["families"]
        self.assertEqual(f["young_under"], 10)
        self.assertEqual(f["guardian_from"], 16)
        self.assertLess(f["young_under"], f["guardian_from"])
        self.assertLessEqual(f["guardian_from"],
                             rules.R["people"]["ages"]["adult"])


class InvariantTest(unittest.TestCase):
    """Five seeds, 380 days each: every phase of every day."""

    SEEDS = (42, 1, 2, 3, 7)
    DAYS = 380

    def test_no_young_child_is_out_alone_or_home_alone(self):
        tally, cases = _measure(self.SEEDS, self.DAYS)
        self.assertGreater(tally["young_out"], 1000)     # it was exercised
        self.assertGreater(tally["young_in"], 1000)
        self.assertEqual(tally["out_alone"], 0, cases[:5])
        self.assertEqual(tally["home_alone"], 0, cases[:5])
        self.assertEqual(tally["older_out_of_bounds"], 0)

    def test_the_day_starts_with_nothing_to_mend(self):
        """The slow layer settles at the end of each day, so the day's own
        settle never has anything left to do."""
        w = gen.generate(42)
        real = families.settle
        mended = []

        def spy(w, evs=None):
            n = real(w, evs)
            mended.append(n)
            return n

        with mock.patch.object(families, "settle", spy):
            for _ in range(60):
                sim.tick(w)
        # two calls a day: the day's own first (even), then the slow
        # layer's at the end (odd), which may have a birth to mend
        self.assertEqual(len(mended), 120)
        self.assertEqual(sum(mended[0::2]), 0, mended[:20])


class MutantTest(unittest.TestCase):
    """Take the rule away and the invariant has to catch it."""

    def test_without_the_rule_children_are_left_alone(self):
        with mock.patch.object(families, "plan", lambda w, press: {}), \
                mock.patch.object(families, "settle", lambda w, evs=None: 0), \
                mock.patch.object(families, "allows",
                                  lambda w, r, c, phase, minding: True), \
                mock.patch.object(families, "curfew",
                                  lambda w, r, phase, minding: False):
            tally, _ = _measure((42,), 60)
        self.assertGreater(tally["out_alone"] + tally["home_alone"], 0)
        self.assertGreater(tally["out_alone"], 0)

    def test_without_the_minder_alone_the_check_fails(self):
        """Curfews stay, only the minding party goes: still caught."""
        with mock.patch.object(families, "plan", lambda w, press: {}), \
                mock.patch.object(families, "settle", lambda w, evs=None: 0):
            tally, _ = _measure((42,), 60)
        self.assertGreater(tally["out_alone"] + tally["home_alone"], 0)


class EdgeCaseTest(unittest.TestCase):
    def setUp(self):
        self.w = gen.generate(42)
        self.hh = _family_with_young(self.w)

    def _guards(self):
        return [r for r in families.members(self.w, self.hh)
                if families.is_guardian(r)]

    def test_a_single_parent_minds_alone(self):
        w, hh = self.w, self.hh
        guards = sorted(self._guards(), key=lambda r: -r["age"])
        for g in guards[1:]:
            hh["members"].remove(g["id"])
            w["residents"].pop(str(g["id"]))
        if guards[0]["age"] < rules.R["people"]["ages"]["adult"]:
            guards[0]["age"] = 30
        tally, cases = _measure((None,), 120, world=w)
        self.assertEqual(tally["out_alone"] + tally["home_alone"], 0, cases)
        self.assertGreater(tally["young_out"], 0)

    def test_a_newly_arrived_family_is_minded_from_day_one(self):
        w = self.w
        unit = next((u for u in w["units"].values()
                     if u["household"] is None), None)
        if unit is None:
            victim = next(h for h in w["households"].values()
                          if h["id"] != self.hh["id"])
            households.move_out(w, victim, "test")
            unit = w["units"][str(victim["unit"])]
        rng = random.Random(5)
        hh = households.move_in(w, "family", unit, rng)
        _add(w, hh, 3)                     # make sure there is a young one
        self.assertEqual(families.unattended(w), [])
        tally, cases = _measure((None,), 30, world=w)
        self.assertEqual(tally["out_alone"] + tally["home_alone"], 0, cases)

    def test_a_household_left_with_no_adult_leaves_whole(self):
        w, hh = self.w, self.hh
        adult = rules.R["people"]["ages"]["adult"]
        for r in list(families.members(w, hh)):
            if r["age"] >= adult:
                hh["members"].remove(r["id"])
                w["residents"].pop(str(r["id"]))
        kids = list(hh["members"])
        evs = []
        families.settle(w, evs)
        self.assertNotIn(str(hh["id"]), w["households"])
        for k in kids:
            self.assertNotIn(str(k), w["residents"])
        self.assertIsNone(w["units"][str(hh["unit"])]["household"])
        self.assertTrue(any(e["kind"] == "left"
                            and "family elsewhere" in e["what"] for e in evs))

    def test_a_dead_minder_is_replaced_by_the_other_guardian(self):
        w, hh = self.w, self.hh
        kid = families.young_in(w, hh)[0]
        g1 = _add(w, hh, 40)
        g2 = _add(w, hh, 70)
        for g in self._guards():
            if g is not g1 and g is not g2:
                _out(g, 2, 2)
        _out(kid, 5, 5); _out(g1, 5, 5); _out(g2, 30, 20)
        for k in families.young_in(w, hh):
            if k is not kid:
                k["where"] = dict(kid["where"])
        hh["members"].remove(g1["id"]); w["residents"].pop(str(g1["id"]))
        self.assertTrue(families.unattended(w))
        self.assertGreater(families.settle(w), 0)
        self.assertEqual(families.unattended(w), [])

    def test_a_baby_born_while_everyone_is_out_brings_a_guardian_home(self):
        w, hh = self.w, self.hh
        for k in families.young_in(w, hh):
            hh["members"].remove(k["id"]); w["residents"].pop(str(k["id"]))
        for i, g in enumerate(self._guards()):
            _out(g, 3 + i, 3)
        baby = _add(w, hh, 0)
        self.assertEqual(families.unattended(w), [(baby, hh)])
        self.assertEqual(families.settle(w), 1)
        eldest = max(self._guards(), key=lambda r: (r["age"], -r["id"]))
        self.assertEqual(eldest["where"]["mode"], "in")
        self.assertEqual(eldest["where"]["unit"], hh["unit"])
        self.assertTrue(families.together(baby, eldest))

    def test_a_sibling_of_sixteen_minds_and_of_fifteen_does_not(self):
        w, hh = self.w, self.hh
        kid = families.young_in(w, hh)[0]
        for r in families.members(w, hh):
            if r is not kid:
                _out(r, 1, 1)
        _home(kid, hh)
        sib = _add(w, hh, rules.R["families"]["guardian_from"])
        self.assertIn(sib, families.guardians_of(w, kid))
        self.assertTrue(families.together(kid, sib))
        self.assertNotIn(kid, [k for k, _ in families.unattended(w)])
        sib["age"] -= 1
        self.assertNotIn(sib, families.guardians_of(w, kid))
        self.assertIn(kid, [k for k, _ in families.unattended(w)])

    def test_the_least_pressed_guardian_covers(self):
        w, hh = self.w, self.hh
        kids = families.young_in(w, hh)
        a, b = _add(w, hh, 35), _add(w, hh, 36)
        for r in families.members(w, hh):
            _home(r, hh)
        press = {a["id"]: 5.0, b["id"]: 1.0}
        leads = families.plan(w, lambda g: press.get(g["id"], 9.0))
        self.assertEqual(sorted(k["id"] for k in leads[b["id"]]),
                         sorted(k["id"] for k in kids))
        self.assertNotIn(a["id"], leads)

    def test_the_party_moves_together(self):
        """A minder's errand takes the children along: after any phase they
        are on the minder's cell or in the minder's flat."""
        w = self.w
        sim.tick(w)
        for k, _ in [(k, hh) for hh in w["households"].values()
                     for k in families.young_in(w, hh)]:
            self.assertTrue(any(families.together(k, g)
                                for g in families.guardians_of(w, k)))


class OlderChildTest(unittest.TestCase):
    def setUp(self):
        self.w = gen.generate(42)
        hh = next(h for h in self.w["households"].values()
                  if h["unit"] is not None)
        self.hh = hh
        self.kid = _add(self.w, hh, 12)
        u = self.w["units"][str(hh["unit"])]
        self.door = self.w["buildings"][str(u["building"])]["door"]

    def _c(self, kind, dx=0):
        return {"kind": kind, "x": self.door[0] + dx, "y": self.door[1],
                "fixture": None, "unit": None}

    def test_playground_and_shop_near_home_in_daytime(self):
        f = rules.R["families"]
        for phase in f["older_daytime"]:
            for kind in f["older_places"]:
                self.assertTrue(families.allows(self.w, self.kid,
                                                self._c(kind), phase, False))

    def test_nothing_else_and_nowhere_far(self):
        f = rules.R["families"]
        self.assertFalse(families.allows(self.w, self.kid, self._c("bench"),
                                         "afternoon", False))
        far = self._c("playground", f["older_range"] + 1)
        self.assertFalse(families.allows(self.w, self.kid, far,
                                         "afternoon", False))

    def test_home_by_evening_and_night(self):
        for phase in ("evening", "night"):
            self.assertFalse(families.allows(self.w, self.kid,
                                             self._c("playground"), phase,
                                             False))
            self.assertTrue(families.curfew(self.w, self.kid, phase, False))
            self.assertTrue(families.allows(self.w, self.kid,
                                            self._c("home"), phase, False))

    def test_a_minder_is_home_by_night(self):
        g = _add(self.w, self.hh, 40)
        _add(self.w, self.hh, 4)
        for phase in rules.R["families"]["home_by"]:
            self.assertTrue(families.curfew(self.w, g, phase, True))
            self.assertFalse(families.allows(self.w, g, self._c("shop"),
                                             phase, True))


class SnapshotTest(unittest.TestCase):
    def test_a_young_child_out_is_walking_with_a_guardian(self):
        w = gen.generate(42)
        hh = _family_with_young(w)
        kid = families.young_in(w, hh)[0]
        g = next(r for r in families.members(w, hh)
                 if families.is_guardian(r))
        self.assertIsNone(web._walking_with(w, kid))      # indoors
        _out(g, 6, 6); _out(kid, 6, 7)
        self.assertEqual(web._walking_with(w, kid), g["id"])
        self.assertIsNone(web._walking_with(w, g))        # not a child
        _out(g, 20, 20)
        self.assertIsNone(web._walking_with(w, kid))


if __name__ == "__main__":
    unittest.main()
