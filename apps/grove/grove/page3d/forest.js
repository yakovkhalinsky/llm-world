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

  /* ------------------------------------------------------- what is drawn
   * The engine grows a forest you could not see into from above: a tree,
   * a sapling and three ferns in a cell, in every cell. The page draws a
   * thinned forest instead (the sim keeps every plant):
   *  - paths: from each ford, four cells out either side, square to the
   *    creek; nothing grows on them but the ferns at their edge and logs;
   *  - clearings: a few 3×3 glades, by a hash of the cell and the world,
   *    five cells apart, holding logs and a fern or two (at least one
   *    wherever a cell two in from the edge is open land);
   *  - banks (land beside water): only weeping trees stand there, so the
   *    water can be seen;
   *  - elsewhere at most one standing tree in a cell (the old one first,
   *    then by id), a fifth of the old ones and a third of the mature ones
   *    dropped by hash, a third of the saplings, never under a standing
   *    tree, and at most one fern a cell (two in three of them).
   * A named plant is always drawn. Pure: the same snapshot
   * draws the same forest, and `trunks` routes round exactly what is
   * drawn. */
  var CLEAR_EVERY = 90;      // about one glade per this many cells
  function cellAt(st, x, y) {
    var N = Number(st.size) | 0;
    if (x < 0 || y < 0 || x >= N || y >= N) return null;
    return st.cells[y * N + x] || null;
  }
  function isWater(st, x, y) {
    var c = cellAt(st, x, y);
    return !!c && c[0] === 'w';
  }
  function zones(st) {
    var N = Number(st.size) | 0;
    var bank = {}, path = {}, clear = {}, centres = [];
    var x, y, k;
    for (y = 0; y < N; y++) {
      for (x = 0; x < N; x++) {
        if (isWater(st, x, y)) continue;
        /* four ways: a willow stands where the bank faces the water. The
         * sim's shore (animals.py shore_cells) is eight ways, so a creature
         * can drink at a corner of the water with no bank willow by it */
        if (isWater(st, x + 1, y) || isWater(st, x - 1, y) ||
            isWater(st, x, y + 1) || isWater(st, x, y - 1)) {
          bank[x + ',' + y] = 1;
        }
      }
    }
    for (y = 0; y < N; y++) {
      for (x = 0; x < N; x++) {
        var c = cellAt(st, x, y);
        if (!c || c[6] !== 'f') continue;
        path[x + ',' + y] = 1;
        /* the creek runs along x when its water is east and west of the
         * ford; the path then crosses along y, and the other way about */
        var along = isWater(st, x - 1, y) || isWater(st, x + 1, y);
        var dx = along ? 0 : 1, dy = along ? 1 : 0;
        [-1, 1].forEach(function (sgn) {
          for (k = 1; k <= 4; k++) {
            var px = x + dx * k * sgn, py = y + dy * k * sgn;
            var pc = cellAt(st, px, py);
            if (!pc || pc[0] === 'w') break;
            path[px + ',' + py] = 1;
          }
        });
      }
    }
    var seed = Number(st.seed) | 0;
    var most = Math.max(1, Math.floor(N * N / CLEAR_EVERY));
    function glade(x, y) {
      centres.push([x, y]);
      for (var cy = y - 1; cy <= y + 1; cy++) {
        for (var cx = x - 1; cx <= x + 1; cx++) {
          if (!isWater(st, cx, cy)) clear[cx + ',' + cy] = 1;
        }
      }
    }
    /* a small map may draw no glade by the hash: it then gets one, at the
     * open cell whose hash is lowest (none only when no cell is open) */
    var best = null, bestH = 0;
    for (y = 2; y < N - 2 && centres.length < most; y++) {
      for (x = 2; x < N - 2 && centres.length < most; x++) {
        if (isWater(st, x, y) || bank[x + ',' + y] || path[x + ',' + y]) continue;
        var h = hash(x * 977 + y * 131, 7001 + seed) % CLEAR_EVERY;
        if (!best || h < bestH) { best = [x, y]; bestH = h; }
        if (h > 2) continue;
        var near = centres.some(function (q) {
          return Math.max(Math.abs(q[0] - x), Math.abs(q[1] - y)) < 5;
        });
        if (near) continue;
        glade(x, y);
      }
    }
    if (!centres.length && best) glade(best[0], best[1]);
    return { bank: bank, path: path, clear: clear, centres: centres };
  }

  function shapeOf(st, sp) {
    var s = st.biome && st.biome.shapes;
    return (s && s[sp]) || '';
  }

  var DRAWN = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  /* By plant id, 1 for every plant the page draws; and the zones. */
  function drawn(st) {
    if (DRAWN && DRAWN.has(st)) return DRAWN.get(st);
    var Z = zones(st);
    var ids = {};
    var plants = (st.plants || []).slice().sort(function (a, b) {
      return a.id - b.id;
    });
    var standing = {}, ferns = {};
    var keep = function (p) { return !!p.n; };
    /* standing trees first: old before mature, then by id */
    plants.filter(function (p) {
      return STANDING[p.st] && kindOf(st, p.sp) === 'tree';
    }).sort(function (a, b) {
      return ((b.st === 'old') - (a.st === 'old')) || (a.id - b.id);
    }).forEach(function (p) {
      var key = p.x + ',' + p.y;
      if (!keep(p)) {
        if (Z.path[key] || Z.clear[key] || standing[key]) return;
        if (Z.bank[key] && shapeOf(st, p.sp) !== 'weeping') return;
        if (hash(p.id, 23) % (p.st === 'old' ? 5 : 3) === 0) return;
      }
      standing[key] = 1;
      ids[p.id] = 1;
    });
    unseal(st, ids);
    plants.forEach(function (p) {
      var key = p.x + ',' + p.y;
      var kind = kindOf(st, p.sp);
      if (ids[p.id]) return;
      if (keep(p) || p.st === 'log') { ids[p.id] = 1; return; }
      if (kind === 'tree') {
        if (STANDING[p.st]) return;
        if (Z.path[key] || Z.clear[key] || standing[key]) return;
        if (Z.bank[key] && shapeOf(st, p.sp) !== 'weeping') return;
        if (hash(p.id, 29) % 3 !== 0) return;
        ids[p.id] = 1;
      } else if (kind === 'understory') {
        if (Z.path[key] || ferns[key] || hash(p.id, 31) % 3 === 0) return;
        if (Z.clear[key] && hash(p.x * 31 + p.y, 37) % 2) return;
        ferns[key] = 1;
        ids[p.id] = 1;
      } else {
        if (Z.path[key]) return;
        ids[p.id] = 1;
      }
    });
    var out = { ids: ids, zones: Z };
    if (DRAWN) DRAWN.set(st, out);
    return out;
  }

  /* The plants world.js draws, in the order the server listed them: those
   * on the map that `drawn` keeps. The page builds its plant meshes from
   * this list and nothing else, so what is drawn and what stands for the
   * router (`trunks`) cannot drift apart. */
  function drawList(st) {
    var N = Number(st.size) | 0;
    var shown = drawn(st).ids;
    return (st.plants || []).filter(function (p) {
      return p.x >= 0 && p.y >= 0 && p.x < N && p.y < N && !!shown[p.id];
    });
  }

  /* ---------------------------------------------------- seeing through
   * Which trees stand between the camera and what it is looking at. Each
   * tree is a vertical capsule ({id, x, z, r, y0, top}, world units); each
   * target a point ({x, y, z}). A tree is in the way when the segment from
   * the camera to a target passes within its radius somewhere between its
   * foot and its top, not at the very ends (the target's own tree, the
   * camera brushing a twig). Returns the ids, sorted. Pure. */
  function occluders(trees, cam, targets, opts) {
    opts = opts || {};
    var t0 = opts.t0 == null ? 0.02 : opts.t0;
    var t1 = opts.t1 == null ? 0.94 : opts.t1;
    var hit = {};
    for (var j = 0; j < targets.length; j++) {
      var T = targets[j];
      var dx = T.x - cam.x, dy = T.y - cam.y, dz = T.z - cam.z;
      var L2 = dx * dx + dz * dz;
      for (var i = 0; i < trees.length; i++) {
        var tr = trees[i];
        if (hit[tr.id]) continue;
        /* the nearest approach in plan, then check the height there */
        var t = L2 > 1e-9 ? ((tr.x - cam.x) * dx + (tr.z - cam.z) * dz) / L2 : 0;
        if (t < t0 || t > t1) continue;
        var px = cam.x + dx * t - tr.x, pz = cam.z + dz * t - tr.z;
        var d2 = px * px + pz * pz;
        if (d2 > tr.r * tr.r) continue;
        /* along the chord through the disk the ray's height spans
         * y(t ± half-chord); it is in the way if that overlaps the tree */
        var half = L2 > 1e-9 ? Math.sqrt(tr.r * tr.r - d2) / Math.sqrt(L2) : 0;
        var ya = cam.y + dy * Math.max(0, t - half);
        var yb = cam.y + dy * Math.min(1, t + half);
        if (Math.min(ya, yb) <= tr.top && Math.max(ya, yb) >= tr.y0) {
          hit[tr.id] = 1;
        }
      }
    }
    return Object.keys(hit).map(Number).sort(function (a, b) { return a - b; });
  }

  /* The trunks must never wall land off from the router (walk.js: four
   * ways over the quarters, soil and rock open, water shut). Two trunks on
   * a diagonal across a one-cell neck can, so: place the trunks, flood the
   * quarters from the largest open piece, and while some land is cut off,
   * drop the unnamed tree whose trunk closes the gap (one touching both the
   * piece and the cut-off ground, else any touching the cut-off ground;
   * lowest id first) and look again. Named trees always stand. Edits `ids`
   * in place. */
  function unseal(st, ids) {
    var N = Number(st.size) | 0, G = N * SUB, n = G * G;
    var byId = {};
    (st.plants || []).forEach(function (p) { byId[p.id] = p; });
    var ground = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var gx = i % G, gy = (i - gx) / G;
      var c = st.cells[((gy / SUB) | 0) * N + ((gx / SUB) | 0)];
      ground[i] = c && c[0] === 'w' ? 0 : 1;
    }
    var nb = function (i, f) {
      var x = i % G, y = (i - x) / G;
      if (x > 0) f(i - 1);
      if (x < G - 1) f(i + 1);
      if (y > 0) f(i - G);
      if (y < G - 1) f(i + G);
    };
    for (var round = 0; round < 64; round++) {
      var fx = placeTrunks(st, ids).fixtures;
      var solid = new Int32Array(n);
      fx.forEach(function (f) { solid[f.y * G + f.x] = f.id + 1; });
      /* the open pieces, and the largest */
      var part = new Int32Array(n), sizes = [0], big = 0;
      for (var s0 = 0; s0 < n; s0++) {
        if (!ground[s0] || solid[s0] || part[s0]) continue;
        var id = sizes.length, todo = [s0], k = 0;
        part[s0] = id;
        while (todo.length) {
          nb(todo.pop(), function (j) {
            if (ground[j] && !solid[j] && !part[j]) { part[j] = id; todo.push(j); }
          });
          k++;
        }
        sizes.push(k);
        if (k > sizes[big]) big = id;
      }
      /* land cells with no quarter in the largest piece */
      var cut = false;
      for (var cy = 0; cy < N && !cut; cy++) {
        for (var cx = 0; cx < N && !cut; cx++) {
          var cc = st.cells[cy * N + cx];
          if (!cc || cc[0] === 'w') continue;
          var ok = false;
          for (var q = 0; q < SUB * SUB; q++) {
            if (part[(cy * SUB + (q / SUB | 0)) * G + cx * SUB + q % SUB] === big) ok = true;
          }
          if (!ok) cut = true;
        }
      }
      if (!cut) return;
      var both = [], any = [];
      fx.forEach(function (f) {
        var p = byId[f.id];
        if (!p || p.n) return;
        var inBig = false, outside = false;
        nb(f.y * G + f.x, function (j) {
          if (!ground[j] || solid[j]) return;
          if (part[j] === big) inBig = true; else outside = true;
        });
        if (outside) (inBig ? both : any).push(f.id);
      });
      var pick = (both.length ? both : any).sort(function (a, b) { return a - b; })[0];
      if (pick === undefined) return;     /* only named trees: they stand */
      delete ids[pick];
    }
  }

  /* Every standing tree takes one quarter of its cell for its trunk: the
   * one its id hashes to, or the next free one round the cell. The trees
   * are placed in id order, so who gets which quarter never depends on the
   * order the server listed them in. Returns the fixtures for the router
   * and, by plant id, where each trunk stands in world units. Only the
   * trees the page draws (`drawn`) stand: a creature never walks round a
   * tree that is not there. */
  function trunks(st) {
    return placeTrunks(st, drawn(st).ids);
  }

  function placeTrunks(st, shown) {
    var N = Number(st.size) | 0;
    var taken = {};
    var fixtures = [];
    var at = {};
    var trees = (st.plants || []).filter(function (p) {
      return STANDING[p.st] && kindOf(st, p.sp) === 'tree' && shown[p.id];
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
   * Every push on the ground must pass the guard (Walk's keep-outs): the
   * body, at its full half-width, clear of every water or off-map quarter
   * near its raw point other than the one it is in, and of every trunk
   * near it, as a disk: TRUNK_KEEP plus the body's half-width from the
   * trunk's middle. A body clear of something stays clear of it; one
   * already nearer than that (a walk's end in a trunk's quarter, a cell
   * that is all water) is never moved nearer. A flyer is kept over the
   * map. One place for the page and the checks. */
  var SP = { Walk: null, grid: null, F: null, N: 0, t0: [], t1: [], K: [],
             home: [] };
  function spaceOk(k, x, z) {
    if (SP.F.layer[k] === 1) {
      return x >= 0 && z >= 0 && x <= SP.N && z <= SP.N;
    }
    return SP.Walk.cellOpen(SP.grid, x * SUB, z * SUB, SP.home[k]) &&
      SP.Walk.keepClear(SP.K, SP.t0[k], SP.t1[k], x * SUB, z * SUB);
  }
  /* a push moves a body at most half a cell; the water and the trunks
   * that could then touch it are within two quarters of its raw quarter */
  var NEAR = 2;
  function space(Walk, grid, F, n, N) {
    for (var k = n; k < F.layer.length; k++) F.layer[k] = -1;
    SP.Walk = Walk; SP.grid = grid; SP.F = F; SP.N = N;
    var K = SP.K, t = 0;
    for (k = 0; k < n; k++) {
      SP.t0[k] = SP.t1[k] = t;
      /* a flyer hovering just past the edge comes back over the map */
      if (F.layer[k] === 1) {
        F.rx[k] = Math.max(0, Math.min(N, F.rx[k]));
        F.rz[k] = Math.max(0, Math.min(N, F.rz[k]));
        continue;
      }
      if (!grid) continue;
      /* in quarters */
      var gx = F.rx[k] * SUB, gz = F.rz[k] * SUB;
      var hx = Math.floor(gx), hz = Math.floor(gz);
      var home = hx >= 0 && hx < grid.W && hz >= 0 && hz < grid.H
        ? hz * grid.W + hx : -1;
      SP.home[k] = home;
      var r = Math.min(F.r[k], 0.2) * SUB;
      t = Walk.groundKeepOuts(grid, K, t, gx, gz, r, home, NEAR);
      for (var sz = hz - NEAR; sz <= hz + NEAR; sz++) {
        if (sz < 0 || sz >= grid.H) continue;
        for (var sx = hx - NEAR; sx <= hx + NEAR; sx++) {
          if (sx < 0 || sx >= grid.W || !grid.solid[sz * grid.W + sx]) continue;
          t = Walk.keepOut(K, t, Walk.KEEP_DISK, sx + 0.5, sz + 0.5, 0,
                           TRUNK_KEEP * SUB + r, gx, gz);
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

  /* An instanced mesh that grows, for the page (world.js makeBatch): a
   * forest gains and loses trees, so the capacity doubles when it must and
   * the count is set every rebuild. Past its capacity mid-build a batch
   * doubles and copies what it has (matrices and colours) into the new
   * mesh: nothing added is ever dropped. THREE is passed in, so the check
   * can hold this to that with a stub. */
  function batch(THREE, scene, geo, mat, cap, opts) {
    var b = { mesh: null, cap: 0, n: 0, owner: [] };
    var white = new THREE.Color(1, 1, 1);
    function alloc(c) {
      if (b.mesh) { scene.remove(b.mesh); b.mesh.dispose(); }
      b.cap = c;
      b.mesh = new THREE.InstancedMesh(geo, mat, c);
      b.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      b.mesh.castShadow = !(opts && opts.noShadow);
      b.mesh.receiveShadow = !!(opts && opts.receive);
      b.mesh.frustumCulled = false;
      b.mesh.count = 0;
      b.mesh.setColorAt(0, white);
      scene.add(b.mesh);
    }
    alloc(Math.max(8, cap));
    function grow() {
      var old = b.mesh, had = b.n;
      b.mesh = null;                  // alloc must not dispose it yet
      alloc(b.cap * 2);
      b.mesh.instanceMatrix.array.set(
        old.instanceMatrix.array.subarray(0, had * 16));
      if (old.instanceColor && b.mesh.instanceColor) {
        b.mesh.instanceColor.array.set(
          old.instanceColor.array.subarray(0, had * 3));
      }
      scene.remove(old);
      old.dispose();
    }
    b.begin = function (n) {
      if (n > b.cap) alloc(Math.max(n, b.cap * 2));
      b.n = 0;
      b.owner.length = 0;
    };
    b.add = function (matrix, colour, owner) {
      if (b.n >= b.cap) grow();
      b.mesh.setMatrixAt(b.n, matrix);
      b.mesh.setColorAt(b.n, colour);
      b.owner[b.n] = owner;
      b.n++;
    };
    b.end = function () {
      b.mesh.count = b.n;
      b.mesh.instanceMatrix.needsUpdate = true;
      if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
    };
    return b;
  }

  var api = {
    SUB: SUB, QX: QX, QZ: QZ, WALK: WALK, STANDING: STANDING,
    hash: hash, subGround: subGround, trunks: trunks, restSpot: restSpot,
    route: route, kindOf: kindOf,
    frameOf: frameOf, figure: figure, restSpots: restSpots, stagger: stagger,
    space: space, TRUNK_KEEP: TRUNK_KEEP,
    zones: zones, drawn: drawn, drawList: drawList, occluders: occluders, shapeOf: shapeOf,
    RADIUS: RADIUS, BODY_OF: BODY_OF, SCALE_OF: SCALE_OF, batch: batch,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.GroveForest = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
