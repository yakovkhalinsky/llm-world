# Grove — a self-contained forest, operated by a small local LLM

A living forest biome that runs entirely on your machine: ponds, pines,
willows, berry glades, grass, mushrooms — and rabbits, deer, foxes, owls,
robins and boars living, hunting, starving and being born through the
seasons. A small local language model is the **World Soul**: every few
weeks it decides which fate befalls the woods (a storm, a drought, a
blight, a bloom, a passing wolf...), its words become the chronicle, and
it names the newborns.

No cloud. No API keys. State lives in one SQLite file. Zero pip
dependencies — the engine is pure Python stdlib, the model runs in Ollama.

```
WEEK 41 · SPRING · 🌧 rain   🐇38 🦌16 🦊9 🦉4 🐦22 🐗6
🌲 🌲 🌱 🟫 🌲 🟨 🌲 🌱 🌳 🌳 ... [24×24 emoji map] ...
 ☾ SOUL ▸ storm NW — "A cold wind is gathering over the western pines."
   ▸ A fox took a wild rabbit at the pond's edge.  (1wk ago)
   ▸ 2 boar slipped in from beyond the forest edge.  (5wk ago)
```

## Requirements

- Python 3.11+ (stdlib only)
- [Ollama](https://ollama.com) running locally

## Quick start

```sh
./grove.sh new --seed 42        # plant a grove (deterministic, no LLM)
./grove.sh run                  # watch it live (LLM in the background)
```

Keys in watch mode: `space` pause · `s` step · `n` invite the soul now ·
`q` quit. Nothing is ever lost — every week is saved to SQLite.

```sh
./grove.sh step 200 --offline   # simulate 8+ years headless, fast
./grove.sh map                  # render the current map
./grove.sh status               # population history with sparklines
./grove.sh chronicle --all      # the whole chronicle (☾ = LLM-written)
```

`grove.sh` is just `python3 -m grove`; run it from the repo root instead
if you prefer.

## The model

Small-model reality: on a ~2 GHz 4-core CPU there is no GPU and inference
is CPU-bound. Measured here: **~1.9 tok/s generation on Llama-3.2-3B**,
~3–6 × that on the 1B. So the defaults are tuned for it:

- `llama3.2:1b` is the default soul (**~25–60 s per intervention**)
- `--model llama3.2:3b` gives richer prose but ~2–3 min per decision
- the world never waits on the model: the sim ticks happily while the
  soul ponders, and results land at the next week boundary

`grove run --offline` (or a missing/unreachable model) gives the same
world with deterministic template prose instead of LLM prose.

## How it stays robust (the one design rule)

> The simulation engine owns ALL state. The LLM never holds the world in
> context and never writes world state. It gets small, bounded jobs with
> schema-validated outputs and deterministic fallbacks.

- **World Soul** — every ~6–12 weeks (of world time): a ≤ 400-token digest
  → one JSON decision from an enumerated menu (`storm, drought, blight,
  bloom, migration, visitor, quiet`), applied by validated, deterministic
  rules. Nonsense in → `quiet` out. Ollama down → `quiet`.
- **Chronicler** — notable events are described by template lines the
  instant they happen; a background call rewrites them when the model is
  ready (☾). Every line is cached by event signature, so replays and
  `--offline` runs cost nothing.
- **Voice** — newborns and elder trees get names (one-word JSON, charset
  validated, list fallback), sometimes with a one-line diary.

The engine (`grove/sim.py`) is fully deterministic per seed: same seed +
same actions ⇒ same world. Tuning constants sit at the top of that file.

## Layout

| path | role |
|---|---|
| `grove/world.py` | state containers, species tables, helpers |
| `grove/gen.py` | seeded worldgen (no LLM) |
| `grove/sim.py` | the tick engine + validated operator effects |
| `grove/events.py` | which events are chronicle-worthy |
| `grove/operator.py` | World Soul: digest, menu schema, validation |
| `grove/chronicler.py` | narration prompts + template fallbacks |
| `grove/voice.py` | naming |
| `grove/llm.py` | Ollama client (JSON-schema chats, never raises) |
| `grove/render.py` | the emoji map + header + chronicle feed |
| `grove/db.py` | SQLite: world snapshot, stats, events, chronicle, cache |
| `grove/__main__.py` | CLI + run loop + background worker |

## Ideas on the shelf

- `grove/web.py`: single-file local dashboard (map + chronicle + stats)
- playable character mode (walk in and talk to the animals)
- seasons' effect on names ("the winter fox"), wolf packs, bear dens
- nomic-embed memory: "ask the grove what happened last spring"