/* ============================================================
   SAVILLS PPM · BENCHMARKING · dashboard UI
   Four views on the same facts:
     • Benchmark a proposal — one record against a cohort you shape with
       dropdowns: where it sits (P25 / median / P75), team mix, FTE by
       phase, rates by title, nearest comparables.
     • Side by side — up to five records, picked from dropdowns, as
       numbers, a staffing grid, rates and the scope matrix; staffing and
       fees can be normalised; differences read against the first column.
     • Comparables finder and Rates explorer — the original rate views.
   Change orders, dead pursuits and no-charge roles are never counted.
   ============================================================ */
(function () {
  'use strict';
  const STORE = window.UFC_Store;
  const BENCH = window.BENCH;
  const CATALOG = window.RATES_CATALOG;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = window.UFC_UI.esc;
  const money = (n) => (n == null || isNaN(n)) ? '—' : '$' + Math.round(n).toLocaleString();
  const rate = (n) => (n == null || isNaN(n) || n === 0) ? '—' : '$' + Math.round(n);
  const pct = (n, d) => (n == null || isNaN(n)) ? '—' : (Math.round(n * Math.pow(10, d == null ? 0 : d)) / Math.pow(10, d == null ? 0 : d)) + '%';
  const fte = (n) => (n == null || isNaN(n)) ? '—' : (Math.round(n * 10) / 10).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const months = (n) => (n == null || isNaN(n)) ? '—' : Math.round(n) + ' mo';
  const statusLabel = (s) => (STORE.STATUS_LABELS && STORE.STATUS_LABELS[s]) || s || '—';
  const fmtBy = {
    money, rate, pct: (v) => pct(v, 0), fte, months, int: (v) => (v == null || isNaN(v)) ? '—' : String(Math.round(v)),
  };
  const fmt = (kind, v) => (fmtBy[kind] || String)(v);
  const openLink = (id) => `Universal Fee Calculator.html?id=${encodeURIComponent(id)}`;

  let PROJECTS = [], FACTS = [], PROJFACTS = [];
  const byId = (id) => PROJFACTS.find(p => p.id === id);

  const state = {
    proposal: '',
    cohort: { ptype: '__own__', industry: '', size: '', outcome: '' },
    slots: ['', '', '', '', ''],
    staffNorm: 'fte',     // fte | pct | avg
    feeNorm: 'abs',       // abs | month | ftemonth
    diff: false,
  };

  function load() {
    // Same rule as every other leader page: you benchmark against what you can see —
    // minus change orders and dead pursuits, which are not proposals in their own right.
    const seen = STORE.visibleProjects ? STORE.visibleProjects(STORE.listProjects()) : STORE.listProjects();
    PROJECTS = BENCH.benchmarkable(seen);
    PROJFACTS = BENCH.projectFacts(PROJECTS);
    FACTS = BENCH.roleFacts(PROJECTS);
  }

  /* ---------- KPIs ---------- */
  function renderKpis() {
    $('#k-projects').textContent = PROJECTS.length;
    $('#k-roles').textContent = FACTS.length;
    const pm = FACTS.filter(f => f.titleId === 'pm').map(f => f.effective);
    $('#k-pm').textContent = pm.length ? rate(BENCH.median(pm)) : '—';
    $('#k-fee').textContent = money(PROJFACTS.reduce((s, p) => s + (p.net || 0), 0));
    $('#k-below').innerHTML = FACTS.filter(f => f.belowFloor).length + '<span class="unit"> roles</span>';
  }

  /* ---------- Shared: project dropdown ---------- */
  function projectOptions(selected, emptyLabel) {
    const groups = {};
    PROJFACTS.forEach(p => { (groups[p.client || '— no client —'] = groups[p.client || '— no client —'] || []).push(p); });
    const clients = Object.keys(groups).sort((a, b) => a.localeCompare(b));
    return `<option value="">${esc(emptyLabel || '— choose a project —')}</option>` + clients.map(c =>
      `<optgroup label="${esc(c)}">` + groups[c].sort((a, b) => a.name.localeCompare(b.name)).map(p =>
        `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)} · ${esc(statusLabel(p.status))} · ${money(p.net)}</option>`
      ).join('') + `</optgroup>`).join('');
  }
  function fillChoice(sel, items, allLabel, ownLabel, current) {
    const opts = [];
    if (ownLabel) opts.push(`<option value="__own__">${esc(ownLabel)}</option>`);
    opts.push(`<option value="">${esc(allLabel)}</option>`);
    items.forEach(i => opts.push(`<option value="${esc(i)}">${esc(i)}</option>`));
    sel.innerHTML = opts.join('');
    if ([...sel.options].some(o => o.value === current)) sel.value = current;
  }

  /* ---------- Position bar: cohort spread with the proposal's dot ---------- */
  function posBar(value, sp, opts) {
    const o = opts || {};
    if (!sp || !sp.n || value == null || !isFinite(value)) return '<div class="posbar empty"></div>';
    const lo = Math.min(sp.min, value), hi = Math.max(sp.max, value);
    const span = (hi - lo) || 1;
    const x = (v) => Math.max(0, Math.min(100, (v - lo) / span * 100));
    const pc = BENCH.percentileOf(value, sp.values);
    const tone = pc == null ? '' : (o.lowerBetter ? (pc >= 75 ? 'hot' : pc <= 25 ? 'cool' : '') : (pc >= 75 ? 'high' : pc <= 25 ? 'low' : ''));
    return `<div class="poswrap"><div class="posbar" title="cohort ${fmt(o.fmt, sp.min)}–${fmt(o.fmt, sp.max)}">
      <div class="iqr" style="left:${x(sp.p25).toFixed(1)}%;width:${Math.max(1, x(sp.p75) - x(sp.p25)).toFixed(1)}%"></div>
      <div class="medtick" style="left:${x(sp.med).toFixed(1)}%"></div>
      <div class="dot ${tone}" style="left:${x(value).toFixed(1)}%"></div>
    </div><div class="pctl ${tone}">${pc == null ? '—' : 'P' + pc}</div></div>`;
  }

  /* ============================================================
     TAB — Benchmark a proposal
     ============================================================ */
  function fillBenchControls() {
    $('#b-proj').innerHTML = projectOptions(state.proposal, '— choose the proposal to benchmark —');
    const types = [...new Set(PROJFACTS.map(p => p.projectType).filter(Boolean))].sort();
    const inds = [...new Set(PROJFACTS.map(p => p.industry).filter(Boolean))].sort();
    fillChoice($('#b-ptype'), types, 'All project types', 'Same type as the proposal', state.cohort.ptype);
    fillChoice($('#b-industry'), inds, 'All industries', 'Same industry as the proposal', state.cohort.industry);
    fillChoice($('#b-size'), BENCH.SIZE_BANDS.map(b => b.key), 'Any size', 'Same size band as the proposal', state.cohort.size);
    $('#b-outcome').value = state.cohort.outcome;
  }
  function cohortFor(t) {
    const c = state.cohort;
    const want = (sel, own) => sel === '__own__' ? (own || '') : sel;
    const ptype = want(c.ptype, t.projectType), ind = want(c.industry, t.industry), size = want(c.size, t.sizeBand);
    return PROJFACTS.filter(p => {
      if (p.id === t.id) return false;
      if (ptype && p.projectType !== ptype) return false;
      if (ind && p.industry !== ind) return false;
      if (size && p.sizeBand !== size) return false;
      if (c.outcome === 'realised' && !p.realised) return false;
      if (c.outcome === 'pursuit' && p.realised) return false;
      return true;
    });
  }
  function cohortLabel(t) {
    const c = state.cohort, parts = [];
    const want = (sel, own) => sel === '__own__' ? (own || '') : sel;
    const ptype = want(c.ptype, t.projectType), ind = want(c.industry, t.industry), size = want(c.size, t.sizeBand);
    if (ptype) parts.push(ptype); if (ind) parts.push(ind); if (size) parts.push(size);
    if (c.outcome === 'realised') parts.push('won / active / closed only');
    if (c.outcome === 'pursuit') parts.push('pursuits only');
    return parts.length ? parts.join(' · ') : 'every project you can see';
  }

  function renderBench() {
    const out = $('#bench-out');
    const t = byId(state.proposal);
    if (!t) {
      out.innerHTML = `<div class="empty">Choose a proposal above. It is placed against every other project you can see, narrowed by the cohort dropdowns.</div>`;
      return;
    }
    const cohort = cohortFor(t);
    const S = BENCH.cohortStats(cohort);
    const small = cohort.length < 5;

    /* 1. Who and against what */
    const head = `<div class="bench-head">
      <div>
        <div class="bh-name">${esc(t.name)} <a class="bh-open" href="${openLink(t.id)}">Open in calculator ↗</a></div>
        <div class="bh-meta">${esc(t.client || '—')}${t.lead ? ' · ' + esc(t.lead) : ''} · <span class="status-tag">${esc(statusLabel(t.status))}</span> · ${esc(t.projectType || 'no project type')} · ${esc(t.industry || 'no industry')} · ${esc(t.sizeBand)} · starts ${t.startYear || '—'}</div>
      </div>
      <div class="bh-cohort ${small ? 'warn' : ''}">
        <div class="lbl">Cohort</div>
        <div class="val">${cohort.length}<span class="unit"> projects</span></div>
        <div class="sub">${esc(cohortLabel(t))}${S.realised ? ` · ${S.realised} won / active / closed` : ''}${small ? ' · small cohort, widen a dropdown' : ''}</div>
      </div>
    </div>`;
    if (!cohort.length) { out.innerHTML = head + `<div class="empty">Nothing else matches this cohort. Widen a dropdown.</div>`; return; }

    /* 2. Position grid */
    const gridRows = BENCH.METRICS.map(m => {
      const sp = S.metrics[m.key];
      const v = t[m.key];
      const na = (m.plan && !t.hasPlan);
      return `<div class="pos-row">
        <div class="pos-cell lbl">${esc(m.label)}${m.hint ? `<div class="muted">${esc(m.hint)}</div>` : ''}</div>
        <div class="pos-cell mine">${na ? '<span class="muted">no plan</span>' : fmt(m.fmt, v)}</div>
        <div class="pos-cell num">${sp.n ? fmt(m.fmt, sp.p25) : '—'}</div>
        <div class="pos-cell num med">${sp.n ? fmt(m.fmt, sp.med) : '—'}</div>
        <div class="pos-cell num">${sp.n ? fmt(m.fmt, sp.p75) : '—'}</div>
        <div class="pos-cell bar">${na ? '' : posBar(v, sp, { fmt: m.fmt, lowerBetter: m.lowerBetter })}${sp.n && sp.n < cohort.length ? `<div class="muted">${sp.n} with a plan</div>` : ''}</div>
      </div>`;
    }).join('');
    const grid = `<div class="card">
      <div class="card-head"><h2>Where it sits.</h2><span class="hint">Band = cohort P25–P75 · tick = cohort median · dot = this proposal · Pnn = its percentile.</span></div>
      <div class="pos-grid">
        <div class="pos-row head"><div class="pos-cell lbl">Metric</div><div class="pos-cell mine">This proposal</div><div class="pos-cell num">P25</div><div class="pos-cell num">Median</div><div class="pos-cell num">P75</div><div class="pos-cell bar">Position in cohort</div></div>
        ${gridRows}
      </div>
    </div>`;

    /* 3. Team mix */
    const mixIds = CATALOG.titles.map(x => x.id).filter(id => t.mix.some(m => m.titleId === id) || S.mix[id]);
    const mixMax = Math.max(1, ...t.mix.map(m => m.pct), ...Object.values(S.mix).map(m => m.med));
    const mixRows = mixIds.map(id => {
      const mine = t.mix.find(m => m.titleId === id);
      const co = S.mix[id];
      const mp = mine ? mine.pct : 0, cp = co ? co.med : 0;
      const d = mp - cp;
      return `<tr>
        <td class="tt">${esc((CATALOG.titles.find(x => x.id === id) || {}).name || id)}</td>
        <td class="mixcell"><div class="mixbar"><div class="fill mine" style="width:${(mp / mixMax * 100).toFixed(1)}%"></div></div></td>
        <td class="num tt">${mine ? pct(mp, 1) : '<span class="muted">—</span>'}</td>
        <td class="num muted">${mine ? fte(mine.fteMonths) + ' FTE-mo · ' + mine.roles + (mine.roles === 1 ? ' role' : ' roles') : ''}</td>
        <td class="mixcell"><div class="mixbar"><div class="fill co" style="width:${(cp / mixMax * 100).toFixed(1)}%"></div></div></td>
        <td class="num">${co ? pct(cp, 1) : '<span class="muted">—</span>'}</td>
        <td class="muted">${co ? `on ${pct(co.usedPct)} of plans` : 'never staffed'}</td>
        <td class="num"><span class="delta ${d > 0.5 ? 'up' : d < -0.5 ? 'down' : ''}">${co || mine ? (d > 0 ? '+' : '') + pct(d, 1) : ''}</span></td>
      </tr>`;
    }).join('');
    const mix = `<div class="card">
      <div class="card-head"><h2>Team mix.</h2><span class="hint">Share of FTE-months by staff title, this proposal against the cohort's median share where that title is staffed.</span></div>
      ${t.hasPlan ? `<table class="tbl"><thead><tr><th>Staff title</th><th colspan="2">This proposal</th><th></th><th colspan="2">Cohort median</th><th>How often staffed</th><th class="num">Δ pts</th></tr></thead><tbody>${mixRows}</tbody></table>`
        : `<div class="empty">This record has no priced staffing plan, so there is no mix to compare.</div>`}
    </div>`;

    /* 4. FTE by phase */
    const phaseRows = t.byPhase.map(ph => {
      const top = Object.keys(ph.byTitle).map(id => ({ id, v: ph.byTitle[id] })).sort((a, b) => b.v - a.v).slice(0, 3)
        .map(x => `${esc((CATALOG.titles.find(y => y.id === x.id) || {}).name || x.id)} ${pct(ph.fteMonths ? x.v / ph.fteMonths * 100 : 0)}`).join(' · ');
      return `<tr><td class="tt">${esc(ph.name)}</td><td class="num">${ph.months}</td><td class="num">${fte(ph.avgFte)}</td><td class="num">${fte(ph.fteMonths)}</td>
        <td class="mixcell"><div class="mixbar"><div class="fill mine" style="width:${ph.pct.toFixed(1)}%"></div></div></td><td class="num">${pct(ph.pct)}</td><td class="muted">${top || '—'}</td></tr>`;
    }).join('');
    const phases = `<div class="card">
      <div class="card-head"><h2>Staffing by phase.</h2><span class="hint">${t.fteMonths ? fte(t.fteMonths) + ' FTE-months over ' + t.durationMonths + ' months · peak ' + fte(t.peakFte) + ' FTE' : ''}</span></div>
      ${t.byPhase.length && t.hasPlan ? `<table class="tbl"><thead><tr><th>Phase</th><th class="num">Months</th><th class="num">Avg FTE</th><th class="num">FTE-months</th><th colspan="2">Share of plan</th><th>Who carries it</th></tr></thead><tbody>${phaseRows}</tbody></table>`
        : `<div class="empty">No phased staffing plan on this record.</div>`}
    </div>`;

    /* 5. Rates by title */
    const rateIds = CATALOG.titles.map(x => x.id).filter(id => t.ratesByTitle[id]);
    const rateRows = rateIds.map(id => {
      const mine = t.ratesByTitle[id], co = S.rates[id];
      const title = CATALOG.titles.find(x => x.id === id) || {};
      return `<tr class="${mine.below ? 'below' : ''}">
        <td class="tt">${esc(title.name || id)}<div class="muted">${mine.n} ${mine.n === 1 ? 'role' : 'roles'}</div></td>
        <td class="num">${rate(mine.quotedMed)}</td>
        <td class="num tt">${rate(mine.effMed)}</td>
        <td class="num">${co ? `${rate(co.p25)} – ${rate(co.p75)}` : '<span class="muted">—</span>'}</td>
        <td class="num">${co ? rate(co.med) : '<span class="muted">—</span>'}</td>
        <td class="num muted">${rate(mine.floor)}</td>
        <td class="num muted">${rate(title.rackRate)}</td>
        <td style="min-width:200px">${co ? posBar(mine.effMed, co, { fmt: 'rate' }) : '<span class="muted">not in cohort</span>'}</td>
        <td>${mine.below ? `<span class="pill below">${mine.below} below floor</span>` : ''}</td>
      </tr>`;
    }).join('');
    const rates = `<div class="card">
      <div class="card-head"><h2>Rates by title.</h2><span class="hint">Effective = after the client discount. Cohort reads one median per project, so a large team does not outvote a small one.</span></div>
      ${rateIds.length ? `<table class="tbl"><thead><tr><th>Staff title</th><th class="num">Quoted</th><th class="num">Effective</th><th class="num">Cohort P25–P75</th><th class="num">Cohort median</th><th class="num">Floor</th><th class="num">Rack</th><th>Position</th><th></th></tr></thead><tbody>${rateRows}</tbody></table>`
        : `<div class="empty">No priced roles on this record.</div>`}
    </div>`;

    /* 6. Nearest comparables */
    const near = BENCH.nearest(t, cohort, 5);
    const nearRows = near.map(p => `<tr>
      <td class="tt"><a href="${openLink(p.id)}">${esc(p.name)}</a><div class="muted">${esc(p.client)}${p.lead ? ' · ' + esc(p.lead) : ''}</div></td>
      <td><span class="status-tag">${esc(statusLabel(p.status))}</span></td>
      <td class="num">${money(p.net)}</td><td class="num">${months(p.durationMonths)}</td>
      <td class="num">${p.hasPlan ? fte(p.avgFte) : '—'}</td><td class="num">${p.hasPlan ? money(p.feePerFteMonth) : '—'}</td>
      <td class="num">${p.hasPlan ? rate(p.blendedRate) : '—'}</td><td class="num">${pct(p.discountPct)}</td>
    </tr>`).join('');
    const nearest = `<div class="card">
      <div class="card-head"><h2>Nearest comparables.</h2><span class="hint">Closest in fee, duration and team size.</span>
        ${near.length ? `<button class="btn btn-ghost" id="b-side" data-ids="${esc([t.id, ...near.slice(0, 4).map(p => p.id)].join(','))}">Open side by side</button>` : ''}</div>
      ${near.length ? `<table class="tbl"><thead><tr><th>Project</th><th>Status</th><th class="num">Net fee</th><th class="num">Duration</th><th class="num">Avg FTE</th><th class="num">Fee / FTE-mo</th><th class="num">Blended rate</th><th class="num">Discount</th></tr></thead><tbody>${nearRows}</tbody></table>` : ''}
    </div>`;

    out.innerHTML = head + grid + mix + phases + rates + nearest;
    const side = $('#b-side');
    if (side) side.addEventListener('click', () => {
      const ids = side.dataset.ids.split(',');
      state.slots = [0, 1, 2, 3, 4].map(i => ids[i] || '');
      renderSlots(); renderCmp(); showTab('cmp');
    });
  }

  /* ============================================================
     TAB — Side by side
     ============================================================ */
  function renderSlots() {
    $$('.cmp-slot').forEach((sel, i) => { sel.innerHTML = projectOptions(state.slots[i], i === 0 ? '— first project (others read against it) —' : '— add a project —'); });
    $('#c-staff').value = state.staffNorm;
    $('#c-fee').value = state.feeNorm;
    $('#c-diff').checked = state.diff;
  }
  function pickedFacts() { return state.slots.map(id => id && byId(id)).filter(Boolean); }

  function renderCmp() {
    const out = $('#cmp-out');
    const ps = pickedFacts();
    if (!ps.length) { out.innerHTML = `<div class="empty">Pick up to five projects from the dropdowns above.</div>`; return; }
    const col = `minmax(170px, 1.1fr) ` + ps.map(() => 'minmax(150px, 1fr)').join(' ');
    const cell = (html, cls) => `<div class="cmp-cell ${cls || ''}">${html}</div>`;
    const row = (label, cells, opts = {}) => `<div class="cmp-row ${opts.head ? 'head' : ''} ${opts.cls || ''}" style="grid-template-columns:${col}">${cell(label)}${cells.map(c => cell(c, opts.big ? 'cmp-big' : '')).join('')}</div>`;
    const sectionHead = (label, cells) => `<div class="cmp-row head" style="grid-template-columns:${col}">${cell(label)}${(cells || ps.map(() => '')).map(c => cell(c)).join('')}</div>`;

    // Numbers with the diff against the first column.
    const delta = (v, base, kind, lowerBetter) => {
      if (!state.diff || base == null || v == null || !isFinite(v) || !isFinite(base)) return '';
      if (kind === 'pct' || kind === 'pts') { const d = v - base; if (Math.abs(d) < 0.05) return '<span class="delta">=</span>'; return `<span class="delta ${(d > 0) !== !!lowerBetter ? 'up' : 'down'}">${d > 0 ? '+' : ''}${pct(d, 1)} pts</span>`; }
      if (!base) return '';
      const r = (v - base) / Math.abs(base) * 100;
      if (Math.abs(r) < 0.5) return '<span class="delta">=</span>';
      return `<span class="delta ${(r > 0) !== !!lowerBetter ? 'up' : 'down'}">${r > 0 ? '+' : ''}${pct(r)}</span>`;
    };
    const nrow = (label, kind, get, opts = {}) => {
      const vals = ps.map(get);
      return row(label, vals.map((v, i) => (opts.na && opts.na(ps[i])) ? '<span class="muted">—</span>' : `${fmt(kind, v)}${i ? delta(v, vals[0], opts.deltaKind || kind, opts.lowerBetter) : ''}`), opts);
    };

    // Fee normalisation.
    const feeLabel = { abs: 'Net fee', month: 'Net fee per month', ftemonth: 'Net fee per FTE-month' }[state.feeNorm];
    const feeOf = (p) => state.feeNorm === 'month' ? p.feePerMonth : state.feeNorm === 'ftemonth' ? p.feePerFteMonth : p.net;

    const overview = [
      row('Project', ps.map(p => `<strong>${esc(p.name)}</strong><div class="cmp-sub"><a href="${openLink(p.id)}">Open ↗</a></div>`), { head: true }),
      row('Client', ps.map(p => esc(p.client || '—'))),
      row('Revenue leader', ps.map(p => esc(p.lead || '—'))),
      row('Status', ps.map(p => `<span class="status-tag">${esc(statusLabel(p.status))}</span>`)),
      row('Project type', ps.map(p => esc(p.projectType || '—'))),
      row('Industry', ps.map(p => esc(p.industry || '—'))),
      row('Start year', ps.map(p => p.startYear || '—')),
      nrow('Duration', 'months', p => p.durationMonths),
      nrow(feeLabel, 'money', feeOf, { big: true, na: p => state.feeNorm === 'ftemonth' && !p.hasPlan }),
      nrow('Gross fee', 'money', p => p.gross),
      nrow('Client discount', 'pct', p => p.discountPct, { lowerBetter: true, deltaKind: 'pts' }),
      nrow('Blended effective rate', 'rate', p => p.blendedRate, { na: p => !p.hasPlan }),
      nrow('Priced roles', 'int', p => p.pricedRoles),
      row('Below cost floor', ps.map(p => p.belowFloorCount ? `<span class="pill below">${p.belowFloorCount} of ${p.pricedRoles}</span>` : '0')),
    ].join('');

    // Staffing grid.
    const staffLabel = { fte: 'FTE-months', pct: '% of team', avg: 'Average FTE' }[state.staffNorm];
    const staffVal = (m, p) => state.staffNorm === 'pct' ? m.pct : state.staffNorm === 'avg' ? (p.durationMonths ? m.fteMonths / p.durationMonths : 0) : m.fteMonths;
    const staffKind = state.staffNorm === 'pct' ? 'pct' : 'fte';
    const titleIds = CATALOG.titles.map(x => x.id).filter(id => ps.some(p => p.mix.some(m => m.titleId === id)));
    const maxShare = Math.max(1, ...ps.flatMap(p => p.mix.map(m => m.pct)));
    const staffRows = titleIds.map(id => {
      const name = (CATALOG.titles.find(x => x.id === id) || {}).name || id;
      const vals = ps.map(p => { const m = p.mix.find(x => x.titleId === id); return m ? staffVal(m, p) : null; });
      const shares = ps.map(p => { const m = p.mix.find(x => x.titleId === id); return m ? m.pct : 0; });
      return row(esc(name), vals.map((v, i) => {
        if (v == null) return '<span class="muted">—</span>';
        const bar = `<div class="mixbar thin"><div class="fill mine" style="width:${(shares[i] / maxShare * 100).toFixed(1)}%"></div></div>`;
        const d = i && vals[0] != null ? delta(v, vals[0], state.staffNorm === 'pct' ? 'pts' : 'fte') : '';
        return `${fmt(staffKind, v)}${d}${bar}`;
      }));
    }).join('');
    const phaseSummary = (p) => p.byPhase.length ? p.byPhase.map(ph => `<div class="cmp-sub">${esc(ph.name)} · ${ph.months} mo · ${fte(ph.avgFte)} FTE</div>`).join('') : '<span class="muted">no phases</span>';
    const staffing = [
      sectionHead(`Staffing plan · ${staffLabel}`, ps.map(p => p.hasPlan ? `${fte(p.fteMonths)} FTE-mo total` : 'no plan')),
      staffRows || row('<span class="muted">No priced staffing on these projects.</span>', ps.map(() => '')),
      nrow('Average team (FTE)', 'fte', p => p.avgFte, { na: p => !p.hasPlan }),
      nrow('Peak team (FTE)', 'fte', p => p.peakFte, { na: p => !p.hasPlan }),
      row('Phases', ps.map(phaseSummary)),
    ].join('');

    // Rates by title.
    const rateIds = CATALOG.titles.map(x => x.id).filter(id => ps.some(p => p.ratesByTitle[id]));
    const rateRows = rateIds.map(id => {
      const name = (CATALOG.titles.find(x => x.id === id) || {}).name || id;
      const effs = ps.map(p => p.ratesByTitle[id] ? p.ratesByTitle[id].effMed : null);
      return row(esc(name), ps.map((p, i) => {
        const r = p.ratesByTitle[id];
        if (!r) return '<span class="muted">—</span>';
        return `<span class="muted">${rate(r.quotedMed)} →</span> <strong>${rate(r.effMed)}</strong>${i && effs[0] != null ? delta(r.effMed, effs[0], 'rate') : ''}${r.below ? ` <span class="pill below">${r.below} below</span>` : ''}`;
      }));
    }).join('');
    const rates = sectionHead('Rates by title · quoted → effective (median per title)') + (rateRows || row('<span class="muted">No priced roles.</span>', ps.map(() => '')));

    // Scope & assumptions ✔/✘ matrix — read straight off the records.
    const raws = ps.map(p => STORE.getProject(p.id) || {});
    const yn = (on) => on ? '<span class="cmp-yes">✔</span>' : '<span class="cmp-no">✘</span>';
    const scopeUnion = [...new Set(raws.flatMap(r => (r.project && r.project.projectSubtypes) || []))].sort();
    const asmUnion = [...new Set(raws.flatMap(r => (r.project && r.project.assumptionsList) || []))].sort();
    const scopeRows = scopeUnion.length
      ? scopeUnion.map(s => row(esc(s), raws.map(r => yn(((r.project && r.project.projectSubtypes) || []).includes(s))))).join('')
      : row('<span class="muted">No scope items captured on these projects.</span>', ps.map(() => ''));
    const asmRows = asmUnion.length
      ? asmUnion.map(s => row(esc(s), raws.map(r => yn(((r.project && r.project.assumptionsList) || []).includes(s))))).join('')
      : row('<span class="muted">No assumptions captured on these projects.</span>', ps.map(() => ''));

    out.innerHTML = `<div class="cmp-grid">
      ${overview}
      ${staffing}
      ${rates}
      ${sectionHead('Scope included')}
      ${scopeRows}
      ${sectionHead('Assumptions &amp; exclusions')}
      ${asmRows}
    </div>`;
  }

  /* ============================================================
     TAB — Comparables finder
     ============================================================ */
  function fillFilterOptions() {
    const clients = [...new Set(FACTS.map(f => f.client).filter(Boolean))].sort();
    const inds = [...new Set(FACTS.map(f => f.industry).filter(Boolean))].sort();
    const ptypes = [...new Set(FACTS.map(f => f.projectType).filter(Boolean))].sort();
    const titles = CATALOG.titles.filter(t => FACTS.some(f => f.titleId === t.id));
    fillSelect($('#f-client'), clients, 'All clients');
    fillSelect($('#f-industry'), inds, 'All industries');
    if ($('#f-ptype')) fillSelect($('#f-ptype'), ptypes, 'All project types');
    $('#f-title').innerHTML = `<option value="">All staff titles</option>` +
      titles.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  }
  function fillSelect(sel, items, allLabel) {
    sel.innerHTML = `<option value="">${allLabel}</option>` + items.map(i => `<option value="${esc(i)}">${esc(i)}</option>`).join('');
  }
  function sizeBucket(fee) {
    if (fee < 1e6) return 's';
    if (fee < 3e6) return 'm';
    if (fee < 6e6) return 'l';
    return 'xl';
  }
  function filteredFacts() {
    const c = $('#f-client').value, ind = $('#f-industry').value, t = $('#f-title').value;
    const pt = $('#f-ptype') ? $('#f-ptype').value : '';
    const size = $('#f-size').value, role = $('#f-role').value.trim().toLowerCase();
    const projSize = {}; PROJFACTS.forEach(p => projSize[p.id] = p.net);
    return FACTS.filter(f => {
      if (c && f.client !== c) return false;
      if (ind && f.industry !== ind) return false;
      if (pt && f.projectType !== pt) return false;
      if (t && f.titleId !== t) return false;
      if (size && sizeBucket(projSize[f.projectId] || 0) !== size) return false;
      if (role && !(f.projectRole || '').toLowerCase().includes(role)) return false;
      return true;
    });
  }
  function renderComp() {
    const f = filteredFacts();
    const stats = $('#comp-stats');
    if (f.length) {
      const q = f.map(x => x.quoted), e = f.map(x => x.effective);
      const below = f.filter(x => x.belowFloor).length;
      stats.innerHTML = [
        ['Matches', f.length, `${new Set(f.map(x => x.projectId)).size} projects`],
        ['Median quoted', rate(BENCH.median(q)), `range ${rate(Math.min(...q))}–${rate(Math.max(...q))}`],
        ['Median effective', rate(BENCH.median(e)), 'discount included'],
        ['Below floor', below, below ? 'potentially unprofitable' : 'all profitable'],
      ].map(([l, v, s]) => `<div class="compstat"><div class="lbl">${l}</div><div class="val">${v}</div><div class="sub">${s}</div></div>`).join('');
    } else { stats.innerHTML = ''; }

    const tb = $('#comp-tbody');
    if (!f.length) { tb.innerHTML = `<tr><td colspan="8" class="empty">No roles match these filters.</td></tr>`; return; }
    const sorted = [...f].sort((a, b) => b.quoted - a.quoted);
    tb.innerHTML = sorted.map(x => `
      <tr class="${x.belowFloor ? 'below' : ''}">
        <td class="tt">${esc(x.titleName)}<div class="muted">${esc(x.tierLabel)}</div></td>
        <td>${esc(x.projectRole || '—')}</td>
        <td>${esc(x.projectName)}<div class="muted">${esc(x.client)}</div></td>
        <td class="muted">${esc(x.industry || '—')}</td>
        <td class="num tt">${rate(x.quoted)}</td>
        <td class="num">${rate(x.effective)}</td>
        <td class="num muted">${rate(x.floor)}</td>
        <td>${x.belowFloor ? '<span class="pill below">below</span> ' : ''}<span class="pill ${x.rateSource}">${x.rateSource}</span></td>
      </tr>`).join('');
  }

  /* ============================================================
     TAB — Rates explorer
     ============================================================ */
  function renderRates() {
    const rows = BENCH.statsByTitle(FACTS);
    const tb = $('#rates-tbody');
    if (!rows.length) { tb.innerHTML = `<tr><td colspan="9" class="empty">No priced roles yet.</td></tr>`; return; }
    // global scale for bars: floor low → highest rack across shown titles
    const maxScale = Math.max(...rows.map(r => Math.max(r.rack, r.quotedMax)));
    const minScale = Math.min(...rows.map(r => r.floorLow)) * 0.9;
    const pos = (v) => ((v - minScale) / (maxScale - minScale)) * 100;
    tb.innerHTML = rows.map(r => {
      const floorPct = pos(r.floorHigh);
      const spanL = pos(r.effMin), spanR = pos(r.effMax);
      const bar = `
        <div class="rangebar" title="eff ${rate(r.effMin)}–${rate(r.effMax)} · floor ${rate(r.floorLow)}–${rate(r.floorHigh)} · rack ${rate(r.rack)}">
          <div class="floorzone" style="width:${floorPct.toFixed(1)}%"></div>
          <div class="span" style="left:${spanL.toFixed(1)}%;width:${Math.max(1.5, spanR - spanL).toFixed(1)}%"></div>
          <div class="med" style="left:${pos(r.effMed).toFixed(1)}%"></div>
          <div class="racktick" style="left:${pos(r.rack).toFixed(1)}%"></div>
        </div>
        <div class="rangelabels"><span>${rate(r.floorLow)} floor</span><span>${rate(r.rack)} rack</span></div>`;
      const bf = r.belowFloor ? `<span class="pill below">${r.belowFloor} / ${r.n}</span>` : `<span class="muted">0</span>`;
      return `<tr>
        <td class="tt">${esc(r.titleName)}</td>
        <td class="num">${r.n}</td>
        <td class="num">${rate(r.quotedMin)}</td>
        <td class="num tt">${rate(r.quotedMed)}</td>
        <td class="num">${rate(r.quotedMax)}</td>
        <td class="num">${rate(r.effMed)}</td>
        <td class="num muted">${rate(r.floorLow)}–${rate(r.floorHigh)}</td>
        <td style="min-width:220px">${bar}</td>
        <td class="num">${bf}</td>
      </tr>`;
    }).join('');
  }

  /* ---------- Tabs ---------- */
  function showTab(name) {
    $$('.tab').forEach(x => x.classList.toggle('on', x.dataset.tab === name));
    $$('.panel').forEach(x => x.classList.toggle('on', x.id === 'panel-' + name));
  }
  function initTabs() {
    $$('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
  }

  function renderFootnote() {
    $('#footnote').innerHTML = `<strong>How these numbers are built.</strong> Every priced role across the projects you can see is read straight from its record using the same math as the calculator. <strong>Quoted</strong> is the start-year rate before the client discount; <strong>Effective</strong> applies the project's client discount — what the client actually paid. <strong>Floor</strong> is the role's Col E / Col G cost rate; a role is flagged <em>below floor</em> when its effective rate dips under that floor. <strong>FTE-months</strong> sum each priced role's monthly FTE across the plan; <strong>blended effective rate</strong> is the net fee divided by FTE-months × hours per month. Change orders, dead pursuits (lost, or rated Dead Pursuit) and no-charge roles are left out of every statistic. Contracted rates are shown as billed (industry adjustment bypassed).`;
  }

  function wire() {
    $('#b-proj').addEventListener('change', e => { state.proposal = e.target.value; renderBench(); });
    [['#b-ptype', 'ptype'], ['#b-industry', 'industry'], ['#b-size', 'size'], ['#b-outcome', 'outcome']].forEach(([s, k]) =>
      $(s).addEventListener('change', e => { state.cohort[k] = e.target.value; renderBench(); }));
    $$('.cmp-slot').forEach((sel, i) => sel.addEventListener('change', () => { state.slots[i] = sel.value; renderCmp(); }));
    $('#c-staff').addEventListener('change', e => { state.staffNorm = e.target.value; renderCmp(); });
    $('#c-fee').addEventListener('change', e => { state.feeNorm = e.target.value; renderCmp(); });
    $('#c-diff').addEventListener('change', e => { state.diff = e.target.checked; renderCmp(); });
    ['#f-client', '#f-industry', '#f-ptype', '#f-title', '#f-size', '#f-role'].forEach(s =>
      $(s) && $(s).addEventListener('input', renderComp));
  }

  function boot() {
    if (BENCH.removeSamples) BENCH.removeSamples();   // purge any previously-seeded sample projects
    load();
    if (!PROJECTS.length && window.UFC_UI && window.UFC_UI.emptyState) {
      const kp = document.querySelector('.kpis');
      if (kp) kp.insertAdjacentHTML('afterend', window.UFC_UI.emptyState({
        title: 'Nothing to benchmark yet',
        body: 'Benchmarks are built from the projects you can see. Create a project, or ask an admin for access to a leader\'s book, and this page fills in on its own.',
        actions: [{ label: '+ New project', href: 'Universal Fee Calculator.html' }, { label: 'Projects Index', href: 'Projects Index.html' }] }));
    }
    // ?id= lands on that proposal's benchmark.
    const qid = new URLSearchParams(location.search).get('id');
    if (qid && byId(qid)) state.proposal = qid;
    renderKpis();
    fillBenchControls();
    renderBench();
    renderSlots();
    renderCmp();
    fillFilterOptions();
    renderComp();
    renderRates();
    renderFootnote();
    initTabs();
    wire();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (window.ufcReady && window.ufcReady.then) { window.ufcReady.then(boot); } else { boot(); }
  });
})();
