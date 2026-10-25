#!/usr/bin/env node
/* The page's thinned forest and its see-through trees, checked in Node on
 * a real snapshot: `node tools/forest_check.js state.json`.
 *
 * - fewer trees are drawn than the sim grows, at most one standing tree a
 *   cell, none on a ford's path or in a clearing, only weeping trees on a
 *   bank (a named plant is always drawn);
 * - every ford has its path and the world has a clearing;
 * - the trunks the creatures walk round are exactly the trees drawn;
 * - the same snapshot draws the same forest;
 * - `occluders` fades a tree between the camera and what it looks at, and
 *   not one behind it, beside the line, or below a line that clears it.
 * FOREST_JS may name another forest.js (the tests' mutants). */
'use strict';
const fs = require('fs');
const path = require('path');

const snap = process.argv[2];
if (!snap) { console.error('usage: forest_check.js state.json'); process.exit(2); }
const st = JSON.parse(fs.readFileSync(snap, 'utf8'));
const F = require(process.env.FOREST_JS ||
                  path.join(__dirname, '..', 'grove', 'page3d', 'forest.js'));
const fails = [];
const n = v => Number(v).toLocaleString('en-AU');
const STANDING = { mature: 1, old: 1 };
const kind = sp => (st.biome && st.biome.kinds && st.biome.kinds[sp]) || '';
const shape = sp => (st.biome && st.biome.shapes && st.biome.shapes[sp]) || '';

const D = F.drawn(st);
const Z = D.zones;
const plants = st.plants || [];
const shown = plants.filter(p => D.ids[p.id]);
const trees = plants.filter(p => kind(p.sp) === 'tree' && p.st !== 'log');
const treesShown = trees.filter(p => D.ids[p.id]);
if (!(treesShown.length <= trees.length * 0.75)) {
  fails.push(`thinning: ${n(treesShown.length)} of ${n(trees.length)} trees drawn`);
}
const perCell = {};
plants.forEach(p => {
  const key = p.x + ',' + p.y;
  if (p.n && !D.ids[p.id]) fails.push(`named plant ${p.id} not drawn`);
  if (!D.ids[p.id] || p.n) return;
  if (kind(p.sp) === 'tree' && STANDING[p.st]) {
    perCell[key] = (perCell[key] || 0) + 1;
    if (perCell[key] > 1) fails.push(`two standing trees drawn in ${key}`);
    if (Z.path[key]) fails.push(`tree ${p.id} on the path at ${key}`);
    if (Z.clear[key]) fails.push(`tree ${p.id} in the clearing at ${key}`);
    if (Z.bank[key] && shape(p.sp) !== 'weeping') {
      fails.push(`${p.sp} ${p.id} hides the bank at ${key}`);
    }
  }
});
const N = Number(st.size) | 0;
let fords = 0;
for (let i = 0; i < N * N; i++) {
  const c = st.cells[i];
  if (c && c[6] === 'f') {
    fords++;
    const key = (i % N) + ',' + Math.floor(i / N);
    if (!Z.path[key]) fails.push(`ford ${key} has no path`);
  }
}
if (!fords) fails.push('no ford in the snapshot');
if (!Z.centres.length) fails.push('no clearing');
const pathCells = Object.keys(Z.path).length;
if (pathCells <= fords) fails.push('the paths go nowhere');

const T = F.trunks(st);
const want = plants.filter(p => STANDING[p.st] && kind(p.sp) === 'tree' &&
                         D.ids[p.id]).map(p => p.id).sort((a, b) => a - b);
const got = Object.keys(T.at).map(Number).sort((a, b) => a - b);
if (JSON.stringify(want) !== JSON.stringify(got)) {
  fails.push(`trunks ${n(got.length)} != trees drawn ${n(want.length)}`);
}

const again = F.drawn(JSON.parse(JSON.stringify(st)));
if (JSON.stringify(again) !== JSON.stringify(D)) fails.push('drawn is not pure');

/* the fade: a camera at (0,5,0) looking at a creature at (10,0.3,0) */
const cam = { x: 0, y: 5, z: 0 };
const tgt = [{ x: 10, y: 0.3, z: 0 }];
const tree = (id, x, z, top) => ({ id, x, z, r: 0.6, y0: 0, top: top || 4 });
const occ = F.occluders([
  tree(1, 7, 0.2),          // in the way, near the creature
  tree(2, 12, 0),           // behind it
  tree(3, 6, 2.5),          // beside the line
  tree(4, 3, 0, 1.5),       // short: the line passes well over it
  tree(5, 9.9, 0),          // the creature's own tree: past t1
], cam, tgt);
if (JSON.stringify(occ) !== '[1]') fails.push(`occluders gave ${JSON.stringify(occ)}, want [1]`);
const two = F.occluders([tree(1, 7, 0), tree(6, -4, 4.5)], cam,
                        tgt.concat([{ x: -8, y: 0.3, z: 9 }]));
if (JSON.stringify(two) !== '[1,6]') fails.push(`two targets gave ${JSON.stringify(two)}`);
if (F.occluders([tree(1, 7, 0)], cam, []).length) fails.push('no target, yet a fade');

if (fails.length) {
  console.log('forest check FAILED');
  fails.slice(0, 40).forEach(f => console.log('  ' + f));
  process.exit(1);
}
console.log(`forest check ok: ${n(treesShown.length)} of ${n(trees.length)} trees drawn, ` +
            `${n(shown.length)} of ${n(plants.length)} plants, ${n(fords)} fords, ` +
            `${n(pathCells)} path cells, ${n(Z.centres.length)} clearings`);
