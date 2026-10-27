/**
 * The estate's runner — apps/estate/estate/web.py's SimRunner, without the
 * thread, the lock, the wall clock or the model.
 *
 * One `step()` is one day, in the Python runner's order: note where
 * everybody stood, tick, keep the events (400) and the day's book (64
 * days), then the watcher if it is due and the chronicle if a run of days
 * is long enough. Pace — paused, a step, seconds a day — belongs to the
 * worker's timer, never to the estate: what happens on a day depends only
 * on the seed and the days before it.
 *
 * The watcher is the `--decide rules` watcher: watcher.choose decides in
 * code, exactly as the Python runner does, and its why is the pack's line —
 * what Python shows when no model is awake to write one. Its cadence is
 * counted in days from the seed (watcher.gapDays), not wall seconds. The
 * chronicle, which Python writes with a model or `chronicler.fallback`,
 * comes later, from seeded templates.
 */
import { generate } from "../sim/gen.ts";
import { R } from "../sim/rules.ts";
import { tick } from "../sim/engine/tick.ts";
import type { Ev } from "../sim/engine/events.ts";
import * as watcher from "../sim/watcher.ts";
import type * as W from "../sim/world.ts";

export type Prev = [x: number, y: number, mode: string, unit: number | null];

export interface Watch {
  fate: string | null; region: string | null; why: string | null; day: number | null;
  decided?: string; confidence?: number;
}

/** Everything the runner keeps, as plain data: what a save holds. */
export interface RunState {
  world: W.World;
  prev: Record<string, Prev>;
  events: Ev[];
  daybooks: Record<string, W.Daybook>;
  last_watch: Watch;
  /** the first day the watcher is due again; 0 is "after the next tick" */
  next_watch: number;
  paused: boolean;
  tick_seconds: number;
}

export const KEEP_EVENTS = 400;
export const KEEP_BOOKS = 64;

export function plant(seed: number): RunState {
  return {
    world: generate(seed),
    prev: {}, events: [], daybooks: {},
    last_watch: { fate: null, region: null, why: null, day: null },
    next_watch: 0,
    paused: false,
    tick_seconds: R.pacing.day_seconds[1]!,
  };
}

function notePrev(w: W.World): Record<string, Prev> {
  const out: Record<string, Prev> = {};
  for (const [rid, r] of Object.entries(w.residents)) {
    const wh = r.where;
    out[rid] = [wh.x, wh.y, wh.mode, wh.unit ?? null];
  }
  return out;
}

/** One day: the tick, its records, the watcher. */
export function step(s: RunState): Ev[] {
  const w = s.world;
  s.prev = notePrev(w);
  const evs = tick(w);
  s.events.push(...evs);
  const day = w.day;
  const book = w.daybook ?? {};
  s.daybooks[day] = { ...book, uses: { ...(book.uses ?? {}) } } as W.Daybook;
  for (const d of Object.keys(s.daybooks)) if (Number(d) < day - KEEP_BOOKS) delete s.daybooks[d];
  if (s.events.length > KEEP_EVENTS) s.events.splice(0, s.events.length - KEEP_EVENTS);
  watch(s);
  return evs;
}

function watch(s: RunState): void {
  const w = s.world;
  if (w.day < s.next_watch) return;
  s.next_watch = w.day + watcher.gapDays(w.seed, w.day);
  const intent = watcher.choose(w);
  watcher.queue(w, intent);
  s.last_watch = {
    fate: intent.fate, region: intent.region, why: intent.why, day: w.day,
    decided: intent.decided!, confidence: intent.confidence!,
  };
}
