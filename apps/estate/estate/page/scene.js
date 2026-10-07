/* scene — the plan, drawn with PixiJS.
 *
 * The grove's island is isometric because a forest has no edges. The estate
 * is a *plan*: a rectangle of ground with a road round it and blocks set in
 * it, and it is drawn the way a plan is drawn — flat, from above, one cell
 * a square. The depth comes from the day instead of from the projection:
 * the light crosses the plan as the day turns, the lamps come on, the
 * windows fill, and people walk out of their doors and back in.
 *
 * Everything here is *shown*, never decided. The scene reads the frame the
 * server sends and draws it; where a fact is missing it draws nothing
 * rather than guessing one, because a guess in a renderer is a second copy
 * of a fact the engine already owns (grove b2/b34).
 */

'use strict';

const Scene = (() => {
  const PAD = 26;                    // px of air around the plan

  /* cell colours by season — the ground is redrawn when the season turns,
   * which is four times a year and never inside a frame */
  const GROUND = {
    0: { lawn: 0x6f8f52, road: 0x3a4048, path: 0x938a7b, paved: 0x6d6a63,
         play: 0xb5945a, water: 0x3d6f88, building: 0x272c33 },
    1: { lawn: 0x63863c, road: 0x3d434b, path: 0x9a9080, paved: 0x726e66,
         play: 0xbe9a58, water: 0x3a7392, building: 0x272c33 },
    2: { lawn: 0x8a7c3e, road: 0x383e45, path: 0x8d8474, paved: 0x6a675f,
         play: 0xb08a4c, water: 0x39677d, building: 0x272c33 },
    3: { lawn: 0x8b9189, road: 0x343a41, path: 0x8c8c8c, paved: 0x6b6b6b,
         play: 0xa89a80, water: 0x35586b, building: 0x272c33 },
  };

  /* the day's five phases, as colour and weight laid over the plan. A tint
   * of alpha 0 is no tint at all — which is midday, and it must be said
   * rather than inferred from a colour that happens to be pale. */
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
    agents: {}, drops: [], season: -1, built: false,
    scale: 1, ox: 0, oy: 0, cw: 0, ch: 0,
  };

  const G = () => new PIXI.Graphics();

  /* ------------------------------------------------------------ geometry */

  function bbox(b) {                  // a building's world-px box
    return { x: b.x * CELL, y: b.y * CELL,
             w: b.w * CELL, h: b.h * CELL };
  }

  /* where a resident is when they are in: a window of their own flat. A
   * person indoors is a state, not a coordinate (the pack's interior note),
   * and this is how a state gets drawn — not by inventing a coordinate for
   * them on the plan, which would put a family of four on the doorstep. */
  function windowOf(unit) {
    const u = SC.ground.units[String(unit)];
    if (!u) return null;
    const b = SC.ground.byId[u.b];
    const cx = b.x + 0.6 + (u.i + 0.5) / u.n * Math.max(0.1, b.w - 1.2);
    const cy = b.y + 0.55 + (u.f - 0.45) / Math.max(1, u.floors) *
      Math.max(0.1, b.h - 1.1);
    return { x: cx * CELL, y: cy * CELL };
  }

  /* --------------------------------------------------------------- build */

  function buildGround(season) {
    const g = SC.gGround, pal = GROUND[season] || GROUND[0];
    const codes = SC.ground.codes, rows = SC.ground.rows;
    g.clear();
    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < rows[y].length; x++) {
        const site = codes[rows[y][x]];
        g.rect(x * CELL, y * CELL, CELL + 0.5, CELL + 0.5)
          .fill(pal[site] !== undefined ? pal[site] : 0x000000);
      }
    }
    /* the pavements read as a curb once the lawn is textured — one thin
     * lighter line on the road's inner edge is all it takes */
    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < rows[y].length; x++) {
        if (codes[rows[y][x]] !== 'road') continue;
        g.rect(x * CELL, y * CELL, CELL + 0.5, 1.5)
          .fill({ color: 0xffffff, alpha: 0.06 });
      }
    }
    SC.season = season;
  }

  function buildBuildings() {
    const g = SC.gBuild;
    g.clear();
    SC.ground.buildings.forEach(b => {
      const x = b.x * CELL, y = b.y * CELL;
      const w = b.w * CELL, h = b.h * CELL;
      g.rect(x + 3, y + 5, w, h).fill({ color: 0x000000, alpha: 0.30 });
      g.rect(x, y, w, h).fill(0x2f3640);
      g.rect(x, y, w, h * 0.32).fill(0x3b434e);       // a lighter roof edge
      g.rect(x, y, w, 2).fill(0x596470);
      g.rect(x, y, 2, h).fill(0x596470);
      g.rect(x + w - 2, y, 2, h).fill(0x232830);
      g.rect(x, y + h - 2, w, 2).fill(0x232830);
      /* the door: the one walkable cell outside the footprint, drawn where
       * the engine says it is, not where it looks right */
      g.rect(b.door[0] * CELL + CELL * 0.25, b.door[1] * CELL + CELL * 0.2,
             CELL * 0.5, CELL * 0.7).fill(0x8a6a3f);
      if (b.kind === 'shop') {
        g.rect(x + w * 0.15, y + h * 0.62, w * 0.7, 5)
          .fill({ color: 0xffca7a, alpha: 0.75 });
      }
    });
  }

  /* windows: one small pane per flat, lit at night by whether a household
   * actually lives there. This is the census drawn rather than written. */
  function buildWindows() {
    const g = SC.gWin, st = SC.state;
    g.clear();
    if (!st) return;
    const lived = {};
    (st.buildings || []).forEach(b => {
      const seen = new Set();
      st.people.forEach(p => {
        if (p.in && p.unit != null) {
          const u = SC.ground.units[String(p.unit)];
          if (u && u.b === b.id) seen.add(u.f);
        }
      });
      lived[b.id] = seen;
    });
    SC.ground.buildings.forEach(b => {
      const u = SC.ground.unitsPer[b.id] || {};
      for (const id in u) {
        const w = u[id];
        const pos = windowOf(id);
        if (!pos) continue;
        const on = (lived[b.id] || new Set()).has(w.f);
        g.circle(pos.x, pos.y, 2.6).fill({
          color: on ? 0xffca7a : 0x1d2229,
          alpha: on ? 0.95 : 0.55,
        });
      }
    });
  }

  function buildObjects() {
    const g = SC.gObj, st = SC.state;
    g.clear();
    if (!st) return;
    st.fixtures.forEach(f => {
      const x = f.x * CELL + CELL / 2, y = f.y * CELL + CELL / 2;
      const worn = Math.max(0, Math.min(1, f.c));
      const fade = 0.35 + 0.65 * worn;      // a broken thing goes grey
      if (f.kind === 'tree') {
        g.ellipse(x + 4, y + 7, 12, 5).fill({ color: 0x000000, alpha: 0.22 });
        g.rect(x - 1.6, y - 2, 3.2, 9).fill(0x5a4630);
        const green = 0x4e7a3a + ((f.id * 2654435761) % 5) * 0x000402;
        g.circle(x - 5, y - 6, 9).fill({ color: green, alpha: fade });
        g.circle(x + 5, y - 4, 8).fill({ color: green, alpha: fade });
        g.circle(x, y - 11, 8.5).fill({ color: green + 0x0a0a06,
                                        alpha: fade });
      } else if (f.kind === 'bench') {
        g.rect(x - 11, y - 3, 22, 3).fill({ color: 0x8a6a3f, alpha: fade });
        g.rect(x - 11, y + 1, 22, 3).fill({ color: 0x76593a, alpha: fade });
        g.rect(x - 10, y + 4, 2.5, 4).fill({ color: 0x5a4630, alpha: fade });
        g.rect(x + 8, y + 4, 2.5, 4).fill({ color: 0x5a4630, alpha: fade });
      } else if (f.kind === 'table') {
        g.circle(x, y, 9).fill({ color: 0x9c7f52, alpha: fade });
        g.circle(x, y, 4.5).fill({ color: 0x7d6440, alpha: fade });
      } else if (f.kind === 'lamp') {
        g.rect(x - 1.4, y - 12, 2.8, 16).fill({ color: 0x4a5158, alpha: fade });
        g.circle(x, y - 13, 4.2).fill({ color: 0xffca7a, alpha: 0.9 * fade });
      } else if (f.kind === 'playground') {
        /* drawn on the play ground it stands on, which is a rectangle of
         * cells, not one cell — the fixture's cell is its anchor */
        g.rect(x - 26, y - 14, 12, 12).fill({ color: 0xd8574f, alpha: fade });
        g.rect(x - 24, y - 12, 8, 8).fill({ color: 0xf0e6d2, alpha: fade });
        g.rect(x + 8, y - 14, 3, 14).fill({ color: 0x4a5158, alpha: fade });
        g.rect(x + 20, y - 14, 3, 14).fill({ color: 0x4a5158, alpha: fade });
        g.rect(x + 6, y - 15, 19, 2.5).fill({ color: 0x4a5158, alpha: fade });
        g.rect(x + 12, y - 14, 2, 9).fill({ color: 0x6d7681, alpha: fade });
        g.rect(x - 6, y - 10, 10, 3).fill({ color: 0x5aa9c8, alpha: fade });
      } else if (f.kind === 'shop') {
        g.circle(x, y, 3).fill({ color: 0xffca7a, alpha: 0.9 });
      }
    });
  }

  /* the two fields the estate actually has. Shade is built once a day and
   * its alpha is left alone; light is built once a day and its alpha is
   * animated with the sun — so the plan is not rebuilt inside a frame. */
  function buildFields() {
    const st = SC.state;
    const sh = SC.gShade, li = SC.gLight;
    sh.clear(); li.clear();
    if (!st) return;
    const w = SC.ground.width;
    for (let i = 0; i < st.shade.length; i++) {
      const v = st.shade[i];
      if (!v) continue;
      const x = (i % w) * CELL, y = ((i / w) | 0) * CELL;
      sh.rect(x, y, CELL + 0.5, CELL + 0.5)
        .fill({ color: 0x0a1a10, alpha: Math.min(0.42, v * 0.045) });
    }
    for (let i = 0; i < st.light.length; i++) {
      const v = st.light[i];
      if (!v) continue;
      const x = (i % w) * CELL, y = ((i / w) | 0) * CELL;
      li.circle(x + CELL / 2, y + CELL / 2, CELL * 0.62)
        .fill({ color: 0xffca7a, alpha: Math.min(0.30, v * 0.034) });
    }
    li.blendMode = 'add';
  }

  /* ------------------------------------------------------------- people */

  function makeAgent(p) {
    const g = G();
    g.__id = p.id;
    return g;
  }

  function drawAgent(a, p, inside) {
    const r = p.role === 'child' ? 3.1 : 3.8;
    a.clear();
    const col = ROLE[p.role] || 0xcccccc;
    a.circle(0, -r * 0.9, r * 0.62).fill({ color: col, alpha: inside ? 0.85 : 1 });
    a.roundRect(-r * 0.72, -r * 0.15, r * 1.44, r * 1.5, r * 0.5)
      .fill({ color: col, alpha: inside ? 0.85 : 1 });
    if (p.stress >= 3) {
      a.circle(0, 0, r * 1.9).stroke({ width: 1.2, color: 0xff6b5a,
                                       alpha: 0.8 });
    }
    a.__drawn = p.role + inside + (p.stress >= 3);
  }

  function syncPeople(st) {
    const seen = {};
    st.people.forEach(p => {
      seen[p.id] = 1;
      let a = SC.agents[p.id];
      if (!a) {
        a = makeAgent(p);
        SC.gPeople.addChild(a);
        SC.agents[p.id] = a;
      }
      const tag = p.role + p.in + (p.stress >= 3);
      if (a.__drawn !== tag) drawAgent(a, p, p.in);
      a.__p = p;
      a.__to = p.in ? windowOf(p.unit) : { x: p.x * CELL + CELL / 2,
                                           y: p.y * CELL + CELL / 2 };
      a.__from = p.pin ? windowOf(p.punit)
        : { x: p.px * CELL + CELL / 2, y: p.py * CELL + CELL / 2 };
      if (!a.__from) a.__from = a.__to;
      if (!a.__init) {
        a.position.set(a.__to.x, a.__to.y);
        a.__init = true;
      }
    });
    for (const id in SC.agents) {
      if (!seen[id]) { SC.gPeople.removeChild(SC.agents[id]); delete SC.agents[id]; }
    }
    SC.tickMs = Math.max(300, (st.tick_seconds || 6) * 1000);
    SC.t0 = performance.now();
  }

  /* ------------------------------------------------------------- weather */

  function seasonOf(st) { return st.season; }

  function syncWeather(st) {
    const want = st.weather === 'rain' ? 130 : st.weather === 'storm' ? 210
      : st.weather === 'frost' ? 90 : st.weather === 'heat' ? 0 : 0;
    const g = SC.gFx;
    while (SC.drops.length > want) {
      g.removeChild(SC.drops.pop().g);
    }
    const pw = SC.ground.width * CELL, ph = SC.ground.height * CELL;
    while (SC.drops.length < want) {
      const d = G();
      const snow = st.weather === 'frost';
      const len = snow ? 0 : 7;
      d.rect(snow ? -1.6 : -0.7, -len, snow ? 3.2 : 1.4, snow ? 3.2 : len)
        .fill({ color: snow ? 0xffffff : 0x9fd0ff, alpha: snow ? 0.85 : 0.5 });
      g.addChild(d);
      /* spawned in the plan's own box, never the window's: grove b43 was a
       * rain that fell into 38% of a phone screen because the box it was
       * spawned in was the canvas and the box it fell in was the world */
      SC.drops.push({ g: d, x: Math.random() * pw, y: Math.random() * ph,
                      v: snow ? 0.5 + Math.random() * 0.5
                              : 4 + Math.random() * 3,
                      sway: Math.random() * 6.28 });
    }
  }

  function stepWeather(dt) {
    const pw = SC.ground.width * CELL, ph = SC.ground.height * CELL;
    const snow = SC.state && SC.state.weather === 'frost';
    SC.drops.forEach(d => {
      d.y += d.v * dt * 0.06;
      if (snow) { d.x += Math.sin(d.sway += dt * 0.002) * 0.4; }
      if (d.y > ph) { d.y = -8; d.x = Math.random() * pw; }
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
    const ca = (a.c >> 16 & 255), cb = (b.c >> 16 & 255);
    const ga = (a.c >> 8 & 255), gb = (b.c >> 8 & 255);
    const ba = (a.c & 255), bb = (b.c & 255);
    const r = mix(ca, cb) | 0, gg = mix(ga, gb) | 0, bl = mix(ba, bb) | 0;
    return { c: (r << 16) | (gg << 8) | bl, a: mix(a.a, b.a) };
  }

  function darkness(ph) {
    // 0 in daylight, 1 deep night — what the lamps are measured against
    const t = Math.max(0, Math.min(1, (ph - 2.6) / 2.0));
    return t * t;
  }

  /* ------------------------------------------------------------ the loop */

  function frame(ticker) {
    if (!SC.state) return;
    const dt = ticker.deltaMS;
    const ph = phaseNow();
    const ease = Math.min(1, (performance.now() - SC.t0) / SC.tickMs);
    const e = ease < 0.5 ? 2 * ease * ease : 1 - Math.pow(-2 * ease + 2, 2) / 2;

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

  function init(ground) {
    SC.ground = ground;
    SC.ground.byId = {};
    SC.ground.buildings = (ground.buildings || []);
    SC.ground.unitsPer = {};
    (ground.buildings || []).forEach(b => { SC.ground.byId[b.id] = b; });
    for (const id in ground.units) {
      const u = ground.units[id];
      const b = SC.ground.byId[u.b];
      if (!b) continue;
      (SC.ground.unitsPer[u.b] = SC.ground.unitsPer[u.b] || {})[id] = u;
    }

    const canvas = document.getElementById('scene');
    const app = new PIXI.Application();
    SC.app = app;

    app.init({
      canvas, resolution: Math.max(1.5, window.devicePixelRatio || 1),
      autoDensity: true, backgroundAlpha: 0, antialias: true,
    }).then(() => {
      SC.world = new PIXI.Container();
      app.stage.addChild(SC.world);
      /* The layers, in the order they are painted, each a Graphics or a
       * Container and nothing in between: a layer wrapped in a container
       * it does not need is a level of indirection the picture does not
       * have, and the check that reads this order would be reading the
       * wrapper rather than the drawing. */
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

      /* the tint is the last thing over the plan and the first thing under
       * nothing: one rect the size of the world, its colour moved with the
       * day. Repainted in place — a rect rebuilt every frame is a leak
       * wearing a colour (grove's texture leak, b26's family). */
      SC.overlay = { tint: 0xffffff, alpha: 0 };
      const g0 = G();
      g0.rect(0, 0, 1, 1).fill(0xffffff);
      SC.tintRect = g0;
      /* The tint lies over the plan but *under* the lamplight: the dark
       * comes from the sun going down and the glow comes from the lamps,
       * and a lamp the night darkens is not a lamp. The selection ring
       * goes above both, or it is invisible exactly when it is needed. */
      SC.world.addChild(SC.tintRect);
      SC.world.addChild(SC.gLight);
      SC.world.addChild(SC.gMark);

      buildGround(SC.state ? SC.state.season : 0);
      buildBuildings();
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
    if (st.season !== SC.season) buildGround(st.season);
    buildWindows();
    buildObjects();
    buildFields();
    syncPeople(st);
    syncWeather(st);
  }

  /* ------------------------------------------------------------- camera */

  function size() {
    const sc = document.getElementById('scroller');
    const vw = sc.clientWidth, vh = sc.clientHeight;
    const pw = SC.ground.width * CELL, ph = SC.ground.height * CELL;
    const fit = Math.min((vw - 2 * PAD) / pw, (vh - 2 * PAD) / ph);
    const zoom = (typeof S !== 'undefined' && S.zoom) || 0;
    SC.scale = zoom === 0 ? fit : zoom;
    if (zoom === 0) {
      SC.cw = vw; SC.ch = vh;
      SC.ox = (vw - pw * SC.scale) / 2;
      SC.oy = (vh - ph * SC.scale) / 2;
    } else {
      SC.cw = pw * SC.scale + 2 * PAD;
      SC.ch = ph * SC.scale + 2 * PAD;
      SC.ox = PAD; SC.oy = PAD;
    }
    SC.app.renderer.resize(SC.cw, SC.ch);
    SC.world.position.set(SC.ox, SC.oy);
    SC.world.scale.set(SC.scale);
    SC.tintRect.clear();
    SC.tintRect.rect(0, 0, pw, ph).fill(0xffffff);
    paintTint();
    mark();
  }

  /* the tint rect is inside the scaled world, so its position and size are
   * world units; its colour is the only thing the day moves */
  function paintTint() {
    if (!SC.tintRect) return;
    SC.tintRect.tint = SC.overlay.tint;
    SC.tintRect.alpha = SC.overlay.alpha;
  }

  function mark() {
    const g = SC.gMark;
    g.clear();
    const sel = (typeof S !== 'undefined' && S.sel) || null;
    if (!sel) return;
    if (sel.kind === 'cell') {
      g.rect(sel.x * CELL, sel.y * CELL, CELL, CELL)
        .stroke({ width: 2, color: 0xffca7a, alpha: 0.95 });
    } else if (sel.kind === 'building') {
      const b = SC.ground.byId[sel.id];
      if (b) g.rect(b.x * CELL, b.y * CELL, b.w * CELL, b.h * CELL)
        .stroke({ width: 2.5, color: 0xffca7a, alpha: 0.95 });
    }
  }

  function cellAt(clientX, clientY) {
    const r = document.getElementById('scene').getBoundingClientRect();
    const x = (clientX - r.left - SC.ox) / SC.scale / CELL;
    const y = (clientY - r.top - SC.oy) / SC.scale / CELL;
    if (x < 0 || y < 0 || x >= SC.ground.width || y >= SC.ground.height) {
      return null;
    }
    return { x: Math.floor(x), y: Math.floor(y) };
  }

  /* clicking asks the same question a person would: is somebody here? If
   * not, what is this place? The answer comes from the frame, never from
   * the picture. */
  function pick(x, y) {
    const st = SC.state;
    if (!st) return;
    const tol = 0.6;
    let best = null, bd = 1e9;
    st.people.forEach(p => {
      if (p.in) return;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < tol && d < bd) { bd = d; best = p; }
    });
    if (best) { S.sel = { kind: 'resident', id: best.id }; Panels.card(); return; }
    const f = st.fixtures.filter(f => f.x === x && f.y === y)[0];
    if (f) { S.sel = { kind: 'fixture', id: f.id }; Panels.card(); return; }
    const b = SC.ground.buildings.filter(b =>
      x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h)[0];
    if (b) { S.sel = { kind: 'building', id: b.id }; Panels.card('building'); mark(); return; }
    S.sel = { kind: 'cell', x, y };
    Panels.card();
    mark();
  }

  /* `dbg` is the scene's own state, not a copy of it: a check that
   * asserts against a second copy of the facts would pass while the
   * picture was wrong, which is the failure this whole page exists to
   * avoid. Nothing in the page reads it. */
  return { init, update, resize: size, cellAt, pick, mark, dbg: SC };
})();
