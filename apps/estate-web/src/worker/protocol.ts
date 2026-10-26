/** Messages between the page and the simulation worker. PR 1 plants only. */
import type { World } from "../sim/world.ts";

export type ToWorker = { type: "gen"; seed: number; width?: number; height?: number };
export type FromWorker =
  | { type: "world"; world: World; hash: string; ms: number }
  | { type: "error"; message: string };
