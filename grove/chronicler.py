"""Chronicler: turns events into one-line chronicle entries.

Each call narrates ONE event (small models handle single-entry JSONs
far better than arrays and phantom ids). Template lines are what the
world shows instantly; a background LLM call replaces them, and a line
the model got wrong (off-topic, hallucinated, garbage) is discarded.
"""

import json
import re

from . import events as E
from . import world as W

LINE_CAP = 90

_SEASON_LINES = {0: "Spring came to the grove.", 1: "Summer came to the grove.",
                 2: "Autumn came to the grove.",
                 3: "Winter came to the grove."}

SYSTEM = (
    "You are the Chronicler of a living forest. ONE event is given: its "
    "data slot and a plain base sentence. Write ONE improved line (no "
    "more than 88 characters) about the SAME animal or plant in the SAME "
    "place the base sentence names — keep the subject words (species, "
    "creature, pond), reshape the rhythm and verbs. A complete little "
    "sentence; never an ellipsis; never another scene; never coordinates. "
    'Reply ONLY: {"text":"..."}'
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
    """Prepare chronicle items: {key, tick, template, slot}."""
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
        out.append({"key": key, "tick": e["tick"],
                    "template": _line(world, e), "slot": slot})
    return out


def build_prompt(item):
    """item: one batch dict with its eid 'e0'."""
    return ("Grove — one event:\n"
            f"{item['eid']} | "
            f"{json.dumps(item['slot'], separators=(',', ':'))}"
            f" | base: {item['template']}")


_STOP = {"the", "an", "at", "and", "was", "a", "of", "in", "on", "for",
         "with", "from", "by", "its", "his", "her", "into", "over",
         "near", "then", "young", "base", "this", "that", "were", "are"}


def _anchors(base):
    words = base.replace('"', " ").replace(".", " ").replace(",", " ") \
        .replace(";", " ").split()
    return {w for w in words if len(w) >= 3 and w not in _STOP}


def _clean(text):
    text = text.strip().splitlines()[0].rstrip("}").strip()
    if re.search(r"[a-z_]+\s*:\s*[\d\"{]", text):
        return None          # the model restated the data slot, not prose
    if len(text.split()) < 3:
        return None
    if not text:
        return None
    if not text.endswith((".", "!", "?", "…")):
        text += "."
    return text[:LINE_CAP]


def parse_single(result, expected_id, base):
    """The requested line for ONE event: a flat {"text": ...} reply is
    preferred (the shape small models hold best); the older
    {"entries": [...]} shape is accepted too. Anchors decide: a line
    that doesn't speak of the event's subject is discarded."""
    if not isinstance(result, dict):
        return None
    cands = []
    if isinstance(result.get("text"), str) and result["text"].strip():
        text = _clean(result["text"])
        if text and len(text) <= LINE_CAP:
            cands.append((str(expected_id), text))
    entries = result.get("entries")
    if isinstance(entries, list):
        for it in entries:
            if not (isinstance(it, dict) and it.get("text")):
                continue
            text = _clean(str(it["text"]))
            if text and len(text) <= LINE_CAP:
                cands.append((str(it.get("id", "")).strip(), text))
    if not cands:
        return None
    # content words that anchor the line to the event (species, hunter,
    # place); a line with none of these is discarded
    anchors = _anchors(base)
    for eid, text in cands:
        if eid == str(expected_id) and any(a in text for a in anchors):
            return text          # right id and the right subject
    for _eid, text in cands:
        if any(a in text for a in anchors):
            return text          # wrong id, right subject — still usable
    return None                  # off-topic: keep the template