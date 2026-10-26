/* water — the grove's creeks and ponds as the page draws them.
 *
 * A creek is one stream from its source edge to its mouth, and the page
 * draws it as one: each kind of water (creek, pond, and the shallow ford
 * where a creek runs over stones) is a single merged surface at one level,
 * one square per cell, edge to edge with its neighbours, never turned. The
 * creek's ripple runs in the creek's own frame (across it and down it,
 * from source to mouth), the same at every corner two cells share, so the
 * stream has no seams where it bends. Two cells of water that touch only
 * at a corner (an old world's water may) are joined with a wedge across
 * the corner.
 *
 * The floor under the water is here too: a cell's height at its centre,
 * which the page's ground is bilinear between. A ford's stones lie just
 * under the surface, so the creek runs on across them; the floor is below
 * the water all the way down a creek, centre to centre.
 *
 * A pure function of the frame (no THREE, no DOM), so `tools/water_check.js`
 * holds it to all of that in Node on a real snapshot.
 *
 * A classic script (loaded before the module), published as GroveWater.
 */
(function (root) {
  'use strict';

  var Y = 0.0;              // the water's one level
  var BED = -0.34;          // a creek's or pond's bed under it
  var FORD_BED = -0.08;     // a ford's stones, just under the creek
  var ELEV = 1.1;           // the engine's elevation, lifted
  var LAND_MIN = 0.06;      // the lowest dry ground
  var WEDGE = 0.35;         // how far a corner join reaches into a cell

  var CREEK = 1, POND = 2, FORD = 3;
  var NAME = { 1: 'creek', 2: 'pond', 3: 'ford' };

  /* which water each cell is (the snapshot's seventh field): 1 creek,
   * 2 pond (and any water a world from before creeks has), 3 a ford
   * across, 0 dry land */
  function kinds(st) {
    var N = Number(st.size) | 0;
    var k = new Uint8Array(N * N);
    for (var i = 0; i < N * N; i++) {
      var c = st.cells[i] || ['s'];
      k[i] = c[6] === 'c' ? CREEK : c[6] === 'f' ? FORD
        : c[0] === 'w' ? POND : 0;
    }
    return k;
  }

  /* the floor's height at a cell's centre */
  function cellHeight(c) {
    c = c || ['s', 0, 0, 0, 0, 0];
    if (c[0] === 'w') return BED;
    if (c[6] === 'f') return FORD_BED;
    return Math.max(LAND_MIN, 0.12 + (Number(c[5]) || 0) * ELEV);
  }

  function heights(st) {
    var N = Number(st.size) | 0;
    var h = new Float32Array(N * N);
    for (var i = 0; i < N * N; i++) h[i] = cellHeight(st.cells[i]);
    return h;
  }

  /* the floor between centres, bilinear, as the page's ground is */
  function floorAt(h, N, x, z) {
    function at(cx, cy) {
      cx = cx < 0 ? 0 : cx >= N ? N - 1 : cx;
      cy = cy < 0 ? 0 : cy >= N ? N - 1 : cy;
      return h[cy * N + cx];
    }
    var u = x - 0.5, v = z - 0.5;
    var x0 = Math.floor(u), z0 = Math.floor(v);
    var fx = u - x0, fz = v - z0;
    return (at(x0, z0) * (1 - fx) + at(x0 + 1, z0) * fx) * (1 - fz) +
      (at(x0, z0 + 1) * (1 - fx) + at(x0 + 1, z0 + 1) * fx) * fz;
  }

  /* Each creek's frame: the cells it runs through, and for each its
   * (across, down) ripple coordinates of a point. A creek runs along x or
   * y from one edge to the other; down is towards its mouth. */
  function frames(st) {
    var N = Number(st.size) | 0;
    var of = new Int32Array(N * N).fill(-1);
    var list = [];
    (st.creeks || []).forEach(function (path, ci) {
      if (!path || !path.length) return;
      var a = path[0], b = path[path.length - 1];
      var alongX = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
      var down = (alongX ? b[0] - a[0] : b[1] - a[1]) < 0 ? -1 : 1;
      list.push({ alongX: alongX, down: down });
      path.forEach(function (p) {
        var x = p[0], y = p[1];
        if (x >= 0 && y >= 0 && x < N && y < N && of[y * N + x] < 0) {
          of[y * N + x] = list.length - 1;
        }
      });
    });
    return { of: of, list: list };
  }

  function uvOf(fr, x, z) {
    if (!fr) return [x, z];
    return fr.alongX ? [z, fr.down * x] : [x, fr.down * z];
  }

  function surface() {
    return { pos: [], uv: [], idx: [], cells: [], wedges: [] };
  }

  /* a triangle facing up (+y), whichever way its corners were given */
  function tri(s, fr, p0, p1, p2) {
    var cross = (p1[1] - p0[1]) * (p2[0] - p0[0]) -
      (p1[0] - p0[0]) * (p2[1] - p0[1]);
    var pts = cross >= 0 ? [p0, p1, p2] : [p0, p2, p1];
    var base = s.pos.length / 2;
    pts.forEach(function (p) {
      s.pos.push(p[0], p[1]);
      var uv = uvOf(fr, p[0], p[1]);
      s.uv.push(uv[0], uv[1]);
    });
    s.idx.push(base, base + 1, base + 2);
  }

  /* The water as the page draws it: per kind, flat arrays of (x, z)
   * points, their ripple uv, and triangles; `cells` the cells each square
   * covers, `wedges` the corner joins. Every point is at level Y. */
  function surfaces(st) {
    var N = Number(st.size) | 0;
    var K = kinds(st);
    var F = frames(st);
    var out = {};
    out[CREEK] = surface(); out[POND] = surface(); out[FORD] = surface();
    for (var i = 0; i < N * N; i++) {
      if (!K[i]) continue;
      var x = i % N, z = (i - x) / N;
      var s = out[K[i]];
      var fr = F.of[i] >= 0 ? F.list[F.of[i]] : null;
      var base = s.pos.length / 2;
      [[x, z], [x, z + 1], [x + 1, z], [x + 1, z + 1]].forEach(function (p) {
        s.pos.push(p[0], p[1]);
        var uv = uvOf(fr, p[0], p[1]);
        s.uv.push(uv[0], uv[1]);
      });
      s.idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
      s.cells.push(i);
    }
    /* a corner that only two diagonal cells of water share: a wedge into
     * each of the two dry cells, so the water runs on across the corner */
    for (var gz = 1; gz < N; gz++) {
      for (var gx = 1; gx < N; gx++) {
        var a = (gz - 1) * N + gx - 1, b = a + 1, c = a + N, d = c + 1;
        var pairs = [[a, d, b, c], [b, c, a, d]];
        for (var q = 0; q < 2; q++) {
          var w0 = pairs[q][0], w1 = pairs[q][1];
          var l0 = pairs[q][2], l1 = pairs[q][3];
          if (!K[w0] || !K[w1] || K[l0] || K[l1]) continue;
          var kind = K[w0] === CREEK || K[w1] === CREEK ? CREEK : K[w0];
          var s2 = out[kind];
          var fr2 = F.of[w0] >= 0 ? F.list[F.of[w0]]
            : F.of[w1] >= 0 ? F.list[F.of[w1]] : null;
          [l0, l1].forEach(function (l) {
            var lx = l % N, lz = (l - lx) / N;
            var sx = lx < gx ? -1 : 1, sz = lz < gz ? -1 : 1;
            tri(s2, fr2, [gx, gz], [gx + sx * WEDGE, gz],
                [gx, gz + sz * WEDGE]);
            s2.wedges.push(l);
          });
        }
      }
    }
    return out;
  }

  var api = {
    Y: Y, BED: BED, FORD_BED: FORD_BED, ELEV: ELEV, LAND_MIN: LAND_MIN,
    WEDGE: WEDGE, CREEK: CREEK, POND: POND, FORD: FORD, NAME: NAME,
    kinds: kinds, cellHeight: cellHeight, heights: heights,
    floorAt: floorAt, frames: frames, surfaces: surfaces,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.GroveWater = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
