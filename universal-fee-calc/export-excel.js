/* ============================================================
   UNIVERSAL FEE CALCULATOR · Excel export
   Produces a 3-sheet workbook with live formulas:
   - Rates & Summary
   - Phase Matrix
   - Monthly Schedule
   ============================================================ */

window.UFC_buildAndDownloadExcel = async function () {
  const S = window.__UFC__;
  const state = S.getState();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Savills PPM';
  wb.created = new Date();
  wb.title = (state.project.name || 'Fee Calculator') + ' · Fee Calculator';

  /* Colors (ARGB) */
  const NAVY = 'FF25273A', YELLOW = 'FFFFDF00', CREAM = 'FFEEE8E3', STEEL = 'FF79828C';
  const WHITE = 'FFFFFFFF', RED = 'FFCE181E', YEL_TINT = 'FFFFF5BF', TEAL = 'FF238291';

  /* Style helpers */
  const styleHeader = (cell, opts = {}) => {
    cell.font = { name: 'Calibri', bold: true, color: { argb: opts.fg || WHITE }, size: opts.size || 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg || NAVY } };
    cell.alignment = { vertical: 'middle', horizontal: opts.align || 'left', wrapText: true };
    cell.border = { bottom: { style: 'medium', color: { argb: NAVY } } };
  };
  const styleSectionTitle = (cell) => {
    cell.font = { name: 'Calibri', bold: true, color: { argb: NAVY }, size: 14 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  };
  const styleLabel = (cell) => {
    cell.font = { name: 'Calibri', bold: true, color: { argb: NAVY }, size: 10 };
    cell.alignment = { vertical: 'middle' };
  };
  const styleInput = (cell, fmt) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
    cell.font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
    cell.border = { bottom: { style: 'thin', color: { argb: NAVY } } };
    if (fmt) cell.numFmt = fmt;
    cell.alignment = { vertical: 'middle', horizontal: 'right' };
  };
  const styleFormula = (cell, fmt) => {
    cell.font = { name: 'Calibri', color: { argb: STEEL }, italic: true };
    if (fmt) cell.numFmt = fmt;
    cell.alignment = { vertical: 'middle', horizontal: 'right' };
  };
  /* Role label: typed Project Role bold on top, staff title muted below —
     mirrors the on-screen phase-matrix cell. Falls back to staff title. */
  const roleLabelRich = (r) => {
    const title = S.getTitle(r.titleId);
    const staff = title?.name || '—';
    const proj = (r.projectRole || '').trim();
    if (!proj) return { richText: [{ text: staff, font: { name: 'Calibri', bold: true, color: { argb: NAVY } } }] };
    return { richText: [
      { text: proj, font: { name: 'Calibri', bold: true, color: { argb: NAVY } } },
      { text: '\n' + staff, font: { name: 'Calibri', size: 9, color: { argb: STEEL } } },
    ] };
  };

  const months = S.getMonths();
  const byPhase = S.getMonthsByPhase();
  const roles = state.roles;
  const groups = state.groups;
  const phases = state.phases;

  /* ============================================================
     SHEET 1 · Setup & Summary
     ============================================================ */
  const s1 = wb.addWorksheet('Setup & Summary', {
    properties: { defaultRowHeight: 18 },
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1, margins: { left:0.5, right:0.5, top:0.5, bottom:0.5, header:0.3, footer:0.3 } },
    views: [{ showGridLines: false }],
  });
  s1.columns = [{ width: 30 }, { width: 22 }, { width: 18 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 36 }];

  // Title
  s1.mergeCells('A1:H1');
  const t1 = s1.getCell('A1');
  t1.value = `Savills · ${state.project.name || 'Untitled Project'} · Fee Calculator`;
  t1.font = { name: 'Calibri', bold: true, size: 20, color: { argb: NAVY } };
  s1.getRow(1).height = 30;

  s1.mergeCells('A2:H2');
  const t2 = s1.getCell('A2');
  t2.value = `${state.project.client ? 'for ' + state.project.client + '  ·  ' : ''}${state.project.lead || ''}  ·  ${state.project.proposalDate || ''}  ·  ${state.project.location || ''}`;
  t2.font = { name: 'Calibri', italic: true, color: { argb: STEEL }, size: 11 };

  // Project info
  let row = 4;
  s1.mergeCells(`A${row}:H${row}`);
  styleSectionTitle(s1.getCell(`A${row}`));
  s1.getCell(`A${row}`).value = '  PROJECT INFO';
  s1.getRow(row).height = 24;
  row++;
  const meta = [
    ['Project',       state.project.name],
    ['Client',        state.project.client],
    ['Savills lead',  state.project.lead],
    ['Proposal date', state.project.proposalDate],
    ['Location',      state.project.location],
    ['Period',        months.length ? `${months[0].longLabel} → ${months[months.length-1].longLabel}` : '—'],
    ['Months',        months.length],
  ];
  meta.forEach(m => {
    styleLabel(s1.getCell(`A${row}`));
    s1.getCell(`A${row}`).value = m[0];
    s1.mergeCells(`B${row}:H${row}`);
    s1.getCell(`B${row}`).value = m[1] || '';
    s1.getCell(`B${row}`).font = { name: 'Calibri', color: { argb: NAVY } };
    row++;
  });

  // Assumptions
  row++;
  s1.mergeCells(`A${row}:H${row}`);
  styleSectionTitle(s1.getCell(`A${row}`));
  s1.getCell(`A${row}`).value = '  GLOBAL ASSUMPTIONS';
  s1.getRow(row).height = 24;
  row++;
  const assumpStart = row;
  const assumps = [
    ['Hours per FTE / month',  state.assumptions.hrsPerMo,    '0.00',   '2,080 / 12 — standard'],
    ['YoY escalation %',       state.assumptions.escalation,  '0.0\\%', 'Compounded from catalog base year'],
    ['Client discount %',      state.assumptions.discount,    '0.0\\%', 'Client / fixed-fee discount, applied at total'],
    ['Rate Lock (1 = on)',     state.assumptions.rateLock ? 1 : 0, '0', 'Locks rates at project start year'],
    ['Catalog base year',      state.assumptions.catalogBaseYear, '0', 'Year of published rates in the catalog'],
    ['Project start year',     state.timeline.startYear,      '0',      'Used as escalation anchor'],
    ['Industry standard adj %', state.assumptions.industryAdj || 0, '0.0\\%', 'Trims rack rates to a competitive baseline'],
  ];
  assumps.forEach((a, i) => {
    const r = assumpStart + i;
    styleLabel(s1.getCell(`A${r}`));
    s1.getCell(`A${r}`).value = a[0];
    s1.getCell(`B${r}`).value = a[1];
    styleInput(s1.getCell(`B${r}`), a[2]);
    s1.mergeCells(`C${r}:H${r}`);
    s1.getCell(`C${r}`).value = a[3];
    s1.getCell(`C${r}`).font = { name: 'Calibri', size: 10, color: { argb: STEEL }, italic: true };
  });
  // Named refs
  wb.definedNames.add(`'Setup & Summary'!$B$${assumpStart}`,   'hrs_per_mo');
  wb.definedNames.add(`'Setup & Summary'!$B$${assumpStart+1}`, 'escalation_pct');
  wb.definedNames.add(`'Setup & Summary'!$B$${assumpStart+2}`, 'discount_pct');
  wb.definedNames.add(`'Setup & Summary'!$B$${assumpStart+3}`, 'rate_lock');
  wb.definedNames.add(`'Setup & Summary'!$B$${assumpStart+4}`, 'catalog_base_year');
  wb.definedNames.add(`'Setup & Summary'!$B$${assumpStart+5}`, 'project_start_year');
  wb.definedNames.add(`'Setup & Summary'!$B$${assumpStart+6}`, 'industry_adj');
  row = assumpStart + assumps.length;

  // Rates table
  row++;
  s1.mergeCells(`A${row}:H${row}`);
  styleSectionTitle(s1.getCell(`A${row}`));
  s1.getCell(`A${row}`).value = '  RATES (per role · industry-adjusted rate × compounded escalation)';
  s1.getRow(row).height = 24;
  row++;
  ['Role', 'Tier', 'Resource', 'Group', 'Adjusted rate', `Start-yr rate`, 'End-yr rate', 'Notes'].forEach((h, i) => {
    const c = s1.getRow(row).getCell(i + 1);
    c.value = h;
    styleHeader(c, { align: i < 4 || i === 7 ? 'left' : 'right' });
  });
  s1.getRow(row).height = 30;
  const ratesHdrRow = row;
  row++;
  const ratesRowByRoleId = {};
  roles.forEach(r => {
    const title = S.getTitle(r.titleId);
    const tier = S.getTier(r.titleId, r.tierId);
    const group = S.getGroup(r.groupId);
    const rn = row;
    ratesRowByRoleId[r.id] = rn;
    s1.getCell(`A${rn}`).value = roleLabelRich(r);
    s1.getCell(`A${rn}`).alignment = { vertical: 'middle', wrapText: true };
    s1.getCell(`B${rn}`).value = tier?.label || '';
    s1.getCell(`B${rn}`).font = { name: 'Calibri', size: 10, color: { argb: STEEL } };
    s1.getCell(`C${rn}`).value = r.resource || 'TBD';
    s1.getCell(`C${rn}`).font = { name: 'Calibri', size: 10, color: { argb: STEEL } };
    s1.getCell(`D${rn}`).value = group?.name || '';
    s1.getCell(`D${rn}`).font = { name: 'Calibri', size: 10, color: { argb: STEEL } };
    // Base rate column (E):
    //  • Grid       → adjusted rack = rack × (1 − industry_adj), anchored at catalog base year
    //  • Contracted → the entered rate as-is (bypasses industry adj), anchored at project start year
    const isContracted = r.rateSource === 'contracted';
    const anchorRef = isContracted ? 'project_start_year' : 'catalog_base_year';
    const rackRate = tier?.isNoCharge ? 0 : (tier?.rate || 0);
    if (isContracted) {
      const cr = parseFloat(r.contractedRate); 
      s1.getCell(`E${rn}`).value = isNaN(cr) ? 0 : cr;
      styleInput(s1.getCell(`E${rn}`), '"$"#,##0.00');
    } else if (rackRate) {
      s1.getCell(`E${rn}`).value = { formula: `ROUND(${rackRate}*(1-industry_adj/100),2)` };
      styleFormula(s1.getCell(`E${rn}`), '"$"#,##0.00');
    } else {
      s1.getCell(`E${rn}`).value = 0;
      styleInput(s1.getCell(`E${rn}`), '"$"#,##0.00');
    }
    // Start-yr rate (formula) — anchored at the role's base year
    s1.getCell(`F${rn}`).value = { formula: `E${rn}*POWER(1+escalation_pct/100, project_start_year - ${anchorRef})` };
    styleFormula(s1.getCell(`F${rn}`), '"$"#,##0.00');
    // End-yr rate
    const endYear = state.timeline.endYear;
    // Published end-year rate (full escalation). Rate Lock shows as the credit, not here.
    s1.getCell(`G${rn}`).value = { formula: `E${rn}*POWER(1+escalation_pct/100, ${endYear} - ${anchorRef})` };
    styleFormula(s1.getCell(`G${rn}`), '"$"#,##0.00');
    const noteParts = [];
    if (r.projectRole) noteParts.push('Project role: ' + r.projectRole);
    if (isContracted) noteParts.push('Contracted rate · bypasses industry adj');
    else if (tier && !tier.isNoCharge) noteParts.push(`Rack $${tier.rate} · −${state.assumptions.industryAdj || 0}% adj`);
    if (tier && !tier.isNoCharge && tier.costFloor) noteParts.push('Cost floor $' + tier.costFloor + '/hr');
    if (title?.note) noteParts.push(title.note);
    s1.getCell(`H${rn}`).value = noteParts.join('  ·  ');
    s1.getCell(`H${rn}`).font = { name: 'Calibri', size: 9, italic: true, color: { argb: STEEL } };
    s1.getCell(`H${rn}`).alignment = { vertical: 'top', wrapText: true };
    s1.getRow(rn).height = (r.projectRole && r.projectRole.trim()) ? 30 : 22;
    row++;
  });

  // Summary block
  row++;
  s1.mergeCells(`A${row}:H${row}`);
  styleSectionTitle(s1.getCell(`A${row}`));
  s1.getCell(`A${row}`).value = '  HEADLINE TOTALS';
  s1.getRow(row).height = 24;
  row++;
  const summary = [
    ['Total FTE-months',         `'Phase Matrix'!total_fte_months`,         '0.0" fte-mo"'],
    ['Gross fee · published',    `'Phase Matrix'!gross_fee`,                '"$"#,##0'],
    ['Less Rate Lock credit',    `-'Phase Matrix'!lock_credit`,             '"$"#,##0'],
    ['Less client discount',     `-'Phase Matrix'!gross_fee*(discount_pct/100)`, '"$"#,##0'],
    ['Net proposed fee',         `'Phase Matrix'!gross_fee - 'Phase Matrix'!lock_credit - 'Phase Matrix'!gross_fee*(discount_pct/100)`, '"$"#,##0'],
  ];
  summary.forEach((s, i) => {
    const r = row++;
    s1.getCell(`A${r}`).value = s[0];
    s1.getCell(`A${r}`).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
    s1.getCell(`B${r}`).value = { formula: s[1] };
    if (i === summary.length - 1) {
      s1.getCell(`A${r}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      s1.getCell(`A${r}`).font = { name: 'Calibri', bold: true, color: { argb: YELLOW }, size: 12 };
      s1.getCell(`B${r}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
      s1.getCell(`B${r}`).font = { name: 'Calibri', bold: true, color: { argb: NAVY }, size: 13 };
      s1.getCell(`B${r}`).numFmt = s[2];
      s1.getCell(`B${r}`).alignment = { horizontal: 'right' };
      s1.getRow(r).height = 26;
    } else {
      s1.getCell(`B${r}`).numFmt = s[2];
      s1.getCell(`B${r}`).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
      s1.getCell(`B${r}`).alignment = { horizontal: 'right' };
    }
  });

  /* ============================================================
     SHEET 2 · Phase Matrix
     ============================================================ */
  const s2 = wb.addWorksheet('Phase Matrix', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
    views: [{ showGridLines: false, state: 'frozen', xSplit: 4, ySplit: 8 }],
  });
  const nPhases = phases.length;
  s2.columns = [
    { width: 26 },   // A: role
    { width: 16 },   // B: tier
    { width: 18 },   // C: resource
    { width: 11 },   // D: catalog rate
    ...Array(nPhases).fill({ width: 11 }),
    { width: 16 },   // last: role total
  ];

  s2.mergeCells(`A1:${colLetter(4 + nPhases + 1)}1`);
  s2.getCell('A1').value = 'Phase Matrix · FTE % allocation';
  s2.getCell('A1').font = { name: 'Calibri', bold: true, size: 18, color: { argb: NAVY } };
  s2.getRow(1).height = 28;

  // Header row 4 — phase names
  const r4 = s2.getRow(4);
  ['Role', 'Tier', 'Resource', 'Adjusted rate'].forEach((h, i) => {
    r4.getCell(i + 1).value = h;
    styleHeader(r4.getCell(i + 1), { align: i === 3 ? 'right' : 'left' });
  });
  phases.forEach((p, i) => {
    const c = r4.getCell(5 + i);
    c.value = p.name;
    styleHeader(c, { align: 'center' });
  });
  r4.getCell(5 + nPhases).value = 'Role total';
  styleHeader(r4.getCell(5 + nPhases), { align: 'right' });
  r4.height = 30;

  // Row 5 — date ranges
  const r5 = s2.getRow(5);
  r5.getCell(1).value = '';
  phases.forEach((p, i) => {
    const slice = byPhase.find(x => x.phase.id === p.id)?.months || [];
    const lbl = slice.length ? (slice.length === 1 ? slice[0].label : `${slice[0].label}–${slice[slice.length-1].label}`) : '—';
    const c = r5.getCell(5 + i);
    c.value = lbl;
    c.font = { name: 'Calibri', size: 9, color: { argb: STEEL } };
    c.alignment = { horizontal: 'center' };
  });

  // Row 6 — months in phase
  const r6 = s2.getRow(6);
  r6.getCell(1).value = 'Months →';
  r6.getCell(1).font = { name: 'Calibri', size: 9, italic: true, color: { argb: STEEL } };
  r6.getCell(1).alignment = { horizontal: 'right' };
  s2.mergeCells('A6:D6');
  phases.forEach((p, i) => {
    const c = r6.getCell(5 + i);
    c.value = p.length;
    c.font = { name: 'Calibri', size: 9, color: { argb: STEEL }, bold: true };
    c.alignment = { horizontal: 'center' };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };
  });

  // Row 7 — average escalation factor for the phase (per year, compounded; rate lock honored)
  const r7 = s2.getRow(7);
  r7.getCell(1).value = 'Esc factor →';
  r7.getCell(1).font = { name: 'Calibri', size: 9, italic: true, color: { argb: STEEL } };
  r7.getCell(1).alignment = { horizontal: 'right' };
  s2.mergeCells('A7:D7');
  // For each phase, compute the *weighted* escalation factor across its months
  // factor_phase = (sum over months: (1+esc)^(year - baseYear)) / count
  // With rate lock, all months use (1+esc)^(startYear - baseYear)
  phases.forEach((p, i) => {
    const slice = byPhase.find(x => x.phase.id === p.id)?.months || [];
    if (!slice.length) {
      r7.getCell(5 + i).value = 1;
    } else {
      // Build formula: IF(rate_lock=1, (1+esc)^(start-base), AVG of monthly factors)
      // For simplicity we precompute the year list:
      const years = slice.map(m => m.year);
      const unique = [...new Set(years)];
      const counts = unique.map(y => years.filter(yy => yy === y).length);
      const avgFormulaParts = unique.map((y, j) =>
        `${counts[j]}*POWER(1+escalation_pct/100, ${y} - catalog_base_year)`
      ).join('+');
      // Published (unlocked) escalation factor only. Rate Lock is NOT applied
      // here — it surfaces once as the lock_credit deduction (no double-removal).
      const unlocked = `(${avgFormulaParts})/${slice.length}`;
      r7.getCell(5 + i).value = { formula: unlocked };
    }
    const c = r7.getCell(5 + i);
    c.numFmt = '0.0000';
    c.font = { name: 'Calibri', size: 9, color: { argb: STEEL }, bold: true };
    c.alignment = { horizontal: 'center' };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };
  });

  // Roles grouped by group
  let mrow = 8;
  const roleRowByRoleId = {};
  const fteCellRef = {};   // role.id → { phaseId → "'Phase Matrix'!<cell>" } for the Monthly Detail sheet
  groups.forEach(g => {
    const inGroup = roles.filter(r => r.groupId === g.id);
    if (!inGroup.length) return;
    s2.mergeCells(`A${mrow}:${colLetter(5 + nPhases)}${mrow}`);
    const gh = s2.getCell(`A${mrow}`);
    gh.value = '  ' + g.name.toUpperCase();
    gh.font = { name: 'Calibri', bold: true, color: { argb: WHITE }, size: 10 };
    gh.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    mrow++;
    inGroup.forEach(r => {
      roleRowByRoleId[r.id] = mrow;
      const title = S.getTitle(r.titleId);
      const tier = S.getTier(r.titleId, r.tierId);
      s2.getCell(`A${mrow}`).value = roleLabelRich(r);
      s2.getCell(`A${mrow}`).alignment = { vertical: 'middle', wrapText: true };
      s2.getCell(`B${mrow}`).value = tier?.label || '';
      s2.getCell(`B${mrow}`).font = { name: 'Calibri', size: 10, color: { argb: STEEL } };
      s2.getCell(`C${mrow}`).value = r.resource || 'TBD';
      s2.getCell(`C${mrow}`).font = { name: 'Calibri', size: 10, color: { argb: STEEL } };
      // Catalog rate formula referencing Sheet 1
      const ratesR = ratesRowByRoleId[r.id];
      s2.getCell(`D${mrow}`).value = { formula: `'Setup & Summary'!E${ratesR}` };
      s2.getCell(`D${mrow}`).numFmt = '"$"#,##0';
      s2.getCell(`D${mrow}`).font = { name: 'Calibri', color: { argb: STEEL } };
      s2.getCell(`D${mrow}`).alignment = { horizontal: 'right' };
      // FTE inputs per phase
      phases.forEach((p, i) => {
        const c = s2.getCell(`${colLetter(5 + i)}${mrow}`);
        c.value = r.fte[p.id] || 0;
        c.numFmt = '0"%"';
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: (r.fte[p.id] || 0) > 0 ? YEL_TINT : 'FFFAFAF7' } };
        c.font = { name: 'Calibri', color: { argb: (r.fte[p.id] || 0) > 0 ? NAVY : STEEL }, bold: (r.fte[p.id] || 0) > 0 };
        c.alignment = { horizontal: 'center' };
      });
      // Remember each FTE cell so the Monthly Detail sheet can reference it live.
      fteCellRef[r.id] = {};
      phases.forEach((p, i) => { fteCellRef[r.id][p.id] = `'Phase Matrix'!${colLetter(5 + i)}${mrow}`; });
      // Role total formula: SUMPRODUCT(FTE row, months row, esc factor row) / 100 * catalog rate * hrs_per_mo
      const fteStartCol = 5, fteEndCol = 5 + nPhases - 1;
      const fteRange = `${colLetter(fteStartCol)}${mrow}:${colLetter(fteEndCol)}${mrow}`;
      const monthsRange = `$${colLetter(fteStartCol)}$6:$${colLetter(fteEndCol)}$6`;
      const escRange = `$${colLetter(fteStartCol)}$7:$${colLetter(fteEndCol)}$7`;
      const totalCell = s2.getCell(`${colLetter(5 + nPhases)}${mrow}`);
      totalCell.value = { formula: `SUMPRODUCT(${fteRange}, ${monthsRange}, ${escRange})/100 * D${mrow} * hrs_per_mo` };
      totalCell.numFmt = '"$"#,##0';
      totalCell.font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
      totalCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };
      totalCell.alignment = { horizontal: 'right' };
      mrow++;
    });
  });

  // Subtotal rows
  mrow++;
  const totalFteRow = mrow;
  s2.mergeCells(`A${totalFteRow}:D${totalFteRow}`);
  s2.getCell(`A${totalFteRow}`).value = 'Total FTEs';
  s2.getCell(`A${totalFteRow}`).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
  s2.getCell(`A${totalFteRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
  s2.getCell(`A${totalFteRow}`).alignment = { horizontal: 'left' };
  phases.forEach((p, i) => {
    const col = colLetter(5 + i);
    // Sum all role rows in this column
    const roleRowsList = Object.values(roleRowByRoleId);
    if (roleRowsList.length) {
      const firstR = Math.min(...roleRowsList);
      const lastR = Math.max(...roleRowsList);
      const c = s2.getCell(`${col}${totalFteRow}`);
      c.value = { formula: `SUM(${col}${firstR}:${col}${lastR})/100` };
      c.numFmt = '0.0';
      c.font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
      c.alignment = { horizontal: 'center' };
    }
  });
  // Total fte-months in last col
  const tfm = s2.getCell(`${colLetter(5 + nPhases)}${totalFteRow}`);
  tfm.value = { formula: `SUMPRODUCT(${colLetter(5)}${totalFteRow}:${colLetter(5+nPhases-1)}${totalFteRow}, $${colLetter(5)}$6:$${colLetter(5+nPhases-1)}$6)` };
  tfm.numFmt = '0.0';
  tfm.font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
  tfm.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
  tfm.alignment = { horizontal: 'center' };
  wb.definedNames.add(`'Phase Matrix'!$${colLetter(5+nPhases)}$${totalFteRow}`, 'total_fte_months');
  s2.getRow(totalFteRow).height = 22;

  // Phase fee row
  mrow++;
  const phaseFeeRow = mrow;
  s2.mergeCells(`A${phaseFeeRow}:D${phaseFeeRow}`);
  s2.getCell(`A${phaseFeeRow}`).value = 'Phase fee (gross)';
  s2.getCell(`A${phaseFeeRow}`).font = { name: 'Calibri', bold: true, color: { argb: WHITE } };
  s2.getCell(`A${phaseFeeRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  s2.getCell(`A${phaseFeeRow}`).alignment = { horizontal: 'left' };
  phases.forEach((p, i) => {
    const col = colLetter(5 + i);
    const roleRowsList = Object.values(roleRowByRoleId);
    if (roleRowsList.length) {
      const firstR = Math.min(...roleRowsList);
      const lastR = Math.max(...roleRowsList);
      const c = s2.getCell(`${col}${phaseFeeRow}`);
      c.value = { formula: `SUMPRODUCT(${col}${firstR}:${col}${lastR}, $D$${firstR}:$D$${lastR})/100 * ${col}$6 * ${col}$7 * hrs_per_mo` };
      c.numFmt = '"$"#,##0';
      c.font = { name: 'Calibri', bold: true, color: { argb: WHITE } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      c.alignment = { horizontal: 'right' };
    }
  });
  const totalFee = s2.getCell(`${colLetter(5 + nPhases)}${phaseFeeRow}`);
  totalFee.value = { formula: `SUM(${colLetter(5)}${phaseFeeRow}:${colLetter(5+nPhases-1)}${phaseFeeRow})` };
  totalFee.numFmt = '"$"#,##0';
  totalFee.font = { name: 'Calibri', bold: true, color: { argb: YELLOW } };
  totalFee.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  totalFee.alignment = { horizontal: 'right' };
  s2.getRow(phaseFeeRow).height = 22;

  // Gross / Lock / Discount / Net
  mrow += 2;
  const grossRow = mrow++;
  const lockRow  = mrow++;
  const discRow  = mrow++;
  const netRow   = mrow++;

  const lastCol = colLetter(5 + nPhases);
  s2.mergeCells(`A${grossRow}:${colLetter(4 + nPhases)}${grossRow}`);
  s2.getCell(`A${grossRow}`).value = 'Gross fee · sum of all phases';
  s2.getCell(`A${grossRow}`).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
  s2.getCell(`A${grossRow}`).alignment = { horizontal: 'right' };
  s2.getCell(`${lastCol}${grossRow}`).value = { formula: `${lastCol}${phaseFeeRow}` };
  s2.getCell(`${lastCol}${grossRow}`).numFmt = '"$"#,##0';
  s2.getCell(`${lastCol}${grossRow}`).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
  s2.getCell(`${lastCol}${grossRow}`).alignment = { horizontal: 'right' };
  wb.definedNames.add(`'Phase Matrix'!$${lastCol}$${grossRow}`, 'gross_fee');

  // Lock credit: gross_fee × (1 - 1/escalation_factor_weighted) × rate_lock — approximate via cached values
  // Simpler: precompute lockCredit and store as a value
  const lockCreditValue = S.lockCredit();
  s2.mergeCells(`A${lockRow}:${colLetter(4 + nPhases)}${lockRow}`);
  s2.getCell(`A${lockRow}`).value = 'Less Rate Lock credit (×rate_lock flag)';
  s2.getCell(`A${lockRow}`).font = { name: 'Calibri', bold: true, color: { argb: RED } };
  s2.getCell(`A${lockRow}`).alignment = { horizontal: 'right' };
  s2.getCell(`${lastCol}${lockRow}`).value = { formula: `${lockCreditValue.toFixed(2)} * rate_lock` };
  s2.getCell(`${lastCol}${lockRow}`).numFmt = '"$"#,##0';
  s2.getCell(`${lastCol}${lockRow}`).font = { name: 'Calibri', bold: true, color: { argb: RED } };
  s2.getCell(`${lastCol}${lockRow}`).alignment = { horizontal: 'right' };
  wb.definedNames.add(`'Phase Matrix'!$${lastCol}$${lockRow}`, 'lock_credit');

  s2.mergeCells(`A${discRow}:${colLetter(4 + nPhases)}${discRow}`);
  s2.getCell(`A${discRow}`).value = 'Less client discount';
  s2.getCell(`A${discRow}`).font = { name: 'Calibri', bold: true, color: { argb: RED } };
  s2.getCell(`A${discRow}`).alignment = { horizontal: 'right' };
  s2.getCell(`${lastCol}${discRow}`).value = { formula: `-${lastCol}${grossRow}*(discount_pct/100)` };
  s2.getCell(`${lastCol}${discRow}`).numFmt = '"$"#,##0';
  s2.getCell(`${lastCol}${discRow}`).font = { name: 'Calibri', bold: true, color: { argb: RED } };
  s2.getCell(`${lastCol}${discRow}`).alignment = { horizontal: 'right' };

  s2.mergeCells(`A${netRow}:${colLetter(4 + nPhases)}${netRow}`);
  s2.getCell(`A${netRow}`).value = 'Total proposed fee (net)';
  s2.getCell(`A${netRow}`).font = { name: 'Calibri', bold: true, color: { argb: YELLOW }, size: 13 };
  s2.getCell(`A${netRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  s2.getCell(`A${netRow}`).alignment = { horizontal: 'right' };
  s2.getCell(`${lastCol}${netRow}`).value = { formula: `${lastCol}${grossRow} - ${lastCol}${lockRow} + ${lastCol}${discRow}` };
  s2.getCell(`${lastCol}${netRow}`).numFmt = '"$"#,##0';
  s2.getCell(`${lastCol}${netRow}`).font = { name: 'Calibri', bold: true, color: { argb: NAVY }, size: 13 };
  s2.getCell(`${lastCol}${netRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
  s2.getCell(`${lastCol}${netRow}`).alignment = { horizontal: 'right' };
  s2.getRow(netRow).height = 26;

  /* ============================================================
     SHEET 3 · Monthly Detail (role × month, LIVE formulas)
     Each month cell = FTE% × adjusted rate × escalation factor × hours.
     FTE references the Phase Matrix; rate references Setup & Summary;
     escalation references the per-month factor row. Fully auditable.
     ============================================================ */
  const s3 = wb.addWorksheet('Monthly Detail', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    views: [{ showGridLines: false, state: 'frozen', xSplit: 4, ySplit: 7 }],
  });

  // Flatten months in phase order; remember each month's phase + year.
  const monthCols = [];
  byPhase.forEach(bucket => bucket.months.forEach(m => monthCols.push({ m, phaseId: bucket.phase.id })));
  const nMonths = monthCols.length;
  const mCol = (i) => colLetter(5 + i);          // month i → column letter
  const totCol = colLetter(5 + nMonths);          // role-total column

  s3.columns = [
    { width: 26 }, { width: 13 }, { width: 16 }, { width: 11 },
    ...Array(nMonths).fill({ width: 11 }),
    { width: 15 },
  ];

  // Title
  s3.mergeCells(`A1:${totCol}1`);
  s3.getCell('A1').value = 'Monthly Detail · fee by role by month';
  s3.getCell('A1').font = { name: 'Calibri', bold: true, size: 18, color: { argb: NAVY } };
  s3.getRow(1).height = 28;
  s3.mergeCells(`A2:${totCol}2`);
  s3.getCell('A2').value = 'Each cell = FTE% × adjusted rate × escalation factor × hours/month. Click any cell to read the formula.';
  s3.getCell('A2').font = { name: 'Calibri', italic: true, size: 10, color: { argb: STEEL } };

  // Row 4 — phase bands across the month columns
  {
    let ci = 0;
    byPhase.forEach(bucket => {
      const len = bucket.months.length;
      if (!len) return;
      s3.mergeCells(`${mCol(ci)}4:${mCol(ci + len - 1)}4`);
      const c = s3.getCell(`${mCol(ci)}4`);
      c.value = bucket.phase.name;
      c.font = { name: 'Calibri', bold: true, size: 10, color: { argb: NAVY } };
      c.alignment = { horizontal: 'center' };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
      ci += len;
    });
  }

  // Rows 5/6/7 — column headers, year, rate factor
  const hLabel = 5, hYear = 6, hFactor = 7;
  ['Role', 'Tier', 'Resource', 'Adj rate'].forEach((h, i) => {
    const c = s3.getRow(hLabel).getCell(i + 1);
    c.value = h; styleHeader(c, { align: i === 3 ? 'right' : 'left' });
  });
  s3.getCell(`${totCol}${hLabel}`).value = 'Role total';
  styleHeader(s3.getCell(`${totCol}${hLabel}`), { align: 'right' });
  s3.getRow(hLabel).height = 26;

  s3.mergeCells(`A${hYear}:D${hYear}`);
  s3.getCell(`A${hYear}`).value = 'Year →';
  s3.getCell(`A${hYear}`).font = { name: 'Calibri', size: 9, italic: true, color: { argb: STEEL } };
  s3.getCell(`A${hYear}`).alignment = { horizontal: 'right' };
  s3.mergeCells(`A${hFactor}:D${hFactor}`);
  s3.getCell(`A${hFactor}`).value = 'Rate factor (grid) →';
  s3.getCell(`A${hFactor}`).font = { name: 'Calibri', size: 9, italic: true, color: { argb: STEEL } };
  s3.getCell(`A${hFactor}`).alignment = { horizontal: 'right' };

  monthCols.forEach((mc, i) => {
    const col = mCol(i);
    const lc = s3.getCell(`${col}${hLabel}`);
    lc.value = mc.m.label;
    styleHeader(lc, { align: 'center' });
    const yc = s3.getCell(`${col}${hYear}`);
    yc.value = mc.m.year; yc.numFmt = '0';
    yc.font = { name: 'Calibri', size: 9, color: { argb: STEEL }, bold: true };
    yc.alignment = { horizontal: 'center' };
    yc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };
    // Published (unlocked) escalation factor for grid roles, anchored at the
    // catalog base year. Rate Lock is NOT applied here — it deducts once below.
    const fc = s3.getCell(`${col}${hFactor}`);
    fc.value = { formula: `POWER(1+escalation_pct/100, ${mc.m.year}-catalog_base_year)` };
    fc.numFmt = '0.0000';
    fc.font = { name: 'Calibri', size: 9, color: { argb: STEEL }, bold: true };
    fc.alignment = { horizontal: 'center' };
    fc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };
  });

  // Data rows — grouped, each with a per-group subtotal row
  let dr = 8;
  const groupSubRows = [];
  groups.forEach(g => {
    const inGroup = roles.filter(r => r.groupId === g.id);
    if (!inGroup.length) return;
    s3.mergeCells(`A${dr}:${totCol}${dr}`);
    const gh = s3.getCell(`A${dr}`);
    gh.value = '  ' + g.name.toUpperCase();
    gh.font = { name: 'Calibri', bold: true, color: { argb: WHITE }, size: 10 };
    gh.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    dr++;
    const firstRoleRow = dr;
    inGroup.forEach(r => {
      const ratesR = ratesRowByRoleId[r.id];
      const contracted = r.rateSource === 'contracted';
      const tier = S.getTier(r.titleId, r.tierId);
      s3.getCell(`A${dr}`).value = roleLabelRich(r);
      s3.getCell(`A${dr}`).alignment = { vertical: 'middle', wrapText: true };
      s3.getCell(`B${dr}`).value = tier?.label || '';
      s3.getCell(`B${dr}`).font = { name: 'Calibri', size: 10, color: { argb: STEEL } };
      s3.getCell(`C${dr}`).value = r.resource || 'TBD';
      s3.getCell(`C${dr}`).font = { name: 'Calibri', size: 10, color: { argb: STEEL } };
      s3.getCell(`D${dr}`).value = { formula: `'Setup & Summary'!E${ratesR}` };
      s3.getCell(`D${dr}`).numFmt = '"$"#,##0';
      s3.getCell(`D${dr}`).font = { name: 'Calibri', color: { argb: STEEL } };
      s3.getCell(`D${dr}`).alignment = { horizontal: 'right' };
      monthCols.forEach((mc, i) => {
        const col = mCol(i);
        const c = s3.getCell(`${col}${dr}`);
        // FTE: per-month override (literal) else reference the live Phase Matrix FTE cell.
        const mk = mc.m.year + '-' + mc.m.month;
        const hasOverride = r.fteMonthly && r.fteMonthly[mk] != null;
        const fteRef = hasOverride
          ? String(r.fteMonthly[mk] || 0)
          : ((fteCellRef[r.id] && fteCellRef[r.id][mc.phaseId]) || '0');
        if (contracted) {
          // anchor = project start year; published (unlocked) escalation
          c.value = { formula: `${fteRef}/100*D${dr}*POWER(1+escalation_pct/100,${mc.m.year}-project_start_year)*hrs_per_mo` };
        } else {
          c.value = { formula: `${fteRef}/100*D${dr}*${col}$${hFactor}*hrs_per_mo` };
        }
        c.numFmt = '"$"#,##0';
        c.alignment = { horizontal: 'right' };
        const fteVal = hasOverride ? r.fteMonthly[mk] : (r.fte[mc.phaseId] || 0);
        if (!fteVal) c.font = { name: 'Calibri', color: { argb: 'FFC9CCD6' } };
      });
      const tc = s3.getCell(`${totCol}${dr}`);
      tc.value = { formula: `SUM(${mCol(0)}${dr}:${mCol(nMonths - 1)}${dr})` };
      tc.numFmt = '"$"#,##0';
      tc.font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
      tc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };
      tc.alignment = { horizontal: 'right' };
      s3.getRow(dr).height = (r.projectRole && r.projectRole.trim()) ? 28 : 18;
      dr++;
    });
    const lastRoleRow = dr - 1;
    // Per-group subtotal
    s3.mergeCells(`A${dr}:D${dr}`);
    s3.getCell(`A${dr}`).value = '  ' + g.name + ' — subtotal';
    s3.getCell(`A${dr}`).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
    s3.getCell(`A${dr}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };
    s3.getCell(`A${dr}`).alignment = { horizontal: 'right' };
    monthCols.forEach((mc, i) => {
      const col = mCol(i);
      const c = s3.getCell(`${col}${dr}`);
      c.value = { formula: `SUM(${col}${firstRoleRow}:${col}${lastRoleRow})` };
      c.numFmt = '"$"#,##0';
      c.font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };
      c.alignment = { horizontal: 'right' };
    });
    const gtc = s3.getCell(`${totCol}${dr}`);
    gtc.value = { formula: `SUM(${totCol}${firstRoleRow}:${totCol}${lastRoleRow})` };
    gtc.numFmt = '"$"#,##0';
    gtc.font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
    gtc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };
    gtc.alignment = { horizontal: 'right' };
    groupSubRows.push(dr);
    s3.getRow(dr).height = 20;
    dr++;
  });

  // Monthly total (all roles) = sum of the group subtotals
  dr++;
  const monthTotRow = dr;
  s3.mergeCells(`A${monthTotRow}:D${monthTotRow}`);
  s3.getCell(`A${monthTotRow}`).value = 'Monthly total · all roles (gross)';
  s3.getCell(`A${monthTotRow}`).font = { name: 'Calibri', bold: true, color: { argb: WHITE } };
  s3.getCell(`A${monthTotRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  s3.getCell(`A${monthTotRow}`).alignment = { horizontal: 'right' };
  monthCols.forEach((mc, i) => {
    const col = mCol(i);
    const c = s3.getCell(`${col}${monthTotRow}`);
    c.value = { formula: groupSubRows.length ? groupSubRows.map(rw => `${col}${rw}`).join('+') : '0' };
    c.numFmt = '"$"#,##0';
    c.font = { name: 'Calibri', bold: true, color: { argb: WHITE } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    c.alignment = { horizontal: 'right' };
  });
  const grossCell = s3.getCell(`${totCol}${monthTotRow}`);
  grossCell.value = { formula: `SUM(${mCol(0)}${monthTotRow}:${mCol(nMonths - 1)}${monthTotRow})` };
  grossCell.numFmt = '"$"#,##0';
  grossCell.font = { name: 'Calibri', bold: true, color: { argb: YELLOW } };
  grossCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  grossCell.alignment = { horizontal: 'right' };
  s3.getRow(monthTotRow).height = 22;

  // Cumulative row
  dr++;
  const cumRow = dr;
  s3.mergeCells(`A${cumRow}:D${cumRow}`);
  s3.getCell(`A${cumRow}`).value = 'Cumulative →';
  s3.getCell(`A${cumRow}`).font = { name: 'Calibri', italic: true, color: { argb: STEEL } };
  s3.getCell(`A${cumRow}`).alignment = { horizontal: 'right' };
  monthCols.forEach((mc, i) => {
    const col = mCol(i);
    const c = s3.getCell(`${col}${cumRow}`);
    c.value = { formula: i === 0 ? `${col}${monthTotRow}` : `${mCol(i - 1)}${cumRow}+${col}${monthTotRow}` };
    c.numFmt = '"$"#,##0';
    c.font = { name: 'Calibri', size: 9, color: { argb: STEEL } };
    c.alignment = { horizontal: 'right' };
  });

  // Waterfall (gross → net) in the role-total column
  dr += 2;
  const wGross = dr++, wLock = dr++, wDisc = dr++, wNet = dr++;
  const wLabel = (row, text, color) => {
    s3.mergeCells(`A${row}:${colLetter(4 + nMonths)}${row}`);
    const c = s3.getCell(`A${row}`);
    c.value = text;
    c.font = { name: 'Calibri', bold: true, color: { argb: color } };
    c.alignment = { horizontal: 'right' };
  };
  const wVal = (row, formula, color, size) => {
    const c = s3.getCell(`${totCol}${row}`);
    c.value = { formula };
    c.numFmt = '"$"#,##0';
    c.font = { name: 'Calibri', bold: true, color: { argb: color }, size: size || 11 };
    c.alignment = { horizontal: 'right' };
    return c;
  };
  wLabel(wGross, 'Gross fee · sum of all months', NAVY);
  wVal(wGross, `${totCol}${monthTotRow}`, NAVY);
  wLabel(wLock, 'Less Rate Lock credit (×rate_lock)', RED);
  wVal(wLock, `-${S.lockCredit().toFixed(2)}*rate_lock`, RED);
  wLabel(wDisc, 'Less client discount', RED);
  wVal(wDisc, `-${totCol}${wGross}*(discount_pct/100)`, RED);
  s3.mergeCells(`A${wNet}:${colLetter(4 + nMonths)}${wNet}`);
  s3.getCell(`A${wNet}`).value = 'Total proposed fee (net)';
  s3.getCell(`A${wNet}`).font = { name: 'Calibri', bold: true, color: { argb: YELLOW }, size: 13 };
  s3.getCell(`A${wNet}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  s3.getCell(`A${wNet}`).alignment = { horizontal: 'right' };
  const netCell = wVal(wNet, `${totCol}${wGross}+${totCol}${wLock}+${totCol}${wDisc}`, NAVY, 13);
  netCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
  s3.getRow(wNet).height = 26;

  // Fee share / revenue
  const fsX = state.assumptions.feeShare;
  if (fsX && fsX.enabled) {
    const pct = parseFloat(fsX.pct) || 0;
    const fRow = wNet + 1, revRow = wNet + 2;
    wLabel(fRow, `Less ${pct}% fee share · broker`, RED);
    wVal(fRow, `-${totCol}${wNet}*(${pct}/100)`, RED);
    s3.mergeCells(`A${revRow}:${colLetter(4 + nMonths)}${revRow}`);
    s3.getCell(`A${revRow}`).value = 'Revenue · net of fee share';
    s3.getCell(`A${revRow}`).font = { name: 'Calibri', bold: true, color: { argb: WHITE }, size: 12 };
    s3.getCell(`A${revRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL } };
    s3.getCell(`A${revRow}`).alignment = { horizontal: 'right' };
    const rc = wVal(revRow, `${totCol}${wNet}+${totCol}${fRow}`, WHITE, 12);
    rc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL } };
    s3.getRow(revRow).height = 24;
  }

  /* Download */
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safeName = (state.project.name || 'fee-calculator').replace(/[^a-z0-9-_]+/gi, '-');
  a.download = `${safeName}-Fee-Calculator.xlsx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  function colLetter(n) {
    // 1 → A, 26 → Z, 27 → AA
    let s = '';
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }
};
