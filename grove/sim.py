"""The tick engine: weather, soil, plants, animals — all deterministic.

One tick is one week. Everything the LLM does arrives through
`world["pending_effect"]` (op events) and `world["effects"]` (ongoing
weather-scapes like drought/blight); the engine applies and validates.
"""

from . import world as W

# ------------------------------------------------------------- tuning knobs

GRASS_REGROW = {0: 0.06, 1: 0.07, 2: 0.03, 3: 0.0}
MOISTURE_DECAY = {0: 0.97, 1: 0.955, 2: 0.975, 3: 1.0}   # per season
RAIN_GAIN = 0.22
STORM_GAIN = 0.28
WINTER_DRAIN = 1.4

NATURAL_STORM_PROB = {2: 0.05}                            # autumn only
RAIN_PROB = {0: 0.22, 1: 0.10, 2: 0.28, 3: 0.0}

LOG_TTL = 5          # weeks a fallen tree lingers
CARCASS_TTL = 3
RECOLONIZE_AFTER = 16
BASE_RESIDENTS = ("rabbit", "deer", "fox", "owl", "robin", "boar")


# ------------------------------------------------------------------ weather

def _roll_weather(w, evs):
    t = w["tick"]
    rng = W.rng_for(w["seed"], t, "weather")
    season = W.season_index(t)
    if w["weather_left"] > 0:
        w["weather_left"] -= 1
        if w["weather_left"] == 0:
            w["weather"] = "clear"
        return
    if season == 3:
        if w["weather"] != "frost":
            w["weather"] = "frost"
        return
    r = rng.random()
    storm_p = NATURAL_STORM_PROB.get(season, 0.0)
    if r < storm_p:
        w["weather"], w["weather_left"] = "storm", 2
        evs.append({"tick": t, "kind": "storm", "x": None, "y": None,
                    "note": "natural"})
    elif r < storm_p + RAIN_PROB[season]:
        w["weather"], w["weather_left"] = "rain", 1
    else:
        w["weather"] = "clear"


# -------------------------------------------------------------------- light

def build_light(world):
    """light[y][x] in 0..1 after canopy shading."""
    size = world["size"]
    shade = [[0.0] * size for _ in range(size)]
    for p in world["plants"].values():
        if p["stage"] in ("seed", "log"):
            continue
        spec = W.PLANT_SPECIES[p["sp"]]
        if p["stage"] == "mature" or p["stage"] == "old":
            self_s, adj_s = spec.get("shade_self", 0), spec.get(
                "shade_adjacent", 0)
        else:   # sapling
            self_s, adj_s = 0.15, 0.05
        if self_s <= 0:
            continue
        x, y = p["x"], p["y"]
        shade[y][x] += self_s
        for ny in (y - 1, y + 1):
            for nx in (x - 1, x + 1):
                if W.in_bounds(size, nx, ny):
                    shade[ny][nx] += adj_s
    return [[max(0.0, 1.0 - min(1.0, shade[y][x])) for x in range(size)]
            for y in range(size)]


# -------------------------------------------------------------------- cells

def _update_cells(w, evs):
    size, t = w["size"], w["tick"]
    rng = W.rng_for(w["seed"], t, "cells")
    season = W.season_index(t)
    weather = w["weather"]
    droughts = [e for e in w["effects"] if e["kind"] == "drought"]
    blights = [e for e in w["effects"] if e["kind"] == "blight"]
    # the sky remembers: a run of rainy weeks soaks the ground
    w["wet_streak"] = (w.get("wet_streak", 0) + 1
                       if weather in ("rain", "storm") else 0)
    soak = min(2.0, w.get("wet_streak", 0) * 0.4)

    for y in range(size):
        for x in range(size):
            c = w["cells"][y][x]
            if c["terrain"] == "water":
                c["moisture"] = 1.0
                c["grass"] = 0.0
                continue
            m = c["moisture"]
            if weather == "rain":
                m += RAIN_GAIN
            elif weather == "storm":
                m += STORM_GAIN
            m *= MOISTURE_DECAY[season]
            for e in droughts:
                if (x, y) in _region_set(e["region"], size):
                    m -= 0.09
            c["moisture"] = _clamp01(m)

            # grass
            regrow = GRASS_REGROW[season] * (1.0 + soak * 0.15)
            if any((x, y) in _region_set(e["region"], size) for e in droughts):
                regrow *= 0.2
            light = w["_light"][y][x]
            if regrow and weather != "frost" and c["moisture"] > 0.12 \
                    and light > 0.30:
                c["grass"] = _clamp01(c["grass"] + regrow)
            if weather == "frost":
                c["grass"] *= 0.93

            # mushrooms: they favor humus, and boom after days of rain
            if c["mushroom"] > 0:
                c["mushroom"] -= 1
            elif weather in ("rain", "storm") and \
                    (c["grass"] > 0.25 or c.get("humus", 0) > 0.3):
                p_mush = 0.08 * (1.0 + soak)
                if c.get("humus", 0) > 0.3:
                    p_mush *= 2.5
                if rng.random() < p_mush:
                    c["mushroom"] = 3

            if c["carcass"] > 0:
                c["carcass"] -= 1


def _region_set(region, size):
    return set(W.region_cells(size, region)) if region != "all" else None


def _clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def _clamp01(v):
    return max(0.0, min(1.0, v))


# ------------------------------------------------------------------- plants

def _update_plants(w, evs, light):
    size, t = w["size"], w["tick"]
    rng = W.rng_for(w["seed"], t, "plants")
    season = W.season_index(t)
    week_in = (t - 1) % W.WEEKS_PER_SEASON + 1
    winter = season == 3
    growing = not winter
    blights = [e for e in w["effects"] if e["kind"] == "blight"]
    droughts = [e for e in w["effects"] if e["kind"] == "drought"]
    fallen = []

    for pid, p in list(w["plants"].items()):
        spec = W.PLANT_SPECIES[p["sp"]]

        if p["stage"] == "log":
            p["log"] = p.get("log", LOG_TTL) - 1
            if p["log"] <= 0:
                # the trunk is gone to humus; the soil remembers the tree
                c2 = w["cells"][p["y"]][p["x"]]
                c2["humus"] = min(1.0, c2.get("humus", 0) + 0.25)
                del w["plants"][pid]
            continue

        c = w["cells"][p["y"]][p["x"]]
        li = light[p["y"]][p["x"]]
        p["age"] += 1
        damaged = False

        # blight / drought pressure
        for e in blights:
            region = _region_set(e["region"], size)
            if (region is None or (p["x"], p["y"]) in region) and \
                    (e.get("species") in (None, p["sp"])):
                mult = 1.6 if p["sp"] in ("fern", "birch") else 1.0
                p["hp"] -= 1.2 * mult
                damaged = True
        for e in droughts:
            region = _region_set(e["region"], size)
            if (region is None or (p["x"], p["y"]) in region) \
                    and c["moisture"] < 0.12:
                p["hp"] -= 0.5
                damaged = True

        # weather stress
        if w["weather"] == "frost":
            if spec["frost_hp"]:
                p["hp"] -= spec["frost_hp"]
                damaged = True
        if w["weather"] == "storm":
            base = (spec["storm_fall_old"] if p["stage"] == "old"
                    else spec["storm_fall_mature"]
                    if p["stage"] == "mature"
                    else spec["storm_fall_mature"] * 0.5)
            if rng.random() < base:
                _fell(w, p, evs, "storm")
                fallen.append(pid)
                continue

        # growth
        if p["stage"] == "sapling":
            ok = (spec["light_need"] <= li) if p["sp"] != "fern" \
                else (li < spec["light_need"] * 1.2)
            if growing and c["moisture"] > 0.12 and \
                    p["age"] >= spec["mature_age"] and ok and p["hp"] > 4:
                p["stage"] = "mature"
        elif p["stage"] == "mature" and p["age"] >= spec["old_age"]:
            p["stage"] = "old"
        if p["stage"] == "old" and spec["kind"] == "tree" \
                and p["id"] not in w["elder_ids"]:
            w["elder_ids"].append(p["id"])
            evs.append({"tick": t, "kind": "elder", "plant": pid,
                        "sp": p["sp"], "x": p["x"], "y": p["y"],
                        "age": p["age"]})

        # ferns scorch in full sun
        if p["sp"] == "fern" and li > 0.75:
            p["hp"] -= 0.6
            damaged = True

        # berry fruiting
        if p["sp"] == "berry" and p["stage"] in ("mature", "old") \
                and season == 0 and week_in == 1 and rng.random() < 0.8:
            p["berries"] = True

        # recover or die — rot feeds the ground beneath a log
        if not damaged and growing and c["moisture"] > 0.10:
            p["hp"] = min(10.0, p["hp"] + 0.4 + c.get("humus", 0) * 0.2)
        if p["hp"] <= 0:
            cause = "blight" if any(blights) else \
                ("drought" if any(droughts) else "withered")
            _fell(w, p, evs, cause)
            continue
        if p["age"] >= spec["max_age"]:
            _fell(w, p, evs, "age")
            continue

        # reproduction
        if spec["kind"] == "tree" and p["stage"] in ("mature", "old") \
                and season == spec["seed_season"] \
                and rng.random() < spec["seed_prob"]:
            _seed(w, p, spec, light, rng)
        if p["sp"] == "fern" and p["stage"] == "mature" and growing \
                and rng.random() < spec.get("spread_prob", 0):
            _spread_fern(w, p, spec, light, rng)
        if p["sp"] == "berry" and p["stage"] in ("mature", "old") \
                and season == spec["seed_season"] \
                and rng.random() < spec["seed_prob"]:
            _seed(w, p, spec, light, rng)


def _fell(w, p, evs, cause):
    p["stage"] = "log"
    p["log"] = LOG_TTL
    evs.append({"tick": w["tick"], "kind": "fell", "plant": p["id"],
                "sp": p["sp"], "x": p["x"], "y": p["y"], "cause": cause,
                "age": p["age"], "name": p["name"]})


def _seed(w, p, spec, light, rng):
    size = w["size"]
    r = spec["seed_radius"]
    for _ in range(3):
        sx = p["x"] + rng.randint(-r, r)
        sy = p["y"] + rng.randint(-r, r)
        if not W.in_bounds(size, sx, sy):
            continue
        c = w["cells"][sy][sx]
        if c["terrain"] != "soil":
            continue
        if spec.get("near_water") and not _near_water(w, sx, sy,
                                                      spec["near_water"]):
            continue
        if light[sy][sx] < spec["light_need"] * 0.8:
            continue
        if _plants_in_cell(w, sx, sy) >= 3:
            continue
        w["plants"][str(w["next_id"])] = W.new_plant(
            w["next_id"], p["sp"], sx, sy, "sapling", 0)
        w["next_id"] += 1
        return


def _spread_fern(w, p, spec, light, rng):
    size = w["size"]
    sy = p["y"] + rng.randint(-1, 1)
    sx = p["x"] + rng.randint(-1, 1)
    if not W.in_bounds(size, sx, sy):
        return
    c = w["cells"][sy][sx]
    if c["terrain"] != "soil" or light[sy][sx] >= spec["light_need"] * 1.2:
        return
    if _plants_in_cell(w, sx, sy) >= 3:
        return
    w["plants"][str(w["next_id"])] = W.new_plant(
        w["next_id"], "fern", sx, sy, "sapling", 0)
    w["next_id"] += 1


def _plants_in_cell(w, x, y):
    return sum(1 for p in w["plants"].values()
               if p["x"] == x and p["y"] == y and p["stage"] != "log")


def _near_water(w, x, y, d):
    size = w["size"]
    for ny in range(max(0, y - d), min(size, y + d + 1)):
        for nx in range(max(0, x - d), min(size, x + d + 1)):
            if w["cells"][ny][nx]["terrain"] == "water":
                return True
    return False


# ------------------------------------------------------------------ animals

def _update_animals(w, evs):
    t = w["tick"]
    size = w["size"]
    season = W.season_index(t)
    winter = season == 3
    rng = W.rng_for(w["seed"], t, "animals")

    for aid, a in list(w["animals"].items()):
        if w["animals"].get(aid) is not a:
            continue    # died earlier this week (as prey) — skip its turn
        spec = W.ANIMAL_SPECIES[a["sp"]]
        if a["transient"] is not None:
            a["transient"] -= 1
            if a["transient"] <= 0:
                evs.append({"tick": t, "kind": "departure", "sp": a["sp"],
                            "x": a["x"], "y": a["y"], "who": a["sp"]})
                del w["animals"][aid]
                continue

        drain = spec["hunger_drain"] * (WINTER_DRAIN if winter else 1.0)
        a["hunger"] += drain
        if a["hunger"] > 9:
            a["hp"] -= 0.5
        if a["hp"] <= 0:
            w["cells"][a["y"]][a["x"]]["carcass"] = CARCASS_TTL
            evs.append({"tick": t, "kind": "starve", "sp": a["sp"],
                        "x": a["x"], "y": a["y"]})
            del w["animals"][aid]
            continue

        _behave(w, a, spec, evs, rng, winter)

        # reproduction
        cap = spec.get("cap", 100)
        pop = _pop(w, a["sp"])
        if not winter and a["preg"] == 0 \
                and a["energy"] >= spec.get("energy_breed", 99) \
                and season in spec.get("breed_seasons", ()) \
                and spec.get("lit_prob") and pop < cap \
                and rng.random() < spec["lit_prob"]:
            a["preg"] = 2
        if a["preg"] > 0:
            a["preg"] -= 1
            if a["preg"] == 0:
                a["energy"] = max(0.0, a["energy"] - 4.0)
                _litter(w, a, spec, evs, rng, cap)

        # aging
        a["age"] += 1
        if a["age"] >= spec["lifespan"]:
            w["cells"][a["y"]][a["x"]]["carcass"] = CARCASS_TTL
            evs.append({"tick": t, "kind": "oldage", "sp": a["sp"],
                        "x": a["x"], "y": a["y"]})
            del w["animals"][aid]
            continue


def _behave(w, a, spec, evs, rng, winter):
    t = w["tick"]
    size = w["size"]
    c0 = w["cells"][a["y"]][a["x"]]
    speed = spec["speed"]
    if winter and rng.random() > spec.get("winterslow", 1.0):
        speed = 0
    ate = False

    # -- predators ------------------------------------------------------
    hunt = spec.get("hunt")
    if hunt:
        prey = _nearest(w, a["x"], a["y"], hunt, spec["scan"])
        # density-dependent hunting: when the warren is thin, predators
        # miss more — the classic loop that keeps boom-bust from collapsing
        hp_scaled = spec.get("hunt_prob", 0.5) * \
            _clamp(_pop(w, hunt) / 30.0, 0.35, 1.0)
        if prey and rng.random() < hp_scaled:
            step_toward(w, a, prey["x"], prey["y"], speed, spec.get("flyer"))
            dist = abs(a["x"] - prey["x"]) + abs(a["y"] - prey["y"])
            if dist <= 1 and rng.random() < 0.5:
                prey_id = next(pid for pid, q in w["animals"].items() if q is prey)
                _kill(w, a, prey_id, prey, evs)
                ate = True
        elif not prey:
            _wander(w, a, speed, spec.get("flyer"), rng)

        # secondary prey (the passing wolf will take a stag if lucky)
        p2 = spec.get("prey2")
        if p2 and a["hunger"] > 3:
            big = _nearest(w, a["x"], a["y"], p2, spec["scan"])
            if big and rng.random() < spec.get("prey2_prob", 0.0):
                dist = abs(a["x"] - big["x"]) + abs(a["y"] - big["y"])
                if dist <= 1:
                    big_id = next(pid for pid, q in w["animals"].items()
                                  if q is big)
                    _kill(w, a, big_id, big, evs)
        return False

    strike = spec.get("strike")
    if strike and a["hunger"] > 4:
        for sp in strike:
            prey = _nearest(w, a["x"], a["y"], sp, spec.get("strike_range", 4))
            if prey and rng.random() < spec.get("strike_prob", 0.07):
                prey_id = next(pid for pid, q in w["animals"].items() if q is prey)
                _kill(w, a, prey_id, prey, evs)
                ate = True
                break

    # -- herbivores / omnivores -----------------------------------------
    if a["sp"] == "rabbit":
        # something with teeth nearby? scatter.
        threat = next((q for q in w["animals"].values()
                       if q["sp"] in ("fox", "wolf")
                       and abs(q["x"] - a["x"]) + abs(q["y"] - a["y"]) <= 3),
                      None)
        if threat:
            px = max(-1, min(1, a["x"] - threat["x"]))
            py = max(-1, min(1, a["y"] - threat["y"]))
            saved = (a["x"], a["y"])
            step_toward(w, a, a["x"] + px * 4, a["y"] + py * 4, speed,
                        spec.get("flyer"))
            if (a["x"], a["y"]) == saved:
                _wander(w, a, speed, spec.get("flyer"), rng)
            return False
        if c0["grass"] >= 0.12:
            c0["grass"] -= 0.18
            ate = True
        else:
            tgt = _nearest_grass(w, a["x"], a["y"], 0.15, spec["scan"])
            _move_to(w, a, tgt, speed, spec.get("flyer"))
    elif a["sp"] == "deer":
        sap = _nearest_sapling(w, a["x"], a["y"], spec["scan"])
        if sap is not None and a["hunger"] > 6 and rng.random() < 0.5:
            sap["hp"] -= 1.5
            evs.append({"tick": t, "kind": "browsed", "plant": sap["id"],
                        "sp": sap["sp"], "x": sap["x"], "y": sap["y"]})
            ate = True
        elif c0["grass"] >= 0.15:
            c0["grass"] -= 0.12
            ate = True
        else:
            tgt = _nearest_grass(w, a["x"], a["y"], 0.15, spec["scan"])
            _move_to(w, a, tgt, speed, spec.get("flyer"))
    elif a["sp"] == "robin":
        bush = _berry_here(w, a["x"], a["y"])
        if bush:
            bush["berries"] = False
            bush["hp"] = max(0.5, bush["hp"] - 1.0)
            evs.append({"tick": t, "kind": "picked", "plant": bush["id"],
                        "sp": bush["sp"], "x": bush["x"], "y": bush["y"]})
            ate = True
        elif c0["mushroom"]:
            c0["mushroom"] = 0
            ate = True
        elif c0["grass"] >= 0.2:
            c0["grass"] -= 0.04
            ate = True
        else:
            tgt = _nearest_food(w, a["x"], a["y"], spec["scan"])
            _move_to(w, a, tgt, speed, spec.get("flyer"))
    elif a["sp"] == "boar":
        if c0["mushroom"]:
            c0["mushroom"] = 0
            ate = True
        elif c0["carcass"]:
            c0["carcass"] = 0
            ate = True
        elif c0["grass"] >= 0.2:
            c0["grass"] -= 0.15
            ate = True
        else:
            tgt = _nearest_food(w, a["x"], a["y"], spec["scan"])
            _move_to(w, a, tgt, speed, spec.get("flyer"))

    if ate:
        a["hunger"] = max(0.0, a["hunger"] - 7.0)
        a["energy"] = min(10.0, a["energy"] + 2.0)
        a["hp"] = min(10.0, a["hp"] + 0.6)
    elif speed:
        _wander(w, a, speed, spec.get("flyer"), rng)
    return ate


def _litter(w, mother, spec, evs, rng, cap):
    t = w["tick"]
    size = w["size"]
    n = spec.get("lit_size", 1)
    kids = []
    for _ in range(n):
        if _pop(w, mother["sp"]) >= cap:
            break
        dx, dy = rng.randint(-1, 1), rng.randint(-1, 1)
        x, y = mother["x"] + dx, mother["y"] + dy
        if not W.in_bounds(size, x, y) or \
                w["cells"][y][x]["terrain"] == "water":
            x, y = mother["x"], mother["y"]
        w["animals"][str(w["next_id"])] = W.new_animal(
            w["next_id"], mother["sp"], x, y, 0)
        kids.append(w["next_id"])
        w["next_id"] += 1
    evs.append({"tick": t, "kind": "birth", "sp": mother["sp"],
                "x": mother["x"], "y": mother["y"], "n": len(kids),
                "kids": kids})
    # newborns wait in the pool until the voice (naming) picks them up
    pool = w.setdefault("name_pool", [])
    pool.extend(kids)
    while len(pool) > 8:
        pool.pop(0)


def _kill(w, predator, prey_id, prey, evs):
    t = w["tick"]
    evs.append({"tick": t, "kind": "predation", "hunter": predator["sp"],
                "sp": prey["sp"], "x": prey["x"], "y": prey["y"]})
    predator["hunger"] = max(0.0, predator["hunger"] - 9.0)
    predator["energy"] = min(10.0, predator["energy"] + 3.0)
    predator["hp"] = min(10.0, predator["hp"] + 1.0)
    del w["animals"][prey_id]


# ------------------------------------------------------------- movement etc

def step_toward(w, a, tx, ty, speed, flyer):
    size = w["size"]
    for _ in range(speed):
        dx = (tx > a["x"]) - (tx < a["x"])
        dy = (ty > a["y"]) - (ty < a["y"])
        cands = []
        if dx:
            cands.append((a["x"] + dx, a["y"]))
        if dy:
            cands.append((a["x"], a["y"] + dy))
        if dx and dy:
            cands.append((a["x"] + dx, a["y"] + dy))
        for cx, cy in cands:
            if W.in_bounds(size, cx, cy) and \
                    (flyer or w["cells"][cy][cx]["terrain"] != "water"):
                a["x"], a["y"] = cx, cy
                break
        else:
            break
        if a["x"] == tx and a["y"] == ty:
            break


def _wander(w, a, speed, flyer, rng):
    size = w["size"]
    for _ in range(speed):
        dx, dy = rng.randint(-1, 1), rng.randint(-1, 1)
        nx, ny = a["x"] + dx, a["y"] + dy
        if W.in_bounds(size, nx, ny) and \
                (flyer or w["cells"][ny][nx]["terrain"] != "water"):
            a["x"], a["y"] = nx, ny


def _move_to(w, a, target, speed, flyer):
    if target is None:
        return
    step_toward(w, a, target[0], target[1], speed, flyer)


def _nearest(w, x, y, sp, radius):
    best, bd = None, radius + 1
    for q in w["animals"].values():
        if q["sp"] != sp:
            continue
        d = abs(q["x"] - x) + abs(q["y"] - y)
        if d <= radius and d < bd:
            best, bd = q, d
    return best


def _nearest_grass(w, x, y, threshold, radius):
    size = w["size"]
    best, bd = None, radius + 1
    for ny in range(max(0, y - radius), min(size, y + radius + 1)):
        for nx in range(max(0, x - radius), min(size, x + radius + 1)):
            d = abs(nx - x) + abs(ny - y)
            if d < bd and w["cells"][ny][nx]["terrain"] == "soil" \
                    and w["cells"][ny][nx]["grass"] >= threshold:
                best, bd = (nx, ny), d
    return best


def _nearest_sapling(w, x, y, radius):
    best, bd = None, radius + 1
    for p in w["plants"].values():
        if p["stage"] != "sapling" or not W.PLANT_SPECIES[p["sp"]][
                "kind"] == "tree":
            continue
        d = abs(p["x"] - x) + abs(p["y"] - y)
        if d <= radius and d < bd:
            best, bd = p, d
    return best


def _berry_here(w, x, y):
    for p in w["plants"].values():
        if p["x"] == x and p["y"] == y and p["sp"] == "berry" \
                and p.get("berries") and p["stage"] != "log":
            return p
    return None


def _nearest_food(w, x, y, radius):
    """Mushroom / carcass / berry bush within radius."""
    best, bd = None, radius + 1
    for ny in range(max(0, y - radius), min(w["size"], y + radius + 1)):
        for nx in range(max(0, x - radius), min(w["size"], x + radius + 1)):
            c = w["cells"][ny][nx]
            score = (1 if c["mushroom"] else 0) + (2 if c["carcass"] else 0)
            if score:
                d = abs(nx - x) + abs(ny - y)
                if d < bd:
                    best, bd = (nx, ny), d
    if best is None:
        bush = None
        bd = radius + 1
        for p in w["plants"].values():
            if p["sp"] == "berry" and p.get("berries") and p["stage"] != "log":
                d = abs(p["x"] - x) + abs(p["y"] - y)
                if d <= radius and d < bd:
                    bush = (p["x"], p["y"])
                    bd = d
        best = bush
    return best


def _pop(w, sp):
    return sum(1 for a in w["animals"].values() if a["sp"] == sp)


# --------------------------------------------------------------- population

def _check_destinies(w, evs):
    """The soul's promises are watched deterministically: by water or
    by age; a death ends the watch unheard."""
    t = w["tick"]
    for d in list(w.get("destinies", [])):
        a = w["animals"].get(str(d["id"]))
        if a is None or a["sp"] != d["sp"]:
            w["destinies"].remove(d)
            evs.append({"tick": t, "kind": "destiny_lost", "sp": d["sp"],
                        "destiny": d["text"]})
            continue
        hit = _near_water(w, a["x"], a["y"], 1) if d["kind"] == "water" \
            else a["age"] >= W.ANIMAL_SPECIES[d["sp"]]["lifespan"] * 0.4
        if hit:
            w["destinies"].remove(d)
            evs.append({"tick": t, "kind": "destiny", "sp": a["sp"],
                        "x": a["x"], "y": a["y"],
                        "name": w["names"].get(str(a["id"])),
                        "destiny": d["text"]})


def _recolonize(w, evs):
    t = w["tick"]
    size = w["size"]
    for sp in BASE_RESIDENTS:
        n = _pop(w, sp)
        if n == 0:
            since = w["absent"].setdefault(sp, t)
            if t - since >= RECOLONIZE_AFTER:
                edges = [(x, y) for y in range(size) for x in range(size)
                         if w["cells"][y][x]["terrain"] == "soil"
                         and (x in (0, size - 1) or y in (0, size - 1))]
                if edges:
                    rng = W.rng_for(w["seed"], t, f"recol:{sp}")
                    n_new = 4 if sp in ("rabbit", "robin") else 2
                    for _ in range(n_new):
                        x, y = rng.choice(edges)
                        w["animals"][str(w["next_id"])] = W.new_animal(
                            w["next_id"], sp, x, y, 3)
                        w["next_id"] += 1
                    w["absent"].pop(sp, None)
                    evs.append({"tick": t, "kind": "recolonize", "sp": sp,
                                "n": n_new})
        else:
            w["absent"].pop(sp, None)


def _migration(w, evs, from_season, to_season):
    """Robins leave with the cold and return with the spring."""
    if to_season == 3:                       # into winter
        n = _pop(w, "robin")
        if n == 0:
            return
        w["robin_last"] = n
        for aid, a in list(w["animals"].items()):
            if a["sp"] == "robin":
                del w["animals"][aid]
        evs.append({"tick": w["tick"], "kind": "robins_left", "n": n})
    elif to_season == 0 and from_season == 3:   # back for spring
        rng = W.rng_for(w["seed"], w["tick"], "return")
        last = w.get("robin_last", 0)
        if last > 0 and rng.random() < 0.75:
            size, n_back = w["size"], max(4, last // 2)
            spots = [(x, y) for y in range(size) for x in range(size)
                     if w["cells"][y][x]["terrain"] == "soil"]
            for _ in range(min(n_back, 30)):
                x, y = rng.choice(spots)
                w["animals"][str(w["next_id"])] = W.new_animal(
                    w["next_id"], "robin", x, y, 1)
                w["next_id"] += 1
            evs.append({"tick": w["tick"], "kind": "robins_return",
                        "n": n_back})
            w["absent"].pop("robin", None)


# --------------------------------------------------------------- entrypoint

def tick(world):
    """Advance one week. Returns the week's events (all kinds)."""
    evs = []

    world["tick"] += 1
    t = world["tick"]
    prev_season = W.season_index(t - 1)
    new_season = W.season_index(t)
    if new_season != prev_season:
        evs.append({"tick": t, "kind": "turn", "season": new_season})
        world["fawns_named"] = 0
        _migration(w=world, evs=evs, from_season=prev_season,
                   to_season=new_season)

    # queued operator decision lands at the tick boundary
    if world.get("pending_effect"):
        effect = world["pending_effect"]
        world["pending_effect"] = None
        _apply_effect(world, effect, evs)

    _roll_weather(world, evs)
    world["_light"] = build_light(world)
    _update_cells(world, evs)
    _update_plants(world, evs, world.pop("_light"))
    _update_animals(world, evs)
    _check_destinies(world, evs)
    _recolonize(world, evs)
    world["name_budget"] = 1  # LLM voice may name one creature per week
    return evs


def _apply_effect(world, effect, evs):
    """Apply a validated operator decision. Pure deterministic mutations."""
    t = world["tick"]
    size = world["size"]
    action = effect.get("action", "quiet")
    strength = max(1, min(3, int(effect.get("strength", 1) or 1)))
    region = effect.get("region", "all")
    rng = W.rng_for(world["seed"], t, f"op:{action}")

    ev = {"tick": t, "kind": "op", "action": action, "region": region,
          "strength": strength, "intent": effect.get("intent", "")}

    if action == "storm":
        world["weather"], world["weather_left"] = "storm", 2 + strength
        for x, y in W.region_cells(size, region):
            c = world["cells"][y][x]
            if c["terrain"] != "water":
                c["moisture"] = _clamp01(c["moisture"] + 0.25)

    elif action == "drought":
        world["effects"].append({"kind": "drought",
                                 "ticks": 3 + 2 * strength, "region": region})

    elif action == "blight":
        world["effects"].append({"kind": "blight", "ticks": 4 + 2 * strength,
                                 "region": region,
                                 "species": effect.get("species")})

    elif action == "bloom":
        for x, y in W.region_cells(size, region):
            c = world["cells"][y][x]
            if c["terrain"] == "soil":
                c["grass"] = _clamp01(c["grass"] + 0.35)
                c["moisture"] = _clamp01(c["moisture"] + 0.15)
        planted = 0
        for _ in range(6 + 3 * strength):
            spots = [(x, y) for y in range(size) for x in range(size)
                     if world["cells"][y][x]["terrain"] == "soil"
                     and world["cells"][y][x]["moisture"] > 0.25
                     and _plants_in_cell(world, x, y) < 3]
            if not spots:
                break
            x, y = rng.choice(spots)
            world["plants"][str(world["next_id"])] = W.new_plant(
                world["next_id"], "berry", x, y, "mature", 3)
            world["next_id"] += 1
            planted += 1
        ev["n"] = planted

    elif action == "migration":
        sp = effect.get("species") or "robin"
        if sp in BASE_RESIDENTS:
            pop_now = _pop(world, sp)
            cap = W.ANIMAL_SPECIES[sp].get("cap", 100)
            if pop_now >= cap * 0.7:
                ev["action"] = "quiet"   # engine demotes: no room for them
            else:
                n = min(2 + 2 * strength, cap - pop_now)
                spawn_animals(world, sp, n, region=region)
                world["absent"].pop(sp, None)
                ev["n"] = n
        else:
            ev["action"] = "quiet"

    elif action == "destiny":
        tid = effect.get("target")
        a = world["animals"].get(str(tid))
        open_d = {d["id"] for d in world.get("destinies", [])}
        if a is None or tid in open_d or len(world.get("destinies", [])) >= 3 \
                or not effect.get("destiny"):
            ev["action"] = "quiet"   # only souls the engine truly knows
        else:
            kind = "water" if a["sp"] in \
                ("rabbit", "deer", "fox", "wolf", "stag", "boar") else "age"
            world.setdefault("destinies", []).append(
                {"id": tid, "sp": a["sp"], "text": effect["destiny"],
                 "made": t, "kind": kind})

    elif action == "visitor":
        sp = effect.get("species") or "stag"
        if sp in ("stag", "wolf"):
            n = 1 + (1 if strength >= 3 else 0)
            spawn_animals(world, sp, n, transient=5 + 2 * strength,
                          region=region if region != "all" else None)
            ev["n"] = n
        else:
            ev["action"] = "quiet"

    # quiet: nothing happens beyond the chronicle line
    evs.append(ev)
    hist = world.setdefault("op_history", [])
    hist.append({"tick": t, "action": ev["action"], "region": region,
                 "strength": strength})
    while len(hist) > 6:
        hist.pop(0)
    world["next_op"] = t + 6 + rng.randint(0, 6)   # every ~1.5-3 months


def spawn_animals(world, sp, n, transient=None, region=None):
    size = world["size"]
    rng = W.rng_for(world["seed"], world["tick"], f"spawn:{sp}")
    if region:
        spots = [(x, y) for x, y in W.region_cells(size, region)
                 if world["cells"][y][x]["terrain"] == "soil"]
    else:
        spots = [(x, y) for y in range(size) for x in range(size)
                 if world["cells"][y][x]["terrain"] == "soil"]
    if not spots:
        return []
    out = []
    for _ in range(n):
        x, y = rng.choice(spots)
        a = W.new_animal(world["next_id"], sp, x, y, 5)
        a["transient"] = transient
        world["animals"][str(world["next_id"])] = a
        world["next_id"] += 1
        out.append(a)
    return out