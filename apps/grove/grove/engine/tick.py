"""The conductor: one tick, one week, in the grove's honest order."""
from .. import rules
from .. import world as W
from .util import _rules
from .weather import _roll_weather, _update_cells
from .plants import build_light, _update_plants, _germinate
from .animals import _update_animals
from .population import _check_destinies, _recolonize, _migration
from .effects import _age_effects, _apply_effect


def tick(world):
    """Advance one week. Returns the week's events (all kinds)."""
    evs = []

    world["tick"] += 1
    t = world["tick"]
    prev_season = W.season_index(t - 1)
    new_season = W.season_index(t)
    if new_season != prev_season:
        evs.append({"tick": t, "kind": "turn", "season": new_season})
        world["fawns_named"] = 0
        _migration(w=world, evs=evs, from_season=prev_season,
                   to_season=new_season)

    # the older fates burn a week down before the new one lands
    _age_effects(world)

    # queued operator decision lands at the tick boundary
    if world.get("pending_effect"):
        effect = world["pending_effect"]
        world["pending_effect"] = None
        _apply_effect(world, effect, evs)

    _roll_weather(world, evs)
    world["_light"] = build_light(world)
    _update_cells(world, evs)
    _update_plants(world, evs, world.pop("_light"))
    _update_animals(world, evs)
    _germinate(world, evs)
    bank = world.setdefault("seedbank", {})
    if bank and world["tick"] % 4 == 0:
        for sp in bank:
            # the bed decays slowly but never to nothing: its last seed
            # remains — soil memory, not a consumable ledger
            bank[sp] = max(1, int(bank[sp] * 0.995))
    _check_destinies(world, evs)
    _recolonize(world, evs)
    world["name_budget"] = rules.R["pacing"]["naming_budget_per_week"]
    return evs
