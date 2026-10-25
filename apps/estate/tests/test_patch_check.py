"""The shared panel patch (`shared/page3d/patch.js`) under its Node check,
and the check itself under mutation: each habit the panels rely on is
broken in turn, and the check must notice every one.

Node is not assumed, so this skips when it is absent.
"""

import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
CHECK = os.path.join(ROOT, "tools", "patch_check.js")
PATCH = os.path.join(ROOT, "..", "shared", "page3d", "patch.js")

# (what is broken, text in patch.js, what it becomes)
MUTANTS = [
    # both guards: the first is only the fast path past the hold checks
    ("an unchanged list is written anyway",
     ["if (same && !(opts && opts.reset)) return false;",
      "if (el._html === html) {"],
     ["", "if (false) {"]),
    ("a newest-first feed does not move the reader by what grew above",
     "top + ((box.scrollHeight || 0) - before)", "top"),
    ("a reader at the top is not kept at the top",
     "box.scrollTop = atTop ? 0 :", "box.scrollTop = atTop ? top + 5 :"),
    ("a plain write loses the position",
     "else if (box.scrollTop !== top) box.scrollTop = top;", ""),
    ("a pressed pointer does not hold the write",
     "if (held.indexOf(box) < 0) held.push(box);", ""),
    ("a selection does not hold the write",
     "return !!(s && !s.isCollapsed", "return false && !!(s && !s.isCollapsed"),
    ("a list still scrolling is written under the reader",
     "now() - box._scrolledAt < SETTLE_MS", "false"),
    ("a reset does not go to the top",
     "if (opts && opts.reset) box.scrollTop = 0;\n    else", "if (false) {}\n    else"),
    ("a reset to the same list does not go to the top",
     "if (opts && opts.reset) box.scrollTop = 0;\n      return false;",
     "return false;"),
    ("a reset that waited is lost",
     "el._opts = reset ? Object.assign({}, opts, { reset: true }) : opts;",
     "el._opts = opts;"),
    ("counts are not en-AU",
     "new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 })",
     "new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 })"),
    ("counts keep their decimals",
     "v = Math.round(v) || 0;", "v = v || 0;"),
    ("a non-number is written as a number",
     "!isFinite(v)) {", "false) {"),
]


def run(src):
    return subprocess.run([NODE, CHECK, src], capture_output=True, text=True,
                          timeout=60)


@unittest.skipUnless(NODE, "node is not installed")
class PatchCheckTest(unittest.TestCase):
    def test_the_patch_passes(self):
        r = run(PATCH)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("all ok", r.stdout)

    def test_every_mutant_is_caught(self):
        with open(PATCH) as f:
            src = f.read()
        with tempfile.TemporaryDirectory() as tmp:
            for what, old, new in MUTANTS:
                with self.subTest(what):
                    olds = old if isinstance(old, list) else [old]
                    news = new if isinstance(new, list) else [new]
                    mutant = src
                    for o, n in zip(olds, news):
                        self.assertEqual(src.count(o), 1, o)
                        mutant = mutant.replace(o, n)
                    p = os.path.join(tmp, "patch.js")
                    with open(p, "w") as f:
                        f.write(mutant)
                    r = run(p)
                    self.assertNotEqual(r.returncode, 0,
                                        f"survived: {what}\n{r.stdout}")


if __name__ == "__main__":
    unittest.main()
