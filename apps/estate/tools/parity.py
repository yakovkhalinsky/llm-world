"""The Python side of highfield's parity test (github.com/yakovkhalinsky/highfield).

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
  python3 tools/parity.py shapes --seeds 1-3 [--days N] [--watch K]
      the JSON paths (ids and indices as *) holding a Python float, and
      those holding an int, over every day of the runs: the port declares
      which fields are floats (src/sim/shape.ts) and is held to this.
  python3 tools/parity.py vectors
      the reference values for the port's Python shims: random.Random
      draws, round(), //, %, sum() and repr(float). Non-finite floats are
      sent as the strings "inf", "-inf", "nan" (JSON has none).
  python3 tools/parity.py yearturn '[[seed, year], ...]'
      each estate moved to the eve of a year's turn with its adults at the
      edge of the old-age rule, ticked once: the world's and the events'
      hashes (tests/yearturn.test.ts).

**The canonical form.** JSON can't tell 1.0 from 1, and JavaScript has
only the one number, so the hash is over a form both languages can write
the same way: sorted keys, no spaces, tuples as lists, and every number
that is integral written as an integer. Any other float
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

if sys.version_info < (3, 12):
    sys.exit("tools/parity.py needs Python 3.12+: sum() of floats is "
             "Neumaier-compensated from 3.12, and the engine's numbers "
             f"depend on it (this is {sys.version.split()[0]})")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# the canonical domain: integral values JS holds exactly, on both sides
SAFE = 2 ** 53 - 1

from estate import gen, rules, sim, watcher              # noqa: E402


def canon_value(v):
    if isinstance(v, bool) or v is None or isinstance(v, str):
        return v
    if isinstance(v, int):
        if abs(v) > SAFE:
            raise ValueError(f"no canonical form for {v}: beyond 2**53")
        return v
    if isinstance(v, float):
        if v.is_integer():
            if abs(v) > SAFE:
                raise ValueError(f"no canonical form for {v!r}: beyond 2**53")
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


def _shape(v, path, floats, ints):
    if isinstance(v, bool) or v is None or isinstance(v, str):
        return
    if isinstance(v, float):
        floats.add(path)
    elif isinstance(v, int):
        ints.add(path)
    elif isinstance(v, dict):
        for k, x in v.items():
            k = str(k)
            _shape(x, f"{path}.{'*' if k.lstrip('-').isdigit() else k}",
                   floats, ints)
    elif isinstance(v, (list, tuple)):
        for x in v:
            _shape(x, f"{path}[*]", floats, ints)


def cmd_shapes(args):
    floats, ints = set(), set()
    for seed in parse_seeds(args.seeds):
        w = gen.generate(seed)
        _shape(w, "$", floats, ints)
        for n in range(1, args.days + 1):
            sim.tick(w)
            if args.watch and n % args.watch == 0:
                watcher.queue(w, watcher.choose(w))
            _shape(w, "$", floats, ints)
    print(json.dumps({"float": sorted(floats), "int": sorted(ints)}))


def _f(x):
    """A float for JSON: non-finite ones as tagged strings."""
    if x != x:
        return "nan"
    if x in (float("inf"), float("-inf")):
        return "inf" if x > 0 else "-inf"
    return x


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
        draws["big"] = [r.randrange(2 ** 32 - 1) for _ in range(3)] + \
            [r.randrange(2 ** 31) for _ in range(3)]
        # well past word 624, so the second (and third) twist is crossed
        draws["long"] = [r.random() for _ in range(1500)][-5:]
        out["rng"].append(draws)

    # The lazy twist's edges, word by word from a fresh seed: every word of
    # the first 1,300 (k = 226|227 = N-M, 623|624, 1247|1248 among them),
    # then random() — two words — from word 0 and from word 1, so draws
    # straddle 226|227 and 623|624 and 1247|1248.
    out["twist"] = []
    for s in ["twist", "1:0:gen", "3771:2871:whim:17:2"]:
        r0, r1, r2 = random.Random(s), random.Random(s), random.Random(s)
        words = [r0.getrandbits(32) for _ in range(1300)]
        even = [r1.random() for _ in range(650)]
        first = r2.getrandbits(32)
        odd = [r2.random() for _ in range(650)]
        out["twist"].append({"seed": s, "words": words, "even": even,
                             "first": first, "odd": odd})

    g = random.Random("vectors")
    edges = [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 0.125, 0.375, 2.675, 1.005,
             0.0, -0.0, 1e-7, 123456.5, 0.4999999999999999]
    floats = edges + [g.uniform(-1000, 1000) for _ in range(300)] + \
        [g.random() for _ in range(300)]
    for x in floats:
        out["round"].append([x, round(x)])
        for n in (0, 1, 2, 3, 6, 10):
            out["round_n"].append([x, n, round(x, n)])
    for x in [1e15 + 0.5, 2.0 ** 52 + 0.5, 1e21, -1e21, 1.7976931348623157e308,
              5e-324, 1e-300, 123456789.123456789, -0.0, 0.5e-6, 2.5e-7]:
        for n in (0, 1, 3, 6, 10, 15, 20):
            out["round_n"].append([x, n, round(x, n)])
    pairs = [(7, 2), (-7, 2), (7, -2), (-7, -2), (0, 3), (5.5, 2),
             (-5.5, 2), (1e-9, 7), (-1e-9, 7), (364, 91), (-1, 7)]
    pairs += [(g.uniform(-100, 100), g.choice([1, 2, 3, 0.7, -2.5]))
              for _ in range(200)]
    # ints whose zero remainder takes the divisor's sign as a float would
    pairs += [(0, -3), (3, -3), (-6, 3), (6, -3), (0, 3), (-0.0, 3),
              (0.0, -3.0), (-6.0, 3.0)]
    for a, b in pairs:
        q, m = divmod(a, b)
        out["divmod"].append([a, b, q, m, isinstance(a, int) and isinstance(b, int)])
    for n in (2, 3, 10, 100, 1000):
        for _ in range(20):
            xs = [g.uniform(-1, 1) * 10 ** g.randint(-8, 8) for _ in range(n)]
            out["sum"].append([xs, sum(xs)])
    out["sum"].append([[0.1] * 10, sum([0.1] * 10)])
    out["sum"].append([[1e16, 1.0, -1e16], sum([1e16, 1.0, -1e16])])
    inf, nan = float("inf"), float("nan")
    for xs in ([1e308, 1e308], [1e308, 1e308, -1e308], [inf, 1.0],
               [inf, -inf], [nan, 1.0], [1.0, inf, 1e-16], [-1e308, -1e308]):
        out["sum"].append([[_f(x) for x in xs], _f(sum(xs))])
    # ints and floats together: CPython adds ints exactly until the first
    # float, then later ints without compensation. Each list carries its
    # int mask, since JSON (and JS) can't tell 1 from 1.0.
    out["sum_mixed"] = []
    mixed = [[0.1, 1, -1], [1e16, 1, -1e16], [1, 2, 3], [1, 0.1, 2, 0.2],
             [2 ** 53 - 1, 0.5], [0.1, 0.2, 0.3, 1], [3, 0.0], [],
             [1e100, 1, -1e100, 1.0]]
    for _ in range(60):
        mixed.append([g.choice([g.randint(-9, 9),
                                g.uniform(-1, 1) * 10 ** g.randint(-8, 17)])
                      for _ in range(g.randint(1, 12))])
    for xs in mixed:
        out["sum_mixed"].append([xs, [isinstance(x, int) for x in xs],
                                 sum(xs), isinstance(sum(xs), int)])
    reprs = [1.0, 0.1, 1e-5, 1e-4, 0.0001234, 1e16, 1e15, 123456789012345678.0,
             1.5e-10, -2.5, 0.3, 2 / 3, 1e22, 5e-324, 1.7976931348623157e308,
             12345.678, 100.0, 1e21, 1e-7]
    reprs += [g.uniform(-1, 1) * 10 ** g.randint(-30, 30) for _ in range(300)]
    for x in reprs:
        out["repr"].append([x, repr(x)])
    for x in (-0.0, float("inf"), float("-inf"), float("nan")):
        out["repr"].append(["-0.0" if x == 0 else _f(x), repr(x)])
    json.dump(out, sys.stdout)
    sys.stdout.write("\n")


def cmd_yearturn(args):
    """Each (seed, year): plant, move to the eve of that year's turn, age
    every adult to the edge of the old-age rule (alternately elder + 7 and
    elder + 6, by id), tick once; print the world's and the events' hashes.
    tests/yearturn.test.ts makes the same edits on the TS side."""
    year_len = rules.R["world"]["days_per_season"] * 4
    ages = rules.R["people"]["ages"]
    out = []
    for seed, year in json.loads(args.cases):
        w = gen.generate(seed)
        w["day"] = year_len * year - 1
        adults = sorted((r for r in w["residents"].values() if r["age"] >= ages["adult"]),
                        key=lambda r: r["id"])
        for i, r in enumerate(adults):
            r["age"] = ages["elder"] + 7 if i % 2 == 0 else ages["elder"] + 6
        evs = sim.tick(w)
        out.append({"hash": world_hash(w),
                    "events": hashlib.sha256(canon(evs).encode()).hexdigest()[:16]})
    print(json.dumps(out))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    pw = sub.add_parser("worlds")
    pw.add_argument("--seeds", default="1-8")
    pw.add_argument("--days", type=int, default=0)
    pw.add_argument("--every", type=int, default=0)
    pw.add_argument("--dump", default=None)
    pw.add_argument("--watch", type=int, default=0)
    ps = sub.add_parser("shapes")
    ps.add_argument("--seeds", default="1-3")
    ps.add_argument("--days", type=int, default=0)
    ps.add_argument("--watch", type=int, default=0)
    sub.add_parser("vectors")
    py = sub.add_parser("yearturn")
    py.add_argument("cases", help='JSON list of [seed, year] pairs')
    args = ap.parse_args()
    {"worlds": cmd_worlds, "vectors": cmd_vectors,
     "shapes": cmd_shapes, "yearturn": cmd_yearturn}[args.cmd](args)


if __name__ == "__main__":
    main()
