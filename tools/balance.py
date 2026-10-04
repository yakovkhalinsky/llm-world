"""balance.py — the ecologist's ledger for the grove.

Runs many seeded worlds headlessly (no LLM) and reports population
persistence, boom/bust ranges, extinctions and recolonizations, with
hard pass/fail lines so sim tuning stays honest.

  python3 tools/balance.py [--seeds 12] [--weeks 600] [--jobs N]
  (defaults: 10 seeds × 900 weeks, all the CPU's cores)
"""

import argparse
import multiprocessing as mp
import sys
import time

sys.path.insert(0, "grove/..")
sys.path.insert(0, ".")

from grove import gen, sim          # noqa: E402
from grove import rules as RL       # noqa: E402
from grove import world as W        # noqa: E402

CHECKS = {
    "plants_min": 120,          # the grove must keep cover
    "species_min": 6,           # every base resident alive in the end
    # every plant species must still be living at the end of the run —
    # the seed bank exists so no species goes permanently extinct
    "plant_species": ("pine", "birch", "willow", "fern", "berry"),
}


def run_world(seed, weeks):
    w = gen.generate(seed, 24)
    last_tick = {"t": 0}
    pops_hist, plant_hist = [], []
    extinctions = recolonizations = 0
    absent_before = set()
    for _ in range(weeks):
        sim.tick(w)
        c = W.counts(w)
        pops_hist.append(c)
        plant_hist.append(W.plant_counts(w))
        # extinction bookkeeping from the world's own ledger
        for sp in ("rabbit", "deer", "fox", "owl", "robin", "boar"):
            absent = c.get(sp, 0) == 0
            was = sp in absent_before
            if not absent:
                if was:
                    recolonizations += 1
                absent_before.discard(sp)
            else:
                absent_before.add(sp)
    extinctions = len([sp for c in [pops_hist[-1]]
                       for sp in ("rabbit", "deer", "fox", "owl", "robin",
                                  "boar") if c.get(sp, 0) == 0]) or 0
    # a species that ENDED absent counts once
    ended_absent = [sp for sp in ("rabbit", "deer", "fox", "owl",
                                  "robin", "boar")
                    if pops_hist[-1].get(sp, 0) == 0]
    spans = {}
    for sp in ("rabbit", "deer", "fox", "owl", "robin", "boar", "pine",
               "birch"):
        ser = [c.get(sp, 0) for c in (pops_hist + plant_hist)
               if sp in (c or {})]
        spans[sp] = (min(ser) if ser else 0, max(ser) if ser else 0)
    return {"seed": seed, "weeks": weeks,
            "end_season": W.season_name(w["tick"]),
            "end": pops_hist[-1] | plant_hist[-1],
            "ended_absent": ended_absent,
            "recolonizations": recolonizations,
            "spans": spans}


def judge(report, weeks):
    fails = []
    end = report["end"]
    if sum(n for sp, n in end.items()
           if sp in ("pine", "birch", "willow")) < CHECKS["plants_min"]:
        fails.append("the forest lost its canopy")
    rosters = [sp for sp in ("rabbit", "deer", "fox", "owl", "robin",
                             "boar") if end.get(sp, 0) == 0]
    # robins read as gone only if the run doesn't END in winter, when
    # they are legitimately south
    if report.get("end_season") == "winter":
        rosters = [sp for sp in rosters if sp != "robin"]
    missing = rosters
    if missing:
        fails.append(f"species gone: {','.join(missing)}")
    missing = [sp for sp in CHECKS["plant_species"] if end.get(sp, 0) == 0]
    if missing:
        fails.append(f"plant species extinct: {','.join(missing)}")
    if all(n == 0 for n in end.values()):
        fails.append("the world died entirely")
    return fails


def _worker(args):
    seed, weeks = args
    t0 = time.time()
    rep = run_world(seed, weeks)
    fails = judge(rep, weeks)
    return rep, fails, time.time() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", type=int, default=10)
    ap.add_argument("--weeks", type=int, default=900)
    ap.add_argument("--jobs", type=int, default=mp.cpu_count() or 2)
    ap.add_argument("--start-seed", type=int, default=1)
    a = ap.parse_args()

    seeds = [(a.start_seed + i, a.weeks) for i in range(a.seeds)]
    print(f"balance: {a.seeds} worlds × {a.weeks} weeks ({a.weeks // 48:.0f} yrs) "
          f"({a.jobs} processes)")
    t0 = time.time()
    worst, all_fails = [], []
    with mp.Pool(a.jobs) as pool:
        for rep, fails, dt in pool.imap_unordered(_worker, seeds):
            span_txt = " ".join(
                f"{k}:{v[1] or '–'}" for k, v in rep["spans"].items()
                if v[1])
            all_fails.extend((rep["seed"], f) for f in fails)
            worst.append(f"seed {rep['seed']}: end {rep['end']} "
                         f"(recol {rep['recolonizations']}) · {span_txt}"
                         + (f"  ✗ {fails}" if fails else "  ✓"))
    print(f"ran in {time.time()-t0:.0f}s")
    for line in sorted(worst)[:a.seeds]:
        print(" ", line)
    if all_fails:
        print("\nFAILED CHECKS:")
        for seed, why in all_fails:
            print(f"  seed {seed}: {why}")
        sys.exit(1)
    print("\nALL CHECKS PASSED")


if __name__ == "__main__":
    main()