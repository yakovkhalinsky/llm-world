/**
 * The watcher: the presence that watches the estate and owns nothing —
 * apps/estate/estate/watcher.py, the half that needs no model.
 *
 * The menu is the pack's, the choice is decide.watch's, and every answer
 * passes the same validator. The why is the pack's own line (there is no
 * model in the browser to write one).
 */
import * as dec from "./decide.ts";
import { R } from "./rules.ts";
import type * as W from "./world.ts";

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
  if (typeof fate !== "string" || !(fate in R.fates)) {
    return quiet("all", `the watcher named a fate the estate has no law for: ${pyRepr(fate)}`);
  }
  const allowed = regionsFor(fate);
  let region = "region" in o ? o.region : "all";
  if (typeof region !== "string" || !allowed.includes(region)) {
    if (allowed.length === 1) region = allowed[0]!;
    else return quiet("all", `${fate} is not something that happens to ${pyRepr(region)}`);
  }
  let why = typeof o.why === "string" ? o.why.trim() : "";
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
