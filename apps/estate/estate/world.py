"""State containers, the calendar, and the one source of randomness.

The whole estate is plain JSON dicts, so it saves as a single blob. Every
random draw comes from (seed, day, salt), so the same seed and the same
days give the same estate in any process, on any machine.

There is deliberately no module-level constant here that duplicates a rules
value (Grove's b34/b35: knobs that existed, merged from JSON, and did
nothing). Everything is read from the live ruleset at the moment of use.
"""

import random

from . import rules

DAYS_PER_WEEK = 7


# ------------------------------------------------------------- the calendar

def season_index(day: int) -> int:
    """Which season this day belongs to. Day 1 is the first of spring."""
    per = rules.R["world"]["days_per_season"]
    return ((day - 1) // per) % 4


def season_name(day: int) -> str:
    return rules.R["presentation"]["seasons"][season_index(day)]


def weekday(day: int) -> int:
    """0..6 from the first day, which is a Monday."""
    return (day - 1) % DAYS_PER_WEEK


def weekday_name(day: int) -> str:
    return rules.R["presentation"]["weekdays"][weekday(day)]


def year_of(day: int) -> int:
    return (day - 1) // (rules.R["world"]["days_per_season"] * 4) + 1


def phase_names():
    return rules.R["world"]["phases"]


def rng_for(seed: int, day: int, salt: str = "") -> random.Random:
    """Deterministic per-day rng, stable across processes and replays. The
    salt is what keeps two draws on the same day independent."""
    return random.Random(f"{seed}:{day}:{salt}")


# ------------------------------------------------------------ the space

def in_bounds(world, x, y) -> bool:
    """A cell inside the estate's plan. The world is a rectangle, not a
    square: width and height are separate, and a plan is rarely square."""
    return 0 <= x < world["width"] and 0 <= y < world["height"]


def cell_at(world, x, y):
    return world["cells"][y][x] if in_bounds(world, x, y) else None


def in_region(world, region, x, y):
    """Is this cell inside a named region? A region is a rectangle of the
    plan — the estate's own geography, shipped by the pack — so that a
    watcher's fate can be about *somewhere* rather than everywhere."""
    spec = rules.R["regions"].get(region)
    if spec is None:
        return region == "all"
    xr, yr = spec.get("x"), spec.get("y")
    return ((xr is None or xr[0] <= x < xr[1]) and
            (yr is None or yr[0] <= y < yr[1]))


def fate_mult(world, key, x, y):
    """What the fates in force multiply a quantity by at this cell. One
    reader for every fate that acts on a place, so a fate cannot be
    declared and do nothing (b34) — if it is in the menu it is read here
    or it is not in the menu."""
    m = 1.0
    for f in world["fates"]:
        v = f.get(key)
        if v is None:
            continue
        if in_region(world, f.get("region", "all"), x, y):
            m *= v
    return m


def walk_cost(world, x, y):
    """What it costs to step onto a cell, or None where nobody may walk.
    A road is cheap, a lawn dear, water and a building wall impassable —
    a building is entered at its door, never crossed. Roadworks make a
    road dearer without ever closing it: a walk that cannot go anywhere
    is a resident who cannot eat (h10's shape, and not one to repeat)."""
    c = cell_at(world, x, y)
    if c is None:
        return None
    base = rules.R["sites"][c["site"]]["walk"]
    if base is None:
        return None
    return base * fate_mult(world, "walk_mult", x, y)


def stair_mult(world, building):
    """What the stairs cost here — a power cut is the lift going out, and
    a sixth floor with no lift is a longer walk than a sixth floor."""
    return fate_mult(world, "stair_mult",
                     building["door"][0], building["door"][1])


def passable(world, x, y) -> bool:
    return walk_cost(world, x, y) is not None


# -------------------------------------------------------------- containers

def new_state(seed: int, width: int, height: int) -> dict:
    """An empty estate shell; gen.py fills it.

    Only fields that something reads are here. A container field with no
    reader is Grove's b15 in miniature — `pending_since`, written every
    tick and read by nothing, which looked like state and was litter — so
    this dict grows as each reader arrives (the watcher's fates, the
    watches, the naming budget) rather than ahead of them.
    """
    return {
        "seed": seed, "day": 0,
        "width": width, "height": height,
        "cells": [],                 # rows[y][x] = cell dict
        "buildings": {},             # id -> building
        "units": {},                 # id -> unit
        "fixtures": {},              # id -> fixture (trees are fixtures too)
        "residents": {},             # id -> resident
        "households": {},            # id -> household
        "next_id": 1,
        "weather": "clear", "weather_left": 0, "wet_days": 0,
        "waiting": [],               # households outside, queued to move in
        # What the day was *like*, collected as it happens and thrown away
        # at the next dawn. Every one of these is already computed by the
        # tick and was being discarded, which is why a feed that read only
        # *events* reported "a quiet day" for weeks on an estate where
        # eighty people were out and about. A day with nothing notable in
        # it still had a shape, and the estate was not recording it.
        "daybook": {"uses": {}, "out": 0, "noise": 0.0, "broke": 0},
        "fates": [],                 # the watcher's effects, in force now
        "pending": [],               # sent, and landing tomorrow
        "biome": None,
    }


def new_cell(site: str) -> dict:
    return {"site": site, "wear": 0.0, "puddle": 0, "shade": 0.0,
            "noise": 0.0, "light": 0.0}


def new_building(bid: int, name: str, kind: str, x: int, y: int,
                 w: int, h: int, floors: int, door) -> dict:
    return {"id": bid, "name": name, "kind": kind, "x": x, "y": y,
            "w": w, "h": h, "floors": floors, "door": list(door),
            "units": [], "condition": 1.0, "power": True, "water": True}


def new_unit(uid: int, building: int, floor: int, capacity: int) -> dict:
    return {"id": uid, "building": building, "floor": floor,
            "household": None, "condition": 1.0, "capacity": capacity,
            "quiet_base": 0.7, "vacant_since": None}


def new_household(hid: int, kind: str, unit) -> dict:
    return {"id": hid, "kind": kind, "unit": unit, "members": [],
            "moved_in": 0, "unhappy": 0.0}


def new_resident(rid: int, household, age: int) -> dict:
    """A person. `where` is either a spot on the plan or a unit — being
    inside is a state, not a coordinate (see the plan's interiors note)."""
    return {"id": rid, "household": household, "name": None, "age": age,
            "role": role_of(age),
            "needs": {n: 0.0 for n in rules.R["needs"]},
            "where": {"mode": "in", "unit": None, "x": 0, "y": 0,
                      "fixture": None},
            "habit": {}, "mobility": 1.0, "stress": 0.0, "tag": None,
            # which way this walk is going round a wall it cannot cross;
            # None when it is walking freely. Read and written only by the
            # walk, and cleared the moment the way opens.
            "side": None}


def new_fixture(fid: int, kind: str, x: int, y: int) -> dict:
    """A placed thing. `condition` is its health — a bench's slats and a
    tree's life are the same number, worn by the same rule."""
    # `occupants` is who is here *now* — it is what congestion reads, and
    # it is emptied every day. `last_use` is how many used it yesterday,
    # which is what the noise field reads. They were one field once, and
    # the noise field was therefore built from a list that had just been
    # emptied: the playground, the shop and the tables had never made a
    # sound between them.
    f = {"id": fid, "kind": kind, "x": x, "y": y, "condition": 1.0,
         "occupants": [], "uses_today": 0, "use_total": 0, "last_use": 0}
    if rules.R["fixtures"][kind].get("stock"):
        f["stock"] = rules.R["fixtures"][kind]["stock"]
    if rules.R["fixtures"][kind].get("living"):
        f["age"] = 0
    return f


def name_for(rng) -> str:
    """A person's name, drawn from the pack's own list.

    The estate is small enough that people are named rather than numbered,
    and a name is most of what makes a card read as a life instead of a
    row. The list lives in the pack with the rest of the world's words —
    a page that invented its own names would be a second copy of a fact
    the world already owns (grove b21/b34).
    """
    names = rules.R["presentation"].get("resident_names") or ()
    return rng.choice(tuple(names)) if names else None


def role_of(age: int) -> str:
    a = rules.R["people"]["ages"]
    if age < a["adult"]:
        return "child"
    if age >= a["elder"]:
        return "elder"
    return "adult"


# ------------------------------------------------------------------ counts

def counts(world) -> dict:
    """Households by type — the estate's census, the heir of Grove's species
    counts, and what the roster law is judged on.

    This had two homes and they disagreed: `world.counts` counted *people*
    by their household's type while `__main__._census` and `render.header`
    each counted *households* in their own way, so the same estate had a
    different census depending on which one you asked. One home, and it is
    the one the law is about — a household is what a flat holds, and a flat
    is what the estate has. A household not in a flat is not living here
    and is not counted."""
    out = {}
    for h in world["households"].values():
        u = world["units"].get(str(h["unit"]))
        if u is not None and u["household"] == h["id"]:
            out[h["kind"]] = out.get(h["kind"], 0) + 1
    return out


def residents_here(world, x, y):
    """Everybody standing on one cell, at this instant."""
    return [r for r in world["residents"].values()
            if r["where"]["mode"] == "at"
            and r["where"]["x"] == x and r["where"]["y"] == y]


def occupied_units(world) -> int:
    return sum(1 for u in world["units"].values()
               if u["household"] is not None)
