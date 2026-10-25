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
    gr = rules.R["gen"]
    octaves = gr.get("noise_octaves", _OCTAVES)   # the pack's own hand
    grid0 = gr.get("coarse_grid", _COARSE)
    total = [[0.0] * size for _ in range(size)]
    amp_total = 0.0
    for o in range(octaves):
        n = grid0 + o * 3
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


# ------------------------------------------------------------------ water

def _is_water(cells, x, y):
    return cells[y][x]["terrain"] == "water"


def carve_creek(cells, size, rng, gr):
    """A creek from one edge of the map to the other, down the low ground.

    It runs along x or y (the rng's choice), keeping three cells off the
    side edges, and takes one cell at a time either straight on or one cell
    to the side, preferring the lower ground, so it meanders. Each sideways
    step is two cells, so the water is joined edge to edge (a creature that
    moves diagonally still cannot slip between two of its cells). Every
    `ford_every` cells, on a straight run, a shallow ford is left: soil a
    creature can cross, marked `ford`. Returns the path, fords included,
    from the source edge to the mouth."""
    horiz = rng.random() < 0.5
    lo, hi = 3, size - 4

    def xy(a, b):
        return (a, b) if horiz else (b, a)

    def elev(a, b):
        x, y = xy(a, b)
        return cells[y][x]["elev"]

    wiggle = gr.get("creek_wiggle", 0.25)
    b = min(range(lo, hi + 1),
            key=lambda bb: elev(0, bb) + rng.random() * wiggle)
    path = [xy(0, b)]
    for a in range(1, size):
        cands = [bb for bb in (b - 1, b, b + 1) if lo <= bb <= hi]
        nb = min(cands, key=lambda bb: elev(a, bb) + abs(bb - b) * 0.04
                 + rng.random() * wiggle)
        if nb != b:
            path.append(xy(a, b))
        path.append(xy(a, nb))
        b = nb
    every = max(3, int(gr.get("ford_every", 6)))
    fords = set()
    i = rng.randint(2, every)
    while i < len(path) - 2:
        # a ford sits on a straight run, so the crossing is square to it
        j = i
        while j < len(path) - 2:
            (x0, y0), (x1, y1), (x2, y2) = path[j - 1], path[j], path[j + 1]
            if x0 - x1 == x1 - x2 and y0 - y1 == y1 - y2:
                break
            j += 1
        if j >= len(path) - 2:
            break
        fords.add(j)
        i = j + every
    for k, (x, y) in enumerate(path):
        c = cells[y][x]
        if k in fords:
            c["terrain"] = "soil"
            c["ford"] = True
            c.pop("water", None)    # it may have been a low, pond cell
            c["elev"] = 0.02
        else:
            c["terrain"] = "water"
            c["water"] = "creek"
            c["elev"] = min(c["elev"], 0.0)
    # the creek lies in its own little valley: the banks come down to it
    on = set(path)
    for x, y in path:
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if (nx, ny) in on or not W.in_bounds(size, nx, ny):
                continue
            c = cells[ny][nx]
            if c["terrain"] != "water":
                c["elev"] = round(max(0.03, c["elev"] * 0.55), 3)
                if c["terrain"] == "rock":
                    c["terrain"] = "soil"
    return path


def dig_pond(cells, size, rng, gr):
    """A still pond in a low spot, away from the creek, the edge and the
    other ponds: a rough disc of water one or two cells across."""
    creek = [(x, y) for y in range(size) for x in range(size)
             if cells[y][x].get("water") == "creek"
             or cells[y][x].get("ford")]
    ponds = [(x, y) for y in range(size) for x in range(size)
             if cells[y][x].get("water") == "pond"]
    r_lo, r_hi = gr.get("pond_radius", (1.3, 2.3))
    r = r_lo + (r_hi - r_lo) * rng.random()
    best = None
    for gap in (4, 3, 2):
        for y in range(3, size - 3):
            for x in range(3, size - 3):
                if any(max(abs(x - cx), abs(y - cy)) < gap + int(r)
                       for cx, cy in creek):
                    continue
                if any(max(abs(x - px), abs(y - py)) < 5 for px, py in ponds):
                    continue
                score = cells[y][x]["elev"] + rng.random() * 0.2
                if best is None or score < best[0]:
                    best = (score, x, y)
        if best:
            break
    if best is None:
        return None
    _, px, py = best
    for y in range(max(0, py - 3), min(size, py + 4)):
        for x in range(max(0, px - 3), min(size, px + 4)):
            d = ((x - px) ** 2 + (y - py) ** 2) ** 0.5
            # a ragged shore: the rim cells are hashed in or out
            if d <= r - 0.5 or (d <= r + 0.4 and rng.random() < 0.55):
                c = cells[y][x]
                if c.get("water") == "creek" or c.get("ford"):
                    continue
                c["terrain"] = "water"
                c["water"] = "pond"
                c["elev"] = min(c["elev"], 0.0)
    return (px, py)


def land_parts(cells, size):
    """The land, in pieces a walking creature cannot leave: every cell that
    is not water, joined to its eight neighbours (the creatures step
    diagonally). Largest piece first, then by its first cell."""
    seen = [[False] * size for _ in range(size)]
    parts = []
    for y in range(size):
        for x in range(size):
            if seen[y][x] or _is_water(cells, x, y):
                continue
            part, todo = [], [(x, y)]
            seen[y][x] = True
            while todo:
                cx, cy = todo.pop()
                part.append((cx, cy))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        nx, ny = cx + dx, cy + dy
                        if (dx or dy) and W.in_bounds(size, nx, ny) and \
                                not seen[ny][nx] and \
                                not _is_water(cells, nx, ny):
                            seen[ny][nx] = True
                            todo.append((nx, ny))
            parts.append(sorted(part, key=lambda p: (p[1], p[0])))
    parts.sort(key=lambda p: (-len(p), p[0][1], p[0][0]))
    return parts


def join_land(cells, size):
    """Ford the water until the land is one piece: from each cut-off piece,
    the shortest way across the water (4-connected, in a fixed order) to
    the rest of the land becomes shallow ford."""
    from collections import deque
    for _ in range(size * size):
        parts = land_parts(cells, size)
        if len(parts) <= 1:
            return
        main = set(parts[0])
        src = parts[-1]
        prev = {p: None for p in src}
        q = deque(src)
        hit = None
        while q and hit is None:
            cx, cy = q.popleft()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                n = (cx + dx, cy + dy)
                if n in prev or not W.in_bounds(size, *n):
                    continue
                prev[n] = (cx, cy)
                if n in main:
                    hit = n
                    break
                if _is_water(cells, *n):
                    q.append(n)
        if hit is None:
            return
        p = prev[hit]
        while p is not None and _is_water(cells, *p):
            c = cells[p[1]][p[0]]
            c["terrain"] = "soil"
            c["ford"] = True
            c.pop("water", None)
            c["elev"] = 0.02
            p = prev[p]


def generate(seed: int, size: int = None, biome: str = None) -> dict:
    rng = W.rng_for(seed, 0, "gen")
    size = size or rules.R["world"]["size"]
    gr = rules.R["gen"]
    st = W.new_state(seed, size)
    if biome:
        rules.select_biome(biome)
    st["biome"] = rules.active_biome()

    elev = _octaves(size, rng, gr["elev_sigma"])
    fert = _octaves(size, rng, gr["fert_sigma"])
    wet = _octaves(size, rng, gr["wet_sigma"])

    # --- terrain ---------------------------------------------------------
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
                if gr.get("creeks", 0) or gr.get("ponds"):
                    cells[y][x]["water"] = "pond"
                water_cells.append((x, y))
            elif e >= e_hi:
                cells[y][x]["terrain"] = "rock"
                rock_cells.append((x, y))
            else:
                cells[y][x]["terrain"] = "soil"
            cells[y][x]["elev"] = round((e - e_lo) / (e_hi - e_lo + 1e-9), 3)

    # --- running and standing water ----------------------------------------
    # a pack that asks for them gets a creek across the whole map and one or
    # more ponds on every seed, then the land is joined back up with fords
    # wherever the water cut a piece of it off (the desert asks for none)
    if gr.get("creeks", 0) or gr.get("ponds"):
        st["creeks"] = []
        wrng = W.rng_for(seed, 0, "water")
        for _ in range(int(gr.get("creeks", 0))):
            path = carve_creek(cells, size, wrng, gr)
            st["creeks"].append([[x, y] for x, y in path])
        lo, hi = gr.get("ponds", (0, 0))
        for _ in range(wrng.randint(int(lo), int(hi))):
            dig_pond(cells, size, wrng, gr)
        join_land(cells, size)
        water_cells = [(x, y) for y in range(size) for x in range(size)
                       if cells[y][x]["terrain"] == "water"]
        rock_cells = [(x, y) for y in range(size) for x in range(size)
                      if cells[y][x]["terrain"] == "rock"]

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
            if c["terrain"] != "soil" or c.get("ford"):
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
    starts = dict(gr.get("starting_animals",
                         {"rabbit": 26, "deer": 8, "fox": 4, "owl": 3,
                          "robin": 14, "boar": 5}))
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
    limit = gr.get("founder_names", 6)
    prob = gr.get("founder_prob", 0.22)
    named = 0
    for aid, a in sorted(animals.items(), key=lambda kv: int(kv[0])):
        if named >= limit:
            break
        rng2 = W.rng_for(seed, 0, f"founder:{aid}")
        if rng2.random() < prob and named < limit:
            st["names"][aid] = V.fallback_name(list(st["names"].values()),
                                               seed, int(aid))
            named += 1
    st["tick"] = 1          # the world is handed over at the close of week 1
    return st