"""apps/estate/estate/web.py's SimRunner, driven day by day for the
port's view tests (tests/view.test.ts): the same loop body, without the
thread, the wall clock, the database or the model.

The one difference is the watcher's cadence. web.py invites it every
60-120 wall seconds; the port counts the same gap in days, rolled from the
seed (src/sim/watcher.ts gapDays), and so does this harness.

    python3 web_harness.py SEED DAYS   (run from apps/estate)

prints one JSON object: the runner's state, every event said aloud, each
kept day's line, and the no-WebGL text frame.
"""
import hashlib
import json
import sys

sys.path.insert(0, ".")
from estate import gen, render, rules, sim, watcher, web  # noqa: E402
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
        self.said = []

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


def main():
    seed, days = int(sys.argv[1]), int(sys.argv[2])
    r = Runner(seed)
    for _ in range(days):
        r.step()
    w = r.world
    people = max(1, len(w["residents"]))
    print(json.dumps({
        "world": world_hash(w), "events": h16(r.events), "daybooks": h16({str(d): b for d, b in r.daybooks.items()}),
        "prev": r.prev,
        "last_watch": r.last_watch, "next_watch": r.next_watch, "said": r.said,
        "lines": {d: render.day_line(b, people) for d, b in r.daybooks.items()},
        "plain": render.full(web._frame(w, r)),
    }, sort_keys=True))


if __name__ == "__main__":
    main()
