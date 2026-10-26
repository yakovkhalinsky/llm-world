/** A day's events: plain records, as the Python engine returns them. */
export type Ev = { day: number; kind: string; [k: string]: unknown };
