/**
 * The bar: from the same seed, Python apps/estate and this port plant the
 * same estate — the same canonical world hash, not a similar one.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canon, worldHash } from "../src/py/canon.ts";
import { generate } from "../src/sim/gen.ts";
import { ESTATE, PYTHON, compare, compareGen, firstDiff, marksFor, parseSeeds } from "../scripts/parity.ts";

describe("rules.json", () => {
  it("is what the Python engine reads today (npm run rules to refresh)", () => {
    const live = execFileSync(PYTHON, [join(ESTATE, "tools/export_rules.py")], { encoding: "utf8" });
    const committed = readFileSync(resolve(import.meta.dirname, "../src/sim/rules.json"), "utf8");
    expect(committed).toBe(live);
  });
});

describe("world generation", () => {
  const results = compareGen("1-8,42,3771");
  for (const r of results) {
    it(`seed ${r.seed}: the planted estate hashes the same (${r.python})`, () => {
      expect(r.diff ?? null).toBeNull();
      expect(r.ts).toBe(r.python);
    });
  }

  it("is deterministic in-process, and the hash sees a one-cell change", () => {
    const a = generate(42);
    const b = generate(42);
    expect(worldHash(a)).toBe(worldHash(b));
    b.cells[5]![5]!.wear = 0.25;
    expect(worldHash(a)).not.toBe(worldHash(b));
    expect(firstDiff(JSON.parse(canon(a)), JSON.parse(canon(b)))).toBe("$.cells[5][5].wear: 0 != 0.25");
  });

  it("refuses a plan too small for its recipe, loudly", () => {
    expect(() => generate(1, 20, 20)).toThrow(/blocks in a row/);
    expect(() => generate(1, 0, 10)).toThrow(/positive/);
    expect(() => generate(1, 201, 30)).toThrow(/at most/);
  });

  it("matches Python on a larger plan too", () => {
    const py = execFileSync(PYTHON, ["-c",
      "import sys; sys.path.insert(0, '.'); from estate import gen; from tools.parity import world_hash; " +
      "print(world_hash(gen.generate(7, 60, 44)))"], { cwd: ESTATE, encoding: "utf8" }).trim();
    expect(worldHash(generate(7, 60, 44))).toBe(py);
  });
});

describe("the harness refuses to pass on nothing", () => {
  it("reads seed specs as parity.py does, and refuses junk", () => {
    expect(parseSeeds("1-3,42")).toEqual([1, 2, 3, 42]);
    for (const bad of ["", ",", "x", "3-1", "1-", "-4", "1.5"]) expect(() => parseSeeds(bad)).toThrow();
  });
  it("marks day 0, every K-th day and the last", () => {
    expect(marksFor(0, 0)).toEqual([0]);
    expect(marksFor(10, 4)).toEqual([0, 4, 8, 10]);
  });
  it("compares every seed it asked for, at every mark", () => {
    const r = compare("1,3", 6, 3, 2);
    expect(r.map((x) => [x.seed, x.days])).toEqual([[1, 0], [1, 3], [1, 6], [3, 0], [3, 3], [3, 6]]);
  });
});

describe("the tick, the rules and the watcher", () => {
  // Every seed, 13 weeks, a fate queued every third day: the world hash and
  // the events since the last mark, both sides. (npm run parity -- --days
  // 364 for the long run.)
  const results = compare("1-8,42,3771", 91, 7, 3);
  it("compares 140 marks", () => expect(results.length).toBe(140));
  for (const r of results) {
    it(`seed ${r.seed} day ${r.days}: ${r.python} / events ${r.pyEvents}`, () => {
      expect(r.diff ?? null).toBeNull();
      expect([r.ts, r.tsEvents]).toEqual([r.python, r.pyEvents]);
    });
  }
});
