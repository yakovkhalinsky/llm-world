/* Two residents never stand inside each other, or in anything else.
 *
 * Runs the page's own placing and spacing — crowd.js (place, the walk
 * there, and `space`, the per-frame push the page calls from world.js)
 * on walk.js — and judges the picture with an oracle of its own, which
 * shares no code with what it checks: the ground's blocked cells read
 * straight from `rows`/`codes`/`walk`, and every fixture's body at its
 * place in the state, at the size world.js draws it (a table's top, a
 * stall, a lamp's pole, a tree's trunk). Penetration is measured as a
 * disk against a box or a disk — never through clearAt or okAt.
 *
 *   snapshot  everyone where the day leaves them, and after the page's
 *             spacing: no two bodies nearer than the sum of their radii;
 *             one figure per seat and no more seated than the bench holds;
 *             no body in a table, a stall, a pole, a trunk, a wall or the
 *             water (its own cell's ground excepted: a door).
 *   walking   the day's walks at 60 frames a second, through Crowd.space as
 *             the page draws them: no two figures nearer than MIN_WALK of
 *             their combined radii, and no push ever takes a body further
 *             into a wall, the water or a fixture than its walk had it.
 *   tables    nobody's body, standing or walking, ever overlaps a table's
 *             0.82 top — their own table's included — and everyone at a
 *             table stands beside it facing its middle.
 *   scenes    small made-up places the day may never produce: a passer-by
 *             at a lamp from every side (the lamp-post case), and at a
 *             café table (whose resident stands off the table's cell, so
 *             only a keep-out from the cells round them keeps them out of
 *             its top); the walk to a lamp's or a tree's places from every
 *             side (round the pole or the trunk, not through it); two
 *             walkers meeting head-on a little to the wrong side (each
 *             must pass on its own right), a crowd in a one-wide corridor,
 *             twenty people at a two-seat bench in a nook (more standing
 *             than its packed tile holds, so the overflow places are
 *             tried), fifteen at a lamp in a dead end.
 *
 * It reports the closest pair before spacing and after, so the gain is
 * visible, not just asserted.
 *
 *   node tools/crowd_check.js ground.json state.json
 *
 * PAGE3D_WALK and PAGE3D_CROWD point it at another walk.js / crowd.js
 * (the tests use that to prove mutants of the page fail). Exits 1 on a
 * failure. */

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
/* how far a body may sink into a wall or a fixture beyond where its walk
 * had it: rounding, not a body inside a pole (a pole is 0.045 across) */
const TOL_IN = 2e-3;
/* while walking, figures may brush (a crowd squeezing out of one door),
 * never stand inside each other: centres at least this share of the sum
 * of their radii apart */
const MIN_WALK = 0.8;
const ROLE = { child: 0.78, elder: 0.92 };
const R_BODY = 0.16;

/* ------------------------------------------------------------ the oracle */
/* What world.js draws on a fixture's cell, about the cell's middle: a
 * table top 0.82 square, a stall 0.9, a lamp pole of radius 0.045, a
 * tree trunk 0.13 at its foot, an unknown kind a 0.5 plinth. A bench is a
 * seat and the playground an open frame people play in: no body here. */
const BODY = { table: ['box', 0.41], shop: ['box', 0.45],
               lamp: ['disk', 0.045], tree: ['disk', 0.13] };
const NO_BODY = { bench: 1, playground: 1 };
const PLINTH = ['box', 0.25];

function oracle(ground, fixtures) {
  const W = ground.width | 0, H = ground.height | 0;
  const walk = ground.walk || {};
  const blocked = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return true;
    const code = ground.codes[ground.rows[y][x]];
    const c = Object.prototype.hasOwnProperty.call(walk, code) ? walk[code]
      : (code === 'water' || code === 'building' ? null : 1);
    return c === null || c === undefined || c <= 0;
  };
  const fix = {};
  (fixtures || []).forEach(f => {
    if (NO_BODY[f.kind]) return;
    fix[f.x + ',' + f.y] = { x: f.x + 0.5, z: f.y + 0.5, kind: f.kind,
                             body: BODY[f.kind] || PLINTH };
  });
  /* how deep a disk sinks into the box [x0,x1]x[z0,z1] (<= 0: clear) */
  const intoBox = (x, z, r, x0, z0, x1, z1) => {
    const dx = Math.max(x0 - x, 0, x - x1), dz = Math.max(z0 - z, 0, z - z1);
    if (dx === 0 && dz === 0) {
      return r + Math.min(x - x0, x1 - x, z - z0, z1 - z);
    }
    return r - Math.hypot(dx, dz);
  };
  /* deepest a body of radius r at (x, z) is in a wall or the water (cells
   * other than `home`, the cell its walk has it in) and in a fixture */
  function pen(x, z, r, hx, hy) {
    let wall = -Infinity, into = -Infinity, what = null;
    const cx = Math.floor(x), cz = Math.floor(z);
    for (let y = cz - 1; y <= cz + 1; y++) {
      for (let xx = cx - 1; xx <= cx + 1; xx++) {
        if (!(xx === hx && y === hy) && blocked(xx, y)) {
          wall = Math.max(wall, intoBox(x, z, r, xx, y, xx + 1, y + 1));
        }
        const f = fix[xx + ',' + y];
        if (!f) continue;
        const [shape, h] = f.body;
        const d = shape === 'disk'
          ? r + h - Math.hypot(x - f.x, z - f.z)
          : intoBox(x, z, r, f.x - h, f.z - h, f.x + h, f.z + h);
        if (d > into) { into = d; what = f.kind + '@' + xx + ',' + y; }
      }
    }
    return { wall, into, what };
  }
  /* how deep a body of radius r at (x, z) is in any table's top — the
   * 0.82 square world.js draws — wherever its walk has it: nobody stands
   * or walks inside a table, their own included */
  const tables = (fixtures || []).filter(f => f.kind === 'table');
  function inTable(x, z, r) {
    let d = -Infinity, what = null;
    for (const f of tables) {
      const h = BODY.table[1];
      const v = intoBox(x, z, r, f.x + 0.5 - h, f.y + 0.5 - h,
                        f.x + 0.5 + h, f.y + 0.5 + h);
      if (v > d) { d = v; what = 'table@' + f.x + ',' + f.y; }
    }
    return { d, what };
  }
  return { pen, blocked, inTable };
}

/* every body in F against the oracle: none further into a wall or a
 * fixture than its raw point (rx/rz) was, beyond TOL_IN */
function judgeFrame(orc, F, n, worst) {
  for (let k = 0; k < n; k++) {
    if (F.layer[k] < 0) continue;
    const hx = Math.floor(F.rx[k]), hy = Math.floor(F.rz[k]);
    const raw = orc.pen(F.rx[k], F.rz[k], F.r[k], hx, hy);
    const got = orc.pen(F.x[k], F.z[k], F.r[k], hx, hy);
    const dw = got.wall - Math.max(raw.wall, 0);
    const df = got.into - Math.max(raw.into, 0);
    if (dw > worst.wall.d) worst.wall = { d: dw, id: F.id[k], at: [F.x[k], F.z[k]] };
    if (df > worst.into.d) {
      worst.into = { d: df, id: F.id[k], what: got.what, at: [F.x[k], F.z[k]] };
    }
  }
}
const freshWorst = () => ({ wall: { d: -Infinity }, into: { d: -Infinity } });
function worstFails(tag, worst, fails) {
  const at = w => w.at.map(v => v.toFixed(3)).join(',');
  if (worst.into.d > TOL_IN) {
    fails.push(`${tag}: ${worst.into.id} pushed ${worst.into.d.toFixed(3)} ` +
               `into the ${worst.into.what} at ${at(worst.into)}`);
  }
  if (worst.wall.d > TOL_IN) {
    fails.push(`${tag}: ${worst.wall.id} pushed ${worst.wall.d.toFixed(3)} ` +
               `into a wall or the water at ${at(worst.wall)}`);
  }
}
function closestPair(xs, zs, rs, n, layer) {
  let g = Infinity;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      if (layer && (layer[a] < 0 || layer[b] < 0)) continue;
      g = Math.min(g, Math.hypot(xs[a] - xs[b], zs[a] - zs[b]) / (rs[a] + rs[b]));
    }
  }
  return g;
}

function load() {
  const ctx = {}; ctx.globalThis = ctx; vm.createContext(ctx);
  for (const f of [WALK, CROWD]) {
    vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
  }
  return { Walk: ctx.EstateWalk, Crowd: ctx.EstateCrowd };
}

/* ---------------------------------------------------------------- scenes */
/* a made-up plan: . path, # building, ~ water, , lawn */
function ascii(lines) {
  const codes = ['path', 'building', 'water', 'lawn'];
  const map = { '.': 0, '#': 1, '~': 2, ',': 3 };
  return { width: lines[0].length, height: lines.length, codes,
           rows: lines.map(l => [...l].map(c => map[c])),
           walk: { path: 1, lawn: 2, building: null, water: null } };
}

function scenes(Walk, Crowd, fails) {
  const ran = [];
  const setup = (lines, fixtures) => {
    const ground = ascii(lines);
    const grid = Walk.buildGrid(ground);
    Walk.setFixtures(grid, fixtures);
    return { ground, grid, fixAt: Crowd.fixtureMap(fixtures),
             orc: oracle(ground, fixtures) };
  };
  const fig = (F, k, x, z, w, hx, hz, id) => {
    F.rx[k] = x; F.rz[k] = z; F.r[k] = R_BODY; F.w[k] = w;
    F.hx[k] = hx; F.hz[k] = hz; F.layer[k] = 0; F.id[k] = id;
  };

  /* the lamp post: one resident standing at a lamp, the page's own slot,
   * and a passer-by brushing them from every side */
  {
    const S = setup(['#####', '#...#', '#...#', '#...#', '#####'],
                    [{ id: 1, kind: 'lamp', x: 2, y: 2 }]);
    const s = Crowd.place(Walk, S.grid, [{ id: 7, x: 2, y: 2, in: false }], {}, S.fixAt);
    const worst = freshWorst();
    const F = Walk.figures(null, 2);
    let cases = 0;
    for (let a = 0; a < 360; a += 3) {
      for (let off = 0.15; off <= 0.4001; off += 0.025) {
        const hx = Math.cos(a * Math.PI / 180), hz = Math.sin(a * Math.PI / 180);
        const wx = s.x[0] - hz * off, wz = s.z[0] + hx * off;
        /* a walk never runs through the pole itself */
        if (Math.hypot(wx - 2.5, wz - 2.5) < R_BODY + 0.045) continue;
        fig(F, 0, s.x[0], s.z[0], 0.5, 0, 0, 7);
        fig(F, 1, wx, wz, 1, hx, hz, 8);
        Crowd.space(Walk, S.grid, S.fixAt, F, 2);
        judgeFrame(S.orc, F, 2, worst);
        cases++;
      }
    }
    worstFails('lamp', worst, fails);
    ran.push(`lamp ${cases}`);
  }

  /* the café table: one resident at a table — their place is just off
   * the table's cell, on the open cell beside it — and a passer-by
   * brushing them from every side: nobody is pushed into the table top */
  {
    const S = setup(['#######', '#.....#', '#.....#', '#.....#', '#######'],
                    [{ id: 1, kind: 'table', x: 3, y: 2 }]);
    const s = Crowd.place(Walk, S.grid, [{ id: 7, x: 3, y: 2, in: false }], {}, S.fixAt);
    const worst = freshWorst();
    let tw = -Infinity;
    const F = Walk.figures(null, 2);
    let cases = 0;
    for (let a = 0; a < 360; a += 3) {
      for (let off = 0.15; off <= 0.4001; off += 0.025) {
        const hx = Math.cos(a * Math.PI / 180), hz = Math.sin(a * Math.PI / 180);
        const wx = s.x[0] - hz * off, wz = s.z[0] + hx * off;
        /* a walk never runs through the table */
        if (S.orc.inTable(wx, wz, R_BODY).d > 0) continue;
        fig(F, 0, s.x[0], s.z[0], 0.5, 0, 0, 7);
        fig(F, 1, wx, wz, 1, hx, hz, 8);
        Crowd.space(Walk, S.grid, S.fixAt, F, 2);
        judgeFrame(S.orc, F, 2, worst);
        tw = Math.max(tw, S.orc.inTable(F.x[0], F.z[0], R_BODY).d);
        cases++;
      }
    }
    worstFails('table-passer', worst, fails);
    if (tw > TOL_IN) {
      fails.push(`table-passer: the resident at the table pushed ${tw.toFixed(3)} into its top`);
    }
    ran.push(`table-passer ${cases}`);
  }

  /* the walk to a lamp or a tree: its places are on its own cell, round
   * the pole or the trunk, so the last leg from a neighbouring cell to a
   * place on the far side must go round it, not through it — from every
   * neighbour, to every place of one to four people there */
  {
    let routes = 0;
    for (const kind of ['lamp', 'tree']) {
      const S = setup(['#######', '#.....#', '#.....#', '#.....#', '#.....#', '#.....#', '#######'],
                      [{ id: 1, kind, x: 3, y: 3 }]);
      const st = { x: 0, z: 0, dx: 0, dz: 0, moving: false };
      let deep = { d: -Infinity };
      for (let N = 1; N <= 4; N++) {
        const people = [];
        for (let k = 0; k < N; k++) people.push({ id: 20 + k, x: 3, y: 3, in: false });
        const s = Crowd.place(Walk, S.grid, people, {}, S.fixAt);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            for (let k = 0; k < N; k++) {
              const p = { id: 20 + k, x: 3, y: 3, px: 3 + dx, py: 3 + dy };
              const got = Crowd.route(Walk, S.grid, p, s.x[k], s.z[k], {}, null, S.fixAt);
              if (!got || got.fallback) {
                fails.push(`${kind}-walk: no route from ${3 + dx},${3 + dy}`);
                continue;
              }
              const r = got.route;
              for (let t = 0; t <= r.total + 1e-9; t += 0.005) {
                Walk.sample(r, Math.min(t, r.total), st);
                const pe = S.orc.pen(st.x, st.z, R_BODY, -9, -9);
                if (pe.into > deep.d) deep = { d: pe.into, at: [st.x, st.z], from: [3 + dx, 3 + dy] };
              }
              routes++;
            }
          }
        }
      }
      if (deep.d > TOL_IN) {
        fails.push(`${kind}-walk: a walk from ${deep.from} runs ${deep.d.toFixed(3)} ` +
                   `into the ${kind} at ${deep.at.map(v => v.toFixed(3)).join(',')}`);
      }
    }
    ran.push(`pole-walk ${routes}`);
  }

  /* head-on, each a twentieth of a cell to the wrong side: they must
   * still pass on their own right (the estate keeps to the right) */
  {
    const S = setup(['#########', '#.......#', '#.......#', '#.......#', '#########'], []);
    const F = Walk.figures(null, 2);
    const worst = freshWorst();
    let passed = null, gap = Infinity, frames = 0, prev = null;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      fig(F, 0, 1.5 + 6 * t, 2.475, 1, 1, 0, 1);
      fig(F, 1, 7.5 - 6 * t, 2.525, 1, -1, 0, 2);
      Crowd.space(Walk, S.grid, S.fixAt, F, 2);
      judgeFrame(S.orc, F, 2, worst);
      frames++;
      gap = Math.min(gap, closestPair(F.x, F.z, F.r, 2));
      const along = F.x[1] - F.x[0];
      if (prev !== null && prev > 0 && along <= 0 && passed === null) {
        /* the moment they pass: is each on its own right of the other? */
        const rightA = (F.z[0] - F.z[1]) * 1;     // a heads +x, its right +z
        const rightB = (F.z[1] - F.z[0]) * -1;    // b heads -x, its right -z
        passed = rightA > 0 && rightB > 0;
      }
      prev = along;
    }
    if (passed !== true) fails.push('head-on: the walkers did not pass on their own right');
    if (gap < MIN_WALK) {
      fails.push(`head-on: the walkers came ${(gap * 100).toFixed(0)}% of a body apart`);
    }
    worstFails('head-on', worst, fails);
    ran.push(`head-on ${frames}`);
  }

  /* a corridor one cell wide, three walking each way */
  {
    const S = setup(['###########', '#.........#', '###########'], []);
    const F = Walk.figures(null, 6);
    const worst = freshWorst();
    let frames = 0;
    for (let t = 0; t <= 1.0001; t += 0.005) {
      for (let k = 0; k < 3; k++) {
        fig(F, k, 1.5 + 8 * t - k * 0.4, 1.5, 1, 1, 0, 10 + k);
        fig(F, 3 + k, 9.5 - 8 * t + k * 0.4, 1.5, 1, -1, 0, 20 + k);
      }
      Crowd.space(Walk, S.grid, S.fixAt, F, 6);
      judgeFrame(S.orc, F, 6, worst);
      frames++;
    }
    worstFails('corridor', worst, fails);
    ran.push(`corridor ${frames}`);
  }

  /* a crowd where there is no room for it: placed (Crowd.place) and then
   * drawn (Crowd.space), every stander clear of the walls and fixtures */
  const crowd = (tag, lines, fixtures, cell, N, apart) => {
    const S = setup(lines, fixtures);
    const benches = {};
    fixtures.forEach(f => {
      if (f.kind === 'bench') benches[f.x + ',' + f.y] = Crowd.bench(S.ground, f);
    });
    const people = [];
    for (let k = 0; k < N; k++) {
      people.push({ id: k + 1, x: cell[0], y: cell[1], in: false,
                    fixture: fixtures[0].id });
    }
    const s = Crowd.place(Walk, S.grid, people, benches, S.fixAt);
    const F = Walk.figures(null, N);
    const seen = {};
    for (let i = 0; i < N; i++) {
      fig(F, i, s.x[i], s.z[i], s.sit[i] === 1 ? 0 : 0.5, 0, 0, i + 1);
      const key = s.x[i].toFixed(3) + ',' + s.z[i].toFixed(3);
      if (seen[key]) fails.push(`${tag}: ${seen[key]} and ${i + 1} on one spot ${key}`);
      seen[key] = i + 1;
      if (s.sit[i] === 1) continue;
      const p = S.orc.pen(s.x[i], s.z[i], R_BODY, cell[0], cell[1]);
      if (p.wall > TOL_IN) {
        fails.push(`${tag}: ${i + 1} placed ${p.wall.toFixed(3)} into a wall ` +
                   `at ${s.x[i].toFixed(2)},${s.z[i].toFixed(2)}`);
      }
      if (p.into > TOL_IN) {
        fails.push(`${tag}: ${i + 1} placed ${p.into.toFixed(3)} into the ` +
                   `${p.what} at ${s.x[i].toFixed(2)},${s.z[i].toFixed(2)}`);
      }
    }
    const placedGap = closestPair(s.x, s.z, F.r, N);
    if (apart && placedGap < 1 - TOL) {
      fails.push(`${tag}: two placed ${(placedGap * 100).toFixed(0)}% of a body apart`);
    }
    Crowd.space(Walk, S.grid, S.fixAt, F, N);
    const worst = freshWorst();
    judgeFrame(S.orc, F, N, worst);
    worstFails(tag, worst, fails);
    ran.push(`${tag} ${N} (closest ${(placedGap * 100).toFixed(0)}%)`);
  };
  crowd('bench-nook', ['#####', '#...#', '##.##', '##.##', '#####'],
        [{ id: 9, kind: 'bench', x: 2, y: 2, cap: 2 }], [2, 2], 20, true);
  crowd('lamp-dead-end', ['#####', '#####', '##.##', '##.##', '##.##', '#####'],
        [{ id: 5, kind: 'lamp', x: 2, y: 2 }], [2, 2], 15, false);
  return ran;
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
  const orc = oracle(ground, st.fixtures);
  const rOf = p => R_BODY * (ROLE[p.role] || 1);

  /* ---------------------------------------------------------- snapshot */
  const spots = Crowd.place(Walk, grid, people, benchByCell, fixAt);
  const out = [];
  people.forEach((p, i) => { if (!p.in) out.push(i); });
  let staticGap = Infinity, staticRaw = Infinity, worst = null;
  const seatSeen = {}, seatedAt = {};
  let atTable = 0;
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
    {
      const t = orc.inTable(spots.x[i], spots.z[i], rOf(p));
      if (t.d > TOL_IN) {
        fails.push(`table: resident ${p.id} stands ${t.d.toFixed(3)} inside ` +
                   `the ${t.what} at ${spots.x[i].toFixed(2)},${spots.z[i].toFixed(2)}`);
      }
    }
    if (fixAt[p.x + ',' + p.y] && fixAt[p.x + ',' + p.y].kind === 'table') {
      atTable++;
      const want = Math.atan2(p.x + 0.5 - spots.x[i], p.y + 0.5 - spots.z[i]);
      const got = Crowd.faceTable ? Crowd.faceTable(fixAt, p.x, p.y,
                                                    spots.x[i], spots.z[i]) : null;
      const off = got === null ? Math.PI
        : Math.abs(Math.atan2(Math.sin(got - want), Math.cos(got - want)));
      if (off > 0.2) {
        fails.push(`table: resident ${p.id} at the table@${p.x},${p.y} ` +
                   `does not face it`);
      }
    }
    if (spots.sit[i] === 1) {
      const k = spots.x[i].toFixed(3) + ',' + spots.z[i].toFixed(3);
      if (seatSeen[k] != null) fails.push(`seat ${k} shared by ${seatSeen[k]} and ${p.id}`);
      seatSeen[k] = p.id;
      const cell = p.x + ',' + p.y;
      seatedAt[cell] = (seatedAt[cell] || 0) + 1;
    } else {
      const pe = orc.pen(spots.x[i], spots.z[i], rOf(p), p.x, p.y);
      if (pe.wall > TOL_IN || pe.into > TOL_IN) {
        fails.push(`snapshot: resident ${p.id} stands ` +
                   (pe.into > TOL_IN ? `${pe.into.toFixed(3)} into the ${pe.what}`
                                     : `${pe.wall.toFixed(3)} into a wall`) +
                   ` at ${spots.x[i].toFixed(2)},${spots.z[i].toFixed(2)}`);
      }
    }
  }
  for (const cell in seatedAt) {
    const b = benchByCell[cell];
    if (seatedAt[cell] > b.cap) fails.push(`bench ${cell} seats ${seatedAt[cell]} > ${b.cap}`);
  }
  if (!atTable) fails.push('table: nobody at a table, so the table check proves nothing');
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
                            p.pin ? doorOf(p.punit) : null, fixAt);
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
  const s = { x: 0, z: 0, dx: 0, dz: 0, moving: false };
  let walkRaw = Infinity, walkGap = Infinity, walkWorst = null, frames = 0;
  const pushed = freshWorst();
  let tableWorst = { d: -Infinity };
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
    });
    const n = out.length;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        if (F.layer[a] < 0 || F.layer[b] < 0) continue;
        const g = Math.hypot(F.rx[a] - F.rx[b], F.rz[a] - F.rz[b]) / (F.r[a] + F.r[b]);
        if (g < walkRaw) walkRaw = g;
      }
    }
    /* the page's own per-frame spacing (world.js spaceResidents) */
    Crowd.space(Walk, grid, fixAt, F, n);
    judgeFrame(orc, F, n, pushed);
    for (let a = 0; a < n; a++) {
      if (F.layer[a] < 0) continue;
      const t = orc.inTable(F.x[a], F.z[a], F.r[a]);
      if (t.d > tableWorst.d) {
        tableWorst = { d: t.d, id: F.id[a], what: t.what, ms: Math.round(ms),
                       at: [F.x[a], F.z[a]] };
      }
    }
    for (let a = 0; a < n; a++) {
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
  worstFails('walking', pushed, fails);
  if (tableWorst.d > TOL_IN) {
    fails.push(`table: resident ${tableWorst.id} walks ${tableWorst.d.toFixed(3)} ` +
               `inside the ${tableWorst.what} at ` +
               `${tableWorst.at.map(v => v.toFixed(2)).join(',')}, ${tableWorst.ms} ms in`);
  }

  const ran = scenes(Walk, Crowd, fails);
  return {
    tiles: built.tiles, outdoor: out.length, seated: spots.seated, scenes: ran,
    atTable,
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
  console.log(`crowd: ${r.outdoor} outdoors, ${r.seated} seated, ` +
              `${r.atTable} at tables (beside, facing), tiles ` +
              JSON.stringify(r.tiles));
  console.log(`snapshot: closest pair ${r.snapshot.before.toFixed(3)} -> ` +
              `${r.snapshot.after.toFixed(3)} (gap beyond touching, cells)`);
  console.log(`walking: ${r.walking.frames} frames, closest pair ` +
              `${(r.walking.before * 100).toFixed(0)}% -> ` +
              `${(r.walking.after * 100).toFixed(0)}% of a body apart`);
  console.log(`scenes: ${r.scenes.join('; ')}`);
  if (r.fails.length) {
    r.fails.forEach(f => console.log('FAIL ' + f));
    process.exit(1);
  }
  console.log('crowd check ok');
}
