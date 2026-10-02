"""Terminal rendering: emoji map, status header, chronicle feed."""

ANIMAL_EMOJI = {
    "rabbit": "🐇", "deer": "🦌", "fox": "🦊", "owl": "🦉",
    "robin": "🐦", "boar": "🐗", "stag": "🦌", "wolf": "🐺",
}

WEATHER_EMOJI = {"clear": "☀", "rain": "🌧", "storm": "⛈", "frost": "❄"}

SEASON_LABEL = {0: "SPRING", 1: "SUMMER", 2: "AUTUMN", 3: "WINTER"}

BLOCKS = "▁▂▃▄▅▆▇█"


def _tile(world, x, y, animals_at, plants_at):
    c = world["cells"][y][x]
    if c["terrain"] == "water":
        return "🌊"
    here = animals_at.get((x, y), ())
    # flyers float above the canopy
    for a in here:
        if a["sp"] in ("robin", "owl"):
            return ANIMAL_EMOJI[a["sp"]]
    # canopy wins the tile from ground animals
    for p in plants_at.get((x, y), ()):
        if p["stage"] in ("mature", "old"):
            return "🌲" if p["sp"] == "pine" else "🌳"
    for a in here:
        return ANIMAL_EMOJI[a["sp"]]
    # understory
    top = None
    for p in plants_at.get((x, y), ()):
        if p["stage"] == "log":
            return "🪵"
        if p["stage"] == "sapling":
            top = "🌱"
        elif p["sp"] == "berry":
            top = "🫐" if p.get("berries") else "🍀"
        elif p["sp"] == "fern" and top != "🌱":
            top = "🌿"
    if top:
        return top
    if c["mushroom"]:
        return "🍄"
    if c["carcass"]:
        return "🦴"
    if c["grass"] > 0.5:
        return "🟩"
    if c["grass"] > 0.15:
        return "🟨"
    return "🟫"


def _animals_at(world):
    at = {}
    for a in world["animals"].values():
        at.setdefault((a["x"], a["y"]), []).append(a)
    return at


def render_map(world):
    size = world["size"]
    at = _animals_at(world)
    pat = {}
    for p in world["plants"].values():
        pat.setdefault((p["x"], p["y"]), []).append(p)
    rows = []
    for y in range(size):
        rows.append("".join(_tile(world, x, y, at, pat) + " "
                            for x in range(size)))
    return "\n".join(rows)


def header(world):
    t = world["tick"]
    season = W_season(world)
    pops = {sp: 0 for sp in ANIMAL_EMOJI if sp not in ("stag", "wolf")}
    for a in world["animals"].values():
        if a["sp"] in pops:
            pops[a["sp"]] += 1
    pop_line = " ".join(f"{ANIMAL_EMOJI[sp]}{n}" for sp, n in pops.items()
                        if n)
    weather = WEATHER_EMOJI.get(world["weather"], "")
    return (f"WEEK {t} · {season} · {weather} {world['weather']}   "
            f"{pop_line}")


def W_season(world):
    i = ((world["tick"] - 1) // 12) % 4
    return SEASON_LABEL[i]


def chronicle_block(world, rows, width=64):
    out = []
    for tick, source, text in rows:
        ago = world["tick"] - tick
        when = "now" if ago <= 0 else f"{ago}wk ago"
        out.append(f"  ▸ {text[:width]}  ({when})")
    return "\n".join(out)


def spark(series, cap):
    if not series:
        return ""
    peak = max(max(series), cap, 1)
    return "".join(BLOCKS[min(7, int(v * 8 / peak))] for v in series)


def full(scene):
    """Assemble one frame. scene dict: world, chron_rows, soul_line, llm_status,
    paused."""
    world = scene["world"]
    parts = [header(scene["world"]), "", render_map(world), "", scene.get(
        "status", "")]
    soul = scene.get("soul_line")
    if soul:
        parts.append(f"\n ☾ SOUL ▸ {soul}")
    rows = scene.get("chron_rows", [])
    parts.append("")
    parts.append(chronicle_block(world, rows))
    return "\n".join(f" {ln}" for ln in parts) + "\n"