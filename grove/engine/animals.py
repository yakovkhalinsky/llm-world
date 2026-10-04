"""The animal loop: hunger, feeding, flight, predation, litters.

Feeding is per-species law in _behave; movement helpers serve it. A kill
satisfies the hunter outright — only starvation and old age leave meat.
"""

from .. import world as W
from .. import rules

from .util import (_clamp, _clamp01, _near_water, _pop, _rules,
                   _breed_seasons)


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

        drain = spec["hunger_drain"] * (_rules()[4] if winter else 1.0)
        a["hunger"] += drain
        if a["hunger"] > 9:
            a["hp"] -= 0.5
        if a["hp"] <= 0:
            w["cells"][a["y"]][a["x"]]["carcass"] = _rules()[8]
            evs.append({"tick": t, "kind": "starve", "sp": a["sp"],
                        "who": a["id"], "x": a["x"], "y": a["y"]})
            del w["animals"][aid]
            continue

        _behave(w, a, spec, evs, rng, winter)

        # reproduction
        cap = spec.get("cap", 100)
        pop = _pop(w, a["sp"])
        if not winter and a["preg"] == 0 \
                and a["energy"] >= spec.get("energy_breed", 99) \
                and season in _breed_seasons(spec) \
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
            w["cells"][a["y"]][a["x"]]["carcass"] = _rules()[8]
            evs.append({"tick": t, "kind": "oldage", "sp": a["sp"],
                        "who": a["id"], "x": a["x"], "y": a["y"]})
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
            _clamp(_pop(w, hunt) / spec.get("hunting_density_scale", 12.0), spec.get("hunt_prob_min", 0.35), 1.0)
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

    # -- the feeding laws: the species table names its diet and carries
    # each law's numbers; the engine runs the law it is given ----------
    diet = spec.get("diet")
    res = None
    if diet == "graze":
        res = _diet_graze(w, a, spec, evs, t, speed, rng)
    elif diet == "browse":
        res = _diet_browse(w, a, spec, evs, t, speed, rng)
    elif diet == "glean":
        res = _diet_glean(w, a, spec, evs, t, speed, rng)
    elif diet == "scavenge":
        res = _diet_scavenge(w, a, spec, evs, t, speed, rng)
    if res == "moved":    # the scatter already moved; no second step
        return False
    ate = ate or bool(res)
    if ate:
        a["hunger"] = max(0.0, a["hunger"] - 7.0)
        a["energy"] = min(10.0, a["energy"] + 2.0)
        a["hp"] = min(10.0, a["hp"] + 0.6)
    elif speed:
        _wander(w, a, speed, spec.get("flyer"), rng)
    return ate


# --- the feeding laws -------------------------------------------------
# every law's numbers live on the species table (with today's values as
# defaults, so no table edit is needed to keep the world's behavior)

def _diet_graze(w, a, spec, evs, t, speed, rng):
    """Grazing: flee what hunts it when close; graze tall-enough grass;
    else walk toward taller grass."""
    c0 = w["cells"][a["y"]][a["x"]]
    flee = next((q for q in w["animals"].values()
                 if q["sp"] in spec.get("flee_from", ())
                 and abs(q["x"] - a["x"]) + abs(q["y"] - a["y"])
                 <= spec.get("flee_range", 3)), None)
    if flee is not None:
        px = max(-1, min(1, a["x"] - flee["x"]))
        py = max(-1, min(1, a["y"] - flee["y"]))
        saved = (a["x"], a["y"])
        step_toward(w, a, a["x"] + px * spec.get("flee_cells", 4),
                    a["y"] + py * spec.get("flee_cells", 4), speed,
                    spec.get("flyer"))
        if (a["x"], a["y"]) == saved:
            _wander(w, a, speed, spec.get("flyer"), rng)
        return "moved"     # already moved; the caller takes no second step
    if c0["grass"] >= spec.get("graze_at", 0.12):
        c0["grass"] -= spec.get("graze_take", 0.18)
        return True
    tgt = _nearest_grass(w, a["x"], a["y"], spec.get("seek_at", 0.15),
                         spec["scan"])
    _move_to(w, a, tgt, speed, spec.get("flyer"))
    return False


def _diet_browse(w, a, spec, evs, t, speed, rng):
    """Browsing: prune saplings when grown hungry, else graze."""
    c0 = w["cells"][a["y"]][a["x"]]
    sap = _nearest_sapling(w, a["x"], a["y"], spec["scan"])
    if sap is not None and a["hunger"] > spec.get("browse_hunger", 6) \
            and rng.random() < spec.get("browse_chance", 0.5):
        sap["hp"] -= spec.get("browse_hp", 1.5)
        evs.append({"tick": t, "kind": "browsed", "plant": sap["id"],
                    "sp": sap["sp"], "x": sap["x"], "y": sap["y"]})
        return True
    if c0["grass"] >= spec.get("graze_at", 0.15):
        c0["grass"] -= spec.get("graze_take", 0.12)
        return True
    tgt = _nearest_grass(w, a["x"], a["y"], spec.get("seek_at", 0.15),
                         spec["scan"])
    _move_to(w, a, tgt, speed, spec.get("flyer"))
    return False


def _diet_glean(w, a, spec, evs, t, speed, rng):
    """Gleaning, the light hand: fruit, then mushrooms, then a nibble."""
    c0 = w["cells"][a["y"]][a["x"]]
    bush = _berry_here(w, a["x"], a["y"])
    if bush:
        bush["berries"] = False
        bush["hp"] = max(0.5, bush["hp"] - 1.0)
        evs.append({"tick": t, "kind": "picked", "plant": bush["id"],
                    "sp": bush["sp"], "x": bush["x"], "y": bush["y"]})
        return True
    if c0["mushroom"]:
        c0["mushroom"] = 0
        return True
    if c0["grass"] >= spec.get("graze_at", 0.2):
        c0["grass"] -= spec.get("graze_take", 0.04)
        return True
    tgt = _nearest_food(w, a["x"], a["y"], spec["scan"])
    _move_to(w, a, tgt, speed, spec.get("flyer"))
    return False


def _diet_scavenge(w, a, spec, evs, t, speed, rng):
    """Scavenging: mushrooms first, then carrion, then a heavier graze."""
    c0 = w["cells"][a["y"]][a["x"]]
    if c0["mushroom"]:
        c0["mushroom"] = 0
        return True
    if c0["carcass"]:
        c0["carcass"] = 0
        return True
    if c0["grass"] >= spec.get("graze_at", 0.2):
        c0["grass"] -= spec.get("graze_take", 0.15)
        return True
    tgt = _nearest_food(w, a["x"], a["y"], spec["scan"])
    _move_to(w, a, tgt, speed, spec.get("flyer"))
    return False

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
                "hunter_id": predator["id"], "victim": prey["id"],
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
