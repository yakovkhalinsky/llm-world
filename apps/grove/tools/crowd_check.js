/* Two creatures never stand inside each other.
 *
 * Runs the page's own spacing — walk.js (pack, separate, clearAt) and
 * forest.js (restSpots, figure) — on a crowded grove built from a real
 * snapshot (crowd_scene.js), and checks the picture:
 *
 *   resting   every creature where the week leaves it, as the page draws
 *             it: no two bodies on one layer (the ground, or the air)
 *             nearer than the sum of their radii, and every ground body on
 *             open ground — out of the water and the trunks' quarters.
 *   walking   the week's walks played out at 60 frames a second (2400
 *             frames at most, for a long week) along the page's own
 *             routes, glide and file (Forest.stagger), through
 *             Walk.separate: no two nearer than MIN_WALK of their
 *             combined radii at any frame, and no push that moves a body
 *             off open ground.
 *
 * It reports the closest pair before spacing (each creature on its own
 * quarter, as the page used to draw it) and after.
 *
 *   node tools/crowd_check.js state.json
 *
 * PAGE3D_WALK and GROVE_FOREST point it at another walk.js / forest.js;
 * the tests use that to prove a page without spacing fails. Exits 1 on a
 * failure. */

'use strict';

const fs = require('fs');
const path = require('path');
const { scene } = require('./crowd_scene');

const WALK = process.env.PAGE3D_WALK ||
  path.join(__dirname, '..', '..', 'shared', 'page3d', 'walk.js');
const FOREST = process.env.GROVE_FOREST ||
  path.join(__dirname, '..', 'grove', 'page3d', 'forest.js');

const TOL = 1e-6;
const MIN_WALK = 0.8;

function load() {
  delete require.cache[require.resolve(WALK)];
  require(WALK);
  return { Walk: globalThis.Page3DWalk, Forest: require(FOREST) };
}

function check(st0) {
  const { Walk, Forest } = load();
  const SUB = Forest.SUB;
  const built = scene(Forest, st0);
  const st = built.state;
  const N = st.size;
  const t = Forest.trunks(st);
  const grid = Walk.buildGrid(Forest.subGround(st), { solid: { trunk: 1 } });
  Walk.setFixtures(grid, t.fixtures);
  const fly = new Set((st.biome && st.biome.flyers) || []);
  const animals = (st.animals || []).filter(a =>
    a.x >= 0 && a.y >= 0 && a.x < N && a.y < N);
  const n = animals.length;
  const fig = animals.map(a => Forest.figure(st, a.sp));
  const fails = [];
  const waterAt = (x, z) => {
    const c = st.cells[Math.floor(z) * N + Math.floor(x)];
    return c && c[0] === 'w';
  };

  const F = Walk.figures(null, n);
  const m = new Array(n);
  /* the page's spacing, given raw points already in F.rx/F.rz */
  function space() {
    for (let k = 0; k < n; k++) {
      const home = Math.floor(F.rz[k] * SUB) * grid.W + Math.floor(F.rx[k] * SUB);
      const mk = Math.min(F.r[k], 0.2) * SUB;
      m[k] = F.layer[k] === 0 &&
        Walk.clearAt(grid, F.rx[k] * SUB, F.rz[k] * SUB, mk, home) ? mk : 0;
    }
    Walk.separate(F, n, {
      iters: 8, pad: 0.04, maxOff: 0.5,
      ok: (k, x, z) => F.layer[k] === 1 ||
        Walk.clearAt(grid, x * SUB, z * SUB, m[k],
          Math.floor(F.rz[k] * SUB) * grid.W + Math.floor(F.rx[k] * SUB)),
    });
  }
  function closest(xs, zs) {
    let best = Infinity, pair = null, at = null;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        if (F.layer[a] !== F.layer[b]) continue;
        const g = Math.hypot(xs[a] - xs[b], zs[a] - zs[b]) / (F.r[a] + F.r[b]);
        if (g < best) {
          best = g; pair = [animals[a].id, animals[b].id];
          at = ((xs[a] + xs[b]) / 2).toFixed(2) + ',' +
               ((zs[a] + zs[b]) / 2).toFixed(2);
        }
      }
    }
    return { g: best, pair, at };
  }
  function setFig(k, x, z, moving, dx, dz) {
    F.rx[k] = x; F.rz[k] = z; F.r[k] = fig[k].r;
    F.w[k] = moving ? 1 : 0.5;
    F.hx[k] = moving ? dx : 0; F.hz[k] = moving ? dz : 0;
    F.layer[k] = fly.has(animals[k].sp) ? 1 : 0;
    F.id[k] = animals[k].id;
  }

  /* ----------------------------------------------------------- resting */
  const now = Forest.restSpots(Walk, grid, st, t.taken, 'now');
  const was = Forest.restSpots(Walk, grid, st, t.taken, 'prev');
  const oldXs = [], oldZs = [];
  animals.forEach((a, k) => {
    const old = Forest.restSpot(a.id, a.x, a.y, st, t.taken);
    oldXs[k] = old.x; oldZs[k] = old.z;
    setFig(k, now[a.id].x, now[a.id].z, false, 0, 0);
  });
  const restBefore = closest(oldXs, oldZs);
  space();
  const restAfter = closest(F.x, F.z);
  for (let k = 0; k < n; k++) {
    if (F.layer[k] !== 0 || waterAt(F.rx[k], F.rz[k])) continue;
    const mk = Math.min(F.r[k], 0.2) * SUB;
    if (!Walk.clearAt(grid, F.x[k] * SUB, F.z[k] * SUB, mk, -1)) {
      fails.push(`resting: ${animals[k].sp} ${animals[k].id} stands in ` +
                 `water or a trunk at ${F.x[k].toFixed(2)},${F.z[k].toFixed(2)}`);
    }
  }
  /* a share of one quarter's room on each side is rounding, not a body
   * inside another */
  if (restAfter.g < 1 - TOL) {
    fails.push(`resting: ${restAfter.pair} at ` +
               `${(restAfter.g * 100).toFixed(0)}% of a body apart at ${restAfter.at}`);
  }

  /* ----------------------------------------------------------- walking */
  const glide = Math.max(0.5, (Number(st.tick_seconds) || 12) * 0.45) * 1000;
  const routes = animals.map((a, k) => {
    const f = was[a.id] || now[a.id], to = now[a.id];
    if (Math.abs(f.x - to.x) < 1e-6 && Math.abs(f.z - to.z) < 1e-6) return null;
    if (fly.has(a.sp)) return Walk.straight(f.x, f.z, to.x, to.z);
    const r = Forest.route(Walk, grid, f.x, f.z, to.x, to.z);
    if (r.fallback) fails.push(`walking: ${a.sp} ${a.id} found no path`);
    return r.route;
  });
  const file = Forest.stagger(st, was);
  const s = { x: 0, z: 0, dx: 0, dz: 0, moving: false };
  let walkBefore = { g: Infinity }, walkAfter = { g: Infinity }, worstMs = 0;
  let frames = 0, offGround = 0;
  /* 60 frames a second; a long week (an hour's tick) is sampled at 2400
   * frames instead — a body moves a few hundredths of a cell between them */
  const step = Math.max(1000 / 60, glide / 2400);
  for (let ms = 0; ms <= glide + 50; ms += step) {
    frames++;
    const tt = ms / 1000;
    animals.forEach((a, k) => {
      const r = routes[k];
      let x = now[a.id].x, z = now[a.id].z, moving = false;
      if (r) {
        const fl = file[a.id];
        const t0 = fl ? fl.lag * glide : 0, dur = fl ? fl.span * glide : glide;
        const f = Math.max(0, Math.min(1, (ms - t0) / dur));
        const e = f * f * (3 - 2 * f);
        Walk.sample(r, e * r.total, s);
        x = s.x; z = s.z;
        moving = f > 0 && f < 1 && Math.abs(s.dx) + Math.abs(s.dz) > 1e-6;
      }
      if (fly.has(a.sp) && !moving) {
        /* the page's hover loop */
        const ph = Forest.hash(a.id, 31) / 4294967295 * 6.28;
        x += Math.cos(tt * 0.6 + ph) * 0.3;
        z += Math.sin(tt * 0.6 + ph) * 0.3;
      }
      setFig(k, x, z, moving, s.dx, s.dz);
    });
    const before = closest(F.rx, F.rz);
    if (before.g < walkBefore.g) walkBefore = before;
    space();
    for (let k = 0; k < n; k++) {
      if (F.layer[k] !== 0) continue;
      const home = Math.floor(F.rz[k] * SUB) * grid.W + Math.floor(F.rx[k] * SUB);
      if (!Walk.clearAt(grid, F.x[k] * SUB, F.z[k] * SUB, m[k], home)) offGround++;
    }
    const after = closest(F.x, F.z);
    if (after.g < walkAfter.g) { walkAfter = after; worstMs = Math.round(ms); }
  }
  if (walkAfter.g < MIN_WALK) {
    fails.push(`walking: ${walkAfter.pair} at ` +
               `${(walkAfter.g * 100).toFixed(0)}% of a body apart at ` +
               `${walkAfter.at}, ${worstMs} ms in`);
  }
  if (offGround) fails.push(`walking: ${offGround} pushes off open ground`);
  return { tiles: built.tiles, animals: n,
           resting: { before: restBefore.g, after: restAfter.g },
           walking: { frames, before: walkBefore.g, after: walkAfter.g },
           fails };
}

if (typeof module !== 'undefined') module.exports = { check };

if (require.main === module) {
  const st = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const r = check(st);
  const pc = v => (v * 100).toFixed(0) + '%';
  console.log(`crowd: ${r.animals} creatures, tiles ${JSON.stringify(r.tiles)}`);
  console.log(`resting: closest pair ${pc(r.resting.before)} -> ` +
              `${pc(r.resting.after)} of a body apart`);
  console.log(`walking: ${r.walking.frames} frames, closest pair ` +
              `${pc(r.walking.before)} -> ${pc(r.walking.after)} of a body apart`);
  if (r.fails.length) {
    r.fails.forEach(f => console.log('FAIL ' + f));
    process.exit(1);
  }
  console.log('crowd check ok');
}
