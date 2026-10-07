// Headless harness for grove's page: runs the page the way a browser
// receives it (the evaluated Python PAGE string) with a stubbed DOM and
// canvas, against real world state. Any throw = failure.
//
//   node tools/page_harness.js <page.html> <state.json>
const fs = require("fs");
const { makeFacade } = require("./facade.js");
const pixiRec = { writes: 0, textures: 0, updates: 0, destroys: 0,
                  renders: 0, inits: 0, resizes: [], anchorSets: 0,
                  failInit: false, maxTextureSize: 4096 };
let offN = 0;

const html = fs.readFileSync(process.argv[2] || "/tmp/grove_page.html",
                             "utf8");
const state = JSON.parse(fs.readFileSync(process.argv[3] ||
                         "/tmp/grove_state.json", "utf8"));
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];

let calls = 0;
const ctxTarget = {};
for (const k of ["fillRect","strokeRect","beginPath","moveTo","lineTo",
  "arc","arcTo","ellipse","quadraticCurveTo","closePath","fill","stroke",
  "fillText","save","restore","translate","scale","rotate","setTransform",
  "setLineDash","clearRect","clip","drawImage"])
  ctxTarget[k] = (...a) => {
    calls++;
    for (const q of a)
      if (typeof q === "number" && !isFinite(q))
        throw new Error(`non-finite arg in ctx.${k}(${a.join(",")})`);
    return undefined;
  };
/* gradients: a stub the canvas gradient stops can be added to */
for (const gk of ["createLinearGradient", "createRadialGradient"])
  ctxTarget[gk] = (...a) => {
    calls++;
    for (const q of a)
      if (typeof q === "number" && !isFinite(q))
        throw new Error(`non-finite arg in ctx.${gk}(${a.join(",")})`);
    return { addColorStop: () => {} };
  };
const ctx = new Proxy(ctxTarget, {
  get(t, k) { return t[k]; },
  set(t, k, v) { t[k] = v; return true; },
});

const rafQ = [];
let nowMs = 1000;

function elBase(id) {
  const e = {
    id, textContent: "", innerHTML: "", disabled: false, className: "",
    style: {}, width: 0, height: 0, listeners: {},
    classList: { set: new Set(), add(c) { e.classList.set.add(c); },
                 remove(c) { e.classList.set.delete(c); },
                 toggle() {}, contains: c => e.classList.set.has(c) },
    addEventListener: (ev, fn) => {
      (e.listeners[ev] = e.listeners[ev] || []).push(fn); },
    getBoundingClientRect: () => ({ left: 8, top: 8, width: 528, height: 528 }),
    getContext: () => ctx,
  };
  return e;
}
function el(id) {
  if (els[id]) return els[id];
  const e = elBase(id);
  els[id] = e;
  return e;
}
const els = {};
["scene", "map", "when", "weather", "pops", "soul", "chron", "sparks",
 "status", "pauseBtn", "stepBtn", "soulBtn", "look", "engine",
 "bio", "bioName", "bioState", "bioRows", "followBtn", "bioClose",
 "tabChron", "tabCensus", "tabTune", "tune", "qinput", "askBtn",
 "askout", "fsBtn", "zoomFit", "zoom1x", "zoom2x", "scroller"]
  .forEach(id => { el(id); });
const fakeFetch = async () => ({ json: async () => state });

new Function("window", "document", "location", "performance", "PIXI",
  "requestAnimationFrame", "setInterval", "fetch", "AbortSignal", js)(
  { devicePixelRatio: 2, innerWidth: 1200, innerHeight: 800,
    addEventListener: () => {} },
  { getElementById: id => el(id),
    createElement: kind => elBase("off-" + kind + "-" + (offN++)),
    querySelector: () => ({ clientWidth: 1090, clientHeight: 500,
                            scrollLeft: 0, scrollTop: 0 }),
    body: { classList: elBase("body").classList } },
  { search: "" }, { now: () => nowMs },
  makeFacade(pixiRec),
  fn => { rafQ.push(fn); return 1; },
  () => 0, fakeFetch, { timeout: () => undefined });

setTimeout(() => {
  const dbg = globalThis.groveDebug;
  if (!dbg || !dbg.ST.s) { console.error("poll never resolved"); process.exit(1); }
  for (let i = 0; i < 30; i++) {
    nowMs += 300;
    const q = rafQ.splice(0);
    if (q.length) q[q.length - 1](nowMs);
  }
  if (calls < 50)
    throw new Error(`scene drew almost nothing (${calls} ctx calls)`);
  console.log(`scene OK: ${calls} draw calls across 30 frames (raf loop)`);

  // the click goes to the canvas the engine actually put the world on
  const target = (pixiRec.inits && globalThis.groveDebug &&
                  globalThis.groveDebug.ENG &&
                  globalThis.groveDebug.ENG.canvas) || els.scene;
  const fns = (target.listeners && target.listeners.click) ||
      (els.scene.listeners && els.scene.listeners.click) || [];
  /* aim at a real tile rather than a fixed pixel: the island is framed
     from its own top corner now, so a hardcoded point can fall on sky */
  const box = target.getBoundingClientRect();
  const cw = dbg.CW(), ch = dbg.CH();
  const at = dbg.cellPoint(6, 1);
  fns[fns.length - 1]({ clientX: box.left + at[0] / cw * box.width,
                        clientY: box.top + at[1] / ch * box.height });
  if (!els.look.textContent.trim()) throw new Error("click produced nothing");
  console.log("click OK:", els.look.textContent.slice(0, 90));
  if (!els.chron.innerHTML && state.chronicle && state.chronicle.length)
    throw new Error("chronicle empty");   // fresh worlds legitimately have none
  console.log("dom OK |", els.when.textContent);
  console.log("HARNESS PASS");
}, 40);