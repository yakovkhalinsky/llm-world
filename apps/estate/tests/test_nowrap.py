"""No label wraps: the one-line rules in the 3D page's stylesheet.

The wrap itself is measured in a real browser at 1280 and 390 wide (the
UI screenshot run counts every label that takes two line boxes); this
pins the rules that make it so, so a later edit that drops one is caught
without a browser. Each rule is then removed in turn and the check must
see it go.
"""

import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSS = os.path.join(ROOT, "estate", "page3d", "style.css")

# every label that must stay on one line, by its rule's selector
ONE_LINE = [".idbox > div", ".chron li .d", ".speedrow .hint", "button", ".cardhead h3", ".timeline li.need > span:last-child", ".hint.foot"]


def rules(css):
    """(selectors, body) for every rule, @media ones included."""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    out = []
    for sel, body in re.findall(r"([^{}]+)\{([^{}]*)\}", css):
        sels = [" ".join(s.split()) for s in sel.split(",")]
        out.append((sels, body))
    return out


def missing(css):
    have = rules(css)
    return [s for s in ONE_LINE
            if not any(s in sels and re.search(r"white-space:\s*nowrap", b)
                       for sels, b in have)]


class NoWrapTest(unittest.TestCase):
    def setUp(self):
        with open(CSS) as f:
            self.css = re.sub(r"/\*.*?\*/", "", f.read(), flags=re.S)

    def test_every_label_is_one_line(self):
        self.assertEqual(missing(self.css), [])

    def test_dropping_any_one_line_rule_is_caught(self):
        have = rules(self.css)
        for s in ONE_LINE:
            with self.subTest(s):
                bodies = [b for sels, b in have if s in sels
                          and re.search(r"white-space:\s*nowrap", b)]
                mutant = self.css
                for b in bodies:
                    mutant = mutant.replace(
                        b, re.sub(r"white-space:\s*nowrap;?", "", b))
                self.assertIn(s, missing(mutant))


if __name__ == "__main__":
    unittest.main()
