/* A crowded grove, built from a real one.
 *
 * Creatures share cells all the time, but the crowd check and the
 * screenshots want the worst case on purpose. This takes a real snapshot
 * and moves animals (nothing else): six ground creatures of mixed sizes
 * into one open cell, four more into a cell with a standing trunk, the
 * flyers into one cell, four
 * walking together from one cell to the same cell, and two pairs walking
 * head-on along one row. Everyone else stays where they were but stops
 * moving. Pure and deterministic.
 *
 *   node tools/crowd_scene.js state.json > crowded.json
 */

'use strict';

function scene(Forest, st0) {
  const st = JSON.parse(JSON.stringify(st0));
  const N = Number(st.size) | 0;
  const t = Forest.trunks(st);
  const flyers = new Set((st.biome && st.biome.flyers) || []);
  const soil = (x, y) => x >= 0 && y >= 0 && x < N && y < N &&
    st.cells[y * N + x][0] !== 'w';
  const trunkCells = {};
  t.fixtures.forEach(f => {
    trunkCells[Math.floor(f.x / Forest.SUB) + ',' + Math.floor(f.y / Forest.SUB)] = 1;
  });
  const freeQuarters = (x, y) => [0, 1, 2, 3]
    .filter(q => !t.taken[x + ',' + y + ',' + q]).length;
  /* the crowd's cell: soil, its four neighbours soil, with the fewest
   * trees between it and the camera a page's `focus` puts at its
   * south-east, so the screenshots can see it; then nearest the middle.
   * A second crowd stands in a cell with a trunk in it, the cell nearest
   * the middle with a trunk and three free quarters, so the spacing is
   * checked against a trunk as well as in the open. */
  const mid = (N - 1) / 2;
  const treeCount = {};          // every tree, a sapling as much as a trunk
  (st.plants || []).forEach(p => {
    if (Forest.kindOf(st, p.sp) !== 'tree') return;
    const k = p.x + ',' + p.y;
    treeCount[k] = (treeCount[k] || 0) + 1;
  });
  const front = (x, y) => {
    let n = 0;
    for (let dy = 0; dy <= 4; dy++) {
      for (let dx = 0; dx <= 4; dx++) {
        if (dx || dy) n += treeCount[(x + dx) + ',' + (y + dy)] || 0;
      }
    }
    return n;
  };
  const roomy = (x, y) => soil(x, y) &&
    [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => soil(x + dx, y + dy));
  let best = null, trunkCell = null;
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      if (!roomy(x, y)) continue;
      const centre = Math.abs(x - mid) + Math.abs(y - mid);
      const d = front(x, y) * 100 + centre;
      if (!best || d < best.d) best = { x, y, d };
      if (trunkCells[x + ',' + y] && freeQuarters(x, y) >= 3 &&
          (!trunkCell || centre < trunkCell.d)) trunkCell = { x, y, d: centre };
    }
  }
  if (!best) best = { x: Math.round(mid), y: Math.round(mid) };
  /* a soil row of at least 6 cells for the head-on pairs, and a soil
   * stretch for the group, away from the crowd */
  function row(skipY) {
    for (let y = 1; y < N - 1; y++) {
      if (Math.abs(y - skipY) < 3) continue;
      for (let x = 0; x + 6 < N; x++) {
        let ok = true;
        for (let k = 0; k <= 6; k++) if (!soil(x + k, y)) { ok = false; break; }
        if (ok) return { x, y };
      }
    }
    return null;
  }
  const r1 = row(best.y);
  const r2 = r1 ? row(r1.y) : null;

  const animals = (st.animals || []).slice().sort((a, b) => a.id - b.id);
  animals.forEach(a => { a.px = a.x; a.py = a.y; });
  const ground = animals.filter(a => !flyers.has(a.sp));
  const fly = animals.filter(a => flyers.has(a.sp));
  /* mixed sizes: the biggest species first, then the smallest */
  const bySp = {};
  ground.forEach(a => { (bySp[a.sp] = bySp[a.sp] || []).push(a); });
  const order = ['deer', 'boar', 'rabbit', 'fox', 'tortoise', 'owl']
    .concat(Object.keys(bySp).sort());
  const pool = [];
  const seen = new Set();
  for (let round = 0; round < 8; round++) {
    for (const sp of order) {
      if (seen.has(sp + round)) continue;
      seen.add(sp + round);
      const a = bySp[sp] && bySp[sp][round];
      if (a && pool.indexOf(a) < 0) pool.push(a);
    }
  }
  let k = 0;
  const take = n => pool.slice(k, (k += n));
  const tiles = { crowd: [best.x, best.y] };
  take(6).forEach(a => { a.x = a.px = best.x; a.y = a.py = best.y; });
  if (trunkCell && (trunkCell.x !== best.x || trunkCell.y !== best.y)) {
    take(4).forEach(a => { a.x = a.px = trunkCell.x; a.y = a.py = trunkCell.y; });
    tiles.trunk = [trunkCell.x, trunkCell.y];
  }
  if (r1) {
    take(4).forEach(a => { a.px = r1.x; a.py = r1.y; a.x = r1.x + 6; a.y = r1.y; });
    tiles.group = [r1.x, r1.y, r1.x + 6, r1.y];
  }
  if (r2) {
    take(2).forEach(a => { a.px = r2.x; a.py = r2.y; a.x = r2.x + 6; a.y = r2.y; });
    take(2).forEach(a => { a.px = r2.x + 6; a.py = r2.y; a.x = r2.x; a.y = r2.y; });
    tiles.headOn = [r2.x, r2.y, r2.x + 6, r2.y];
  }
  const fc = [best.x + 1, best.y];
  fly.slice(0, 3).forEach(a => { a.x = a.px = fc[0]; a.y = a.py = fc[1]; });
  tiles.flyers = fc;
  st.animals = animals;
  return { state: st, tiles: tiles };
}

if (typeof module !== 'undefined') module.exports = { scene };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const Forest = require(process.env.GROVE_FOREST ||
    path.join(__dirname, '..', 'grove', 'page3d', 'forest.js'));
  const st = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const out = scene(Forest, st);
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(out.tiles));
  process.stdout.write(JSON.stringify(out.state));
}
