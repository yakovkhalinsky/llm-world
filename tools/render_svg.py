"""Render the current world as an isometric SVG (a static twin of the
dashboard's canvas scene, for the README).

  python3 tools/render_svg.py [out.svg]      # reads ./grove_data/grove.db
"""

import json
import math
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from grove import db as dbm            # noqa: E402
from grove import rules                # noqa: E402
from grove import world as W           # noqa: E402

TW, TH, SIDE = 40, 20, 17
PADX, PADY = 30, 78


def jit(seed, salt):
    """A deterministic per-object nudge — the same recipe the page's
    scene uses: the forest is not stamped on a grid."""
    x = math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453
    return x - math.floor(x)

# the fallback: what the scene drew before the twin learned to read the
# pack. The real palettes come from the world's own tables — the same
# seasons the page draws with — so a desert renders as a desert.
PALETTES = {
    "spring": {"grass": "#6fa053", "soil": "#4a3a29", "water": "#27496b",
               "rock": "#5d6266", "pine": "#2f6038", "leaf": "#6f9f4a",
               "under": "#3f6d38", "canopyDim": 1.0},
    "summer": {"grass": "#5d8f45", "soil": "#45362a", "water": "#2a4d66",
               "rock": "#5a6062", "pine": "#2a5630", "leaf": "#5f9440",
               "under": "#3f6d38", "canopyDim": 1.0},
    "autumn": {"grass": "#9a8a4a", "soil": "#4d3a28", "water": "#284a5e",
               "rock": "#5d6266", "pine": "#2d5035", "leaf": "#b0762f",
               "under": "#4a5c33", "canopyDim": 1.0},
    "winter": {"grass": "#a8b3ad", "soil": "#5a5148", "water": "#31536e",
               "rock": "#68707a", "pine": "#2c4a42", "leaf": "#86775d",
               "under": "#54724e", "canopyDim": 0.85},
}

ANIMAL_FILL = {"rabbit": "#9b8d90", "deer": "#a8834f", "fox": "#c26a35",
               "owl": "#8d7358", "robin": "#7d8ba0", "boar": "#5c4a42",
               "stag": "#9a7546", "wolf": "#8a8f94"}

PALETTE_KEYS = ("grass", "soil", "water", "rock", "pine", "leaf",
                "under", "canopyDim")


def palettes():
    """The pack's seasons, over the fallback; the twin draws with the
    same table the page draws with."""
    src = rules.R["presentation"].get("seasons_palette") or {}
    out = {}
    for season, literal in PALETTES.items():
        got = src.get(season) or {}
        out[season] = {k: got.get(k, literal[k]) for k in PALETTE_KEYS}
    return out


def animal_body():
    got = rules.R["presentation"].get("animal_body") or {}
    out = dict(ANIMAL_FILL)
    out.update(got)
    return out


EPX = 26                       # the pack's relief scale, read in main()


def elev_px_of():
    return rules.R["presentation"].get("elev_px", 26)


def iso_e(world, x, y):
    """iso with the land raised: the world's own elev, drawn."""
    cx, cy = iso(x, y)
    e = max(0, (world["cells"][y][x].get("elev", 0) or 0))
    return cx, cy - e * EPX


def iso(x, y):
    return (OX + (x - y) * TW / 2, OY + (x + y) * TH / 2)


def poly(pts, fill, opacity=None, stroke=None):
    p = " ".join(f"{a:.1f},{b:.1f}" for a, b in pts)
    op = f' opacity="{opacity}"' if opacity is not None else ""
    st = f' stroke="{stroke}" stroke-width="1"' if stroke else ""
    return f'<polygon points="{p}" fill="{fill}"{op}{st}/>'


def path(d, stroke, width=1):
    return (f'<path d="{d}" fill="none" stroke="{stroke}" '
            f'stroke-width="{width}"/>')


def blob(cx, cy, rx, ry, fill, opacity=None):
    op = f' opacity="{opacity}"' if opacity is not None else ""
    return (f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="{rx:.1f}" '
            f'ry="{ry:.1f}" fill="{fill}"{op}/>')


def quad(ux, uy, h, stroke):
    """A blade, a reed: a quadratic stem standing in the ground."""
    return path(f"M {ux:.1f},{uy + 3:.1f} Q {ux + 2:.1f},{uy - 1:.1f} "
                f"{ux + 1.4:.1f},{uy - h:.1f}", stroke)


def diamond(cx, cy, fill, **kw):
    return poly([(cx, cy - TH / 2), (cx + TW / 2, cy), (cx, cy + TH / 2),
                 (cx - TW / 2, cy)], fill, **kw)


def tree(world, p, pal):
    parts = []
    cx, cy = iso_e(world, p["x"], p["y"])
    cx += (jit(p["id"], 1) - 0.5) * 6      # a breath off-centre,
    cy += (jit(p["id"], 2) - 0.5) * 4      # each at its own size
    scale = (1.0 if p["stage"] == "mature" else
             1.1 if p["stage"] == "old" else 0.55)
    if p["id"] in world["elder_ids"]:
        scale *= 1.12
    scale *= (0.92 + jit(p["id"], 3) * 0.16)
    # ground shadow
    parts.append(f'<ellipse cx="{cx:.1f}" cy="{cy+2:.1f}" '
                 f'rx="{9*scale:.1f}" ry="{3.4*scale:.1f}" '
                 f'fill="rgba(8,14,11,0.18)"/>')
    parts.append(f'<polygon points="{cx-TW/2:.1f},{cy:.1f} {cx:.1f},'
                 f'{cy-TH/2:.1f} {cx+TW/2:.1f},{cy:.1f} {cx:.1f},{cy+TH/2:.1f}"'
                 f' fill="rgba(8,14,11,0.08)"/>')   # the weight's shade
    trunk = {"birch": "#d9d4c9", "willow": "#8a7663"}.get(p["sp"], "#5b422f")
    trunkH = 7 if p["sp"] == "pine" else 10
    tw = 3
    parts.append(poly([(cx - tw*0.8, cy), (cx - tw*0.3, cy - trunkH*scale),
                       (cx + tw*0.3, cy - trunkH*scale),
                       (cx + tw*0.8, cy)], trunk))
    col = pal["pine"] if p["sp"] == "pine" else pal["leaf"]
    dim = pal.get("canopyDim", 1.0) or 1.0     # winter thins the canopy
    if p["sp"] == "pine":
        for k in range(3):
            wd, h = (11 - k * 3) * scale, (9 - k) * scale
            oy = (7 + k * 4.5) * scale
            parts.append(poly([(cx, cy - oy - h), (cx + wd, cy - oy),
                               (cx - wd, cy - oy)], col, opacity=dim))
            parts.append(poly([(cx, cy - oy - h), (cx + wd, cy - oy),
                               (cx + wd*0.12, cy - oy - h*0.3)],
                              "rgba(8,18,14,0.14)", opacity=dim))
        if W.season_name(world["tick"]) == "winter":
            parts.append(poly([(cx, cy - 22*scale), (cx + 3.5*scale,
                                                    cy - 17*scale),
                               (cx - 3.5*scale, cy - 17*scale)],
                              "rgba(240,246,250,0.6)"))
    else:
        r = 9.5 * scale
        cyy = cy - trunkH * scale - r * 0.55
        parts.append(f'<ellipse cx="{cx + 0*r:.1f}" '
                     f'cy="{cyy:.1f}" rx="{r:.1f}" '
                     f'ry="{r*0.72:.1f}" fill="{col}" '
                     f'opacity="{dim:.2f}"/>')
        for ex, ey, er in ((0.5, 0.3, 0.68), (-0.55, 0.15, 0.6)):
            parts.append(f'<ellipse cx="{cx + ex*r:.1f}" '
                         f'cy="{cyy + ey*r:.1f}" rx="{r*er:.1f}" '
                         f'ry="{r*er*0.72:.1f}" fill="{col}" '
                         f'opacity="{dim*0.85:.2f}"/>')
        parts.append(f'<ellipse cx="{cx - r*0.42:.1f}" '
                     f'cy="{cyy - r*0.34:.1f}" rx="{r*0.5:.1f}" '
                     f'ry="{r*0.36:.1f}" fill="rgba(255,244,200,0.13)"/>')
        parts.append(f'<ellipse cx="{cx + r*0.3:.1f}" '
                     f'cy="{cyy + r*0.42:.1f}" rx="{r*0.72:.1f}" '
                     f'ry="{r*0.4:.1f}" fill="rgba(10,20,14,0.16)"/>')
        if p["sp"] == "willow":
            for k in range(-2, 3):
                x0, y0 = cx + k * 3, cyy + r * 0.3
                x1, y1 = cx + k * 7, cyy + r * 1.6
                parts.append(f'<path d="M {x0:.1f} {y0:.1f} '
                             f'Q {cx + k*5.5:.1f} {cyy + r*0.9:.1f} '
                             f'{x1:.1f} {y1:.1f}" stroke="{col}" '
                             f'fill="none" stroke-width="1.3"/>')
    name = world["names"].get(str(p["id"]))
    if name and p["stage"] in ("old",):
        parts.append(f'<text x="{cx:.0f}" y="{cy - trunkH*2-16*scale:.0f}" '
                     f'font-size="9" font-style="italic" '
                     f'text-anchor="middle" fill="#dfe9db">{name}</text>')
    return parts


def creature(world, a, pal):
    cx, cy = iso_e(world, a["x"], a["y"])
    cx += (jit(a["id"], 5) - 0.5) * 4      # the flock, too, breathes
    cy += (jit(a["id"], 6) - 0.5) * 3
    js = 0.9 + jit(a["id"], 7) * 0.14
    fill = ANIMAL_FILL.get(a["sp"], "#999")
    body = (f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="{6.4*js:.1f}" '
            f'ry="{4.2*js:.1f}" fill="{fill}"/>')
    sh = (f'<ellipse cx="{cx:.1f}" cy="{cy+2:.1f}" rx="{6*js:.1f}" '
          f'ry="{2.3*js:.1f}" fill="rgba(8,14,11,0.2)"/>')
    return [sh, body]


def reflections(world, pal):
    """The mirrored world: shore plants lean into the water below them,
    upside down and quiet, clipped inside the tile they lean on."""
    parts, at, size = [], {}, world["size"]
    for t in world["plants"].values():
        at[(t["x"], t["y"])] = t
    for y, row in enumerate(world["cells"]):
        for x, c in enumerate(row):
            if c["terrain"] != "water":
                continue
            for nx, ny in ((x - 1, y), (x, y - 1)):
                t = at.get((nx, ny))
                if not t or t["stage"] == "log":
                    continue
                cx, cy = iso_e(world, x, y)
                tx, ty = cx + (nx - x) * TW / 4, cy - TH * 0.1
                col = pal["pine"] if t["sp"] == "pine" else pal["leaf"]
                cid = f"w{x}-{y}-{nx}-{ny}"
                parts.append(
                    f'<clipPath id="{cid}"><polygon points='
                    f'"{cx-TW/2:.1f},{cy:.1f} {cx:.1f},{cy-TH/2:.1f} '
                    f'{cx+TW/2:.1f},{cy:.1f} {cx:.1f},{cy+TH/2:.1f}"/>'
                    f'</clipPath>')
                if t["sp"] == "pine":
                    lean = (f'<polygon points="0,-15 7,0 -7,0" '
                            f'fill="{col}"/>')
                else:
                    lean = (f'<ellipse cx="0" cy="-7" rx="7.5" ry="5" '
                            f'fill="{col}"/>'
                            f'<rect x="-1" y="-1" width="2" height="5" '
                            f'fill="{col}"/>')
                parts.append(f'<g clip-path="url(#{cid})">'
                             f'<g transform="translate({tx:.1f},{ty:.1f}) '
                             f'scale(1,-0.5)" opacity="0.09">{lean}</g></g>')
    return parts


def glint(world):
    """Moonlight finds the water: a shimmer column over the pond's heart."""
    size = world["size"]
    xi = yi = n = 0
    for y, row in enumerate(world["cells"]):
        for x, c in enumerate(row):
            if c["terrain"] == "water":
                xi += x; yi += y; n += 1
    if not n:
        return []
    gx, gy = iso(xi / n, yi / n)
    return [path(f"M {gx+(k-1.5)*9-5:.1f},{gy+(k-1.5)*5:.1f} "
                 f"L {gx+(k-1.5)*9+5:.1f},{gy+(k-1.5)*5:.1f}",
                 "rgba(210,228,246,0.14)", 1.4) for k in range(4)]


def cloud_shadows(span_w, span_h):
    """The sky's weather drifts across the ground itself, faint."""
    return [blob(span_w * (0.22 + 0.28 * k), span_h * (0.30 + 0.18 * k),
                 120 + k * 36, 26, "rgba(10,16,13,0.05)")
            for k in range(3)]


def main(out):
    db = dbm.DB("grove_data/grove.db")
    world = db.load_world()
    size = world["size"]
    global OX, OY
    span_w = (size - 1) * TW + TW + PADX * 2
    span_h = (size - 1) * TH + TH + PADY * 2
    OX, OY = span_w / 2, PADY
    global EPX
    EPX = elev_px_of()
    global ANIMAL_FILL
    ANIMAL_FILL = animal_body()
    pal = palettes()[W.season_name(world["tick"])]

    parts = [f'<rect width="{span_w}" height="{span_h}" fill="#0c1210"/>']

    # terrain — the living ground on its own landform: tufts, pebbles,
    # wet rims, reeds, and the walls where the land steps down
    for y, row in enumerate(world["cells"]):
        for x, c in enumerate(row):
            i = y * size + x
            cx, cy = iso_e(world, x, y)
            eMe = max(0, (c.get("elev", 0) or 0))
            if c["terrain"] == "water":
                parts.append(diamond(cx, cy, pal["water"]))
            elif c["terrain"] == "rock":
                parts.append(diamond(cx, cy, pal["rock"]))
                for u in range(3):              # pebbles, and a crack
                    parts.append(blob(cx + ((i * 23 + u * 41) % 17 - 8) * 0.9,
                                      cy + ((i * 37 + u * 19) % 11 - 5) * 0.6,
                                      1.6, 1.1, "rgba(255,255,255,0.10)"))
                parts.append(path(f"M {cx-6:.1f},{cy+1:.1f} "
                                  f"L {cx+3-(i%5):.1f},{cy-2-(i%3):.1f}",
                                  "rgba(0,0,0,0.14)"))
            else:
                parts.append(diamond(cx, cy, pal["soil"]))
                g = c["grass"]
                if g > 0.06:
                    parts.append(diamond(cx, cy, pal["grass"],
                                         opacity=min(1, g * 0.9)))
                if g > 0.45:                    # tufts of tall grass
                    for u in range(2 + i * 7 % 3):
                        parts.append(quad(cx + ((i * 31 + u * 13) % 21 - 10)
                                          * 0.8,
                                          cy + ((i * 17 + u * 29) % 13 - 6)
                                          * 0.5,
                                          5 + u * 1.6, pal["grass"]))
            walls = []                          # SE in sun, SW in shade
            dX = (eMe - (max(0, world["cells"][y][x + 1].get("elev", 0) or 0)
                         if x < size - 1 else 0)) * EPX
            if dX > 1:
                walls.append(poly(
                    [(cx + TW / 2, cy), (cx, cy + TH / 2),
                     (cx, cy + TH / 2 + dX), (cx + TW / 2, cy + dX)],
                    "#4a392a"))
            dY = (eMe - (max(0, world["cells"][y + 1][x].get("elev", 0) or 0)
                         if y < size - 1 else 0)) * EPX
            if dY > 1:
                walls.append(poly(
                    [(cx, cy + TH / 2), (cx - TW / 2, cy),
                     (cx - TW / 2, cy + dY), (cx, cy + TH / 2 + dY)],
                    "#3a2d20"))
            parts += walls
            if c["terrain"] != "water":
                nbrs = [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
                wet = any(0 <= nx < size and 0 <= ny < size and
                          world["cells"][ny][nx]["terrain"] == "water"
                          for nx, ny in nbrs)
                if wet:
                    parts.append(diamond(cx, cy, "rgba(24,20,12,0.16)"))
                    if c["grass"] < 0.5 and i * 13 % 3 != 2:
                        for u in range(3):      # reeds at the shore
                            ux = cx + ((i * 23 + u * 41) % 17 - 8) * 0.75
                            h2 = 5 + (i * 11 + u * 7) % 4
                            parts.append(quad(ux, cy, h2,
                                              pal.get("under",
                                                      "#3f6d38")))
                            parts.append(f'<rect x="{ux + 0.7:.1f}" '
                                         f'y="{cy - h2 - 2.4:.1f}" width="1.2" '
                                         f'height="2.4" fill="#6b4a33"/>')
                    else:                       # or holds a stone
                        parts.append(blob(cx + (i * 19 % 9 - 4),
                                          cy + (i * 7 % 5 - 2) * 0.6,
                                          2.4, 1.5, "rgba(94,98,102,0.6)"))

    parts += cloud_shadows(span_w, span_h)
    parts += reflections(world, pal)
    parts += glint(world)

    # entities, depth-sorted
    ents = [(p["x"] + p["y"], 0, ("plant", p)) for p in world["plants"].values()]
    ents += [(a["x"] + a["y"], 1, ("animal", a))
             for a in world["animals"].values()]
    ents.sort(key=lambda t: (t[0], t[1]))
    for _d, _k, (kind, ent) in ents:
        if kind == "plant":
            parts += tree(world, ent, pal)
        else:
            parts += creature(world, ent, pal)

    parts.append(f'<text x="{OX}" y="{span_h - 8}" font-family="Georgia" '
                 f'font-size="13" text-anchor="middle" fill="#7d9285">'
                 f'week {world["tick"]} · '
                 f'{W.season_name(world["tick"])} · seed {world["seed"]}'
                 f'</text>')

    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
           'viewBox="0 0 %d %d">' % (span_w, span_h, span_w, span_h)
           + "".join(parts) + "</svg>")
    pathlib.Path(out).write_text(svg)
    print(f"{out}: {len(svg)//1024} KiB, week {world['tick']}, "
          f"{len(world['plants'])} plants, {len(world['animals'])} animals")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "docs/grove.svg")