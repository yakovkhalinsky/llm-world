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

The curfew and the evening range are measured where people end up, and their
mutants (no evening range; the walk home capped by the phase) must fail.
The walk tests pin the way round the block row that used to trap a family
behind it, and the walk home at night that must arrive however far it is.

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

    def test_the_night_curfew_and_the_evening_range_hold(self):
        """Measured where people end up: nobody from a household with young
        children is out at the end of the night, and no young child (so no
        minder) ends the evening beyond `evening_range` of the door. Seed 1
        is the one the review traced a family stranded behind the row on."""
        tally, cases = _measure(self.SEEDS, self.DAYS)
        self.assertEqual(tally["young_out_at_night"], 0, cases[:5])
        self.assertEqual(tally["household_out_at_night"], 0, cases[:5])
        self.assertEqual(tally["evening_far"], 0, cases[:5])
        self.assertEqual(family_check.failures(tally), 0)

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
        with mock.patch.object(families, "plan", lambda w, press, busy=None: {}), \
                mock.patch.object(families, "settle", lambda w, evs=None: 0), \
                mock.patch.object(families, "allows",
                                  lambda *a, **k: True), \
                mock.patch.object(families, "curfew",
                                  lambda w, r, phase, minding: False):
            tally, _ = _measure((42,), 60)
        self.assertGreater(tally["out_alone"] + tally["home_alone"], 0)
        self.assertGreater(tally["out_alone"], 0)

    def test_without_the_minder_alone_the_check_fails(self):
        """Curfews stay, only the minding party goes: still caught."""
        with mock.patch.object(families, "plan", lambda w, press, busy=None: {}), \
                mock.patch.object(families, "settle", lambda w, evs=None: 0):
            tally, _ = _measure((42,), 60)
        self.assertGreater(tally["out_alone"] + tally["home_alone"], 0)


class EveningMutantTest(unittest.TestCase):
    """The evening range and the curfew walk, each taken away, are caught."""

    def test_without_the_evening_range_minders_end_the_evening_far(self):
        real = families.allows

        def no_range(w, r, c, phase, minding, reach=None):
            if minding and phase == "evening" and c["kind"] != "home":
                return True                    # families.py's range check
            return real(w, r, c, phase, minding, reach)

        with mock.patch.object(families, "allows", no_range):
            tally, _ = _measure((42,), 120)
        self.assertGreater(tally["evening_far"], 0)

    def test_without_the_sure_walk_home_the_curfew_fails(self):
        """The walk home capped by the phase's budget, as it was."""
        with mock.patch.object(families, "sure_home",
                               lambda *a, **k: False), \
                mock.patch.object(families, "reach_matters",
                                  lambda phase: False):
            tally, _ = _measure((1,), 120)
        self.assertGreater(tally["young_out_at_night"]
                           + tally["evening_far"], 0)


class WalkTest(unittest.TestCase):
    """The walk round a wall, and the walk home that must arrive."""

    def test_the_trap_behind_the_row_is_walked_out_of(self):
        """Seed 1: north of the row at (26,5), for the door at (27,12) on
        its south side. The old side-step swung between (25,5) and (26,5)
        for the whole walk; now it goes round the block's end."""
        w = gen.generate(1)
        r = next(iter(w["residents"].values()))
        r["where"] = {"mode": "at", "x": 26, "y": 5, "fixture": None}
        self.assertFalse(W.passable(w, 26, 6))
        seen = []
        for _ in range(10):
            if residents._walk(w, r, 27, 12, 3):
                break
            seen.append((r["where"]["x"], r["where"]["y"]))
        self.assertEqual((r["where"]["x"], r["where"]["y"]), (27, 12))
        self.assertEqual(len(seen), len(set(seen)), seen)   # never back

    def test_a_walk_never_steps_on_a_wall(self):
        w = gen.generate(42)
        r = next(iter(w["residents"].values()))
        rng = random.Random(5)
        cells = [(x, y) for y in range(w["height"]) for x in range(w["width"])
                 if W.passable(w, x, y)]
        for _ in range(200):
            (sx, sy), (tx, ty) = rng.sample(cells, 2)
            r["where"] = {"mode": "at", "x": sx, "y": sy, "fixture": None}
            for _ in range(200):
                done = residents._walk(w, r, tx, ty, 1)
                self.assertTrue(W.passable(w, r["where"]["x"],
                                           r["where"]["y"]))
                if done:
                    break
            self.assertEqual((r["where"]["x"], r["where"]["y"]), (tx, ty))

    def test_the_walk_home_at_night_arrives_however_far(self):
        """A slow minder at the far corner of the estate with the children
        at nightfall: one phase later they are all indoors."""
        w = gen.generate(42)
        hh = _family_with_young(w)
        folk = families.members(w, hh)
        guards = [g for g in folk if families.is_guardian(g)]
        for g in folk:
            g["mobility"] = 0.3
            _out(g, w["width"] - 2, w["height"] - 2)
        lead = min(guards, key=lambda g: g["id"])
        cand = residents.candidates(w)
        kids = families.young_in(w, hh)
        others = [g for g in folk if g is not lead and g not in kids]
        residents._live(w, [lead] + kids, cand, "night", 99)
        for o in others:
            residents._live(w, [o], cand, "night", 99)
        for r in folk:
            self.assertEqual(r["where"]["mode"], "in", r["id"])
            self.assertEqual(r["where"]["unit"], hh["unit"])

    def test_the_evening_choice_passes_over_what_the_walk_cannot_reach(self):
        # #10 review: nothing failed with the reach left out of `_choose`.
        # A family wanting to play goes to the playground; with that one
        # cell beyond the walk this evening, they go somewhere else
        w = gen.generate(42)
        hh = _family_with_young(w)
        party = sorted(families.members(w, hh),
                       key=lambda r: (not families.is_guardian(r), r["id"]))
        party = [party[0]] + [r for r in party if families.is_young(r)]
        door = w["buildings"][str(
            w["units"][str(hh["unit"])]["building"])]["door"]
        for r in party:
            _out(r, *door)
            r["needs"].update(food=0.0, rest=0.0, quiet=0.0, company=1.0,
                              play=4.0)
        cand = residents.candidates(w)
        c, need, _ = residents._choose(w, party, cand, "evening",
                                       random.Random(1))
        self.assertEqual((c["kind"], need), ("playground", "play"))
        real = residents._reach

        def beyond(w, sx, sy, limit=None):
            dist = real(w, sx, sy, limit)
            dist.pop((c["x"], c["y"]), None)
            return dist
        with mock.patch.object(residents, "_reach", beyond):
            c2, _, _ = residents._choose(w, party, cand, "evening",
                                         random.Random(1))
        self.assertIsNotNone(c2)
        self.assertNotEqual((c2["x"], c2["y"]), (c["x"], c["y"]))

    def test_a_minders_evening_walk_home_is_sure_without_a_curfew(self):
        # in range, in the evening, no curfew yet: the walk home must still
        # arrive, or a capped one could end the evening beyond the range
        w = gen.generate(42)
        hh = _family_with_young(w)
        g = next(r for r in families.members(w, hh)
                 if families.is_guardian(r))
        door = w["buildings"][str(
            w["units"][str(hh["unit"])]["building"])]["door"]
        _out(g, door[0] + 1, door[1])
        self.assertFalse(families.curfew(w, g, "evening", True))
        self.assertTrue(families.sure_home(w, g, "evening", True))
        self.assertFalse(families.sure_home(w, g, "evening", False))

    def test_the_capped_reach_is_the_full_one_cut_at_the_budget(self):
        w = gen.generate(42)
        hh = _family_with_young(w)
        door = w["buildings"][str(
            w["units"][str(hh["unit"])]["building"])]["door"]
        full = residents._reach(w, *door)
        for budget in (1, 5, 12, 30):
            self.assertEqual(residents._reach(w, *door, budget),
                             {k: d for k, d in full.items() if d <= budget})

    def test_an_evening_outing_is_one_the_party_can_reach(self):
        w = gen.generate(42)
        hh = _family_with_young(w)
        g = next(r for r in families.members(w, hh) if families.is_guardian(r))
        _add(w, hh, 4)
        u = w["units"][str(hh["unit"])]
        door = w["buildings"][str(u["building"])]["door"]
        c = {"kind": "bench", "x": door[0] + 2, "y": door[1],
             "fixture": None, "unit": None}
        self.assertTrue(families.allows(w, g, c, "evening", True,
                                        lambda c: True))
        self.assertFalse(families.allows(w, g, c, "evening", True,
                                         lambda c: False))
        far = dict(c, x=door[0] + rules.R["families"]["evening_range"] + 1)
        self.assertFalse(families.allows(w, g, far, "evening", True,
                                         lambda c: True))
        # out beyond the range already: the minder heads home
        _out(g, far["x"], far["y"])
        self.assertTrue(families.curfew(w, g, "evening", True))
        self.assertTrue(families.sure_home(w, g, "evening", True))
        _out(g, c["x"], c["y"])
        self.assertFalse(families.curfew(w, g, "evening", True))


class FrictionTest(unittest.TestCase):
    def test_each_resident_is_ranked_once_a_phase(self):
        """The gate's friction samples `ranked_needs`; a party member
        ranked again for `_also` was counted twice."""
        w = gen.generate(1)
        real = residents.ranked_needs
        seen = []

        def spy(w_, r, phase):
            seen.append((w_["day"], phase, r["id"]))
            return real(w_, r, phase)

        with mock.patch.object(residents, "ranked_needs", spy):
            for _ in range(30):
                sim.tick(w)
        self.assertGreater(len(seen), 1000)
        self.assertEqual(len(seen), len(set(seen)))


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

    def test_a_child_stays_with_the_guardian_beside_them(self):
        """Minding passes hand to hand: a guardian out across the estate,
        however unpressed, does not take over a child at home with the
        other one (`plan` picks only from the guardians together with the
        child)."""
        w, hh = self.w, self.hh
        kids = families.young_in(w, hh)
        a, b = _add(w, hh, 35), _add(w, hh, 36)
        for r in families.members(w, hh):
            if r is not b:
                _home(r, hh)
        _out(b, 3, 3)
        others = [g for g in self._guards() if g not in (a, b)]
        for g in others:
            _out(g, 4, 4)
        press = {a["id"]: 5.0, b["id"]: 0.0}
        leads = families.plan(w, lambda g: press.get(g["id"], 9.0))
        self.assertEqual(sorted(k["id"] for k in leads.get(a["id"], [])),
                         sorted(k["id"] for k in kids))
        self.assertNotIn(b["id"], leads)

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
