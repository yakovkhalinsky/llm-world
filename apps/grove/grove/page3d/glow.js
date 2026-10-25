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
 * mushrooms is never quite dark at nightfall. Through the night the
 * choice is carried from week to week (see `choose`), so a ring that
 * survives a week never switches on or off in the dark. It is a
 * view-only choice — the sim never sees it, and every mushroom still
 * stands; only its light is withheld.
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
    /* exact 32-bit products: a plain multiply passes 2^53 for large
     * nights and rounds its low bits away before the `| 0` */
    var x = (Math.imul(n | 0, 374761393) +
             Math.imul(salt | 0, 668265263)) | 0;
    x = Math.imul(x ^ (x >>> 13), 1274126177) | 0;
    x = x ^ (x >>> 16);
    return x >>> 0;
  }
  function hash01(n, salt) { return hash(n, salt) / 4294967295; }

  /* a ring's draw on a night, 0..1: it glows if this is under SHARE */
  function score(key, night) {
    return hash01(key, Math.imul(night | 0, 7919) + 4241);
  }

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
   * by). Returns {rings, lit: [ring], litCell, mushCell} — the last two
   * Uint8Array(N*N), the lit rings' cells and every mushroom cell.
   *
   * `carry` is the choice made for the week before, on the same night
   * (an earlier result of this function). A week's growth can move a
   * ring's first cell, and with it the ring's draw, so a ring that
   * survived the week would flip on or off in the dark. With a carry:
   *   - a ring touching a cell lit the week before stays lit;
   *   - a ring that stood the week before (it touches one of its
   *     mushroom cells) but was dark stays dark;
   *   - only a new ring is drawn, as on a fresh night.
   * The fallback (the ring closest to passing glows when none passes)
   * applies to a fresh night only, or among new rings: a surviving dark
   * ring never lights up mid-night to stand in for one that died. */
  function choose(cells, N, night, share, carry) {
    var s = share == null ? SHARE : share;
    var all = rings(cells, N);
    var lit = [];
    var best = null, bestH = 2;
    for (var r = 0; r < all.length; r++) {
      var ring = all[r];
      if (carry) {
        var wasLit = false, stood = false;
        for (var c = 0; c < ring.cells.length; c++) {
          var k = ring.cells[c];
          if (carry.litCell[k]) wasLit = true;
          if (carry.mushCell[k]) stood = true;
        }
        if (wasLit) { lit.push(ring); continue; }
        if (stood) continue;
      }
      var h = score(ring.key, night);
      if (h < s) lit.push(ring);
      if (h < bestH) { bestH = h; best = ring; }
    }
    if (!lit.length && best) lit.push(best);
    lit.sort(function (a, b) { return a.key - b.key; });
    var litCell = new Uint8Array(N * N);
    for (var q = 0; q < lit.length; q++) {
      for (var j = 0; j < lit[q].cells.length; j++) litCell[lit[q].cells[j]] = 1;
    }
    var mushCell = new Uint8Array(N * N);
    for (var i = 0; i < N * N; i++) if (isMush(cells, i)) mushCell[i] = 1;
    return { rings: all, lit: lit, litCell: litCell, mushCell: mushCell };
  }

  /* The page's weekly rebuild: a fresh choice while it is light (or with
   * nothing to carry), and the week before carried through the dark, so
   * the lit set is chosen by day and holds all night. `dark` is the
   * clock's 0..1; the glow shows above DARK_ON. */
  var DARK_ON = 0.02;
  function rebuild(prev, cells, N, night, dark) {
    var carry = prev && dark > DARK_ON ? prev : null;
    return choose(cells, N, night, null, carry);
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

  var api = { SHARE: SHARE, REACH: REACH, STEPS: STEPS, DARK_ON: DARK_ON,
              hash: hash, score: score, rings: rings, choose: choose,
              rebuild: rebuild, field: field };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.GroveGlow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
