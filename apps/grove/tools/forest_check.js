#!/usr/bin/env node
/* The page's thinned forest and its see-through trees, checked in Node on
 * a real snapshot: `node tools/forest_check.js state.json`.
 *
 * - fewer trees are drawn than the sim grows, at most one standing tree a
 *   cell, none on a ford's path or in a clearing, only weeping trees on a
 *   bank (a named plant is always drawn);
 * - every ford has its path and the world has a clearing;
 * - the trunks the creatures walk round are exactly the trees drawn, the
 *   page builds its plant meshes from Forest.drawList only (world.js's
 *   buildPlants is read and held to that; WORLD_JS may name a mutant), and
 *   drawList is the drawn plants on the map;
 * - the page's router (walk.js, four ways, round the trunks) reaches every
 *   land cell of the map from every other;
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

/* the plants the page draws: drawList, the drawn ones on the map */
const list = F.drawList(st);
const wantList = plants.filter(p => D.ids[p.id] && p.x >= 0 && p.y >= 0 &&
                                    p.x < (st.size | 0) && p.y < (st.size | 0))
  .map(p => p.id);
if (JSON.stringify(list.map(p => p.id)) !== JSON.stringify(wantList)) {
  fails.push(`drawList ${n(list.length)} != drawn plants ${n(wantList.length)}`);
}
const listTrees = list.filter(p => STANDING[p.st] && kind(p.sp) === 'tree')
  .map(p => p.id).sort((a, b) => a - b);
if (JSON.stringify(listTrees) !== JSON.stringify(got)) {
  fails.push(`drawList standing trees ${n(listTrees.length)} != trunks ${n(got.length)}`);
}

/* world.js: buildPlants draws from drawList and from nothing else */
const worldSrc = fs.readFileSync(process.env.WORLD_JS ||
  path.join(__dirname, '..', 'grove', 'page3d', 'world.js'), 'utf8');
const bodyOf = (src, head) => {
  const at = src.indexOf(head);
  if (at < 0) return null;
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i + 1, j);
  }
  return null;
};
const bp = bodyOf(worldSrc, 'function buildPlants(st)');
if (!bp) {
  fails.push('world.js has no buildPlants(st)');
} else {
  const m = bp.match(/const (\w+) = Forest\.drawList\(st\);/);
  if (!m) fails.push('world.js buildPlants does not take Forest.drawList(st)');
  const loops = bp.match(/for \([^)]*\)/g) || [];
  const plantLoops = loops.filter(l => /\bp\b/.test(l) || /plants/.test(l));
  if (!m || plantLoops.length !== 1 ||
      plantLoops[0] !== `for (const p of ${m[1]})`) {
    fails.push(`world.js buildPlants loops ${JSON.stringify(plantLoops)}, ` +
               'not once over the drawList');
  }
  if (/\bplants\b|st\.plants|\bshown\b/.test(bp.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))) {
    fails.push('world.js buildPlants reaches past drawList to the plants');
  }
}

/* the router: four ways round the trunks, every land cell reachable */
require(path.join(__dirname, '..', '..', 'shared', 'page3d', 'walk.js'));
const Walk = globalThis.Page3DWalk;
const grid = Walk.buildGrid(F.subGround(st), { solid: { trunk: 1 } });
Walk.setFixtures(grid, T.fixtures);
{
  const SUB = F.SUB, GW = grid.W;
  const open = i => grid.base[i] && !grid.solid[i];
  const seen = new Uint8Array(grid.n);
  let start = -1;
  for (let i = 0; i < grid.n && start < 0; i++) if (open(i)) start = i;
  const todo = start >= 0 ? [start] : [];
  if (start >= 0) seen[start] = 1;
  while (todo.length) {
    const i = todo.pop(), x = i % GW, y = (i - x) / GW;
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GW || ny >= grid.H) return;
      const j = ny * GW + nx;
      if (!seen[j] && open(j)) { seen[j] = 1; todo.push(j); }
    });
  }
  let lost = 0, first = '';
  for (let cy = 0; cy < N; cy++) {
    for (let cx = 0; cx < N; cx++) {
      const c = st.cells[cy * N + cx];
      if (!c || c[0] === 'w') continue;
      let reach = false;
      for (let q = 0; q < SUB * SUB; q++) {
        const i = (cy * SUB + (q / SUB | 0)) * GW + cx * SUB + q % SUB;
        if (seen[i]) reach = true;
      }
      if (!reach) { lost++; if (!first) first = cx + ',' + cy; }
    }
  }
  if (lost) fails.push(`the router cannot reach ${n(lost)} land cells (first ${first})`);
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
