/**
 * The people: what they want, where they go, and what it costs them —
 * apps/estate/estate/engine/residents.py.
 */
import type { PyRandom } from "../../py/random.ts";
import { R } from "../rules.ts";
import * as W from "../world.ts";
import * as D from "./daytime.ts";
import * as F from "./families.ts";
import type { Cand } from "./families.ts";
import * as P from "./places.ts";
import { wetness } from "./weather.ts";
import type { Ev } from "./events.ts";

type Res = W.Resident;
export const PHASES = ["dawn", "morning", "afternoon", "evening", "night"] as const;

/** Called as watcher(w, phase) once every resident has settled a phase. */
export const PHASE_WATCHERS: ((w: W.World, phase: string) => void)[] = [];

/**
 * The two seams tools/balance.py patches in Python (`residents.ranked_needs`
 * and `residents._satisfy` are module globals there). Hooks observe; they
 * cannot change what the engine does.
 */
export const HOOKS: {
  ranked: ((w: W.World, r: Res, phase: string, out: string[]) => void) | null;
  satisfy: ((w: W.World, r: Res, c: Cand, need: string, phase: string) => void) | null;
} = { ranked: null, satisfy: null };

function intKeys(o: Record<string, unknown>): string[] {
  return Object.keys(o).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

function pos(w: W.World, r: Res): [number, number] {
  if (r.where.mode === "in") {
    const u = w.units[String(r.where.unit)]!;
    const b = w.buildings[String(u.building)]!;
    return [b.door[0], b.door[1]];
  }
  return [r.where.x, r.where.y];
}

function unitOf(w: W.World, r: Res): W.Unit | null {
  let uid = r.where.unit ?? null;
  if (uid === null) {
    const h = w.households[String(r.household)];
    uid = h ? h.unit : null;
  }
  return uid !== null ? (w.units[String(uid)] ?? null) : null;
}

export type Cands = Record<string, Cand[]>;

export function candidates(w: W.World): Cands {
  const out: Cands = {};
  for (const n of Object.keys(R.needs)) out[n] = [];
  for (const f of Object.values(w.fixtures)) {
    if (f.condition <= 0) continue;
    const affords = R.fixtures[f.kind]!.affords;
    if (affords.food && (f.stock ?? 1) <= 0) continue;
    for (const [need, q] of Object.entries(affords)) {
      if (q > 0) out[need]!.push({ kind: f.kind, x: f.x, y: f.y, fixture: f, unit: null });
    }
  }
  for (const u of Object.values(w.units)) {
    if (u.household === null) continue;
    const b = w.buildings[String(u.building)]!;
    for (const [need, spec] of Object.entries(R.needs)) {
      if (!spec.home) continue;
      out[need]!.push({ kind: "home", x: b.door[0], y: b.door[1], fixture: null, unit: u });
    }
  }
  return out;
}

export function phaseMult(need: string, phase: string): number {
  return R.needs[need]!.phases?.[phase] ?? 1.0;
}

export function weekMult(need: string, day: number): number {
  if (W.weekday(day) < 5) return 1.0;
  return R.needs[need]!.weekend ?? 1.0;
}

function drainsOf(w: W.World, r: Res): Record<string, number> {
  const kind = w.households[String(r.household)]?.kind ?? "";
  return R.households[kind]?.drains ?? {};
}

export function pressure(w: W.World, r: Res, need: string, phase: string): number {
  const spec = R.needs[need]!;
  if (spec.roles !== undefined && !spec.roles.includes(r.role)) return 0.0;
  const mult = drainsOf(w, r)[need] ?? 1.0;
  let p = spec.urge * r.needs[need]! * phaseMult(need, phase) * weekMult(need, w.day) * mult;
  if (!spec.home) p *= R.weather.outdoor[w.weather] ?? 1.0;
  return p;
}

function rankedNeedsBase(w: W.World, r: Res, phase: string): string[] {
  const floor = R.engine.urge_floor!;
  const ranked: [number, string][] = [];
  for (const n of Object.keys(R.needs)) {
    const p = pressure(w, r, n, phase);
    if (p > floor) ranked.push([p, n]);
  }
  ranked.sort((a, b) => F.cmpTuple([-a[0], a[1]], [-b[0], b[1]]));
  return ranked.map(([, n]) => n);
}

export function rankedNeeds(w: W.World, r: Res, phase: string): string[] {
  const out = rankedNeedsBase(w, r, phase);
  if (HOOKS.ranked) HOOKS.ranked(w, r, phase, out);
  return out;
}

function utility(w: W.World, r: Res, c: Cand, need: string, phase: string, rng: PyRandom): number | null {
  const [px, py] = pos(w, r);
  const unit = unitOf(w, r);
  const inside = r.where.mode === "in";
  const stair = R.engine.stair_step!;
  let eff: number;
  let cost: number;
  if (c.kind === "home") {
    if (unit === null || c.unit!.id !== unit.id) return null;
    eff = R.engine.home_rest! * c.unit!.condition;
    eff *= 1.0 + 0.35 * wetness(w);
    if (need === "quiet") eff *= Math.max(0.05, 1.0 - P.unitNoise(w, c.unit!));
    cost = 0.0;
  } else {
    const f = c.fixture!;
    if (P.full(c.kind, f.occupants)) return null;
    eff = P.effective(c.kind, need, f.condition, f.occupants.length, f);
    const wet = wetness(w);
    if (wet) eff *= 1.0 - 0.45 * wet;
    const shade = w.cells[f.y]![f.x]!.shade;
    if (w.weather === "heat") eff *= 1.0 + 0.8 * shade;
    if (need === "quiet") eff *= 0.4 + 0.6 * shade;
    if (phase === "evening" || phase === "night") eff *= 1.0 + 0.7 * w.cells[f.y]![f.x]!.light;
    const d = Math.abs(c.x - px) + Math.abs(c.y - py);
    if (d > R.engine.scan!) return null;
    cost = d * R.engine.travel_cost! + (inside && unit ? unit.floor * stair : 0);
  }
  const habit = r.habit[phase] === c.kind ? R.engine.habit_bonus! : 0.0;
  return eff - cost + habit + rng.random() * R.engine.whim!;
}

// the eight ways a step can go, in the order a tie is broken
const STEPS: readonly [number, number][] = [
  [0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1],
];

/** A cell's key; cells one off the plan (all a search can reach) stay distinct. */
function ck(w: W.World, x: number, y: number): number {
  return (y + 2) * (w.width + 4) + (x + 2);
}

type Pt = [number, number];

export function path(w: W.World, sx: number, sy: number, tx: number, ty: number): Pt[] | null {
  if (sx === tx && sy === ty) return [];
  const came = new Map<number, Pt | null>();
  came.set(ck(w, sx, sy), null);
  let frontier: Pt[] = [[sx, sy]];
  while (frontier.length) {
    const nxt: Pt[] = [];
    for (const [cx, cy] of frontier) {
      for (const [ox, oy] of STEPS) {
        const nx = cx + ox, ny = cy + oy;
        const k = ck(w, nx, ny);
        if (came.has(k)) continue;
        const isT = nx === tx && ny === ty;
        if (!isT && !W.passable(w, nx, ny)) continue;
        came.set(k, [cx, cy]);
        if (isT) {
          const out: Pt[] = [];
          let n: Pt = [nx, ny];
          while (!(n[0] === sx && n[1] === sy)) {
            out.push(n);
            n = came.get(ck(w, n[0], n[1]))!;
          }
          out.reverse();
          return out;
        }
        nxt.push([nx, ny]);
      }
    }
    frontier = nxt;
  }
  return null;
}

export function reach(w: W.World, sx: number, sy: number, limit: number | null = null): Map<number, number> {
  const dist = new Map<number, number>();
  dist.set(ck(w, sx, sy), 0);
  let frontier: Pt[] = [[sx, sy]];
  let d = 0;
  while (frontier.length && (limit === null || d < limit)) {
    d += 1;
    const nxt: Pt[] = [];
    for (const [cx, cy] of frontier) {
      for (const [ox, oy] of STEPS) {
        const nx = cx + ox, ny = cy + oy;
        const k = ck(w, nx, ny);
        if (dist.has(k)) continue;
        dist.set(k, d);
        if (W.passable(w, nx, ny)) nxt.push([nx, ny]);
      }
    }
    frontier = nxt;
  }
  return dist;
}

function followPath(r: Res, p: Pt[], steps: number): boolean {
  for (const [x, y] of p.slice(0, Math.max(0, steps))) {
    r.where.x = x; r.where.y = y;
  }
  return p.length <= steps;
}

/** Python's path[steps:] for any int steps. */
function tail<T>(xs: T[], steps: number): T[] {
  return steps >= 0 ? xs.slice(steps) : xs.slice(Math.max(0, xs.length + steps));
}

function hold(r: Res, tx: number, ty: number, p: Pt[], steps: number): void {
  const rest = tail(p, steps);
  r.side = rest.length ? { to: [tx, ty], path: rest.map((q) => [q[0], q[1]]) } : null;
}

function routeWalk(w: W.World, r: Res, tx: number, ty: number, steps: number): boolean {
  r.side = null;
  const p = path(w, r.where.x, r.where.y, tx, ty);
  if (p === null) return false;
  return followPath(r, p, steps);
}

function walk(w: W.World, r: Res, tx: number, ty: number, steps: number): boolean {
  const held = r.side as { to?: unknown; path?: number[][] } | null | undefined;
  r.side = null;
  if (held !== null && typeof held === "object" && !Array.isArray(held)) {
    const to = held.to as number[] | undefined;
    if (Array.isArray(to) && to.length === 2 && to[0] === tx && to[1] === ty && held.path && held.path.length) {
      const p = held.path.map((q) => [q[0]!, q[1]!] as Pt);
      const wx = r.where.x, wy = r.where.y;
      if (Math.max(Math.abs(p[0]![0] - wx), Math.abs(p[0]![1] - wy)) === 1) {
        hold(r, tx, ty, p, steps);
        return followPath(r, p, steps);
      }
    }
  }
  for (let n = 0; n < steps; n++) {
    const wx = r.where.x, wy = r.where.y;
    if (wx === tx && wy === ty) return true;
    const dx = Number(tx > wx) - Number(tx < wx);
    const dy = Number(ty > wy) - Number(ty < wy);
    const forward: Pt[] = [];
    if (dx && dy) forward.push([wx + dx, wy + dy]);
    if (dx) forward.push([wx + dx, wy]);
    if (dy) forward.push([wx, wy + dy]);
    const keyed = forward.map((q) => ({ q, k: W.walkCost(w, q[0], q[1]) || 99 }));
    keyed.sort((a, b) => a.k - b.k);
    let moved = false;
    for (const { q: [cx, cy] } of keyed) {
      if (W.passable(w, cx, cy)) {
        r.where.x = cx; r.where.y = cy;
        moved = true;
        break;
      }
    }
    if (!moved) {
      const p = path(w, wx, wy, tx, ty);
      if (p === null) return false;
      hold(r, tx, ty, p, steps - n);
      return followPath(r, p, steps - n);
    }
  }
  return r.where.x === tx && r.where.y === ty;
}

function setOff(w: W.World, r: Res, budget: number | null = null): [number, number, number] | null {
  let b0 = budget === null ? R.engine.steps_per_phase! * r.mobility : budget;
  if (r.where.mode !== "in") return [r.where.x, r.where.y, Math.max(1, Math.trunc(b0))];
  const unit = unitOf(w, r);
  if (unit === null) return null;
  const b = w.buildings[String(unit.building)]!;
  b0 -= unit.floor * R.engine.stair_step! * W.stairMult(w, b);
  if (b0 <= 0) return null;
  return [b.door[0], b.door[1], Math.max(1, Math.trunc(b0))];
}

function goTo(
  w: W.World, r: Res, c: Cand,
  opts: { route?: boolean; sure?: boolean; budget?: number | null } = {},
): boolean {
  r.where.fixture = null;
  const off = setOff(w, r, opts.budget ?? null);
  if (off === null) return false;
  const [sx, sy, budget] = off;
  if (r.where.mode === "in") {
    const unit = unitOf(w, r)!;
    r.where = { mode: "at", unit: unit.id, x: sx, y: sy, fixture: null };
  }
  let arrived: boolean;
  if (opts.sure) arrived = routeWalk(w, r, c.x, c.y, w.width * w.height);
  else if (opts.route || c.duty) arrived = routeWalk(w, r, c.x, c.y, budget);
  else arrived = walk(w, r, c.x, c.y, budget);
  if (!arrived) return false;
  if (c.kind === "home") {
    r.where.mode = "in";
    r.where.unit = c.unit!.id;
  }
  return true;
}

function satisfyBase(w: W.World, r: Res, c: Cand, need: string, phase: string): void {
  r.habit[phase] = c.kind;
  const full = R.engine.need_max! * R.engine.arrive_restore!;
  if (c.kind === "home") {
    r.needs[need] = Math.max(0.0, r.needs[need]! - full * R.engine.home_rest!);
    return;
  }
  const f = c.fixture!;
  const restore = full * P.baseQuality(f.kind, need, f);
  r.needs[need] = Math.max(0.0, r.needs[need]! - restore);
  r.where.fixture = f.id;
  f.occupants.push(r.id);
  f.uses_today = (f.uses_today ?? 0) + 1;
  f.use_total += 1;
  if (w.daybook) {
    const u = w.daybook.uses;
    u[f.kind] = (u[f.kind] ?? 0) + 1;
  }
  if (need === "food" && f.stock !== undefined && f.stock !== null && f.stock > 0) {
    f.stock -= 1;
    if (f.stock <= 0 && w.daybook) w.daybook.sold_out = true;
  }
}

export function satisfy(w: W.World, r: Res, c: Cand, need: string, phase: string): void {
  if (HOOKS.satisfy) HOOKS.satisfy(w, r, c, need, phase);
  satisfyBase(w, r, c, need, phase);
}

export function drain(w: W.World, _phase: string): void {
  const top = R.engine.need_max!;
  for (const r of Object.values(w.residents)) {
    const drains = drainsOf(w, r);
    for (const [need, spec] of Object.entries(R.needs)) {
      if (spec.roles !== undefined && !spec.roles.includes(r.role)) continue;
      if (spec.from === "noise") {
        let noise: number;
        if (r.where.mode === "in") {
          const unit = unitOf(w, r);
          noise = unit ? P.unitNoise(w, unit) : 0.0;
        } else if (r.where.mode === D.AWAY) {
          noise = 0.0;
        } else {
          noise = w.cells[r.where.y]![r.where.x]!.noise;
        }
        r.needs[need] = r.needs[need]! + noise * R.engine.quiet_gain!;
      } else {
        r.needs[need] = r.needs[need]! + spec.rate * (drains[need] ?? 1.0);
      }
      r.needs[need] = Math.min(top, r.needs[need]!);
    }
  }
}

function heldFixture(w: W.World, r: Res): W.Fixture | null {
  const where = r.where;
  const fid = where.fixture ?? null;
  if (where.mode !== "at" || fid === null) return null;
  const f = w.fixtures[String(fid)];
  if (f === undefined || f.x !== where.x || f.y !== where.y) return null;
  return f;
}

function seatHolders(w: W.World): void {
  for (const f of Object.values(w.fixtures)) f.occupants = [];
  for (const rid of intKeys(w.residents)) {
    const r = w.residents[rid]!;
    const f = heldFixture(w, r);
    if (f !== null) f.occupants.push(r.id);
  }
}

export function topPress(w: W.World, r: Res, phase: string): number {
  let m = -Infinity;
  const needs = Object.keys(R.needs);
  if (!needs.length) return 0.0;
  for (const n of needs) {
    const p = pressure(w, r, n, phase);
    if (p > m || Number.isNaN(p)) m = p;
  }
  return m;
}

function homeOf(w: W.World, r: Res, cand: Cands, phase: string): [Cand | null, string | null] {
  const unit = unitOf(w, r);
  if (unit === null) return [null, null];
  let best: [number, Cand, string] | null = null;
  for (const [need, spec] of Object.entries(R.needs)) {
    if (!spec.home) continue;
    for (const c of cand[need] ?? []) {
      if (c.kind === "home" && c.unit!.id === unit.id) {
        const p = pressure(w, r, need, phase);
        if (best === null || p > best[0]) best = [p, c, need];
      }
    }
  }
  return best ? [best[1], best[2]] : [null, null];
}

function choose(
  w: W.World, party: Res[], cand: Cands, phase: string, rng: PyRandom,
  wanted: Map<number, string[]> | null = null,
): [Cand | null, string | null, Res | null] {
  const lead = party[0]!;
  const minding = party.length > 1;
  const ranked = new Map<number, string[]>();
  for (const p of party) ranked.set(p.id, rankedNeeds(w, p, phase));
  if (wanted !== null) for (const [k, v] of ranked) wanted.set(k, v);
  const wants: [number, string, Res][] = [];
  for (const p of party) for (const n of ranked.get(p.id)!) wants.push([pressure(w, p, n, phase), n, p]);
  wants.sort((a, b) => F.cmpTuple([-a[0], a[1], a[2].id], [-b[0], b[1], b[2].id]));
  let reachFn: ((c: Cand) => boolean) | null = null;
  if (minding && F.reachMatters(phase)) {
    const off = setOff(w, lead);
    if (off !== null) {
      const [sx, sy, budget] = off;
      const dist = reach(w, sx, sy, budget);
      reachFn = (c) => dist.has(ck(w, c.x, c.y));
    } else {
      reachFn = () => false;
    }
  }
  for (const [, need, p] of wants) {
    let best: Cand | null = null;
    let bestU: number | null = null;
    for (const c of cand[need] ?? []) {
      if (!F.allows(w, lead, c, phase, minding, reachFn)) continue;
      const u = utility(w, p, c, need, phase, rng);
      if (u !== null && (bestU === null || u > bestU)) { best = c; bestU = u; }
    }
    if (best !== null) return [best, need, p];
  }
  return [null, null, null];
}

function also(w: W.World, r: Res, c: Cand, phase: string, ranked: string[] | undefined): string | null {
  const list = ranked ?? rankedNeeds(w, r, phase);
  for (const need of list) {
    if (c.kind === "home") {
      if (R.needs[need]!.home) return need;
      continue;
    }
    const f = c.fixture!;
    if ((R.fixtures[f.kind]!.affords[need] ?? 0) > 0) return P.full(f.kind, f.occupants) ? null : need;
  }
  return null;
}

function fray(r: Res, line: number): void {
  let frayed = -Infinity;
  for (const [n, spec] of Object.entries(R.needs)) {
    if (!spec.roles || !spec.roles.length || spec.roles.includes(r.role)) {
      const v = r.needs[n]!;
      if (v > frayed) frayed = v;
    }
  }
  if (frayed >= line) r.stress += 1.0;
  else r.stress *= R.engine.stress_decay!;
}

function live(w: W.World, party: Res[], cand: Cands, phase: string, line: number, fetch: readonly Res[]): void {
  const r = party[0]!;
  const minding = party.length > 1;
  const held: [Res, W.Fixture | null][] = [];
  for (const p of party) {
    const h = heldFixture(w, p);
    if (h !== null) {
      const i = h.occupants.indexOf(p.id);
      if (i < 0) throw new Error(`list.remove(x): x not in list (resident ${p.id})`);
      h.occupants.splice(i, 1);
    }
    held.push([p, h]);
  }
  const dt = D.duty(w, party, phase, fetch);
  if (dt !== null) {
    const arrived = goTo(w, r, dt, { budget: R.engine.scan! });
    for (const k of party.slice(1)) F.follow(k, r);
    if (arrived) party = D.arrive(w, party, dt, phase, fetch);
    for (const p of party) fray(p, line);
    return;
  }
  const rng = W.rngFor(w.seed, w.day, `whim:${r.id}:${phase}`);
  const wanted = new Map<number, string[]>();
  let [best, needOf, who] = choose(w, party, cand, phase, rng, wanted);
  if (best === null && r.where.mode === "at" && F.curfew(w, r, phase, minding)) {
    [best, needOf] = homeOf(w, r, cand, phase);
    who = r;
  }
  if (best === null) {
    const full = R.engine.need_max! * R.engine.arrive_restore!;
    for (const [p, h] of held) {
      p.needs.rest = Math.max(0.0, p.needs.rest! - full * R.engine.home_rest!);
      if (h !== null) h.occupants.push(p.id);
    }
    return;
  }
  const home = best.kind === "home";
  const sure = home && F.sureHome(w, r, phase, minding);
  const route = minding && F.reachMatters(phase);
  const arrived = goTo(w, r, best, { route, sure });
  for (const k of party.slice(1)) F.follow(k, r);
  if (arrived) {
    satisfy(w, who!, best, needOf!, phase);
    for (const p of party) {
      if (p !== who) {
        const a = also(w, p, best, phase, wanted.get(p.id));
        if (a !== null) satisfy(w, p, best, a, phase);
      }
    }
  }
  for (const p of party) fray(p, line);
}

export function updateResidents(w: W.World, evs: Ev[]): void {
  const cand = candidates(w);
  const line = R.engine.stress_at!;
  D.overnight(w);
  F.settle(w, evs);
  for (const phase of PHASES) {
    drain(w, phase);
    D.begin(w, phase);
    seatHolders(w);
    const leads = F.plan(w, (g) => topPress(w, g, phase), (g) => D.busy(w, g, phase));
    const led = new Set<number>();
    for (const ks of leads.values()) for (const k of ks) led.add(k.id);
    const fetch = D.collectors(w, phase);
    for (const rid of intKeys(w.residents)) {
      const r = w.residents[rid];
      if (r === undefined || led.has(r.id)) continue;
      if (F.OFF_PLAN.includes(r.where.mode)) {
        fray(r, line);
        continue;
      }
      const got = fetch.get(r.id) ?? [];
      live(w, [r, ...(leads.get(r.id) ?? [])], cand, phase, line, got);
      for (const k of got) led.add(k.id);
    }
    for (const f of Object.values(w.fixtures)) f.occupants = [];
    if (w.daybook) {
      let out = 0;
      for (const x of Object.values(w.residents)) if (x.where.mode === "at") out++;
      w.daybook.out = Math.max(w.daybook.out, out);
    }
    D.record(w, phase);
    for (const watch of PHASE_WATCHERS) watch(w, phase);
  }
}
