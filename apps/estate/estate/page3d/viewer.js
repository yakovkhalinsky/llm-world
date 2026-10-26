/* viewer — the page's spine for the 3D view.
 *
 * The bargain the estate makes: the simulation owns every fact and this page
 * only asks. It fetches the ground once, polls the day, and hands the frame
 * to the world. The HUD reads the same frame, so a number in a panel and a
 * shape in the scene can never disagree.
 *
 * These query parameters exist for the headless checks that look at this
 * page:
 *
 *   ?phase=night    freeze the light at the middle of one of the five
 *                   phases (dawn, morning, afternoon, evening, night;
 *                   `day`, `dusk` and `sunrise` are accepted as aliases)
 *   ?clock=0.2      pin the day's fraction, 0..1 from midnight to
 *                   midnight, for a screenshot of mid-dawn (0.2),
 *                   mid-dusk (0.8) or any hour between; it wins over
 *                   `?phase=` if both are given.
 *   ?static=1       draw the first state and stop. With no `phase` the
 *                   frozen light is afternoon, so a screenshot is legible
 *                   rather than a dawn taken from a standing start.
 *   ?view=top       start overhead, for looking at the whole plan at once.
 *   ?focus=bench    frame the camera close on the busiest occupied bench
 *                   (any bench if nobody is out).
 *   ?focus=perimeter
 *                   frame a stretch of the outer footpath, wide enough to
 *                   hold its benches and the people on them.
 *   ?focus=x,y     frames a named cell instead, for a close-up of a
 *                   particular place.
 *   ?show=morning  draw where everybody was at the end of one of today's
 *                   phases (the scrubber's buttons do the same), with the
 *                   light at that phase unless `phase` or `clock` say
 *                   otherwise: the live frame is always the end of a
 *                   day's night, and this is how a school morning is seen.
 *   ?trace=1       draw every current walking route as a line on the ground;
 *                   ?trace=<id> draws one resident's route only. The lines
 *                   are rebuilt when the day arrives, never inside a frame.
 *
 * When the first state has been drawn it publishes
 * `window.__estate3d = {ready, residents, buildings, benches, seated,
 * outside, walking, perimeter, phase, dayFrac, routes}` — `phase` and
 * `dayFrac` are the HUD's own clock and keep moving with the light;
 * `seated` is how many residents are on a bench now, `outside` how many
 * are not in a flat, `walking` how many the page is walking between
 * cells, `perimeter` how many are out on the estate's edge, and `routes`
 * is `{active, maxWaypoints, fallbacks}` from the router.
 */

import { createWorld } from './world.js';

const PHASES = ['dawn', 'morning', 'afternoon', 'evening', 'night'];
/* The pack names the phases but carries no glyph for them (its glyph map
 * is needs, households, fixtures, sites and weather), so this one display
 * fact lives here rather than being an emoji the server has to invent.
 * Night is a moon, not the same sun the afternoon uses. */
const PHASE_GLYPH = {
  dawn: '🌅', morning: '☀', afternoon: '☀', evening: '🌇', night: '☾',
};
const PHASE_ALIAS = {
  dawn: 0, sunrise: 0, morning: 1, noon: 2, day: 2, afternoon: 2,
  dusk: 3, sunset: 3, evening: 3, night: 4, midnight: 4,
};

/* the panels are a classic script (hud.js), pure DOM and testable in Node;
 * this module gives them the ground once and a state on every poll */
const HUD = (typeof globalThis !== 'undefined' && globalThis.EstateHUD) ||
            null;

const $ = id => document.getElementById(id);

const params = new URLSearchParams(window.location.search);
const phaseArg = (params.get('phase') || '').toLowerCase();
const STATIC = params.get('static') === '1';
/* a plan-like overhead camera, for looking at the whole estate at once */
const TOP = params.get('view') === 'top';
/* a close camera on the busiest bench, or on a named cell */
const FOCUS = (params.get('focus') || '').toLowerCase();
/* debug lines: every walking route, or one resident's */
const TRACE = params.get('trace') || '';
const parsedPhase = Object.prototype.hasOwnProperty.call(PHASE_ALIAS, phaseArg)
  ? PHASE_ALIAS[phaseArg] : -1;
/* one of today's phases to show rather than the live frame (-1: live) */
const showArg = (params.get('show') || '').toLowerCase();
const showPhase = PHASES.indexOf(showArg);
/* static with no named phase freezes at afternoon for a legible shot; a
 * shown phase is lit as itself */
const forcedPhase = parsedPhase >= 0 ? parsedPhase
                   : showPhase >= 0 ? showPhase
                   : (STATIC ? 2 : -1);
/* a pinned fraction of the day, for a screenshot of any hour; -1 is unset */
const clockArg = params.get('clock');
const clockNum = clockArg == null || clockArg === '' ? NaN : Number(clockArg);
const clockFrac = Number.isFinite(clockNum) &&
                  clockNum >= 0 && clockNum <= 1 ? clockNum : -1;

const S = {
  ground: null,
  state: null,
  world: null,
  selected: null,       // {kind:'resident', id} or {kind:'building', id}
  hover: null,
  pointerX: 0,
  pointerY: 0,
  hoverDirty: false,
  phaseLabel: -1,
  show: showPhase,      // which of today's phases is drawn; -1 is live
};

/* the frame the scene and the panels draw: the live state, or one of
 * today's phases laid over it (hud.js `phaseView`) */
function framed(st) {
  return HUD && st ? HUD.phaseView(st, S.show) : st;
}

function drawShows(st) {
  const box = $('shows');
  if (!box || !HUD) return;
  /* written only when it changed (patch.js), so a button is not
   * replaced under the click that is pressing it; the one click handler
   * is on the box (wire) */
  window.Patch.write(box, HUD.scrubber(st, S.show));
}

function pickShow(ev) {
  const b = ev.target && ev.target.closest && ev.target.closest('button');
  if (!b || b.dataset.i === undefined) return;
  S.show = Number(b.dataset.i);
  if (S.world) S.world.setPhaseView(S.show);
  if (S.state) show(S.state);
}

function show(st) {
  const f = framed(st);
  S.world.setState(f);
  updateHUD(f);
  drawShows(st);
  if (S.selected) drawCard();
  if (STATIC) S.world.frame(performance.now());
}

window.__estate3d = { ready: false };

function fetchJSON(url) {
  return fetch(url, { cache: 'no-store' }).then(r => {
    if (!r.ok) throw new Error(url + ' → ' + r.status);
    return r.json();
  });
}

/* one escaper for the page, and it lives in hud.js (which loads first);
 * without the HUD there is nothing safe to write, so nothing is written */
const esc = HUD ? HUD.esc : () => '';

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

function fallback(why) {
  document.body.classList.add('nogl');
  $('nogl').hidden = false;
  $('noglWhy').textContent = why || 'this browser has no WebGL';
  /* The estate is still here without a renderer: `/api/plain` is the
   * server's own glyph map of the same world, so the fallback draws
   * nothing and asks for one frame of the truth. */
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

/* The header, the day feed, the census and the watcher tab live in hud.js
 * so the same words can be checked without a browser. This module owns the
 * scene and the controls; it hands the panels a ground once and a state on
 * every poll. */
function updateHUD(st) {
  if (HUD) HUD.update(st);
  markPace(st.tick_seconds);
  const b = $('pauseBtn');
  b.textContent = st.paused ? '▶ play' : '⏸ pause';
  b.classList.toggle('on', !!st.paused);
  /* a day is stepped by hand only while paused, as the grove's week */
  $('stepBtn').disabled = !st.paused;
}

function markPace(now) {
  Array.prototype.forEach.call($('speeds').querySelectorAll('button'), b => {
    b.classList.toggle('on', Math.abs(parseFloat(b.dataset.s) - now) < 0.01);
  });
}

function phaseLabel(info) {
  if (info.index === S.phaseLabel) return;
  S.phaseLabel = info.index;
  const name = PHASES[info.index];
  /* the live header counts who is at school and at work in the phase the
   * clock is at (hud.js `countFrame`) */
  if (HUD && HUD.setClock(name) && S.state) HUD.head(framed(S.state));
  $('phase').textContent = name;
  const glyph = $('phaseGlyph');
  glyph.textContent = PHASE_GLYPH[name] || '·';
  glyph.classList.toggle('night', name === 'night');
}

/* ------------------------------------------------------------- the card */

function drawCard() {
  const open = HUD ? HUD.card(framed(S.state), S.selected) : false;
  if (!HUD) $('card').classList.remove('on');
  /* on a phone the card takes the bottom sheet's place (style.css) */
  document.body.classList.toggle('carded', !!open);
}

/* a new thing picked starts its card at the top, and replaces it whole:
 * the old selection goes and the card's lists forget what they were
 * holding, so the new name never sits over the old state */
function select(sel) {
  S.selected = sel;
  $('card').scrollTop = 0;
  if (window.Patch && window.Patch.fresh) {
    window.Patch.fresh([$('cardState'), $('cardRows')]);
  }
  drawCard();
}

function siteAt(x, y) {
  const g = S.ground;
  if (!g || !g.rows || !g.rows[y] || g.rows[y][x] === undefined) return '';
  return g.codes[g.rows[y][x]];
}

function showHover(hit) {
  const tip = $('tip');
  if (!hit) { tip.classList.remove('on'); S.hover = null; return; }
  S.hover = hit;
  if (hit.kind === 'resident') {
    tip.textContent = hit.person.name;   // as the card heads it
  } else if (hit.kind === 'building') {
    tip.textContent = hit.building.name;   // as the card heads it
  } else if (hit.kind === 'fixture') {
    const kind = (hit.fixture && hit.fixture.kind) || 'a place';
    // as the card heads it: "🚏 bus stop", not the raw kind
    tip.textContent = HUD ? HUD.glyphOf('fixtures', kind) + ' ' + HUD.kindName(kind) : kind;
  } else {
    tip.textContent = siteAt(hit.cell.x, hit.cell.y) || 'the ground';
  }
  tip.style.left = (S.pointerX + 14) + 'px';
  tip.style.top = (S.pointerY + 14) + 'px';
  tip.classList.add('on');
}

/* ------------------------------------------------------------ the loop */

let rafId = 0;
let ready = false;
let focusApplied = false;

function publishReady() {
  if (ready) return;
  ready = true;
  const summary = S.world.stateSummary();
  window.__estate3d = {
    ready: true,
    residents: summary.residents,
    buildings: summary.buildings,
    benches: summary.benches,
    seated: summary.seated,
    outside: summary.outside,
    walking: summary.walking,
    perimeter: summary.perimeter,
    phase: S.world.phaseName(),
    dayFrac: S.world.dayFraction(),
    static: STATIC,
    routes: S.world.routeStats(),
  };
  /* the same signal in the DOM, so a headless check that only dumps the
   * page can tell a drawn estate from a module that never ran */
  document.body.dataset.estate3d = 'ready';
}

/* Once, when the first state (and so the people) has arrived: a screenshot
 * taken after a poll should already be framed. */
function applyFocus() {
  if (focusApplied || !FOCUS || !S.world) return;
  focusApplied = true;
  if (FOCUS === 'bench') {
    S.world.focusBench();
  } else if (FOCUS === 'perimeter') {
    S.world.focusPerimeter();
  } else {
    const m = /^(-?\d+),(-?\d+)$/.exec(FOCUS);
    if (m) S.world.focusCell(Number(m[1]), Number(m[2]));
  }
  /* static mode has no animation loop, and the first render happened before
   * the camera moved — draw the focused frame now */
  if (STATIC) S.world.frame(performance.now());
}

/* The debug hook carries the same clock the HUD and the light read, so a
 * headless check can ask what hour the picture is at instead of guessing
 * from the pixels. Two assignments, no object, no allocation per frame. */
function publishClock(info) {
  if (!ready) return;
  window.__estate3d.phase = info.name;
  window.__estate3d.dayFrac = info.dayFrac;
}

function tick(now) {
  if (!S.world) return;
  const info = S.world.frame(now);
  phaseLabel(info);
  publishClock(info);
  if (!ready && S.world.hasState()) publishReady();
  if (S.hoverDirty && S.world) {
    S.hoverDirty = false;
    const r = $('view').getBoundingClientRect();
    showHover(S.world.pick(S.pointerX, S.pointerY, r));
  }
  if (!STATIC) rafId = requestAnimationFrame(tick);
}

/* --------------------------------------------------------------- polls */

let pollTimer = 0;

function poll() {
  fetchJSON('/api/state').then(st => {
    S.state = st;
    if (S.world) {
      S.world.setState(framed(st));
      updateHUD(framed(st));
      drawShows(st);
      if (S.selected) drawCard();
      /* The first state is drawn here rather than waiting for the next
       * animation frame. A headless check may never get one — and
       * `ready` means the estate is on screen, not that a compositor
       * decided to tick. */
      if (!ready) {
        const info = S.world.frame(performance.now());
        phaseLabel(info);
        publishReady();
      }
      /* the counts move with the estate, and a headless check is entitled
       * to ask for them on any poll, not only the first */
      const summary = S.world.stateSummary();
      window.__estate3d.seated = summary.seated;
      window.__estate3d.benches = summary.benches;
      window.__estate3d.outside = summary.outside;
      window.__estate3d.walking = summary.walking;
      window.__estate3d.perimeter = summary.perimeter;
      window.__estate3d.routes = S.world.routeStats();
      applyFocus();
    }
    if (STATIC) return;
    pollTimer = window.setTimeout(poll, 700);
  }).catch(() => {
    if (!STATIC) pollTimer = window.setTimeout(poll, 2000);
  });
}

/* ------------------------------------------------------------ controls */

function post(body) {
  return fetch('/api/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function speeds(list) {
  const box = $('speeds');
  const speedsList = list && list.length ? list : [60, 20, 5];
  box.innerHTML = speedsList.map(s => {
    const n = Number(s);
    const word = n >= 60 && n % 60 === 0 ? (n / 60) + ' min' : n + 's';
    return '<button data-s="' + n + '">' + esc(word) + '</button>';
  }).join('');
  Array.prototype.forEach.call(box.querySelectorAll('button'), b => {
    b.onclick = () => post({ tick_seconds: parseFloat(b.dataset.s) });
  });
}

function wire() {
  $('pauseBtn').onclick = () => {
    const p = !(S.state && S.state.paused);
    post({ paused: p });
  };
  $('stepBtn').onclick = () => post({ step: 1 });
  $('cardClose').onclick = () => select(null);
  $('shows').addEventListener('click', pickShow);
  /* a list under a finger, or with text selected in it, is not rewritten
   * until it is let go (patch.js) */
  window.Patch.hold($('chron'));
  window.Patch.hold($('card'), [$('cardState'), $('cardRows')]);
  $('fsBtn').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  };
  $('tabChron').onclick = () => HUD && HUD.tab('chron', S.state);
  $('tabCensus').onclick = () => HUD && HUD.tab('census', S.state);
  $('tabWatch').onclick = () => HUD && HUD.tab('watch', S.state);

  const canvas = $('view');
  canvas.addEventListener('pointermove', ev => {
    S.pointerX = ev.clientX;
    S.pointerY = ev.clientY;
    S.hoverDirty = true;
    if (STATIC && S.world) {
      /* no animation loop to notice the flag */
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
    if (hit.kind === 'resident') {
      /* the name stays with the pick, so a card for someone who has since
       * left can still say who */
      select({ kind: 'resident', id: hit.person.id, name: hit.person.name });
    } else if (hit.kind === 'building') {
      select({ kind: 'building', id: hit.building.id });
    } else if (hit.kind === 'fixture') {
      select({ kind: 'fixture', id: hit.fixture.id });
    } else {
      select({ kind: 'cell', x: hit.cell.x, y: hit.cell.y });
    }
  });

  fitHint();
  window.addEventListener('resize', () => {
    fitHint();
    if (!S.world) return;
    S.world.resize();
    if (STATIC) S.world.frame(performance.now());
  });
}

/* The hint at the foot is one line, whole, or not there: the keys drop
 * first when the gap between the panels is narrow, then the hint itself;
 * it never ends in "…". */
function fitHint() {
  const h = $('hint');
  if (!h || !h.querySelector || !h.classList) return;
  const keys = h.querySelector('.keys');
  h.classList.remove('cut');
  if (keys) keys.hidden = false;
  const over = () => h.scrollWidth > h.clientWidth + 1;
  if (keys && over()) keys.hidden = true;
  if (over()) h.classList.add('cut');
}

/* --------------------------------------------------------------- start */

function start() {
  wire();
  if (!webglAvailable()) {
    fallback('this browser has no WebGL');
    return;
  }
  fetchJSON('/api/ground').then(g => {
    S.ground = g;
    if (HUD) HUD.setGround(g);
    try {
      S.world = createWorld(g, $('view'), {
        forcedPhase, clockFrac, staticMode: STATIC, topView: TOP,
        trace: TRACE,
      });
    } catch (e) {
      fallback('WebGL could not start: ' + e.message);
      return;
    }
    S.world.resize();
    $('engine').textContent = 'three.js';
    speeds(g.speeds);
    if (!STATIC) rafId = requestAnimationFrame(tick);
    poll();
  }).catch(e => fallback('the ground would not load: ' + e.message));
}

start();
