/* ============================================================
   SAVILLS PPM · REVENUE PROJECTIONS — page controller
   ------------------------------------------------------------
   Moved out of Revenue Projections.html so the page logic is a
   real module: diffable, searchable, and shared-nothing with the
   markup. Loaded by that page only, after store.js + boot.js.
   ============================================================ */
(function () {
  const STORE = window.UFC_Store;
  const CATALOG = window.RATES_CATALOG;
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const $ = (s) => document.querySelector(s);

  const fmtFull = (n) => (n < 0 ? '-' : '') + '$' + Math.round(Math.abs(n)).toLocaleString();
  const fmtExact = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function fmtK(n) {
    if (!n) return '';
    const k = Math.abs(n) / 1000;
    const s = k >= 1000 ? '$' + (k / 1000).toFixed(1) + 'M'
            : '$' + (k >= 100 ? Math.round(k) : k.toFixed(1)) + 'K';
    return n < 0 ? '(' + s + ')' : s;      // finance convention: negatives in parens
  }

  let showExcluded = true;
  /* Closed-out projects are finished work whose earned months are still real
     revenue, so they stay IN by default — hiding them by default would move
     every year-to-date total on this page. The preference is remembered per
     browser so the choice only has to be made once. */
  const CLOSED_PREF = 'ufc_proj_show_closed_v1';
  let showClosed = (() => { try { return localStorage.getItem(CLOSED_PREF) !== '0'; } catch (e) { return true; } })();
  let showBroker = false;
  let showPass = false;
  let editMode = false;
  let ALL = [];                 // prepared rows (built once)
  let LAST_VIEW = null;         // last rendered model, for Excel export
  const QUARTERS = { Q1: [1,2,3], Q2: [4,5,6], Q3: [7,8,9], Q4: [10,11,12] };

  function prepData() {
    // Change orders fold into their parent's revised curve — exclude as rows.
    const parents = STORE.listProjects().filter(p => !STORE.isChangeOrder(p));
    const projects = STORE.visibleProjects(parents);
    ALL = projects.map(p => {
      const map = {}, brokerMap = {}, passMap = {};
      let total = 0;
      // Prefer the materialized billing series on the record (booked = frozen contract,
      // pursuit = live-refreshed on save). map = client INVOICE per month (incl. pass-through);
      // brokerMap = broker cut; passMap = pass-through vendor cost (flows out, not revenue).
      /* ONE canonical series for every month — see store.billingSeries().
         Freezing protects the price, not the calendar: a booked record keeps
         its contracted pricing, but overrides, slips and plan adjustments
         always show. Reading the frozen byMonth raw (what this did) meant a
         monthly edit was saved, flagged red, and then drawn at its old value. */
      const slipMap = {};
      (STORE.billingSeries(p, CATALOG) || []).forEach(s => {
        const k = s.year + '-' + s.month;
        map[k] = (map[k] || 0) + s.invoice;
        brokerMap[k] = (brokerMap[k] || 0) + (s.broker || 0);
        passMap[k] = (passMap[k] || 0) + (s.passCost || 0);
        total += s.invoice;
        if (s.slipOut || s.slipIn || s.adjusted) {
          const e = slipMap[k] = slipMap[k] || { out: 0, in: 0, adj: 0 };
          e.out += s.slipOut || 0; e.in += s.slipIn || 0; e.adj += s.adjusted || 0;
        }
      });
      // Add each approved change order's incremental curve on top of the baseline.
      const cos = STORE.approvedChangeOrders ? STORE.approvedChangeOrders(p.id) : [];
      cos.forEach(co => {
        STORE.changeOrderDelta(co).byMonth.forEach(x => {
          const [y, m] = x.ym.split('-').map(Number);
          const k = y + '-' + m;
          map[k] = (map[k] || 0) + x.net; total += x.net;
        });
      });
      const pj = p.project || {};
      const leaders = [pj.lead, pj.clientRelOwner].map(x => (x || '').trim()).filter(Boolean);
      const serviceLines = STORE.projectServiceLines(p);
      const fs = (p.assumptions && p.assumptions.feeShare) || {};
      const feeSharePct = fs.enabled ? (parseFloat(fs.pct) || 0) : 0;
      const ptCost = (p.financials && p.financials.passThroughCost) || 0;
      return { p, pj, rating: STORE.ratingFor(p), map, brokerMap, passMap, total, ov: p.monthlyOverrides || null, slipMap,
               coCount: cos.length, feeSharePct, ptCost, status: (pj.status || '').trim(),
               client: (pj.client || '').trim(), leaders, serviceLines, industry: (pj.industry || '').trim(), projectType: (pj.projectType || '').trim() };
    });
    populateFilters();
  }

  function uniqSorted(arr) { return [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b)); }

  function populateFilters() {
    const fill = (id, vals, allLabel) => {
      const sel = $('#' + id);
      const cur = sel.value;
      sel.innerHTML = `<option value="">${allLabel}</option>` + vals.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
      if (vals.includes(cur)) sel.value = cur;
    };
    fill('f-client', uniqSorted(ALL.map(r => r.client)), 'All clients');
    fill('f-leader', uniqSorted(ALL.flatMap(r => r.leaders)), 'All leaders');
    fill('f-service', uniqSorted(ALL.flatMap(r => r.serviceLines)), 'All service lines');
    fill('f-industry', uniqSorted(ALL.map(r => r.industry)), 'All industries');
    fill('f-ptype', uniqSorted(ALL.map(r => r.projectType)), 'All project types');
    // Years from data
    const years = uniqSorted(ALL.flatMap(r => Object.keys(r.map).map(k => k.split('-')[0])));
    const ysel = $('#f-year'); const yc = ysel.value;
    ysel.innerHTML = `<option value="">All years</option>` + years.map(y => `<option value="${y}">${y}</option>`).join('');
    if (years.includes(yc)) ysel.value = yc;
    const qsel = $('#f-quarter');
    if (!qsel.options.length) qsel.innerHTML = `<option value="">All quarters</option>` + Object.keys(QUARTERS).map(q => `<option value="${q}">${q}</option>`).join('');
    const msel = $('#f-month');
    if (!msel.options.length) msel.innerHTML = `<option value="">All months</option>` + MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');
  }

  function currentFilters() {
    return {
      client: $('#f-client').value, leader: $('#f-leader').value,
      service: $('#f-service').value, industry: $('#f-industry').value, ptype: $('#f-ptype').value,
      year: $('#f-year').value, quarter: $('#f-quarter').value, month: $('#f-month').value,
    };
  }

  function build() {
    try { renderSlips(); } catch (e) {}
    if (!ALL.length) { $('#empty').hidden = false; $('#proj-table').innerHTML = ''; $('#kpis').innerHTML = ''; $('#filt-count').textContent = ''; return; }
    $('#empty').hidden = true;
    const f = currentFilters();

    // mark active filter selects
    ['f-client','f-leader','f-service','f-industry','f-ptype','f-year','f-quarter','f-month'].forEach(id => {
      $('#' + id).classList.toggle('active', !!$('#' + id).value);
    });

    // Row filters
    let rows = ALL.filter(r => {
      if (!showClosed && r.status === 'closed') return false;
      if (f.client && r.client !== f.client) return false;
      if (f.leader && !r.leaders.includes(f.leader)) return false;
      if (f.service && !r.serviceLines.includes(f.service)) return false;
      if (f.industry && r.industry !== f.industry) return false;
      if (f.ptype && r.projectType !== f.ptype) return false;
      return true;
    });
    // When a service line is selected, slice each project to only that line's fees.
    if (f.service) {
      rows = rows.map(r => {
        const series = STORE.monthlySeries(r.p, CATALOG, { serviceLine: f.service });
        const map = {}; let total = 0;
        series.forEach(s => { const k = s.year + '-' + s.month; map[k] = (map[k] || 0) + s.amount; total += s.amount; });
        return Object.assign({}, r, { map, total });
      }).filter(r => r.total > 0.5);
    }
    const dupes = findDoubleCounts(rows);
    const dupIds = new Set(dupes.map(d => d.row.p.id));
    renderDoubleCounts(dupes);
    const closedHidden = showClosed ? 0 : ALL.filter(r => r.status === 'closed').length;
    $('#filt-count').textContent = `${rows.length} of ${ALL.length} projects`
      + (f.service ? ` · ${f.service} only` : '')
      + (closedHidden ? ` · ${closedHidden} closed out hidden` : '');

    // Column (time) filter predicate
    const monthAllowed = (y, m) => {
      if (f.year && String(y) !== f.year) return false;
      if (f.quarter && !QUARTERS[f.quarter].includes(m)) return false;
      if (f.month && m !== parseInt(f.month)) return false;
      return true;
    };

    if (!rows.length) {
      $('#proj-table').innerHTML = '';
      $('#empty').hidden = false; $('#empty').textContent = 'No projects match these filters.';
      $('#kpis').innerHTML = '';
      return;
    }

    // Global month range across filtered rows
    let minY = Infinity, minM = 1, maxY = -Infinity, maxM = 12, any = false;
    rows.forEach(r => Object.keys(r.map).forEach(k => {
      const [yy, mm] = k.split('-').map(Number); any = true;
      if (minY === Infinity || yy < minY || (yy === minY && mm < minM)) { minY = yy; minM = mm; }
      if (maxY === -Infinity || yy > maxY || (yy === maxY && mm > maxM)) { maxY = yy; maxM = mm; }
    }));
    if (!any) { minY = new Date().getFullYear(); minM = 1; maxY = minY; maxM = 12; }

    // Build the ordered list of month columns, applying the time filter
    const cols = [];
    let y = minY, m = minM;
    while (y < maxY || (y === maxY && m <= maxM)) {
      if (monthAllowed(y, m)) cols.push({ y, m, key: y + '-' + m });
      m++; if (m > 12) { m = 1; y++; }
      if (cols.length > 240) break;
    }
    // Year spans
    const years = [];
    cols.forEach(c => { const last = years[years.length - 1]; if (last && last.y === c.y) last.span++; else years.push({ y: c.y, span: 1 }); });

    // Sort: rating asc, then total desc
    rows.sort((a, b) => a.rating - b.rating || b.total - a.total);

    // ---- Header ----
    let html = '<thead>';
    html += '<tr class="years"><th class="corner" rowspan="2">Project · ' + rows.length + '</th>';
    years.forEach((yr, i) => { html += `<th colspan="${yr.span}">${yr.y}</th>`; });
    html += '<th class="totcol" rowspan="2">Total</th></tr>';
    html += '<tr>';
    const _now = new Date(); const _ck = _now.getFullYear() + '-' + (_now.getMonth() + 1);
    cols.forEach((c, i) => {
      const sep = (i + 1 < cols.length && cols[i + 1].y !== c.y) ? ' year-sep' : '';
      const today = c.key === _ck ? ' today' : '';
      html += `<th class="${(sep + today).trim()}">${c.key === _ck ? '<span class="today-tag">CURRENT</span>' : ''}${MONTHS[c.m - 1]}</th>`;
    });
    html += '</tr></thead><tbody>';

    // Column totals (ratings 1–4 only) + weighted (all, × confidence)
    const colTot = {}, colWt = {};
    const colBroker = {}; let grandBroker = 0;
    const colPass = {}; let grandPass = 0;
    cols.forEach(c => { colTot[c.key] = 0; colWt[c.key] = 0; });
    let grandTot = 0, grandWt = 0;

    let lastRating = null;
    rows.forEach(r => {
      const excluded = r.rating > 4;
      const meta = STORE.ratingMeta(r.rating);

      // Skip hidden excluded rows BEFORE emitting a group header, so a fully
      // hidden rating group leaves no orphan header. (Weighted totals are
      // computed in a separate pass below, so skipping here is safe.)
      if (excluded && !showExcluded) return;

      // Group header when rating changes (only for groups that will render)
      if (r.rating !== lastRating) {
        lastRating = r.rating;
        const gExcl = r.rating > 4 ? ' excluded' : '';
        const colspan = cols.length + 2;
        html += `<tr class="group-row${gExcl}"><td colspan="${colspan}">${r.rating} · ${meta.label}${r.rating > 4 ? ' — excluded from totals' : ''}</td></tr>`;
      }

      const pj = r.p.project || {};
      html += `<tr class="r${r.rating}${excluded ? ' excluded' : ''}">`;
      const ratingCell = editMode
        ? `<select class="rtag-edit r${r.rating}" data-pid="${r.p.id}" title="Projection rating">${STORE.RATINGS.map(rt => `<option value="${rt.n}" ${rt.n===r.rating?'selected':''}>${rt.n}</option>`).join('')}</select>`
        : `<span class="rtag r${r.rating}">${r.rating}</span>`;
      const coMeta = r.coCount ? ` · <span style="color:var(--sav-teal);">incl. ${r.coCount} CO${r.coCount === 1 ? '' : 's'}</span>` : '';
      html += `<td class="proj-cell">${ratingCell}<a class="pname" href="Universal Fee Calculator.html?id=${encodeURIComponent(r.p.id)}" title="Open in the fee calculator">${esc(pj.name || 'Untitled')}</a><div class="pmeta">${esc(pj.client || '')}${pj.client && pj.status ? ' · ' : ''}${STORE.STATUS_LABELS[pj.status] || ''}${coMeta}${dupIds.has(r.p.id) ? '<span class="dup-badge" title="This row\u2019s monthly figure equals the sum of this client\u2019s other rows — it may be a roll-up counted on top of its own parts. Check before trusting the total.">⚠ possible double count</span>' : ''}<span class="open-link"> · open →</span></div></td>`;
      let rvt = 0;
      cols.forEach((c, i) => {
        const v = r.map[c.key] || 0;
        rvt += v;
        const sep = (i + 1 < cols.length && cols[i + 1].y !== c.y) ? ' year-sep' : '';
        const today = c.key === _ck ? ' today' : '';
        const isOv = r.ov && r.ov[c.key] != null;
        const sl = r.slipMap && r.slipMap[c.key];
        const slCls = sl ? (sl.out ? ' slip-out' : '') + (sl.in ? ' slip-in' : '') + (sl.adj ? ' slip-adj' : '') : '';
        const slTip = sl ? ` · ${sl.out ? 'slipped out ' + fmtExact(sl.out) : ''}${sl.out && sl.in ? ' / ' : ''}${sl.in ? 'slipped in ' + fmtExact(sl.in) : ''}${sl.adj ? 'plan adjusted ' + fmtExact(sl.adj) : ''} — unreconciled` : '';
        if (editMode) {
          html += `<td class="num editable${isOv ? ' overridden' : ''}${slCls}${sep}${today}" contenteditable="true" data-pid="${r.p.id}" data-key="${c.key}">${v ? Math.round(v) : ''}</td>`;
        } else {
          html += `<td class="num${v ? '' : ' zero'}${isOv ? ' overridden' : ''}${slCls}${sep}${today}"${v ? ` title="${fmtExact(v)}${slTip}"` : (sl ? ` title="${slTip.replace(/^ · /, '')}"` : '')}>${v ? fmtK(v) : '·'}</td>`;
        }
        if (!excluded) { colTot[c.key] += v; grandTot += v; }
      });
      html += `<td class="rowtot num" title="${fmtExact(rvt)}">${fmtK(rvt)}</td>`;
      html += '</tr>';
      // Broker fee-split sub-line (toggle): the monthly broker cut beneath the invoice total.
      if (showBroker && r.feeSharePct > 0) {
        const bm = r.brokerMap || {};
        let rowBroker = 0;
        html += `<tr class="broker-row"><td class="proj-cell">↳ Broker fee · ${r.feeSharePct}%</td>`;
        cols.forEach((c, i) => {
          const sep = (i + 1 < cols.length && cols[i + 1].y !== c.y) ? ' year-sep' : '';
          const today = c.key === _ck ? ' today' : '';
          const b = bm[c.key] || 0;
          rowBroker += b;
          html += `<td class="num broker${sep}${today}"${b ? ` title="−${fmtExact(b)}"` : ''}>${b ? '−' + fmtK(b) : ''}</td>`;
          if (!excluded) { colBroker[c.key] = (colBroker[c.key] || 0) + b; grandBroker += b; }
        });
        html += `<td class="rowtot num broker">−${fmtK(rowBroker)}</td></tr>`;
      }
      // Pass-through pull-out sub-line (toggle): vendor cost billed through, flows out.
      if (showPass && r.ptCost > 0) {
        const pm = r.passMap || {};
        let rowPass = 0;
        html += `<tr class="pass-row"><td class="proj-cell">↳ Pass-through cost</td>`;
        cols.forEach((c, i) => {
          const sep = (i + 1 < cols.length && cols[i + 1].y !== c.y) ? ' year-sep' : '';
          const today = c.key === _ck ? ' today' : '';
          const b = pm[c.key] || 0;
          rowPass += b;
          html += `<td class="num pass${sep}${today}"${b ? ` title="−${fmtExact(b)}"` : ''}>${b ? '−' + fmtK(b) : ''}</td>`;
          if (!excluded) { colPass[c.key] = (colPass[c.key] || 0) + b; grandPass += b; }
        });
        html += `<td class="rowtot num pass">−${fmtK(rowPass)}</td></tr>`;
      }
    });

    // Probability-weighted totals — every pursuit × its rating confidence (visible cols only).
    cols.forEach(c => { colWt[c.key] = 0; });
    rows.forEach(r => { const w = STORE.ratingMeta(r.rating).weight; cols.forEach(c => { const v = (r.map[c.key] || 0); colWt[c.key] += v * w; grandWt += v * w; }); });

    // ---- Totals rows ----
    html += '<tr class="totals"><td class="proj-cell">Projected (rated 1–4)</td>';
    cols.forEach((c, i) => { const sep = (i + 1 < cols.length && cols[i + 1].y !== c.y) ? ' year-sep' : ''; html += `<td class="num${sep}"${colTot[c.key] ? ` title="${fmtExact(colTot[c.key])}"` : ''}>${colTot[c.key] ? fmtK(colTot[c.key]) : '·'}</td>`; });
    html += `<td class="rowtot num" title="${fmtExact(grandTot)}">${fmtK(grandTot)}</td></tr>`;

    html += '<tr class="totals weighted"><td class="proj-cell">Probability-weighted (all)</td>';
    cols.forEach((c, i) => { const sep = (i + 1 < cols.length && cols[i + 1].y !== c.y) ? ' year-sep' : ''; html += `<td class="num${sep}"${colWt[c.key] ? ` title="${fmtExact(colWt[c.key])}"` : ''}>${colWt[c.key] ? fmtK(colWt[c.key]) : '·'}</td>`; });
    html += `<td class="rowtot num" title="${fmtExact(grandWt)}">${fmtK(grandWt)}</td></tr>`;

    // Broker-fee rolled-up total (toggle)
    if (showBroker && grandBroker > 0) {
      html += '<tr class="totals broker-total"><td class="proj-cell">↳ Broker fee · all splits</td>';
      cols.forEach((c, i) => { const sep = (i + 1 < cols.length && cols[i + 1].y !== c.y) ? ' year-sep' : ''; const b = colBroker[c.key] || 0; html += `<td class="num${sep}">${b ? '−' + fmtK(b) : '·'}</td>`; });
      html += `<td class="rowtot num">−${fmtK(grandBroker)}</td></tr>`;
      html += '<tr class="totals net-after-broker"><td class="proj-cell">Net of broker fee</td>';
      cols.forEach((c, i) => { const sep = (i + 1 < cols.length && cols[i + 1].y !== c.y) ? ' year-sep' : ''; const n = (colTot[c.key] || 0) - (colBroker[c.key] || 0); html += `<td class="num${sep}">${n ? fmtK(n) : '·'}</td>`; });
      html += `<td class="rowtot num">${fmtK(grandTot - grandBroker)}</td></tr>`;
    }

    // Pass-through rolled-up total (toggle) — cost billed through Savills, netted to revenue
    if (showPass && grandPass > 0) {
      html += '<tr class="totals pass-total"><td class="proj-cell">↳ Pass-through cost · all lines</td>';
      cols.forEach((c, i) => { const sep = (i + 1 < cols.length && cols[i + 1].y !== c.y) ? ' year-sep' : ''; const b = colPass[c.key] || 0; html += `<td class="num${sep}">${b ? '−' + fmtK(b) : '·'}</td>`; });
      html += `<td class="rowtot num">−${fmtK(grandPass)}</td></tr>`;
      html += '<tr class="totals net-after-pass"><td class="proj-cell">Savills revenue · net of pass-through</td>';
      cols.forEach((c, i) => { const sep = (i + 1 < cols.length && cols[i + 1].y !== c.y) ? ' year-sep' : ''; const n = (colTot[c.key] || 0) - (colBroker[c.key] || 0) - (colPass[c.key] || 0); html += `<td class="num${sep}">${n ? fmtK(n) : '·'}</td>`; });
      html += `<td class="rowtot num">${fmtK(grandTot - grandBroker - grandPass)}</td></tr>`;
    }

    html += '</tbody>';
    $('#proj-table').innerHTML = html;
    if (editMode) wireEditing();

    // ---- KPIs (over filtered rows + visible columns) ----
    const _ky = new Date(); const cy = _ky.getFullYear(); const cmKey = cy + '-' + (_ky.getMonth() + 1);
    const cmLabel = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][_ky.getMonth()] + ' ' + cy;
    // Every dollar card is scoped to a single calendar year (default = current, 2026).
    const yrTotal = (r, y) => cols.filter(c => c.y === y).reduce((a, c) => a + (r.map[c.key] || 0), 0);
    const booked      = rows.filter(r => r.rating === 1).reduce((s, r) => s + yrTotal(r, cy), 0);
    const booked2027  = rows.filter(r => r.rating === 1).reduce((s, r) => s + yrTotal(r, cy + 1), 0);
    const pipeline14  = rows.filter(r => r.rating >= 2 && r.rating <= 4).reduce((s, r) => s + yrTotal(r, cy), 0);
    const longshot    = rows.filter(r => r.rating >= 5 && r.rating <= 6).reduce((s, r) => s + yrTotal(r, cy), 0);
    const total2026   = rows.filter(r => r.rating >= 1 && r.rating <= 4).reduce((s, r) => s + yrTotal(r, cy), 0);
    const wt2026      = rows.reduce((s, r) => s + yrTotal(r, cy) * ((STORE.ratingMeta(r.rating) || {}).weight || 0), 0);
    // Calendar-year + current-month rollups (rated 1–4, the forecast set)
    const fc = rows.filter(r => r.rating >= 1 && r.rating <= 4);
    const cyTotal = total2026;
    const cmTotal = fc.reduce((s, r) => s + (r.map[cmKey] || 0), 0);
    $('#kpis').innerHTML = `
      <div class="kpi teal"><div class="k-lbl">Calendar ${cy} · projected</div><div class="k-val" title="${fmtExact(cyTotal)}">${fmtFull(cyTotal)}</div><div class="k-sub">Rated 1–4, ${cy} work-performed months</div></div>
      <div class="kpi navy"><div class="k-lbl">Current month · ${cmLabel}</div><div class="k-val" title="${fmtExact(cmTotal)}">${fmtFull(cmTotal)}</div><div class="k-sub">Highlighted column in the grid</div></div>
      <div class="kpi"><div class="k-lbl">Booked · ${cy} (rated 1)</div><div class="k-val" title="${fmtExact(booked)}">${fmtFull(booked)}</div><div class="k-sub">Signed / active · Booked ${cy + 1} ${fmtFull(booked2027)}</div></div>
      <div class="kpi"><div class="k-lbl">Pipeline · ${cy} (rated 2–4)</div><div class="k-val" title="${fmtExact(pipeline14)}">${fmtFull(pipeline14)}</div><div class="k-sub">≥ 50% confidence</div></div>
      <div class="kpi"><div class="k-lbl">Projected total (1–4) · ${cy}</div><div class="k-val" title="${fmtExact(total2026)}">${fmtFull(total2026)}</div><div class="k-sub">All ${cy} earned (work-performed) months</div></div>
      <div class="kpi"><div class="k-lbl">Probability-weighted · ${cy}</div><div class="k-val" title="${fmtExact(wt2026)}">${fmtFull(wt2026)}</div><div class="k-sub">All pursuits × confidence · incl. ${fmtFull(longshot)} long-shot</div></div>
    `;

    // Capture the exact rendered model for the Excel export.
    LAST_VIEW = { rows, cols, years, colTot, colWt, grandTot, grandWt,
                  booked, pipeline14, longshot, filters: f, showExcluded, showClosed };

    // ---- Legend ----
    $('#legend').innerHTML = STORE.RATINGS.map(r => {
      const c = { 1:'#1f8a5b',2:'#3AA95C',3:'var(--sav-yellow)',4:'var(--sav-orange)',5:'var(--sav-steel)',6:'var(--sav-steel)',7:'var(--sav-steel)' }[r.n];
      return `<span class="lg"><span class="dot" style="background:${c}"></span>${r.n} ${r.label}</span>`;
    }).join('');
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

  /* ---------- Excel export — mirrors the matrix exactly as viewed ---------- */
  async function exportProjections() {
    if (typeof ExcelJS === 'undefined') { alert('Excel library not loaded.'); return; }
    if (!LAST_VIEW || !LAST_VIEW.rows.length) { alert('Nothing to export — adjust the filters so projects are visible.'); return; }
    const V = LAST_VIEW;
    const NAVY='FF25273A', YEL='FFFFDF00', TEAL='FF0E7C7B', CREAM='FFEEE8E3', STEEL='FF79828C', WHITE='FFFFFFFF', HAIR='FFE2DFDA';
    const RCOL = { 1:'FF1F8A5B', 2:'FF3AA95C', 3:'FFD9A300', 4:'FFD2691E', 5:STEEL, 6:STEEL, 7:STEEL };
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Savills PPM';
    const ws = wb.addWorksheet('Revenue Projections', {
      views: [{ state: 'frozen', xSplit: 1, ySplit: 5 }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    const nCols = V.cols.length;
    const M0 = 5;                            // first month column (1 Project, 2 Client, 3 Rating, 4 Leader)
    const lastCol = M0 + nCols;              // months + total
    const colL = (i) => { let s=''; i++; while(i>0){ s=String.fromCharCode(65+(i-1)%26)+s; i=Math.floor((i-1)/26);} return s; };
    ws.getColumn(1).width = 30; ws.getColumn(2).width = 22; ws.getColumn(3).width = 16; ws.getColumn(4).width = 18;
    for (let i=0;i<nCols;i++) ws.getColumn(M0+i).width = 10;
    ws.getColumn(lastCol).width = 14;
    const leaderName = (pj) => { const l = STORE.resolveLeader && STORE.resolveLeader(pj.leadId || pj.lead); return l ? l.displayName : (pj.lead || ''); };

    const money = (n) => n;   // full precision in the cell; numFmt controls DISPLAY only
    const setMoney = (cell, n, opts={}) => {
      cell.value = n ? money(n) : (opts.dash ? '·' : null);
      cell.numFmt = '#,##0.00';
      cell.alignment = { horizontal: 'right' };
      if (opts.font) cell.font = opts.font;
      if (opts.fill) cell.fill = { type:'pattern', pattern:'solid', fgColor:{argb:opts.fill} };
    };

    // ----- Title + KPI band (rows 1-3) -----
    ws.mergeCells(1,1,1,lastCol);
    const t = ws.getCell('A1');
    t.value = 'Revenue Projections';
    t.font = { name:'Calibri', bold:true, size:18, color:{argb:NAVY} };
    ws.getRow(1).height = 26;
    const fbits = [];
    const f = V.filters;
    if (f.client) fbits.push('Client: '+f.client);
    if (f.leader) fbits.push('Leader: '+f.leader);
    if (f.service) fbits.push('Service: '+f.service);
    if (f.industry) fbits.push('Industry: '+f.industry);
    if (f.ptype) fbits.push('Type: '+f.ptype);
    if (f.year) fbits.push('Year: '+f.year);
    if (f.quarter) fbits.push(f.quarter);
    if (f.month) fbits.push('Month: '+MONTHS[parseInt(f.month)-1]);
    ws.mergeCells(2,1,2,lastCol);
    const sub = ws.getCell('A2');
    sub.value = `${V.rows.length} projects · as of ${new Date().toLocaleDateString()}` + (fbits.length ? '  ·  '+fbits.join('  ·  ') : '  ·  all projects') + (V.showExcluded ? '' : '  ·  rated 1–4 only') + (V.showClosed ? '' : '  ·  closed out excluded');
    sub.font = { name:'Calibri', italic:true, size:10, color:{argb:STEEL} };
    // KPI cells (row 4)
    const kpis = [
      ['Booked (rated 1)', V.booked, NAVY, WHITE],
      ['Pipeline (2–4)', V.pipeline14, CREAM, NAVY],
      ['Projected total (1–4)', V.grandTot, TEAL, WHITE],
      ['Probability-weighted', V.grandWt, CREAM, NAVY],
    ];
    let kc = 1;
    const kpiSpan = Math.max(2, Math.floor((lastCol) / 4));
    kpis.forEach((k, idx) => {
      const c0 = kc, c1 = (idx === 3) ? lastCol : Math.min(lastCol, kc + kpiSpan - 1);
      ws.mergeCells(4, c0, 4, c1);
      const cell = ws.getCell(4, c0);
      cell.value = `${k[0]}:  ${fmtFull(k[1])}`;
      cell.font = { name:'Calibri', bold:true, size:11, color:{argb:k[3]} };
      cell.fill = { type:'pattern', pattern:'solid', fgColor:{argb:k[2]} };
      cell.alignment = { horizontal:'left', vertical:'middle', indent:1 };
      kc = c1 + 1;
    });
    ws.getRow(4).height = 22;

    // ----- Header: year spans (row 5) + months (row 6) -----
    const yearRow = 5, monRow = 6;
    [[1,`Project · ${V.rows.length}`],[2,'Client'],[3,'Rating'],[4,'Revenue Leader']].forEach(([col,label]) => {
      ws.mergeCells(yearRow,col,monRow,col);
      const hc = ws.getCell(yearRow,col);
      hc.value = label;
      hc.font = { name:'Calibri', bold:true, color:{argb:WHITE} };
      hc.fill = { type:'pattern', pattern:'solid', fgColor:{argb:NAVY} };
      hc.alignment = { vertical:'middle' };
    });
    let ci = M0;
    V.years.forEach(yr => {
      ws.mergeCells(yearRow, ci, yearRow, ci + yr.span - 1);
      const yc = ws.getCell(yearRow, ci);
      yc.value = yr.y;
      yc.font = { name:'Calibri', bold:true, color:{argb:NAVY} };
      yc.fill = { type:'pattern', pattern:'solid', fgColor:{argb:YEL} };
      yc.alignment = { horizontal:'center' };
      ci += yr.span;
    });
    ws.mergeCells(yearRow, lastCol, monRow, lastCol);
    const tc = ws.getCell(yearRow, lastCol);
    tc.value = 'Total';
    tc.font = { name:'Calibri', bold:true, color:{argb:WHITE} };
    tc.fill = { type:'pattern', pattern:'solid', fgColor:{argb:NAVY} };
    tc.alignment = { horizontal:'right', vertical:'middle' };
    V.cols.forEach((c, i) => {
      const cell = ws.getCell(monRow, M0 + i);
      cell.value = MONTHS[c.m - 1];
      cell.font = { name:'Calibri', size:9, bold:true, color:{argb:STEEL} };
      cell.fill = { type:'pattern', pattern:'solid', fgColor:{argb:CREAM} };
      cell.alignment = { horizontal:'center' };
    });

    // ----- Body: rating groups + project rows -----
    let r = monRow + 1;
    let lastRating = null;
    V.rows.forEach(row => {
      const excluded = row.rating > 4;
      if (excluded && !V.showExcluded) return;
      const meta = STORE.ratingMeta(row.rating);
      if (row.rating !== lastRating) {
        lastRating = row.rating;
        ws.mergeCells(r, 1, r, lastCol);
        const g = ws.getCell(r, 1);
        g.value = `  ${row.rating} · ${meta.label}${excluded ? ' — excluded from totals' : ''}`;
        g.font = { name:'Calibri', bold:true, size:10, color:{argb: excluded ? STEEL : NAVY} };
        g.fill = { type:'pattern', pattern:'solid', fgColor:{argb: excluded ? 'FFF4F4F3' : 'FFF0EFEC'} };
        ws.getRow(r).height = 18;
        r++;
      }
      const pj = row.p.project || {};
      ws.getCell(r, 1).value = (pj.name || 'Untitled') + (row.coCount ? '  (incl. '+row.coCount+' CO'+(row.coCount===1?'':'s')+')' : '');
      ws.getCell(r, 1).font = { name:'Calibri', bold:true, size:11, color:{argb: excluded ? STEEL : NAVY} };
      ws.getCell(r, 1).alignment = { vertical:'middle' };
      ws.getCell(r, 2).value = pj.client || '';
      ws.getCell(r, 2).font = { name:'Calibri', size:10, color:{argb: excluded ? STEEL : NAVY} };
      ws.getCell(r, 3).value = row.rating + ' · ' + (meta.short || meta.label || '');
      ws.getCell(r, 3).font = { name:'Calibri', size:10, color:{argb: RCOL[row.rating] || NAVY}, bold:true };
      ws.getCell(r, 4).value = leaderName(pj);
      ws.getCell(r, 4).font = { name:'Calibri', size:10, color:{argb: STEEL} };
      let rvt = 0;
      V.cols.forEach((c, i) => {
        const v = row.map[c.key] || 0; rvt += v;
        const isOv = row.ov && row.ov[c.key] != null;
        const cell = ws.getCell(r, M0 + i);
        setMoney(cell, v, { dash:true, font:{ name:'Calibri', size:10, color:{argb: isOv ? TEAL : (excluded ? STEEL : NAVY)}, bold: !!isOv } });
      });
      setMoney(ws.getCell(r, lastCol), rvt, { font:{ name:'Calibri', bold:true, color:{argb: RCOL[row.rating] || NAVY} } });
      r++;
    });

    // ----- Totals rows -----
    const totRow = r + 1;
    ws.mergeCells(totRow,1,totRow,4);
    ws.getCell(totRow,1).value = 'Projected (rated 1–4)';
    ws.getCell(totRow,1).font = { name:'Calibri', bold:true, color:{argb:WHITE} };
    ws.getCell(totRow,1).fill = { type:'pattern', pattern:'solid', fgColor:{argb:NAVY} };
    [2,3,4].forEach(cc=>{ ws.getCell(totRow,cc).fill = { type:'pattern', pattern:'solid', fgColor:{argb:NAVY} }; });
    V.cols.forEach((c, i) => setMoney(ws.getCell(totRow, M0+i), V.colTot[c.key], { dash:true, font:{name:'Calibri', bold:true, color:{argb:WHITE}}, fill:NAVY }));
    setMoney(ws.getCell(totRow, lastCol), V.grandTot, { font:{name:'Calibri', bold:true, color:{argb:YEL}}, fill:NAVY });
    ws.getRow(totRow).height = 20;

    const wtRow = totRow + 1;
    ws.mergeCells(wtRow,1,wtRow,4);
    ws.getCell(wtRow,1).value = 'Probability-weighted (all)';
    ws.getCell(wtRow,1).font = { name:'Calibri', bold:true, color:{argb:NAVY} };
    ws.getCell(wtRow,1).fill = { type:'pattern', pattern:'solid', fgColor:{argb:CREAM} };
    [2,3,4].forEach(cc=>{ ws.getCell(wtRow,cc).fill = { type:'pattern', pattern:'solid', fgColor:{argb:CREAM} }; });
    V.cols.forEach((c, i) => setMoney(ws.getCell(wtRow, M0+i), V.colWt[c.key], { dash:true, font:{name:'Calibri', color:{argb:NAVY}}, fill:CREAM }));
    setMoney(ws.getCell(wtRow, lastCol), V.grandWt, { font:{name:'Calibri', bold:true, color:{argb:NAVY}}, fill:CREAM });

    // borders on the matrix
    for (let rr = yearRow; rr <= wtRow; rr++) for (let cc = 1; cc <= lastCol; cc++) {
      ws.getCell(rr, cc).border = { bottom:{style:'thin', color:{argb:HAIR}}, right:{style:'thin', color:{argb:HAIR}} };
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Revenue Projections ${new Date().toISOString().slice(0,10)}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /** Commit a manual monthly override (or rating) and persist to the project. */
  function wireEditing() {
    document.querySelectorAll('#proj-table td.editable').forEach(td => {
      // Remember the value shown when editing starts, so a no-op click that just
      // focuses/blurs the cell never gets recorded as a manual override.
      td.addEventListener('focus', () => { td.dataset.orig = td.textContent.replace(/[$,\s]/g, '').trim(); });
      td.addEventListener('blur', () => {
        const pid = td.dataset.pid, key = td.dataset.key;
        const rec = STORE.getProject(pid); if (!rec) return;
        const raw = td.textContent.replace(/[$,\s]/g, '').trim();
        const orig = td.dataset.orig != null ? td.dataset.orig : raw;
        // Unchanged → do nothing. No write, no save, no red flag.
        if (raw === orig) return;
        rec.monthlyOverrides = rec.monthlyOverrides || {};
        if (raw === '') { delete rec.monthlyOverrides[key]; }   // cleared = revert to computed
        else { const n = parseFloat(raw); if (!isNaN(n)) rec.monthlyOverrides[key] = n; else return; }
        if (!Object.keys(rec.monthlyOverrides).length) delete rec.monthlyOverrides;
        STORE.saveProject(rec);
        prepData(); build();
      });
      td.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); td.blur(); } });
    });
    document.querySelectorAll('#proj-table select.rtag-edit').forEach(sel => {
      sel.addEventListener('change', () => {
        const rec = STORE.getProject(sel.dataset.pid); if (!rec) return;
        rec.project = rec.project || {};
        rec.project.rating = parseInt(sel.value) || null;
        STORE.saveProject(rec);
        prepData(); build();
      });
    });
  }

  /* ---------- Flash report: snapshots + Excel export ---------- */
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function initFlash() {
    const now = new Date();
    const ysel = $('#flash-year'), msel = $('#flash-month');
    const yNow = now.getFullYear();
    for (let y = yNow - 2; y <= yNow + 4; y++) ysel.insertAdjacentHTML('beforeend', `<option value="${y}">${y}</option>`);
    MONTH_NAMES.forEach((m, i) => msel.insertAdjacentHTML('beforeend', `<option value="${i+1}">${m}</option>`));
    // default to the prior month (flash is usually "for work performed last month")
    const prev = new Date(yNow, now.getMonth() - 1, 1);
    ysel.value = prev.getFullYear(); msel.value = prev.getMonth() + 1;
    ysel.addEventListener('change', renderFlashSnaps);
    msel.addEventListener('change', renderFlashSnaps);
    $('#flash-capture').addEventListener('click', captureFlash);
    $('#flash-export').addEventListener('click', exportFlash);
    renderFlashSnaps();
  }
  function flashPeriod() { return { year: +$('#flash-year').value, month: +$('#flash-month').value }; }
  function monthRevenueFor(p, year, month) {
    const series = STORE.monthlySeries(p, CATALOG);
    const hit = series.find(s => s.year === year && s.month === month);
    let amt = hit ? hit.amount : 0;
    // Roll up approved change orders' incremental for this month.
    (STORE.approvedChangeOrders ? STORE.approvedChangeOrders(p.id) : []).forEach(co => {
      STORE.changeOrderDelta(co).byMonth.forEach(x => {
        const [y, m] = x.ym.split('-').map(Number);
        if (y === year && m === month) amt += x.net;
      });
    });
    return amt;
  }
  function renderFlashSnaps() {
    const { year, month } = flashPeriod();
    const snaps = STORE.getSnapshots(year, month);
    const taken = STORE.FLASH_LABELS.filter(l => snaps[l]);
    $('#flash-snaps').innerHTML = taken.length
      ? taken.map(l => { const d = new Date(snaps[l].asOf); return `<span class="snap-chip">${l} · ${d.toLocaleDateString()}</span>`; }).join('')
      : '<span class="snap-none">no snapshots captured yet</span>';
  }
  function captureFlash() {
    const { year, month } = flashPeriod();
    const label = $('#flash-label').value;
    const projects = STORE.visibleProjects(STORE.listProjects().filter(p => !STORE.isChangeOrder(p)));
    STORE.captureSnapshot(year, month, label, projects, (p) => {
      const pj = p.project || {};
      return {
        projId: pj.projectId365 || pj.salesforceId || '',
        name: pj.name || 'Untitled',
        client: pj.client || '',
        rating: STORE.ratingFor(p),
        amount: monthRevenueFor(p, year, month),
      };
    });
    renderFlashSnaps();
    alert(`Captured "${label}" snapshot for ${MONTH_NAMES[month-1]} ${year}.`);
  }
  async function exportFlash() {
    if (typeof ExcelJS === 'undefined') { alert('Excel library not loaded.'); return; }
    const { year, month } = flashPeriod();
    const snaps = STORE.getSnapshots(year, month);
    const labels = STORE.FLASH_LABELS;
    const projects = STORE.visibleProjects(STORE.listProjects().filter(p => !STORE.isChangeOrder(p)));
    // Union of projects across live + all snapshots
    const live = {};
    projects.forEach(p => { const pj = p.project || {}; live[p.id] = { projId: pj.projectId365 || '', name: pj.name || 'Untitled', client: pj.client || '', rating: STORE.ratingFor(p), amount: monthRevenueFor(p, year, month) }; });
    const ids = new Set(Object.keys(live));
    labels.forEach(l => { if (snaps[l]) Object.keys(snaps[l].rows).forEach(id => ids.add(id)); });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`${MONTH_NAMES[month-1]} ${year} Flash`);
    const NAVY = 'FF25273A', YEL = 'FFFFDF00', RED = 'FFCE181E', GRN = 'FF1F8A5B';
    // Title
    ws.mergeCells('A1:H1');
    ws.getCell('A1').value = `Savills PPM — Monthly Flash · ${MONTH_NAMES[month-1]} ${year} (Work Performed)`;
    ws.getCell('A1').font = { bold: true, size: 14, color: { argb: NAVY } };
    ws.getCell('A2').value = `Exported ${new Date().toLocaleString()}`;
    ws.getCell('A2').font = { italic: true, size: 10, color: { argb: 'FF79828C' } };

    const header = ['Project ID', 'Project Name', 'Client', 'Rating', ...labels, 'Variance (latest − #1)'];
    const hr = ws.addRow([]); // spacer
    const head = ws.addRow(header);
    head.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { horizontal: 'center' }; });
    head.getCell(1).alignment = head.getCell(2).alignment = head.getCell(3).alignment = { horizontal: 'left' };

    const fmt = '"$"#,##0';
    let totals = { live: 0 }; labels.forEach(l => totals[l] = 0);
    [...ids].map(id => {
      const base = live[id] || (function(){ for (const l of labels) if (snaps[l] && snaps[l].rows[id]) return snaps[l].rows[id]; return {}; })();
      const cells = [base.projId || '', base.name || '', base.client || '', base.rating || ''];
      const vals = labels.map(l => (snaps[l] && snaps[l].rows[id]) ? snaps[l].rows[id].amount : (l === labels[0] ? null : null));
      // If no snapshot for a label, show the LIVE amount only in the last (latest) col context
      return { id, cells, vals, liveAmt: live[id] ? live[id].amount : 0, sort: base.rating || 9 };
    }).sort((a,b)=> a.sort - b.sort).forEach(rowObj => {
      // latest known = last non-null snapshot, else live
      let latest = null; for (let i = labels.length - 1; i >= 0; i--) if (rowObj.vals[i] != null) { latest = rowObj.vals[i]; break; }
      if (latest == null) latest = rowObj.liveAmt;
      const first = rowObj.vals[0] != null ? rowObj.vals[0] : null;
      const variance = (first != null) ? (latest - first) : null;
      const row = ws.addRow([...rowObj.cells, ...rowObj.vals.map(v => v == null ? '' : v), variance == null ? '' : variance]);
      labels.forEach((l, i) => { const c = row.getCell(5 + i); c.numFmt = fmt; if (snaps[l] && snaps[l].rows[rowObj.id]) totals[l] += rowObj.vals[i] || 0; });
      const vc = row.getCell(5 + labels.length); vc.numFmt = fmt;
      if (variance != null && Math.abs(variance) > 0.5) vc.font = { bold: true, color: { argb: variance < 0 ? RED : GRN } };
    });
    // Totals row
    const tot = ws.addRow(['', 'TOTAL', '', '', ...labels.map(l => totals[l]), '']);
    tot.eachCell(c => { c.font = { bold: true, color: { argb: NAVY } }; });
    labels.forEach((l, i) => { tot.getCell(5 + i).numFmt = fmt; tot.getCell(5 + i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YEL } }; });
    ws.columns.forEach((c, i) => { c.width = i === 1 ? 40 : (i === 2 ? 24 : 16); });

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Savills PPM Flash ${year}-${String(month).padStart(2,'0')}.xlsx`;
    a.click();
  }

  $('#edit-toggle')?.addEventListener('click', () => {
    editMode = !editMode;
    $('#edit-toggle').classList.toggle('on', editMode);
    $('#edit-toggle').textContent = editMode ? '✓ Done editing' : '✎ Edit';
    document.getElementById('matrix-scroll').classList.toggle('editing', editMode);
    build();
  });
  $('#show-excluded')?.addEventListener('change', e => { showExcluded = e.target.checked; build(); });
  {
    const cb = $('#show-closed');
    if (cb) {
      cb.checked = showClosed;
      cb.addEventListener('change', e => {
        showClosed = e.target.checked;
        try { localStorage.setItem(CLOSED_PREF, showClosed ? '1' : '0'); } catch (err) {}
        build();
      });
    }
  }
  $('#show-broker')?.addEventListener('change', e => { showBroker = e.target.checked; build(); });
  $('#show-pass')?.addEventListener('change', e => { showPass = e.target.checked; build(); });
  $('#xlsx-export')?.addEventListener('click', exportProjections);
  ['f-client','f-leader','f-service','f-industry','f-ptype','f-year','f-quarter','f-month'].forEach(id => {
    $('#' + id)?.addEventListener('change', () => { $('#empty').innerHTML = 'No projects yet. <a href="Universal Fee Calculator.html">Build one in the calculator →</a> or <a href="Ingestion Studio.html">ingest a proposal →</a>'; build(); });
  });
  $('#clear-filters')?.addEventListener('click', () => {
    ['f-client','f-leader','f-service','f-industry','f-ptype','f-year','f-quarter','f-month'].forEach(id => { const el = $('#' + id); if (el) el.value = ''; });
    $('#empty').innerHTML = 'No projects yet. <a href="Universal Fee Calculator.html">Build one in the calculator →</a> or <a href="Ingestion Studio.html">ingest a proposal →</a>';
    build();
  });
  /* ---------- open slips banner ---------- */
  const MLBL = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const YMLBL = (ym) => { const [y, m] = String(ym).split('-').map(Number); return MLBL[m - 1] + ' ' + y; };
  const monthsBetween = (a, b) => { const [ay, am] = String(a).split('-').map(Number), [by, bm] = String(b).split('-').map(Number); return (by - ay) * 12 + (bm - am); };
  /* ---------- possible double-counted rows ----------
     From the Aug 13 review: Lazard appeared BOTH as a rolled-up line and as
     its broken-out change-management / PPM / workplace lines, so the same
     money was counted twice ("that line at the bottom is duplicative").

     The signature of a roll-up is arithmetic, not naming: within one client
     and one month, a row whose figure equals the sum of that client's OTHER
     rows is almost certainly the parent of them. Requiring the pattern to
     hold in at least two months keeps a single-month coincidence from
     firing, and requiring at least two siblings stops an ordinary pair of
     equal-sized projects looking like a parent and child.

     Flags only. A client really can have one project the same size as the
     rest combined, so nothing is hidden or altered — the row is badged and
     listed, and a human decides. */
  function findDoubleCounts(rows) {
    const TOL = 0.02;                      // 2% — rounding, not a real difference
    const byClient = {};
    rows.forEach(r => {
      const k = (r.client || '').trim().toLowerCase();
      if (!k) return;                      // no client, no sibling set to compare against
      (byClient[k] = byClient[k] || []).push(r);
    });
    const out = [];
    Object.values(byClient).forEach(list => {
      if (list.length < 3) return;         // need a parent plus >= 2 children
      list.forEach(r => {
        const months = [];
        Object.keys(r.map).forEach(mk => {
          const mine = r.map[mk] || 0;
          if (mine <= 0) return;
          const others = list.reduce((t, o) => (o === r ? t : t + (o.map[mk] || 0)), 0);
          if (others <= 0) return;
          const siblings = list.filter(o => o !== r && (o.map[mk] || 0) > 0).length;
          if (siblings < 2) return;
          if (Math.abs(mine - others) / Math.max(mine, others) <= TOL) months.push(mk);
        });
        if (months.length >= 2) {
          months.sort();
          out.push({ row: r, months, amount: months.reduce((t, mk) => t + (r.map[mk] || 0), 0),
                     siblings: list.filter(o => o !== r).length });
        }
      });
    });
    return out.sort((a, b) => b.amount - a.amount);
  }

  function renderDoubleCounts(dupes) {
    const bar = $('#dup-bar');
    if (!bar) return;
    if (!dupes.length) { bar.hidden = true; return; }
    bar.hidden = false;
    const tot = dupes.reduce((a, d) => a + d.amount, 0);
    bar.innerHTML = `<div class="dup-head">⚠ <b>${dupes.length} row${dupes.length === 1 ? '' : 's'} may be counted twice</b>
      — ${fmtFull(tot)} across the flagged months. Each of these matches the sum of its client\u2019s other rows, which is what a roll-up sitting on top of its own parts looks like.</div>
      <table class="dup-tbl"><thead><tr><th>Project</th><th>Client</th><th>Months</th><th style="text-align:right">In those months</th></tr></thead><tbody>`
      + dupes.map(d => `<tr>
          <td><a href="Universal Fee Calculator.html?id=${encodeURIComponent(d.row.p.id)}">${esc((d.row.pj || {}).name || 'Untitled')}</a></td>
          <td>${esc(d.row.client || '')}</td>
          <td>${d.months.length} of ${Object.keys(d.row.map).length}<span class="dup-mo"> · ${esc(d.months.slice(0, 3).map(mk => { const [y, m] = mk.split('-'); return MONTHS[+m - 1] + ' ' + String(y).slice(2); }).join(', '))}${d.months.length > 3 ? '…' : ''}</span></td>
          <td style="text-align:right">${fmtFull(d.amount)}</td>
        </tr>`).join('')
      + `</tbody></table><div class="dup-foot">Nothing has been changed or hidden — a client really can have one project the size of the rest combined. If it is a duplicate, delete the roll-up and keep the parts.</div>`;
  }

  function renderSlips() {
    const bar = $('#slip-bar');
    if (!STORE.allOpenSlips) { bar.hidden = true; return; }
    const slips = STORE.allOpenSlips();
    if (!slips.length) { bar.hidden = true; return; }
    bar.hidden = false;
    const total = slips.reduce((a, s) => a + Math.abs(Number((s.kind || 'slip') === 'adjust' ? s.delta : s.amount) || 0), 0);
    const nAdj = slips.filter(s => (s.kind || 'slip') === 'adjust').length;
    const nSlip = slips.length - nAdj;
    $('#slip-sub').innerHTML = `<b>${slips.length}</b> open change${slips.length === 1 ? '' : 's'} from Revenue Reconciliation`
      + (nSlip ? ` — ${nSlip} moved to a later month` : '') + (nAdj ? `${nSlip ? ',' : ' —'} ${nAdj} plan adjustment${nAdj === 1 ? '' : 's'}` : '')
      + ` — <b>${fmtExact(total)}</b>. Red below until the schedule is moved and each one is reconciled.`;
    $('#slip-list').innerHTML = `<table><thead><tr>
        <th>Project</th><th>Change</th><th>Month(s)</th><th style="text-align:right">Amount</th><th></th>
      </tr></thead><tbody>` + slips.map(s => {
        const isAdj = (s.kind || 'slip') === 'adjust';
        const amt = Number(isAdj ? s.delta : s.amount) || 0;
        const shift = isAdj ? 0 : monthsBetween(s.fromYm, s.toYm);
        return `<tr>
        <td><strong>${esc(s.name)}</strong><div class="sl-note">${esc(s.client || '')}${s.note ? ' · ' + esc(s.note) : ''}</div>
            <a class="sl-open" href="Universal Fee Calculator.html?project=${encodeURIComponent(s.projectId)}">Open in calculator →</a></td>
        <td>${isAdj ? 'Plan adjusted' : 'Slipped ' + shift + ' month' + (Math.abs(shift) === 1 ? '' : 's')}</td>
        <td>${isAdj ? YMLBL(s.ym) : YMLBL(s.fromYm) + ' → ' + YMLBL(s.toYm)}</td>
        <td class="n">${fmtExact(amt)}</td>
        <td>${!isAdj && shift ? `<button class="sl-shift" data-pid="${s.projectId}" data-n="${shift}">Shift schedule ${shift > 0 ? '+' : ''}${shift}</button>` : ''}
            <button class="sl-ok" data-pid="${s.projectId}" data-sid="${s.id}">Reconciled</button></td>
      </tr>`; }).join('') + '</tbody></table>';
    document.querySelectorAll('#slip-list .sl-shift').forEach(b => b.addEventListener('click', () => {
      const n = +b.dataset.n;
      if (!confirm(`Move this project's whole schedule ${n > 0 ? 'out' : 'in'} by ${Math.abs(n)} month${Math.abs(n) === 1 ? '' : 's'}?\n\nPhase lengths stay the same; the start date and every month of staffing move with it.`)) return;
      try { STORE.shiftSchedule(b.dataset.pid, n); } catch (e) { alert(e.message); return; }
      prepData(); build();
    }));
    document.querySelectorAll('#slip-list .sl-ok').forEach(b => b.addEventListener('click', () => {
      try { STORE.reconcileSlip(b.dataset.pid, b.dataset.sid, true); } catch (e) { alert(e.message); return; }
      prepData(); build();
    }));
  }
  $('#slip-toggle')?.addEventListener('click', () => {
    const l = $('#slip-list'); const open = l.classList.toggle('open');
    $('#slip-toggle').textContent = open ? 'Hide' : 'Show';
  });

  function boot() { prepData(); build(); initFlash(); renderSlips(); }
  if (window.ufcReady && window.ufcReady.then) { window.ufcReady.then(boot); } else { boot(); }
})();
