# Highfield — bug worklist

Highfield is built under Grove's sixteen recorded failure classes (see the
README for the table). New findings get new numbers here, and each entry
says which class it belongs to, how it was found, and what its own check
is. One fix per commit, verified by its check before it lands.

The list is the record. Entries are left as written even when the tree
moves under them.

---

## Phase 0 — the skeleton, the pack, seeded generation

Four faults, all found in the first hour by **looking at the output** —
which is class 16 (only the eye catches it) doing exactly what it is for.
The generator ran happily and produced a plausible estate; the plan drew
fine and the numbers looked right.

- [x] **h1** *class 15 & 16* — **every building's door was inside its own
  footprint.** `gen.py` set a block's door to the middle of its near long
  edge — a cell the block itself occupies, and a building is entered at its
  door and never crossed, so that door was impassable. The same fault in
  the shop. **Nobody could ever have left a flat.** Found by checking the
  one property the design rests on: *is the door walkable?* — which had
  never been asserted. Fix: the door is the walkable cell just outside the
  footprint. Check: over 20 seeds, every building's door is walkable and
  stands on a path or paving.

- [x] **h2** *class 1 & 5* — **the recipe could fall short in silence.**
  `gen.trees`/`benches`/`lamps`/`bins` say what the estate should hold, but
  the placement loop aimed at unfiltered candidates: a cell already holding
  a bench ate a lamp's place in the list, so the recipe asked for nine and
  got seven without a word. `gen.shop` was worse — a condition that could
  never be true skipped the shop entirely and said nothing. This is the
  unread-value class wearing its other face: a number that looks like it
  means something and does not. Fix: candidates are filtered to free ground
  *before* the quota is taken from them, and gen **raises** naming the
  shortfall rather than delivering fewer. Check: five seeds reproduce the
  recipe exactly; a plan too small for its recipe fails loudly.

- [x] **h3** *class 8* — **the playground was never drawn.** `_rect(cells,
  px, py, px+3, cy1 - cy0, "play")` passed the courtyard's *height* where a
  y coordinate belonged, so the rectangle was empty and the estate had a
  playground fixture standing on paving. Wrong operand, in the same call
  shape as Grove's b7. Found by counting the site kinds in the drawn plan
  and noticing `play: 0`. Check: the plan holds the play cells the recipe
  implies.

- [x] **h4** *class 2, in miniature* — **an unused import and an unread
  local.** `gen.py` imported `random` and never used it, and computed
  `gap = g["block_gap"]` while the block insets were written as a literal
  `2` below it — the pack's `block_gap` knob doing nothing, which is Grove's
  b34 caught this time before it shipped. Fix: the import goes, and the
  insets read `gap`.

- [ ] **h5** *class 1, knowingly taken* — **the pack runs ahead of its
  readers.** Phase 0 ships `needs`, `fixtures`, `households`, `engine`,
  `pacing` and `gate` — 56 keys that no module names yet, because the
  residents, the fixtures, the gate and the watcher do not exist. The rule
  is that a key nothing reads is a bug; here the keys are the design
  landing before its code. **Not fixed, and not hidden**: `tools/audit.py`
  names every one of them and exits non-zero under `--strict`, so the debt
  is a number that can be watched rather than a silence that can be
  trusted. It closes when the phases land — the audit is what says so.
  (The audit itself had the class-14 fault on its first run: it grepped
  the whole package including `rules.py`, where the keys are *defined*, so
  a definition counted as a reader and it reported nothing. A check that
  lies about what it checks is worse than none.)
