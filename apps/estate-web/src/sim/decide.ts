/**
 * decide(): the estate's choices, made in code — apps/estate/estate/decide.py.
 *
 * The watcher's choice of a fate and a region is a seeded, weighted draw
 * over the estate's needs bands. In the browser there is no model, so this
 * is the whole of the watcher's choosing; its "why" is the pack's line.
 */
import type { PyRandom } from "../py/random.ts";
import { pyRound, pySum } from "../py/num.ts";
import { R } from "./rules.ts";
import * as W from "./world.ts";

export type Question =
  | { type: "choice"; options: Record<string, number> }
  | { type: "score"; levels: string[]; weights?: number[] };
export interface Answer { type: string; probs: Record<string, number>; pick: string; confidence: number }

export function decide(questions: Record<string, Question>, rng: PyRandom): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const name of Object.keys(questions).sort()) {
    const q = questions[name]!;
    let opts: [string, number][];
    if (q.type === "score") {
      const ws = q.weights && q.weights.length ? q.weights : q.levels.map(() => 1.0);
      opts = q.levels.slice(0, Math.min(q.levels.length, ws.length)).map((l, i) => [l, ws[i]!]);
    } else {
      // Object.entries puts integer-like keys first, where a Python dict
      // keeps insertion order; no pack has one, and one would change the
      // roll, so refuse it rather than drift
      opts = Object.entries(q.options);
      if (opts.some(([k]) => /^(0|[1-9]\d*)$/.test(k))) {
        throw new TypeError(`question ${name}: option ${JSON.stringify(opts[0]![0])} looks like an array index`);
      }
    }
    // Python's max(0.0, w): a NaN weight loses to 0.0, where Math.max keeps it
    opts = opts.map(([k, w]) => { const f = Number(w); return [k, f > 0.0 ? f : 0.0]; });
    // every weight went through float() above: an all-float sum
    let total = pySum(opts.map(([, w]) => w));
    if (total <= 0) {
      opts = opts.map(([k]) => [k, 1.0]);
      total = opts.length;
    }
    const probs: Record<string, number> = {};
    for (const [k, w] of opts) probs[k] = w / total;
    const roll = rng.random();
    let pick = opts[opts.length - 1]![0];
    let acc = 0.0;
    for (const [k] of opts) {
      acc += probs[k]!;
      if (roll < acc) { pick = k; break; }
    }
    out[name] = { type: Object.hasOwn(q, "type") ? q.type : "choice", probs, pick, confidence: probs[pick]! };
  }
  return out;
}

export function bands(w: W.World): Record<string, number> {
  const res = Object.values(w.residents);
  if (!res.length) return {};
  const out: Record<string, number> = {};
  // needs are floats in Python, always (FLOAT_FIELDS; tests/shape.test.ts)
  for (const need of Object.keys(R.needs)) out[need] = pySum(res.map((r) => r.needs[need]!)) / res.length;
  return out;
}

export function frayedShare(w: W.World): number {
  const res = Object.values(w.residents);
  if (!res.length) return 0.0;
  return res.filter((r) => r.stress >= 1).length / res.length;
}

export const SEASON_FIT: Record<string, Record<string, number>> = {
  frost: { winter: 2.0, autumn: 0.8, spring: 0.5, summer: 0.05 },
  heat: { summer: 2.0, spring: 0.6, autumn: 0.5, winter: 0.05 },
  rain: { autumn: 1.6, spring: 1.4, winter: 1.0, summer: 0.7 },
};

export function fateWeights(w: W.World): Record<string, number> {
  const b = bands(w);
  const fray = frayedShare(w);
  const vals = Object.values(b);
  const calm = vals.length && Math.max(...vals) < 1.0 ? 1.0 : 0.3;
  const season = W.seasonName(w.day);
  const inForce = new Set(w.fates.map((f) => f.kind));
  const out: Record<string, number> = {};
  for (const fate of Object.keys(R.fates).sort()) {
    const spec = R.fates[fate]!;
    let wt: number;
    if (fate === "quiet") {
      wt = 3.0 + 2.0 * fray;
    } else if (spec.stock) {
      wt = 0.3 + 2.0 * Math.max(0.0, (b.food ?? 0.0) - 1.0);
    } else if ((spec.noise_mult ?? 1.0) < 1.0) {
      wt = 0.3 + 2.0 * Math.max(0.0, (b.quiet ?? 0.0) - 1.0) + fray;
    } else if (spec.weather) {
      const base = spec.weather === "storm" ? 0.4 : 0.6;
      wt = base * (SEASON_FIT[spec.weather]?.[season] ?? 1.0);
    } else if (spec.walk_mult || spec.stair_mult || spec.damage) {
      wt = 0.35 * calm;
    } else {
      wt = 0.5;
    }
    if (inForce.has(fate) && fate !== "quiet") wt *= 0.1;
    out[fate] = pyRound(wt, 6);
  }
  return out;
}

export function regionWeights(fate: string): Record<string, number> {
  const regs = R.fates[fate]?.regions;
  const out: Record<string, number> = {};
  for (const r of regs && regs.length ? regs : ["all"]) out[r] = 1.0;
  return out;
}

export interface Pick { fate: string; region: string; why: string; confidence: number; decided: string }

export function watch(w: W.World): Pick {
  const rng = W.rngFor(w.seed, w.day, "decide:watch");
  const a = decide({ fate: { type: "choice", options: fateWeights(w) } }, rng).fate!;
  const fate = a.pick;
  const r = decide({ region: { type: "choice", options: regionWeights(fate) } }, rng).region!;
  return {
    fate, region: r.pick, why: R.fates[fate]!.why ?? "",
    confidence: pyRound(a.confidence, 3), decided: "rules",
  };
}
