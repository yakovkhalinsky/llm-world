"""The weekday: the school run, the school day, and work.

The family rules (engine/families.py) said who may be where; nothing said
anyone *had* to be anywhere, so a Tuesday was a Sunday with different
multipliers and the children's day had no shape at all. This module is the
shape. It is deterministic and algorithmic, it reads every number from
`rules.R["school"]` and `rules.R["work"]`, and it does nothing on a plan
without a school gate and a bus stop (a world generated before them).

- **pupils** are residents aged `school.ages`. On a school day the run is
  made in `school.run`: a pupil walks to the school gate and goes in the
  moment they reach it. An under-ten never walks it alone — they are in
  their minder's party (`families.plan`), and the minder's party goes to
  the gate; the little ones too young for school come along. The 10-15s
  walk on their own.
- **at school** a pupil's mode is `"school"`: inside the fence, on a spot
  in the yard, with the teachers. That counts as supervised (it is not out
  alone and not home alone), and a phase there meets `school.meets`.
- **home time** is the first phase after `school.hours`. The 10-15s come
  out of the gate. An under-ten waits inside until a guardian who is on
  the estate comes for them — the household's carer first — and then
  walks home in that guardian's party. Nobody comes: the child stays in
  (after-school club) and the next phase tries again.
- **workers** are working-age adults (`people.ages`) holding a job, drawn
  once per person from the seed (`work.share`). On a work day they walk
  to the bus stop in `work.commute` and are gone once there: mode
  `"away"`, off the plan, through `work.shift`. They step off the bus at
  the stop at the start of the first phase after it.
- **the carer.** A household with young children keeps one adult on the
  estate for them: a guardian who has no job if there is one, else the
  lowest-id adult. With a child under school age the carer does not work;
  with only pupils they work `work.school_hours`, and are back for home
  time. Nobody leaves for work while they are minding a child (they are
  late, and catch the next bus), so the minding is never dropped.
"""

from .. import rules
from .. import world as W
from . import families

AWAY = "away"
SCHOOL = "school"


def law():
    return rules.R["school"]


def jobs():
    return rules.R["work"]


# ------------------------------------------------------------- the places

def gate(w):
    """The school's gate fixture, or None on a plan without a school."""
    for fid in sorted(w["fixtures"], key=int):
        f = w["fixtures"][fid]
        if f["kind"] == "school":
            return f
    return None


def stop(w):
    for fid in sorted(w["fixtures"], key=int):
        f = w["fixtures"][fid]
        if f["kind"] == "bus_stop":
            return f
    return None


def school_building(w):
    for bid in sorted(w["buildings"], key=int):
        b = w["buildings"][bid]
        if b["kind"] == "school":
            return b
    return None


def yard_spots(w):
    b = school_building(w)
    if b is None or not b.get("yard"):
        g = gate(w)
        return [(g["x"], g["y"])] if g else []
    x0, y0, yw, yh = b["yard"]
    return [(x, y) for y in range(y0, y0 + yh) for x in range(x0, x0 + yw)]


# ------------------------------------------------------------- the people

def school_day(w):
    return W.weekday(w["day"]) in law()["days"]


def is_pupil(r):
    lo, hi = law()["ages"]
    return lo <= r["age"] < hi


def has_job(w, r):
    """Drawn once per person from the seed and kept: the same resident
    works in every run, and a birthday never redraws it."""
    if "job" not in r:
        r["job"] = (W.rng_for(w["seed"], 0, f"job:{r['id']}").random()
                    < jobs()["share"])
    return r["job"]


def is_worker(w, r):
    ages = rules.R["people"]["ages"]
    return ages["adult"] <= r["age"] < ages["elder"] and has_job(w, r)


def carer(w, hh):
    """The adult who stays on the estate for this household's young
    children, or None if it has none."""
    folk = families.members(w, hh)
    if not any(families.is_young(r) for r in folk):
        return None
    adult = rules.R["people"]["ages"]["adult"]
    adults = sorted((r for r in folk if r["age"] >= adult),
                    key=lambda r: r["id"])
    if not adults:
        return None
    free = [r for r in adults if not is_worker(w, r)]
    return (free or adults)[0]


def shift(w, r):
    """The phases `r` is away at work today: () for anyone not working."""
    if not school_day(w) or not is_worker(w, r):
        return ()
    hh = families.household(w, r)
    if hh is not None and carer(w, hh) is r:
        young = families.young_in(w, hh)
        if any(not is_pupil(k) for k in young):
            return ()                     # a child at home all day
        return tuple(jobs()["school_hours"])
    return tuple(jobs()["shift"])


def commuting(w, r, phase):
    """Is `r` due at the bus stop this phase: the commute, or a shift
    phase they have not yet left for (late, for a child they were minding)."""
    sh = shift(w, r)
    if not sh or r["where"]["mode"] == AWAY:
        return False
    return phase == jobs()["commute"] or phase in sh


def due_at_school(w, r, phase):
    """Is `r` a pupil who should be walking to school this phase?"""
    if not school_day(w) or not is_pupil(r):
        return False
    if r["where"]["mode"] == SCHOOL or r.get("schooled") == w["day"]:
        return False                      # in, or already been today
    return phase == law()["run"] or phase in law()["hours"]


def busy(w, g, phase):
    """A guardian with somewhere else to be this phase is the last choice
    of minder (`families.plan` takes this as its first key)."""
    return commuting(w, g, phase)


# ------------------------------------------------------- the phase's turns

def _enter(w, k):
    """A pupil goes in at the gate, to a spot in the yard."""
    spots = yard_spots(w)
    g = gate(w)
    inside = sum(1 for r in w["residents"].values()
                 if r["where"]["mode"] == SCHOOL)
    x, y = spots[inside % len(spots)] if spots else (g["x"], g["y"])
    k["where"] = {"mode": SCHOOL, "unit": None, "x": x, "y": y,
                  "fixture": g["id"] if g else None}
    k["side"] = None
    k["schooled"] = w["day"]


def _home_unit(w, r):
    hh = families.household(w, r)
    return hh["unit"] if hh else None


def _out_at(w, r, f):
    r["where"] = {"mode": "at", "unit": _home_unit(w, r), "x": f["x"],
                  "y": f["y"], "fixture": None}
    r["side"] = None


def _meet(w, r, meets):
    full = rules.R["engine"]["need_max"] * rules.R["engine"]["arrive_restore"]
    for need, q in meets.items():
        if need not in r["needs"]:
            continue
        spec = rules.R["needs"][need]
        if "roles" in spec and r["role"] not in spec["roles"]:
            continue
        r["needs"][need] = max(0.0, r["needs"][need] - full * q)


def begin(w, phase, evs=None):
    """The start of a phase, before anybody chooses: the bus brings the
    workers whose shift is over, the school lets out whoever's day is done,
    and a phase at school or at work does what it does for their needs."""
    g, s = gate(w), stop(w)
    for rid in sorted(w["residents"], key=int):
        r = w["residents"][rid]
        mode = r["where"]["mode"]
        if mode == AWAY:
            if s is None or phase not in shift(w, r):
                _out_at(w, r, s or {"x": r["where"]["x"], "y": r["where"]["y"]})
            else:
                _meet(w, r, jobs()["meets"])
        elif mode == SCHOOL:
            if phase in law()["hours"] and school_day(w):
                _meet(w, r, law()["meets"])
            elif not families.is_young(r) or g is None:
                _out_at(w, r, g or {"x": r["where"]["x"],
                                    "y": r["where"]["y"]})
            # an under-ten waits inside for a guardian (`collector`)


def collectors(w, phase):
    """{guardian id: [children waiting at school]} — who fetches whom this
    phase. The carer if they are on the estate, else the lowest-id guardian
    on it; nobody who is away."""
    out = {}
    if gate(w) is None or phase in law()["hours"] and school_day(w):
        return out
    for hid in sorted(w["households"], key=int):
        hh = w["households"][hid]
        kids = sorted((k for k in families.young_in(w, hh)
                       if k["where"]["mode"] == SCHOOL),
                      key=lambda r: r["id"])
        if not kids:
            continue
        here = sorted((m for m in families.members(w, hh)
                       if families.is_guardian(m)
                       and m["where"]["mode"] not in (AWAY, SCHOOL)),
                      key=lambda r: r["id"])
        if not here:
            continue
        c = carer(w, hh)
        who = c if c in here else here[0]
        out[who["id"]] = kids
    return out


def duty(w, party, phase, fetch):
    """Where this party *must* go this phase, as a candidate, or None.

    `fetch` is the list of children this lead is collecting (`collectors`).
    The school run beats the commute: a parent walks the children to the
    gate and catches the later bus."""
    lead = party[0]
    g, s = gate(w), stop(w)
    if g is not None:
        if fetch:
            return {"kind": "school", "x": g["x"], "y": g["y"],
                    "fixture": g, "unit": None, "duty": "pickup"}
        if any(due_at_school(w, p, phase) for p in party):
            return {"kind": "school", "x": g["x"], "y": g["y"],
                    "fixture": g, "unit": None, "duty": "run"}
    if s is not None and len(party) == 1 and commuting(w, lead, phase):
        return {"kind": "bus_stop", "x": s["x"], "y": s["y"],
                "fixture": s, "unit": None, "duty": "commute"}
    return None


def arrive(w, party, c, phase, fetch):
    """The party has reached the gate or the stop: who goes in, who comes
    out, who gets on the bus."""
    lead = party[0]
    if c["duty"] == "commute":
        lead["where"] = {"mode": AWAY, "unit": _home_unit(w, lead),
                         "x": c["x"], "y": c["y"], "fixture": None}
        lead["side"] = None
        _tally(w, c["fixture"])
        return list(party)
    if c["duty"] == "pickup":
        for k in fetch:
            families.follow(k, lead)
        _tally(w, c["fixture"])
        return list(party) + list(fetch)
    # the run: whoever is due goes in; the lead (and anyone too young)
    # stays outside the gate
    stay = []
    for p in party:
        if due_at_school(w, p, phase):
            _enter(w, p)
            _tally(w, c["fixture"])
        else:
            stay.append(p)
    return stay


def _tally(w, f):
    f["uses_today"] = f.get("uses_today", 0) + 1
    f["use_total"] += 1


# ------------------------------------------------------------- the census

def roll(w):
    """The school's numbers for a card: pupils on the roll, in today, and
    in right now; and the bus stop's: workers, and away right now."""
    pupils = [r for r in w["residents"].values() if is_pupil(r)]
    workers = [r for r in w["residents"].values() if is_worker(w, r)]
    return {
        "enrolled": len(pupils),
        "in_today": sum(1 for r in pupils if r.get("schooled") == w["day"]),
        "in_now": sum(1 for r in pupils if r["where"]["mode"] == SCHOOL),
        "workers": len(workers),
        "away_now": sum(1 for r in workers if r["where"]["mode"] == AWAY),
    }


# ------------------------------------------------------- the day's record

def overnight(w):
    """The start of a day: nobody is still at work or at school. Anyone
    the day left there (a world saved mid-day, or a child no guardian could
    reach) is home, which `families.settle` then makes sure is minded."""
    for r in w["residents"].values():
        if r["where"]["mode"] in (AWAY, SCHOOL):
            hh = families.household(w, r)
            unit = w["units"].get(str(hh["unit"])) if hh else None
            if unit is None:
                g = gate(w) or stop(w)
                _out_at(w, r, g or r["where"])
                continue
            b = w["buildings"][str(unit["building"])]
            r["where"] = {"mode": "in", "unit": unit["id"],
                          "x": b["door"][0], "y": b["door"][1],
                          "fixture": None}
            r["side"] = None
    w["day_phases"] = {"day": w["day"], "phases": {}}


MODE_CODE = {"in": "i", "at": "a", SCHOOL: "s", AWAY: "w"}


def record(w, phase):
    """Where everybody was at the end of this phase, kept for today only,
    so the 3D page can show a daytime that has already passed (the live
    snapshot is always the end of the night): {phase: {id: [x, y, mode,
    unit, fixture, walking with]}}."""
    book = w.get("day_phases")
    if not book or book.get("day") != w["day"]:
        book = w["day_phases"] = {"day": w["day"], "phases": {}}
    snap = {}
    for rid in sorted(w["residents"], key=int):
        r = w["residents"][rid]
        wh = r["where"]
        snap[rid] = [wh["x"], wh["y"], MODE_CODE.get(wh["mode"], "a"),
                     wh.get("unit"), wh.get("fixture"),
                     families.walking_with(w, r)]
    book["phases"][phase] = snap
