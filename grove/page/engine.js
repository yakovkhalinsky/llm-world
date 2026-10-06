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
else markEngine(ENGINE);

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
    ENG.overLayer = new PIXI.Container();
    app.stage.addChild(ENG.skyLayer, ENG.earthLayer, ENG.liveLayer,
                       ENG.overLayer);
    engInitSky();
    engInitOverlays();
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

function drawScenePixi(tnow) {
  const s = ST.s;
  if (!s || !s.cells) return;
  fitCanvas(s.size);
  const tsec = tnow / 1000;
  const dt = Math.min(0.1, (tnow - (drawScene.last || tnow)) / 1000);
  drawScene.last = tnow;
  if (!ENG.active) return;             // the engine is still waking

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