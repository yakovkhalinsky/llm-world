# Grove — bug worklist

Findings from the 2026-10-04 review: a manual sweep of all modules plus a
focused review of the latest commit (`ef3ad5a`). Work through top-down —
the P0s are small diffs against features this week's commits already
claim are working. Tick the box when the fix lands and its check
passes; one fix per commit, message in the grove's voice.

Verification at the bottom. The sim's number-knobs are untouched, so
the balance gate is not implicated — only fix **3** touches the engine,
and it touches a path the gate never runs (operator actions).

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

### b8 · [ ] `soul_gap()` always returns the top of the range

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

### b9 · [ ] `/api/ask` holds the world lock across the embed call

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

- [ ] **b10** `grove/operator.py:143-146` — unreachable tail of
  `known_unnamed` (references a `lines` that doesn't exist there);
  delete it.
- [ ] **b11** `grove/voice.py:41` — a model `null` name becomes
  `str(None)` → `"None"` passes `NAME_RE` → a creature genuinely named
  None. Guard: only treat a string name as a candidate.
- [ ] **b12** `grove/reviewer.py:213` — 2-segment lawful paths
  (`pop.recolonize_after`, `pop.robins_return_prob`) pass `validate`
  (bounds table has them) but `apply_amendment` demands exactly 3
  segments — an accepted proposal silently never applies. Walk
  `parts[:-1]`, refuse `*` anywhere, refuse a non-dict target.
- [ ] **b13** `grove/db.py:186` — the duplicate-rendering check only
  runs at capacity 3, so the same line can occupy two slots and
  round-robin serve twice in a row. Check `dup` before the `have >= 3`
  branch instead of inside it.
- [ ] **b14** `grove/llm.py:212-213` — `self.tok.get("_pin", 0)`: `_pin`
  is never set anywhere; drop the ghost fallback (keep the `or 0`).
- [ ] **b15** `grove/app.py:147,155` — `pending_since` is written,
  never read; delete it or surface the backlog's age on the dashboard.
- [ ] **b16** `grove/sim.py:247-248` — death attribution: with blight
  and drought both running, drought deaths read "blight" (`any(blights)`
  wins). Track which pressure actually hit *this* plant that week
  (the damage loops already know) and attribute from that.

## Known risk — no action yet

- The web indexer thread (`web.py:1241-1249`) writes `db.con` from its
  own thread without the world lock. SQLite serializes access on one
  connection, and batches are small, so the practical risk is low — but
  a commit can land mid-`step()`. If anything odd ever shows in the vec
  table, this is the first suspect.