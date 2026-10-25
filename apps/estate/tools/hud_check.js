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
ok('the voice line is the server\'s', els.voice.textContent === (state.llm || ''),
   els.voice.textContent);

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
   censusKeys.every(k => censusHtml.indexOf(k) >= 0),
   censusKeys.filter(k => censusHtml.indexOf(k) < 0).join(', '));
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

const fixture = first(state.fixtures);
if (!fixture) {
  ok('the frame has a fixture to card', false);
} else {
  ok('a fixture gets a card',
     EstateHUD.card(state, { kind: 'fixture', id: fixture.id}) &&
     els.cardName.textContent.indexOf(fixture.kind) >= 0,
     els.cardName.textContent);
  ok('the fixture card carries its use and its wear',
     els.cardState.innerHTML.indexOf('used') >= 0 &&
     els.cardRows.innerHTML.indexOf('condition') >= 0,
     els.cardState.innerHTML);
}

const building = first(ground.buildings);
if (!building) {
  ok('the ground has a building to card', false);
} else {
  ok('a block gets a card',
     EstateHUD.card(state, { kind: 'building', id: building.id}) &&
     els.cardName.textContent === building.name,
     els.cardName.textContent);
  ok('the block card carries the flats',
     els.cardRows.innerHTML.indexOf('flats') >= 0,
     els.cardRows.innerHTML);
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
  ok('the cell card carries its shade and lamp',
     els.cardRows.innerHTML.indexOf('shade') >= 0 &&
     els.cardRows.innerHTML.indexOf('lamp') >= 0,
     els.cardRows.innerHTML);
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
        els.chron.innerHTML.split('by age')[0]);
escaped('the census escapes roles and their glyphs',
        els.chron.innerHTML.split('by age')[1] || '');

/* the day feed: the day's line, and its news */
evil.days = [{ day: 1, line: TAG, says: [] }];
EstateHUD.tab('chron', evil);
escaped('the day feed escapes a day\'s line', els.chron.innerHTML);
evil.days = [{ day: 1, line: '', says: [TAG, TAG] }];
EstateHUD.tab('chron', evil);
escaped('the day feed escapes a day\'s news', els.chron.innerHTML);

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

/* the block card: a building's kind comes with the ground */
if (evilGround.buildings && evilGround.buildings[0]) {
  EstateHUD.card(state, { kind: 'building', id: evilGround.buildings[0].id });
  escaped('the block card escapes the building\'s kind',
          els.cardState.innerHTML);
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
