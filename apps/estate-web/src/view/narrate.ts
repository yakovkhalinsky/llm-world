/**
 * The watcher's why, without a model (the chronicle follows).
 *
 * In apps/estate a model writes one sentence on why the watcher sent what
 * it sent (watcher.why_prompt). The browser has no model, so this module
 * writes it from templates — and the rule a model was given is the rule here,
 * kept by construction rather than by asking nicely:
 *
 *   - Only what happened. Every sentence is sifted out of the run's own
 *     events, its daybooks, or the world as it stands. A template whose
 *     fact is not there (no dry spell, no sold-out shop, nobody fraying)
 *     is not on the menu that day; the pack's own line always is.
 *   - Nobody invented. Every name is a name an event or a resident
 *     carries; a template that names nobody says "a family", never "Ada".
 *   - No repeats. Each template has an id, the last few ids used are
 *     remembered (and saved with the estate), and a remembered one is
 *     only reused when nothing else fits.
 *
 * The choice among fitting templates is the seed's: `rngFor(seed, day,
 * "watch:why")`, a generator of its own that the world never draws from,
 * so the words never change the estate they describe.
 */
import { byCodePoint } from "../py/canon.ts";
import type { PyRandom } from "../py/random.ts";
import { R } from "../sim/rules.ts";
import * as W from "../sim/world.ts";
import type { Ev } from "../sim/engine/events.ts";
import type { Intent } from "../sim/watcher.ts";
import { commas, words } from "./render.ts";

/** Template ids lately used, oldest first; saved with the estate. */
export interface Memory { used: string[] }

export const MEMORY = 24;

type Option = [id: string, text: string];

/** One of the options, preferring any not used lately. */
export function pick(rng: PyRandom, mem: Memory, options: Option[]): string {
  // the older half: never used first, then the ones used longest ago, so
  // a line is never the last one said and the order never settles into a
  // round the reader can predict
  const age = (id: string) => mem.used.lastIndexOf(id);
  const ages = options.map(([id]) => age(id)).sort((p, q) => p - q);
  const cut = ages[Math.max(0, Math.ceil(options.length / 2) - 1)]!;
  const pool = options.filter(([id]) => age(id) <= cut);
  const [id, text] = rng.choice(pool);
  mem.used = mem.used.filter((u) => u !== id);
  mem.used.push(id);
  if (mem.used.length > MEMORY) mem.used.splice(0, mem.used.length - MEMORY);
  return text;
}

const NUM = ["no", "one", "two", "three", "four", "five", "six", "seven",
  "eight", "nine", "ten", "eleven", "twelve"];

/** A small count as a word, a large one with commas. */
export function count(n: number): string {
  return n < NUM.length ? NUM[n]! : commas(n);
}

/** "Ada", "Ada and Bram", "Ada, Bram and Cleo", "Ada, Bram, Cleo and 2 others". */
export function list(xs: string[], most = 4): string {
  if (xs.length > most) {
    const rest = xs.length - (most - 1);
    xs = [...xs.slice(0, most - 1), `${count(rest)} others`];
  }
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

const isAre = (n: number) => (n === 1 ? "is" : "are");
function names(evs: Ev[], d = "someone"): string[] {
  return evs.map((e) => (e.who === undefined || e.who === null || e.who === "" ? d : String(e.who)));
}

/** The residents fraying now (stress ≥ 1), worst first, named ones only. */
function frayed(w: W.World, n = 2): string[] {
  return Object.values(w.residents)
    .filter((r) => r.stress >= 1 && r.name)
    .sort((p, q) => q.stress - p.stress || p.id - q.id)
    .slice(0, n).map((r) => r.name!);
}

// --------------------------------------------------------- the watcher's why

/** Facts the why may lean on, every one read off the world or its books. */
interface Facts {
  season: string; weekday: string; weather: string;
  dry: number; calm: number; soldOut: number; stockPct: number | null;
  worn: string[]; broken: string[]; frayed: string[];
  today: number | null; born: string[];
}

function facts(w: W.World, books: Record<number, W.Daybook | undefined>, events: Ev[]): Facts {
  const back = (pred: (b: W.Daybook) => boolean): number => {
    let n = 0;
    for (let d = w.day; d > w.day - 64; d--) {
      const b = books[d];
      if (!b || !pred(b)) break;
      n++;
    }
    return n;
  };
  const week = [...Array(7).keys()].map((i) => books[w.day - i]).filter((b): b is W.Daybook => !!b);
  const shop = Object.values(w.fixtures).find((f) => f.kind === "shop" && typeof f.stock === "number");
  const full = R.fixtures.shop?.stock;
  const fx = Object.values(w.fixtures);
  const today = books[w.day];
  return {
    season: W.seasonName(w.day),
    weekday: W.weekdayName(w.day),
    weather: w.weather,
    dry: back((b) => b.weather !== "rain" && b.weather !== "storm"),
    calm: back((b) => b.weather !== "storm"),
    soldOut: week.filter((b) => b.sold_out).length,
    stockPct: shop && full ? Math.round((100 * shop.stock!) / full) : null,
    worn: [...new Set(fx.filter((f) => f.condition > 0 && f.condition < 0.35).map((f) => f.kind))].sort(byCodePoint),
    broken: [...new Set(fx.filter((f) => f.condition <= 0).map((f) => f.kind))].sort(byCodePoint),
    frayed: frayed(w),
    today: today ? Object.values(today.uses ?? {}).reduce((p, q) => p + q, 0) : null,
    born: names(events.filter((e) => e.kind === "born" && e.day > w.day - 7 && e.who)),
  };
}

/** The watcher's why for a choice already made: one short sentence in the
 * place's own voice, from the facts that fit the fate, or the pack's line. */
export function why(w: W.World, intent: Intent, books: Record<number, W.Daybook | undefined>,
                    events: Ev[], mem: Memory): string {
  const f = facts(w, books, events);
  const pack = R.fates[intent.fate]?.why ?? intent.why;
  const opts: Option[] = [];
  const add = (ok: unknown, id: string, text: () => string) => { if (ok) opts.push([`${intent.fate}:${id}`, text()]); };
  const times = (k: number) => (k === 1 ? "once" : k === 2 ? "twice" : `${count(k)} times`);
  switch (intent.fate) {
    case "rain":
      add(f.dry >= 3, "dry", () => `${count(f.dry)} dry days; the lawns want rain`);
      add(f.dry >= 2, "held", () => `it is ${f.season}, and the sky has held off long enough`);
      break;
    case "storm":
      add(f.calm >= 5, "calm", () => `${count(f.calm)} days without a storm; enough of that`);
      add(f.season === "autumn" || f.season === "winter", "season", () => `${f.season} weather, and the estate should feel it`);
      break;
    case "heat":
      add(f.season === "summer", "summer", () => "high summer; let the courtyard bake");
      add(f.today !== null && f.today >= 400, "busy", () => `${commas(f.today!)} errands today — the heat will slow them`);
      break;
    case "frost":
      add(f.season === "winter" || f.season === "autumn", "season", () => `${f.season} nights are long; the estate wakes white`);
      break;
    case "delivery":
      add(f.soldOut, "sold", () => `the shop sold out ${times(f.soldOut)} this week; the shelves want filling`);
      add(f.stockPct !== null && f.stockPct < 50, "stock", () => `the shop's shelves are down to ${f.stockPct}%`);
      break;
    case "roadworks":
      add(f.today, "long", () => `${commas(f.today!)} errands today; let them take the long way round a while`);
      break;
    case "power_cut":
      add(!f.frayed.length, "steady", () => "nobody is fraying; the estate can stand a dark night");
      break;
    case "tranquillity":
      add(f.frayed.length, "fray", () => `${list(f.frayed)} ${isAre(f.frayed.length)} fraying; the estate could use a few quiet days`);
      break;
    case "damage":
      add(f.worn.length, "worn", () => `the ${words(f.worn[0])} has been wearing thin`);
      break;
    case "quiet":
      add(!f.frayed.length, "steady", () => "nobody is fraying — the estate can keep its own day");
      add(f.today, "errands", () => `${commas(f.today!)} errands today; the estate needs nothing from me`);
      add(f.weather === "rain", "rain", () => "it is raining well enough without me");
      add(f.born.length, "born", () => `${list(f.born)} ${isAre(f.born.length)} new on the estate; let the days be ordinary`);
      add(true, "day", () => `the estate is left to its own ${f.weekday}`);
      break;
  }
  opts.push([`${intent.fate}:pack`, pack]);
  return pick(W.rngFor(w.seed, w.day, "watch:why"), mem, opts);
}
