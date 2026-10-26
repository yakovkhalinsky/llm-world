/// <reference lib="webworker" />
/**
 * The estate lives here, off the page's thread — web.py's server and its
 * runner thread in one. The worker holds the estate, keeps its pace (a day
 * every `tick_seconds`, paused, or a few days stepped) and answers the
 * page's requests.
 *
 * The pace is the only thing the wall clock touches. Which day comes next,
 * when the watcher looks and what it chooses all come from the seed.
 */
import { respond } from "../view/api.ts";
import { plant, step, type RunState } from "../view/runner.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";

declare const self: DedicatedWorkerGlobalScope;

/** web.py waits 0.1 s between stepped days. */
const STEP_GAP = 100;
const DEFAULT_SEED = 1;

let state: RunState | null = null;
const queued = { step: 0 };
let timer: ReturnType<typeof setTimeout> | undefined;

function post(m: FromWorker): void {
  self.postMessage(m);
}

function schedule(now = false): void {
  clearTimeout(timer);
  timer = undefined;
  if (!state) return;
  if (now) timer = setTimeout(beat, 0);
  else if (queued.step > 0) timer = setTimeout(beat, STEP_GAP);
  else if (!state.paused) timer = setTimeout(beat, state.tick_seconds * 1000);
}

function beat(): void {
  if (!state) return;
  if (queued.step > 0 || !state.paused) {
    if (queued.step > 0) queued.step--;
    step(state);
  }
  schedule();
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data as ToWorker | null;
  const id = m && typeof m === "object" && typeof m.id === "number" ? m.id : null;
  try {
    if (m?.type === "open") {
      state = plant(m.seed ?? DEFAULT_SEED);
      queued.step = 0;
      // the first day comes at once, as web.py's runner has it on start
      schedule(true);
      post({ type: "opened", id: id!, seed: state.world.seed, day: state.world.day });
    } else if (m?.type === "api") {
      if (!state) {
        post({ type: "api", id: id!, status: 503, contentType: "application/json", body: JSON.stringify({ error: "the estate is not open yet" }) });
        return;
      }
      const r = respond(state, queued, m.method.toUpperCase(), m.path, m.body);
      // a control may pause, step or re-pace the estate: the next beat follows it
      if (m.path === "/api/control" && r.status === 200) schedule();
      post({ type: "api", id: id!, ...r });
    } else {
      throw new TypeError(`unknown request ${JSON.stringify((m as { type?: unknown } | null)?.type)}`);
    }
  } catch (e) {
    post({ type: "error", id, message: e instanceof Error ? e.message : String(e) });
  }
};

self.onmessageerror = () => post({ type: "error", id: null, message: "a request could not be read" });
