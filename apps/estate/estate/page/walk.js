/* walk — the route a resident takes across the plan.
 *
 * The engine walks its people cell by cell, around walls, and then saves only
 * where each of them ended the day. The pages used to draw that as a straight
 * glide from one cell to the next, which sent everybody through the blocks.
 * This is the missing half: the same ground, read the same way, searched
 * rather than slid across.
 *
 * It is one file for both viewers. The plan page inlines it and the 3D page
 * loads it as a classic script before its module, so there is one search and
 * one set of costs — a second copy in the other renderer would drift from
 * this one the first time either was touched (grove b2/b34).
 *
 * The ground is /api/ground: `rows` names a site per cell, `codes` names the
 * sites, and `walk` is the pack's own step cost (or null where nobody may
 * walk). That last field is shipped by the server rather than written here:
 * the price of a lawn is the pack's fact, and a page that guessed it would be
 * the second home for it.
 *
 * `EstateWalk` is a plain global, deliberately: the plan page is classic
 * scripts and the 3D page is modules, and a plain global is the one shape
 * both can read without a build step.
 */
(function (root) {
  'use strict';

  /* Things a walker goes around. A tree, a lamp standard, a table, the
   * playground's frame and the shop's stall are solids on the ground. A
   * bench is not: it is a seat, and a resident's destination is its own
   * cell, so the route ends on it rather than stopping beside it.
   *
   * The engine's own passability is only the ground (it has no fixtures in
   * its walk); these are the renderer's solids, and every one of them is
   * still enterable as a route's *endpoint* — a destination is where you
   * were going, not an obstacle on the way. */
  var SOLID = { tree: 1, lamp: 1, table: 1, playground: 1, shop: 1 };

  /* A walk is searched to at most this many nodes per route. The plans are
   * a few hundred cells; the cap is a backstop against a pathological grid,
   * not a description of the estate. A route that hits it falls back to a
   * straight line rather than stalling the frame. */
  var MAX_EXPANSIONS = 6000;

  /* A person's pace in cells per second when the tick gives them room. A
   * route is never allowed to outlast the tick that sent it: the duration is
   * capped below, so a long walk speeds up enough to arrive before the next
   * state arrives. */
  var WALK_CPS = 4.0;

  function buildGrid(ground) {
    var W = ground.width | 0, H = ground.height | 0;
    var n = W * H;
    var walkMap = ground.walk || {};
    var hasWalk = false;
    for (var k in walkMap) { hasWalk = true; break; }
    var base = new Uint8Array(n);
    var cost = new Float32Array(n);
    var minCost = Infinity;
    for (var y = 0; y < H; y++) {
      var row = ground.rows[y];
      for (var x = 0; x < W; x++) {
        var code = ground.codes[row[x]];
        var i = y * W + x;
        var c;
        if (hasWalk) {
          c = Object.prototype.hasOwnProperty.call(walkMap, code)
            ? walkMap[code] : 1.0;
        } else {
          /* a server too old to ship the pack's costs: still refuse water
           * and walls, but there is no honest price to invent */
          c = (code === 'water' || code === 'building') ? null : 1.0;
        }
        if (c === null || c === undefined || c <= 0) {
          base[i] = 0;
          cost[i] = 1.0;
        } else {
          base[i] = 1;
          cost[i] = c;
          if (c < minCost) minCost = c;
        }
      }
    }
    if (!isFinite(minCost) || minCost <= 0) minCost = 1.0;
    var heapSize = Math.max(256, n * 8);
    return {
      W: W, H: H, n: n,
      base: base, cost: cost, minCost: minCost,
      solid: new Uint8Array(n), fixturesKey: null,
      cache: new Map(), cacheLimit: 512,
      gScore: new Float32Array(n), came: new Int32Array(n),
      stamp: new Int32Array(n), closed: new Int32Array(n), call: 0,
      heap: new Int32Array(heapSize), heapF: new Float32Array(heapSize),
      heapN: 0,
    };
  }

  /* Fixtures arrive with the day rather than with the ground. Their cells
   * are static, so this is paid once; a changed list (a fallen tree) clears
   * the cached routes that may have crossed it. */
  function setFixtures(g, fixtures) {
    if (!g) return;
    var key = '';
    for (var i = 0; i < fixtures.length; i++) {
      key += fixtures[i].id + ':' + fixtures[i].kind + ',';
    }
    if (key === g.fixturesKey) return;
    g.fixturesKey = key;
    g.solid.fill(0);
    for (var j = 0; j < fixtures.length; j++) {
      var f = fixtures[j];
      if (SOLID[f.kind] && f.x >= 0 && f.y >= 0 &&
          f.x < g.W && f.y < g.H) {
        g.solid[f.y * g.W + f.x] = 1;
      }
    }
    g.cache.clear();
  }

  /* May a walker stand on this cell? A solid fixture blocks it — except at
   * the route's own start and end, because those are where the walker
   * already is and where they meant to go. */
  function openAt(g, x, y, sx, sy, gx, gy) {
    if (x < 0 || y < 0 || x >= g.W || y >= g.H) return false;
    var i = y * g.W + x;
    if (!g.base[i]) return false;
    if (g.solid[i] && !((x === sx && y === sy) || (x === gx && y === gy))) {
      return false;
    }
    return true;
  }

  /* ----------------------------------------------------------- the heap */

  function heapPush(g, node, f) {
    if (g.heapN >= g.heap.length) return false;
    var h = g.heap, hf = g.heapF, i = g.heapN++;
    h[i] = node;
    hf[i] = f;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (hf[p] <= hf[i]) break;
      var tn = h[p], tf = hf[p];
      h[p] = h[i]; hf[p] = hf[i];
      h[i] = tn; hf[i] = tf;
      i = p;
    }
    return true;
  }

  function heapPop(g) {
    var h = g.heap, hf = g.heapF;
    var top = h[0];
    var last = --g.heapN;
    if (last > 0) {
      h[0] = h[last];
      hf[0] = hf[last];
      var i = 0;
      for (;;) {
        var l = i * 2 + 1, r = l + 1, small = i;
        if (l < last && hf[l] < hf[small]) small = l;
        if (r < last && hf[r] < hf[small]) small = r;
        if (small === i) break;
        var tn = h[i], tf = hf[i];
        h[i] = h[small]; hf[i] = hf[small];
        h[small] = tn; hf[small] = tf;
        i = small;
      }
    }
    return top;
  }

  /* ------------------------------------------------------ line of sight */
  /* A supercover traversal of the cells a segment crosses. When the segment
   * passes exactly through a corner, both side cells are required to be
   * open: a walker does not squeeze between two solids. */
  function losClear(g, ax, ay, bx, by, sx, sy, gx, gy) {
    var x = ax, y = ay;
    if (!openAt(g, x, y, sx, sy, gx, gy)) return false;
    if (x === bx && y === by) return true;
    var dx = bx - ax, dy = by - ay;
    var stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    var stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    var adx = Math.abs(dx), ady = Math.abs(dy);
    var tdx = adx ? 1 / adx : Infinity;
    var tdy = ady ? 1 / ady : Infinity;
    var tmx = adx ? 0.5 / adx : Infinity;
    var tmy = ady ? 0.5 / ady : Infinity;
    var guard = adx + ady + 4;
    while ((x !== bx || y !== by) && guard-- > 0) {
      if (tmx < tmy - 1e-9) {
        x += stepX; tmx += tdx;
      } else if (tmy < tmx - 1e-9) {
        y += stepY; tmy += tdy;
      } else {
        if (!openAt(g, x + stepX, y, sx, sy, gx, gy)) return false;
        if (!openAt(g, x, y + stepY, sx, sy, gx, gy)) return false;
        x += stepX; y += stepY; tmx += tdx; tmy += tdy;
      }
      if (!openAt(g, x, y, sx, sy, gx, gy)) return false;
    }
    return x === bx && y === by;
  }

  /* ------------------------------------------------------------- search */

  function search(g, sx, sy, gx, gy) {
    var W = g.W, n = g.n;
    var call = ++g.call;
    if (call > 2000000000) {           // a very long-lived page
      g.stamp.fill(0);
      g.closed.fill(0);
      g.call = 1;
      call = 1;
    }
    var start = sy * W + sx, goal = gy * W + gx;
    g.gScore[start] = 0;
    g.came[start] = -1;
    g.stamp[start] = call;
    g.heapN = 0;
    var h0 = (Math.abs(gx - sx) + Math.abs(gy - sy)) * g.minCost;
    heapPush(g, start, h0);

    var expansions = 0, found = false;
    while (g.heapN > 0) {
      var node = heapPop(g);
      if (g.closed[node] === call) continue;
      g.closed[node] = call;
      if (node === goal) { found = true; break; }
      if (++expansions > MAX_EXPANSIONS) break;
      var x = node % W, y = (node - x) / W;
      var gs = g.gScore[node];
      /* four ways, as the engine walks: a step is onto a cell, never
       * through the corner between two */
      for (var d = 0; d < 4; d++) {
        var nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
        var ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (!openAt(g, nx, ny, sx, sy, gx, gy)) continue;
        var ni = ny * W + nx;
        if (g.closed[ni] === call) continue;
        var ng = gs + g.cost[ni];
        if (g.stamp[ni] !== call || ng < g.gScore[ni]) {
          g.stamp[ni] = call;
          g.gScore[ni] = ng;
          g.came[ni] = node;
          var h = (Math.abs(gx - nx) + Math.abs(gy - ny)) * g.minCost;
          if (!heapPush(g, ni, ng + h)) break;
        }
      }
    }
    if (!found) return null;

    /* goal back to start, then forward */
    var back = [];
    var cur = goal;
    while (cur !== -1) {
      back.push(cur);
      cur = g.came[cur];
    }
    var path = [];
    for (var i = back.length - 1; i >= 0; i--) {
      var p = back[i];
      path.push(p % W, (p - p % W) / W);
    }
    return pull(g, path, sx, sy, gx, gy);
  }

  /* String-pulling: keep only the corners a straight line can actually
   * reach. This is what turns a staircase of cell steps into a walk, and the
   * line-of-sight test is what keeps it from cutting through a block. */
  function pull(g, path, sx, sy, gx, gy) {
    var m = path.length / 2;
    var out = [sx, sy];
    var cx = sx, cy = sy, at = 1;
    while (at < m) {
      var far = m - 1;
      while (far > at &&
             !losClear(g, cx, cy, path[far * 2], path[far * 2 + 1],
                       sx, sy, gx, gy)) {
        far--;
      }
      cx = path[far * 2];
      cy = path[far * 2 + 1];
      out.push(cx, cy);
      at = far + 1;
    }
    return out;
  }

  /* A route from one cell to another, as flat [x,y,x,y,…] corner cells.
   * Cached from→to, because the same two cells are asked for again and
   * again across a day and the grid never moves. */
  function findPath(g, sx, sy, gx, gy) {
    if (!g) return null;
    if (!openAt(g, sx, sy, sx, sy, gx, gy) ||
        !openAt(g, gx, gy, sx, sy, gx, gy)) {
      return null;
    }
    if (sx === gx && sy === gy) return [sx, sy];
    var key = sx + ',' + sy + '>' + gx + ',' + gy;
    if (g.cache.has(key)) return g.cache.get(key);
    var out = search(g, sx, sy, gx, gy);
    if (g.cache.size >= g.cacheLimit) g.cache.clear();
    g.cache.set(key, out);
    return out;
  }

  /* --------------------------------------------------------- the points */

  function cumulative(xs, zs) {
    var n = xs.length;
    var cum = new Float64Array(n);
    var total = 0;
    for (var i = 1; i < n; i++) {
      total += Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
      cum[i] = total;
    }
    return { xs: new Float64Array(xs), zs: new Float64Array(zs),
             cum: cum, n: n, total: total };
  }

  /* Cell corners to a walkable polyline: exact start and end, cell centres
   * between, and each corner cut back a little so the turn is rounded
   * rather than a right angle. The cut points stay inside the corner cell,
   * which is walkable by construction, so rounding can never clip a block. */
  function routePoints(cells, fromX, fromZ, toX, toZ) {
    var m = cells.length / 2;
    if (m <= 1) return cumulative([fromX, toX], [fromZ, toZ]);
    var xs = [], zs = [], i;
    for (i = 0; i < m; i++) {
      xs.push(cells[i * 2] + 0.5);
      zs.push(cells[i * 2 + 1] + 0.5);
    }
    xs[0] = fromX; zs[0] = fromZ;
    xs[m - 1] = toX; zs[m - 1] = toZ;

    var ox = [xs[0]], oz = [zs[0]];
    for (i = 1; i < m - 1; i++) {
      var ax = xs[i - 1], az = zs[i - 1];
      var bx = xs[i], bz = zs[i];
      var cx = xs[i + 1], cz = zs[i + 1];
      var abx = bx - ax, abz = bz - az;
      var bcx = cx - bx, bcz = cz - bz;
      var ab = Math.hypot(abx, abz), bc = Math.hypot(bcx, bcz);
      var cross = abx * bcz - abz * bcx;
      if (ab < 1e-6 || bc < 1e-6 || Math.abs(cross) < 1e-6 * ab * bc) {
        ox.push(bx); oz.push(bz);
        continue;
      }
      var d = Math.min(0.45, 0.45 * ab, 0.45 * bc);
      ox.push(bx + (ax - bx) * (d / ab), bx + (cx - bx) * (d / bc));
      oz.push(bz + (az - bz) * (d / ab), bz + (cz - bz) * (d / bc));
    }
    ox.push(xs[m - 1]); oz.push(zs[m - 1]);
    return cumulative(ox, oz);
  }

  /* The fallback a route may never need: two points, no search. */
  function straight(fromX, fromZ, toX, toZ) {
    return cumulative([fromX, toX], [fromZ, toZ]);
  }

  /* How long the walk should take. Short routes use the walking pace;
   * long ones are compressed until they arrive before the next state, which
   * is the promise the old glide made and this must keep. */
  function duration(total, tickMs) {
    if (total <= 1e-4) return 0;
    var walkMs = total / WALK_CPS * 1000;
    var cap = Math.max(120, (tickMs || 6000) * 0.9);
    return Math.max(60, Math.min(walkMs, cap));
  }

  /* Where along a route, at distance t. Writes into `out` — the renderers
   * call this once per person per frame, and a fresh vector per call would
   * be exactly the per-frame allocation the hot loop must not make. */
  function sample(route, t, out) {
    var n = route.n;
    if (route.total <= 1e-6) {
      out.x = route.xs[n - 1]; out.z = route.zs[n - 1];
      out.dx = 0; out.dz = 0; out.moving = false;
      return out;
    }
    if (t < 0) t = 0;
    if (t > route.total) t = route.total;
    var lo = 0, hi = n - 1;
    while (lo + 1 < hi) {
      var mid = (lo + hi) >> 1;
      if (route.cum[mid] <= t) lo = mid; else hi = mid;
    }
    var seg = route.cum[hi] - route.cum[lo];
    var f = seg > 1e-9 ? (t - route.cum[lo]) / seg : 0;
    out.x = route.xs[lo] + (route.xs[hi] - route.xs[lo]) * f;
    out.z = route.zs[lo] + (route.zs[hi] - route.zs[lo]) * f;
    out.dx = route.xs[hi] - route.xs[lo];
    out.dz = route.zs[hi] - route.zs[lo];
    out.moving = t < route.total;
    return out;
  }

  root.EstateWalk = {
    buildGrid: buildGrid,
    setFixtures: setFixtures,
    findPath: findPath,
    routePoints: routePoints,
    straight: straight,
    duration: duration,
    sample: sample,
    WALK_CPS: WALK_CPS,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
