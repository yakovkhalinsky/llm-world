"""The HUD's Node check, run where Node exists.

`tools/hud_check.js` runs `estate/page3d/hud.js` against a stub DOM with the
server's own ground and state payloads. The panels are pure DOM, so the
things a screenshot cannot pin — one feed row per day, the census and
watcher tabs, a card for each kind of thing clicked, and the escaping of
every string that comes from the world — are checked without a browser.

Node is not assumed, so this skips when it is absent. The payloads are
built through the package's own `web.ground` and `web.snapshot`, with six
days actually ticked so the feed has more than one row and the watcher has
something to say.

Run from `apps/estate`:

    python3 -m unittest discover -s tests
"""

import json
import os
import shutil
import subprocess
import tempfile
import threading
import types
import unittest

from estate import gen, sim, web

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
CHECK = os.path.join(ROOT, "tools", "hud_check.js")


def _state_payload(world, days=7):
    """`/api/state` after a few real ticks, without a server or a thread.
    Seven days ends on a Monday, so the frame's phases hold a school day."""
    events = []
    books = {}
    for _ in range(days):
        events.extend(sim.tick(world))
        book = world.get("daybook") or {}
        books[world["day"]] = dict(book, uses=dict(book.get("uses", {})))
    runner = types.SimpleNamespace(
        prev={}, events=events, daybooks=books, past_lines={},
        past_news={}, paused=False, tick_seconds=60, llm=None,
        chronicle=[{"day": world["day"], "text": "a quiet week."}],
        last_watch={"fate": "a small fate", "region": "the courtyard",
                    "why": "the watcher said so", "day": world["day"]})
    return web.snapshot(types.SimpleNamespace(world=world), runner,
                        threading.Lock())


@unittest.skipUnless(NODE, "node is not installed")
class HudCheckTest(unittest.TestCase):
    def test_the_hud_passes_its_check(self):
        world = gen.generate(42)
        ground = web.ground(types.SimpleNamespace(world=world))
        state = _state_payload(world)
        with tempfile.TemporaryDirectory() as tmp:
            gpath = os.path.join(tmp, "ground.json")
            spath = os.path.join(tmp, "state.json")
            with open(gpath, "w") as f:
                json.dump(ground, f)
            with open(spath, "w") as f:
                json.dump(state, f)
            run = subprocess.run(
                [NODE, CHECK, gpath, spath], cwd=ROOT,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, timeout=180)
        self.assertEqual(run.returncode, 0,
                         "hud_check failed:\n" + run.stdout)
        self.assertIn("all ok", run.stdout)


if __name__ == "__main__":
    unittest.main()
