/**
 * The parity harness: Python apps/estate and this port, same seeds, same
 * worlds — compared by canonical hash, and on a mismatch, by the first
 * place the two canonical worlds differ.
 *
 *   npm run parity -- [--seeds 1-8,42,3771] [--days N] [--every K] [--watch K]
 *
 * Day 0 is the planted estate; --days ticks N days and compares at every
 * K-th (--every, default only day N); --watch K has the watcher choose and
 * queue a fate after every K-th day, on both sides. Each line compares the
 * world hash and the hash of the events since the previous line.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canon, hash16 } from "../src/py/canon.ts";
import { generate } from "../src/sim/gen.ts";
import { tick } from "../src/sim/engine/tick.ts";
import * as watcher from "../src/sim/watcher.ts";
import type { Ev } from "../src/sim/engine/events.ts";

export const ESTATE = resolve(import.meta.dirname, "../../estate");
export const PYTHON = process.env.PYTHON ?? "python3";

export interface PyLine { seed: number; days: number; day: number; hash: string; events: string }

export function pythonWorlds(seeds: string, days = 0, every = 0, dump?: string, watch = 0): PyLine[] {
  const args = [join(ESTATE, "tools/parity.py"), "worlds", "--seeds", seeds,
    "--days", String(days), "--every", String(every), "--watch", String(watch)];
  if (dump) args.push("--dump", dump);
  const out = execFileSync(PYTHON, args, { encoding: "utf8", maxBuffer: 1 << 28 });
  return out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as PyLine);
}

/** The first differing JSON path between two canonical strings. */
export function firstDiff(a: unknown, b: unknown, path = "$"): string | null {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) {
    return `${path}: ${JSON.stringify(a)?.slice(0, 80)} != ${JSON.stringify(b)?.slice(0, 80)}`;
  }
  if (a && typeof a === "object") {
    if (Array.isArray(a)) {
      const bb = b as unknown[];
      if (a.length !== bb.length) return `${path}: length ${a.length} != ${bb.length}`;
      for (let i = 0; i < a.length; i++) {
        const d = firstDiff(a[i], bb[i], `${path}[${i}]`);
        if (d) return d;
      }
      return null;
    }
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort();
    for (const k of keys) {
      if (!(k in ao) || !(k in bo)) return `${path}.${k}: present only in ${k in ao ? "python" : "ts"}`;
      const d = firstDiff(ao[k], bo[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return a === b ? null : `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}

export interface Result {
  seed: number; days: number; python: string; ts: string; ok: boolean;
  pyEvents: string; tsEvents: string; diff?: string;
}

/** The TS side of `parity.py worlds`: the same marks, the same lines. */
export function tsWorlds(seed: number, days = 0, every = 0, watch = 0,
  onMark?: (n: number, canonical: string) => void): Omit<PyLine, "seed">[] {
  const w = generate(seed);
  const marks = new Set(marksFor(days, every));
  const out: Omit<PyLine, "seed">[] = [];
  let evs: Ev[] = [];
  const emit = (n: number): void => {
    const c = canon(w);
    out.push({ days: n, day: w.day, hash: hash16(c), events: hash16(canon(evs)) });
    evs = [];
    onMark?.(n, c);
  };
  emit(0);
  for (let n = 1; n <= days; n++) {
    evs.push(...tick(w));
    if (watch && n % watch === 0) watcher.queue(w, watcher.choose(w));
    if (marks.has(n)) emit(n);
  }
  return out;
}

/** "1-8,42,3771" → [1..8, 42, 3771], as parity.py reads it; refuses junk. */
export function parseSeeds(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part); // parity.py takes no negatives
    if (!m) throw new Error(`bad seed spec: ${JSON.stringify(part)}`);
    const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b < a) throw new Error(`bad seed range: ${part}`);
    for (let s = a; s <= b; s++) out.push(s);
  }
  if (!out.length) throw new Error(`no seeds in ${JSON.stringify(spec)}`);
  return out;
}

/** The marks both sides report at: 0, every K-th day, and the last. */
export function marksFor(days: number, every: number): number[] {
  const m = new Set<number>([0]);
  if (days) {
    const e = every || days;
    for (let n = e; n <= days; n += e) m.add(n);
    m.add(days);
  }
  return [...m].sort((a, b) => a - b);
}

/**
 * Compare every requested seed at every mark. Throws, rather than passing
 * on nothing, when Python reports no seeds, a different set of seeds than
 * asked, or a different set of marks for one.
 */
export function compare(seeds: string, days = 0, every = 0, watch = 0): Result[] {
  const want = parseSeeds(seeds);
  const marks = marksFor(days, every);
  const dump = mkdtempSync(join(tmpdir(), "estate-parity-"));
  const py = pythonWorlds(seeds, days, every, dump, watch);
  const bySeed = new Map<number, PyLine[]>();
  for (const p of py) bySeed.set(p.seed, [...(bySeed.get(p.seed) ?? []), p]);
  const got = [...bySeed.keys()].sort((a, b) => a - b);
  const asked = [...new Set(want)].sort((a, b) => a - b);
  if (JSON.stringify(got) !== JSON.stringify(asked)) {
    throw new Error(`python reported seeds ${JSON.stringify(got)}, asked for ${JSON.stringify(asked)}`);
  }
  const res: Result[] = [];
  for (const seed of asked) {
    const lines = bySeed.get(seed)!;
    const at = lines.map((l) => l.days);
    if (JSON.stringify(at) !== JSON.stringify(marks)) {
      throw new Error(`python seed ${seed} reported days ${JSON.stringify(at)}, expected ${JSON.stringify(marks)}`);
    }
    const diffs = new Map<number, string>();
    const ts = tsWorlds(seed, days, every, watch, (n, c) => {
      const p = lines.find((l) => l.days === n)!;
      if (!diffs.size && hash16(c) !== p.hash) {
        const pyWorld = JSON.parse(readFileSync(join(dump, `${seed}-${n}.json`), "utf8"));
        diffs.set(n, firstDiff(pyWorld, JSON.parse(c)) ?? "(same values, different text)");
      }
    });
    if (ts.length !== lines.length) throw new Error(`seed ${seed}: ts gave ${ts.length} marks, python ${lines.length}`);
    lines.forEach((p, i) => {
      const t = ts[i]!;
      const ok = t.days === p.days && t.hash === p.hash && t.events === p.events && t.day === p.day;
      const r: Result = { seed, days: p.days, python: p.hash, ts: t.hash, ok, pyEvents: p.events, tsEvents: t.events };
      const d = diffs.get(p.days);
      if (d) r.diff = d;
      else if (!ok) r.diff = t.hash === p.hash ? "world matches; events differ" : "(see earlier line)";
      res.push(r);
    });
  }
  if (!res.length) throw new Error("no comparisons made");
  return res;
}

/** Day 0 only: the planted estate. */
export function compareGen(seeds: string): Result[] {
  return compare(seeds, 0, 0, 0);
}

function main(): void {
  const argv = process.argv.slice(2);
  const opt = (k: string, d: string): string => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : d;
  };
  const seeds = opt("--seeds", "1-8,42,3771");
  const days = Number(opt("--days", "0"));
  const every = Number(opt("--every", "0"));
  const watch = Number(opt("--watch", "0"));
  for (const [k, v] of [["--days", days], ["--every", every], ["--watch", watch]] as const) {
    if (!Number.isSafeInteger(v) || v < 0) { console.error(`${k} wants a whole number ≥ 0`); process.exit(2); }
  }
  let res: Result[];
  try {
    res = compare(seeds, days, every, watch);
  } catch (e) {
    console.error(`parity: ${(e as Error).message}`);
    process.exit(2);
  }
  let bad = 0;
  for (const r of res) {
    console.log(`seed ${String(r.seed).padStart(5)}  day ${String(r.days).padStart(4)}  python ${r.python}  ts ${r.ts}  events ${r.pyEvents}${r.tsEvents === r.pyEvents ? "" : "≠" + r.tsEvents}  ${r.ok ? "ok" : "MISMATCH"}`);
    if (!r.ok) { bad++; console.log(`  first difference: ${r.diff}`); }
  }
  console.log(bad ? `${bad} of ${res.length} differ` : `all ${res.length} match`);
  process.exit(bad ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
