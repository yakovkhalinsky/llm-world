/**
 * The runner and the words, against web.py's runner (tests/web_harness.py):
 * after a run of days the two hold the same world, events, day books,
 * prev positions and watcher, and say every event, every day and the
 * no-WebGL frame in the same words.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canon, hash16 } from "../src/py/canon.ts";
import { dayLine, full, say, commas } from "../src/view/render.ts";
import { plant, step } from "../src/view/runner.ts";
import * as W from "../src/sim/world.ts";
import { ESTATE, PYTHON } from "../scripts/parity.ts";

const HARNESS = join(import.meta.dirname, "web_harness.py");

function python(seed: number, days: number) {
  return JSON.parse(execFileSync(PYTHON, [HARNESS, String(seed), String(days)],
    { cwd: ESTATE, encoding: "utf8", maxBuffer: 1 << 26 }));
}

describe.each([[1, 120], [42, 75]])("seed %i, %i days", (seed, days) => {
  const py = python(seed, days);
  const s = plant(seed);
  const said: string[] = [];
  for (let i = 0; i < days; i++) said.push(...step(s).map(say));
  const w = s.world;

  it("keeps what web.py's runner keeps", () => {
    expect(hash16(canon(w))).toBe(py.world);
    expect(hash16(canon(s.events))).toBe(py.events);
    expect(hash16(canon(s.daybooks))).toBe(py.daybooks);
    expect(s.prev).toEqual(py.prev);
    expect({ ...s.last_watch, next_watch: s.next_watch }).toEqual({ ...py.last_watch, next_watch: py.next_watch });
  });

  it("says every event and every day as render.py does", () => {
    expect(said).toEqual(py.said);
    expect(Object.fromEntries(Object.entries(s.daybooks).map(([d, b]) => [d, dayLine(b)]))).toEqual(py.lines);
  });

  it("draws the no-WebGL frame as render.full does", () => {
    const status = `${W.weekdayName(w.day)} · no watcher yet`;
    expect(full({ world: w, status, watcher_line: null, chronicle: [] })).toBe(py.plain);
  });
});

it("writes thousands as Python's {:,} does", () => {
  expect([0, 999, 1000, -1234567].map(commas)).toEqual(["0", "999", "1,000", "-1,234,567"]);
});
