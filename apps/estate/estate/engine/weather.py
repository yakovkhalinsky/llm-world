"""The sky over the estate: one roll a day, with persistence.

Rain sticks for a day or two and soaks the ground; a storm or a heat snap is
a one-day visitation. Frost is simply winter's face. The wet streak is the
estate's memory of rain: a run of wet days softens outdoor noise and keeps
people in, which is how weather reaches the needs without touching them
directly.
"""

from .. import world as W
from .. import rules


def roll_weather(w, evs):
    """One day's weather. Persistence: a rain or storm keeps its day."""
    t = w["day"]
    season = W.season_index(t)
    if w["weather_left"] > 0:
        w["weather_left"] -= 1
        if w["weather_left"] == 0 and w["weather"] != "frost":
            w["weather"] = "clear"
        return
    if season == rules.R["weather"]["frost_week"]:
        if w["weather"] != "frost":
            w["weather"] = "frost"
            evs.append({"day": t, "kind": "frost"})
        return
    rng = W.rng_for(w["seed"], t, "weather")
    prob = rules.intkey(rules.R["weather"]["rain_prob"])
    storms = rules.intkey(rules.R["weather"]["storm_prob"])
    heat = rules.intkey(rules.R["weather"]["heat_prob"])
    r = rng.random()
    storm_p = storms.get(season, 0.0)
    heat_p = heat.get(season, 0.0)
    if r < storm_p:
        w["weather"], w["weather_left"] = "storm", 1
        evs.append({"day": t, "kind": "storm"})
    elif r < storm_p + heat_p:
        w["weather"], w["weather_left"] = "heat", 1
    elif r < storm_p + heat_p + prob.get(season, 0.0):
        w["weather"], w["weather_left"] = "rain", 1
    else:
        w["weather"] = "clear"


def update_wet_streak(w):
    """The estate's memory of rain. This is the only thing that reads it,
    so it is updated where it is used rather than in the conductor."""
    w["wet_days"] = (w.get("wet_days", 0) + 1
                     if w["weather"] in ("rain", "storm") else 0)
    return w["wet_days"]


def wetness(w) -> float:
    """0 when dry; 1 after a fortnight of rain. Softens outdoor noise and
    keeps people in, which is how weather reaches a need without the
    weather module knowing what a need is."""
    return min(1.0, w.get("wet_days", 0) / 14.0)
