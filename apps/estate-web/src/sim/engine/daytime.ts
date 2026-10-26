/**
 * The weekday: the school run, the school day, and work —
 * apps/estate/estate/engine/daytime.py.
 */
import { R } from "../rules.ts";
import * as W from "../world.ts";
import * as F from "./families.ts";
import type { Cand } from "./families.ts";

type Res = W.Resident;
export const AWAY = "away";
export const SCHOOL = "school";

export function law() { return R.school; }
export function jobs() { return R.work; }

const intKeys = W.ids;
const pk = (x: number, y: number) => `${x},${y}`;

// ------------------------------------------------------------- the places

export function gate(w: W.World): W.Fixture | null {
  for (const fid of intKeys(w.fixtures)) {
    const f = w.fixtures[fid]!;
    if (f.kind === "school") return f;
  }
  return null;
}

export function stop(w: W.World): W.Fixture | null {
  for (const fid of intKeys(w.fixtures)) {
    const f = w.fixtures[fid]!;
    if (f.kind === "bus_stop") return f;
  }
  return null;
}

export function stopSpots(w: W.World): [number, number][] {
  const s = stop(w);
  if (s === null) return [];
  const taken = new Set<string>();
  for (const f of Object.values(w.fixtures)) taken.add(pk(f.x, f.y));
  const ring: [number, number, number][] = [];
  for (const dy of [-1, 0, 1]) {
    for (const dx of [-1, 0, 1]) {
      const x = s.x + dx, y = s.y + dy;
      if ((dx || dy) && 0 <= x && x < w.width && 0 <= y && y < w.height &&
          !taken.has(pk(x, y)) && W.passable(w, x, y)) {
        ring.push([Math.abs(dx) + Math.abs(dy), y, x]);
      }
    }
  }
  ring.sort((a, b) => F.cmpTuple(a, b));
  const out = ring.map(([, y, x]) => [x, y] as [number, number]);
  return out.length ? out : [[s.x, s.y]];
}

function waitAt(w: W.World): [number, number] {
  const spots = stopSpots(w);
  const held = new Map<string, number>();
  for (const [x, y] of spots) held.set(pk(x, y), 0);
  for (const r of Object.values(w.residents)) {
    if (r.where.mode === AWAY) {
      const p = pk(r.where.x, r.where.y);
      if (held.has(p)) held.set(p, held.get(p)! + 1);
    }
  }
  let best = spots[0]!;
  for (const s of spots.slice(1)) if (held.get(pk(...s))! < held.get(pk(...best))!) best = s;
  return best;
}

export function schoolBuilding(w: W.World): W.Building | null {
  for (const bid of intKeys(w.buildings)) {
    const b = w.buildings[bid]!;
    if (b.kind === "school") return b;
  }
  return null;
}

export function yardSpots(w: W.World): [number, number][] {
  const b = schoolBuilding(w);
  if (b === null || !b.yard) {
    const g = gate(w);
    return g ? [[g.x, g.y]] : [];
  }
  const [x0, y0, yw, yh] = b.yard as [number, number, number, number];
  const cells: [number, number][] = [];
  for (let y = y0; y < y0 + yh; y++) for (let x = x0; x < x0 + yw; x++) cells.push([x, y]);
  const out: [number, number][] = [];
  const times = law().per_yard_cell ?? 1;
  for (let i = 0; i < times; i++) out.push(...cells);
  return out;
}

// ------------------------------------------------------------- the people

export function schoolDay(w: W.World): boolean {
  return law().days.includes(W.weekday(w.day));
}

export function isPupil(r: Res): boolean {
  const [lo, hi] = law().ages;
  return lo <= r.age && r.age < hi;
}

/** Drawn once per person from the seed and kept. The key is added the
 * first time anyone asks, exactly as in Python, since it is in the hash. */
export function hasJob(w: W.World, r: Res): boolean {
  if (!("job" in r)) r.job = W.rngFor(w.seed, 0, `job:${r.id}`).random() < jobs().share;
  return r.job as boolean;
}

export function isWorker(w: W.World, r: Res): boolean {
  const ages = R.people.ages;
  return ages.adult <= r.age && r.age < ages.elder && hasJob(w, r);
}

export function carer(w: W.World, hh: W.Household): Res | null {
  const folk = F.members(w, hh);
  if (!folk.some(F.isYoung)) return null;
  const adult = R.people.ages.adult;
  const adults = folk.filter((r) => r.age >= adult).sort((a, b) => a.id - b.id);
  if (!adults.length) return null;
  const free = adults.filter((r) => !isWorker(w, r));
  return (free.length ? free : adults)[0]!;
}

export function shift(w: W.World, r: Res): readonly string[] {
  if (!schoolDay(w) || !isWorker(w, r)) return [];
  const hh = F.household(w, r);
  if (hh !== null && carer(w, hh) === r) {
    const young = F.youngIn(w, hh);
    if (young.some((k) => !isPupil(k))) return [];
    return jobs().school_hours;
  }
  return jobs().shift;
}

export function commuting(w: W.World, r: Res, phase: string): boolean {
  const sh = shift(w, r);
  if (!sh.length || r.where.mode === AWAY) return false;
  return phase === jobs().commute || sh.includes(phase);
}

export function dueAtSchool(w: W.World, r: Res, phase: string): boolean {
  if (!schoolDay(w) || !isPupil(r)) return false;
  if (r.where.mode === SCHOOL || r.schooled === w.day) return false;
  return phase === law().run || law().hours.includes(phase);
}

export function busy(w: W.World, g: Res, phase: string): boolean {
  return commuting(w, g, phase);
}

// ------------------------------------------------------- the phase's turns

function enter(w: W.World, k: Res): void {
  const spots = yardSpots(w);
  const g = gate(w);
  const held = new Map<string, number>();
  for (const r of Object.values(w.residents)) {
    if (r.where.mode === SCHOOL) {
      const p = pk(r.where.x, r.where.y);
      held.set(p, (held.get(p) ?? 0) + 1);
    }
  }
  let x: number, y: number;
  if (spots.length) {
    // min(dict.fromkeys(spots), key=held.get): unique spots, first-seen order
    const seen = new Set<string>();
    let best: [number, number] | null = null;
    let bv = 0;
    for (const s of spots) {
      const key = pk(...s);
      if (seen.has(key)) continue;
      seen.add(key);
      const v = held.get(key) ?? 0;
      if (best === null || v < bv) { best = s; bv = v; }
    }
    [x, y] = best!;
  } else {
    x = g!.x; y = g!.y;
  }
  k.where = { mode: SCHOOL, unit: null, x, y, fixture: g ? g.id : null };
  k.side = null;
  k.schooled = w.day;
}

function homeUnit(w: W.World, r: Res): number | null {
  const hh = F.household(w, r);
  return hh ? hh.unit : null;
}

function outAt(w: W.World, r: Res, f: { x: number; y: number }): void {
  r.where = { mode: "at", unit: homeUnit(w, r), x: f.x, y: f.y, fixture: null };
  r.side = null;
}

function meet(w: W.World, r: Res, meets: Record<string, number>): void {
  const full = R.engine.need_max! * R.engine.arrive_restore!;
  for (const [need, q] of Object.entries(meets)) {
    if (!(need in r.needs)) continue;
    const spec = R.needs[need]!;
    if (spec.roles !== undefined && !spec.roles.includes(r.role)) continue;
    r.needs[need] = Math.max(0.0, r.needs[need]! - full * q);
  }
}

export function begin(w: W.World, phase: string): void {
  const g = gate(w), s = stop(w);
  for (const rid of intKeys(w.residents)) {
    const r = w.residents[rid]!;
    const mode = r.where.mode;
    if (mode === AWAY) {
      if (s === null || !shift(w, r).includes(phase)) {
        outAt(w, r, { x: r.where.x, y: r.where.y });
      } else {
        meet(w, r, jobs().meets);
      }
    } else if (mode === SCHOOL) {
      if (law().hours.includes(phase) && schoolDay(w)) {
        meet(w, r, law().meets);
      } else if (!F.isYoung(r) || g === null) {
        outAt(w, r, g ?? { x: r.where.x, y: r.where.y });
      }
    }
  }
}

/** {guardian id: [children waiting at school]}, in Python dict order. */
export function collectors(w: W.World, phase: string): Map<number, Res[]> {
  const out = new Map<number, Res[]>();
  if (gate(w) === null || (law().hours.includes(phase) && schoolDay(w))) return out;
  for (const hid of intKeys(w.households)) {
    const hh = w.households[hid]!;
    const kids = F.youngIn(w, hh).filter((k) => k.where.mode === SCHOOL).sort((a, b) => a.id - b.id);
    if (!kids.length) continue;
    const here = F.members(w, hh)
      .filter((m) => F.isGuardian(m) && m.where.mode !== AWAY && m.where.mode !== SCHOOL)
      .sort((a, b) => a.id - b.id);
    if (!here.length) continue;
    const c = carer(w, hh);
    const who = c !== null && here.includes(c) ? c : here[0]!;
    out.set(who.id, kids);
  }
  return out;
}

export function duty(w: W.World, party: Res[], phase: string, fetch: readonly Res[]): Cand | null {
  const lead = party[0]!;
  const g = gate(w), s = stop(w);
  if (g !== null) {
    if (fetch.length) return { kind: "school", x: g.x, y: g.y, fixture: g, unit: null, duty: "pickup" };
    if (party.some((p) => dueAtSchool(w, p, phase))) {
      return { kind: "school", x: g.x, y: g.y, fixture: g, unit: null, duty: "run" };
    }
  }
  if (s !== null && party.length === 1 && commuting(w, lead, phase)) {
    return { kind: "bus_stop", x: s.x, y: s.y, fixture: s, unit: null, duty: "commute" };
  }
  return null;
}

export function arrive(w: W.World, party: Res[], c: Cand, phase: string, fetch: readonly Res[]): Res[] {
  const lead = party[0]!;
  if (c.duty === "commute") {
    const [x, y] = waitAt(w);
    lead.where = { mode: AWAY, unit: homeUnit(w, lead), x, y, fixture: null };
    lead.side = null;
    tally(c.fixture!);
    return [...party];
  }
  if (c.duty === "pickup") {
    for (const k of fetch) F.follow(k, lead);
    tally(c.fixture!);
    return [...party, ...fetch];
  }
  const stay: Res[] = [];
  for (const p of party) {
    if (dueAtSchool(w, p, phase)) {
      enter(w, p);
      tally(c.fixture!);
    } else {
      stay.push(p);
    }
  }
  return stay;
}

function tally(f: W.Fixture): void {
  f.uses_today = (f.uses_today ?? 0) + 1;
  f.use_total += 1;
}

// ------------------------------------------------------------- the census

export function roll(w: W.World) {
  const all = Object.values(w.residents);
  const pupils = all.filter(isPupil);
  const workers = all.filter((r) => isWorker(w, r));
  return {
    enrolled: pupils.length,
    in_today: pupils.filter((r) => r.schooled === w.day).length,
    in_now: pupils.filter((r) => r.where.mode === SCHOOL).length,
    workers: workers.length,
    away_now: workers.filter((r) => r.where.mode === AWAY).length,
  };
}

// ------------------------------------------------------- the day's record

export function overnight(w: W.World): void {
  for (const r of Object.values(w.residents)) {
    if (r.where.mode === AWAY || r.where.mode === SCHOOL) {
      const hh = F.household(w, r);
      const unit = hh ? w.units[String(hh.unit)] : undefined;
      if (unit === undefined) {
        const g = gate(w) ?? stop(w);
        outAt(w, r, g ?? r.where);
        continue;
      }
      const b = w.buildings[String(unit.building)]!;
      r.where = { mode: "in", unit: unit.id, x: b.door[0], y: b.door[1], fixture: null };
      r.side = null;
    }
  }
  w.day_phases = { day: w.day, phases: {} };
}

export const MODE_CODE: Record<string, string> = { in: "i", at: "a", [SCHOOL]: "s", [AWAY]: "w" };

export type PhaseSnap = Record<string, [number, number, string, number | null, number | null, number | null]>;

export function record(w: W.World, phase: string): void {
  let book = w.day_phases as { day: number; phases: Record<string, PhaseSnap> } | undefined | null;
  if (!book || book.day !== w.day) {
    book = { day: w.day, phases: {} };
    w.day_phases = book;
  }
  const snap: PhaseSnap = {};
  for (const rid of intKeys(w.residents)) {
    const r = w.residents[rid]!;
    const wh = r.where;
    snap[rid] = [wh.x, wh.y, MODE_CODE[wh.mode] ?? "a", wh.unit ?? null, wh.fixture ?? null, F.walkingWith(w, r)];
  }
  book.phases[phase] = snap;
}
