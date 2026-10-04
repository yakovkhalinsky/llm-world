"""The World Soul: the LLM's role as operator of the grove.

Roughly once every 3–6 weeks of world-time it receives a compact digest
(a few hundred tokens) and returns ONE decision from an enumerated menu.
The engine validates every field and applies the decision deterministically.
The LLM bends the world; it never owns it.
"""

from . import rules
from . import world as W
from .world import plant_counts
from .engine import _pop

MENU = ("storm", "drought", "blight", "bloom", "migration", "visitor",
        "destiny", "quiet")
REGIONS = ("NW", "NE", "SW", "SE", "all")

_SCHEMA_BONES = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": list(MENU)},
        "region": {"type": "string", "enum": list(REGIONS)},
        "strength": {"type": "integer", "enum": [1, 2, 3]},
        "target": {"type": "integer"},
        "destiny": {"type": "string"},
        "intent": {"type": "string"},
    },
    "required": ["action", "region", "strength", "intent"],
}


def system():
    """The World Soul's brief, in the pack's own words."""
    return rules.R["presentation"]["soul_system"]


def schema():
    """The op menu with the pack's own species in the enum."""
    bones = {k: v for k, v in _SCHEMA_BONES["properties"].items()}
    bones["species"] = {"type": "string", "enum":
                        list(rules.R["plants"])
                        + list(rules.R["pop"]["base_residents"])
                        + list(rules.R["pop"]["visitor_species"])
                        + ["none"]}
    return {"type": "object", "properties": bones,
            "required": _SCHEMA_BONES["required"]}



def digest(world, recent_lines):
    """A few hundred tokens of world summary for the operator."""
    size, t = world["size"], world["tick"]
    season = W.season_name(t)
    pops = {sp: n for sp, n in
            {k: _pop(world, k) for k in W.ANIMAL_SPECIES
             if not W.ANIMAL_SPECIES[k].get("visitor")}.items()
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
            if a["sp"] not in rules.R["pop"]["visitor_species"]:
                out.append(a)
    return sorted(out, key=lambda a: -a["age"])


def validate(raw):
    """Normalize a model decision into an effect dict (fallback: quiet)."""
    if not isinstance(raw, dict):
        return _quiet("the soul kept its peace")
    action = raw.get("action")
    if action not in MENU:
        return _quiet(str(raw.get("intent") or
                          "the soul kept its peace")[:180])
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
    if action == "visitor" and effect["species"] not in \
            rules.R["pop"]["visitor_species"]:
        effect["species"] = "stag"
    if action not in ("blight", "migration", "visitor"):
        effect["species"] = None
    return effect


def _quiet(intent):
    return {"action": "quiet", "region": "all", "strength": 1,
            "species": None, "intent": intent}