/**
 * The Python shims against Python itself: tools/parity.py `vectors` prints
 * reference values from CPython, and every one must come back identical.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { divmod, floatRepr, pyRound, pySum } from "../src/py/num.ts";
import { PyRandom } from "../src/py/random.ts";
import { ESTATE, PYTHON } from "../scripts/parity.ts";

interface Draws {
  seed: string; random: number[]; bits: number[]; below: number[]; randint: number[];
  choice: number[]; shuffle: number[]; after: number; big: number[]; long: number[];
}
type F = number | "inf" | "-inf" | "nan" | "-0.0"; // JSON has no non-finite floats
interface Vectors {
  rng: Draws[];
  round: [number, number][];
  round_n: [number, number, number][];
  divmod: [number, number, number, number, boolean][];
  sum: [F[], F][];
  sum_mixed: [number[], boolean[], number, boolean][];
  repr: [F, string][];
  twist: { seed: string; words: number[]; even: number[]; first: number; odd: number[] }[];
}

const V = JSON.parse(
  execFileSync(PYTHON, [join(ESTATE, "tools/parity.py"), "vectors"], { encoding: "utf8", maxBuffer: 1 << 26 }),
) as Vectors;

const f = (x: F): number =>
  x === "inf" ? Infinity : x === "-inf" ? -Infinity : x === "nan" ? NaN : x === "-0.0" ? -0 : x;

describe("the vectors", () => {
  it("are all there (an empty group would pass vacuously)", () => {
    expect(V.rng.length).toBeGreaterThanOrEqual(7);
    for (const k of ["round", "round_n", "divmod", "sum", "sum_mixed", "repr"] as const) {
      expect(V[k].length, k).toBeGreaterThan(50);
    }
  });
});

describe("random.Random", () => {
  for (const d of V.rng) {
    it(`draws the same as Python for seed ${JSON.stringify(d.seed)}`, () => {
      const r = new PyRandom(d.seed);
      expect(Array.from({ length: 5 }, () => r.random())).toEqual(d.random);
      expect(Array.from({ length: 33 }, (_, k) => r.getrandbits(k))).toEqual(d.bits);
      expect([1, 2, 3, 5, 7, 40, 30, 47, 1000, 2 ** 31 + 1].map((n) => r.randrange(n))).toEqual(d.below);
      expect(([[2, 16], [19, 78], [7, 9], [0, 0]] as const).map(([a, b]) => r.randint(a, b))).toEqual(d.randint);
      expect(Array.from({ length: 6 }, () => r.choice([2, 2, 3, 4]))).toEqual(d.choice);
      const xs = Array.from({ length: 25 }, (_, i) => i);
      r.shuffle(xs);
      expect(xs).toEqual(d.shuffle);
      expect(r.random()).toBe(d.after);
      const big = [...Array.from({ length: 3 }, () => r.randrange(2 ** 32 - 1)),
        ...Array.from({ length: 3 }, () => r.randrange(2 ** 31))];
      expect(big).toEqual(d.big);
      expect(Array.from({ length: 1500 }, () => r.random()).slice(-5)).toEqual(d.long);
    });
  }
});

describe("random.Random's lazy twist", () => {
  // N = 624, M = 397: words below N-M = 227 are twisted as drawn, the rest
  // in one go; then the second state at 624, the third at 1248
  const EDGES = [0, 1, 226, 227, 228, 396, 397, 622, 623, 624, 625, 1247, 1248, 1249];
  for (const t of V.twist ?? []) {
    it(`draws every word as CPython does across the twist, seed ${JSON.stringify(t.seed)}`, () => {
      expect(t.words.length).toBe(1300);
      const r = new PyRandom(t.seed);
      const words = Array.from({ length: 1300 }, () => r.getrandbits(32));
      for (const k of EDGES) expect(words[k], `word ${k}`).toBe(t.words[k]);
      expect(words).toEqual(t.words);
    });
    it(`draws random() across the boundaries from word 0 and word 1, seed ${JSON.stringify(t.seed)}`, () => {
      const even = new PyRandom(t.seed);
      expect(Array.from({ length: 650 }, () => even.random())).toEqual(t.even);
      const odd = new PyRandom(t.seed);
      expect(odd.getrandbits(32)).toBe(t.first);
      expect(Array.from({ length: 650 }, () => odd.random())).toEqual(t.odd);
    });
  }
  it("has its vectors", () => expect(V.twist.length).toBe(3));
});

describe("arithmetic", () => {
  it("round(x) is banker's", () => {
    for (const [x, want] of V.round) expect([x, pyRound(x)]).toEqual([x, want]);
  });
  it("round(x, n) is correctly rounded, ties to even", () => {
    for (const [x, n, want] of V.round_n) expect([x, n, pyRound(x, n)]).toEqual([x, n, want]);
  });
  it("divmod, // and % follow the divisor's sign", () => {
    for (const [a, b, q, m, ints] of V.divmod) expect([a, b, ...divmod(a, b, ints)]).toEqual([a, b, q, m]);
  });
  it("sum() of floats is Neumaier-compensated, as in 3.12+, through inf, nan and overflow", () => {
    for (const [xs, want] of V.sum) expect(pySum(xs.map(f))).toBe(f(want));
  });
  it("sum() of ints and floats takes CPython's int path, then adds ints uncompensated", () => {
    for (const [xs, mask, want] of V.sum_mixed) {
      expect([xs, pySum(xs, (_x, i) => mask[i]!)]).toEqual([xs, want]);
    }
  });
  it("sum() of a mixed list read as all floats is the known divergence", () => {
    expect(pySum([0.1, 1, -1])).toBe(0.1); // Python: 0.10000000000000009
    expect(pySum([0.1, 1, -1], (_x, i) => i > 0)).toBe(0.10000000000000009);
  });
  it("repr(float) is Python's, -0.0, inf and nan too", () => {
    for (const [x, want] of V.repr) expect([x, floatRepr(f(x))]).toEqual([x, want]);
  });
});

describe("the edges refuse rather than guess", () => {
  it("divmod of a non-finite number throws (Python gives nan; the sim never makes one)", () => {
    expect(() => divmod(Infinity, 1)).toThrow(/non-finite/);
    expect(() => divmod(NaN, 1)).toThrow(/non-finite/);
    expect(() => divmod(1, 0)).toThrow(/division by zero/);
  });
  it("round() to an int of nan or inf throws, as Python's does", () => {
    expect(() => pyRound(NaN)).toThrow();
    expect(() => pyRound(Infinity)).toThrow();
  });
  it("randrange() of a non-integer throws, as 3.12's does", () => {
    const r = new PyRandom("x");
    expect(() => r.randrange(0.5, 3.5)).toThrow(TypeError);
    expect(() => r.randrange(2.5)).toThrow(TypeError);
    expect(() => r.randrange(0)).toThrow(RangeError);
  });
  it("sum() refuses an int it can't hold exactly", () => {
    expect(() => pySum([2 ** 53, 1], () => true)).toThrow(/safe/);
  });
});
