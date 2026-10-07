"""World state containers, species tables and small helpers.

World state is plain JSON-serializable dicts so it can be saved as one
blob to SQLite. All randomness derives from (seed, tick, salt-string) so
the world is fully deterministic and the rng never needs serializing.
"""

import random

from . import rules

def size_default():
    return rules.R["world"]["size"]

def season_length():
    return rules.R["world"]["weeks_per_season"]

SEASONS = ("spring", "summer", "autumn", "winter")
REGION_NAMES = ("NW", "NE", "SW", "SE")

# ---------------------------------------------------------------- plants

PLANT_SPECIES = rules.R["plants"]         # live aliases of the pack
ANIMAL_SPECIES = rules.R["animals"]

# ---------------------------------------------------------------- helpers

def season_index(tick: int) -> int:
    """Which season (0..3) does this week belong to. Week 1 is spring."""
    return ((tick - 1) // rules.R["world"]["weeks_per_season"]) \
        % len(SEASONS)

def season_name(tick: int) -> str:
    return SEASONS[season_index(tick)]

def rng_for(seed: int, tick: int, salt: str = "") -> random.Random:
    """Deterministic per-tick rng, stable across processes/replays."""
    return random.Random(f"{seed}:{tick}:{salt}")

def in_bounds(size: int, x: int, y: int) -> bool:
    return 0 <= x < size and 0 <= y < size

def quadrant(x: int, y: int, size: int) -> str:
    w = h = size / 2
    return ("W" if x < w else "E") + ("N" if y < h else "S")

def region_cells(size: int, region: str):
    """Yield (x, y) for a region name: NW/NE/SW/SE/all."""
    hx = size // 2
    hy = size // 2
    for y in range(size):
        for x in range(size):
            if region == "all":
                yield x, y
            elif region == "NW" and x < hx and y < hy:
                yield x, y
            elif region == "NE" and x >= hx and y < hy:
                yield x, y
            elif region == "SW" and x < hx and y >= hy:
                yield x, y
            elif region == "SE" and x >= hx and y >= hy:
                yield x, y



def creature_names():
    """The pack's pool of names, in its own voice."""
    return rules.R["presentation"]["creature_names"]


def place_words():
    """The pack's words for a place."""
    return rules.R["presentation"]["place_words"]


def place(world, x, y):
    """Human-readable spot for prose: pond's edge or a region of the world."""
    size = world["size"]
    if x is None:
        return rules.R["presentation"]["world_word"]
    for ny in (y - 1, y + 1):
        for nx in (x - 1, x + 1):
            if terrain_at(world, nx, ny) == "water":
                return rules.R["presentation"].get("shore_place",
                                                   "the pond's edge")
    return place_words().get(quadrant(x, y, size),
                             rules.R["presentation"]["world_word"])


def terrain_at(world, x, y):
    size = world["size"]
    if not in_bounds(size, x, y):
        return None
    return world["cells"][y][x]["terrain"]

def new_plant(pid: int, sp: str, x: int, y: int, stage: str = "sapling",
              age: int = 0) -> dict:
    return {"id": pid, "sp": sp, "x": x, "y": y, "age": age, "stage": stage,
            "hp": 10.0, "berries": False, "name": None}

def new_animal(aid: int, sp: str, x: int, y: int, age: float = 2.0) -> dict:
    return {"id": aid, "sp": sp, "x": x, "y": y, "age": age,
            "hunger": 2.0, "energy": 4.0, "hp": 10.0, "preg": 0,
            "transient": None, "name": None}

def new_state(seed: int, size: int = None) -> dict:
    """An empty world shell; gen.py fills it."""
    size = size or rules.R["world"]["size"]
    return {
        "seed": seed, "size": size, "tick": 0,
        "weather": "clear", "weather_left": 0,
        "cells": [],                 # rows[y][x] = cell dict
        "plants": {},                # id -> plant (log-stage included)
        "animals": {},               # id -> animal
        "next_id": 1,
        "absent": {},                # species -> first tick absent
        "names": {},                 # creature/tree id -> name
        "name_budget": 0,            # LLM name requests allowed this week
        "effects": [],               # ongoing operator effects
        "pending_effect": None,      # queued operator effect (applied next tick)
        "name_pool": [],             # newborns awaiting a name from the voice
        "seedbank": {},              # dormant seeds in the soil
        "destinies": [],             # the soul's watch over named creatures
        "next_op": 6,                # tick when the LLM operator is next invited
        "op_history": [],            # last operator decisions (for its own digest)
        "elder_ids": [],             # plants that reached 'old' stage
        "fawns_named": 0,            # births named since last season turn
    }

def counts(world: dict) -> dict:
    """Animal population by species."""
    out: dict = {}
    for a in world["animals"].values():
        out[a["sp"]] = out.get(a["sp"], 0) + 1
    return out

def plant_counts(world: dict) -> dict:
    out: dict = {}
    for p in world["plants"].values():
        if p["stage"] != "log":
            out[p["sp"]] = out.get(p["sp"], 0) + 1
    return out

def oldest_plant(world: dict, sp: str):
    best = None
    for p in world["plants"].values():
        if p["sp"] == sp and p["stage"] in ("mature", "old"):
            if best is None or p["age"] > best["age"]:
                best = p
    return best

def plant_label(world: dict, p: dict) -> str:
    name = (world["names"].get(str(p["id"])) or p.get("name"))
    return f"{name} the {PLANT_SPECIES[p['sp']]['desc']}" if name \
        else f"a {p['stage']} {PLANT_SPECIES[p['sp']]['desc']}"