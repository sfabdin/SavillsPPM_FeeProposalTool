/* ============================================================
   SAVILLS PPM · PROJECTS INDEX — page controller
   ------------------------------------------------------------
   Moved out of Projects Index.html so the page logic is a real
   module: diffable, searchable, and shared-nothing with the
   markup. Loaded by that page only, after store.js + boot.js.
   ============================================================ */
(function () {
  'use strict';
  const STORE = window.UFC_Store;
  const CATALOG = window.RATES_CATALOG;

  /* ---------- State ---------- */
  let filters = {
    search: '',
    status: '',
    industry: '',
    ptype: '',
    lead: '',
  };
  let sort = { col: 'updatedAt', dir: 'desc' };
  let quickEdit = false;   // superuser-only inline editing of Lead PE / type / industry
  let LAST_VIEW = null;    // the rows currently on screen — what "Export this view" writes

  /* ---------- Helpers ---------- */
  function $(s, r = document) { return r.querySelector(s); }
  function $$(s, r = document) { return [...r.querySelectorAll(s)]; }
  const esc = window.UFC_UI.esc;
  function fmtMoney(n) {
    if (!n || Math.abs(n) < 0.5) return '$0';
    const a = Math.abs(n);
    const s = a >= 1e6 ? '$' + (a/1e6).toFixed(1).replace(/\.0$/,'') + 'M'
            : a >= 1e3 ? '$' + (a/1e3).toFixed(0) + 'K'
            : '$' + Math.round(a).toLocaleString();
    return n < 0 ? '(' + s + ')' : s;      // finance convention: negatives in parens
  }
  function fmtMoneyFull(n) {
    if (!n) return '$0';
    return (n < 0 ? '($' : '$') + Math.abs(Math.round(n)).toLocaleString() + (n < 0 ? ')' : '');
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtRelative(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const days = Math.floor(diff / 86400000);
    if (days < 1) return 'today';
    if (days < 2) return 'yesterday';
    if (days < 7) return days + ' days ago';
    if (days < 30) return Math.floor(days / 7) + 'w ago';
    if (days < 365) return Math.floor(days / 30) + 'mo ago';
    return Math.floor(days / 365) + 'y ago';
  }
  function fmtPeriod(p) {
    if (!p.timeline) return '—';
    const t = p.timeline;
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${monthNames[t.startMonth-1]} ’${String(t.startYear).slice(-2)} → ${monthNames[t.endMonth-1]} ’${String(t.endYear).slice(-2)}`;
  }

  /* Memoized per-project fee — keyed on id + updatedAt, so it only recomputes
     when a record actually changes. Eliminates redundant recompute across KPIs,
     client rollup, sort and the row map within a render AND across re-renders
     (every filter keystroke). */
  const _feeCache = new Map();
  function projectFee(p) {
    const key = p.id + '|' + (p.updatedAt || '');
    const hit = _feeCache.get(key);
    if (hit) return hit;
    const val = computeProjectFee(p);
    _feeCache.set(key, val);
    return val;
  }
  function computeProjectFee(p) {
    // Imported projects carry their $ in the locked monthly series, not in roles.
    if (p.source && p.source.importedByMonth && !(p.source && p.source.reconciled)) {
      const series = STORE.monthlySeries(p, CATALOG) || [];
      const net = series.reduce((a, s) => a + (s.amount || 0), 0);
      return { gross: net, lockCredit: 0, discount: 0, net, fteMonths: 0 };
    }
    return STORE.projectFinancials(p, r => STORE.getTierRateFromCatalog(r, CATALOG, p));
  }

  /* ---------- Populate filter dropdowns ---------- */
  function populateFilters(projects) {
    const statusSel = $('#filter-status');
    const indSel = $('#filter-industry');
    const ptSel = $('#filter-ptype');
    const leadSel = $('#filter-lead');

    // Build options (preserve current selections)
    const curStatus = filters.status, curInd = filters.industry, curLead = filters.lead;
    statusSel.innerHTML = '<option value="">All statuses</option>' +
      STORE.STATUSES.map(s => `<option value="${s}" ${s===curStatus?'selected':''}>${STORE.STATUS_LABELS[s]}</option>`).join('');

    const industries = [...new Set(projects.map(p => p.project?.industry).filter(Boolean))].sort();
    indSel.innerHTML = '<option value="">All industries</option>' +
      industries.map(i => `<option value="${esc(i)}" ${i===curInd?'selected':''}>${esc(i)}</option>`).join('');

    if (ptSel) {
      const curPt = filters.ptype;
      const ptypes = [...new Set(projects.map(p => p.project?.projectType).filter(Boolean))].sort();
      ptSel.innerHTML = '<option value="">All project types</option>' +
        ptypes.map(t => `<option value="${esc(t)}" ${t===curPt?'selected':''}>${esc(t)}</option>`).join('');
    }

    const leadName = (p) => (STORE.leaderDisplay ? STORE.leaderDisplay(p.project?.leadId || p.project?.lead) : p.project?.lead) || '';
    const leads = [...new Set(projects.map(leadName).filter(Boolean))].sort();
    leadSel.innerHTML = '<option value="">All leads</option>' +
      leads.map(l => `<option value="${esc(l)}" ${l===curLead?'selected':''}>${esc(l)}</option>`).join('');
  }

  /* ---------- Identity / access wall ---------- */
  function buildIdentityBar(allProjects) {
    const sel = $('#id-user');
    const label = document.querySelector('.identity-bar .id-label');
    const cur = STORE.getCurrentUser();

    // Only a SUPERUSER gets the impersonation switcher. Everyone else
    // sees a static, read-only identity — no way to assume another person's view.
    if (!STORE.canImpersonate()) {
      if (sel) sel.style.display = 'none';
      if (label) label.textContent = 'Signed in as';
      let nameEl = document.getElementById('id-static-name');
      if (!nameEl && sel) {
        nameEl = document.createElement('span');
        nameEl.id = 'id-static-name';
        nameEl.style.cssText = 'font-family:var(--font-display);font-weight:700;font-size:13px;color:#fff;margin:0 4px;';
        sel.parentNode.insertBefore(nameEl, sel.nextSibling);
      }
      if (nameEl) nameEl.textContent = cur.name || '(unrecognized)';
      updateIdentityMeta();
      return;
    }

    // SUPERUSER: full switcher to preview anyone's restricted view.
    if (label) label.textContent = 'Viewing as';
    if (sel) sel.style.display = '';
    const roster = STORE.impersonationRoster();
    const imp = STORE.getImpersonation();
    const me = (STORE.getRealIdentity && STORE.getRealIdentity()) || {};
    const meName = (STORE.displayNameForLogin && STORE.displayNameForLogin(me.username)) || me.name || '';
    const opts = [`<option value="__me__">Me — ${esc(meName || 'admin')} (admin · all projects)</option>`]
      .concat(roster.map(r => `<option value="${esc(r.username)}">${esc(r.name)}${r.role === 'admin' ? ' · admin' : ''}</option>`))
      .concat([`<option value="__custom__">Custom email…</option>`]);
    sel.innerHTML = opts.join('');
    sel.value = imp ? esc(imp) : '__me__';
    if (sel.selectedIndex < 0) sel.value = '__me__';
    updateIdentityMeta();
  }
  function updateIdentityMeta() {
    const cur = STORE.getCurrentUser();
    const roleEl = $('#id-role'), noteEl = $('#id-note');
    const previewing = !!cur.impersonating;
    if (cur.role === 'admin') {
      roleEl.textContent = 'Admin · sees all';
      roleEl.className = 'id-role admin';
      noteEl.innerHTML = previewing
        ? `<strong>Previewing</strong> ${esc(cur.name)} (admin). <a href="#" id="id-exit" style="color:#fff;">← back to me</a>`
        : `Full portfolio visibility. Use <strong>Viewing as</strong> to preview a restricted view.`;
    } else {
      roleEl.textContent = 'Member · own projects';
      roleEl.className = 'id-role member';
      noteEl.innerHTML = previewing
        ? `<strong>Previewing</strong> ${esc(cur.name || 'this person')} — only their projects show. <a href="#" id="id-exit" style="color:#fff;">← back to me</a>`
        : `Showing only projects led or owned by <strong>${esc(cur.name || '—')}</strong>. Other teams' fees are hidden.`;
    }
    const exit = document.getElementById('id-exit');
    if (exit) exit.addEventListener('click', (e) => { e.preventDefault(); STORE.clearImpersonation(); filters = { search: '', status: '', industry: '', ptype: '', lead: '' }; render(); });
  }
  function applyFilters(projects) {
    return projects.filter(p => {
      const pj = p.project || {};
      if (filters.status && pj.status !== filters.status) return false;
      if (filters.industry && pj.industry !== filters.industry) return false;
      if (filters.ptype && pj.projectType !== filters.ptype) return false;
      if (filters.lead && ((STORE.leaderDisplay ? STORE.leaderDisplay(pj.leadId || pj.lead) : pj.lead) || '') !== filters.lead) return false;
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const hay = [pj.name, pj.client, pj.lead, pj.location, pj.clientContact, pj.clientRelOwner]
          .filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function applySort(projects) {
    const dir = sort.dir === 'desc' ? -1 : 1;
    return [...projects].sort((a, b) => {
      let av, bv;
      switch (sort.col) {
        case 'name': av = a.project?.name || ''; bv = b.project?.name || ''; break;
        case 'client': av = a.project?.client || ''; bv = b.project?.client || ''; break;
        case 'status': av = a.project?.status || ''; bv = b.project?.status || ''; break;
        case 'industry': av = a.project?.industry || ''; bv = b.project?.industry || ''; break;
        case 'lead': av = a.project?.lead || ''; bv = b.project?.lead || ''; break;
        case 'fee': av = projectFee(a).net; bv = projectFee(b).net; break;
        case 'updatedAt':
        default: av = a.updatedAt || ''; bv = b.updatedAt || '';
      }
      if (typeof av === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  /* Per-year billings for a project (revised curve if it has approved COs,
     else the raw monthly series). Keyed to id+updatedAt so it only recomputes
     when the record changes. Returns { 2026, 2027 }. */
  const _yearCache = new Map();
  function feeByYear(p) {
    const key = p.id + '|' + (p.updatedAt || '');
    const hit = _yearCache.get(key);
    if (hit) return hit;
    const out = { 2026: 0, 2027: 0 };
    const rc = STORE.revisedContract(p.id);
    if (rc.coCount) {
      rc.byMonth.forEach(m => {
        const y = parseInt(String(m.ym).split('-')[0], 10);
        if (out[y] != null) out[y] += m.net || 0;
      });
    } else {
      (STORE.monthlySeries(p, CATALOG) || []).forEach(m => {
        if (out[m.year] != null) out[m.year] += m.amount || 0;
      });
    }
    _yearCache.set(key, out);
    return out;
  }

  /* ---------- KPI rollup ---------- */
  function renderKpis(allProjects) {
    // Parents only — change orders fold into their parent's revised contract.
    const parents = allProjects.filter(p => !STORE.isChangeOrder(p));
    // Every dollar card is scoped to billings landing in CALENDAR 2026 (not
    // whole-project lifetime value). Booked 2027 is surfaced separately.
    const fees = parents.map(p => {
      const y = feeByYear(p);
      return { p, net: y[2026], net2027: y[2027] };
    });
    const total = fees.reduce((s, x) => s + x.net, 0);
    // Pipeline = open opportunities being actively pursued (submitted + negotiation).
    // Drafts are working estimates, not real pipeline — excluded.
    const pipeline = fees.filter(x => ['submitted','negotiation'].includes(x.p.project?.status))
                        .reduce((s, x) => s + x.net, 0);
    // Won = signed / awarded work (won, active, closed).
    const won = fees.filter(x => ['won','active','closed'].includes(x.p.project?.status))
                   .reduce((s, x) => s + x.net, 0);
    // Booked 2027 = the same awarded work, billings landing in 2027.
    const won2027 = fees.filter(x => ['won','active','closed'].includes(x.p.project?.status))
                   .reduce((s, x) => s + x.net2027, 0);
    // Probability-weighted forecast = every project × its rating confidence.
    const weighted = fees.reduce((s, x) => {
      const w = (STORE.ratingMeta(STORE.ratingFor(x.p)) || {}).weight || 0;
      return s + x.net * w;
    }, 0);
    const wonCount = parents.filter(p => ['won','active','closed'].includes(p.project?.status)).length;
    // Win rate = won ÷ everything actively pursued (open pipeline + decided), so
    // open negotiations pull it below 100%. Drafts aren't pursuits yet → excluded.
    const pursued = parents.filter(p => ['submitted','negotiation','won','lost','active','closed'].includes(p.project?.status)).length;
    const wr = pursued ? Math.round((wonCount / pursued) * 100) : null;

    $('#kpi-count').textContent = parents.length;
    $('#kpi-pipeline').textContent = fmtMoney(pipeline);
    $('#kpi-won').textContent = fmtMoney(won);
    $('#kpi-won-2027').textContent = fmtMoney(won2027);
    $('#kpi-weighted').textContent = fmtMoney(weighted);
    $('#kpi-winrate').innerHTML = wr !== null ? `${wr}<span class="unit">%</span>` : '—';
    $('#kpi-total').textContent = fmtMoney(total);
  }

  /* ---------- Client rollup ---------- */
  function renderClientRollup(allProjects) {
    const parents = allProjects.filter(p => !STORE.isChangeOrder(p));
    const rows = STORE.clientRollup(parents, p => projectFee(p).net);
    const hint = $('#cr-hint'), body = $('#cr-body');
    if (!rows.length) { if (hint) hint.textContent = ''; if (body) body.innerHTML = ''; return; }
    if (hint) hint.textContent = `${rows.length} client${rows.length === 1 ? '' : 's'}`;
    body.innerHTML = `<table class="cr-table">
      <thead><tr><th>Client</th><th class="num">Projects</th><th class="num">Original</th><th class="num">Change orders</th><th class="num">Revised contract</th></tr></thead>
      <tbody>${rows.map(r => {
        const coDelta = r.revised - r.baseline;
        const coTxt = r.coCount ? `<span class="cr-co">${coDelta >= 0 ? '+' : '−'}${fmtMoneyFull(Math.abs(coDelta))} · ${r.coCount}</span>` : '—';
        return `<tr>
          <td class="cr-client">${esc(r.client)}</td>
          <td class="num">${r.projects}</td>
          <td class="num">${fmtMoneyFull(r.baseline)}</td>
          <td class="num">${coTxt}</td>
          <td class="num"><strong>${fmtMoneyFull(r.revised)}</strong></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  }

  /* ---------- Render ---------- */
  /* ---- What changed on your projects, last 7 days ----
     The audit trail, scoped the same way the table is: only projects you can
     see, only the last week, grouped by project with the latest action first.
     A leader opens the index and knows what moved without opening the Change
     Log — which is one click away for the detail. */
  const RC_DAYS = 7;
  const RC_LABEL = { create: 'Created', edit: 'Edited', status: 'Status changed', book: 'Booked', delete: 'Deleted', restore: 'Restored',
    'co-create': 'Change order', 'co-approve': 'CO approved', 'reconcile-commit': 'Reconciled', 'plan-adjust': 'Plan adjusted',
    'schedule-shift': 'Schedule shifted', slip: 'Slipped', 'slip-remove': 'Slip removed', 'ledger-post': 'Actuals posted',
    'ledger-allocate': 'Allocated', 'ledger-map': 'Mapped', 'ledger-match': 'Mapped', 'project-from-ledger': 'Created from ledger' };
  const rcKind = (a) => /^(book|co-approve)$/.test(a) ? 'book' : /^(delete|purge)$/.test(a) ? 'delete' : '';
  const rcLabel = (a) => RC_LABEL[a] || (/^staff-/.test(a) ? 'Staffing changed' : /^ledger-/.test(a) ? 'Ledger updated' : (a || 'Changed'));
  function renderRecentChanges(visible) {
    const host = $('#recent-changes');
    if (!host || !STORE.listActivity) return;
    const ids = new Set(visible.map(p => p.id));
    const since = Date.now() - RC_DAYS * 86400000;
    const byProj = new Map();
    let total = 0;
    for (const e of STORE.listActivity(null)) {
      if (!e || !e.ts || Date.parse(e.ts) < since) continue;
      if (!e.projectId || !ids.has(e.projectId)) continue;
      total++;
      const g = byProj.get(e.projectId) || { n: 0, latest: e };
      g.n++; if (!g.latest || (e.ts > g.latest.ts)) g.latest = e;
      byProj.set(e.projectId, g);
    }
    if (!total) { host.hidden = true; host.innerHTML = ''; return; }
    const rows = [...byProj.entries()].sort((a, b) => (b[1].latest.ts || '').localeCompare(a[1].latest.ts || '')).slice(0, 8);
    const li = rows.map(([pid, g]) => {
      const p = visible.find(x => x.id === pid) || {};
      const name = (p.project && p.project.name) || (g.latest.meta && g.latest.meta.name) || '(project removed)';
      const who = g.latest.actorName || g.latest.actor || '';
      const a = g.latest.action;
      return '<li><span class="rc-what ' + rcKind(a) + '">' + esc(rcLabel(a)) + '</span>' +
        '<a class="rc-proj" href="Universal Fee Calculator.html?id=' + encodeURIComponent(pid) + '">' + esc(name) + '</a>' +
        '<span class="rc-who">' + esc(who) + ' · ' + esc(fmtRelative(g.latest.ts)) + (g.n > 1 ? ' · ' + g.n + ' changes' : '') + '</span></li>';
    }).join('');
    host.innerHTML = '<div class="rc-head"><h2>Changed on your projects · last ' + RC_DAYS + ' days</h2>' +
      '<span class="rc-sum">' + total + ' change' + (total === 1 ? '' : 's') + ' across ' + byProj.size + ' project' + (byProj.size === 1 ? '' : 's') +
      (byProj.size > rows.length ? ' · showing the ' + rows.length + ' most recent' : '') + ' — <a href="Change Log.html">open the Change Log</a></span></div><ul>' + li + '</ul>';
    host.hidden = false;
  }
  /* The boot pull brings the current month's trail; in the first week of a
     month the window reaches into the previous one, so ask for it too. */
  function ensureRecentMonths() {
    const Box = window.UFC_Box;
    if (!Box || !Box.enabled || !Box.pullActivityMonths || !STORE.activityMonths) return;
    const d = new Date(); if (d.getUTCDate() > RC_DAYS) return;
    const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    if (STORE.activityMonths().includes(prev)) return;
    Box.pullActivityMonths([prev]).then(() => render()).catch(() => {});
  }

  function render() {
    const everything = STORE.listProjects();
    buildIdentityBar(everything);
    // Apply the access wall FIRST — members never see other teams' projects.
    const all = STORE.visibleProjects(everything);
    try { renderRecentChanges(all); } catch (e) { console.warn('recent changes', e); }
    populateFilters(all);
    renderKpis(all);
    renderClientRollup(all);
    const filtered = applySort(applyFilters(all));
    /* What "Export this view" writes. Captured HERE, after the access wall,
       the filters and the sort — so the workbook is the table you are looking
       at, in the order you are looking at it, and a member can never export
       rows the page would not show them. */
    LAST_VIEW = { rows: filtered.filter(p => !STORE.isChangeOrder(p)), filters: { ...filters }, sort: { ...sort },
                  /* Count the same way the rows do — change orders fold into
                     their parent and are never rows, so counting them in the
                     denominator made an unfiltered export read "249 of 253". */
                  total: all.filter(p => !STORE.isChangeOrder(p)).length };

    const host = $('#table-host');
    if (!all.length) {
      host.innerHTML = `
        <div class="empty-state">
          <h3>Your project database is empty.</h3>
          <p>Start by creating a new proposal in the calculator, or importing a JSON backup of an existing database.</p>
          <div class="actions">
            <button class="btn btn-primary" onclick="document.getElementById('new-btn').click()">+ Create first project</button>
            <button class="btn btn-ghost" onclick="document.getElementById('import-btn').click()">Import JSON</button>
          </div>
        </div>`;
      return;
    }
    if (!filtered.length) {
      host.innerHTML = `
        <div class="empty-state">
          <h3>No projects match these filters.</h3>
          <p>Adjust the filters or clear them to see all ${all.length} project${all.length === 1 ? '' : 's'}.</p>
          <div class="actions">
            <button class="btn btn-ghost" onclick="document.getElementById('clear-btn').click()">Clear filters</button>
          </div>
        </div>`;
      return;
    }

    const cols = [
      { key: 'name',      label: 'Project' },
      { key: 'client',    label: 'Client · location' },
      { key: 'status',    label: 'Status' },
      { key: 'industry',  label: 'Industry' },
      { key: 'ptype',     label: 'Project type', sortable: false },
      { key: 'lead',      label: 'Lead PE' },
      { key: 'period',    label: 'Period', sortable: false },
      { key: 'fee',       label: 'Net fee', num: true },
      { key: 'updatedAt', label: 'Last updated' },
      { key: 'actions',   label: '', sortable: false },
    ];

    const headHtml = cols.map(c => {
      const sortable = c.sortable !== false;
      const isSorted = sort.col === c.key;
      const arrow = isSorted ? (sort.dir === 'desc' ? '↓' : '↑') : '↕';
      const cls = (c.num ? 'num ' : '') + (isSorted ? 'sorted' : '');
      return sortable
        ? `<th class="${cls}" data-col="${c.key}">${c.label}<span class="sort-arrow">${arrow}</span></th>`
        : `<th class="${cls}">${c.label}</th>`;
    }).join('');

    const rowsHtml = filtered.filter(p => !STORE.isChangeOrder(p)).map(p => {
      const pj = p.project || {};
      const fin = projectFee(p);
      const rc = STORE.revisedContract(p.id);
      const hasCOs = rc.coCount > 0;
      const statusKey = pj.status || 'draft';
      const statusLabel = STORE.STATUS_LABELS[statusKey] || statusKey;
      const coSign = rc.coNetSum >= 0 ? '+' : '−';
      const feeCell = hasCOs
        ? `<div class="pfee">${fmtMoneyFull(rc.revisedNet)}</div>
           <div class="pfee-sub">${fmtMoneyFull(rc.baselineNet)} ${coSign} ${rc.coCount} CO${rc.coCount === 1 ? '' : 's'}</div>`
        : `<div class="pfee">${fmtMoneyFull(fin.net)}</div>
           <div class="pfee-sub">${fin.fteMonths.toFixed(1)} fte-mo</div>`;
      const nameSub = hasCOs
        ? `<span class="pname-sub">${esc(pj.industry || '—')} · revised contract</span>`
        : `<span class="pname-sub">${esc(pj.industry || '—')}</span>`;
      return `<tr data-id="${p.id}">
        ${quickEdit ? `
        <td><input class="qe-in" data-qe="name" data-id="${p.id}" value="${esc(pj.name || '')}" placeholder="Project name"></td>
        <td>
          <input class="qe-in" data-qe="client" data-id="${p.id}" value="${esc(pj.client || '')}" placeholder="Client">
          <input class="qe-in qe-sm" data-qe="location" data-id="${p.id}" value="${esc(pj.location || '')}" placeholder="Location">
        </td>
        <td><select class="qe-sel" data-qe="status" data-id="${p.id}">${STORE.STATUSES.map(x => `<option value="${esc(x)}" ${pj.status === x ? 'selected' : ''}>${esc(STORE.STATUS_LABELS[x] || x)}</option>`).join('')}</select></td>` : `
        <td>
          <div class="pname">${esc(pj.name || 'Untitled')}${nameSub}</div>
        </td>
        <td>
          <div class="pclient">${esc(pj.client || '—')}</div>
          <div class="pclient-sub">${esc(pj.location || '')}</div>
        </td>
        <td><span class="pill status-${statusKey}">${esc(statusLabel)}</span></td>`}
        ${quickEdit ? `
        <td><select class="qe-sel" data-qe="industry" data-id="${p.id}"><option value="">—</option>${STORE.INDUSTRIES.map(x => `<option ${pj.industry === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></td>
        <td><select class="qe-sel" data-qe="projectType" data-id="${p.id}"><option value="">—</option>${STORE.PROJECT_TYPES.map(t => `<option ${pj.projectType === t.name ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></td>
        <td><select class="qe-sel" data-qe="lead" data-id="${p.id}"><option value="">—</option>${STORE.REVENUE_LEADERS.map(l => `<option value="${esc(l.id)}" ${(pj.leadId === l.id || (!pj.leadId && pj.lead === l.displayName)) ? 'selected' : ''}>${esc(l.displayName)}</option>`).join('')}</select></td>` : `
        <td>${esc(pj.industry || '—')}</td>
        <td>${esc(pj.projectType || '—')}</td>
        <td>${esc(pj.lead || '—')}</td>`}
        <td style="font-family: var(--font-body); color: var(--sav-steel); font-size: 12px;">${fmtPeriod(p)}</td>
        <td class="num">${feeCell}</td>
        <td style="font-family: var(--font-body); color: var(--sav-steel); font-size: 12px;">${fmtRelative(p.updatedAt)}</td>
        <td>
          <div class="row-actions">
            <button class="icon-btn duplicate" data-id="${p.id}" title="Duplicate">⎘</button>
            <button class="icon-btn delete" data-id="${p.id}" title="Delete">×</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    host.innerHTML = `
      <div class="projects-wrap">
        <table class="projects-table">
          <thead><tr>${headHtml}</tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`;

    // Wire row clicks → open calculator (suspended while quick-editing, so a
    // stray click can't navigate away mid-edit)
    $$('.projects-table tbody tr').forEach(tr => {
      tr.addEventListener('click', (e) => {
        if (quickEdit) return;
        if (e.target.closest('.row-actions')) return;
        const id = tr.dataset.id;
        window.location.href = 'Universal Fee Calculator.html?id=' + encodeURIComponent(id);
      });
    });
    // Quick-edit selects — superuser only; each change saves immediately.
    $$('.projects-table [data-qe]').forEach(sel => {
      sel.addEventListener('click', (e) => e.stopPropagation());
      sel.addEventListener('change', (e) => {
        e.stopPropagation();
        if (!STORE.canImpersonate()) return;   // hard gate: superuser's REAL identity only
        const p = STORE.getProject(sel.dataset.id);
        if (!p) return;
        const pj = { ...(p.project || {}) };
        if (sel.dataset.qe === 'lead') {
          const l = STORE.leaderById(sel.value);
          pj.leadId = l ? l.id : '';
          pj.lead = l ? l.displayName : '';
        } else {
          const val = String(sel.value == null ? '' : sel.value).trim();
          /* A project with no name is unfindable everywhere else in the tool,
             so refuse the blank rather than saving it and let the cell snap
             back to what it was. */
          if (sel.dataset.qe === 'name' && !val) {
            sel.value = (p.project || {}).name || '';
            sel.classList.remove('qe-saved');
            alert('A project needs a name — the previous one has been put back.');
            return;
          }
          if (val === String((p.project || {})[sel.dataset.qe] || '').trim()) return;   // no-op edit
          pj[sel.dataset.qe] = val;
        }
        try {
          STORE.saveProject({ ...p, project: pj }, { baseUpdatedAt: p.updatedAt });
          sel.classList.remove('qe-saved'); void sel.offsetWidth; sel.classList.add('qe-saved');
        } catch (err) {
          alert(err && err.code === 'STALE_WRITE'
            ? 'Someone saved this project while you were looking — the table will refresh so you can re-apply your change.'
            : 'Save failed: ' + (err.message || err));
          render();
        }
      });
    });
    // Sort
    $$('.projects-table thead th[data-col]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.col;
        if (sort.col === col) {
          sort.dir = sort.dir === 'desc' ? 'asc' : 'desc';
        } else {
          sort.col = col;
          sort.dir = (col === 'fee' || col === 'updatedAt') ? 'desc' : 'asc';
        }
        render();
      });
    });
    // Delete
    $$('.row-actions .delete').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = e.target.dataset.id;
      const p = STORE.getProject(id);
      if (!confirm(`Delete project "${p?.project?.name || 'Untitled'}"? This cannot be undone.`)) return;
      STORE.deleteProject(id);
      render();
    }));
    // Duplicate
    $$('.row-actions .duplicate').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = e.target.dataset.id;
      const p = STORE.getProject(id);
      if (!p) return;
      const dup = JSON.parse(JSON.stringify(p));
      dup.id = null;
      dup.createdAt = null;
      dup.updatedAt = null;
      dup.project.name = (dup.project.name || 'Untitled') + ' (copy)';
      dup.project.status = 'draft';
      STORE.saveProject(dup);
      render();
    }));
  }

  /* ---------- Toolbar wiring ---------- */
  let _searchTimer = null;
  $('#search-input')?.addEventListener('input', e => {
    filters.search = e.target.value;
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(render, 140);
  });
  $('#id-user')?.addEventListener('change', e => {
    const v = e.target.value;
    if (v === '__me__') {
      STORE.clearImpersonation();
    } else if (v === '__custom__') {
      const email = (prompt('Preview as which Box login (email)?') || '').trim();
      if (email) STORE.setImpersonation(email);
      else { STORE.clearImpersonation(); }
    } else {
      STORE.setImpersonation(v);
    }
    // reset filters so a stale lead filter doesn't compound with the wall
    filters = { search: '', status: '', industry: '', ptype: '', lead: '' };
    $('#search-input').value = '';
    render();
  });
  $('#filter-status')?.addEventListener('change', e => { filters.status = e.target.value; render(); });
  $('#filter-industry')?.addEventListener('change', e => { filters.industry = e.target.value; render(); });
  $('#filter-ptype')?.addEventListener('change', e => { filters.ptype = e.target.value; render(); });
  $('#filter-lead')?.addEventListener('change', e => { filters.lead = e.target.value; render(); });
  // Quick edit — the button only exists for the superuser's REAL identity
  // (impersonation previews don't unlock it).
  {
    const qb = $('#qe-btn');
    if (qb && STORE.canImpersonate()) qb.hidden = false;
    qb?.addEventListener('click', () => {
      quickEdit = !quickEdit;
      qb.textContent = quickEdit ? '✓ Done' : '✎ Quick edit';
      qb.classList.toggle('btn-primary', quickEdit);
      qb.classList.toggle('btn-ghost', !quickEdit);
      const note = $('#qe-note'); if (note) note.hidden = !quickEdit;
      render();
    });
  }
  $('#clear-btn')?.addEventListener('click', () => {
    filters = { search: '', status: '', industry: '', ptype: '', lead: '' };
    $('#search-input').value = '';
    render();
  });

  /* ---------- Header actions ---------- */
  $('#new-btn')?.addEventListener('click', () => {
    window.location.href = 'Universal Fee Calculator.html';
  });
  $('#export-btn')?.addEventListener('click', () => {
    const json = STORE.exportDb();
    const date = new Date().toISOString().slice(0, 10);
    STORE.downloadJson(`savills-ppm-fee-db-${date}.json`, json);
  });
  /* ---------- Export this view ----------
     The page promises "searchable, benchmarkable, exportable", but the only
     export here was a JSON database dump — a maintenance artifact nobody
     opens in a spreadsheet. This writes the table you are actually looking
     at: same rows, same order, same filters.

     It reads LAST_VIEW rather than re-running the query, so what lands in
     the workbook cannot drift from what is on screen — including the access
     wall, which is applied before LAST_VIEW is captured. */
  $('#export-view-btn')?.addEventListener('click', async () => {
    const btn = $('#export-view-btn');
    if (!LAST_VIEW || !LAST_VIEW.rows.length) {
      alert('Nothing to export — no projects match the current filters.');
      return;
    }
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      await window.UFC_Vendor.excel();
      await buildViewWorkbook();
    } catch (e) {
      console.error('view export failed', e);
      alert('Export failed: ' + ((e && e.message) || e));
    } finally {
      btn.disabled = false; btn.textContent = original;
    }
  });

  async function buildViewWorkbook() {
    const V = LAST_VIEW;
    const NAVY = 'FF25273A', YEL = 'FFFFDF00', STEEL = 'FF79828C', WHITE = 'FFFFFFFF', CREAM = 'FFEEE8E3';
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Savills PPM';
    const ws = wb.addWorksheet('Projects', {
      views: [{ state: 'frozen', ySplit: 4 }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });

    // Title + provenance. Which filters produced this matters as much as the
    // rows: a sheet of 12 projects with no context reads as the whole book.
    ws.mergeCells('A1:K1');
    ws.getCell('A1').value = 'Savills PPM — Projects Index';
    ws.getCell('A1').font = { name: 'Calibri', bold: true, size: 16, color: { argb: NAVY } };
    ws.getRow(1).height = 24;

    const f = V.filters || {};
    const bits = [];
    if (f.search) bits.push('Search: "' + f.search + '"');
    if (f.status) bits.push('Status: ' + (STORE.STATUS_LABELS[f.status] || f.status));
    if (f.industry) bits.push('Industry: ' + f.industry);
    if (f.ptype) bits.push('Type: ' + f.ptype);
    if (f.lead) bits.push('Lead: ' + f.lead);
    ws.mergeCells('A2:K2');
    ws.getCell('A2').value = V.rows.length + ' of ' + V.total + ' projects'
      + (bits.length ? '  ·  ' + bits.join('  ·  ') : '  ·  no filters applied')
      + '  ·  exported ' + new Date().toLocaleString();
    ws.getCell('A2').font = { name: 'Calibri', italic: true, size: 10, color: { argb: STEEL } };

    const cols = [
      ['Project', 34], ['Client', 24], ['Location', 18], ['Status', 14],
      ['Industry', 18], ['Project type', 22], ['Lead PE', 18],
      ['Period', 18], ['Net fee', 14], ['FTE-months', 12], ['Last updated', 14],
    ];
    cols.forEach((c, i) => { ws.getColumn(i + 1).width = c[1]; });
    const head = ws.getRow(4);
    cols.forEach((c, i) => {
      const cell = head.getCell(i + 1);
      cell.value = c[0];
      cell.font = { name: 'Calibri', bold: true, color: { argb: WHITE } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      cell.alignment = { horizontal: i >= 8 && i <= 9 ? 'right' : 'left' };
    });

    let net = 0, fte = 0;
    V.rows.forEach((p) => {
      const pj = p.project || {};
      const fin = projectFee(p);
      const rc = STORE.revisedContract(p.id);
      // A project with approved change orders is worth its REVISED contract —
      // the same figure the on-screen row shows, not the original baseline.
      const rowNet = rc.coCount ? rc.revisedNet : fin.net;
      net += rowNet || 0; fte += fin.fteMonths || 0;
      const r = ws.addRow([
        (pj.name || 'Untitled') + (rc.coCount ? '  (incl. ' + rc.coCount + ' CO' + (rc.coCount === 1 ? '' : 's') + ')' : ''),
        pj.client || '', pj.location || '',
        STORE.STATUS_LABELS[pj.status] || pj.status || '',
        pj.industry || '', pj.projectType || '', pj.lead || '',
        fmtPeriod(p), rowNet || 0, +(fin.fteMonths || 0).toFixed(1),
        p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : '',
      ]);
      r.getCell(9).numFmt = '"$"#,##0';
      r.getCell(10).numFmt = '#,##0.0';
      r.getCell(1).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
      if (STORE.isPlaceholder && STORE.isPlaceholder(p)) {
        // Carry the estimate caveat into the workbook — a badge that only
        // exists on screen is one nobody downstream ever sees.
        r.getCell(9).font = { name: 'Calibri', italic: true, color: { argb: STEEL } };
        r.getCell(9).note = 'Placeholder — these dollars were assumed to hold the space, not priced from scope.';
      }
    });

    const tot = ws.addRow(['TOTAL', '', '', '', '', '', '', '', net, +fte.toFixed(1), '']);
    tot.eachCell((c) => { c.font = { name: 'Calibri', bold: true, color: { argb: NAVY } }; });
    tot.getCell(9).numFmt = '"$"#,##0';
    tot.getCell(10).numFmt = '#,##0.0';
    [9, 10].forEach((i) => { tot.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YEL } }; });
    tot.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'Savills PPM Projects ' + new Date().toISOString().slice(0, 10) + '.xlsx';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  $('#import-btn')?.addEventListener('click', () => $('#import-input').click());
  $('#import-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        let mode = 'merge';
        if (!confirm('Import will MERGE the file into the shared database (the newest version of each project wins — safe).\n\nOK = merge · Cancel = other options')) {
          const word = prompt('REPLACE overwrites ALL existing projects for EVERYONE once it syncs to Box.\n\nType REPLACE to confirm, anything else falls back to a safe merge, or Cancel to abort.');
          if (word === null) return;
          if (word.trim() === 'REPLACE') mode = 'replace';
        }
        const n = STORE.importDb(reader.result, mode);
        alert(`Imported ${n} project${n === 1 ? '' : 's'}.`);
        render();
      } catch (err) {
        alert('Import failed: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // Wait for the data layer (instant on localStorage; pulls from Box when enabled).
  function boot() {
    // One-time lead-id normalization for legacy/imported records (NOT per render).
    if (STORE.migrateLeadIds) { try { STORE.migrateLeadIds(); } catch (e) {} }
    render();
    try { ensureRecentMonths(); } catch (e) {}
  }
  if (window.ufcReady && window.ufcReady.then) { window.ufcReady.then(boot); } else { boot(); }
})();
