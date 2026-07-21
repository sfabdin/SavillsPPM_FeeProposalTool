/* ============================================================
   SAVILLS PPM · STAFFING & BANDWIDTH — page controller
   ------------------------------------------------------------
   Renders four views over the staffing store (window.UFC_Staff):
     • Bandwidth  — per-person point-in-time load heatmap (over/under).
     • Allocations— the editable matrix (add / edit / delete rows).
     • By Project — headcount + FTE roll-up, linked to fee-tool projects.
     • Actuals vs Expected — planned hours (alloc% × capacity) against
       ACTUAL hours from a Clockify SUMMARY export (user×project×month),
       dropped in manually today or auto-pulled from a Box file later.
       No live Clockify API — the file is pre-aggregated so it stays small.
   ============================================================ */
(function () {
  'use strict';
  const S = window.UFC_Staff;
  const STORE = window.UFC_Store;

  /* ============================================================
     ACCESS WALL — this tool is allowlist-only (fail-CLOSED).
     Bandwidth, pursuit staffing and utilization are leadership-
     sensitive; only these Box logins may load the page. Match is
     case-insensitive on the signed-in (or impersonated) identity —
     an unrecognized/blank login sees the denial panel, never data.
     ============================================================ */
  const STAFF_ADMINS = new Set([
    'sabdin@savills.us',     // Salim Abdin — owner
    'salim@savills.us',      // Salim — legacy login
    'mglatt@savills.us',     // Michael Glatt
    'jsantoro@savills.us',   // Jeff Santoro
    'esobel@savills.us',     // Emily Sobel
    'eglatt@savills.us',     // Emily Glatt
    'kyriacos.yerou@savills.com', // developer (note .com)
  ]);
  function staffAccessOk() {
    const u = STORE.getCurrentUser();
    return !!(u && u.username) && STAFF_ADMINS.has(String(u.username).trim().toLowerCase());
  }
  function renderDenied() {
    const u = STORE.getCurrentUser();
    document.querySelector('.wrap').innerHTML = `
      <header class="head">
        <img class="logo" src="design-system/assets/savills_logo.png" alt="Savills">
        <div class="title-block"><h1>Staffing &amp; Bandwidth</h1><p class="tagline">Restricted tool.</p></div>
      </header>
      <div class="empty" style="padding:70px 40px">
        <div style="font-family:var(--font-display);font-weight:800;font-size:20px;color:var(--sav-navy);margin-bottom:10px">This tool is limited to staffing leadership.</div>
        <div style="max-width:460px;margin:0 auto;line-height:1.6">You're signed in as <strong>${(u && u.username) ? String(u.username).replace(/[&<>"]/g,'') : '(no identity)'}</strong>, which isn't on the access list. If you need bandwidth or allocation information, contact Salim Abdin.</div>
        <div style="margin-top:22px"><a href="Fee Generator.html" class="btn btn-secondary" style="text-decoration:none">← Back to the Fee System</a></div>
      </div>`;
  }

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtH = (n) => n ? (Math.round(n * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—';
  const fmtPct = (n) => n ? Math.round(n) + '%' : '';

  const state = {
    tab: 'bandwidth',
    winStart: null, winLen: 12, incPursuit: true,
    allocSearch: '', allocStatus: '', allocProject: '',
    projSearch: '',
    varProject: '',
    expandedPeople: new Set(), expandedProjects: new Set(),
    clockifyReport: null,
    editingAlloc: null,
  };

  function months() { const out = []; let c = state.winStart; for (let i = 0; i < state.winLen; i++) { out.push(c); c = S.ymAdd(c, 1); } return out; }
  function uCls(v) { if (!v) return 'u0'; if (v <= 85) return 'u1'; if (v <= 100) return 'u2'; if (v <= 120) return 'u3'; if (v <= 150) return 'u4'; return 'u5'; }

  /* ---------- identity bar (shared pattern) ---------- */
  function buildIdentityBar() {
    const sel = $('#id-user'); const label = document.querySelector('.identity-bar .id-label');
    const cur = STORE.getCurrentUser();
    if (!STORE.canImpersonate()) {
      if (sel) sel.style.display = 'none';
      if (label) label.textContent = 'Signed in as';
      let nameEl = document.getElementById('id-static-name');
      if (!nameEl && sel) { nameEl = document.createElement('span'); nameEl.id = 'id-static-name'; nameEl.style.cssText = 'font-family:var(--font-display);font-weight:700;font-size:13px;color:#fff;margin:0 4px;'; sel.parentNode.insertBefore(nameEl, sel.nextSibling); }
      if (nameEl) nameEl.textContent = cur.name || '(unrecognized)';
    } else {
      if (label) label.textContent = 'Viewing as'; if (sel) sel.style.display = '';
      const roster = STORE.impersonationRoster(); const imp = STORE.getImpersonation();
      sel.innerHTML = ['<option value="__me__">Me — admin · all</option>'].concat(roster.map(r => `<option value="${esc(r.username)}">${esc(r.name)} · ${r.role}</option>`)).join('');
      sel.value = imp ? esc(imp) : '__me__'; if (sel.selectedIndex < 0) sel.value = '__me__';
      sel.onchange = () => { const v = sel.value; if (v === '__me__') STORE.clearImpersonation(); else STORE.setImpersonation(v); if (!staffAccessOk()) { renderDenied(); return; } renderAll(); };
    }
    const roleEl = $('#id-role'), noteEl = $('#id-note');
    if (roleEl) { if (cur.role === 'admin') { roleEl.textContent = 'Admin · all teams'; roleEl.className = 'id-role admin'; } else { roleEl.textContent = 'Member'; roleEl.className = 'id-role member'; } }
    if (noteEl) noteEl.textContent = cur.impersonating ? 'Previewing ' + (cur.name || 'this person') : '';
  }

  /* ---------- BANDWIDTH ---------- */
  function renderBandwidth() {
    const ms = months();
    const rows = S.bandwidthGrid(ms, { includePursuit: state.incPursuit }).filter(r => r.activeMonths > 0);
    rows.sort((a, b) => b.peak - a.peak || a.person.name.localeCompare(b.person.name));
    const over = rows.filter(r => r.peak > 100).length;
    const nh = rows.filter(r => r.person.isNewHire).length;
    const avgLoad = rows.length ? rows.reduce((s, r) => s + r.avg, 0) / rows.length : 0;

    const kpis = `<div class="kpi-strip">
      <div class="kpi-card"><div class="k-num">${rows.length}</div><div class="k-lbl">People allocated</div></div>
      <div class="kpi-card ${over ? 'warn' : ''}"><div class="k-num">${over}</div><div class="k-lbl">Over-allocated (peak &gt; 100%)</div></div>
      <div class="kpi-card accent"><div class="k-num">${Math.round(avgLoad)}%</div><div class="k-lbl">Avg load, active months</div></div>
      <div class="kpi-card"><div class="k-num">${nh}</div><div class="k-lbl">Planned new hires in view</div></div>
    </div>`;

    const nowYm = S.currentYM();
    let head = '<tr><th class="who">Person</th>' + ms.map(m => `<th${m < nowYm ? ' style="opacity:.6"' : ''}>${esc(S.ymLabel(m))}</th>`).join('') + '<th class="pk">Peak</th></tr>';
    let body = '';
    rows.forEach(r => {
      const meta = [r.person.isNewHire ? '<span class="nh-tag">New hire</span>' : '', r.person.capacityPct !== 100 ? `${r.person.capacityPct}% cap` : ''].filter(Boolean).join('');
      body += `<tr data-person="${esc(r.person.id)}"><td class="who"><div class="who-name" data-exp="${esc(r.person.id)}">${esc(r.person.name)}</div>${meta ? `<div class="who-meta">${meta}</div>` : ''}</td>`;
      ms.forEach(m => { const v = Math.round(r.byMonth[m] || 0); body += `<td><span class="cell ${uCls(v)} ${m < nowYm ? 'past' : ''}">${v ? v : '·'}</span></td>`; });
      body += `<td class="pk ${r.peak > 100 ? 'over' : ''}">${Math.round(r.peak)}%</td></tr>`;
      if (state.expandedPeople.has(r.person.id)) body += personDrawer(r.person, ms);
    });

    const legend = `<div class="legend">
      <span><span class="sw" style="background:#eef4f4"></span>≤85% headroom</span>
      <span><span class="sw" style="background:#cfe6e4"></span>86–100% full</span>
      <span><span class="sw" style="background:#fce7c2"></span>101–120% over</span>
      <span><span class="sw" style="background:#f6c9c2"></span>121–150%</span>
      <span><span class="sw" style="background:#e4453a"></span>&gt;150% critical</span>
      <span style="margin-left:auto">Click a name for their project breakdown.</span>
    </div>`;

    $('#p-bandwidth').innerHTML = kpis + `<div class="hm-wrap"><table class="hm"><thead>${head}</thead><tbody>${body}</tbody></table></div>` + legend;
    $$('#p-bandwidth .who-name').forEach(el => el.onclick = () => { const id = el.dataset.exp; if (state.expandedPeople.has(id)) state.expandedPeople.delete(id); else state.expandedPeople.add(id); renderBandwidth(); });
  }

  function personDrawer(person, ms) {
    const allocs = S.listAllocations().filter(a => a.personId === person.id && (state.incPursuit || (a.status !== 'Pursuit' && a.type !== 'Opportunity')));
    // keep those active anywhere in-window
    const inWin = allocs.filter(a => ms.some(m => (a.start ? a.start <= m : false) && (a.end ? m <= a.end : true)));
    if (!inWin.length) return `<tr class="drawer-row"><td colspan="${ms.length + 2}"><div class="drawer"><em class="note-txt">No allocations in this window.</em></div></td></tr>`;
    let rows = '';
    inWin.forEach(a => {
      const cells = ms.map(m => { const on = (a.start ? a.start <= m : false) && (a.end ? m <= a.end : true); return `<td>${on ? a.pct + '%' : '·'}</td>`; }).join('');
      const stat = (a.status === 'Pursuit' || a.type === 'Opportunity') ? ' <span class="status-p">pursuit</span>' : '';
      rows += `<tr><td>${esc(a.project)}${stat}${a.note ? ` <span class="vmini" title="${esc(a.note)}">— ${esc(a.note.length > 40 ? a.note.slice(0, 40) + '…' : a.note)}</span>` : ''}</td>${cells}</tr>`;
    });
    return `<tr class="drawer-row"><td colspan="${ms.length + 2}"><div class="drawer"><h4>${esc(person.name)} · allocation detail</h4>
      <table class="mini"><thead><tr><th>Project</th>${ms.map(m => `<th>${esc(S.ymLabel(m))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></td></tr>`;
  }

  /* ---------- ALLOCATIONS ---------- */
  function renderAllocations() {
    let list = S.listAllocations();
    const q = state.allocSearch.toLowerCase();
    if (q) list = list.filter(a => (a.project + ' ' + a.client + ' ' + (S.getPerson(a.personId) || {}).name + ' ' + a.note).toLowerCase().includes(q));
    if (state.allocStatus) list = list.filter(a => a.status === state.allocStatus);
    if (state.allocProject) list = list.filter(a => a.project === state.allocProject);
    list.sort((a, b) => a.project.localeCompare(b.project) || ((S.getPerson(a.personId) || {}).name || '').localeCompare((S.getPerson(b.personId) || {}).name || ''));

    const projOpts = ['<option value="">All projects</option>'].concat(S.distinctProjects().map(p => `<option ${state.allocProject === p ? 'selected' : ''}>${esc(p)}</option>`)).join('');
    const toolbar = `<div class="toolbar">
      <input type="search" id="al-search" placeholder="Filter person, project, client, note…" value="${esc(state.allocSearch)}">
      <select id="al-status"><option value="">All statuses</option><option ${state.allocStatus === 'Active' ? 'selected' : ''}>Active</option><option ${state.allocStatus === 'Pursuit' ? 'selected' : ''}>Pursuit</option></select>
      <select id="al-project">${projOpts}</select>
      <span class="grow"></span>
      <button class="btn btn-primary" id="al-add">+ Add allocation</button>
    </div>`;

    let body = '';
    list.forEach(a => {
      const person = S.getPerson(a.personId) || { name: a.personId };
      const isP = a.status === 'Pursuit' || a.type === 'Opportunity';
      body += `<tr>
        <td class="pname">${esc(a.project)}</td>
        <td>${esc(a.client || '—')}</td>
        <td>${esc(person.name)}${person.isNewHire ? ' <span class="nh-tag">NH</span>' : ''}</td>
        <td><span class="badge ${isP ? 'pursuit' : 'active'}">${esc(a.status)}${a.type === 'Opportunity' ? ' · opp' : ''}</span></td>
        <td>${esc(a.start ? S.ymLabel(a.start) : '—')} – ${esc(a.end ? S.ymLabel(a.end) : '—')}</td>
        <td class="num">${a.pct}%</td>
        <td class="vmini">${esc(a.note || '')}</td>
        <td><span class="row-act"><button data-edit="${a.id}">Edit</button><button class="del" data-del="${a.id}">Del</button></span></td>
      </tr>`;
    });
    const table = list.length ? `<table class="dt"><thead><tr><th>Project</th><th>Client</th><th>Person</th><th>Status</th><th>Window</th><th class="num">Alloc</th><th>Note / decision</th><th></th></tr></thead><tbody>${body}</tbody></table>`
      : `<div class="empty">No allocations match. <a href="#" id="al-clear">Clear filters</a></div>`;
    $('#p-allocations').innerHTML = toolbar + table;

    $('#al-search').oninput = (e) => { state.allocSearch = e.target.value; renderAllocations(); const el = $('#al-search'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); };
    $('#al-status').onchange = (e) => { state.allocStatus = e.target.value; renderAllocations(); };
    $('#al-project').onchange = (e) => { state.allocProject = e.target.value; renderAllocations(); };
    $('#al-add').onclick = () => openAllocModal(null);
    const clr = $('#al-clear'); if (clr) clr.onclick = (e) => { e.preventDefault(); state.allocSearch = state.allocStatus = state.allocProject = ''; renderAllocations(); };
    $$('#p-allocations [data-edit]').forEach(b => b.onclick = () => openAllocModal(b.dataset.edit));
    $$('#p-allocations [data-del]').forEach(b => b.onclick = () => { const a = S.listAllocations().find(x => x.id === b.dataset.del); if (a && confirm(`Delete ${(S.getPerson(a.personId) || {}).name} on ${a.project}?`)) { S.deleteAllocation(b.dataset.del); renderAll(); } });
  }

  /* ---------- BY PROJECT ---------- */
  function renderProjects() {
    const ms = months();
    let rows = S.projectRollup(ms, { includePursuit: state.incPursuit });
    const q = state.projSearch.toLowerCase();
    if (q) rows = rows.filter(r => (r.project + ' ' + r.client).toLowerCase().includes(q));
    const maxFte = Math.max(1, ...rows.map(r => r.peakFte));

    const toolbar = `<div class="toolbar"><input type="search" id="pj-search" placeholder="Filter project or client…" value="${esc(state.projSearch)}"><span class="grow"></span><span class="note-txt">${rows.length} projects · ${rows.filter(r => r.feeProject).length} linked to the fee tool</span></div>`;

    let body = '';
    rows.forEach(r => {
      const spark = `<span class="fte-spark">${ms.map(m => { const v = r.byMonth[m] || 0; const h = Math.max(1, Math.round(v / maxFte * 26)); return `<i style="height:${h}px" title="${S.ymLabel(m)}: ${v.toFixed(2)} FTE"></i>`; }).join('')}</span>`;
      const link = r.feeProject ? `<a class="link-fee" href="Universal Fee Calculator.html?id=${encodeURIComponent(r.feeProject.id)}" title="Open in fee tool">fee ↗</a>` : '<span class="no-link">not in fee tool</span>';
      body += `<tr>
        <td class="pname"><span class="expand-btn" data-exp="${esc(r.project)}">${state.expandedProjects.has(r.project) ? '▾' : '▸'}</span> ${esc(r.project)} ${link}</td>
        <td>${esc(r.client || '—')}</td>
        <td class="num">${r.headcount}</td>
        <td class="num">${r.peakFte.toFixed(2)}</td>
        <td>${spark}</td>
      </tr>`;
      if (state.expandedProjects.has(r.project)) {
        let pr = '';
        r.allocs.slice().sort((a, b) => b.pct - a.pct).forEach(a => {
          const person = S.getPerson(a.personId) || { name: a.personId };
          const isP = a.status === 'Pursuit' || a.type === 'Opportunity';
          pr += `<tr><td>${esc(person.name)}${person.isNewHire ? ' <span class="nh-tag">NH</span>' : ''}${isP ? ' <span class="status-p">pursuit</span>' : ''}</td><td style="text-align:right">${a.pct}%</td><td style="text-align:right">${esc(a.start ? S.ymLabel(a.start) : '—')} – ${esc(a.end ? S.ymLabel(a.end) : '—')}</td><td>${esc(a.note || '')}</td></tr>`;
        });
        body += `<tr class="drawer-row"><td colspan="5"><div class="drawer"><table class="mini"><thead><tr><th>Person</th><th>Alloc</th><th>Window</th><th>Note</th></tr></thead><tbody>${pr}</tbody></table></div></td></tr>`;
      }
    });
    const table = rows.length ? `<table class="dt"><thead><tr><th>Project</th><th>Client</th><th class="num">Headcount</th><th class="num">Peak FTE</th><th>FTE over window</th></tr></thead><tbody>${body}</tbody></table>` : `<div class="empty">No projects match.</div>`;
    $('#p-projects').innerHTML = toolbar + table;
    $('#pj-search').oninput = (e) => { state.projSearch = e.target.value; renderProjects(); const el = $('#pj-search'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); };
    $$('#p-projects [data-exp]').forEach(b => b.onclick = () => { const p = b.dataset.exp; if (state.expandedProjects.has(p)) state.expandedProjects.delete(p); else state.expandedProjects.add(p); renderProjects(); });
  }

  /* ---------- ACTUALS vs EXPECTED ---------- */
  function renderActuals() {
    const has = S.hasActuals();
    const meta = S.actualsMeta();
    let html = importCard(has, meta);

    if (state.clockifyReport) html += reportBlock(state.clockifyReport);

    if (has) {
      const ms = months();
      const projFilter = state.varProject;
      let rows = S.varianceMatrix(ms, { project: projFilter || undefined });
      // group by project
      const byProj = {};
      rows.forEach(r => { (byProj[r.project] = byProj[r.project] || []).push(r); });
      const projNames = Object.keys(byProj).sort();
      const totExp = rows.reduce((s, r) => s + r.expected, 0), totAct = rows.reduce((s, r) => s + r.actual, 0);

      const projOpts = ['<option value="">All projects</option>'].concat(S.distinctProjects().map(p => `<option ${projFilter === p ? 'selected' : ''}>${esc(p)}</option>`)).join('');
      html += `<div class="kpi-strip" style="grid-template-columns:repeat(3,1fr)">
        <div class="kpi-card accent"><div class="k-num">${fmtH(totExp)}</div><div class="k-lbl">Expected hrs (planned) · window</div></div>
        <div class="kpi-card"><div class="k-num">${fmtH(totAct)}</div><div class="k-lbl">Actual hrs logged</div></div>
        <div class="kpi-card ${Math.abs(totAct - totExp) > totExp * 0.1 ? 'warn' : ''}"><div class="k-num">${totAct >= totExp ? '+' : ''}${fmtH(totAct - totExp)}</div><div class="k-lbl">Variance (actual − expected)</div></div>
      </div>`;
      html += `<div class="toolbar"><select id="var-project">${projOpts}</select><span class="grow"></span><span class="note-txt">Expected = capacity (${S.monthHours()} hrs/mo × cap%) × allocation%. Over-run in <span class="var-over">red</span>, under-run in <span class="var-under">amber</span>.</span></div>`;

      if (!projNames.length) html += `<div class="empty">No matched allocations or actuals in this window.</div>`;
      projNames.forEach(pn => {
        const list = byProj[pn].sort((a, b) => b.actual - a.actual);
        const pe = list.reduce((s, r) => s + r.expected, 0), pa = list.reduce((s, r) => s + r.actual, 0);
        let b = '';
        list.forEach(r => {
          const vcls = varCls(r.expected, r.actual);
          b += `<tr><td class="pname" style="font-weight:600">${esc(r.person.name)}</td><td class="num">${fmtH(r.expected)}</td><td class="num">${fmtH(r.actual)}</td><td class="num ${vcls}">${r.variance >= 0 ? '+' : ''}${fmtH(r.variance)}</td><td class="num vmini">${r.expected ? Math.round(r.actual / r.expected * 100) + '%' : '—'}</td></tr>`;
        });
        const pcls = varCls(pe, pa);
        const plan = S.feePlanHours(pn, ms);
        const planChip = plan ? ` · <span title="Planned hours in the fee tool for this window — the baseline the matrix converges to once the proposal is fully staffed">fee-tool plan <b style="color:var(--sav-teal)">${fmtH(plan.total)}</b></span>` : '';
        html += `<div style="background:#fff;border:1px solid rgba(37,39,58,0.12);margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;padding:11px 16px;border-bottom:1px solid rgba(37,39,58,0.1)">
            <div class="pname" style="font-size:14px">${esc(pn)} <span class="note-txt">· ${esc(list[0].client || '')}</span></div>
            <div class="note-txt">exp <b style="color:var(--sav-navy)">${fmtH(pe)}</b> · act <b style="color:var(--sav-navy)">${fmtH(pa)}</b> · <span class="${pcls}">${pa >= pe ? '+' : ''}${fmtH(pa - pe)}</span>${planChip}</div>
          </div>
          <table class="dt"><thead><tr><th>Person</th><th class="num">Expected hrs</th><th class="num">Actual hrs</th><th class="num">Variance</th><th class="num">% of plan</th></tr></thead><tbody>${b}</tbody></table>
        </div>`;
      });
      const vp = $('#var-project'); if (vp) vp.onchange = (e) => { state.varProject = e.target.value; renderActuals(); };
    }
    $('#p-actuals').innerHTML = html;
    wireImport();
    if (has) { const vp = $('#var-project'); if (vp) vp.onchange = (e) => { state.varProject = e.target.value; renderActuals(); }; }
  }

  function varCls(exp, act) { if (!exp && !act) return ''; if (!exp) return 'var-over'; const r = act / exp; if (r > 1.1) return 'var-over'; if (r < 0.85) return 'var-under'; return 'var-ok'; }

  function importCard(has, meta) {
    const metaLine = has ? `<div class="meta-line">Loaded <b>${meta.rows}</b> actual rows across <b>${(meta.months || []).length}</b> month(s)${meta.importedAt ? ` · last import ${new Date(meta.importedAt).toLocaleString()}` : ''}. <a href="#" id="clear-actuals">Clear actuals</a></div>` : '';
    return `<div class="import-card">
      <h3>${has ? 'Update actual hours' : 'Load actual hours (Clockify)'}</h3>
      <p>Three ways in — all the same small, pre-aggregated file (hours by <em>user × project × month</em>), never raw time entries or a live API crawl: <strong>① drop a CSV</strong> exported from Clockify by hand, <strong>② pull via API</strong> (a serverless proxy asks Clockify's Reports API for the aggregated summary — one request), or <strong>③ pull the file from Box</strong> (a scheduled job writes <code>clockify-actuals.csv</code> there). Users match by name, projects by name — anything unmatched is listed so you can fix it at source. Clockify project names that carry a <strong>Salesforce ID</strong> match through it automatically — the most reliable join, immune to renames.</p>
      ${metaLine}
      <div class="drop" id="drop"><div class="big">Drop Clockify CSV here, or click to choose</div><div class="sm">Detailed report → group by User, or Summary report by User + Project. Needs a duration column and (ideally) a date.</div></div>
      <div class="imp-actions" style="margin-top:12px">
        <button class="btn btn-secondary" id="pull-api">⟳ Pull from Clockify (API)</button>
        <button class="btn btn-ghost" id="pull-box">Pull file from Box</button>
        <span class="note-txt" id="pull-note">API pull uses the aggregated summary report for the current window — one small request, never raw entries.</span>
      </div>
    </div>`;
  }

  function reportBlock(rep) {
    if (rep.error) return `<div class="import-card" style="border-color:#e0b4ae"><p style="color:#8f2418;margin:0"><strong>Couldn't read that file.</strong> ${esc(rep.error)}</p></div>`;
    const uu = rep.unmatchedUsers, up = rep.unmatchedProjects;
    const umUsers = `<div class="um ${uu.length ? '' : 'empty-ok'}"><h5>${uu.length ? uu.length + ' unmatched people' : 'All people matched ✓'}</h5>${uu.length ? `<ul>${uu.slice(0, 30).map(u => `<li>${esc(u.name || '(blank)')}<span>${fmtH(u.hours)} h</span></li>`).join('')}</ul>` : '<div class="note-txt">Every Clockify user maps to a roster name.</div>'}</div>`;
    const umProj = `<div class="um ${up.length ? '' : 'empty-ok'}"><h5>${up.length ? up.length + ' unmatched projects' : 'All projects matched ✓'}</h5>${up.length ? `<ul>${up.slice(0, 30).map(u => `<li>${esc(u.name || '(blank)')}<span>${fmtH(u.hours)} h</span></li>`).join('')}</ul>` : '<div class="note-txt">Every Clockify project maps to the matrix.</div>'}</div>`;
    return `<div class="import-card">
      <div class="report" style="border-top:0;padding-top:0">
        <div class="rrow">
          <div class="rstat"><b>${fmtH(rep.totalHours)}</b><span>Total hours</span></div>
          <div class="rstat"><b>${rep.rowCount.toLocaleString()}</b><span>Source rows</span></div>
          <div class="rstat"><b>${(rep.months || []).length}</b><span>Months</span></div>
          ${rep.sfHits ? `<div class="rstat"><b>${rep.sfHits.toLocaleString()}</b><span>Matched via Salesforce ID</span></div>` : ''}
          <div class="rstat"><b>${rep.months && rep.months.length ? esc(S.ymLabel(rep.months[0]) + ' – ' + S.ymLabel(rep.months[rep.months.length - 1])) : '—'}</b><span>Period</span></div>
        </div>
        <div class="unmatched">${umUsers}${umProj}</div>
        <div class="imp-actions">
          <button class="btn btn-primary" id="commit-merge">Commit — replace these months</button>
          <button class="btn btn-ghost" id="commit-add">Add to existing</button>
          <button class="btn btn-ghost" id="commit-cancel">Cancel</button>
          <span class="note-txt">Unmatched people are skipped (they carry no capacity). Fix names in Clockify or add them to the roster, then re-import.</span>
        </div>
      </div>
    </div>`;
  }

  function wireImport() {
    const drop = $('#drop'), fileInput = $('#clockify-file');
    if (drop) {
      drop.onclick = () => fileInput.click();
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = () => drop.classList.remove('over');
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) readClockify(e.dataTransfer.files[0]); };
    }
    if (fileInput) fileInput.onchange = () => { if (fileInput.files[0]) readClockify(fileInput.files[0]); fileInput.value = ''; };
    const ca = $('#clear-actuals'); if (ca) ca.onclick = (e) => { e.preventDefault(); if (confirm('Clear all imported actual hours?')) { S.clearActuals(); state.clockifyReport = null; renderActuals(); } };
    const cm = $('#commit-merge'); if (cm) cm.onclick = () => { const r = S.commitClockify(state.clockifyReport, 'replace'); state.clockifyReport = null; renderActuals(); toast(`Imported ${r.written} rows${r.skipped ? ` · ${r.skipped} skipped (unmatched)` : ''}.`); };
    const cadd = $('#commit-add'); if (cadd) cadd.onclick = () => { const r = S.commitClockify(state.clockifyReport, 'merge'); state.clockifyReport = null; renderActuals(); toast(`Added ${r.written} rows${r.skipped ? ` · ${r.skipped} skipped` : ''}.`); };
    const cc = $('#commit-cancel'); if (cc) cc.onclick = () => { state.clockifyReport = null; renderActuals(); };
    const note = $('#pull-note');
    const setNote = (msg, bad) => { if (note) { note.textContent = msg; note.style.color = bad ? '#8f2418' : ''; } };
    const pa = $('#pull-api');
    if (pa) pa.onclick = async () => {
      const ms = months();
      const start = ms[0] + '-01';
      const [ey, em] = ms[ms.length - 1].split('-').map(Number);
      const end = ey + '-' + String(em).padStart(2, '0') + '-' + new Date(Date.UTC(ey, em, 0)).getUTCDate();
      setNote('Pulling summary report…'); pa.disabled = true;
      try {
        const res = await fetch('/api/clockify?start=' + start + '&end=' + end);
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.detail || j.error || ('HTTP ' + res.status)); }
        state.clockifyReport = S.analyzeClockify(await res.text(), ms[0]);
        renderActuals();
      } catch (e) { setNote('Clockify pull failed: ' + e.message + (String(e.message).includes('configured') || String(e.message).includes('501') ? ' — set CLOCKIFY_API_KEY + CLOCKIFY_WORKSPACE_ID in Vercel.' : ''), true); pa.disabled = false; }
    };
    const pb = $('#pull-box');
    if (pb) pb.onclick = async () => {
      setNote('Pulling clockify-actuals.csv from Box…'); pb.disabled = true;
      try {
        if (!window.UFC_Box || !window.UFC_Box.pullActuals) throw new Error('Box layer not loaded');
        state.clockifyReport = S.analyzeClockify(await window.UFC_Box.pullActuals(), months()[0]);
        renderActuals();
      } catch (e) { setNote('Box pull failed: ' + e.message, true); pb.disabled = false; }
    };
  }

  function readClockify(file) {
    const rd = new FileReader();
    rd.onload = () => {
      const defMonth = months()[0];
      state.clockifyReport = S.analyzeClockify(String(rd.result), defMonth);
      renderActuals();
    };
    rd.readAsText(file);
  }

  function toast(msg) {
    let t = document.getElementById('toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--sav-navy);color:#fff;padding:12px 20px;font-family:var(--font-display);font-weight:700;font-size:13px;z-index:300;box-shadow:0 6px 24px rgba(0,0,0,.25)'; document.body.appendChild(t); }
    t.textContent = msg; t.style.opacity = '1'; clearTimeout(t._h); t._h = setTimeout(() => { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; }, 2600);
  }

  /* ---------- allocation modal ---------- */
  function openAllocModal(id) {
    const a = id ? S.listAllocations().find(x => x.id === id) : null;
    state.editingAlloc = a ? a.id : null;
    $('#am-title').textContent = a ? 'Edit allocation' : 'Add allocation';
    $('#am-people').innerHTML = S.listPeople().map(p => `<option value="${esc(p.name)}">`).join('');
    $('#am-projects').innerHTML = S.distinctProjects().map(p => `<option value="${esc(p)}">`).join('');
    $('#am-clients').innerHTML = S.distinctClients().map(c => `<option value="${esc(c)}">`).join('');
    const person = a ? (S.getPerson(a.personId) || {}) : {};
    $('#am-person').value = a ? (person.name || '') : '';
    $('#am-project').value = a ? a.project : '';
    $('#am-client').value = a ? a.client : '';
    $('#am-status').value = a ? a.status : 'Active';
    $('#am-type').value = a ? a.type : 'Awarded';
    $('#am-start').value = a && a.start ? a.start : months()[0];
    $('#am-end').value = a && a.end ? a.end : S.ymAdd(months()[0], 11);
    $('#am-pct').value = a ? a.pct : 25;
    $('#am-note').value = a ? (a.note || '') : '';
    $('#alloc-modal').classList.add('open');
  }
  function closeAllocModal() { $('#alloc-modal').classList.remove('open'); state.editingAlloc = null; }
  function saveAllocModal() {
    const name = $('#am-person').value.trim();
    const project = $('#am-project').value.trim();
    if (!name || !project) { alert('Person and project are required.'); return; }
    const rec = {
      id: state.editingAlloc || undefined,
      personId: S.personIdForName(name), personName: name,
      project, client: $('#am-client').value.trim(),
      status: $('#am-status').value, type: $('#am-type').value,
      start: $('#am-start').value || null, end: $('#am-end').value || null,
      pct: +$('#am-pct').value || 0, note: $('#am-note').value.trim(),
    };
    S.saveAllocation(rec); closeAllocModal(); renderAll();
    toast(state.editingAlloc ? 'Allocation updated.' : 'Allocation added.');
  }

  /* ---------- shell ---------- */
  function renderCounts() {
    $('#cnt-alloc').textContent = '(' + S.listAllocations().length + ')';
    $('#cnt-proj').textContent = '(' + S.distinctProjects().length + ')';
  }
  function renderActive() {
    if (state.tab === 'bandwidth') renderBandwidth();
    else if (state.tab === 'allocations') renderAllocations();
    else if (state.tab === 'projects') renderProjects();
    else if (state.tab === 'actuals') renderActuals();
  }
  function renderAll() { buildIdentityBar(); renderCounts(); renderActive(); }

  function buildWindowOptions() {
    const sel = $('#win-start'); const now = new Date();
    const startY = now.getUTCFullYear() - 1;
    let opts = '';
    for (let y = startY; y <= startY + 3; y++) for (let m = 1; m <= 12; m++) { const ym = y + '-' + String(m).padStart(2, '0'); opts += `<option value="${ym}">${S.ymLabel(ym)}</option>`; }
    sel.innerHTML = opts;
    const def = now.getUTCFullYear() + '-01';
    state.winStart = def; sel.value = def;
  }

  function init() {
    if (!staffAccessOk()) { renderDenied(); return; }
    buildWindowOptions();
    $('#month-hrs').value = S.monthHours();
    $('#win-start').onchange = (e) => { state.winStart = e.target.value; renderActive(); };
    $('#win-len').onchange = (e) => { state.winLen = +e.target.value; renderActive(); };
    $('#month-hrs').onchange = (e) => { S.setMonthHours(+e.target.value); renderActive(); };
    $('#inc-pursuit').onchange = (e) => { state.incPursuit = e.target.checked; renderActive(); };
    $$('#tabs .tab').forEach(t => t.onclick = () => { state.tab = t.dataset.tab; $$('#tabs .tab').forEach(x => x.classList.toggle('active', x === t)); $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'p-' + state.tab)); renderActive(); });
    $('#am-close').onclick = closeAllocModal; $('#am-cancel').onclick = closeAllocModal; $('#am-save').onclick = saveAllocModal;
    $('#alloc-modal').onclick = (e) => { if (e.target.id === 'alloc-modal') closeAllocModal(); };
    renderAll();
  }

  if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(init); else document.addEventListener('ufc:ready', init);
})();
