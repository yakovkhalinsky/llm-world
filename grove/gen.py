"""Seeded, deterministic world generation — pure code, no LLM involved.

Builds terrain from smoothed value noise: a pond in the lowest basin, a few
rock outcrops, moisture gradient toward water, and initial populations.
"""

import random

from . import world as W

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


def generate(seed: int, size: int = W.SIZE_DEFAULT) -> dict:
    rng = W.rng_for(seed, 0, "gen")
    st = W.new_state(seed, size)

    elev = _octaves(size, rng, 0.35)
    fert = _octaves(size, rng, 0.4)
    wet = _octaves(size, rng, 0.3)

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
                "fert": round(max(0.05, min(1.0, 0.35 + f * 0.9)), 3),
                "moisture": round(max(0.05, min(1.0, 0.25 + m * 0.6)), 3),
                "grass": 0.0,
                "mushroom": 0,          # ticks of mushroom presence left
                "carcass": 0,           # ticks of carcass presence left
            }
            row.append(cell)
        cells.append(row)

    # normalize elevation to 0..1 for thresholds
    vals = sorted(v for row in elev for v in row)
    q = lambda p: vals[int(p * (len(vals) - 1))]
    e_lo, e_hi = q(0.06), q(0.93)
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
                    cells[y][x]["moisture"] = min(1.0, cells[y][x]["moisture"] + 0.35)

    st["cells"] = cells

    # --- initial plants ---------------------------------------------------
    pid = st["next_id"]
    plants = {}
    species_pool = ("pine", "birch")
    for y in range(size):
        for x in range(size):
            c = cells[y][x]
            if c["terrain"] != "soil":
                continue
            cluster = (elev[y][x] + wet[y][x]) / 2
            p_tree = 0.0
            if c["moisture"] > 0.40 and c["fert"] > 0.35:
                p_tree = 0.13 + 0.33 * (cluster - 0.1)
            if rng.random() < p_tree:
                n_here = rng.choice((1, 1, 2))
                for _ in range(n_here):
                    if sum(1 for q in plants.values()
                           if q["x"] == x and q["y"] == y) >= 3:
                        break
                    sp = rng.choice(("pine", "pine", "birch", "birch"))
                    # willows ring the pond
                    near_water = any(abs(x - wx) + abs(y - wy) <= 2
                                     for wy, wx in
                                     [(yy, xx) for yy in range(size) for xx in range(size)
                                      if cells[yy][xx]["terrain"] == "water"])
                    if near_water and rng.random() < 0.45:
                        sp = "willow"
                    age = rng.randint(8, 60)
                    stage = "mature"
                    if age < W.PLANT_SPECIES[sp]["mature_age"]:
                        stage = "sapling"
                    elif age >= W.PLANT_SPECIES[sp]["old_age"]:
                        stage = "old"
                    plants[str(pid)] = W.new_plant(pid, sp, x, y, stage, age)
                    pid += 1
            elif rng.random() < 0.07 * c["fert"]:
                plants[str(pid)] = W.new_plant(pid, "berry", x, y,
                                               "mature" if rng.random() < 0.6
                                               else "sapling", rng.randint(1, 6))
                pid += 1
            c["grass"] = round(min(1.0, 0.3 + c["fert"] * 0.5 + rng.uniform(-0.2, 0.3)), 3)
    st["plants"] = plants
    st["next_id"] = pid
    st["seedbank"] = {"pine": 8, "birch": 8, "willow": 4,
                      "berry": 6, "fern": 8}

    # ferns take root wherever the young canopy already shades
    from . import sim as S   # local import to reuse shade field
    light = S.build_light(world=st)
    for y in range(size):
        for x in range(size):
            c = cells[y][x]
            if c["terrain"] == "soil" and light[y][x] < 0.55 \
                    and rng.random() < 0.5:
                plants[str(pid)] = W.new_plant(pid, "fern", x, y, "mature",
                                               rng.randint(2, 10))
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
    st["tick"] = 1          # the world is handed over at the close of week 1
    return st