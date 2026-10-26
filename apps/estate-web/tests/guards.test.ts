/**
 * The edges #23's review found where JavaScript and Python part ways on
 * input the engine does not produce today but a model answer or a future
 * rule could: prototype keys, whitespace, NaN weights, integer-like keys,
 * a zero step.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { range } from "../src/py/num.ts";
import { PyRandom } from "../src/py/random.ts";
import { pyStrip } from "../src/py/text.ts";
import { decide } from "../src/sim/decide.ts";
import { QUIET, validate } from "../src/sim/watcher.ts";
import { PYTHON } from "../scripts/parity.ts";

describe("watcher.validate", () => {
  it("refuses prototype keys as fates, as Python's `in` on a dict does", () => {
    for (const fate of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(validate({ fate }).fate).toBe(QUIET);
    }
    expect(validate(JSON.parse('{"__proto__": {"region": "all"}, "fate": "rain"}')).fate).toBe("rain");
  });

  it("strips the why as str.strip() does", () => {
    expect(validate({ fate: "rain", why: "\u001c wet \u0085" }).why).toBe("wet");
    expect(validate({ fate: "rain", why: "\ufeffwet" }).why).toBe("\ufeffwet");
  });
});

describe("pyStrip", () => {
  it("strips exactly what CPython's str.strip() strips", () => {
    const all = Array.from({ length: 0x3001 }, (_, i) => String.fromCharCode(i)).join("") + "\ufeff";
    const py = execFileSync(PYTHON, ["-c",
      "import sys, json; s = json.load(sys.stdin); print(json.dumps([c for c in s if c.strip() == '']))"],
    { input: JSON.stringify(all), encoding: "utf8" });
    const js = [...all].filter((c) => pyStrip(c) === "");
    expect(js).toEqual(JSON.parse(py));
  });
});

describe("decide", () => {
  const rng = () => new PyRandom("1");
  it("treats a NaN weight as Python's max(0.0, nan) does: as 0.0", () => {
    const a = decide({ q: { type: "choice", options: { a: Number.NaN, b: 1.0 } } }, rng());
    expect(a.q!.probs).toEqual({ a: 0, b: 1 });
  });
  it("refuses an integer-like option key rather than roll in a different order", () => {
    expect(() => decide({ q: { type: "choice", options: { b: 1, 2: 1 } } }, rng())).toThrow(/array index/);
  });
});

describe("range", () => {
  it("refuses a zero step, as Python raises ValueError", () => {
    expect(() => range(5, 1, 0)).toThrow(/zero/);
    expect(() => range(1, 5, 0)).toThrow(/zero/);
  });
});
