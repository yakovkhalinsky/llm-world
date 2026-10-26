/**
 * The estate in words and glyphs — apps/estate/estate/render.py.
 *
 * `say` is the one home of an event's sentence: the day feed, the chronicle
 * and the watcher's digest all take it from here. `dayLine` is what an
 * ordinary day was like, from its own daybook. `full` is the text frame the
 * page shows when it has no WebGL (`/api/plain`).
 */
import { byCodePoint } from "../py/canon.ts";
import { R } from "../sim/rules.ts";
import * as W from "../sim/world.ts";
import type { Ev } from "../sim/engine/events.ts";

export const WEATHER_GLYPH: Record<string, string> = {
  clear: "☀", rain: "🌧", storm: "⛈", heat: "🔥", frost: "❄",
};

export const ROLE_GLYPH: Record<string, string> = { child: "🧒", adult: "🧑", elder: "🧓" };

const ROLES = ["child", "adult", "elder"];

/** Python's `f"{n:,}"`: thousands with commas, whatever the locale. */
export function commas(n: number): string {
  const s = String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (n < 0 ? "-" : "") + s;
}

/** An enum said aloud: `flat_share` is "flat share". */
export function words(x: unknown): string {
  return String(x).replace(/_/g, " ");
}

/** "an elder", "a flat share": the article the word wants. */
export function a(word: unknown): string {
  const w = words(word);
  return ("aeiou".includes(w.slice(0, 1).toLowerCase()) ? "an " : "a ") + w;
}

/** who a household of each kind is, as the subject of "moved in" */
export const MOVER: Record<string, string> = {
  single: "someone on their own", flat_share: "a flat share",
  elder: "an elder and family", family: "a family", couple: "a couple",
};

const str = (v: unknown, d: string): string => (v === undefined ? d : v === null ? "None" : String(v));

/** An event as a sentence (render.say). */
export function say(ev: Ev): string {
  const k = ev.kind;
  switch (k) {
    case "turn": {
      const seasons = R.presentation.seasons ?? [];
      const i = ev.season as number | null | undefined;
      return `the season turned to ${i !== undefined && i !== null && i < seasons.length ? seasons[i] : "another season"}`;
    }
    case "broke": return `${a(ev.what || "thing")} broke`;
    case "tree_down": return "a tree came down";
    case "storm": return "a storm crossed the estate";
    case "frost": return "ice on the pond";
    case "fate": return (ev.say as string) || `the watcher sent ${ev.what === undefined ? "None" : String(ev.what)}`;
    case "moved_in": {
      const where = (ev.where as string) || "household";
      return `${MOVER[where] ?? a(where)} moved in`;
    }
    case "born": return `${str(ev.who, "a child")} was born on the estate`;
    case "died": return `${str(ev.who, "someone")} died`;
    case "left": return ev.who ? `${String(ev.who)} left the estate` : "a household left the estate";
    case "grew": return `${str(ev.who, "someone")} — ${str(ev.what, "a year older")}`;
    default: return String(k);
  }
}

/** Benches, not benchs. */
export function plural(kind: string): string {
  if (/(ch|sh|s|x)$/.test(kind)) return kind + "es";
  if (kind.endsWith("y")) return kind.slice(0, -1) + "ies";
  return kind + "s";
}

/** What a day was like, from what actually happened in it (render.day_line). */
export function dayLine(book: W.Daybook | null | undefined): string {
  if (!book || !Object.keys(book).length) return "";
  const uses = book.uses ?? {};
  const keys = Object.keys(uses);
  if (!keys.length) return "a still day — nobody left their flat";
  const total = keys.reduce((s, k) => s + uses[k]!, 0);
  const sky = book.weather ?? null;
  const top = keys.sort((p, q) => uses[q]! - uses[p]! || byCodePoint(p, q));
  const aside = top.filter((k) => k !== "shop")[0];
  const place = aside !== undefined ? plural(aside) : "courtyard";
  const t = commas(total);
  if (sky === "storm") return "a storm — nobody crossed the estate who did not have to";
  if (sky === "rain") return `rain on and off; ${t} errands, the ${place} empty between showers`;
  if (sky === "heat") return `hot and still; ${t} errands, and whatever shade there was, taken`;
  if (sky === "frost") return `cold and bright; ${t} errands, the ${place} busy and nobody lingering`;
  if (book.sold_out && (sky === null || sky === "clear" || sky === "frost")) {
    return `${t} errands and the shop sold out before the evening — the ${place} busy instead`;
  }
  if (total >= 400) return `a busy day — ${t} errands, the ${place} never empty`;
  if (total <= 352) return `a slow day — ${t} errands, and the ${place} mostly empty`;
  return `${t} errands, most of them to the shop, and the ${place} busy`;
}

/** The census line: households, not people, one glyph per kind. */
export function header(w: W.World): string {
  const day = w.day;
  const census = W.counts(w);
  const kinds = Object.keys(census).sort(byCodePoint).filter((k) => census[k])
    .map((k) => `${R.households[k]!.glyph}${census[k]}`).join(" ");
  return `DAY ${day} · ${W.seasonName(day)} · ${W.weekdayName(day)} · ` +
    `${WEATHER_GLYPH[w.weather] ?? ""} ${w.weather}   ${kinds}`;
}

/** One glyph per cell: people win, then a fixture, then the ground. */
export function renderMap(w: W.World): string {
  const here = new Map<string, W.Resident[]>();
  for (const r of Object.values(w.residents)) {
    if (r.where.mode !== "at") continue;
    const k = `${r.where.x},${r.where.y}`;
    const l = here.get(k);
    if (l) l.push(r); else here.set(k, [r]);
  }
  const fixtures = new Map<string, W.Fixture>();
  for (const f of Object.values(w.fixtures)) {
    const k = `${f.x},${f.y}`;
    if (!fixtures.has(k)) fixtures.set(k, f);
  }
  const rows: string[] = [];
  for (let y = 0; y < w.height; y++) {
    let row = "";
    for (let x = 0; x < w.width; x++) {
      const c = w.cells[y]![x]!;
      if (c.site === "building") { row += "🏢"; continue; }
      if (c.site === "water") { row += "🌊"; continue; }
      const people = here.get(`${x},${y}`);
      if (people) {
        const top = people.reduce((m, p) => Math.max(m, ROLES.indexOf(p.role)), -1);
        row += ROLE_GLYPH[ROLES[top]!];
        continue;
      }
      const f = fixtures.get(`${x},${y}`);
      if (f && f.condition > 0) { row += R.fixtures[f.kind]!.glyph; continue; }
      row += R.sites[c.site]!.glyph;
    }
    rows.push(row);
  }
  return rows.join("\n");
}

export interface Scene {
  world: W.World;
  status?: string;
  watcher_line?: string | null;
  chronicle?: [number, string, string][];
}

/** One text frame: the header, the plan, the watcher's word, the lines. */
export function full(scene: Scene): string {
  const w = scene.world;
  const parts = [header(w), "", renderMap(w), "", scene.status ?? ""];
  if (scene.watcher_line) parts.push(`\n ☾ ${scene.watcher_line}`);
  const rows = scene.chronicle ?? [];
  if (rows.length) {
    parts.push("");
    for (const [tick, , text] of rows) {
      const ago = w.day - tick;
      parts.push(`  ▸ ${text}  (${ago <= 0 ? "today" : `${ago}d ago`})`);
    }
  }
  return parts.map((ln) => ` ${ln}`).join("\n") + "\n";
}
