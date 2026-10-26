# estate-web: Highfield in the browser

A TypeScript port of [`apps/estate`](../estate) that runs entirely in the
browser. There's no server and no model: the simulation runs in a Web
Worker, and the result is a static build.

**Status: phase 1 of 4.** Only world generation is ported so far. The page
plants an estate from a seed and draws its plan.

| phase | what lands |
|---|---|
| 1 (this) | scaffold, Python's `random` in TS, world generation, and the parity harness |
| 2 | the day: tick, residents' `decide()`, families, the households' slow layer, the watcher's fate picking, and the gate fingerprint |
| 3 | the front end: page3d wired to the worker, seeded templates and event-sifting in place of the model's lines, and saves in IndexedDB |
| 4 | the README, screenshots and a static build for GitHub Pages |

## The bar: same seed, same estate

The port has to produce the same estate as the Python engine from the same
seed. It is not enough for it to be similar.

```sh
npm install
npm test          # the shims against CPython, rules.json freshness, and gen parity
npm run parity    # Python vs TS world hashes, seeds 1-8, 42 and 3771
```

Run `npm test` and `npm run parity` from this folder, with `python3` (3.12
or later) on your PATH. They call [`../estate/tools/parity.py`](../estate/tools/parity.py),
a read-only hook that plants worlds in memory and prints:

- each world's canonical hash; and
- CPython's reference values for the shims.

If two worlds differ, the harness reports the first JSON path where they
diverge.

**The canonical form.** Keys are sorted and there are no spaces. Tuples
become lists. Any integral number below 1e16 is written as an integer, and
every other number is written as Python's `repr`. The TS twin is
[`src/py/canon.ts`](src/py/canon.ts), and the hash is sha256 cut to 16 hex
characters.

**What can't match, and why it doesn't matter.**

- **Python's int/float distinction.** JS has only one number type, so the
  hash doesn't see this difference. Every value still agrees, and no engine
  code reads the type. The one place the type shows is `json.dumps` in the
  gate fingerprint, where phase 2 marks which fields are floats.
- **`sum()` before Python 3.12.** Python 3.12 made `sum()` of floats
  Neumaier-compensated. The port does the same, so the Python side of the
  test needs 3.12 or later. The engine itself still runs on 3.11.

## The Python shims (`src/py`)

| Python | TS |
|---|---|
| `random.Random(str)`: sha512 seeding, MT19937, `random`, `getrandbits`, `randrange`, `randint`, `choice`, `shuffle` | `PyRandom` |
| `round(x)` (banker's) and `round(x, n)` (rounded on the exact binary value, ties to even) | `pyRound` |
| `//`, `%` and `divmod` (the divisor's sign) | `floordiv`, `mod`, `divmod` |
| `sum` (compensated) | `pySum` |
| `repr(float)` | `floatRepr` |
| `max`/`min` with `key=` (the first of any ties wins) | `maxBy`, `minBy` |

The rules come from `src/sim/rules.json`, which `npm run rules` exports from
the Python engine's `rules.R`. A test fails if the JSON drifts from what
the engine reads.

```sh
npm run dev       # the page, on Vite's dev server
npm run build     # typecheck, then a static build in dist/
```
