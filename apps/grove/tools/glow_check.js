#!/usr/bin/env node
/* glow_check — the rings that glow at night, in Node.
 *
 * Reads a /api/state snapshot (a file, or stdin) and runs the page's own
 * choice of glowing rings (`page3d/glow.js`) over many nights:
 *
 *   - the rings are the mushroom cells, each in exactly one ring, and no
 *     two rings touch (eight neighbours);
 *   - with every ring lit, the page's field is the server's `glow` field,
 *     cell for cell (the page builds pools with the server's arithmetic);
 *   - the same snapshot and night always light the same rings;
 *   - a lit ring is lit whole, and nothing but lit rings is lit;
 *   - the lit rings are the ones whose draw is under SHARE, and on a night
 *     none passes, the one ring closest to passing (never just the first);
 *   - a night with rings lights at least one, and in a big grove neither
 *     one ring nor all of them on most nights;
 *   - over many nights about one ring in four glows (0.2–0.3), each ring
 *     takes its turn about as often, a ring lit tonight is no likelier
 *     to be lit 1–4 nights on (no rota), and nights differ;
 *   - a cell glows only within reach of a lit ring.
 *
 * Given the next week's snapshot as well, it replays the page's weekly
 * rebuild (`Glow.rebuild`) in the dark on the same night: a ring that
 * survived the week keeps its state (lit or dark), and every lit cell
 * still standing stays lit. By day the rebuild is a fresh choice.
 *
 *   node tools/glow_check.js snapshot.json [next-week.json]
 *   GROVE_GLOW=/path/to/mutant/glow.js node tools/glow_check.js s.json
 *
 * Prints a JSON report and exits 1 on any failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const Glow = require(process.env.GROVE_GLOW ||
                     path.join(__dirname, '..', 'grove', 'page3d', 'glow.js'));

const st = JSON.parse(process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8')
                                      : fs.readFileSync(0, 'utf8'));
const next = process.argv[3]
  ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : null;
const N = st.size;

/* failures by kind: the first case of each, and how many */
const kinds = new Map();
function fail(kind, detail) {
  const k = kinds.get(kind);
  if (k) k.count++;
  else kinds.set(kind, { first: detail || '', count: 1 });
}

const isMush = (s, i) => !!(s.cells[i] && s.cells[i][3]);
const mush = [];
for (let i = 0; i < N * N; i++) if (isMush(st, i)) mush.push(i);

/* the rings partition the mushroom cells, and are 8-separated */
const rings = Glow.rings(st.cells, N);
const owner = new Int32Array(N * N).fill(-1);
rings.forEach((r, k) => r.cells.forEach(i => {
  if (owner[i] !== -1) fail('cell in two rings', 'cell ' + i);
  if (!isMush(st, i)) fail('ring cell has no mushroom', 'cell ' + i);
  owner[i] = k;
  if (r.key !== Math.min.apply(null, r.cells)) fail('ring key is not its first cell', 'ring ' + r.key);
}));
mush.forEach(i => {
  if (owner[i] === -1) fail('mushroom cell in no ring', 'cell ' + i);
  const x = i % N, y = (i - x) / N;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
    const j = ny * N + nx;
    if (owner[j] !== -1 && owner[j] !== owner[i]) fail('rings touch', 'at cell ' + i);
  }
});

/* every ring lit: the server's field */
const all = new Uint8Array(N * N);
mush.forEach(i => { all[i] = 1; });
const full = Glow.field(all, N);
let mismatch = 0;
for (let i = 0; i < N * N; i++) {
  if (full[i] !== (Number(st.glow[i]) || 0)) mismatch++;
}
if (mismatch) fail('cells differ from the server glow field', mismatch + ' cells');

/* the rings a night should light, from the draw alone */
function expected(cells, n, share) {
  const rs = Glow.rings(cells, N);
  const under = rs.filter(r => Glow.score(r.key, n) < share);
  if (under.length || !rs.length) return under.map(r => r.key);
  let best = rs[0];
  rs.forEach(r => { if (Glow.score(r.key, n) < Glow.score(best.key, n)) best = r; });
  return [best.key];
}

/* many nights */
const NIGHTS = 400;
const LAGS = 4;
let litSum = 0, ringSum = 0, emptyNights = 0, extremeNights = 0;
const seenSets = new Set();
const litBy = rings.map(() => new Uint8Array(NIGHTS));   // [ring][night]
const index = new Map(rings.map((r, k) => [r.key, k]));
for (let n = 0; n < NIGHTS; n++) {
  const a = Glow.choose(st.cells, N, n);
  const b = Glow.choose(st.cells, N, n);
  const ka = a.lit.map(r => r.key).join(',');
  if (ka !== b.lit.map(r => r.key).join(',')) fail('not deterministic', 'night ' + n);
  seenSets.add(ka);
  if (a.rings.length && !a.lit.length) emptyNights++;
  if (rings.length >= 20 && (a.lit.length <= 1 || a.lit.length === a.rings.length)) {
    extremeNights++;
  }
  litSum += a.lit.length;
  ringSum += a.rings.length;
  a.lit.forEach(r => { if (index.has(r.key)) litBy[index.get(r.key)][n] = 1; });

  /* the lit set is the draw's: under SHARE, else the closest to passing */
  if (ka !== expected(st.cells, n, Glow.SHARE).join(',')) {
    fail('lit rings are not the ones whose draw is under SHARE', 'night ' + n);
  }
  /* a night where no ring passes: the fallback must be the best draw */
  const none = Glow.choose(st.cells, N, n, 1e-12);
  if (rings.length &&
      none.lit.map(r => r.key).join(',') !== expected(st.cells, n, 1e-12).join(',')) {
    fail('fallback is not the ring closest to passing', 'night ' + n);
  }

  /* lit rings whole, nothing else */
  const want = new Uint8Array(N * N);
  a.lit.forEach(r => r.cells.forEach(i => { want[i] = 1; }));
  for (let i = 0; i < N * N; i++) {
    if (want[i] && !a.litCell[i]) { fail('a lit ring has a dark cell', 'night ' + n + ' cell ' + i); break; }
    if (!want[i] && a.litCell[i] && isMush(st, i)) { fail('a cell outside the lit rings is lit', 'night ' + n + ' cell ' + i); break; }
  }
  if (a.litCell.some((v, i) => v && !isMush(st, i))) {
    fail('lights a cell with no mushroom', 'night ' + n);
  }
  if (a.mushCell && a.mushCell.some((v, i) => !!v !== isMush(st, i))) {
    fail('mushCell is not the mushroom cells', 'night ' + n);
  }

  /* glow only within reach of a lit cell */
  const f = Glow.field(a.litCell, N);
  const r = Math.floor(Glow.REACH);
  for (let i = 0; i < N * N; i++) {
    if (!f[i]) continue;
    const x = i % N, y = (i - x) / N;
    let near = false;
    for (let dy = -r; dy <= r && !near; dy++) for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      if (a.litCell[ny * N + nx] && Math.hypot(dx, dy) < Glow.REACH) { near = true; break; }
    }
    if (!near) { fail('glows far from a lit ring', 'night ' + n + ' cell ' + i); break; }
  }
}
if (emptyNights) fail('nights with rings light none', emptyNights + ' nights');
if (extremeNights > NIGHTS * 0.05) {
  fail('most nights light one ring or every ring', extremeNights + ' of ' + NIGHTS);
}
const share = ringSum ? litSum / ringSum : 0;
if (ringSum >= 1000 ? (share < 0.2 || share > 0.3)
                    : (rings.length >= 4 && (share < 0.1 || share > 0.45))) {
  fail('lit share is not about one in four', share.toFixed(3));
}
/* each ring takes its turn: over 400 nights a fair ring is lit on 25%
 * ± 2.2%, so 10–42% is a wide band that a stuck ring still misses */
litBy.forEach((row, k) => {
  const s = row.reduce((a, b) => a + b, 0) / NIGHTS;
  if (s < 0.1 || s > 0.42) fail('a ring is lit far from one night in four', 'ring ' + rings[k].key + ' ' + s.toFixed(3));
});
/* no rota: lit tonight says nothing about the next few nights */
const lagShare = [];
for (let lag = 1; lag <= LAGS; lag++) {
  let lit = 0, again = 0;
  litBy.forEach(row => {
    for (let n = 0; n + lag < NIGHTS; n++) if (row[n]) { lit++; if (row[n + lag]) again++; }
  });
  const p = lit ? again / lit : 0;
  lagShare.push(Number(p.toFixed(3)));
  if (lit >= 200 && (p < 0.15 || p > 0.35)) {
    fail('lit tonight predicts lit ' + lag + ' nights on', p.toFixed(3));
  }
}
if (rings.length >= 2 && seenSets.size < 2) fail('every night lights the same rings');

/* the weekly rebuild through one night */
let carry = null;
if (next) {
  if (next.size !== N) fail('next week is a different size');
  const NN = 60;
  let surviving = 0, flips = 0, freshFlips = 0, lostCells = 0;
  for (let n = 0; n < NN; n++) {
    const prev = Glow.choose(st.cells, N, n);
    const dark = Glow.rebuild(prev, next.cells, N, n, 1);
    const fresh = Glow.choose(next.cells, N, n);
    const litKeys = new Set(dark.lit.map(r => r.key));
    const freshKeys = new Set(fresh.lit.map(r => r.key));
    dark.rings.forEach(r => {
      const stood = r.cells.some(i => prev.mushCell[i]);
      if (!stood) return;
      surviving++;
      const was = r.cells.some(i => prev.litCell[i]);
      if (was !== litKeys.has(r.key)) flips++;
      if (was !== freshKeys.has(r.key)) freshFlips++;
    });
    for (let i = 0; i < N * N; i++) {
      if (prev.litCell[i] && isMush(next, i) && !dark.litCell[i]) lostCells++;
    }
    const day = Glow.rebuild(prev, next.cells, N, n, 0);
    if (day.lit.map(r => r.key).join(',') !== fresh.lit.map(r => r.key).join(',')) {
      fail('the daytime rebuild is not a fresh choice', 'night ' + n);
    }
  }
  if (flips) fail('a surviving ring flips in the dark', flips + ' of ' + surviving);
  if (lostCells) fail('a lit cell still standing goes dark mid-night', lostCells + ' cells');
  carry = { nights: NN, survivingRingNights: surviving, flips,
            flipsWithoutCarry: freshFlips, lostCells };
}

const failures = [...kinds].map(([k, v]) =>
  k + (v.first ? ' (' + v.first + ')' : '') + (v.count > 1 ? ' x' + v.count : ''));
const report = {
  size: N, mushrooms: mush.length, rings: rings.length,
  serverFieldMatch: mismatch === 0, nights: NIGHTS,
  litShare: Number(share.toFixed(3)), distinctNightSets: seenSets.size,
  litAgainAfter: lagShare, carry,
  ok: failures.length === 0, failures,
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
