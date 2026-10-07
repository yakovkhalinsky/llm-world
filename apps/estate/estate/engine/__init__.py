"""The estate's engine, one module per domain, with tick.py as the
conductor. estate/sim.py is this package's face, so the import surface
stays flat for callers.

Domains arrive with their readers: weather and the day's turn first, then
the residents, the fixtures they wear out, the households, and the
watcher's fates. Nothing is stubbed ahead of use — a function with no
caller is Grove's b41 in miniature.
"""

from .weather import roll_weather, update_wet_streak, wetness
from .tick import tick
