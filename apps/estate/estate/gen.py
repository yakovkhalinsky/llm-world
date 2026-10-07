"""Seeded, deterministic estate generation — pure code, no LLM involved.

Draws a plan, not a landscape: a ring road, four residential blocks facing a
courtyard, a shop, a pond, a playground, and the fixtures and households
that fill them. Everything comes from (seed, 0, "gen") in a fixed order, so
the same seed is the same estate in any process.
"""

from . import world as W
from . import rules

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

    # --- the four blocks, facing the courtyard --------------------------
    bw, bh = 12, 6
    gap = g["block_gap"]
    by_top = rw + rw + gap
    by_bot = h - rw - rw - bh - gap
    bx_left = rw + rw + gap
    bx_right = w - rw - rw - bw - gap - 1
    blocks = []
    for (bx, by) in ((bx_left, by_top), (bx_right, by_top),
                     (bx_left, by_bot), (bx_right, by_bot)):
        if bx + bw >= w - rw or by + bh >= h - rw or bx < rw or by < rw:
            continue                       # too small a plan for four
        blocks.append((bx, by))

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

    # --- the shop, on the courtyard's edge ------------------------------
    shop_b = None
    if g["shop"] and cx0 - 4 >= rw + rw:       # four cells clear of the ring
        sx, sy = cx0 - 4, cy0                 # hard against the courtyard
        _rect(cells, sx, sy, sx + 3, sy + 3, "building")
        bid = st["next_id"]; st["next_id"] += 1
        shop_b = W.new_building(bid, "The Shop", "shop", sx, sy, 4, 4, 1,
                                (sx + 4, sy + 1))    # open on the courtyard
        st["buildings"][str(bid)] = shop_b

    # --- the pond, and the playground -----------------------------------
    if g["pond"]:
        px, py = cx0 + 8, cy0 + 1
        _rect(cells, px, py, px + 3, py + 2, "water")
    play_at = None
    if g["playgrounds"] and cx1 - 8 > cx0 + 12:
        px, py = cx1 - 5, cy0
        _rect(cells, px, py, px + 3, cy1, "play")
        play_at = (px + 1, py + 1)

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
    inner = [(x, y) for y in range(cy0, cy1 + 1)
             for x in range(cx0 + 1, cx1) if free(x, y)]
    rng.shuffle(inner)

    plan = (("bench", edge[:g["benches"]]),
            ("lamp", edge[g["benches"]:g["benches"] + g["lamps"]]),
            ("bin", edge[g["benches"] + g["lamps"]:
                         g["benches"] + g["lamps"] + g["bins"]]),
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
        if cells[y][x]["site"] != "lawn" or (x, y) in taken:
            continue
        near = any((x + dx, y + dy) in taken for dx in (-1, 0, 1)
                   for dy in (-1, 0, 1) if (dx or dy))
        if near:
            continue
        if place("tree", x, y):
            planted += 1

    if shop_b:
        place("shop", shop_b["door"][0], shop_b["door"][1])

    # The recipe is a promise. Placing fewer than it asks used to be silent
    # — a lamp aimed at a cell inside a block, a table in the pond — which
    # is the same shape as Grove's unread config (b34): a number that looks
    # like it means something and does not. It fails loudly instead.
    got = {}
    for f in st["fixtures"].values():
        got[f["kind"]] = got.get(f["kind"], 0) + 1
    asked = {"bench": g["benches"], "lamp": g["lamps"], "bin": g["bins"],
             "table": g["tables"], "tree": g["trees"],
             "playground": g["playgrounds"] if play_at else 0,
             "shop": 1 if shop_b else 0}
    short = {k: (v, got.get(k, 0)) for k, v in asked.items()
             if got.get(k, 0) != v}
    if short:
        raise ValueError(
            f"the recipe asks for more than this plan can hold: {short} "
            f"(asked, placed) — widen the plan or lower the recipe")

    st["cells"] = cells

    # --- the first households --------------------------------------------
    st["households"] = {}
    st["residents"] = {}
    st["names"] = {}
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
        _move_in(st, rng, kind, st["units"][str(units.pop())])
    # and a waiting list of people outside, wanting a flat
    for _ in range(g["waiting"]):
        st["waiting"].append({"kind": rng.choice(rules.R["pop"]["roster"])})

    for b in buildings:
        rng.shuffle(b["units"])

    st["day"] = 1
    return st


def _move_in(st, rng, kind, unit):
    """One household takes a flat: the people are made here, and the unit
    remembers when they came."""
    spec = rules.R["households"][kind]
    hid = st["next_id"]; st["next_id"] += 1
    hh = W.new_household(hid, kind, unit["id"])
    hh["moved_in"] = st["day"]
    unit["household"] = hid
    unit["vacant_since"] = None
    lo, hi = spec["members"]
    n = rng.randint(lo, hi)
    clo, chi = spec["children"]
    kids = rng.randint(clo, chi) if chi else 0
    kids = min(kids, max(0, n - 1))
    for _ in range(n):
        rid = st["next_id"]; st["next_id"] += 1
        age = rng.randint(2, 16) if kids > 0 else rng.randint(19, 78)
        if kids > 0:
            kids -= 1
        r = W.new_resident(rid, hid, age)
        r["where"]["unit"] = unit["id"]
        r["mobility"] = spec.get("mobility", 1.0)
        st["residents"][str(rid)] = r
        hh["members"].append(rid)
    st["households"][str(hid)] = hh
    return hh
