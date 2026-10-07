"""The estate's law — every number that runs the world, in one dict.

`rules.R` is the live ruleset the engine reads *at the moment of use*.
Nothing in the code may hold a second copy of a value that lives here
(Grove's b34/b35: knobs that existed, merged from JSON, and did nothing).

A pack is folded in place, so the engine's aliases never rebind. A JSON
override merges over the result, so a world may keep its own constitution.

**No integer keys, anywhere.** JSON object keys are strings whatever they
went in as, and a table holding both is how Grove's saved constitution came
back with four keys twice, then died half-written (b52). Seasonal tables are
keyed by strings and converted at read time by `intkey`.
"""

import copy
import json


# The base law. Sections the *engine* owns are filled in here; the sections
# that are a world's *nature* are empty until a pack arrives.
R = {
    # the world's shape and calendar — a pack ships these
    "world": {},

    # the ground, the needs, the fixtures, the households, the recipe:
    # a pack ships these whole, so the dict must exist to be filled
    "sites": {}, "needs": {}, "fixtures": {},
    "households": {}, "people": {}, "gen": {},
    "presentation": {}, "pop": {}, "weather": {}, "gate": {},

    # what the engine itself owns: the numbers that are the machinery
    # rather than the world, and that no pack should have to restate
    "engine": {
        "scan": 16,              # how far a resident will look for a place
        "steps_per_phase": 6,    # cells a resident covers in one phase
        "congestion": 1.0,       # k in capacity/(capacity + k*occupancy)
        "arrive_restore": 1.0,   # how much of a need one visit lifts
        "stress_line": 2.6,      # pressure at which a person starts to fray
        "stress_decay": 0.90,    # how fast that frays away again
        "busy_wear": 3.0,        # how much harder use wears a fixture
        "repair": 0.0,           # set by a fate; residents do not yet mend
    },

    "pacing": {
        "day_seconds": {"run": 6.0, "web": 6.0},
        "watcher_gap": (60, 120),      # wall seconds between invitations
        "watcher_gap_cloud": (40, 80),
        "reprobe_seconds": 900,        # before retrying the chosen voice
        "naming_budget_per_day": 2,
        "chronicle_need": 3,
    },

    # the lawful band for each amendable path; empty until a steward exists
    "bounds": {},
}

# Sections a pack ships WHOLE rather than merging into. A pack that names the
# ground means all of the ground, not a patch over another world's.
_WHOLE = ("sites", "needs", "fixtures", "households", "people", "gen")

_PACKS = {}
_ACTIVE = None


def register(name, spec):
    """A biome module hands its SPEC here at import."""
    _PACKS[name] = spec


def load_spec(name):
    if name not in _PACKS:
        raise KeyError(f"no such biome pack: {name!r} "
                       f"(known: {sorted(_PACKS)})")
    return _PACKS[name]


def select_biome(name):
    """Fold a pack into the live ruleset in place, and remember which
    nature now holds. Sections named in _WHOLE replace; the rest merge."""
    global _ACTIVE
    spec = load_spec(name)
    for section, values in spec.items():
        if section not in R:
            raise KeyError(
                f"the pack {name!r} carries a section the ruleset has no "
                f"home for: {section!r} — a value nothing reads is a bug "
                f"(b34), so this is an error rather than a silent merge")
        if section in _WHOLE:
            R[section].clear()
        R[section].update(copy.deepcopy(values))
    _ACTIVE = name
    return name


def active_biome():
    return _ACTIVE


def intkey(d):
    """Season keys arrive as strings from JSON; the engine wants ints. One
    place does the conversion, so no table ever holds both."""
    return {int(k): v for k, v in (d or {}).items()}


def load_override(path):
    """Merge a JSON rules file over the live ruleset, in place."""
    with open(path) as f:
        given = json.load(f)

    def merge(dst, src):
        for k, v in src.items():
            if isinstance(v, dict) and isinstance(dst.get(k), dict):
                merge(dst[k], v)
            else:
                dst[k] = copy.deepcopy(v)

    merge(R, given)
    return given


def dump_template(path):
    with open(path, "w") as f:
        json.dump(R, f, indent=1, sort_keys=True, default=str)
    return path


# The packs arrive at the bottom, after R exists, and the estate's nature is
# folded in with the import — exactly as Grove's grove pack is.
from .biomes import estate as _estate          # noqa: E402

register("estate", _estate.SPEC)
select_biome("estate")
