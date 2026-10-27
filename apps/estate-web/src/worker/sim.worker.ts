/// <reference lib="webworker" />
/**
 * The estate lives here, off the page's thread — web.py's server and its
 * runner thread in one. The worker holds the estate, keeps its pace (a day
 * every `tick_seconds`, paused, or a few days stepped), answers the page's
 * requests and saves after every day.
 *
 * The pace is the only thing the wall clock touches. Which day comes next,
 * when the watcher looks and what it chooses all come from the seed, so a
 * saved estate resumed is the estate it was.
 */
import { respond } from "../view/api.ts";
import { plant, step, type RunState } from "../view/runner.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";
import * as store from "./store.ts";

declare const self: DedicatedWorkerGlobalScope;

/** web.py waits 0.1 s between stepped days. */
const STEP_GAP = 100;
const DEFAULT_SEED = 1;

let state: RunState | null = null;
const queued = { step: 0 };
let timer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<void> | null = null;
let dirty = false;
/** this tab holds the seed's lock; a second tab on the seed runs but never saves */
let held = false;
let release: (() => void) | null = null;
/** what the last save came to, so the page hears only when it changes */
let lastSave: store.Saved = { ok: true };

function post(m: FromWorker): void {
  self.postMessage(m);
}

/** Save now, or once the save in hand is done; saves never overlap. */
function persist(): Promise<void> {
  dirty = true;
  if (saving) return saving;
  saving = (async () => {
    while (dirty && state && held) {
      dirty = false;
      const r = await store.save(state);
      if (r.ok !== lastSave.ok || (!r.ok && !lastSave.ok && r.why !== lastSave.why)) {
        lastSave = r;
        post({ type: "saving", id: null, ok: r.ok, why: r.ok ? "" : r.why });
      }
    }
    saving = null;
  })();
  return saving;
}

async function open(seed: number | null, fresh: boolean) {
  const s = seed ?? (await store.lastSeed()) ?? DEFAULT_SEED;
  release?.();
  release = await store.claim(s);
  held = release !== null;
  if (fresh && held) await store.forget(s);
  const saved = fresh ? undefined : await store.load(s);
  state = saved?.state ?? plant(s);
  queued.step = 0;
  dirty = true;
  lastSave = held ? await store.save(state) : { ok: false, why: "open in another tab" };
  dirty = false;
  // A new estate has its first day at once, as web.py's runner does on
  // start; a resumed one waits its pace, so a reload is not a day.
  schedule(!saved && !state.paused);
  return {
    seed: s, day: state.world.day, resumed: Boolean(saved),
    saving: lastSave.ok, why: lastSave.ok ? "" : lastSave.why,
    ...(saved?.crashed !== undefined ? { crashed: saved.crashed } : {}),
  };
}

function schedule(now = false): void {
  clearTimeout(timer);
  timer = undefined;
  if (!state) return;
  if (now) timer = setTimeout(beat, 0);
  else if (queued.step > 0) timer = setTimeout(beat, STEP_GAP);
  else if (!state.paused) timer = setTimeout(beat, state.tick_seconds * 1000);
}

/**
 * One beat of the runner: a stepped day, or a paced one. A day that throws
 * leaves the estate part way through it, so it is dropped (#23's N8) —
 * nothing carries on from a world no seed grows; the page is told, and the
 * next request answers 503 until the estate is opened again.
 */
function beat(): void {
  if (!state) return;
  if (queued.step > 0 || !state.paused) {
    if (queued.step > 0) queued.step--;
    const { seed, day } = state.world;
    try {
      step(state);
    } catch (e) {
      // the half-ticked day is not saved: persist() stops once state is null,
      // and the store keeps the last whole day, marked with the day that threw
      state = null;
      if (held) void store.markCrashed(seed, day + 1);
      queued.step = 0;
      clearTimeout(timer);
      timer = undefined;
      post({ type: "error", id: null, message: `the estate stopped: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    void persist();
  }
  schedule();
}

/** The pace a control can change; the countdown restarts only when it does. */
const pace = (s: RunState) => `${s.paused}|${queued.step}|${s.tick_seconds}`;

function badRequest(m: unknown): string | null {
  if (!m || typeof m !== "object") return "a request must be an object";
  const r = m as Record<string, unknown>;
  if (typeof r.id !== "number") return "a request needs a numeric id";
  if (r.type === "open") {
    if (r.seed !== null && !Number.isSafeInteger(r.seed)) return "open's seed must be a whole number or null";
    return r.fresh === undefined || typeof r.fresh === "boolean" ? null : "open's fresh must be a boolean";
  }
  if (r.type === "flush") return null;
  if (r.type === "api") {
    if (typeof r.method !== "string") return "api's method must be a string";
    if (typeof r.path !== "string") return "api's path must be a string";
    if (r.body !== null && typeof r.body !== "string") return "api's body must be a string or null";
    return null;
  }
  return `unknown request ${JSON.stringify(r.type)}`;
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data as ToWorker | null;
  const id = m && typeof m === "object" && typeof m.id === "number" ? m.id : null;
  try {
    const bad = badRequest(m);
    if (bad) throw new TypeError(bad);
    if (m!.type === "open") {
      post({ type: "opened", id: id!, ...(await open(m!.seed, Boolean(m!.fresh))) });
    } else if (m!.type === "flush") {
      if (state) await persist();
      post({ type: "flushed", id: id! });
    } else {
      const a = m as Extract<ToWorker, { type: "api" }>;
      if (!state) {
        post({ type: "api", id: id!, status: 503, contentType: "application/json", body: JSON.stringify({ error: "the estate is not open yet" }) });
        return;
      }
      const before = pace(state);
      const r = respond(state, queued, a.method.toUpperCase(), a.path, a.body);
      // A control that changed the pace restarts the countdown, so the next
      // day follows it. This is where TS and web.py part on wall-clock pace
      // (only the pace: which day comes next is the seed's): web.py's
      // stop.wait(tick_seconds) is not woken by a control, so there a new
      // pace waits out the current day, and a step queued and then
      // unpaused comes STEP_GAP (100 ms) after the control here, where
      // web.py takes it on its next wake. A control that changes nothing
      // ({} or a repeat) leaves the countdown alone.
      if (r.status === 200 && pace(state) !== before) schedule();
      if (a.path === "/api/control" && r.status === 200) void persist();
      post({ type: "api", id: id!, ...r });
    }
  } catch (e) {
    post({ type: "error", id, message: e instanceof Error ? e.message : String(e) });
  }
};

self.onmessageerror = () => post({ type: "error", id: null, message: "a request could not be read" });
