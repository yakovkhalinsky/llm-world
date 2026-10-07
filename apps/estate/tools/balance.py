"""The gate: seeded estates × years, and every law must hold.

Pure engine, no model. Eight estates are planted, run for years, and then
asked the questions a living place should be able to answer. It does not
only check that life exists; it checks that life is *unsatisfied enough to
be interesting* and *varied enough to be worth watching* — because the
failure mode of a simulation like this is not death, it is a metronome: an
estate where every need is met, nothing happens, and the years pass
identically. The estate produced one of those by accident (h12, a shop that
broke every other day), and the whole year's *average* hid it.

Two of the checks are proxies and say so:

- **friction** measures the mean of each resident's top need pressure, over
  every resident, every phase, every day of the run. A band too low is a
  utopia; too high is a famine. It is measured by instrumenting the
  chooser rather than by changing the engine, so the engine the gate judges
  is the engine that ships.
- **distinctness** counts the distinct (need, place-kind) pairs the estate
  actually used each day. Below a floor, everyone is doing the same thing
  in the same place — a marching band, not an estate.

  python3 tools/balance.py [--seeds N] [--years N] [--fingerprint]

On success it prints a fingerprint — a hash of every number it checked —
so an engine change that alters the world's behaviour cannot land
unnoticed: the fingerprint is the balance gate's own determinism, the same
way the world's hash is the engine's.
"""

import argparse
import hashlib
import json
import os
import statistics
import sys
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from estate import gen, rules, sim                      # noqa: E402
from estate.engine import residents                      # noqa: E402


# ------------------------------------------------------- the instruments

FRICTION = []
USED = defaultdict(set)          # day -> {(need, place-kind)}
KINDS_USED = defaultdict(int)    # fixture kind -> uses


def instrument():
    """Watch the chooser and the satisfier without changing either. The
    gate must judge the engine that ships, so it observes rather than
    edits — and it puts everything back before it returns."""
    orig_ranked = residents.ranked_needs
    orig_satisfy = residents._satisfy

    def ranked(w, r, phase):
        out = orig_ranked(w, r, phase)
        FRICTION.append(residents.pressure(w, r, out[0], phase) if out else 0.0)
        return out

    def satisfy(w, r, c, need, phase):
        USED[w["day"]].add((need, c["kind"]))
        if c["kind"] != "home":
            KINDS_USED[c["fixture"]["kind"]] += 1
        return orig_satisfy(w, r, c, need, phase)

    residents.ranked_needs = ranked
    residents._satisfy = satisfy
    return lambda: (setattr(residents, "ranked_needs", orig_ranked),
                    setattr(residents, "_satisfy", orig_satisfy))


# ------------------------------------------------------------- one estate

def run_one(seed, years, days_per_year=364):
    """Plant an estate, run it, and report what it became."""
    FRICTION.clear()
    USED.clear()
    KINDS_USED.clear()
    w = gen.generate(seed)
    start = rules.R["gate"]
    for _ in range(years * days_per_year):
        sim.tick(w)

    census = {}
    for h in w["households"].values():
        u = w["units"].get(str(h["unit"]))
        if u is not None and u["household"] == h["id"]:
            census[h["kind"]] = census.get(h["kind"], 0) + 1
    occupied = sum(1 for u in w["units"].values() if u["household"] is not None)
    vacancy = []
    for b in w["buildings"].values():
        if b["kind"] != "block":
            continue
        live = sum(1 for u in b["units"]
                   if w["units"][str(u)]["household"] is not None)
        vacancy.append(live / max(1, len(b["units"])))
    worn = sorted({f["kind"] for f in w["fixtures"].values()
                   if f["condition"] <= 0})
    afford = {k for k, v in rules.R["fixtures"].items() if v.get("affords")}
    umin = rules.R["gate"]["use_min"]
    unused = sorted(k for k in afford if KINDS_USED.get(k, 0) < umin)
    distinct = ([len(v) for v in USED.values()] or [0])
    return {
        "seed": seed, "days": years * days_per_year,
        "census": census,
        "residents": len(w["residents"]),
        "households": len(w["households"]),
        "occupancy": round(occupied / max(1, len(w["units"])), 3),
        "emptiest_block": round(min(vacancy) if vacancy else 1.0, 3),
        "unused_fixture": unused,
        "all_broken": [k for k in afford if k in worn
                       and KINDS_USED.get(k, 0) == 0],
        "friction": round(statistics.mean(FRICTION) if FRICTION else 0.0, 3),
        "distinct": round(statistics.mean(distinct), 2),
        "worn": worn,
        "start": start,
    }


# -------------------------------------------------------------- the checks

def gate(r):
    """Every law, checked and named. Returns the list of failures."""
    g = rules.R["gate"]
    bad = []
    roster = rules.R["pop"]["roster"]
    gone = [k for k in roster if not r["census"].get(k)]
    if gone:
        bad.append(f"seed {r['seed']}: household types absent at the end: "
                   f"{gone} — a type lost is a type that can never return")
    if not (g["residents_min"] <= r["residents"] <= g["residents_max"]):
        bad.append(f"seed {r['seed']}: {r['residents']} residents, outside "
                   f"[{g['residents_min']}, {g['residents_max']}]")
    if r["occupancy"] < g["occupancy_min"]:
        bad.append(f"seed {r['seed']}: occupancy {r['occupancy']} below "
                   f"{g['occupancy_min']} — the estate is emptying")
    if r["emptiest_block"] <= 0.0:
        bad.append(f"seed {r['seed']}: a block stands entirely vacant")
    if r["unused_fixture"]:
        bad.append(f"seed {r['seed']}: fixture kinds nothing used in "
                   f"{r['days']} days: {r['unused_fixture']} — a place the "
                   f"law offers and nobody can reach or wants")
    lo, hi = g["friction"]
    if not (lo <= r["friction"] <= hi):
        bad.append(f"seed {r['seed']}: friction {r['friction']} outside "
                   f"[{lo}, {hi}] — "
                   + ("a utopia: nothing presses" if r["friction"] < lo
                      else "a famine: everything presses at once"))
    if r["distinct"] < g["distinct_min"]:
        bad.append(f"seed {r['seed']}: {r['distinct']} distinct "
                   f"(need, place) pairs a day, below {g['distinct_min']} — "
                   f"the estate is a marching band")
    return bad


def fingerprint(rows):
    keep = [{k: v for k, v in r.items() if k != "start"} for r in rows]
    blob = json.dumps(keep, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--seeds", type=int, default=None)
    ap.add_argument("--years", type=int, default=None)
    ap.add_argument("--fingerprint", action="store_true",
                    help="print only the fingerprint")
    args = ap.parse_args(argv)
    g = rules.R["gate"]
    seeds = args.seeds or g["seeds"]
    years = args.years or g["years"]

    restore = instrument()
    rows = []
    try:
        for seed in range(1, seeds + 1):
            rows.append(run_one(seed, years))
    finally:
        restore()

    if args.fingerprint:
        print(fingerprint(rows))
        return 0

    print(f"{seeds} estates × {years} years\n")
    print("%-5s %-4s %-6s %-5s %-6s %-8s %-6s %s"
          % ("seed", "folk", "hhlds", "occ", "frict", "distinct", "empty",
             "census"))
    for r in rows:
        print("%-5d %-4d %-6d %-5.2f %-6.2f %-8.2f %-6.2f %s"
              % (r["seed"], r["residents"], r["households"], r["occupancy"],
                 r["friction"], r["distinct"], r["emptiest_block"],
                 " ".join(f"{k[:4]}{v}" for k, v in sorted(r["census"].items()))))
    print()

    bad = []
    for r in rows:
        bad += gate(r)
    if bad:
        print("THE GATE FAILS:")
        for b in bad:
            print("  ✗ " + b)
    else:
        print("the gate holds.")
    print(f"\nfingerprint {fingerprint(rows)}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
