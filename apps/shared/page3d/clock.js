/* clock — the day's hour and the light that follows it.
 *
 * The 3D view's light is one continuous function of one number: the
 * fraction of the day since midnight. This file is that function and
 * nothing else — no THREE, no DOM, no canvas — so it can be run and
 * checked without a browser. `world.js` reads it for the picture; the day
 * clock's properties (no jump at the turn, no jump when a poll re-anchors,
 * `light(0) == light(1)`, a pinned clock or phase, a paused day frozen) are
 * therefore properties of a pure module, not of a renderer.
 *
 * Shared by both 3D views (apps/shared/page3d/); each app serves this
 * folder under its own `/3d/`.
 *
 * It publishes itself as a classic script, like `walk.js` beside it: the 3D
 * page loads it before its module, and `tools/clock_check.js` requires it
 * in Node.
 */
(function (root) {
  'use strict';

  var PHASE_NAMES = ['dawn', 'morning', 'afternoon', 'evening', 'night'];

  /* The day's light as keyframes on a continuous clock. `at` is the
   * fraction of the day, 0 being midnight — the darkest hour, the middle
   * of the night that straddles the day's turn — and 1 the same hour
   * again, so the table wraps without a seam: the last key is the first
   * key's light. The five named phases are equal fifths of the clock, each
   * starting half a fifth before its anchor (night 0.9..1.0 and 0.0..0.1,
   * dawn 0.1..0.3, morning 0.3..0.5, afternoon 0.5..0.7, evening
   * 0.7..0.9), so a phase's anchor is its middle and a frozen `?phase=`
   * shows that phase's own light.
   *
   * `dark` is how much of the night is on: it drives the lamps, the
   * windows and the figures' warmth, and it crosses from 0 to 1 over a
   * long dusk and back over a long dawn rather than at a threshold.
   * Everything between two keys — colour, intensity, sun position,
   * darkness — is eased with a smoothstep, so the sun travels its arc and
   * the light changes pace at the ends of each run instead of stepping at
   * the day's turn. Colours are sRGB hex here (the shape the vendor
   * expects); `lightAt` hands back linear components, which is what
   * THREE.Color's working space holds.
   *
   * `offset` is the sun from the estate's centre, so the same table works
   * on a plan of any size. Dawn and evening keep the warm light but not a
   * grazing sun: below about 25° the shadow camera sees the estate
   * edge-on and a low sun throws long rectangles across everything beyond
   * it. The colour says the hour; the elevation stays high enough for the
   * light to fall like light.
   *
   * Dusk has a key of its own at 0.90 — a dusky rose between the orange
   * evening and the blue night, still lit about halfway between the two —
   * so the last fifth of the day steps down evenly (frame brightness
   * roughly 70, 55, 38 at 0.80, 0.85, 0.90, and 19 at night) rather than
   * falling from sunset to moonlight in one ease.
   *
   * The night is lit by the moon, not by the sky: the hemisphere fill is
   * lower than by day (0.5) and a deep blue, so a night has depth and
   * the warm lamps and the grove's few glows carry it, rather than a flat blue wash. By
   * day the sun is the strong key and the fill is held at 0.55, so blocks
   * and trees have a shadow side. */
  var LIGHT = [
    { at: 0.00, sun: 0xa8b8d8, sunI: 0.5,
      offset: [-20, 28, -28], sky: 0x131d36, hemiSky: 0x4a5d88,
      hemiGround: 0x1c2129, hemiI: 0.5, dark: 1.0 },
    { at: 0.20, sun: 0xffb27a, sunI: 1.15,
      offset: [28, 20, 20], sky: 0xe6b28c, hemiSky: 0xffd6ae,
      hemiGround: 0x4a4034, hemiI: 0.55, dark: 0.35 },
    { at: 0.40, sun: 0xfff2dc, sunI: 2.6,
      offset: [24, 40, 26], sky: 0x9fcdf2, hemiSky: 0xdcecff,
      hemiGround: 0x4e5648, hemiI: 0.55, dark: 0.0 },
    { at: 0.60, sun: 0xffe0b0, sunI: 2.4,
      offset: [-24, 36, 18], sky: 0xa9d6f5, hemiSky: 0xe4f0ff,
      hemiGround: 0x55584a, hemiI: 0.55, dark: 0.0 },
    { at: 0.80, sun: 0xff8a4c, sunI: 1.35,
      offset: [-30, 20, -14], sky: 0xd98a62, hemiSky: 0xffc9a8,
      hemiGround: 0x40372e, hemiI: 0.48, dark: 0.50 },
    { at: 0.90, sun: 0xd8a08c, sunI: 0.85,
      offset: [-25, 24, -21], sky: 0x5a3c4e, hemiSky: 0x9a86a4,
      hemiGround: 0x36302e, hemiI: 0.58, dark: 0.8 },
    { at: 1.00, sun: 0xa8b8d8, sunI: 0.5,
      offset: [-20, 28, -28], sky: 0x131d36, hemiSky: 0x4a5d88,
      hemiGround: 0x1c2129, hemiI: 0.5, dark: 1.0 },
  ];

  /* ACES exposure: a little over by day, level at night, eased by `dark`
   * — the night reads as moonlit rather than murky, and the warm lamps
   * still stand out against it. */
  var EXPOSURE_DAY = 1.1;
  var EXPOSURE_NIGHT = 1.0;
  /* The fog leans this far from the sky's colour toward the hemisphere's
   * ground colour by day, so the horizon sits a little darker than the sky
   * and the board does not float. It goes to nothing as `dark` comes on: a
   * night's fog is the night sky's own colour. */
  var FOG_GROUND = 0.15;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function mixNum(a, b, f) { return a + (b - a) * f; }
  /* Ease the run between two keys: the light leaves an anchor and arrives
   * at the next one at rest, which is what gives a dusk a beginning and an
   * end rather than a constant rate from noon to midnight. */
  function smooth01(t) { return t * t * (3 - 2 * t); }

  /* the vendor's own sRGB-to-linear curve, so interpolating here is the
   * same arithmetic THREE.Color does in its working space */
  function srgbToLinear(c) {
    return c < 0.04045 ? c * 0.0773993808
                       : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
  }
  function hexToLinear(hex) {
    return [srgbToLinear(((hex >> 16) & 255) / 255),
            srgbToLinear(((hex >> 8) & 255) / 255),
            srgbToLinear((hex & 255) / 255)];
  }
  function lerp3(a, b, f) {
    return [mixNum(a[0], b[0], f), mixNum(a[1], b[1], f),
            mixNum(a[2], b[2], f)];
  }

  var LINEAR = LIGHT.map(function (k) {
    return { sun: hexToLinear(k.sun), sky: hexToLinear(k.sky),
             hemiSky: hexToLinear(k.hemiSky),
             hemiGround: hexToLinear(k.hemiGround) };
  });

  /* --- the clock ------------------------------------------------------ */

  function makeClock(opts) {
    opts = opts || {};
    var pin = opts.clockPin;
    var forced = opts.forcedPhase;
    return {
      dayMs: Math.max(300, opts.dayMs || 6000),
      dayStart: 0,          // wall time at the client's fraction 0
      daySeen: -1,          // the server day the clock was last anchored to
      paused: false,
      pausedFrac: 0,        // the fraction a paused day is frozen at
      clockPin: (typeof pin === 'number' && isFinite(pin) && pin >= 0)
        ? clamp01(pin) : -1,
      forcedPhase: (typeof forced === 'number' && isFinite(forced))
        ? forced : -1,
      haveState: false,
    };
  }

  /* The fraction since `dayStart`, taken modulo one day: a late poll can
   * let the clock run through the turn before the state arrives without
   * ever stopping or jumping. */
  function dayNow(c, now) {
    var t = (now - c.dayStart) / c.dayMs;
    return t <= 0 ? 0 : t - Math.floor(t);
  }

  function fraction(c, now) {
    if (c.clockPin >= 0) return c.clockPin;
    if (c.forcedPhase >= 0) return ((c.forcedPhase + 1) % 5) / 5;
    if (!c.haveState) return 0.2;       // the dawn the first state opens in
    return c.paused ? c.pausedFrac : dayNow(c, now);
  }

  /* A pace change alters the rate, not the hour: keep the fraction the
   * light has already reached. */
  function setPace(c, now, tickSeconds) {
    var next = Math.max(300, (tickSeconds || 6) * 1000);
    if (next === c.dayMs) return false;
    var frac = dayNow(c, now);
    c.dayMs = next;
    if (c.daySeen >= 0) c.dayStart = now - frac * c.dayMs;
    return true;
  }

  /* A poll arrived. Pausing freezes the clock at the hour it is showing;
   * resuming re-anchors so the light does not move. A new day re-anchors
   * at the fraction already reached rather than at zero — the table's
   * first and last keys are the same night, so the light keeps running
   * through the turn and the poll's lateness never drags it backwards.
   * (A stepped day while paused is a new day too, and starts at midnight.) */
  function onState(c, now, st) {
    if (!!st.paused !== c.paused) {
      if (st.paused) c.pausedFrac = dayNow(c, now);
      else c.dayStart = now - c.pausedFrac * c.dayMs;
      c.paused = !!st.paused;
    }
    if (st.day !== c.daySeen) {
      var first = c.daySeen < 0;
      c.daySeen = st.day;
      if (c.paused) c.pausedFrac = first ? 0.2 : 0;
      else if (first) c.dayStart = now - 0.2 * c.dayMs;
      else c.dayStart = now - dayNow(c, now) * c.dayMs;
    }
  }

  /* The five names are equal fifths of the same clock the light reads,
   * each starting half a fifth before its anchor, so the HUD cannot call
   * it night while the estate is still at dusk. Night straddles the turn. */
  function phaseAt(frac) {
    var names = frac - 0.1;
    if (names < 0) names += 1;
    var index = Math.min(4, Math.floor(names * 5));
    return { index: index, name: PHASE_NAMES[index],
             phase: names * 5, dayFrac: frac };
  }

  /* Everything the sky needs at one fraction, eased across the key either
   * side. Colours are linear components (see srgbToLinear). */
  function lightAt(dayFrac) {
    var f = clamp01(dayFrac);
    var i = 0;
    while (i < LIGHT.length - 2 && f >= LIGHT[i + 1].at) i++;
    var a = LIGHT[i], b = LIGHT[i + 1];
    var la = LINEAR[i], lb = LINEAR[i + 1];
    var span = b.at - a.at;
    var t = span > 0 ? smooth01(clamp01((f - a.at) / span)) : 0;
    return {
      sunI: mixNum(a.sunI, b.sunI, t),
      hemiI: mixNum(a.hemiI, b.hemiI, t),
      dark: mixNum(a.dark, b.dark, t),
      offset: [mixNum(a.offset[0], b.offset[0], t),
               mixNum(a.offset[1], b.offset[1], t),
               mixNum(a.offset[2], b.offset[2], t)],
      sun: lerp3(la.sun, lb.sun, t),
      sky: lerp3(la.sky, lb.sky, t),
      hemiSky: lerp3(la.hemiSky, lb.hemiSky, t),
      hemiGround: lerp3(la.hemiGround, lb.hemiGround, t),
      exposure: exposureAt(mixNum(a.dark, b.dark, t)),
    };
  }

  /* the renderer's exposure for a darkness 0..1 */
  function exposureAt(dark) {
    return mixNum(EXPOSURE_DAY, EXPOSURE_NIGHT, clamp01(dark));
  }

  /* how far the fog leans toward the ground colour at a darkness 0..1 */
  function fogGroundMix(dark) {
    return FOG_GROUND * (1 - clamp01(dark));
  }

  var api = {
    PHASE_NAMES: PHASE_NAMES,
    LIGHT: LIGHT,
    EXPOSURE_DAY: EXPOSURE_DAY,
    EXPOSURE_NIGHT: EXPOSURE_NIGHT,
    FOG_GROUND: FOG_GROUND,
    exposureAt: exposureAt,
    fogGroundMix: fogGroundMix,
    clamp01: clamp01,
    mixNum: mixNum,
    smooth01: smooth01,
    srgbToLinear: srgbToLinear,
    makeClock: makeClock,
    dayNow: dayNow,
    fraction: fraction,
    setPace: setPace,
    onState: onState,
    phaseAt: phaseAt,
    lightAt: lightAt,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  /* `Page3DClock` is the shared name (both apps' 3D views read it);
   * `EstateClock` stays for the estate's module and checks. */
  root.Page3DClock = api;
  root.EstateClock = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
