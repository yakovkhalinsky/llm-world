/**
 * The int/float shape: which world fields are Python floats, declared in
 * src/sim/shape.ts, checked against the engine over real runs (fates and
 * all, so the fate fields appear).
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ESTATE, PYTHON } from "../scripts/parity.ts";
import { tick } from "../src/sim/engine/tick.ts";
import { generate } from "../src/sim/gen.ts";
import { FLOAT_FIELDS, numericPaths } from "../src/sim/shape.ts";
import * as watcher from "../src/sim/watcher.ts";

const SEEDS = [1, 2, 3], DAYS = 120, WATCH = 3;

describe("int/float shape", () => {
  const py = JSON.parse(execFileSync(PYTHON, [join(ESTATE, "tools/parity.py"), "shapes",
    "--seeds", SEEDS.join(","), "--days", String(DAYS), "--watch", String(WATCH)],
  { encoding: "utf8", maxBuffer: 1 << 26 })) as { float: string[]; int: string[] };

  const ts = new Set<string>();
  for (const seed of SEEDS) {
    const w = generate(seed);
    numericPaths(w, "$", ts);
    for (let n = 1; n <= DAYS; n++) {
      tick(w);
      if (n % WATCH === 0) watcher.queue(w, watcher.choose(w));
      numericPaths(w, "$", ts);
    }
  }

  it("no path holds both an int and a float in Python", () => {
    expect(py.float.filter((p) => py.int.includes(p))).toEqual([]);
  });
  it("the declared float fields are exactly Python's", () => {
    expect([...FLOAT_FIELDS].sort()).toEqual([...py.float].sort());
  });
  it("the port has numbers where Python has, and nowhere else", () => {
    expect([...ts].sort()).toEqual([...py.float, ...py.int].sort());
  });
}, 120_000);
