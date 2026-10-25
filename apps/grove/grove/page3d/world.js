/* world — the grove in three dimensions.
 *
 * The forest floor is a real surface: the engine's elevation lifts it,
 * the water lies in its hollows, and the season colours it. Trees stand
 * on it, creatures walk across it round the trunks and the water (the
 * shared router, on the quartered grid `forest.js` builds), and at night
 * the mushrooms' glow lies on it as a soft pool of light rather than a
 * dot per cap.
 *
 * Nothing here is decided. The cells, the plants, the creatures and where
 * they were last week all arrive in the frame; this file gives them a
 * body. The light is the shared day clock (`clock.js`): a day of the
 * page's lasts a handful of weeks of the grove's, and the sun crosses the
 * sky continuously rather than stepping when a week turns.
 *
 * Everything that varies from tree to tree (a lean, a shade, which way a
 * fern faces) is hashed from the thing's id, so the same grove is drawn
 * the same way on every load. The rain and the snow are the only things
 * drawn at random, and they are weather, not the world.
 */

import * as THREE from 'three';
import { OrbitControls } from '/3d/vendor/OrbitControls.js';

const G = typeof globalThis !== 'undefined' ? globalThis : {};
const Walk = G.Page3DWalk || null;
const Clock = G.Page3DClock || null;
const Field = G.Page3DField || null;
const Forest = G.GroveForest || null;
const Glow = G.GroveGlow || null;
const SUB = (Forest && Forest.SUB) || 2;

/* the floor: a cell is a world unit; the engine's elevation is lifted by
 * ELEV, the water's bed sunk below its surface */
const ELEV = 1.1;
const LAND_MIN = 0.06;
const WATER_Y = 0.0;
const WATER_BED = -0.34;
const MARGIN = 10;            // cells of wild forest floor beyond the grove
const SEG = 2;                // ground vertices per cell, each way

const STAGE_SCALE = { sapling: 0.45, mature: 0.85, old: 1.0 };
const DEFAULT_SHAPES = { pine: 'pine', birch: 'deciduous',
                         willow: 'weeping', fern: 'fronds', berry: 'bush' };
const KIND_SHAPE = { tree: 'deciduous', shrub: 'bush',
                     understory: 'fronds' };
/* dark bark against the grass (Iris): birch stays pale, the willow's is a
 * grey-brown, everything else a deep brown */
const TRUNK = { birch: 0xd9d4c9, willow: 0x5e5044 };
const TRUNK_DEFAULT = 0x4a3626;
/* a trunk's foot stays inside the quarter the router keeps for it
 * (forest.js TRUNK_KEEP): radius ≤ 0.125 of a cell, the geometry's foot
 * being half its width */
const TRUNK_W_MAX = 0.25;
/* each tree's leaves differ a little in hue and value from its
 * neighbours', so the layers separate (Iris: ±8° hue, ±6% lightness) */
const LEAF_HUE = 8 / 360;
const LEAF_LIGHT = 0.06;
/* the silhouette's own tints, leaned into the season's palette */
const BIRCH_LEAF = 0x8fae55;
const WILLOW_LEAF = 0xa9b865;
/* the darkest a bush may be: below this they read as litter (Iris) */
const BUSH_FLOOR = 0x3d4a2c;
/* the water: a creek runs lighter than a pond, which lies still and dark */
const CREEK_TINT = 0x6f9fae;
const BANK_HEX = 0x8b7b5a;     // the mud and sand at the water's edge
const FORD_HEX = 0x948b7c;     // the pebbles of a ford
const PATH_HEX = 0x7d6a4f;     // a trodden path
const FLOW_SPEED = 0.18;       // texture lengths a second, down the creek
/* trees between the camera and what it watches are drawn as ghosts */
const GHOST_OPACITY = 0.16;
const FADE_EVERY = 120;        // ms between looks for trees in the way
const FADE_NEAR = 3;           // cells round the view's centre that count
const FADE_MAX = 6;            // creatures round the centre that count
const SEASON_NAMES = ['spring', 'summer', 'autumn', 'winter'];
const GLOW_HEX = 0x9ff5d0;    // the mushrooms' pale mint light
const BODY_DEFAULT = 0x8c7a66;

/* the weather greys the sky: the estate's own table */
const WEATHER_SKY = {
  rain:  { hex: 0x8c98a3, mix: 0.68, sun: 0.72 },
  storm: { hex: 0x6d7883, mix: 0.8, sun: 0.55 },
  frost: { hex: 0xd7e2ea, mix: 0.45, sun: 0.85 },
};
const SUN_MIN_Y = 12;

function h01(id, salt) {
  return Forest.hash(id, salt) / 4294967295;
}

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const _c3 = new THREE.Color();
const _c4 = new THREE.Color();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function colourOf(hex, fallback) {
  try {
    if (hex === null || hex === undefined || hex === '') {
      return new THREE.Color(fallback);
    }
    return new THREE.Color(String(hex));
  } catch (e) {
    return new THREE.Color(fallback);
  }
}

/* ------------------------------------------------------------- batches */

/* An instanced mesh that grows (forest.js `batch`, where the tests can
 * reach it with a stub THREE): past its capacity mid-build it doubles and
 * keeps what it has. */
function makeBatch(scene, geo, mat, cap, opts) {
  return Forest.batch(THREE, scene, geo, mat, cap, opts);
}

function place(x, y, z, sx, sy, sz, yaw, out) {
  _e.set(0, yaw || 0, 0);
  _q.setFromEuler(_e);
  _v.set(x, y, z);
  _s.set(sx, sy, sz);
  return (out || _m).compose(_v, _q, _s);
}

/* ------------------------------------------------------------ creatures */

/* A creature is a handful of boxes and balls, in its own frame: +x is
 * forward, y up, sizes in world units. `c` names the colour: the body's,
 * a darker or paler shade of it, or a fixed one. An optional ninth field
 * tips the part about z (the deer's neck, at 45°). */
const PARTS = {
  rabbit: [
    ['box', 0.28, 0.18, 0.18, 0, 0.13, 0, 'body'],
    ['ball', 0.09, 0.09, 0.09, 0.16, 0.24, 0, 'body'],
    ['box', 0.03, 0.15, 0.045, 0.14, 0.37, 0.045, 'body'],
    ['box', 0.03, 0.15, 0.045, 0.14, 0.37, -0.045, 'body'],
    ['ball', 0.045, 0.045, 0.045, -0.16, 0.16, 0, 'pale'],
  ],
  deer: [
    ['box', 0.66, 0.3, 0.24, 0, 0.62, 0, 'body'],
    ['box', 0.042, 0.48, 0.042, 0.25, 0.24, 0.08, 'dark'],
    ['box', 0.042, 0.48, 0.042, 0.25, 0.24, -0.08, 'dark'],
    ['box', 0.042, 0.48, 0.042, -0.25, 0.24, 0.08, 'dark'],
    ['box', 0.042, 0.48, 0.042, -0.25, 0.24, -0.08, 'dark'],
    ['box', 0.1, 0.34, 0.09, 0.36, 0.86, 0, 'body', -Math.PI / 4],
    ['box', 0.22, 0.12, 0.11, 0.5, 1.0, 0, 'body'],
    ['box', 0.04, 0.1, 0.03, 0.44, 1.1, 0.05, 'dark'],
    ['box', 0.04, 0.1, 0.03, 0.44, 1.1, -0.05, 'dark'],
    ['box', 0.06, 0.08, 0.06, -0.35, 0.72, 0, 'pale'],
  ],
  fox: [
    ['box', 0.46, 0.18, 0.16, 0, 0.3, 0, 'body'],
    ['box', 0.05, 0.22, 0.05, 0.17, 0.11, 0.05, 'dark'],
    ['box', 0.05, 0.22, 0.05, 0.17, 0.11, -0.05, 'dark'],
    ['box', 0.05, 0.22, 0.05, -0.17, 0.11, 0.05, 'dark'],
    ['box', 0.05, 0.22, 0.05, -0.17, 0.11, -0.05, 'dark'],
    ['box', 0.17, 0.14, 0.14, 0.28, 0.38, 0, 'body'],
    ['box', 0.1, 0.06, 0.07, 0.4, 0.35, 0, 'pale'],
    ['box', 0.04, 0.08, 0.04, 0.26, 0.48, 0.04, 'dark'],
    ['box', 0.04, 0.08, 0.04, 0.26, 0.48, -0.04, 'dark'],
    ['box', 0.37, 0.08, 0.08, -0.41, 0.31, 0, 'body'],
    ['ball', 0.055, 0.05, 0.05, -0.6, 0.31, 0, 'white'],
  ],
  boar: [
    ['box', 0.6, 0.32, 0.3, 0, 0.32, 0, 'body'],
    ['box', 0.07, 0.17, 0.07, 0.2, 0.08, 0.1, 'dark'],
    ['box', 0.07, 0.17, 0.07, 0.2, 0.08, -0.1, 'dark'],
    ['box', 0.07, 0.17, 0.07, -0.2, 0.08, 0.1, 'dark'],
    ['box', 0.07, 0.17, 0.07, -0.2, 0.08, -0.1, 'dark'],
    ['box', 0.22, 0.22, 0.22, 0.36, 0.32, 0, 'body'],
    ['box', 0.08, 0.09, 0.11, 0.5, 0.27, 0, 'pale'],
    ['box', 0.03, 0.06, 0.02, 0.5, 0.33, 0.07, 'horn'],
    ['box', 0.03, 0.06, 0.02, 0.5, 0.33, -0.07, 'horn'],
    ['box', 0.06, 0.12, 0.04, -0.32, 0.38, 0, 'dark'],
  ],
  owl: [
    ['box', 0.2, 0.3, 0.2, 0, 0.2, 0, 'body'],
    ['box', 0.19, 0.15, 0.18, 0.01, 0.42, 0, 'body'],
    ['box', 0.03, 0.06, 0.03, 0.02, 0.52, 0.06, 'dark'],
    ['box', 0.03, 0.06, 0.03, 0.02, 0.52, -0.06, 'dark'],
    ['ball', 0.03, 0.03, 0.03, 0.1, 0.44, 0.045, 'eye'],
    ['ball', 0.03, 0.03, 0.03, 0.1, 0.44, -0.045, 'eye'],
    ['wing', 0.16, 0.03, 0.2, 0, 0.26, 0.13, 'dark'],
    ['wing', 0.16, 0.03, 0.2, 0, 0.26, -0.13, 'dark'],
  ],
  robin: [
    ['box', 0.16, 0.12, 0.11, 0, 0.1, 0, 'body'],
    ['ball', 0.065, 0.065, 0.065, 0.09, 0.18, 0, 'body'],
    ['ball', 0.06, 0.06, 0.055, 0.06, 0.09, 0, 'red'],
    ['box', 0.1, 0.02, 0.06, -0.12, 0.13, 0, 'dark'],
    ['wing', 0.1, 0.02, 0.14, 0, 0.13, 0.08, 'dark'],
    ['wing', 0.1, 0.02, 0.14, 0, 0.13, -0.08, 'dark'],
  ],
  tortoise: [
    ['ball', 0.26, 0.14, 0.22, 0, 0.12, 0, 'body'],
    ['ball', 0.07, 0.06, 0.06, 0.27, 0.1, 0, 'pale'],
    ['box', 0.07, 0.08, 0.07, 0.14, 0.04, 0.13, 'pale'],
    ['box', 0.07, 0.08, 0.07, 0.14, 0.04, -0.13, 'pale'],
    ['box', 0.07, 0.08, 0.07, -0.14, 0.04, 0.13, 'pale'],
    ['box', 0.07, 0.08, 0.07, -0.14, 0.04, -0.13, 'pale'],
  ],
};
const FIXED = {
  white: 0xf3efe6, red: 0xc8502e, horn: 0xeee3c8, eye: 0xf0c040,
};

export function createWorld(first, canvas, opts) {
  opts = opts || {};
  if (!Clock) throw new Error('the day clock (clock.js) did not load');
  if (!Field) throw new Error('the light field (field.js) did not load');
  if (!Forest) throw new Error('the forest (forest.js) did not load');
  if (!Glow) throw new Error('the mushroom light (glow.js) did not load');
  const staticMode = !!opts.staticMode;
  const clock = Clock.makeClock({ clockPin: opts.clockFrac,
                                  forcedPhase: opts.forcedPhase });
  const N = Number(first.size) | 0;
  const centre = new THREE.Vector3(N / 2, 0.4, N / 2);
  let st0 = first;          // the frame the static ground was built from

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

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(Clock.LIGHT[3].sky);
  /* the fog starts at three quarters of the grove's size and is whole by
   * 2.2, so the floor's apron has gone into the sky before it reaches the
   * frame's corners — no hard world edge; its colour is
   * the sky's, leaned a little toward the ground by day (updateSky) */
  scene.fog = new THREE.Fog(Clock.LIGHT[3].sky, N * 0.75, N * 2.2);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 300);
  camera.position.set(centre.x + N * 0.55, N * 0.72, centre.z + N * 0.95);
  if (opts.topView) camera.position.set(centre.x, N * 1.5, centre.z + 0.01);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(centre);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 3;
  controls.maxDistance = N * 3.2;
  controls.minPolarAngle = 0.08;
  controls.maxPolarAngle = Math.PI / 2 - 0.06;
  controls.listenToKeyEvents(window);
  controls.update();

  /* -------------------------------------------------------------- lights */

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.7);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const span = N * 0.75 + 4;
  sun.shadow.camera.left = -span;
  sun.shadow.camera.right = span;
  sun.shadow.camera.top = span;
  sun.shadow.camera.bottom = -span;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 140;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);
  sun.target.position.copy(centre);

  /* ------------------------------------------------------------- the floor */

  /* The height of a cell's centre: the engine's elevation for land, the
   * bed for water. Between centres the floor is bilinear, so a bank slopes
   * into the water and a ridge is a ridge, not a staircase. */
  const cellH = new Float32Array(N * N);
  const isWater = new Uint8Array(N * N);
  /* which water (the snapshot's seventh field): 1 creek, 2 pond (and any
   * water a world from before creeks has), 3 a ford across, 0 dry land */
  const waterKind = new Uint8Array(N * N);
  function readCells(st) {
    for (let i = 0; i < N * N; i++) {
      const c = st.cells[i] || ['s', 0, 0, 0, 0, 0];
      isWater[i] = c[0] === 'w' ? 1 : 0;
      waterKind[i] = c[6] === 'c' ? 1 : c[6] === 'f' ? 3
        : isWater[i] ? 2 : 0;
      cellH[i] = isWater[i] ? WATER_BED
        : Math.max(LAND_MIN, 0.12 + (Number(c[5]) || 0) * ELEV);
    }
  }
  readCells(first);

  function hAt(cx, cy) {
    const x = cx < 0 ? 0 : cx >= N ? N - 1 : cx;
    const y = cy < 0 ? 0 : cy >= N ? N - 1 : cy;
    return cellH[y * N + x];
  }
  /* beyond the grove the floor settles to a low, even wildwood */
  function edgeFade(x, z) {
    const dx = Math.max(0, -x, x - N), dz = Math.max(0, -z, z - N);
    return Math.min(1, Math.hypot(dx, dz) / 4);
  }
  function heightAt(x, z) {
    const u = x - 0.5, v = z - 0.5;
    const x0 = Math.floor(u), z0 = Math.floor(v);
    const fx = u - x0, fz = v - z0;
    const a = hAt(x0, z0), b = hAt(x0 + 1, z0);
    const c = hAt(x0, z0 + 1), d = hAt(x0 + 1, z0 + 1);
    let h = (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
    const e = edgeFade(x, z);
    if (e > 0) h = h * (1 - e) + 0.12 * e;
    return h;
  }

  const GW = N + MARGIN * 2;           // the floor's span, in cells
  const VN = GW * SEG + 1;             // vertices along a side
  const groundGeo = new THREE.BufferGeometry();
  const gPos = new Float32Array(VN * VN * 3);
  const gCol = new Float32Array(VN * VN * 3);
  const gUv = new Float32Array(VN * VN * 2);
  for (let j = 0; j < VN; j++) {
    for (let i = 0; i < VN; i++) {
      const k = j * VN + i;
      const x = -MARGIN + i / SEG, z = -MARGIN + j / SEG;
      gPos[k * 3] = x;
      gPos[k * 3 + 1] = heightAt(x, z);
      gPos[k * 3 + 2] = z;
      gUv[k * 2] = (x + MARGIN) / GW;
      gUv[k * 2 + 1] = 1 - (z + MARGIN) / GW;
    }
  }
  const gIdx = [];
  for (let j = 0; j < VN - 1; j++) {
    for (let i = 0; i < VN - 1; i++) {
      const a = j * VN + i, b = a + 1, c = a + VN, d = c + 1;
      gIdx.push(a, c, b, b, c, d);
    }
  }
  groundGeo.setIndex(gIdx);
  groundGeo.setAttribute('position', new THREE.BufferAttribute(gPos, 3));
  groundGeo.setAttribute('color', new THREE.BufferAttribute(gCol, 3));
  groundGeo.setAttribute('uv', new THREE.BufferAttribute(gUv, 2));
  groundGeo.computeVertexNormals();
  const groundMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.96, metalness: 0 });
  const groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);

  /* a floor under the floor, out to the fog, so the world has no edge —
   * with the map cut out of it, so it never lies over the water, which
   * sits below it */
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x2c3a24,
                                                    roughness: 1 });
  const baseShape = new THREE.Shape();
  const BR = GW * 3, HR = GW / 2 - 0.5;
  baseShape.moveTo(-BR, -BR); baseShape.lineTo(BR, -BR);
  baseShape.lineTo(BR, BR); baseShape.lineTo(-BR, BR); baseShape.closePath();
  const baseHole = new THREE.Path();
  baseHole.moveTo(-HR, -HR); baseHole.lineTo(-HR, HR);
  baseHole.lineTo(HR, HR); baseHole.lineTo(HR, -HR); baseHole.closePath();
  baseShape.holes.push(baseHole);
  const base = new THREE.Mesh(new THREE.ShapeGeometry(baseShape), baseMat);
  base.rotation.x = -Math.PI / 2;
  base.position.set(N / 2, 0.1, N / 2);
  base.receiveShadow = true;
  scene.add(base);

  /* The water: a sheet per water cell, at one level. A pond lies still,
   * dark and glossy; a creek is lighter and runs — its sheets carry a
   * ripple texture turned down the creek (the snapshot's `creeks`, each
   * from source to mouth) that scrolls every frame; over a ford the creek
   * runs thin and clear across the stones. Terrain does not change in a
   * world's life, so this is built once, from the first frame. */
  const flowDir = new Float32Array(N * N * 2);
  (first.creeks || []).forEach(path => {
    for (let k = 0; k < path.length; k++) {
      const a = path[Math.max(0, k - 1)], b = path[Math.min(path.length - 1, k + 1)];
      const x = path[k][0], y = path[k][1];
      if (!(x >= 0 && y >= 0 && x < N && y < N)) continue;
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      flowDir[(y * N + x) * 2] = dx / l;
      flowDir[(y * N + x) * 2 + 1] = dz / l;
    }
  });
  function rippleTexture() {
    if (typeof document === 'undefined') return null;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#c8d8dc';
    g.fillRect(0, 0, 64, 64);
    /* light streaks along the flow (v), hashed so every page draws them
     * alike */
    for (let k = 0; k < 26; k++) {
      const x = h01(k, 300) * 64, y = h01(k, 301) * 64;
      const len = 10 + h01(k, 302) * 22, w = 1 + h01(k, 303) * 2.5;
      g.fillStyle = 'rgba(255,255,255,' + (0.25 + h01(k, 304) * 0.5) + ')';
      for (const ox of [-64, 0, 64]) {
        for (const oy of [-64, 0, 64]) g.fillRect(x + ox, y + oy, w, len);
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  const flowTex = rippleTexture();
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x2a4d66, roughness: 0.05, metalness: 0.3, transparent: true,
    opacity: 0.9 });
  const creekMat = new THREE.MeshStandardMaterial({
    color: CREEK_TINT, roughness: 0.18, metalness: 0.1, transparent: true,
    opacity: 0.84, map: flowTex });
  const fordMat = new THREE.MeshStandardMaterial({
    color: CREEK_TINT, roughness: 0.2, metalness: 0.05, transparent: true,
    opacity: 0.42, map: flowTex, depthWrite: false });
  const waterGeo = new THREE.PlaneGeometry(1.02, 1.02);
  waterGeo.rotateX(-Math.PI / 2);
  function waterSheet(mat, kind, lift) {
    let count = 0;
    for (let i = 0; i < N * N; i++) if (waterKind[i] === kind) count++;
    const mesh = new THREE.InstancedMesh(waterGeo, mat, Math.max(1, count));
    mesh.receiveShadow = true;
    let n = 0;
    for (let i = 0; i < N * N; i++) {
      if (waterKind[i] !== kind) continue;
      const x = i % N, y = (i - x) / N;
      const dx = flowDir[i * 2], dz = flowDir[i * 2 + 1];
      /* the sheet's -z (the texture's +v) turned down the creek */
      const yaw = dx || dz ? Math.atan2(-dx, -dz) : 0;
      const y0 = lift ? heightAt(x + 0.5, y + 0.5) + lift : WATER_Y;
      mesh.setMatrixAt(n++, place(x + 0.5, y0, y + 0.5, 1, 1, 1, yaw));
    }
    mesh.count = n;
    scene.add(mesh);
    return mesh;
  }
  const water = waterSheet(waterMat, 2, 0);
  const creek = waterSheet(creekMat, 1, 0);
  const ford = waterSheet(fordMat, 3, 0.035);

  /* rocks: a few stones on every rock cell, where they always were */
  const stoneGeo = new THREE.IcosahedronGeometry(1, 0);
  const stoneMat = new THREE.MeshStandardMaterial({ roughness: 0.9,
                                                     flatShading: true });
  const stones = makeBatch(scene, stoneGeo, stoneMat, 64, { receive: true });

  /* ---------------------------------------------------------- the season */

  /* The pack's palette for the season, blended with the last season's over
   * its first two weeks — the first leaves of spring arrive in the air of
   * winter, as they did in the plan view. */
  const PAL_KEYS = ['grass', 'soil', 'water', 'rock', 'pine', 'leaf',
                    'under', 'bush', 'fruit'];
  const pal = {};
  PAL_KEYS.forEach(k => { pal[k] = new THREE.Color(); });
  pal.canopyDim = 1;
  function readPalette(st) {
    const seasons = (st.biome && st.biome.seasons) || {};
    const cur = seasons[st.season] || seasons.spring || {};
    let prev = cur, m = 1;
    const tick = Number(st.tick) || 0;
    const weekIn = tick ? ((tick - 1) % 12) + 1 : 12;
    if (weekIn <= 2) {
      const i = SEASON_NAMES.indexOf(st.season);
      prev = seasons[SEASON_NAMES[(i + 3) % 4]] || cur;
      m = weekIn / 3;
    }
    PAL_KEYS.forEach(k => {
      _c1.copy(colourOf(prev[k], 0x667755));
      _c2.copy(colourOf(cur[k], 0x667755));
      pal[k].copy(_c1).lerp(_c2, m);
    });
    const a = Number(prev.canopyDim), b = Number(cur.canopyDim);
    pal.canopyDim = (isFinite(a) ? a : 1) * (1 - m) + (isFinite(b) ? b : 1) * m;
  }

  /* the floor's colour per cell: soil greening with its grass, rock grey,
   * the water's bed a dark mix of mud and water */
  const cellCol = new Float32Array(N * N * 3);
  const wild = new THREE.Color();
  const bankCol = new THREE.Color(BANK_HEX);
  const fordCol = new THREE.Color(FORD_HEX);
  const pathCol = new THREE.Color(PATH_HEX);
  function paintFloor(st) {
    const Z = Forest.drawn(st).zones;
    for (let i = 0; i < N * N; i++) {
      const c = st.cells[i] || ['s', 0];
      const x = i % N, y = (i - x) / N, key = x + ',' + y;
      if (c[0] === 'w') {
        _c1.copy(pal.soil).lerp(pal.water, 0.5).multiplyScalar(0.7);
      } else if (c[0] === 'r') {
        _c1.copy(pal.rock).lerp(pal.soil, 0.15);
      } else {
        const g = Math.max(0, Math.min(1, (Number(c[1]) || 0) / 0.8));
        _c1.copy(pal.soil).lerp(pal.grass, 0.25 + 0.75 * g);
        /* a glade is a little greener, a path is trodden earth, the bank
         * goes to mud and sand, a ford to pebbles */
        if (Z.clear[key]) _c1.lerp(pal.grass, 0.3);
        if (Z.path[key]) _c1.lerp(pathCol, 0.45);
        if (Z.bank[key]) _c1.lerp(bankCol, 0.38);
        if (c[6] === 'f') _c1.copy(fordCol);
      }
      cellCol[i * 3] = _c1.r; cellCol[i * 3 + 1] = _c1.g;
      cellCol[i * 3 + 2] = _c1.b;
    }
    wild.copy(pal.soil).lerp(pal.grass, 0.55).multiplyScalar(0.8);
    baseMat.color.copy(wild).multiplyScalar(0.85);
    const ch = (cx, cy, o) => {
      const x = cx < 0 ? 0 : cx >= N ? N - 1 : cx;
      const y = cy < 0 ? 0 : cy >= N ? N - 1 : cy;
      return cellCol[(y * N + x) * 3 + o];
    };
    for (let k = 0; k < VN * VN; k++) {
      const x = gPos[k * 3], z = gPos[k * 3 + 2];
      const u = x - 0.5, v = z - 0.5;
      const x0 = Math.floor(u), z0 = Math.floor(v);
      const fx = u - x0, fz = v - z0;
      const e = edgeFade(x, z);
      for (let o = 0; o < 3; o++) {
        let val = (ch(x0, z0, o) * (1 - fx) + ch(x0 + 1, z0, o) * fx) *
          (1 - fz) + (ch(x0, z0 + 1, o) * (1 - fx) +
          ch(x0 + 1, z0 + 1, o) * fx) * fz;
        const w = o === 0 ? wild.r : o === 1 ? wild.g : wild.b;
        gCol[k * 3 + o] = val * (1 - e) + w * e;
      }
    }
    groundGeo.attributes.color.needsUpdate = true;
    waterMat.color.copy(pal.water).multiplyScalar(0.85);
    creekMat.color.copy(pal.water).lerp(_c1.setHex(CREEK_TINT), 0.55);
    fordMat.color.copy(creekMat.color).lerp(_c1.setHex(0xffffff), 0.2);

    stones.begin(N * 3 + 64);
    for (let i = 0; i < N * N; i++) {
      if (!st.cells[i]) continue;
      if (st.cells[i][6] === 'f') {
        /* stepping stones across the ford, square to the creek */
        const x = i % N, y = (i - x) / N;
        const along = (x > 0 && isWater[i - 1]) || (x < N - 1 && isWater[i + 1]);
        for (let s = 0; s < 4; s++) {
          const u = 0.14 + s * 0.24, v = 0.38 + h01(i, 110 + s) * 0.24;
          const px = x + (along ? v : u), pz = y + (along ? u : v);
          const r = 0.09 + h01(i, 120 + s) * 0.05;
          _c1.copy(pal.rock).multiplyScalar(0.95 + h01(i, 130 + s) * 0.3);
          stones.add(place(px, heightAt(px, pz) + r * 0.25, pz,
                           r * 1.2, r * 0.45, r, h01(i, 140 + s) * 6.28),
                     _c1, null);
        }
        continue;
      }
      if (st.cells[i][0] !== 'r') continue;
      const x = i % N, y = (i - x) / N;
      for (let s = 0; s < 3; s++) {
        const r = 0.12 + h01(i, 40 + s) * 0.2;
        const px = x + 0.2 + h01(i, 50 + s) * 0.6;
        const pz = y + 0.2 + h01(i, 60 + s) * 0.6;
        _c1.copy(pal.rock).multiplyScalar(0.85 + h01(i, 70 + s) * 0.3);
        stones.add(place(px, heightAt(px, pz) + r * 0.35, pz,
                         r, r * 0.7, r * 1.1, h01(i, 80 + s) * 6.28),
                   _c1, null);
      }
    }
    stones.end();
  }

  /* --------------------------------------------------------- the glow */

  /* The mushrooms' light: the server's field (0..9 a cell, the same shape
   * as the estate's lamplight) painted by the shared `field.js` into a
   * canvas that covers the whole floor, and laid on the floor as a second
   * skin — the floor's own geometry, added to whatever is under it — so
   * the light follows every bank and hollow. `dark` scales it: it comes
   * up through the dusk and goes out through the dawn.
   *
   * Only some rings glow on a given night (glow.js): the page builds the
   * field from those rings itself, with the server's arithmetic, rather
   * than painting the server's field of every mushroom. */
  const GLOW_PX = 12;
  /* the pool's strength at full dark: enough that a lit ring reads as a
   * pool of mint light on the floor, low enough that the night around it
   * stays blue */
  const GLOW_OPACITY = 0.28;
  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = GW * GLOW_PX;
  glowCanvas.height = GW * GLOW_PX;
  const glowCells = document.createElement('canvas');
  glowCells.width = GW;
  glowCells.height = GW;
  const glowTex = new THREE.CanvasTexture(glowCanvas);
  glowTex.colorSpace = THREE.NoColorSpace;
  glowTex.minFilter = THREE.LinearFilter;
  glowTex.magFilter = THREE.LinearFilter;
  glowTex.generateMipmaps = false;
  const glowMat = new THREE.MeshBasicMaterial({
    color: GLOW_HEX, map: glowTex, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const glow = new THREE.Mesh(groundGeo, glowMat);
  glow.renderOrder = 2;
  glow.visible = false;
  scene.add(glow);
  const glowPainter = Field.makePainter(GW, GW, GLOW_PX, glowCanvas,
                                        glowCells);
  const glowWide = new Array(GW * GW).fill(0);
  let glowCount = 0;
  let litCell = new Uint8Array(N * N);
  let ringCount = 0, ringsLit = 0;
  /* the night the lit rings were chosen for: the day number, taken only
   * while it is light (or on the first frame), so the choice never changes
   * in the dark — the swap happens by day, when no ring is glowing */
  let nightKey = null;
  let dayNow = 0;
  /* the last choice, carried into the next week's rebuild while it is
   * dark: a week's growth can rekey a ring, and without the carry a ring
   * that survived the week would flip on or off mid-night */
  let glowChoice = null;
  function buildGlow(st, fresh) {
    const ch = fresh ? Glow.choose(st.cells, N, nightKey | 0)
                     : Glow.rebuild(glowChoice, st.cells, N, nightKey | 0,
                                    darkNow);
    glowChoice = ch;
    litCell = ch.litCell;
    ringCount = ch.rings.length;
    ringsLit = ch.lit.length;
    const f = Glow.field(litCell, N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        glowWide[(y + MARGIN) * GW + x + MARGIN] = Number(f[y * N + x]) || 0;
      }
    }
    const r = glowPainter.paint(glowWide);
    if (!r.changed) return;
    glowTex.needsUpdate = true;
    glowCount = r.lit;
  }

  /* ---------------------------------------------------------- the plants */

  const cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 7);
  cylGeo.translate(0, 0.5, 0);
  const trunkGeo = new THREE.CylinderGeometry(0.32, 0.5, 1, 7);
  trunkGeo.translate(0, 0.5, 0);
  const coneGeo = new THREE.ConeGeometry(0.5, 1, 8);
  coneGeo.translate(0, 0.5, 0);
  /* low-poly clusters read as leaves; detail 1 read as green jelly (Iris) */
  const crownGeo = new THREE.IcosahedronGeometry(0.5, 0);
  /* a willow's hanging strand: a thin open cone, its wide end at the top
   * (y 0), hanging a unit down to a point */
  const strandGeo = new THREE.ConeGeometry(0.5, 1, 4, 1, true);
  strandGeo.rotateX(Math.PI);
  strandGeo.translate(0, -0.5, 0);
  const padGeo = new THREE.CircleGeometry(0.5, 9);
  padGeo.rotateX(-Math.PI / 2);
  const bushGeo = new THREE.IcosahedronGeometry(0.5, 0);
  const frondGeo = new THREE.ConeGeometry(0.5, 1, 4, 1, true);
  frondGeo.translate(0, 0.5, 0);
  const ballGeo = new THREE.SphereGeometry(0.5, 8, 6);
  const capGeo = new THREE.SphereGeometry(0.5, 10, 6, 0, Math.PI * 2, 0,
                                          Math.PI / 2);
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);

  const barkMat = new THREE.MeshStandardMaterial({ roughness: 0.95 });
  const leafMat = new THREE.MeshStandardMaterial({ roughness: 0.85,
                                                    flatShading: true });
  const frondMat = new THREE.MeshStandardMaterial({
    roughness: 0.9, side: THREE.DoubleSide, flatShading: true });
  const fruitMat = new THREE.MeshStandardMaterial({ roughness: 0.5 });
  const mushMat = new THREE.MeshStandardMaterial({
    roughness: 0.6, emissive: GLOW_HEX, emissiveIntensity: 0 });
  /* the caps of a ring that is not glowing tonight: the faint day sheen,
   * fading after dark so an unlit ring reads as a pale cap, not a lamp */
  const mushDimMat = new THREE.MeshStandardMaterial({
    roughness: 0.6, emissive: GLOW_HEX, emissiveIntensity: 0.15 });
  const stemMat = new THREE.MeshStandardMaterial({ color: 0xe8e0cc,
                                                    roughness: 0.8 });

  /* the willow's strands: see-through, so the light and the water show
   * between them */
  const strandMat = new THREE.MeshStandardMaterial({
    roughness: 0.85, side: THREE.DoubleSide, flatShading: true,
    transparent: true, opacity: 0.78 });
  /* the ghosts of trees in the way of what the camera watches */
  const ghost = m => {
    const g = m.clone();
    g.transparent = true; g.opacity = GHOST_OPACITY; g.depthWrite = false;
    return g;
  };
  const B = {
    trunk: makeBatch(scene, trunkGeo, barkMat, 512),
    cone: makeBatch(scene, coneGeo, leafMat, 1024),
    crown: makeBatch(scene, crownGeo, leafMat, 512),
    strand: makeBatch(scene, strandGeo, strandMat, 512, { noShadow: true }),
    pad: makeBatch(scene, padGeo, frondMat, 64, { noShadow: true,
                                                   receive: true }),
    reed: makeBatch(scene, cylGeo, frondMat, 256, { noShadow: true }),
    frond: makeBatch(scene, frondGeo, frondMat, 1024, { noShadow: true }),
    bush: makeBatch(scene, bushGeo, leafMat, 256),
    fruit: makeBatch(scene, ballGeo, fruitMat, 512, { noShadow: true }),
    arm: makeBatch(scene, cylGeo, leafMat, 256),
    log: makeBatch(scene, cylGeo, barkMat, 64),
    stem: makeBatch(scene, cylGeo, stemMat, 256, { noShadow: true }),
    cap: makeBatch(scene, capGeo, mushDimMat, 256, { noShadow: true }),
    capLit: makeBatch(scene, capGeo, mushMat, 256, { noShadow: true }),
    mound: makeBatch(scene, ballGeo, barkMat, 32),
  };
  /* ghost twins: drawn see-through, never picked, cast no shadow change */
  const GH = {
    trunk: makeBatch(scene, trunkGeo, ghost(barkMat), 32, { noShadow: true }),
    cone: makeBatch(scene, coneGeo, ghost(leafMat), 64, { noShadow: true }),
    crown: makeBatch(scene, crownGeo, ghost(leafMat), 64, { noShadow: true }),
    strand: makeBatch(scene, strandGeo, ghost(strandMat), 64,
                      { noShadow: true }),
  };
  const GHOSTED = ['trunk', 'cone', 'crown', 'strand'];
  /* what a click on each batch means: a plant by id, or nothing */
  const PLANT_PICK = ['trunk', 'cone', 'crown', 'strand', 'frond', 'bush',
                      'arm', 'log'];

  let shapes = DEFAULT_SHAPES;
  let trunkAt = {};
  let plantById = {};
  let trunkTaken = {};

  function shapeOf(st, sp) {
    const s = (st.biome && st.biome.shapes) || DEFAULT_SHAPES;
    return s[sp] || DEFAULT_SHAPES[sp] ||
      KIND_SHAPE[Forest.kindOf(st, sp)] || 'bush';
  }

  /* a plant's spot: a standing tree's trunk quarter, or a stable nudge
   * somewhere inside its cell for everything that is not a solid */
  function spotOf(p) {
    const t = trunkAt[p.id];
    if (t) return t;
    return { x: p.x + 0.15 + h01(p.id, 1) * 0.7,
             z: p.y + 0.15 + h01(p.id, 2) * 0.7 };
  }

  function shade(base, id, salt, k) {
    return _c1.copy(base).multiplyScalar(1 - k + h01(id, salt) * 2 * k);
  }

  /* a tree's own leaf: the season's colour, leaned toward the shape's tint,
   * turned a few degrees and lightened or darkened a little by its id */
  const _hsl = { h: 0, s: 0, l: 0 };
  function leafOf(base, tint, mix, id) {
    _c1.copy(base);
    if (tint !== null) _c1.lerp(_c3.setHex(tint), mix);
    _c1.getHSL(_hsl);
    _c1.setHSL((_hsl.h + (h01(id, 17) * 2 - 1) * LEAF_HUE + 1) % 1, _hsl.s,
               Math.max(0, Math.min(1, _hsl.l *
                 (1 + (h01(id, 18) * 2 - 1) * LEAF_LIGHT))));
    return _c1;
  }

  /* the trunk's width: Iris's heavier trunks, but never wider than the
   * quarter the router keeps round it */
  function trunkW(k, s) { return Math.min(TRUNK_W_MAX, k * s); }

  /* trees the camera sees, for the fade: a capsule each, by plant id */
  let treeBoxes = [];
  let faded = {};
  const bushFloor = new THREE.Color(BUSH_FLOOR);

  /* every plant the server sent, by id, for picking and the summary */
  function indexPlants(st) {
    plantById = {};
    (st.plants || []).forEach(p => { plantById[p.id] = p; });
  }

  /* The plant meshes come from Forest.drawList and nothing else (the
   * forest_check test holds this function to that): the trees drawn are
   * exactly the trees that stand for the router. */
  function buildPlants(st) {
    indexPlants(st);
    const list = Forest.drawList(st);
    const n = list.length;
    B.trunk.begin(n); B.cone.begin(n * 3); B.crown.begin(n * 3);
    B.strand.begin(n * 16); B.frond.begin(n * 4); B.bush.begin(n);
    B.fruit.begin(n * 4); B.arm.begin(n * 2); B.log.begin(n);
    /* the ghosts are sized from the faded set, as the solid ones are from
     * the plants: a weeping willow alone is sixteen strands */
    const nf = Object.keys(faded).length;
    GH.trunk.begin(nf); GH.cone.begin(nf * 3); GH.crown.begin(nf * 3);
    GH.strand.begin(nf * 16);
    treeBoxes = [];
    const dim = pal.canopyDim;
    for (const p of list) {
      const sp = p.sp;
      const spot = spotOf(p);
      const gy = heightAt(spot.x, spot.z);
      const yaw = h01(p.id, 3) * Math.PI * 2;
      /* a tree in the way of what the camera watches goes to the ghosts */
      const T = faded[p.id] ? GH : B;
      if (p.st === 'log') {
        const len = 1.1 + h01(p.id, 4) * 0.5;
        _e.set(0, yaw, Math.PI / 2);
        _q.setFromEuler(_e);
        _m.compose(_v.set(spot.x, gy + 0.09, spot.z), _q,
                   _s.set(0.18, len, 0.18));
        B.log.add(_m, _c2.setHex(TRUNK[sp] || TRUNK_DEFAULT)
          .multiplyScalar(0.7), p.id);
        continue;
      }
      const stage = STAGE_SCALE[p.st];
      if (!stage) continue;                 // a seed is not drawn
      const s = stage * (p.el ? 1.12 : 1) * (0.88 + h01(p.id, 5) * 0.24);
      const shape = shapeOf(st, sp);
      const bark = _c2.setHex(TRUNK[sp] || TRUNK_DEFAULT);
      if (shape === 'pine') {
        const th = 0.9 * s, tw = trunkW(0.28, s);
        T.trunk.add(place(spot.x, gy, spot.z, tw, th, tw, yaw), bark, p.id);
        /* narrower tiers than before: light gets between the spires */
        let top = 0;
        for (let t = 0; t < 3; t++) {
          const w = (0.82 - t * 0.2) * s, ch = (1.1 - t * 0.15) * s;
          const y0 = gy + th * 0.55 + t * 0.62 * s;
          top = y0 + ch;
          T.cone.add(place(spot.x, y0, spot.z, w, ch, w, yaw + t),
                     leafOf(pal.pine, null, 0, p.id).multiplyScalar(dim),
                     p.id);
        }
        treeBoxes.push({ id: p.id, x: spot.x, z: spot.z, r: 0.42 * s,
                         y0: gy + th * 0.5, top });
      } else if (shape === 'weeping') {
        /* a weeping willow: a slim trunk, a small dome, and thin strands
         * hanging from its rim nearly to the ground with air between
         * them — not a solid bell */
        const th = 1.25 * s, tw = trunkW(0.13, s);
        T.trunk.add(place(spot.x, gy, spot.z, tw, th, tw, yaw), bark, p.id);
        const leaf = leafOf(pal.leaf, WILLOW_LEAF, 0.35, p.id)
          .multiplyScalar(dim);
        const cw = 0.78 * s, chh = 0.4 * s, top = gy + th + chh * 0.55;
        T.crown.add(place(spot.x, gy + th + chh * 0.1, spot.z, cw, chh, cw,
                          yaw), leaf, p.id);
        const many = p.st === 'sapling' ? 7 : 15;
        const lc = _c3.copy(leaf).lerp(_c4.setHex(0xd8e09a), 0.12);
        for (let f = 0; f < many; f++) {
          const outer = f % 3 !== 0;
          const a = yaw + f * (Math.PI * 2 / many) + (h01(p.id, 40 + f) - 0.5) * 0.3;
          const rr = (outer ? 0.42 : 0.22) * s;
          const sx = spot.x + Math.cos(a) * rr, sz = spot.z + Math.sin(a) * rr;
          const len = (outer ? 0.95 : 0.7) * th * (0.8 + h01(p.id, 60 + f) * 0.3);
          /* the strand's foot swings a little outward */
          _v.set(-Math.sin(a), 0, Math.cos(a));
          _q.setFromAxisAngle(_v, outer ? 0.16 : 0.08);
          _m.compose(_v.set(sx, gy + th + chh * 0.05, sz), _q,
                     _s.set(0.075 * s, len, 0.075 * s));
          T.strand.add(_m, lc, p.id);
        }
        treeBoxes.push({ id: p.id, x: spot.x, z: spot.z, r: 0.5 * s,
                         y0: gy + 0.3, top });
      } else if (shape === 'deciduous') {
        /* a broadleaf: two or three low-poly clusters, offset and tilted
         * up, rather than one round blob (Iris) */
        const th = 1.35 * s, tw = sp === 'birch' ? trunkW(0.17, s)
                                                 : trunkW(0.27, s);
        T.trunk.add(place(spot.x, gy, spot.z, tw, th, tw, yaw), bark, p.id);
        const leaf = leafOf(pal.leaf, sp === 'birch' ? BIRCH_LEAF : null,
                            0.3, p.id).multiplyScalar(dim);
        const lc = _c3.copy(leaf);
        const many = 2 + (h01(p.id, 19) < 0.5 ? 1 : 0);
        const cw = 0.86 * s;
        let top = 0;
        for (let c = 0; c < many; c++) {
          const f = c === 0 ? 1 : 0.7 + h01(p.id, 20 + c) * 0.3;
          const a = yaw + c * 2.4;
          const off = c === 0 ? 0 : 0.25 * s;
          const up = c === 0 ? 0 : (0.15 + h01(p.id, 24 + c) * 0.2) * s;
          const w = cw * f, hh = w * 0.8;
          const cy = gy + th + hh * 0.2 + up;
          top = Math.max(top, cy + hh * 0.5);
          T.crown.add(place(spot.x + Math.cos(a) * off, cy,
                            spot.z + Math.sin(a) * off, w, hh, w, yaw + c),
                      lc, p.id);
        }
        treeBoxes.push({ id: p.id, x: spot.x, z: spot.z, r: 0.5 * s,
                         y0: gy + th * 0.55, top });
      } else if (shape === 'cactus') {
        const th = 1.6 * s;
        const green = shade(pal.pine, p.id, 13, 0.08);
        B.arm.add(place(spot.x, gy, spot.z, 0.32 * s, th, 0.32 * s, yaw),
                  green, p.id);
        if (p.st !== 'sapling') {
          for (let a = 0; a < 2; a++) {
            const side = a ? -1 : 1;
            const ax = spot.x + Math.cos(yaw) * 0.26 * s * side;
            const az = spot.z + Math.sin(yaw) * 0.26 * s * side;
            const ay = gy + th * (0.4 + h01(p.id, 14 + a) * 0.2);
            B.arm.add(place(ax, ay, az, 0.2 * s, 0.6 * s, 0.2 * s, 0),
                      green, p.id);
          }
        }
      } else if (shape === 'fronds') {
        const fc = shade(pal.under, p.id, 15, 0.12);
        for (let f = 0; f < 4; f++) {
          const a = yaw + f * Math.PI / 2;
          _e.set(0.5, a, 0);
          _q.setFromEuler(_e);
          _m.compose(_v.set(spot.x, gy, spot.z), _q,
                     _s.set(0.34 * s, 0.6 * s, 0.12 * s));
          B.frond.add(_m, fc, p.id);
        }
      } else {
        /* a bush, and anything with no shape of its own; never darker
         * than the floor Iris set, or it reads as litter */
        const bw = 0.62 * s;
        const bc = shade(pal.bush, p.id, 16, 0.1);
        bc.setRGB(Math.max(bc.r, bushFloor.r), Math.max(bc.g, bushFloor.g),
                  Math.max(bc.b, bushFloor.b));
        B.bush.add(place(spot.x, gy + bw * 0.38, spot.z, bw, bw * 0.78, bw,
                         yaw), bc, p.id);
        if (p.b) {
          for (let f = 0; f < 4; f++) {
            const a = yaw + f * 1.7;
            B.fruit.add(place(spot.x + Math.cos(a) * bw * 0.42,
                              gy + bw * (0.35 + 0.15 * (f & 1)),
                              spot.z + Math.sin(a) * bw * 0.42,
                              0.09, 0.09, 0.09, 0), pal.fruit, null);
          }
        }
      }
    }
    buildShore();
    Object.keys(B).forEach(k => {
      if (k !== 'stem' && k !== 'cap' && k !== 'capLit' && k !== 'mound' &&
          k !== 'pad' && k !== 'reed') {
        B[k].end();
      }
    });
    GHOSTED.forEach(k => GH[k].end());
  }

  /* lily pads on the ponds and reeds round them: the season's greens */
  function buildShore() {
    B.pad.begin(N * 2); B.reed.begin(N * 8);
    for (let i = 0; i < N * N; i++) {
      const x = i % N, y = (i - x) / N;
      if (waterKind[i] === 2) {
        if (h01(i, 150) > 0.34) continue;
        const px = x + 0.25 + h01(i, 151) * 0.5;
        const pz = y + 0.25 + h01(i, 152) * 0.5;
        const r = 0.22 + h01(i, 153) * 0.14;
        B.pad.add(place(px, WATER_Y + 0.012, pz, r, 1, r, h01(i, 154) * 6.28),
                  _c1.copy(pal.under).lerp(pal.grass, 0.3)
                    .multiplyScalar(0.9 + h01(i, 155) * 0.2), null);
        continue;
      }
      if (waterKind[i] || isWater[i]) continue;
      let pond = false;
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(d => {
        const qx = x + d[0], qy = y + d[1];
        if (qx >= 0 && qy >= 0 && qx < N && qy < N &&
            waterKind[qy * N + qx] === 2) pond = true;
      });
      if (!pond || h01(i, 160) > 0.55) continue;
      const many = 3 + Math.floor(h01(i, 161) * 3);
      for (let k = 0; k < many; k++) {
        const px = x + 0.15 + h01(i, 162 + k) * 0.7;
        const pz = y + 0.15 + h01(i, 170 + k) * 0.7;
        const hgt = 0.35 + h01(i, 180 + k) * 0.3;
        B.reed.add(place(px, heightAt(px, pz) - 0.02, pz, 0.025, hgt, 0.025, 0),
                   _c1.copy(pal.under).lerp(pal.soil, 0.25), null);
      }
    }
    B.pad.end(); B.reed.end();
  }

  /* mushrooms (their caps glow after dark) and the fallen, cell by cell */
  let mushCount = 0;
  function buildCells(st) {
    B.stem.begin(N * 3); B.cap.begin(N * 3); B.capLit.begin(N * 3);
    B.mound.begin(16);
    mushCount = 0;
    for (let i = 0; i < N * N; i++) {
      const c = st.cells[i];
      if (!c) continue;
      const x = i % N, y = (i - x) / N;
      if (c[3]) {
        mushCount++;
        for (let m = 0; m < 3; m++) {
          const px = x + 0.2 + h01(i, 90 + m) * 0.6;
          const pz = y + 0.2 + h01(i, 95 + m) * 0.6;
          const gy = heightAt(px, pz);
          const r = 0.07 + h01(i, 99 + m) * 0.05;
          B.stem.add(place(px, gy, pz, r * 0.45, r * 1.4, r * 0.45, 0),
                     _c1.setHex(0xe8e0cc), null);
          (litCell[i] ? B.capLit : B.cap).add(
            place(px, gy + r * 1.3, pz, r * 2.2, r * 1.6, r * 2.2, 0),
            _c1.setHex(0xd9f5e6), null);
        }
      }
      if (c[4]) {
        const px = x + 0.5, pz = y + 0.5;
        B.mound.add(place(px, heightAt(px, pz) + 0.04, pz, 0.5, 0.18, 0.34,
                          h01(i, 7) * 6.28), _c1.setHex(0x6b5a4c), null);
      }
    }
    B.stem.end(); B.cap.end(); B.capLit.end(); B.mound.end();
  }

  /* ------------------------------------------------------- the router */

  const grid = Walk ? Walk.buildGrid(Forest.subGround(first),
                                     { solid: { trunk: 1 } }) : null;
  let routeFallbacks = 0, routeMaxPoints = 0;

  /* --------------------------------------------------------- creatures */

  const partBox = makeBatch(scene, boxGeo, new THREE.MeshStandardMaterial({
    roughness: 0.85, emissive: 0xffffff, emissiveIntensity: 0 }), 512);
  const partBall = makeBatch(scene, ballGeo, new THREE.MeshStandardMaterial({
    roughness: 0.7, emissive: 0xffffff, emissiveIntensity: 0 }), 128);
  /* the body's own colour carries a faint emissive after dark, so a deer
   * is still a deer by moonlight, as the estate's people are */
  partBox.mesh.material.emissive.setHex(0x223344);
  partBall.mesh.material.emissive.setHex(0x223344);

  const shadowGeo = new THREE.CircleGeometry(0.5, 14);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadows = makeBatch(scene, shadowGeo, new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2 }), 128, { noShadow: true });
  const shadowCol = new THREE.Color(0xffffff);

  let beasts = [];              // {a, frame, scale, colours, route, ...}
  let beastById = {};
  let flyers = new Set();
  let lastTick = -1;
  let followId = null;
  let selectedId = null;

  function bodyColour(st, sp) {
    const bodies = (st.biome && st.biome.bodies) || {};
    return colourOf(bodies[sp], BODY_DEFAULT);
  }

  function partColour(base, c) {
    if (FIXED[c] !== undefined) return new THREE.Color(FIXED[c]);
    if (c === 'dark') return base.clone().multiplyScalar(0.62);
    if (c === 'pale') return base.clone().lerp(new THREE.Color(0xf1e8d8), 0.5);
    return base.clone();
  }

  function syncBeasts(st, now) {
    flyers = new Set((st.biome && st.biome.flyers) || []);
    const newTick = Number(st.tick) !== lastTick;
    lastTick = Number(st.tick);
    /* the glide: as long as the plan view's, so a creature arrives well
     * before the next week does (the server says how late we already are) */
    const lag = Math.max(0, (Number(st.now) || 0) - (Number(st.step_at) || 0));
    const glide = Math.max(0.5, ((Number(st.tick_seconds) || 12) - lag) *
                           0.45) * 1000;
    const next = {};
    const list = [];
    /* everyone's resting place this week and last, shared out where a
     * cell holds more than one (forest.js) */
    const spots = Forest.restSpots(Walk, grid, st, trunkTaken, 'now');
    let spotsWas = null;
    /* walkers sharing a road go in file (forest.js) */
    let file = null;
    (st.animals || []).forEach(a => {
      if (!(a.x >= 0 && a.y >= 0 && a.x < N && a.y < N)) return;
      let b = beastById[a.id];
      const fly = flyers.has(a.sp);
      const to = spots[a.id];
      if (!b) {
        const fig = Forest.figure(st, a.sp);
        const frame = fig.frame;
        const base = bodyColour(st, a.sp);
        b = { id: a.id, frame, scale: fig.scale, r: fig.r,
              colours: PARTS[frame].map(p => partColour(base, p[7])),
              x: to.x, z: to.z, yaw: h01(a.id, 30) * 6.28,
              route: null, t0: 0, dur: 0, tx: to.x, tz: to.z };
        /* a creature that arrives already walking starts last week's spot */
        if (!staticMode && (a.px !== a.x || a.py !== a.y) &&
            a.px >= 0 && a.py >= 0) {
          spotsWas = spotsWas ||
            Forest.restSpots(Walk, grid, st, trunkTaken, 'prev');
          const from = spotsWas[a.id];
          b.tx = from.x; b.tz = from.z; b.x = from.x; b.z = from.z;
        }
      }
      b.a = a;
      b.fly = fly;
      if ((newTick || b.tx !== to.x || b.tz !== to.z) &&
          (Math.abs(b.tx - to.x) > 1e-6 || Math.abs(b.tz - to.z) > 1e-6)) {
        const fx = b.route ? b.x : b.tx, fz = b.route ? b.z : b.tz;
        let r;
        if (fly || !grid || staticMode) {
          r = { route: Walk ? Walk.straight(fx, fz, to.x, to.z) : null,
                fallback: false };
        } else {
          r = Forest.route(Walk, grid, fx, fz, to.x, to.z);
          if (r.fallback) routeFallbacks++;
          else routeMaxPoints = Math.max(routeMaxPoints, r.points || 0);
        }
        if (staticMode || !r.route) {
          b.route = null; b.x = to.x; b.z = to.z;
        } else {
          b.route = r.route;
          if (newTick && !file) {
            spotsWas = spotsWas ||
              Forest.restSpots(Walk, grid, st, trunkTaken, 'prev');
            file = Forest.stagger(st, spotsWas);
          }
          const f = newTick ? file[a.id] : null;
          b.t0 = now + (f ? f.lag * glide : 0);
          b.dur = f ? f.span * glide : glide;
        }
        b.tx = to.x; b.tz = to.z;
      }
      next[a.id] = b;
      list.push(b);
    });
    beastById = next;
    beasts = list;
  }

  const sampleOut = { x: 0, z: 0, dx: 0, dz: 0, moving: false };

  /* Creatures sharing a cell, or passing on one line, are kept apart as
   * they are drawn: every creature goes to Walk.separate with the radius
   * its body keeps clear (forest.js), flyers in a layer of their own, and
   * any two closer than their bodies are pushed apart — oncoming walkers
   * to their own right, so they pass side by side. No push takes a body
   * into the water or another trunk's quarter (Walk.clearAt on the
   * router's grid), nor nearer any trunk than its body allows, and no
   * flyer off the map (Forest.space). `b.x`/`b.z` stay where the walk
   * has them; only the drawing moves. Stateless: a frame depends on nothing but its own time. */
  let crowdF = null;
  const crowdMove = [];

  function updateBeasts(now, dark) {
    let n = 0;
    for (let i = 0; i < beasts.length; i++) n += PARTS[beasts[i].frame].length;
    partBox.begin(n); partBall.begin(n); shadows.begin(beasts.length);
    const t = now / 1000;
    if (Walk) crowdF = Walk.figures(crowdF, beasts.length);
    for (let i = 0; i < beasts.length; i++) {
      const b = beasts[i];
      let moving = false;
      if (b.route) {
        const f = b.dur > 0 ? Math.max(0, Math.min(1, (now - b.t0) / b.dur))
                            : 1;
        /* eased like the plan view's glide: a start and a stop, not a
         * slide at constant speed */
        const e = f * f * (3 - 2 * f);
        Walk.sample(b.route, e * b.route.total, sampleOut);
        b.x = sampleOut.x; b.z = sampleOut.z;
        if (Math.abs(sampleOut.dx) + Math.abs(sampleOut.dz) > 1e-6 &&
            f > 0 && f < 1) {
          const want = Math.atan2(-sampleOut.dz, sampleOut.dx);
          let d = want - b.yaw;
          d = Math.atan2(Math.sin(d), Math.cos(d));
          b.yaw += d * 0.25;
          moving = true;
        }
        if (f >= 1) { b.route = null; b.x = b.tx; b.z = b.tz; }
      }
      const ph = h01(b.id, 31) * 6.28;
      let px = b.x, pz = b.z;
      if (b.fly && !moving && !staticMode) {
        /* a flyer hovers over its cell in a slow loop */
        px += Math.cos(t * 0.6 + ph) * 0.3;
        pz += Math.sin(t * 0.6 + ph) * 0.3;
        b.yaw = -(t * 0.6 + ph) - Math.PI / 2;
      }
      crowdMove[i] = moving;
      if (!crowdF) continue;
      const F = crowdF;
      F.rx[i] = px; F.rz[i] = pz;
      F.r[i] = b.r;
      F.w[i] = moving ? 1 : 0.5;
      F.hx[i] = moving ? sampleOut.dx : 0;
      F.hz[i] = moving ? sampleOut.dz : 0;
      F.layer[i] = b.fly ? 1 : 0;
      F.id[i] = b.id;
    }
    if (crowdF) Forest.space(Walk, grid, crowdF, beasts.length, N);
    for (let i = 0; i < beasts.length; i++) {
      const b = beasts[i];
      const moving = crowdMove[i];
      const px = crowdF ? crowdF.x[i] : b.x, pz = crowdF ? crowdF.z[i] : b.z;
      const gy = heightAt(px, pz);
      const ph = h01(b.id, 31) * 6.28;
      let y = gy, wing = 0;
      if (b.fly) {
        /* and flaps */
        y = gy + 1.5 + Math.sin(t * 1.3 + ph) * 0.18;
        wing = Math.sin(t * 14 + ph) * 0.9;
      } else if (moving) {
        y += Math.abs(Math.sin(t * 9 + ph)) * 0.04;
      }
      _e.set(0, b.yaw, 0);
      _q.setFromEuler(_e);
      _m2.compose(_v.set(px, y, pz), _q, _s.set(b.scale, b.scale, b.scale));
      /* a soft contact shadow under each body, smaller under a flyer */
      const sd = b.r * (b.fly ? 1.4 : 2.3);
      shadows.add(place(px, gy + 0.02, pz, sd, 1, sd, 0), shadowCol, null);
      const parts = PARTS[b.frame];
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k];
        let rx = 0;
        if (p[0] === 'wing') rx = p[6] > 0 ? wing : -wing;
        _e.set(rx, 0, p[8] || 0);
        _q.setFromEuler(_e);
        _m.compose(_v.set(p[4], p[5] + (p[0] === 'ball' ? 0 : 0), p[6]), _q,
                   _s.set(p[1] * (p[0] === 'ball' ? 2 : 1),
                          p[2] * (p[0] === 'ball' ? 2 : 1),
                          p[3] * (p[0] === 'ball' ? 2 : 1)));
        _m.premultiply(_m2);
        (p[0] === 'ball' ? partBall : partBox).add(_m, b.colours[k], b.id);
      }
    }
    partBox.end(); partBall.end(); shadows.end();
    partBox.mesh.material.emissiveIntensity = dark * 0.5;
    partBall.mesh.material.emissiveIntensity = dark * 0.5;
  }

  /* -------------------------------------------------------- fireflies */

  /* After dark in the warm half of the year, near the water: deterministic
   * spots, a slow drift, an additive spark. Decoration, never a fact. */
  const FLY_MAX = 80;
  const flyPos = new Float32Array(FLY_MAX * 3);
  const flyHome = [];
  for (let i = 0; i < N * N && flyHome.length < FLY_MAX; i++) {
    if (!isWater[i]) continue;
    const x = i % N, y = (i - x) / N;
    for (let k = 0; k < 2 && flyHome.length < FLY_MAX; k++) {
      flyHome.push([x + h01(i, 200 + k) * 1.6 - 0.3,
                    y + h01(i, 210 + k) * 1.6 - 0.3, h01(i, 220 + k) * 6.28]);
    }
  }
  /* each fly flickers on its own, between 0.3 and 1.0 of full: a vertex
   * colour (the spark's colour times its brightness) under additive
   * blending, so no two blink together */
  const FLY_HEX = new THREE.Color(0xe9ff9a);
  const flyCol = new Float32Array(FLY_MAX * 3);
  const flyGeo = new THREE.BufferGeometry();
  const flyAttr = new THREE.BufferAttribute(flyPos, 3);
  const flyColAttr = new THREE.BufferAttribute(flyCol, 3);
  flyGeo.setAttribute('position', flyAttr);
  flyGeo.setAttribute('color', flyColAttr);
  flyGeo.setDrawRange(0, flyHome.length);
  const fireflies = new THREE.Points(flyGeo, new THREE.PointsMaterial({
    color: 0xffffff, vertexColors: true, size: 0.08, transparent: true,
    opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    fog: false }));
  fireflies.frustumCulled = false;
  fireflies.visible = false;
  scene.add(fireflies);
  let warm = false;

  function updateFireflies(now, dark) {
    const on = warm && dark > 0.35 && flyHome.length > 0;
    fireflies.visible = on;
    if (!on) return;
    const t = now / 1000;
    for (let i = 0; i < flyHome.length; i++) {
      const h = flyHome[i];
      flyPos[i * 3] = h[0] + Math.sin(t * 0.5 + h[2]) * 0.4;
      flyPos[i * 3 + 1] = heightAt(h[0], h[1]) + 0.5 +
        Math.sin(t * 0.9 + h[2] * 2) * 0.25;
      flyPos[i * 3 + 2] = h[1] + Math.cos(t * 0.4 + h[2]) * 0.4;
      /* 0.3..1.0, at this fly's own rate and phase */
      const b = 0.65 + 0.35 * Math.sin(t * (2.2 + h[2] * 0.25) + h[2] * 3);
      flyCol[i * 3] = FLY_HEX.r * b;
      flyCol[i * 3 + 1] = FLY_HEX.g * b;
      flyCol[i * 3 + 2] = FLY_HEX.b * b;
    }
    flyAttr.needsUpdate = true;
    flyColAttr.needsUpdate = true;
    fireflies.material.opacity = Math.min(1, (dark - 0.35) * 1.5);
  }

  /* ---------------------------------------------------------- weather */

  const RAIN_MAX = 1400, SNOW_MAX = 900;
  const SPAN = N + 8;
  const rainPos = new Float32Array(RAIN_MAX * 6);
  for (let i = 0; i < RAIN_MAX; i++) {
    const x = Math.random() * SPAN - 4, y = Math.random() * 14;
    const z = Math.random() * SPAN - 4;
    rainPos.set([x, y, z, x, y - 0.5, z], i * 6);
  }
  const rainGeo = new THREE.BufferGeometry();
  const rainAttr = new THREE.BufferAttribute(rainPos, 3);
  rainGeo.setAttribute('position', rainAttr);
  rainGeo.setDrawRange(0, 0);
  const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({
    color: 0x9fd0ff, transparent: true, opacity: 0.45, depthWrite: false }));
  rain.frustumCulled = false;
  rain.visible = false;
  scene.add(rain);

  const snowPos = new Float32Array(SNOW_MAX * 3);
  for (let i = 0; i < SNOW_MAX; i++) {
    snowPos[i * 3] = Math.random() * SPAN - 4;
    snowPos[i * 3 + 1] = Math.random() * 14;
    snowPos[i * 3 + 2] = Math.random() * SPAN - 4;
  }
  const snowGeo = new THREE.BufferGeometry();
  const snowAttr = new THREE.BufferAttribute(snowPos, 3);
  snowGeo.setAttribute('position', snowAttr);
  snowGeo.setDrawRange(0, 0);
  const snow = new THREE.Points(snowGeo, new THREE.PointsMaterial({
    color: 0xffffff, size: 0.09, transparent: true, opacity: 0.85,
    depthWrite: false }));
  snow.frustumCulled = false;
  snow.visible = false;
  scene.add(snow);

  let weather = 'clear';
  let rainAmount = 0, snowAmount = 0;
  let flash = 0, nextFlash = 0;

  function syncWeather(st) {
    weather = st.weather || 'clear';
    rainAmount = weather === 'rain' ? 700 : weather === 'storm' ? RAIN_MAX : 0;
    snowAmount = weather === 'frost' ? SNOW_MAX : 0;
    rainGeo.setDrawRange(0, rainAmount * 2);
    snowGeo.setDrawRange(0, snowAmount);
    rain.visible = rainAmount > 0;
    snow.visible = snowAmount > 0;
  }

  function updateWeather(dt, now) {
    if (staticMode) return;
    if (rainAmount) {
      const fall = 11 * dt;
      for (let i = 0; i < rainAmount; i++) {
        const j = i * 6;
        rainPos[j + 1] -= fall;
        rainPos[j + 4] = rainPos[j + 1] - 0.5;
        if (rainPos[j + 1] < 0) {
          const x = Math.random() * SPAN - 4, z = Math.random() * SPAN - 4;
          rainPos[j] = x; rainPos[j + 1] = 14; rainPos[j + 2] = z;
          rainPos[j + 3] = x; rainPos[j + 4] = 13.5; rainPos[j + 5] = z;
        }
      }
      rainAttr.needsUpdate = true;
    }
    if (snowAmount) {
      for (let i = 0; i < snowAmount; i++) {
        const j = i * 3;
        snowPos[j + 1] -= 1.1 * dt;
        snowPos[j] += Math.sin(now * 0.001 + i * 0.7) * 0.005;
        if (snowPos[j + 1] < 0) {
          snowPos[j] = Math.random() * SPAN - 4;
          snowPos[j + 1] = 14;
          snowPos[j + 2] = Math.random() * SPAN - 4;
        }
      }
      snowAttr.needsUpdate = true;
    }
    /* a storm's lightning: a flash every few seconds, gone in a blink */
    if (weather === 'storm') {
      if (now > nextFlash) {
        flash = 1;
        nextFlash = now + 2500 + Math.random() * 6000;
      }
    }
    flash = Math.max(0, flash - dt * 5);
  }

  /* ------------------------------------------------------------ the sky */

  const skyColour = new THREE.Color();
  const groundColour = new THREE.Color();
  let darkNow = 0;

  function updateSky(dayFrac) {
    const l = Clock.lightAt(dayFrac);
    sun.intensity = l.sunI;
    hemi.intensity = l.hemiI + flash * 2.2;
    sun.color.setRGB(l.sun[0], l.sun[1], l.sun[2]);
    skyColour.setRGB(l.sky[0], l.sky[1], l.sky[2]);
    hemi.color.setRGB(l.hemiSky[0], l.hemiSky[1], l.hemiSky[2]);
    hemi.groundColor.setRGB(l.hemiGround[0], l.hemiGround[1],
                            l.hemiGround[2]);
    groundColour.copy(hemi.groundColor);
    darkNow = l.dark;
    renderer.toneMappingExposure = l.exposure;
    const wt = WEATHER_SKY[weather];
    if (wt) {
      _c1.setHex(wt.hex);
      skyColour.lerp(_c1, wt.mix * (1 - darkNow));
      sun.intensity *= wt.sun;
    }
    if (flash > 0) skyColour.lerp(_c1.setHex(0xcfd8ff), flash * 0.5);
    scene.background.copy(skyColour);
    /* the horizon a little below the sky's value by day, so the grove
     * sits on the ground; at night the fog is the night sky's own colour
     * (clock.js fogGroundMix) */
    scene.fog.color.copy(skyColour)
      .lerp(groundColour, Clock.fogGroundMix(darkNow));
    const k = N / 24;
    sun.position.set(centre.x + l.offset[0] * k,
                     Math.max(SUN_MIN_Y, l.offset[1] * k),
                     centre.z + l.offset[2] * k);
  }

  /* --------------------------------------------------------------- state */

  /* the server's week and the page's day: a day lasts a few weeks, close to
   * a minute and a half of wall time whatever the tick */
  function weeksPerDay(st) {
    return Math.max(1, Math.round(96 / Math.max(0.5,
      Number(st.tick_seconds) || 12)));
  }

  let lastNow = 0;
  let builtTick = -1;

  function setState(st) {
    const now = performance.now();
    clock.haveState = true;
    const wpd = weeksPerDay(st);
    Clock.setPace(clock, now, (Number(st.tick_seconds) || 12) * wpd);
    Clock.onState(clock, now, { paused: !!st.paused,
                                day: Math.floor((Number(st.tick) || 0) / wpd) });
    dayNow = Math.floor((Number(st.tick) || 0) / wpd);
    if (nightKey === null) nightKey = dayNow;
    warm = st.season === 'spring' || st.season === 'summer';
    if (Number(st.tick) !== builtTick) {
      builtTick = Number(st.tick);
      st0 = st;
      readPalette(st);
      paintFloor(st);
      const t = Forest.trunks(st);
      trunkAt = t.at;
      trunkTaken = t.taken;
      if (grid) Walk.setFixtures(grid, t.fixtures);
      buildPlants(st);
      buildGlow(st);      // first: it chooses the lit rings the caps show
      buildCells(st);
    }
    syncBeasts(st, now);
    syncWeather(st);
  }

  /* --------------------------------------------------------------- fade */

  /* The trees between the camera and what it is watching — the creature
   * followed or selected, the view's centre, and the few creatures
   * nearest it — are drawn as ghosts (forest.js occluders). Looked at a
   * few times a second; the plants are rebuilt only when the set changes. */
  let fadeAt = -1e9, fadeKey = '';
  const fadeTargets = [];
  function fadeTargetsNow() {
    fadeTargets.length = 0;
    const add = (x, z, up) => fadeTargets.push(
      { x, y: heightAt(x, z) + up, z });
    [followId, selectedId].forEach(id => {
      const b = id !== null ? beastById[id] : null;
      if (b) add(b.x, b.z, b.fly ? 1.6 : 0.3);
    });
    const cx = controls.target.x, cz = controls.target.z;
    add(cx, cz, 0.3);
    const near = [];
    beasts.forEach(b => {
      const d = Math.hypot(b.x - cx, b.z - cz);
      if (d <= FADE_NEAR) near.push([d, b.id, b]);
    });
    near.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    near.slice(0, FADE_MAX).forEach(e => add(e[2].x, e[2].z,
                                              e[2].fly ? 1.6 : 0.3));
    return fadeTargets;
  }
  let fadeView = '';
  function updateFade(now) {
    if (!st0) return;
    if (staticMode) {
      /* the screenshot path draws every frame: look again only when the
       * camera, the creature watched or the week has changed */
      const c = camera.position, t = controls.target;
      const view = [c.x, c.y, c.z, t.x, t.z, followId, selectedId,
                    builtTick].join(' ');
      if (view === fadeView) return;
      fadeView = view;
    } else if (now - fadeAt < FADE_EVERY) {
      return;
    }
    fadeAt = now;
    const ids = Forest.occluders(treeBoxes, camera.position,
                                 fadeTargetsNow());
    const key = ids.join(',');
    if (key === fadeKey) return;
    fadeKey = key;
    faded = {};
    ids.forEach(id => { faded[id] = 1; });
    buildPlants(st0);
  }

  /* -------------------------------------------------------------- frame */

  const phaseInfo = { phase: 2, index: 2, name: 'afternoon', darkness: 0,
                      dayFrac: 0.5 };

  function frame(now) {
    const dt = Math.min(0.05, lastNow ? Math.max(0, (now - lastNow) / 1000)
                                      : 0.016);
    lastNow = now;
    const f = Clock.fraction(clock, now);
    updateWeather(dt, now);
    updateSky(f);
    const dark = darkNow;
    /* a new night's rings, chosen while it is light */
    if (dark <= Glow.DARK_ON && nightKey !== dayNow && builtTick >= 0) {
      nightKey = dayNow;
      buildGlow(st0, true);
      buildCells(st0);
    }
    glowMat.opacity = dark * GLOW_OPACITY;
    glow.visible = glowCount > 0 && dark > Glow.DARK_ON;
    mushMat.emissiveIntensity = 0.15 + dark * 1.6;
    mushDimMat.emissiveIntensity = 0.15 - dark * 0.13;
    updateBeasts(now, dark);
    updateFireflies(now, dark);
    creekMat.map && (creekMat.map.offset.y =
      -((now / 1000) * FLOW_SPEED % 1));
    if (followId !== null && beastById[followId]) {
      const b = beastById[followId];
      _v.set(b.x, heightAt(b.x, b.z) + 0.4, b.z).sub(controls.target)
        .multiplyScalar(staticMode ? 1 : 0.08);
      controls.target.add(_v);
      camera.position.add(_v);
    }
    controls.update();
    updateFade(now);
    renderer.render(scene, camera);
    const info = Clock.phaseAt(f);
    phaseInfo.phase = info.phase;
    phaseInfo.index = info.index;
    phaseInfo.name = info.name;
    phaseInfo.darkness = dark;
    phaseInfo.dayFrac = f;
    return phaseInfo;
  }

  /* --------------------------------------------------------------- pick */

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const TERRAIN_NAME = { s: 'soil', w: 'water', r: 'rock' };

  function pick(clientX, clientY, rect, withGround) {
    if (!clock.haveState) return null;
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    let best = null;
    [partBox, partBall].forEach(bt => {
      const h = raycaster.intersectObject(bt.mesh, false);
      if (h.length && (!best || h[0].distance < best.d)) {
        const id = bt.owner[h[0].instanceId];
        const b = beastById[id];
        if (b) best = { d: h[0].distance,
                        hit: { kind: 'animal', entity: b.a } };
      }
    });
    PLANT_PICK.forEach(k => {
      const bt = B[k];
      if (!bt.n) return;
      const h = raycaster.intersectObject(bt.mesh, false);
      if (h.length && (!best || h[0].distance < best.d)) {
        const p = plantById[bt.owner[h[0].instanceId]];
        if (p) best = { d: h[0].distance, hit: { kind: 'plant', entity: p } };
      }
    });
    if (best) return best.hit;
    const gh = raycaster.intersectObject(groundMesh, false);
    if (gh.length) {
      const x = Math.floor(gh[0].point.x), y = Math.floor(gh[0].point.z);
      if (x >= 0 && y >= 0 && x < N && y < N) {
        const c = st0.cells[y * N + x];
        return { kind: 'cell', x, y,
                 terrain: TERRAIN_NAME[c && c[0]] || 'the ground' };
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

  function focusCell(x, y) {
    const px = x + 0.5, pz = y + 0.5, py = heightAt(px, pz) + 0.5;
    controls.target.set(px, py, pz);
    camera.position.set(px + 4.2, py + 3.6, pz + 4.6);
    controls.update();
    return true;
  }

  function follow(id) {
    followId = id === null || id === undefined ? null : id;
  }

  /* the creature the card is open on: the trees before it fade too */
  function select(id) {
    selectedId = id === null || id === undefined ? null : id;
    fadeAt = -1e9;
  }

  function stateSummary() {
    let walking = 0, fly = 0;
    beasts.forEach(b => {
      if (b.fly) fly++;
      if (b.a.px !== b.a.x || b.a.py !== b.a.y) walking++;
    });
    return {
      plants: Object.keys(plantById).length,
      animals: beasts.length,
      trees: Object.keys(trunkAt).length,
      faded: Object.keys(faded).length,
      flyers: fly,
      walking,
      mushrooms: mushCount,
      glow: glowCount,
      rings: ringCount,
      ringsLit,
    };
  }

  function routeStats() {
    const now = performance.now();
    let active = 0;
    beasts.forEach(b => { if (b.route && now - b.t0 < b.dur) active++; });
    return { active, maxWaypoints: routeMaxPoints,
             fallbacks: routeFallbacks };
  }

  return {
    scene, camera, renderer, controls,
    setState, frame, resize, pick, focusCell, follow, select, stateSummary,
    routeStats, heightAt,
    phaseName: () => phaseInfo.name,
    dayFraction: () => phaseInfo.dayFrac,
    hasState: () => clock.haveState,
    staticMode,
  };
}
