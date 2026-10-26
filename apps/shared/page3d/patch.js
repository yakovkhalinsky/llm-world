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
 *   - while a pointer is pressed in a held panel (`Patch.hold`), or it
 *     scrolled a moment ago (a fling still coasting), the write waits and
 *     lands when that ends;
 *   - text selected in the same panel holds it too, but only that panel
 *     and only for SELECT_MS after the selection last changed: a
 *     selection left behind does not freeze the feed for good;
 *   - `opts.newestFirst`: rows arrive at the top. A reader at the top
 *     stays stuck to it and sees the new row; one who has scrolled down
 *     keeps the row they were reading. The feeds are capped, so rows
 *     come in at the top and go out at the bottom at once and the height
 *     says nothing; the patch anchors on the first row in view instead
 *     (its `data-key`, else its text) and puts that row back exactly
 *     where it was. Only when that row and every one after it are gone
 *     does it fall back to the height added above.
 *   - `Patch.drop(el)` forgets a list: what it showed and any write it
 *     was holding, so the next write lands whole; `Patch.fresh(lists)`
 *     does that for a card on a new pick and lets go of the selection;
 *   - `opts.reset`: a different list (a tab change) starts at the top;
 *   - otherwise the position is kept as it was.
 *
 * `Patch.key(when, text)` is a row's `data-key`: its time as a number and a
 * short hash of its words, so a row whose shown words change (a relative
 * "2 weeks ago") keeps its key, and nothing from the frame reaches the
 * attribute but digits and letters.
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
  /* how long a selection holds its panel after it last changed */
  var SELECT_MS = 4000;
  var held = [];               // panels a pointer is pressed in
  var selAt = -Infinity;       // when the selection last changed

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

  /* the scroll box that moves when `el` is written: `el` itself, or the
   * panel it sits in (a card scrolls as one) */
  function scroller(el) {
    return el._scroller || el;
  }

  /* text selected in this list's own panel, chosen in the last SELECT_MS */
  function selecting(el) {
    var s = root.getSelection && root.getSelection();
    if (!s || s.isCollapsed) return false;
    var box = scroller(el);
    if (!((s.anchorNode && inside(box, s.anchorNode)) ||
          (s.focusNode && inside(box, s.focusNode)))) return false;
    if (selAt === -Infinity) selAt = now();   // no selectionchange seen yet
    return now() - selAt < SELECT_MS;
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
  var due = 0;
  /* flush once `ms` from now; an earlier flush already set stands, and
   * whatever is still held then sets the next */
  function later(ms) {
    ms = ms || SETTLE_MS;
    if (!root.setTimeout) return;
    if (timer && due >= now() && due <= now() + ms) return;
    if (timer && root.clearTimeout) root.clearTimeout(timer);
    due = now() + ms;
    timer = root.setTimeout(function () { timer = 0; flush(); }, ms);
  }

  function drop(el) {
    el._html = undefined;
    el._pending = null;
    el._opts = undefined;
    var i = waiting.indexOf(el);
    if (i >= 0) waiting.splice(i, 1);
  }

  /* a new pick: let go of any selected text (it belongs to what was
   * shown) and forget `lists` and their panels' motion, so the card's next
   * writes land whole and at once, never the new name over the old state */
  function fresh(lists) {
    var s = root.getSelection && root.getSelection();
    if (s && !s.isCollapsed && s.removeAllRanges) s.removeAllRanges();
    (lists || []).forEach(function (el) {
      if (!el) return;
      drop(el);
      scroller(el)._scrolledAt = undefined;
    });
  }

  /* the rows of a list, as an array */
  function rowsOf(el) {
    var k = el.children || [];
    return Array.prototype.slice.call(k);
  }

  function keyOf(row) {
    var k = row.getAttribute && row.getAttribute('data-key');
    return k !== null && k !== undefined && k !== '' ? 'k:' + k
      : 't:' + (row.textContent || '');
  }

  /* where a row's top sits, in px below the scroll box's visible top */
  function offsetIn(box, row) {
    if (!row.getBoundingClientRect || !box.getBoundingClientRect) return null;
    return row.getBoundingClientRect().top - box.getBoundingClientRect().top;
  }

  /* the first row in view and the rows after it: [{key, at, index}] */
  function anchors(el, box) {
    var rows = rowsOf(el), out = [];
    for (var i = 0; i < rows.length; i++) {
      var at = offsetIn(box, rows[i]);
      if (at === null) return [];
      var h = rows[i].getBoundingClientRect().height || 0;
      if (!out.length && at + h <= 0) continue;   // above the view
      out.push({ key: keyOf(rows[i]), at: at, index: i });
    }
    return out;
  }

  function count(list, k) {
    var n = 0;
    for (var i = 0; i < list.length; i++) if (list[i] === k) n += 1;
    return n;
  }

  /* put the first surviving anchor back where it was; true if one was.
   * A row whose words appear once, before and after, is trusted first:
   * every row in a capped feed moves by the same amount, so any one of
   * them in view says how far. */
  function reanchor(el, box, marks) {
    var rows = rowsOf(el);
    var keys = rows.map(keyOf);
    var was = marks.map(function (a) { return a.key; });
    var order = marks.filter(function (a) {
      return count(was, a.key) === 1 && count(keys, a.key) === 1;
    }).concat(marks);
    for (var m = 0; m < order.length; m++) {
      var a = order[m], pick = -1;
      /* rows only move down a capped newest-first feed, so the same text
       * twice is told apart by taking the first at or below where it was */
      for (var i = 0; i < keys.length; i++) {
        if (keys[i] !== a.key) continue;
        pick = i;
        if (i >= a.index) break;
      }
      if (pick < 0) continue;
      var at = offsetIn(box, rows[pick]);
      if (at === null) return false;
      box.scrollTop = (box.scrollTop || 0) + (at - a.at);
      return true;
    }
    return false;
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
      else if (!isHeld(el)) later(Math.max(SETTLE_MS, SELECT_MS - (now() - selAt)));
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
    var marks = opts && opts.newestFirst && !atTop ? anchors(el, box) : [];
    el._html = html;
    el.innerHTML = html;
    if (opts && opts.reset) box.scrollTop = 0;
    else if (opts && opts.newestFirst) {
      if (atTop) box.scrollTop = 0;
      else if (!reanchor(el, box, marks)) {
        box.scrollTop = top + ((box.scrollHeight || 0) - before);
      }
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
    /* a selection that ends lets its list catch up at once, not when the
     * hold's timer runs out (a list still held or moving waits on) */
    if (root.document && root.document.addEventListener && !hold.sel) {
      hold.sel = true;
      root.document.addEventListener('selectionchange', function () {
        selAt = now();
        var s = root.getSelection && root.getSelection();
        if (waiting.length && !(s && !s.isCollapsed)) flush();
      });
    }
  }

  /* a row's stable key: `when` as a number, and `text` (if given) as a
   * 32-bit FNV-1a hash in base 36 */
  function key(when, text) {
    var k = String(Number(when));
    if (text === undefined || text === null) return k;
    var s = String(text), h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul ? Math.imul(h, 0x01000193) : (h * 0x01000193) | 0;
    }
    return k + ':' + (h >>> 0).toString(36);
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

  root.Patch = { write: write, hold: hold, fmt: fmt, flush: flush, drop: drop,
                 fresh: fresh, key: key,
                 SETTLE_MS: SETTLE_MS, SELECT_MS: SELECT_MS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
