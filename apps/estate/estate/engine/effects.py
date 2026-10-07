"""The watcher's fates: what it sent, how long it lasts, and what it does.

The watcher owns nothing. It sends a bounded, validated intent from an
enumerated menu and the engine decides what that means — the same rule the
grove's World Soul lives under, and the whole reason a model that writes
nonsense, times out or is unplugged cannot break the world.

Two lifetimes matter and they are different. A fate **lands** once, and a
fate **lasts**. Landing is what it does the day it arrives (a delivery
fills the shelves); lasting is what it keeps doing while it is in force
(the road stays up for a week). Everything that lasts is aged here, before
the next thing lands, so a fate gets exactly the span its strength bought
— grove b30 was a drought that never expired, and it is not repeated.
"""

from .. import rules
from .. import world as W


def age(w):
    """Every fate loses a day; a spent one is dropped. Called before a new
    fate lands, so the two cannot overlap by accident."""
    keep = []
    for f in w["fates"]:
        f["left"] = f.get("left", 0) - 1
        if f["left"] > 0:
            keep.append(f)
    w["fates"] = keep


def land(w, evs):
    """Land one queued fate, if there is one. Returns its kind or None."""
    if not w["pending"]:
        return None
    f = w["pending"].pop(0)
    spec = rules.R["fates"].get(f["kind"])
    if spec is None:                   # validated on the way in, and again
        return None                    # here: a menu is not a promise
    rng = W.rng_for(w["seed"], w["day"], f"fate:{f['kind']}")
    lo, hi = spec.get("days", (1, 1))
    left = rng.randint(lo, hi)

    # what it does on arrival
    if spec.get("weather"):
        w["weather"] = spec["weather"]
        w["weather_left"] = max(w.get("weather_left", 0), left)
    if spec.get("stock"):
        for fx in w["fixtures"].values():
            if fx["kind"] == "shop":
                fx["stock"] = rules.R["fixtures"]["shop"].get("stock", 150)
    if spec.get("damage"):
        _damage(w, f, spec["damage"], rng)

    # what it keeps doing while it lasts: a multiplier the engine reads
    for key in ("walk_mult", "stair_mult", "noise_mult"):
        if spec.get(key) is not None:
            w["fates"].append({"kind": f["kind"], "left": left,
                               "region": f.get("region", "all"),
                               key: spec[key]})
    evs.append({"day": w["day"], "kind": "fate", "what": f["kind"],
                "region": f.get("region", "all"), "left": left,
                "say": spec.get("why", "")})
    return f["kind"]


def _damage(w, f, amount, rng):
    """Break something, in the region the fate names. A fate about
    somewhere with nothing in it does nothing and says so."""
    region = f.get("region", "all")
    here = [fx for fx in w["fixtures"].values()
            if fx["condition"] > 0
            and W.in_region(w, region, fx["x"], fx["y"])]
    if not here:
        return None
    fx = here[rng.randrange(len(here))]
    fx["condition"] = max(0.0, fx["condition"] - amount)
    return fx
