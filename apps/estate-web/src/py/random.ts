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

export class PyRandom {
  private mt = new Uint32Array(N);
  private mti = N + 1;

  constructor(seed: string) {
    this.initByArray(seedKey(seed));
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const p = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
      mt[i] = (Math.imul(1812433253, p) + i) >>> 0;
    }
    this.mti = N;
  }

  private initByArray(key: number[]): void {
    this.initGenrand(19650218);
    const mt = this.mt;
    let i = 1;
    let j = 0;
    const kl = key.length;
    for (let k = Math.max(N, kl); k; k--) {
      const p = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
      mt[i] = ((mt[i]! ^ Math.imul(p, 1664525)) + key[j]! + j) >>> 0;
      i++;
      j++;
      if (i >= N) { mt[0] = mt[N - 1]!; i = 1; }
      if (j >= kl) j = 0;
    }
    for (let k = N - 1; k; k--) {
      const p = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
      mt[i] = ((mt[i]! ^ Math.imul(p, 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) { mt[0] = mt[N - 1]!; i = 1; }
    }
    mt[0] = 0x80000000;
  }

  /** genrand_uint32 */
  private u32(): number {
    const mt = this.mt;
    if (this.mti >= N) {
      let kk = 0;
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
      this.mti = 0;
    }
    let y = mt[this.mti++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
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
    if (stop === undefined) {
      if (start <= 0) throw new RangeError("empty range for randrange()");
      return this.randbelow(start);
    }
    const width = stop - start;
    if (width <= 0) throw new RangeError(`empty range in randrange(${start}, ${stop})`);
    return start + this.randbelow(width);
  }

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
