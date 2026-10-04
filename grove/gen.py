"""Seeded, deterministic world generation — pure code, no LLM involved.

Builds terrain from smoothed value noise: a pond in the lowest basin, a few
rock outcrops, moisture gradient toward water, and initial populations.
"""

import random

from . import world as W
from . import rules

_COARSE = 6          # coarse noise grid, upsampled to the world size
_OCTAVES = 3


def _sample(coarse: list, size: int, rng: random.Random, jitter: float) -> list:
    """Bilinearly upsample the coarse grid, then add fine jitter."""
    n = len(coarse)
    grid = []
    for y in range(size):
        row = []
        gy = y * (n - 1) / (size - 1)
        y0 = min(int(gy), n - 2)
        fy = gy - y0
        for x in range(size):
            gx = x * (n - 1) / (size - 1)
            x0 = min(int(gx), n - 2)
            fx = gx - x0
            a = coarse[y0][x0]
            b = coarse[y0][x0 + 1]
            c = coarse[y0 + 1][x0]
            d = coarse[y0 + 1][x0 + 1]
            top = a + (b - a) * fx
            bot = c + (d - c) * fx
            row.append((top + (bot - top) * fy) + rng.uniform(-jitter, jitter))
        grid.append(row)
    return grid


def _octaves(size: int, rng: random.Random, base_jitter: float) -> list:
    total = [[0.0] * size for _ in range(size)]
    amp_total = 0.0
    for o in range(_OCTAVES):
        n = _COARSE + o * 3
        coarse = [[rng.random() for _ in range(n)] for _ in range(n)]
        amp = 1.0 / (o + 1)
        layer = _sample(coarse, size, rng, base_jitter * amp)
        for y in range(size):
            for x in range(size):
                total[y][x] += layer[y][x] * amp
        amp_total += amp
    for y in range(size):
        for x in range(size):
            total[y][x] /= amp_total
    return total


def generate(seed: int, size: int = None) -> dict:
    rng = W.rng_for(seed, 0, "gen")
    size = size or rules.R["world"]["size"]
    gr = rules.R["gen"]
    st = W.new_state(seed, size)

    elev = _octaves(size, rng, gr["elev_sigma"])
    fert = _octaves(size, rng, gr["fert_sigma"])
    wet = _octaves(size, rng, gr["wet_sigma"])

    # --- terrain ---------------------------------------------------------
    lo, hi = 8.4, 9.0  # elev quantiles (value noise lives roughly in 0.15..0.85)
    water_cells, rock_cells = [], []
    cells = []
    for y in range(size):
        row = []
        for x in range(size):
            e, f, m = elev[y][x], fert[y][x], wet[y][x]
            cell = {
                "elev": round(e, 3),
                "fert": round(max(0.05, min(1.0, gr["fert_base"] + f * gr["fert_spread"])), 3),
                "moisture": round(max(0.05, min(1.0, gr["moist_base"] + m * gr["moist_spread"])), 3),
                "grass": 0.0,
                "mushroom": 0,          # ticks of mushroom presence left
                "carcass": 0,           # ticks of carcass presence left
            }
            row.append(cell)
        cells.append(row)

    # normalize elevation to 0..1 for thresholds
    vals = sorted(v for row in elev for v in row)
    q = lambda p: vals[int(p * (len(vals) - 1))]
    e_lo, e_hi = q(gr["water_quantile"]), q(gr["rock_quantile"])
    for y in range(size):
        for x in range(size):
            e = elev[y][x]
            if e <= e_lo:
                cells[y][x]["terrain"] = "water"
                water_cells.append((x, y))
            elif e >= e_hi:
                cells[y][x]["terrain"] = "rock"
                rock_cells.append((x, y))
            else:
                cells[y][x]["terrain"] = "soil"
            cells[y][x]["elev"] = round((e - e_lo) / (e_hi - e_lo + 1e-9), 3)

    # moisture bonus near water
    for wy, wx in [(y, x) for y in range(size) for x in range(size)
                   if cells[y][x]["terrain"] == "water"]:
        for y in range(size):
            for x in range(size):
                if abs(x - wx) + abs(y - wy) <= 2:
                    cells[y][x]["moisture"] = min(1.0, cells[y][x]["moisture"] + gr["near_water_moisture"])

    st["cells"] = cells

    # --- initial plants ---------------------------------------------------
    # the planting recipe is data: the tree pool with its weights, the
    # shore tree, the fruiting shrub and the shade understory
    pool = []
    for sp, wt in gr.get("tree_pool", {"pine": 2, "birch": 2}).items():
        pool += [sp] * int(wt)
    if not pool:
        pool = ["pine", "birch"]
    pid = st["next_id"]
    plants = {}
    for y in range(size):
        for x in range(size):
            c = cells[y][x]
            if c["terrain"] != "soil":
                continue
            cluster = (elev[y][x] + wet[y][x]) / 2
            p_tree = 0.0
            if c["moisture"] > gr["p_tree_moisture_min"] and \
                    c["fert"] > gr["p_tree_fert_min"]:
                p_tree = gr["p_tree_base"] + gr["p_tree_slope"] * \
                    (cluster - 0.1)
            if rng.random() < p_tree:
                n_here = rng.choice((1, 1, 2))
                for _ in range(n_here):
                    if sum(1 for q in plants.values()
                           if q["x"] == x and q["y"] == y) >= 3:
                        break
                    sp = rng.choice(pool)
                    # the shore tree rings the water
                    near_water = any(abs(x - wx) + abs(y - wy) <= 2
                                     for wy, wx in
                                     [(yy, xx) for yy in range(size) for xx in range(size)
                                      if cells[yy][xx]["terrain"] == "water"])
                    if near_water and rng.random() < gr["willow_near_water_prob"]:
                        sp = gr.get("shore_species", "willow")
                    age = rng.randint(*gr["initial_age_spread"])
                    stage = "mature"
                    if age < W.PLANT_SPECIES[sp]["mature_age"]:
                        stage = "sapling"
                    elif age >= W.PLANT_SPECIES[sp]["old_age"]:
                        stage = "old"
                    plants[str(pid)] = W.new_plant(pid, sp, x, y, stage, age)
                    pid += 1
            elif rng.random() < gr["p_berry"] * c["fert"]:
                plants[str(pid)] = W.new_plant(
                    pid, gr.get("shrub_species", "berry"), x, y,
                    "mature" if rng.random() < 0.6 else "sapling",
                    rng.randint(1, 6))
                pid += 1
            c["grass"] = round(min(1.0, gr["grass_base"] + c["fert"] * gr["grass_fert"]
                                  + rng.uniform(-0.2, 0.3)), 3)
    st["plants"] = plants
    st["next_id"] = pid
    st["seedbank"] = dict(gr["starting_seedbank"])

    # ferns take root wherever the young canopy already shades
    from . import sim as S   # local import to reuse shade field
    light = S.build_light(world=st)
    for y in range(size):
        for x in range(size):
            c = cells[y][x]
            if c["terrain"] == "soil" and light[y][x] < 0.55 \
                    and rng.random() < gr["p_fern_shade"]:
                plants[str(pid)] = W.new_plant(
                    pid, gr.get("understory_species", "fern"), x, y,
                    "mature", rng.randint(2, 10))
                pid += 1
    st["next_id"] = pid

    # --- initial animals ---------------------------------------------------
    land = [(x, y) for y in range(size) for x in range(size)
            if cells[y][x]["terrain"] != "water"]
    starts = {"rabbit": 26, "deer": 8, "fox": 4, "owl": 3,
              "robin": 14, "boar": 5}
    animals = {}
    for sp, n in starts.items():
        for _ in range(n):
            x, y = rng.choice(land)
            animals[str(st["next_id"])] = W.new_animal(
                st["next_id"], sp, x, y, rng.uniform(2, 8))
            st["next_id"] += 1
    st["animals"] = animals

    # the founding souls: the grove starts already known to its voice
    from . import voice as V
    named = 0
    for aid, a in sorted(animals.items(), key=lambda kv: int(kv[0])):
        if named >= 6:
            break
        rng2 = W.rng_for(seed, 0, f"founder:{aid}")
        if rng2.random() < 0.22 and named < 6:
            st["names"][aid] = V.fallback_name(list(st["names"].values()),
                                               seed, int(aid))
            named += 1
    st["tick"] = 1          # the world is handed over at the close of week 1
    return st