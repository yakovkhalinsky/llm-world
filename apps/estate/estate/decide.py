"""decide(): the estate's choices, made in code.

The watcher's job has two halves. Choosing a fate and a region is a
choice from a finite menu — the shape a decision model answers (System
One's `choice` question) and not the shape a 4B language model is good
at, on a Pi, at ~20 s a call. Saying *why* is language. So with `--decide
rules` (the default) the choice is made here, by a seeded, weighted policy
over the estate's needs bands, and the model is only asked for the one
line of why (watcher.WHY_SCHEMA). `--decide llm` keeps the old way.

Determinism: the draw comes from W.rng_for(seed, day, "decide:watch"), so
the same world on the same day makes the same choice in any process. The
watcher only ever runs with AI on; with `--offline` nothing here is
called, and the balance gate's fingerprint cannot move.
"""

from . import rules
from . import world as W

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


def bands(w):
    """{need: mean} over the residents — what the watcher's digest calls
    met (<1), wearing (<2), pressing (<3) and bad."""
    res = list(w["residents"].values())
    if not res:
        return {}
    return {need: sum(r["needs"][need] for r in res) / len(res)
            for need in rules.R["needs"]}


def frayed_share(w):
    res = list(w["residents"].values())
    if not res:
        return 0.0
    return sum(1 for r in res if r["stress"] >= 1) / len(res)


SEASON_FIT = {"frost": {"winter": 2.0, "autumn": 0.8, "spring": 0.5,
                        "summer": 0.05},
              "heat": {"summer": 2.0, "spring": 0.6, "autumn": 0.5,
                       "winter": 0.05},
              "rain": {"autumn": 1.6, "spring": 1.4, "winter": 1.0,
                       "summer": 0.7}}


def fate_weights(w):
    """The policy: how much each fate the pack ships fits today."""
    b = bands(w)
    fray = frayed_share(w)
    calm = 1.0 if b and max(b.values()) < 1.0 else 0.3
    season = W.season_name(w["day"])
    in_force = {f["kind"] for f in w.get("fates", [])}
    out = {}
    for fate, spec in sorted(rules.R["fates"].items()):
        if fate == "quiet":
            wt = 3.0 + 2.0 * fray
        elif spec.get("stock"):
            wt = 0.3 + 2.0 * max(0.0, b.get("food", 0.0) - 1.0)
        elif spec.get("noise_mult", 1.0) < 1.0:
            wt = 0.3 + 2.0 * max(0.0, b.get("quiet", 0.0) - 1.0) + fray
        elif spec.get("weather"):
            base = 0.4 if spec["weather"] == "storm" else 0.6
            wt = base * SEASON_FIT.get(spec["weather"], {}).get(season, 1.0)
        elif spec.get("walk_mult") or spec.get("stair_mult") or \
                spec.get("damage"):
            wt = 0.35 * calm      # friction is for days that can take it
        else:
            wt = 0.5
        if fate in in_force and fate != "quiet":
            wt *= 0.1             # it is already happening
        out[fate] = round(wt, 6)
    return out


def region_weights(fate):
    regs = rules.R["fates"].get(fate, {}).get("regions") or ("all",)
    return {r: 1.0 for r in regs}


def watch(w):
    """The watcher's choice: {fate, region, why, probs, confidence}. The
    why is the pack's own line for the fate until a model writes one."""
    rng = W.rng_for(w["seed"], w["day"], "decide:watch")
    a = decide({"fate": {"type": "choice", "options": fate_weights(w)}},
               rng)["fate"]
    fate = a["pick"]
    r = decide({"region": {"type": "choice",
                           "options": region_weights(fate)}}, rng)["region"]
    return {"fate": fate, "region": r["pick"],
            "why": rules.R["fates"][fate].get("why", ""),
            "confidence": round(a["confidence"], 3),
            "decided": "rules"}
