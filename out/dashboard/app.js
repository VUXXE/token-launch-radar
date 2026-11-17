(function () {
  'use strict';
  var D = window.RADAR;
  var boardEl = document.getElementById('view-board');
  var detailEl = document.getElementById('view-detail');
  if (!D || !boardEl || !detailEl) {
    if (boardEl) boardEl.innerHTML = '<div class="panel empty"><h2>The radar data did not load</h2><p>Run main.ts to write data.js beside the dashboard.</p></div>';
    return;
  }

  function $(sel, el) { return (el || document).querySelector(sel); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtUsd(n) { return '$' + Math.round(Number(n)).toLocaleString('en-US'); }
  function fmtCompact(n) {
    var a = Math.abs(Number(n) || 0);
    if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + Math.round(n || 0);
  }
  function fmtPct(v) { return v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }
  function fmtAge(d) {
    if (!isFinite(d) || d <= 0) return '—';
    if (d >= 730) return (d / 365).toFixed(1) + 'y';
    if (d >= 60) return Math.round(d / 30) + 'mo';
    return Math.round(d) + 'd';
  }
  function median(values) {
    var v = values.filter(function (x) { return typeof x === 'number' && isFinite(x); }).sort(function (a, b) { return a - b; });
    if (!v.length) return null;
    var m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  var state = { q: '', cat: '', chain: '', preOnly: true, sort: 'rank', dir: 1, liveSort: 'multiple', liveDir: -1 };

  function readUrl() {
    var sp = new URLSearchParams(location.search);
    state.q = sp.get('q') || '';
    state.cat = sp.get('cat') || sp.get('category') || '';
    state.chain = sp.get('chain') || '';
    if (sp.get('view') === 'live' || sp.get('pre') === '0' || sp.get('pretoken') === '0') state.preOnly = false;
    if (sp.get('pre') === '1' || sp.get('pretoken') === '1') state.preOnly = true;
  }
  function writeUrl() {
    var sp = new URLSearchParams();
    if (state.q) sp.set('q', state.q);
    if (state.cat) sp.set('cat', state.cat);
    if (state.chain) sp.set('chain', state.chain);
    if (!state.preOnly) sp.set('pre', '0');
    var qs = sp.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }

  var allCats = Array.from(new Set(D.rows.concat(D.live).map(function (r) { return r.category; }).filter(Boolean))).sort();
  var allChains = Array.from(new Set(D.rows.concat(D.live).reduce(function (a, r) { return a.concat(r.chains || []); }, []))).sort();

  function route() {
    var m = (location.hash || '').match(/^#\/p\/([^?#]+)/);
    if (m) showDetail(decodeURIComponent(m[1]));
    else showBoard();
  }

  function meta() {
    var el = $('#meta');
    if (!el) return;
    el.innerHTML =
      '<span class="pill">Snapshot ' + esc(D.as_of) + '</span>' +
      '<span class="pill">Model ' + esc(D.model_version) + '</span>' +
      '<span class="pill">' + D.screen.candidates + ' candidates · ' + D.screen.watchlist_size + ' watch</span>';
  }

  function controlsHTML() {
    var catOpts = '<option value="">All categories</option>' + allCats.map(function (c) {
      return '<option value="' + esc(c) + '"' + (c === state.cat ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    var chainOpts = '<option value="">All chains</option>' + allChains.map(function (c) {
      return '<option value="' + esc(c) + '"' + (c === state.chain ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    return '<div class="controls">' +
      '<label class="field"><span>Search</span><input id="q" type="search" autocomplete="off" placeholder="Name, slug, chain…" value="' + esc(state.q) + '"></label>' +
      '<label class="field"><span>Category</span><select id="cat">' + catOpts + '</select></label>' +
      '<label class="field"><span>Chain</span><select id="chain">' + chainOpts + '</select></label>' +
      '<label class="toggle"><input id="pre" type="checkbox"' + (state.preOnly ? ' checked' : '') + '>' +
      '<span class="toggle-text"><strong>Pre-token only</strong><small>' + (state.preOnly ? 'Ranked launch candidates' : 'Live token-bearing peers') + '</small></span></label>' +
      '</div>';
  }

  function stat(k, v, s) {
    return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div><div class="s">' + esc(s) + '</div></div>';
  }
  function boardStatsHTML(rows) {
    var total = rows.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    var watch = rows.filter(function (r) { return r.on_watchlist; }).length;
    var medAge = median(rows.map(function (r) { return r.age_days; }));
    return '<div class="stats">' +
      stat('Candidates ranked', String(rows.length), 'of ' + D.screen.candidates + ' launch candidates') +
      stat('On watchlist', String(watch), 'of ' + D.screen.watchlist_size + ' house slots') +
      stat('Total implied value', fmtCompact(total), 'sum of the rows in view') +
      stat('Median age', medAge == null ? '—' : fmtAge(medAge), 'tracked without a token') +
      '</div>';
  }
  function liveStatsHTML(rows) {
    var mults = rows.map(function (r) { return r.mcap_tvl; });
    var chg = rows.map(function (r) { return r.change_7d; });
    var mcap = rows.reduce(function (s, r) { return s + (r.mcap_usd || 0); }, 0);
    var medM = median(mults);
    var medC = median(chg);
    return '<div class="stats">' +
      stat('Token peers', String(rows.length), 'with a token on record') +
      stat('Median multiple', medM == null ? '—' : medM.toFixed(2) + 'x', 'market cap ÷ TVL') +
      stat('Total market cap', fmtCompact(mcap), 'sum of the rows in view') +
      stat('Median 7d change', medC == null ? '—' : fmtPct(medC), 'TVL move, where reported') +
      '</div>';
  }

  function filterText(r) {
    return [r.name, r.slug, r.category || '', (r.chains || []).join(' '), r.symbol || ''].join(' ');
  }
  function applyFilters(rows) {
    var out = rows;
    if (state.cat) out = out.filter(function (r) { return (r.category || '') === state.cat; });
    if (state.chain) out = out.filter(function (r) { return (r.chains || []).indexOf(state.chain) >= 0; });
    if (state.q) {
      var q = state.q.toLowerCase();
      out = out.filter(function (r) { return filterText(r).toLowerCase().indexOf(q) >= 0; });
    }
    return out;
  }
  function boardRows() { return applyFilters(D.rows); }
  function liveRows() { return applyFilters(D.live); }

  function cmp(a, b, key) {
    switch (key) {
      case 'rank': return a.rank - b.rank;
      case 'name': return a.name.localeCompare(b.name);
      case 'category': return (a.category || 'zzz').localeCompare(b.category || 'zzz');
      case 'implied': return a.implied_value_usd - b.implied_value_usd;
      case 'tvl': return a.tvl_usd - b.tvl_usd;
      case 'change': return (a.change_7d == null ? -1e15 : a.change_7d) - (b.change_7d == null ? -1e15 : b.change_7d);
      case 'age': return a.age_days - b.age_days;
      case 'mcap': return (a.mcap_usd || 0) - (b.mcap_usd || 0);
      case 'multiple': return (a.mcap_tvl || 0) - (b.mcap_tvl || 0);
      default: return 0;
    }
  }
  function sortBoard(rows) {
    return rows.slice().sort(function (a, b) { return (cmp(a, b, state.sort) || a.rank - b.rank) * state.dir; });
  }
  function sortLive(rows) {
    return rows.slice().sort(function (a, b) { return (cmp(a, b, state.liveSort) || 0) * state.liveDir; });
  }

  function sortTh(key, label, numeric) {
    var active = state.sort === key;
    var arrow = active ? (state.dir === 1 ? '▲' : '▼') : '';
    return '<th class="' + (numeric ? 'c-num' : '') + '"' + (active ? ' aria-sort="' + (state.dir === 1 ? 'ascending' : 'descending') + '"' : '') +
      '><button class="th-sort" type="button" data-k="' + key + '">' + esc(label) + '<span class="arrow">' + arrow + '</span></button></th>';
  }
  function liveTh(key, label, numeric) {
    var active = state.liveSort === key;
    var arrow = active ? (state.liveDir === 1 ? '▲' : '▼') : '';
    return '<th class="' + (numeric ? 'c-num' : '') + '"' + (active ? ' aria-sort="' + (state.liveDir === 1 ? 'ascending' : 'descending') + '"' : '') +
      '><button class="th-sort" type="button" data-lk="' + key + '">' + esc(label) + '<span class="arrow">' + arrow + '</span></button></th>';
  }

  function emptyHTML() {
    var filters = [];
    if (state.q) filters.push('search "' + state.q + '"');
    if (state.cat) filters.push('category ' + state.cat);
    if (state.chain) filters.push('chain ' + state.chain);
    return '<div class="empty">' +
      '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="24" cy="24" r="17"/><circle cx="24" cy="24" r="8"/><path d="M24 24 37 11"/><circle cx="24" cy="24" r="2" fill="currentColor"/></svg>' +
      '<h2>Nothing on the radar</h2>' +
      '<p>No ' + (state.preOnly ? 'launch candidates' : 'live token peers') + ' match' + (filters.length ? ' ' + esc(filters.join(' + ')) : '') + '.</p>' +
      '<a class="btn" href="' + esc(location.pathname) + '">Back to the full board</a>' +
      '</div>';
  }

  function boardTable(rows) {
    if (!rows.length) return emptyHTML();
    var sorted = sortBoard(rows);
    var max = Math.max.apply(null, sorted.map(function (r) { return r.implied_value_usd; }).concat([1]));
    var body = sorted.map(function (r) {
      var chg = r.change_7d == null ? '<span class="muted">—</span>' : '<span class="' + (r.change_7d >= 0 ? 'pos' : 'neg') + '">' + fmtPct(r.change_7d) + '</span>';
      var width = Math.max(2, (r.implied_value_usd / max) * 100);
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="num rank c-rank">' + r.rank + '</td>' +
        '<td><div class="proto"><a class="name" href="#/p/' + encodeURIComponent(r.slug) + '">' + esc(r.name) + '</a>' +
        (r.on_watchlist ? '<span class="chip watch">WATCH</span>' : '') + '</div><div class="sub">' + esc(r.slug) + '</div></td>' +
        '<td><span class="chip cat">' + esc(r.category || 'Uncategorized') + '</span></td>' +
        '<td class="c-num"><div class="value"><span class="num">' + fmtCompact(r.implied_value_usd) + '</span>' +
        '<span class="vbar" aria-hidden="true"><i style="width:' + width.toFixed(1) + '%"></i></span></div></td>' +
        '<td class="num c-num">' + fmtCompact(r.tvl_usd) + '</td>' +
        '<td class="num c-num">' + chg + '</td>' +
        '<td class="num c-num">' + fmtAge(r.age_days) + '</td>' +
        '</tr>';
    }).join('');
    return '<div class="table-wrap"><table><thead><tr>' +
      sortTh('rank', 'Rank', false) + sortTh('name', 'Protocol', false) + sortTh('category', 'Category', false) +
      sortTh('implied', 'Implied value', true) + sortTh('tvl', 'TVL', true) + sortTh('change', '7d', true) + sortTh('age', 'Age', true) +
      '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  function liveTable(rows) {
    if (!rows.length) return emptyHTML();
    var sorted = sortLive(rows);
    var body = sorted.map(function (r) {
      var chg = r.change_7d == null ? '<span class="muted">—</span>' : '<span class="' + (r.change_7d >= 0 ? 'pos' : 'neg') + '">' + fmtPct(r.change_7d) + '</span>';
      return '<tr><td><div class="proto"><span class="name">' + esc(r.name) + '</span><span class="chip token">' + esc(r.symbol || 'token') + '</span></div><div class="sub">' + esc(r.slug) + '</div></td>' +
        '<td><span class="chip cat">' + esc(r.category || 'Uncategorized') + '</span></td>' +
        '<td class="num c-num">' + fmtCompact(r.tvl_usd) + '</td>' +
        '<td class="num c-num">' + (r.mcap_usd ? fmtCompact(r.mcap_usd) : '—') + '</td>' +
        '<td class="num c-num">' + (r.mcap_tvl == null ? '—' : Number(r.mcap_tvl).toFixed(2) + 'x') + '</td>' +
        '<td class="num c-num">' + chg + '</td></tr>';
    }).join('');
    return '<div class="table-wrap"><table><thead><tr>' +
      liveTh('name', 'Protocol', false) + liveTh('category', 'Category', false) + liveTh('tvl', 'TVL', true) +
      liveTh('mcap', 'Market cap', true) + liveTh('multiple', 'Mcap/TVL', true) + liveTh('change', '7d', true) +
      '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  function methodologyHTML() {
    var s = D.screen;
    var g = D.multiples.global;
    return '<details class="method"><summary>How this radar works — screen, value model, fallbacks and limits<span>open to read</span></summary><div class="method-body"><div class="method-grid">' +
      '<div><h3>The screen</h3><p>' + s.pre_token_total + ' protocols in the sealed snapshot record no token. ' + s.excluded_as_product +
      ' are excluded as wrapped, staked, bridged or exchange products, leaving ' + s.candidates + ' launch candidates. ' + s.below_floor +
      ' of them sit below the $' + Math.round(D.floor_usd / 1e6) + 'M watchlist floor and stay on the board anyway.</p>' +
      '<p>All ' + s.watchlist_size + ' watchlist slugs are ranked and carry a WATCH chip. Token-bearing protocols are held out as live comparables.</p></div>' +
      '<div><h3>The value model</h3><p>implied = round(TVL × category multiple × momentum × maturity), using snapshot fields only. ' +
      'The category multiple is the median market-cap/TVL of priced token-bearing peers in the same category. Categories with fewer than three peers fall back to the global median of ' +
      Number(g.multiple).toFixed(2) + 'x over ' + g.peer_count + ' peers. Multiples are clamped to 0.05–2.00x.</p>' +
      '<p>Momentum maps the 7d TVL change (clamped to −60%…+120%) to 0.70–1.60x; a null change is neutral. Maturity rises from 0.70x to 1.30x over five years tracked without a token; a null listing date defaults to 365 days.</p></div>' +
      '<div><h3>Reading the board</h3><p>Each row shows the implied value, its TVL, the 7d move and the no-token age. Open a protocol for the factor waterfall, up to six priced category peers and the full farm plan.</p>' +
      '<p>Values are a comparative signal, not a price, a valuation or a launch promise. Small peer samples and volatile TVL moves deserve caution.</p></div>' +
      '</div><p class="disclaimer">Snapshot ' + esc(D.as_of) + ' · model ' + esc(D.model_version) + ' · ' + D.live.length + ' token-bearing protocols held out as live comparables.</p></div></details>';
  }

  function noteHTML() {
    if (state.preOnly) {
      return '<div class="model-note"><strong>Model</strong> implied = round(TVL × category multiple × momentum × maturity) · ' +
        D.screen.candidates + ' candidates from ' + D.screen.pre_token_total + ' token-free records · ' +
        D.screen.watchlist_size + ' watchlist · ' + D.screen.below_floor + ' below the $' + Math.round(D.floor_usd / 1e6) + 'M floor.</div>';
    }
    return '<div class="model-note"><strong>Live comparables</strong> ' + D.live.length +
      ' token-bearing protocols held out of the ranking. Multiple = market cap ÷ TVL.</div>';
  }

  function renderBody() {
    var statsEl = $('#stats'), tableEl = $('#table'), methodEl = $('#method'), noteEl = $('#note');
    if (!statsEl || !tableEl) return;
    if (noteEl) noteEl.innerHTML = noteHTML();
    if (state.preOnly) {
      var rows = boardRows();
      statsEl.innerHTML = boardStatsHTML(rows);
      tableEl.innerHTML = boardTable(rows);
      if (methodEl) methodEl.innerHTML = methodologyHTML();
    } else {
      var live = liveRows();
      statsEl.innerHTML = liveStatsHTML(live);
      tableEl.innerHTML = liveTable(live);
      if (methodEl) methodEl.innerHTML = '';
    }
  }

  function bindControls() {
    var q = $('#q'), cat = $('#cat'), chain = $('#chain'), pre = $('#pre');
    if (q) q.addEventListener('input', function (e) { state.q = e.target.value; writeUrl(); renderBody(); });
    if (cat) cat.addEventListener('change', function (e) { state.cat = e.target.value; writeUrl(); renderBody(); });
    if (chain) chain.addEventListener('change', function (e) { state.chain = e.target.value; writeUrl(); renderBody(); });
    if (pre) pre.addEventListener('change', function (e) {
      state.preOnly = e.target.checked;
      writeUrl();
      renderControls();
      renderBody();
    });
  }

  function renderControls() {
    var el = $('#controls');
    if (!el) return;
    el.innerHTML = controlsHTML();
    bindControls();
  }

  function bindTable() {
    var el = $('#table');
    if (!el) return;
    el.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-k],[data-lk]');
      if (btn) {
        e.preventDefault();
        if (btn.dataset.k) {
          var k = btn.dataset.k;
          var asc = k === 'rank' || k === 'name' || k === 'category';
          if (state.sort === k) state.dir *= -1;
          else { state.sort = k; state.dir = asc ? 1 : -1; }
        } else if (btn.dataset.lk) {
          var lk = btn.dataset.lk;
          var lasc = lk === 'name' || lk === 'category';
          if (state.liveSort === lk) state.liveDir *= -1;
          else { state.liveSort = lk; state.liveDir = lasc ? 1 : -1; }
        }
        renderBody();
        return;
      }
      var row = e.target.closest('tr[data-slug]');
      if (row && !e.target.closest('a')) location.hash = '#/p/' + encodeURIComponent(row.dataset.slug);
    });
  }

  function showBoard() {
    detailEl.classList.add('hidden');
    boardEl.classList.remove('hidden');
    boardEl.innerHTML = '<div class="panel"><div id="controls"></div><div id="stats"></div><div id="note"></div><div id="table"></div><div id="method"></div></div>';
    renderControls();
    bindTable();
    renderBody();
  }

  function parseStep(s) {
    var t = String(s);
    var ci = t.indexOf(' Cost: ');
    var ti = t.indexOf(' Time: ');
    var action = ci >= 0 ? t.slice(0, ci) : t;
    var cost = ci >= 0 ? t.slice(ci + 6, ti >= 0 ? ti : t.length).replace(/\.$/, '') : '';
    var time = ti >= 0 ? t.slice(ti + 6).replace(/\.$/, '') : '';
    return { action: action, cost: cost, time: time };
  }

  function waterfallSvg(r) {
    var base = r.tvl_usd * r.category_multiple;
    var afterMom = base * r.momentum_multiplier;
    var afterMat = afterMom * r.maturity_multiplier;
    var vals = [r.tvl_usd, base, afterMom, afterMat];
    var max = Math.max.apply(null, vals.concat([1]));
    var W = 520, H = 156, padT = 22, padB = 24, bw = 76, gap = 44;
    var total = 4 * bw + 3 * gap;
    var x0 = (W - total) / 2;
    var plot = H - padT - padB;
    var labels = ['TVL', '× Multiple', '× Momentum', '× Maturity'];
    var nums = [fmtCompact(r.tvl_usd), fmtCompact(base), fmtCompact(afterMom), fmtCompact(r.implied_value_usd)];
    var colors = ['#a9c8bd', '#7fb3a3', '#4f947f', '#0c6b55'];
    var s = '<svg class="water" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Implied value waterfall">';
    for (var i = 0; i < 4; i++) {
      var h = Math.max(2, (vals[i] / max) * plot);
      var x = x0 + i * (bw + gap);
      var y = H - padB - h;
      s += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw + '" height="' + h.toFixed(1) + '" rx="4" fill="' + colors[i] + '"></rect>';
      s += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (y - 6).toFixed(1) + '" text-anchor="middle" font-size="10.5" fill="#31443c">' + esc(nums[i]) + '</text>';
      s += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 7) + '" text-anchor="middle" font-size="10" fill="#69736d">' + esc(labels[i]) + '</text>';
      if (i < 3) {
        var nx = x0 + (i + 1) * (bw + gap);
        var ny = H - padB - Math.max(2, (vals[i + 1] / max) * plot);
        s += '<line x1="' + (x + bw) + '" y1="' + y.toFixed(1) + '" x2="' + nx + '" y2="' + ny.toFixed(1) + '" stroke="#c8c3b4" stroke-dasharray="3 3"></line>';
      }
    }
    return s + '</svg>';
  }

  function detailHTML(r) {
    var cat = r.category || 'Uncategorized';
    var catKey = r.category || '__none__';
    var catInfo = D.multiples.categories[catKey];
    var peers = D.live.filter(function (p) { return (p.category || '') === (r.category || '') && p.mcap_tvl != null; })
      .sort(function (a, b) { return b.mcap_tvl - a.mcap_tvl; });
    var shown = peers.slice(0, 6);
    var peerList = shown.length
      ? '<ul class="peers">' + shown.map(function (p) {
        return '<li><span class="sym">' + esc(p.symbol || '—') + '</span><span class="pname">' + esc(p.name) + '</span>' +
          '<span class="pmult num">' + Number(p.mcap_tvl).toFixed(2) + 'x</span><span class="pmcap num">' + fmtCompact(p.mcap_usd || 0) + '</span></li>';
      }).join('') + '</ul>'
      : '<p class="lead">No token-bearing protocol in this category records both a positive market cap and TVL.</p>';
    var peerNote = shown.length
      ? (peers.length > shown.length ? 'Showing ' + shown.length + ' of ' + peers.length + ' priced peers' : peers.length + ' priced peer' + (peers.length === 1 ? '' : 's')) + ', sorted by market cap ÷ TVL.'
      : 'No local peer multiple is available.';
    var callout;
    if (r.multiple_source === 'category') {
      callout = '<div class="callout"><strong>Category multiple · ' + Number(r.category_multiple).toFixed(2) + 'x</strong>' +
        'Median of ' + r.peer_count + ' priced peers in ' + esc(cat) + '. This is the multiple applied to ' + esc(r.name) + '’s TVL.</div>';
    } else {
      callout = '<div class="callout warn"><strong>Fallback multiple · ' + Number(r.category_multiple).toFixed(2) + 'x</strong>' +
        'Fewer than three priced peers in ' + esc(cat) + ', so the model uses the global median of ' +
        Number(r.category_multiple).toFixed(2) + 'x over ' + r.peer_count + ' peers.</div>';
    }
    var chg = r.change_7d == null ? '<span class="muted">—</span>' : '<span class="' + (r.change_7d >= 0 ? 'pos' : 'neg') + '">' + fmtPct(r.change_7d) + '</span>';
    var steps = (r.farm_steps || []).map(function (s, i) {
      var p = parseStep(s);
      return '<li class="step"><div class="step-n">' + (i + 1) + '</div><div class="step-body"><div>' + esc(p.action) + '</div>' +
        '<div class="step-chips">' + (p.cost ? '<span class="chip cost">Cost: ' + esc(p.cost) + '</span>' : '') +
        (p.time ? '<span class="chip time">Time: ' + esc(p.time) + '</span>' : '') + '</div></div></li>';
    }).join('');
    var back = esc(location.pathname + location.search) + '#';
    return '<a class="back" href="' + back + '">← Back to board</a>' +
      '<article class="panel detail-head"><div class="rank-badge">#' + r.rank + '</div><div class="grow">' +
      '<h2>' + esc(r.name) + (r.on_watchlist ? '<span class="chip watch">WATCH</span>' : '') + '</h2>' +
      '<div class="sub">' + esc(r.slug) + ' · ' + esc((r.chains || []).join(', ') || 'No chain listed') + '</div>' +
      '<div class="chips"><span class="chip cat">' + esc(cat) + '</span><span class="chip">Records no token</span></div></div>' +
      '<div class="head-value"><div class="k">Implied value</div><div class="v">' + fmtUsd(r.implied_value_usd) + '</div></div></article>' +
      '<div class="why"><strong>Why this rank</strong> #' + r.rank + ' of ' + D.rows.length + ' by implied value · #' + r.category_rank + ' of ' + r.category_size +
      ' in ' + esc(cat) + ' · #' + r.tvl_rank + ' by TVL among ranked candidates.</div>' +
      '<div class="detail-grid">' +
      '<section class="panel card span-7"><h3>Implied value build</h3><p class="lead">TVL × category multiple × momentum × maturity, using snapshot fields only.</p>' +
      waterfallSvg(r) + '<div class="factors">' +
      '<div class="factor"><div class="k">Category multiple</div><div class="v">' + Number(r.category_multiple).toFixed(3) + 'x</div><div class="s">' +
      (r.multiple_source === 'category' ? 'median of ' + r.peer_count + ' peers in ' + esc(cat) : 'global fallback over ' + r.peer_count + ' peers') + '</div></div>' +
      '<div class="factor"><div class="k">Momentum</div><div class="v">' + Number(r.momentum_multiplier).toFixed(3) + 'x</div><div class="s">from 7d change ' + (r.change_7d == null ? '(null → 0%)' : fmtPct(r.change_7d)) + '</div></div>' +
      '<div class="factor"><div class="k">Maturity</div><div class="v">' + Number(r.maturity_multiplier).toFixed(3) + 'x</div><div class="s">' + r.age_days + ' days tracked without a token</div></div>' +
      '</div><div class="kv">' +
      '<div class="item"><div class="k">TVL</div><div class="v num">' + fmtUsd(r.tvl_usd) + '</div></div>' +
      '<div class="item"><div class="k">7d change</div><div class="v num">' + chg + '</div></div>' +
      '<div class="item"><div class="k">Age</div><div class="v num">' + fmtAge(r.age_days) + '</div><div class="s">' + r.age_days + ' days</div></div>' +
      '<div class="item"><div class="k">Listed at</div><div class="v">' + esc(r.listed_at || 'unknown') + '</div></div>' +
      '</div></section>' +
      '<section class="panel card span-5"><h3>Token-bearing peers</h3><p class="lead">Up to six priced peers in ' + esc(cat) + '; ' + esc(peerNote) + '</p>' +
      peerList + callout + '</section>' +
      '<section class="panel card span-12"><h3>Farm plan</h3><p class="lead">Concrete steps derived from ' + esc(r.name) +
      '’s category, chains, TVL and age. Costs and times are estimates; verify onchain before committing capital.</p><ol class="steps">' + steps + '</ol></section>' +
      '</div>';
  }

  function showDetail(slug) {
    boardEl.classList.add('hidden');
    detailEl.classList.remove('hidden');
    var r = D.rows.find(function (x) { return x.slug === slug; });
    if (!r) {
      detailEl.innerHTML = '<a class="back" href="' + esc(location.pathname + location.search) + '#">← Back to board</a>' +
        '<div class="panel card"><h2>Protocol not found</h2><p class="muted">No ranked protocol has the slug “' + esc(slug) + '”.</p></div>';
      return;
    }
    detailEl.innerHTML = detailHTML(r);
    window.scrollTo(0, 0);
  }

  function init() {
    meta();
    readUrl();
    window.addEventListener('hashchange', route);
    window.addEventListener('popstate', function () { readUrl(); route(); });
    route();
  }
  init();
})();
