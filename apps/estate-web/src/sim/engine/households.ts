/**
 * The households — apps/estate/estate/engine/households.py.
 *
 * PR 1 ports the mechanics gen needs (a household taking a flat). The
 * slow layer — ageing, births, deaths, turnover, the letting office — comes
 * with the tick.
 */
import type { PyRandom } from "../../py/random.ts";
import { R } from "../rules.ts";
import * as W from "../world.ts";

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
