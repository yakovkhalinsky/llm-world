"""The Python side of apps/estate-web's parity test.

The browser port must plant and run the same estate as this engine from
the same seed — not a similar one. This prints what the port is held to:

  python3 tools/parity.py worlds --seeds 1-8,42,3771 [--days N] [--every K] [--dump DIR]
      one JSON line per (seed, day): the world's canonical hash. Day 0 is
      the planted estate (gen.generate; its `day` field already reads 1),
      and with --days the engine is ticked N days, no watcher, exactly as
      the gate runs it. With --watch K the watcher also chooses (in code,
      `watcher.choose`, as the web runner's default `--decide rules` does)
      and queues a fate after every K-th day, so fates land and last. Each
      line also carries `events`: the hash of the events since the last
      line.
  python3 tools/parity.py vectors
      the reference values for the port's Python shims: random.Random
      draws, round(), //, %, sum() and repr(float).

**The canonical form.** JSON can't tell 1.0 from 1, and JavaScript has
only the one number, so the hash is over a form both languages can write
the same way: sorted keys, no spaces, tuples as lists, and every number
that is integral (and under 1e16) written as an integer. Any other float
is written as Python's repr. The int/float distinction is the one thing
the hash cannot see; nothing in the engine reads it, since every
arithmetic result agrees in value. Where it does show — json.dumps in the
gate's fingerprint — the port says which numbers are floats.

Read-only: it plants worlds in memory and touches no data directory.
"""

import argparse
import hashlib
import json
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from estate import gen, sim, watcher                     # noqa: E402


def canon_value(v):
    if isinstance(v, bool) or v is None or isinstance(v, str):
        return v
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        if v.is_integer() and abs(v) < 1e16:
            return int(v)
        return v
    if isinstance(v, dict):
        return {str(k): canon_value(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [canon_value(x) for x in v]
    raise TypeError(f"no canonical form for {type(v).__name__}: {v!r}")


def canon(world) -> str:
    return json.dumps(canon_value(world), sort_keys=True,
                      separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False)


def world_hash(world) -> str:
    return hashlib.sha256(canon(world).encode("utf-8")).hexdigest()[:16]


def parse_seeds(s):
    out = []
    for part in s.split(","):
        if "-" in part:
            a, b = part.split("-")
            out += list(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return out


def cmd_worlds(args):
    for seed in parse_seeds(args.seeds):
        w = gen.generate(seed)
        marks = {0}
        if args.days:
            every = args.every or args.days
            marks |= set(range(every, args.days + 1, every)) | {args.days}

        evs = []

        def emit(n):
            print(json.dumps({"seed": seed, "days": n, "day": w["day"],
                              "hash": world_hash(w),
                              "events": hashlib.sha256(
                                  canon(evs).encode()).hexdigest()[:16]}),
                  flush=True)
            evs.clear()
            if args.dump:
                os.makedirs(args.dump, exist_ok=True)
                with open(os.path.join(args.dump, f"{seed}-{n}.json"), "w") as f:
                    f.write(canon(w))

        emit(0)
        for n in range(1, (args.days or 0) + 1):
            evs.extend(sim.tick(w))
            if args.watch and n % args.watch == 0:
                watcher.queue(w, watcher.choose(w))
            if n in marks:
                emit(n)


def cmd_vectors(_args):
    out = {"rng": [], "round": [], "round_n": [], "divmod": [],
           "sum": [], "repr": []}
    for s in ["0:0:gen", "1:0:gen", "3771:2871:whim:17:2", "42:1:weather",
              "", "é:ü:🙂", "8:999:letting"]:
        r = random.Random(s)
        draws = {
            "seed": s,
            "random": [r.random() for _ in range(5)],
            "bits": [r.getrandbits(k) for k in range(0, 33)],
            "below": [r.randrange(n) for n in (1, 2, 3, 5, 7, 40, 30, 47,
                                               1000, 2 ** 31 + 1)],
            "randint": [r.randint(a, b) for a, b in ((2, 16), (19, 78),
                                                     (7, 9), (0, 0))],
            "choice": [r.choice([2, 2, 3, 4]) for _ in range(6)],
        }
        xs = list(range(25))
        r.shuffle(xs)
        draws["shuffle"] = xs
        draws["after"] = r.random()
        out["rng"].append(draws)

    g = random.Random("vectors")
    edges = [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 0.125, 0.375, 2.675, 1.005,
             0.0, -0.0, 1e-7, 123456.5, 0.4999999999999999]
    floats = edges + [g.uniform(-1000, 1000) for _ in range(300)] + \
        [g.random() for _ in range(300)]
    for x in floats:
        out["round"].append([x, round(x)])
        for n in (0, 1, 2, 3):
            out["round_n"].append([x, n, round(x, n)])
    pairs = [(7, 2), (-7, 2), (7, -2), (-7, -2), (0, 3), (5.5, 2),
             (-5.5, 2), (1e-9, 7), (-1e-9, 7), (364, 91), (-1, 7)]
    pairs += [(g.uniform(-100, 100), g.choice([1, 2, 3, 0.7, -2.5]))
              for _ in range(200)]
    for a, b in pairs:
        q, m = divmod(a, b)
        out["divmod"].append([a, b, q, m])
    for n in (2, 3, 10, 100, 1000):
        for _ in range(20):
            xs = [g.uniform(-1, 1) * 10 ** g.randint(-8, 8) for _ in range(n)]
            out["sum"].append([xs, sum(xs)])
    out["sum"].append([[0.1] * 10, sum([0.1] * 10)])
    out["sum"].append([[1e16, 1.0, -1e16], sum([1e16, 1.0, -1e16])])
    reprs = [1.0, 0.1, 1e-5, 1e-4, 0.0001234, 1e16, 1e15, 123456789012345678.0,
             1.5e-10, -2.5, 0.3, 2 / 3, 1e22, 5e-324, 1.7976931348623157e308,
             12345.678, 100.0, 1e21, 1e-7]
    reprs += [g.uniform(-1, 1) * 10 ** g.randint(-30, 30) for _ in range(300)]
    for x in reprs:
        out["repr"].append([x, repr(x)])
    json.dump(out, sys.stdout)
    sys.stdout.write("\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    pw = sub.add_parser("worlds")
    pw.add_argument("--seeds", default="1-8")
    pw.add_argument("--days", type=int, default=0)
    pw.add_argument("--every", type=int, default=0)
    pw.add_argument("--dump", default=None)
    pw.add_argument("--watch", type=int, default=0)
    sub.add_parser("vectors")
    args = ap.parse_args()
    {"worlds": cmd_worlds, "vectors": cmd_vectors}[args.cmd](args)


if __name__ == "__main__":
    main()
