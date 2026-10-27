/**
 * The watcher's why, written from templates (narrate.why), keeps the rules
 * a model was only asked to keep:
 *   - only what happened: every fact a why states is read back off the
 *     world and its day books on the day it was written;
 *   - nobody invented: every resident it names is a resident fraying now,
 *     or one born on the estate that week;
 *   - no repeats: a template is held back while others fit, so a line
 *     is never said twice running, unless it is the only one that fits;
 * and it is the seed's alone, the same on every run.
 */
import { describe, expect, it } from "vitest";
import { PyRandom } from "../src/py/random.ts";
import { R } from "../src/sim/rules.ts";
import * as W from "../src/sim/world.ts";
import type { Ev } from "../src/sim/engine/events.ts";
import { MEMORY, pick, whyOptions, type Memory } from "../src/view/narrate.ts";
import { plant, step, type RunState } from "../src/view/runner.ts";

const NAMES = [...new Set(R.presentation.resident_names ?? [])];
const WORD = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const num = (s: string) => (WORD.includes(s) ? WORD.indexOf(s) : Number(s.replace(/,/g, "")));

interface Why { day: number; fate: string; why: string; s: RunState }

/** Every why the watcher wrote over a run, with the run as it stood then. */
function whys(seed: number, days: number): Why[] {
  const s = plant(seed);
  const out: Why[] = [];
  for (let i = 0; i < days; i++) {
    step(s);
    if (s.last_watch.day === s.world.day) {
      out.push({ day: s.world.day, fate: s.last_watch.fate!, why: s.last_watch.why!, s: structuredClone(s) });
    }
  }
  return out;
}

describe.each([1, 42, 7])("seed %i, a year", (seed) => {
  const all = whys(seed, 365);

  it("writes a why every time the watcher looks", () => {
    expect(all.length).toBeGreaterThan(10);
    for (const x of all) expect(x.why.trim()).not.toBe("");
    // more than the pack's lines: the templates are in use
    const packs = new Set(Object.values(R.fates).map((f) => f.why));
    expect(all.filter((x) => !packs.has(x.why)).length).toBeGreaterThan(all.length / 3);
  });

  it("names nobody who is not fraying now or born that week", () => {
    for (const { why, s, day } of all) {
      const fraying = Object.values(s.world.residents).filter((r) => r.stress >= 1).map((r) => r.name);
      const born = s.events.filter((e) => e.kind === "born" && e.day > day - 7).map((e) => e.who);
      for (const n of NAMES) {
        if (new RegExp(`\\b${n}\\b`).test(why)) expect([...fraying, ...born], why).toContain(n);
      }
    }
  });

  it("states only facts the world and its books bear out", () => {
    for (const { why, s, day } of all) {
      const book = s.daybooks[day];
      const errands = Object.values(book?.uses ?? {}).reduce((p, q) => p + q, 0);
      let m: RegExpMatchArray | null;
      if ((m = why.match(/^([\d,]+) errands today/))) expect(num(m[1]!), why).toBe(errands);
      if ((m = why.match(/^(\w+) dry days/))) {
        for (let d = day; d > day - num(m[1]!); d--) expect(["rain", "storm"], why).not.toContain(s.daybooks[d]!.weather);
      }
      if ((m = why.match(/^(\w+) days without a storm/))) {
        for (let d = day; d > day - num(m[1]!); d--) expect(s.daybooks[d]!.weather, why).not.toBe("storm");
      }
      if (/sold out .* this week/.test(why)) {
        expect([...Array(7).keys()].some((i) => s.daybooks[day - i]?.sold_out), why).toBe(true);
      }
      if (/raining well enough/.test(why)) expect(s.world.weather).toBe("rain");
      if (/nobody is fraying/.test(why)) {
        expect(Object.values(s.world.residents).some((r) => r.stress >= 1 && r.name), why).toBe(false);
      }
      if ((m = why.match(/^the (.+) has been wearing thin/))) {
        expect(Object.values(s.world.fixtures).some((f) => f.kind.replace(/_/g, " ") === m![1] && f.condition > 0 && f.condition < 0.35), why).toBe(true);
      }
    }
  });

  it("is the seed's: the same whys on every run", () => {
    expect(whys(seed, 120).map((x) => x.why)).toEqual(all.filter((x) => x.day <= 120).map((x) => x.why));
  });
});

describe("each fact's threshold, a day either side", () => {
  const base = () => {
    const s = plant(1);
    for (let i = 0; i < 20; i++) step(s);
    for (const f of Object.values(s.world.fixtures)) f.condition = 1;
    return s;
  };
  /** day books for the last `n` days dry, the one before wet */
  const books = (day: number, dry: number): Record<number, W.Daybook> => {
    const b: Record<number, W.Daybook> = {};
    for (let d = day; d > day - 64; d--) b[d] = { uses: {}, out: 0, noise: 0, broke: 0, weather: d > day - dry ? "sun" : "rain" };
    return b;
  };
  const ids = (s: RunState, fate: string, b: Record<number, W.Daybook>, evs: Ev[] = [], region = "all") =>
    whyOptions(s.world, { fate, region, why: "" }, b, evs).map(([id]) => id);

  it("a dry spell: two days hold off, three want rain", () => {
    const s = base();
    const d = s.world.day;
    expect(ids(s, "rain", books(d, 1))).toEqual(["rain:pack"]);
    expect(ids(s, "rain", books(d, 2))).toEqual(["rain:held", "rain:pack"]);
    expect(ids(s, "rain", books(d, 3))).toEqual(["rain:dry", "rain:held", "rain:pack"]);
  });

  it("born this week: six days back is new, seven is not", () => {
    const s = base();
    const d = s.world.day;
    const born = (ago: number): Ev[] => [{ day: d - ago, kind: "born", who: "Ada", what: "" } as Ev];
    const b = books(d, 0);
    expect(ids(s, "quiet", b, born(6))).toContain("quiet:born");
    expect(ids(s, "quiet", b, born(7))).not.toContain("quiet:born");
    expect(whyOptions(s.world, { fate: "quiet", region: "all", why: "" }, b, born(6)).find(([id]) => id === "quiet:born")![1])
      .toMatch(/^Ada is new on the estate/);
  });

  it("the shop's shelves: under half is said, half is not", () => {
    const s = base();
    const shop = Object.values(s.world.fixtures).find((f) => f.kind === "shop")!;
    const full = R.fixtures.shop!.stock!;
    const at = (pct: number) => [...Array(full + 1).keys()].filter((x) => Math.round((100 * x) / full) === pct);
    const b = books(s.world.day, 0);
    shop.stock = Math.min(...at(50));
    expect(ids(s, "delivery", b)).not.toContain("delivery:stock");
    shop.stock = Math.max(...[...Array(full + 1).keys()].filter((x) => Math.round((100 * x) / full) < 50));
    expect(ids(s, "delivery", b)).toContain("delivery:stock");
  });

  it("damage names a worn fixture where it is aimed, before one elsewhere", () => {
    const s = base();
    const fx = Object.values(s.world.fixtures);
    const [region, a, b] = Object.keys(R.regions).flatMap((r) => {
      const inside = fx.filter((f) => W.inRegion(s.world, r, f.x, f.y));
      const outside = fx.filter((f) => !W.inRegion(s.world, r, f.x, f.y));
      const a = inside.find((f) => outside.some((o) => o.kind < f.kind));
      const b = a && outside.find((o) => o.kind < a.kind);
      return a && b ? [[r, a, b] as const] : [];
    })[0]!;
    a.condition = 0.2;
    b.condition = 0.2;
    const line = (r: string) => whyOptions(s.world, { fate: "damage", region: r, why: "" }, books(s.world.day, 0), [])
      .find(([id]) => id === "damage:worn")![1];
    expect(line(region)).toBe(`the ${a.kind.replace(/_/g, " ")} has been wearing thin`);
    expect(line("all")).toBe(`the ${b.kind.replace(/_/g, " ")} has been wearing thin`);
  });
});

describe("pick", () => {
  const opts = (n: number) => [...Array(n).keys()].map((i) => [`t:${i}`, `line ${i}`] as [string, string]);

  it("never says the last line again while another fits", () => {
    const rng = new PyRandom("pick");
    const mem: Memory = { used: [] };
    for (const n of [2, 3, 5, 8]) {
      let last = "";
      for (let i = 0; i < 200; i++) {
        const line = pick(rng, mem, opts(n));
        expect(line).not.toBe(last);
        last = line;
      }
    }
  });

  it("keeps a said line back for half as many picks as there are lines, and remembers only so much", () => {
    const rng = new PyRandom("round");
    const mem: Memory = { used: [] };
    for (const n of [4, 6, 9]) {
      const said = [...Array(120)].map(() => pick(rng, mem, opts(n)));
      said.forEach((line, i) => expect(said.slice(Math.max(0, i - Math.floor(n / 2)), i)).not.toContain(line));
      // and never settles into a fixed round
      expect(said.slice(0, n).join()).not.toBe(said.slice(n, 2 * n).join());
    }
    for (let i = 0; i < 100; i++) pick(rng, mem, opts(40));
    expect(mem.used.length).toBe(MEMORY);
  });

  it("says the one line there is, however lately said", () => {
    const mem: Memory = { used: ["only"] };
    expect(pick(new PyRandom("one"), mem, [["only", "the pack's line"]])).toBe("the pack's line");
  });
});
