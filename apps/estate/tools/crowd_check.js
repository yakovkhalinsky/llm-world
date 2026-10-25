/* Two residents never stand inside each other.
 *
 * Runs the page's own spacing — walk.js (pack, separate, clearAt) and
 * crowd.js (who stands where on a tile, and the walk there) — on a crowded
 * day built from a real one (crowd_scene.js), and checks the picture:
 *
 *   snapshot  everyone where the day leaves them: no two bodies nearer
 *             than the sum of their radii; one figure per seat and no
 *             more seated than the bench holds; nobody standing in a
 *             table, a stall, a wall or the water.
 *   walking   the day's walks played out at 60 frames a second, through
 *             Walk.separate as the page draws them: no two figures nearer
 *             than MIN_WALK of their combined radii at any frame, and no
 *             push ever moves a body off open ground.
 *
 * It reports the closest pair before spacing and after, so the gain is
 * visible, not just asserted.
 *
 *   node tools/crowd_check.js ground.json state.json
 *
 * PAGE3D_WALK and PAGE3D_CROWD point it at another walk.js / crowd.js
 * (the tests use that to prove a page without spacing fails). Exits 1 on
 * a failure. */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { scene } = require('./crowd_scene');

const HERE = path.join(__dirname, '..');
const WALK = process.env.PAGE3D_WALK ||
  path.join(HERE, '..', 'shared', 'page3d', 'walk.js');
const CROWD = process.env.PAGE3D_CROWD ||
  path.join(HERE, 'estate', 'page3d', 'crowd.js');

/* allowed overlap at rest: none beyond rounding */
const TOL = 1e-6;
/* while walking, figures may brush (a crowd squeezing out of one door),
 * never stand inside each other: centres at least this share of the sum
 * of their radii apart */
const MIN_WALK = 0.8;
const ROLE = { child: 0.78, elder: 0.92 };

function load() {
  const ctx = {}; ctx.globalThis = ctx; vm.createContext(ctx);
  for (const f of [WALK, CROWD]) {
    vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
  }
  return { Walk: ctx.EstateWalk, Crowd: ctx.EstateCrowd };
}

function check(ground, state) {
  const { Walk, Crowd } = load();
  const built = scene(Walk, ground, state);
  const st = built.state;
  const people = st.people;
  const grid = Walk.buildGrid(ground);
  Walk.setFixtures(grid, st.fixtures || []);
  const fixAt = Crowd.fixtureMap(st.fixtures);
  const benchByCell = {};
  (st.fixtures || []).forEach(f => {
    if (f.kind === 'bench') benchByCell[f.x + ',' + f.y] = Crowd.bench(ground, f);
  });
  const fails = [];
  const rOf = p => Crowd.R * (ROLE[p.role] || 1);

  /* ---------------------------------------------------------- snapshot */
  const spots = Crowd.place(Walk, grid, people, benchByCell, fixAt);
  const out = [];
  people.forEach((p, i) => { if (!p.in) out.push(i); });
  let staticGap = Infinity, staticRaw = Infinity, worst = null;
  const seatSeen = {}, seatedAt = {};
  for (let a = 0; a < out.length; a++) {
    const i = out[a], p = people[i];
    /* the old page: every resident on their cell's middle, give or take
     * a hash jitter of their own — the "before" this is measured against */
    for (let b = a + 1; b < out.length; b++) {
      const j = out[b], q = people[j];
      const need = rOf(p) + rOf(q);
      const g = Math.hypot(spots.x[i] - spots.x[j], spots.z[i] - spots.z[j]) - need;
      if (g < staticGap) { staticGap = g; worst = [p.id, q.id]; }
      if (p.x === q.x && p.y === q.y) staticRaw = Math.min(staticRaw, -need);
    }
    if (spots.sit[i] === 1) {
      const k = spots.x[i].toFixed(3) + ',' + spots.z[i].toFixed(3);
      if (seatSeen[k] != null) fails.push(`seat ${k} shared by ${seatSeen[k]} and ${p.id}`);
      seatSeen[k] = p.id;
      const cell = p.x + ',' + p.y;
      seatedAt[cell] = (seatedAt[cell] || 0) + 1;
    } else if (!Crowd.okAt(Walk, grid, fixAt, spots.x[i], spots.z[i], p.x, p.y)) {
      fails.push(`resident ${p.id} stands on blocked ground at ` +
                 `${spots.x[i].toFixed(2)},${spots.z[i].toFixed(2)}`);
    }
  }
  for (const cell in seatedAt) {
    const b = benchByCell[cell];
    if (seatedAt[cell] > b.cap) fails.push(`bench ${cell} seats ${seatedAt[cell]} > ${b.cap}`);
  }
  if (staticGap < -TOL) {
    fails.push(`snapshot: residents ${worst} overlap by ${(-staticGap).toFixed(3)}`);
  }

  /* ----------------------------------------------------------- walking */
  const dayMs = Math.max(300, (Number(st.tick_seconds) || 6) * 1000);
  const units = ground.units || {};
  const doorOf = unit => {
    const u = units[String(unit)];
    const b = u && (ground.buildings || []).find(bb => bb.id === u.b);
    return b && b.door ? { x: b.door[0], y: b.door[1] } : null;
  };
  const routes = [], durs = [];
  let longest = 0, fallbacks = 0;
  for (const i of out) {
    const p = people[i];
    const got = Crowd.route(Walk, grid, p, spots.x[i], spots.z[i], {},
                            p.pin ? doorOf(p.punit) : null);
    routes[i] = got ? got.route : null;
    durs[i] = got ? Walk.duration(got.route.total, dayMs) : 0;
    if (got && got.fallback) fallbacks++;
    longest = Math.max(longest, durs[i]);
  }
  /* the page's queue: walkers leaving one point go in turn */
  const qi = out.filter(i => routes[i] && routes[i].total > 1e-6);
  const delays = Crowd.queue ? Crowd.queue(qi.map(i => ({
    id: people[i].id, x: routes[i].xs[0], z: routes[i].zs[0] }))) : [];
  const t0 = [];
  qi.forEach((i, k) => {
    const f = Crowd.fit ? Crowd.fit(delays[k] || 0, durs[i], dayMs)
                        : { delay: 0, dur: durs[i] };
    t0[i] = f.delay; durs[i] = f.dur;
    longest = Math.max(longest, f.delay + f.dur);
  });
  if (fallbacks) fails.push(`${fallbacks} walks found no path`);
  const F = Walk.figures(null, out.length);
  const m = [];
  const s = { x: 0, z: 0, dx: 0, dz: 0, moving: false };
  let walkRaw = Infinity, walkGap = Infinity, walkWorst = null, frames = 0;
  let offGround = 0;
  for (let ms = 0; ms <= longest + 50; ms += 1000 / 60) {
    frames++;
    out.forEach((i, k) => {
      const r = routes[i];
      s.x = spots.x[i]; s.z = spots.z[i]; s.dx = s.dz = 0; s.moving = false;
      F.layer[k] = 0;
      if (r && r.total > 1e-6) {
        /* still indoors, queued behind others at the door */
        if (people[i].pin && ms < (t0[i] || 0)) F.layer[k] = -1;
        Walk.sample(r, (ms - (t0[i] || 0)) / (durs[i] || 1) * r.total, s);
      }
      F.rx[k] = s.x; F.rz[k] = s.z;
      F.r[k] = rOf(people[i]);
      const seated = spots.sit[i] === 1 && !s.moving;
      F.w[k] = seated ? 0 : s.moving ? 1 : 0.5;
      F.hx[k] = s.moving ? s.dx : 0; F.hz[k] = s.moving ? s.dz : 0;
      F.id[k] = people[i].id;
      const home = Math.floor(s.z) * grid.W + Math.floor(s.x);
      m[k] = Walk.clearAt(grid, s.x, s.z, F.r[k], home) ? F.r[k] : 0;
    });
    const n = out.length;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        if (F.layer[a] < 0 || F.layer[b] < 0) continue;
        const g = Math.hypot(F.rx[a] - F.rx[b], F.rz[a] - F.rz[b]) / (F.r[a] + F.r[b]);
        if (g < walkRaw) walkRaw = g;
      }
    }
    Walk.separate(F, n, {
      iters: 8, pad: 0.06, maxOff: 0.5,
      ok: (k, x, z) => Walk.clearAt(grid, x, z, m[k],
        Math.floor(F.rz[k]) * grid.W + Math.floor(F.rx[k])),
    });
    for (let a = 0; a < n; a++) {
      const home = Math.floor(F.rz[a]) * grid.W + Math.floor(F.rx[a]);
      if (!Walk.clearAt(grid, F.x[a], F.z[a], m[a], home)) offGround++;
      if (F.layer[a] < 0) continue;
      for (let b = a + 1; b < n; b++) {
        if (F.layer[b] < 0) continue;
        const g = Math.hypot(F.x[a] - F.x[b], F.z[a] - F.z[b]) / (F.r[a] + F.r[b]);
        if (g < walkGap) {
          walkGap = g;
          walkWorst = [people[out[a]].id, people[out[b]].id, Math.round(ms)];
        }
      }
    }
  }
  if (walkGap < MIN_WALK) {
    fails.push(`walking: residents ${walkWorst.slice(0, 2)} at ` +
               `${(walkGap * 100).toFixed(0)}% of a body apart, ${walkWorst[2]} ms in`);
  }
  if (offGround) fails.push(`walking: ${offGround} pushes off open ground`);

  return {
    tiles: built.tiles, outdoor: out.length, seated: spots.seated,
    snapshot: { before: staticRaw, after: staticGap },
    walking: { frames, before: walkRaw, after: walkGap },
    fails,
  };
}

if (typeof module !== 'undefined') module.exports = { check };

if (require.main === module) {
  const ground = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const state = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const r = check(ground, state);
  console.log(`crowd: ${r.outdoor} outdoors, ${r.seated} seated, tiles ` +
              JSON.stringify(r.tiles));
  console.log(`snapshot: closest pair ${r.snapshot.before.toFixed(3)} -> ` +
              `${r.snapshot.after.toFixed(3)} (gap beyond touching, cells)`);
  console.log(`walking: ${r.walking.frames} frames, closest pair ` +
              `${(r.walking.before * 100).toFixed(0)}% -> ` +
              `${(r.walking.after * 100).toFixed(0)}% of a body apart`);
  if (r.fails.length) {
    r.fails.forEach(f => console.log('FAIL ' + f));
    process.exit(1);
  }
  console.log('crowd check ok');
}
