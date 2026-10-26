/// <reference lib="webworker" />
/**
 * The simulation lives here, off the page's thread: the page asks, the
 * worker plants (and, from PR 2, ticks) and posts the world back.
 */
import { worldHash } from "../py/canon.ts";
import { generate } from "../sim/gen.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";

declare const self: DedicatedWorkerGlobalScope;

function post(m: FromWorker): void {
  self.postMessage(m);
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  try {
    if (m.type === "gen") {
      const t0 = performance.now();
      const world = generate(m.seed, m.width, m.height);
      post({ type: "world", world, hash: worldHash(world), ms: performance.now() - t0 });
    }
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
