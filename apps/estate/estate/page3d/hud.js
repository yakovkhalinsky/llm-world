/* hud — the words around the scene.
 *
 * The scene shows the estate; these panels say what it means. Both read the
 * same frame the server sent, so a number in a panel and a shape in the
 * scene can never disagree. The glyphs come with the ground payload, from
 * the pack, because a page that spells its own emoji has a second copy of a
 * fact that lives in the world's law (grove b21).
 *
 * This file is pure DOM: no THREE, no WebGL, no fetch. It is a classic
 * script, loaded before the module like `walk.js` and `clock.js`, so
 * `tools/hud_check.js` can run the same code against a stub DOM in Node.
 *
 * Every string that comes from the world is escaped once, where it is
 * written. `textContent` is used for a single name; `innerHTML` is only
 * used for rows whose data has already been through `esc`, and every number
 * goes through `Number`.
 */
(function (root) {
  'use strict';

  var ground = null;
  var view = 'chron';
  var TABS = [
    ['chron', 'tabChron'],
    ['census', 'tabCensus'],
    ['watch', 'tabWatch'],
  ];

  function $(id) { return document.getElementById(id); }

  /* the page's one escaper: viewer.js borrows it as `EstateHUD.esc`.
   * Both quotes are escaped, so a string is safe in an attribute whichever
   * quote the attribute uses. */
  var esc = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
                 "'": '&#39;' }[c];
      });
  };

  var WEATHER_WORD = { clear: 'clear', rain: 'rain', storm: 'storm',
                       heat: 'heat', frost: 'frost' };

  /* the glyph tables arrive whole; this is the lookup, not a second copy */
  function glyphOf(group, key) {
    var g = (ground && ground.glyphs) || {};
    return ((g[group] || {})[key]) || '';
  }

  function setGround(g) { ground = g; }

  /* A count as people read one: 1,234 rather than 1234. Every whole
   * number the panels write goes through here, so the thousands are
   * separated the same way everywhere (and a number is always a number). */
  function num(v) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) return '0';
    var s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + s;
  }

  /* ------------------------------------------------- the day, phase by phase */

  /* The live frame is always the end of a day's night: the estate lives a
   * whole day per tick, so a school morning has happened and gone by the
   * time the page hears of it. The server keeps where everybody was at the
   * end of each of today's phases (`phases`, engine/daytime.py `record`),
   * and this turns one of them into a frame the scene draws like any other:
   * each person where that phase left them, walking from where the phase
   * before it did. `index` is into `st.phases.order`; anything else is the
   * live frame, unchanged. */
  var MODE = { i: 'in', a: 'at', s: 'school', w: 'away' };

  function phaseView(st, index) {
    var ph = st && st.phases;
    if (!ph || !ph.order || index < 0 || index >= ph.order.length) return st;
    var name = ph.order[index];
    var at = (ph.at || {})[name];
    if (!at) return st;
    var before = index > 0 ? (ph.at || {})[ph.order[index - 1]] : null;
    var people = (st.people || []).map(function (p) {
      var r = at[String(p.id)];
      if (!r) return p;
      var q = {};
      for (var k in p) q[k] = p[k];
      var mode = MODE[r[2]] || 'at';
      var b = before ? before[String(p.id)] : null;
      var pmode = b ? (MODE[b[2]] || 'at') : (p.pin ? 'in' : 'at');
      q.x = r[0]; q.y = r[1]; q.mode = mode;
      q.unit = r[3]; q.fixture = r[4]; q['with'] = r[5];
      if (b) { q.px = b[0]; q.py = b[1]; q.punit = b[3]; }
      q.pin = pmode === 'in';
      q.pmode = pmode;
      /* off the estate at work: hidden, except in the phase they left,
       * when they are at the stop waiting for the bus */
      q['in'] = mode === 'in' || (mode === 'away' && pmode === 'away');
      return q;
    });
    var out = {};
    for (var k2 in st) out[k2] = st[k2];
    out.people = people;
    out.viewPhase = name;
    out.viewKey = Number(st.day) + ':' + name;
    return out;
  }

  /* The scrubber: the live frame, then today's five phases. */
  function scrubber(st, index) {
    var order = (st && st.phases && st.phases.order) || [];
    var b = ['<button data-i="-1" class="' + (index < 0 ? 'on' : '') +
             '">live</button>'];
    order.forEach(function (name, i) {
      b.push('<button data-i="' + i + '" class="' +
             (i === index ? 'on' : '') + '">' + esc(name) + '</button>');
    });
    return b.join('');
  }

  /* who is where right now in this frame, for the school's and the bus
   * stop's cards and the header */
  function daytime(st) {
    var d = (st && st.daytime) || {};
    var now = { school: 0, away: 0 };
    (st && st.people || []).forEach(function (p) {
      if (p.mode === 'school') now.school++;
      else if (p.mode === 'away') now.away++;
    });
    return { enrolled: Number(d.enrolled) || 0,
             inToday: Number(d.in_today) || 0,
             workers: Number(d.workers) || 0,
             school: now.school, away: now.away };
  }

  /* ----------------------------------------------------------- the head */

  function head(st) {
    $('when').textContent =
      'day ' + num(st.day) + ' · ' + st.season_name + ' · ' + st.weekday +
      (st.viewPhase ? ' · ' + st.viewPhase : '');
    $('weather').textContent =
      glyphOf('weather', st.weather) + ' ' +
      (WEATHER_WORD[st.weather] || st.weather);

    var bits = [];
    bits.push('<b>' + num(st.residents) + '</b> people');
    /* the shop and the school are buildings but not blocks; the header
     * counts homes */
    bits.push('<b>' + num((st.buildings || [])
      .filter(function (b) { return b.kind === 'block'; }).length) +
      '</b> blocks');
    bits.push('<b>' + num(st.units) + '</b> flats');
    if (st.waiting) bits.push('<b>' + num(st.waiting) + '</b> waiting');
    var dt = daytime(st);
    if (dt.school) bits.push('<b>' + num(dt.school) + '</b> at school');
    if (dt.away) bits.push('<b>' + num(dt.away) + '</b> at work');
    $('pops').innerHTML = bits.join(' · ');

    /* the watcher, in its own words, and the voice that carried them */
    var w = st.watcher || {};
    $('watch').innerHTML = w.fate
      ? '<span class="d">☾</span> ' + esc(w.why || w.fate)
      : '<span class="dim">☾ no watcher has come yet</span>';
    $('voice').textContent = st.llm || '';
  }

  /* --------------------------------------------------------- the census */

  function census(st) {
    var counts = st.census || {};
    var rows = Object.keys(counts)
      .sort(function (a, b) { return counts[b] - counts[a]; })
      .map(function (k) {
        return '<li><span>' + esc(glyphOf('households', k)) + ' ' +
          esc(k) + '</span><span>' + num(counts[k]) + '</span></li>';
      });
    var kinds = (st.people || []).reduce(function (m, p) {
      m[p.role] = (m[p.role] || 0) + 1;
      return m;
    }, {});
    var byrole = Object.keys(kinds).sort().map(function (k) {
      return '<li><span>' + esc(glyphOf('roles', k)) + ' ' + esc(k) +
        '</span><span>' + num(kinds[k]) + '</span></li>';
    });
    var dt = daytime(st);
    byrole.push('<li><span>' + esc(glyphOf('fixtures', 'school')) +
      ' pupils</span><span>' + num(dt.enrolled) + '</span></li>');
    byrole.push('<li><span>' + esc(glyphOf('fixtures', 'bus_stop')) +
      ' work off the estate</span><span>' + num(dt.workers) +
      '</span></li>');
    return '<ul class="timeline">' + rows.join('') + '</ul>' +
      '<div class="status">by age</div><ul class="timeline">' +
      byrole.join('') + '</ul>';
  }

  /* ----------------------------------------------------------- the feed */

  /* One row per day, newest first. The sentences come from the server
   * (`render.say`) — the page does not spell its own, because two wordings
   * for one event would have the estate telling a person and the watcher
   * different stories about the same day. And the rows are *days*, not
   * events: the estate is quiet most days, and a panel that only ever
   * showed events sat unchanged for half an hour and read as broken. */
  function feed(st) {
    var days = (st.days || []).slice().reverse();
    $('chron').innerHTML = days.length ? days.map(function (d) {
      var says = Array.isArray(d.says) ? d.says : [];
      var news = says.length ? says.join(' · ') : '';
      return '<li' + (says.length ? '' : ' class="quiet"') + '>' +
        '<span class="d">d' + num(d.day) + '</span>' +
        '<span class="shape">' + esc(d.line || '') + '</span>' +
        (news ? '<span class="news">' + esc(news) + '</span>' : '') +
        '</li>';
    }).join('') : '<li>nothing has happened yet. it is early.</li>';
  }

  /* ------------------------------------------------------- the watcher */

  function chronicle(st) {
    var rows = (st.chronicle || []).slice().reverse();
    $('chron').innerHTML = rows.length ? rows.map(function (e) {
      return '<li><span class="d">d' + num(e.day) + '</span> ' +
        esc(e.text) + '</li>';
    }).join('') :
      '<li>no watcher has come yet, and the chronicle is empty. ' +
      'the estate keeps its own lines either way.</li>';
  }

  function render(st) {
    if (view === 'census') $('chron').innerHTML = census(st);
    else if (view === 'watch') chronicle(st);
    else feed(st);
  }

  function tab(name, st) {
    view = TABS.some(function (t) { return t[0] === name; }) ? name : 'chron';
    TABS.forEach(function (t) {
      $(t[1]).classList.toggle('on', t[0] === view);
    });
    if (st) render(st);
  }

  /* ----------------------------------------------------------- the card */

  function bar(v, max) {
    var pc = Math.max(0, Math.min(100, (Number(v) / Number(max)) * 100));
    return '<span class="bar"><i style="width:' + pc.toFixed(0) + '%"></i>' +
      '</span> ' + Number(v).toFixed(2);
  }

  function row(label, n) {
    return '<li><span>' + esc(label) + '</span><span>' + num(n) +
      '</span></li>';
  }

  /* what a fixture is called on its card, where its kind is not a word */
  var FIXTURE_NAME = { school: 'school gate', bus_stop: 'bus stop' };

  function needRows(p) {
    var needs = p.needs || {};
    return Object.keys(needs).sort().map(function (n) {
      return '<li><span>' + esc(glyphOf('needs', n)) + ' ' + esc(n) +
        '</span><span>' + bar(needs[n], 4) + '</span></li>';
    }).join('');
  }

  /* The household, one row each: name, role and age, and who a young
   * child is out walking with (engine/families.py keeps every child under
   * ten beside a guardian). Members are looked up in the same frame, so
   * the card names only people the frame carries. */
  function familyRows(st, p) {
    var byId = {};
    (st.people || []).forEach(function (x) { byId[x.id] = x; });
    var rows = (p.family || []).map(function (id) {
      var m = byId[id];
      if (!m) return '';
      return '<li><span>' + esc(glyphOf('roles', m.role)) + ' ' +
        esc(m.name || 'a resident') + '</span><span>' + esc(m.role) +
        ' · ' + num(m.age) + '</span></li>';
    }).join('');
    var w = p['with'] !== null && p['with'] !== undefined
      ? byId[p['with']] : null;
    if (w) {
      rows = '<li><span>out with</span><span>' +
        esc(w.name || 'a resident') + '</span></li>' + rows;
    }
    return rows ? '<li><span>— family —</span><span></span></li>' + rows
                : '';
  }

  function cardFor(st, sel) {
    if (!st || !sel) return null;
    if (sel.kind === 'resident') {
      var p = (st.people || []).filter(function (x) {
        return x.id === sel.id;
      })[0];
      if (!p) return { name: 'a person', state: 'gone', rows: '' };
      var where = p.mode === 'school' ? 'at school, inside the fence'
        : p.mode === 'away' ? 'away at work, off the estate'
        : p.in
        ? 'inside, flat ' + (p.unit === null || p.unit === undefined
                             ? '' : Number(p.unit))
        : 'out at ' + Number(p.x) + ',' + Number(p.y);
      var day = p.pupil ? ' · at school on weekdays'
        : p.job ? ' · works off the estate on weekdays' : '';
      var family = familyRows(st, p);
      var habit = Object.keys(p.habit || {}).map(function (k) {
        return '<li><span>' + esc(k) + '</span><span>' +
          esc(p.habit[k]) + '</span></li>';
      }).join('');
      return {
        name: p.name || 'a resident',
        state: esc(glyphOf('roles', p.role)) + ' ' + esc(p.role) + ' · age ' +
          num(p.age) + ' · ' + esc(p.kind || '') + ' household' +
          esc(day) + '<br>' +
          esc(where) +
          (p.stress >= 1 ? ' · frayed ' + Number(p.stress) : ''),
        rows: needRows(p) + family + (habit ?
          '<li><span>— today —</span><span></span></li>' + habit : ''),
      };
    }
    if (sel.kind === 'fixture') {
      var f = (st.fixtures || []).filter(function (x) {
        return x.id === sel.id;
      })[0];
      if (!f) return { name: 'a place', state: 'gone', rows: '' };
      /* the name is plain text: the card writes it with textContent */
      var spec = glyphOf('fixtures', f.kind) + ' ' +
        (FIXTURE_NAME[f.kind] || f.kind);
      var extra = '';
      if (f.kind === 'school' || f.kind === 'bus_stop') {
        var dn = daytime(st);
        extra = f.kind === 'school'
          ? row('pupils on the roll', dn.enrolled) +
            row('in today', dn.inToday) + row('in school now', dn.school)
          : row('work off the estate', dn.workers) +
            row('at work now', dn.away);
      }
      return {
        name: spec,
        state: 'at ' + Number(f.x) + ',' + Number(f.y) + ' · ' +
          (f.kind === 'school' ? 'gone through ' :
           f.kind === 'bus_stop' ? 'boarded ' : 'used ') +
          num(f.uses) + ' times' +
          (f.stock !== null && f.stock !== undefined
            ? ' · stock ' + Number(f.stock) : ''),
        rows: extra + '<li><span>condition</span><span>' + bar(f.c, 1) +
          '</span></li>',
      };
    }
    if (sel.kind === 'building') {
      var b = (ground && ground.buildings || []).filter(function (x) {
        return x.id === sel.id;
      })[0];
      var d = (st.buildings || []).filter(function (x) {
        return x.id === sel.id;
      })[0] || {};
      if (!b) return null;
      /* each kind of building says what it is for: a school's card counts
       * pupils, not the flats it does not have */
      var rows;
      if (b.kind === 'school') {
        var ds = daytime(st);
        rows = row('pupils on the roll', ds.enrolled) +
          row('in today', ds.inToday) + row('in school now', ds.school);
      } else if (b.kind === 'shop') {
        rows = '';
      } else {
        rows = row('flats', d.units || 0) + row('lived in', d.lived || 0);
      }
      var where = b.kind === 'school' && b.gate
        ? ' · gate at ' + Number(b.gate[0]) + ',' + Number(b.gate[1])
        : ' · door at ' + Number(b.door[0]) + ',' + Number(b.door[1]);
      return {
        name: b.name,
        state: esc(b.kind) + ' · ' + num(b.floors) + ' floors' + where +
          '<br>' +
          (d.power ? 'power on' : 'no power') + ' · ' +
          (d.water ? 'water on' : 'no water'),
        rows: rows,
      };
    }
    if (sel.kind === 'cell') {
      if (!ground || !ground.rows || !ground.rows[sel.y] ||
          ground.rows[sel.y][sel.x] === undefined) return null;
      var site = ground.codes[ground.rows[sel.y][sel.x]];
      var i = sel.y * ground.width + sel.x;
      var shade = Number((st.shade || [])[i]);
      var light = Number((st.light || [])[i]);
      if (!isFinite(shade)) shade = 0;
      if (!isFinite(light)) light = 0;
      return {
        name: glyphOf('sites', site) + ' ' + site,
        state: 'at ' + Number(sel.x) + ',' + Number(sel.y),
        rows: '<li><span>shade</span><span>' +
          (shade / 9).toFixed(2) + '</span></li>' +
          '<li><span>lamp</span><span>' +
          (light / 9).toFixed(2) + '</span></li>',
      };
    }
    return null;
  }

  /* Write the card for `sel`, or close it. Returns whether it is open. */
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

  function update(st) {
    head(st);
    render(st);
  }

  var api = {
    setGround: setGround,
    update: update,
    tab: tab,
    card: card,
    glyphOf: glyphOf,
    esc: esc,
    num: num,
    phaseView: phaseView,
    scrubber: scrubber,
    view: function () { return view; },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.EstateHUD = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
