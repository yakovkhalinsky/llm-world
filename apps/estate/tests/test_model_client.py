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


if __name__ == "__main__":
    unittest.main()
