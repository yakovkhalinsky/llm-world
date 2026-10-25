/* glow — which of the grove's mushroom rings glow tonight.
 *
 * The server sends every mushroom (a cell's fourth field) and a light field
 * built from all of them (`web.glow_field`). Lit all at once they washed the
 * whole canopy green; the night should be mostly dark blue with a few pools
 * of green. So the page lights only about one ring in four, and builds its
 * own field from those rings with the server's own formula.
 *
 * A ring is a patch of mushroom cells touching one another (the eight
 * neighbours). Whether a ring glows is a hash of the ring and of the night,
 * and nothing else: the same snapshot on the same night lights the same
 * rings on every page load, a different night lights others, and if no ring
 * passes the hash the one closest to passing glows, so a grove with
 * mushrooms is never quite dark. It is a view-only choice — the sim never
 * sees it, and every mushroom still stands; only its light is withheld.
 *
 * Pure: no THREE, no DOM, no randomness. A classic script, loaded before the
 * module and published as GroveGlow; `tools/glow_check.js` requires it in
 * Node.
 */
(function (root) {
  'use strict';

  var SHARE = 0.25;           // about one ring in four glows on a night
  /* the server's `GLOW_REACH` and `GLOW_STEPS` (grove/web.py), so a ring's
   * pool here is the pool the server would have sent for it */
  var REACH = 2.6;
  var STEPS = 9;

  function hash(n, salt) {
    var x = ((n | 0) * 374761393 + (salt | 0) * 668265263) | 0;
    x = Math.imul(x ^ (x >>> 13), 1274126177) | 0;
    x = x ^ (x >>> 16);
    return x >>> 0;
  }
  function hash01(n, salt) { return hash(n, salt) / 4294967295; }

  function isMush(cells, i) {
    var c = cells[i];
    return !!(c && c[3]);
  }

  /* The rings, in the order of their first cell: each is
   * {key: its lowest cell index, cells: [cell indices]}. */
  function rings(cells, N) {
    var seen = new Uint8Array(N * N);
    var out = [];
    for (var i = 0; i < N * N; i++) {
      if (seen[i] || !isMush(cells, i)) continue;
      var ring = { key: i, cells: [] };
      var stack = [i];
      seen[i] = 1;
      while (stack.length) {
        var k = stack.pop();
        ring.cells.push(k);
        var x = k % N, y = (k - x) / N;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            var nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
            var j = ny * N + nx;
            if (!seen[j] && isMush(cells, j)) { seen[j] = 1; stack.push(j); }
          }
        }
      }
      ring.cells.sort(function (a, b) { return a - b; });
      out.push(ring);
    }
    return out;
  }

  /* The rings that glow on `night` (any integer the page counts nights
   * by). Returns {rings, lit: [ring], litCell: Uint8Array(N*N)}. */
  function choose(cells, N, night, share) {
    var s = share == null ? SHARE : share;
    var all = rings(cells, N);
    var lit = [];
    var best = null, bestH = 2;
    for (var r = 0; r < all.length; r++) {
      var h = hash01(all[r].key, (night | 0) * 7919 + 4241);
      if (h < s) lit.push(all[r]);
      if (h < bestH) { bestH = h; best = all[r]; }
    }
    if (!lit.length && best) lit.push(best);
    var litCell = new Uint8Array(N * N);
    for (var q = 0; q < lit.length; q++) {
      for (var c = 0; c < lit[q].cells.length; c++) litCell[lit[q].cells[c]] = 1;
    }
    return { rings: all, lit: lit, litCell: litCell };
  }

  /* The light field of the lit cells: one step 0..STEPS per cell,
   * row-major — `web.glow_field`'s arithmetic, on fewer sources. */
  function field(litCell, N) {
    var out = new Array(N * N);
    for (var i = 0; i < N * N; i++) out[i] = 0;
    var r = Math.floor(REACH);
    for (var s = 0; s < N * N; s++) {
      if (!litCell[s]) continue;
      var sx = s % N, sy = (s - sx) / N;
      for (var y = Math.max(0, sy - r); y < Math.min(N, sy + r + 1); y++) {
        for (var x = Math.max(0, sx - r); x < Math.min(N, sx + r + 1); x++) {
          var d = Math.sqrt((x - sx) * (x - sx) + (y - sy) * (y - sy));
          if (d >= REACH) continue;
          /* Python's round() is half-to-even; d is a root of an integer,
           * and STEPS * (1 - d / REACH) lands on a half only for d = 1.3
           * or d = 0.4333..., neither of which is such a root */
          var v = Math.round(STEPS * (1 - d / REACH));
          var i2 = y * N + x;
          if (v > out[i2]) out[i2] = v;
        }
      }
    }
    return out;
  }

  var api = { SHARE: SHARE, REACH: REACH, STEPS: STEPS, hash: hash,
              rings: rings, choose: choose, field: field };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.GroveGlow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
