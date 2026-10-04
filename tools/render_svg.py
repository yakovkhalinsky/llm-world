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
from grove import world as W           # noqa: E402

TW, TH, SIDE = 40, 20, 17
PADX, PADY = 30, 78


def jit(seed, salt):
    """A deterministic per-object nudge — the same recipe the page's
    scene uses: the forest is not stamped on a grid."""
    x = math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453
    return x - math.floor(x)

PALETTES = {
    "spring": {"grass": "#6fa053", "soil": "#4a3a29", "water": "#27496b",
               "rock": "#5d6266", "pine": "#2f6038", "leaf": "#6f9f4a"},
    "summer": {"grass": "#5d8f45", "soil": "#45362a", "water": "#2a4d66",
               "rock": "#5a6062", "pine": "#2a5630", "leaf": "#5f9440"},
    "autumn": {"grass": "#9a8a4a", "soil": "#4d3a28", "water": "#284a5e",
               "rock": "#5d6266", "pine": "#2d5035", "leaf": "#b0762f"},
    "winter": {"grass": "#a8b3ad", "soil": "#5a5148", "water": "#31536e",
               "rock": "#68707a", "pine": "#2c4a42", "leaf": "#86775d"},
}

ANIMAL_FILL = {"rabbit": "#9b8d90", "deer": "#a8834f", "fox": "#c26a35",
               "owl": "#8d7358", "robin": "#7d8ba0", "boar": "#5c4a42",
               "stag": "#9a7546", "wolf": "#8a8f94"}


def iso(x, y):
    return (OX + (x - y) * TW / 2, OY + (x + y) * TH / 2)


def poly(pts, fill, opacity=None, stroke=None):
    p = " ".join(f"{a:.1f},{b:.1f}" for a, b in pts)
    op = f' opacity="{opacity}"' if opacity is not None else ""
    st = f' stroke="{stroke}" stroke-width="1"' if stroke else ""
    return f'<polygon points="{p}" fill="{fill}"{op}{st}/>'


def diamond(cx, cy, fill, **kw):
    return poly([(cx, cy - TH / 2), (cx + TW / 2, cy), (cx, cy + TH / 2),
                 (cx - TW / 2, cy)], fill, **kw)


def tree(world, p, pal):
    parts = []
    cx, cy = iso(p["x"], p["y"])
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
    if p["sp"] == "pine":
        for k in range(3):
            wd, h = (11 - k * 3) * scale, (9 - k) * scale
            oy = (7 + k * 4.5) * scale
            parts.append(poly([(cx, cy - oy - h), (cx + wd, cy - oy),
                               (cx - wd, cy - oy)],
                              col))
            parts.append(poly([(cx, cy - oy - h), (cx + wd, cy - oy),
                               (cx + wd*0.12, cy - oy - h*0.3)],
                              "rgba(8,18,14,0.14)"))   # the tier's shade
        if W.season_name(world["tick"]) == "winter":
            parts.append(poly([(cx, cy - 22*scale), (cx + 3.5*scale,
                                                    cy - 17*scale),
                               (cx - 3.5*scale, cy - 17*scale)],
                              "rgba(240,246,250,0.6)"))
    else:
        r = 9.5 * scale
        cyy = cy - trunkH * scale - r * 0.55
        for ex, ey, er in ((0, 0, 1.0), (0.5, 0.3, 0.68),
                           (-0.55, 0.15, 0.6)):
            parts.append(f'<ellipse cx="{cx + ex*r:.1f}" '
                         f'cy="{cyy + ey*r:.1f}" rx="{r*er:.1f}" '
                         f'ry="{r*er*0.72:.1f}" fill="{col}"/>')
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
    cx, cy = iso(a["x"] + 0.0, a["y"] + 0.0)
    cx += (jit(a["id"], 5) - 0.5) * 4      # the flock, too, breathes
    cy += (jit(a["id"], 6) - 0.5) * 3
    js = 0.9 + jit(a["id"], 7) * 0.14
    fill = ANIMAL_FILL.get(a["sp"], "#999")
    body = (f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="{6.4*js:.1f}" '
            f'ry="{4.2*js:.1f}" fill="{fill}"/>')
    sh = (f'<ellipse cx="{cx:.1f}" cy="{cy+2:.1f}" rx="{6*js:.1f}" '
          f'ry="{2.3*js:.1f}" fill="rgba(8,14,11,0.2)"/>')
    return [sh, body]


def main(out):
    db = dbm.DB("grove_data/grove.db")
    world = db.load_world()
    size = world["size"]
    global OX, OY
    span_w = (size - 1) * TW + TW + PADX * 2
    span_h = (size - 1) * TH + TH + PADY * 2
    OX, OY = span_w / 2, PADY
    pal = PALETTES[W.season_name(world["tick"])]

    parts = [f'<rect width="{span_w}" height="{span_h}" fill="#0c1210"/>']

    # terrain
    for y, row in enumerate(world["cells"]):
        for x, c in enumerate(row):
            cx, cy = iso(x, y)
            if c["terrain"] == "water":
                parts.append(diamond(cx, cy, pal["water"]))
            elif c["terrain"] == "rock":
                parts.append(diamond(cx, cy, pal["rock"]))
            else:
                parts.append(diamond(cx, cy, pal["soil"]))
                g = c["grass"]
                if g > 0.06:
                    parts.append(diamond(cx, cy, pal["grass"],
                                         opacity=min(1, g * 0.9)))

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