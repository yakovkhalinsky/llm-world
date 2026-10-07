"""The placed things: what they afford, how full they are, how they wear.

Two ideas carry the whole estate here.

**A place affords less the busier it is.** `capacity / (capacity + k·occupancy)`
is the same shape as Grove's density-dependent hunting — a fox misses more
when the warren is thin, and the seventh child on the swings gets almost
nothing. It costs O(1), needs no pathfinding, and it is what makes demand
redistribute itself instead of everyone choosing the same bench forever.

**Use wears a thing out.** The busiest playground cracks first, so the
estate's capacity is consumed by the very life that saturates it, and an
unattended estate degrades. That is the anti-equilibrium force: without it
the estate settles into a metronome where every need is met and nothing
ever happens.
"""

from .. import rules
from .. import world as W
from . import weather


def base_quality(kind, need):
    return rules.R["fixtures"][kind]["affords"].get(need, 0.0)


def effective(kind, need, condition, occupants):
    """What a place is worth for a need right now: its base quality, cut
    down by how worn it is and by how full it already is."""
    cap = max(1, rules.R["fixtures"][kind]["capacity"])
    k = rules.R["engine"]["congestion"]
    return base_quality(kind, need) * condition / \
        (1.0 + k * occupants / cap)


# --------------------------------------------------------------- noise

def build_noise(w):
    """Noise is a field, not a property of a place.

    It radiates from the roads, from wherever people have gathered, and —
    the part that makes it a commons rather than a menu item — it does not
    stop at a wall. Quiet is therefore the one need a lively estate can
    never fully meet, which is exactly why it is in the model: it is the
    need that keeps the estate from settling.
    """
    ww, hh = w["width"], w["height"]
    soft = rules.R["weather"]["soften"] * weather.wetness(w)
    grid = [[0.0] * ww for _ in range(hh)]
    for y in range(hh):
        for x in range(ww):
            grid[y][x] = rules.R["sites"][w["cells"][y][x]["site"]]["noise"]
    for f in w["fixtures"].values():
        n = f.get("last_use", 0)
        if not n or f["condition"] <= 0:
            continue
        loud = rules.R["fixtures"][f["kind"]].get("loud", 0.0)
        if not loud:
            continue
        # A sound carries. The kernel was 3×3 for everything, so the
        # playground — the loudest thing on the estate and the whole
        # reason `quiet` is a commons — was inaudible from every door,
        # seven cells away at the nearest. `carry` is how far this sort of
        # thing is heard, and it differs by sort for the same reason
        # `upkeep` does: a playground is not a bench.
        carry = rules.R["fixtures"][f["kind"]].get("carry", 1)
        emit = loud * min(n, 12)          # a hundred hands are not ten
        for dy in range(-carry, carry + 1):
            for dx in range(-carry, carry + 1):
                d = abs(dx) + abs(dy)
                if d > carry:
                    continue
                x, y = f["x"] + dx, f["y"] + dy
                if W.in_bounds(w, x, y):
                    grid[y][x] += emit * (1.0 - d / (carry + 1.0))
    for y in range(hh):
        for x in range(ww):
            # a fate can quieten a place without closing it: tranquillity
            # is the estate being *quieter*, not the noise being deleted
            w["cells"][y][x]["noise"] = max(
                0.0, (grid[y][x] - soft)
                * W.fate_mult(w, "noise_mult", x, y))
    book = w.get("daybook")
    if book is not None:
        book["noise"] = max((c["noise"] for row in w["cells"] for c in row),
                            default=0.0)
    return w["cells"]


def build_light(w):
    """What the lamps light. A working lamp makes the ground around it
    usable after dark, which is the whole reason a courtyard has them."""
    grid = [[0.0] * w["width"] for _ in range(w["height"])]
    for f in w["fixtures"].values():
        emit = rules.R["fixtures"][f["kind"]].get("light", 0.0)
        if not emit or f["condition"] <= 0:
            continue
        for dy in (-2, -1, 0, 1, 2):
            for dx in (-2, -1, 0, 1, 2):
                x, y = f["x"] + dx, f["y"] + dy
                if W.in_bounds(w, x, y):
                    d = abs(dx) + abs(dy)
                    grid[y][x] += emit * max(0.0, 1.0 - d / 3.0)
    for y in range(w["height"]):
        for x in range(w["width"]):
            w["cells"][y][x]["light"] = min(1.0, grid[y][x])


def unit_noise(w, unit):
    """What a flat hears. There is no interior grid, so this stands in for
    one: the road fades as you climb, and the neighbours do not — which is
    how a top-floor flat by a quiet road can still be the loudest place in
    the estate during a party on the floor below."""
    b = w["buildings"][str(unit["building"])]
    door = w["cells"][b["door"][1]][b["door"][0]]["noise"]
    road = door * max(0.12, 1.0 - 0.10 * unit["floor"])
    homes = sum(1 for u in b["units"]
                if w["units"][str(u)]["household"] is not None)
    crowd = homes / max(1, len(b["units"]))
    return (road + 0.14 * crowd) * (1.0 - 0.45 * unit["quiet_base"])


# ------------------------------------------------------------ fixtures

def update_fixtures(w, evs):
    """Wear, breakage and stock. `busy_wear` is what makes use cost: a
    fixture's condition falls by its own decay, and by that decay again for
    every hand that touched it today."""
    busy = rules.R["engine"]["busy_wear"]
    repair = rules.R["engine"]["repair"]
    # And a thing can simply *fail* — a slat gives way, a bulb goes, a
    # swing chain snaps. Maintenance keeps the estate's places well; it
    # does not keep them immortal, and without this the estate had no
    # attrition at all: the `upkeep` fix that stopped the shop starving
    # the estate also stopped anything ever breaking, quietly removing
    # one of the three loops the whole design rests on. Nothing here is
    # near condition zero any more, so the decay alone can never reach it.
    rng = W.rng_for(w["seed"], w["day"], "fail")
    for f in w["fixtures"].values():
        spec = rules.R["fixtures"][f["kind"]]
        if spec.get("living"):
            continue                     # trees age by their own law
        uses = f.pop("uses_today", 0)
        f["last_use"] = uses      # what the noise field hears tomorrow
        was = f["condition"]
        # Wear grows with use; mending grows with *damage*. The second half
        # is the whole of it: `repair / (1 + uses)` made the repair term
        # shrink exactly as the wear term grew, so any fixture busy enough
        # was a one-way ratchet to zero — and nothing in the estate is
        # busier than the shop, so the shop was permanently broken. Food
        # has one source, so the estate ate on alternate days: eat until it
        # broke, mend a hair overnight, eat again. A metronome built out of
        # the very loop meant to prevent one. Mending toward whole gives
        # every fixture a real level instead — the busy ones lower, and a
        # thing used past what the estate can keep up with still fails.
        if rng.random() < spec.get("break_prob", 0.0):
            # it failed outright. This has to be *after* `was` is read, or
            # the repair term below computes from the zeroed value and puts
            # the thing straight back — which is exactly what happened, and
            # is why a round of failures produced no `broke` events at all.
            f["condition"] = 0.0
        else:
            f["condition"] = max(0.0, min(1.0, was
                                           - spec["decay"] * (1.0 + busy * uses)
                                           + repair * spec.get("upkeep", 1.0)
                                           * (1.0 - was)))
        if was > 0 and f["condition"] <= 0:
            evs.append({"day": w["day"], "kind": "broke", "what": f["kind"],
                        "x": f["x"], "y": f["y"]})
            if w.get("daybook") is not None:
                w["daybook"]["broke"] += 1
        # a shop is supplied: the delivery fate is a windfall on top of
        # this, not the estate's only way of eating
        if spec.get("supplied"):
            f["stock"] = spec.get("stock", 150)
        f["occupants"] = []
