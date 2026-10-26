/**
 * Python's arithmetic where it differs from JavaScript's.
 *
 * The estate is Python, and parity means its numbers, not merely similar
 * ones. Where the two languages part company the port calls one of these
 * instead of the JS operator:
 *
 *   round(x)       banker's rounding to an int        → pyRound(x)
 *   round(x, n)    correctly rounded, ties to even    → pyRound(x, n)
 *   a // b         floor division (float_divmod)      → floordiv(a, b)
 *   a % b          sign follows the divisor           → mod(a, b)
 *   divmod(a, b)                                      → divmod(a, b)
 *   sum(xs)        CPython 3.12+'s int/float paths    → pySum(xs, isInt)
 *   repr(float)    '1.0', '1e-05', '1e+16'            → floatRepr(x)
 *
 * JS has one number type where Python has int and float. Integer-valued
 * results agree on value, which is all the simulation reads; where the
 * difference shows (repr, json.dumps) the caller says which it means.
 */

/** float_divmod from Objects/floatobject.c, which int // int agrees with
 * in value for every value the estate holds (well inside 2**53). Only the
 * sign of zero differs: an int has none, so divmod(0, -3) is (0, 0) where
 * divmod(0.0, -3.0) is (-0.0, -0.0). JS can't tell the two apart, so the
 * caller says: `ints` for Python ints (zeros come back +0). Canon never
 * sees a zero's sign; repr does. Non-finite operands throw: the simulation
 * never makes one, and C's NaN-is-true doesn't carry. */
export function divmod(vx: number, wx: number, ints = false): [number, number] {
  if (!Number.isFinite(vx) || !Number.isFinite(wx)) throw new RangeError(`divmod of non-finite ${vx}, ${wx}`);
  if (wx === 0) throw new RangeError("division by zero");
  if (ints) {
    if (!Number.isSafeInteger(vx) || !Number.isSafeInteger(wx)) throw new TypeError(`int divmod of ${vx}, ${wx}`);
    const [q, m] = floatDivmod(vx, wx);
    return [q + 0, m + 0];
  }
  return floatDivmod(vx, wx);
}

function floatDivmod(vx: number, wx: number): [number, number] {
  let mod = vx % wx; // C fmod
  let div = (vx - mod) / wx;
  if (mod) {
    if (wx < 0 !== mod < 0) {
      mod += wx;
      div -= 1.0;
    }
  } else {
    mod = wx < 0 ? -0 : 0;
  }
  let floordiv: number;
  if (div) {
    floordiv = Math.floor(div);
    if (div - floordiv > 0.5) floordiv += 1.0;
  } else {
    floordiv = vx / wx < 0 || Object.is(vx / wx, -0) ? -0 : 0;
  }
  return [floordiv, mod];
}

export function floordiv(a: number, b: number, ints = false): number {
  return divmod(a, b, ints)[0];
}

export function mod(a: number, b: number, ints = false): number {
  return divmod(a, b, ints)[1];
}

/** round(x) — half to even, to an integer. */
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * round(x) or round(x, n). CPython rounds the float's *exact* binary value
 * to n decimals, ties to even, then reads the decimal back. toFixed rounds
 * the exact value too, but breaks ties upward, so an exact tie (which can
 * only be a short, terminating expansion) is detected and sent to even.
 */
export function pyRound(x: number, ndigits?: number): number {
  if (ndigits === undefined) {
    // an int: round(-0.4) is 0, not -0; and there is no int nan or inf
    if (!Number.isFinite(x)) throw new RangeError(`cannot round ${x} to an integer`);
    return roundHalfEven(x) + 0;
  }
  if (!Number.isFinite(x) || x === 0) return x;
  if (!Number.isInteger(ndigits)) throw new TypeError(`ndigits must be an int, not ${ndigits}`);
  if (Math.abs(x) >= 2 ** 52 && ndigits >= 0) return x; // already integral
  if (ndigits < 0 || ndigits > 20) throw new RangeError(`pyRound ndigits=${ndigits} not ported`);
  const ax = Math.abs(x);
  const exact = ax.toFixed(100); // exact for a tie, which terminates early
  const dot = exact.indexOf(".");
  const tail = exact.slice(dot + 1 + ndigits);
  let s: string;
  if (tail[0] === "5" && /^50*$/.test(tail)) {
    // exactly halfway: keep the truncation if its last digit is even
    const trunc = exact.slice(0, dot + 1 + ndigits).replace(/\.$/, "");
    const last = trunc.replace(".", "").slice(-1);
    s = Number(last) % 2 === 0 ? trunc : ax.toFixed(ndigits);
  } else {
    s = ax.toFixed(ndigits);
  }
  const r = Number(s);
  return x < 0 ? -r : r;
}

/**
 * sum(xs), as CPython 3.12+ adds: the int items first, exactly, while
 * there have been no floats; the first float added to that total plainly;
 * then Neumaier's
 * compensated sum over the floats, with each later int added to the
 * running total *without* compensation (`f_result += (double)value`).
 *
 * JS can't tell 1 from 1.0, so the caller says which items are Python
 * ints: `isInt(x, i)`. Without it every item is taken as a float — the
 * right reading only when every item is a float in Python (as with
 * `float(w)` weights or the residents' needs). sum([0.1, 1, -1]) is
 * 0.10000000000000009 in Python but 0.1 summed as all floats.
 */
export function pySum(xs: Iterable<number>, isInt?: (x: number, i: number) => boolean): number {
  let i = 0;
  let iResult = 0;
  let floating = false;
  let f = 0.0;
  let c = 0.0;
  for (const x of xs) {
    const asInt = isInt ? isInt(x, i) : false;
    i++;
    if (asInt && !Number.isSafeInteger(x)) throw new RangeError(`int ${x} outside the safe range`);
    if (!floating) {
      if (asInt) {
        iResult += x;
        if (!Number.isSafeInteger(iResult)) throw new RangeError("int sum outside the safe range");
        continue;
      }
      // the first float meets the int total in a plain int + float
      // (PyNumber_Add), uncompensated; the float loop starts from there
      floating = true;
      f = iResult + x;
      continue;
    }
    if (asInt) {
      f += x;
      continue;
    }
    const t = f + x;
    if (Math.abs(f) >= Math.abs(x)) c += f - t + x;
    else c += x - t + f;
    f = t;
  }
  if (!floating) return iResult;
  if (c && Number.isFinite(c)) f += c;
  return f;
}

/** repr(float): shortest round-trip digits (the same digits JS picks),
 * laid out the way Python lays them out. */
export function floatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  const [mant, expS] = Math.abs(x).toExponential().split("e") as [string, string];
  const digits = mant.replace(".", "");
  const exp = Number(expS);
  if (exp >= -4 && exp < 16) {
    let out: string;
    if (exp < 0) out = "0." + "0".repeat(-exp - 1) + digits;
    else if (digits.length <= exp + 1) out = digits + "0".repeat(exp + 1 - digits.length) + ".0";
    else out = digits.slice(0, exp + 1) + "." + digits.slice(exp + 1);
    return sign + out;
  }
  const m = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
  const e = Math.abs(exp).toString().padStart(2, "0");
  return `${sign}${m}e${exp < 0 ? "-" : "+"}${e}`;
}

/** max(xs, key=k): the first of the largest, as Python's is. */
export function maxBy<T>(xs: Iterable<T>, key: (x: T) => number): T {
  let best: T | undefined;
  let bk = -Infinity;
  let any = false;
  for (const x of xs) {
    const k = key(x);
    if (!any || k > bk) {
      best = x;
      bk = k;
      any = true;
    }
  }
  if (!any) throw new RangeError("max() arg is an empty sequence");
  return best as T;
}

/** min(xs, key=k): the first of the smallest. */
export function minBy<T>(xs: Iterable<T>, key: (x: T) => number): T {
  let best: T | undefined;
  let bk = Infinity;
  let any = false;
  for (const x of xs) {
    const k = key(x);
    if (!any || k < bk) {
      best = x;
      bk = k;
      any = true;
    }
  }
  if (!any) throw new RangeError("min() arg is an empty sequence");
  return best as T;
}

/** range(a, b) as an array. */
export function range(a: number, b?: number, step = 1): number[] {
  if (b === undefined) { b = a; a = 0; }
  if (step === 0) throw new RangeError("range() arg 3 must not be zero");
  const out: number[] = [];
  if (step > 0) for (let i = a; i < b; i += step) out.push(i);
  else for (let i = a; i > b; i += step) out.push(i);
  return out;
}

/** int // int, int % int and divmod(int, int): `ints` set (see divmod). */
export const idivmod = (a: number, b: number): [number, number] => divmod(a, b, true);
export const ifloordiv = (a: number, b: number): number => divmod(a, b, true)[0];
export const imod = (a: number, b: number): number => divmod(a, b, true)[1];
