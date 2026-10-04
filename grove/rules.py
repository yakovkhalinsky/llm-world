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

    "plants": {
        "pine":   {"kind": "tree", "mature_age": 20, "old_age": 96,
                   "max_age": 240, "seed_season": 2, "seed_prob": 0.16,
                   "seed_radius": 3, "light_need": 0.25,
                   "shade_self": 0.55, "shade_adjacent": 0.30,
                   "storm_fall_mature": 0.05, "storm_fall_old": 0.12,
                   "frost_hp": 0.0, "emoji": "pine", "desc": "pine"},
        "birch":  {"kind": "tree", "mature_age": 12, "old_age": 88,
                   "max_age": 160, "seed_season": 2, "seed_prob": 0.28,
                   "seed_radius": 6, "light_need": 0.45,
                   "shade_self": 0.45, "shade_adjacent": 0.22,
                   "storm_fall_mature": 0.09, "storm_fall_old": 0.22,
                   "frost_hp": 0.15, "emoji": "leaf", "desc": "birch"},
        "willow": {"kind": "tree", "mature_age": 9, "old_age": 72,
                   "max_age": 140, "seed_season": 2, "seed_prob": 0.30,
                   "seed_radius": 3, "near_water": 2, "light_need": 0.40,
                   "shade_self": 0.40, "shade_adjacent": 0.20,
                   "storm_fall_mature": 0.12, "storm_fall_old": 0.30,
                   "frost_hp": 0.15, "emoji": "leaf", "desc": "willow"},
        "fern":   {"kind": "understory", "mature_age": 2, "old_age": 30,
                   "max_age": 58, "light_need": 0.65, "spread_prob": 0.16,
                   "spread_radius": 1, "storm_fall_mature": 0.02,
                   "storm_fall_old": 0.05, "frost_hp": 0.25,
                   "emoji": "fern", "desc": "fern"},
        "berry":  {"kind": "shrub", "mature_age": 3, "old_age": 22,
                   "max_age": 40, "seed_season": (0, 2),
                   "seed_prob": 0.22, "seed_radius": 3, "light_need": 0.50,
                   "shade_self": 0.03, "shade_adjacent": 0.0,
                   "storm_fall_mature": 0.06, "storm_fall_old": 0.15,
                   "frost_hp": 0.20, "emoji": "berry",
                   "desc": "berry bush"},
    },

    "animals": {
        "rabbit": {"hunger_drain": 0.8, "lifespan": 60, "speed": 3,
                   "scan": 4, "lit_size": 3, "lit_prob": 0.28,
                   "breed_seasons": (0, 1), "energy_breed": 6.0,
                   "diet": "graze", "flee_from": ("fox", "wolf"),
                   "flee_range": 3, "flee_cells": 4,
                   "graze_at": 0.12, "graze_take": 0.18, "seek_at": 0.15,
                   "cap": 24, "winterslow": 0.4,
                   "predators": ("fox", "owl", "wolf")},
        "deer":   {"hunger_drain": 0.55, "lifespan": 200, "speed": 2,
                   "scan": 5, "lit_size": 1, "lit_prob": 0.10,
                   "breed_seasons": (0,), "energy_breed": 8.0,
                   "diet": "browse", "browse_hunger": 6,
                   "browse_chance": 0.5, "browse_hp": 1.5,
                   "graze_at": 0.15, "graze_take": 0.12, "seek_at": 0.15,
                   "cap": 10, "winterslow": 0.5},
        "fox":    {"hunt": "rabbit", "hunt_prob": 0.5,
                   "hunting_density_scale": 12.0,
                   "hunt_prob_min": 0.35, "hunger_drain": 0.7,
                   "lifespan": 130, "speed": 3, "scan": 6,
                   "lit_size": 2, "lit_prob": 0.09, "breed_seasons": (0, 2),
                   "energy_breed": 7.0, "cap": 6, "winterslow": 0.6},
        "owl":    {"strike": ("rabbit",), "strike_prob": 0.18,
                   "strike_range": 5, "hunger_drain": 0.5,
                   "lifespan": 160, "speed": 2, "scan": 2,
                   "lit_size": 1, "lit_prob": 0.10,
                   "breed_seasons": (0, 1), "energy_breed": 6.0,
                   "cap": 3, "winterslow": 1.0},
        "robin":  {"hunger_drain": 0.5, "lifespan": 40, "speed": 4,
                   "scan": 3, "lit_size": 3, "lit_prob": 0.30,
                   "breed_seasons": (0, 1), "energy_breed": 5.0,
                   "diet": "glean", "graze_at": 0.2, "graze_take": 0.04,
                   "cap": 14, "winterslow": 0.75, "flyer": True},
        "boar":   {"hunger_drain": 0.5, "lifespan": 140, "speed": 1,
                   "scan": 3, "lit_size": 2, "lit_prob": 0.15,
                   "breed_seasons": (1, 2), "energy_breed": 6.0,
                   "diet": "scavenge",
                   "graze_at": 0.2, "graze_take": 0.15,
                   "cap": 5, "winterslow": 0.7},
        "stag":   {"hunger_drain": 0.55, "lifespan": 200, "speed": 2,
                   "scan": 5, "winterslow": 0.6, "visitor": True},
        "wolf":   {"hunt": "rabbit", "hunt_prob": 0.6,
                   "hunting_density_scale": 12.0, "hunt_prob_min": 0.35,
                   "prey2": "deer", "prey2_prob": 0.3,
                   "hunger_drain": 0.7, "lifespan": 180, "speed": 3,
                   "scan": 7, "winterslow": 1.0, "visitor": True},
    },

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

    "gen": {
        "noise_octaves": 3, "coarse_grid": 6,
        "elev_sigma": 0.35, "fert_sigma": 0.40, "wet_sigma": 0.30,
        "fert_base": 0.35, "fert_spread": 0.9,
        "moist_base": 0.25, "moist_spread": 0.6,
        "water_quantile": 0.06, "rock_quantile": 0.93,
        "near_water_moisture": 0.35,
        "p_tree_base": 0.13, "p_tree_slope": 0.33,
        "p_tree_moisture_min": 0.40, "p_tree_fert_min": 0.35,
        "willow_near_water_prob": 0.45,
        "initial_age_spread": (8, 60),
        "p_berry": 0.07, "grass_base": 0.3, "grass_fert": 0.5,
        "p_fern_shade": 0.5, "fern_scorch_light": 0.85,
        "starting_seedbank": {"pine": 8, "birch": 8, "willow": 4,
                              "berry": 6, "fern": 8},
        "founder_names": 6, "founder_prob": 0.22,
    },

    "pacing": {
        "tick_seconds": {"run": 12.0, "web": 12.0},
        "soul_gap_local": (60, 120),          # wall s between invitations
        "soul_gap_cloud": (40, 80),
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
        "animals.*.hunger_drain": (0.2, 0.5),
        "animals.*.lit_prob": (0.02, 0.6),
        "animals.*.hunt_prob": (0.1, 0.8),
        "plants.*.seed_prob": (0.02, 0.6),
        "plants.*.light_need": (0.1, 0.9),
        "plants.*.storm_fall_old": (0.0, 0.5),
        "weather.rain_prob.2": (0.0, 0.6),      # autumn's rain
        "pop.recolonize_after": (8, 40),
        "pop.robins_return_prob": (0.4, 1.0),
    },
    "review": {"every_weeks": 48, "auto_tune": False},
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