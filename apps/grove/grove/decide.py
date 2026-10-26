"""decide(): the grove's choices, made in code.

Two of the LLM's jobs here are choices, not language: the World Soul's
operator picks an action, a region, a strength and a species from a
finite menu, and the steward picks rule paths and values inside bounds.
Those are the shapes a decision model answers (System One's `choice`
and `score` questions), not the shape a 4B language model is good at on
a Pi. So with `--decide rules` (the default) the choice is made here by
a seeded, weighted policy over the world's state, and the model is only
asked for the words: the soul's intent and a destiny's text, and the
steward's verdict. `--decide llm` keeps the old way.

Determinism: every draw comes from random.Random(f"{seed}:{tick}:...")
so the same world on the same week makes the same choice in any process.
None of it runs with `--offline`, so the sim fingerprint cannot move.
"""

import random

from . import rules
from . import world as W
from .engine import _pop

def decide(questions, rng):
    """Answer typed questions in one pass, SystemOne-shaped.

    `questions` maps a name to {"type": "choice", "options": {option:
    weight}} or {"type": "score", "levels": [...], "weights": [...]}. The
    answer for each is {"type", "probs": {option: p}, "pick", "confidence"}:
    calibrated-looking probabilities from the policy's weights, and a pick
    drawn from them with the caller's seeded rng. No text is generated.
    The same questions and the same rng always give the same answers — a
    hosted or local decision model can replace this function without the
    world noticing anything but the picks."""
    out = {}
    for name in sorted(questions):
        q = questions[name]
        if q.get("type") == "score":
            opts = list(zip(q["levels"], q.get("weights")
                            or [1.0] * len(q["levels"])))
        else:
            opts = list(q["options"].items())
        opts = [(k, max(0.0, float(w))) for k, w in opts]
        total = sum(w for _k, w in opts)
        if total <= 0:
            opts = [(k, 1.0) for k, _w in opts]
            total = float(len(opts))
        probs = {k: w / total for k, w in opts}
        roll = rng.random()
        pick = opts[-1][0]
        acc = 0.0
        for k, _w in opts:
            acc += probs[k]
            if roll < acc:
                pick = k
                break
        out[name] = {"type": q.get("type", "choice"), "probs": probs,
                     "pick": pick, "confidence": probs[pick]}
    return out


# ------------------------------------------------------------ the operator

def _moisture(world):
    size = world["size"]
    out = {}
    for region in W.REGION_NAMES:
        vals = [world["cells"][y][x]["moisture"]
                for x, y in W.region_cells(size, region)
                if world["cells"][y][x]["terrain"] == "soil"]
        out[region] = (sum(vals) / len(vals)) if vals else 0.0
    return out


def _destiny_target(world):
    """The oldest soul the engine knows and has no destiny for yet."""
    open_d = {d["id"] for d in world.get("destinies", [])}
    if len(open_d) >= 3:
        return None
    visitors = set(rules.R["pop"]["visitor_species"])
    named = []
    unnamed = []
    for a in world["animals"].values():
        if a["id"] in open_d or a["sp"] in visitors:
            continue
        nm = world["names"].get(str(a["id"])) or a.get("name")
        (named if nm else unnamed).append(a)
    pool = named or unnamed
    if not pool:
        return None
    return sorted(pool, key=lambda a: (-a["age"], a["id"]))[0]


def operator_pressures(world):
    """{action: (pressure, region, species, target)} — how much each move
    on the menu answers what the grove is showing this week."""
    moist = _moisture(world)
    wettest = max(sorted(moist), key=lambda r: moist[r])
    driest = min(sorted(moist), key=lambda r: moist[r])
    pc = W.plant_counts(world)
    total_plants = sum(pc.values()) or 1
    top_plant = max(sorted(pc), key=lambda s: pc[s]) if pc else None
    share = (pc.get(top_plant, 0) / total_plants) if top_plant else 0.0
    caps = {sp: W.ANIMAL_SPECIES[sp].get("cap", 1)
            for sp in rules.R["pop"]["base_residents"]
            if sp in W.ANIMAL_SPECIES}
    ratio = {sp: _pop(world, sp) / max(1, c) for sp, c in caps.items()}
    lowest = min(sorted(ratio), key=lambda s: ratio[s]) if ratio else None
    target = _destiny_target(world)
    visitors = list(rules.R["pop"]["visitor_species"])
    return {
        "quiet": (0.0, "all", None, None),
        "drought": (max(0.0, moist[wettest] - 0.6) * 3, wettest, None, None),
        "bloom": (max(0.0, 0.35 - moist[driest]) * 3, driest,
                  rules.R["pop"].get("bloom_species"), None),
        "storm": (0.15, "all", None, None),
        "blight": (max(0.0, share - 0.4) * 2.5, "all", top_plant, None),
        "migration": ((max(0.0, 0.3 - ratio[lowest]) * 4) if lowest
                      else 0.0, "all", lowest, None),
        "visitor": (0.1, "all", visitors[world["tick"] % len(visitors)]
                    if visitors else None, None),
        "destiny": (0.3 if target else 0.0, "all", None,
                    target["id"] if target else None),
    }


BASE = {"quiet": 2.0, "drought": 0.3, "bloom": 0.3, "storm": 0.4,
        "blight": 0.2, "migration": 0.2, "visitor": 0.3, "destiny": 0.4}


def operator_weights(world, pressures=None):
    p = pressures or operator_pressures(world)
    hist = [h["action"] for h in world.get("op_history", [])]
    out = {}
    for action in sorted(BASE):
        pressure, _r, sp, tgt = p[action]
        wt = BASE[action] + pressure
        if action == "destiny" and tgt is None:
            wt = 0.0
        if action in ("blight", "migration") and sp is None:
            wt = 0.0
        if action != "quiet" and len(hist) >= 3 and \
                set(hist[-3:]) == {action}:
            wt = 0.0            # three times running: something else
        elif action != "quiet" and hist and hist[-1] == action:
            wt *= 0.5
        out[action] = round(wt, 6)
    return out


def _destiny_text(world, a):
    if a is None:
        return ""
    if a["sp"] in rules.R["pop"].get("water_seekers", ()):
        return "will find the water's edge"
    return "will grow old in the grove"


def operator(world):
    """The World Soul's choice, as the effect `operator.validate` would
    return, with the words left as templates for a model to replace."""
    rng = random.Random(f"{world['seed']}:{world['tick']}:decide:op")
    p = operator_pressures(world)
    a = decide({"action": {"type": "choice",
                           "options": operator_weights(world, p)}},
               rng)["action"]
    action = a["pick"]
    pressure, region, species, target = p[action]
    strength = 1 + (pressure > 0.5) + (pressure > 1.0)
    eff = {"action": action, "region": region, "strength": int(strength),
           "species": species, "target": target, "destiny": "",
           "intent": TEMPLATE_INTENT[action],
           "confidence": round(a["confidence"], 3), "decided": "rules"}
    if action == "destiny":
        eff["destiny"] = _destiny_text(world,
                                       world["animals"].get(str(target)))
    return eff


TEMPLATE_INTENT = {
    "quiet": "the soul kept its peace",
    "drought": "the wet ground is given a dry spell",
    "bloom": "the dry ground is given a flowering",
    "storm": "a storm is let loose on the grove",
    "blight": "the commonest plant is thinned",
    "migration": "the thinnest of the residents is joined by more",
    "visitor": "a visitor is sent through the grove",
    "destiny": "an old soul is given a destiny",
}


# ------------------------------------------------------------- the steward

def amendments(led):
    """At most two rule moves from the year's ledger (reviewer._year_ledger),
    in the steward's own terms: a boom that ends in extinction asks for a
    smaller cap; a species living at its ceiling may deserve more room.
    Near-extinctions ask for patience, so they are left alone. Each move is
    small and still passes reviewer.validate before anything happens."""
    series = (led.get("peak_trough_end") or {}).get("pop", {})
    end = (led.get("end") or {}).get("pop", {})
    out = []
    for sp in sorted(series):
        t = W.ANIMAL_SPECIES.get(sp) or {}
        if t.get("visitor") or "cap" not in t:
            continue
        cap = t["cap"]
        lo, hi = series[sp]
        now = end.get(sp, 0)
        step = max(1, round(cap * 0.1))
        if (lo == 0 or now == 0) and hi >= 0.8 * cap:
            out.append((hi / max(1, cap), {
                "rule": f"animals.{sp}.cap", "value": cap - step,
                "why": f"{sp} boomed to {hi} and fell to nothing; a "
                       f"smaller cap may spare the crash"}))
        elif lo >= 0.9 * cap:
            out.append((lo / max(1, cap), {
                "rule": f"animals.{sp}.cap", "value": cap + step,
                "why": f"{sp} lived at its ceiling of {cap} all year"}))
    out.sort(key=lambda x: (-x[0], x[1]["rule"]))
    return [a for _s, a in out[:2]]
