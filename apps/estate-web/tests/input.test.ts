/** Seeds and sizes are safe integers, or refused — never quietly 0. */
import { describe, expect, it } from "vitest";
import { canon } from "../src/py/canon.ts";
import { generate } from "../src/sim/gen.ts";
import { parseSeed } from "../src/seed.ts";

describe("inputs", () => {
  it("generate refuses seeds and sizes that aren't safe integers", () => {
    for (const s of [1.5, NaN, Infinity, 2 ** 53, -(2 ** 53)]) expect(() => generate(s)).toThrow();
    expect(() => generate(1, 40.5, 30)).toThrow();
    expect(() => generate(1, 40, NaN)).toThrow();
  });
  it("the canonical domain closes at 2^53 on this side, as on Python's", () => {
    expect(canon(2 ** 53 - 1)).toBe("9007199254740991");
    expect(() => canon(2 ** 53)).toThrow();
    expect(() => canon(1e16)).toThrow();
    expect(() => canon([-(2 ** 53)])).toThrow();
  });
  it("the seed box takes whole numbers only", () => {
    expect(parseSeed("42")).toBe(42);
    expect(parseSeed(" -7 ")).toBe(-7);
    for (const bad of ["", "abc", "1.5", "1e3", "9007199254740993", "0x10"]) expect(parseSeed(bad)).toBeNull();
  });
});
