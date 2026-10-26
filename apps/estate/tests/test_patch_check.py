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
    # Acid Burn D: a selection that collapses lands the held write at once
    ("a collapsed selection waits for the timer",
     "if (waiting.length && !(s && !s.isCollapsed)) flush();",
     "if (waiting.length && !(s && !s.isCollapsed)) later();"),
    ("a collapsed selection lands nothing",
     "if (waiting.length && !(s && !s.isCollapsed)) flush();", ""),
    # Patch.key (Acid Burn F1, grove): the key is the week and the words
    ("a row's key ignores its words",
     "if (text === undefined || text === null) return k;", "return k;"),
    ("a row's key ignores its week",
     "var k = String(Number(when));", "var k = '0';"),
    ("a row's key carries the frame's text as it is",
     "return k + ':' + (h >>> 0).toString(36);", "return k + ':' + s;"),
    # both guards: the first is only the fast path past the hold checks
    ("an unchanged list is written anyway",
     ["if (same && !(opts && opts.reset)) return false;",
      "if (el._html === html) {"],
     ["", "if (false) {"]),
    ("with every row in view gone, the reader is not moved by what grew",
     "top + ((box.scrollHeight || 0) - before)", "top"),
    ("a capped feed corrects by height, not by the row in view",
     "else if (!reanchor(el, box, marks)) {", "else if (true) {"),
    ("the row in view is not put back at its offset",
     "box.scrollTop = (box.scrollTop || 0) + (at - a.at);",
     "box.scrollTop = (box.scrollTop || 0) + at;"),
    ("data-key is ignored",
     "return k !== null && k !== undefined && k !== '' ? 'k:' + k",
     "return false ? 'k:' + k"),
    ("repeated words are anchored before a one-off row",
     "    var order = marks.filter(", "    var order = [].filter("),
    ("a reader at the top is not kept at the top",
     "if (atTop) box.scrollTop = 0;", "if (atTop) box.scrollTop = top + 5;"),
    ("a plain write loses the position",
     "else if (box.scrollTop !== top) box.scrollTop = top;", ""),
    ("a pressed pointer does not hold the write",
     "if (held.indexOf(box) < 0) held.push(box);", ""),
    ("a selection does not hold the write",
     "if (!s || s.isCollapsed) return false;", "return false;"),
    ("a selection anywhere on the page holds every list",
     "if (!((s.anchorNode && inside(box, s.anchorNode)) ||",
     "if (false && ((s.anchorNode && inside(box, s.anchorNode)) ||"),
    ("a selection that ends in the panel does not hold it",
     "(s.focusNode && inside(box, s.focusNode)))) return false;",
     "(false))) return false;"),
    ("a selection left behind holds for ever",
     "return now() - selAt < SELECT_MS;", "return true;"),
    ("a new selection does not start a new hold",
     "selAt = now();\n        var s", "var s"),
    ("a selection hold sets no timer to end it",
     "else if (!isHeld(el)) later(", "else if (false) later("),
    ("pointerleave does not let go",
     "box.addEventListener('pointerleave', up);", ""),
    ("pointercancel does not let go",
     "box.addEventListener('pointercancel', up);", ""),
    ("the timer fires no flush",
     "timer = 0; flush(); }, ms);", "timer = 0; }, ms);"),
    ("every timer is the settle time, whatever was asked",
     "timer = 0; flush(); }, ms);", "timer = 0; flush(); }, SETTLE_MS);"),
    ("a pending write is never cleared",
     "    el._pending = null;\n    var box", "    var box"),
    ("only the first held list is flushed",
     "    list.forEach(function (el) {", "    list.slice(0, 1).forEach(function (el) {"),
    ("a new pick keeps the selection",
     "if (s && !s.isCollapsed && s.removeAllRanges) s.removeAllRanges();", ""),
    ("a new pick keeps the card's held write",
     "      if (!el) return;\n      drop(el);\n", "      if (!el) return;\n"),
    ("a new pick waits out the card's fling",
     "      scroller(el)._scrolledAt = undefined;\n", ""),
    ("a dropped list remembers what it showed",
     "    el._html = undefined;\n", ""),
    ("a dropped list keeps the write it was holding",
     "    el._pending = null;\n    el._opts = undefined;\n"
     "    var i = waiting.indexOf(el);\n    if (i >= 0) waiting.splice(i, 1);",
     "    el._opts = undefined;"),
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
