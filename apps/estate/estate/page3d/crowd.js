/* crowd — where each resident stands when several share a tile.
 *
 * The engine says which cell a resident ended the day on and nothing
 * finer: a playground holds a dozen children, a table four, a bench two
 * seated and anyone else standing by. Where in the cell each one is drawn
 * is the page's choice, and it used to be each resident's own hash jitter
 * (±0.17 of a cell), chosen without looking at anyone else — so two people
 * on one tile were drawn inside each other, and four at a table stood in
 * the table. This places them as a group instead:
 *
 *   - seats first, one figure per seat (the bench's own rule, unchanged);
 *     anyone over the bench's capacity stands past its ends, each in a
 *     place of their own, then in front of it;
 *   - everyone else on a tile is packed round its middle (`Walk.pack`),
 *     lowest id first, bodies a little more than a body apart, never inside
 *     a table, a shop's stall or a lamp standard, and never on a wall, the
 *     water or another fixture (`okAt`);
 *   - a walk starts where its walker last stood, and ends at the place
 *     chosen here.
 *
 * The page then keeps walkers apart frame by frame with `Walk.separate`.
 * None of this touches the engine: the sim is unchanged, and so is every
 * fingerprint. Pure functions of the snapshot — no THREE, no DOM — so
 * `tools/crowd_check.js` runs this same file in Node.
 *
 * A classic script loaded before the module, published as EstateCrowd.
 */
(function (root) {
  'use strict';

  /* a body's half-width: the capsule and the head are both 0.16 */
  var R = 0.16;
  /* room between two standing bodies, on top of touching */
  var GAP = 0.04;
  /* how far from a solid fixture's middle a body's edge must stay, by kind:
   * the table top is 0.82 square, the stall 0.9; a lamp or a tree is only
   * its pole (0.045 across the radius) or trunk (0.13 at its foot). The playground is for climbing on, so children may
   * stand in its frame. A kind the page has never seen keeps a small
   * plinth's distance. */
  var KEEP = { table: 0.42, shop: 0.46, lamp: 0.06, tree: 0.14,
               playground: 0 };
  var KEEP_OTHER = 0.26;
  /* seats along a bench, centre to centre; a stander past its end */
  var SEAT_STEP = 0.42;
  var END = 0.74, END_STEP = 2 * R + GAP;

  /* Which way a bench faces: its back to the walkway's far side, looking
   * at the path beside it; a bench with no path beside it keeps the
   * default pose. */
  function benchFacing(ground, f) {
    var W = ground.width, H = ground.height;
    var dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    for (var k = 0; k < dirs.length; k++) {
      var x = f.x + dirs[k][0], y = f.y + dirs[k][1];
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (ground.codes[ground.rows[y][x]] === 'path') {
        return { fx: dirs[k][0], fz: dirs[k][1],
                 yaw: Math.atan2(dirs[k][0], dirs[k][1]) };
      }
    }
    return { fx: 0, fz: 1, yaw: 0 };
  }

  /* The page's record of a bench: where, which way, how many seats. */
  function bench(ground, f) {
    var face = benchFacing(ground, f);
    return { key: f.x + ',' + f.y, id: Number(f.id),
             cx: f.x, cy: f.y, x: f.x + 0.5, z: f.y + 0.5,
             fx: face.fx, fz: face.fz, yaw: face.yaw,
             perimeter: !!f.perimeter,
             cap: Math.max(0, Number(f.cap) || 0) };
  }

  function fixtureMap(fixtures) {
    var m = {};
    (fixtures || []).forEach(function (f) { m[f.x + ',' + f.y] = f; });
    return m;
  }

  /* How far a body's edge keeps from the middle of the fixture on cell
   * (hx, hy): 0 when there is none. */
  function keepAt(fixAt, hx, hy) {
    var f = fixAt && fixAt[hx + ',' + hy];
    if (!f) return 0;
    return Object.prototype.hasOwnProperty.call(KEEP, f.kind)
      ? KEEP[f.kind] : KEEP_OTHER;
  }

  /* May a body stand at (x, z), when (hx, hy) is the cell it belongs to?
   * Its own cell is allowed (a door, a fixture's cell); every other cell
   * its body touches must be open ground with no solid in it; and in a
   * solid fixture's cell it keeps out of the fixture itself (clearAt's
   * `keep`). */
  function okAt(Walk, grid, fixAt, x, z, hx, hy) {
    if (!grid) return true;
    return Walk.clearAt(grid, x, z, R, hy * grid.W + hx,
                        keepAt(fixAt, hx, hy));
  }

  /* Where everyone outdoors stands. `people` is the snapshot's list;
   * `benchByCell` maps "x,y" to `bench(...)`. Returns parallel arrays by
   * index: x, z, sit (0 standing, 1 seated, 2 standing by a bench), the
   * bench's facing for 1 and 2, and `seats`, by resident id, the seat a
   * seated resident took (to get up from tomorrow). */
  function place(Walk, grid, people, benchByCell, fixAt) {
    var n = people.length;
    var out = { x: new Array(n), z: new Array(n), sit: new Array(n),
                fx: new Array(n), fz: new Array(n), seated: 0, seats: {} };
    var groups = {}, keys = [];
    for (var i = 0; i < n; i++) {
      var p = people[i];
      out.x[i] = p.x + 0.5; out.z[i] = p.y + 0.5;
      out.sit[i] = 0; out.fx[i] = 0; out.fz[i] = 1;
      if (p.in) continue;
      var key = p.x + ',' + p.y;
      if (!groups[key]) { groups[key] = []; keys.push(key); }
      groups[key].push(i);
    }
    keys.sort();
    for (var g = 0; g < keys.length; g++) {
      var idx = groups[keys[g]];
      var b = benchByCell && benchByCell[keys[g]];
      if (b) placeBench(Walk, grid, fixAt, people, idx, b, out);
      else placeTile(Walk, grid, fixAt, people, idx, out);
    }
    return out;
  }

  function placeTile(Walk, grid, fixAt, people, idx, out) {
    idx.sort(function (a, c) { return people[a].id - people[c].id; });
    var p0 = people[idx[0]];
    var hx = p0.x, hy = p0.y;
    var solid = grid && grid.solid[hy * grid.W + hx];
    var rs = idx.map(function () { return R; });
    var got = Walk ? Walk.pack(rs, hx + 0.5, hy + 0.5, {
      gap: GAP, reach: 1.6, recentre: !solid,
      ok: function (k, x, z) { return okAt(Walk, grid, fixAt, x, z, hx, hy); },
    }) : null;
    for (var k = 0; k < idx.length; k++) {
      if (got) { out.x[idx[k]] = got.xs[k]; out.z[idx[k]] = got.zs[k]; }
    }
  }

  /* A resident is seated only when the bench is the fixture they chose; a
   * walk that merely ended on the cell stands there. Seats go to those
   * users first, lowest ids first, side by side. */
  function placeBench(Walk, grid, fixAt, people, idx, b, out) {
    idx.sort(function (a, c) {
      var ua = people[a].fixture != null &&
               Number(people[a].fixture) === b.id ? 0 : 1;
      var uc = people[c].fixture != null &&
               Number(people[c].fixture) === b.id ? 0 : 1;
      return ua - uc || people[a].id - people[c].id;
    });
    /* local +x, which runs along the seat, in world coordinates */
    var ax = Math.cos(b.yaw), az = -Math.sin(b.yaw);
    /* places to stand, in order: past alternate ends of the seat, a
     * body's width further each time, then a row in front of it. The seat
     * is 0.9 long (±0.45) and a body 0.32 wide, so nothing nearer the end
     * than 0.61 — a stander there reads as a third sitter. */
    var spots = [];
    for (var j = 0; j < 4; j++) {
      var d = END + j * END_STEP;
      spots.push([b.x + ax * -d, b.z + az * -d], [b.x + ax * d, b.z + az * d]);
    }
    for (var row = 1; row <= 2; row++) {
      var f = 0.30 + row * END_STEP;
      [-0.5, 0.5, -1.5, 1.5].forEach(function (s) {
        spots.push([b.x + b.fx * f + ax * s * END_STEP,
                    b.z + b.fz * f + az * s * END_STEP]);
      });
    }
    var used = 0, over = [], taken = [];
    for (var rank = 0; rank < idx.length; rank++) {
      var i = idx[rank];
      out.fx[i] = b.fx; out.fz[i] = b.fz;
      if (rank < b.cap) {
        var off = b.cap > 1 ? (rank - (b.cap - 1) / 2) * SEAT_STEP : 0;
        out.x[i] = b.x + ax * off;
        out.z[i] = b.z + az * off;
        out.sit[i] = 1;
        out.seats[people[i].id] = { cell: b.key, x: out.x[i], z: out.z[i] };
        out.seated++;
        taken.push({ x: out.x[i], z: out.z[i], r: R });
        continue;
      }
      out.sit[i] = 2;
      var stood = false;
      while (used < spots.length) {
        var s = spots[used++];
        if (okAt(Walk, grid, fixAt, s[0], s[1], b.cx, b.cy)) {
          out.x[i] = s[0]; out.z[i] = s[1];
          taken.push({ x: s[0], z: s[1], r: R });
          stood = true;
          break;
        }
      }
      if (!stood) over.push(i);
    }
    /* more standers than places by the bench (a crowd, or a bench in a
     * nook with no room past its ends): packed round it like any shared
     * tile, clear of the seated and those already standing, on ground
     * okAt allows — never in a wall, never on top of each other */
    if (!over.length) return;
    var got = Walk ? Walk.pack(over.map(function () { return R; }), b.x, b.z, {
      gap: GAP, reach: 1.6, fixed: taken,
      ok: function (k, x, z) {
        return okAt(Walk, grid, fixAt, x, z, b.cx, b.cy);
      },
    }) : null;
    over.forEach(function (i, k) {
      out.x[i] = got ? got.xs[k] : b.x + ax * END;
      out.z[i] = got ? got.zs[k] : b.z + az * END;
    });
  }

  /* The page's spacing for one frame: `Walk.separate` on F's n figures
   * (rx/rz their raw points), with the guard every push must pass — the
   * body stays on open ground (clearAt, at its full radius when its raw
   * point was clear, else its centre at least) and out of the fixture in
   * the cell its route has it in (the fixture's keep; a body whose raw
   * point is already nearer than that is never moved nearer). One place
   * for the page and the checks. */
  var SP = { Walk: null, grid: null, F: null, m: [], home: [], keep: [] };
  function spaceOk(k, x, z) {
    return SP.Walk.clearAt(SP.grid, x, z, SP.m[k], SP.home[k], SP.keep[k]);
  }
  function space(Walk, grid, fixAt, F, n) {
    for (var k = n; k < F.layer.length; k++) F.layer[k] = -1;
    if (grid) {
      for (k = 0; k < n; k++) {
        var x = F.rx[k], z = F.rz[k];
        var hx = Math.floor(x), hz = Math.floor(z);
        var home = hz * grid.W + hx;
        var m = Walk.clearAt(grid, x, z, F.r[k], home) ? F.r[k] : 0;
        var keep = 0;
        if (grid.solid[home] && hx >= 0 && hx < grid.W) {
          keep = keepAt(fixAt, hx, hz);
          var box = Math.max(Math.abs(x - hx - 0.5), Math.abs(z - hz - 0.5));
          keep = Math.max(0, Math.min(keep, box - m));
        }
        SP.m[k] = m; SP.home[k] = home; SP.keep[k] = keep;
      }
      SP.Walk = Walk; SP.grid = grid; SP.F = F;
    }
    return Walk.separate(F, n, { iters: 8, pad: 0.06, maxOff: 0.5,
                                 ok: grid ? spaceOk : null });
  }

  /* The walk to (tx, tz) for resident p: from the door if they are coming
   * out of a block, else from where they stood (`prev[id]`, if it is on
   * the cell they left) or the middle of that cell. Null when there is
   * nowhere to go, or they stay on their tile and the page never saw them
   * stand anywhere else on it. `{route, fallback}` otherwise; a missing path falls
   * back to the straight line and says so. */
  function route(Walk, grid, p, tx, tz, prev, door) {
    var scx, scy, sx, sz;
    if (door) {
      scx = door.x; scy = door.y;
      sx = scx + 0.5; sz = scy + 0.5;
    } else {
      scx = p.px == null ? p.x : p.px;
      scy = p.py == null ? p.y : p.py;
      sx = scx + 0.5; sz = scy + 0.5;
      var was = prev && prev[p.id];
      if (was && was.cell === scx + ',' + scy) { sx = was.x; sz = was.z; }
      /* staying on the tile with no earlier spot to come from (the page
       * has just opened): already standing there, as before */
      else if (scx === p.x && scy === p.y) return null;
    }
    if (Math.abs(sx - tx) < 1e-3 && Math.abs(sz - tz) < 1e-3) return null;
    var tcx = Math.floor(tx), tcy = Math.floor(tz);
    var cells = null;
    if (grid) {
      if (scx === tcx && scy === tcy) cells = [scx, scy];
      else cells = Walk.findPath(grid, scx, scy, tcx, tcy);
    }
    if (cells) return { route: Walk.routePoints(cells, sx, sz, tx, tz),
                        fallback: false, from: [scx, scy] };
    return { route: Walk ? Walk.straight(sx, sz, tx, tz)
                         : { xs: [sx, tx], zs: [sz, tz], cum: [0, 1], n: 2,
                             total: Math.hypot(tx - sx, tz - sz) },
             fallback: true, from: [scx, scy] };
  }

  /* Walkers who set off from the same point — out of one door, or off one
   * tile when the page has no earlier spot for them — go one after another
   * rather than as one body: lowest id first, each a body and a half behind
   * the one before at walking pace (walk.js's 4 cells a second). `starts`
   * is a list of {id, x, z}; returns each one's delay in ms, in order. */
  var QUEUE_MS = (2 * R + GAP + 0.12) / 4.0 * 1000;
  function queue(starts) {
    var groups = {}, delays = new Array(starts.length);
    starts.forEach(function (s, k) {
      var key = s.x.toFixed(3) + ',' + s.z.toFixed(3);
      (groups[key] = groups[key] || []).push(k);
    });
    Object.keys(groups).forEach(function (key) {
      groups[key].sort(function (a, b) { return starts[a].id - starts[b].id; })
        .forEach(function (k, rank) { delays[k] = rank * QUEUE_MS; });
    });
    return delays;
  }
  /* A late start still arrives inside the day: the walk is shortened to
   * fit, never pushed past the hour (walk.js caps a walk at 0.9 of it). */
  function fit(delay, dur, dayMs) {
    var cap = Math.max(120, (dayMs || 6000) * 0.9);
    var d = Math.min(delay, cap * 0.5);
    return { delay: d, dur: Math.min(dur, Math.max(60, cap - d)) };
  }

  var api = {
    R: R, GAP: GAP, KEEP: KEEP, SEAT_STEP: SEAT_STEP, END: END,
    benchFacing: benchFacing, bench: bench, fixtureMap: fixtureMap,
    okAt: okAt, keepAt: keepAt, place: place, route: route, space: space,
    queue: queue, fit: fit, QUEUE_MS: QUEUE_MS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.EstateCrowd = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
