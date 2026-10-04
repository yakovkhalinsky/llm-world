# Grove — tuning guide

The world is a set of honest numbers, gated. This is how to change it
without quietly killing the forest.

## The gate first, always

```sh
python3 tools/balance.py --seeds 8 --weeks 900
```

This runs 8 seeded worlds for ~19 simulated years each (pure engine, no
LLM, ~4 min on the grove's own CPU) and fails loudly if any species goes
extinct, the canopy shrinks under 120 plants, or a species is absent at
the end. `--seeds N --weeks W` for quicker loops; robins are exempt only
if the run ends in winter (they are legitimately south).

The workflow for any balance change: **edit → gate → look at the spans
(the peak per species) → iterate.** A world that passes with one
species pinned at its cap is fine; a world where the cap never binds is
usually a world where the cap is wrong.

## The species tables (grove/world.py)

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

Animals:

| knob | meaning |
|---|---|
| `hunger_drain` | weekly hunger; over 9 they starve toward death |
| `speed` / `scan` / `winterslow` | movement per week, forage/hunt search radius, winter sluggishness |
| `hunt` / `hunt_prob` (+ density scaling) | the predator-prey loop: hunting efficiency scales with prey density (`sim.py` divides by ~the warren's normal size) |
| `lit_size` / `lit_prob` / `breed_seasons` / `energy_breed` | reproduction: litter size/chance, the seasons it may breed, the energy to breed |
| `cap` | soft population ceiling: no breeding above it |
| `lifespan` | death by old age |

## The world's tempo

- `--tick-seconds` (CLI): wall seconds per week. ~12 s is observably
  human (a season ≈ 2.5 min, a year ≈ 10); creatures cover ~45% of a
  week's span in motion, then browse and rest.
- `LLM.soul_gap()` (grove/llm.py): the wall-seconds band between soul
  invitations, by tier — the local soul speaks every 60–120 s rolled,
  the cloud's every 40–80.
- `maybe_schedule` (grove/app.py): the chronicle flushes when ≥ N events
  backlog (2 locally); the naming budget is 1/week, ≤ 8/season.

## What the small models can and cannot carry

Measured on this machine (4 weak CPU cores, no GPU):

- llama-3.2-3b: best judgment and names; ~20–60 s per warm call. The
  soul and the voice.
- llama-3.2-1b: best throughput; ~5–8 s per line. The memory-keeper
  (ask), and the voice's fallback seat when 3b fails twice.
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
| a canopy closing over the understory | `seed_prob` of trees (the world self-thins at the crowding cap), or the cap in `_trees_in_cell` |
| a species extinct forever | check the seed bank's deposits (`_seed`'s failure path banks) and the germination's spots |
| too many creatures | the `cap` of their table |
| the chronicle too busy | `MAX_PER_TICK` in `events.py` + `notable`'s fold rules |