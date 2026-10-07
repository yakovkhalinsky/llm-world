/* panels — the words around the plan.
 *
 * The scene shows the estate; these show what it means. Both read the same
 * frame, so a number in a panel and a shape on the plan can never disagree
 * — and the glyphs come with the ground payload, from the pack, because a
 * page that spells its own emoji has a second copy of a fact that lives in
 * the world's law (grove b21: three hand-copied palettes).
 */

'use strict';

const Panels = (() => {
  const $ = id => document.getElementById(id);

  const esc = s => String(s === null || s === undefined ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;',
                                '"': '&quot;' })[c]);

  const WEATHER_WORD = { clear: 'clear', rain: 'rain', storm: 'storm',
                         heat: 'heat', frost: 'frost' };

  /* the glyph tables arrive whole; this is the lookup, not a second copy */
  function glyphOf(group, key) {
    const g = (S.ground && S.ground.glyphs) || {};
    return ((g[group] || {})[key]) || '';
  }

  /* ----------------------------------------------------------- the head */

  function head(st) {
    $('when').textContent =
      'day ' + st.day + ' · ' + st.season_name + ' · ' + st.weekday;
    $('weather').textContent =
      glyphOf('weather', st.weather) + ' ' +
      (WEATHER_WORD[st.weather] || st.weather);

    /* the watcher, in its own words, and the voice that carried them */
    const w = st.watcher || {};
    $('watch').innerHTML = w.fate
      ? '<span class="d">☾</span> ' + esc(w.why || w.fate)
      : '<span class="dim">☾ no watcher has come yet</span>';
    $('voice').textContent = st.llm || '';

    const bits = [];
    bits.push('<b>' + st.residents + '</b> people');
    bits.push('<b>' + (st.buildings || []).length + '</b> blocks');
    bits.push('<b>' + st.units + '</b> flats');
    if (st.waiting) bits.push('<b>' + st.waiting + '</b> waiting');
    $('pops').innerHTML = bits.join(' · ');
  }

  /* --------------------------------------------------------- the census */

  function census(st) {
    const rows = Object.keys(st.census || {})
      .sort((a, b) => st.census[b] - st.census[a])
      .map(k => '<li><span>' + glyphOf('households', k) + ' ' + esc(k) +
                '</span><span>' + st.census[k] + '</span></li>');
    const kinds = st.people.reduce((m, p) => {
      m[p.role] = (m[p.role] || 0) + 1; return m;
    }, {});
    const byrole = Object.keys(kinds).sort().map(k =>
      '<li><span>' + glyphOf('roles', k) + ' ' + esc(k) + '</span><span>' +
      kinds[k] + '</span></li>');
    return '<ul class="timeline">' + rows.join('') + '</ul>' +
      '<div class="status">by age</div><ul class="timeline">' +
      byrole.join('') + '</ul>';
  }

  /* --------------------------------------------------------- the feed */

  function feed(st) {
    /* One row per day, newest first. The sentences come from the server
     * (render.say) — the page does not spell its own, because two wordings
     * for one event would have the estate telling a person and the watcher
     * different stories about the same day. And the rows are *days*, not
     * events: the estate is quiet most days, and a panel that only ever
     * showed events sat unchanged for half an hour and read as broken. */
    const days = (st.days || []).slice().reverse();
    $('chron').innerHTML = days.length ? days.map(d =>
      '<li' + (d.says.length ? '' : ' class="quiet"') + '>' +
      '<span class="d">d' + d.day + '</span> ' +
      (d.says.length ? esc(d.says.join(' · ')) : 'a quiet day') +
      '</li>').join('') : '<li>nothing has happened yet. it is early.</li>';
  }

  function tab(name) {
    S.view = name;
    ['tabChron', 'tabCensus', 'tabWatch'].forEach(id =>
      $(id).classList.toggle('on',
        id === 'tab' + name[0].toUpperCase() + name.slice(1)));
    const st = S.state;
    if (!st) return;
    if (name === 'census') {
      $('chron').innerHTML = census(st);
      $('look').textContent = 'who lives here';
    } else if (name === 'watch') {
      const c = (st.chronicle || []).slice().reverse();
      $('chron').innerHTML = c.length
        ? c.map(e => '<li><span class="d">d' + e.day + '</span> ' +
                     esc(e.text) + '</li>').join('')
        : '<li>no watcher has come yet, and the chronicle is empty. ' +
          'the estate keeps its own lines either way.</li>';
      $('look').textContent = '';
    } else {
      feed(st);
      $('look').textContent = '';
    }
  }

  /* ----------------------------------------------------------- the card */

  function bar(v, max) {
    const pc = Math.max(0, Math.min(100, (v / max) * 100));
    return '<span class="bar"><i style="width:' + pc.toFixed(0) + '%"></i>' +
      '</span> ' + v.toFixed(2);
  }

  function needRows(p) {
    return Object.keys(p.needs).sort().map(n =>
      '<li><span>' + glyphOf('needs', n) + ' ' + esc(n) + '</span>' +
      '<span>' + bar(p.needs[n], 4) + '</span></li>').join('');
  }

  function cardFor(st) {
    const sel = S.sel;
    if (!sel) return null;
    if (sel.kind === 'resident') {
      const p = st.people.filter(p => p.id === sel.id)[0];
      if (!p) return { name: 'a person', state: 'gone', rows: '' };
      const where = p.in ? 'inside, flat ' + p.unit : 'out at ' + p.x + ',' + p.y;
      const habit = Object.keys(p.habit || {}).map(k =>
        '<li><span>' + k + '</span><span>' + esc(p.habit[k]) + '</span></li>')
        .join('');
      return {
        name: (p.name || 'a resident'),
        state: glyphOf('roles', p.role) + ' ' + esc(p.role) + ' · age ' +
          p.age + ' · ' + esc(p.kind || '') + ' household<br>' + esc(where) +
          (p.stress >= 1 ? ' · frayed ' + p.stress : ''),
        rows: needRows(p) + (habit ?
          '<li><span>— today —</span><span></span></li>' + habit : ''),
      };
    }
    if (sel.kind === 'fixture') {
      const f = st.fixtures.filter(f => f.id === sel.id)[0];
      if (!f) return { name: 'a place', state: 'gone', rows: '' };
      const spec = (S.ground.glyphs.fixtures[f.kind] || '') + ' ' + f.kind;
      return {
        name: spec,
        state: 'at ' + f.x + ',' + f.y + ' · used ' + f.uses + ' times' +
          (f.stock !== null && f.stock !== undefined ? ' · stock ' + f.stock : ''),
        rows: '<li><span>condition</span><span>' + bar(f.c, 1) + '</span></li>',
      };
    }
    if (sel.kind === 'building') {
      const b = S.ground.byId[sel.id];
      const d = (st.buildings || []).filter(x => x.id === sel.id)[0] || {};
      if (!b) return null;
      return {
        name: b.name,
        state: b.kind + ' · ' + b.floors + ' floors · door at ' +
          b.door[0] + ',' + b.door[1],
        rows: '<li><span>flats</span><span>' + (d.units || b.units || 0) +
          '</span></li>' +
          '<li><span>lived in</span><span>' + (d.lived || 0) + '</span></li>',
      };
    }
    if (sel.kind === 'cell') {
      const i = sel.y * S.ground.width + sel.x;
      const site = S.ground.codes[S.ground.rows[sel.y][sel.x]];
      return {
        name: glyphOf('sites', site) + ' ' + site,
        state: 'at ' + sel.x + ',' + sel.y,
        rows: '<li><span>shade</span><span>' + (st.shade[i] / 9).toFixed(2) +
          '</span></li>' +
          '<li><span>lamp</span><span>' + (st.light[i] / 9).toFixed(2) +
          '</span></li>',
      };
    }
    return null;
  }

  function card() {
    const st = S.state;
    const el = $('card');
    if (!st || !S.sel) { el.classList.remove('on'); return; }
    const c = cardFor(st);
    if (!c) { el.classList.remove('on'); return; }
    $('cardName').innerHTML = esc(c.name);
    $('cardState').innerHTML = c.state;
    $('cardRows').innerHTML = c.rows;
    el.classList.add('on');
  }

  /* --------------------------------------------------------------- pace */

  /* How the estate is watched. Three buttons and no slider: the choices
   * are the pack's, and the pace is the server's — the page only asks. */
  function speeds(list, onPick) {
    const speeds = list && list.length ? list : [60, 20, 5];
    const box = $('speeds');
    if (!box) return;
    box.innerHTML = speeds.map(s =>
      '<button data-s="' + s + '">' + SPEED_WORD(s) + '</button>').join('');
    Array.prototype.forEach.call(box.querySelectorAll('button'), b => {
      b.onclick = () => onPick(parseFloat(b.dataset.s));
    });
  }

  function SPEED_WORD(s) {
    if (s >= 60 && s % 60 === 0) return (s / 60) + ' min';
    return s + 's';
  }

  function markSpeed(now) {
    const box = $('speeds');
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('button'), b => {
      b.classList.toggle('on', Math.abs(parseFloat(b.dataset.s) - now) < 0.01);
    });
  }

  /* -------------------------------------------------------------- update */

  function update(st) {
    head(st);
    if (S.view === 'chron') feed(st);
    else if (S.view === 'census') census(st);
    if (S.sel) card();
    const b = $('pauseBtn');
    b.textContent = st.paused ? '▶ play' : '⏸ pause';
    b.classList.toggle('on', !!st.paused);
    markSpeed(st.tick_seconds);
  }

  return { update, tab, card, speeds };
})();
