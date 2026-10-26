/**
 * Families: who minds the little ones — apps/estate/estate/engine/families.py.
 *
 * Children are never left without a trusted adult: every phase each group
 * of young children has exactly one minder, chosen from the guardians
 * already with them, and a household with children and no adult leaves
 * whole.
 */
import { R } from "../rules.ts";
import type * as W from "../world.ts";
import { moveOut } from "./households.ts";
import type { Ev } from "./events.ts";

type Res = W.Resident;
/** A candidate place: a fixture, or a flat ("home"). */
export interface Cand {
  kind: string; x: number; y: number;
  fixture: W.Fixture | null; unit: W.Unit | null; duty?: string;
}

export function law() { return R.families; }

export function isYoung(r: Res): boolean { return r.age < law().young_under; }
export function isGuardian(r: Res): boolean { return r.age >= law().guardian_from; }
export function isOlderChild(r: Res): boolean { return !isYoung(r) && !isGuardian(r); }

export function members(w: W.World, hh: W.Household): Res[] {
  const out: Res[] = [];
  for (const m of hh.members) {
    const r = w.residents[String(m)];
    if (r !== undefined) out.push(r);
  }
  return out;
}

export function household(w: W.World, r: Res): W.Household | null {
  return w.households[String(r.household)] ?? null;
}

export function guardiansOf(w: W.World, r: Res): Res[] {
  const hh = household(w, r);
  if (hh === null) return [];
  return members(w, hh).filter((g) => g !== r && isGuardian(g));
}

export function youngIn(w: W.World, hh: W.Household): Res[] {
  return members(w, hh).filter(isYoung);
}

export function hasYoung(w: W.World, r: Res): boolean {
  const hh = household(w, r);
  return hh !== null && youngIn(w, hh).length > 0;
}

export const OFF_PLAN = ["school", "away"];

export function atSchool(r: Res): boolean { return r.where.mode === "school"; }

export function together(a: Res, b: Res): boolean {
  const wa = a.where, wb = b.where;
  if (OFF_PLAN.includes(wa.mode) || OFF_PLAN.includes(wb.mode)) return false;
  if (wa.mode === "in" || wb.mode === "in") {
    return wa.mode === "in" && wb.mode === "in" && (wa.unit ?? null) === (wb.unit ?? null);
  }
  return Math.max(Math.abs(wa.x - wb.x), Math.abs(wa.y - wb.y)) <= law().near;
}

/** dict(minder["where"], fixture=None): a copy, never a shared object. */
export function follow(child: Res, minder: Res): void {
  child.where = { ...minder.where, fixture: null };
  child.side = null;
}

export function unattended(w: W.World): [Res, W.Household][] {
  const out: [Res, W.Household][] = [];
  for (const hh of Object.values(w.households)) {
    for (const k of youngIn(w, hh)) {
      if (atSchool(k)) continue;
      if (!guardiansOf(w, k).some((g) => together(k, g))) out.push([k, hh]);
    }
  }
  return out;
}

const byId = (a: Res, b: Res) => a.id - b.id;
/** sorted(dict): a plain object's integer keys come out of Object.keys
 * already ascending (see W.ids) */
const sortedIntKeys = (o: Record<string, unknown>): string[] => Object.keys(o);

/** Who minds whom this phase: Map of minder id to children, in insertion
 * order (Python dict order). */
export function plan(
  w: W.World, press: (g: Res) => number, busy: ((g: Res) => boolean) | null = null,
): Map<number, Res[]> {
  const leads = new Map<number, Res[]>();
  for (const hid of sortedIntKeys(w.households)) {
    const hh = w.households[hid]!;
    const kids = youngIn(w, hh).sort(byId);
    if (!kids.length) continue;
    const guards = members(w, hh).filter(isGuardian).sort(byId);
    if (!guards.length) continue;
    for (const k of kids) {
      const near = guards.filter((g) => together(k, g));
      if (!near.length) continue;
      // min() evaluates the key of every element, in order
      let m: Res | null = null;
      let mk: [number, number, number] | null = null;
      for (const g of near) {
        const key: [number, number, number] = [busy !== null && busy(g) ? 1 : 0, press(g), g.id];
        if (mk === null || cmpTuple(key, mk) < 0) { m = g; mk = key; }
      }
      const list = leads.get(m!.id);
      if (list) list.push(k); else leads.set(m!.id, [k]);
    }
  }
  return leads;
}

export function cmpTuple(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return a.length - b.length;
}

export function walkingWith(w: W.World, r: Res): number | null {
  if (r.where.mode !== "at" || !isYoung(r)) return null;
  const near = guardiansOf(w, r).filter((g) => together(r, g));
  if (!near.length) return null;
  const wx = r.where.x, wy = r.where.y;
  let best: Res | null = null;
  let bk: [number, number] | null = null;
  for (const g of near) {
    const key: [number, number] = [Math.max(Math.abs(g.where.x - wx), Math.abs(g.where.y - wy)), g.id];
    if (bk === null || cmpTuple(key, bk) < 0) { best = g; bk = key; }
  }
  return best!.id;
}

export function settle(w: W.World, evs: Ev[] | null = null): number {
  const adult = R.people.ages.adult;
  for (const hid of sortedIntKeys(w.households)) {
    const hh = w.households[hid];
    if (hh === undefined) continue;
    const folk = members(w, hh);
    const kids = folk.filter((r) => r.age < adult);
    if (kids.length && !folk.some((r) => r.age >= adult)) leave(w, hh, evs);
  }
  let mended = 0;
  const un = unattended(w).sort((a, b) => a[0].id - b[0].id);
  for (const [k, hh] of un) {
    const guards = guardiansOf(w, k);
    if (!guards.length) continue;
    if (guards.some((g) => together(k, g))) continue;
    const home = guards.filter((g) => g.where.mode === "in" && (g.where.unit ?? null) === hh.unit);
    if (home.length) {
      k.where = { mode: "in", unit: hh.unit, x: k.where.x, y: k.where.y, fixture: null };
    } else {
      // max(guards, key=(age, -id)): the first of the maxima
      let g = guards[0]!;
      for (const c of guards.slice(1)) {
        if (cmpTuple([c.age, -c.id], [g.age, -g.id]) > 0) g = c;
      }
      g.where = { mode: "in", unit: hh.unit, x: g.where.x, y: g.where.y, fixture: null };
      g.side = null;
      follow(k, g);
    }
    mended += 1;
  }
  return mended;
}

function leave(w: W.World, hh: W.Household, evs: Ev[] | null): void {
  const folk = members(w, hh);
  if (evs !== null) {
    evs.push({
      day: w.day, kind: "left",
      who: folk.length ? `the ${pyStr(folk[0]!.name)} household` : `a ${hh.kind}`,
      what: "the children go to family elsewhere",
    });
  }
  moveOut(w, hh, "the children went to family elsewhere");
}

/** str() of a name that may be None. */
export function pyStr(v: unknown): string {
  return v === null || v === undefined ? "None" : String(v);
}

// ------------------------------------------------------------ what's allowed

function distHome(w: W.World, r: Res, c: { x: number; y: number }): number {
  const hh = household(w, r);
  const u = hh ? w.units[String(hh.unit)] : undefined;
  if (u === undefined) return 0;
  const door = w.buildings[String(u.building)]!.door;
  return Math.abs(c.x - door[0]) + Math.abs(c.y - door[1]);
}

export function reachMatters(phase: string): boolean { return phase === "evening"; }

export function allows(
  w: W.World, r: Res, c: Cand, phase: string, minding: boolean,
  reach: ((c: Cand) => boolean) | null = null,
): boolean {
  if (c.kind === "home") return true;
  const f = law();
  if (f.home_by.includes(phase) && (minding || hasYoung(w, r))) return false;
  if (minding && reachMatters(phase)) {
    return distHome(w, r, c) <= f.evening_range && (reach === null || reach(c));
  }
  if (isOlderChild(r)) {
    return f.older_daytime.includes(phase) && f.older_places.includes(c.kind) &&
      distHome(w, r, c) <= f.older_range;
  }
  return true;
}

export function curfew(w: W.World, r: Res, phase: string, minding: boolean): boolean {
  const f = law();
  if (f.home_by.includes(phase) && (minding || hasYoung(w, r))) return true;
  if (minding && reachMatters(phase) && r.where.mode === "at" && distHome(w, r, r.where) > f.evening_range) {
    return true;
  }
  return isOlderChild(r) && !f.older_daytime.includes(phase);
}

export function sureHome(w: W.World, r: Res, phase: string, minding: boolean): boolean {
  return curfew(w, r, phase, minding) || (minding && reachMatters(phase));
}
