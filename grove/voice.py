"""Voice: the LLM names newborns and elder trees — rarely, and short."""

import re

from . import world as W

NAME_RE = re.compile(r"^[A-Za-z][A-Za-z\-]{2,15}$")

SYSTEM = (
    "You are the voice of a forest. You are asked to give one creature or "
    "one old tree a name: a single English word, 3–16 letters, forest-"
    "tasting (moss, bramble, ember, tarn...), not a person's name, not "
    "taken from existing names. Optionally add a one-line 'diary' (under "
    "80 characters) in the voice of the named one. "
    'Reply ONLY as JSON: {"name":"...", "diary":"..."}'
)

SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "diary": {"type": "string"},
    },
    "required": ["name"],
}


def fallback_name(existing, seed, tick):
    """Deterministic pick from the resident name list."""
    used = set(existing)
    rng = W.rng_for(seed, tick, "voice")
    free = [n for n in W.CREATURE_NAMES if n not in used] or W.CREATURE_NAMES
    return rng.choice(free)


def parse(result, fallback, existing):
    """(name, diary) — name validated against the charset rules."""
    name, diary = fallback, ""
    if isinstance(result, dict):
        raw = result.get("name")           # a model's null/None is no name
        parts = raw.strip().split() if isinstance(raw, str) else []
        cand = re.sub(r"[^A-Za-z\-]", "", parts[0]) if parts else ""
        if cand and NAME_RE.match(cand) and cand not in existing:
            name = cand
        diary = str(result.get("diary", "")).strip()[:80]
    return name[0].upper() + name[1:] if name else fallback, diary


def prompt_for(kind, sp):
    if kind == "tree":
        ask = (f"An elder {sp} has grown into its long years, and the "
               f"grove's creatures have decided it deserves a name")
    else:
        ask = f"A newborn {sp} entered the world this week"
    return ask + ". Give it a name."