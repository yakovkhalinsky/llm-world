/* viewer — the page's spine for the 3D view.
 *
 * The same bargain the plan page makes: the simulation owns every fact and
 * this page only asks. It fetches the ground once, polls the day, and hands
 * the frame to the world. The HUD reads the same frame, so a number in a
 * panel and a shape in the scene can never disagree.
 *
 * Two query parameters exist for the headless checks that look at this page:
 *
 *   ?phase=night    freeze the light at one of the five phases
 *                   (dawn, morning, afternoon, evening, night; `day`,
 *                   `dusk` and `sunrise` are accepted as aliases)
 *   ?static=1       draw the first state and stop. With no `phase` the
 *                   frozen light is afternoon, so a screenshot is legible
 *                   rather than a dawn taken from a standing start.
 *   ?view=top       start overhead, for looking at the whole plan at once.
 *
 * When the first state has been drawn it publishes
 * `window.__estate3d = {ready, residents, buildings, phase}`.
 */

import { createWorld } from './world.js';

const PHASES = ['dawn', 'morning', 'afternoon', 'evening', 'night'];
const PHASE_ALIAS = {
  dawn: 0, sunrise: 0, morning: 1, noon: 2, day: 2, afternoon: 2,
  dusk: 3, sunset: 3, evening: 3, night: 4, midnight: 4,
};

const $ = id => document.getElementById(id);

const params = new URLSearchParams(window.location.search);
const phaseArg = (params.get('phase') || '').toLowerCase();
const STATIC = params.get('static') === '1';
/* a plan-like overhead camera, for looking at the whole estate at once */
const TOP = params.get('view') === 'top';
const parsedPhase = Object.prototype.hasOwnProperty.call(PHASE_ALIAS, phaseArg)
  ? PHASE_ALIAS[phaseArg] : -1;
/* static with no named phase freezes at afternoon for a legible shot */
const forcedPhase = parsedPhase >= 0 ? parsedPhase
                   : (STATIC ? 2 : -1);

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
};

window.__estate3d = { ready: false };

function fetchJSON(url) {
  return fetch(url, { cache: 'no-store' }).then(r => {
    if (!r.ok) throw new Error(url + ' → ' + r.status);
    return r.json();
  });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;',
                                '"': '&quot;' })[c]);
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

function fallback(why) {
  document.body.classList.add('nogl');
  $('nogl').hidden = false;
  $('noglWhy').textContent = why || 'this browser has no WebGL';
}

/* --------------------------------------------------------------- the HUD */

const WEATHER_WORD = { clear: 'clear', rain: 'rain', storm: 'storm',
                       heat: 'heat', frost: 'frost' };

function glyphOf(group, key) {
  const g = (S.ground && S.ground.glyphs) || {};
  return ((g[group] || {})[key]) || '';
}

function head(st) {
  $('when').textContent =
    'day ' + st.day + ' · ' + st.season_name + ' · ' + st.weekday;
  $('weather').textContent =
    glyphOf('weather', st.weather) + ' ' +
    (WEATHER_WORD[st.weather] || st.weather);
  $('pops').innerHTML = '<b>' + st.residents + '</b> people · <b>' +
    (st.buildings || []).length + '</b> blocks · <b>' + st.units +
    '</b> flats' + (st.waiting ? ' · <b>' + st.waiting + '</b> waiting' : '');
  markPace(st.tick_seconds);
  const b = $('pauseBtn');
  b.textContent = st.paused ? '▶ play' : '⏸ pause';
  b.classList.toggle('on', !!st.paused);
}

function markPace(now) {
  Array.prototype.forEach.call($('speeds').querySelectorAll('button'), b => {
    b.classList.toggle('on', Math.abs(parseFloat(b.dataset.s) - now) < 0.01);
  });
}

function phaseLabel(info) {
  if (info.index === S.phaseLabel) return;
  S.phaseLabel = info.index;
  $('phase').textContent = PHASES[info.index];
}

/* ------------------------------------------------------------- the card */

function cardFor(sel) {
  const st = S.state;
  if (!st || !sel) return null;
  if (sel.kind === 'resident') {
    const p = st.people.filter(x => x.id === sel.id)[0];
    if (!p) return null;
    const needs = Object.keys(p.needs || {}).sort()
      .map(n => '<li><span>' + glyphOf('needs', n) + ' ' + esc(n) +
                '</span><span>' + p.needs[n].toFixed(2) + '</span></li>')
      .join('');
    return {
      name: p.name || 'a resident',
      state: glyphOf('roles', p.role) + ' ' + esc(p.role) + ' · age ' +
        p.age + ' · ' + esc(p.kind || '') + ' household<br>' +
        (p.in ? 'inside, flat ' + p.unit
              : 'out at ' + p.x + ',' + p.y) +
        (p.stress >= 1 ? ' · frayed ' + p.stress : ''),
      rows: needs,
    };
  }
  if (sel.kind === 'building') {
    const b = (S.ground.buildings || []).filter(x => x.id === sel.id)[0];
    const d = (st.buildings || []).filter(x => x.id === sel.id)[0] || {};
    if (!b) return null;
    return {
      name: b.name,
      state: b.kind + ' · ' + b.floors + ' floors · door at ' +
        b.door[0] + ',' + b.door[1] + '<br>' +
        (d.power ? 'power on' : 'no power') + ' · ' +
        (d.water ? 'water on' : 'no water'),
      rows: '<li><span>flats</span><span>' + (d.units || 0) + '</span></li>' +
        '<li><span>lived in</span><span>' + (d.lived || 0) + '</span></li>',
    };
  }
  return null;
}

function drawCard() {
  const c = cardFor(S.selected);
  const el = $('card');
  if (!c) { el.classList.remove('on'); return; }
  $('cardName').textContent = c.name;
  $('cardState').innerHTML = c.state;
  $('cardRows').innerHTML = c.rows;
  el.classList.add('on');
}

function showHover(hit) {
  const tip = $('tip');
  if (!hit) { tip.classList.remove('on'); S.hover = null; return; }
  S.hover = hit;
  if (hit.kind === 'resident') {
    tip.textContent = hit.person.name + ' · ' + hit.person.role;
  } else {
    tip.textContent = hit.building.name + ' · ' + hit.building.kind;
  }
  tip.style.left = (S.pointerX + 14) + 'px';
  tip.style.top = (S.pointerY + 14) + 'px';
  tip.classList.add('on');
}

/* ------------------------------------------------------------ the loop */

let rafId = 0;
let ready = false;

function publishReady() {
  if (ready) return;
  ready = true;
  const summary = S.world.stateSummary();
  window.__estate3d = {
    ready: true,
    residents: summary.residents,
    buildings: summary.buildings,
    phase: S.world.phaseName(),
    static: STATIC,
  };
  /* the same signal in the DOM, so a headless check that only dumps the
   * page can tell a drawn estate from a module that never ran */
  document.body.dataset.estate3d = 'ready';
}

function tick(now) {
  if (!S.world) return;
  const info = S.world.frame(now);
  phaseLabel(info);
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
      S.world.setState(st);
      head(st);
      if (S.selected) drawCard();
    }
    if (STATIC) {
      /* one frame, then hold perfectly still — a screenshot should not
       * depend on which millisecond the browser got around to it */
      if (S.world) {
        const info = S.world.frame(performance.now());
        phaseLabel(info);
        publishReady();
      }
      return;
    }
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
    const word = s >= 60 && s % 60 === 0 ? (s / 60) + ' min' : s + 's';
    return '<button data-s="' + s + '">' + word + '</button>';
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
  $('cardClose').onclick = () => {
    S.selected = null;
    drawCard();
  };

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
    const hit = S.world.pick(ev.clientX, ev.clientY, r);
    if (!hit) { S.selected = null; drawCard(); return; }
    S.selected = hit.kind === 'resident'
      ? { kind: 'resident', id: hit.person.id }
      : { kind: 'building', id: hit.building.id };
    drawCard();
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
  if (!webglAvailable()) {
    fallback('this browser has no WebGL');
    return;
  }
  fetchJSON('/api/ground').then(g => {
    S.ground = g;
    try {
      S.world = createWorld(g, $('view'), {
        forcedPhase, staticMode: STATIC, topView: TOP,
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
