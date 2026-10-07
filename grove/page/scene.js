/* ================= canvas scene ================= */
/* the engine decided in boot; the scene's own canvas stays untouched
   when pixi will own the paint — a 2d context, once taken, closes the
   door forever */
if (new URLSearchParams(location.search).has("plain"))
  document.body.classList.add("plain");

const TW = 40, TH = 20;              // isometric tile diamond (2:1)
const SIDE = 17;                     // slab thickness under the floor
const PADX = 30, PADY = 72;          // margins head-/foot-room
const cnv = $("scene");     // kept for the plain word-map and history
let ctx = null;              // the recipes draw only inside captures
const DPR = Math.max(1.5, window.devicePixelRatio || 1);
/* art factor: everything drawn scales with the tile size */
const K = TW / 30;
let OX = 0, OY = 0, CW = 0, CH = 0, FIT = 1, PX = 0, PY = 0;
/* contain-fit: the scene takes whatever room the window gives it,
   drawn at device resolution so zoom stays sharp; only re-fits when
   the size, zoom or window box actually changed */
let VIEW = { dw: 0, dh: 0, zoom: 1 };
function fitCanvas(size) {
  const sc = document.querySelector(".map-scroll");
  const availW = (sc ? sc.clientWidth : window.innerWidth - 20) || 600;
  const availH = (sc ? sc.clientHeight : window.innerHeight - 200) || 400;
  const SW = (size - 1) * TW + TW + PADX * 2;   // the scene's own box
  const SH = (size - 1) * TH + TH + PADY * 2;
  const key = `${size}|${VIEW.zoom}|${Math.round(availW)}x${Math.round(availH)}`;
  if (fitCanvas.key === key) return;
  fitCanvas.key = key;
  /* the canvas is the screen at fit — the whole window, sky and all —
     and the island floats centered inside it; zoomed, the box grows
     past the window and the scroller pans, as it did */
  CW = VIEW.zoom === 1 ? availW : availW * VIEW.zoom;
  CH = VIEW.zoom === 1 ? availH : CW * SH / SW;
  VIEW.dw = CW; VIEW.dh = CH;
  FIT = Math.min(CW / SW, CH / SH);             // the world's fit scale
  PX = (CW - SW * FIT) / 2;                     // where the world sits
  PY = (CH - SH * FIT) / 2;                     // on that canvas
  OX = SW / 2; OY = PADY;          // world-local, where the top corner lives
  ENG.sceneBox = { w: SW, h: SH, fit: FIT, px: PX, py: PY };
  if (ENG && ENG.app)
    ENG.app.renderer.resize(Math.round(VIEW.dw), Math.round(VIEW.dh),
                            DPR);
  else fitCanvas.key = null;             // retry once the app lives
}
window.addEventListener("resize", () => {
  if (ST.s && ST.s.size) fitCanvas(ST.s.size);
});
/* cell (x, y) → the world's local position of the diamond's center;
   the world sits placed by (PX, PY) and scaled by FIT on the canvas */
function iso(x, y) { return [OX + (x - y) * TW / 2, OY + (x + y) * TH / 2]; }

/* the earth's own scale: units of elevation to pixels, from the pack
   (the desert makes taller dunes than the grove does) */
function elevPx() {
  const b = ST.s && ST.s.biome;
  return (b && b.elev_px) || 26;
}
/* the world's landform, gentled for the eye: the elev field keeps its
   own noise as data, but three diffusion passes make neighbours agree
   before it is drawn, so the ground rolls where once it stepped.
   Cached per tick; the world's own data is never rewritten. */
const ELEV_CACHE = { tick: -1, field: null };
function elevField(s) {
  if (ELEV_CACHE.tick === s.tick && ELEV_CACHE.field)
    return ELEV_CACHE.field;
  const size = s.size, n = s.cells.length;
  let f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = s.cells[i][5] || 0;
  for (let pass = 0; pass < 3; pass++) {
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i % size, y = (i / size) | 0;
      let tot = f[i] * 3, cnt = 3;       // the cell keeps most its own
      if (x > 0)        { tot += f[i - 1]; cnt++; }
      if (x < size - 1) { tot += f[i + 1]; cnt++; }
      if (y > 0)        { tot += f[i - size]; cnt++; }
      if (y < size - 1) { tot += f[i + size]; cnt++; }
      g[i] = tot / cnt;
    }
    f = g;
  }
  ELEV_CACHE.tick = s.tick;
  ELEV_CACHE.field = f;
  return f;
}
function elevAt(x, y) {
  const s = ST.s;
  if (!s || !s.cells) return 0;
  return Math.max(0, elevField(s)[y * s.size + x]) * elevPx();
}

/* a deterministic per-object nudge: the forest is not stamped on a
   grid — every thing stands a breath off-centre, at its own size,
   stable to its id so it never wobbles between frames */
function jit(seed, salt) {                    // [0, 1), stable for a seed
  const x = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const SEASONS = {
  spring: { grass: "#6fa053", soil: "#4a3a29", water: "#2a4d66",
            rock: "#5d6266", pine: "#2f6038", leaf: "#6f9f4a",
            canopyDim: 1.0, wash: null,
            under: "#3f6d38", bush: "#4a7a3a", fruit: "#b03a48",
            nightT: "#141a22", nightB: "#1c2419" },
  summer: { grass: "#5d8f45", soil: "#45362a", water: "#27496b",
            rock: "#5a6062", pine: "#2a5630", leaf: "#5f9440",
            canopyDim: 1.0, wash: null,
            under: "#3f6d38", bush: "#4a7a3a", fruit: "#b03a48",
            nightT: "#101820", nightB: "#18251a" },
  autumn: { grass: "#9a8a4a", soil: "#4d3a28", water: "#284a5e",
            rock: "#5d6266", pine: "#2d5035", leaf: "#b0762f",
            canopyDim: 1.0, wash: null,
            under: "#4a5c33", bush: "#50762f", fruit: "#a3472e",
            nightT: "#161418", nightB: "#241f16" },
  winter: { grass: "#a8b3ad", soil: "#5a5148", water: "#31536e",
            rock: "#68707a", pine: "#2c4a42", leaf: "#86775d",
            canopyDim: 0.85, wash: "rgba(190,215,225,0.10)",
            under: "#54724e", bush: "#506a48", fruit: "#46514a",
            nightT: "#0d1218", nightB: "#1a2226" },
};
function hexToRgb(h) {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
/* two palettes blend mid-air between seasons: the first leaves of
   spring arrive in the air of winter */
function mixPal(a, b, m) {
  const out = { wash: b.wash, mix: m };
  for (const k of ["grass", "soil", "water", "rock", "pine", "leaf",
        "under", "bush", "fruit"]) {
    const A = hexToRgb(a[k]), B = hexToRgb(b[k]);
    out[k] = "rgb(" + Math.round(A[0] + (B[0] - A[0]) * m) + "," +
        Math.round(A[1] + (B[1] - A[1]) * m) + "," +
        Math.round(A[2] + (B[2] - A[2]) * m) + ")";
  }
  out.canopyDim = a.canopyDim + (b.canopyDim - a.canopyDim) * m;
  out.nightT = "rgb(" + hexToRgb(a.nightT).map((v, i) =>
      Math.round(v + (hexToRgb(b.nightT)[i] - v) * m)).join(",") + ")";
  out.nightB = "rgb(" + hexToRgb(a.nightB).map((v, i) =>
      Math.round(v + (hexToRgb(b.nightB)[i] - v) * m)).join(",") + ")";
  return out;
}
function pal() {
  const s = ST.s || {};
  const cur = SEASONS[s.season || "spring"] || SEASONS.spring;
  if (!s.tick) return cur;
  const weekIn = ((s.tick - 1) % 12) + 1;
  if (weekIn > 2) return cur;            // the blend only spans two weeks
  const names = ["spring", "summer", "autumn", "winter"];
  const prev = SEASONS[names[(names.indexOf(s.season) + 3) % 4]];
  return mixPal(prev, cur, weekIn / 3);
}

/* species -> drawn shape; the pack may set its own map, and it carries
   the guests' half too (a desert's shrike rides the robin's shape) */
let SHAPES = { pine: "pine", birch: "deciduous", willow: "deciduous",
               fern: "fronds", berry: "bush" };
function shapeOf(a) { return SHAPES[a.sp] || a.sp; }
const ANIMAL_BODY = {
  rabbit: "#9b8d90", deer: "#a8834f", fox: "#c26a35", owl: "#8d7358",
  robin: "#7d8ba0", boar: "#5c4a42", stag: "#9a7546", wolf: "#8a8f94",
};

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
  c.fill();
}

/* one isometric ground diamond centered at (cx, cy) */
function diamondPath(c, cx, cy) {
  c.beginPath();
  c.moveTo(cx, cy - TH / 2);
  c.lineTo(cx + TW / 2, cy);
  c.lineTo(cx, cy + TH / 2);
  c.lineTo(cx - TW / 2, cy);
  c.closePath();
}

/* soft ellipse shadow that grounds a standing thing */
function shadow(cx, cy, rx) {
  ctx.fillStyle = "rgba(8,14,11,0.20)";
  ctx.beginPath(); ctx.ellipse(cx, cy + 2 * K, rx * K, rx * 0.38 * K,
                               0, 0, 6.3);
  ctx.fill();
}

/* -------- the air the world floats in —— ----------------------------- */
/* deterministic star field, built once */
const STARS = (() => {
  let x = 99;
  const r = () => (x = (x * 48271) % 2147483647) / 2147483647;
  const arr = [];
  for (let i = 0; i < 110; i++)
    arr.push({ u: r(), v: r() * 0.9, s: 0.5 + r() * 1.1,
               tw: r() * 6.3, br: 0.25 + r() * 0.4 });
  return arr;
})();

/* the water's body: the filled tile and its dark heart — these stand
   in the baked earth; only the light upon them breathes live */
function drawWaterCellStatic(s, i, p, elevF) {
  const size = s.size;
  const [sx, sy0] = iso(i % size, (i / size) | 0);
  const sy = sy0 - Math.max(0, elevF[i]) * elevPx();
  ctx.fillStyle = p.water;
  diamondPath(ctx, sx, sy); ctx.fill();
  // depth: a darker heart in the water, the shallows reading lighter
  const D = 0.62;
  ctx.fillStyle = "rgba(6,14,26,0.16)";
  ctx.beginPath();
  ctx.moveTo(sx, sy - TH / 2 * D);
  ctx.lineTo(sx + TW / 2 * D, sy);
  ctx.lineTo(sx, sy + TH / 2 * D);
  ctx.lineTo(sx - TW / 2 * D, sy);
  ctx.closePath(); ctx.fill();
}

/* the water light's own clock — one truth for every engine */
function waterLight(i, tsec) {
  return { w1: Math.sin(tsec * 1.4 + i * 1.7) * 2,
           w2: Math.sin(tsec * 0.9 + i * 2.3) * 3,
           foam: Math.sin(tsec * 1.8 + i * 0.9) };
}

/* a land cell: soil, grass, tufts, stone, walls, shore, seams — the
   earth has no tide, so none of this depends on the frame */
function drawLandCell(s, i, p, elevF) {
  const size = s.size, px = elevPx();
  const c = s.cells[i];
  const x = i % size, y = Math.floor(i / size);
  const eMe = Math.max(0, elevF[i]);   // the tile and its walls agree
  const [sx, sy0] = iso(x, y);
  const sy = sy0 - eMe * px;           // the land rises here
  diamondPath(ctx, sx, sy);
  ctx.fillStyle = p.soil;
    ctx.fill();
    const g = c[1];
    if (g > 0.06) {
      ctx.globalAlpha = Math.min(1, g * 0.9);
      ctx.fillStyle = p.grass;
      diamondPath(ctx, sx, sy); ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (g > 0.45) {              // tall grass carries tufts of its own
      const T = 2 + i * 7 % 3;
      ctx.strokeStyle = p.grass; ctx.lineWidth = 1;
      for (let u = 0; u < T; u++) {
        const ux = ((i * 31 + u * 13) % 21 - 10) * 0.8,
              uy = ((i * 17 + u * 29) % 13 - 6) * 0.5;
        ctx.beginPath();
        ctx.moveTo(sx + ux, sy + uy + 3);
        ctx.quadraticCurveTo(sx + ux + 2, sy + uy - 1,
                             sx + ux + 1.4, sy + uy - 5 - u * 1.6);
        ctx.stroke();
      }
    }
    if (c[2] > 0.75) {                             // soaked ground
      ctx.fillStyle = "rgba(30,50,66,0.18)";
      diamondPath(ctx, sx, sy); ctx.fill();
    }
    if (c[0] === "r") {
      ctx.fillStyle = p.rock;
      diamondPath(ctx, sx, sy); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      ctx.beginPath();
      ctx.moveTo(sx - 5, sy); ctx.lineTo(sx, sy - 5);
      ctx.lineTo(sx + 5, sy); ctx.closePath(); ctx.fill();
      // each rock keeps its pebbles and a line or two of cracks
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      for (let u = 0; u < 3; u++) {
        ctx.beginPath();
        ctx.ellipse(sx + ((i * 23 + u * 41) % 17 - 8) * 0.9,
                    sy + ((i * 37 + u * 19) % 11 - 5) * 0.6,
                    1.6, 1.1, 0, 0, 6.3);
        ctx.fill();
      }
      ctx.strokeStyle = "rgba(0,0,0,0.14)"; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx - 6, sy + 1);
      ctx.lineTo(sx + 3 - (i % 5), sy - 2 - (i % 3));
      ctx.stroke();
    }

    /* the walls: the steps' own faces. A step's side exists whenever
       the ground beside drops — tiny ones are contour lines, tall ones
       are ledges — and nothing between is torn open. Sunlit to the SE,
       shaded to the SW; at the island's rim the face falls to the plinth. */
    const dX = (eMe - (x < size - 1 ?
                       Math.max(0, elevF[i + 1]) : 0)) * px;
    if (dX > (x === size - 1 ? 1 : 0.5)) {
      ctx.fillStyle = "#4a392a";
      ctx.beginPath();
      ctx.moveTo(sx + TW / 2, sy);
      ctx.lineTo(sx, sy + TH / 2);
      ctx.lineTo(sx, sy + TH / 2 + dX);
      ctx.lineTo(sx + TW / 2, sy + dX);
      ctx.closePath(); ctx.fill();
    }
    const dY = (eMe - (y < size - 1 ?
                       Math.max(0, elevF[i + size]) : 0)) * px;
    if (dY > (y === size - 1 ? 1 : 0.5)) {
      ctx.fillStyle = "#3a2d20";
      ctx.beginPath();
      ctx.moveTo(sx, sy + TH / 2);
      ctx.lineTo(sx - TW / 2, sy);
      ctx.lineTo(sx - TW / 2, sy + dY);
      ctx.lineTo(sx, sy + TH / 2 + dY);
      ctx.closePath(); ctx.fill();
    }

    /* the shore: ground that touches water wears a wet rim, and the
       quiet edges grow reeds and hold stones */
    const nbrs4 = [i + 1, i - 1, i + size, i - size];
    let wet = false;
    for (let e = 0; e < 4; e++) {
      const j = nbrs4[e];
      if (j >= 0 && j < s.cells.length &&
          !(e === 0 && (i % size) === size - 1) &&
          !(e === 1 && (i % size) === 0) &&
          s.cells[j][0] === "w") wet = true;
    }
    if (wet) {
      ctx.fillStyle = "rgba(24,20,12,0.16)";
      diamondPath(ctx, sx, sy); ctx.fill();
      if (c[1] < 0.5 && i * 13 % 3 !== 2) {          // reeds at the shore
        ctx.strokeStyle = p.under; ctx.lineWidth = 1.1;
        for (let u = 0; u < 3; u++) {
          const ux = ((i * 23 + u * 41) % 17 - 8) * 0.75,
                h2 = 5 + (i * 11 + u * 7) % 4;
          ctx.beginPath();
          ctx.moveTo(sx + ux, sy + 2);
          ctx.quadraticCurveTo(sx + ux + 0.6, sy - h2 * 0.5,
                               sx + ux + 1, sy - h2);
          ctx.stroke();
          ctx.fillStyle = "#6b4a33";
          ctx.fillRect(sx + ux + 0.7, sy - h2 - 2.4, 1.2, 2.4);
        }
      } else {                                       // or holds a stone
        ctx.fillStyle = "rgba(94,98,102,0.6)";
        ctx.beginPath();
        ctx.ellipse(sx + (i * 19 % 9 - 4), sy + (i * 7 % 5 - 2) * 0.6,
                    2.4, 1.5, 0, 0, 6.3);
        ctx.fill();
      }
    }

    /* faint diamond seams so the grid reads */
    ctx.strokeStyle = "rgba(0,0,0,0.055)";
    ctx.lineWidth = 1;
    diamondPath(ctx, sx, sy); ctx.stroke();

    if (c[3]) {                                    // mushrooms
      ctx.fillStyle = "rgba(8,14,11,0.10)";
      ctx.beginPath(); ctx.ellipse(sx + 1, sy + 4, 4, 1.6, 0, 0, 6.3);
      ctx.fill();
      ctx.fillStyle = "#e8e3d2";
      ctx.fillRect(sx - 1, sy - 2, 2, 5);
      ctx.fillStyle = "#b0483c";
      ctx.beginPath(); ctx.arc(sx, sy - 2, 4, 3.2, 6.1); ctx.fill();
    }
    if (c[4]) {                                    // carrion
      ctx.fillStyle = "#c9c2b8";
      ctx.beginPath(); ctx.arc(sx, sy + 2, 3.2, 0, 6.3); ctx.fill();
    }
}

/* the whole earth — stone, soil and water's body — with the water's
   light on top; this draws today only where the offscreen bake can't */
/* the world sits on a raised earth slab */
function drawSlab(s) {
  const size = s.size, p = pal();
  const [rx, ry] = iso(size - 1, 0);
  const [bx, by] = iso(size - 1, size - 1);
  const [lx, ly] = iso(0, size - 1);
  ctx.fillStyle = "#4a392a";                       // sunlit side
  ctx.beginPath();
  ctx.moveTo(rx + TW / 2, ry);
  ctx.lineTo(bx, by + TH / 2);
  ctx.lineTo(bx, by + TH / 2 + SIDE);
  ctx.lineTo(rx + TW / 2, ry + SIDE);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#3a2d20";                       // shaded side
  ctx.beginPath();
  ctx.moveTo(bx, by + TH / 2);
  ctx.lineTo(lx - TW / 2, ly);
  ctx.lineTo(lx - TW / 2, ly + SIDE);
  ctx.lineTo(bx, by + TH / 2 + SIDE);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = "rgba(0,0,0,0.22)";              // soft ground shadow
  ctx.beginPath();
  ctx.ellipse(OX, OY + (size - 1) * TH + SIDE + 8,
              (size - 1) * TW / 2 + 30, 20, 0, 0, 6.3);
  ctx.fill();
}

/* the moonlight's dashes — one truth for every engine */
function glintDash(k, gx, gy, tsec) {
  const ph = Math.sin(tsec * 1.1 + k * 1.9);
  return { ph, lx: gx + (k - 1.5) * 9 + ph * 2.5, ly: gy + (k - 1.5) * 5 };
}

function drawPlant(t, tsec) {
  const p = pal(), sway = Math.sin(tsec * 1.1) * 0.05;
  const js = 0.92 + jit(t.id, 3) * 0.16;      // each thing's own size
  let [sx, sy] = iso(t.x, t.y);
  sy -= elevAt(t.x, t.y);                      // plants stand on the land
  sx += (jit(t.id, 1) - 0.5) * 6 * K;
  sy += (jit(t.id, 2) - 0.5) * 4 * K;
  if (t.st !== "log") {          // the ground remembers the weight
    ctx.fillStyle = "rgba(8,14,11,0.08)";
    diamondPath(ctx, sx, sy); ctx.fill();
  }
  const shape = SHAPES[t.sp] || "deciduous";
  const isPine = shape === "pine";

  if (t.st === "log") {                            // flat lying trunk
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate((t.x * 7 % 3 - 1) * 0.25);          // settled at an angle
    ctx.fillStyle = "#6b4a33";
    roundRect(ctx, -10 * K, -4 * K, 20 * K, 5 * K, 2 * K);
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.fillRect(-10 * K, -4 * K, 20 * K, 2 * K);
    ctx.restore();
    return;
  }
  if (shape === "fronds") {
    const stem = p.under || "#3f6d38";
    ctx.strokeStyle = stem; ctx.lineWidth = 1.4 * K;
    for (let k = -2; k <= 2; k++) {
      ctx.beginPath();
      ctx.moveTo(sx, sy + 2 * K);
      ctx.quadraticCurveTo(sx + k * 4 * K * js, sy - 6 * K,
                           sx + k * 6 * K * js, sy - 11 * K * js +
                           sway * 26 * K);
      ctx.stroke();
    }
    return;
  }
  if (shape === "bush") {
    shadow(sx, sy, 6);
    ctx.fillStyle = p.bush || "#4a7a3a";
    ctx.beginPath();
    ctx.ellipse(sx, sy - 3 * K, 7.5 * K * js, 5.2 * K * js, 0, 0, 6.3);
    ctx.fill();
    if (t.b) {
      ctx.fillStyle = p.fruit || "#b03a48";
      for (const [bx, byy] of [[-3.5, -4], [1, -6.5], [4, -3.5]]) {
        ctx.beginPath();
        ctx.arc(sx + bx * K, sy + byy * K, 1.5 * K, 0, 6.3); ctx.fill();
      }
    }
    return;
  }
  if (shape === "cactus") {
    ctx.save();
    ctx.translate(sx, sy);          // the body was written translated —
    shadow(0, 0, 7);                // but nothing ever moved it there
    ctx.fillStyle = p.pine;
    const h = (t.st === "old" ? 26 : t.st === "mature" ? 21 : 8) *
              (0.94 + jit(t.id, 4) * 0.12);
    ctx.fillRect(-2.5 * K, -h * K, 5 * K, h * K);
    ctx.beginPath();                                  // the rounded top
    ctx.ellipse(0, -h * K, 2.5 * K, 2 * K, 0, 0, 6.3); ctx.fill();
    if (t.st !== "sapling") {                         // the two arms
      ctx.fillRect(-8 * K, -h * K + 7 * K, 3.2 * K, 6 * K);
      ctx.fillRect(-8 * K, -h * K + 4.4 * K, 8 * K, 2.2 * K);
      ctx.fillRect(4.8 * K, -h * K + 11 * K, 3.2 * K, 5 * K);
      ctx.fillRect(0, -h * K + 9 * K, 8 * K, 2.2 * K);
    }
    ctx.restore();
    return;
  }
  // trees
  let scale = t.st === "mature" ? 1 : t.st === "old" ? 1.1 : 0.55;
  if (t.el) scale *= 1.12;
  scale *= js * K;                                 // art grows with tiles
  shadow(sx, sy, 9 * scale);
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(sway * (isPine ? 0.35 : 0.85));
  const trunkCol = t.sp === "birch" ? "#d9d4c9"
      : t.sp === "willow" ? "#8a7663" : "#5b422f";
  const trunkH = isPine ? 7 : 10, tw = (t.st === "sapling" ? 2 : 3) * K;
  ctx.fillStyle = trunkCol;
  ctx.beginPath();              // the trunk tapers, the root spreads
  ctx.moveTo(-tw * 0.8, 0);
  ctx.lineTo(-tw * 0.3, -trunkH * scale);
  ctx.lineTo(tw * 0.3, -trunkH * scale);
  ctx.lineTo(tw * 0.8, 0);
  ctx.closePath(); ctx.fill();
  if (t.sp === "birch" && t.st !== "sapling") {
    ctx.fillStyle = "rgba(70,70,70,0.7)";
    ctx.fillRect(-1.1 * K, -trunkH * scale + 2, 1.2 * K, K);
  }
  const leafCol = isPine ? p.pine : p.leaf;
  const dim = p.canopyDim === undefined ? 1 : p.canopyDim;
  if (isPine) {
    ctx.globalAlpha = dim;              // winter thins the canopy
    ctx.fillStyle = leafCol;
    for (let k = 0; k < 3; k++) {
      const w = (11 - k * 3) * scale, h = (9 - k) * scale,
            oy = -(7 + k * 4.5) * scale;
      ctx.beginPath();
      ctx.moveTo(0, oy - h);
      ctx.lineTo(w, oy);
      ctx.lineTo(-w, oy);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = "rgba(8,18,14,0.14)";   // each tier's shaded side
      ctx.beginPath();
      ctx.moveTo(0, oy - h);
      ctx.lineTo(w, oy);
      ctx.lineTo(w * 0.12, oy - h * 0.3);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = leafCol;
    }
    if (ST.s && ST.s.season === "winter") {
      ctx.fillStyle = "rgba(240,246,250,0.55)";
      ctx.beginPath();
      ctx.moveTo(0, -22 * scale); ctx.lineTo(3.5 * scale, -17 * scale);
      ctx.lineTo(-3.5 * scale, -17 * scale);
      ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else {
    const r = 9.5 * scale;
    const cy = -trunkH * (t.st === "sapling" ? 1.15 : 1) - r * 0.55;
    ctx.globalAlpha = dim;              // winter thins the canopy here too
    ctx.fillStyle = leafCol;
    ctx.beginPath();
    ctx.ellipse(0, cy, r, r * 0.72, 0, 0, 6.3); ctx.fill();
    ctx.globalAlpha = dim * 0.85;
    ctx.beginPath();
    ctx.ellipse(r * 0.5, cy + r * 0.3, r * 0.68, r * 0.5, 0, 0, 6.3);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(-r * 0.55, cy + r * 0.15, r * 0.6, r * 0.45, 0, 0, 6.3);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(255,244,200,0.13)";     // the sun's NW side
    ctx.beginPath();
    ctx.ellipse(-r * 0.42, cy - r * 0.34, r * 0.5, r * 0.36, 0, 0, 6.3);
    ctx.fill();
    ctx.fillStyle = "rgba(10,20,14,0.16)";        // the canopy's own shade
    ctx.beginPath();
    ctx.ellipse(r * 0.3, cy + r * 0.42, r * 0.72, r * 0.4, 0, 0, 6.3);
    ctx.fill();
    if (t.sp === "willow") {                       // drooping fronds
      ctx.strokeStyle = leafCol; ctx.lineWidth = 1.3;
      for (let k = -2; k <= 2; k++) {
        ctx.beginPath();
        ctx.moveTo(k * 3, cy + r * 0.3);
        ctx.quadraticCurveTo(k * 5.5, cy + r * 0.9, k * 7, cy + r * 1.6);
        ctx.stroke();
      }
    }
    if (t.st === "old" || t.el) {
      ctx.fillStyle = "rgba(30,42,28,0.22)";
      ctx.beginPath();
      ctx.ellipse(-r * 0.3, cy - r * 0.35, r * 0.5, r * 0.38, 0, 0, 6.3);
      ctx.fill();
    }
  }
  ctx.restore();
  if ((t.st === "old" || t.el) && t.n && t.n !== "-") {
    const ly = -trunkH * 2 - 16 * scale;
    ctx.font = "italic 9px Georgia, serif";
    ctx.fillStyle = "rgba(10,14,12,0.65)";
    ctx.fillText(t.n, sx + 1, ly);
    ctx.fillStyle = "#dfe9db";
    ctx.fillText(t.n, sx, ly - 1);
  }
}

/* where a creature is and how it moves: one function, shared by every
   engine that draws creatures — the recipes consume it, never repeat it */
function animalGait(a, f, tsec, idx) {
  // glide between week-start and week-end cells — in iso space
  const e = f < 1 ? (f * f * (3 - 2 * f)) : 1;   // smoothstep
  const cx0 = ((a.px - a.py) * TW / 2), cy0 = ((a.px + a.py) * TH / 2);
  const cx1 = ((a.x - a.y) * TW / 2), cy1 = ((a.x + a.y) * TH / 2);
  const gx = cx0 + (cx1 - cx0) * e, gy = cy0 + (cy1 - cy0) * e;
  // the flock, too, is not stamped on a grid: a breath off-centre and
  // a size of its own, stable to its id — it never wobbles in flight
  const jx = (jit(a.id, 5) - 0.5) * 4 * K,
        jy = (jit(a.id, 6) - 0.5) * 3 * K,
        js = 0.95 + jit(a.id, 7) * 0.10;
  // face the direction of glide; keep the facing when the glide is done
  // or when a creature briefly stands still (index-sticky across polls)
  const dx = cx1 - cx0;
  if (Math.abs(dx) > 0.9) FACING[idx] = dx < 0 ? -1 : 1;
  const flip = FACING[idx] || 1;
  const shape = shapeOf(a);
  const flyer = shape === "owl" || shape === "robin";
  // children are children: little for their first six weeks
  const szc = a.ag !== undefined && a.ag < 6 ? 0.62 : 1;
  const lift =
      flyer ? -9 + (f < 1 ? Math.sin(tsec * 14 + a.id) * 1.1 : 0)
      : (shape === "rabbit" && f < 1
         ? -Math.abs(Math.sin(f * 12 + a.id)) * 5   // rabbits hop with the glide
         : Math.sin(tsec * 5 + a.x) * 0.8) * szc;
  /* landing: the hop's own phase tells when a rabbit touches ground —
     mid-air they stretch, on the landing they squash */
  const hopP = shape === "rabbit" && f < 1 ?
      Math.abs(Math.sin(f * 12 + a.id)) : 0;
  const sqx = hopP && hopP < 0.3 ? 1.08 : 1,
        sqy = hopP && hopP < 0.3 ? 0.88 : 1;
  /* every gait rides the glide too: while a creature covers its journey
     its legs swing through a stride or two; standing, they rest */
  const stride = f < 1 ? 1 : 0;
  // creatures stand on the land: their height rides between the start
  // and end cells' elevations as they glide
  const eL = elevAt(a.px ?? a.x, a.py ?? a.y) +
      (elevAt(a.x, a.y) - elevAt(a.px ?? a.x, a.py ?? a.y)) * e;
  return { e, gx, gy, flip, flyer, szc, jx, jy, js, stride, lift,
           hopP, sqx, sqy, eL };
}

/* the phases a body needs — one truth for frames and captured poses */
function gaitPhases(a, f, tsec) {
  return {
    stride: f < 1 ? 1 : 0,
    dTrot: f < 1 ? Math.sin(f * 14 + a.id * 2) * 1.2 : 0,
    bTrot: f < 1 ? Math.sin(f * 14 + a.id) * 1.2 : 0,
    flap: f < 1 ? Math.sin(f * 20 + a.id) : 0.3,
    rf: f < 1 ? Math.sin(f * 24 + a.id) : 0.4,
    flick: Math.pow(Math.max(0,
        Math.sin(tsec * 0.9 + a.id * 2) - 0.94) / 0.06, 2),
    tail: Math.sin(tsec * (f < 1 ? 5.5 : 3) + a.id) * (f < 1 ? 2.4 : 1.6),
    winter: !!(ST.s && ST.s.season === "winter"),
  };
}

/* the creature's body in local units — no shadow, no label, no
   transform: the one truth every engine captures from */
function animalBody(shape, a, ph) {
  const body = ANIMAL_BODY[a.sp] || "#999";
  const winter = ph.winter;
  switch (shape) {
    case "rabbit":
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(0, 2, 5, 4, 0, 0, 6.3); ctx.fill();
      // ears: the far one flicks on its own quiet alarm
      const flick = ph.flick;
      ctx.beginPath(); ctx.ellipse(2, -3, 1.6, 4, 0.35, 0, 6.3); ctx.fill();
      ctx.beginPath(); ctx.ellipse(4.4, -3, 1.6, 4, 0.2 - flick * 0.4,
                                   0, 6.3); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(-4.5, 1, 2.2, 0, 6.3); ctx.fill();
      break;
    case "deer": case "stag": {
      const sz = a.sp === "stag" ? 1.2 : 1;
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(0, 1, 7 * sz, 4 * sz, 0, 0, 6.3);
      ctx.fill();
      // a trot: each pair swings against the other, the far pair dimmer
      const trot = ph.dTrot;
      ctx.fillStyle = "#8a6a45";
      ctx.fillRect(-3.6 - trot, 4.2, 1.4, 3.6 * sz);
      ctx.fillRect(4.4 + trot, 4.2, 1.4, 3.6 * sz);
      ctx.fillStyle = body;
      ctx.fillRect(-5 + trot, 4, 1.6, 4 * sz);
      ctx.fillRect(3 - trot, 4, 1.6, 4 * sz);
      ctx.beginPath(); ctx.arc(6, -2 * sz, 2.4, 0, 6.3); ctx.fill();
      ctx.strokeStyle = winter ? "#d9d4c9" : "#775f38"; ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(6.5, -4); ctx.lineTo(7.5, -8); ctx.lineTo(9.5, -9);
      ctx.moveTo(5.5, -4); ctx.lineTo(4.5, -8); ctx.lineTo(2.5, -9);
      ctx.stroke();
      break;
    }
    case "fox":
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(0, 2, 6, 3.2, 0, 0, 6.3); ctx.fill();
      ctx.beginPath(); ctx.arc(5.4, 0, 2.1, 0, 6.3); ctx.fill();
      ctx.fillStyle = "#e8dccb";
      // the tail flicks quicker in flight
      const tailSway = ph.tail;
      ctx.beginPath();
      ctx.moveTo(-4, 1.5);
      ctx.quadraticCurveTo(-9, -1 + tailSway, -8, -6 + tailSway * 1.4);
      ctx.lineTo(-6, -2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(-5, 2.5, 1.7, 0, 6.3); ctx.fill();
      if (a.h) {                       // the hungry eye glints
        ctx.fillStyle = "#f2c96a";
        ctx.beginPath(); ctx.arc(5.8, -0.5, 0.7, 0, 6.3); ctx.fill();
      }
      break;
    case "owl":
      // the wings beat behind the body, once or twice a glide
      const flap = ph.flap;
      ctx.fillStyle = "rgba(0,0,0,0.16)";
      ctx.beginPath();
      ctx.ellipse(-4.8, -1.2 + flap * 2.1, 3.1, 1.15,
                  -0.55 + flap * 0.55, 0, 6.3); ctx.fill();
      ctx.beginPath();
      ctx.ellipse(4.8, -1.2 - flap * 2.1, 3.1, 1.15,
                  0.55 - flap * 0.55, 0, 6.3); ctx.fill();
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(0, 0, 4.6, 5.6, 0, 0, 6.3); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath(); ctx.arc(-1.6, -1.5, 1.3, 0, 6.3); ctx.fill();
      ctx.beginPath(); ctx.arc(1.6, -1.5, 1.3, 0, 6.3); ctx.fill();
      ctx.fillStyle = "#222";
      ctx.beginPath(); ctx.arc(-1.6, -1.5, 0.6, 0, 6.3); ctx.fill();
      ctx.beginPath(); ctx.arc(1.6, -1.5, 0.6, 0, 6.3); ctx.fill();
      if (a.h) {
        ctx.fillStyle = "#f2c96a";
        ctx.beginPath(); ctx.arc(-1.6, -1.5, 0.3, 0, 6.3); ctx.fill();
        ctx.beginPath(); ctx.arc(1.6, -1.5, 0.3, 0, 6.3); ctx.fill();
      }
      break;
    case "robin":
      // small wings, busy in flight
      const rf = ph.rf;
      ctx.fillStyle = "rgba(0,0,0,0.15)";
      ctx.beginPath();
      ctx.ellipse(-3.3, -0.5 + rf * 1.4, 1.9, 0.85,
                  -0.45 + rf * 0.5, 0, 6.3); ctx.fill();
      ctx.beginPath();
      ctx.ellipse(3.3, -0.5 - rf * 1.4, 1.9, 0.85,
                  0.45 - rf * 0.5, 0, 6.3); ctx.fill();
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(0, 0, 3.6, 3, 0, 0, 6.3); ctx.fill();
      ctx.fillStyle = "#b25c3e";
      ctx.beginPath(); ctx.ellipse(1.2, 0.8, 1.6, 1.2, 0, 0, 6.3); ctx.fill();
      ctx.fillStyle = "#494f5c";
      ctx.beginPath(); ctx.arc(-2.6, -1.6, 1.5, 0, 6.3); ctx.fill();
      break;
    case "tortoise":
      ctx.fillStyle = "#7d8a5a";
      ctx.beginPath(); ctx.ellipse(0, 2, 5.5, 3.6, 0, 0, 6.3); ctx.fill();
      ctx.fillStyle = "#5d6b42";
      ctx.beginPath(); ctx.ellipse(0, 0.5, 4, 2.6, 0, 0, 6.3); ctx.fill();
      ctx.fillStyle = "#7d8a5a";
      ctx.beginPath(); ctx.arc(5.4, 2.6, 1.6, 0, 6.3); ctx.fill();
      break;
    case "boar":
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(0, 1.5, 6.4, 4.2, 0, 0, 6.3); ctx.fill();
      ctx.strokeStyle = "#4a3b35"; ctx.lineWidth = 1;
      // a trot, too, when the boar moves
      const bt = ph.bTrot;
      ctx.beginPath();
      ctx.moveTo(-4 + bt, 5); ctx.lineTo(-4 + bt, 7);
      ctx.moveTo(3 - bt, 5); ctx.lineTo(3 - bt, 7);
      ctx.stroke();
      ctx.fillStyle = "#3a2f2b";
      ctx.beginPath(); ctx.arc(6.2, 0.5, 2.4, 0, 6.3); ctx.fill();
      ctx.fillStyle = "#e8e3d2";
      ctx.beginPath(); ctx.arc(7.4, 1.6, 1, 0, 6.3); ctx.fill();
      break;
    default:  // wolf
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(0, 1, 6.6, 3.4, 0, 0, 6.3); ctx.fill();
      ctx.beginPath(); ctx.arc(5.8, -1, 2.3, 0, 6.3); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(4.2, -3); ctx.lineTo(5.2, -6); ctx.lineTo(6.4, -3.4);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = body; ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(-5, 0); ctx.quadraticCurveTo(-9, 2, -8, 7); ctx.stroke();
      if (a.h) {                       // the wolf's hungry eye
        ctx.fillStyle = "#f2c96a";
        ctx.beginPath(); ctx.arc(6.4, -1.3, 0.6, 0, 6.3); ctx.fill();
      }
      break;
  }
}

/* particles fall over the whole scene */
const dots = [];

/* The box the air is seen through, in WORLD units. Every particle's sprite
   is a child of ENG.poolLayer, which lives inside ENG.worldGroup — placed
   at (PX, PY) and scaled by FIT — so a particle must be made and culled in
   the units the island is drawn in, not in canvas pixels. The two agree
   only at FIT 1: on a phone the island is wider than the screen, and rain
   spawned over canvas x 0..CW world-units covered the left sliver of it —
   never more than FIT of the window, however long you watched. */
function airBox() {
  if (!FIT) return { x0: 0, x1: CW, y0: 0, y1: CH };
  return { x0: -PX / FIT, x1: (CW - PX) / FIT,
           y0: -PY / FIT, y1: (CH - PY) / FIT };
}
function airX(air) { return air.x0 + Math.random() * (air.x1 - air.x0); }

function spawnParticles(s, dt) {
  const storm = s.weather === "storm", rain = s.weather === "rain",
        frost = s.weather === "frost";
  const air = airBox();
  const count = kind => dots.reduce((n, d) => n + (d.kind === kind), 0);
  if ((rain || storm) && count("rain") < (storm ? 120 : 36) &&
      Math.random() < 0.5)
    dots.push({ kind: "rain", x: airX(air), y: air.y0 - 6,
                v: 190 + Math.random() * 90, dx: storm ? 42 : 12 });
  if (frost && count("snow") < 70)
    for (let k = 0; k < 2; k++)
      dots.push({ kind: "snow", x: airX(air), y: air.y0 - 4,
                  v: 18 + Math.random() * 14, dx: Math.random() * 10 - 5 });
  if (s.season === "autumn" && count("leaf") < 10 && Math.random() < 0.015)
    dots.push({ kind: "leaf", x: airX(air), y: air.y0 - 4,
                v: 22 + Math.random() * 16, dx: Math.random() * 24 - 12 });
  /* the air holds its own quiet life: pollen in spring, fireflies on
     summer weeks — they drift rather than fall */
  if (s.season === "spring" && count("pollen") < 18 && Math.random() < 0.06)
    dots.push({ kind: "pollen", x: airX(air),
                y: air.y0 + (air.y1 - air.y0) * (0.15 + Math.random() * 0.6),
                v: 7 + Math.random() * 8,
                dx: Math.random() * 8 - 4, ph: Math.random() * 6.3 });
  if (s.season === "summer" && count("fly") < 16 && Math.random() < 0.05)
    dots.push({ kind: "fly", x: airX(air),
                y: air.y0 + (air.y1 - air.y0) * (0.25 + Math.random() * 0.55),
                v: 0, dx: 0, ph: Math.random() * 6.3 });
}

/* the air's motion, without the drawing: positions advance, the dead
   are culled — shared by every engine that paints the air */
function updateParticles(dt) {
  const air = airBox();               // the same box they were made in
  for (let i = dots.length - 1; i >= 0; i--) {
    const d = dots[i];
    if (d.kind === "fly") {
      d.x += Math.sin(dt * 40 + d.ph) * 0.02 * 60 * dt + 6 * dt;
      d.y += Math.cos(dt * 37 + d.ph) * 0.018 * 60 * dt;
      if (d.x > air.x1 + 6) dots.splice(i, 1);
      continue;
    }
    d.y += d.v * dt; d.x += d.dx * dt;
    if (d.kind === "pollen") d.x += Math.sin(d.y * 0.05 + d.ph) * 4 * dt;
    if (d.kind === "leaf") d.x += Math.sin((d.y + i * 10) * 0.05) * 12 * dt;
    if (d.y > air.y1) dots.splice(i, 1);
  }
  if (dots.length > 260) dots.splice(0, dots.length - 260);
}

const REGIONS = { all: [0,0,1,1], NW: [0,0,.5,.5], NE: [.5,0,1,.5],
                  SW: [0,.5,.5,1], SE: [.5,.5,1,1] };
/* the soul's touch — its geometry and its breath, one truth for
   every engine */
function effectFields(e, s, tsec) {
  const reg = REGIONS[e.split(" over ")[1].split(" ")[0]] || REGIONS.all;
  const x0 = reg[0] * s.size, xe = reg[2] * s.size;
  const y0 = reg[1] * s.size, ye = reg[3] * s.size;
  const [mx, my] = iso((x0 + xe) / 2 - 0.5, (y0 + ye) / 2 - 0.5);
  const span = (Math.abs(xe - x0) + Math.abs(ye - y0)) * 0.5 * TW;
  const kind = e.startsWith("blight") ? "blight"
      : e.startsWith("drought") ? "drought" : "bloom";
  const col = kind === "blight" ? "140,60,150"
      : kind === "drought" ? "190,140,40" : "140,210,140";
  const breathe = kind === "blight" ? 0.05 * Math.sin(tsec * 1.1)
      : kind === "bloom" ? 0.03 * Math.sin(tsec * 0.7) : 0;
  const core = (kind === "drought" ? 0.17 : kind === "blight" ? 0.14
                : 0.11) + breathe;
  return { x0, xe, y0, ye, mx, my, span, kind, col, core, x0y0: [x0, y0] };
}

function bloomSpark(k, ef, tsec) {
  return { fx: ef.x0 + ((k * 7 + 3) % Math.max(1, ef.xe - ef.x0)) + 0.5,
           fy: ef.y0 + ((k * 11 + 5) % Math.max(1, ef.ye - ef.y0)) + 0.5,
           tw: Math.max(0, Math.sin(tsec * 2.2 + k * 2.6)) };
}

/* the mirror's breath — one truth for every engine */
function reflectionAlpha(i, tsec) {
  return 0.09 + 0.03 * Math.sin(tsec * 1.3 + i * 0.7);
}

/* the soul's arrival: when a new decision lands, a slow ring blooms
   from the region's heart and fades — the unseen, seen passing */
let soulRings = [];
let lastOpWeek = -1;
function checkSoulArrival(s, tnow) {
  const ops = s.ops || [];
  if (!ops.length) return;
  const last = ops[ops.length - 1];
  if (lastOpWeek < 0) { lastOpWeek = last.week; return; }
  if (last.week === lastOpWeek) return;
  lastOpWeek = last.week;
  if (last.action === "quiet") return;   // a kept peace needs no ring
  const reg = REGIONS[last.region || "all"] || REGIONS.all;
  const [mx, my] = iso((reg[0] + reg[2]) * s.size / 2 - 0.5,
                       (reg[1] + reg[3]) * s.size / 2 - 0.5);
  soulRings.push({ mx, my, t0: tnow });
  if (soulRings.length > 6) soulRings.shift();
}

/* the rings age and fall away from the list; the drawing follows */
function ageRings(tnow) {
  for (let i = soulRings.length - 1; i >= 0; i--) {
    const r = soulRings[i];
    if ((tnow - r.t0) / 2400 >= 1) soulRings.splice(i, 1);
  }
}

let flash = 0;
/* the earth, remembered: the slab, every tile's fill, the walls, the
   shore's marks, the plants at rest — drawn once to an offscreen
   canvas whenever the week, the pack's relief or the view changes.
   The frame then composites the bake and pays only for what lives:
   the water's light, the creatures, the air. */
let baked = null;
/* the earth's recipes, painted onto one surface — the single truth
   every engine captures from */
function paintEarth(oc, s, mapScale) {
  const old = ctx;
  ctx = oc;                            // the rooms serve whom they must
  ctx.setTransform(mapScale, 0, 0, mapScale, 0, 0);
  drawSlab(s);
  const p = pal();
  const elevF = elevField(s);
  for (let i = 0; i < s.cells.length; i++) {
    const c = s.cells[i];
    if (c[0] === "w") drawWaterCellStatic(s, i, p, elevF);
    else drawLandCell(s, i, p, elevF);
  }
  for (const en of plantOrder(s)) drawPlant(en, 0);   // trees at rest
  ctx = old;
}

function plantOrder(s) {
  const ents = [];
  for (const t of s.plants) ents.push(t);
  ents.sort((u, q) => (u.x + u.y) - (q.x + q.y) ||
                       (u.st === "log") - (q.st === "log"));
  return ents;
}

/* the glide's fraction, shared by every engine's creatures */
function glideOf(tnow) {
  return glidePhase();
}

function loop(tnow) {
  if (!document.body.classList.contains("plain")) {
    drawScenePixi(tnow);
    trackFollow();               // the follow-cam eases after the world moves
  }
  requestAnimationFrame(loop);
}

/* pick a cell from a click, honoring the land's relief: the flat map
   is a first guess, and the raised diamonds around it correct it */
/* a click's screen point → the world's own units: the world sits
   placed at (PX, PY) and scaled by FIT on the canvas */
function pickCell(s, u0, v0) {
  const uw = (u0 - PX) / FIT, vw = (v0 - PY) / FIT;
  const gx = Math.round((uw - OX) / (TW / 2) / 2
                        + (vw - OY) / (TH / 2) / 2);
  const gy = Math.round((vw - OY) / (TH / 2) / 2
                        - (uw - OX) / (TW / 2) / 2);
  let best = null, bestD = 1e9;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = gx + dx, y = gy + dy;
      if (x < 0 || y < 0 || x >= s.size || y >= s.size) continue;
      const [cx, cy0] = iso(x, y);
      const cy = cy0 - elevAt(x, y);
      const du = Math.abs(uw - cx) / (TW / 2) +
                 Math.abs(vw - cy) / (TH / 2);
      if (du <= 1.001) {
        const d = (uw - cx) * (uw - cx) + (vw - cy) * (vw - cy);
        if (d < bestD) { best = [x, y]; bestD = d; }
      }
    }
  return best;                    // null → the click fell on the sky
}

/* look at a tile (click) — inverse isometric mapping; a named (or lone)
   occupant opens its biography. One handler, bound to whichever canvas
   the engine put the world on. */
let sceneClickTarget = null;
function bindSceneClick(target) {
  if (sceneClickTarget === target) return;      // never twice
  sceneClickTarget = target;
  target.addEventListener("click", e => {
    const s = ST.s;
    if (!s || !s.cells) return;
    const r = target.getBoundingClientRect();
    const u0 = (e.clientX - r.left) / r.width * CW;
    const v0 = (e.clientY - r.top) / r.height * CH;
    const picked = pickCell(s, u0, v0);
    if (!picked) return;
    const [x, y] = picked;
    const c = s.cells[y * s.size + x];
    const here = [];
    for (const a of s.animals || [])
      if (a.x === x && a.y === y) here.push({ id: a.id, kind: "animal",
                                              sp: a.sp, n: a.n });
    for (const t of s.plants || [])
      if (t.x === x && t.y === y && t.st !== "log") here.push(
        { id: t.id, kind: "plant", sp: t.sp, st: t.st, n: t.n });
    const named = here.filter(t => t.n);
    if (named.length === 1 || here.length === 1) {
      const one = named[0] || here[0];
      openBio(one.id, one.kind, one.sp, one.n);
      $("look").textContent = "Here: " + (one.n || "a wild " + one.sp);
      return;
    }
    const bits = [];
    if (c[0] === "w") bits.push("the water");
    else if (c[0] === "r") bits.push("rock");
    else if (c[1] > 0.5) bits.push("long grass");
    else bits.push("open ground");
    for (const t of here)
      bits.push(`${t.n || "a wild " + t.sp} (${t.kind === "plant"
                 ? t.st : "creature"})`);
    $("look").textContent = "Here: " + bits.join(" · ");
  });
}

/* zoom: fit / 1.5x / 2x — real levels; the scroller pans when zoomed */
const zoomLevels = [["zoomFit", 1], ["zoom1x", 1.6], ["zoom2x", 2.2]];
for (const [zid, z] of zoomLevels)
  $(zid).onclick = () => {
    VIEW.zoom = z;
    fitCanvas.key = null;
    if (ST.s && ST.s.size) fitCanvas(ST.s.size);
    for (const [oid] of zoomLevels)
      $(oid).classList.toggle("on", oid === zid);
    const sc = document.querySelector(".map-scroll");
    if (sc) { sc.scrollLeft = 0; sc.scrollTop = 0; }
  };

/* ask the grove a question — answered from the world's own history */
$("askBtn").onclick = async () => {
  const q = $("qinput").value.trim();
  if (!q || !q.length) return;
  $("askout").textContent = " ☾ the grove ponders…";
  $("askBtn").disabled = true;
  try {
    const r = await fetch("/api/ask", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q }),
      signal: AbortSignal.timeout(90000) });
    const s = await r.json();
    $("askout").textContent = s.answer ? (" ☾ " + s.answer)
                                       : " ☾ no answer came";
  } catch (e) { $("askout").textContent = " ☾ the thought was lost"; }
  $("askBtn").disabled = false;
};
$("qinput").addEventListener("keydown", e => {
  if (e.key === "Enter") $("askBtn").onclick();
});

