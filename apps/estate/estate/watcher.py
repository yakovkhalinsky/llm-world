"""The watcher: the presence that watches the estate and owns nothing.

One JSON decision, from an enumerated menu, validated against the pack —
the grove's operator, renamed and re-scoped. The discipline is the whole
design and it is worth restating, because every part of it was bought with
a fault:

- **The menu is finite and it is the pack's.** The model may not invent a
  fate, and may not send one to a region the fate does not accept — a menu
  that says yes to anything is not a menu.
- **The schema is one schema, used by both the digest and the validator.**
  Grove b46 was a prompt that offered paths the law refused; the two must
  never be written twice.
- **Validation never rewrites a legal answer.** A fate that does not exist
  becomes `quiet`, which is a real choice — the honest reading of "send
  nothing" — and not a silent substitution.
- **The engine decides what a fate means.** The model names a fate; the
  pack says what it does; nothing the model writes reaches the world
  except as one of those names.
"""

import json

from . import rules
from . import world as W

QUIET = "quiet"


def menu():
    """The fates the pack ships, in a stable order."""
    return sorted(rules.R["fates"])


def regions_for(fate):
    """Which regions this fate may be sent to. A fate that names none is
    about the whole estate and nothing narrower."""
    spec = rules.R["fates"].get(fate, {})
    return tuple(spec.get("regions") or ("all",))


def system():
    """The watcher's words, from the pack (presentation.watcher_system)."""
    return rules.R["presentation"].get("watcher_system", "")


def schema():
    """The one schema, used by the digest and by the validator: a fate
    from the menu, and the reason in the watcher's own words."""
    return {
        "type": "object",
        "properties": {
            "fate": {"type": "string", "enum": menu()},
            "region": {"type": "string", "enum": sorted(rules.R["regions"])},
            "why": {"type": "string"},
        },
        "required": ["fate", "region", "why"],
    }


def _needs_line(w):
    """How the estate is doing, in the terms the model can act on — the
    pressures, not the integers. A digest that hands over raw floats
    invites the model to reason about arithmetic it cannot do."""
    if not w["residents"]:
        return "nobody lives here"
    out = []
    for need in rules.R["needs"]:
        vals = [r["needs"][need] for r in w["residents"].values()]
        mean = sum(vals) / len(vals)
        top = max(vals)
        band = ("met" if mean < 1.0 else
                "wearing" if mean < 2.0 else
                "pressing" if mean < 3.0 else "bad")
        out.append(f"{need} {band} (worst {top:.1f} of "
                   f"{rules.R['engine']['need_max']:.0f})")
    return "; ".join(out)


def _frayed(w, n=3):
    frayed = sorted((r for r in w["residents"].values() if r["stress"] >= 1),
                    key=lambda r: -r["stress"])[:n]
    if not frayed:
        return "nobody is fraying"
    return ", ".join(f"{r['name'] or 'someone'} ({r['role']}, {r['stress']:.0f})"
                     for r in frayed)


def _places(w, n=4):
    """What is being used, and what is wearing out."""
    uses = {}
    worn = []
    for f in w["fixtures"].values():
        uses[f["kind"]] = uses.get(f["kind"], 0) + f["use_total"]
        if f["condition"] <= 0:
            worn.append(f["kind"])
        elif f["condition"] < 0.35:
            worn.append(f["kind"] + " (going)")
    busiest = sorted(uses.items(), key=lambda kv: -kv[1])[:n]
    line = ", ".join(f"{k} {v}" for k, v in busiest if v)
    if worn:
        line += " · wearing out: " + ", ".join(sorted(set(worn)))
    return line or "nothing has been used yet"


def digest(w, recent_lines=()):
    """How the estate is doing today. Written once, read by the model, and
    deliberately the same shape as the validator's menu — the model is
    never offered a fate the law will refuse."""
    day = w["day"]
    fates = ", ".join(f"{f['kind']} ({f['left']}d left)" for f in w["fates"])
    recent = "\n".join(f"  - {r}" for r in recent_lines[-6:]) or "  - nothing"
    lines = [
        f"Day {day} ({W.weekday_name(day)}, {W.season_name(day)}). "
        f"Weather: {w['weather']}. " +
        (f"In force: {fates}." if fates else "Nothing is in force."),
        f"People: {len(w['residents'])} residents in "
        f"{W.occupied_units(w)} of {len(w['units'])} flats, "
        f"{len(w['waiting'])} waiting.",
        f"Needs: {_needs_line(w)}.",
        f"Fraying: {_frayed(w)}.",
        f"Places: {_places(w)}.",
        "Recently:\n" + recent,
        "",
        "Menus — you may send exactly one of these:",
    ]
    for fate in menu():
        spec = rules.R["fates"][fate]
        regs = ", ".join(regions_for(fate))
        span = spec.get("days", (1, 1))
        lines.append(f"  {fate} — {spec.get('why', '')} "
                     f"[regions: {regs}; lasts {span[0]}-{span[1]} days]")
    lines.append("")
    lines.append("Reply with JSON only: "
                 '{"fate": "<one of the above>", "region": "<one of the '
                 'regions listed for it>", "why": "<one short sentence>"}')
    return "\n".join(lines)


# --------------------------------------------------------------- validation

def _quiet(region="all", why="nothing — the estate is left to its own day"):
    return {"fate": QUIET, "region": region, "why": why}


def validate(raw):
    """A model's answer as a fate the engine may land, or `quiet`.

    Nothing is rewritten into something legal: an unknown fate, a region
    that fate does not accept, or a reply that is not an object at all all
    become `quiet`, which is a fate the pack ships and the estate honours.
    Silence is a real answer, and it is the safe one.
    """
    if not isinstance(raw, dict):
        return _quiet(why="the watcher said nothing readable")
    fate = raw.get("fate")
    if not isinstance(fate, str) or fate not in rules.R["fates"]:
        return _quiet(why=f"the watcher named a fate the estate has no "
                          f"law for: {fate!r}")
    allowed = regions_for(fate)
    region = raw.get("region", "all")
    if not isinstance(region, str) or region not in allowed:
        if len(allowed) == 1:
            region = allowed[0]           # it may only be here; say so
        else:
            return _quiet(why=f"{fate} is not something that happens to "
                              f"{region!r}")
    why = raw.get("why")
    why = why.strip() if isinstance(why, str) else ""
    if len(why) > 200:
        why = why[:197] + "…"
    return {"fate": fate, "region": region,
            "why": why or rules.R["fates"][fate].get("why", "")}


def invite(llm, w, recent_lines=()):
    """Ask the watcher once. Returns a validated intent; never raises and
    never returns None — an unreachable model simply means `quiet`."""
    if llm is None or not llm.enabled:
        return _quiet(why="no watcher is listening")
    raw = llm.chat_json(system(), digest(w, recent_lines), schema(),
                        max_tokens=220, job="watch")
    if raw is None:
        return _quiet(why="the watcher did not answer")
    return validate(raw)


def queue(w, intent):
    """Put a validated fate in the estate's hand. The engine lands it
    tomorrow, so a fate sent today is dated tomorrow and ages from there."""
    if intent.get("fate") == QUIET:
        return None
    w["pending"].append({"kind": intent["fate"],
                         "region": intent.get("region", "all")})
    return intent


def dumps(intent):
    return json.dumps(intent, sort_keys=True)
