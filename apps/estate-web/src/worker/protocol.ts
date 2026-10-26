/**
 * Messages between the page and the simulation worker. Every request has
 * an id and every reply carries the id it answers.
 *
 * `open` plants an estate; `api` is one of page3d's requests (GET
 * /api/ground, /api/state, /api/plain, POST /api/control), answered as
 * web.py answers it — a status, a content type and a body.
 */
export type ToWorker =
  | { type: "open"; id: number; seed: number | null }
  | { type: "api"; id: number; method: string; path: string; body: string | null };

export interface Opened { seed: number; day: number }

export type FromWorker =
  | ({ type: "opened"; id: number } & Opened)
  | { type: "api"; id: number; status: number; contentType: string; body: string }
  | { type: "error"; id: number | null; message: string };
