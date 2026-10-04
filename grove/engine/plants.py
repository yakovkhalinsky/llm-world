"""Light, the plant loop, seed rain, the understory and the bank.

The canopy's shade is rebuilt every week; a seed that cannot land sleeps
in the bank — soil memory, never consumed — and autumn lets it speak.
"""

from .. import world as W
from .. import rules

from .util import (_clamp, _clamp01, _region_set, _near_water,
                   _pop, _rules, _seasons)


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

def _update_plants(w, evs, light):
    size, t = w["size"], w["tick"]
    rng = W.rng_for(w["seed"], t, "plants")
    season = W.season_index(t)
    week_in = (t - 1) % rules.R["world"]["weeks_per_season"] + 1
    winter = season == 3
    growing = not winter
    blights = [e for e in w["effects"] if e["kind"] == "blight"]
    droughts = [e for e in w["effects"] if e["kind"] == "drought"]
    fallen = []

    for pid, p in list(w["plants"].items()):
        spec = W.PLANT_SPECIES[p["sp"]]

        if p["stage"] == "log":
            p["log"] = p.get("log", _rules()[7]) - 1
            if p["log"] <= 0:
                # the trunk is gone to humus; the soil remembers the tree
                c2 = w["cells"][p["y"]][p["x"]]
                c2["humus"] = min(1.0, c2.get("humus", 0) + rules.R["cells"]["humus_per_log"])
                del w["plants"][pid]
            continue

        c = w["cells"][p["y"]][p["x"]]
        li = light[p["y"]][p["x"]]
        p["age"] += 1
        damaged = False
        p_bl, p_dr = False, False

        # blight / drought pressure — which one actually bites this plant
        for e in blights:
            region = _region_set(e["region"], size)
            if (region is None or (p["x"], p["y"]) in region) and \
                    (e.get("species") in (None, p["sp"])):
                mult = 1.6 if p["sp"] in ("fern", "birch") else 1.0
                p["hp"] -= 1.2 * mult
                damaged = True
                p_bl = True
        for e in droughts:
            region = _region_set(e["region"], size)
            if (region is None or (p["x"], p["y"]) in region) \
                    and c["moisture"] < 0.12:
                p["hp"] -= 0.5
                damaged = True
                p_dr = True

        # weather stress
        if w["weather"] == "frost" and spec["frost_hp"]:
            p["hp"] -= spec["frost_hp"]
            damaged = True
            if p["hp"] < rules.R["cells"]["understory_hp_floor"] \
                    and spec["kind"] != "tree":
                p["hp"] = rules.R["cells"]["understory_hp_floor"]      # the cold stuns; it does not murder
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
        if p["sp"] == "fern" and li > 0.85:
            p["hp"] -= 0.6
            damaged = True

        # berry fruiting
        if p["sp"] == "berry" and p["stage"] in ("mature", "old") \
                and season == 0 and week_in == 1 and rng.random() < 0.8:
            p["berries"] = True

        # recover or die — rot feeds the ground beneath a log
        if not damaged and growing and c["moisture"] > 0.10:
            p["hp"] = min(10.0, p["hp"] + rules.R["cells"]["regen_per_week"] + c.get("humus", 0) * rules.R["cells"]["regen_humus_bonus"])
        if p["hp"] <= 0:
            cause = "blight" if p_bl else \
                ("drought" if p_dr else "withered")
            _fell(w, p, evs, cause)
            continue
        if p["age"] >= spec["max_age"]:
            _fell(w, p, evs, "age")
            continue

        # reproduction
        if spec["kind"] == "tree" and p["stage"] in ("mature", "old") \
                and season in _seasons(spec["seed_season"]) \
                and rng.random() < spec["seed_prob"]:
            _seed(w, p, spec, light, rng)
        if p["sp"] == "fern" and p["stage"] == "mature" and growing \
                and rng.random() < spec.get("spread_prob", 0):
            _spread_fern(w, p, spec, light, rng)
            _spread_fern(w, p, spec, light, rng)   # spores go out twice
        if p["sp"] == "berry" and p["stage"] in ("mature", "old") \
                and season in _seasons(spec["seed_season"]) \
                and rng.random() < spec["seed_prob"]:
            _seed(w, p, spec, light, rng)
        if p["sp"] == "berry" and p["stage"] in ("mature", "old") \
                and growing and rng.random() < 0.045:
            _spread_berry(w, p, rng)   # suckering: a clone next door

def _fell(w, p, evs, cause):
    p["stage"] = "log"
    p["log"] = _rules()[7]
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
        tol = 0.6 if c.get("humus", 0) > 0.25 else 0.8    # rot feeds light
        if light[sy][sx] < spec["light_need"] * tol:
            continue
        if _trees_in_cell(w, sx, sy) >= 1:
            # a shade-tolerant seed may still try under the canopy: its
            # niche is the light another tree's shade already softened —
            # but most seeds under a canopy do not take
            if spec["light_need"] > 0.3 or \
                    light[sy][sx] < spec["light_need"] * 1.6 or \
                    _trees_in_cell(w, sx, sy) >= 2:
                _bank(w, p["sp"])      # crowded: the seed waits in soil
                return
            if rng.random() >= rules.R["pop"]["shade_sprout_prob"]:
                _bank(w, p["sp"])
                return
        if _understory_in_cell(w, sx, sy) >= 2:
            _bank(w, p["sp"])
            return
        w["plants"][str(w["next_id"])] = W.new_plant(
            w["next_id"], p["sp"], sx, sy, "sapling", 0)
        w["next_id"] += 1
        return
    _bank(w, p["sp"])                  # shaded/no soil/water: the bank too



def _bank(w, sp):
    """A failed landing sleeps in the seed bank (capped)."""
    bank = w.setdefault("seedbank", {})
    bank[sp] = min(90, bank.get(sp, 0) + 1)

def _germinate(w, evs):
    """When a species is gone from the living forest, autumn lets the
    bank speak: the species returns from the soil's memory."""
    t = w["tick"]
    if W.season_index(t) != 2:          # autumn
        return
    bank = w.setdefault("seedbank", {})
    for sp in list(bank):
        alive = sum(1 for p in w["plants"].values()
                    if p["sp"] == sp and p["stage"] != "log")
        if alive >= rules.R["pop"]["germinate_min_alive"]:
            continue
        # the bank is the soil's memory, not a consumable ledger: the
        # rescue draws on it without emptying it; decay is the only loss
        n = min(rules.R["pop"]["germinate_cap"],
                max(rules.R["pop"]["germinate_min"],
                    bank.get(sp, 0) // 10)) if bank.get(sp) else 0
        if n <= 0 or (alive and t % 48 < 24):
            continue                        # don't smother a surviving handful
        size = w["size"]
        rng = W.rng_for(w["seed"], t, f"germ:{sp}")
        spec = W.PLANT_SPECIES[sp]
        light = build_light(w)
        # the bank doesn't gamble: enumerate where it could actually live
        spots = []
        for y in range(size):
            for x in range(size):
                c = w["cells"][y][x]
                if c["terrain"] != "soil":
                    continue
                if spec.get("near_water") and not _near_water(
                        w, x, y, spec["near_water"]):
                    continue
                li = light[y][x]
                if sp == "fern":
                    if not li < spec["light_need"] * 1.2:
                        continue
                elif li < spec["light_need"] * 0.8:
                    continue
                if sp in ("fern", "berry"):
                    if _understory_in_cell(w, x, y) >= 1:
                        continue
                elif _trees_in_cell(w, x, y) >= 1:
                    tolerant = spec["light_need"] <= 0.3
                    if not tolerant:
                        continue
                    if light[y][x] >= spec["light_need"] * 1.6 or \
                            _trees_in_cell(w, x, y) >= 2:
                        continue
                    if rng.random() >= rules.R["pop"]["shade_sprout_prob"]:
                        continue
                spots.append((x, y))
        if not spots:
            bank[sp] = min(90, bank.get(sp, 0) + 1)   # keep waiting in soil
            continue
        made = 0
        for x, y in rng.sample(spots, min(n, len(spots))):
            w["plants"][str(w["next_id"])] = W.new_plant(
                w["next_id"], sp, x, y, "sapling", 0)
            w["next_id"] += 1
            made += 1
        evs.append({"tick": t, "kind": "germinate", "sp": sp, "n": made})

def _spread_berry(w, p, rng):
    """A mature bush root-suckers: a clone in the pocket next door."""
    size = w["size"]
    for _ in range(2):
        sy = p["y"] + rng.randint(-1, 1)
        sx = p["x"] + rng.randint(-1, 1)
        if not W.in_bounds(size, sx, sy):
            continue
        if w["cells"][sy][sx]["terrain"] != "soil":
            continue
        if _understory_in_cell(w, sx, sy) >= 1:
            continue
        w["plants"][str(w["next_id"])] = W.new_plant(
            w["next_id"], "berry", sx, sy, "sapling", 0)
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
    if _understory_in_cell(w, sx, sy) >= 1:
        _bank(w, "fern")               # spores sleep in the soil instead
        return
    w["plants"][str(w["next_id"])] = W.new_plant(
        w["next_id"], "fern", sx, sy, "sapling", 0)
    w["next_id"] += 1

def _understory_in_cell(w, x, y):
    return sum(1 for p in w["plants"].values()
               if p["x"] == x and p["y"] == y and p["stage"] != "log"
               and W.PLANT_SPECIES[p["sp"]]["kind"] in ("understory",
                                                       "shrub"))

def _trees_in_cell(w, x, y):
    return sum(1 for p in w["plants"].values()
               if p["x"] == x and p["y"] == y
               and p["stage"] != "log"
               and W.PLANT_SPECIES[p["sp"]]["kind"] != "understory")

def _plants_in_cell(w, x, y):
    return sum(1 for p in w["plants"].values()
               if p["x"] == x and p["y"] == y and p["stage"] != "log")
