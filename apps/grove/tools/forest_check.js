#!/usr/bin/env node
/* The page's thinned forest and its see-through trees, checked in Node on
 * a real snapshot: `node tools/forest_check.js state.json`.
 *
 * - fewer trees are drawn than the sim grows, at most one standing tree a
 *   cell, none on a ford's path or in a clearing, only weeping trees on a
 *   bank (a named plant is always drawn);
 * - every ford has its path and the world has a clearing (if any cell
 *   two in from the edge is open land: a 4×4 map has none);
 * - the trunks the creatures walk round are exactly the trees drawn, the
 *   page builds its plant meshes from Forest.drawList only (world.js's
 *   buildPlants is read and held to that; WORLD_JS may name a mutant), and
 *   drawList is the drawn plants on the map;
 * - the page's router (walk.js, four ways, round the trunks) reaches every
 *   land cell of the map from every other (`--reach maps.jsonl` runs only
 *   this check, on many snapshots, one a line, each with a "tag");
 * - the same snapshot draws the same forest;
 * - forest.js `batch` (world.js's instanced meshes) grows past its
 *   capacity and keeps every matrix, colour and owner (a stub THREE);
 * - `occluders` fades a tree between the camera and what it looks at, and
 *   not one behind it, beside the line, or below a line that clears it.
 * FOREST_JS may name another forest.js (the tests' mutants). */
'use strict';
const fs = require('fs');
const path = require('path');

const F = require(process.env.FOREST_JS ||
                  path.join(__dirname, '..', 'grove', 'page3d', 'forest.js'));
require(path.join(__dirname, '..', '..', 'shared', 'page3d', 'walk.js'));
const Walk = globalThis.Page3DWalk;
const n = v => Number(v).toLocaleString('en-AU');

/* the router: four ways round the trunks, every land cell reachable from
 * every other. Returns '' or what is wrong. */
function routerLost(st) {
  const N = Number(st.size) | 0;
  const T = F.trunks(st);
  const grid = Walk.buildGrid(F.subGround(st), { solid: { trunk: 1 } });
  Walk.setFixtures(grid, T.fixtures);
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
  return lost ? `the router cannot reach ${n(lost)} land cells (first ${first})` : '';
}

/* `--reach file.jsonl`: only the router check, on many snapshots (one a
 * line, each with a "tag"), in one process; prints each that fails. */
if (process.argv[2] === '--reach') {
  let bad = 0, all = 0;
  fs.readFileSync(process.argv[3], 'utf8').split('\n').forEach(line => {
    if (!line.trim()) return;
    const st = JSON.parse(line);
    all++;
    const lost = routerLost(st);
    if (lost) { bad++; console.log(`${st.tag}: ${lost}`); }
  });
  console.log(`router reach: ${n(all - bad)} of ${n(all)} maps whole`);
  process.exit(bad ? 1 : 0);
}

const snap = process.argv[2];
if (!snap) { console.error('usage: forest_check.js state.json | --reach maps.jsonl'); process.exit(2); }
const st = JSON.parse(fs.readFileSync(snap, 'utf8'));
const fails = [];
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
if (!Z.centres.length) {
  /* none is right only when no cell two in from the edge is open land */
  let open = 0;
  for (let y = 2; y < N - 2; y++) for (let x = 2; x < N - 2; x++) {
    const c = st.cells[y * N + x], key = x + ',' + y;
    if (c && c[0] !== 'w' && !Z.bank[key] && !Z.path[key]) open++;
  }
  if (open) fails.push(`no clearing, with ${n(open)} open cells for one`);
}
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
  const code = bp.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  if (/\bplants\b|st\.plants|\bshown\b|plantById|Object\.(values|keys|entries)\(\s*plant/.test(code)) {
    fails.push('world.js buildPlants reaches past drawList to the plants');
  }
  /* the list is only read: its declaration, its length and the one loop
   * (so nothing pushes, splices or swaps more plants onto it) */
  if (m) {
    const L = m[1];
    const uses = code.match(new RegExp(`[^\\s]*\\s*\\b${L}\\b[^\\s;]*`, 'g')) || [];
    const ok = [`const ${L}`, `${L}.length`, `of ${L})`];
    const rest = code.replace(`const ${L} = Forest.drawList(st);`, '')
      .replace(`for (const p of ${L})`, '').replace(new RegExp(`\\b${L}\\.length\\b`, 'g'), '');
    if (new RegExp(`\\b${L}\\b`).test(rest)) {
      fails.push(`world.js buildPlants does more with ${L} than read it: ` +
                 JSON.stringify(uses.filter(u => !ok.some(o => u.includes(o)))));
    }
  }
}

{
  const lost = routerLost(st);
  if (lost) fails.push(lost);
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

/* the batches grow, they never drop: a stub THREE (the same shapes as
 * three's InstancedMesh: a matrix array of 16 a slot, colours made on the
 * first setColorAt), a ghost-sized batch (32) and past its capacity mid-build,
 * one over and then many over, every matrix and colour kept */
function batchLost(cap, count) {
  const live = new Set();
  const made = [];
  const scene = { add: m => live.add(m), remove: m => live.delete(m) };
  function Color(r, g, b) { this.r = r; this.g = g; this.b = b; }
  Color.prototype.toArray = function (a, o) { a[o] = this.r; a[o + 1] = this.g; a[o + 2] = this.b; };
  function InstancedMesh(geo, mat, c) {
    this.slots = c;
    this.count = c;
    this.instanceMatrix = { array: new Float32Array(c * 16), setUsage() {} };
    this.instanceColor = null;
    this.disposed = false;
    made.push(this);
  }
  InstancedMesh.prototype.setMatrixAt = function (i, m) {
    if (i >= this.slots) throw new Error(`slot ${i} past ${this.slots}`);
    m.toArray(this.instanceMatrix.array, i * 16);
  };
  InstancedMesh.prototype.setColorAt = function (i, c) {
    if (i >= this.slots) throw new Error(`slot ${i} past ${this.slots}`);
    if (!this.instanceColor) {
      this.instanceColor = { array: new Float32Array(this.slots * 3).fill(1) };
    }
    c.toArray(this.instanceColor.array, i * 3);
  };
  InstancedMesh.prototype.dispose = function () { this.disposed = true; };
  const THREE = { Color, InstancedMesh, DynamicDrawUsage: 35048 };
  const mat = i => ({ toArray(a, o) { for (let k = 0; k < 16; k++) a[o + k] = i * 16 + k + 1; } });
  const out = [];
  let b;
  try {
    b = F.batch(THREE, scene, null, null, cap, { noShadow: true });
    b.begin(0);
    for (let i = 0; i < count; i++) b.add(mat(i), new Color(i + 1, -(i + 1), i / 1000), 'p' + i);
    b.end();
  } catch (e) {
    return [`batch ${cap}+${count - cap}: ${e.message}`];
  }
  const m = b.mesh;
  if (b.n !== count) out.push(`n is ${b.n}, want ${count}`);
  if (m.count !== count) out.push(`count is ${m.count}, want ${count}`);
  if (b.cap < count || m.slots < count) out.push(`capacity ${b.cap} under ${count}`);
  if (live.size !== 1 || !live.has(m)) out.push(`the scene holds ${live.size} meshes, not the batch's one`);
  if (made.some(x => x !== m && !x.disposed)) out.push('an outgrown mesh was not disposed');
  let badM = 0, badC = 0, badO = 0;
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 16; k++) if (m.instanceMatrix.array[i * 16 + k] !== i * 16 + k + 1) { badM++; break; }
    const c = m.instanceColor ? m.instanceColor.array : [];
    if (c[i * 3] !== i + 1 || c[i * 3 + 1] !== -(i + 1) ||
        c[i * 3 + 2] !== Math.fround(i / 1000)) badC++;
    if (b.owner[i] !== 'p' + i) badO++;
  }
  if (badM) out.push(`${badM} of ${count} matrices lost`);
  if (badC) out.push(`${badC} of ${count} colours lost`);
  if (badO) out.push(`${badO} of ${count} owners lost`);
  return out.map(f => `batch ${cap}+${count - cap}: ${f}`);
}
[[32, 33], [32, 200], [8, 9], [64, 64]].forEach(([cap, count]) => {
  batchLost(cap, count).forEach(f => fails.push(f));
});

if (fails.length) {
  console.log('forest check FAILED');
  fails.slice(0, 40).forEach(f => console.log('  ' + f));
  process.exit(1);
}
console.log(`forest check ok: ${n(treesShown.length)} of ${n(trees.length)} trees drawn, ` +
            `${n(shown.length)} of ${n(plants.length)} plants, ${n(fords)} fords, ` +
            `${n(pathCells)} path cells, ${n(Z.centres.length)} clearings`);
