/* viewer — the page's spine for the grove's 3D view.
 *
 * The same bargain the estate's view makes: the simulation owns every fact
 * and this page only asks. It polls `/api/state`, hands the frame to the
 * world (the scene) and to the HUD (the words), and sends the keeper's
 * buttons back as POSTs. Nothing here decides anything about the grove.
 *
 * These query parameters exist for the headless checks that look at this
 * page:
 *
 *   ?phase=night    freeze the light at the middle of one of the five
 *                   phases (dawn, morning, afternoon, evening, night;
 *                   `day`, `dusk` and `sunrise` are accepted as aliases)
 *   ?clock=0.2      pin the day's fraction, 0..1 from midnight to
 *                   midnight; it wins over `?phase=` if both are given
 *   ?static=1       draw the first state and stop. With no `phase` the
 *                   frozen light is afternoon, so a screenshot is legible.
 *   ?view=top       start overhead, the whole grove at once
 *   ?focus=x,y      frame one cell close up
 *   ?plain          show the glyph map (the no-WebGL view) on purpose
 *
 * When the first state has been drawn it publishes `window.__grove3d =
 * {ready, plants, animals, trees, flyers, walking, glow, phase, dayFrac,
 * static, routes}` — `routes` is `{active, maxWaypoints, fallbacks}` from
 * the shared router, `glow` how many cells the mushrooms' light reaches.
 */

import { createWorld } from './world.js';

const PHASES = ['dawn', 'morning', 'afternoon', 'evening', 'night'];
const PHASE_GLYPH = {
  dawn: '🌅', morning: '☀', afternoon: '☀', evening: '🌇', night: '☾',
};
const PHASE_ALIAS = {
  dawn: 0, sunrise: 0, morning: 1, noon: 2, day: 2, afternoon: 2,
  dusk: 3, sunset: 3, evening: 3, night: 4, midnight: 4,
};

/* the panels are a classic script (hud.js), pure DOM and testable in Node */
const HUD = (typeof globalThis !== 'undefined' && globalThis.GroveHUD) ||
            null;

const $ = id => document.getElementById(id);

const params = new URLSearchParams(window.location.search);
const phaseArg = (params.get('phase') || '').toLowerCase();
const STATIC = params.get('static') === '1';
const TOP = params.get('view') === 'top';
const FOCUS = (params.get('focus') || '').toLowerCase();
const PLAIN = params.has('plain');
const parsedPhase = Object.prototype.hasOwnProperty.call(PHASE_ALIAS, phaseArg)
  ? PHASE_ALIAS[phaseArg] : -1;
const forcedPhase = parsedPhase >= 0 ? parsedPhase : (STATIC ? 2 : -1);
const clockArg = params.get('clock');
const clockNum = clockArg == null || clockArg === '' ? NaN : Number(clockArg);
const clockFrac = Number.isFinite(clockNum) &&
                  clockNum >= 0 && clockNum <= 1 ? clockNum : -1;

const S = {
  state: null,
  world: null,
  selected: null,       // {kind:'animal'|'plant', id} or {kind:'cell', x, y}
  follow: false,
  pointerX: 0,
  pointerY: 0,
  hoverDirty: false,
  phaseLabel: -1,
  calm: false,
};

window.__grove3d = { ready: false };

function fetchJSON(url) {
  return fetch(url, { cache: 'no-store' }).then(r => {
    if (!r.ok) throw new Error(url + ' → ' + r.status);
    return r.json();
  });
}

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext &&
              (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) {
    return false;
  }
}

let plainTimer = 0;

/* No renderer, no grove? No: `/api/plain` is the server's own glyph map of
 * the same world, written into a <pre> with textContent, so the fallback
 * draws nothing and asks for the truth every tick or so. */
function fallback(why) {
  document.body.classList.add('nogl');
  $('nogl').hidden = false;
  $('noglWhy').textContent = why || 'this browser has no WebGL';
  const redraw = () => fetch('/api/plain', { cache: 'no-store' }).then(r => {
    if (!r.ok) throw new Error('/api/plain → ' + r.status);
    return r.text();
  }).then(text => {
    $('plain').textContent = text;
  }).catch(() => {
    $('plain').textContent = 'the glyph map is not answering.';
  });
  redraw();
  if (!plainTimer) plainTimer = setInterval(redraw, 1400);
}

/* --------------------------------------------------------------- the HUD */

function updateHUD(st) {
  if (HUD) HUD.update(st);
  const b = $('pauseBtn');
  b.textContent = st.paused ? '▶ play' : '⏸ pause';
  b.classList.toggle('on', !!st.paused);
  /* a week is stepped, and the soul invited, by hand only while paused */
  $('stepBtn').disabled = !st.paused;
  $('soulBtn').disabled = !st.paused || !(st.llm && st.llm.ok);
}

function phaseLabel(info) {
  if (info.index === S.phaseLabel) return;
  S.phaseLabel = info.index;
  const name = PHASES[info.index];
  $('phase').textContent = name;
  const glyph = $('phaseGlyph');
  glyph.textContent = PHASE_GLYPH[name] || '·';
  glyph.classList.toggle('night', name === 'night');
}

/* ------------------------------------------------------------- the card */

let bioAsked = 0;

function drawCard() {
  const open = HUD ? HUD.card(S.state, S.selected) : false;
  if (!HUD) $('card').classList.remove('on');
  $('followBtn').hidden = !(S.selected && S.selected.kind === 'animal');
  $('followBtn').classList.toggle('on', S.follow);
  return open;
}

/* The biography is the ledger's: asked once when a creature or a plant is
 * clicked, and its answer written only if that is still the one open. */
function askBio(sel) {
  if (!sel || (sel.kind !== 'animal' && sel.kind !== 'plant')) return;
  const ask = ++bioAsked;
  const id = Number(sel.id);
  fetchJSON('/api/bio?id=' + encodeURIComponent(id)).then(b => {
    if (ask !== bioAsked || !S.selected || S.selected.id !== id) return;
    if (HUD) HUD.bio(b, sel.name);
  }).catch(() => {});
}

function select(sel) {
  S.selected = sel;
  if (!sel || sel.kind !== 'animal') S.follow = false;
  if (drawCard()) askBio(sel);
  if (S.world) S.world.follow(S.follow && sel ? sel.id : null);
}

function showHover(hit) {
  const tip = $('tip');
  if (!hit) { tip.classList.remove('on'); return; }
  if (hit.kind === 'animal' || hit.kind === 'plant') {
    const e = hit.entity;
    tip.textContent = (e.n ? e.n + ' · ' : '') + e.sp +
      (hit.kind === 'plant' ? ' · ' + e.st : '');
  } else {
    tip.textContent = hit.terrain || 'the ground';
  }
  tip.style.left = (S.pointerX + 14) + 'px';
  tip.style.top = (S.pointerY + 14) + 'px';
  tip.classList.add('on');
}

/* ------------------------------------------------------------ the loop */

let ready = false;
let focusApplied = false;

function summary() {
  const s = S.world.stateSummary();
  Object.assign(window.__grove3d, s, {
    phase: S.world.phaseName(),
    dayFrac: S.world.dayFraction(),
    static: STATIC,
    routes: S.world.routeStats(),
  });
}

function publishReady() {
  if (ready) return;
  ready = true;
  window.__grove3d.ready = true;
  summary();
  document.body.dataset.grove3d = 'ready';
}

function applyFocus() {
  if (focusApplied || !FOCUS || !S.world) return;
  focusApplied = true;
  const m = /^(-?\d+),(-?\d+)$/.exec(FOCUS);
  if (m) S.world.focusCell(Number(m[1]), Number(m[2]));
  if (STATIC) S.world.frame(performance.now());
}

function tick(now) {
  if (!S.world) return;
  const info = S.world.frame(now);
  phaseLabel(info);
  if (ready) {
    window.__grove3d.phase = info.name;
    window.__grove3d.dayFrac = info.dayFrac;
  }
  if (S.hoverDirty) {
    S.hoverDirty = false;
    const r = $('view').getBoundingClientRect();
    showHover(S.world.pick(S.pointerX, S.pointerY, r));
  }
  if (!STATIC) requestAnimationFrame(tick);
}

/* --------------------------------------------------------------- polls */

let pollTimer = 0;
/* a button's POST asks for a poll at once; the sequence keeps that from
 * starting a second chain of polls beside the one already running */
let pollSeq = 0;

function first(st) {
  try {
    S.world = createWorld(st, $('view'), {
      forcedPhase, clockFrac, staticMode: STATIC, topView: TOP,
    });
  } catch (e) {
    fallback('WebGL could not start: ' + e.message);
    return false;
  }
  S.world.resize();
  $('engine').textContent = 'three.js';
  if (!STATIC) requestAnimationFrame(tick);
  return true;
}

function poll() {
  const my = ++pollSeq;
  window.clearTimeout(pollTimer);
  fetchJSON('/api/state').then(st => {
    if (my !== pollSeq) return;     // a newer poll is on its way
    if (st.error) {
      /* no world yet: say so where the plain map would be */
      fallback(st.error);
      return;
    }
    S.state = st;
    if (!S.world && !first(st)) return;
    S.world.setState(st);
    updateHUD(st);
    if (S.selected) drawCard();
    if (!ready) {
      phaseLabel(S.world.frame(performance.now()));
      publishReady();
    } else {
      summary();
    }
    applyFocus();
    if (STATIC) return;
    pollTimer = window.setTimeout(poll, 700);
  }).catch(() => {
    if (!STATIC && my === pollSeq) pollTimer = window.setTimeout(poll, 2000);
  });
}

/* ------------------------------------------------------------ controls */

function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(r => (r.ok ? r.json() : null)).catch(() => null);
}

function loadTuning() {
  return fetchJSON('/api/tuning').then(s => {
    if (HUD) HUD.setTuning(s);
  }).catch(() => {});
}

function ask() {
  const q = $('qinput').value.trim();
  if (!q) return;
  const out = $('askout');
  out.textContent = 'the grove ponders…';
  out.classList.add('pulse');
  $('askBtn').disabled = true;
  post('/api/ask', { q }).then(r => {
    out.classList.remove('pulse');
    /* the answer is a model's: textContent, never markup */
    out.textContent = r && r.answer ? '☾ ' + r.answer
                                    : 'the grove did not answer.';
  }).finally(() => { $('askBtn').disabled = false; });
}

function toggleCalm() {
  S.calm = !S.calm;
  document.body.classList.toggle('calm', S.calm);
}

function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen();
  }
}

function wire() {
  $('pauseBtn').onclick = () => post('/api/pause').then(poll);
  $('stepBtn').onclick = () => post('/api/step').then(poll);
  $('soulBtn').onclick = () => post('/api/soul').then(poll);
  $('fsBtn').onclick = fullscreen;
  $('askBtn').onclick = ask;
  $('qinput').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') ask();
  });
  $('cardClose').onclick = () => select(null);
  $('followBtn').onclick = () => {
    S.follow = !S.follow;
    $('followBtn').classList.toggle('on', S.follow);
    if (S.world) S.world.follow(S.follow && S.selected ? S.selected.id : null);
  };
  $('tabChron').onclick = () => HUD && HUD.tab('chron', S.state);
  $('tabCensus').onclick = () => HUD && HUD.tab('census', S.state);
  $('tabTune').onclick = () => {
    if (!HUD) return;
    HUD.tab('tune', S.state);
    loadTuning();
  };
  /* the steward's buttons are drawn by the HUD; one listener on the list
   * reads which, and the id is the number the HUD wrote */
  $('chron').addEventListener('click', ev => {
    const b = ev.target.closest ? ev.target.closest('button[data-a]') : null;
    if (!b) return;
    const a = b.dataset.a === 'accept' ? 'accept' : 'dismiss';
    b.disabled = true;
    post('/api/tuning/' + a, { id: Number(b.dataset.id) }).then(loadTuning);
  });

  window.addEventListener('keydown', ev => {
    if (ev.target && (ev.target.tagName === 'INPUT' ||
                      ev.target.tagName === 'TEXTAREA')) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === ' ') { ev.preventDefault(); $('pauseBtn').click(); }
    else if (ev.key === 's') { if (!$('stepBtn').disabled) $('stepBtn').click(); }
    else if (ev.key === 'n') { if (!$('soulBtn').disabled) $('soulBtn').click(); }
    else if (ev.key === 'f') fullscreen();
    else if (ev.key === 'c') toggleCalm();
    else if (ev.key === 'Escape') select(null);
  });

  const canvas = $('view');
  canvas.addEventListener('pointermove', ev => {
    S.pointerX = ev.clientX;
    S.pointerY = ev.clientY;
    S.hoverDirty = true;
    if (STATIC && S.world) {
      const r = canvas.getBoundingClientRect();
      showHover(S.world.pick(ev.clientX, ev.clientY, r));
    }
  });
  canvas.addEventListener('pointerleave', () => showHover(null));
  canvas.addEventListener('click', ev => {
    if (!S.world) return;
    const r = canvas.getBoundingClientRect();
    const hit = S.world.pick(ev.clientX, ev.clientY, r, true);
    if (!hit) { select(null); return; }
    if (hit.kind === 'animal' || hit.kind === 'plant') {
      select({ kind: hit.kind, id: hit.entity.id, name: hit.entity.n });
    } else {
      select({ kind: 'cell', x: hit.x, y: hit.y });
    }
  });

  window.addEventListener('resize', () => {
    if (!S.world) return;
    S.world.resize();
    if (STATIC) S.world.frame(performance.now());
  });
}

/* --------------------------------------------------------------- start */

function start() {
  wire();
  if (PLAIN) { fallback('the glyph map, as asked (?plain).'); return; }
  if (!webglAvailable()) {
    fallback('this browser has no WebGL');
    return;
  }
  poll();
}

start();
