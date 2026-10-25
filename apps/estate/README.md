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
./estate.sh web                # dashboard on :8787 — plan / , 3D /3d
python3 tools/balance.py       # the gate: 8 estates, years, every law
```

The web server's own tests are stdlib-only:

```sh
python3 -m unittest discover -s tests
```

The dashboard runs the estate at a pace you choose — `a day every 60s`,
`20s` or `5s`, set in the control panel and owned by the pack
(`pacing.day_seconds`), not by the page. At the slowest, one of the day's
five phases lasts twelve seconds and you can follow a single person out of
their door and back; at the fastest the phases blur into a timelapse.

It is one hand-written page and no build step: a background
thread ticks the estate and the page draws it, gliding each resident from
where they were yesterday to where they are today, and turning the light
across the plan as the five phases pass. PixiJS is **vendored** beside the
page (`estate/page/vendor/pixi.min.js`), so the file is never fetched from
a CDN at runtime and the whole thing works offline. If PixiJS will not
load, the page falls back to the plain glyph map rather than showing a
blank rectangle.

## The 3D view

There is a second view at <http://localhost:8787/3d> (follow **3d ↗** on
the plan page, and **← plan** to come back). It is the same estate, the
same poll and the same five phases seen through a real camera: solid
blocks with their floors, doors and windows, the fixtures in their cells,
and the residents gliding between them. The windows of lived-in flats warm
at dusk while empty ones stay dark, lamps lay pools of light on the
ground, seasons turn the grass and the trees, and rain falls as streaks.

Drag to orbit, wheel to zoom, right-drag to pan (arrow keys pan too), and
click or hover a resident or a block for its card. Pause, **+ day** and
the three paces work exactly as they do on the plan page.

For screenshots and headless checks:

- `?phase=night` freezes the light at a phase (`dawn`, `morning`,
  `afternoon`, `evening`, `night`; `day`, `dusk` and `sunrise` are
  accepted). Without it the light turns with the tick.
- `?static=1` draws the first state and stops — afternoon if no phase was
  named — so a screenshot does not depend on when the browser was ready.
- `?view=top` starts overhead, for looking at the whole plan at once.
- `?focus=bench` frames the camera close on the busiest occupied bench
  (any bench if the estate is indoors), so a screenshot can show people
  sitting on one; `?focus=x,y` frames a named cell instead.
- once the first state is drawn the page publishes
  `window.__estate3d = {ready, residents, buildings, benches, seated,
  phase}` — `seated` is how many residents are on a bench now.

Three.js **r170** (MIT) is vendored in `estate/page3d/vendor/` together
with `OrbitControls` and the licence; the page's import map resolves
`three` locally. Nothing is fetched from a CDN at runtime and there is no
build step, so the 3D view works offline like the plan. If WebGL is not
available the page says so and links back to the plan at `/`.

Check the page without a browser — it is the page's own scripts against a
stub PixiJS, asserting the layer order (the tint under the lamplight, or
a lamp the night darkens is not a lamp), that a warm frame draws nothing,
and that the weather falls in the plan's box and not the window's:

```sh
python3 -m estate web &            # in one shell
curl -s localhost:8787/api/ground > /tmp/g.json
curl -s localhost:8787/api/state  > /tmp/s.json
node tools/pixi_check.js /tmp/g.json /tmp/s.json
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
  shop, lamps and trees. They are used, they wear, and they break. Benches
  stand in the courtyard's bands and beside the door paths — the walkways
  through the courtyard — spaced apart and preferring ground near a tree or
  a lamp, so the estate passes seats on its way rather than having to know
  where they are. In both views a resident on a bench's cell sits on it, up
  to its capacity — a path-side bench turned to face the walkway it serves.
  A lamp affords nothing by itself — it
  *lights*, and what it lights is worth more in the evening, which is the
  whole reason a courtyard has them.
- **A need is chosen before a place.** The resident picks what presses
  hardest and *then* the best place for it, falling to the next need down
  when the first has nowhere to go. Scored the other way round, the nearest
  bench beats a meal merely by being nearest.
- **A walk goes round a wall.** Movement is a greedy step toward the
  target, priced by the ground — but a building is impassable, so when
  every step forward is a wall the walk commits to a side and holds it
  until the way opens.

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
| `estate/web.py` | the dashboard's server: the page, the state API, the tick thread |
| `estate/watcher.py` | the watcher: the menu, the digest, the validator |
| `estate/llm.py` | the Ollama client: one voice, one chain, never raises |
| `estate/chronicler.py` | the estate's record of its own days, with and without a model |
| `estate/engine/households.py` | ageing, births, deaths, emigration, the letting office |
| `estate/engine/effects.py` | the watcher's fates: what lands, what lasts, what ages |
| `estate/page/` | the dashboard: PixiJS scene, panels, and the vendored engine |
| `estate/page3d/` | the second view: Three.js scene, HUD, vendored r170 engine |
| `tools/pixi_check.js` | the page's headless check: the layer order, a warm frame, the weather's box |
| `estate/db.py` | SQLite: the estate as one blob, plus its census |
| `tools/balance.py` | the gate: seeded estates × years, every law must hold |

## Status

**All seven phases.** The estate plants, steps, draws and is deterministic
per seed; its people choose, walk and are satisfied; its fixtures fill,
wear and break; its households age, grow, leave and refill; a watcher
sends it weather and luck from a menu it cannot invent past; and the
dashboard shows all of it.

The gate is `tools/balance.py`. It runs seeded estates for years with no
model at all and refuses one that has lost a household type, emptied, gone
quiet in the wrong way, or settled into a marching band — and it prints a
fingerprint, so an engine change that alters the world's behaviour cannot
land unnoticed.

The recipe grew on this branch: `gen.path_benches` asks for six benches
beside the courtyard walkways, so an estate now has thirteen benches where
it had seven. That is a deliberate change to the world, and the gate's
fingerprint moved with it — `dcb219a70d21072f` → `ba8cdf35318ba5eb` — because
world generation is the world. Every law still holds, with friction between
1.33 and 1.37 and distinctness between 7.90 and 7.98. The new benches draw
from their own rng salt after the trees, so for a given seed every other
fixture stands where it stood; what changed is the benches, not a reshuffle.

Nineteen faults are recorded in `docs/BUGS.md` under Grove's sixteen
classes. Almost none of them crashed anything. They were found by asking
the estate's own design questions and checking the answers — *do the needs
get met*, *is the playground heard*, *does anyone live above the third
floor* — which is the whole of the method this project inherited, and the
reason the ledger is the most useful file in it.

Still deferred, each deliberately: money, traffic beyond noise, a school
timetable, illness, interiors as a grid, A*, the steward, embeddings, the
SVG twin.
