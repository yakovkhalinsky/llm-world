"""Event handling: which happenings deserve a place in the chronicle,
with same-week same-story events folded into one counted event."""

from . import rules
from . import world as W

# priority tiers for clipping loud weeks (lower is more important)
PRIORITY = {
    "op": 0, "recolonize": 1, "destiny": 1, "arrival": 1,
    "turn": 2, "destiny_lost": 2, "robins_left": 2, "robins_return": 2,
    "germinate": 3,
    "storm": 3,
    "fell": 3, "elder": 4, "predation": 5, "departure": 6,
    "browsed": 7, "picked": 7, "birth": 8, "oldage": 9, "starve": 9,
}

FOLDABLE = ("fell", "predation", "browsed", "picked", "oldage", "starve",
            "birth")


def _fold(events):
    """One line per (kind, species, hunter/cause) story per week; named
    individuals keep their own line — a dead named tree is one tree."""
    collapsed, index = [], {}
    for e in events:
        if e["kind"] in FOLDABLE and not e.get("name"):
            gk = (e["kind"], e.get("sp"), e.get("hunter") or e.get("cause"))
            if gk in index:
                tgt = collapsed[index[gk]]
                tgt["n"] = tgt.get("n", 1) + e.get("n", 1)
                if e.get("kids"):
                    tgt["kids"] = (tgt.get("kids") or []) + e["kids"]
                if e["kind"] == "predation" and e.get("victim"):
                    tgt["victims"] = (tgt.get("victims") or
                                      ([tgt["victim"]] if
                                       tgt.get("victim") else [])) \
                        + [e["victim"]]
                continue
            index[gk] = len(collapsed)
        collapsed.append(e)
    return collapsed


def notable(events):
    """Filter + fold + clip: the chronicle takes a bounded week's worth."""
    scored = []
    for i, e in enumerate(_fold(events)):
        kind = e["kind"]
        # understory lives short; only a pack's own trees falling are news
        if kind == "fell" and W.PLANT_SPECIES.get(
                e.get("sp"), {}).get("kind") != "tree":
            continue
        if kind in ("birth", "oldage", "starve") and e.get("sp") and \
                e["sp"] in ("stag", "wolf"):
            continue    # transient visitors don't need birth/death notes
        if kind in PRIORITY:
            scored.append((PRIORITY[kind], i, e))
    scored.sort(key=lambda t: (t[0], t[1]))
    return [e for _, _, e in scored[:rules.R["pacing"]["chron_max_per_tick"]]]


def event_key(e):
    """Stable signature, used for narration caching + db dedupe."""
    import json
    slim = {k: v for k, v in e.items() if k in
            ("tick", "kind", "sp", "hunter", "plant", "x", "y", "n",
             "action", "region", "strength", "season", "cause", "kids",
             "name", "destiny", "who", "victim", "victims", "hunter_id")}
    return json.dumps(slim, sort_keys=True)