/* ============================================================
   STAFFING & BANDWIDTH · Excel exports
   ------------------------------------------------------------
   Two downloads, both values-only (no live formulas) point-in-time
   records — for version control / circulation, not for editing back
   into the app.

   1) UFC_buildAndDownloadStaffingSnapshot() — the COMPREHENSIVE book,
      one sheet per view on the page so nothing on screen is trapped
      there:
        Cover · Compare (Plan/Contract/Actual) · By Project · By Person
        · Allocations · Contract vs Staffing (the bridge) · Leaves
        · Insights · Clockify Reporting · Mapping · Actuals (raw)
   2) UFC_buildAndDownloadTimeEntryExport() — the Clockify Reporting tab on its
      own, reproducing the on-screen colour coding cell for cell.

   Both share the palette + helpers below.
   ============================================================ */
(function () {
  'use strict';

  const NAVY = 'FF25273A', YELLOW = 'FFFFDF00', CREAM = 'FFEEE8E3', STEEL = 'FF79828C', WHITE = 'FFFFFFFF';
  const TEAL = 'FF0E7C7B';
  /* Time-entry cell colours — the EXACT on-screen scale (styles.css .cell
     u1/u2/u3/u5 + the leave marker), so a printed sheet reads like the tab. */
  const C_OVER = 'FFCFE6E4';   // ≥100% logged
  const C_OK   = 'FFEEF4F4';   // 80–99% on target
  const C_LOW  = 'FFFCE7C2';   // 1–79% behind
  const C_ZERO = 'FFE4453A';   // 0% nothing logged
  const C_LEAVE = 'FFEFE6F7';  // on leave — not expected
  const C_NA   = 'FFF7F7F5';   // not allocated / not here yet

  const colLetter = (n) => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
  const round1 = (n) => Math.round((n || 0) * 10) / 10;

  const styleHeader = (cell, opts = {}) => {
    cell.font = { name: 'Calibri', bold: true, color: { argb: opts.fg || WHITE }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg || NAVY } };
    cell.alignment = { vertical: 'middle', horizontal: opts.align || 'left', wrapText: true };
  };
  const styleSectionTitle = (cell, bg) => {
    cell.font = { name: 'Calibri', bold: true, color: { argb: NAVY }, size: 12 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg || YELLOW } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  };
  /** Standard header row from an array of {h, w, align} column specs. */
  function headerRow(ws, cols, opts) {
    ws.columns = cols.map(c => ({ width: c.w || 16 }));
    const r = ws.getRow(1);
    cols.forEach((c, i) => { const cell = r.getCell(i + 1); cell.value = c.h; styleHeader(cell, { align: c.align }); });
    r.height = 20;
    ws.views = [{ state: 'frozen', ySplit: 1, xSplit: (opts && opts.xSplit) || 0 }];
    return r;
  }
  function titleBlock(ws, title, sub, span) {
    ws.mergeCells(`A1:${colLetter(span || 6)}1`);
    const t = ws.getCell('A1');
    t.value = title;
    t.font = { name: 'Calibri', bold: true, size: 15, color: { argb: NAVY } };
    ws.getRow(1).height = 22;
    ws.mergeCells(`A2:${colLetter(span || 6)}2`);
    const s = ws.getCell('A2');
    s.value = sub;
    s.font = { name: 'Calibri', italic: true, size: 10, color: { argb: STEEL } };
    return 4;   // next free row
  }
  async function download(wb, filename) {
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  /** Time-entry cell → {fill, text, note} using the on-screen rules. */
  function complianceCell(c) {
    if (c === 'leave') return { fill: C_LEAVE, value: 'leave', font: { argb: 'FF6B3FA0' }, note: 'On leave of absence — no hours expected' };
    if (!c) return { fill: C_NA, value: null, font: { argb: STEEL }, note: 'Not allocated / not here yet' };
    const p = Math.round(c.pct * 100);
    const fill = p >= 100 ? C_OVER : p >= 80 ? C_OK : p > 0 ? C_LOW : C_ZERO;
    return {
      fill, value: c.pct,
      font: { argb: p === 0 ? WHITE : NAVY, bold: p === 0 },
      note: `${round1(c.h)} h logged of a ${round1(c.capM)} h bar`,
    };
  }

window.UFC_buildAndDownloadStaffingSnapshot = async function () {
  const S = window.UFC_Staff;
  const STORE = window.UFC_Store;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Savills PPM';
  wb.created = new Date();
  wb.title = 'Staffing & Bandwidth Snapshot';

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const curUser = STORE.getCurrentUser();
  const who = (curUser && curUser.username) || 'unknown';

  /* ---------- full month range: union of allocation window + actuals coverage ---------- */
  const aw = S.allocationWindow();
  const am = S.actualsMeta().months || [];
  let lo = aw.lo, hi = aw.hi;
  am.forEach(ym => { if (ym < lo) lo = ym; if (ym > hi) hi = ym; });
  const months = [];
  { let c = lo, guard = 0; while (c <= hi && guard < 240) { months.push(c); c = S.ymAdd(c, 1); guard++; } }

  /* ============================================================
     SHEET · Cover — what's in the book and what the numbers mean
     ============================================================ */
  {
    const cv = wb.addWorksheet('Cover', { views: [{ showGridLines: false }] });
    cv.columns = [{ width: 30 }, { width: 78 }];
    let r = titleBlock(cv, 'Staffing & Bandwidth — full export', `Exported ${dateStr} by ${who} · window ${months.length ? S.ymLabel(months[0]) + ' – ' + S.ymLabel(months[months.length - 1]) : 'no data'} · static values, not live formulas`, 2);
    const idx = [
      ['Compare', 'Plan / Contract / Actual by project and month — the Compare tab, incl. a totals block that ties to the on-screen chart.'],
      ['By Project', 'One row per project: headcount, peak FTE, and monthly FTE load.'],
      ['By Person', 'One row per person: peak/average load, active months, and monthly load %.'],
      ['Allocations', 'Every allocation record — person, project, window, %, note.'],
      ['Contract vs Staffing', 'The bridge: contract demand the matrix has not staffed, by segment.'],
      ['Leaves', 'Leaves of absence — who is out, when, and when they return.'],
      ['Insights', 'Every Insights card as a table: overextended, coverage gaps, headroom, pursuit exposure, coming available, internal time.'],
      ['Clockify Reporting', 'Compliance grid with the same colour coding as the tab (also available as its own download).'],
      ['Mapping', 'Roster ↔ Clockify users, employment type, titles, and project ↔ fee-tool links.'],
      ['Actuals', 'Raw logged hours — person × project × month.'],
    ];
    const hr = cv.getRow(r);
    hr.getCell(1).value = 'Sheet'; styleHeader(hr.getCell(1));
    hr.getCell(2).value = 'What it holds'; styleHeader(hr.getCell(2));
    hr.height = 20; r++;
    idx.forEach(([a, b]) => {
      cv.getCell(`A${r}`).value = a;
      cv.getCell(`A${r}`).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
      cv.getCell(`B${r}`).value = b;
      cv.getCell(`B${r}`).alignment = { wrapText: true, vertical: 'top' };
      r++;
    });
    r++;
    cv.mergeCells(`A${r}:B${r}`);
    styleSectionTitle(cv.getCell(`A${r}`));
    cv.getCell(`A${r}`).value = '  HOW THE NUMBERS ARE MEASURED';
    r++;
    [
      ['Capacity bar', `${S.monthHours()} h/month at 100% capacity. Part-timers are measured against their own % (set on Mapping), never the full-time bar.`],
      ['Internal staff', 'Marked non-billable on Mapping: internal time is expected, so burn/idle flags skip them.'],
      ['New joiners', "Months before someone's first-ever logged hour are not expected of them and are excluded from their score."],
      ['Leaves', 'Months on a leave of absence are not expected and are excluded from compliance.'],
      ['Pursuits', 'Unsigned work is included in load figures here; the page has a toggle for it.'],
    ].forEach(([k, v]) => {
      cv.getCell(`A${r}`).value = k;
      cv.getCell(`A${r}`).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
      cv.getCell(`B${r}`).value = v;
      cv.getCell(`B${r}`).alignment = { wrapText: true, vertical: 'top' };
      r++;
    });
  }

  /* ============================================================
     SHEET 1 · Allocations (raw)
     ============================================================ */
  const s1 = wb.addWorksheet('Allocations', { views: [{ state: 'frozen', ySplit: 1 }] });
  s1.columns = [
    { header: 'Person', key: 'person', width: 22 },
    { header: 'Title', key: 'title', width: 22 },
    { header: 'Project', key: 'project', width: 34 },
    { header: 'Client', key: 'client', width: 22 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Type', key: 'type', width: 14 },
    { header: 'Start', key: 'start', width: 10 },
    { header: 'End', key: 'end', width: 10 },
    { header: 'Allocation %', key: 'pct', width: 13 },
    { header: 'Note', key: 'note', width: 34 },
  ];
  s1.getRow(1).eachCell(c => styleHeader(c));
  s1.getRow(1).height = 20;
  const allocs = S.listAllocations().slice().sort((a, b) =>
    (S.getPerson(a.personId) || {}).name > (S.getPerson(b.personId) || {}).name ? 1 : -1);
  allocs.forEach(a => {
    const p = S.getPerson(a.personId);
    s1.addRow({
      person: p ? p.name : a.personId,
      title: p ? (p.title || '') : '',
      project: a.project || '',
      client: a.client || '',
      status: a.status || '',
      type: a.type || '',
      start: a.start || '',
      end: a.end || '',
      pct: a.pct || 0,
      note: a.note || '',
    });
  });
  s1.getColumn('pct').numFmt = '0"%"';
  if (allocs.length) s1.autoFilter = { from: 'A1', to: `J${allocs.length + 1}` };

  /* ============================================================
     SHEET 2 · Actuals (raw)
     ============================================================ */
  const s2 = wb.addWorksheet('Actuals', { views: [{ state: 'frozen', ySplit: 1 }] });
  s2.columns = [
    { header: 'Person', key: 'person', width: 22 },
    { header: 'Project', key: 'project', width: 34 },
    { header: 'Client', key: 'client', width: 22 },
    { header: 'Month', key: 'month', width: 12 },
    { header: 'Actual Hours', key: 'hours', width: 14 },
  ];
  s2.getRow(1).eachCell(c => styleHeader(c));
  s2.getRow(1).height = 20;
  const varAll = S.varianceMatrix(months, {});
  let actualRowCount = 0;
  varAll.forEach(r => {
    months.forEach(ym => {
      const a = r.byMonth[ym] ? r.byMonth[ym].a : 0;
      if (a > 0) {
        s2.addRow({ person: r.person.name, project: r.project, client: r.client || '', month: ym, hours: Math.round(a * 100) / 100 });
        actualRowCount++;
      }
    });
  });
  s2.getColumn('hours').numFmt = '#,##0.00';
  if (actualRowCount) s2.autoFilter = { from: 'A1', to: `E${actualRowCount + 1}` };
  else s2.addRow({ person: '(no actuals in range)', project: '', client: '', month: '', hours: '' });

  /* ============================================================
     SHEET 3 · Project Summary — mirrors the Compare tab: quick
     totals + Plan/Contract/Actual monthly detail, each block with
     its own grand-total row.
     ============================================================ */
  const totColIdx = 3 + months.length;   // A=project, B=client, months…, then Total
  const s3 = wb.addWorksheet('Compare', { views: [{ showGridLines: false, state: 'frozen', xSplit: 2, ySplit: 0 }] });
  s3.columns = [{ width: 32 }, { width: 20 }, ...months.map(() => ({ width: 10 })), { width: 12 }];

  let row = 1;
  s3.mergeCells(`A${row}:D${row}`);
  s3.getCell(`A${row}`).value = 'Staffing & Bandwidth · Plan / Contract / Actual snapshot';
  s3.getCell(`A${row}`).font = { name: 'Calibri', bold: true, size: 16, color: { argb: NAVY } };
  s3.getRow(row).height = 24; row++;
  s3.mergeCells(`A${row}:D${row}`);
  s3.getCell(`A${row}`).value = `Exported ${dateStr} by ${who} · ${months.length ? S.ymLabel(months[0]) + ' – ' + S.ymLabel(months[months.length - 1]) : 'no data'} · hours, static values (not live formulas)`;
  s3.getCell(`A${row}`).font = { name: 'Calibri', italic: true, size: 10, color: { argb: STEEL } };
  row += 2;

  // Same project grouping the Compare tab uses — Macro/Time Off projects
  // rolled into one combined row so this reconciles with the on-screen chart.
  const rows = S.varianceMatrix(months, {});
  const byProj = {};
  rows.forEach(r => { (byProj[r.project] = byProj[r.project] || []).push(r); });
  const macroKeys = Object.keys(byProj).filter(k => S.isTimeOffProject(k) || S.isMacroProject(k));
  if (macroKeys.length) {
    const combined = [];
    macroKeys.forEach(k => { combined.push(...byProj[k]); delete byProj[k]; });
    byProj['Macro / Time Off'] = combined;
  }
  const projNames = Object.keys(byProj).sort((a, b) => a.localeCompare(b));
  const contractByProj = {};
  const perProjTotals = {};
  projNames.forEach(pn => {
    const list = byProj[pn];
    const client = (list[0] || {}).client || '';
    perProjTotals[pn] = { client };
    const cp = S.contractPlan(pn, months, client);
    if (cp) contractByProj[pn] = cp;
  });

  /* ---- quick summary block ---- */
  s3.mergeCells(`A${row}:G${row}`);
  styleSectionTitle(s3.getCell(`A${row}`));
  s3.getCell(`A${row}`).value = '  PROJECT SUMMARY (totals across full range)';
  s3.getRow(row).height = 22; row++;
  const sumHdr = row;
  ['Project', 'Client', 'Plan (hrs)', 'Contract (hrs)', 'Actual (hrs)', 'Variance (Act − Plan)', '% of plan'].forEach((h, i) => {
    const c = s3.getCell(`${colLetter(i + 1)}${sumHdr}`);
    c.value = h; styleHeader(c, { align: i >= 2 ? 'right' : 'left' });
  });
  s3.getRow(sumHdr).height = 22; row++;

  let gPlan = 0, gCon = 0, gAct = 0;
  projNames.forEach(pn => {
    const list = byProj[pn];
    const plan = list.reduce((s, r) => s + r.expected, 0);
    const act = list.reduce((s, r) => s + r.actual, 0);
    const con = contractByProj[pn] ? contractByProj[pn].total : 0;
    gPlan += plan; gAct += act; gCon += con;
    const r = row;
    s3.getCell(`A${r}`).value = pn;
    s3.getCell(`B${r}`).value = perProjTotals[pn].client;
    s3.getCell(`C${r}`).value = round1(plan);
    s3.getCell(`D${r}`).value = round1(con);
    s3.getCell(`E${r}`).value = round1(act);
    s3.getCell(`F${r}`).value = round1(act - plan);
    s3.getCell(`G${r}`).value = plan ? Math.round(act / plan * 1000) / 10 : null;
    ['C', 'D', 'E', 'F'].forEach(col => { s3.getCell(`${col}${r}`).numFmt = '#,##0.0'; s3.getCell(`${col}${r}`).alignment = { horizontal: 'right' }; });
    s3.getCell(`G${r}`).numFmt = '0.0"%"';
    s3.getCell(`G${r}`).alignment = { horizontal: 'right' };
    row++;
  });
  const gtRow = row;
  s3.getCell(`A${gtRow}`).value = 'GRAND TOTAL';
  s3.getCell(`B${gtRow}`).value = `${projNames.length} projects`;
  s3.getCell(`C${gtRow}`).value = round1(gPlan);
  s3.getCell(`D${gtRow}`).value = round1(gCon);
  s3.getCell(`E${gtRow}`).value = round1(gAct);
  s3.getCell(`F${gtRow}`).value = round1(gAct - gPlan);
  s3.getCell(`G${gtRow}`).value = gPlan ? Math.round(gAct / gPlan * 1000) / 10 : null;
  ['A', 'B', 'C', 'D', 'E', 'F', 'G'].forEach(col => {
    const c = s3.getCell(`${col}${gtRow}`);
    c.font = { name: 'Calibri', bold: true, color: { argb: WHITE } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    if (['C', 'D', 'E', 'F'].includes(col)) { c.numFmt = '#,##0.0'; c.alignment = { horizontal: 'right' }; }
    if (col === 'G') { c.numFmt = '0.0"%"'; c.alignment = { horizontal: 'right' }; }
  });
  s3.getRow(gtRow).height = 22;
  row = gtRow + 3;

  /* ---- monthly detail sections: Plan / Contract / Actual ---- */
  const totColL = colLetter(totColIdx);
  const monthBlock = (title, sub, valueFor) => {
    s3.mergeCells(`A${row}:${totColL}${row}`);
    const banner = s3.getCell(`A${row}`);
    banner.value = { richText: [
      { text: title, font: { name: 'Calibri', bold: true, size: 11, color: { argb: WHITE } } },
      ...(sub ? [{ text: '   ' + sub, font: { name: 'Calibri', size: 9, italic: true, color: { argb: 'FFE9D9CF' } } }] : []),
    ] };
    banner.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    banner.alignment = { vertical: 'middle' };
    s3.getRow(row).height = 20; row++;

    const hdrRow = row;
    s3.getCell(`A${hdrRow}`).value = 'Project'; styleHeader(s3.getCell(`A${hdrRow}`));
    s3.getCell(`B${hdrRow}`).value = 'Client'; styleHeader(s3.getCell(`B${hdrRow}`));
    months.forEach((ym, i) => { const c = s3.getCell(`${colLetter(3 + i)}${hdrRow}`); c.value = S.ymLabel(ym); styleHeader(c, { align: 'right' }); });
    s3.getCell(`${totColL}${hdrRow}`).value = 'Total'; styleHeader(s3.getCell(`${totColL}${hdrRow}`), { align: 'right' });
    s3.getRow(hdrRow).height = 20; row++;

    const monthTotals = months.map(() => 0);
    let grand = 0;
    projNames.forEach(pn => {
      const r = row;
      s3.getCell(`A${r}`).value = pn;
      s3.getCell(`B${r}`).value = perProjTotals[pn].client;
      let rowTot = 0;
      months.forEach((ym, i) => {
        const v = round1(valueFor(pn, ym));
        const c = s3.getCell(`${colLetter(3 + i)}${r}`);
        c.value = v || null; c.numFmt = '#,##0.0'; c.alignment = { horizontal: 'right' };
        if (v) c.font = { name: 'Calibri', color: { argb: NAVY } };
        rowTot += v; monthTotals[i] += v;
      });
      const tc = s3.getCell(`${totColL}${r}`);
      tc.value = round1(rowTot); tc.numFmt = '#,##0.0'; tc.font = { name: 'Calibri', bold: true, color: { argb: NAVY } }; tc.alignment = { horizontal: 'right' };
      tc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };
      grand += rowTot;
      row++;
    });

    const gr = row;
    s3.getCell(`A${gr}`).value = 'Grand total';
    s3.getCell(`A${gr}`).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
    s3.getCell(`A${gr}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
    s3.getCell(`B${gr}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
    months.forEach((ym, i) => {
      const c = s3.getCell(`${colLetter(3 + i)}${gr}`);
      c.value = round1(monthTotals[i]); c.numFmt = '#,##0.0'; c.font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } }; c.alignment = { horizontal: 'right' };
    });
    const gc = s3.getCell(`${totColL}${gr}`);
    gc.value = round1(grand); gc.numFmt = '#,##0.0'; gc.font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
    gc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } }; gc.alignment = { horizontal: 'right' };
    s3.getRow(gr).height = 20;
    row = gr + 3;
  };

  monthBlock('① PLAN — hrs (staffing matrix)', 'planned allocation % × capacity', (pn, ym) =>
    byProj[pn].reduce((s, x) => s + ((x.byMonth[ym] || {}).e || 0), 0));
  monthBlock('② CONTRACT — hrs (fee tool)', 'staffed titles from the linked fee-tool project(s)', (pn, ym) => {
    const cp = contractByProj[pn]; return cp ? (cp.byMonth[ym] || 0) : 0;
  });
  monthBlock('③ ACTUAL — hrs (Clockify)', 'logged hours, incl. macro / time off rolled into its own row', (pn, ym) =>
    byProj[pn].reduce((s, x) => s + ((x.byMonth[ym] || {}).a || 0), 0));

  /* ============================================================
     SHEET · By Project — the By Project tab
     ============================================================ */
  {
    const ws = wb.addWorksheet('By Project', { views: [{ state: 'frozen', ySplit: 1, xSplit: 2 }] });
    headerRow(ws, [
      { h: 'Project', w: 34 }, { h: 'Client', w: 22 }, { h: 'People', w: 9, align: 'right' },
      { h: 'Peak FTE', w: 10, align: 'right' }, { h: 'Fee link', w: 30 },
      ...months.map(m => ({ h: S.ymLabel(m), w: 9, align: 'right' })),
    ], { xSplit: 2 });
    const roll = S.projectRollup(months, { includePursuit: true });
    let r = 2;
    roll.forEach(p => {
      ws.getCell(`A${r}`).value = p.project;
      ws.getCell(`B${r}`).value = p.client || '';
      ws.getCell(`C${r}`).value = p.headcount;
      ws.getCell(`D${r}`).value = round1(p.peakFte);
      ws.getCell(`E${r}`).value = p.feeProject ? (p.feeProject.name || '') : '';
      months.forEach((ym, i) => {
        const c = ws.getCell(`${colLetter(6 + i)}${r}`);
        const v = round1(p.byMonth[ym] || 0);
        c.value = v || null; c.numFmt = '#,##0.0'; c.alignment = { horizontal: 'right' };
      });
      ['C', 'D'].forEach(col => ws.getCell(`${col}${r}`).alignment = { horizontal: 'right' });
      r++;
    });
    if (roll.length) ws.autoFilter = { from: 'A1', to: `E${roll.length + 1}` };
    else ws.getCell('A2').value = '(no projects in this window)';
  }

  /* ============================================================
     SHEET · By Person — the By Person tab (load % per month)
     ============================================================ */
  {
    const ws = wb.addWorksheet('By Person', { views: [{ state: 'frozen', ySplit: 1, xSplit: 2 }] });
    headerRow(ws, [
      { h: 'Person', w: 24 }, { h: 'Title', w: 24 }, { h: 'Employment', w: 14 },
      { h: 'Capacity %', w: 11, align: 'right' }, { h: 'Peak load %', w: 11, align: 'right' },
      { h: 'Avg load %', w: 11, align: 'right' }, { h: 'Active months', w: 12, align: 'right' },
      { h: 'Flags', w: 22 },
      ...months.map(m => ({ h: S.ymLabel(m), w: 9, align: 'right' })),
    ], { xSplit: 2 });
    const grid = S.bandwidthGrid(months, { includePursuit: true }).filter(x => x.activeMonths > 0)
      .sort((a, b) => a.person.name.localeCompare(b.person.name));
    const leaveBy = {}; S.leaveStatus().forEach(l => { if (l.status !== 'past') leaveBy[l.person.id] = l; });
    let r = 2;
    grid.forEach(x => {
      const p = x.person;
      const emp = S.personEmploymentType(p);
      const flags = [
        p.isNewHire ? 'New hire' : '', p.isPool ? 'Pool' : '',
        leaveBy[p.id] ? (leaveBy[p.id].status === 'out' ? 'On leave to ' + S.ymLabel(leaveBy[p.id].end) : 'Leave from ' + S.ymLabel(leaveBy[p.id].start)) : '',
      ].filter(Boolean).join(' · ');
      ws.getCell(`A${r}`).value = p.name;
      ws.getCell(`B${r}`).value = p.title || '';
      ws.getCell(`C${r}`).value = emp === 'internal' ? 'Internal' : emp === 'part' ? 'Part time' : 'Full time';
      ws.getCell(`D${r}`).value = p.capacityPct != null ? p.capacityPct : 100;
      ws.getCell(`E${r}`).value = Math.round(x.peak);
      ws.getCell(`F${r}`).value = Math.round(x.avg);
      ws.getCell(`G${r}`).value = x.activeMonths;
      ws.getCell(`H${r}`).value = flags;
      if (x.peak > 100) ws.getCell(`E${r}`).font = { name: 'Calibri', bold: true, color: { argb: 'FFB3413B' } };
      months.forEach((ym, i) => {
        const c = ws.getCell(`${colLetter(9 + i)}${r}`);
        const v = Math.round(x.byMonth[ym] || 0);
        c.value = v || null; c.alignment = { horizontal: 'right' };
        if (v > 100) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE7C2' } };
        else if (v >= 86) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_OVER } };
        else if (v > 0) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_OK } };
      });
      ['D', 'E', 'F', 'G'].forEach(col => ws.getCell(`${col}${r}`).alignment = { horizontal: 'right' });
      r++;
    });
    if (grid.length) ws.autoFilter = { from: 'A1', to: `H${grid.length + 1}` };
    else ws.getCell('A2').value = '(nobody allocated in this window)';
  }

  /* ============================================================
     SHEET · Contract vs Staffing — the Allocations-tab bridge
     ============================================================ */
  {
    const ws = wb.addWorksheet('Contract vs Staffing', { views: [{ state: 'frozen', ySplit: 1 }] });
    headerRow(ws, [
      { h: 'Project', w: 34 }, { h: 'Client', w: 20 }, { h: 'Contract resource', w: 24 },
      { h: 'Role', w: 24 }, { h: 'Open role?', w: 11 }, { h: 'On roster?', w: 12 },
      { h: 'Top-up?', w: 10 }, { h: 'Window', w: 20 },
      { h: 'Contract %', w: 11, align: 'right' }, { h: 'Already staffed %', w: 15, align: 'right' },
      { h: 'Gap %', w: 9, align: 'right' }, { h: 'Total gap (FTE-mo)', w: 16, align: 'right' },
      { h: 'Flag', w: 30 },
    ]);
    let gaps = [];
    try { gaps = S.contractStaffingGaps() || []; } catch (e) { gaps = []; }
    let r = 2;
    gaps.forEach(g => {
      (g.segments || []).forEach((sg, i) => {
        ws.getCell(`A${r}`).value = g.project;
        ws.getCell(`B${r}`).value = g.client || '';
        ws.getCell(`C${r}`).value = g.open ? '(open role — needs a name)' : (g.resource || '');
        ws.getCell(`D${r}`).value = g.roleTitle || '';
        ws.getCell(`E${r}`).value = g.open ? 'Yes' : 'No';
        ws.getCell(`F${r}`).value = g.open ? '—' : (g.isNew ? 'Not on roster' : 'Yes');
        ws.getCell(`G${r}`).value = g.topUp ? 'Top-up' : 'New';
        ws.getCell(`H${r}`).value = S.ymLabel(sg.start) + (sg.start !== sg.end ? ' – ' + S.ymLabel(sg.end) : '');
        ws.getCell(`I${r}`).value = sg.want;
        ws.getCell(`J${r}`).value = sg.have;
        ws.getCell(`K${r}`).value = sg.need;
        ws.getCell(`L${r}`).value = i === 0 ? g.totalNeedFteMo : null;
        ws.getCell(`M${r}`).value = g.possibleDupFee ? 'Possible duplicate fee record: ' + g.possibleDupFee : '';
        ['I', 'J', 'K', 'L'].forEach(col => ws.getCell(`${col}${r}`).alignment = { horizontal: 'right' });
        ws.getCell(`K${r}`).font = { name: 'Calibri', bold: true, color: { argb: 'FF8A6D00' } };
        r++;
      });
    });
    if (r === 2) ws.getCell('A2').value = 'Every contract role is staffed in the matrix — nothing outstanding.';
    else ws.autoFilter = { from: 'A1', to: `M${r - 1}` };
  }

  /* ============================================================
     SHEET · Leaves of absence
     ============================================================ */
  {
    const ws = wb.addWorksheet('Leaves', { views: [{ state: 'frozen', ySplit: 1 }] });
    headerRow(ws, [
      { h: 'Person', w: 24 }, { h: 'Title', w: 24 }, { h: 'Status', w: 12 },
      { h: 'Leave starts', w: 13 }, { h: 'Leave ends', w: 13 }, { h: 'Back in', w: 13 },
      { h: 'Months to return', w: 15, align: 'right' }, { h: 'Action', w: 34 }, { h: 'Note', w: 30 },
    ]);
    const lv = S.leaveStatus();
    let r = 2;
    lv.forEach(l => {
      ws.getCell(`A${r}`).value = l.person.name;
      ws.getCell(`B${r}`).value = l.person.title || '';
      ws.getCell(`C${r}`).value = l.status === 'out' ? 'Out now' : l.status === 'upcoming' ? 'Upcoming' : 'Returned';
      ws.getCell(`D${r}`).value = S.ymLabel(l.start);
      ws.getCell(`E${r}`).value = S.ymLabel(l.end);
      ws.getCell(`F${r}`).value = l.status === 'past' ? '—' : S.ymLabel(S.ymAdd(l.end, 1));
      ws.getCell(`G${r}`).value = l.status === 'out' ? l.monthsToReturn : null;
      ws.getCell(`G${r}`).alignment = { horizontal: 'right' };
      ws.getCell(`H${r}`).value = l.returningSoon ? 'Returning soon — plan their staffing'
        : l.startingSoon ? 'Starts soon — reassign their book' : '';
      ws.getCell(`I${r}`).value = (l.alloc && l.alloc.note) || '';
      if (l.returningSoon || l.startingSoon) {
        ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].forEach(col => {
          ws.getCell(`${col}${r}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: l.returningSoon ? 'FFFDF3D7' : C_LEAVE } };
        });
      }
      r++;
    });
    if (!lv.length) ws.getCell('A2').value = 'Nobody is on or headed into a leave.';
  }

  /* ============================================================
     SHEET · Insights — every card as a table
     ============================================================ */
  {
    const ws = wb.addWorksheet('Insights', { views: [{ showGridLines: false }] });
    ws.columns = [{ width: 30 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 30 }];
    let r = titleBlock(ws, 'Insights', `Exported ${dateStr} · same cards as the Insights tab, ${months.length ? S.ymLabel(months[0]) + ' – ' + S.ymLabel(months[months.length - 1]) : ''}`, 5);
    const section = (title, cols, rowsOut, empty) => {
      ws.mergeCells(`A${r}:E${r}`);
      styleSectionTitle(ws.getCell(`A${r}`));
      ws.getCell(`A${r}`).value = '  ' + title;
      ws.getRow(r).height = 20; r++;
      if (!rowsOut.length) { ws.getCell(`A${r}`).value = empty || 'Nothing to report.'; ws.getCell(`A${r}`).font = { name: 'Calibri', italic: true, color: { argb: STEEL } }; r += 2; return; }
      cols.forEach((h, i) => { const c = ws.getCell(`${colLetter(i + 1)}${r}`); c.value = h; styleHeader(c, { align: i ? 'right' : 'left' }); });
      r++;
      rowsOut.forEach(vals => {
        vals.forEach((v, i) => {
          const c = ws.getCell(`${colLetter(i + 1)}${r}`);
          c.value = v;
          if (i) c.alignment = { horizontal: 'right' };
        });
        r++;
      });
      r++;
    };

    const ppl = S.bandwidthGrid(months, { includePursuit: true }).filter(x => x.activeMonths > 0).map(x => {
      const capH = months.length * S.capacityHours(x.person);
      return { person: x.person, peak: x.peak, avg: x.avg, capH, over: months.filter(m => (x.byMonth[m] || 0) > 100).length };
    });
    section('MOST OVEREXTENDED · peak load over 100%',
      ['Person', 'Peak %', 'Months > 100%', 'Avg %'],
      ppl.filter(p => p.peak > 100).sort((a, b) => b.peak - a.peak).slice(0, 15)
        .map(p => [p.person.name, Math.round(p.peak), p.over, Math.round(p.avg)]),
      'Nobody over the line.');

    section('HEADROOM · first call before hiring',
      ['Person', 'Avg load %', 'Peak %'],
      ppl.filter(p => p.peak > 0 && p.peak <= 85 && !(p.person && p.person.nonBillable)).sort((a, b) => a.avg - b.avg).slice(0, 15)
        .map(p => [p.person.name, Math.round(p.avg), Math.round(p.peak)]),
      'No one with meaningful headroom.');

    let avail = []; try { avail = S.comingAvailable({ includePursuit: true }) || []; } catch (e) {}
    section('COMING AVAILABLE · next 3 months',
      ['Person', 'Now %', 'Drops to %', 'When'],
      avail.slice(0, 15).map(f => [f.person.name, Math.round(f.cur), Math.round(f.to), S.ymLabel(f.m)]),
      'No meaningful load drops.');

    let unass = []; try { unass = S.unassignedRoles(months) || []; } catch (e) {}
    section('UNSTAFFED CONTRACT ROLES · title has nobody matching on the project',
      ['Project', 'Role', 'Contract hrs', 'FTE-months'],
      unass.slice(0, 30).map(u => [u.project, u.role, round1(u.hours), round1(u.fte)]),
      'Every contract role has a matching person staffed.');

    let mt = { overhead: [], boh: [], flagged: [] };
    try { mt = S.substantialMacroTime(months.filter(m => m <= S.currentYM())) || mt; } catch (e) {}
    section('SUBSTANTIAL INTERNAL TIME · >40h, overhead & BOH excluded',
      ['Person', 'Internal hrs', '% of their logged time'],
      (mt.flagged || []).map(x => [x.person.name, round1(x.hours), Math.round(x.pct * 100)]),
      'Nobody over 40h of unexpected internal time.');
    section('EXCLUDED FROM THAT FLAG · expected internal time',
      ['Person', 'Why', '% internal'],
      (mt.overhead || []).map(x => [x.person.name, 'Marked internal on Mapping', Math.round(x.pct * 100)])
        .concat((mt.boh || []).map(x => [x.person.name, 'Looks like back-of-house (≥90% internal) — consider marking internal', Math.round(x.pct * 100)])),
      'Nobody excluded.');
  }

  /* ============================================================
     SHEET · Time Entry — same grid + colours as the tab
     ============================================================ */
  writeTimeEntrySheets(wb, S, months, {}, { includeDetail: false });

  /* ============================================================
     SHEET · Mapping — roster ↔ Clockify, employment, fee links
     ============================================================ */
  {
    const ws = wb.addWorksheet('Mapping', { views: [{ showGridLines: false }] });
    ws.columns = [{ width: 30 }, { width: 26 }, { width: 18 }, { width: 14 }, { width: 40 }];
    let r = titleBlock(ws, 'Mapping', 'Roster ↔ Clockify identities, employment type, and project ↔ fee-tool links', 5);
    const db = S.readDb();
    const maps = db.mappings || {};

    ws.mergeCells(`A${r}:E${r}`); styleSectionTitle(ws.getCell(`A${r}`));
    ws.getCell(`A${r}`).value = '  PEOPLE'; ws.getRow(r).height = 20; r++;
    ['Person', 'Title', 'Employment', 'Capacity %', 'Pinned Clockify user(s)'].forEach((h, i) => {
      const c = ws.getCell(`${colLetter(i + 1)}${r}`); c.value = h; styleHeader(c, { align: i === 3 ? 'right' : 'left' });
    });
    r++;
    const userMaps = maps.users || {};
    S.listPeople().filter(p => !p.isNewHire).sort((a, b) => a.name.localeCompare(b.name)).forEach(p => {
      const pinned = Object.entries(userMaps).filter(([, pid]) => pid === p.id).map(([ck]) => ck).join(', ');
      const emp = S.personEmploymentType(p);
      ws.getCell(`A${r}`).value = p.name;
      ws.getCell(`B${r}`).value = p.title || '';
      ws.getCell(`C${r}`).value = emp === 'internal' ? 'Internal' : emp === 'part' ? 'Part time' : 'Full time';
      ws.getCell(`D${r}`).value = p.capacityPct != null ? p.capacityPct : 100;
      ws.getCell(`D${r}`).alignment = { horizontal: 'right' };
      ws.getCell(`E${r}`).value = pinned;
      r++;
    });
    r++;

    ws.mergeCells(`A${r}:E${r}`); styleSectionTitle(ws.getCell(`A${r}`));
    ws.getCell(`A${r}`).value = '  PROJECTS → FEE TOOL'; ws.getRow(r).height = 20; r++;
    ['Matrix project', 'Client', 'Linked fee project(s)', 'Link', 'Renamed from'].forEach((h, i) => {
      const c = ws.getCell(`${colLetter(i + 1)}${r}`); c.value = h; styleHeader(c);
    });
    r++;
    const renames = maps.renames || {};
    const revRen = {}; Object.entries(renames).forEach(([oldK, nw]) => { (revRen[nw] = revRen[nw] || []).push(oldK); });
    S.distinctProjects().sort((a, b) => a.localeCompare(b)).forEach(pn => {
      const client = (db.allocations.find(a => a.project === pn) || {}).client || '';
      let links = []; try { links = S.matchFeeProjects ? S.matchFeeProjects(pn, client) : []; } catch (e) {}
      const names = links.map(l => { const f = (STORE.listProjects() || []).find(x => x.id === l.id); return f ? ((f.project && f.project.name) || f.name || l.id) : l.id; });
      ws.getCell(`A${r}`).value = pn;
      ws.getCell(`B${r}`).value = client;
      ws.getCell(`C${r}`).value = names.join(' + ');
      ws.getCell(`D${r}`).value = links.length ? (links.some(l => l.via !== 'mapped') ? 'auto-matched' : 'confirmed') : 'not linked';
      ws.getCell(`E${r}`).value = (revRen[pn] || []).join(', ');
      if (!links.length) ws.getCell(`D${r}`).font = { name: 'Calibri', color: { argb: 'FFB3413B' } };
      r++;
    });
  }

  await download(wb, `Staffing-Full-Export_${dateStr}.xlsx`);
};

/* ============================================================
   TIME ENTRY sheets — shared by the full book and the standalone
   download, so both always match the tab exactly.
   ============================================================ */
function writeTimeEntrySheets(wb, S, monthsList, opts, cfg) {
  cfg = cfg || {};
  const comp = S.complianceRows(monthsList, opts || {});
  const ms = comp.months, rows = comp.rows;

  const ws = wb.addWorksheet('Clockify Reporting', { views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
  headerRow(ws, [
    { h: 'Person', w: 26 },
    ...ms.map(m => ({ h: S.ymLabel(m) + (m === comp.nowYm ? ' (pro-rata)' : ''), w: 11, align: 'right' })),
    { h: 'Behind (hrs)', w: 12, align: 'right' },
    { h: 'Months on target', w: 15, align: 'right' },
    { h: 'Logged (hrs)', w: 12, align: 'right' },
    { h: 'Their bar (hrs)', w: 13, align: 'right' },
    { h: 'Employment', w: 13 },
    { h: 'Flags', w: 30 },
  ], { xSplit: 1 });

  let r = 2;
  rows.forEach(row => {
    const p = row.person;
    const emp = S.personEmploymentType(p);
    ws.getCell(`A${r}`).value = p.name;
    ws.getCell(`A${r}`).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
    ms.forEach((ym, i) => {
      const cell = ws.getCell(`${colLetter(2 + i)}${r}`);
      const spec = complianceCell(row.byMonth[ym]);
      cell.value = spec.value;
      // 0% multiplies by 100 (0.99 -> "99%"). 0"%" would only append the sign
      // to the raw fraction and render 0.99 as "1%".
      if (typeof spec.value === 'number') cell.numFmt = '0%';
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: spec.fill } };
      cell.font = { name: 'Calibri', bold: !!spec.font.bold, color: { argb: spec.font.argb } };
      cell.alignment = { horizontal: 'right' };
      if (spec.note) cell.note = spec.note;
    });
    const base = 2 + ms.length;
    const behind = ws.getCell(`${colLetter(base)}${r}`);
    behind.value = row.behindHrs > 1 ? round1(row.behindHrs) : null;
    behind.numFmt = '#,##0.0'; behind.alignment = { horizontal: 'right' };
    if (row.behindHrs > 8) behind.font = { name: 'Calibri', bold: true, color: { argb: 'FFB3413B' } };
    const tgt = ws.getCell(`${colLetter(base + 1)}${r}`);
    tgt.value = row.compliance; tgt.numFmt = '0%'; tgt.alignment = { horizontal: 'right' };
    if (row.compliance < 0.5) tgt.font = { name: 'Calibri', bold: true, color: { argb: 'FFB3413B' } };
    ws.getCell(`${colLetter(base + 2)}${r}`).value = round1(row.totLogged);
    ws.getCell(`${colLetter(base + 3)}${r}`).value = round1(row.totCap);
    [base + 2, base + 3].forEach(i => { const c = ws.getCell(`${colLetter(i)}${r}`); c.numFmt = '#,##0.0'; c.alignment = { horizontal: 'right' }; });
    ws.getCell(`${colLetter(base + 4)}${r}`).value = emp === 'internal' ? 'Internal' : emp === 'part' ? `Part time · ${p.capacityPct}%` : 'Full time';
    ws.getCell(`${colLetter(base + 5)}${r}`).value = [
      row.joinedMid ? 'Joined ' + S.ymLabel(row.joined) : '',
      row.leaveMonths ? row.leaveMonths + ' mo leave' : '',
    ].filter(Boolean).join(' · ');
    r++;
  });
  if (!rows.length) ws.getCell('A2').value = '(no logged hours in this window)';

  /* legend + the not-tracked list, so the sheet explains itself */
  r += 1;
  ws.getCell(`A${r}`).value = 'LEGEND';
  ws.getCell(`A${r}`).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
  r++;
  [['≥100% of their bar logged', C_OVER], ['80–99% · on target', C_OK], ['1–79% · behind', C_LOW],
   ['0% · nothing logged', C_ZERO], ['On leave — not expected', C_LEAVE], ['Not allocated / not here yet', C_NA],
  ].forEach(([label, fill]) => {
    const sw = ws.getCell(`A${r}`);
    sw.value = label;
    sw.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    sw.font = { name: 'Calibri', size: 10, color: { argb: fill === C_ZERO ? WHITE : NAVY } };
    r++;
  });
  r++;
  ws.getCell(`A${r}`).value = `The bar is ${S.monthHours()} h/month × each person's capacity %, so part-timers are measured against their own number. Months before someone's first logged hour, and months on leave, are not expected of them. Current month is pro-rata.`;
  ws.getCell(`A${r}`).font = { name: 'Calibri', italic: true, size: 9, color: { argb: STEEL } };
  r += 2;
  if (comp.untracked.length) {
    ws.getCell(`A${r}`).value = 'NOT TRACKED HERE — no hours can arrive for these people';
    ws.getCell(`A${r}`).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
    r++;
    comp.untracked.forEach(u => {
      ws.getCell(`A${r}`).value = u.person.name;
      ws.getCell(`B${r}`).value = u.reason;
      ws.getCell(`B${r}`).font = { name: 'Calibri', italic: true, size: 10, color: { argb: STEEL } };
      r++;
    });
  }

  /* Optional per-person × month detail sheet (standalone export only) */
  if (cfg.includeDetail) {
    const d = wb.addWorksheet('Clockify Reporting detail', { views: [{ state: 'frozen', ySplit: 1 }] });
    headerRow(d, [
      { h: 'Person', w: 26 }, { h: 'Title', w: 24 }, { h: 'Employment', w: 14 }, { h: 'Month', w: 11 },
      { h: 'Logged hrs', w: 12, align: 'right' }, { h: 'Their bar hrs', w: 13, align: 'right' },
      { h: '% of bar', w: 10, align: 'right' }, { h: 'State', w: 18 },
    ]);
    let dr = 2;
    rows.forEach(row => {
      const emp = S.personEmploymentType(row.person);
      ms.forEach(ym => {
        const c = row.byMonth[ym];
        const state = c === 'leave' ? 'On leave' : !c ? 'Not expected' : (c.pct >= 1 ? 'At/over bar' : c.pct >= 0.8 ? 'On target' : c.pct > 0 ? 'Behind' : 'Nothing logged');
        d.getCell(`A${dr}`).value = row.person.name;
        d.getCell(`B${dr}`).value = row.person.title || '';
        d.getCell(`C${dr}`).value = emp === 'internal' ? 'Internal' : emp === 'part' ? 'Part time' : 'Full time';
        d.getCell(`D${dr}`).value = ym;
        d.getCell(`E${dr}`).value = c && c !== 'leave' ? round1(c.h) : null;
        d.getCell(`F${dr}`).value = c && c !== 'leave' ? round1(c.capM) : null;
        const pc = d.getCell(`G${dr}`);
        pc.value = c && c !== 'leave' ? c.pct : null; pc.numFmt = '0%';
        d.getCell(`H${dr}`).value = state;
        if (c && c !== 'leave') {
          const spec = complianceCell(c);
          pc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: spec.fill } };
          pc.font = { name: 'Calibri', bold: !!spec.font.bold, color: { argb: spec.font.argb } };
        } else if (c === 'leave') {
          d.getCell(`H${dr}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_LEAVE } };
        }
        ['E', 'F', 'G'].forEach(col => d.getCell(`${col}${dr}`).alignment = { horizontal: 'right' });
        dr++;
      });
    });
    if (dr > 2) d.autoFilter = { from: 'A1', to: `H${dr - 1}` };
  }
  return comp;
}

/** Standalone Clockify Reporting download — the tab plus a flat detail sheet. */
window.UFC_buildAndDownloadTimeEntryExport = async function (monthsList, opts) {
  const S = window.UFC_Staff;
  const STORE = window.UFC_Store;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Savills PPM';
  wb.created = new Date();
  wb.title = 'Clockify Reporting';
  const dateStr = new Date().toISOString().slice(0, 10);
  const who = (STORE.getCurrentUser() || {}).username || 'unknown';

  writeTimeEntrySheets(wb, S, monthsList || [], opts || {}, { includeDetail: true });

  // stamp provenance on the grid sheet
  const ws = wb.getWorksheet('Clockify Reporting');
  const lastRow = ws.lastRow ? ws.lastRow.number + 2 : 2;
  ws.getCell(`A${lastRow}`).value = `Exported ${dateStr} by ${who} · static values, not live formulas`;
  ws.getCell(`A${lastRow}`).font = { name: 'Calibri', italic: true, size: 9, color: { argb: STEEL } };

  await download(wb, `Clockify-Reporting_${dateStr}.xlsx`);
};

})();
