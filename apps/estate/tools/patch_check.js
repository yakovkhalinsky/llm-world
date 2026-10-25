#!/usr/bin/env node
/* patch_check — `shared/page3d/patch.js` against a stub DOM.
 *
 * The habits a screenshot cannot catch: an unchanged list is not written
 * at all; a reader who scrolled keeps their row when a newest-first feed
 * grows above it, and one at the top stays at the top; a plain write keeps
 * the position; a pressed pointer or a selection holds the write until it
 * ends; a tab change (reset) starts at the top, even when it had to wait;
 * and counts read as an Australian writes them. The capped feeds push rows
 * in at the top while old ones drop off the bottom (prepend k, drop k), and
 * the reader's row must stay put through that too; a selection holds only
 * its own panel, and only for a few seconds; a dropped list starts afresh;
 * the timers that land a held write fire and can fire again.
 *
 * The stub is unkind on purpose: every innerHTML write throws scrollTop
 * back to 0, as a browser can when a list's height dips mid-write, so a
 * patch that does not put the reader back is seen.
 *
 *   node tools/patch_check.js [path/to/patch.js]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = process.argv[2] ||
  path.join(__dirname, '..', '..', 'shared', 'page3d', 'patch.js');

let clock = 1000;
let selection = null;
const handlers = {};
const timers = [];          // [ms, fn] for each setTimeout the patch asks for

function El(name) {
  this.name = name;
  this.kids = [];
  this.writes = 0;
  this._inner = '';
  this.scrollTop = 0;
  this.scrollHeight = 0;
  this.on = {};
}
El.prototype = {
  get innerHTML() { return this._inner; },
  set innerHTML(v) {
    this._inner = v;
    this.writes += 1;
    const self = this;
    const box = this._scroller || this;
    /* each <li> a row 20 px tall, laid out from the top of the list (a
     * list in a card starts 40 px down it, under the heading) */
    const lead = box === this ? 0 : 40;
    this.children = [];
    const re = /<li(?: data-key="([^"]*)")?>(.*?)<\/li>/g;
    let m;
    while ((m = re.exec(v))) {
      const i = this.children.length, key = m[1], text = m[2].replace(/<[^>]*>/g, '');
      this.children.push({
        textContent: text,
        getAttribute: (a) => (a === 'data-key' && key !== undefined ? key : null),
        getBoundingClientRect: () => ({ top: lead + i * 20 - box.scrollTop, height: 20 }),
      });
    }
    box.scrollHeight = this.children.length * 20 + (box === this ? 0 : 400);
    box.scrollTop = 0;
    void self;
  },
  getBoundingClientRect() { return { top: 0, height: 200 }; },
  contains(n) {
    return n === this || this.kids.some((k) => k === n || k.contains(n));
  },
  addEventListener(t, f) { (this.on[t] = this.on[t] || []).push(f); },
  fire(t) { (this.on[t] || []).forEach((f) => f({})); },
  children: [],
};

const ctx = {
  Intl, Object, String, Number, Math, isFinite,
  Date: { now: () => clock },
  performance: { now: () => clock },
  /* nothing fires by itself: a check runs the timers it means to */
  setTimeout: (f, ms) => { timers.push([ms, f]); return timers.length; },
  clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1][1] = () => {}; },
  getSelection: () => selection,
  document: { addEventListener(t, f) { handlers[t] = f; } },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: SRC });
const P = ctx.Patch;

let bad = 0;
function ok(what, cond, got) {
  if (cond) console.log('  ok   ' + what);
  else { bad += 1; console.log('  FAIL ' + what + (got !== undefined ? ' — got ' + JSON.stringify(got) : '')); }
}
/* let every timer asked for so far run out, as time passing would */
function drain() {
  clock += 10000;
  timers.splice(0).forEach((t) => t[1]());
}
const rows = (n, tag) => Array.from({ length: n },
  (_, i) => '<li>' + (tag || 'r') + i + '</li>').join('');

/* the same html is no write */
let el = new El('feed');
P.write(el, rows(10));
const w0 = el.writes;
ok('the first write lands', w0 === 1 && el.innerHTML === rows(10), el.writes);
ok('the same list again is not written', P.write(el, rows(10)) === false &&
   el.writes === w0, el.writes);

/* a plain write keeps the reader where they were */
el.scrollTop = 60;
P.write(el, rows(10, 'q'));
ok('a changed list keeps the position', el.scrollTop === 60, el.scrollTop);

/* newest first: a reader down the list keeps their row */
el = new El('chron');
P.write(el, rows(10), { newestFirst: true });
el.scrollTop = 100;
P.write(el, '<li>new</li><li>new2</li><li>new3</li>' + rows(10),
        { newestFirst: true });
ok('rows added above move the reader by their height',
   el.scrollTop === 160, el.scrollTop);
el.scrollTop = 0;
P.write(el, '<li>newer</li><li>new</li><li>new2</li><li>new3</li>' +
        rows(10), { newestFirst: true });
ok('a reader at the top stays stuck to the top', el.scrollTop === 0,
   el.scrollTop);

/* a finger in the panel holds the write */
const card = new El('card');
const list = new El('rows');
card.kids.push(list);
P.hold(card, [list]);
P.write(list, rows(4));
card.scrollTop = 30;
card.fire('pointerdown');
const before = list.writes;
P.write(list, rows(5));
ok('a pressed pointer holds the write', list.writes === before &&
   list.innerHTML === rows(4), list.innerHTML);
card.fire('pointerup');
ok('letting go lands the held write', list.innerHTML === rows(5), list.innerHTML);
ok('and the card stays where it was scrolled', card.scrollTop === 30,
   card.scrollTop);

/* a selection in the list holds it */
selection = { isCollapsed: false, anchorNode: list };
P.write(list, rows(6));
ok('a selection holds the write', list.innerHTML === rows(5), list.innerHTML);
selection = null;
P.flush();
ok('the write lands once the selection ends', list.innerHTML === rows(6),
   list.innerHTML);

/* a fling still coasting holds it too */
card.fire('scroll');
P.write(list, rows(7));
ok('a list still scrolling is not written under the reader',
   list.innerHTML === rows(6), list.innerHTML);
clock += 1000;
P.flush();
ok('it lands when the scroll settles', list.innerHTML === rows(7),
   list.innerHTML);

/* a tab change starts at the top, even after a wait */
card.scrollTop = 80;
P.write(list, rows(7), { reset: true });
ok('a reset with the same html still goes to the top', card.scrollTop === 0,
   card.scrollTop);
card.scrollTop = 80;
card.fire('pointerdown');
P.write(list, rows(2, 'tab'), { reset: true });
P.write(list, rows(3, 'tab'));
card.fire('pointerup');
ok('a reset that waited is not lost to a later write',
   list.innerHTML === rows(3, 'tab') && card.scrollTop === 0,
   [list.innerHTML, card.scrollTop]);

/* the reset that waited is spent once it lands: a later held write is a
 * plain one and keeps the position */
card.scrollTop = 50;
card.fire('pointerdown');
P.write(list, rows(4, 'tab'));
card.fire('pointerup');
ok('a reset that landed does not carry over to the next held write',
   list.innerHTML === rows(4, 'tab') && card.scrollTop === 50,
   [list.innerHTML, card.scrollTop]);

/* en-AU counts */
const F = [[1234, '1,234'], [1234567, '1,234,567'], [1234.6, '1,235'],
           [999, '999'], ['12', '12'], [-0.2, '0'], [0, '0'],
           [null, '—'], [undefined, '—'], ['', '—'], ['x', '—'],
           [NaN, '—'], [Infinity, '—']];
F.forEach(([n, want]) => {
  ok('fmt(' + (typeof n === 'string' ? JSON.stringify(n) : String(n)) + ') is ' + want, P.fmt(n) === want, P.fmt(n));
});

/* --- capped newest-first feeds: rows in at the top, out at the bottom --- */
const feed = (keys) => keys.map((k) => '<li>' + k + '</li>').join('');
const range = (a, b) => Array.from({ length: b - a }, (_, i) => 'day ' + (a + i));
el = new El('capped');
P.write(el, feed(range(0, 10).reverse()), { newestFirst: true });   // day 9 .. day 0
el.scrollTop = 100;                                                  // day 4 at the top
P.write(el, feed(range(2, 12).reverse()), { newestFirst: true });   // +2 on top, 2 off the end
ok('prepend 2, drop 2: the row in view stays put', el.scrollTop === 140 &&
   el.children[7].textContent === 'day 4', el.scrollTop);
el.scrollTop = 150;                                                  // day 4 half out of view
P.write(el, feed(range(3, 13).reverse()), { newestFirst: true });
ok('prepend 1, drop 1: a half-hidden row keeps its offset', el.scrollTop === 170,
   el.scrollTop);
el = new El('grove14');
P.write(el, feed(range(0, 14).reverse()), { newestFirst: true });
el.scrollTop = 60;
for (let k = 1; k <= 4; k++) {                                     // four new weeks, one a time
  P.write(el, feed(range(k, 14 + k).reverse()), { newestFirst: true });
}
ok('prepend 4, drop 4 one at a time (the grove cap of 14): the same row in view',
   el.scrollTop === 140 && el.children[7].textContent === 'day 10', el.scrollTop);
el = new El('trim');
P.write(el, feed(range(0, 10).reverse()), { newestFirst: true });
el.scrollTop = 100;
P.write(el, feed(range(0, 7).reverse()), { newestFirst: true });   // 3 gone from the top
ok('rows gone from above move the reader up by as many', el.scrollTop === 40 &&
   el.children[2].textContent === 'day 4', el.scrollTop);
el = new El('gone');
P.write(el, feed(range(0, 10).reverse()), { newestFirst: true });
el.scrollTop = 140;                                                  // day 2 .. day 0 in view
P.write(el, feed(range(3, 16).reverse()), { newestFirst: true });   // +6 on top, those 3 gone
ok('when every row in view is gone, the reader moves by the height added',
   el.scrollTop === 200, el.scrollTop);
/* the same words twice: data-key tells them apart, else where they were */
const keyed = (ks) => ks.map((k) => '<li data-key="' + k + '">a slow day</li>').join('');
el = new El('keyed');
P.write(el, keyed(['w9', 'w8', 'w7', 'w6', 'w5', 'w4']), { newestFirst: true });
el.scrollTop = 60;                                                   // w6 at the top
P.write(el, keyed(['w11', 'w10', 'w9', 'w8', 'w7', 'w6']), { newestFirst: true });
ok('rows with the same words are told apart by data-key', el.scrollTop === 100,
   el.scrollTop);
el = new El('same');
P.write(el, feed(['a', 'x', 'x', 'x', 'b', 'c']), { newestFirst: true });
el.scrollTop = 40;                                                   // the second x at the top
P.write(el, feed(['n', 'a', 'x', 'x', 'x', 'b']), { newestFirst: true });
ok('without a key, a row of repeated words is placed by a one-off row near it',
   el.scrollTop === 60, el.scrollTop);

/* --- a selection holds only its own panel, and not for long --- */
drain();
const panelA = new El('panelA'), listA = new El('listA');
const panelB = new El('panelB'), listB = new El('listB');
panelA.kids.push(listA); panelB.kids.push(listB);
P.hold(panelA, [listA]); P.hold(panelB, [listB]);
P.write(listA, rows(2)); P.write(listB, rows(2));
selection = { isCollapsed: false, anchorNode: listA, focusNode: listA };
handlers.selectionchange();
P.write(listB, rows(3));
ok('a selection in one panel does not hold another', listB.innerHTML === rows(3),
   listB.innerHTML);
const tN = timers.length;
P.write(listA, rows(3));
ok('it holds its own', listA.innerHTML === rows(2), listA.innerHTML);
selection = { isCollapsed: false, anchorNode: new El('elsewhere'), focusNode: listA };
P.flush();
ok('a selection that ends in the panel holds it too', listA.innerHTML === rows(2),
   listA.innerHTML);
selection = { isCollapsed: false, anchorNode: listA, focusNode: listA };
P.write(listA, rows(4));
const selT = timers.slice(tN);
ok('a held selection sets a timer for when its hold runs out',
   selT.length === 1 && selT[0][0] > P.SETTLE_MS && selT[0][0] <= P.SELECT_MS,
   selT.map((t) => t[0]));
clock += P.SELECT_MS + 1;
timers.splice(0).forEach((t) => t[1]());
ok('a selection left behind stops holding after a few seconds',
   listA.innerHTML === rows(4), listA.innerHTML);
handlers.selectionchange();                                        // a new selection
P.write(listA, rows(5));
ok('a fresh selection holds again', listA.innerHTML === rows(4), listA.innerHTML);
selection = null;
handlers.selectionchange();
P.flush();
ok('and lets go when it is cleared', listA.innerHTML === rows(5), listA.innerHTML);

/* --- a dropped list starts afresh --- */
panelA.fire('pointerdown');
P.write(listA, rows(6, 'old'));
P.drop(listA);
panelA.fire('pointerup');
ok('a dropped list loses the write it was holding', listA.innerHTML === rows(5),
   listA.innerHTML);
const wD = listA.writes;
P.write(listA, rows(5));
ok('and its next write lands whole, even the same html', listA.writes === wD + 1,
   listA.writes - wD);

/* --- a new pick: Patch.fresh lets go of the selection and the card --- */
let removed = 0;
selection = { isCollapsed: false, anchorNode: listA, focusNode: listA,
              removeAllRanges() { removed += 1; selection = null; } };
handlers.selectionchange();
P.write(listA, rows(7, 'old'));
panelA.fire('scroll');
P.fresh([listA, null]);
ok('fresh lets go of the selection', removed === 1 && selection === null, removed);
const wF = listA.writes;
P.write(listA, rows(5));
ok('fresh: the held write is gone and the next one lands at once, mid-fling',
   listA.writes === wF + 1 && listA.innerHTML === rows(5), [listA.writes - wF, listA.innerHTML]);
P.flush();
ok('fresh: nothing old lands after it', listA.innerHTML === rows(5), listA.innerHTML);

/* --- every way a pointer lets go lands the write --- */
['pointerleave', 'pointercancel'].forEach((ev, i) => {
  panelB.fire('pointerdown');
  P.write(listB, rows(5 + i, ev));
  ok('a pressed pointer holds (' + ev + ')', listB.innerHTML !== rows(5 + i, ev),
     listB.innerHTML);
  panelB.fire(ev);
  ok(ev + ' lands the held write', listB.innerHTML === rows(5 + i, ev), listB.innerHTML);
});

/* --- a held write lands once: nothing is left queued or pending --- */
const wQ = listB.writes;
P.flush(); P.flush();
ok('a flush after the write landed writes nothing', listB.writes === wQ, listB.writes - wQ);
ok('the same list again is still no write', P.write(listB, rows(6, 'pointercancel')) === false &&
   listB.writes === wQ, listB.writes - wQ);

/* --- every list waiting lands, not just the first --- */
const panelC = new El('panelC'), c1 = new El('c1'), c2 = new El('c2'), c3 = new El('c3');
panelC.kids.push(c1, c2, c3);
P.hold(panelC, [c1, c2, c3]);
panelC.fire('pointerdown');
P.write(c1, rows(1, 'c')); P.write(c2, rows(2, 'c')); P.write(c3, rows(3, 'c'));
panelC.fire('pointerup');
ok('letting go lands every held list', c1.innerHTML === rows(1, 'c') &&
   c2.innerHTML === rows(2, 'c') && c3.innerHTML === rows(3, 'c'),
   [c1.innerHTML, c2.innerHTML, c3.innerHTML].map((h) => h.length));

/* --- the settle timer: set by a scroll, fires a flush, can be set again --- */
drain();
const panelD = new El('panelD'), d1 = new El('d1');
panelD.kids.push(d1);
P.hold(panelD, [d1]);
P.write(d1, rows(1));
let tD = timers.length;
panelD.fire('scroll');
P.write(d1, rows(2));
ok('a scroll sets a settle timer of SETTLE_MS', timers.length === tD + 1 &&
   timers[tD][0] === P.SETTLE_MS, timers.slice(tD).map((t) => t[0]));
clock += P.SETTLE_MS + 1;
timers[tD][1]();
ok('the settle timer lands the write', d1.innerHTML === rows(2), d1.innerHTML);
tD = timers.length;
panelD.fire('scroll');
P.write(d1, rows(3));
ok('a later scroll sets a fresh timer', timers.length === tD + 1, timers.length - tD);
clock += P.SETTLE_MS + 1;
timers[timers.length - 1][1]();
ok('and that one lands too', d1.innerHTML === rows(3), d1.innerHTML);

console.log(bad ? '\n' + bad + ' failed' : '\nall ok');
process.exit(bad ? 1 : 0);
