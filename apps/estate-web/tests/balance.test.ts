/**
 * The balance gate's fingerprint, ported: one estate × one year here (the
 * full 8 × 3 is `npm run balance -- --fingerprint`, which must print
 * f5d9ea5e95da827c, as `python3 tools/balance.py --fingerprint` does).
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ESTATE, PYTHON } from "../scripts/parity.ts";
import { fingerprint, pyDumps, runOne } from "../scripts/balance.ts";

describe("balance fingerprint", () => {
  it("json.dumps as Python spells it", () => {
    expect(pyDumps({ b: [1, "é"], a: null })).toBe('{"a": null, "b": [1, "\\u00e9"]}');
  });
  it("seed 1, one year: the same fingerprint as tools/balance.py", () => {
    const py = execFileSync(PYTHON, [join(ESTATE, "tools/balance.py"), "--seeds", "1", "--years", "1", "--fingerprint"],
      { encoding: "utf8" }).trim();
    expect(fingerprint([runOne(1, 1)])).toBe(py);
  }, 180_000);
});
