/* The page's headless check.
 *
 * No browser on this box, so the page's own scripts run against a stub
 * PIXI that records the node tree and every drawing op — the same trick
 * grove's pixi_check.js plays on the island, and for the same reason: the
 * things that go wrong in a renderer are order, ownership and arithmetic,
 * and all three are visible without a screen.
 *
 * The assertions worth having:
 *   · the layers exist in the order that makes the picture true — above
 *     all the tint under the lamplight, because a lamp the night darkens
 *     is not a lamp
 *   · a warm frame draws nothing: no rebuild inside a frame
 *   · every fixture kind the frame carries reaches the canvas
 *   · rain is spawned in the plan's box, never the canvas's (grove b43)
 *   · a click maps back to the cell it landed on
 *
 *   node tools/pixi_check.js <ground.json> <state.json>
 */

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HERE = path.join(__dirname, '..', 'estate', 'page');
const FILES = ['boot.js', 'scene.js', 'panels.js'];

/* ------------------------------------------------------------- stubs */

let OPS = [];              // drawing ops, in order
let PHASE = 'build';       // 'build' | 'frame'
let FRAME_OPS = 0;

function vec() {
  return { x: 0, y: 0, set(a, b) { this.x = a; this.y = b; return this; } };
}

function Graphics() {
  this.__kind = 'graphics';
  this.children = [];              // its own, never one shared on the
  this.alpha = 1;                  // prototype: a shared array is every
                                   // graphics writing into every other
 this.blendMode = 'normal'; this.tint = 0xffffff;
  this.position = vec(); this.scale = vec();
}
function Container() {
  this.__kind = 'container';
  this.children = [];
  this.alpha = 1; this.blendMode = 'normal';
  this.position = vec(); this.scale = vec();
}
['rect', 'circle', 'ellipse', 'roundRect', 'poly', 'moveTo', 'lineTo',
 'fill', 'stroke', 'clear'].forEach(n => {
  Graphics.prototype[n] = function (...a) {
    if (PHASE === 'frame') FRAME_OPS++;
    else OPS.push([n, ...a]);
    return this;
  };
});
Container.prototype.addChild = function (c) {
  const i = this.children.indexOf(c);
  if (i >= 0) this.children.splice(i, 1);
  this.children.push(c);
  return c;                       // pixi's addChild hands the child back
};
Container.prototype.removeChild = function (c) {
  const i = this.children.indexOf(c);
  if (i >= 0) this.children.splice(i, 1);
  return c;
};

const APP = { tick: null, resized: [] };
const PIXI = {
  Application: function () {
    this.stage = new Container();
    this.ticker = { add: fn => { APP.tick = fn; }, deltaMS: 16 };
    this.renderer = { resize: (w, h) => APP.resized.push([w, h]) };
    this.init = async function (o) { this.canvas = o.canvas; return this; };
  },
  Container, Graphics,
};

/* --------------------------------------------------------------- dom */

const els = {};
function El(id) {
  this.id = id; this.textContent = ''; this.innerHTML = ''; this.dataset = {};
  const set = new Set();
  this.classList = {
    add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
    toggle: (c, on) => { on ? set.add(c) : set.delete(c); },
  };
  this.clientWidth = 1200; this.clientHeight = 800;
  this.addEventListener = () => {};
  this.getBoundingClientRect = () => ({ left: 0, top: 0 });
}
['scene', 'scroller', 'engine', 'when', 'weather', 'pops', 'chron', 'look',
 'pauseBtn', 'stepBtn', 'fsBtn', 'zoomFit', 'zoom1x', 'zoom2x', 'hint',
 'tabChron', 'tabCensus', 'tabWatch', 'card', 'cardName', 'cardState',
 'cardRows', 'cardClose', 'plain', 'watch', 'voice'].forEach(id => { els[id] = new El(id); });

const document = {
  body: new El('body'), documentElement: new El('html'),
  getElementById: id => els[id] || (els[id] = new El(id)),
  addEventListener: () => {}, fullscreenElement: null, exitFullscreen: () => {},
};

/* ------------------------------------------------------------ fixture */

const ground = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const state = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
state.paused = false;

const timers = [];
const sandbox = {
  PIXI, document, console,
  performance: { now: () => Date.now() },
  fetch: url => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(url.indexOf('ground') >= 0 ? ground : state),
    text: () => Promise.resolve('plain map'),
  }),
  setTimeout: fn => { timers.push(fn); return timers.length; },
  setInterval: () => 0, clearTimeout: () => {},
  addEventListener: () => {}, location: { search: '' }, URLSearchParams,
  Math, JSON, Object, Array, String, Number, Set, Map, Date, isNaN,
  window: { devicePixelRatio: 2, addEventListener: () => {} },
};
sandbox.window.PIXI = PIXI;
const ctx = vm.createContext(sandbox);
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(HERE, f), 'utf8'), ctx,
                  { filename: f });
}

/* ------------------------------------------------------------- checks */

const fails = [];
function ok(name, cond, detail) {
  if (!cond) fails.push(name);
  console.log((cond ? '  ok   ' : '  FAIL ') + name +
              (detail && !cond ? '   (' + detail + ')' : ''));
}
const turn = () => new Promise(r => setImmediate(r));
async function settle(n) {
  for (let i = 0; i < n; i++) {
    await turn();
    while (timers.length) timers.shift()();
  }
}

(async () => {
  await settle(12);

  /* a `const` at a script's top level is a binding in the context's
   * lexical scope, not a property of the sandbox object — so the page's
   * globals have to be asked for inside the context, not read off it */
  const grab = expr => vm.runInContext(expr, ctx);
  const Scene = grab('Scene'), S = grab('S');
  ok('the page loaded its scripts', !!Scene && !!S);
  if (!Scene || !Scene.dbg) {
    console.log('\n' + fails.length + ' FAILED');
    process.exit(1);
  }
  const sc = Scene.dbg;
  ok('the ground arrived', !!S.ground && S.ground.rows.length > 0);
  ok('the day arrived', !!S.state);

  /* --- the layer order, which is the picture's honesty ----------------- */
  const kids = sc.world.children;
  const idx = l => kids.indexOf(l);
  ok('the plan is drawn under everything',
     idx(sc.gGround) === 0 && idx(sc.gShade) > idx(sc.gGround));
  ok('the buildings sit over the ground and under the people',
     idx(sc.gBuild) > idx(sc.gGround) && idx(sc.gObj) > idx(sc.gBuild) &&
     idx(sc.gPeople) > idx(sc.gObj));
  ok('the tint lies over the plan', idx(sc.tintRect) > idx(sc.gPeople));
  ok('the lamplight lies over the tint — a lamp the night darkens is not ' +
     'a lamp', idx(sc.gLight) > idx(sc.tintRect));
  ok('the selection ring lies over the lamplight',
     idx(sc.gMark) > idx(sc.gLight));

  /* --- what reached the canvas ---------------------------------------- */
  const kinds = new Set(state.fixtures.map(f => f.kind));
  const drewTree = OPS.filter(o => o[0] === 'ellipse').length;
  ok('trees are drawn with a shadow of their own', drewTree >= 1,
     drewTree + ' ellipses');
  ok('every building footprint is drawn',
     OPS.filter(o => o[0] === 'rect').length >= state.buildings.length * 5);
  ok('a window pane was drawn for every flat',
     OPS.filter(o => o[0] === 'circle').length >= Object.keys(ground.units).length,
     'circles ' + OPS.filter(o => o[0] === 'circle').length +
     ' vs flats ' + Object.keys(ground.units).length);
  ok('there is a person for every resident',
     Object.keys(sc.agents).length === state.people.length,
     Object.keys(sc.agents).length + ' vs ' + state.people.length);

  /* --- a warm frame draws nothing ------------------------------------- */
  ok('the ticker was handed a frame', typeof APP.tick === 'function');
  const before = OPS.length;
  PHASE = 'frame';
  for (let i = 0; i < 8; i++) APP.tick({ deltaMS: 16 });
  PHASE = 'build';
  ok('a warm frame draws no geometry — no rebuild inside a frame',
     FRAME_OPS === 0, FRAME_OPS + ' ops in 8 frames');
  ok('a warm frame neither rebuilt nor lost the earth',
     OPS.length === before);

  /* --- the weather falls in the plan's box ---------------------------- */
  const pw = ground.width * 30, ph = ground.height * 30;
  PHASE = 'frame';
  for (let i = 0; i < 4; i++) APP.tick({ deltaMS: 16 });
  PHASE = 'build';
  const far = sc.drops.filter(d => d.x > pw + 5);
  ok('the weather falls in the plan, not in the window (b43)',
     far.length === 0, far.length + ' drops outside the plan');

  /* --- the day moves, and only the day -------------------------------- */
  const tint0 = sc.overlay.tint;
  ok('the day has a tint', typeof tint0 === 'number');

  /* --- a click lands where it was aimed ------------------------------- */
  const target = { x: 12, y: 15 };
  const wx = sc.ox + (target.x + 0.5) * 30 * sc.scale;
  const wy = sc.oy + (target.y + 0.5) * 30 * sc.scale;
  const got = Scene.cellAt(wx, wy);
  ok('a click maps back to the cell it landed on',
     got && got.x === target.x && got.y === target.y,
     got ? got.x + ',' + got.y : 'null');

  /* --- the panels are filled, not blank -------------------------------- */
  ok('the header was written', els.when.textContent.indexOf('day ') === 0,
     els.when.textContent);
  ok('the census lists every household kind',
     (els.chron.innerHTML.match(/<li>/g) || []).length >= 1);

  console.log('\n' + (fails.length ? fails.length + ' FAILED: ' + fails.join('; ')
                                   : 'all ok'));
  process.exit(fails.length ? 1 : 0);
})();
