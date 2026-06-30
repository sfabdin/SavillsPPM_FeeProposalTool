/* ============================================================
   SAVILLS PPM · BENCHMARKING · dashboard UI
   ============================================================ */
(function () {
  'use strict';
  const STORE = window.UFC_Store;
  const BENCH = window.BENCH;
  const CATALOG = window.RATES_CATALOG;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const money = (n) => (n == null || isNaN(n)) ? '—' : '$' + Math.round(n).toLocaleString();
  const rate = (n) => (n == null || isNaN(n) || n === 0) ? '—' : '$' + Math.round(n);

  let PROJECTS = [], FACTS = [], PROJFACTS = [];

  function load() {
    PROJECTS = STORE.listProjects();
    PROJFACTS = BENCH.projectFacts(PROJECTS);
    FACTS = BENCH.roleFacts(PROJECTS);
  }

  /* ---------- KPIs ---------- */
  function renderKpis() {
    $('#k-projects').textContent = PROJECTS.length;
    $('#k-roles').textContent = FACTS.length;
    const pm = FACTS.filter(f => f.titleId === 'pm').map(f => f.effective);
    $('#k-pm').textContent = pm.length ? rate(BENCH.median(pm)) : '—';
    $('#k-fee').textContent = money(PROJFACTS.reduce((s, p) => s + (p.net || 0), 0));
    $('#k-below').innerHTML = FACTS.filter(f => f.belowFloor).length + '<span class="unit"> roles</span>';
  }

  /* ============================================================
     TAB 1 — Comparables
     ============================================================ */
  function fillFilterOptions() {
    const clients = [...new Set(FACTS.map(f => f.client).filter(Boolean))].sort();
    const inds = [...new Set(FACTS.map(f => f.industry).filter(Boolean))].sort();
    const ptypes = [...new Set(FACTS.map(f => f.projectType).filter(Boolean))].sort();
    const titles = CATALOG.titles.filter(t => FACTS.some(f => f.titleId === t.id));
    fillSelect($('#f-client'), clients, 'All clients');
    fillSelect($('#f-industry'), inds, 'All industries');
    if ($('#f-ptype')) fillSelect($('#f-ptype'), ptypes, 'All project types');
    $('#f-title').innerHTML = `<option value="">All staff titles</option>` +
      titles.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  }
  function fillSelect(sel, items, allLabel) {
    sel.innerHTML = `<option value="">${allLabel}</option>` + items.map(i => `<option value="${esc(i)}">${esc(i)}</option>`).join('');
  }
  function sizeBucket(fee) {
    if (fee < 1e6) return 's';
    if (fee < 3e6) return 'm';
    if (fee < 6e6) return 'l';
    return 'xl';
  }
  function filteredFacts() {
    const c = $('#f-client').value, ind = $('#f-industry').value, t = $('#f-title').value;
    const pt = $('#f-ptype') ? $('#f-ptype').value : '';
    const size = $('#f-size').value, role = $('#f-role').value.trim().toLowerCase();
    const projSize = {}; PROJFACTS.forEach(p => projSize[p.id] = p.net);
    return FACTS.filter(f => {
      if (c && f.client !== c) return false;
      if (ind && f.industry !== ind) return false;
      if (pt && f.projectType !== pt) return false;
      if (t && f.titleId !== t) return false;
      if (size && sizeBucket(projSize[f.projectId] || 0) !== size) return false;
      if (role && !(f.projectRole || '').toLowerCase().includes(role)) return false;
      return true;
    });
  }
  function renderComp() {
    const f = filteredFacts();
    const stats = $('#comp-stats');
    if (f.length) {
      const q = f.map(x => x.quoted), e = f.map(x => x.effective);
      const below = f.filter(x => x.belowFloor).length;
      stats.innerHTML = [
        ['Matches', f.length, `${new Set(f.map(x => x.projectId)).size} projects`],
        ['Median quoted', rate(BENCH.median(q)), `range ${rate(Math.min(...q))}–${rate(Math.max(...q))}`],
        ['Median effective', rate(BENCH.median(e)), 'discount included'],
        ['Below floor', below, below ? 'potentially unprofitable' : 'all profitable'],
      ].map(([l, v, s]) => `<div class="compstat"><div class="lbl">${l}</div><div class="val">${typeof v === 'number' ? v : v}</div><div class="sub">${s}</div></div>`).join('');
    } else { stats.innerHTML = ''; }

    const tb = $('#comp-tbody');
    if (!f.length) { tb.innerHTML = `<tr><td colspan="8" class="empty">No roles match these filters.</td></tr>`; return; }
    const sorted = [...f].sort((a, b) => b.quoted - a.quoted);
    tb.innerHTML = sorted.map(x => `
      <tr class="${x.belowFloor ? 'below' : ''}">
        <td class="tt">${esc(x.titleName)}<div class="muted">${esc(x.tierLabel)}</div></td>
        <td>${esc(x.projectRole || '—')}</td>
        <td>${esc(x.projectName)}<div class="muted">${esc(x.client)}</div></td>
        <td class="muted">${esc(x.industry || '—')}</td>
        <td class="num tt">${rate(x.quoted)}</td>
        <td class="num">${rate(x.effective)}</td>
        <td class="num muted">${rate(x.floor)}</td>
        <td>${x.belowFloor ? '<span class="pill below">below</span> ' : ''}<span class="pill ${x.rateSource}">${x.rateSource}</span></td>
      </tr>`).join('');
  }

  /* ============================================================
     TAB 2 — Rates explorer
     ============================================================ */
  function renderRates() {
    const rows = BENCH.statsByTitle(FACTS);
    const tb = $('#rates-tbody');
    if (!rows.length) { tb.innerHTML = `<tr><td colspan="9" class="empty">No priced roles yet.</td></tr>`; return; }
    // global scale for bars: floor low → highest rack across shown titles
    const maxScale = Math.max(...rows.map(r => Math.max(r.rack, r.quotedMax)));
    const minScale = Math.min(...rows.map(r => r.floorLow)) * 0.9;
    const pos = (v) => ((v - minScale) / (maxScale - minScale)) * 100;
    tb.innerHTML = rows.map(r => {
      const floorPct = pos(r.floorHigh);
      const spanL = pos(r.effMin), spanR = pos(r.effMax);
      const bar = `
        <div class="rangebar" title="eff ${rate(r.effMin)}–${rate(r.effMax)} · floor ${rate(r.floorLow)}–${rate(r.floorHigh)} · rack ${rate(r.rack)}">
          <div class="floorzone" style="width:${floorPct.toFixed(1)}%"></div>
          <div class="span" style="left:${spanL.toFixed(1)}%;width:${Math.max(1.5, spanR - spanL).toFixed(1)}%"></div>
          <div class="med" style="left:${pos(r.effMed).toFixed(1)}%"></div>
          <div class="racktick" style="left:${pos(r.rack).toFixed(1)}%"></div>
        </div>
        <div class="rangelabels"><span>${rate(r.floorLow)} floor</span><span>${rate(r.rack)} rack</span></div>`;
      const bf = r.belowFloor ? `<span class="pill below">${r.belowFloor} / ${r.n}</span>` : `<span class="muted">0</span>`;
      return `<tr>
        <td class="tt">${esc(r.titleName)}</td>
        <td class="num">${r.n}</td>
        <td class="num">${rate(r.quotedMin)}</td>
        <td class="num tt">${rate(r.quotedMed)}</td>
        <td class="num">${rate(r.quotedMax)}</td>
        <td class="num">${rate(r.effMed)}</td>
        <td class="num muted">${rate(r.floorLow)}–${rate(r.floorHigh)}</td>
        <td style="min-width:220px">${bar}</td>
        <td class="num">${bf}</td>
      </tr>`;
    }).join('');
  }

  /* ============================================================
     TAB 3 — Project comparison
     ============================================================ */
  let picked = [];
  function renderPick() {
    const pick = $('#proj-pick');
    pick.innerHTML = PROJFACTS.map(p =>
      `<button class="projchip ${picked.includes(p.id) ? 'on' : ''}" data-id="${p.id}">${esc(p.name)}<span class="muted"> · ${esc(p.client)}</span></button>`
    ).join('');
    $$('#proj-pick .projchip').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.id;
      if (picked.includes(id)) picked = picked.filter(x => x !== id);
      else { if (picked.length >= 3) picked.shift(); picked.push(id); }
      renderPick(); renderCmp();
    }));
  }
  function renderCmp() {
    const out = $('#cmp-out');
    if (!picked.length) { out.innerHTML = `<div class="empty">Pick up to three projects above to compare.</div>`; return; }
    const ps = picked.map(id => PROJFACTS.find(p => p.id === id)).filter(Boolean);
    const col = `minmax(150px, 1fr) ` + ps.map(() => 'minmax(160px, 1fr)').join(' ');
    const row = (label, cells, opts = {}) => `<div class="cmp-row ${opts.head ? 'head' : ''}" style="grid-template-columns:${col}">
      <div class="cmp-cell">${label}</div>${cells.map(c => `<div class="cmp-cell ${opts.big ? 'cmp-big' : ''}">${c}</div>`).join('')}</div>`;

    // staff-title rows: union of titles across picked projects, effective median per project
    const titleIds = CATALOG.titles.map(t => t.id).filter(id => ps.some(p => p.roleFacts.some(f => f.titleId === id)));
    const titleRows = titleIds.map(id => {
      const name = CATALOG.titles.find(t => t.id === id).name;
      const cells = ps.map(p => {
        const fs = p.roleFacts.filter(f => f.titleId === id);
        if (!fs.length) return '<span class="muted">—</span>';
        const e = BENCH.median(fs.map(f => f.effective));
        const below = fs.some(f => f.belowFloor);
        return `${rate(e)}${below ? ' <span class="pill below">below</span>' : ''}`;
      });
      return row(name, cells);
    }).join('');

    // Scope & assumptions ✔/✘ matrix — read straight off the records.
    const raws = ps.map(p => STORE.getProject(p.id) || {});
    const yn = (on) => on ? '<span class="cmp-yes">✔</span>' : '<span class="cmp-no">✘</span>';
    const scopeUnion = [...new Set(raws.flatMap(r => (r.project && r.project.projectSubtypes) || []))].sort();
    const asmUnion = [...new Set(raws.flatMap(r => (r.project && r.project.assumptionsList) || []))].sort();
    const scopeRows = scopeUnion.length
      ? scopeUnion.map(s => row(esc(s), raws.map(r => yn(((r.project && r.project.projectSubtypes) || []).includes(s))))).join('')
      : `<div class="cmp-row" style="grid-template-columns:${col}"><div class="cmp-cell muted">No scope items captured on these projects.</div>${ps.map(() => '<div class="cmp-cell"></div>').join('')}</div>`;
    const asmRows = asmUnion.length
      ? asmUnion.map(s => row(esc(s), raws.map(r => yn(((r.project && r.project.assumptionsList) || []).includes(s))))).join('')
      : `<div class="cmp-row" style="grid-template-columns:${col}"><div class="cmp-cell muted">No assumptions captured on these projects.</div>${ps.map(() => '<div class="cmp-cell"></div>').join('')}</div>`;
    const sectionHead = (label) => `<div class="cmp-row head" style="grid-template-columns:${col}"><div class="cmp-cell">${label}</div>${ps.map(() => '<div class="cmp-cell"></div>').join('')}</div>`;

    out.innerHTML = `<div class="cmp-grid">
      ${row('Project', ps.map(p => `<strong>${esc(p.name)}</strong>`), { head: true })}
      ${row('Client', ps.map(p => esc(p.client)))}
      ${row('Industry', ps.map(p => esc(p.industry || '—')))}
      ${row('Project type', ps.map(p => esc(p.projectType || '—')))}
      ${row('Status', ps.map(p => `<span class="status-tag">${esc((STORE.STATUS_LABELS[p.status] || p.status || '—'))}</span>`))}
      ${row('Start year', ps.map(p => p.startYear || '—'))}
      ${row('Duration', ps.map(p => `${p.durationMonths} mo`))}
      ${row('Net fee', ps.map(p => money(p.net)), { big: true })}
      ${row('Client discount', ps.map(p => `${p.discountPct}%`))}
      ${row('Roles', ps.map(p => p.roleCount))}
      ${row('Below floor', ps.map(p => p.belowFloorCount ? `<span class="pill below">${p.belowFloorCount}</span>` : '0'))}
      ${sectionHead('Scope included')}
      ${scopeRows}
      ${sectionHead('Assumptions &amp; exclusions')}
      ${asmRows}
      <div class="cmp-row head" style="grid-template-columns:${col}"><div class="cmp-cell">Median effective rate by title</div>${ps.map(() => '<div class="cmp-cell"></div>').join('')}</div>
      ${titleRows}
    </div>`;
  }

  /* ---------- Tabs ---------- */
  function initTabs() {
    $$('.tab').forEach(t => t.addEventListener('click', () => {
      $$('.tab').forEach(x => x.classList.remove('on'));
      $$('.panel').forEach(x => x.classList.remove('on'));
      t.classList.add('on');
      $('#panel-' + t.dataset.tab).classList.add('on');
    }));
  }

  function renderFootnote() {
    $('#footnote').innerHTML = `<strong>How these numbers are built.</strong> Every priced role across all saved projects is read straight from its record using the same math as the calculator. <strong>Quoted</strong> is the start-year rate before the client discount; <strong>Effective</strong> applies the project's client discount — what the client actually paid. <strong>Floor</strong> is the role's Col E / Col G cost rate; a role is flagged <em>below floor</em> when its effective rate dips under that floor. Contracted rates are shown as billed (industry adjustment bypassed). The dashboard grows as you ingest more historicals.`;
  }

  function boot() {
    if (BENCH.removeSamples) BENCH.removeSamples();   // purge any previously-seeded sample projects
    load();
    renderKpis();
    fillFilterOptions();
    renderComp();
    renderRates();
    renderPick();
    renderCmp();
    renderFootnote();
    initTabs();
    ['#f-client', '#f-industry', '#f-ptype', '#f-title', '#f-size', '#f-role'].forEach(s =>
      $(s) && $(s).addEventListener('input', renderComp));
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (window.ufcReady && window.ufcReady.then) { window.ufcReady.then(boot); } else { boot(); }
  });
})();
