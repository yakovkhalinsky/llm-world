/**
 * State containers, the calendar, and the one source of randomness —
 * apps/estate/estate/world.py.
 *
 * The estate is plain JSON-shaped objects, as in Python, so it saves as a
 * single blob and hashes the same way on both sides. Dicts keyed by
 * `str(id)` stay plain objects: ids only ever grow, so Python's insertion
 * order and JS's ascending integer-key order are the same order.
 */
import { PyRandom } from "../py/random.ts";
import { ifloordiv, imod } from "../py/num.ts";
import { R } from "./rules.ts";

export const DAYS_PER_WEEK = 7;

// ------------------------------------------------------------- types

export interface Cell {
  site: string; wear: number; puddle: number; shade: number; noise: number; light: number;
  [k: string]: unknown;
}
export interface Building {
  id: number; name: string; kind: string; x: number; y: number; w: number; h: number;
  floors: number; door: [number, number]; units: number[]; condition: number;
  power: boolean; water: boolean; [k: string]: unknown;
}
export interface Unit {
  id: number; building: number; floor: number; household: number | null;
  condition: number; capacity: number; quiet_base: number; vacant_since: number | null;
  [k: string]: unknown;
}
export interface Household {
  id: number; kind: string; unit: number; members: number[]; moved_in: number;
  unhappy: number; [k: string]: unknown;
}
export interface Where {
  mode: string; unit: number | null; x: number; y: number; fixture: number | null;
  [k: string]: unknown;
}
export interface Resident {
  id: number; household: number; name: string | null; age: number; role: string;
  needs: Record<string, number>; where: Where; habit: Record<string, unknown>;
  mobility: number; stress: number; tag: string | null; side: unknown;
  [k: string]: unknown;
}
export interface Fixture {
  id: number; kind: string; x: number; y: number; condition: number;
  occupants: number[]; uses_today: number; use_total: number; last_use: number;
  stock?: number; age?: number; [k: string]: unknown;
}
export interface Fate { kind?: string; region?: string; [k: string]: unknown }

export interface Daybook {
  uses: Record<string, number>; out: number; noise: number; broke: number;
  sold_out?: boolean; weather?: string;
}

export interface World {
  seed: number; day: number; width: number; height: number;
  cells: Cell[][];
  buildings: Record<string, Building>;
  units: Record<string, Unit>;
  fixtures: Record<string, Fixture>;
  residents: Record<string, Resident>;
  households: Record<string, Household>;
  next_id: number;
  weather: string; weather_left: number; wet_days: number;
  waiting: { kind: string }[];
  daybook: Daybook;
  fates: Fate[];
  pending: Fate[];
  biome: string | null;
  [k: string]: unknown;
}

// ------------------------------------------------------------- the calendar

export function seasonIndex(day: number): number {
  return imod(ifloordiv(day - 1, R.world.days_per_season), 4);
}
export function seasonName(day: number): string {
  return R.presentation.seasons[seasonIndex(day)]!;
}
export function weekday(day: number): number {
  return imod(day - 1, DAYS_PER_WEEK);
}
export function weekdayName(day: number): string {
  return R.presentation.weekdays[weekday(day)]!;
}
export function yearOf(day: number): number {
  return ifloordiv(day - 1, R.world.days_per_season * 4) + 1;
}
export function phaseNames(): string[] {
  return R.world.phases;
}

/** Deterministic per-day rng, the same draws as Python's for the same
 * (seed, day, salt). */
export function rngFor(seed: number, day: number, salt = ""): PyRandom {
  return new PyRandom(`${seed}:${day}:${salt}`);
}

// ------------------------------------------------------------ the space

export function inBounds(w: World, x: number, y: number): boolean {
  return 0 <= x && x < w.width && 0 <= y && y < w.height;
}
export function cellAt(w: World, x: number, y: number): Cell | null {
  return inBounds(w, x, y) ? w.cells[y]![x]! : null;
}
export function inRegion(_w: World, region: string, x: number, y: number): boolean {
  const spec = R.regions[region];
  if (spec === undefined) return region === "all";
  const xr = spec.x;
  const yr = spec.y;
  return (xr == null || (xr[0] <= x && x < xr[1])) && (yr == null || (yr[0] <= y && y < yr[1]));
}
export function fateMult(w: World, key: string, x: number, y: number): number {
  let m = 1.0;
  for (const f of w.fates) {
    const v = f[key];
    if (v === undefined || v === null) continue;
    if (inRegion(w, (f.region as string | undefined) ?? "all", x, y)) m *= v as number;
  }
  return m;
}
export function walkCost(w: World, x: number, y: number): number | null {
  const c = cellAt(w, x, y);
  if (c === null) return null;
  const base = R.sites[c.site]!.walk;
  if (base === null) return null;
  return base * fateMult(w, "walk_mult", x, y);
}
export function stairMult(w: World, b: Building): number {
  return fateMult(w, "stair_mult", b.door[0], b.door[1]);
}
export function passable(w: World, x: number, y: number): boolean {
  return walkCost(w, x, y) !== null;
}

// -------------------------------------------------------------- containers

export function newState(seed: number, width: number, height: number): World {
  return {
    seed, day: 0, width, height,
    cells: [], buildings: {}, units: {}, fixtures: {}, residents: {}, households: {},
    next_id: 1,
    weather: "clear", weather_left: 0, wet_days: 0,
    waiting: [],
    daybook: { uses: {}, out: 0, noise: 0.0, broke: 0 },
    fates: [], pending: [],
    biome: null,
  };
}

export function newCell(site: string): Cell {
  return { site, wear: 0.0, puddle: 0, shade: 0.0, noise: 0.0, light: 0.0 };
}

export function newBuilding(
  bid: number, name: string, kind: string, x: number, y: number,
  w: number, h: number, floors: number, door: readonly [number, number],
): Building {
  return {
    id: bid, name, kind, x, y, w, h, floors, door: [door[0], door[1]],
    units: [], condition: 1.0, power: true, water: true,
  };
}

export function newUnit(uid: number, building: number, floor: number, capacity: number): Unit {
  return {
    id: uid, building, floor, household: null, condition: 1.0, capacity,
    quiet_base: 0.7, vacant_since: null,
  };
}

export function newHousehold(hid: number, kind: string, unit: number): Household {
  return { id: hid, kind, unit, members: [], moved_in: 0, unhappy: 0.0 };
}

export function newResident(rid: number, household: number, age: number): Resident {
  const needs: Record<string, number> = {};
  for (const n of Object.keys(R.needs)) needs[n] = 0.0;
  return {
    id: rid, household, name: null, age, role: roleOf(age), needs,
    where: { mode: "in", unit: null, x: 0, y: 0, fixture: null },
    habit: {}, mobility: 1.0, stress: 0.0, tag: null, side: null,
  };
}

export function newFixture(fid: number, kind: string, x: number, y: number): Fixture {
  const f: Fixture = {
    id: fid, kind, x, y, condition: 1.0,
    occupants: [], uses_today: 0, use_total: 0, last_use: 0,
  };
  const spec = R.fixtures[kind]!;
  if (spec.stock) f.stock = spec.stock;
  if (spec.living) f.age = 0;
  return f;
}

export function nameFor(rng: PyRandom): string | null {
  const names = R.presentation.resident_names ?? [];
  return names.length ? rng.choice(names) : null;
}

export function roleOf(age: number): string {
  const a = R.people.ages;
  if (age < a.adult) return "child";
  if (age >= a.elder) return "elder";
  return "adult";
}

// ------------------------------------------------------------------ counts

/** Households by type, counting only a household its flat says is home. */
export function counts(w: World): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of Object.values(w.households)) {
    const u = w.units[String(h.unit)];
    if (u !== undefined && u.household === h.id) out[h.kind] = (out[h.kind] ?? 0) + 1;
  }
  return out;
}

export function residentsHere(w: World, x: number, y: number): Resident[] {
  return Object.values(w.residents).filter(
    (r) => r.where.mode === "at" && r.where.x === x && r.where.y === y,
  );
}

export function occupiedUnits(w: World): number {
  let n = 0;
  for (const u of Object.values(w.units)) if (u.household !== null) n++;
  return n;
}
