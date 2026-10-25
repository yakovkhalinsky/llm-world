# Highfield — a housing estate that lives

A self-contained estate on a small language model: one row of residential
blocks along the north, open ground and a courtyard in front of them, a
shop, a playground, benches, trees, and the people who live among them —
going out, coming home, wearing the swings out, falling out with the
neighbours, moving away, moving in.

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
./estate.sh web                # dashboard on :8787 — the 3D view at /
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
thread ticks the estate and the page draws it, walking each resident from
where they were yesterday to where they are today, and turning the light
across the estate as the five phases pass. Three.js is **vendored** in the
folder both apps' 3D views share (`../shared/page3d/vendor/`), so the file
is never fetched from a CDN
at runtime and the whole thing works offline. If WebGL will not start, the
page shows the server's glyph map (`/api/plain`) rather than a blank
rectangle.

## The view

The estate has one view, in three dimensions, at
<http://localhost:8787/>. `/3d` and `/3d/` serve the same page: they are
kept as aliases for old links and for screenshot URLs, whose `?phase=`,
`?clock=` and `?focus=` query strings a redirect would drop. Every asset is
absolute under `/3d/`, so it resolves from either address.

It is the same estate, the same poll and the same five phases seen through
a real camera: solid blocks with their floors, doors and windows, the
fixtures in their cells, and the residents walking between them. The
windows of lived-in flats warm at dusk while empty ones stay dark, lamps
lay pools of light on the ground, seasons turn the grass and the trees, and
rain falls as streaks.

The light runs on one continuous clock rather than switching when a poll
reports a new day: the sun crosses the sky, the sky and fog take its colour,
and the lamps, windows and figures' warmth ease in and out over a long
dawn and dusk. The clock is a day from midnight to midnight, and the five
equal phases run dawn, morning, afternoon, evening and night, with the
night straddling the day's turn: the hour either side of midnight is one
phase, not two, and the darkest light is the same on both sides of the
seam. So there is no moment where the scene jumps. A paused day freezes
the light where it is, and changing pace changes the rate of the day, not
the hour it is at.

Drag to orbit, wheel to zoom, right-drag to pan (arrow keys pan too), and
click or hover a resident, a block or a fixture for its card; a click also
names the ground cell under the pointer, so a lawn, the water or a path has
a card too. Pause, **+ day**, **⛶ full** and the three paces are in the
bottom-left panel. The panel above them has three tabs: **the day** (one
row per ticked day, quiet days included), **who lives here** (households by
kind and people by role) and **☾ watcher** (the chronicle). The top-right
panel carries the clock, the weather, the population, the watcher's last
word and the model's voice line.

For screenshots and headless checks:

- `?phase=night` freezes the light at the middle of a phase (`dawn`,
  `morning`, `afternoon`, `evening`, `night`; `day`, `dusk` and `sunrise`
  are accepted). Without it the light turns with the tick.
- `?clock=0.2` pins the day's fraction instead, from 0 at midnight to 1 at
  the next midnight; the five phases start at 0.1, 0.3, 0.5, 0.7 and 0.9,
  so `?clock=0.2` is mid-dawn, `0.8` mid-dusk, and `0`/`1` are the
  darkest hour. It is finer than `?phase=` and wins if both are given.
- `?static=1` draws the first state and stops — afternoon if no phase or
  clock was named — so a screenshot does not depend on when the browser
  was ready.
- `?view=top` starts overhead, for looking at the whole plan at once.
- `?focus=bench` frames the camera close on the busiest occupied bench
  (any bench if the estate is indoors), so a screenshot can show people
  sitting on one. `?focus=perimeter` frames a stretch of the outer
  footpath, wide enough to hold its benches and the people on them;
  `?focus=x,y` frames a named cell instead.
- once the first state is drawn the page publishes
  `window.__estate3d = {ready, residents, buildings, benches, seated,
  outside, walking, perimeter, phase, dayFrac}` — `phase` and `dayFrac`
  are the clock the HUD and the light are reading (the fraction is 0..1
  and keeps moving), `seated` is how many residents are on a bench now,
  `outside` how many are not in a flat, `walking` how many the page is
  walking between cells, and `perimeter` how many are out on the estate's
  edge.

Three.js **r170** (MIT) is vendored in `../shared/page3d/vendor/` together
with `OrbitControls` and the licence; the page's import map resolves
`three` locally. Nothing is fetched from a CDN at runtime and there is no
build step, so the view works fully offline. If WebGL is not available the
page says why and shows the server's own glyph map from `/api/plain` in a
scrollable `<pre>`, refreshed while the estate ticks.

### Headless checks

The view is checked without a browser. Each check takes the server's own
two payloads — the static ground and the day's state — either as files or,
for the router, from a running server. They need Node; the Python suite
skips the wrappers when `node` is not on `PATH`.

```sh
python3 -m estate web &            # in one shell
curl -s localhost:8787/api/ground > /tmp/g.json
curl -s localhost:8787/api/state  > /tmp/s.json

node tools/hud_check.js  /tmp/g.json /tmp/s.json
node tools/walk_check.js /tmp/g.json /tmp/s.json
node tools/walk_check.js http://localhost:8787
node tools/clock_check.js
```

- **`hud_check.js`** runs `page3d/hud.js` against a stub DOM: the header,
  the day feed (one row per day, and not the empty-state message), the
  census and watcher tabs, a card for a resident, a fixture, a block and a
  cell, and the escaping of every string that comes from the world. It
  also refuses two functions of one name in a classic script. The feed
  must have more than a day in it, so pass it a state from a server that
  has been running (or press **+ day** five times); the Python wrapper
  ticks six days itself.
- **`walk_check.js`** is the router's test (`../shared/page3d/walk.js`): every door
  reaches every fixture with no nulls, no string-pulled segment crosses a
  building, the water or a solid fixture, an enclosed target returns null
  and terminates, endpoints off the plan or in a wall return null, a route
  sampled at its total lands on the target and stops, and a walk never
  outlasts the tick. It also reports 2000 uncached random routes as a
  timing line. Pass it a live URL to read `/api/ground` and `/api/state`
  over HTTP.
- **`clock_check.js`** runs `../shared/page3d/clock.js`, the pure day clock and light
  table the 3D page draws from: `light(0) == light(1)`, the pinned
  `?clock=`/`?phase=` fractions, a frozen paused day, and no
  frame-to-frame jump in any light channel at 60s, 20s and 5s a day with
  700ms polls over many days (including the day's turn and a pace change).

`python3 -m unittest discover -s tests` runs these wrappers too when Node
is present, planting a fresh seed-42 estate for them.

## The world

- **A day is a tick**, resolved in five phases — dawn, morning, afternoon,
  evening, night — so a day is a life rather than a snapshot.
- **The plan** is a rectangle of ground: road, path, paving, lawn, the
  playground, water, and building footprints. A building is entered at its
  door and never crossed. The blocks stand in **one row along the north**,
  doors facing south: a block always hides whatever stands behind it, and
  both views look in from the south-east, so the row is at the back and
  the ground in front — the courtyard with its shop, pond, playground,
  tables and original benches, plus the perimeter footpath and its seats
  on the open sides — stays visible. The north stretch of the perimeter
  path runs behind the row, as a service path behind the blocks. The
  recipe names the arrangement (`gen.layout:
  "row"`) and sizes the row to keep the old four-block capacity: two
  12-cell blocks of 7–9 floors and 4–5 flats a floor.
- **Being inside is a state, not a coordinate.** A resident is either on the
  plan or in a flat; coming and going costs the stairs.
- **Five needs** — food, rest, company, play (children only), and quiet —
  met at the places that afford them, and interfering by design.
- **Fixtures** are the placed things: benches, the playground, tables, the
  shop, lamps and trees. They are used, they wear, and they break. The
  courtyard's seven benches stand in its bands, as they always have. Ten
  more furnish the edge: a footpath runs one cell in from the ring road,
  and the benches stand on the outermost cell of the band, facing back
  across the path to the estate and spread evenly around all four sides.
  The path is cheap walking ground, so a resident who heads out crosses it
  rather than skirting it. The edge's benches carry a `perimeter_bonus` in
  the pack — the quiet and green of the margin, and the stroll for its own
  sake — which is enough for a resident with rest, company or quiet to
  spend to walk out, sit, and come back. The bonus is part of the bench's
  own base, so wear and crowding scale it exactly as they scale the bench;
  it is no larger than the bench's afford for each need, so a full edge
  seat is worth no more than an empty courtyard one. A bench's capacity is
  a hard seat count: two residents sit, and anyone else on the cell stands
  clearly beside it rather than on the slats. In both views a bench beside
  a path turns to face it. A lamp affords nothing by itself — it *lights*,
  and what it lights is worth more in the evening, which is the whole
  reason a courtyard has them.
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
| `estate/web.py` | the dashboard's server: the 3D page, the state API, the tick thread |
| `estate/watcher.py` | the watcher: the menu, the digest, the validator |
| `estate/llm.py` | the Ollama client: one voice, one chain, never raises |
| `estate/chronicler.py` | the estate's record of its own days, with and without a model |
| `estate/engine/households.py` | ageing, births, deaths, emigration, the letting office |
| `estate/engine/effects.py` | the watcher's fates: what lands, what lasts, what ages |
| `estate/page3d/` | the view: Three.js scene and HUD (served under `/3d/`, falling back to `../shared/page3d/`) |
| `estate/page3d/viewer.js` | the page's spine: fetch, poll, pick and the camera's controls |
| `estate/page3d/world.js` | the solid estate: ground, blocks, fixtures, people, weather and light |
| `estate/page3d/hud.js` | the panels and cards, pure DOM (no THREE), shared with the Node check |
| `../shared/page3d/walk.js` | the router, pure (no THREE), shared with the grove's view and with its check |
| `../shared/page3d/clock.js` | the day's clock and light table, pure (no THREE), shared with the grove's view and the Node check |
| `../shared/page3d/vendor/` | Three.js r170, OrbitControls and the licence, vendored once for both views |
| `tools/hud_check.js` | the HUD's check: the feed, the census, the watcher, the cards and escaping |
| `tools/walk_check.js` | the router's check: doors to fixtures, no crossing, nulls, sample and duration |
| `tools/clock_check.js` | the day clock's check: no jump at the turn or on a poll, the pins, a frozen day |
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

The recipe grew on this branch. `gen.perimeter_path` lays a footpath one
cell in from the ring road, and `gen.perimeter_benches` asks for ten seats
on its outer side, spread evenly around all four sides and facing back
across it; the courtyard's original seven benches keep their places. A
perimeter bench carries the pack's `perimeter_bonus` for rest, company and
quiet — the margin is quieter and greener, and the stroll is worth
something — and a bench now affords a little quiet of its own, so the
existing chooser sends people out to the edge without a new need or a new
subsystem. Over 60 days at seed 42 the perimeter went from no residents to
1.8–6.5 out there at the end of each phase (9.6 outdoors at night, up from
4.5), with 54–389 perimeter-bench visits a phase over the run.

That is a deliberate change to the world, and the gate's fingerprint moved
with it — `dcb219a70d21072f` on main → `ba8cdf35318ba5eb` when the first
benches landed → `0a687daff322d77a` when the perimeter benches landed. Every
law held then, with friction between 1.43 and 1.52 and distinctness
between 8.74 and 8.94. The footpath moves the trees, so the generation is
not a no-op for them; the courtyard's own fixtures stand where they stood.

The row is the branch's other deliberate change. `gen.layout` names the
arrangement, and the estate's is `"row"`: two 12-cell blocks on one
northern line, doors south, with the courtyard and the open ground in
front. Four blocks had put two of them between the south-east views and
the ground behind; a row at the back hides nothing, where a line through
the middle would have hidden half the estate. The row is fewer and
taller — 7–9 floors and 4–5 flats a floor — so seed 42 holds 71 flats
against 67, and 64–85 across the gate's eight seeds against 60–81; its
population after 30 days is 52 against 53, and over the gate's three
years it settles at 123–158 residents and 0.79–0.81 occupancy. The
perimeter path and its benches keep their band, and the courtyard's seven
benches keep their cells at seed 42; the trees (and one perimeter seat)
move because the open ground changed.

The gate's fingerprint moved `0a687daff322d77a` → `010d3b9656ef8a9d`
because this is a deliberate generation change. Every law holds, with
friction between 1.40 and 1.50 and distinctness between 8.88 and 8.94.

The perimeter bonus then moved into the bench's base. It used to be added
after `places.effective()`, so a worn or crowded edge seat kept all of it,
and for quiet it was four times the bench's own 0.18; `_satisfy` restored
only the bare afford, so a resident drawn out by the bonus found almost
none of it on arrival. The bonus now sits inside the base that both the
chooser and the restore use, and it is no larger than the bench's own
afford for each need, so condition and congestion scale it and a full edge
seat is worth no more than an empty courtyard one. A one-third bonus left
the edge unvisited, so the values were tuned to that ceiling rather than
abandoning the change. Over the same 60 days at seed 42 the perimeter now
carries 0.52 / 0.98 / 1.38 / 1.10 / 1.35 residents at the end of dawn /
morning / afternoon / evening / night, 0.28 / 0.72 / 0.95 / 0.73 / 1.13 of
them on a perimeter bench, with 17 / 43 / 57 / 44 / 68 bench visits by
phase and 62 distinct walkers; outdoors at night is 5.6 rather than 9.0.

A bench's capacity also became hard: the congestion term had allowed up to
six residents on a two-seat bench at a phase end (46 of 300 phase ends at
seed 42), which both views could only draw as people on the slats. The
chooser now refuses a full bench, and the views seat only residents whose
chosen fixture is that bench and stand anyone else clearly beside it. No
phase end in the same 60 days puts more than two people on a two-seat
bench.

The gate's fingerprint moved `010d3b9656ef8a9d` → `9a968319c0c5f992`
because this is a deliberate chooser change. Every law holds, with friction
between 1.33 and 1.44 and distinctness between 8.00 and 8.13.

The gate's current fingerprint is `d5ddd81da91d9e58`. The single 3D view
changed the server's routes and the page, not the engine or the simulation,
so the estate's behaviour — and its fingerprint — is unchanged.

Nineteen faults are recorded in `docs/BUGS.md` under Grove's sixteen
classes. Almost none of them crashed anything. They were found by asking
the estate's own design questions and checking the answers — *do the needs
get met*, *is the playground heard*, *does anyone live above the third
floor* — which is the whole of the method this project inherited, and the
reason the ledger is the most useful file in it.

Still deferred, each deliberately: money, traffic beyond noise, a school
timetable, illness, interiors as a grid, A*, the steward, embeddings, the
SVG twin.
