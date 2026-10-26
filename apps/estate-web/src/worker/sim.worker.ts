/// <reference lib="webworker" />
/**
 * The simulation lives here, off the page's thread: the page asks, the
 * worker plants or ticks the estate it holds and posts the world back.
 */
import { worldHash } from "../py/canon.ts";
import { tick } from "../sim/engine/tick.ts";
import type { Ev } from "../sim/engine/events.ts";
import { generate } from "../sim/gen.ts";
import type { World } from "../sim/world.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";

declare const self: DedicatedWorkerGlobalScope;

let world: World | null = null;

function post(m: FromWorker): void {
  self.postMessage(m);
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data as ToWorker | null;
  const id = m && typeof m === "object" && typeof m.id === "number" ? m.id : null;
  try {
    const t0 = performance.now();
    const events: Ev[] = [];
    if (m?.type === "gen") {
      world = generate(m.seed, m.width, m.height);
    } else if (m?.type === "tick") {
      if (world === null) throw new Error("nothing planted yet");
      if (!Number.isSafeInteger(m.days) || m.days < 0) throw new RangeError(`days must be a whole number ≥ 0, not ${m.days}`);
      try {
        for (let n = 0; n < m.days; n++) events.push(...tick(world));
      } catch (e) {
        // a tick that threw left the estate part way through a day: drop
        // it, so no later request carries on from a world no seed grows
        world = null;
        throw e;
      }
    } else {
      throw new TypeError(`unknown request ${JSON.stringify((m as { type?: unknown } | null)?.type)}`);
    }
    post({ type: "world", id: id!, world, hash: worldHash(world), ms: performance.now() - t0, events });
  } catch (e) {
    post({ type: "error", id, message: e instanceof Error ? e.message : String(e) });
  }
};

self.onmessageerror = () => post({ type: "error", id: null, message: "a request could not be read" });
