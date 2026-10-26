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
import { path, pathMap, setPathStamp } from "../src/sim/engine/residents.ts";
import { tick } from "../src/sim/engine/tick.ts";
import { generate } from "../src/sim/gen.ts";
import type { World } from "../src/sim/world.ts";
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

  it("is linear on a long run of whitespace inside the text, as CPython's is", () => {
    const at = performance.now();
    for (const pad of [" ", "\u3000", "\t\n"]) {
      const s = ` a${pad.repeat(100_000)}a `;
      expect(pyStrip(s)).toBe(s.slice(1, -1));
      expect(pyStrip(pad.repeat(100_000))).toBe("");
    }
    expect(performance.now() - at).toBeLessThan(250);
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

describe("ids", () => {
  // world.ids leans on JS ordering a plain object's array-index keys
  // ascending; that holds only for canonical integer keys
  const canonical = (w: World) => {
    for (const c of ["buildings", "units", "fixtures", "residents", "households"] as const) {
      for (const k of Object.keys(w[c])) {
        const n = Number(k);
        expect(Number.isInteger(n) && n >= 0 && n < 2 ** 32 - 1 && String(n) === k, `${c}[${JSON.stringify(k)}]`).toBe(true);
        expect((w[c][k] as { id: number }).id).toBe(n);
      }
    }
  };
  it("are canonical integers in the planted estate and after a run with arrivals", () => {
    for (const seed of [1, 7]) {
      const w = generate(seed);
      canonical(w);
      for (let d = 0; d < 60; d++) tick(w);
      canonical(w);
    }
  });
});

describe("path's search stamp", () => {
  it("finds the same paths as the map search on either side of its wrap at 0x7fffffff", () => {
    const w = generate(3);
    const pts = Object.values(w.fixtures).map((f) => [f.x, f.y] as const);
    const pairs = pts.flatMap((a, i) => pts.slice(i + 1, i + 4).map((b) => [a, b] as const));
    expect(pairs.length).toBeGreaterThan(6);
    const want = pairs.map(([a, b]) => pathMap(w, a[0], a[1], b[0], b[1]));
    path(w, pairs[0]![0][0], pairs[0]![0][1], pairs[0]![1][0], pairs[0]![1][1]); // size the scratch first
    try {
      setPathStamp(0x7fffffff - 3);
      // the third search wraps: the arrays are cleared and the stamp starts at 1
      const got = pairs.map(([a, b]) => path(w, a[0], a[1], b[0], b[1]));
      expect(got).toEqual(want);
    } finally {
      setPathStamp(0);
    }
  });
});
