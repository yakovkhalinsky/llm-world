"""The people: what they want, where they go, and what it costs them.

Grove has one need satisfied by four feeding laws; a person has five and
chooses among places. The shape of the choice is Grove's — nearest of kind,
within a scan, moved a few cells — with two additions that make it a life
rather than a diff:

- **habit.** A resident keeps the place they used in this phase last time
  and will go back to it unless something better beats it. Routine is what
  makes a world legible: the same bench, the same errand, most days.
- **the stairs.** Being inside is a state, not a coordinate, so coming and
  going costs `floor × stair_step` out of the phase's step budget. A sixth
  floor is a real distance, and when the lift fails it becomes a longer one.
"""

from .. import rules
from .. import world as W
from . import places

PHASES = ("dawn", "morning", "afternoon", "evening", "night")


def _pos(w, r):
    """Where a resident stands on the plan. Somebody indoors stands at
    their block's door, which is where a trip begins and ends."""
    if r["where"]["mode"] == "in":
        u = w["units"][str(r["where"]["unit"])]
        b = w["buildings"][str(u["building"])]
        return b["door"][0], b["door"][1]
    return r["where"]["x"], r["where"]["y"]


def _unit_of(w, r):
    uid = r["where"].get("unit")
    if uid is None:
        h = w["households"].get(str(r["household"]))
        uid = h["unit"] if h else None
    return w["units"].get(str(uid)) if uid is not None else None


def candidates(w):
    """Everywhere that affords something, built once a day rather than once
    a resident — the hot loop iterates places, never the plan."""
    out = {n: [] for n in rules.R["needs"]}
    for f in w["fixtures"].values():
        if f["condition"] <= 0:
            continue
        affords = rules.R["fixtures"][f["kind"]]["affords"]
        if affords.get("food") and f.get("stock", 1) <= 0:
            continue
        for need, q in affords.items():
            if q > 0:
                out[need].append({"kind": f["kind"], "x": f["x"], "y": f["y"],
                                  "fixture": f, "unit": None})
    for u in w["units"].values():
        if u["household"] is None:
            continue
        b = w["buildings"][str(u["building"])]
        for need in ("rest", "quiet"):
            out[need].append({"kind": "home", "x": b["door"][0],
                              "y": b["door"][1], "fixture": None, "unit": u})
    return out


def phase_mult(need, phase):
    return rules.R["needs"][need].get("phases", {}).get(phase, 1.0)


def pressure(w, r, need, phase):
    """How much this need is pushing, for this person, at this hour."""
    spec = rules.R["needs"][need]
    if "roles" in spec and r["role"] not in spec["roles"]:
        return 0.0
    hh = rules.R["households"].get(
        w["households"].get(str(r["household"]), {}).get("kind", ""), {})
    mult = hh.get("drains", {}).get(need, 1.0)
    return spec["urge"] * r["needs"][need] * phase_mult(need, phase) * mult


def ranked_needs(w, r, phase):
    """What this person wants, most pressing first, with everything too
    faint to be worth a trip dropped.

    The need is chosen *before* the place, and that order is the whole
    difference between a life and a shuttle: scored together, the nearest
    bench beats a meal merely by being nearest, and the estate eats only
    when eating happens to be convenient — which, over a year, is not
    often enough to keep anyone fed.
    """
    floor = rules.R["engine"]["urge_floor"]
    ranked = [(pressure(w, r, n, phase), n) for n in rules.R["needs"]]
    ranked = [(p, n) for p, n in ranked if p > floor]
    ranked.sort(key=lambda pn: (-pn[0], pn[1]))   # ties by name, so the
    return [n for _, n in ranked]                 # order is never in doubt


def _utility(w, r, c, need, phase, rng):
    px, py = _pos(w, r)
    unit = _unit_of(w, r)
    inside = r["where"]["mode"] == "in"
    stair = rules.R["engine"]["stair_step"]
    if c["kind"] == "home":
        if unit is None or c["unit"]["id"] != unit["id"]:
            return None                    # not your flat
        # Your own flat is not a place you might visit if it happens to be
        # near: it is yours, and you know the way there from anywhere. It
        # is deliberately *not* filtered by `scan` — and that is not a
        # detail. A resident who wandered to a corner of the plan with
        # nothing in range had no candidate for any need, so never moved,
        # and standing still kept them out of range of everything for good:
        # four people spent the rest of the year on the bottom road. The
        # way home is also the recovery path.
        eff = rules.R["engine"]["home_rest"] * c["unit"]["condition"]
        if need == "quiet":
            eff *= max(0.05, 1.0 - places.unit_noise(w, c["unit"]))
        cost = (c["unit"]["floor"] * stair) if not inside else 0
    else:
        f = c["fixture"]
        eff = places.effective(c["kind"], need, f["condition"],
                               len(f["occupants"]))
        shade = w["cells"][f["y"]][f["x"]]["shade"]
        if w["weather"] == "heat":
            eff *= 1.0 + 0.8 * shade      # the shade is worth having
        if need == "quiet":
            eff *= 0.4 + 0.6 * shade      # and it is quiet under a tree
        if phase in ("evening", "night"):
            eff *= 1.0 + 0.7 * w["cells"][f["y"]][f["x"]]["light"]
        d = abs(c["x"] - px) + abs(c["y"] - py)
        if d > rules.R["engine"]["scan"]:
            return None
        cost = d * rules.R["engine"]["travel_cost"] + \
            (unit["floor"] * stair if inside and unit else 0)
    habit = rules.R["engine"]["habit_bonus"] \
        if r["habit"].get(phase) == c["kind"] else 0.0
    return eff - cost + habit + rng.random() * rules.R["engine"]["whim"]


def _can_step(w, x, y, tx, ty):
    """Is there a passable step from here toward the target? This is how a
    walk knows its detour around a wall has ended."""
    dx = (tx > x) - (tx < x)
    dy = (ty > y) - (ty < y)
    for cx, cy in ((x + dx, y + dy), (x + dx, y), (x, y + dy)):
        if (cx, cy) != (x, y) and W.passable(w, cx, cy):
            return True
    return False


def _walk(w, r, tx, ty, steps):
    """Grove's step_toward, with the ground priced — a road is cheap, a lawn
    dear — and with a way around a wall.

    Grove's world had no walls, so a walk that only ever stepped *toward*
    its target always arrived. The estate has blocks, and a building is not
    merely dear to cross, it is impassable: every step toward the shop's
    door from the cell just above it is the shop's own roof. Worse, the
    first way round that suggested itself was the cell it had just come
    from, so a walk beside the shop stepped back and forth between two
    cells for forty steps and got nowhere — three children stood there for
    a year.

    So going round is a *maneuver*, not a per-step choice: once a walk has
    picked a side it keeps going that way until the way toward the target
    opens again, and only then resumes the direct walk.
    """
    for _ in range(steps):
        wx, wy = r["where"]["x"], r["where"]["y"]
        if wx == tx and wy == ty:
            r["side"] = None
            return True
        dx = (tx > wx) - (tx < wx)
        dy = (ty > wy) - (ty < wy)
        side = r["side"]
        if side:
            nx, ny = wx + side[0], wy + side[1]
            if not W.passable(w, nx, ny):
                r["side"] = None          # that way is shut too; choose again
            else:
                r["where"]["x"], r["where"]["y"] = nx, ny
                if _can_step(w, nx, ny, tx, ty):
                    r["side"] = None      # the wall has ended
                continue
        forward = []
        if dx and dy:
            forward.append((wx + dx, wy + dy))
        if dx:
            forward.append((wx + dx, wy))
        if dy:
            forward.append((wx, wy + dy))
        forward.sort(key=lambda p: W.walk_cost(w, *p) or 99)
        moved = False
        for cx, cy in forward:
            if W.passable(w, cx, cy):
                r["where"]["x"], r["where"]["y"] = cx, cy
                r["side"] = None
                moved = True
                break
        if moved:
            continue
        # every step toward the target is a wall. Go round: the ways round
        # are exactly the directions that do not face it, and the shortest
        # way round is the one that leaves the least walk afterwards.
        toward = set()
        if dx and dy:
            toward.add((dx, dy))
        if dx:
            toward.add((dx, 0))
        if dy:
            toward.add((0, dy))
        opts = []
        for sx, sy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            if (sx, sy) in toward:
                continue
            cx, cy = wx + sx, wy + sy
            if W.passable(w, cx, cy):
                opts.append((abs(cx - tx) + abs(cy - ty), sx, sy, cx, cy))
        if not opts:
            return False                  # walled in on every side
        opts.sort()
        _, sx, sy, cx, cy = opts[0]
        r["where"]["x"], r["where"]["y"] = cx, cy
        r["side"] = (sx, sy)
    return r["where"]["x"] == tx and r["where"]["y"] == ty


def _go_to(w, r, c):
    """Leave home if inside, walk, and arrive — or run out of the phase."""
    budget = rules.R["engine"]["steps_per_phase"] * r["mobility"]
    r["side"] = None                       # a new walk chooses its own way
    if r["where"]["mode"] == "in":
        unit = _unit_of(w, r)
        if unit is None:
            return False
        budget -= unit["floor"] * rules.R["engine"]["stair_step"]
        if budget <= 0:
            return False                   # the stairs took the whole phase
        b = w["buildings"][str(unit["building"])]
        r["where"] = {"mode": "at", "unit": unit["id"], "x": b["door"][0],
                      "y": b["door"][1], "fixture": None}
    arrived = _walk(w, r, c["x"], c["y"], max(1, int(budget)))
    if not arrived:
        return False
    if c["kind"] == "home":
        r["where"]["mode"] = "in"
        r["where"]["unit"] = c["unit"]["id"]
    return True


def _satisfy(w, r, c, need, phase):
    r["habit"][phase] = c["kind"]
    full = rules.R["engine"]["need_max"] * rules.R["engine"]["arrive_restore"]
    if c["kind"] == "home":
        r["needs"][need] = max(0.0, r["needs"][need] -
                               full * rules.R["engine"]["home_rest"])
        return
    f = c["fixture"]
    restore = full * places.base_quality(f["kind"], need)
    r["needs"][need] = max(0.0, r["needs"][need] - restore)
    f["occupants"].append(r["id"])
    f["uses_today"] = f.get("uses_today", 0) + 1
    f["use_total"] += 1
    if need == "food" and f.get("stock") is not None and f["stock"] > 0:
        f["stock"] -= 1


def drain(w, phase):
    """A phase of ordinary living: needs rise, and the noise you are
    standing in is what fills the need for quiet."""
    for r in w["residents"].values():
        hh = rules.R["households"].get(
            w["households"].get(str(r["household"]), {}).get("kind", ""), {})
        drains = hh.get("drains", {})
        top = rules.R["engine"]["need_max"]
        for need, spec in rules.R["needs"].items():
            # a need masked by role is not this person's need at all: an
            # adult does not accumulate a longing to play. Letting it rise
            # anyway put every grown resident at play 4.0 forever — a
            # number nothing could ever spend, which is the unread value
            # wearing a need's clothes.
            if "roles" in spec and r["role"] not in spec["roles"]:
                continue
            if spec.get("from") == "noise":
                if r["where"]["mode"] == "in":
                    unit = _unit_of(w, r)
                    noise = places.unit_noise(w, unit) if unit else 0.0
                else:
                    noise = w["cells"][r["where"]["y"]][r["where"]["x"]]["noise"]
                r["needs"][need] += noise * rules.R["engine"]["quiet_gain"]
            else:
                r["needs"][need] += spec["rate"] * drains.get(need, 1.0)
            # a need saturates. Unbounded, it grows forever and every
            # pressure comparison becomes noise.
            r["needs"][need] = min(top, r["needs"][need])


def update_residents(w, evs):
    cand = candidates(w)
    line = rules.R["engine"]["stress_at"]
    for phase in PHASES:
        drain(w, phase)
        for rid in sorted(w["residents"], key=lambda k: int(k)):
            r = w["residents"].get(rid)
            if r is None:
                continue
            best, best_u, need_of = None, None, None
            rng = W.rng_for(w["seed"], w["day"], f"whim:{rid}:{phase}")
            # the most pressing need first, and if there is nowhere to
            # meet it, the next one down — never a place chosen on
            # convenience before the need that sent you looking
            for need in ranked_needs(w, r, phase):
                for c in cand.get(need, ()):
                    u = _utility(w, r, c, need, phase, rng)
                    if u is not None and (best_u is None or u > best_u):
                        best, best_u, need_of = c, u, need
                if best is not None:
                    break
            if best is None:
                # nowhere to go: a phase at home, worth the same as any
                # other visit home — the same expression, so the two paths
                # cannot drift apart
                full = rules.R["engine"]["need_max"] * \
                    rules.R["engine"]["arrive_restore"]
                r["needs"]["rest"] = max(
                    0.0, r["needs"]["rest"] - full * rules.R["engine"]["home_rest"])
                continue
            if _go_to(w, r, best):
                _satisfy(w, r, best, need_of, phase)
            # a person who cannot get what they want starts to fray — and
            # stops, and recovers: this is what the letting office reads
            frayed = max(r["needs"][n] for n in rules.R["needs"]
                         if not rules.R["needs"][n].get("roles")
                         or r["role"] in rules.R["needs"][n]["roles"])
            if frayed >= line:
                r["stress"] += 1.0
            else:
                r["stress"] *= rules.R["engine"]["stress_decay"]
        for f in w["fixtures"].values():
            f["occupants"] = []
