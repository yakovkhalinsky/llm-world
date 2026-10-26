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
 * Without IndexedDB (some private windows, a test runner) every call
 * resolves quietly to nothing and the estate simply is not kept.
 */
import { canon, hash16 } from "../py/canon.ts";
import { R } from "../sim/rules.ts";
import type { RunState } from "../view/runner.ts";

export const FORMAT = 1;
export const RULES = hash16(canon(R));

export interface Save { seed: number; format: number; rules: string; saved: number; state: RunState }

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
      rq.onsuccess = () => done(rq.result);
      rq.onerror = () => done(null);
      rq.onblocked = () => done(null);
    } catch {
      done(null);
    }
  });
  return opening;
}

function run<T>(store: string, mode: IDBTransactionMode, act: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then((d) => new Promise<T | undefined>((done) => {
    if (!d) return done(undefined);
    try {
      const tx = d.transaction(store, mode);
      const rq = act(tx.objectStore(store));
      tx.oncomplete = () => done(rq ? rq.result : undefined);
      tx.onerror = tx.onabort = () => done(undefined);
    } catch {
      done(undefined);
    }
  }));
}

export async function available(): Promise<boolean> {
  return (await db()) !== null;
}

/** The seed last open, if any. */
export async function lastSeed(): Promise<number | undefined> {
  const v = await run<unknown>(META, "readonly", (s) => s.get("last"));
  return typeof v === "number" && Number.isSafeInteger(v) ? v : undefined;
}

/** The estate saved for `seed`, if it was saved by this format and rules. */
export async function load(seed: number): Promise<RunState | undefined> {
  const v = await run<Save | undefined>(ESTATES, "readonly", (s) => s.get(seed));
  if (!v || v.format !== FORMAT || v.rules !== RULES || v.state?.world?.seed !== seed) return undefined;
  return v.state;
}

export async function save(state: RunState): Promise<boolean> {
  const seed = state.world.seed;
  const rec: Save = { seed, format: FORMAT, rules: RULES, saved: Date.now(), state };
  const ok = await run(ESTATES, "readwrite", (s) => s.put(rec));
  await run(META, "readwrite", (s) => s.put(seed, "last"));
  return ok !== undefined;
}

export async function forget(seed: number): Promise<void> {
  await run(ESTATES, "readwrite", (s) => s.delete(seed));
}
