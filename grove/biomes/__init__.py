"""The world's biomes: each module here is one pack — its species, its
planting recipe, its words and its colours. rules.select_biome folds a
pack into the live ruleset in place, so the engine's aliases never
rebind and the reviewer's JSON overrides keep stacking above."""

from . import grove
from . import desert

_PACKS = {"grove": grove, "desert": desert}


def load_spec(name):
    """A biome's pack dict; an unknown name is an error, not a grove."""
    if name not in _PACKS:
        raise KeyError(f"no such biome pack: {name!r} "
                       f"(known: {sorted(_PACKS)})")
    return _PACKS[name].SPEC
