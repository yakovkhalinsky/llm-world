# Grove — tuning guide

The world is a set of honest numbers, gated. This is how to change it
without quietly killing the forest.

## The gate first, always

```sh
python3 tools/balance.py --seeds 8 --weeks 900
```

This runs 8 seeded worlds for ~19 simulated years each (pure engine, no
LLM, ≈90 s on the grove's own CPU) and fails loudly if any species goes
extinct, the canopy shrinks under 120 plants, or a species is absent at
the end. `--seeds N --weeks W` for quicker loops; robins are exempt only
if the run ends in winter (they are legitimately south).

The workflow for any balance change: **edit → gate → look at the spans
(the peak per species) → iterate.** A world that passes with one
species pinned at its cap is fine; a world where the cap never binds is
usually a world where the cap is wrong.

## The species tables (the biome packs, grove/biomes/)

A pack is a world's whole nature. `grove/biomes/grove.py` and
`grove/biomes/desert.py` carry: the species tables, the planting recipe
(`gen`), the pop keys (residents, water-seekers, visitors), weather and
cell overrides, the gate's law (`plants_min`), and the presentation
(words, colours, emoji, shapes, names, the briefs). `grove new --biome
desert` grows a world from another pack; `tools/balance.py --biome
desert` gates it by its own law. The engine reads `rules.R`, which a
pack folds into — whole sections replace, partial merge.

Plants:

| knob | meaning |
|---|---|
| `mature_age` / `old_age` / `max_age` | weeks to reach each stage; death at `max_age` |
| `seed_season` | which seasons seed (a number, tuple (0, 2), etc.) |
| `seed_prob` / `seed_radius` | weekly seed chance per mature plant, and how far the seed may travel from the parent |
| `light_need` | light threshold — trees need MORE light than this; ferns need LESS (understory) |
| `shade_self` / `shade_adjacent` | how much light the canopy removes, own cell vs the ring |
| `storm_fall_mature` / `storm_fall_old` | weekly fall chance in a storm, by stage |
| `frost_hp` | weekly frost wound; the cold stuns understory (a floor of 1 hp) but kills slowly |
| `near_water` (willow) | a seedling must land within N cells of water |
| `spread_prob` / `spread_radius` (fern) | the spore spread: weekly chance and distance; failed spores bank too |

Animals:

| knob | meaning |
|---|---|
| `hunger_drain` | weekly hunger; over 9 they starve toward death |
| `speed` / `scan` / `winterslow` | movement per week, forage/hunt search radius, winter sluggishness |
| `hunt` / `hunt_prob` (+ `hunt_prob_min`, `hunting_density_scale`) | the predator-prey loop: hunting efficiency scales with prey density (`sim.py` divides by ~the warren's normal size) |
| `strike` / `strike_prob` / `strike_range` (owl) | owls hunt by ambush, not pursuit — the strike loop instead of the chase |
| `lit_size` / `lit_prob` / `breed_seasons` / `energy_breed` | reproduction: litter size/chance, the seasons it may breed, the energy to breed |
| `cap` | soft population ceiling: no breeding above it |
| `lifespan` | death by old age |
| `diet` | which feeding law runs: `graze` (flee + grass), `browse` (saplings too), `glean` (fruit, then mushrooms, a light graze), `scavenge` (mushrooms, carrion, a heavier graze) — with each law's numbers beside it (`flee_*`, `browse_*`, `graze_at`/`graze_take`/`seek_at`, `sucker_prob`, `fruit_*`) |
| `migration` | `{"leave_at", "return_at"}` — a species that leaves with the cold and returns; the return's law lives in `pop.robins_return_*` |

## The world's tempo

- `--tick-seconds` (CLI): wall seconds per week. ~12 s is observably
  human (a season ≈ 2.5 min, a year ≈ 10); creatures cover ~45% of a
  week's span in motion, then browse and rest.
- `LLM.soul_gap()` (grove/llm.py): the wall-seconds band between soul
  invitations, by tier — the local soul speaks every 60–120 s rolled,
  the cloud's every 40–80.
- `pacing.reprobe_seconds` (default 900): how long the grove stays on a
  fallback voice before trying the model it was **asked** for again.
  The chain steps down after two failed calls and used to be a ratchet —
  `_resolve` runs once, at construction — so a single bad pair demoted
  every job until the process was restarted. The chosen voice is retried
  on this cadence and steps back down if it is still unwell. `--model`
  pins a chain of one, which can never slide.
- `maybe_schedule` (grove/app.py): the chronicle flushes when ≥ 4 events
  backlog (and the flush takes its slot on a three-week rotation); the
  naming budget is 3/week, ≤ 14/season.

## What the small models can and cannot carry

Measured on this machine (4 weak CPU cores, no GPU):

- glm-5.3-flash:cloud: the grove's default voice, through Ollama's own
  proxy — ~1–3 s per chronicle line, ~3–8 s per soul decision; it
  reasons deeply (the bullet below) before every answer.
- llama-3.2-3b: best judgment and names on-box; ~20–60 s per warm call.
  The one voice of `--tier local`.
- llama-3.2-1b: best throughput; ~5–8 s per line. Now only the chain's
  deepest seat — the ask rides the one voice like every job.
- qwen3 (all sizes): no speed win here; dropped.
- Reasoning clouds (the flash class): their thinking runs in a hidden
  `thinking` channel — send NO `think` key (with `think:false` the proxy
  streams the reasoning into the answer's own field) and give
  `num_predict` ~3000 of headroom (measured: a live 200-week op digest
  reasons ~2.2k tokens before the JSON); the answer stops naturally.
- Structured outputs (`format` = the schema) make valid JSON ~certain;
  the acceptance filters catch the *content* failures instead.
- One flat `{"text": …}` per call beats arrays: small models truncate
  multi-event arrays mid-string.

## The emergency levers

| symptom | lever |
|---|---|
| a species oscillating to extinction | the predation's density divisor in `_behave` (halve it for gentler pressure) |
| a canopy closing over the understory | `seed_prob` of trees (the world self-thins at the crowding cap), or the crowding caps enforced where `_trees_in_cell` is checked (`sim.py`'s plant loop) |
| a species extinct forever | check the seed bank's deposits (`_seed`'s failure path banks) and the germination's spots |
| too many creatures | the `cap` of their table |
| the chronicle too busy | `MAX_PER_TICK` in `events.py` + `notable`'s fold rules |