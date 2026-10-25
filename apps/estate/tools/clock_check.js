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

const Clock = require(path.join(__dirname, '..', 'estate', 'page3d',
                                  'clock.js'));

const fails = [];
function ok(name, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name +
              (cond || !detail ? '' : '   (' + detail + ')'));
  if (!cond) fails.push(name);
}

function fields(l) {
  return [l.sunI, l.hemiI, l.dark, l.offset[0], l.offset[1], l.offset[2],
          l.sun[0], l.sun[1], l.sun[2],
          l.sky[0], l.sky[1], l.sky[2],
          l.hemiSky[0], l.hemiSky[1], l.hemiSky[2],
          l.hemiGround[0], l.hemiGround[1], l.hemiGround[2]];
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

/* --------------------------------------------------------------- the pins */

const pinnedClock = Clock.makeClock({ clockPin: 0.2, forcedPhase: 2 });
ok('?clock= pins the fraction, and wins over ?phase=',
   Clock.fraction(pinnedClock, 0) === 0.2 &&
   Clock.fraction(pinnedClock, 123456) === 0.2);

const phases = [
  [0, 'night', 0.0], [1, 'dawn', 0.2], [2, 'morning', 0.4],
  [3, 'afternoon', 0.6], [4, 'evening', 0.8],
];
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
  ok(label + ': no frame-to-frame jump over twelve days',
     r.maxFrame < EPS_FRAME,
     'worst ' + r.maxFrame.toFixed(6) + ' at ' + r.atFrame);
  ok(label + ': a poll re-anchors without moving the light',
     r.maxPoll < EPS_POLL,
     'worst ' + r.maxPoll.toExponential(3) + ' at ' + r.atPoll);
  ok(label + ': the day turns many times over the run',
     r.turns >= 10, r.turns + ' turns');
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
