#!/usr/bin/env node
/* patch_check — `shared/page3d/patch.js` against a stub DOM.
 *
 * The habits a screenshot cannot catch: an unchanged list is not written
 * at all; a reader who scrolled keeps their row when a newest-first feed
 * grows above it, and one at the top stays at the top; a plain write keeps
 * the position; a pressed pointer or a selection holds the write until it
 * ends; a tab change (reset) starts at the top, even when it had to wait;
 * and counts read as an Australian writes them.
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
    const rows = (v.match(/<li/g) || []).length;
    const box = this._scroller || this;
    box.scrollHeight = rows * 20 + (box === this ? 0 : 400);
    box.scrollTop = 0;
  },
  contains(n) {
    return n === this || this.kids.some((k) => k === n || k.contains(n));
  },
  addEventListener(t, f) { (this.on[t] = this.on[t] || []).push(f); },
  fire(t) { (this.on[t] || []).forEach((f) => f({})); },
};

const ctx = {
  Intl, Object, String, Number, Math, isFinite,
  Date: { now: () => clock },
  performance: { now: () => clock },
  setTimeout: () => 1,      // flushes are driven by hand below
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

/* en-AU counts */
const F = [[1234, '1,234'], [1234567, '1,234,567'], [1234.6, '1,235'],
           [999, '999'], ['12', '12'], [-0.2, '0'], [0, '0'],
           [null, '—'], [undefined, '—'], ['', '—'], ['x', '—'],
           [NaN, '—'], [Infinity, '—']];
F.forEach(([n, want]) => {
  ok('fmt(' + (typeof n === 'string' ? JSON.stringify(n) : String(n)) + ') is ' + want, P.fmt(n) === want, P.fmt(n));
});

console.log(bad ? '\n' + bad + ' failed' : '\nall ok');
process.exit(bad ? 1 : 0);
