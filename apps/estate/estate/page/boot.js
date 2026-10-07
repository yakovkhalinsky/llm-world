/* boot — the page's spine: fetching, the camera, and the controls.
 *
 * One rule from grove carries straight over: the simulation owns every
 * number, and the page only ever *asks*. Nothing here computes a fact the
 * engine already knows, and nothing here decides anything a resident
 * decided — if it did, there would be two copies of that fact, and one of
 * them would be wrong by the weekend.
 */

'use strict';

const CELL = 30;                 // world px per plan cell
const PAD = 28;                  // px of air around the plan

const S = {
  ground: null,                  // the static plan, fetched once
  state: null,                   // the day's frame
  zoom: 0,                       // 0 = fit, else a multiplier
  tick0: 0,                      // when the current frame arrived
  sel: null,                     // {kind, id} or null
  view: 'chron',
  havePixi: false,
};

function $(id) { return document.getElementById(id); }

function fetchJSON(url) {
  return fetch(url, { cache: 'no-store' }).then(r => {
    if (!r.ok) throw new Error(url + ' → ' + r.status);
    return r.json();
  });
}

/* ------------------------------------------------------------- the loop */

function poll() {
  fetchJSON('/api/state').then(st => {
    /* A person does not teleport. The new frame arrives with the day, and
     * the scene glides each of them from their last cell to this one over
     * the tick — which is what makes a day read as a day. */
    S.state = st;
    S.tick0 = performance.now();
    if (S.havePixi) Scene.update(st);
    Panels.update(st);
    setTimeout(poll, 700);
  }).catch(() => setTimeout(poll, 2000));
}

/* ------------------------------------------------------------- controls */

function post(body) {
  return fetch('/api/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function wire() {
  $('pauseBtn').onclick = () => {
    const p = !(S.state && S.state.paused);
    post({ paused: p });
    $('pauseBtn').textContent = p ? '▶ play' : '⏸ pause';
    $('pauseBtn').classList.toggle('on', p);
  };
  $('stepBtn').onclick = () => post({ step: 1 });
  $('fsBtn').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  };

  const zoom = z => {
    S.zoom = z;
    ['zoomFit', 'zoom1x', 'zoom2x'].forEach(id =>
      $(id).classList.toggle('on', $(id).dataset.z === String(z)));
    if (S.havePixi) Scene.resize();
  if (S.havePixi) Scene.mark();
  };
  $('zoomFit').dataset.z = '0';
  $('zoom1x').dataset.z = '1';
  $('zoom2x').dataset.z = '2';
  $('zoomFit').onclick = () => zoom(0);
  $('zoom1x').onclick = () => zoom(1);
  $('zoom2x').onclick = () => zoom(2);

  $('tabChron').onclick = () => Panels.tab('chron');
  $('tabCensus').onclick = () => Panels.tab('census');
  $('cardClose').onclick = () => { S.sel = null; Panels.card(null); };

  addEventListener('keydown', e => {
    if (e.key === ' ') { e.preventDefault(); $('pauseBtn').click(); }
    if (e.key === 's') $('stepBtn').click();
  });

  /* click the plan: a person if one is under the pointer, else the place */
  $('scene').addEventListener('click', ev => {
    if (!S.havePixi) return;
    const p = Scene.cellAt(ev.clientX, ev.clientY);
    if (p) Scene.pick(p.x, p.y);
  });
}

/* --------------------------------------------------------------- the page */

function plainFallback(why) {
  document.body.classList.add('plain');
  $('engine').textContent = why;
  $('hint').textContent = 'plain view';
  const redraw = () => fetch('/api/plain').then(r => r.text())
    .then(t => { $('plain').textContent = t; });
  redraw();
  setInterval(redraw, 1400);
}

function start() {
  wire();
  fetchJSON('/api/ground').then(g => {
    S.ground = g;
    if (window.PIXI && window.PIXI.Application) {
      S.havePixi = true;
      $('engine').textContent = 'pixi';
      Scene.init(g);
    } else {
      plainFallback('no pixi');
    }
    poll();
  }).catch(e => plainFallback('ground failed: ' + e.message));
}

start();
