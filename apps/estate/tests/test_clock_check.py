"""The day clock's Node check, run where Node exists.

`tools/clock_check.js` tests `shared/page3d/clock.js` — the pure clock and
light table `world.js` uses. The property is the one a browser screenshot
cannot pin: the light never jumps at the day's turn or when a poll
re-anchors, at all three paces, and `light(0) == light(1)`.

Node is not assumed, so this skips when it is absent.

Run from `apps/estate`:

    python3 -m unittest discover -s tests
"""

import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
CHECK = os.path.join(ROOT, "tools", "clock_check.js")


@unittest.skipUnless(NODE, "node is not installed")
class ClockCheckTest(unittest.TestCase):
    def test_the_day_clock_passes_its_check(self):
        run = subprocess.run(
            [NODE, CHECK], cwd=ROOT, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, timeout=180)
        self.assertEqual(run.returncode, 0,
                         "clock_check failed:\n" + run.stdout)
        self.assertIn("all ok", run.stdout)


if __name__ == "__main__":
    unittest.main()
