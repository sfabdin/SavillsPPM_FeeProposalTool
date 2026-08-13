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

  /* ---------- Helpers ---------- */
  function $(s, r = document) { return r.querySelector(s); }
  function $$(s, r = document) { return [...r.querySelectorAll(s)]; }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
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

    const leads = [...new Set(projects.map(p => p.project?.lead).filter(Boolean))].sort();
    leadSel.innerHTML = '<option value="">All leads</option>' +
      leads.map(l => `<option value="${esc(l)}" ${l===curLead?'selected':''}>${esc(l)}</option>`).join('');
  }

  /* ---------- Identity / access wall ---------- */
  function buildIdentityBar(allProjects) {
    const sel = $('#id-user');
    const label = document.querySelector('.identity-bar .id-label');
    const cur = STORE.getCurrentUser();

    // Only the SUPERUSER (Salim) gets the impersonation switcher. Everyone else
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
    const opts = [`<option value="__me__">Me — Salim (admin · all projects)</option>`]
      .concat(roster.map(r => `<option value="${esc(r.username)}">${esc(r.name)} · ${r.role}</option>`))
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
      if (filters.lead && pj.lead !== filters.lead) return false;
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
  function render() {
    const everything = STORE.listProjects();
    buildIdentityBar(everything);
    // Apply the access wall FIRST — members never see other teams' projects.
    const all = STORE.visibleProjects(everything);
    populateFilters(all);
    renderKpis(all);
    renderClientRollup(all);
    const filtered = applySort(applyFilters(all));

    const host = $('#table-host');
    if (!all.length) {
      host.innerHTML = `
        <div class="empty-state">
          <h3>Your project database is empty.</h3>
          <p>Start by creating a new proposal in the calculator, importing a JSON backup of an existing database, or seeding a demo project (the 383M migration) to see the system populated.</p>
          <div class="actions">
            <button class="btn btn-primary" onclick="document.getElementById('new-btn').click()">+ Create first project</button>
            <button class="btn btn-ghost" onclick="document.getElementById('seed-btn').click()">Seed demo data</button>
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
        <td>
          <div class="pname">${esc(pj.name || 'Untitled')}${nameSub}</div>
        </td>
        <td>
          <div class="pclient">${esc(pj.client || '—')}</div>
          <div class="pclient-sub">${esc(pj.location || '')}</div>
        </td>
        <td><span class="pill status-${statusKey}">${esc(statusLabel)}</span></td>
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
          pj[sel.dataset.qe] = sel.value;
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

  $('#seed-btn')?.addEventListener('click', () => {
    seedDemoData();
    render();
  });

  /* ---------- Demo seed ---------- */
  function seedDemoData() {
    const demos = buildDemoProjects();
    demos.forEach(p => STORE.saveProject(p));
  }

  function buildDemoProjects() {
    const mkFte = (phases, vals) => {
      const out = {};
      phases.forEach((p, i) => out[p.id] = vals[i] || 0);
      return out;
    };
    const p1Phases = [
      { id: 'p1a', name: 'Ramp-up',  length: 1 },
      { id: 'p1b', name: 'Kickoff',  length: 2 },
      { id: 'p1c', name: 'Planning', length: 6 },
      { id: 'p1d', name: 'Execution',length: 3 },
      { id: 'p1e', name: 'Closeout', length: 2 },
    ];
    const p1 = {
      project: {
        name: '383 Madison Migration ’27',
        client: 'JPMorgan Chase',
        lead: 'Kathy Spiegel',
        proposalDate: '2026-04-15',
        location: 'New York, NY',
        status: 'won',
        industry: 'Financial Services',
        firstProposalDate: '2026-03-01',
        signedContractDate: '2026-05-20',
        clientContact: 'M. Roberts · Real Estate',
        clientRelOwner: 'Hoffman',
      },
      timeline: { startMonth: 1, startYear: 2027, endMonth: 2, endYear: 2028 },
      phases: p1Phases,
      groups: [
        { id: 'core',  name: 'Core team' },
        { id: 'field', name: 'Field team' },
        { id: 'pic',   name: 'PIC / Advisory' },
      ],
      roles: [
        { id: 'r1', titleId: 'pe',     tierId: 'sr',  resource: 'Kathy Spiegel',  groupId: 'core', fte: mkFte(p1Phases, [50,75,75,100,50]) },
        { id: 'r2', titleId: 'pm',     tierId: 'mid', resource: 'Sarah Alim',     groupId: 'core', fte: mkFte(p1Phases, [50,100,100,100,75]) },
        { id: 'r3', titleId: 'lf',     tierId: 'sr',  resource: 'Mike DiLeo',     groupId: 'core', fte: mkFte(p1Phases, [25,50,75,100,50]) },
        { id: 'r4', titleId: 'tem',    tierId: 'std', resource: 'TBD 2Q ’27',     groupId: 'field',fte: mkFte(p1Phases, [0,0,0,100,0]) },
        { id: 'r5', titleId: 'tem',    tierId: 'std', resource: 'TBD 2Q ’27',     groupId: 'field',fte: mkFte(p1Phases, [0,0,0,100,0]) },
        { id: 'r6', titleId: 'tem',    tierId: 'std', resource: 'TBD 2Q ’27',     groupId: 'field',fte: mkFte(p1Phases, [0,0,0,100,0]) },
        { id: 'r7', titleId: 'pic',    tierId: 'std', resource: 'Hoffman/Santoro',groupId: 'pic',  fte: mkFte(p1Phases, [10,10,10,10,10]) },
      ],
      assumptions: { hrsPerMo: 173.33, escalation: 3.0, discount: 0, rateLock: false, catalogBaseYear: 2025 },
    };

    const p2Phases = [
      { id: 'p2a', name: 'Mobilization', length: 1 },
      { id: 'p2b', name: 'Delivery',     length: 4 },
      { id: 'p2c', name: 'Closeout',     length: 1 },
    ];
    const p2 = {
      project: {
        name: 'Hudson Yards Build-out',
        client: 'Pfizer',
        lead: 'Michael Glatt',
        proposalDate: '2026-02-10',
        location: 'New York, NY',
        status: 'active',
        industry: 'Life Sciences',
        firstProposalDate: '2026-01-15',
        signedContractDate: '2026-03-05',
        clientContact: 'J. Chen · Facilities',
        clientRelOwner: 'Glatt',
      },
      timeline: { startMonth: 4, startYear: 2026, endMonth: 9, endYear: 2026 },
      phases: p2Phases,
      groups: [
        { id: 'core',  name: 'Core team' },
        { id: 'field', name: 'Field team' },
      ],
      roles: [
        { id: 'r1', titleId: 'pe',  tierId: 'sr',  resource: 'Michael Glatt', groupId: 'core', fte: mkFte(p2Phases, [50,50,25]) },
        { id: 'r2', titleId: 'pm',  tierId: 'sr',  resource: 'Jess White',    groupId: 'core', fte: mkFte(p2Phases, [75,100,50]) },
        { id: 'r3', titleId: 'bc',  tierId: 'sr',  resource: 'TBD',            groupId: 'core', fte: mkFte(p2Phases, [50,75,25]) },
        { id: 'r4', titleId: 'tem', tierId: 'std', resource: 'TBD',            groupId: 'field',fte: mkFte(p2Phases, [0,100,25]) },
      ],
      assumptions: { hrsPerMo: 173.33, escalation: 3.0, discount: 5, rateLock: false, catalogBaseYear: 2025 },
    };

    const p3Phases = [
      { id: 'p3a', name: 'Discovery', length: 2 },
      { id: 'p3b', name: 'Design',    length: 3 },
      { id: 'p3c', name: 'Build',     length: 4 },
      { id: 'p3d', name: 'Closeout',  length: 1 },
    ];
    const p3 = {
      project: {
        name: 'Tech Campus Phase 2',
        client: 'Meta Platforms',
        lead: 'Hudson Grieve',
        proposalDate: '2026-05-01',
        location: 'Menlo Park, CA',
        status: 'submitted',
        industry: 'TAMI',
        firstProposalDate: '2026-04-10',
        signedContractDate: '',
        clientContact: 'K. Patel · Workplace',
        clientRelOwner: 'Grieve',
      },
      timeline: { startMonth: 7, startYear: 2026, endMonth: 4, endYear: 2027 },
      phases: p3Phases,
      groups: [
        { id: 'core',  name: 'Core team' },
        { id: 'field', name: 'Field team' },
      ],
      roles: [
        { id: 'r1', titleId: 'pe',  tierId: 'sr',  resource: 'Hudson Grieve', groupId: 'core', fte: mkFte(p3Phases, [50,75,100,50]) },
        { id: 'r2', titleId: 'pm',  tierId: 'sr',  resource: 'TBD',            groupId: 'core', fte: mkFte(p3Phases, [75,100,100,75]) },
        { id: 'r3', titleId: 'cm',  tierId: 'sr',  resource: 'TBD',            groupId: 'core', fte: mkFte(p3Phases, [25,75,100,25]) },
        { id: 'r4', titleId: 'tem', tierId: 'std', resource: 'TBD',            groupId: 'field',fte: mkFte(p3Phases, [0,0,100,0]) },
      ],
      assumptions: { hrsPerMo: 173.33, escalation: 3.0, discount: 0, rateLock: true, catalogBaseYear: 2025 },
    };

    const p4Phases = [
      { id: 'p4a', name: 'Owner Rep', length: 8 },
    ];
    const p4 = {
      project: {
        name: 'Park Avenue HQ Refit',
        client: 'Citi',
        lead: 'Kathy Spiegel',
        proposalDate: '2025-11-20',
        location: 'New York, NY',
        status: 'lost',
        industry: 'Financial Services',
        firstProposalDate: '2025-10-15',
        signedContractDate: '',
        clientContact: 'A. Brown · Corporate RE',
        clientRelOwner: 'Spiegel',
      },
      timeline: { startMonth: 1, startYear: 2026, endMonth: 8, endYear: 2026 },
      phases: p4Phases,
      groups: [{ id: 'core', name: 'Core team' }],
      roles: [
        { id: 'r1', titleId: 'pe', tierId: 'sr', resource: 'Kathy Spiegel', groupId: 'core', fte: mkFte(p4Phases, [50]) },
        { id: 'r2', titleId: 'pm', tierId: 'mid', resource: 'TBD',           groupId: 'core', fte: mkFte(p4Phases, [100]) },
      ],
      assumptions: { hrsPerMo: 173.33, escalation: 3.0, discount: 10, rateLock: false, catalogBaseYear: 2025 },
    };

    return [p1, p2, p3, p4];
  }

  // Wait for the data layer (instant on localStorage; pulls from Box when enabled).
  function boot() {
    // One-time lead-id normalization for legacy/imported records (NOT per render).
    if (STORE.migrateLeadIds) { try { STORE.migrateLeadIds(); } catch (e) {} }
    render();
  }
  if (window.ufcReady && window.ufcReady.then) { window.ufcReady.then(boot); } else { boot(); }
})();
