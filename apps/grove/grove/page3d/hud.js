/* hud — the words around the grove.
 *
 * The scene shows the grove; these panels say what it means. Both read the
 * same frame the server sent, so a count in a panel and a creature in the
 * scene can never disagree.
 *
 * This file is pure DOM: no THREE, no WebGL, no fetch. It is a classic
 * script, loaded before the module like the shared `walk.js`, `clock.js`
 * and `field.js`, so `tools/hud_check.js` can run the same code against a
 * stub DOM in Node.
 *
 * Every string that comes from the world is escaped once, where it is
 * written — and a good deal of it is written by a language model: the
 * chronicle, the soul's line, the steward's rules and reasons and verdict,
 * the biographies. `textContent` is used for a single line; `innerHTML` is
 * only used for rows whose strings have been through `esc`, and every
 * number goes through `Number`. (The pixi page this replaces wrote the
 * chronicle, the census, the biographies and the steward's words straight
 * into innerHTML.)
 */
(function (root) {
  'use strict';

  var view = 'chron';
  var tuning = null;            // the last /api/tuning answer
  var TABS = [
    ['chron', 'tabChron'],
    ['census', 'tabCensus'],
    ['tune', 'tabTune'],
  ];
  var BLOCKS = '▁▂▃▄▅▆▇█';

  function $(id) { return document.getElementById(id); }

  /* the page's one escaper: viewer.js borrows it as `GroveHUD.esc`. Both
   * quotes are escaped, so a string is safe in an attribute whichever
   * quote the attribute uses. */
  var esc = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
                 "'": '&#39;' }[c];
      });
  };

  function ago(tick, now) {
    var d = Number(now) - Number(tick);
    return d <= 0 ? 'now' : Number(d) + 'wk ago';
  }

  /* ----------------------------------------------------------- the head */

  function head(st) {
    $('when').textContent = 'week ' + Number(st.tick) + ' · ' +
      (st.season || '');
    $('weather').textContent = (st.weather_emo || '') + ' ' +
      (st.weather || '');
    $('pops').innerHTML = (st.pop_chips || []).map(function (c) {
      return '<span class="popline"><span class="picon">' + esc(c.emo) +
        '</span><span class="pname">' + esc(c.name) +
        '</span><span class="pnum">' + Number(c.n) + '</span></span>';
    }).join('');

    var soul = $('soul');
    soul.textContent = st.soul ? '☾ ' + st.soul : '';
    soul.className = 'soul' + (st.soul === 'listening…' ? ' pulse' : '');

    var llm = st.llm || {};
    var f = llm.fail;
    $('status').textContent = (st.paused ? 'paused · ' : '') +
      (llm.status || '') +
      (llm.reason ? ' — last stumble: ' + llm.reason : '') +
      (f ? ' [the ' + f.job + ' job, on ' + f.model + ']' : '');
    /* hover the status line to see exactly what the model sent back */
    $('status').title = f ? 'the ' + f.job + ' job could not be read — ' +
      f.why + (f.raw ? '\n\n' + f.raw : '') : '';
  }

  /* ----------------------------------------------------- the chronicle */

  /* The mark says whose words a line is; it is chosen from a fixed table,
   * never copied from the frame. */
  function markOf(source) {
    if (source === 'llm' || source === 'soul') return ['mark-llm', '☾'];
    if (source === 'voice') return ['mark-voice', '☂'];
    return ['mark-template', '·'];
  }

  function chronicle(st) {
    var rows = st.chronicle || [];
    return rows.length ? rows.map(function (c) {
      var m = markOf(c.source);
      return '<li><span class="' + m[0] + '">' + m[1] + '</span> ' +
        esc(c.text) + '<span class="when">' + esc(ago(c.tick, st.tick)) +
        '</span></li>';
    }).join('') : '<li>the chronicle is still blank. it is early.</li>';
  }

  /* ---------------------------------------------------------- the census */

  function spark(values) {
    var v = (values || []).map(function (x) { return Number(x) || 0; });
    if (!v.length) v = [0];
    var peak = Math.max(Math.max.apply(null, v), 1);
    return v.map(function (x) {
      return BLOCKS[Math.max(0, Math.min(7, Math.floor(x * 8 / peak)))];
    }).join('');
  }

  function census(st) {
    var rows = (st.series || []).map(function (sr) {
      var v = sr.values || [];
      return '<li class="sparkline"><span class="name">' + esc(sr.emo) +
        ' ' + esc(sr.name) + ' <b>' + Number(v.length ? v[v.length - 1] : 0) +
        '</b></span><span class="spark">' + spark(v) + '</span></li>';
    });
    return rows.length ? rows.join('')
      : '<li>nothing has been counted yet.</li>';
  }

  /* --------------------------------------------------------- the steward */

  function moveTo(was, now) {
    return (was === null || was === undefined)
      ? '→ ' + esc(now) : esc(was) + ' → ' + esc(now);
  }

  /* The steward's words are a model's: the rule it names, its reason, its
   * verdict and a proposal's status all go through `esc`; the id that the
   * accept and dismiss buttons carry goes through `Number`. Under
   * auto-tune the steward takes its own first amendment, so there is
   * nothing for the keeper to press and the buttons are not drawn. */
  function tune(s) {
    if (!s) return '<li>asking the steward…</li>';
    var auto = !!s.auto_tune;
    var rows = (s.pending || []).map(function (p) {
      return '<li><b>' + esc(p.rule) + '</b> ' + moveTo(p.was, p.value) +
        '<div class="when">wk' + Number(p.week) + ' — ' + esc(p.why) +
        '</div>' +
        (auto ? '' :
          '<div><button class="mini" data-a="accept" data-id="' +
          Number(p.id) + '">⚔ accept</button> ' +
          '<button class="mini" data-a="dismiss" data-id="' +
          Number(p.id) + '">leave it</button></div>') +
        '</li>';
    });
    var last = s.last;
    var lastHtml = last
      ? '<li class="when">the steward read the ledger at wk' +
        Number(last.week) + ' — ' +
        (last.amendments
          ? Number(last.amendments) + ' amendment' +
            (Number(last.amendments) > 1 ? 's' : '')
          : 'nothing to change') +
        (last.verdict ? '<br><i>“' + esc(last.verdict) + '”</i>' : '') +
        '</li>'
      : '';
    var headHtml = rows.length && auto
      ? '<li class="when">also asked for, and kept for the record — one ' +
        'rule is taken a year:</li>' : '';
    var hist = (s.history || []).slice(0, 8).map(function (h) {
      return '<li style="opacity:.75"><b>' + esc(h.rule) + '</b> ' +
        moveTo(h.was, h.value) + ' <span class="when">' + esc(h.status) +
        ' · wk' + Number(h.week) + '</span></li>';
    });
    return lastHtml + headHtml +
      (rows.join('') ||
       '<li class="when">the steward offers nothing at the moment.</li>') +
      (hist.length ? '<li class="sub">the world\'s amendments</li>' +
                     hist.join('') : '');
  }

  function setTuning(s) {
    tuning = s;
    if (view === 'tune') $('chron').innerHTML = tune(tuning);
  }

  /* ------------------------------------------------------------ the tabs */

  function render(st) {
    var el = $('chron');
    el.className = 'chron' + (view === 'tune' ? ' tune' : '');
    if (view === 'census') el.innerHTML = census(st);
    else if (view === 'tune') el.innerHTML = tune(tuning);
    else el.innerHTML = chronicle(st);
  }

  function tab(name, st) {
    view = TABS.some(function (t) { return t[0] === name; }) ? name : 'chron';
    TABS.forEach(function (t) {
      $(t[1]).classList.toggle('on', t[0] === view);
    });
    if (st) render(st);
  }

  /* ------------------------------------------------------------ the card */

  /* What the frame itself says about a creature or a plant, written the
   * moment it is clicked; the biography (`bio`) follows when the ledger
   * answers. The name is plain text: the card writes it with textContent. */
  function cardFor(st, sel) {
    if (!st || !sel) return null;
    if (sel.kind === 'animal' || sel.kind === 'plant') {
      var list = sel.kind === 'animal' ? st.animals : st.plants;
      var e = (list || []).filter(function (x) { return x.id === sel.id; })[0];
      if (!e) {
        return { name: sel.name || 'one of the grove', state: 'gone',
                 rows: '' };
      }
      var what = sel.kind === 'animal'
        ? 'age ' + Number(e.ag) + 'wk' + (e.h ? ' · hungry' : '')
        : esc(e.st) + (e.el ? ' · an elder' : '') +
          (e.b ? ' · in fruit' : '');
      return {
        name: (e.n || 'a wild ' + e.sp) + ' · ' + e.sp,
        state: what + ' · at ' + Number(e.x) + ',' + Number(e.y),
        rows: '<li class="ev"><span class="wk">…</span>consulting the ' +
          'ledger…</li>',
      };
    }
    if (sel.kind === 'cell') {
      var size = Number(st.size) || 0;
      var x = Number(sel.x), y = Number(sel.y);
      if (!(x >= 0 && y >= 0 && x < size && y < size)) return null;
      var c = (st.cells || [])[y * size + x];
      if (!c) return null;
      var TERRAIN = { s: 'soil', w: 'water', r: 'rock' };
      var glow = Number((st.glow || [])[y * size + x]) || 0;
      return {
        name: TERRAIN[c[0]] || 'the ground',
        state: 'at ' + x + ',' + y,
        rows: '<li><span>grass</span><span>' + Number(c[1]).toFixed(2) +
          '</span></li>' +
          '<li><span>moisture</span><span>' + Number(c[2]).toFixed(2) +
          '</span></li>' +
          (c[3] ? '<li><span>mushrooms</span><span>yes</span></li>' : '') +
          (c[4] ? '<li><span>a carcass</span><span>yes</span></li>' : '') +
          '<li><span>glow</span><span>' + (glow / 9).toFixed(2) +
          '</span></li>',
      };
    }
    return null;
  }

  function card(st, sel) {
    var c = cardFor(st, sel);
    var el = $('card');
    if (!c) { el.classList.remove('on'); return false; }
    $('cardName').textContent = c.name;
    $('cardState').innerHTML = c.state;
    $('cardRows').innerHTML = c.rows;
    el.classList.add('on');
    return true;
  }

  /* The ledger's answer for the open card: `/api/bio`. The events are the
   * chronicle's own sentences about this soul — model text among them. */
  function bio(b, fallbackName) {
    if (!b) return;
    var state = b.gone ? 'remembered in the chronicle'
      : (b.alive ? 'alive in the grove' : '…');
    $('cardName').textContent = (b.name || fallbackName ||
      'a wild ' + (b.sp || 'thing')) + (b.sp ? ' · ' + b.sp : '');
    $('cardState').textContent = state;
    var rows = b.events || [];
    $('cardRows').innerHTML = rows.length ? rows.map(function (ev) {
      return '<li class="ev"><span class="wk">wk' + Number(ev.tick) +
        '</span>' + esc(ev.text) + '</li>';
    }).join('') : '<li class="ev"><span class="wk">—</span>no marked ' +
      'events yet; its story is still quiet.</li>';
  }

  function update(st) {
    head(st);
    render(st);
  }

  var api = {
    update: update,
    tab: tab,
    card: card,
    bio: bio,
    setTuning: setTuning,
    tune: tune,
    esc: esc,
    view: function () { return view; },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.GroveHUD = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
