"""Chronicler: turns events into one-line chronicle entries.

Each call narrates ONE event. Template lines are deterministic with
variant phrases (no two identical stories read the same way); the LLM's
versions replace them, and both a hallucination filter and an echo
guard keep the chronicle varied.
"""

import json
import re

from . import events as E
from . import world as W

LINE_CAP = 90

_SEASON_LINES = {0: "Spring came to the grove.", 1: "Summer came to the grove.",
                 2: "Autumn came to the grove.",
                 3: "Winter came to the grove."}

_CAUSE_HEADS = {"storm": ("The storm", "The gale", "The wind"),
                "age": ("Great age", "The slow centuries", "Old age"),
                "drought": ("The drought", "The dry weeks"),
                "blight": ("A blight", "The sickness")}
_CAUSE_VERBS = ("brought down", "felled", "took")

_KIND_BONES = {
    "predation": ["{H} took a wild {sp} at {p}.",
                  "{H} caught a wild {sp} at {p}.",
                  "A wild {sp} fell to the {sp2} at {p}."],
    "birth": ["{n} young {sp} {Vb} born at {p}.",
              "{n} {sp} young entered the world at {p}.",
              "Newborn {sp} — {n} appeared at {pp}."],
    "fell": ["{C} {V} {L} at {p}.",
             "At {p}, {Cl} {V} {L}.",
             "{L} {Be} fallen at {p} — {Cl}."],
    "elder": ["{L} has reached its long years at {p}.",
              "Age crowned {L} at {p}.",
              "{L} stood its hundredth season at {p}."],
    "oldage": ["{A} wild {sp}, grown old, lay down at {p}.",
               "A wild {sp} reached the end of its years at {p}.",
               "Time took a wild {sp} gently at {p}."],
    "starve": ["{A} wild {sp} starved at {p}.",
               "Hunger claimed a wild {sp} at {p}.",
               "A wild {sp} wasted to nothing at {p}."],
    "browsed": ["A deer browsed the young {ph} at {p}.",
                "The young {ph} felt a deer's teeth at {p}.",
                "Deer cropped the young {ph} at {p}."],
    "picked": ["Berries were picked clean off {L} at {p}.",
               "{L} gave its berries away at {p}."],
    "recolonize": ["{n} {sp} slipped in from beyond the forest edge.",
                   "From the wilds beyond, {n} {sp} arrived.",
                   "The east wind brought {n} {sp} back to us."],
    "arrival": ["A visitor {sp} entered the grove at {p}.",
                "A {sp} appeared at {p}, then lingered."],
    "departure": ["The visitor {sp} moved on, beyond the trees.",
                  "The {sp} wandered on — the grove is small."],
}

_STOP = {"the", "an", "at", "and", "was", "a", "of", "in", "on", "for",
         "with", "from", "by", "its", "his", "her", "into", "over",
         "near", "then", "young", "base", "this", "that", "were", "are"}

SYSTEM = (
    "You are the Chronicler of a living forest. ONE event is given: its "
    "data slot and a plain base sentence. Write ONE improved line (no "
    "more than 88 characters) about the SAME animal or plant in the SAME "
    "place the base sentence names — keep the subject words (species, "
    "creature, pond), reshape the rhythm and verbs. A complete little "
    "sentence; never an ellipsis; never another scene; never coordinates. "
    "If recent lines are listed at the end, do not repeat their wording "
    "or openings. "
    'Reply ONLY: {"text":"..."}'
)


def _stable(*vals):
    a = 2166136261
    for v in vals:
        for b in str(v).encode():
            a = (a * 16777619 + b) & 0x7fffffff
    return a


def _line(world, e):
    """Deterministic fallback line: variant pools picked stably so the
    same story reads differently across weeks."""
    kind = e["kind"]
    sp = e.get("sp")
    is_plant = sp in W.PLANT_SPECIES
    ph = W.PLANT_SPECIES[sp]["desc"] if is_plant else (sp or "grove")
    place = W.place(world, e.get("x"), e.get("y"))
    name = e.get("name") or world["names"].get(str(e.get("plant")))
    plant_label = f"{name} the {ph}" if name else f"the {ph}"

    if kind == "turn":
        return _SEASON_LINES.get(e.get("season", 0), "A season turned.")
    if kind == "storm":
        return "A squall ran through the trees and was gone."
    if kind == "op":
        return e.get("intent") or f"The world soul kept its peace ({e.get('action')})."
    if kind == "destiny":
        label = f"{e.get('name')} the {sp}" if e.get("name") \
            else f"the wild {sp}"
        return f"As the soul foretold — {label}: {e.get('destiny', '')}"
    if kind == "destiny_lost":
        return "Under the soul's watch, its creature died and the prophecy went unheard."

    pool = _KIND_BONES.get(kind)
    if not pool:
        return f"{kind} in {place}."
    seed, tick = world.get("seed", 0), e.get("tick", 0)
    variant = pool[_stable(seed, tick, sp or 0, len(kind)) % len(pool)]

    A = "An" if sp and sp[0] in "aeiou" else "A"
    H = None
    if kind == "predation":
        hunter = e.get("hunter")
        H = f"An {hunter}" if hunter == "owl" else (f"A {hunter}" if hunter else "Something")
    L = plant_label if is_plant else e.get("name") and f"{e['name']} the {sp}"
    bones_n = e.get("n", 1)
    bones = {"sp": sp, "ph": ph, "p": place, "n": bones_n,
             "A": A, "L": L if L else f"the {ph}",
             "Be": "are" if bones_n > 1 else "is",
             "Vb": "were" if bones_n > 1 else "was",
             "H": H or "It",
             "Cl": (_CAUSE_HEADS.get(
                 e.get("cause") or "age", ("Slow decline",))[0]).lower(),
             "pp": place, "sp2": e.get("hunter", sp), "C": _CAUSE_HEADS.get(
                 e.get("cause") or "age", ("Slow decline",))[0],
             "V": _CAUSE_VERBS[_stable(seed, tick, 7) % len(_CAUSE_VERBS)]}
    if bones_n > 1 and "{L}" in variant and not name:
        plural = ph + ("es" if ph.endswith("h") else "s")
        bones["L"] = f"{bones_n} {plural}" if is_plant else \
            f"{bones_n} wild {plural}"
    line = variant.format(**bones)
    return line[0].upper() + line[1:]


def batch(events, world):
    """Prepare chronicle items: {key, tick, template, slot}."""
    out, seen = [], set()
    for e in events:
        key = E.event_key(e)
        if key in seen:
            continue
        seen.add(key)
        keep = ("tick", "kind", "sp", "hunter", "n", "cause", "season",
                "action", "region", "strength", "destiny")
        slot = {k: v for k, v in e.items() if k in keep and v is not None}
        slot["place"] = W.place(world, e.get("x"), e.get("y"))
        if e["kind"] == "op":   # regions become spoken places
            slot["place"] = W.PLACE_WORDS.get(e.get("region"), "the grove")
        out.append({"key": key, "tick": e["tick"],
                    "template": _line(world, e), "slot": slot})
    return out


def build_prompt(item, recents=()):
    """item: one batch dict with its eid 'e0'; recents: lines to avoid."""
    prompt = ("Grove — one event:\n"
              f"{item['eid']} | "
              f"{json.dumps(item['slot'], separators=(',', ':'))}"
              f" | base: {item['template']}")
    if recents:
        prompt += "\n\nRecent chronicle lines (avoid their wording):\n" + \
                  "\n".join(f" - {r}" for r in recents[-4:])
    return prompt


def _anchors(base):
    words = re.findall(r"[a-z'-]+", base.lower())
    return {w for w in words if len(w) >= 3 and w not in _STOP}


def _is_echo(text, recents):
    """True when the line closely overlaps a recent line (or is equal)."""
    norm = text.strip().lower().rstrip(".!?")
    words = {w for w in re.findall(r"[a-z']+", norm)
             if len(w) > 3 and w not in _STOP}
    for r in recents or ():
        rn = r.strip().lower().rstrip(".!?")
        if rn == norm:
            return True
        rw = {w for w in re.findall(r"[a-z']+", rn)
              if len(w) > 3 and w not in _STOP}
        uni = len(words | rw)
        if uni and len(words & rw) / uni > 0.55:
            return True
    return False


def _clean(text):
    text = text.strip().splitlines()[0].rstrip("}").strip()
    if re.search(r"[a-z_]+\s*:\s*[\d\"{]", text):
        return None          # the model restated the data slot, not prose
    if len(text.split()) < 5:
        return None          # fragments like 'Wisp of pine' are not lines
    if not text:
        return None
    if not text.endswith((".", "!", "?", "…")):
        text += "."
    return text[:LINE_CAP]


def parse_single(result, expected_id, base, recents=None):
    """The requested line: flat {"text": ...} preferred, the older
    {"entries": [...]} accepted; subject anchors + an echo guard
    decide; None when the model is off-topic, repetitive or garbage."""
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
    anchors = _anchors(base)
    for eid, text in cands:
        if eid == str(expected_id) and any(a in text for a in anchors) \
                and not _is_echo(text, recents):
            return text
    for _eid, text in cands:
        if any(a in text for a in anchors) and not _is_echo(text, recents):
            return text
    return None