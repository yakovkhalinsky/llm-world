/**
 * A saved estate resumed is the estate it was: IndexedDB keeps a run by
 * structured clone, and a clone stepped on matches the run that never
 * stopped, day for day. With no IndexedDB (as here, in Node) the store
 * answers quietly that nothing is kept.
 */
import { expect, it } from "vitest";
import { worldHash } from "../src/py/canon.ts";
import { plant, step } from "../src/view/runner.ts";
import * as store from "../src/worker/store.ts";

it("resumes a structured-clone save exactly where the run would have gone", () => {
  const run = plant(7);
  for (let d = 0; d < 40; d++) step(run);
  const resumed = structuredClone(run);
  for (let d = 0; d < 40; d++) {
    step(run);
    step(resumed);
  }
  expect(worldHash(resumed.world)).toBe(worldHash(run.world));
  expect(resumed).toEqual(run);
});

it("keeps nothing, and fails nothing, without IndexedDB", async () => {
  expect(await store.available()).toBe(false);
  expect(await store.load(7)).toBeUndefined();
  expect(await store.lastSeed()).toBeUndefined();
  expect(await store.save(plant(7))).toEqual({ ok: false, why: "no storage here" });
  expect(await store.claim(7)).toBeTypeOf("function"); // no locks here either: this tab may save
  await expect(store.forget(7)).resolves.toBeUndefined();
});
