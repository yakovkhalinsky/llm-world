/* The day clock's check.
 *
 * The 3D page's light is one continuous function of the day's fraction
 * (`page3d/clock.js`). The property that matters — no frame-to-frame jump
 * in the light, above all at the day's turn and when a poll re-anchors the
 * clock — was previously checked only by a Python replica that lived in a
 * commit message. This runs the production module.
 *
 * At 60s, 20s and 5s a day, with a 700ms poll (the page's own cadence),
 * over many days and a pace change in the middle: every frame's light is
 * compared with the one before it, and every poll's re-anchor is compared
 * with the light it replaced. `light(0) == light(1)`, the pinned clock and
 * phase land where the README says, and a paused day stays frozen.
 *
 *   node tools/clock_check.js
 */

'use strict';

const path = require('path');

const Clock = require(path.join(__dirname, '..', '..', 'shared', 'page3d',
                               'clock.js'));

const fails = [];
function ok(name, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name +
              (cond || !detail ? '' : '   (' + detail + ')'));
  if (!cond) fails.push(name);
}

/* The sun's offset is in world units (tens of cells), the other channels
 * are 0..~2.4; scale the offset by the table's own largest offset so a
 * jump in any channel is measured on the same footing. */
const OFFSET_SCALE = 1 / Math.max(...Clock.LIGHT.map(
  k => Math.max(...k.offset.map(Math.abs))));
function fields(l) {
  return [l.sunI, l.hemiI, l.dark,
          l.offset[0] * OFFSET_SCALE, l.offset[1] * OFFSET_SCALE,
          l.offset[2] * OFFSET_SCALE,
          l.sun[0], l.sun[1], l.sun[2],
          l.sky[0], l.sky[1], l.sky[2],
          l.hemiSky[0], l.hemiSky[1], l.hemiSky[2],
          l.hemiGround[0], l.hemiGround[1], l.hemiGround[2],
          l.exposure, Clock.fogGroundMix(l.dark)];
}

function diff(a, b) {
  const fa = fields(a), fb = fields(b);
  let worst = 0;
  for (let i = 0; i < fa.length; i++) {
    worst = Math.max(worst, Math.abs(fa[i] - fb[i]));
  }
  return worst;
}

/* --------------------------------------------------------------- the table */

const at0 = Clock.lightAt(0);
const at1 = Clock.lightAt(1);
ok('light(0) equals light(1) — the wrap has no seam',
   diff(at0, at1) < 1e-12, diff(at0, at1));
ok('the light table starts at midnight and ends at midnight',
   Clock.LIGHT[0].at === 0 &&
   Clock.LIGHT[Clock.LIGHT.length - 1].at === 1);
ok('the last key is the first key, channel for channel',
   Clock.LIGHT[0].sun === Clock.LIGHT[Clock.LIGHT.length - 1].sun &&
   Clock.LIGHT[0].sky === Clock.LIGHT[Clock.LIGHT.length - 1].sky &&
   Clock.LIGHT[0].dark === Clock.LIGHT[Clock.LIGHT.length - 1].dark);
ok('night is the darkest hour and noon the lightest',
   at0.dark === 1 && Clock.lightAt(0.4).dark === 0 &&
   Clock.lightAt(0.6).sunI > at0.sunI);

/* ------------------------------------------ the art direction's values */

/* Iris's review: a moonlit night (dim, blue, never a wash), a crisper day
 * (a stronger sun over a lower fill), the exposure easing from 1.1 by day
 * to 1.0 at night, and a fog leaned toward the ground by day only. */
function hexIs(v, hex) { return v === hex; }
for (const k of [Clock.LIGHT[0], Clock.LIGHT[Clock.LIGHT.length - 1]]) {
  ok('night key ' + k.at + ' is moonlight, not a wash',
     k.hemiI === 0.5 && k.sunI === 0.5 &&
     hexIs(k.hemiSky, 0x4a5d88) && hexIs(k.hemiGround, 0x1c2129) &&
     hexIs(k.sun, 0xa8b8d8) && hexIs(k.sky, 0x131d36),
     JSON.stringify(k));
}
{
  const k9 = Clock.LIGHT.find(k => k.at === 0.9);
  ok('a dusk key at 0.90 steps evening down to the night',
     k9 && k9.hemiI === 0.58 && k9.sunI === 0.85 &&
     hexIs(k9.sun, 0xd8a08c) && hexIs(k9.sky, 0x5a3c4e) &&
     hexIs(k9.hemiSky, 0x9a86a4) && hexIs(k9.hemiGround, 0x36302e) &&
     k9.dark === 0.8,
     JSON.stringify(k9));
}
{
  const k4 = Clock.LIGHT.find(k => k.at === 0.4);
  const k6 = Clock.LIGHT.find(k => k.at === 0.6);
  ok('midday keys: a stronger sun over a lower fill',
     k4.sunI === 2.6 && k6.sunI === 2.4 &&
     k4.hemiI === 0.55 && k6.hemiI === 0.55,
     JSON.stringify([k4, k6]));
  ok('the sun outweighs the fill by day, the fill no longer drowns it',
     Clock.lightAt(0.5).sunI / Clock.lightAt(0.5).hemiI > 4);
}
ok('exposure is 1.1 by day', Clock.EXPOSURE_DAY === 1.1 &&
   Math.abs(Clock.lightAt(0.5).exposure - 1.1) < 1e-12 &&
   Math.abs(Clock.lightAt(0.4).exposure - 1.1) < 1e-12,
   Clock.lightAt(0.5).exposure);
ok('exposure is 1.0 at night', Clock.EXPOSURE_NIGHT === 1.0 &&
   Math.abs(at0.exposure - 1.0) < 1e-12 &&
   Math.abs(at1.exposure - 1.0) < 1e-12, at0.exposure);
ok('exposure follows the dark, and stays between its ends', (() => {
  for (let f = 0; f <= 1; f += 0.001) {
    const l = Clock.lightAt(f);
    const want = 1.1 + (1.0 - 1.1) * l.dark;
    if (Math.abs(l.exposure - want) > 1e-9) return false;
    if (l.exposure < 1.0 - 1e-12 || l.exposure > 1.1 + 1e-12) return false;
  }
  return true;
})());
ok('exposure clamps a dark outside 0..1',
   Clock.exposureAt(-1) === 1.1 && Clock.exposureAt(2) === 1.0);
ok('the fog leans 15% toward the ground by day, none at night',
   Clock.FOG_GROUND === 0.15 && Clock.fogGroundMix(0) === 0.15 &&
   Clock.fogGroundMix(1) === 0 &&
   Math.abs(Clock.fogGroundMix(0.5) - 0.075) < 1e-12 &&
   Clock.fogGroundMix(-1) === 0.15 && Clock.fogGroundMix(3) === 0);

/* --------------------------------------------------------------- the pins */

const pinnedClock = Clock.makeClock({ clockPin: 0.2, forcedPhase: 2 });
ok('?clock= pins the fraction, and wins over ?phase=',
   Clock.fraction(pinnedClock, 0) === 0.2 &&
   Clock.fraction(pinnedClock, 123456) === 0.2);

/* the index is the one viewer.js's PHASE_ALIAS hands the clock, which is
 * PHASE_NAMES order: dawn 0 … night 4 */
const phases = [
  [4, 'night', 0.0], [0, 'dawn', 0.2], [1, 'morning', 0.4],
  [2, 'afternoon', 0.6], [3, 'evening', 0.8],
];
for (const [forced, name] of phases) {
  ok('phase index ' + forced + ' is ' + name,
     Clock.PHASE_NAMES[forced] === name, Clock.PHASE_NAMES[forced]);
}
for (const [forced, name, frac] of phases) {
  const c = Clock.makeClock({ forcedPhase: forced });
  ok('?phase=' + name + ' freezes at its own hour',
     Clock.fraction(c, 98765) === frac, Clock.fraction(c, 98765));
  const p = Clock.phaseAt(frac);
  ok('the fraction ' + frac + ' is called ' + name, p.name === name, p.name);
}
ok('night straddles the day turn',
   Clock.phaseAt(0.0).name === 'night' &&
   Clock.phaseAt(0.09).name === 'night' &&
   Clock.phaseAt(0.9).name === 'night');

/* --------------------------------------------------------- a paused day */

{
  const c = Clock.makeClock({});
  Clock.onState(c, 0, { day: 1, paused: false });
  c.haveState = true;             // as world.js setState does
  const frozen = Clock.fraction(c, 1000);
  Clock.onState(c, 1000, { day: 1, paused: true });
  let moved = 0;
  for (let t = 1000; t < 20000; t += 250) {
    moved = Math.max(moved, Math.abs(Clock.fraction(c, t) - frozen));
  }
  ok('a paused day freezes the clock', moved < 1e-12, moved);
  Clock.onState(c, 20000, { day: 1, paused: false });
  ok('unpausing resumes from the frozen hour',
     Math.abs(Clock.fraction(c, 20000) - frozen) < 1e-12);
}

/* ------------------------------------------------- no jump, over the days */

function run(tickSeconds, days, paceChangeAfter) {
  const c = Clock.makeClock({});
  /* the page sets the pace from the first state's tick_seconds */
  Clock.setPace(c, 0, tickSeconds);
  let now = 0;
  let day = 1;
  let dayMs = tickSeconds * 1000;
  let nextPoll = 0;
  let nextPace = paceChangeAfter == null ? Infinity : paceChangeAfter;
  /* the page opens at 0.2 of the day, so the first turn is 0.8 of a day
   * away (Clock.onState's first-state anchor) */
  let nextDayAt = 0.8 * dayMs;
  Clock.onState(c, now, { day, paused: false });
  c.haveState = true;             // the first state has been drawn

  let last = Clock.lightAt(Clock.fraction(c, now));
  let maxFrame = 0;
  let maxPoll = 0;
  let atFrame = null;
  let atPoll = null;
  let turns = 0;

  const end = days * dayMs;
  while (now < end) {
    now += 16;                       // about one animation frame

    // the server's day advances on its own cadence, not on the poll's;
    // a pace change moves the rate, never the day number backwards
    if (now >= nextDayAt) {
      day++;
      turns++;
      nextDayAt = now + dayMs;
    }

    if (now >= nextPoll) {
      nextPoll = now + 700;          // the page's poll
      const before = Clock.lightAt(Clock.fraction(c, now));
      Clock.onState(c, now, { day, paused: false });
      const after = Clock.lightAt(Clock.fraction(c, now));
      const d = diff(before, after);
      if (d > maxPoll) { maxPoll = d; atPoll = now; }
    }

    if (now >= nextPace) {
      nextPace = Infinity;
      const before = Clock.lightAt(Clock.fraction(c, now));
      const next = tickSeconds === 60 ? 5 : 60;
      Clock.setPace(c, now, next);
      dayMs = next * 1000;
      nextDayAt = now + dayMs;
      const after = Clock.lightAt(Clock.fraction(c, now));
      const d = diff(before, after);
      if (d > maxPoll) { maxPoll = d; atPoll = now; }
    }

    const l = Clock.lightAt(Clock.fraction(c, now));
    const d = diff(last, l);
    if (d > maxFrame) { maxFrame = d; atFrame = Clock.fraction(c, now); }
    last = l;
  }
  return { maxFrame, atFrame, maxPoll, atPoll, turns };
}

/* A frame is 16ms, so at the fastest pace (5s a day) one frame is 0.0032
 * of a day; even a channel moving at the table's steepest is far inside
 * 0.05. A jump at the turn would be an order of magnitude larger. */
const EPS_FRAME = 0.05;
const EPS_POLL = 1e-9;

for (const tick of [60, 20, 5]) {
  const r = run(tick, 12, tick === 20 ? 6 * tick * 1000 : null);
  const label = 'a day every ' + tick + 's';
  ok(label + ': no frame-to-frame jump over the run',
     r.maxFrame < EPS_FRAME,
     'worst ' + r.maxFrame.toFixed(6) + ' at ' + r.atFrame);
  ok(label + ': a poll re-anchors without moving the light',
     r.maxPoll < EPS_POLL,
     'worst ' + r.maxPoll.toExponential(3) + ' at ' + r.atPoll);
  ok(label + ': the day turns many times over the run',
     r.turns >= 5, r.turns + ' turns');
  console.log('  ---- ' + label + ': ' + r.turns + ' days, worst frame ' +
              r.maxFrame.toFixed(6) + ', worst poll ' +
              r.maxPoll.toExponential(2));
}

/* A full sweep, independent of the simulation: every adjacent pair of
 * fractions is continuous, including across the seam. */
{
  let worst = 0, where = 0;
  const step = 1 / 5000;
  let prev = Clock.lightAt(0);
  for (let i = 1; i <= 5000; i++) {
    const f = (i * step) % 1;
    const l = Clock.lightAt(f);
    const d = diff(prev, l);
    if (d > worst) { worst = d; where = f; }
    prev = l;
  }
  ok('a dense sweep of the whole day is continuous', worst < 0.01,
     'worst ' + worst.toFixed(6) + ' near ' + where);
}

console.log('\n' + (fails.length
  ? fails.length + ' FAILED: ' + fails.join('; ') : 'all ok'));
process.exit(fails.length ? 1 : 0);
