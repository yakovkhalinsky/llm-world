/* walk — the route a walker takes across the plan.
 *
 * Shared by both 3D views (apps/shared/page3d/): Highfield's residents and
 * the grove's creatures are routed by this one search. Each app's server
 * serves this folder under its own `/3d/` after its own page3d/, so the
 * page names it as `/3d/walk.js` either way.
 *
 * The engine walks its people cell by cell, around walls, and then saves only
 * where each of them ended the day. The view used to draw that as a straight
 * glide from one cell to the next, which sent everybody through the blocks.
 * This is the missing half: the same ground, read the same way, searched
 * rather than slid across.
 *
 * The 3D page loads it as a classic script before its module, so there is
 * one search and one set of costs — a second copy inside the module would
 * drift from this one the first time either was touched (grove b2/b34).
 *
 * The ground is /api/ground: `rows` names a site per cell, `codes` names the
 * sites, and `walk` is the pack's own step cost (or null where nobody may
 * walk). That last field is shipped by the server rather than written here:
 * the price of a lawn is the pack's fact, and a page that guessed it would be
 * the second home for it.
 *
 * `EstateWalk` is a plain global, deliberately: the 3D page's router is a
 * classic script loaded ahead of its module, and a plain global is the one
 * shape both can read without a build step.
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
  var SOLID = { tree: 1, lamp: 1, table: 1, playground: 1, shop: 1,
                bus_stop: 1 };
  /* The list above is the estate's, and the default. Another world names
   * its own solids when it builds its grid (`buildGrid(ground, {solid:
   * {...}})`) — the grove's are its standing trunks — so the search has no
   * opinion about what a place is made of. */

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

  function buildGrid(ground, opts) {
    var solidKinds = (opts && opts.solid) || SOLID;
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
      solid: new Uint8Array(n), fixturesKey: null, solidKinds: solidKinds,
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
      if (g.solidKinds[f.kind] && f.x >= 0 && f.y >= 0 &&
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

  /* ------------------------------------------------------------ spacing
   *
   * Two figures never share a point. The sims put several walkers in one
   * cell on purpose (a playground holds a dozen children, a grove cell a
   * deer and three rabbits) and say nothing finer than the cell; where in
   * the cell each one stands is the renderer's choice. These pick it so
   * bodies do not stand inside each other, without touching the sims: they
   * are pure, deterministic functions of the positions they are given, so
   * the same frame of the same snapshot draws the same picture.
   *
   *   pack      places a group sharing a spot: each figure, in the order
   *             given, at the nearest point (on a fine hex lattice round the
   *             spot) that keeps its radius clear of those already placed
   *             and that the caller's `ok` accepts.
   *   separate  pushes apart, each frame, figures closer than the sum of
   *             their radii — walkers on one path, or a walker passing a
   *             group — and passes oncoming walkers side by side.
   *   clearAt   the guard both use: a point (and a ring of probes round it)
   *             on open ground, so spacing never stands anyone in a wall, a
   *             solid or the water, and never moves them across one. */

  /* Unit hex lattice, nearest the origin first; points within `reach`. */
  var LATTICE = null;
  var LATTICE_STEP = 0.04;
  function lattice() {
    if (LATTICE) return LATTICE;
    var pts = [];
    var reach = 2.2, rows = Math.ceil(reach / (LATTICE_STEP * 0.866));
    for (var j = -rows; j <= rows; j++) {
      var zz = j * LATTICE_STEP * 0.8660254;
      var shift = (j & 1) ? LATTICE_STEP / 2 : 0;
      var cols = Math.ceil(reach / LATTICE_STEP) + 1;
      for (var i = -cols; i <= cols; i++) {
        var xx = i * LATTICE_STEP + shift;
        var d = Math.hypot(xx, zz);
        if (d <= reach) pts.push([xx, zz, d, Math.atan2(zz, xx)]);
      }
    }
    pts.sort(function (a, b) { return (a[2] - b[2]) || (a[3] - b[3]); });
    LATTICE = pts;
    return pts;
  }

  /* `rs[k]` is figure k's radius; returns { xs, zs, placed }.
   * `opts.gap` is the extra room between two bodies; `opts.ok(k, x, z)`
   * vets a point (the same order as `separate`'s); `opts.fixed` lists
   * bodies already standing there ({x, z, r}) to keep clear of too;
   * `opts.recentre` shifts the packed group so its middle is the spot,
   * when every point still passes.
   *
   * `placed[k]` is 1 for a figure with a clear place of its own. When the
   * crowd is bigger than the room, a figure no clear point is left for is
   * not left on the spot (which may be a lamp post or a table): it takes
   * the point `ok` accepts that is least crowded — the one whose nearest
   * body is furthest off — and `placed[k]` is 2; `separate` does the rest.
   * Only when `ok` accepts nothing at all within `reach` is it left on the
   * spot, with `placed[k]` false. */
  function pack(rs, cx, cz, opts) {
    opts = opts || {};
    var gap = opts.gap || 0, ok = opts.ok || null;
    var reach = opts.reach || 2.2;
    var fixed = opts.fixed || [];
    var L = lattice();
    var n = rs.length;
    var xs = new Array(n), zs = new Array(n), placed = new Array(n);
    for (var k = 0; k < n; k++) {
      xs[k] = cx; zs[k] = cz; placed[k] = false;
      var best = -Infinity, bx = cx, bz = cz;
      for (var c = 0; c < L.length; c++) {
        if (L[c][2] > reach) break;
        var x = cx + L[c][0], z = cz + L[c][1];
        /* the tightest fit here: the smallest room left to any body */
        var room = Infinity;
        for (var q = 0; q < k + fixed.length; q++) {
          var ox, oz, orr;
          if (q < k) {
            if (!placed[q]) continue;
            ox = xs[q]; oz = zs[q]; orr = rs[q];
          } else {
            var f = fixed[q - k];
            ox = f.x; oz = f.z; orr = f.r;
          }
          var dx = x - ox, dz = z - oz;
          var rm = Math.sqrt(dx * dx + dz * dz) - (rs[k] + orr + gap);
          if (rm < room) room = rm;
          if (room < 0 && room <= best) break;   // no better than the best
        }
        if (room < 0 && room <= best) continue;
        if (ok && !ok(k, x, z)) continue;
        if (room >= 0) { bx = x; bz = z; best = room; break; }
        best = room; bx = x; bz = z;
      }
      if (best > -Infinity) {
        xs[k] = bx; zs[k] = bz; placed[k] = best >= 0 ? 1 : 2;
      }
    }
    if (opts.recentre && n > 1) {
      var mx = 0, mz = 0, m = 0;
      for (k = 0; k < n; k++) if (placed[k]) { mx += xs[k]; mz += zs[k]; m++; }
      if (m > 1) {
        var sx = cx - mx / m, sz = cz - mz / m, all = true;
        for (k = 0; k < n && all; k++) {
          if (placed[k] && ok && !ok(k, xs[k] + sx, zs[k] + sz)) all = false;
        }
        if (all) {
          for (k = 0; k < n; k++) if (placed[k]) { xs[k] += sx; zs[k] += sz; }
        }
      }
    }
    return { xs: xs, zs: zs, placed: placed };
  }

  /* Is (gx, gz), in grid units, clear ground for a body of half-width m?
   * The point and eight probes round it must each be on a walkable cell
   * with no solid in it — or on `home`, the cell the figure's own route
   * puts it in (a door, a fixture it is using, a cell that is all water),
   * which it may stand in. But a solid in its own cell is still a body:
   * with `keep` > 0 the point must also be at least `keep` + m from the
   * middle of a solid home cell (a box distance — the fixture's half-size
   * plus the body's), so nobody stands in a lamp post or a tree. */
  var PROBE = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
               [0.7071, 0.7071], [-0.7071, 0.7071],
               [0.7071, -0.7071], [-0.7071, -0.7071]];
  function clearAt(g, gx, gz, m, home, keep) {
    var cx, cz, i;
    if (keep > 0 && home >= 0 && g.solid[home]) {
      var hx = home % g.W, hz = (home - hx) / g.W;
      if (Math.max(Math.abs(gx - hx - 0.5), Math.abs(gz - hz - 0.5)) <
          keep + m) {
        return false;
      }
    }
    for (var k = 0; k < PROBE.length; k++) {
      var px = gx + PROBE[k][0] * m, pz = gz + PROBE[k][1] * m;
      cx = Math.floor(px); cz = Math.floor(pz);
      if (cx < 0 || cz < 0 || cx >= g.W || cz >= g.H) return false;
      i = cz * g.W + cx;
      if (i === home) continue;
      if (!g.base[i] || g.solid[i]) return false;
    }
    /* the probes can pass either side of a blocked cell's corner (water
     * touching only diagonally): any blocked cell nearer than m, as a box */
    for (cz = Math.floor(gz - m); cz <= Math.floor(gz + m); cz++) {
      for (cx = Math.floor(gx - m); cx <= Math.floor(gx + m); cx++) {
        if (cx < 0 || cz < 0 || cx >= g.W || cz >= g.H) continue;
        i = cz * g.W + cx;
        if (i === home || (g.base[i] && !g.solid[i])) continue;
        var ex = Math.max(cx - gx, 0, gx - cx - 1);
        var ez = Math.max(cz - gz, 0, gz - cz - 1);
        if (ex * ex + ez * ez < m * m) return false;
      }
    }
    return true;
  }

  /* Keep-outs: the per-frame push's guard as shapes, for `separate`'s
   * `ok`. A body is checked against every wall, water cell and fixture
   * near its raw point (the point its walk has it at this frame) at its
   * full half-width — not just its centre once it touches something, and
   * not only against the cell its centre happens to be in. Each keep-out
   * is a box (`h` its half-size about cx, cz; KEEP_BOX) or a disk (`h` its
   * radius; KEEP_DISK) and `need`, how far the body's centre must stay
   * from its edge: the body's half-width (with any margin the caller
   * adds) — or, when its raw point is already nearer than that, no nearer
   * than its raw point. So a push may slide a body along a wall it grazes,
   * or away from a pole it stands too close to, but can never take it
   * further into a wall, the water or a fixture than its walk had it.
   * Five numbers each in a flat array the caller reuses: no allocation in
   * the frame. */
  var KEEP_BOX = 0, KEEP_DISK = 1;
  /* signed distance from (x, z) to a keep-out's edge (negative inside) */
  function edgeDist(type, cx, cz, h, x, z) {
    var dx = Math.abs(x - cx), dz = Math.abs(z - cz);
    if (type === KEEP_DISK) return Math.sqrt(dx * dx + dz * dz) - h;
    var ex = dx - h, ez = dz - h;
    if (ex <= 0 && ez <= 0) return Math.max(ex, ez);
    var ox = ex > 0 ? ex : 0, oz = ez > 0 ? ez : 0;
    return Math.sqrt(ox * ox + oz * oz);
  }
  /* add one keep-out at K[t..t+4] for a body whose raw point is (rx, rz);
   * returns the next free index */
  function keepOut(K, t, type, cx, cz, h, need, rx, rz) {
    K[t] = type; K[t + 1] = cx; K[t + 2] = cz; K[t + 3] = h;
    K[t + 4] = Math.min(need, edgeDist(type, cx, cz, h, rx, rz));
    return t + 5;
  }
  /* the ground's keep-outs round raw point (gx, gz), in grid units: every
   * cell within `near` of the cell it is in that is off the grid or not
   * walkable, a whole-cell box, other than `home` (the cell its walk has it
   * in: a door, a cell that is all water). Solid fixtures are the
   * caller's: it knows their shapes. */
  function groundKeepOuts(g, K, t, gx, gz, m, home, near) {
    var hx = Math.floor(gx), hz = Math.floor(gz);
    for (var z = hz - near; z <= hz + near; z++) {
      for (var x = hx - near; x <= hx + near; x++) {
        var off = x < 0 || z < 0 || x >= g.W || z >= g.H;
        var i = z * g.W + x;
        if (!off && (i === home || g.base[i])) continue;
        t = keepOut(K, t, KEEP_BOX, x + 0.5, z + 0.5, 0.5, m, gx, gz);
      }
    }
    return t;
  }
  /* is (x, z)'s own cell open ground on the grid, or `home`? (the
   * keep-outs' edges, exactly: a body whose raw point is on a cell's edge
   * may be kept no further than the edge, and rounding must not then put
   * its centre over it) */
  function cellOpen(g, x, z, home) {
    var cx = Math.floor(x), cz = Math.floor(z);
    if (cx < 0 || cz < 0 || cx >= g.W || cz >= g.H) return false;
    var i = cz * g.W + cx;
    return i === home || !!g.base[i];
  }
  /* is (x, z) clear of the keep-outs K[t0..t1)? */
  function keepClear(K, t0, t1, x, z) {
    for (var i = t0; i < t1; i += 5) {
      if (edgeDist(K[i], K[i + 1], K[i + 2], K[i + 3], x, z) < K[i + 4]) {
        return false;
      }
    }
    return true;
  }

  /* A route's first or last leg may end beside a pole or a trunk on the
   * far side of it (a walk to a lamp's slot, or away from one): the
   * router ends a route on the slot itself, so the leg from the next cell
   * runs straight through the fixture. `around` bends every leg of the
   * route that passes nearer than `rho` to (cx, cz) round it instead:
   * along the tangent, an arc the shorter way round, and the tangent off
   * again, each chord short enough to stay `rho` clear. Legs that start
   * or end inside `rho` are left alone (the router put them there).
   *
   * With `grid` (and `m`, the body's half-width) a bend is never deeper
   * into a wall, the water or off the map than the plain leg was: a
   * tangent from far off can cut a building's corner the straight leg
   * cleared. Then it tries the other way round; then the plain leg as far
   * as the pole, the arc, and the plain leg on (the arc hugs the pole, so
   * it stays on its cell); and if even that goes deeper, the leg is left
   * as it was. The leg's own two cells (a door, the fixture's cell) don't
   * count. Pure; returns the route itself when nothing needs bending. */
  var ARC_STEP = Math.PI / 6;
  function segDist(ax, az, bx, bz, cx, cz) {
    var vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz;
    var t = l2 > 1e-12 ? ((cx - ax) * vx + (cz - az) * vz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(ax + vx * t - cx, az + vz * t - cz);
  }
  function segBoxDist(ax, az, bx, bz, x0, z0, x1, z1) {
    /* a segment and a box in 2D: touching, or nearest at an end of the
     * segment or a corner of the box */
    var t0 = 0, t1 = 1, dx = bx - ax, dz = bz - az;
    var p = [-dx, dx, -dz, dz], q = [ax - x0, x1 - ax, az - z0, z1 - az];
    var hit = true;
    for (var k = 0; k < 4 && hit; k++) {
      if (Math.abs(p[k]) < 1e-12) { if (q[k] < 0) hit = false; continue; }
      var r = q[k] / p[k];
      if (p[k] < 0) { if (r > t1) hit = false; else if (r > t0) t0 = r; }
      else if (r < t0) hit = false; else if (r < t1) t1 = r;
    }
    if (hit) return 0;
    var pt = function (x, z) {
      var ox = Math.max(x0 - x, 0, x - x1), oz = Math.max(z0 - z, 0, z - z1);
      return Math.hypot(ox, oz);
    };
    return Math.min(pt(ax, az), pt(bx, bz),
                    segDist(ax, az, bx, bz, x0, z0), segDist(ax, az, bx, bz, x1, z0),
                    segDist(ax, az, bx, bz, x0, z1), segDist(ax, az, bx, bz, x1, z1));
  }
  /* how far a body of half-width m on the polyline xs/zs reaches into the
   * ground's blocked cells (off the map, or not walkable) other than
   * cells skip0 and skip1: m less its nearest approach to one,
   * a negative number when it stays clear (and m when it crosses one) */
  function wallDepth(g, m, xs, zs, skip0, skip1) {
    var worst = -Infinity;
    for (var i = 1; i < xs.length; i++) {
      var ax = xs[i - 1], az = zs[i - 1], bx = xs[i], bz = zs[i];
      var gx0 = Math.floor(Math.min(ax, bx) - m), gx1 = Math.floor(Math.max(ax, bx) + m);
      var gz0 = Math.floor(Math.min(az, bz) - m), gz1 = Math.floor(Math.max(az, bz) + m);
      for (var z = gz0; z <= gz1; z++) {
        for (var x = gx0; x <= gx1; x++) {
          var off = x < 0 || z < 0 || x >= g.W || z >= g.H;
          var c = z * g.W + x;
          if (!off && (c === skip0 || c === skip1 || g.base[c])) continue;
          var d = m - segBoxDist(ax, az, bx, bz, x, z, x + 1, z + 1);
          if (d > worst) worst = d;
        }
      }
    }
    return worst;
  }
  /* the arc at radius rr about (cx, cz) from angle `from`, `sweep` the
   * way s, in steps of no more than ARC_STEP, onto ox/oz */
  function arcTo(ox, oz, cx, cz, rr, from, s, sweep) {
    var steps = Math.max(1, Math.ceil(sweep / ARC_STEP - 1e-9));
    for (var k = 0; k <= steps; k++) {
      var ang = from + s * sweep * (k / steps);
      ox.push(cx + Math.cos(ang) * rr); oz.push(cz + Math.sin(ang) * rr);
    }
  }
  function sweepOf(s, from, to) {
    var sweep = s * (to - from);
    sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return sweep > 2 * Math.PI - 1e-9 ? 0 : sweep;
  }
  function around(route, cx, cz, rho, grid, m) {
    var xs = route.xs, zs = route.zs, n = route.n;
    var rr = rho / Math.cos(ARC_STEP / 2);
    var ox = [xs[0]], oz = [zs[0]], bent = false;
    for (var i = 1; i < n; i++) {
      var ax = xs[i - 1], az = zs[i - 1], bx = xs[i], bz = zs[i];
      var da = Math.hypot(ax - cx, az - cz), db = Math.hypot(bx - cx, bz - cz);
      if (da < rho - 1e-9 || db < rho - 1e-9 ||
          segDist(ax, az, bx, bz, cx, cz) >= rho - 1e-9) {
        ox.push(bx); oz.push(bz);
        continue;
      }
      var aa = Math.atan2(az - cz, ax - cx), ab = Math.atan2(bz - cz, bx - cx);
      /* the bends to try, best first: tangent on, arc, tangent off, the
       * shorter way round, then the longer */
      var ta = Math.acos(Math.min(1, rr / Math.max(da, rr)));
      var tb = Math.acos(Math.min(1, rr / Math.max(db, rr)));
      var tries = [];
      for (var s = -1; s <= 1; s += 2) {
        var from = aa + s * ta;
        tries.push({ s: s, from: from, sweep: sweepOf(s, from, ab - s * tb) });
      }
      if (tries[1].sweep < tries[0].sweep) tries.reverse();
      if (grid) {
        /* then: the plain leg to where it meets the circle rr, the arc
         * (which starts and ends on the leg, or straight out from an end
         * already inside rr), and the plain leg on */
        var vx = bx - ax, vz = bz - az, L2 = vx * vx + vz * vz;
        var fx = ax - cx, fz = az - cz;
        var B = fx * vx + fz * vz, C = fx * fx + fz * fz - rr * rr;
        var disc = Math.sqrt(Math.max(0, B * B - L2 * C));
        var u1 = Math.max(0, (-B - disc) / L2), u2 = Math.min(1, (-B + disc) / L2);
        var px = ax + vx * u1, pz = az + vz * u1, qx = ax + vx * u2, qz = az + vz * u2;
        var a1 = Math.atan2(pz - cz, px - cx), a2 = Math.atan2(qz - cz, qx - cx);
        var sec = [];
        for (s = -1; s <= 1; s += 2) {
          sec.push({ s: s, from: a1, sweep: sweepOf(s, a1, a2) });
        }
        if (sec[1].sweep < sec[0].sweep) sec.reverse();
        tries = tries.concat(sec);
      }
      var skip0 = -1, skip1 = -1, limit = Infinity;
      if (grid) {
        var cell = function (x, z) {
          var gx = Math.floor(x), gz = Math.floor(z);
          return gx < 0 || gz < 0 || gx >= grid.W || gz >= grid.H ? -1 : gz * grid.W + gx;
        };
        skip0 = cell(ax, az); skip1 = cell(bx, bz);
        limit = Math.max(0, wallDepth(grid, m, [ax, bx], [az, bz], skip0, skip1)) + 1e-9;
      }
      var took = null;
      for (var k = 0; k < tries.length && !took; k++) {
        var T = tries[k], px2 = [ax], pz2 = [az];
        arcTo(px2, pz2, cx, cz, rr, T.from, T.s, T.sweep);
        px2.push(bx); pz2.push(bz);
        if (!grid || wallDepth(grid, m, px2, pz2, skip0, skip1) <= limit) took = [px2, pz2];
      }
      if (!took) { ox.push(bx); oz.push(bz); continue; }
      for (k = 1; k < took[0].length; k++) { ox.push(took[0][k]); oz.push(took[1][k]); }
      bent = true;
    }
    return bent ? cumulative(ox, oz) : route;
  }

  /* Push overlapping figures apart. `F` holds parallel arrays, `n` long:
   *   rx, rz   where each figure would be drawn alone (read only)
   *   x, z     where it is drawn (written)
   *   r        body radius;  w  how readily it moves (0: seated, fixed)
   *   hx, hz   heading while walking (0, 0 when still)
   *   layer    who it can collide with (-1: not drawn, skipped)
   *   id       a stable id, for breaking an exact tie the same way always
   * Stateless: a fixed number of Gauss-Seidel sweeps from the raw points
   * every frame, in index order, so the result depends only on this
   * frame's input. Each pair closer than ri + rj (+ `pad` when either is
   * walking, so a walker steps aside a little before contact) shares the
   * shortfall by weight; two walkers meeting head-on also lean to their
   * own right, so they pass side by side rather than shoving along the
   * path. No figure is moved further than `maxOff` from its raw point, and
   * no move is taken that `ok(i, x, z)` refuses. With `opts.measure` it
   * returns the smallest gap left (negative: an overlap it could not
   * undo) — an O(n²) pass, for the checks; the page leaves it off. */
  var _head = new Int32Array(0), _next = new Int32Array(0);
  /* how far (a share of two bodies) oncoming walkers may be on the wrong
   * side of each other and still be steered to pass on their right */
  var WRONG_SIDE = 0.75;

  function separate(F, n, opts) {
    opts = opts || {};
    var iters = opts.iters || 8;
    var maxOff = opts.maxOff == null ? 0.6 : opts.maxOff;
    var pad = opts.pad || 0;
    var ok = opts.ok || null;
    var x = F.x, z = F.z, rx = F.rx, rz = F.rz, r = F.r, w = F.w;
    var hx = F.hx, hz = F.hz, layer = F.layer, id = F.id;
    var i, j, rmax = 0, minX = Infinity, minZ = Infinity;
    var maxX = -Infinity, maxZ = -Infinity;
    for (i = 0; i < n; i++) {
      x[i] = rx[i]; z[i] = rz[i];
      if (layer[i] < 0) continue;
      if (r[i] > rmax) rmax = r[i];
      if (x[i] < minX) minX = x[i];
      if (z[i] < minZ) minZ = z[i];
      if (x[i] > maxX) maxX = x[i];
      if (z[i] > maxZ) maxZ = z[i];
    }
    if (!(rmax > 0)) return opts.measure ? Infinity : undefined;
    var cs = 2 * rmax + pad + 2 * maxOff / iters + 0.05;
    minX -= maxOff + cs; minZ -= maxOff + cs;
    var GW = Math.max(1, Math.ceil((maxX - minX + maxOff + cs) / cs) + 1);
    var GH = Math.max(1, Math.ceil((maxZ - minZ + maxOff + cs) / cs) + 1);
    if (GW * GH > 65536) {           // a stray far point: coarser buckets
      cs = Math.max((maxX - minX) / 255, (maxZ - minZ) / 255, cs);
      GW = Math.ceil((maxX - minX + maxOff + cs) / cs) + 1;
      GH = Math.ceil((maxZ - minZ + maxOff + cs) / cs) + 1;
    }
    if (_head.length < GW * GH) _head = new Int32Array(GW * GH);
    if (_next.length < n) _next = new Int32Array(Math.max(n, 64));

    function tryMove(k, nx, nz) {
      var ox = nx - rx[k], oz = nz - rz[k];
      var off = Math.hypot(ox, oz);
      if (off > maxOff) {
        nx = rx[k] + ox * (maxOff / off);
        nz = rz[k] + oz * (maxOff / off);
      }
      if (ok && !ok(k, nx, nz)) return false;
      x[k] = nx; z[k] = nz;
      return true;
    }

    function resolve(a, b) {
      if (layer[a] !== layer[b]) return;
      var dx = x[b] - x[a], dz = z[b] - z[a];
      var d = Math.hypot(dx, dz);
      var movA = hx[a] !== 0 || hz[a] !== 0;
      var movB = hx[b] !== 0 || hz[b] !== 0;
      var want = r[a] + r[b] + (movA || movB ? pad : 0);
      var need = want - d;
      if (need <= 0) return;
      var nx, nz;
      if (d > 1e-6) {
        nx = dx / d; nz = dz / d;
      } else {
        /* the same point: across the heading if walking, else a fixed
         * direction from the pair's ids — never a coin toss */
        var hl = Math.hypot(hx[a], hz[a]);
        var side = id[a] < id[b] ? 1 : -1;
        if (hl > 0) { nx = -hz[a] / hl * side; nz = hx[a] / hl * side; }
        else {
          var ang = ((id[a] * 0.6180339 + id[b] * 0.3819660) % 1) * 6.2831853;
          nx = Math.cos(ang); nz = Math.sin(ang);
        }
      }
      var wa = w[a], wb = w[b];
      if (wa + wb <= 0) return;
      var ax, az, bx, bz;
      if (movA && movB) {
        var la = Math.hypot(hx[a], hz[a]), lb = Math.hypot(hx[b], hz[b]);
        var ux = hx[a] / la, uz = hz[a] / la, vx = hx[b] / lb, vz = hz[b] / lb;
        var dot = ux * vx + uz * vz;
        /* oncoming, with b on a's right — the wrong side — but by less
         * than most of a body: they pass the right way, so the push is the
         * mirror of the plain one across a's line. Without it the lean
         * below fades as they come abreast and the plain push takes over,
         * and each would jump to its left at the moment they pass. */
        var side = -uz * nx + ux * nz;            // > 0: b on a's right
        if (dot < -0.3 && side > 0 && side * d < WRONG_SIDE * (r[a] + r[b])) {
          nx -= 2 * side * -uz; nz -= 2 * side * ux;
        }
        ax = -nx; az = -nz; bx = nx; bz = nz;
        /* oncoming walkers: lean right, weighted by how head-on it is */
        var lat = Math.abs(-uz * nx + ux * nz);   // how far to a's side b is
        var k = Math.max(0, Math.min(1, (-dot - 0.3) / 0.4)) *
                Math.max(0, Math.min(1, 1 - lat / 0.6));
        if (k > 0) {
          /* a's right is (-uz, ux) in x/z; b's is (-vz, vx) */
          ax += k * 1.5 * -uz; az += k * 1.5 * ux;
          bx += k * 1.5 * -vz; bz += k * 1.5 * vx;
          var l1 = Math.hypot(ax, az) || 1, l2 = Math.hypot(bx, bz) || 1;
          ax /= l1; az /= l1; bx /= l2; bz /= l2;
        }
      } else {
        ax = -nx; az = -nz; bx = nx; bz = nz;
      }
      var sa = wa / (wa + wb), sb = wb / (wa + wb);
      var movedA = sa > 0 && tryMove(a, x[a] + ax * need * sa,
                                        z[a] + az * need * sa);
      if (!movedA && sa > 0 && wb > 0) sb = 1;
      var movedB = sb > 0 && tryMove(b, x[b] + bx * need * sb,
                                        z[b] + bz * need * sb);
      if (!movedB && sb > 0 && sb < 1 && wa > 0 && movedA) {
        tryMove(a, x[a] + ax * need * sb, z[a] + az * need * sb);
      }
    }

    for (var it = 0; it < iters; it++) {
      _head.fill(-1, 0, GW * GH);
      for (i = 0; i < n; i++) {
        if (layer[i] < 0) continue;
        var bi = Math.min(GW - 1, Math.max(0, Math.floor((x[i] - minX) / cs))) +
                 Math.min(GH - 1, Math.max(0, Math.floor((z[i] - minZ) / cs))) * GW;
        _next[i] = _head[bi]; _head[bi] = i;
      }
      for (i = 0; i < n; i++) {
        if (layer[i] < 0) continue;
        var gx = Math.min(GW - 1, Math.max(0, Math.floor((x[i] - minX) / cs)));
        var gz = Math.min(GH - 1, Math.max(0, Math.floor((z[i] - minZ) / cs)));
        for (var oz = -1; oz <= 1; oz++) {
          var zz = gz + oz;
          if (zz < 0 || zz >= GH) continue;
          for (var ox = -1; ox <= 1; ox++) {
            var xx = gx + ox;
            if (xx < 0 || xx >= GW) continue;
            for (j = _head[zz * GW + xx]; j >= 0; j = _next[j]) {
              if (j > i) resolve(i, j);
            }
          }
        }
      }
    }
    return opts.measure ? minGap(F, n) : undefined;
  }

  /* The smallest r-adjusted gap between two drawn figures on one layer
   * (negative: they overlap by that much). For the checks and the HUD. */
  function minGap(F, n) {
    var best = Infinity;
    for (var i = 0; i < n; i++) {
      if (F.layer[i] < 0) continue;
      for (var j = i + 1; j < n; j++) {
        if (F.layer[j] !== F.layer[i]) continue;
        var g = Math.hypot(F.x[i] - F.x[j], F.z[i] - F.z[j]) - F.r[i] - F.r[j];
        if (g < best) best = g;
      }
    }
    return best;
  }

  /* Parallel arrays for `separate`, grown to at least n. */
  function figures(F, n) {
    if (F && F.x.length >= n) return F;
    var m = Math.max(n, 16, F ? F.x.length * 2 : 0);
    return {
      rx: new Float64Array(m), rz: new Float64Array(m),
      x: new Float64Array(m), z: new Float64Array(m),
      r: new Float64Array(m), w: new Float64Array(m),
      hx: new Float64Array(m), hz: new Float64Array(m),
      layer: new Int32Array(m).fill(-1), id: new Float64Array(m),
    };
  }

  var api = {
    SOLID: SOLID,
    buildGrid: buildGrid,
    setFixtures: setFixtures,
    findPath: findPath,
    routePoints: routePoints,
    straight: straight,
    duration: duration,
    sample: sample,
    WALK_CPS: WALK_CPS,
    pack: pack,
    clearAt: clearAt,
    KEEP_BOX: KEEP_BOX, KEEP_DISK: KEEP_DISK,
    edgeDist: edgeDist, keepOut: keepOut, groundKeepOuts: groundKeepOuts,
    cellOpen: cellOpen, keepClear: keepClear, around: around,
    separate: separate,
    minGap: minGap,
    figures: figures,
  };
  /* `Page3DWalk` is the shared name; `EstateWalk` is kept because the
   * estate's module and its check were written against it. */
  root.Page3DWalk = api;
  root.EstateWalk = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
