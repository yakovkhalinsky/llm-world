"""decide(): the World Soul's move and the steward's amendments chosen in
code, the model kept to words.

    python3 -m unittest tests.test_decide
"""

import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from grove import decide, gen, operator, reviewer  # noqa: E402
from grove import world as W                      # noqa: E402
import helpers                                    # noqa: E402


class DecideCoreTest(unittest.TestCase):

    def test_the_same_rng_gives_the_same_answers(self):
        q = {"a": {"type": "choice", "options": {"x": 1, "y": 2}}}
        self.assertEqual(decide.decide(q, random.Random(7)),
                         decide.decide(q, random.Random(7)))

    def test_a_zero_weight_is_never_picked(self):
        q = {"a": {"type": "choice", "options": {"x": 0, "y": 1}}}
        for i in range(200):
            self.assertEqual(decide.decide(q, random.Random(i))["a"]["pick"],
                             "y")


class OperatorTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.w = gen.generate(42)

    def test_the_same_week_makes_the_same_move(self):
        self.assertEqual(operator.choose(self.w), operator.choose(self.w))

    def test_every_move_is_legal(self):
        w = dict(self.w)
        seen = set()
        for tick in range(300):
            w["tick"] = tick
            eff = operator.choose(w)
            self.assertIn(eff["action"], operator.MENU)
            self.assertIn(eff["region"], operator.REGIONS)
            self.assertIn(eff["strength"], (1, 2, 3))
            self.assertTrue(eff["intent"])
            again = operator.validate(eff)
            self.assertEqual(again["action"], eff["action"])
            if eff["action"] == "destiny":
                self.assertIn(str(eff["target"]), w["animals"])
                self.assertTrue(eff["destiny"])
            if eff["action"] in ("blight", "migration"):
                self.assertTrue(eff["species"])
            seen.add(eff["action"])
        self.assertIn("quiet", seen)
        self.assertGreater(len(seen), 4)

    def test_three_times_running_is_enough(self):
        w = dict(self.w, op_history=[{"action": "storm"}] * 3)
        self.assertEqual(decide.operator_weights(w)["storm"], 0.0)
        w = dict(self.w, op_history=[{"action": "storm"}])
        self.assertLess(decide.operator_weights(w)["storm"],
                        decide.operator_weights(self.w)["storm"])

    def test_no_target_no_destiny(self):
        w = dict(self.w, destinies=[{"id": i} for i in range(3)])
        self.assertEqual(decide.operator_weights(w)["destiny"], 0.0)

    def test_words_never_change_the_move(self):
        w = dict(self.w)
        for tick in range(60):
            w["tick"] = tick
            eff = operator.choose(w)
            raw = {"intent": "  I  will  drown it all ", "action": "storm",
                   "region": "NW", "strength": 3, "destiny": "dies"}
            out = operator.with_words(eff, raw)
            for k in ("action", "region", "strength", "species", "target"):
                self.assertEqual(out[k], eff[k])
            self.assertEqual(out["intent"], "I will drown it all")
            self.assertNotIn("confidence", out)
            if eff["action"] != "destiny":
                self.assertEqual(out["destiny"], eff["destiny"])

    def test_the_words_are_capped(self):
        eff = operator.choose(self.w)
        out = operator.with_words(eff, {"intent": "w " * 200,
                                        "destiny": "d " * 200})
        self.assertEqual(len(out["intent"]), 140)
        dest = dict(eff, action="destiny", destiny="old")
        out = operator.with_words(dest, {"destiny": "d " * 200})
        self.assertEqual(len(out["destiny"]), 90)

    def test_unusable_words_keep_the_template(self):
        eff = operator.choose(self.w)
        out = operator.with_words(eff, None)
        self.assertEqual(out["intent"], eff["intent"])


class AmendmentsTest(unittest.TestCase):

    def _sp(self):
        return sorted(sp for sp, t in W.ANIMAL_SPECIES.items()
                      if "cap" in t and not t.get("visitor"))

    def test_a_boom_and_crash_asks_for_a_smaller_cap(self):
        sp = self._sp()[0]
        cap = W.ANIMAL_SPECIES[sp]["cap"]
        led = {"peak_trough_end": {"pop": {sp: (0, cap)}},
               "end": {"pop": {sp: 0}}}
        out = decide.amendments(led)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["rule"], f"animals.{sp}.cap")
        self.assertLess(out[0]["value"], cap)
        ok, _v, why = reviewer.validate(out[0])
        self.assertTrue(ok, why)

    def test_life_at_the_ceiling_asks_for_room(self):
        sp = self._sp()[0]
        cap = W.ANIMAL_SPECIES[sp]["cap"]
        led = {"peak_trough_end": {"pop": {sp: (cap, cap)}},
               "end": {"pop": {sp: cap}}}
        out = decide.amendments(led)
        self.assertGreater(out[0]["value"], cap)
        self.assertTrue(reviewer.validate(out[0])[0])

    def test_at_most_two_and_a_quiet_year_asks_nothing(self):
        sps = self._sp()
        led = {"peak_trough_end": {"pop": {
            sp: (0, W.ANIMAL_SPECIES[sp]["cap"]) for sp in sps}},
            "end": {"pop": {}}}
        self.assertLessEqual(len(decide.amendments(led)), 2)
        led = {"peak_trough_end": {"pop": {
            sp: (1, max(1, W.ANIMAL_SPECIES[sp]["cap"] // 2))
            for sp in sps}}, "end": {"pop": {sp: 1 for sp in sps}}}
        self.assertEqual(decide.amendments(led), [])


class Stub:
    decide = "rules"

    def ready(self):
        return False


class QueueStub:
    busy = False

    def __init__(self, accept):
        self.accept = accept
        self.jobs = []

    def submit(self, job):
        self.jobs.append(job)
        return self.accept


class AppTest(unittest.TestCase):
    """No model, or a model that answers: the soul's move is the same."""

    def setUp(self):
        self.tmp, _d, self.g, _l, _r = helpers.make_grove(42)
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.g.db.con.close)

    def test_no_model_lands_the_move_with_its_template(self):
        g = self.g
        g.llm, g.worker = Stub(), QueueStub(True)
        want = operator.with_words(operator.choose(g.world), None)
        g._invite_operator()
        self.assertEqual(g.world["pending_effect"], want)
        self.assertEqual(g.worker.jobs, [])     # nothing asked of a model

    def test_the_models_words_ride_on_the_chosen_move(self):
        g = self.g
        stub = Stub()
        stub.ready = lambda: True
        g.llm, g.worker = stub, QueueStub(True)
        eff = operator.choose(g.world)
        g._invite_operator()
        # the move is queued at invite time, template words and all
        landed = g.world["pending_effect"]
        self.assertEqual(landed, operator.with_words(eff, None))
        job = g.worker.jobs[0]
        self.assertEqual(job["schema"], operator.WORDS_SCHEMA)
        g._apply_one({"kind": "op", "ok": True,
                      "data": {"intent": "the soul speaks"},
                      "extra": job["extra"]})
        got = g.world["pending_effect"]
        self.assertIs(got, landed)
        self.assertEqual(got["action"], eff["action"])
        self.assertEqual(got["intent"], "the soul speaks")
        self.assertIn("the soul speaks", g.soul_line)

    def test_a_slow_model_never_delays_the_move(self):
        """The op lands at the next tick whatever the model is doing; words
        that come back after it landed rewrite its chronicle line only."""
        g = self.g
        stub = Stub()
        stub.ready = lambda: True
        g.llm, g.worker = stub, QueueStub(True)
        g._invite_operator()
        template = g.world["pending_effect"]["intent"]
        g.step()                                  # lands, no words yet
        self.assertIsNone(g.world.get("pending_effect"))
        ops = [r for r in g.db.chronicle(50) if r[4] == template]
        self.assertTrue(ops, "the op's template line was not recorded")
        g._apply_one({"kind": "op", "ok": True,
                      "data": {"intent": "late, but the soul's own"},
                      "extra": g.worker.jobs[0]["extra"]})
        texts = [r[4] for r in g.db.chronicle(50)]
        self.assertIn("late, but the soul's own", texts)
        self.assertNotIn(template, texts)

    def test_words_never_change_the_world(self):
        """Two groves, one whose model answers and one whose never does,
        tick to the same world."""
        tmp, _d, g2, _l, _r = helpers.make_grove(42)
        self.addCleanup(tmp.cleanup)
        self.addCleanup(g2.db.con.close)
        for g, answers in ((self.g, True), (g2, False)):
            stub = Stub()
            stub.ready = lambda: True
            g.llm, g.worker = stub, QueueStub(True)
            for _ in range(3):
                g._invite_operator()
                if answers:
                    g._apply_one({"kind": "op", "ok": True,
                                  "data": {"intent": "words", "destiny":
                                           "a fate in words"},
                                  "extra": g.worker.jobs[-1]["extra"]})
                for _ in range(4):
                    g.step()
        strip = ("pending_effect", "destinies", "op_history")
        a = {k: v for k, v in self.g.world.items() if k not in strip}
        b = {k: v for k, v in g2.world.items() if k not in strip}
        self.assertEqual(a, b)

    def test_a_full_queue_still_lands_the_move(self):
        g = self.g
        stub = Stub()
        stub.ready = lambda: True
        g.llm, g.worker = stub, QueueStub(False)
        g._invite_operator()
        self.assertEqual(g.world["pending_effect"]["action"],
                         operator.choose(g.world)["action"])


if __name__ == "__main__":
    unittest.main()
