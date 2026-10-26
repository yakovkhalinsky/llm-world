/**
 * The parity harness: Python apps/estate and this port, same seeds, same
 * worlds — compared by canonical hash, and on a mismatch, by the first
 * place the two canonical worlds differ.
 *
 *   npm run parity -- [--seeds 1-8,42,3771] [--days N] [--every K]
 *
 * PR 1 ports generation, so --days must be 0 (the planted estate).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canon, hash16 } from "../src/py/canon.ts";
import { generate } from "../src/sim/gen.ts";

export const ESTATE = resolve(import.meta.dirname, "../../estate");
export const PYTHON = process.env.PYTHON ?? "python3";

export interface PyLine { seed: number; days: number; day: number; hash: string }

export function pythonWorlds(seeds: string, days = 0, every = 0, dump?: string): PyLine[] {
  const args = [join(ESTATE, "tools/parity.py"), "worlds", "--seeds", seeds,
    "--days", String(days), "--every", String(every)];
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

export interface Result { seed: number; days: number; python: string; ts: string; ok: boolean; diff?: string }

export function compareGen(seeds: string): Result[] {
  const dump = mkdtempSync(join(tmpdir(), "estate-parity-"));
  const py = pythonWorlds(seeds, 0, 0, dump);
  return py.map((p) => {
    const w = generate(p.seed);
    const c = canon(w);
    const ts = hash16(c);
    const r: Result = { seed: p.seed, days: p.days, python: p.hash, ts, ok: ts === p.hash };
    if (!r.ok) {
      const pyWorld = JSON.parse(readFileSync(join(dump, `${p.seed}-0.json`), "utf8"));
      r.diff = firstDiff(pyWorld, JSON.parse(c)) ?? "(same values, different text)";
    }
    return r;
  });
}

function main(): void {
  const argv = process.argv.slice(2);
  const opt = (k: string, d: string): string => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : d;
  };
  const seeds = opt("--seeds", "1-8,42,3771");
  const days = Number(opt("--days", "0"));
  if (days !== 0) {
    console.error("this port has generation only so far: --days must be 0");
    process.exit(2);
  }
  const res = compareGen(seeds);
  let bad = 0;
  for (const r of res) {
    console.log(`seed ${String(r.seed).padStart(5)}  day ${r.days}  python ${r.python}  ts ${r.ts}  ${r.ok ? "ok" : "MISMATCH"}`);
    if (!r.ok) { bad++; console.log(`  first difference: ${r.diff}`); }
  }
  console.log(bad ? `${bad} of ${res.length} differ` : `all ${res.length} match`);
  process.exit(bad ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
