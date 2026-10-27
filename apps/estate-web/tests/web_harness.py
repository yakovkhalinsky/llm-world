"""apps/estate/estate/web.py's own SimRunner, driven a day at a time for
the port's view tests (tests/view.test.ts): its `step()` (the loop body:
tick, keep, save) and its `_maybe_watch()`, with no thread, no database
and no model.

What differs is only *when* the watcher is invited. web.py invites it
every 60-120 wall seconds, rolled from the unseeded `random.random()` —
and with no model at all (`llm=None`) it never invites it. The port
counts the gap in days rolled from the seed (src/sim/watcher.ts gapDays),
which is new behaviour; it matches web.py's `--decide rules` mode, where
the choice is code. So here the runner gets a stand-in model that says
`decide == "rules"` and is never ready (no why is written), and its
wall-clock gate is opened on the seeded day and shut otherwise.

    python3 web_harness.py SEED DAYS [PAD]   (run from apps/estate)
        one JSON object: the runner's state, every event said aloud, each
        kept day's line, the no-WebGL text frame, web.py's /api/ground and
        /api/state, and what web._control makes of each request in
        CONTROLS. PAD placeholder
        events are put in the log first ({"kind": "pad", "day": 0, "n": i}), so a
        short run reaches the 400-event cap and is pruned.
    python3 web_harness.py lines       (books as JSON on stdin)
        render.day_line for each book.
"""
import hashlib
import json
import math
import sys
import threading
from types import SimpleNamespace

sys.path.insert(0, ".")
from estate import gen, render, rules, web, webguard  # noqa: E402
from estate import world as W  # noqa: E402
from tools.parity import canon, world_hash  # noqa: E402


def gap_days(seed, day):
    pace = rules.R["pacing"]["day_seconds"][1]
    lo, hi = rules.R["pacing"]["watcher_gap"]
    a = max(1, round(lo / pace))
    b = max(a, round(hi / pace))
    return W.rng_for(seed, day, "watch:gap").randint(a, b)


class Est:
    """web.Estate without the database: the world, and saves that go nowhere."""

    def __init__(self, seed):
        self.world = gen.generate(seed)

    def save(self, evs=()):
        pass


class RulesOnly:
    """The `--decide rules` model, never ready: choices in code, no words."""
    decide = "rules"

    def ready(self):
        return False

    def watch_gap(self):
        return tuple(rules.R["pacing"]["watcher_gap"])


def run(seed, days, pad=0):
    runner = web.SimRunner(Est(seed), threading.Lock(),
                           rules.R["pacing"]["day_seconds"][1], llm=RulesOnly())
    runner.events = [{"kind": "pad", "day": 0, "n": i} for i in range(pad)]
    due, said = 0, []
    for _ in range(days):
        evs = runner.step()
        said.extend(render.say(e) for e in evs)
        day = runner.est.world["day"]
        if day >= due:
            due = day + gap_days(seed, day)
            runner.next_watch = 0.0          # due: open the wall-clock gate
            runner._maybe_watch()
        runner.next_watch = math.inf         # and shut it until the next
    return runner, due, said


def h16(x):
    return hashlib.sha256(canon(x).encode()).hexdigest()[:16]


# control requests, each applied to the runner as it was left by the last
CONTROLS = [
    {}, {"paused": True}, {"paused": 1}, {"paused": None}, {"step": 3}, {"step": 0},
    {"step": 101}, {"step": True}, {"step": 2.5}, {"step": "2"}, {"tick_seconds": 5},
    {"tick_seconds": 0.01}, {"tick_seconds": 1e9}, {"tick_seconds": "5"},
    {"tick_seconds": False}, {"paused": False, "step": 1}, {"speed": 1},
    {"paused": True, "nope": 1}, {"tick_seconds": 7.5, "paused": "no"},
]
# bodies as the page could write them, which json.dumps would not: whole
# numbers written as floats, and an int too big for a float
RAW = ['{"step": 5.0}', '{"step": 1e2}', '{"step": 1.0000000000000001}', '{"step": 5E0}',
       '{"step": -0.0}', '{"step": 7}', '{"tick_seconds": 3e1}', '{"paused": 1.0}',
       '{"tick_seconds": 1' + '0' * 400 + '}', '{"tick_seconds": -1' + '0' * 400 + '}']


def control(r, req):
    try:
        code, out = web._control(r, req)
    except webguard.Refused as e:
        code, out = e.code, {"error": e.why}
    return {"code": code, "out": out, "paused": r.paused, "step": r.step_once,
            "tick_seconds": r.tick_seconds}


def main():
    if sys.argv[1] == "lines":
        print(json.dumps([render.day_line(b, 1) for b in json.load(sys.stdin)]))
        return
    seed, days = int(sys.argv[1]), int(sys.argv[2])
    r, due, said = run(seed, days, int(sys.argv[3]) if len(sys.argv) > 3 else 0)
    w = r.est.world
    r.llm = None                             # the page's view: no model
    est = SimpleNamespace(world=w)
    bodies = [json.dumps(q) for q in CONTROLS] + RAW
    people = max(1, len(w["residents"]))
    print(json.dumps({
        "world": world_hash(w), "events": h16(r.events), "n_events": len(r.events),
        "daybooks": h16({str(d): b for d, b in r.daybooks.items()}),
        "prev": r.prev,
        "last_watch": r.last_watch, "next_watch": due, "said": said,
        "lines": {d: render.day_line(b, people) for d, b in r.daybooks.items()},
        "plain": render.full(web._frame(w, r)),
        "ground": web.ground(est),
        "state": web.snapshot(est, r, threading.Lock()),
        "controls": bodies,
        "control": [control(r, json.loads(b)) for b in bodies],
    }, sort_keys=True))


if __name__ == "__main__":
    main()
