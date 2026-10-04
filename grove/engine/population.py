"""The safety nets: destinies, recolonization, the robins' covenant.

A species can never be truly lost; the world's edges always hold more.
"""

from .. import world as W
from .. import rules

from .util import _clamp, _clamp01, _region_set, _near_water, _pop


def _check_destinies(w, evs):
    """The soul's promises are watched deterministically: by water or
    by age; a death ends the watch unheard."""
    t = w["tick"]
    for d in list(w.get("destinies", [])):
        a = w["animals"].get(str(d["id"]))
        if a is None or a["sp"] != d["sp"]:
            w["destinies"].remove(d)
            evs.append({"tick": t, "kind": "destiny_lost", "sp": d["sp"],
                        "who": d["id"], "destiny": d["text"]})
            continue
        hit = _near_water(w, a["x"], a["y"], 1) if d["kind"] == "water" \
            else a["age"] >= W.ANIMAL_SPECIES[d["sp"]]["lifespan"] * 0.4
        if hit:
            w["destinies"].remove(d)
            evs.append({"tick": t, "kind": "destiny", "sp": a["sp"],
                        "who": a["id"], "x": a["x"], "y": a["y"],
                        "name": w["names"].get(str(a["id"])),
                        "destiny": d["text"]})

def _recolonize(w, evs):
    t = w["tick"]
    size = w["size"]
    for sp in rules.R["pop"]["base_residents"]:
        n = _pop(w, sp)
        if n == 0:
            since = w["absent"].setdefault(sp, t)
            if t - since >= rules.R["pop"]["recolonize_after"]:
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
    """Species whose table says `migration` leave at their leave-season
    and return at their return-season; the return's law (chance, floor,
    share of the flock) stays in rules — lawful amendments still move it.
    The robin's chronicle names keep their old kinds."""
    for sp, spec in W.ANIMAL_SPECIES.items():
        m = spec.get("migration")
        if not m:
            continue
        leave_at, return_at = m.get("leave_at", 3), m.get("return_at", 0)
        if to_season == leave_at:
            n = _pop(w, sp)
            if n == 0:
                continue
            w.setdefault("migrated", {})[sp] = n
            for aid, a in list(w["animals"].items()):
                if a["sp"] == sp:
                    del w["animals"][aid]
            evs.append({"tick": w["tick"],
                        "kind": "robins_left" if sp == "robin"
                        else "migration_out", "n": n})
        elif to_season == return_at and from_season == leave_at:
            rng = W.rng_for(w["seed"], w["tick"], "return")
            last = w.get("migrated", {}).get(sp, w.get("robin_last", 0)
                                             if sp == "robin" else 0)
            if last > 0 and rng.random() < \
                    rules.R["pop"]["robins_return_prob"]:
                size = w["size"]
                n_back = max(rules.R["pop"]["robins_return_min"], last // 2)
                spots = [(x, y) for y in range(size) for x in range(size)
                         if w["cells"][y][x]["terrain"] == "soil"]
                for _ in range(min(n_back, 30)):
                    x, y = rng.choice(spots)
                    w["animals"][str(w["next_id"])] = W.new_animal(
                        w["next_id"], sp, x, y, 1)
                    w["next_id"] += 1
                evs.append({"tick": w["tick"],
                            "kind": "robins_return" if sp == "robin"
                            else "migration_back", "n": n_back})
                w["absent"].pop(sp, None)


# --------------------------------------------------------------- entrypoint
