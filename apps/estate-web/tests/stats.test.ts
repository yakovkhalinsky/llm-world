/** statistics.mean against Python's own, on awkward data. */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PYTHON } from "../scripts/parity.ts";
import { floatRepr } from "../src/py/num.ts";
import { meanFloat, meanInts } from "../src/py/stats.ts";
import { PyRandom } from "../src/py/random.ts";

const r = new PyRandom("stats");
const floatSets: number[][] = [
  [0.1, 0.2, 0.3], [1e16, 1.0, -1e16], [0.0], [2.5, 2.5], [1 / 3, 2 / 3, 1e-300, 5e-324],
  Array.from({ length: 5000 }, () => r.random() * 4),
  Array.from({ length: 999 }, (_, i) => (i % 7) * 0.1 + 1e-9 * i),
];
const intSets: number[][] = [[1, 2, 3, 4], [1, 2], [3, 3, 4], [0], [7, 7, 8, 9, 11, 13], Array.from({ length: 1092 }, (_, i) => (i * 37) % 23)];

describe("statistics.mean", () => {
  const py = JSON.parse(execFileSync(PYTHON, ["-c",
    "import json,statistics,sys; d=json.load(sys.stdin); " + // JSON drops .0: float() puts it back
    
    "print(json.dumps([[repr(statistics.mean([float(v) for v in x])) for x in d['f']], [repr(statistics.mean(x)) for x in d['i']]]))"],
  { input: JSON.stringify({ f: floatSets, i: intSets }), encoding: "utf8" })) as [string[], string[]];
  it("floats: summed exactly, rounded once", () => {
    expect(floatSets.map((x) => floatRepr(meanFloat(x)))).toEqual(py[0]);
  });
  it("ints: an int when whole, else the rounded float", () => {
    expect(intSets.map((x) => { const m = meanInts(x); return "int" in m ? String(m.int) : floatRepr(m.float); })).toEqual(py[1]);
  });
});
