/* ============================================================
   SAVILLS PPM · STAFFING & BANDWIDTH — the REVENUE LEADER view
   ------------------------------------------------------------
   What a revenue leader sees on the Staffing Matrix page: their own
   projects only, through the same wall that scopes the Projects Index
   and Revenue Projections (store.userOwnsProject). Three tabs:

     Time vs Plan   planned hours from THEIR proposal, hours allocated
                    in the matrix, hours logged in Clockify — per
                    project, then by month and by person. Excel out.
     My allocations the matrix rows on their projects, editable, plus
                    the contract bridge for their projects.
     Mapping        which Clockify project feeds each of theirs:
                    confirm an auto-match, claim an unclaimed one, or
                    flag it for an admin.

   Nothing here writes a fee project. Allocations, mappings and flags go
   to the staffing store and the trail; the proposal is edited in the
   calculator. Admins see this view through the switch at the top of the
   page, and preview a specific leader with "Viewing as".
   ============================================================ */
(function () {
  'use strict';
  const S = () => window.UFC_Staff;
  const STORE = () => window.UFC_Store;
  const H = () => window.__UFC_STAFF_HOOKS__ || {};
  const $ = (q, el) => (el || document).querySelector(q);
  const $$ = (q, el) => Array.from((el || document).querySelectorAll(q));
  const esc = (v) => window.UFC_UI.esc(v);
  const fmtH = (n) => (n == null || !n) ? '—' : (Math.round(n * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const toast = (m, k) => { try { window.UFC_UI.toast(m, k); } catch (e) {} };
  const L = { tab: 'time', open: new Set(), search: '', ckNames: null, ckError: null };

  /* ---------- scope: the leader's projects, and the matrix names linked to them ---------- */
  function scope(user) {
    const st = STORE(); const u = user || st.getCurrentUser();
    const parents = st.listProjects().filter(p => !(st.isChangeOrder && st.isChangeOrder(p)));
    const fee = parents.filter(p => st.userOwnsProject(p, u))
      .sort((a, b) => (rank(a) - rank(b)) || ((a.project || {}).client || '').localeCompare((b.project || {}).client || '') || ((a.project || {}).name || '').localeCompare((b.project || {}).name || ''));
    const matrixNames = new Set(); const matrixByFee = {};
    fee.forEach(p => { const names = S().matrixProjectsForFee(p.id); matrixByFee[p.id] = names; names.forEach(n => matrixNames.add(n)); });
    return { user: u, fee, matrixNames, matrixByFee, feeIds: new Set(fee.map(p => p.id)) };
  }
  const rank = (p) => { const st = (p.project || {}).status || ''; return st === 'active' ? 0 : st === 'won' ? 1 : /^(negotiation|submitted|draft|hold)$/.test(st) ? 2 : 3; };
  const nameOf = (p) => (p.project || {}).name || 'Untitled';
  const clientOf = (p) => (p.project || {}).client || '';
  const statusLabel = (p) => (STORE().STATUS_LABELS || {})[(p.project || {}).status] || (p.project || {}).status || '';
  const calcLink = (p, text) => `<a href="Universal Fee Calculator.html?id=${encodeURIComponent(p.id)}" target="_blank" rel="noopener" style="color:inherit;font-weight:700" title="Open the proposal in the calculator (new tab)">${esc(text || nameOf(p))}</a>`;
  const allowedProject = (sc, name) => sc.matrixNames.has(name) || sc.fee.some(p => nameOf(p) === name || (clientOf(p) ? clientOf(p) + ' — ' : '') + nameOf(p) === name);

  /* ---------- Time vs Plan ---------- */
  function timeRows(sc, months) {
    const st = S(); const now = st.currentYM();
    const toDate = months.filter(m => m <= now);
    return sc.fee.map(p => {
      const plan = st.feeProjectPlan(p.id, months);
      const act = st.feeProjectActuals(p.id, months);
      const sum = (obj, ms) => ms.reduce((t, m) => t + ((obj || {})[m] || 0), 0);
      const allocBy = {}, actBy = {};
      act.rows.forEach(r => months.forEach(m => { const c = r.byMonth[m] || { e: 0, a: 0 }; allocBy[m] = (allocBy[m] || 0) + c.e; actBy[m] = (actBy[m] || 0) + c.a; }));
      const plannedToDate = plan ? sum(plan.byMonth, toDate) : 0;
      const logged = sum(actBy, toDate);
      const allocToDate = sum(allocBy, toDate);
      const planTotal = plan ? sum(plan.byMonth, months) : 0;
      const remaining = Math.max(0, planTotal - logged);
      const pace = plannedToDate > 0 ? logged / plannedToDate : null;
      const hasActuals = Object.values(actBy).some(v => v > 0);
      let tone = 'n', text = '';
      if (!plan) { tone = 'n'; text = 'no plan — roster not priced in the calculator'; }
      else if (!act.matrixNames.length) { tone = 'w'; text = 'no Clockify project mapped'; }
      else if (!hasActuals) { tone = 'w'; text = 'nothing logged in this window'; }
      else if (pace == null) { tone = 'n'; text = 'plan starts later'; }
      else if (pace > 1.1) { tone = 'r'; text = 'over plan · ' + Math.round((pace - 1) * 100) + '% over'; }
      else if (pace < 0.9) { tone = 'a'; text = 'under plan · ' + Math.round((1 - pace) * 100) + '% under'; }
      else { tone = 'g'; text = 'on plan'; }
      return { p, plan, act, planBy: plan ? plan.byMonth : {}, allocBy, actBy, plannedToDate, allocToDate, logged, planTotal, remaining, pace, tone, text, toDate };
    });
  }
  function paceChip(r) {
    const cls = { g: 'lv-g', a: 'lv-a', r: 'lv-r', w: 'lv-w', n: 'lv-n' }[r.tone];
    return `<span class="lv-chip ${cls}">${esc(r.text)}</span>`;
  }
  function renderTime(sc, host) {
    const months = H().months(); const st = S();
    const rows = timeRows(sc, months);
    const q = L.search.toLowerCase();
    const shown = rows.filter(r => !q || (nameOf(r.p) + ' ' + clientOf(r.p)).toLowerCase().includes(q));
    const tot = shown.reduce((t, r) => { t.plan += r.plannedToDate; t.log += r.logged; t.alloc += r.allocToDate; return t; }, { plan: 0, log: 0, alloc: 0 });
    const over = shown.filter(r => r.tone === 'r').length, under = shown.filter(r => r.tone === 'a').length, noPlan = shown.filter(r => !r.plan).length, noMap = shown.filter(r => r.plan && !r.act.matrixNames.length).length;
    const nowLbl = st.ymLabel(st.currentYM());
    let html = `<div class="lv-head"><div><div class="eyebrow">Your projects · ${esc(st.ymLabel(months[0]))} – ${esc(st.ymLabel(months[months.length - 1]))}</div>
        <h2>Time vs plan</h2>
        <p>Planned hours come from <b>your proposal</b> in the calculator (roles × FTE × hours a month). Logged hours come from <b>Clockify</b>, through the project mapping. "To date" means through ${esc(nowLbl)}. Nothing here changes a fee.</p></div>
        <div class="lv-actions"><button class="btn btn-secondary" id="lv-xlsx" title="Summary, by month and by person — the three layers below as sheets">⬇ Excel</button></div></div>
      <div class="kpis lv-kpis">
        <div class="kpi"><div class="v">${fmtH(tot.plan)}</div><div class="s">planned hours to date</div></div>
        <div class="kpi"><div class="v">${fmtH(tot.log)}</div><div class="s">logged to date</div></div>
        <div class="kpi"><div class="v" style="color:${tot.log - tot.plan > 0 ? 'var(--sav-red)' : 'var(--sav-navy)'}">${tot.log - tot.plan > 0 ? '+' : ''}${fmtH(tot.log - tot.plan)}</div><div class="s">variance (logged − planned)</div></div>
        <div class="kpi"><div class="v">${over} <span class="lv-small">over</span> · ${under} <span class="lv-small">under</span></div><div class="s">projects off plan by more than 10%</div></div>
      </div>`;
    if (noPlan || noMap) html += `<div class="note-txt lv-note">${noPlan ? `<b>${noPlan}</b> project${noPlan === 1 ? ' has' : 's have'} no plan to compare against — the roster is not priced in the calculator. ` : ''}${noMap ? `<b>${noMap}</b> ${noMap === 1 ? 'has' : 'have'} no Clockify project mapped — <a href="#" data-ltab="map" style="font-weight:700">fix it on Mapping</a>.` : ''}</div>`;
    html += `<div class="toolbar"><input type="search" id="lv-search" placeholder="Filter your projects…" value="${esc(L.search)}"><span class="grow"></span><span class="note-txt">Click a project for month and person detail.</span></div>`;
    if (!sc.fee.length) html += `<div class="empty">No projects list you as revenue leader or relationship owner. If that is wrong, the project's leader field in the calculator is what decides.</div>`;
    else if (!shown.length) html += `<div class="empty">Nothing matches the filter.</div>`;
    else {
      html += `<table class="dt lv-table"><thead><tr><th>Client</th><th>Project</th><th>Status</th><th class="num" title="Hours your proposal plans through ${esc(nowLbl)}">Planned to date</th><th class="num" title="Hours allocated in the matrix through ${esc(nowLbl)}">Allocated</th><th class="num" title="Hours logged in Clockify through ${esc(nowLbl)}">Logged</th><th class="num">Variance</th><th>Pace</th><th class="num" title="Planned hours in this window not yet logged">Plan left</th></tr></thead><tbody>`;
      shown.forEach(r => {
        const open = L.open.has(r.p.id);
        const v = r.logged - r.plannedToDate;
        html += `<tr class="lv-row" data-open="${esc(r.p.id)}"><td>${esc(clientOf(r.p))}</td><td class="pname">${esc(nameOf(r.p))}<div class="vmini">${r.act.matrixNames.length ? 'matrix: ' + esc(r.act.matrixNames.join(', ')) : '<span style="color:#8a6d00">no matrix project linked</span>'}</div></td>
          <td><span class="badge ${/active|won/.test((r.p.project || {}).status) ? 'active' : 'pursuit'}">${esc(statusLabel(r.p))}</span></td>
          <td class="num">${fmtH(r.plannedToDate)}</td><td class="num">${fmtH(r.allocToDate)}</td><td class="num">${fmtH(r.logged)}</td>
          <td class="num" style="color:${v > 0 ? 'var(--sav-red)' : 'var(--sav-navy)'}">${r.plan ? (v > 0 ? '+' : '') + fmtH(v) : '—'}</td>
          <td>${paceChip(r)}</td><td class="num">${r.plan ? fmtH(r.remaining) : '—'}</td></tr>`;
        if (open) html += `<tr class="lv-detail"><td colspan="9">${detailHtml(r, months)}</td></tr>`;
      });
      html += `</tbody></table>`;
    }
    host.innerHTML = html;
    $$('.lv-row', host).forEach(tr => tr.onclick = (e) => { if (e.target.closest('a')) return; const id = tr.dataset.open; if (L.open.has(id)) L.open.delete(id); else L.open.add(id); renderTime(sc, host); });
    const sb = $('#lv-search', host); if (sb) sb.oninput = (e) => { L.search = e.target.value; const pos = e.target.selectionStart; renderTime(sc, host); const el = $('#lv-search', host); if (el) { el.focus(); el.setSelectionRange(pos, pos); } };
    const xb = $('#lv-xlsx', host); if (xb) xb.onclick = () => exportExcel(sc, rows, months).catch(e => toast('Excel export failed — ' + (e.message || e)));
    $$('[data-ltab]', host).forEach(a => a.onclick = (e) => { e.preventDefault(); H().setLeaderTab && H().setLeaderTab(a.dataset.ltab); });
  }
  function detailHtml(r, months) {
    const st = S(); const now = st.currentYM();
    const mh = months.map(m => `<th class="num${m === now ? ' lv-now' : ''}">${esc(st.ymLabel(m))}</th>`).join('');
    const line = (label, by, cls) => `<tr class="${cls || ''}"><td class="pname">${label}</td>${months.map(m => `<td class="num${m === now ? ' lv-now' : ''}">${fmtH((by || {})[m])}</td>`).join('')}<td class="num"><b>${fmtH(months.reduce((t, m) => t + ((by || {})[m] || 0), 0))}</b></td></tr>`;
    let html = `<div class="lv-sub"><div class="lv-subh">By month · hours</div><div class="tw"><table class="dt lv-grid"><thead><tr><th></th>${mh}<th class="num">Window</th></tr></thead><tbody>
      ${line('Planned (proposal)', r.planBy)}${line('Allocated (matrix)', r.allocBy)}${line('Logged (Clockify)', r.actBy, 'lv-act')}
      ${line('Logged − planned', Object.fromEntries(months.map(m => [m, ((r.actBy[m] || 0) - (r.planBy[m] || 0)) || 0])), 'lv-var')}</tbody></table></div></div>`;
    if (r.plan && r.plan.roles.length) html += `<div class="lv-sub"><div class="lv-subh">Planned, by title</div><div class="vmini">${r.plan.roles.map(x => esc(x.title) + ' ' + fmtH(x.hours) + ' h').join(' · ')}</div></div>`;
    html += `<div class="lv-sub"><div class="lv-subh">By person · logged (allocated)</div>`;
    if (!r.act.rows.length) html += `<div class="vmini">Nobody has hours or an allocation on this project in the window.</div>`;
    else html += `<div class="tw"><table class="dt lv-grid"><thead><tr><th>Person</th>${mh}<th class="num">Window</th></tr></thead><tbody>${r.act.rows.map(x => `<tr><td class="pname">${esc(x.person.name)}</td>${months.map(m => { const c = x.byMonth[m] || { e: 0, a: 0 }; return `<td class="num${m === now ? ' lv-now' : ''}">${fmtH(c.a)}${c.e ? ` <span class="vmini">(${fmtH(c.e)})</span>` : ''}</td>`; }).join('')}<td class="num"><b>${fmtH(x.actual)}</b> <span class="vmini">(${fmtH(x.expected)})</span></td></tr>`).join('')}</tbody></table></div>`;
    html += `</div><div class="vmini" style="margin-top:8px">${calcLink(r.p, 'Open the proposal in the calculator →')} to change the plan · <a href="#" data-ltab="allocs" style="font-weight:700">My allocations</a> to change who is on it.</div>`;
    return html;
  }
  async function exportExcel(sc, rows, months) {
    await window.UFC_Vendor.excel();
    if (typeof ExcelJS === 'undefined') throw new Error('Excel library not loaded.');
    const st = S(); const wb = new ExcelJS.Workbook(); wb.creator = 'Savills PPM';
    const hdr = (ws) => { ws.getRow(1).eachCell(c => { c.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF25273A' } }; }); ws.views = [{ state: 'frozen', ySplit: 1 }]; };
    const s1 = wb.addWorksheet('Summary');
    s1.columns = [{ header: 'Client', key: 'client', width: 22 }, { header: 'Project', key: 'project', width: 36 }, { header: 'Status', key: 'status', width: 12 }, { header: 'Planned to date', key: 'plan', width: 16 }, { header: 'Allocated to date', key: 'alloc', width: 16 }, { header: 'Logged to date', key: 'log', width: 16 }, { header: 'Variance', key: 'var', width: 12 }, { header: 'Pace', key: 'pace', width: 10 }, { header: 'Planned in window', key: 'ptot', width: 16 }, { header: 'Plan left', key: 'left', width: 12 }, { header: 'Note', key: 'note', width: 40 }];
    rows.forEach(r => s1.addRow({ client: clientOf(r.p), project: nameOf(r.p), status: statusLabel(r.p), plan: +r.plannedToDate.toFixed(1), alloc: +r.allocToDate.toFixed(1), log: +r.logged.toFixed(1), var: +(r.logged - r.plannedToDate).toFixed(1), pace: r.pace == null ? '' : Math.round(r.pace * 100) / 100, ptot: +r.planTotal.toFixed(1), left: +r.remaining.toFixed(1), note: r.text }));
    hdr(s1); s1.getColumn('pace').numFmt = '0%';
    const s2 = wb.addWorksheet('By month');
    s2.columns = [{ header: 'Client', width: 22 }, { header: 'Project', width: 36 }, { header: 'Line', width: 20 }].concat(months.map(m => ({ header: st.ymLabel(m), width: 9 }))).concat([{ header: 'Window', width: 10 }]);
    rows.forEach(r => [['Planned (proposal)', r.planBy], ['Allocated (matrix)', r.allocBy], ['Logged (Clockify)', r.actBy]].forEach(([label, by]) => s2.addRow([clientOf(r.p), nameOf(r.p), label].concat(months.map(m => +((by || {})[m] || 0).toFixed(1))).concat([+months.reduce((t, m) => t + ((by || {})[m] || 0), 0).toFixed(1)]))));
    hdr(s2);
    const s3 = wb.addWorksheet('By person');
    s3.columns = [{ header: 'Client', width: 22 }, { header: 'Project', width: 36 }, { header: 'Person', width: 24 }, { header: 'Line', width: 12 }].concat(months.map(m => ({ header: st.ymLabel(m), width: 9 }))).concat([{ header: 'Window', width: 10 }]);
    rows.forEach(r => r.act.rows.forEach(x => { s3.addRow([clientOf(r.p), nameOf(r.p), x.person.name, 'Logged'].concat(months.map(m => +((x.byMonth[m] || {}).a || 0).toFixed(1))).concat([+x.actual.toFixed(1)])); s3.addRow([clientOf(r.p), nameOf(r.p), x.person.name, 'Allocated'].concat(months.map(m => +((x.byMonth[m] || {}).e || 0).toFixed(1))).concat([+x.expected.toFixed(1)])); }));
    hdr(s3);
    const buf = await wb.xlsx.writeBuffer(); const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'Time vs Plan ' + new Date().toISOString().slice(0, 10) + '.xlsx'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------- My allocations + the contract bridge, scoped ---------- */
  function renderAllocs(sc, host) {
    const st = S(); const now = st.currentYM();
    const rows = st.listAllocations().filter(a => sc.matrixNames.has(a.project))
      .sort((a, b) => (a.project || '').localeCompare(b.project || '') || ((st.getPerson(a.personId) || {}).name || '').localeCompare((st.getPerson(b.personId) || {}).name || ''));
    const gaps = (st.contractStaffingGaps() || []).filter(g => !g.dismissed && (sc.matrixNames.has(g.project) || sc.fee.some(p => nameOf(p) === g.project)));
    const rosterOptions = st.listPeople().filter(p => p.active !== false).map(p => `<option value="${esc(p.name)}">`).join('');
    let html = `<div class="lv-head"><div><div class="eyebrow">Your projects</div><h2>My allocations</h2>
        <p>Who is on your projects, at what percent, from when. Edits here change the staffing matrix only — never a fee. <b>Load</b> is the person's total allocation across every project this month; the other projects stay with their leaders.</p></div>
        <div class="lv-actions"><button class="btn btn-primary" id="lv-add">+ Add allocation</button></div></div>`;
    if (gaps.length) {
      html += `<details class="lv-bridge" open><summary>🤝 Contract staffing to be allocated <span class="lv-chip lv-w">${gaps.length} item${gaps.length === 1 ? '' : 's'}</span><span class="note-txt">your proposals staff these roles; the matrix does not yet</span></summary>
        <datalist id="lv-people">${rosterOptions}</datalist>`;
      gaps.forEach((g, i) => {
        html += `<div class="lv-gap"><div class="lv-gap-h"><b>${g.open ? 'Open role: ' + esc(g.roleTitle) : esc(g.resource)}</b> <span class="note-txt">on</span> <b>${esc(g.project)}</b> <span class="note-txt">· ${esc(g.roles.join(', '))} · ${g.totalNeedFteMo} FTE-mo missing</span></div>
          <div class="vmini">${g.segments.map(sg => `${esc(st.ymLabel(sg.start))}${sg.start !== sg.end ? ' → ' + esc(st.ymLabel(sg.end)) : ''} · contract ${sg.want}% · staffed ${sg.have}% · <b>+${sg.need}%</b>`).join(' &nbsp;|&nbsp; ')}</div>
          <div class="lv-gap-act"><input list="lv-people" data-gname="${i}" value="${g.open ? '' : esc(g.person ? g.person.name : g.resource)}" placeholder="${g.open ? 'Who takes this role?' : 'Change the name to map it onto someone else'}">
            <button class="btn btn-primary" data-gapply="${i}">Confirm — create ${g.segments.length} allocation${g.segments.length === 1 ? '' : 's'}</button>
            <input data-gwhy="${i}" placeholder="Why not? e.g. pursuit died"> <button class="btn btn-ghost" data-gdismiss="${i}">✕ Not staffing this</button></div></div>`;
      });
      html += `</details>`;
    }
    if (!rows.length) html += `<div class="empty">No allocations on your projects yet.${sc.matrixNames.size ? '' : ' Your projects have no matrix project linked — add an allocation and the project name links by itself, or confirm the link on Mapping.'}</div>`;
    else {
      html += `<table class="dt"><thead><tr><th>Client</th><th>Project</th><th>Person</th><th class="num" title="Total allocation across all projects this month">Load ${esc(st.ymLabel(now))}</th><th>Status</th><th>Window</th><th class="num">Alloc</th><th>Note</th><th></th></tr></thead><tbody>`;
      rows.forEach(a => {
        const person = st.getPerson(a.personId) || { name: a.personName || a.personId };
        const load = Math.round(st.personLoad(a.personId, now) || 0);
        html += `<tr><td>${esc(a.client || '—')}</td><td class="pname">${esc(a.project)}</td><td>${esc(person.name)}</td>
          <td class="num" style="color:${load > 100 ? 'var(--sav-red)' : 'inherit'}">${load}%</td>
          <td><span class="badge ${a.status === 'Pursuit' || a.type === 'Opportunity' ? 'pursuit' : 'active'}">${esc(a.status || '')}</span></td>
          <td>${esc(a.start ? st.ymLabel(a.start) : '—')} – ${esc(a.end ? st.ymLabel(a.end) : 'open')}</td><td class="num">${a.pct}%</td><td class="vmini">${esc(a.note || '')}</td>
          <td><span class="row-act"><button data-edit="${esc(a.id)}">Edit</button><button class="del" data-del="${esc(a.id)}">Del</button></span></td></tr>`;
      });
      html += `</tbody></table>`;
    }
    host.innerHTML = html;
    const add = $('#lv-add', host); if (add) add.onclick = () => H().openAllocModal(null, { project: sc.matrixNames.size === 1 ? [...sc.matrixNames][0] : (sc.fee.length === 1 ? nameOf(sc.fee[0]) : null), client: sc.fee.length === 1 ? clientOf(sc.fee[0]) : null });
    $$('[data-edit]', host).forEach(b => b.onclick = () => H().openAllocModal(b.dataset.edit));
    $$('[data-del]', host).forEach(b => b.onclick = () => { const a = st.listAllocations().find(x => x.id === b.dataset.del); if (!a || !sc.matrixNames.has(a.project)) return; if (confirm(`Remove ${(st.getPerson(a.personId) || {}).name || ''}'s allocation on ${a.project}?\n\nOnly the plan goes — logged Clockify hours stay.`)) { st.deleteAllocation(a.id); H().renderAll(); } });
    $$('[data-gapply]', host).forEach(b => b.onclick = () => {
      const g = gaps[+b.dataset.gapply]; if (!g) return;
      const inp = $(`[data-gname="${b.dataset.gapply}"]`, host); let typed = inp ? inp.value.trim() : '';
      if (!typed) { if (g.open) { toast('Type a name for this open role first.'); if (inp) inp.focus(); return; } typed = g.resource; }
      const hit = st.listPeople().find(p => st.namesMatch(p.name, typed));
      const personId = hit ? hit.id : st.personIdForName(typed); const personName = hit ? hit.name : typed;
      g.segments.forEach(sg => st.saveAllocation({ personId, personName, project: g.project, client: g.client, status: 'Active', type: 'Awarded', start: sg.start, end: sg.end, pct: sg.need,
        contractRole: g.open ? g.roleTitle : undefined, contractResource: g.open ? undefined : g.resource,
        note: (g.open ? 'Open contract role staffed' : (g.topUp ? `Contract top-up (matrix had ${sg.have}%, contract ${sg.want}%)` : 'From contract staffing')) + ' · ' + g.roles.join(', ') }));
      if (!g.open && g.resource) { const per = st.getPerson(personId); if (per && !st.namesMatch(per.name, g.resource)) st.setPersonAlias(g.resource, personId); }
      toast(`Created ${g.segments.length} allocation${g.segments.length === 1 ? '' : 's'} for ${personName}.`, 'ok'); H().renderAll();
    });
    $$('[data-gdismiss]', host).forEach(b => b.onclick = () => { const g = gaps[+b.dataset.gdismiss]; if (!g) return; const why = $(`[data-gwhy="${b.dataset.gdismiss}"]`, host); st.dismissGap(g.key, why ? why.value.trim() : ''); toast('Taken off the list — an admin can reopen it.'); H().renderAll(); });
  }

  /* ---------- Mapping: confirm · claim · flag ---------- */
  async function pullClockifyNames() {
    try {
      let headers = {}; try { const tok = window.UFC_Box && window.UFC_Box.getAccessToken ? await window.UFC_Box.getAccessToken() : null; if (tok) headers = { Authorization: 'Bearer ' + tok }; } catch (e) {}
      const res = await fetch('/api/clockify?list=projects', { headers });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      L.ckNames = S().parseCsvRows(await res.text()).map(o => o.Project || Object.values(o)[0] || '').filter(Boolean);
    } catch (e) { L.ckNames = []; L.ckError = e.message || String(e); }
  }
  function renderMapping(sc, host) {
    const st = S();
    if (L.ckNames === null) { host.innerHTML = '<div class="empty">Checking the Clockify project list…</div>'; pullClockifyNames().then(() => renderMapping(sc, host)); return; }
    const maps = st.getMappings(); const flags = st.mappingFlags();
    const unclaimed = st.unclaimedClockifyProjects(L.ckNames);
    const ckByMatrix = {};
    Object.entries(maps.projects || {}).forEach(([ck, mp]) => { if (mp && mp !== '__ignore__') (ckByMatrix[mp] = ckByMatrix[mp] || []).push({ ck, via: 'mapped' }); });
    const actualNames = new Set(Object.keys(st.readDb().actuals || {}).map(k => k.split('|')[1]));
    [...actualNames, ...L.ckNames].forEach(raw => { const k = String(raw).toLowerCase().replace(/\s+/g, ' ').trim(); if ((maps.projects || {})[k]) return; const r = st.resolveClockifyProject(raw); if (r && r.name && !(ckByMatrix[r.name] || []).some(x => x.ck === raw)) (ckByMatrix[r.name] = ckByMatrix[r.name] || []).push({ ck: raw, via: r.via }); });
    let html = `<div class="lv-head"><div><div class="eyebrow">Your projects</div><h2>Mapping — which Clockify project feeds each of yours</h2>
        <p>Hours only land on your project when its Clockify project is mapped to it. <b>Confirm</b> a link that was matched by name, <b>claim</b> a Clockify project nothing has claimed, or <b>flag</b> one that is wrong and belongs to someone else — an admin resolves flags.</p></div></div>
      ${L.ckError ? `<div class="note-txt lv-note">Could not pull the live Clockify list (${esc(L.ckError)}) — the names below come from hours already imported.</div>` : ''}
      <datalist id="lv-unclaimed">${unclaimed.map(n => `<option value="${esc(n)}">`).join('')}</datalist>`;
    if (!sc.fee.length) { host.innerHTML = html + '<div class="empty">No projects list you as revenue leader.</div>'; return; }
    html += `<table class="dt lv-map"><thead><tr><th style="width:26%">Your project</th><th style="width:30%">Matrix project · fee link</th><th>Clockify project(s) landing there</th><th style="width:22%">Claim · flag</th></tr></thead><tbody>`;
    sc.fee.forEach(p => {
      const names = sc.matrixByFee[p.id] || [];
      const client = clientOf(p);
      const linkCell = names.length ? names.map(mp => { const via = (st.matchFeeProjects(mp, client).find(l => l.id === p.id) || {}).via || 'name'; const confirmed = via === 'mapped';
          return `<div class="lv-link"><span class="badge ${confirmed ? 'active' : 'pursuit'}" title="${confirmed ? 'confirmed link' : 'matched by ' + esc(via) + ' — not confirmed'}">${esc(mp)}</span> ${confirmed ? '<span class="vmini">✓ confirmed</span>' : `<button class="btn sm" data-confirm="${esc(mp)}" data-fee="${esc(p.id)}">Confirm</button>`}</div>`; }).join('')
        : '<span class="no-link" style="margin:0">no matrix project linked</span>';
      const cks = names.flatMap(mp => ckByMatrix[mp] || []);
      const ckCell = cks.length ? cks.map(c => `<span class="badge ${c.via === 'mapped' || c.via === 'name' ? 'active' : 'pursuit'}" title="${esc(c.via)}">${esc(c.ck)}</span>`).join(' ') : '<span class="no-link" style="margin:0">nothing lands here</span>';
      const sugg = unclaimed.filter(n => STORE().tokenScore(n, nameOf(p)) >= 0.5).slice(0, 3);
      const flag = flags[p.id];
      const actCell = `<input list="lv-unclaimed" data-claim="${esc(p.id)}" placeholder="Claim an unclaimed Clockify project…" title="Only Clockify projects no fee project has claimed appear here">
        ${sugg.length ? `<div class="vmini" style="margin-top:4px">Looks like yours: ${sugg.map(n => `<a href="#" data-claimname="${esc(n)}" data-claim-fee="${esc(p.id)}">${esc(n)}</a>`).join(' · ')}</div>` : ''}
        ${flag ? `<div class="lv-flag">⚑ flagged ${esc(new Date(flag.at).toLocaleDateString())}${flag.note ? ' — “' + esc(flag.note) + '”' : ''} · waiting on admin</div>` : `<div style="margin-top:6px;display:flex;gap:4px"><input data-flagnote="${esc(p.id)}" placeholder="What is wrong?"><button class="btn sm ghost" data-flag="${esc(p.id)}">⚑ Flag</button></div>`}`;
      html += `<tr><td class="pname">${esc(nameOf(p))}<div class="vmini">${esc(client)} · ${esc(statusLabel(p))}</div></td><td>${linkCell}</td><td>${ckCell}</td><td>${actCell}</td></tr>`;
    });
    html += `</tbody></table>`;
    host.innerHTML = html;
    $$('[data-confirm]', host).forEach(b => b.onclick = () => { st.setFeeMapping(b.dataset.confirm, b.dataset.fee); toast('Link confirmed — it is pinned for everyone now.', 'ok'); H().renderAll(); });
    const claim = (name, feeId) => { try { const mp = st.claimClockifyForFee(name, feeId); toast(`Claimed — “${name}” now lands on ${mp}. Hours already imported moved with it.`, 'ok'); H().renderAll(); } catch (e) { toast(e.message || String(e)); } };
    $$('[data-claim]', host).forEach(inp => inp.onchange = () => { const v = inp.value.trim(); if (!v) return; const hit = unclaimed.find(n => n.toLowerCase() === v.toLowerCase()) || (unclaimed.filter(n => n.toLowerCase().includes(v.toLowerCase())).length === 1 ? unclaimed.find(n => n.toLowerCase().includes(v.toLowerCase())) : null); if (!hit) { inp.style.borderColor = '#C0392B'; inp.title = 'Pick from the list — only unclaimed Clockify projects can be taken here; flag anything else.'; return; } claim(hit, inp.dataset.claim); });
    $$('[data-claimname]', host).forEach(a => a.onclick = (e) => { e.preventDefault(); claim(a.dataset.claimname, a.dataset.claimFee); });
    $$('[data-flag]', host).forEach(b => b.onclick = () => { const note = ($(`[data-flagnote="${b.dataset.flag}"]`, host) || {}).value || ''; const p = sc.fee.find(x => x.id === b.dataset.flag); st.flagMapping(b.dataset.flag, note, p ? nameOf(p) : ''); toast('Flagged for an admin — it shows at the top of their Mapping tab.', 'ok'); H().renderAll(); });
  }

  /* ---------- shell ---------- */
  function render(tab, user) {
    const sc = scope(user);
    L.tab = tab || L.tab;
    const host = $('#p-lead-' + L.tab); if (!host) return;
    if (L.tab === 'time') renderTime(sc, host); else if (L.tab === 'allocs') renderAllocs(sc, host); else renderMapping(sc, host);
    return sc;
  }
  window.UFC_StaffLeader = { scope, render, timeRows, allowedProject, exportExcel, state: L };
})();
