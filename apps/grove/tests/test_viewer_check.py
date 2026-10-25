"""The card's ask on the page's side, through `tools/viewer_check.js` — and
the check itself: each piece of the viewer's fix is undone in turn in a
copy of `page3d/viewer.js`, and the check must fail on each, in the scene
that guards it.

Needs Node; skipped without it."""

import os
import shutil
import subprocess
import tempfile
import unittest

from tests.helpers import ROOT

NODE = shutil.which("node")
VIEWER = os.path.join(ROOT, "grove", "page3d", "viewer.js")
CHECK = os.path.join(ROOT, "tools", "viewer_check.js")

# (what is undone, the text in viewer.js, what it becomes, the FAIL line
# the check must print)
MUTANTS = [
    ("the poll clears the kept answer before redrawing",
     "    if (S.selected) {\n      drawCard();",
     "    if (S.selected) {\n      S.ledger = null;\n      drawCard();",
     "FAIL kept:"),
    ("a late answer is not checked against the open card",
     "    .then(b => {\n      if (!mine()) return;\n",
     "    .then(b => {\n",
     "FAIL race:"),
    ("the fetch is not given the abort signal",
     "{ cache: 'no-store', signal: ctl ? ctl.signal : undefined }",
     "{ cache: 'no-store' }",
     "FAIL timeout:"),
    ("the poll re-asks every poll, not every week",
     "if (S.ledger && !bioWaiting && st.tick !== S.ledgerTick) {",
     "if (S.ledger && !bioWaiting) {",
     "FAIL weekly:"),
    ("the poll re-asks over an ask that is still waiting",
     "if (S.ledger && !bioWaiting && st.tick !== S.ledgerTick) {",
     "if (S.ledger && st.tick !== S.ledgerTick) {",
     "FAIL short:"),
    ("a superseded ask is left running",
     "  if (bioCtl) bioCtl.abort();\n",
     "",
     "FAIL race:"),
    ("the timeout no longer fails the card",
     "    if (ctl) ctl.abort();\n    fail();\n",
     "",
     "FAIL timeout:"),
    ("a pick leaves the old card's selection and held writes",
     "    window.Patch.fresh([$('cardState'), $('cardRows')]);\n",
     "",
     "FAIL pick:"),
    ("a pick starts the card afresh only after drawing it",
     "  if (window.Patch && window.Patch.fresh) {\n"
     "    window.Patch.fresh([$('cardState'), $('cardRows')]);\n  }\n"
     "  if (!sel || sel.kind !== 'animal') S.follow = false;\n"
     "  if (drawCard()) askBio(sel);\n",
     "  if (!sel || sel.kind !== 'animal') S.follow = false;\n"
     "  if (drawCard()) askBio(sel);\n"
     "  window.Patch.fresh([$('cardState'), $('cardRows')]);\n",
     "FAIL pick:"),
    ("the follow button is offered on every card",
     "$('followBtn').hidden = !(S.selected && S.selected.kind === 'animal');",
     "$('followBtn').hidden = !S.selected;",
     "FAIL follow:"),
    ("the follow button does not say it is following",
     "const word = S.follow ? '◉ following' : '◎ follow';",
     "const word = '◎ follow';",
     "FAIL follow:"),
    ("an open card leaves the phone's sheet under it",
     "document.body.classList.toggle('carded', !!open);",
     "document.body.classList.toggle('carded', false);",
     "FAIL follow:"),
]


def run(viewer):
    return subprocess.run([NODE, CHECK],
                          env=dict(os.environ, GROVE_VIEWER=viewer),
                          capture_output=True, text=True, timeout=60)


@unittest.skipUnless(NODE, "node is not installed")
class ViewerCheckTest(unittest.TestCase):
    def test_the_viewer_passes(self):
        r = run(VIEWER)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(r.stdout.rstrip().endswith("all ok"), r.stdout)

    def test_every_piece_of_the_fix_is_needed(self):
        with open(VIEWER) as f:
            src = f.read()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "viewer.js")
            for name, old, new, line in MUTANTS:
                with self.subTest(name):
                    # a mutant whose text is gone tests nothing: fail loudly
                    self.assertEqual(src.count(old), 1, old)
                    with open(path, "w") as f:
                        f.write(src.replace(old, new))
                    r = run(path)
                    self.assertNotEqual(r.returncode, 0, r.stdout)
                    self.assertIn(line, r.stdout)


if __name__ == "__main__":
    unittest.main()
