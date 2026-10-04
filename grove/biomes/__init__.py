"""The world's biomes: each module here is one pack — its species, its
planting recipe, and (per pack) its words and colours. rules.select_biome
folds a pack into the live ruleset in place, so the engine's aliases
never rebind and the reviewer's JSON overrides keep stacking above."""

from . import grove

_PACKS = {"grove": grove}


def load_spec(name):
    """A biome's pack dict; an unknown name lands home in the grove."""
    return _PACKS.get(name, grove).SPEC
