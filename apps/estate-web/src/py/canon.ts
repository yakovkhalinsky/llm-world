/**
 * The canonical world form and its hash — the TS twin of
 * apps/estate/tools/parity.py's `canon` / `world_hash`.
 *
 * Sorted keys (by code point, as Python sorts), no spaces, every integral
 * number written as an integer and every other one as Python's repr. The
 * domain is closed at 2**53: an integral value outside ±(2**53 - 1) has no
 * canonical form on either side (Python's canon_value raises too), so a
 * hash mismatch is always a simulation difference, never an encoding one. Python's int/float
 * distinction is the one thing this form cannot see, and is meant not to:
 * JS has one number, and the engine never reads the difference.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { floatRepr } from "./num.ts";

function num(x: number): string {
  if (!Number.isFinite(x)) throw new RangeError(`no canonical form for ${x}`);
  if (Number.isInteger(x)) {
    if (!Number.isSafeInteger(x)) throw new RangeError(`no canonical form for ${x}: integral beyond 2**53`);
    return Object.is(x, -0) ? "0" : String(x);
  }
  return floatRepr(x);
}

/** Python's str order: by code point, not UTF-16 unit (they differ only
 * for astral characters against U+E000–U+FFFF). */
export function byCodePoint(a: string, b: string): number {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}

function write(v: unknown, out: string[]): void {
  if (v === null || v === undefined) { out.push("null"); return; }
  switch (typeof v) {
    case "boolean": out.push(v ? "true" : "false"); return;
    case "number": out.push(num(v)); return;
    case "string": out.push(JSON.stringify(v)); return;
    case "object": {
      if (Array.isArray(v)) {
        out.push("[");
        v.forEach((x, i) => { if (i) out.push(","); write(x, out); });
        out.push("]");
        return;
      }
      const o = v as Record<string, unknown>;
      // undefined-valued keys are absent, as they would be in Python
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort(byCodePoint);
      out.push("{");
      keys.forEach((k, i) => {
        if (i) out.push(",");
        out.push(JSON.stringify(k), ":");
        write(o[k], out);
      });
      out.push("}");
      return;
    }
    default:
      throw new TypeError(`no canonical form for ${typeof v}`);
  }
}

export function canon(v: unknown): string {
  const out: string[] = [];
  write(v, out);
  return out.join("");
}

export function hash16(s: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(s))).slice(0, 16);
}

export function worldHash(world: unknown): string {
  return hash16(canon(world));
}
