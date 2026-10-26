/**
 * The watcher: the presence that watches the estate and owns nothing —
 * apps/estate/estate/watcher.py, the half that needs no model.
 *
 * The menu is the pack's, the choice is decide.watch's, and every answer
 * passes the same validator. The why is the pack's own line (there is no
 * model in the browser to write one).
 */
import { pyStrip } from "../py/text.ts";
import * as dec from "./decide.ts";
import { R } from "./rules.ts";
import * as W from "./world.ts";
import { pyRound } from "../py/num.ts";

export const QUIET = "quiet";

export interface Intent { fate: string; region: string; why: string; decided?: string; confidence?: number; day?: number }

export function menu(): string[] {
  return Object.keys(R.fates).sort();
}

export function regionsFor(fate: string): string[] {
  const regs = R.fates[fate]?.regions;
  return regs && regs.length ? [...regs] : ["all"];
}

function quiet(region = "all", why = "nothing — the estate is left to its own day"): Intent {
  return { fate: QUIET, region, why };
}

/** A pick as a fate the engine may land, or `quiet`. Never rewrites a
 * legal answer. Python's `{fate!r}` repr is approximated for strings. */
export function validate(raw: unknown): Intent {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return quiet("all", "the watcher said nothing readable");
  }
  const o = raw as Record<string, unknown>;
  const fate = o.fate;
  if (typeof fate !== "string" || !Object.hasOwn(R.fates, fate)) {
    return quiet("all", `the watcher named a fate the estate has no law for: ${pyRepr(fate)}`);
  }
  const allowed = regionsFor(fate);
  let region = Object.hasOwn(o, "region") ? o.region : "all";
  if (typeof region !== "string" || !allowed.includes(region)) {
    if (allowed.length === 1) region = allowed[0]!;
    else return quiet("all", `${fate} is not something that happens to ${pyRepr(region)}`);
  }
  let why = typeof o.why === "string" ? pyStrip(o.why) : "";
  if ([...why].length > 200) why = [...why].slice(0, 197).join("") + "…";
  return { fate, region: region as string, why: why || (R.fates[fate]!.why ?? "") };
}

function pyRepr(v: unknown): string {
  if (v === undefined || v === null) return "None";
  if (typeof v === "string") return v.includes("'") && !v.includes('"') ? `"${v}"` : `'${v.replace(/'/g, "\\'")}'`;
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

/** The fate and region, chosen in code — always legal. */
export function choose(w: W.World): Intent {
  const pick = dec.watch(w);
  const out = validate(pick);
  out.decided = "rules";
  out.confidence = pick.confidence;
  return out;
}

/** Put a validated fate in the estate's hand; it lands tomorrow. */
export function queue(w: W.World, intent: Intent): Intent | null {
  if (intent.fate === QUIET) return null;
  w.pending.push({ kind: intent.fate, region: intent.region ?? "all" });
  return intent;
}

/**
 * The watcher's cadence in days. The Python runner invites the watcher
 * every R.pacing.watcher_gap wall seconds (60–120 s); a browser tab's wall
 * clock pauses, throttles and sleeps, so here the same gap is counted in
 * days at the pack's default pace (the middle of `day_seconds`, 20 s a
 * day: 3–6 days) and rolled from the seed. The estate's whole timeline is
 * then a function of its seed and how many days it has lived, at any
 * speed.
 *
 * This is new behaviour, not a port: web.py rolls its gap from the
 * unseeded `random.random()`, and with no model at all it never invites
 * the watcher. The port matches web.py's `--decide rules` mode — the
 * choice in code — on this seeded cadence, and tests/web_harness.py
 * drives web.py's own runner on it. (`watcher_gap_cloud`, the cadence
 * for a hosted model, is unused here.)
 */
export function gapDays(seed: number, day: number): number {
  const pace = R.pacing.day_seconds[1]!;
  const [lo, hi] = R.pacing.watcher_gap;
  const a = Math.max(1, pyRound(lo / pace));
  const b = Math.max(a, pyRound(hi / pace));
  return W.rngFor(seed, day, "watch:gap").randint(a, b);
}
