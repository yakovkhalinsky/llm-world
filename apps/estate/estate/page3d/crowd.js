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
   * its pole (0.045 across the radius) or trunk (0.13 at its foot); the bus
   * shelter all of its 0.86 square — posts, glass, seat, roof and the
   * stop's pole are drawn inside it — so the queue waits round it
   * (daytime.stop_spots). The playground is for climbing on, so children may
   * stand in its frame. A kind the page has never seen keeps a small
   * plinth's distance. */
  var KEEP = { table: 0.42, shop: 0.46, lamp: 0.06, tree: 0.14,
               playground: 0, bus_stop: 0.44 };
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

  /* A young child out with a guardian (the snapshot's `with`, the id of
   * the guardian the engine keeps them with) stands beside them: a body's
   * width and a gap from the guardian's place, the first of these that the
   * tile's own rules allow — clear of walls, the water and the keep of the
   * table, stall, lamp or tree on the cell (`okAt`), and clear of everyone
   * else placed on the tile. Beside a seated guardian, in front of the
   * bench first. A child who has a seat of their own keeps it. */
  var BESIDE = 2 * R + GAP;
  function besideSpots(gx, gz, seated, fx, fz) {
    var d = BESIDE, e = BESIDE * Math.SQRT1_2, out = [];
    if (seated) {
      out.push([gx + fx * d, gz + fz * d],
               [gx + fx * d - fz * e, gz + fz * d + fx * e],
               [gx + fx * d + fz * e, gz + fz * d - fx * e]);
    }
    out.push([gx + d, gz], [gx - d, gz], [gx, gz + d], [gx, gz - d],
             [gx + e, gz + e], [gx - e, gz + e], [gx + e, gz - e],
             [gx - e, gz - e]);
    return out;
  }

  function placeBeside(Walk, grid, fixAt, people, groups, keys, out) {
    var at = {};
    for (var i = 0; i < people.length; i++) at[people[i].id] = i;
    for (var g = 0; g < keys.length; g++) {
      var idx = groups[keys[g]].slice().sort(function (a, c) {
        return people[a].id - people[c].id;
      });
      for (var k = 0; k < idx.length; k++) {
        var ci = idx[k], p = people[ci];
        if (p.with == null) continue;
        var gi = at[p.with];
        /* the guardian on another tile (a view between polls) or indoors:
         * nothing to stand beside */
        if (gi === undefined || people[gi].in || people[gi].x !== p.x ||
            people[gi].y !== p.y) continue;
        out.with[ci] = gi;
        if (out.sit[ci] === 1) continue;
        var spots = besideSpots(out.x[gi], out.z[gi], out.sit[gi] === 1,
                                out.fx[gi], out.fz[gi]);
        for (var s = 0; s < spots.length; s++) {
          var x = spots[s][0], z = spots[s][1];
          if (!okAt(Walk, grid, fixAt, x, z, p.x, p.y)) continue;
          var clear = true;
          for (var o = 0; o < idx.length && clear; o++) {
            var oi = idx[o];
            if (oi === ci) continue;
            if (Math.hypot(out.x[oi] - x, out.z[oi] - z) < BESIDE - 1e-6) {
              clear = false;
            }
          }
          if (!clear) continue;
          out.x[ci] = x; out.z[ci] = z;
          out.sit[ci] = 0;
          break;
        }
      }
    }
  }

  /* Where everyone outdoors stands. `people` is the snapshot's list;
   * `benchByCell` maps "x,y" to `bench(...)`. Returns parallel arrays by
   * index: x, z, sit (0 standing, 1 seated, 2 standing by a bench), the
   * bench's facing for 1 and 2, and `seats`, by resident id, the seat a
   * seated resident took (to get up from tomorrow). `with[i]` is the index
   * of the guardian a young child stands beside (`placeBeside`), else -1. */
  function place(Walk, grid, people, benchByCell, fixAt) {
    var n = people.length;
    var out = { x: new Array(n), z: new Array(n), sit: new Array(n),
                fx: new Array(n), fz: new Array(n), seated: 0, seats: {},
                with: new Array(n) };
    var groups = {}, keys = [];
    for (var i = 0; i < n; i++) {
      var p = people[i];
      out.x[i] = p.x + 0.5; out.z[i] = p.y + 0.5;
      out.sit[i] = 0; out.fx[i] = 0; out.fz[i] = 1; out.with[i] = -1;
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
    placeBeside(Walk, grid, fixAt, people, groups, keys, out);
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

  /* What world.js draws on a solid fixture's cell, about its middle, for
   * the per-frame push: a box's half-size or a disk's radius (Walk's
   * KEEP_BOX / KEEP_DISK) — a table top 0.82 square, a stall 0.9, a lamp's
   * pole, a tree's trunk at its foot, the bus shelter's 0.86 square that
   * holds its posts, glass, roof and the stop's pole. The playground is for climbing on: no
   * body. A solid kind the page has never seen is a small plinth. A body's
   * edge keeps BODY_GAP clear of any of them. */
  var BODY = { table: [0, 0.41], shop: [0, 0.45], lamp: [1, 0.045],
               tree: [1, 0.13], playground: null, bus_stop: [0, 0.43] };
  var BODY_OTHER = [0, 0.25];
  var BODY_GAP = 0.01;
  function bodyAt(fixAt, x, y) {
    var f = fixAt && fixAt[x + ',' + y];
    if (!f) return BODY_OTHER;
    return Object.prototype.hasOwnProperty.call(BODY, f.kind)
      ? BODY[f.kind] : BODY_OTHER;
  }

  /* The page's spacing for one frame: `Walk.separate` on F's n figures
   * (rx/rz their raw points), with the guard every push must pass: the
   * body, at its full half-width, against every wall and every solid
   * fixture's drawn body within a cell of its raw point (Walk's
   * keep-outs) — so a resident at a café table, whose place is just
   * outside the table's cell, is still kept out of the table top. A body
   * clear of something stays clear of it; one already nearer than that is
   * never moved nearer. The cell the raw point is in counts as open
   * ground (a door). One place for the page and the checks. */
  var SP = { Walk: null, grid: null, K: [], t0: [], t1: [], home: [] };
  function spaceOk(k, x, z) {
    return SP.Walk.cellOpen(SP.grid, x, z, SP.home[k]) &&
      SP.Walk.keepClear(SP.K, SP.t0[k], SP.t1[k], x, z);
  }
  function space(Walk, grid, fixAt, F, n) {
    for (var k = n; k < F.layer.length; k++) F.layer[k] = -1;
    if (grid) {
      var K = SP.K, t = 0;
      for (k = 0; k < n; k++) {
        SP.t0[k] = t;
        if (F.layer[k] < 0) { SP.t1[k] = t; continue; }
        var x = F.rx[k], z = F.rz[k], m = F.r[k];
        var hx = Math.floor(x), hz = Math.floor(z);
        var home = hx >= 0 && hx < grid.W && hz >= 0 && hz < grid.H
          ? hz * grid.W + hx : -1;
        SP.home[k] = home;
        t = Walk.groundKeepOuts(grid, K, t, x, z, m, home, 1);
        for (var y = hz - 1; y <= hz + 1; y++) {
          if (y < 0 || y >= grid.H) continue;
          for (var c = hx - 1; c <= hx + 1; c++) {
            if (c < 0 || c >= grid.W || !grid.solid[y * grid.W + c]) continue;
            var b = bodyAt(fixAt, c, y);
            if (!b) continue;
            t = Walk.keepOut(K, t, b[0], c + 0.5, y + 0.5, b[1], m + BODY_GAP, x, z);
          }
        }
        SP.t1[k] = t;
      }
      SP.Walk = Walk; SP.grid = grid;
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
  var ROUND_GAP = 0.005;
  function route(Walk, grid, p, tx, tz, prev, door, fixAt) {
    var scx, scy, sx, sz;
    if (door) {
      scx = door.x; scy = door.y;
      sx = scx + 0.5; sz = scy + 0.5;
    } else {
      scx = p.px == null ? p.x : p.px;
      scy = p.py == null ? p.y : p.py;
      sx = scx + 0.5; sz = scy + 0.5;
      var was = prev && prev[p.id];
      if (was && was.cell === scx + ',' + scy) {
        sx = was.x; sz = was.z;
        /* a place just off a solid fixture's cell — beside a café table,
         * in the bus stop's queue round its shelter — is on the open cell
         * it stands in: the walk away sets off from that cell, as the walk
         * there ended in it, not back across the fixture's (the stop-passer
         * scene walked them through the shelter) */
        var wx = Math.floor(sx), wz = Math.floor(sz);
        if (grid && (wx !== scx || wz !== scy) && wx >= 0 && wz >= 0 &&
            wx < grid.W && wz < grid.H && grid.solid[scy * grid.W + scx] &&
            grid.base[wz * grid.W + wx] && !grid.solid[wz * grid.W + wx]) {
          scx = wx; scy = wz;
        }
      }
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
    if (cells) {
      var r = Walk.routePoints(cells, sx, sz, tx, tz);
      /* a slot at a lamp or a tree is on its own cell, so the first leg
       * (leaving one) or the last (going to one) may run through the pole
       * or the trunk: bent round it */
      if (Walk.around && fixAt) {
        [[scx, scy], [tcx, tcy]].forEach(function (cc, i) {
          if (i === 1 && cc[0] === scx && cc[1] === scy) return;
          var f = fixAt[cc[0] + ',' + cc[1]];
          var b = f && grid.solid[cc[1] * grid.W + cc[0]] && bodyAt(fixAt, cc[0], cc[1]);
          if (!b || b[0] !== 1) return;
          r = Walk.around(r, cc[0] + 0.5, cc[1] + 0.5, b[1] + R + ROUND_GAP,
                         grid, R);
        });
      }
      if (fixAt) r = byMiddles(r, grid, fixAt, scx, scy, tcx, tcy);
      return { route: r, fallback: false, from: [scx, scy] };
    }
    return { route: Walk ? Walk.straight(sx, sz, tx, tz)
                         : { xs: [sx, tx], zs: [sz, tz], cum: [0, 1], n: 2,
                             total: Math.hypot(tx - sx, tz - sz) },
             fallback: true, from: [scx, scy] };
  }

  /* How deep a body of radius R walking `r` goes, at its deepest, into a
   * wall or the water (a closed cell other than the one it is in) and
   * into a solid fixture's drawn body (a pole, a trunk, a table top, a
   * stall): {wall, into}, <= 0 when clear. Sampled every 0.02 of a cell. */
  function depthAlong(r, grid, fixAt) {
    var wall = -Infinity, into = -Infinity;
    var intoBox = function (x, z, x0, z0, x1, z1) {
      var dx = Math.max(x0 - x, 0, x - x1), dz = Math.max(z0 - z, 0, z - z1);
      if (dx === 0 && dz === 0) {
        return R + Math.min(x - x0, x1 - x, z - z0, z1 - z);
      }
      return R - Math.hypot(dx, dz);
    };
    for (var i = 1; i < r.n; i++) {
      var ax = r.xs[i - 1], az = r.zs[i - 1], bx = r.xs[i], bz = r.zs[i];
      var steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.02));
      for (var k = 0; k <= steps; k++) {
        var x = ax + (bx - ax) * k / steps, z = az + (bz - az) * k / steps;
        var cx = Math.floor(x), cz = Math.floor(z);
        for (var y = cz - 1; y <= cz + 1; y++) {
          for (var xx = cx - 1; xx <= cx + 1; xx++) {
            var out = xx < 0 || y < 0 || xx >= grid.W || y >= grid.H;
            if ((xx !== cx || y !== cz) && (out || !grid.base[y * grid.W + xx])) {
              wall = Math.max(wall, intoBox(x, z, xx, y, xx + 1, y + 1));
            }
            if (out || !grid.solid[y * grid.W + xx] || !fixAt ||
                !fixAt[xx + ',' + y]) continue;
            var b = bodyAt(fixAt, xx, y);
            if (!b) continue;
            var mx = xx + 0.5, mz = y + 0.5;
            into = Math.max(into, b[0] === 1
              ? R + b[1] - Math.hypot(x - mx, z - mz)
              : intoBox(x, z, mx - b[1], mz - b[1], mx + b[1], mz + b[1]));
          }
        }
      }
    }
    return { wall: wall, into: into };
  }

  /* An end off its cell's middle — a place beside a café table or in the
   * bus stop's queue round its shelter — can cut the corner of a solid
   * fixture's cell that the search's line of sight, middle to middle,
   * cleared (the stop-passer scene: 0.11 into the shelter's roof post).
   * Such an end leg goes by its own cell's middle instead, when that cell
   * is open and the leg so goes less deep into the fixture and no deeper
   * into a wall. Two short legs measured per end, and only when the plain
   * one touches something. */
  function byMiddles(r, grid, fixAt, scx, scy, tcx, tcy) {
    var xs = Array.prototype.slice.call(r.xs);
    var zs = Array.prototype.slice.call(r.zs);
    var leg = function (ax, az, bx, bz) {
      return depthAlong({ xs: [ax, bx], zs: [az, bz], n: 2 }, grid, fixAt);
    };
    var by = function (i, j, cx, cy) {
      /* the leg from point i to point j (adjacent), by (cx, cy)'s middle */
      var mx = cx + 0.5, mz = cy + 0.5;
      if (grid.solid[cy * grid.W + cx] || !grid.base[cy * grid.W + cx]) return false;
      if (Math.hypot(xs[i] - mx, zs[i] - mz) < 1e-6 ||
          Math.hypot(xs[j] - mx, zs[j] - mz) < 1e-6) return false;
      var now = leg(xs[i], zs[i], xs[j], zs[j]);
      if (now.into <= 0) return false;
      var a = leg(xs[i], zs[i], mx, mz), b = leg(mx, mz, xs[j], zs[j]);
      if (Math.max(a.into, b.into) >= now.into ||
          Math.max(a.wall, b.wall) > Math.max(now.wall, 0) + 1e-9) return false;
      xs.splice(Math.max(i, j), 0, mx);
      zs.splice(Math.max(i, j), 0, mz);
      return true;
    };
    var changed = by(xs.length - 2, xs.length - 1, tcx, tcy);
    if (by(0, 1, scx, scy)) changed = true;
    if (!changed) return r;
    var cum = new Float64Array(xs.length), total = 0;
    for (var i = 1; i < xs.length; i++) {
      total += Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
      cum[i] = total;
    }
    return { xs: new Float64Array(xs), zs: new Float64Array(zs), cum: cum,
             n: xs.length, total: total };
  }

  /* A young child's walk with their guardian: the guardian's own route,
   * from where the child stands to the child's place beside them, so the
   * pair walk one way round every wall (the guardian's path is the one
   * that was checked) and arrive together. `own` is the child's own route
   * (`route`); when it starts on another cell than the guardian's, or the
   * guardian is not walking, the child keeps their own.
   *
   * The two end legs are the child's, not the guardian's — from the
   * guardian's second point back to where the child stands, and from the
   * guardian's last bend on to the child's place — so they go round every
   * pole and trunk beside them by the same detour `route` takes (#12's
   * Walk.around). And when the page has the ground (`grid`), the follow
   * is kept only if it goes no deeper into a wall or a fixture than the
   * child's own route: otherwise the child walks their own way.
   *
   * The detour only rounds disks (a pole, a trunk); a table top, a stall
   * or a wall's corner beside an end leg is the depth guard's alone, and
   * crowd_check's follow-guard scene has end legs that graze each.
   *
   * Cost: Walk.around runs once per pole or trunk in the cells within one
   * of each end leg's box, so it is bounded by that box (an end leg spans
   * a cell or two), plus two depthAlong walks; the adversarial worst the
   * #10 review timed was 12.7 ms for one follow.
   *
   * FOLLOW_TOL is rounding, in cells: a follow deeper than the child's
   * own route by more than this is refused. It is not slack — at 0.05 a
   * follow grazing a table top by 0.02 would be kept (the follow-guard
   * scene fails). */
  var FOLLOW_TOL = 1e-3;
  function follow(lead, leadFrom, own, ownFrom, Walk, grid, fixAt) {
    if (!lead || !own || !leadFrom || !ownFrom ||
        leadFrom[0] !== ownFrom[0] || leadFrom[1] !== ownFrom[1] ||
        lead.n < 2) return own;
    var xs = Array.prototype.slice.call(lead.xs);
    var zs = Array.prototype.slice.call(lead.zs);
    xs[0] = own.xs[0]; zs[0] = own.zs[0];
    xs[xs.length - 1] = own.xs[own.n - 1];
    zs[zs.length - 1] = own.zs[own.n - 1];
    var cum = new Float64Array(xs.length), total = 0;
    for (var i = 1; i < xs.length; i++) {
      total += Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
      cum[i] = total;
    }
    var r = { xs: new Float64Array(xs), zs: new Float64Array(zs), cum: cum,
              n: xs.length, total: total };
    if (!grid) return r;
    if (Walk && Walk.around && fixAt) {
      /* every pole or trunk within a cell of either end leg */
      var seen = {};
      [0, 1].forEach(function (end) {
        /* read afresh: a detour on the first leg adds points, so the last
         * leg's indices are only known once it is done */
        var lg = end ? [r.n - 2, r.n - 1] : [0, 1];
        var x0 = Math.floor(Math.min(r.xs[lg[0]], r.xs[lg[1]])) - 1;
        var x1 = Math.floor(Math.max(r.xs[lg[0]], r.xs[lg[1]])) + 1;
        var z0 = Math.floor(Math.min(r.zs[lg[0]], r.zs[lg[1]])) - 1;
        var z1 = Math.floor(Math.max(r.zs[lg[0]], r.zs[lg[1]])) + 1;
        for (var y = z0; y <= z1; y++) {
          for (var x = x0; x <= x1; x++) {
            var key = x + ',' + y;
            if (seen[key] || x < 0 || y < 0 || x >= grid.W || y >= grid.H ||
                !fixAt[key] || !grid.solid[y * grid.W + x]) continue;
            seen[key] = true;
            var b = bodyAt(fixAt, x, y);
            if (!b || b[0] !== 1) continue;
            r = Walk.around(r, x + 0.5, y + 0.5, b[1] + R + ROUND_GAP, grid, R);
          }
        }
      });
    }
    var got = depthAlong(r, grid, fixAt), mine = depthAlong(own, grid, fixAt);
    if (got.into > Math.max(mine.into, 0) + FOLLOW_TOL ||
        got.wall > Math.max(mine.wall, 0) + FOLLOW_TOL) return own;
    return r;
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

  /* Someone standing at a table faces it: the yaw (world.js's `facing`,
   * atan2 of the way they look) from (x, z) to the middle of the table on
   * their cell (hx, hy), or null when their cell has no table. */
  function faceTable(fixAt, hx, hy, x, z) {
    var f = fixAt && fixAt[hx + ',' + hy];
    if (!f || f.kind !== 'table') return null;
    var dx = f.x + 0.5 - x, dz = f.y + 0.5 - z;
    if (dx * dx + dz * dz < 1e-8) return null;
    return Math.atan2(dx, dz);
  }

  /* Steps underfoot. A door's step and the shop's stall — a low wooden
   * plinth on the cell in front of the shop, where the engine puts its
   * counter — are the only raised ground a walker crosses, so they are
   * one step high (STEP_H), and a figure over one is lifted onto it: fully
   * once a foot (FOOT from the body's middle) is over its edge, and on a
   * smooth ramp over the RAMP before that, so nobody's feet pass through
   * a step and nobody pops up onto one in a frame. `steps` is the list
   * world.js draws the steps from — the same rectangles, so what is drawn
   * and what is stood on cannot drift apart. */
  var STEP_H = 0.06;
  var FOOT = 0.10;
  var RAMP = 0.22;
  function doorFace(b) {
    var dx = b.door[0], dy = b.door[1];
    if (dy < b.y) return { axis: 'z', sign: -1, at: b.y };
    if (dy >= b.y + b.h) return { axis: 'z', sign: 1, at: b.y + b.h };
    if (dx < b.x) return { axis: 'x', sign: -1, at: b.x };
    return { axis: 'x', sign: 1, at: b.x + b.w };
  }
  /* one building's door step: {x0, z0, x1, z1, h, kind, id, face, along,
   * doorW}, in world units (x along columns, z along rows) */
  function doorStep(b) {
    var face = doorFace(b);
    var doorW = b.kind === 'shop' ? 0.8 : 0.55;
    var along = face.axis === 'z'
      ? Math.max(b.x + 0.55, Math.min(b.x + b.w - 0.55, b.door[0] + 0.5))
      : Math.max(b.y + 0.55, Math.min(b.y + b.h - 0.55, b.door[1] + 0.5));
    var half = (doorW + 0.24) / 2;
    var a = face.at + face.sign * 0.04, c = face.at + face.sign * 0.38;
    var lo = Math.min(a, c), hi = Math.max(a, c);
    var r = face.axis === 'z'
      ? { x0: along - half, x1: along + half, z0: lo, z1: hi }
      : { x0: lo, x1: hi, z0: along - half, z1: along + half };
    r.h = STEP_H; r.kind = 'door'; r.id = b.id;
    r.face = face; r.along = along; r.doorW = doorW;
    return r;
  }
  function steps(ground, fixtures) {
    var out = [];
    (ground.buildings || []).forEach(function (b) {
      if (b && b.door) out.push(doorStep(b));
    });
    (fixtures || []).forEach(function (f) {
      if (f.kind !== 'shop') return;
      out.push({ x0: f.x + 0.05, x1: f.x + 0.95, z0: f.y + 0.05,
                 z1: f.y + 0.95, h: STEP_H, kind: 'shop', id: f.id });
    });
    return out;
  }
  /* how far above the ground a figure standing at (x, z) has its feet */
  function lift(st, x, z) {
    var best = 0;
    if (!st) return 0;
    for (var k = 0; k < st.length; k++) {
      var r = st[k];
      var dx = Math.max(r.x0 - x, 0, x - r.x1);
      var dz = Math.max(r.z0 - z, 0, z - r.z1);
      var d = Math.sqrt(dx * dx + dz * dz), y;
      if (d <= FOOT) y = r.h;
      else if (d >= FOOT + RAMP) continue;
      else {
        var t = 1 - (d - FOOT) / RAMP;
        y = r.h * t * t * (3 - 2 * t);
      }
      if (y > best) best = y;
    }
    return best;
  }

  var api = {
    R: R, GAP: GAP, KEEP: KEEP, SEAT_STEP: SEAT_STEP, END: END,
    benchFacing: benchFacing, bench: bench, fixtureMap: fixtureMap,
    BODY: BODY, BODY_GAP: BODY_GAP,
    okAt: okAt, keepAt: keepAt, place: place, route: route, space: space,
    BESIDE: BESIDE, follow: follow, depthAlong: depthAlong,
    queue: queue, fit: fit, QUEUE_MS: QUEUE_MS,
    STEP_H: STEP_H, FOOT: FOOT, RAMP: RAMP, doorFace: doorFace,
    steps: steps, doorStep: doorStep, lift: lift, faceTable: faceTable,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.EstateCrowd = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
