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
import { KEEP_EVENTS, plant, step } from "../src/view/runner.ts";
import type { Ev } from "../src/sim/engine/events.ts";
import * as W from "../src/sim/world.ts";
import { ESTATE, PYTHON } from "../scripts/parity.ts";

const HARNESS = join(import.meta.dirname, "web_harness.py");

function python(seed: number, days: number, pad = 0) {
  return JSON.parse(execFileSync(PYTHON, [HARNESS, String(seed), String(days), String(pad)],
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

describe("the event log's cap", () => {
  // ~1 event a day: 400 would take well over a year of ticks on both
  // sides, so the log starts with 380 placeholders, as the harness's does
  const PAD = 380;
  const py = python(5, 40, PAD);
  const s = plant(5);
  s.events = Array.from({ length: PAD }, (_, n) => ({ kind: "pad", n }) as unknown as Ev);
  for (let i = 0; i < 40; i++) step(s);

  it("prunes to the last 400 events as web.py's runner does", () => {
    expect(py.n_events).toBe(KEEP_EVENTS);
    expect(s.events.length).toBe(KEEP_EVENTS);
    expect(s.events[0]!.kind).toBe("pad");
    expect(hash16(canon(s.events))).toBe(py.events);
    expect(hash16(canon(s.world))).toBe(py.world);
  });
});

describe("dayLine at its thresholds", () => {
  // a day's book with `total` uses: the shop most, the benches next
  const book = (total: number, extra: Partial<W.Daybook> = {}): W.Daybook =>
    ({ uses: { shop: total - Math.floor(total / 3), bench: Math.floor(total / 3) }, out: 0, noise: 0, broke: 0, ...extra });
  const books: W.Daybook[] = [];
  for (const total of [1, 351, 352, 353, 399, 400, 401, 1000, 12345]) {
    for (const weather of [undefined, "clear", "rain", "heat", "frost", "storm"]) {
      books.push(book(total, weather === undefined ? {} : { weather }));
      books.push(book(total, { weather: weather ?? "clear", sold_out: true }));
    }
  }
  books.push({ uses: {}, out: 0, noise: 0, broke: 0 });
  books.push({ uses: { shop: 400 }, out: 0, noise: 0, broke: 0 });
  books.push({ uses: { tree: 200, bench: 200 }, out: 0, noise: 0, broke: 0 });

  it("writes every line as render.day_line does, 352|353 and 399|400 included", () => {
    const py = JSON.parse(execFileSync(PYTHON, [HARNESS, "lines"],
      { cwd: ESTATE, encoding: "utf8", input: JSON.stringify(books) })) as string[];
    expect(books.map((b) => dayLine(b))).toEqual(py);
    expect(new Set(py).size).toBeGreaterThan(30);
  });
});

it("writes thousands as Python's {:,} does", () => {
  expect([0, 999, 1000, -1234567].map(commas)).toEqual(["0", "999", "1,000", "-1,234,567"]);
});
