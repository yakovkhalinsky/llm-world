"""The estate's sentences: enums said as words, the right article, the
past tense for news, and commas in big numbers."""

import unittest

from estate import render


class SayTest(unittest.TestCase):
    def test_enums_are_words_with_the_right_article(self):
        self.assertEqual(render.say({"kind": "moved_in",
                                     "where": "flat_share"}),
                         "a flat share moved in")
        self.assertEqual(render.say({"kind": "moved_in", "where": "elder"}),
                         "an elder and family moved in")
        self.assertEqual(render.say({"kind": "moved_in", "where": "single"}),
                         "someone on their own moved in")
        self.assertEqual(render.say({"kind": "moved_in", "where": "houseboat"}),
                         "a houseboat moved in")
        self.assertEqual(render.say({"kind": "broke", "what": "lamp"}),
                         "a lamp broke")
        self.assertEqual(render.say({"kind": "broke", "what": "awning"}),
                         "an awning broke")

    def test_news_is_past_tense(self):
        self.assertEqual(render.say({"kind": "born", "who": "Ada"}),
                         "Ada was born on the estate")
        self.assertEqual(render.say({"kind": "died", "who": "Bo"}), "Bo died")
        self.assertEqual(render.say({"kind": "left"}),
                         "a household left the estate")
        for ev in ({"kind": "moved_in", "where": "flat_share"},
                   {"kind": "left", "who": "Cy"}):
            self.assertNotIn("_", render.say(ev))

    def test_big_counts_have_commas(self):
        line = render.day_line({"uses": {"shop": 1200, "bench": 34}}, {})
        self.assertIn("1,234 errands", line)


if __name__ == "__main__":
    unittest.main()
