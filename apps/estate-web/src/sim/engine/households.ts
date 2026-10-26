/**
 * The households — apps/estate/estate/engine/households.py.
 *
 * The slow layer, once a day: ageing, births and deaths on the turn of the
 * year; unhappiness, emigration, turnover, the waiting list and the letting
 * office every day; and last, `families.settle`.
 */
import type { PyRandom } from "../../py/random.ts";
import { R } from "../rules.ts";
import * as W from "../world.ts";
import type { Ev } from "./events.ts";
import { settle } from "./families.ts";

/** A household takes a flat and its people are made. */
export function moveIn(
  w: W.World, kind: string, unit: W.Unit, rng: PyRandom, day?: number,
): W.Household {
  const spec = R.households[kind]!;
  const hid = w.next_id; w.next_id += 1;
  const hh = W.newHousehold(hid, kind, unit.id);
  hh.moved_in = day === undefined ? w.day : day;
  unit.household = hid;
  unit.vacant_since = null;
  const [lo, hi] = spec.members;
  const n = rng.randint(lo, hi);
  const [clo, chi] = spec.children;
  let kids = chi ? rng.randint(clo, chi) : 0;
  kids = Math.min(kids, Math.max(0, n - 1));
  for (let i = 0; i < n; i++) {
    const rid = w.next_id; w.next_id += 1;
    const age = kids > 0 ? rng.randint(2, 16) : rng.randint(19, 78);
    if (kids > 0) kids -= 1;
    const r = W.newResident(rid, hid, age);
    r.name = W.nameFor(rng);
    r.where.unit = unit.id;
    r.mobility = spec.mobility ?? 1.0;
    w.residents[String(rid)] = r;
    hh.members.push(rid);
  }
  w.households[String(hid)] = hh;
  return hh;
}

/** A household leaves: its people go, and its flat stands empty from today. */
export function moveOut(w: W.World, hh: W.Household, why: string): string {
  const unit = w.units[String(hh.unit)];
  for (const rid of [...hh.members]) delete w.residents[String(rid)];
  hh.members = [];
  if (unit !== undefined && unit.household === hh.id) {
    unit.household = null;
    unit.vacant_since = w.day;
  }
  delete w.households[String(hh.id)];
  return why;
}

export function householdOf(w: W.World, r: W.Resident): W.Household | undefined {
  return w.households[String(r.household)];
}

export function membersOf(w: W.World, hh: W.Household): W.Resident[] {
  const out: W.Resident[] = [];
  for (const m of hh.members) {
    const r = w.residents[String(m)];
    if (r !== undefined) out.push(r);
  }
  return out;
}

// ------------------------------------------------------------------ ageing

export function agePeople(w: W.World, evs: Ev[]): void {
  for (const r of Object.values(w.residents)) {
    r.age += 1;
    const was = r.role;
    r.role = W.roleOf(r.age);
    if (r.role !== was) {
      evs.push({
        day: w.day, kind: "grew", who: r.name || "someone",
        what: r.role === "adult" ? "a child becomes an adult" : "an adult becomes an elder",
      });
    }
  }
}

export function oldAge(w: W.World, evs: Ev[]): void {
  const p = R.pop.death_prob ?? 0.0;
  if (!p) return;
  const a = R.people.ages;
  const rng = W.rngFor(w.seed, w.day, "death");
  for (const hh of Object.values(w.households)) {
    for (const r of membersOf(w, hh)) {
      if (r.role !== "elder" || r.age < a.elder + 8) continue;
      if (rng.random() >= p) continue;
      evs.push({ day: w.day, kind: "died", who: r.name || "someone" });
      const i = hh.members.indexOf(r.id);
      if (i < 0) throw new Error(`list.remove(x): x not in list (resident ${r.id})`);
      hh.members.splice(i, 1);
      delete w.residents[String(r.id)];
      if (!hh.members.length) moveOut(w, hh, "the last of the household died");
    }
  }
}

export function births(w: W.World, evs: Ev[]): void {
  const p = R.pop.birth_prob ?? 0.0;
  if (!p) return;
  const rng = W.rngFor(w.seed, w.day, "birth");
  for (const hh of Object.values(w.households)) {
    if (!["family", "couple", "flat_share"].includes(hh.kind)) continue;
    const unit = w.units[String(hh.unit)];
    if (unit === undefined || unit.household !== hh.id) continue;
    if (hh.members.length >= unit.capacity * R.pop.crowding) continue;
    if (rng.random() >= p) continue;
    const rid = w.next_id; w.next_id += 1;
    const r = W.newResident(rid, hh.id, 0);
    r.name = W.nameFor(rng);
    r.where.unit = unit.id;
    w.residents[String(rid)] = r;
    hh.members.push(rid);
    evs.push({ day: w.day, kind: "born", who: r.name, where: hh.kind });
  }
}

// ------------------------------------------------------------- unhappiness

export function unhappiness(w: W.World): void {
  const rise = R.pop.unhappy_rise ?? 0.5;
  const decay = R.pop.unhappy_decay ?? 0.97;
  for (const hh of Object.values(w.households)) {
    const folk = membersOf(w, hh);
    if (!folk.length) continue;
    const frayed = folk.filter((r) => r.stress >= 1.0).length / folk.length;
    hh.unhappy = hh.unhappy * decay + frayed * rise;
  }
}

export function emigration(w: W.World, evs: Ev[]): void {
  const line = R.pop.emigrate_at ?? 3.0;
  for (const hh of Object.values(w.households)) {
    if (hh.unhappy < line) continue;
    const who = membersOf(w, hh);
    evs.push({
      day: w.day, kind: "left", who: who.length ? who[0]!.name : "a household",
      what: `a ${hh.kind} leaves the estate`,
    });
    moveOut(w, hh, "unhappy");
  }
}

// ----------------------------------------------------------- letting office

export function wantKind(w: W.World): string | null {
  const shape = R.gen.founding ?? {};
  let total = 0;
  for (const v of Object.values(shape)) total += v;
  total = total || 1;
  const target = (R.pop.fill_to ?? 0.8) * Object.keys(w.units).length;
  const have = W.counts(w);
  const need: Record<string, number> = {};
  for (const k of R.pop.roster) need[k] = ((shape[k] ?? 0) / total) * target - (have[k] ?? 0);
  const names = Object.keys(need).sort();
  let best = names[0]!;
  for (const k of names.slice(1)) if (need[k]! > need[best]!) best = k;
  return need[best]! > 0.5 ? best : null;
}

export function turnover(w: W.World, evs: Ev[]): void {
  const p = R.pop.move_away_prob ?? 0.0;
  if (!p) return;
  const rng = W.rngFor(w.seed, w.day, "turnover");
  for (const hh of Object.values(w.households)) {
    if (rng.random() >= p) continue;
    const folk = membersOf(w, hh);
    evs.push({
      day: w.day, kind: "left",
      who: folk.length ? `the ${folk[0]!.name === null ? "None" : folk[0]!.name} household` : `a ${hh.kind}`,
    });
    moveOut(w, hh, "moved away");
  }
}

export function lettingOffice(w: W.World, evs: Ev[]): void {
  const after = R.pop.letting_after;
  const rng = W.rngFor(w.seed, w.day, "letting");
  const vacant = Object.values(w.units).filter((u) => u.household === null);
  for (const u of vacant) if (u.vacant_since === null) u.vacant_since = w.day;
  const due = vacant.filter((u) => w.day - (u.vacant_since || w.day) >= after);
  if (!due.length) return;
  const kind = wantKind(w);
  if (kind === null) return;
  const pick = w.waiting.findIndex((c) => c.kind === kind);
  if (pick >= 0) w.waiting.splice(pick, 1);
  const flat = due[rng.randrange(due.length)]!;
  moveIn(w, kind, flat, rng, w.day);
  evs.push({ day: w.day, kind: "moved_in", where: kind, flat: flat.id });
}

export function arrivals(w: W.World): { kind: string } | undefined {
  const size = R.pop.waiting_size ?? 6;
  if (w.waiting.length >= size) return undefined;
  const rng = W.rngFor(w.seed, w.day, "arrive");
  w.waiting.push({ kind: rng.choice(R.pop.roster) });
  return w.waiting[w.waiting.length - 1];
}

// -------------------------------------------------------------- conductor

export function updateHouseholds(w: W.World, evs: Ev[]): void {
  if (w.day % (R.world.days_per_season * 4) === 0) {
    agePeople(w, evs);
    oldAge(w, evs);
    births(w, evs);
  }
  unhappiness(w);
  emigration(w, evs);
  turnover(w, evs);
  arrivals(w);
  lettingOffice(w, evs);
  settle(w, evs);
}
