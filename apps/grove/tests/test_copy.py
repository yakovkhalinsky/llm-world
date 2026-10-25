"""The chronicle's fallback lines read as English: "a wild owl", not "an
wild owl"; "2 young foxes were born", not "2 fox young entered the
world"; and a count of nothing is not news at all."""

import unittest

from grove import chronicler, events


def lines(kind, sp, n=1, ticks=60, **extra):
    world = {"seed": 7, "names": {}, "size": 12}
    out = set()
    for t in range(ticks):           # walk the variant pool
        e = dict(kind=kind, sp=sp, n=n, tick=t, x=None, y=None, **extra)
        out.add(chronicler._line(world, e))
    return out


class CopyTest(unittest.TestCase):
    def test_no_an_before_wild(self):
        for kind in ("oldage", "starve", "predation"):
            for sp in ("owl", "rabbit", "deer"):
                for s in lines(kind, sp, hunter="fox"):
                    self.assertNotIn("An wild", s)
                    self.assertNotIn("an wild", s)

    def test_births_are_plural_and_were_born(self):
        got = lines("birth", "fox", n=2)
        self.assertTrue(any(s.startswith("2 young foxes were born at ")
                            for s in got), got)
        for s in got:
            self.assertIn("foxes", s)
            self.assertNotIn("fox young", s)
            self.assertNotIn("— 2 appeared", s)
        for s in lines("birth", "deer", n=3):
            self.assertIn("3 young deer", s.replace("newborn", "young"))
        for s in lines("birth", "rabbit", n=1):
            self.assertTrue(s.startswith("A "), s)
            self.assertIn("rabbit", s)
            self.assertNotIn("rabbits", s)
            self.assertNotIn("were", s)
        for s in lines("birth", "rabbit", n=1234):
            self.assertIn("1,234 ", s)

    def test_arrivals_from_beyond_are_plural(self):
        for s in lines("recolonize", "wolf", n=3):
            self.assertIn("3 wolves", s)

    def test_plurals_of_y_words(self):
        from grove.chronicler import _plural
        self.assertEqual(_plural("berry", 2), "berries")
        self.assertEqual(_plural("berry", 1), "berry")
        self.assertEqual(_plural("jay", 2), "jays")
        self.assertEqual(_plural("fox", 3), "foxes")
        for s in lines("oldage", "fox", n=3):
            self.assertNotIn("foxs", s)

    def test_zero_counts_are_not_news(self):
        evs = [{"kind": "birth", "sp": "deer", "n": 0, "tick": 1},
               {"kind": "robins_left", "n": 0, "tick": 1},
               {"kind": "birth", "sp": "fox", "n": 2, "tick": 1}]
        kept = events.notable(evs)
        self.assertEqual([(e["kind"], e["sp"]) for e in kept],
                         [("birth", "fox")])


if __name__ == "__main__":
    unittest.main()
