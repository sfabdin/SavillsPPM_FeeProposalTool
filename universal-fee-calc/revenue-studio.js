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
      const g = groups[k] || (groups[k] = { key: k, booked: 0, p90: 0, likely: 0, low: 0 });
      g[RB(r.rating)] += r.yearTotal;
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

    const sliceLabel = { client: 'Client', leader: 'Revenue Leader', industry: 'Industry', serviceLine: 'Service line', rating: 'Rating' }[sliceDim];
    let html = `<thead><tr>
      <th class="lbl">${sliceLabel}</th>
      <th>${esc(baseline.name)} target</th>
      <th>Rating 1</th><th>Rating 2</th><th>Rating 3–4</th>
      <th class="low">Rating 5–7</th>
      <th>Adjust</th><th>Projected</th><th>Remaining</th><th>Status</th>
    </tr></thead><tbody>`;
    let existingShown = false, newSectionShown = false;
    list.forEach(g => {
      if (sliceDim === 'client' && !g.isNew && !existingShown) {
        existingShown = true;
        html += `<tr class="section-row"><td class="lbl" colspan="10">Existing Clients · have a Budget / RF1 target</td></tr>`;
      }
      if (sliceDim === 'client' && g.isNew && !newSectionShown) {
        newSectionShown = true;
        html += `<tr class="section-row"><td class="lbl" colspan="10">New Clients / Projects · no baseline target</td></tr>`;
      }
      const hasT = g.tgt != null;
      const flag = !hasT ? '' : (Math.abs(g.vsT) < Math.max(1, g.tgt * 0.02) ? '<span class="flag at">At</span>' : (g.vsT > 0 ? '<span class="flag above">Above</span>' : '<span class="flag below">Below</span>'));
      const rem = hasT ? (g.vsT < 0 ? fmt(g.vsT) : (g.vsT > 0 ? '+' + fmt(g.vsT) : '✓')) : '—';
      html += `<tr>
        <td class="lbl">${esc(g.key)}</td>
        <td>${hasT ? fmt(g.tgt) : '—'}</td>
        <td class="bk-booked">${g.booked ? fmt(g.booked) : '—'}</td>
        <td class="bk-p90">${g.p90 ? fmt(g.p90) : '—'}</td>
        <td class="bk-likely">${g.likely ? fmt(g.likely) : '—'}</td>
        <td class="low">${g.low ? fmt(g.low) : '—'}</td>
        <td class="${g.adjust?(g.adjust>0?'num pos':'num neg'):''}">${g.adjust ? (g.adjust>0?'+':'')+fmt(g.adjust) : '—'}</td>
        <td><strong>${fmt(g.projected)}</strong></td>
        <td class="${hasT?(g.vsT>=0?'num pos':'num neg'):''}">${rem}</td>
        <td style="text-align:left;">${flag}</td>
      </tr>`;
    });
    if (overallAdj) {
      html += `<tr><td class="lbl">＋ Overall adjustment</td><td>—</td><td>—</td><td>—</td><td>—</td><td class="low">—</td><td class="${overallAdj>0?'num pos':'num neg'}">${(overallAdj>0?'+':'')+fmt(overallAdj)}</td><td><strong>${fmt(overallAdj)}</strong></td><td>—</td><td class="na">N/A</td></tr>`;
    }
    if (slushTarget || allocatedProjected) {
      const drawnNote = drawnNewBiz > 0 ? '−' + fmt(drawnNewBiz) + ' drawn' : '';
      html += `<tr class="fbiz"><td class="lbl">↳ Allocated for New Business · incremental reserve</td><td>${slushTarget ? fmt(slushTarget) : '—'}</td><td>—</td><td>—</td><td>—</td><td class="low">—</td><td class="num pos">+${fmt(allocatedProjected)}</td><td><strong>${fmt(allocatedProjected)}</strong></td><td class="num neg">${drawnNote}</td><td class="na">N/A</td></tr>`;
    }
    html += `</tbody><tfoot><tr class="tot">
      <td class="lbl">Total</td><td>${fmt(T.tgt)}</td>
      <td class="bk-booked">${fmt(T.booked)}</td><td class="bk-p90">${fmt(T.p90)}</td><td class="bk-likely">${fmt(T.likely)}</td>
      <td class="low">${fmt(T.low)}</td>
      <td class="${T.adjust?(T.adjust>0?'num pos':'num neg'):''}">${T.adjust?(T.adjust>0?'+':'')+fmt(T.adjust):'—'}</td>
      <td>${fmt(T.projected)}</td>
      <td class="${vsTotal>=0?'num pos':'num neg'}">${vsTotal>=0?'+':''}${fmt(vsTotal)}</td><td></td>
    </tr></tfoot>`;
    $('#cmp-table').innerHTML = html;
    renderEntries();
    renderMonthly(rows, baseline, isFuture, T.tgt);

    $('#studio-foot').innerHTML = `<strong>Projected</strong> = Rating 1 (Booked) + Rating 2 (90%) + Rating 3–4 (Likely) + adjustments. Rating 5–7 is greyed and excluded. <strong>Existing Clients</strong> have a Budget / RF1 target; <strong>New Clients / Projects</strong> have no baseline. <strong>Allocated for New Business</strong> is the budgeted new-biz reserve — it draws down as real new clients land, so it offsets their gains instead of double-counting. <strong>Remaining</strong> is the gap to target (negative) or amount over (positive).` + (sliceDim !== 'client' ? ` <em>${esc(sliceLabel)} has no baseline target (Budget is client-level).</em>` : '');
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
