/* The grove HUD's headless check.
 *
 * `page3d/hud.js` writes the words around the scene: the header, the
 * chronicle, the census, the steward's tab, and the card for whatever was
 * clicked. Much of what it writes is a language model's — the chronicle,
 * the soul's line, the steward's rules, reasons and verdicts, the
 * biographies — so this check feeds it a hostile string in *every* field
 * of every payload, numbers included, and asserts that nothing reaches
 * innerHTML as markup: every string comes out escaped, every number comes
 * out a number (or a dash), and the text still arrives (an escaper that drops
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
const PATCH = path.join(__dirname, '..', '..', 'shared', 'page3d', 'patch.js');

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
  const attrs = {};
  this.setAttribute = (k, v) => { attrs[k] = String(v); };
  this.getAttribute = k => (k in attrs ? attrs[k] : null);
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

const ctx = { document, console, Intl };
ctx.globalThis = ctx;
vm.createContext(ctx);
/* the page loads the shared patch.js before hud.js, and so does this */
vm.runInContext(fs.readFileSync(PATCH, 'utf8'), ctx, { filename: 'patch.js' });
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
ok('a count that is not a number is written as a dash',
   els.pops.innerHTML.indexOf('<span class="pnum">—</span>') >= 0,
   els.pops.innerHTML);
ok('a week that is not a number is written as a dash',
   els.chron.innerHTML.indexOf('<span class="when">—</span>') >= 0 &&
   els.when.textContent.indexOf('week —') === 0,
   els.chron.innerHTML + ' / ' + els.when.textContent);
ok('the mark is from the fixed table, not the frame',
   els.chron.innerHTML.indexOf('class="mark-llm"') >= 0, els.chron.innerHTML);
ok('a line from the rules starts with its words, no "·" bullet',
   els.chron.innerHTML.indexOf('class="mark-template"') < 0 &&
   els.chron.innerHTML.indexOf('</span>· ') < 0 &&
   els.chron.innerHTML.indexOf('>·</span>') < 0, els.chron.innerHTML);
ok('the soul line is text', els.soul.textContent === '☾ ' + TAG);

step('the census tab', () => H.tab('census', state));
clean('census');
ok('the census carries the names, escaped',
   els.chron.innerHTML.split(ESCAPED).length - 1 === 2, els.chron.innerHTML);
const sparkText = (els.chron.innerHTML.match(
  /<span class="spark">([^<]*)<\/span>/) || [])[1] || '';
ok('the sparkline is blocks only, whatever the values',
   /^[\u2581-\u2588]{3}$/.test(sparkText), sparkText);
ok('the census count that is not a number is a dash',
   els.chron.innerHTML.indexOf('<b>—</b>') >= 0, els.chron.innerHTML);

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
ok('weeks and the amendment count that are not numbers are dashes',
   tuneHtml.indexOf('week — — ') >= 0 && tuneHtml.indexOf('· week —') >= 0 &&
   tuneHtml.indexOf('in week — — — amendment') >= 0 &&
   tuneHtml.indexOf('NaN<') < 0, tuneHtml);
step('the steward under auto-tune', () =>
  H.setTuning(Object.assign({}, tuning, { auto_tune: true })));
ok('auto-tune draws no buttons', els.chron.innerHTML.indexOf('<button') < 0,
   els.chron.innerHTML);
clean('steward auto');
step('back to the chronicle', () => H.tab('chron', state));

step('a creature\'s card', () => H.card(state, { kind: 'animal', id: 7 }));
clean('animal card');
ok('the card is open', els.card.classList.contains('on'));
ok('the creature\'s name is text',
   els.cardName.textContent.indexOf(TAG + ' ' + TAG + ' · ' + TAG) === 0,
   els.cardName.textContent);
ok('the creature\'s age is a dash, and no place is written',
   els.cardState.innerHTML.indexOf('— weeks old') === 0 &&
   els.cardState.innerHTML.indexOf(' at ') < 0, els.cardState.innerHTML);
step('a creature picked with its id as text', () =>
  H.card(state, { kind: 'animal', id: '7' }));
ok('the pick\'s id is read as a number: the live creature\'s card',
   els.cardState.innerHTML.indexOf('weeks old') >= 0, els.cardState.innerHTML);

step('a plant\'s card', () => H.card(state, { kind: 'plant', id: 9 }));
clean('plant card');
ok('the plant\'s stage is the heading\'s, not repeated in its state',
   els.cardState.innerHTML.indexOf(ESCAPED) < 0 &&
   els.cardState.innerHTML.indexOf('<') < 0, els.cardState.innerHTML);
ok('the plant\'s place is not written',
   els.cardState.innerHTML.indexOf(' at ') < 0 &&
   els.cardState.innerHTML.indexOf('NaN') < 0, els.cardState.innerHTML);

step('a cell\'s card', () => H.card(state, { kind: 'cell', x: 0, y: 0 }));
clean('cell card');
ok('the cell card is open on soil', els.cardName.textContent === 'soil',
   els.cardName.textContent);
ok('the cell\'s grass and moisture are dashes, and no glow is no row',
   (els.cardRows.innerHTML.match(/<span>—<\/span>/g) || []).length === 2 &&
   els.cardRows.innerHTML.indexOf('glow') < 0 &&
   els.cardRows.innerHTML.indexOf('NaN') < 0,
   els.cardRows.innerHTML);
step('a cell picked with its coordinates as strings',
     () => H.card(state, { kind: 'cell', x: '1', y: '0' }));
ok('coordinates are read as numbers, not joined as strings',
   els.cardName.textContent === 'water' &&
   els.cardState.innerHTML === 'open water', els.cardName.textContent + ' / ' +
   els.cardState.innerHTML);
step('the same, a row down', () =>
  H.card(state, { kind: 'cell', x: '0', y: '1e0' }));
ok('the row is read as a number too',
   els.cardName.textContent === 'soil' &&
   els.cardState.innerHTML === 'low, by the water · nothing grows or walks here',
   els.cardName.textContent + ' / ' + els.cardState.innerHTML);
ok('a cell off the map gets no card',
   H.card(state, { kind: 'cell', x: 5, y: 0 }) === false);

/* The ledger's answer rides in with every redraw of the card: a frame poll
 * redraws it every 0.7 s, and an answer written once would be wiped by the
 * next poll back to "looking up its story…" for good. */
const BIO = { id: 7, sp: TAG, name: TAG, alive: true, hunger: TAG,
              energy: TAG, events: [{ tick: TAG, text: TAG },
                                    { tick: 4, text: TAG }] };
step('a card waiting on the ledger', () =>
  H.card(state, { kind: 'animal', id: 7 }, { id: 7, state: 'wait' }));
ok('the waiting card says so', els.cardRows.innerHTML.indexOf(
  'looking up its story') >= 0, els.cardRows.innerHTML);
step('a biography', () =>
  H.card(state, { kind: 'animal', id: 7 }, { id: 7, state: 'ok', b: BIO }));
clean('biography');
ok('the biography carries its events, escaped',
   els.cardRows.innerHTML.split(ESCAPED).length - 1 === 2,
   els.cardRows.innerHTML);
ok('the biography\'s weeks are numbers, newest first',
   els.cardRows.innerHTML.indexOf('week —') >= 0 &&
   els.cardRows.innerHTML.indexOf('week 4') >= 0 &&
   els.cardRows.innerHTML.indexOf('week 4') <
   els.cardRows.innerHTML.indexOf('week —'), els.cardRows.innerHTML);
ok('needs that are not numbers are dashes',
   els.cardRows.innerHTML.indexOf('<span>hunger</span><span>—<') >= 0 &&
   els.cardRows.innerHTML.indexOf(
     '<span>energy</span><span class="bar"><i style="width:0%"></i></span>' +
     '<span>—</span>') >= 0 &&
   els.cardRows.innerHTML.indexOf('NaN') < 0,
   els.cardRows.innerHTML);
ok('the card is not left consulting',
   els.cardRows.innerHTML.indexOf('looking up') < 0, els.cardRows.innerHTML);
ok('the frame\'s facts stay on the card',
   els.cardState.innerHTML.indexOf('— weeks old') === 0,
   els.cardState.innerHTML);
/* hunger has no cap in the sim (the seed-42 run reaches 27.4), so the card
 * never puts it over 10: it is a word */
[[27.4, 'starving'], [6.2, 'hungry'], [1.1, 'fed'], ['27.4', 'starving']]
  .forEach(([h, want]) => {
    step('hunger ' + h, () =>
      H.card(state, { kind: 'animal', id: 7 },
             { id: 7, state: 'ok', b: { id: 7, alive: true, hunger: h,
                                        energy: 10, events: [] } }));
    ok('hunger ' + h + ' reads "' + want + '", not out of 10',
       els.cardRows.innerHTML.indexOf('<span>hunger</span><span>' + want +
                                      '</span>') >= 0, els.cardRows.innerHTML);
  });
step('the next poll redraws the card', () =>
  H.card(state, { kind: 'animal', id: 7 }, { id: 7, state: 'ok', b: BIO }));
ok('the redraw keeps the biography',
   els.cardRows.innerHTML.split(ESCAPED).length - 1 === 2 &&
   els.cardRows.innerHTML.indexOf('looking up') < 0, els.cardRows.innerHTML);
step('another creature\'s answer', () =>
  H.card(state, { kind: 'animal', id: 7 }, { id: 8, state: 'ok', b: BIO }));
ok('an answer for another id is not shown',
   els.cardRows.innerHTML.indexOf('looking up') >= 0, els.cardRows.innerHTML);
step('an answer whose id came as text', () =>
  H.card(state, { kind: 'animal', id: 7 }, { id: '7', state: 'ok', b: BIO }));
ok('the ids are compared as numbers',
   els.cardRows.innerHTML.indexOf('looking up') < 0, els.cardRows.innerHTML);
step('a selection whose id came as text', () =>
  H.card(state, { kind: 'animal', id: '70' },
         { id: 70, state: 'ok', b: { id: 70, gone: true, events: [] } }));
ok('the selection\'s id is compared as a number',
   els.cardState.innerHTML === 'remembered in the chronicle',
   els.cardState.innerHTML);
step('a ledger that did not answer', () =>
  H.card(state, { kind: 'animal', id: 7 }, { id: 7, state: 'fail' }));
ok('a failed ask ends in a plain line',
   els.cardRows.innerHTML.indexOf('did not answer') >= 0 &&
   els.cardRows.innerHTML.indexOf('looking up') < 0, els.cardRows.innerHTML);
step('a soul that is gone', () =>
  H.card(state, { kind: 'animal', id: 70 },
         { id: 70, state: 'ok', b: { id: 70, gone: true, sp: TAG,
                                     events: [{ tick: 1, text: TAG }] } }));
clean('gone');
ok('the gone soul is remembered, its name text',
   els.cardState.innerHTML === 'remembered in the chronicle' &&
   els.cardName.textContent === 'a ' + TAG + ', gone',
   els.cardName.textContent);
ok('the gone soul\'s events are there, escaped',
   els.cardRows.innerHTML.split(ESCAPED).length - 1 === 1,
   els.cardRows.innerHTML);

/* ------------------------------------------- the card speaks in words */

/* A friendly frame: what each kind of card says, and what it must not.
 * Iris's panels review: words not decimals, no coordinates, counts with
 * their commas, a plant's stage as a phrase. */
const plain = {
  size: 2, tick: 1234, season: 'spring', weather: 'rain', paused: false,
  llm: { status: 'AI off · no key' },
  pop_chips: [{ emo: '🦉', name: 'owl', n: 1 },
              { emo: '🐇', name: 'rabbit', n: 1240 },
              { emo: '🌲', name: 'pine', n: 24 }],
  chronicle: [{ tick: 1234, text: 'rain', source: 'template' },
              { tick: 1233, text: 'a fox', source: 'llm' },
              { tick: 1200, text: 'old', source: 'voice' }],
  series: [{ emo: '🐇', name: 'rabbit', values: [1000, 1240] }],
  cells: [['s', 0.7, 0.4, 1, 0, 0.9], ['w', 0, 1, 0, 0, 0, 'c'],
          ['s', 0, 0, 0, 0, 0.5], ['r', 0.2, 0.1, 0, 1, 0.1]],
  glow: [9, 0, 0, 2],
  animals: [{ id: 1, sp: 'rabbit', x: 0, y: 0, ag: 1052, h: 1 },
            { id: 2, sp: 'owl', x: 0, y: 0, ag: 3, n: 'Hoot' }],
  plants: [{ id: 3, sp: 'pine', x: 0, y: 0, st: 'old', el: 1, b: 0 },
           { id: 4, sp: 'pine', x: '0', y: '0', st: 'sapling' },
           { id: 5, sp: 'oak', x: 1, y: 1, st: 'log' }],
};
const DECIMAL = /\d\.\d/;
const cardText = () => els.cardName.textContent + ' | ' +
  els.cardState.innerHTML + ' | ' + els.cardRows.innerHTML;

step('the head of a friendly frame', () => H.update(plain));
ok('the week is grouped: "week 1,234"',
   els.when.textContent.indexOf('week 1,234') === 0, els.when.textContent);
ok('the chips are most first, with their commas',
   /rabbit.*1,240.*pine.*24.*owl.*1/.test(els.pops.innerHTML.replace(/<[^>]*>/g,
                                                                     '')),
   els.pops.innerHTML);
ok('the times read as words',
   els.chron.innerHTML.indexOf('>this week<') >= 0 &&
   els.chron.innerHTML.indexOf('>last week<') >= 0 &&
   els.chron.innerHTML.indexOf('>34 weeks ago<') >= 0, els.chron.innerHTML);
ok('the status line is short, one line',
   els.status.textContent === 'AI off · no key', els.status.textContent);
ok('the server\'s status is said for a reader',
   H.voiceLine('tier local — pure deterministic sim') ===
     'AI off · pure deterministic sim' &&
   H.voiceLine('tier local — no model (ollama not running)') ===
     'AI off · no model' &&
   H.voiceLine('tier cloud · m3 · tokens today 1,234 of 50,000') ===
     'AI · m3 · tokens today 1,234 of 50,000',
   H.voiceLine('tier local — no model (ollama not running)'));
step('an AI that is off, with its reason', () => H.update(Object.assign({},
  plain, { llm: { status: 'tier local — no key', ok: false,
                  reason: 'no key' } })));
ok('an AI that is off is not a hiccup',
   els.status.textContent === 'AI off · no key', els.status.textContent);
step('an AI that stumbled', () => H.update(Object.assign({}, plain,
  { llm: { status: 'tier cloud · m3', ok: true, reason: 'timeout' } })));
ok('a stumble on a working AI is flagged, its reason the tooltip',
   els.status.textContent === 'AI · m3 · ⚠ hiccup' &&
   els.status.title.indexOf('last stumble: timeout') >= 0,
   els.status.textContent);
step('back', () => H.update(plain));
step('the census of a friendly frame', () => H.tab('census', plain));
ok('the census count has its comma',
   els.chron.innerHTML.indexOf('<b>1,240</b>') >= 0, els.chron.innerHTML);
step('back', () => H.tab('chron', plain));
ok('the tabs say which is selected (aria)',
   els.tabChron.getAttribute('aria-selected') === 'true' &&
   els.tabCensus.getAttribute('aria-selected') === 'false',
   els.tabChron.getAttribute('aria-selected'));

step('a rabbit', () => H.card(plain, { kind: 'animal', id: 1 }));
ok('an animal: emoji, "a wild", its age with a comma, hungry in words',
   els.cardName.textContent === '🐇 a wild rabbit' &&
   els.cardState.innerHTML === '1,052 weeks old · hungry', cardText());
step('a named owl', () => H.card(plain, { kind: 'animal', id: 2 }));
ok('a named animal keeps its name',
   els.cardName.textContent === '🦉 Hoot · owl', els.cardName.textContent);
step('an old pine', () => H.card(plain, { kind: 'plant', id: 3 }));
ok('a plant: its glyph and stage in the heading, not again in the state',
   els.cardName.textContent === '🌲 an old pine' &&
   els.cardState.innerHTML === 'one of the grove\'s oldest', cardText());
step('a log', () => H.card(plain, { kind: 'plant', id: 5 }));
ok('a log is a fallen tree',
   els.cardName.textContent === '🌳 a fallen oak' &&
   els.cardState.innerHTML === 'now a log', cardText());
step('a busy cell', () => H.card(plain, { kind: 'cell', x: 0, y: 0 }));
ok('a cell says what stands and walks on it, counted',
   els.cardState.innerHTML ===
   'on the high ground · 2 pines · a rabbit · an owl', els.cardState.innerHTML);
ok('a cell\'s ground is in words, with bars',
   els.cardRows.innerHTML.indexOf('<span>lush</span>') >= 0 &&
   els.cardRows.innerHTML.indexOf('<span>damp</span>') >= 0 &&
   els.cardRows.innerHTML.indexOf('mushrooms</span><span>here') >= 0 &&
   els.cardRows.innerHTML.indexOf('<span>glows at night</span>') >= 0 &&
   els.cardRows.innerHTML.indexOf('width:70%') >= 0, els.cardRows.innerHTML);
step('the creek', () => H.card(plain, { kind: 'cell', x: 1, y: 0 }));
ok('water is named for what it is, with no ground rows',
   els.cardName.textContent === 'the creek' &&
   els.cardState.innerHTML === 'open water' &&
   els.cardRows.innerHTML.indexOf('grass') < 0, cardText());
step('a bare cell', () => H.card(plain, { kind: 'cell', x: 0, y: 1 }));
ok('an empty cell says so', els.cardState.innerHTML ===
   'on the slope · nothing grows or walks here', els.cardState.innerHTML);
step('rock', () => H.card(plain, { kind: 'cell', x: 1, y: 1 }));
ok('rock: low, a log, remains, a faint glow',
   els.cardState.innerHTML === 'low, by the water · an oak' &&
   els.cardRows.innerHTML.indexOf('remains</span><span>here') >= 0 &&
   els.cardRows.innerHTML.indexOf('glows faintly at night') >= 0, cardText());
ok('rock has no grass or moisture rows',
   els.cardRows.innerHTML.indexOf('grass') < 0 &&
   els.cardRows.innerHTML.indexOf('moisture') < 0, cardText());
step('a census', () => H.tab('census', Object.assign({}, plain, { series: [
  { emo: '🦉', name: 'owl', values: [9, 2] },
  { emo: '🐇', name: 'rabbit', values: Array.from({ length: 36 }, (_, i) => 1000 + i) },
  { emo: '🦊', name: 'fox', values: [1, 40] }] })));
ok('the census runs most first, by the latest count',
   (function () {
     const n = (els.chron.innerHTML.match(/<b>[^<]*<\/b>/g) || [])
       .map(x => Number(x.replace(/<\/?b>|,/g, '')));
     return n.length === 3 && n.every((v, i) => !i || n[i - 1] >= v);
   })(), els.chron.innerHTML);
ok('the census spark is at most 24 weeks',
   (els.chron.innerHTML.match(/<span class="spark">([^<]*)<\/span>/g) || [])
     .every(x => x.replace(/<[^>]+>/g, '').length <= 24), els.chron.innerHTML);
step('back to the feed', () => H.tab('chron', plain));

step('a busy cell picked with its place as text', () =>
  H.card(plain, { kind: 'cell', x: '0', y: '0' }));
ok('what is on a cell is matched by number, whatever the pick carried',
   els.cardState.innerHTML ===
   'on the high ground · 2 pines · a rabbit · an owl', els.cardState.innerHTML);

/* species names come from the frame: one alone and two together */
const crowd = Object.assign({}, plain, {
  animals: [{ id: 11, sp: TAG, x: 1, y: 1 }],
  plants: [{ id: 12, sp: TAG, x: 0, y: 0 }, { id: 13, sp: TAG, x: 0, y: 0 }],
});
step('a cell with a strange species', () =>
  H.card(crowd, { kind: 'cell', x: 1, y: 1 }));
clean('one strange species');
ok('a lone species is named, escaped',
   els.cardState.innerHTML.indexOf('a ' + ESCAPED) >= 0,
   els.cardState.innerHTML);
step('a cell with two of a strange species', () =>
  H.card(crowd, { kind: 'cell', x: 0, y: 0 }));
clean('two strange species');
ok('a counted species is named, escaped',
   els.cardState.innerHTML.indexOf('2 ' + ESCAPED + 's') >= 0,
   els.cardState.innerHTML);

/* no card, of any kind, writes a decimal or a coordinate */
for (const sel of [{ kind: 'animal', id: 1 }, { kind: 'animal', id: 2 },
                   { kind: 'plant', id: 3 }, { kind: 'plant', id: 4 },
                   { kind: 'plant', id: 5 }, { kind: 'cell', x: 0, y: 0 },
                   { kind: 'cell', x: 1, y: 0 }, { kind: 'cell', x: 0, y: 1 },
                   { kind: 'cell', x: 1, y: 1 }]) {
  step('card ' + JSON.stringify(sel), () => H.card(plain, sel,
    { id: sel.id, state: 'ok', b: { id: sel.id, alive: true, hunger: 6.37,
                                    energy: 4.25, events: [
                                      { tick: 1100, text: 'born' }] } }));
  const t = cardText().replace(/style="[^"]*"/g, '');
  ok('no decimals or coordinates on ' + JSON.stringify(sel),
     !DECIMAL.test(t) && !/\bat \d/.test(t) && t.indexOf('NaN') < 0, t);
}

/* the panels write only what changed (shared patch.js) */
{
  step('the frame again', () => H.update(plain));
  let writes = 0;
  let html = els.chron.innerHTML;
  Object.defineProperty(els.chron, 'innerHTML', {
    configurable: true, get: () => html, set: v => { writes++; html = v; } });
  for (let i = 0; i < 5; i++) H.update(plain);
  ok('an unchanged frame writes nothing to the feed', writes === 0,
     writes + ' writes');
  const more = Object.assign({}, plain, { chronicle: [
    { tick: 1234, text: 'news', source: 'llm' }].concat(plain.chronicle) });
  H.update(more);
  ok('a new line writes the feed once', writes === 1, writes + ' writes');
  delete els.chron.innerHTML;
  els.chron.innerHTML = html;
}

console.log('\n' + (fails.length ? fails.length + ' FAILED' : 'all ok'));
process.exit(fails.length ? 1 : 0);
