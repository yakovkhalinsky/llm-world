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
for (const f of ['walk.js', 'hud.js', 'clock.js']) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'estate', 'page3d', f), 'utf8');
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

const evil = clone(state);
const tag = '<img src=x onerror=alert(1)>';
if (person) evil.people[0].role = tag;
if (evil.people[0]) {
  EstateHUD.card(evil, { kind: 'resident', id: evil.people[0].id });
  ok('the resident card escapes a role',
     els.cardState.innerHTML.indexOf('<img') < 0 &&
     els.cardState.innerHTML.indexOf('&lt;img') >= 0,
     els.cardState.innerHTML.slice(0, 160));
}
evil.days = [{ day: 1, line: tag, says: [tag] }];
EstateHUD.tab('chron', evil);
ok('the day feed escapes a line and its news',
   els.chron.innerHTML.indexOf('<img') < 0 &&
   els.chron.innerHTML.indexOf('&lt;img') >= 0,
   els.chron.innerHTML.slice(0, 160));
evil.chronicle = [{ day: 1, text: tag }];
EstateHUD.tab('watch', evil);
ok('the watcher tab escapes the chronicle',
   els.chron.innerHTML.indexOf('<img') < 0 &&
   els.chron.innerHTML.indexOf('&lt;img') >= 0,
   els.chron.innerHTML.slice(0, 160));

/* a card number is a number: a string that is not one must not leak */
const numeric = clone(state);
if (numeric.people[0]) {
  numeric.people[0].age = 41;
  EstateHUD.card(numeric, { kind: 'resident', id: numeric.people[0].id });
  ok('numbers reach the card as numbers, not NaN',
     els.cardState.innerHTML.indexOf('NaN') < 0,
     els.cardState.innerHTML);
}

console.log('\n' + (fails.length
  ? fails.length + ' FAILED: ' + fails.join('; ') : 'all ok'));
process.exit(fails.length ? 1 : 0);
