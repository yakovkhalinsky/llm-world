#!/usr/bin/env node
/* water_check — the grove's water as the page draws it, in Node.
 *
 * Reads a /api/state snapshot (a file, or stdin) and builds the page's own
 * water (`page3d/water.js`, which `world.js` draws as it comes):
 *
 *   - each creek's path runs cell to cell by sides (never only a corner),
 *     every cell of it creek or ford, and every creek or ford cell is on a
 *     creek's path: each creek is one stream, source to mouth;
 *   - the arrays the page draws (`Water.buffers`, which world.js only wraps
 *     in BufferAttributes) put every point at the water's one level, every
 *     normal straight up, every index in range, each triangle facing up;
 *   - every cell of water is covered whole by its own kind's surface (a
 *     creek's, a pond's, a ford's), once, its corners and edges too, so
 *     neighbours meet edge to edge with no gap and no overlap; nothing is
 *     turned off the grid, and no surface lies over dry land (the cell's
 *     middle and a point a quarter in from each corner) — a corner's wedge
 *     reaches under half a cell;
 *   - two cells of water that touch only at a corner are joined across it;
 *   - a creek's ripple has no seams: wherever a point of a creek's surface
 *     (a square's or a wedge's) lies on another of its triangles, the two
 *     agree on its uv; and down the path from source to mouth the ripple's
 *     v only grows;
 *   - the floor (bilinear between cell centres, as the page's ground is)
 *     stays under the water all the way down every creek, fords too, and
 *     every bed is under the water's one level;
 *   - everything that stands (a plant, a mushroom, a carcass) stands at or
 *     above the water (`Water.standAt`): the sim grows plants on fords,
 *     whose stones are under the creek.
 *
 * A lint (reported, and failing, but no mutant tests it: it reads the
 * source) that world.js draws water.js's buffers, floor and stand heights.
 *
 *   node tools/water_check.js snapshot.json
 *   GROVE_WATER=/path/to/mutant/water.js node tools/water_check.js s.json
 *   GROVE_WORLD=/path/to/world.js node tools/water_check.js s.json   (the lint)
 *
 * Prints a JSON report and exits 1 on any failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, '..', 'grove', 'page3d');
const Water = require(process.env.GROVE_WATER || path.join(PAGE, 'water.js'));
const worldSrc = fs.readFileSync(process.env.GROVE_WORLD ||
                                 path.join(PAGE, 'world.js'), 'utf8');

const st = JSON.parse(process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8')
                                      : fs.readFileSync(0, 'utf8'));
const N = st.size;

const kinds = new Map();
function fail(kind, detail) {
  const k = kinds.get(kind);
  if (k) k.count++;
  else kinds.set(kind, { first: detail || '', count: 1 });
}
const xy = i => '(' + (i % N) + ',' + Math.floor(i / N) + ')';

/* which water each cell is, read here from the snapshot (not water.js) */
const kindOf = new Uint8Array(N * N);
for (let i = 0; i < N * N; i++) {
  const c = st.cells[i] || ['s'];
  kindOf[i] = c[6] === 'c' ? 1 : c[6] === 'f' ? 3 : c[0] === 'w' ? 2 : 0;
}
const isStream = i => kindOf[i] === 1 || kindOf[i] === 3;

/* ---- each creek is one stream ---------------------------------------- */
const creeks = st.creeks || [];
const creekOf = new Int32Array(N * N).fill(-1);
creeks.forEach((p, ci) => {
  p.forEach((q, k) => {
    const i = q[1] * N + q[0];
    if (!(q[0] >= 0 && q[1] >= 0 && q[0] < N && q[1] < N)) {
      fail('a creek runs off the grove', 'creek ' + ci + ' at ' + q);
      return;
    }
    if (!isStream(i)) fail('a creek path cell is not creek or ford', xy(i));
    if (creekOf[i] < 0) creekOf[i] = ci;
    if (k) {
      const d = Math.abs(q[0] - p[k - 1][0]) + Math.abs(q[1] - p[k - 1][1]);
      if (d !== 1) fail('a creek steps by a corner or jumps',
                        'creek ' + ci + ' ' + p[k - 1] + ' -> ' + q);
    }
  });
  if (p.length) {
    const a = p[0], b = p[p.length - 1];
    const edge = q => q[0] === 0 || q[1] === 0 || q[0] === N - 1 || q[1] === N - 1;
    if (!edge(a) || !edge(b)) fail('a creek does not run edge to edge', 'creek ' + ci);
  }
});
for (let i = 0; i < N * N; i++) {
  if (isStream(i) && creekOf[i] < 0) fail('creek water off every creek path', xy(i));
}

/* ponds: 4-connected pieces of pond water */
const seen = new Uint8Array(N * N);
let ponds = 0, pondCells = 0;
for (let i = 0; i < N * N; i++) {
  if (kindOf[i] !== 2 || seen[i]) continue;
  ponds++;
  const stack = [i];
  seen[i] = 1;
  while (stack.length) {
    const j = stack.pop();
    pondCells++;
    const x = j % N, y = (j - x) / N;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = ny * N + nx;
      if (nx >= 0 && ny >= 0 && nx < N && ny < N && kindOf[k] === 2 && !seen[k]) {
        seen[k] = 1;
        stack.push(k);
      }
    }
  }
}

/* ---- the arrays the page draws ---------------------------------------- */
const S = Water.surfaces(st);
const tris = [];          // [kind, ax, az, bx, bz, cx, cz, au, av, bu, bv, cu, cv]
const bucket = new Map(); // cell -> triangle indices
const verts = [];         // [kind, x, z, u, v]
[1, 2, 3].forEach(k => {
  const s = S[k];
  if (!s) { fail('a kind of water has no surface', String(k)); return; }
  const B = Water.buffers(s);
  const n = B.position.length / 3;
  if (B.normal.length !== n * 3 || B.uv.length !== n * 2) {
    fail('the buffers disagree in length', Water.NAME[k]);
  }
  for (let v = 0; v < n; v++) {
    if (B.position[v * 3 + 1] !== Water.Y) {
      fail('a point of water off the one level', Water.NAME[k] + ' y ' + B.position[v * 3 + 1]);
    }
    if (B.normal[v * 3] !== 0 || B.normal[v * 3 + 1] !== 1 || B.normal[v * 3 + 2] !== 0) {
      fail('a normal of the water not straight up', Water.NAME[k]);
    }
    verts.push([k, B.position[v * 3], B.position[v * 3 + 2], B.uv[v * 2], B.uv[v * 2 + 1]]);
  }
  if (B.index.length % 3) fail('the index is not whole triangles', Water.NAME[k]);
  for (let t = 0; t + 2 < B.index.length; t += 3) {
    const id = [B.index[t], B.index[t + 1], B.index[t + 2]];
    if (id.some(j => !(j >= 0 && j < n))) {
      fail('an index past the points', Water.NAME[k]);
      continue;
    }
    const p = id.map(j => [B.position[j * 3], B.position[j * 3 + 2]]);
    const cross = (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]) -
      (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]);
    if (cross <= 0) fail('a water triangle faces down or is empty', Water.NAME[k]);
    const ti = tris.length;
    tris.push([k, p[0][0], p[0][1], p[1][0], p[1][1], p[2][0], p[2][1],
               ...id.flatMap(j => [B.uv[j * 2], B.uv[j * 2 + 1]])]);
    const xs = p.map(q => q[0]), zs = p.map(q => q[1]);
    for (let z = Math.floor(Math.min(...zs) + 1e-9); z <= Math.floor(Math.max(...zs) - 1e-9); z++) {
      for (let x = Math.floor(Math.min(...xs) + 1e-9); x <= Math.floor(Math.max(...xs) - 1e-9); x++) {
        if (x < 0 || z < 0 || x >= N || z >= N) {
          fail('water drawn off the grove', x + ',' + z);
          continue;
        }
        const c = z * N + x;
        if (!bucket.has(c)) bucket.set(c, []);
        bucket.get(c).push(ti);
      }
    }
  }
});
function inside(t, x, z) {
  const e = 1e-9;
  const d = (ax, az, bx, bz) => (bz - az) * (x - ax) - (bx - ax) * (z - az);
  const d1 = d(t[1], t[2], t[3], t[4]), d2 = d(t[3], t[4], t[5], t[6]),
    d3 = d(t[5], t[6], t[1], t[2]);
  const neg = d1 < -e || d2 < -e || d3 < -e, pos = d1 > e || d2 > e || d3 > e;
  return !(neg && pos);
}
function trisAt(x, z) {
  const cx = Math.min(N - 1, Math.max(0, Math.floor(x))),
    cz = Math.min(N - 1, Math.max(0, Math.floor(z)));
  const out = [];
  const seenT = new Set();
  for (let oz = -1; oz <= 1; oz++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (cx + ox < 0 || cx + ox >= N) continue;
      const b = bucket.get((cz + oz) * N + cx + ox);
      if (!b) continue;
      for (const ti of b) {
        if (seenT.has(ti)) continue;
        seenT.add(ti);
        if (inside(tris[ti], x, z)) out.push(ti);
      }
    }
  }
  return out;
}
const covering = (x, z) => trisAt(x, z).map(ti => tris[ti][0]);
/* a triangle's uv at a point, by barycentric weights */
function uvIn(t, x, z) {
  const [ax, az, bx, bz, cx, cz] = t.slice(1, 7);
  const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
  const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
  const l3 = 1 - l1 - l2;
  return [l1 * t[7] + l2 * t[9] + l3 * t[11], l1 * t[8] + l2 * t[10] + l3 * t[12]];
}
const IN = [0.13, 0.41, 0.66, 0.92];     // off a square's diagonals
const EDGE = [0, 0.25, 0.5, 0.75, 1];
let waterCells = 0;
for (let i = 0; i < N * N; i++) {
  const x = i % N, z = (i - x) / N;
  if (!kindOf[i]) {
    for (const [u, v] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      if (covering(x + u, z + v).length) {
        fail('water drawn over dry land', xy(i) + ' +' + u + ',' + v);
      }
    }
    continue;
  }
  waterCells++;
  for (const u of IN) {
    for (const v of IN) {
      const c = covering(x + u, z + v);
      if (!c.includes(kindOf[i])) {
        fail('a cell of water is not covered whole by its own surface',
             Water.NAME[kindOf[i]] + ' ' + xy(i));
      } else if (c.length !== 1) {
        fail('water surfaces overlap', xy(i) + ' x' + c.length);
      }
    }
  }
  for (const u of EDGE) {
    for (const v of EDGE) {
      if (u > 0 && u < 1 && v > 0 && v < 1) continue;
      if (!covering(x + u, z + v).length) {
        fail('a gap at the edge of a cell of water', xy(i) + ' +' + u + ',' + v);
      }
    }
  }
}

/* corners only two diagonal cells of water share are joined, by a wedge
 * under half a cell */
if (!(Water.WEDGE > 0 && Water.WEDGE < 0.5)) fail('a corner\'s wedge is not under half a cell', String(Water.WEDGE));
let diagonals = 0;
for (let gz = 1; gz < N; gz++) {
  for (let gx = 1; gx < N; gx++) {
    const a = (gz - 1) * N + gx - 1, b = a + 1, c = a + N, d = c + 1;
    for (const [w0, w1, l0, l1] of [[a, d, b, c], [b, c, a, d]]) {
      if (!kindOf[w0] || !kindOf[w1] || kindOf[l0] || kindOf[l1]) continue;
      diagonals++;
      for (const l of [l0, l1]) {
        const lx = l % N, lz = (l - lx) / N;
        const px = gx + (lx < gx ? -0.08 : 0.08), pz = gz + (lz < gz ? -0.08 : 0.08);
        if (!covering(px, pz).length) {
          fail('water touching only at a corner is not joined', '(' + gx + ',' + gz + ')');
        }
      }
    }
  }
}

/* ---- a creek's ripple has no seams, and runs downstream --------------- */
/* each triangle's creek: its cell's, or for a wedge in a dry cell, the
 * creek of the water across the corner it reaches from */
function creekOfTri(t) {
  const cx = (t[1] + t[3] + t[5]) / 3, cz = (t[2] + t[4] + t[6]) / 3;
  const c = Math.floor(cz) * N + Math.floor(cx);
  if (kindOf[c]) return creekOf[c];
  for (let o = 0; o < 3; o++) {
    const gx = t[1 + o * 2], gz = t[2 + o * 2];
    if (gx !== Math.round(gx) || gz !== Math.round(gz)) continue;
    for (const [dx, dz] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
      const x = gx + dx, z = gz + dz;
      if (x >= 0 && z >= 0 && x < N && z < N && creekOf[z * N + x] >= 0) {
        return creekOf[z * N + x];
      }
    }
  }
  return -1;
}
const triCreek = tris.map(t => (t[0] === 1 || t[0] === 3) ? creekOfTri(t) : -1);
let seams = 0;
tris.forEach((t, ti) => {
  const ci = triCreek[ti];
  if (ci < 0) return;
  for (let o = 0; o < 3; o++) {
    const x = t[1 + o * 2], z = t[2 + o * 2], u = t[7 + o * 2], v = t[8 + o * 2];
    for (const tj of trisAt(x, z)) {
      if (tj === ti || triCreek[tj] !== ci) continue;
      const w = uvIn(tris[tj], x, z);
      if (Math.abs(w[0] - u) > 1e-6 || Math.abs(w[1] - v) > 1e-6) {
        seams++;
        fail('a seam in a creek\'s ripple', 'creek ' + ci + ' at ' + x + ',' + z +
             ': ' + u + ',' + v + ' vs ' + w[0].toFixed(3) + ',' + w[1].toFixed(3));
      }
    }
  }
});
function vAt(x, z) {
  for (const ti of trisAt(x, z)) {
    if (tris[ti][0] === 1 || tris[ti][0] === 3) return uvIn(tris[ti], x, z)[1];
  }
  return undefined;
}
creeks.forEach((p, ci) => {
  let last = -Infinity;
  p.forEach(q => {
    const v = vAt(q[0] + 0.5, q[1] + 0.5);
    if (v === undefined) return;
    if (v < last - 1e-9) fail('a creek\'s ripple runs upstream', 'creek ' + ci + ' at ' + q);
    last = Math.max(last, v);
  });
  if (p.length > 1) {
    const v0 = vAt(p[0][0] + 0.5, p[0][1] + 0.5);
    const v1 = vAt(p[p.length - 1][0] + 0.5, p[p.length - 1][1] + 0.5);
    if (!(v1 - v0 >= N / 2)) fail('a creek\'s ripple does not run source to mouth', 'creek ' + ci);
  }
});

/* ---- the floor stays under the water down every creek ---------------- */
if (!(Water.BED < Water.Y && Water.FORD_BED < Water.Y)) {
  fail('a bed is not under the water', 'Y ' + Water.Y + ' bed ' + Water.BED +
       ' ford ' + Water.FORD_BED);
}
const H = Water.heights(st);
let floorMax = -Infinity;
creeks.forEach((p, ci) => {
  for (let k = 0; k + 1 < p.length; k++) {
    for (let s = 0; s <= 8; s++) {
      const f = s / 8;
      const x = p[k][0] + 0.5 + (p[k + 1][0] - p[k][0]) * f;
      const z = p[k][1] + 0.5 + (p[k + 1][1] - p[k][1]) * f;
      const h = Water.floorAt(H, N, x, z);
      floorMax = Math.max(floorMax, h);
      if (h > Water.Y - 0.02) {
        fail('the floor rises out of a creek', 'creek ' + ci + ' at ' +
             x.toFixed(2) + ',' + z.toFixed(2) + ' floor ' + h.toFixed(3));
      }
    }
  }
});

/* ---- everything standing stands at or above the water ---------------- */
const floor = (x, z) => Water.floorAt(H, N, x, z);
const standing = [];      // [what, cell]
(Array.isArray(st.plants) ? st.plants : []).forEach(p => {
  if (p.x >= 0 && p.y >= 0 && p.x < N && p.y < N) standing.push(['plant', p.y * N + p.x]);
});
for (let i = 0; i < N * N; i++) {
  const c = st.cells[i];
  if (c && c[3]) standing.push(['mushroom', i]);
  if (c && c[4]) standing.push(['carcass', i]);
}
let standingOnFords = 0, standLow = Infinity;
for (const [what, i] of standing) {
  const x = i % N, z = (i - x) / N;
  if (kindOf[i] === 3) standingOnFords++;
  for (const u of [0.15, 0.5, 0.85]) {
    for (const v of [0.15, 0.5, 0.85]) {
      const h = Water.standAt(floor, x + u, z + v);
      standLow = Math.min(standLow, h);
      if (h < Water.Y || h < floor(x + u, z + v)) {
        fail('something stands under the water', what + ' ' + xy(i) + ' at ' + h.toFixed(3));
      }
    }
  }
}

/* ---- the lint: world.js draws water.js's ----------------------------- */
const lint = {
  'its water from water.js\'s buffers': 'Water.buffers(sheets[kind])',
  'its floor from water.js': 'cellH[i] = Water.cellHeight(c);',
  'its stand heights from water.js': 'Water.standAt(heightAt, x, z)',
};
for (const [what, src] of Object.entries(lint)) {
  if (!worldSrc.includes(src)) fail('lint: world.js does not draw ' + what, src);
}
for (const site of ['const gy = standAt(spot.x, spot.z);', 'const gy = standAt(px, pz);',
                    'B.mound.add(place(px, standAt(px, pz) + 0.04']) {
  if (!worldSrc.includes(site)) fail('lint: world.js stands something on the bare floor', site);
}
if (/InstancedMesh\(waterGeo|const yaw = dx \|\| dz/.test(worldSrc)) {
  fail('lint: world.js still turns a sheet per cell of water');
}

const failures = [...kinds].map(([k, v]) =>
  k + (v.first ? ' (' + v.first + ')' : '') + (v.count > 1 ? ' x' + v.count : ''));
const report = {
  size: N, creeks: creeks.length,
  creekCells: [...kindOf].filter(k => k === 1).length,
  fords: [...kindOf].filter(k => k === 3).length,
  ponds, pondCells, waterCells, diagonalJoins: diagonals, seams,
  floorMaxOnCreeks: Number(floorMax.toFixed(3)),
  standing: standing.length, standingOnFords,
  standLowest: standing.length ? Number(standLow.toFixed(3)) : null,
  ok: failures.length === 0, failures,
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
