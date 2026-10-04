/* The page's headless check: load the assembled scripts exactly the way
   web.py serves them (boot, scene, panels), stub the browser, record
   every stroke the canvas receives, and walk a synthetic world through
   the scene. Findings of the graphics review carry their own
   assertions below — new ones get new checks in the same spirit.
     node tools/scene_check.js
*/
"use strict";
const fs = require("fs"),
      path = require("path"),
      vm = require("vm");

const page = [];
for (const name of ["boot.js", "scene.js", "panels.js"])
  page.push(fs.readFileSync(
      path.join(__dirname, "..", "grove", "page", name), "utf8"));

/* ---- the stubbed browser -------------------------------------------- */
const elements = new Map();
function el(id) {
  if (elements.has(id)) return elements.get(id);
  const e = {
    id, textContent: "", innerHTML: "", className: "", disabled: false,
    value: "", hidden: false, dataset: {}, onclick: null, style: {},
    clientWidth: 1400, clientHeight: 800, scrollLeft: 0, scrollTop: 0,
    addEventListener() {}, scrollTo() {}, toggleAttribute() {},
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
  elements.set(id, e);
  return e;
}

const doc = { getElementById: el,
               querySelector: sel => el(sel.replace(/^#/, "")),
               querySelectorAll: () => [],
               body: { classList: el("body").classList },
               fullscreenElement: null,
               documentElement: { requestFullscreen: () => Promise.resolve() },
               exitFullscreen() {} };
const win = { addEventListener() {}, devicePixelRatio: 1 };
const loc = { search: "" };

const TRACE = [];
const fmt = v => typeof v === "number" ? String(Math.round(v * 100) / 100)
                   : String(v);
const grad = () => ({ addColorStop() {} });
/* the recorder remembers the world's transforms: the page draws in
   logical iso coords, translated/scaled per entity, so the trace
   records where a stroke truly lands in canvas space — offscreen or
   on the wrong tile shows up exactly as it would on screen. Rotations
   are drawn as calls but ignored in the mapping (they never exceed a
   degree or two of sway). */
let m = { a: 1, d: 1, e: 0, f: 0 };
const stack = [];
const map = (x, y) => [m.a * x + m.e, m.d * y + m.f];
const ctx2d = new Proxy({}, {
  get(_t, k) {
    return (...a) => {
      if (k === "createLinearGradient" || k === "createRadialGradient") {
        return grad();
      }
      if (k === "setTransform") { m = { a: a[0], d: a[3], e: a[4], f: a[5] }; }
      else if (k === "resetTransform") { m = { a: 1, d: 1, e: 0, f: 0 }; }
      else if (k === "save") { stack.push({ ...m }); }
      else if (k === "restore") { if (stack.length) m = stack.pop(); }
      else if (k === "translate") { m.e += m.a * a[0]; m.f += m.d * a[1]; }
      else if (k === "scale") { m.a *= a[0]; m.d *= a[1]; }
      const R = { fillRect: [0, 1], strokeRect: [0, 1],
                  ellipse: [0, 1], arc: [0, 1] }[k];
      if (R) {
        const [xp, yp] = map(a[R[0]], a[R[1]]);
        a[R[0]] = xp; a[R[1]] = yp;
      }
      TRACE.push(k + "(" + a.map(fmt).join(",") + ")");
    };
  },
  set(_t, k, v) { TRACE.push(k + "=" + fmt(v)); return true; },
});

/* ---- run the page the way the server assembles it ------------------- */
const sandbox = {
  document: doc, window: win, location: loc,
  console: { log() {} },                    // keep the page's chatter quiet
  fetch(url) {
    const body = String(url).startsWith("/api/bio")
        ? { alive: true, name: "Sly", sp: "fox", events: [{ tick: 5, text: "was born" }] }
        : { error: "quiet" };
    return Promise.resolve({ json: async () => body });
  },
  setTimeout, clearTimeout,
  setInterval: () => 0, clearInterval() {},
  requestAnimationFrame: () => 0,
  performance: { now: () => 2000 },   // a frozen clock: the world is
                                      // hermetic, frame for frame
  TRACE,
  URLSearchParams, AbortSignal,
};
vm.createContext(sandbox);
for (const src of page) vm.runInContext(src, sandbox, { filename: "page.js" });

/* ---- the driver: everything below runs inside the page's world ------ */
const driver = `
(async () => {
  const out = { checks: [], crash: null };
  let okn = 0, failn = 0;
  const ok = (name, cond, detail) => {
    out.checks.push({ name, pass: !!cond, detail: detail || "" });
    if (cond) okn++; else failn++;
  };

  // a world of every shape and state, drawn once
  const size = 8;
  const cells = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let c;
    if (y === 5 && (x === 2 || x === 3))      c = ["w", 0, 0, 0, 0];
    else if (x === 7 && y === 7)              c = ["r", 0, 0, 0, 0];
    else if (x === 1 && y === 6)              c = ["s", 0.9, 0.8, 1, 1];
    else if (x === 6 && y === 1)              c = ["s", 0.9, 0, 0, 0];
    else c = ["s", ((x + y) % 2) / 2, ((x + y) % 3) / 3 > 0.2 ? 0.9 : 0, 0, 0];
    cells.push(c);
  }
  const plants = [
    { id: 1, x: 1, y: 1, sp: "pine", st: "mature" },
    { id: 2, x: 2, y: 1, sp: "birch", st: "old", el: 1, n: "Elder" },
    { id: 3, x: 3, y: 1, sp: "willow", st: "old", n: "Wisp" },
    { id: 4, x: 4, y: 1, sp: "fern", st: "mature" },
    { id: 5, x: 5, y: 1, sp: "berry", st: "mature", b: 1 },
    { id: 6, x: 1, y: 2, sp: "pine", st: "sapling" },
    { id: 7, x: 2, y: 2, sp: "birch", st: "mature" },
    { id: 8, x: 4, y: 4, sp: "pine", st: "log" },
    { id: 9, x: 5, y: 5, sp: "saguaro", st: "mature" },
    { id: 10, x: 6, y: 5, sp: "saguaro", st: "sapling" },
  ];
  const animals = [
    { id: 1, x: 3, y: 3, px: 3, py: 3, sp: "rabbit", ag: 12 },
    { id: 2, x: 4, y: 3, px: 3, py: 3, sp: "deer", ag: 12 },
    { id: 3, x: 5, y: 3, px: 5, py: 3, sp: "fox", ag: 12, h: 1 },
    { id: 4, x: 6, y: 3, px: 6, py: 3, sp: "owl", ag: 12 },
    { id: 5, x: 2, y: 4, px: 2, py: 4, sp: "robin", ag: 12 },
    { id: 6, x: 3, y: 4, px: 3, py: 4, sp: "boar", ag: 12 },
    { id: 7, x: 4, y: 4, px: 4, py: 4, sp: "wolf", ag: 3, n: "Tuft" },
    { id: 8, x: 5, y: 4, px: 5, py: 4, sp: "stag", ag: 12 },
    { id: 9, x: 6, y: 4, px: 6, py: 4, sp: "tortoise", ag: 12 },
  ];
  const world = {
    tick: 472, season: "winter", weather: "clear", size, paused: false,
    now: 0, step_at: 0, tick_seconds: 8,
    map: [], llm: { status: "at rest" }, chronicle: [], pop_chips: [],
    series: [],
    effects: ["blight over NW", "drought over all", "bloom over SE"],
    ops: [], cells, plants, animals,
  };
  ST.s = world;
  ST.flight = { start: 0, dur: 8 };
  SHAPES["saguaro"] = "cactus";     // what the desert's pack injects
  const tnow = 12345678;
  const tsec = tnow / 1000;

  const reset = () => { FACING.length = 0; dots.length = 0; };
  function traceOf(fn) {
    TRACE.length = 0; reset(); fn();
    const t = TRACE.slice(); TRACE.length = 0; return t;
  }
  function hash(tr) {
    let x = 5381;
    for (const e of tr) for (let i = 0; i < e.length; i++)
      x = ((x * 33) ^ e.charCodeAt(i)) >>> 0;
    return x.toString(16);
  }

  // the whole frame draws without crashing
  try {
    TRACE.length = 0; reset(); drawScene(tnow);
  } catch (e) {
    out.crash = String(e && e.stack || e);
  }

  // every fillRect lands on the canvas — nothing drawn offscreen.
  // (the trace records buffer-space coords; cnv.width is the buffer)
  const full = TRACE.slice();
  let off = null;
  for (const s of full) {
    const m = s.match(/^fillRect\\((-?[\\d.]+),(-?[\\d.]+),/);
    if (!m) continue;
    const [fx, fy] = [parseFloat(m[1]), parseFloat(m[2])];
    if (fx < 0 || fx > cnv.width || fy < 0 || fy > cnv.height)
      off = off || "(" + fx + ", " + fy + ")";
  }
  reset(); TRACE.length = 0;
  ok("nothing draws off the canvas", off === null, off ||
     \`\${full.length} strokes over the whole frame\`);

  // the frame draws the same twice — the scene is deterministic
  const tr1 = traceOf(() => drawScene(tnow));
  const full1 = hash(tr1);
  const tr2 = traceOf(() => drawScene(tnow));
  const full2 = hash(tr2);
  let firstDiff = null;
  for (let i = 0; i < Math.max(tr1.length, tr2.length) && !firstDiff; i++)
    if (tr1[i] !== tr2[i]) firstDiff = "#" + i + ": [" + tr1[i] + "] vs [" +
        tr2[i] + "]";
  ok("the frame draws the same twice", full1 === full2,
     firstDiff || "identical");

  // a tree draws the same twice, and a different tree draws differently
  const tw = (id) => ({ id, x: 5, y: 6, sp: "willow", st: "mature" });
  const hA1 = hash(traceOf(() => drawPlant(tw(11), tsec)));
  const hA2 = hash(traceOf(() => drawPlant(tw(11), tsec)));
  const hA3 = hash(traceOf(() => drawPlant(tw(12), tsec)));
  ok("a tree draws the same twice", hA1 === hA2);
  ok("trees with different ids draw differently",
     hA1 !== hA3, \`\${hA1} vs \${hA3}\`);

  // each cactus draws on its own tile — the saguaro's marks sit within
  // a tile's width of the cell's iso position (buffer space: the base
  // setTransform scale is cnv.width / CW)
  const sB = cnv.width / CW;
  for (const c of [plants[8], plants[9]]) {
    let stray = null;
    TRACE.length = 0; drawPlant(c, tsec);
    const [tx, ty] = iso(c.x, c.y);
    for (const s of TRACE) {
      const m = s.match(/^fillRect\\((-?[\\d.]+),(-?[\\d.]+),/);
      if (!m) continue;
      const [fx, fy] = [parseFloat(m[1]), parseFloat(m[2])];
      if (Math.abs(fx - tx * sB) > 15 * K * sB ||
          fy < (ty - 30 * K) * sB || fy > (ty + 5 * K) * sB)
        stray = stray || "(" + fx + ", " + fy + ") vs (" +
                (tx * sB) + ", " + (ty * sB) + ")";
    }
    TRACE.length = 0; reset();
    ok(\`the saguaro stands on \${c.st} at (\${c.x},\${c.y})\`,
       stray === null,
       stray || "all its strokes near its tile");
  }

  // creatures move with the glide: same spot, different phase,
  // different strokes
  const staticDeer = { id: 2, x: 4, y: 2, px: 4, py: 2, sp: "deer", ag: 12 };
  const d1 = hash(traceOf(() => drawAnimal(staticDeer, 0.25, tsec, 0)));
  const d2 = hash(traceOf(() => drawAnimal(staticDeer, 0.75, tsec, 0)));
  ok("the deer's strokes move with the glide", d1 !== d2,
     \`\${d1} vs \${d2}\`);
  const staticOwl = { id: 4, x: 2, y: 4, px: 2, py: 4, sp: "owl", ag: 12 };
  const o1 = hash(traceOf(() => drawAnimal(staticOwl, 0.3, tsec, 0)));
  const o2 = hash(traceOf(() => drawAnimal(staticOwl, 0.7, tsec, 0)));
  ok("the owl's strokes move with the glide", o1 !== o2,
     \`\${o1} vs \${o2}\`);

  // follow-cam: opening a biography then pressing follow keeps the soul
  let followErr = null, followed = null;
  try {
    openBio(7, "animal", "fox", "Sly");
    await 0;                        // the ledger's fetch settles
    await 0;
    const fb = document.getElementById("followBtn");
    if (fb.onclick) fb.onclick();
    followed = ST.follow || null;
  } catch (e) { followErr = String(e && e.message || e); }
  ok("follow keeps the soul",
     followErr === null && followed && followed.oid === 7,
     followErr ? ("throws: " + followErr) :
     followed ? (followed.oid + ", " + followed.kind) : "nothing followed");

  out.ok = okn; out.fail = failn;
  return out;
})()
`;

/* ---- node side ------------------------------------------------------- */
(async () => {
  const out = await vm.runInContext(driver, sandbox, { filename: "driver.js" });
  console.log(`scene_check — ${out.ok} pass, ${out.fail} fail`);
  for (const c of out.checks)
    console.log(`  ${c.pass ? "·" : "✗"} ${c.name}` +
                (c.pass && c.detail ? ` (${c.detail})` :
                 !c.pass ? ` — ${c.detail}` : ""));
  if (out.crash) {
    console.log("CRASH inside the scene draw:\n" + out.crash);
    process.exit(1);
  }
  process.exit(out.fail ? 1 : 0);
})().catch(e => { console.error("harness failed:", e.stack); process.exit(1); });