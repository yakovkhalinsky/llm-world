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
 * used for rows whose data has already been through `esc`, and every count
 * goes through `fmt` (en-AU thousands; a dash for what is not a number).
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

  /* The panels' shared habits (apps/shared/page3d/patch.js, loaded first):
   * `fmt` is a count as people read one here — 1,234, en-AU, a dash for
   * anything that is not a number — and every count the panels write goes
   * through it; `write` writes a list only when it changed, keeping the
   * reader's place. */
  var Patch = root.Patch;
  var fmt = Patch.fmt;
  var write = Patch.write;

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

  /* The live frame is the end of a night, when nobody is at school or at
   * work, so its own counts would never show either (#14 review). Live,
   * the header counts the phase the clock is at instead — the one the
   * light shows — and a phase picked on the scrubber counts that phase. */
  var clockPhase = null;

  function setClock(name) {
    var was = clockPhase;
    clockPhase = name || null;
    return was !== clockPhase;
  }

  function countFrame(st) {
    if (!st || st.viewPhase || !clockPhase) return st;
    var order = (st.phases && st.phases.order) || [];
    var i = order.indexOf(clockPhase);
    return i < 0 ? st : phaseView(st, i);
  }

  /* The model's status, short enough for one line: the reason or the
   * model and the day's tokens. The whole line is the element's title. */
  function voiceLine(s) {
    s = String(s || '');
    var off = /^tier \w+ — (.*)$/.exec(s);
    if (off) return 'AI off · ' + off[1].replace(/\s*\(.*$/, '');
    return s.replace(/^tier \w+ · /, 'AI · ');
  }

  function head(st) {
    $('when').textContent =
      'day ' + fmt(st.day) + ' · ' + st.season_name + ' · ' + st.weekday;
    /* a scrubbed phase is the phase line's to say, not said twice */
    $('weather').textContent =
      glyphOf('weather', st.weather) + ' ' +
      (WEATHER_WORD[st.weather] || st.weather);

    var bits = [];
    bits.push('<b>' + fmt(st.residents) + '</b> people');
    /* the shop and the school are buildings but not blocks; the header
     * counts homes */
    bits.push('<b>' + fmt((st.buildings || [])
      .filter(function (b) { return b.kind === 'block'; }).length) +
      '</b> blocks');
    bits.push('<b>' + fmt(st.units) + '</b> flats');
    if (st.waiting) bits.push('<b>' + fmt(st.waiting) + '</b> waiting');
    var dt = daytime(countFrame(st));
    if (dt.school) bits.push('<b>' + fmt(dt.school) + '</b> at school');
    if (dt.away) bits.push('<b>' + fmt(dt.away) + '</b> at work');
    /* each count its own chip, so the line wraps between counts */
    write($('pops'), bits.map(function (b) {
      return '<span class="popline">' + b + '</span>';
    }).join(''));

    /* the watcher, in its own words, and the voice that carried them */
    var w = st.watcher || {};
    write($('watch'), w.fate
      ? '<span class="d">☾</span> ' + esc(w.why || w.fate)
      : '<span class="dim">☾ the watcher hasn\'t written yet</span>');
    $('watch').title = w.fate ? String(w.why || w.fate) : '';
    var voice = $('voice');
    voice.textContent = voiceLine(st.llm);
    voice.title = st.llm || '';
  }

  /* --------------------------------------------------------- the census */

  /* a household kind as a word: the pack's keys are identifiers */
  function kindWord(k) { return String(k).replace(/_/g, ' '); }

  function census(st) {
    var counts = st.census || {};
    var rows = Object.keys(counts)
      .sort(function (a, b) { return counts[b] - counts[a]; })
      .map(function (k) {
        return '<li><span>' + esc(glyphOf('households', k)) + ' ' +
          esc(kindWord(k)) + '</span><span>' + fmt(counts[k]) +
          '</span></li>';
      });
    var kinds = (st.people || []).reduce(function (m, p) {
      m[p.role] = (m[p.role] || 0) + 1;
      return m;
    }, {});
    var byrole = Object.keys(kinds).sort().map(function (k) {
      return '<li><span>' + esc(glyphOf('roles', k)) + ' ' + esc(k) +
        '</span><span>' + fmt(kinds[k]) + '</span></li>';
    });
    var dt = daytime(st);
    byrole.push('<li><span>' + esc(glyphOf('fixtures', 'school')) +
      ' pupils</span><span>' + fmt(dt.enrolled) + '</span></li>');
    byrole.push('<li><span>' + esc(glyphOf('fixtures', 'bus_stop')) +
      ' work off the estate</span><span>' + fmt(dt.workers) +
      '</span></li>');
    var waiting = Number(st.waiting) > 0
      ? '<div class="status">' + fmt(st.waiting) +
        ' on the waiting list</div>' : '';
    return '<li class="sub"><div class="status">households</div>' +
      '<ul class="timeline">' + rows.join('') + '</ul></li>' +
      '<li class="sub"><div class="status">by role</div>' +
      '<ul class="timeline">' + byrole.join('') + '</ul>' + waiting +
      '</li>';
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
    return days.length ? days.map(function (d) {
      var says = Array.isArray(d.says) ? d.says : [];
      /* keyed by its day: today's row gains its news as the day goes */
      return '<li data-key="' + Patch.key(d.day) + '"' +
        (says.length ? '' : ' class="quiet"') + '>' +
        '<span class="d">day ' + fmt(d.day) + '</span>' +
        '<span class="shape">' + esc(d.line || '') + '</span>' +
        (says.length ? '<span class="news">' + says.map(function (s) {
          return esc(s);   // no bullet, as the grove's feed
        }).join('<br>') + '</span>' : '') +
        '</li>';
    }).join('') : '<li>nothing has happened yet — it\'s early</li>';
  }

  /* ------------------------------------------------------- the watcher */

  function chronicle(st) {
    var rows = (st.chronicle || []).slice().reverse();
    return rows.length ? rows.map(function (e) {
      return '<li data-key="' + Patch.key(e.day, e.text) + '">' +
        '<span class="d">day ' + fmt(e.day) + '</span>' +
        '<span class="shape">' + esc(e.text) + '</span></li>';
    }).join('') :
      '<li class="quiet"><span class="shape">the watcher hasn\'t written ' +
      'anything yet — the days tab keeps going either way</span></li>';
  }

  /* The list is written only when it changed, and the reader keeps their
   * place (shared `patch.js`): the feed and the chronicle are newest
   * first, so a reader at the top sees the new day arrive and one who has
   * scrolled down keeps the row they were reading; a tab change starts
   * the new list at the top. */
  function render(st) {
    var el = $('chron');
    var html = view === 'census' ? census(st)
      : view === 'watch' ? chronicle(st) : feed(st);
    write(el, html, { newestFirst: view !== 'census',
                      reset: el._view !== view });
    el._view = view;
  }

  function tab(name, st) {
    view = TABS.some(function (t) { return t[0] === name; }) ? name : 'chron';
    TABS.forEach(function (t) {
      $(t[1]).classList.toggle('on', t[0] === view);
      if ($(t[1]).setAttribute) {
        $(t[1]).setAttribute('aria-selected', t[0] === view ? 'true' : 'false');
      }
    });
    if (st) render(st);
  }

  /* ----------------------------------------------------------- the card */

  /* A level as a bar and a word. Needs run 0-4 and higher wants more
   * (engine/residents.py): a word for the reader, and the bar turns warm
   * when the need is pressing. */
  var NEED_HOT = 2.6;
  function needWord(v) {
    return v < 1.3 ? 'fine' : v < NEED_HOT ? 'wants' : 'needs it badly';
  }
  function bar(v, max, hot) {
    var pc = Math.max(0, Math.min(100, (Number(v) / Number(max)) * 100));
    if (!isFinite(pc)) pc = 0;
    return '<span class="bar' + (hot ? ' hot' : '') + '"><i style="width:' +
      pc.toFixed(0) + '%"></i></span>';
  }

  /* wear as a word: the fixtures run 1 (new) to 0 (broken) */
  function wear(c) {
    c = Number(c);
    if (!isFinite(c)) return '—';
    return c <= 0 ? 'broken' : c < 0.4 ? 'worn' : c <= 0.75 ? 'fine'
      : 'good';
  }

  function row(label, value) {
    return '<li><span>' + esc(label) + '</span><span>' + value +
      '</span></li>';
  }
  function line(text) {
    return '<li><span>' + text + '</span><span></span></li>';
  }
  function header(text) {
    return '<li class="hd"><span>' + esc(text) + '</span><span></span></li>';
  }
  function conditionRow(c) {
    return '<li class="need"><span>condition</span>' + bar(c, 1) +
      '<span>' + esc(wear(c)) + '</span></li>';
  }

  /* "a bench", "2 benches and a table" */
  var PLURAL = { bench: 'benches', bus_stop: 'bus stops' };
  function kindName(k) {
    return FIXTURE_NAME[k] || String(k).replace(/_/g, ' ');
  }
  function some(list) {
    var n = {};
    var order = [];
    list.forEach(function (f) {
      if (!n[f.kind]) { n[f.kind] = 0; order.push(f.kind); }
      n[f.kind]++;
    });
    var words = order.map(function (k) {
      return n[k] === 1 ? 'a ' + kindName(k)
        : fmt(n[k]) + ' ' + (PLURAL[k] || kindName(k) + 's');
    });
    return words.length <= 1 ? words.join('')
      : words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
  }

  /* what a fixture is called on its card, where its kind is not a word */
  var FIXTURE_NAME = { school: 'school gate', bus_stop: 'bus stop' };
  /* the word for one use of each kind of fixture */
  var USE_WORD = { bench: 'sits', table: 'games', playground: 'visits',
                   shop: 'visits', school: 'times through the gate',
                   bus_stop: 'boardings' };
  /* the places people sit, play and shop: the things a lamp lights and a
   * tree shades */
  var LIVING = { lamp: 1, tree: 1 };
  var SITE_WORD = { path: 'footpath', paved: 'paving', play: 'play area',
                    water: 'pond', building: 'building', yard: 'schoolyard' };
  function siteWord(s) { return SITE_WORD[s] || String(s || 'ground'); }
  var LIT_PHASES = { evening: 1, night: 1, dawn: 1 };

  function cellIndex(x, y) {
    return Number(y) * (ground ? Number(ground.width) : 0) + Number(x);
  }
  function siteOf(x, y) {
    if (!ground || !ground.rows || !ground.rows[y] ||
        ground.rows[y][x] === undefined) return '';
    return ground.codes[ground.rows[y][x]];
  }
  function field(st, name, x, y) {
    var v = Number((st[name] || [])[cellIndex(x, y)]);
    return isFinite(v) ? v : 0;
  }
  function near(st, x, y, reach, test) {
    return (st.fixtures || []).filter(function (f) {
      var d = Math.abs(f.x - x) + Math.abs(f.y - y);
      return test(f, Math.abs(f.x - x), Math.abs(f.y - y)) && d <= reach;
    });
  }
  function nearest(st, x, y, reach) {
    var best = null;
    var bd = Infinity;
    (st.fixtures || []).forEach(function (f) {
      if (LIVING[f.kind]) return;
      var d = Math.abs(f.x - x) + Math.abs(f.y - y);
      if (d < bd) { bd = d; best = f; }
    });
    return bd <= reach ? best : null;
  }

  /* how many are using a fixture now: out on the plan, at its cell, and
   * it was the last thing they used */
  function usingNow(st, f) {
    return (st.people || []).filter(function (p) {
      return !p['in'] && p.fixture === f.id && p.x === f.x && p.y === f.y;
    }).length;
  }

  function needRows(p) {
    var needs = p.needs || {};
    var rows = Object.keys(needs).sort(function (a, b) {
      return (Number(needs[b]) || 0) - (Number(needs[a]) || 0) ||
        (a < b ? -1 : a > b ? 1 : 0);
    }).map(function (n) {
      var v = Number(needs[n]);
      return '<li class="need"><span>' + esc(glyphOf('needs', n)) + ' ' +
        esc(n) + '</span>' + bar(v, 4, v >= NEED_HOT) +
        '<span class="w">' + (isFinite(v) ? needWord(v) : '—') +
        '</span></li>';
    }).join('');
    return rows ? header('needs') + rows : '';
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
        ', ' + ageWord(m.age) + '</span></li>';
    }).join('');
    var w = p['with'] !== null && p['with'] !== undefined
      ? byId[p['with']] : null;
    if (w) {
      rows = '<li><span>out with</span><span>' +
        esc(w.name || 'a resident') + '</span></li>' + rows;
    }
    return rows ? header('household') + rows : '';
  }

  /* a baby's age is not "0" */
  function ageWord(a) {
    return Number(a) >= 0 && Number(a) < 1 && a !== null && a !== ''
      ? 'under 1' : fmt(a);
  }

  /* how a household kind reads in a sentence about one of its people */
  function livesWith(p) {
    var k = p.kind;
    var WORDS = { family: 'in a family', couple: 'lives as a couple',
                  flat_share: 'in a flat share', elder: 'lives with an elder',
                  single: 'lives alone' };
    if (!WORDS[k]) return 'in a ' + kindWord(k || 'household') + ' household';
    /* a household whose others have left is one person on their own */
    if (k === 'single' || !(p.family || []).length) return 'lives alone';
    /* an elder in an elder household lives with family, not "an elder" */
    if (k === 'elder' && p.role === 'elder') return 'lives with family';
    return WORDS[k];
  }

  function flatWords(unit) {
    var u = ground && ground.units ? ground.units[String(unit)] : null;
    if (unit === null || unit === undefined) return 'at home';
    var b = u ? (ground.buildings || []).filter(function (x) {
      return x.id === u.b;
    })[0] : null;
    return 'at home · flat ' + fmt(unit) +
      (u ? ', floor ' + fmt(u.f) : '') + (b ? ', ' + b.name : '');
  }

  function residentCard(st, sel) {
    var p = (st.people || []).filter(function (x) {
      return x.id === sel.id;
    })[0];
    if (!p) {
      return { name: sel.name || 'a resident',
               state: sel.name ? esc(sel.name) + ' has left the estate'
                          : 'they have left the estate',
               rows: '' };
    }
    var where;
    if (p.mode === 'school') where = 'at school, inside the fence';
    else if (p.mode === 'away') where = 'away at work, off the estate';
    else if (p['in']) where = flatWords(p.unit);
    else {
      var at = (st.fixtures || []).filter(function (f) {
        return f.id === p.fixture && f.x === p.x && f.y === p.y;
      })[0];
      var by = at || nearest(st, p.x, p.y, 3);
      where = at ? 'out · at the ' + kindName(at.kind)
        : by ? 'out · near the ' + kindName(by.kind)
        : 'out · on the ' + siteWord(siteOf(p.x, p.y));
    }
    var day = p.pupil ? 'at school on weekdays'
      : p.job ? 'works off the estate on weekdays' : '';
    var stress = Number(p.stress);
    var mood = stress >= 5 ? 'very stressed' : stress >= 1 ? 'stressed' : '';
    var order = ((st.phases && st.phases.order) ||
                 ['dawn', 'morning', 'afternoon', 'evening', 'night'])
      .slice();
    Object.keys(p.habit || {}).forEach(function (k) {
      if (order.indexOf(k) < 0) order.push(k);
    });
    var nowPhase = st.viewPhase || clockPhase;
    var habit = order.filter(function (k) {
      return p.habit && p.habit[k] !== undefined;
    }).map(function (k) {
      var place = p.habit[k];
      var g = place === 'home' ? '🏠' : glyphOf('fixtures', place);
      var cur = k === nowPhase;
      return '<li' + (cur ? ' class="now"' : '') + '><span>' + esc(k) +
        '</span><span>' + (g ? esc(g) + ' ' : '') + esc(kindName(place)) +
        '</span></li>';
    }).join('');
    return {
      name: p.name || 'a resident',
      state: esc(glyphOf('roles', p.role)) + ' ' + esc(p.role) + ', ' +
        ageWord(p.age) + ' · ' + esc(livesWith(p)) + '<br>' + esc(where) +
        (mood ? ' · ' + mood : '') + (day ? '<br>' + esc(day) : ''),
      rows: needRows(p) + familyRows(st, p) +
        (habit ? header('usually') + habit : ''),
    };
  }

  /* The shop is a building with the stall at its door: one place, so one
   * card whichever of the two was clicked. */
  function shopCard(st) {
    var b = (ground && ground.buildings || []).filter(function (x) {
      return x.kind === 'shop';
    })[0];
    var f = (st.fixtures || []).filter(function (x) {
      return x.kind === 'shop';
    })[0];
    var d = b ? (st.buildings || []).filter(function (x) {
      return x.id === b.id;
    })[0] || {} : {};
    var rows = '';
    if (f) {
      rows += row('on the shelves',
                  f.stock === null || f.stock === undefined ? '—'
                    : fmt(f.stock)) +
        row('visits so far', fmt(f.uses)) +
        row('inside now', fmt(usingNow(st, f)) + ' of ' + fmt(f.cap)) +
        conditionRow(f.c);
    }
    var open = f && Number(f.c) <= 0 ? '⚠ broken, closed until mended'
      : 'open';
    return {
      name: glyphOf('fixtures', 'shop') + ' ' + (b ? b.name : 'the shop'),
      state: open + offs(d),
      rows: rows,
    };
  }

  /* the school is the building and the gate in its fence: one card */
  function schoolCard(st) {
    var b = (ground && ground.buildings || []).filter(function (x) {
      return x.kind === 'school';
    })[0];
    var f = (st.fixtures || []).filter(function (x) {
      return x.kind === 'school';
    })[0];
    var d = b ? (st.buildings || []).filter(function (x) {
      return x.id === b.id;
    })[0] || {} : {};
    var dn = daytime(st);
    var rows = row('pupils on the roll', fmt(dn.enrolled)) +
      row('in today', fmt(dn.inToday)) + row('in school now', fmt(dn.school));
    if (f) rows += row('through the gate so far', fmt(f.uses)) +
      conditionRow(f.c);
    return {
      name: glyphOf('fixtures', 'school') + ' ' +
        (b ? b.name : 'the school'),
      state: (b ? fmt(b.floors) + ' floors · ' : '') +
        'a weekday school for the estate\'s children' + offs(d),
      rows: rows,
    };
  }

  /* power and water are news only when they are off */
  function offs(d) {
    return (d.power === false ? '<br>⚠ no power' : '') +
      (d.water === false ? '<br>⚠ no water' : '');
  }

  function blockCard(st, b) {
    var d = (st.buildings || []).filter(function (x) {
      return x.id === b.id;
    })[0] || {};
    var units = (ground && ground.units) || {};
    var home = function (p) {
      var u = p.unit !== null && p.unit !== undefined ? p.unit : p.punit;
      return units[String(u)];
    };
    var here = (st.people || []).filter(function (p) {
      var u = home(p);
      return u && u.b === b.id;
    });
    var inNow = here.filter(function (p) { return p['in']; }).length;
    var kinds = {};
    var seen = {};
    here.forEach(function (p) {
      var u = p.unit !== null && p.unit !== undefined ? p.unit : p.punit;
      if (seen[u]) return;
      seen[u] = 1;
      kinds[p.kind] = (kinds[p.kind] || 0) + 1;
    });
    var hh = Object.keys(kinds).sort(function (a, c) {
      return kinds[c] - kinds[a];
    }).map(function (k) {
      return '<li><span>' + esc(glyphOf('households', k)) + ' ' +
        esc(kindWord(k)) + '</span><span>' + fmt(kinds[k]) + '</span></li>';
    }).join('');
    var bg = glyphOf('sites', 'building');
    return {
      name: (bg ? bg + ' ' : '') + b.name,   // headed like a cell or the shop
      state: fmt(b.floors) + ' floors · ' + fmt(d.lived) + ' of ' +
        fmt(d.units) + ' flats lived in' + offs(d),
      rows: row('people live here', fmt(here.length)) +
        row('at home now', fmt(inNow)) +
        (hh ? header('households') + hh : ''),
    };
  }

  function fixtureCard(st, f) {
    if (f.kind === 'shop') return shopCard(st);
    if (f.kind === 'school') return schoolCard(st);
    var spec = glyphOf('fixtures', f.kind) + ' ' + kindName(f.kind);
    var rows = '';
    var bits = [];
    var c = Number(f.c);
    if (f.kind === 'lamp') {
      var ph = st.viewPhase || clockPhase;
      bits.push(!(c > 0) ? '⚠ out, bulb gone'
        : LIT_PHASES[ph] ? 'lit' : 'off in daylight');
      var lit = near(st, f.x, f.y, 2, function (g) {
        return !LIVING[g.kind];
      });
      bits.push(lit.length ? 'lights ' + some(lit)
        : 'lights the ' + siteWord(siteOf(f.x, f.y)));
      rows = conditionRow(f.c);
    } else if (f.kind === 'tree') {
      var shaded = near(st, f.x, f.y, 2, function (g, dx, dy) {
        return !LIVING[g.kind] && dx <= 1 && dy <= 1;
      });
      bits.push(shaded.length ? 'shades ' + some(shaded)
        : 'shades the ' + siteWord(siteOf(f.x, f.y)));
      if (st.weather === 'storm') bits.push('could come down in a storm');
    } else if (f.kind === 'bus_stop') {
      var dn = daytime(st);
      bits.push('the bus to work, on weekdays');
      rows = row('work off the estate', fmt(dn.workers)) +
        row('at work now', fmt(dn.away)) +
        row('boardings so far', fmt(f.uses)) + conditionRow(f.c);
    } else {
      if (f.kind === 'bench' && f.perimeter) spec += ' by the footpath';
      if (!(c > 0)) bits.push('⚠ broken');
      if (field(st, 'shade', f.x, f.y) >= 2) bits.push('in the shade of a tree');
      if (f.kind !== 'playground' && field(st, 'light', f.x, f.y) >= 3) {
        bits.push('lamplit after dark');
      }
      var now = usingNow(st, f);
      var cap = Number(f.cap) || 0;
      rows = row((USE_WORD[f.kind] || 'uses') + ' so far', fmt(f.uses)) +
        (cap ? row(f.kind === 'bench' ? 'seats taken'
                   : f.kind === 'table' ? 'at the table' : 'here now',
                   fmt(now) + ' of ' + fmt(cap)) : '') +
        conditionRow(f.c);
    }
    if (!bits.length) bits.push('on the ' + siteWord(siteOf(f.x, f.y)));
    return { name: spec, state: esc(bits.join(' · ')), rows: rows };
  }

  /* shade and lamplight on the ground, 0-9 from the server */
  function shadeWord(v) {
    return v >= 6 ? 'deep' : v >= 3 ? 'some' : v > 0 ? 'a little' : 'none';
  }
  function lightWord(v) {
    return v >= 6 ? 'bright after dark' : v >= 3 ? 'lit after dark'
      : v > 0 ? 'dim after dark' : 'dark at night';
  }

  function cellCard(st, sel) {
    var site = siteOf(sel.x, sel.y);
    if (!site) return null;
    var shade = field(st, 'shade', sel.x, sel.y);
    var light = field(st, 'light', sel.x, sel.y);
    var by = nearest(st, sel.x, sel.y, 3);
    /* a row for what is there; no shade and no lamp are not rows with an
     * empty bar */
    var rows = (shade > 0 ? '<li class="need"><span>shade</span>' +
      bar(shade, 9) + '<span>' + shadeWord(shade) + '</span></li>' : '') +
      (light > 0 ? '<li class="need"><span>lamplight</span>' + bar(light, 9) +
      '<span>' + lightWord(light) + '</span></li>' : '');
    /* with nothing near and no rows, a line still says what it is: a card
     * that is only a heading reads as broken */
    var plain = { road: 'a road round the estate', path: 'a footpath' };
    return {
      name: glyphOf('sites', site) + ' ' + siteWord(site),
      state: by ? 'near the ' + esc(kindName(by.kind))
        : rows ? '' : plain[site] || 'no shade or lamplight here',
      rows: rows,
    };
  }

  function cardFor(st, sel) {
    if (!st || !sel) return null;
    if (sel.kind === 'resident') return residentCard(st, sel);
    if (sel.kind === 'shop') return shopCard(st);
    if (sel.kind === 'school') return schoolCard(st);
    if (sel.kind === 'fixture') {
      var f = (st.fixtures || []).filter(function (x) {
        return x.id === sel.id;
      })[0];
      if (!f) return { name: 'a place', state: 'gone', rows: '' };
      return fixtureCard(st, f);
    }
    if (sel.kind === 'building') {
      var b = (ground && ground.buildings || []).filter(function (x) {
        return x.id === sel.id;
      })[0];
      if (!b) return null;
      /* each kind of building says what it is for: a school's card counts
       * pupils, not the flats it does not have */
      if (b.kind === 'shop') return shopCard(st);
      if (b.kind === 'school') return schoolCard(st);
      return blockCard(st, b);
    }
    if (sel.kind === 'cell') return cellCard(st, sel);
    return null;
  }

  /* Write the card for `sel`, or close it. Returns whether it is open.
   * The rows are written only when they changed, so a card being read (or
   * scrolled) is not rebuilt under the reader on every poll. */
  function card(st, sel) {
    var c = cardFor(st, sel);
    var el = $('card');
    if (!c) { el.classList.remove('on'); return false; }
    $('cardName').textContent = c.name;
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
    setGround: setGround,
    update: update,
    head: head,
    setClock: setClock,
    tab: tab,
    card: card,
    glyphOf: glyphOf,
    kindName: kindName,
    esc: esc,
    num: fmt,
    voiceLine: voiceLine,
    needWord: needWord,
    phaseView: phaseView,
    scrubber: scrubber,
    view: function () { return view; },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.EstateHUD = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
