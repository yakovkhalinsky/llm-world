/* The grove HUD's headless check.
 *
 * `page3d/hud.js` writes the words around the scene: the header, the
 * chronicle, the census, the steward's tab, and the card for whatever was
 * clicked. Much of what it writes is a language model's — the chronicle,
 * the soul's line, the steward's rules, reasons and verdicts, the
 * biographies — so this check feeds it a hostile string in *every* field
 * of every payload, numbers included, and asserts that nothing reaches
 * innerHTML as markup: every string comes out escaped, every number comes
 * out a number (or NaN), and the text still arrives (an escaper that drops
 * everything would pass a check that only looked for the absence of tags).
 *
 * It is pure DOM, so it runs against a stub document in Node.
 *
 *   node tools/hud_check.js
 *   GROVE_HUD=/path/to/mutant/hud.js node tools/hud_check.js
 *
 * The second form is how `tests/test_hud_check.py` proves the check has
 * teeth: it strips each `esc(` and `Number(` wrapper from a copy of hud.js
 * in turn and expects this check to fail on every one.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HUD = process.env.GROVE_HUD ||
  path.join(__dirname, '..', 'grove', 'page3d', 'hud.js');

/* the hostile string: a tag, an attribute breakout both ways, an entity */
const TAG = '<img src=x onerror=alert(1)>" onmouseover="x\' onfocus=\'y &amp;';
const RAW = ['<img', '" onmouseover', "' onfocus"];
const ESCAPED = '&lt;img src=x onerror=alert(1)&gt;&quot; onmouseover=&quot;x' +
  '&#39; onfocus=&#39;y &amp;amp;';

/* --------------------------------------------------------------- stubs */

function El(id) {
  this.id = id;
  this.textContent = '';
  this.innerHTML = '';
  this.title = '';
  this.className = '';
  this.dataset = {};
  const set = new Set();
  this.classList = {
    add: c => set.add(c), remove: c => set.delete(c),
    contains: c => set.has(c),
    toggle: (c, on) => { on ? set.add(c) : set.delete(c); },
  };
}

const els = {};
const document = {
  getElementById: id => els[id] || (els[id] = new El(id)),
};

const fails = [];
function ok(name, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name +
              (cond || !detail ? '' : '   (' + String(detail).slice(0, 300) +
               ')'));
  if (!cond) fails.push(name);
}

const ctx = { document, console };
ctx.globalThis = ctx;
vm.createContext(ctx);
try {
  vm.runInContext(fs.readFileSync(HUD, 'utf8'), ctx, { filename: 'hud.js' });
} catch (e) {
  ok('hud.js runs', false, e.message);
}
const H = ctx.GroveHUD;
if (!H) {
  ok('hud.js publishes GroveHUD', false);
  console.log('\n' + fails.length + ' FAILED');
  process.exit(1);
}

/* every element's markup is free of the raw string */
function clean(label) {
  for (const id of Object.keys(els)) {
    const html = els[id].innerHTML;
    const bad = RAW.filter(r => html.indexOf(r) >= 0);
    ok(label + ': #' + id + ' carries no live markup', bad.length === 0,
       html);
  }
}
function step(label, fn) {
  try { fn(); } catch (e) { ok(label + ' runs', false, e.stack); }
}

/* --------------------------------------------------- the hostile frame */

const state = {
  size: 3, tick: TAG, season: TAG, weather: TAG, weather_emo: TAG,
  paused: false, soul: TAG,
  llm: { status: TAG, reason: TAG,
         fail: { job: TAG, model: TAG, why: TAG, raw: TAG } },
  pop_chips: [{ emo: TAG, name: TAG, n: TAG }],
  chronicle: [{ tick: TAG, text: TAG, source: TAG },
              { tick: 3, text: TAG, source: 'llm' }],
  series: [{ emo: TAG, name: TAG, values: [1, 2, TAG] }],
  cells: [['s', TAG, TAG, 1, 1, 0], ['w', 0.2, 0.3, 0, 0, 0],
          ['r', 0, 0, 0, 0, 0], ['s', 0, 0, 0, 0, 0],
          ['s', 0, 0, 0, 0, 0], ['s', 0, 0, 0, 0, 0],
          ['s', 0, 0, 0, 0, 0], ['s', 0, 0, 0, 0, 0],
          ['s', 0, 0, 0, 0, 0]],
  glow: [TAG, 0, 0, 0, 0, 0, 0, 0, 0],
  animals: [{ id: 7, sp: TAG, x: TAG, y: TAG, px: 0, py: 0, ag: TAG,
              h: TAG, n: TAG }],
  plants: [{ id: 9, sp: TAG, x: TAG, y: TAG, st: TAG, el: TAG, b: TAG,
             n: TAG }],
};

const tuning = {
  auto_tune: false,
  pending: [{ id: TAG, week: TAG, rule: TAG, value: TAG, why: TAG,
              status: TAG, was: TAG },
            { id: 2, week: 4, rule: TAG, value: TAG, why: TAG,
              status: 'pending', was: null }],
  history: [{ id: TAG, week: TAG, rule: TAG, value: TAG, why: TAG,
              status: TAG, was: TAG }],
  last: { week: TAG, amendments: TAG, verdict: TAG },
};

/* ----------------------------------------------------------- the checks */

ok('esc() leaves no tag or quote', !/[<>"']/.test(H.esc(TAG)), H.esc(TAG));
ok('esc() escapes the whole string', H.esc(TAG) === ESCAPED, H.esc(TAG));

step('the chronicle tab', () => { H.tab('chron', state); H.update(state); });
clean('chronicle');
ok('the chronicle carries the text, escaped',
   els.chron.innerHTML.split(ESCAPED).length - 1 === 2, els.chron.innerHTML);
ok('the population line carries the names, escaped',
   els.pops.innerHTML.split(ESCAPED).length - 1 === 2, els.pops.innerHTML);
ok('a count that is not a number is written as NaN',
   els.pops.innerHTML.indexOf('<span class="pnum">NaN</span>') >= 0,
   els.pops.innerHTML);
ok('a week that is not a number is written as NaN',
   els.chron.innerHTML.indexOf('NaNwk ago') >= 0 &&
   els.when.textContent.indexOf('week NaN') === 0,
   els.chron.innerHTML);
ok('the mark is from the fixed table, not the frame',
   els.chron.innerHTML.indexOf('class="mark-template"') >= 0 &&
   els.chron.innerHTML.indexOf('class="mark-llm"') >= 0, els.chron.innerHTML);
ok('the soul line is text', els.soul.textContent === '☾ ' + TAG);

step('the census tab', () => H.tab('census', state));
clean('census');
ok('the census carries the names, escaped',
   els.chron.innerHTML.split(ESCAPED).length - 1 === 2, els.chron.innerHTML);
const sparkText = (els.chron.innerHTML.match(
  /<span class="spark">([^<]*)<\/span>/) || [])[1] || '';
ok('the sparkline is blocks only, whatever the values',
   /^[\u2581-\u2588]{3}$/.test(sparkText), sparkText);
ok('the census count that is not a number is NaN',
   els.chron.innerHTML.indexOf('<b>NaN</b>') >= 0, els.chron.innerHTML);

step('the steward tab', () => { H.tab('tune', state); H.setTuning(tuning); });
clean('steward');
const tuneHtml = els.chron.innerHTML;
ok('the steward tab is drawn', tuneHtml.indexOf('the world\'s amendments') >= 0,
   tuneHtml);
/* rule, was, value, why for the first; rule, value, why for the second;
 * rule, was, value, status for the history; the verdict */
ok('the steward\'s words are all there, escaped',
   tuneHtml.split(ESCAPED).length - 1 === 12,
   tuneHtml.split(ESCAPED).length - 1);
ok('a proposal id that is not a number is NaN in the button',
   tuneHtml.indexOf('data-id="NaN"') >= 0 && tuneHtml.indexOf('data-id="2"') >= 0,
   tuneHtml);
ok('weeks and the amendment count that are not numbers are NaN',
   tuneHtml.indexOf('wkNaN — ') >= 0 && tuneHtml.indexOf('· wkNaN') >= 0 &&
   tuneHtml.indexOf('at wkNaN — NaN amendment') >= 0, tuneHtml);
step('the steward under auto-tune', () =>
  H.setTuning(Object.assign({}, tuning, { auto_tune: true })));
ok('auto-tune draws no buttons', els.chron.innerHTML.indexOf('<button') < 0,
   els.chron.innerHTML);
clean('steward auto');
step('back to the chronicle', () => H.tab('chron', state));

step('a creature\'s card', () => H.card(state, { kind: 'animal', id: 7 }));
clean('animal card');
ok('the card is open', els.card.classList.contains('on'));
ok('the creature\'s name is text', els.cardName.textContent.indexOf(TAG) === 0,
   els.cardName.textContent);
ok('the creature\'s numbers are NaN',
   els.cardState.innerHTML.indexOf('age NaNwk') === 0 &&
   els.cardState.innerHTML.indexOf('at NaN,NaN') >= 0, els.cardState.innerHTML);

step('a plant\'s card', () => H.card(state, { kind: 'plant', id: 9 }));
clean('plant card');
ok('the plant\'s stage is there, escaped',
   els.cardState.innerHTML.indexOf(ESCAPED) === 0, els.cardState.innerHTML);
ok('the plant\'s place is NaN', els.cardState.innerHTML.indexOf('at NaN,NaN') >= 0,
   els.cardState.innerHTML);

step('a cell\'s card', () => H.card(state, { kind: 'cell', x: 0, y: 0 }));
clean('cell card');
ok('the cell card is open on soil', els.cardName.textContent === 'soil',
   els.cardName.textContent);
ok('the cell\'s grass and moisture are NaN, its glow nothing',
   (els.cardRows.innerHTML.match(/<span>NaN<\/span>/g) || []).length === 2 &&
   els.cardRows.innerHTML.indexOf('<span>glow</span><span>0.00</span>') >= 0,
   els.cardRows.innerHTML);
step('a cell picked with its coordinates as strings',
     () => H.card(state, { kind: 'cell', x: '1', y: '0' }));
ok('coordinates are read as numbers, not joined as strings',
   els.cardName.textContent === 'water' &&
   els.cardState.innerHTML === 'at 1,0', els.cardName.textContent + ' / ' +
   els.cardState.innerHTML);
step('the same, a row down', () =>
  H.card(state, { kind: 'cell', x: '0', y: '1e0' }));
ok('the row is read as a number too, and written as one',
   els.cardName.textContent === 'soil' &&
   els.cardState.innerHTML === 'at 0,1', els.cardName.textContent + ' / ' +
   els.cardState.innerHTML);
ok('a cell off the map gets no card',
   H.card(state, { kind: 'cell', x: 5, y: 0 }) === false);

step('a biography', () => H.bio({ id: 7, sp: TAG, name: TAG, alive: true,
                                   events: [{ tick: TAG, text: TAG },
                                            { tick: 4, text: TAG }] }));
clean('biography');
ok('the biography carries its events, escaped',
   els.cardRows.innerHTML.split(ESCAPED).length - 1 === 2,
   els.cardRows.innerHTML);
ok('the biography\'s weeks are numbers',
   els.cardRows.innerHTML.indexOf('wkNaN') >= 0 &&
   els.cardRows.innerHTML.indexOf('wk4') >= 0, els.cardRows.innerHTML);
ok('the biography\'s name is text', els.cardName.textContent.indexOf(TAG) === 0);

console.log('\n' + (fails.length ? fails.length + ' FAILED' : 'all ok'));
process.exit(fails.length ? 1 : 0);
