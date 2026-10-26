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

async function open(seed: number | null, fresh: boolean) {
  const s = seed ?? (await store.lastSeed()) ?? DEFAULT_SEED;
  if (fresh) await store.forget(s);
  const saved = fresh ? undefined : await store.load(s);
  state = saved ?? plant(s);
  queued.step = 0;
  await persist();
  // A new estate has its first day at once, as web.py's runner does on
  // start; a resumed one waits its pace, so a reload is not a day.
  schedule(!saved && !state.paused);
  return { seed: s, day: state.world.day, resumed: Boolean(saved), saving: await store.available() };
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
    void persist();
  }
  schedule();
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data as ToWorker | null;
  const id = m && typeof m === "object" && typeof m.id === "number" ? m.id : null;
  try {
    if (m?.type === "open") {
      post({ type: "opened", id: id!, ...(await open(m.seed, Boolean(m.fresh))) });
    } else if (m?.type === "api") {
      if (!state) {
        post({ type: "api", id: id!, status: 503, contentType: "application/json", body: JSON.stringify({ error: "the estate is not open yet" }) });
        return;
      }
      const r = respond(state, queued, m.method.toUpperCase(), m.path, m.body);
      // a control may pause, step or re-pace the estate: the next beat follows it
      if (m.path === "/api/control" && r.status === 200) {
        void persist();
        schedule();
      }
      post({ type: "api", id: id!, ...r });
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
