"""Weather and the cell loops: moisture, grass, mushrooms, carrion.

Deterministic, seeded per (seed, tick). The sky remembers wet weekends
("wet-streak" soak); frost is simply winter's face.
"""

from .. import world as W
from .. import rules

from .util import _clamp, _clamp01, _region_set, _near_water, _pop, _rules


def _roll_weather(w, evs):
    t = w["tick"]
    rng = W.rng_for(w["seed"], t, "weather")
    season = W.season_index(t)
    if w["weather_left"] > 0:
        w["weather_left"] -= 1
        if w["weather_left"] == 0:
            w["weather"] = "clear"
        return
    if season == 3:
        if w["weather"] != "frost":
            w["weather"] = "frost"
        return
    r = rng.random()
    storm_p = _rules()[5].get(season, 0.0)
    if r < storm_p:
        w["weather"], w["weather_left"] = "storm", 2
        evs.append({"tick": t, "kind": "storm", "x": None, "y": None,
                    "note": "natural"})
    elif r < storm_p + _rules()[6].get(season, 0.0):
        w["weather"], w["weather_left"] = "rain", 1
    else:
        w["weather"] = "clear"


# -------------------------------------------------------------------- light

def _update_cells(w, evs):
    size, t = w["size"], w["tick"]
    rng = W.rng_for(w["seed"], t, "cells")
    season = W.season_index(t)
    weather = w["weather"]
    # the drought's footprint, resolved once per week: None means the
    # whole world, so `_region_set` must never be re-read per cell
    droughts = [_region_set(e["region"], size) for e in w["effects"]
                if e["kind"] == "drought"]
    # the sky remembers: a run of rainy weeks soaks the ground
    w["wet_streak"] = (w.get("wet_streak", 0) + 1
                       if weather in ("rain", "storm") else 0)
    soak = min(2.0, w.get("wet_streak", 0) * 0.4)

    for y in range(size):
        for x in range(size):
            c = w["cells"][y][x]
            if c["terrain"] == "water":
                c["moisture"] = 1.0
                c["grass"] = 0.0
                continue
            m = c["moisture"]
            if weather == "rain":
                m += _rules()[2]
            elif weather == "storm":
                m += _rules()[3]
            m *= _rules()[1][season]
            for region in droughts:
                if region is None or (x, y) in region:
                    m -= 0.09
            c["moisture"] = _clamp01(m)

            # grass
            regrow = _rules()[0][season] * (1.0 + soak * 0.15)
            if any(region is None or (x, y) in region for region in droughts):
                regrow *= 0.2
            light = w["_light"][y][x]
            if regrow and weather != "frost" and c["moisture"] > 0.12 \
                    and light > 0.30:
                c["grass"] = _clamp01(c["grass"] + regrow)
            if weather == "frost":
                c["grass"] *= 0.93

            # mushrooms: they favor humus, and boom after days of rain
            if c["mushroom"] > 0:
                c["mushroom"] -= 1
            elif weather in ("rain", "storm") and \
                    (c["grass"] > 0.25 or c.get("humus", 0) > 0.3):
                p_mush = 0.08 * (1.0 + soak)
                if c.get("humus", 0) > 0.3:
                    p_mush *= 2.5
                if rng.random() < p_mush:
                    c["mushroom"] = 3

            if c["carcass"] > 0:
                c["carcass"] -= 1
