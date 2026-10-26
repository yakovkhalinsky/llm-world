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
  choice: number[]; shuffle: number[]; after: number;
}
interface Vectors {
  rng: Draws[];
  round: [number, number][];
  round_n: [number, number, number][];
  divmod: [number, number, number, number][];
  sum: [number[], number][];
  repr: [number, string][];
}

const V = JSON.parse(
  execFileSync(PYTHON, [join(ESTATE, "tools/parity.py"), "vectors"], { encoding: "utf8", maxBuffer: 1 << 26 }),
) as Vectors;

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
    });
  }
});

describe("arithmetic", () => {
  it("round(x) is banker's", () => {
    for (const [x, want] of V.round) expect([x, pyRound(x)]).toEqual([x, want]);
  });
  it("round(x, n) is correctly rounded, ties to even", () => {
    for (const [x, n, want] of V.round_n) expect([x, n, pyRound(x, n)]).toEqual([x, n, want]);
  });
  it("divmod, // and % follow the divisor's sign", () => {
    for (const [a, b, q, m] of V.divmod) expect([a, b, ...divmod(a, b)]).toEqual([a, b, q, m]);
  });
  it("sum() is Neumaier-compensated, as in 3.12+", () => {
    for (const [xs, want] of V.sum) expect(pySum(xs)).toBe(want);
  });
  it("repr(float) is Python's", () => {
    for (const [x, want] of V.repr) expect([x, floatRepr(x)]).toEqual([x, want]);
  });
});
