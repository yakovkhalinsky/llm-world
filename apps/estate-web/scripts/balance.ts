/**
 * tools/balance.py, ported: the gate, and its fingerprint — eight estates ×
 * three years, pure engine, every number the gate checks hashed. The
 * fingerprint is the port's strongest parity check: it sees three years of
 * every seed's residents, households, fixtures and the chooser itself.
 *
 *   npm run balance -- [--seeds N] [--years N] [--fingerprint]
 *
 * Instrumented as Python instruments it: residents.ts's HOOKS observe the
 * chooser (ranked needs) and the satisfier, and change nothing.
 *
 * Python's fingerprint is json.dumps(sort_keys=True, default=str) — so
 * floats carry repr()'s digits, ints don't, and the means are
 * statistics.mean's (exact, rounded once). Every list in it is sorted on
 * both sides, so no line depends on a Python set's PYTHONHASHSEED order.
 */
import { createHash } from "node:crypto";
import { byCodePoint } from "../src/py/canon.ts";
import { floatRepr, pyRound } from "../src/py/num.ts";
import { meanFloat, meanInts } from "../src/py/stats.ts";
import { tick } from "../src/sim/engine/tick.ts";
import { HOOKS, pressure } from "../src/sim/engine/residents.ts";
import { generate } from "../src/sim/gen.ts";
import { R } from "../src/sim/rules.ts";

/** A Python float in the fingerprint (JS numbers are ints otherwise). */
class PyFloat { constructor(readonly v: number) {} }
type Py = number | string | boolean | null | PyFloat | Py[] | { [k: string]: Py };

/** json.dumps(v, sort_keys=True): ", " and ": ", ASCII-escaped. */
export function pyDumps(v: Py): string {
  if (v instanceof PyFloat) return floatRepr(v.v);   // finite here: no NaN/Infinity spelling needed
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new TypeError(`an int that isn't one: ${v}`);
    return String(v);
  }
  if (typeof v === "string") {
    return JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  }
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return "[" + v.map(pyDumps).join(", ") + "]";
  return "{" + Object.keys(v).sort(byCodePoint).map((k) => `${pyDumps(k)}: ${pyDumps(v[k]!)}`).join(", ") + "}";
}

interface Row {
  seed: number; days: number; census: Record<string, number>;
  residents: number; households: number;
  occupancy: number; emptiest_block: number;
  unused_fixture: string[]; all_broken: string[];
  friction: number; distinct: { int: number } | { float: number }; worn: string[];
}

const DAYS_PER_YEAR = 364;

export function runOne(seed: number, years: number): Row {
  const friction: number[] = [];
  const used = new Map<number, Set<string>>();
  const kindsUsed = new Map<string, number>();
  HOOKS.ranked = (w, r, phase, out) => {
    friction.push(out.length ? pressure(w, r, out[0]!, phase) : 0.0);
  };
  HOOKS.satisfy = (w, _r, c, need) => {
    let s = used.get(w.day);
    if (!s) used.set(w.day, (s = new Set()));
    s.add(JSON.stringify([need, c.kind]));
    if (c.kind !== "home") kindsUsed.set(c.fixture!.kind, (kindsUsed.get(c.fixture!.kind) ?? 0) + 1);
  };
  try {
    const w = generate(seed);
    for (let i = 0; i < years * DAYS_PER_YEAR; i++) tick(w);

    const census: Record<string, number> = {};
    for (const h of Object.values(w.households)) {
      const u = w.units[String(h.unit)];
      if (u !== undefined && u.household === h.id) census[h.kind] = (census[h.kind] ?? 0) + 1;
    }
    const units = Object.values(w.units);
    const occupied = units.filter((u) => u.household !== null).length;
    const vacancy: number[] = [];
    for (const b of Object.values(w.buildings)) {
      if (b.kind !== "block") continue;
      const live = b.units.filter((u) => w.units[String(u)]!.household !== null).length;
      vacancy.push(live / Math.max(1, b.units.length));
    }
    const worn = [...new Set(Object.values(w.fixtures).filter((f) => f.condition <= 0).map((f) => f.kind))].sort(byCodePoint);
    const afford = Object.entries(R.fixtures).filter(([, v]) => truthy((v as { affords?: unknown }).affords)).map(([k]) => k);
    const umin = R.gate.use_min;
    const distinct = used.size ? [...used.values()].map((s) => s.size) : [0];
    const dm = meanInts(distinct);
    return {
      seed, days: years * DAYS_PER_YEAR, census,
      residents: Object.keys(w.residents).length,
      households: Object.keys(w.households).length,
      occupancy: pyRound(occupied / Math.max(1, units.length), 3),
      emptiest_block: pyRound(vacancy.length ? Math.min(...vacancy) : 1.0, 3),
      unused_fixture: afford.filter((k) => (kindsUsed.get(k) ?? 0) < umin).sort(byCodePoint),
      all_broken: afford.filter((k) => worn.includes(k) && (kindsUsed.get(k) ?? 0) === 0).sort(byCodePoint),
      friction: pyRound(friction.length ? meanFloat(friction) : 0.0, 3),
      distinct: "int" in dm ? dm : { float: pyRound(dm.float, 2) },
      worn,
    };
  } finally {
    HOOKS.ranked = null;
    HOOKS.satisfy = null;
  }
}

/** Python truthiness, for the JSON values rules.json holds. */
function truthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

function toPy(r: Row): Py {
  return {
    seed: r.seed, days: r.days, census: r.census, residents: r.residents, households: r.households,
    occupancy: new PyFloat(r.occupancy), emptiest_block: new PyFloat(r.emptiest_block),
    unused_fixture: r.unused_fixture, all_broken: r.all_broken,
    friction: new PyFloat(r.friction),
    distinct: "int" in r.distinct ? r.distinct.int : new PyFloat(r.distinct.float),
    worn: r.worn,
  };
}

export function fingerprint(rows: Row[]): string {
  return createHash("sha256").update(pyDumps(rows.map(toPy))).digest("hex").slice(0, 16);
}

/** The gate's laws, as balance.py names them. */
export function gate(r: Row): string[] {
  const g = R.gate, bad: string[] = [];
  const gone = R.pop.roster.filter((k) => !r.census[k]);
  if (gone.length) bad.push(`seed ${r.seed}: household types absent at the end: ${gone.join(", ")}`);
  if (!(g.residents_min <= r.residents && r.residents <= g.residents_max)) {
    bad.push(`seed ${r.seed}: ${r.residents} residents, outside [${g.residents_min}, ${g.residents_max}]`);
  }
  if (r.occupancy < g.occupancy_min) bad.push(`seed ${r.seed}: occupancy ${r.occupancy} below ${g.occupancy_min}`);
  if (r.emptiest_block <= 0.0) bad.push(`seed ${r.seed}: a block stands entirely vacant`);
  if (r.unused_fixture.length) bad.push(`seed ${r.seed}: fixture kinds nothing used in ${r.days} days: ${r.unused_fixture.join(", ")}`);
  const [lo, hi] = g.friction;
  if (!(lo! <= r.friction && r.friction <= hi!)) bad.push(`seed ${r.seed}: friction ${r.friction} outside [${lo}, ${hi}]`);
  const d = "int" in r.distinct ? r.distinct.int : r.distinct.float;
  if (d < g.distinct_min) bad.push(`seed ${r.seed}: ${d} distinct (need, place) pairs a day, below ${g.distinct_min}`);
  return bad;
}

function main(): void {
  const argv = process.argv.slice(2);
  const opt = (k: string): number | null => {
    const i = argv.indexOf(k);
    if (i < 0) return null;
    const n = Number(argv[i + 1]);
    if (!Number.isSafeInteger(n) || n < 1) { console.error(`${k} wants a whole number ≥ 1`); process.exit(2); }
    return n;
  };
  const seeds = opt("--seeds") ?? R.gate.seeds;
  const years = opt("--years") ?? R.gate.years;
  const rows: Row[] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const t0 = performance.now();
    rows.push(runOne(seed, years));
    if (!argv.includes("--fingerprint")) console.error(`seed ${seed}: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }
  if (argv.includes("--fingerprint")) { console.log(fingerprint(rows)); return; }
  console.log(`${seeds} estates × ${years} years\n`);
  for (const r of rows) {
    const d = "int" in r.distinct ? r.distinct.int : r.distinct.float;
    console.log(`seed ${r.seed}: folk ${r.residents}, households ${r.households}, occupancy ${r.occupancy}, friction ${r.friction}, distinct ${d}, emptiest ${r.emptiest_block}, census ${Object.entries(r.census).sort(([a], [b]) => byCodePoint(a, b)).map(([k, v]) => k.slice(0, 4) + v).join(" ")}`);
  }
  const bad = rows.flatMap(gate);
  console.log(bad.length ? "\nTHE GATE FAILS:\n" + bad.map((b) => "  ✗ " + b).join("\n") : "\nthe gate holds.");
  console.log(`\nfingerprint ${fingerprint(rows)}`);
  process.exit(bad.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
