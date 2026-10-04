# Grove — architecture

> The one design rule: **the simulation engine owns all state; the LLM
> only bends it.** Every model output is schema-validated with a
> deterministic fallback, so the world cannot break when a 1–3B model
> writes nonsense, times out, or is simply unplugged.

## The world in one sentence

A 24×24 (configurable) grid of diamonds. One tick = one week. Cells hold
terrain (soil/water/rock), moisture, grass, humus, mushrooms, carrion and
a canopy of individually-tracked plants; animals exist as individuals
with species, age, hunger, energy and (sometimes) names. Weather is
persistence-seeded; a year is 48 weeks across four seasons. Everything is
deterministic: `gen.generate(seed)` + the same ticks = the same world.

## Tick order (grove/sim.py)

1. The week increments; season turns reset name budgets and trigger the
   **robin migration** (they leave at the frost, return in spring).
2. The **queued operator effect** lands (the soul speaks at tick
   boundaries; its decision is validated then applied deterministically).
3. Weather: a seeded roll with persistence (rain sticks, storms are
   operator-invited or autumnal rarities); winter is frost.
4. Cells: rain/decay on moisture, grass regrowth (season × moisture ×
   light × drought), **wet-streak soak**, mushroom blooms (favored on
   humus, after rain), carcass decay.
5. Light: rebuilt from the canopy (each tree shades its cell and
   neighbors in two strengths).
6. Plants: aging and stage transitions (seed→sapling→mature→old→log),
   weather wounds (frost stuns understory, storms fell trees by
   strength, blight/drought effects burn), berries fruiting in spring,
   **seed rain** (failed landings go to the **seed bank**) and fern
   spread (spore failures bank too), death → log → **humus**.
7. **Understory pockets**: trees cap at one per cell; ferns and bushes
   live UNDER them (one pocket per cell), including germination.
8. Animals: hunger drain (heavier in winter), forage (grass, berries,
   mushrooms, carrion), hunt (predation scales with prey density; the
   density-dependent loop keeps boom-bust from collapsing), flee
   behavior for rabbits, litters with kid-ids recorded, old age,
   transient visitors departing.
9. **Destiny checks**: the soul's watches resolve on water-adjacency or
   age, or end when the watched creature dies.
10. **Seed-bank germination** (autumn): when a species is nearly gone,
   the bank — soil memory, never consumed — sprouts it into genuinely
   suitable spots (light, water, crowding aware). The forest can never
   lose a species forever.
11. **Recolonization** (animals): a species absent 16+ weeks returns as
   a small group from beyond the edge.

## Persistence (grove/db.py)

One SQLite file (`grove_data/grove.db`):

| table | role |
|---|---|
| `world` | the whole world state as one JSON blob (row 1) |
| `stats` | per-week census (animals + plants) — the sparklines' source |
| `chron` | chronicle rows: `raw` event dumps + rendered lines (`template`/`llm`/`soul`/`voice`) keyed by event signature |
| `bio` | biography ledger: (entity id, week) → chronicle key |
| `vec` | chronicle embeddings (nomic-embed-text) for ask-the-grove |
| `cache` | narration cache by event signature |

Resets archive the old file (`archive-<date>-wk<N>.db`) instead of
deleting it: chronicles and biographies outlive their worlds.

## The LLM's three-and-a-half jobs

| job | cadence | model (local tier) | contract | fallback |
|---|---|---|---|---|
| **operator** (World Soul) | every 60–120 s wall | llama-3.2-3b | one JSON fate from menu (storm/drought/blight/bloom/migration/visitor/**destiny**/quiet) + bounded params | `quiet` |
| **chronicle** | when 2+ events backlogged | the soul's model, always | flat `{"text": …}` ≤ 88 chars | template |
| **voice** (naming + diaries) | ~1/week, ≤8/season | the soul's model, always | `{"name": …, "diary": …}` | name list |
| **ask** (memory-keeper) | on demand | llama-3.2-1b | `{"answer": …}` from retrieved excerpts | apology line |

Model calls: Ollama `/api/chat`, **streaming with a hard wall-clock
deadline** (non-streaming calls hang forever when the queue wedges),
`think: false` (reasoning models must not spend the budget thinking),
`format` = the JSON schema (grammar-constrained), `keep_alive` keeps both
local models resident. The soul's voice — operator, chronicle, naming —
shares ONE model-resolution and ONE chain, and a repeat-failure swap
moves it as one (ask and review keep their own chains). `--tier cloud`
runs the same contracts on a cloud model with automatic local fallback.

Acceptance filters (chronicle): subject anchors from the base line + a
hallucination guard (the line must mention the event's actual subject),
a `slot-dump` rejection (the model restating data as prose), an echo
guard (no duplicating or heavily over-lapping recent lines), and a
minimum word count. Rejected → the template line stands.

## Threading model (grove/app.py, grove/web.py)

The world is touched by exactly one runner (the CLI loop, or the web
dashboard's `SimRunner`) guarded by a world lock; LLM calls happen in a
background worker and return results that the runner applies at tick
boundaries. The ask endpoint runs its model call **outside** the lock
(the forest keeps ticking while the grove ponders). The runner wraps
every beat so no single exception can stop the world.

## Determinism

All randomness derives from `(seed, tick, salt)` strings, stable across
processes. `tools/balance.py` exploits it: many seeded worlds × years,
all species must persist, or the gate fails.