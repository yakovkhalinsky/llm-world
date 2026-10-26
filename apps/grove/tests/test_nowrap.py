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
CSS = os.path.join(ROOT, "grove", "page3d", "style.css")

# every label that must stay on one line, by its rule's selector
ONE_LINE = ["button", ".cardhead h3", ".timeline li.need > span:last-child", ".hint.foot", ".llmstat", ".poplines .popline", ".chron li .when", ".sparkline", ".timeline .wk", ".idrow > span", "#tip"]


# (selector, what its rule must say, what a mutant strips)
GUARDS = [
    (".sparkline", r"grid-template-columns:[^;]*minmax\(0", r"minmax\(0,\s*1fr\)"),
    (".sparkline .spark", r"min-width:\s*0", r"min-width:\s*0;?"),
    (".sparkline .spark", r"overflow:\s*hidden", r"overflow:\s*hidden;?"),
    (".idbox > .idrow", r"flex-wrap:\s*wrap", r"flex-wrap:\s*wrap;?"),
]

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


def has(css, sel, prop):
    """Does some rule for `sel` say `prop` (a regex over its body)?"""
    return any(sel in sels and re.search(prop, b) for sels, b in rules(css))


class NothingCutTest(unittest.TestCase):
    """Nothing is cut short: no ellipsis on a line that holds counts, and
    nothing a reader needs sits off the side of a row that scrolls."""

    def setUp(self):
        with open(CSS) as f:
            self.css = re.sub(r"/\*.*?\*/", "", f.read(), flags=re.S)

    def test_nothing_scrolls_sideways(self):
        # the no-WebGL glyph map is a <pre> and may scroll; nothing else
        rows = [sels for sels, b in rules(self.css)
                if re.search(r"overflow-x:\s*(auto|scroll)", b)
                and not all("#plain" in x or "pre" in x.split() for x in sels)]
        self.assertEqual(rows, [])

    def test_the_census_counts_stay_in_their_column(self):
        for sel, prop, _ in GUARDS:
            with self.subTest(sel):
                self.assertTrue(has(self.css, sel, prop))


    def test_the_checks_see_a_rule_go(self):
        for sel, prop, rx in GUARDS:
            with self.subTest(sel):
                bodies = [b for sels, b in rules(self.css)
                          if sel in sels and re.search(prop, b)]
                mutant = self.css
                for b in bodies:
                    mutant = mutant.replace(b, re.sub(rx, "", b))
                self.assertFalse(has(mutant, sel, prop))


if __name__ == "__main__":
    unittest.main()
