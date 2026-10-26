/**
 * The turn of the year — ageing, deaths and births, which run only when
 * the day is a multiple of 364 — checked against Python on purpose rather
 * than by reaching it: the parity in CI stops at day 91, and a change to
 * the old-age rule otherwise slips past every test but the 3-year
 * fingerprint (#23's review, mutant A).
 *
 * Each case plants a seed, moves it to the eve of a year's turn, and ages
 * every adult to the edge of the old-age rule: half to `elder + 7` (one
 * birthday short of it) and half to `elder + 6`... then ticks the one day
 * on both sides. The worlds must hash the same, and the rule must be seen
 * at its edge: someone at `elder + 8` dies, nobody younger does, and a
 * household loses its last member.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { canon, hash16 } from "../src/py/canon.ts";
import { tick } from "../src/sim/engine/tick.ts";
import { generate } from "../src/sim/gen.ts";
import { R } from "../src/sim/rules.ts";
import type { World } from "../src/sim/world.ts";
import { ESTATE, PYTHON } from "../scripts/parity.ts";

const CASES: [seed: number, year: number][] = [[2, 3], [3, 1], [5, 1], [5, 3], [6, 2]];
const YEAR = R.world.days_per_season * 4;
const ELDER = R.people.ages.elder;

/** The same edits, in the same order, as `parity.py yearturn`. */
function eve(seed: number, year: number): World {
  const w = generate(seed);
  w.day = YEAR * year - 1;
  const adults = Object.values(w.residents).filter((r) => r.age >= R.people.ages.adult).sort((a, b) => a.id - b.id);
  adults.forEach((r, i) => { r.age = i % 2 === 0 ? ELDER + 7 : ELDER + 6; });
  return w;
}


describe("the turn of the year", () => {
  const python = JSON.parse(execFileSync(PYTHON, ["tools/parity.py", "yearturn", JSON.stringify(CASES)], { cwd: ESTATE, encoding: "utf8" })) as { hash: string; events: string }[];
  let died = 0;
  let emptied = 0;

  CASES.forEach(([seed, year], i) => {
    it(`seed ${seed}, day ${YEAR * year}: hashes as Python's`, () => {
      const w = eve(seed, year);
      const before = new Map(Object.values(w.residents).map((r) => [r.id, { name: r.name, age: r.age + 1 }]));
      const lone = Object.values(w.households).filter((h) => h.members.length === 1).map((h) => [h.id, h.members[0]!] as const);
      const evs = tick(w);
      expect(w.day % YEAR).toBe(0);
      expect({ hash: hash16(canon(w)), events: hash16(canon(evs)) }).toEqual(python[i]);
      // the dead are named; each is someone gone today who had reached the rule's age
      const gone = [...before].filter(([id]) => !(String(id) in w.residents)).map(([id, r]) => ({ id, ...r }));
      const dead = evs.filter((e) => e.kind === "died").map((e) => e.who as string);
      for (const who of dead) {
        expect(gone.some((r) => r.name === who && r.age >= ELDER + 8), `${who} died below elder + 8`).toBe(true);
      }
      died += dead.length;
      emptied += lone.filter(([h, m]) => !(String(h) in w.households) && dead.includes(before.get(m)!.name ?? "")).length;
    });
  });

  it("sees the rule at its edge: deaths at elder + 8, and a household's last member", () => {
    expect(died).toBeGreaterThan(0);
    expect(emptied).toBeGreaterThan(0);
  });
});
