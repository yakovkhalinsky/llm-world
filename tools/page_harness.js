// Headless harness for grove's page: runs the page the way a browser
// receives it (the evaluated Python PAGE string) with a stubbed DOM and
// canvas, against real world state. Any throw = failure.
//
//   node tools/page_harness.js <page.html> <state.json>
const fs = require("fs");

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
  "setLineDash","clearRect","createLinearGradient"])
  ctxTarget[k] = (...a) => {
    calls++;
    for (const q of a)
      if (typeof q === "number" && !isFinite(q))
        throw new Error(`non-finite arg in ctx.${k}(${a.join(",")})`);
    return undefined;
  };
const ctx = new Proxy(ctxTarget, {
  get(t, k) { return t[k]; },
  set(t, k, v) { t[k] = v; return true; },
});

const rafQ = [];
let nowMs = 1000;

function el(id) {
  const e = {
    id, textContent: "", innerHTML: "", disabled: false, className: "",
    style: {}, width: 0, height: 0, listeners: {},
    addEventListener: (ev, fn) => { e.listeners[ev] = fn; },
    getBoundingClientRect: () => ({ left: 8, top: 8, width: 528, height: 528 }),
    getContext: () => ctx,
  };
  return e;
}
const els = {};
["scene", "map", "when", "weather", "pops", "soul", "chron", "sparks",
 "status", "pauseBtn", "stepBtn", "soulBtn", "look"]
  .forEach(id => { els[id] = el(id); });
const fakeFetch = async () => ({ json: async () => state });

new Function("window", "document", "location", "performance",
  "requestAnimationFrame", "setInterval", "fetch", "AbortSignal", js)(
  { devicePixelRatio: 2 },
  { getElementById: id => els[id] || (els[id] = el(id)),
    body: { classList: { contains: () => false, add: () => {} } } },
  { search: "" }, { now: () => nowMs },
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

  els.scene.listeners.click({ clientX: 208, clientY: 308 });
  if (!els.look.textContent.trim()) throw new Error("click produced nothing");
  console.log("click OK:", els.look.textContent.slice(0, 90));
  if (!els.chron.innerHTML) throw new Error("chronicle empty");
  console.log("dom OK |", els.when.textContent);
  console.log("HARNESS PASS");
}, 40);