"""The tick engine — one package now (grove/engine), split by domain:
weather and cells, plants and their niches, animals, the population's
safety nets, and the operator's fates. This module keeps the old import
face so every existing caller (grove/app.py, tools/, gen.py) still
answers to grove.sim.tick."""

from .engine import (tick, build_light, _apply_effect, spawn_animals,
                     _bank, _germinate, _update_animals, _behave,
                     _check_destinies, _recolonize, _migration, _pop)