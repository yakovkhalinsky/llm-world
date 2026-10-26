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
  const marks = new Set<number>([0]);
  if (days) {
    const e = every || days;
    for (let n = e; n <= days; n += e) marks.add(n);
    marks.add(days);
  }
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

export function compare(seeds: string, days = 0, every = 0, watch = 0): Result[] {
  const dump = mkdtempSync(join(tmpdir(), "estate-parity-"));
  const py = pythonWorlds(seeds, days, every, dump, watch);
  const bySeed = new Map<number, PyLine[]>();
  for (const p of py) bySeed.set(p.seed, [...(bySeed.get(p.seed) ?? []), p]);
  const res: Result[] = [];
  for (const [seed, lines] of bySeed) {
    let diffed = false;
    const ts = tsWorlds(seed, days, every, watch, (n, c) => {
      const p = lines.find((l) => l.days === n)!;
      if (!diffed && hash16(c) !== p.hash) {
        diffed = true;
        const pyWorld = JSON.parse(readFileSync(join(dump, `${seed}-${n}.json`), "utf8"));
        diffs.set(`${seed}-${n}`, firstDiff(pyWorld, JSON.parse(c)) ?? "(same values, different text)");
      }
    });
    const diffs0 = diffs;
    lines.forEach((p, i) => {
      const t = ts[i]!;
      const ok = t.hash === p.hash && t.events === p.events && t.day === p.day;
      const r: Result = { seed, days: p.days, python: p.hash, ts: t.hash, ok, pyEvents: p.events, tsEvents: t.events };
      const d = diffs0.get(`${seed}-${p.days}`);
      if (d) r.diff = d;
      else if (!ok) r.diff = t.hash === p.hash ? "world matches; events differ" : "(see earlier line)";
      res.push(r);
    });
  }
  return res;
}
const diffs = new Map<string, string>();

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
  const res = compare(seeds, days, every, watch);
  let bad = 0;
  for (const r of res) {
    console.log(`seed ${String(r.seed).padStart(5)}  day ${String(r.days).padStart(4)}  python ${r.python}  ts ${r.ts}  events ${r.pyEvents}${r.tsEvents === r.pyEvents ? "" : "≠" + r.tsEvents}  ${r.ok ? "ok" : "MISMATCH"}`);
    if (!r.ok) { bad++; console.log(`  first difference: ${r.diff}`); }
  }
  console.log(bad ? `${bad} of ${res.length} differ` : `all ${res.length} match`);
  process.exit(bad ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
