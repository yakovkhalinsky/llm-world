/**
 * The page's four questions, answered from the runner — what
 * apps/estate/estate/web.py serves at /api/ground, /api/state, /api/plain
 * and POST /api/control, field for field, so the reused page3d front end
 * (viewer.js, hud.js, world.js) reads them unchanged.
 *
 * The fields a model filled in Python say there is none: `llm` is a status
 * line hud.js shows as "AI off · pure deterministic sim", and `models` is
 * null, as it is under `--offline`.
 */
import { pyRound } from "../py/num.ts";
import { R } from "../sim/rules.ts";
import * as W from "../sim/world.ts";
import * as daytime from "../sim/engine/daytime.ts";
import * as families from "../sim/engine/families.ts";
import { PHASES } from "../sim/engine/residents.ts";
import type { Ev } from "../sim/engine/events.ts";
import { ROLE_GLYPH, WEATHER_GLYPH, dayLine, full, say } from "./render.ts";
import type { RunState } from "./runner.ts";

/** The status line where Python names its models (llm.status_line). */
export const LLM_STATUS = "tier browser — pure deterministic sim";

const glyphs = <T extends { glyph?: string }>(o: Record<string, T>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.glyph ?? null]));

/** The plan as it was drawn; fetched once (web.ground). */
export function ground(w: W.World) {
  const codes = Object.keys(R.sites);
  const idx = new Map(codes.map((c, i) => [c, i]));
  const rows = w.cells.map((row) => row.map((c) => idx.get(c.site)!));
  const buildings = [];
  const units: Record<string, { b: number; f: number; i: number; n: number; floors: number }> = {};
  for (const [bid, b] of Object.entries(w.buildings)) {
    buildings.push({
      id: Number(bid), name: b.name, kind: b.kind, x: b.x, y: b.y, w: b.w, h: b.h,
      floors: b.floors, door: b.door, yard: b.yard ?? null, gate: b.gate ?? null,
    });
    const per = new Map<number, number[]>();
    for (const u of [...b.units].sort((p, q) => p - q)) {
      const fl = w.units[String(u)]!.floor;
      const l = per.get(fl);
      if (l) l.push(u); else per.set(fl, [u]);
    }
    for (const [fl, ids] of per) {
      ids.forEach((u, i) => { units[String(u)] = { b: Number(bid), f: fl, i, n: ids.length, floors: b.floors }; });
    }
  }
  return {
    width: w.width, height: w.height, codes, rows,
    walk: Object.fromEntries(codes.map((n) => [n, R.sites[n]!.walk ?? null])),
    biome: w.biome ?? null, seed: w.seed, buildings, units,
    glyphs: {
      needs: glyphs(R.needs), households: glyphs(R.households),
      fixtures: glyphs(R.fixtures), sites: glyphs(R.sites),
      roles: ROLE_GLYPH, weather: WEATHER_GLYPH,
    },
    speeds: [...R.pacing.day_seconds],
    words: { world: R.presentation.world_word ?? "the estate", seasons: [...(R.presentation.seasons ?? [])] },
  };
}

const small = (vals: number[]) => vals.map((v) => Math.min(9, Math.trunc(v * 9)));

/** The last few days, one row each (web.day_feed). */
export function dayFeed(w: W.World, events: Ev[], books: RunState["daybooks"], days = 24) {
  const byDay = new Map<number, string[]>();
  for (const e of events) {
    const l = byDay.get(e.day);
    if (l) l.push(say(e)); else byDay.set(e.day, [say(e)]);
  }
  const out = [];
  for (let d = Math.max(1, w.day - days + 1); d <= w.day; d++) {
    const line = dayLine(books[d]);
    const says = byDay.get(d) ?? [];
    if (!line && !says.length) continue;
    out.push({ day: d, says, line });
  }
  return out;
}

/** Everything the page needs for one frame (web.snapshot). */
export function snapshot(s: RunState) {
  const w = s.world;
  const day = w.day;
  const people = Object.entries(w.residents).map(([rid, r]) => {
    const wh = r.where;
    const [px, py, pmode, punit] = s.prev[rid] ?? [wh.x, wh.y, wh.mode, wh.unit ?? null];
    const hh = w.households[String(r.household)];
    return {
      id: Number(rid), name: r.name, role: r.role, kind: hh?.kind ?? null, age: r.age,
      x: wh.x, y: wh.y,
      in: wh.mode === "in" || (wh.mode === pmode && pmode === "away"),
      mode: wh.mode, pupil: daytime.isPupil(r), job: Boolean(r.job),
      unit: wh.unit ?? null, fixture: wh.fixture ?? null,
      px, py, pin: pmode === "in", pmode, punit,
      habit: r.habit, stress: pyRound(r.stress, 1),
      needs: Object.fromEntries(Object.entries(r.needs).map(([k, v]) => [k, pyRound(v, 2)])),
      family: (hh?.members ?? []).filter((m) => m !== r.id && String(m) in w.residents),
      with: families.walkingWith(w, r),
    };
  });
  const fixtures = Object.entries(w.fixtures).map(([fid, f]) => ({
    id: Number(fid), kind: f.kind, x: f.x, y: f.y, c: pyRound(f.condition, 3),
    uses: f.use_total, stock: f.stock ?? null, cap: R.fixtures[f.kind]!.capacity ?? 0,
    perimeter: Boolean(f.perimeter),
  }));
  const buildings = Object.entries(w.buildings).map(([bid, b]) => ({
    id: Number(bid), kind: b.kind, units: b.units.length,
    lived: b.units.filter((u) => w.units[String(u)]!.household !== null).length,
    power: b.power, water: b.water,
  }));
  const shade: number[] = [];
  const light: number[] = [];
  for (const row of w.cells) {
    shade.push(...small(row.map((c) => c.shade)));
    light.push(...small(row.map((c) => c.light)));
  }
  const book = w.day_phases as { day: number; phases: unknown } | null | undefined;
  return {
    day, season: W.seasonIndex(day), season_name: W.seasonName(day),
    weekday: W.weekdayName(day), year: W.yearOf(day),
    weather: w.weather, weather_left: w.weather_left, wet_days: w.wet_days,
    paused: s.paused, tick_seconds: s.tick_seconds,
    census: W.counts(w),
    residents: Object.keys(w.residents).length,
    units: Object.keys(w.units).length,
    waiting: w.waiting.length,
    people, fixtures, buildings,
    daytime: daytime.roll(w),
    phases: book && book.day === day ? { day, order: [...PHASES], at: book.phases ?? {} } : null,
    shade, light,
    events: s.events.slice(-60).map((e) => ({ ...e, say: say(e) })),
    days: dayFeed(w, s.events, s.daybooks),
    watcher: { ...s.last_watch },
    chronicle: [] as { day: number; text: string }[],
    llm: LLM_STATUS,
    models: null,
  };
}

/** The text frame for a page with no WebGL (web._frame + render.full). */
export function plain(s: RunState): string {
  const w = s.world;
  return full({
    world: w,
    status: (s.paused ? "paused · " : "") + `${W.weekdayName(w.day)} · no watcher yet`,
    watcher_line: null, chronicle: [],
  });
}

export interface Pace { paused: boolean; step: number; tick_seconds: number }

/** The most days that can be queued. web.py's `step_once` has no ceiling
 * (1,000 requests of 100 queue 100,000 days); here the extra is dropped,
 * so a stuck button can't queue a fast-forward that outlives the tab. */
export const MAX_QUEUED = 10_000;

const FIELDS = ["paused", "step", "tick_seconds"];

/**
 * A control request checked as web._control checks it: only `paused`
 * (a bool), `step` (a whole number 1..100, which pauses) and
 * `tick_seconds` (finite, clamped to 0.2 s..1 day). Returns the error the
 * page shows, or null with `pace` changed.
 */
export function control(pace: Pace, req: object): string | null {
  const o = req as Record<string, unknown>;
  const has = (k: string) => Object.hasOwn(o, k);
  if (Object.keys(o).some((k) => !FIELDS.includes(k))) return "unknown field";
  if (has("paused") && typeof o.paused !== "boolean") return "paused must be true or false";
  // a step written as a float (5.0, 1e2) arrives as a PyFloat from parseBody
  if (has("step") && !(Number.isInteger(o.step) && (o.step as number) >= 1 && (o.step as number) <= 100)) {
    return "step must be a whole number 1..100";
  }
  const pace0 = o.tick_seconds instanceof PyFloat ? o.tick_seconds.value : o.tick_seconds;
  if (has("tick_seconds") && !(typeof pace0 === "number" && Number.isFinite(pace0))) {
    return "tick_seconds must be a number";
  }
  if (has("paused")) pace.paused = o.paused as boolean;
  if (has("step")) { pace.step = Math.min(MAX_QUEUED, pace.step + (o.step as number)); pace.paused = true; }
  if (has("tick_seconds")) pace.tick_seconds = Math.min(86400, Math.max(0.2, pace0 as number));
  return null;
}

/** A JSON number written with a fraction or an exponent: what Python's
 * json reads as a float, which JSON.parse can't tell from an int (5.0 is
 * 5). Boxed, so `step: 5.0` is refused as web.py refuses it. */
export class PyFloat {
  constructor(readonly value: number) {}
}

/** Whether JSON.parse hands a reviver the source text (ES2025; Chrome
 * 114+, Firefox 135+, Safari 18.4+, Node 21+). Where it doesn't, 5.0
 * reads as 5 and a float step is taken — the one known gap, and page3d
 * only ever sends whole steps. */
export const SOURCE_TEXT = (() => {
  let ok = false;
  JSON.parse("1", ((_k: string, v: unknown, ctx?: { source?: string }) => { ok = ctx?.source === "1"; return v; }) as never);
  return ok;
})();

/** The body as Python's json.loads reads it, as far as control() cares:
 * numbers written as floats are PyFloats. (NaN and Infinity aren't JSON
 * to either side.) */
export function parseBody(body: string): unknown {
  if (!SOURCE_TEXT) return JSON.parse(body);
  return JSON.parse(body, ((_k: string, v: unknown, ctx?: { source?: string }) =>
    typeof v === "number" && ctx?.source !== undefined && /[.eE]/.test(ctx.source) ? new PyFloat(v) : v) as never);
}

/** The path as web.py's `urlparse(self.path).path` gives it: no query, no
 * fragment, no `;params` on the last segment. */
export function pathOnly(path: string): string {
  const p = path.split(/[?#]/, 1)[0]!;
  const slash = p.lastIndexOf("/");
  const semi = p.indexOf(";", slash + 1);
  return semi < 0 ? p : p.slice(0, semi);
}

export interface Reply { status: number; contentType: string; body: string }

const JSON_TYPE = "application/json";
const json = (status: number, v: unknown): Reply => ({ status, contentType: JSON_TYPE, body: JSON.stringify(v) });

/**
 * One of page3d's requests, answered as web.py's handler answers it: the
 * three GETs, and the POST that pauses, steps and paces the runner — which
 * changes `s` and `queued` (the days asked for and not yet stepped) only
 * when the whole request is good. Anything else is web.py's 404.
 *
 * Not ported, since nothing here is on a network: webguard.check's Host
 * and Origin checks (403), and webguard.read_json's length rules — no
 * Content-Length (411), more than one, not a number, a body shorter than
 * its length (400), or over BODY_LIMIT (413).
 */
export function respond(s: RunState, queued: { step: number }, method: string, url: string, body: string | null): Reply {
  const path = pathOnly(url);
  if (method === "GET") {
    // web.py turns a throw in /api/state into a 500 (the others would drop
    // the connection); here all three answer, so the page sees a status
    try {
      if (path === "/api/ground") return json(200, ground(s.world));
      if (path === "/api/state") return json(200, snapshot(s));
      if (path === "/api/plain") return { status: 200, contentType: "text/plain; charset=utf-8", body: plain(s) };
    } catch (e) {
      return json(500, { error: String(e instanceof Error ? e.message : e) });
    }
  } else if (method === "POST" && path === "/api/control") {
    let req: unknown;
    try {
      req = parseBody(body || "{}");
    } catch {
      return json(400, { error: "the body is not JSON" });
    }
    if (req === null || typeof req !== "object" || Array.isArray(req) || req instanceof PyFloat) return json(400, { error: "the body is not a JSON object" });
    const pace = { paused: s.paused, step: queued.step, tick_seconds: s.tick_seconds };
    const err = control(pace, req);
    if (err) return json(400, { error: err });
    s.paused = pace.paused;
    s.tick_seconds = pace.tick_seconds;
    queued.step = pace.step;
    return json(200, { ok: true });
  }
  return { status: 404, contentType: "text/plain; charset=utf-8", body: "no such thing" };
}
