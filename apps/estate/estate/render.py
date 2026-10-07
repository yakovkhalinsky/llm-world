"""Terminal rendering: the plan as glyphs, the header, and the day's lines.

The fastest view of the estate, and the first one built — a world you cannot
see is a world you cannot judge (Grove's b26/b48: several bugs were found
only by looking at the artifact).
"""

from . import world as W
from . import rules

WEATHER_GLYPH = {"clear": "☀", "rain": "🌧", "storm": "⛈",
                 "heat": "🔥", "frost": "❄"}

ROLE_GLYPH = {"child": "🧒", "adult": "🧑", "elder": "🧓"}


def site_glyph(site):
    return rules.R["sites"][site]["glyph"]


def fixture_glyph(kind):
    return rules.R["fixtures"][kind]["glyph"]


def header(world) -> str:
    day = world["day"]
    wd = W.weekday_name(day)
    # households, not people — one glyph per household is what the roster
    # law counts, and two types sharing a glyph made the header unreadable
    census = {}
    for h in world["households"].values():
        if world["units"].get(str(h["unit"]), {}).get("household") == h["id"]:
            census[h["kind"]] = census.get(h["kind"], 0) + 1
    kinds = " ".join(f"{rules.R['households'][k]['glyph']}{n}"
                     for k, n in sorted(census.items()) if n)
    return (f"DAY {day} · {W.season_name(day)} · {wd} · "
            f"{WEATHER_GLYPH.get(world['weather'], '')} {world['weather']}"
            f"   {kinds}")


def render_map(world) -> str:
    """One glyph per cell. A person standing somewhere is the most
    interesting thing about that cell, so people win; then a fixture; then
    the ground itself."""
    here = {}
    for r in world["residents"].values():
        if r["where"]["mode"] == "at":
            here.setdefault((r["where"]["x"], r["where"]["y"]), []).append(r)
    fixtures = {}
    for f in world["fixtures"].values():
        fixtures.setdefault((f["x"], f["y"]), f)
    rows = []
    for y in range(world["height"]):
        row = []
        for x in range(world["width"]):
            c = world["cells"][y][x]
            if c["site"] == "building":
                row.append("🏢")
                continue
            if c["site"] == "water":
                row.append("🌊")
                continue
            people = here.get((x, y))
            if people:
                row.append(ROLE_GLYPH[max(
                    (p["role"] for p in people),
                    key=lambda r: ("child", "adult", "elder").index(r))])
                continue
            f = fixtures.get((x, y))
            if f and f["condition"] > 0:
                row.append(fixture_glyph(f["kind"]))
                continue
            row.append(site_glyph(c["site"]))
        rows.append("".join(row))
    return "\n".join(rows)


def line_of(world, text, when) -> str:
    return f"  ▸ {text}  ({when})"


def full(scene) -> str:
    """One frame: the header, the plan, the watcher's word, the day's lines."""
    world = scene["world"]
    parts = [header(world), "", render_map(world), "", scene.get("status", "")]
    if scene.get("watcher_line"):
        parts.append(f"\n ☾ {scene['watcher_line']}")
    rows = scene.get("chronicle", [])
    if rows:
        parts.append("")
        for tick, _source, text in rows:
            ago = world["day"] - tick
            when = "today" if ago <= 0 else f"{ago}d ago"
            parts.append(line_of(world, text, when))
    return "\n".join(f" {ln}" for ln in parts) + "\n"
