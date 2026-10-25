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

  var api = {
    SUB: SUB, QX: QX, QZ: QZ, WALK: WALK, STANDING: STANDING,
    hash: hash, subGround: subGround, trunks: trunks, restSpot: restSpot,
    route: route, kindOf: kindOf,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.GroveForest = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
