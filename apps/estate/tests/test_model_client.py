"""The client's view of a model that is there but not answering: a cloud
name /api/show could not confirm once, and models that keep failing.

    python3 -m unittest tests.test_model_client
"""

import unittest

from estate import llm as llmm
from tests.test_models import FakeOllama, QWEN, GEMMA, CLOUD

LEAD = llmm.LEAD_JOB


class ShowBackoffTest(unittest.TestCase):

    def make(self, **kw):
        self.fake = FakeOllama(tags=(QWEN, GEMMA, "nomic-embed-text:latest"), cloud=(CLOUD,), **kw)
        self.addCleanup(self.fake.close)
        return llmm.LLM(host=self.fake.host, timeout=10, tier="cloud",
                        lock_path="")

    def test_one_failed_show_does_not_lock_the_cloud_out(self):
        llm = self.make(show_fail=1)
        self.assertEqual(llm.job_models[LEAD], QWEN)
        self.assertNotIn(CLOUD, llm.shown)            # a no is not kept
        # before the backoff is up it is not asked again
        shows = self.fake.shows
        llm.next_probe = 0
        llm.ready()
        self.assertEqual(self.fake.shows, shows)
        self.assertEqual(llm.job_models[LEAD], QWEN)
        # once it is up, the cloud comes back without a restart
        llm.show_retry[CLOUD] = (0.0, llm.show_retry[CLOUD][1])
        llm.next_probe = 0
        self.assertTrue(llm.ready())
        self.assertEqual(llm.job_models[LEAD], CLOUD)
        self.assertNotIn(CLOUD, llm.missing)

    def test_the_backoff_doubles_to_a_cap(self):
        llm = self.make(show_fail=99)
        gaps = [llm.show_retry[CLOUD][1]]
        for _ in range(8):
            llm.show_retry[CLOUD] = (0.0, llm.show_retry[CLOUD][1])
            llm.probe()
            gaps.append(llm.show_retry[CLOUD][1])
        self.assertEqual(gaps[:3], [llmm.SHOW_BACKOFF, llmm.SHOW_BACKOFF * 2,
                                    llmm.SHOW_BACKOFF * 4])
        self.assertEqual(gaps[-1], llmm.SHOW_BACKOFF_MAX)


class FailingTest(unittest.TestCase):

    def make(self, **kw):
        self.fake = FakeOllama(tags=(QWEN, GEMMA, "nomic-embed-text:latest"), **kw)
        self.addCleanup(self.fake.close)
        return llmm.LLM(host=self.fake.host, timeout=10, tier="local",
                        lock_path="")

    def ask(self, llm):
        return llm.chat_json("s", "u", {"type": "object"}, job=LEAD,
                             retries=1)

    def test_installed_models_that_fail_are_failing_not_missing(self):
        llm = self.make(chat_500=(QWEN, GEMMA))
        self.assertIsNone(self.ask(llm))       # qwen fails twice, swaps
        self.assertIsNone(self.ask(llm))       # gemma fails twice: off
        self.assertIsNone(llm.job_models[LEAD])
        self.assertEqual(llm.job_state(LEAD), "failing")
        st = llm.model_status()
        self.assertEqual(st["jobs"][LEAD]["state"], "failing")
        self.assertIn("HTTP 500", st["failing"][LEAD])
        self.assertEqual(st["missing"], [])
        line = llmm.status_line(llm)
        self.assertIn("failing", line)
        self.assertNotIn("not installed", line)
        self.assertNotIn("no model installed", llm.reason)
        # until the next probe it does not keep hammering a broken box
        chats = len(self.fake.chats)
        self.assertIsNone(self.ask(llm))
        self.assertEqual(len(self.fake.chats), chats)
        self.assertIn("every model failing", llm.reason)
        # when the box recovers, the next probe puts it back
        self.fake.chat_500.clear()
        llm.next_probe = 0
        self.assertIsNotNone(self.ask(llm))
        self.assertEqual(llm.job_state(LEAD), "ok")
        self.assertEqual(llm.model_status()["failing"], {})

    def test_a_missing_model_is_named_once(self):
        llm = self.make(chat_404=(QWEN,))
        self.assertIsNotNone(self.ask(llm))    # moved on to gemma
        line = llmm.status_line(llm)
        self.assertEqual(line.count(QWEN), 1, line)
        self.assertNotIn("is not installed", line)


if __name__ == "__main__":
    unittest.main()
