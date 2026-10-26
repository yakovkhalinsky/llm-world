/**
 * The chronicle, written from templates (narrate.chronicle), keeps the
 * rules a model was only asked to keep:
 *   - only what happened: every death, birth, storm, sold-out shop and
 *     errand count it states is in that stretch's events or day books;
 *   - nobody invented: every resident it names is in the stretch's events
 *     or fraying now;
 *   - no repeats: no entry is word for word another the estate keeps;
 * and it comes every `pacing.chronicle_need` days, the seed's alone.
 */
import { describe, expect, it } from "vitest";
import { R } from "../src/sim/rules.ts";
import { snapshot } from "../src/view/api.ts";
import { plural, words } from "../src/view/render.ts";
import { KEEP_CHRONICLE, plant, step, type RunState } from "../src/view/runner.ts";

const NAMES = [...new Set(R.presentation.resident_names ?? [])];
const WORD = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const num = (s: string) => (WORD.includes(s.toLowerCase()) ? WORD.indexOf(s.toLowerCase()) : Number(s.replace(/,/g, "")));

interface Written { text: string; days: number[]; s: RunState }

/** Every entry written over a run, with its days and the run as it stood. */
function written(seed: number, days: number): { all: Written[]; s: RunState } {
  const s = plant(seed);
  const all: Written[] = [];
  let since: number[] = [];
  for (let i = 0; i < days; i++) {
    step(s);
    since.push(s.world.day);
    if (!s.run.length) {
      // the run is spent: an entry was written today
      const last = s.chronicle[s.chronicle.length - 1]!;
      expect(last.day).toBe(s.world.day);
      all.push({ text: last.text, days: since, s: structuredClone(s) });
      since = [];
    }
  }
  return { all, s };
}

describe.each([1, 42, 7])("seed %i, a year", (seed) => {
  const { all, s: end } = written(seed, 365);

  it("writes an entry every chronicle_need days, keeps 40 and shows 8", () => {
    expect(all.length).toBe(Math.floor(365 / R.pacing.chronicle_need));
    for (const x of all) expect(x.days.length).toBe(R.pacing.chronicle_need);
    expect(end.chronicle.length).toBe(KEEP_CHRONICLE);
    expect(snapshot(end).chronicle).toEqual(end.chronicle.slice(-8));
  });

  it("writes one to three plain sentences, each one new", () => {
    for (const { text } of all) {
      expect(text.trim(), text).not.toBe("");
      expect(text.split(/(?<=\.) /).length, text).toBeLessThanOrEqual(4);
      expect(text, text).not.toMatch(/undefined|null|NaN|\{|\}/);
    }
    all.forEach((x, i) => {
      const kept = all.slice(Math.max(0, i - KEEP_CHRONICLE + 1), i).map((y) => y.text);
      expect(kept, x.text).not.toContain(x.text);
    });
  });

  it("names nobody who is not in the stretch or fraying now", () => {
    for (const { text, days, s } of all) {
      const evs = s.events.filter((e) => e.day >= days[0]!);
      const said = evs.flatMap((e) => Object.values(e).filter((v): v is string => typeof v === "string")).join(" ");
      const fraying = Object.values(s.world.residents).filter((r) => r.stress >= 1).map((r) => r.name);
      for (const n of NAMES) {
        if (new RegExp(`\\b${n}\\b`).test(text)) {
          expect(fraying.includes(n) || new RegExp(`\\b${n}\\b`).test(said), `${n}: ${text}`).toBe(true);
        }
      }
    }
  });

  it("states only what the stretch's events and books bear out", () => {
    let checked = 0;
    for (const { text, days, s } of all) {
      const evs = s.events.filter((e) => e.day >= days[0]!);
      const has = (k: string) => evs.some((e) => e.kind === k);
      const books = days.map((d) => s.daybooks[d]).filter((b) => b !== undefined);
      const errands = books.reduce((p, b) => p + Object.values(b.uses ?? {}).reduce((q, r) => q + r, 0), 0);
      const t = text.toLowerCase();
      if (/\bdied\b|deaths? on the estate|estate lost (?!a tree)/.test(t)) expect(has("died"), text).toBe(true);
      if (/\bborn\b|new names? on the estate/.test(t)) expect(has("born"), text).toBe(true);
      if (/storms? (crossed|came through)/.test(t)) expect(has("storm"), text).toBe(true);
      if (/trees? came down|lost a tree/.test(t)) expect(has("tree_down"), text).toBe(true);
      if (/season turned/.test(t)) expect(has("turn"), text).toBe(true);
      if (/left the estate|moved away|said goodbye/.test(t)) expect(has("left"), text).toBe(true);
      if (/moved in|new neighbours|took in|new households/.test(t)) expect(has("moved_in"), text).toBe(true);
      if (/sold out|shelves were bare/.test(t)) expect(books.some((b) => b.sold_out), text).toBe(true);
      let m: RegExpMatchArray | null;
      if ((m = t.match(/([\d,]+) errands(,| over)/))) expect(num(m[1]!), text).toBe(errands);
      if ((m = t.match(/(?:rain|wet weather) on (\w+) of (\w+) days/))) {
        expect(num(m[1]!), text).toBe(books.filter((b) => b.weather === "rain" || b.weather === "storm").length);
        expect(num(m[2]!), text).toBe(books.length);
      }
      if (/not one errand run/.test(t)) expect(errands, text).toBe(0);
      if ((m = t.match(/the ([a-z ]+?) busiest after the shop/))) {
        const uses = (kind: string) => books.reduce((p, b) => p + (b.uses?.[kind] ?? 0), 0);
        const kinds = Object.keys(s.world.fixtures).length ? Object.values(s.world.fixtures).map((f) => f.kind) : [];
        const k = kinds.find((x) => words(x) === m![1] || plural(words(x)) === m![1]);
        expect(k, text).toBeDefined();
        expect(uses("shop"), text).toBeGreaterThanOrEqual(uses(k!));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("is the seed's: the same entries on every run", () => {
    const again = written(seed, 120).all.map((x) => x.text);
    expect(again.length).toBe(40);
    expect(again).toEqual(all.slice(0, again.length).map((x) => x.text));
  });
});
