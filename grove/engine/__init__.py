"""The grove's tick engine, one module per domain: weather and cells,
plants and their niches, animals, the population's safety nets, the
operator's fates — and tick.py as the conductor. grove/sim.py is this
package's facade, so every older import still answers."""

from .util import _rules, _clamp, _clamp01, _region_set, _near_water, _pop
from .weather import _roll_weather, _update_cells
from .plants import (build_light, _update_plants, _fell, _seed, _bank,
                     _germinate, _understory_in_cell, _trees_in_cell,
                     _plants_in_cell)
from .animals import _update_animals, _behave, _kill, _litter
from .population import (_check_destinies, _recolonize, _migration)
from .effects import _apply_effect, spawn_animals
from .tick import tick
