"""The engine's shared bits: clamps, region sets and lookup."""

# the constants bundle (cell physics, weather chances, the winter drain)

from .. import rules


def _intkey(d):
    """Season keys arrive as strings from JSON overrides."""
    return {int(k): v for k, v in (d or {}).items()}

def _rules():
    r = rules.R
    return (
        _intkey(r["cells"]["grass_regrow"]),
        _intkey(r["cells"]["moisture_decay"]),
        r["weather"]["rain_gain"], r["weather"]["storm_gain"],
        r["pop"]["winter_drain"],
        _intkey(r["weather"]["natural_storm_prob"]),
        _intkey(r["weather"]["rain_prob"]),
        r["weather"]["log_ttl"], r["weather"]["carcass_ttl"],
        r["pop"]["recolonize_after"],
    )


# ------------------------------------------------------------------ weather

def _region_set(region, size):
    return set(W.region_cells(size, region)) if region != "all" else None

def _clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v

def _clamp01(v):
    return max(0.0, min(1.0, v))


# ------------------------------------------------------------------- plants

def _near_water(w, x, y, d):
    size = w["size"]
    for ny in range(max(0, y - d), min(size, y + d + 1)):
        for nx in range(max(0, x - d), min(size, x + d + 1)):
            if w["cells"][ny][nx]["terrain"] == "water":
                return True
    return False


# ------------------------------------------------------------------ animals

def _pop(w, sp):
    return sum(1 for a in w["animals"].values() if a["sp"] == sp)


# --------------------------------------------------------------- population


def _seasons(v):
    if isinstance(v, (list, tuple)):
        return tuple(v)
    return (v,)


def _breed_seasons(spec):
    return _seasons(spec.get("breed_seasons", ()))
