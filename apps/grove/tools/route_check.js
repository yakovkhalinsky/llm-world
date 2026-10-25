#!/usr/bin/env node
/* route_check — the grove's creatures walk round things, in Node.
 *
 * Reads a /api/state snapshot (a file, or stdin) and runs the page's own
 * routing (`page3d/forest.js` on the shared `walk.js`) for every creature
 * that is not a flyer, from where it rested last week to where it rests
 * now. Every route is sampled finely, and no sample may stand in water or
 * in a trunk's quarter — except inside the quarter the walk starts or ends
 * in, which is where the creature already is or meant to go. A straight
 * fallback is allowed (the router says why) but counted, and must be
 * rarer than the routes it stands in for.
 *
 *   node tools/route_check.js snapshot.json
 *   GROVE_FOREST=/path/to/mutant/forest.js node tools/route_check.js s.json
 *
 * The second form is how `tests/test_route_check.py` proves the check
 * fails a router that walks straight through things.
 *
 * Prints a JSON report and exits 1 on any failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const here = path.join(__dirname, '..', 'grove', 'page3d');
/* walk.js publishes itself on the global, as it does in the page */
require(path.join(__dirname, '..', '..', 'shared', 'page3d', 'walk.js'));
const Walk = globalThis.Page3DWalk;
const Forest = require(process.env.GROVE_FOREST ||
                       path.join(here, 'forest.js'));

const src = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8')
                            : fs.readFileSync(0, 'utf8');
const st = JSON.parse(src);
const N = st.size;
const SUB = Forest.SUB;

const t = Forest.trunks(st);
const grid = Walk.buildGrid(Forest.subGround(st), { solid: { trunk: 1 } });
Walk.setFixtures(grid, t.fixtures);
const flyers = new Set((st.biome && st.biome.flyers) || []);

const failures = [];
let routes = 0, fallbacks = 0, moved = 0, maxPoints = 0;

function blocked(sx, sy) {
  const i = sy * grid.W + sx;
  return !grid.base[i] || grid.solid[i];
}

/* the trunks themselves: never in water, at most four to a cell, and the
 * same quarters whichever order the plants are listed in */
const shuffled = Object.assign({}, st, { plants: st.plants.slice().reverse() });
const t2 = Forest.trunks(shuffled);
if (JSON.stringify(t2.at) !== JSON.stringify(t.at)) {
  failures.push('trunk quarters depend on the order the plants came in');
}
t.fixtures.forEach(f => {
  if (!grid.base[f.y * grid.W + f.x]) {
    failures.push('trunk ' + f.id + ' stands in water');
  }
});

/* where the page rests each creature, last week and this: its own
 * quarter alone, a share of the cell when it has company */
const restNow = Forest.restSpots(Walk, grid, st, t.taken, 'now');
const restWas = Forest.restSpots(Walk, grid, st, t.taken, 'prev');

(st.animals || []).forEach(a => {
  if (flyers.has(a.sp)) return;
  const from = restWas[a.id];
  const to = restNow[a.id];
  /* a resting spot is open ground unless the whole cell is water */
  const c = st.cells[a.y * N + a.x];
  if (c[0] !== 'w' &&
      blocked(Math.floor(to.x * SUB), Math.floor(to.z * SUB))) {
    failures.push('animal ' + a.id + ' rests in a trunk or the water');
  }
  if (a.px !== a.x || a.py !== a.y) moved++;
  const r = Forest.route(Walk, grid, from.x, from.z, to.x, to.z);
  routes++;
  if (r.fallback) { fallbacks++; return; }
  maxPoints = Math.max(maxPoints, r.route.n);
  const s0 = [Math.floor(from.x * SUB), Math.floor(from.z * SUB)];
  const s1 = [Math.floor(to.x * SUB), Math.floor(to.z * SUB)];
  const out = { x: 0, z: 0 };
  const steps = Math.max(4, Math.ceil(r.route.total * 40));
  for (let k = 0; k <= steps; k++) {
    Walk.sample(r.route, (k / steps) * r.route.total, out);
    const sx = Math.floor(out.x * SUB), sy = Math.floor(out.z * SUB);
    if ((sx === s0[0] && sy === s0[1]) || (sx === s1[0] && sy === s1[1])) {
      continue;
    }
    if (blocked(sx, sy)) {
      failures.push('animal ' + a.id + ' (' + a.sp + ') walks through ' +
        (grid.base[sy * grid.W + sx] ? 'a trunk' : 'water') + ' at ' +
        out.x.toFixed(2) + ',' + out.z.toFixed(2));
      return;
    }
  }
});

/* a synthetic walk that must go round: across a cell whose middle row of
 * quarters is all trunk but one, so the straight line is blocked */
(function detour() {
  const g = Walk.buildGrid({ width: 6, height: 6,
    rows: Array.from({ length: 6 }, () => [0, 0, 0, 0, 0, 0]),
    codes: ['soil'], walk: { soil: 1 } }, { solid: { trunk: 1 } });
  Walk.setFixtures(g, [0, 1, 2, 3, 4].map((x, i) =>
    ({ id: i, kind: 'trunk', x: x, y: 3 })));
  const r = Forest.route(Walk, g, 0.75, 0.25, 0.75, 2.75);
  if (r.fallback) { failures.push('the detour found no way round'); return; }
  const out = { x: 0, z: 0 };
  for (let k = 0; k <= 400; k++) {
    Walk.sample(r.route, (k / 400) * r.route.total, out);
    const sx = Math.floor(out.x * SUB), sy = Math.floor(out.z * SUB);
    if (sy === 3 && sx < 5) {
      failures.push('the detour went through a trunk');
      return;
    }
  }
  if (r.route.total < 3) failures.push('the detour did not go round');
})();

const report = {
  trunks: t.fixtures.length, routes, moved, fallbacks, maxPoints,
  failures: failures.slice(0, 20), failureCount: failures.length,
};
console.log(JSON.stringify(report));
const tooMany = routes > 0 && fallbacks * 4 > routes;
if (tooMany) console.error('too many straight fallbacks');
process.exit(failures.length || tooMany ? 1 : 0);
