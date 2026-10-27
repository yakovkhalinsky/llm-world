/**
 * The chronicle and the watcher's why, without a model.
 *
 * In apps/estate a model writes both: a paragraph over each run of days
 * (chronicler.py) and one sentence on why the watcher sent what it sent
 * (watcher.why_prompt). The browser has no model, so this module writes
 * them from templates — and the rule a model was given is the rule here,
 * kept by construction rather than by asking nicely:
 *
 *   - Only what happened. Every sentence is sifted out of the run's own
 *     events, its daybooks, or the world as it stands. A template whose
 *     fact is not there (no deaths, no sold-out shop, nobody fraying) is
 *     not on the menu that day; for the why, the pack's own line always is.
 *   - Nobody invented. Every name is a name an event or a resident
 *     carries; a template that names nobody says "a family", never "Ada".
 *   - No repeats. Each template has an id, the last few ids used are
 *     remembered (and saved with the estate), and a remembered one is
 *     only reused when nothing else fits; and no chronicle entry is word
 *     for word an entry the estate still keeps.
 *
 * The choice among fitting templates is the seed's: `rngFor(seed, day,
 * "chronicle")` and `rngFor(seed, day, "watch:why")`, generators of their
 * own that the world never draws from, so the words never change the
 * estate they describe.
 */
import { byCodePoint } from "../py/canon.ts";
import type { PyRandom } from "../py/random.ts";
import { R } from "../sim/rules.ts";
import * as W from "../sim/world.ts";
import type { Ev } from "../sim/engine/events.ts";
import type { Intent } from "../sim/watcher.ts";
import { MOVER, a, commas, plural, words } from "./render.ts";

/** Template ids lately used, oldest first; saved with the estate. */
export interface Memory { used: string[] }

export const MEMORY = 24;

export type Option = [id: string, text: string];

/** One of the options, preferring any not used lately: a line is never
 * said twice running, unless it is the only one that fits. */
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

/** What a fate is called, where "a delivery: the shop is restocked" reads
 * well; the weather fates and damage say themselves. */
const FATE_NOUN: Record<string, string> = {
  delivery: "a delivery", roadworks: "roadworks", power_cut: "a power cut",
  tranquillity: "a quiet spell",
};

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
const wasWere = (n: number) => (n === 1 ? "was" : "were");

function sentence(s: string): string {
  s = s.trim();
  if (!s) return s;
  s = s[0]!.toUpperCase() + s.slice(1);
  return /[.!?…]$/.test(s) ? s : s + ".";
}

function names(evs: Ev[], d = "someone"): string[] {
  return evs.map((e) => (e.who === undefined || e.who === null || e.who === "" ? d : String(e.who)));
}

/** Kinds counted, said aloud: "a bench and two lamps". */
function things(kinds: string[]): string {
  const n = new Map<string, number>();
  for (const k of kinds) n.set(k, (n.get(k) ?? 0) + 1);
  return list([...n.keys()].sort(byCodePoint).map((k) =>
    n.get(k) === 1 ? a(k) : `${count(n.get(k)!)} ${plural(words(k))}`));
}

function buildingOf(w: W.World, unit: unknown): string | null {
  const u = typeof unit === "number" ? w.units[String(unit)] : undefined;
  return u ? w.buildings[String(u.building)]?.name ?? null : null;
}

/** The residents fraying now (stress ≥ 1), worst first, named ones only. */
function frayed(w: W.World, n = 2): string[] {
  return Object.values(w.residents)
    .filter((r) => r.stress >= 1 && r.name)
    .sort((p, q) => q.stress - p.stress || p.id - q.id)
    .slice(0, n).map((r) => r.name!);
}

const SKY_DAYS: Record<string, string> = {
  clear: "clear", rain: "wet", storm: "stormy", heat: "hot", frost: "frosty",
};

interface Beat { weight: number; options: Option[] }

// ------------------------------------------------------------ the chronicle

export interface Stretch {
  /** the run's days, oldest first */
  days: number[];
  events: Ev[];
  books: Record<number, W.Daybook | undefined>;
}

/** What the run's events were, as beats a sentence can be made of. */
function news(w: W.World, evs: Ev[]): Beat[] {
  const by = (k: string) => evs.filter((e) => e.kind === k);
  const out: Beat[] = [];
  const died = names(by("died"));
  if (died.length) {
    const n = died.length;
    out.push({ weight: 10, options: [
      ["died:0", `${list(died)} died`],
      ["died:1", `the estate lost ${list(died)}`],
      ["died:2", n === 1 ? `there was a death on the estate: ${died[0]}`
        : `there were ${count(n)} deaths on the estate: ${list(died)}`],
    ] });
  }
  const born = names(by("born"), "a child");
  if (born.length) {
    const n = born.length;
    out.push({ weight: 9, options: [
      ["born:0", `${list(born)} ${wasWere(n)} born on the estate`],
      ["born:1", `${n === 1 ? "a new name" : "new names"} on the estate: ${list(born)}`],
      ["born:2", `the estate grew by ${count(n)} — ${list(born)}, born here`],
    ] });
  }
  for (const e of by("turn")) {
    const i = e.season as number;
    const s = R.presentation.seasons[i] ?? "another season";
    const opts: Option[] = [["turn:0", `the season turned to ${s}`], ["turn:1", `${s} came in`]];
    const line = R.presentation.season_lines[String(i)];
    if (line) opts.push(["turn:2", line]);
    out.push({ weight: 8, options: opts });
  }
  const left = names(by("left"), "a household");
  if (left.length) {
    const n = left.length;
    out.push({ weight: 8, options: n === 1 ? [
      ["left:0", `${left[0]} left the estate`],
      ["left:1", `${left[0]} moved away`],
      ["left:2", `the estate said goodbye to ${left[0]}`],
    ] : [
      ["left:0", `${list(left)} left the estate`],
      ["left:3", `${count(n)} households moved away — ${list(left)}`],
    ] });
  }
  const moved = by("moved_in");
  if (moved.length) {
    const who = moved.map((e) => MOVER[e.where as string] ?? a(e.where || "household"));
    const where = moved.map((e) => buildingOf(w, e.flat));
    const n = moved.length;
    if (n === 1 && where[0]) {
      out.push({ weight: 7, options: [
        ["move:0", `${who[0]} moved into ${where[0]}`],
        ["move:1", `new neighbours in ${where[0]}: ${who[0]}`],
        ["move:2", `${where[0]} took in ${who[0]}`],
      ] });
    } else {
      out.push({ weight: 7, options: [
        ["move:3", `${list(who)} moved in`],
        ["move:4", `${count(n)} new households on the estate — ${list(who)}`],
      ] });
    }
  }
  // the engine says what someone grew into at the end of `what`: "a child
  // becomes an adult", "an adult becomes an elder" (households.agePeople)
  const grew = by("grew");
  const into = (role: string) => names(grew.filter((e) => String(e.what ?? "").endsWith(`becomes an ${role}`)));
  const adults = into("adult");
  const elders = into("elder");
  if (adults.length) {
    out.push({ weight: 6, options: [
      ["adult:0", `${list(adults)} came of age`],
      ["adult:1", `${list(adults)} ${isAre(adults.length)} grown now`],
    ] });
  }
  if (elders.length) {
    out.push({ weight: 6, options: [
      ["elder:0", `${list(elders)} ${isAre(elders.length)} counted among the elders now`],
      ["elder:1", `${list(elders)} turned elder`],
    ] });
  }
  for (const e of by("fate")) {
    const s = (e.say as string) || `the watcher sent ${words(e.what)}`;
    const opts: Option[] = [["fate:0", s]];
    const noun = FATE_NOUN[e.what as string];
    if (noun && e.say) opts.push(["fate:1", `${noun}: ${s}`]);
    out.push({ weight: 6, options: opts });
  }
  const storms = by("storm").length;
  if (storms) {
    out.push({ weight: 5, options: storms === 1
      ? [["storm:0", "a storm crossed the estate"], ["storm:1", "a storm came through"]]
      : [["storm:0", `${count(storms)} storms crossed the estate`]] });
  }
  const trees = by("tree_down").length;
  if (trees) {
    out.push({ weight: 5, options: trees === 1
      ? [["tree:0", "a tree came down"], ["tree:1", "the estate lost a tree"]]
      : [["tree:0", `${count(trees)} trees came down`]] });
  }
  const broke = by("broke").map((e) => String(e.what || "thing"));
  if (broke.length) {
    out.push({ weight: 5, options: [
      ["broke:0", `${things(broke)} broke`],
      ["broke:1", `${things(broke)} gave out`],
    ] });
  }
  if (by("frost").length) {
    // render.py's "ice on the pond", where the estate has a pond to ice
    const pond = w.cells.some((row) => row.some((c) => c.site === "water"));
    out.push({ weight: 3, options: pond
      ? [["frost:0", "ice on the pond"], ["frost:1", "the pond iced over"]]
      : [["frost:2", "a hard frost"], ["frost:3", "the estate woke white"]] });
  }
  return out;
}

const dayz = (n: number): string => (n === 1 ? "day" : "days");

/** The shape of the run's ordinary days, from their daybooks. */
function shape(w: W.World, s: Stretch): Beat | null {
  const days = s.days.filter((d) => s.books[d]);
  if (!days.length) return null;
  const totals = days.map((d) => Object.values(s.books[d]!.uses ?? {}).reduce((p, q) => p + q, 0));
  const total = totals.reduce((p, q) => p + q, 0);
  const n = days.length;
  if (!total) {
    return { weight: 1, options: [
      ["still:0", `${count(n)} still ${dayz(n)} — not one errand run`],
    ] };
  }
  const skies = days.map((d) => s.books[d]!.weather ?? "clear");
  const uses: Record<string, number> = {};
  for (const d of days) for (const [k, v] of Object.entries(s.books[d]!.uses ?? {})) uses[k] = (uses[k] ?? 0) + v;
  const aside = Object.keys(uses).filter((k) => k !== "shop" && uses[k]! > 0)
    .sort((p, q) => uses[q]! - uses[p]! || byCodePoint(p, q))[0];
  // the busiest place but the shop, said as it stood against the shop
  const many = Object.values(w.fixtures).filter((f) => f.kind === aside).length > 1;
  const place = aside ? `the ${many ? plural(words(aside)) : words(aside)}` : null;
  const rank = !aside ? "" : (uses.shop ?? 0) >= uses[aside]! ? "busiest after the shop" : "busier even than the shop";
  const one = skies.every((x) => x === skies[0]);
  const wet = skies.filter((x) => x === "rain" || x === "storm").length;
  const sky = one
    ? `${count(n)} ${SKY_DAYS[skies[0]!] ?? skies[0]} ${dayz(n)}`
    : wet ? `${skies.includes("storm") ? "wet weather" : "rain"} on ${count(wet)} of ${count(n)} days` : `${count(n)} dry days`;
  const best = totals.indexOf(Math.max(...totals));
  const opts: Option[] = [
    ["shape:1", `${commas(total)} errands over ${count(n)} ${dayz(n)}, the most on ${W.weekdayName(days[best]!)} (${commas(totals[best]!)})`],
  ];
  if (place) {
    opts.push(["shape:0", `${sky}; ${commas(total)} errands, and ${place} ${rank}`]);
    opts.push(["shape:2", `${sky}, and ${place} the place to be`]);
  }
  if (n > 1) opts.push(["shape:3", `${sky}; about ${commas(Math.round(total / n))} errands a day`]);
  return { weight: 1, options: opts };
}

function soldOut(s: Stretch): Beat | null {
  const k = s.days.filter((d) => s.books[d]?.sold_out).length;
  if (!k) return null;
  const times = k === 1 ? "once" : k === 2 ? "twice" : `${count(k)} times`;
  return { weight: 4, options: [
    ["sold:0", `the shop sold out ${times}`],
    ["sold:1", k === 1 ? "one evening the shop's shelves were bare" : `the shop's shelves were bare ${times}`],
  ] };
}

function fraying(w: W.World): Beat | null {
  const who = frayed(w);
  if (!who.length) return null;
  return { weight: 2, options: [
    ["fray:0", `${list(who)} ${isAre(who.length)} fraying`],
    ["fray:1", `it has been hard going for ${list(who)}`],
  ] };
}

/** One entry for a run of days: the two weightiest things that happened
 * and what the days were like. Never empty, never more than three
 * sentences, and only ever the run's own facts. */
export function chronicle(w: W.World, s: Stretch, mem: Memory, earlier: readonly string[] = []): string {
  const rng = W.rngFor(w.seed, w.day, "chronicle");
  const beats = news(w, s.events).sort((p, q) => q.weight - p.weight);
  const lead = beats.slice(0, 2);
  const extra = [soldOut(s), fraying(w)].filter((b): b is Beat => b !== null);
  if (lead.length < 2 && extra.length) lead.push(extra[0]!);
  const sh = shape(w, s);
  if (sh && lead.length < 3) lead.push(sh);
  if (!lead.length) {
    return `${count(s.days.length)} ${dayz(s.days.length)} the estate has no record of.`;
  }
  let text = "";
  for (let tries = 0; tries < 4; tries++) {
    text = lead.map((b) => sentence(pick(rng, mem, b.options))).join(" ");
    if (!earlier.includes(text)) return text;
  }
  // every wording is one the estate already keeps: name the days, which
  // no other entry can share
  const [from, to] = [s.days[0]!, s.days[s.days.length - 1]!];
  return `${text} ${sentence(from === to ? `day ${commas(from)}` : `days ${commas(from)} to ${commas(to)}`)}`;
}

// --------------------------------------------------------- the watcher's why

/** Facts the why may lean on, every one read off the world or its books. */
export interface Facts {
  season: string; weekday: string; weather: string;
  dry: number; calm: number; soldOut: number; stockPct: number | null;
  worn: string[]; broken: string[]; frayed: string[];
  today: number | null; born: string[];
}

export function facts(w: W.World, books: Record<number, W.Daybook | undefined>, events: Ev[]): Facts {
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

/** Every line the why could say today for a choice already made, with its
 * template id: the ones whose facts hold, and the pack's line last. */
export function whyOptions(w: W.World, intent: Intent, books: Record<number, W.Daybook | undefined>,
                           events: Ev[]): Option[] {
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
    case "damage": {
      // the worn kind where the damage is aimed, if one is, else any
      const aimed = Object.values(w.fixtures)
        .filter((x) => f.worn.includes(x.kind) && x.condition > 0 && x.condition < 0.35 && W.inRegion(w, intent.region, x.x, x.y))
        .map((x) => x.kind).sort(byCodePoint);
      const kind = aimed[0] ?? f.worn[0];
      add(kind, "worn", () => `the ${words(kind!)} has been wearing thin`);
      break;
    }
    case "quiet":
      add(!f.frayed.length, "steady", () => "nobody is fraying — the estate can keep its own day");
      add(f.today, "errands", () => `${commas(f.today!)} errands today; the estate needs nothing from me`);
      add(f.weather === "rain", "rain", () => "it is raining well enough without me");
      add(f.born.length, "born", () => `${list(f.born)} ${isAre(f.born.length)} new on the estate; let the days be ordinary`);
      add(true, "day", () => `the estate is left to its own ${f.weekday}`);
      break;
  }
  opts.push([`${intent.fate}:pack`, pack]);
  return opts;
}

/** The watcher's why for a choice already made: one short sentence in the
 * place's own voice, from the facts that fit the fate, or the pack's line. */
export function why(w: W.World, intent: Intent, books: Record<number, W.Daybook | undefined>,
                    events: Ev[], mem: Memory): string {
  return pick(W.rngFor(w.seed, w.day, "watch:why"), mem, whyOptions(w, intent, books, events));
}
