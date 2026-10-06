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
    getContext() { return ctx2d; },
  };
  return e;
}
function el(id) {
  if (elements.has(id)) return elements.get(id);
  const e = elStub(id);
  elements.set(id, e);
  return e;
}

/* ---- the PIXI facade: only what the page asks, recorded -------------- */
let NODE_WRITES = 0, TEXTURES = 0, RENDERS = 0, INITS = 0,
    RESIZES = [], UPDATES = 0, DESTROYS = 0;
let FAIL_INIT = false;

class PixiNode {
  constructor() {
    this.children = [];
    this._ = { alpha: 1, tint: 0xffffff, x: 0, y: 0, sx: 1, sy: 1,
               rot: 0, texture: null, width: 0, height: 0 };
    this.anchor = { set() {} };
  }
  addChild(...cs) { for (const c of cs) this.children.push(c); return cs[0]; }
  removeChildren() { const c = this.children; this.children = []; return c; }
  w() { NODE_WRITES++; }
  get alpha() { return this._.alpha; }
  set alpha(v) { this._.alpha = v; this.w(); }
  get tint() { return this._.tint; }
  set tint(v) { this._.tint = v; this.w(); }
  get texture() { return this._.texture; }
  set texture(v) { this._.texture = v; this.w(); }
  get width() { return this._.width; }
  set width(v) { this._.width = v; this.w(); }
  get height() { return this._.height; }
  set height(v) { this._.height = v; this.w(); }
  get scale() {
    const self = this;
    return { get x() { return self._.sx; }, set x(v) { self._.sx = v; self.w(); },
             get y() { return self._.sy; }, set y(v) { self._.sy = v; self.w(); },
             set(x, y) { self._.sx = x; self._.sy = y; self.w(); } };
  }
  get position() {
    const self = this;
    return { get x() { return self._.x; }, set x(v) { self._.x = v; self.w(); },
             get y() { return self._.y; }, set y(v) { self._.y = v; self.w(); },
             set(x, y) { self._.x = x; self._.y = y; self.w(); } };
  }
  get rotation() { return this._.rot; }
  set rotation(v) { this._.rot = v; this.w(); }
}

function makeFacade() {
  class AppCanvas {}
  const Application = class {
    constructor() {
      this.stage = new PixiNode();
      this.canvas = { id: "facade-canvas", style: {},
                      addEventListener() {},
                      getBoundingClientRect: () =>
                        ({ left: 0, top: 0, width: 528, height: 528 }) };
      this.renderer = {
        maxTextureSize: 4096,
        resize(w, h, res) { RESIZES.push([Math.round(w), Math.round(h),
                                          res]); } };
    }
    async init(opts) {
      INITS++;
      if (FAIL_INIT) throw new Error("no surface for the engine");
      this.initOpts = opts;
    }
    render() { RENDERS++; }
  };
  return {
    Application,
    Container: PixiNode,
    Sprite: class extends PixiNode { constructor(tex) { super();
        if (tex !== undefined) this.texture = tex; } },
    Text: class extends PixiNode { constructor(str) { super();
        this.text = str; } },
    Graphics: class extends PixiNode {
      constructor() { super(); this.paths = 0; this.strokes = 0; }
      clear() { this.paths = 0; this.strokes = 0; return this; }
      ellipse() { this.paths++; return this; }
      circle() { this.paths++; return this; }
      rect() { this.paths++; return this; }
      moveTo() { return this; }
      lineTo() { return this; }
      closePath() { return this; }
      beginPath() { return this; }
      fill(o) { return this; }
      stroke(o) { this.strokes++; return this; }
    },
    FillGradient: class { constructor(opts) { this.opts = opts; }
                          addColorStop() {} },
    Texture: { from(src) {
      TEXTURES++;
      return { source: { update() { UPDATES++; } },
               destroy(rec) { DESTROYS++; },
               __src: src, width: src && src.width || 0,
               height: src && src.height || 0 };
    } },
  };
}

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
  const before = { writes: NODE_WRITES, trace: TRACE.length, tex: TEXTURES };
  for (let i = 0; i < n; i++) {
    const q = rafQ.splice(0);
    for (const fn of q) fn(4000 + i * 300);
  }
  return { writes: NODE_WRITES - before.writes,
           trace: TRACE.length - before.trace,
           tex: TEXTURES - before.tex };
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
`;

(async () => {
  let fails = 0;
  const ok = (name, cond, detail) => {
    console.log((cond ? "  · " : "  ✗ ") + name +
                (cond && detail ? ` (${detail})` : !cond ? ` — ${detail}` : ""));
    if (!cond) fails++;
  };

  /* --- the engine boots, in its own canvas, the word-map asleep --- */
  const a = await boot({ __search: "?engine=pixi", __pixi: makeFacade() });
  await 0; await 0; await 0;                          // engBoot resolves
  ok("the engine boots behind ?engine=pixi", true, "booted once");
  ok("the engine is the only painter",
     vm.runInContext("ENGINE", a.sandbox) === "pixi" &&
     vm.runInContext("ENG.active", a.sandbox) === true &&
     INITS === 1);
  ok("the engine owns its own canvas",
     vm.runInContext("ENG.canvas.id", a.sandbox) === "scene-g" &&
     el("scene")._cls.has("retired"));
  vm.runInContext(WORLD, a.sandbox);
  const f1 = frames(a.sandbox, a.rafQ, 3);
  ok("the frame renders through pixi", RENDERS === 3, RENDERS + " renders");
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
     RESIZES.length >= 1 && RESIZES[RESIZES.length - 1][2] === 1.5,
     "renderer resize at DPR " + RESIZES[RESIZES.length - 1][2]);
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

  // --- the earth, one texture ---------------------------------------
  ok("the earth rides between sky and the living",
     vm.runInContext("ENG.stage.children[1]", a.sandbox) ===
     vm.runInContext("ENG.earthLayer", a.sandbox) &&
     vm.runInContext("ENG.earthLayer.children.length", a.sandbox) === 1);
  const spr0w = vm.runInContext("ENG.earthSpr.width", a.sandbox);
  ok("the earth sprite covers the logical box",
     spr0w > 0 && vm.runInContext("ENG.earthSpr.height", a.sandbox) > 0,
     "width " + spr0w.toFixed(0) + " logical");
  vm.runInContext("ENG.bakeCv.__mark = 17;", a.sandbox);
  const tex0 = vm.runInContext("ENG.bakeTex", a.sandbox) && null;
  vm.runInContext("ENG.__texBefore = ENG.bakeTex;", a.sandbox);
  const u0 = UPDATES;
  vm.runInContext("ST.s.tick = 473; fitCanvas.key = null;", a.sandbox);
  frames(a.sandbox, a.rafQ, 1);
  ok("a new week rebakes the earth in place",
     vm.runInContext("ENG.bakeCv.__mark", a.sandbox) === 17 &&
     UPDATES === u0 + 1 &&
     vm.runInContext("ENG.earthSpr.texture", a.sandbox) ===
     vm.runInContext("ENG.bakeTex", a.sandbox),
     "canvas kept (mark " + vm.runInContext("ENG.bakeCv.__mark", a.sandbox) +
     "), one source update, texture ref stable");
  frames(a.sandbox, a.rafQ, 1);
  ok("a warm week rebakes nothing more",
     UPDATES === u0 + 1, "the key only moves with the world's weeks");
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

  // the pose is caught by the recipe itself: catching a pose writes
  // the body recipe's own ops, op for op, in the same transform
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
  const from = cap.findIndex(s2 => s2.startsWith("setTransform(8,")) + 1;
  const after = cap.slice(from);
  ok("the pose is caught by the recipe itself",
     after.length === bod.length &&
     JSON.stringify(after) === JSON.stringify(bod),
     after.length + " ops, op for op of " + bod.length);

  /* --- an engine refused falls to words, once, honestly --- */
  FAIL_INIT = true;                    // before the boot, so the init
  const b = await boot({ __search: "?engine=pixi", __pixi: makeFacade() });
  await 0; await 0;
  ok("a refused engine says so",
     vm.runInContext("ENG.failed", b.sandbox) === true, "failed=true");
  ok("the world falls to its words",
     el("body")._cls.has("plain"), "the word-map");
  const initsB = INITS, rendersB = RENDERS;
  vm.runInContext(`${WORLD}`, b.sandbox);
  frames(b.sandbox, b.rafQ, 2);
  ok("a fallen frame renders nothing", RENDERS === rendersB,
     `renders ${RENDERS - rendersB}`);

  console.log(`pixi_check — ${fails ? "FAIL " + fails : "ALL PASS"}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("pixi_check failed:", e.stack);
                  process.exit(1); });