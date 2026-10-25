/* The router's check.
 *
 * `walk.js` is the half of the plan the engine does not have: the engine
 * walks its people cell by cell, and both pages ask this file for the same
 * search over the same ground. It had no committed test — the Python
 * replica in a commit message was not in the repo, and a replica that is
 * not run is not a test.
 *
 * The ground and the day are the server's own payloads, so this can be
 * pointed at a live estate or handed two files. Every door must reach
 * every fixture; no string-pulled segment may cross a block, the water or
 * a solid fixture; an enclosed target returns null and terminates; a
 * start or end off the plan, or inside a wall, returns null; a route
 * sampled at its own total lands on the target and stops; and a walk never
 * outlasts the tick that sent it.
 *
 *   node tools/walk_check.js ground.json state.json
 *   node tools/walk_check.js http://localhost:8797
 *
 * The HTTP form fetches /api/ground and /api/state, the same two payloads
 * the pages poll.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const https = require('https');

const WALK = path.join(__dirname, '..', 'estate', 'page', 'walk.js');

/* The page is classic scripts, so walk.js publishes itself on `globalThis`
 * rather than exporting. Load it in a context of its own, exactly as the
 * plan page inlines it. */
function loadWalk(file) {
  const src = fs.readFileSync(file, 'utf8');
  const ctx = {};
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: file });
  if (!ctx.EstateWalk) throw new Error('walk.js did not publish EstateWalk');
  return ctx.EstateWalk;
}

/* ------------------------------------------------------------- payloads */

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const lib = url.indexOf('https:') === 0 ? https : http;
    lib.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(url + ' -> ' + res.statusCode));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error(url + ' returned no JSON: ' + e.message));
        }
      });
    }).on('error', reject);
  });
}

async function load(where) {
  if (/^https?:\/\//.test(where)) {
    const base = where.replace(/\/+$/, '');
    const [ground, state] = await Promise.all([
      getJSON(base + '/api/ground'), getJSON(base + '/api/state')]);
    return { ground, state, label: base };
  }
  if (!process.argv[2] || !process.argv[3]) {
    throw new Error('usage: walk_check.js <ground.json> <state.json> | ' +
                    'walk_check.js http://host:port');
  }
  return {
    ground: JSON.parse(fs.readFileSync(process.argv[2], 'utf8')),
    state: JSON.parse(fs.readFileSync(process.argv[3], 'utf8')),
    label: 'files',
  };
}

/* ---------------------------------------------------------------- checks */

const fails = [];
function ok(name, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name +
              (cond || !detail ? '' : '   (' + detail + ')'));
  if (!cond) fails.push(name);
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }

/* `rows` is the server's array of codes; the harness also accepted rows of
 * raw characters, so keep that shape working for a hand-written payload. */
function cellCode(ground, x, y) {
  if (x < 0 || y < 0 || x >= ground.width || y >= ground.height) return null;
  const row = ground.rows[y];
  const v = typeof row === 'string' ? row.charCodeAt(x) : row[x];
  return ground.codes[v];
}

function setCell(ground, x, y, code) {
  const idx = ground.codes.indexOf(code);
  if (idx < 0) throw new Error('no such site in this ground: ' + code);
  const row = ground.rows[y];
  if (typeof row === 'string') {
    ground.rows[y] = row.slice(0, x) + String.fromCharCode(idx) +
                     row.slice(x + 1);
  } else {
    row[x] = idx;
  }
}

const SOLID = { tree: 1, lamp: 1, table: 1, playground: 1, shop: 1 };

/* One straight segment of a pulled route, sampled densely enough that
 * "which cell did it cross" is not a matter of opinion. The route's own
 * endpoints are exempt from the solid-fixture test, exactly as the router's
 * `openAt` exempts them: a destination may be a solid fixture, and the walk
 * is allowed to finish on the thing it set out for; a start may be one too
 * (the shop's stall stands on the shop's door), because that is where the
 * walker already is. Buildings and water are never exempt. */
function segmentCrosses(ground, solidAt, ax, ay, bx, by, sx, sy, gx, gy) {
  const L = Math.hypot(bx - ax, by - ay);
  const k = Math.max(1, Math.ceil(L * 20));
  for (let j = 0; j <= k; j++) {
    const x = Math.floor(ax + (bx - ax) * j / k);
    const y = Math.floor(ay + (by - ay) * j / k);
    const code = cellCode(ground, x, y);
    if (code === null) return 'off the plan at ' + x + ',' + y;
    if (code === 'building' || code === 'water') {
      return code + ' at ' + x + ',' + y;
    }
    const endpoint = (x === gx && y === gy) || (x === sx && y === sy);
    if (!endpoint && solidAt[y * ground.width + x]) {
      return 'solid fixture at ' + x + ',' + y;
    }
  }
  return null;
}

function solidGrid(Walk, g, fixtures) {
  const out = new Uint8Array(groundWidth(g) * groundHeight(g));
  for (const f of fixtures) {
    if (SOLID[f.kind] && f.x >= 0 && f.y >= 0 &&
        f.x < groundWidth(g) && f.y < groundHeight(g)) {
      out[f.y * groundWidth(g) + f.x] = 1;
    }
  }
  return out;
}
function groundWidth(g) { return g.W; }
function groundHeight(g) { return g.H; }

function run(Walk, ground, fixtures) {
  const g = Walk.buildGrid(ground);
  Walk.setFixtures(g, fixtures);
  const doors = (ground.buildings || []).map(b => b.door);
  const goals = fixtures.map(f => [f.x, f.y]);
  const solid = solidGrid(Walk, g, fixtures);

  /* --- every door reaches every fixture ------------------------------- */
  let routes = 0, nulls = 0, bad = 0, maxCorners = 0;
  const t0 = process.hrtime.bigint();
  for (const d of doors) {
    for (const t of goals) {
      const p = Walk.findPath(g, d[0], d[1], t[0], t[1]);
      routes++;
      if (!p) { nulls++; continue; }
      maxCorners = Math.max(maxCorners, p.length / 2);
      for (let i = 0; i + 3 < p.length; i += 2) {
        const why = segmentCrosses(ground, solid,
                                   p[i] + 0.5, p[i + 1] + 0.5,
                                   p[i + 2] + 0.5, p[i + 3] + 0.5,
                                   d[0], d[1], t[0], t[1]);
        if (why) {
          if (bad < 5) {
            console.log('  ---- ' + d + ' -> ' + t + ': ' + why);
          }
          bad++;
          break;
        }
      }
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ok('every door reaches every fixture', nulls === 0,
     nulls + ' of ' + routes + ' routes are null');
  ok('no route crosses a building, the water or a solid fixture',
     bad === 0, bad + ' routes cross something');
  ok('a pulled route is made of corners, not cells', maxCorners > 0);
  console.log('  ---- ' + routes + ' door-to-fixture routes, longest ' +
              maxCorners + ' corners, ' + ms.toFixed(1) + ' ms cold');

  /* --- an enclosed target returns null, and terminates ---------------- */
  const walled = clone(ground);
  let target = null;
  for (const f of fixtures) {
    if (f.kind !== 'bench') continue;
    if (f.x < 1 || f.y < 1 ||
        f.x >= walled.width - 1 || f.y >= walled.height - 1) continue;
    if (cellCode(walled, f.x, f.y) === 'water' ||
        cellCode(walled, f.x, f.y) === 'building') continue;
    target = f;
    break;
  }
  ok('the ground has a bench to wall in', !!target);
  if (target) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      setCell(walled, target.x + dx, target.y + dy, 'water');
    }
    const g2 = Walk.buildGrid(walled);
    Walk.setFixtures(g2, fixtures);
    const d = doors[0];
    const started = Date.now();
    const p = Walk.findPath(g2, d[0], d[1], target.x, target.y);
    const took = Date.now() - started;
    ok('an enclosed target returns null', p === null, JSON.stringify(p));
    ok('an enclosed target terminates promptly', took < 5000,
       took + ' ms');
  }

  /* --- endpoints off the plan or in a wall ---------------------------- */
  const d0 = doors[0] || [0, 0];
  ok('an out-of-bounds start returns null',
     Walk.findPath(g, -1, 0, d0[0], d0[1]) === null);
  ok('an out-of-bounds target returns null',
     Walk.findPath(g, d0[0], d0[1], ground.width, 0) === null);
  let wall = null;
  for (let y = 0; y < ground.height && !wall; y++) {
    for (let x = 0; x < ground.width; x++) {
      if (cellCode(ground, x, y) === 'building') { wall = [x, y]; break; }
    }
  }
  ok('the ground has a building cell', !!wall);
  if (wall) {
    ok('a building cell as a start returns null',
       Walk.findPath(g, wall[0], wall[1], d0[0], d0[1]) === null);
    ok('a building cell as a target returns null',
       Walk.findPath(g, d0[0], d0[1], wall[0], wall[1]) === null);
  }

  /* --- sample lands on the target and stops --------------------------- */
  const bench = fixtures.find(f => f.kind === 'bench') || null;
  if (bench) {
    const cells = Walk.findPath(g, d0[0], d0[1], bench.x, bench.y);
    ok('a route to a bench was found', !!cells);
    if (cells) {
      const route = Walk.routePoints(cells, d0[0] + 0.5, d0[1] + 0.5,
                                     bench.x + 0.5, bench.y + 0.5);
      const out = {};
      Walk.sample(route, route.total, out);
      ok('sample at the total lands on the target',
         Math.abs(out.x - (bench.x + 0.5)) < 1e-9 &&
         Math.abs(out.z - (bench.y + 0.5)) < 1e-9,
         out.x + ',' + out.z);
      ok('sample at the total is not moving', out.moving === false);
      const mid = {};
      Walk.sample(route, route.total / 2, mid);
      ok('sample before the end is moving',
         route.total <= 1e-6 || mid.moving === true);
    }
  }

  /* --- a walk never outlasts the tick --------------------------------- */
  const totals = [0.0001, 0.5, 1, 5, 20, 50, 100, 500];
  /* the server's fastest pace is a day every 5s, and its control clamps a
   * tick at 0.2s; a minute is the slow one. The 200ms case is included so
   * the short-tick floor is checked, not assumed. */
  const ticks = [200, 300, 600, 1000, 5000, 20000, 60000];
  let over = 0, worst = '';
  for (const total of totals) {
    for (const tick of ticks) {
      const d = Walk.duration(total, tick);
      if (!(d >= 0) || d > tick * 0.9 + 1e-9) {
        over++;
        worst = 'total ' + total + ', tick ' + tick + ' -> ' + d;
      }
    }
  }
  ok('duration never exceeds 0.9 of the tick', over === 0, worst);
  const unset = Walk.duration(500);
  ok('duration with no tick defaults to the six-second day',
     unset <= 6000 * 0.9 + 1e-9, unset);

  /* --- the uncached cost of a random route ---------------------------- */
  const g3 = Walk.buildGrid(ground);
  Walk.setFixtures(g3, fixtures);
  let rnd = 1;
  const R = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const open = [];
  for (let y = 0; y < ground.height; y++) {
    for (let x = 0; x < ground.width; x++) {
      const c = cellCode(ground, x, y);
      if (c !== 'building' && c !== 'water') open.push([x, y]);
    }
  }
  const started = Date.now();
  let randomNulls = 0;
  for (let i = 0; i < 2000 && open.length; i++) {
    g3.cache.clear();
    const a = open[Math.floor(R() * open.length)];
    const b = open[Math.floor(R() * open.length)];
    if (Walk.findPath(g3, a[0], a[1], b[0], b[1]) === null) randomNulls++;
  }
  const randomMs = Date.now() - started;
  console.log('  ---- 2000 uncached random open-cell routes: ' + randomMs +
              ' ms, ' + randomNulls + ' null');
  ok('2000 uncached random routes finish inside the generous bound',
     randomMs < 20000, randomMs + ' ms');
}

(async () => {
  try {
    const Walk = loadWalk(WALK);
    const { ground, state, label } = await load(process.argv[2]);
    console.log('walk_check: ' + label);
    ok('the ground arrived', !!ground && !!ground.rows && !!ground.codes);
    ok('the day arrived', !!state && Array.isArray(state.fixtures));
    if (!ground || !ground.rows || !state || !Array.isArray(state.fixtures)) {
      console.log('\n' + fails.length + ' FAILED');
      process.exit(1);
    }
    run(Walk, ground, state.fixtures);
    console.log('\n' + (fails.length
      ? fails.length + ' FAILED: ' + fails.join('; ') : 'all ok'));
    process.exit(fails.length ? 1 : 0);
  } catch (e) {
    console.error('walk_check: ' + (e && e.stack ? e.stack : e));
    process.exit(1);
  }
})();
