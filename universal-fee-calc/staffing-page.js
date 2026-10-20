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

  /* Auth header for our own /api/* endpoints — they validate the Box session.
     The adapter is the only thing that reads the token; a fallback that
     scanned localStorage for anything token-shaped used to live here. */
  async function apiHeaders() {
    try {
      const tok = window.UFC_Box && window.UFC_Box.getAccessToken ? await window.UFC_Box.getAccessToken() : null;
      if (tok) return { Authorization: 'Bearer ' + tok };
    } catch (e) {}
    return {};
  }

  /* ============================================================
     ACCESS WALL — fail-CLOSED. Bandwidth, pursuit staffing and
     utilization are leadership-sensitive.

     This used to be its OWN hardcoded allowlist, which silently
     drifted from store.js every time someone was added or removed
     (people granted admin elsewhere were denied here, with no
     obvious reason why). There is now ONE list, in the identity
     layer: isAdmin() covers full admins and tool admins — the
     latter being people who get the admin TOOLS while their
     project-data visibility stays member-scoped.
     ============================================================ */
  function staffAccessOk() {
    try { return !!(STORE && STORE.isAdmin && STORE.isAdmin()); } catch (e) { return false; }
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
          <a href="Fee Generator.html" class="btn btn-secondary" style="text-decoration:none">System home</a>
        </div>
      </div>`;
    const b = document.getElementById('deny-back');
    if (b) b.onclick = () => { STORE.clearImpersonation(); window.location.reload(); };
  }

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  /* Search boxes live inside the tab they filter, and the tab is rebuilt as
     one innerHTML string — so a keystroke used to throw away the input mid-word
     and re-focus it. Now the rebuild waits until typing pauses, and the caret
     is put back where it was. */
  const debounce = (window.UFC_UI && window.UFC_UI.debounce) || ((fn) => fn);
  function searchBox(sel, apply) {
    const run = debounce((v) => {
      apply(v);
      const el = $(sel); if (!el) return;
      el.focus(); el.setSelectionRange(el.value.length, el.value.length);
    }, 150);
    return (e) => run(e.target.value);
  }
  const esc = window.UFC_UI.esc;
  const fmtH = (n) => n ? (Math.round(n * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—';
  const fmtPct = (n) => n ? Math.round(n) + '%' : '';

  const state = {
    tab: 'actuals',
    winStart: null, winLen: 12, incPursuit: true,
    group: '',                                              // practice group in view ('' = all) — see UFC_Staff.setViewGroup
    allocSearch: '', allocStatus: '', allocProject: '',
    projSearch: '', projClient: '',
    pplSearch: '', expandedRoster: new Set(), pplExpandInit: false,
    varProject: '', varPerson: '', varProjectQ: '', varPersonQ: '', gridMetric: 'plan', varGroup: 'project', varUnit: 'hours', showMacro: true, glossaryOpen: false,
    expandedProjects: new Set(),
    clockifyReport: null, clockifyRaw: null,
    editingAlloc: null,
    mapSearch: '', mapOnlyProblems: false, mapAllFee: false, clockifyNames: null,
    compSearch: '', compSort: { key: 'behind', dir: -1 },   // Clockify Reporting table: filter + column sort
    compView: 'summary',                                    // 'summary' (grouped + sparklines) | 'grid' (month detail)
    bridgeOpen: false,                                      // "contract staffing" card starts rolled up — it can dwarf the page
    dupOpen: false,                                         // "double-counted allocations" stays open while you work through it
    allocSort: { key: 'project', dir: 1 },                  // the allocations log: click a column to sort, again to flip
  };

  /* Practice-group picker. The short names are what people say out loud;
     the stored value is the fee tool's controlled service-line string. */
  const GROUP_SHORT = { 'Program & Project Management': 'PPM', 'Other Savills Group': 'Other' };
  const groupShort = (g) => GROUP_SHORT[g] || g;
  const GROUP_PREF = 'savills-ppm-staff-group-view';
  function applyGroup(g) {
    state.group = S.groupList().includes(g) ? g : '';
    S.setViewGroup(state.group || null);
    try { localStorage.setItem(GROUP_PREF, state.group); } catch (e) {}
  }
  function buildGroupOptions() {
    const sel = $('#grp-view'); if (!sel) return;
    let saved = ''; try { saved = localStorage.getItem(GROUP_PREF) || ''; } catch (e) {}
    applyGroup(saved);
    sel.innerHTML = '<option value="">All groups</option>' + S.groupList().map(g => `<option value="${esc(g)}" ${state.group === g ? 'selected' : ''}>${esc(groupShort(g))}</option>`).join('');
    sel.onchange = (e) => { applyGroup(e.target.value); renderAll(); };
  }

  function months() { const out = []; let c = state.winStart; for (let i = 0; i < state.winLen; i++) { out.push(c); c = S.ymAdd(c, 1); } return out; }

  /* ============================================================
     TWO VIEWS, ONE PAGE. The module as built is the LEADERSHIP view and
     stays admin-only. A revenue leader who opens the page gets the LEADER
     view (staffing-leader.js): their own projects through the same wall
     as everywhere else — time vs plan, their allocations, their mapping.
     Admins switch between the two at the top of the page and preview a
     specific leader with "Viewing as". Nothing in either view writes a
     fee project.
     ============================================================ */
  const VIEW_KEY = 'ufc_staff_view_v1';
  let viewMode = 'lead';                      // 'lead' (the full module) | 'leader'
  const LEADER = () => window.UFC_StaffLeader;
  function leaderCapable(user) {
    try {
      const u = user || STORE.getCurrentUser();
      if (STORE.resolveLeader && (STORE.resolveLeader(u.username) || STORE.resolveLeader(u.name))) return true;
      const sc = LEADER() && LEADER().scope(u);
      return !!(sc && sc.fee.length);
    } catch (e) { return false; }
  }
  /** What this person may see: 'lead', 'leader' or null (denied). Admins keep
      their chosen mode; an impersonated non-admin is shown as a leader. */
  function resolveView() {
    if (staffAccessOk()) {
      let m = null; try { m = new URLSearchParams(location.search).get('view'); } catch (e) {}
      if (m !== 'leader' && m !== 'lead') { try { m = localStorage.getItem(VIEW_KEY); } catch (e) { m = null; } }
      viewMode = m === 'leader' ? 'leader' : 'lead';
      return viewMode;
    }
    if (leaderCapable()) { viewMode = 'leader'; return 'leader'; }
    return null;
  }
  function applyView() {
    const leader = viewMode === 'leader';
    document.body.classList.toggle('leader-view', leader);
    const sw = $('#view-switch'); if (sw) { sw.hidden = !staffAccessOk(); $$('#view-switch [data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === viewMode)); }
    const tabs = $('#tabs'), ltabs = $('#leader-tabs');
    if (tabs) tabs.hidden = leader; if (ltabs) ltabs.hidden = !leader;
    $$('.panel').forEach(pn => pn.classList.toggle('active', leader ? pn.id === 'p-lead-' + (state.leaderTab || 'time') : pn.id === 'p-' + state.tab));
  }
  function setupViewSwitch() {
    $$('#view-switch [data-view]').forEach(b => b.onclick = () => {
      if (!staffAccessOk()) return;
      viewMode = b.dataset.view === 'leader' ? 'leader' : 'lead';
      try { localStorage.setItem(VIEW_KEY, viewMode); } catch (e) {}
      applyView(); renderAll();
    });
    $$('#leader-tabs .tab').forEach(t => t.onclick = () => setLeaderTab(t.dataset.ltab));
  }
  function setLeaderTab(name) {
    state.leaderTab = name || 'time';
    $$('#leader-tabs .tab').forEach(x => x.classList.toggle('active', x.dataset.ltab === state.leaderTab));
    $$('.panel').forEach(pn => pn.classList.toggle('active', pn.id === 'p-lead-' + state.leaderTab));
    renderLeader();
  }
  function renderLeader() {
    const Lm = LEADER(); if (!Lm) return;
    try { Lm.render(state.leaderTab || 'time'); } catch (e) { console.error('leader view', e); const h = $('#p-lead-' + (state.leaderTab || 'time')); if (h) h.innerHTML = '<div class="empty">Could not draw this view — ' + esc(e.message || e) + '</div>'; }
  }
  function uCls(v) { if (!v) return 'u0'; if (v <= 85) return 'u1'; if (v <= 100) return 'u2'; if (v <= 120) return 'u3'; if (v <= 150) return 'u4'; return 'u5'; }
  /** Datalist inputs need an exact match to commit, but browsers don't always
      auto-complete what someone typed even when it uniquely identifies one
      option — so a good-faith partial ("Carlyle Investment Manag…") gets
      rejected outright. Falls back to a substring match across the given
      fields; only resolves when exactly one candidate matches, so an
      ambiguous partial still asks the person to be more specific. */
  function resolveTyped(typed, list, fields) {
    const v = typed.trim().toLowerCase(); if (!v) return null;
    const hits = list.filter(item => fields.some(f => String(item[f] || '').toLowerCase().includes(v)));
    return hits.length === 1 ? hits[0] : null;
  }
  function isPursuitAlloc(a) { return a.status === 'Pursuit' || a.type === 'Opportunity'; }
  /** Switch to a named tab (button highlight + panel + render). */
  function setTab(name) {
    const t = document.querySelector(`#tabs .tab[data-tab="${name}"]`);
    if (!t) return;
    state.tab = name;
    $$('#tabs .tab').forEach(x => x.classList.toggle('active', x === t));
    $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'p-' + name));
    renderActive();
  }
  /** Wire every data-goto-tab link inside a container. */
  function wireGoto(sel) {
    $$(sel + ' [data-goto-tab]').forEach(a => a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); setTab(a.dataset.gotoTab); });
  }

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
      sel.onchange = () => {
        const v = sel.value; if (v === '__me__') STORE.clearImpersonation(); else STORE.setImpersonation(v);
        // Previewing a non-admin shows the page as they get it: the leader view, or the door.
        const m = resolveView(); if (!m) { renderDenied(); return; }
        applyView(); renderAll();
      };
    }
    const roleEl = $('#id-role'), noteEl = $('#id-note');
    if (roleEl) { if (cur.role === 'admin') { roleEl.textContent = 'Admin · all teams'; roleEl.className = 'id-role admin'; } else { roleEl.textContent = 'Member'; roleEl.className = 'id-role member'; } }
    if (noteEl) noteEl.textContent = cur.impersonating ? 'Previewing ' + (cur.name || 'this person') : '';
  }

  /* Compact callout: who's freeing up over the next 3 months — surfaced on
     By Person (Bandwidth was folded into that view; this is the natural
     home for it now) since it's the "who can take the next assignment"
     question people come here for. Collapsed to a one-line summary by
     default; expands (native <details>, same pattern as matchAudit()) into
     a scrollable gradient timeline covering everyone active in the window,
     not just those freeing up. */

  /* ---------- ALLOCATIONS ---------- */
  /* ---------- Contract → Allocation bridge (lives on the Allocations tab —
     it proposes allocations, so it belongs where allocations are managed).
     Gaps are cached against the db snapshot so re-renders (search keystrokes)
     don't recompute the whole contract diff. ---------- */
  function bridgeGapsCached() {
    // Key on meta.updatedAt (stamped by every writeDb) — object identity is
    // useless here because writeDb caches the same mutated object.
    const db = S.readDb();
    const key = ((db.meta && db.meta.updatedAt) || '') + '|' + state.group;   // the group scopes which contract roles count
    if (state._gapsKey !== key) { state._bridgeGaps = S.contractStaffingGaps(); state._gapsKey = key; }
    return state._bridgeGaps || [];
  }

  /** A gap for someone ALREADY staffed on the project is an edit to their
      existing row, not a headline — flag it inline on the row instead of in
      the card. Returns { personId|project → gapIndex } for those, keyed only
      when that person really has a visible allocation row to hang it on. */
  function inlineTopUpIndex() {
    const idx = {};
    const allocs = S.listAllocations();
    bridgeGapsCached().forEach((g, i) => {
      if (g.open || !g.topUp || !g.person) return;
      if (g.possibleDupFee) return;   // demand from a suspect duplicate record — keep it in the card WITH its warning
      if (allocs.some(a => a.personId === g.person.id && a.project === g.project)) idx[g.person.id + '|' + g.project] = i;
    });
    return idx;
  }

  /* Same person, same project, overlapping months, two rows — the load charts
     add both, so every over-allocation figure downstream is inflated until one
     goes. Flag only: two concurrent roles CAN be legitimate, so a human picks
     which row (if either) is wrong. */
  function dupAllocSectionHtml() {
    const dups = S.duplicateAllocations();
    if (!dups.length) return '';
    const n = dups.length;
    return `<details id="dup-roll" ${state.dupOpen ? 'open' : ''} style="background:#fff;border:1px solid rgba(37,39,58,0.12);border-left:4px solid #C0392B;margin-bottom:14px">
      <summary style="list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:11px 16px">
        <span style="font-family:var(--font-display);font-weight:700;font-size:13px;color:var(--sav-navy)">⚠ Double-counted allocations</span>
        <span class="mv-chip" style="background:#C0392B;color:#fff;font-weight:800">${n} person·project pair${n === 1 ? '' : 's'}</span>
        <span class="grow"></span>
        <span class="note-txt">click to review</span>
      </summary>
      <div style="padding:0 16px 12px">
        <div class="note-txt" style="margin:0 0 8px">These people hold more than one allocation to the same project over the same months, so their load is counted twice. Two genuine concurrent roles are possible — nothing is removed automatically. <b>Edit</b> a row to change its window or percentage, <b>End before next</b> closes it the month before the next row starts, or delete the one that shouldn't be there.</div>
        ${dups.map(d => `<div style="border-bottom:1px dashed rgba(37,39,58,0.12);padding:8px 0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:5px">
            <b>${esc(d.person.name)}</b><span class="note-txt">on</span><span style="font-weight:600">${pLbl(d.project)}</span>
            <span class="mv-chip" style="background:#fbe9ea;color:#b3151b;font-weight:700">${d.worstPct}% in ${esc(S.ymLabel(d.worstMonth))}</span>
            ${d.identical ? '<span class="mv-chip" style="background:#fdf3d7;color:#8a6d00;font-weight:700" title="Same window, same percentage — almost certainly one row saved twice">identical rows</span>' : ''}
          </div>
          <table class="dt" style="max-width:760px"><thead><tr><th>Window</th><th class="num">%</th><th>Status</th><th>Note</th><th style="width:300px"></th></tr></thead><tbody>
          ${d.rows.slice().sort((x, y) => String(x.start).localeCompare(String(y.start))).map((r, i, arr) => {
            // the next row that starts after this one — "end before next" trims this row to the month before it
            const next = arr.slice(i + 1).find(x => x.start > r.start);
            const trimTo = next ? S.ymAdd(next.start, -1) : null;
            const canTrim = trimTo && trimTo >= r.start && (!r.end || r.end > trimTo);
            return `<tr>
            <td>${esc(S.ymLabel(r.start))}${r.end && r.end !== r.start ? ' → ' + esc(S.ymLabel(r.end)) : (r.end ? '' : ' → open')}</td>
            <td class="num">${Math.round(parseFloat(r.pct) || 0)}%</td>
            <td class="note-txt">${esc(r.status || '')}${r.type ? ' · ' + esc(r.type) : ''}</td>
            <td class="note-txt">${esc((r.note || '').slice(0, 60))}</td>
            <td style="white-space:nowrap"><button class="btn btn-ghost" style="padding:4px 10px;font-size:11px" data-dup-edit="${esc(r.id)}">Edit</button>${canTrim ? ` <button class="btn btn-ghost" style="padding:4px 10px;font-size:11px" data-dup-trim="${esc(r.id)}" data-to="${esc(trimTo)}" title="Set this row's end to ${esc(S.ymLabel(trimTo))}, so it hands over to the row starting ${esc(S.ymLabel(next.start))}">End before next → ${esc(S.ymLabel(trimTo))}</button>` : ''} <button class="btn btn-ghost" style="padding:4px 10px;font-size:11px;color:#8f2418" data-dup-del="${esc(r.id)}">Delete</button></td>
          </tr>`; }).join('')}
          </tbody></table>
        </div>`).join('')}
      </div>
    </details>`;
  }

  function bridgeSectionHtml() {
    /* NOTE: `gaps` stays the FULL cached list. Every data-bridge-* attribute
       below carries an index into it, and the click handlers read
       bridgeGapsCached()[i] — filtering this array would silently point every
       Confirm button at the wrong row. Dismissed rows are skipped inside the
       map instead, the same way inline top-ups are. */
    const gaps = bridgeGapsCached();
    if (!gaps.length) return '';
    const dropped = gaps.filter(g => g.dismissed);
    const inline = new Set(Object.values(inlineTopUpIndex()));
    const isHidden = (g, i) => inline.has(i) || !!g.dismissed;
    if (gaps.every(isHidden) && !dropped.length) return '';
    // ---- roll-up stats: the whole story while the card is collapsed ----
    const shown = gaps.filter((g, i) => !isHidden(g, i));
    const nOpen = shown.filter(g => g.open).length;
    const nNew = shown.filter(g => !g.open && g.isNew).length;
    const nLinked = shown.filter(g => !g.open && !g.isNew).length;
    const nSigned = shown.filter(g => g.via === 'direct' && !g.possibleDupFee).length;
    const nDup = shown.filter(g => g.possibleDupFee).length;
    const fteMo = Math.round(shown.reduce((s2, g) => s2 + (parseFloat(g.totalNeedFteMo) || 0), 0) * 10) / 10;
    const nProj = new Set(shown.map(g => g.project)).size;
    const stat = (n, label, bg, fg, title) => n ? `<span class="mv-chip" style="background:${bg};color:${fg};font-weight:700" title="${esc(title || '')}">${n} ${label}</span>` : '';
    const segRow = (sg) => `<tr><td>${esc(S.ymLabel(sg.start))}${sg.start !== sg.end ? ' → ' + esc(S.ymLabel(sg.end)) : ''}</td><td class="num">${sg.want}%</td><td class="num">${sg.have ? sg.have + '%' : '—'}</td><td class="num" style="font-weight:800;color:var(--sav-teal)">+${sg.need}%</td></tr>`;
    const rosterOptions = S.listPeople().map(p => `<option value="${esc(p.name)}">`).join('');
    return `<details id="bridge-roll" ${state.bridgeOpen ? 'open' : ''} style="background:#fff;border:1px solid rgba(37,39,58,0.12);border-left:4px solid var(--sav-teal);margin-bottom:14px">
      <summary style="list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:11px 16px">
        <span id="bridge-caret" style="font-size:10px;color:var(--sav-steel);transition:transform .15s;display:inline-block;${state.bridgeOpen ? 'transform:rotate(90deg)' : ''}">▶</span>
        <span style="font-family:var(--font-display);font-weight:700;font-size:13px;color:var(--sav-navy)">🤝 Contract staffing to be allocated</span>
        <span class="mv-chip" style="background:var(--sav-navy);color:#fff;font-weight:800">${shown.length} item${shown.length === 1 ? '' : 's'} · ${nProj} project${nProj === 1 ? '' : 's'}</span>
        <span class="mv-chip" style="background:#e7f0ee;color:#0E7C7B;font-weight:700" title="Total contract staffing not yet reflected in the matrix, in full-time-equivalent months">${fteMo} FTE-mo missing</span>
        ${stat(nOpen, 'open role' + (nOpen === 1 ? '' : 's'), '#fdf3d7', '#8a6d00', 'Unstaffed contract slots that need a name')}
        ${stat(nNew, 'not on roster', '#fdf3d7', '#8a6d00', 'Contract names that don’t match anyone here — map the nickname or create them')}
        ${stat(nLinked, 'ready to confirm', '#e7f0ee', '#0E7C7B', 'Contract names that already resolve to a roster person — one click each')}
        ${stat(nSigned, 'signed · nobody staffed', '#fbe9ea', '#b3151b', 'Won projects with zero matrix staffing — the most urgent kind')}
        ${stat(nDup, 'possible dup ⚠', '#fdf3d7', '#8a6d00', 'Demand from a fee record that may duplicate another — check before staffing')}
        <span class="grow"></span>
        <span class="note-txt" id="bridge-roll-hint">${state.bridgeOpen ? 'click to roll up' : 'click to review'}</span>
      </summary>
      <div style="padding:0 16px 12px">
      <div class="note-txt" style="margin:0 0 6px">Every under-covered contract role — named people AND open slots. Review the segments, adjust the name if it maps to someone already here (nicknames count — the link is remembered), then confirm. Nothing is created without your OK.</div>
      <datalist id="bridge-people">${rosterOptions}</datalist>
      ${gaps.map((g, i) => isHidden(g, i) ? '' : `<details style="border-bottom:1px dashed rgba(37,39,58,0.12)">
        <summary style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 4px;cursor:pointer">
          <b>${g.open ? 'Open role: ' + esc(g.roleTitle) : esc(g.resource)}</b><span class="note-txt">on</span><span style="font-weight:600">${pLbl(g.project, g.client)}</span>
          ${g.open
            ? '<span class="mv-chip" style="background:#fdf3d7;color:#8a6d00;font-weight:700">unstaffed — needs a name</span>'
            : (g.isNew
              ? '<span class="mv-chip" style="background:#fdf3d7;color:#8a6d00;font-weight:700">not on the roster — map or create below</span>'
              : `<span class="mv-chip" style="background:#e7f0ee;color:#0E7C7B;font-weight:700">links to existing: ${esc(g.person.name)}</span>`)}
          ${g.topUp ? `<span class="mv-chip" style="background:#e7eef0">${g.open ? 'partially covered by matching titles' : 'top-up — partial allocation exists'}</span>` : ''}
          ${g.via === 'direct' && !g.possibleDupFee ? '<span class="mv-chip" style="background:#fbe9ea;color:#b3151b;font-weight:700">signed project — nobody staffed yet</span>' : ''}
          ${g.possibleDupFee ? `<span class="mv-chip" style="background:#fdf3d7;color:#8a6d00;font-weight:700" title="Two fee-tool records appear to describe this same work — check Projects Index and archive or merge the spare before staffing against it (its revenue may also double-count).">⚠ from fee record “${esc(g.possibleDupFee)}” — possible duplicate of the linked one</span>` : ''}
          ${g.rating ? `<span class="mv-chip" style="background:${g.rating <= 1 ? '#e7f0ee' : g.rating <= 4 ? '#eef1f3' : '#f5f4f1'};color:${g.rating <= 1 ? '#0E7C7B' : g.rating <= 4 ? '#4a5560' : '#8a8f98'};font-weight:700" title="Projection rating of the linked fee project. 1 = booked, 2-4 = weighted pipeline, 5-7 = low likelihood — a rating 5-7 naming someone is rarely a staffing decision.">rating ${g.rating}</span>` : ''}
          ${g.lead ? `<span class="mv-chip" style="background:#f4f2ef;color:#4a5560" title="Revenue leader on the linked fee project — who to ask whether this is real">${esc(g.lead)}</span>` : ''}
          <span class="note-txt">· ${esc(g.roles.join(', '))} · ${g.totalNeedFteMo} FTE-mo missing</span>
        </summary>
        <div style="padding:4px 4px 12px">
          ${g.via !== 'mapped' && g.via !== 'direct' ? '<div class="note-txt" style="color:#8a6d00;margin-bottom:6px">≈ this project’s fee link is auto-matched, not confirmed — verify it in Mapping before creating allocations from it.</div>' : ''}
          <table class="dt" style="max-width:520px"><thead><tr><th>Window</th><th class="num">Contract</th><th class="num">${g.open ? 'Covered (matching titles)' : 'Already staffed'}</th><th class="num">Will create</th></tr></thead><tbody>${g.segments.map(segRow).join('')}</tbody></table>
          <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span class="note-txt" style="font-weight:700">Assign to:</span>
            <input list="bridge-people" data-bridge-name="${i}" value="${g.open ? '' : esc(g.person ? g.person.name : g.resource)}" placeholder="${g.open ? 'Who takes this role? Type a name…' : 'Change to map onto someone else…'}" style="padding:8px 10px;border:1px solid rgba(37,39,58,0.3);font-size:13px;min-width:240px">
            <span class="note-txt" data-bridge-hint="${i}"></span>
          </div>
          ${!g.open && g.isNew ? `<div class="note-txt" style="margin-top:4px">Contract says “${esc(g.resource)}” — if that's a nickname or old spelling of someone already on the roster, type their roster name above and the mapping is saved for every future contract.</div>` : ''}
          <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-primary" style="padding:8px 16px;font-size:12px" data-bridge-apply="${i}">Confirm — create ${g.segments.length} allocation${g.segments.length === 1 ? '' : 's'}</button>
            <span class="note-txt">or</span>
            <input data-bridge-why="${esc(g.key)}" placeholder="Why not? e.g. pursuit died, never going to staff" style="padding:7px 10px;border:1px solid rgba(37,39,58,0.3);font-size:12px;min-width:250px">
            <button class="btn btn-ghost" style="padding:8px 14px;font-size:12px" data-bridge-dismiss="${esc(g.key)}" title="Take this off the list without creating anything. Recorded with your name and reason, and reopenable from the dismissed roll-up.">✕ Not staffing this</button>
          </div>
        </div>
      </details>`).join('')}
      ${dropped.length ? `<details style="margin-top:10px;border-top:1px solid rgba(37,39,58,0.12);padding-top:8px">
        <summary style="cursor:pointer;font-size:12px;color:var(--sav-steel)">${dropped.length} dismissed — not being staffed <span class="note-txt">· click to review or put back</span></summary>
        <table class="dt" style="margin-top:6px"><thead><tr><th>Who / role</th><th>Project</th><th>Reason</th><th>By</th><th></th></tr></thead><tbody>
        ${dropped.map(g => `<tr>
          <td>${g.open ? 'Open: ' + esc(g.roleTitle) : esc(g.resource)}</td>
          <td>${pLbl(g.project, g.client)}</td>
          <td class="note-txt">${esc((g.dismissed && g.dismissed.reason) || '—')}</td>
          <td class="note-txt">${esc((g.dismissed && g.dismissed.by) || '')}${g.dismissed && g.dismissed.at ? ' · ' + esc(String(g.dismissed.at).slice(0, 10)) : ''}</td>
          <td><button class="btn btn-ghost" style="padding:4px 10px;font-size:11px" data-bridge-restore="${esc(g.key)}">Put back</button></td>
        </tr>`).join('')}
        </tbody></table>
      </details>` : ''}
      </div>
    </details>`;
  }

  function wireBridge() {
    const root = $('#p-allocations');
    if (!root) return;
    // Roll-up state survives re-renders (every allocation edit re-renders the tab).
    const dr = $('#dup-roll'); if (dr) dr.ontoggle = () => { state.dupOpen = dr.open; };
    const roll = $('#bridge-roll');
    if (roll) roll.ontoggle = () => {
      state.bridgeOpen = roll.open;
      const c = $('#bridge-caret'); if (c) c.style.transform = roll.open ? 'rotate(90deg)' : '';
      const h = $('#bridge-roll-hint'); if (h) h.textContent = roll.open ? 'click to roll up' : 'click to review';
    };
    $$('#p-allocations [data-bridge-name]').forEach(inp => inp.oninput = () => {
      const hint = $(`#p-allocations [data-bridge-hint="${inp.dataset.bridgeName}"]`);
      if (!hint) return;
      const v = inp.value.trim();
      if (!v) { hint.textContent = ''; return; }
      const hit = S.listPeople().find(p => S.namesMatch(p.name, v));
      const pool = /\bpool/i.test(v);
      hint.innerHTML = hit
        ? `→ links to existing <b style="color:#0E7C7B">${esc(hit.name)}</b>${hit.isPool ? ' (shared pool)' : ''}`
        : `→ will create <b style="color:#8a6d00">NEW ${pool ? 'shared POOL — several people can bill toward it' : 'person'}</b>`;
    });
    $$('#p-allocations [data-bridge-apply]').forEach(b => b.onclick = () => {
      const i = +b.dataset.bridgeApply;
      const g = bridgeGapsCached()[i];
      if (!g) return;
      const inp = $(`#p-allocations [data-bridge-name="${i}"]`);
      let typed = inp ? inp.value.trim() : '';
      if (!typed) {
        if (g.open) { toast('Type a name for this open role first — nothing was created.'); if (inp) inp.focus(); return; }
        typed = g.resource;
      }
      const hit = S.listPeople().find(p => S.namesMatch(p.name, typed));
      const personId = hit ? hit.id : S.personIdForName(typed);
      const personName = hit ? hit.name : typed;
      g.segments.forEach(sg => {
        S.saveAllocation({
          personId, personName,
          feeId: g.feeId, project: g.project, client: g.client,
          status: 'Active', type: 'Awarded',
          start: sg.start, end: sg.end, pct: sg.need,
          // ties the row back to the contract slot/name it satisfies, so the
          // gap clears even when the assignee differs from the contract label
          contractRole: g.open ? g.roleTitle : undefined,
          contractResource: g.open ? undefined : g.resource,
          contract: { pct: sg.need, want: sg.want, have: sg.have, start: sg.start, end: sg.end },
          note: (g.open ? `Open contract role staffed`
            : (g.topUp ? `Contract top-up (matrix had ${sg.have}%, contract ${sg.want}%)` : `From contract staffing`)) + ` · ${g.roles.join(', ')}`,
        });
      });
      // Contract name ≠ roster name (nickname, spelling drift)? Remember the
      // mapping so every future contract naming them resolves automatically.
      if (!g.open && g.resource) {
        const per = S.getPerson(personId);
        if (per && !S.namesMatch(per.name, g.resource)) S.setPersonAlias(g.resource, personId);
      }
      toast(`Created ${g.segments.length} allocation${g.segments.length === 1 ? '' : 's'} for ${personName}`);
      renderCounts(); renderAllocations();
    });
    $$('#p-allocations [data-dup-edit]').forEach(b => b.onclick = () => openAllocModal(b.dataset.dupEdit));
    $$('#p-allocations [data-dup-trim]').forEach(b => b.onclick = () => {
      const a = S.listAllocations().find(x => x.id === b.dataset.dupTrim); if (!a) return;
      S.saveAllocation(Object.assign({}, a, { end: b.dataset.to }));
      state._gapsKey = null; toast(`Row now ends ${S.ymLabel(b.dataset.to)}.`); renderCounts(); renderAllocations();
    });
    $$('#p-allocations [data-dup-del]').forEach(b => b.onclick = () => {
      const id = b.dataset.dupDel;
      const all = S.listAllocations().find(a => a.id === id);
      if (!all) return;
      if (!confirm(`Delete this allocation?\n\n${all.personName || ''} · ${all.project}\n${S.ymLabel(all.start)}${all.end && all.end !== all.start ? ' – ' + S.ymLabel(all.end) : ''} at ${Math.round(parseFloat(all.pct) || 0)}%\n\nThe other row on this project stays.`)) return;
      S.deleteAllocation(id);
      toast('Allocation deleted.');
      renderCounts(); renderAllocations();
    });
    /* Dismiss — a recorded judgement, not a delete. The row leaves the working
       list and lands in the roll-up with who and why, reopenable any time. */
    $$('#p-allocations [data-bridge-dismiss]').forEach(b => b.onclick = () => {
      const key = b.dataset.bridgeDismiss;
      const why = $(`#p-allocations [data-bridge-why="${CSS.escape(key)}"]`);
      const reason = why ? why.value.trim() : '';
      S.dismissGap(key, reason);
      state._gapsKey = null;                       // force a rebuild of the cache
      toast('Taken off the list. Reopen it any time from “dismissed” at the foot of this card.');
      renderCounts(); renderAllocations();
    });
    $$('#p-allocations [data-bridge-restore]').forEach(b => b.onclick = () => {
      S.restoreGap(b.dataset.bridgeRestore);
      state._gapsKey = null;
      toast('Back on the list.');
      renderCounts(); renderAllocations();
    });
    // Inline top-up chips — the same confirm-gated create, anchored on the
    // person's existing allocation row instead of the card.
    $$('#p-allocations [data-inline-topup]').forEach(el => el.onclick = (e) => {
      e.preventDefault();
      const g = bridgeGapsCached()[+el.dataset.inlineTopup];
      if (!g) return;
      const segs = g.segments.map(sg => `  +${sg.need}%  ${S.ymLabel(sg.start)} – ${S.ymLabel(sg.end)}  (contract ${sg.want}%, currently ${sg.have}%)`).join('\n');
      if (!confirm(`The contract staffs ${g.resource} on ${g.project} beyond the current allocation:\n\n${segs}\n\nAdd the difference as ${g.segments.length === 1 ? 'a new allocation row' : g.segments.length + ' new allocation rows'}?`)) return;
      g.segments.forEach(sg => {
        S.saveAllocation({
          personId: g.personId, personName: g.resource,
          feeId: g.feeId, project: g.project, client: g.client,
          status: 'Active', type: 'Awarded',
          start: sg.start, end: sg.end, pct: sg.need,
          contractResource: g.resource,
          contract: { pct: sg.need, want: sg.want, have: sg.have, start: sg.start, end: sg.end },
          note: `Contract top-up (matrix had ${sg.have}%, contract ${sg.want}%) · ${g.roles.join(', ')}`,
        });
      });
      toast(`Added ${g.segments.length} allocation${g.segments.length === 1 ? '' : 's'} for ${g.resource}`);
      renderCounts(); renderAllocations();
    });
  }

  /* Leaves-of-absence panel: who's out, until when, and the 1–2 month
     return heads-up. Leaves are ordinary allocations to the special
     "Leaves of Absence" project — this just surfaces their timing. */
  function leaveSectionHtml() {
    const rows = S.leaveStatus().filter(l => l.status !== 'past');
    const chip = (l) => {
      const who = esc(l.person.name);
      if (l.status === 'out') {
        const back = `returns ${esc(S.ymLabel(S.ymAdd(l.end, 1)))}`;
        return l.returningSoon
          ? `<span class="mv-chip" style="background:#fdf3d7;color:#8a6d00;font-weight:700" title="Back within ~${l.monthsToReturn} month${l.monthsToReturn === 1 ? '' : 's'} — line up their next assignment now"><b>${who}</b> · 🔔 ${back} — plan their staffing</span>`
          : `<span class="mv-chip" style="background:#efe6f7;color:#6b3fa0"><b>${who}</b> · out until ${esc(S.ymLabel(l.end))}</span>`;
      }
      return `<span class="mv-chip" style="background:#efe6f7;color:#6b3fa0"><b>${who}</b> · leave starts ${esc(S.ymLabel(l.start))}${l.startingSoon ? ' — reassign their book' : ''}</span>`;
    };
    const body = rows.length
      ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${rows.map(chip).join('')}</div>`
      : `<span class="note-txt">No one is on or headed into a leave. </span>`;
    return `<div style="background:#fff;border:1px solid rgba(37,39,58,0.12);border-left:4px solid #6b3fa0;padding:12px 16px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:${rows.length ? '8px' : '0'}">
        <span style="font-family:var(--font-display);font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:#6b3fa0">🌴 Leaves of absence</span>
        <span class="grow"></span>
        <button class="btn btn-ghost" id="leave-add" style="padding:4px 10px;font-size:11.5px" title="A leave is an allocation to the special &quot;Leaves of Absence&quot; project at 100% — it blocks the person's capacity for the window">+ Log a leave</button>
      </div>
      ${body}
    </div>`;
  }

  function renderAllocations() {
    let list = S.listAllocations().filter(a => S.inView(a.personId));
    const q = state.allocSearch.toLowerCase();
    if (q) list = list.filter(a => (a.project + ' ' + a.client + ' ' + (S.getPerson(a.personId) || {}).name + ' ' + a.note).toLowerCase().includes(q));
    if (state.allocStatus) list = list.filter(a => a.status === state.allocStatus);
    if (state.allocProject) list = list.filter(a => a.project === state.allocProject);
    const pname = (a) => (S.getPerson(a.personId) || {}).name || a.personName || '';
    const SORTERS = {
      client: (a, b) => (a.client || '').localeCompare(b.client || ''),
      project: (a, b) => (a.project || '').localeCompare(b.project || ''),
      person: (a, b) => pname(a).localeCompare(pname(b)),
      status: (a, b) => (a.status || '').localeCompare(b.status || '') || (a.type || '').localeCompare(b.type || ''),
      window: (a, b) => String(a.start || '').localeCompare(String(b.start || '')) || String(a.end || '9999').localeCompare(String(b.end || '9999')),
      pct: (a, b) => (parseFloat(a.pct) || 0) - (parseFloat(b.pct) || 0),
      note: (a, b) => (a.note || '').localeCompare(b.note || ''),
    };
    const srt = SORTERS[state.allocSort.key] || SORTERS.project;
    list.sort((a, b) => (srt(a, b) * state.allocSort.dir) || SORTERS.project(a, b) || SORTERS.person(a, b) || SORTERS.window(a, b));
    const th = (key, label, cls) => `<th class="${cls || ''} sort-th ${state.allocSort.key === key ? 'on' : ''}" data-sort="${key}" title="Sort by ${label.toLowerCase()}${state.allocSort.key === key ? (state.allocSort.dir === 1 ? ' · ascending — click to flip' : ' · descending — click to flip') : ''}">${label}${state.allocSort.key === key ? `<span class="sort-arrow">${state.allocSort.dir === 1 ? '▲' : '▼'}</span>` : ''}</th>`;

    const projOpts = ['<option value="">All projects</option>'].concat(S.distinctProjects().map(p => `<option ${state.allocProject === p ? 'selected' : ''}>${esc(p)}</option>`)).join('');
    const toolbar = `<div class="toolbar">
      <input type="search" id="al-search" placeholder="Filter person, project, client, note…" value="${esc(state.allocSearch)}">
      <select id="al-status"><option value="">All statuses</option><option ${state.allocStatus === 'Active' ? 'selected' : ''}>Active</option><option ${state.allocStatus === 'Pursuit' ? 'selected' : ''}>Pursuit</option></select>
      <select id="al-project">${projOpts}</select>
      <span class="grow"></span>
      <span class="note-txt">Excel round trip &amp; sheet re-import live in <a href="#" data-goto-tab="sources" style="font-weight:700">Data Sources</a></span>
      <button class="btn btn-primary" id="al-add">+ Add allocation</button>
    </div>`;

    let body = '';
    const inlineIdx = inlineTopUpIndex();
    const chipShown = new Set();   // one chip per person×project, on their first row
    list.forEach(a => {
      const person = S.getPerson(a.personId) || { name: a.personId };
      const isP = isPursuitAlloc(a);
      const isLeave = S.isLeaveProject(a.project);
      let chip = '';
      const gi = inlineIdx[a.personId + '|' + a.project];
      if (gi !== undefined && !chipShown.has(gi)) {
        chipShown.add(gi);
        const g = bridgeGapsCached()[gi];
        const sg0 = g.segments[0];
        const label = g.segments.length === 1
          ? `+${sg0.need}% ${S.ymLabel(sg0.start)}${sg0.start !== sg0.end ? '–' + S.ymLabel(sg0.end) : ''}`
          : `+${g.totalNeedFteMo} FTE-mo across ${g.segments.length} windows`;
        chip = ` <a href="#" class="mv-chip" data-inline-topup="${gi}" style="background:#fdf3d7;color:#8a6d00;font-weight:700;text-decoration:none;white-space:nowrap" title="The contract staffs ${esc(g.resource)} beyond what's allocated here — click to add the difference as its own row">⚠ contract ${label} — add?</a>`;
      }
      body += `<tr class="${isP ? 'pursuit-row' : ''}"${isLeave ? ' style="background:#faf7fd"' : ''}>
        <td>${esc(a.client || '—')}</td>
        <td class="pname">${pLbl(a.project, a.client)}</td>
        <td>${esc(person.name)}${person.isNewHire ? ' <span class="nh-tag">NH</span>' : ''}${person.isPool ? ' <span class="nh-tag" style="background:#dff0ee;color:#0E7C7B" title="Shared contract pool — several people can bill toward this line">POOL</span>' : ''}</td>
        <td>${isLeave ? '<span class="badge" style="background:#efe6f7;color:#6b3fa0">🌴 Leave</span>' : `<span class="badge ${isP ? 'pursuit' : 'active'}">${esc(a.status)}${a.type === 'Opportunity' ? ' · opp' : ''}</span>`}</td>
        <td>${esc(a.start ? S.ymLabel(a.start) : '—')} – ${esc(a.end ? S.ymLabel(a.end) : '—')}${isLeave && a.end ? ` <span class="vmini" style="color:#6b3fa0">back ${esc(S.ymLabel(S.ymAdd(a.end, 1)))}</span>` : ''}</td>
        <td class="num">${a.pct}%</td>
        <td class="vmini">${contractTag(a)}${a.note ? (contractTag(a) ? ' ' : '') + esc(a.note) : ''}${chip}</td>
        <td><span class="row-act"><button data-edit="${a.id}">Edit</button><button class="del" data-del="${a.id}">Del</button></span></td>
      </tr>`;
    });
    const table = list.length ? `<table class="dt"><thead><tr>${th('client', 'Client')}${th('project', 'Project')}${th('person', 'Person')}${th('status', 'Status')}${th('window', 'Window')}${th('pct', 'Alloc', 'num')}${th('note', 'Note / decision')}<th></th></tr></thead><tbody>${body}</tbody></table>`
      : `<div class="empty">No allocations match. <a href="#" id="al-clear">Clear filters</a></div>`;
    $('#p-allocations').innerHTML = legacySectionHtml() + dupAllocSectionHtml() + bridgeSectionHtml() + leaveSectionHtml() + toolbar + table;
    wireBridge(); wireLegacy('#p-allocations', renderAll);
    const la = $('#leave-add');
    if (la) la.onclick = () => openAllocModal(null, { title: 'Log a leave of absence', project: 'Leaves of Absence', client: 'Internal', pct: 100, note: 'Leave of absence' });

    $('#al-search').oninput = searchBox('#al-search', v => { state.allocSearch = v; renderAllocations(); });
    $('#al-status').onchange = (e) => { state.allocStatus = e.target.value; renderAllocations(); };
    $('#al-project').onchange = (e) => { state.allocProject = e.target.value; renderAllocations(); };
    $('#al-add').onclick = () => openAllocModal(null);
    wireGoto('#p-allocations');
    const clr = $('#al-clear'); if (clr) clr.onclick = (e) => { e.preventDefault(); state.allocSearch = state.allocStatus = state.allocProject = ''; renderAllocations(); };
    $$('#p-allocations [data-sort]').forEach(h => h.onclick = () => { const k = h.dataset.sort; if (state.allocSort.key === k) state.allocSort.dir = -state.allocSort.dir; else state.allocSort = { key: k, dir: 1 }; renderAllocations(); });
    $$('#p-allocations [data-edit]').forEach(b => b.onclick = () => openAllocModal(b.dataset.edit));
    $$('#p-allocations [data-del]').forEach(b => b.onclick = () => { const a = S.listAllocations().find(x => x.id === b.dataset.del); if (a && confirm(`Remove ${(S.getPerson(a.personId) || {}).name}'s planned allocation on ${a.project}?\n\nOnly the plan goes — their logged Clockify hours stay.`)) { S.deleteAllocation(b.dataset.del); renderAll(); } });
  }

  /* ---------- BY PROJECT ---------- */
  /* ---------- SHARED: what the By Project / By Person cells show ----------
     Projected = the allocations (the plan). Actual = Clockify hours, read
     as FTE (By Project) or % of the person's capacity (By Person). Variance
     = actual − projected, so a positive number is more time than planned.
     Months Clockify has not covered are hatched, never zero. */
  function gridMetric() { return S.hasActuals() ? (state.gridMetric || 'plan') : 'plan'; }
  function actualsIndex(ms) {
    // months Clockify can speak for: pulled, and not in the future (a pulled range often runs past today)
    const nowYm = S.currentYM(); const byProj = {}, byPerson = {}, byPP = {}; const covered = new Set((S.actualsMeta().months || []).filter(m => m <= nowYm));
    if (S.hasActuals()) S.varianceMatrix(ms, {}).forEach(r => {
      ms.forEach(m => { const a = r.byMonth[m] ? r.byMonth[m].a : 0; if (!a) return;
        (byProj[r.project] = byProj[r.project] || {})[m] = (byProj[r.project][m] || 0) + a;
        (byPerson[r.person.id] = byPerson[r.person.id] || {})[m] = (byPerson[r.person.id][m] || 0) + a;
        const pp = byPP[r.person.id] = byPP[r.person.id] || {}; (pp[r.project] = pp[r.project] || { client: r.client || '', m: {} }).m[m] = ((pp[r.project].m[m]) || 0) + a; });
    });
    // the current month is judged against the part of the plan that has elapsed
    const ex = S.currentMonthExpectation ? S.currentMonthExpectation(new Date()) : { frac: 1, early: false };
    if (ex.early) covered.delete(nowYm);                       // too early in the month to judge
    const planFrac = (m) => m === nowYm ? ex.frac : 1;
    return { byProj, byPerson, byPP, covered, nowYm, planFrac };
  }
  function metricToggle(tabId) {
    const m = gridMetric(); const has = S.hasActuals();
    const btn = (key, label, tip) => `<button type="button" class="seg-btn ${m === key ? 'active' : ''}" data-metric="${key}" ${!has && key !== 'plan' ? 'disabled title="Pull Clockify hours in Data Sources first"' : `title="${tip}"`}>${label}</button>`;
    return `<div class="seg-toggle" role="group" aria-label="What the cells show">${btn('plan', 'Projected · allocations', 'The staffing plan — allocation % by month')}${btn('actual', 'Actual · Clockify', 'Hours actually logged in Clockify')}${btn('var', 'Variance · actual − projected', 'More time than planned reads positive')}</div>`;
  }
  function wireMetric(tabId, rerender) { $$(`${tabId} [data-metric]`).forEach(b => b.onclick = () => { if (b.disabled) return; state.gridMetric = b.dataset.metric; rerender(); }); }
  const vCls = (v, base) => { if (v == null) return 'nodata'; const ref = Math.max(Math.abs(base || 0), 1e-6); if (!v && !base) return 'v0'; if (Math.abs(v) <= 0.1 * ref) return 'vok'; if (v > 0) return v > 0.5 * ref ? 'vover2' : 'vover'; return 'vunder'; };
  const fmtSigned = (v, d) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d);

  function renderProjects() {
    const ms = months();
    const metric = gridMetric();
    const AX = actualsIndex(ms); const MH = S.monthHours();
    let rows = S.projectRollup(ms, { includePursuit: state.incPursuit });
    // Actual / variance views also show projects that have hours but no plan
    if (metric !== 'plan') {
      const have = new Set(rows.map(r => r.project));
      Object.keys(AX.byProj).forEach(pn => { if (have.has(pn) || S.isLeaveProject(pn)) return; const ppl = Object.keys(AX.byPP).filter(pid => AX.byPP[pid][pn]); const client = (ppl.length && AX.byPP[ppl[0]][pn].client) || ''; rows.push({ project: pn, client, headcount: ppl.length, peakFte: 0, byMonth: {}, allocs: [], feeProject: (S.projectLabel(pn, client).fee[0] || null), noPlan: true }); });
      rows.sort((a, b) => a.project.localeCompare(b.project));
    }
    const q = state.projSearch.toLowerCase();
    if (q) rows = rows.filter(r => (r.project + ' ' + r.client + ' ' + S.projectLabel(r.project, r.client).name).toLowerCase().includes(q));
    if (state.projClient) rows = rows.filter(r => r.client === state.projClient);
    // the number each cell shows, per project per month — FTE in every mode
    const cellVal = (r, m) => {
      const plan = r.byMonth[m] || 0;
      if (metric === 'plan') return plan;
      if (!AX.covered.has(m)) return null;
      const act = ((AX.byProj[r.project] || {})[m] || 0) / MH;
      return metric === 'actual' ? act : act - plan * AX.planFrac(m);
    };
    rows.forEach(r => { r.vals = {}; let pk = 0; ms.forEach(m => { const v = cellVal(r, m); r.vals[m] = v; if (v != null && Math.abs(v) > Math.abs(pk)) pk = v; }); r.peakShown = pk; });
    const feeOpts = S.listFeeProjects().map(p => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
    const intOpts = S.INTERNAL_ORDER.map(k => `<option value="int:${k}">${esc(S.INTERNAL_LINES[k].label)}</option>`).join('');
    const unassignedByProj = {};
    S.unassignedRoles(ms).forEach(u => { (unassignedByProj[u.project] = unassignedByProj[u.project] || []).push(u); });

    const unCount = Object.keys(unassignedByProj).length;
    const linked = rows.filter(r => r.feeProject).length;
    const avgPeak = rows.length ? rows.reduce((s, r) => s + Math.abs(r.peakShown), 0) / rows.length : 0;
    const peakLbl = metric === 'plan' ? 'Avg peak FTE · projected' : metric === 'actual' ? 'Avg peak FTE · actual (Clockify)' : 'Avg peak |variance| · FTE';
    const kpis = `<div class="kpi-strip">
      <div class="kpi-card"><div class="k-num">${rows.length}</div><div class="k-lbl">Projects in view${metric !== 'plan' ? ' · incl. hours with no plan' : ''}</div></div>
      <div class="kpi-card"><div class="k-num">${linked}</div><div class="k-lbl">Linked to fee tool</div></div>
      <div class="kpi-card ${unCount ? 'warn' : ''}"><div class="k-num">${unCount}</div><div class="k-lbl">With unassigned contract roles</div></div>
      <div class="kpi-card accent"><div class="k-num">${avgPeak.toFixed(2)}</div><div class="k-lbl">${peakLbl}</div></div>
    </div>`;

    const clientOpts = ['<option value="">All clients</option>'].concat(S.distinctClients().map(c => `<option ${state.projClient === c ? 'selected' : ''}>${esc(c)}</option>`)).join('');
    const allProjExpanded = rows.length > 0 && rows.every(r => state.expandedProjects.has(r.project));
    const explain = metric === 'plan' ? 'Cells are <b>projected FTE</b> from the allocations (Σ allocation % ÷ 100).' : metric === 'actual' ? 'Cells are <b>actual FTE</b> from Clockify (hours ÷ ' + MH + ' h). Hatched = no Clockify data for that month.' : 'Cells are <b>actual − projected</b> in FTE. <span class="var-over">+</span> more time than planned, <span class="var-under">−</span> less. The current month is judged month-to-date. Hatched = no Clockify data yet.';
    const toolbar = `<div class="toolbar">${metricToggle('#p-projects')}<input type="search" id="pj-search" placeholder="Filter project or client…" value="${esc(state.projSearch)}"><select id="pj-client">${clientOpts}</select><button class="btn btn-ghost" id="pj-expand-toggle">${allProjExpanded ? '▾ Collapse all' : '▸ Expand all'}</button><span class="grow"></span><span class="note-txt">${rows.length} projects · ${linked} linked to the fee tool</span></div>
      <div class="note-txt" style="margin:-6px 0 10px">${explain}</div>`;

    const nowYm = S.currentYM();
    const unitHead = metric === 'plan' ? 'Projected FTE' : metric === 'actual' ? 'Actual FTE' : 'Variance FTE';
    let head = `<tr><th class="who">Project <span class="vmini" style="text-transform:none;letter-spacing:0;font-weight:400">· ${unitHead}</span></th>` + ms.map(m => `<th${m < nowYm ? ' style="opacity:.6"' : ''}>${esc(S.ymLabel(m))}</th>`).join('') + `<th>Headcount</th><th class="pk">${metric === 'var' ? 'Largest gap' : 'Peak FTE'}</th></tr>`;
    let body = '';
    const fmtCell = (v) => v == null ? '·' : (metric === 'var' ? (v ? fmtSigned(v, 2) : '·') : (v ? v.toFixed(2) : '·'));
    rows.forEach(r => {
      const L = S.projectLabel(r.project, r.client);
      // Every planned row sits on a fee project or an internal line. The two
      // exceptions are fixable right here: hours from a Clockify project no
      // fee project claims, and rows still under an old matrix name.
      const link = r.feeProject
        ? `<a class="link-fee" href="Universal Fee Calculator.html?id=${encodeURIComponent(r.feeProject.id)}" title="Open in fee tool">fee ↗</a>`
        : L.internal ? `<span class="badge" style="background:#e7eef0;color:#4a5560" title="Internal line — no fee project, by design">internal</span>`
        : L.unmapped ? `<select class="fee-link-sel" data-ck-map="${esc(r.project)}" title="A Clockify project with hours and no fee project — pick where its hours belong"><option value="">Clockify project · map to…</option>${feeOpts}${intOpts}<option value="__ignore__">— ignore these hours —</option></select>`
        : `<select class="fee-link-sel" data-legacy-move="${esc(r.project)}" title="Rows under an old matrix name — move them onto the fee project they staff"><option value="">needs a project · move to…</option>${feeOpts}${intOpts}</select>`;
      const un = unassignedByProj[r.project];
      const unBadge = un ? ` <span class="badge" style="color:#8f2418;background:#fbe9e7" title="${esc(un.map(u => u.role + ' — ' + fmtH(u.hours) + 'h unstaffed').join(' · '))}">⚠ ${un.length} unassigned</span>` : '';
      const noPlanBadge = r.noPlan ? ' <span class="badge" style="color:#8a6d00;background:#fdf3d7" title="Clockify hours exist for this project but nothing is allocated">hours, no plan</span>' : '';
      const peak = Math.max(1e-6, Math.abs(r.peakShown));
      body += `<tr><td class="who"><div class="who-name" data-exp="${esc(r.project)}">${esc(L.name)}</div><div class="who-meta">${esc(r.client || L.client || '—')} ${link}${unBadge}${noPlanBadge}</div></td>`;
      ms.forEach(m => {
        const v = r.vals[m]; const plan = r.byMonth[m] || 0;
        const hasPursuit = metric === 'plan' && r.allocs.some(a => isPursuitAlloc(a) && S.allocActiveIn(a, m));
        const cls = metric === 'var' ? vCls(v, plan) : (v == null ? 'nodata' : uCls(Math.round(Math.abs(v) / peak * 100)));
        const tip = v == null ? (m === AX.nowYm ? 'Too early in the month to judge' : 'No Clockify data for this month') : metric === 'plan' ? `${v.toFixed(2)} FTE projected` : metric === 'actual' ? `${v.toFixed(2)} FTE actual · projected ${plan.toFixed(2)}` : `${fmtSigned(v, 2)} FTE vs a projected ${(plan * AX.planFrac(m)).toFixed(2)}${m === AX.nowYm ? ' (month to date)' : ''}`;
        body += `<td><span class="cell ${cls} ${hasPursuit ? 'has-pursuit' : ''} ${m < nowYm ? 'past' : ''}" title="${tip}${hasPursuit ? ' · includes pursuit hours' : ''}">${fmtCell(v)}</span></td>`;
      });
      body += `<td>${r.headcount}</td><td class="pk">${metric === 'var' ? fmtSigned(r.peakShown, 2) : r.peakShown.toFixed(2)}</td></tr>`;
      if (state.expandedProjects.has(r.project)) {
        let pr = '';
        if (metric === 'plan') {
          r.allocs.slice().sort((a, b) => b.pct - a.pct).forEach(a => {
            const person = S.getPerson(a.personId) || { name: a.personId };
            const isP = isPursuitAlloc(a);
            const stat = isP ? ' <span class="status-p">pursuit</span>' : '';
            const note = a.note ? ` <span class="vmini" title="${esc(a.note)}">— ${esc(a.note.length > 40 ? a.note.slice(0, 40) + '…' : a.note)}</span>` : '';
            pr += `<tr class="drawer-tr alloc-row ${isP ? 'pursuit-row' : ''}" data-edit-alloc="${esc(a.id)}" title="Click to edit this allocation"><td class="who dproj">${esc(person.name)}${person.isNewHire ? ' <span class="nh-tag">NH</span>' : ''}${stat}${contractTag(a)}${note}</td>${ms.map(m => `<td class="dcell">${S.allocActiveIn(a, m) ? a.pct + '%' : '·'}</td>`).join('')}<td class="dcell dacts" colspan="2">${drawerActs(a)}</td></tr>`;
          });
        } else {
          // one row per person who is planned OR logged time here
          const pids = new Set(r.allocs.map(a => a.personId)); Object.keys(AX.byPP).forEach(pid => { if (AX.byPP[pid][r.project]) pids.add(pid); });
          const prow = [...pids].map(pid => { const person = S.getPerson(pid) || { name: pid }; const planM = {}, actM = {}; ms.forEach(m => { planM[m] = r.allocs.filter(a => a.personId === pid && S.allocActiveIn(a, m)).reduce((t, a) => t + (parseFloat(a.pct) || 0) / 100, 0) * AX.planFrac(m); actM[m] = (((AX.byPP[pid] || {})[r.project] || { m: {} }).m[m] || 0) / MH; }); return { pid, person, planM, actM, tot: ms.reduce((t, m) => t + actM[m], 0) }; }).sort((a, b) => b.tot - a.tot);
          prow.forEach(x => {
            const alloc = r.allocs.find(a => a.personId === x.pid);
            const cells = ms.map(m => { if (!AX.covered.has(m)) return '<td class="dcell" style="color:#c9cdd3">·</td>'; const v = metric === 'actual' ? x.actM[m] : x.actM[m] - x.planM[m]; const txt = metric === 'actual' ? (v ? v.toFixed(2) : '·') : (v ? fmtSigned(v, 2) : '·'); const col = metric === 'var' && v ? (v > 0.1 * Math.max(x.planM[m], 0.05) ? 'color:#7a5600' : v < -0.1 * Math.max(x.planM[m], 0.05) ? 'color:#4a5560' : '') : ''; return `<td class="dcell" style="${col}" title="${metric === 'actual' ? `${x.actM[m].toFixed(2)} FTE actual · ${x.planM[m].toFixed(2)} projected` : `${fmtSigned(v, 2)} vs ${x.planM[m].toFixed(2)} projected`}">${txt}</td>`; }).join('');
            pr += `<tr class="drawer-tr ${alloc ? 'alloc-row' : ''}" ${alloc ? `data-edit-alloc="${esc(alloc.id)}" title="Click to edit this person's allocation"` : 'title="Logged time, no allocation"'}><td class="who dproj">${esc(x.person.name)}${alloc ? '' : ' <span class="nh-tag" style="background:#fdf3d7;color:#8a6d00">no plan</span>'}</td>${cells}<td class="dcell dacts" colspan="2">${alloc ? drawerActs(alloc) : ''}</td></tr>`;
          });
        }
        if (!pr) pr = `<tr class="drawer-tr"><td class="who dproj"><em class="note-txt">No allocations in this window.</em></td>${ms.map(() => '<td class="dcell">·</td>').join('')}<td class="dcell"></td><td class="dcell"></td></tr>`;
        pr += drawerAddRow(ms, { project: r.project, client: r.client || '' }, '+ Add someone to this project');
        body += pr;
      }
    });
    const table = rows.length ? `<div class="hm-wrap"><table class="hm"><thead>${head}</thead><tbody>${body}</tbody></table></div>` : `<div class="empty">No projects match.</div>`;
    const legend = metric === 'var'
      ? `<div class="legend"><span><span class="sw" style="background:#cfe6e4"></span>within ±10% of plan</span><span><span class="sw" style="background:#fce7c2"></span>more than planned</span><span><span class="sw" style="background:#f6c9c2"></span>far more (&gt;50% over)</span><span><span class="sw" style="background:#eef4f4"></span>less than planned</span><span><span class="sw nodata" style="background:repeating-linear-gradient(45deg,#f7f6f3 0 4px,#fff 4px 8px)"></span>no Clockify data</span><span style="margin-left:auto">Click a project for who; edit, delete or add rows right in the drawer.</span></div>`
      : `<div class="legend"><span>Cell shade = that month relative to the project's own peak.</span>${metric === 'plan' ? '<span><span class="sw sw-stripe"></span>includes pursuit hours — not yet signed</span>' : '<span><span class="sw" style="background:repeating-linear-gradient(45deg,#f7f6f3 0 4px,#fff 4px 8px)"></span>no Clockify data</span>'}<span style="margin-left:auto">Click a project for its staffing; edit, delete or add rows right in the drawer.</span></div>`;
    $('#p-projects').innerHTML = kpis + toolbar + table + legend;
    wireMetric('#p-projects', renderProjects);
    $('#pj-search').oninput = searchBox('#pj-search', v => { state.projSearch = v; renderProjects(); });
    const pjc = $('#pj-client'); if (pjc) pjc.onchange = (e) => { state.projClient = e.target.value; renderProjects(); };
    $('#pj-expand-toggle').onclick = () => {
      if (allProjExpanded) state.expandedProjects.clear();
      else rows.forEach(r => state.expandedProjects.add(r.project));
      renderProjects();
    };
    $$('#p-projects .who-name').forEach(el => el.onclick = () => { const p = el.dataset.exp; if (state.expandedProjects.has(p)) state.expandedProjects.delete(p); else state.expandedProjects.add(p); renderProjects(); });
    $$('#p-projects [data-ck-map]').forEach(sel => sel.onchange = () => { if (!sel.value) return; try { S.setProjectMapping(sel.dataset.ckMap, sel.value); toast('Mapped — saved for everyone; the hours land there now.'); } catch (e) { toast(e.message || String(e)); } renderAll(); });
    $$('#p-projects [data-legacy-move]').forEach(sel => sel.onchange = () => { if (!sel.value) return; try { const r = S.placeName(sel.dataset.legacyMove, sel.value); state._gapsKey = null; toast(`Moved ${r.rows} allocation${r.rows === 1 ? '' : 's'} onto ${r.label}.`); } catch (e) { toast(e.message || String(e)); } renderAll(); });
    $$('#p-projects [data-edit-alloc]').forEach(tr => tr.onclick = () => openAllocModal(tr.dataset.editAlloc));
    wireDrawerActs('#p-projects');
  }

  /* ---------- BY PERSON ---------- */
  /* Mirror of By Project: one row per person with headcount-equivalent
     (concurrent project count), peak/avg load and a load sparkline, drawer
     expands to their project mix plus a Gantt-style timeline of each
     allocation's start/end so you can see people transfer project → project. */
  function renderPeople() {
    const ms = months();
    const metric = gridMetric();
    const AX = actualsIndex(ms);
    let rows = S.bandwidthGrid(ms, { includePursuit: state.incPursuit }).filter(r => r.activeMonths > 0 || (metric !== 'plan' && AX.byPerson[r.person.id]));
    const q = state.pplSearch.toLowerCase();
    if (q) rows = rows.filter(r => r.person.name.toLowerCase().includes(q));
    rows.sort((a, b) => a.person.name.localeCompare(b.person.name));
    if (!state.pplExpandInit) { rows.forEach(r => state.expandedRoster.add(r.person.id)); state.pplExpandInit = true; }
    // the number each cell shows — % of the person's own capacity in every mode
    const capOf = (p) => Math.max(S.capacityHours(p), 1e-6);
    const cellVal = (r, m) => {
      const plan = r.byMonth[m] || 0;
      if (metric === 'plan') return plan;
      if (!AX.covered.has(m)) return null;
      const act = ((AX.byPerson[r.person.id] || {})[m] || 0) / capOf(r.person) * 100;
      return metric === 'actual' ? act : act - plan * AX.planFrac(m);
    };
    rows.forEach(r => { r.vals = {}; let pk = 0, sum = 0, n = 0; ms.forEach(m => { const v = cellVal(r, m); r.vals[m] = v; if (v != null) { if (Math.abs(v) > Math.abs(pk)) pk = v; if (v) { sum += v; n++; } } }); r.peakShown = pk; r.avgShown = n ? sum / n : 0; });
    const over = rows.filter(r => metric === 'var' ? r.peakShown > 10 : r.peakShown > 100).length;
    const nh = rows.filter(r => r.person.isNewHire).length;
    const avgLoad = rows.length ? rows.reduce((s, r) => s + r.avgShown, 0) / rows.length : 0;
    const overLbl = metric === 'plan' ? 'Over-allocated (peak &gt; 100%)' : metric === 'actual' ? 'Logged over capacity (peak &gt; 100%)' : 'Logged well over plan (&gt; +10 pts)';
    const avgLbl = metric === 'plan' ? 'Avg projected load, active months' : metric === 'actual' ? 'Avg actual load, months with hours' : 'Avg variance, actual − projected';
    const kpis = `<div class="kpi-strip">
      <div class="kpi-card"><div class="k-num">${rows.length}</div><div class="k-lbl">People in view</div></div>
      <div class="kpi-card ${over ? 'warn' : ''}"><div class="k-num">${over}</div><div class="k-lbl">${overLbl}</div></div>
      <div class="kpi-card accent"><div class="k-num">${metric === 'var' ? fmtSigned(Math.round(avgLoad), 0) : Math.round(avgLoad)}%</div><div class="k-lbl">${avgLbl}</div></div>
      <div class="kpi-card"><div class="k-num">${nh}</div><div class="k-lbl">Planned new hires in view</div></div>
    </div>`;

    const allExpanded = rows.length > 0 && rows.every(r => state.expandedRoster.has(r.person.id));
    const explain = metric === 'plan' ? 'Cells are <b>projected load</b> — allocation % summed across projects.' : metric === 'actual' ? 'Cells are <b>actual load</b> — Clockify hours as a % of the person\'s own capacity (part-timers against their percentage). Hatched = no Clockify data for that month.' : 'Cells are <b>actual − projected</b>, in points of capacity. <span class="var-over">+</span> more time than planned, <span class="var-under">−</span> less. The current month is judged month-to-date. Hatched = no Clockify data yet.';
    const toolbar = `<div class="toolbar">${metricToggle('#p-people')}<input type="search" id="ppl-search" placeholder="Filter person…" value="${esc(state.pplSearch)}"><button class="btn btn-ghost" id="ppl-expand-toggle">${allExpanded ? '▾ Collapse all' : '▸ Expand all'}</button><span class="grow"></span><span class="note-txt">${rows.length} people ${metric === 'plan' ? 'active' : 'with plan or hours'} in this window</span></div>
      <div class="note-txt" style="margin:-6px 0 10px">${explain}</div>`;

    const nowYm = S.currentYM();
    const leaveByPerson = {};
    S.leaveStatus().forEach(l => { if (l.status !== 'past' && !leaveByPerson[l.person.id]) leaveByPerson[l.person.id] = l; });
    const unitHead = metric === 'plan' ? 'Projected load %' : metric === 'actual' ? 'Actual load %' : 'Variance, pts';
    let head = `<tr><th class="who">Person <span class="vmini" style="text-transform:none;letter-spacing:0;font-weight:400">· ${unitHead}</span></th>` + ms.map(m => `<th${m < nowYm ? ' style="opacity:.6"' : ''}>${esc(S.ymLabel(m))}</th>`).join('') + `<th>Projects</th><th class="pk">${metric === 'var' ? 'Largest gap' : 'Peak'}</th></tr>`;
    let body = '';
    const fmtCell = (v) => v == null ? '·' : (metric === 'var' ? (Math.round(v) ? fmtSigned(Math.round(v), 0) : '·') : (Math.round(v) ? Math.round(v) : '·'));
    rows.forEach(r => {
      const allocs = S.listAllocations().filter(a => a.personId === r.person.id && (state.incPursuit || (a.status !== 'Pursuit' && a.type !== 'Opportunity')));
      const inWin = allocs.filter(a => ms.some(m => S.allocActiveIn(a, m)));
      const projSet = new Set(inWin.map(a => a.project)); if (metric !== 'plan') Object.keys(AX.byPP[r.person.id] || {}).forEach(pn => projSet.add(pn));
      const projectCount = projSet.size;
      const lv = leaveByPerson[r.person.id];
      const lvTag = lv ? `<span class="nh-tag" style="background:${lv.returningSoon ? '#fdf3d7' : '#efe6f7'};color:${lv.returningSoon ? '#8a6d00' : '#6b3fa0'}" title="${lv.status === 'out' ? `On leave — back ${esc(S.ymLabel(S.ymAdd(lv.end, 1)))}${lv.returningSoon ? ' (soon — plan their staffing)' : ''}` : `Leave starts ${esc(S.ymLabel(lv.start))}`}">🌴 ${lv.status === 'out' ? `until ${esc(S.ymLabel(lv.end))}` : `from ${esc(S.ymLabel(lv.start))}`}</span>` : '';
      const empTag = r.person.nonBillable ? '<span class="nh-tag" style="background:#e7eef0;color:#4a5560" title="Internal / overhead">INT</span>'
        : ((r.person.capacityPct != null && r.person.capacityPct < 100) ? `<span class="nh-tag" style="background:#e3ecf7;color:#2f5d8f" title="Part time — measured against ${r.person.capacityPct}% of a full month (≈${Math.round(S.monthHours() * r.person.capacityPct / 100)} h/mo)">PT · ${r.person.capacityPct}%</span>` : '');
      const grp = S.personGroup(r.person);
      const grpTag = (!state.group && grp !== S.DEFAULT_GROUP) ? `<span class="nh-tag" style="background:#e7f0ee;color:#0E7C7B" title="Practice group — set on the Mapping tab">${esc(groupShort(grp))}</span>` : '';
      const meta = [grpTag, r.person.isNewHire ? '<span class="nh-tag">New hire</span>' : '', r.person.isPool ? '<span class="nh-tag" style="background:#dff0ee;color:#0E7C7B" title="Shared contract pool — several people can bill toward this line">POOL</span>' : '', empTag, lvTag, r.person.title ? esc(r.person.title) : ''].filter(Boolean).join(' ');
      body += `<tr><td class="who"><div class="who-name" data-exp="${esc(r.person.id)}">${esc(r.person.name)}</div>${meta ? `<div class="who-meta">${meta}</div>` : ''}</td>`;
      ms.forEach(m => {
        const v = r.vals[m]; const plan = r.byMonth[m] || 0;
        const hasPursuit = metric === 'plan' && inWin.some(a => isPursuitAlloc(a) && S.allocActiveIn(a, m));
        const cls = metric === 'var' ? vCls(v, plan) : (v == null ? 'nodata' : uCls(Math.round(v)));
        const tip = v == null ? (m === AX.nowYm ? 'Too early in the month to judge' : 'No Clockify data for this month') : metric === 'plan' ? `${Math.round(v)}% projected` : metric === 'actual' ? `${Math.round(v)}% actual · ${Math.round(plan)}% projected` : `${fmtSigned(Math.round(v), 0)} pts vs ${Math.round(plan * AX.planFrac(m))}% projected${m === AX.nowYm ? ' (month to date)' : ''}`;
        body += `<td><span class="cell ${cls} ${hasPursuit ? 'has-pursuit' : ''} ${m < nowYm ? 'past' : ''}" title="${tip}${hasPursuit ? ' · includes pursuit hours' : ''}">${fmtCell(v)}</span></td>`;
      });
      body += `<td>${projectCount}</td><td class="pk ${(metric === 'var' ? r.peakShown > 10 : r.peakShown > 100) ? 'over' : ''}">${metric === 'var' ? fmtSigned(Math.round(r.peakShown), 0) : Math.round(r.peakShown) + '%'}</td></tr>`;
      if (state.expandedRoster.has(r.person.id)) {
        let pr = '';
        if (metric === 'plan') {
          /* Jeff's structure from the Aug 13 review: the signed work totalled on
             its own, the pursuits totalled on their own, then the combined line —
             so "what are they actually committed to" and "what if it all lands"
             are two separate readings rather than one blended number. */
          const rowFor = (a) => {
            const isP = isPursuitAlloc(a);
            const stat = isP ? ' <span class="status-p">pursuit</span>' : '';
            const note = a.note ? ` <span class="vmini" title="${esc(a.note)}">— ${esc(a.note.length > 40 ? a.note.slice(0, 40) + '…' : a.note)}</span>` : '';
            return `<tr class="drawer-tr alloc-row ${isP ? 'pursuit-row' : ''}" data-edit-alloc="${esc(a.id)}" title="Click to edit this allocation"><td class="who dproj">${pLbl(a.project, a.client)}${stat}${contractTag(a)}${note}</td>${ms.map(m => `<td class="dcell">${S.allocActiveIn(a, m) ? a.pct + '%' : '·'}</td>`).join('')}<td class="dcell dacts" colspan="2">${drawerActs(a)}</td></tr>`;
          };
          const sumRow = (label, list, style, title) => {
            const cells = ms.map(m => {
              const v = list.reduce((t, a) => t + (S.allocActiveIn(a, m) ? (parseFloat(a.pct) || 0) : 0), 0);
              return `<td class="dcell" style="${style}">${v ? Math.round(v) + '%' : '·'}</td>`;
            }).join('');
            return `<tr class="drawer-tr"${title ? ` title="${esc(title)}"` : ''}><td class="who dproj" style="${style}">${esc(label)}</td>${cells}<td class="dcell"></td><td class="dcell"></td></tr>`;
          };
          const byPct = (a, b) => b.pct - a.pct;
          const firm = inWin.filter(a => !isPursuitAlloc(a)).sort(byPct);
          const purs = inWin.filter(a => isPursuitAlloc(a)).sort(byPct);
          const SUB = 'font-weight:700;background:#f4f6f7';
          const ALL = 'font-weight:800;background:#eceff1;border-top:1px solid rgba(37,39,58,0.25)';
          pr += firm.map(rowFor).join('');
          if (firm.length && purs.length) pr += sumRow('Subtotal · signed work', firm, SUB, 'Confirmed commitments only — what they are actually on the hook for');
          if (purs.length) {
            pr += purs.map(rowFor).join('');
            pr += sumRow('Subtotal · pursuits', purs, SUB, 'Unsigned work — only lands if these convert');
            pr += sumRow('Total · if every pursuit lands', inWin, ALL, 'Signed plus pursuit — the worst case for their capacity');
          } else if (firm.length > 1) {
            pr += sumRow('Total', firm, ALL, '');
          }
        } else {
          // one row per project they are planned on OR logged time to, in % of their capacity
          const cap = capOf(r.person);
          const names = [...projSet].map(pn => { const planM = {}, actM = {}; ms.forEach(m => { planM[m] = inWin.filter(a => a.project === pn && S.allocActiveIn(a, m)).reduce((t, a) => t + (parseFloat(a.pct) || 0), 0) * AX.planFrac(m); actM[m] = (((AX.byPP[r.person.id] || {})[pn] || { m: {} }).m[m] || 0) / cap * 100; }); const alloc = inWin.find(a => a.project === pn); return { pn, client: alloc ? alloc.client : (((AX.byPP[r.person.id] || {})[pn] || {}).client || ''), planM, actM, alloc, tot: ms.reduce((t, m) => t + actM[m], 0) }; }).sort((a, b) => b.tot - a.tot);
          names.forEach(x => {
            const cells = ms.map(m => { if (!AX.covered.has(m)) return '<td class="dcell" style="color:#c9cdd3">·</td>'; const v = metric === 'actual' ? x.actM[m] : x.actM[m] - x.planM[m]; const rv = Math.round(v); const txt = metric === 'actual' ? (rv ? rv + '%' : '·') : (rv ? fmtSigned(rv, 0) : '·'); const col = metric === 'var' && rv ? (v > Math.max(0.1 * x.planM[m], 5) ? 'color:#7a5600' : v < -Math.max(0.1 * x.planM[m], 5) ? 'color:#4a5560' : '') : ''; return `<td class="dcell" style="${col}" title="${metric === 'actual' ? `${Math.round(x.actM[m])}% actual · ${Math.round(x.planM[m])}% projected` : `${fmtSigned(rv, 0)} pts vs ${Math.round(x.planM[m])}% projected`}">${txt}</td>`; }).join('');
            pr += `<tr class="drawer-tr ${x.alloc ? 'alloc-row' : ''}" ${x.alloc ? `data-edit-alloc="${esc(x.alloc.id)}" title="Click to edit this allocation"` : 'title="Logged time, no allocation"'}><td class="who dproj">${pLbl(x.pn, x.client)}${x.alloc ? '' : ' <span class="nh-tag" style="background:#fdf3d7;color:#8a6d00">no plan</span>'}</td>${cells}<td class="dcell dacts" colspan="2">${x.alloc ? drawerActs(x.alloc) : ''}</td></tr>`;
          });
          if (names.length > 1) { const tot = ms.map(m => { if (!AX.covered.has(m)) return '<td class="dcell" style="color:#c9cdd3">·</td>'; const v = r.vals[m]; const rv = Math.round(v || 0); return `<td class="dcell" style="font-weight:800;background:#eceff1">${rv ? (metric === 'var' ? fmtSigned(rv, 0) : rv + '%') : '·'}</td>`; }).join(''); pr += `<tr class="drawer-tr"><td class="who dproj" style="font-weight:800;background:#eceff1">Total</td>${tot}<td class="dcell"></td><td class="dcell"></td></tr>`; }
        }
        if (!pr) pr = `<tr class="drawer-tr"><td class="who dproj"><em class="note-txt">${metric === 'plan' ? 'No allocations in this window.' : 'Nothing planned or logged in this window.'}</em></td>${ms.map(() => '<td class="dcell">·</td>').join('')}<td class="dcell"></td><td class="dcell"></td></tr>`;
        pr += drawerAddRow(ms, { person: r.person.name }, '+ Add a project for ' + r.person.name);
        body += pr;
      }
    });
    const table = rows.length ? `<div class="hm-wrap"><table class="hm"><thead>${head}</thead><tbody>${body}</tbody></table></div>` : `<div class="empty">No people match.</div>`;
    const legend = metric === 'var'
      ? `<div class="legend"><span><span class="sw" style="background:#cfe6e4"></span>within ±10% of plan</span><span><span class="sw" style="background:#fce7c2"></span>more time than planned</span><span><span class="sw" style="background:#f6c9c2"></span>far more (&gt;50% over)</span><span><span class="sw" style="background:#eef4f4"></span>less than planned</span><span><span class="sw" style="background:repeating-linear-gradient(45deg,#f7f6f3 0 4px,#fff 4px 8px)"></span>no Clockify data</span><span style="margin-left:auto">Click a name for the project split, click a planned row to edit it.</span></div>`
      : `<div class="legend">
      <span><span class="sw" style="background:#eef4f4"></span>≤85% headroom</span>
      <span><span class="sw" style="background:#cfe6e4"></span>86–100% full</span>
      <span><span class="sw" style="background:#fce7c2"></span>101–120% over</span>
      <span><span class="sw" style="background:#f6c9c2"></span>121–150%</span>
      <span><span class="sw" style="background:#e4453a"></span>&gt;150% critical</span>
      ${metric === 'plan' ? '<span><span class="sw sw-stripe"></span>includes pursuit hours — not yet signed</span>' : '<span><span class="sw" style="background:repeating-linear-gradient(45deg,#f7f6f3 0 4px,#fff 4px 8px)"></span>no Clockify data</span>'}
      <span style="margin-left:auto">Click a name for their allocations; edit, delete or add rows right in the drawer.</span>
    </div>`;
    $('#p-people').innerHTML = kpis + toolbar + table + legend;
    wireMetric('#p-people', renderPeople);
    $('#ppl-search').oninput = searchBox('#ppl-search', v => { state.pplSearch = v; renderPeople(); });
    $('#ppl-expand-toggle').onclick = () => {
      if (allExpanded) state.expandedRoster.clear();
      else rows.forEach(r => state.expandedRoster.add(r.person.id));
      renderPeople();
    };
    $$('#p-people .who-name').forEach(el => el.onclick = () => { const id = el.dataset.exp; if (state.expandedRoster.has(id)) state.expandedRoster.delete(id); else state.expandedRoster.add(id); renderPeople(); });
    $$('#p-people [data-edit-alloc]').forEach(tr => tr.onclick = () => openAllocModal(tr.dataset.editAlloc));
    wireDrawerActs('#p-people');
  }

  /* ---------- edit · delete · add straight from a drawer ----------
     The By Project and By Person drawers are where the plan is READ, so
     they are where it gets changed too — no round trip to the Allocations
     tab. Same modal, same verbs, same trail. */
  function drawerActs(a) {
    return `<span class="row-act" onclick="event.stopPropagation()"><button type="button" data-dedit="${esc(a.id)}" title="Edit this allocation">Edit</button><button type="button" class="del" data-ddel="${esc(a.id)}" title="Delete this allocation — the plan only; logged hours stay">Del</button></span>`;
  }
  function drawerAddRow(ms, preset, label) {
    return `<tr class="drawer-tr drawer-add"><td class="who dproj" colspan="${ms.length + 3}"><a href="#" class="drawer-add-link" data-dadd="${esc(JSON.stringify(preset))}">${esc(label)}</a></td></tr>`;
  }
  function wireDrawerActs(scope) {
    $$(`${scope} [data-dedit]`).forEach(b => b.onclick = (e) => { e.stopPropagation(); openAllocModal(b.dataset.dedit); });
    $$(`${scope} [data-ddel]`).forEach(b => b.onclick = (e) => {
      e.stopPropagation();
      const a = S.listAllocations().find(x => x.id === b.dataset.ddel); if (!a) return;
      const who = (S.getPerson(a.personId) || {}).name || a.personName || '';
      if (!confirm(`Delete ${who}'s allocation on ${a.project}?\n\n${S.ymLabel(a.start)}${a.end && a.end !== a.start ? ' – ' + S.ymLabel(a.end) : ''} at ${Math.round(parseFloat(a.pct) || 0)}%.\n\nOnly the plan goes — logged Clockify hours stay.`)) return;
      S.deleteAllocation(a.id); state._gapsKey = null; toast('Allocation deleted.'); renderAll();
    });
    $$(`${scope} [data-dadd]`).forEach(a => a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); let preset = {}; try { preset = JSON.parse(a.dataset.dadd); } catch (err) {} openAllocModal(null, preset); });
  }

  /** Where an allocation came from: a contract tag, and the contract's own
      figure when someone has since changed the row. */
  function contractTag(a) {
    if (!a) return '';
    const d = S.allocContractDrift(a);
    if (d) {
      const win = (x, y) => x ? S.ymLabel(x) + (y && y !== x ? ' – ' + S.ymLabel(y) : '') : '';
      const bits = [];
      if (d.pctChanged) bits.push(`${d.pct}% → ${a.pct}%`);
      if (d.datesChanged) bits.push(`${win(d.start, d.end)} → ${win(a.start, a.end)}`);
      return ` <span class="nh-tag ct-tag changed" title="Accepted from the contract at ${d.pct}%${d.start ? ' for ' + win(d.start, d.end) : ''}; the plan was changed since. The contract itself is unchanged.">📄 contract ${esc(bits.join(' · '))}</span>`;
    }
    if (a.contract || a.contractRole || a.contractResource) return ` <span class="nh-tag ct-tag" title="Accepted from the contract staffing${a.contract ? ' at ' + a.contract.pct + '%' + (a.contract.want && a.contract.want !== a.contract.pct ? ' (contract total ' + a.contract.want + '%)' : '') : ''}">📄 contract</span>`;
    return '';
  }
  function pLbl(name, client) { const L = S.projectLabel(name, client); return esc(L.name) + (L.legacy ? ' <span class="nh-tag" style="background:#fbe9e7;color:#8f2418" title="An old matrix name with no fee project chosen yet — move it from the banner at the top of Allocations">needs a project</span>' : ''); }
  /* Rows the move to fee keys could not place: still under their old matrix
     name, counted toward nobody's contract. One picker per name moves every
     row at once; the engine's best guess is offered as a one-click take. */
  function legacySectionHtml() {
    const legacy = S.legacyProjects(); if (!legacy.length) return '';
    return `<div style="background:#fff;border:1px solid rgba(37,39,58,0.12);border-left:4px solid #C0392B;padding:12px 16px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px"><span style="font-family:var(--font-display);font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:#8f2418">⚠ ${legacy.length} allocation project name${legacy.length === 1 ? ' is' : 's are'} not fee-tool names</span><span class="note-txt">Rows planned under a name the fee tool does not know. Map each to the fee project (or internal line) it staffs and every row moves at once; until then they count toward nobody's contract.</span></div>
      <table class="dt"><thead><tr><th>Name in the allocations</th><th class="num">Rows</th><th class="num">People</th><th>Looks like</th><th style="width:34%">Map to fee-tool project</th></tr></thead><tbody>
      ${legacy.map(g => `<tr><td class="pname">${esc(g.name)}<div class="vmini">${esc(g.client || '')}</div></td><td class="num">${g.rows}</td><td class="num">${g.people}</td><td>${g.suggest ? `<span class="badge pursuit">${esc(g.suggest.label)}</span> <button class="btn sm" data-legacy-take="${esc(g.name)}" data-key="${esc(g.suggest.key)}">Use this</button>` : '<span class="vmini">no match</span>'}</td><td><input list="target-dl" data-legacy-move="${esc(g.name)}" class="fee-link-sel" style="width:95%" placeholder="type the fee project…"></td></tr>`).join('')}
      </tbody></table>${targetDatalist()}</div>`;
  }
  /** Fee projects and internal lines, as a datalist every "where does this go" box shares. */
  function targetDatalist() { return `<datalist id="target-dl">${S.listFeeProjects().map(p => `<option value="${esc(p.label)}"></option>`).join('')}${S.INTERNAL_ORDER.map(k => `<option value="${esc(S.INTERNAL_LINES[k].label)}" label="internal line"></option>`).join('')}</datalist>`; }
  /** What someone typed in a target box → { feeId } | { internal } | null. */
  function mapTargetFor(v) { const t = S.projectRefToTarget(v); if (t) return t; const h = resolveTyped(v, S.listFeeProjects(), ['label', 'name', 'client']); return h ? { feeId: h.id } : null; }
  function wireLegacy(scope, rerender) {
    const done = (r) => { state._gapsKey = null; toast(`Moved ${r.rows} allocation${r.rows === 1 ? '' : 's'} onto ${r.label}${r.pinned ? ' — and the Clockify hours under that name land there too' : ''}.`); rerender(); };
    $$(`${scope} [data-legacy-move]`).forEach(inp => inp.onchange = () => { const v = inp.value.trim(); if (!v) return; const t = mapTargetFor(v); if (!t) { inp.style.borderColor = '#C0392B'; inp.title = 'Pick a fee project or internal line from the list — or type more of the name/client, it only needs to be unique.'; return; } done(S.placeName(inp.dataset.legacyMove, t)); });
    $$(`${scope} [data-legacy-take]`).forEach(b => b.onclick = () => { const t = S.projectRefToTarget(b.dataset.key); if (!t) return; done(S.placeName(b.dataset.legacyTake, t)); });
  }

  /* ---------- ACTUALS vs EXPECTED ----------
     Just the comparison now. The Clockify import card, the ①②③ glossary and
     the data-health notices that used to stack above it live on Data Sources
     (import + health) and in the header glossary button — this tab opens on
     the thing it's named after. */
  function renderActuals() {
    const has = S.hasActuals();
    let html = '';
    if (!has) {
      const meta = S.actualsMeta();
      html += `<div class="note-txt" style="margin:0 0 12px;padding:10px 14px;background:#fdf6e3;border-left:3px solid #e8b563">③ Actuals aren't loaded${meta.importedAt ? '' : ' yet'} — the comparison below shows ① Plan vs ② Contract only. <a href="#" data-goto-tab="sources" style="font-weight:700">Load them in Data Sources →</a></div>`;
    }

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
      // Leaves consume capacity but bill nothing — plan-vs-actual noise here.
      rows = rows.filter(r => !S.isLeaveProject(r.project));
      // A Clockify project nothing in the fee tool claims is not a project to
      // compare against — it lives on the Mapping tab until someone maps it.
      rows = rows.filter(r => !r.unmapped);
      // Type-to-search narrows live; Enter (or a pick from the list) locks it as a chip.
      const pq = String(state.varProjectQ || '').trim().toLowerCase(), qq = String(state.varPersonQ || '').trim().toLowerCase();
      if (pq) rows = rows.filter(r => (r.project + ' ' + (r.client || '') + ' ' + S.projectLabel(r.project, r.client).name).toLowerCase().includes(pq));
      if (qq) rows = rows.filter(r => String(r.person.name || '').toLowerCase().includes(qq));
      // Dollars mode: ①③ become hours × the person's internal COST rate (by title)
      if (dollars) rows = rows.map(r => { const k = rateOf(r.person); const bm = {}; ms.forEach(m => { const c = r.byMonth[m]; bm[m] = { e: c.e * k, a: c.a * k }; }); return { ...r, expected: r.expected * k, actual: r.actual * k, variance: r.variance * k, byMonth: bm }; });
      const byPerson = state.varGroup === 'person';
      // group by project or by person
      const byProj = {};
      rows.forEach(r => { const k = byPerson ? r.person.id : r.project; (byProj[k] = byProj[k] || []).push(r); });
      // Roll every Macro/Time-Off-named project into one combined row instead
      // of cluttering the list with each overhead line item separately — the
      // chart above already shows the true billable/macro/PTO split. The
      // "Include Macro / Time Off" checkbox controls whether that combined
      // row shows at all (unchecked = hide it from this list entirely).
      if (!byPerson) {
        const macroKeys = Object.keys(byProj).filter(k => S.isTimeOffProject(k) || S.isMacroProject(k));
        if (macroKeys.length) {
          const combined = [];
          macroKeys.forEach(k => { combined.push(...byProj[k]); delete byProj[k]; });
          if (state.showMacro) byProj['Macro / Time Off'] = combined;
        }
      }
      const projNames = Object.keys(byProj).sort((a, b) => byPerson ? (S.getPerson(a) || { name: a }).name.localeCompare((S.getPerson(b) || { name: b }).name) : a.localeCompare(b));
      const totExp = rows.reduce((s, r) => s + r.expected, 0), totAct = rows.reduce((s, r) => s + r.actual, 0);

      const projList = S.distinctProjects().filter(x => !S.isLeaveProject(x));
      const pplList = S.listPeople().filter(S.inView).sort((a, b) => a.name.localeCompare(b.name));
      const lockedPerson = state.varPerson ? (S.getPerson(state.varPerson) || { name: state.varPerson }).name : '';
      const findBox = (id, q, list, chip, unlockKey, ph) => `<span class="cmp-find">${chip ? `<span class="lock-chip" title="Locked — click × to clear">🔒 ${esc(chip)}<button type="button" data-unlock="${unlockKey}" aria-label="Clear">×</button></span>` : `<input type="search" id="${id}" list="${id}-list" placeholder="${ph}" value="${esc(q)}" autocomplete="off"><datalist id="${id}-list">${list.map(v => typeof v === 'string' ? `<option value="${esc(v)}">` : `<option value="${esc(v.value)}" label="${esc(v.label)}">`).join('')}</datalist>`}</span>`;
      // Suggestions carry the fee name (what people know) with the matrix name as the value that locks.
      const projSuggest = projList;
      const findProject = findBox('var-project-q', state.varProjectQ, projSuggest, projFilter ? S.projectLabel(projFilter).name : '', 'project', 'Project… Enter locks');
      const findPerson = findBox('var-person-q', state.varPersonQ, pplList.map(x => x.name), lockedPerson, 'person', 'Person… Enter locks');
      // Contract only applies when grouped by project (the contract has no names)
      let totContract = 0; const contractByProj = {};
      (byPerson ? [...new Set(rows.map(r => r.project))] : projNames).forEach(pn => { const cl = (rows.find(r => r.project === pn) || {}).client || ''; const cp = S.contractPlan(pn, ms, cl); if (cp) { contractByProj[pn] = cp; totContract += cpTot(cp); } });
      // monthly sums for the trend chart — macroM/ptoM track how much of actM
      // is Macro/non-billable vs Time Off specifically, so the chart can show
      // billable actuals separately from overhead instead of blending them.
      const planM = {}, actM = {}, conM = {}, macroM = {}, ptoM = {};
      ms.forEach(m => { planM[m] = 0; actM[m] = 0; conM[m] = 0; macroM[m] = 0; ptoM[m] = 0; });
      rows.forEach(r => {
        const isPto = S.isTimeOffProject(r.project);
        const isMacro = !isPto && S.isMacroProject(r.project);
        ms.forEach(m => { const c = r.byMonth[m]; planM[m] += c.e; actM[m] += c.a; if (isPto) ptoM[m] += c.a; else if (isMacro) macroM[m] += c.a; });
      });
      Object.values(contractByProj).forEach(cp => ms.forEach(m => { conM[m] += cpM(cp, m); }));
      html += dollars ? `<div class="kpi-strip">
        <div class="kpi-card"><div class="k-num">${fmtH(totContract)}</div><div class="k-lbl">② Fee billed (fee tool · net)</div></div>
        <div class="kpi-card accent"><div class="k-num">${fmtH(totAct)}</div><div class="k-lbl">③ Cost of hours logged (hours × cost rate)</div></div>
        <div class="kpi-card"><div class="k-num">${fmtH(totExp)}</div><div class="k-lbl">① Planned cost (matrix × cost rate) · reference</div></div>
        <div class="kpi-card ${totContract - totAct < 0 ? 'warn' : ''}"><div class="k-num">${fmtH(totContract - totAct)}</div><div class="k-lbl">Margin · ② fee − ③ actual cost${totContract ? ' · ' + Math.round((totContract - totAct) / totContract * 100) + '%' : ''}</div></div>
      </div>${noRate.size ? `<div class="note-txt" style="margin:-8px 0 12px;color:#8a6d00">⚠ No cost rate for: ${esc([...noRate].join(' · '))} — their hours count as $0. Fix the title on the roster (Clockify carries it in on the next pull).</div>` : ''}` : `<div class="kpi-strip">
        <div class="kpi-card accent"><div class="k-num">${fmtH(totExp)}</div><div class="k-lbl">① Matrix plan (JS sheet) · hrs</div></div>
        <div class="kpi-card"><div class="k-num">${fmtH(totContract)}</div><div class="k-lbl">② Per contract (fee tool) · hrs</div></div>
        <div class="kpi-card"><div class="k-num">${fmtH(totAct)}</div><div class="k-lbl">③ Actual (Clockify) · hrs</div></div>
        <div class="kpi-card ${Math.abs(totAct - totExp) > totExp * 0.1 ? 'warn' : ''}"><div class="k-num">${totAct >= totExp ? '+' : ''}${fmtH(totAct - totExp)}</div><div class="k-lbl">Actual − matrix plan</div></div>
      </div>`;
      // Bridge nudge — contract roles the matrix hasn't staffed yet.
      if (!byPerson && !projFilter) {
        const bg = bridgeGapsCached();
        if (bg.length) html += `<div class="note-txt" style="margin:0 0 10px;padding:8px 12px;background:#e7f0ee;border-left:3px solid var(--sav-teal)">🤝 <b>${bg.length}</b> contract role${bg.length === 1 ? ' isn’t' : 's aren’t'} fully staffed in the matrix — <a href="#" data-goto-tab="allocations" style="font-weight:700">review &amp; confirm in Allocations →</a></div>`;
      }
      html += `<div class="toolbar">
        <div class="seg-toggle" role="group" aria-label="Group by">
          <button type="button" class="seg-btn ${!byPerson ? 'active' : ''}" data-group="project">By Project</button>
          <button type="button" class="seg-btn ${byPerson ? 'active' : ''}" data-group="person">By Person</button>
        </div>
        ${findProject}${findPerson}
        ${canDollars ? `<div class="seg-toggle" role="group" aria-label="Units" title="Hours, or the same hours priced at each person’s cost rate against the contracted fee"><button type="button" class="seg-btn ${!dollars ? 'active' : ''}" data-unit="hours">Hours</button><button type="button" class="seg-btn ${dollars ? 'active' : ''}" data-unit="dollars">$ cost vs fee billed</button></div>` : ''}
        ${!byPerson ? `<label class="chk" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:12.5px"><input type="checkbox" id="var-showmacro" ${state.showMacro ? 'checked' : ''}> Include Macro / Time Off</label>` : ''}
        <button type="button" class="seg-btn" id="cmp-expand-all" style="border:1px solid rgba(37,39,58,0.25)">Expand all</button>
        <span class="grow"></span><span class="note-txt">${dollars ? '② = the contracted fee — what the client pays (fee tool, net). ③ = hours × internal COST rate for each person’s title. Every project total compares ③ against ②; ① is the matrix plan priced at cost, kept as a reference row. Profitable = ③ below ②.' : `▲ over plan · ▼ under plan · ● on plan (±10%) — ① who we PLAN to staff (names) · ② what the CONTRACT is priced at (titles, no names) · ③ what actually got logged. Expected = ${S.monthHours()} hrs/mo × cap% × allocation%.`}</span></div>`;
      html += `<div class="legend" style="margin:-4px 0 10px"><span><span class="sw" style="background:#cfe6e4"></span>on plan (85–110%)</span><span><span class="sw" style="background:#fce7c2"></span>over plan${dollars ? ' / over the fee' : ''}</span><span><span class="sw" style="background:#eef4f4"></span>under plan</span><span><span class="sw" style="background:#f4f2ef"></span>logged with no plan</span><span>·&nbsp; nothing either way</span><span style="margin-left:auto">${dollars ? 'Each cell: what the hours cost (hours × cost rate), over what was planned. Project totals read against the fee billed, and a Margin row shows fee − cost by month.' : 'Each cell: the hours that happened, over what was planned.'}</span></div>`;
      html += compareChart(ms, planM, conM, actM, macroM, ptoM, projFilter, dollars);

      if (!projNames.length) html += `<div class="empty">No matched allocations or actuals in this window.</div>`;
      const cmpHead = (firstCol) => `<thead><tr><th class="sticky-col">${firstCol}</th>${msDesc.map(m => `<th class="num">${esc(S.ymLabel(m))}<div class="vmini" style="text-transform:none;letter-spacing:0">${dollars ? 'cost · of plan' : 'actual · of plan'}</div></th>`).join('')}<th class="num">${dollars ? '① Plan cost' : '① Plan hrs'}</th><th class="num">${dollars ? '③ Actual cost' : '③ Actual hrs'}</th><th class="num">Variance${dollars ? '<div class="vmini" style="text-transform:none;letter-spacing:0">people vs ① · totals vs ② fee</div>' : ''}</th><th class="num">${dollars ? '% of ① / ② fee' : '% of plan'}</th></tr></thead>`;
      // One cell = one number you read (what happened), the plan beneath it,
      // the variance as the tint — no arrows, no slashes.
      const mcell = (ref, act, refWord) => {
        const w = refWord || 'of';
        if (!ref && !act) return '<td class="num cmp-c cmp-e">·</td>';
        if (!ref) return `<td class="num cmp-c cmp-noplan" title="${fmtH(act)} logged, nothing planned"><div class="cmp-a">${fmtH(act)}</div><div class="cmp-p">no plan</div></td>`;
        const cls = varCls(ref, act); const pct = Math.round(act / ref * 100);
        return `<td class="num cmp-c ${cls}" title="${fmtH(act)} against ${fmtH(ref)} · ${pct}%"><div class="cmp-a">${act ? fmtH(act) : '0'}</div><div class="cmp-p">${w} ${fmtH(ref)} · ${pct}%</div></td>`;
      };
      // Dollars: the line that answers the question — fee billed less cost, by month.
      const marginRow = (feeM, costM, feeTot, costTot) => `<tr style="background:#fff"><td class="pname sticky-col" style="font-weight:800">Margin <span class="vmini" style="font-weight:600">· ② fee − ③ cost</span></td>${msDesc.map(m => { const f = feeM(m) || 0, c = costM(m) || 0; if (!f && !c) return '<td class="num cmp-c cmp-e">·</td>'; const mg = f - c; return `<td class="num cmp-c" style="color:${mg < 0 ? '#A6131A' : '#1f5a3e'};font-weight:800" title="fee ${fmtH(f)} − cost ${fmtH(c)}"><div class="cmp-a">${mg < 0 ? '−' : ''}${fmtH(Math.abs(mg))}</div><div class="cmp-p">${f ? Math.round(mg / f * 100) + '% of fee' : 'no fee'}</div></td>`; }).join('')}<td class="num"></td><td class="num"></td><td class="num" style="font-weight:800;color:${feeTot - costTot < 0 ? '#A6131A' : '#1f5a3e'}">${feeTot - costTot < 0 ? '−' : ''}${fmtH(Math.abs(feeTot - costTot))}</td><td class="num vmini" style="font-weight:700">${feeTot ? Math.round((feeTot - costTot) / feeTot * 100) + '% margin' : '—'}</td></tr>`;
      const refRow = (label, refM, refTot, act, tip) => `<tr style="background:#f4f6f7"><td class="vmini sticky-col" style="font-weight:700" title="${esc(tip || '')}">${label}</td>${msDesc.map(m => `<td class="num vmini">${refM(m) ? fmtH(refM(m)) : '·'}</td>`).join('')}<td class="num vmini" style="font-weight:700">${fmtH(refTot)}</td><td class="num vmini">${fmtH(act)}</td><td class="num vmini ${varCls(refTot, act)}">${act >= refTot ? '+' : ''}${fmtH(act - refTot)}</td><td class="num vmini">${refTot ? Math.round(act / refTot * 100) + '%' : '—'}</td></tr>`;
      projNames.forEach(pn => {
        const list = byProj[pn].sort((a, b) => b.actual - a.actual);
        const pe = list.reduce((s, r) => s + r.expected, 0), pa = list.reduce((s, r) => s + r.actual, 0);
        const pL = byPerson ? null : S.projectLabel(pn, list[0].client || '');
        const cardTitle = byPerson ? (S.getPerson(pn) || { name: pn }).name : pL.name;
        const cardSub = byPerson ? ((S.getPerson(pn) || {}).title || '') : (list[0].client || pL.client || '');
        // planned in the fee tool, but no Clockify project lands here yet — the hours cannot arrive
        const noCk = !byPerson && pL.feeId && !S.clockifyNamesFor(pL.key).length;
        const noCkTag = noCk ? ' <span class="badge" style="background:#fbe9e7;color:#8f2418;font-weight:800" title="No Clockify project is mapped to this fee project — logged hours cannot land here. Map one on the Mapping tab.">no Clockify project mapped</span>' : '';
        const rowLabel = (r) => byPerson ? pLbl(r.project, r.client) : esc(r.person.name);
        const cp = byPerson ? null : contractByProj[pn];
        // Dollars: the yardstick is the FEE — what the client pays — not the
        // matrix hours priced at cost. The plan stays as a reference row.
        const feeRef = !!(dollars && cp && cpTot(cp) > 0);
        const fee = feeRef ? cpTot(cp) : 0;
        let b = '';
        list.forEach(r => {
          const vcls = varCls(r.expected, r.actual);
          const mcells = msDesc.map(m => { const c = r.byMonth[m]; return mcell(c.e, c.a); }).join('');
          b += `<tr><td class="pname sticky-col" style="font-weight:600">${rowLabel(r)}</td>${mcells}<td class="num">${fmtH(r.expected)}</td><td class="num">${fmtH(r.actual)}</td><td class="num ${vcls}">${varArrow(r.expected, r.actual)} ${r.variance >= 0 ? '+' : ''}${fmtH(r.variance)}</td><td class="num vmini">${r.expected ? Math.round(r.actual / r.expected * 100) + '%' : '—'}</td></tr>`;
        });
        // TOTAL row — per-month plan/actual/% summed over people; in dollars,
        // against the fee for the month when the project has one.
        const planMo = (m) => list.reduce((s, r) => s + r.byMonth[m].e, 0), actMo = (m) => list.reduce((s, r) => s + r.byMonth[m].a, 0);
        const refTot = feeRef ? fee : pe, refMo = feeRef ? (m) => cpM(cp, m) : planMo;
        const pcls = varCls(refTot, pa);
        const totCells = msDesc.map(m => mcell(refMo(m), actMo(m), feeRef ? 'of fee' : 'of')).join('');
        const totRow = `<tr style="background:#faf9f7;border-top:2px solid rgba(37,39,58,0.18)"><td class="pname sticky-col" style="font-weight:800">Total${feeRef ? ' <span class="vmini" style="font-weight:600">· vs ② fee</span>' : ''}</td>${totCells}<td class="num" style="font-weight:800">${fmtH(pe)}</td><td class="num" style="font-weight:800">${fmtH(pa)}</td><td class="num ${pcls}" style="font-weight:800">${varArrow(refTot, pa)} ${pa >= refTot ? '+' : ''}${fmtH(pa - refTot)}</td><td class="num vmini" style="font-weight:700">${refTot ? Math.round(pa / refTot * 100) + '%' : '—'}</td></tr>`;
        // Trust marker: a pinned Mapping link and a fuzzy auto-match look the
        // same everywhere else — say which one this ② number is riding on.
        const autoMatched = cp && (cp.feeProjects || []).some(f => f.via !== 'mapped');
        const linkBadge = cp ? (autoMatched
          ? ` <span title="Fee link is auto-matched by name — confirm it in Mapping" style="color:#8a6d00;cursor:help">≈ auto</span>`
          : ` <span title="Fee link confirmed in Mapping" style="color:#0E7C7B;cursor:help">🔗</span>`) : '';
        const contractCell = cp ? `contract <b style="color:var(--sav-navy)">${fmtH(cpTot(cp))}</b>${linkBadge}` : (byPerson ? `<span style="color:#b0b5bc">no contract staffing</span>`
            : pL.feeId ? `<a href="Universal Fee Calculator.html?id=${encodeURIComponent(pL.feeId)}" style="color:#b0b5bc" title="The fee record has no priced roles — staff it in the calculator and the contract line appears here">no contract staffing priced ↗</a>`
            : `<a href="#" data-goto-tab="allocations" style="color:#b0b5bc" title="These rows are under a name the fee tool does not know — map them from the banner on Allocations">no contract staffing — needs a fee project</a>`);
        const summaryLine = feeRef
          ? `② fee <b style="color:var(--sav-navy)">${fmtH(fee)}</b>${linkBadge} · ③ actual cost <b style="color:var(--sav-navy)">${fmtH(pa)}</b> · <span class="${pcls}">${fee - pa >= 0 ? '+' : ''}${fmtH(fee - pa)} margin · ${Math.round(pa / fee * 100)}% of fee spent</span> · <span style="color:#8a94a0">① plan cost ${fmtH(pe)}</span>`
          : `① matrix <b style="color:var(--sav-navy)">${fmtH(pe)}</b> · ${contractCell} · ③ actual <b style="color:var(--sav-navy)">${fmtH(pa)}</b> · <span class="${pcls}">${pa >= pe ? '+' : ''}${fmtH(pa - pe)} vs plan</span>`;
        let contractTbl = '';
        if (cp && cp.roles.length) {
          contractTbl = `<div style="padding:8px 16px 12px;border-top:1px dashed rgba(37,39,58,0.12);background:#faf9f7">
            <div style="font-family:var(--font-display);font-size:9.5px;letter-spacing:0.05em;text-transform:uppercase;color:var(--sav-steel);margin-bottom:5px">② Per contract · ${esc((cp.feeProjects || []).map(f => f.name).join(' + '))} ${autoMatched ? '<span style="text-transform:none;letter-spacing:0;color:#8a6d00">≈ auto-matched — confirm in Mapping</span>' : '<span style="text-transform:none;letter-spacing:0;color:#0E7C7B">🔗 confirmed link</span>'} <span style="text-transform:none;letter-spacing:0">(titles — match people to these when staffing)</span></div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">${cp.roles.map(r => `<span class="mv-chip" style="background:#e7eef0"><b>${_fmtHours(r.hours)}h</b> ${esc(r.title)} · ${r.fteMonths} FTE-mo</span>`).join('')}</div>
          </div>`;
        }
        const refRows = feeRef
          ? marginRow((m) => cpM(cp, m), actMo, fee, pa) + refRow('① Plan cost (matrix × rate)', planMo, pe, pa, 'The matrix plan priced at each person’s cost rate — a reference, not the yardstick')
          : (cp ? refRow(dollars ? '② Contract fee $' : '② Contract (titles)', (m) => cpM(cp, m), cpTot(cp), pa, '') : '');
        html += `<details class="cmp-card" style="background:#fff;border:1px solid rgba(37,39,58,0.12);margin-bottom:12px">
          <summary style="display:flex;justify-content:space-between;align-items:center;padding:11px 16px;cursor:pointer">
            <div class="pname" style="font-size:14px">${esc(cardTitle)} <span class="note-txt">· ${esc(cardSub)}</span>${noCkTag}</div>
            <div class="note-txt">${summaryLine}</div>
          </summary>
          <div style="border-top:1px solid rgba(37,39,58,0.1)">
          <div class="cmp-scroll"><table class="dt cmp-table">${cmpHead(byPerson ? 'Project' : 'Person')}<tbody>${b}${totRow}${refRows}
          </tbody></table></div>
          ${contractTbl}
          </div>
        </details>`;
      });
      if (projNames.length) {
        const feeRefAll = !!(dollars && totContract > 0);
        const refTot = feeRefAll ? totContract : totExp, refMo = feeRefAll ? (m) => conM[m] || 0 : (m) => planM[m] || 0;
        const gtCells = msDesc.map(m => mcell(refMo(m), actM[m] || 0, feeRefAll ? 'of fee' : 'of')).join('');
        const gtCls = varCls(refTot, totAct);
        const gtSummary = feeRefAll
          ? `② fee <b style="color:var(--sav-navy)">${fmtH(totContract)}</b> · ③ actual cost <b style="color:var(--sav-navy)">${fmtH(totAct)}</b> · <span class="${gtCls}">${totContract - totAct >= 0 ? '+' : ''}${fmtH(totContract - totAct)} margin · ${Math.round(totAct / totContract * 100)}% of fee spent</span> · <span style="color:#8a94a0">① plan cost ${fmtH(totExp)}</span>`
          : `① matrix <b style="color:var(--sav-navy)">${fmtH(totExp)}</b> · ② contract <b style="color:var(--sav-navy)">${fmtH(totContract)}</b> · ③ actual <b style="color:var(--sav-navy)">${fmtH(totAct)}</b> · <span class="${gtCls}">${totAct >= totExp ? '+' : ''}${fmtH(totAct - totExp)} vs plan</span>`;
        const gtRef = feeRefAll
          ? marginRow((m) => conM[m] || 0, (m) => actM[m] || 0, totContract, totAct) + refRow('① Plan cost (matrix × rate)', (m) => planM[m] || 0, totExp, totAct, 'The matrix plan priced at cost — a reference, not the yardstick')
          : (totContract ? refRow(dollars ? '② Contract fee $' : '② Contract (titles)', (m) => conM[m] || 0, totContract, totAct, '') : '');
        html += `<div class="cmp-card" style="background:#fff;border:2px solid var(--sav-navy);margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;padding:11px 16px;border-bottom:1px solid rgba(37,39,58,0.1)">
            <div class="pname" style="font-size:14px">Grand total <span class="note-txt">· ${projNames.length} ${byPerson ? 'people' : 'projects'} in view — matches the chart above</span></div>
            <div class="note-txt">${gtSummary}</div>
          </div>
          <div class="cmp-scroll"><table class="dt cmp-table">${cmpHead('All ' + (byPerson ? 'people' : 'projects'))}<tbody>
            <tr style="background:#faf9f7;border-top:2px solid rgba(37,39,58,0.18)"><td class="pname sticky-col" style="font-weight:800">Total${feeRefAll ? ' <span class="vmini" style="font-weight:600">· vs ② fee</span>' : ''}</td>${gtCells}<td class="num" style="font-weight:800">${fmtH(totExp)}</td><td class="num" style="font-weight:800">${fmtH(totAct)}</td><td class="num ${gtCls}" style="font-weight:800">${varArrow(refTot, totAct)} ${totAct >= refTot ? '+' : ''}${fmtH(totAct - refTot)}</td><td class="num vmini" style="font-weight:700">${refTot ? Math.round(totAct / refTot * 100) + '%' : '—'}</td></tr>
            ${gtRef}
          </tbody></table></div>
        </div>`;
      }
    }
    $('#p-actuals').innerHTML = html;
    wireImport();
    wireCompareFind();
    $$('#p-actuals [data-group]').forEach(b => b.onclick = () => { state.varGroup = b.dataset.group; renderActuals(); });
    $$('#p-actuals [data-unit]').forEach(b => b.onclick = () => { state.varUnit = b.dataset.unit; renderActuals(); });
    const vsm = $('#var-showmacro'); if (vsm) vsm.onchange = (e) => { state.showMacro = e.target.checked; renderActuals(); };
    $$('#p-actuals [data-goto-tab]').forEach(a => a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); const t = document.querySelector(`#tabs .tab[data-tab="${a.dataset.gotoTab}"]`); if (t) t.click(); });
    const gl = $('#cmp-glossary'); if (gl) gl.ontoggle = () => { state.glossaryOpen = gl.open; };
    const xa = $('#cmp-expand-all'); if (xa) xa.onclick = () => {
      const ds = $$('#p-actuals details.cmp-card');
      const anyClosed = ds.some(d => !d.open);
      ds.forEach(d => { d.open = anyClosed; });
      xa.textContent = anyClosed ? 'Collapse all' : 'Expand all';
    };
  }

  /* Grouped-bar trend chart: ① plan / ② contract / ③ actual per month. The
     ③ Actual bar is itself stacked — billable (yellow, bottom) + macro/
     non-billable (tan) + Time Off (striped tan, top) — so overhead and PTO
     never masquerade as billable actuals in the total bar height. Every
     segment's value is printed INSIDE the segment (when tall enough to hold
     it) rather than floating above the bar. */
  /* Type-to-search with a lock. Typing narrows the comparison live; Enter
     (or picking from the list) locks the best match as a chip, so you can
     lock a project, then type a person and lock that too. × clears a lock. */
  let cmpFindTimer = null, cmpRefocus = null;
  function wireCompareFind() {
    const resolveProject = (q) => { const list = S.distinctProjects(); const lq = q.trim().toLowerCase(); if (!lq) return ''; const fee = (x) => S.projectLabel(x).name.toLowerCase(); return list.find(x => x.toLowerCase() === lq || fee(x) === lq) || list.find(x => x.toLowerCase().includes(lq) || fee(x).includes(lq)) || ''; };
    const resolvePerson = (q) => { const list = S.listPeople().filter(S.inView); const lq = q.trim().toLowerCase(); if (!lq) return ''; const hit = list.find(x => x.name.toLowerCase() === lq) || list.find(x => x.name.toLowerCase().includes(lq)); return hit ? hit.id : ''; };
    const wire = (id, qKey, lockKey, resolve) => {
      const el = $('#' + id); if (!el) return;
      el.oninput = () => { clearTimeout(cmpFindTimer); const v = el.value; cmpFindTimer = setTimeout(() => { state[qKey] = v; cmpRefocus = { id, pos: el.selectionStart }; renderActuals(); }, 140); };
      el.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); clearTimeout(cmpFindTimer); const hit = resolve(el.value); if (hit) { state[lockKey] = hit; state[qKey] = ''; cmpRefocus = null; renderActuals(); } else toast('No ' + (lockKey === 'varProject' ? 'project' : 'person') + ' matches “' + el.value + '”.'); }
        if (e.key === 'Escape') { el.value = ''; state[qKey] = ''; renderActuals(); }
      };
      el.onchange = () => { const v = el.value, list = lockKey === 'varProject' ? S.distinctProjects().flatMap(x => [x, S.projectLabel(x).name]) : S.listPeople().filter(S.inView).map(x => x.name); if (list.some(x => x.toLowerCase() === v.trim().toLowerCase())) { clearTimeout(cmpFindTimer); state[lockKey] = resolve(v); state[qKey] = ''; cmpRefocus = null; renderActuals(); } };
    };
    wire('var-project-q', 'varProjectQ', 'varProject', resolveProject);
    wire('var-person-q', 'varPersonQ', 'varPerson', resolvePerson);
    $$('#p-actuals [data-unlock]').forEach(b => b.onclick = () => { state[b.dataset.unlock === 'project' ? 'varProject' : 'varPerson'] = ''; renderActuals(); });
    if (cmpRefocus) { const el = $('#' + cmpRefocus.id); if (el) { el.focus(); try { el.setSelectionRange(cmpRefocus.pos, cmpRefocus.pos); } catch (e) {} } cmpRefocus = null; }
  }
  function compareChart(ms, planM, conM, actM, macroM, ptoM, projFilter, dollars) {
    const W = Math.max(560, ms.length * 110), H = 210, padL = 48, padT = 14, padB = 30, padR = 8;
    const max = Math.max(1, ...ms.map(m => Math.max(planM[m] || 0, conM[m] || 0, actM[m] || 0)));
    const y = (v) => padT + (H - padT - padB) * (1 - v / max);
    const gw = (W - padL - padR) / ms.length;
    const tf = (v) => (dollars ? '$' : '') + Math.round(v).toLocaleString();
    // Label INSIDE a segment, centered — only when the segment is tall enough
    // to hold readable text; otherwise it's skipped (never floated elsewhere).
    const segLabel = (xx, bw, yTop, yBot, val, color) => {
      if (!val || (yBot - yTop) < 13) return '';
      return `<text x="${xx + bw / 2}" y="${(yTop + yBot) / 2 + 3}" text-anchor="middle" font-size="7.5" fill="${color}">${tf(val)}</text>`;
    };
    let s = `<defs><pattern id="pto-stripe" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="#EDE6D6"></rect>
      <line x1="0" y1="0" x2="0" y2="6" stroke="#25273A" stroke-width="2" stroke-opacity="0.3"></line>
    </pattern></defs>`;
    for (let i = 0; i <= 4; i++) { const v = max * i / 4, yy = y(v); s += `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" stroke="rgba(37,39,58,.08)"></line><text x="${padL - 6}" y="${yy + 3}" text-anchor="end" font-size="9" fill="#79828C">${tf(v)}</text>`; }
    const bw = Math.max(8, Math.min(26, (gw - 26) / 3));
    const names = dollars ? ['① Plan cost', '② Contract fee', '③ Actual cost'] : ['① Matrix plan', '② Contract', '③ Actual'];
    let totBillable = 0, totMacro = 0, totPto = 0;
    ms.forEach((m, i) => {
      const x0 = padL + i * gw + (gw - 3 * bw - 8) / 2;
      const yBase = H - padB;
      [[planM[m] || 0, '#0E7C7B', '#fff'], [conM[m] || 0, '#9aa3ad', '#25273A']].forEach(([v, c, txt], j) => {
        const xx = x0 + j * (bw + 4), yy = y(v);
        s += `<rect x="${xx}" y="${yy}" width="${bw}" height="${Math.max(0, yBase - yy)}" fill="${c}" stroke="#25273A" stroke-width="0.5"><title>${names[j]} · ${S.ymLabel(m)}: ${tf(v)}${dollars ? '' : ' h'}</title></rect>`;
        s += segLabel(xx, bw, yy, yBase, v, txt);
      });
      // ③ Actual — stacked: billable (bottom) + macro/non-billable (middle) + Time Off (top, striped)
      const pto = Math.max(0, ptoM[m] || 0);
      const macro = Math.max(0, macroM[m] || 0);
      const billable = Math.max(0, (actM[m] || 0) - macro - pto);
      totBillable += billable; totMacro += macro; totPto += pto;
      const xx = x0 + 2 * (bw + 4);
      const yBillTop = y(billable), yMacroTop = y(billable + macro), yPtoTop = y(billable + macro + pto);
      if (billable > 0) { s += `<rect x="${xx}" y="${yBillTop}" width="${bw}" height="${Math.max(0, yBase - yBillTop)}" fill="#FFDF00" stroke="#25273A" stroke-width="1"><title>③ Actual (billable) · ${S.ymLabel(m)}: ${tf(billable)}${dollars ? '' : ' h'}</title></rect>`; s += segLabel(xx, bw, yBillTop, yBase, billable, '#25273A'); }
      if (macro > 0) { s += `<rect x="${xx}" y="${yMacroTop}" width="${bw}" height="${Math.max(0, yBillTop - yMacroTop)}" fill="#E5DCC0" stroke="#25273A" stroke-width="1"><title>③ Actual (macro / non-billable) · ${S.ymLabel(m)}: ${tf(macro)}${dollars ? '' : ' h'}</title></rect>`; s += segLabel(xx, bw, yMacroTop, yBillTop, macro, '#25273A'); }
      if (pto > 0) { s += `<rect x="${xx}" y="${yPtoTop}" width="${bw}" height="${Math.max(0, yMacroTop - yPtoTop)}" fill="url(#pto-stripe)" stroke="#25273A" stroke-width="1"><title>③ Actual (Time Off) · ${S.ymLabel(m)}: ${tf(pto)}${dollars ? '' : ' h'}</title></rect>`; s += segLabel(xx, bw, yPtoTop, yMacroTop, pto, '#25273A'); }
      s += `<text x="${padL + i * gw + gw / 2}" y="${H - 10}" text-anchor="middle" font-size="10" fill="#25273A" font-weight="600">${esc(S.ymLabel(m))}</text>`;
    });
    return `<div style="background:#fff;border:1px solid rgba(37,39,58,0.12);padding:14px 16px;margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:8px">
        <div style="font-family:var(--font-display);font-weight:700;font-size:12px;color:var(--sav-navy)">${dollars ? 'Dollars' : 'Hours'} by month — ${projFilter ? esc(S.projectLabel(projFilter).name) : 'all projects'}</div>
        <div class="note-txt"><span style="color:#0E7C7B">■</span> ${names[0]}&nbsp;&nbsp;<span style="color:#9aa3ad">■</span> ${names[1]}&nbsp;&nbsp;<span style="color:#e8c400">■</span> ${names[2]} billable&nbsp;&nbsp;<span style="color:#E5DCC0;border:1px solid rgba(37,39,58,0.3)">■</span> ${names[2]} macro&nbsp;&nbsp;<span style="display:inline-block;width:12px;height:12px;vertical-align:-2px;border:1px solid rgba(37,39,58,0.3);background-color:#EDE6D6;background-image:repeating-linear-gradient(45deg, rgba(37,39,58,0.35) 0 3px, transparent 3px 7px)"></span> ${names[2]} Time Off · hover a bar for the number</div>
      </div>
      <div class="note-txt" style="margin-bottom:8px">③ Actual, this window: <b style="color:var(--sav-navy)">${tf(totBillable)}</b> billable + <b style="color:var(--sav-navy)">${tf(totMacro)}</b> macro + <b style="color:var(--sav-navy)">${tf(totPto)}</b> Time Off = <b style="color:var(--sav-navy)">${tf(totBillable + totMacro + totPto)}</b> total</div>
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
    const pplSel = (name) => `<select data-map-user="${esc(name)}" style="font-size:11px;max-width:170px"><option value="">map to…</option><option value="__ignore__">Ignore (not delivery)</option><option value="__add__">＋ Add as new person</option>${S.listPeople().map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>`;
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
        <datalist id="imp-proj-dl"><option value="Ignore"></option>${S.listFeeProjects().map(p => `<option value="${esc(p.label)}"></option>`).join('')}${S.INTERNAL_ORDER.map(k => `<option value="${esc(S.INTERNAL_LINES[k].label)}" label="internal line"></option>`).join('')}</datalist>
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
    const viaBadge = (v) => v === 'name' ? '<span class="badge active">exact</span>' : v === 'mapped' ? '<span class="badge active">pinned</span>' : v === 'salesforce' ? '<span class="badge active">SF ID</span>' : v === 'rule' ? '<span class="badge active">internal</span>' : (v === 'unmatched' || v === 'unmapped') ? '<span class="badge" style="color:#8f2418;background:#fbe9e7">unmapped</span>' : `<span class="badge pursuit" title="matched on words alone — confirm it on Mapping">≈ ${esc(v)}</span>`;
    const rows = rep.matchDetail.map(d => `<tr>
      <td>${esc(d.from)}</td><td>${viaBadge(d.via)}</td>
      <td>${esc(d.to)}</td>
      <td class="num">${fmtH(d.hours)}</td>
      <td><input list="imp-proj-dl" data-map-proj="${esc(d.from)}" style="font-size:11px;max-width:190px;border:1px dashed rgba(37,39,58,0.3);padding:2px 5px" placeholder="type to remap…"></td>
    </tr>`).join('');
    return `<details style="margin-bottom:16px"><summary style="cursor:pointer;font-family:var(--font-display);font-weight:700;font-size:12px;color:var(--sav-navy)">Where every Clockify project landed (${rep.matchDetail.length}) — check this if a project's actuals look wrong</summary>
      <table class="dt" style="margin-top:10px"><thead><tr><th>Clockify project</th><th>Match</th><th>→ Fee project / internal line</th><th class="num">Hours</th><th>Fix</th></tr></thead><tbody>${rows}</tbody></table></details>`;
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
    const ca = $('#clear-actuals'); if (ca) ca.onclick = (e) => { e.preventDefault(); if (confirm('Clear all imported Clockify hours?\n\nBandwidth and profitability lose their actuals until the next import. Project mappings and title pins are kept.')) { S.clearActuals(); state.clockifyReport = null; renderSources(); renderFreshness(); } };
    const cm = $('#commit-merge'); if (cm) cm.onclick = () => { const r = S.commitClockify(state.clockifyReport, 'replace'); state.clockifyReport = null; state.clockifyRaw = null; renderSources(); renderFreshness(); toast(`Imported ${r.written} rows${r.skipped ? ` · ${r.skipped} skipped (unmatched)` : ''}.`); };
    const cadd = $('#commit-add'); if (cadd) cadd.onclick = () => { const r = S.commitClockify(state.clockifyReport, 'merge'); state.clockifyReport = null; state.clockifyRaw = null; renderSources(); renderFreshness(); toast(`Added ${r.written} rows${r.skipped ? ` · ${r.skipped} skipped` : ''}.`); };
    const cc = $('#commit-cancel'); if (cc) cc.onclick = () => { state.clockifyReport = null; state.clockifyRaw = null; renderSources(); };
    // mapping selects — save + instantly re-analyze the same file
    const reanalyze = () => { if (state.clockifyRaw) { state.clockifyReport = S.analyzeClockify(state.clockifyRaw, months()[0]); renderSources(); } };
    $$('#p-sources [data-map-user]').forEach(sel => sel.onchange = () => {
      if (!sel.value) return;
      if (sel.value === '__add__') { const p = S.addPersonFromClockify({ name: sel.dataset.mapUser }); toast(p ? `${p.name} added to the roster and mapped.` : 'Could not add.', 'ok'); reanalyze(); return; }
      S.setUserMapping(sel.dataset.mapUser, sel.value); toast('Mapping saved — re-checked.'); reanalyze();
    });
    $$('#p-sources [data-map-proj]').forEach(inp => inp.onchange = () => {
      const v = inp.value.trim(); if (!v) return;
      const isIgnore = v.toLowerCase() === 'ignore';
      const hit = isIgnore ? '__ignore__' : mapTargetFor(v);
      if (!hit) { inp.style.borderColor = '#C0392B'; inp.title = 'Pick a fee project or internal line from the list (or type Ignore)'; return; }
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
        renderSources();
      } catch (e) { setNote('Clockify pull failed: ' + e.message + (String(e.message).includes('configured') || String(e.message).includes('501') ? ' — set CLOCKIFY_API_KEY + CLOCKIFY_WORKSPACE_ID in Vercel.' : ''), true); pa.disabled = false; }
    };
    const pb = $('#pull-box');
    if (pb) pb.onclick = async () => {
      setNote('Pulling clockify-actuals.csv from Box…'); pb.disabled = true;
      try {
        if (!window.UFC_Box || !window.UFC_Box.pullActuals) throw new Error('Box layer not loaded');
        state.clockifyRaw = await window.UFC_Box.pullActuals();
        state.clockifyReport = S.analyzeClockify(state.clockifyRaw, months()[0]);
        renderSources();
      } catch (e) { setNote('Box pull failed: ' + e.message, true); pb.disabled = false; }
    };
  }

  function readClockify(file) {
    const rd = new FileReader();
    rd.onload = () => {
      const defMonth = months()[0];
      state.clockifyRaw = String(rd.result);
      state.clockifyReport = S.analyzeClockify(state.clockifyRaw, defMonth);
      renderSources();
    };
    rd.readAsText(file);
  }

  function toast(msg) {
    let t = document.getElementById('toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--sav-navy);color:#fff;padding:12px 20px;font-family:var(--font-display);font-weight:700;font-size:13px;z-index:300;box-shadow:0 6px 24px rgba(0,0,0,.25)'; document.body.appendChild(t); }
    t.textContent = msg; t.style.opacity = '1'; clearTimeout(t._h); t._h = setTimeout(() => { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; }, 2600);
  }

  /* ---------- allocation modal ---------- */
  function openAllocModal(id, preset) {
    const a = id ? S.listAllocations().find(x => x.id === id) : null;
    state.editingAlloc = a ? a.id : null;
    $('#am-title').textContent = a ? 'Edit allocation' : (preset && preset.title) || 'Add allocation';
    $('#am-people').innerHTML = S.listPeople().map(p => `<option value="${esc(p.name)}">`).join('');
    /* The project list is the FEE TOOL's projects — "Client — Project", the
       names everyone knows — plus the internal lines (leave, time off, BD,
       overhead). An allocation is keyed on the record it staffs, so there is
       no free-text project any more. */
    const feeChoices = allocFeeChoices();
    const internalChoices = viewMode === 'leader' && LEADER() ? [] : S.INTERNAL_ORDER.map(k => S.INTERNAL_LINES[k].label);
    $('#am-projects').innerHTML = feeChoices.map(f => `<option value="${esc(f.label)}" label="${esc(STORE.STATUS_LABELS[(f.p.project || {}).status] || '')}">`).join('')
      + internalChoices.map(l => `<option value="${esc(l)}" label="internal line · no fee project">`).join('');
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
    const ct = $('#am-contract');
    if (ct) {
      if (a && (a.contract || a.contractRole || a.contractResource)) {
        const c = a.contract; const win = (x, y) => x ? S.ymLabel(x) + (y && y !== x ? ' – ' + S.ymLabel(y) : '') : '';
        ct.hidden = false;
        ct.innerHTML = `📄 <b>Per the contract:</b> ${c ? `<b>${c.pct}%</b>${c.want && c.want !== c.pct ? ` (of a ${c.want}% contract line${c.have ? `, ${c.have}% was already in the matrix` : ''})` : ''}${c.start ? ' · ' + esc(win(c.start, c.end)) : ''}` : 'accepted from the contract staffing'}${a.contractRole ? ' · role ' + esc(a.contractRole) : ''}${a.contractResource && a.contractResource !== (person.name || '') ? ' · named ' + esc(a.contractResource) : ''}.<div class="vmini" style="margin-top:3px">Changing this row changes the staffing plan only. The contract and the fee are not touched; the contract figure stays on the row so the difference is visible.</div>`;
      } else { ct.hidden = true; ct.innerHTML = ''; }
    }
    if (!a && preset) {   // prefilled add (e.g. "Log a leave")
      if (preset.project != null) $('#am-project').value = preset.project;
      if (preset.person != null) $('#am-person').value = preset.person;
      if (preset.client != null) $('#am-client').value = preset.client;
      if (preset.pct != null) $('#am-pct').value = preset.pct;
      if (preset.note != null) $('#am-note').value = preset.note;
    }
    $('#alloc-modal').classList.add('open');
  }
  function closeAllocModal() { $('#alloc-modal').classList.remove('open'); state.editingAlloc = null; }
  /** Fee projects a new allocation may be filed under: every live parent for
      an admin, the leader's own in the leader view. Dead pursuits are left out. */
  function allocFeeChoices() {
    let list = STORE.listProjects().filter(p => !(STORE.isChangeOrder && STORE.isChangeOrder(p)) && !(STORE.isDeadPursuit && STORE.isDeadPursuit(p)) && (p.project || {}).name);
    if (viewMode === 'leader' && LEADER()) { const ids = LEADER().scope().feeIds; list = list.filter(p => ids.has(p.id)); }
    const out = list.map(p => ({ id: p.id, p, name: p.project.name, client: p.project.client || '', label: (p.project.client ? p.project.client + ' — ' : '') + p.project.name }));
    // Two fee records with the same client and name (it happens): tell them
    // apart in the list by project number or status, so a pick is unambiguous.
    const count = {}; out.forEach(f => { count[f.label] = (count[f.label] || 0) + 1; });
    out.forEach(f => { if (count[f.label] > 1) f.label += ' · ' + ((f.p.project || {}).projectNumber || STORE.STATUS_LABELS[(f.p.project || {}).status] || (f.p.project || {}).status || f.id.slice(-4)); });
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }
  /** What the person typed in the project box → the fee project it names, if any. */
  function allocFeePick(typed) {
    const v = String(typed || '').trim(); if (!v) return null;
    const list = allocFeeChoices();
    return list.find(f => f.label === v) || list.find(f => f.name === v) || resolveTyped(v, list, ['label', 'name']);
  }
  function saveAllocModal() {
    const name = $('#am-person').value.trim();
    const project = $('#am-project').value.trim();
    if (!name || !project) { UFC_UI.toast('Person and project are required.'); return; }
    // Leaders stay inside their own projects. An admin may edit any
    // allocation from either view — the real sign-in decides, not the
    // leader being impersonated.
    const realU = (STORE.getRealIdentity && STORE.getRealIdentity()) || {};
    const adminHere = (STORE.isAdmin && STORE.isAdmin()) || (realU.username && STORE.adminEmails && STORE.adminEmails().includes(String(realU.username).toLowerCase()));
    if (viewMode === 'leader' && LEADER() && !adminHere) {
      const sc = LEADER().scope();
      if (!LEADER().allowedProject(sc, project)) { UFC_UI.toast('That is not one of your projects — pick one of yours from the list.'); return; }
      if (state.editingAlloc) { const cur = S.listAllocations().find(x => x.id === state.editingAlloc); if (cur && !(cur.feeId && sc.feeIds.has(cur.feeId))) { UFC_UI.toast('That allocation is on another leader\'s project.'); return; } }
    }
    // The row is keyed on the fee project (or internal line) picked. A row
    // still under an old name may be edited without moving it; a NEW row
    // must land on a real target.
    const fee = allocFeePick(project);
    const target = fee ? { feeId: fee.id } : mapTargetFor(project);
    if (!target && !state.editingAlloc) { UFC_UI.toast('Pick a fee project (or an internal line) from the list — every allocation is keyed on one.'); return; }
    const rec = Object.assign({
      id: state.editingAlloc || undefined,
      personId: S.personIdForName(name), personName: name,
      project: fee ? fee.label : project, client: $('#am-client').value.trim() || (fee ? fee.client : (target && target.internal ? 'Internal' : '')),
      status: $('#am-status').value, type: $('#am-type').value,
      start: $('#am-start').value || null, end: $('#am-end').value || null,
      pct: +$('#am-pct').value || 0, note: $('#am-note').value.trim(),
    }, target || {});
    S.saveAllocation(rec);
    const wasEdit = !!state.editingAlloc;
    closeAllocModal(); renderAll();
    toast(wasEdit ? 'Allocation updated.' : 'Allocation added' + (fee ? ' on ' + fee.label + '.' : '.'));
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
    const ckList = state.clockifyNames;
    const ckClient = {}; ckList.forEach(c => { ckClient[c.name.toLowerCase()] = c.client || ''; });
    /* FEE PROJECTS ON THE LEFT. One row per fee-tool project (and per
       internal line); the Clockify projects feeding it sit beside it, and a
       picker over the Clockify list attaches another. Many Clockify projects
       to one fee project; nothing points the other way. */
    const ckRows = S.clockifyProjectRows(ckList.map(c => c.name));
    const q = state.mapSearch.toLowerCase();
    const ckByKey = {}; ckRows.forEach(r => (r.keys || (r.key ? [r.key] : [])).forEach(k => (ckByKey[k] = ckByKey[k] || []).push(r)));
    const AXk = S.actualsIndex().byKey;
    // rows: planned projects + anything hours land on + every fee project when asked (or when searching)
    const rowKeys = new Map();
    S.planProjects().forEach(p => { if (p.feeId || p.internal) rowKeys.set(p.key, p); });
    Object.keys(AXk).forEach(k => { if (/^(fee|int):/.test(k) && !rowKeys.has(k)) rowKeys.set(k, S.describeKey(k)); });
    S.INTERNAL_ORDER.forEach(k => { if (!rowKeys.has('int:' + k)) rowKeys.set('int:' + k, S.describeKey('int:' + k)); });
    if (state.mapAllFee || q) feeList.forEach(p => { if (!rowKeys.has('fee:' + p.id) && (!q || (p.label + ' ' + p.client).toLowerCase().includes(q) || state.mapAllFee)) rowKeys.set('fee:' + p.id, S.describeKey('fee:' + p.id)); });
    const feeRows = [...rowKeys.values()].sort((a, b) => (a.internal ? 1 : 0) - (b.internal ? 1 : 0) || a.label.localeCompare(b.label));
    const ckBadge = (c, rowKey) => {
      const how = c.via === 'mapped' ? 'pinned' : c.via === 'salesforce' ? 'Salesforce id' : c.via === 'rule' ? 'internal rule' : c.via === 'auto' ? 'guessed from the name — not confirmed' : 'exact name';
      const others = c.shared ? c.labels.filter((l, i) => c.keys[i] !== rowKey) : [];
      return `<div class="lv-link" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:2px 0"><span class="badge ${c.via === 'auto' ? 'pursuit' : 'active'}" title="${how}">${esc(c.name)}</span><span class="vmini">${c.hours ? fmtH(c.hours) + ' h' : 'no hours yet'} · ${c.via === 'mapped' ? 'pinned' : c.via === 'salesforce' ? 'SF id' : c.via === 'rule' ? 'rule' : c.via === 'auto' ? 'guess' : 'name'}</span>${c.via === 'auto' ? `<button class="btn sm" data-confirm-ck="${esc(c.name)}" data-fee="${esc(rowKey)}" title="Pin this match">✓ Confirm</button>` : ''}<a href="#" data-unmap-ck="${esc(c.name)}" data-from="${esc(rowKey)}" data-pinned="${c.pinned ? 1 : 0}" style="color:#8f2418;text-decoration:none;font-weight:800" title="${c.pinned && c.shared ? 'Take this Clockify project off this fee project (it stays on the others)' : 'Unmap — the hours stop landing here and show as “no project” until mapped again'}">✕</a>${others.length ? `<span class="vmini" title="A month's hours go to whichever record is active then; two active at once split by planned hours">also feeds <b>${esc(others.join(', '))}</b> · split by month</span>` : ''}${c.conflict ? `<span class="vmini" style="color:#8f2418">⚠ its Salesforce id belongs to <b>${esc(c.conflict)}</b></span>` : ''}</div>`;
    };
    let rows = ''; let problems = 0; let shown = 0;
    feeRows.forEach(p => {
      const cks = ckByKey[p.key] || [];
      const planned = S.planProjects().some(x => x.key === p.key);
      const silent = planned && !!p.feeId && !cks.length;
      const isProblem = silent || cks.some(c => c.via === 'auto' || c.conflict);
      if (isProblem) problems++;
      if (q && !(p.label + ' ' + p.client + ' ' + cks.map(c => c.name).join(' ')).toLowerCase().includes(q)) return;
      if (state.mapOnlyProblems && !isProblem) return;
      shown++;
      const ckCell = cks.length ? cks.map(c => ckBadge(c, p.key)).join('') : `<span class="no-link" style="margin:0">${silent ? 'planned, but no Clockify project lands here — hours cannot reach it' : p.internal ? 'nothing lands here' : 'nothing lands here'}</span>`;
      rows += `<tr>
        <td class="pname">${esc(p.label)}${p.feeId ? ` <a class="link-fee" href="Universal Fee Calculator.html?id=${encodeURIComponent(p.feeId)}" title="Open in fee tool">↗</a>` : ''}<div class="vmini">${p.internal ? 'internal line · no fee project by design' : esc(((STORE.STATUS_LABELS || {})[p.status] || p.status || '') + (planned ? ' · planned' : ''))}</div></td>
        <td>${ckCell}</td>
        <td><input list="ck-dl" data-attach="${esc(p.key)}" class="fee-link-sel" style="width:95%" placeholder="${cks.length ? 'add another Clockify project…' : 'pick the Clockify project…'}" title="Type part of a Clockify project name and pick it — the list shows where each one lands today"></td>
      </tr>`;
    });
    // the Clockify list to pick from: unmapped first, each with where it lands today
    const ckPick = ckRows.slice().sort((a, b) => (a.unmapped ? 0 : 1) - (b.unmapped ? 0 : 1) || b.hours - a.hours);
    const ckDatalist = `<datalist id="ck-dl">${ckPick.map(c => `<option value="${esc(c.name)}" label="${esc(c.ignored ? 'ignored' : c.unmapped ? 'UNMAPPED' + (c.hours ? ' · ' + fmtH(c.hours) + ' h' : '') : '→ ' + c.label)}"></option>`).join('')}</datalist>`;
    // Clockify projects with hours and no fee project — the other way in
    const unmappedRows = ckRows.filter(r => r.unmapped).filter(r => !q || (r.name + ' ' + (ckClient[r.name.toLowerCase()] || '')).toLowerCase().includes(q));
    problems += ckRows.filter(r => r.unmapped).length;
    const unmappedSection = unmappedRows.length ? `<h3 style="font-family:var(--font-display);font-size:13px;color:var(--sav-navy);margin:22px 0 8px">Clockify projects with no fee project <span class="note-txt" style="font-weight:400">(${unmappedRows.length} · ${fmtH(unmappedRows.reduce((t, r) => t + r.hours, 0))} h shown as “no project” until mapped — pick the fee project, or Ignore non-project time)</span></h3>
      <table class="dt"><thead><tr><th style="width:34%">③ Clockify project</th><th class="num" style="width:80px">Hours</th><th>Map to ② fee project / internal line</th></tr></thead><tbody>${unmappedRows.map(r => `<tr><td class="pname">${esc(r.name)}${r.detached ? ' <span class="nh-tag" style="background:#eee8e3;color:#79828c" title="Unmapped on purpose — no automatic match is applied">unmapped by hand</span>' : ''}<div class="vmini">${esc(ckClient[r.name.toLowerCase()] || '')}${r.plannedRows ? ` · planned under this name too (${r.plannedRows} row${r.plannedRows === 1 ? '' : 's'}) — mapping it moves both` : ''}${r.detached ? ` · <a href="#" data-automap-ck="${esc(r.name)}">try the automatic match again</a>` : ''}</div></td><td class="num">${r.hours ? fmtH(r.hours) : '—'}</td><td><input list="target-dl" data-map-ck="${esc(r.name)}" class="fee-link-sel" style="width:60%" placeholder="type the fee project…"> <button class="btn sm ghost" data-ignore-proj="${esc(r.name)}" title="Not project work — never count these hours">Ignore</button></td></tr>`).join('')}</tbody></table>` : '';
    // ---- PEOPLE mapping: roster ↔ Clockify users ----
    const ckUsers = state.clockifyUsers || [];
    const userMaps = maps.users || {};
    let pplRows = ''; let pplProblems = 0;
    const hasHours = (pid) => Object.keys(S.readDb().actuals || {}).some(k => k.startsWith(pid + '|'));
    S.listPeople().filter(p => !p.isNewHire || hasHours(p.id)).forEach(p => {
      // which clockify users resolve to this person (saved mapping or name match)
      const hits = ckUsers.filter(u => { const m = userMaps[u.name.toLowerCase().replace(/\s+/g, ' ').trim()]; if (m) return m === p.id; return S.namesMatch(p.name, u.name) && !S.userExcluded(u.name, p.id); });
      const isProblem = !hits.length;
      if (isProblem) pplProblems++;
      if (q && !p.name.toLowerCase().includes(q)) return;
      if (state.mapOnlyProblems && !isProblem) return;
      const cell = hits.length
        ? hits.map(u => { const saved = userMaps[u.name.toLowerCase().replace(/\s+/g, ' ').trim()] === p.id; return `<span class="badge active" title="${esc(u.email)}${saved ? ' · pinned mapping' : ' · name match'}">${esc(u.name)} <a href="#" data-unmap-user="${esc(u.name)}" data-unmap-pid="${esc(p.id)}" data-unmap-saved="${saved ? 1 : 0}" style="color:inherit;text-decoration:none;font-weight:800" title="Not this person — remove">✕</a></span>`; }).join(' ')
        : (ckUsers.length ? '<span class="no-link" style="margin:0">no Clockify user matches — their hours are being DROPPED at import</span>' : '<span class="vmini">user list unavailable</span>');
      const empType = S.personEmploymentType(p);
      const capPct = p.capacityPct != null ? p.capacityPct : 100;
      const leftTag = (p.joinedYm ? ` <span class="nh-tag" style="background:#fdf3d7;color:#8a6d00" title="Started ${esc(S.ymLabel(p.joinedYm))} — earlier months are not expected; that month is partial and not scored">JOINED ${esc(S.ymLabel(p.joinedYm))}</span>` : '')
        + (p.leftYm ? ` <span class="nh-tag" style="background:#eee8e3;color:#79828c" title="Left the firm — nothing is expected after ${esc(S.ymLabel(p.leftYm))}">LEFT ${esc(S.ymLabel(p.leftYm))}</span>` : '');
      const typeTag = leftTag + (empType === 'internal'
        ? ' <span class="nh-tag" style="background:#e7eef0;color:#4a5560" title="Internal / overhead — internal time is expected, excluded from burn flags and availability lists">INTERNAL</span>'
        : (empType === 'part' ? ` <span class="nh-tag" style="background:#e3ecf7;color:#2f5d8f" title="Part time — every hours bar (expected hours, time-entry compliance, burn) measures against ${capPct}% of a full month">PT · ${capPct}%</span>` : ''));
      const leftCell = `<div style="white-space:nowrap"><span class="vmini">Joined</span> <input type="month" data-joined="${esc(p.id)}" value="${esc(p.joinedYm || '')}" class="fee-link-sel" style="width:auto" title="First month with the firm. Set it when the data cannot tell — e.g. someone who started mid-way through the first month on record. Earlier months are not expected; that month is partial and not scored."></div>
        <div style="white-space:nowrap;margin-top:4px"><span class="vmini">Left</span> <input type="month" data-left="${esc(p.id)}" value="${esc(p.leftYm || '')}" class="fee-link-sel" style="width:auto" title="Last month with the firm. From the month after, no hours are expected and they drop out of the chase list. Clear it if they are back."></div>`;
      const empCell = `<select data-emp="${esc(p.id)}" class="fee-link-sel" style="width:auto" title="Sets the bar this person is measured against — Full Time = full-month hours · Part Time = the % you set · Internal = overhead, internal time expected">
          <option value="full" ${empType === 'full' ? 'selected' : ''}>Full Time · Billable</option>
          <option value="part" ${empType === 'part' ? 'selected' : ''}>Part Time</option>
          <option value="internal" ${empType === 'internal' ? 'selected' : ''}>Internal</option>
        </select>${empType === 'part' ? `<div style="margin-top:4px;white-space:nowrap"><input type="number" data-emp-cap="${esc(p.id)}" value="${capPct}" min="5" max="100" step="5" style="width:54px"> % <span class="vmini">≈ ${Math.round(S.monthHours() * capPct / 100)} h/mo bar</span></div>` : ''}`;
      const grp = S.personGroup(p);
      const grpCell = `<select data-grp="${esc(p.id)}" class="fee-link-sel" style="width:auto" title="Practice group — the group picker at the top of the page shows only this group's people, and only the contract roles tagged to it in the fee tool">
          ${S.groupList().map(g => `<option value="${esc(g)}" ${g === grp ? 'selected' : ''}>${esc(groupShort(g))}${!p.serviceLine && g === S.DEFAULT_GROUP ? ' (default)' : ''}</option>`).join('')}
        </select>`;
      pplRows += `<tr><td class="pname">${esc(p.name)}${typeTag}<div class="vmini">${esc(p.title || '')}</div></td><td>${cell}<br><input list="map-ckuser-dl" data-map-ckuser="${esc(p.id)}" class="fee-link-sel" style="margin:4px 0 0;width:90%" placeholder="${hits.length ? 'type to add another…' : 'type Clockify user…'}"></td><td>${grpCell}</td><td>${empCell}</td><td>${leftCell}</td></tr>`;
    });
    /* Clockify users with no roster person at all — new hires the JS sheet
       does not know yet. Their hours are dropped at import until they exist. */
    const nk = (n) => String(n || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const people = S.listPeople();
    const orphans = ckUsers.filter(u => {
      if (/^(inactive|deactivated)$/i.test(u.status || '')) return false;
      const m = userMaps[nk(u.name)];
      if (m) return false;                                          // mapped to someone, or ignored
      return !people.some(p => S.namesMatch(p.name, u.name) && !S.userExcluded(u.name, p.id));
    }).filter(u => !q || u.name.toLowerCase().includes(q));
    const orphanSection = orphans.length ? `<div class="note-txt" style="margin:14px 0 6px;padding:10px 14px;background:#fdf3d7;border-left:3px solid #e8b563;color:#4a4f5e">
        <b>${orphans.length} Clockify user${orphans.length === 1 ? ' is' : 's are'} not on the roster</b> — their hours are dropped at import until they are. Add them here (they land on the next pull), or ignore non-delivery staff.
        <table class="dt" style="margin-top:8px"><tbody>${orphans.map(u => `<tr><td class="pname">${esc(u.name)}<div class="vmini">${esc(u.title || '')}${u.title && u.email ? ' · ' : ''}${esc(u.email || '')}</div></td>
          <td style="white-space:nowrap"><button class="btn sm" data-add-ck="${esc(u.name)}" data-add-ck-title="${esc(u.title || '')}">＋ Add to roster</button> <button class="btn sm ghost" data-ignore-ck="${esc(u.name)}" title="Not delivery staff — never import their hours">Ignore</button></td></tr>`).join('')}</tbody></table></div>` : '';
    const pplSection = orphanSection + `<h3 style="font-family:var(--font-display);font-size:13px;color:var(--sav-navy);margin:22px 0 8px">People — roster ↔ Clockify <span class="note-txt" style="font-weight:400">(${pplProblems} unmatched · unmatched people's hours are skipped at import — map, then re-pull actuals to backfill · set the Employment type so everyone is measured against the right bar: part-timers against their %, internal staff not flagged at all · set the Group so the group picker at the top scopes every tab to that practice — anyone left unset counts as PPM${state.group ? ' · this list always shows everyone, whatever group is picked above' : ''})</span></h3>
      <table class="dt"><thead><tr><th style="width:24%">Roster person (JS sheet)</th><th>③ Clockify user(s)</th><th style="width:170px">Group</th><th style="width:170px">Employment</th><th style="width:190px" title="Joiners and leavers: first and last month with the firm">Joined / left</th></tr></thead><tbody>${pplRows || '<tr><td colspan="5"><div class="empty" style="border:0">Nothing matches the filter.</div></td></tr>'}</tbody></table>
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
    const banner = state.clockifyNamesError ? `<div class="note-txt" style="color:#8f2418;margin-bottom:10px">Couldn't pull the Clockify list (${esc(state.clockifyNamesError)}) — the rows below are the Clockify projects with hours already imported, plus saved pins.</div>` : '';
    const flags = S.mappingFlags ? S.mappingFlags() : {};
    const flagIds = Object.keys(flags);
    const flagQueue = flagIds.length ? `<div class="lv-queue"><div class="lv-queue-h">⚑ ${flagIds.length} mapping flag${flagIds.length === 1 ? '' : 's'} from revenue leaders <span class="note-txt" style="font-weight:400">— they could not fix these from their view: the Clockify project belongs to another fee project, or the link is wrong. Fix the mapping below, then resolve.</span></div>
        <table class="dt"><thead><tr><th>Fee project</th><th>Flagged by</th><th>When</th><th>Note</th><th></th></tr></thead><tbody>${flagIds.map(id => { const f = flags[id]; const fp = feeList.find(x => x.id === id); return `<tr><td class="pname">${esc(fp ? fp.label : (f.feeName || id))}</td><td>${esc(f.byName || f.by || '')}</td><td>${esc(new Date(f.at).toLocaleString())}</td><td>${esc(f.note || '')}</td><td><button class="btn sm" data-flag-resolve="${esc(id)}">Resolved</button></td></tr>`; }).join('')}</tbody></table></div>` : '';
    $('#p-mapping').innerHTML = `${banner}${flagQueue}
      <div class="toolbar">
        <input type="search" id="map-search" placeholder="Find a fee project or a Clockify project…" value="${esc(state.mapSearch)}">
        <label class="chk" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:12.5px"><input type="checkbox" id="map-problems" ${state.mapOnlyProblems ? 'checked' : ''}> Only problems (${problems})</label>
        <label class="chk" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:12.5px" title="By default only planned projects and projects with hours are listed"><input type="checkbox" id="map-all-fee" ${state.mapAllFee ? 'checked' : ''}> Every fee project (${feeList.length})</label>
        <span class="grow"></span>
        <button class="btn btn-ghost" id="map-refresh" title="Re-pull the Clockify project list">⟳ Refresh Clockify list</button>
        <span class="note-txt">Fee project on the left, the Clockify projects feeding it on the right — several can. Every pick is saved for everyone and applies to all future pulls.</span>
      </div>
      <table class="dt"><thead><tr><th style="width:32%">② Fee-tool project</th><th>③ Clockify project(s) landing here</th><th style="width:26%">Attach a Clockify project</th></tr></thead><tbody>${rows || '<tr><td colspan="3"><div class="empty" style="border:0">Nothing matches the filter.</div></td></tr>'}</tbody></table>
      <div class="note-txt" style="margin-top:6px">${shown} of ${feeRows.length} projects shown${state.mapAllFee ? '' : ' · planned projects and projects with hours; tick “Every fee project” or search to reach the rest'}.</div>
      ${ckDatalist}${targetDatalist()}
      <div style="margin-top:18px">${legacySectionHtml()}</div>
      ${unmappedSection}
      ${pplSection}
      ${titleSection}`;
    $$('#p-mapping [data-flag-resolve]').forEach(b => b.onclick = () => { S.clearMappingFlag(b.dataset.flagResolve); toast('Flag resolved.', 'ok'); renderMapping(); });
    $('#map-search').oninput = searchBox('#map-search', v => { state.mapSearch = v; renderMapping(); });
    $('#map-problems').onchange = (e) => { state.mapOnlyProblems = e.target.checked; renderMapping(); };
    $('#map-all-fee').onchange = (e) => { state.mapAllFee = e.target.checked; renderMapping(); };
    const ckNames = ckRows.map(r => ({ name: r.name, client: ckClient[r.name.toLowerCase()] || '' }));
    $$('#p-mapping [data-attach]').forEach(inp => inp.onchange = () => {
      const v = inp.value.trim(); if (!v) return;
      let hit = ckNames.find(c => c.name.toLowerCase() === v.toLowerCase()) || resolveTyped(v, ckNames, ['name', 'client']);
      if (!hit) { inp.style.borderColor = '#C0392B'; inp.title = 'Pick a Clockify project from the list — or type more of its name, it only needs to be unique.'; return; }
      try { S.setProjectMapping(hit.name, inp.dataset.attach, { add: true }); let moved = 0; if (S.legacyProjects().some(g => g.name.toLowerCase() === hit.name.toLowerCase())) moved = S.retargetLegacy(hit.name, S.projectRefToTarget(inp.dataset.attach)); state._gapsKey = null; const now = S.resolveClockify(hit.name); const shared = now && now.feeIds && now.feeIds.length > 1; toast(`“${hit.name}” now lands on ${S.describeKey(inp.dataset.attach).label}${shared ? ` — shared with ${now.feeIds.filter(id => 'fee:' + id !== inp.dataset.attach).map(id => S.describeKey('fee:' + id).label).join(', ')}; each month's hours go to whichever record is active then` : ''}${moved ? ` — and ${moved} planned row${moved === 1 ? '' : 's'} under that name moved too` : ''}.`); } catch (e) { toast(e.message || String(e)); }
      renderMapping(); renderCounts();
    });
    $('#map-refresh').onclick = () => { state.clockifyNames = null; state.clockifyNamesError = null; renderMapping(); };
    $$('#p-mapping [data-map-ck]').forEach(inp => inp.onchange = () => {
      const v = inp.value.trim(); if (!v) return;
      const target = mapTargetFor(v);
      if (!target) { inp.style.borderColor = '#C0392B'; inp.title = 'Pick a fee project or internal line from the list — or type more of the name/client, it only needs to be unique.'; return; }
      try { S.setProjectMapping(inp.dataset.mapCk, target); let moved = 0; if (S.legacyProjects().some(g => g.name.toLowerCase() === inp.dataset.mapCk.toLowerCase())) moved = S.retargetLegacy(inp.dataset.mapCk, target); state._gapsKey = null; toast('Mapping saved — the hours land there now and on every future pull.' + (moved ? ` ${moved} planned row${moved === 1 ? '' : 's'} under that name moved too.` : '')); } catch (e) { toast(e.message || String(e)); }
      renderMapping(); renderCounts();
    });
    $$('#p-mapping [data-confirm-ck]').forEach(b => b.onclick = () => { S.setProjectMapping(b.dataset.confirmCk, b.dataset.fee, { add: true }); toast('Pinned — saved for everyone.'); renderMapping(); });
    $$('#p-mapping [data-unmap-ck]').forEach(a => a.onclick = (e) => {
      e.preventDefault();
      const ck = a.dataset.unmapCk, from = a.dataset.from;
      // pinned → take this fee record off the pin (the last one away detaches);
      // automatic → detach outright, so the match does not come straight back
      if (a.dataset.pinned === '1') S.setProjectMapping(ck, from, { remove: true }); else S.setProjectMapping(ck, '__detach__');
      const now = S.resolveClockify(ck);
      toast(now && now.key ? `“${ck}” no longer feeds ${S.describeKey(from).label}; it still feeds ${(now.feeIds || []).map(id => S.describeKey('fee:' + id).label).join(' + ')}.` : `“${ck}” is unmapped — its hours show as “no project” until you map it again (bottom of this tab).`);
      renderMapping();
    });
    $$('#p-mapping [data-automap-ck]').forEach(a => a.onclick = (e) => { e.preventDefault(); S.setProjectMapping(a.dataset.automapCk, null); toast('Back to the automatic match.'); renderMapping(); });
    $$('#p-mapping [data-ignore-proj]').forEach(b => b.onclick = () => { S.setProjectMapping(b.dataset.ignoreProj, '__ignore__'); toast('Ignored — those hours are not counted anywhere.'); renderMapping(); });
    wireLegacy('#p-mapping', () => { renderMapping(); renderCounts(); });
    $$('#p-mapping [data-unmap-user]').forEach(a => a.onclick = (e) => {
      e.preventDefault();
      const ck = a.dataset.unmapUser, pid = a.dataset.unmapPid;
      if (a.dataset.unmapSaved === '1') S.setUserMapping(ck, null);   // drop the pinned mapping
      S.setUserExclusion(ck, pid, true);                              // and block the fuzzy match
      toast('Removed — ' + ck + ' no longer maps to this person. Re-pull actuals to recompute.');
      renderMapping();
    });
    $$('#p-mapping [data-add-ck]').forEach(b => b.onclick = () => {
      const person = S.addPersonFromClockify({ name: b.dataset.addCk, title: b.dataset.addCkTitle });
      toast(person ? `${person.name} added to the roster and mapped — their hours land on the next actuals pull.` : 'Could not add that user.', 'ok');
      renderMapping();
    });
    $$('#p-mapping [data-ignore-ck]').forEach(b => b.onclick = () => { S.setUserMapping(b.dataset.ignoreCk, '__ignore__'); toast('Ignored — their hours will not be imported.', 'ok'); renderMapping(); });
    $$('#p-mapping [data-joined]').forEach(inp => inp.onchange = () => {
      const pid = inp.dataset.joined, ym = inp.value || null;
      const person = S.getPerson(pid) || {};
      S.setPersonJoined(pid, ym);
      toast(ym ? `${person.name || 'Person'} started ${S.ymLabel(ym)} — earlier months are not expected and that month is not scored.`
               : `${person.name || 'Person'}: start month cleared — the first month with hours is the start again.`, 'ok');
      renderMapping(); try { renderCompliance(); } catch (e) {}
    });
    $$('#p-mapping [data-left]').forEach(inp => inp.onchange = () => {
      const pid = inp.dataset.left, ym = inp.value || null;
      const person = S.getPerson(pid) || {};
      S.setPersonLeft(pid, ym);
      toast(ym ? `${person.name || 'Person'} marked as left in ${S.ymLabel(ym)} — nothing is expected of them after that month.`
               : `${person.name || 'Person'} is active again.`, 'ok');
      renderMapping(); try { renderCompliance(); } catch (e) {}
    });
    $$('#p-mapping [data-grp]').forEach(sel => sel.onchange = () => {
      const person = S.setPersonGroup(sel.dataset.grp, sel.value);
      toast(`${(person && person.name) || 'Person'} is in ${groupShort(sel.value)} — the group picker at the top now counts them there.`, 'ok');
      renderCounts(); renderMapping();
    });
    $$('#p-mapping [data-emp]').forEach(sel => sel.onchange = () => {
      const pid = sel.dataset.emp, type = sel.value;
      const person = S.getPerson(pid) || {};
      // switching TO part time starts at 50% unless they already had a reduced bar
      const cap = type === 'part' ? ((person.capacityPct != null && person.capacityPct < 100) ? person.capacityPct : 50) : undefined;
      S.setPersonEmployment(pid, { type, capacityPct: cap });
      toast(type === 'internal' ? 'Marked internal — their internal time is expected now; burn flags and availability lists skip them.'
        : type === 'part' ? `Part time — set their % below; every hours bar now measures against it.`
        : 'Full time billable — measured against the full-month bar again.');
      renderMapping();
    });
    $$('#p-mapping [data-emp-cap]').forEach(inp => inp.onchange = () => {
      const v = Math.max(5, Math.min(100, Math.round(+inp.value) || 50));
      S.setPersonEmployment(inp.dataset.empCap, { type: 'part', capacityPct: v });
      toast(`Bar set — ${v}% ≈ ${Math.round(S.monthHours() * v / 100)} h/mo. Expected hours, time-entry compliance and burn all measure against it.`);
      renderMapping();
    });
    $$('#p-mapping [data-map-ckuser]').forEach(inp => inp.onchange = () => {
      const v = inp.value.trim(); if (!v) return;
      let u = (state.clockifyUsers || []).find(x => x.name.toLowerCase() === v.toLowerCase());
      if (!u) u = resolveTyped(v, state.clockifyUsers || [], ['name', 'email']);
      if (!u) { inp.style.borderColor = '#C0392B'; inp.title = 'Pick a Clockify user from the list — or type more of the name/email, it only needs to be unique.'; return; }
      S.setUserMapping(u.name, inp.dataset.mapCkuser);
      toast('Person mapped — now re-pull actuals on the Compare tab to backfill their hours.');
      renderMapping();
    });
    $$('#p-mapping [data-map-title]').forEach(inp => inp.onchange = () => {
      const v = inp.value.trim(); if (!v) return;
      let o = rateByLabel[v.toLowerCase()];
      if (!o) o = resolveTyped(v, rateOpts, ['label']);
      if (!o) { inp.style.borderColor = '#C0392B'; inp.title = 'Pick a rate-grid title from the list — or type more of it, it only needs to be unique.'; return; }
      S.setTitleMapping(inp.dataset.mapTitle, o.titleId, o.tierId);
      toast('Title pinned — “' + inp.dataset.mapTitle + '” now costs $' + o.rate + '/h everywhere.');
      renderMapping();
    });
    $$('#p-mapping [data-unmap-title]').forEach(a => a.onclick = (e) => {
      e.preventDefault(); S.setTitleMapping(a.dataset.unmapTitle, null); toast('Pinned title mapping removed — back to auto-match.'); renderMapping();
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
    const hot = projRows.filter(p => (p.pctPlan != null && p.pctPlan > 1.1) || (p.plan === 0 && p.act > 20)).sort((a, b) => b.varPlan - a.varPlan).slice(0, 5);
    const cold = projRows.filter(p => p.plan > 20 && (p.act / p.plan) < 0.85).sort((a, b) => a.varPlan - b.varPlan).slice(0, 5);

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
    const overext = ppl.filter(p => p.peak > 100 || p.burnPct > 1.05).sort((a, b) => (b.burnPct + b.peak / 100) - (a.burnPct + a.peak / 100));
    const headroom = ppl.filter(p => p.peak > 0 && p.peak <= 85 && p.burnPct < 0.85 && !(p.person && p.person.nonBillable)).sort((a, b) => a.avg - b.avg);

    // ---- role heat: where over-plan hours concentrate, by title ----
    const roleHeat = {};
    vm.forEach(r => {
      let e = 0, a = 0; msPast.forEach(m => { e += r.byMonth[m].e; a += r.byMonth[m].a; });
      const over = a - e; if (over <= 0) return;
      const t = (r.person.title || '').trim() || 'Unknown title';
      roleHeat[t] = (roleHeat[t] || 0) + over;
    });
    const roles = Object.entries(roleHeat).map(([title, hrs]) => ({ title, hrs })).sort((a, b) => b.hrs - a.hrs).slice(0, 5);
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

    // ---- bandwidth coming available in the next 3 months ----
    /* Pursuits deliberately NOT passed through: this report answers "who can
       take new work", and unsigned pursuit load makes people look committed
       when they are not. No top-N cap either — Jeff asked for everyone who
       frees 25%+, not the five biggest movers. */
    const freeing = S.comingAvailable({ minFreedPct: 25 });

    // ---- pursuit exposure: how much of forward load is unsigned work ----
    const fwdMs = ms.filter(m => m >= nowYm);
    const bwAll2 = S.bandwidthGrid(fwdMs, { includePursuit: true });
    const firmBy = {}; S.bandwidthGrid(fwdMs, { includePursuit: false }).forEach(r => firmBy[r.person.id] = r);
    const pursuitPpl = bwAll2.map(r => {
      const f = firmBy[r.person.id];
      const all = r.avg || 0, firm = (f && f.avg) || 0, pur = all - firm;
      return pur >= 10 ? { person: r.person, all, firm, pur } : null;
    }).filter(Boolean).sort((a, b) => b.pur - a.pur).slice(0, 5);

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
    const macroTime = S.substantialMacroTime(msPast);
    const boh = macroTime.boh;
    const overheadPpl = macroTime.overhead || [];
    const macro = macroTime.flagged;

    const fH = (n) => fmtH(Math.round(n * 10) / 10);
    const noAct = hasAct ? '' : `<div class="note-txt" style="margin-bottom:14px;color:#8a6d00">No Clockify actuals loaded — burn-based insights are empty. Pull actuals on the Compare tab first.</div>`;
    const projTable = (list, dir) => list.length ? `<table class="dt"><thead><tr><th>Project</th><th class="num">③ Actual</th><th class="num">① Plan</th><th class="num">② Contract</th><th class="num">${dir}</th></tr></thead><tbody>${list.map(p => `<tr><td class="pname">${pLbl(p.project, p.client)}<div class="vmini">${esc(p.client || '')}</div></td><td class="num"><b>${fH(p.act)}</b></td><td class="num">${fH(p.plan)}</td><td class="num">${p.contract != null ? fH(p.contract) : '—'}</td><td class="num ${dir === 'Over' ? 'var-over' : 'var-under'}">${p.varPlan >= 0 ? '+' : ''}${fH(p.varPlan)}${p.pctPlan != null ? `<div class="vmini">${Math.round(p.pctPlan * 100)}% of plan</div>` : '<div class="vmini">no plan</div>'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty" style="border:0">Nothing here — clean.</div>';

    const gapsShown = gaps, trendsShown = trends.slice(0, 5);
    const more = (n, total) => total > n ? `<div class="vmini" style="padding:6px 2px 0">+${total - n} more</div>` : '';


    $('#p-insights').innerHTML = `${noAct}<div class="ins-grid">
      <div class="ins-card"><h3>🔥 Burning over plan <span>· ${esc(S.ymLabel(msPast[0] || ms[0]))}–${esc(S.ymLabel(msPast[msPast.length - 1] || ms[ms.length - 1]))}</span></h3>${projTable(hot, 'Over')}</div>
      <div class="ins-card"><h3>🧊 Under-served <span>· scope risk or stale plan</span></h3>${projTable(cold, 'Under')}</div>
      <div class="ins-card"><h3>⚠️ Most overextended <span>· load + burn vs capacity</span></h3>${overext.length ? `<div style="max-height:320px;overflow-y:auto"><table class="dt"><thead><tr><th>Person</th><th class="num">Peak</th><th class="num">Months &gt;100%</th><th class="num">Burn</th></tr></thead><tbody>${overext.map(p => `<tr><td class="pname">${esc(p.person.name)}</td><td class="num ${p.peak > 100 ? 'var-over' : ''}">${Math.round(p.peak)}%</td><td class="num">${p.overMonths}</td><td class="num ${p.burnPct > 1.05 ? 'var-over' : ''}">${p.capH ? Math.round(p.burnPct * 100) + '%' : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty" style="border:0">Nobody over the line.</div>'}</div>
      <div class="ins-card"><h3>🎯 Role heat <span>· over-plan hours by title${hireSignal ? ' · <b>' + hireSignal + '</b>' : ''}</span></h3>${roles.length ? `<table class="dt"><tbody>${roles.map(r => `<tr><td style="width:38%" class="pname">${esc(r.title)}</td><td><div class="heat-bar"><i style="width:${Math.round(r.hrs / maxRole * 100)}%;background:${r.hrs / maxRole > 0.6 ? '#e4453a' : '#e8b563'}"></i></div></td><td class="num" style="width:70px"><b>+${fH(r.hrs)}</b>h</td></tr>`).join('')}</tbody></table>` : '<div class="empty" style="border:0">Nothing to attribute yet.</div>'}</div>
      <div class="ins-card"><h3>🕳️ Contract coverage gaps <span>· &lt;60% staffed</span></h3>${gapsShown.length ? `<div style="max-height:320px;overflow-y:auto"><table class="dt"><thead><tr><th>Project</th><th class="num">Contract</th><th class="num">Gap</th></tr></thead><tbody>${gapsShown.map(g => `<tr><td class="pname">${pLbl(g.project, g.client)}</td><td class="num">${fH(g.contract)}</td><td class="num var-over">${fH(g.gap)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty" style="border:0">Every contract is ≥60% staffed.</div>'}</div>
      <div class="ins-card"><h3>🟢 Headroom <span>· first call before hiring</span></h3>${headroom.length ? `<div style="max-height:320px;overflow-y:auto"><table class="dt"><thead><tr><th>Person</th><th class="num">Avg load</th><th class="num">Burn</th></tr></thead><tbody>${headroom.map(p => `<tr><td class="pname">${esc(p.person.name)}</td><td class="num">${Math.round(p.avg)}%</td><td class="num">${p.capH ? Math.round(p.burnPct * 100) + '%' : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty" style="border:0">No one with meaningful headroom.</div>'}</div>
      <div class="ins-card"><h3>🎯 Pursuit exposure <span>· forward load on unsigned work</span></h3>${pursuitPpl.length ? `<table class="dt"><thead><tr><th>Person</th><th class="num">Firm</th><th class="num">+ Pursuit</th><th class="num">If landed</th></tr></thead><tbody>${pursuitPpl.map(p => `<tr><td class="pname">${esc(p.person.name)}</td><td class="num">${Math.round(p.firm)}%</td><td class="num" style="color:#8a6d00;font-weight:700">+${Math.round(p.pur)}</td><td class="num ${p.all > 100 ? 'var-over' : ''}">${Math.round(p.all)}%</td></tr>`).join('')}</tbody></table>` : '<div class="empty" style="border:0">No pursuit allocations in the forward window.</div>'}</div>
      <div class="ins-card"><h3>📈 Burn trend <span>· last 3 months, ±30%+ swings</span></h3>${trendsShown.length ? `<table class="dt"><thead><tr><th>Project</th><th class="num">Trend</th></tr></thead><tbody>${trendsShown.map(t => `<tr><td class="pname">${pLbl(t.project, t.client)}</td><td class="num ${t.delta > 0 ? 'var-over' : 'var-under'}">${t.delta > 0 ? '▲' : '▼'} ${t.pct > 0 ? '+' : ''}${Math.round(t.pct * 100)}%</td></tr>`).join('')}</tbody></table>${more(5, trends.length)}` : `<div class="empty" style="border:0">${hasAct ? (msPast.length >= 3 ? 'No big swings.' : 'Widen the window to ≥3 past months.') : 'Needs Clockify actuals.'}</div>`}</div>
      <div class="ins-card"><h3>📉 Coming available <span>· next 3 months · frees 25%+ · pursuits excluded</span></h3>${freeing.length ? `<div style="max-height:320px;overflow-y:auto"><table class="dt"><thead><tr><th>Person</th><th class="num">Now</th><th class="num">Drops to</th><th class="num">Frees</th><th>When</th></tr></thead><tbody>${freeing.map(f => `<tr><td class="pname">${esc(f.person.name)}${f.stillLoaded ? ' <span class="badge pursuit" title="Still over 100% today — the drop brings them back toward the line rather than opening a full slot">over-allocated now</span>' : ''}</td><td class="num">${Math.round(f.cur)}%</td><td class="num" style="color:#1f7a44;font-weight:700">${Math.round(f.to)}%</td><td class="num">${Math.round(f.freedPct)}%</td><td>${esc(S.ymLabel(f.m))}</td></tr>`).join('')}</tbody></table></div><div class="note-txt" style="padding:6px 16px 2px;font-size:11px">${freeing.length} ${freeing.length === 1 ? 'person frees' : 'people free'} 25% or more of their capacity. Sorted by where they land, so the most available person is first.</div>` : '<div class="empty" style="border:0">Nobody frees 25% or more in the next three months.</div>'}</div>
      ${(() => {
        const noAlloc = S.loggingWithoutAllocation(msPast);
        if (!noAlloc.length) return '';
        return `<div class="ins-card"><h3>\u26A0 Logging time, not allocated <span>· real hours with nothing planned against them</span></h3><div style="max-height:320px;overflow-y:auto"><table class="dt"><thead><tr><th>Person</th><th class="num">Hrs</th><th>Where</th></tr></thead><tbody>${noAlloc.map(r => `<tr><td class="pname">${esc(r.person.name)}</td><td class="num var-over"><b>${fH(r.hours)}</b></td><td class="note-txt">${esc(r.projects.slice(0, 2).map(p => p.name).join(', '))}${r.projects.length > 2 ? ' +' + (r.projects.length - 2) : ''}</td></tr>`).join('')}</tbody></table></div><div class="note-txt" style="padding:6px 16px 10px;font-size:11px">These people are on the roster and their hours are being costed, but they hold no allocation in this window — so plan-vs-actual compares real burn against zero and their load reads as free. <a href="#" data-goto-tab="allocations">Add an allocation</a> and they join the plan.</div></div>`;
      })()}
      ${(() => { const lv = S.leaveStatus().filter(l => l.status !== 'past'); if (!lv.length) return ''; return `<div class="ins-card"><h3>🌴 Leaves of absence <span>· returns need a plan 1–2 months out</span></h3><table class="dt"><thead><tr><th>Person</th><th>Out</th><th>Back</th><th></th></tr></thead><tbody>${lv.map(l => `<tr><td class="pname">${esc(l.person.name)}</td><td>${esc(S.ymLabel(l.start))} – ${esc(S.ymLabel(l.end))}</td><td>${l.status === 'out' ? esc(S.ymLabel(S.ymAdd(l.end, 1))) : `<span class="vmini">starts ${esc(S.ymLabel(l.start))}</span>`}</td><td>${l.returningSoon ? '<span class="mv-chip" style="background:#fdf3d7;color:#8a6d00;font-weight:700">🔔 plan their staffing</span>' : (l.startingSoon ? '<span class="mv-chip" style="background:#efe6f7;color:#6b3fa0">reassign their book</span>' : '')}</td></tr>`).join('')}</tbody></table></div>`; })()}
      <div class="ins-card"><h3>🏢 Substantial internal time <span>· &gt;40h · overhead, BOH &amp; PTO excluded</span></h3>${(overheadPpl.length || boh.length) ? `<div style="padding:8px 16px;border-bottom:1px dashed rgba(37,39,58,0.12);background:#faf9f7"><div style="display:flex;flex-wrap:wrap;gap:6px">${overheadPpl.map(r => `<span class="mv-chip" style="background:#e7eef0;color:#4a5560" title="Marked non-billable in Mapping — internal time is their job, this is expected">${esc(r.person.name)} · overhead</span>`).join('')}${boh.map(r => `<span class="mv-chip" style="background:#e7eef0" title="≥90% internal — looks like dedicated back-of-house. If that's their actual job, mark them non-billable in Mapping and they'll stop appearing here">${esc(r.person.name)} · ${Math.round(r.pct * 100)}%</span>`).join('')}</div></div>` : ''}${macro.length ? `<div style="max-height:320px;overflow-y:auto"><table class="dt"><thead><tr><th>Person</th><th class="num">Hrs</th><th class="num">%</th></tr></thead><tbody>${macro.map(r => `<tr><td class="pname">${esc(r.person.name)}</td><td class="num var-over"><b>${fH(r.hours)}</b>${r.ptoHours > 0 ? `<div class="vmini" style="color:#5a6070" title="Time off, counted separately — it is not part of the flag">+${fH(r.ptoHours)} PTO</div>` : ''}</td><td class="num">${Math.round(r.pct * 100)}%</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty" style="border:0">${hasAct ? 'Nobody over 40h.' : 'Needs Clockify actuals.'}</div>`}<div class="note-txt" style="padding:6px 16px 10px;font-size:11px">Counts work-type internal time only — PTO, vacation and holidays are shown beside the figure but never trigger the flag. Pure-overhead staff (admin, finance, BD…) shouldn't be here at all — <a href="#" data-goto-tab="mapping">mark them non-billable in Mapping</a> and this card skips them.</div></div>
    </div>`;
    $$('#p-insights [data-goto-tab]').forEach(a => a.onclick = (e) => { e.preventDefault(); const t = document.querySelector(`#tabs .tab[data-tab="${a.dataset.gotoTab}"]`); if (t) t.click(); });
  }

  /* ---------- TIME ENTRY COMPLIANCE — who logs, who's behind ----------
     Works off committed Clockify actuals (person × project × month). A month
     counts as "logged" against capacity (monthHours × cap%); people with
     allocations in a month but no hours are behind. The current month is
     judged by working days elapsed less a one-week grace, and is not judged
     at all until that grace is used up; the previous month is always fully
     due (staff.js currentMonthExpectation). ---------- */
  /* ---------- CLOCKIFY REPORTING (was "Time Entry") ----------
     Rebuilt to answer one question first — who do I need to chase, and by
     how much — instead of opening on a wall of percentages. The month grid
     survives one click away under "Month detail". Same engine
     (staff.js complianceRows) drives this tab AND the Excel export, so the
     two can never disagree. */
  /** Lateness rows (from the API pull) folded per person over a month window. */
  function latenessByPerson(ms, lateRowsAll) {
    const lateRows = (lateRowsAll || S.getLateness().rows).filter(r => ms.includes(r.ym));
    const latePP = {};
    lateRows.forEach(r => {
      const person = S.listPeople().find(p => S.namesMatch(p.name, r.user));
      if (state.group && !(person && S.inView(person))) return;   // team lag is the viewed group's lag
      const pid = person ? person.id : 'x:' + r.user;
      const a = latePP[pid] || (latePP[pid] = { name: person ? person.name : r.user, entries: 0, lagW: 0, maxLag: 0, w3: 0, w7: 0 });
      a.entries += r.entries; a.lagW += r.avgLag * r.entries; a.maxLag = Math.max(a.maxLag, r.maxLag);
      a.w3 += r.pctWithin3 * r.entries / 100; a.w7 += r.pctWithin7 * r.entries / 100;
    });
    const lagOf = (pid) => { const a = latePP[pid]; return a && a.entries ? a.lagW / a.entries : null; };
    const teamLag = (() => { const as = Object.values(latePP); const e = as.reduce((s, a) => s + a.entries, 0); return e ? as.reduce((s, a) => s + a.lagW, 0) / e : null; })();
    return { latePP, lagOf, teamLag };
  }
  /** One sentence on why a person is on the chase list — the shortest path
      from the tab (or the email) to fixed data. Empty months first, OLDEST
      first: a whole September with nothing in it matters more than an October
      six working days old, so the current month is named last, as "so far". */
  function chaseReasonFor(r, ctx) {
    const { ms, nowYm, expect, lagOf } = ctx;
    const lastTime = () => S.lastTimeEntered(r, ms).replace(/^./, c => c.toUpperCase());
    const lag = lagOf(r.person.id);
    const expMs = ms.filter(m => r.byMonth[m] && r.byMonth[m] !== 'leave' && !r.byMonth[m].early && !r.byMonth[m].joinMonth);
    const zeroMs = expMs.filter(m => r.byMonth[m].h === 0);
    const zeroPast = zeroMs.filter(m => m !== nowYm), zeroNow = zeroMs.includes(nowYm);
    if (zeroPast.length) {
      const whole = zeroPast.length === 1 ? 'the whole month' : 'whole months';
      return `Nothing logged for ${zeroPast.map(m => S.ymLabel(m)).join(', ')} — ${whole}, ${fmtH(zeroPast.reduce((s, m) => s + r.byMonth[m].capM, 0))} h, missing outright` +
        (zeroNow ? `, and nothing yet for ${S.ymLabel(nowYm)}` : '') + '. ' + lastTime() + '.';
    }
    if (zeroNow) return `Nothing logged yet for ${S.ymLabel(nowYm)} — working day ${expect.elapsed} of ${expect.total}, ${fmtH(r.byMonth[nowYm].capM)} h expected by now. ` + lastTime() + '.';
    const under = expMs.filter(m => r.byMonth[m].pct < 0.8).length;
    if (r.compliance < 0.5 && r.expectedMonths >= 3) return `Under target ${under} of ${expMs.length} months — their projects read as under-served in Compare even if the work happened.`;
    const recent = expMs.slice(-3);
    if (recent.length === 3 && recent.every(m => r.byMonth[m].pct < 0.8)) return `Slipping — 3 months in a row under target.`;
    if (lag != null && lag > 7) return `Logs late rather than not at all — ${lag.toFixed(1)}-day average lag.`;
    return `${fmtH(r.behindHrs)} h short of their own bar across the window.`;
  }

  function renderCompliance() {
    const late = S.getLateness();
    const topBar = `<div class="toolbar">
      <span class="note-txt">${late.at ? 'Entry lateness pulled ' + new Date(late.at).toLocaleString() + ' — refresh it in <a href="#" data-goto-tab="sources" style="font-weight:700">Data Sources</a>.' : 'Lag numbers are empty until entry lateness is pulled — <a href="#" data-goto-tab="sources" style="font-weight:700">pull it in Data Sources →</a>'}</span>
      <span class="grow"></span>
      <button class="btn btn-secondary" id="email-clockify" title="Compose the Clockify status email (Excel attached) and the personal nudges — you see each one and press Send yourself">✉ Email Clockify status…</button>
      <button class="btn btn-primary" id="export-timeentry" title="Download this report as Excel — same month grid, same colour coding, plus per-person detail and the not-tracked list">⭳ Export Clockify Reporting</button>
    </div>`;
    if (!S.hasActuals()) { $('#p-compliance').innerHTML = topBar + '<div class="empty">No Clockify actuals loaded — <a href="#" data-goto-tab="sources" style="font-weight:700">load them in Data Sources →</a>. This report is computed from logged hours by month.</div>'; wireLateness(); wireGoto('#p-compliance'); return; }
    const comp = S.complianceRows(months(), { clockifyUsers: state.clockifyUsers || [] });
    const ms = comp.months, rows = comp.rows, untracked = comp.untracked;
    const nowYm = comp.nowYm, prorata = comp.prorata, expect = comp.expect || { early: false, elapsed: 0, total: 0, grace: 5 };
    const dueLbl = expect.early
      ? `${S.ymLabel(nowYm)} not yet due · counts from working day ${expect.grace + 1}`
      : `${S.ymLabel(nowYm)} to date · working day ${expect.elapsed} of ${expect.total}, less a ${expect.grace}-day grace`;
    if (!ms.length) { $('#p-compliance').innerHTML = topBar + '<div class="empty">Window is entirely in the future — step back to see logged months.</div>'; wireLateness(); wireGoto('#p-compliance'); return; }

    // ---- lateness join + chase reasons: shared with the email composer ----
    const { latePP, lagOf, teamLag } = latenessByPerson(ms, late.rows);
    const totMissing = rows.reduce((s, r) => s + r.behindHrs, 0);
    const behindRows = rows.filter(S.isBehind);   // engine sorts behind-desc already; behind = more than a month of their own hours missing
    let nowH = 0, nowEff = 0;
    // capM is ALREADY pro-rated for the current month by the engine — don't re-apply.
    rows.forEach(r => { const c = r.byMonth[nowYm]; if (c && c !== 'leave' && !c.early && !c.joinMonth) { nowH += c.h; nowEff += c.capM; } });
    const nowPct = nowEff ? Math.round(nowH / nowEff * 100) : null;
    const reasonFor = (r) => chaseReasonFor(r, { ms, nowYm, expect, lagOf });
    const chaseTop = behindRows.slice(0, 4);
    const chaseSum = chaseTop.reduce((s, r) => s + r.behindHrs, 0);
    const chaseHtml = chaseTop.length ? `
      <div class="chase"><b>Chase ${chaseTop.length === 1 ? 'this person' : 'these ' + ['', '', 'two', 'three', 'four'][chaseTop.length] + ' first'}</b> — ${chaseTop.length === 1 ? 'they account' : 'together they account'} for <b>${fmtH(chaseSum)} h</b> of the ${fmtH(totMissing)} h missing.</div>
      <table class="dt" style="margin-bottom:18px"><thead><tr><th>Person</th><th class="num">Missing</th><th>Why it matters</th></tr></thead><tbody>
        ${chaseTop.map(r => `<tr>
          <td class="pname">${esc(r.person.name)}${personTags(r)}<div class="vmini">${esc(r.person.title || '')}</div></td>
          <td class="num" style="color:#8f2418;font-weight:800">${fmtH(r.behindHrs)} h</td>
          <td style="font-size:12.5px">${esc(reasonFor(r))}</td>
        </tr>`).join('')}
      </tbody></table>` : `<div class="note-txt" style="margin:0 0 14px;padding:8px 12px;background:#e7f0ee;border-left:3px solid var(--sav-teal)">✓ Nobody is meaningfully behind their own bar this window.</div>`;

    // ---- shared bits ----
    const q2 = (state.compSearch || '').toLowerCase();
    const matches = (r) => !q2 || (r.person.name + ' ' + (r.person.title || '')).toLowerCase().includes(q2);
    const view = state.compView || 'summary';
    const segBar = `<div class="toolbar" style="margin-bottom:10px">
      <div class="seg-view"><button id="cv-summary" class="${view === 'summary' ? 'on' : ''}" type="button">Summary</button><button id="cv-grid" class="${view === 'grid' ? 'on' : ''}" type="button">Month detail</button></div>
      <input type="search" id="comp-search" placeholder="Filter person or title…" value="${esc(state.compSearch || '')}">
      <span class="grow"></span>
      <span class="note-txt">${view === 'summary' ? 'Grouped by who needs attention · sparkline = the window month by month' : 'Every month as a % of that person’s own bar — click any column header to re-sort'}</span>
    </div>`;

    let bodyHtml = '';
    if (view === 'summary') {
      // ---- SUMMARY: grouped rows + sparklines, worst first ----
      const spark = (r) => '<span class="spark">' + ms.map(m => {
        const c = r.byMonth[m];
        if (c === 'leave') return '<i class="lv" style="height:20px" title="On leave"></i>';
        if (!c) return '<i class="na" style="height:4px" title="Not here yet / not expected"></i>';
        if (c.joinMonth) return `<i class="na" style="height:6px" title="${esc(S.ymLabel(m))}: joined this month — partial month, not scored${c.h ? ' · ' + fmtH(c.h) + ' h logged' : ''}"></i>`;
        if (c.early) return `<i class="na" style="height:6px" title="${esc(S.ymLabel(m))}: not yet due${c.h ? ' · ' + fmtH(c.h) + ' h logged so far' : ''}"></i>`;
        if (c.pct === 0) return `<i class="zero" style="height:3px" title="${esc(S.ymLabel(m))}: nothing logged"></i>`;
        const h = Math.max(3, Math.round(Math.min(c.pct, 1.25) / 1.25 * 20));
        return `<i${c.pct < 0.8 ? ' class="low"' : ''} style="height:${h}px" title="${esc(S.ymLabel(m))}: ${Math.round(c.pct * 100)}%"></i>`;
      }).join('') + '</span>';
      const TONE = { bad: '#8f2418', warn: '#8a6d00', ok: '#0E7C7B', mute: 'var(--sav-steel)', leave: '#6b3fa0' };
      const trendWord = (r) => { const n = S.complianceNote(r, comp); return [n.text, TONE[n.tone] || TONE.mute]; };
      const rowHtml = (r) => {
        const [word, col] = trendWord(r);
        const lag = lagOf(r.person.id);
        return `<tr>
          <td class="pname">${esc(r.person.name)}${personTags(r)}<div class="vmini">${esc(r.person.title || '')}</div></td>
          <td>${spark(r)} <span style="font-size:11.5px;color:${col}">${esc(word)}</span></td>
          <td class="num">${fmtH(r.totLogged)}</td>
          <td class="num">${fmtH(r.totCap)}</td>
          <td class="num" ${S.isBehind(r) ? 'style="color:#8f2418;font-weight:800"' : ''}>${r.behindHrs > 1 ? fmtH(r.behindHrs) : '—'}</td>
          <td class="num">${lag != null ? lag.toFixed(1) + ' d' : '—'}</td>
        </tr>`;
      };
      const measured = rows.filter(r => r.totCap > 0);
      const notMeasured = rows.filter(r => r.totCap <= 0);
      const gBehind = measured.filter(r => S.isBehind(r) && matches(r));
      const gOk = measured.filter(r => !S.isBehind(r) && matches(r)).sort((a, b) => a.person.name.localeCompare(b.person.name));
      const gNot = notMeasured.filter(matches);
      const unShown = untracked.filter(u => !q2 || u.person.name.toLowerCase().includes(q2));
      const grp = (label, note, n) => `<tr class="grouprow"><td colspan="6">${label} · ${n} ${n === 1 ? 'person' : 'people'} <span style="font-weight:400;color:var(--sav-steel)">— ${note}</span></td></tr>`;
      let sBody = '';
      if (gBehind.length) sBody += grp('Behind', 'more than a month of their own hours missing', gBehind.length) + gBehind.map(rowHtml).join('');
      if (gOk.length) sBody += grp('On target', 'nothing to do', gOk.length) + gOk.map(rowHtml).join('');
      if (gNot.length + unShown.length) sBody += grp('Not measured', 'on leave all window, or no hours can arrive for them', gNot.length + unShown.length)
        + gNot.map(rowHtml).join('')
        + unShown.map(u => `<tr><td class="pname">${esc(u.person.name)}<div class="vmini">${esc(u.person.title || '')}</div></td><td colspan="5" style="color:var(--sav-steel);font-size:12px">${esc(u.reason)} — <a href="#" data-goto-tab="mapping">fix in Mapping →</a></td></tr>`).join('');
      bodyHtml = `<div class="hm-wrap"><table class="dt"><thead><tr>
          <th style="width:24%">Person</th><th>Trend · ${ms.length} month${ms.length === 1 ? '' : 's'}</th>
          <th class="num">Logged</th><th class="num">Their bar</th><th class="num">Missing</th><th class="num">Avg lag</th>
        </tr></thead><tbody>${sBody || `<tr><td colspan="6"><div class="empty" style="border:0">Nobody matches the filter.</div></td></tr>`}</tbody></table></div>
        <div class="legend"><span>Bar height = % of their own bar that month</span><span><span class="sw" style="background:#0E7C7B"></span>≥80%</span><span><span class="sw" style="background:#e8b563"></span>under 80%</span><span><span class="sw" style="background:#e4453a"></span>zero</span><span><span class="sw" style="background:#b9a3d8"></span>🌴 leave</span><span><span class="sw" style="background:rgba(37,39,58,0.12)"></span>not here yet</span><span>"Their bar" = ${S.monthHours()} h × capacity % — part-timers are never judged against the full-time number, and months before someone's first logged hour aren't expected of them.</span></div>`;
    } else {
      // ---- MONTH DETAIL: the original grid — searchable, sortable ----
      const cellFor = (c) => {
        if (c === 'leave') return '<td title="On leave of absence — no hours expected"><span class="cell" style="background:#efe6f7;color:#6b3fa0">🌴</span></td>';
        if (!c) return '<td><span class="cell u0">·</span></td>';
        if (c.joinMonth) return `<td title="Joined this month — a partial month, shown but not scored${c.h ? '; ' + fmtH(c.h) + ' h logged' : ''}"><span class="cell u0">${c.h ? fmtH(c.h) + 'h' : 'joined'}</span></td>`;
        if (c.early) return `<td title="Not yet due — the month counts from working day ${expect.grace + 1}${c.h ? '; ' + fmtH(c.h) + ' h logged so far' : ''}"><span class="cell u0">${c.h ? fmtH(c.h) + 'h' : 'soon'}</span></td>`;
        const p = Math.round(c.pct * 100);
        const cls = p >= 100 ? 'u2' : p >= 80 ? 'u1' : p > 0 ? 'u3' : 'u5';
        return `<td title="${fmtH(c.h)} / ${fmtH(c.capM)} h"><span class="cell ${cls}" style="${p === 0 ? 'color:#fff' : ''}">${p}%</span></td>`;
      };
      const sort = state.compSort || { key: 'behind', dir: -1 };
      let shown = rows.filter(matches);
      const sortVal = (r) => {
        if (sort.key === 'name') return r.person.name.toLowerCase();
        if (sort.key === 'behind') return r.behindHrs;
        if (sort.key === 'target') return r.compliance;
        if (sort.key.startsWith('ym:')) { const c = r.byMonth[sort.key.slice(3)]; return c && c !== 'leave' ? c.pct : -1; }
        return 0;
      };
      shown.sort((a, b) => { const va = sortVal(a), vb = sortVal(b); return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * sort.dir; });
      let body = '';
      shown.forEach(r => {
        body += `<tr><td class="who"><div class="who-name" style="cursor:default">${esc(r.person.name)}${personTags(r)}</div><div class="who-meta">${esc(r.person.title || '')}</div></td>`;
        ms.forEach(ym => body += cellFor(r.byMonth[ym]));
        body += `<td class="pk ${S.isBehind(r) ? 'over' : ''}">${r.behindHrs > 1 ? fmtH(r.behindHrs) + 'h' : '—'}</td>`;
        body += `<td class="pk ${r.compliance < 0.5 ? 'over' : ''}">${Math.round(r.compliance * 100)}%</td></tr>`;
      });
      const arrow = (key) => sort.key === key ? (sort.dir > 0 ? ' ▲' : ' ▼') : '';
      const sortTh = (key, label, extra) => `<th ${extra || ''} data-csort="${key}" style="cursor:pointer" title="Click to sort">${label}${arrow(key)}</th>`;
      bodyHtml = `${untracked.length ? `<div class="note-txt" style="margin:0 0 10px;padding:8px 12px;background:#f4f2ef;border-left:3px solid #b0b5bc"><b>${untracked.length} ${untracked.length === 1 ? 'person is' : 'people are'} not tracked here</b> — no hours can arrive for them, so a 0% row would be meaningless: ${untracked.slice(0, 8).map(u => `${esc(u.person.name)} <span class="vmini">(${esc(u.reason)})</span>`).join(' · ')}${untracked.length > 8 ? ` · +${untracked.length - 8} more` : ''}. <a href="#" data-goto-tab="mapping">Map them in Mapping →</a></div>` : ''}
        <div class="hm-wrap"><table class="hm"><thead><tr>${sortTh('name', 'Person', 'class="who"')}${ms.map(m => sortTh('ym:' + m, esc(S.ymLabel(m)) + (m === nowYm ? '<div class="vmini" style="text-transform:none">' + (expect.early ? 'not yet due' : 'to date') + '</div>' : ''))).join('')}${sortTh('behind', 'Behind', 'class="pk"')}${sortTh('target', 'Months on target', 'class="pk"')}</tr></thead><tbody>${body || `<tr><td colspan="${ms.length + 3}"><div class="empty" style="border:0">Nobody matches the filter.</div></td></tr>`}</tbody></table></div>
        <div class="legend"><span><span class="sw" style="background:#cfe6e4"></span>≥100%</span><span><span class="sw" style="background:#eef4f4"></span>80–99% on target</span><span><span class="sw" style="background:#fce7c2"></span>1–79% behind</span><span><span class="sw" style="background:#e4453a"></span>0% nothing logged</span><span><span class="sw" style="background:#efe6f7"></span>🌴 on leave — not expected</span><span>· = not allocated / not here yet</span><span>Months before someone's first-ever logged hour aren't expected of them ("joined" tag)</span></div>`;
    }

    $('#p-compliance').innerHTML = topBar + `
      <div class="kpi-strip">
        <div class="kpi-card ${totMissing > 40 ? 'warn' : 'accent'}"><div class="k-num">${fmtH(totMissing)} h</div><div class="k-lbl">Hours missing · this window · vs each person's own bar</div></div>
        <div class="kpi-card ${behindRows.length ? 'warn' : ''}"><div class="k-num">${behindRows.length}<span style="font-size:14px;font-weight:400;color:var(--sav-steel)"> of ${rows.length}</span></div><div class="k-lbl">People behind (&gt;1 month of their own hours missing)</div></div>
        <div class="kpi-card ${nowPct != null && nowPct < 80 ? 'warn' : ''}"><div class="k-num">${nowPct != null ? nowPct + '%' : '—'}</div><div class="k-lbl">${expect.early ? esc(dueLbl) : 'Logged for ' + esc(dueLbl)}</div></div>
        <div class="kpi-card"><div class="k-num">${teamLag != null ? teamLag.toFixed(1) + ' d' : '—'}</div><div class="k-lbl">Avg days to log an entry${teamLag == null ? ' · pull lateness in Data Sources' : ''}</div></div>
      </div>
      ${chaseHtml}
      ${segBar}
      ${bodyHtml}`;

    const cvS = $('#cv-summary'), cvG = $('#cv-grid');
    if (cvS) cvS.onclick = () => { state.compView = 'summary'; renderCompliance(); };
    if (cvG) cvG.onclick = () => { state.compView = 'grid'; renderCompliance(); };
    const cs = $('#comp-search');
    if (cs) cs.oninput = searchBox('#comp-search', v => { state.compSearch = v; renderCompliance(); });
    $$('#p-compliance [data-csort]').forEach(th => th.onclick = () => {
      const k = th.dataset.csort;
      const cur = state.compSort || { key: 'behind', dir: -1 };
      // First click always lands on the "needs attention" end: most hours
      // behind, LOWEST months-on-target / month %, names A→Z. Click again to flip.
      const firstDir = (k === 'behind') ? -1 : 1;
      state.compSort = { key: k, dir: cur.key === k ? -cur.dir : firstDir };
      renderCompliance();
    });
    wireGoto('#p-compliance');
    wireLateness();
    const em = $('#email-clockify'); if (em) em.onclick = () => openMailModal();
  }

  /* ---------- EMAIL CLOCKIFY STATUS · composed here, sent by hand ----------
     One modal, two tabs. "Status digest" is one email to the admins (or
     whoever is typed into To) with the whole table in the body and the
     Clockify Reporting workbook attached. "Nudges" is one short email per
     person who is behind, to the address Clockify holds for them. Every
     message is previewed exactly as it will land; nothing goes until Send is
     pressed, and then it goes through the same outbox as every other notice. */
  const MAIL = { tab: 'digest', to: '', cc: '', subject: '', attach: true, picked: {}, emails: {}, emailSrc: {}, preview: null, from: '', until: '', snap: null, edits: {} };
  /* edits: hand changes to a generated email, keyed 'digest' or a person id →
     { subject, html }. The preview is the editor: whatever it shows is what
     goes. A range change throws edits away (the numbers underneath moved). */
  const htmlToText = (h) => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<\/(p|div|tr|h\d|li)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
  function mailFor(key, generated) {
    const e = MAIL.edits[key];
    if (!e) return { subject: generated.subject, html: generated.html, text: generated.text, edited: false };
    const html = e.html != null ? e.html : generated.html;
    return { subject: e.subject || generated.subject, html, text: htmlToText(html), edited: true };
  }
  function wireEditor(key, generated) {
    const ed = $('#mm-editor'); if (!ed) return;
    ed.oninput = () => { MAIL.edits[key] = Object.assign({}, MAIL.edits[key], { html: ed.innerHTML }); const r = $('#mm-reset'); if (r) r.style.display = ''; const l = $('#mm-edited'); if (l) l.textContent = 'edited'; };
    const r = $('#mm-reset'); if (r) r.onclick = (e) => { e.preventDefault(); delete MAIL.edits[key]; if (key !== 'digest') MAIL.subject = ''; renderMailModal(); };
    const sub = $('#mm-subject'); if (sub) sub.oninput = (e) => { MAIL.edits[key] = Object.assign({}, MAIL.edits[key], { subject: e.target.value }); if (key === 'digest') MAIL.subject = e.target.value; };
  }
  const editorHtml = (lbl, m) => `<div class="mm-preview-lbl">${lbl} · <span id="mm-edited">${m.edited ? 'edited' : 'exactly what lands in the inbox'}</span> · click into the email to change the wording <a href="#" id="mm-reset" style="${m.edited ? '' : 'display:none'}">Reset to generated</a></div>
        <div class="mm-preview" id="mm-editor" contenteditable="true" spellcheck="true">${m.html}</div>`;
  /** Months the email can cover: everything with hours, up to the current month. */
  function mailMonthChoices() {
    const db = S.readDb(); const now = S.currentYM();
    const set = new Set((db.meta && db.meta.clockifyMonths) || []);
    Object.keys(db.actuals || {}).forEach(k => set.add(k.split('|')[2]));
    return [...set].filter(m => /^\d{4}-\d{2}$/.test(m) && m <= now).sort();
  }
  /** The email's own numbers for the chosen range — not the tab's window. */
  function mailRange() {
    const all = mailMonthChoices(); if (!all.length) return [];
    const from = MAIL.from && all.includes(MAIL.from) ? MAIL.from : all[Math.max(0, all.length - 3)];
    const until = MAIL.until && all.includes(MAIL.until) ? MAIL.until : all[all.length - 1];
    MAIL.from = from <= until ? from : until; MAIL.until = until;
    return all.filter(m => m >= MAIL.from && m <= MAIL.until);
  }
  function mailSnap() {
    const ms = mailRange(); if (!ms.length) return null;
    const comp = S.complianceRows(ms, { clockifyUsers: state.clockifyUsers || [] });
    const nowYm = comp.nowYm, expect = comp.expect || { early: false, elapsed: 0, total: 0, grace: 5 };
    const dueLbl = expect.early ? `${S.ymLabel(nowYm)} not yet due · counts from working day ${expect.grace + 1}` : `${S.ymLabel(nowYm)} to date · working day ${expect.elapsed} of ${expect.total}, less a ${expect.grace}-day grace`;
    const { lagOf, teamLag } = latenessByPerson(comp.months);
    const reasonFor = (r) => chaseReasonFor(r, { ms: comp.months, nowYm, expect, lagOf });
    return { comp, ms: comp.months, rows: comp.rows, untracked: comp.untracked, nowYm, dueLbl, teamLag, expect, lagOf, reasonFor, pulledAt: (S.readDb().meta || {}).clockifyImportedAt || null };
  }
  /* The address for a nudge: the Clockify user pinned to this person, then a
     Clockify user with the same name, then the roster, then the firm's
     first-initial+surname pattern as a GUESS the sender should check. */
  function emailForPerson(p) {
    const users = state.clockifyUsers || [];
    const maps = (S.getMappings().users) || {};
    const nk = (n) => String(n || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const pinned = users.find(u => maps[nk(u.name)] === p.id && u.email);
    const hit = pinned || users.find(u => S.namesMatch(p.name, u.name) && u.email);
    if (hit) { MAIL.emailSrc[p.id] = 'clockify'; return String(hit.email).toLowerCase(); }
    const r = S.personEmail(p); MAIL.emailSrc[p.id] = r.source; return r.email;
  }
  async function openMailModal() {
    if (!mailSnap()) { toast('No Clockify hours loaded yet — pull them in Data Sources first.'); return; }
    const ov = $('#mail-modal'); ov.classList.add('open');
    MAIL.tab = 'digest';
    MAIL.to = MAIL.to || (STORE.adminEmails ? STORE.adminEmails().join('; ') : '');
    MAIL.cc = MAIL.cc || (STORE.bookWatcherEmails ? STORE.bookWatcherEmails().join('; ') : '');   // Emily Glatt, Emily Sobel, Jeff Santoro — not the sender
    renderMailModal();
    if (!(state.clockifyUsers || []).length) { try { await pullClockifyNames(); } catch (e) {} renderMailModal(); }
  }
  function closeMailModal() { $('#mail-modal').classList.remove('open'); }
  function mailCtx() { const s = mailSnap(); return { nowYm: s.nowYm, expect: s.expect, dueLbl: s.dueLbl, teamLag: s.teamLag, lagOf: s.lagOf, reasonFor: s.reasonFor, lastEntry: (r) => S.lastTimeEntered(r, s.ms), toolUrl: location.origin + location.pathname, pulledAt: s.pulledAt ? new Date(s.pulledAt).toLocaleDateString() : null }; }
  /* Anyone with hours missing in the range can be nudged — the list is
     everyone short, most-short first; the ones more than a month behind are
     ticked by default, the rest are a click away. */
  function behindRows() { const s = mailSnap(); return s.rows.filter(r => (r.behindHrs || 0) > 0).sort((a, b) => (S.isBehind(b) ? 1 : 0) - (S.isBehind(a) ? 1 : 0) || (b.behindHrs || 0) - (a.behindHrs || 0)); }
  function renderMailModal() {
    const s = mailSnap(); if (!s) return;
    const body = $('#mm-body'), note = $('#mm-note'), send = $('#mm-send');
    $$('#mail-modal .mm-tabs button').forEach(b => b.classList.toggle('on', b.dataset.mm === MAIL.tab));
    const behind = behindRows();
    $('#mm-nudge-n').textContent = behind.length;
    const authed = !!(window.UFC_Box && window.UFC_Box.enabled && window.UFC_Box.isAuthed && window.UFC_Box.isAuthed());
    const choices = mailMonthChoices();
    const opt = (sel) => choices.map(m => `<option value="${m}" ${m === sel ? 'selected' : ''}>${esc(S.ymLabel(m))}</option>`).join('');
    const rangeRow = `<div class="mm-row"><label>Months</label><div class="mm-range"><select id="mm-from">${opt(MAIL.from)}</select><span>to</span><select id="mm-until">${opt(MAIL.until)}</select><span class="note-txt">${s.ms.length} month${s.ms.length === 1 ? '' : 's'} · the email covers only this range</span></div></div>`;
    if (MAIL.tab === 'digest') {
      const gen = S.clockifyStatusEmail(s.comp, mailCtx());
      const mail = mailFor('digest', gen);
      MAIL.subject = mail.subject;
      $('#mm-title').textContent = 'Email Clockify status · ' + gen.counts.people + ' people';
      body.innerHTML = rangeRow + `
        <div class="mm-row"><label>To</label><input type="text" id="mm-to" value="${esc(MAIL.to)}" placeholder="addresses separated by ;"></div>
        <div class="mm-row"><label>Cc</label><input type="text" id="mm-cc" value="${esc(MAIL.cc)}"></div>
        <div class="mm-row"><label>Subject</label><input type="text" id="mm-subject" value="${esc(mail.subject)}"></div>
        <label class="mm-check"><input type="checkbox" id="mm-attach" ${MAIL.attach ? 'checked' : ''}> Attach the Clockify Reporting workbook (the same Excel as the export button)</label>
        ${editorHtml('Preview', mail)}`;
      $('#mm-to').oninput = (e) => { MAIL.to = e.target.value; };
      $('#mm-cc').oninput = (e) => { MAIL.cc = e.target.value; };
      $('#mm-attach').onchange = (e) => { MAIL.attach = e.target.checked; };
      wireEditor('digest', gen);
      send.textContent = 'Send status email'; send.disabled = !authed;
      note.textContent = authed ? 'Goes through the notifications outbox, from PPMRevenueSystem@savills.us.' : 'Sign in to Box to send.';
      wireMailRange();
    } else {
      // Nudges: who, to which address, and a preview of the highlighted one.
      behind.forEach(r => { if (!(r.person.id in MAIL.emails)) MAIL.emails[r.person.id] = emailForPerson(r.person); if (!(r.person.id in MAIL.picked)) MAIL.picked[r.person.id] = !!MAIL.emails[r.person.id] && S.isBehind(r); });
      const overN = behind.filter(S.isBehind).length;
      if (!MAIL.preview || !behind.some(r => r.person.id === MAIL.preview)) MAIL.preview = behind.length ? behind[0].person.id : null;
      const pv = behind.find(r => r.person.id === MAIL.preview);
      const gen = pv ? S.clockifyNudgeEmail(pv, mailCtx()) : null;
      const mail = pv ? mailFor(pv.person.id, gen) : null;
      const n = behind.filter(r => MAIL.picked[r.person.id] && MAIL.emails[r.person.id]).length;
      const addressable = behind.filter(r => MAIL.emails[r.person.id]).length;
      const editedN = behind.filter(r => MAIL.edits[r.person.id]).length;
      $('#mm-title').textContent = 'Nudge · ' + behind.length + ' ' + (behind.length === 1 ? 'person has' : 'people have') + ' hours missing' + (overN ? ' · ' + overN + ' more than a month behind' : '');
      body.innerHTML = rangeRow + (behind.length ? `
        <div class="note-txt">One short email each, to the address Clockify holds for them (or the roster's). An amber address is the firm's first-initial-surname pattern guessed from the name — check it; whatever you type is kept on the roster. Everyone with hours missing in this range is listed, most-short first; the <b>&gt;1 mo</b> rows are ticked to start with, tick anyone else you want to nudge. Click a row to preview their email; click into the preview to reword it for that person only.${(state.clockifyUsers || []).length ? '' : ' Clockify addresses are loading…'}</div>
        <div class="mm-pickbar"><span><b>${n}</b> of ${addressable} with an address selected${editedN ? ` · ${editedN} reworded` : ''}</span><a href="#" id="mm-all">Select all</a><a href="#" id="mm-over" title="Only the people more than a month of their own hours behind">Select &gt;1 month behind</a><a href="#" id="mm-none">Deselect all</a></div>
        <div class="mm-people"><table><tbody>${behind.map(r => `<tr class="${r.person.id === MAIL.preview ? 'sel' : ''}" data-pid="${esc(r.person.id)}">
          <td style="width:28px"><input type="checkbox" data-pick="${esc(r.person.id)}" ${MAIL.picked[r.person.id] ? 'checked' : ''} ${MAIL.emails[r.person.id] ? '' : 'disabled'}></td>
          <td><b>${esc(r.person.name)}</b>${S.isBehind(r) ? ' <span class="nh-tag" style="background:#fbe9e7;color:#8f2418" title="More than a month of their own hours missing">&gt;1 mo</span>' : ''}${MAIL.edits[r.person.id] ? ' <span class="nh-tag" title="You changed this person\'s email">reworded</span>' : ''}<div class="vmini">${esc(r.person.title || '')}</div></td>
          <td class="num" style="color:#8f2418;font-weight:800;white-space:nowrap">${fmtH(r.behindHrs)} h<div class="vmini" style="font-weight:400">≈ ${(Math.round(S.behindMonths(r) * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 })} mo</div></td>
          <td style="width:40%"><input type="text" data-email="${esc(r.person.id)}" value="${esc(MAIL.emails[r.person.id] || '')}" placeholder="no address — type one"${MAIL.emailSrc[r.person.id] === 'guess' ? ' style="border-color:#e8b563;background:#fffbf0" title="Guessed from the name — not from Clockify or the roster"' : ''}>${MAIL.emails[r.person.id] ? (MAIL.emailSrc[r.person.id] === 'guess' ? '<div class="miss" style="color:#8a6d00">guessed from the name — check it</div>' : '') : '<div class="miss">No address on Clockify or the roster</div>'}</td>
        </tr>`).join('')}</tbody></table></div>
        <div class="mm-row"><label>Cc</label><input type="text" id="mm-cc" value="${esc(MAIL.cc)}"></div>
        ${pv ? `<div class="mm-row"><label>Subject</label><input type="text" id="mm-subject" value="${esc(mail.subject)}"></div>` : ''}
        ${mail ? editorHtml('Preview · ' + esc(pv.person.name), mail) : ''}` : '<div class="empty" style="border:0">Nobody has hours missing in this range. Nothing to nudge.</div>');
      const setAll = (v) => { behind.forEach(r => { if (MAIL.emails[r.person.id]) MAIL.picked[r.person.id] = v; }); renderMailModal(); };
      const all = $('#mm-all'); if (all) all.onclick = (e) => { e.preventDefault(); setAll(true); };
      const none = $('#mm-none'); if (none) none.onclick = (e) => { e.preventDefault(); setAll(false); };
      const over = $('#mm-over'); if (over) over.onclick = (e) => { e.preventDefault(); behind.forEach(r => { MAIL.picked[r.person.id] = !!MAIL.emails[r.person.id] && S.isBehind(r); }); renderMailModal(); };
      if (pv) wireEditor(pv.person.id, gen);
      $$('#mm-body [data-pick]').forEach(cb => cb.onchange = (e) => { MAIL.picked[cb.dataset.pick] = e.target.checked; renderMailModal(); });
      $$('#mm-body [data-email]').forEach(inp => { inp.oninput = (e) => { MAIL.emails[inp.dataset.email] = e.target.value.trim().toLowerCase(); if (!MAIL.emails[inp.dataset.email]) MAIL.picked[inp.dataset.email] = false; else if (!(inp.dataset.email in MAIL.picked)) MAIL.picked[inp.dataset.email] = true; }; inp.onchange = () => { const v = MAIL.emails[inp.dataset.email] || ''; if (v && /@/.test(v)) { S.setPersonEmail(inp.dataset.email, v); MAIL.emailSrc[inp.dataset.email] = 'roster'; } renderMailModal(); }; inp.onclick = (e) => e.stopPropagation(); });
      $$('#mm-body tr[data-pid]').forEach(tr => tr.onclick = (e) => { if (e.target.closest('input')) return; MAIL.preview = tr.dataset.pid; renderMailModal(); });
      const cc = $('#mm-cc'); if (cc) cc.oninput = (e) => { MAIL.cc = e.target.value; };
      send.textContent = 'Send ' + n + ' nudge' + (n === 1 ? '' : 's'); send.disabled = !authed || !n;
      note.textContent = authed ? (n ? 'Each person gets only their own email.' : 'Tick at least one person with an address.') : 'Sign in to Box to send.';
      wireMailRange();
    }
  }
  function wireMailRange() {
    const f = $('#mm-from'), u = $('#mm-until'); if (!f || !u) return;
    const apply = () => { MAIL.from = f.value; MAIL.until = u.value; if (MAIL.from > MAIL.until) { const t = MAIL.from; MAIL.from = MAIL.until; MAIL.until = t; } MAIL.subject = ''; MAIL.picked = {}; MAIL.preview = null; MAIL.edits = {}; renderMailModal(); };
    f.onchange = apply; u.onchange = apply;
  }
  const splitAddrs = (v) => String(v || '').split(/[;,\s]+/).map(x => x.trim().toLowerCase()).filter(x => /@/.test(x));
  async function sendMail() {
    const s = mailSnap(); const B = window.UFC_Box; if (!s || !B || !B.notify) return;
    const send = $('#mm-send'); send.disabled = true; const note = $('#mm-note');
    try {
      if (MAIL.tab === 'digest') {
        const to = splitAddrs(MAIL.to); if (!to.length) { toast('Add at least one address in To.'); send.disabled = false; return; }
        const gen = S.clockifyStatusEmail(s.comp, mailCtx());
        const mail = mailFor('digest', gen);
        const attachments = [];
        if (MAIL.attach) {
          note.textContent = 'Building the workbook…';
          const wb = await window.UFC_buildTimeEntryWorkbook(s.ms, { clockifyUsers: state.clockifyUsers || [] });
          const buf = await wb.xlsx.writeBuffer();
          const bytes = new Uint8Array(buf); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          attachments.push({ Name: wb.__fileName || 'Clockify-Reporting.xlsx', ContentBytes: btoa(bin), ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        }
        B.notify({ event: 'clockify-status', to, cc: splitAddrs(MAIL.cc), subject: mail.subject, html: mail.html, text: mail.text, attachments, data: gen.counts });
        try { STORE.logSystem && STORE.logSystem('clockify-email', { kind: 'status', to: to.length, people: gen.counts.people, behind: gen.counts.behind, cost: gen.counts.cost, attached: attachments.length, edited: mail.edited }); } catch (e) {}
        if (B.flushNotify) B.flushNotify().catch(() => {});
        toast('Status email queued to ' + to.length + ' address' + (to.length === 1 ? '' : 'es') + (attachments.length ? ' with the workbook attached' : '') + '.', 'ok');
      } else {
        const picked = behindRows().filter(r => MAIL.picked[r.person.id] && MAIL.emails[r.person.id]);
        if (!picked.length) { send.disabled = false; return; }
        picked.forEach(r => { const m = mailFor(r.person.id, S.clockifyNudgeEmail(r, mailCtx())); B.notify({ event: 'clockify-nudge', to: [MAIL.emails[r.person.id]], cc: splitAddrs(MAIL.cc), subject: m.subject, html: m.html, text: m.text, data: { personId: r.person.id, behindHrs: Math.round(r.behindHrs * 10) / 10, edited: m.edited } }); });
        try { STORE.logSystem && STORE.logSystem('clockify-email', { kind: 'nudge', people: picked.length, names: picked.map(r => r.person.name).join(', '), edited: picked.filter(r => MAIL.edits[r.person.id]).length }); } catch (e) {}
        if (B.flushNotify) B.flushNotify().catch(() => {});
        toast(picked.length + ' nudge' + (picked.length === 1 ? '' : 's') + ' queued.', 'ok');
      }
      closeMailModal();
    } catch (e) { toast('Could not send: ' + (e.message || e)); send.disabled = false; }
  }
  function wireMailModal() {
    const ov = $('#mail-modal'); if (!ov) return;
    $('#mm-close').onclick = closeMailModal; $('#mm-cancel').onclick = closeMailModal;
    ov.onclick = (e) => { if (e.target === ov) closeMailModal(); };
    $$('#mail-modal .mm-tabs button').forEach(b => b.onclick = () => { MAIL.tab = b.dataset.mm; renderMailModal(); });
    $('#mm-send').onclick = sendMail;
  }

  /** The little fairness tags every person-row carries (PT / INT / joined / leave). */
  function personTags(r) {
    const ptTag = (r.person.capacityPct != null && r.person.capacityPct < 100 && !r.person.nonBillable)
      ? ` <span class="nh-tag" style="background:#e3ecf7;color:#2f5d8f" title="Part time — every month here is judged against ${r.person.capacityPct}% of a full month (≈${Math.round(S.monthHours() * r.person.capacityPct / 100)} h)">PT · ${r.person.capacityPct}%</span>` : '';
    const intTag = r.person.nonBillable ? ' <span class="nh-tag" style="background:#e7eef0;color:#4a5560" title="Internal / overhead — still expected to log their hours, internal projects count">INT</span>' : '';
    const joinTag = r.joinedMid ? ` <span class="nh-tag" title="First logged hour ${esc(S.ymLabel(r.joined))} — earlier months aren't expected of them">joined ${esc(S.ymLabel(r.joined))}</span>` : '';
    const lvTag = r.leaveMonths ? ` <span class="nh-tag" style="background:#efe6f7;color:#6b3fa0" title="On a leave of absence for ${r.leaveMonths} month${r.leaveMonths === 1 ? '' : 's'} of this window — those months aren't counted">🌴 ${r.leaveMonths} mo</span>` : '';
    return ptTag + intTag + joinTag + lvTag;
  }

  function wireLateness() {
    const ex = $('#export-timeentry');
    if (ex) ex.onclick = async () => {
      const orig = ex.textContent;
      ex.disabled = true; ex.textContent = 'Building…';
      try { await window.UFC_buildAndDownloadTimeEntryExport(months(), { clockifyUsers: state.clockifyUsers || [] }); toast('Clockify Reporting exported.'); }
      catch (e) { console.error(e); UFC_UI.toast('Export failed: ' + (e && e.message ? e.message : e)); }
      finally { ex.disabled = false; ex.textContent = orig; }
    };
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
        const rows = S.parseCsvRows(await res.text()).map(o => ({ user: o.User, ym: o.Month, entries: +o.Entries || 0, hours: +o.Hours || 0, avgLag: +o.AvgLagDays || 0, maxLag: +o.MaxLagDays || 0, pctWithin3: +o.PctWithin3d || 0, pctWithin7: +o.PctWithin7d || 0, lastWorked: o.LastWorked || '', lastEntered: o.LastEntered || '' }));
        S.setLateness(rows);
        renderActive();   // bound from Data Sources and Clockify Reporting alike
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
      // MERGE rather than replace: anything saved locally but not yet pushed
      // (offline, failed push, another tab) survives the reconnect.
      if (remote) { if (S.mergeFromRemote) S.mergeFromRemote(remote); else S.hydrateFromRemote(remote); }
      else await Box.uploadStaff(S.readDb());               // first run: seed staff.json from local
      let t = null, pushing = false;
      S.attachRemote((db) => {
        clearTimeout(t); pushing = true;
        t = setTimeout(async () => {
          try { Box.emitSync && Box.emitSync('syncing', 'staff.json'); await Box.uploadStaff(db); Box.emitSync && Box.emitSync('synced', ''); setStoreNote('box'); toast('Saved — synced to Box ✓'); }
          catch (e) { Box.emitSync && Box.emitSync('error', 'staff.json: ' + e.message); setStoreNote('error', e.message); }
          finally { pushing = false; }
        }, 1200);
      });
      setStoreNote('box');
      // Mapping decisions shipped as code — applied once, here, after the merge
      // and with the push hook attached, so they land in Box like any edit.
      try { const n = S.applyMappingSeeds ? S.applyMappingSeeds() : []; if (n.length) { toast(n.length + ' mapping fix' + (n.length === 1 ? '' : 'es') + ' applied and saved.', 'ok'); } } catch (e) { console.warn('mapping seeds', e); }
      // Data repairs shipped as code (the allocations deep dive) — same rule: once, here, logged.
      try { const c = S.applyCleanupSeeds ? S.applyCleanupSeeds() : []; if (c.length) { const r = c[0]; toast(`Allocations cleanup applied: ${r.merges} people merged, ${r.renames} project names folded, ${r.deletes} duplicate rows removed, ${r.ended} row ended.`, 'ok'); if (state.winStart) renderAll(); } } catch (e) { console.warn('cleanup seeds', e); }
      // Live refresh: when the tab regains focus (and every 3 min) check the file's
      // etag; if a teammate saved, hydrate + re-render — mappings flow to everyone.
      const refresh = async () => {
        if (pushing || document.hidden || !Box.pullStaffIfChanged) return;
        // Never pull the rug while a row is being edited.
        if (state.editingAlloc !== null) return;
        const openModal = document.querySelector('#alloc-modal.open');
        if (openModal) return;
        try {
          const r = await Box.pullStaffIfChanged();
          if (r) {
            // Merge, so a teammate's refresh can't wipe edits this tab hasn't pushed.
            if (S.mergeFromRemote) S.mergeFromRemote(r); else S.hydrateFromRemote(r);
            renderAll();
            toast('Refreshed — a teammate saved changes to staff.json.');
          }
        } catch (e) {}
      };
      document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
      setInterval(refresh, 180000);
    } catch (e) { setStoreNote('error', e.message); }
  }

  /* ---------- matrix file re-import ---------- */
  function wireMatrixImport() {
    const fi = $('#matrix-file'); if (!fi) return;
    fi.onchange = async () => {
      const f = fi.files[0]; fi.value = ''; if (!f) return;
      const res = await S.parseMatrixFile(f);
      if (res.error) { UFC_UI.toast('Import failed — ' + res.error); return; }
      const people = new Set(res.rows.map(r => r.person)).size, projects = new Set(res.rows.map(r => r.proj)).size;
      if (!confirm(`Replace the allocation matrix with “${f.name}”?\n\n${res.rows.length} allocations · ${people} people · ${projects} projects.\n\nClockify actuals and roster capacity/title edits are KEPT. Manually-added allocations and note edits made here since the last import are REPLACED by the sheet.`)) return;
      const out = S.importMatrix(res.rows, f.name);
      renderAll();
      toast(`Matrix replaced — ${out.allocations} allocations, ${out.people} people.`);
    };
  }

  /* ---------- DATA SOURCES — every feed in one place: what it is, what it
     drives, when it last moved, and the one control that refreshes it. The
     Clockify import card lives here now; Compare just reads the result. ---------- */
  function ageDays(iso) { return iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null; }
  function agoTxt(iso) {
    const d = ageDays(iso);
    if (d == null) return 'never';
    if (d === 0) return 'today';
    if (d === 1) return 'yesterday';
    if (d < 45) return d + ' days ago';
    return new Date(iso).toLocaleDateString();
  }
  /** Project names still without a fee project — rows parked under an old matrix name. */
  function unlinkedProjects() { return S.legacyProjects().map(g => g.name); }

  function renderSources() {
    const meta = S.readDb().meta || {};
    const has = S.hasActuals();
    const am = S.actualsMeta();
    const late = S.getLateness();
    const dot = (cls) => `<span class="fs-dot ${cls}" style="display:inline-block;margin-right:2px"></span>`;
    const aAge = ageDays(am.importedAt);
    const aDot = aAge == null ? 'bad' : aAge <= 7 ? 'ok' : aAge <= 21 ? 'warn' : 'bad';
    const unlinked = unlinkedProjects();
    const linkable = S.planProjects().filter(p => !p.internal).length;
    const unmappedCk = S.unmappedClockify();
    const lAge = ageDays(late.at);

    const row = (name, feeds, lastHtml, statusHtml, actionHtml) => `<tr>
      <td class="pname" style="white-space:nowrap">${name}</td>
      <td class="vmini" style="max-width:320px">${feeds}</td>
      <td>${lastHtml}</td>
      <td>${statusHtml}</td>
      <td style="white-space:nowrap">${actionHtml}</td>
    </tr>`;

    let html = `<div class="note-txt" style="margin:0 0 12px;padding:10px 14px;background:#fff;border:1px solid rgba(37,39,58,0.12);border-left:4px solid var(--sav-teal)">Everything the Review tabs read comes through here. Each feed shows when it last moved and who touched it — refresh a feed and every tab updates; nothing else on this page writes data behind your back.</div>
      <table class="dt" style="margin-bottom:18px"><thead><tr><th>Feed</th><th>What it drives</th><th>Last updated</th><th>Status</th><th>Refresh</th></tr></thead><tbody>
      ${row('③ Clockify actuals',
        'Compare, Clockify Reporting, Insights — every &ldquo;what actually happened&rdquo; number.',
        has ? `${esc(agoTxt(am.importedAt))}${am.importedAt ? ` <span class="vmini">· ${new Date(am.importedAt).toLocaleString()}</span>` : ''}<div class="vmini">${am.rows.toLocaleString()} rows · ${(am.months || []).length} month${(am.months || []).length === 1 ? '' : 's'}${(am.months || []).length ? ' · ' + esc(S.ymLabel(am.months[0]) + ' – ' + S.ymLabel(am.months[am.months.length - 1])) : ''}</div>` : '<span style="color:#8f2418">never loaded</span>',
        dot(aDot) + (aAge == null ? 'missing' : aAge <= 7 ? 'fresh' : aAge <= 21 ? 'aging' : 'stale'),
        '<a href="#import-anchor" style="font-weight:700">Import card below ↓</a>')}
      ${row('① Allocations <span class="vmini">(maintained in this tool)</span>',
        'The plan side of Compare, By Project, By Person, and the contract bridge. Edit rows on the <b>Allocations</b> tab, or take the whole matrix out to Excel with the <b>round trip</b> (pending contract adds come out as ready-made yellow rows), clean it up and put it back. The sheet re-import is only for starting over.',
        `${meta.updatedAt ? `Last edit ${esc(agoTxt(meta.updatedAt))}${meta.updatedBy ? ` by <b>${esc(meta.updatedBy)}</b>` : ''}` : '—'}<div class="vmini">${meta.matrixImportedAt ? `Seeded from ${esc(meta.matrixSource || 'JS sheet')} · ${new Date(meta.matrixImportedAt).toLocaleDateString()}` : 'No sheet import on record'}</div>`,
        dot('ok') + 'live',
        `<button class="btn btn-primary" id="rt-export" title="Every allocation plus every pending contract add (yellow rows — put ADD in Action to accept) in one editable workbook. Edit, then Put it back.">⇩ Excel round trip</button>
         <button class="btn btn-ghost" id="rt-import" title="Import the round-trip workbook you edited. You see every add, change and remove before anything is written.">⇪ Put it back</button><input type="file" id="rt-file" accept=".xlsx" hidden>
         <button class="btn btn-ghost" id="src-reimport" title="Replace ALL allocations from a fresh export of the staffing sheet (Data tab or CSV). Actuals and roster edits are kept.">⇪ Re-import sheet</button>`)}
      ${row('② Fee-tool contract lines',
        'The priced roles behind &ldquo;② Contract&rdquo; in Compare and the contract-vs-staffing checks.',
        `${linkable - unlinked.length} of ${linkable} projects linked`,
        dot(unlinked.length ? 'warn' : 'ok') + (unlinked.length ? unlinked.length + ' unlinked' : 'all linked'),
        '<a href="#" data-goto-tab="mapping" style="font-weight:700">Fix in Mapping →</a>')}
      ${row('🐌 Entry lateness',
        'The &ldquo;avg days to log&rdquo; column and lag KPI in Clockify Reporting.',
        late.at ? `${esc(agoTxt(late.at))} <span class="vmini">· ${new Date(late.at).toLocaleString()}</span>` : 'never pulled',
        dot(late.at ? (lAge <= 21 ? 'ok' : 'warn') : 'warn') + (late.at ? 'loaded' : 'optional'),
        '<button class="btn btn-ghost" id="pull-lateness">⟳ Pull lateness (API)</button>')}
      </tbody></table>
      <div class="note-txt" id="late-note" style="margin:-10px 0 14px"></div>`;

    // Data health — the gaps that quietly corrupt the numbers downstream.
    {
      const missEnd = S.listAllocations().filter(a => !a.end).length;
      const noTitle = S.listPeople().filter(p => p.active !== false && !(p.title || '').trim()).length;
      const bits = [];
      if (missEnd) bits.push(`<a href="#" data-goto-tab="allocations"><b>${missEnd}</b> allocation${missEnd === 1 ? '' : 's'} missing an end date</a>`);
      if (noTitle) bits.push(`<a href="#" data-goto-tab="mapping"><b>${noTitle}</b> ${noTitle === 1 ? 'person' : 'people'} without a title</a> (their cost rate reads $0)`);
      if (unlinked.length) bits.push(`<a href="#" data-goto-tab="allocations"><b>${unlinked.length}</b> project name${unlinked.length === 1 ? '' : 's'} still need a fee project</a> (rows under an old matrix name — no ② Contract line)`);
      if (unmappedCk.length) bits.push(`<a href="#" data-goto-tab="mapping"><b>${unmappedCk.length}</b> Clockify project${unmappedCk.length === 1 ? '' : 's'} with hours and no fee project</a> (${fmtH(unmappedCk.reduce((t, u) => t + u.hours, 0))} h shown as “no project”)`);
      if (bits.length) html += `<div class="note-txt" style="margin:0 0 14px;padding:8px 12px;background:#fdf6e3;border-left:3px solid #e8b563">🩺 Data health: ${bits.join(' · ')}</div>`;
    }

    html += `<div id="import-anchor"></div>` + importCard(has, am);
    if (state.clockifyReport) html += reportBlock(state.clockifyReport);

    $('#p-sources').innerHTML = html;
    wireImport();
    wireGoto('#p-sources');
    const mr = $('#src-reimport'); if (mr) mr.onclick = () => $('#matrix-file').click();
    wireRoundTrip();
    wireLateness();
  }

  /* ---------- Excel round trip: export → edit → put it back (staffing-roundtrip.js) ---------- */
  function wireRoundTrip() {
    const RT = window.UFC_StaffRoundTrip; if (!RT) return;
    const ex = $('#rt-export'), im = $('#rt-import'), fi = $('#rt-file');
    if (ex) ex.onclick = async () => {
      ex.disabled = true;
      try { const r = await RT.exportRoundTrip(); toast(`Exported ${r.existing.length} allocations` + (r.pending.length ? ` and ${r.pending.length} pending add${r.pending.length === 1 ? '' : 's'} (yellow rows — put ADD in Action to accept)` : '') + '.'); }
      catch (e) { toast('Export failed — ' + (e.message || e)); }
      finally { ex.disabled = false; }
    };
    if (im && fi) {
      im.onclick = () => fi.click();
      fi.onchange = async () => {
        const f = fi.files[0]; fi.value = ''; if (!f) return;
        let plan;
        try { plan = RT.buildPlan(await RT.parseWorkbook(f)); }
        catch (e) { toast('Import failed — ' + (e.message || e)); return; }
        const n = plan.adds.length + plan.updates.length + plan.removes.length;
        const msg = `Put back “${f.name}”?\n\n` + RT.describePlan(plan);
        if (!n) { alert(msg + '\n\nNothing to write.'); return; }
        if (!confirm(msg + '\n\nWrite these ' + n + ' change' + (n === 1 ? '' : 's') + '? The trail records the sweep under your name.')) return;
        const out = S.applyRoundTrip(plan);
        state._gapsKey = null;
        renderAll();
        toast(`Round trip applied — ${out.added} added, ${out.changed} changed, ${out.removed} removed.`);
      };
    }
  }

  /* ---------- freshness strip — the age of every feed, on every tab ---------- */
  function renderFreshness() {
    const el = $('#fresh-strip'); if (!el) return;
    try {
      const meta = S.readDb().meta || {};
      const am = S.actualsMeta();
      const aAge = ageDays(am.importedAt);
      const aDot = aAge == null ? 'bad' : aAge <= 7 ? 'ok' : aAge <= 21 ? 'warn' : 'bad';
      const unlinked = unlinkedProjects().length;
      let gapDot = 'warn', gapTxt = 'needs actuals', gapAge = 'load Clockify hours first';
      if (S.hasActuals()) {
        const comp = S.complianceRows(months(), { clockifyUsers: state.clockifyUsers || [] });
        const behind = comp.rows.filter(S.isBehind).length;
        const miss = comp.rows.reduce((s, r) => s + r.behindHrs, 0);
        gapDot = behind ? 'warn' : 'ok';
        gapTxt = behind ? behind + (behind === 1 ? ' person behind' : ' people behind') : 'everyone current';
        gapAge = behind ? fmtH(miss) + ' h missing this window' : 'nothing to chase';
      }
      const cell = (goto, k, dotCls, v, age) => `<button class="fs-cell" data-goto-tab="${goto}" type="button" title="Open ${goto === 'sources' ? 'Data Sources' : goto}">
        <span class="fs-k">${k}</span>
        <span class="fs-v"><span class="fs-dot ${dotCls}"></span>${v}</span>
        <span class="fs-age">${age}</span>
      </button>`;
      el.innerHTML =
        cell('sources', '③ Clockify actuals', aDot, aAge == null ? 'not loaded' : 'updated ' + esc(agoTxt(am.importedAt)), (am.months || []).length ? (am.months || []).length + ' months of hours' : 'Compare runs blind without them') +
        cell('allocations', '① Allocations', 'ok', meta.updatedAt ? 'edited ' + esc(agoTxt(meta.updatedAt)) : 'no edits recorded', meta.updatedBy ? 'by ' + esc(meta.updatedBy) : 'maintained in this tool') +
        cell('mapping', '② Fee-tool links', unlinked ? 'warn' : 'ok', unlinked ? unlinked + ' unlinked' : 'all linked', unlinked ? 'no ② Contract line for those' : 'contract lines flowing') +
        cell('compliance', '⏱ Entry gaps', gapDot, gapTxt, gapAge);
      wireGoto('#fresh-strip');
    } catch (e) { console.error('freshness strip', e); el.innerHTML = ''; }
  }

  function renderCounts() {
    const allocs = S.listAllocations().filter(a => S.inView(a.personId));
    $('#cnt-alloc').textContent = '(' + allocs.length + ')';
    $('#cnt-proj').textContent = '(' + (state.group ? new Set(allocs.map(a => a.project).filter(Boolean)).size : S.distinctProjects().length) + ')';
    $('#cnt-ppl').textContent = '(' + S.listPeople().filter(S.inView).length + ')';
  }
  function renderActive() {
    const panel = $('#p-' + state.tab);
    try {
      if (state.tab === 'allocations') renderAllocations();
      else if (state.tab === 'projects') renderProjects();
      else if (state.tab === 'people') renderPeople();
      else if (state.tab === 'actuals') renderActuals();
      else if (state.tab === 'mapping') renderMapping();
      else if (state.tab === 'insights') renderInsights();
      else if (state.tab === 'compliance') renderCompliance();
      else if (state.tab === 'sources') renderSources();
    } catch (e) {
      console.error('render failed', e);
      if (panel) panel.innerHTML = `<div class="empty" style="color:#8f2418"><b>This view hit an error:</b> ${esc(e.message)}<br><span class="vmini">${esc((e.stack || '').split('\n')[1] || '')}</span></div>`;
    }
  }
  function renderAll() {
    buildIdentityBar();
    if (viewMode === 'leader') { renderLeader(); return; }
    renderCounts(); renderFreshness(); renderShiftBanner(); renderActive();
  }

  /* ---- Pending schedule shifts — the people must follow the contract ----
     Reconciliation moved a project's schedule (and its contract staffing);
     the named-people allocations here did not move with it. One click
     applies the same shift to every allocation row on that project. */
  function renderShiftBanner() {
    let bar = $('#shift-pending-bar');
    const pend = (S.pendingContractShifts ? S.pendingContractShifts() : [])
      .filter(x => x.months);
    if (!pend.length) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'shift-pending-bar';
      bar.style.cssText = 'background:#fdeaea;border:1px solid var(--sav-red);border-left:5px solid var(--sav-red);padding:12px 16px;margin-bottom:14px;font-family:var(--font-body);font-size:12.5px;color:var(--sav-navy)';
      const anchor = $('#fresh-strip');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(bar, anchor);
      else document.querySelector('.controls')?.after(bar);
    }
    bar.innerHTML = '<strong style="font-family:var(--font-display);letter-spacing:.04em">SCHEDULES MOVED — allocations have not.</strong> '
      + 'Reconciliation shifted these projects; their contract staffing moved with them, the named-people rows below did not.'
      + pend.map(x => `<div style="margin-top:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span><b>${esc(x.name)}</b> moved ${x.months > 0 ? '+' : ''}${x.months} month${Math.abs(x.months) === 1 ? '' : 's'}${x.by ? ' · ' + esc(x.by) : ''}${x.at ? ' · ' + new Date(x.at).toLocaleDateString() : ''} · ${x.allocations} allocation row${x.allocations === 1 ? '' : 's'} here</span>
          <button class="btn" data-shift-apply="${esc(x.id)}" data-n="${x.months}" style="background:var(--sav-navy);color:#fff">Shift ${x.allocations ? x.allocations + ' row' + (x.allocations === 1 ? '' : 's') : 'allocations'} ${x.months > 0 ? '+' : ''}${x.months}mo</button>
          <button class="btn" data-shift-skip="${esc(x.id)}" title="Clear the flag without moving anything — the allocations were already right">Already handled</button>
        </div>`).join('');
    $$('#shift-pending-bar [data-shift-apply]').forEach(b => b.onclick = () => {
      const n = +b.dataset.n;
      let moved = 0;
      try { moved = S.shiftAllocationsForFeeProject(b.dataset.shiftApply, n); window.UFC_Store.clearStaffingShift(b.dataset.shiftApply); }
      catch (e) { UFC_UI.toast(e.message); return; }
      toast(moved ? `${moved} allocation row${moved === 1 ? '' : 's'} moved ${n > 0 ? '+' : ''}${n} month${Math.abs(n) === 1 ? '' : 's'} — bandwidth reflects the new dates.` : 'No allocation rows found for that project — flag cleared.');
      renderAll();
    });
    $$('#shift-pending-bar [data-shift-skip]').forEach(b => b.onclick = () => {
      try { window.UFC_Store.clearStaffingShift(b.dataset.shiftSkip); } catch (e) { UFC_UI.toast(e.message); return; }
      renderAll();
    });
  }

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
    if (!resolveView()) { renderDenied(); return; }
    window.__UFC_STAFF_HOOKS__ = { months, openAllocModal, renderAll, setLeaderTab, state };
    wireMatrixImport();
    wireStaffSync().then(() => {
      buildWindowOptions();
      buildGroupOptions();
      setupViewSwitch(); applyView();
    $('#month-hrs').value = S.monthHours();
    const gh = $('#gloss-hrs'); if (gh) gh.textContent = S.monthHours();
    $('#win-start').onchange = (e) => { state.winStart = e.target.value; renderActive(); };
    const step = (d) => { const nv = S.ymAdd(state.winStart, d); const sel = $('#win-start'); if ([...sel.options].some(o => o.value === nv)) { state.winStart = nv; sel.value = nv; renderActive(); } };
    $('#win-prev').onclick = () => step(-1);
    $('#win-next').onclick = () => step(1);
    $('#win-len').onchange = (e) => { state.winLen = +e.target.value; renderActive(); };
    $('#month-hrs').onchange = (e) => { S.setMonthHours(+e.target.value); const g2 = $('#gloss-hrs'); if (g2) g2.textContent = S.monthHours(); renderActive(); };
    $('#inc-pursuit').onchange = (e) => { state.incPursuit = e.target.checked; renderActive(); };
    $('#export-snapshot-btn').onclick = async () => {
      if (typeof ExcelJS === 'undefined') { UFC_UI.toast('Excel library failed to load.'); return; }
      const btn = $('#export-snapshot-btn'); const orig = btn.textContent;
      btn.textContent = 'Building…'; btn.disabled = true;
      try { await window.UFC_buildAndDownloadStaffingSnapshot(); }
      catch (e) { console.error(e); UFC_UI.toast('Snapshot export failed: ' + e.message); }
      finally { btn.textContent = orig; btn.disabled = false; }
    };
    $$('#tabs .tab').forEach(t => t.onclick = () => setTab(t.dataset.tab));
    $('#am-close').onclick = closeAllocModal; $('#am-cancel').onclick = closeAllocModal; $('#am-save').onclick = saveAllocModal;
    $('#am-project').addEventListener('change', () => { const fee = allocFeePick($('#am-project').value); if (fee && !$('#am-client').value.trim()) $('#am-client').value = fee.client; });
    $('#alloc-modal').onclick = (e) => { if (e.target.id === 'alloc-modal') closeAllocModal(); };
    wireMailModal();
    renderAll();
    });
  }

  if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(init); else document.addEventListener('ufc:ready', init);
})();
