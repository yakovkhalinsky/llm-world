/* field — a light field, painted once into a canvas the scene can wear.
 *
 * Both 3D views light their nights the same way: the server sends one
 * step per cell (0..9, row-major) and the page paints that field as a
 * smooth pool of light rather than a disc per source. The estate's lamps
 * and the grove's mushrooms are the same picture — brightest at the
 * source, fading to nothing at its reach, two pools merging where they
 * overlap — so the painting lives here, once.
 *
 * Pure canvas: no THREE, no fetch. The caller owns the texture; this only
 * fills the big canvas it was given (a cell to `px` pixels, upscaled with
 * smoothing and blurred so the rim of a pool is a fade, not a ledge) and
 * says how many cells were lit, and whether anything changed.
 *
 * Shared by both 3D views (apps/shared/page3d/); each app serves this
 * folder under its own `/3d/`. A classic script, like clock.js and walk.js.
 */
(function (root) {
  'use strict';

  var STEPS = 9;

  /* `big` is W*px by H*px, `small` is W by H; both are canvases the caller
   * made (the caller's document, so this file never touches one). The
   * field is keyed on its own values: an unchanged field is not repainted.
   * Returns {lit, changed}. */
  function makePainter(W, H, px, big, small) {
    var key = null;
    var lit = 0;
    function paint(values) {
      var vals = values || [];
      var k = Array.prototype.join.call(vals, ',');
      if (k === key) return { lit: lit, changed: false };
      key = k;
      var sctx = small.getContext('2d');
      var img = sctx.createImageData(W, H);
      var n = 0;
      for (var i = 0; i < W * H; i++) {
        var v = Math.max(0, Math.min(STEPS, Number(vals[i]) || 0)) / STEPS;
        if (v) n++;
        /* eased a little so the low steps stay faint */
        var a = Math.round(255 * Math.pow(v, 1.3));
        img.data[i * 4] = 255;
        img.data[i * 4 + 1] = 255;
        img.data[i * 4 + 2] = 255;
        img.data[i * 4 + 3] = a;
      }
      sctx.putImageData(img, 0, 0);
      var bctx = big.getContext('2d');
      bctx.clearRect(0, 0, big.width, big.height);
      bctx.imageSmoothingEnabled = true;
      bctx.imageSmoothingQuality = 'high';
      /* the blur takes the corners off the smoothing's diamonds; a browser
       * without canvas filters still gets the smooth upscale */
      if ('filter' in bctx) bctx.filter = 'blur(' + (px * 0.6) + 'px)';
      bctx.drawImage(small, 0, 0, big.width, big.height);
      if ('filter' in bctx) bctx.filter = 'none';
      lit = n;
      return { lit: lit, changed: true };
    }
    return { paint: paint };
  }

  var api = { STEPS: STEPS, makePainter: makePainter };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.Page3DField = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
