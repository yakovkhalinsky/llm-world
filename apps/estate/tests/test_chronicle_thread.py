"""The chronicle is written off the sim thread: a hung or slow model never
freezes the estate, and the record is still written once.

    python3 -m unittest tests.test_chronicle_thread
"""

import threading
import time
import unittest

from estate import chronicler, gen, web
from tests.test_decide import Stub


class FakeDB:
    def __init__(self):
        self.rows = []

    def add_chronicle(self, day, text):
        self.rows.append((day, text))


class FakeEstate:
    def __init__(self, w):
        self.world = w
        self.db = FakeDB()

    def save(self, evs=()):
        pass


class ChronicleThreadTest(unittest.TestCase):

    def runner(self, llm):
        w = gen.generate(42)
        w["day"] = 30
        est = FakeEstate(w)
        r = web.SimRunner(est, threading.Lock(), 3600, llm=llm)
        r.lines = ["the Okafors moved in", "rain on the green"]
        r.span = 5
        return r, est

    def wait(self, r):
        for _ in range(100):
            if not r.chron_busy:
                return
            time.sleep(0.05)
        self.fail("the chronicle never landed")

    def test_a_slow_model_does_not_stall_the_sim(self):
        r, est = self.runner(Stub(reply={"text": "A wet, settled week."},
                                  delay=1.0))
        t0 = time.time()
        r._maybe_chronicle()
        self.assertLess(time.time() - t0, 0.3)
        self.assertTrue(r.chron_busy)
        # the days go on and gather lines for the next entry
        self.assertEqual((r.lines, r.span), ([], 0))
        r.lines.append("a third thing")
        r.span = 4
        r._maybe_chronicle()                 # busy: waits its turn
        self.assertEqual(r.lines, ["a third thing"])
        self.wait(r)
        self.assertEqual(est.db.rows, [(30, "A wet, settled week.")])
        self.assertEqual(r.chronicle[-1]["text"], "A wet, settled week.")

    def test_no_model_writes_the_template_at_once(self):
        r, est = self.runner(None)
        r._maybe_chronicle()
        self.assertFalse(r.chron_busy)
        self.assertEqual(est.db.rows, [(30, chronicler.fallback(
            ["the Okafors moved in", "rain on the green"], 5))])

    def test_a_model_that_answers_nothing_leaves_the_template(self):
        r, est = self.runner(Stub(reply=None))
        r._maybe_chronicle()
        self.wait(r)
        self.assertEqual(len(est.db.rows), 1)
        self.assertTrue(est.db.rows[0][1].startswith("5 days:"))


if __name__ == "__main__":
    unittest.main()
