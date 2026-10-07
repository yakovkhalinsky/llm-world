"""reviewer.py — the LLM's ecological review of the world's ruleset.

Roughly once a simulated year the reviewer reads: the current rules,
the year's census (peaks/troughs/ends per species), the population's
crises (extinctions, recolonizations, germinations, the robins'), the
soil's bank, and the recent chronicle. It proposes AT MOST TWO rule
amendments with reasons (or no change at all: restraint is expected).

Proposals are validated against rules.R["bounds"] before anything
happens: out-of-laws are refused with the reason, and a value outside
its band is clamped into it. By default the steward's first lawful
amendment is APPLIED — the point of it is to actually tune the ecology
— and every change, offered or taken, is written to the world's own
override file so it outlives the run. `--no-auto-tune` keeps it to
offers, which the keeper accepts on the dashboard's tuning tab; a second
amendment is always left as an offer, because a rule needs a year to be
judged.

The tone: a steward, not a tinkerer. Only one rule in flight at a time
(a rule needs a year to be judged); the reviewer may also simply say
the world needs nothing.
"""

import json
import re
import time

from . import rules
from .world import counts as world_counts, plant_counts as world_plant_counts

REVIEW_SYSTEM = (
    "You are the grove's steward, reviewing its written constitution "
    "once a year with the previous year's ledger in hand. You may "
    "propose amendments to the rules (each: a path, a proposed value, "
    "and one honest sentence why), or propose nothing. Judge from the "
    "ledger: a boom that ends in extinction asks for smaller caps; a "
    "species living at its ceiling the whole year may deserve more "
    "room; an understory gone quiet asks for gentler seed rain or a "
    "more open canopy; near-extinctions ask for patience, not "
    "panic. Propose at most two changes, each small: a constitution "
    "needs a year's evidence to be judged again. In 'verdict' write "
    "one sentence in the voice of a keeper of a living world.\n"
    'Reply ONLY as JSON: {"verdict":"...", "amendments":'
    '[{"rule":"animals.rabbit.cap","value":20,"why":"..."}], '
    '"nothing":false}'
)

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string"},
        "nothing": {"type": "boolean"},
        "amendments": {"type": "array", "items": {
            "type": "object",
            "properties": {"rule": {"type": "string"},
                           "value": {"type": "number"},
                           "why": {"type": "string"}},
            "required": ["rule", "why"]}},
    },
    "required": ["verdict", "amendments"],
}


def _year_ledger(world, db, weeks=48):
    """The reviewed year's census: per-species peak/trough/end + the
    crises the world recorded."""
    t = world["tick"]
    hist = db.history(weeks)
    series = {}
    for _tick, snap in hist:
        for sect in ("pop", "plants"):
            for sp, n in snap.get(sect, {}).items():
                a, b = series.setdefault(sect, {}).get(sp, (10**9, -1))
                series[sect][sp] = (min(a, n), max(b, n))
    end = {"pop": world_counts(world), "plants": world_plant_counts(world)}
    events = {}
    for row in db.con.execute(
            "SELECT kind, COUNT(*) FROM chron WHERE source='raw' AND "
            "kind IN ('recolonize','germinate','robins_left',"
            "'robins_return','germinate') GROUP BY kind").fetchall():
        events[row[0]] = row[1]
    starves = db.con.execute(
        "SELECT COUNT(*) FROM chron WHERE source='raw' AND "
        "kind='starve'").fetchone()[0]
    return {"peak_trough_end": series, "end": end,
            "crises": events, "starving_lately": starves,
            "soil_bank": world.get("seedbank", {}),
            "week": t}





def digest(world, db, weeks=48):
    """The review's evidence, in compact text (a few hundred tokens)."""
    led = _year_ledger(world, db, weeks)
    lines = [f"week {world['tick']}"]
    for sect in ("pop", "plants"):
        for sp, (lo, hi) in sorted((led["peak_trough_end"] or {}).get(
                sect, {}).items()):
            end = led["end"][sect].get(sp, 0)
            lines.append(f" {sect} {sp}: peak {hi}, trough {lo}, now {end}")
    if led["crises"]:
        lines.append("crises: " + ", ".join(
            f"{k} ({n}×)" for k, n in led["crises"].items()))
    if led["starving_lately"]:
        lines.append(f"starvations {led['starving_lately']}×")
    bank = led["soil_bank"]
    if bank:
        lines.append("seed bank: " + ", ".join(f"{k} {v}"
                                               for k, v in bank.items()))
    cur = rules_current()
    if cur:
        lines.append("current rules: " + "; ".join(cur))
    return "\n".join(lines)


def _value_at(path):
    """The live value at a dotted path, or None if the path names nothing."""
    node = rules.R
    for step in path.split("."):
        if not isinstance(node, dict) or step not in node:
            return None
        node = node[step]
    return None if isinstance(node, dict) else node


def rules_current():
    """The lawful paths, their current values and the bands they may move
    within — the whole surface a steward may propose on.

    These must be the very dotted paths `validate` accepts and
    `apply_amendment` walks, section and all: they were once not, and every
    amendment the steward offered was refused as an unlawful path. And it
    has to be shown all of them — it was shown two knobs of the eleven, and
    a constitution you cannot read is one you cannot amend."""
    law = rules.R.get("bounds", {})
    out = []
    for section, key in (("animals", "cap"), ("plants", "seed_prob")):
        for sp, t in sorted(rules.R[section].items()):
            if t.get("visitor") or key not in t:
                continue                     # only what actually exists
            band = law.get(section + ".*." + key)
            out.append(f"{section}.{sp}.{key}={t[key]}"
                       + (f" (lawful {band[0]}..{band[1]})" if band else ""))
    also = []
    for path, band in sorted(law.items()):
        if "*" in path:
            section, _sp, key = path.split(".")
            if key in ("cap", "seed_prob"):
                continue
            also.append(f"{section}.<species>.{key} "
                        f"({band[0]}..{band[1]})")
        else:
            also.append(f"{path}={_value_at(path)} ({band[0]}..{band[1]})")
    if also:
        out.append("also amendable — " + "; ".join(also))
    return out


def _bounds_for(path):
    """The legal band for a dotted path; species-wildcards apply."""
    law = rules.R.get("bounds", {})
    if path in law:
        return law[path]
    parts = path.split(".")
    if len(parts) == 3 and parts[0] in ("animals", "plants"):
        band = law.get(parts[0] + ".*." + parts[2])
        if band:
            return band
    return None


def validate(proposal):
    """(ok, clamped_value, reason) against the bounds' hard law."""
    if not isinstance(proposal, dict):
        return False, None, "not a proposal"
    path = str(proposal.get("rule", "")).strip()
    # `_` belongs in this class. Every declared bound but `cap` and
    # `lifespan` carries one — seed_prob, light_need, hunger_drain,
    # recolonize_after — so without it the law named two of the eleven and
    # refused the other nine as an "unlawful path", whatever the steward
    # proposed.
    if not path or not re.match(r"^(animals|plants|pop|weather|cells)\."
                                r"[A-Za-z0-9_*]+(\.[A-Za-z0-9_*]+)?$",
                                path):
        return False, None, f"unlawful path: {path!r}"
    band = _bounds_for(path)
    if band is None:
        return False, None, f"no law covers {path!r}"
    value = proposal.get("value")
    try:
        value = float(value)
    except (TypeError, ValueError):
        return False, None, "value is not a number"
    lo, hi = band
    if path.startswith("animals.") and path.endswith(".cap") and \
            value < 2:
        return False, None, "a species may never be reduced toward zero"
    clamped = max(lo, min(hi, value))
    why = ""
    if clamped != value:
        why = f"clamped into {lo}..{hi}"
    return True, clamped, why


def pending(db, current_week=0):
    # offers older than two seasons expire; at most three are in view
    db.con.execute(
        "UPDATE proposals SET status='expired' "
        "WHERE status='offered' AND week < ?", (current_week - 24,))
    db.con.commit()
    return db.con.execute(
        "SELECT id, week, rule, value, why, status, was FROM proposals "
        "WHERE status IN ('pending','offered') ORDER BY id DESC "
        "LIMIT 3").fetchall()


def history(db, n=20):
    return db.con.execute(
        "SELECT id, week, status, rule, value, was FROM proposals "
        "ORDER BY id DESC LIMIT ?", (n,)).fetchall()


def record(db, world, proposals, verdict, auto):
    """Validate + store; auto-apply the ones the law allows.

    Returns (outcomes, applied_rule): the one amendment this review
    actually wrote into the constitution, or None. At most one is ever
    applied — a rule needs a year's evidence before it is judged again —
    so the caller knows whether the constitution must be persisted."""
    out = []
    applied_rule = None
    for prop in (proposals or [])[:2]:
        ok, value, reason = validate(prop)
        was = _value_at(str(prop.get("rule", "")))   # read before it moves
        why = str(prop.get("why", ""))[:160] +             (f" [{reason}]" if reason else "")
        if not ok:
            db.add_amendment(world["tick"], "refused", str(
                prop.get("rule"))[:80], prop.get("value"),
                f"refused: {reason}", verdict, was)
            out.append((False, prop.get("rule"), None, reason))
            continue
        # the row goes in first, always: the ledger keeps every reading,
        # whether it is offered for the viewer or taken at once. In auto
        # mode `apply_amendment` then marks this same row applied — which
        # it could not do before, because no row was ever written and the
        # world changed its own constitution invisibly.
        db.add_amendment(world["tick"], "offered", prop["rule"], value,
                         why, verdict, was)
        if auto and applied_rule is None and \
                apply_amendment(db, rules, prop["rule"], value):
            applied_rule = prop["rule"]
            out.append((True, prop.get("rule"), value, reason))
        else:
            out.append((True, prop.get("rule"), value, "offered"))
    return out, applied_rule


def apply_amendment(db, rules_mod, path, value):
    """Set a rule by dotted path of any depth (2-seg law paths and
    species paths both work). The walk refuses `*` anywhere and a
    path that points outside the rules or at anything but a leaf."""
    parts = path.split(".")
    if len(parts) < 2 or "*" in parts:
        return False
    node = rules_mod.R
    for step in parts[:-1]:
        if not isinstance(node.get(step), dict):
            return False
        node = node[step]
    if parts[-1] not in node:
        return False
    node[parts[-1]] = value
    db.con.execute(
        "UPDATE proposals SET status='applied', value=? "
        "WHERE rule=? AND status IN ('pending','offered')",
        (value, path))
    db.con.commit()
    return True


def dismiss(db, proposal_id):
    db.con.execute("UPDATE proposals SET status='dismissed' WHERE id=?",
                   (proposal_id,))
    db.con.commit()
    return True