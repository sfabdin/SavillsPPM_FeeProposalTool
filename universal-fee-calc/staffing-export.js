/* ============================================================
   STAFFING & BANDWIDTH · Excel snapshot export
   ------------------------------------------------------------
   A frozen, values-only (no live formulas) point-in-time record —
   for version control / historical review, not for editing back
   into the app. Three sheets:
     1. Allocations     — raw, one row per allocation record
     2. Actuals         — raw, one row per person × project × month
     3. Project Summary — rolled up to match the Compare tab: a
        quick totals table plus Plan/Contract/Actual monthly detail,
        each with a grand-total row that ties to the on-screen chart
   ============================================================ */
window.UFC_buildAndDownloadStaffingSnapshot = async function () {
  const S = window.UFC_Staff;
  const STORE = window.UFC_Store;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Savills PPM';
  wb.created = new Date();
  wb.title = 'Staffing & Bandwidth Snapshot';

  const NAVY = 'FF25273A', YELLOW = 'FFFFDF00', CREAM = 'FFEEE8E3', STEEL = 'FF79828C', WHITE = 'FFFFFFFF';

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
  const colLetter = (n) => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
  const round1 = (n) => Math.round((n || 0) * 10) / 10;

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
  const s3 = wb.addWorksheet('Project Summary', { views: [{ showGridLines: false, state: 'frozen', xSplit: 2, ySplit: 0 }] });
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

  /* Download */
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Staffing-Snapshot_${dateStr}.xlsx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
