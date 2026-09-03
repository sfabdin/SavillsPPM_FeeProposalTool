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
  /** 1–7 from a number, a numeric string, or a rating label/short — null if none. */
  function parseRating(v, st) {
    const t = S(v); if (!t) return null;
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= 7) return n;
    const lc = t.toLowerCase();
    const hit = ((st && st.RATINGS) || []).find(r => r && ((r.label || '').toLowerCase() === lc || (r.short || '').toLowerCase() === lc || String(r.n) === t));
    return hit ? hit.n : null;
  }
  const N = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
  /** Strictly numeric, or null. N() coerces junk to 0, which is right for
      "read a number out of a cell" and catastrophically wrong for "are these
      two values equal" — "Tasia Long" and "Renamed Person" are both 0. */
  const NUM = (v) => {
    const t = String(v == null ? '' : v).replace(/[$,\s]/g, '');
    if (t === '' || !/^-?\d*\.?\d+$/.test(t)) return null;
    const n = Number(t);
    return isFinite(n) ? n : null;
  };
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
    { key: 'lossReason',    h: 'Loss reason',       w: 20, list: 'LossReason' },
    { key: 'rating',        h: 'Rating',            w: 18, list: 'Rating' },
    { key: 'industry',      h: 'Industry',          w: 20, list: 'Industry' },
    { key: 'projectType',   h: 'Project type',      w: 34, list: 'ProjectType' },
    { key: 'projectSubtypes', h: 'Type sub-services (; separated)', w: 46 },
    { key: 'lead',          h: 'Lead PE',           w: 22, list: 'Lead' },
    { key: 'clientRelOwner',h: 'Relationship owner',w: 22, list: 'Lead' },
    { key: 'accessGrant',   h: 'Grant access to (emails)', w: 40 },
    { key: 'assumptionsList', h: 'Assumptions / exclusions (; separated)', w: 52 },
    { key: 'location',      h: 'Location',          w: 20 },
    { key: 'salesforceId',  h: 'Salesforce ID',     w: 16, text: true },
    { key: 'clientContact', h: 'Client contact',    w: 22 },
    { key: 'proposalDate',  h: 'Proposal date',     w: 15, text: true },
    { key: 'firstProposalDate', h: 'First proposal date', w: 17, text: true },
    { key: 'signedContractDate', h: 'Signed contract date', w: 18, text: true },
    { key: 'intakeSent',    h: 'Intake sent (Y/N)', w: 14, list: 'YesNo' },
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
  /** Relationship owner is stored as a leader id (like Lead PE) but older
      records hold a raw name — show whichever resolves. */
  function relDisplay(raw) {
    if (!raw) return '';
    const l = STORE().resolveLeader(raw);
    return l ? l.displayName : String(raw);
  }
  /** Multi-value cells are "a; b; c" — semicolons, because commas appear
      inside assumption text and email lists. */
  const splitList = (v) => S(v).split(';').map(x => x.trim()).filter(Boolean);

  function projectRow(p) {
    const pj = p.project || {}, tl = p.timeline || {}, a = p.assumptions || {};
    let fee = 0;
    try { const f = STORE().projectFinancials(p, window.RATES_CATALOG); fee = (f && f.net) || 0; } catch (e) {}
    return {
      id: p.id, action: '',
      name: pj.name || '', client: pj.client || '', status: pj.status || '',
      lossReason: pj.lossReason || '', rating: pj.rating || '',
      industry: pj.industry || '', projectType: pj.projectType || '',
      projectSubtypes: (pj.projectSubtypes || []).join('; '),
      lead: pj.leadId ? (STORE().leaderDisplay(pj.leadId) || pj.lead || '') : (pj.lead || ''),
      clientRelOwner: relDisplay(pj.clientRelOwner),
      accessGrant: pj.accessGrant || '',
      assumptionsList: (pj.assumptionsList || []).join('; '),
      location: pj.location || '', salesforceId: pj.salesforceId || '',
      clientContact: pj.clientContact || '',
      proposalDate: pj.proposalDate || '', firstProposalDate: pj.firstProposalDate || '',
      signedContractDate: pj.signedContractDate || '',
      intakeSent: pj.intakeSent ? 'Y' : 'N',
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
    await window.UFC_Vendor.excel();
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
      ['LossReason', st.LOST_REASONS.slice()],
      ['Assumption', st.ASSUMPTION_LIBRARY.slice()],
      ['Rating', (st.RATINGS || []).map(r => (typeof r === 'string' ? r : (r.label || r.id || '')))],
      ['Industry', st.INDUSTRIES.slice()],
      ['ProjectType', st.PROJECT_TYPES.map(t => t.name)],
      ['Lead', st.REVENUE_LEADERS.map(l => l.displayName + (l.username ? ' <' + l.username + '>' : ''))],
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

    /* Type sub-services live per project type, so a single-column dropdown
       can't express them — this reference sheet is where you copy the exact
       strings from (import validates against it). */
    const subsWs = wb.addWorksheet('Type subs', { views: [{ state: 'frozen', ySplit: 1 }] });
    subsWs.columns = [{ width: 38 }, { width: 52 }];
    ['Project type', 'Sub-service (paste into the Projects sheet)'].forEach((h, i) => {
      const c = subsWs.getRow(1).getCell(i + 1);
      c.value = h; c.font = { bold: true, size: 10, color: { argb: WHITE } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    });
    let sr = 2;
    st.PROJECT_TYPES.forEach(t => t.subs.forEach(sub => {
      subsWs.getCell(sr, 1).value = t.name;
      subsWs.getCell(sr, 2).value = sub;
      sr++;
    }));
    subsWs.autoFilter = { from: 'A1', to: `B${sr - 1}` };

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
    await window.UFC_Vendor.excel();
    if (typeof ExcelJS === 'undefined') throw new Error('Excel library not loaded on this page.');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const get = (n) => wb.worksheets.find(w => w.name.toLowerCase() === n);
    const projects = rowsOf(get('projects'), PROJECT_COLS);
    if (!projects.length) throw new Error('No rows found on a "Projects" sheet — is this the exported workbook?');
    // The Lists + Type subs sheets are EDITABLE: whatever you add there
    // becomes part of the system vocabulary when the workbook is applied.
    const listsWs = get('lists');
    const lists = { Industry: [], ProjectType: [], LossReason: [], Lead: [] };
    if (listsWs) {
      const head = [];
      listsWs.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { head[i] = S(c.value); });
      head.forEach((h, col) => {
        if (!lists[h]) return;
        listsWs.eachRow((row, rn) => { if (rn === 1) return; const v = S(row.getCell(col).value); if (v) lists[h].push(v); });
      });
    }
    const subsWs = get('type subs');
    const typeSubs = [];
    if (subsWs) subsWs.eachRow((row, rn) => {
      if (rn === 1) return;
      const t = S(row.getCell(1).value), sub = S(row.getCell(2).value);
      if (t && sub) typeSubs.push({ type: t, sub });
    });
    return {
      fileName: file.name,
      projects,
      roles: rowsOf(get('roles'), ROLE_COLS),
      phases: rowsOf(get('phases'), PHASE_COLS),
      groups: rowsOf(get('groups'), GROUP_COLS),
      revenue: rowsOf(get('revenue'), REV_COLS),
      lists, typeSubs,
    };
  }

  /** A leader typed onto the Lists sheet arrives as "Michael Glatt" or, better,
      "Michael Glatt <mglatt@savills.us>". The email is what ownership and the
      access wall actually key on, so when it isn't supplied we derive the house
      convention (first initial + surname @savills.us) and say so in the review,
      where a wrong guess is easy to spot and fix. */
  function deriveLeader(text) {
    const m = /^(.*?)[<(]\s*([^\s<>()]+@[^\s<>()]+?)\s*[>)]?\s*$/.exec(S(text));
    const name = S(m ? m[1] : text);
    const email = m ? m[2].toLowerCase() : '';
    if (!name) return null;
    const parts = name.split(/\s+/).filter(Boolean);
    const slug = (parts.length > 1 ? parts[0][0] + parts[parts.length - 1] : parts[0] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const id = email ? email.split('@')[0].toLowerCase().replace(/[^a-z0-9.]/g, '') : slug;
    if (!id) return null;
    return { id, displayName: name, username: email || (slug + '@savills.us'), aliases: [name], guessedEmail: !email };
  }

  /* ---------- VALIDATE + BUILD the next record for each project ---------- */
  function buildPlan(parsed) {
    const st = STORE();
    const errors = [], changes = [], creates = [], removes = [], untouched = [];
    /* A title id is valid if the rate grid knows it OR the catalog maps it as
       a legacy alias — the calculator resolves both, so flagging an alias that
       has been on a role for two years would be a lie. When the grid hasn't
       hydrated (offline), skip the check rather than reject everything. */
    const cat = window.RATES_CATALOG || {};
    const catalogTitles = new Set((cat.titles || []).map(t => t.id));
    const legacyIds = new Set(Object.keys(cat.legacyAlias || {}));
    const titleKnown = (id) => !catalogTitles.size || catalogTitles.has(id) || legacyIds.has(id);

    /* Vocabulary: system lists PLUS anything added on the workbook's Lists /
       Type subs sheets. Validation runs against the effective set, and the
       additions are applied first when the plan runs. */
    const wbLists = (parsed.lists || { Industry: [], ProjectType: [], LossReason: [] });
    const sysIndustries = st.INDUSTRIES, sysReasons = st.LOST_REASONS, sysTypes = st.PROJECT_TYPES;
    const newIndustries = (wbLists.Industry || []).filter(x => !sysIndustries.includes(x));
    const newReasons = (wbLists.LossReason || []).filter(x => !sysReasons.includes(x));
    const wbTypeNames = (wbLists.ProjectType || []);
    const subsByType = {};
    (parsed.typeSubs || []).forEach(({ type, sub }) => { (subsByType[type] = subsByType[type] || []).push(sub); });
    const newTypes = [];
    const seenTypeNames = new Set(wbTypeNames.concat(Object.keys(subsByType)));
    seenTypeNames.forEach(name => {
      const base = sysTypes.find(t => t.name === name);
      const subs = (subsByType[name] || []).filter(x => !base || !base.subs.includes(x));
      if (!base) newTypes.push({ name, subs: subsByType[name] || [] });
      else if (subs.length) newTypes.push({ name, subs });
    });
    const newLeaders = [];
    const offerLeader = (txt) => {
      if (!S(txt)) return;
      if (st.resolveLeader(S(txt).replace(/\s*[<(][^<>()]*[>)]\s*$/, '').trim()) || st.resolveLeader(txt)) return;
      const l = deriveLeader(txt);
      if (l && !newLeaders.some(x => x.id === l.id)) newLeaders.push(l);
    };
    (wbLists.Lead || []).forEach(offerLeader);
    /* A leader can also be born in the Lead PE / relationship-owner column
       itself. Requiring a trip to the Lists sheet first was the whole
       frustration: the workbook plainly said who the person was, and the tool
       made you say it twice before it would believe you.

       The guard is the EMAIL. "Naida Serak <nserak@savills.us>" is an
       unambiguous identity assertion, so it stands up a leader. A bare
       unrecognised name is still an error, because that is far more likely to
       be a typo of someone who already exists than a genuinely new person —
       and a typo that silently minted a duplicate leader would be much worse
       than one that stopped the upload. */
    (parsed.projects || []).forEach(row => {
      [row.lead, row.clientRelOwner].forEach(v => { if (st.splitLeaderText && st.splitLeaderText(v)) offerLeader(v); });
    });
    /* Resolve against the live directory PLUS the leaders this same workbook
       is adding. Matches the bare name, the email, or the "Name <email>" form
       the Lists sheet asks for — a leader added on one sheet has to be usable
       on the others in the very same upload, in whichever of those spellings
       the person happened to type. */
    const resolveEff = (value) => {
      const hit = st.resolveLeader(value);
      if (hit) return hit;
      const tryOne = (raw) => {
        const vk = S(raw).toLowerCase();
        if (!vk) return null;
        return newLeaders.find(l => l.id === vk
          || l.displayName.toLowerCase() === vk
          || String(l.username).toLowerCase() === vk
          || (l.aliases || []).some(a => S(a).toLowerCase() === vk)) || null;
      };
      const direct = tryOne(value);
      if (direct) return direct;
      const parts = st.splitLeaderText ? st.splitLeaderText(value) : null;
      return parts ? (tryOne(parts.email) || tryOne(parts.name)) : null;
    };
    const vocabAdds = { industries: newIndustries, lossReasons: newReasons, projectTypes: newTypes, leaders: newLeaders };
    const vocabCount = newIndustries.length + newReasons.length + newLeaders.length + newTypes.reduce((n, t) => n + 1 + t.subs.length, 0);
    const effIndustries = sysIndustries.concat(newIndustries);
    const effReasons = sysReasons.concat(newReasons);
    const effSubs = (typeName) => {
      const base = sysTypes.find(t => t.name === typeName);
      const add = newTypes.find(t => t.name === typeName);
      return (base ? base.subs : []).concat(add ? add.subs : []);
    };
    const effTypeNames = sysTypes.map(t => t.name).concat(newTypes.filter(t => !sysTypes.some(s2 => s2.name === t.name)).map(t => t.name));
    /* When we do refuse, say what would have been accepted and name the
       closest existing leader — an unrecognised name is nearly always a
       spelling drift from someone already on the list, and "not known" alone
       leaves the person guessing which of the two problems they have. */
    const leaderHint = (txt) => {
      const v = S(txt).toLowerCase();
      const all = st.REVENUE_LEADERS.concat(newLeaders);
      let best = null, bestScore = 0;
      all.forEach(l => {
        const name = S(l.displayName).toLowerCase();
        if (!name || !v) return;
        // crude closeness: shared leading characters over the longer string
        let i = 0; while (i < name.length && i < v.length && name[i] === v[i]) i++;
        const surname = name.split(/\s+/).pop(), vSurname = v.split(/\s+/).pop();
        const score = Math.max(i / Math.max(name.length, v.length), surname === vSurname ? 0.8 : 0);
        if (score > bestScore) { bestScore = score; best = l; }
      });
      const near = (best && bestScore >= 0.5)
        ? ` Did you mean "${best.displayName}"?`
        : '';
      return `${near} To add them as a NEW revenue leader, write them with an email — "Name <someone@savills.us>" — in this cell or on the Lists sheet.`;
    };

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
      /* Validate only what you actually CHANGED. A value that came out of the
         export and went back untouched is pre-existing data — legacy title
         ids, a lead who left, an industry from before the list settled — and
         blocking the whole import on it would make the round trip impossible
         on real data. Untouched cells pass through exactly as they were. */
      const base = prev ? projectRow(prev) : null;
      const edited = (k) => !base || S(row[k]) !== S(base[k]);
      const errIf = (k, cond, msg) => { if (edited(k) && cond) err('Projects', row._row, msg); };

      const status = S(row.status);
      errIf('status', status && !st.STATUSES.includes(status), `Status "${status}" is not one of: ${st.STATUSES.join(', ')}`);
      const industry = S(row.industry);
      errIf('industry', industry && !effIndustries.includes(industry), `Industry "${industry}" is not on the list — add it to the Lists sheet if it's a real new industry`);
      const ptype = S(row.projectType);
      errIf('projectType', ptype && !effTypeNames.includes(ptype), `Project type "${ptype}" is not on the list — add it to the Lists sheet if it's a real new type`);
      const leadTxt = S(row.lead);
      let leader = null;
      if (leadTxt) {
        leader = resolveEff(leadTxt);
        errIf('lead', !leader, `Lead PE "${leadTxt}" is not a known revenue leader.${leaderHint(leadTxt)}`);
      }
      const lossReason = S(row.lossReason);
      errIf('lossReason', lossReason && !effReasons.includes(lossReason), `Loss reason "${lossReason}" is not one of: ${effReasons.join(', ')}`);
      // Sub-services must belong to the chosen project type — that's the whole
      // point of the taxonomy, and a typo here is invisible everywhere else.
      const subs = splitList(row.projectSubtypes);
      if (subs.length && edited('projectSubtypes')) {
        if (!ptype) err('Projects', row._row, 'Sub-services are set but Project type is blank — pick the type first');
        else {
          const valid = effSubs(ptype);
          subs.forEach(s2 => { if (!valid.includes(s2)) err('Projects', row._row, `Sub-service "${s2}" isn't part of "${ptype}" — valid: ${valid.join(' · ')}${valid.length ? '' : '(none defined)'}`); });
        }
      }
      // Access grant: emails only, normalised the same way the access wall reads them.
      const rawAccess = S(row.accessGrant);
      const emails = st.parseAccessEmails(rawAccess);
      if (rawAccess && edited('accessGrant')) {
        const junk = rawAccess.split(/[,;\n]+/).map(x => x.trim()).filter(x => x && !x.includes('@'));
        if (junk.length) err('Projects', row._row, `Grant access needs email addresses — "${junk.join('", "')}" ${junk.length === 1 ? 'is not one' : 'are not'}`);
      }
      const relTxt = S(row.clientRelOwner);
      let relOwner = null;
      if (relTxt) {
        relOwner = resolveEff(relTxt);
        errIf('clientRelOwner', !relOwner, `Relationship owner "${relTxt}" is not a known revenue leader.${leaderHint(relTxt)}`);
      }
      setIf('name', S(row.name)); setIf('client', S(row.client));
      if (status || !isNew) setIf('status', status || pj.status || 'draft');
      setIf('lossReason', lossReason);
      /* Rating must land as the integer 1–7 the store keys on. A cell can hold
         the number, a numeric string, or the dropdown's label ("90% and up");
         a string "2" used to be stored as-is and, failing a strict compare,
         read back as Dead Pursuit — weight zero, project gone from the forecast. */
      const ratingIn = S(row.rating);
      if (ratingIn) {
        const rn = parseRating(ratingIn, st);
        errIf('rating', rn == null, `Rating "${ratingIn}" is not 1–7 or one of the list labels.`);
        if (rn != null) setIf('rating', rn);
      }
      setIf('industry', industry); setIf('projectType', ptype);
      pj.projectSubtypes = subs;
      if (leader) { pj.leadId = leader.id; pj.lead = leader.displayName; }
      else if (!leadTxt) { pj.leadId = ''; pj.lead = ''; }
      else if (edited('lead')) { pj.leadId = ''; pj.lead = leadTxt; }   // unresolved but deliberately typed
      pj.clientRelOwner = relOwner ? relOwner.id : (relTxt ? (prev ? (prev.project || {}).clientRelOwner : relTxt) : '');
      if (edited('accessGrant')) pj.accessGrant = emails.join(', ');
      pj.assumptionsList = splitList(row.assumptionsList);
      setIf('location', S(row.location)); setIf('salesforceId', S(row.salesforceId));
      setIf('clientContact', S(row.clientContact));
      setIf('proposalDate', S(row.proposalDate));
      setIf('firstProposalDate', S(row.firstProposalDate));
      setIf('signedContractDate', S(row.signedContractDate));
      pj.intakeSent = YESNO(row.intakeSent);
      setIf('notes', S(row.notes));

      const sYm = parseYm(row.start), eYm = parseYm(row.end);
      if (S(row.start) && !sYm) err('Projects', row._row, `Start "${S(row.start)}" isn't a YYYY-MM month`);
      if (S(row.end) && !eYm) err('Projects', row._row, `End "${S(row.end)}" isn't a YYYY-MM month`);
      const timeline = Object.assign({}, (prev && prev.timeline) || {});
      if (sYm) { timeline.startYear = sYm.year; timeline.startMonth = sYm.month; }
      if (eYm) { timeline.endYear = eYm.year; timeline.endMonth = eYm.month; }

      const assumptions = Object.assign(
        isNew ? window.UFC_Store.defaultAssumptions({ escalation: 3, industryAdj: 20 }) : {},
        (prev && prev.assumptions) || {});
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
      // …then put back anything that only LOOKED changed (a record with no
      // rateLock key exports as "N" and would otherwise come back as false).
      if (prev) settle(prev.assumptions || {}, assumptions, ['hrsPerMo', 'escalation', 'industryAdj', 'discount', 'rateLock', 'billingMode', 'catalogBaseYear']);

      if (prev) settle(prev.project || {}, pj, PROJ_SETTLE);
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
          const old0 = prevRoles[S(rr.roleId)] || null;
          const titleEdited = !old0 || S(old0.titleId) !== titleId;
          if (rateSource === 'grid' && titleId && titleEdited && !titleKnown(titleId)) {
            err('Roles', rr._row, `Title ID "${titleId}" isn't in the rate grid — fix it, or set Rate source to contracted`);
          }
          if (rateSource === 'contracted' && S(rr.contractedRate) === '' && (!old0 || old0.rateSource !== 'contracted' || old0.contractedRate != null)) {
            err('Roles', rr._row, 'Rate source is contracted but Contracted rate is blank');
          }
          const gName = S(rr.group);
          let g = groups.find(x => (x.name || '').toLowerCase() === gName.toLowerCase());
          if (!g && gName) { g = { id: uid('g_'), name: gName }; groups.push(g); }
          const old = old0;
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
            titleId,
            // Blank tier cell = the role never had one; don't invent 'mid'.
            tierId: S(rr.tierId) || (old ? old.tierId : 'mid'),
            projectRole: S(rr.projectRole), resource: S(rr.resource),
            rateSource, fte,
          });
          if (rateSource === 'contracted') role.contractedRate = N(rr.contractedRate); else delete role.contractedRate;
          // A month-by-month schedule only survives while its phase FTEs are left alone.
          if (old && old.fteMonthly && !fteTouched) role.fteMonthly = old.fteMonthly; else delete role.fteMonthly;
          // Unchanged in substance → keep the original object untouched.
          roles.push(old && sameRole(old, role) ? old : role);
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
        // describeChanges covers the fields the Change Log cares about; these
        // are the rest of the page, so the review shows EVERY edit you made.
        const a0 = prev.project || {}, b0 = next.project || {};
        [
          ['status', 'Status'], ['location', 'Location'], ['clientContact', 'Client contact'],
          ['signedContractDate', 'Signed contract date'], ['rating', 'Rating'],
        ].forEach(([k, label]) => {
          if (S(a0[k]) !== S(b0[k]) && !diff.some(d => d.field === label)) diff.push({ field: label, from: S(a0[k]) || '—', to: S(b0[k]) || '—' });
        });
        const relLbl = (v) => relDisplay(v) || '—';
        if (S(a0.clientRelOwner) !== S(b0.clientRelOwner)) diff.push({ field: 'Relationship owner', from: relLbl(a0.clientRelOwner), to: relLbl(b0.clientRelOwner) });
        const listLbl = (arr) => (arr && arr.length) ? arr.join('; ') : '—';
        if (JSON.stringify(a0.projectSubtypes || []) !== JSON.stringify(b0.projectSubtypes || []))
          diff.push({ field: 'Type sub-services', from: listLbl(a0.projectSubtypes), to: listLbl(b0.projectSubtypes) });
        if (JSON.stringify(a0.assumptionsList || []) !== JSON.stringify(b0.assumptionsList || []))
          diff.push({ field: 'Assumptions', from: listLbl(a0.assumptionsList), to: listLbl(b0.assumptionsList) });
        if (!!a0.intakeSent !== !!b0.intakeSent) diff.push({ field: 'Intake sent', from: a0.intakeSent ? 'Y' : 'N', to: b0.intakeSent ? 'Y' : 'N' });
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

    if (vocabCount) plan.unshift({ kind: 'vocab', adds: vocabAdds });
    return { plan, errors, changes, creates, removes, untouched, missing, vocab: vocabAdds, vocabCount };
  }
  /** Excel round-trips lose types: a numeric rating comes back "1", a blank
      cell becomes '' where the record held undefined. Those are the SAME
      value, and reporting 300 projects as "changed" because of it would bury
      the edits that matter. Where a field is unchanged in substance, put the
      original value back so the diff — and the saved record — stay clean. */
  function settle(prev, next, keys) {
    if (!prev) return;
    keys.forEach(k => {
      const a = prev[k], b = next[k];
      if (a === b) return;
      const bothBlank = (a == null || a === '' || a === false) && (b == null || b === '' || b === false);
      const sameText = S(a) === S(b);
      const na = NUM(a), nb = NUM(b);
      const sameNum = na !== null && nb !== null && na === nb;
      if (bothBlank || sameText || sameNum) next[k] = a;
    });
  }
  const PROJ_SETTLE = ['name', 'client', 'status', 'lossReason', 'rating', 'industry', 'projectType', 'lead', 'leadId',
    'clientRelOwner', 'accessGrant', 'location', 'salesforceId', 'clientContact', 'proposalDate', 'firstProposalDate',
    'signedContractDate', 'notes', 'intakeSent'];
  const ROLE_SETTLE = ['titleId', 'tierId', 'projectRole', 'resource', 'rateSource', 'contractedRate', 'groupId'];
  /** Two roles are the same in substance if every modelled field matches
      loosely — then we keep the ORIGINAL object, preserving its id, its
      month-by-month schedule and any field the workbook doesn't carry. */
  function sameRole(a, b) {
    if (!a || !b) return false;
    // "grid" IS the absence of a contracted rate — an older role simply has no
    // rateSource key, and the export writes "grid" for it either way.
    const norm = (k, v) => k === 'rateSource' ? (v === 'contracted' ? 'contracted' : 'grid') : S(v);
    if (ROLE_SETTLE.some(k => {
      if (norm(k, a[k]) === norm(k, b[k])) return false;
      const na = NUM(a[k]), nb = NUM(b[k]);
      return !(na !== null && nb !== null && na === nb);   // 200 vs "200" is the same rate
    })) return false;
    const fa = a.fte || {}, fb = b.fte || {};
    const keys = new Set(Object.keys(fa).concat(Object.keys(fb)));
    for (const k of keys) if (N(fa[k]) !== N(fb[k])) return false;   // FTE cells are numbers or blank
    return true;
  }

  function rolesKey(r) {
    return [r.titleId, r.tierId, r.projectRole, r.resource, r.rateSource, r.contractedRate, JSON.stringify(r.fte || {})].join('|');
  }

  /* ---------- APPLY ---------- */
  function apply(plan) {
    const st = STORE();
    let created = 0, updated = 0, removed = 0, vocab = 0; const failed = [];
    plan.forEach(step => {
      try {
        if (step.kind === 'vocab') { vocab += st.addVocab(step.adds); }
        else if (step.kind === 'remove') { st.deleteProject(step.id); removed++; }
        else if (step.kind === 'create') { st.saveProject(step.record); created++; }
        else { st.saveProject(step.record, { baseUpdatedAt: step.baseUpdatedAt }); updated++; }
      } catch (e) {
        failed.push((step.id || (step.record && step.record.project && step.record.project.name) || '?') + ': ' + (e.message || e));
      }
    });
    return { created, updated, removed, vocab, failed };
  }

  window.UFC_BulkExcel = { exportWorkbook, parseWorkbook, buildPlan, apply, PROJECT_COLS, ROLE_COLS };
})();
