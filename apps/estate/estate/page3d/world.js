/* world — the estate in three dimensions.
 *
 * The plan page draws the estate in isometric because a block's height is
 * the fact the whole interior model rests on. This page draws the same fact
 * with a real camera: the blocks are solid, the light moves across them, and
 * a person walks from a door to a bench on the ground rather than sliding
 * across a picture.
 *
 * Nothing here is decided. The ground, the blocks, the flats, the people and
 * their positions all arrive from the server; this file only gives them a
 * body. Where a fact is missing it draws nothing rather than inventing one,
 * because a guess in a renderer is a second copy of a fact the engine owns.
 *
 * The five phases of the day are the same five the PixiJS scene uses —
 * dawn, morning, afternoon, evening, night — and the same interpolation:
 * `phaseNow` turns the wall time since the last poll into a fractional
 * phase, and the light table is read at that fraction. `darkness` is the
 * same curve too, so window-light and lamp-glow arrive at the same moment
 * on both pages.
 */

import * as THREE from 'three';
import { OrbitControls } from '/3d/vendor/OrbitControls.js';

const PHASE_NAMES = ['dawn', 'morning', 'afternoon', 'evening', 'night'];
const FLOOR_H = 1.35;          // world units per storey
const TILE_TOP = 0.12;         // the walking surface: top of a ground tile
const WALK_Y = TILE_TOP + 0.005;

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
};

const BUILDING_STYLE = {
  block: { wall: 0xb7b0a1, roof: 0x444b52, trim: 0x8f887b },
  shop: { wall: 0xcf9f60, roof: 0x7c4038, trim: 0xf0c98a },
};

/* The same role colours the plan page uses. A person is coloured by what
 * they are, never by which household they belong to: two children in one
 * family are two children. */
const ROLE_COLOUR = { child: 0xf2c14e, adult: 0x9ecbf0, elder: 0xd9b8e8 };
const SKIN = [0xf1d5b5, 0xe8c39a, 0xc68863, 0x8d5524];

/* The sun's five anchors. `offset` is from the estate's centre, so the same
 * table works on a plan of any size. Colours are sRGB hex and become linear
 * when three reads them. */
const SKY = [
  { sun: 0xffb27a, sunI: 1.15, offset: [30, 12, 22], sky: 0xe6b28c,
    hemiSky: 0xffd6ae, hemiGround: 0x4a4034, hemiI: 0.55 },
  { sun: 0xfff2dc, sunI: 2.35, offset: [24, 40, 26], sky: 0xa9cbe8,
    hemiSky: 0xdcecff, hemiGround: 0x4e5648, hemiI: 0.82 },
  { sun: 0xffe0b0, sunI: 2.15, offset: [-24, 36, 18], sky: 0xbdd6e8,
    hemiSky: 0xe4f0ff, hemiGround: 0x55584a, hemiI: 0.78 },
  { sun: 0xff8a4c, sunI: 1.35, offset: [-32, 12, -16], sky: 0xd98a62,
    hemiSky: 0xffc9a8, hemiGround: 0x40372e, hemiI: 0.48 },
  /* Night is dark, not black: the plan page lays a 52%-alpha navy over a
   * drawing that is still there, and the 3D page keeps the same bargain —
   * enough blue light to read the blocks, with the lamps and the lived-in
   * windows doing the rest. A literally unlit estate is not night, it is a
   * rendering failure. */
  { sun: 0x9fb4e6, sunI: 0.55, offset: [-20, 28, -28], sky: 0x17243f,
    hemiSky: 0x6e86b8, hemiGround: 0x2a3038, hemiI: 1.05 },
];

const _c1 = new THREE.Color();

function hash01(n, salt) {
  let x = (n * 374761393 + (salt || 0) * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177) | 0;
  x = x ^ (x >>> 16);
  return (x >>> 0) / 4294967295;
}

const clamp01 = v => Math.max(0, Math.min(1, v));
const mixNum = (x, y, f) => x + (y - x) * f;

function stringHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

/* The plan page's `darkness`: nothing until the afternoon is well gone,
 * then a squared climb to full night. */
function darkness(ph) {
  const t = clamp01((ph - 2.6) / 2.0);
  return t * t;
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
  const forcedPhase = Number.isFinite(opts.forcedPhase) ? opts.forcedPhase
                                                          : -1;
  const staticMode = !!opts.staticMode;
  const W = ground.width, H = ground.height;
  const centre = new THREE.Vector3(W / 2, 1.4, H / 2);

  /* ------------------------------------------------------------ renderer */

  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY[2].sky);
  scene.fog = new THREE.Fog(SKY[2].sky, Math.max(W, H) * 1.05,
                            Math.max(W, H) * 3.2);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
  /* high enough to see over the front blocks into the courtyard, still
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
  const shadowSpan = Math.max(W, H) * 0.85;
  sun.shadow.camera.left = -shadowSpan;
  sun.shadow.camera.right = shadowSpan;
  sun.shadow.camera.top = shadowSpan;
  sun.shadow.camera.bottom = -shadowSpan;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 190;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
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

  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(W + 90, H + 90),
    new THREE.MeshStandardMaterial({ color: 0x33402f, roughness: 1 }));
  base.rotation.x = -Math.PI / 2;
  base.position.set(W / 2, -0.03, H / 2);
  base.receiveShadow = true;
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
        addBox(g, trimMat, b.w + 0.06, 0.055, b.h + 0.06,
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
    const doorW = b.kind === 'shop' ? 0.8 : 0.55;
    const doorH = b.kind === 'shop' ? 1.15 : 0.92;
    const along = face.axis === 'z'
      ? Math.max(b.x + 0.55, Math.min(b.x + b.w - 0.55, b.door[0] + 0.5))
      : Math.max(b.y + 0.55, Math.min(b.y + b.h - 0.55, b.door[1] + 0.5));
    const out = face.at + face.sign * 0.045;
    if (face.axis === 'z') {
      addBox(g, doorMat, doorW, doorH, 0.08,
             along, TILE_TOP + doorH / 2, out).castShadow = false;
      addBox(g, stepMat, doorW + 0.24, 0.07, 0.34,
             along, TILE_TOP + 0.035, face.at + face.sign * 0.21);
      addBox(g, roofMat, doorW + 0.34, 0.06, 0.36,
             along, TILE_TOP + doorH + 0.2, face.at + face.sign * 0.16);
    } else {
      addBox(g, doorMat, 0.08, doorH, doorW,
             out, TILE_TOP + doorH / 2, along).castShadow = false;
      addBox(g, stepMat, 0.34, 0.07, doorW + 0.24,
             face.at + face.sign * 0.21, TILE_TOP + 0.035, along);
      addBox(g, roofMat, 0.36, 0.06, doorW + 0.34,
             face.at + face.sign * 0.16, TILE_TOP + doorH + 0.2, along);
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

  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xffca7a, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false });
  /* a circle, not a square: a pool of lamplight has no corners */
  const glowGeo = new THREE.CircleGeometry(0.5, 12);
  glowGeo.rotateX(-Math.PI / 2);
  const glow = new THREE.InstancedMesh(glowGeo, glowMat, Math.max(1, W * H));
  glow.frustumCulled = false;
  glow.renderOrder = 2;
  scene.add(glow);

  let glowCount = 0;
  function buildGlow(st) {
    const light = (st && st.light) || [];
    let n = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = light[y * W + x] || 0;
        if (!v) continue;
        const s = 1.35 + v * 0.2;
        dummy.position.set(x + 0.5, TILE_TOP + 0.02, y + 0.5);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(s, 1, s);
        dummy.updateMatrix();
        glow.setMatrixAt(n, dummy.matrix);
        n++;
      }
    }
    glow.count = n;
    glowCount = n;
    glow.instanceMatrix.needsUpdate = true;
  }

  /* --------------------------------------------------------- windows lit */

  const occupied = new Set();
  let nightOn = false;
  let occupancyDirty = true;

  function paintWindows() {
    if (!windowSlots.length) return;
    for (let i = 0; i < windowSlots.length; i++) {
      const s = windowSlots[i];
      let hex;
      if (s.unit != null && occupied.has(s.unit)) {
        hex = nightOn ? 0xffca7a : 0x51616f;
      } else if (s.shop) {
        hex = nightOn ? 0xffb45c : 0x6b5a44;
      } else {
        hex = nightOn ? 0x0f1419 : 0x263039;
      }
      _c1.setHex(hex);
      windowMesh.setColorAt(i, _c1);
    }
    if (windowMesh.instanceColor) windowMesh.instanceColor.needsUpdate = true;
  }

  /* ------------------------------------------------------------ the sky */

  const skyColour = new THREE.Color();
  const sunColour = new THREE.Color();
  const hemiSky = new THREE.Color();
  const hemiGround = new THREE.Color();
  const skyA = SKY.map(p => ({
    sun: new THREE.Color(p.sun), sky: new THREE.Color(p.sky),
    hemiSky: new THREE.Color(p.hemiSky),
    hemiGround: new THREE.Color(p.hemiGround),
  }));

  function updateSky(ph) {
    const i = Math.min(4, Math.floor(ph));
    const f = Math.min(1, Math.max(0, ph - i));
    const a = SKY[i], b = SKY[Math.min(4, i + 1)];
    const ca = skyA[i], cb = skyA[Math.min(4, i + 1)];

    sun.intensity = mixNum(a.sunI, b.sunI, f);
    hemi.intensity = mixNum(a.hemiI, b.hemiI, f);
    sunColour.lerpColors(ca.sun, cb.sun, f);
    sun.color.copy(sunColour);
    skyColour.lerpColors(ca.sky, cb.sky, f);
    hemiSky.lerpColors(ca.hemiSky, cb.hemiSky, f);
    hemiGround.lerpColors(ca.hemiGround, cb.hemiGround, f);
    hemi.color.copy(hemiSky);
    hemi.groundColor.copy(hemiGround);
    scene.background.copy(skyColour);
    scene.fog.color.copy(skyColour);

    sun.position.set(
      centre.x + mixNum(a.offset[0], b.offset[0], f),
      mixNum(a.offset[1], b.offset[1], f),
      centre.z + mixNum(a.offset[2], b.offset[2], f));
  }

  /* ----------------------------------------------------------- residents */

  /* A figure is a little over half a cell tall — small enough that a block
   * dwarfs it, large enough that a person is visible from the far side of
   * the estate without a label. */
  const bodyGeo = new THREE.CapsuleGeometry(0.13, 0.36, 3, 8);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.76, metalness: 0.02 });
  const headGeo = new THREE.SphereGeometry(0.13, 10, 8);
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.7 });

  let bodyMesh = null, headMesh = null, capacity = 0;
  let people = [];
  let personAt = [];
  const fromX = [], fromZ = [], toX = [], toZ = [];
  const offX = [], offZ = [], roleScale = [];
  let t0 = 0, tickMs = 6000;

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
    headMesh.frustumCulled = false;
    scene.add(bodyMesh);
    scene.add(headMesh);
  }

  /* where a person appears when they step out: the face of their block,
   * under the window of their own flat */
  function homeSpot(unit) {
    const u = ground.units[String(unit)];
    if (!u) return { x: centre.x, z: centre.z };
    const b = buildingById[u.b];
    if (!b) return { x: centre.x, z: centre.z };
    const longX = b.w >= b.h;
    const t = (u.i + 0.5) / Math.max(1, u.n);
    if (longX) {
      return { x: b.x + 0.72 + t * Math.max(0.1, b.w - 1.44),
               z: b.y + b.h + 0.38 };
    }
    return { x: b.x + b.w + 0.38,
             z: b.y + 0.72 + t * Math.max(0.1, b.h - 1.44) };
  }

  function syncResidents(st) {
    people = st.people || [];
    ensureResidents(people.length);
    bodyMesh.count = people.length;
    headMesh.count = people.length;
    if (personAt.length < capacity) {
      for (let i = personAt.length; i < capacity; i++) {
        personAt[i] = null;
        fromX[i] = fromZ[i] = toX[i] = toZ[i] = 0;
        offX[i] = offZ[i] = 0;
        roleScale[i] = 1;
      }
    }

    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      personAt[i] = p;
      const from = p.pin ? homeSpot(p.punit)
                         : { x: (p.px == null ? p.x : p.px) + 0.5,
                             z: (p.py == null ? p.y : p.py) + 0.5 };
      fromX[i] = from.x;
      fromZ[i] = from.z;
      toX[i] = p.x + 0.5;
      toZ[i] = p.y + 0.5;
      offX[i] = (hash01(p.id, 11) * 2 - 1) * 0.17;
      offZ[i] = (hash01(p.id, 12) * 2 - 1) * 0.17;
      roleScale[i] = p.role === 'child' ? 0.78 : p.role === 'elder' ? 0.92 : 1;

      _c1.setHex(ROLE_COLOUR[p.role] === undefined ? 0xcccccc
                                                   : ROLE_COLOUR[p.role]);
      bodyMesh.setColorAt(i, _c1);
      _c1.setHex(SKIN[Math.floor(hash01(p.id, 13) * SKIN.length) % SKIN.length]);
      headMesh.setColorAt(i, _c1);
    }
    if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
    if (headMesh.instanceColor) headMesh.instanceColor.needsUpdate = true;

    occupied.clear();
    for (let i = 0; i < people.length; i++) {
      if (people[i].unit != null) occupied.add(people[i].unit);
    }
    occupancyDirty = true;

    t0 = performance.now();
    tickMs = Math.max(300, (st.tick_seconds || 6) * 1000);
  }

  function glided(now) {
    const raw = Math.min(1, Math.max(0, (now - t0) / tickMs));
    return raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2;
  }

  function updateResidents(now) {
    if (!bodyMesh) return;
    const e = glided(now);
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      if (p.in) {
        dummy.position.set(0, -50, 0);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(0, 0, 0);
        dummy.updateMatrix();
        bodyMesh.setMatrixAt(i, dummy.matrix);
        headMesh.setMatrixAt(i, dummy.matrix);
        continue;
      }
      const s = roleScale[i];
      const x = fromX[i] + (toX[i] - fromX[i]) * e + offX[i];
      const z = fromZ[i] + (toZ[i] - fromZ[i]) * e + offZ[i];
      const bob = Math.sin(now * 0.003 + i * 1.7) * 0.012;
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(s, s, s);
      dummy.position.set(x, WALK_Y + 0.31 * s + bob, z);
      dummy.updateMatrix();
      bodyMesh.setMatrixAt(i, dummy.matrix);
      dummy.position.set(x, WALK_Y + 0.72 * s + bob, z);
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

  function buildFixture(f, season) {
    const g = new THREE.Group();
    g.position.set(f.x + 0.5, TILE_TOP, f.y + 0.5);
    g.userData.pick = { kind: 'fixture', id: f.id };
    const mats = [];

    if (f.kind === 'tree') {
      treeMesh(g, mats, season, f.id);
    } else if (f.kind === 'bench') {
      const wood = fixtureMaterial(0x8a6a3f, 0.9);
      const metal = fixtureMaterial(0x454c54, 0.7);
      mats.push(wood, metal);
      addBox(g, wood.mat, 0.9, 0.08, 0.34, 0, 0.42, 0);
      addBox(g, wood.mat, 0.9, 0.3, 0.07, 0, 0.58, -0.16);
      addBox(g, metal.mat, 0.07, 0.42, 0.3, -0.34, 0.21, 0);
      addBox(g, metal.mat, 0.07, 0.42, 0.3, 0.34, 0.21, 0);
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
    } else if (f.kind === 'shop') {
      const wood = fixtureMaterial(0xcf9f60, 0.8);
      mats.push(wood);
      addBox(g, wood.mat, 0.9, 0.08, 0.9, 0, 0.55, 0);
      addBox(g, wood.mat, 0.85, 0.5, 0.85, 0, 0.27, 0);
    } else {
      /* a kind the page has never seen: a small plinth in its own colour,
       * so the estate still shows that something is there */
      const hex = fallbackSiteColour(f.kind);
      const mat = fixtureMaterial(hex, 0.85);
      mats.push(mat);
      addBox(g, mat.mat, 0.5, 0.3, 0.5, 0, 0.15, 0);
    }

    fixtureGroup.add(g);
    return { id: f.id, kind: f.kind, group: g, mats };
  }

  function buildFixtures(st) {
    clearFixtures();
    const season = Math.max(0, Math.min(3, st.season || 0));
    (st.fixtures || []).forEach(f => {
      fixtureEntries.push(buildFixture(f, season));
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
    const byId = {};
    (st.fixtures || []).forEach(f => { byId[f.id] = f; });
    fixtureEntries.forEach(fx => {
      const f = byId[fx.id];
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
  let haveState = false;
  let lastNow = 0;

  function setState(st) {
    haveState = true;
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
    paintWindows();
    lastNow = performance.now();
  }

  /* -------------------------------------------------------------- frame */

  const phaseInfo = { phase: 2, index: 2, name: 'afternoon', darkness: 0 };

  function phaseNow(now) {
    if (forcedPhase >= 0) return forcedPhase;
    if (!haveState) return 2;
    const t = (now - t0) / tickMs;
    return Math.max(0, Math.min(4.999, t * 5));
  }

  function frame(now) {
    const dt = Math.min(0.05, lastNow ? Math.max(0, (now - lastNow) / 1000)
                                      : 0.016);
    lastNow = now;
    const ph = phaseNow(now);
    updateSky(ph);
    const dark = darkness(ph);
    const night = dark > 0.2;
    if (night !== nightOn || occupancyDirty) {
      nightOn = night;
      occupancyDirty = false;
      paintWindows();
    }
    lampBulbMat.emissiveIntensity = 0.05 + dark * 2.6;
    shopSignMat.emissiveIntensity = 0.1 + dark * 1.8;
    glowMat.opacity = dark * 0.55;
    glow.visible = glowCount > 0 && dark > 0.02;

    updateResidents(now);
    updateWeather(dt, now);
    controls.update();
    renderer.render(scene, camera);

    const idx = Math.min(4, Math.floor(ph));
    phaseInfo.phase = ph;
    phaseInfo.index = idx;
    phaseInfo.name = PHASE_NAMES[idx];
    phaseInfo.darkness = dark;
    return phaseInfo;
  }

  /* -------------------------------------------------------------- pick */

  function pick(clientX, clientY, rect) {
    if (!haveState) return null;
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    if (bodyMesh) {
      const hits = raycaster.intersectObject(bodyMesh, false);
      if (hits.length) {
        const p = personAt[hits[0].instanceId];
        if (p) return { kind: 'resident', person: p };
      }
    }
    const bh = raycaster.intersectObjects(buildingBodies, false);
    if (bh.length) {
      const id = bh[0].object.userData.pick.id;
      return { kind: 'building', id, building: buildingById[id] };
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
    return { residents: people.length,
             buildings: (ground.buildings || []).length };
  }

  return {
    scene, camera, renderer, controls,
    setState, frame, resize, pick, stateSummary,
    phaseIndex: () => phaseInfo.index,
    phaseName: () => phaseInfo.name,
    hasState: () => haveState,
    staticMode,
  };
}
