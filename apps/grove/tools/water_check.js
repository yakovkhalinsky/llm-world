#!/usr/bin/env node
/* water_check — the grove's water as the page draws it, in Node.
 *
 * Reads a /api/state snapshot (a file, or stdin) and builds the page's own
 * water (`page3d/water.js`, which `world.js` draws as it comes):
 *
 *   - each creek's path runs cell to cell by sides (never only a corner),
 *     every cell of it creek or ford, and every creek or ford cell is on a
 *     creek's path: each creek is one stream, source to mouth;
 *   - every cell of water is covered whole by its own kind's surface (a
 *     creek's, a pond's, a ford's), once, its corners and edges too, so
 *     neighbours meet edge to edge with no gap and no overlap; nothing is
 *     turned off the grid, and no surface lies over dry land except a
 *     corner's wedge;
 *   - two cells of water that touch only at a corner are joined across it;
 *   - a creek's ripple has no seams: where two of its cells (creek or ford)
 *     share a corner they give it the same uv, and down the path from
 *     source to mouth the ripple's v only grows;
 *   - the floor (bilinear between cell centres, as the page's ground is)
 *     stays under the water all the way down every creek, fords too, and
 *     every bed is under the water's one level;
 *   - `world.js` draws exactly these surfaces, flat at that one level,
 *     never culled, and its floor is water.js's.
 *
 *   node tools/water_check.js snapshot.json
 *   GROVE_WATER=/path/to/mutant/water.js node tools/water_check.js s.json
 *   GROVE_WORLD=/path/to/mutant/world.js node tools/water_check.js s.json
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

/* ---- the surfaces cover the water ------------------------------------ */
const S = Water.surfaces(st);
const tris = [];          // [kind, ax, az, bx, bz, cx, cz]
const bucket = new Map(); // cell -> triangle indices
[1, 2, 3].forEach(k => {
  const s = S[k];
  if (!s) { fail('a kind of water has no surface', String(k)); return; }
  for (let t = 0; t < s.idx.length; t += 3) {
    const p = [0, 1, 2].map(o => [s.pos[s.idx[t + o] * 2], s.pos[s.idx[t + o] * 2 + 1]]);
    const cross = (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]) -
      (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]);
    if (cross <= 0) fail('a water triangle faces down or is empty', String(k));
    const ti = tris.length;
    tris.push([k, p[0][0], p[0][1], p[1][0], p[1][1], p[2][0], p[2][1]]);
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
function covering(x, z) {
  const cx = Math.min(N - 1, Math.max(0, Math.floor(x))),
    cz = Math.min(N - 1, Math.max(0, Math.floor(z)));
  const out = [];
  const seenT = new Set();
  for (let oz = -1; oz <= 1; oz++) {
    for (let ox = -1; ox <= 1; ox++) {
      const b = bucket.get((cz + oz) * N + cx + ox);
      if (!b || cx + ox < 0 || cx + ox >= N) continue;
      for (const ti of b) {
        if (seenT.has(ti)) continue;
        seenT.add(ti);
        if (inside(tris[ti], x, z)) out.push(tris[ti][0]);
      }
    }
  }
  return out;
}
const IN = [0.13, 0.41, 0.66, 0.92];     // off a square's diagonals
const EDGE = [0, 0.25, 0.5, 0.75, 1];
let waterCells = 0;
for (let i = 0; i < N * N; i++) {
  const x = i % N, z = (i - x) / N;
  if (!kindOf[i]) {
    if (covering(x + 0.5, z + 0.5).length) fail('water drawn over dry land', xy(i));
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

/* corners only two diagonal cells of water share are joined */
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
let seams = 0;
const uvAt = new Map();
const cellV = new Map();
[1, 3].forEach(k => {
  const s = S[k];
  if (!s || !s.cells) return;
  s.cells.forEach((cell, q) => {
    const ci = creekOf[cell];
    let vs = 0;
    for (let o = 0; o < 4; o++) {
      const vi = q * 4 + o;
      const key = ci + ':' + s.pos[vi * 2] + ',' + s.pos[vi * 2 + 1];
      const uv = s.uv[vi * 2] + ',' + s.uv[vi * 2 + 1];
      vs += s.uv[vi * 2 + 1];
      if (ci < 0) continue;
      if (uvAt.has(key) && uvAt.get(key) !== uv) {
        seams++;
        fail('a seam in a creek\'s ripple', 'creek ' + ci + ' at ' +
             key.split(':')[1] + ': ' + uvAt.get(key) + ' vs ' + uv);
      } else uvAt.set(key, uv);
    }
    cellV.set(cell, vs / 4);
  });
});
creeks.forEach((p, ci) => {
  let last = -Infinity;
  p.forEach(q => {
    const v = cellV.get(q[1] * N + q[0]);
    if (v === undefined) return;
    if (v < last - 1e-9) fail('a creek\'s ripple runs upstream', 'creek ' + ci + ' at ' + q);
    last = Math.max(last, v);
  });
  if (p.length > 1) {
    const v0 = cellV.get(p[0][1] * N + p[0][0]);
    const v1 = cellV.get(p[p.length - 1][1] * N + p[p.length - 1][0]);
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

/* ---- world.js draws these surfaces, flat at the one level ------------- */
const draws = {
  'its water from water.js': 'Water.surfaces(first)',
  'its floor from water.js': 'cellH[i] = Water ? Water.cellHeight(c)',
  'every point at the one level': 'pos[k * 3 + 1] = WATER_Y;',
  'its water never culled': 'mesh.frustumCulled = false;',
  'its level from water.js': 'const WATER_Y = Water ? Water.Y',
};
for (const [what, src] of Object.entries(draws)) {
  if (!worldSrc.includes(src)) fail('world.js does not draw ' + what, src);
}
if (/InstancedMesh\(waterGeo|const yaw = dx \|\| dz/.test(worldSrc)) {
  fail('world.js still turns a sheet per cell of water');
}

const failures = [...kinds].map(([k, v]) =>
  k + (v.first ? ' (' + v.first + ')' : '') + (v.count > 1 ? ' x' + v.count : ''));
const report = {
  size: N, creeks: creeks.length,
  creekCells: [...kindOf].filter(k => k === 1).length,
  fords: [...kindOf].filter(k => k === 3).length,
  ponds, pondCells, waterCells, diagonalJoins: diagonals, seams,
  floorMaxOnCreeks: Number(floorMax.toFixed(3)),
  ok: failures.length === 0, failures,
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
