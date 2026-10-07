"""The estate's record of its own days.

Two layers, and the order between them is the whole design.

**The line** is deterministic: what happened today, one sentence per event,
from `render.say`. It is always there, it is always true, and it does not
need a model, a network or a working disk.

**The paragraph** is a model's prose over a run of recent lines. It is a
grace note. When the model is away, busy, or writing nonsense, the
chronicle is still the lines — the estate's history never depended on
anyone being awake to phrase it, which is the same rule the world itself
lives under. A summary that quietly became the only record would be the
unrecoverable-persistence class with a nicer voice.
"""

import re

from . import render
from . import rules
from . import world as W

MAX = 600


def day_lines(w, evs):
    """What happened today, in the estate's own words, without a model."""
    return [render.say(e) for e in evs]


def worth_writing(span):
    """Is there enough to make a paragraph of? A quiet estate gets no
    paragraph, which is correct — most days nothing happens, and saying so
    in four sentences is worse than saying it in none."""
    return span >= rules.R["pacing"].get("chronicle_need", 3)


def schema():
    return {"type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"]}


def _tidy(text):
    """A model's paragraph as one the estate will keep: one line, no
    markdown, bounded."""
    text = re.sub(r"[\r\n]+", " ", text or "")
    text = re.sub(r"[*_`#]+", "", text)
    text = re.sub(r"\s{2,}", " ", text).strip()
    return text[:MAX]


def fallback(lines, days):
    """The honest entry when no prose was written: the days, named."""
    if not lines:
        return f"{days} quiet days on the estate."
    return f"{days} days: " + "; ".join(lines[:6]) + ("…" if len(lines) > 6
                                                      else "")


def narrate(llm, w, lines, days, recent=()):
    """A paragraph over the run, or the lines themselves. Never nothing."""
    if llm is None or not llm.enabled or not lines:
        return fallback(lines, days)
    prompt = (
        f"The estate, {w['width']}×{w['height']} cells of it, has just lived "
        f"through {days} days ({W.season_name(w['day'])}). "
        f"The weather was {w['weather']} "
        f"and {len(w['residents'])} people live here in "
        f"{len(w['households'])} households.\n\n"
        "What happened, oldest first:\n"
        + "\n".join(f"- {ln}" for ln in lines[-30:])
        + (("\n\nEarlier:\n" + "\n".join(f"- {ln}" for ln in recent[-4:]))
           if recent else "")
        + "\n\nWrite ONE paragraph of two to four sentences recording these "
          "days as a chronicler of this place would: plain, unhurried, and "
          "about the people and the estate rather than about the numbers. "
          "Do not list events; tell what the run of days was like. No "
          'headings, no bullet points. Reply with JSON only: '
          '{"text": "..."}')
    out = llm.chat_json(system(), prompt, schema(), max_tokens=220,
                        job="chron")
    if not isinstance(out, dict):
        return fallback(lines, days)
    text = _tidy(out.get("text"))
    return text or fallback(lines, days)


def system():
    return ("You keep the chronicle of a small housing estate: a plain, "
            "unhurried record of ordinary days. You do not invent events — "
            "you are given what happened and you say what the run of days "
            "was like. No flourish, no moral, no numbers.")
