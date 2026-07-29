/* ============================================================
   SAVILLS PPM · INGESTION STUDIO — REVENUE PROJECTIONS (BULK)
   ------------------------------------------------------------
   Upload a revenue leader's "3. Detailed Revenues" workbook, diff it
   against what's already in the system, and let an admin pick which
   projects to bring in — never a blind overwrite.

     • Parses the "3. Detailed Revenues" tab by locating its header row
       (matches on "Client"/"Project" columns) and its monthly columns
       by DATE VALUE rather than a hardcoded column index, so a sheet
       that gains/loses a year block or a column still parses.
     • A "project" in the sheet may span several rows (Base Contract +
       amendments) sharing one Project ID — these are summed into one
       group before anything else happens.
     • Only groups with revenue in 2026 or 2027 are kept (leadership's
       cutoff for this cycle) — a group with $0 in both years is
       dropped before matching even runs.
     • Matches each group to an existing project: Project ID first
       (best-effort — the sheet's IDs are D365/Salesforce codes that
       may not always line up with what's stored), then a token-based
       name+client match (same approach as staff.js's matchFeeProject).
       Every row also gets a manual override control, because the
       auto-match is a starting point, not a verdict.
     • Diffs against monthlySeries(p, catalog) — the SAME figure the
       app already shows everywhere (override-if-set, else computed,
       else a locked original import) — so "what would change" here
       means what would actually change on that project's page.
     • Import writes into project.monthlyOverrides, the exact field
       Revenue Projections' manual "✎ Edit" already writes to. Nothing
       new is invented; this is that same mechanism, in bulk.
   ============================================================ */
(function () {
  'use strict';
  const STORE = window.UFC_Store;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => (n == null || isNaN(n)) ? '—' : (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString();
  const uid = () => 'proj_' + Math.random().toString(36).slice(2, 11);

  /* ---------- token-based name matching (same approach as staff.js) ---------- */
  const STOP_WORDS = new Set(['the', 'of', 'and', 'a', 'an', 'for', 'to', 'at', 'in', 'on', 'llc', 'inc', 'corp', 'project', 'phase']);
  function nameTokens(s) { return String(s || '').toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(t => t && t.length > 1 && !STOP_WORDS.has(t)); }
  function tokenScore(a, b) {
    const ta = nameTokens(a), tb = nameTokens(b);
    if (!ta.length || !tb.length) return 0;
    const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    let hit = 0;
    small.forEach(t => {
      if (big.includes(t)) { hit += 1; return; }
      if (big.some(bt => (bt.length >= 3 && t.startsWith(bt)) || (t.length >= 3 && bt.startsWith(t)))) hit += 0.75;
    });
    return hit / small.length;
  }
  function buildProjectIndex() {
    return STORE.listProjects().map(p => ({
      id: p.id,
      name: (p.project && p.project.name) || '',
      client: (p.project && p.project.client) || '',
      sf: String((p.project && p.project.salesforceId) || '').trim().toLowerCase(),
      label: ((p.project && p.project.client) || '') + ' — ' + ((p.project && p.project.name) || ''),
    }));
  }
  function matchGroup(idx, g) {
    if (g.projectId) {
      const key = g.projectId.trim().toLowerCase();
      const hit = idx.find(p => p.sf && p.sf === key);
      if (hit) return { id: hit.id, label: hit.label, via: 'id' };
    }
    let best = null, bestScore = 0;
    idx.forEach(p => {
      let s = tokenScore(g.project, p.name);
      if (g.client && p.client) s = s * 0.8 + tokenScore(g.client, p.client) * 0.2;
      if (s > bestScore) { bestScore = s; best = p; }
    });
    if (best && bestScore >= 0.6) return { id: best.id, label: best.label, via: 'name', score: Math.round(bestScore * 100) };
    return null;
  }

  /* ---------- parse "3. Detailed Revenues" ---------- */
  async function parseWorkbook(file) {
    const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const sheetName = wb.SheetNames.find(n => /3[.\s]*detailed\s*revenues/i.test(n)) || wb.SheetNames.find(n => /detailed\s*revenues/i.test(n));
    if (!sheetName) throw new Error(`No "3. Detailed Revenues" tab found. Sheets in this file: ${wb.SheetNames.join(', ')}`);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
    return rows;
  }

  function findCol(header, re) { return header.findIndex(c => re.test(String(c == null ? '' : c).trim())); }

  function extractRows(rows) {
    const headerRowIdx = rows.findIndex(r => Array.isArray(r) && findCol(r, /^client$/i) >= 0 && findCol(r, /^project$/i) >= 0);
    if (headerRowIdx < 0) throw new Error('Could not find the header row — expected columns named "Client" and "Project".');
    const header = rows[headerRowIdx];
    const col = {
      client: findCol(header, /^client$/i),
      project: findCol(header, /^project$/i),
      projectId: findCol(header, /^project\s*id$/i),
      startDate: findCol(header, /^start\s*date$/i),
      endDate: findCol(header, /^end\s*date$/i),
      newOrEdit: findCol(header, /^new\s*or\s*edit$/i),
      revenueType: findCol(header, /^revenue\s*type$/i),
      contractType: findCol(header, /^contract\s*type$/i),
      rating: findCol(header, /rating.*likeli/i),
      leader: findCol(header, /revenue\s*leader/i),
    };
    // Month columns are literal Date values in the header row; group by year.
    // "Total YYYY" columns are labeled text, found the same way.
    const monthCols = {}, totalCols = {};
    header.forEach((v, i) => {
      if (v instanceof Date) {
        const y = v.getFullYear(), m = v.getMonth() + 1;
        (monthCols[y] = monthCols[y] || []).push({ col: i, month: m });
      } else {
        const m = /^total\s+(\d{4})/i.exec(String(v == null ? '' : v).trim());
        if (m) totalCols[+m[1]] = i;
      }
    });
    Object.keys(monthCols).forEach(y => monthCols[y].sort((a, b) => a.month - b.month));
    const years = Object.keys(monthCols).map(Number).sort();

    const out = [];
    for (let r = headerRowIdx + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const client = row[col.client];
      if (!client || !String(client).trim()) continue;   // real-row rule: a legend/total/adjustment row never has a Client
      const byYear = {}, totalsByYear = {};
      years.forEach(y => {
        byYear[y] = {};
        monthCols[y].forEach(mc => { byYear[y][mc.month] = Number(row[mc.col]) || 0; });
        totalsByYear[y] = totalCols[y] != null ? (Number(row[totalCols[y]]) || 0) : Object.values(byYear[y]).reduce((s, v) => s + v, 0);
      });
      out.push({
        rowNum: r + 1,
        client: String(client).trim(),
        project: String(row[col.project] || '').trim(),
        projectId: col.projectId >= 0 ? String(row[col.projectId] || '').trim() : '',
        startDate: col.startDate >= 0 ? row[col.startDate] : null,
        endDate: col.endDate >= 0 ? row[col.endDate] : null,
        newOrEdit: col.newOrEdit >= 0 ? row[col.newOrEdit] : null,
        revenueType: col.revenueType >= 0 ? String(row[col.revenueType] || '') : '',
        contractType: col.contractType >= 0 ? String(row[col.contractType] || '') : '',
        rating: col.rating >= 0 ? String(row[col.rating] || '') : '',
        leader: col.leader >= 0 ? String(row[col.leader] || '') : '',
        byYear, totalsByYear,
      });
    }
    return { rows: out, years };
  }

  /** Multiple sheet rows can share a Project ID (Base Contract + amendments) —
      sum them into one group. No ID → group by client+project name instead. */
  function groupRows(dataRows, years) {
    const groups = {};
    dataRows.forEach(r => {
      const key = r.projectId ? 'id:' + r.projectId.toLowerCase() : 'nc:' + r.client.toLowerCase() + '|' + r.project.toLowerCase();
      let g = groups[key];
      if (!g) {
        g = groups[key] = {
          key, client: r.client, project: r.project, projectId: r.projectId,
          rating: r.rating, revenueType: r.revenueType, leader: r.leader, newOrEdit: r.newOrEdit,
          startDate: r.startDate, endDate: r.endDate,
          byYear: {}, totalsByYear: {}, rows: [],
        };
        years.forEach(y => { g.byYear[y] = {}; for (let m = 1; m <= 12; m++) g.byYear[y][m] = 0; g.totalsByYear[y] = 0; });
      }
      g.rows.push(r);
      // widen the date range across amendments
      if (r.startDate && (!g.startDate || r.startDate < g.startDate)) g.startDate = r.startDate;
      if (r.endDate && (!g.endDate || r.endDate > g.endDate)) g.endDate = r.endDate;
      years.forEach(y => {
        Object.keys(r.byYear[y] || {}).forEach(m => { g.byYear[y][m] += r.byYear[y][m] || 0; });
        g.totalsByYear[y] += r.totalsByYear[y] || 0;
      });
    });
    return Object.values(groups);
  }

  /** Leadership's cutoff for this cycle: drop anything with $0 in both 2026 and 2027. */
  function filterGroups(groups) {
    return groups.filter(g => Math.round(g.totalsByYear[2026] || 0) !== 0 || Math.round(g.totalsByYear[2027] || 0) !== 0);
  }

  /* ---------- diff against what's currently in effect ---------- */
  function currentSeriesByYear(project, years) {
    const catalog = window.RATES_CATALOG;
    const series = STORE.monthlySeries(project, catalog) || [];
    const out = {};
    years.forEach(y => { out[y] = {}; for (let m = 1; m <= 12; m++) out[y][m] = 0; });
    series.forEach(s => { if (out[s.year]) out[s.year][s.month] = s.amount || 0; });
    return out;
  }
  function lockedByOriginalImport(project) {
    return !!(project && project.source && project.source.importedByMonth && !project.source.reconciled);
  }

  function diffGroup(g, matchedProject, years) {
    if (!matchedProject) {
      return { isNew: true, changedMonths: 0, totalDelta: g.totalsByYear[2026] + (g.totalsByYear[2027] || 0), current: null };
    }
    const current = currentSeriesByYear(matchedProject, years);
    let changedMonths = 0, totalDelta = 0;
    years.forEach(y => {
      for (let m = 1; m <= 12; m++) {
        const sheetV = Math.round((g.byYear[y][m] || 0) * 100) / 100;
        const curV = Math.round((current[y][m] || 0) * 100) / 100;
        if (Math.abs(sheetV - curV) >= 0.5) { changedMonths++; totalDelta += (sheetV - curV); }
      }
    });
    return { isNew: false, changedMonths, totalDelta, current, locked: lockedByOriginalImport(matchedProject) };
  }

  /* ---------- new lightweight project (override-driven, no roster) ---------- */
  function monthsFromDates(startDate, endDate, years) {
    if (startDate instanceof Date && endDate instanceof Date) {
      return { startMonth: startDate.getMonth() + 1, startYear: startDate.getFullYear(), endMonth: endDate.getMonth() + 1, endYear: endDate.getFullYear() };
    }
    // fall back to spanning the years the sheet actually carries revenue for
    const y0 = Math.min(...years), y1 = Math.max(...years);
    return { startMonth: 1, startYear: y0, endMonth: 12, endYear: y1 };
  }
  function buildOverrides(g, years) {
    const ov = {};
    years.forEach(y => { for (let m = 1; m <= 12; m++) { const v = g.byYear[y][m] || 0; if (v) ov[y + '-' + m] = Math.round(v * 100) / 100; } });
    return ov;
  }
  function createLightweightProject(g, years) {
    const tl = monthsFromDates(g.startDate, g.endDate, years);
    const totalMonths = Math.max(1, (tl.endYear - tl.startYear) * 12 + (tl.endMonth - tl.startMonth) + 1);
    const booked = /^1\s*:/.test(g.rating || '');
    const record = {
      project: {
        name: g.project || 'Untitled', client: g.client || '', lead: '', proposalDate: new Date().toISOString().slice(0, 10),
        location: '', status: booked ? 'won' : 'negotiation', industry: '',
        firstProposalDate: '', signedContractDate: '', clientContact: '', clientRelOwner: '',
        salesforceId: g.projectId || '',
      },
      timeline: { startMonth: tl.startMonth, startYear: tl.startYear, endMonth: tl.endMonth, endYear: tl.endYear },
      phases: [{ id: uid(), name: 'Full term', length: totalMonths }],
      groups: [{ id: uid(), name: 'Core team' }],
      roles: [],
      assumptions: { hrsPerMo: 173.33, escalation: 3.0, industryAdj: 20, discount: 0, rateLock: false, billingMode: 'phase', catalogBaseYear: (window.RATES_CATALOG && window.RATES_CATALOG.baseYear) || 2024 },
      monthlyOverrides: buildOverrides(g, years),
      source: { type: 'revenue-import', name: state.fileName || 'revenue projections', ingestedAt: new Date().toISOString(), sheetProjectId: g.projectId || null, sheetRating: g.rating || null },
    };
    return STORE.saveProject(record);
  }
  function applyOverridesToProject(projectId, g, years) {
    const p = STORE.getProject(projectId);
    if (!p) throw new Error('Matched project no longer exists — it may have been deleted.');
    const ov = Object.assign({}, p.monthlyOverrides || {}, buildOverrides(g, years));
    const next = { ...p, monthlyOverrides: ov };
    return STORE.saveProject(next, { baseUpdatedAt: p.updatedAt });
  }

  /* ---------- state + render ---------- */
  const state = { fileName: '', years: [], groups: [], projectIndex: [], overrides: {}, included: new Set() };

  function setStatus(msg, cls) {
    const el = $('#ri-status'); if (!el) return;
    el.textContent = msg || ''; el.className = 'src-status' + (cls ? ' ' + cls : '');
  }

  function summarize() {
    const total = state.groups.length;
    let matched = 0, changed = 0, unchanged = 0, unmatched = 0;
    state.groups.forEach(g => {
      const pid = state.overrides[g.key] !== undefined ? state.overrides[g.key] : (g.match && g.match.id);
      if (pid) { matched++; const d = diffGroup(g, STORE.getProject(pid), state.years); if (d.changedMonths) changed++; else unchanged++; }
      else unmatched++;
    });
    return { total, matched, changed, unchanged, unmatched, selected: state.included.size };
  }

  function renderSummary() {
    const s = summarize();
    $('#ri-sum').innerHTML = `
      <div class="sumcard"><div class="lbl">Projects in sheet</div><div class="val">${s.total}</div></div>
      <div class="sumcard ok"><div class="lbl">Matched · changed</div><div class="val">${s.changed}</div></div>
      <div class="sumcard"><div class="lbl">Matched · unchanged</div><div class="val">${s.unchanged}</div></div>
      <div class="sumcard warn"><div class="lbl">New / unmatched</div><div class="val">${s.unmatched}</div></div>`;
    $('#ri-apply-btn').textContent = `Import selected (${s.selected}) →`;
    $('#ri-apply-btn').disabled = s.selected === 0;
  }

  function projectOptionsHtml(selectedId) {
    return state.projectIndex.map(p => `<option value="${esc(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.label)}</option>`).join('');
  }

  function monthDiffTable(g, matchedProjectId) {
    const p = matchedProjectId ? STORE.getProject(matchedProjectId) : null;
    const current = p ? currentSeriesByYear(p, state.years) : null;
    return state.years.map(y => {
      const cells = [];
      for (let m = 1; m <= 12; m++) {
        const sheetV = g.byYear[y][m] || 0;
        const curV = current ? (current[y][m] || 0) : null;
        const changed = curV != null && Math.abs(sheetV - curV) >= 0.5;
        cells.push(`<td class="num ${changed ? 'ri-changed' : ''}" title="${esc(String(y))}-${m}">${sheetV ? money(sheetV) : '·'}${curV != null && changed ? `<div class="ri-was">was ${money(curV)}</div>` : ''}</td>`);
      }
      return `<tr><td class="ri-yr">${y}</td>${cells.join('')}<td class="num" style="font-weight:700">${money(g.totalsByYear[y] || 0)}</td></tr>`;
    }).join('');
  }

  function renderTable() {
    const tb = $('#ri-tbody');
    if (!state.groups.length) { tb.innerHTML = `<tr><td colspan="9" class="empty">Drop a revenue projections workbook above.</td></tr>`; return; }
    tb.innerHTML = state.groups.map((g, i) => {
      const matchedId = state.overrides[g.key] !== undefined ? state.overrides[g.key] : (g.match && g.match.id) || '';
      const matchedProject = matchedId ? STORE.getProject(matchedId) : null;
      const d = diffGroup(g, matchedProject, state.years);
      const checked = state.included.has(g.key);
      const matchBadge = !matchedId
        ? `<span class="ri-badge ri-new">New</span>`
        : (g.match && g.match.via === 'id' ? `<span class="ri-badge ri-id">ID match</span>` : `<span class="ri-badge ri-name">Name match${g.match && g.match.score ? ' · ' + g.match.score + '%' : ''}</span>`);
      const deltaTxt = d.isNew ? `${money(d.totalDelta)} (new)` : (d.changedMonths ? `${d.totalDelta >= 0 ? '+' : ''}${money(d.totalDelta)} across ${d.changedMonths} mo` : 'no change');
      const lockWarn = d.locked ? `<div class="ri-warn">⚠ locked to its original import — a new override won't show until this project is reconciled</div>` : '';
      return `<tr class="ri-row" data-key="${esc(g.key)}">
        <td><input type="checkbox" class="ri-check" data-key="${esc(g.key)}" ${checked ? 'checked' : ''}></td>
        <td>${esc(g.client)}</td>
        <td>${esc(g.project)}${g.rows.length > 1 ? `<span class="raw">${g.rows.length} sheet rows summed</span>` : ''}</td>
        <td>${esc(g.rating || '—')}</td>
        <td>${matchBadge}<div class="ri-match-pick"><input list="ri-projects-${i}" class="ri-match-input" data-key="${esc(g.key)}" value="${matchedProject ? esc(((matchedProject.project||{}).client||'') + ' — ' + ((matchedProject.project||{}).name||'')) : ''}" placeholder="type to link… or leave blank = new"><datalist id="ri-projects-${i}">${projectOptionsDatalist()}</datalist></div></td>
        <td class="num">${money(g.totalsByYear[2026] || 0)}</td>
        <td class="num">${money(g.totalsByYear[2027] || 0)}</td>
        <td class="num ${d.changedMonths || d.isNew ? 'ri-delta' : ''}">${deltaTxt}${lockWarn}</td>
        <td><button class="ri-expand" data-key="${esc(g.key)}" title="Month-by-month detail">▸</button></td>
      </tr>
      <tr class="ri-detail-row" data-detail="${esc(g.key)}" hidden><td colspan="9">
        <table class="ri-detail"><thead><tr><th>Yr</th>${Array.from({length:12},(_,i)=>`<th>${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][i]}</th>`).join('')}<th>Total</th></tr></thead>
        <tbody>${monthDiffTable(g, matchedId)}</tbody></table>
      </td></tr>`;
    }).join('');

    $$('.ri-check').forEach(cb => cb.onchange = () => { const k = cb.dataset.key; if (cb.checked) state.included.add(k); else state.included.delete(k); renderSummary(); });
    $$('.ri-expand').forEach(b => b.onclick = () => {
      const row = $(`.ri-detail-row[data-detail="${CSS.escape(b.dataset.key)}"]`);
      if (row) { row.hidden = !row.hidden; b.textContent = row.hidden ? '▸' : '▾'; }
    });
    $$('.ri-match-input').forEach(inp => inp.onchange = () => {
      const k = inp.dataset.key;
      const label = inp.value.trim();
      if (!label) { state.overrides[k] = null; renderTable(); renderSummary(); return; }
      const hit = state.projectIndex.find(p => p.label.toLowerCase() === label.toLowerCase());
      if (hit) { state.overrides[k] = hit.id; renderTable(); renderSummary(); }
    });
  }
  function projectOptionsDatalist() {
    return state.projectIndex.map(p => `<option value="${esc(p.label)}">`).join('');
  }

  async function applySelected() {
    const btn = $('#ri-apply-btn'); const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Importing…';
    let created = 0, updated = 0, failed = [];
    for (const g of state.groups) {
      if (!state.included.has(g.key)) continue;
      const matchedId = state.overrides[g.key] !== undefined ? state.overrides[g.key] : (g.match && g.match.id);
      try {
        if (matchedId) { applyOverridesToProject(matchedId, g, state.years); updated++; }
        else { createLightweightProject(g, state.years); created++; }
      } catch (e) { failed.push(`${g.client} — ${g.project}: ${e.message}`); }
    }
    state.included.clear();
    state.projectIndex = buildProjectIndex();   // new projects now exist — refresh matching pool
    renderTable(); renderSummary();
    btn.textContent = orig; btn.disabled = false;
    setStatus(`Imported: ${updated} updated, ${created} created` + (failed.length ? ` — ${failed.length} failed (${failed.join(' · ')})` : ''), failed.length ? 'bad' : '');
  }

  /** Everything after the raw sheet_to_json rows are in hand — shared by the
      real upload path and the test seam below, so both exercise identical
      grouping/filtering/matching/selection logic. */
  function processParsedRows(rows) {
    const { rows: dataRows, years } = extractRows(rows);
    const groups = filterGroups(groupRows(dataRows, years));
    state.years = years;
    state.projectIndex = buildProjectIndex();
    state.overrides = {};
    state.included = new Set();
    groups.forEach(g => { g.match = matchGroup(state.projectIndex, g); });
    groups.sort((a, b) => a.client.localeCompare(b.client) || a.project.localeCompare(b.project));
    state.groups = groups;
    // default selection: matched-with-changes are pre-checked; new/unmatched and
    // unchanged are opt-in, so a bulk import never silently creates or no-ops
    groups.forEach(g => {
      if (!g.match) return;                 // new project — opt-in only
      const d = diffGroup(g, STORE.getProject(g.match.id), years);
      if (d.changedMonths) state.included.add(g.key);
    });
    renderTable(); renderSummary();
    return { dataRows, groups, years };
  }

  async function handleFile(file) {
    state.fileName = file.name;
    setStatus(`Reading ${file.name}…`, 'busy');
    try {
      const rows = await parseWorkbook(file);
      const { dataRows, groups, years } = processParsedRows(rows);
      setStatus(`Parsed ${dataRows.length} sheet rows → ${groups.length} projects with 2026/2027 revenue (years found: ${years.join(', ')}).`, '');
    } catch (e) {
      setStatus('Could not read that workbook: ' + e.message, 'bad');
    }
  }

  function wire() {
    const dz = $('#ri-dropzone'), fi = $('#ri-file-input');
    if (!dz || !fi) return;
    $('#ri-choose-btn').addEventListener('click', (e) => { e.stopPropagation(); fi.click(); });
    dz.addEventListener('click', () => fi.click());
    fi.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); fi.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'dragend', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
    $('#ri-apply-btn').addEventListener('click', applySelected);
    renderTable(); renderSummary();
  }

  function boot() {
    const start = () => wire();
    if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(start); else start();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.UFC_RevenueImport = { handleFile, processParsedRows };   // exposed for tests
})();
