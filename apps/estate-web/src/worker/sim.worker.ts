/// <reference lib="webworker" />
/**
 * The estate lives here, off the page's thread — web.py's server and its
 * runner thread in one. The worker holds the estate, keeps its pace (a day
 * every `tick_seconds`, paused, or a few days stepped), answers the page's
 * requests and saves after every day.
 *
 * The pace is the only thing the wall clock touches. Which day comes next,
 * when the watcher looks, what it chooses and what the chronicle says all
 * come from the seed, so a saved estate resumed is the estate it was.
 */
import * as api from "../view/api.ts";
import { plant, step, type RunState } from "../view/runner.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";
import * as store from "./store.ts";

declare const self: DedicatedWorkerGlobalScope;

/** web.py waits 0.1 s between stepped days. */
const STEP_GAP = 100;
const DEFAULT_SEED = 1;

let state: RunState | null = null;
let stepping = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<void> | null = null;
let dirty = false;

function post(m: FromWorker): void {
  self.postMessage(m);
}

/** Save now, or once the save in hand is done; saves never overlap. */
function persist(): Promise<void> {
  dirty = true;
  if (saving) return saving;
  saving = (async () => {
    while (dirty && state) {
      dirty = false;
      await store.save(state);
    }
    saving = null;
  })();
  return saving;
}

function schedule(now = false): void {
  clearTimeout(timer);
  timer = undefined;
  if (!state) return;
  if (now) timer = setTimeout(beat, 0);
  else if (stepping > 0) timer = setTimeout(beat, STEP_GAP);
  else if (!state.paused) timer = setTimeout(beat, state.tick_seconds * 1000);
}

function beat(): void {
  if (!state) return;
  if (stepping > 0 || !state.paused) {
    if (stepping > 0) stepping--;
    step(state);
    void persist();
  }
  schedule();
}

async function open(seed: number | null, fresh: boolean) {
  const s = seed ?? (await store.lastSeed()) ?? DEFAULT_SEED;
  if (fresh) await store.forget(s);
  const saved = fresh ? undefined : await store.load(s);
  state = saved ?? plant(s);
  stepping = 0;
  await persist();
  // A new estate has its first day at once, as web.py's runner does on
  // start; a resumed one waits its pace, so a reload is not a day.
  schedule(!saved && !state.paused);
  return { seed: s, day: state.world.day, resumed: Boolean(saved), saving: await store.available() };
}

const JSON_TYPE = "application/json";

function answer(method: string, path: string, body: string | null): { status: number; contentType: string; body: string } {
  const json = (status: number, v: unknown) => ({ status, contentType: JSON_TYPE, body: JSON.stringify(v) });
  if (!state) return json(503, { error: "the estate is not open yet" });
  if (method === "GET") {
    if (path === "/api/ground") return json(200, api.ground(state.world));
    if (path === "/api/state") return json(200, api.snapshot(state));
    if (path === "/api/plain") return { status: 200, contentType: "text/plain; charset=utf-8", body: api.plain(state) };
  } else if (method === "POST" && path === "/api/control") {
    let req: unknown;
    try {
      req = JSON.parse(body || "{}");
    } catch {
      return json(400, { error: "the body is not JSON" });
    }
    if (req === null || typeof req !== "object" || Array.isArray(req)) return json(400, { error: "the body is not a JSON object" });
    const pace = { paused: state.paused, step: stepping, tick_seconds: state.tick_seconds };
    const err = api.control(pace, req);
    if (err) return json(400, { error: err });
    state.paused = pace.paused;
    state.tick_seconds = pace.tick_seconds;
    stepping = pace.step;
    void persist();
    schedule();
    return json(200, { ok: true });
  }
  return { status: 404, contentType: "text/plain; charset=utf-8", body: "no such thing" };
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data as ToWorker | null;
  const id = m && typeof m === "object" && typeof m.id === "number" ? m.id : null;
  try {
    if (m?.type === "open") {
      post({ type: "opened", id: id!, ...(await open(m.seed, Boolean(m.fresh))) });
    } else if (m?.type === "api") {
      post({ type: "api", id: id!, ...answer(m.method.toUpperCase(), m.path, m.body) });
    } else if (m?.type === "flush") {
      if (state) await persist();
      post({ type: "flushed", id: id! });
    } else {
      throw new TypeError(`unknown request ${JSON.stringify((m as { type?: unknown } | null)?.type)}`);
    }
  } catch (e) {
    post({ type: "error", id, message: e instanceof Error ? e.message : String(e) });
  }
};

self.onmessageerror = () => post({ type: "error", id: null, message: "a request could not be read" });

