"""apps/estate/estate/web.py's SimRunner, driven day by day for the
port's view tests (tests/view.test.ts): the same loop body, without the
thread, the wall clock, the database or the model.

The one difference is the watcher's cadence. web.py invites it every
60-120 wall seconds; the port counts the same gap in days, rolled from the
seed (src/sim/watcher.ts gapDays), and so does this harness.

    python3 web_harness.py SEED DAYS   (run from apps/estate)

prints one JSON object: the runner's state, every event said aloud, each
kept day's line, the no-WebGL text frame, web.py's /api/ground and
/api/state, and what web._control makes of each request in CONTROLS.
"""
import hashlib
import json
import sys
import threading
from types import SimpleNamespace

sys.path.insert(0, ".")
from estate import gen, render, rules, sim, watcher, web, webguard  # noqa: E402
from estate import world as W  # noqa: E402
from tools.parity import canon, world_hash  # noqa: E402


def gap_days(seed, day):
    pace = rules.R["pacing"]["day_seconds"][1]
    lo, hi = rules.R["pacing"]["watcher_gap"]
    a = max(1, round(lo / pace))
    b = max(a, round(hi / pace))
    return W.rng_for(seed, day, "watch:gap").randint(a, b)


class Runner:
    def __init__(self, seed):
        self.world = gen.generate(seed)
        self.prev, self.events, self.daybooks = {}, [], {}
        self.last_watch = {"fate": None, "region": None, "why": None, "day": None}
        self.next_watch = 0
        self.paused = False
        self.tick_seconds = rules.R["pacing"]["day_seconds"][1]
        self.step_once = 0
        self.said = []
        # what snapshot reads that this harness has no use for
        self.past_lines, self.past_news, self.chronicle, self.llm = {}, {}, [], None

    def step(self):
        w = self.world
        self.prev = {rid: (r["where"]["x"], r["where"]["y"], r["where"]["mode"],
                           r["where"].get("unit"))
                     for rid, r in w["residents"].items()}
        evs = sim.tick(w)
        self.events.extend(evs)
        self.said.extend(render.say(e) for e in evs)
        day = w["day"]
        book = w.get("daybook") or {}
        self.daybooks[day] = dict(book, uses=dict(book.get("uses", {})))
        for old_day in [d for d in self.daybooks if d < day - 64]:
            del self.daybooks[old_day]
        del self.events[:-400]
        if day >= self.next_watch:
            self.next_watch = day + gap_days(w["seed"], day)
            intent = watcher.choose(w)
            watcher.queue(w, intent)
            intent["day"] = day
            self.last_watch = intent


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


def control(r, req):
    try:
        code, out = web._control(r, req)
    except webguard.Refused as e:
        code, out = e.code, {"error": e.why}
    return {"code": code, "out": out, "paused": r.paused, "step": r.step_once,
            "tick_seconds": r.tick_seconds}


def main():
    seed, days = int(sys.argv[1]), int(sys.argv[2])
    r = Runner(seed)
    for _ in range(days):
        r.step()
    w = r.world
    est = SimpleNamespace(world=w)
    people = max(1, len(w["residents"]))
    print(json.dumps({
        "world": world_hash(w), "events": h16(r.events), "daybooks": h16({str(d): b for d, b in r.daybooks.items()}),
        "prev": r.prev,
        "last_watch": r.last_watch, "next_watch": r.next_watch, "said": r.said,
        "lines": {d: render.day_line(b, people) for d, b in r.daybooks.items()},
        "plain": render.full(web._frame(w, r)),
        "ground": web.ground(est),
        "state": web.snapshot(est, r, threading.Lock()),
        "controls": [json.dumps(q) for q in CONTROLS],
        "control": [control(r, q) for q in CONTROLS],
    }, sort_keys=True))


if __name__ == "__main__":
    main()
