/**
 * statistics.mean, exactly as Python takes it: the data summed as exact
 * rationals, divided by n, and only then rounded — once — to a float. For
 * all-int data an integral mean stays an int (the `int` result here); any
 * other mean is the correctly rounded float.
 *
 * Doubles are held exactly as BigInt multiples of 2^-1074, so the sum
 * never rounds. Finite inputs only.
 */

const SCALE = 1074n;

/** x as an exact BigInt multiple of 2^-1074. */
export function exactUnits(x: number): bigint {
  if (!Number.isFinite(x)) throw new RangeError(`mean of a non-finite value: ${x}`);
  if (x === 0) return 0n;
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const hi = dv.getUint32(0), lo = dv.getUint32(4);
  const sign = hi >>> 31 ? -1n : 1n;
  const bexp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let shift: bigint;
  if (bexp === 0) shift = 0n;                 // subnormal: mant × 2^-1074
  else { mant |= 1n << 52n; shift = BigInt(bexp - 1); }
  return sign * (mant << shift);
}

function bitLength(n: bigint): number {
  return n === 0n ? 0 : n.toString(2).length;
}

/** num/den rounded once, half to even, to the nearest double (normal range). */
export function ratioToFloat(num: bigint, den: bigint): number {
  if (den <= 0n) throw new RangeError("den must be positive");
  if (num === 0n) return 0.0;
  const neg = num < 0n;
  const a = neg ? -num : num;
  // q = floor(a·2^s / den) with 55..56 bits, so there are bits to round off
  const s = 55 - (bitLength(a) - bitLength(den));
  const n2 = s >= 0 ? a << BigInt(s) : a;
  const d2 = s >= 0 ? den : den << BigInt(-s);
  let q = n2 / d2;
  const sticky = n2 % d2 !== 0n;
  let e = -s;                                  // value = q·2^e (+ sticky)
  const extra = bitLength(q) - 53;
  const dropped = q & ((1n << BigInt(extra)) - 1n);
  q >>= BigInt(extra);
  e += extra;
  const half = 1n << BigInt(extra - 1);
  if (dropped > half || (dropped === half && (sticky || (q & 1n) === 1n))) q += 1n;
  const v = Number(q) * 2 ** e;               // q ≤ 2^53: exact; 2^e exact here
  return neg ? -v : v;
}

/** statistics.mean of floats (or of ints and floats): a float. */
export function meanFloat(xs: readonly number[]): number {
  if (!xs.length) throw new RangeError("mean requires at least one data point");
  let total = 0n;
  for (const x of xs) total += exactUnits(x);
  return ratioToFloat(total, BigInt(xs.length) << SCALE);
}

/** statistics.mean of ints: `{int}` when the mean is whole, else `{float}`. */
export function meanInts(xs: readonly number[]): { int: number } | { float: number } {
  if (!xs.length) throw new RangeError("mean requires at least one data point");
  let total = 0n;
  for (const x of xs) {
    if (!Number.isSafeInteger(x)) throw new TypeError(`meanInts wants safe integers, got ${x}`);
    total += BigInt(x);
  }
  const n = BigInt(xs.length);
  return total % n === 0n ? { int: Number(total / n) } : { float: ratioToFloat(total, n) };
}
