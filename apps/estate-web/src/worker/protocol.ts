/**
 * Messages between the page and the simulation worker. Every request has
 * an id and every reply carries the id it answers, so a reply to a stale
 * request (a plant superseded by another, a long tick) can be told apart.
 */
import type { World } from "../sim/world.ts";
import type { Ev } from "../sim/engine/events.ts";

export type ToWorker =
  | { type: "gen"; id: number; seed: number; width?: number; height?: number }
  | { type: "tick"; id: number; days: number };
export type FromWorker =
  | { type: "world"; id: number; world: World; hash: string; ms: number; events: Ev[] }
  | { type: "error"; id: number | null; message: string };
