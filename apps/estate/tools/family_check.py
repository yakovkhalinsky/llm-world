"""family_check.py — are the estate's young children ever left alone?

Runs seeded estates and looks at every resident at the end of every phase
(the states the engine settles on and the views draw). A *young* child is
one under `families.young_under`; a *guardian* is a member of the same
household aged `families.guardian_from` or over. A young child is

- **out alone** when they are out on the plan and no guardian of theirs is
  out within `families.near` cells (Chebyshev) of them;
- **home alone** when they are indoors and no guardian of theirs is
  indoors in the same flat.

Older children (from `young_under` to `guardian_from`) are counted as
**out of bounds** when they are out at night or in the evening, or out by
day further than `families.older_range` from their own door.

  python3 tools/family_check.py [--seeds 1,2] [--days N] [--json]

Pure engine; it observes through `residents.PHASE_WATCHERS` and changes
nothing. It also runs on an engine that has no family rules at all (it
falls back to the same thresholds), which is how the "before" figure in
the PR was measured.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from estate import gen, rules, sim                      # noqa: E402
from estate.engine import residents                      # noqa: E402

FALLBACK = {"young_under": 10, "guardian_from": 16, "near": 1,
            "older_range": 14}


def law():
    out = dict(FALLBACK)
    out.update({k: v for k, v in rules.R.get("families", {}).items()
                if k in FALLBACK})
    return out


def _door(w, hh):
    u = w["units"].get(str(hh["unit"]))
    if u is None:
        return None
    return w["buildings"][str(u["building"])]["door"]


def look(w, phase, tally, cases=None):
    """Count, for one settled phase, every young child out alone or home
    alone and every older child out of bounds."""
    f = law()
    for hh in w["households"].values():
        folk = [w["residents"][str(m)] for m in hh["members"]
                if str(m) in w["residents"]]
        guards = [r for r in folk if r["age"] >= f["guardian_from"]]
        door = _door(w, hh)
        for k in folk:
            if k["age"] >= f["guardian_from"]:
                continue
            wk = k["where"]
            if k["age"] < f["young_under"]:
                tally["young_phases"] += 1
                if wk["mode"] == "in":
                    tally["young_in"] += 1
                    ok = any(g["where"]["mode"] == "in"
                             and g["where"].get("unit") == wk.get("unit")
                             for g in guards)
                    kind = "home_alone"
                else:
                    tally["young_out"] += 1
                    ok = any(g["where"]["mode"] == "at"
                             and max(abs(g["where"]["x"] - wk["x"]),
                                     abs(g["where"]["y"] - wk["y"]))
                             <= f["near"] for g in guards)
                    kind = "out_alone"
                if not ok:
                    tally[kind] += 1
                    if cases is not None and len(cases) < 20:
                        cases.append({"day": w["day"], "phase": phase,
                                      "kind": kind, "child": k["id"],
                                      "age": k["age"],
                                      "household": hh["kind"],
                                      "guardians": len(guards)})
            else:
                tally["older_phases"] += 1
                if wk["mode"] != "at":
                    continue
                far = (door is None or abs(wk["x"] - door[0])
                       + abs(wk["y"] - door[1]) > f["older_range"])
                if phase in ("evening", "night") or far:
                    tally["older_out_of_bounds"] += 1


def new_tally():
    return {"young_phases": 0, "young_in": 0, "young_out": 0,
            "out_alone": 0, "home_alone": 0,
            "older_phases": 0, "older_out_of_bounds": 0}


def run(seeds, days):
    tally = new_tally()
    cases = []
    state = {}

    def watch(w, phase):
        look(w, phase, tally, cases)

    residents.PHASE_WATCHERS.append(watch)
    try:
        for s in seeds:
            w = gen.generate(s)
            for _ in range(days):
                sim.tick(w)
            state[s] = len(w["residents"])
    finally:
        residents.PHASE_WATCHERS.remove(watch)
    return tally, cases


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--seeds", default="42")
    ap.add_argument("--days", type=int, default=364)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    seeds = [int(s) for s in a.seeds.split(",")]
    t, cases = run(seeds, a.days)
    if a.json:
        print(json.dumps({"tally": t, "cases": cases}, indent=1))
        return 0
    yp = max(1, t["young_phases"])
    print(f"seeds {seeds}, {a.days} days, law {law()}")
    print(f"young-child phases: {t['young_phases']}  "
          f"(indoors {t['young_in']}, out {t['young_out']})")
    print(f"  out with no guardian near: {t['out_alone']} "
          f"({100 * t['out_alone'] / yp:.1f}% of young-child phases)")
    print(f"  home alone:                {t['home_alone']} "
          f"({100 * t['home_alone'] / yp:.1f}%)")
    print(f"older-child phases: {t['older_phases']}, out of bounds "
          f"{t['older_out_of_bounds']}")
    return 1 if t["out_alone"] or t["home_alone"] else 0


if __name__ == "__main__":
    sys.exit(main())
