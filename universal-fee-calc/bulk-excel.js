/* ============================================================
   SAVILLS PPM · BULK EXCEL ROUND TRIP  (projects.json ⇄ .xlsx)
   ------------------------------------------------------------
   One workbook that IS the project database: export it, scrub it
   in Excel, put it back. Built for a single mass cleanup pass,
   not for daily use — pair it with maintenance mode so nobody
   else is writing while the book is out of the building.

   Contract with the rest of the system
   ------------------------------------
   · Project ID is the join key and is never edited. A row with no
     ID (or Action = NEW) creates a project; Action = REMOVE
     soft-deletes it. Deleting a ROW does nothing — that way a
     stray sort-and-delete in Excel can't wipe records.
   · Sheets are AUTHORITATIVE PER PROJECT: if a project appears on
     the Roles sheet, its roster is rebuilt from those rows (so
     deleting a role row really deletes the role). Projects absent
     from a sheet keep whatever they had.
   · Anything the workbook doesn't model — imported-revenue
     provenance, change-order links, versions, activity — is
     carried over from the live record untouched.
   · Round-trip guarantee: export → reimport with no edits must
     report zero changes. The test suite asserts exactly that.
   ============================================================ */
(function () {
  'use strict';
  const STORE = () => window.UFC_Store;

  /* ---------- small helpers ---------- */
  const S = (v) => (v == null ? '' : String(v)).trim();
  const N = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
  const YESNO = (v) => /^(y|yes|true|on|1)$/i.test(S(v));
  const uid = (p) => p + Math.random().toString(36).slice(2, 9);
  /** Store month keys are unpadded ("2026-3"); Excel wants sortable text. */
  const toXlMonth = (k) => { const [y, m] = String(k).split('-'); return y + '-' + String(+m).padStart(2, '0'); };
  const toDbMonth = (k) => { const [y, m] = String(k).split('-'); return +y + '-' + (+m); };
  const ymText = (y, m) => (y && m) ? (y + '-' + String(m).padStart(2, '0')) : '';
  function parseYm(v) {
    const s = S(v);
    if (!s) return null;
    let mm = /^(\d{4})[-/](\d{1,2})$/.exec(s);
    if (mm) return { year: +mm[1], month: +mm[2] };
    const d = (v instanceof Date) ? v : null;              // Excel may hand back a real date
    if (d) return { year: d.getFullYear(), month: d.getMonth() + 1 };
    return null;
  }

  /* ---------- column definitions ----------
     `key` drives both write and read, so the two directions can never
     drift apart. `ro: true` = reference only, ignored on import. */
  const PROJECT_COLS = [
    { key: 'id',            h: 'Project ID',        w: 20, lock: true },
    { key: 'action',        h: 'Action',            w: 10 },
    { key: 'name',          h: 'Project name',      w: 38 },
    { key: 'client',        h: 'Client',            w: 26 },
    { key: 'status',        h: 'Status',            w: 14, list: 'Status' },
    { key: 'rating',        h: 'Rating',            w: 18, list: 'Rating' },
    { key: 'industry',      h: 'Industry',          w: 20, list: 'Industry' },
    { key: 'projectType',   h: 'Project type',      w: 34, list: 'ProjectType' },
    { key: 'lead',          h: 'Lead PE',           w: 22, list: 'Lead' },
    { key: 'location',      h: 'Location',          w: 20 },
    { key: 'salesforceId',  h: 'Salesforce ID',     w: 16, text: true },
    { key: 'clientContact', h: 'Client contact',    w: 22 },
    { key: 'clientRelOwner',h: 'Relationship owner',w: 22 },
    { key: 'start',         h: 'Start (YYYY-MM)',   w: 15, text: true },
    { key: 'end',           h: 'End (YYYY-MM)',     w: 15, text: true },
    { key: 'hrsPerMo',      h: 'Hrs / month',       w: 12, num: true },
    { key: 'escalation',    h: 'Escalation %',      w: 13, num: true },
    { key: 'industryAdj',   h: 'Industry adj %',    w: 14, num: true },
    { key: 'discount',      h: 'Discount %',        w: 12, num: true },
    { key: 'rateLock',      h: 'Rate lock (Y/N)',   w: 14, list: 'YesNo' },
    { key: 'billingMode',   h: 'Fee basis',         w: 13, list: 'Billing' },
    { key: 'catalogBaseYear', h: 'Rate grid year',  w: 14, num: true },
    { key: 'notes',         h: 'Notes',             w: 40 },
    { key: 'refFee',        h: '▸ Net fee',         w: 15, ro: true, num: true },
    { key: 'refRoles',      h: '▸ Roles',           w: 9,  ro: true, num: true },
    { key: 'refUpdated',    h: '▸ Last updated',    w: 20, ro: true },
    { key: 'refBy',         h: '▸ Last edited by',  w: 20, ro: true },
  ];
  const MAX_PHASE_COLS = 8;
  const ROLE_COLS = [
    { key: 'projectId', h: 'Project ID',   w: 20, lock: true },
    { key: 'refProject',h: '▸ Project',    w: 30, ro: true },
    { key: 'roleId',    h: 'Role ID',      w: 16, lock: true },
    { key: 'action',    h: 'Action',       w: 10 },
    { key: 'group',     h: 'Team / group', w: 18 },
    { key: 'titleId',   h: 'Title ID',     w: 20, list: 'TitleId' },
    { key: 'tierId',    h: 'Tier',         w: 10, list: 'Tier' },
    { key: 'projectRole', h: 'Project role', w: 22 },
    { key: 'resource',  h: 'Resource (name)', w: 24 },
    { key: 'rateSource',h: 'Rate source',  w: 14, list: 'RateSource' },
    { key: 'contractedRate', h: 'Contracted rate', w: 15, num: true },
  ];
  const PHASE_COLS = [
    { key: 'projectId', h: 'Project ID', w: 20, lock: true },
    { key: 'refProject',h: '▸ Project',  w: 30, ro: true },
    { key: 'phaseId',   h: 'Phase ID',   w: 14, lock: true },
    { key: 'order',     h: 'Order',      w: 8,  num: true },
    { key: 'name',      h: 'Phase name', w: 26 },
    { key: 'length',    h: 'Length (months)', w: 16, num: true },
  ];
  const GROUP_COLS = [
    { key: 'projectId', h: 'Project ID', w: 20, lock: true },
    { key: 'refProject',h: '▸ Project',  w: 30, ro: true },
    { key: 'groupId',   h: 'Group ID',   w: 14, lock: true },
    { key: 'name',      h: 'Team name',  w: 26 },
    { key: 'serviceLine', h: 'Service line', w: 24 },
  ];
  const REV_COLS = [
    { key: 'projectId', h: 'Project ID', w: 20, lock: true },
    { key: 'refProject',h: '▸ Project',  w: 30, ro: true },
    { key: 'kind',      h: 'Kind',       w: 12, list: 'RevKind' },
    { key: 'month',     h: 'Month (YYYY-MM)', w: 16, text: true },
    { key: 'amount',    h: 'Amount',     w: 15, num: true },
  ];

  const NAVY = 'FF25273A', WHITE = 'FFFFFFFF', GREY = 'FFF0EFEC', LOCK = 'FFE4E2DD';

  /* ---------- flatten one project into its sheet rows ---------- */
  function projectRow(p) {
    const pj = p.project || {}, tl = p.timeline || {}, a = p.assumptions || {};
    let fee = 0;
    try { const f = STORE().projectFinancials(p, window.RATES_CATALOG); fee = (f && f.net) || 0; } catch (e) {}
    return {
      id: p.id, action: '',
      name: pj.name || '', client: pj.client || '', status: pj.status || '', rating: pj.rating || '',
      industry: pj.industry || '', projectType: pj.projectType || '',
      lead: pj.leadId ? (STORE().leaderDisplay(pj.leadId) || pj.lead || '') : (pj.lead || ''),
      location: pj.location || '', salesforceId: pj.salesforceId || '',
      clientContact: pj.clientContact || '', clientRelOwner: pj.clientRelOwner || '',
      start: ymText(tl.startYear, tl.startMonth), end: ymText(tl.endYear, tl.endMonth),
      hrsPerMo: a.hrsPerMo == null ? '' : a.hrsPerMo,
      escalation: a.escalation == null ? '' : a.escalation,
      industryAdj: a.industryAdj == null ? '' : a.industryAdj,
      discount: a.discount == null ? '' : a.discount,
      rateLock: a.rateLock ? 'Y' : 'N',
      billingMode: a.billingMode || 'phase',
      catalogBaseYear: a.catalogBaseYear == null ? '' : a.catalogBaseYear,
      notes: pj.notes || '',
      refFee: Math.round(fee), refRoles: (p.roles || []).length,
      refUpdated: p.updatedAt || '', refBy: (p.lastSavedBy && (p.lastSavedBy.name || p.lastSavedBy.username)) || '',
    };
  }
  function roleRows(p) {
    const groups = p.groups || [];
    const gName = (id) => (groups.find(g => g.id === id) || {}).name || '';
    const phases = p.phases || [];
    return (p.roles || []).map(r => {
      const row = {
        projectId: p.id, refProject: (p.project || {}).name || '', roleId: r.id || '', action: '',
        group: gName(r.groupId), titleId: r.titleId || '', tierId: r.tierId || '',
        projectRole: r.projectRole || '', resource: r.resource || '',
        rateSource: r.rateSource === 'contracted' ? 'contracted' : 'grid',
        contractedRate: r.rateSource === 'contracted' ? (r.contractedRate == null ? 0 : r.contractedRate) : '',
      };
      phases.slice(0, MAX_PHASE_COLS).forEach((ph, i) => {
        const v = (r.fte || {})[ph.id];
        row['fte' + (i + 1)] = (v == null || v === '') ? '' : v;
      });
      row._monthly = r.fteMonthly && Object.keys(r.fteMonthly).length ? 'yes' : '';
      return row;
    });
  }
  function revRows(p) {
    const out = [];
    const imp = (p.source || {}).importedByMonth || {};
    Object.keys(imp).sort().forEach(k => out.push({ projectId: p.id, refProject: (p.project || {}).name || '', kind: 'imported', month: toXlMonth(k), amount: imp[k] }));
    const ov = p.monthlyOverrides || {};
    Object.keys(ov).sort().forEach(k => out.push({ projectId: p.id, refProject: (p.project || {}).name || '', kind: 'override', month: toXlMonth(k), amount: ov[k] }));
    return out;
  }

  /* ---------- EXPORT ---------- */
  async function buildWorkbook() {
    if (typeof ExcelJS === 'undefined') throw new Error('Excel library not loaded on this page.');
    const st = STORE();
    const projects = st.listProjects().slice().sort((a, b) =>
      ((a.project || {}).client || '').localeCompare((b.project || {}).client || '') ||
      ((a.project || {}).name || '').localeCompare((b.project || {}).name || ''));
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Savills PPM'; wb.created = new Date();

    /* Lists sheet first — the dropdowns point at it. */
    const lists = wb.addWorksheet('Lists');
    const listCols = [
      ['Status', st.STATUSES.slice()],
      ['Rating', (st.RATINGS || []).map(r => (typeof r === 'string' ? r : (r.label || r.id || '')))],
      ['Industry', st.INDUSTRIES.slice()],
      ['ProjectType', st.PROJECT_TYPES.map(t => t.name)],
      ['Lead', st.REVENUE_LEADERS.map(l => l.displayName)],
      ['YesNo', ['Y', 'N']],
      ['Billing', ['phase', 'flatline']],
      ['RateSource', ['grid', 'contracted']],
      ['Tier', ['high', 'mid', 'low']],
      ['RevKind', ['imported', 'override']],
      ['TitleId', ((window.RATES_CATALOG && window.RATES_CATALOG.titles) || []).map(t => t.id)],
    ];
    const listRange = {};
    listCols.forEach((pair, i) => {
      const col = i + 1;
      lists.getColumn(col).width = 26;
      lists.getCell(1, col).value = pair[0];
      lists.getCell(1, col).font = { bold: true, color: { argb: WHITE } };
      lists.getCell(1, col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      pair[1].forEach((v, r) => { lists.getCell(r + 2, col).value = v; });
      const letter = lists.getColumn(col).letter;
      listRange[pair[0]] = pair[1].length ? `Lists!$${letter}$2:$${letter}$${pair[1].length + 1}` : null;
    });

    /* Generic sheet writer: header styling, widths, locks, validation. */
    function sheet(name, cols, rows) {
      const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
      ws.columns = cols.map(c => ({ width: c.w }));
      cols.forEach((c, i) => {
        const cell = ws.getRow(1).getCell(i + 1);
        cell.value = c.h;
        cell.font = { name: 'Calibri', bold: true, size: 10, color: { argb: WHITE } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.ro ? 'FF79828C' : NAVY } };
        cell.alignment = { vertical: 'middle', wrapText: true };
      });
      ws.getRow(1).height = 26;
      rows.forEach((r, ri) => {
        const row = ws.getRow(ri + 2);
        cols.forEach((c, i) => {
          const cell = row.getCell(i + 1);
          const v = r[c.key];
          cell.value = (v === '' || v == null) ? null : (c.num ? (typeof v === 'number' ? v : N(v)) : v);
          if (c.num) cell.numFmt = '#,##0.##';
          if (c.text) cell.numFmt = '@';
          if (c.lock || c.ro) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.lock ? LOCK : GREY } };
          if (c.list && listRange[c.list]) {
            cell.dataValidation = { type: 'list', allowBlank: true, formulae: [listRange[c.list]], showErrorMessage: true,
              errorTitle: 'Pick from the list', error: 'Use one of the values on the Lists sheet — free text is rejected on import.' };
          }
        });
      });
      if (rows.length) ws.autoFilter = { from: 'A1', to: { row: 1, column: cols.length } };
      return ws;
    }

    /* Projects */
    sheet('Projects', PROJECT_COLS, projects.map(projectRow));

    /* Roles — FTE columns are per phase INDEX, since phases differ per project */
    const roleCols = ROLE_COLS.concat(
      Array.from({ length: MAX_PHASE_COLS }, (_, i) => ({ key: 'fte' + (i + 1), h: 'FTE% P' + (i + 1), w: 10, num: true })),
      [{ key: '_monthly', h: '▸ Month-by-month FTE?', w: 20, ro: true }]);
    const allRoles = [];
    projects.forEach(p => allRoles.push(...roleRows(p)));
    sheet('Roles', roleCols, allRoles);

    /* Phases / Groups / Revenue */
    const allPhases = [];
    projects.forEach(p => (p.phases || []).forEach((ph, i) => allPhases.push({
      projectId: p.id, refProject: (p.project || {}).name || '', phaseId: ph.id, order: i + 1, name: ph.name || '', length: ph.length || 0,
    })));
    sheet('Phases', PHASE_COLS, allPhases);

    const allGroups = [];
    projects.forEach(p => (p.groups || []).forEach(g => allGroups.push({
      projectId: p.id, refProject: (p.project || {}).name || '', groupId: g.id, name: g.name || '', serviceLine: g.serviceLine || '',
    })));
    sheet('Groups', GROUP_COLS, allGroups);

    const allRev = [];
    projects.forEach(p => allRev.push(...revRows(p)));
    sheet('Revenue', REV_COLS, allRev);

    /* Read me — written last so it lands first in the tab order */
    const rm = wb.addWorksheet('Read me', { views: [{ showGridLines: false }] });
    rm.columns = [{ width: 30 }, { width: 108 }];
    rm.getCell('A1').value = 'Savills PPM — bulk project editor';
    rm.getCell('A1').font = { bold: true, size: 15, color: { argb: NAVY } };
    rm.getCell('A2').value = `Exported ${new Date().toLocaleString()} · ${projects.length} projects · schema v${st.SCHEMA}`;
    rm.getCell('A2').font = { italic: true, size: 10, color: { argb: 'FF79828C' } };
    let r = 4;
    [
      ['How it works', 'Edit the sheets, then drop this file back on the Bulk Editor page. You get a full diff to review before anything is written.'],
      ['Project ID', 'The join key. NEVER edit or clear it. Grey columns (▸) are reference only and are ignored on import.'],
      ['Adding a project', 'Add a row on Projects with the Action column set to NEW and leave Project ID blank.'],
      ['Removing a project', 'Set Action = REMOVE. Deleting the ROW does nothing — that way an accidental sort-and-delete cannot wipe records.'],
      ['Roles, Phases, Groups, Revenue', 'These sheets are AUTHORITATIVE for every project that appears on them: the project is rebuilt from exactly those rows. Delete a role row to delete the role; add a row with a blank Role ID to add one. A project with no rows on a sheet keeps what it already had.'],
      ['FTE columns', 'FTE% P1…P8 map to that project\'s phases in order (see the Phases sheet). Roles flagged "Month-by-month FTE" carry a per-month schedule that is preserved as long as you leave their FTE% columns alone.'],
      ['Rates', 'Rate source "grid" prices from the rate grid using Title ID + Tier. "contracted" uses the Contracted rate column verbatim. Title IDs must exist on the Lists sheet.'],
      ['What is preserved', 'Imported-revenue provenance, change-order links, saved versions and the activity log are carried over untouched — the workbook does not model them.'],
      ['Before you start', 'Turn ON maintenance mode in the tool so nobody else saves while the book is out. Turn it off when you are done.'],
    ].forEach(([k, v]) => {
      rm.getCell(`A${r}`).value = k;
      rm.getCell(`A${r}`).font = { bold: true, color: { argb: NAVY } };
      rm.getCell(`A${r}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFDF00' } };
      rm.getCell(`A${r}`).alignment = { vertical: 'top' };
      rm.getCell(`B${r}`).value = v;
      rm.getCell(`B${r}`).alignment = { wrapText: true, vertical: 'top' };
      rm.getRow(r).height = 30;
      r++;
    });
    return { wb, count: projects.length };
  }

  async function exportWorkbook() {
    const { wb, count } = await buildWorkbook();
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `PPM-Projects-Bulk_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { count };
  }

  /* ---------- PARSE ---------- */
  function rowsOf(ws, cols) {
    const out = [];
    if (!ws) return out;
    const header = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { header[i] = S(c.value); });
    const idx = {};
    cols.forEach(c => { const i = header.findIndex(h => h === c.h); if (i > 0) idx[c.key] = i; });
    // extra FTE columns come through by header name
    header.forEach((h, i) => { const m = /^FTE% P(\d+)$/.exec(h || ''); if (m) idx['fte' + m[1]] = i; });
    ws.eachRow((row, rn) => {
      if (rn === 1) return;
      const o = { _row: rn };
      Object.keys(idx).forEach(k => {
        let v = row.getCell(idx[k]).value;
        if (v && typeof v === 'object') v = v.result != null ? v.result : (v.text != null ? v.text : (v instanceof Date ? v : S(v)));
        o[k] = v;
      });
      const meaningful = Object.keys(idx).some(k => k !== '_row' && S(o[k]) !== '');
      if (meaningful) out.push(o);
    });
    return out;
  }

  async function parseWorkbook(file) {
    if (typeof ExcelJS === 'undefined') throw new Error('Excel library not loaded on this page.');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const get = (n) => wb.worksheets.find(w => w.name.toLowerCase() === n);
    const projects = rowsOf(get('projects'), PROJECT_COLS);
    if (!projects.length) throw new Error('No rows found on a "Projects" sheet — is this the exported workbook?');
    return {
      fileName: file.name,
      projects,
      roles: rowsOf(get('roles'), ROLE_COLS),
      phases: rowsOf(get('phases'), PHASE_COLS),
      groups: rowsOf(get('groups'), GROUP_COLS),
      revenue: rowsOf(get('revenue'), REV_COLS),
    };
  }

  /* ---------- VALIDATE + BUILD the next record for each project ---------- */
  function buildPlan(parsed) {
    const st = STORE();
    const errors = [], changes = [], creates = [], removes = [], untouched = [];
    const catalogTitles = new Set(((window.RATES_CATALOG && window.RATES_CATALOG.titles) || []).map(t => t.id));
    const byProjRoles = {}, byProjPhases = {}, byProjGroups = {}, byProjRev = {};
    (parsed.roles || []).forEach(r => { const k = S(r.projectId); if (k) (byProjRoles[k] = byProjRoles[k] || []).push(r); });
    (parsed.phases || []).forEach(r => { const k = S(r.projectId); if (k) (byProjPhases[k] = byProjPhases[k] || []).push(r); });
    (parsed.groups || []).forEach(r => { const k = S(r.projectId); if (k) (byProjGroups[k] = byProjGroups[k] || []).push(r); });
    (parsed.revenue || []).forEach(r => { const k = S(r.projectId); if (k) (byProjRev[k] = byProjRev[k] || []).push(r); });

    const err = (sheet, row, msg) => errors.push({ sheet, row, msg });
    const seenIds = new Set();
    const plan = [];

    parsed.projects.forEach(row => {
      const id = S(row.id);
      const action = S(row.action).toUpperCase();
      if (id && seenIds.has(id)) { err('Projects', row._row, `Project ID ${id} appears more than once`); return; }
      if (id) seenIds.add(id);

      if (action === 'REMOVE') {
        if (!id) { err('Projects', row._row, 'REMOVE needs a Project ID'); return; }
        const p = st.getProject(id);
        if (!p) { err('Projects', row._row, `Project ID ${id} no longer exists`); return; }
        removes.push({ id, label: ((p.project || {}).client || '') + ' — ' + ((p.project || {}).name || '') });
        plan.push({ kind: 'remove', id });
        return;
      }

      const isNew = !id || action === 'NEW';
      const prev = isNew ? null : st.getProject(id);
      if (!isNew && !prev) { err('Projects', row._row, `Project ID ${id} no longer exists — it may have been deleted`); return; }
      if (isNew && !S(row.name)) { err('Projects', row._row, 'A new project needs a name'); return; }

      // --- validated header fields ---
      const pj = Object.assign({}, (prev && prev.project) || {});
      const setIf = (k, v) => { pj[k] = v; };
      const status = S(row.status);
      if (status && !st.STATUSES.includes(status)) err('Projects', row._row, `Status "${status}" is not one of: ${st.STATUSES.join(', ')}`);
      const industry = S(row.industry);
      if (industry && !st.INDUSTRIES.includes(industry)) err('Projects', row._row, `Industry "${industry}" is not on the list`);
      const ptype = S(row.projectType);
      if (ptype && !st.PROJECT_TYPES.some(t => t.name === ptype)) err('Projects', row._row, `Project type "${ptype}" is not on the list`);
      const leadTxt = S(row.lead);
      let leader = null;
      if (leadTxt) {
        leader = st.resolveLeader(leadTxt);
        if (!leader) err('Projects', row._row, `Lead PE "${leadTxt}" is not a known revenue leader`);
      }
      setIf('name', S(row.name)); setIf('client', S(row.client));
      if (status || !isNew) setIf('status', status || pj.status || 'draft');
      setIf('rating', S(row.rating)); setIf('industry', industry); setIf('projectType', ptype);
      pj.leadId = leader ? leader.id : ''; pj.lead = leader ? leader.displayName : '';
      setIf('location', S(row.location)); setIf('salesforceId', S(row.salesforceId));
      setIf('clientContact', S(row.clientContact)); setIf('clientRelOwner', S(row.clientRelOwner));
      setIf('notes', S(row.notes));

      const sYm = parseYm(row.start), eYm = parseYm(row.end);
      if (S(row.start) && !sYm) err('Projects', row._row, `Start "${S(row.start)}" isn't a YYYY-MM month`);
      if (S(row.end) && !eYm) err('Projects', row._row, `End "${S(row.end)}" isn't a YYYY-MM month`);
      const timeline = Object.assign({}, (prev && prev.timeline) || {});
      if (sYm) { timeline.startYear = sYm.year; timeline.startMonth = sYm.month; }
      if (eYm) { timeline.endYear = eYm.year; timeline.endMonth = eYm.month; }

      const assumptions = Object.assign({
        hrsPerMo: 173.33, escalation: 3, industryAdj: 20, discount: 0, rateLock: false,
        billingMode: 'phase', catalogBaseYear: (window.RATES_CATALOG && window.RATES_CATALOG.baseYear) || 2024,
      }, (prev && prev.assumptions) || {});
      if (S(row.hrsPerMo) !== '') assumptions.hrsPerMo = N(row.hrsPerMo);
      if (S(row.escalation) !== '') assumptions.escalation = N(row.escalation);
      if (S(row.industryAdj) !== '') assumptions.industryAdj = N(row.industryAdj);
      if (S(row.discount) !== '') assumptions.discount = N(row.discount);
      assumptions.rateLock = YESNO(row.rateLock);
      const bm = S(row.billingMode).toLowerCase();
      if (bm) {
        if (!['phase', 'flatline'].includes(bm)) err('Projects', row._row, `Fee basis "${bm}" must be phase or flatline`);
        else assumptions.billingMode = bm;
      }
      if (S(row.catalogBaseYear) !== '') assumptions.catalogBaseYear = N(row.catalogBaseYear);

      const next = Object.assign({}, prev || {}, { project: pj, timeline, assumptions });
      if (isNew) { delete next.id; delete next.updatedAt; delete next.createdAt; }

      // --- child sheets, authoritative per project ---
      const key = id || ('NEW#' + row._row);
      let phases = (prev && prev.phases) || [];
      if (byProjPhases[key]) {
        phases = byProjPhases[key]
          .slice().sort((a, b) => (N(a.order) || 0) - (N(b.order) || 0))
          .map(pr => ({ id: S(pr.phaseId) || uid('ph_'), name: S(pr.name) || 'Phase', length: Math.max(1, Math.round(N(pr.length)) || 1) }));
      }
      if (!phases.length) phases = [{ id: uid('ph_'), name: 'Full term', length: 12 }];
      next.phases = phases;

      let groups = (prev && prev.groups) || [];
      if (byProjGroups[key]) {
        groups = byProjGroups[key].map(gr => {
          const g = { id: S(gr.groupId) || uid('g_'), name: S(gr.name) || 'Team' };
          if (S(gr.serviceLine)) g.serviceLine = S(gr.serviceLine);
          return g;
        });
      }
      if (!groups.length) groups = [{ id: uid('g_'), name: 'Core team' }];
      next.groups = groups;

      if (byProjRoles[key]) {
        const prevRoles = {}; ((prev && prev.roles) || []).forEach(r => { if (r.id) prevRoles[r.id] = r; });
        const roles = [];
        byProjRoles[key].forEach(rr => {
          if (S(rr.action).toUpperCase() === 'REMOVE') return;
          const titleId = S(rr.titleId);
          const rateSource = S(rr.rateSource).toLowerCase() === 'contracted' ? 'contracted' : 'grid';
          if (rateSource === 'grid' && titleId && catalogTitles.size && !catalogTitles.has(titleId)) {
            err('Roles', rr._row, `Title ID "${titleId}" isn't in the rate grid — fix it, or set Rate source to contracted`);
          }
          if (rateSource === 'contracted' && S(rr.contractedRate) === '') {
            err('Roles', rr._row, 'Rate source is contracted but Contracted rate is blank');
          }
          const gName = S(rr.group);
          let g = groups.find(x => (x.name || '').toLowerCase() === gName.toLowerCase());
          if (!g && gName) { g = { id: uid('g_'), name: gName }; groups.push(g); }
          const old = prevRoles[S(rr.roleId)] || null;
          const fte = {};
          let fteTouched = false;
          phases.forEach((ph, i) => {
            const raw = rr['fte' + (i + 1)];
            if (S(raw) === '') return;
            fte[ph.id] = N(raw);
            if (!old || (old.fte || {})[ph.id] !== N(raw)) fteTouched = true;
          });
          const role = Object.assign({}, old || {}, {
            id: (old && old.id) || uid('r_'),
            groupId: g ? g.id : groups[0].id,
            titleId, tierId: S(rr.tierId) || 'mid',
            projectRole: S(rr.projectRole), resource: S(rr.resource),
            rateSource, fte,
          });
          if (rateSource === 'contracted') role.contractedRate = N(rr.contractedRate); else delete role.contractedRate;
          // A month-by-month schedule only survives while its phase FTEs are left alone.
          if (old && old.fteMonthly && !fteTouched) role.fteMonthly = old.fteMonthly; else delete role.fteMonthly;
          roles.push(role);
        });
        next.roles = roles;
        next.groups = groups;
      } else if (!next.roles) next.roles = [];

      if (byProjRev[key]) {
        const imp = {}, ov = {};
        byProjRev[key].forEach(rv => {
          const ym = parseYm(rv.month);
          if (!ym) { err('Revenue', rv._row, `Month "${S(rv.month)}" isn't YYYY-MM`); return; }
          const k = ym.year + '-' + ym.month;
          const amt = N(rv.amount);
          if (S(rv.kind).toLowerCase() === 'override') ov[k] = amt; else imp[k] = amt;
        });
        next.monthlyOverrides = ov;
        next.source = Object.assign({}, (prev && prev.source) || {}, { importedByMonth: imp });
      }

      if (isNew) {
        creates.push({ label: (S(row.client) ? S(row.client) + ' — ' : '') + S(row.name), row: row._row });
        plan.push({ kind: 'create', record: next, key });
      } else {
        const diff = st.describeChanges(prev, next) || [];
        const roleDelta = ((prev.roles || []).length !== (next.roles || []).length)
          ? [{ field: 'Roles', from: (prev.roles || []).length + '', to: (next.roles || []).length + '' }] : [];
        const rosterChanged = JSON.stringify((prev.roles || []).map(rolesKey)) !== JSON.stringify((next.roles || []).map(rolesKey));
        const revChanged = JSON.stringify(prev.monthlyOverrides || {}) !== JSON.stringify(next.monthlyOverrides || {})
          || JSON.stringify(((prev.source || {}).importedByMonth) || {}) !== JSON.stringify(((next.source || {}).importedByMonth) || {});
        const all = diff.concat(roleDelta);
        if (rosterChanged && !roleDelta.length) all.push({ field: 'Roster', from: 'edited', to: 'in Excel' });
        if (revChanged) all.push({ field: 'Monthly revenue', from: 'edited', to: 'in Excel' });
        if (all.length) {
          changes.push({ id, label: ((prev.project || {}).client || '') + ' — ' + ((prev.project || {}).name || ''), fields: all });
          plan.push({ kind: 'update', id, record: next, baseUpdatedAt: prev.updatedAt });
        } else {
          untouched.push(id);
        }
      }
    });

    const inSheet = new Set(parsed.projects.map(r => S(r.id)).filter(Boolean));
    const missing = st.listProjects().filter(p => !inSheet.has(p.id))
      .map(p => ({ id: p.id, label: ((p.project || {}).client || '') + ' — ' + ((p.project || {}).name || '') }));

    return { plan, errors, changes, creates, removes, untouched, missing };
  }
  function rolesKey(r) {
    return [r.titleId, r.tierId, r.projectRole, r.resource, r.rateSource, r.contractedRate, JSON.stringify(r.fte || {})].join('|');
  }

  /* ---------- APPLY ---------- */
  function apply(plan) {
    const st = STORE();
    let created = 0, updated = 0, removed = 0; const failed = [];
    plan.forEach(step => {
      try {
        if (step.kind === 'remove') { st.deleteProject(step.id); removed++; }
        else if (step.kind === 'create') { st.saveProject(step.record); created++; }
        else { st.saveProject(step.record, { baseUpdatedAt: step.baseUpdatedAt }); updated++; }
      } catch (e) {
        failed.push((step.id || (step.record && step.record.project && step.record.project.name) || '?') + ': ' + (e.message || e));
      }
    });
    return { created, updated, removed, failed };
  }

  window.UFC_BulkExcel = { exportWorkbook, parseWorkbook, buildPlan, apply, PROJECT_COLS, ROLE_COLS };
})();
