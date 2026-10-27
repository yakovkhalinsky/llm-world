/**
 * The worker's loop, run in-process: `self` is a stand-in that records what
 * the worker posts. A day that throws must drop the estate (#23's N8), not
 * leave a half-ticked world for the next control to carry on from.
 */
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { FromWorker } from "../src/worker/protocol.ts";

const boom = { on: false };
vi.mock("../src/view/runner.ts", async (orig) => {
  const real = await orig<typeof import("../src/view/runner.ts")>();
  return { ...real, step: (s: Parameters<typeof real.step>[0]) => { if (boom.on) throw new Error("boom"); real.step(s); } };
});

const posted: FromWorker[] = [];
const self = { postMessage: (m: FromWorker) => posted.push(m), onmessage: null as null | ((e: { data: unknown }) => unknown) };
/** onmessage is async once the store is in: wait for its answer */
const send = async (data: unknown) => { await self.onmessage!({ data }); };

beforeAll(async () => {
  vi.useFakeTimers();
  (globalThis as { self?: unknown }).self = self;
  await import("../src/worker/sim.worker.ts");
});
afterEach(() => { posted.length = 0; boom.on = false; });

it("drops the estate when a day throws, and says so", async () => {
  await send({ type: "open", id: 1, seed: 3 });
  expect(posted.at(-1)).toMatchObject({ type: "opened", id: 1, seed: 3 });
  boom.on = true;
  vi.advanceTimersByTime(0);
  expect(posted.at(-1)).toMatchObject({ type: "error", id: null, message: expect.stringContaining("boom") });
  boom.on = false;
  await send({ type: "api", id: 2, method: "POST", path: "/api/control", body: '{"step":1}' });
  expect(posted.at(-1)).toMatchObject({ type: "api", id: 2, status: 503 });
  // nothing is left scheduled to tick a dropped world
  expect(vi.getTimerCount()).toBe(0);
});

it("refuses a malformed request as a protocol error", async () => {
  await send({ type: "open", id: 1, seed: 3 });
  for (const [m, why] of [
    [{ type: "api", id: 5, path: "/api/state", body: null }, /method/],
    [{ type: "api", id: 6, method: "GET", path: 7, body: null }, /path/],
    [{ type: "api", id: 7, method: "POST", path: "/api/control", body: {} }, /body/],
    [{ type: "open", id: 8, seed: "x" }, /seed/],
    [{ type: "nope", id: 9 }, /unknown request/],
  ] as const) {
    await send(m);
    expect(posted.at(-1)).toMatchObject({ type: "error", id: m.id, message: expect.stringMatching(why) });
  }
});

it("restarts the countdown only when a control changes the pace", async () => {
  await send({ type: "open", id: 1, seed: 3 });
  await send({ type: "api", id: 2, method: "POST", path: "/api/control", body: '{"paused":true}' });
  const spy = vi.spyOn(globalThis, "clearTimeout");
  await send({ type: "api", id: 3, method: "POST", path: "/api/control", body: "{}" });
  await send({ type: "api", id: 4, method: "POST", path: "/api/control", body: '{"paused":true}' });
  expect(spy).not.toHaveBeenCalled();
  await send({ type: "api", id: 5, method: "POST", path: "/api/control", body: '{"step":1}' });
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});
