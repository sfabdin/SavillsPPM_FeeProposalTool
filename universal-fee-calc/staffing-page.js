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

  /* Auth header for our own /api/* endpoints — they validate the Box session. */
  async function apiHeaders() {
    try {
      const tok = window.UFC_Box && window.UFC_Box.getAccessToken ? await window.UFC_Box.getAccessToken() : null;
      return tok ? { Authorization: 'Bearer ' + tok } : {};
    } catch (e) { return {}; }
  }

  /* ============================================================
     ACCESS WALL — this tool is allowlist-only (fail-CLOSED).
     Bandwidth, pursuit staffing and utilization are leadership-
     sensitive; only these Box logins may load the page. Match is
     case-insensitive on the signed-in (or impersonated) identity —
     an unrecognized/blank login sees the denial panel, never data.
     ============================================================ */
  const STAFF_ADMINS = new Set([
    'sabdin@savills.us',     // Sarah Abdin — owner
    'salim@savills.us',      // Sarah — legacy login
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
    const canEsc = STORE.canImpersonate && STORE.canImpersonate();
    document.querySelector('.wrap').innerHTML = `
      <header class="head">
        <img class="logo" src="design-system/assets/savills_logo.png" alt="Savills">
        <div class="title-block"><h1>Staffing &amp; Bandwidth</h1><p class="tagline">Restricted tool.</p></div>
      </header>
      <div class="empty" style="padding:70px 40px">
        <div style="font-family:var(--font-display);font-weight:800;font-size:20px;color:var(--sav-navy);margin-bottom:10px">This tool is limited to staffing leadership.</div>
        <div style="max-width:460px;margin:0 auto;line-height:1.6">${canEsc ? 'You&rsquo;re previewing as' : 'You&rsquo;re signed in as'} <strong>${(u && u.username) ? String(u.username).replace(/[&<>"]/g,'') : '(no identity)'}</strong>, which isn't on the access list.${canEsc ? ' This is what they would see.' : ' If you need bandwidth or allocation information, contact Sarah Abdin.'}</div>
        <div style="margin-top:22px;display:flex;gap:10px;justify-content:center">
          ${canEsc ? '<button class="btn btn-primary" id="deny-back">← Back to my view</button>' : ''}
          <a href="Fee Generator.html" class="btn btn-secondary" style="text-decoration:none">Fee System home</a>
        </div>
      </div>`;
    const b = document.getElementById('deny-back');
    if (b) b.onclick = () => { STORE.clearImpersonation(); window.location.reload(); };
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
    projSearch: '', projClient: '',
    varProject: '', varPerson: '', varGroup: 'project', varUnit: 'hours',
    bwSearch: '', bwOver: false, bwProject: '',
    expandedPeople: new Set(), expandedProjects: new Set(),
    clockifyReport: null, clockifyRaw: null,
    editingAlloc: null,
    canonProposals: null,
    mapSearch: '', mapOnlyProblems: false, clockifyNames: null,
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
  /* Shared bandwidth filters (heatmap + single-month view). Project filter
     keeps people ON that project; their load still counts ALL their work. */
  function bwToolbar() {
    const projOpts = ['<option value="">All projects</option>'].concat(S.distinctProjects().map(p => `<option ${state.bwProject === p ? 'selected' : ''}>${esc(p)}</option>`)).join('');
    return `<div class="toolbar">
      <input type="search" id="bw-search" placeholder="Filter people…" value="${esc(state.bwSearch)}">
      <select id="bw-project" title="Show only people allocated to this project (their load still counts everything)">${projOpts}</select>
      <label class="chk" style="font-size:12.5px;display:inline-flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="bw-over" ${state.bwOver ? 'checked' : ''}> Only over-allocated</label>
      <span class="grow"></span>
    </div>`;
  }
  function bwFilter(rows, loadOf) {
    let out = rows;
    const q = state.bwSearch.toLowerCase();
    if (q) out = out.filter(r => r.person.name.toLowerCase().includes(q));
    if (state.bwOver) out = out.filter(r => loadOf(r) > 100);
    if (state.bwProject) {
      const ppl = new Set(S.listAllocations().filter(a => a.project === state.bwProject).map(a => a.personId));
      out = out.filter(r => ppl.has(r.person.id));
    }
    return out;
  }
  function wireBwToolbar(rerender) {
    const si = $('#bw-search'); if (si) si.oninput = (e) => { state.bwSearch = e.target.value; rerender(); const el = $('#bw-search'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); };
    const pj = $('#bw-project'); if (pj) pj.onchange = (e) => { state.bwProject = e.target.value; rerender(); };
    const ov = $('#bw-over'); if (ov) ov.onchange = (e) => { state.bwOver = e.target.checked; rerender(); };
  }

  function renderBandwidth() {
    const ms = months();
    if (ms.length === 1) { renderMonthFocus(ms[0]); return; }
    const rows = bwFilter(S.bandwidthGrid(ms, { includePursuit: state.incPursuit }).filter(r => r.activeMonths > 0), (r) => r.peak);
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

    $('#p-bandwidth').innerHTML = kpis + bwToolbar() + `<div class="hm-wrap"><table class="hm"><thead>${head}</thead><tbody>${body}</tbody></table></div>` + legend;
    wireBwToolbar(renderBandwidth);
    $$('#p-bandwidth .who-name').forEach(el => el.onclick = () => { const id = el.dataset.exp; if (state.expandedPeople.has(id)) state.expandedPeople.delete(id); else state.expandedPeople.add(id); renderBandwidth(); });
  }

  /* Single-month focus: everyone's load THIS month with their project mix,
     heaviest first — the "who can take work in July?" pivot. */
  function renderMonthFocus(ym) {
    const rows = bwFilter(S.bandwidthGrid([ym], { includePursuit: state.incPursuit }).filter(r => (r.byMonth[ym] || 0) > 0), (r) => r.byMonth[ym] || 0);
    rows.sort((a, b) => (b.byMonth[ym] || 0) - (a.byMonth[ym] || 0) || a.person.name.localeCompare(b.person.name));
    const over = rows.filter(r => r.byMonth[ym] > 100).length;
    const free = rows.filter(r => r.byMonth[ym] <= 85).length;
    const avg = rows.length ? rows.reduce((s, r) => s + r.byMonth[ym], 0) / rows.length : 0;
    const kpis = `<div class="kpi-strip">
      <div class="kpi-card"><div class="k-num">${rows.length}</div><div class="k-lbl">People staffed · ${esc(S.ymLabel(ym))}</div></div>
      <div class="kpi-card ${over ? 'warn' : ''}"><div class="k-num">${over}</div><div class="k-lbl">Over 100% this month</div></div>
      <div class="kpi-card accent"><div class="k-num">${free}</div><div class="k-lbl">With headroom (≤85%)</div></div>
      <div class="kpi-card"><div class="k-num">${Math.round(avg)}%</div><div class="k-lbl">Avg load</div></div>
    </div>`;
    const barCol = (v) => v > 150 ? '#e4453a' : v > 120 ? '#e08a7d' : v > 100 ? '#e8b563' : v > 85 ? '#5ba8a5' : '#a9cfcd';
    let body = '';
    rows.forEach(r => {
      const v = Math.round(r.byMonth[ym] || 0);
      const allocs = S.personAllocationsIn(r.person.id, ym).filter(a => state.incPursuit || (a.status !== 'Pursuit' && a.type !== 'Opportunity'));
      const chips = allocs.sort((a, b) => b.pct - a.pct).map(a => `<span class="mv-chip ${(a.status === 'Pursuit' || a.type === 'Opportunity') ? 'pursuit' : ''}" title="${esc(a.note || '')}"><b>${a.pct}%</b> ${esc(a.project)}</span>`).join('');
      const w = Math.min(100, v / 1.6);   // bar scaled to 160% full-width
      body += `<div class="mv-row">
        <div><div class="who-name" style="cursor:default">${esc(r.person.name)}</div>${r.person.isNewHire ? '<div class="who-meta"><span class="nh-tag">New hire</span></div>' : ''}</div>
        <div style="display:flex;align-items:center;gap:10px"><span class="mv-load" style="color:${v > 100 ? '#C0392B' : 'var(--sav-navy)'}">${v}%</span>
          <div class="mv-bar" style="flex:1"><i style="width:${w}%;background:${barCol(v)}"></i><span class="cap" style="left:${100 / 1.6}%"></span></div></div>
        <div class="mv-projs">${chips}</div>
      </div>`;
    });
    const legend = `<div class="legend"><span>Tick mark = 100% capacity. Chips show each project's share; amber chips are pursuits.</span><span style="margin-left:auto">◀ ▶ in the toolbar pivots month to month.</span></div>`;
    $('#p-bandwidth').innerHTML = kpis + bwToolbar() + `<div style="border:1px solid rgba(37,39,58,0.12)"><div class="mv-row" style="background:#faf9f7;border-top:0;font-family:var(--font-display);font-size:9.5px;letter-spacing:0.05em;text-transform:uppercase;color:var(--sav-steel)"><div>Person</div><div>Load · ${esc(S.ymLabel(ym))}</div><div>Projects this month</div></div>${body || '<div class="empty" style="border:0">Nobody staffed this month.</div>'}</div>` + legend;
    wireBwToolbar(() => renderMonthFocus(ym));
  }

  function personDrawer(person, ms) {
    const allocs = S.listAllocations().filter(a => a.personId === person.id && (state.incPursuit || (a.status !== 'Pursuit' && a.type !== 'Opportunity')));
    const inWin = allocs.filter(a => ms.some(m => (a.start ? a.start <= m : false) && (a.end ? m <= a.end : true)));
    if (!inWin.length) return `<tr class="drawer-tr"><td class="who dproj"><em class="note-txt">No allocations in this window.</em></td>${ms.map(() => '<td class="dcell">·</td>').join('')}<td class="dcell"></td></tr>`;
    const on = (a, m) => (a.start ? a.start <= m : false) && (a.end ? m <= a.end : true);
    let rows = '';
    inWin.forEach(a => {
      const stat = (a.status === 'Pursuit' || a.type === 'Opportunity') ? ' <span class="status-p">pursuit</span>' : '';
      const note = a.note ? ` <span class="vmini" title="${esc(a.note)}">— ${esc(a.note.length > 40 ? a.note.slice(0, 40) + '…' : a.note)}</span>` : '';
      rows += `<tr class="drawer-tr"><td class="who dproj">${esc(a.project)}${stat}${note}</td>${ms.map(m => `<td class="dcell">${on(a, m) ? a.pct + '%' : '·'}</td>`).join('')}<td class="dcell"></td></tr>`;
    });
    // total row — per-month load, same math as the heatmap cell above (Σ alloc% ÷ capacity)
    const cap = person.capacityPct || 100;
    const tot = ms.map(m => inWin.reduce((s, a) => s + (on(a, m) ? (+a.pct || 0) : 0), 0));
    const load = (t) => Math.round(t / cap * 100);
    rows += `<tr class="drawer-tr drawer-tot"><td class="who dproj">Total load${cap !== 100 ? ` <span class="vmini">Σ alloc ÷ ${cap}% capacity</span>` : ''}</td>${tot.map(t => `<td class="dcell">${t ? load(t) + '%' : '·'}</td>`).join('')}<td class="dcell">${Math.max(0, ...tot.map(load))}%</td></tr>`;
    return rows;
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
      <span class="note-txt" id="matrix-meta"></span>
      <button class="btn btn-ghost" id="canon-sync" title="Pull Clockify's project list and rename matrix projects to the canonical names — one-time mapping, remembered for future sheet imports">⇄ Sync names from Clockify</button>
      <button class="btn btn-ghost" id="matrix-reimport" title="Replace all allocations from a fresh export of the staffing sheet (Data tab or CSV). Actuals and roster edits are kept.">⇪ Re-import JS sheet</button>
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
    const mm = $('#matrix-meta');
    if (mm) { const meta = S.readDb().meta || {}; mm.textContent = meta.matrixImportedAt ? `Matrix: ${meta.matrixSource || 'seed v43'} · ${new Date(meta.matrixImportedAt).toLocaleDateString()}` : ''; }
    const mr = $('#matrix-reimport'); if (mr) mr.onclick = () => $('#matrix-file').click();
    const cs = $('#canon-sync'); if (cs) cs.onclick = startCanonSync;
    if (state.canonProposals) renderCanonReview();
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
    if (state.projClient) rows = rows.filter(r => r.client === state.projClient);
    const maxFte = Math.max(1, ...rows.map(r => r.peakFte));
    const feeOpts = S.listFeeProjects().map(p => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');

    const clientOpts = ['<option value="">All clients</option>'].concat(S.distinctClients().map(c => `<option ${state.projClient === c ? 'selected' : ''}>${esc(c)}</option>`)).join('');
    const toolbar = `<div class="toolbar"><input type="search" id="pj-search" placeholder="Filter project or client…" value="${esc(state.projSearch)}"><select id="pj-client">${clientOpts}</select><span class="grow"></span><span class="note-txt">${rows.length} projects · ${rows.filter(r => r.feeProject).length} linked to the fee tool</span></div>`;

    let body = '';
    rows.forEach(r => {
      const spark = `<span class="fte-spark">${ms.map(m => { const v = r.byMonth[m] || 0; const h = Math.max(1, Math.round(v / maxFte * 26)); return `<i style="height:${h}px" title="${S.ymLabel(m)}: ${v.toFixed(2)} FTE"></i>`; }).join('')}</span>`;
      const link = r.feeProject
        ? `<a class="link-fee" href="Universal Fee Calculator.html?id=${encodeURIComponent(r.feeProject.id)}" title="Open in fee tool · matched by ${esc(r.feeProject.via || 'name')}${r.feeProject.score ? ' (' + r.feeProject.score + '%)' : ''}">fee ${r.feeProject.via === 'tokens' ? '≈' : r.feeProject.via === 'mapped' ? '⚯' : ''}↗</a>${r.feeProject.via === 'tokens' ? `<button class="row-act-link" data-fee-confirm="${esc(r.project)}" data-fee-id="${esc(r.feeProject.id)}" title="Confirm this smart match — saves it permanently">✓</button>` : ''}`
        : `<select class="fee-link-sel" data-fee-link="${esc(r.project)}" title="Link this matrix project to a fee-tool project — saved once, shared"><option value="">link to fee…</option>${feeOpts}</select>`;
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
    const pjc = $('#pj-client'); if (pjc) pjc.onchange = (e) => { state.projClient = e.target.value; renderProjects(); };
    $$('#p-projects [data-exp]').forEach(b => b.onclick = () => { const p = b.dataset.exp; if (state.expandedProjects.has(p)) state.expandedProjects.delete(p); else state.expandedProjects.add(p); renderProjects(); });
    $$('#p-projects [data-fee-link]').forEach(sel => sel.onchange = () => { if (!sel.value) return; S.setFeeMapping(sel.dataset.feeLink, sel.value); toast('Linked — saved for everyone.'); renderProjects(); });
    $$('#p-projects [data-fee-confirm]').forEach(b => b.onclick = () => { S.setFeeMapping(b.dataset.feeConfirm, b.dataset.feeId); toast('Match confirmed — saved.'); renderProjects(); });
  }

  /* ---------- ACTUALS vs EXPECTED ---------- */
  function renderActuals() {
    const has = S.hasActuals();
    const meta = S.actualsMeta();
    let html = importCard(has, meta);

    if (state.clockifyReport) html += reportBlock(state.clockifyReport);

    const cat = window.RATES_CATALOG;
    const canDollars = !!(cat && cat.hydrated);
    const dollars = state.varUnit === 'dollars' && canDollars;
    const _fmtHours = fmtH;
    const fmtD = (n) => (n < 0 ? '−' : '') + '$' + Math.abs(Math.round(n)).toLocaleString();
    {
      const fmtH = dollars ? fmtD : _fmtHours;   // shadow: every figure below follows the unit toggle
      const noRate = new Set(); const _rateCache = {};
      const rateOf = (person) => {
        if (!person) return 0;
        if (_rateCache[person.id] != null) return _rateCache[person.id];
        const r = S.personCostRate(person) || 0;
        if (!r) noRate.add(person.name + (person.title ? ' — ' + person.title : ' — no title yet'));
        return (_rateCache[person.id] = r);
      };
      const cpM = (cp, m) => dollars ? ((cp.feeByMonth || {})[m] || 0) : (cp.byMonth[m] || 0);
      const cpTot = (cp) => dollars ? (cp.feeTotal || 0) : cp.total;
      const msAsc = months();
      const ms = msAsc;
      // Display order: chronological, Jan → Dec (matches the chart above)
      const msDesc = msAsc.slice();
      const showMonths = true;
      const projFilter = state.varProject;
      let rows = S.varianceMatrix(ms, { project: projFilter || undefined, person: state.varPerson || undefined });
      // Dollars mode: ①③ become hours × the person's internal COST rate (by title)
      if (dollars) rows = rows.map(r => { const k = rateOf(r.person); const bm = {}; ms.forEach(m => { const c = r.byMonth[m]; bm[m] = { e: c.e * k, a: c.a * k }; }); return { ...r, expected: r.expected * k, actual: r.actual * k, variance: r.variance * k, byMonth: bm }; });
      const byPerson = state.varGroup === 'person';
      // group by project or by person
      const byProj = {};
      rows.forEach(r => { const k = byPerson ? r.person.id : r.project; (byProj[k] = byProj[k] || []).push(r); });
      const projNames = Object.keys(byProj).sort((a, b) => byPerson ? (S.getPerson(a) || { name: a }).name.localeCompare((S.getPerson(b) || { name: b }).name) : a.localeCompare(b));
      const totExp = rows.reduce((s, r) => s + r.expected, 0), totAct = rows.reduce((s, r) => s + r.actual, 0);

      const projOpts = ['<option value="">All projects</option>'].concat(S.distinctProjects().map(p => `<option ${projFilter === p ? 'selected' : ''}>${esc(p)}</option>`)).join('');
      const pplOpts = ['<option value="">All people</option>'].concat(S.listPeople().map(p => `<option value="${esc(p.id)}" ${state.varPerson === p.id ? 'selected' : ''}>${esc(p.name)}</option>`)).join('');
      // Contract only applies when grouped by project (the contract has no names)
      let totContract = 0; const contractByProj = {};
      (byPerson ? [...new Set(rows.map(r => r.project))] : projNames).forEach(pn => { const cl = (rows.find(r => r.project === pn) || {}).client || ''; const cp = S.contractPlan(pn, ms, cl); if (cp) { contractByProj[pn] = cp; totContract += cpTot(cp); } });
      // monthly sums for the trend chart
      const planM = {}, actM = {}, conM = {};
      ms.forEach(m => { planM[m] = 0; actM[m] = 0; conM[m] = 0; });
      rows.forEach(r => ms.forEach(m => { const c = r.byMonth[m]; planM[m] += c.e; actM[m] += c.a; }));
      Object.values(contractByProj).forEach(cp => ms.forEach(m => { conM[m] += cpM(cp, m); }));
      html += dollars ? `<div class="kpi-strip">
        <div class="kpi-card accent"><div class="k-num">${fmtH(totExp)}</div><div class="k-lbl">① Planned cost (matrix × cost rate)</div></div>
        <div class="kpi-card"><div class="k-num">${fmtH(totContract)}</div><div class="k-lbl">② Contracted fee (fee tool · net)</div></div>
        <div class="kpi-card"><div class="k-num">${fmtH(totAct)}</div><div class="k-lbl">③ Actual cost (hours × cost rate)</div></div>
        <div class="kpi-card ${totContract - totAct < 0 ? 'warn' : ''}"><div class="k-num">${fmtH(totContract - totAct)}</div><div class="k-lbl">Margin · ② fee − ③ actual cost${totContract ? ' · ' + Math.round((totContract - totAct) / totContract * 100) + '%' : ''}</div></div>
      </div>${noRate.size ? `<div class="note-txt" style="margin:-8px 0 12px;color:#8a6d00">⚠ No cost rate for: ${esc([...noRate].join(' · '))} — their hours count as $0. Fix the title on the roster (Clockify carries it in on the next pull).</div>` : ''}` : `<div class="kpi-strip">
        <div class="kpi-card accent"><div class="k-num">${fmtH(totExp)}</div><div class="k-lbl">① Matrix plan (JS sheet) · hrs</div></div>
        <div class="kpi-card"><div class="k-num">${fmtH(totContract)}</div><div class="k-lbl">② Per contract (fee tool) · hrs</div></div>
        <div class="kpi-card"><div class="k-num">${fmtH(totAct)}</div><div class="k-lbl">③ Actual (Clockify) · hrs</div></div>
        <div class="kpi-card ${Math.abs(totAct - totExp) > totExp * 0.1 ? 'warn' : ''}"><div class="k-num">${totAct >= totExp ? '+' : ''}${fmtH(totAct - totExp)}</div><div class="k-lbl">Actual − matrix plan</div></div>
      </div>`;
      html += `<div class="toolbar">
        <select id="var-group" title="Group rows by project or by person"><option value="project" ${!byPerson ? 'selected' : ''}>Group: by project</option><option value="person" ${byPerson ? 'selected' : ''}>Group: by person</option></select>
        <select id="var-project">${projOpts}</select>
        <select id="var-person">${pplOpts}</select>
        ${canDollars ? `<select id="var-unit" title="Show hours or dollars"><option value="hours">Units: hours</option><option value="dollars" ${dollars ? 'selected' : ''}>Units: $ cost vs fee</option></select>` : ''}
        <span class="grow"></span><span class="note-txt">${dollars ? '① ③ = hours × internal COST rate for each person’s title (rates.json · titles from Clockify) · ② = contracted NET fee from the fee tool. Profitable = ③ below ②.' : `▲ over plan · ▼ under plan · ● on plan (±10%) — ① who we PLAN to staff (names) · ② what the CONTRACT is priced at (titles, no names) · ③ what actually got logged. Expected = ${S.monthHours()} hrs/mo × cap% × allocation%.`}</span></div>`;
      html += compareChart(ms, planM, conM, actM, projFilter, dollars);

      if (!projNames.length) html += `<div class="empty">No matched allocations or actuals in this window.</div>`;
      projNames.forEach(pn => {
        const list = byProj[pn].sort((a, b) => b.actual - a.actual);
        const pe = list.reduce((s, r) => s + r.expected, 0), pa = list.reduce((s, r) => s + r.actual, 0);
        const cardTitle = byPerson ? (S.getPerson(pn) || { name: pn }).name : pn;
        const cardSub = byPerson ? ((S.getPerson(pn) || {}).title || '') : (list[0].client || '');
        const rowLabel = (r) => byPerson ? r.project : r.person.name;
        let b = '';
        list.forEach(r => {
          const vcls = varCls(r.expected, r.actual);
          const mcells = msDesc.map(m => { const c = r.byMonth[m]; const cls = (c.e || c.a) ? varCls(c.e, c.a) : ''; const pct = c.e ? Math.round(c.a / c.e * 100) + '%' : (c.a ? '—' : ''); return `<td class="num ${cls}" style="white-space:nowrap">${(c.a || c.e) ? `${varArrow(c.e, c.a)} <b>${fmtH(c.a)}</b><span class="vmini"> /${c.e ? fmtH(c.e) : '0'}</span><div class="vmini">${pct}</div>` : '·'}</td>`; }).join('');
          b += `<tr><td class="pname sticky-col" style="font-weight:600">${esc(rowLabel(r))}</td>${mcells}<td class="num">${fmtH(r.expected)}</td><td class="num">${fmtH(r.actual)}</td><td class="num ${vcls}">${varArrow(r.expected, r.actual)} ${r.variance >= 0 ? '+' : ''}${fmtH(r.variance)}</td><td class="num vmini">${r.expected ? Math.round(r.actual / r.expected * 100) + '%' : '—'}</td></tr>`;
        });
        // TOTAL row — per-month plan/actual/% summed over people
        const pcls = varCls(pe, pa);
        const totCells = msDesc.map(m => { let e = 0, a = 0; list.forEach(r => { e += r.byMonth[m].e; a += r.byMonth[m].a; }); const pct = e ? Math.round(a / e * 100) + '%' : (a ? '—' : ''); return `<td class="num ${e || a ? varCls(e, a) : ''}" style="white-space:nowrap">${(e || a) ? `${varArrow(e, a)} <b>${fmtH(a)}</b><span class="vmini"> /${fmtH(e)}</span><div class="vmini">${pct}</div>` : '·'}</td>`; }).join('');
        const totRow = `<tr style="background:#faf9f7;border-top:2px solid rgba(37,39,58,0.18)"><td class="pname sticky-col" style="font-weight:800">Total</td>${totCells}<td class="num" style="font-weight:800">${fmtH(pe)}</td><td class="num" style="font-weight:800">${fmtH(pa)}</td><td class="num ${pcls}" style="font-weight:800">${varArrow(pe, pa)} ${pa >= pe ? '+' : ''}${fmtH(pa - pe)}</td><td class="num vmini" style="font-weight:700">${pe ? Math.round(pa / pe * 100) + '%' : '—'}</td></tr>`;
        const cp = byPerson ? null : contractByProj[pn];
        const contractCell = cp ? `contract <b style="color:var(--sav-navy)">${fmtH(cpTot(cp))}</b>` : `<span style="color:#b0b5bc">no contract staffing</span>`;
        let contractTbl = '';
        if (cp && cp.roles.length) {
          contractTbl = `<div style="padding:8px 16px 12px;border-top:1px dashed rgba(37,39,58,0.12);background:#faf9f7">
            <div style="font-family:var(--font-display);font-size:9.5px;letter-spacing:0.05em;text-transform:uppercase;color:var(--sav-steel);margin-bottom:5px">② Per contract · ${esc(cp.feeProject.name)} <span style="text-transform:none;letter-spacing:0">(titles — match people to these when staffing)</span></div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">${cp.roles.map(r => `<span class="mv-chip" style="background:#e7eef0"><b>${_fmtHours(r.hours)}h</b> ${esc(r.title)} · ${r.fteMonths} FTE-mo</span>`).join('')}</div>
          </div>`;
        }
        html += `<div style="background:#fff;border:1px solid rgba(37,39,58,0.12);margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;padding:11px 16px;border-bottom:1px solid rgba(37,39,58,0.1)">
            <div class="pname" style="font-size:14px">${esc(cardTitle)} <span class="note-txt">· ${esc(cardSub)}</span></div>
            <div class="note-txt">① matrix <b style="color:var(--sav-navy)">${fmtH(pe)}</b> · ${contractCell} · ③ actual <b style="color:var(--sav-navy)">${fmtH(pa)}</b> · <span class="${pcls}">${pa >= pe ? '+' : ''}${fmtH(pa - pe)} vs plan</span></div>
          </div>
          <div class="cmp-scroll"><table class="dt cmp-table"><thead><tr><th class="sticky-col">${byPerson ? 'Project' : 'Person'}</th>${msDesc.map(m => `<th class="num">${esc(S.ymLabel(m))}<div class="vmini" style="text-transform:none;letter-spacing:0">act /plan · %</div></th>`).join('')}<th class="num">${dollars ? '① Plan cost' : '① Plan hrs'}</th><th class="num">${dollars ? '③ Actual cost' : '③ Actual hrs'}</th><th class="num">Variance</th><th class="num">% of plan</th></tr></thead><tbody>${b}${totRow}
          ${cp ? `<tr style="background:#f4f6f7"><td class="vmini sticky-col" style="font-weight:700">${dollars ? '② Contract fee $' : '② Contract (titles)'}</td>${msDesc.map(m => `<td class="num vmini">${cpM(cp, m) ? fmtH(cpM(cp, m)) : '·'}</td>`).join('')}<td class="num vmini" style="font-weight:700">${fmtH(cpTot(cp))}</td><td class="num vmini">${fmtH(pa)}</td><td class="num vmini ${varCls(cpTot(cp), pa)}">${pa >= cpTot(cp) ? '+' : ''}${fmtH(pa - cpTot(cp))}</td><td class="num vmini">${cpTot(cp) ? Math.round(pa / cpTot(cp) * 100) + '%' : '—'}</td></tr>` : ''}
          </tbody></table></div>
          ${contractTbl}
        </div>`;
      });
    }
    $('#p-actuals').innerHTML = html;
    wireImport();
    const vp2 = $('#var-project'); if (vp2) vp2.onchange = (e) => { state.varProject = e.target.value; renderActuals(); };
    const vpp = $('#var-person'); if (vpp) vpp.onchange = (e) => { state.varPerson = e.target.value; renderActuals(); };
    const vg = $('#var-group'); if (vg) vg.onchange = (e) => { state.varGroup = e.target.value; renderActuals(); };
    const vu = $('#var-unit'); if (vu) vu.onchange = (e) => { state.varUnit = e.target.value; renderActuals(); };
  }

  /* Grouped-bar trend chart: ① plan / ② contract / ③ actual per month. */
  function compareChart(ms, planM, conM, actM, projFilter, dollars) {
    const W = Math.max(560, ms.length * 110), H = 210, padL = 48, padT = 14, padB = 30, padR = 8;
    const max = Math.max(1, ...ms.map(m => Math.max(planM[m] || 0, conM[m] || 0, actM[m] || 0)));
    const y = (v) => padT + (H - padT - padB) * (1 - v / max);
    const gw = (W - padL - padR) / ms.length;
    const tf = (v) => (dollars ? '$' : '') + Math.round(v).toLocaleString();
    let s = '';
    for (let i = 0; i <= 4; i++) { const v = max * i / 4, yy = y(v); s += `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" stroke="rgba(37,39,58,.08)"></line><text x="${padL - 6}" y="${yy + 3}" text-anchor="end" font-size="9" fill="#79828C">${tf(v)}</text>`; }
    const bw = Math.max(8, Math.min(26, (gw - 26) / 3));
    const names = dollars ? ['① Plan cost', '② Contract fee', '③ Actual cost'] : ['① Matrix plan', '② Contract', '③ Actual'];
    ms.forEach((m, i) => {
      const x0 = padL + i * gw + (gw - 3 * bw - 8) / 2;
      [[planM[m] || 0, '#0E7C7B', ''], [conM[m] || 0, '#9aa3ad', ''], [actM[m] || 0, '#FFDF00', 'stroke="#25273A" stroke-width="1"']].forEach(([v, c, st], j) => {
        const xx = x0 + j * (bw + 4), yy = y(v);
        s += `<rect x="${xx}" y="${yy}" width="${bw}" height="${Math.max(0, H - padB - yy)}" fill="${c}" ${st}><title>${names[j]} · ${S.ymLabel(m)}: ${tf(v)}${dollars ? '' : ' h'}</title></rect>`;
      });
      s += `<text x="${padL + i * gw + gw / 2}" y="${H - 10}" text-anchor="middle" font-size="10" fill="#25273A" font-weight="600">${esc(S.ymLabel(m))}</text>`;
    });
    return `<div style="background:#fff;border:1px solid rgba(37,39,58,0.12);padding:14px 16px;margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:8px">
        <div style="font-family:var(--font-display);font-weight:700;font-size:12px;color:var(--sav-navy)">${dollars ? 'Dollars' : 'Hours'} by month — ${projFilter ? esc(projFilter) : 'all projects'}</div>
        <div class="note-txt"><span style="color:#0E7C7B">■</span> ${names[0]}&nbsp;&nbsp;<span style="color:#9aa3ad">■</span> ${names[1]}&nbsp;&nbsp;<span style="color:#e8c400">■</span> ${names[2]} · hover a bar for the number</div>
      </div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block">${s}</svg></div>`;
  }

  function varCls(exp, act) { if (!exp && !act) return ''; if (!exp) return 'var-over'; const r = act / exp; if (r > 1.1) return 'var-over'; if (r < 0.85) return 'var-under'; return 'var-ok'; }
  /** Arrow vs the plan: ▲ over allocation, ▼ under, — on plan (±10%). */
  function varArrow(exp, act) { if (!exp && !act) return ''; if (!exp) return '<span class="var-over">▲</span>'; const r = act / exp; if (r > 1.1) return '<span class="var-over">▲</span>'; if (r < 0.85) return '<span class="var-under">▼</span>'; return '<span class="var-ok">●</span>'; }

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
    const pplSel = (name) => `<select data-map-user="${esc(name)}" style="font-size:11px;max-width:170px"><option value="">map to…</option><option value="__ignore__">Ignore (not delivery)</option>${S.listPeople().map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>`;
    const projSel = (name) => `<input list="imp-proj-dl" data-map-proj="${esc(name)}" style="font-size:11px;max-width:190px;border:1px dashed rgba(37,39,58,0.3);padding:2px 5px" placeholder="type to map… (or Ignore)">`;
    const umUsers = `<div class="um ${uu.length ? '' : 'empty-ok'}"><h5>${uu.length ? uu.length + ' unmatched people — map once, remembered forever' : 'All people matched ✓'}</h5>${uu.length ? `<ul>${uu.slice(0, 30).map(u => `<li><span style="flex:1;color:var(--sav-navy)">${esc(u.name || '(blank)')}</span><span>${fmtH(u.hours)} h</span>&nbsp;${pplSel(u.name)}</li>`).join('')}</ul>` : '<div class="note-txt">Every Clockify user maps to a roster name.</div>'}</div>`;
    const umProj = `<div class="um ${up.length ? '' : 'empty-ok'}"><h5>${up.length ? up.length + ' unmatched projects — map once, remembered forever' : 'All projects matched ✓'}</h5>${up.length ? `<ul>${up.slice(0, 30).map(u => `<li><span style="flex:1;color:var(--sav-navy)">${esc(u.name || '(blank)')}</span><span>${fmtH(u.hours)} h</span>&nbsp;${projSel(u.name)}</li>`).join('')}</ul>` : '<div class="note-txt">Every Clockify project maps to the matrix.</div>'}</div>`;
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
        <datalist id="imp-proj-dl"><option value="Ignore"></option>${S.distinctProjects().map(p => `<option value="${esc(p)}"></option>`).join('')}</datalist>
        ${matchAudit(rep)}
        <div class="imp-actions">
          <button class="btn btn-primary" id="commit-merge">Commit — replace these months</button>
          <button class="btn btn-ghost" id="commit-add">Add to existing</button>
          <button class="btn btn-ghost" id="commit-cancel">Cancel</button>
          <span class="note-txt">Unmatched people are skipped (they carry no capacity). Pick a mapping next to any unmatched name — it re-checks instantly and the mapping is saved for every future import.</span>
        </div>
      </div>
    </div>`;
  }

  /* Full audit: every Clockify project → where its hours landed, with a remap
     select on every row (not just unmatched) — catches WRONG matches, e.g.
     sibling JPMC projects collapsing into one. */
  function matchAudit(rep) {
    if (!rep.matchDetail || !rep.matchDetail.length) return '';
    const viaBadge = (v) => v === 'name' ? '<span class="badge active">exact</span>' : v === 'mapped' ? '<span class="badge active">mapped</span>' : v === 'salesforce' ? '<span class="badge active">SF ID</span>' : v === 'unmatched' ? '<span class="badge" style="color:#8f2418;background:#fbe9e7">unmatched</span>' : `<span class="badge pursuit">${esc(v)}</span>`;
    const rows = rep.matchDetail.map(d => `<tr>
      <td>${esc(d.from)}</td><td>${viaBadge(d.via)}</td>
      <td>${d.via === 'unmatched' ? '<span class="vmini">—</span>' : esc(d.to)}</td>
      <td class="num">${fmtH(d.hours)}</td>
      <td><input list="imp-proj-dl" data-map-proj="${esc(d.from)}" style="font-size:11px;max-width:190px;border:1px dashed rgba(37,39,58,0.3);padding:2px 5px" placeholder="type to remap…"></td>
    </tr>`).join('');
    return `<details style="margin-bottom:16px"><summary style="cursor:pointer;font-family:var(--font-display);font-weight:700;font-size:12px;color:var(--sav-navy)">Where every Clockify project landed (${rep.matchDetail.length}) — check this if a project's actuals look wrong</summary>
      <table class="dt" style="margin-top:10px"><thead><tr><th>Clockify project</th><th>Match</th><th>→ Matrix project</th><th class="num">Hours</th><th>Fix</th></tr></thead><tbody>${rows}</tbody></table></details>`;
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
    const cm = $('#commit-merge'); if (cm) cm.onclick = () => { const r = S.commitClockify(state.clockifyReport, 'replace'); state.clockifyReport = null; state.clockifyRaw = null; renderActuals(); toast(`Imported ${r.written} rows${r.skipped ? ` · ${r.skipped} skipped (unmatched)` : ''}.`); };
    const cadd = $('#commit-add'); if (cadd) cadd.onclick = () => { const r = S.commitClockify(state.clockifyReport, 'merge'); state.clockifyReport = null; state.clockifyRaw = null; renderActuals(); toast(`Added ${r.written} rows${r.skipped ? ` · ${r.skipped} skipped` : ''}.`); };
    const cc = $('#commit-cancel'); if (cc) cc.onclick = () => { state.clockifyReport = null; state.clockifyRaw = null; renderActuals(); };
    // mapping selects — save + instantly re-analyze the same file
    const reanalyze = () => { if (state.clockifyRaw) { state.clockifyReport = S.analyzeClockify(state.clockifyRaw, months()[0]); renderActuals(); } };
    $$('#p-actuals [data-map-user]').forEach(sel => sel.onchange = () => { if (!sel.value) return; S.setUserMapping(sel.dataset.mapUser, sel.value); toast('Mapping saved — re-checked.'); reanalyze(); });
    $$('#p-actuals [data-map-proj]').forEach(inp => inp.onchange = () => {
      const v = inp.value.trim(); if (!v) return;
      const isIgnore = v.toLowerCase() === 'ignore';
      const hit = isIgnore ? '__ignore__' : S.distinctProjects().find(p => p.toLowerCase() === v.toLowerCase());
      if (!hit) { inp.style.borderColor = '#C0392B'; inp.title = 'Pick a project from the list (or type Ignore)'; return; }
      S.setProjectMapping(inp.dataset.mapProj, hit); toast('Mapping saved — re-checked.'); reanalyze();
    });
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
        const res = await fetch('/api/clockify?start=' + start + '&end=' + end, { headers: await apiHeaders() });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.detail || j.error || ('HTTP ' + res.status)); }
        state.clockifyRaw = await res.text();
        state.clockifyReport = S.analyzeClockify(state.clockifyRaw, ms[0]);
        renderActuals();
      } catch (e) { setNote('Clockify pull failed: ' + e.message + (String(e.message).includes('configured') || String(e.message).includes('501') ? ' — set CLOCKIFY_API_KEY + CLOCKIFY_WORKSPACE_ID in Vercel.' : ''), true); pa.disabled = false; }
    };
    const pb = $('#pull-box');
    if (pb) pb.onclick = async () => {
      setNote('Pulling clockify-actuals.csv from Box…'); pb.disabled = true;
      try {
        if (!window.UFC_Box || !window.UFC_Box.pullActuals) throw new Error('Box layer not loaded');
        state.clockifyRaw = await window.UFC_Box.pullActuals();
        state.clockifyReport = S.analyzeClockify(state.clockifyRaw, months()[0]);
        renderActuals();
      } catch (e) { setNote('Box pull failed: ' + e.message, true); pb.disabled = false; }
    };
  }

  function readClockify(file) {
    const rd = new FileReader();
    rd.onload = () => {
      const defMonth = months()[0];
      state.clockifyRaw = String(rd.result);
      state.clockifyReport = S.analyzeClockify(state.clockifyRaw, defMonth);
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
  /* ---------- MAPPING — one row per matrix project, its resolved fee-tool
     and Clockify links side by side, selector to fix either. Saved mappings
     live in staff.json, so a fix here applies to every import, forever. ---------- */
  async function pullClockifyNames() {
    try {
      const res = await fetch('/api/clockify?list=projects', { headers: await apiHeaders() });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state.clockifyNames = S.parseCsvRows(await res.text()).map(o => ({ name: o.Project || Object.values(o)[0] || '', client: o.Client || '' })).filter(x => x.name);
    } catch (e) { state.clockifyNames = []; state.clockifyNamesError = e.message; }
    try {
      const res2 = await fetch('/api/clockify?list=users&titles=1', { headers: await apiHeaders() });
      state.clockifyUsers = res2.ok ? S.parseCsvRows(await res2.text()).map(o => ({ name: o.User || '', email: o.Email || '', status: o.Status || '', title: o.JobTitle || '' })).filter(x => x.name) : [];
      const n = S.applyClockifyTitles(state.clockifyUsers);
      if (n) toast(n + ' job title' + (n > 1 ? 's' : '') + ' pulled from Clockify onto the roster.');
    } catch (e) { state.clockifyUsers = []; }
  }
  function renderMapping() {
    if (state.clockifyNames === null) {
      $('#p-mapping').innerHTML = '<div class="empty">Pulling the Clockify project list…</div>';
      pullClockifyNames().then(renderMapping);
      return;
    }
    const maps = S.getMappings();
    const feeList = S.listFeeProjects();
    const feeByName = {}; feeList.forEach(p => { feeByName[p.label.toLowerCase()] = p.id; if (!feeByName[p.name.toLowerCase()]) feeByName[p.name.toLowerCase()] = p.id; });
    const ckList = state.clockifyNames;
    const ckByName = {}; ckList.forEach(c => ckByName[c.name.toLowerCase()] = c.name);
    // reverse index: which clockify names resolve to each matrix project
    const ckResolved = {};
    ckList.forEach(c => {
      const m = maps.projects[c.name.toLowerCase().replace(/\s+/g, ' ').trim()];
      const res = m ? { name: m, via: 'mapped' } : S.resolveClockifyProject ? S.resolveClockifyProject(c.name) : null;
      if (res && res.name) (ckResolved[res.name] = ckResolved[res.name] || []).push({ ck: c.name, via: res.via });
    });
    let rows = '';
    let problems = 0;
    const q = state.mapSearch.toLowerCase();
    S.distinctProjects().forEach(mp => {
      // client comes from the matrix rows for this project — disambiguates same-name projects
      const mpClient = (S.listAllocations().find(a => a.project === mp) || {}).client || '';
      const fee = S.matchFeeProject(mp, mpClient);
      const cks = ckResolved[mp] || [];
      const isProblem = !fee || !cks.length;
      if (isProblem) problems++;
      if (q && !mp.toLowerCase().includes(q)) return;
      if (state.mapOnlyProblems && !isProblem) return;
      const feeCell = fee
        ? `<span class="badge ${fee.via === 'tokens' ? 'pursuit' : 'active'}" title="matched by ${esc(fee.via || 'name')}">${esc(fee.client ? fee.client + ' — ' + fee.name : fee.name)}</span>`
        : '<span class="no-link" style="margin:0">not linked</span>';
      const ckCell = cks.length
        ? cks.map(c => `<span class="badge ${c.via === 'name' || c.via === 'mapped' ? 'active' : 'pursuit'}" title="${esc(c.via)}">${esc(c.ck)}</span>`).join(' ')
        : (ckList.length ? '<span class="no-link" style="margin:0">no Clockify project resolves here</span>' : '<span class="vmini">list unavailable</span>');
      rows += `<tr>
        <td class="pname">${esc(mp)}</td>
        <td>${feeCell}<br><input list="map-fee-dl" data-map-fee="${esc(mp)}" class="fee-link-sel" style="margin:4px 0 0;width:90%" placeholder="${fee ? 'type to change… (— to unlink)' : 'type to link fee…'}"></td>
        <td>${ckCell}<br><input list="map-ck-dl" data-map-ck="${esc(mp)}" class="fee-link-sel" style="margin:4px 0 0;width:90%" placeholder="${cks.length ? 'type to add another…' : 'type Clockify project…'}"></td>
      </tr>`;
    });
    // ---- PEOPLE mapping: roster ↔ Clockify users ----
    const ckUsers = state.clockifyUsers || [];
    const userMaps = maps.users || {};
    let pplRows = ''; let pplProblems = 0;
    S.listPeople().filter(p => !p.isNewHire).forEach(p => {
      // which clockify users resolve to this person (saved mapping or name match)
      const hits = ckUsers.filter(u => { const m = userMaps[u.name.toLowerCase().replace(/\s+/g, ' ').trim()]; if (m) return m === p.id; return S.namesMatch(p.name, u.name) && !S.userExcluded(u.name, p.id); });
      const isProblem = !hits.length;
      if (isProblem) pplProblems++;
      if (q && !p.name.toLowerCase().includes(q)) return;
      if (state.mapOnlyProblems && !isProblem) return;
      const cell = hits.length
        ? hits.map(u => { const saved = userMaps[u.name.toLowerCase().replace(/\s+/g, ' ').trim()] === p.id; return `<span class="badge active" title="${esc(u.email)}${saved ? ' · pinned mapping' : ' · name match'}">${esc(u.name)} <a href="#" data-unmap-user="${esc(u.name)}" data-unmap-pid="${esc(p.id)}" data-unmap-saved="${saved ? 1 : 0}" style="color:inherit;text-decoration:none;font-weight:800" title="Not this person — remove">✕</a></span>`; }).join(' ')
        : (ckUsers.length ? '<span class="no-link" style="margin:0">no Clockify user matches — their hours are being DROPPED at import</span>' : '<span class="vmini">user list unavailable</span>');
      pplRows += `<tr><td class="pname">${esc(p.name)}<div class="vmini">${esc(p.title || '')}</div></td><td>${cell}<br><input list="map-ckuser-dl" data-map-ckuser="${esc(p.id)}" class="fee-link-sel" style="margin:4px 0 0;width:90%" placeholder="${hits.length ? 'type to add another…' : 'type Clockify user…'}"></td></tr>`;
    });
    const pplSection = `<h3 style="font-family:var(--font-display);font-size:13px;color:var(--sav-navy);margin:22px 0 8px">People — roster ↔ Clockify <span class="note-txt" style="font-weight:400">(${pplProblems} unmatched · unmatched people's hours are skipped at import — map, then re-pull actuals to backfill)</span></h3>
      <table class="dt"><thead><tr><th style="width:28%">Roster person (JS sheet)</th><th>③ Clockify user(s)</th></tr></thead><tbody>${pplRows || '<tr><td colspan="2"><div class="empty" style="border:0">Nothing matches the filter.</div></td></tr>'}</tbody></table>
      <datalist id="map-ckuser-dl">${ckUsers.map(u => `<option value="${esc(u.name)}"${u.email ? ` label="${esc(u.email)}"` : ''}></option>`).join('')}</datalist>`;
    // ---- job titles ↔ rate grid: every distinct roster title, its resolved
    // rate family + cost rate, and a picker to pin the ones that don't match ----
    const cat = window.RATES_CATALOG;
    const tierName = { high: 'High', mid: 'Mid', low: 'Low' };
    const rateOpts = [];
    if (cat && cat.hydrated) (cat.titles || []).forEach(t => (t.tiers || []).forEach(tr => rateOpts.push({ label: (t.name || t.id) + ' — ' + (tierName[tr.id] || tr.id), titleId: t.id, tierId: tr.id, rate: tr.costFloor })));
    const rateByLabel = {}; rateOpts.forEach(o => rateByLabel[o.label.toLowerCase()] = o);
    const titleCount = {};
    S.listPeople().forEach(p => { const t = (p.title || '').trim(); if (t) { const k = t.toLowerCase(); (titleCount[k] = titleCount[k] || { title: t, n: 0 }).n++; } });
    const savedTitles = (S.getMappings().titles) || {};
    let titleRows = ''; let titleProblems = 0;
    Object.values(titleCount).sort((a, b) => a.title.localeCompare(b.title)).forEach(tc => {
      const fam = S.titleFamily(tc.title);
      const rate = S.costRateForTitle(tc.title);
      const pinned = !!savedTitles[tc.title.toLowerCase()];
      const ok = !!rate;
      if (!ok) titleProblems++;
      if (state.mapOnlyProblems && ok) return;
      const famName = fam && cat ? ((cat.titles || []).find(x => x.id === fam.titleId) || {}).name || fam.titleId : null;
      const cell = ok ? `<span class="badge active" title="${pinned ? 'pinned mapping' : 'auto-matched'}">${esc(famName)} — ${tierName[fam.tierId] || fam.tierId} · $${rate}/h</span>${pinned ? ` <a href="#" data-unmap-title="${esc(tc.title)}" style="color:#8f2418;text-decoration:none" title="Remove pinned mapping">✕</a>` : ''}` : '<span class="no-link" style="margin:0">no rate match — hours excluded from $</span>';
      titleRows += `<tr><td class="pname">${esc(tc.title)}<div class="vmini">${tc.n} ${tc.n > 1 ? 'people' : 'person'}</div></td><td>${cell}<br><input list="map-title-dl" data-map-title="${esc(tc.title)}" class="fee-link-sel" style="margin:4px 0 0;width:90%" placeholder="${ok ? 'type to override…' : 'type rate-grid title…'}"></td></tr>`;
    });
    const titleSection = (cat && cat.hydrated) ? `<h3 style="font-family:var(--font-display);font-size:13px;color:var(--sav-navy);margin:22px 0 8px">Job titles ↔ rate grid <span class="note-txt" style="font-weight:400">(${titleProblems} unmatched · unmatched titles have no cost rate, so their hours are excluded from every $ view)</span></h3>
      <table class="dt"><thead><tr><th style="width:28%">Job title (from Clockify)</th><th>Rate-grid family · tier · cost rate</th></tr></thead><tbody>${titleRows || '<tr><td colspan="2"><div class="empty" style="border:0">Nothing matches the filter.</div></td></tr>'}</tbody></table>
      <datalist id="map-title-dl">${rateOpts.map(o => `<option value="${esc(o.label)}" label="$${o.rate}/h cost"></option>`).join('')}</datalist>` : '';
    const banner = state.clockifyNamesError ? `<div class="note-txt" style="color:#8f2418;margin-bottom:10px">Couldn't pull the Clockify list (${esc(state.clockifyNamesError)}) — fee links still work; Clockify column limited to saved mappings.</div>` : '';
    $('#p-mapping').innerHTML = `${banner}
      <div class="toolbar">
        <input type="search" id="map-search" placeholder="Filter projects…" value="${esc(state.mapSearch)}">
        <label class="chk" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:12.5px"><input type="checkbox" id="map-problems" ${state.mapOnlyProblems ? 'checked' : ''}> Only problems (${problems})</label>
        <span class="grow"></span>
        <button class="btn btn-ghost" id="map-refresh" title="Re-pull the Clockify project list">⟳ Refresh Clockify list</button>
        <span class="note-txt">Every pick is saved to staff.json and applies to all future imports.</span>
      </div>
      <table class="dt"><thead><tr><th style="width:28%">Matrix project (JS sheet)</th><th style="width:32%">② Fee tool</th><th>③ Clockify project(s) landing here</th></tr></thead><tbody>${rows || '<tr><td colspan="3"><div class="empty" style="border:0">Nothing matches the filter.</div></td></tr>'}</tbody></table>
      <datalist id="map-fee-dl"><option value="— unlink —"></option>${feeList.map(p => `<option value="${esc(p.label)}"></option>`).join('')}</datalist>
      <datalist id="map-ck-dl">${ckList.map(c => `<option value="${esc(c.name)}"${c.client ? ` label="${esc(c.client)}"` : ''}></option>`).join('')}</datalist>
      ${pplSection}
      ${titleSection}`;
    $('#map-search').oninput = (e) => { state.mapSearch = e.target.value; renderMapping(); const el = $('#map-search'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); };
    $('#map-problems').onchange = (e) => { state.mapOnlyProblems = e.target.checked; renderMapping(); };
    $('#map-refresh').onclick = () => { state.clockifyNames = null; state.clockifyNamesError = null; renderMapping(); };
    $$('#p-mapping [data-map-fee]').forEach(inp => inp.onchange = () => {
      const v = inp.value.trim(); if (!v) return;
      if (v === '— unlink —') { S.setFeeMapping(inp.dataset.mapFee, null); toast('Fee link removed.'); renderMapping(); return; }
      const id = feeByName[v.toLowerCase()];
      if (!id) { inp.style.borderColor = '#C0392B'; inp.title = 'Pick a fee project from the list'; return; }
      S.setFeeMapping(inp.dataset.mapFee, id); toast('Fee link saved.'); renderMapping();
    });
    $$('#p-mapping [data-unmap-user]').forEach(a => a.onclick = (e) => {
      e.preventDefault();
      const ck = a.dataset.unmapUser, pid = a.dataset.unmapPid;
      if (a.dataset.unmapSaved === '1') S.setUserMapping(ck, null);   // drop the pinned mapping
      S.setUserExclusion(ck, pid, true);                              // and block the fuzzy match
      toast('Removed — ' + ck + ' no longer maps to this person. Re-pull actuals to recompute.');
      renderMapping();
    });
    $$('#p-mapping [data-map-ckuser]').forEach(inp => inp.onchange = () => {
      const v = inp.value.trim(); if (!v) return;
      const u = (state.clockifyUsers || []).find(x => x.name.toLowerCase() === v.toLowerCase());
      if (!u) { inp.style.borderColor = '#C0392B'; inp.title = 'Pick a Clockify user from the list'; return; }
      S.setUserMapping(u.name, inp.dataset.mapCkuser);
      toast('Person mapped — now re-pull actuals on the Compare tab to backfill their hours.');
      renderMapping();
    });
    $$('#p-mapping [data-map-title]').forEach(inp => inp.onchange = () => {
      const v = inp.value.trim(); if (!v) return;
      const o = rateByLabel[v.toLowerCase()];
      if (!o) { inp.style.borderColor = '#C0392B'; inp.title = 'Pick a rate-grid title from the list'; return; }
      S.setTitleMapping(inp.dataset.mapTitle, o.titleId, o.tierId);
      toast('Title pinned — “' + inp.dataset.mapTitle + '” now costs $' + o.rate + '/h everywhere.');
      renderMapping();
    });
    $$('#p-mapping [data-unmap-title]').forEach(a => a.onclick = (e) => {
      e.preventDefault(); S.setTitleMapping(a.dataset.unmapTitle, null); toast('Pinned title mapping removed — back to auto-match.'); renderMapping();
    });
    $$('#p-mapping [data-map-ck]').forEach(inp => inp.onchange = () => {
      const v = inp.value.trim(); if (!v) return;
      const ck = ckByName[v.toLowerCase()];
      if (!ck) { inp.style.borderColor = '#C0392B'; inp.title = 'Pick a Clockify project from the list'; return; }
      S.setProjectMapping(ck, inp.dataset.mapCk); toast('Clockify mapping saved — existing hours moved, applies to every future import.'); renderMapping();
    });
  }

  /* ---------- INSIGHTS — where the heat is ---------- */
  function renderInsights() {
    const ms = months();
    const nowYm = S.currentYM();
    const msPast = ms.filter(m => m <= nowYm);           // actuals only exist up to now
    const hasAct = S.hasActuals();
    const vm = S.varianceMatrix(ms, {});
    const monthHrs = S.monthHours();

    // ---- per-project burn: actual vs matrix plan AND vs contract (past months only) ----
    const proj = {};
    vm.forEach(r => {
      const p = proj[r.project] || (proj[r.project] = { project: r.project, client: r.client, plan: 0, act: 0, people: new Set() });
      msPast.forEach(m => { const c = r.byMonth[m]; p.plan += c.e; p.act += c.a; });
      if (r.actual || r.expected) p.people.add(r.person.id);
    });
    const projRows = Object.values(proj).map(p => {
      const cp = S.contractPlan(p.project, msPast, p.client);
      return { ...p, contract: cp ? cp.total : null, varPlan: p.act - p.plan, pctPlan: p.plan ? p.act / p.plan : null, varContract: cp ? p.act - cp.total : null };
    }).filter(p => p.plan > 5 || p.act > 5);
    const hot = projRows.filter(p => (p.pctPlan != null && p.pctPlan > 1.1) || (p.plan === 0 && p.act > 20)).sort((a, b) => b.varPlan - a.varPlan).slice(0, 12);
    const cold = projRows.filter(p => p.plan > 20 && (p.act / p.plan) < 0.85).sort((a, b) => a.varPlan - b.varPlan).slice(0, 12);

    // ---- people: overextension = planned load + actual burn vs capacity ----
    const bw = S.bandwidthGrid(ms, { includePursuit: state.incPursuit });
    const ppl = bw.filter(r => r.activeMonths > 0).map(r => {
      const person = r.person;
      let act = 0; msPast.forEach(() => {});
      const mine = vm.filter(v => v.person.id === person.id);
      let actH = 0, planH = 0;
      mine.forEach(v => msPast.forEach(m => { actH += v.byMonth[m].a; planH += v.byMonth[m].e; }));
      const capH = msPast.length * S.capacityHours(person);
      return { person, peak: r.peak, avg: r.avg, actH, planH, capH, burnPct: capH ? actH / capH : 0, overMonths: ms.filter(m => (r.byMonth[m] || 0) > 100).length };
    });
    const overext = ppl.filter(p => p.peak > 100 || p.burnPct > 1.05).sort((a, b) => (b.burnPct + b.peak / 100) - (a.burnPct + a.peak / 100)).slice(0, 12);
    const headroom = ppl.filter(p => p.peak > 0 && p.peak <= 85 && p.burnPct < 0.85).sort((a, b) => a.avg - b.avg).slice(0, 10);

    // ---- role heat: where over-plan hours concentrate, by title ----
    const roleHeat = {};
    vm.forEach(r => {
      let e = 0, a = 0; msPast.forEach(m => { e += r.byMonth[m].e; a += r.byMonth[m].a; });
      const over = a - e; if (over <= 0) return;
      const t = (r.person.title || '').trim() || 'Unknown title';
      roleHeat[t] = (roleHeat[t] || 0) + over;
    });
    const roles = Object.entries(roleHeat).map(([title, hrs]) => ({ title, hrs })).sort((a, b) => b.hrs - a.hrs).slice(0, 8);
    const maxRole = roles.length ? roles[0].hrs : 1;
    const hireSignal = roles.filter(r => r.hrs >= monthHrs).map(r => `${esc(r.title)}: ~${(r.hrs / (monthHrs * msPast.length || 1)).toFixed(1)} FTE short`).join(' · ');

    // ---- unstaffed contract work: fee projects with contract hours but thin matrix staffing ----
    const gaps = [];
    S.distinctProjects().forEach(pn => {
      const client = (S.listAllocations().find(a => a.project === pn) || {}).client || '';
      const cp = S.contractPlan(pn, ms, client); if (!cp) return;
      const planned = vm.filter(r => r.project === pn).reduce((s, r) => { let e = 0; ms.forEach(m => e += r.byMonth[m].e); return s + e; }, 0);
      if (cp.total > 100 && planned < cp.total * 0.6) gaps.push({ project: pn, contract: cp.total, planned, gap: cp.total - planned });
    });
    gaps.sort((a, b) => b.gap - a.gap);

    // ---- unassigned contract roles: contract titles with no allocated person whose title matches ----
    const unassigned = [];
    S.distinctProjects().forEach(pn => {
      const client = (S.listAllocations().find(a => a.project === pn) || {}).client || '';
      const cp = S.contractPlan(pn, ms, client); if (!cp || !cp.roles.length) return;
      const staffedTitles = [...new Set(S.listAllocations().filter(a => a.project === pn).map(a => ((S.getPerson(a.personId) || {}).title || '').trim()))].filter(Boolean);
      const famOf = (t) => { const f = S.titleFamily && S.titleFamily(t); return f ? f.titleId : null; };
      const fams = new Set(staffedTitles.map(famOf).filter(Boolean));
      cp.roles.forEach(r => {
        if (r.hours < 20) return;                                  // ignore slivers
        const fam = famOf(r.title);
        const covered = (fam && fams.has(fam)) || staffedTitles.some(t => S.tokenScore(t, r.title) >= 0.5);
        if (!covered) unassigned.push({ project: pn, role: r.title, hours: r.hours, fte: r.fteMonths });
      });
    });
    unassigned.sort((a, b) => b.hours - a.hours);

    // ---- bandwidth coming available in the next 3 months ----
    const nextMs = []; { let [fy, fm] = nowYm.split('-').map(Number); for (let i = 0; i < 4; i++) { nextMs.push(fy + '-' + String(fm).padStart(2, '0')); fm++; if (fm > 12) { fm = 1; fy++; } } }
    const freeing = S.bandwidthGrid(nextMs, { includePursuit: state.incPursuit }).map(r => {
      const cur = r.byMonth[nextMs[0]] || 0;
      let best = null;
      nextMs.slice(1).forEach(m => { const v = r.byMonth[m] || 0; if (v < 100 && cur - v >= 25 && (!best || v < best.v)) best = { m, v }; });
      if (!best) return null;
      // freed = capacity that opens up BELOW the 100% line (loads over 100% free nothing until they cross it)
      const freedH = Math.round((Math.min(cur, 100) - best.v) / 100 * S.capacityHours(r.person));
      return freedH > 0 ? { person: r.person, cur, to: best.v, m: best.m, freedH } : null;
    }).filter(Boolean).sort((a, b) => b.freedH - a.freedH).slice(0, 12);

    // ---- pursuit exposure: how much of forward load is unsigned work ----
    const fwdMs = ms.filter(m => m >= nowYm);
    const bwAll2 = S.bandwidthGrid(fwdMs, { includePursuit: true });
    const firmBy = {}; S.bandwidthGrid(fwdMs, { includePursuit: false }).forEach(r => firmBy[r.person.id] = r);
    const pursuitPpl = bwAll2.map(r => {
      const f = firmBy[r.person.id];
      const all = r.avg || 0, firm = (f && f.avg) || 0, pur = all - firm;
      return pur >= 10 ? { person: r.person, all, firm, pur } : null;
    }).filter(Boolean).sort((a, b) => b.pur - a.pur).slice(0, 12);
    const purProj = {};
    S.listAllocations().filter(a => a.status === 'Pursuit' || a.type === 'Opportunity').forEach(a => {
      const act = fwdMs.filter(m => (a.start ? a.start <= m : false) && (a.end ? m <= a.end : true)).length;
      if (!act) return;
      const rec = purProj[a.project] || (purProj[a.project] = { project: a.project, ppl: new Set(), fteMo: 0 });
      rec.ppl.add(a.personId); rec.fteMo += (+a.pct || 0) / 100 * act;
    });
    const pursuitProjects = Object.values(purProj).sort((a, b) => b.fteMo - a.fteMo).slice(0, 8);

    // ---- month-over-month burn trend: last 3 COMPLETE months, flag ±30%+ swings ----
    const trends = [];
    if (hasAct && msPast.length >= 3) {
      const recent = msPast.slice(0, -1).slice(-3);
      Object.values(proj).forEach(p => {
        const series = recent.map(m => vm.filter(r => r.project === p.project).reduce((s, r) => s + r.byMonth[m].a, 0));
        const tot = series.reduce((s, v) => s + v, 0); if (tot < 30) return;
        const first = series[0], last = series[series.length - 1];
        const delta = last - first, pct = first ? delta / first : (last ? 1 : 0);
        if (Math.abs(pct) >= 0.3 && Math.abs(delta) >= 15) trends.push({ project: p.project, series, months: recent, delta, pct });
      });
      trends.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    }

    // ---- substantial macro / non-client time (> 40 h in the window) ----
    const macroAll = (hasAct && S.macroHours) ? S.macroHours(msPast) : [];
    const boh = macroAll.filter(r => r.pct >= 0.9 && r.hours > 40);
    const macro = macroAll.filter(r => r.pct < 0.9 && r.hours > 40).slice(0, 12);

    const fH = (n) => fmtH(Math.round(n * 10) / 10);
    const noAct = hasAct ? '' : `<div class="note-txt" style="margin-bottom:14px;color:#8a6d00">No Clockify actuals loaded — burn-based insights are empty. Pull actuals on the Compare tab first.</div>`;
    const projTable = (list, dir) => list.length ? `<table class="dt"><thead><tr><th>Project</th><th class="num">③ Actual</th><th class="num">① Plan</th><th class="num">② Contract</th><th class="num">${dir}</th></tr></thead><tbody>${list.map(p => `<tr><td class="pname">${esc(p.project)}<div class="vmini">${esc(p.client || '')}</div></td><td class="num"><b>${fH(p.act)}</b></td><td class="num">${fH(p.plan)}</td><td class="num">${p.contract != null ? fH(p.contract) : '—'}</td><td class="num ${dir === 'Over' ? 'var-over' : 'var-under'}">${p.varPlan >= 0 ? '+' : ''}${fH(p.varPlan)}${p.pctPlan != null ? `<div class="vmini">${Math.round(p.pctPlan * 100)}% of plan</div>` : '<div class="vmini">no plan</div>'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty" style="border:0">Nothing here — clean.</div>';

    $('#p-insights').innerHTML = `${noAct}<div class="ins-grid">
      <div class="ins-card"><h3>🔥 Burning over plan <span>· actuals beat both plans · ${esc(S.ymLabel(msPast[0] || ms[0]))}–${esc(S.ymLabel(msPast[msPast.length - 1] || ms[ms.length - 1]))}</span></h3>${projTable(hot, 'Over')}</div>
      <div class="ins-card"><h3>🧊 Under-served <span>· planned hours not being delivered — scope risk or stale plan</span></h3>${projTable(cold, 'Under')}</div>
      <div class="ins-card"><h3>⚠️ Most overextended people <span>· planned load + actual burn vs capacity</span></h3>${overext.length ? `<table class="dt"><thead><tr><th>Person</th><th class="num">Peak load</th><th class="num">Months &gt;100%</th><th class="num">Burn vs capacity</th></tr></thead><tbody>${overext.map(p => `<tr><td class="pname">${esc(p.person.name)}<div class="vmini">${esc(p.person.title || '')}</div></td><td class="num ${p.peak > 100 ? 'var-over' : ''}">${Math.round(p.peak)}%</td><td class="num">${p.overMonths}</td><td class="num ${p.burnPct > 1.05 ? 'var-over' : ''}">${p.capH ? Math.round(p.burnPct * 100) + '%' : '—'}<div class="vmini">${fH(p.actH)} / ${fH(p.capH)} h</div></td></tr>`).join('')}</tbody></table>` : '<div class="empty" style="border:0">Nobody over the line.</div>'}</div>
      <div class="ins-card"><h3>🎯 Role heat — what to hire <span>· over-plan hours by title${hireSignal ? ' · <b>' + hireSignal + '</b>' : ''}</span></h3>${roles.length ? `<table class="dt"><tbody>${roles.map(r => `<tr><td style="width:38%" class="pname">${esc(r.title)}</td><td><div class="heat-bar"><i style="width:${Math.round(r.hrs / maxRole * 100)}%;background:${r.hrs / maxRole > 0.6 ? '#e4453a' : '#e8b563'}"></i></div></td><td class="num" style="width:90px"><b>+${fH(r.hrs)}</b> h</td></tr>`).join('')}</tbody></table>` : '<div class="empty" style="border:0">No over-plan hours to attribute yet.</div>'}</div>
      <div class="ins-card"><h3>🕳️ Contract coverage gaps <span>· contract hours with under 60% staffed in the matrix — staff these or watch revenue slip</span></h3>${gaps.length ? `<table class="dt"><thead><tr><th>Project</th><th class="num">② Contract</th><th class="num">① Planned</th><th class="num">Gap</th></tr></thead><tbody>${gaps.slice(0, 10).map(g => `<tr><td class="pname">${esc(g.project)}</td><td class="num">${fH(g.contract)}</td><td class="num">${fH(g.planned)}</td><td class="num var-over">${fH(g.gap)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty" style="border:0">Every contract is ≥60% staffed.</div>'}</div>
      <div class="ins-card"><h3>🟢 Headroom <span>· ≤85% load and light burn — first call before hiring</span></h3>${headroom.length ? `<table class="dt"><thead><tr><th>Person</th><th class="num">Avg load</th><th class="num">Burn</th></tr></thead><tbody>${headroom.map(p => `<tr><td class="pname">${esc(p.person.name)}<div class="vmini">${esc(p.person.title || '')}</div></td><td class="num">${Math.round(p.avg)}%</td><td class="num">${p.capH ? Math.round(p.burnPct * 100) + '%' : '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty" style="border:0">No one with meaningful headroom.</div>'}</div>
      <div class="ins-card"><h3>🎯 Pursuit exposure <span>· forward load riding on unsigned work — if these don't land, this capacity frees; if they all land, check the peaks</span></h3>${pursuitPpl.length ? `<table class="dt"><thead><tr><th>Person</th><th class="num">Firm load</th><th class="num">+ Pursuit</th><th class="num">If all land</th></tr></thead><tbody>${pursuitPpl.map(p => `<tr><td class="pname">${esc(p.person.name)}<div class="vmini">${esc(p.person.title || '')}</div></td><td class="num">${Math.round(p.firm)}%</td><td class="num" style="color:#8a6d00;font-weight:700">+${Math.round(p.pur)}</td><td class="num ${p.all > 100 ? 'var-over' : ''}">${Math.round(p.all)}%</td></tr>`).join('')}</tbody></table>${pursuitProjects.length ? `<div style="padding:8px 2px 0"><div class="vmini" style="margin-bottom:5px;text-transform:uppercase;letter-spacing:0.05em">Biggest pursuits by staffing at stake</div><div style="display:flex;flex-wrap:wrap;gap:6px">${pursuitProjects.map(p => `<span class="mv-chip pursuit"><b>${p.fteMo.toFixed(1)}</b> FTE-mo · ${esc(p.project)} · ${p.ppl.size} ppl</span>`).join('')}</div></div>` : ''}` : '<div class="empty" style="border:0">No pursuit allocations in the forward window.</div>'}</div>
      <div class="ins-card"><h3>📈 Burn trend — last 3 complete months <span>· projects whose monthly burn swung ±30%+ — ramping up or winding down</span></h3>${trends.length ? `<table class="dt"><thead><tr><th>Project</th>${(trends[0].months).map(m => `<th class="num">${esc(S.ymLabel(m))}</th>`).join('')}<th class="num">Trend</th></tr></thead><tbody>${trends.slice(0, 12).map(t => `<tr><td class="pname">${esc(t.project)}</td>${t.series.map(v => `<td class="num">${fH(v)}</td>`).join('')}<td class="num ${t.delta > 0 ? 'var-over' : 'var-under'}">${t.delta > 0 ? '▲' : '▼'} ${t.delta > 0 ? '+' : ''}${fH(t.delta)}<div class="vmini">${t.pct > 0 ? '+' : ''}${Math.round(t.pct * 100)}%</div></td></tr>`).join('')}</tbody></table>` : `<div class="empty" style="border:0">${hasAct ? (msPast.length >= 3 ? 'No big swings — burn is steady.' : 'Widen the window to ≥3 past months to see trends.') : 'Needs Clockify actuals — pull them on the Compare tab.'}</div>`}</div>
      <div class="ins-card"><h3>🧩 Unassigned contract roles <span>· contract titles with no allocated person whose title matches — assign someone or confirm coverage</span></h3>${unassigned.length ? `<table class="dt"><thead><tr><th>Project</th><th>Role (contract)</th><th class="num">Hours</th><th class="num">FTE-mo</th></tr></thead><tbody>${unassigned.slice(0, 12).map(u => `<tr><td class="pname">${esc(u.project)}</td><td>${esc(u.role)}</td><td class="num"><b>${fH(u.hours)}</b></td><td class="num">${u.fte}</td></tr>`).join('')}</tbody></table>` : '<div class="empty" style="border:0">Every contract role has a plausible person allocated.</div>'}</div>
      <div class="ins-card"><h3>📉 Coming available — next 3 months <span>· load drops under 100% — hours below capacity they can take on</span></h3>${freeing.length ? `<table class="dt"><thead><tr><th>Person</th><th class="num">Now</th><th class="num">Drops to</th><th>When</th><th class="num">~Freed h/mo</th></tr></thead><tbody>${freeing.map(f => `<tr><td class="pname">${esc(f.person.name)}<div class="vmini">${esc(f.person.title || '')}</div></td><td class="num">${Math.round(f.cur)}%</td><td class="num" style="color:#1f7a44;font-weight:700">${Math.round(f.to)}%</td><td>${esc(S.ymLabel(f.m))}</td><td class="num">${f.freedH}</td></tr>`).join('')}</tbody></table>` : '<div class="empty" style="border:0">No meaningful load drops in the next 3 months.</div>'}</div>
      <div class="ins-card"><h3>🏢 Substantial macro time <span>· &gt;40 h on PPM / Macro / non-billable / BD in the window · dedicated BOH staff excluded</span></h3>${boh.length ? `<div style="padding:8px 16px;border-bottom:1px dashed rgba(37,39,58,0.12);background:#faf9f7"><div style="font-family:var(--font-display);font-size:9.5px;letter-spacing:0.05em;text-transform:uppercase;color:var(--sav-steel);margin-bottom:5px">Dedicated BOH staff · ≥90% of their time is macro — expected, not flagged</div><div style="display:flex;flex-wrap:wrap;gap:6px">${boh.map(r => `<span class="mv-chip" style="background:#e7eef0">${esc(r.person.name)} · ${Math.round(r.pct * 100)}%</span>`).join('')}</div></div>` : ''}${macro.length ? `<table class="dt"><thead><tr><th>Person</th><th class="num">Macro hrs</th><th class="num">% of their time</th><th>Where</th></tr></thead><tbody>${macro.map(r => { const top = Object.entries(r.byProj).sort((a, b) => b[1] - a[1])[0]; return `<tr><td class="pname">${esc(r.person.name)}</td><td class="num var-over"><b>${fH(r.hours)}</b></td><td class="num">${Math.round(r.pct * 100)}%</td><td class="vmini">${esc(top[0])} (${fH(top[1])} h)</td></tr>`; }).join('')}</tbody></table>` : `<div class="empty" style="border:0">${hasAct ? 'Nobody over 40 h of non-client time.' : 'Needs Clockify actuals — pull them on the Compare tab.'}</div>`}</div>
    </div>`;
  }

  /* ---------- PROFITABILITY — billed $ (booked fee schedule) vs burned $
     (Clockify hours × cost rate by title). Rating-1 projects only count as
     billed; everything else shows cost-only so the burn is still visible. */
  function renderProfit() {
    const nowYm = S.currentYM();
    const ms = months().filter(m => m <= nowYm);
    const fmtD = (n) => (n < 0 ? '−' : '') + '$' + Math.abs(Math.round(n)).toLocaleString();
    const r = S.profitability(ms);
    if (!r.ok) { $('#p-profit').innerHTML = `<div class="empty">${r.why === 'rates' ? 'Rates not loaded — sign in and wait for rates.json (dollars need the cost-rate catalog).' : 'No Clockify actuals loaded — pull them on the Compare tab first.'}</div>`; return; }
    const booked = r.rows.filter(x => x.booked);
    const unlinked = r.rows.filter(x => !x.booked);
    const totBilled = booked.reduce((s, x) => s + x.billed, 0);
    const totCostBooked = booked.reduce((s, x) => s + x.cost, 0);
    const totMargin = totBilled - totCostBooked;
    const losing = booked.filter(x => x.margin < 0);
    // monthly billed vs burned series across booked projects
    const bM = {}, cM = {}; ms.forEach(m => { bM[m] = 0; cM[m] = 0; });
    booked.forEach(x => ms.forEach(m => { bM[m] += (x.billedByMonth && x.billedByMonth[m]) || 0; cM[m] += (x.byMonth[m] && x.byMonth[m].cost) || 0; }));
    let html = `<div class="kpi-strip">
      <div class="kpi-card accent"><div class="k-num">${fmtD(totBilled)}</div><div class="k-lbl">Billed · booked (rating 1) fee schedule · ${esc(S.ymLabel(ms[0]))}–${esc(S.ymLabel(ms[ms.length - 1]))}</div></div>
      <div class="kpi-card"><div class="k-num">${fmtD(totCostBooked)}</div><div class="k-lbl">Burned · hours × cost rate · booked projects</div></div>
      <div class="kpi-card ${totMargin < 0 ? 'warn' : ''}"><div class="k-num">${fmtD(totMargin)}</div><div class="k-lbl">Margin${totBilled ? ' · ' + Math.round(totMargin / totBilled * 100) + '%' : ''}</div></div>
      <div class="kpi-card ${losing.length ? 'warn' : ''}"><div class="k-num">${losing.length}</div><div class="k-lbl">Booked projects under water</div></div>
    </div>`;
    if (r.noRate.length) html += `<div class="note-txt" style="margin:-8px 0 12px;color:#8a6d00">⚠ No cost rate for ${r.noRate.length} people: ${esc(r.noRate.slice(0, 12).join(' · '))}${r.noRate.length > 12 ? ' …' : ''} — their hours are EXCLUDED from cost. <button class="btn btn-ghost" id="pf-titles" style="padding:2px 10px;font-size:11px">⟳ Pull job titles from Clockify</button></div>`;
    html += profitChart(ms, bM, cM, fmtD);
    const row = (x, i) => {
      const pct = x.marginPct != null ? Math.round(x.marginPct * 100) : null;
      const mCls = x.margin < 0 ? 'var-over' : 'var-ok';
      const trend = ms.slice(-3).map(m => (x.byMonth[m] && x.byMonth[m].cost) || 0);
      const rising = trend.length >= 2 && trend[trend.length - 1] > trend[0] * 1.3 && trend[trend.length - 1] - trend[0] > 500;
      return `<tr class="pf-row" data-i="${i}" style="cursor:pointer"><td class="pname">${esc(x.project)}${x.fee ? `<div class="vmini">${esc(x.fee.client || '')}</div>` : ''}${rising ? ' <span class="status-p" style="background:#fce7c2;color:#8a6d00">burn rising</span>' : ''}</td><td class="num">${x.booked ? fmtD(x.billed) : '<span style="color:#b0b5bc">' + (x.fee ? 'not booked (rating ' + (x.fee.rating || '?') + ')' : 'no fee link') + '</span>'}</td><td class="num">${fmtD(x.cost)}<div class="vmini">${Math.round(x.hours).toLocaleString()} h</div></td><td class="num ${x.booked ? mCls : ''}">${x.booked ? fmtD(x.margin) : '—'}</td><td class="num ${x.booked && pct != null && pct < 20 ? 'var-over' : ''}">${x.booked && pct != null ? pct + '%' : '—'}</td></tr>
      <tr class="pf-detail" data-i="${i}" style="display:none"><td colspan="5" style="background:#faf9f7;padding:8px 16px 12px"><div style="display:flex;flex-wrap:wrap;gap:6px">${x.ppl.map(p => `<span class="mv-chip"><b>${fmtD(p.cost)}</b> ${esc(p.name)} · ${Math.round(p.hours)} h × $${p.rate}/h${p.title ? ' · ' + esc(p.title) : ''}</span>`).join('')}</div></td></tr>`;
    };
    const tbl = (list, empty) => list.length ? `<table class="dt"><thead><tr><th>Project</th><th class="num">Billed (fee schedule)</th><th class="num">Burned (cost)</th><th class="num">Margin</th><th class="num">Margin %</th></tr></thead><tbody>${list.map((x) => row(x, r.rows.indexOf(x))).join('')}</tbody></table>` : `<div class="empty" style="border:0">${empty}</div>`;
    html += `<div class="ins-grid" style="grid-template-columns:1fr">
      <div class="ins-card"><h3>💰 Booked projects — billed vs burned <span>· sorted worst margin first · click a row for the people behind the cost</span></h3>${tbl(booked, 'No booked (rating 1) projects with logged hours in this window.')}</div>
      <div class="ins-card"><h3>🕒 Burning without booked billing <span>· hours logged on projects with no rating-1 fee — pursuit investment or a missing mapping/rating</span></h3>${tbl(unlinked, 'Every project with hours has a booked fee. Clean.')}</div>
    </div>`;
    $('#p-profit').innerHTML = html;
    const pt = $('#pf-titles');
    if (pt) pt.onclick = async () => { pt.disabled = true; pt.textContent = 'Pulling titles…'; try { await pullClockifyNames(); renderProfit(); } catch (e) { pt.disabled = false; pt.textContent = 'Pull failed — retry'; } };
    $$('#p-profit .pf-row').forEach(tr => tr.onclick = () => { const d = $(`#p-profit .pf-detail[data-i="${tr.dataset.i}"]`); if (d) d.style.display = d.style.display === 'none' ? '' : 'none'; });
  }

  function profitChart(ms, bM, cM, fmtD) {
    const W = Math.max(560, ms.length * 90), H = 200, padL = 58, padT = 14, padB = 28, padR = 8;
    const max = Math.max(1, ...ms.map(m => Math.max(bM[m], cM[m])));
    const y = (v) => padT + (H - padT - padB) * (1 - v / max);
    const gw = (W - padL - padR) / ms.length;
    let s = '';
    for (let i = 0; i <= 4; i++) { const v = max * i / 4, yy = y(v); s += `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" stroke="rgba(37,39,58,.08)"></line><text x="${padL - 6}" y="${yy + 3}" text-anchor="end" font-size="9" fill="#79828C">$${Math.round(v / 1000)}k</text>`; }
    const bw = Math.max(10, Math.min(30, (gw - 18) / 2));
    ms.forEach((m, i) => {
      const x0 = padL + i * gw + (gw - 2 * bw - 4) / 2;
      [[bM[m], '#0E7C7B', 'Billed'], [cM[m], '#FFDF00', 'Burned']].forEach(([v, c, nm], j) => {
        const xx = x0 + j * (bw + 4), yy = y(v);
        s += `<rect x="${xx}" y="${yy}" width="${bw}" height="${Math.max(0, H - padB - yy)}" fill="${c}" ${j ? 'stroke="#25273A" stroke-width="1"' : ''}><title>${nm} · ${S.ymLabel(m)}: ${fmtD(v)}</title></rect>`;
      });
      s += `<text x="${padL + i * gw + gw / 2}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#25273A" font-weight="600">${esc(S.ymLabel(m))}</text>`;
    });
    return `<div style="background:#fff;border:1px solid rgba(37,39,58,0.12);padding:14px 16px;margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:8px">
        <div style="font-family:var(--font-display);font-weight:700;font-size:12px;color:var(--sav-navy)">Billed vs burned by month — booked projects</div>
        <div class="note-txt"><span style="color:#0E7C7B">■</span> Billed (fee schedule)&nbsp;&nbsp;<span style="color:#e8c400">■</span> Burned (hours × cost rate) · gap = margin</div>
      </div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block">${s}</svg></div>`;
  }

  /* ---------- TIME ENTRY COMPLIANCE — who logs, who's behind ----------
     Works off committed Clockify actuals (person × project × month). A month
     counts as "logged" against capacity (monthHours × cap%); people with
     allocations in a month but no hours are behind. Current month is judged
     pro-rata by working days elapsed. ---------- */
  function renderCompliance() {
    const late = S.getLateness();
    const lateBar = `<div class="toolbar">
      <button class="btn btn-secondary" id="pull-lateness">⟳ Pull entry lateness (API)</button>
      <span class="note-txt" id="late-note">${late.at ? 'Lateness last pulled ' + new Date(late.at).toLocaleString() : 'Lateness = when an entry was CREATED vs the day the work happened (decoded from Clockify entry IDs). One aggregated call — fast.'}</span>
      <span class="grow"></span>
    </div>`;
    if (!S.hasActuals()) { $('#p-compliance').innerHTML = lateBar + '<div class="empty">No Clockify actuals loaded — pull them on the Compare tab first. Compliance is computed from logged hours by month.</div>'; wireLateness(); return; }
    const nowYm = S.currentYM();
    const ms = months().filter(m => m <= nowYm);
    if (!ms.length) { $('#p-compliance').innerHTML = lateBar + '<div class="empty">Window is entirely in the future — step back to see logged months.</div>'; wireLateness(); return; }
    // pro-rata factor for the current month (day-of-month / ~30)
    const now = new Date();
    const prorata = Math.min(1, now.getUTCDate() / 30);
    const db = S.readDb();
    // actual hours per person per month (all projects, incl. internal/PTO maps)
    const perPM = {};
    Object.entries(db.actuals).forEach(([k, h]) => { const [pid, , ym] = k.split('|'); (perPM[pid] = perPM[pid] || {})[ym] = (perPM[pid][ym] || 0) + h; });
    // who SHOULD log: anyone with an active allocation in a month, or anyone with hours
    const rows = [];
    S.listPeople().forEach(person => {
      if (person.isNewHire) return;
      const logged = perPM[person.id] || {};
      const cap = S.capacityHours(person);
      const byMonth = {}; let expectedMonths = 0, okMonths = 0, totLogged = 0, totCap = 0;
      ms.forEach(ym => {
        const active = S.personAllocationsIn(person.id, ym).length > 0;
        const h = logged[ym] || 0;
        if (!active && !h) { byMonth[ym] = null; return; }
        const capM = cap * (ym === nowYm ? prorata : 1);
        const pct = capM ? h / capM : 0;
        byMonth[ym] = { h, capM, pct };
        expectedMonths++; totLogged += h; totCap += capM;
        if (pct >= 0.8) okMonths++;
      });
      if (!expectedMonths) return;
      // behind = latest expected month under 80%
      const lastMs = ms.filter(m => byMonth[m]).slice(-1)[0];
      const lastPct = lastMs ? byMonth[lastMs].pct : 0;
      rows.push({ person, byMonth, expectedMonths, okMonths, totLogged, totCap, compliance: expectedMonths ? okMonths / expectedMonths : 0, lastMs, lastPct, behindHrs: Math.max(0, totCap - totLogged) });
    });
    rows.sort((a, b) => a.lastPct - b.lastPct || a.compliance - b.compliance);
    const behindNow = rows.filter(r => r.lastMs === nowYm ? r.lastPct < 0.8 * 1 : r.lastPct < 0.8);
    const zeroNow = rows.filter(r => r.byMonth[nowYm] && r.byMonth[nowYm].h === 0);
    const teamPct = rows.length ? rows.reduce((s, r) => s + r.compliance, 0) / rows.length : 0;
    const chronic = rows.filter(r => r.expectedMonths >= 3 && r.compliance < 0.5);
    const stars = rows.filter(r => r.expectedMonths >= 3 && r.compliance >= 0.95).sort((a, b) => b.expectedMonths - a.expectedMonths);

    // ---- lateness join: rows from the API, per person over the window ----
    const lateRows = late.rows.filter(r => ms.includes(r.ym));
    const latePP = {};
    lateRows.forEach(r => {
      const person = S.listPeople().find(p => S.namesMatch(p.name, r.user));
      const pid = person ? person.id : 'x:' + r.user;
      const a = latePP[pid] || (latePP[pid] = { name: person ? person.name : r.user, entries: 0, lagW: 0, maxLag: 0, w3: 0, w7: 0 });
      a.entries += r.entries; a.lagW += r.avgLag * r.entries; a.maxLag = Math.max(a.maxLag, r.maxLag);
      a.w3 += r.pctWithin3 * r.entries / 100; a.w7 += r.pctWithin7 * r.entries / 100;
    });
    const lateList = Object.values(latePP).map(a => ({ ...a, avgLag: a.entries ? a.lagW / a.entries : 0, p3: a.entries ? a.w3 / a.entries * 100 : 0, p7: a.entries ? a.w7 / a.entries * 100 : 0 })).filter(a => a.entries >= 5);
    const worstLag = lateList.slice().sort((x, y) => y.avgLag - x.avgLag).slice(0, 12);
    const teamLag = lateList.length ? lateList.reduce((s, a) => s + a.lagW, 0) / lateList.reduce((s, a) => s + a.entries, 0) : null;
    const teamP7 = lateList.length ? lateList.reduce((s, a) => s + a.w7, 0) / lateList.reduce((s, a) => s + a.entries, 0) * 100 : null;
    const latenessCard = late.rows.length ? `
        <div class="ins-card"><h3>🐌 Latest loggers <span>· days between doing the work and entering it · team avg <b>${teamLag != null ? teamLag.toFixed(1) : '—'}d</b> · ${teamP7 != null ? Math.round(teamP7) : '—'}% within a week</span></h3><table class="dt"><thead><tr><th>Person</th><th class="num">Avg lag</th><th class="num">Worst</th><th class="num">≤3 days</th><th class="num">≤7 days</th></tr></thead><tbody>${worstLag.map(a => `<tr><td class="pname">${esc(a.name)}</td><td class="num ${a.avgLag > 7 ? 'var-over' : a.avgLag > 3 ? 'var-under' : 'var-ok'}">${a.avgLag.toFixed(1)}d</td><td class="num">${Math.round(a.maxLag)}d</td><td class="num">${Math.round(a.p3)}%</td><td class="num">${Math.round(a.p7)}%</td></tr>`).join('')}</tbody></table></div>` : `
        <div class="ins-card"><h3>🐌 Entry lateness</h3><div class="empty" style="border:0">Not pulled yet — click “⟳ Pull entry lateness” above. It answers “who logs late and by how many days”, decoded from entry creation timestamps.</div></div>`;

    // ---- discipline score: completeness (compliance) × timeliness (≤7-day share) ----
    const lagByPid = {}; Object.entries(latePP).forEach(([pid, a]) => lagByPid[pid] = a);
    const disc = rows.filter(r => r.expectedMonths >= 2).map(r => {
      const la = lagByPid[r.person.id];
      const p7 = la && la.entries ? la.w7 / la.entries : null;
      const score = p7 == null ? r.compliance : (r.compliance * 0.6 + p7 * 0.4);
      return { person: r.person, compliance: r.compliance, p7, score };
    }).sort((a, b) => a.score - b.score);
    const worstDisc = disc.filter(d => d.score < 0.6).slice(0, 8);

    const cellFor = (c, ym) => {
      if (!c) return '<td><span class="cell u0">·</span></td>';
      const p = Math.round(c.pct * 100);
      const cls = p >= 100 ? 'u2' : p >= 80 ? 'u1' : p > 0 ? 'u3' : 'u5';
      return `<td title="${fmtH(c.h)} / ${fmtH(c.capM)} h"><span class="cell ${cls}" style="${p === 0 ? 'color:#fff' : ''}">${p}%</span></td>`;
    };
    let body = '';
    rows.forEach(r => {
      body += `<tr><td class="who"><div class="who-name" style="cursor:default">${esc(r.person.name)}</div><div class="who-meta">${esc(r.person.title || '')}</div></td>`;
      ms.forEach(ym => body += cellFor(r.byMonth[ym], ym));
      body += `<td class="pk ${r.compliance < 0.5 ? 'over' : ''}">${Math.round(r.compliance * 100)}%</td></tr>`;
    });
    $('#p-compliance').innerHTML = lateBar + `
      <div class="kpi-strip">
        <div class="kpi-card ${teamPct < 0.7 ? 'warn' : 'accent'}"><div class="k-num">${Math.round(teamPct * 100)}%</div><div class="k-lbl">Team compliance · months ≥80% logged</div></div>
        <div class="kpi-card ${behindNow.length ? 'warn' : ''}"><div class="k-num">${behindNow.length}</div><div class="k-lbl">Behind right now (latest month &lt;80%)</div></div>
        <div class="kpi-card ${zeroNow.length ? 'warn' : ''}"><div class="k-num">${zeroNow.length}</div><div class="k-lbl">Zero hours logged · ${esc(S.ymLabel(nowYm))}</div></div>
        <div class="kpi-card"><div class="k-num">${rows.length}</div><div class="k-lbl">People expected to log</div></div>
      </div>
      <div class="ins-grid" style="margin-bottom:16px">
        ${latenessCard}
        <div class="ins-card"><h3>⏰ Most behind <span>· hours missing vs capacity across the window</span></h3><table class="dt"><thead><tr><th>Person</th><th class="num">Logged</th><th class="num">Capacity</th><th class="num">Missing</th><th class="num">Latest month</th></tr></thead><tbody>${rows.filter(r => r.behindHrs > 8).slice(0, 12).map(r => `<tr><td class="pname">${esc(r.person.name)}<div class="vmini">${esc(r.person.title || '')}</div></td><td class="num">${fmtH(r.totLogged)}</td><td class="num">${fmtH(r.totCap)}</td><td class="num var-over">${fmtH(r.behindHrs)}</td><td class="num ${r.lastPct < 0.8 ? 'var-over' : 'var-ok'}">${Math.round(r.lastPct * 100)}%</td></tr>`).join('') || '<tr><td colspan="5"><div class="empty" style="border:0">Everyone current.</div></td></tr>'}</tbody></table></div>
        <div class="ins-card"><h3>📊 Entry insights</h3><div style="padding:14px 16px;font-size:12.5px;line-height:1.7;color:var(--sav-navy)">
          ${chronic.length ? `<div>• <b>${chronic.length} chronic under-logger${chronic.length > 1 ? 's' : ''}</b> (&lt;50% of months at target): ${chronic.slice(0, 6).map(r => esc(r.person.name)).join(', ')}${chronic.length > 6 ? '…' : ''} — their projects read as under-served in Compare even if the work happened.</div>` : ''}
          ${zeroNow.length ? `<div>• <b>${zeroNow.length} allocated but at zero for ${esc(S.ymLabel(nowYm))}</b>: ${zeroNow.slice(0, 6).map(r => esc(r.person.name)).join(', ')}${zeroNow.length > 6 ? '…' : ''} — chase these first; the month is ${Math.round(prorata * 100)}% gone.</div>` : ''}
          ${worstDisc.length ? `<div>• <b>Weakest logging discipline</b> (completeness × timeliness): ${worstDisc.map(d => `${esc(d.person.name)} (${Math.round(d.score * 100)})`).join(', ')} — score = 60% months-on-target + 40% entries within a week${late.rows.length ? '' : ' (lateness not pulled — completeness only)'}.</div>` : ''}
          ${stars.length ? `<div>• <b>Reliable loggers</b>: ${stars.slice(0, 6).map(r => esc(r.person.name)).join(', ')} — ≥95% of months on target.</div>` : ''}
          <div>• Variance data is only as good as entry: team compliance of <b>${Math.round(teamPct * 100)}%</b> means roughly <b>${fmtH(rows.reduce((s, r) => s + r.behindHrs, 0))} h</b> of delivered work may be invisible in Compare.</div>
          <div class="vmini" style="margin-top:6px;color:var(--sav-steel)">"On target" = ≥80% of capacity logged for the month (current month pro-rata). Capacity = ${S.monthHours()} h × cap%. PTO/internal projects count if mapped rather than ignored.</div>
        </div></div>
      </div>
      <div class="hm-wrap"><table class="hm"><thead><tr><th class="who">Person</th>${ms.map(m => `<th>${esc(S.ymLabel(m))}${m === nowYm ? '<div class="vmini" style="text-transform:none">pro-rata</div>' : ''}</th>`).join('')}<th class="pk">Months on target</th></tr></thead><tbody>${body}</tbody></table></div>
      <div class="legend"><span><span class="sw" style="background:#cfe6e4"></span>≥100%</span><span><span class="sw" style="background:#eef4f4"></span>80–99% on target</span><span><span class="sw" style="background:#fce7c2"></span>1–79% behind</span><span><span class="sw" style="background:#e4453a"></span>0% nothing logged</span><span>· = not allocated that month</span></div>`;
    wireLateness();
  }

  function wireLateness() {
    const b = $('#pull-lateness'); if (!b) return;
    b.onclick = async () => {
      const ms = months().filter(m => m <= S.currentYM());
      if (!ms.length) return;
      const start = ms[0] + '-01';
      const [ey, em] = ms[ms.length - 1].split('-').map(Number);
      const end = ey + '-' + String(em).padStart(2, '0') + '-' + new Date(Date.UTC(ey, em, 0)).getUTCDate();
      b.disabled = true; const note = $('#late-note'); if (note) note.textContent = 'Pulling entry-level lateness (aggregated server-side)…';
      try {
        const res = await fetch('/api/clockify?lateness=1&start=' + start + '&end=' + end, { headers: await apiHeaders() });
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.detail || j.error || ('HTTP ' + res.status)); }
        const rows = S.parseCsvRows(await res.text()).map(o => ({ user: o.User, ym: o.Month, entries: +o.Entries || 0, hours: +o.Hours || 0, avgLag: +o.AvgLagDays || 0, maxLag: +o.MaxLagDays || 0, pctWithin3: +o.PctWithin3d || 0, pctWithin7: +o.PctWithin7d || 0 }));
        S.setLateness(rows);
        renderCompliance();
        toast('Lateness stats loaded — ' + rows.length + ' person-months.');
      } catch (e) { b.disabled = false; if (note) { note.textContent = 'Lateness pull failed: ' + e.message; note.style.color = '#8f2418'; } }
    };
  }

  /* ---------- staff.json sync (Box) — makes the matrix + notes a shared,
     living document instead of per-browser state ---------- */
  function setStoreNote(mode, extra) {
    const el = $('#store-note'); if (!el) return;
    if (mode === 'box') { el.innerHTML = '● Shared · saves to <b>staff.json</b> in Box'; el.style.color = '#1f7a44'; }
    else if (mode === 'error') { el.textContent = '⚠ Box save failed — working locally. ' + (extra || ''); el.style.color = '#C0392B'; }
    else { el.textContent = 'Local to this browser — sign in to Box to share'; el.style.color = ''; }
  }
  async function wireStaffSync() {
    const Box = window.UFC_Box;
    if (!(Box && Box.enabled)) { setStoreNote('local'); return; }
    try {
      const remote = await Box.pullStaff();                 // resolves staff.json in the shared folder
      if (remote) S.hydrateFromRemote(remote);              // Box is the source of truth
      else await Box.uploadStaff(S.readDb());               // first run: seed staff.json from local
      let t = null, pushing = false;
      S.attachRemote((db) => {
        clearTimeout(t); pushing = true;
        t = setTimeout(async () => {
          try { Box.emitSync && Box.emitSync('syncing', 'staff.json'); await Box.uploadStaff(db); Box.emitSync && Box.emitSync('synced', ''); setStoreNote('box'); }
          catch (e) { Box.emitSync && Box.emitSync('error', 'staff.json: ' + e.message); setStoreNote('error', e.message); }
          finally { pushing = false; }
        }, 1200);
      });
      setStoreNote('box');
      // Live refresh: when the tab regains focus (and every 3 min) check the file's
      // etag; if a teammate saved, hydrate + re-render — mappings flow to everyone.
      const refresh = async () => {
        if (pushing || document.hidden || !Box.pullStaffIfChanged) return;
        try { const r = await Box.pullStaffIfChanged(); if (r) { S.hydrateFromRemote(r); renderAll(); toast('Refreshed — a teammate saved changes to staff.json.'); } } catch (e) {}
      };
      document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
      setInterval(refresh, 180000);
    } catch (e) { setStoreNote('error', e.message); }
  }

  /* ---------- canonical name sync (Clockify → matrix renames) ---------- */
  async function startCanonSync() {
    const btn = $('#canon-sync'); if (btn) { btn.disabled = true; btn.textContent = 'Pulling project list…'; }
    try {
      const res = await fetch('/api/clockify?list=projects', { headers: await apiHeaders() });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.detail || j.error || ('HTTP ' + res.status)); }
      const rows = S.parseCsvRows(await res.text()).map(o => ({ name: o.Project || o.project || Object.values(o)[0] || '', client: o.Client || o.client || '' }));
      if (!rows.length) throw new Error('empty project list');
      state.canonProposals = S.proposeCanonical(rows);
      renderAllocations();
    } catch (e) { alert('Could not pull the Clockify project list: ' + e.message + '\n\nAlternative: export any Clockify report as CSV and drop it on the Compare tab — unmatched projects can be mapped there.'); if (btn) { btn.disabled = false; btn.textContent = '⇄ Sync names from Clockify'; } }
  }
  function renderCanonReview() {
    const props = state.canonProposals; if (!props) return;
    const need = props.filter(p => p.kind !== 'exact');
    const exact = props.length - need.length;
    let rows = '';
    need.forEach((p, i) => {
      const badge = p.kind === 'strong' ? `<span class="badge active">${p.score}%</span>` : p.kind === 'weak' ? `<span class="badge pursuit">${p.score}%</span>` : p.kind === 'saved' ? `<span class="badge active">saved</span>` : `<span class="no-link" style="margin:0">no Clockify yet</span>`;
      rows += `<tr>
        <td class="pname">${esc(p.matrix)}</td>
        <td>${badge}</td>
        <td>${p.match ? esc(p.match) + (p.client ? ` <span class="vmini">· ${esc(p.client)}</span>` : '') : '<span class="vmini">keeps its JS-sheet name; will canonicalize once it exists in Clockify</span>'}</td>
        <td>${p.match ? `<label class="chk" style="justify-content:flex-end"><input type="checkbox" data-canon-i="${i}" ${p.kind !== 'weak' ? 'checked' : ''}> rename</label>` : ''}</td>
      </tr>`;
    });
    const panel = `<div class="import-card" id="canon-panel" style="margin-top:16px">
      <h3>Sync names from Clockify — review</h3>
      <p><b>${exact}</b> of ${props.length} matrix projects already match Clockify exactly. Review the rest: checked rows get renamed to the canonical Clockify name (allocations + actuals follow), and the old→new mapping is remembered so future JS-sheet imports auto-rename. Strong matches are pre-checked; weak ones (amber) need your eye.</p>
      <table class="dt"><thead><tr><th>Matrix (JS sheet)</th><th>Match</th><th>Clockify canonical</th><th style="text-align:right">Rename?</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="imp-actions" style="margin-top:14px">
        <button class="btn btn-primary" id="canon-commit">Commit renames</button>
        <button class="btn btn-ghost" id="canon-cancel">Cancel</button>
      </div>
    </div>`;
    $('#p-allocations').insertAdjacentHTML('afterbegin', panel);
    $('#canon-cancel').onclick = () => { state.canonProposals = null; renderAllocations(); };
    $('#canon-commit').onclick = () => {
      const pairs = [];
      $$('#canon-panel [data-canon-i]').forEach(cb => { if (cb.checked) { const p = need[+cb.dataset.canonI]; if (p && p.match) pairs.push({ from: p.matrix, to: p.match }); } });
      const n = S.commitRenames(pairs);
      state.canonProposals = null;
      renderAll();
      toast(`Renamed ${pairs.length} projects (${n} allocations updated) — mapping saved.`);
    };
  }

  /* ---------- matrix file re-import ---------- */
  function wireMatrixImport() {
    const fi = $('#matrix-file'); if (!fi) return;
    fi.onchange = async () => {
      const f = fi.files[0]; fi.value = ''; if (!f) return;
      const res = await S.parseMatrixFile(f);
      if (res.error) { alert('Import failed — ' + res.error); return; }
      const people = new Set(res.rows.map(r => r.person)).size, projects = new Set(res.rows.map(r => r.proj)).size;
      if (!confirm(`Replace the allocation matrix with “${f.name}”?\n\n${res.rows.length} allocations · ${people} people · ${projects} projects.\n\nClockify actuals and roster capacity/title edits are KEPT. Manually-added allocations and note edits made here since the last import are REPLACED by the sheet.`)) return;
      const out = S.importMatrix(res.rows, f.name);
      renderAll();
      toast(`Matrix replaced — ${out.allocations} allocations, ${out.people} people.`);
    };
  }

  function renderCounts() {
    $('#cnt-alloc').textContent = '(' + S.listAllocations().length + ')';
    $('#cnt-proj').textContent = '(' + S.distinctProjects().length + ')';
  }
  function renderActive() {
    const panel = $('#p-' + state.tab);
    try {
      if (state.tab === 'bandwidth') renderBandwidth();
      else if (state.tab === 'allocations') renderAllocations();
      else if (state.tab === 'projects') renderProjects();
      else if (state.tab === 'actuals') renderActuals();
      else if (state.tab === 'mapping') renderMapping();
      else if (state.tab === 'insights') renderInsights();
      else if (state.tab === 'profit') renderProfit();
      else if (state.tab === 'compliance') renderCompliance();
    } catch (e) {
      console.error('render failed', e);
      if (panel) panel.innerHTML = `<div class="empty" style="color:#8f2418"><b>This view hit an error:</b> ${esc(e.message)}<br><span class="vmini">${esc((e.stack || '').split('\n')[1] || '')}</span></div>`;
    }
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
    wireMatrixImport();
    wireStaffSync().then(() => {
      buildWindowOptions();
    $('#month-hrs').value = S.monthHours();
    $('#win-start').onchange = (e) => { state.winStart = e.target.value; renderActive(); };
    const step = (d) => { const nv = S.ymAdd(state.winStart, d); const sel = $('#win-start'); if ([...sel.options].some(o => o.value === nv)) { state.winStart = nv; sel.value = nv; renderActive(); } };
    $('#win-prev').onclick = () => step(-1);
    $('#win-next').onclick = () => step(1);
    $('#win-len').onchange = (e) => { state.winLen = +e.target.value; renderActive(); };
    $('#month-hrs').onchange = (e) => { S.setMonthHours(+e.target.value); renderActive(); };
    $('#inc-pursuit').onchange = (e) => { state.incPursuit = e.target.checked; renderActive(); };
    $$('#tabs .tab').forEach(t => t.onclick = () => { state.tab = t.dataset.tab; $$('#tabs .tab').forEach(x => x.classList.toggle('active', x === t)); $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'p-' + state.tab)); renderActive(); });
    $('#am-close').onclick = closeAllocModal; $('#am-cancel').onclick = closeAllocModal; $('#am-save').onclick = saveAllocModal;
    $('#alloc-modal').onclick = (e) => { if (e.target.id === 'alloc-modal') closeAllocModal(); };
    renderAll();
    });
  }

  if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(init); else document.addEventListener('ufc:ready', init);
})();
