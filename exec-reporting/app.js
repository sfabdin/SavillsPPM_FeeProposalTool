/* ============================================================
   EXECUTIVE REPORTING · shell + renderers
   ------------------------------------------------------------
   The user-facing layer. Boot order on this page:
     1. UFC_Box.boot()  - the SAME boot every page runs: Box auth,
        pull projects.json -> local store, identity -> access wall,
        rates.json -> the page-local catalog shim below.
     2. Gate: Store.seesAllProjects() only. Fail closed - anything
        short of a confirmed full-admin identity sees the access
        panel, never the numbers.
     3. Read-only data assembly through EXEC_CORE's pure mappers.
        Opening the page IS the refresh: boot() always re-pulls.
   This module never writes to projects/rates/staff/studio.
   ============================================================ */
(function () {
  'use strict';

  const $ = (sel, el) => (el || document).querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* Page-local rates catalog shim: boot() hands the confidential grid to
     window.RATES_CATALOG.hydrate if present. We keep it in memory only -
     never in localStorage - matching the tool's own handling. */
  const DATA = { rates: null, staff: null, projectsRaw: null, studioRaw: null, mapped: null, studio: null, overview: null, panels: null, notes: [] };
  window.RATES_CATALOG = { hydrate: (payload) => { DATA.rates = payload; } };

  const CORE = window.EXEC_CORE;
  const MON = CORE.MON;
  const fm = CORE.fmtMoney;
  const fmf = CORE.fmtMoneyFull;

  /* ---------------- boot + gate ---------------- */
  async function main() {
    const root = $('#exec-root');

    /* Dev-only fixtures mode: localhost + ?dev=fixtures&base=<url> renders the
       module from local JSON copies of the four files, so the build can be
       verified without Box. Never active on a deployed origin; no data is
       embedded anywhere. */
    const qp = new URLSearchParams(location.search);
    if ((location.hostname === 'localhost' || location.hostname === '127.0.0.1') && qp.get('dev') === 'fixtures') {
      root.innerHTML = gateBox('Dev fixtures', 'Loading local fixture files…', '');
      try {
        const base = qp.get('base') || 'fixtures';
        const [pj, st] = await Promise.all([
          fetch(base + '/projects.json').then((r) => r.json()),
          fetch(base + '/studio.json').then((r) => r.json()),
        ]);
        DATA.projectsRaw = pj;
        DATA.studioRaw = st;
        computeAll('DEV FIXTURES · local files, not Box');
        render(root, true);
      } catch (e) {
        root.innerHTML = gateBox('Dev fixtures failed', 'Could not fetch the fixture files.', esc(e && e.message));
      }
      return;
    }

    root.innerHTML = gateBox('Loading', 'Signing in to Box and pulling the latest data…', '');
    let boot;
    try {
      boot = await window.UFC_Box.boot();
    } catch (e) {
      root.innerHTML = gateBox('Could not load', 'Box did not answer. Reload to retry.', esc(e && e.message));
      return;
    }
    if (!boot || !boot.ok) {
      if (boot && boot.needsLogin) {
        root.innerHTML = gateBox('Sign in required', 'Executive Reporting reads live data from Box. Sign in with your Savills Box account to continue.', '', '<button id="exec-login">Sign in with Box</button>');
        $('#exec-login').addEventListener('click', () => window.UFC_Box.login());
        return;
      }
      if (boot && boot.needsRates) {
        root.innerHTML = gateBox('Data unavailable', 'The rate card could not be loaded from Box, so the tool cannot start. ' + esc(boot.error || ''), '');
        return;
      }
      root.innerHTML = gateBox('Could not load', 'Box sign-in did not complete. Reload to retry.', '');
      return;
    }

    // ---- THE GATE. seesAllProjects only (store.js rule: every data-
    // visibility decision uses this, never isAdmin). Fail closed.
    const S = window.UFC_Store;
    let allowed = false;
    try { allowed = !!(S && S.seesAllProjects && S.seesAllProjects(S.getCurrentUser())); } catch (e) { allowed = false; }
    if (!allowed) {
      root.innerHTML = gateBox('Executive Reporting is restricted',
        'This area is limited to the leadership access list. Your projects and tools are unaffected - use the menu to get back to them.', '');
      return;
    }

    assemble();
    render(root);
  }

  /* ---------------- data assembly (read-only) ---------------- */
  function assemble() {
    const S = window.UFC_Store;
    DATA.projectsRaw = JSON.parse(S.exportDb());          // the projects.json shape, from the store's own serialiser
    DATA.studioRaw = S.readStudio();
    const pulled = new Date();
    computeAll('Live from Box · pulled ' + pulled.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET');
  }

  function computeAll(asOf) {
    DATA.tab2 = null; DATA.tab3 = null;
    if (DATA.studioRaw && DATA.studioRaw.schemaVersion == null) DATA.studioRaw = Object.assign({ schemaVersion: 1 }, DATA.studioRaw);
    DATA.mapped = CORE.mapProjects(DATA.projectsRaw);
    DATA.studio = CORE.mapStudio(DATA.studioRaw);
    DATA.notes = [];
    if (!DATA.mapped.ok) { DATA.notes.push('projects: ' + DATA.mapped.error); return; }
    if (!DATA.studio.ok) DATA.notes.push('studio: ' + DATA.studio.error);
    const studioOk = DATA.studio.ok ? DATA.studio : { baselines: [], baselineLines: [], scenarios: [] };
    DATA.overview = CORE.pipelineOverview(DATA.mapped, studioOk, asOf);
    DATA.panels = CORE.tab1Panels(DATA.mapped, studioOk, DATA.overview);
    DATA.notes.push(...DATA.mapped.notes);
  }

  function gateBox(title, body, err, extra) {
    return '<div class="gate"><h2>' + esc(title) + '</h2><p>' + body + '</p>' +
      (err ? '<p class="err">' + err + '</p>' : '') + (extra || '') + '</div>';
  }

  /* ---------------- shell ---------------- */
  const TABS = [
    { key: 'pipeline', label: 'Pipeline & Budget' },
    { key: 'leaders', label: 'Leaders' },
    { key: 'clients', label: 'Clients' },
    { key: 'rates', label: 'Rates' },
    { key: 'locations', label: 'Locations' },
    { key: 'clockify', label: 'Delivery & Effort' },
    { key: 'confidence', label: 'Confidence', internal: true },
    { key: 'glossary', label: 'Definitions', internal: true },
  ];
  let activeTab = 'pipeline';

  function render(root, dev) {
    if (!DATA.mapped || !DATA.mapped.ok) {
      root.innerHTML = gateBox('The data files have changed shape',
        'The projects file could not be read the way the data aggregator app normally writes it. Nothing is guessed at in this situation.',
        esc(DATA.notes.join(' · ')));
      return;
    }
    const d = DATA.overview;
    root.innerHTML =
      '<div class="wrap">' +
      '<div class="hdr"><h1>Executive Reporting · ' + d.year + '</h1>' +
      (dev ? '<span class="dflag demo">DEV FIXTURES</span>' : '<span class="badge">LIVE</span>') +
      '<span class="asof">' + esc(d.asOf) + '</span></div>' +
      '<div class="tabbar">' + TABS.map((t) =>
        '<button data-tab="' + t.key + '" class="' + (t.key === activeTab ? 'on ' : '') + (t.internal ? 'internal' : '') + '">' + esc(t.label) + '</button>'
      ).join('') + '</div>' +
      '<div id="exec-tab"></div>' +
      '</div>';
    root.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => {
      activeTab = b.dataset.tab;
      root.querySelectorAll('.tabbar button').forEach((x) => x.classList.toggle('on', x === b));
      renderTab();
    }));
    renderTab();
  }

  function renderTab() {
    const host = $('#exec-tab');
    if (activeTab === 'pipeline') host.innerHTML = tabPipeline();
    else if (activeTab === 'leaders') host.innerHTML = tabLeaders();
    else if (activeTab === 'clients') host.innerHTML = tabClients();
    else host.innerHTML = tabStub(activeTab);
    wireTab(host);
  }

  const tab2 = () => (DATA.tab2 || (DATA.tab2 = CORE.tab2Data(DATA.mapped, DATA.studio.ok ? DATA.studio : { baselines: [], baselineLines: [], scenarios: [] }, DATA.overview)));
  const tab3 = () => (DATA.tab3 || (DATA.tab3 = CORE.tab3Data(DATA.mapped, DATA.overview.year)));

  function tabStub(key) {
    const t = TABS.find((x) => x.key === key);
    return panel((t ? t.label : key), { kind: 'demo', text: 'PORT IN PROGRESS' }, '',
      'This tab is being ported from the Part 2 app. The Pipeline & Budget tab is live; the rest land in this branch before review.', '');
  }

  /* ---------------- shared blocks ---------------- */
  function panel(heading, flag, msg, cap, body) {
    return '<div class="blk"><h3>' + heading +
      (flag ? ' <span class="dflag ' + flag.kind + '">' + esc(flag.text) + '</span>' : '') + '</h3>' +
      (msg ? '<div class="msg">' + msg + '</div>' : '') +
      (body || '') +
      (cap ? '<div class="cap">' + cap + '</div>' : '') +
      '</div>';
  }
  const arrowCell = (delta) => delta >= 0
    ? '<span class="tone-good">↑ ' + fm(Math.abs(delta)) + '</span>'
    : '<span class="tone-bad">↓ ' + fm(Math.abs(delta)) + '</span>';

  /* ---------------- TAB 1 · Pipeline & Budget ---------------- */
  function tabPipeline() {
    const d = DATA.overview;
    const p = DATA.panels;
    const t = (r) => d.tiers.find((x) => x.rating === r) || { revenue: 0, weighted: 0 };
    const r2 = t(2).revenue;
    const r34 = t(3).revenue + t(4).revenue;
    const covered = d.shortfall <= 0;

    // KPI row
    const kpis =
      '<div class="kpirow">' +
      kpi('Annual budget', fm(d.budget), 'set each October · frozen for ' + d.year, 'teal') +
      kpi('Booked (R1)', fm(d.booked), 'firm revenue', '') +
      kpi('Projected (1-4)', fm(d.projected), 'feeds the budget', 'navy') +
      kpi('Risk-weighted EV', fm(d.weighted), 'Σ likelihood × $', '') +
      kpi('Over / (under)', fm(d.overUnder), 'projected − budget', d.overUnder >= 0 ? 'good' : 'bad') +
      '</div>';

    // Bridge panel
    const coverage =
      '<div class="note">We still need <b>' + fm(d.gap) + '</b> to hit budget. The deals we are chasing are worth <b>' + fm(d.openFace) + '</b>, enough if every deal lands. Adjusted for how likely each deal is, they are worth <b class="' + (covered ? 'tone-good' : (d.shortfall <= d.gap * 0.2 ? 'tone-amber' : 'tone-bad')) + '">' + fm(d.openWeighted) + '</b>' +
      (covered ? ', which covers the gap.' : ', about <b>' + fm(d.shortfall) + '</b> short. We either need more deals in play, or better odds on the ones we have.') + '</div>';
    const varTable =
      '<table class="vtable"><thead><tr><th>Total</th><th class="num">Value</th><th class="num">Variance vs budget (' + fmf(d.budget) + ')</th></tr></thead><tbody>' +
      '<tr><td>Projected (1-4), face value</td><td class="num">' + fm(d.projected) + '</td><td class="num">' + arrowCell(d.overUnder) + '</td></tr>' +
      '<tr><td>Risk-weighted (1-4)</td><td class="num">' + fm(d.weighted) + '</td><td class="num">' + arrowCell(d.weighted - d.budget) + '</td></tr>' +
      '</tbody></table>';
    const bridgePanel = panel('Pipeline trending to the frozen annual budget', { kind: 'live', text: 'LIVE' },
      esc(d.bridgeMsg),
      'What it is: how the pipeline builds from Booked up to the current Projected total (' + fm(d.projected) + '), shown next to the risk-weighted total (' + fm(d.weighted) + ', the sum of likelihood × $) and the frozen annual budget bar, with the gap to budget as its own coloured block. Why we show it: at face value the pipeline trends ' + (d.overUnder >= 0 ? 'slightly over' : 'under') + ' budget (' + (d.overUnder >= 0 ? '+' : '') + fm(d.overUnder) + '), but on a risk-weighted basis it is about ' + fm(Math.abs(d.weighted - d.budget)) + ' ' + (d.weighted - d.budget >= 0 ? 'over' : 'under') + ' - the more honest read - so we show both. The gap reads both ways (over or under).',
      bridgeChart(d.booked, r2, r34, d.projected, d.weighted, d.budget) + coverage + varTable);

    // Rating mix
    const maxTier = Math.max.apply(null, d.tiers.map((x) => x.revenue).concat([1]));
    const mixRows = d.tiers.map((x) => {
      const fullPct = (x.revenue / maxTier) * 100;
      const wPct = (x.weighted / maxTier) * 100;
      const barBg = x.feeds_budget ? 'rgba(31,138,76,.18)' : 'var(--r57)';
      const solid = x.feeds_budget
        ? '<div style="width:' + wPct + '%;background:var(--r' + (x.rating === 1 ? '1' : x.rating === 2 ? '2' : '34') + ')"></div>'
        : '';
      const tip = x.feeds_budget
        ? 'R' + x.rating + ' ' + x.label + ': full ' + d.year + ' value ' + fm(x.revenue) + ' (hatched = not yet firm) · risk-weighted ' + fm(x.weighted) + ' (solid)'
        : 'R' + x.rating + ' ' + x.label + ': ' + fm(x.revenue) + ' - excluded from budget and weighting';
      return '<tr><td><b>R' + x.rating + '</b></td><td>' + esc(x.label) + '</td>' +
        '<td class="num">' + x.projects + '</td><td class="num">' + fm(x.revenue) + '</td>' +
        '<td class="num">' + (x.feeds_budget ? fm(x.weighted) : 'excluded') + '</td>' +
        '<td>' + (x.feeds_budget ? 'Yes' : 'No') + '</td>' +
        '<td style="width:34%"><div class="barwrap" title="' + esc(tip) + '">' +
        '<div class="hatch" style="width:' + fullPct + '%;background:' + barBg + '"></div>' + solid +
        '</div></td></tr>';
    }).join('');
    const mixPanel = panel('Likelihood rating mix 1-7', { kind: 'live', text: 'LIVE' }, esc(d.mixMsg),
      'What it is: how many projects and how much revenue sit at each confidence rating (1 = booked … 7 = dead), with a flag for which ratings feed the budget. Why we show it: it shows the quality of the pipeline - a lot of revenue sitting in low ratings means more risk. Solid = risk-weighted (counted) · hatched = full ' + d.year + ' value, not yet firm · grey hatched = R5-7, excluded from budget.',
      '<table class="vtable"><thead><tr><th>Rating</th><th>Meaning</th><th class="num">Projects</th><th class="num">Revenue</th><th class="num">Risk-weighted</th><th>Feeds budget?</th><th style="width:34%">Full value vs weighted</th></tr></thead><tbody>' + mixRows +
      '<tr class="total"><td colspan="2">All ratings</td><td class="num">' + d.tiers.reduce((a, x) => a + x.projects, 0) + '</td><td class="num">' + fm(d.total) + '</td><td class="num">' + fm(d.weighted) + '</td><td colspan="2"></td></tr>' +
      '</tbody></table>');

    // Leader split
    const LCOLOURS = ['#238291', '#097CE8', '#3AA95C', '#EF6B00', '#83007E', '#c7ced6'];
    const maxLeader = Math.max.apply(null, p.leaderRows.map((r) => r.total).concat([1]));
    const leaderBars = p.leaderRows.map((row) => {
      const width = (row.total / maxLeader) * 100;
      let acc = 0;
      const segs = row.segs.map((s, i) => {
        const w = row.total > 0 ? (s.value / row.total) * 100 : 0;
        const seg = '<div title="' + esc(s.name + ': ' + fm(s.value)) + '" style="position:absolute;top:0;bottom:0;left:' + acc + '%;width:' + w + '%;background:' + (s.name === 'Other' ? LCOLOURS[5] : LCOLOURS[i % 5]) + '"></div>';
        acc += w;
        return seg;
      }).join('');
      return '<div style="display:grid;grid-template-columns:140px 1fr 90px;gap:10px;align-items:center;margin:7px 0">' +
        '<div style="font-size:12px"><b>R' + row.rating + '</b> ' + esc(row.label) + '</div>' +
        '<div style="position:relative;height:18px;border:1px solid var(--hairline);background:#fff"><div style="position:relative;height:100%;width:' + width + '%">' + segs + '</div></div>' +
        '<div class="num" style="font-size:12.5px;font-weight:700;text-align:right">' + fm(row.total) + '</div></div>';
    }).join('');
    const leaderLegend = '<div class="cap">Top 5 leaders coloured per tier, rest grouped as Other. Hover any segment for the leader and value.</div>';
    const leaderPanel = panel('Revenue by rating, split by leader', { kind: 'live', text: 'LIVE' }, '',
      'What it is: inside each likelihood tier, which revenue leaders own the revenue (top 5 coloured, the rest grouped as Other). Why we show it: it shows who is carrying firm revenue versus speculative revenue.',
      leaderBars + leaderLegend);

    // Top 10 clients
    const clientRow = (r) => {
      const vsBudget = r.budget === null || r.budget === 0 ? null : r.projected - r.budget;
      return '<tr><td>' + esc(r.name) + '</td>' +
        '<td class="num">' + fm(r.r1) + '</td><td class="num">' + fm(r.r2) + '</td><td class="num">' + fm(r.r34) + '</td>' +
        '<td class="num"><b>' + fm(r.projected) + '</b></td>' +
        '<td class="num" style="color:var(--mut);background:rgba(37,39,58,.04)">' + fm(r.longShots) + '</td>' +
        '<td class="num">' + (r.budget === null || r.budget === 0 ? '-' : fm(r.budget)) + '</td>' +
        '<td class="num">' + (vsBudget === null
          ? (r.projected > 0 ? '<span class="tone-good">+' + fm(r.projected) + ' incremental</span>' : '-')
          : arrowCell(vsBudget)) + '</td></tr>';
    };
    const tc = p.topClients;
    const topPanel = panel('Top 10 clients by projected revenue', { kind: 'live', text: 'LIVE' }, esc(p.topMsg),
      'What it is: the top 10 clients ranked by projected revenue (ratings 1-4, the money that counts toward budget), split across the likelihood tiers, totalled, and compared to each client\'s annual budget line. Long-shot revenue (ratings 5-7) sits in its own grey column - visible, but kept out of every number we count. Why we show it: to see who is ahead of or behind plan - and clients that were not in the October budget show their full projected as positive incremental.',
      '<table class="vtable"><thead><tr><th>Client</th><th class="num">Booked (R1)</th><th class="num">90% (R2)</th><th class="num">Likely (R3-4)</th><th class="num">Projected (1-4)</th><th class="num" style="color:var(--mut)">Long shots (R5-7)</th><th class="num">Oct budget</th><th class="num">vs budget</th></tr></thead><tbody>' +
      tc.rows.map(clientRow).join('') + clientRow(tc.other) +
      '<tr class="total"><td>' + esc(tc.total.name) + '</td><td class="num">' + fm(tc.total.r1) + '</td><td class="num">' + fm(tc.total.r2) + '</td><td class="num">' + fm(tc.total.r34) + '</td><td class="num">' + fm(tc.total.projected) + '</td><td class="num" style="color:var(--mut)">' + fm(tc.total.longShots) + '</td><td class="num">' + fm(tc.total.budget || 0) + '</td><td></td></tr>' +
      '</tbody></table>');

    // Monthly tracking (toggle: cumulative | run-rate)
    const monthlyPanel = panel('Booked and projected, tracking to budget by month', { kind: 'live', text: 'LIVE' }, esc(p.monthly.msg),
      'What it is: two ways to watch the year unfold against budget. Cumulative to budget shows booked and projected revenue climbing toward the annual budget line. Monthly run-rate shows each month by rating against a flat budget line (' + fm(p.monthly.flat) + '/mo) plus a revised target (red): the flat budget lifted by the cumulative over/under to date, so a bar reaching the red line means we are fully caught up. Each bar prints its total and a star shows the month\'s over/under vs budget. Why we show it: to answer "how far behind or ahead are we cumulatively, and what would it take to get whole?"',
      '<div class="tabbar" style="border-bottom:1px solid var(--hairline);margin:6px 0"><button id="mv-cum" class="on">Cumulative to budget</button><button id="mv-run">Monthly run-rate</button></div>' +
      '<div id="mv-host">' + cumulativeChart(p.monthly, d.budget, p.monthly.todayMonth) + '</div>' +
      monthlyTable(p.monthly));

    // Vintages
    const vintagePanel = p.vintages.length
      ? panel('Full year projection by revenue projection month', { kind: 'live', text: 'LIVE' }, '',
        'What it is: the full-year revenue figure as it stood at each frozen snapshot, split R1-R4, so you can watch revenue solidify up the chain as deals convert.',
        vintageChart(p.vintages, d.budget))
      : panel('Full year projection by revenue projection month', { kind: 'demo', text: 'AWAITING HISTORY' }, '',
        'What it is: the full-year figure as it stood at each frozen monthly snapshot, split R1 (booked) through R4, so drift AND quality show together. The frozen history lives in monthly snapshots; none are in the shared data files yet, so this panel starts filling in from the next freeze. Nothing here is simulated.',
        '<div class="note">No frozen snapshots in the data files yet. The panel populates itself from the first monthly freeze onward.</div>');

    // Staleness
    const bands = p.stale.bands;
    const bandTotal = Math.max(bands.green + bands.amber + bands.red, 1);
    const bandStrip = '<div style="display:flex;height:26px;width:100%;border:1px solid var(--hairline);margin:4px 0 10px">' +
      [['0-30 on track', bands.green, bands.greenV, '#1f8a4c'], ['30-90 ageing', bands.amber, bands.amberV, '#8a6a09'], ['90+ stale', bands.red, bands.redV, '#b3151b']]
        .filter((b) => b[1] > 0)
        .map((b) => '<div style="width:' + ((b[1] / bandTotal) * 100) + '%;min-width:60px;background:' + b[3] + ';color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center">' + b[0] + ': ' + b[1] + ' · ' + fm(b[2]) + '</div>').join('') +
      '</div>';
    const staleRows = p.stale.rows.map((r) =>
      '<tr><td>' + esc(r.name) + '</td><td>' + esc(r.client) + '</td><td class="num">R' + r.rating + '</td>' +
      '<td class="num">' + fm(r.value) + '</td>' +
      '<td class="num">' + (r.days === null ? '<span style="color:var(--mut)">awaiting history</span>'
        : '<span class="' + (r.days >= 90 ? 'tone-bad' : r.days >= 30 ? 'tone-amber' : 'tone-good') + '">' + r.days + '</span>') + '</td></tr>').join('');
    const stalePanel = panel('Pipeline staleness - how long since a deal last moved', { kind: 'live', text: 'LIVE' }, esc(p.stale.msg),
      'What it is: for each not-yet-booked deal (R2-R4), the time since its rating or value last changed - graded 0-30 on track, 30-90 ageing, 90+ stale. Why we show it: deals only convert if they are actively worked, so a long stretch with no movement is an automatic nudge that a deal is stalling. Booked (R1) is set aside (it is won, not pipeline). Showing the 15 stalest; the change history began accruing ' + esc(p.stale.started) + '.',
      bandStrip +
      '<table class="vtable"><thead><tr><th>Project (stalest first)</th><th>Client</th><th class="num">Rating</th><th class="num">' + d.year + ' value</th><th class="num">Days since last move</th></tr></thead><tbody>' + staleRows + '</tbody></table>');

    return kpis + bridgePanel + mixPanel + leaderPanel + topPanel + monthlyPanel + vintagePanel + stalePanel;
  }

  function kpi(label, value, sub, tone) {
    return '<div class="kpi ' + (tone || '') + '"><div class="lbl">' + esc(label) + '</div><div class="val">' + esc(value) + '</div><div class="sub">' + esc(sub) + '</div></div>';
  }

  /* ---------------- charts (SVG strings; every value printed) ---------------- */
  function bridgeChart(booked, r2, r34, projected, weighted, budget) {
    const W = 940, H = 210, L = 10, R = 10, T = 26, B = 34;
    const plotW = W - L - R, plotH = H - T - B;
    const maxV = Math.max(projected, budget, weighted) * 1.08;
    const y = (v) => T + plotH - (v / maxV) * plotH;
    const cols = 6, cw = plotW / cols, bw = cw * 0.62;
    const cx = (i) => L + i * cw + (cw - bw) / 2;
    const seg = (i, from, to, colour, label, tip) =>
      '<rect x="' + cx(i) + '" y="' + y(to) + '" width="' + bw + '" height="' + Math.max(y(from) - y(to), 1) + '" fill="' + colour + '"><title>' + esc(tip) + '</title></rect>' +
      '<text x="' + (cx(i) + bw / 2) + '" y="' + (y(to) - 5) + '" text-anchor="middle" font-size="11" font-weight="700" fill="#25273A">' + esc(label) + '</text>';
    const xlbl = (i, txt) => '<text x="' + (cx(i) + bw / 2) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10.5" fill="#5f6a78">' + esc(txt) + '</text>';
    const gap = projected - budget;
    const gapColour = gap >= 0 ? 'var(--good)' : 'var(--bad)';
    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Budget bridge">';
    s += seg(0, 0, booked, 'var(--r1)', fm(booked), 'Booked (R1): ' + fm(booked));
    s += seg(1, booked, booked + r2, 'var(--r2)', fm(r2), '90% accrued (R2): +' + fm(r2));
    s += seg(2, booked + r2, projected, 'var(--r34)', fm(r34), 'Likely (R3-4): +' + fm(r34));
    s += seg(3, 0, projected, '#16263b', fm(projected), 'Projected (1-4), face value: ' + fm(projected));
    s += seg(4, 0, weighted, '#5b7d92', fm(weighted), 'Risk-weighted EV: ' + fm(weighted));
    s += seg(5, 0, budget, '#9aa6b2', fm(budget), 'Frozen annual budget: ' + fm(budget));
    // connectors
    const conn = (i, v) => '<line x1="' + (cx(i) + bw) + '" y1="' + y(v) + '" x2="' + cx(i + 1) + '" y2="' + y(v) + '" stroke="#9aa6b2" stroke-dasharray="3 3"/>';
    s += conn(0, booked) + conn(1, booked + r2) + conn(2, projected);
    // gap block between projected and budget
    s += '<rect x="' + (cx(5) - cw * 0.16) + '" y="' + y(Math.max(projected, budget)) + '" width="6" height="' + Math.abs(y(budget) - y(projected)) + '" fill="' + gapColour + '"><title>Gap to budget: ' + (gap >= 0 ? '+' : '') + fm(gap) + '</title></rect>';
    s += '<line x1="' + L + '" y1="' + y(budget) + '" x2="' + (W - R) + '" y2="' + y(budget) + '" stroke="#16263b" stroke-width="1.4" stroke-dasharray="6 4"/>';
    s += '<text x="' + (W - R) + '" y="' + (y(budget) - 5) + '" text-anchor="end" font-size="10.5" font-weight="700" fill="#16263b">Budget ' + fm(budget) + '</text>';
    s += xlbl(0, 'Booked R1') + xlbl(1, '+ R2') + xlbl(2, '+ R3-4') + xlbl(3, 'Projected') + xlbl(4, 'Risk-weighted') + xlbl(5, 'Budget');
    s += '</svg>';
    return s;
  }

  function cumulativeChart(monthly, budget, todayMonth) {
    const rows = monthly.rows;
    const W = 940, H = 230, L = 58, R = 16, T = 14, B = 30;
    const plotW = W - L - R, plotH = H - T - B;
    let cum = 0;
    const cums = rows.map((r) => (cum += r.total));
    const maxV = Math.max(budget, cums[11] || 0) * 1.06;
    const x = (m) => L + ((m - 0.5) / 12) * plotW;
    const y = (v) => T + plotH - (v / maxV) * plotH;
    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Cumulative to budget">';
    for (let g = 0; g <= 4; g++) {
      const gv = (maxV * g) / 4;
      s += '<line x1="' + L + '" y1="' + y(gv) + '" x2="' + (W - R) + '" y2="' + y(gv) + '" stroke="rgba(37,39,58,.10)"/>';
      s += '<text x="' + (L - 6) + '" y="' + (y(gv) + 3.5) + '" text-anchor="end" font-size="10" fill="#5f6a78">' + fm(gv) + '</text>';
    }
    s += '<line x1="' + L + '" y1="' + y(budget) + '" x2="' + (W - R) + '" y2="' + y(budget) + '" stroke="#16263b" stroke-width="1.6" stroke-dasharray="6 4"/>';
    s += '<text x="' + (W - R) + '" y="' + (y(budget) - 5) + '" text-anchor="end" font-size="10.5" font-weight="700" fill="#16263b">Annual budget ' + fm(budget) + '</text>';
    if (todayMonth >= 1 && todayMonth <= 12) {
      s += '<line x1="' + x(todayMonth) + '" y1="' + T + '" x2="' + x(todayMonth) + '" y2="' + (T + plotH) + '" stroke="#8a6a09" stroke-dasharray="2 3"/>';
      s += '<text x="' + (x(todayMonth) + 4) + '" y="' + (T + 10) + '" font-size="9.5" fill="#8a6a09">today</text>';
    }
    let path = '';
    rows.forEach((r, i) => { path += (i === 0 ? 'M' : 'L') + x(i + 1) + ' ' + y(cums[i]) + ' '; });
    s += '<path d="' + path + '" fill="none" stroke="#238291" stroke-width="2.2"/>';
    rows.forEach((r, i) => {
      s += '<circle cx="' + x(i + 1) + '" cy="' + y(cums[i]) + '" r="3.4" fill="#fff" stroke="#238291" stroke-width="2"><title>' + MON[i] + ': cumulative ' + fm(cums[i]) + ' (month ' + fm(r.total) + ')</title></circle>';
      if (i % 2 === 1 || i === 11) s += '<text x="' + x(i + 1) + '" y="' + (y(cums[i]) - 8) + '" text-anchor="middle" font-size="9.5" font-weight="700" fill="#1d6d7a">' + fm(cums[i]) + '</text>';
      s += '<text x="' + x(i + 1) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10" fill="#5f6a78">' + MON[i] + '</text>';
    });
    s += '</svg>';
    return s;
  }

  function runRateChart(monthly) {
    const rows = monthly.rows;
    const W = 940, H = 250, L = 58, R = 16, T = 20, B = 30;
    const plotW = W - L - R, plotH = H - T - B;
    const maxV = Math.max.apply(null, rows.map((r) => Math.max(r.total, r.revised, r.flat))) * 1.15;
    const y = (v) => T + plotH - (Math.max(v, 0) / maxV) * plotH;
    const bw = (plotW / 12) * 0.56;
    const x = (m) => L + ((m - 0.5) / 12) * (plotW) - bw / 2;
    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Monthly run-rate">';
    for (let g = 0; g <= 4; g++) {
      const gv = (maxV * g) / 4;
      s += '<line x1="' + L + '" y1="' + y(gv) + '" x2="' + (W - R) + '" y2="' + y(gv) + '" stroke="rgba(37,39,58,.10)"/>';
      s += '<text x="' + (L - 6) + '" y="' + (y(gv) + 3.5) + '" text-anchor="end" font-size="10" fill="#5f6a78">' + fm(gv) + '</text>';
    }
    rows.forEach((r, i) => {
      const bx = x(i + 1);
      let base = 0;
      [['r1', 'var(--r1)', 'R1 booked'], ['r2', 'var(--r2)', 'R2 90%'], ['r34', 'var(--r34)', 'R3-4 likely']].forEach(([k, colour, lbl]) => {
        const v = r[k];
        if (v <= 0) return;
        s += '<rect x="' + bx + '" y="' + y(base + v) + '" width="' + bw + '" height="' + Math.max(y(base) - y(base + v), 0.5) + '" fill="' + colour + '"><title>' + MON[i] + ' ' + lbl + ': ' + fm(v) + ' (' + (r.total > 0 ? Math.round((v / r.total) * 100) : 0) + '% of the month)</title></rect>';
        base += v;
      });
      if (r.total > 0) s += '<text x="' + (bx + bw / 2) + '" y="' + (y(r.total) - 4) + '" text-anchor="middle" font-size="9.5" font-weight="700" fill="#25273A">' + fm(r.total) + '</text>';
      const star = r.variance >= 0 ? '#1f8a4c' : '#b3151b';
      s += '<text x="' + (bx + bw / 2) + '" y="' + (H - 20) + '" text-anchor="middle" font-size="9" fill="' + star + '">★ ' + (r.variance >= 0 ? '+' : '') + fm(r.variance) + '</text>';
      s += '<text x="' + (bx + bw / 2) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="#5f6a78">' + MON[i] + '</text>';
    });
    // flat budget line + revised target line
    const lineAt = (get, colour, width, dash) => {
      let path = '';
      rows.forEach((r, i) => {
        const px = x(i + 1) + bw / 2;
        path += (i === 0 ? 'M' : 'L') + px + ' ' + y(get(r)) + ' ';
      });
      return '<path d="' + path + '" fill="none" stroke="' + colour + '" stroke-width="' + width + '"' + (dash ? ' stroke-dasharray="' + dash + '"' : '') + '/>';
    };
    s += lineAt((r) => r.flat, '#16263b', 1.6, '6 4');
    s += lineAt((r) => r.revised, '#C0392B', 1.8, '');
    s += '<text x="' + (W - R) + '" y="' + (y(rows[11].flat) - 4) + '" text-anchor="end" font-size="9.5" fill="#16263b">flat ' + fm(rows[0].flat) + '/mo</text>';
    s += '<text x="' + (W - R) + '" y="' + (y(rows[11].revised) + 11) + '" text-anchor="end" font-size="9.5" fill="#C0392B">revised target</text>';
    s += '</svg>';
    return s;
  }

  function monthlyTable(monthly) {
    const rows = monthly.rows.map((r, i) =>
      '<tr><td>' + MON[i] + '</td><td class="num">' + fm(r.r1) + '</td><td class="num">' + fm(r.r2) + '</td><td class="num">' + fm(r.r34) + '</td>' +
      '<td class="num"><b>' + fm(r.total) + '</b></td><td class="num">' + fm(r.flat) + '</td>' +
      '<td class="num ' + (r.variance >= 0 ? 'tone-good' : 'tone-bad') + '">' + (r.variance >= 0 ? '+' : '') + fm(r.variance) + '</td>' +
      '<td class="num ' + (r.cumVsBudget >= 0 ? 'tone-good' : 'tone-bad') + '">' + (r.cumVsBudget >= 0 ? '+' : '') + fm(r.cumVsBudget) + '</td></tr>').join('');
    return '<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:var(--mut)">Backing table: month by month against the flat budget</summary>' +
      '<table class="vtable"><thead><tr><th>Month</th><th class="num">R1</th><th class="num">R2</th><th class="num">R3-4</th><th class="num">Total</th><th class="num">Flat budget</th><th class="num">Variance vs flat</th><th class="num">Cumulative vs budget</th></tr></thead><tbody>' + rows + '</tbody></table></details>';
  }

  function vintageChart(vintages, budget) {
    const W = 940, H = 230, L = 58, R = 16, T = 16, B = 30;
    const plotW = W - L - R, plotH = H - T - B;
    const maxV = Math.max.apply(null, vintages.map((v) => v.total).concat([budget])) * 1.08;
    const y = (v) => T + plotH - (v / maxV) * plotH;
    const n = vintages.length;
    const cw = plotW / Math.max(n, 1), bw = Math.min(cw * 0.5, 70);
    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Full year projection by vintage">';
    s += '<line x1="' + L + '" y1="' + y(budget) + '" x2="' + (W - R) + '" y2="' + y(budget) + '" stroke="#16263b" stroke-width="1.4" stroke-dasharray="6 4"/>';
    s += '<text x="' + (W - R) + '" y="' + (y(budget) - 5) + '" text-anchor="end" font-size="10" font-weight="700" fill="#16263b">Budget ' + fm(budget) + '</text>';
    vintages.forEach((v, i) => {
      const bx = L + i * cw + (cw - bw) / 2;
      let base = 0;
      [['r1', 'var(--r1)'], ['r2', 'var(--r2)'], ['r3', 'var(--r34)'], ['r4', '#b7dcae']].forEach(([k, colour]) => {
        const val = v[k];
        if (val <= 0) return;
        s += '<rect x="' + bx + '" y="' + y(base + val) + '" width="' + bw + '" height="' + Math.max(y(base) - y(base + val), 0.5) + '" fill="' + colour + '"><title>' + esc(v.label) + ' ' + k.toUpperCase() + ': ' + fm(val) + '</title></rect>';
        base += val;
      });
      s += '<text x="' + (bx + bw / 2) + '" y="' + (y(v.total) - 5) + '" text-anchor="middle" font-size="10" font-weight="700" fill="#25273A">' + fm(v.total) + '</text>';
      s += '<text x="' + (bx + bw / 2) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10" fill="#5f6a78">' + esc(v.label) + '</text>';
    });
    s += '</svg>';
    return s;
  }

  /* ---------------- TAB 2 · Leaders ---------------- */
  function tabLeaders() {
    const d = tab2();
    const kpis = '<div class="kpirow">' +
      kpi(d.year + ' revenue (all ratings)', fm(d.kpis.revenue), 'every project with ' + d.year + ' revenue', 'teal') +
      kpi('Booked (R1)', fm(d.kpis.booked), 'firm revenue', '') +
      kpi('Projects', String(d.kpis.projects), 'whole snapshot', '') +
      kpi('Revenue leaders', String(d.kpis.leaders), 'with ' + d.year + ' revenue', '') +
      kpi('Clients', String(d.kpis.clients), 'with positive revenue', 'navy') +
      '</div>';

    const maxRev = Math.max.apply(null, d.books.map((b) => b.revenue).concat([1]));
    const bookRows = d.books.map((b) => {
      const w = Math.max((b.revenue / maxRev) * 100, 0);
      const bw2 = b.revenue > 0 ? Math.max((b.booked / maxRev) * 100, 0) : 0;
      const clientTip = b.clients.slice(0, 5).map((c) => c.name + ': ' + fm(c.revenue)).join(' · ');
      const aging = b.aging.amber + b.aging.red > 0
        ? '<span class="tone-amber">' + (b.aging.amber + b.aging.red) + ' ageing · ' + fm(b.aging.amberRedValue) + '</span>'
        : '<span class="tone-good">on track</span>';
      return '<div style="display:grid;grid-template-columns:150px 1fr 110px 150px;gap:10px;align-items:center;margin:6px 0" title="' + esc(clientTip) + '">' +
        '<div style="font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(b.name) + '</div>' +
        '<div style="position:relative;height:16px;border:1px solid var(--hairline);background:#fff">' +
        '<div class="hatch" style="position:absolute;top:0;bottom:0;left:0;width:' + w + '%;background:rgba(31,138,76,.15)"></div>' +
        '<div style="position:absolute;top:0;bottom:0;left:0;width:' + bw2 + '%;background:var(--r1)"></div></div>' +
        '<div class="num" style="font-size:12px;font-weight:700;text-align:right">' + fm(b.revenue) + '</div>' +
        '<div style="font-size:11px;text-align:right">' + aging + '</div></div>';
    }).join('');
    const scorecard = panel('Consolidated leader scorecard', { kind: 'live', text: 'LIVE' }, esc(d.scorecardMsg),
      'What it is: each revenue leader\'s ' + d.year + ' book - solid green is booked (R1), hatched is the full all-ratings book, with their open-pipeline ageing state on the right. Hover a row for the leader\'s top clients. Why we show it: it shows who is carrying firm revenue versus speculative revenue, and whose open deals are going quiet.',
      bookRows);

    const groupTable = (rows, label) =>
      '<table class="vtable"><thead><tr><th>' + label + '</th><th class="num">Revenue</th><th class="num">Booked (R1)</th><th class="num">Projects</th></tr></thead><tbody>' +
      rows.map((g) => '<tr><td>' + esc(g.key) + '</td><td class="num">' + fm(g.revenue) + '</td><td class="num">' + fm(g.booked) + '</td><td class="num">' + g.projects + '</td></tr>').join('') +
      '</tbody></table>';
    const industryPanel = panel('Revenue by industry', { kind: 'demo', text: 'DEMO CLASSIFICATION' }, '',
      'Industry tags exist on only a handful of source records, so this grouping runs on the app-side demo map until the intake fields land. The dollars are real; the classification is illustrative.',
      groupTable(d.byIndustry, 'Industry'));
    const typePanel = panel('Revenue by project type', { kind: 'demo', text: 'DEMO CLASSIFICATION' }, '',
      'Same basis as the industry panel: real dollars, demo classification until tagged at intake.',
      groupTable(d.byType, 'Project type'));

    const rf = d.baselines.map((b) => {
      const filled = b.total != null;
      return '<div style="text-align:center;flex:1">' +
        '<div style="width:16px;height:16px;border-radius:50%;margin:0 auto 6px;border:2px solid ' + (filled ? 'var(--teal)' : 'var(--mut)') + ';background:' + (filled ? 'var(--teal)' : '#fff') + '"></div>' +
        '<div style="font-size:11px;font-weight:700">' + esc(b.name) + '</div>' +
        '<div style="font-size:12px" class="' + (filled ? '' : 'tone-neutral') + '">' + (filled ? fm(b.total) : 'awaited') + '</div></div>';
    }).join('');
    const rfPanel = panel('Budget and reforecast timeline', { kind: 'live', text: 'LIVE' }, '',
      'What it is: the frozen annual budget and the reforecast milestones as they are submitted through the year. Open circles are milestones not yet submitted. Why we show it: the projection is always read against a named baseline, never a moving one.',
      '<div style="display:flex;align-items:flex-start;gap:8px;padding:12px 4px;border-top:2px solid var(--hairline)">' + rf + '</div>');

    const agingPanel = panel('Deal ageing by leader', { kind: 'live', text: 'LIVE' }, esc(d.agingMsg),
      'What it is: each leader\'s open R2-R4 deals graded by time since the last material move (rating, roster, phases, timing, fee terms). Why we show it: stalling deals surface to their owner automatically instead of waiting to be chased.',
      '<table class="vtable"><thead><tr><th>Leader</th><th class="num">0-30 on track</th><th class="num">30-90 ageing</th><th class="num">90+ stale</th><th class="num">Value ageing 30+</th></tr></thead><tbody>' +
      d.books.filter((b) => b.aging.green + b.aging.amber + b.aging.red > 0).map((b) =>
        '<tr><td>' + esc(b.name) + '</td><td class="num tone-good">' + b.aging.green + '</td>' +
        '<td class="num' + (b.aging.amber ? ' tone-amber' : '') + '">' + b.aging.amber + '</td>' +
        '<td class="num' + (b.aging.red ? ' tone-bad' : '') + '">' + b.aging.red + '</td>' +
        '<td class="num">' + fm(b.aging.amberRedValue) + '</td></tr>').join('') +
      '</tbody></table>');

    const pending = panel('Staff-cost planner and margin quadrant', { kind: 'demo', text: 'PORT IN PROGRESS' }, '',
      'The manual staff-cost grid and the margin quadrant from the Part 2 app land in this branch before review. Nothing else on this tab depends on them.', '');

    return kpis + scorecard + agingPanel + rfPanel + industryPanel + typePanel + pending;
  }

  /* ---------------- TAB 3 · Clients ---------------- */
  const SECTOR_COLOURS = {
    'Banking & Capital Markets': '#1d4ed8', 'Insurance': '#0891b2', 'Asset & Wealth Management': '#0d9488',
    'Legal': '#7c3aed', 'Professional Services & Consulting': '#c026d3', 'Technology & Software': '#2563eb',
    'Telecommunications': '#0ea5e9', 'Media & Entertainment': '#db2777', 'Aerospace & Defense': '#475569',
    'Travel & Transportation': '#f59e0b', 'Energy & Utilities': '#ca8a04', 'Healthcare & Life Sciences': '#16a34a',
    'Consumer & Retail': '#ea580c', 'Real Estate': '#9a3412', 'Public Sector & Education': '#4f46e5',
    'Nonprofit & Associations': '#65a30d', 'Unclassified': '#9ca3af', 'Other': '#9ca3af', 'Excluded': '#d1d5db',
  };
  const sectorColour = (s) => SECTOR_COLOURS[s] || '#9ca3af';

  function tabClients() {
    const d = tab3();
    const kpis = '<div class="kpirow">' +
      kpi('Top client', d.kpis.topClientPct + '%', esc(d.kpis.topClientName), 'navy') +
      kpi('Top 5 share', d.kpis.top5Pct + '%', 'of all-ratings revenue', '') +
      kpi('Concentration (HHI)', String(d.kpis.hhi), d.kpis.hhi < 1500 ? 'low' : d.kpis.hhi < 2500 ? 'moderate' : 'high', '') +
      kpi('Clients', String(d.kpis.clients), 'with positive ' + d.year + ' revenue', '') +
      kpi(d.year + ' revenue (all ratings)', fm(d.kpis.revenue), 'imported monthly grain', 'teal') +
      '</div>';

    const maxP = Math.max.apply(null, d.pareto.map((r) => r.revenue).concat([1]));
    const paretoRows = d.pareto.map((r) =>
      '<div style="display:grid;grid-template-columns:170px 1fr 90px 70px;gap:10px;align-items:center;margin:5px 0">' +
      '<div style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(r.name) + '">' + esc(r.name) + '</div>' +
      '<div style="position:relative;height:14px;border:1px solid var(--hairline)"><div style="position:absolute;inset:0;width:' + ((r.revenue / maxP) * 100) + '%;background:var(--teal)"></div></div>' +
      '<div class="num" style="font-size:12px;font-weight:700;text-align:right">' + fm(r.revenue) + '</div>' +
      '<div class="num" style="font-size:11px;color:var(--mut);text-align:right" title="cumulative share of revenue">' + Math.round(r.cumShare * 100) + '% cum</div></div>').join('');
    const paretoPanel = panel('Client concentration - top 10', { kind: 'live', text: 'LIVE' }, esc(d.paretoMsg),
      'What it is: the ten largest clients by ' + d.year + ' revenue (all ratings), each with its running cumulative share of the book. Why we show it: concentration is the standing leadership question, and the cumulative column answers "how few clients is the year really standing on".',
      paretoRows);

    // Sector donut
    let angle = -Math.PI / 2;
    const cx = 105, cy = 105, R = 88, r0 = 52;
    const slices = d.donut.map((s) => {
      const sweep = s.share * 2 * Math.PI;
      const a0 = angle, a1 = angle + sweep;
      angle = a1;
      const big = sweep > Math.PI ? 1 : 0;
      const p = (a, rad) => (cx + rad * Math.cos(a)).toFixed(2) + ' ' + (cy + rad * Math.sin(a)).toFixed(2);
      return '<path d="M ' + p(a0, R) + ' A ' + R + ' ' + R + ' 0 ' + big + ' 1 ' + p(a1, R) + ' L ' + p(a1, r0) + ' A ' + r0 + ' ' + r0 + ' 0 ' + big + ' 0 ' + p(a0, r0) + ' Z" fill="' + sectorColour(s.sector) + '"><title>' + esc(s.sector + ': ' + fm(s.revenue) + ' (' + Math.round(s.share * 100) + '%) · ' + (s.topClients.length ? 'top: ' + s.topClients.join(', ') : '')) + '</title></path>';
    }).join('');
    const legend = d.donut.slice(0, 8).map((s) =>
      '<div style="display:flex;gap:8px;align-items:center;font-size:11.5px;padding:2px 0">' +
      '<span style="width:10px;height:10px;background:' + sectorColour(s.sector) + ';flex:none"></span>' +
      '<span style="flex:1">' + esc(s.sector) + '</span>' +
      '<span style="color:var(--mut)">' + Math.round(s.share * 100) + '%</span>' +
      '<span style="font-weight:700;min-width:70px;text-align:right">' + fm(s.revenue) + '</span></div>').join('');
    const donutPanel = panel('Revenue by sector', { kind: 'demo', text: 'SEEDED CLASSIFICATION' }, esc(d.sectorMsg),
      'What it is: ' + d.year + ' revenue by client sector. The classification is the app-side seed map (keyword based); the curated corrections made in the database app\'s Client Admin are not in the shared files, so treat slices as directional. Hover a slice for its top clients.',
      '<div style="display:grid;grid-template-columns:220px 1fr;gap:20px;align-items:center">' +
      '<svg viewBox="0 0 210 210" width="210" role="img" aria-label="Revenue by sector">' + slices + '</svg>' +
      '<div>' + legend + '</div></div>');

    // Sector by month stack
    const stackSectors = d.topSectors.concat(d.sectorMonths.some((x) => x.sector === 'Other') ? ['Other'] : []);
    const byMonthSector = new Map();
    for (const x of d.sectorMonths) byMonthSector.set(x.sector + '|' + x.month, x.revenue);
    const maxMonth = Math.max.apply(null, d.monthTotals.concat([1]));
    const W = 940, H = 220, L = 58, Rr = 16, T = 16, B = 30;
    const plotW = W - L - Rr, plotH = H - T - B;
    const y = (v) => T + plotH - (v / (maxMonth * 1.12)) * plotH;
    const bw = (plotW / 12) * 0.58;
    let stack = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Sector by month">';
    for (let g = 0; g <= 4; g++) {
      const gv = (maxMonth * 1.12 * g) / 4;
      stack += '<line x1="' + L + '" y1="' + y(gv) + '" x2="' + (W - Rr) + '" y2="' + y(gv) + '" stroke="rgba(37,39,58,.10)"/>' +
        '<text x="' + (L - 6) + '" y="' + (y(gv) + 3.5) + '" text-anchor="end" font-size="10" fill="#5f6a78">' + fm(gv) + '</text>';
    }
    for (let mth = 1; mth <= 12; mth++) {
      const bx = L + ((mth - 0.5) / 12) * plotW - bw / 2;
      let base = 0;
      for (const s of stackSectors) {
        const v = byMonthSector.get(s + '|' + mth) || 0;
        if (v <= 0) continue;
        const isPast = mth <= d.lastActual;
        stack += '<rect x="' + bx + '" y="' + y(base + v) + '" width="' + bw + '" height="' + Math.max(y(base) - y(base + v), 0.5) + '" fill="' + sectorColour(s) + '"' + (isPast ? '' : ' opacity="0.55"') + '><title>' + esc(MON[mth - 1] + ' ' + s + ': ' + fm(v) + ' (' + (d.monthTotals[mth - 1] > 0 ? Math.round((v / d.monthTotals[mth - 1]) * 100) : 0) + '% of month)') + '</title></rect>';
        base += v;
      }
      if (d.monthTotals[mth - 1] > 0) stack += '<text x="' + (bx + bw / 2) + '" y="' + (y(d.monthTotals[mth - 1]) - 4) + '" text-anchor="middle" font-size="9" font-weight="700" fill="#25273A">' + fm(d.monthTotals[mth - 1]) + '</text>';
      stack += '<text x="' + (bx + bw / 2) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="#5f6a78">' + MON[mth - 1] + '</text>';
    }
    stack += '</svg>';
    const stackPanel = panel('Sector mix, month by month', { kind: 'demo', text: 'SEEDED CLASSIFICATION' }, '',
      'What it is: each month\'s revenue stacked by sector (top six sectors, rest folded into Other). Months after ' + MON[d.lastActual - 1] + ' render lighter - they are projection, not yet firm. Hover a segment for its share of the month.',
      stack);

    // Movers
    const moverTable = (rows, label) =>
      '<div><div style="font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin:4px 0">' + label + '</div>' +
      '<table class="vtable"><thead><tr><th>Client</th><th class="num">' + esc(d.movers.prevMonth) + '</th><th class="num">' + esc(d.movers.month) + '</th><th class="num">Change</th></tr></thead><tbody>' +
      rows.map((r) => '<tr><td>' + esc(r.name) + '</td><td class="num">' + fm(r.prev) + '</td><td class="num">' + fm(r.cur) + '</td>' +
        '<td class="num ' + (r.delta >= 0 ? 'tone-good' : 'tone-bad') + '">' + (r.delta >= 0 ? '+' : '-') + fm(Math.abs(r.delta)) + '</td></tr>').join('') +
      '</tbody></table></div>';
    const moversPanel = panel('Month-on-month movers - ' + esc(d.movers.month) + ' vs ' + esc(d.movers.prevMonth), { kind: 'live', text: 'LIVE' }, '',
      'What it is: the clients whose month went up or down the most between the two latest reporting months. Why we show it: the month-on-month story names who moved, not just that the total moved.',
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">' + moverTable(d.movers.gainers, 'Largest gains') + moverTable(d.movers.drops, 'Largest drops') + '</div>');

    // Programme drill
    const progRows = d.programmes.map((pr) =>
      '<details style="border-bottom:1px solid var(--hairline);padding:5px 0"><summary style="cursor:pointer;font-size:13px"><b>' + esc(pr.client) + '</b> · ' + esc(pr.programme) + ' <span style="float:right;font-weight:700">' + fm(pr.revenue) + '</span></summary>' +
      '<table class="vtable" style="margin:6px 0 4px">' + pr.projects.map((pj) => '<tr><td style="font-size:12px">' + esc(pj.name) + '</td><td class="num" style="font-size:12px">' + fm(pj.revenue) + '</td></tr>').join('') + '</table></details>').join('');
    const progPanel = panel('Programme drill-down - top clients', { kind: 'demo', text: 'DEMO GROUPING' }, '',
      'What it is: the top clients\' revenue grouped into project families by name matching. The live rule becomes the programme name and shared Salesforce number once captured at intake; name matching is the documented placeholder. Expand a row for the projects inside it.',
      progRows);

    const rvb = panel('Reported vs billed', { kind: 'demo', text: 'NOT AVAILABLE' }, '',
      '', '<div class="note" style="border-left:3px solid var(--bad)">Billed-versus-recognised cannot be shown from the shared data files: they carry projected and recognised revenue, not invoicing. This panel returns when a billing feed exists. Shown honestly rather than approximated.</div>');

    return kpis + paretoPanel + donutPanel + stackPanel + moversPanel + progPanel + rvb;
  }

  /* ---------------- per-tab wiring ---------------- */
  function wireTab(host) {
    const cum = $('#mv-cum', host), run = $('#mv-run', host), mv = $('#mv-host', host);
    if (cum && run && mv) {
      cum.addEventListener('click', () => { cum.classList.add('on'); run.classList.remove('on'); mv.innerHTML = cumulativeChart(DATA.panels.monthly, DATA.overview.budget, DATA.panels.monthly.todayMonth); });
      run.addEventListener('click', () => { run.classList.add('on'); cum.classList.remove('on'); mv.innerHTML = runRateChart(DATA.panels.monthly); });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
  else main();
})();
