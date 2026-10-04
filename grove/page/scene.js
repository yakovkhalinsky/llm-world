/* ================= canvas scene ================= */
try { $("scene").getContext("2d"); }
catch (e) { document.body.classList.add("plain"); }
if (new URLSearchParams(location.search).has("plain"))
  document.body.classList.add("plain");

const TW = 40, TH = 20;              // isometric tile diamond (2:1)
const SIDE = 17;                     // slab thickness under the floor
const PADX = 30, PADY = 72;          // margins head-/foot-room
const cnv = $("scene"), ctx = cnv.getContext("2d");
const DPR = Math.max(1.5, window.devicePixelRatio || 1);
/* art factor: everything drawn scales with the tile size */
const K = TW / 30;
let OX = 0, OY = 0, CW = 0, CH = 0;
/* contain-fit: the scene takes whatever room the window gives it,
   drawn at device resolution so zoom stays sharp; only re-fits when
   the size, zoom or window box actually changed */
let VIEW = { dw: 0, dh: 0, zoom: 1 };
function fitCanvas(size) {
  const sc = document.querySelector(".map-scroll");
  const availW = (sc ? sc.clientWidth : window.innerWidth - 20) || 600;
  const availH = (sc ? sc.clientHeight : window.innerHeight - 200) || 400;
  const w = (size - 1) * TW + TW + PADX * 2;
  const h = (size - 1) * TH + TH + PADY * 2;
  const key = `${size}|${VIEW.zoom}|${Math.round(availW)}x${Math.round(availH)}`;
  if (fitCanvas.key === key) return;
  fitCanvas.key = key;
  CW = w; CH = h;
  if (VIEW.zoom === 1) {
    VIEW.dw = Math.min(availW, availH * w / h);
    VIEW.dh = VIEW.dw * h / w;                 // contain: both fit
  } else {
    VIEW.dw = availW * VIEW.zoom;              // zoom wins; user pans
    VIEW.dh = VIEW.dw * h / w;
  }
  cnv.width = Math.round(VIEW.dw * DPR);
  cnv.height = Math.round(VIEW.dh * DPR);
  cnv.style.width = `${Math.round(VIEW.dw)}px`;
  cnv.style.height = `${Math.round(VIEW.dh)}px`;
  OX = w / 2;  OY = PADY;          // (0,0) sits at the top corner
  const s = VIEW.dw * DPR / w;     // logical → buffer pixels
  ctx.setTransform(s, 0, 0, s, 0, 0);
}
window.addEventListener("resize", () => {
  if (ST.s && ST.s.size) fitCanvas(ST.s.size);
});
/* cell (x, y) → screen position of the diamond's center */
function iso(x, y) { return [OX + (x - y) * TW / 2, OY + (x + y) * TH / 2]; }

/* the earth's own scale: units of elevation to pixels, from the pack
   (the desert makes taller dunes than the grove does) */
function elevPx() {
  const b = ST.s && ST.s.biome;
  return (b && b.elev_px) || 26;
}
/* a cell's drawn elevation in pixels — the land rises, water stays low */
function elevAt(x, y) {
  const s = ST.s;
  if (!s || !s.cells) return 0;
  const c = s.cells[y * s.size + x];
  return Math.max(0, (c && c[5]) || 0) * elevPx();
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

/* species -> drawn shape; the pack may set its own map */
let SHAPES = { pine: "pine", birch: "deciduous", willow: "deciduous",
               fern: "fronds", berry: "bush" };
let A_SHAPES = {};                    // guests' shapes, by species
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

function drawBackdrop(tsec) {
  // the slab floats over a deep, season-tinted night; stars shine far
  // off and cloud shadows drift beneath the world
  const p = pal();
  const sky = ctx.createLinearGradient(0, 0, 0, CH);
  sky.addColorStop(0, p.nightT);
  sky.addColorStop(1, p.nightB);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, CW, CH);
  for (const st of STARS) {
    const a = st.br * (0.6 + 0.4 * Math.sin(tsec * 1.7 + st.tw));
    ctx.fillStyle = "rgba(226,236,235," + a.toFixed(3) + ")";
    ctx.fillRect(st.u * CW, st.v * CH, st.s, st.s);
  }
  // three slow cloud shadows beneath the world
  for (let i = 0; i < 3; i++) {
    const cx = ((tsec * 11 + i * 470) % (CW + 400)) - 200;
    const cy = CH * (0.18 + i * 0.26);
    ctx.fillStyle = "rgba(10,16,13,0.10)";
    ctx.beginPath();
    ctx.ellipse(cx, cy, 150 + i * 40, 34, 0, 0, 6.3);
    ctx.fill();
  }
}

function drawMist() {
  // far-side mist: the fog lives at the scene's top, above the far woods
  const s = ST.s || {};
  const deep = (s.season === "winter") ? 0.30 :
      (s.weather === "clear") ? 0.16 : 0.23;
  const fog = ctx.createLinearGradient(0, 0, 0, CH * 0.58);
  fog.addColorStop(0, "rgba(178,206,205," + deep + ")");
  fog.addColorStop(1, "rgba(178,206,205,0)");
  ctx.fillStyle = fog;
  ctx.fillRect(0, 0, CW, CH * 0.58);
}

function drawVignette() {
  const v = ctx.createRadialGradient(
      CW / 2, CH / 2, Math.min(CW, CH) * 0.36,
      CW / 2, CH / 2, Math.max(CW, CH) * 0.74);
  v.addColorStop(0, "rgba(2,6,5,0)");
  v.addColorStop(1, "rgba(2,6,5,0.32)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, CW, CH);
}

function drawTerrain(s, tsec) {
  const p = pal(), size = s.size, px = elevPx();
  for (let i = 0; i < s.cells.length; i++) {
    const c = s.cells[i];
    const x = i % size, y = Math.floor(i / size);
    const eMe = Math.max(0, c[5] || 0);
    const [sx, sy0] = iso(x, y);
    const sy = sy0 - eMe * px;           // the land rises here

    if (c[0] === "w") {
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
      // caustics: two slow light-lines drifting over each sheet of water
      const w1 = Math.sin(tsec * 1.4 + i * 1.7) * 2;
      const w2 = Math.sin(tsec * 0.9 + i * 2.3) * 3;
      ctx.strokeStyle = "rgba(200,225,240,0.20)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx - 7, sy + w1);
      ctx.lineTo(sx + 4, sy + w1);
      ctx.moveTo(sx - 2, sy + 1 + w2 * 0.7);
      ctx.lineTo(sx + 8, sy + 1 + w2 * 0.7);
      ctx.stroke();
      // foam: light rim along every edge that faces land
      const nbrs = [i + 1, i - 1, i + size, i - size];
      for (let e = 0; e < 4; e++) {
        const j = nbrs[e];
        if (j < 0 || j >= s.cells.length || s.cells[j][0] === "w" ||
            (e === 0 && (i % size) === size - 1) ||
            (e === 1 && (i % size) === 0))
          continue;
        const pts = { 0: [sx, sy + TH / 2, sx + TW / 2, sy],   // +x: SE edge
                      1: [sx - TW / 2, sy, sx, sy - TH / 2],   // -x: NW edge
                      2: [sx - TW / 2, sy, sx, sy + TH / 2],   // +y: SW edge
                      3: [sx, sy - TH / 2, sx + TW / 2, sy] }; // -y: NE edge
        const pt = pts[e];
        // the foam breathes with its own tide: brighter and dimmer,
        // and a second, quieter line laps just inside the rim
        const ph = Math.sin(tsec * 1.8 + i * 0.9);
        ctx.strokeStyle = "rgba(205,228,238," +
            (0.28 + ph * 0.10).toFixed(3) + ")";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(pt[0], pt[1]); ctx.lineTo(pt[2], pt[3]);
        ctx.stroke();
        ctx.strokeStyle = "rgba(205,228,238," +
            Math.max(0, 0.10 - ph * 0.07).toFixed(3) + ")";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo((pt[0] + sx * 0.09) / 1.09, (pt[1] + sy * 0.09) / 1.09);
        ctx.lineTo((pt[2] + sx * 0.09) / 1.09, (pt[3] + sy * 0.09) / 1.09);
        ctx.stroke();
      }
      continue;
    }

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

    /* the walls: where the ground beside this tile stands lower — or
       the island's edge falls away — the earth shows its side, sunlit
       to the SE, shaded to the SW */
    const dX = (eMe - (x < size - 1 ?
                       Math.max(0, s.cells[i + 1][5] || 0) : 0)) * px;
    if (dX > 1) {
      ctx.fillStyle = "#4a392a";
      ctx.beginPath();
      ctx.moveTo(sx + TW / 2, sy);
      ctx.lineTo(sx, sy + TH / 2);
      ctx.lineTo(sx, sy + TH / 2 + dX);
      ctx.lineTo(sx + TW / 2, sy + dX);
      ctx.closePath(); ctx.fill();
    }
    const dY = (eMe - (y < size - 1 ?
                       Math.max(0, s.cells[i + size][5] || 0) : 0)) * px;
    if (dY > 1) {
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
}

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

/* the sky's weather drifts across the ground itself, faint — the world
   sits under the same clouds its shadow sits under */
function drawCloudShadows(s, tsec) {
  for (let i = 0; i < 3; i++) {
    const cx = ((tsec * 9 + i * 520) % (CW + 460)) - 230;
    const cy = CH * (0.22 + i * 0.24);
    ctx.fillStyle = "rgba(10,16,13,0.05)";
    ctx.beginPath();
    ctx.ellipse(cx, cy, 120 + i * 36, 26, 0, 0, 6.3);
    ctx.fill();
  }
}

/* the mirrored world: a shore plant leans into the water below it,
   upside down and quiet, clipped inside the tile it leans on */
function drawReflections(s, tsec) {
  const p = pal(), size = s.size;
  const at = {};
  for (const t of s.plants) at[t.x + "," + t.y] = t;
  for (let i = 0; i < s.cells.length; i++) {
    if (s.cells[i][0] !== "w") continue;
    const x = i % size, y = Math.floor(i / size);
    const [sx, sy] = iso(x, y);
    for (const [nx, ny] of [[x - 1, y], [x, y - 1]]) {
      const t = at[nx + "," + ny];
      if (!t || t.st === "log") continue;
      const shape = SHAPES[t.sp] || "deciduous";
      ctx.save();
      diamondPath(ctx, sx, sy); ctx.clip();
      ctx.translate(sx + (nx - x) * TW / 4, sy - TH * 0.1);
      ctx.scale(1, -0.5);                 // lean, squash, quiet
      ctx.globalAlpha = 0.09 + 0.03 * Math.sin(tsec * 1.3 + i * 0.7);
      ctx.fillStyle = p.leaf || "#6f9f4a";
      if (shape === "pine") {
        ctx.beginPath();
        ctx.moveTo(0, -15); ctx.lineTo(7, 0); ctx.lineTo(-7, 0);
        ctx.closePath(); ctx.fill();
      } else {
        ctx.beginPath(); ctx.ellipse(0, -7, 7.5, 5, 0, 0, 6.3); ctx.fill();
        ctx.fillRect(-1, -1, 2, 5);
      }
      ctx.restore();
    }
  }
}

/* moonlight finds the water: a shimmer column over the pond's heart */
function drawGlint(s, tsec) {
  let xi = 0, yi = 0, n = 0;
  for (let i = 0; i < s.cells.length; i++)
    if (s.cells[i][0] === "w") {
      xi += i % s.size; yi += Math.floor(i / s.size); n++;
    }
  if (!n) return;
  const [gx, gy] = iso(xi / n, yi / n);
  for (let k = 0; k < 4; k++) {
    const ph = Math.sin(tsec * 1.1 + k * 1.9);
    const lx = gx + (k - 1.5) * 9 + ph * 2.5,
          ly = gy + (k - 1.5) * 5;
    ctx.strokeStyle = "rgba(210,228,246," + (0.12 + 0.06 * ph).toFixed(3) + ")";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(lx - 5 - ph, ly); ctx.lineTo(lx + 5 + ph, ly);
    ctx.stroke();
  }
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

function drawAnimal(a, f, tsec, idx) {
  // glide between week-start and week-end cells — in iso space
  const e = f < 1 ? (f * f * (3 - 2 * f)) : 1;   // smoothstep
  const cx0 = ((a.px - a.py) * TW / 2), cy0 = ((a.px + a.py) * TH / 2);
  const cx1 = ((a.x - a.y) * TW / 2), cy1 = ((a.x + a.y) * TH / 2);
  const gx = cx0 + (cx1 - cx0) * e, gy = cy0 + (cy1 - cy0) * e;
  const body = ANIMAL_BODY[a.sp] || "#999";
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
  const flyer = a.sp === "owl" || a.sp === "robin";
  // children are children: little for their first six weeks
  const sz = a.ag !== undefined && a.ag < 6 ? 0.62 : 1;
  const lift =
      flyer ? -9 + (f < 1 ? Math.sin(tsec * 14 + a.id) * 1.1 : 0)
      : (a.sp === "rabbit" && f < 1
         ? -Math.abs(Math.sin(f * 12 + a.id)) * 5   // rabbits hop with the glide
         : Math.sin(tsec * 5 + a.x) * 0.8) * sz;
  /* landing: the hop's own phase tells when a rabbit touches ground —
     mid-air they stretch, on the landing they squash */
  const hopP = a.sp === "rabbit" && f < 1 ?
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
  const cy = OY + gy + lift * K + jy - eL;
  if (flyer) shadow(OX + gx + jx, OY + gy + 2, 3 * sz);   // small, distant
  else shadow(OX + gx + jx, OY + gy, 6 * sz);
  ctx.save();
  ctx.translate(OX + gx + jx, cy);
  ctx.scale(flip * K * sz * js * sqx, K * sz * js * sqy);
  const winter = ST.s && ST.s.season === "winter";
  switch (A_SHAPES[a.sp] || a.sp) {
    case "rabbit":
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.ellipse(0, 2, 5, 4, 0, 0, 6.3); ctx.fill();
      // ears: the far one flicks on its own quiet alarm
      const flick = Math.pow(Math.max(0,
          Math.sin(tsec * 0.9 + a.id * 2) - 0.94) / 0.06, 2);
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
      const trot = stride * Math.sin(f * 14 + a.id * 2) * 1.2;
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
      const tailSway = Math.sin(tsec * (f < 1 ? 5.5 : 3) + a.id) *
          (f < 1 ? 2.4 : 1.6);
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
      const flap = f < 1 ? Math.sin(f * 20 + a.id) : 0.3;
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
      const rf = f < 1 ? Math.sin(f * 24 + a.id) : 0.4;
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
      const bt = stride * Math.sin(f * 14 + a.id) * 1.2;
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
  ctx.restore();
  if (a.n && a.n !== "-") {
    ctx.font = "italic 9px Georgia, serif";
    ctx.fillStyle = "rgba(10,14,12,0.65)";
    ctx.fillText(a.n, OX + gx + 1, cy - 10 * K);
    ctx.fillStyle = "#dfe9db";
    ctx.fillText(a.n, OX + gx, cy - 11 * K);
  }
}

/* particles fall over the whole scene */
const dots = [];
function spawnParticles(s, dt) {
  const storm = s.weather === "storm", rain = s.weather === "rain",
        frost = s.weather === "frost";
  const count = kind => dots.reduce((n, d) => n + (d.kind === kind), 0);
  if ((rain || storm) && count("rain") < (storm ? 120 : 36) &&
      Math.random() < 0.5)
    dots.push({ kind: "rain", x: Math.random() * CW, y: -6,
                v: 190 + Math.random() * 90, dx: storm ? 42 : 12 });
  if (frost && count("snow") < 70)
    for (let k = 0; k < 2; k++)
      dots.push({ kind: "snow", x: Math.random() * CW, y: -4,
                  v: 18 + Math.random() * 14, dx: Math.random() * 10 - 5 });
  if (s.season === "autumn" && count("leaf") < 10 && Math.random() < 0.015)
    dots.push({ kind: "leaf", x: Math.random() * CW, y: -4,
                v: 22 + Math.random() * 16, dx: Math.random() * 24 - 12 });
  /* the air holds its own quiet life: pollen in spring, fireflies on
     summer weeks — they drift rather than fall */
  if (s.season === "spring" && count("pollen") < 18 && Math.random() < 0.06)
    dots.push({ kind: "pollen", x: Math.random() * CW,
                y: CH * (0.15 + Math.random() * 0.6),
                v: 7 + Math.random() * 8,
                dx: Math.random() * 8 - 4, ph: Math.random() * 6.3 });
  if (s.season === "summer" && count("fly") < 16 && Math.random() < 0.05)
    dots.push({ kind: "fly", x: Math.random() * CW,
                y: CH * (0.25 + Math.random() * 0.55),
                v: 0, dx: 0, ph: Math.random() * 6.3 });
}

function drawParticles(dt) {
  for (let i = dots.length - 1; i >= 0; i--) {
    const d = dots[i];
    if (d.kind === "fly") {
      d.x += Math.sin(dt * 40 + d.ph) * 0.02 * 60 * dt + 6 * dt;
      d.y += Math.cos(dt * 37 + d.ph) * 0.018 * 60 * dt;
      if (d.x > CW + 6) { dots.splice(i, 1); continue; }
      const glow = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(d.ph * 7 + i));
      ctx.fillStyle = "rgba(232,212,137," + (glow * 0.9).toFixed(3) + ")";
      ctx.beginPath(); ctx.arc(d.x, d.y, 1.6, 0, 6.3); ctx.fill();
      continue;
    }
    d.y += d.v * dt; d.x += d.dx * dt;
    if (d.kind === "pollen") d.x += Math.sin(d.y * 0.05 + d.ph) * 4 * dt;
    if (d.kind === "leaf") d.x += Math.sin((d.y + i * 10) * 0.05) * 12 * dt;
    if (d.y > CH - 4) { dots.splice(i, 1); continue; }
    ctx.save();
    ctx.globalAlpha = d.kind === "rain" ? 0.55 : 0.8;
    if (d.kind === "rain") {
      ctx.strokeStyle = "#9fc6dd"; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - d.dx * 0.05, d.y - d.v * 0.05);
      ctx.stroke();
    } else {
      ctx.fillStyle = d.kind === "leaf" ? "#a5763c"
          : d.kind === "pollen" ? "#e6e0c8" : "#eef4f6";
      ctx.beginPath(); ctx.arc(d.x, d.y, d.kind === "leaf" ? 2.2 : 1.3,
                               0, 6.3);
      ctx.fill();
    }
    ctx.restore();
  }
  if (dots.length > 260) dots.splice(0, dots.length - 260);
}

const REGIONS = { all: [0,0,1,1], NW: [0,0,.5,.5], NE: [.5,0,1,.5],
                  SW: [0,.5,.5,1], SE: [.5,.5,1,1] };
function drawEffects(s, tsec) {
  // the soul's touches are felt, not outlined: soft feathered air,
  // breathing when the pressure breathes
  for (const e of s.effects || []) {
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
    const g = ctx.createRadialGradient(mx, my, span * 0.15, mx, my, span);
    g.addColorStop(0, "rgba(" + col + "," + core.toFixed(3) + ")");
    g.addColorStop(0.65, "rgba(" + col + "," + (core * 0.45).toFixed(3) + ")");
    g.addColorStop(1, "rgba(" + col + ",0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(...iso(x0, y0));
    ctx.lineTo(...iso(xe, y0));
    ctx.lineTo(...iso(xe, ye));
    ctx.lineTo(...iso(x0, ye));
    ctx.closePath();
    ctx.fill();
    if (kind === "bloom") {           // the blessing sparkles
      for (let k = 0; k < 4; k++) {
        const fx = x0 + ((k * 7 + 3) % Math.max(1, xe - x0)) + 0.5;
        const fy = y0 + ((k * 11 + 5) % Math.max(1, ye - y0)) + 0.5;
        const [fxs, fys] = iso(fx, fy);
        const tw = Math.max(0, Math.sin(tsec * 2.2 + k * 2.6));
        ctx.fillStyle = "rgba(225,255,220," + (tw * 0.5).toFixed(3) + ")";
        ctx.fillRect(fxs - 1, fys - 7 - tw * 2, 2, 4 + tw * 3);
      }
    }
  }
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

function drawSoulRings(tnow) {
  for (let i = soulRings.length - 1; i >= 0; i--) {
    const r = soulRings[i];
    const age = (tnow - r.t0) / 2400;
    if (age >= 1) { soulRings.splice(i, 1); continue; }
    const rad = 14 + age * 210;
    ctx.strokeStyle = "rgba(226,238,230," + ((1 - age) * 0.35).toFixed(3) + ")";
    ctx.lineWidth = 2.2 * (1 - age) + 0.4;
    ctx.beginPath();
    ctx.ellipse(r.mx, r.my, rad, rad * 0.5, 0, 0, 6.3);
    ctx.stroke();
  }
}

let flash = 0;
function drawScene(tnow) {
  const s = ST.s;
  if (!s || !s.cells) return;
  fitCanvas(s.size);
  const tsec = tnow / 1000;
  const dt = Math.min(0.1, (tnow - (drawScene.last || tnow)) / 1000);
  drawScene.last = tnow;
  // fraction of the glide between weekly positions, from the true phase
  const glide = glidePhase();

  drawBackdrop(tsec);
  drawSlab(s);
  drawTerrain(s, tsec);
  drawCloudShadows(s, tsec);
  drawReflections(s, tsec);
  drawGlint(s, tsec);

  /* depth sorting: entities paint far-to-near (by x+y); within one
     diamond the ground cover comes first, creatures in front */
  const ents = [];
  for (const t of s.plants)
    ents.push({ d: t.x + t.y, k: t.st === "log" ? 0 : 1, t });
  s.animals.forEach((a, i) => ents.push({ d: a.x + a.y, k: 2, a, i }));
  ents.sort((p, q) => p.d - q.d || p.k - q.k);
  for (const en of ents) {
    if (en.k === 1) drawPlant(en.t, tsec);
    else if (en.k === 2) drawAnimal(en.a, glide, tsec, en.i);
  }
  trackFollow(glide);
  checkSoulArrival(s, tnow);
  spawnParticles(s, dt);
  drawParticles(dt);
  drawEffects(s, tsec);
  drawSoulRings(tnow);

  if (pal().wash) {
    ctx.fillStyle = pal().wash;
    ctx.fillRect(0, 0, CW, CH);
  }
  if (s.weather === "storm") {
    ctx.fillStyle = "rgba(20,28,40,0.25)";
    ctx.fillRect(0, 0, CW, CH);
    if (Math.random() < 0.006) flash = 0.30;
  }
  drawMist();
  drawVignette();
  if (flash > 0) {
    ctx.fillStyle = `rgba(240,245,255,${flash})`;
    ctx.fillRect(0, 0, CW, CH);
    flash -= dt * 1.8;
  }
}

function loop(tnow) {
  if (!document.body.classList.contains("plain"))
    drawScene(tnow);
  requestAnimationFrame(loop);
}

/* pick a cell from a click, honoring the land's relief: the flat map
   is a first guess, and the raised diamonds around it correct it */
function pickCell(s, u0, v0) {
  const gx = Math.round((u0 - OX) / (TW / 2) / 2
                        + (v0 - OY) / (TH / 2) / 2);
  const gy = Math.round((v0 - OY) / (TH / 2) / 2
                        - (u0 - OX) / (TW / 2) / 2);
  let best = null, bestD = 1e9;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = gx + dx, y = gy + dy;
      if (x < 0 || y < 0 || x >= s.size || y >= s.size) continue;
      const [cx, cy0] = iso(x, y);
      const cy = cy0 - elevAt(x, y);
      const du = Math.abs(u0 - cx) / (TW / 2) +
                 Math.abs(v0 - cy) / (TH / 2);
      if (du <= 1.001) {
        const d = (u0 - cx) * (u0 - cx) + (v0 - cy) * (v0 - cy);
        if (d < bestD) { best = [x, y]; bestD = d; }
      }
    }
  return best;                    // null → the click fell on the sky
}

/* look at a tile (click) — inverse isometric mapping; a named (or lone)
   occupant opens its biography */
cnv.addEventListener("click", e => {
  const s = ST.s;
  if (!s || !s.cells) return;
  const r = cnv.getBoundingClientRect();
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

