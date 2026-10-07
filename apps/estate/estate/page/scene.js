/* scene — the estate, drawn with PixiJS in isometric.
 *
 * The grove's island is isometric because a forest has no edges; the estate
 * is isometric because it has *height*. A plan drawn flat has to say "6
 * floors" in words; drawn this way a six-storey block simply rises, and the
 * thing the whole interior model rests on — that a sixth floor is a long
 * way up — is visible before anyone reads a number.
 *
 * The projection is the grove's: a cell is a 2:1 diamond, x runs down-right
 * and y runs down-left, and everything is painted back to front along the
 * diagonals so that things in front cover things behind. One column is
 * drawn per cell: two faces toward the viewer and a top. A ground cell is a
 * shallow slab; a building cell is as tall as its floors.
 *
 * Everything here is *shown*, never decided. The scene reads the frame the
 * server sends and draws it; where a fact is missing it draws nothing
 * rather than guessing one, because a guess in a renderer is a second copy
 * of a fact the engine already owns (grove b2/b34).
 */

'use strict';

const Scene = (() => {
  const PAD = 30;                    // px of air around the island
  const TW = 28, TH = 14;            // isometric tile diamond, 2:1
  const SLAB = 7;                    // how thick the ground itself is
  const FLOOR = 8;                   // screen px per storey

  /* cell colours by season. The two side faces are the same colour knocked
   * back, because a surface in shadow is the same surface, not a different
   * one. */
  const GROUND = {
    0: { lawn: 0x6f8f52, road: 0x3a4048, path: 0x938a7b, paved: 0x6d6a63,
         play: 0xb5945a, water: 0x3d6f88, building: 0x2f3640 },
    1: { lawn: 0x63863c, road: 0x3d434b, path: 0x9a9080, paved: 0x726e66,
         play: 0xbe9a58, water: 0x3a7392, building: 0x2f3640 },
    2: { lawn: 0x8a7c3e, road: 0x383e45, path: 0x8d8474, paved: 0x6a675f,
         play: 0xb08a4c, water: 0x39677d, building: 0x2f3640 },
    3: { lawn: 0x8b9189, road: 0x343a41, path: 0x8c8c8c, paved: 0x6b6b6b,
         play: 0xa89a80, water: 0x35586b, building: 0x2f3640 },
  };

  /* the day's five phases, as colour and weight laid over the island */
  const DAY = [
    { c: 0xff9d6b, a: 0.24 },        // dawn
    { c: 0xffffff, a: 0.00 },        // morning
    { c: 0xffe3b8, a: 0.06 },        // afternoon
    { c: 0xff8a4c, a: 0.28 },        // evening
    { c: 0x18265c, a: 0.52 },        // night
  ];

  const ROLE = { child: 0xf2c14e, adult: 0x9ecbf0, elder: 0xd9b8e8 };

  const SC = {
    app: null, world: null,
    gGround: null, gShade: null, gBuild: null, gWin: null,
    gObj: null, gPeople: null, gLight: null, gFx: null, gMark: null,
    ground: null, state: null, tickMs: 6000, t0: 0,
    agents: {}, drops: [], season: -1, built: false, shadeKey: '',
    scale: 1, ox: 0, oy: 0, cw: 0, ch: 0,
    ext: { x0: 0, y0: 0, w: 1, h: 1 },
    heights: null,
  };

  const G = () => new PIXI.Graphics();

  const dark = (c, f) => {
    const r = (c >> 16 & 255) * f | 0, g = (c >> 8 & 255) * f | 0,
          b = (c & 255) * f | 0;
    return (r << 16) | (g << 8) | b;
  };

  /* ------------------------------------------------------------ geometry */

  /* A cell corner in world pixels. +x is down-right, +y down-left, so the
   * viewer stands to the south and the two faces toward them are the +x and
   * +y ones — which is all the hidden-surface work this needs. */
  const iso = (x, y) => ({ x: (x - y) * TW / 2, y: (x + y) * TH / 2 });

  function heightsOf() {
    const h = {};
    SC.ground.buildings.forEach(b => {
      const top = Math.max(1, b.floors) * FLOOR;
      for (let y = b.y; y < b.y + b.h; y++) {
        for (let x = b.x; x < b.x + b.w; x++) h[x + ',' + y] = top;
      }
    });
    SC.heights = h;
    return h;
  }

  const heightAt = (x, y) => (SC.heights || {})[x + ',' + y] || 0;

  /* where a resident is when they are in: a window of their own flat. A
   * person indoors is a state, not a coordinate, and this is how a state
   * gets drawn — on the face of the block they live in. */
  function windowOf(unit) {
    const u = SC.ground.units[String(unit)];
    if (!u) return null;
    const b = SC.ground.byId[u.b];
    const cx = b.x + 0.6 + (u.i + 0.5) / u.n * Math.max(0.1, b.w - 1.2);
    const cy = b.y + 0.6 + (u.f - 0.45) / Math.max(1, u.floors) *
      Math.max(0.1, b.h - 1.2);
    const p = iso(cx, cy);
    return { x: p.x, y: p.y - Math.max(1, u.f) * FLOOR };
  }

  /* every cell, back to front: along the diagonals x+y = s. Two cells on
   * one diagonal never cover each other, so their order within it is free. */
  function inOrder(fn) {
    const W = SC.ground.width, H = SC.ground.height;
    for (let s = 0; s <= W + H - 2; s++) {
      const lo = Math.max(0, s - (H - 1)), hi = Math.min(W - 1, s);
      for (let x = lo; x <= hi; x++) fn(x, s - x);
    }
  }

  /* One cell: its walls, then its top. The walls are what make it a column
   * rather than a tile, and their height is what makes a block a block. */
  function column(g, x, y, top, side, h, base) {
    const A = iso(x, y), B = iso(x + 1, y), C = iso(x + 1, y + 1),
          D = iso(x, y + 1);
    const foot = C.y + base;
    g.poly([B.x, B.y - h, C.x, C.y - h, C.x, foot, B.x, B.y + base])
      .fill(side);
    g.poly([D.x, D.y - h, C.x, C.y - h, C.x, foot, D.x, D.y + base])
      .fill(dark(side, 0.82));
    g.poly([A.x, A.y - h, B.x, B.y - h, C.x, C.y - h, D.x, D.y - h]).fill(top);
  }

  /* --------------------------------------------------------------- build */

  function buildGround(st) {
    const g = SC.gGround;
    const pal = GROUND[(st && st.season) || 0] || GROUND[0];
    const codes = SC.ground.codes, rows = SC.ground.rows;
    const shade = (st && st.shade) || [];
    const W = SC.ground.width;
    g.clear();
    inOrder((x, y) => {
      const site = codes[rows[y][x]];
      const isB = site === 'building';
      const h = isB ? heightAt(x, y) : 0;
      let top = pal[site] !== undefined ? pal[site] : 0x000000;
      if (isB) {
        top = dark(top, 1.22);          // a roof catches the sky
      } else {
        /* the day's shade is baked straight into the surface. A wash laid
         * over the top in a second pass floats across the blocks standing
         * in front of it, and shade under a building is not shade on it. */
        const v = shade[y * W + x] || 0;
        if (v) top = dark(top, 1 - Math.min(0.45, v * 0.05));
      }
      column(g, x, y, top, isB ? pal.building : dark(top, 0.78), h, SLAB);
    });
    SC.season = (st && st.season) || 0;
  }

  /* Windows are drawn on the face of each block, one pane per flat, lit at
   * night by whether a household actually lives there. This is the census
   * drawn rather than written. */
  function buildWindows() {
    const g = SC.gWin, st = SC.state;
    g.clear();
    if (!st) return;
    const lived = {};
    st.people.forEach(p => {
      if (p.in && p.unit != null) {
        const u = SC.ground.units[String(p.unit)];
        if (u) (lived[u.b] = lived[u.b] || new Set()).add(u.f);
      }
    });
    SC.ground.buildings.forEach(b => {
      const u = SC.ground.unitsPer[b.id] || {};
      for (const id in u) {
        const pos = windowOf(id);
        if (!pos) continue;
        const on = (lived[b.id] || new Set()).has(u[id].f);
        g.circle(pos.x, pos.y, 2.4).fill({
          color: on ? 0xffca7a : 0x1d2229, alpha: on ? 0.95 : 0.5,
        });
      }
    });
  }

  function buildObjects() {
    const g = SC.gObj, st = SC.state;
    g.clear();
    if (!st) return;
    st.fixtures.forEach(f => {
      const p = iso(f.x + 0.5, f.y + 0.5);
      const x = p.x, y = p.y - heightAt(f.x, f.y);
      const worn = Math.max(0, Math.min(1, f.c));
      const fade = 0.35 + 0.65 * worn;
      if (f.kind === 'tree') {
        g.ellipse(x + 3, y + 5, 11, 4.5).fill({ color: 0x000000, alpha: 0.2 });
        g.rect(x - 1.5, y - 6, 3, 8).fill(0x5a4630);
        const green = 0x4e7a3a + ((f.id * 2654435761) % 5) * 0x000402;
        g.circle(x - 4, y - 9, 8).fill({ color: green, alpha: fade });
        g.circle(x + 4, y - 7, 7).fill({ color: green, alpha: fade });
        g.circle(x, y - 13, 7.5).fill({ color: green + 0x0a0a06,
                                        alpha: fade });
      } else if (f.kind === 'bench') {
        g.poly([x - 10, y, x, y + 5, x + 10, y, x, y - 5])
          .fill({ color: 0x8a6a3f, alpha: fade });
        g.rect(x - 8, y, 2, 5).fill({ color: 0x5a4630, alpha: fade });
        g.rect(x + 6, y, 2, 5).fill({ color: 0x5a4630, alpha: fade });
      } else if (f.kind === 'table') {
        g.ellipse(x, y, 9, 4.5).fill({ color: 0x9c7f52, alpha: fade });
        g.ellipse(x, y - 2, 4.5, 2.2).fill({ color: 0x7d6440, alpha: fade });
      } else if (f.kind === 'lamp') {
        g.rect(x - 1.2, y - 16, 2.4, 18).fill({ color: 0x4a5158,
                                                alpha: fade });
        g.circle(x, y - 17, 3.8).fill({ color: 0xffca7a, alpha: 0.9 * fade });
      } else if (f.kind === 'playground') {
        g.poly([x - 22, y, x - 8, y + 7, x + 6, y, x - 8, y - 7])
          .fill({ color: 0xd8574f, alpha: fade });
        g.rect(x + 6, y - 20, 2.5, 14).fill({ color: 0x4a5158, alpha: fade });
        g.rect(x + 17, y - 20, 2.5, 14).fill({ color: 0x4a5158, alpha: fade });
        g.rect(x + 4, y - 21, 16, 2.2).fill({ color: 0x4a5158, alpha: fade });
        g.rect(x + 11, y - 20, 1.8, 9).fill({ color: 0x6d7681, alpha: fade });
      } else if (f.kind === 'shop') {
        g.circle(x, y - 4, 3).fill({ color: 0xffca7a, alpha: 0.9 });
      }
    });
  }

  /* The lamplight: additive, over the island but under the dark. It is the
   * one layer here whose *alpha* moves inside a frame rather than its
   * geometry, which is why it is a layer of its own. */
  function buildLight() {
    const g = SC.gLight, st = SC.state;
    g.clear();
    if (!st) return;
    const W = SC.ground.width, light = st.light || [];
    for (let y = 0; y < SC.ground.height; y += 2) {
      for (let x = 0; x < W; x += 2) {
        const v = light[y * W + x] || 0;
        if (!v) continue;
        const p = iso(x + 0.5, y + 0.5);
        g.ellipse(p.x, p.y - heightAt(x, y), TW * 1.2, TH * 1.2).fill({
          color: 0xffca7a, alpha: Math.min(0.20, v * 0.022),
        });
      }
    }
    g.blendMode = 'add';
  }

  /* ------------------------------------------------------------- people */

  function drawAgent(a, p, inside) {
    const r = p.role === 'child' ? 3.0 : 3.6;
    a.clear();
    const col = ROLE[p.role] || 0xcccccc;
    const al = inside ? 0.8 : 1;
    a.circle(0, -r * 1.1, r * 0.6).fill({ color: col, alpha: al });
    a.roundRect(-r * 0.68, -r * 0.4, r * 1.36, r * 1.5, r * 0.5)
      .fill({ color: col, alpha: al });
    if (p.stress >= 3) {
      a.circle(0, 0, r * 1.9).stroke({ width: 1.2, color: 0xff6b5a,
                                       alpha: 0.8 });
    }
  }

  const atop = q => {
    const s = iso(q.x + 0.5, q.y + 0.5);
    return { x: s.x, y: s.y - heightAt(Math.floor(q.x), Math.floor(q.y)) };
  };

  function syncPeople(st) {
    const seen = {};
    st.people.forEach(p => {
      seen[p.id] = 1;
      let a = SC.agents[p.id];
      if (!a) {
        a = G();
        SC.gPeople.addChild(a);
        SC.agents[p.id] = a;
      }
      const tag = p.role + p.in + (p.stress >= 3);
      if (a.__drawn !== tag) { drawAgent(a, p, p.in); a.__drawn = tag; }
      a.__to = p.in ? windowOf(p.unit) : atop(p);
      a.__from = p.pin ? windowOf(p.punit) : atop({ x: p.px, y: p.py });
      if (!a.__from) a.__from = a.__to;
      if (!a.__init) { a.position.set(a.__to.x, a.__to.y); a.__init = true; }
    });
    for (const id in SC.agents) {
      if (!seen[id]) {
        SC.gPeople.removeChild(SC.agents[id]);
        delete SC.agents[id];
      }
    }
    SC.tickMs = Math.max(300, (st.tick_seconds || 6) * 1000);
    SC.t0 = performance.now();
  }

  /* ------------------------------------------------------------- weather */

  function syncWeather(st) {
    const want = st.weather === 'rain' ? 130 : st.weather === 'storm' ? 210
      : st.weather === 'frost' ? 90 : 0;
    const g = SC.gFx;
    while (SC.drops.length > want) g.removeChild(SC.drops.pop().g);
    const e = SC.ext;
    while (SC.drops.length < want) {
      const d = G();
      const snow = st.weather === 'frost';
      const len = snow ? 0 : 7;
      d.rect(snow ? -1.6 : -0.7, -len, snow ? 3.2 : 1.4, snow ? 3.2 : len)
        .fill({ color: snow ? 0xffffff : 0x9fd0ff, alpha: snow ? 0.85 : 0.5 });
      g.addChild(d);
      /* spawned in the island's own box, never the window's: grove b43 was a
       * rain that fell into 38% of a phone screen because the box it was
       * spawned in was the canvas and the box it fell in was the world */
      SC.drops.push({ g: d, x: e.x0 + Math.random() * e.w,
                      y: e.y0 + Math.random() * e.h,
                      v: snow ? 0.5 + Math.random() * 0.5
                              : 4 + Math.random() * 3,
                      sway: Math.random() * 6.28 });
    }
  }

  function stepWeather(dt) {
    const e = SC.ext;
    const snow = SC.state && SC.state.weather === 'frost';
    SC.drops.forEach(d => {
      d.y += d.v * dt * 0.06;
      if (snow) d.x += Math.sin(d.sway += dt * 0.002) * 0.4;
      if (d.y > e.y0 + e.h) { d.y = e.y0 - 8; d.x = e.x0 + Math.random() * e.w; }
      d.g.position.set(d.x, d.y);
    });
  }

  /* ------------------------------------------------------------ the day */

  function phaseNow() {
    if (!SC.state) return 2;
    const t = (performance.now() - SC.t0) / SC.tickMs;
    return Math.max(0, Math.min(4.999, t * 5));
  }

  function tintFor(ph) {
    const i = Math.floor(ph), f = ph - i;
    const a = DAY[i], b = DAY[Math.min(4, i + 1)];
    const mix = (x, y) => x + (y - x) * f;
    const r = mix(a.c >> 16 & 255, b.c >> 16 & 255) | 0;
    const g = mix(a.c >> 8 & 255, b.c >> 8 & 255) | 0;
    const bl = mix(a.c & 255, b.c & 255) | 0;
    return { c: (r << 16) | (g << 8) | bl, a: mix(a.a, b.a) };
  }

  function darkness(ph) {
    const t = Math.max(0, Math.min(1, (ph - 2.6) / 2.0));
    return t * t;
  }

  /* ------------------------------------------------------------ the loop */

  function frame(ticker) {
    if (!SC.state) return;
    const dt = ticker.deltaMS;
    const ph = phaseNow();
    const ease = Math.min(1, (performance.now() - SC.t0) / SC.tickMs);
    const e = ease < 0.5 ? 2 * ease * ease
                         : 1 - Math.pow(-2 * ease + 2, 2) / 2;
    for (const id in SC.agents) {
      const a = SC.agents[id];
      if (!a.__to) continue;
      a.position.set(a.__from.x + (a.__to.x - a.__from.x) * e,
                     a.__from.y + (a.__to.y - a.__from.y) * e);
    }
    const tint = tintFor(ph);
    SC.overlay.tint = tint.c;
    SC.overlay.alpha = tint.a;
    paintTint();
    SC.gLight.alpha = darkness(ph);
    SC.gWin.alpha = 0.55 + 0.45 * darkness(ph);
    stepWeather(dt);
  }

  /* --------------------------------------------------------------- init */

  function extent() {
    const W = SC.ground.width, H = SC.ground.height;
    let hi = 0;
    const h = SC.heights || {};
    for (const k in h) hi = Math.max(hi, h[k]);
    const x0 = -H * TW / 2 - 20, x1 = W * TW / 2 + 20;
    const y0 = -hi - 26;
    const y1 = (W + H) * TH / 2 + SLAB + 12;
    SC.ext = { x0, y0, w: x1 - x0, h: y1 - y0 };
    return SC.ext;
  }

  function init(ground) {
    SC.ground = ground;
    SC.ground.byId = {};
    SC.ground.buildings = ground.buildings || [];
    SC.ground.unitsPer = {};
    SC.ground.buildings.forEach(b => { SC.ground.byId[b.id] = b; });
    for (const id in ground.units) {
      const u = ground.units[id];
      if (SC.ground.byId[u.b]) {
        (SC.ground.unitsPer[u.b] = SC.ground.unitsPer[u.b] || {})[id] = u;
      }
    }
    heightsOf();
    extent();

    const canvas = document.getElementById('scene');
    const app = new PIXI.Application();
    SC.app = app;
    app.init({
      canvas, resolution: Math.max(1.5, window.devicePixelRatio || 1),
      autoDensity: true, backgroundAlpha: 0, antialias: true,
    }).then(() => {
      SC.world = new PIXI.Container();
      app.stage.addChild(SC.world);
      /* the layers, in the order they are painted, each a Graphics or a
       * Container and nothing in between */
      SC.gGround = new PIXI.Graphics();
      SC.gShade = new PIXI.Graphics();
      SC.gBuild = new PIXI.Graphics();
      SC.gWin = new PIXI.Graphics();
      SC.gObj = new PIXI.Graphics();
      SC.gPeople = new PIXI.Container();
      SC.gFx = new PIXI.Container();
      SC.gLight = new PIXI.Graphics();
      SC.gMark = new PIXI.Graphics();
      [SC.gGround, SC.gShade, SC.gBuild, SC.gWin, SC.gObj, SC.gPeople,
       SC.gFx, SC.gLight, SC.gMark].forEach(l => SC.world.addChild(l));

      /* the tint lies over the island but under the lamplight: the dark
       * comes from the sun going down and the glow from the lamps, and a
       * lamp the night darkens is not a lamp */
      SC.overlay = { tint: 0xffffff, alpha: 0 };
      SC.tintRect = G();
      SC.tintRect.rect(0, 0, 1, 1).fill(0xffffff);
      SC.world.addChild(SC.tintRect);
      SC.world.addChild(SC.gLight);
      SC.world.addChild(SC.gMark);

      buildGround(SC.state || { season: 0 });
      size();
      app.ticker.add(frame);
      SC.built = true;
      if (SC.pending) { update(SC.pending); SC.pending = null; }
    });
  }

  /* -------------------------------------------------------------- update */

  function update(st) {
    if (!SC.built) { SC.pending = st; return; }
    SC.state = st;
    /* the ground carries the day's shade baked into it, so it is rebuilt
     * when the day turns rather than when the season does — once a day,
     * and never inside a frame */
    const key = st.day + ':' + st.season;
    if (key !== SC.shadeKey) {
      buildGround(st);
      SC.shadeKey = key;
    }
    buildWindows();
    buildObjects();
    buildLight();
    syncPeople(st);
    syncWeather(st);
  }

  /* ------------------------------------------------------------- camera */

  function size() {
    const sc = document.getElementById('scroller');
    const vw = sc.clientWidth, vh = sc.clientHeight;
    const e = extent();
    const fit = Math.min((vw - 2 * PAD) / e.w, (vh - 2 * PAD) / e.h);
    const zoom = (typeof S !== 'undefined' && S.zoom) || 0;
    SC.scale = zoom === 0 ? fit : zoom;
    if (zoom === 0) {
      SC.cw = vw; SC.ch = vh;
      SC.ox = (vw - e.w * SC.scale) / 2 - e.x0 * SC.scale;
      SC.oy = (vh - e.h * SC.scale) / 2 - e.y0 * SC.scale;
    } else {
      SC.cw = e.w * SC.scale + 2 * PAD;
      SC.ch = e.h * SC.scale + 2 * PAD;
      SC.ox = PAD - e.x0 * SC.scale;
      SC.oy = PAD - e.y0 * SC.scale;
    }
    SC.app.renderer.resize(SC.cw, SC.ch);
    SC.world.position.set(SC.ox, SC.oy);
    SC.world.scale.set(SC.scale);
    SC.tintRect.clear();
    SC.tintRect.rect(e.x0, e.y0, e.w, e.h).fill(0xffffff);
    paintTint();
    mark();
  }

  function paintTint() {
    if (!SC.tintRect) return;
    SC.tintRect.tint = SC.overlay.tint;
    SC.tintRect.alpha = SC.overlay.alpha;
  }

  function ring(g, x, y, color, width) {
    const A = iso(x, y), B = iso(x + 1, y), C = iso(x + 1, y + 1),
          D = iso(x, y + 1), h = heightAt(x, y);
    g.poly([A.x, A.y - h, B.x, B.y - h, C.x, C.y - h, D.x, D.y - h])
      .stroke({ width, color, alpha: 0.95 });
  }

  function mark() {
    const g = SC.gMark;
    g.clear();
    const sel = (typeof S !== 'undefined' && S.sel) || null;
    if (!sel) return;
    if (sel.kind === 'cell') {
      ring(g, sel.x, sel.y, 0xffca7a, 2);
    } else if (sel.kind === 'building') {
      const b = SC.ground.byId[sel.id];
      if (!b) return;
      const h = Math.max(1, b.floors) * FLOOR;
      const pts = [];
      [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h],
       [b.x, b.y + b.h]].forEach(([x, y]) => {
        const p = iso(x, y);
        pts.push(p.x, p.y - h);
      });
      g.poly(pts).stroke({ width: 2.5, color: 0xffca7a, alpha: 0.95 });
    }
  }

  /* Picking inverts the projection. It ignores height, so a click high on a
   * tall block lands on the cell behind it — which is the honest reading of
   * a click on a roof, and better than a guess. */
  function cellAt(clientX, clientY) {
    const r = document.getElementById('scene').getBoundingClientRect();
    const sx = (clientX - r.left - SC.ox) / SC.scale;
    const sy = (clientY - r.top - SC.oy) / SC.scale;
    const u = sx / (TW / 2), v = sy / (TH / 2);
    const x = Math.floor((u + v) / 2), y = Math.floor((v - u) / 2);
    if (x < 0 || y < 0 || x >= SC.ground.width || y >= SC.ground.height) {
      return null;
    }
    return { x, y };
  }

  function pick(x, y) {
    const st = SC.state;
    if (!st) return;
    const tol = 0.7;
    let best = null, bd = 1e9;
    st.people.forEach(p => {
      if (p.in) return;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < tol && d < bd) { bd = d; best = p; }
    });
    if (best) {
      S.sel = { kind: 'resident', id: best.id };
      Panels.card();
      return;
    }
    const f = st.fixtures.filter(f => f.x === x && f.y === y)[0];
    if (f) {
      S.sel = { kind: 'fixture', id: f.id };
      Panels.card();
      return;
    }
    const b = SC.ground.buildings.filter(b =>
      x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h)[0];
    if (b) {
      S.sel = { kind: 'building', id: b.id };
      Panels.card();
      mark();
      return;
    }
    S.sel = { kind: 'cell', x, y };
    Panels.card();
    mark();
  }

  /* `dbg` is the scene's own state, not a copy of it: a check asserting
   * against a second copy of the facts would pass while the picture was
   * wrong, which is the failure this whole page exists to avoid. Nothing in
   * the page reads it. */
  return { init, update, resize: size, cellAt, pick, mark, dbg: SC,
           iso, heightAt };
})();
