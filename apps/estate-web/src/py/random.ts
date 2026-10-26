/**
 * Python's `random.Random`, bit for bit.
 *
 * The estate draws every number it ever uses from `random.Random(str)` —
 * `W.rng_for(seed, day, salt)` — so a port that is to replay the same
 * world from the same seed must draw the same numbers in the same order.
 * This is CPython's Mersenne Twister (Modules/_randommodule.c) and the
 * pure-Python layer on top of it (Lib/random.py, 3.11+), for exactly the
 * methods the estate calls: random, getrandbits(k ≤ 32), randrange,
 * randint, choice, shuffle.
 *
 * Seeding a string (version 2): the seed integer is
 * `int.from_bytes(s + sha512(s))`, big-endian, and its 32-bit words, least
 * significant first, are handed to `init_by_array`. sha512 has to be
 * synchronous here (WebCrypto's is not), so it is @noble/hashes'.
 */
import { sha512 } from "@noble/hashes/sha2.js";

const N = 624;
const M = 397;
const enc = new TextEncoder();

/** The seed key: big-endian bytes read as one integer, cut into 32-bit
 * words least significant first, leading zero words dropped (CPython
 * sizes the key by the integer's bit length). */
export function seedKey(seed: string): number[] {
  const s = enc.encode(seed);
  const all = new Uint8Array(s.length + 64);
  all.set(s, 0);
  all.set(sha512(s), s.length);
  const key: number[] = [];
  for (let end = all.length; end > 0; end -= 4) {
    let w = 0;
    for (let b = Math.max(0, end - 4); b < end; b++) w = ((w << 8) | all[b]!) >>> 0;
    key.push(w);
  }
  while (key.length > 1 && key[key.length - 1] === 0) key.pop();
  return key;
}

/** init_genrand(19650218): where every init_by_array starts. It never
 * changes, so it is worked out once and copied. */
const BASE = (() => {
  const mt = new Uint32Array(N);
  mt[0] = 19650218;
  for (let i = 1; i < N; i++) {
    const p = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
    mt[i] = (Math.imul(1812433253, p) + i) >>> 0;
  }
  return mt;
})();

/**
 * The estate seeds a fresh generator for every (seed, day, salt) — one per
 * resident per phase for their whims — and most draw only a handful of
 * numbers. So the twist is done lazily: word k of the new state depends
 * only on words k, k+1 and k+M of the old one, and for k < N-M those are
 * all still untwisted, so the first N-M words can be twisted one at a time
 * as they are drawn. Past that the rest of the twist is done in one go.
 * The words come out exactly as the eager loop makes them.
 */
export class PyRandom {
  private mt = new Uint32Array(N);
  private mti = N;
  /** how far the pending twist has got, or -1 when none is pending.
   * Anything that reads or copies `mt` whole — a getstate(), a clone —
   * must finish the pending twist first (words tw..N-1 are still the old
   * state's), or it captures a state no CPython generator was ever in. */
  private tw = -1;

  constructor(seed: string) {
    this.initByArray(seedKey(seed));
  }

  private initByArray(key: number[]): void {
    const mt = this.mt;
    mt.set(BASE);
    let i = 1;
    let j = 0;
    const kl = key.length;
    let prev = mt[0]!; // mt[i - 1], carried rather than re-read
    for (let k = Math.max(N, kl); k; k--) {
      prev = ((mt[i]! ^ Math.imul(prev ^ (prev >>> 30), 1664525)) + key[j]! + j) >>> 0;
      mt[i] = prev;
      i++;
      j++;
      if (i >= N) { mt[0] = prev; i = 1; }
      if (j >= kl) j = 0;
    }
    for (let k = N - 1; k; k--) {
      prev = ((mt[i]! ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) - i) >>> 0;
      mt[i] = prev;
      i++;
      if (i >= N) { mt[0] = prev; i = 1; }
    }
    mt[0] = 0x80000000;
  }

  /** genrand_uint32 */
  private u32(): number {
    const mt = this.mt;
    if (this.mti >= N) {
      this.mti = 0;
      this.tw = 0;
    }
    const at = this.mti++;
    if (at >= this.tw && this.tw >= 0) this.twistTo(at);
    let y = mt[at]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** Carry the pending twist on until word `at` is new. */
  private twistTo(at: number): void {
    const mt = this.mt;
    let kk = this.tw;
    if (at < N - M) {
      for (; kk <= at; kk++) {
        const y = (mt[kk]! & 0x80000000) | (mt[kk + 1]! & 0x7fffffff);
        mt[kk] = mt[kk + M]! ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.tw = kk;
      return;
    }
    for (; kk < N - M; kk++) {
      const y = (mt[kk]! & 0x80000000) | (mt[kk + 1]! & 0x7fffffff);
      mt[kk] = mt[kk + M]! ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
    }
    for (; kk < N - 1; kk++) {
      const y = (mt[kk]! & 0x80000000) | (mt[kk + 1]! & 0x7fffffff);
      mt[kk] = mt[kk + (M - N)]! ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
    }
    const y = (mt[N - 1]! & 0x80000000) | (mt[0]! & 0x7fffffff);
    mt[N - 1] = mt[M - 1]! ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
    this.tw = -1;
  }

  /** random.random(): 53 bits from two draws. */
  random(): number {
    const a = this.u32() >>> 5;
    const b = this.u32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  getrandbits(k: number): number {
    if (k === 0) return 0;
    if (k < 0 || k > 32) throw new RangeError(`getrandbits(${k}): only 0..32 is ported`);
    return this.u32() >>> (32 - k);
  }

  /** _randbelow_with_getrandbits */
  randbelow(n: number): number {
    if (!Number.isInteger(n) || n <= 0 || n > 0xffffffff) throw new RangeError(`randbelow(${n})`);
    const k = 32 - Math.clz32(n);
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  randrange(start: number, stop?: number): number {
    // 3.12+ refuses a non-integer outright; so does the port
    if (!Number.isSafeInteger(start) || (stop !== undefined && !Number.isSafeInteger(stop))) {
      throw new TypeError(`randrange() needs integers, got ${start}${stop === undefined ? "" : `, ${stop}`}`);
    }
    if (stop === undefined) {
      if (start <= 0) throw new RangeError("empty range for randrange()");
      return this.randbelow(start);
    }
    const width = stop - start;
    if (width <= 0) throw new RangeError(`empty range in randrange(${start}, ${stop})`);
    return start + this.randbelow(width);
  }

  /** Only for widths below 2**32: randbelow draws from one 32-bit word,
   * where CPython's would go on to wider getrandbits. The engine's widest
   * is a few thousand; randbelow refuses rather than diverge. */
  randint(a: number, b: number): number {
    return this.randrange(a, b + 1);
  }

  choice<T>(seq: readonly T[]): T {
    if (seq.length === 0) throw new RangeError("Cannot choose from an empty sequence");
    return seq[this.randbelow(seq.length)]!;
  }

  shuffle<T>(x: T[]): void {
    for (let i = x.length - 1; i > 0; i--) {
      const j = this.randbelow(i + 1);
      const t = x[i]!;
      x[i] = x[j]!;
      x[j] = t;
    }
  }
}
