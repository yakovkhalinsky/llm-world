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

---

## Phases 1–2 — needs, places, and the walk

The engine ran, nobody crashed, and the plan drew. Every fault below was
found by **measuring the year** — a simulated 364 days on a throwaway
world — and asking the one question phase 1 exists to answer: *do the
needs actually get met?* They did not, five times over.

- [x] **h6** *class 8* — **a place's quality was read as an absolute
  instead of a share of the need.** A bench affords `company: 0.25`, and
  the code spent it as 0.25 of the need — against a day that adds 1.1. No
  number of visits could ever keep up, so food, company and play sat pinned
  at the 4.0 ceiling all year and the estate was, in the only sense that
  matters, starving. The quality is a *fraction of a whole need*: one visit
  to the shop is most of a meal, one visit to the bench is a quarter of an
  afternoon's company. Fix: `restore = need_max × arrive_restore × quality`,
  the same expression for a flat as for a place. Check: after a year, every
  need's mean sits under a third of its ceiling.

- [x] **h7** *class 1 & 8, and the worst of the set* — **the need was
  never chosen; the place was.** The resident was supposed to pick the
  need that pressed hardest and *then* the best place for it — that is what
  `top_need` was written for. `update_residents` never called it: it scored
  every (place, need) pair by the place's own quality and took the best
  pair. Since a need's urgency was nowhere in that score, **the nearest
  bench always beat a meal**, and the estate ate only when eating happened
  to be convenient. `top_need` was defined, correct, and dead — the
  unread-value class, this time with the value being a whole function.
  Fix: `ranked_needs`, a need is chosen by pressure first and a place
  second, falling to the next need down when the top one has nowhere to go.
  Check: no need is ever the top pressure while sitting at its ceiling.

- [x] **h8** *class 1* — **a masked need drained for the people it was
  masked from.** `play` is a child's need: `pressure` refuses it for an
  adult, so an adult can never satisfy it — but `drain` added it to every
  resident every phase. Thirty-four adults carried a play need of 4.0
  forever, a number nothing could ever spend. Fix: a need whose `roles`
  exclude you does not drain for you. Check: no resident carries a need
  their own role cannot meet.

- [x] **h9** *class 15* — **the plan placed two needs where nobody could
  reach them.** The shop stood at the courtyard's west end and the
  playground at its east, so the far blocks' doors were 22 cells from food
  and 18 from play — past `engine.scan`, which is the filter that decides
  whether a place is a candidate at all. Fourteen residents could never eat
  and twenty-five could never play, whatever they chose, and the need just
  sat at its ceiling. Two surfaces — a need and the place that serves it —
  that never meet. Fix: the shop and the playground stand in the middle of
  the courtyard, where an estate's amenities stand; and `gen` now **checks
  reach**: every door must reach a place affording every need it serves,
  within `scan`, or the plan is refused by name. Check: the reach check
  runs at generation on every seed.

- [x] **h10** *class 15 & 8* — **the walk could not get around a wall, and
  an arrival was reported as a failure.** Grove's `step_toward` is greedy:
  it steps toward its target and there was never a wall to argue with.
  The estate has blocks, and a building is impassable — so a resident whose
  target lay behind one gave up and stood still. Worse, the first way round
  that suggested itself was the cell it had just come from, so a walk beside
  the shop oscillated between two cells for forty steps and never passed
  it. Three children stood above the shop for 728 days and never ate. And
  separately: a walk that arrived on its final step fell out of the loop and
  returned *False*, so the visit did not count. Fix: going round is a
  committed maneuver that holds its side until the way opens, and the walk
  checks arrival after the loop. Check: from all four doors of all four
  blocks, a walk reaches the shop and the playground.

- [x] **h11** *class 1, in miniature* — **a container with no reader.**
  `gen` wrote `st["names"] = {}`, which nothing ever read, while the pack's
  `presentation.resident_names` — a list of forty-seven names — was read by
  nothing at all. A dict that looks like state and a list that looks like
  a feature, both inert. Fix: people are named at generation from the pack,
  and the empty dict goes. Check: every resident has a name, and the audit's
  unread-key count drops by one.

- [x] **h12** *class 11 & 12, and the best of the set* — **the mending
  shrank exactly as the wear grew, so the busiest place on the estate could
  never mend.** `condition` fell by `decay × (1 + busy_wear × uses)` and
  rose by `repair / (1 + uses)`: the more a thing was used, the faster it
  wore *and* the slower it mended, which is a one-way ratchet to zero for
  anything used often enough. Nothing on the estate is used oftener than
  the shop — and food has exactly one source. So the shop sat permanently
  at condition 0.000, and the estate ate on alternate days: everybody ate
  until the shop broke, the shop mended a hair overnight (0.0198), and
  everybody ate again. A metronome, three days long, built out of the very
  loop that exists to prevent one — and invisible in every summary, because
  the *average* need over the year looked like a mildly hungry estate
  rather than a clock. Found by watching the need day by day instead of at
  the end. Fix: mending grows with the damage (`repair × (1 - condition)`),
  so every fixture has a real level — the busy ones lower — and a thing
  used past what the estate can keep up with still fails, which keeps the
  attrition loop the design wanted. Check: the busiest fixture's condition
  settles above zero, and the estate's food does not alternate.
