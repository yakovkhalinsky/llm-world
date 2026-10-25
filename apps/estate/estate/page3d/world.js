/* world — the estate in three dimensions.
 *
 * The estate is drawn in three dimensions because a block's height is the
 * fact the whole interior model rests on. A real camera makes it solid: the
 * light moves across the blocks, and a person walks from a door to a bench
 * on the ground rather than sliding across a picture.
 *
 * Nothing here is decided. The ground, the blocks, the flats, the people and
 * their positions all arrive from the server; this file only gives them a
 * body. Where a fact is missing it draws nothing rather than inventing one,
 * because a guess in a renderer is a second copy of a fact the engine owns.
 *
 * The five phases of the day are dawn, morning, afternoon, evening and
 * night — equal fifths of one continuous clock. `dayFraction` turns the wall
 * time since the day's turn into a fraction of the day; the light table is
 * keyed by that
 * fraction and eased between its keys, so the sun crosses the sky and the
 * lamps, windows and fog arrive and leave over a long dawn and dusk rather
 * than stepping when the server's `day` changes. The clock's wrap from 1
 * to 0 lands on the same night at both ends.
 */

import * as THREE from 'three';
import { OrbitControls } from '/3d/vendor/OrbitControls.js';

/* The router is a classic script (`/3d/walk.js`) loaded before this module;
 * see walk.js beside it. If it ever fails to load, the page still draws
 * everyone — as a straight line, which is what it used to do always. */
const Walk = (typeof globalThis !== 'undefined' && globalThis.EstateWalk) ||
             null;

/* Who stands where on a shared tile (`/3d/crowd.js`, a classic script
 * like the router): one figure per seat, the rest spread over the tile. */
const Crowd = (typeof globalThis !== 'undefined' && globalThis.EstateCrowd) ||
              null;

/* The day's clock and the light table are `clock.js`, loaded as a classic
 * script before this module: pure functions with no THREE, so the property
 * that matters — the light never jumps at the turn — is testable in Node
 * (`tools/clock_check.js`) rather than only by a replica that ships
 * nowhere. */
const Clock = (typeof globalThis !== 'undefined' && globalThis.EstateClock) ||
              null;

/* The light field's painter (`/3d/field.js`, shared with the grove), a
 * classic script before this module like the clock. */
const Field = (typeof globalThis !== 'undefined' && globalThis.Page3DField) ||
              null;

const FLOOR_H = 1.35;          // world units per storey
const TILE_TOP = 0.12;         // the walking surface: top of a ground tile
const WALK_Y = TILE_TOP + 0.005;
/* A door's step and the shop's stall are one step high (crowd.js), and a
 * figure over either stands on it, never in it. */
const STEP_H = Crowd ? Crowd.STEP_H : 0.06;

/* A season shifts the living ground and the trees; the road, the paving and
 * the buildings are the same in every season, because they are not alive. */
const SEASONS = [
  { lawn: 0x6f8f52, play: 0xb5945a, path: 0x938a7b, water: 0x3d6f88,
    canopy: [0x4e7a3a, 0x5c8a44, 0x3f6b33] },
  { lawn: 0x63863c, play: 0xbe9a58, path: 0x9a9080, water: 0x3a7392,
    canopy: [0x3f7a35, 0x4e8a3f, 0x366b2d] },
  { lawn: 0x8a7c3e, play: 0xb08a4c, path: 0x8d8474, water: 0x39677d,
    canopy: [0x9a7b2e, 0xa8862f, 0x80651f] },
  { lawn: 0x8b9189, play: 0xa89a80, path: 0x8c8c8c, water: 0x35586b,
    canopy: [0x8a8f82, 0x7c8277, 0x6e746a] },
];

/* The site names are the pack's (`codes` in /api/ground); this is only what
 * each one looks like. An unknown site gets a stable colour rather than a
 * second copy of the site list, so a pack that adds a site still draws. */
const SITE_COLOUR = {
  road: 0x3a4048, path: 0x938a7b, paved: 0x6d6a63, lawn: 0x6f8f52,
  play: 0xb5945a, water: 0x3d6f88, building: 0x2f3640,
  yard: 0x86817a,
};

const BUILDING_STYLE = {
  block: { wall: 0xb7b0a1, roof: 0x444b52, trim: 0x8f887b },
  shop: { wall: 0xcf9f60, roof: 0x7c4038, trim: 0xf0c98a },
  /* red brick and a slate roof: a school looks like nothing else here */
  school: { wall: 0xa8654a, roof: 0x3e4650, trim: 0xe3d6bf },
};

/* A person is coloured by what they are, never by which household they
 * belong to: two children in one family are two children. */
const ROLE_COLOUR = { child: 0xf2c14e, adult: 0x9ecbf0, elder: 0xd9b8e8 };
const SKIN = [0xf1d5b5, 0xe8c39a, 0xc68863, 0x8d5524];

/* A weather is a fact about the sky, so it tints the sky (and the fog that
 * matches it) rather than only the ground. Clear days keep the phase's own
 * blue; rain and storm pull it to grey, frost to a cold haze, heat to a
 * warm one. Night keeps its dark blue — the tint fades out with the light,
 * because a grey sky at midnight is not what rain looks like. */
const WEATHER_SKY = {
  rain:  { hex: 0x8c98a3, mix: 0.68, sun: 0.72 },
  storm: { hex: 0x6d7883, mix: 0.8, sun: 0.55 },
  frost: { hex: 0xd7e2ea, mix: 0.45, sun: 0.85 },
  heat:  { hex: 0xe8cfa0, mix: 0.32, sun: 1.02 },
};

/* the sun never gets low enough to throw a shadow across the sky */
const SUN_MIN_Y = 19;

const _c1 = new THREE.Color();
const _haze = new THREE.Color(0x8a9184);

function hash01(n, salt) {
  let x = (n * 374761393 + (salt || 0) * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177) | 0;
  x = x ^ (x >>> 16);
  return (x >>> 0) / 4294967295;
}

/* the clock's own helper; the fallback only keeps unrelated geometry code
 * running if clock.js failed to load, and `createWorld` refuses to start
 * without the light table anyway */
const clamp01 = (Clock && Clock.clamp01) ||
                (v => Math.max(0, Math.min(1, v)));

function stringHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

function doorFace(b) {
  const dx = b.door[0], dy = b.door[1];
  if (dy < b.y) return { axis: 'z', sign: -1, at: b.y };
  if (dy >= b.y + b.h) return { axis: 'z', sign: 1, at: b.y + b.h };
  if (dx < b.x) return { axis: 'x', sign: -1, at: b.x };
  return { axis: 'x', sign: 1, at: b.x + b.w };
}

export function createWorld(ground, canvas, opts) {
  opts = opts || {};
  if (!Clock) throw new Error('the day clock (clock.js) did not load');
  if (!Field) throw new Error('the light field (field.js) did not load');
  const forcedPhase = Number.isFinite(opts.forcedPhase) ? opts.forcedPhase
                                                          : -1;
  /* `?clock=0.15` pins the day's fraction for screenshots of mid-dawn or
   * mid-dusk; it is finer than a phase and wins if both are given. The
   * clock owns both pins and the day's own anchoring. */
  const clock = Clock.makeClock({ clockPin: opts.clockFrac,
                                  forcedPhase: forcedPhase });
  const staticMode = !!opts.staticMode;
  const W = ground.width, H = ground.height;
  const centre = new THREE.Vector3(W / 2, 1.4, H / 2);
  /* the plan's walkable ground, searched once and never rebuilt unless the
   * fixture list changes */
  const grid = Walk ? Walk.buildGrid(ground) : null;

  /* The outer band of the estate: walkable ground inside the ring road
   * within three cells of it. The plan is the source — the road's own
   * cells say where the ring is, so a wider plan or a different road
   * width moves the band with it. The `perimeter` count uses this, and
   * `?focus=perimeter` uses the bench marks the server sends; neither
   * invents a second copy of the geometry. */
  const perimeterCells = (() => {
    const roads = [];
    let x0 = W, x1 = -1, y0 = H, y1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (ground.codes[ground.rows[y][x]] === 'road') {
          roads.push([x, y]);
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    const cells = new Set();
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const code = ground.codes[ground.rows[y][x]];
        if (code === 'road' || code === 'building' || code === 'water') {
          continue;
        }
        let near = false;
        for (let i = 0; i < roads.length && !near; i++) {
          near = Math.abs(x - roads[i][0]) + Math.abs(y - roads[i][1]) <= 3;
        }
        if (near) cells.add(x + ',' + y);
      }
    }
    return cells;
  })();

  /* ------------------------------------------------------------ renderer */

  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  /* set every frame from the clock (lightAt's exposure) */
  renderer.toneMappingExposure = Clock.EXPOSURE_DAY;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const maxDim = Math.max(W, H);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(Clock.LIGHT[3].sky);
  /* Fog turns the ground past the estate into sky. It starts at 0.8
   * of the estate's size and is whole by 2.2, so the apron is gone into
   * the sky before it reaches the frame's corners (further out, it showed
   * through as a grey-green blotch, a hard world edge), while the blocks
   * themselves — well inside the near distance from the camera's usual
   * framing — stay crisp. Its colour is the sky's every frame, leaned a little toward
   * the ground by day (see updateSky). */
  scene.fog = new THREE.Fog(Clock.LIGHT[3].sky, maxDim * 0.8, maxDim * 2.2);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
  /* from the south-east, where both views look in, and high enough to
   * hold the north block row and the open courtyard in front of it, still
   * oblique enough that a block reads as a block and not as a plan */
  camera.position.set(centre.x + 20, centre.y + 38, centre.z + 24);

  const controls = new OrbitControls(camera, canvas);
  if (opts.topView) {
    /* a plan-like view for checking that everything is actually drawn:
     * from ground level a front block legitimately hides the courtyard */
    camera.position.set(centre.x, centre.y + 58, centre.z + 0.01);
  }
  controls.target.copy(centre);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 8;
  controls.maxDistance = 130;
  controls.minPolarAngle = 0.08;
  /* the camera may look down at the estate but never from below it */
  controls.maxPolarAngle = Math.PI / 2 - 0.04;
  /* OrbitControls implements arrow-key panning but only wires the listener
   * when it is asked; connect() installs the pointer and the wheel only. */
  controls.listenToKeyEvents(window);
  controls.update();

  /* -------------------------------------------------------------- lights */

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.7);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  /* Tight to the estate: half its diagonal, plus enough for the tallest
   * block's top to fall inside the frustum at a low-ish sun. Everything
   * past the estate is outside the shadow camera, so no shadow can be
   * stretched across the ground behind it. */
  const shadowSpan = Math.hypot(W, H) * 0.5 + 8;
  sun.shadow.camera.left = -shadowSpan;
  sun.shadow.camera.right = shadowSpan;
  sun.shadow.camera.top = shadowSpan;
  sun.shadow.camera.bottom = -shadowSpan;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 120;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);
  scene.add(sun.target);
  sun.target.position.copy(centre);

  /* shared geometry, so a bench and a roof are the same box */
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 8);
  const taperGeo = new THREE.CylinderGeometry(0.68, 1, 1, 7);
  const icoGeo = new THREE.IcosahedronGeometry(1, 0);
  const sphereGeo = new THREE.SphereGeometry(1, 10, 8);

  const dummy = new THREE.Object3D();
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  /* -------------------------------------------------------------- ground */

  const siteColourCache = {};
  function fallbackSiteColour(site) {
    if (siteColourCache[site] !== undefined) return siteColourCache[site];
    let h = 0;
    for (let i = 0; i < site.length; i++) h = (h * 31 + site.charCodeAt(i)) | 0;
    _c1.setHSL((h >>> 0) % 360 / 360, 0.26, 0.42);
    siteColourCache[site] = _c1.getHex();
    return siteColourCache[site];
  }

  /* The ground outside the estate. It is an apron that fades to nothing —
   * and therefore to the sky behind it — a little way past the last tile,
   * rather than a plane large enough to fill the frame. It takes no
   * shadows: a building's shadow belongs on the estate's paving, and a
   * shadow stretched across this apron was the dark rectangle the low sun
   * used to throw into the background. The alpha is computed once from the
   * estate rectangle, so the fade has a constant width on every side. */
  const baseW = W + 120, baseH = H + 120;
  const FADE_IN = 1.5, FADE_OUT = 21, FADE_TEX = 256;
  const fadeCanvas = document.createElement('canvas');
  fadeCanvas.width = fadeCanvas.height = FADE_TEX;
  const fadeCtx = fadeCanvas.getContext('2d');
  const fadeImg = fadeCtx.createImageData(FADE_TEX, FADE_TEX);
  for (let py = 0; py < FADE_TEX; py++) {
    for (let px = 0; px < FADE_TEX; px++) {
      const wx = ((px + 0.5) / FADE_TEX - 0.5) * baseW + W / 2;
      const wz = ((py + 0.5) / FADE_TEX - 0.5) * baseH + H / 2;
      const dx = Math.max(0, -wx, wx - W);
      const dz = Math.max(0, -wz, wz - H);
      const t = clamp01((Math.hypot(dx, dz) - FADE_IN) /
                        (FADE_OUT - FADE_IN));
      const a = 1 - t * t * (3 - 2 * t);
      const o = (py * FADE_TEX + px) * 4;
      fadeImg.data[o] = 255;
      fadeImg.data[o + 1] = Math.round(a * 255);
      fadeImg.data[o + 2] = 255;
      fadeImg.data[o + 3] = 255;
    }
  }
  fadeCtx.putImageData(fadeImg, 0, 0);
  const fadeTex = new THREE.CanvasTexture(fadeCanvas);

  const baseMat = new THREE.MeshStandardMaterial({
    color: 0x66735c, roughness: 1, transparent: true,
    alphaMap: fadeTex, depthWrite: false });
  const base = new THREE.Mesh(new THREE.PlaneGeometry(baseW, baseH), baseMat);
  base.rotation.x = -Math.PI / 2;
  base.position.set(W / 2, -0.03, H / 2);
  base.receiveShadow = false;
  scene.add(base);

  const tileGeo = new THREE.BoxGeometry(1, 0.14, 1);
  const tileMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.96, metalness: 0.0,
  });
  const tiles = new THREE.InstancedMesh(tileGeo, tileMat, W * H);
  tiles.receiveShadow = true;
  tiles.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  scene.add(tiles);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const site = ground.codes[ground.rows[y][x]];
      dummy.position.set(x + 0.5, site === 'water' ? -0.01 : 0.05, y + 0.5);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      tiles.setMatrixAt(i, dummy.matrix);
    }
  }

  function paintGround(st) {
    const season = Math.max(0, Math.min(3, (st && st.season) || 0));
    const pal = SEASONS[season];
    const shade = (st && st.shade) || null;
    /* the apron is the same living ground, muted and hazed so it reads as
     * distance rather than as a second, flatter estate */
    _c1.setHex(pal.lawn).lerp(_haze, 0.38).multiplyScalar(0.84);
    baseMat.color.copy(_c1);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const site = ground.codes[ground.rows[y][x]];
        let hex = SITE_COLOUR[site];
        if (hex === undefined) hex = fallbackSiteColour(site);
        if (site === 'lawn') hex = pal.lawn;
        else if (site === 'play') hex = pal.play;
        else if (site === 'path') hex = pal.path;
        else if (site === 'water') hex = pal.water;
        let f = 1;
        if (shade) f -= Math.min(0.45, (shade[i] || 0) * 0.05);
        if (site === 'building') f = 1.08;
        _c1.setHex(hex).multiplyScalar(f);
        tiles.setColorAt(i, _c1);
      }
    }
    if (tiles.instanceColor) tiles.instanceColor.needsUpdate = true;
  }

  paintGround(null);

  /* --------------------------------------------------------- buildings */

  const buildingById = {};
  const unitsByBuilding = {};
  (ground.buildings || []).forEach(b => { buildingById[b.id] = b; });
  for (const uid of Object.keys(ground.units || {})) {
    const u = ground.units[uid];
    (unitsByBuilding[u.b] = unitsByBuilding[u.b] || []).push(
      { uid: Number(uid), b: u.b, f: u.f, i: u.i, n: u.n });
  }

  const wallMats = {
    block: new THREE.MeshStandardMaterial({ color: BUILDING_STYLE.block.wall,
                                            roughness: 0.88 }),
    shop: new THREE.MeshStandardMaterial({ color: BUILDING_STYLE.shop.wall,
                                           roughness: 0.8 }),
  };
  const roofMats = {
    block: new THREE.MeshStandardMaterial({ color: BUILDING_STYLE.block.roof,
                                            roughness: 0.9 }),
    shop: new THREE.MeshStandardMaterial({ color: BUILDING_STYLE.shop.roof,
                                           roughness: 0.8 }),
  };
  /* A kind the pack has not shown us before still gets a stable face and
   * roof of its own, derived from its name. Two unknown kinds must not
   * silently become the same block. */
  const unknownStyle = {};
  function styleFor(kind) {
    if (BUILDING_STYLE[kind]) return BUILDING_STYLE[kind];
    if (!unknownStyle[kind]) {
      const h = (stringHash(kind) % 360) / 360;
      _c1.setHSL(h, 0.2, 0.55);
      const wall = _c1.getHex();
      _c1.setHSL((h + 0.47) % 1, 0.26, 0.31);
      unknownStyle[kind] = { wall, roof: _c1.getHex(), trim: wall };
    }
    return unknownStyle[kind];
  }
  function wallFor(kind) {
    if (!wallMats[kind]) {
      wallMats[kind] = new THREE.MeshStandardMaterial({
        color: styleFor(kind).wall, roughness: 0.86 });
    }
    return wallMats[kind];
  }
  function roofFor(kind) {
    if (!roofMats[kind]) {
      roofMats[kind] = new THREE.MeshStandardMaterial({
        color: styleFor(kind).roof, roughness: 0.9 });
    }
    return roofMats[kind];
  }
  const trimMat = new THREE.MeshStandardMaterial({
    color: BUILDING_STYLE.block.trim, roughness: 0.9 });
  const doorMat = new THREE.MeshStandardMaterial({
    color: 0x4b3523, roughness: 0.85 });
  const stepMat = new THREE.MeshStandardMaterial({
    color: 0x8d8a82, roughness: 0.95 });
  const detailMat = new THREE.MeshStandardMaterial({
    color: 0x7b7d80, roughness: 0.9 });
  const lampBulbMat = new THREE.MeshStandardMaterial({
    color: 0x4a4234, emissive: 0xffca7a, emissiveIntensity: 0.05,
    roughness: 0.5 });
  const schoolTrimMat = new THREE.MeshStandardMaterial({
    color: BUILDING_STYLE.school.trim, roughness: 0.9 });
  const schoolSignMat = new THREE.MeshStandardMaterial({
    color: 0x24486b, roughness: 0.7 });
  const fenceMat = new THREE.MeshStandardMaterial({
    color: 0x3d5a4a, roughness: 0.75 });
  const lineMat = new THREE.MeshStandardMaterial({
    color: 0xe9e4d8, roughness: 0.95 });
  const shopSignMat = new THREE.MeshStandardMaterial({
    color: 0x5a3a24, emissive: 0xffb45c, emissiveIntensity: 0.1,
    roughness: 0.7 });

  const buildingBodies = [];
  const windowSlots = [];

  function addBox(group, mat, sx, sy, sz, px, py, pz) {
    const m = new THREE.Mesh(unitBox, mat);
    m.scale.set(sx, sy, sz);
    m.position.set(px, py, pz);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  }

  function addWindow(px, py, pz, ry, unit, shop, sx, sy) {
    windowSlots.push({ px, py, pz, ry, unit, shop: !!shop,
                       sx: sx || 1, sy: sy || 1 });
  }

  /* The school: a two-storey brick building with a row of tall classroom
   * windows on every floor, its name board over the door, and its yard
   * fenced on the three sides the building does not close, with a gap at
   * the gate (the gate's pillars are the `school` fixture). Pupils inside
   * the fence are at school; the fence is what makes that visible. */
  function buildSchool(g, b, face, along) {
    /* the name board, white-edged navy, above the door canopy */
    if (face.axis === 'z') {
      addBox(g, schoolSignMat, 2.0, 0.32, 0.08, along,
             TILE_TOP + 1.3, face.at + face.sign * 0.06);
      addBox(g, schoolTrimMat, 2.12, 0.42, 0.04, along,
             TILE_TOP + 1.3, face.at + face.sign * 0.025);
    } else {
      addBox(g, schoolSignMat, 0.08, 0.32, 2.0,
             face.at + face.sign * 0.06, TILE_TOP + 1.3, along);
      addBox(g, schoolTrimMat, 0.04, 0.42, 2.12,
             face.at + face.sign * 0.025, TILE_TOP + 1.3, along);
    }
    /* classroom windows: tall, many, evenly along both long faces; the
     * ground floor leaves the door and its board clear */
    const longX = b.w >= b.h;
    const len = longX ? b.w : b.h;
    const start = longX ? b.x : b.y;
    const n = Math.max(2, Math.floor((len - 0.6) / 1.05));
    for (let f = 1; f <= b.floors; f++) {
      const y = TILE_TOP + (f - 1) * FLOOR_H + FLOOR_H * 0.52;
      for (let i = 0; i < n; i++) {
        const pos = start + 0.3 + (i + 0.5) * (len - 0.6) / n;
        [-1, 1].forEach(side => {
          const onDoor = f === 1 && face.sign === side &&
            ((longX && face.axis === 'z') || (!longX && face.axis !== 'z')) &&
            Math.abs(pos - along) < 1.1;
          if (onDoor) return;
          if (longX) {
            addWindow(pos, y, side < 0 ? b.y - 0.02 : b.y + b.h + 0.02,
                      side < 0 ? Math.PI : 0, null, false, 0.7, 1.3);
          } else {
            addWindow(side < 0 ? b.x - 0.02 : b.x + b.w + 0.02, y, pos,
                      side < 0 ? -Math.PI / 2 : Math.PI / 2, null, false,
                      0.7, 1.3);
          }
        });
      }
    }
    /* the yard's fence: posts every cell, two rails, and the gap at the
     * gate */
    if (!b.yard) return;
    const [yx, yy, yw, yh] = b.yard.map(Number);
    const gx = b.gate ? Number(b.gate[0]) : -99;
    const postH = 1.0;
    function rail(x0, z0, x1, z1) {
      const lx = Math.abs(x1 - x0), lz = Math.abs(z1 - z0);
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      [0.38, 0.86].forEach(h => {
        addBox(g, fenceMat, Math.max(0.05, lx), 0.05, Math.max(0.05, lz),
               mx, TILE_TOP + h, mz).castShadow = false;
      });
      /* thin palings between the rails, a few per cell */
      const len = Math.max(lx, lz);
      for (let t = 0.25; t < len; t += 0.25) {
        const px = lx ? Math.min(x0, x1) + t : x0;
        const pz = lz ? Math.min(z0, z1) + t : z0;
        addBox(g, fenceMat, 0.03, 0.82, 0.03, px,
               TILE_TOP + 0.45, pz).castShadow = false;
      }
    }
    function post(x, z) {
      addBox(g, fenceMat, 0.08, postH, 0.08, x, TILE_TOP + postH / 2, z);
    }
    /* north side, either side of the gate's gap */
    const north = yy;
    if (gx > yx) rail(yx, north, gx, north);
    const after = gx >= yx && gx < yx + yw ? gx + 1 : yx;
    if (after < yx + yw) rail(after, north, yx + yw, north);
    rail(yx + yw, yy, yx + yw, yy + yh);              // east
    rail(yx, yy + yh, yx + yw, yy + yh);              // south
    for (let x = yx; x <= yx + yw; x++) {
      if (x !== gx && x !== gx + 1) post(x, north);
      post(x, yy + yh);
    }
    for (let z = yy + 1; z < yy + yh; z++) post(yx + yw, z);
    /* the yard's markings: a painted court, so it reads as a playground
     * from above rather than a car park */
    const cx0 = yx + 0.7, cx1 = yx + yw - 0.7;
    const cz0 = yy + 0.7, cz1 = yy + yh - 0.7;
    const ly = TILE_TOP + 0.012;
    [[cx0, cz0, cx1, cz0], [cx0, cz1, cx1, cz1],
     [cx0, cz0, cx0, cz1], [cx1, cz0, cx1, cz1],
     [(cx0 + cx1) / 2, cz0, (cx0 + cx1) / 2, cz1]].forEach(l => {
      const m = addBox(g, lineMat, Math.max(0.05, Math.abs(l[2] - l[0])),
                       0.012, Math.max(0.05, Math.abs(l[3] - l[1])),
                       (l[0] + l[2]) / 2, ly, (l[1] + l[3]) / 2);
      m.castShadow = false;
    });
  }

  (ground.buildings || []).forEach(b => {
    const wallMat = wallFor(b.kind);
    const roofMat = roofFor(b.kind);
    const g = new THREE.Group();
    scene.add(g);

    const wallH = b.kind === 'shop' ? 1.9 : Math.max(1, b.floors) * FLOOR_H;
    const cx = b.x + b.w / 2, cz = b.y + b.h / 2;

    const body = addBox(g, wallMat, b.w, wallH, b.h,
                        cx, TILE_TOP + wallH / 2, cz);
    body.userData.pick = { kind: 'building', id: b.id };
    buildingBodies.push(body);

    const roof = addBox(g, roofMat, b.w + 0.32, 0.2, b.h + 0.32,
                        cx, TILE_TOP + wallH + 0.1, cz);
    /* the roof is most of what a click from above can land on */
    roof.userData.pick = body.userData.pick;
    buildingBodies.push(roof);

    if (b.kind !== 'shop') {
      for (let f = 1; f < b.floors; f++) {
        addBox(g, b.kind === 'school' ? schoolTrimMat : trimMat,
               b.w + 0.06, 0.055, b.h + 0.06,
               cx, TILE_TOP + f * FLOOR_H, cz);
      }
      /* a stair housing and a water tank, so a roof reads as a roof */
      const hx = b.x + 0.9 + hash01(b.id, 1) * Math.max(0.1, b.w - 2.6);
      const hz = b.y + 0.9 + hash01(b.id, 2) * Math.max(0.1, b.h - 2.6);
      addBox(g, detailMat, 1.0, 0.7, 0.9,
             hx, TILE_TOP + wallH + 0.55, hz);
      const tank = new THREE.Mesh(cylGeo, detailMat);
      tank.scale.set(0.28, 0.45, 0.28);
      tank.position.set(b.x + b.w - 1.1, TILE_TOP + wallH + 0.58,
                        b.y + 1.0);
      tank.castShadow = true;
      tank.receiveShadow = true;
      g.add(tank);
    } else {
      addBox(g, trimMat, b.w + 0.08, 0.12, b.h + 0.08,
             cx, TILE_TOP + wallH - 0.05, cz);
    }

    /* Door on the cell the engine named, with a step and a canopy. */
    const face = doorFace(b);
    const doorW = b.kind === 'shop' || b.kind === 'school' ? 0.8 : 0.55;
    const doorH = b.kind === 'shop' ? 1.15 : 0.92;
    const along = face.axis === 'z'
      ? Math.max(b.x + 0.55, Math.min(b.x + b.w - 0.55, b.door[0] + 0.5))
      : Math.max(b.y + 0.55, Math.min(b.y + b.h - 0.55, b.door[1] + 0.5));
    const out = face.at + face.sign * 0.045;
    if (face.axis === 'z') {
      addBox(g, doorMat, doorW, doorH, 0.08,
             along, TILE_TOP + doorH / 2, out).castShadow = false;
      addBox(g, roofMat, doorW + 0.34, 0.06, 0.36,
             along, TILE_TOP + doorH + 0.2, face.at + face.sign * 0.16);
    } else {
      addBox(g, doorMat, 0.08, doorH, doorW,
             out, TILE_TOP + doorH / 2, along).castShadow = false;

      addBox(g, roofMat, 0.36, 0.06, doorW + 0.34,
             face.at + face.sign * 0.16, TILE_TOP + doorH + 0.2, along);
    }

    /* the step is the one people are lifted onto (Crowd.steps), drawn
     * from the same rectangle so the two cannot drift apart */
    const st = Crowd ? Crowd.doorStep(b) : null;
    if (st) {
      addBox(g, stepMat, st.x1 - st.x0, STEP_H, st.z1 - st.z0,
             (st.x0 + st.x1) / 2, TILE_TOP + STEP_H / 2, (st.z0 + st.z1) / 2);
    }

    /* a small lamp over the door, part of the same night as the street */
    const bulb = new THREE.Mesh(sphereGeo, lampBulbMat);
    bulb.scale.setScalar(0.09);
    if (face.axis === 'z') {
      bulb.position.set(along, TILE_TOP + doorH + 0.34,
                        face.at + face.sign * 0.12);
    } else {
      bulb.position.set(face.at + face.sign * 0.12,
                        TILE_TOP + doorH + 0.34, along);
    }
    g.add(bulb);

    if (b.kind === 'shop') {
      /* the sign and the shopfront: the one place on the estate that is
       * always awake after dark, because somebody is still serving */
      if (face.axis === 'z') {
        addBox(g, shopSignMat, 1.7, 0.36, 0.1, along,
               TILE_TOP + wallH - 0.34, face.at + face.sign * 0.12);
      } else {
        addBox(g, shopSignMat, 0.1, 0.36, 1.7,
               face.at + face.sign * 0.12, TILE_TOP + wallH - 0.34, along);
      }
      const paneY = TILE_TOP + 1.22;
      [along - 0.9, along, along + 0.9].forEach(px => {
        if (face.axis === 'z') {
          addWindow(px, paneY, face.at + face.sign * 0.05,
                    face.sign > 0 ? 0 : Math.PI, null, true, 1.45, 1.25);
        } else {
          addWindow(face.at + face.sign * 0.05, paneY, px,
                    face.sign > 0 ? Math.PI / 2 : -Math.PI / 2,
                    null, true, 1.45, 1.25);
        }
      });
    }

    if (b.kind === 'school') buildSchool(g, b, face, along);

    /* Windows: one pane per flat on each long face, at its own fraction of
     * the face, so the pane belongs to the flat it is drawn for. */
    const units = unitsByBuilding[b.id] || [];
    const longX = b.w >= b.h;
    const len = longX ? b.w : b.h;
    const start = longX ? b.x : b.y;
    const margin = 0.72;
    const span = Math.max(0.1, len - 2 * margin);

    units.forEach(u => {
      const t = (u.i + 0.5) / Math.max(1, u.n);
      const pos = start + margin + t * span;
      const y = TILE_TOP + (u.f - 1) * FLOOR_H + FLOOR_H * 0.58;
      if (longX) {
        addWindow(pos, y, b.y - 0.02, Math.PI, u.uid, false);
        addWindow(pos, y, b.y + b.h + 0.02, 0, u.uid, false);
      } else {
        addWindow(b.x - 0.02, y, pos, -Math.PI / 2, u.uid, false);
        addWindow(b.x + b.w + 0.02, y, pos, Math.PI / 2, u.uid, false);
      }
    });

    /* narrow dark windows on the short faces: architecture, not flats */
    if (units.length) {
      for (let f = 1; f <= b.floors; f++) {
        const y = TILE_TOP + (f - 1) * FLOOR_H + FLOOR_H * 0.58;
        [0.34, 0.66].forEach(t => {
          if (longX) {
            const pz = b.y + t * b.h;
            addWindow(b.x - 0.02, y, pz, -Math.PI / 2, null, false, 0.8, 0.9);
            addWindow(b.x + b.w + 0.02, y, pz, Math.PI / 2, null, false,
                      0.8, 0.9);
          } else {
            const px = b.x + t * b.w;
            addWindow(px, y, b.y - 0.02, Math.PI, null, false, 0.8, 0.9);
            addWindow(px, y, b.y + b.h + 0.02, 0, null, false, 0.8, 0.9);
          }
        });
      }
    }
  });

  /* One instanced pane mesh for every window on the estate. The colour is
   * the whole state of a window: cold glass by day and warm lamplight at
   * night if — and only if — the flat it belongs to is lived in. */
  const paneGeo = new THREE.PlaneGeometry(0.5, 0.62);
  const paneMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, side: THREE.DoubleSide, fog: true });
  const frameGeo = new THREE.PlaneGeometry(0.62, 0.74);
  const frameMat = new THREE.MeshBasicMaterial({
    color: 0x14181e, side: THREE.DoubleSide, fog: true });
  const slotCount = Math.max(1, windowSlots.length);
  const windowMesh = new THREE.InstancedMesh(paneGeo, paneMat, slotCount);
  const frameMesh = new THREE.InstancedMesh(frameGeo, frameMat, slotCount);
  windowMesh.frustumCulled = false;
  frameMesh.frustumCulled = false;
  scene.add(windowMesh);
  scene.add(frameMesh);

  for (let i = 0; i < windowSlots.length; i++) {
    const s = windowSlots[i];
    dummy.position.set(s.px, s.py, s.pz);
    dummy.rotation.set(0, s.ry, 0);
    dummy.scale.set(s.sx, s.sy, 1);
    dummy.updateMatrix();
    windowMesh.setMatrixAt(i, dummy.matrix);
    const nx = Math.sin(s.ry), nz = Math.cos(s.ry);
    dummy.position.set(s.px - nx * 0.014, s.py, s.pz - nz * 0.014);
    dummy.scale.set(s.sx * 1.22, s.sy * 1.16, 1);
    dummy.updateMatrix();
    frameMesh.setMatrixAt(i, dummy.matrix);
  }
  windowMesh.count = windowSlots.length;
  frameMesh.count = windowSlots.length;
  windowMesh.instanceMatrix.needsUpdate = true;
  frameMesh.instanceMatrix.needsUpdate = true;

  /* ---------------------------------------------------------- lamplight */

  /* The lamps' light is a field, not a set of objects: the engine sends a
   * value per cell (0-9) and that is what is drawn. It used to be drawn as
   * a flat disc stamped on every lit cell at one opacity, which read as a
   * grid of hard-edged circles rather than pools of light. Now the field is
   * baked into one texture: a cell per pixel, scaled up with smoothing and
   * blurred, so the light is brightest under the lamp, fades to nothing at
   * its reach, and two lamps' pools merge where they overlap. It lies on
   * the ground as one plane, added to whatever is under it, and `dark`
   * scales it, so it comes up through the dusk with the windows. */
  const GLOW_PX = 16;                 // texture pixels per tile
  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = W * GLOW_PX;
  glowCanvas.height = H * GLOW_PX;
  const glowCells = document.createElement('canvas');
  glowCells.width = W;
  glowCells.height = H;
  const glowTex = new THREE.CanvasTexture(glowCanvas);
  glowTex.colorSpace = THREE.NoColorSpace;  // an amount of light, not a colour
  glowTex.minFilter = THREE.LinearFilter;
  glowTex.magFilter = THREE.LinearFilter;
  glowTex.generateMipmaps = false;
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xffbf66, map: glowTex, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const glowGeo = new THREE.PlaneGeometry(W, H);
  glowGeo.rotateX(-Math.PI / 2);
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.position.set(W / 2, TILE_TOP + 0.02, H / 2);
  glow.renderOrder = 2;
  glow.visible = false;
  scene.add(glow);

  /* the painting itself is `field.js`, shared with the grove's view */
  const glowPainter = Field.makePainter(W, H, GLOW_PX, glowCanvas, glowCells);
  let glowCount = 0;
  function buildGlow(st) {
    const r = glowPainter.paint((st && st.light) || []);
    if (!r.changed) return;            // the field changes when a lamp does
    glowTex.needsUpdate = true;
    glowCount = r.lit;
  }

  /* --------------------------------------------------------- windows lit */

  const occupied = new Set();
  let occupancyDirty = true;
  /* A window's colour is the whole state of it: cold glass by day, warm
   * lamplight in a lived-in flat at night. It is mixed by `dark` rather
   * than switched at a threshold, so the estate lights up room by room
   * through the dusk and goes out the same way through the dawn. The
   * instance colours are rewritten in `WINDOW_STEPS` small steps: that is
   * finer than the eye reads as a step and, unlike a per-frame rewrite,
   * uploads the buffer only while the light is actually moving. */
  const WINDOW_STEPS = 24;
  const WIN_DAY = {
    lived: new THREE.Color(0x51616f), shop: new THREE.Color(0x6b5a44),
    pane: new THREE.Color(0x263039),
  };
  const WIN_NIGHT = {
    lived: new THREE.Color(0xffca7a), shop: new THREE.Color(0xffb45c),
    pane: new THREE.Color(0x0f1419),
  };
  let windowDark = 0;

  function paintWindows(dark) {
    if (!windowSlots.length) return;
    windowDark = clamp01(dark);
    for (let i = 0; i < windowSlots.length; i++) {
      const s = windowSlots[i];
      const key = s.unit != null && occupied.has(s.unit) ? 'lived'
                : s.shop ? 'shop' : 'pane';
      _c1.lerpColors(WIN_DAY[key], WIN_NIGHT[key], windowDark);
      windowMesh.setColorAt(i, _c1);
    }
    if (windowMesh.instanceColor) windowMesh.instanceColor.needsUpdate = true;
  }

  /* ------------------------------------------------------------ the sky */

  const skyColour = new THREE.Color();
  const sunColour = new THREE.Color();
  const hemiSky = new THREE.Color();
  const hemiGround = new THREE.Color();
  let weather = 'clear';
  let darkNow = 0;

  /* The whole sky from one number: the day's fraction. The keyframes and
   * the easing are `clock.js`; this only writes the result into the light
   * objects and the sky. Nothing here allocates: the colours and the light
   * objects are the ones made above. */
  function updateSky(dayFrac) {
    const l = Clock.lightAt(dayFrac);

    sun.intensity = l.sunI;
    hemi.intensity = l.hemiI;
    sunColour.setRGB(l.sun[0], l.sun[1], l.sun[2]);
    sun.color.copy(sunColour);
    skyColour.setRGB(l.sky[0], l.sky[1], l.sky[2]);
    hemiSky.setRGB(l.hemiSky[0], l.hemiSky[1], l.hemiSky[2]);
    hemiGround.setRGB(l.hemiGround[0], l.hemiGround[1], l.hemiGround[2]);
    darkNow = l.dark;

    /* the weather is a property of the sky, so it greys the sky itself
     * (and the fog, which is the same colour) rather than only dimming
     * the ground. It fades out at night, where every sky is dark anyway. */
    const wt = WEATHER_SKY[weather];
    if (wt) {
      _c1.setHex(wt.hex);
      skyColour.lerp(_c1, wt.mix * (1 - darkNow));
      sun.intensity *= wt.sun;
    }

    hemi.color.copy(hemiSky);
    hemi.groundColor.copy(hemiGround);
    scene.background.copy(skyColour);
    /* the horizon a little below the sky's value by day, so the estate
     * sits on the ground rather than floating; at night the fog is the
     * night sky's own colour (clock.js fogGroundMix) */
    scene.fog.color.copy(skyColour)
      .lerp(hemiGround, Clock.fogGroundMix(darkNow));
    renderer.toneMappingExposure = l.exposure;

    /* the sun's arc: east and high at dawn, overhead by morning, west and
     * low by evening, then the moon's blue from the north. The floor on
     * the elevation is the shadow camera's, not the sky's — see SUN_MIN_Y */
    sun.position.set(
      centre.x + l.offset[0],
      Math.max(SUN_MIN_Y, l.offset[1]),
      centre.z + l.offset[2]);
  }

  /* ----------------------------------------------------------- residents */

  /* A figure is about a door's height — small enough that a block dwarfs
   * it, large enough that a person is visible from the far side of
   * the estate without a label. It carries a little warm emissive so the
   * same figure reads at dusk as a person and not as a dark speck. */
  const bodyGeo = new THREE.CapsuleGeometry(0.16, 0.40, 4, 8);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xffe0b0, emissiveIntensity: 0.1,
    roughness: 0.7, metalness: 0.0 });
  const headGeo = new THREE.SphereGeometry(0.16, 10, 8);
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xffd0a0, emissiveIntensity: 0.06,
    roughness: 0.65 });

  let bodyMesh = null, headMesh = null, capacity = 0;
  let people = [];
  let personAt = [];
  const toX = [], toZ = [];
  const roleScale = [];
  /* 0 stands, 1 sits on the bench, 2 stands beside it because it is full */
  const sitMode = [], seatFx = [], seatFz = [];
  /* Each walker's route (from walk.js beside this file) and when its walk
   * began. A route is built when a person's cell changes, not once a frame
   * and not once a poll: the state repeats between days, and rebuilding on
   * every poll restarted the walk before it had got anywhere. */
  const routes = [], routeT0 = [], routeDur = [];
  /* the cell each route set off from; and, for a young child walking with
   * their guardian, the guardian's index (Crowd.place's `with`), else -1 */
  const routeFrom = [], walksWith = [];
  const facing = [];
  let routesBuilt = false;
  let routeFallbacks = 0;     // straight lines used because no path was found
  let routeMaxPoints = 0;
  const routeSample = { x: 0, z: 0, dx: 0, dz: 0, moving: false };
  /* the figures handed to Walk.separate each frame (see updateResidents),
   * and the smallest gap it left, for the HUD and the checks */
  let crowdF = null, crowdIdx = [];
  let crowdFix = null;
  let stepList = null;

  /* ----------------------------------------------------------- trace */
  /* `?trace=1` draws every current route; `?trace=<id>` draws one. It is a
   * debugging view, rebuilt when the day arrives and never inside a frame —
   * the lines are the route the person is actually walking, not a second
   * guess at it. */
  const TRACE_MAX = 8192;           // vertices
  let traceMesh = null, traceGeo = null;
  if (opts.trace) {
    traceGeo = new THREE.BufferGeometry();
    traceGeo.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array(TRACE_MAX * 3), 3)
        .setUsage(THREE.DynamicDrawUsage));
    traceGeo.setDrawRange(0, 0);
    traceMesh = new THREE.LineSegments(traceGeo, new THREE.LineBasicMaterial({
      color: 0xffd166, transparent: true, opacity: 0.9,
      depthWrite: false }));
    traceMesh.frustumCulled = false;
    traceMesh.renderOrder = 4;
    traceMesh.visible = false;
    scene.add(traceMesh);
  }

  function rebuildTrace() {
    if (!traceMesh) return;
    const pos = traceGeo.attributes.position.array;
    const want = String(opts.trace);
    const one = want === '1' ? null : Number(want);
    let n = 0;
    for (let i = 0; i < people.length && n + 6 <= TRACE_MAX * 3; i++) {
      if (one !== null && people[i].id !== one) continue;
      const r = routes[i];
      if (!r || r.n < 2) continue;
      for (let k = 0; k + 1 < r.n && n + 6 <= TRACE_MAX * 3; k++) {
        pos[n++] = r.xs[k]; pos[n++] = WALK_Y + 0.04; pos[n++] = r.zs[k];
        pos[n++] = r.xs[k + 1]; pos[n++] = WALK_Y + 0.04; pos[n++] = r.zs[k + 1];
      }
    }
    traceGeo.setDrawRange(0, n / 3);
    traceGeo.attributes.position.needsUpdate = true;
    traceMesh.visible = n > 0;
  }

  /* where everyone outdoors stood last state: a walk starts from that spot
   * (the seat they get up from, their place in the crowd) rather than the
   * cell's centre, and somebody whose spot did not move is not sent
   * walking at all */
  let prevSpot = {};
  /* The day is the clock, not the poll: `clock` (clock.js) owns the anchor
   * and the pins. The page is polled several times per day, and resetting
   * on every state made the light restart toward dawn and the walk restart
   * toward the old position before either had got anywhere. The next state
   * with a new `day` re-anchors at the fraction already reached; the light
   * is a periodic function of that fraction, so the wrap back to 0 at the
   * day's turn is the same night it wraps from. */

  function ensureResidents(n) {
    if (bodyMesh && n <= capacity) return;
    if (bodyMesh) {
      scene.remove(bodyMesh);
      scene.remove(headMesh);
      bodyMesh.dispose();
      headMesh.dispose();
    }
    capacity = Math.max(64, n + 32);
    bodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, capacity);
    headMesh = new THREE.InstancedMesh(headGeo, headMat, capacity);
    bodyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    headMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    bodyMesh.castShadow = true;
    bodyMesh.frustumCulled = false;
    headMesh.castShadow = true;
    headMesh.frustumCulled = false;
    scene.add(bodyMesh);
    scene.add(headMesh);
  }

  /* Where a walk begins or ends when a block is involved: the door cell the
   * engine itself walks to, never a point on the wall. Being inside is a
   * state, not a coordinate (`_pos` in the engine makes the same turn). */
  function doorSpot(unit) {
    const u = ground.units[String(unit)];
    const b = u ? buildingById[u.b] : null;
    return b ? { x: b.door[0], y: b.door[1] } : null;
  }

  /* The school gate, where every walk in or out of the yard goes through
   * the fence: the yard is not walkable ground (nobody crosses it on the
   * way somewhere else), so the router takes a walk to the gate and the
   * last steps are through it to the pupil's place inside. */
  const schoolB = (ground.buildings || [])
    .find(b => b.kind === 'school' && b.gate);
  const schoolGate = schoolB
    ? { x: Number(schoolB.gate[0]), y: Number(schoolB.gate[1]) } : null;
  let lastViewKey = '';

  function cellsBetween(sx, sy, tx, ty) {
    if (!grid) return null;
    const c = Walk.findPath(grid, sx, sy, tx, ty);
    return c ? Array.from(c) : null;
  }

  /* the cells of a walk that starts or ends inside the fence */
  function schoolCells(scx, scy, gx, gy, wasIn, isIn) {
    const G = schoolGate;
    const inner = [G.x, G.y + 1];
    if (wasIn && isIn) return [scx, scy, gx, gy];
    if (isIn) {
      const c = cellsBetween(scx, scy, G.x, G.y);
      return c ? c.concat(inner, [gx, gy]) : null;
    }
    const c = cellsBetween(G.x, G.y, gx, gy);
    return c ? [scx, scy].concat(inner, c) : null;
  }

  /* A walk into or out of the yard, shaped like Crowd.route's: from the
   * door or where the walker last stood, to their place (`tx`, `tz`) as
   * Crowd.place set it, through the gate. */
  function schoolRoute(p, tx, tz, prev, door) {
    let scx, scy, sx, sz;
    if (door) {
      scx = door.x; scy = door.y;
      sx = scx + 0.5; sz = scy + 0.5;
    } else {
      scx = p.px == null ? p.x : p.px;
      scy = p.py == null ? p.y : p.py;
      sx = scx + 0.5; sz = scy + 0.5;
      const was = prev && prev[p.id];
      if (was && was.cell === scx + ',' + scy) { sx = was.x; sz = was.z; }
      else if (scx === p.x && scy === p.y) return null;
    }
    if (Math.abs(sx - tx) < 1e-3 && Math.abs(sz - tz) < 1e-3) return null;
    const isIn = p.mode === 'school', wasIn = p.pmode === 'school';
    const cells = schoolCells(scx, scy, Math.floor(tx), Math.floor(tz),
                              wasIn, isIn);
    if (cells) {
      return { route: Walk.routePoints(cells, sx, sz, tx, tz),
               fallback: false, from: [scx, scy] };
    }
    return { route: Walk.straight(sx, sz, tx, tz), fallback: true,
             from: [scx, scy] };
  }

  function syncResidents(st) {
    people = st.people || [];
    ensureResidents(people.length);
    bodyMesh.count = people.length;
    headMesh.count = people.length;
    if (personAt.length < capacity) {
      for (let i = personAt.length; i < capacity; i++) {
        personAt[i] = null;
        toX[i] = toZ[i] = 0;
        roleScale[i] = 1;
        sitMode[i] = 0;
        seatFx[i] = 0;
        seatFz[i] = 1;
        routes[i] = null;
        routeT0[i] = routeDur[i] = 0;
        facing[i] = 0;
      }
    }

    /* A position only changes when a day does. The page is polled several
     * times per day, so a route is rebuilt on the day's arrival and left
     * alone in between: rebuilding it on every poll restarted the walk from
     * its beginning before it had arrived. */
    /* the scrubber's view of another phase is a new picture too */
    const viewKey = st.viewKey || '';
    const fresh = !routesBuilt || st.day !== clock.daySeen ||
                  viewKey !== lastViewKey;
    lastViewKey = viewKey;
    const spotWas = prevSpot;
    /* the fixtures first: where a crowd may stand depends on them */
    if (fresh && grid) Walk.setFixtures(grid, st.fixtures || []);

    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      personAt[i] = p;
      toX[i] = p.x + 0.5;
      toZ[i] = p.y + 0.5;
      roleScale[i] = p.role === 'child' ? 0.78 : p.role === 'elder' ? 0.92 : 1;
      sitMode[i] = 0;

      _c1.setHex(ROLE_COLOUR[p.role] === undefined ? 0xcccccc
                                                   : ROLE_COLOUR[p.role]);
      bodyMesh.setColorAt(i, _c1);
      _c1.setHex(SKIN[Math.floor(hash01(p.id, 13) * SKIN.length) % SKIN.length]);
      headMesh.setColorAt(i, _c1);
    }

    /* Where on their tile each resident stands (crowd.js): one figure per
     * seat on a bench and the rest standing clear of it, everyone else on a
     * shared tile packed round its middle, never inside a table or a stall.
     * A function of the snapshot alone, so a poll that repeats the state
     * repeats the picture. */
    crowdFix = Crowd ? Crowd.fixtureMap(st.fixtures) : null;
    stepList = Crowd ? Crowd.steps(ground, st.fixtures) : null;
    const spots = Crowd ? Crowd.place(Walk, grid, people, benchByCell,
                                      crowdFix)
                        : null;
    seatedCount = spots ? spots.seated : 0;
    const spotNow = {};
    for (let i = 0; i < people.length; i++) {
      if (!spots) break;
      toX[i] = spots.x[i];
      toZ[i] = spots.z[i];
      sitMode[i] = spots.sit[i];
      seatFx[i] = spots.fx[i];
      seatFz[i] = spots.fz[i];
      const p = people[i];
      if (!p.in) spotNow[p.id] = { cell: p.x + ',' + p.y, x: toX[i], z: toZ[i] };
    }
    prevSpot = spotNow;
    if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
    if (headMesh.instanceColor) headMesh.instanceColor.needsUpdate = true;

    occupied.clear();
    for (let i = 0; i < people.length; i++) {
      if (people[i].unit != null) occupied.add(people[i].unit);
    }
    occupancyDirty = true;

    const now = performance.now();
    /* a pace change alters the rate, not the hour: the clock keeps the
     * fraction already reached, so switching from a minute a day to five
     * seconds makes the rest of the day shorter rather than jumping the
     * light (see Clock.setPace) */
    Clock.setPace(clock, now, st.tick_seconds);

    /* Each changed position becomes a walk over the plan's own ground. A
     * resident leaving a block starts at its door; a resident already on a
     * bench starts at the seat. Anyone whose cell did not change keeps the
     * route they had — which is what lets a walk finish. */
    if (fresh) {
      routeMaxPoints = 0;
      for (let i = 0; i < people.length; i++) {
        const p = people[i];
        routes[i] = null;
        routeFrom[i] = null;
        walksWith[i] = -1;
        if (p.in) continue;                // indoors is not drawn walking
        /* from the door when leaving a block, else from where they stood;
         * to their own place on the tile. Somebody whose place did not
         * move stays put. */
        const door = p.pin ? doorSpot(p.punit) : null;
        /* a walk into or out of the school yard goes through its gate
         * (schoolRoute); every other walk is the crowd's (crowd.js) */
        const school = Walk && schoolGate &&
                       (p.mode === 'school' || p.pmode === 'school');
        const got = school ? schoolRoute(p, toX[i], toZ[i], spotWas, door)
                  : Crowd ? Crowd.route(Walk, grid, p, toX[i], toZ[i],
                                        spotWas, door, crowdFix)
                          : null;
        if (!got) continue;
        /* no path (or no router): the straight line the page used to draw,
         * counted so a broken grid is visible rather than silent */
        if (got.fallback) routeFallbacks++;
        const route = got.route;
        routes[i] = route;
        routeFrom[i] = got.from;
        routeT0[i] = now;
        routeDur[i] = Walk ? Walk.duration(route.total, clock.dayMs)
                           : Math.max(120, clock.dayMs * 0.9);
        if (route.total > 1e-4 && route.n > routeMaxPoints) {
          routeMaxPoints = route.n;
        }
        if (route.n > 1) {
          const dx = route.xs[1] - route.xs[0];
          const dz = route.zs[1] - route.zs[0];
          if (dx || dz) facing[i] = Math.atan2(dx, dz);
        }
      }
      /* A young child out with a guardian walks the guardian's own way,
       * from where they stood to their place beside them (Crowd.place puts
       * it clear of walls, fixtures, table tops and everyone else on the
       * tile), a step behind: the pair set off, go round every wall and
       * arrive as one, and the child is never drawn off on a way of their
       * own. */
      if (Crowd && spots) {
        for (let i = 0; i < people.length; i++) {
          const g = spots.with[i];
          if (g == null || g < 0 || !routes[i] || !routes[g]) continue;
          const r = Crowd.follow(routes[g], routeFrom[g], routes[i],
                                 routeFrom[i], Walk, grid, crowdFix);
          if (r === routes[i]) continue;
          routes[i] = r;
          walksWith[i] = g;
          if (r.n > routeMaxPoints) routeMaxPoints = r.n;
        }
      }
      /* walkers setting off from one point go in turn, not as one body:
       * six out of a door file out of it (crowd.js) */
      if (Crowd) {
        const qi = [], starts = [];
        for (let i = 0; i < people.length; i++) {
          const r = routes[i];
          if (!r || r.total <= 1e-6 || walksWith[i] >= 0) continue;
          qi.push(i);
          starts.push({ id: people[i].id, x: r.xs[0], z: r.zs[0] });
        }
        const delays = Crowd.queue(starts);
        for (let k = 0; k < qi.length; k++) {
          const f = Crowd.fit(delays[k], routeDur[qi[k]], clock.dayMs);
          routeT0[qi[k]] = now + f.delay;
          routeDur[qi[k]] = f.dur;
        }
        /* a child a step behind their guardian, at the guardian's pace,
         * still inside the day */
        for (let i = 0; i < people.length; i++) {
          const g = walksWith[i];
          if (g < 0) continue;
          const f = Crowd.fit(routeT0[g] - now + Crowd.QUEUE_MS,
                              routeDur[g], clock.dayMs);
          routeT0[i] = now + f.delay;
          routeDur[i] = f.dur;
          const r = routes[i];
          if (r.n > 1) {
            const dx = r.xs[1] - r.xs[0], dz = r.zs[1] - r.zs[0];
            if (dx || dz) facing[i] = Math.atan2(dx, dz);
          }
        }
      }
      routesBuilt = true;
      if (traceMesh) rebuildTrace();
    }

    /* freeze at the hour the page is showing; re-anchor at the fraction
     * already reached when the day turns (Clock.onState). */
    Clock.onState(clock, now, st);
  }

  /* Somebody queued behind others at a door is still indoors. */
  function waiting(i, now) {
    return !staticMode && !!routes[i] && people[i].pin && now < routeT0[i];
  }

  /* Where each figure is drawn this frame, before spacing: on its route
   * if it has one, else at its place. */
  function rawResident(i, now, out) {
    const r = routes[i];
    out.hidden = waiting(i, now);
    out.x = toX[i]; out.z = toZ[i];
    out.dx = out.dz = 0;
    out.moving = false;
    if (Walk && r && r.total > 1e-6) {
      const t = staticMode ? r.total
                           : (now - routeT0[i]) / (routeDur[i] || 1) * r.total;
      Walk.sample(r, t, routeSample);
      out.x = routeSample.x;
      out.z = routeSample.z;
      out.dx = routeSample.dx;
      out.dz = routeSample.dz;
      out.moving = routeSample.moving;
    }
    return out;
  }

  /* Keep figures from walking into each other: every outdoor figure is
   * handed to Walk.separate, which pushes apart any two closer than their
   * bodies and passes oncoming walkers side by side. Seated figures do not
   * move; walkers give way more readily than those standing. No push takes
   * a body onto a wall, a solid or the water, or out of the cell its route
   * has it in other than onto open ground (Walk.clearAt), nor into the
   * lamp post, tree or table in its own cell (the fixture's keep,
   * Crowd.space) — the walk's own guarantee holds after spacing too. Stateless, so a frame depends on
   * nothing but its own time. */
  const crowdDx = [], crowdDz = [];
  const crowdRaw = { x: 0, z: 0, dx: 0, dz: 0, moving: false };
  function spaceResidents(now) {
    let n = 0;
    crowdF = Walk ? Walk.figures(crowdF, people.length) : null;
    for (let i = 0; i < people.length; i++) {
      crowdDx[i] = crowdDz[i] = 0;
      if (!crowdF || people[i].in) continue;
      rawResident(i, now, crowdRaw);
      if (crowdRaw.hidden) continue;
      const F = crowdF;
      F.rx[n] = crowdRaw.x; F.rz[n] = crowdRaw.z;
      F.r[n] = Crowd.R * roleScale[i];
      const seated = sitMode[i] === 1 && !crowdRaw.moving;
      F.w[n] = seated ? 0 : crowdRaw.moving ? 1 : 0.5;
      F.hx[n] = crowdRaw.moving ? crowdRaw.dx : 0;
      F.hz[n] = crowdRaw.moving ? crowdRaw.dz : 0;
      F.layer[n] = 0;
      F.id[n] = people[i].id;
      crowdIdx[n] = i;
      n++;
    }
    if (!crowdF || n === 0) return;
    /* pushed only to open ground, and never into the lamp post, tree or
     * table in a body's own cell (crowd.js space) */
    Crowd.space(Walk, grid, crowdFix, crowdF, n);
    for (let k = 0; k < n; k++) {
      const i = crowdIdx[k];
      crowdDx[i] = crowdF.x[k] - crowdF.rx[k];
      crowdDz[i] = crowdF.z[k] - crowdF.rz[k];
    }
  }

  function updateResidents(now) {
    if (!bodyMesh) return;
    spaceResidents(now);
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      if (p.in || waiting(i, now)) {
        dummy.position.set(0, -50, 0);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(0, 0, 0);
        dummy.updateMatrix();
        bodyMesh.setMatrixAt(i, dummy.matrix);
        headMesh.setMatrixAt(i, dummy.matrix);
        continue;
      }
      const s = roleScale[i];
      const r = routes[i];
      let x = toX[i], z = toZ[i];
      let moving = false;
      if (Walk && r && r.total > 1e-6) {
        const t = staticMode ? r.total
                             : (now - routeT0[i]) / (routeDur[i] || 1) * r.total;
        Walk.sample(r, t, routeSample);
        x = routeSample.x;
        z = routeSample.z;
        moving = routeSample.moving;
        if (routeSample.dx || routeSample.dz) {
          facing[i] = Math.atan2(routeSample.dx, routeSample.dz);
        }
      }
      x += crowdDx[i] || 0;
      z += crowdDz[i] || 0;
      /* at a table and not walking: beside it, facing it (crowd.js) */
      if (!moving && Crowd) {
        const yaw = Crowd.faceTable(crowdFix, p.x, p.y, x, z);
        if (yaw !== null) facing[i] = yaw;
      }

      /* somebody who has arrived at their bench sits; somebody still
       * walking there is still walking */
      if (sitMode[i] === 1 && !moving) {
        /* sitting: the body is shorter and its foot is the seat's top, and
         * a small lean toward the path is what makes it read as sitting
         * rather than as a figure sunk into the ground */
        const fx = seatFx[i], fz = seatFz[i];
        const seatY = TILE_TOP + 0.46;
        dummy.rotation.set(0.16 * fz, 0, -0.16 * fx);
        dummy.scale.set(s, s * 0.72, s);
        dummy.position.set(x, seatY + 0.26 * s, z);
        dummy.updateMatrix();
        bodyMesh.setMatrixAt(i, dummy.matrix);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(s, s, s);
        dummy.position.set(x + fx * 0.09 * s, seatY + 0.60 * s,
                          z + fz * 0.09 * s);
        dummy.updateMatrix();
        headMesh.setMatrixAt(i, dummy.matrix);
        continue;
      }
      /* a small gait while walking, still otherwise; and a body turned the
       * way it is going */
      const bob = moving
        ? (1 + Math.sin(now * 0.009 + i * 1.7)) * 0.02 * s
        : 0;
      /* standing on a step when over one, and rising onto it smoothly on
       * the way in (crowd.js `lift`); the gait only ever lifts a foot,
       * never sinks it into the ground */
      const footY = WALK_Y + (Crowd ? Crowd.lift(stepList, x, z) : 0);
      dummy.rotation.set(0, facing[i], 0);
      dummy.scale.set(s, s, s);
      dummy.position.set(x, footY + 0.36 * s + bob, z);
      dummy.updateMatrix();
      bodyMesh.setMatrixAt(i, dummy.matrix);
      dummy.position.set(x, footY + 0.82 * s + bob, z);
      dummy.updateMatrix();
      headMesh.setMatrixAt(i, dummy.matrix);
    }
    bodyMesh.instanceMatrix.needsUpdate = true;
    headMesh.instanceMatrix.needsUpdate = true;
  }

  /* ----------------------------------------------------------- fixtures */

  const fixtureGroup = new THREE.Group();
  scene.add(fixtureGroup);
  let fixtureKey = '';
  let fixturesBuilt = false;
  let fixtureEntries = [];
  let treeEntries = [];
  /* the frame's own fixtures by id, so a click on a bench can return the
   * fact the server sent rather than a second copy kept by the page */
  let fixtureById = {};
  /* The benches, by cell, with the way each one faces. A resident on a
   * bench's cell is seated on it (up to its capacity), and `focus=bench`
   * needs to know where the benches are without inventing a second copy of
   * the fixture list. Both are derived from the state the server sends. */
  let benchByCell = {};
  let benchCount = 0;
  let seatedCount = 0;

  function clearFixtures() {
    fixtureEntries.forEach(fx => {
      fx.mats.forEach(m => m.mat.dispose());
    });
    while (fixtureGroup.children.length) {
      fixtureGroup.remove(fixtureGroup.children[0]);
    }
    fixtureEntries = [];
    treeEntries = [];
  }

  function fixtureMaterial(hex, rough) {
    const mat = new THREE.MeshStandardMaterial({
      color: hex, roughness: rough === undefined ? 0.85 : rough });
    return { mat, base: hex };
  }

  function treeMesh(group, mats, season, id) {
    const trunk = fixtureMaterial(0x5a4630, 0.95);
    const canopyColour = SEASONS[season].canopy[
      Math.floor(hash01(id, 21) * SEASONS[season].canopy.length) %
      SEASONS[season].canopy.length];
    const canopy = fixtureMaterial(canopyColour, 0.9);
    mats.push(trunk, canopy);
    const t = new THREE.Mesh(taperGeo, trunk.mat);
    t.scale.set(0.13, 0.85, 0.13);
    t.position.set(0, 0.425, 0);
    t.castShadow = true;
    group.add(t);
    const blobs = [[-0.22, 1.18, 0.02, 0.42], [0.23, 1.08, -0.06, 0.39],
                   [0.0, 1.48, 0.07, 0.45]];
    blobs.forEach(bl => {
      const m = new THREE.Mesh(icoGeo, canopy.mat);
      m.scale.setScalar(bl[3]);
      m.position.set(bl[0], bl[1], bl[2]);
      m.castShadow = true;
      group.add(m);
    });
    treeEntries.push({ id, canopy, trunk });
  }

  /* Which way a bench faces. A bench beside a path turns its back to the
   * walkway's far side and looks at the path, its seat running along it, so
   * whoever sits watches the estate go past. The path is a fact already in
   * the ground (`codes` and `rows`), never a second map in the page. A bench
   * with no path beside it — the courtyard's own — keeps the default pose,
   * which is the one both views have always drawn. */
  function buildFixture(f, season) {
    const g = new THREE.Group();
    g.position.set(f.x + 0.5, TILE_TOP, f.y + 0.5);
    g.userData.pick = { kind: 'fixture', id: f.id };
    const mats = [];

    let bench = null;
    if (f.kind === 'tree') {
      treeMesh(g, mats, season, f.id);
    } else if (f.kind === 'bench') {
      bench = Crowd ? Crowd.bench(ground, f)
                    : { key: f.x + ',' + f.y, id: Number(f.id), cx: f.x,
                        cy: f.y, x: f.x + 0.5, z: f.y + 0.5, fx: 0, fz: 1,
                        yaw: 0, perimeter: !!f.perimeter,
                        cap: Math.max(0, Number(f.cap) || 0) };
      const face = bench;
      g.rotation.y = face.yaw;
      const wood = fixtureMaterial(0x8a6a3f, 0.9);
      const metal = fixtureMaterial(0x454c54, 0.7);
      mats.push(wood, metal);
      addBox(g, wood.mat, 0.9, 0.08, 0.34, 0, 0.42, 0);
      addBox(g, wood.mat, 0.9, 0.3, 0.07, 0, 0.58, -0.16);
      addBox(g, metal.mat, 0.07, 0.42, 0.3, -0.34, 0.21, 0);
      addBox(g, metal.mat, 0.07, 0.42, 0.3, 0.34, 0.21, 0);
      /* local +z is the way it faces; local +x runs along the seat */
    } else if (f.kind === 'table') {
      const wood = fixtureMaterial(0x9c7f52, 0.9);
      const metal = fixtureMaterial(0x454c54, 0.7);
      mats.push(wood, metal);
      addBox(g, wood.mat, 0.82, 0.08, 0.82, 0, 0.7, 0);
      [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]
        .forEach(p => addBox(g, metal.mat, 0.07, 0.7, 0.07, p[0], 0.35, p[1]));
    } else if (f.kind === 'lamp') {
      const metal = fixtureMaterial(0x4a5158, 0.65);
      mats.push(metal);
      const pole = new THREE.Mesh(cylGeo, metal.mat);
      pole.scale.set(0.045, 1.75, 0.045);
      pole.position.set(0, 0.875, 0);
      pole.castShadow = true;
      g.add(pole);
      const arm = addBox(g, metal.mat, 0.34, 0.05, 0.05, 0.14, 1.74, 0);
      arm.castShadow = false;
      const bulb = new THREE.Mesh(sphereGeo, lampBulbMat);
      bulb.scale.setScalar(0.145);
      bulb.position.set(0.3, 1.68, 0);
      g.add(bulb);
    } else if (f.kind === 'playground') {
      const red = fixtureMaterial(0xd8574f, 0.8);
      const yellow = fixtureMaterial(0xe6b84f, 0.8);
      const metal = fixtureMaterial(0x4a5158, 0.7);
      mats.push(red, yellow, metal);
      addBox(g, red.mat, 0.07, 1.15, 0.07, -0.4, 0.575, -0.3);
      addBox(g, red.mat, 0.07, 1.15, 0.07, -0.4, 0.575, 0.3);
      addBox(g, red.mat, 0.07, 0.07, 0.68, -0.4, 1.12, 0);
      addBox(g, yellow.mat, 0.55, 0.07, 0.34, -0.05, 0.7, 0.28);
      addBox(g, yellow.mat, 0.07, 0.7, 0.07, 0.22, 0.35, 0.28);
      addBox(g, metal.mat, 0.5, 0.05, 0.05, 0.28, 1.1, -0.28);
      addBox(g, metal.mat, 0.05, 1.1, 0.05, 0.03, 0.55, -0.28);
      addBox(g, metal.mat, 0.05, 1.1, 0.05, 0.53, 0.55, -0.28);
      addBox(g, red.mat, 0.16, 0.04, 0.12, 0.18, 0.42, -0.28);
      addBox(g, red.mat, 0.16, 0.04, 0.12, 0.38, 0.42, -0.28);
    } else if (f.kind === 'school') {
      /* the school gate: two brick pillars with caps in the gap of the
       * yard's fence (the fence line is the cell's south edge) and an
       * open green leaf folded back against the fence */
      const brick = fixtureMaterial(BUILDING_STYLE.school.wall, 0.9);
      const cap = fixtureMaterial(BUILDING_STYLE.school.trim, 0.9);
      const leaf = fixtureMaterial(0x3d5a4a, 0.75);
      mats.push(brick, cap, leaf);
      [-0.46, 0.46].forEach(px => {
        addBox(g, brick.mat, 0.2, 1.15, 0.2, px, 0.575, 0.5);
        addBox(g, cap.mat, 0.26, 0.07, 0.26, px, 1.18, 0.5);
      });
      addBox(g, leaf.mat, 0.04, 0.8, 0.6, 0.38, 0.5, 0.82);
    } else if (f.kind === 'bus_stop') {
      /* a bus shelter: two posts, a roof, a glass back, a perch seat, and
       * the stop's own pole with its round sign. Every piece stands inside
       * the 0.86 square about the cell's middle — crowd.js's BODY and KEEP
       * for the stop, the shelter's solid cell in walk.js — so nobody
       * walks through the pole (it stood in the next cell, with no
       * keep-out) or the posts. crowd_check's oracle reads these numbers
       * from here. */
      const metal = fixtureMaterial(0x4a5158, 0.65);
      const glass = fixtureMaterial(0x9fb7c4, 0.3);
      const sign = fixtureMaterial(0xc8453c, 0.6);
      const roofM = fixtureMaterial(0x30363d, 0.8);
      mats.push(metal, glass, sign, roofM);
      glass.mat.transparent = true;
      glass.mat.opacity = 0.55;
      addBox(g, metal.mat, 0.06, 1.3, 0.06, -0.4, 0.65, -0.3);
      addBox(g, metal.mat, 0.06, 1.3, 0.06, 0.4, 0.65, -0.3);
      addBox(g, roofM.mat, 0.86, 0.06, 0.55, 0, 1.32, -0.12);
      addBox(g, glass.mat, 0.8, 1.0, 0.03, 0, 0.75, -0.32)
        .castShadow = false;
      addBox(g, metal.mat, 0.7, 0.05, 0.16, 0, 0.45, -0.22);
      const pole = new THREE.Mesh(cylGeo, metal.mat);
      pole.scale.set(0.035, 1.6, 0.035);
      pole.position.set(0.25, 0.8, 0.25);
      pole.castShadow = true;
      g.add(pole);
      const disc = new THREE.Mesh(cylGeo, sign.mat);
      disc.scale.set(0.17, 0.03, 0.17);
      disc.rotation.x = Math.PI / 2;
      disc.position.set(0.25, 1.55, 0.25);
      g.add(disc);
    } else if (f.kind === 'shop') {
      const wood = fixtureMaterial(0xcf9f60, 0.8);
      mats.push(wood);
      /* the shop's front: a low wooden plinth before its door, one step
       * high, that its customers step up onto (it was a waist-high
       * counter they walked through) */
      addBox(g, wood.mat, 0.9, STEP_H, 0.9, 0, STEP_H / 2, 0);
    } else {
      /* a kind the page has never seen: a small plinth in its own colour,
       * so the estate still shows that something is there */
      const hex = fallbackSiteColour(f.kind);
      const mat = fixtureMaterial(hex, 0.85);
      mats.push(mat);
      addBox(g, mat.mat, 0.5, 0.3, 0.5, 0, 0.15, 0);
    }

    fixtureGroup.add(g);
    return { id: f.id, kind: f.kind, group: g, mats, bench };
  }

  function buildFixtures(st) {
    clearFixtures();
    const season = Math.max(0, Math.min(3, st.season || 0));
    benchByCell = {};
    benchCount = 0;
    (st.fixtures || []).forEach(f => {
      const entry = buildFixture(f, season);
      fixtureEntries.push(entry);
      if (entry.bench) {
        benchByCell[entry.bench.key] = entry.bench;
        benchCount++;
      }
    });
    fixtureKey = (st.fixtures || []).map(f => f.id + ':' + f.kind).join(',');
    fixturesBuilt = true;
    syncFixtureSeason(st.season || 0);
  }

  function syncFixtureSeason(season) {
    season = Math.max(0, Math.min(3, season || 0));
    treeEntries.forEach(t => {
      const pal = SEASONS[season].canopy;
      const hex = pal[Math.floor(hash01(t.id, 21) * pal.length) % pal.length];
      t.canopy.base = hex;
      t.trunk.base = 0x5a4630;
    });
  }

  function syncFixtures(st) {
    const key = (st.fixtures || []).map(f => f.id + ':' + f.kind).join(',');
    if (!fixturesBuilt || key !== fixtureKey) buildFixtures(st);
    syncFixtureSeason(st.season || 0);
    fixtureById = {};
    (st.fixtures || []).forEach(f => { fixtureById[f.id] = f; });
    fixtureEntries.forEach(fx => {
      const f = fixtureById[fx.id];
      const c = f ? clamp01(f.c == null ? 1 : f.c) : 1;
      const k = 0.55 + 0.45 * c;
      fx.mats.forEach(m => {
        _c1.setHex(m.base).multiplyScalar(k);
        m.mat.color.copy(_c1);
      });
      const tilt = (1 - c);
      fx.group.rotation.z = (hash01(fx.id, 31) - 0.5) * 0.24 * tilt;
      fx.group.rotation.x = (hash01(fx.id, 32) - 0.5) * 0.2 * tilt;
    });
  }

  /* ------------------------------------------------------------- weather */

  /* Rain is drawn as short vertical line segments rather than points. A
   * point sprite the size of a raindrop is a star, and a night sky full of
   * stars on a rainy day is a lie about the weather. One LineSegments is
   * still one draw call. Snow keeps the points, because a flake is a
   * point. */
  const RAIN_MAX = 1500, SNOW_MAX = 700;
  const rainPos = new Float32Array(RAIN_MAX * 6);
  for (let i = 0; i < RAIN_MAX; i++) {
    const x = Math.random() * (W + 4) - 2;
    const y = Math.random() * 16;
    const z = Math.random() * (H + 4) - 2;
    const j = i * 6;
    rainPos[j] = x; rainPos[j + 1] = y; rainPos[j + 2] = z;
    rainPos[j + 3] = x; rainPos[j + 4] = y - 0.55; rainPos[j + 5] = z;
  }
  const rainGeo = new THREE.BufferGeometry();
  const rainAttr = new THREE.BufferAttribute(rainPos, 3);
  rainGeo.setAttribute('position', rainAttr);
  rainGeo.setDrawRange(0, 0);
  const rainMat = new THREE.LineBasicMaterial({
    color: 0x9fd0ff, transparent: true, opacity: 0.48, depthWrite: false });
  const rain = new THREE.LineSegments(rainGeo, rainMat);
  rain.frustumCulled = false;
  rain.visible = false;
  scene.add(rain);

  const snowPos = new Float32Array(SNOW_MAX * 3);
  for (let i = 0; i < SNOW_MAX; i++) {
    snowPos[i * 3] = Math.random() * (W + 4) - 2;
    snowPos[i * 3 + 1] = Math.random() * 16;
    snowPos[i * 3 + 2] = Math.random() * (H + 4) - 2;
  }
  const snowGeo = new THREE.BufferGeometry();
  const snowAttr = new THREE.BufferAttribute(snowPos, 3);
  snowGeo.setAttribute('position', snowAttr);
  snowGeo.setDrawRange(0, 0);
  const snowMat = new THREE.PointsMaterial({
    color: 0xffffff, size: 0.115, transparent: true, opacity: 0.85,
    depthWrite: false, sizeAttenuation: true });
  const snow = new THREE.Points(snowGeo, snowMat);
  snow.frustumCulled = false;
  snow.visible = false;
  scene.add(snow);

  let rainAmount = 0, snowAmount = 0;

  function syncWeather(st) {
    const weather = st.weather || 'clear';
    rainAmount = weather === 'rain' ? 800 : weather === 'storm' ? RAIN_MAX : 0;
    snowAmount = weather === 'frost' ? SNOW_MAX : 0;
    rainGeo.setDrawRange(0, rainAmount * 2);
    snowGeo.setDrawRange(0, snowAmount);
    rain.visible = rainAmount > 0;
    snow.visible = snowAmount > 0;
  }

  function updateWeather(dt, now) {
    if (rainAmount) {
      const fall = 12 * dt;
      for (let i = 0; i < rainAmount; i++) {
        const j = i * 6;
        rainPos[j + 1] -= fall;
        rainPos[j + 4] = rainPos[j + 1] - 0.55;
        if (rainPos[j + 1] < 0) {
          const x = Math.random() * (W + 4) - 2;
          const z = Math.random() * (H + 4) - 2;
          rainPos[j] = x; rainPos[j + 1] = 16; rainPos[j + 2] = z;
          rainPos[j + 3] = x; rainPos[j + 4] = 15.45; rainPos[j + 5] = z;
        }
      }
      rainAttr.needsUpdate = true;
    }
    if (snowAmount) {
      for (let i = 0; i < snowAmount; i++) {
        const j = i * 3;
        snowPos[j + 1] -= 1.3 * dt;
        snowPos[j] += Math.sin(now * 0.001 + i * 0.7) * 0.006;
        if (snowPos[j + 1] < 0) {
          snowPos[j] = Math.random() * (W + 4) - 2;
          snowPos[j + 1] = 16;
          snowPos[j + 2] = Math.random() * (H + 4) - 2;
        }
      }
      snowAttr.needsUpdate = true;
    }
  }

  /* --------------------------------------------------------------- state */

  let groundKey = '';
  let lastNow = 0;

  function setState(st) {
    clock.haveState = true;
    weather = st.weather || 'clear';
    const key = st.day + ':' + st.season;
    if (key !== groundKey) {
      groundKey = key;
      paintGround(st);
      buildGlow(st);
    }
    if (!fixturesBuilt) buildFixtures(st);
    syncFixtures(st);
    syncResidents(st);
    syncWeather(st);
    /* who is at home may have changed; the windows are painted here at
     * the hour the last frame drew, and the next frame moves them on if
     * the light has moved a step */
    paintWindows(windowDark);
    occupancyDirty = false;
    lastNow = performance.now();
  }

  /* -------------------------------------------------------------- frame */

  const phaseInfo = { phase: 2, index: 2, name: 'afternoon', darkness: 0,
                      dayFrac: 0.5 };
  let windowStep = -1;

  /* Where the day is, 0..1 (clock.js): a frozen phase is shown at its
   * midpoint, which is also its key in the light table (dawn 0.2, morning
   * 0.4, afternoon 0.6, evening 0.8, night 0.0); `?clock=` pins the clock
   * outright; a paused day does not keep turning its light. */
  function dayFraction(now) {
    return Clock.fraction(clock, now);
  }

  function frame(now) {
    const dt = Math.min(0.05, lastNow ? Math.max(0, (now - lastNow) / 1000)
                                      : 0.016);
    lastNow = now;
    const f = dayFraction(now);
    updateSky(f);
    const dark = darkNow;
    /* repaint the windows when the darkness has moved a step, or when who
     * is at home has changed; not once a frame */
    const step = Math.round(dark * WINDOW_STEPS);
    if (step !== windowStep || occupancyDirty) {
      windowStep = step;
      occupancyDirty = false;
      paintWindows(step / WINDOW_STEPS);
    }
    /* people do not become part of the scenery after dark: the same small
     * warm emissive keeps an outside figure legible at night */
    bodyMat.emissiveIntensity = 0.1 + dark * 0.42;
    headMat.emissiveIntensity = 0.06 + dark * 0.34;
    lampBulbMat.emissiveIntensity = 0.05 + dark * 2.6;
    shopSignMat.emissiveIntensity = 0.1 + dark * 1.8;
    glowMat.opacity = dark * 1.1;
    glow.visible = glowCount > 0 && dark > 0.02;

    updateResidents(now);
    updateWeather(dt, now);
    controls.update();
    renderer.render(scene, camera);

    /* the five names are equal fifths of the same clock the light reads;
     * Clock.phaseAt is where that fact lives. */
    const info = Clock.phaseAt(f);
    phaseInfo.phase = info.phase;
    phaseInfo.index = info.index;
    phaseInfo.name = info.name;
    phaseInfo.darkness = dark;
    phaseInfo.dayFrac = f;
    return phaseInfo;
  }

  /* -------------------------------------------------------------- pick */

  /* `withGround` is the click's privilege: a hover asks only what is on
   * top of the ground, while a click may also name the cell that was hit.
   * Raycasting every tile on every pointer move would be wasted work. */
  function pick(clientX, clientY, rect, withGround) {
    if (!clock.haveState) return null;
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    /* Whatever is nearest is what was clicked. A fixture standing in front
     * of a block must win over the block behind it, so the three pickable
     * layers are compared by distance rather than checked in an order. */
    let best = null;
    if (bodyMesh) {
      /* the head is a person too: without it a click on the most visible
       * part of a figure fell through to whatever stood behind */
      const hits = raycaster.intersectObjects([bodyMesh, headMesh], false);
      if (hits.length) {
        const p = personAt[hits[0].instanceId];
        if (p) best = { d: hits[0].distance,
                        hit: { kind: 'resident', person: p } };
      }
    }
    const bh = raycaster.intersectObjects(buildingBodies, false);
    if (bh.length && (!best || bh[0].distance < best.d)) {
      const id = bh[0].object.userData.pick.id;
      best = { d: bh[0].distance,
               hit: { kind: 'building', id, building: buildingById[id] } };
    }
    /* a fixture's own group carries the id; the ray lands on a mesh inside
     * it, so walk back up to the group that owns the pick */
    const fh = raycaster.intersectObjects(fixtureGroup.children, true);
    if (fh.length) {
      let o = fh[0].object;
      while (o && !o.userData.pick) o = o.parent;
      const mark = o && o.userData.pick;
      if (mark && (!best || fh[0].distance < best.d)) {
        best = { d: fh[0].distance,
                 hit: { kind: 'fixture', id: mark.id,
                        fixture: fixtureById[mark.id] ||
                                 { id: mark.id, kind: 'a place' } } };
      }
    }
    if (best) return best.hit;
    /* the ground itself: an instanced tile knows its own cell, so a click
     * on a lawn or the water can say which one it was */
    if (withGround) {
      const th = raycaster.intersectObject(tiles, false);
      if (th.length && th[0].instanceId !== undefined) {
        const i = th[0].instanceId;
        const x = i % W, y = (i - x) / W;
        return { kind: 'cell', x, y,
                 cell: { x, y, site: ground.codes[ground.rows[y][x]] } };
      }
    }
    return null;
  }

  /* ------------------------------------------------------------- resize */

  function resize() {
    const w = canvas.clientWidth || window.innerWidth || 1;
    const h = canvas.clientHeight || window.innerHeight || 1;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function stateSummary() {
    /* Who is outdoors, who is between cells (the page glides them, so a
     * changed cell is a person visibly walking this tick), and who is out
     * on the estate's edge. `outside` is everyone not in a flat; the two
     * narrower counts are the ones a screenshot of the perimeter is about. */
    let outside = 0, walking = 0, onPerimeter = 0;
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      if (p.in) continue;
      outside++;
      if ((p.px != null && p.x !== p.px) ||
          (p.py != null && p.y !== p.py)) walking++;
      if (perimeterCells.has(p.x + ',' + p.y)) onPerimeter++;
    }
    return { residents: people.length,
             buildings: (ground.buildings || []).length,
             benches: benchCount, seated: seatedCount,
             outside, walking, perimeter: onPerimeter };
  }

  /* --------------------------------------------------------------- focus */

  /* A close camera on one spot, for a screenshot that can be read. The
   * offset is longer than `controls.minDistance`, so the controls do not
   * pull the camera back out again the moment it is placed. */
  function focusAt(x, y, z) {
    controls.target.set(x, y, z);
    camera.position.set(x + 5.2, y + 5.4, z + 5.4);
    controls.update();
  }

  /* Is the ground clear for six cells in this direction? A camera put too
   * close behind a bench stands inside the block the bench is against. */
  function clearAhead(b, fx, fz) {
    for (let d = 1; d <= 6; d++) {
      const x = b.cx + fx * d, y = b.cy + fz * d;
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      if (ground.codes[ground.rows[y][x]] === 'building') return false;
    }
    return true;
  }

  /* A bench is framed from the side it faces. That side is the path, which
   * is open ground by definition; the courtyard's own benches have no path,
   * so they take the first open side instead. */
  function focusBenchAt(b) {
    let { fx, fz } = b;
    if (!clearAhead(b, fx, fz)) {
      [fx, fz] = [[0, 1], [0, -1], [1, 0], [-1, 0]]
        .filter(d => d[0] !== b.fx || d[1] !== b.fz)
        .find(d => clearAhead(b, d[0], d[1])) || [fx, fz];
    }
    const y = TILE_TOP + 0.9;
    controls.target.set(b.x, y, b.z);
    camera.position.set(b.x + fx * 5.7, y + 5.7, b.z + fz * 5.7);
    controls.update();
  }

  /* The busiest occupied bench, so `?focus=bench` lands on people rather
   * than on an empty seat; any bench if the estate is indoors. */
  function focusBench() {
    const keys = Object.keys(benchByCell).sort();
    if (!keys.length) return false;
    const counts = {};
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      if (p.in) continue;
      const k = p.x + ',' + p.y;
      if (benchByCell[k]) counts[k] = (counts[k] || 0) + 1;
    }
    let best = keys[0], bestN = -1;
    keys.forEach(k => {
      const n = counts[k] || 0;
      if (n > bestN) { bestN = n; best = k; }
    });
    focusBenchAt(benchByCell[best]);
    return true;
  }

  function focusCell(x, y) {
    focusAt(x + 0.5, TILE_TOP + 0.6, y + 0.5);
    return true;
  }

  /* A stretch of the outer path, framed from the road side. The busiest
   * perimeter bench is the target (any perimeter bench if nobody is out),
   * and the camera stands further back on the bench's outward side, off to
   * one side along the path, so the shot holds the path and its
   * neighbouring seats rather than a block's roof. The bench faces the
   * estate, so this view is over its shoulder; the road side is the one
   * side with no building between the camera and the seat. */
  function focusPerimeter() {
    const keys = Object.keys(benchByCell)
      .filter(k => benchByCell[k].perimeter).sort();
    if (!keys.length) return false;
    const counts = {};
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      if (p.in) continue;
      const k = p.x + ',' + p.y;
      if (benchByCell[k] && benchByCell[k].perimeter) {
        counts[k] = (counts[k] || 0) + 1;
      }
    }
    let best = keys[0], bestN = -1;
    keys.forEach(k => {
      const n = counts[k] || 0;
      if (n > bestN) { bestN = n; best = k; }
    });
    const b = benchByCell[best];
    const { fx, fz } = b;
    const sx = fz, sz = -fx;          // along the path, across the view
    const ox = -fx, oz = -fz;         // away from the estate, to the road
    const y = TILE_TOP + 0.9;
    controls.target.set(b.x + sx * 2.0, y, b.z + sz * 2.0);
    camera.position.set(b.x + ox * 6.0 + sx * 3.0,
                        y + 6.2,
                        b.z + oz * 6.0 + sz * 3.0);
    controls.update();
    return true;
  }

  /* Which of today's phases the page is showing (-1: the live frame). The
   * light follows it unless the page pinned an hour of its own; the
   * frame itself is the caller's (hud.js `phaseView`). */
  function setPhaseView(i) {
    clock.forcedPhase = i >= 0 ? i : forcedPhase;
  }

  /* What the route machinery is doing, for the page's debug hook: how many
   * walks are in flight, the longest one's waypoints, and how many positions
   * ever had to fall back to a straight line. */
  function routeStats() {
    const now = performance.now();
    let active = 0;
    for (let i = 0; i < people.length; i++) {
      const r = routes[i];
      if (r && r.total > 1e-6 && now - routeT0[i] < routeDur[i]) active++;
    }
    return { active, maxWaypoints: routeMaxPoints,
             fallbacks: routeFallbacks };
  }

  return {
    scene, camera, renderer, controls,
    setState, frame, resize, pick, stateSummary, focusBench, focusPerimeter,
    focusCell, routeStats, setPhaseView,
    phaseIndex: () => phaseInfo.index,
    phaseName: () => phaseInfo.name,
    dayFraction: () => phaseInfo.dayFrac,
    hasState: () => clock.haveState,
    staticMode,
  };
}
