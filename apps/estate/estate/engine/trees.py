"""The trees: the only fixtures that live.

Grove's plant law, kept small. A tree ages, it can come down in a storm, and
it makes **shade** — a field, rebuilt each day, which is worth more in a
heat wave and is what makes a bench under a plane better than a bench in the
open. A felled tree takes its shade with it.
"""

from .. import rules
from .. import world as W


def build_shade(w):
    """Shade is a field, like noise: a tree shades its own cell and the ring
    around it, and the canopy of several trees stacks."""
    grid = [[0.0] * w["width"] for _ in range(w["height"])]
    for f in w["fixtures"].values():
        if f["kind"] != "tree" or f["condition"] <= 0:
            continue
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                x, y = f["x"] + dx, f["y"] + dy
                if W.in_bounds(w, x, y):
                    grid[y][x] += 0.30 if not (dx or dy) else 0.12
    for y in range(w["height"]):
        for x in range(w["width"]):
            w["cells"][y][x]["shade"] = min(1.0, grid[y][x])


def update_trees(w, evs):
    rng = W.rng_for(w["seed"], w["day"], "trees")
    storm = w["weather"] == "storm"
    for f in list(w["fixtures"].values()):
        spec = rules.R["fixtures"][f["kind"]]
        if not spec.get("living"):
            continue
        f["age"] += 1
        if storm and rng.random() < spec.get("storm_fall", 0.0):
            del w["fixtures"][str(f["id"])]
            evs.append({"day": w["day"], "kind": "tree_down",
                        "x": f["x"], "y": f["y"]})
    build_shade(w)
