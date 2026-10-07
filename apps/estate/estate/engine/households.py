"""The households: who ages, who arrives, who leaves, and who fills a flat.

Grove's species tables generalised. A household is the estate's unit of
*life* where a resident is the unit of *want*: it ages, it grows, it can
become unhappy enough to leave, and when a flat stands empty long enough
the letting office fills it — with the type the estate is shortest of, not
with whoever happens to be first in the queue.

That last part is the whole of the roster law, and it is worth stating
plainly: **a household type can never be permanently lost.** An estate that
loses its elders because it happened to let to nobody but couples is an
estate that will never have an elder again, and the gate is right to refuse
it. So the office reads what the estate is missing and attracts that.

Nothing here acts on a need; that is the residents' work, and it has already
happened by the time this runs. This is the slower layer — the one whose
unit is years rather than hours.
"""

from .. import rules
from .. import world as W


# ------------------------------------------------------------ the mechanics

def move_in(w, kind, unit, rng, day=None):
    """A household takes a flat and its people are made.

    This lives here and NOT in gen, because gen is not the only thing that
    fills a flat — the letting office does too, every day of the estate's
    life — and one fact with two homes drifts (b2). gen calls this.
    """
    spec = rules.R["households"][kind]
    hid = w["next_id"]; w["next_id"] += 1
    hh = W.new_household(hid, kind, unit["id"])
    hh["moved_in"] = w["day"] if day is None else day
    unit["household"] = hid
    unit["vacant_since"] = None
    lo, hi = spec["members"]
    n = rng.randint(lo, hi)
    clo, chi = spec["children"]
    kids = rng.randint(clo, chi) if chi else 0
    kids = min(kids, max(0, n - 1))
    for _ in range(n):
        rid = w["next_id"]; w["next_id"] += 1
        age = rng.randint(2, 16) if kids > 0 else rng.randint(19, 78)
        if kids > 0:
            kids -= 1
        r = W.new_resident(rid, hid, age)
        r["name"] = W.name_for(rng)
        r["where"]["unit"] = unit["id"]
        r["mobility"] = spec.get("mobility", 1.0)
        w["residents"][str(rid)] = r
        hh["members"].append(rid)
    w["households"][str(hid)] = hh
    return hh


def move_out(w, hh, why):
    """A household leaves: its people go, and its flat stands empty from
    today — which is the day the letting office starts counting."""
    unit = w["units"].get(str(hh["unit"]))
    for rid in list(hh["members"]):
        w["residents"].pop(str(rid), None)
    hh["members"] = []
    if unit is not None and unit["household"] == hh["id"]:
        unit["household"] = None
        unit["vacant_since"] = w["day"]
    w["households"].pop(str(hh["id"]), None)
    return why


def household_of(w, r):
    return w["households"].get(str(r["household"]))


def members_of(w, hh):
    return [w["residents"][str(m)] for m in hh["members"]
            if str(m) in w["residents"]]


# ------------------------------------------------------------------ ageing

def age_people(w, evs):
    """A year older, on the turn of the year. Ageing happens on a date
    rather than on a birthday per person for the same reason the calendar
    has seasons: one clock, not two hundred."""
    for r in w["residents"].values():
        r["age"] += 1
        was = r["role"]
        r["role"] = W.role_of(r["age"])
        if r["role"] != was:
            evs.append({"day": w["day"], "kind": "grew",
                        "who": r["name"] or "someone",
                        "what": "a child becomes an adult"
                        if r["role"] == "adult" else "an adult becomes an elder"})


def old_age(w, evs):
    """The estate loses someone, rarely. Read straight from the rules so
    the chance is a knob and not a mystery, and named, so the estate can
    say who it was."""
    p = rules.R["pop"].get("death_prob", 0.0)
    if not p:
        return
    a = rules.R["people"]["ages"]
    rng = W.rng_for(w["seed"], w["day"], "death")
    for hh in list(w["households"].values()):
        for r in list(members_of(w, hh)):
            if r["role"] != "elder" or r["age"] < a["elder"] + 8:
                continue
            if rng.random() >= p:
                continue
            evs.append({"day": w["day"], "kind": "died",
                        "who": r["name"] or "someone"})
            hh["members"].remove(r["id"])
            w["residents"].pop(str(r["id"]), None)
            if not hh["members"]:
                move_out(w, hh, "the last of the household died")


def births(w, evs):
    """A household with children may gain one. This is the estate's own
    growth rather than the world's: it happens on the year turn, it needs
    room in the flat, and it is what keeps a roster from standing still."""
    p = rules.R["pop"].get("birth_prob", 0.0)
    if not p:
        return
    rng = W.rng_for(w["seed"], w["day"], "birth")
    for hh in list(w["households"].values()):
        if hh["kind"] not in ("family", "couple", "flat_share"):
            continue
        unit = w["units"].get(str(hh["unit"]))
        if unit is None or unit["household"] != hh["id"]:
            continue
        if len(hh["members"]) >= unit["capacity"] * rules.R["pop"]["crowding"]:
            continue                       # no room, and the estate knows it
        if rng.random() >= p:
            continue
        rid = w["next_id"]; w["next_id"] += 1
        r = W.new_resident(rid, hh["id"], 0)
        r["name"] = W.name_for(rng)
        r["where"]["unit"] = unit["id"]
        w["residents"][str(rid)] = r
        hh["members"].append(rid)
        evs.append({"day": w["day"], "kind": "born",
                    "who": r["name"],
                    "where": hh["kind"]})


# ------------------------------------------------------------- unhappiness

def unhappiness(w):
    """How settled each household is. It rises while its people are frayed
    and falls while they are not — so `unhappy` is a memory of the last few
    weeks rather than today's mood, which is what makes emigration rare and
    meaningful instead of instant."""
    rise = rules.R["pop"].get("unhappy_rise", 0.5)
    decay = rules.R["pop"].get("unhappy_decay", 0.97)
    for hh in w["households"].values():
        folk = members_of(w, hh)
        if not folk:
            continue
        frayed = sum(1 for r in folk if r["stress"] >= 1.0) / len(folk)
        hh["unhappy"] = hh["unhappy"] * decay + frayed * rise


def emigration(w, evs):
    """A household that has been unhappy for long enough leaves. This is
    the estate losing people for a reason, which is the only way a
    population should fall."""
    line = rules.R["pop"].get("emigrate_at", 3.0)
    for hh in list(w["households"].values()):
        if hh["unhappy"] < line:
            continue
        who = members_of(w, hh)
        evs.append({"day": w["day"], "kind": "left",
                    "who": (who[0]["name"] if who else "a household"),
                    "what": f"a {hh['kind']} leaves the estate"})
        move_out(w, hh, "unhappy")


# ----------------------------------------------------------- letting office

def want_kind(w):
    """Which household the estate is shortest of.

    Not against the *founding counts* — an estate that has exactly the
    households it was planted with has no deficit at all, so an office
    reading that would leave forty-four flats empty forever, which is what
    it did. The target is the planted *shape* scaled to the size the estate
    means to be: `fill_to` of its flats let, shared out in the proportions
    it was founded with. Then a type is short when it is short of its share
    of the estate, and the office lets to whoever is furthest short.

    That is what keeps a type from vanishing *and* what lets the estate grow
    into its own housing, which are the same rule read twice.
    """
    shape = rules.R["gen"].get("founding", {})
    total = sum(shape.values()) or 1
    target = rules.R["pop"].get("fill_to", 0.8) * len(w["units"])
    have = W.counts(w)
    need = {k: shape.get(k, 0) / total * target - have.get(k, 0)
            for k in rules.R["pop"]["roster"]}
    best = max(sorted(need), key=lambda k: need[k])
    return best if need[best] > 0.5 else None


def turnover(w, evs):
    """A household leaves for its own reasons.

    Not every departure is misery. The estate could only ever move people
    out when they were fraying, and on a healthy estate nobody is — so
    after the flats had filled, nobody left and nobody arrived and the
    estate had no news of any kind, for years. Real estates turn over:
    work, family, a bigger flat somewhere else. The letting office refills
    what they leave, so the population holds and the comings and goings
    are the estate's ordinary weather.
    """
    p = rules.R["pop"].get("move_away_prob", 0.0)
    if not p:
        return
    rng = W.rng_for(w["seed"], w["day"], "turnover")
    for hh in list(w["households"].values()):
        if rng.random() >= p:
            continue
        folk = members_of(w, hh)
        evs.append({"day": w["day"], "kind": "left",
                    "who": (f"the {folk[0]['name']} household" if folk
                            else f"a {hh['kind']}")})
        move_out(w, hh, "moved away")


def letting_office(w, evs):
    """Fill vacant flats. A flat must stand empty for `letting_after` days
    first — so a vacancy is a fact about the estate's life and not an
    instant refill — and the household that takes it is the one the
    estate needs."""
    after = rules.R["pop"]["letting_after"]
    rng = W.rng_for(w["seed"], w["day"], "letting")
    vacant = [u for u in w["units"].values() if u["household"] is None]
    for u in vacant:
        if u["vacant_since"] is None:
            u["vacant_since"] = w["day"]
    due = [u for u in vacant
           if w["day"] - (u["vacant_since"] or w["day"]) >= after]
    if not due:
        return
    kind = want_kind(w)
    if kind is None:
        return
    # a household of the needed type, already waiting — or one the estate
    # attracts, which is what a letting office is *for*. Without this an
    # estate that lost all its elders would wait forever for an elder to
    # turn up in a random queue, and the roster law would be a hope.
    pick = None
    for i, cand in enumerate(w["waiting"]):
        if cand["kind"] == kind:
            pick = i
            break
    if pick is not None:
        w["waiting"].pop(pick)
    # Which empty flat? Not the lowest-numbered one — that fills the estate
    # from the ground up, and after two years nobody had ever lived above
    # the third floor, so the stairs the whole interior model rests on were
    # a cost almost nobody paid. An office lets what it has.
    flat = due[rng.randrange(len(due))]
    move_in(w, kind, flat, rng, day=w["day"])
    evs.append({"day": w["day"], "kind": "moved_in", "where": kind,
                "flat": flat["id"]})


def arrivals(w):
    """The waiting list outside the gate. Households turn up wanting a
    flat; the office takes the ones it needs and the rest wait."""
    size = rules.R["pop"].get("waiting_size", 6)
    if len(w["waiting"]) >= size:
        return
    rng = W.rng_for(w["seed"], w["day"], "arrive")
    w["waiting"].append({"kind": rng.choice(rules.R["pop"]["roster"])})
    return w["waiting"][-1]


# -------------------------------------------------------------- conductor

def update_households(w, evs):
    """The slow layer, once a day: the year's turns, then the day's.

    The order matters. People are made and unmade before the office looks
    at the flats, so a household that left this morning leaves a vacancy
    the office counts tomorrow rather than one it fills today; and
    unhappiness is computed before emigration reads it, so a household
    leaves because of the weeks it has had, not because of this minute.
    """
    if w["day"] % (rules.R["world"]["days_per_season"] * 4) == 0:
        age_people(w, evs)
        old_age(w, evs)
        births(w, evs)
    unhappiness(w)
    emigration(w, evs)
    turnover(w, evs)
    arrivals(w)
    letting_office(w, evs)
