/** The placed things — apps/estate/estate/engine/places.py. */
import { R } from "../rules.ts";
import * as W from "../world.ts";
import { wetness } from "./weather.ts";
import type { Ev } from "./events.ts";

export function perimeterBonus(kind: string, need: string): number {
  return R.fixtures[kind]!.perimeter_bonus?.[need] ?? 0.0;
}

export function baseQuality(kind: string, need: string, fixture: W.Fixture | null = null): number {
  let q = R.fixtures[kind]!.affords[need] ?? 0.0;
  if (fixture !== null && fixture.perimeter) q += perimeterBonus(kind, need);
  return q;
}

export function effective(
  kind: string, need: string, condition: number, occupants: number, fixture: W.Fixture | null = null,
): number {
  const cap = Math.max(1, R.fixtures[kind]!.capacity!);
  const k = R.engine.congestion!;
  return (baseQuality(kind, need, fixture) * condition) / (1.0 + (k * occupants) / cap);
}

export function full(kind: string, occupants: readonly unknown[]): boolean {
  const spec = R.fixtures[kind]!;
  if (!spec.hard_capacity) return false;
  return occupants.length >= Math.max(1, spec.capacity!);
}

// --------------------------------------------------------------- noise

export function buildNoise(w: W.World): W.Cell[][] {
  const ww = w.width, hh = w.height;
  const soft = R.weather.soften * wetness(w);
  const grid: number[][] = [];
  for (let y = 0; y < hh; y++) {
    const row = new Array<number>(ww);
    for (let x = 0; x < ww; x++) row[x] = R.sites[w.cells[y]![x]!.site]!.noise;
    grid.push(row);
  }
  for (const f of Object.values(w.fixtures)) {
    const n = f.last_use ?? 0;
    if (!n || f.condition <= 0) continue;
    const spec = R.fixtures[f.kind]!;
    const loud = spec.loud ?? 0.0;
    if (!loud) continue;
    const carry = spec.carry ?? 1;
    const emit = loud * Math.min(n, 12);
    for (let dy = -carry; dy <= carry; dy++) {
      for (let dx = -carry; dx <= carry; dx++) {
        const d = Math.abs(dx) + Math.abs(dy);
        if (d > carry) continue;
        const x = f.x + dx, y = f.y + dy;
        if (W.inBounds(w, x, y)) grid[y]![x]! += emit * (1.0 - d / (carry + 1.0));
      }
    }
  }
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < ww; x++) {
      w.cells[y]![x]!.noise = Math.max(0.0, (grid[y]![x]! - soft) * W.fateMult(w, "noise_mult", x, y));
    }
  }
  const book = w.daybook;
  if (book !== undefined && book !== null) {
    let m = -Infinity;
    for (const row of w.cells) for (const c of row) if (c.noise > m) m = c.noise;
    book.noise = m === -Infinity ? 0.0 : m;
  }
  return w.cells;
}

export function buildLight(w: W.World): void {
  const grid: number[][] = Array.from({ length: w.height }, () => new Array<number>(w.width).fill(0.0));
  for (const f of Object.values(w.fixtures)) {
    const emit = R.fixtures[f.kind]!.light ?? 0.0;
    if (!emit || f.condition <= 0) continue;
    for (const dy of [-2, -1, 0, 1, 2]) {
      for (const dx of [-2, -1, 0, 1, 2]) {
        const x = f.x + dx, y = f.y + dy;
        if (W.inBounds(w, x, y)) {
          const d = Math.abs(dx) + Math.abs(dy);
          grid[y]![x]! += emit * Math.max(0.0, 1.0 - d / 3.0);
        }
      }
    }
  }
  for (let y = 0; y < w.height; y++) {
    for (let x = 0; x < w.width; x++) w.cells[y]![x]!.light = Math.min(1.0, grid[y]![x]!);
  }
}

export function unitNoise(w: W.World, unit: W.Unit): number {
  const b = w.buildings[String(unit.building)]!;
  const door = w.cells[b.door[1]]![b.door[0]]!.noise;
  const road = door * Math.max(0.12, 1.0 - 0.10 * unit.floor);
  let homes = 0;
  for (const u of b.units) if (w.units[String(u)]!.household !== null) homes++;
  const crowd = homes / Math.max(1, b.units.length);
  return (road + 0.14 * crowd) * (1.0 - 0.45 * unit.quiet_base);
}

// ------------------------------------------------------------ fixtures

export function updateFixtures(w: W.World, evs: Ev[]): void {
  const busy = R.engine.busy_wear!;
  const repair = R.engine.repair!;
  const rng = W.rngFor(w.seed, w.day, "fail");
  for (const f of Object.values(w.fixtures)) {
    const spec = R.fixtures[f.kind]!;
    if (spec.living) continue;
    const uses = f.uses_today ?? 0;
    delete (f as Partial<W.Fixture>).uses_today;
    f.last_use = uses;
    const was = f.condition;
    if (rng.random() < (spec.break_prob ?? 0.0)) {
      f.condition = 0.0;
    } else {
      f.condition = Math.max(0.0, Math.min(1.0,
        was - spec.decay * (1.0 + busy * uses) + repair * (spec.upkeep ?? 1.0) * (1.0 - was)));
    }
    if (was > 0 && f.condition <= 0) {
      evs.push({ day: w.day, kind: "broke", what: f.kind, x: f.x, y: f.y });
      if (w.daybook !== undefined && w.daybook !== null) w.daybook.broke += 1;
    }
    if (spec.supplied) f.stock = spec.stock ?? 150;
    f.occupants = [];
  }
}
