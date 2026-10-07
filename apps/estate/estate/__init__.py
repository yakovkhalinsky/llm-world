"""Highfield — a housing estate that lives.

A self-contained estate on a small language model. The engine owns all
state and is fully deterministic per seed; the model is a watcher with no
stake, which sends weather and small fates and narrates them, and owns
nothing.

The design rule, inherited from Grove: the simulation owns the world; the
LLM only bends it, through bounded schema-validated jobs with deterministic
fallbacks, so the estate cannot break when the model writes nonsense, times
out, or is unplugged.
"""

__version__ = "0.1.0"
