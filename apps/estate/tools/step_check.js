/* Nobody walks through a step.
 *
 * A door's step and the shop's stall (the low plinth before its door) are
 * the only raised ground on the estate, and people walk onto both on their
 * way in and out. This runs the page's own lifting — crowd.js `steps` (the
 * rectangles world.js draws the steps from) and `lift` (how high a figure
 * at a point has its feet) on walk.js routes — and judges it with an
 * oracle of its own: every step's footprint worked out here from the
 * buildings' doors and the shop fixture, at the size world.js draws it,
 * never through `steps` or `lift`.
 *
 *   drawn     every step the oracle expects is one the page draws, at the
 *             same place and size, and none is more than one step high
 *             (MAX_STEP);
 *   scan      over every step and a margin round it, at 0.01 of a cell: a
 *             foot over a step (within FOOT_O of its edge) is never below
 *             its top, and the ground never rises faster than MAX_SLOPE —
 *             a ramp, not a jump;
 *   walking   every walk into each door and back out, from every cell
 *             within REACH that can reach it, to the door's middle and to
 *             a ring of places round it (where a crowd stands), at 60
 *             frames a second at walking pace: feet never below the step
 *             under them, and never rising more than MAX_RISE in a frame.
 *
 * It reports how many of those frames had feet inside a step before the
 * lift, so the gain is visible, not just asserted.
 *
 *   node tools/step_check.js ground.json state.json
 *
 * PAGE3D_WALK and PAGE3D_CROWD point it at another walk.js / crowd.js
 * (the tests use that to prove mutants of the page fail). Exits 1 on a
 * failure. */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HERE = path.join(__dirname, '..');
const WALK = process.env.PAGE3D_WALK ||
  path.join(HERE, '..', 'shared', 'page3d', 'walk.js');
const CROWD = process.env.PAGE3D_CROWD ||
  path.join(HERE, 'estate', 'page3d', 'crowd.js');

/* one step: a shade over the 0.07 the door steps used to be */
const MAX_STEP = 0.08;
/* a foot reaches this far from a body's middle (the body is 0.16) */
const FOOT_O = 0.08;
/* the ground underfoot rises no faster than this (height per cell) */
const MAX_SLOPE = 0.5;
/* walking pace (walk.js: 4 cells a second) at 60 frames a second */
const PACE = 4.0 / 60;
const MAX_RISE = 0.03;
const REACH = 5;
const TOL = 1e-9;

function load() {
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of [WALK, CROWD]) {
    vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
  }
  return { Walk: ctx.EstateWalk, Crowd: ctx.EstateCrowd };
}

/* ------------------------------------------------------------ the oracle */
/* world.js draws a door's step (doorW + 0.24) wide and 0.34 deep, its
 * middle 0.21 out from the wall, centred on the door — the door cell's
 * middle, kept 0.55 from the building's corners; a door is 0.8 wide on the
 * shop and 0.55 elsewhere. The shop's stall is a 0.9 square on its cell. */
function oracleSteps(ground, fixtures, h) {
  const out = [];
  for (const b of ground.buildings || []) {
    if (!b || !b.door) continue;
    const [dx, dy] = b.door;
    let axis, sign, at;
    if (dy < b.y) { axis = 'z'; sign = -1; at = b.y; }
    else if (dy >= b.y + b.h) { axis = 'z'; sign = 1; at = b.y + b.h; }
    else if (dx < b.x) { axis = 'x'; sign = -1; at = b.x; }
    else { axis = 'x'; sign = 1; at = b.x + b.w; }
    const wide = (b.kind === 'shop' ? 0.8 : 0.55) + 0.24;
    const lo = axis === 'z' ? b.x : b.y, len = axis === 'z' ? b.w : b.h;
    const mid = Math.min(Math.max((axis === 'z' ? dx : dy) + 0.5, lo + 0.55),
                         lo + len - 0.55);
    const near = at + sign * (0.21 - 0.17), far = at + sign * (0.21 + 0.17);
    const a0 = Math.min(near, far), a1 = Math.max(near, far);
    const r = axis === 'z'
      ? { x0: mid - wide / 2, x1: mid + wide / 2, z0: a0, z1: a1 }
      : { x0: a0, x1: a1, z0: mid - wide / 2, z1: mid + wide / 2 };
    r.h = h; r.what = 'door of ' + b.kind + ' ' + b.id;
    r.door = [dx, dy];
    out.push(r);
  }
  for (const f of fixtures || []) {
    if (f.kind !== 'shop') continue;
    out.push({ x0: f.x + 0.05, x1: f.x + 0.95, z0: f.y + 0.05, z1: f.y + 0.95,
               h, what: 'shop stall ' + f.id, door: [f.x, f.y] });
  }
  return out;
}
const distTo = (r, x, z) => Math.hypot(Math.max(r.x0 - x, 0, x - r.x1),
                                       Math.max(r.z0 - z, 0, z - r.z1));
/* the top of whatever a foot at (x, z) is over: 0 on the bare ground */
function surface(rects, x, z) {
  let top = 0, what = null;
  for (const r of rects) {
    if (distTo(r, x, z) <= FOOT_O && r.h > top) { top = r.h; what = r.what; }
  }
  return { top, what };
}

/* ------------------------------------------------------------- the check */
function check(ground, state) {
  const { Walk, Crowd } = load();
  const fails = [];
  const fixtures = state.fixtures || [];
  const page = Crowd.steps(ground, fixtures);
  const h = Crowd.STEP_H;   /* world.js draws every step STEP_H high */
  const rects = oracleSteps(ground, fixtures, h);

  /* drawn */
  if (!(h > 0 && h <= MAX_STEP)) {
    fails.push(`drawn: a step ${h} high (one step is at most ${MAX_STEP})`);
  }
  for (const r of rects) {
    const same = page.find(p => ['x0', 'x1', 'z0', 'z1'].every(
      k => Math.abs(p[k] - r[k]) < 1e-6) && Math.abs(p.h - r.h) < 1e-9);
    if (!same) fails.push(`drawn: the ${r.what} is not where the page has it`);
  }
  if (page.length !== rects.length) {
    fails.push(`drawn: the page has ${page.length} steps, the oracle ${rects.length}`);
  }

  /* scan */
  let scanned = 0, slope = 0, slopeAt = null;
  const scanWorst = {};   /* the deepest foot, step by step */
  const D = 0.01, M = FOOT_O + 0.4;
  for (const r of rects) {
    for (let x = r.x0 - M; x <= r.x1 + M + 1e-9; x += D) {
      let prev = null;
      for (let z = r.z0 - M; z <= r.z1 + M + 1e-9; z += D) {
        const y = Crowd.lift(page, x, z);
        const s = surface(rects, x, z);
        const under = s.top - y;
        if (under > TOL && !(scanWorst[s.what] && scanWorst[s.what].d >= under)) {
          scanWorst[s.what] = { d: under, what: s.what, at: [x, z] };
        }
        if (prev !== null && Math.abs(y - prev) / D > slope) {
          slope = Math.abs(y - prev) / D; slopeAt = [x, z];
        }
        const yx = Crowd.lift(page, x + D, z);
        if (Math.abs(yx - y) / D > slope) { slope = Math.abs(yx - y) / D; slopeAt = [x, z]; }
        prev = y;
        scanned++;
      }
    }
  }
  const at = p => p.map(v => v.toFixed(2)).join(',');
  for (const w of Object.values(scanWorst)) {
    fails.push(`scan: a foot ${w.d.toFixed(3)} below the top of the ` +
               `${w.what} at ${at(w.at)}`);
  }
  if (slope > MAX_SLOPE) {
    fails.push(`scan: the ground rises ${slope.toFixed(2)} a cell at ` +
               `${at(slopeAt)} (a jump, not a ramp; at most ${MAX_SLOPE})`);
  }

  /* walking */
  const grid = Walk.buildGrid(ground);
  Walk.setFixtures(grid, fixtures);
  let frames = 0, walks = 0, sunkBefore = 0, rise = 0, riseAt = null;
  let walkWorst = { d: 0 };
  const doors = {};
  rects.forEach(r => { doors[r.door.join(',')] = r.door; });
  const ring = [[0, 0]];
  for (const rad of [0.4, 0.62]) {
    for (let a = 0; a < 8; a++) {
      ring.push([rad * Math.cos(a * Math.PI / 4), rad * Math.sin(a * Math.PI / 4)]);
    }
  }
  const S = { x: 0, z: 0, dx: 0, dz: 0, moving: false };
  const walkOne = (route) => {
    walks++;
    let last = null;
    for (let t = 0; t <= route.total + PACE; t += PACE) {
      Walk.sample(route, Math.min(t, route.total), S);
      const y = Crowd.lift(page, S.x, S.z);
      const s = surface(rects, S.x, S.z);
      if (s.top > TOL) sunkBefore++;
      if (s.top - y > walkWorst.d) {
        walkWorst = { d: s.top - y, what: s.what, at: [S.x, S.z] };
      }
      if (last !== null && y - last > rise) { rise = y - last; riseAt = [S.x, S.z]; }
      last = y;
      frames++;
    }
  };
  for (const key of Object.keys(doors)) {
    const [gx, gy] = doors[key];
    for (let y = gy - REACH; y <= gy + REACH; y++) {
      for (let x = gx - REACH; x <= gx + REACH; x++) {
        if (x === gx && y === gy) continue;
        if (Math.abs(x - gx) + Math.abs(y - gy) > REACH) continue;
        const cells = Walk.findPath(grid, x, y, gx, gy);
        if (!cells) continue;
        for (const [ox, oz] of ring) {
          const tx = gx + 0.5 + ox, tz = gy + 0.5 + oz;
          walkOne(Walk.routePoints(cells, x + 0.5, y + 0.5, tx, tz));
          walkOne(Walk.routePoints(cells.slice().reverse(), tx, tz,
                                   x + 0.5, y + 0.5));
        }
      }
    }
  }
  if (walkWorst.d > TOL) {
    fails.push(`walking: feet ${walkWorst.d.toFixed(3)} below the top of the ` +
               `${walkWorst.what} at ${at(walkWorst.at)}`);
  }
  if (rise > MAX_RISE) {
    fails.push(`walking: feet rise ${rise.toFixed(3)} in one frame at ` +
               `${at(riseAt)} (at most ${MAX_RISE})`);
  }
  if (!walks) fails.push('walking: no walk reached a door');

  return { steps: rects.length, height: h, scanned, slope, walks, frames,
           sunkBefore, rise, fails };
}

if (typeof module !== 'undefined') module.exports = { check };

if (require.main === module) {
  const ground = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const state = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const r = check(ground, state);
  console.log(`steps: ${r.steps} drawn, ${r.height} high`);
  console.log(`scan: ${r.scanned} points, steepest ${r.slope.toFixed(2)} a cell`);
  console.log(`walking: ${r.walks} walks in and out, ${r.frames} frames; ` +
              `${r.sunkBefore} frames over a step (feet in it without the ` +
              `lift), highest rise ${r.rise.toFixed(3)} a frame`);
  if (r.fails.length) {
    r.fails.forEach(f => console.log('FAIL ' + f));
    process.exit(1);
  }
  console.log('step check ok');
}
