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
import { ESTATE, PYTHON, compareGen, firstDiff } from "../scripts/parity.ts";

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
