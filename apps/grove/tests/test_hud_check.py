"""The HUD's escaping, through `tools/hud_check.js` — and the check
itself: every `esc(` and `Number(` wrapper in `page3d/hud.js` is removed
in turn from a copy, and the check must fail on each, save the few whose
removal changes nothing a reader could see (listed below, with why).

Needs Node; skipped without it."""

import os
import re
import shutil
import subprocess
import tempfile
import unittest

from tests.helpers import ROOT

NODE = shutil.which("node")
PAGE = os.path.join(ROOT, "grove", "page3d")
HUD = os.path.join(PAGE, "hud.js")
CHECK = os.path.join(ROOT, "tools", "hud_check.js")

# Wrappers whose removal is an equivalent mutant: the value is coerced to a
# number by the expression around it anyway, or is a string the HUD made
# itself from numbers. Keyed by the source line, so a line that changes
# drops out of the list and its wrapper is tested again.
EQUIVALENT = {
    # `now - tick` coerces both; `d` is already a number
    "var d = Number(now) - Number(tick);",
    "return d <= 0 ? 'now' : Number(d) + 'wk ago';",
    # ago() only ever returns 'now' or a number and 'wk ago'
    "esc(c.text) + '<span class=\"when\">' + esc(ago(c.tick, st.tick)) +",
    # a comparison coerces; only an 's' or '' is written
    "(Number(last.amendments) > 1 ? 's' : '')",
    # the size is only multiplied and compared, both of which coerce
    "var size = Number(st.size) || 0;",
}


def run(hud):
    return subprocess.run([NODE, CHECK], env=dict(os.environ, GROVE_HUD=hud),
                          capture_output=True, text=True, timeout=60)


def wrappers(src):
    """(offset, name, line) for every call of esc() or Number(), but not
    esc's own definition."""
    out = []
    for m in re.finditer(r"\b(esc|Number)\(", src):
        if src[max(0, m.start() - 4):m.start()] == "var ":
            continue
        start = src.rfind("\n", 0, m.start()) + 1
        end = src.find("\n", m.start())
        out.append((m.start(), m.group(1), src[start:end].strip()))
    return out


@unittest.skipUnless(NODE, "node is not installed")
class HudCheckTest(unittest.TestCase):
    def test_the_hud_passes(self):
        r = run(HUD)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(r.stdout.rstrip().endswith("all ok"), r.stdout)

    def test_every_wrapper_is_needed(self):
        with open(HUD) as f:
            src = f.read()
        sites = wrappers(src)
        self.assertGreater(len(sites), 25)
        survived, used = [], set()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "hud.js")
            for pos, name, line in sites:
                if line in EQUIVALENT:
                    used.add(line)
                    continue
                with open(path, "w") as f:
                    f.write(src[:pos] + src[pos + len(name):])
                if run(path).returncode == 0:
                    survived.append(name + " in: " + line)
        self.assertEqual(survived, [], "the check does not notice these")
        # the list is not a place for lines that are gone
        self.assertEqual(used, EQUIVALENT)

    def test_an_escaper_that_does_nothing_fails(self):
        with open(HUD) as f:
            src = f.read()
        mut = re.sub(r"var esc = function \(s\) \{",
                     "var esc = function (s) { return String(s);", src,
                     count=1)
        self.assertNotEqual(mut, src)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "hud.js")
            with open(path, "w") as f:
                f.write(mut)
            self.assertNotEqual(run(path).returncode, 0)

    def test_an_escaper_that_drops_everything_fails(self):
        with open(HUD) as f:
            src = f.read()
        mut = re.sub(r"var esc = function \(s\) \{",
                     "var esc = function (s) { return '';", src, count=1)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "hud.js")
            with open(path, "w") as f:
                f.write(mut)
            self.assertNotEqual(run(path).returncode, 0)


@unittest.skipUnless(NODE, "node is not installed")
class ScriptsParseTest(unittest.TestCase):
    def test_every_script_parses(self):
        files = [os.path.join(ROOT, "tools", n)
                 for n in os.listdir(os.path.join(ROOT, "tools"))
                 if n.endswith(".js")]
        files += [os.path.join(PAGE, n) for n in os.listdir(PAGE)
                  if n.endswith(".js")]
        shared = os.path.join(ROOT, "..", "shared", "page3d")
        files += [os.path.join(shared, n) for n in os.listdir(shared)
                  if n.endswith(".js")]
        for path in files:
            with self.subTest(path=os.path.relpath(path, ROOT)):
                args = [NODE, "--check", path]
                if path.endswith(("viewer.js", "world.js")):
                    # ES modules
                    args = [NODE, "--input-type=module", "--check"]
                    with open(path) as f:
                        r = subprocess.run(args, stdin=f, capture_output=True,
                                           text=True, timeout=30)
                else:
                    r = subprocess.run(args, capture_output=True, text=True,
                                       timeout=30)
                self.assertEqual(r.returncode, 0, r.stderr)

    def test_no_function_is_defined_twice(self):
        for name in os.listdir(PAGE):
            if not name.endswith(".js"):
                continue
            with open(os.path.join(PAGE, name)) as f:
                src = f.read()
            names = re.findall(r"^\s*(?:async\s+)?function\s+(\w+)\s*\(",
                               src, re.M)
            dup = sorted({n for n in names if names.count(n) > 1})
            with self.subTest(file=name):
                self.assertEqual(dup, [])


if __name__ == "__main__":
    unittest.main()
