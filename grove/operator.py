"""The World Soul: the LLM's role as operator of the grove.

Roughly once every 3–6 weeks of world-time it receives a compact digest
(a few hundred tokens) and returns ONE decision from an enumerated menu.
The engine validates every field and applies the decision deterministically.
The LLM bends the world; it never owns it.
"""

from . import world as W
from .world import plant_counts
from .sim import _pop

MENU = ("storm", "drought", "blight", "bloom", "migration", "visitor",
        "destiny", "quiet")
REGIONS = ("NW", "NE", "SW", "SE", "all")

SYSTEM = (
    "You are the World Soul of a small forest — the slow, fate-bearing "
    "presence behind its weather and fortunes. Every few weeks you are "
    "given a digest of the grove's state and you choose ONE intervention, "
    "as a forest would be fated to receive: sometimes harsh, sometimes "
    "kind, often nothing at all. Read the digest first: help the world "
    "stay balanced (drought after dry weeks is cruel twice).\n"
    "Valid fates: storm (a squall with wind-fall), drought (dry weeks), "
    "blight (a creeping sickness in plants), bloom (grass and berries "
    "surge), migration (a species arrives at the edge), visitor (a lone "
    "stag or passing wolf enters briefly), destiny (mark ONE creature "
    "whose life you will watch), quiet (the soul keeps its peace).\n"
    "For 'destiny' name a creature by the id number from the digest's "
    "'known souls' list, and in 'destiny' write one short prophecy "
    "(under 70 characters) about its life — where it shall go, what it "
    "shall become. The engine keeps the watch and chronicles the "
    "fulfillment.\n"
    "Choose 'region' from NW, NE, SW, SE or all. 'strength' is 1 (mild) "
    "to 3 (severe). 'blight' may name one plant species: pine, birch, "
    "willow, fern, berry. 'migration' may name one animal species: "
    "rabbit, deer, fox, owl, robin, boar. 'visitor' names stag or wolf.\n"
    "In 'intent' write one plain sentence (under 110 characters) saying "
    "what you intend, in the voice of the forest itself.\n"
    'Reply ONLY as JSON: {"action":"...", "region":"...", "strength":1, '
    '"species":null, "target":null, "destiny":null, "intent":"..."}'
)

SCHEMA = {
    "type": "object",
    "properties": {
        "action": {"type": "string",
                   "enum": ["storm", "drought", "blight", "bloom",
                            "migration", "visitor", "destiny", "quiet"]},
        "region": {"type": "string", "enum": ["NW", "NE", "SW", "SE", "all"]},
        "strength": {"type": "integer", "enum": [1, 2, 3]},
        "species": {"type": "string",
                    "enum": ["pine", "birch", "willow", "fern", "berry",
                             "rabbit", "deer", "fox", "owl", "robin",
                             "boar", "stag", "wolf", "none"]},
        "target": {"type": "integer"},
        "destiny": {"type": "string"},
        "intent": {"type": "string"},
    },
    "required": ["action", "region", "strength", "intent"],
}

DESTINY_TRIGGERS = ("rabbit", "deer", "fox", "wolf", "stag", "boar")


def digest(world, recent_lines):
    """A few hundred tokens of world summary for the operator."""
    size, t = world["size"], world["tick"]
    season = W.season_name(t)
    pops = {sp: n for sp, n in
            {k: _pop(world, k) for k in W.ANIMAL_DEFAULT_CAPS}.items()
            if n}
    pc = plant_counts(world)

    quads = {}
    for region in W.REGION_NAMES:
        vals = [world["cells"][y][x]["moisture"]
                for x, y in W.region_cells(size, region)
                if world["cells"][y][x]["terrain"] == "soil"]
        quads[region] = (sum(vals) / len(vals)) if vals else 0.0
    moist = " | ".join(f"{k} {v:.2f}" for k, v in quads.items())

    # souls the operator may single out: named creatures by id, then the
    # oldest unnamed residents — the engine can only watch what it knows
    souls = []
    for a in world["animals"].values():
        nm = world["names"].get(str(a["id"])) or a.get("name")
        if nm:
            souls.append(f"id {a['id']} — {nm} the {a['sp']}, "
                         f"{a['age']:.0f} wks old")
    for a in sorted(known_unnamed(world)[:3],
                    key=lambda x: -x["age"]):
        souls.append(f"id {a['id']} — wild {a['sp']}, {a['age']:.0f} wks old")
    while len(souls) > 6:
        souls.pop()

    elders = []
    for sp, table in W.PLANT_SPECIES.items():
        old = W.oldest_plant(world, sp)
        if old and old["age"] >= table["old_age"]:
            elders.append(f"{sp} (x{old['x']},y{old['y']}) age {old['age']}")
        if len(elders) >= 2:
            break

    effects = [f"{e['kind']} over {e['region']} ({e['ticks']} more weeks)"
               for e in world["effects"]]
    history_raw = world.get("op_history", [])
    history = [f"{h['action']} {h['region']} wk{h['tick']}"
               for h in history_raw]
    lines = recent_lines[-3:] if recent_lines else []

    out = [
        f"Week {t}, {season}, weather {world['weather']}.",
        f"moisture: {moist}",
        "animals: " + (", ".join(f"{k} {v}" for k, v in pops.items()) or "none"),
        "plants: " + (", ".join(f"{k} {v}" for k, v in sorted(pc.items()))
                      or "none"),
        "old trees: " + ("; ".join(elders) if elders else "none"),
        "ongoing: " + ("; ".join(effects) if effects else "none"),
        "recently: " + ("; ".join(history) if history else "nothing yet"),
        "known souls: " + ("; ".join(souls) if souls
                           else "none named yet"),
    ]
    if len(history_raw) >= 3 and \
            len({h["action"] for h in history_raw[-3:]}) == 1:
        out.append(f"You have brought {history_raw[-1]['action']} three "
                   f"times running; something else would serve the grove.")
    if lines:
        out.append("last chronicle:")
        out.extend(f"  - {ln}" for ln in lines)
    return "\n".join(out)


def known_unnamed(world):
    """Living animals without names, oldest first."""
    out = []
    for a in world["animals"].values():
        if not (world["names"].get(str(a["id"])) or a.get("name")):
            if a["sp"] not in ("stag", "wolf"):   # visitors aren't of us
                out.append(a)
    return sorted(out, key=lambda a: -a["age"])
    if lines:
        out.append("last chronicle:")
        out.extend(f"  - {ln}" for ln in lines)
    return "\n".join(out)


def validate(raw):
    """Normalize a model decision into an effect dict (fallback: quiet)."""
    if not isinstance(raw, dict):
        return _quiet("the soul kept its peace")
    action = raw.get("action")
    if action not in MENU:
        return _quiet(str(raw.get("intent") or
                          "the soul kept its peace"))[:180]
    effect = {
        "action": action,
        "region": raw.get("region") if raw.get("region") in REGIONS else "all",
        "strength": raw.get("strength") if raw.get("strength") in (1, 2, 3) else 1,
        "species": raw.get("species") if isinstance(raw.get("species"), str)
                   and raw["species"] != "none" else None,
        "target": raw.get("target") if isinstance(raw.get("target"), int)
                  else None,
        "destiny": str(raw.get("destiny") or "").strip()[:90],
        "intent": str(raw.get("intent") or "").strip()[:140],
    }
    # blight only on plants; migration/visitor only on their animal lists
    if action == "blight" and effect["species"] not in W.PLANT_SPECIES:
        effect["species"] = None
    if action == "migration" and (effect["species"] not in
                                  ("rabbit", "deer", "fox", "owl", "robin",
                                   "boar")):
        effect["species"] = "robin"
    if action == "visitor" and effect["species"] not in ("stag", "wolf"):
        effect["species"] = "stag"
    if action not in ("blight", "migration", "visitor"):
        effect["species"] = None
    return effect


def _quiet(intent):
    return {"action": "quiet", "region": "all", "strength": 1,
            "species": None, "intent": intent}