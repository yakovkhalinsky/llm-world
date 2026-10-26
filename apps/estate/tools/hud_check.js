/* The HUD's headless check.
 *
 * `page3d/hud.js` is the words around the scene: the header, the day feed,
 * the census, the watcher's chronicle and the card for whatever was
 * clicked. It is pure DOM — no THREE, no WebGL, no fetch — so it runs
 * against a stub document in Node with the server's own two payloads, the
 * same way `clock_check.js` runs the clock.
 *
 * The assertions worth having:
 *   · the day feed is one row per day and is not the empty-state message
 *     (the panel was once reported dead while a check that only looked at
 *     the header passed)
 *   · the census tab lists the household kinds the frame carries
 *   · the watcher tab lists the chronicle
 *   · a resident, a fixture, a block and a cell each get a card, and a
 *     fixture card carries its wear
 *   · a resident card lists the household, and who a young child is out
 *     with (engine/families.py)
 *   · a school's card counts pupils rather than flats, the school gate and
 *     the bus stop each get a card that counts their people, and a count
 *     is written with thousands separators
 *   · today's phases make frames of their own (`phaseView`): a weekday
 *     morning has pupils at school and workers away, and the scrubber has
 *     a button per phase
 *   · every string from the server is escaped where it is written, and
 *     numbers never reach innerHTML as anything but a number
 *
 *   node tools/hud_check.js <ground.json> <state.json>
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HUD = path.join(__dirname, '..', 'estate', 'page3d', 'hud.js');
const PATCH = path.join(__dirname, '..', '..', 'shared', 'page3d', 'patch.js');

/* --------------------------------------------------------------- stubs */

function El(id) {
  this.id = id;
  this.textContent = '';
  this.innerHTML = '';
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

const ctx = { document, console };
ctx.globalThis = ctx;
vm.createContext(ctx);
/* the page loads the shared patch.js before hud.js, and so does this */
vm.runInContext(fs.readFileSync(PATCH, 'utf8'), ctx, { filename: 'patch.js' });
vm.runInContext(fs.readFileSync(HUD, 'utf8'), ctx, { filename: 'hud.js' });

const EstateHUD = ctx.EstateHUD;

/* ------------------------------------------------------------- fixture */

const ground = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const state = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));

/* -------------------------------------------------------------- checks */

const fails = [];
function ok(name, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name +
              (cond || !detail ? '' : '   (' + detail + ')'));
  if (!cond) fails.push(name);
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function count(html, needle) {
  return (html.match(new RegExp(needle, 'g')) || []).length;
}

if (!EstateHUD) {
  console.log('  FAIL hud.js did not publish EstateHUD');
  console.log('\n1 FAILED');
  process.exit(1);
}

/* Two functions of one name *in one file* is not an error — declarations
 * hoist, so the later one silently wins and the earlier is dead code that
 * still looks alive. That is how a dead day feed once ran for a day while
 * every other check passed. The 3D page's classic scripts are each one
 * IIFE, so a collision inside a file is the shape this can still have. */
/* hud.js is the estate's own; the router and the clock are the folder
 * both apps' 3D views share */
const SHARED = path.join(__dirname, '..', '..', 'shared', 'page3d');
for (const f of ['walk.js', 'hud.js', 'clock.js']) {
  const dir = f === 'hud.js' ? path.join(__dirname, '..', 'estate', 'page3d')
                             : SHARED;
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const seen = {};
  for (const m of src.matchAll(
      /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    (seen[name] = seen[name] || []).push(f);
  }
  const dup = Object.keys(seen).filter(k => seen[k].length > 1);
  ok('no function is declared twice in ' + f, dup.length === 0,
     dup.join(', '));
}

EstateHUD.setGround(ground);
EstateHUD.update(state);

/* --- the head is written, not blank ---------------------------------- */

ok('the header was written', els.when.textContent.indexOf('day ') === 0,
   els.when.textContent);
ok('the weather was written', els.weather.textContent.length > 0,
   els.weather.textContent);
ok('the population line was written', els.pops.innerHTML.indexOf('people') >= 0,
   els.pops.innerHTML);
ok('the watcher line was written', els.watch.innerHTML.length > 0);
ok('the voice line is the server\'s, short, with the whole of it as its title',
   els.voice.textContent === EstateHUD.voiceLine(state.llm) &&
   els.voice.title === (state.llm || '') &&
   els.voice.textContent.length <= (state.llm || '').length,
   els.voice.textContent);
ok('a voice line says the AI is off, and why, in a few words',
   EstateHUD.voiceLine('tier local — pure deterministic sim') ===
     'AI off · pure deterministic sim' &&
   EstateHUD.voiceLine('tier local — no model (ollama not running)') ===
     'AI off · no model' &&
   EstateHUD.voiceLine('tier cloud · m3 · tokens today 1,234') ===
     'AI · m3 · tokens today 1,234',
   EstateHUD.voiceLine('tier local — no model (ollama not running)'));

/* --- the day feed ---------------------------------------------------- */

const days = state.days || [];
ok('the frame carries a day feed', days.length >= 5, days.length + ' days');
ok('the day feed renders one row per day',
   count(els.chron.innerHTML, '<li') === days.length,
   count(els.chron.innerHTML, '<li') + ' rows for ' + days.length + ' days');
ok('the day feed is not the empty-state message',
   els.chron.innerHTML.indexOf('nothing has happened yet') < 0);

/* --- the census ------------------------------------------------------ */

EstateHUD.tab('census', state);
const censusHtml = els.chron.innerHTML;
const censusKeys = Object.keys(state.census || {});
ok('the census tab lists every household kind in the frame',
   censusKeys.every(k => censusHtml.indexOf(k.replace(/_/g, ' ')) >= 0),
   censusKeys.filter(k => censusHtml.indexOf(k.replace(/_/g, ' ')) < 0)
     .join(', '));
ok('a household kind is written as words, not as its key',
   censusHtml.indexOf('_') < 0, censusHtml.slice(0, 200));
ok('the census tab counts people by role',
   (state.people || []).every(p => censusHtml.indexOf(p.role) >= 0));
ok('the census tab marks itself as the open tab',
   els.tabCensus.classList.contains('on') &&
   !els.tabChron.classList.contains('on'));

/* --- the watcher ----------------------------------------------------- */

EstateHUD.tab('watch', state);
ok('the watcher tab lists the chronicle',
   (state.chronicle || []).length === 0 ||
   (state.chronicle || []).every(e =>
     els.chron.innerHTML.indexOf(EstateHUD.esc(String(e.text))) >= 0));
ok('the watcher tab is never blank',
   els.chron.innerHTML.indexOf('<li') >= 0);

EstateHUD.tab('chron', state);

/* --- the cards ------------------------------------------------------- */

function first(list) { return (list || [])[0]; }

const person = first(state.people);
if (!person) {
  ok('the frame has a resident to card', false);
} else {
  ok('a resident gets a card',
     EstateHUD.card(state, { kind: 'resident', id: person.id}) &&
     els.card.classList.contains('on'));
  ok('the resident card names the resident',
     els.cardName.textContent === (person.name || 'a resident'),
     els.cardName.textContent);
  ok('the resident card has a need row per need',
     count(els.cardRows.innerHTML, '<li') >= Object.keys(person.needs || {}).length,
     els.cardRows.innerHTML.slice(0, 120));
}

/* an elder in an elder household lives with family (Iris A8) */
if (person) {
  const st = clone(state);
  const gran = Object.assign(clone(person), { id: 9003, name: 'Hal',
    role: 'elder', age: 71, kind: 'elder', family: [9004] });
  const son = Object.assign(clone(person), { id: 9004, name: 'Rob',
    role: 'adult', age: 44, kind: 'elder', family: [9003] });
  st.people = [gran, son];
  EstateHUD.card(st, { kind: 'resident', id: 9003 });
  ok('an elder\'s card: lives with family, not "lives with an elder"',
     els.cardState.innerHTML.indexOf('lives with family') >= 0, els.cardState.innerHTML);
  EstateHUD.card(st, { kind: 'resident', id: 9004 });
  ok('the elder\'s family: lives with an elder',
     els.cardState.innerHTML.indexOf('lives with an elder') >= 0, els.cardState.innerHTML);
}

/* the family: a two-person household cards each other, and a young child
 * out with a guardian names them */
if (person) {
  const st = clone(state);
  const kid = Object.assign(clone(person), { id: 9001, name: 'Kit',
    role: 'child', age: 6, in: false, family: [9002], with: 9002 });
  const mum = Object.assign(clone(person), { id: 9002, name: 'Ann',
    role: 'adult', age: 34, in: false, family: [9001], with: null });
  st.people = [kid, mum];
  EstateHUD.card(st, { kind: 'resident', id: 9001 });
  const rows = els.cardRows.innerHTML;
  ok('a child\'s card lists the household', rows.indexOf('Ann') >= 0 &&
     rows.indexOf('34') >= 0, rows.slice(0, 200));
  ok('a child\'s card names who they are out with',
     rows.indexOf('out with</span><span>Ann') >= 0, rows.slice(0, 200));
  EstateHUD.card(st, { kind: 'resident', id: 9002 });
  ok('a guardian\'s card lists the child and says nobody is minding them',
     els.cardRows.innerHTML.indexOf('Kit') >= 0 &&
     els.cardRows.innerHTML.indexOf('out with') < 0,
     els.cardRows.innerHTML.slice(0, 200));
}

const fixture = (state.fixtures || []).find(f => f.kind === 'bench');
if (!fixture) {
  ok('the frame has a bench to card', false);
} else {
  ok('a fixture gets a card',
     EstateHUD.card(state, { kind: 'fixture', id: fixture.id}) &&
     els.cardName.textContent.indexOf('bench') >= 0,
     els.cardName.textContent);
  ok('the bench card carries its use and its wear',
     els.cardRows.innerHTML.indexOf('sits so far') >= 0 &&
     els.cardRows.innerHTML.indexOf('seats taken') >= 0 &&
     els.cardRows.innerHTML.indexOf('condition') >= 0,
     els.cardRows.innerHTML);
}

const building = first(ground.buildings);
if (!building) {
  ok('the ground has a building to card', false);
} else {
  ok('a block gets a card',
     EstateHUD.card(state, { kind: 'building', id: building.id}) &&
     els.cardName.textContent === '🏢 ' + building.name,
     els.cardName.textContent);
  ok('the block card carries the flats and who lives there',
     els.cardState.innerHTML.indexOf('flats lived in') >= 0 &&
     els.cardRows.innerHTML.indexOf('people live here') >= 0,
     els.cardState.innerHTML + ' ' + els.cardRows.innerHTML);
}

/* the first cell that is not under a block or a fixture */
let cell = null;
outer:
for (let y = 0; y < ground.height && !cell; y++) {
  for (let x = 0; x < ground.width; x++) {
    if (ground.codes[ground.rows[y][x]] !== 'building') { cell = [x, y]; break outer; }
  }
}
if (!cell) {
  ok('the ground has a cell to card', false);
} else {
  const site = ground.codes[ground.rows[cell[1]][cell[0]]];
  ok('a cell gets a card',
     EstateHUD.card(state, { kind: 'cell', x: cell[0], y: cell[1]}) &&
     els.cardName.textContent.indexOf(site) >= 0,
     els.cardName.textContent);
  /* across the ground: shade and lamplight are rows where there is some,
   * and never a row with an empty bar */
  let shaded = 0, lit = 0, empty = '';
  for (let y = 0; y < ground.height; y++) {
    for (let x = 0; x < ground.width; x++) {
      if (ground.codes[ground.rows[y][x]] === 'building') continue;
      if (!EstateHUD.card(state, { kind: 'cell', x, y })) continue;
      const r = els.cardRows.innerHTML;
      if (r.indexOf('>shade<') >= 0) shaded++;
      if (r.indexOf('>lamplight<') >= 0) lit++;
      if (/width:0%|>none<|dark at night/.test(r)) empty = r;
    }
  }
  /* a road or footpath with nothing near and no rows still says what it
   * is: a heading with an empty body read as broken (Iris A2) */
  let bare = '';
  for (let y = 0; y < ground.height && !bare; y++) {
    for (let x = 0; x < ground.width; x++) {
      if (ground.codes[ground.rows[y][x]] === 'building') continue;
      if (!EstateHUD.card(state, { kind: 'cell', x, y })) continue;
      if (!els.cardRows.innerHTML && !els.cardState.innerHTML) {
        bare = x + ',' + y + ' ' + els.cardName.textContent; break;
      }
    }
  }
  ok('no cell card is a heading with nothing under it', !bare, bare);
  {
    let road = null;
    for (let y = 0; y < ground.height && !road; y++) {
      for (let x = 0; x < ground.width; x++) {
        if (ground.codes[ground.rows[y][x]] !== 'road') continue;
        EstateHUD.card(state, { kind: 'cell', x, y });
        if (!els.cardRows.innerHTML && els.cardState.innerHTML.indexOf('near the') < 0) {
          road = els.cardState.innerHTML; break;
        }
      }
    }
    ok('a bare road says it is the road round the estate',
       road === null || road === 'a road round the estate', road);
  }
  ok('cell cards carry shade and lamplight where there is some',
     shaded > 0 && lit > 0, shaded + ' shaded, ' + lit + ' lit');
  ok('no cell card shows a zero row with an empty bar', !empty, empty);
}

/* --- the school, the bus stop and the day's phases -------------------- */

ok('numbers get thousands separators',
   EstateHUD.num(1234567) === '1,234,567' && EstateHUD.num(999) === '999' &&
   EstateHUD.num(-1200) === '-1,200' && EstateHUD.num('x') === '—',
   EstateHUD.num(1234567));
{
  const st = clone(state);
  st.residents = 12345;
  EstateHUD.update(st);
  ok('the header writes a big count with a comma',
     els.pops.innerHTML.indexOf('12,345') >= 0, els.pops.innerHTML);
  EstateHUD.update(state);
}

const school = (ground.buildings || []).find(b => b.kind === 'school');
ok('the ground has a school', !!school);
if (school) {
  EstateHUD.card(state, { kind: 'building', id: school.id });
  const rows = els.cardRows.innerHTML;
  ok('the school card counts pupils, not flats',
     rows.indexOf('pupils on the roll') >= 0 && rows.indexOf('flats') < 0 &&
     rows.indexOf('lived in') < 0, rows);
  ok('the school card is named for the school',
     els.cardName.textContent.indexOf(school.name) >= 0,
     els.cardName.textContent);
}
const shop = (ground.buildings || []).find(b => b.kind === 'shop');
if (shop) {
  EstateHUD.card(state, { kind: 'building', id: shop.id });
  ok('the shop card has no flats', els.cardRows.innerHTML.indexOf('flats') < 0,
     els.cardRows.innerHTML);
}
for (const [kind, word, row] of [['school', 'School', 'pupils'],
                                 ['bus_stop', 'bus stop', 'work']]) {
  const f = (state.fixtures || []).find(x => x.kind === kind);
  ok('the frame has a ' + word, !!f);
  if (!f) continue;
  EstateHUD.card(state, { kind: 'fixture', id: f.id });
  ok('the ' + word + ' card is named and counts its people',
     els.cardName.textContent.indexOf(word) >= 0 &&
     els.cardRows.innerHTML.indexOf(row) >= 0,
     els.cardName.textContent + ' ' + els.cardRows.innerHTML.slice(0, 120));
}

const ph = state.phases;
ok('the frame carries today\'s phases',
   ph && ph.order && ph.order.length === 5 &&
   ph.order.every(n => ph.at && ph.at[n]), JSON.stringify(ph && ph.order));
if (ph && ph.order) {
  const live = EstateHUD.phaseView(state, -1);
  ok('the live view is the frame itself', live === state);
  const mi = ph.order.indexOf('morning');
  const morning = EstateHUD.phaseView(state, mi);
  ok('a phase view is its own frame', morning !== state &&
     morning.viewPhase === 'morning' &&
     morning.viewKey === state.day + ':morning' &&
     morning.people.length === (state.people || []).length);
  const rec = ph.at.morning;
  ok('a phase view puts everyone where the phase left them',
     morning.people.every(p => !rec[String(p.id)] ||
       (p.x === rec[String(p.id)][0] && p.y === rec[String(p.id)][1])));
  ok('a phase view walks from the phase before',
     morning.people.every(p => {
       const b = ph.at[ph.order[mi - 1]][String(p.id)];
       return !b || (p.px === b[0] && p.py === b[1]);
     }));
  const modes = morning.people.map(p => p.mode);
  const weekend = /^(Saturday|Sunday)$/.test(String(state.weekday));
  ok(weekend ? 'a weekend morning has nobody at school or at work'
             : 'a weekday morning has pupils at school and workers away',
     weekend ? modes.indexOf('school') < 0 && modes.indexOf('away') < 0
             : (!state.daytime || state.daytime.enrolled === 0 ||
                (modes.indexOf('school') >= 0 &&
                 modes.indexOf('away') >= 0)),
     state.weekday + ': ' + modes.join(','));
  ok('nobody at school or away is drawn indoors, or away and walking',
     morning.people.every(p =>
       (p.mode !== 'school' || !p.in) &&
       (p.mode !== 'away' || p.pmode !== 'away' || p.in)));
  EstateHUD.update(morning);
  /* the phase line under it (viewer.js phaseLabel) says which phase is
   * shown; the date saying it too read twice (Iris A4) */
  ok('a scrubbed phase is not said again in the date line',
     els.when.textContent.indexOf('morning') < 0 &&
     els.when.textContent.indexOf(state.weekday) >= 0, els.when.textContent);
  const pupil = morning.people.find(p => p.mode === 'school');
  if (pupil) {
    EstateHUD.card(morning, { kind: 'resident', id: pupil.id });
    ok('a pupil\'s card says they are at school',
       els.cardState.innerHTML.indexOf('at school') >= 0,
       els.cardState.innerHTML);
  }
  /* #14 review: the header never said 'at school' or 'at work', because
   * the live frame is the end of a night. Live it counts the clock's
   * phase; a phase picked on the scrubber counts that phase. */
  if (!weekend && state.daytime && state.daytime.enrolled > 0) {
    const pops = () => els.pops.innerHTML;
    const n = (word) => { const m = pops().match(
      new RegExp('<b>([\\d,]+)</b> ' + word)); return m ? m[1] : null; };
    const want = (f, mode) => String(f.people.filter(
      p => p.mode === mode).length);
    EstateHUD.setClock(null);
    EstateHUD.update(state);
    ok('live, at the end of the night, nobody is at school or at work',
       n('at school') === null && n('at work') === null, pops());
    EstateHUD.setClock('morning');
    EstateHUD.update(state);
    ok('live, with the clock at morning, the header counts the morning',
       n('at school') === want(morning, 'school') &&
       n('at work') === want(morning, 'away'), pops());
    ok('the live frame itself is still the end of the night',
       els.when.textContent.indexOf('morning') < 0, els.when.textContent);
    EstateHUD.setClock('night');
    EstateHUD.update(state);
    ok('live, with the clock at night, nobody is at school or at work',
       n('at school') === null && n('at work') === null, pops());
    EstateHUD.setClock('night');
    EstateHUD.update(morning);
    ok('a phase picked on the scrubber counts that phase, whatever the clock',
       n('at school') === want(morning, 'school') &&
       n('at work') === want(morning, 'away'), pops());
    const ev = EstateHUD.phaseView(state, ph.order.indexOf('evening'));
    EstateHUD.setClock('morning');
    EstateHUD.update(ev);
    ok('the scrubber\'s evening has nobody at school or at work',
       n('at school') === null && n('at work') === null, pops());
    EstateHUD.setClock(null);
  }
  const bar = EstateHUD.scrubber(state, mi);
  ok('the scrubber has live and one button per phase',
     count(bar, '<button') === 6 && count(bar, 'class="on"') === 1 &&
     bar.indexOf('data-i="' + mi + '" class="on"') >= 0, bar);
  EstateHUD.update(state);
}

/* --- each kind of thing gets the card it needs (Iris's panels review) - */

/* what no card may carry: a raw decimal, a count without its thousands
 * comma, a pack key with an underscore, or a coordinate pair */
function plain(what, cardOk) {
  const html = els.cardState.innerHTML + ' ' + els.cardRows.innerHTML;
  const text = html.replace(/<[^>]*>/g, ' ').replace(/&#?\w+;/g, ' ');
  const bad = [/\d\.\d/, /\d{4,}/, /_/, /\bat \d+,\d+/,
               /NaN|undefined|null/].filter(r => r.test(text));
  ok(what + ' gets a card in words', cardOk && bad.length === 0,
     bad.map(String).join(' ') + ' in ' + text.slice(0, 240));
}
for (const p of (state.people || []).slice(0, 25)) {
  plain('resident ' + p.name, EstateHUD.card(state, { kind: 'resident',
                                                       id: p.id }));
}
for (const f of state.fixtures || []) {
  plain('the ' + f.kind + ' ' + f.id,
        EstateHUD.card(state, { kind: 'fixture', id: f.id }));
}
for (const b of ground.buildings || []) {
  plain(b.name, EstateHUD.card(state, { kind: 'building', id: b.id }));
}
for (const f of (state.fixtures || []).filter(f => f.kind === 'tree' ||
                                                  f.kind === 'lamp')) {
  EstateHUD.card(state, { kind: 'fixture', id: f.id });
  const all = els.cardState.innerHTML + els.cardRows.innerHTML;
  ok('a ' + f.kind + ' card counts no uses', all.indexOf('so far') < 0 &&
     all.indexOf('used') < 0 && all.indexOf('uses') < 0, all);
  if (f.kind === 'tree') {
    ok('a tree card says what it shades', all.indexOf('shades ') >= 0, all);
  }
}
{
  const lamp = (state.fixtures || []).find(f => f.kind === 'lamp');
  ok('the frame has a lamp', !!lamp);
  if (lamp) {
    const st = clone(state);
    const l = st.fixtures.find(f => f.id === lamp.id);
    l.c = 0.8;
    const say = (phase) => {
      EstateHUD.setClock(phase);
      EstateHUD.card(st, { kind: 'fixture', id: l.id });
      return els.cardState.innerHTML;
    };
    ok('a lamp is lit at night', /^lit\b/.test(say('night')), say('night'));
    ok('a lamp is off in daylight', say('afternoon').indexOf('off in daylight') === 0,
       say('afternoon'));
    l.c = 0;
    ok('a broken lamp is out, whatever the hour',
       say('night').indexOf('⚠ out') === 0 && say('morning').indexOf('⚠ out') === 0,
       say('night'));
    ok('a lamp says what it lights', say('night').indexOf('lights ') >= 0,
       say('night'));
    EstateHUD.setClock(null);
  }
}
{
  const shopB = (ground.buildings || []).find(b => b.kind === 'shop');
  const shopF = (state.fixtures || []).find(f => f.kind === 'shop');
  if (shopB && shopF) {
    EstateHUD.card(state, { kind: 'building', id: shopB.id });
    const one = [els.cardName.textContent, els.cardState.innerHTML,
                 els.cardRows.innerHTML].join('|');
    EstateHUD.card(state, { kind: 'fixture', id: shopF.id });
    const two = [els.cardName.textContent, els.cardState.innerHTML,
                 els.cardRows.innerHTML].join('|');
    ok('the shop building and the shop at its door are one card',
       one === two && one.indexOf(shopB.name) >= 0, one + ' // ' + two);
    ok('the shop card has its shelves, its visits and no flats',
       one.indexOf('on the shelves') >= 0 && one.indexOf('visits so far') >= 0 &&
       one.indexOf('flats') < 0 && one.indexOf('floors') < 0, one);
  }
}
{
  const schB = (ground.buildings || []).find(b => b.kind === 'school');
  const schF = (state.fixtures || []).find(f => f.kind === 'school');
  if (schB && schF) {
    EstateHUD.card(state, { kind: 'building', id: schB.id });
    const one = els.cardName.textContent + els.cardRows.innerHTML;
    EstateHUD.card(state, { kind: 'fixture', id: schF.id });
    const two = els.cardName.textContent + els.cardRows.innerHTML;
    ok('the school and its gate are one card', one === two, two);
  }
}
ok('a need reads as a word: fine, wants, needs it badly',
   EstateHUD.needWord(0) === 'fine' && EstateHUD.needWord(1.29) === 'fine' &&
   EstateHUD.needWord(1.3) === 'wants' && EstateHUD.needWord(2.59) === 'wants' &&
   EstateHUD.needWord(2.6) === 'needs it badly' &&
   EstateHUD.needWord(4) === 'needs it badly');
if (person) {
  const st = clone(state);
  const p = st.people.find(x => x.id === person.id);
  p.needs = { food: 3.1, rest: 0.4 };
  EstateHUD.card(st, { kind: 'resident', id: p.id });
  const rows = els.cardRows.innerHTML;
  ok('a pressing need has a hot bar, a quiet one does not',
     count(rows, 'class="bar hot"') === 1 && rows.indexOf('needs it badly') >= 0 &&
     rows.indexOf('>fine<') >= 0, rows);
  ok('a resident\'s needs come most pressing first',
     rows.indexOf('food') < rows.indexOf('rest'), rows);
  EstateHUD.card(st, { kind: 'resident', id: 987654, name: 'Sasha' });
  ok('a resident who has gone says so',
     els.card.classList.contains('on') &&
     els.cardState.innerHTML.indexOf('Sasha has left the estate') >= 0,
     els.cardState.innerHTML);
  EstateHUD.card(st, { kind: 'resident', id: 987655 });
  ok('a nameless resident who has gone is "they have left"',
     els.cardState.innerHTML.indexOf('they have left the estate') >= 0,
     els.cardState.innerHTML);
  p.kind = 'flat_share';
  p.family = [p.id];
  EstateHUD.card(st, { kind: 'resident', id: p.id });
  ok('a household kind is a phrase on the card',
     els.cardState.innerHTML.indexOf('in a flat share') >= 0,
     els.cardState.innerHTML);
}
{
  const st = clone(state);
  st.days = [{ day: 1747, line: 'a day', says: [] }];
  st.chronicle = [{ day: 1747, text: 'a line' }];
  EstateHUD.tab('chron', st);
  ok('the feed writes the day as "day 1,747"',
     els.chron.innerHTML.indexOf('day 1,747') >= 0, els.chron.innerHTML);
  EstateHUD.tab('watch', st);
  ok('the chronicle writes the day as "day 1,747"',
     els.chron.innerHTML.indexOf('day 1,747') >= 0, els.chron.innerHTML);
  EstateHUD.tab('chron', state);
}
/* the newest-first lists carry a key that does not move with their words
 * (patch.js anchors the reader's row on it): a day's row by its day, as
 * today's row gains its news; a watcher's line by its day and words */
{
  const keys = () => (els.chron.innerHTML.match(/data-key="([^"]*)"/g) || [])
    .map((k) => k.slice(10, -1));
  const st = clone(state);
  st.days = [{ day: 9, line: 'a day', says: [] }, { day: 10, line: 'today', says: [] }];
  st.chronicle = [{ day: 9, text: 'one' }, { day: 9, text: 'two' }];
  EstateHUD.tab('chron', st);
  const k1 = keys();
  st.days[1] = { day: 10, line: 'today, busier', says: ['a fox'] };
  st.days.push({ day: 11, line: 'tomorrow', says: [] });
  EstateHUD.update(st);
  const k2 = keys();
  ok('a day keeps its row\'s key as its words grow, one key a day',
     k1.length === 2 && JSON.stringify(k2.slice(1)) === JSON.stringify(k1) &&
     new Set(k2).size === 3, [k1, k2]);
  EstateHUD.tab('watch', st);
  const w = keys();
  ok('two watcher lines on one day have two keys',
     w.length === 2 && w[0] !== w[1] && w.every((k) => /^\d+:[0-9a-z]+$/.test(k)), w);
  EstateHUD.tab('chron', state);
}

/* the panels write a list only when it changed (patch.js) */
{
  const before = els.chron.innerHTML;
  let writes = 0;
  let html = before;
  Object.defineProperty(els.chron, 'innerHTML', {
    configurable: true,
    get: () => html, set: v => { writes++; html = v; } });
  for (let i = 0; i < 5; i++) EstateHUD.update(state);
  ok('an unchanged frame writes nothing to the feed', writes === 0,
     writes + ' writes');
  const st = clone(state);
  st.days = (st.days || []).concat([{ day: 9999, line: 'new', says: [] }]);
  EstateHUD.update(st);
  ok('a new day writes the feed once', writes === 1, writes + ' writes');
  delete els.chron.innerHTML;
  els.chron.innerHTML = html;
  EstateHUD.update(state);
}

/* closing is a state too: no selection, no card */
EstateHUD.card(state, null);
ok('closing the card hides it', !els.card.classList.contains('on'));

/* --- nothing from the server is markup ------------------------------- */

/* One hostile string goes into every string the HUD writes with innerHTML:
 * the watcher's words (LLM text), the feed, the chronicle, census keys,
 * roles, household kinds, need names, habits, a building's kind and every
 * glyph. It carries both quotes, so the day an attribute interpolates text
 * the check already covers it. A site that drops its `esc` leaves a raw
 * `<img` behind, and the check fails — every site, not only the first. */
const TAG = '"\'><img src=x onerror=1><script>x</script>';

function escaped(name, html) {
  ok(name,
     html.indexOf('<img') < 0 && html.indexOf('<script') < 0 &&
     html.indexOf('&lt;img') >= 0 && html.indexOf('&lt;script') >= 0 &&
     html.indexOf('&quot;') >= 0 && html.indexOf('&#39;') >= 0,
     html.slice(0, 200));
}

ok('esc escapes both quotes and the angle brackets',
   EstateHUD.esc(TAG) ===
   '&quot;&#39;&gt;&lt;img src=x onerror=1&gt;&lt;script&gt;x&lt;/script&gt;',
   EstateHUD.esc(TAG));

const evilGround = clone(ground);
evilGround.glyphs = clone(ground.glyphs || {});
for (const g of ['households', 'roles', 'needs', 'fixtures', 'sites',
                 'weather']) {
  evilGround.glyphs[g] = Object.assign({}, evilGround.glyphs[g] || {},
                                       { [TAG]: TAG });
}
if (evilGround.buildings && evilGround.buildings[0]) {
  evilGround.buildings[0].kind = TAG;
}
EstateHUD.setGround(evilGround);

const evil = clone(state);

/* the watcher line: its reason, and its fate when it gave no reason */
evil.watcher = { fate: TAG, why: TAG };
EstateHUD.update(evil);
escaped('the watcher line escapes the watcher\'s reason', els.watch.innerHTML);
evil.watcher = { fate: TAG, why: '' };
EstateHUD.update(evil);
escaped('the watcher line escapes a fate given without a reason',
        els.watch.innerHTML);

/* the census: a household kind and its glyph, a role and its glyph */
evil.census = { [TAG]: 3 };
evil.people = (evil.people || []).slice(0, 1);
if (evil.people[0]) evil.people[0].role = TAG;
EstateHUD.tab('census', evil);
escaped('the census escapes household kinds and their glyphs',
        els.chron.innerHTML.split('by role')[0]);
escaped('the census escapes roles and their glyphs',
        els.chron.innerHTML.split('by role')[1] || '');

/* the day feed: the day's line, and its news */
evil.days = [{ day: 1, line: TAG, says: [] }];
EstateHUD.tab('chron', evil);
escaped('the day feed escapes a day\'s line', els.chron.innerHTML);
evil.days = [{ day: 1, line: '', says: [TAG, TAG] }];
EstateHUD.tab('chron', evil);
escaped('the day feed escapes a day\'s news', els.chron.innerHTML);
evil.days = [{ day: 1, line: 'quiet', says: ['the Ossian household left the estate'] }];
EstateHUD.tab('chron', evil);
ok('the day feed\'s news has no bullet, as the grove\'s (Iris A3)',
   els.chron.innerHTML.indexOf('<span class="news">the Ossian') >= 0, els.chron.innerHTML);

/* the watcher tab: the chronicle */
evil.chronicle = [{ day: 1, text: TAG }];
EstateHUD.tab('watch', evil);
escaped('the watcher tab escapes the chronicle', els.chron.innerHTML);
EstateHUD.tab('chron', evil);

/* the resident card, one hostile field at a time, so one escaped field
 * cannot stand in for another that is not */
if (!state.people || !state.people[0]) {
  ok('the frame has a resident to card with hostile strings', false);
} else {
  const base = clone(state.people[0]);
  base.role = 'kid'; base.kind = 'family'; base.in = false;
  base.habit = {}; base.needs = {};
  const cases = [
    ['a role (and its glyph)', p => { p.role = TAG; }, 'cardState'],
    ['a household kind', p => { p.kind = TAG; }, 'cardState'],
    ['a need name (and its glyph)', p => { p.needs = { [TAG]: 2 }; },
     'cardRows'],
    ['a habit\'s name', p => { p.habit = { [TAG]: 'home' }; }, 'cardRows'],
    ['a habit\'s place', p => { p.habit = { work: TAG }; }, 'cardRows'],
  ];
  for (const [what, mutate, where] of cases) {
    const st = clone(state);
    const p = clone(base);
    mutate(p);
    st.people = [p];
    EstateHUD.card(st, { kind: 'resident', id: p.id });
    escaped('the resident card escapes ' + what, els[where].innerHTML);
  }
}

/* the family rows: a household member's name and role, and the name of
 * the guardian a young child is out with, each hostile on its own */
if (state.people && state.people[0]) {
  const kidOf = () => Object.assign(clone(state.people[0]), {
    id: 9001, role: 'child', kind: 'family', in: false, habit: {},
    needs: {}, family: [9002], with: 9002 });
  const mumOf = () => Object.assign(clone(state.people[0]), {
    id: 9002, name: 'Ann', role: 'adult', kind: 'family', in: false,
    habit: {}, needs: {}, family: [9001], with: null });
  const cases = [
    ['a family member\'s name', m => { m.name = TAG; }, false],
    ['a family member\'s role (and its glyph)', m => { m.role = TAG; }, false],
    ['the name of who a child is out with', m => { m.name = TAG; }, true],
  ];
  for (const [what, mutate, onlyWith] of cases) {
    const st = clone(state);
    const kid = kidOf();
    const m = mumOf(); mutate(m);
    st.people = [kid, m];
    EstateHUD.card(st, { kind: 'resident', id: kid.id });
    const rows = els.cardRows.innerHTML;
    escaped('the resident card escapes ' + what,
            onlyWith ? (rows.split('out with')[1] || '').split('</li>')[0]
                     : rows);
  }
}

/* the block card: a building's kind comes with the ground */
if (evilGround.buildings && evilGround.buildings[0]) {
  EstateHUD.card(state, { kind: 'building', id: evilGround.buildings[0].id });
  /* the card no longer writes a block's kind (its name says it), so a
   * hostile kind must simply not arrive as markup */
  numeric('a building\'s kind never reaches the block card as markup',
          els.cardState.innerHTML + els.cardRows.innerHTML);
}

/* --- a number is a number -------------------------------------------- */

/* (The resident card's `where` also goes through `esc`, but it is built
 * only from `Number`s and fixed words, so no input can tell that `esc`
 * apart from its absence. What guards it is `Number`, checked here.) */

/* Every number goes through `Number`, so a hostile string where a number
 * belongs comes out as NaN — never as markup, and never as escaped text
 * (escaped text would mean the number went through `esc` instead). */
function numeric(name, html) {
  ok(name,
     html.indexOf('<img') < 0 && html.indexOf('&lt;') < 0 &&
     html.indexOf('img') < 0 && html.indexOf('script') < 0,
     html.slice(0, 200));
}

EstateHUD.setGround(ground);
const nums = clone(state);
nums.residents = TAG; nums.units = TAG; nums.waiting = TAG;
nums.census = { family: TAG };
nums.days = [{ day: TAG, line: 'a day', says: [] }];
nums.chronicle = [{ day: TAG, text: 'a line' }];
EstateHUD.update(nums);
numeric('the header\'s counts are numbers', els.pops.innerHTML);
numeric('the day feed\'s day is a number', els.chron.innerHTML);
EstateHUD.tab('census', nums);
numeric('the census counts are numbers', els.chron.innerHTML);
EstateHUD.tab('watch', nums);
numeric('the chronicle\'s day is a number', els.chron.innerHTML);
EstateHUD.tab('chron', nums);

if (nums.people && nums.people[0]) {
  const p = nums.people[0];
  p.age = TAG; p.in = false; p.x = TAG; p.y = TAG; p.stress = TAG;
  p.habit = {}; p.needs = { rest: TAG };
  p.role = 'kid'; p.kind = 'family';
  EstateHUD.card(nums, { kind: 'resident', id: p.id });
  numeric('a resident\'s age and place are numbers', els.cardState.innerHTML);
  numeric('a need\'s level is a number', els.cardRows.innerHTML);
  const m = clone(p);
  m.id = 9002; m.age = TAG; m.name = 'Ann'; m.role = 'adult';
  p.family = [9002];
  nums.people = [p, m];
  EstateHUD.card(nums, { kind: 'resident', id: p.id });
  numeric('a family member\'s age is a number',
          els.cardRows.innerHTML.split('household')[1] || '');
  nums.people = [p]; p.family = [];
  p.in = true; p.unit = TAG;
  EstateHUD.card(nums, { kind: 'resident', id: p.id });
  numeric('a resident\'s flat is a number', els.cardState.innerHTML);
}
if (nums.fixtures && nums.fixtures[0]) {
  const f = nums.fixtures[0];
  f.x = TAG; f.y = TAG; f.uses = TAG; f.stock = TAG; f.c = TAG;
  EstateHUD.card(nums, { kind: 'fixture', id: f.id });
  numeric('a fixture\'s place, uses and stock are numbers',
          els.cardState.innerHTML);
  numeric('a fixture\'s condition is a number', els.cardRows.innerHTML);
}
if (ground.buildings && ground.buildings[0]) {
  const g2 = clone(ground);
  const b = g2.buildings[0];
  b.floors = TAG; b.door = [TAG, TAG];
  nums.buildings = [{ id: b.id, units: TAG, lived: TAG, power: 1, water: 1 }];
  EstateHUD.setGround(g2);
  EstateHUD.card(nums, { kind: 'building', id: b.id });
  numeric('a block\'s floors and door are numbers', els.cardState.innerHTML);
  numeric('a block\'s flats are numbers', els.cardRows.innerHTML);
  EstateHUD.setGround(ground);
}

console.log('\n' + (fails.length
  ? fails.length + ' FAILED: ' + fails.join('; ') : 'all ok'));
process.exit(fails.length ? 1 : 0);
