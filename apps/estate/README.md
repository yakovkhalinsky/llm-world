# Highfield — a housing estate that lives

A self-contained estate on a small language model: four residential blocks
around a courtyard, a shop, a playground, benches, trees, and the people
who live among them — going out, coming home, wearing the swings out,
falling out with the neighbours, moving away, moving in.

Nothing here waits on the model. The engine owns every fact, the world is
fully deterministic per seed, and a small LLM is **a watcher with no
stake**: it sends the weather and the occasional small fate, and its words
become the estate's diary.

## The design rule

> The simulation owns all state; the LLM only bends it. Every model output
> is schema-validated with a deterministic fallback, so the world cannot
> break when the model writes nonsense, times out, or is unplugged.

## The constraints this project was built under

Highfield is a separate world from Grove — a forest simulation with a much
longer history — but it inherits Grove's design rule *and* the sixteen ways
that rule was found to go wrong across its 52 recorded bugs. They are
constraints here, not folklore:

> Every fact has one home; every field has a reader; every accumulation has
> a lifetime; every boundary has one geometry; every external value is
> type-checked; every failure names itself; every tuned change passes the
> gate first; and if a threshold has no good value, the model is wrong, not
> the threshold.

| the rule | the failure it prevents |
|---|---|
| Every field has a named reader; a config key with no consumer is a bug | a whole subsystem built and never connected |
| One home per fact; no literal may duplicate a config default | two copies that drift apart |
| One schema for the given and the accepted; never silently rewrite a legal value | a validator that disagrees with what it is fed |
| Every accumulation declares its lifetime; an effect ages before the next lands | state that is written and never counted down |
| Never catch and continue silently; keep job, model, why and raw payload | a failure swallowed while the record said success |
| Anything that can degrade needs a recovery path with a cadence | a value computed once and frozen forever |
| Compute and draw in the same named space | a unit mismatch nobody can see |
| Attribute a cause from the pressure that hit *this* instance | an aggregate blaming the wrong thing |
| Defaults are live and obey the data they claim to obey | a subsystem switched off, quietly |
| Never truncate continuous state; test the smallest viable population | an accumulation that kills the small case |
| Persistence is atomic; rebuild from the ledger when records disagree | a file truncated halfway through a write |
| No catch-all identity default; resolve to your own data or fail loudly | a missing fact silently borrowing a sibling's |
| Never hold the world lock across a network call | a stalled world behind a slow answer |
| Regression-first: every check must fail on the unfixed code | a harness guarding the old behaviour |
| One geometry for a shared boundary; if a threshold has no good value, the model is wrong | two surfaces that never meet |
| Render every surface and look at it | the bug only an eye can catch |

**Practice:** audit the config for unread keys; audit the data for unread
fields; render every entity and look; walk the world through a recording
harness; diff golden census output; sample the real model against the real
client rather than the happy path; force the rare branch; ask why two views
disagree.

**Principles:** the gate first, always; one fix per commit, verified before
it lands; reopening tuned balance is a deliberate work item and never a
side-effect; the world's nature is a pack and every engine, gate and
renderer asks the pack; data and presentation are separate; diagnostics
name themselves; the record of a deliberate non-fix is kept, with its
reason.

## Running it

```sh
./estate.sh new --seed 42      # plant an estate (deterministic, no LLM)
./estate.sh step 100           # advance 100 days, headless
./estate.sh map                # draw the plan
./estate.sh status             # census history
./estate.sh rules              # the live ruleset
```

## The world

- **A day is a tick**, resolved in five phases — dawn, morning, afternoon,
  evening, night — so a day is a life rather than a snapshot.
- **The plan** is a rectangle of ground: road, path, paving, lawn, the
  playground, water, and building footprints. A building is entered at its
  door and never crossed.
- **Being inside is a state, not a coordinate.** A resident is either on the
  plan or in a flat; coming and going costs the stairs.
- **Five needs** — food, rest, company, play (children only), and quiet —
  met at the places that afford them, and interfering by design.
- **Fixtures** are the placed things: benches, the playground, tables, the
  shop, lamps, bins, and trees. They are used, they wear, and they break.

### What keeps it from settling into a metronome

A world of met needs is a dead world. Three loops prevent it:

1. **A place affords less the busier it is** — the seventh child on the
   swings gets almost nothing, so demand redistributes itself.
2. **Use wears things out** — the busiest playground cracks first, and an
   unattended estate degrades.
3. **Quiet is a commons, not a property** — noise is a field, so it is the
   one need that a lively estate can never fully meet.

## Layout

| path | role |
|---|---|
| `estate/engine/` | the tick's domains: the sky, the plan, the people, the households, the watcher's fates |
| `estate/biomes/` | a world's nature as a pack: `estate.py` |
| `estate/rules.py` | the live ruleset + pack folding + JSON overrides |
| `estate/world.py` | state containers, the calendar, the one rng |
| `estate/gen.py` | seeded estate generation (no LLM) |
| `estate/render.py` | the terminal view: the plan and the day's lines |
| `estate/db.py` | SQLite: the estate as one blob, plus its census |
| `tools/balance.py` | the gate: seeded estates × years, every law must hold |

## Status

Phase 0 — the skeleton, the pack, seeded generation and the day's turn.
The estate plants, steps and draws, and is deterministic per seed. The
people do not yet act: needs, places, fixtures and households arrive in
the phases after, each with its readers rather than ahead of them.
