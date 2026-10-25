"""family_check.py — are the estate's young children ever left alone?

Runs seeded estates and looks at every resident at the end of every phase
(the states the engine settles on and the views draw). A *young* child is
one under `families.young_under`; a *guardian* is a member of the same
household aged `families.guardian_from` or over. A young child is

- **out alone** when they are out on the plan and no guardian of theirs is
  out within `families.near` cells (Chebyshev) of them;
- **home alone** when they are indoors and no guardian of theirs is
  indoors in the same flat;
- **at school** (inside the fence, with the teachers) is supervised, and
  is counted on its own line — while the school is open: the run's phase
  and the school hours of a school day (`rules.school`). A young child
  still inside the fence after that is **left at school**, and fails the
  check like a child home alone. A guardian away at work is not near
  anyone.

The curfew and the evening range are measured where people actually
end up, not where they meant to go:

- **out at night**: a young child out on the plan at the end of a
  `families.home_by` phase, and separately any member of a household with
  young children out then (the rule is that the whole household is home);
- **evening far**: a young child out at the end of the evening further
  than `families.evening_range` (Manhattan) from their own door — they are
  with their minder, so this is the minder's evening range too.

Older children (from `young_under` to `guardian_from`) are counted as
**out of bounds** when they are out at night or in the evening, or out by
day further than `families.older_range` from their own door.

  python3 tools/family_check.py [--seeds 1,2] [--days N] [--json]

Every count must be 0, and the exit status says whether it was.

Pure engine; it observes through `residents.PHASE_WATCHERS` and changes
nothing. The thresholds fall back to the defaults below when the ruleset
has no `families` table. An engine older than the family rules has no
`PHASE_WATCHERS` to observe through, so measuring one (the PR's "before"
figures) needs the watcher hook patched into its `update_residents`.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from estate import gen, rules, sim                      # noqa: E402
from estate.engine import residents                      # noqa: E402

FALLBACK = {"young_under": 10, "guardian_from": 16, "near": 1,
            "older_range": 14, "evening_range": 10, "home_by": ["night"]}


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


def _school_open(w, phase):
    """Is anyone at school to mind the children this phase? (The rules'
    own words; an engine with no school has none open.)"""
    s = rules.R.get("school")
    if not s:
        return False
    from estate import world as W
    weekday = W.weekday(w["day"])
    return (weekday in s["days"]
            and (phase == s["run"] or phase in s["hours"]))


def look(w, phase, tally, cases=None):
    """Count, for one settled phase, every young child out alone or home
    alone and every older child out of bounds."""
    f = law()
    for hh in w["households"].values():
        folk = [w["residents"][str(m)] for m in hh["members"]
                if str(m) in w["residents"]]
        guards = [r for r in folk if r["age"] >= f["guardian_from"]]
        door = _door(w, hh)
        young = [k for k in folk if k["age"] < f["young_under"]]
        if young and phase in f["home_by"]:
            tally["household_out_at_night"] += sum(
                1 for r in folk if r["where"]["mode"] == "at")
        for k in folk:
            if k["age"] >= f["guardian_from"]:
                continue
            wk = k["where"]
            if k["age"] < f["young_under"]:
                tally["young_phases"] += 1
                if wk["mode"] == "school":
                    # inside the school fence, with the teachers: minded,
                    # and nobody's guardian needs to be there — while
                    # there are teachers
                    tally["young_school"] += 1
                    ok = _school_open(w, phase)
                    kind = "left_at_school"
                elif wk["mode"] == "in":
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
                    far = (door is not None and abs(wk["x"] - door[0])
                           + abs(wk["y"] - door[1]) > f["evening_range"])
                    late = None
                    if phase in f["home_by"]:
                        late = "young_out_at_night"
                    elif phase == "evening" and far:
                        late = "evening_far"
                    if late:
                        tally[late] += 1
                        if cases is not None and len(cases) < 20:
                            cases.append({"day": w["day"], "phase": phase,
                                          "kind": late, "child": k["id"],
                                          "age": k["age"],
                                          "at": [wk["x"], wk["y"]],
                                          "door": door})
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
            "young_school": 0,
            "out_alone": 0, "home_alone": 0, "left_at_school": 0,
            "young_out_at_night": 0, "household_out_at_night": 0,
            "evening_far": 0,
            "older_phases": 0, "older_out_of_bounds": 0}


def run(seeds, days):
    tally = new_tally()
    cases = []

    def watch(w, phase):
        look(w, phase, tally, cases)

    residents.PHASE_WATCHERS.append(watch)
    try:
        for s in seeds:
            w = gen.generate(s)
            for _ in range(days):
                sim.tick(w)
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
          f"(indoors {t['young_in']}, out {t['young_out']}, "
          f"at school {t['young_school']})")
    print(f"  out with no guardian near: {t['out_alone']} "
          f"({100 * t['out_alone'] / yp:.1f}% of young-child phases)")
    print(f"  home alone:                {t['home_alone']} "
          f"({100 * t['home_alone'] / yp:.1f}%)")
    print(f"  left at school after hours: {t['left_at_school']}")
    print(f"  out at night:              {t['young_out_at_night']} "
          f"(household members out at night: "
          f"{t['household_out_at_night']})")
    print(f"  out at evening's end beyond the evening range: "
          f"{t['evening_far']}")
    print(f"older-child phases: {t['older_phases']}, out of bounds "
          f"{t['older_out_of_bounds']}")
    return 1 if failures(t) else 0


def failures(t):
    """The counts that must be zero."""
    return sum(t[k] for k in ("out_alone", "home_alone", "left_at_school",
                              "young_out_at_night", "household_out_at_night",
                              "evening_far", "older_out_of_bounds"))


if __name__ == "__main__":
    sys.exit(main())
