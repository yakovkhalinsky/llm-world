# llm-world

Small worlds that run on a small language model. Each is self-contained,
deterministic per seed, and cannot be broken by the model: the simulation
owns every fact, and the LLM is a voice let into it.

## The one design rule

> The simulation owns all state; the LLM only bends it. Every model output
> is schema-validated with a deterministic fallback, so the world cannot
> break when the model writes nonsense, times out, or is unplugged.

No API keys. No pip dependencies in the engines — pure Python stdlib, with
the model reached through your own Ollama.

## The worlds

| app | the world |
|---|---|
| [`apps/grove`](apps/grove) | **Grove** — a forest biome: ponds and pines, rabbits and foxes, seasons, succession, and a World Soul that decides its fates. Runs live in the terminal or as a full-screen isometric dashboard. |
| [`apps/estate`](apps/estate) | **Highfield** — a housing estate: four blocks around a courtyard, a shop, a playground, benches and trees, and the people who live among them. A watcher with no stake sends the weather and the small fates. |

Each app is a whole world: its engine, its tools, its docs, its launcher
and its data. They share a box, an Ollama and a design — not a line of
code. `core/` arrives when there is a third thing to share and not before.

## Running them

```sh
cd apps/grove  && ./grove.sh new --seed 42 && ./grove.sh run
cd apps/estate && ./estate.sh new --seed 42 && ./estate.sh step 100
```

Each app's own README has the detail; each has its own `--data` directory,
its own `tools/`, and its own gate.

## What the two share

Not code — **lessons**. Grove was built first and kept a worklist of 52
bugs, which distil into sixteen ways this design rule goes wrong: a field
nothing reads, one fact kept in two places, a validator that disagrees with
what it is fed, a failure swallowed silently, a threshold with no good
value. Estate was built under those sixteen as written constraints, and
carries the same table in its README.

Two ideas are common to both, and worth stating here because they are what
the worlds are *for*, not how they are made:

- **A world with nothing left to want is a dead world.** Grove keeps its
  ecology off equilibrium with density-dependent predation and a seed bank
  that never empties; the estate keeps a plaza busy and a bench worn by
  making a place afford less the fuller it is, and by making quiet a
  commons that a lively estate can never fully satisfy.
- **The record is the point.** Both keep a `docs/BUGS.md` as the log of
  what went wrong and why, with the fixes that failed written down beside
  the ones that worked.

## Layout

| path | role |
|---|---|
| `apps/grove/` | the forest: package, tools, docs, launcher, its data |
| `apps/estate/` | the estate: the same shape |
| `core/` | shared services, when something is genuinely shared |
| `LICENSE` | one licence for the lot |
