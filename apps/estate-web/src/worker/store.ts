/**
 * Saves, in the browser's IndexedDB: database "highfield", one record per
 * seed in "estates", and in "meta" the seed last open, so a page with no
 * `?seed=` comes back to the estate it left.
 *
 * A save carries its format and the rules it was ticked under (a hash of
 * the pack). A save from another format or other rules is not resumed —
 * the days it holds could not be told apart from days these rules would
 * never have produced — and the seed is planted again instead.
 *
 * The record is untrusted input: any page on this origin can write the
 * database. A save whose shape is not a RunState's is not resumed either.
 *
 * Without IndexedDB (some private windows, a test runner) every call
 * resolves quietly to nothing and the estate simply is not kept; a save
 * that fails (storage full, say) says why.
 */
import { canon, hash16 } from "../py/canon.ts";
import { R } from "../sim/rules.ts";
import type { RunState } from "../view/runner.ts";

/**
 * Bump FORMAT whenever RunState (or the World inside it) gains, loses or
 * changes the meaning of a field: an old save must not be resumed into code
 * that reads it differently. tests/store-idb.test.ts pins the keys, so a
 * change to them fails until FORMAT and the pin move together.
 */
export const FORMAT = 3;
export const RULES = hash16(canon(R));

export interface Save {
  seed: number; format: number; rules: string; saved: number; state: RunState;
  /** the day this estate stopped on, if a day threw: resuming it will again */
  crashed?: number;
}

/** What a save came to: kept, or why not ("no storage here", "storage full", …). */
export type Saved = { ok: true } | { ok: false; why: string };

const DB = "highfield";
const ESTATES = "estates";
const META = "meta";

let opening: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((done) => {
    if (typeof indexedDB === "undefined") return done(null);
    try {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => {
        rq.result.createObjectStore(ESTATES, { keyPath: "seed" });
        rq.result.createObjectStore(META);
      };
      rq.onsuccess = () => {
        const d = rq.result;
        // a newer page wants to upgrade: step aside rather than block it
        d.onversionchange = () => {
          d.close();
          opening = null;
        };
        done(d);
      };
      rq.onerror = () => done(null);
      rq.onblocked = () => done(null);
    } catch {
      done(null);
    }
  });
  return opening;
}

function why(e: unknown): string {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "QuotaExceededError") return "storage full";
  return typeof name === "string" && name ? name : "the save failed";
}

type Done<T> = { ok: true; value: T | undefined } | { ok: false; why: string };

function run<T>(stores: string | string[], mode: IDBTransactionMode, act: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<Done<T>> {
  return db().then((d) => new Promise<Done<T>>((done) => {
    if (!d) return done({ ok: false, why: "no storage here" });
    try {
      const tx = d.transaction(stores, mode);
      const rq = act(tx);
      tx.oncomplete = () => done({ ok: true, value: rq ? rq.result : undefined });
      tx.onerror = tx.onabort = () => done({ ok: false, why: why(tx.error) });
    } catch (e) {
      done({ ok: false, why: why(e) });
    }
  }));
}

export async function available(): Promise<boolean> {
  return (await db()) !== null;
}

/** The seed last open, if any. */
export async function lastSeed(): Promise<number | undefined> {
  const r = await run<unknown>(META, "readonly", (tx) => tx.objectStore(META).get("last"));
  const v = r.ok ? r.value : undefined;
  return typeof v === "number" && Number.isSafeInteger(v) ? v : undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isDay = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

/** Enough of a RunState's shape that resuming it cannot crash on a missing part. */
export function looksLikeRun(v: unknown, seed: number): v is RunState {
  if (!isObj(v) || !isObj(v.world)) return false;
  const w = v.world;
  return w.seed === seed && isDay(w.day) && isDay(w.next_id)
    && Number.isSafeInteger(w.width) && Number.isSafeInteger(w.height)
    && Array.isArray(w.cells) && w.cells.length === w.height && w.cells.every((r) => Array.isArray(r) && r.length === w.width)
    && ["buildings", "units", "fixtures", "residents", "households", "daybook"].every((k) => isObj(w[k]))
    && ["waiting", "fates", "pending"].every((k) => Array.isArray(w[k]))
    && isObj(v.prev) && Array.isArray(v.events) && isObj(v.daybooks) && isObj(v.last_watch)
    && isObj(v.memory) && Array.isArray(v.memory.used)
    && Number.isFinite(v.next_watch) && typeof v.paused === "boolean"
    && typeof v.tick_seconds === "number" && v.tick_seconds > 0 && Number.isFinite(v.tick_seconds);
}

export interface Loaded { state: RunState; crashed?: number }

/** The estate saved for `seed`, if this format and rules saved it and it is whole. */
export async function load(seed: number): Promise<Loaded | undefined> {
  const r = await run<Save | undefined>(ESTATES, "readonly", (tx) => tx.objectStore(ESTATES).get(seed));
  const v = r.ok ? r.value : undefined;
  if (!isObj(v) || v.format !== FORMAT || v.rules !== RULES || !looksLikeRun(v.state, seed)) return undefined;
  return isDay(v.crashed) ? { state: v.state, crashed: v.crashed } : { state: v.state };
}

/** Save the estate and mark it the one last open, in one transaction. */
export async function save(state: RunState): Promise<Saved> {
  const seed = state.world.seed;
  const rec: Save = { seed, format: FORMAT, rules: RULES, saved: Date.now(), state };
  const r = await run([ESTATES, META], "readwrite", (tx) => {
    tx.objectStore(ESTATES).put(rec);
    tx.objectStore(META).put(seed, "last");
  });
  return r.ok ? { ok: true } : r;
}

/** Note on the save that the day after it threw, so the page can offer a fresh start. */
export async function markCrashed(seed: number, day: number): Promise<void> {
  await run(ESTATES, "readwrite", (tx) => {
    const s = tx.objectStore(ESTATES);
    const rq = s.get(seed);
    rq.onsuccess = () => {
      if (isObj(rq.result)) s.put({ ...rq.result, crashed: day });
    };
  });
}

export async function forget(seed: number): Promise<void> {
  await run(ESTATES, "readwrite", (tx) => tx.objectStore(ESTATES).delete(seed));
}

/**
 * Hold this seed for this tab (a Web Lock, kept until the worker goes), so
 * a second tab on the same seed knows and does not save over the first.
 * Without Web Locks every tab holds it, as before. Resolves to a release.
 */
export function claim(seed: number): Promise<(() => void) | null> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks) return Promise.resolve(() => {});
  return new Promise((done) => {
    locks.request(`highfield:${seed}`, { ifAvailable: true }, (lock) => {
      if (!lock) {
        done(null);
        return;
      }
      return new Promise<void>((release) => done(() => release()));
    }).catch(() => done(() => {}));
  });
}
