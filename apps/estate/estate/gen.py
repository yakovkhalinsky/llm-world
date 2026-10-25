"""Seeded, deterministic estate generation — pure code, no LLM involved.

Draws a plan, not a landscape: a ring road with a footpath along its inner
edge, one row of residential blocks along the north facing open ground, a
shop, a pond, a playground, a school with its yard south of the
courtyard, a bus stop on the ring road, and the fixtures and households
that fill them. Everything comes from (seed, 0, "gen") in a fixed order, so the same
seed is the same estate in any process.
"""

from . import rules
from . import world as W
from .engine import households

BLOCK_NAMES = ("Ash", "Elm", "Lime", "Maple", "Willow", "Hawthorn")


def _rect(cells, x0, y0, x1, y1, site):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if 0 <= y < len(cells) and 0 <= x < len(cells[0]):
                cells[y][x] = W.new_cell(site)


def generate(seed: int, width: int = None, height: int = None,
             biome: str = None) -> dict:
    if biome:
        rules.select_biome(biome)
    rng = W.rng_for(seed, 0, "gen")
    g = rules.R["gen"]
    w = width or rules.R["world"]["width"]
    h = height or rules.R["world"]["height"]
    st = W.new_state(seed, w, h)
    st["biome"] = rules.active_biome()
    cells = [[W.new_cell("lawn") for _ in range(w)] for _ in range(h)]

    # --- the ring road, and the ground inside it ------------------------
    rw = g["road_width"]
    _rect(cells, rw, rw, w - rw - 1, rw + rw - 1, "road")          # top
    _rect(cells, rw, h - rw - rw, w - rw - 1, h - rw - 1, "road")  # bottom
    _rect(cells, rw, rw, rw + rw - 1, h - rw - 1, "road")          # left
    _rect(cells, w - rw - rw, rw, w - rw - 1, h - rw - 1, "road")  # right

    # --- the courtyard, between the blocks ------------------------------
    # the courtyard leaves a clear band above and below it (y = cy0-1 and
    # cy1+1) — that band is where the benches, lamps and bins stand, and
    # the blocks must not reach into it
    cy0, cy1 = h // 2 - 2, h // 2 + 1
    cx0, cx1 = rw + 6, w - rw - 7
    _rect(cells, cx0, cy0, cx1, cy1, "paved")

    # --- the blocks, in the recipe's layout -----------------------------
    # `layout` is the estate's arrangement, not a decoration of it. A block
    # is impassable, and a block in front of something hides it from both
    # views (they look from the south-east): the four-block quad put two
    # blocks between the camera and the courtyard's own south side. The
    # row lays every block along the north, doors south, so the ground in
    # front — the courtyard with its shop, pond, playground and tables, and
    # the perimeter path — is open and visible from either view.
    bw, bh = 12, 6
    gap = g["block_gap"]
    layout = g.get("layout", "quad")
    blocks = []
    if layout == "row":
        # centred across the plan, shoulder to shoulder with `block_gap`
        # between neighbours; the north band leaves the perimeter's bench
        # row and footpath clear above them
        n = g["blocks"]
        span = n * bw + max(0, n - 1) * gap
        bx = (w - span) // 2
        by = rw + rw + gap
        # the inner ground starts and ends a road's width inside each
        # outer margin: x = 2rw .. w-2rw-1 and y likewise
        if (bx < rw * 2 or bx + span > w - rw * 2
                or by + bh > h - rw * 2):
            raise ValueError(
                f"the recipe asks for {n} blocks in a row {span} cells wide "
                f"but this {w}×{h} plan's inner ground is only "
                f"{max(0, w - 4 * rw)} wide — widen the plan or lower "
                f"gen.blocks")
        for i in range(n):
            blocks.append((bx + i * (bw + gap), by))
    elif layout == "quad":
        by_top = rw + rw + gap
        by_bot = h - rw - rw - bh - gap
        bx_left = rw + rw + gap
        bx_right = w - rw - rw - bw - gap - 1
        for (bx, by) in ((bx_left, by_top), (bx_right, by_top),
                         (bx_left, by_bot), (bx_right, by_bot)):
            if bx + bw >= w - rw or by + bh >= h - rw or bx < rw or by < rw:
                continue                   # too small a plan for four
            blocks.append((bx, by))
    else:
        # an unknown arrangement is a recipe that does not say what it
        # means; guessing a layout is how a key becomes a decoration (b34)
        raise ValueError(
            f"gen.layout is {layout!r} — expected 'row' or 'quad'")

    # The row is the estate's promise about the open ground, so a plan too
    # narrow to hold it must say so rather than quietly drop a block.
    if len(blocks) != g["blocks"]:
        raise ValueError(
            f"the recipe asks for {g['blocks']} blocks in a {layout} but "
            f"this plan holds {len(blocks)} — widen the plan or lower "
            f"gen.blocks")

    st["buildings"] = {}
    st["units"] = {}
    buildings = []
    for n, (bx, by) in enumerate(blocks):
        _rect(cells, bx, by, bx + bw - 1, by + bh - 1, "building")
        floors = rng.randint(*g["block_floors"])
        per = rng.randint(*g["units_per_floor"])
        # The door is the *walkable* cell just outside the footprint, not a
        # cell within it: a building is entered at its door and never
        # crossed, so a door inside the walls is a door nobody can use.
        door = (bx + bw // 2, by + bh) if by < h // 2 \
            else (bx + bw // 2, by - 1)
        bid = st["next_id"]; st["next_id"] += 1
        b = W.new_building(bid, f"{BLOCK_NAMES[n % len(BLOCK_NAMES)]} Block",
                           "block", bx, by, bw, bh, floors, door)
        for f in range(1, floors + 1):
            for k in range(per):
                uid = st["next_id"]; st["next_id"] += 1
                u = W.new_unit(uid, bid, f, rng.choice((2, 2, 3, 4)))
                st["units"][str(uid)] = u
                b["units"].append(uid)
        st["buildings"][str(bid)] = b
        buildings.append(b)
        # a path from the door to the courtyard's near edge
        edge = cy1 if by < h // 2 else cy0
        _rect(cells, door[0], min(door[1], edge),
              door[0], max(door[1], edge), "path")

    # --- the perimeter footpath -----------------------------------------
    # The ring road carries the estate's traffic; this is the walk beside
    # it. It sits one cell in from the ring road, leaving the outermost
    # cell of the band for the benches: the path is the walking lane and
    # the seats face back across it to the estate, so a walk out to the
    # edge actually uses the path rather than stepping around it. Without
    # the path the outer band was lawn only — walkable, but nobody's
    # destination.
    if g.get("perimeter_path"):
        inner = rw * 2 + 1
        far_x, far_y = w - rw * 2 - 2, h - rw * 2 - 2
        _rect(cells, inner, inner, far_x, inner, "path")       # north
        _rect(cells, inner, far_y, far_x, far_y, "path")       # south
        _rect(cells, inner, inner, inner, far_y, "path")       # west
        _rect(cells, far_x, inner, far_x, far_y, "path")       # east

    # --- the shop and the playground, apart, either side of the middle ---
    # Where these stand is not decoration. A need is only served if the
    # place that serves it can be *reached*: with the shop at the west end
    # of the courtyard and the playground at the east, the far blocks were
    # 22 cells from food and 18 from play — past the scan — so a whole
    # corner of the estate could not eat, whatever it chose, and the need
    # sat at its ceiling all year. Then both went shoulder to shoulder in
    # the middle, which met the reach and left a wall of shop and swings
    # across the courtyard: no room round either, the tables squeezed
    # against them, and nothing to see past them in the 3D view.
    #
    # Now they stand apart, either side of a clear middle, each with a ring
    # of open paving round it, and each still inside `families.older_range`
    # of *both* doors (the 10-15s go to them alone) — checked below, not
    # trusted:
    #
    #   band      L  :  L          L    :  L   (y = cy0-1: no seat by either)
    #   courtyard ...:.[###]....[pppp]...:...   (the shop; the playground)
    #             ...:.[###]....[pppp]...:...
    #             ~~~~..S..........  ....:...   (S: the shop's door, south)
    #             ~~~~...............  ..:...   (the pond in the west)
    #   band         :             :        :   (y = cy1+1)
    #
    # The middle between them is left open: the walk from the courtyard to
    # the school gate runs down it, and both views look straight through
    # it to the row.
    mid = (cx0 + cx1) // 2
    clear = set()                    # the ring of open paving round each

    def ring(x0, y0, x1, y1):
        return {(x, y) for y in range(y0 - 1, y1 + 2)
                for x in range(x0 - 1, x1 + 2)}

    shop_b = None
    if g["shop"]:
        sx, sy = mid - 4, cy0
        _rect(cells, sx, sy, sx + 2, sy + 1, "building")
        bid = st["next_id"]; st["next_id"] += 1
        # open on the courtyard, facing the school and both views
        shop_b = W.new_building(bid, "The Shop", "shop", sx, sy, 3, 2, 1,
                                (sx + 1, sy + 2))
        st["buildings"][str(bid)] = shop_b
        clear |= ring(sx, sy, sx + 2, sy + 1)

    # --- the pond, and the playground -----------------------------------
    # the pond sits in the courtyard's west, clear of the doors' paths
    if g["pond"]:
        px, py = cx0, cy1 - 1
        _rect(cells, px, py, px + 3, py + 1, "water")
    play_at = None
    if g["playgrounds"]:
        px, py = mid + 3, cy0
        _rect(cells, px, py, px + 3, py + 1, "play")
        play_at = (px, py)
        clear |= ring(px, py, px + 3, py + 1)
    # and the middle between them stays open paving, the way through
    clear |= {(x, y) for y in range(cy0, cy1 + 1)
              for x in range(mid, mid + 2)}

    # --- the school, and the way to the bus -----------------------------
    # The family rules gave the children somewhere they may not go alone
    # and nowhere they must go; the week had weekdays and nothing happened
    # on them. A school and a bus stop are what make a weekday a weekday
    # (engine/daytime.py). Both stand on the open ground *south* of the
    # courtyard, below the row: in front of the blocks as both views look,
    # so nothing tall hides the school run, and off every block's own path.
    #
    #   courtyard ...............................
    #   band             :              :       (y = cy1+1, paths cross it)
    #   gate row         ::::G          :       (door path to the gate G)
    #   school        #######yyyyyy     :       (the school, its fenced yard)
    #                 #######yyyyyy     :
    #   perimeter ::::::::::::::::::::::::::::  (the footpath by the road)
    #   bench row                       S       (S: the bus stop)
    #
    # The gate is on the courtyard's middle, so it is within
    # `families.older_range` of every door in the row: a 10-15 walking
    # home from school is never further out than the rules let them be.
    reserved = set()
    school_b = None
    if g.get("school"):
        sbw, sbh, yw = 7, 4, 6
        sx, sy = mid - sbw + 1, cy1 + 3
        far = h - rw * 2 - 2              # the perimeter path's row
        if sy + sbh > far or sx + sbw + yw > w - rw * 2 - 2 or sx < rw * 2:
            raise ValueError(
                f"the recipe asks for a school but this {w}×{h} plan has no "
                f"room for it south of the courtyard — widen the plan or "
                f"set gen.school to False")
        _rect(cells, sx, sy, sx + sbw - 1, sy + sbh - 1, "building")
        _rect(cells, sx + sbw, sy, sx + sbw + yw - 1, sy + sbh - 1, "yard")
        door = (sx + sbw // 2, sy - 1)
        gate = (sx + sbw, sy - 1)         # in the yard's fence, by the door
        bid = st["next_id"]; st["next_id"] += 1
        school_b = W.new_building(bid, "Highfield School", "school",
                                  sx, sy, sbw, sbh, 2, door)
        school_b["yard"] = [sx + sbw, sy, yw, sbh]
        school_b["gate"] = list(gate)
        st["buildings"][str(bid)] = school_b
        # a path from the courtyard down to the door, and along to the gate
        _rect(cells, door[0], cy1 + 1, door[0], door[1], "path")
        _rect(cells, door[0], door[1], gate[0], gate[1], "path")
        reserved |= {(door[0], cy1 + 1)}
    stop_at = None
    if g.get("bus_stop"):
        # the stop is on the ring road, on the south side, straight down
        # from the east block's door: a path runs from the courtyard to the
        # perimeter footpath, and the stop stands in the band beside the
        # road, where the perimeter's benches stand
        far = h - rw * 2 - 2
        bx = buildings[-1]["door"][0]
        for y in range(cy1 + 1, far):
            if cells[y][bx]["site"] not in ("lawn", "path"):
                raise ValueError(
                    f"the bus stop's path down x={bx} meets "
                    f"{cells[y][bx]['site']!r} at y={y} — the plan has no "
                    f"clear way from the blocks to the road")
        _rect(cells, bx, cy1 + 1, bx, far - 1, "path")
        reserved |= {(bx, cy1 + 1)}
        stop_at = (bx, far + 1)

    # --- the fixtures ---------------------------------------------------
    st["fixtures"] = {}
    taken = set()

    def place(kind, x, y):
        if not (0 <= x < w and 0 <= y < h):
            return None
        if (x, y) in taken:
            return None
        if rules.R["sites"][cells[y][x]["site"]]["walk"] is None and \
                kind != "shop":
            return None
        fid = st["next_id"]; st["next_id"] += 1
        f = W.new_fixture(fid, kind, x, y)
        st["fixtures"][str(fid)] = f
        taken.add((x, y))
        return f

    if play_at:
        place("playground", *play_at)
    if school_b:
        place("school", *school_b["gate"])
    if stop_at:
        place("bus_stop", *stop_at)

    def free(x, y):
        return (0 <= x < w and 0 <= y < h and (x, y) not in taken
                and rules.R["sites"][cells[y][x]["site"]]["walk"] is not None)

    # Candidates are filtered to free ground *before* the quota is taken
    # from them. Iterating unfiltered meant a cell already holding a bench
    # silently ate a lamp's place in the list, and the recipe asked for
    # nine and got seven without a word.
    edge = [(x, y) for y in (cy0 - 1, cy1 + 1)
            for x in range(cx0, cx1 + 1) if free(x, y)]
    rng.shuffle(edge)
    # the school's and the bus stop's paths cross the band: a bench is not
    # put down across a footpath. Dropped *after* the shuffle, so the rest
    # of the band keeps the order (and the seed its cells) it had.
    edge = [p for p in edge if p not in reserved and p not in clear]
    # the tables keep off the open ring round the shop and the playground
    inner = [(x, y) for y in range(cy0, cy1 + 1)
             for x in range(cx0 + 1, cx1)
             if free(x, y) and (x, y) not in clear]
    rng.shuffle(inner)

    plan = (("bench", edge[:g["benches"]]),
            ("lamp", edge[g["benches"]:g["benches"] + g["lamps"]]),
            ("table", inner[:g["tables"]]))
    placed_counts = {}
    for kind, spots in plan:
        placed_counts[kind] = 0
        for x, y in spots:
            if place(kind, x, y):
                placed_counts[kind] += 1

    # trees on the open lawns — everywhere the ground is free
    planted = 0
    tries = 0
    while planted < g["trees"] and tries < 400:
        tries += 1
        x, y = rng.randrange(w), rng.randrange(h)
        if cells[y][x]["site"] != "lawn" or (x, y) in taken \
                or (x, y) in clear:
            continue                   # nor in the ring round the shop
        near = any((x + dx, y + dy) in taken for dx in (-1, 0, 1)
                   for dy in (-1, 0, 1) if (dx or dy))
        if near:
            continue
        if place("tree", x, y):
            planted += 1

    # --- benches along the perimeter footpath ----------------------------
    # The courtyard's benches stand in the bands above and below it; these
    # stand on the outer side of the path that runs beside the ring road,
    # so the estate has furnished edges rather than a green margin nobody
    # stops on. They are spread around all four sides — a quota per side,
    # evenly spaced along it — so a resident leaving any block finds a seat
    # out there, and the walk to it is the stroll. The cell is beside the
    # path and not upon it: a bench on a walkway is an obstacle, not a seat
    # beside it. There is no fresh randomness here: the even spacing and
    # what the trees left free are enough, so the same seed still chooses
    # the same cells. The path is drawn before the trees, which moves the
    # trees; the courtyard's own fixtures keep their places.
    perimeter_benches = g.get("perimeter_benches", 0)
    if perimeter_benches:
        # the outermost cell of the band, between the path and the road, so
        # the walker crosses the path to reach the seat and sits facing the
        # estate. The corners belong to the long sides, so the short sides
        # start a cell later and no two sides can choose the same cell.
        edge = rw * 2
        far_x, far_y = w - rw * 2 - 1, h - rw * 2 - 1
        sides = {
            "top": ([(x, edge) for x in range(edge + 1, far_x)],
                    lambda p: p[0]),
            "bottom": ([(x, far_y) for x in range(edge + 1, far_x)],
                       lambda p: p[0]),
            "left": ([(edge, y) for y in range(edge + 2, far_y - 1)],
                     lambda p: p[1]),
            "right": ([(far_x, y) for y in range(edge + 2, far_y - 1)],
                      lambda p: p[1]),
        }
        order = ("top", "bottom", "left", "right")
        base, extra = divmod(perimeter_benches, len(order))
        quota = {s: base + (1 if i < extra else 0)
                 for i, s in enumerate(order)}
        chosen = []
        for s in order:
            spots = [p for p in sides[s][0] if free(*p)]
            spots.sort(key=sides[s][1])
            want = quota[s]
            if len(spots) < want:
                raise ValueError(
                    f"the recipe asks for {perimeter_benches} perimeter "
                    f"benches but the {s} side holds only {len(spots)} free "
                    f"spots beside the path — widen the plan or lower "
                    f"gen.perimeter_benches")
            # evenly spaced along the side, endpoints included. The spots
            # are already filtered by what the trees left free, so the seed
            # still chooses the exact cell without any fresh randomness.
            for i in range(want):
                t = i / (want - 1) if want > 1 else 0.5
                idx = round(t * (len(spots) - 1))
                chosen.append(spots[idx])
        if len(chosen) != perimeter_benches:
            raise ValueError(
                f"the recipe asks for {perimeter_benches} perimeter benches "
                f"but this plan holds only {len(chosen)} free spots beside "
                f"the path — widen the plan or lower gen.perimeter_benches")
        for x, y in chosen:
            f = place("bench", x, y)
            if f:
                f["perimeter"] = True

    if shop_b:
        place("shop", shop_b["door"][0], shop_b["door"][1])

    # The recipe is a promise. Placing fewer than it asks used to be silent
    # — a lamp aimed at a cell inside a block, a table in the pond — which
    # is the same shape as Grove's unread config (b34): a number that looks
    # like it means something and does not. It fails loudly instead.
    got = {}
    for f in st["fixtures"].values():
        got[f["kind"]] = got.get(f["kind"], 0) + 1
    asked = {"bench": g["benches"] + perimeter_benches, "lamp": g["lamps"],
             "table": g["tables"], "tree": g["trees"],
             "playground": g["playgrounds"] if play_at else 0,
             "shop": 1 if shop_b else 0,
             "school": 1 if school_b else 0,
             "bus_stop": 1 if stop_at else 0}
    short = {k: (v, got.get(k, 0)) for k, v in asked.items()
             if got.get(k, 0) != v}
    if short:
        raise ValueError(
            f"the recipe asks for more than this plan can hold: {short} "
            f"(asked, placed) — widen the plan or lower the recipe")

    _check_reach(st, cells, buildings)
    _check_older(st, buildings)

    st["cells"] = cells

    # --- the first households --------------------------------------------
    st["households"] = {}
    st["residents"] = {}
    units = [u for b in buildings for u in b["units"]
             if st["units"][str(u)]["floor"] <= 4]      # ground floors fill
    rng.shuffle(units)
    founding = []
    for kind, n in g["founding"].items():
        founding += [kind] * n
    rng.shuffle(founding)
    for kind in founding:
        if not units:
            break
        households.move_in(st, kind, st["units"][str(units.pop())], rng)
    # and a waiting list of people outside, wanting a flat
    for _ in range(g["waiting"]):
        st["waiting"].append({"kind": rng.choice(rules.R["pop"]["roster"])})

    for b in buildings:
        rng.shuffle(b["units"])

    st["day"] = 1
    return st


def _reachable(cells, start, goal, limit):
    """Can a walker get from one passable cell to another within `limit`
    steps? Water is not walked on and a building is entered at its door,
    never crossed, so this is a flood over the ground that is walkable."""
    if start == goal:
        return True
    seen = {start}
    frontier = [start]
    for _ in range(limit):
        nxt = []
        for x, y in frontier:
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                p = (x + dx, y + dy)
                if p in seen:
                    continue
                if not (0 <= p[0] < len(cells[0]) and 0 <= p[1] < len(cells)):
                    continue
                if p == goal:
                    return True
                if rules.R["sites"][cells[p[1]][p[0]]["site"]]["walk"] is None:
                    continue
                seen.add(p)
                nxt.append(p)
        frontier = nxt
    return False


def _check_reach(st, cells, buildings):
    """Every door must be able to reach a place that affords each need the
    law claims the estate serves.

    This is the check whose absence let a corner of the estate starve: the
    shop existed, the need existed, and nothing asked whether the two could
    ever meet. It is the plan's own promise, and it fails named rather than
    being discovered as a need pinned at its ceiling a year later.
    """
    scan = rules.R["engine"]["scan"]
    doors = [tuple(b["door"]) for b in buildings]
    for need, spec in rules.R["needs"].items():
        if spec.get("from") == "noise":
            # quiet is filled by the noise where you stand, not by a
            # destination every door must reach. A bench affords a little
            # of it now, but no door is cut off from quiet by distance.
            continue
        goals = [(f["x"], f["y"]) for f in st["fixtures"].values()
                 if rules.R["fixtures"][f["kind"]]["affords"].get(need)]
        if not goals:
            raise ValueError(
                f"this plan places nothing that affords {need!r} — the need "
                f"is in the law and nothing in the estate can meet it")
        for d in doors:
            if not any(_reachable(cells, d, g, scan) for g in goals):
                raise ValueError(
                    f"the door at {d} cannot reach anywhere affording "
                    f"{need!r} within {scan} steps — nobody in that building "
                    f"can meet it, whatever they choose")


def _check_older(st, buildings):
    """The places the 10-15s may go alone (`families.older_places`) must be
    within `families.older_range` of every door, or a whole block's older
    children have a playground on the plan and none they are allowed to.
    Spreading the shop and the playground apart is only allowed as far as
    this holds; it fails named rather than as a need nobody can meet."""
    f = rules.R.get("families")
    if not f:
        return
    doors = [tuple(b["door"]) for b in buildings]
    for kind in f["older_places"]:
        spots = [(x["x"], x["y"]) for x in st["fixtures"].values()
                 if x["kind"] == kind]
        if not spots:
            continue
        for d in doors:
            near = min(abs(x - d[0]) + abs(y - d[1]) for x, y in spots)
            if near > f["older_range"]:
                raise ValueError(
                    f"the door at {d} is {near} cells from the nearest "
                    f"{kind}, past families.older_range "
                    f"({f['older_range']}) — the 10-15s there could never "
                    f"go to one")
