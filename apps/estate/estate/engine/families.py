"""Families: who minds the little ones.

A household is a set of people sharing a flat, and until this module it was
nothing more — a four-year-old chose a bench as freely as anyone and sat on
it alone at midnight. These rules are deterministic and algorithmic (no
model anywhere), and they read every number from `rules.R["families"]`.

- **guardians.** A child under `young_under` is *young*. A member of the
  same household aged `guardian_from` or more is a *guardian*: a parent, a
  grandparent, or a brother or sister of sixteen or more. `guardians_of`
  is the link, and it is computed from the household rather than stored,
  so a birth, a death, an arrival or a birthday can never leave it stale.
- **the minder.** Every phase, each group of young children has exactly
  one minder, chosen from the guardians who are *with* them already (in
  the same flat, or out beside them): the least pressed of them, so a
  busy parent's errand is covered by the other adult at home. Only a
  guardian already with the children may take them over, so minding
  passes hand to hand and is never dropped.
- **the party.** The minder and the children choose and move as one. The
  most pressing need in the party — the minder's or a child's — picks the
  place, so a child's longing to play is a playground trip with a parent
  and a parent's hunger is the shop run with the children along. The
  children walk on the minder's cell and arrive when the minder does.
- **curfew.** A household with young children is home in `home_by`; the
  minder keeps within `evening_range` of the door in the evening.
- **the 10-15s.** Alone they may use only `older_places`, within
  `older_range` of their own door, and only in `older_daytime`; otherwise
  they go home.
- **no child-headed households.** A household with children and nobody of
  adult age left (the grandparent who was raising them has died, or the
  adults have gone) leaves the estate whole: the children go to family
  elsewhere rather than staying on alone.
"""

from .. import rules


def law():
    return rules.R["families"]


def is_young(r):
    return r["age"] < law()["young_under"]


def is_guardian(r):
    return r["age"] >= law()["guardian_from"]


def is_older_child(r):
    return not is_young(r) and not is_guardian(r)


def members(w, hh):
    return [w["residents"][str(m)] for m in hh["members"]
            if str(m) in w["residents"]]


def household(w, r):
    return w["households"].get(str(r["household"]))


def guardians_of(w, r):
    """Everyone in this person's household who may mind them."""
    hh = household(w, r)
    if hh is None:
        return []
    return [g for g in members(w, hh) if g is not r and is_guardian(g)]


def young_in(w, hh):
    return [r for r in members(w, hh) if is_young(r)]


def has_young(w, r):
    hh = household(w, r)
    return hh is not None and bool(young_in(w, hh))


def together(a, b):
    """Is `a` with `b`: both in the same flat, or both out and beside each
    other."""
    wa, wb = a["where"], b["where"]
    if wa["mode"] == "in" or wb["mode"] == "in":
        return (wa["mode"] == wb["mode"] == "in"
                and wa.get("unit") == wb.get("unit"))
    return max(abs(wa["x"] - wb["x"]), abs(wa["y"] - wb["y"])) \
        <= law()["near"]


def follow(child, minder):
    """Put a child where their minder is: in the same flat, or on the same
    cell. `fixture` is cleared — standing beside the bench a parent sat on
    is not sitting on it — and so is any walk round a wall."""
    child["where"] = dict(minder["where"], fixture=None)
    child["side"] = None


def unattended(w):
    """Every young child not with a guardian, as (child, household)."""
    out = []
    for hh in w["households"].values():
        for k in young_in(w, hh):
            if not any(together(k, g) for g in guardians_of(w, k)):
                out.append((k, hh))
    return out


def plan(w, press):
    """Who minds whom this phase: {minder id: [children]}.

    `press(r)` is how hard a guardian's own most pressing need is pushing;
    the least pressed guardian with a group takes it. Children are grouped
    by where they are, so a parent at home with the baby and another out
    with the eight-year-old are two minders, and two groups a single
    guardian is with merge into one party.
    """
    leads = {}
    for hid in sorted(w["households"], key=int):
        hh = w["households"][hid]
        kids = sorted(young_in(w, hh), key=lambda r: r["id"])
        if not kids:
            continue
        guards = sorted((g for g in members(w, hh) if is_guardian(g)),
                        key=lambda r: r["id"])
        if not guards:
            continue        # `settle` sends such a household away
        for k in kids:
            near = [g for g in guards if together(k, g)]
            if not near:
                continue    # `settle` mends this before a phase is lived
            m = min(near, key=lambda g: (press(g), g["id"]))
            leads.setdefault(m["id"], []).append(k)
    return leads


def settle(w, evs=None):
    """Mend anything the slow layer has done to the minding, so every
    phase starts with each young child beside a guardian.

    The day's own rules never break it; what can is the slow layer between
    days — a baby born while both parents were out, the minder who died —
    and a world saved before these rules existed. A household with no
    guardian at all, or with children and no adult, leaves (see the module
    note). A child with no guardian beside them is joined by one: someone
    already home if there is, otherwise the eldest guardian comes home to
    them. Returns how many children were mended.
    """
    adult = rules.R["people"]["ages"]["adult"]
    for hid in sorted(w["households"], key=int):
        hh = w["households"].get(hid)
        if hh is None:
            continue
        folk = members(w, hh)
        kids = [r for r in folk if r["age"] < adult]
        if kids and not any(r["age"] >= adult for r in folk):
            _leave(w, hh, evs)
    mended = 0
    for k, hh in sorted(unattended(w), key=lambda kh: kh[0]["id"]):
        guards = guardians_of(w, k)
        if not guards:
            continue
        if any(together(k, g) for g in guards):
            continue        # an earlier mend in this loop already joined
        home = [g for g in guards if g["where"]["mode"] == "in"
                and g["where"].get("unit") == hh["unit"]]
        if home:
            k["where"] = {"mode": "in", "unit": hh["unit"],
                          "x": k["where"]["x"], "y": k["where"]["y"],
                          "fixture": None}
        else:
            g = max(guards, key=lambda r: (r["age"], -r["id"]))
            g["where"] = {"mode": "in", "unit": hh["unit"],
                          "x": g["where"]["x"], "y": g["where"]["y"],
                          "fixture": None}
            g["side"] = None
            follow(k, g)
        mended += 1
    return mended


def _leave(w, hh, evs):
    from . import households as H         # households imports this module
    folk = members(w, hh)
    if evs is not None:
        evs.append({"day": w["day"], "kind": "left",
                    "who": (f"the {folk[0]['name']} household" if folk
                            else f"a {hh['kind']}"),
                    "what": "the children go to family elsewhere"})
    H.move_out(w, hh, "the children went to family elsewhere")


# ------------------------------------------------------------ what's allowed

def _dist_home(w, r, c):
    hh = household(w, r)
    u = w["units"].get(str(hh["unit"])) if hh else None
    if u is None:
        return 0
    door = w["buildings"][str(u["building"])]["door"]
    return abs(c["x"] - door[0]) + abs(c["y"] - door[1])


def allows(w, r, c, phase, minding):
    """May `r` choose candidate `c` this phase? Home is always allowed.
    `minding` is True for a minder choosing for their party."""
    if c["kind"] == "home":
        return True
    f = law()
    if phase in f["home_by"] and (minding or has_young(w, r)):
        return False
    if minding and phase == "evening":
        return _dist_home(w, r, c) <= f["evening_range"]
    if is_older_child(r):
        return (phase in f["older_daytime"]
                and c["kind"] in f["older_places"]
                and _dist_home(w, r, c) <= f["older_range"])
    return True


def curfew(w, r, phase, minding):
    """Must `r` head home this phase even with nothing to do there?"""
    f = law()
    if phase in f["home_by"] and (minding or has_young(w, r)):
        return True
    return is_older_child(r) and phase not in f["older_daytime"]
