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
 *   - a night with rings lights at least one, and over many nights about
 *     one ring in four glows; different nights light different rings;
 *   - a cell glows only within reach of a lit ring.
 *
 *   node tools/glow_check.js snapshot.json
 *   GROVE_GLOW=/path/to/mutant/glow.js node tools/glow_check.js s.json
 *
 * Prints a JSON report and exits 1 on any failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const Glow = require(process.env.GROVE_GLOW ||
                     path.join(__dirname, '..', 'grove', 'page3d', 'glow.js'));

const src = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8')
                            : fs.readFileSync(0, 'utf8');
const st = JSON.parse(src);
const N = st.size;
const failures = [];
function fail(msg) { if (failures.length < 20) failures.push(msg); }

const mush = [];
for (let i = 0; i < N * N; i++) if (st.cells[i] && st.cells[i][3]) mush.push(i);

/* the rings partition the mushroom cells, and are 8-separated */
const rings = Glow.rings(st.cells, N);
const owner = new Int32Array(N * N).fill(-1);
rings.forEach((r, k) => r.cells.forEach(i => {
  if (owner[i] !== -1) fail('cell ' + i + ' in two rings');
  if (!(st.cells[i] && st.cells[i][3])) fail('ring cell ' + i + ' has no mushroom');
  owner[i] = k;
  if (r.key !== Math.min.apply(null, r.cells)) fail('ring key is not its first cell');
}));
mush.forEach(i => {
  if (owner[i] === -1) fail('mushroom cell ' + i + ' in no ring');
  const x = i % N, y = (i - x) / N;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
    const j = ny * N + nx;
    if (owner[j] !== -1 && owner[j] !== owner[i]) fail('rings touch at ' + i);
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
if (mismatch) fail(mismatch + ' cells differ from the server glow field');

/* many nights */
const NIGHTS = 200;
let litSum = 0, ringSum = 0, emptyNights = 0;
const seenSets = new Set();
for (let n = 0; n < NIGHTS; n++) {
  const a = Glow.choose(st.cells, N, n);
  const b = Glow.choose(st.cells, N, n);
  const ka = a.lit.map(r => r.key).join(',');
  if (ka !== b.lit.map(r => r.key).join(',')) fail('night ' + n + ' not deterministic');
  seenSets.add(ka);
  if (a.rings.length && !a.lit.length) emptyNights++;
  litSum += a.lit.length;
  ringSum += a.rings.length;
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
    if (!near) { fail('night ' + n + ': cell ' + i + ' glows far from a lit ring'); break; }
  }
  if (a.litCell.some((v, i) => v && !(st.cells[i] && st.cells[i][3]))) {
    fail('night ' + n + ' lights a cell with no mushroom');
  }
}
if (emptyNights) fail(emptyNights + ' nights with rings light none');
const share = ringSum ? litSum / ringSum : 0;
if (rings.length >= 4 && (share < 0.15 || share > 0.4)) {
  fail('lit share ' + share.toFixed(3) + ' is not about one in four');
}
if (rings.length >= 2 && seenSets.size < 2) fail('every night lights the same rings');

const report = {
  size: N, mushrooms: mush.length, rings: rings.length,
  serverFieldMatch: mismatch === 0, nights: NIGHTS,
  litShare: Number(share.toFixed(3)), distinctNightSets: seenSets.size,
  ok: failures.length === 0, failures,
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
