/* Two creatures never stand inside each other, or in a trunk or the water.
 *
 * Runs the page's own resting and spacing — forest.js (restSpots, figure,
 * stagger, and `space`, the per-frame push world.js calls) on walk.js —
 * on a crowded grove built from a real snapshot (crowd_scene.js), and on
 * made-up glades, and judges the picture with an oracle of its own that
 * shares no code with what it checks: the water read straight
 * from the snapshot's cells, and every standing trunk a disk of the
 * largest radius world.js draws (0.126 of a cell at its foot) where the
 * page draws it. A body is a disk of its own radius, at most 0.2 (the
 * feet; a big creature's head may overhang the bank).
 *
 *   resting   every creature where the week leaves it, after the page's
 *             spacing: no two bodies on one layer (the ground, or the air)
 *             nearer than the sum of their radii, no ground body in the
 *             water or in a trunk (a creature in a cell that is
 *             all water stays in that cell), and every flyer over the map.
 *   walking   the week's walks played out at 60 frames a second (2400
 *             frames at most, for a long week) along the page's own
 *             routes, glide and file (Forest.stagger), through
 *             Forest.space: no two nearer than MIN_WALK of their combined
 *             radii at any frame, and no push that takes a body further
 *             into the water or a trunk than its walk had it.
 *   scenes    a creature beside a trunk, one in a trunk's quarter (where
 *             a walk may end), and one on a bank, brushed by a
 *             walker from every side; two meeting head-on a little to the
 *             wrong side (each must pass on its own right).
 *
 * It reports the closest pair before spacing (each creature on its own
 * quarter, as the page used to draw it) and after.
 *
 *   node tools/crowd_check.js state.json
 *
 * PAGE3D_WALK and GROVE_FOREST point it at another walk.js / forest.js;
 * the tests use that to prove mutants of the page fail. Exits 1 on a
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
/* how far a body may sink into the water or a trunk beyond where its walk
 * had it: rounding */
const TOL_IN = 2e-3;
const MIN_WALK = 0.8;
const TRUNK_R = 0.126;
const FOOT = 0.2;

/* ------------------------------------------------------------ the oracle */
/* `cells` the snapshot's own, N a side; `trunks` [{x, z}] in cells */
function oracle(N, cells, trunks) {
  const blocked = (x, y) => {
    if (x < 0 || y < 0 || x >= N || y >= N) return true;
    const c = cells[y * N + x];
    return !!c && c[0] === 'w';
  };
  const byCell = {};
  trunks.forEach(t => {
    const k = Math.floor(t.x) + ',' + Math.floor(t.z);
    (byCell[k] = byCell[k] || []).push(t);
  });
  const intoBox = (x, z, r, x0, z0, x1, z1) => {
    const dx = Math.max(x0 - x, 0, x - x1), dz = Math.max(z0 - z, 0, z - z1);
    if (dx === 0 && dz === 0) return r + Math.min(x - x0, x1 - x, z - z0, z1 - z);
    return r - Math.hypot(dx, dz);
  };
  /* deepest a foot of radius r at (x, z) is in a blocked cell other than
   * (hx, hy), and in a trunk */
  function pen(x, z, r, hx, hy) {
    let wall = -Infinity, into = -Infinity, what = null;
    const cx = Math.floor(x), cz = Math.floor(z);
    for (let y = cz - 1; y <= cz + 1; y++) {
      for (let xx = cx - 1; xx <= cx + 1; xx++) {
        if (!(xx === hx && y === hy) && blocked(xx, y)) {
          wall = Math.max(wall, intoBox(x, z, r, xx, y, xx + 1, y + 1));
        }
        for (const t of byCell[xx + ',' + y] || []) {
          const d = r + TRUNK_R - Math.hypot(x - t.x, z - t.z);
          if (d > into) { into = d; what = 'trunk@' + t.x.toFixed(2) + ',' + t.z.toFixed(2); }
        }
      }
    }
    return { wall, into, what };
  }
  return { pen, blocked };
}
const freshWorst = () => ({ wall: { d: -Infinity }, into: { d: -Infinity }, air: 0 });
function judgeFrame(orc, N, F, n, worst) {
  for (let k = 0; k < n; k++) {
    if (F.layer[k] === 1) {
      if (F.x[k] < -TOL || F.z[k] < -TOL || F.x[k] > N + TOL || F.z[k] > N + TOL) worst.air++;
      continue;
    }
    if (F.layer[k] !== 0) continue;
    const r = Math.min(F.r[k], FOOT);
    const hx = Math.floor(F.rx[k]), hy = Math.floor(F.rz[k]);
    const raw = orc.pen(F.rx[k], F.rz[k], r, hx, hy);
    const got = orc.pen(F.x[k], F.z[k], r, hx, hy);
    const dw = got.wall - Math.max(raw.wall, 0);
    const df = got.into - Math.max(raw.into, 0);
    if (dw > worst.wall.d) worst.wall = { d: dw, id: F.id[k], at: [F.x[k], F.z[k]] };
    if (df > worst.into.d) worst.into = { d: df, id: F.id[k], what: got.what, at: [F.x[k], F.z[k]] };
  }
}
function worstFails(tag, worst, fails) {
  const at = w => w.at.map(v => v.toFixed(3)).join(',');
  if (worst.into.d > TOL_IN) {
    fails.push(`${tag}: ${worst.into.id} pushed ${worst.into.d.toFixed(3)} ` +
               `into the ${worst.into.what} at ${at(worst.into)}`);
  }
  if (worst.wall.d > TOL_IN) {
    fails.push(`${tag}: ${worst.wall.id} pushed ${worst.wall.d.toFixed(3)} ` +
               `into the water at ${at(worst.wall)}`);
  }
  if (worst.air) fails.push(`${tag}: ${worst.air} flyers drawn off the map`);
}

/* ---------------------------------------------------------------- scenes */
/* a made-up glade: s soil, w water, r rock, one row a string; `trunks`
 * quarters [cx, cy, q] */
function scenes(Walk, Forest, fails) {
  const SUB = Forest.SUB, ran = [];
  const setup = (lines, quarters) => {
    const N = lines.length;
    const st = { size: N, cells: [].concat(...lines.map(l => [...l])) };
    const grid = Walk.buildGrid(Forest.subGround(st), { solid: { trunk: 1 } });
    const fixtures = [], trunks = [];
    quarters.forEach(([cx, cy, q], i) => {
      fixtures.push({ id: i + 1, kind: 'trunk', x: cx * SUB + (q & 1), y: cy * SUB + (q >> 1) });
      trunks.push({ x: cx + ((q & 1) + 0.5) / SUB, z: cy + ((q >> 1) + 0.5) / SUB });
    });
    Walk.setFixtures(grid, fixtures);
    return { N, grid, orc: oracle(N, st.cells, trunks), trunks };
  };
  const fig = (F, k, x, z, r, w, hx, hz, id, layer) => {
    F.rx[k] = x; F.rz[k] = z; F.r[k] = r; F.w[k] = w;
    F.hx[k] = hx; F.hz[k] = hz; F.layer[k] = layer || 0; F.id[k] = id;
  };
  /* a resting creature at (sx, sz), brushed from every side */
  const brush = (tag, S, sx, sz) => {
    const F = Walk.figures(null, 2), worst = freshWorst();
    let cases = 0;
    for (let a = 0; a < 360; a += 3) {
      for (let off = 0.1; off <= 0.4001; off += 0.025) {
        const hx = Math.cos(a * Math.PI / 180), hz = Math.sin(a * Math.PI / 180);
        const wx = sx - hz * off, wz = sz + hx * off;
        const p = S.orc.pen(wx, wz, 0.15, Math.floor(wx), Math.floor(wz));
        if (p.wall > 0 || p.into > 0) continue;   // a walk is never there
        fig(F, 0, sx, sz, 0.15, 0.5, 0, 0, 1);
        fig(F, 1, wx, wz, 0.15, 1, hx, hz, 2);
        Forest.space(Walk, S.grid, F, 2, S.N);
        judgeFrame(S.orc, S.N, F, 2, worst);
        cases++;
      }
    }
    worstFails(tag, worst, fails);
    ran.push(`${tag} ${cases}`);
  };
  {
    /* beside a trunk: the push must never take it nearer the trunk */
    const S = setup(['sss', 'sss', 'sss'], [[1, 1, 0]]);
    const t = S.trunks[0];
    brush('trunk', S, t.x + TRUNK_R + 0.15 + 0.02, t.z + 0.05);
    /* and one standing in the trunk's own quarter, nearer than it should */
    brush('in-trunk', S, t.x + 0.2, t.z - 0.03);
  }
  {
    /* on a bank: water to the west */
    const S = setup(['wsss', 'wsss', 'wsss', 'wsss'], []);
    brush('bank', S, 1 + 0.15 + 0.01, 2.0);
  }
  {
    const S = setup(Array(7).fill('sssssss'), []);
    const F = Walk.figures(null, 2), worst = freshWorst();
    let passed = null, prev = null, gap = Infinity, frames = 0;
    for (let tt = 0; tt <= 1.0001; tt += 0.01) {
      fig(F, 0, 0.5 + 6 * tt, 3.475, 0.15, 1, 1, 0, 1);
      fig(F, 1, 6.5 - 6 * tt, 3.525, 0.15, 1, -1, 0, 2);
      Forest.space(Walk, S.grid, F, 2, S.N);
      judgeFrame(S.orc, S.N, F, 2, worst);
      frames++;
      gap = Math.min(gap, Math.hypot(F.x[0] - F.x[1], F.z[0] - F.z[1]) / 0.3);
      const along = F.x[1] - F.x[0];
      if (prev !== null && prev > 0 && along <= 0 && passed === null) {
        passed = F.z[0] > F.z[1];   // a heads +x, its right is +z
      }
      prev = along;
    }
    if (passed !== true) fails.push('head-on: the walkers did not pass on their own right');
    if (gap < MIN_WALK) fails.push(`head-on: ${(gap * 100).toFixed(0)}% of a body apart`);
    worstFails('head-on', worst, fails);
    ran.push(`head-on ${frames}`);
  }
  {
    /* a flyer hovering just past the map's edge, another beside it */
    const S = setup(['sss', 'sss', 'sss'], []);
    const F = Walk.figures(null, 2), worst = freshWorst();
    fig(F, 0, -0.1, 1.5, 0.15, 0.5, 0, 0, 1, 1);
    fig(F, 1, 0.05, 1.5, 0.15, 0.5, 0, 0, 2, 1);
    Forest.space(Walk, S.grid, F, 2, S.N);
    judgeFrame(S.orc, S.N, F, 2, worst);
    worstFails('edge', worst, fails);
    ran.push('edge 2');
  }
  return ran;
}

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
  const orc = oracle(N, st.cells, Object.keys(t.at).map(id => t.at[id]));
  const waterAt = (x, z) => {
    const c = st.cells[Math.floor(z) * N + Math.floor(x)];
    return c && c[0] === 'w';
  };

  const F = Walk.figures(null, n);
  /* the page's spacing (world.js updateBeasts), raw points in F.rx/F.rz */
  const space = () => Forest.space(Walk, grid, F, n, N);
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
    const where = `${F.x[k].toFixed(2)},${F.z[k].toFixed(2)}`;
    if (F.layer[k] === 1) {
      if (F.x[k] < 0 || F.z[k] < 0 || F.x[k] > N || F.z[k] > N) {
        fails.push(`resting: ${animals[k].sp} ${animals[k].id} flies off the map at ${where}`);
      }
      continue;
    }
    /* a creature in a cell that is all water may stay in that cell */
    const own = waterAt(F.rx[k], F.rz[k]);
    const p = orc.pen(F.x[k], F.z[k], Math.min(F.r[k], FOOT),
                      own ? Math.floor(F.rx[k]) : -9, own ? Math.floor(F.rz[k]) : -9);
    if (p.wall > TOL_IN || p.into > TOL_IN) {
      fails.push(`resting: ${animals[k].sp} ${animals[k].id} stands ` +
                 (p.into > TOL_IN ? `${p.into.toFixed(3)} into the ${p.what}`
                                  : `${p.wall.toFixed(3)} in the water`) +
                 ` at ${where}`);
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
  let frames = 0;
  const pushed = freshWorst();
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
    judgeFrame(orc, N, F, n, pushed);
    const after = closest(F.x, F.z);
    if (after.g < walkAfter.g) { walkAfter = after; worstMs = Math.round(ms); }
  }
  if (walkAfter.g < MIN_WALK) {
    fails.push(`walking: ${walkAfter.pair} at ` +
               `${(walkAfter.g * 100).toFixed(0)}% of a body apart at ` +
               `${walkAfter.at}, ${worstMs} ms in`);
  }
  worstFails('walking', pushed, fails);
  const ran = scenes(Walk, Forest, fails);
  return { tiles: built.tiles, animals: n, scenes: ran,
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
  console.log(`scenes: ${r.scenes.join('; ')}`);
  if (r.fails.length) {
    r.fails.forEach(f => console.log('FAIL ' + f));
    process.exit(1);
  }
  console.log('crowd check ok');
}
