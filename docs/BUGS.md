# Grove — bug worklist

Findings from the 2026-10-04 review: a manual sweep of all modules plus
a focused review of the latest commit (`ef3ad5a`). **All fixed the same
day** — b1–b16 from the sweep, then b17 (the indexer hazard listed here
as a known risk) and b18 (one model, cloud-first) after it, and
b19–b21 while the biome packs went in (the phases' refactor found two
real bugs of its own). One fix per
commit, messages in the grove's voice; each item was verified by its
own prescribed check before it was committed and pushed. The balance
gate ran clean over the engine-touching fixes (8 worlds × 900 weeks,
every species persisting); of those, b16 touched the plant loop only in
how a death names its cause. Keep this list as the record — new
findings get new numbers below.

---

## P0 — regressions, one-liners

### b1 · [x] the biography ledger is unreachable

**Where** `grove/app.py:149` — a mid-function `return evs, notable` was
inserted by `8f8dffc`; everything below it is dead code, including a
duplicated pending-enqueue block (`app.py:150-156`) and the whole
biographies' ledger (`app.py:158-177`).

**Effect** Since `8f8dffc`, `add_bio` rows are written only for rename
lines. Births, predations, elder events never reach the ledger, so
every creature's and tree's `db.bio()` shows nothing but "was named X".
The `/api/bio` view is nearly empty for everything except named souls.

**Fix** Delete the duplicate block, move the ledger above the return —
the end of `step()` becomes:

```python
        if llm_items and self.worker is not None:
            for it in llm_items:
                self.eid += 1
                it["eid"] = f"e{self.eid}"
                if not self.pending_chron:
                    self.pending_since = w["tick"]
                self.pending_chron[it["eid"]] = it

        # the biographies' ledger: every soul touched by this week's
        # story gets a row pointing at the chronicle's final line
        for e in notable:
            key = evm.event_key(e)
            ids = []
            if e["kind"] == "birth":
                ids += [k for k in (e.get("kids") or [])]
            elif e["kind"] == "predation":
                ids += [v for v in (e.get("victims") or
                                    ([e["victim"]] if e.get("victim")
                                     else []))]
                if e.get("hunter_id"):
                    ids.append(e["hunter_id"])
            elif e.get("who"):
                ids.append(e["who"])
            elif e.get("plant"):
                ids.append(e["plant"])
            for oid in dict.fromkeys(ids):
                self.db.add_bio(int(oid), key, e["tick"])
        return evs, notable
```

**Check** `grove step 5` (or a few web-mode weeks), then
`sqlite3 grove_data/grove.db "SELECT COUNT(*) FROM bio"` grows past the
rename rows; a birthed kid's `/api/bio` shows its birth line.

---

### b2 · [x] the narr-cache never hits — written and read under different keys

**Where** The read is `cache_get(it["narr_key"])` (`grove/app.py:136`).
Both writes still use the per-event key:

- `grove/app.py:318` — `cache_set(res["extra"]["key"], text)`
- `grove/__main__.py:154` — `cache_set(item["key"], text)`

`event_key` embeds `tick`/`x`/`y` (unique per week), `narr_key` is the
story signature (`kind|sp|hunter|cause|n|place`). `8f8dffc` switched
the read to `narr_key` and even added `"narr": item["narr_key"]` to the
flush extra — but not the write. Net: every repeated story pays a fresh
model call, and the cache table grows write-only forever.

**Fix** One word in each write — the extra already carries the right key:

```python
# grove/app.py, _apply_one (kind == "chron")
self.db.cache_set(res["extra"]["narr"], text)
```

```python
# grove/__main__.py, cmd_step
g.db.cache_set(item["narr_key"], text)
```

**One-off cleanup** Rows keyed by event strings are unreachable junk
after the fix (they start with `{`, narr keys start with the kind):

```sh
sqlite3 grove_data/grove.db "DELETE FROM cache WHERE narr LIKE '{%'"
```

**Check** In tier local, narrate into a world where a story repeats
(same kind|sp|cause|n|place, e.g. a regular owl hunt at the pond's
edge). The second occurrence is recorded as `source='llm'` with no
model call (`jobs["chron"]` stays flat while `chron_ok` advances).

---

### b3 · [x] `BASE_RESIDENTS` is undefined — NameError on the migration op

**Where** `grove/sim.py:964` — `_apply_effect` action `"migration"`
checks `if sp in BASE_RESIDENTS:`. Nothing defines it; `_recolonize`
uses `rules.R["pop"]["base_residents"]` (`sim.py:823`).

**Effect** When the World Soul chooses `migration`, `_apply_effect`
raises NameError. Web mode survives via the runner's catch-all ("runner
error" spam, that week's save lost — `pending_effect` is cleared
before the crash so it doesn't loop). CLI `grove step` dies with a
traceback.

**Fix**

```python
if sp in rules.R["pop"]["base_residents"]:
```

Confirmed consistent: `base_residents` (`rules.py:116`) is exactly
rabbit, deer, fox, owl, robin, boar — the menu's migration list.

**Check** Force an op once (steward, or submit a hand-built effect) —
no "runner error" line, and the species appears at the region's edge.

---

## P1 — the voice tier's model machinery (`grove/llm.py`)

### b4 · [x] "one model, moving as one" — the init block is a no-op, and the swap walks the wrong chains

**Where** `grove/llm.py:69-71`. The `setdefault` can never fire: the
`LOCAL_JOBS` loop three lines above already assigned `job_models` and
`job_chains` for `chron` and `voice` (they are keys of `LOCAL_JOBS`).
So in the **local** tier the chronicler stays on `1b` with its
*reversed* chain `[1b, 3b]`, and when `soul` (`3b`) fails twice,
`_swap_job_model` walks the three separate chains and moves the
chronicler **from 1b to the slow 3b** (and voice 3b→1b) — the exact
two-style/slow-prose split `ef3ad5a` set out to remove. In the **cloud**
tier the invariant holds only by accident (both resolve to `chain[0]`).

**Fix** Skip the tied jobs in the resolve loop, then assign
unconditionally. `ef3ad5a`'s own words decide this: chron, voice and
the soul share one resolution, one chain, one swap. This makes
`--tier hybrid` put the chronicle on the soul's cloud chain too — the
`TIER_JOBS` comment ("the local 1B keeps up") describes the *old*
hybrid; keep it only if you decide the chronicle must stay local there,
in which case the tie block and `_swap_job_model` need a chron-carveout
instead (say so in the commit either way).

```python
        self.job_models = {}
        self.job_chains = {}
        for job in LOCAL_JOBS:
            if job in ("chron", "voice", "op"):
                continue          # the soul's voice speaks for these too
            model, chain = self._resolve(job)
            self.job_models[job] = model
            self.job_chains[job] = list(chain)
        # the voice (soul) and the prose speak with ONE model, always:
        # the same resolution and the same chain, advancing together
        for job in ("chron", "voice", "op"):
            self.job_models[job] = self.job_models["soul"]
            self.job_chains[job] = list(self.job_chains["soul"])
```

**Check** `status_line` prints the same model for (soul) and (prose) in
`--tier local`, and a forced soul failure moves all three (or none).

### b5 · [x] `job="op"` is missing from every table — KeyError after two failures

**Where** `grove/llm.py:170` — `payload["model"] = self.job_models[job]`
raises KeyError for `job="op"`: it is in neither `LOCAL_JOBS` nor the
`TIER_JOBS` lists nor the tie block, so it never reaches `job_models`.
Violates the module docstring's "chat_json NEVER raises" (`llm.py:11`);
the SoulWorker catch-all swallows it, the decision is dropped, and
`job_fails["op"]` never resets — every later op repeats the crash.

**Effect** Two bad operator payloads and the soul stops speaking for the
rest of the session. Also: since `op` is unreachable to the tier tables,
the World Soul decision always runs the `1b` default — with
`--tier cloud` too, contradicting "a true all-cloud world".

**Fix** Mostly covered by **b4** (the tie block above binds `op` to the
soul's model and chain). One defensive line remains:

```python
payload["model"] = self.job_models.get(job, model)
```

`_swap_job_model`'s trio becomes `("soul", "chron", "voice", "op")`.

**Check** Feed two malformed operator replies (or point
`host` at a staller) — no traceback; the op falls back and the next
invitation still fires.

### b6 · [x] the swap note lies, and nothing bounds `notes`

**Where** `grove/llm.py:105-106` — `"the grove's voice moved to …"` is
appended even when nothing moved (e.g. only `1b` installed: every chain
filters to the unavailable `3b`, no model ever changes, the note still
claims a move and `status_line` displays it). `notes` is never trimmed.

**Fix**

```python
        before = dict(self.job_models)
        for step_job in ("soul", "chron", "voice", "op"):
            chain = [m for m in self.job_chains.get(step_job, [])
                     if m != self.job_models.get(step_job)]
            if chain and self._available(chain[0]):
                self.job_models[step_job] = chain[0]
        if self.job_models != before:
            self.notes.append("the grove's voice moved to "
                              + self.job_models["soul"])
        self.notes = self.notes[-4:]
        return True
```

---

## P1 — operator, pacing, web

### b7 · [x] `validate` slices a dict — TypeError on an off-menu action

**Where** `grove/operator.py:155-156`:

```python
return _quiet(str(raw.get("intent") or
                  "the soul kept its peace"))[:180]
```

`_quiet` returns a dict; `dict[:180]` is a TypeError. Reachable when the
operator's action escapes the schema (the regex-recovery path in
`chat_json` re-parses raw JSON with no enum). Web mode's
result-handler loop catches it (the op is silently lost,
`handler_errors`++); CLI `grove step --narrate` would crash. The
`[:180]` belonged to the intent string.

**Fix**

```python
    if action not in MENU:
        return _quiet(str(raw.get("intent") or
                          "the soul kept its peace")[:180])
```

**Check** `operator.validate({"action": "earthquake", "intent":
"x" * 300})` returns a quiet effect with a 180-char intent.

### b8 · [x] `soul_gap()` always returns the top of the range

**Where** `grove/llm.py:232` — `return lo + (hi - lo)` is just `hi`, and
the one caller (`grove/app.py:191`) adds no randomness despite the
comment "the caller re-rolls via randomness at use". The gap between
World Soul invitations is a constant 120 s local / 80 s cloud instead of
varying within (60,120) / (40,80) (`rules.py:144-145`).

**Fix** Return the pair; roll at the caller (`random` is already
imported in `app.py`):

```python
    # llm.py
    def soul_gap(self):
        """(lo, hi) wall seconds between World Soul invitations."""
        p = rules.R["pacing"]["soul_gap_local" if not self.is_cloud()
                             else "soul_gap_cloud"]
        return p[0], p[1]
```

```python
    # app.py, maybe_schedule
    lo, hi = self.llm.soul_gap()
    self.next_op_wall = time.time() + random.uniform(lo, hi)
```

### b9 · [x] `/api/ask` holds the world lock across the embed call

**Where** `grove/web.py:1402` — inside `with lock:`, `memory.recall`
calls `embed` → `urlopen(timeout=150)` plus a `200` retry while
`memory.py:32`'s own comment explains embed can legitimately wait that
long behind a busy ollama runner. The SimRunner can't take the lock
meanwhile: the world freezes for the whole ask.

**Fix** Fetch the rows under the lock; embed and rank outside it. Give
`recall` an optional pre-fetched set and use it in the handler:

```python
# memory.py
def recall(db, llm, question, top=5, rows=None):
    if rows is None:
        rows = db.con.execute(
            "SELECT key, tick, text, vec FROM vec").fetchall()
    ...   # rest unchanged
```

```python
# web.py, /api/ask
with lock:
    ...                       # the enabled/no-world guards as now
    rows = g.db.con.execute("SELECT key, tick, text, vec FROM vec"
                            ).fetchall()
    digest_text = operator.digest(g.world, [])
excerpts = memory.recall(g.db, g.llm, q, rows=rows)
```

**Check** Open the dashboard, ask a question, and confirm the map keeps
ticking while the answer is pending (pause a tick's worth of weeks
during a slow embed).

---

## Minors — fold in when convenient

- [x] **b10** `grove/operator.py:143-146` — unreachable tail of
  `known_unnamed` (references a `lines` that doesn't exist there);
  delete it.
- [x] **b11** `grove/voice.py:41` — a model `null` name becomes
  `str(None)` → `"None"` passes `NAME_RE` → a creature genuinely named
  None. Guard: only treat a string name as a candidate.
- [x] **b12** `grove/reviewer.py:213` — 2-segment lawful paths
  (`pop.recolonize_after`, `pop.robins_return_prob`) pass `validate`
  (bounds table has them) but `apply_amendment` demands exactly 3
  segments — an accepted proposal silently never applies. Walk
  `parts[:-1]`, refuse `*` anywhere, refuse a non-dict target.
- [x] **b13** `grove/db.py:186` — the duplicate-rendering check only
  runs at capacity 3, so the same line can occupy two slots and
  round-robin serve twice in a row. Check `dup` before the `have >= 3`
  branch instead of inside it.
- [x] **b14** `grove/llm.py:212-213` — `self.tok.get("_pin", 0)`: `_pin`
  is never set anywhere; drop the ghost fallback (keep the `or 0`).
- [x] **b15** `grove/app.py:147,155` — `pending_since` is written,
  never read; delete it or surface the backlog's age on the dashboard.
- [x] **b16** `grove/sim.py:247-248` — death attribution: with blight
  and drought both running, drought deaths read "blight" (`any(blights)`
  wins). Track which pressure actually hit *this* plant that week
  (the damage loops already know) and attribute from that.

## Fixed after the sweep

- [x] **b17** the web indexer thread writes `db.con` from its own
  thread without the world lock — the same class of hazard sat in the
  ask handler's pre-index call. On one shared connection, a foreign
  commit could seal a week the sim was mid-writing (proven: the sim's
  own discard could not take the sealed rows back). Both embedding
  threads now carry their own sqlite connection: their commits block
  for their turn at the file's write lock and can never land
  mid-`step()`. If anything odd ever shows in the vec table, the
  ollama queue is the suspect now, not sqlite.

- [x] **b18** "one model, moving as one" extended to EVERY job, and the
  default tier made cloud-first. ask and review still resolved on their
  own tables (1b/3b), the "hybrid" tier had died silently, and the
  `--model auto` help's promise ("cloud-first with local fallback")
  never existed in code — the default tier fell through to the local
  tables. Now: one resolution, one chain, all six jobs (soul, chron,
  voice, op, ask, review), in every tier — the default resolves
  glm-5.3-flash:cloud (fd46dc1's choice); `--tier local` pins the
  llama; nothing reachable → the chain slides to llama3.2:3b. A
  flash-compat finding landed with it: with `think:false` the flash
  proxy streams its REASONING into the answer's `content` (no JSON ever
  parses) while with no `think` key the reasoning goes to the hidden
  `thinking` field — so the client drops the key and gives cloud calls
  generous `num_predict` headroom (3000: measured on a real 200-week op
  digest, flash reasons ~2.2k tokens before the JSON; the model stops
  naturally and the ceiling only truncates — the first ~500/1100
  ceilings were passed mid-reasoning by live prompts, and each such
  failure moved the whole voice down the chain in one honest step,
  which is how the swap is meant to behave). The dashboard's llm block
  now exposes the client's `reason` and per-job `fails` so the next
  stumble names itself. The embedder (nomic) is not a language
  model and is untouched.

## Found while refactoring (the biomes' phases)

- [x] **b19** the seed bank's decay truncated: `int(bank * 0.995)` every
  fourth week bleeds ~13–20% of a small bed's mass at every step (4→3,
  3→2…), while the intended rate is 0.5%. The grove's big, heavily
  fed beds hid the bug; the desert's small ones died of it (the
  prickly-pear went extinct in every seed). Fix: the bed keeps its
  **last seed** — `max(1, int(bank * 0.995))`, byte-identical for every
  bank above mass 2, so the grove's tuned equilibrium and gate
  fingerprints hold. A full float-mass bank was tried and *rejected*:
  it shifts the grove's tuned trajectories (one seed lost its foxes) —
  reopening the grove's balance tuning is a deliberate work item of its
  own, not a side-effect; if the bed's arithmetic ever gets retuned,
  run the gate first.
- [x] **b20** the balance gate lied about what it checked: its spans
  covered only 8 of the 13 species (willow, fern and berry never had
  spans), its extinct-plant check hardcoded the grove's five plants,
  and gen's founding table hardcoded six grove species — a desert world
  was seeded with rabbits and crashed. All now read the pack
  (`base_residents`/`plants`/`starting_animals`/`gate.plants_min`); the
  spans now cover every species (the earlier gate prints differ by this
  richer report, not by the censuses).
- [x] **b21** — the known-risk note on `tools/render_svg.py` is closed:
  it carried a third hand-copied copy of the scene's palettes and
  species colours, and would have painted a desert in grove colours.
  Now the twin reads the world's own tables
  (`presentation.seasons_palette`, `presentation.animal_body`) — the
  very same seasons and bodies the page draws with — and today's
  literals remain only as the fallback. Check: under the desert pack
  the twin resolves winter grass to the desert's own `#9c9a88`
  (nothing hand-copied matches it); on the grove the render is
  byte-stable and the ground counts hold.

## Found while reading the worklist itself

- [x] **b22** `tools/render_svg.py:128-140` — the terrain loop drew one
  cell per row: the `if c["terrain"]` block sat *outside* the inner
  `for x` loop, so `x` and `c` lingered on the row's last cell and one
  diamond landed per row. The README scene's ground has been mostly
  empty since the script was born (`b911e08`) — 34 of the world's 576
  cells drawn (17 soil + 17 grass overlays), the pond and all 42 rock
  cells missing; the trees covered the loss well enough that it read as
  correct. Fix: the drawing steps inside the row loop, one diamond per
  cell. Check: render and count — 35 water, 42 rock, 499 soil base
  diamonds, 472 grass overlays, cell for cell against the world.

- [x] **b26** *found by looking at the sky* — the three clouds drifting
  past the dashboard's night were **white rectangles**: the engine's
  capture built the cloud sprites from the stars' 2×2 white texture
  (`engine.js` `engInitSky` reached for `starTex` where it meant the
  240×48 soft cloud it had just captured; `cloudCv` rode unused). Fixed:
  the clouds use their own texture; the harness now asserts the
  sprites' texture *identity* (clouds the cloud capture, stars the
  2px), which the old node-count check could not see through. The first
  bug found by an eye on the real device, not by a harness.

## Found on the page's own ground (the graphics review)

- [x] **b23** `grove/page/scene.js:364-378` — the cactus branch wrote
  its whole body as if translated (`fillRect(-2.5*K, -h*K, …)`) but
  never called `translate`: every saguaro painted offscreen at the
  canvas's top-left corner, all its strokes stacked on one point, since
  the desert's shapes went in. The desert's live world has been showing
  a corner-smeared saguaro instead of a forest of them. Fix:
  `save`/`translate(sx, sy)`/`restore` around the branch. Check:
  `tools/scene_check.js` — a new headless harness that loads the page's
  own three scripts the way web.py serves them, records every stroke
  the canvas receives through a transform-following recorder, walks a
  synthetic world through the scene, and asserts each saguaro's marks
  sit within a tile of its cell with nothing drawn offcanvas. The
  harness failed on the unfixed code first — the saguaro stood at
  (-3.3, -28) against its tile's (190, 172).

- [x] **b24** `grove/page/panels.js:24` — the follow button read a
  bare `bio` global that was never defined as data: `bio.oid` was
  always undefined (in a browser `bio` quietly resolves to the `#bio`
  DOM element — an HTMLElement has no `.oid` — so nothing followed; the
  harness makes the same bug throw plainly). Opening a biography and
  pressing ◎ follow marked the button "on" and followed nothing. Fix:
  `openBio` records the target it was given (`bioTarget`); the button
  reads that. Check: the harness opens a biography and presses follow —
  the cam's target is the soul it was shown (7, animal); no globals
  conjured.

- [x] **b25** the drawn terrain read as inconsistent blocks — the page
  drew the world's raw `elev` field, whose neighbours jump a mean 0.28
  elev units (p95 0.645 — a 7px average, 17px worst-case step between
  adjacent tiles at the grove's 26px relief), so every diamond stood
  like its own block, and 553 wall quads slabbed every noisy step.
  Fix, drawn only — the world's saved data keeps its own noise: three
  diffusion passes over the field before it is drawn (self-weight 3
  of 7, cached per tick in the page, the same recipe in the twin's
  `smooth_elev`), and walls only where the true ledge is (≥4px
  interior steps; at the island's rim the face always falls to the
  plinth). Check: `tools/scene_check.js` asserts the drawn field's
  neighbour jump falls below half the raw's and under 2px; walls stand
  only at true ledges (18 walls on the synthetic land; the real
  render's wall count fell 553 → 93, byte-stable across runs, ground
  counts untouched). Numbers measured: raw mean |Δ| 5.14px drawn
  0.73px on the check's own field.

- [x] **b27** — found within the hour: the fit refactor had left the
  ground-side cloud shadows drifting in **window** units while they
  live inside the world group (placed and scaled): at fit they sweep
  far past the island into the sky's own space. Fixed: their drift and
  seat are the island's own box now (`ENG.sceneBox`). Check: the
  harness reads the first shadow's seat — inside the island's width
  and between a fifth and four fifths of its height, at every frame
  the frozen clock hands out.

- [x] **b28** the terrain tiles rendered torn — with per-cell elevation
  drawn, two neighbouring tiles at different heights share an edge no
  more (each diamond sits at its own height), and the wall quads that
  should cover the step only drew at ≥4px interior drops: **814 of the
  world's 1104 neighbour steps sat between the thresholds — open
  hairline gaps** from the raised tile's edge straight to the backdrop.
  The walls are geometry, not decoration: a step's face exists whenever
  the ground drops, so interior walls now draw at >0.5px (the gentled
  field's steps are 0.5–5px — contour lines, not the old noise slabs);
  the rim keeps its ≥1px. The twin matched the wrong branch first trip
  (interior left at 4 while the rim changed — 528 faces on the real
  render caught it: ~480 drops closed + rims). Check: the harness
  counts the gentled field's drops and asserts one face for each —
  "the walls close every step the ground makes" — plus the twin's
  byte-stable render and the ground counts across seasons.

## The 2026-10-07 sweep — the World Soul's own ground

The gate runs the pure engine with no LLM, so it can never reach the
fates. Everything below lives on the path the gate cannot walk.

- [x] **b29** the fates' region helper crashes: **every drought**, and
  **any off-region blight**. `_region_set` (`grove/engine/util.py:29`)
  called `W.region_cells` while the module imported only `rules`, so a
  named region raised `NameError: name 'W' is not defined`; for `"all"`
  it returned `None`, which `grove/engine/weather.py:66,72` then used
  directly — `(x, y) in None` → `TypeError`. The Soul's two lasting
  fates were therefore dead on arrival: `drought` at any region killed
  the tick (web mode swallowed it as "runner error" and lost the week
  mid-write; `grove step --narrate` died outright), and `blight` died on
  NW/NE/SW/SE — its own schema enum — leaving only `blight` over `all`
  alive, because `plants.py` is the one caller that already guarded the
  `None`. Measured before the fix: `drought/all` → TypeError,
  `drought/NW` → NameError, `blight/SW` → NameError; `storm`, `bloom`
  and `blight/all` were clean. Fix: `util.py` imports the world and
  documents `None` = everywhere; `weather.py` resolves each drought's
  footprint **once per week** rather than once per cell (it rebuilt a
  576-cell set inside the cell loop) and tests `region is None or
  (x, y) in region` — the guard `plants.py` already used. The `blights`
  list `_update_cells` built and never read goes with it. Check: every
  fate on every region ticks clean, and a strength-3 `drought` over NW
  drops that quadrant's mean moisture 0.74 → 0.31 while SE moves only
  with the weather; the gate is unmoved — 8 worlds × 900 weeks, all
  species persisting, the per-seed census lines byte-identical.

- [x] **b30** the fates never ended. `_apply_effect` wrote `ticks` for
  `drought` and `blight` (`grove/engine/effects.py:35,38`) and nothing
  ever decremented or pruned it: a blight cast in week 1 still read
  "6 more weeks" in week 31 and still burned 1.2 hp/week off every
  plant it named, forever — the World Soul's *lasting* fates were
  permanent ones. Fix: `_age_effects` burns a week off every live
  effect and spends it at zero, called from `tick()` **before** the
  new fate lands so a fate always gets the full span its strength
  bought. Check: a strength-1 blight (6 ticks) is gone from
  `world["effects"]` at week 7 and the digest stops announcing it;
  a strength-3 drought holds exactly 9 weeks.

- [x] **b31** the fates and the chronicle still spoke the grove's
  species. Four hardcoded species lists survived the packs:
  `operator.validate` coerced any `migration` species outside
  rabbit/deer/fox/owl/robin/boar to `"robin"` — a species the desert
  does not have, so the fate was demoted to `quiet` and **the desert's
  migrations never happened at all**; `effects.py` defaulted `migration`
  to `"robin"` and `visitor` to `"stag"`, and gated a visitor on
  `sp in ("stag", "wolf")`, demoting a `bighorn`; and `events.notable`
  dropped every `fell` whose species was not pine/birch/willow, so **no
  desert tree ever fell in the chronicle**. All four now read the pack
  (`pop.base_residents`, `pop.migration_default`, `pop.visitor_default`,
  `pop.visitor_species`, and the plant table's own `kind == "tree"`).
  Byte-identical on the grove — `migration_default` is `robin`,
  `visitor_default` is `stag`, and the grove's three tree species are
  exactly the ones the old list named. Check: the desert validates
  `sandgrouse`/`bighorn` and keeps them, a migration genuinely lands
  once the flock has room, `saguaro` and `palo-verde` falls are news
  while `sagebrush` is not, and a junk migration species still falls
  back to `robin` on the grove.

- [x] **b32** the word-map printed words. When the packs went in, the
  grove's plant table was given `emoji` values copied from its *shape*
  list — `'pine'`, `'leaf'`, `'fern'`, `'berry'` — and `render._tile`
  reads that field straight (`grove/render.py:34`), so the terminal's
  map, `grove map` and the `?plain` fallback page have been spelling
  those four words across the grove's tiles instead of drawing it. The
  desert was never wrong: its pack holds real emoji. The grove's now
  does too (🌲 🌳 🌿 🍀) — so a mature fern reads as a fern rather than
  as the generic 🌳 it fell back to before the packs, which is the one
  visible change. The same pass took the tile's other hardcodings to
  the pack: flying is now `animals.*.flyer` rather than the literal
  `owl`/`robin` (a desert's shrike and sandgrouse float over the canopy
  as they should), a fruiting bush shows 🫐 — the branch that would
  have drawn it was unreachable, every mature plant returning at the
  canopy loop first — and the dead `berry`/`fern` limbs under it are
  gone. Check: both biomes render glyph for glyph, a fruiting berry
  reads 🫐 and a bare one 🍀, a log 🪵, a robin over a canopy 🐦, a
  desert shrike over a saguaro 🐦 too; and the gate is unmoved (the
  engine never reads `plants.*.emoji`).

- [x] **b33** the guests drew as wolves, the follow-cam followed
  nothing, and two panels kept promises they never made.
  - `scene.js:159` declared `A_SHAPES` (`guests' shapes, by species`)
    and `engine.js:239` read it — but `boot.js:40` pushed the pack's
    map into `SHAPES`, so `A_SHAPES[a.sp]` was always `undefined` and
    every desert animal fell through `animalBody`'s switch to the wolf
    default, and found no `POSE_CHAN` entry, so it stood frozen. There
    was never a reason for two maps: the halves don't collide, so
    `shapeOf()` reads the one the pack fills.
  - The same `a.sp === "owl" || a.sp === "robin"` decided flying and
    `a.sp === "rabbit"` the hop, in two files — the desert's birds
    never took off and its jackrabbit never hopped. Both now ask the
    shape being drawn, which is where the page keeps the wings.
  - `trackFollow` (`panels.js:36`) was never called from anywhere: the
    `◎ follow` button toggled a class and moved nothing. It also
    dropped the fit transform (`iso()` is world-local, the scroller
    counts canvas pixels at `PX + u*FIT`) behind a `VIEW.dw / CW` that
    is 1 by construction, and filtered plants on `q.log`, a field the
    snapshot never sends (plants carry `st`). Now called from the
    frame loop, with the transform and the filter right.
  - `#chron`'s tab handler never hid `#tune`, so switching back from
    ⚖ tuning stacked both panes and left the tab lit; and `body.plain
    .bio` matched nothing — the card is `#bio` — so a no-GPU page kept
    its `position: fixed`. The `n` key also fired the soul button
    while unpaused, where the `s` key and the button itself check
    `disabled`.
  Check: `tools/pixi_check.js` ALL PASS (36410 draw calls over 30
  frames, the rabbit still squashes on landing, the bake and the walls
  unmoved) and the real page over a throwaway world passes
  `tools/page_harness.js`.

## The same sweep — the knobs that were not connected

Found by asking the ruleset which of its own numbers nothing reads. All
four are the same fault: a setting that exists, is settable, and does
nothing — so anyone tuning through `--rules` (or writing a world's own
constitution) changes a value the engine never consults.

- [x] **b34** the sky's law was written twice. `cells.winter_grass_decay`,
  `cells.wet_streak_soak`, `cells.mushroom_base_prob` and
  `cells.mushroom_humus_mult` sit in the ruleset and merge from any JSON
  override, while `weather.py` ran its own copies of the same four
  numbers (`0.93`, `0.4`, `0.08`, `2.5`). `pacing.chron_max_per_tick` had
  a twin too — the module constant `MAX_PER_TICK` in `events.py`. The
  engine reads the ruleset for all five now. The arithmetic is
  untouched at the default values, so the gate's census is unmoved.
  Check: frost shaves the grove's grass to 179 with
  `winter_grass_decay: 0.5` against 339 at 0.93; `mushroom_base_prob: 0`
  grows no mushrooms at all against 63; a three-event week yields three
  lines with `chron_max_per_tick: 3`.

- [x] **b35** the generator ignored its own recipe. `gen.noise_octaves`
  and `gen.coarse_grid` rode in both packs while `gen.py` used the
  module constants `_OCTAVES`/`_COARSE`; `gen.founder_names` and
  `gen.founder_prob` were bare literals in the founding loop;
  `gen.fern_scorch_light` was a leftover the fern's own per-species
  `scorch_light` had already superseded (it is gone from both packs);
  and a dead `lo, hi = 8.4, 9.0` local sat unread above the terrain
  loop. All now read the pack. Check: `noise_octaves` 3 → 2 and
  `coarse_grid` 6 → 9 each move the terrain and the plant count;
  `founder_names` 6 → 1 leaves one founder; the packs' defaults
  reproduce seed 42's world exactly (286 plants, 60 animals, 6
  founders).

- [x] **b36** the gate would not read its own law, and the pack's
  chronicler brief was dead. `tools/balance.py` defaulted to **10**
  seeds while `gate.seeds` said 8 and `TUNING.md` tells you to run
  `--seeds 8`; `gate.weeks` and `gate.species_all_present` were never
  consulted at all; and `--biome` folded its pack in *after* argparse
  had already read the defaults, so the law could not have applied
  either way. The pack is folded first now and unset arguments take its
  law (`--seeds`/`--weeks` default to `None` and fill in afterwards).
  Separately, `presentation.chronicler_system` — a complete verbatim
  brief in both packs, which `ARCHITECTURE.md` promises — was never
  read: `chronicler.system()` rebuilt its own body from
  `chronicler_role`. The pack's brief wins; the shared body stays as the
  fallback for a pack that carries none. The grove's two texts are
  character-for-character the same, so its prompt is unchanged.
  Check: `balance.py` with no arguments reports 8 worlds; a pack may
  waive the roster law with `species_all_present: false`; the desert's
  chronicler brief and the grove's each come back from their own pack,
  and a pack stripped of one still gets the shared body.
