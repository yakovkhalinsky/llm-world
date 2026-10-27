/**
 * Messages between the page and the simulation worker. Every request has
 * an id and every reply carries the id it answers.
 *
 * `open` plants or resumes an estate; `api` is one of page3d's requests
 * (GET /api/ground, /api/state, /api/plain, POST /api/control), answered
 * as web.py answers it — a status, a content type and a body.
 */
export type ToWorker =
  | { type: "open"; id: number; seed: number | null; fresh?: boolean }
  | { type: "api"; id: number; method: string; path: string; body: string | null }
  | { type: "flush"; id: number };

export interface Opened {
  seed: number; day: number; resumed: boolean;
  /** whether the estate is being kept, and if not why ("open in another tab", "storage full", …) */
  saving: boolean; why: string;
  /** the day this saved estate stopped on last time, if it did */
  crashed?: number;
}

export type FromWorker =
  | ({ type: "opened"; id: number } & Opened)
  | { type: "api"; id: number; status: number; contentType: string; body: string }
  | { type: "flushed"; id: number }
  /** a save's outcome changed: the estate stopped being kept, or is kept again */
  | { type: "saving"; id: null; ok: boolean; why: string }
  | { type: "error"; id: number | null; message: string };

/** The requests page3d makes that the worker answers; anything else is fetched. */
export const API_PATHS: ReadonlySet<string> = new Set(["/api/ground", "/api/state", "/api/plain", "/api/control"]);
