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


def walk_cost(world, x, y):
    """What it costs to step onto a cell, or None where nobody may walk.
    A road is cheap, a lawn dear, water and a building wall impassable —
    a building is entered at its door, never crossed."""
    c = cell_at(world, x, y)
    return None if c is None else rules.R["sites"][c["site"]]["walk"]


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
        "biome": None,
    }


def new_cell(site: str) -> dict:
    return {"site": site, "wear": 0.0, "puddle": 0, "shade": 0.0, "noise": 0.0}


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
            "habit": {}, "mobility": 1.0, "stress": 0.0, "tag": None}


def new_fixture(fid: int, kind: str, x: int, y: int) -> dict:
    return {"id": fid, "kind": kind, "x": x, "y": y, "condition": 1.0,
            "occupants": [], "use_total": 0,
            "stock": rules.R["fixtures"][kind].get("stock", 0),
            # a tree carries the plant law; nothing else grows
            "sp": kind if rules.R["fixtures"][kind].get("living") else None,
            "age": 0, "stage": None, "hp": 10.0, "name": None}


def role_of(age: int) -> str:
    a = rules.R["people"]["ages"]
    if age < a["adult"]:
        return "child"
    if age >= a["elder"]:
        return "elder"
    return "adult"


# ------------------------------------------------------------------ counts

def counts(world) -> dict:
    """Residents by household type — the estate's census, the heir of
    Grove's species counts, and what the roster law is judged on."""
    out = {}
    for r in world["residents"].values():
        h = world["households"].get(str(r["household"]))
        if h:
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
