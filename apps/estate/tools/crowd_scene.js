/* A crowded day, built from a real one.
 *
 * The live estate rarely has more than two people on one tile at the
 * moment a page polls, so the crowd check and the screenshots of a crowd
 * need one made on purpose. This takes the server's own ground and day
 * and moves residents (nothing else) onto the busiest places the plan
 * has: nine on the playground, three on a two-seat bench, four at a
 * table, five standing on one path tile, six leaving the same door
 * together for the same place, and two groups walking head-on along one
 * straight run of path. Everyone else is put indoors. The same inputs
 * give the same scene, so the check is deterministic.
 *
 *   node tools/crowd_scene.js ground.json state.json > crowded.json
 */

'use strict';

function scene(Walk, ground, state) {
  const st = JSON.parse(JSON.stringify(state));
  const g = Walk.buildGrid(ground, {});
  Walk.setFixtures(g, st.fixtures || []);
  const W = g.W, H = g.H;
  const code = (x, y) => ground.codes[ground.rows[y][x]];
  const open = (x, y) => x >= 0 && y >= 0 && x < W && y < H &&
    g.base[y * W + x] && !g.solid[y * W + x];
  const fixAt = {};
  (st.fixtures || []).forEach(f => { fixAt[f.x + ',' + f.y] = f; });
  const people = (st.people || []).slice().sort((a, b) => a.id - b.id);
  const byId = (a, b) => a.id - b.id;
  const fx = (st.fixtures || []).slice().sort(byId);
  const near = (f, x, y) => Math.abs(f.x - x) + Math.abs(f.y - y);

  const play = fx.find(f => f.kind === 'playground');
  const table = fx.find(f => f.kind === 'table');
  /* a bench beside a path, so it faces it, and not on the perimeter */
  const bench = fx.find(f => f.kind === 'bench' && !f.perimeter &&
    [[0, -1], [0, 1], [-1, 0], [1, 0]].some(([dx, dy]) => {
      const x = f.x + dx, y = f.y + dy;
      return x >= 0 && y >= 0 && x < W && y < H && code(x, y) === 'path';
    })) || fx.find(f => f.kind === 'bench');

  /* open path tiles with no fixture, nearest the playground first */
  const paths = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (code(x, y) === 'path' && open(x, y) && !fixAt[x + ',' + y]) {
        paths.push([x, y]);
      }
    }
  }
  const anchor = play || { x: W >> 1, y: H >> 1 };
  paths.sort((a, b) => (near(anchor, a[0], a[1]) - near(anchor, b[0], b[1])) ||
    (a[1] - b[1]) || (a[0] - b[0]));
  const standTile = paths[0];

  /* the longest straight run of open path, for the head-on walkers */
  let run = null;
  for (const [x, y] of paths) {
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      let n = 0;
      while (open(x + dx * (n + 1), y + dy * (n + 1)) &&
             code(x + dx * (n + 1), y + dy * (n + 1)) === 'path') n++;
      if (n >= 4 && (!run || n > run.n)) run = { x, y, dx, dy, n };
    }
  }

  /* a door with an open tile in front, and a far open path tile */
  const units = ground.units || {};
  const doorUnit = Object.keys(units).map(Number).sort((a, b) => a - b)
    .find(u => { const b = (ground.buildings || []).find(bb => bb.id === units[u].b);
                 return b && b.door; });
  const doorB = (ground.buildings || []).find(b => b.id === units[doorUnit].b);

  let k = 0;
  const take = n => people.slice(k, (k += n));
  people.forEach(p => {           // indoors by default, at home, not walking
    p.in = true; p.pin = true; p.fixture = null;
    p.px = p.x; p.py = p.y; p.punit = p.unit;
  });
  const outdoor = (p, x, y, fixture) => {
    p.x = x; p.y = y; p.px = x; p.py = y; p.in = false; p.pin = false;
    p.fixture = fixture == null ? null : fixture;
  };
  const tiles = {};
  if (play) take(9).forEach(p => outdoor(p, play.x, play.y, play.id));
  if (bench) take(3).forEach(p => outdoor(p, bench.x, bench.y, bench.id));
  if (table) take(4).forEach(p => outdoor(p, table.x, table.y, table.id));
  if (standTile) take(5).forEach(p => outdoor(p, standTile[0], standTile[1]));
  tiles.play = play && [play.x, play.y];
  tiles.bench = bench && [bench.x, bench.y];
  tiles.table = table && [table.x, table.y];
  tiles.stand = standTile;

  /* six out of the same door at once, all to the same far tile */
  if (doorB) {
    const far = paths[Math.min(paths.length - 1, Math.floor(paths.length * 0.6))];
    take(6).forEach(p => {
      p.x = far[0]; p.y = far[1]; p.in = false; p.fixture = null;
      p.pin = true; p.punit = doorUnit; p.px = doorB.door[0]; p.py = doorB.door[1];
    });
    tiles.door = doorB.door; tiles.doorTo = far;
  }
  /* three each way along one straight run */
  if (run) {
    const a = [run.x, run.y];
    const b = [run.x + run.dx * run.n, run.y + run.dy * run.n];
    take(3).forEach(p => { outdoor(p, b[0], b[1]); p.px = a[0]; p.py = a[1]; });
    take(3).forEach(p => { outdoor(p, a[0], a[1]); p.px = b[0]; p.py = b[1]; });
    tiles.runA = a; tiles.runB = b;
  }
  st.people = people;
  return { state: st, tiles: tiles };
}

if (typeof module !== 'undefined') module.exports = { scene };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const file = process.env.PAGE3D_WALK ||
    path.join(__dirname, '..', '..', 'shared', 'page3d', 'walk.js');
  const ctx = {}; ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  const ground = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const state = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const out = scene(ctx.EstateWalk, ground, state);
  if (process.argv[4]) fs.writeFileSync(process.argv[4], JSON.stringify(out.tiles));
  process.stdout.write(JSON.stringify(out.state));
}
