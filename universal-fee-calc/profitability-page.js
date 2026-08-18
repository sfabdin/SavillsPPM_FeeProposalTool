/* ============================================================
   SAVILLS PPM · PROFITABILITY PAGE
   ------------------------------------------------------------
   Standalone view: the whole revenue projection (same rows, math
   and rating rules as Revenue Projections) with Clockify burn
   (hours × cost rate by title) laid against it by month.
   Data: projects.json (revenue) + staff.json (actuals/mappings)
   + rates.json (cost rates) — all via the shared boot.
   Mapping toggles: fee-link pickers and title pinning inline,
   saved to staff.json for the whole team.
   ============================================================ */
(function () {
  'use strict';
  const STORE = window.UFC_Store;
  const S = window.UFC_Staff;

  /* ACCESS WALL — fail-CLOSED, and deliberately NOT a second copy of the
     admin list. This page used to keep its own hardcoded set, which drifted
     out of step with store.js the moment anyone was added or removed. One
     list, in the identity layer: isAdmin() covers full admins and tool
     admins (admin tools, member-scoped project data). */
  function accessOk() {
    try { return !!(STORE && STORE.isAdmin && STORE.isAdmin()); } catch (e) { return false; }
  }

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtD = (n) => (n < 0 ? '−' : '') + '$' + Math.abs(Math.round(n)).toLocaleString();
  const fmtK = (n) => { if (!n) return ''; const k = n / 1000; return Math.abs(k) >= 1000 ? '$' + (k / 1000).toFixed(1) + 'M' : '$' + (Math.abs(k) >= 100 ? Math.round(k) : k.toFixed(1)) + 'K'; };
  let toastT = null;
  function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 3200); }

  const state = { winStart: null, winLen: 12, search: '', client: '', scope: 'included', showMap: false, expanded: new Set(), monthPick: {} };
  function months() { const out = []; let c = state.winStart; for (let i = 0; i < state.winLen; i++) { out.push(c); c = S.ymAdd(c, 1); } return out; }

  /* Detail GRID under an expanded row: people down the side, months across —
     hours + cost per cell. mFocus narrows to one clicked month. */
  function detailGrid(x, ms, mFocus) {
    if (!x.ppl.length) return '<span class="note-txt">No logged hours against this project in the window.</span>';
    const cols = mFocus ? [mFocus] : ms;
    const showPpl = mFocus ? x.ppl.filter(p => p.byMonth[mFocus]) : x.ppl;
    if (!showPpl.length) return '<span class="note-txt">No hours logged in ' + esc(S.ymLabel(mFocus)) + ' — click another month or the project name for the full window.</span>';
    let h = '<div style="display:flex;align-items:center;gap:12px;margin-bottom:6px"><span style="font-family:var(--font-display);font-weight:700;font-size:11px;color:var(--sav-navy)">' + (mFocus ? esc(S.ymLabel(mFocus)) + ' · staffing' : 'Full window · staffing') + '</span>' + (mFocus ? '<a href="#" data-clear-month="' + esc(x.key) + '" style="font-size:11px">show all months</a>' : '') + '</div>';
    h += '<div class="cmp-scroll dg-scroll"><table class="dt" style="width:auto;min-width:420px"><thead><tr><th class="sticky-col dg-who">Person</th><th>Rate</th>' + cols.map(m => '<th class="num">' + esc(S.ymLabel(m)) + '<div class="vmini" style="text-transform:none;letter-spacing:0">h · $</div></th>').join('') + '<th class="num">Total h</th><th class="num">Total $</th></tr></thead><tbody>';
    showPpl.forEach(p => {
      h += '<tr><td class="pname sticky-col dg-who">' + esc(p.name) + (p.title ? '<div class="vmini">' + esc(p.title) + '</div>' : '') + '</td><td class="num vmini">$' + p.rate + '/h</td>';
      cols.forEach(m => { const c = p.byMonth[m]; h += '<td class="num">' + (c ? Math.round(c.hours * 10) / 10 + '<div class="vmini">' + fmtD(c.cost) + '</div>' : '<span style="color:#c9cdd3">·</span>') + '</td>'; });
      const fh = mFocus ? (p.byMonth[mFocus] || { hours: 0 }).hours : p.hours;
      const fc = mFocus ? (p.byMonth[mFocus] || { cost: 0 }).cost : p.cost;
      h += '<td class="num" style="font-weight:700">' + Math.round(fh * 10) / 10 + '</td><td class="num" style="font-weight:700">' + fmtD(fc) + '</td></tr>';
    });
    h += '</tbody></table></div>';
    return h;
  }

  function render() {
    const ms = months();
    const nowYm = S.currentYM();
    const r = S.profitability(ms);
    if (!r.ok) { $('#p-profit').innerHTML = '<div class="empty">Rates not loaded — sign in and wait for rates.json (dollars need the cost-rate catalog).</div>'; return; }
    let rows = r.rows;
    const clients = [...new Set(r.rows.map(x => x.client).filter(Boolean))].sort();
    const q = state.search.toLowerCase();
    if (q) rows = rows.filter(x => (x.project + ' ' + x.client + ' ' + x.srcNames.join(' ')).toLowerCase().includes(q));
    if (state.client) rows = rows.filter(x => x.client === state.client);
    if (state.scope === 'booked') rows = rows.filter(x => x.booked || x.noLink);
    else if (state.scope === 'included') rows = rows.filter(x => x.included || x.noLink || x.cost > 0);
    const inc = rows.filter(x => x.included);
    const revM = {}, costM = {}; ms.forEach(m => { revM[m] = 0; costM[m] = 0; });
    let totRev = 0, totCost = 0;
    inc.forEach(x => { ms.forEach(m => { revM[m] += x.revByMonth[m] || 0; }); totRev += x.revTotal; });
    rows.forEach(x => { ms.forEach(m => { costM[m] += x.costByMonth[m] || 0; }); totCost += x.cost; });
    const losing = inc.filter(x => x.cost > 0 && x.revTotal > 0 && x.cost > x.revTotal);

    let html = '<div class="kpi-strip">'
      + '<div class="kpi-card accent"><div class="k-num">' + fmtD(totRev) + '</div><div class="k-lbl">Revenue · ratings 1–4 · ' + esc(S.ymLabel(ms[0])) + '–' + esc(S.ymLabel(ms[ms.length - 1])) + '</div></div>'
      + '<div class="kpi-card"><div class="k-num">' + fmtD(totCost) + '</div><div class="k-lbl">Cost · Clockify hours × cost rate</div></div>'
      + '<div class="kpi-card ' + (totRev - totCost < 0 ? 'warn' : '') + '"><div class="k-num">' + fmtD(totRev - totCost) + '</div><div class="k-lbl">Margin' + (totRev ? ' · ' + Math.round((totRev - totCost) / totRev * 100) + '%' : '') + '</div></div>'
      + '<div class="kpi-card ' + (losing.length ? 'warn' : '') + '"><div class="k-num">' + losing.length + '</div><div class="k-lbl">Projects with cost above revenue</div></div>'
      + '</div>';
    /* Unpriced hours make every margin below read BETTER than reality, so say
       how big the hole is — not just who is in it. Margins are still shown
       (they are directionally useful); this is the asterisk on them. */
    if (r.noRate.length) {
      const up = r.unpriced || { hours: 0 };
      const who = r.noRate.length === 1 ? '1 person' : r.noRate.length + ' people';
      html += '<div class="note-txt" style="margin:-8px 0 12px;color:#8a6d00">⚠ <strong>' + Math.round(up.hours).toLocaleString() + ' hours are missing from every cost figure below</strong> — no cost rate for ' + who + ': ' + esc(r.noRate.slice(0, 10).join(' · ')) + (r.noRate.length > 10 ? ' …' : '') + '. Margins shown are therefore <strong>better than actual</strong>. Pin their titles on the <a href="Staffing Matrix.html">Staffing Matrix</a> Mapping tab.</div>';
    }
    if (!r.hasActuals) html += '<div class="note-txt" style="margin:-4px 0 12px;color:#8a6d00">No Clockify actuals loaded — cost rows are empty. Pull actuals on the <a href="Staffing Matrix.html">Staffing Matrix</a> Compare tab.</div>';
    const macroFlag = S.substantialMacroTime(ms);
    if (macroFlag.flagged.length) html += '<div class="note-txt" style="margin:-4px 0 12px;color:#8a6d00">🏢 ' + macroFlag.flagged.length + ' ' + (macroFlag.flagged.length > 1 ? 'people' : 'person') + ' with &gt;40h non-billable/internal time this window: ' + esc(macroFlag.flagged.slice(0, 8).map(x => x.person.name + ' (' + Math.round(x.hours) + 'h)').join(' · ')) + (macroFlag.flagged.length > 8 ? ' …' : '') + ' — see “Non-billable / internal time” below for the $ detail.</div>';
    html += '<div class="toolbar">'
      + '<input type="search" id="pf-search" placeholder="Filter projects…" value="' + esc(state.search) + '">'
      + '<select id="pf-client"><option value="">All clients</option>' + clients.map(c => '<option ' + (state.client === c ? 'selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>'
      + '<select id="pf-scope"><option value="included" ' + (state.scope === 'included' ? 'selected' : '') + '>Ratings 1–4 + anything with hours</option><option value="booked" ' + (state.scope === 'booked' ? 'selected' : '') + '>Booked (rating 1) only</option><option value="all" ' + (state.scope === 'all' ? 'selected' : '') + '>All ratings</option></select>'
      + '<span class="grow"></span>'
      + '<span class="note-txt">Rev = projection invoice (booked snapshot / fee schedule + COs) · Cost = hours × cost rate · greyed rows excluded from totals · click a row for who\'s burning</span></div>';
    html += chart(ms, revM, costM);

    const feeList = S.listFeeProjects();
    const ratingBadge = (x) => x.noLink ? '<span class="badge pursuit" title="hours logged, no fee-tool link">no fee link</span>' : '<span class="badge ' + (x.booked ? 'active' : x.included ? '' : 'pursuit') + '" title="projection rating">' + x.rating + (x.booked ? ' · booked' : '') + '</span>';
    let body = '';
    rows.forEach((x, i) => {
      const margin = x.revTotal - x.cost;
      const dim = !(x.included || x.noLink) ? 'opacity:0.55;' : '';
      const mapCtl = state.showMap && x.noLink ? '<br><input list="pf-fee-dl" data-map-fee="' + esc(x.project) + '" class="fee-link-sel" placeholder="link to fee project…">' : '';
      body += '<tr class="pf-row" data-i="' + i + '" style="cursor:pointer;' + dim + '"><td class="pname sticky-col" style="background:#fff">' + esc(x.project) + '<div class="vmini">' + esc(x.client || '') + ' ' + ratingBadge(x) + (x.srcNames.length && x.srcNames[0] !== x.project ? ' <span class="vmini" title="matrix/Clockify source">⇐ ' + esc(x.srcNames.join(', ')) + '</span>' : '') + '</div>' + mapCtl + '</td>';
      ms.forEach(m => {
        const rv = x.revByMonth[m] || 0, cv = x.costByMonth[m] || 0;
        body += '<td class="num pf-mcell" data-i="' + i + '" data-m="' + m + '" title="' + esc(S.ymLabel(m)) + ' · rev ' + fmtD(rv) + ' · cost ' + fmtD(cv) + ' — click for that month\'s staffing">' + (rv ? '<div>' + fmtK(rv) + '</div>' : '<div style="color:#c9cdd3">·</div>') + (cv ? '<div class="vmini" style="color:' + (cv > rv ? '#C0392B' : '#0E7C7B') + '">' + fmtK(cv) + '</div>' : '') + '</td>';
      });
      body += '<td class="num" style="font-weight:700">' + (x.revTotal ? fmtD(x.revTotal) : '—') + '</td><td class="num">' + (x.cost ? fmtD(x.cost) : '—') + '<div class="vmini">' + (x.hours ? Math.round(x.hours).toLocaleString() + ' h' : '') + '</div></td><td class="num ' + (margin < 0 ? 'var-over' : x.revTotal ? 'var-ok' : '') + '">' + ((x.revTotal || x.cost) ? fmtD(margin) : '—') + '</td><td class="num ' + (x.revTotal && margin / x.revTotal < 0.2 ? 'var-over' : '') + '">' + (x.revTotal ? Math.round(margin / x.revTotal * 100) + '%' : '—') + '</td></tr>';
      body += '<tr class="pf-detail" data-i="' + i + '" style="display:' + (state.expanded.has(x.key) ? '' : 'none') + '"><td colspan="' + (ms.length + 5) + '" style="background:#faf9f7;padding:10px 16px 14px">' + detailGrid(x, ms, state.monthPick[x.key] || null) + '</td></tr>';
    });
    let totCells = '';
    ms.forEach(m => { totCells += '<td class="num"><div style="font-weight:700">' + (fmtK(revM[m]) || '·') + '</div>' + (costM[m] ? '<div class="vmini" style="color:' + (costM[m] > revM[m] ? '#C0392B' : '#0E7C7B') + '">' + fmtK(costM[m]) + '</div>' : '') + '</td>'; });
    const totRow = '<tr style="background:#f4f6f7;border-top:2px solid rgba(37,39,58,0.25)"><td class="pname sticky-col" style="background:#f4f6f7;font-weight:700">Total · ' + inc.length + ' included</td>' + totCells + '<td class="num" style="font-weight:700">' + fmtD(totRev) + '</td><td class="num" style="font-weight:700">' + fmtD(totCost) + '</td><td class="num ' + (totRev - totCost < 0 ? 'var-over' : 'var-ok') + '" style="font-weight:700">' + fmtD(totRev - totCost) + '</td><td class="num">' + (totRev ? Math.round((totRev - totCost) / totRev * 100) + '%' : '—') + '</td></tr>';
    // ---- bottom lines: staff cost OUTSIDE the fee mapping ----
    const oh = r.overhead || { byMonth: {}, cost: 0, hours: 0, ppl: [], byProj: {} };
    const ohTop = Object.entries(oh.byProj || {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([p2, c2]) => esc(p2) + ' ' + fmtK(c2)).join(' · ');
    let ohCells = ''; ms.forEach(m => { ohCells += '<td class="num vmini" style="color:#8a6d00">' + (oh.byMonth[m] ? fmtK(oh.byMonth[m]) : '·') + '</td>'; });
    const ohRow = oh.cost ? '<tr class="pf-oh" style="background:#fdf9ee;cursor:pointer"><td class="pname sticky-col" style="background:#fdf9ee">Non-billable / internal time <span class="badge pursuit">outside fee mapping</span><div class="vmini">' + ohTop + (Object.keys(oh.byProj).length > 4 ? ' …' : '') + ' · click for people</div></td>' + ohCells + '<td class="num">—</td><td class="num" style="font-weight:700;color:#8a6d00">' + fmtD(oh.cost) + '<div class="vmini">' + Math.round(oh.hours).toLocaleString() + ' h</div></td><td class="num">—</td><td class="num">—</td></tr>'
      + '<tr class="pf-oh-detail" style="display:' + (state.expanded.has('overhead') ? '' : 'none') + '"><td colspan="' + (ms.length + 5) + '" style="background:#fdf9ee;padding:10px 16px 14px">' + detailGrid({ ppl: oh.ppl, key: 'overhead' }, ms, state.monthPick['overhead'] || null) + '</td></tr>' : '';
    // ---- PTO / vacation / holiday — macro time, but not discretionary overhead ----
    const to = r.timeOff || { byMonth: {}, cost: 0, hours: 0, ppl: [], byProj: {} };
    let toCells = ''; ms.forEach(m => { toCells += '<td class="num vmini" style="color:#5a6070">' + (to.byMonth[m] ? fmtK(to.byMonth[m]) : '·') + '</td>'; });
    const toRow = to.cost ? '<tr class="pf-to" style="background:#f7f7f9;cursor:pointer"><td class="pname sticky-col" style="background:#f7f7f9">PTO · vacation · holiday <span class="badge">not overhead</span><div class="vmini">Time off, priced at cost so the hours reconcile — held apart from non-billable work · click for people</div></td>' + toCells + '<td class="num">—</td><td class="num" style="font-weight:700;color:#5a6070">' + fmtD(to.cost) + '<div class="vmini">' + Math.round(to.hours).toLocaleString() + ' h</div></td><td class="num">—</td><td class="num">—</td></tr>'
      + '<tr class="pf-to-detail" style="display:' + (state.expanded.has('timeoff') ? '' : 'none') + '"><td colspan="' + (ms.length + 5) + '" style="background:#f7f7f9;padding:10px 16px 14px">' + detailGrid({ ppl: to.ppl, key: 'timeoff' }, ms, state.monthPick['timeoff'] || null) + '</td></tr>' : '';
    const allCost = totCost + oh.cost;
    let allCells = ''; ms.forEach(m => { const v = (costM[m] || 0) + (oh.byMonth[m] || 0); allCells += '<td class="num" style="font-weight:700">' + (v ? fmtK(v) : '·') + '</td>'; });
    const allRow = '<tr style="background:#eceff1;border-top:2px solid rgba(37,39,58,0.35)"><td class="pname sticky-col" style="background:#eceff1;font-weight:700">All staff cost · fee-mapped + non-billable</td>' + allCells + '<td class="num">' + fmtD(totRev) + '</td><td class="num" style="font-weight:700">' + fmtD(allCost) + '</td><td class="num ' + (totRev - allCost < 0 ? 'var-over' : 'var-ok') + '" style="font-weight:700">' + fmtD(totRev - allCost) + '</td><td class="num">' + (totRev ? Math.round((totRev - allCost) / totRev * 100) + '%' : '—') + '</td></tr>';
    html += '<div class="cmp-scroll"><table class="dt"><thead><tr><th class="sticky-col">Project</th>' + ms.map(m => '<th class="num">' + esc(S.ymLabel(m)) + (m === nowYm ? '<div class="vmini" style="text-transform:none">current</div>' : '') + '<div class="vmini" style="text-transform:none;letter-spacing:0">rev / cost</div></th>').join('') + '<th class="num">Revenue</th><th class="num">Cost</th><th class="num">Margin</th><th class="num">%</th></tr></thead><tbody>' + (body || '<tr><td colspan="' + (ms.length + 5) + '"><div class="empty" style="border:0">Nothing matches the filter.</div></td></tr>') + totRow + ohRow + toRow + allRow + '</tbody></table></div>'
      + '<datalist id="pf-fee-dl">' + feeList.map(p => '<option value="' + esc(p.label) + '"></option>').join('') + '</datalist>';
    $('#p-profit').innerHTML = html;

    $('#pf-search').oninput = (e) => { state.search = e.target.value; render(); const el = $('#pf-search'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); };
    $('#pf-client').onchange = (e) => { state.client = e.target.value; render(); };
    $('#pf-scope').onchange = (e) => { state.scope = e.target.value; render(); };
    const feeByLabel = {}; feeList.forEach(p => feeByLabel[p.label.toLowerCase()] = p.id);
    $$('#p-profit [data-map-fee]').forEach(inp => {
      inp.onclick = (e) => e.stopPropagation();
      inp.onchange = () => {
        const v = inp.value.trim(); if (!v) return;
        const id = feeByLabel[v.toLowerCase()];
        if (!id) { inp.style.borderColor = '#C0392B'; inp.title = 'Pick a fee project from the list'; return; }
        S.setFeeMapping(inp.dataset.mapFee, id);
        toast('Linked — “' + inp.dataset.mapFee + '” now rolls into that fee project. Saved for the whole team.');
        render();
      };
    });
    const rowsRef = rows;
    $$('#p-profit .pf-mcell').forEach(td => td.onclick = (e) => {
      e.stopPropagation();
      const x = rowsRef[+td.dataset.i]; if (!x) return;
      state.monthPick[x.key] = td.dataset.m;
      state.expanded.add(x.key);
      render();
    });
    $$('#p-profit [data-clear-month]').forEach(a => a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); delete state.monthPick[a.dataset.clearMonth]; render(); });
    $$('#p-profit .pf-oh').forEach(tr => tr.onclick = () => { if (state.expanded.has('overhead')) { state.expanded.delete('overhead'); delete state.monthPick['overhead']; } else state.expanded.add('overhead'); render(); });
    $$('#p-profit .pf-to').forEach(tr => tr.onclick = () => { if (state.expanded.has('timeoff')) { state.expanded.delete('timeoff'); delete state.monthPick['timeoff']; } else state.expanded.add('timeoff'); render(); });
    $$('#p-profit .pf-row').forEach(tr => tr.onclick = () => {
      const x = rowsRef[+tr.dataset.i]; if (!x) return;
      if (state.expanded.has(x.key)) { state.expanded.delete(x.key); delete state.monthPick[x.key]; } else state.expanded.add(x.key);
      render();
    });
  }

  function chart(ms, bM, cM) {
    const W = Math.max(560, ms.length * 90), H = 200, padL = 58, padT = 14, padB = 28, padR = 8;
    const max = Math.max(1, ...ms.map(m => Math.max(bM[m], cM[m])));
    const y = (v) => padT + (H - padT - padB) * (1 - v / max);
    const gw = (W - padL - padR) / ms.length;
    let s = '';
    for (let i = 0; i <= 4; i++) { const v = max * i / 4, yy = y(v); s += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + yy + '" y2="' + yy + '" stroke="rgba(37,39,58,.08)"></line><text x="' + (padL - 6) + '" y="' + (yy + 3) + '" text-anchor="end" font-size="9" fill="#79828C">$' + Math.round(v / 1000) + 'k</text>'; }
    const bw = Math.max(10, Math.min(30, (gw - 18) / 2));
    ms.forEach((m, i) => {
      const x0 = padL + i * gw + (gw - 2 * bw - 4) / 2;
      [[bM[m], '#0E7C7B', 'Revenue', ''], [cM[m], '#FFDF00', 'Cost', 'stroke="#25273A" stroke-width="1"']].forEach(([v, c, nm, st], j) => {
        const xx = x0 + j * (bw + 4), yy = y(v);
        s += '<rect x="' + xx + '" y="' + yy + '" width="' + bw + '" height="' + Math.max(0, H - padB - yy) + '" fill="' + c + '" ' + st + '><title>' + nm + ' · ' + S.ymLabel(m) + ': ' + fmtD(v) + '</title></rect>';
      });
      s += '<text x="' + (padL + i * gw + gw / 2) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="#25273A" font-weight="600">' + esc(S.ymLabel(m)) + '</text>';
    });
    return '<div style="background:#fff;border:1px solid rgba(37,39,58,0.12);padding:14px 16px;margin-bottom:16px">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:8px">'
      + '<div style="font-family:var(--font-display);font-weight:700;font-size:12px;color:var(--sav-navy)">Revenue vs cost by month — filtered set</div>'
      + '<div class="note-txt"><span style="color:#0E7C7B">■</span> Revenue (projection)&nbsp;&nbsp;<span style="color:#e8c400">■</span> Cost (hours × cost rate) · gap = margin</div>'
      + '</div><svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;display:block">' + s + '</svg></div>';
  }

  /* ---------- identity bar (same pattern as staffing) ---------- */
  function buildIdentityBar() {
    const sel = $('#id-user'); const label = document.querySelector('.identity-bar .id-label');
    const cur = STORE.getCurrentUser();
    if (!STORE.canImpersonate()) {
      if (sel) sel.style.display = 'none';
      if (label) label.textContent = 'Signed in as';
      let nameEl = document.getElementById('id-static-name');
      if (!nameEl && sel) { nameEl = document.createElement('span'); nameEl.id = 'id-static-name'; nameEl.style.cssText = 'font-family:var(--font-display);font-weight:700;font-size:13px;color:#fff;margin:0 4px;'; sel.parentNode.insertBefore(nameEl, sel.nextSibling); }
      if (nameEl) nameEl.textContent = (cur && cur.name) || '(unrecognized)';
      return;
    }
    const users = STORE.listUsers ? STORE.listUsers() : [];
    sel.innerHTML = users.map(u => '<option value="' + esc(u.username) + '"' + (cur && cur.username === u.username ? ' selected' : '') + '>' + esc(u.name || u.username) + '</option>').join('');
    sel.onchange = () => { STORE.impersonate(sel.value); window.location.reload(); };
  }

  function renderDenied() {
    document.querySelector('.wrap').innerHTML = '<header class="head"><img class="logo" src="design-system/assets/savills_logo.png" alt="Savills"><div class="title-block"><h1>Profitability</h1><p class="tagline">Restricted tool.</p></div></header>'
      + '<div class="empty" style="padding:70px 40px"><div style="font-family:var(--font-display);font-weight:800;font-size:20px;color:var(--sav-navy);margin-bottom:10px">This tool is limited to staffing leadership.</div>'
      + '<div style="max-width:460px;margin:0 auto;line-height:1.6">If you need profitability information, contact Sarah Abdin.</div>'
      + '<div style="margin-top:22px"><a href="Fee Generator.html" class="btn" style="text-decoration:none">System home</a></div></div>';
  }

  function setStoreNote() {
    const el = $('#store-note'); if (!el) return;
    const Box = window.UFC_Box;
    el.textContent = (Box && Box.enabled) ? 'Live · projects.json + staff.json + rates.json from Box' : 'Local data only';
  }

  async function init() {
    if (!accessOk()) { renderDenied(); return; }
    buildIdentityBar();
    // shared staff.json (actuals + mappings) — pull latest before first render
    try { const Box = window.UFC_Box; if (Box && Box.enabled && Box.pullStaff) { const remote = await Box.pullStaff(); if (remote) S.hydrateFromRemote(remote); } } catch (e) {}
    setStoreNote();
    state.winStart = S.ymAdd(S.currentYM(), -3);
    const startSel = $('#win-start');
    const opts = []; let c = S.ymAdd(S.currentYM(), -18);
    for (let i = 0; i < 36; i++) { opts.push(c); c = S.ymAdd(c, 1); }
    startSel.innerHTML = opts.map(m => '<option value="' + m + '"' + (m === state.winStart ? ' selected' : '') + '>' + esc(S.ymLabel(m)) + '</option>').join('');
    startSel.onchange = () => { state.winStart = startSel.value; render(); };
    $('#win-prev').onclick = () => { state.winStart = S.ymAdd(state.winStart, -1); startSel.value = state.winStart; render(); };
    $('#win-next').onclick = () => { state.winStart = S.ymAdd(state.winStart, 1); startSel.value = state.winStart; render(); };
    $('#win-len').onchange = (e) => { state.winLen = +e.target.value; render(); };
    $('#show-map').onchange = (e) => { state.showMap = e.target.checked; render(); };
    render();
  }

  if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(init); else document.addEventListener('DOMContentLoaded', init);
})();
