"""The biome's rules — every number that runs the world, in one dict.

`rules.R` is the live ruleset the engine reads at use-time. A JSON
override file (`--rules path.json` / `grove rules --template`) merges
over these defaults IN PLACE, so nothing in the engine changes shape.

The sections mirror the machinery:
  world    — the map and the calendar
  weather  — the sky's dice          cells    — soil/grass/water
  plants   — species tables          animals  — species tables
  gen      — worldgen's hand        pacing    — the world's temporal tempo
  naming   — the voice's budget     gate      — the balance harness's lines
"""

import copy
import json

R = {
    "world": {"size": 24, "weeks_per_season": 12},

    "weather": {
        "rain_gain": 0.22, "storm_gain": 0.28,
        "natural_storm_prob": {"2": 0.05},          # autumn
        "rain_prob": {"0": 0.22, "1": 0.10, "2": 0.28, "3": 0.0},
        "log_ttl": 5, "carcass_ttl": 3,
    },

    "cells": {
        "grass_regrow": {"0": 0.06, "1": 0.07, "2": 0.03, "3": 0.0},
        "moisture_decay": {"0": 0.97, "1": 0.955, "2": 0.975, "3": 1.0},
        "winter_grass_decay": 0.93,
        "wet_streak_soak": 0.4,          # per consecutive rainy week
        "mushroom_base_prob": 0.08,
        "mushroom_humus_mult": 2.5,
        "humus_per_log": 0.25,
        "regen_per_week": 0.4,
        "regen_humus_bonus": 0.2,
        "understory_hp_floor": 1.0,      # frost stuns, never murders
    },

    "plants": {},     # the pack folds its nature in at import
    "animals": {},    # species tables live in grove/biomes/ now
    "presentation": {},  # the pack's words, colours, emoji, names
    "pop": {
        "winter_drain": 1.4,
        "recolonize_after": 16,
        "base_residents": ["rabbit", "deer", "fox", "owl", "robin", "boar"],
        "robins_return_prob": 0.75,
        "robins_return_min": 4,
        "germinate_min_alive": 3,        # rescue below this count
        "germinate_cap": 8, "germinate_min": 3,
        "shade_sprout_prob": 0.4,        # seeding under another tree
    },

    "gen": {},        # the planting recipe rides the pack too
    "pacing": {
        "tick_seconds": {"run": 12.0, "web": 12.0},
        "soul_gap_local": (60, 120),          # wall s between invitations
        "soul_gap_cloud": (40, 80),
        "reprobe_seconds": 900,               # before retrying the chosen voice
        "chron_flush_need": 4,                # backlog to outweigh naming
        "chron_max_per_tick": 10,
        "naming_budget_per_week": 3,
        "naming_cap_per_season": 14,
    },

    "gate": {"seeds": 8, "weeks": 900, "plants_min": 120,
             "species_all_present": True},

    # the amendments' hard law: any LLM review may propose changes, but
    # only inside these ranges — the engine clamps or refuses, and only
    # one rule changes per review
    "bounds": {
        "animals.*.cap": (2, 60),
        "animals.*.lifespan": (20, 400),
        # the shipped packs run 0.25 (tortoise) to 0.8 (rabbit): a band
        # that stopped at 0.5 silently clamped every steward that named a
        # real value into a 37% cut nobody asked for
        "animals.*.hunger_drain": (0.2, 1.0),
        "animals.*.lit_prob": (0.02, 0.6),
        "animals.*.hunt_prob": (0.1, 0.8),
        "plants.*.seed_prob": (0.02, 0.6),
        "plants.*.light_need": (0.1, 0.9),
        "plants.*.storm_fall_old": (0.0, 0.5),
        "weather.rain_prob.2": (0.0, 0.6),      # autumn's rain
        "pop.recolonize_after": (8, 40),
        "pop.robins_return_prob": (0.4, 1.0),
    },
    "review": {"every_weeks": 48, "auto_tune": True},
}


def load_override(path):
    """Merge a JSON rules file over the live ruleset, in place, so the
    engine's existing references update without touching shapes."""
    with open(path) as f:
        given = json.load(f)

    def merge(dst, src):
        for k, v in src.items():
            if isinstance(v, dict) and isinstance(dst.get(k), dict):
                merge(dst[k], v)
            else:
                dst[k] = copy.deepcopy(v)

    merge(R, given)
    return given


def dump_template(path):
    with open(path, "w") as f:
        json.dump(R, f, indent=1, sort_keys=True)
    return path


def int_keys_fix(section):
    """JSON round-trips make season keys strings; give floats back."""
    return {int(k): v for k, v in section.items()}


def seasons_floats(section):
    return {int(k): v for k, v in section.items()}

# -- the biome packs ------------------------------------------------------
# the pack is the world's nature: its species tables and planting recipe.
# Folding happens IN PLACE so the engine's aliases never rebind; the
# reviewer's JSON overrides always stack above the pack.

from .biomes import load_spec

_ACTIVE = "grove"


def select_biome(name):
    """Fold a biome pack into the live ruleset in place, and remember
    which nature now holds."""
    global _ACTIVE
    spec = load_spec(name)
    for section in spec:
        if section not in R:
            continue
        if section in ("plants", "animals", "gen"):
            R[section].clear()          # packs ship these whole
        R[section].update(spec[section])
    _ACTIVE = name


def active_biome():
    return _ACTIVE


select_biome("grove")     # the grove's nature arrives with the import
