"""World state containers, species tables and small helpers.

World state is plain JSON-serializable dicts so it can be saved as one
blob to SQLite. All randomness derives from (seed, tick, salt-string) so
the world is fully deterministic and the rng never needs serializing.
"""

import random

SIZE_DEFAULT = 24
WEEKS_PER_SEASON = 12
SEASONS = ("spring", "summer", "autumn", "winter")
REGION_NAMES = ("NW", "NE", "SW", "SE")

# ---------------------------------------------------------------- plants

PLANT_SPECIES = {
    "pine": {
        "kind": "tree",
        "mature_age": 20, "old_age": 96, "max_age": 240,
        "seed_season": 2,          # autumn
        "seed_prob": 0.16, "seed_radius": 2,
        "light_need": 0.25,        # shade tolerant
        "shade_self": 0.55, "shade_adjacent": 0.30,
        "storm_fall_mature": 0.05, "storm_fall_old": 0.12,
        "frost_hp": 0.0, "emoji": "pine",
        "desc": "pine",
    },
    "birch": {
        "kind": "tree",
        "mature_age": 12, "old_age": 88, "max_age": 160,
        "seed_season": 2, "seed_prob": 0.30, "seed_radius": 4,
        "light_need": 0.45,
        "shade_self": 0.45, "shade_adjacent": 0.22,
        "storm_fall_mature": 0.09, "storm_fall_old": 0.22,
        "frost_hp": 0.15, "emoji": "leaf",
        "desc": "birch",
    },
    "willow": {
        "kind": "tree",
        "mature_age": 9, "old_age": 72, "max_age": 140,
        "seed_season": 2, "seed_prob": 0.28, "seed_radius": 3,
        "near_water": 2,           # must spawn within N cells of water
        "light_need": 0.40,
        "shade_self": 0.40, "shade_adjacent": 0.20,
        "storm_fall_mature": 0.12, "storm_fall_old": 0.30,
        "frost_hp": 0.30, "emoji": "leaf",
        "desc": "willow",
    },
    "fern": {
        "kind": "understory",
        "mature_age": 2, "old_age": 12, "max_age": 22,
        "light_need": 0.65,        # needs SHADE: grows when light BELOW this
        "spread_prob": 0.10, "spread_radius": 1,
        "storm_fall_mature": 0.02, "storm_fall_old": 0.05,
        "frost_hp": 0.25, "emoji": "fern",
        "desc": "fern",
    },
    "berry": {
        "kind": "shrub",
        "mature_age": 3, "old_age": 18, "max_age": 30,
        "seed_season": 0, "seed_prob": 0.10, "seed_radius": 2,
        "light_need": 0.50,
        "shade_self": 0.03, "shade_adjacent": 0.0,
        "storm_fall_mature": 0.06, "storm_fall_old": 0.15,
        "frost_hp": 0.50, "emoji": "berry",
        "desc": "berry bush",
    },
}

PLANT_STAGES = ("seed", "sapling", "mature", "old", "log")

# ---------------------------------------------------------------- animals

ANIMAL_SPECIES = {
    "rabbit": {
        "hunger_drain": 0.8, "lifespan": 60, "speed": 3, "scan": 4,
        "lit_size": 3, "lit_prob": 0.28, "breed_seasons": (0, 1),
        "energy_breed": 6.0, "cap": 60, "winterslow": 0.4,
        "predators": ("fox", "owl", "wolf"),
    },
    "deer": {
        "hunger_drain": 0.55, "lifespan": 200, "speed": 2, "scan": 5,
        "lit_size": 1, "lit_prob": 0.10, "breed_seasons": (0,),
        "energy_breed": 8.0, "cap": 22, "winterslow": 0.5,
    },
    "fox": {
        "hunt": "rabbit", "hunt_prob": 0.5, "hunger_drain": 0.7,
        "lifespan": 130, "speed": 3, "scan": 6,
        "lit_size": 2, "lit_prob": 0.09, "breed_seasons": (0, 2),
        "energy_breed": 7.0, "cap": 14, "winterslow": 0.6,
    },
    "owl": {
        "strike": ("rabbit", "robin"), "strike_prob": 0.18, "strike_range": 5,
        "hunger_drain": 0.5, "lifespan": 160, "speed": 2, "scan": 2,
        "lit_size": 1, "lit_prob": 0.10, "breed_seasons": (0, 1),
        "energy_breed": 6.0, "cap": 6, "winterslow": 1.0,
    },
    "robin": {
        "hunger_drain": 0.5, "lifespan": 40, "speed": 4, "scan": 3,
        "lit_size": 3, "lit_prob": 0.30, "breed_seasons": (0, 1),
        "energy_breed": 5.0, "cap": 30, "winterslow": 0.75, "flyer": True,
    },
    "boar": {
        "hunger_drain": 0.5, "lifespan": 140, "speed": 1, "scan": 3,
        "lit_size": 2, "lit_prob": 0.15, "breed_seasons": (1, 2),
        "energy_breed": 6.0, "cap": 10, "winterslow": 0.7,
    },
    # transient visitors (never recolonized, never permanent residents)
    "stag": {  # lone wandering stag
        "hunger_drain": 0.55, "lifespan": 200, "speed": 2, "scan": 5,
        "winterslow": 0.6, "visitor": True,
    },
    "wolf": {  # passing wolf: hunts rabbits and deer
        "hunt": "rabbit", "hunt_prob": 0.6, "prey2": "deer", "prey2_prob": 0.3,
        "hunger_drain": 0.7, "lifespan": 180, "speed": 3, "scan": 7,
        "winterslow": 1.0, "visitor": True,
    },
}

ANIMAL_DEFAULT_CAPS = {sp: t.get("cap", 100) for sp, t in ANIMAL_SPECIES.items()}

CREATURE_NAMES = [
    "Bracken", "Sorrel", "Thistle", "Rowan", "Bramble", "Clover", "Fable",
    "Juniper", "Hazel", "Wren", "Tarn", "Moss", "Pip", "Nettle", "Sallow",
    "Alder", "Bramblin", "Fen", "Tansy", "Osier", "Cinder", "Dapple",
    "Loam", "Reed", "Sedge", "Yarrow", "Hobble", "Quill", "Burr", "Larch",
    "Marl", "Frost", "Gorse", "Teasel", "Cob", "Rush", "Bent", "Vole",
]

# ---------------------------------------------------------------- helpers

def season_index(tick: int) -> int:
    """Which season (0..3) does this week belong to. Week 1 is spring."""
    return ((tick - 1) // WEEKS_PER_SEASON) % len(SEASONS)

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


PLACE_WORDS = {"NW": "the north-west woods", "NE": "the north-east woods",
               "SW": "the south-west woods", "SE": "the south-east woods",
               "all": "the grove"}


def place(world, x, y):
    """Human-readable spot for prose: pond's edge or a region of the woods."""
    size = world["size"]
    if x is None:
        return "the grove"
    for ny in (y - 1, y + 1):
        for nx in (x - 1, x + 1):
            if terrain_at(world, nx, ny) == "water":
                return "the pond's edge"
    return PLACE_WORDS.get(quadrant(x, y, size), "the grove")


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

def new_state(seed: int, size: int = SIZE_DEFAULT) -> dict:
    """An empty world shell; gen.py fills it."""
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

def animal_label(world: dict, a: dict) -> str:
    name = (world["names"].get(str(a["id"])) or a.get("name"))
    sp = a["sp"]
    return f"{name} the {sp}" if name else f"a wild {sp}"