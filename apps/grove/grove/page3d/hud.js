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
 * number goes through `Number` or `fmt` (shared `patch.js`: grouped
 * digits, '—' for anything that is not a number). Every write goes through
 * `Patch.write`, which skips a write that changes nothing and keeps the
 * reader's place in a list. (The pixi page this replaces wrote the
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
  var Patch = root.Patch;
  var fmt = Patch.fmt;
  var write = Patch.write;

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

  /* how long ago, in words: this week, last week, 3 weeks ago */
  function ago(tick, now) {
    var d = Number(now) - Number(tick);
    if (!isFinite(d)) return '—';
    return d <= 0 ? 'this week' : d === 1 ? 'last week'
      : fmt(d) + ' weeks ago';
  }

  /* ----------------------------------------------------------- the head */

  /* The server's status line, said for a reader: "tier local — pure
   * deterministic sim" is "AI off · pure deterministic sim", and "tier
   * cloud · m · tokens today 1,234" is "AI · m · tokens today 1,234". The
   * whole line stays the tooltip. (The estate's HUD says it the same way.) */
  function voiceLine(s) {
    s = String(s || '');
    var off = /^tier \w+ — (.*)$/.exec(s);
    if (off) return 'AI off · ' + off[1].replace(/\s*\(.*$/, '');
    return s.replace(/^tier \w+ · /, 'AI · ');
  }

  function head(st) {
    $('when').textContent = 'week ' + fmt(st.tick) + ' · ' +
      (st.season || '');
    $('weather').textContent = (st.weather_emo || '') + ' ' +
      (st.weather || '');
    /* most first, and spaced, so a screen reader hears "🐇 rabbit 24" */
    var chips = (st.pop_chips || []).slice().sort(function (a, b) {
      return (b.n || 0) - (a.n || 0);
    });
    write($('pops'), chips.map(function (c) {
      return '<span class="popline"><span class="picon">' + esc(c.emo) +
        '</span> <span class="pname">' + esc(c.name) +
        '</span> <span class="pnum">' + fmt(c.n) + '</span></span>';
    }).join(''));

    var soul = $('soul');
    soul.textContent = st.soul ? '☾ ' + st.soul : '';
    soul.className = 'soul' + (st.soul === 'listening…' ? ' pulse' : '');

    /* one short line; the stumble, its job and model and what the model
     * sent back are the line's tooltip */
    var llm = st.llm || {};
    var f = llm.fail;
    var line = String(llm.status || '');
    /* a reason on a working AI is its last stumble; on one that is off
     * it is why it is off, already in the line */
    $('status').textContent = (st.paused ? 'paused · ' : '') +
      voiceLine(line) + ((llm.ok && llm.reason) || f ? ' · ⚠ hiccup' : '');
    $('status').title = line +
      (llm.reason ? '\nlast stumble: ' + llm.reason : '') +
      (f ? '\nthe ' + f.job + ' job, on ' + f.model +
           ', could not be read — ' + f.why +
           (f.raw ? '\n\n' + f.raw : '') : '');
  }

  /* ----------------------------------------------------- the chronicle */

  /* The mark says whose words a line is; it is chosen from a fixed table,
   * never copied from the frame. */
  function markOf(source) {
    if (source === 'llm' || source === 'soul') {
      return ['mark-llm', '☾', 'written by the grove\'s AI'];
    }
    if (source === 'voice') return ['mark-voice', '☂', 'the grove\'s voice'];
    return ['mark-template', '·', 'from the rules'];
  }

  /* the time first, so it floats right on the row's first line */
  function chronicle(st) {
    var rows = st.chronicle || [];
    return rows.length ? rows.map(function (c) {
      var m = markOf(c.source);
      return '<li><span class="when">' + esc(ago(c.tick, st.tick)) +
        '</span><span class="' + m[0] + '" title="' + m[2] + '">' + m[1] +
        '</span> ' + esc(c.text) + '</li>';
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
      /* the latest count last, so the counts make one column */
      return '<li class="sparkline"><span class="name">' + esc(sr.emo) +
        ' ' + esc(sr.name) + '</span><span class="spark">' + spark(v) +
        '</span><b>' + fmt(v.length ? v[v.length - 1] : 0) + '</b></li>';
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
        '<div class="when">week ' + fmt(p.week) + ' — ' + esc(p.why) +
        '</div>' +
        (auto ? '' :
          '<div><button class="mini" data-a="accept" data-id="' +
          Number(p.id) + '">✓ accept</button> ' +
          '<button class="mini" data-a="dismiss" data-id="' +
          Number(p.id) + '">leave it</button></div>') +
        '</li>';
    });
    var last = s.last;
    var lastHtml = last
      ? '<li class="when">the steward read the ledger in week ' +
        fmt(last.week) + ' — ' +
        (last.amendments
          ? fmt(last.amendments) + ' amendment' +
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
        ' · week ' + fmt(h.week) + '</span></li>';
    });
    return lastHtml + headHtml +
      (rows.join('') ||
       '<li class="when">the steward offers nothing at the moment.</li>') +
      (hist.length ? '<li class="sub">the world\'s amendments</li>' +
                     hist.join('') : '');
  }

  function setTuning(s) {
    tuning = s;
    if (view === 'tune') write($('chron'), tune(tuning));
  }

  /* ------------------------------------------------------------ the tabs */

  function render(st) {
    var el = $('chron');
    el.className = 'chron' + (view === 'tune' ? ' tune' : '');
    var html = view === 'census' ? census(st)
      : view === 'tune' ? tune(tuning) : chronicle(st);
    /* the chronicle's newest line is on top; a tab switch starts at the top */
    write(el, html, { newestFirst: view === 'chron',
                      reset: el._view !== view });
    el._view = view;
  }

  function tab(name, st) {
    view = TABS.some(function (t) { return t[0] === name; }) ? name : 'chron';
    TABS.forEach(function (t) {
      var b = $(t[1]);
      b.classList.toggle('on', t[0] === view);
      if (b.setAttribute) b.setAttribute('aria-selected', String(t[0] === view));
    });
    if (st) render(st);
  }

  /* ------------------------------------------------------------ the card */

  /* The card speaks in words, not decimals (Iris's panels review, §3.2):
   * a bar and a word for what is measured, plain phrases for the rest, and
   * no coordinates. */

  function bar(v) {
    var w = Math.max(0, Math.min(1, Number(v) || 0));
    return '<span class="bar"><i style="width:' + Math.round(w * 100) +
      '%"></i></span>';
  }
  function row(name, value) {
    return '<li><span>' + name + '</span><span>' + value + '</span></li>';
  }
  /* a name, a bar and a word, in columns that line up row to row */
  function barRow(name, v, word) {
    return '<li class="need"><span>' + name + '</span>' + bar(v) +
      '<span>' + word + '</span></li>';
  }
  function article(word) {
    return /^[aeiou]/i.test(String(word)) ? 'an ' : 'a ';
  }
  /* the frame's own emoji for a species (the population chips), for the
   * card's name, which is written as text */
  function emojiOf(st, sp) {
    var c = (st.pop_chips || []).filter(function (x) {
      return x.name === sp;
    })[0];
    return c && c.emo ? c.emo + ' ' : '';
  }

  /* The card's ledger rows: the chronicle's own sentences about this soul
   * (`/api/bio`, model text among them), newest first. `led` is the
   * viewer's record of the ask: { id, state: 'wait' | 'ok' | 'fail', b }.
   * A frame poll redraws the card every 0.7 s, so these rows come from that
   * record each time, never from a one-off write the next poll would
   * wipe. */
  function ledgerRows(led) {
    if (!led || led.state === 'wait') {
      return '<li class="ev"><span class="wk">…</span>looking up its ' +
        'story…</li>';
    }
    if (led.state !== 'ok' || !led.b) {
      return '<li class="ev"><span class="wk">—</span>the ledger did not ' +
        'answer; what is above is from the live grove.</li>';
    }
    var rows = (led.b.events || []).slice().reverse();
    return rows.length ? rows.map(function (ev) {
      return '<li class="ev"><span class="wk">week ' + fmt(ev.tick) +
        '</span>' + esc(ev.text) + '</li>';
    }).join('') : '<li class="ev"><span class="wk">—</span>no marked ' +
      'events yet; its story is still quiet.</li>';
  }

  /* A living creature's needs, from the ledger's answer. Energy is kept
   * on 0–10 by the sim; hunger is not capped (it climbs by the species'
   * drain each week and only hurts past 9 — the seed-42 run peaks near
   * 27), so it is a word, never "/ 10". The words follow the sim: past 5
   * the frame marks it hungry, past 9 it loses health. */
  function hungerWord(h) {
    return h > 9 ? 'starving' : h > 5 ? 'hungry' : h >= 0 ? 'fed' : '—';
  }
  function energyWord(e) {
    return e > 6 ? 'strong' : e > 3 ? 'tired' : e >= 0 ? 'weak' : '—';
  }
  function needRows(b) {
    if (!b || !b.alive || b.hunger === undefined) return '';
    /* the words compare, and the bar divides: both read the numbers */
    return row('hunger', hungerWord(b.hunger)) +
      barRow('energy', b.energy / 10, energyWord(b.energy));
  }

  /* a plant's stage, as a heading and as a state */
  var STAGE_HEAD = { sapling: 'a young ', mature: 'a grown ', old: 'an old ',
                     log: 'a fallen ' };
  var STAGE_STATE = { sapling: 'a sapling', mature: 'grown', old: 'old',
                      log: 'fallen, now a log' };

  /* the ground, in words */
  function grassWord(g) {
    return g >= 0.66 ? 'lush' : g >= 0.33 ? 'grassy' : g > 0.05 ? 'thin'
      : g >= 0 ? 'bare' : '—';
  }
  function wetWord(m) {
    return m >= 0.66 ? 'wet' : m >= 0.33 ? 'damp' : m >= 0 ? 'dry' : '—';
  }
  function glowWord(g) {
    return g > 0.5 ? 'glows at night' : g > 0 ? 'glows faintly at night'
      : 'no glow';
  }
  function heightWord(e, terrain) {
    if (terrain === 'w') return '';
    return e > 0.8 ? 'on the high ground' : e < 0.15 ? 'low, by the water'
      : 'on the slope';
  }
  var WATER = { p: 'a pond', c: 'the creek', f: 'a ford across the creek' };
  var PLURAL = { deer: 'deer', birch: 'birches', fox: 'foxes' };

  /* what stands or walks on a cell: "3 pines · a rabbit" */
  function hereWords(st, x, y) {
    var count = {};
    var order = [];
    (st.plants || []).concat(st.animals || []).forEach(function (e) {
      if (Number(e.x) !== x || Number(e.y) !== y) return;
      var sp = String(e.sp);
      if (!count[sp]) { count[sp] = 0; order.push(sp); }
      count[sp] += 1;
    });
    return order.map(function (sp) {
      var n = count[sp];
      return n === 1 ? article(sp) + esc(sp)
        : fmt(n) + ' ' + esc(PLURAL[sp] || sp + 's');
    }).join(' · ');
  }

  /* What the frame itself says about a creature or a plant, written the
   * moment it is clicked; the ledger's rows follow when it answers. The
   * name is plain text: the card writes it with textContent. */
  function cardFor(st, sel, ledger) {
    if (!st || !sel) return null;
    if (sel.kind === 'animal' || sel.kind === 'plant') {
      var led = ledger && Number(ledger.id) === Number(sel.id) ? ledger
        : null;
      var b = led && led.state === 'ok' ? led.b : null;
      var list = sel.kind === 'animal' ? st.animals : st.plants;
      var e = (list || []).filter(function (x) {
        return x.id === Number(sel.id);
      })[0];
      if (!e) {
        return {
          name: b ? (b.name ? b.name + (b.sp ? ' · ' + b.sp : '')
                    : article(b.sp || 'thing') + (b.sp || 'thing') +
                      ', gone')
            : (sel.name || 'one of the grove'),
          state: b ? 'remembered in the chronicle' : 'gone',
          rows: ledgerRows(led),
        };
      }
      if (sel.kind === 'animal') {
        return {
          name: emojiOf(st, e.sp) +
            (e.n ? e.n + ' · ' + e.sp : 'a wild ' + e.sp),
          state: fmt(e.ag) + ' weeks old' + (e.h ? ' · hungry' : ''),
          rows: needRows(b) + ledgerRows(led),
        };
      }
      var stage = String(e.st);
      var head = Object.prototype.hasOwnProperty.call(STAGE_HEAD, stage)
        ? STAGE_HEAD[stage] : article(e.sp);
      var bits = [Object.prototype.hasOwnProperty.call(STAGE_STATE, stage)
        ? STAGE_STATE[stage] : esc(e.st)];
      if (e.el) bits.push('one of the grove\'s oldest');
      if (e.b) bits.push('in fruit');
      return {
        name: e.n ? e.n + ' · ' + e.sp : head + e.sp,
        state: bits.join(' · '),
        rows: ledgerRows(led),
      };
    }
    if (sel.kind === 'cell') {
      var size = Number(st.size) || 0;
      var x = Number(sel.x), y = Number(sel.y);
      if (!(x >= 0 && y >= 0 && x < size && y < size)) return null;
      var c = (st.cells || [])[y * size + x];
      if (!c) return null;
      var TERRAIN = { s: 'soil', w: 'water', r: 'rock' };
      /* the words compare and the bars read Number: no NaN reaches a
       * reader whatever the frame holds */
      var glow = ((st.glow || [])[y * size + x] || 0) / 9;
      var grass = c[1], wet = c[2];
      var name = c[0] === 'w' && WATER[c[6]] ? WATER[c[6]]
        : TERRAIN[c[0]] || 'the ground';
      var here = hereWords(st, x, y);
      return {
        name: name,
        state: [heightWord(c[5], c[0]), here ||
                (c[0] === 'w' ? 'open water' : 'nothing grows or walks here')]
          .filter(Boolean).join(' · '),
        rows: (c[0] === 'w' ? '' :
               barRow('grass', grass, grassWord(grass)) +
               barRow('moisture', wet, wetWord(wet))) +
          (c[3] ? row('🍄 mushrooms', 'here') : '') +
          (c[4] ? row('remains', 'here') : '') +
          barRow('glow', glow, glowWord(glow)),
      };
    }
    return null;
  }

  function card(st, sel, ledger) {
    var c = cardFor(st, sel, ledger);
    var el = $('card');
    if (!c) { el.classList.remove('on'); return false; }
    var name = $('cardName');
    if (name.textContent !== c.name) name.textContent = c.name;
    write($('cardState'), c.state);
    write($('cardRows'), c.rows);
    el.classList.add('on');
    return true;
  }

  function update(st) {
    head(st);
    render(st);
  }

  var api = {
    update: update,
    tab: tab,
    card: card,
    setTuning: setTuning,
    tune: tune,
    esc: esc,
    voiceLine: voiceLine,
    view: function () { return view; },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.GroveHUD = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
