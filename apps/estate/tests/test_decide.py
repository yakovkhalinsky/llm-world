"""decide(): the watcher's choice made in code, the model kept to words.

    python3 -m unittest tests.test_decide
"""

import random
import threading
import time
import unittest

from estate import decide, gen, rules, watcher, web
from estate import world as W


class Stub:
    """An LLM that answers (or not) on demand, counting its calls."""

    def __init__(self, reply=None, ready=True, delay=0.0, mode="rules"):
        self.reply, self._ready, self.delay = reply, ready, delay
        self.decide = mode
        self.calls = []

    def ready(self):
        return self._ready

    @property
    def enabled(self):
        return self._ready

    def watch_gap(self):
        return (60, 120)

    def chat_json(self, system, user, schema, **kw):
        self.calls.append((user, schema, kw))
        time.sleep(self.delay)
        return self.reply


class DecideCoreTest(unittest.TestCase):

    def test_the_same_rng_gives_the_same_answers(self):
        q = {"a": {"type": "choice", "options": {"x": 1, "y": 2, "z": 0}},
             "b": {"type": "score", "levels": [1, 2, 3]}}
        one = decide.decide(q, random.Random("s"))
        two = decide.decide(q, random.Random("s"))
        self.assertEqual(one, two)
        self.assertAlmostEqual(sum(one["a"]["probs"].values()), 1.0)
        self.assertEqual(one["a"]["confidence"],
                         one["a"]["probs"][one["a"]["pick"]])

    def test_a_zero_weight_is_never_picked(self):
        q = {"a": {"type": "choice", "options": {"x": 0, "y": 1}}}
        for i in range(200):
            self.assertEqual(decide.decide(q, random.Random(i))["a"]["pick"],
                             "y")


class WatchTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.w = gen.generate(42)

    def test_the_same_day_makes_the_same_choice(self):
        self.assertEqual(decide.watch(self.w), decide.watch(self.w))

    def test_every_choice_is_legal(self):
        w = dict(self.w)
        seen = set()
        for day in range(1, 400, 3):
            w["day"] = day
            pick = watcher.choose(w)
            self.assertIn(pick["fate"], rules.R["fates"])
            self.assertIn(pick["region"], watcher.regions_for(pick["fate"]))
            self.assertTrue(pick["why"])
            self.assertEqual(watcher.validate(pick)["fate"], pick["fate"])
            seen.add(pick["fate"])
        self.assertIn("quiet", seen)
        self.assertGreater(len(seen), 4)        # not one fate forever

    def test_the_season_shapes_the_weather(self):
        w = dict(self.w)
        days = {W.season_name(d): d for d in range(1, 400)}
        w["day"] = days["winter"]
        wint = decide.fate_weights(w)
        w["day"] = days["summer"]
        summ = decide.fate_weights(w)
        self.assertGreater(wint["frost"], wint["heat"])
        self.assertGreater(summ["heat"], summ["frost"])

    def test_a_fate_in_force_is_not_sent_again(self):
        w = dict(self.w, fates=[{"kind": "rain", "left": 2}])
        self.assertLess(decide.fate_weights(w)["rain"],
                        decide.fate_weights(self.w)["rain"])


class InviteTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.w = gen.generate(42)

    def test_no_model_still_chooses_with_the_packs_words(self):
        intent = watcher.invite(Stub(ready=False), self.w)
        self.assertEqual(intent, watcher.choose(self.w))
        self.assertEqual(intent["why"],
                         rules.R["fates"][intent["fate"]]["why"])

    def test_the_model_writes_only_the_why(self):
        llm = Stub(reply={"why": "  because  it is time ",
                          "fate": "storm"})
        intent = watcher.invite(llm, self.w)
        self.assertEqual(intent["fate"], watcher.choose(self.w)["fate"])
        self.assertEqual(intent["why"], "because it is time")
        _user, schema, kw = llm.calls[0]
        self.assertEqual(schema, watcher.WHY_SCHEMA)
        self.assertEqual(kw["job"], "watch")

    def test_an_unreadable_why_keeps_the_template(self):
        intent = watcher.invite(Stub(reply={"nope": 1}), self.w)
        self.assertEqual(intent["why"],
                         rules.R["fates"][intent["fate"]]["why"])

    def test_decide_llm_keeps_the_old_way(self):
        llm = Stub(reply={"fate": "storm", "region": "all", "why": "w"},
                   mode="llm")
        intent = watcher.invite(llm, self.w)
        self.assertEqual(intent["fate"], "storm")
        self.assertEqual(llm.calls[0][1], watcher.schema())


class FakeEstate:
    def __init__(self, w):
        self.world = w
        self.saves = 0

    def save(self, evs=()):
        self.saves += 1


class RunnerTest(unittest.TestCase):
    """With decide=rules the fate lands at once and the why is written off
    the sim thread: a slow model never stalls the estate."""

    def _noisy_day(self):
        w = gen.generate(42)
        for day in range(1, 400):
            w["day"] = day
            if decide.watch(w)["fate"] != "quiet":
                return w
        self.fail("no day sent anything")

    def test_the_fate_lands_before_the_model_answers(self):
        w = self._noisy_day()
        llm = Stub(reply={"why": "the model's why"}, delay=0.6)
        r = web.SimRunner(FakeEstate(w), threading.Lock(), 3600, llm=llm)
        t0 = time.time()
        r._maybe_watch()
        self.assertLess(time.time() - t0, 0.4)
        self.assertEqual(len(w["pending"]), 1)
        self.assertEqual(r.last_watch["why"],
                         rules.R["fates"][r.last_watch["fate"]]["why"])
        for _ in range(50):
            if not r.why_busy:
                break
            time.sleep(0.05)
        self.assertEqual(r.last_watch["why"], "the model's why")

    def test_no_model_still_lands_a_fate(self):
        w = self._noisy_day()
        r = web.SimRunner(FakeEstate(w), threading.Lock(), 3600,
                          llm=Stub(ready=False))
        r._maybe_watch()
        self.assertEqual(len(w["pending"]), 1)
        self.assertFalse(r.why_busy)


if __name__ == "__main__":
    unittest.main()
