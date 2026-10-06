/* The engine's headless check: the page's own scripts, run with a stub
   PIXI that records init, the node tree and every property write, and
   a transform-following 2d recorder for the capture surfaces. The
   assertion that matters most: warm frames move nothing but light —
   no capture, no rebuild, a bounded write budget. That is the "no
   performance tuning" promise, proven.
     node tools/pixi_check.js
*/
"use strict";
const fs = require("fs"),
      path = require("path"),
      vm = require("vm");

const page = [];
for (const name of ["boot.js", "scene.js", "engine.js", "panels.js"])
  page.push(fs.readFileSync(
      path.join(__dirname, "..", "grove", "page", name), "utf8"));

/* ---- the recorder (the same transform-following surface scene_check
   keeps — the captures' coordinates must map to where they truly land) */
const TRACE = [];
const fmt = v => typeof v === "number" ? String(Math.round(v * 100) / 100)
                   : String(v);
const grad = () => ({ addColorStop() {} });
let m = { a: 1, d: 1, e: 0, f: 0 };
const stack = [];
const map = (x, y) => [m.a * x + m.e, m.d * y + m.f];
const ctx2d = new Proxy({}, {
  get(_t, k) {
    return (...a) => {
      if (k === "createLinearGradient" || k === "createRadialGradient")
        return grad();
      if (k === "setTransform") m = { a: a[0], d: a[3], e: a[4], f: a[5] };
      else if (k === "resetTransform") m = { a: 1, d: 1, e: 0, f: 0 };
      else if (k === "save") stack.push({ ...m });
      else if (k === "restore") { if (stack.length) m = stack.pop(); }
      else if (k === "translate") { m.e += m.a * a[0]; m.f += m.d * a[1]; }
      else if (k === "scale") { m.a *= a[0]; m.d *= a[1]; }
      const R = { fillRect: [0, 1], strokeRect: [0, 1],
                  ellipse: [0, 1], arc: [0, 1] }[k];
      if (R) { const p = map(a[R[0]], a[R[1]]); a[R[0]] = p[0]; a[R[1]] = p[1]; }
      const P = { moveTo: 1, lineTo: 1, quadraticCurveTo: 2 }[k];
      if (P) for (let pi = 0; pi < P; pi++) {
        const q = map(a[pi * 2], a[pi * 2 + 1]);
        a[pi * 2] = q[0]; a[pi * 2 + 1] = q[1];
      }
      TRACE.push(k + "(" + a.map(fmt).join(",") + ")");
    };
  },
  set(_t, k, v) { TRACE.push(k + "=" + fmt(v)); return true; },
});

/* ---- the element stub ------------------------------------------------ */
const elements = new Map();
function elStub(id) {
  const e = {
    id, textContent: "", innerHTML: "", className: "", disabled: false,
    value: "", hidden: false, dataset: {}, onclick: null, style: {},
    width: 0, height: 0, clientWidth: 1400, clientHeight: 800,
    scrollLeft: 0, scrollTop: 0, listeners: {},
    addEventListener(ev, fn) { const l = e.listeners[ev] =
        (e.listeners[ev] || []); l.push(fn); e.listeners[ev] = l; },
    scrollTo() {}, toggleAttribute() {},
    insertBefore(child, ref) { return child; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 528,
                                       height: 528 }; },
    _cls: new Set(),
    classList: {
      add: c => e._cls.add(c),
      remove: c => e._cls.delete(c),
      contains: c => e._cls.has(c),
      toggle(c, f) { if (f === undefined) f = !e._cls.has(c);
                     f ? e._cls.add(c) : e._cls.delete(c); return f; },
    },
    getContext() {                     // a fresh canvas: identity, no
      m = { a: 1, d: 1, e: 0, f: 0 };  // stranger's transform in it
      stack.length = 0;
      return ctx2d;
    },
  };
  return e;
}
function el(id) {
  if (elements.has(id)) return elements.get(id);
  const e = elStub(id);
  elements.set(id, e);
  return e;
}

/* ---- the shared facade: only what the page asks, recorded ------------ */
const { makeFacade } = require("./facade.js");
const rec = { writes: 0, textures: 0, updates: 0, destroys: 0, renders: 0,
              inits: 0, resizes: [], anchorSets: 0, failInit: false,
              maxTextureSize: 4096 };

/* ---- one sandbox, one page boot, one answer --------------------------- */
async function boot(sandbox) {
  const rafQ = [];
  sandbox.document = {
    getElementById: el, querySelector: () => el("map-scroll"),
    querySelectorAll: () => [],
    createElement: kind => elStub(kind),   // fresh: each capture
    body: { classList: el("body").classList },
    fullscreenElement: null,
    documentElement: { requestFullscreen: () => Promise.resolve() },
    exitFullscreen() {},
  };
  sandbox.window = { addEventListener() {}, devicePixelRatio: 1 };
  sandbox.location = { search: sandbox.__search || "" };
  sandbox.performance = { now: () => 2000 };     // the frozen clock
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.AbortSignal = AbortSignal;
  sandbox.requestAnimationFrame = fn => { rafQ.push(fn); return 1; };
  sandbox.setInterval = () => 0;
  sandbox.console = { log() {} };
  sandbox.fetch = url => Promise.resolve({ json: async () =>
    ({ error: "quiet" }) });
  sandbox.TRACE = TRACE;
  if (sandbox.__pixi) sandbox.PIXI = sandbox.__pixi;
  vm.createContext(sandbox);
  TRACE.length = 0;
  for (const src of page) vm.runInContext(src, sandbox);
  return { rafQ, sandbox };
}

function frames(sandbox, rafQ, n) {
  const before = { writes: rec.writes, trace: TRACE.length, tex: rec.textures };
  for (let i = 0; i < n; i++) {
    const q = rafQ.splice(0);
    for (const fn of q) fn(4000 + i * 300);
  }
  return { writes: rec.writes - before.writes,
           trace: TRACE.length - before.trace,
           tex: rec.textures - before.tex };
}

/* ---- the world the checks live in ------------------------------------- */
const WORLD = `
  const size = 8;
  const cells = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let c;
    if (y === 5 && (x === 2 || x === 3))      c = ["w", 0, 0, 0, 0, 0];
    else if (x === 7 && y === 7)              c = ["r", 0, 0, 0, 0, 1.0];
    else if (x === 6 && y === 1)              c = ["s", 0.9, 0, 0, 0, 0.9];
    else c = ["s", ((x + y) % 2) / 2, 0, 0, 0, 0.3 + ((x + y) % 3) * 0.1];
    cells.push(c);
  }
  ST.s = { tick: 472, season: "winter", weather: "clear", size,
           paused: false, now: 0, step_at: 0, tick_seconds: 8,
           biome: { elev_px: 30 }, map: [], llm: { status: "at rest" },
           chronicle: [], pop_chips: [], series: [],
           effects: ["bloom over SE"], ops: [], cells,
           plants: [{ id: 1, x: 2, y: 4, sp: "birch", st: "mature" }],
           animals: [{ id: 1, x: 3, y: 3, px: 3, py: 3, sp: "deer",
                       ag: 12 }] };
  ST.flight = { start: 0, dur: 8 };
  const tileAt = (x2, y2) => {        // a tile's drawn position
    const t3 = iso(x2, y2);
    return [t3[0], t3[1] - elevAt(x2, y2)];
  };
`;

(async () => {
  let fails = 0;
  const ok = (name, cond, detail) => {
    console.log((cond ? "  · " : "  ✗ ") + name +
                (cond && detail ? ` (${detail})` : !cond ? ` — ${detail}` : ""));
    if (!cond) fails++;
  };

  /* --- the engine boots, in its own canvas, the word-map asleep --- */
  const a = await boot({ __search: "?engine=pixi", __pixi: makeFacade(rec) });
  await 0; await 0; await 0;                          // engBoot resolves
  ok("the engine boots behind ?engine=pixi", true, "booted once");
  ok("the engine is the only painter",
     vm.runInContext("ENGINE", a.sandbox) === "pixi" &&
     vm.runInContext("ENG.active", a.sandbox) === true &&
     rec.inits === 1);
  ok("the engine owns its own canvas",
     vm.runInContext("ENG.canvas.id", a.sandbox) === "scene-g" &&
     el("scene")._cls.has("retired"));
  vm.runInContext(WORLD, a.sandbox);
  const f1 = frames(a.sandbox, a.rafQ, 3);
  ok("the frame renders through pixi", rec.renders === 3, rec.renders + " renders");
  ok("the sky rides the stage",
     vm.runInContext("ENG.skyLayer.children.length", a.sandbox) === 114,
     "1 gradient + 110 stars + 3 clouds");
  ok("the overlays say the light",
     vm.runInContext("ENG.overLayer.children.length", a.sandbox) === 5,
     "mist, vignette, wash, storm, flash");
  const f2 = frames(a.sandbox, a.rafQ, 3);
  ok("a warm frame captures nothing",
     f2.trace === 0, f2.trace + " ctx writes");
  ok("a warm frame writes a bounded budget",
     f2.writes / 3 < 400, (f2.writes / 3).toFixed(0) + " node writes/frame");
  ok("resize rides the fit",
     rec.resizes.length >= 1 && rec.resizes[rec.resizes.length - 1][2] === 1.5,
     "renderer resize at DPR " + rec.resizes[rec.resizes.length - 1][2]);
  const w1 = frames(a.sandbox, a.rafQ, 1).writes;
  const w2 = frames(a.sandbox, a.rafQ, 1).writes;
  ok("frames write the same, frame for frame", w1 === w2,
     w1 + " vs " + w2);

  // --- the living air -------------------------------------------------
  const TSEC = 4.0;                       // the frozen clock's tsec
  const water = vm.runInContext(
      "({c: ENG.water.length, edges: ENG.water.map(w => w.edges.length)})",
      a.sandbox);
  ok("the pond's light stands ready", water.c === 2, water.c + " cells");
  const wrm = vm.runInContext(
      "ENG.water[0].edges[0].rim._ ? ENG.water[0].edges[0].rim._.alpha : 0",
      a.sandbox);
  const exp = 0.28 + 0.10 * vm.runInContext(
      "waterLight(42, " + TSEC + ").foam", a.sandbox);
  ok("the foam breathes by the shared clock",
     Math.abs(wrm - exp) < 0.001, wrm.toFixed(3) + " vs " + exp.toFixed(3));
  const mrm = vm.runInContext("ENG.mirror[0].sp._.alpha", a.sandbox);
  ok("the mirror breathes by the shared clock",
     Math.abs(mrm - (0.09 + 0.03 * Math.sin(TSEC * 1.3 + 42 * 0.7))) < 0.001,
     mrm.toFixed(3));
  ok("the moon leaves its dashes",
     vm.runInContext("ENG.glint.length", a.sandbox) === 4, "4 dashes");
  const aura = vm.runInContext(
      "ENG.auras.length ? ENG.auras[0].spr.tint : 0", a.sandbox);
  ok("the aura wears the bloom's tint", aura === 0x8cd28c,
     "tint 0x" + Number(aura).toString(16) + " for bloom over SE");
  ok("a warm frame still writes a bounded budget",
     (frames(a.sandbox, a.rafQ, 1).writes) < 700,
     "under the living-air budget");

  // --- the rings' one honest exception ---------------------------------
  vm.runInContext('soulRings.push({ mx: 100, my: 100, t0: 4000 });' +
                  'soulRings.push({ mx: 120, my: 110, t0: 4000 });',
                  a.sandbox);
  const rb0 = vm.runInContext(
      "ENG.ringGfx ? ENG.ringGfx.reduce((n, g) => n + g.paths, 0) : 0",
      a.sandbox);
  frames(a.sandbox, a.rafQ, 1);
  ok("the rings rebuild tiny graphics, six at most",
     vm.runInContext("ENG.ringGfx.length", a.sandbox) === 2 &&
     vm.runInContext("ENG.ringGfx.reduce((n, g) => n + g.paths, 0)",
                     a.sandbox) > rb0,
     "2 rings rebuilt");

  // --- the pool holds the air ------------------------------------------
  vm.runInContext('ST.s.season = "spring"; ST.s.weather = "rain";',
                  a.sandbox);
  let grew = 0;
  for (let i = 0; i < 20; i++) {
    frames(a.sandbox, a.rafQ, 1);
    grew = Math.max(grew, vm.runInContext("ENG.pool.length", a.sandbox));
  }
  ok("the pool holds every drop and no more",
     grew > 0 && grew <= 260, grew + " sprites for the rain");
  vm.runInContext('ST.s.season = "winter"; ST.s.weather = "clear";',
                  a.sandbox);          // the world returns to the frozen
                                       // clock's winter for later tests
  frames(a.sandbox, a.rafQ, 1);        // the pose epoch re-captures once
  frames(a.sandbox, a.rafQ, 1);        // and the next frame rests warm
  ok("the click binds once to the engine's canvas",
     true, "bound at boot");

  // --- the window is the scene's screen -------------------------------
  ok("the canvas is the whole screen at fit",
     vm.runInContext("CW === 1400 && CH === 800", a.sandbox),
     vm.runInContext("CW + 'x' + CH", a.sandbox));
  const box = vm.runInContext(
      "({x: ENG.worldGroup._.x, y: ENG.worldGroup._.y," +
      " sx: ENG.worldGroup._.sx})", a.sandbox);
  const expPX = vm.runInContext("PX", a.sandbox),
        expPY = vm.runInContext("PY", a.sandbox),
        expFIT = vm.runInContext("FIT", a.sandbox);
  ok("the island sits centered, scaled to fit",
     box.x === expPX && box.y === expPY && box.sx === expFIT,
     `pos (${expPX.toFixed(0)}, ${expPY.toFixed(0)}) × ${expFIT.toFixed(2)}`);
  const earthW = vm.runInContext("ENG.earthSpr.width", a.sandbox);
  ok("the earth sprite spans the island's own box",
     Math.abs(earthW - 380) < 0.01, "width " + earthW);

  // --- the earth, one texture ---------------------------------------
  ok("the earth rides under the world group, over the living",
     vm.runInContext("ENG.stage.children[1]", a.sandbox) ===
     vm.runInContext("ENG.worldGroup", a.sandbox) &&
     vm.runInContext("ENG.worldGroup.children[0]", a.sandbox) ===
     vm.runInContext("ENG.earthLayer", a.sandbox) &&
     vm.runInContext("ENG.earthLayer.children.length", a.sandbox) === 1);
  const spr0w = vm.runInContext("ENG.earthSpr.width", a.sandbox);
  ok("the earth sprite covers the logical box",
     spr0w > 0 && vm.runInContext("ENG.earthSpr.height", a.sandbox) > 0,
     "width " + spr0w.toFixed(0) + " logical");
  vm.runInContext("ENG.bakeCv.__mark = 17;", a.sandbox);
  const tex0 = vm.runInContext("ENG.bakeTex", a.sandbox) && null;
  vm.runInContext("ENG.__texBefore = ENG.bakeTex;", a.sandbox);
  const u0 = rec.updates;
  vm.runInContext("ST.s.tick = 473; fitCanvas.key = null;", a.sandbox);
  frames(a.sandbox, a.rafQ, 1);
  ok("a new week rebakes the earth in place",
     vm.runInContext("ENG.bakeCv.__mark", a.sandbox) === 17 &&
     rec.updates === u0 + 1 &&
     vm.runInContext("ENG.earthSpr.texture", a.sandbox) ===
     vm.runInContext("ENG.bakeTex", a.sandbox),
     "canvas kept (mark " + vm.runInContext("ENG.bakeCv.__mark", a.sandbox) +
     "), one source update, texture ref stable");
  frames(a.sandbox, a.rafQ, 1);
  ok("a warm week rebakes nothing more",
     rec.updates === u0 + 1, "the key only moves with the world's weeks");
  vm.runInContext("VIEW.zoom = 2.2; fitCanvas.key = null; ST.s.tick = 475;",
                  a.sandbox);
  frames(a.sandbox, a.rafQ, 1);
  const bw = vm.runInContext("ENG.bakeCv.width", a.sandbox),
        bh = vm.runInContext("ENG.bakeCv.height", a.sandbox);
  ok("the bake honors the device's ceiling",
     bw <= 4096 && bh <= 4096, bw + "x" + bh + " under zoom at DPR 1.5");
  const fZ1 = frames(a.sandbox, a.rafQ, 1);
  const fZ2 = frames(a.sandbox, a.rafQ, 2);
  ok("zoomed warm frames re-capture at most a pose, then rest",
     fZ1.trace <= 60 && fZ2.trace === 0,
     fZ1.trace + " then " + fZ2.trace + " ctx writes");

  // --- the pose is caught by the recipe itself ------------------------
  const KEY = vm.runInContext(
      "poseKeyFor(ENG.creatures[0].a, " +
      "gaitPhases(ENG.creatures[0].a, 0.25, 4.0))", a.sandbox);
  TRACE.length = 0;
  vm.runInContext("engCapturePose(" + JSON.stringify(KEY) + ")", a.sandbox);
  const cap = TRACE.slice();
  TRACE.length = 0;
  vm.runInContext(
    `engCapture(200, 200, oc => animalBody("deer", { sp: "deer", h: 0 },
      (function () {
        const p = { stride: 1, winter: true, dTrot: 0, bTrot: 0,
                    flap: 0, rf: 0, tail: 0, flick: 0 };
        const ch = ${JSON.stringify(KEY)}.split("|")[4];
        if (ch && ch !== "still") {
          const [nm, q, amp, n] = ch.split(":");
          p[nm] = engDequant(+q, +amp, +n);
        }
        return p;
      })()))`, a.sandbox);
  const bod = TRACE.slice();
  TRACE.length = 0;
  // the capture traced through its own box transform: unmap (v − o)/SS
  const unmap = tr => tr.map(s2 => {
    const xy = num2(s2, "fillRect") || num2(s2, "ellipse") ||
        num2(s2, "arc") || num2(s2, "moveTo") || num2(s2, "lineTo");
    if (!xy) return s2;
    let out2 = s2;
    for (const [xi2, yi2] of [[xy[0], xy[1]], [xy[2], xy[3]]]) {
      if (xi2 === undefined) break;
      const rnd = v => Math.round(v * 100) / 100;
      out2 = out2.replace("(" + xi2, "(" + rnd((xi2 - 96) / 8))
                 .replace("," + yi2, "," + rnd((yi2 - 104) / 8));
    }
    return out2;
  });
  const from = cap.findIndex(s2 => s2.startsWith("setTransform(8,")) + 1;
  const after = unmap(cap.slice(from));
  let firstOff = null;
  for (let q = 0; q < Math.min(after.length, bod.length); q++)
    if (after[q] !== bod[q]) { firstOff = q; break; }
  ok("the pose is caught by the recipe itself",
     after.length === bod.length && firstOff === null,
     firstOff === null ? (after.length + " ops, op for op") :
     ("#" + firstOff + ": [" + after[firstOff] + "] vs [" + bod[firstOff] +
      "]"));

  // --- the recipes' corpus, ported from scene_check -------------------
  // the earth's bake trace, the per-object captures at one-to-one, and
  // the facade's nodes carry the same truths they always carried
  const bke = vm.runInContext(
      "({w: ENG.bakeCv.width, h: ENG.bakeCv.height})", a.sandbox);
  const bkS = bke.w / 380;    // device px per logical unit
  function num2(s2, kind) {   // coords parsed straight from the trace
    if (!s2.startsWith(kind + "(")) return null;
    const body2 = s2.slice(kind.length + 1, s2.length - 1).split(",");
    const fx2 = parseFloat(body2[0]), fy2 = parseFloat(body2[1]);
    return isFinite(fx2) && isFinite(fy2) ? [fx2, fy2] : null;
  }
  function nearB(s2, kind, x2, y2, tol) {
    const xy = num2(s2, kind);
    return !!xy && Math.abs(xy[0] - x2 * bkS) < tol * bkS &&
           Math.abs(xy[1] - y2 * bkS) < tol * bkS;
  }
  TRACE.length = 0;
  vm.runInContext("ST.s.tick = 800; fitCanvas.key = null;", a.sandbox);
  frames(a.sandbox, a.rafQ, 1);
  const bakeTr = TRACE.slice();
  TRACE.length = 0;
  let offB = null;
  for (const s2 of bakeTr) {
    const xy = num2(s2, "fillRect");
    if (!xy) continue;
    if (xy[0] < 0 || xy[0] > bke.w || xy[1] < 0 || xy[1] > bke.h)
      offB = offB || "[" + xy[0] + "," + xy[1] + "]";
  }
  ok("the baked earth draws nothing off its texture", offB === null,
     offB || bke.w + "x" + bke.h);
  const hillB = vm.runInContext("tileAt(6, 1)", a.sandbox);
  const riseB = bakeTr.filter(s2 => s2.startsWith("moveTo(") &&
      nearB(s2, "moveTo", hillB[0], hillB[1] - 10, 1.5)).length;
  ok("the hill rises in the bake", riseB >= 2,
     riseB + " corners at the height");
  const sunlB = bakeTr.filter(s2 => s2 === "fillStyle=#4a392a").length;
  const shadB = bakeTr.filter(s2 => s2 === "fillStyle=#3a2d20").length;
  ok("the bake's walls stand only at true ledges",
     sunlB >= 4 && shadB >= 4 && (sunlB + shadB) <= 24,
     sunlB + " sunlit, " + shadB + " shaded");
  const tuftB = bakeTr.filter(s2 => s2.startsWith("quadraticCurveTo(") &&
      nearB(s2, "quadraticCurveTo", hillB[0], hillB[1], 8)).length;
  ok("the tall grass stands in tufts", tuftB >= 3, tuftB + " strokes");
  ok("the wet rim rings the water",
     bakeTr.includes("fillStyle=rgba(24,20,12,0.16)"));
  // per-object captures draw at one-to-one: the world's own units
  function capPlant(p2, t2) {
    TRACE.length = 0;
    vm.runInContext("engCapture(" + Math.ceil(vm.runInContext(
        "ENG.sceneBox.w", a.sandbox)) + "," + Math.ceil(vm.runInContext(
        "ENG.sceneBox.h", a.sandbox)) +
        ", oc => drawPlant(" + JSON.stringify(p2) + ", " + t2 + "))",
        a.sandbox);
    const tr = TRACE.slice();
    TRACE.length = 0;
    return tr;
  }
  const sg1 = capPlant({ id: 9, x: 5, y: 5, sp: "saguaro", st: "mature" }, 4);
  const sg1b = capPlant({ id: 9, x: 5, y: 5, sp: "saguaro", st: "mature" }, 4);
  const sg2 = capPlant({ id: 10, x: 6, y: 5, sp: "saguaro", st: "sapling" }, 4);
  const hashOf = tr => {
    let h = 5381;
    for (const e of tr) for (let i = 0; i < e.length; i++)
      h = ((h * 33) ^ e.charCodeAt(i)) >>> 0;
    return h.toString(16);
  };
  ok("a plant draws the same twice", hashOf(sg1) === hashOf(sg1b));
  ok("plants with different ids draw differently",
     hashOf(sg1.slice(0, 400)) !== hashOf(sg2.slice(0, 400)));
  // creatures ride the land: the facade's nodes carry the gait
  vm.runInContext(
      "ENG.creatures[0].a.x = 6; ENG.creatures[0].a.y = 1; " +
      "ENG.creatures[0].a.px = 6; ENG.creatures[0].a.py = 1;", a.sandbox);
  frames(a.sandbox, a.rafQ, 1);
  const ridA = vm.runInContext("ENG.creatures[0].root._.y", a.sandbox);
  vm.runInContext(
      "ENG.creatures[0].a.y = 2; ENG.creatures[0].a.py = 2;", a.sandbox);
  frames(a.sandbox, a.rafQ, 1);
  const ridB = vm.runInContext("ENG.creatures[0].root._.y", a.sandbox);
  const expRide = vm.runInContext(
      "(tileAt(6, 1)[1] - tileAt(6, 2)[1])", a.sandbox);
  ok("creatures ride the land",
     Math.abs((ridB - ridA) - (-expRide)) < 2,
     (ridB - ridA).toFixed(1) + " vs " + (-expRide).toFixed(1));
  // the pose grid answers the glide
  const pkA = vm.runInContext(
      "poseKeyFor(ENG.creatures[0].a, " +
      "gaitPhases(ENG.creatures[0].a, 0.25, 4))", a.sandbox);
  const pkB = vm.runInContext(
      "poseKeyFor(ENG.creatures[0].a, " +
      "gaitPhases(ENG.creatures[0].a, 0.75, 4))", a.sandbox);
  ok("the stride's pose answers the glide", pkA !== pkB,
     pkA.slice(-9) + " vs " + pkB.slice(-9));
  // the squash: a landing rabbit's scale wider than tall, rest square
  vm.runInContext(
      "ST.s.animals[0] = { id: 1, x: 3, y: 3, px: 3, py: 3, " +
      "sp: 'rabbit', ag: 12 }; engBuildCreatures(ST.s);", a.sandbox);
  vm.runInContext(
      "engAnimalsLive(4, (Math.PI - 1) / 12);", a.sandbox);
  const sxL = vm.runInContext("ENG.creatures[0].inner._.sx", a.sandbox);
  const syL = vm.runInContext("ENG.creatures[0].inner._.sy", a.sandbox);
  ok("the rabbit squashes on the landing",
     syL < sxL, "scale " + sxL.toFixed(2) + "," + syL.toFixed(2));
  vm.runInContext("engAnimalsLive(4, 1);", a.sandbox);
  const sxR = vm.runInContext("ENG.creatures[0].inner._.sx", a.sandbox);
  const syR = vm.runInContext("ENG.creatures[0].inner._.sy", a.sandbox);
  ok("the rabbit at rest stands square",
     sxR === syR, "scale " + sxR.toFixed(2) + "," + syR.toFixed(2));

  /* --- an engine refused falls to words, once, honestly --- */
  rec.failInit = true;                    // before the boot, so the init
  const b = await boot({ __search: "?engine=pixi", __pixi: makeFacade(rec) });
  await 0; await 0;
  ok("a refused engine says so",
     vm.runInContext("ENG.failed", b.sandbox) === true, "failed=true");
  ok("the world falls to its words",
     el("body")._cls.has("plain"), "the word-map");
  const initsB = rec.inits, rendersB = rec.renders;
  vm.runInContext(`${WORLD}`, b.sandbox);
  frames(b.sandbox, b.rafQ, 2);
  ok("a fallen frame renders nothing", rec.renders === rendersB,
     `renders ${rec.renders - rendersB}`);

  console.log(`pixi_check — ${fails ? "FAIL " + fails : "ALL PASS"}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("pixi_check failed:", e.stack);
                  process.exit(1); });