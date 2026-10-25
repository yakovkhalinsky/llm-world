/* The grove viewer's card check: the page's side of the `/api/bio` ask.
 *
 * `page3d/viewer.js` asks the ledger when a creature or a plant is clicked
 * and keeps the answer in `S.ledger`, so every frame poll's redraw of the
 * card carries it. `tools/hud_check.js` covers how the card is written;
 * this covers when it is asked and what the poll does with the answer. It
 * loads the real viewer.js into a Node vm with a stub DOM, a stub HUD and
 * world, a `fetch` whose answers the check releases by hand, and a fake
 * clock, then walks five scenes:
 *
 *   kept      an answer survives the polls that follow it
 *   race      a late answer for A never lands on B's card, and A's
 *             superseded ask is aborted
 *   timeout   a hung ask is aborted through its signal, and fails plainly
 *   weekly    one quiet re-ask per week, not one per poll
 *   short     a hung ask with weeks shorter than the timeout still fails
 *   follow    '◎ follow' is offered on a creature's card only, and a
 *             press follows it; an open card hides the phone's bottom
 *             sheet (body.carded)
 *
 *   node tools/viewer_check.js
 *   GROVE_VIEWER=/path/to/mutant/viewer.js node tools/viewer_check.js
 *
 * The second form is how `tests/test_viewer_check.py` proves each scene
 * has teeth: it undoes one piece of the fix in a copy and expects a FAIL.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const VIEWER = process.env.GROVE_VIEWER ||
  path.join(__dirname, '..', 'grove', 'page3d', 'viewer.js');
const POLL_MS = 700;
const TIMEOUT_MS = 4000;

const fails = [];
function ok(name, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name +
              (cond || detail === undefined ? '' :
               '   (' + String(detail).slice(0, 300) + ')'));
  if (!cond) fails.push(name);
}

const flush = () => new Promise(r => setImmediate(r));
async function settle() { for (let i = 0; i < 8; i++) await flush(); }

/* One fresh page per scene: its own DOM, clock, fetch and viewer. */
function page() {
  const els = {};
  function El(id) {
    this.id = id;
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.dataset = {};
    const set = new Set();
    this.classList = {
      add: c => set.add(c), remove: c => set.delete(c),
      contains: c => set.has(c),
      toggle: (c, on) => { (on === undefined ? !set.has(c) : on)
        ? set.add(c) : set.delete(c); },
    };
    this.addEventListener = () => {};
    this.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800,
                                          height: 600 });
  }
  const document = {
    getElementById: id => els[id] || (els[id] = new El(id)),
    createElement: () => ({ getContext: () => ({}) }),
    body: new El('body'),
    documentElement: new El('html'),
  };

  /* the clock: timers run only when the scene moves time on */
  let now = 0, seq = 0;
  const timers = new Map();
  const setTimeout_ = (fn, ms) => {
    const id = ++seq;
    timers.set(id, { at: now + (ms || 0), fn });
    return id;
  };
  const clearTimeout_ = id => { timers.delete(id); };
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      await settle();
      let next = null;
      for (const [id, t] of timers) {
        if (t.at <= end && (!next || t.at < next[1].at ||
            (t.at === next[1].at && id < next[0]))) next = [id, t];
      }
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
    await settle();
  }

  /* the server: the frame is whatever the scene says; each bio ask waits
   * until the scene answers it (or forever, for a hung ledger) */
  const P = { tick: 1, asks: [], states: 0 };
  const res = body => ({ ok: true, status: 200, json: () => body });
  function fetch(url, opts) {
    if (url === '/api/state') {
      P.states++;
      return Promise.resolve(res({ tick: P.tick, paused: false,
                                   llm: { ok: false }, animals: [],
                                   plants: [] }));
    }
    if (url.indexOf('/api/bio?id=') === 0) {
      return new Promise((resolve, reject) => {
        const a = { id: Number(url.split('=')[1]), opts, done: false };
        a.answer = b => { if (!a.done) { a.done = true; resolve(res(b)); } };
        const sig = opts && opts.signal;
        if (sig) {
          if (sig.aborted) reject(new Error('aborted'));
          sig.addEventListener('abort', () => {
            if (!a.done) { a.done = true; reject(new Error('aborted')); }
          });
        }
        P.asks.push(a);
      });
    }
    return Promise.resolve(res({}));
  }

  /* the HUD: every card it is asked to draw, with the ledger it was given */
  const cards = [];
  const HUD = {
    update() {}, setTuning() {}, tab() {},
    card(st, sel, ledger) {
      cards.push({ sel, ledger: ledger ? JSON.parse(JSON.stringify(ledger))
                                       : null });
      return !!sel;
    },
  };
  const follows = [];
  const world = {
    resize() {}, setState() {}, follow(id) { follows.push(id); },
    focusCell() {},
    frame: () => ({ index: 2, name: 'afternoon', dayFrac: 0.5 }),
    stateSummary: () => ({}), phaseName: () => 'afternoon',
    dayFraction: () => 0.5, routeStats: () => ({}), pick: () => null,
  };

  const ctx = {
    document, console, fetch, AbortController, URLSearchParams,
    setTimeout: setTimeout_, clearTimeout: clearTimeout_,
    setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0,
    performance: { now: () => now },
    location: { search: '' },
    addEventListener: () => {},
    WebGLRenderingContext: function () {},
    GroveHUD: HUD,
    __createWorld: () => world,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);

  let src = fs.readFileSync(VIEWER, 'utf8');
  const imp = /^import \{ createWorld \} from '\.\/world\.js';$/m;
  if (!imp.test(src)) throw new Error('viewer.js no longer imports ' +
                                      'createWorld as this check expects');
  src = src.replace(imp, 'const createWorld = globalThis.__createWorld;') +
    '\nglobalThis.__viewer = { S, select, askBio, poll };\n';
  vm.runInContext(src, ctx, { filename: 'viewer.js' });

  const V = ctx.__viewer;
  return {
    P, cards, advance, settle, V, els, document, follows,
    lastCard: () => cards[cards.length - 1],
    bioAsks: () => P.asks.length,
  };
}

const led = l => (l ? l.id + ':' + l.state : 'null');

async function kept() {
  const p = page();
  await p.settle();
  p.V.select({ kind: 'animal', id: 7 });
  ok('kept: a click asks the ledger once', p.bioAsks() === 1, p.bioAsks());
  p.P.asks[0].answer({ id: 7, alive: true, events: [] });
  await p.settle();
  ok('kept: the answer reaches the card',
     led(p.lastCard().ledger) === '7:ok', led(p.lastCard().ledger));
  const before = p.cards.length;
  await p.advance(POLL_MS * 3);
  const redraws = p.cards.slice(before);
  ok('kept: the polls redraw the card', redraws.length >= 3, redraws.length);
  ok('kept: every poll\'s redraw still carries the answer',
     redraws.length > 0 && redraws.every(c => led(c.ledger) === '7:ok'),
     redraws.map(c => led(c.ledger)).join(' '));
}

async function race() {
  const p = page();
  await p.settle();
  p.V.select({ kind: 'animal', id: 7 });
  /* 7's answer is already on its way (too late to abort) when 8 is
   * clicked: it must be dropped, not written over 8's card */
  p.P.asks[0].answer({ id: 7, alive: true, events: [] });
  p.V.select({ kind: 'animal', id: 8 });
  ok('race: two clicks, two asks', p.bioAsks() === 2, p.bioAsks());
  await p.settle();
  ok('race: 7\'s late answer leaves 8 waiting on its own',
     led(p.V.S.ledger) === '8:wait', led(p.V.S.ledger));
  p.P.asks[1].answer({ id: 8, alive: true, events: [] });
  await p.settle();
  ok('race: 8\'s answer lands', led(p.V.S.ledger) === '8:ok',
     led(p.V.S.ledger));
  await p.advance(POLL_MS);
  ok('race: 8\'s card still shows 8\'s answer',
     led(p.lastCard().ledger) === '8:ok', led(p.lastCard().ledger));
  ok('race: the superseded ask was aborted',
     !!p.P.asks[0].opts.signal && p.P.asks[0].opts.signal.aborted);
}

async function timeout() {
  const p = page();
  await p.settle();
  p.V.select({ kind: 'animal', id: 7 });
  const a = p.P.asks[0];
  const sig = a.opts && a.opts.signal;
  ok('timeout: the ask carries an abort signal',
     !!sig && typeof sig.aborted === 'boolean', String(sig));
  await p.advance(TIMEOUT_MS - 100);
  ok('timeout: still waiting just before the timeout',
     led(p.V.S.ledger) === '7:wait', led(p.V.S.ledger));
  await p.advance(200);
  ok('timeout: the timeout aborts the fetch', !!sig && sig.aborted === true,
     sig && sig.aborted);
  ok('timeout: the card says the ledger did not answer',
     led(p.lastCard().ledger) === '7:fail', led(p.lastCard().ledger));
}

async function weekly() {
  const p = page();
  await p.settle();
  p.V.select({ kind: 'animal', id: 7 });
  p.P.asks[0].answer({ id: 7, alive: true, events: [] });
  await p.advance(POLL_MS * 5);
  ok('weekly: no re-ask while the week stays the same', p.bioAsks() === 1,
     p.bioAsks());
  p.P.tick = 2;
  await p.advance(POLL_MS);
  ok('weekly: a new week asks again, once', p.bioAsks() === 2, p.bioAsks());
  ok('weekly: the quiet re-ask keeps the rows it has',
     led(p.lastCard().ledger) === '7:ok', led(p.lastCard().ledger));
  p.P.asks[1].answer({ id: 7, alive: true, events: [] });
  await p.advance(POLL_MS * 4);
  ok('weekly: and no more until the next week', p.bioAsks() === 2,
     p.bioAsks());
}

async function short() {
  const p = page();
  await p.settle();
  p.V.select({ kind: 'animal', id: 7 });
  /* a hung ledger and a week every poll (--tick-seconds under 4) */
  for (let t = 0; t < 5; t++) {
    p.P.tick++;
    await p.advance(POLL_MS);
  }
  ok('short: no re-ask over an ask still waiting', p.bioAsks() === 1,
     p.bioAsks());
  for (let t = 0; t < 5; t++) {
    p.P.tick++;
    await p.advance(POLL_MS);
  }
  ok('short: the hung ask still ends in the plain line',
     led(p.V.S.ledger) === '7:fail' &&
     led(p.lastCard().ledger) === '7:fail',
     led(p.V.S.ledger) + ' / ' + led(p.lastCard().ledger));
}

async function follow() {
  const p = page();
  await p.settle();
  const btn = p.els.followBtn;
  p.V.select({ kind: 'cell', x: 1, y: 1 });
  ok('follow: a cell\'s card offers no follow', btn && btn.hidden === true,
     btn && btn.hidden);
  ok('follow: an open card hides the bottom sheet (body.carded)',
     p.document.body.classList.contains('carded'));
  p.V.select({ kind: 'animal', id: 7 });
  ok('follow: a creature\'s card offers "◎ follow"',
     btn.hidden === false && btn.textContent === '◎ follow',
     btn.hidden + ' ' + btn.textContent);
  ok('follow: not following until pressed', p.V.S.follow === false,
     p.V.S.follow);
  btn.onclick();
  ok('follow: a press follows the creature',
     p.V.S.follow === true && p.follows[p.follows.length - 1] === 7 &&
     btn.textContent === '◉ following' && btn.classList.contains('on'),
     p.V.S.follow + ' ' + p.follows.join(',') + ' ' + btn.textContent);
  btn.onclick();
  ok('follow: a second press lets it go',
     p.V.S.follow === false && p.follows[p.follows.length - 1] === null &&
     btn.textContent === '◎ follow', p.follows.join(','));
  p.V.select(null);
  ok('follow: closing the card brings the sheet back',
     !p.document.body.classList.contains('carded') && btn.hidden === true);
}

(async () => {
  for (const scene of [kept, race, timeout, weekly, short, follow]) {
    try { await scene(); } catch (e) {
      ok(scene.name + ' runs', false, e.stack);
    }
  }
  console.log('\n' + (fails.length ? fails.length + ' FAILED' : 'all ok'));
  process.exit(fails.length ? 1 : 0);
})();
