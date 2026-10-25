/* patch — the panels' two small habits, shared by both 3D views.
 *
 * `Patch.write(el, html, opts)` writes a list only when it changed, and
 * keeps the reader where they were. The frame is polled every 0.7 s, and
 * the panels used to rewrite their lists on every poll whether or not a
 * word had changed: the rows under a finger were replaced mid-fling, a
 * selection in the feed was lost within a second, the steward's buttons
 * were recreated under a click, and a newest-first feed slid a row down
 * under the reader every time a day arrived. Now:
 *
 *   - the same html again is no write at all (the 700 ms no-op);
 *   - while a pointer is pressed in a held panel (`Patch.hold`), text is
 *     selected in it, or it scrolled a moment ago (a fling still
 *     coasting), the write waits and lands when that ends;
 *   - `opts.newestFirst`: rows arrive at the top. A reader at the top
 *     stays stuck to it and sees the new row; one who has scrolled down
 *     keeps the row they were reading, `scrollTop` moving by exactly the
 *     height added above it. (Right while both feeds drop their old rows
 *     off the bottom; a feed that ever trims from the top needs keyed
 *     rows instead.)
 *   - `opts.reset`: a different list (a tab change) starts at the top;
 *   - otherwise the position is kept as it was.
 *
 * `Patch.fmt(n)` is a count as an Australian reader writes one — 1,234 —
 * rounded to a whole number, and a dash for anything that is not a
 * number. Every count the panels write goes through it.
 *
 * Pure DOM and no world knowledge, a classic script loaded before each
 * `hud.js`, so the HUD checks run it against their stub DOM in Node.
 */
(function (root) {
  'use strict';

  /* how long after the last scroll event a list counts as still moving:
   * longer than the gap between a momentum fling's scroll events */
  var SETTLE_MS = 250;
  var held = [];               // panels a pointer is pressed in

  function now() {
    return root.performance && root.performance.now
      ? root.performance.now() : Date.now();
  }

  function inside(box, el) {
    return box === el || !!(box && box.contains && box.contains(el));
  }

  function isHeld(el) {
    for (var i = 0; i < held.length; i++) {
      if (inside(held[i], el)) return true;
    }
    return false;
  }

  function selecting(el) {
    var s = root.getSelection && root.getSelection();
    return !!(s && !s.isCollapsed && s.anchorNode &&
              inside(el, s.anchorNode));
  }

  /* the scroll box that moves when `el` is written: `el` itself, or the
   * panel it sits in (a card scrolls as one) */
  function scroller(el) {
    return el._scroller || el;
  }

  function moving(el) {
    var box = scroller(el);
    return box._scrolledAt !== undefined &&
      now() - box._scrolledAt < SETTLE_MS;
  }

  var waiting = [];            // lists whose write is held back

  function flush() {
    var list = waiting;
    waiting = [];
    list.forEach(function (el) {
      if (el._pending !== null && el._pending !== undefined) {
        write(el, el._pending, el._opts);
      }
    });
  }

  var timer = 0;
  function later() {
    if (timer || !root.setTimeout) return;
    timer = root.setTimeout(function () { timer = 0; flush(); }, SETTLE_MS);
  }

  function write(el, html, opts) {
    html = String(html);
    var same = el._html === html && (el._pending === null ||
                                     el._pending === undefined);
    if (same && !(opts && opts.reset)) return false;
    if (isHeld(el) || selecting(el) || moving(el)) {
      /* a reset asked for while waiting is not lost to a later write */
      var reset = !!(opts && opts.reset) || !!(el._opts && el._opts.reset &&
                                                 el._pending !== null &&
                                                 el._pending !== undefined);
      el._pending = html;
      el._opts = reset ? Object.assign({}, opts, { reset: true }) : opts;
      if (waiting.indexOf(el) < 0) waiting.push(el);
      if (moving(el)) later();
      return false;
    }
    el._pending = null;
    var box = scroller(el);
    if (el._html === html) {
      /* a reset to the list already shown: back to the top, no write */
      if (opts && opts.reset) box.scrollTop = 0;
      return false;
    }
    var top = box.scrollTop || 0;
    var before = box.scrollHeight || 0;
    var atTop = top <= 2;
    el._html = html;
    el.innerHTML = html;
    if (opts && opts.reset) box.scrollTop = 0;
    else if (opts && opts.newestFirst) {
      box.scrollTop = atTop ? 0 : top + ((box.scrollHeight || 0) - before);
    } else if (box.scrollTop !== top) box.scrollTop = top;
    return true;
  }

  /* Hold a panel's lists still while a pointer is pressed in it, and know
   * when it was last scrolled. `lists` are the elements written inside
   * it, when it is not itself the list. */
  function hold(box, lists) {
    (lists || []).forEach(function (el) { el._scroller = box; });
    var down = function () { if (held.indexOf(box) < 0) held.push(box); };
    var up = function () {
      var i = held.indexOf(box);
      if (i >= 0) held.splice(i, 1);
      flush();
    };
    box.addEventListener('pointerdown', down);
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
    box.addEventListener('pointerleave', up);
    box.addEventListener('scroll', function () {
      box._scrolledAt = now();
      later();
    }, { passive: true });
    /* a selection that ends lets its list catch up */
    if (root.document && root.document.addEventListener && !hold.sel) {
      hold.sel = true;
      root.document.addEventListener('selectionchange', function () {
        if (waiting.length && !(root.getSelection &&
                                !root.getSelection().isCollapsed)) later();
      });
    }
  }

  var NF = typeof Intl !== 'undefined' && Intl.NumberFormat
    ? new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 }) : null;

  function fmt(n) {
    var v = Number(n);
    if (n === null || n === undefined || n === '' || !isFinite(v)) {
      return '—';
    }
    v = Math.round(v) || 0;          // never "-0"
    return NF ? NF.format(v) : v.toLocaleString('en-AU');
  }

  root.Patch = { write: write, hold: hold, fmt: fmt, flush: flush };
})(typeof globalThis !== 'undefined' ? globalThis : this);
