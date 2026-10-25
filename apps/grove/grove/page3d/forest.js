/* forest — where things stand, and where a creature may walk.
 *
 * The estate's router (`walk.js`, shared) finds paths on a grid of cells.
 * A grove cell is a metre of forest floor that may hold a tree, three
 * ferns and a rabbit at once, so the router is given a finer grid here:
 * every cell is split into 2×2 quarters. Water quarters are not walkable;
 * a standing tree's trunk takes one quarter of its cell and that quarter
 * is a solid, so a deer walks round a pine instead of through it, and
 * never wades.
 *
 * Everything here is a pure function of the frame (no THREE, no DOM, no
 * randomness): the same snapshot puts every trunk and every resting
 * creature in the same quarter on every page load, which is what lets
 * `tools/route_check.js` check the routes in Node against a real world.
 *
 * A classic script (loaded before the module), published as GroveForest.
 */
(function (root) {
  'use strict';

  var SUB = 2;                       // quarters per cell, each way
  /* a quarter's centre within its cell, in cells */
  var QX = [0.25, 0.75, 0.25, 0.75];
  var QZ = [0.25, 0.25, 0.75, 0.75];
  var TERRAIN = { s: 'soil', w: 'water', r: 'rock' };
  /* what a step costs on each ground: water is null, never walked */
  var WALK = { soil: 1.0, rock: 1.4, water: null };
  /* the stages that stand: a sapling is a whip a deer brushes past, a log
   * is lying down; only a grown trunk is a solid */
  var STANDING = { mature: 1, old: 1 };

  function hash(n, salt) {
    var x = ((n | 0) * 374761393 + (salt | 0) * 668265263) | 0;
    x = Math.imul(x ^ (x >>> 13), 1274126177) | 0;
    x = x ^ (x >>> 16);
    return x >>> 0;
  }

  /* The quartered ground, in the shape `Walk.buildGrid` reads. */
  function subGround(st) {
    var N = Number(st.size) | 0;
    var rows = [];
    for (var sy = 0; sy < N * SUB; sy++) {
      var row = [];
      for (var sx = 0; sx < N * SUB; sx++) {
        var c = st.cells[((sy / SUB) | 0) * N + ((sx / SUB) | 0)];
        var t = TERRAIN[c && c[0]] || 'soil';
        row.push(t === 'water' ? 1 : t === 'rock' ? 2 : 0);
      }
      rows.push(row);
    }
    return { width: N * SUB, height: N * SUB, rows: rows,
             codes: ['soil', 'water', 'rock'], walk: WALK };
  }

  function kindOf(st, sp) {
    var k = st.biome && st.biome.kinds;
    return (k && k[sp]) || '';
  }

  /* Every standing tree takes one quarter of its cell for its trunk: the
   * one its id hashes to, or the next free one round the cell. The trees
   * are placed in id order, so who gets which quarter never depends on the
   * order the server listed them in. Returns the fixtures for the router
   * and, by plant id, where each trunk stands in world units. */
  function trunks(st) {
    var N = Number(st.size) | 0;
    var taken = {};
    var fixtures = [];
    var at = {};
    var trees = (st.plants || []).filter(function (p) {
      return STANDING[p.st] && kindOf(st, p.sp) === 'tree';
    }).sort(function (a, b) { return a.id - b.id; });
    for (var i = 0; i < trees.length; i++) {
      var p = trees[i];
      if (!(p.x >= 0 && p.y >= 0 && p.x < N && p.y < N)) continue;
      var q0 = hash(p.id, 11) % 4;
      var q = q0;
      for (var k = 0; k < 4; k++) {
        var cand = (q0 + k) % 4;
        if (!taken[p.x + ',' + p.y + ',' + cand]) { q = cand; break; }
      }
      taken[p.x + ',' + p.y + ',' + q] = 1;
      var sx = p.x * SUB + (q & 1), sy = p.y * SUB + (q >> 1);
      fixtures.push({ id: p.id, kind: 'trunk', x: sx, y: sy });
      at[p.id] = { x: p.x + QX[q], z: p.y + QZ[q], q: q };
    }
    return { fixtures: fixtures, at: at, taken: taken };
  }

  /* Where a creature rests in a cell: a quarter that is neither water nor
   * a trunk, chosen by its id and the cell so that it is the same quarter
   * every time it comes back to that cell. */
  function restSpot(id, x, y, st, taken) {
    var q0 = hash(id, x * 977 + y * 131 + 7) % 4;
    var N = Number(st.size) | 0;
    var c = st.cells[y * N + x];
    var water = c && c[0] === 'w';
    for (var k = 0; k < 4; k++) {
      var q = (q0 + k) % 4;
      if (!water && !taken[x + ',' + y + ',' + q]) {
        return { x: x + QX[q], z: y + QZ[q] };
      }
    }
    return { x: x + QX[q0], z: y + QZ[q0] };
  }

  /* A walk from one point to another, in world units, round the trunks
   * and the water. `null` from the router (a start or goal in the water, or
   * a goal walled in) falls back to the straight line, and says so. */
  function route(Walk, grid, fx, fz, tx, tz) {
    var cells = Walk.findPath(grid,
      Math.floor(fx * SUB), Math.floor(fz * SUB),
      Math.floor(tx * SUB), Math.floor(tz * SUB));
    if (!cells) {
      return { route: Walk.straight(fx, fz, tx, tz), fallback: true };
    }
    var r = Walk.routePoints(cells, fx * SUB, fz * SUB, tx * SUB, tz * SUB);
    for (var i = 0; i < r.n; i++) {
      r.xs[i] /= SUB; r.zs[i] /= SUB; r.cum[i] /= SUB;
    }
    r.total /= SUB;
    return { route: r, fallback: false, points: r.n };
  }

  /* ------------------------------------------------------------ bodies */

  /* The frames the page draws (world.js's PARTS), and the creatures with
   * no frame of their own: the visitors and the pack's others take a
   * resident's, a little larger. */
  var FRAMES = { rabbit: 1, deer: 1, fox: 1, boar: 1, owl: 1, robin: 1,
                 tortoise: 1 };
  var BODY_OF = { stag: 'deer', wolf: 'fox', deer: 'deer' };
  var SCALE_OF = { stag: 1.15, wolf: 1.3 };
  /* How much ground each frame keeps to itself, in cells at scale 1: about
   * half its body's length, less the thin ends (a fox's brush, a deer's
   * muzzle) that may pass over a neighbour. */
  var RADIUS = { rabbit: 0.15, robin: 0.1, owl: 0.13, fox: 0.25,
                 boar: 0.3, deer: 0.32, tortoise: 0.2 };

  function frameOf(sp, shape) {
    var s = shape || sp;
    if (FRAMES[s]) return s;
    if (BODY_OF[s]) return BODY_OF[s];
    return 'fox';              // a creature with no frame of its own
  }

  /* A creature's frame, its scale and the radius it keeps clear. */
  function figure(st, sp) {
    var shapes = (st.biome && st.biome.shapes) || {};
    var frame = frameOf(sp, shapes[sp]);
    var scale = SCALE_OF[sp] || 1;
    return { frame: frame, scale: scale, r: RADIUS[frame] * scale };
  }

  /* Where every creature rests this week (`which` 'now', on x/y) or last
   * week ('prev', on px/py), by id. One alone in its cell takes its own
   * quarter, as it always has (`restSpot`). Two or more share the cell
   * out: packed round its middle (Walk.pack), the largest first and then
   * by id, each body clear of the rest, on open ground — never in the
   * water, never in a trunk's quarter (Walk.clearAt on the router's own
   * grid). Flyers hover in a layer of their own and are spread among
   * themselves. Pure: the same week puts everyone in the same place. */
  function restSpots(Walk, grid, st, taken, which) {
    var prev = which === 'prev';
    var N = Number(st.size) | 0;
    var fly = {};
    ((st.biome && st.biome.flyers) || []).forEach(function (sp) { fly[sp] = 1; });
    var groups = {}, keys = [], out = {};
    (st.animals || []).forEach(function (a) {
      var x = prev ? a.px : a.x, y = prev ? a.py : a.y;
      if (!(x >= 0 && y >= 0 && x < N && y < N)) return;
      var key = x + ',' + y + ',' + (fly[a.sp] ? 1 : 0);
      if (!groups[key]) { groups[key] = []; keys.push(key); }
      groups[key].push({ a: a, x: x, y: y, r: figure(st, a.sp).r,
                         fly: !!fly[a.sp] });
    });
    keys.forEach(function (key) {
      var g = groups[key];
      if (g.length === 1 || !Walk || !grid) {
        g.forEach(function (e) {
          out[e.a.id] = restSpot(e.a.id, e.x, e.y, st, taken);
        });
        return;
      }
      g.sort(function (p, q) { return (q.r - p.r) || (p.a.id - q.a.id); });
      var x = g[0].x, y = g[0].y;
      var c = st.cells[y * N + x];
      var water = c && c[0] === 'w';
      var rs = g.map(function (e) { return e.r; });
      var ok = g[0].fly ? null : function (k, px, pz) {
        var m = Math.min(rs[k], 0.2) * SUB;
        /* a cell that is all water: its creatures are where the engine put
         * them, so its own quarters are allowed, nothing beyond */
        if (water) {
          return Math.floor(px) === x && Math.floor(pz) === y;
        }
        return Walk.clearAt(grid, px * SUB, pz * SUB, m, -1);
      };
      var got = Walk.pack(rs, x + 0.5, y + 0.5,
                          { gap: 0.02, reach: 1.4, ok: ok, recentre: true });
      /* a creature with no clear place (`placed` 2: the least crowded open
       * point) still beats the cell's middle; with no open point at all it
       * takes its own quarter, as before */
      g.forEach(function (e, k) {
        out[e.a.id] = got.placed[k] ? { x: got.xs[k], z: got.zs[k] }
                                    : restSpot(e.a.id, e.x, e.y, st, taken);
      });
    });
    return out;
  }

  /* Creatures that leave one cell for the same other cell take the same
   * road, and two bodies cannot pass a trunk's gap side by side. So they
   * go in file: the one furthest along the way first (by where it rested
   * last week, `was` from restSpots; then by id), so nobody walks through
   * one still waiting its turn, each a tenth of the glide behind the one before
   * (closer when there are many), all at the same pace, so the gap holds
   * the whole way. By id: { lag, span }, fractions of the glide — when to
   * set off and how long the walk takes. A creature walking alone is not
   * in the map, and walks the whole glide as before. Ground walkers only:
   * the flyers have the air to themselves. */
  var FILE_STEP = 0.1, FILE_SPAN = 0.6;

  /* A trunk's foot is at most 0.125 of a cell across its radius (an old,
   * large tree); a body keeps that far from a trunk's middle, plus its own
   * half-width. In cells. */
  var TRUNK_KEEP = 0.13;

  /* The page's spacing for one frame: `Walk.separate` on F's n figures
   * (rx/rz their raw points, in cells; layer 0 the ground, 1 the air).
   * Every push on the ground must pass the guard: open ground round the
   * body (clearAt on the quartered grid, at its half-width when its raw
   * point was clear, else its centre at least), and clear of every trunk
   * near it, as a disk: TRUNK_KEEP plus the body's half-width from the
   * trunk's middle — a body whose raw point is already nearer than that
   * is never moved nearer. A flyer is kept over the map. One place for
   * the page and the checks. */
  var SP = { Walk: null, grid: null, F: null, N: 0, m: [], home: [],
             t0: [], t1: [], T: [] };
  function spaceOk(k, x, z) {
    if (SP.F.layer[k] === 1) {
      return x >= 0 && z >= 0 && x <= SP.N && z <= SP.N;
    }
    var T = SP.T;
    for (var i = SP.t0[k]; i < SP.t1[k]; i += 3) {
      var dx = x - T[i], dz = z - T[i + 1];
      if (dx * dx + dz * dz < T[i + 2] * T[i + 2]) return false;
    }
    return SP.Walk.clearAt(SP.grid, x * SUB, z * SUB, SP.m[k], SP.home[k]);
  }
  /* a push moves a body at most half a cell; the trunks that could then
   * touch it are within two quarters of its raw quarter */
  var NEAR = 2;
  function space(Walk, grid, F, n, N) {
    for (var k = n; k < F.layer.length; k++) F.layer[k] = -1;
    SP.Walk = Walk; SP.grid = grid; SP.F = F; SP.N = N;
    var T = SP.T, t = 0;
    for (k = 0; k < n; k++) {
      SP.t0[k] = SP.t1[k] = t;
      /* a flyer hovering just past the edge comes back over the map */
      if (F.layer[k] === 1) {
        F.rx[k] = Math.max(0, Math.min(N, F.rx[k]));
        F.rz[k] = Math.max(0, Math.min(N, F.rz[k]));
        continue;
      }
      if (!grid) continue;
      var gx = F.rx[k] * SUB, gz = F.rz[k] * SUB;
      var hx = Math.floor(gx), hz = Math.floor(gz);
      var home = hz * grid.W + hx;
      var rc = Math.min(F.r[k], 0.2);
      var r = rc * SUB;
      SP.m[k] = Walk.clearAt(grid, gx, gz, r, home) ? r : 0;
      SP.home[k] = home;
      for (var sz = hz - NEAR; sz <= hz + NEAR; sz++) {
        if (sz < 0 || sz >= grid.H) continue;
        for (var sx = hx - NEAR; sx <= hx + NEAR; sx++) {
          if (sx < 0 || sx >= grid.W || !grid.solid[sz * grid.W + sx]) continue;
          var cx = (sx + 0.5) / SUB, cz = (sz + 0.5) / SUB;
          var d = Math.sqrt((F.rx[k] - cx) * (F.rx[k] - cx) +
                            (F.rz[k] - cz) * (F.rz[k] - cz));
          T[t++] = cx; T[t++] = cz; T[t++] = Math.min(TRUNK_KEEP + rc, d);
        }
      }
      SP.t1[k] = t;
    }
    return Walk.separate(F, n, { iters: 8, pad: 0.04, maxOff: 0.5,
                                 ok: grid ? spaceOk : null });
  }
  function stagger(st, was) {
    var fly = {};
    ((st.biome && st.biome.flyers) || []).forEach(function (sp) { fly[sp] = 1; });
    var groups = {}, keys = [], out = {};
    (st.animals || []).forEach(function (a) {
      if (fly[a.sp] || !(a.px >= 0 && a.py >= 0)) return;
      if (a.px === a.x && a.py === a.y) return;
      var key = a.px + ',' + a.py + '>' + a.x + ',' + a.y;
      if (!groups[key]) { groups[key] = []; keys.push(key); }
      var w = was && was[a.id];
      var ahead = w ? (w.x - a.px - 0.5) * (a.x - a.px) +
                      (w.z - a.py - 0.5) * (a.y - a.py) : 0;
      groups[key].push({ id: a.id, ahead: ahead });
    });
    keys.forEach(function (key) {
      var ids = groups[key];
      if (ids.length < 2) return;
      ids.sort(function (p, q) {
        return (q.ahead - p.ahead) || (p.id - q.id);
      });
      var step = Math.min(FILE_STEP, (1 - FILE_SPAN) / (ids.length - 1));
      ids.forEach(function (e, k) {
        out[e.id] = { lag: k * step, span: FILE_SPAN };
      });
    });
    return out;
  }

  var api = {
    SUB: SUB, QX: QX, QZ: QZ, WALK: WALK, STANDING: STANDING,
    hash: hash, subGround: subGround, trunks: trunks, restSpot: restSpot,
    route: route, kindOf: kindOf,
    frameOf: frameOf, figure: figure, restSpots: restSpots, stagger: stagger,
    space: space, TRUNK_KEEP: TRUNK_KEEP,
    RADIUS: RADIUS, BODY_OF: BODY_OF, SCALE_OF: SCALE_OF,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.GroveForest = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
