/* ============================================================
   SAVILLS PPM · STAFFING ALLOCATIONS — Excel round trip
   ------------------------------------------------------------
   One workbook that IS the allocation matrix: export it from Data
   Sources, clean it up in Excel, put it back. Built for a recurring
   sweep every few weeks while the matrix and the fee tool converge —
   it fades out as everything is entered live.

   Contract with the store
   -----------------------
   · ID is the join key and is never edited. A row with an ID updates
     that allocation; Action = REMOVE deletes it. Deleting a ROW does
     nothing — a stray sort-and-delete in Excel can't wipe records.
   · A row with NO ID and Action = ADD creates an allocation. A new
     person name creates the person (with the Title column).
   · PENDING ADDS come out ready-made: every open item on the contract
     bridge ("Contract staffing to be allocated" at the top of the
     Allocations tab) is a yellow row at the top with the window, %,
     client, project and contract slot filled in and Action BLANK. Put
     ADD in Action (the dropdown; fill down to accept many) → it is
     created on import and the bridge item clears. Leave it blank or
     delete the row → nothing happens. Opt-in, so an export put back
     untouched never adds two hundred rows by accident.
   · Round-trip guarantee: export → import with no edits is zero
     changes. The test suite asserts exactly that.

   Reading uses ExcelJS (the shared lazy vendor); the sheet is found by
   its headers, so a reordered or renamed workbook still imports.
   ============================================================ */
(function () {
  'use strict';
  const S = () => window.UFC_Staff;
  const COLS = [
    ['id', 'ID', 12], ['action', 'Action', 10], ['person', 'Person', 24], ['title', 'Title', 22],
    ['client', 'Client', 22], ['project', 'Project', 34], ['status', 'Status', 11], ['type', 'Type', 12],
    ['start', 'Start', 10], ['end', 'End', 10], ['pct', 'Allocation %', 12], ['note', 'Note', 40],
    ['contractRole', 'Contract role', 20], ['contractResource', 'Contract resource', 20], ['context', 'Why it is here', 46],
  ];
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const T = (v) => (v == null ? '' : String(v)).trim();

  /* ---------- the rows: pending adds first, then every allocation ---------- */
  function exportRows() {
    const St = S();
    const pending = [];
    let gaps = []; try { gaps = St.contractStaffingGaps() || []; } catch (e) { gaps = []; }
    gaps.forEach(g => {
      if (g.dismissed) return;
      (g.segments || []).forEach(sg => pending.push({
        id: '', action: '',
        person: g.open ? '' : (g.person ? g.person.name : (g.resource || '')),
        title: g.person ? (g.person.title || '') : '',
        client: g.client || '', project: g.project || '',
        status: 'Active', type: 'Awarded',
        start: sg.start, end: sg.end, pct: sg.need,
        note: (g.open ? 'Open contract role staffed' : (g.topUp ? 'Contract top-up (matrix had ' + sg.have + '%, contract ' + sg.want + '%)' : 'From contract staffing')) + ' · ' + (g.roles || []).join(', '),
        contractRole: g.open ? (g.roleTitle || '') : '',
        contractResource: g.open ? '' : (g.resource || ''),
        context: [g.open ? 'OPEN ROLE — type a name in Person' : (g.isNew ? 'not on the roster — will be created' : 'links to ' + g.person.name),
                  'contract ' + sg.want + '% · staffed ' + sg.have + '%', g.rating ? 'rating ' + g.rating : '', g.lead ? 'ask ' + g.lead : ''].filter(Boolean).join(' · '),
        pending: true,
      }));
    });
    const nameOf = (a) => { const p = St.getPerson(a.personId); return p ? p.name : (a.personName || a.personId || ''); };
    const existing = St.listAllocations().slice()
      .sort((a, b) => (a.project || '').localeCompare(b.project || '') || nameOf(a).localeCompare(nameOf(b)) || String(a.start || '').localeCompare(String(b.start || '')))
      .map(a => { const p = St.getPerson(a.personId); return {
        id: a.id, action: '', person: nameOf(a), title: p ? (p.title || '') : '',
        client: a.client || '', project: a.project || '', status: a.status || '', type: a.type || '',
        start: a.start || '', end: a.end || '', pct: +a.pct || 0, note: a.note || '',
        contractRole: a.contractRole || '', contractResource: a.contractResource || '', context: '' }; });
    return { pending, existing };
  }

  /* ---------- parsing helpers (what Excel hands back) ---------- */
  function cellText(v) {
    if (v == null) return '';
    if (v instanceof Date) return v;
    if (typeof v === 'object') {
      if (v.result != null) return cellText(v.result);
      if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
      if (v.text != null) return String(v.text);
      if (v.hyperlink) return String(v.text || v.hyperlink);
      return '';
    }
    return v;
  }
  /** 'YYYY-MM' from what a person or Excel puts in a month cell: 2026-09,
      2026-9, 2026-09-01, Sep-26, Sep 2026, September 2026, a real date, an
      Excel serial. null when it is none of those. */
  function parseYm(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : v.getUTCFullYear() + '-' + String(v.getUTCMonth() + 1).padStart(2, '0');
    if (typeof v === 'number') { if (v < 20000 || v > 80000) return null; const d = new Date(Math.round((v - 25569) * 86400000)); return parseYm(d); }
    const s = T(v);
    let m = /^(\d{4})[-\/.](\d{1,2})(?:[-\/.]\d{1,2})?(?:[T ].*)?$/.exec(s);
    if (m) { const mo = +m[2]; return mo >= 1 && mo <= 12 ? m[1] + '-' + String(mo).padStart(2, '0') : null; }
    m = /^([A-Za-z]{3})[A-Za-z]*[-\s']*(\d{2}|\d{4})$/.exec(s);
    if (m) { const mo = MON.indexOf(m[1].toLowerCase()); if (mo < 0) return null; const y = m[2].length === 2 ? 2000 + +m[2] : +m[2]; return y + '-' + String(mo + 1).padStart(2, '0'); }
    m = /^(\d{1,2})[-\/](\d{4})$/.exec(s);                      // 9/2026
    if (m) { const mo = +m[1]; return mo >= 1 && mo <= 12 ? m[2] + '-' + String(mo).padStart(2, '0') : null; }
    return null;
  }
  function parsePct(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v <= 1 && v > 0 && String(v).indexOf('.') >= 0 ? Math.round(v * 100) : v;   // Excel "60%" is 0.6
    const n = parseFloat(T(v).replace(/[%\s,]/g, ''));
    return isFinite(n) ? n : null;
  }
  const normStatus = (v) => { const s = T(v); const l = s.toLowerCase(); return l === 'active' ? 'Active' : l === 'pursuit' ? 'Pursuit' : s; };
  const normAction = (v) => T(v).toUpperCase().replace(/[^A-Z]/g, '');

  /** Column index per field from a header row, tolerant of case and wording. */
  function mapHeaders(cells) {
    const idx = {};
    const want = {
      id: /^id$|^allocation id$/, action: /^action$/, person: /^person|^name$|^resource|^person allocated/, title: /^title|^job title/,
      client: /^client/, project: /^project/, status: /^status/, type: /^type/, start: /^start|^from/, end: /^end|^to$|^through/,
      pct: /alloc|^pct$|^%|^percent/, note: /^note|^decision|^comment/, contractRole: /^contract role|^role$/, contractResource: /^contract resource|^contract name/,
    };
    cells.forEach((h, i) => { const k = T(cellText(h)).toLowerCase(); if (!k) return; Object.keys(want).forEach(f => { if (idx[f] == null && want[f].test(k)) idx[f] = i; }); });
    return idx;
  }
  /** Rows as plain objects from an ExcelJS worksheet (or any 2-D grid). */
  function rowsFromGrid(grid) {
    let hi = grid.findIndex(r => { const idx = mapHeaders(r); return idx.person != null && idx.project != null && idx.pct != null; });
    if (hi < 0) return null;
    const idx = mapHeaders(grid[hi]);
    const out = [];
    for (let r = hi + 1; r < grid.length; r++) {
      const row = grid[r] || []; const get = (f) => idx[f] == null ? '' : cellText(row[idx[f]]);
      const o = { row: r + 1, id: T(get('id')), action: normAction(get('action')), person: T(get('person')), title: T(get('title')),
        client: T(get('client')), project: T(get('project')), status: normStatus(get('status')), type: T(get('type')),
        start: get('start'), end: get('end'), pct: get('pct'), note: T(get('note')),
        contractRole: T(get('contractRole')), contractResource: T(get('contractResource')) };
      if (!o.id && !o.person && !o.project && !o.action) continue;     // blank line
      out.push(o);
    }
    return out;
  }
  async function parseWorkbook(file) {
    await window.UFC_Vendor.excel();
    if (typeof ExcelJS === 'undefined') throw new Error('Excel library not loaded.');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const sheets = [wb.getWorksheet('Allocations')].concat(wb.worksheets).filter(Boolean);
    for (const ws of sheets) {
      const grid = [];
      ws.eachRow({ includeEmpty: true }, (row, n) => { grid[n - 1] = row.values.slice(1); });
      const rows = rowsFromGrid(grid);
      if (rows) return rows;
    }
    throw new Error('No sheet with Person, Project and Allocation % columns — export the round trip first and edit that file.');
  }

  /* ---------- the plan: what the sheet would change, before it changes it ---------- */
  function buildPlan(rows) {
    const St = S();
    const plan = { adds: [], updates: [], removes: [], unchanged: 0, skipped: 0, errors: [] };
    const byId = {}; St.listAllocations().forEach(a => { byId[a.id] = a; });
    const people = St.listPeople();
    const resolve = (name) => { const hit = people.find(p => St.namesMatch(p.name, name)); return hit ? { personId: hit.id, personName: hit.name, isNew: false } : { personId: St.personIdForName(name), personName: name, isNew: true }; };
    const seen = new Set();
    (rows || []).forEach(r => {
      const where = 'Row ' + r.row;
      if (r.id && !byId[r.id]) { plan.errors.push(where + ': no allocation with ID ' + r.id + ' — was it deleted in the tool?'); return; }
      if (r.id && seen.has(r.id)) { plan.errors.push(where + ': ID ' + r.id + ' appears twice — the second copy was ignored.'); return; }
      if (r.id) seen.add(r.id);
      if (r.id && r.action === 'REMOVE') { const a = byId[r.id]; plan.removes.push({ id: r.id, person: r.person, project: a.project, start: a.start, end: a.end, pct: a.pct }); return; }
      if (!r.id && !(r.action === 'ADD' || r.action === 'NEW')) { plan.skipped++; return; }
      if (!r.person) { plan.errors.push(where + ': ' + (r.id ? 'Person is blank.' : 'Person is blank — an open role needs a name before it can be added.')); return; }
      if (!r.project) { plan.errors.push(where + ': Project is blank.'); return; }
      const stored = r.id ? byId[r.id] : null;
      const asIs = (v, cur) => stored != null && !(v instanceof Date) && T(v) === String(cur == null ? '' : cur);   // untouched cell: keep the stored value, even a malformed one
      const start = asIs(r.start, stored && stored.start) ? (stored.start || '') : parseYm(r.start);
      if (!start && !asIs(r.start, stored && stored.start)) { plan.errors.push(where + ': Start "' + T(r.start instanceof Date ? r.start.toISOString().slice(0, 10) : r.start) + '" is not a month (use YYYY-MM).'); return; }
      const end = asIs(r.end, stored && stored.end) ? (stored.end || '') : ((r.end == null || r.end === '') ? '' : parseYm(r.end));
      if (end === null) { plan.errors.push(where + ': End "' + T(r.end) + '" is not a month (use YYYY-MM or leave blank for open-ended).'); return; }
      const untouched = stored != null && asIs(r.start, stored.start) && asIs(r.end, stored.end);   // a stored oddity is not the sheet's fault
      if (end && end < start && !untouched) { plan.errors.push(where + ': ends (' + end + ') before it starts (' + start + ').'); return; }
      const pct = parsePct(r.pct); if (pct == null || pct < 0 || pct > 200) { plan.errors.push(where + ': Allocation % "' + T(r.pct) + '" is not a percentage.'); return; }
      const who = resolve(r.person);
      const next = { personId: who.personId, personName: who.personName, client: T(r.client), project: T(r.project), status: normStatus(r.status) || 'Active', type: T(r.type) || 'Awarded',
        start, end, pct: Math.round(pct * 10) / 10, note: r.note, contractRole: r.contractRole || undefined, contractResource: r.contractResource || undefined };
      if (!r.id) { plan.adds.push({ next, title: r.title, newPerson: who.isNew, person: who.personName, project: r.project, start, end, pct: next.pct }); return; }
      const a = byId[r.id]; const changes = [];
      const cmp = (k, label, cur, nu) => { if (String(cur == null ? '' : cur) !== String(nu == null ? '' : nu)) changes.push({ k, label, from: cur == null ? '' : cur, to: nu == null ? '' : nu }); };
      cmp('personId', 'Person', a.personId, next.personId);
      cmp('client', 'Client', a.client || '', next.client); cmp('project', 'Project', a.project || '', next.project);
      cmp('status', 'Status', a.status || '', next.status); cmp('type', 'Type', a.type || '', next.type);
      cmp('start', 'Start', a.start || '', next.start); cmp('end', 'End', a.end || '', next.end);
      cmp('pct', 'Allocation %', +a.pct || 0, next.pct); cmp('note', 'Note', a.note || '', next.note);
      cmp('contractRole', 'Contract role', a.contractRole || '', next.contractRole || ''); cmp('contractResource', 'Contract resource', a.contractResource || '', next.contractResource || '');
      if (!changes.length) { plan.unchanged++; return; }
      const patch = {}; changes.forEach(c => { patch[c.k] = next[c.k]; }); if (patch.personId != null) patch.personName = next.personName;
      plan.updates.push({ id: r.id, next: patch, changes, title: r.title, newPerson: who.isNew && patch.personId != null, person: who.personName, project: next.project,
        summary: changes.map(c => c.label + ' ' + (c.k === 'personId' ? ((St.getPerson(a.personId) || {}).name || a.personId) + ' → ' + who.personName : c.from + ' → ' + c.to)).join(', ') });
    });
    return plan;
  }
  function describePlan(plan) {
    const L = [];
    if (plan.errors.length) L.push(plan.errors.length + ' row' + (plan.errors.length === 1 ? '' : 's') + ' could not be read and will be left alone:\n  ' + plan.errors.slice(0, 8).join('\n  ') + (plan.errors.length > 8 ? '\n  …' : ''));
    L.push(plan.adds.length + ' to add' + (plan.adds.length ? ':\n  ' + plan.adds.slice(0, 10).map(x => x.person + ' · ' + x.project + ' · ' + x.start + (x.end ? '–' + x.end : '') + ' · ' + x.pct + '%' + (x.newPerson ? ' (new person)' : '')).join('\n  ') + (plan.adds.length > 10 ? '\n  …' : '') : ''));
    L.push(plan.updates.length + ' to change' + (plan.updates.length ? ':\n  ' + plan.updates.slice(0, 10).map(x => x.person + ' · ' + x.project + ': ' + x.summary).join('\n  ') + (plan.updates.length > 10 ? '\n  …' : '') : ''));
    L.push(plan.removes.length + ' to remove' + (plan.removes.length ? ':\n  ' + plan.removes.slice(0, 10).map(x => x.person + ' · ' + x.project + ' · ' + x.start + (x.end ? '–' + x.end : '')).join('\n  ') + (plan.removes.length > 10 ? '\n  …' : '') : ''));
    L.push(plan.unchanged + ' unchanged · ' + plan.skipped + ' yellow row' + (plan.skipped === 1 ? '' : 's') + ' without ADD (left out)');
    return L.join('\n\n');
  }

  /* ---------- the workbook ---------- */
  async function buildWorkbook() {
    await window.UFC_Vendor.excel();
    if (typeof ExcelJS === 'undefined') throw new Error('Excel library not loaded.');
    const { pending, existing } = exportRows();
    const wb = new ExcelJS.Workbook(); wb.creator = 'Savills PPM';
    const ws = wb.addWorksheet('Allocations', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = COLS.map(([key, header, width]) => ({ key, header, width }));
    const hr = ws.getRow(1);
    hr.eachCell(c => { c.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF25273A' } }; c.alignment = { vertical: 'middle', wrapText: true }; });
    hr.height = 20;
    const put = (r, yellow) => {
      const row = ws.addRow(Object.assign({}, r, { start: String(r.start || ''), end: String(r.end || '') }));
      row.eachCell({ includeEmpty: true }, c => { c.font = { name: 'Calibri', size: 10, color: { argb: yellow ? 'FF8A6D00' : 'FF25273A' } }; if (yellow) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDF3D7' } }; });
      row.getCell('id').font = { name: 'Calibri', size: 9, color: { argb: 'FF79828C' } };
      row.getCell('action').font = { name: 'Calibri', size: 10, bold: true, color: { argb: yellow ? 'FF8A6D00' : 'FF25273A' } };
      ['start', 'end'].forEach(k => { row.getCell(k).numFmt = '@'; row.getCell(k).alignment = { horizontal: 'left' }; });
      row.getCell('pct').numFmt = '0.#';
      if (!yellow) row.getCell('context').font = { name: 'Calibri', size: 9, color: { argb: 'FF79828C' } };
    };
    pending.forEach(r => put(r, true));
    existing.forEach(r => put(r, false));
    const last = ws.rowCount;
    if (last > 1) {
      ws.dataValidations.add('B2:B' + last, { type: 'list', allowBlank: true, formulae: ['"ADD,REMOVE"'], showErrorMessage: true, errorTitle: 'Action', error: 'ADD (a new row) or REMOVE (an existing row), or leave blank.' });
      ws.dataValidations.add('G2:G' + last, { type: 'list', allowBlank: true, formulae: ['"Active,Pursuit"'], showErrorMessage: false });
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: last, column: COLS.length } };
    }
    const how = wb.addWorksheet('How to');
    how.getColumn(1).width = 110;
    const lines = [
      ['Staffing allocations · Excel round trip', true],
      ['Exported ' + new Date().toLocaleString() + ' · ' + existing.length + ' allocations · ' + pending.length + ' pending add' + (pending.length === 1 ? '' : 's') + ' (yellow rows at the top of the Allocations sheet)', false],
      ['', false],
      ['YELLOW ROWS are contract staffing the matrix has not allocated yet — the same items as “Contract staffing to be allocated” at the top of the Allocations tab. Each comes with its window, %, client, project and contract slot filled in, and Action blank.', false],
      ['   Put ADD in Action (pick it from the dropdown; fill down to accept many) → the row is created when you import, and the item clears from the bridge.   Leave Action blank, or delete the row → nothing happens.   An OPEN ROLE has no Person: type a name (an existing roster name links; a new name is created with the Title you give).', false],
      ['', false],
      ['WHITE ROWS are every allocation as it stands. Edit any cell except ID. Put REMOVE in Action to delete one. Deleting a row does nothing — only REMOVE removes.', false],
      ['   Person: an existing roster name (nicknames and “Last, First” resolve). A new name creates the person.   Start / End: months as YYYY-MM (Sep-26 and real dates also read); leave End blank for open-ended.   Allocation %: 0–200.', false],
      ['   Contract role / Contract resource tie a row to the contract slot it satisfies, so the bridge knows it is covered — leave them as exported.', false],
      ['', false],
      ['TO PUT IT BACK: Staffing Matrix → Data Sources → ① Allocations → “Put it back”. You see the full list of adds, changes and removes before anything is written; the trail records the sweep under your name.', false],
      ['A file exported and imported without edits changes nothing.', false],
    ];
    lines.forEach(([t, bold], i) => { const c = how.getCell(i + 1, 1); c.value = t; c.font = { name: 'Calibri', size: bold ? 14 : 10, bold: !!bold, color: { argb: 'FF25273A' } }; c.alignment = { wrapText: true, vertical: 'top' }; });
    return wb;
  }
  async function exportRoundTrip() {
    const wb = await buildWorkbook();
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = 'Staffing Allocations round trip ' + new Date().toISOString().slice(0, 10) + '.xlsx';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    return exportRows();
  }

  window.UFC_StaffRoundTrip = { COLS, exportRows, rowsFromGrid, parseWorkbook, parseYm, parsePct, buildPlan, describePlan, buildWorkbook, exportRoundTrip };
})();
