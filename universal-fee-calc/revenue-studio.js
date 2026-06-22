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
      let yearTotal = 0;
      series.forEach(s => { if (s.year === activeYear) yearTotal += s.amount; });
      const pj = p.project || {};
      const leader = STORE.resolveLeader(pj.leadId || pj.lead);
      const created = Date.parse(p.createdAt || '');
      return {
        p, yearTotal,
        rating: STORE.ratingFor(p),
        isNew: isFinite(cutoff) && isFinite(created) && created > cutoff,   // new-since-baseline → draws pool
        client: (pj.client || '—').trim() || '—',
        leader: leader ? leader.displayName : (pj.lead || '—'),
        industry: (pj.industry || '—').trim() || '—',
        serviceLine: (STORE.projectServiceLines(p)[0] || '—'),
      };
    });
  }
  function sliceKey(row) { return row[sliceDim] || '—'; }

  function render() {
    const lead = effectiveLeader();
    document.body.classList.toggle('leader-mode', !!lead);
    const banner = $('#leader-banner');
    if (lead) {
      banner.hidden = false;
      banner.innerHTML = (isAdminUser ? 'Previewing what <strong>' + esc(lead.displayName) + '</strong> sees · ' : 'Signed in as <strong>' + esc(lead.displayName) + '</strong> · ') + 'read-only — only your projects and the pools assigned to you. Pools are set by admins.';
    } else { banner.hidden = true; }

    const baseline = activeBaselineId ? STORE.getBaseline(activeBaselineId) : null;
    if (!baseline) { $('#no-baseline').hidden = false; $('#cmp-table').innerHTML = ''; $('#kpis').innerHTML = ''; $('#studio-foot').textContent = ''; renderEntries(); return; }
    $('#no-baseline').hidden = true;

    const sc = activeScenario();
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

    // Group live by slice; firm (r1) vs in-play (2-4); drawdown = new-since-baseline live.
    const groups = {};
    rows.forEach(r => {
      const k = sliceKey(r);
      const g = groups[k] || (groups[k] = { key: k, live: 0, firm: 0, inplay: 0, drawn: 0 });
      g.live += r.yearTotal;
      if (r.rating === 1) g.firm += r.yearTotal; else if (r.rating >= 2 && r.rating <= 4) g.inplay += r.yearTotal;
      if (r.isNew) g.drawn += r.yearTotal;     // consumes the pool
    });
    if (sliceDim === 'client') Object.keys(baseByClient).forEach(c => { if (lead && !(leaderClients && leaderClients.has(c))) return; if (!groups[c]) groups[c] = { key: c, live: 0, firm: 0, inplay: 0, drawn: 0 }; });
    adjustEntries.forEach(a => { if (a.key && a.dim === sliceDim && !groups[a.key]) groups[a.key] = { key: a.key, live: 0, firm: 0, inplay: 0, drawn: 0 }; });

    const list = Object.values(groups).map(g => {
      const pool = poolFor(g.key);
      const remaining = Math.max(0, pool - g.drawn);     // unbooked future work still expected
      const adjust = adjFor(g.key);
      const scenario = g.live + remaining + adjust;       // live already includes drawn bookings
      const tgt = targetForSlice(g.key);
      return { ...g, pool, remaining, adjust, scenario, tgt, overCap: pool > 0 && g.drawn > pool + 0.5 };
    }).sort((a, b) => (b.tgt || b.scenario) - (a.tgt || a.scenario));

    // Totals
    let T = { tgt: 0, live: 0, firm: 0, inplay: 0, pool: 0, drawn: 0, remaining: 0, adjust: 0, scenario: 0 };
    list.forEach(g => { T.tgt += g.tgt || 0; T.live += g.live; T.firm += g.firm; T.inplay += g.inplay; T.pool += g.pool; T.drawn += g.drawn; T.remaining += g.remaining; T.adjust += g.adjust; T.scenario += g.scenario; });
    // Overall (unsliced) pool + adjustment add at the total level
    T.pool += overallPool; T.remaining += Math.max(0, overallPool); T.adjust += overallAdj;
    T.scenario += Math.max(0, overallPool) + overallAdj;

    const variance = T.scenario - T.tgt;
    const scName = sc ? sc.name : 'Live only';
    $('#kpis').innerHTML = `
      <div class="kpi teal"><div class="k-lbl">${esc(baseline.name)} target · ${activeYear}</div><div class="k-val">${fmt(T.tgt)}</div><div class="k-sub">Frozen baseline</div></div>
      <div class="kpi navy"><div class="k-lbl">Scenario · ${esc(scName)}</div><div class="k-val">${fmt(T.scenario)}</div><div class="k-sub">Live + pool + adjustments</div></div>
      <div class="kpi"><div class="k-lbl">Booked (r1)</div><div class="k-val">${fmt(T.firm)}</div><div class="k-sub">Firm revenue</div></div>
      <div class="kpi"><div class="k-lbl">Variance vs target</div><div class="k-val ${variance>=0?'num pos':'num neg'}">${variance>=0?'+':''}${fmt(variance)}</div><div class="k-sub">${T.tgt?((variance/T.tgt)*100).toFixed(1)+'% of target':'—'}</div></div>`;

    const sliceLabel = { client: 'Client', leader: 'Revenue Leader', industry: 'Industry', serviceLine: 'Service line', rating: 'Rating' }[sliceDim];
    let html = `<thead><tr>
      <th class="lbl">${sliceLabel}</th>
      <th>${esc(baseline.name)} target</th>
      <th>Live</th><th>Booked</th>
      <th>Future pool</th><th>Drawn</th><th>Remaining</th>
      <th>Adjust</th><th>Scenario</th><th>Variance</th><th>Status</th>
    </tr></thead><tbody>`;
    list.forEach(g => {
      const hasT = g.tgt != null;
      const v = hasT ? (g.scenario - g.tgt) : null;
      const flag = !hasT ? '' : (Math.abs(v) < Math.max(1, g.tgt * 0.02) ? '<span class="flag at">At</span>' : (v > 0 ? '<span class="flag above">Above</span>' : '<span class="flag below">Below</span>'));
      html += `<tr>
        <td class="lbl">${esc(g.key)}</td>
        <td>${hasT ? fmt(g.tgt) : '—'}</td>
        <td>${fmt(g.live)}</td>
        <td>${fmt(g.firm)}</td>
        <td>${g.pool ? fmt(g.pool) : '—'}</td>
        <td>${g.drawn ? fmt(g.drawn) : '—'}</td>
        <td class="${g.overCap?'num neg':''}">${g.pool ? fmt(g.remaining) + (g.overCap ? ' ⚠' : '') : '—'}</td>
        <td class="${g.adjust?(g.adjust>0?'num pos':'num neg'):''}">${g.adjust ? (g.adjust>0?'+':'')+fmt(g.adjust) : '—'}</td>
        <td><strong>${fmt(g.scenario)}</strong></td>
        <td class="${v==null?'':(v>=0?'num pos':'num neg')}">${v==null?'—':(v>=0?'+':'')+fmt(v)}</td>
        <td style="text-align:left;">${flag}</td>
      </tr>`;
    });
    if (overallPool || overallAdj) {
      html += `<tr><td class="lbl">＋ Overall (unallocated)</td><td>—</td><td>—</td><td>—</td><td>${overallPool?fmt(overallPool):'—'}</td><td>—</td><td>${overallPool?fmt(Math.max(0,overallPool)):'—'}</td><td class="${overallAdj?(overallAdj>0?'num pos':'num neg'):''}">${overallAdj?(overallAdj>0?'+':'')+fmt(overallAdj):'—'}</td><td><strong>${fmt(Math.max(0,overallPool)+overallAdj)}</strong></td><td>—</td><td></td></tr>`;
    }
    html += `</tbody><tfoot><tr class="tot">
      <td class="lbl">Total</td><td>${fmt(T.tgt)}</td><td>${fmt(T.live)}</td><td>${fmt(T.firm)}</td>
      <td>${fmt(T.pool)}</td><td>${fmt(T.drawn)}</td><td>${fmt(T.remaining)}</td>
      <td class="${T.adjust?(T.adjust>0?'num pos':'num neg'):''}">${T.adjust?(T.adjust>0?'+':'')+fmt(T.adjust):'—'}</td>
      <td>${fmt(T.scenario)}</td>
      <td class="${variance>=0?'num pos':'num neg'}">${variance>=0?'+':''}${fmt(variance)}</td><td></td>
    </tr></tfoot>`;
    $('#cmp-table').innerHTML = html;
    renderEntries();

    $('#studio-foot').innerHTML = `Scenario = Live + remaining future pool + adjustments. <strong>Drawn</strong> = revenue from projects created after the baseline date (${esc((baseline.submittedAt||'').slice(0,10))}) — these consume the pool. Pools/adjustments live only in the scenario; project data is untouched.` + (sliceDim !== 'client' ? ` <em>${esc(sliceLabel)} has no baseline target (Budget is client-level).</em>` : '');
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
