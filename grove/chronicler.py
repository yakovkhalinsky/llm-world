"""Chronicler: turns events into one-line chronicle entries.

Template lines are computed immediately (they show instantly in the feed);
the LLM versions replace them when a background call succeeds. Both are
cached by event signature so replays cost nothing.
"""

import json

from . import events as E
from . import world as W

LINE_CAP = 90

_SEASON_LINES = {0: "Spring came to the grove.", 1: "Summer came to the grove.",
                 2: "Autumn came to the grove.",
                 3: "Winter came to the grove."}

_SYSTEM = (
    "You are the Chronicler of a living forest. You receive events, each "
    "with an id (e0, e1, ...), a data slot, and a plain 'base' sentence. "
    "For EVERY event return exactly one rewritten line of at most 88 "
    "characters: more vivid than its base, but strictly about the same "
    "happening — never add animals, plants or weather not present in the "
    "data or base. Vary your openings; consecutive lines must not start "
    "the same way or repeat a pattern. Speak of places as they are named "
    "in the data ('the pond's edge', 'the south-east woods') — never use "
    "letter-and-number coordinates. Use the creature or tree name if "
    "given. No moralizing. "
    'Reply ONLY as JSON: {"entries":[{"id":"e0","text":"..."}, ...]}'
)


def _line(world, e):
    """Deterministic fallback line (also fed to the model as its base)."""
    kind = e["kind"]
    sp = e.get("sp")
    is_plant = sp in W.PLANT_SPECIES
    ph = W.PLANT_SPECIES[sp]["desc"] if is_plant else (sp or "grove")
    place = W.place(world, e.get("x"), e.get("y"))
    name = e.get("name") or world["names"].get(str(e.get("plant")))
    plant_label = f"{name} the {ph}" if name else f"the {ph}"

    if kind == "predation":
        hunter = f"An {e['hunter']}" if e["hunter"] == "owl" \
            else f"A {e['hunter']}"
        return f"{hunter} took a wild {sp} at {place}."
    if kind == "birth":
        return f"{e.get('n', 1)} young {sp} born at {place}."
    if kind == "fell":
        cause = {"storm": "The storm", "blight": "A blight", "drought":
                 "The drought", "age": "Great age", "withered": "Slow decline"}
        head = cause.get(e.get("cause"), "Slow decline")
        return f"{head} brought down {plant_label} at {place}."
    if kind == "elder":
        return (f"{name} the {ph} has reached its long years at {place}."
                if name else
                f"One {ph} has reached its long years at {place}.")
    if kind == "oldage":
        art = "An" if sp and sp[0] in "aeiou" else "A"
        return f"{art} wild {sp}, grown old, lay down at {place}."
    if kind == "starve":
        art = "An" if sp and sp[0] in "aeiou" else "A"
        return f"{art} wild {sp} starved at {place}."
    if kind == "browsed":
        return f"A deer browsed a young {ph} at {place}."
    if kind == "picked":
        return f"Berries were picked clean off {plant_label} at {place}."
    if kind == "recolonize":
        return f"{e.get('n', 2)} {sp} slipped in from beyond the forest edge."
    if kind == "arrival":
        return f"A visitor {sp} entered the grove at {place}."
    if kind == "departure":
        return f"The visitor {sp} moved on, beyond the trees."
    if kind == "turn":
        return _SEASON_LINES.get(e.get("season", 0), "A season turned.")
    if kind == "storm":
        return "A squall ran through the trees and was gone."
    if kind == "op":
        return e.get("intent") or f"The world soul kept its peace ({e.get('action')})."
    return f"{kind} in {place}."


def batch(events, world):
    """Prepare a chronicle batch.

    Returns list of dicts: {key, tick, template, slot, place}. The slot for
    prose carries no coordinates — places are named (pond's edge, woods).
    """
    out, seen = [], set()
    for e in events:
        key = E.event_key(e)
        if key in seen:
            continue
        seen.add(key)
        keep = ("tick", "kind", "sp", "hunter", "n", "cause", "season",
                "action", "strength")
        slot = {k: v for k, v in e.items() if k in keep and v is not None}
        slot["place"] = W.place(world, e.get("x"), e.get("y"))
        if e["kind"] == "op":   # regions become spoken places
            slot["place"] = W.PLACE_WORDS.get(e.get("region"), "the grove")
        template = _line(world, e)
        out.append({"key": key, "tick": e["tick"], "template": template,
                    "slot": slot})
    return out


def build_prompt(items):
    items = [dict(it, eid=it.get("eid", f"e{i}"))
             for i, it in enumerate(items)]
    return "Grove — events for the chronicle:\n" + "\n".join(
        f"{it['eid']} | {json.dumps(it['slot'], separators=(',', ':'))}"
        f" | base: {it['template']}" for it in items)


def parse(result, items):
    """Map model output back onto items; text None where the model failed."""
    got = {}
    if isinstance(result, dict):
        for item in result.get("entries", []):
            if isinstance(item, dict) and "id" in item and "text" in item:
                text = str(item["text"]).strip().splitlines()
                if text and 0 < len(text[0]) <= LINE_CAP * 2:
                    got[str(item["id"])] = text[0]
    results = []
    for item in items:
        text = got.get(item["eid"])
        if text:
            text = text.rstrip("}").strip()   # 1B models sometimes leak a '}''
            text = text.rstrip(".") + "." if text and not \
                text.endswith((".", "!", "?", "…")) else text
            if not text:
                text = None
        results.append((item["eid"], text))
    return results