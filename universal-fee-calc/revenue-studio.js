/* ============================================================
   SAVILLS PPM · REVENUE STUDIO  (Phase A)
   ------------------------------------------------------------
   Admin-gated. Compares a frozen baseline (Budget / RFx) against
   the LIVE roll-up from project records, sliced by client / leader
   / industry / service line / rating, flagged at/below/above.
   Reads project data read-only; baselines live in the separate
   studio store (studio.json). Never writes to projects.
   ============================================================ */
(function () {
  'use strict';
  const STORE = window.UFC_Store;
  const CATALOG = window.RATES_CATALOG;
  const $ = (s) => document.querySelector(s);
  const fmt = (n) => (n < 0 ? '-' : '') + '$' + Math.round(Math.abs(n)).toLocaleString();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let activeBaselineId = null;
  let sliceDim = 'client';
  let activeYear = 2026;

  function ready() {
    // Admin gate
    const me = STORE.getCurrentUser();
    if (!STORE.isAdmin(me)) {
      $('#gate').hidden = false;
      $('#gate').innerHTML = 'Revenue Studio is admin-only. You\'re signed in as <strong>' + esc(me.name || 'unknown') + '</strong>.';
      return;
    }
    $('#studio-body').hidden = false;
    // year options
    $('#year-sel').innerHTML = [2025, 2026, 2027, 2028].map(y => `<option value="${y}" ${y === activeYear ? 'selected' : ''}>${y}</option>`).join('');
    $('#slice-sel').addEventListener('change', e => { sliceDim = e.target.value; render(); });
    $('#year-sel').addEventListener('change', e => { activeYear = +e.target.value; render(); });
    $('#baseline-sel').addEventListener('change', e => { activeBaselineId = e.target.value; render(); });
    $('#load-budget-btn').addEventListener('click', () => $('#budget-file').click());
    $('#budget-file').addEventListener('change', onBudgetFile);
    refreshBaselineSel();
    render();
  }

  function refreshBaselineSel() {
    const bls = STORE.listBaselines();
    const sel = $('#baseline-sel');
    if (!bls.length) { sel.innerHTML = '<option value="">— none loaded —</option>'; activeBaselineId = null; return; }
    if (!activeBaselineId || !bls.find(b => b.id === activeBaselineId)) activeBaselineId = bls[0].id;
    sel.innerHTML = bls.map(b => `<option value="${b.id}" ${b.id === activeBaselineId ? 'selected' : ''}>${esc(b.name)} · ${fmt(b.total)}</option>`).join('');
  }

  async function onBudgetFile(e) {
    const f = e.target.files[0]; if (!f) return;
    try {
      const wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
      // Expect: col0 = Client, col1 = annual $. Skip header + non-numeric rows.
      const clientAnnual = {};
      aoa.forEach(row => {
        const name = (row[0] || '').toString().trim();
        const amt = parseFloat(row[1]);
        if (!name || !isFinite(amt) || /client/i.test(name) || /total/i.test(name)) return;
        clientAnnual[name] = (clientAnnual[name] || 0) + amt;
      });
      const n = Object.keys(clientAnnual).length;
      if (!n) { alert('No client rows found. Expected Client in column A, annual $ in column B.'); return; }
      // Create two distinct baselines with the same numbers: Budget + RF1.
      const budget = STORE.baselineFromBudget('2026 Budget', 'budget', activeYear, clientAnnual, activeYear + '-01-01');
      STORE.saveBaseline(budget);
      const rf1 = STORE.baselineFromBudget('RF1', 'rf', activeYear, clientAnnual, activeYear + '-01-01');
      rf1.order = 1;
      STORE.saveBaseline(rf1);
      refreshBaselineSel();
      render();
      alert(`Loaded ${n} clients · ${fmt(budget.total)} as “2026 Budget” and “RF1”.`);
    } catch (err) { alert('Could not read the budget file: ' + err.message); }
    finally { e.target.value = ''; }
  }

  /* ---- Live roll-up from projects (read-only) ---- */
  function liveRows() {
    const projects = STORE.visibleProjects(STORE.listProjects()).filter(p => !STORE.isChangeOrder(p));
    return projects.map(p => {
      const series = STORE.monthlySeries(p, CATALOG) || [];
      const byMonth = {}; let yearTotal = 0;
      series.forEach(s => { const k = s.year + '-' + s.month; byMonth[k] = (byMonth[k] || 0) + s.amount; if (s.year === activeYear) yearTotal += s.amount; });
      const pj = p.project || {};
      const leader = STORE.resolveLeader(pj.leadId || pj.lead);
      return {
        p, byMonth, yearTotal,
        rating: STORE.ratingFor(p),
        client: (pj.client || '—').trim(),
        leader: leader ? leader.displayName : (pj.lead || '—'),
        industry: (pj.industry || '—').trim() || '—',
        serviceLine: (STORE.projectServiceLines(p)[0] || '—'),
      };
    });
  }

  function sliceKey(row) { return row[sliceDim] || '—'; }

  function render() {
    const baseline = activeBaselineId ? STORE.getBaseline(activeBaselineId) : null;
    if (!baseline) { $('#no-baseline').hidden = false; $('#cmp-table').innerHTML = ''; $('#kpis').innerHTML = ''; $('#studio-foot').textContent = ''; return; }
    $('#no-baseline').hidden = true;

    const rows = liveRows();
    // Baseline targets by slice. Currently broken out by client; other dims fall
    // back to "—" target (live only) since the Budget sheet is client-level.
    const baseByClient = baseline.byClient || {};
    const targetForSlice = (key) => {
      if (sliceDim === 'client') { const c = baseByClient[key]; return c ? c.annual : 0; }
      return null; // no baseline breakdown for this dim yet
    };

    // Group live rows by slice; sum the active year's live $, and split firm (r1) vs in-play (2-4).
    const groups = {};
    rows.forEach(r => {
      const k = sliceKey(r);
      const g = groups[k] || (groups[k] = { key: k, live: 0, firm: 0, inplay: 0, count: 0 });
      g.live += r.yearTotal;
      if (r.rating === 1) g.firm += r.yearTotal;
      else if (r.rating >= 2 && r.rating <= 4) g.inplay += r.yearTotal;
      g.count++;
    });

    // Ensure baseline-only clients still show (target with no live yet).
    if (sliceDim === 'client') Object.keys(baseByClient).forEach(c => { if (!groups[c]) groups[c] = { key: c, live: 0, firm: 0, inplay: 0, count: 0 }; });

    const list = Object.values(groups).sort((a, b) => {
      const ta = targetForSlice(a.key) || 0, tb = targetForSlice(b.key) || 0;
      return (tb || b.live) - (ta || a.live);
    });

    // KPIs
    let tgtTotal = 0, liveTotal = 0, firmTotal = 0;
    list.forEach(g => { tgtTotal += targetForSlice(g.key) || 0; liveTotal += g.live; firmTotal += g.firm; });
    const variance = liveTotal - tgtTotal;
    $('#kpis').innerHTML = `
      <div class="kpi teal"><div class="k-lbl">${esc(baseline.name)} target · ${activeYear}</div><div class="k-val">${fmt(tgtTotal)}</div><div class="k-sub">Frozen baseline</div></div>
      <div class="kpi navy"><div class="k-lbl">Live projected · ${activeYear}</div><div class="k-val">${fmt(liveTotal)}</div><div class="k-sub">From current projects</div></div>
      <div class="kpi"><div class="k-lbl">Booked (rated 1)</div><div class="k-val">${fmt(firmTotal)}</div><div class="k-sub">Firm revenue</div></div>
      <div class="kpi"><div class="k-lbl">Variance vs target</div><div class="k-val ${variance>=0?'num pos':'num neg'}">${variance>=0?'+':''}${fmt(variance)}</div><div class="k-sub">${tgtTotal?((variance/tgtTotal)*100).toFixed(1)+'% of target':'—'}</div></div>`;

    // Table
    const sliceLabel = { client: 'Client', leader: 'Revenue Leader', industry: 'Industry', serviceLine: 'Service line', rating: 'Rating' }[sliceDim];
    let html = `<thead><tr>
      <th class="lbl">${sliceLabel}</th>
      <th>${esc(baseline.name)} target</th>
      <th>Live projected</th>
      <th>Booked (r1)</th>
      <th>In-play (2–4)</th>
      <th>Variance</th>
      <th>Status</th>
    </tr></thead><tbody>`;
    list.forEach(g => {
      const tgt = targetForSlice(g.key);
      const hasT = tgt != null;
      const v = hasT ? (g.live - tgt) : null;
      const flag = !hasT ? '' : (Math.abs(v) < Math.max(1, tgt * 0.02) ? '<span class="flag at">At target</span>' : (v > 0 ? '<span class="flag above">Above</span>' : '<span class="flag below">Below</span>'));
      html += `<tr>
        <td class="lbl">${esc(g.key)}</td>
        <td>${hasT ? fmt(tgt) : '—'}</td>
        <td>${fmt(g.live)}</td>
        <td>${fmt(g.firm)}</td>
        <td>${fmt(g.inplay)}</td>
        <td class="${v==null?'':(v>=0?'num pos':'num neg')}">${v==null?'—':(v>=0?'+':'')+fmt(v)}</td>
        <td style="text-align:left;">${flag}</td>
      </tr>`;
    });
    html += `</tbody><tfoot><tr class="tot">
      <td class="lbl">Total</td>
      <td>${fmt(tgtTotal)}</td>
      <td>${fmt(liveTotal)}</td>
      <td>${fmt(firmTotal)}</td>
      <td>${fmt(liveTotal - firmTotal)}</td>
      <td class="${variance>=0?'num pos':'num neg'}">${variance>=0?'+':''}${fmt(variance)}</td>
      <td></td>
    </tr></tfoot>`;
    $('#cmp-table').innerHTML = html;

    $('#studio-foot').innerHTML = sliceDim === 'client'
      ? `Baseline is the ${activeYear} annual plan, flatlined ÷12. Live figures roll up current projects (discount &amp; fee-share applied). Booked = rating 1. <strong>Phase A</strong> — scenarios, adjustments, and the future-projects drawdown pool come next.`
      : `Note: the loaded Budget is client-level, so <strong>${esc(sliceLabel)}</strong> has no baseline target yet — live figures shown for reference. Slice by Client to compare against target.`;
  }

  // Boot: wait for the data layer (boot.js sets window.ufcReady).
  if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(ready); else window.addEventListener('load', ready);
})();
