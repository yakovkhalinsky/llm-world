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

---

## Phase 5 — the watcher and its fates

- [x] **h13** *class 3, caught before it could run* — **the prompt listed a
  different menu from the law.** `presentation.watcher_system` — written
  at phase 0, long before any fate existed — enumerated the fates it
  expected: rain, heat, frost, storm, delivery, *festival, closure, outage,
  pipe, stray*, quiet. The `fates` table, written now, holds rain, storm,
  heat, frost, delivery, *roadworks, power_cut, tranquillity, damage*,
  quiet. Five of the prompt's fates had no law behind them and four of the
  law's were invisible to the model — grove b46 exactly, a digest offering
  what the validator refuses, and the reason the validator exists. Found by
  reading the two side by side while wiring them, which is the only way
  this class is ever found. Fix: the prompt keeps the voice and the
  discipline and **names no fates at all**; `watcher.digest` prints the
  menu from the table, so there is one home for it and nothing left to
  drift. Check: every fate the digest offers validates, and every fate the
  law has appears in the digest.

- [x] **h14** *class 4, in miniature* — **the sky a fate sent was spent
  before it was seen.** The tick landed the fate and *then* rolled the
  weather, and `roll_weather` takes the day it is called on out of a
  span's count as it decrements — so a storm sent for two days was clear
  by the following morning: `weather_left` went 2 → 1 → 0 in one tick.
  Found by sending a storm and watching the sky for a week. Fix: the sky
  rolls first and the fate overwrites it, which is also the truer order —
  the watcher is the weather, and what it sends for today is what today
  is. The wet streak is now read from the sky the estate actually got.
  Check: a fate sent for N days is in force for N days.

---

## Phases 4, 6 and 7 — households, the gate, and the chronicle

The estate now grows into its own housing, ages, loses people and fills
their flats; the gate judges eight of them over years; and the chronicle is
written. Five faults, and the first four were all found by *asking the
estate's own design questions and checking the answer* rather than by
anything crashing. Nothing crashed for any of them.

- [x] **h15** *class 8* — **the estate outgrew a shop it could never
  mend.** With the flats filled, one shop served 171 errands a day, and
  the wear rule is linear in use while the mending rule is not: at that
  load its equilibrium condition was **0.08**, so the estate spent seasons
  with a shop that broke every few days, and food — which has exactly one
  source — went with it. Every other kind was healthy (benches 0.79, the
  playground 0.74); only the busiest thing in the estate was broken, which
  is the shape h12 had already warned about and a different mechanism.
  Found by measuring every fixture kind's equilibrium rather than looking
  at a summary. Fix: `upkeep` in the pack — how well the estate looks after
  *this sort of thing* — because sorts differ: a shop has someone who runs
  it and a bench has nobody. The attrition loop survives; a kind just has
  to be used past what its own upkeep can carry. Check: the busiest kind's
  condition settles above zero as the estate grows.

- [x] **h16** *class 1, and the best-hidden of the set* — **the noise field
  was built from a list that is always empty at the moment it is read.**
  `build_noise` read each fixture's `occupants`, and `update_fixtures`
  empties `occupants` at the end of every day, so when the field was built
  each morning every fixture was empty: *the playground had never made a
  sound.* Grove's b15 exactly — a field written every tick and read by
  nothing — except here the field was read and its source was always
  nothing. Worse, the kernel was 3×3 for everything, so even a full
  playground was inaudible from the nearest door, seven cells away. **The
  estate's central design claim — that quiet is a commons, that noise does
  not stop at a wall — was not implemented at all**, and the measurement
  proved it backwards: flats near the playground were *quieter* than far
  ones. Fix: `occupants` is who is here now (congestion reads it) and
  `last_use` is how many were here yesterday (the noise field reads that),
  one fact per home; and `carry` says how far each sort of sound is heard,
  because a playground is not a bench. Check: flats near the playground
  want quiet more than flats far from it.

- [x] **h17** *class 9* — **the letting office filled the estate from the
  ground up.** It let to the lowest-numbered vacant flat, and unit ids run
  floor by floor, so after two years **nobody had ever lived above the
  third floor** and the stairs — the entire interior model — were a cost
  almost nobody paid. The plan's own rider says the stair cost must
  interact or it is invisible noise; it was invisible, and it had been
  invisible since phase 0 because of a `sort`. Fix: the office lets what it
  has, chosen deterministically. Check: the upper floors are lived in.

- [x] **h18** *class 2* — **the stairs were charged twice.** `_go_to` takes
  `floor × stair_step` out of the phase's step budget, which *is* the cost
  of climbing; `_utility` also subtracted it as a penalty. Charged once, a
  fourth floor is a walk; charged twice it is 1.4 against a flat worth
  0.62, so nobody above the third floor ever went home at all — they slept
  on benches, and the estate had a wing of empty bedrooms. Two copies of
  one fact, and the second copy was the one in charge. Fix: the cost lives
  in the walk, where it is physical, and what makes a sixth floor hard is
  the distance rather than a dislike of it. Check: residents on every floor
  arrive home.

- [x] **h19** *class 14, in the gate itself* — **a band fitted instead of
  derived.** The friction band was written at phase 0 as `(0.15, 0.85)`
  before any estate existed to have a value, and a perfectly living estate
  of 130 people failed it at 1.7 — the gate was about to be "fixed" by
  widening a number until its own subject passed, which is how a check
  becomes decoration. The statistic is `urge × need × phase-multiplier ×
  drains`, so its scale is set by what it is made of: a need pinned at its
  ceiling gives about 5, and needs at zero give 0. The band is now derived
  from those two facts — the top under a famine, the bottom above nothing —
  and it can still fail in both directions. Check: the reasons are in the
  pack, beside the numbers.

Three faults were also caught in passing and folded in rather than numbered:
the estate had **two censuses that disagreed** (`world.counts` counted
people by their household's type; two other places counted households), so
the same estate answered differently depending on who asked — one home now,
and it is the one the roster law is about. `render.say` printed raw event
kinds for events it had no wording for, so `moved_in` reached a chronicle
draft as the literal string. And a knob added and never read
(`pacing.watcher_every`) was removed the same day: the project's own rule
about unread keys applies to the person writing them too.

- [x] **h20** *class 14, caught by the gate on its first real run* — **a
  place the law offered and nobody wanted.** The gate's first honest run
  named one failure: `tree` — a fixture kind with zero uses in 364 days. A
  tree afforded `quiet: 0.35, rest: 0.15`, and under the shade term (its own
  cell is only 0.30 shaded) that is worth 0.36 against a flat's own 0.62 —
  and `quiet` presses hardest at night, when everyone is indoors anyway. So
  not one person sat under a tree in a year, and the pack said one should
  want to. The tempting fix was to raise the number until the check passed;
  the honest one was to read what the check said. **A tree is not a place
  you go.** It shades — and the field it makes is already read by the heat
  bonus and the quiet bonus wherever a person is sitting, so a bench under
  a plane is a better bench than a bench in the open and the tree is the
  reason. Its affordances are now empty, exactly as the lamp's are: a lamp
  lights and a tree shades, and neither is somewhere you go. Check: the
  gate's fixture-use rule, which is what found it.

---

## After the phases — found by looking at the running estate

- [x] **h21** *class 1 & 5 — and my own fault, twice over* — **the write
  path and the read path each worked and nothing joined them.** The
  chronicle was written faithfully — a year of it, 120 entries in the
  database — and the dashboard served **zero**, because the running server
  never loaded the history it already had. `Estate` read it into
  `self.history` and `cmd_web` was supposed to hand it to the runner; the
  patch that did that *silently matched nothing*, so the line was never
  there and nothing failed. Two faults in one: a join nobody made, and a
  replacement I did not assert. It is the second one that matters — the
  same shape as the steward's `add_amendment` patch, which silently failed
  to apply and made every amendment raise a TypeError into a swallowing
  loop. **A patch that does not match must be an error, not a no-op**: every
  edit in this session now asserts that its target was found and its
  result is present. Found by curling the running estate and comparing what
  it served against what was on disk, which is the only way this class is
  ever found.

- [x] **h22** *class 1* — **the pace had no home, and the one place that
  looked like it did was read by nothing.** `pacing.day_seconds` held
  `{"run": 6.0, "web": 6.0}` and nothing ever read it, while the estate's
  actual pace was set by three separate literals in the CLI — a `3.0` for
  the terminal watcher, a `6.0` for the dashboard, and a `6.0` again in the
  page's own fallback for how long a day lasts. Four numbers describing one
  fact, three of them live and none of them the one that looked official.
  Fix: the pack holds the paces the estate may be watched at — a list, 60,
  20 and 5 wall seconds a day — the CLI's default is the middle of it, the
  dashboard sends the list down with the ground, and the page builds its
  buttons from what it is given rather than from a copy. Three and not a
  slider: a day is five phases, so at 60 s a phase lasts twelve seconds and
  you can follow one person out of their door and back, while at 5 s the
  phases blur into a timelapse, and there is nothing honest between those
  worth a fourth stop.

- [x] **h23** *class 5, the mirror of h21* — **a replacement that matched
  more than it should.** Adding the watcher's styles used a bare
  `replace(".feed {", …)`, and `.feed {` occurs **twice** in the stylesheet
  — once as the rule, once inside the narrow-view media query. So the new
  rules were inserted into both, and the media query came out holding a
  duplicate of the watcher's styles and a stray fragment of the main rule.
  It was still *valid* CSS and still looked approximately right, which is
  what makes this class dangerous: nothing failed, nothing was reported, and
  the damage was only visible by reading the end of the file. h21 was a
  patch that matched nothing; this is a patch that matched everything. Both
  are the same lesson, and the rule is now the same for both: **assert on
  the count, then assert on the result** — every replacement in this
  session names how many times its anchor occurs and fails unless it is
  exactly once. Found by the next edit's assertion refusing to match inside
  the corrupted block, which is the first time a check of mine caught a
  mistake of mine before it landed.

- [x] **h24** *class 12, and the one a person noticed first* — **the estate
  lost its texture, and the panel that should have shown it was looking at
  the wrong thing.** Yakov reported that the day feed had stopped
  updating. It had not stopped: it was faithfully reporting that nothing
  was happening, and nothing was happening because the `upkeep` fix of h15
  — which stopped the shop starving the estate — had also stopped anything
  ever breaking. Condition `0` is what fires a `broke`, and after upkeep no
  fixture came within 0.45 of it, so the estate's attrition loop, one of
  the three the whole design rests on, had been quietly switched off by the
  repair of a different fault. Over 400 days it produced 54 events, all of
  them in the first ninety while the flats were filling. **A fix for one
  thing had silently removed another**, and no check was watching: the gate
  asks whether a kind is *entirely* broken, which it never was. Two faults
  in one place, then. The estate now has ordinary failure — a slat gives
  way, a bulb goes — at a rate the pack states per sort of thing, and the
  feed is **days rather than events**: one row a day, and a day with
  nothing in it says `a quiet day`. A feed of events looks frozen on an
  estate having a quiet week, which is most weeks, and a panel that sits
  still for half an hour reads as broken however truthful it is. (The
  failure roll was written in the wrong place first — zeroing the condition
  *before* `was` was read, so the repair term computed from the zeroed
  value and put the thing straight back, producing a round of failures and
  no events at all: the same "nothing happened and nothing said so" shape,
  caught this time by counting.)

- [x] **h25** *class 2 & 5, and worse than h23 because it shipped* — **two
  functions of one name, and the dead one ran.** The day feed was reported
  fixed and was not: `panels.js` held **two** `function feed(st)`, the new
  day-based one and the old events-based one, and a function declaration
  hoists — so the *second*, which reads `st.events` and had been dead for a
  day, was the one actually called, and it kept painting "nothing has
  happened yet" over a panel whose data was sitting right there. The
  duplicate came from the same slice-based insertion as h23's over-match:
  `t[index(seasonName):index(feed)]` replaced *up to* the old feed and put
  a new one in front of it, leaving the old one behind. And the reason it
  shipped is the more useful part — **every check passed**. The harness
  asserted that the header and the census had been written and never once
  asserted what the feed *rendered*, and the census assertion matched
  `<li>`, which the empty-state message also is, so it passed on the very
  failure it was standing next to. Three faults in one afternoon's work,
  all of the same family: **a check that cannot fail is not a check.** The
  harness now asserts the feed's actual rows, the census assertion asks for
  the census, and a new guard fails if any name is declared twice in a file
  or twice at the top level of the page.

- [x] **h26** *class 12, and the one that took three tries* — **an estate
  whose days were interchangeable had no days in it.** Yakov reported that
  the feed always said "a quiet day". It did, and it was telling the truth:
  the estate ran 391, 395, 397 errands every single day, and eighty-odd
  people went out and came home in the same order every morning. **The
  plan's three anti-equilibrium loops were not what was missing. What was
  missing was that two of them had never been connected:** the plan has
  said since it was written that weather "keeps people in", and nothing
  implemented it — rain softened the noise and changed nothing else at all
  — and nothing anywhere distinguished Saturday from Tuesday. Fixing it
  took three goes, each wrong in an instructive way. Putting the sky on the
  *places* did nothing, because it multiplied every outdoor option by the
  same number and left the ranking untouched. Putting it on the *pressure*
  worked, but only for needs that cannot be met at home — which meant the
  engine had to stop hardcoding `("rest", "quiet")` in two places and ask
  the pack which needs a flat can meet (`"home": true`), a fact about a
  need that belongs with the needs. And the day's own line was a recital of
  the same three statistics until it was made to lead with whatever
  differed. A storm now stops the estate (243 errands against 393); rain
  and frost visibly shorten it; the weekend has a shape; households come
  and go for their own reasons rather than only when miserable, which after
  the flats filled they never did — so the estate had no comings and no
  goings and no news of any kind for years. Check: the day feed's lines are
  distinct, and the gate still holds.
