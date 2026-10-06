/* ================= the engine: pixi composes ====================== */
/* The recipes still draw — but at capture time, onto 2d surfaces that
   become textures. Pixi composes and moves: sprites with texture
   swaps, transforms and alphas, and one render call. Nothing that
   lives on the GPU has its geometry rebuilt inside a frame; the earth
   is remembered, the creatures caught once per pose. */

const ENG = {
  active: false,               // the app woke; the frame may render
  failed: false,               // init refused — the page says so plainly
  app: null, canvas: null, stage: null,
  skyKey: "", starSpr: [], cloudSpr: [], overlay: {},
  baked: null, bakeKey: "", bakeTex: null, bakeCanvas: null,
};

function markEngine(name) {
  const el = $("engine");
  if (el) el.textContent = name ? "[" + name + "]" : "";
}

if (ENGINE === "pixi") engBoot();
else {
  if (ENGINE === "none") document.body.classList.add("plain");
  markEngine(ENGINE === "off" ? "" : ENGINE);
}

async function engBoot() {
  try {
    const app = new PIXI.Application();
    await app.init({
      resolution: DPR, autoDensity: true, backgroundAlpha: 0,
      antialias: true, autoStart: false, sharedTicker: false,
    });
    ENG.app = app;
    ENG.canvas = app.canvas;
    ENG.stage = app.stage;
    ENG.canvas.id = "scene-g";
    const sc = document.querySelector(".map-scroll");
    if (sc && sc.insertBefore) sc.insertBefore(ENG.canvas, cnv);
    cnv.classList.add("retired");
    ENG.skyLayer = new PIXI.Container();
    ENG.earthLayer = new PIXI.Container();
    ENG.liveLayer = new PIXI.Container();
    ENG.liveA = new PIXI.Container();     // water light, shadows, mirror,
                                          // glint — the per-tick statics
    ENG.animalLayer = new PIXI.Container();  // the creatures (C6 fills it)
    ENG.poolLayer = new PIXI.Container(); // the air's particles, pooled
    ENG.liveB = new PIXI.Container();     // auras and the rings
    ENG.overLayer = new PIXI.Container();
    app.stage.addChild(ENG.skyLayer, ENG.earthLayer, ENG.liveLayer,
                       ENG.overLayer);
    ENG.liveLayer.addChild(ENG.liveA, ENG.animalLayer, ENG.poolLayer,
                           ENG.liveB);
    engInitSky();
    engInitOverlays();
    engInitPool();
    bindSceneClick(ENG.canvas);          // once, never doubled
    ENG.active = true;
    markEngine("pixi");
    if (ST.s && ST.s.size) fitCanvas(ST.s.size);
  } catch (e) {
    ENG.failed = true;
    // no GPU surface came: the words take over — the map the page
    // already knows how to show is the honest fall
    document.body.classList.add("plain");
    markEngine("pixi ✗ " + (e && e.message
        ? String(e.message).slice(0, 40) : "no surface"));
  }
}

/* a capture: the recipes' own 2d surface, drawn once, kept as pixels;
   caught into a texture by whoever asked. The page's ctx steps aside. */
function engCapture(w, h, draw) {
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(w));
  cv.height = Math.max(1, Math.round(h));
  const oc = cv.getContext("2d");
  const old = ctx;
  ctx = oc;
  draw(oc);
  ctx = old;
  cv.__tex = null;                     // a new canvas is a new texture
  return cv;
}

function engTex(cv) {
  if (!cv.__tex) cv.__tex = PIXI.Texture.from(cv);
  return cv.__tex;
}

function bakeKey(s) {
  return [s.tick, s.season, s.weather, elevPx(), Math.round(VIEW.dw),
          Math.round(VIEW.dh)].join("|");
}

/* -------- the earth, one texture: the recipes paint it once per
   week's key onto a kept canvas; the texture updates in place and the
   GPU composites it forever after — nothing per frame re-draws it ---- */
function engBaked(s, key) {
  if (ENG.bakeKey === key && ENG.bakeTex) return;
  const cap = (ENG.app && ENG.app.renderer &&
               ENG.app.renderer.maxTextureSize) || 4096;
  let s0 = VIEW.dw * DPR / CW;         // device pixels per logical unit
  s0 = Math.min(s0, cap / CW, cap / CH);   // a phone's ceiling, honored
  const dwB = Math.max(1, Math.floor(CW * s0)),
        dhB = Math.max(1, Math.floor(CH * s0));
  const sameBox = ENG.bakeCv && ENG.bakeCv.width === dwB &&
                  ENG.bakeCv.height === dhB;
  if (sameBox) {                       // the box held: update in place
    paintEarth(ENG.bakeCv.getContext("2d"), s, s0);
    ENG.bakeTex.source.update();
  } else {
    const cv = engCapture(dwB, dhB, oc => paintEarth(oc, s, s0));
    if (ENG.bakeTex && ENG.bakeTex.destroy)
      ENG.bakeTex.destroy(true);
    ENG.bakeTex = engTex(cv);
    ENG.bakeCv = cv;
    if (ENG.earthSpr) ENG.earthSpr.texture = ENG.bakeTex;
    else {
      ENG.earthSpr = new PIXI.Sprite(ENG.bakeTex);
      ENG.earthLayer.addChild(ENG.earthSpr);
    }
  }
  engCoverage(ENG.earthSpr, CW, CH);   // logical: covered to the pixel
  ENG.bakeKey = key;
}

/* the bake key's own function; the statics key on the same value */

/* -------- the sky: one gradient captured per palette, stars and
   clouds as sprites the frame only nudges -------------------------- */
function engInitSky() {
  const starCv = engCapture(2, 2, oc => {
    oc.fillStyle = "#e2ecec"; oc.fillRect(0, 0, 2, 2);
  });
  const cloudCv = engCapture(240, 48, oc => {
    const g = oc.createRadialGradient(120, 24, 2, 120, 24, 120);
    g.addColorStop(0, "rgba(10,16,13,0.5)");
    g.addColorStop(1, "rgba(10,16,13,0)");
    oc.fillStyle = g;
    oc.beginPath(); oc.ellipse(120, 24, 120, 24, 0, 0, 6.3); oc.fill();
  });
  ENG.cloudCv = cloudCv;
  ENG.skyCv = engCapture(8, 256, oc => {
    const p = pal();
    const g = oc.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, String(p.nightT));
    g.addColorStop(1, String(p.nightB));
    oc.fillStyle = g; oc.fillRect(0, 0, 8, 256);
  });
  const sky = new PIXI.Sprite(engTex(ENG.skyCv));
  ENG.skyLayer.addChild(sky);
  ENG.skySpr = sky;
  for (const st of STARS) {
    const sp = new PIXI.Sprite(engTex(starCv));
    sp.anchor && sp.anchor.set && sp.anchor.set(0.5);
    sp.__u = st.u; sp.__v = st.v; sp.__s = st.s; sp.__tw = st.tw;
    sp.__br = st.br;
    ENG.skyLayer.addChild(sp);
    ENG.starSpr.push(sp);
  }
  const starTex = engTex(starCv);
  for (let i = 0; i < 3; i++) {
    const sp = new PIXI.Sprite(starTex);
    sp.anchor && sp.anchor.set && sp.anchor.set(0.5);
    sp.__i = i;
    ENG.skyLayer.addChild(sp);
    ENG.cloudSpr.push(sp);
  }
}

/* -------- the last word the frame says: mist, vignette, the winter's
   wash, the storm's dim and its flash ------------------------------ */
function engInitOverlays() {
  const mistCv = engCapture(8, 256, oc => {
    const g = oc.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, "rgba(178,206,205,1)");
    g.addColorStop(1, "rgba(178,206,205,0)");
    oc.fillStyle = g; oc.fillRect(0, 0, 8, 256);
  });
  const vigCv = engCapture(256, 256, oc => {
    const g = oc.createRadialGradient(128, 128, 92, 128, 128, 190);
    g.addColorStop(0, "rgba(2,6,5,0)");
    g.addColorStop(1, "rgba(2,6,5,0.32)");
    oc.fillStyle = g; oc.fillRect(0, 0, 256, 256);
  });
  const rectCv = engCapture(2, 2, oc => {
    oc.fillStyle = "#fff"; oc.fillRect(0, 0, 2, 2);
  });
  ENG.overlay.rectTex = engTex(rectCv);
  ENG.overlay.mistTex = engTex(mistCv);
  ENG.overlay.vigTex = engTex(vigCv);
  ENG.overlay.mist = new PIXI.Sprite(ENG.overlay.mistTex);
  ENG.overlay.vig = new PIXI.Sprite(ENG.overlay.vigTex);
  ENG.overlay.wash = new PIXI.Sprite(ENG.overlay.rectTex);
  ENG.overlay.storm = new PIXI.Sprite(ENG.overlay.rectTex);
  ENG.overlay.flash = new PIXI.Sprite(ENG.overlay.rectTex);
  ENG.overLayer.addChild(ENG.overlay.mist, ENG.overlay.vig,
                         ENG.overlay.wash, ENG.overlay.storm,
                         ENG.overlay.flash);
}

/* a textured rect that covers the scene's box exactly */
function engCoverage(spr, w, h) {
  spr.width = w; spr.height = h;
  spr.position.set(0, 0);
}

/* -------- the creatures: caught once per pose, moved by properties ---
   The recipe drew them; the capture grid quantizes the gait (~10
   quanta a stride — sub-pixel at the world's scale); a frame never
   rebuilds a creature's geometry. */

/* a value → its bucket in [−amp, amp]; a bucket → its center */
function engQuant(v, amp, n) {
  if (!amp || v === undefined) return 0;
  return Math.max(0, Math.min(n, Math.round((v / amp + 1) * n / 2)));
}
function engDequant(qn, amp, n) {
  if (!qn) return 0;
  return (qn / n * 2 - 1) * amp;
}

/* a family's own motion channel, and nothing else — the pose space
   stays bounded: a deer is its trot, a fox its tail, a bird its wing */
const POSE_CHAN = {
  rabbit: ["flick", "flick", 1.2, 4],
  fox: ["tail", "tail", 2.4, 8],
  owl: ["flap", "flap", 1, 10],
  robin: ["rf", "rf", 1, 10],
  deer: ["dTrot", "trot", 1.2, 10],
  stag: ["dTrot", "trot", 1.2, 10],
  boar: ["bTrot", "trot", 1.2, 10],
};
function poseKeyFor(a, ph) {
  const shape = A_SHAPES[a.sp] || a.sp;
  const ch = POSE_CHAN[shape];
  const q = ch ? ch[1] + ":" + engQuant(ph[ch[0]], ch[2], ch[3]) + ":"
                + ch[2] + ":" + ch[3] : "still";
  return [shape, a.sp, ph.winter ? "w" : "s", a.h ? "h" : "-", q]
      .join("|");
}

/* the box the bodies live in, in local units; x −12..+12, y −13..+9 */
const POSE_BOX = { w: 24, h: 22, ox: 12, oy: 13, ss: 8 };

function engCapturePose(key) {
  const [shape, sp, wi, hun, chan] = key.split("|");
  const ph = { stride: 1, winter: wi === "w", dTrot: 0, bTrot: 0,
               flap: 0, rf: 0, tail: 0, flick: 0 };
  if (chan && chan !== "still") {
    const [nm, q, amp, n] = chan.split(":");
    ph[nm] = engDequant(+q, +amp, +n);
  }
  const a = { sp, h: hun === "h" ? 1 : 0 };
  const SS = POSE_BOX.ss;
  const cv = engCapture(POSE_BOX.w * SS, POSE_BOX.h * SS, oc => {
    oc.setTransform(SS, 0, 0, SS, POSE_BOX.ox * SS, POSE_BOX.oy * SS);
    animalBody(shape, a, ph);          // the recipe itself draws the pose
  });
  ENG.poseTex[key] = engTex(cv);
  return ENG.poseTex[key];
}

function engBuildCreatures(s) {
  if (!ENG_FX.shadowTex) {
    const cv = engCapture(16, 8, oc => {
      oc.fillStyle = "rgba(8,14,11,1)";
      oc.beginPath();
      oc.ellipse(8, 4, 7.5, 2.85, 0, 0, 6.3); oc.fill();
    });
    ENG_FX.shadowTex = engTex(cv);
  }
  // the pose epoch: winter's whiskers and the packs' colours change it
  const sig = [!!(s.season === "winter"), JSON.stringify(ANIMAL_BODY),
               DPR].join("|");
  if (ENG.poseSig !== sig) {
    ENG.poseSig = sig;
    for (const k in ENG.poseTex) if (ENG.poseTex[k].destroy)
      ENG.poseTex[k].destroy(true);
    ENG.poseTex = {};
  }
  ENG.animalLayer.removeChildren();
  ENG.creatures = [];
  for (const a of s.animals) {
    const root = new PIXI.Container();
    const inner = new PIXI.Container();       // the scale and the flip
    const shadow = new PIXI.Sprite(ENG_FX.shadowTex);
    shadow.anchor && shadow.anchor.set && shadow.anchor.set(0.5, 0.5);
    shadow.alpha = 0.20;
    const flyer = a.sp === "owl" || a.sp === "robin";
    const szc = a.ag !== undefined && a.ag < 6 ? 0.62 : 1;
    const rx = (flyer ? 3 : 6) * szc;
    shadow.width = rx * 2 / K * 1.08;         // local units (K rides below)
    shadow.height = rx * 0.76 / K * 1.08;
    const body = new PIXI.Sprite();
    body.anchor && body.anchor.set &&
        body.anchor.set(POSE_BOX.ox / POSE_BOX.w,
                        POSE_BOX.oy / POSE_BOX.h);
    body.width = POSE_BOX.w; body.height = POSE_BOX.h;
    inner.addChild(shadow, body);
    root.addChild(inner);
    let labels = null;
    if (a.n && a.n !== "-") {
      const style = { fontFamily: "Georgia, serif", fontSize: 9,
                      fontStyle: "italic" };
      const dark = new PIXI.Text(a.n, { ...style, fill: "#101412" });
      const light = new PIXI.Text(a.n, { ...style, fill: "#dfe9db" });
      root.addChild(dark, light);
      labels = { dark, light };
    }
    ENG.animalLayer.addChild(root);
    ENG.creatures.push({ a, root, inner, shadow, body, labels, flyer,
                         szc });
  }
}

/* the creatures, per frame: the shared gait, the shared phases, a
   pose texture, positions, the flip; the labels ride above */
function engAnimalsLive(tsec, glide) {
  const s = ST.s;
  for (let i = 0; i < ENG.creatures.length; i++) {
    const c = ENG.creatures[i];
    if (!c) break;
    const a = c.a;
    const g = animalGait(a, glide, tsec, i);
    const ph = gaitPhases(a, glide, tsec);
    const key = poseKeyFor(a, ph);
    c.body.texture = ENG.poseTex[key] || engCapturePose(key);
    c.root.position.set(OX + g.gx + g.jx,
                        OY + g.gy + g.lift * K + g.jy - g.eL);
    c.inner.scale.set(g.flip * K * c.szc * g.js * g.sqx,
                      K * c.szc * g.js * g.sqy);
    c.shadow.position.set(0, 2 + 2 * K - g.lift * K - g.jy + g.eL);
    if (c.labels) {
      c.labels.dark.position.set(1 - g.jx, -10 * K);
      c.labels.light.position.set(-g.jx, -11 * K);
    }
  }
  if (ENG.creatures.length !== s.animals.length)
    engBuildCreatures(s);          // a soul arrived mid-tick: rebuild
}

/* -------- the living air: the water's light, the sky's shadows on
   the ground, the mirror, the moon's glint, the particles, the soul's
   touches — captured once, moved by properties forever ------------ */

const ENG_FX = {};

/* a thin line texture of full alpha; the sprite carries its breath */
function engLineTex(len, rotDeg) {
  const cv = engCapture(Math.ceil(len) + 2, 4, oc => {
    oc.strokeStyle = "rgba(255,255,255,1)"; oc.lineWidth = 1.6;
    oc.beginPath();
    oc.moveTo(1, 2); oc.lineTo(len + 1, 2); oc.stroke();
  });
  return engTex(cv);
}

/* the water light: per cell its caustics' pair and its shore edges,
   captured once per neighbor-mask, alpha the only live thing */
function engBuildWater(s) {
  const size = s.size, elevF = elevField(s), p = pal();
  ENG.liveA.removeChildren();
  ENG.water = [];
  const dashACv = engCapture(13, 3, oc => {
    oc.strokeStyle = "rgba(200,225,240,0.20)"; oc.lineWidth = 1;
    oc.beginPath(); oc.moveTo(0, 1.5); oc.lineTo(12, 1.5); oc.stroke();
  });
  const dashBCv = engCapture(12, 3, oc => {
    oc.strokeStyle = "rgba(200,225,240,0.20)"; oc.lineWidth = 1;
    oc.beginPath(); oc.moveTo(0, 1.5); oc.lineTo(11, 1.5); oc.stroke();
  });
  const foamRim = engLineTex(23, 0);
  const foamIn = engLineTex(21, 0);
  const edgeAngle = Math.atan2(-TH / 2, TW / 2);
  for (let i = 0; i < s.cells.length; i++) {
    if (s.cells[i][0] !== "w") continue;
    const [sx, sy0] = iso(i % size, (i / size) | 0);
    const sy = sy0 - Math.max(0, elevF[i]) * elevPx();
    const ca = new PIXI.Sprite(engTex(dashACv));
    const cb = new PIXI.Sprite(engTex(dashBCv));
    ENG.liveA.addChild(ca, cb);
    const edges = [];
    const nbrs = [i + 1, i - 1, i + size, i - size];
    for (let e = 0; e < 4; e++) {
      const j = nbrs[e];
      if (j < 0 || j >= s.cells.length || s.cells[j][0] === "w" ||
          (e === 0 && (i % size) === size - 1) ||
          (e === 1 && (i % size) === 0))
        continue;
      const pt = { 0: [sx, sy + TH / 2, sx + TW / 2, sy],
                   1: [sx - TW / 2, sy, sx, sy - TH / 2],
                   2: [sx - TW / 2, sy, sx, sy + TH / 2],
                   3: [sx, sy - TH / 2, sx + TW / 2, sy] }[e];
      const midx = (pt[0] + pt[2]) / 2, midy = (pt[1] + pt[3]) / 2;
      const len = Math.hypot(pt[2] - pt[0], pt[3] - pt[1]);
      const rot = e < 2 ? edgeAngle : -edgeAngle;
      const rim = new PIXI.Sprite(foamRim);
      rim.width = len + 2; rim.rotation = rot;
      rim.position.set(midx - (len + 2) / 2 * Math.cos(rot),
                       midy - (len + 2) / 2 * Math.sin(rot));
      rim.anchor && rim.anchor.set && rim.anchor.set(0, 0.5);
      const inn = new PIXI.Sprite(foamIn);
      const lx = (pt[0] + sx * 0.09) / 1.09, ly = (pt[1] + sy * 0.09) / 1.09;
      const rx = (pt[2] + sx * 0.09) / 1.09, ry = (pt[3] + sy * 0.09) / 1.09;
      const imx = (lx + rx) / 2, imy = (ly + ry) / 2;
      const ilen = Math.hypot(rx - lx, ry - ly);
      inn.width = ilen + 2; inn.rotation = rot;
      inn.position.set(imx - (ilen + 2) / 2 * Math.cos(rot),
                       imy - (ilen + 2) / 2 * Math.sin(rot));
      inn.anchor && inn.anchor.set && inn.anchor.set(0, 0.5);
      ENG.liveA.addChild(rim, inn);
      edges.push({ rim, inn });
    }
    ENG.water.push({ i, ca, cb, edges, tx: sx, ty: sy });
  }
}

/* the mirror: two capture textures (upright or conifer), one sprite
   per shore plant — the clip happened at capture, never a mask */
function engBuildMirror(s) {
  if (!ENG_FX.mirrorCv) {
    const size = s.size;
    const clip = oc => {
      oc.beginPath();
      oc.moveTo(size / 2, 2); oc.lineTo(size - 2, size / 2);
      oc.lineTo(size / 2, size - 2); oc.lineTo(2, size / 2);
      oc.closePath(); oc.clip();
    };
    const pineCv = engCapture(size, size, oc => {
      clip(oc);
      oc.translate(size / 2 + TW / 4, size / 2 - TH * 0.1);
      oc.scale(1, -0.5);
      const col = "rgba(111,159,74,1)";
      oc.fillStyle = col;
      oc.beginPath(); oc.moveTo(0, -15); oc.lineTo(7, 0);
      oc.lineTo(-7, 0); oc.closePath(); oc.fill();
    });
    const decCv = engCapture(size, size, oc => {
      clip(oc);
      oc.translate(size / 2 + TW / 4, size / 2 - TH * 0.1);
      oc.scale(1, -0.5);
      const col = "rgba(111,159,74,1)";
      oc.fillStyle = col;
      oc.beginPath(); oc.ellipse(0, -7, 7.5, 5, 0, 0, 6.3); oc.fill();
      oc.fillRect(-1, -1, 2, 5);
    });
    ENG_FX.mirrorCv = { pine: pineCv, dec: decCv };
  }
  const size = s.size, at = {};
  for (const t of s.plants) at[t.x + "," + t.y] = t;
  ENG.mirror = [];
  for (let i = 0; i < s.cells.length; i++) {
    if (s.cells[i][0] !== "w") continue;
    const x = i % size, y = (i / size) | 0;
    for (const [nx, ny] of [[x - 1, y], [x, y - 1]]) {
      const t = at[nx + "," + ny];
      if (!t || t.st === "log") continue;
      const cv = (SHAPES[t.sp] || "deciduous") === "pine"
          ? ENG_FX.mirrorCv.pine : ENG_FX.mirrorCv.dec;
      const sp = new PIXI.Sprite(engTex(cv));
      const [sx, sy0] = iso(x, y);
      sp.position.set(sx - size / 2, sy0 - size / 2);
      ENG.liveA.addChild(sp);
      ENG.mirror.push({ i, sp });
    }
  }
}

/* the moon's dashes over the pond's heart */
function engBuildGlint(s) {
  let xi = 0, yi = 0, n = 0;
  for (let i = 0; i < s.cells.length; i++)
    if (s.cells[i][0] === "w") { xi += i % s.size; yi += (i / s.size) | 0; n++; }
  if (!n) { ENG.glint = []; return; }
  const [gx, gy] = iso(xi / n, yi / n);
  const line = engLineTex(11, 0);
  ENG.glint = [];
  for (let k = 0; k < 4; k++) {
    const sp = new PIXI.Sprite(line);
    sp.tint = 0xd2e4f6;
    sp.anchor && sp.anchor.set && sp.anchor.set(0.5, 0.5);
    ENG.liveA.addChild(sp);
    ENG.glint.push(sp);
  }
  ENG.glintGx = gx; ENG.glintGy = gy;
}

/* the soul's touches: one radial texture, tinted by kind, breathing */
function engBuildAuras(s) {
  if (!ENG_FX.auraTex) {
    const cv = engCapture(128, 128, oc => {
      const g = oc.createRadialGradient(64, 64, 8, 64, 64, 64);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.65, "rgba(255,255,255,0.45)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      oc.fillStyle = g; oc.fillRect(0, 0, 128, 128);
    });
    ENG_FX.auraTex = engTex(cv);
    ENG_FX.sparkTex = engTex(engCapture(2, 8, oc => {
      oc.fillStyle = "rgba(255,255,255,1)"; oc.fillRect(0, 0, 2, 8);
    }));
    ENG_FX.auraTint = { blight: 0x8c3c96, drought: 0xbe8c28, bloom: 0x8cd28c };
  }
  ENG.liveB.removeChildren();
  ENG.auras = [];
  for (const e of s.effects || []) {
    const ef = effectFields(e, s, 0);
    const kind = ef.kind;
    const spr = new PIXI.Sprite(ENG_FX.auraTex);
    spr.tint = ENG_FX.auraTint[kind];
    spr.width = ef.span * 2; spr.height = ef.span * 2;
    spr.position.set(ef.mx - ef.span, ef.my - ef.span);
    ENG.liveB.addChild(spr);
    ENG.auras.push({ spr, core0: ef.core });
    if (kind === "bloom") {
      ENG.auras[ENG.auras.length - 1].sparks = [];
      for (let k = 0; k < 4; k++) {
        const sp = new PIXI.Sprite(ENG_FX.sparkTex);
        sp.tint = 0xe1ffdc;
        ENG.liveB.addChild(sp);
        ENG.auras[ENG.auras.length - 1].sparks.push(sp);
      }
    }
    ENG.auras[ENG.auras.length - 1].ef = e;
  }
}

/* per tick, after the earth's bake: the water light, the mirror, the
   glint and the auras take their places; the frame only breathes them */
function engTickStatics(s) {
  const key = ENG.bakeKey;
  if (ENG.staticsKey === key) return;
  ENG.staticsKey = key;
  engBuildWater(s);
  engBuildMirror(s);
  engBuildGlint(s);
  engBuildAuras(s);
  engBuildGroundClouds(s);
  engBuildCreatures(s);
}

/* the sky's clouds cross the ground too: three soft shadows that drift */
function engBuildGroundClouds(s) {
  const cloud = engTex(ENG.cloudCv);
  ENG.groundClouds = [];
  for (let i = 0; i < 3; i++) {
    const sp = new PIXI.Sprite(cloud);
    ENG.liveA.addChild(sp);
    ENG.groundClouds.push(sp);
  }
}

/* the water light, per frame: the dashes' drift and the foam's tide */
function engWaterLive(s, tsec) {
  for (const w of ENG.water) {
    const L = waterLight(w.i, tsec);
    w.ca.position.set(w.tx - 7, w.ty + L.w1 - 1.5);
    w.cb.position.set(w.tx - 2, w.ty + 1 + L.w2 * 0.7 - 1.5);
    for (const e of w.edges) {
      e.rim.alpha = 0.28 + L.foam * 0.10;
      e.inn.alpha = Math.max(0, 0.10 - L.foam * 0.07);
    }
  }
}

/* the shadows on the ground, per frame */
function engGroundCloudLive(s, tsec) {
  for (let i = 0; i < ENG.groundClouds.length; i++) {
    const sp = ENG.groundClouds[i];
    sp.position.set(((tsec * 9 + i * 520) % (CW + 460)) - 230,
                    CH * (0.22 + i * 0.24));
    sp.width = 2 * (120 + i * 36);
    sp.height = 52;
    sp.alpha = 0.1;
  }
}

/* the mirror, per frame: the shared formula's breath */
function engMirrorLive(s, tsec) {
  for (const r2 of ENG.mirror)
    r2.sp.alpha = reflectionAlpha(r2.i, tsec);
}

/* the moonlight, per frame: the dashes' drift */
function engGlintLive(s, tsec) {
  for (let k = 0; k < ENG.glint.length; k++) {
    const d = glintDash(k, ENG.glintGx, ENG.glintGy, tsec);
    ENG.glint[k].position.set(d.lx, d.ly);
    ENG.glint[k].alpha = 0.12 + 0.06 * d.ph;
    ENG.glint[k].width = 11 + d.ph * 5;
  }
}

/* the auras, per frame: the shared formula's breathing, the sparks */
function engAurasLive(s, tsec) {
  for (const a2 of ENG.auras) {
    const ef = effectFields(a2.ef, s, tsec);
    a2.spr.alpha = Math.min(1, ef.core);
    if (a2.sparks)
      for (let k = 0; k < a2.sparks.length; k++) {
        const sp = bloomSpark(k, ef, tsec);
        const [fxs, fys] = iso(sp.fx, sp.fy);
        a2.sparks[k].position.set(fxs - 1, fys - 7 - sp.tw * 2);
        a2.sparks[k].height = 4 + sp.tw * 3;
        a2.sparks[k].alpha = sp.tw * 0.5;
      }
  }
}

/* the particles: pooled sprites over the shared dots array */
function engInitPool() {
  ENG.pool = [];
  const dot = engTex(engCapture(3, 3, oc => {
    oc.fillStyle = "rgba(255,255,255,1)";
    oc.beginPath(); oc.arc(1.5, 1.5, 1.4, 0, 6.3); oc.fill();
  }));
  const rain = engLineTex(12, 0);
  ENG.poolTex = { dot, rain };
}

const DOT_TINT = { snow: 0xeef4f6, pollen: 0xe6e0c8, leaf: 0xa5763c,
                   fly: 0xe8d489 };
function engParticles(dt) {
  updateParticles(dt);                // the shared advance, then the pool
  const pool = ENG.pool, n = dots.length;
  for (let i = 0; i < n; i++) {
    const d = dots[i];
    let sp = pool[i];
    if (!sp) {
      sp = new PIXI.Sprite(d.kind === "rain" ? ENG.poolTex.rain
                                               : ENG.poolTex.dot);
      sp.anchor && sp.anchor.set && sp.anchor.set(0.5, d.kind === "rain"
          ? 1 : 0.5);
      ENG.poolLayer.addChild(sp);
      pool.push(sp);
    }
    sp.visible = true;
    if (d.kind === "rain") {
      sp.rotation = Math.atan2(d.dx, d.v);       // slant with the rain
      sp.alpha = 0.55;
      sp.tint = 0x9fc6dd;
      sp.width = 2; sp.height = Math.hypot(d.dx * 0.05, d.v * 0.05);
      sp.position.set(d.x, d.y);
    } else if (d.kind === "fly") {
      const glow = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(d.ph * 7 + i));
      sp.alpha = glow * 0.9;
      sp.tint = DOT_TINT.fly;
      sp.width = 2.6; sp.height = 2.6;
      sp.position.set(d.x, d.y);
    } else {
      sp.alpha = 0.8;
      sp.tint = DOT_TINT[d.kind] || 0xffffff;
      sp.rotation = 0;
      sp.width = d.kind === "leaf" ? 2.6 : 2.2;
      sp.height = d.kind === "leaf" ? 2.6 : 2.2;
      sp.position.set(d.x, d.y);
    }
  }
  for (let i = pool.length - 1; i >= n; i--)
    pool[i].visible = false;
}

/* the rings: the one deliberate exception — a Graphics rebuilt per
   frame, six at most, because both radius and width breathe */
function engRings(tnow) {
  ageRings(tnow);
  if (!ENG.ringGfx) { ENG.ringGfx = []; ENG.ringBuilt = -1; }
  while (ENG.ringGfx.length < soulRings.length) {
    const g = new PIXI.Graphics();
    ENG.ringBuilt += 1;
    ENG.liveB.addChild(g);
    ENG.ringGfx.push(g);
  }
  for (let i = 0; i < ENG.ringGfx.length; i++) {
    const g = ENG.ringGfx[i], r = soulRings[i];
    if (!r) { g.visible = false; continue; }
    g.visible = true;
    const age = (tnow - r.t0) / 2400;
    g.clear && g.clear();
    g.ellipse(r.mx, r.my, 14 + age * 210, (14 + age * 210) * 0.5);
    g.stroke({ width: 2.2 * (1 - age) + 0.4, color: 0xe2eee6,
               alpha: (1 - age) * 0.35 });
  }
}

function drawScenePixi(tnow) {
  const s = ST.s;
  if (!s || !s.cells) return;
  fitCanvas(s.size);
  const tsec = tnow / 1000;
  const dt = Math.min(0.1, (tnow - (drawScenePixi.last || tnow)) / 1000);
  drawScenePixi.last = tnow;
  if (!ENG.active) return;             // the engine is still waking
  const glide = glideOf(tnow);         // the shared fraction

  const p = pal();
  // the sky
  const skyKey = String(s.tick) + "|" + String(p.nightT);
  if (ENG.skyKey !== skyKey) {
    ENG.skyKey = skyKey;
    ENG.skyCv = engCapture(8, 256, oc => {
      const g = oc.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, String(p.nightT));
      g.addColorStop(1, String(p.nightB));
      oc.fillStyle = g; oc.fillRect(0, 0, 8, 256);
    });
    ENG.skySpr.texture = engTex(ENG.skyCv);
  }
  engCoverage(ENG.skySpr, CW, CH);
  const box = CW + "|" + CH;
  if (ENG.starBox !== box && CW > 0) {  // the seats move with the view,
    ENG.starBox = box;                  // the twinkle alone is per frame
    for (const st of ENG.starSpr) {
      st.position.set(st.__u * CW, st.__v * CH);
      st.width = st.__s; st.height = st.__s;
    }
    for (const sp of ENG.cloudSpr)
      sp.height = 68;
  }
  for (const st of ENG.starSpr)
    st.alpha = st.__br * (0.6 + 0.4 * Math.sin(tsec * 1.7 + st.__tw));
  for (const sp of ENG.cloudSpr) {
    const i = sp.__i;
    sp.position.set(((tsec * 11 + i * 470) % (CW + 400)) - 200,
                    CH * (0.18 + i * 0.26));
    sp.width = 300 + i * 80;
    sp.alpha = 0.2;
  }

  // the earth: one texture per week's key, the engine's own bake
  engBaked(s, bakeKey(s));
  engTickStatics(s);
  checkSoulArrival(s, tnow);           // the rings spawn as they ever did
  engWaterLive(s, tsec);
  engGroundCloudLive(s, tsec);
  engMirrorLive(s, tsec);
  engGlintLive(s, tsec);
  spawnParticles(s, dt);
  engAnimalsLive(tsec, glide);
  engParticles(dt);
  engAurasLive(s, tsec);
  engRings(tnow);

  // the overlays: mist breathes with the season, the rest says so
  engCoverage(ENG.overlay.mist, CW, CH * 0.58);
  ENG.overlay.mist.alpha = (s.season === "winter") ? 0.30 :
      (s.weather === "clear") ? 0.16 : 0.23;
  engCoverage(ENG.overlay.vig, CW, CH);
  if (p.wash) {
    engCoverage(ENG.overlay.wash, CW, CH);
    ENG.overlay.wash.tint = 0xbed7e1;
    ENG.overlay.wash.alpha = 0.10;
  } else ENG.overlay.wash.alpha = 0;
  if (s.weather === "storm") {
    engCoverage(ENG.overlay.storm, CW, CH);
    ENG.overlay.storm.tint = 0x141c28;
    ENG.overlay.storm.alpha = 0.25;
    if (Math.random() < 0.006) flash = 0.30;
  } else ENG.overlay.storm.alpha = 0;
  if (flash > 0) {
    engCoverage(ENG.overlay.flash, CW, CH);
    ENG.overlay.flash.tint = 0xf0f5ff;
    ENG.overlay.flash.alpha = flash;
    flash -= dt * 1.8;
  } else ENG.overlay.flash.alpha = 0;

  // the earth and the living still arrive — the engine's next rooms
  ENG.app.render();
}