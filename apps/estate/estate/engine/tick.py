"""The conductor: one day on the estate, in its honest order.

The order is not arbitrary. The ground and the sky are settled before
anyone reads them; anything with a lifetime is aged before the next lands;
nobody chooses a place until the day's noise and shade exist, because those
are part of what a place *is* today; and the people act before the
households are settled, so a vacancy made today is let tomorrow rather than
refilled the same evening.
"""

from .. import world as W
from . import effects
from . import households
from . import places
from . import residents
from . import trees
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

    # 2. the fates that are already in force lose a day — before the new
    #    one lands, so each gets the span it was sent for
    effects.age(w)

    # 3. the sky rolls, and THEN one queued fate lands. The order is the
    #    plan's, inverted, and deliberately: a fate that is the sky must
    #    overwrite the day it lands on, or `roll_weather` takes the first
    #    day of its span out of the count as it decrements, and a storm
    #    sent for two days is over before anyone has seen it.
    roll_weather(w, evs)
    effects.land(w, evs)

    # 4. the estate's memory of the sky it actually got, not the one that
    #    was rolled for it
    update_wet_streak(w)

    # 5. the trees grow and can come down; their shade is built with them
    trees.update_trees(w, evs)

    # 6. whoever is out and about is making noise, so the field is rebuilt
    #    now — before anyone decides where to be, not after
    places.build_noise(w)
    places.build_light(w)

    # 7. the day's living: five phases, everyone choosing once in each
    residents.update_residents(w, evs)

    # 8. the day's wear: fixtures are used up, and some of them break
    places.update_fixtures(w, evs)

    # 9. the slow layer. The people have acted; now the households age,
    #    lose and gain their own, and the letting office counts the empty
    #    flats — after the day's living, so a household that leaves this
    #    morning leaves a vacancy tomorrow rather than one filled today
    households.update_households(w, evs)

    return evs
