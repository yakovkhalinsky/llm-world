"""The conductor: one day on the estate, in its honest order.

The order matters and is not arbitrary — the environment is settled before
anyone reads it, and anything with a lifetime is aged before the next one
lands (Grove's b30: a fate that wrote its span and was never counted).
"""

from .. import world as W
from .weather import roll_weather, update_wet_streak


def tick(w) -> list:
    """Advance one day. Returns the day's events, all kinds."""
    evs = []
    w["day"] += 1
    t = w["day"]

    # 1. the day turns; a season turn is news
    prev, now = W.season_index(t - 1), W.season_index(t)
    if now != prev:
        evs.append({"day": t, "kind": "turn", "season": now})

    # 2. the sky, and the estate's memory of it
    roll_weather(w, evs)
    update_wet_streak(w)

    return evs
