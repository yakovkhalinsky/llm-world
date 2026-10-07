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


def say(ev) -> str:
    """An event as a sentence. This is the ONE home of that wording: the
    digest the watcher reads and the page's feed both take the sentence
    from here, so the estate cannot end up telling a person and a model
    two different stories about the same day."""
    k = ev.get("kind")
    if k == "turn":
        seasons = rules.R["presentation"].get("seasons", ())
        s = seasons[ev["season"]] if ev.get("season") is not None \
            and ev["season"] < len(seasons) else "another season"
        return f"the season turns to {s}"
    if k == "broke":
        return f"a {ev.get('what', 'thing')} broke"
    if k == "tree_down":
        return "a tree came down"
    if k == "storm":
        return "a storm crossed the estate"
    if k == "frost":
        return "ice on the pond"
    if k == "fate":
        return ev.get("say") or f"the watcher sent {ev.get('what')}"
    # the household events. Every kind the engine emits has a sentence
    # here, and a kind without one is a bug this function would hide by
    # printing its own name — which is how `moved_in` reached a chronicle
    # draft as the literal string "moved_in".
    if k == "moved_in":
        return f"a {ev.get('where', 'household')} moves into a flat"
    if k == "born":
        return f"{ev.get('who', 'a child')} is born on the estate"
    if k == "died":
        return f"{ev.get('who', 'someone')} dies"
    if k == "left":
        who = ev.get("who")
        return (f"{who} leaves the estate" if who
                else "a household leaves the estate")
    if k == "grew":
        return f"{ev.get('who', 'someone')} — {ev.get('what', 'a year older')}"
    return str(k)


def header(world) -> str:
    day = world["day"]
    wd = W.weekday_name(day)
    # households, not people — one glyph per household is what the roster
    # law counts, and two types sharing a glyph made the header unreadable
    census = W.counts(world)
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
