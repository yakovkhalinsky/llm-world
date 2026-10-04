"""The operator's fates, applied at tick boundaries.

Validated upstream (operator.validate); here they mutate the world
deterministically and write their own history.
"""

from .. import world as W
from .. import rules

from .plants import _plants_in_cell
from .util import _clamp, _clamp01, _region_set, _near_water, _pop


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
        if sp in rules.R["pop"]["base_residents"]:
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
                rules.R["pop"]["water_seekers"] else "age"
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
