"""Event handling: which happenings deserve a place in the chronicle."""

# priority tiers for clipping loud weeks (lower is more important)
PRIORITY = {
    "op": 0, "recolonize": 1, "arrival": 1, "turn": 2, "storm": 3,
    "fell": 3, "elder": 4, "predation": 5, "departure": 6,
    "browsed": 7, "birth": 8, "oldage": 9, "starve": 9,
}

MAX_PER_TICK = 10


def notable(events):
    """Filter + clip: the chronicle takes at most MAX_PER_TICK events."""
    # collapse same-species litters born the same week into one event
    collapsed, birth_seen = [], set()
    for e in events:
        if e["kind"] != "birth":
            collapsed.append(e)
            continue
        sp = e.get("sp")
        if sp in birth_seen:
            for prev in collapsed:
                if prev["kind"] == "birth" and prev.get("sp") == sp:
                    prev["n"] = prev.get("n", 1) + e.get("n", 1)
                    prev["kids"] = (prev.get("kids") or []) + \
                        (e.get("kids") or [])
                    break
            continue
        birth_seen.add(sp)
        collapsed.append(e)

    scored = []
    for i, e in enumerate(collapsed):
        kind = e["kind"]
        if kind == "fell" and e.get("sp") not in ("pine", "birch", "willow"):
            continue    # understory lives short; only tree falls are news
        if kind in ("birth", "oldage", "starve") and e.get("sp") and \
                e["sp"] in ("stag", "wolf"):
            continue    # transient visitors don't need birth/death notes
        if kind in PRIORITY:
            scored.append((PRIORITY[kind], i, e))
    scored.sort(key=lambda t: (t[0], t[1]))
    return [e for _, _, e in scored[:MAX_PER_TICK]]


def event_key(e):
    """Stable signature, used for narration caching + db updates."""
    import json
    slim = {k: v for k, v in e.items() if k in
            ("tick", "kind", "sp", "hunter", "plant", "x", "y", "n",
             "action", "region", "strength", "season", "cause", "kids")}
    return json.dumps(slim, sort_keys=True)