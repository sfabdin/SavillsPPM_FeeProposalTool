/* ============================================================
   SAVILLS PPM · REVENUE STUDIO  (Phases A + B)
   ------------------------------------------------------------
   Admin-gated. Compares a frozen baseline (Budget / RFx) against
   the LIVE roll-up from projects, plus a named SCENARIO overlay:
   manual adjustments and a "Projected Future Projects" pool (by
   client and/or overall) that NEW-since-baseline bookings draw down.
   Reads project data read-only; baselines + scenarios live in the
   separate studio store (studio.json). Never writes to projects.
   ============================================================ */
(function () {
  'use strict';
  const STORE = window.UFC_Store;
  const CATALOG = window.RATES_CATALOG;
  const $ = (s) => document.querySelector(s);
  const fmt = (n) => (n < 0 ? '-' : '') + '$' + Math.round(Math.abs(n)).toLocaleString();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let activeBaselineId = null;
  let activeScenarioId = null;
  let sliceDim = 'client';
  let activeYear = 2026;
  let viewMode = 'year';                       // 'year' | 'month'
  let viewTab = 'build';                       // 'build' | 'exec'
  const COLLAPSED = new Set();                 // bucket ids the user collapsed
  const OPENGRP = new Set();                   // group ids the user drilled into
  let LAST_TREE = null;                        // last rendered tree (for export)
  try { const s = JSON.parse(localStorage.getItem('ufc_studio_view') || '{}'); if (s.mode) viewMode = s.mode; (s.collapsed || []).forEach(x => COLLAPSED.add(x)); (s.open || []).forEach(x => OPENGRP.add(x)); } catch (e) {}
  const saveView = () => { try { localStorage.setItem('ufc_studio_view', JSON.stringify({ mode: viewMode, collapsed: [...COLLAPSED], open: [...OPENGRP] })); } catch (e) {} };
  let viewAsLeaderId = null;     // admin previewing a leader; null = own/admin view
  let isAdminUser = false;

  /** The effective leader being viewed (leader-mode) or null (admin full view). */
  function effectiveLeader() {
    if (!isAdminUser) { const me = STORE.getCurrentUser(); return STORE.resolveLeader(me.username) || STORE.resolveLeader(me.name) || { displayName: me.name || 'You', id: me.username }; }
    return viewAsLeaderId ? STORE.leaderById(viewAsLeaderId) : null;
  }
  function leaderMode() { return !!effectiveLeader(); }

  function ready() {
    const me = STORE.getCurrentUser();
    isAdminUser = STORE.isAdmin(me);
    // Both admins and revenue leaders may enter; leaders get a read-only slice.
    const leader = isAdminUser ? null : (STORE.resolveLeader(me.username) || STORE.resolveLeader(me.name));
    if (!isAdminUser && !leader) {
      $('#gate').hidden = false;
      $('#gate').innerHTML = 'Revenue Studio is for admins and revenue leaders. You\'re signed in as <strong>' + esc(me.name || 'unknown') + '</strong> — ask an admin for access.';
      return;
    }
    $('#studio-body').hidden = false;
    $('#year-sel').innerHTML = [2025, 2026, 2027, 2028].map(y => `<option value="${y}" ${y === activeYear ? 'selected' : ''}>${y}</option>`).join('');
    $('#slice-sel').addEventListener('change', e => { sliceDim = e.target.value; render(); });
    $('#year-sel').addEventListener('change', e => { activeYear = +e.target.value; render(); });
    $('#baseline-sel').addEventListener('change', e => { activeBaselineId = e.target.value; render(); });
    $('#load-budget-btn').addEventListener('click', () => $('#budget-file').click());
    $('#budget-file').addEventListener('change', onBudgetFile);
    // Granularity toggle (Year / Month)
    $('#viewmode-ctl') && $('#viewmode-ctl').addEventListener('click', e => {
      const b = e.target.closest('button[data-mode]'); if (!b) return;
      viewMode = b.dataset.mode;
      [...$('#viewmode-ctl').querySelectorAll('button')].forEach(x => x.classList.toggle('on', x.dataset.mode === viewMode));
      saveView(); render();
    });
    [...($('#viewmode-ctl') ? $('#viewmode-ctl').querySelectorAll('button') : [])].forEach(x => x.classList.toggle('on', x.dataset.mode === viewMode));
    $('#expand-all-btn') && $('#expand-all-btn').addEventListener('click', () => { COLLAPSED.clear(); (LAST_TREE ? LAST_TREE.tree : []).forEach(b => (b.kids || []).forEach(g => OPENGRP.add(g.id))); saveView(); render(); });
    $('#collapse-all-btn') && $('#collapse-all-btn').addEventListener('click', () => { OPENGRP.clear(); saveView(); render(); });
    $('#export-view-btn') && $('#export-view-btn').addEventListener('click', exportView);
    // View tabs (Pipeline & Budget / Exec Report)
    $('.studio-tabs') && $('.studio-tabs').addEventListener('click', e => {
      const b = e.target.closest('button[data-view]'); if (!b) return;
      viewTab = b.dataset.view;
      [...document.querySelectorAll('.studio-tab')].forEach(x => x.classList.toggle('on', x.dataset.view === viewTab));
      applyViewTab();
    });
    // Drill-down caret delegation
    $('#cmp-table') && $('#cmp-table').addEventListener('click', e => {
      const a = e.target.closest('a.tw'); if (!a) return;
      e.preventDefault();
      const id = a.dataset.node;
      if (a.dataset.kind === 'bkt') { if (COLLAPSED.has(id)) COLLAPSED.delete(id); else COLLAPSED.add(id); }
      else { if (OPENGRP.has(id)) OPENGRP.delete(id); else OPENGRP.add(id); }
      saveView(); render();
    });
    $('#scenario-sel') && $('#scenario-sel').addEventListener('change', e => { activeScenarioId = e.target.value || null; render(); });
    $('#new-scenario-btn') && $('#new-scenario-btn').addEventListener('click', newScenario);
    $('#rename-scenario-btn') && $('#rename-scenario-btn').addEventListener('click', renameScenario);
    $('#del-scenario-btn') && $('#del-scenario-btn').addEventListener('click', delScenario);
    $('#add-pool-btn') && $('#add-pool-btn').addEventListener('click', () => addEntry('pool'));
    $('#add-adjust-btn') && $('#add-adjust-btn').addEventListener('click', () => addEntry('adjust'));
    // Admin-only "View as" leader selector (Phase C)
    if (isAdminUser) {
      $('#viewas-group').hidden = false;
      const leaders = STORE.REVENUE_LEADERS.slice().sort((a, b) => a.displayName.localeCompare(b.displayName));
      $('#viewas-sel').innerHTML = '<option value="">Me · admin (full view)</option>' +
        leaders.map(l => `<option value="${l.id}">${esc(l.displayName)}</option>`).join('');
      $('#viewas-sel').addEventListener('change', e => { viewAsLeaderId = e.target.value || null; render(); });
    }
    refreshBaselineSel();
    refreshScenarioSel();
    render();
  }

  function refreshBaselineSel() {
    const bls = STORE.listBaselines();
    const sel = $('#baseline-sel');
    if (!bls.length) { sel.innerHTML = '<option value="">— none loaded —</option>'; activeBaselineId = null; return; }
    if (!activeBaselineId || !bls.find(b => b.id === activeBaselineId)) activeBaselineId = bls[0].id;
    sel.innerHTML = bls.map(b => `<option value="${b.id}" ${b.id === activeBaselineId ? 'selected' : ''}>${esc(b.name)} · ${fmt(b.total)}</option>`).join('');
  }

  function refreshScenarioSel() {
    const scs = STORE.listScenarios();
    const sel = $('#scenario-sel');
    if (!sel) return;
    if (!scs.length) { sel.innerHTML = '<option value="">— live only (no scenario) —</option>'; activeScenarioId = null; return; }
    if (activeScenarioId && !scs.find(s => s.id === activeScenarioId)) activeScenarioId = null;
    sel.innerHTML = '<option value="">— live only (no scenario) —</option>' +
      scs.map(s => `<option value="${s.id}" ${s.id === activeScenarioId ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  }

  function activeScenario() { return activeScenarioId ? STORE.getScenario(activeScenarioId) : null; }

  function newScenario() {
    const name = (prompt('Name this scenario (e.g. "Conservative", "Stretch"):') || '').trim();
    if (!name) return;
    const sc = STORE.saveScenario({ name, baselineId: activeBaselineId, year: activeYear, adjustments: [] });
    activeScenarioId = sc.id;
    refreshScenarioSel(); render();
  }
  function renameScenario() {
    const sc = activeScenario(); if (!sc) return alert('Pick a scenario first.');
    const name = (prompt('Rename scenario:', sc.name) || '').trim();
    if (!name) return;
    sc.name = name; STORE.saveScenario(sc); refreshScenarioSel(); render();
  }
  function delScenario() {
    const sc = activeScenario(); if (!sc) return;
    if (!confirm(`Delete scenario "${sc.name}"? This does not touch any project data.`)) return;
    STORE.deleteScenario(sc.id); activeScenarioId = null; refreshScenarioSel(); render();
  }

  function addEntry(type) {
    const sc = activeScenario();
    if (!sc) return alert('Create or pick a scenario first — adjustments live inside a scenario.');
    const dimLabel = { client: 'client', leader: 'leader', industry: 'industry', serviceLine: 'service line', rating: 'rating' }[sliceDim] || 'slice';
    const key = (prompt(`${type === 'pool' ? 'Projected future projects' : 'Adjustment'} applies to which ${dimLabel}? Type the exact name, or leave blank for OVERALL:`) || '').trim();
    const amtRaw = prompt(`Annual ${type === 'pool' ? 'pool' : 'adjustment'} amount for ${activeYear} (use a negative number to subtract):`, '0');
    const annual = parseFloat((amtRaw || '').replace(/[,$]/g, ''));
    if (!isFinite(annual) || annual === 0) return;
    const note = (prompt('Optional note / label:', type === 'pool' ? 'Projected future work' : 'Adjustment') || '').trim();
    sc.adjustments = sc.adjustments || [];
    sc.adjustments.push({ id: 'a_' + Math.random().toString(36).slice(2, 9), type, dim: key ? sliceDim : 'all', key: key || '', annual, note, year: activeYear });
    STORE.saveScenario(sc); render();
  }
  function removeEntry(id) {
    const sc = activeScenario(); if (!sc) return;
    sc.adjustments = (sc.adjustments || []).filter(a => a.id !== id);
    STORE.saveScenario(sc); render();
  }
  window.__studioRemoveEntry = removeEntry;
  window.__studioRenderExec = (...a) => renderExec(...a);   // test hook

  async function onBudgetFile(e) {
    const f = e.target.files[0]; if (!f) return;
    try {
      const wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
      const clientAnnual = {};
      aoa.forEach(row => {
        const name = (row[0] || '').toString().trim();
        const amt = parseFloat(row[1]);
        if (!name || !isFinite(amt) || /client/i.test(name) || /total/i.test(name)) return;
        clientAnnual[name] = (clientAnnual[name] || 0) + amt;
      });
      const n = Object.keys(clientAnnual).length;
      if (!n) { alert('No client rows found. Expected Client in column A, annual $ in column B.'); return; }
      const budget = STORE.baselineFromBudget('2026 Budget', 'budget', activeYear, clientAnnual, activeYear + '-01-01');
      STORE.saveBaseline(budget);
      const rf1 = STORE.baselineFromBudget('RF1', 'rf', activeYear, clientAnnual, activeYear + '-01-01');
      rf1.order = 1; STORE.saveBaseline(rf1);
      refreshBaselineSel(); render();
      alert(`Loaded ${n} clients · ${fmt(budget.total)} as “2026 Budget” and “RF1”.`);
    } catch (err) { alert('Could not read the budget file: ' + err.message); }
    finally { e.target.value = ''; }
  }

  /* ---- Live roll-up from projects (read-only) ---- */
  function liveRows(baseline) {
    const cutoff = baseline ? Date.parse(baseline.submittedAt || '') : NaN;
    const projects = STORE.visibleProjects(STORE.listProjects()).filter(p => !STORE.isChangeOrder(p));
    return projects.map(p => {
      const series = STORE.monthlySeries(p, CATALOG) || [];
      let yearTotal = 0; const byMonth = {};
      series.forEach(s => { if (s.year === activeYear) { yearTotal += s.amount; byMonth[s.month] = (byMonth[s.month] || 0) + s.amount; } });
      const pj = p.project || {};
      const leader = STORE.resolveLeader(pj.leadId || pj.lead);
      const created = Date.parse(p.createdAt || '');
      return {
        p, yearTotal, byMonth,
        rating: STORE.ratingFor(p),
        isNew: isFinite(cutoff) && isFinite(created) && created > cutoff,
        client: (pj.client || '—').trim() || '—',
        leader: leader ? leader.displayName : (pj.lead || '—'),
        industry: (pj.industry || '—').trim() || '—',
        serviceLine: (STORE.projectServiceLines(p)[0] || '—'),
      };
    });
  }
  function sliceKey(row) { return row[sliceDim] || '—'; }

  /* ---- Pipeline waterfall: how Booked → +90% → +Likely → Projected builds vs target ---- */
  function buildWaterfall(T, vsTotal) {
    const steps = [
      { label: 'Booked', sub: 'Rating 1', cls: 'booked', base: 0, delta: T.booked },
      { label: '+ 90%', sub: 'Rating 2', cls: 'p90', base: T.booked, delta: T.p90 },
      { label: '+ Likely', sub: 'Rating 3–4', cls: 'likely', base: T.booked + T.p90, delta: T.likely },
    ];
    if (Math.abs(T.adjust) > 0.5) {
      const negBase = T.booked + T.p90 + T.likely + Math.min(0, T.adjust);
      steps.push({ label: (T.adjust >= 0 ? '+ ' : '− ') + 'Adjust', sub: 'Reserve / manual', cls: 'adj', base: negBase, delta: Math.abs(T.adjust) });
    }
    steps.push({ label: 'Projected', sub: 'Rating 1–4', cls: 'total', base: 0, delta: T.projected, total: true });
    const scale = Math.max(T.projected, T.tgt, 1) * 1.12;
    const pct = (v) => (v / scale * 100);
    const cols = steps.map((s, i) => {
      const bottom = pct(s.base), h = Math.max(pct(s.delta), 0.4);
      let val;
      if (s.total || s.cls === 'booked') val = fmt(s.delta);
      else if (s.cls === 'adj' && T.adjust < 0) val = '−' + fmt(s.delta);
      else val = '+' + fmt(s.delta);
      return `<div class="wf-col"><div class="wf-bar ${s.cls}" style="bottom:${bottom}%;height:${h}%"><span class="wf-val">${val}</span></div></div>`;
    }).join('');
    const labels = steps.map(s => `<div class="wf-lab"><span class="l1">${esc(s.label)}</span><span class="l2">${esc(s.sub)}</span></div>`).join('');
    const tgtLine = T.tgt ? `<div class="wf-tgt" style="bottom:${pct(T.tgt)}%"><span>Target · ${fmt(T.tgt)}</span></div>` : '';
    const gapTxt = T.tgt ? `<span class="wf-gap ${vsTotal >= 0 ? 'pos' : 'neg'}">${vsTotal >= 0 ? 'Over target by ' : 'Remaining to target '}${fmt(Math.abs(vsTotal))}</span>` : '';
    return `<div class="panel-h"><h2>How the projected number builds</h2>${gapTxt}</div>
      <div class="wf-plot">${tgtLine}${cols}</div>
      <div class="wf-labs">${labels}</div>`;
  }

  /* ---- Provenance / confidence strip: what's safe to trust in this view ---- */
  function buildConfidence(rows, baseline) {
    const n = rows.length;
    const imported = rows.filter(r => r.p.source && r.p.source.importedByMonth);
    const withStaff = rows.filter(r => (r.p.roles || []).length > 0);
    const totalRev = rows.reduce((a, r) => a + r.yearTotal, 0) || 1;
    const importedRev = imported.reduce((a, r) => a + r.yearTotal, 0);
    const pctLive = Math.round((totalRev - importedRev) / totalRev * 100);
    const frozen = baseline.createdAt ? new Date(baseline.createdAt).toLocaleDateString() : '—';
    const chip = (status, label, val) => `<div class="cf-chip"><span class="cf-dot ${status}"></span><span class="cf-l">${label}</span><span class="cf-v">${val}</span></div>`;
    return chip(pctLive >= 80 ? 'live' : 'partial', 'Pipeline source', pctLive + '% calculated · ' + (100 - pctLive) + '% imported $')
      + chip(withStaff.length === n && n ? 'live' : (withStaff.length ? 'partial' : 'missing'), 'Staffing coverage', withStaff.length + '/' + n + ' have allocations')
      + chip('imported', 'Baseline', esc(baseline.name) + ' · frozen ' + frozen)
      + chip('planned', 'Margin', 'Planned — floor-rate basis · actuals pending Clockify');
  }

  function render() {
    const lead = effectiveLeader();
    document.body.classList.toggle('leader-mode', !!lead);
    const banner = $('#leader-banner');
    if (lead) {
      banner.hidden = false;
      banner.innerHTML = (isAdminUser ? 'Previewing what <strong>' + esc(lead.displayName) + '</strong> sees · ' : 'Signed in as <strong>' + esc(lead.displayName) + '</strong> · ') + 'read-only — only your projects and the pools assigned to you. Pools are set by admins.';
    } else { banner.hidden = true; }

    const baseline = activeBaselineId ? STORE.getBaseline(activeBaselineId) : null;
    if (!baseline) { $('#no-baseline').hidden = false; $('#cmp-table').innerHTML = ''; $('#kpis').innerHTML = ''; $('#waterfall').hidden = true; $('#confidence').innerHTML = ''; $('#studio-foot').textContent = ''; renderEntries(); return; }
    $('#no-baseline').hidden = true;

    const sc = activeScenario();
    const now0 = new Date();
    const curMonthIdx = (activeYear === now0.getFullYear()) ? (now0.getMonth() + 1) : (activeYear < now0.getFullYear() ? 13 : 0);
    let rows = liveRows(baseline);
    // Leader mode: restrict to the leader's own projects + their client set.
    let leaderClients = null;
    if (lead) {
      rows = rows.filter(r => { const l = STORE.resolveLeader(r.p.project && (r.p.project.leadId || r.p.project.lead)); return l && l.id === lead.id; });
      leaderClients = new Set(rows.map(r => r.client));
    }
    const baseByClient = baseline.byClient || {};
    const targetForSlice = (key) => (sliceDim === 'client' ? ((baseByClient[key] || {}).annual || 0) : null);

    // scenario entries for this dim — leader sees ONLY pools/adjustments assigned to them.
    let adjustEntries = sc ? (sc.adjustments || []).filter(a => a.year === activeYear) : [];
    if (lead) {
      adjustEntries = adjustEntries.filter(a =>
        (a.dim === 'leader' && a.key === lead.displayName) ||
        (a.dim === 'client' && leaderClients.has(a.key)));   // overall pools hidden from leaders
    }
    const poolFor = (key) => adjustEntries.filter(a => a.type === 'pool' && a.dim === sliceDim && a.key === key).reduce((s, a) => s + a.annual, 0);
    const adjFor = (key) => adjustEntries.filter(a => a.type === 'adjust' && a.dim === sliceDim && a.key === key).reduce((s, a) => s + a.annual, 0);
    const overallPool = adjustEntries.filter(a => a.type === 'pool' && a.dim === 'all').reduce((s, a) => s + a.annual, 0);
    const overallAdj = adjustEntries.filter(a => a.type === 'adjust' && a.dim === 'all').reduce((s, a) => s + a.annual, 0);

    // ---- Group live by slice, split into likelihood buckets ----
    // "Future Business" = the unallocated slush from Revenue Projections — shown
    // below the line as an adjustment, never as a client row.
    // Three tiers, in order: named clients (top) → New Clients (middle, named
    // Slush = unallocated INCREMENTAL business not tied to a named client. It shows up
    // both as a baseline line ("Incremental Business" / "New Business Opportunities") and
    // as live unnamed pipeline rows. It becomes the below-the-line reserve, never an
    // Existing-Client row.
    const isSlush = (name) => /future business|unalloc|slush|^tbd$|incremental|new business opportun|new business$/i.test(name || '');
    const isFuture = isSlush;   // excluded from the monthly curve and from per-client rows
    const RB = (r) => r === 1 ? 'booked' : r === 2 ? 'p90' : (r >= 3 && r <= 4) ? 'likely' : 'low';
    const groups = {}; let slushLive = 0, slushTarget = 0;
    rows.forEach(r => {
      if (isSlush(r.client)) { if (r.rating <= 4) slushLive += r.yearTotal; return; }
      const k = sliceKey(r);
      const g = groups[k] || (groups[k] = { key: k, booked: 0, p90: 0, likely: 0, low: 0, projects: [] });
      g[RB(r.rating)] += r.yearTotal;
      g.projects.push(r);
    });
    if (sliceDim === 'client') Object.keys(baseByClient).forEach(c => {
      if (lead && !(leaderClients && leaderClients.has(c))) return;
      if (isSlush(c)) { slushTarget += (baseByClient[c].annual || 0); return; }   // incremental baseline line → reserve
      if (!groups[c]) groups[c] = { key: c, booked: 0, p90: 0, likely: 0, low: 0 };
    });
    adjustEntries.forEach(a => { if (a.key && a.dim === sliceDim && !groups[a.key]) groups[a.key] = { key: a.key, booked: 0, p90: 0, likely: 0, low: 0 }; });

    const list = Object.values(groups).map(g => {
      const adjust = adjFor(g.key);
      const projected = g.booked + g.p90 + g.likely + adjust;   // 1–4 + manual adjust (low excluded)
      const tgt = targetForSlice(g.key);
      const vsT = tgt != null ? projected - tgt : null;          // <0 = remaining gap, >0 = over
      // Existing = has a Budget / RF1 baseline target; New = $0 baseline (client slice only).
      const isNew = sliceDim === 'client' && !(tgt != null && tgt > 0);
      return { ...g, adjust, projected, tgt, vsT, isNew };
    }).sort((a, b) => {
      if (!!a.isNew !== !!b.isNew) return a.isNew ? 1 : -1;       // existing clients above new
      return (b.tgt || b.projected) - (a.tgt || a.projected);
    });

    // "Allocated for New Business" = the budgeted incremental reserve (baseline
    // "Incremental Business" line + live unnamed pipeline), drawn down as real New
    // Clients/Projects land — so it offsets their gains instead of double-counting.
    const newClientTotal = list.filter(g => g.isNew).reduce((a, g) => a + g.projected, 0);
    const allocatedRemaining = Math.max(0, slushTarget - newClientTotal - slushLive);
    const allocatedProjected = slushLive + allocatedRemaining;   // the reserve's contribution to projected
    const drawnNewBiz = Math.min(newClientTotal, Math.max(0, slushTarget - slushLive));

    let T = { tgt: 0, booked: 0, p90: 0, likely: 0, low: 0, adjust: 0, projected: 0 };
    list.forEach(g => { T.tgt += g.tgt || 0; T.booked += g.booked; T.p90 += g.p90; T.likely += g.likely; T.low += g.low; T.adjust += g.adjust; T.projected += g.projected; });
    T.tgt += slushTarget;                          // budget includes the incremental reserve target
    T.adjust += overallAdj + allocatedProjected;   // Allocated for New Business rolls in below the line
    T.projected += overallAdj + allocatedProjected;
    const vsTotal = T.projected - T.tgt;

    const scName = sc ? sc.name : 'Live only';
    $('#kpis').innerHTML = `
      <div class="kpi teal"><div class="k-lbl">${esc(baseline.name)} target · ${activeYear}${lead ? ' · your clients' : ''}</div><div class="k-val">${fmt(T.tgt)}</div><div class="k-sub">${lead ? 'Your submitted target' : 'Frozen baseline'}</div></div>
      <div class="kpi navy"><div class="k-lbl">Projected (rating 1–4)${sc?' · '+esc(scName):''}</div><div class="k-val">${fmt(T.projected)}</div><div class="k-sub">Booked + 90% + likely + adj</div></div>
      <div class="kpi"><div class="k-lbl">Booked (rating 1)</div><div class="k-val">${fmt(T.booked)}</div><div class="k-sub">Firm revenue</div></div>
      <div class="kpi"><div class="k-lbl">${vsTotal>=0?'Over target':'Remaining to target'}</div><div class="k-val ${vsTotal>=0?'num pos':'num neg'}">${vsTotal>=0?'+':''}${fmt(vsTotal)}</div><div class="k-sub">${T.tgt?((vsTotal/T.tgt)*100).toFixed(1)+'% of target':'—'}</div></div>`;

    $('#waterfall').hidden = false;
    $('#waterfall').innerHTML = buildWaterfall(T, vsTotal);
    $('#confidence').innerHTML = buildConfidence(rows, baseline);

    const sliceLabel = { client: 'Client', leader: 'Revenue Leader', industry: 'Industry', serviceLine: 'Service line', rating: 'Rating' }[sliceDim];

    // ---- Build the drill-down tree: bucket → group (slice key) → project ----
    const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const RBkey = (rt) => rt === 1 ? 'booked' : rt === 2 ? 'p90' : (rt >= 3 && rt <= 4) ? 'likely' : 'low';
    function projNode(r, pid) {
      const n = { id: pid + '/' + r.p.id, label: (r.p.project && r.p.project.name) || 'Untitled', level: 2, kind: 'project',
        tgt: null, booked: 0, p90: 0, likely: 0, low: 0, adjust: 0, byMonth: {}, kids: [], rating: r.rating, status: (r.p.project && r.p.project.status) || '' };
      n[RBkey(r.rating)] = r.yearTotal;
      Object.keys(r.byMonth || {}).forEach(mm => { n.byMonth[mm] = (n.byMonth[mm] || 0) + r.byMonth[mm]; });
      n.projected = n.booked + n.p90 + n.likely;        // low excluded
      return n;
    }
    function groupNode(g, pid) {
      const id = pid + '/' + g.key;
      const kids = (g.projects || []).map(r => projNode(r, id)).sort((a, b) => b.projected - a.projected);
      const byMonth = {};
      kids.forEach(k => Object.keys(k.byMonth).forEach(mm => { byMonth[mm] = (byMonth[mm] || 0) + k.byMonth[mm]; }));
      return { id, label: g.key, level: 1, kind: 'group', tgt: g.tgt, booked: g.booked, p90: g.p90, likely: g.likely, low: g.low,
        adjust: g.adjust, projected: g.projected, byMonth, kids, vsT: g.vsT, isNew: g.isNew };
    }
    function bucketNode(label, id, glist) {
      const kids = glist.map(g => groupNode(g, id));
      const agg = { id, label, level: 0, kind: 'bucket', tgt: 0, booked: 0, p90: 0, likely: 0, low: 0, adjust: 0, projected: 0, byMonth: {}, kids };
      kids.forEach(k => { agg.tgt += k.tgt || 0; agg.booked += k.booked; agg.p90 += k.p90; agg.likely += k.likely; agg.low += k.low; agg.adjust += k.adjust; agg.projected += k.projected; Object.keys(k.byMonth).forEach(mm => { agg.byMonth[mm] = (agg.byMonth[mm] || 0) + k.byMonth[mm]; }); });
      return agg;
    }
    const tree = [];
    if (sliceDim === 'client') {
      const ex = list.filter(g => !g.isNew), nw = list.filter(g => g.isNew);
      if (ex.length) tree.push(bucketNode('Existing Clients · Budget / RF1', 'bkt-ex', ex));
      if (nw.length) tree.push(bucketNode('New Clients / Projects · no baseline', 'bkt-new', nw));
    } else {
      tree.push(bucketNode(sliceLabel + 's', 'bkt-all', list));
    }
    // Below-the-line reserve + overall adjustment as leaf buckets.
    if (slushTarget || allocatedProjected) tree.push({ id: 'bkt-alloc', label: '↳ Allocated for New Business · incremental reserve', level: 0, kind: 'reserve', tgt: slushTarget, booked: 0, p90: 0, likely: 0, low: 0, adjust: 0, projected: allocatedProjected, byMonth: {}, kids: [], drawn: drawnNewBiz });
    if (overallAdj) tree.push({ id: 'bkt-adj', label: '＋ Overall adjustment', level: 0, kind: 'adj', tgt: null, booked: 0, p90: 0, likely: 0, low: 0, adjust: overallAdj, projected: overallAdj, byMonth: {}, kids: [] });

    LAST_TREE = { tree, T, sliceLabel, baselineName: baseline.name, mode: viewMode };

    // ---- Render rows honoring collapse state ----
    const isBktOpen = (id) => !COLLAPSED.has(id);
    const isGrpOpen = (id) => OPENGRP.has(id);
    const fmtCell = (v) => v ? fmt(v) : '—';
    const caret = (open) => `<span class="caret">${open ? '▾' : '▸'}</span>`;
    const monthCols = MO.map((mo, i) => `<th class="${i+1<curMonthIdx?'past':''} ${i+1===curMonthIdx?'cur':''}">${mo}</th>`).join('');

    let head, bodyRows = '';
    if (viewMode === 'month') {
      head = `<tr><th class="lbl">${sliceLabel}</th>${monthCols}<th>Total</th><th>Target</th><th>Rem.</th></tr>`;
    } else {
      head = `<tr><th class="lbl">${sliceLabel}</th><th>${esc(baseline.name)} target</th><th>Rating 1</th><th>Rating 2</th><th>Rating 3–4</th><th class="low">Rating 5–7</th><th>Adjust</th><th>Projected</th><th>Remaining</th><th>Status</th></tr>`;
    }
    const colCount = viewMode === 'month' ? 15 : 10;

    function rowFor(n, open, hasKids) {
      const pad = 6 + n.level * 18;
      const tw = `<td class="lbl" style="padding-left:${pad}px">${hasKids ? `<a href="#" class="tw" data-node="${esc(n.id)}" data-kind="${n.kind === 'bucket' || n.kind === 'reserve' || n.kind === 'adj' ? 'bkt' : 'grp'}">${caret(open)}</a>` : '<span class="caret-sp"></span>'}<span class="${n.level===0?'b0':n.level===1?'b1':'b2'}">${esc(n.label)}</span></td>`;
      if (viewMode === 'month') {
        const cells = MO.map((_, i) => { const v = n.byMonth[i + 1] || 0; return `<td class="${i+1<curMonthIdx?'past':''} ${i+1===curMonthIdx?'cur':''}">${v ? fmt(v) : '·'}</td>`; }).join('');
        const hasT = n.tgt != null && n.tgt > 0;
        const rem = hasT ? (n.projected - n.tgt) : null;
        return `<tr class="lvl${n.level} ${n.kind}">${tw}${cells}<td><strong>${fmtCell(n.projected)}</strong></td><td>${hasT ? fmt(n.tgt) : '—'}</td><td class="${hasT?(rem>=0?'num pos':'num neg'):''}">${hasT ? ((rem>=0?'+':'')+fmt(rem)) : '—'}</td></tr>`;
      }
      const hasT = n.tgt != null && (n.kind === 'reserve' ? n.tgt > 0 : n.tgt > 0);
      const vsT = hasT ? (n.projected - n.tgt) : null;
      const flag = !hasT ? (n.kind==='reserve'||n.kind==='adj'?'<span class="na">N/A</span>':'') : (Math.abs(vsT) < Math.max(1, n.tgt * 0.02) ? '<span class="flag at">At</span>' : (vsT > 0 ? '<span class="flag above">Above</span>' : '<span class="flag below">Below</span>'));
      const rem = hasT ? (vsT < 0 ? fmt(vsT) : (vsT > 0 ? '+' + fmt(vsT) : '✓')) : (n.kind==='reserve' && n.drawn>0 ? '−'+fmt(n.drawn)+' drawn' : '—');
      const statusCell = n.kind === 'project' ? `<td style="text-align:left;font-size:10px;color:var(--sav-steel);">${esc((STORE.STATUS_LABELS && STORE.STATUS_LABELS[n.status]) || n.status || '')}</td>` : `<td style="text-align:left;">${flag}</td>`;
      return `<tr class="lvl${n.level} ${n.kind}">${tw}<td>${hasT ? fmt(n.tgt) : '—'}</td><td class="bk-booked">${fmtCell(n.booked)}</td><td class="bk-p90">${fmtCell(n.p90)}</td><td class="bk-likely">${fmtCell(n.likely)}</td><td class="low">${fmtCell(n.low)}</td><td class="${n.adjust?(n.adjust>0?'num pos':'num neg'):''}">${n.adjust?((n.adjust>0?'+':'')+fmt(n.adjust)):'—'}</td><td><strong>${fmtCell(n.projected)}</strong></td><td class="${hasT?(vsT>=0?'num pos':'num neg'):'num neg'}">${rem}</td>${statusCell}</tr>`;
    }
    tree.forEach(bkt => {
      const bktOpen = isBktOpen(bkt.id);
      bodyRows += rowFor(bkt, bktOpen, (bkt.kids || []).length > 0);
      if (!bktOpen) return;
      (bkt.kids || []).forEach(grp => {
        const grpOpen = isGrpOpen(grp.id);
        bodyRows += rowFor(grp, grpOpen, (grp.kids || []).length > 0);
        if (grpOpen) (grp.kids || []).forEach(pr => { bodyRows += rowFor(pr, false, false); });
      });
    });

    let footCells;
    if (viewMode === 'month') {
      const mtot = MO.map((_, i) => { let s = 0; tree.forEach(b => { s += b.byMonth[i + 1] || 0; }); return `<td>${s ? fmt(s) : '·'}</td>`; }).join('');
      footCells = `${mtot}<td><strong>${fmt(T.projected)}</strong></td><td>${fmt(T.tgt)}</td><td class="${vsTotal>=0?'num pos':'num neg'}">${vsTotal>=0?'+':''}${fmt(vsTotal)}</td>`;
    } else {
      footCells = `<td>${fmt(T.tgt)}</td><td class="bk-booked">${fmt(T.booked)}</td><td class="bk-p90">${fmt(T.p90)}</td><td class="bk-likely">${fmt(T.likely)}</td><td class="low">${fmt(T.low)}</td><td class="${T.adjust?(T.adjust>0?'num pos':'num neg'):''}">${T.adjust?(T.adjust>0?'+':'')+fmt(T.adjust):'—'}</td><td>${fmt(T.projected)}</td><td class="${vsTotal>=0?'num pos':'num neg'}">${vsTotal>=0?'+':''}${fmt(vsTotal)}</td><td></td>`;
    }
    const html = `<thead>${head}</thead><tbody>${bodyRows}</tbody><tfoot><tr class="tot"><td class="lbl">Total</td>${footCells}</tr></tfoot>`;
    $('#cmp-table').innerHTML = html;
    renderEntries();
    renderMonthly(rows, baseline, isFuture, T.tgt);
    renderExec(rows, T, baseline);
    applyViewTab();

    $('#studio-foot').innerHTML = `<strong>Projected</strong> = Rating 1 (Booked) + Rating 2 (90%) + Rating 3–4 (Likely) + adjustments. Rating 5–7 is greyed and excluded. <strong>Existing Clients</strong> have a Budget / RF1 target; <strong>New Clients / Projects</strong> have no baseline. <strong>Allocated for New Business</strong> is the budgeted new-biz reserve — it draws down as real new clients land, so it offsets their gains instead of double-counting. <strong>Remaining</strong> is the gap to target (negative) or amount over (positive).` + (sliceDim !== 'client' ? ` <em>${esc(sliceLabel)} has no baseline target (Budget is client-level).</em>` : '');
  }

  /* ---- Toggle build vs exec view ---- */
  function applyViewTab() {
    const body = $('#studio-body'); if (!body) return;
    body.setAttribute('data-view', viewTab);
    const bv = $('#build-view'), ev = $('#exec-view');
    if (bv) bv.hidden = viewTab !== 'build';
    if (ev) ev.hidden = viewTab !== 'exec';
  }

  /* ---- Exec report: concentration, ageing, mix — project-level, leader-scoped ---- */
  function renderExec(rows, T, baseline) {
    const host = $('#exec-view'); if (!host) return;
    const proj = (r) => (r.rating <= 4 ? r.yearTotal : 0);     // projected $ = rating 1–4
    const live = rows.filter(r => !/future business|unalloc|slush|^tbd$|incremental|new business opportun|new business$/i.test(r.client || ''));
    const totalProj = live.reduce((a, r) => a + proj(r), 0) || 1;
    const now = Date.now();

    /* 1 · Client concentration (Pareto) */
    const byClient = {};
    live.forEach(r => { const k = r.client; byClient[k] = (byClient[k] || 0) + proj(r); });
    const clients = Object.entries(byClient).map(([k, v]) => ({ k, v })).filter(c => c.v > 0).sort((a, b) => b.v - a.v);
    const maxC = clients.length ? clients[0].v : 1;
    let cum = 0, n80 = 0, hit80 = false;
    const pareto = clients.map((c, i) => {
      cum += c.v; const cumPct = cum / totalProj * 100;
      const inTop = !hit80; if (cumPct >= 80 && !hit80) { hit80 = true; n80 = i + 1; }
      return { ...c, share: c.v / totalProj * 100, cumPct, inTop };
    });
    if (!n80) n80 = clients.length;
    const topShare = clients.slice(0, n80).reduce((a, c) => a + c.v, 0) / totalProj * 100;
    const paretoRows = pareto.slice(0, 12).map(c => `<tr class="${c.inTop ? 'in80' : 'tail80'}">
      <td class="l">${esc(c.k)}</td>
      <td class="num">${fmt(c.v)}</td>
      <td class="num">${c.share.toFixed(1)}%</td>
      <td class="barcell"><div class="bar ${c.inTop ? '' : 'tail'}" style="width:${Math.max(2, c.v / maxC * 100)}%"></div><div class="cum" style="left:${Math.min(100, c.cumPct)}%"></div></td>
      <td class="num">${c.cumPct.toFixed(0)}%</td></tr>`).join('');
    const moreC = pareto.length > 12 ? `<tr class="tail80"><td class="l">+ ${pareto.length - 12} more clients</td><td class="num">${fmt(pareto.slice(12).reduce((a,c)=>a+c.v,0))}</td><td class="num"></td><td></td><td class="num">100%</td></tr>` : '';

    /* 2 · Pipeline by stage + ageing */
    const RB = (rt) => rt === 1 ? 'booked' : rt === 2 ? 'p90' : (rt >= 3 && rt <= 4) ? 'likely' : 'low';
    const stageMeta = { booked: ['Booked', 'Rating 1'], p90: ['90% · Verbal', 'Rating 2'], likely: ['Likely', 'Rating 3–4'], low: ['Low likelihood', 'Rating 5–7'] };
    const stages = { booked: [], p90: [], likely: [], low: [] };
    live.forEach(r => stages[RB(r.rating)].push(r));
    const ageOf = (r) => { const c = Date.parse(r.p.createdAt || ''); return isFinite(c) ? Math.max(0, Math.round((now - c) / 86400000)) : null; };
    const agePill = (d) => d == null ? '<span class="age-pill">—</span>' : `<span class="age-pill ${d <= 30 ? 'fresh' : d <= 90 ? 'mid' : 'stale'}">${d}d</span>`;
    const stageRows = ['booked','p90','likely','low'].map(s => {
      const list = stages[s]; if (!list.length) return '';
      const sum = list.reduce((a, r) => a + r.yearTotal, 0);
      const ages = list.map(ageOf).filter(d => d != null);
      const avgAge = ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : null;
      return `<tr class="stage-row"><td class="l"><span class="stage-dot ${s}"></span>${stageMeta[s][0]} <span style="color:var(--sav-steel);font-weight:400;font-size:10px">${stageMeta[s][1]}</span></td>
        <td class="num">${list.length}</td><td class="num">${fmt(sum)}</td><td class="num">${agePill(avgAge)}</td></tr>`;
    }).join('');

    /* 3 · Mix rollups (industry, service line) */
    function mix(dim, label) {
      const by = {};
      live.forEach(r => { const k = r[dim] || '—'; by[k] = (by[k] || 0) + proj(r); });
      const arr = Object.entries(by).map(([k, v]) => ({ k, v })).filter(x => x.v > 0).sort((a, b) => b.v - a.v);
      const mx = arr.length ? arr[0].v : 1;
      const body = arr.slice(0, 8).map(x => `<tr><td class="l">${esc(x.k)}</td><td class="num">${fmt(x.v)}</td><td class="num">${(x.v/totalProj*100).toFixed(0)}%</td><td><div class="share"><i style="width:${Math.max(3, x.v/mx*100)}%"></i></div></td></tr>`).join('');
      return `<div class="exec-card"><h2>${label}</h2><div class="ec-sub">Projected $ share · rating 1–4</div>
        <table class="roll"><thead><tr><th class="l">${label}</th><th>$</th><th>Share</th><th> </th></tr></thead>
        <tbody>${body}</tbody></table></div>`;
    }

    host.innerHTML = `
      <div class="exec-grid">
        <div class="exec-card wide">
          <h2>Client concentration</h2>
          <div class="ec-sub">Projected revenue by client, ranked · dashed line = cumulative share</div>
          <div class="exec-callout">Top <strong>${n80}</strong> ${n80 === 1 ? 'client' : 'clients'} = <strong>${topShare.toFixed(0)}%</strong> of the projected book · ${clients.length} clients total · ${fmt(totalProj)} projected</div>
          <table class="pareto"><thead><tr><th class="l">Client</th><th>Projected</th><th>Share</th><th class="l"> </th><th>Cum.</th></tr></thead>
          <tbody>${paretoRows}${moreC}</tbody></table>
        </div>
        <div class="exec-card">
          <h2>Pipeline by stage &amp; age</h2>
          <div class="ec-sub">Count, value and average age since created</div>
          <table class="roll"><thead><tr><th class="l">Stage</th><th># </th><th>Value</th><th>Avg age</th></tr></thead>
          <tbody>${stageRows}</tbody>
          <tbody><tr class="tot"><td class="l">All pipeline</td><td class="num">${live.length}</td><td class="num">${fmt(live.reduce((a,r)=>a+r.yearTotal,0))}</td><td></td></tr></tbody></table>
        </div>
        ${mix('industry', 'By industry')}
        ${mix('serviceLine', 'By service line')}
        <div class="exec-card">
          <h2>Margin</h2>
          <div class="ec-sub">Planned basis · floor-rate</div>
          <div class="exec-callout" style="border-left-color:#8a6abf">Margin analysis is <strong>planned-only</strong> today — computed against floor rates. <strong>Actuals pending Clockify</strong> (join on Salesforce ID). Once live, this card shows planned vs. actual margin by client and service line.</div>
        </div>
      </div>`;
  }

  /* ---- Monthly stacked chart + table, colored by likelihood ---- */
  function renderMonthly(rows, baseline, isFuture, sliceTarget) {
    const host = $('#monthly'); if (!host) return;
    const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const now = new Date(); const curMonth = (activeYear === now.getFullYear()) ? now.getMonth() + 1 : (activeYear < now.getFullYear() ? 13 : 0);
    const m = MO.map(() => ({ booked: 0, p90: 0, likely: 0, low: 0 }));
    rows.forEach(r => {
      if (isFuture && isFuture(r.client)) return;     // slush excluded from the curve
      const b = r.rating === 1 ? 'booked' : r.rating === 2 ? 'p90' : (r.rating >= 3 && r.rating <= 4) ? 'likely' : 'low';
      Object.keys(r.byMonth).forEach(mm => { const i = (+mm) - 1; if (i >= 0 && i < 12) m[i][b] += r.byMonth[mm]; });
    });
    const liveMonthTotal = (i) => m[i].booked + m[i].p90 + m[i].likely;   // 1–4 (low excluded)
    const trendLine = MO.map((_, i) => m[i].booked + m[i].p90);           // current trending = rating 1+2

    // Target line, scoped to the current slice's target (so a leader sees only their own).
    const annualTgt = (sliceTarget != null && sliceTarget > 0) ? sliceTarget : (baseline.total || 0);
    let pastActual = 0; for (let i = 0; i < 12; i++) if (i + 1 < curMonth) pastActual += liveMonthTotal(i);
    const remMonths = Math.max(1, 12 - Math.max(0, curMonth - 1));
    const remPerMonth = Math.max(0, (annualTgt - pastActual)) / remMonths;
    const tgtLine = MO.map((_, i) => (i + 1 < curMonth) ? liveMonthTotal(i) : remPerMonth);

    // Nice rounded axis top so gridlines read in clean increments.
    const rawMax = Math.max(1, ...MO.map((_, i) => Math.max(liveMonthTotal(i), tgtLine[i])));
    const niceStep = (() => {
      const rough = rawMax / 4;
      const mag = Math.pow(10, Math.floor(Math.log10(rough)));
      const norm = rough / mag;
      const s = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
      return s * mag;
    })();
    const maxV = Math.max(niceStep, Math.ceil(rawMax / niceStep) * niceStep);
    const H = 230;
    const px = (v) => Math.max(0, (v / maxV) * H);
    const fmtShort = (v) => v >= 1e6 ? '$' + (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M'
      : v >= 1e3 ? '$' + Math.round(v / 1e3) + 'K' : '$' + Math.round(v);

    // Horizontal gridlines + dollar axis labels.
    const ticks = []; for (let g = 0; g <= maxV + 1; g += niceStep) ticks.push(g);
    const grid = ticks.map(t => `<div class="gline" style="bottom:${px(t)}px"><span class="ylab">${fmtShort(t)}</span></div>`).join('');

    const bars = MO.map((mo, i) => {
      const seg = (v, cls) => v > 0 ? `<div class="seg ${cls}" style="height:${px(v)}px" title="${mo}: ${cls} ${fmt(v)}"></div>` : '';
      const tot = liveMonthTotal(i);
      const isPast = i + 1 < curMonth, isCur = i + 1 === curMonth;
      return `<div class="mcol2 ${isCur ? 'cur' : ''}">
        <div class="mbar" style="height:${H}px">
          ${tot > 0 ? `<div class="btot" style="bottom:${Math.min(H - 2, px(tot) + 3)}px">${fmtShort(tot)}</div>` : ''}
          ${seg(m[i].booked, 'booked')}${seg(m[i].p90, 'p90')}${seg(m[i].likely, 'likely')}
          <div class="trd" style="bottom:${px(trendLine[i])}px" title="${mo} trending (1+2) ${fmt(trendLine[i])}"></div>
          <div class="tgt" style="bottom:${px(tgtLine[i])}px" title="${mo} target ${fmt(tgtLine[i])}"></div>
        </div>
        <div class="mlbl ${isPast ? 'past' : ''} ${isCur ? 'cur' : ''}">${mo}</div>
      </div>`;
    }).join('');

    const trow = (lbl, cls, vals, bold) => `<tr class="${bold ? 'tot' : ''}"><td class="lbl">${lbl}</td>${vals.map(v => `<td class="${cls}">${v ? fmt(v) : '·'}</td>`).join('')}<td class="${cls}"><strong>${fmt(vals.reduce((a, b) => a + b, 0))}</strong></td></tr>`;
    const tvar = (lbl, vals) => { const sum = vals.reduce((a, b) => a + b, 0); return `<tr class="tot var-row"><td class="lbl">${lbl}</td>${vals.map(v => `<td class="${v >= 0 ? 'num pos' : 'num neg'}">${v ? (v > 0 ? '+' : '') + fmt(v) : '·'}</td>`).join('')}<td class="${sum >= 0 ? 'num pos' : 'num neg'}"><strong>${(sum > 0 ? '+' : '') + fmt(sum)}</strong></td></tr>`; };
    const tableHtml = `<table class="cmp mtbl"><thead><tr><th class="lbl">By month · ${activeYear}</th>${MO.map((mo, i) => `<th class="${i+1<curMonth?'past':''} ${i+1===curMonth?'cur':''}">${mo}</th>`).join('')}<th>Total</th></tr></thead><tbody>
      ${trow('Rating 1 · Booked', 'bk-booked', m.map(x => x.booked))}
      ${trow('Rating 2 · 90%', 'bk-p90', m.map(x => x.p90))}
      ${trow('Rating 3–4 · Likely', 'bk-likely', m.map(x => x.likely))}
      ${trow('Rating 5–7 · Low', 'low', m.map(x => x.low))}
      ${trow('Target', '', tgtLine, true)}
      ${trow('Current trending (1+2)', 'bk-p90', trendLine, true)}
      ${tvar('Variance · trending − target', trendLine.map((t, i) => t - tgtLine[i]))}
    </tbody></table>`;

    host.innerHTML = `
      <div class="mhead">
        <h2>By month · ${activeYear}</h2>
        <div class="legend">
          <span><i class="sw booked"></i>Rating 1 · Booked</span>
          <span><i class="sw p90"></i>Rating 2 · 90%</span>
          <span><i class="sw likely"></i>Rating 3–4 · Likely</span>
          <span><i class="sw trend"></i>Trending (1+2)</span>
          <span><i class="sw tgtsw"></i>Target</span>
        </div>
      </div>
      <div class="chart"><div class="grid">${grid}</div>${bars}</div>
      <div class="table-wrap">${tableHtml}</div>`;
  }

  /* Export the current view (slice + granularity + full drill-down) to Excel. */
  function exportView() {
    if (typeof XLSX === 'undefined') { alert('Excel library not loaded.'); return; }
    if (!LAST_TREE) { alert('Nothing to export yet.'); return; }
    const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const { tree, T, sliceLabel, baselineName, mode } = LAST_TREE;
    const aoa = [];
    if (mode === 'month') {
      aoa.push([sliceLabel, ...MO, 'Total', 'Target', 'Remaining']);
      const push = (n, depth) => {
        const hasT = n.tgt != null && n.tgt > 0;
        aoa.push(['  '.repeat(depth) + n.label, ...MO.map((_, i) => Math.round(n.byMonth[i + 1] || 0)), Math.round(n.projected), hasT ? Math.round(n.tgt) : '', hasT ? Math.round(n.projected - n.tgt) : '']);
        (n.kids || []).forEach(k => push(k, depth + 1));
      };
      tree.forEach(b => push(b, 0));
      aoa.push(['Total', ...MO.map((_, i) => Math.round(tree.reduce((s, b) => s + (b.byMonth[i + 1] || 0), 0))), Math.round(T.projected), Math.round(T.tgt), Math.round(T.projected - T.tgt)]);
    } else {
      aoa.push([sliceLabel, baselineName + ' target', 'Rating 1', 'Rating 2', 'Rating 3-4', 'Rating 5-7', 'Adjust', 'Projected', 'Remaining']);
      const push = (n, depth) => {
        const hasT = n.tgt != null && n.tgt > 0;
        aoa.push(['  '.repeat(depth) + n.label, hasT ? Math.round(n.tgt) : '', Math.round(n.booked), Math.round(n.p90), Math.round(n.likely), Math.round(n.low), Math.round(n.adjust), Math.round(n.projected), hasT ? Math.round(n.projected - n.tgt) : '']);
        (n.kids || []).forEach(k => push(k, depth + 1));
      };
      tree.forEach(b => push(b, 0));
      aoa.push(['Total', Math.round(T.tgt), Math.round(T.booked), Math.round(T.p90), Math.round(T.likely), Math.round(T.low), Math.round(T.adjust), Math.round(T.projected), Math.round(T.projected - T.tgt)]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Revenue Studio');
    const lead = effectiveLeader();
    const fname = `Revenue Studio · ${baselineName} · ${sliceLabel} · ${activeYear}${lead ? ' · ' + lead.displayName : ''} (${mode}).xlsx`;
    XLSX.writeFile(wb, fname);
  }

  /* Scenario entry chips (pool + adjustments) below the table */
  function renderEntries() {
    const box = $('#entries'); if (!box) return;
    const sc = activeScenario();
    if (!sc || !(sc.adjustments || []).length) { box.innerHTML = sc ? '<span class="entries-empty">No adjustments yet. Add a future-projects pool or a manual adjustment above.</span>' : ''; return; }
    box.innerHTML = '<div class="entries-lbl">Scenario adjustments</div>' + sc.adjustments.filter(a => a.year === activeYear).map(a => {
      const where = a.key ? `${a.dim}: ${esc(a.key)}` : 'overall';
      const cls = a.type === 'pool' ? 'pool' : (a.annual >= 0 ? 'add' : 'sub');
      return `<span class="entry ${cls}">${a.type === 'pool' ? '◆ pool' : (a.annual >= 0 ? '+ adj' : '− adj')} · ${where} · ${(a.annual>=0?'':'-')}${fmt(Math.abs(a.annual))}${a.note ? ' · ' + esc(a.note) : ''} <a href="#" onclick="__studioRemoveEntry('${a.id}');return false;">✕</a></span>`;
    }).join('');
  }

  if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(ready); else window.addEventListener('load', ready);
})();
