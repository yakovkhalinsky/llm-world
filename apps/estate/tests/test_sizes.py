"""Every plan size either plants a whole estate or says why it cannot.

#14 review: `estate new --size 44x32` (and 48x36, 60x40) crashed — the
courtyard sat on the plan's middle, so a taller plan pushed the shop and
the playground past `families.older_range` of the doors — and 34x26 died
with a traceback for want of room for the school. The courtyard now sits
under the doors and the extra ground goes south; a plan too small for the
recipe is refused by name, before any old estate is archived.

Run from `apps/estate`:

    python3 -m unittest tests.test_sizes
"""
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from estate import gen, sim                              # noqa: E402
from estate.engine import families                      # noqa: E402


def _try(w, h):
    try:
        return gen.generate(42, w, h), None
    except ValueError as e:
        return None, str(e)


class SizeSweepTest(unittest.TestCase):
    def test_every_plan_from_40x28_up_plants(self):
        for w in range(40, 66, 4):
            for h in range(28, 46, 2):
                world, err = _try(w, h)
                self.assertIsNone(err, f"{w}x{h}: {err}")
                kinds = {f["kind"] for f in world["fixtures"].values()}
                for k in ("shop", "playground", "school", "bus_stop"):
                    self.assertIn(k, kinds, f"{w}x{h}")

    def test_a_smaller_plan_is_refused_by_name(self):
        for w in range(30, 66, 4):
            for h in range(22, 30, 2):
                world, err = _try(w, h)
                if err is not None:
                    self.assertRegex(err, r"widen the plan", f"{w}x{h}")

    def test_the_default_plan_is_the_one_it_was(self):
        # the courtyard moves only on plans taller than the default
        a, b = gen.generate(42), gen.generate(42, 40, 30)
        self.assertEqual(a["fixtures"], b["fixtures"])
        shop = next(x for x in a["buildings"].values()
                    if x["kind"] == "shop")
        doors = {x["door"][1] for x in a["buildings"].values()
                 if x["kind"] == "block"}
        self.assertEqual(doors, {12})
        self.assertEqual(shop["y"], a["height"] // 2 - 2)   # as before
        self.assertEqual(shop["y"], 13)                     # under the doors

    def test_a_big_plan_runs(self):
        w = gen.generate(42, 64, 44)
        for _ in range(7):                 # a week
            sim.tick(w)
        self.assertEqual(families.unattended(w), [])


class NewCommandTest(unittest.TestCase):
    def _new(self, data, *extra):
        return subprocess.run(
            [sys.executable, "-m", "estate", "--data", data, "new",
             "--seed", "42", *extra],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, timeout=120)

    def test_sizes_plant_or_refuse_without_a_traceback(self):
        with tempfile.TemporaryDirectory() as d:
            ok = self._new(d, "--size", "44x32")
            self.assertEqual(ok.returncode, 0, ok.stdout)
            self.assertIn("new estate", ok.stdout)
            before = sorted(os.listdir(d))
            bad = self._new(d, "--size", "34x26", "--force")
            self.assertNotEqual(bad.returncode, 0)
            self.assertNotIn("Traceback", bad.stdout)
            self.assertIn("cannot plant a 34×26 estate", bad.stdout)
            # the estate already there was not archived for nothing
            self.assertEqual(sorted(os.listdir(d)), before)
            junk = self._new(d, "--size", "big", "--force")
            self.assertNotIn("Traceback", junk.stdout)
            self.assertIn("expected WxH", junk.stdout)


if __name__ == "__main__":
    unittest.main()
