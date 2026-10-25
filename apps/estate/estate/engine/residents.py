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
from . import daytime
from . import families
from . import places
from . import weather

PHASES = ("dawn", "morning", "afternoon", "evening", "night")

# Called as watcher(w, phase) once every resident has settled a phase. The
# engine never reads them; the tools observe the settled states through
# them (tools/family_check.py) without editing the chooser.
PHASE_WATCHERS = []


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
        for need, spec in rules.R["needs"].items():
            if not spec.get("home"):
                continue
            out[need].append({"kind": "home", "x": b["door"][0],
                              "y": b["door"][1], "fixture": None, "unit": u})
    return out


def phase_mult(need, phase):
    return rules.R["needs"][need].get("phases", {}).get(phase, 1.0)


def week_mult(need, day):
    """The week has a shape, and it is not a detail.

    Saturday and Sunday are not Tuesday. Without this the estate had no
    rhythm above the day at all: every one of them ran 391, 395, 397
    errands and the plan's own day-feed said the same sentence for weeks.
    A world whose days are interchangeable has no days in it.
    """
    if W.weekday(day) < 5:
        return 1.0
    return rules.R["needs"][need].get("weekend", 1.0)


def pressure(w, r, need, phase):
    """How much this need is pushing, for this person, at this hour."""
    spec = rules.R["needs"][need]
    if "roles" in spec and r["role"] not in spec["roles"]:
        return 0.0
    hh = rules.R["households"].get(
        w["households"].get(str(r["household"]), {}).get("kind", ""), {})
    mult = hh.get("drains", {}).get(need, 1.0)
    p = (spec["urge"] * r["needs"][need] * phase_mult(need, phase)
         * week_mult(need, w["day"]) * mult)
    # Rain belongs here, in what sends you looking, and not in what you
    # find when you get there. Put on the places instead it multiplied every
    # outdoor option by the same number, so the ranking was untouched and a
    # rainy Tuesday ran exactly as a clear one did. A need a flat can meet
    # is not damped: you are no less hungry on a wet day, only less willing
    # to cross the estate for it.
    if not spec.get("home"):
        p *= rules.R["weather"].get("outdoor", {}).get(w["weather"], 1.0)
    return p


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
        # ... and home is worth more when it is wet out
        eff *= 1.0 + 0.35 * weather.wetness(w)
        if need == "quiet":
            eff *= max(0.05, 1.0 - places.unit_noise(w, c["unit"]))
        # No stair term here. The stairs are already what they cost — they
        # come out of the phase's step budget in _go_to, which is the whole
        # of the interior model. Charging them again as a utility penalty
        # charged them twice, and the second charge was the one that
        # dominated: at four floors it was 1.4 against a flat worth 0.62,
        # so nobody above the third floor ever went home at all. They slept
        # on benches, and the estate had a whole wing of empty bedrooms.
        # What makes a sixth floor hard is the walk, not a dislike of it.
        cost = 0.0
    else:
        f = c["fixture"]
        # A seat's capacity is hard: a full bench is not a worse bench, it
        # is no bench. The chooser falls through to the next candidate, so
        # the tenth person at the edge walks to the next free seat rather
        # than piling onto the first.
        if places.full(c["kind"], f["occupants"]):
            return None
        eff = places.effective(c["kind"], need, f["condition"],
                               len(f["occupants"]), f)
        # and the weather reaches the need without the weather module ever
        # knowing what a need is: a wet day keeps people in. The plan has
        # claimed this since it was written and nothing implemented it, so
        # rain softened the noise and changed nothing else at all.
        wet = weather.wetness(w)
        if wet:
            eff *= 1.0 - 0.45 * wet
        shade = w["cells"][f["y"]][f["x"]]["shade"]
        if w["weather"] == "heat":
            eff *= 1.0 + 0.8 * shade      # the shade is worth having
        if need == "quiet":
            eff *= 0.4 + 0.6 * shade      # and it is quiet under a tree
        if phase in ("evening", "night"):
            eff *= 1.0 + 0.7 * w["cells"][f["y"]][f["x"]]["light"]
        # The perimeter's own benches are worth the walk out: the quiet
        # and green of the ring road's margin, and the stroll for its own
        # sake. The bonus lives in the pack beside the bench's affords
        # (`places.base_quality`) and is folded in *before* condition and
        # crowding, so a worn or busy seat keeps no more of it than it
        # keeps of the bench itself. Rain damps it with the rest of the
        # outdoor draw, because nobody strolls the perimeter in a downpour.
        d = abs(c["x"] - px) + abs(c["y"] - py)
        if d > rules.R["engine"]["scan"]:
            return None
        cost = d * rules.R["engine"]["travel_cost"] + \
            (unit["floor"] * stair if inside and unit else 0)
    habit = rules.R["engine"]["habit_bonus"] \
        if r["habit"].get(phase) == c["kind"] else 0.0
    return eff - cost + habit + rng.random() * rules.R["engine"]["whim"]


# the eight ways a step can go, in the order a tie is broken
_STEPS = ((0, -1), (1, 0), (0, 1), (-1, 0), (1, -1), (1, 1), (-1, 1), (-1, -1))


def _path(w, sx, sy, tx, ty):
    """The shortest way from one cell to another over walkable ground: the
    cells to step on, the target last (the target itself need not be
    walkable — a fixture's own cell is where you arrive). A plain
    breadth-first search, eight ways, ties broken in `_STEPS` order, so it
    is the same way every time. None when there is no way at all."""
    if (sx, sy) == (tx, ty):
        return []
    came = {(sx, sy): None}
    frontier = [(sx, sy)]
    while frontier:
        nxt = []
        for cx, cy in frontier:
            for ox, oy in _STEPS:
                n = (cx + ox, cy + oy)
                if n in came:
                    continue
                if n != (tx, ty) and not W.passable(w, *n):
                    continue
                came[n] = (cx, cy)
                if n == (tx, ty):
                    out = []
                    while n != (sx, sy):
                        out.append(n)
                        n = came[n]
                    out.reverse()
                    return out
                nxt.append(n)
        frontier = nxt
    return None


def _reach(w, sx, sy, limit=None):
    """How many steps every walkable cell is from here (the same search as
    `_path`): what a walk can still get to this phase. With `limit` the
    search stops at that many steps — a cell further off is simply not in
    the answer, which is all the evening's choice asks of it (`_choose`),
    and it is most of the cost of a minder's evening choice otherwise."""
    dist = {(sx, sy): 0}
    frontier = [(sx, sy)]
    d = 0
    while frontier and (limit is None or d < limit):
        d += 1
        nxt = []
        for cx, cy in frontier:
            for ox, oy in _STEPS:
                n = (cx + ox, cy + oy)
                if n in dist:
                    continue
                dist[n] = d          # a fixture's cell is reached, not crossed
                if W.passable(w, *n):
                    nxt.append(n)
        frontier = nxt
    return dist


def _follow(r, path, steps):
    for x, y in path[:steps]:
        r["where"]["x"], r["where"]["y"] = x, y
    return len(path) <= steps


def _hold(r, tx, ty, path, steps):
    """Keep what is left of the way round once `steps` of it are walked."""
    rest = path[steps:]
    r["side"] = ({"to": [tx, ty], "path": [list(p) for p in rest]}
                 if rest else None)


def _route_walk(w, r, tx, ty, steps):
    """Walk the shortest way there, up to `steps` steps: the walk a minder
    makes in the evening (it was chosen because it can be made in the
    phase), and the walk home at curfew (made with no step cap at all)."""
    r["side"] = None
    path = _path(w, r["where"]["x"], r["where"]["y"], tx, ty)
    if path is None:
        return False                      # walled in: no way there at all
    return _follow(r, path, steps)


def _walk(w, r, tx, ty, steps):
    """Grove's step_toward, with the ground priced — a road is cheap, a lawn
    dear — and with a way around a wall.

    Grove's world had no walls, so a walk that only ever stepped *toward*
    its target always arrived. The estate has blocks, and a building is not
    merely dear to cross, it is impassable: every step toward the shop's
    door from the cell just above it is the shop's own roof.

    Going round used to be a maneuver: pick a side and keep going that way
    until a step toward the target opened. That is a trap at any wall
    whose way round is not straight along it. North of the row, heading
    for a door on its south side, the side step west opens a step back
    east — to the cell the walk just left — so the walk swung between two
    cells behind the block for the rest of the phase, and a family
    stranded there spent the night out (seed 1, three nights in its first
    two months). Now a walk that meets a wall takes the shortest way round
    it from where it stands (`_path`): the whole remaining walk, not a
    guess at a side. The way round is kept (`r["side"]`) until it has been
    walked, so a walk that runs out of phase half-way round carries on
    round next phase rather than stepping "toward" the target back into
    the pocket it was leaving.
    """
    held = r.get("side")
    r["side"] = None
    if isinstance(held, dict) and held.get("to") == [tx, ty] and held["path"]:
        path = [tuple(p) for p in held["path"]]
        wx, wy = r["where"]["x"], r["where"]["y"]
        if max(abs(path[0][0] - wx), abs(path[0][1] - wy)) == 1:
            _hold(r, tx, ty, path, steps)
            return _follow(r, path, steps)
    for n in range(steps):
        wx, wy = r["where"]["x"], r["where"]["y"]
        if wx == tx and wy == ty:
            return True
        dx = (tx > wx) - (tx < wx)
        dy = (ty > wy) - (ty < wy)
        forward = []
        if dx and dy:
            forward.append((wx + dx, wy + dy))
        if dx:
            forward.append((wx + dx, wy))
        if dy:
            forward.append((wx, wy + dy))
        forward.sort(key=lambda p: W.walk_cost(w, *p) or 99)
        for cx, cy in forward:
            if W.passable(w, cx, cy):
                r["where"]["x"], r["where"]["y"] = cx, cy
                break
        else:
            # every step toward the target is a wall: the way round it
            path = _path(w, wx, wy, tx, ty)
            if path is None:
                return False              # walled in on every side
            _hold(r, tx, ty, path, steps - n)
            return _follow(r, path, steps - n)
    return r["where"]["x"] == tx and r["where"]["y"] == ty


def _set_off(w, r, budget=None):
    """Where a walk starts and how many steps it has this phase: from the
    door, less the stairs, for someone indoors. None if they cannot get
    out (no flat, or the stairs took the whole phase). `budget` overrides
    the phase's ordinary stroll: the school run and the commute are made
    with the whole phase to make them in."""
    if budget is None:
        budget = rules.R["engine"]["steps_per_phase"] * r["mobility"]
    if r["where"]["mode"] != "in":
        return r["where"]["x"], r["where"]["y"], max(1, int(budget))
    unit = _unit_of(w, r)
    if unit is None:
        return None
    b = w["buildings"][str(unit["building"])]
    # the stairs, priced by whatever the estate is doing today: a power
    # cut is the lift going out, and a sixth floor with no lift is a
    # longer walk than a sixth floor (the plan's own rider)
    budget -= (unit["floor"] * rules.R["engine"]["stair_step"]
               * W.stair_mult(w, b))
    if budget <= 0:
        return None
    return b["door"][0], b["door"][1], max(1, int(budget))


def _go_to(w, r, c, route=False, sure=False, budget=None):
    """Leave home if inside, walk, and arrive — or run out of the phase.

    `route` walks the shortest way (`_route_walk`) rather than by feel, for
    a walk that was chosen because it can be made in the phase. `sure` is
    a walk that must arrive — the walk home at curfew — so it has no step
    cap: the phase's budget is how far someone strolls, not how far they
    will go to get the children home to bed. It is bounded by the size of
    the estate (width × height steps, more than any shortest way), not by
    the phase: the stairs and the walker's mobility are not charged to it.
    A duty walk (`c["duty"]`: the school gate, the bus) is a walk made
    every day by the way anyone knows, so it too goes the shortest way,
    with `budget` steps."""
    # `r["side"]` is a way round a wall still being walked (see `_walk`):
    # it is kept only while the walk is to the same place
    # a walk starts from where you were; until you arrive and use a place,
    # `where.fixture` is not a claim about this phase (the views seat only
    # the residents whose chosen fixture is the bench they stand on)
    r["where"]["fixture"] = None
    off = _set_off(w, r, budget)
    if off is None:
        return False                       # the stairs took the whole phase
    sx, sy, budget = off
    if r["where"]["mode"] == "in":
        unit = _unit_of(w, r)
        r["where"] = {"mode": "at", "unit": unit["id"], "x": sx, "y": sy,
                      "fixture": None}
    if sure:
        arrived = _route_walk(w, r, c["x"], c["y"], w["width"] * w["height"])
    elif route or c.get("duty"):
        arrived = _route_walk(w, r, c["x"], c["y"], budget)
    else:
        arrived = _walk(w, r, c["x"], c["y"], budget)
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
    # The same base the chooser weighed, perimeter bonus included: what
    # draws a resident out is what they get when they arrive. Restoring
    # only the bare afford was the mismatch that made a far, quiet seat
    # worth the walk out and then meet almost none of the need.
    restore = full * places.base_quality(f["kind"], need, f)
    r["needs"][need] = max(0.0, r["needs"][need] - restore)
    # who is actually using this place, for the views: a resident passing
    # through a bench's cell has not sat on it, and must not be drawn as if
    # they had. The engine itself never reads this back.
    r["where"]["fixture"] = f["id"]
    f["occupants"].append(r["id"])
    f["uses_today"] = f.get("uses_today", 0) + 1
    f["use_total"] += 1
    if w.get("daybook") is not None:
        u = w["daybook"]["uses"]
        u[f["kind"]] = u.get(f["kind"], 0) + 1
    if need == "food" and f.get("stock") is not None and f["stock"] > 0:
        f["stock"] -= 1
        if f["stock"] <= 0 and w.get("daybook") is not None:
            w["daybook"]["sold_out"] = True


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
                elif r["where"]["mode"] == daytime.AWAY:
                    noise = 0.0            # not the estate's noise to bear
                else:
                    noise = w["cells"][r["where"]["y"]][r["where"]["x"]]["noise"]
                r["needs"][need] += noise * rules.R["engine"]["quiet_gain"]
            else:
                r["needs"][need] += spec["rate"] * drains.get(need, 1.0)
            # a need saturates. Unbounded, it grows forever and every
            # pressure comparison becomes noise.
            r["needs"][need] = min(top, r["needs"][need])


def _held_fixture(w, r):
    """The fixture `r` is sitting at, if they are still on its cell."""
    where = r["where"]
    fid = where.get("fixture")
    if where["mode"] != "at" or fid is None:
        return None
    f = w["fixtures"].get(str(fid))
    if f is None or (f["x"], f["y"]) != (where["x"], where["y"]):
        return None
    return f


def _seat_holders(w):
    for f in w["fixtures"].values():
        f["occupants"] = []
    for rid in sorted(w["residents"], key=lambda k: int(k)):
        r = w["residents"][rid]
        f = _held_fixture(w, r)
        if f is not None:
            f["occupants"].append(r["id"])


def _top_press(w, r, phase):
    """How hard this person's most pressing need is pushing."""
    return max([pressure(w, r, n, phase) for n in rules.R["needs"]] or [0.0])


def _home_of(w, r, cand, phase):
    """Your own flat as a candidate, with the home need it best meets —
    the way home when a curfew sends you there with nothing else to do."""
    unit = _unit_of(w, r)
    if unit is None:
        return None, None
    best = None
    for need, spec in rules.R["needs"].items():
        if not spec.get("home"):
            continue
        for c in cand.get(need, ()):
            if c["kind"] == "home" and c["unit"]["id"] == unit["id"]:
                p = pressure(w, r, need, phase)
                if best is None or p > best[0]:
                    best = (p, c, need)
    return (best[1], best[2]) if best else (None, None)


def _choose(w, party, cand, phase, rng, wanted=None):
    """The place this party goes and the need, and whose need, it serves.

    A party of one is a resident choosing alone, exactly as before: the
    most pressing need first, and if there is nowhere to meet it, the next
    one down. A minder's party pools everyone's needs and goes for the most
    pressing of them, whoever's it is — that is how a child's longing to
    play becomes a playground trip with a parent — but only to places the
    minder may take children (`families.allows`). In the evening those are
    the places near home the party can also *reach* this phase, so the
    party ends the evening where the rule says it may be, not on the way.

    `wanted` collects each member's ranked needs, so `_also` reads the
    same list rather than ranking anyone twice in a phase (the gate's
    friction samples one ranking per resident per phase).
    """
    lead = party[0]
    minding = len(party) > 1
    ranked = {p["id"]: ranked_needs(w, p, phase) for p in party}
    if wanted is not None:
        wanted.update(ranked)
    wants = [(pressure(w, p, n, phase), n, p)
             for p in party for n in ranked[p["id"]]]
    wants.sort(key=lambda e: (-e[0], e[1], e[2]["id"]))
    reach = None
    if minding and families.reach_matters(phase):
        off = _set_off(w, lead)
        if off is not None:
            sx, sy, budget = off
            dist = _reach(w, sx, sy, budget)
            reach = (lambda c: (c["x"], c["y"]) in dist)
        else:
            reach = lambda c: False       # noqa: E731 (stuck indoors)
    for _, need, p in wants:
        best, best_u = None, None
        for c in cand.get(need, ()):
            if not families.allows(w, lead, c, phase, minding, reach):
                continue
            u = _utility(w, p, c, need, phase, rng)
            if u is not None and (best_u is None or u > best_u):
                best, best_u = c, u
        if best is not None:
            return best, need, p
    return None, None, None


def _also(w, r, c, phase, ranked=None):
    """What else a member of a party gets where the party went: their own
    most pressing need the place meets, if a seat is free for them.
    `ranked` is their ranking from `_choose`, when there was one."""
    if ranked is None:
        ranked = ranked_needs(w, r, phase)
    for need in ranked:
        if c["kind"] == "home":
            if rules.R["needs"][need].get("home"):
                return need
            continue
        f = c["fixture"]
        if rules.R["fixtures"][f["kind"]]["affords"].get(need, 0) > 0:
            return None if places.full(f["kind"], f["occupants"]) else need
    return None


def _fray(r, line):
    """A person who cannot get what they want starts to fray — and stops,
    and recovers: this is what the letting office reads."""
    frayed = max(r["needs"][n] for n in rules.R["needs"]
                 if not rules.R["needs"][n].get("roles")
                 or r["role"] in rules.R["needs"][n]["roles"])
    if frayed >= line:
        r["stress"] += 1.0
    else:
        r["stress"] *= rules.R["engine"]["stress_decay"]


def _live(w, party, cand, phase, line, fetch=()):
    """One phase for a resident and whoever they are minding. `fetch` is
    the young children this resident is collecting from school."""
    r = party[0]
    minding = len(party) > 1
    # a resident re-deciding is not competing with themselves for the seat
    # they are on (nor are the children with them)
    held = []
    for p in party:
        h = _held_fixture(w, p)
        if h is not None:
            h["occupants"].remove(p["id"])
        held.append((p, h))
    # somewhere they have to be — the school gate, the bus — comes before
    # anything they would choose (engine/daytime.py)
    # The duty walk has the whole `engine.scan` of steps, and `_set_off`
    # with a budget given does not scale it by the walker's mobility (only
    # the stairs come off it). That is safe because duties fall by day and
    # near home: the gate is a few path cells from every door, the run is
    # at dawn and the pickup in the afternoon or evening, never at night
    # (tests/test_school.py PickupTimeTest).
    duty = daytime.duty(w, party, phase, fetch)
    if duty is not None:
        arrived = _go_to(w, r, duty, budget=rules.R["engine"]["scan"])
        for k in party[1:]:
            families.follow(k, r)
        if arrived:
            party = daytime.arrive(w, party, duty, phase, fetch)
        for p in party:
            _fray(p, line)
        return
    rng = W.rng_for(w["seed"], w["day"], f"whim:{r['id']}:{phase}")
    wanted = {}
    best, need_of, who = _choose(w, party, cand, phase, rng, wanted)
    if best is None and r["where"]["mode"] == "at" \
            and families.curfew(w, r, phase, minding):
        best, need_of = _home_of(w, r, cand, phase)
        who = r
    if best is None:
        # nowhere to go: a phase at home, worth the same as any other
        # visit home — the same expression, so the two paths cannot drift
        # apart
        full = rules.R["engine"]["need_max"] * \
            rules.R["engine"]["arrive_restore"]
        for p, h in held:
            p["needs"]["rest"] = max(
                0.0, p["needs"]["rest"] - full * rules.R["engine"]["home_rest"])
            if h is not None:
                h["occupants"].append(p["id"])   # still sitting
        return
    # the walk home at curfew, and a minder's walk home in the evening,
    # must arrive: they are made with no step cap. A minder's evening
    # outing was chosen as one they can make in the phase, so it is walked
    # the way it was measured.
    home = best["kind"] == "home"
    sure = home and families.sure_home(w, r, phase, minding)
    route = minding and families.reach_matters(phase)
    arrived = _go_to(w, r, best, route=route, sure=sure)
    # the children walk with their minder and are wherever they got to,
    # indoors or out — never left at the door or on the bench behind
    for k in party[1:]:
        families.follow(k, r)
    if arrived:
        _satisfy(w, who, best, need_of, phase)
        for p in party:
            if p is not who:
                also = _also(w, p, best, phase, wanted.get(p["id"]))
                if also is not None:
                    _satisfy(w, p, best, also, phase)
    for p in party:
        _fray(p, line)


def update_residents(w, evs):
    cand = candidates(w)
    line = rules.R["engine"]["stress_at"]
    # a world saved before the family rules, or anything the slow layer
    # left: every young child starts the day beside a guardian
    daytime.overnight(w)
    families.settle(w, evs)
    for phase in PHASES:
        drain(w, phase)
        # the bus brings the day's workers back, the school lets out
        daytime.begin(w, phase)
        # A seat is held from the moment it is taken until its holder gets
        # up: whoever is still sitting from the last phase counts against
        # the bench before anyone else chooses. Clearing the lists and
        # letting each resident re-claim on their turn left a stayer — who
        # keeps their seat when nothing pulls them away — invisible to the
        # chooser, and two more could sit down beside them.
        _seat_holders(w)
        # who minds the young children this phase: they live it as their
        # minder's party, on the minder's turn, and never on their own
        leads = families.plan(w, lambda g: _top_press(w, g, phase),
                              busy=lambda g: daytime.busy(w, g, phase))
        led = {k["id"] for ks in leads.values() for k in ks}
        fetch = daytime.collectors(w, phase)
        for rid in sorted(w["residents"], key=lambda k: int(k)):
            r = w["residents"].get(rid)
            if r is None or r["id"] in led:
                continue
            if r["where"]["mode"] in families.OFF_PLAN:
                _fray(r, line)             # at school, or at work
                continue
            got = fetch.get(r["id"], ())
            _live(w, [r] + leads.get(r["id"], []), cand, phase, line, got)
            # the children collected at the gate lived this phase as the
            # collector's party; a lower-id collector must not leave them
            # a turn of their own to walk home alone on
            led.update(k["id"] for k in got)
        for f in w["fixtures"].values():
            f["occupants"] = []
        # how full the estate was at its fullest hour, which is the one
        # number that says whether a day was busy without saying anything
        # about what happened in it
        if w.get("daybook") is not None:
            out = sum(1 for x in w["residents"].values()
                      if x["where"]["mode"] == "at")
            w["daybook"]["out"] = max(w["daybook"]["out"], out)
        daytime.record(w, phase)
        for watch in PHASE_WATCHERS:
            watch(w, phase)
