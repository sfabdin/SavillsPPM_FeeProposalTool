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
    s1.getCell(`A${rn}`).value = title?.name || '—';
    s1.getCell(`A${rn}`).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
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
    s1.getCell(`G${rn}`).value = { formula: `IF(rate_lock=1, F${rn}, E${rn}*POWER(1+escalation_pct/100, ${endYear} - ${anchorRef}))` };
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
    s1.getRow(rn).height = 22;
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
      const unlocked = `(${avgFormulaParts})/${slice.length}`;
      const locked = `POWER(1+escalation_pct/100, project_start_year - catalog_base_year)`;
      r7.getCell(5 + i).value = { formula: `IF(rate_lock=1, ${locked}, ${unlocked})` };
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
      s2.getCell(`A${mrow}`).value = title?.name || '—';
      s2.getCell(`A${mrow}`).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
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
     SHEET 3 · Monthly Schedule (values; computed in JS)
     ============================================================ */
  const s3 = wb.addWorksheet('Monthly Schedule', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
    views: [{ showGridLines: false }],
  });
  const visibleGroups = groups.filter(g => roles.some(r => r.groupId === g.id));
  s3.columns = [
    { width: 26 },
    ...visibleGroups.map(() => ({ width: 16 })),
    { width: 18 },
  ];
  s3.mergeCells(`A1:${colLetter(2 + visibleGroups.length)}1`);
  s3.getCell('A1').value = 'Monthly Fee Schedule';
  s3.getCell('A1').font = { name: 'Calibri', bold: true, size: 18, color: { argb: NAVY } };
  s3.getRow(1).height = 28;

  const flat = state.assumptions.billingMode === 'flatline';
  let mr = 3;
  ['Month', ...visibleGroups.map(g => g.name), flat ? 'Monthly billed' : 'Monthly total'].forEach((h, i) => {
    const c = s3.getRow(mr).getCell(i + 1);
    c.value = h;
    styleHeader(c, { align: i === 0 ? 'left' : 'right' });
  });
  s3.getRow(mr).height = 28;
  mr++;

  // Pre-pass: group gross + month count (needed for flatline distribution).
  let groupGrossPre = {}; let totalGrossPre = 0; let monthCount = 0;
  visibleGroups.forEach(g => groupGrossPre[g.id] = 0);
  byPhase.forEach(bucket => bucket.months.forEach(m => {
    monthCount++;
    visibleGroups.forEach(g => {
      const fee = roles.filter(r => r.groupId === g.id).reduce((s, r) => s + S.monthlyFee(r, m, bucket.phase.id), 0);
      groupGrossPre[g.id] += fee; totalGrossPre += fee;
    });
  }));
  const netVal = S.netTotal();
  const flatMonthly = monthCount ? netVal / monthCount : 0;

  if (flat) {
    s3.mergeCells(`A${mr}:${colLetter(2 + visibleGroups.length)}${mr}`);
    const cap = s3.getCell(`A${mr}`);
    cap.value = `  Flat monthly fee — net total ÷ ${monthCount} month${monthCount === 1 ? '' : 's'}. Resource loading drives the total; billing is levelized.`;
    cap.font = { name: 'Calibri', italic: true, color: { argb: NAVY }, size: 10 };
    cap.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YEL_TINT } };
    mr++;
  }

  let grandTotalsByGroup = {};
  visibleGroups.forEach(g => grandTotalsByGroup[g.id] = 0);
  let grandGross = 0;
  byPhase.forEach(bucket => {
    if (!bucket.months.length) return;
    s3.mergeCells(`A${mr}:${colLetter(2 + visibleGroups.length)}${mr}`);
    const ph = s3.getCell(`A${mr}`);
    ph.value = '  ' + bucket.phase.name + ' · ' + bucket.months.length + ' mo';
    ph.font = { name: 'Calibri', bold: true, color: { argb: NAVY }, size: 10 };
    ph.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
    s3.getRow(mr).height = 20;
    mr++;
    bucket.months.forEach(m => {
      const row = s3.getRow(mr);
      row.getCell(1).value = m.longLabel;
      row.getCell(1).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
      let mTotal = 0;
      visibleGroups.forEach((g, i) => {
        let fee;
        if (flat) {
          const share = totalGrossPre > 0 ? groupGrossPre[g.id] / totalGrossPre : 1 / visibleGroups.length;
          fee = flatMonthly * share;
        } else {
          fee = roles.filter(r => r.groupId === g.id)
            .reduce((s, r) => s + S.monthlyFee(r, m, bucket.phase.id), 0);
        }
        grandTotalsByGroup[g.id] += fee;
        mTotal += fee;
        const c = row.getCell(2 + i);
        c.value = fee;
        c.numFmt = '"$"#,##0';
        c.alignment = { horizontal: 'right' };
      });
      grandGross += mTotal;
      const tc = row.getCell(2 + visibleGroups.length);
      tc.value = mTotal;
      tc.numFmt = '"$"#,##0';
      tc.font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
      tc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YEL_TINT } };
      tc.alignment = { horizontal: 'right' };
      mr++;
    });
  });

  const lockVal = S.lockCredit();
  const discVal = (S.grossTotal ? S.grossTotal() : grandGross) * (state.assumptions.discount / 100);

  if (flat) {
    // Flatline footer: one "Flat monthly fee" row + the net total. Credits are baked in.
    mr++;
    const fmRow = s3.getRow(mr);
    fmRow.getCell(1).value = 'Flat monthly fee';
    fmRow.getCell(1).font = { name: 'Calibri', bold: true, color: { argb: WHITE } };
    fmRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    visibleGroups.forEach((g, i) => {
      const c = fmRow.getCell(2 + i);
      c.value = monthCount ? grandTotalsByGroup[g.id] / monthCount : 0;
      c.numFmt = '"$"#,##0';
      c.font = { name: 'Calibri', bold: true, color: { argb: WHITE } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      c.alignment = { horizontal: 'right' };
    });
    const fmc = fmRow.getCell(2 + visibleGroups.length);
    fmc.value = flatMonthly;
    fmc.numFmt = '"$"#,##0';
    fmc.font = { name: 'Calibri', bold: true, color: { argb: WHITE } };
    fmc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    fmc.alignment = { horizontal: 'right' };
    s3.getRow(mr).height = 22;

    mr++;
    const tot = s3.getRow(mr);
    tot.getCell(1).value = 'Total proposed fee';
    tot.getCell(1).font = { name: 'Calibri', bold: true, color: { argb: NAVY }, size: 13 };
    tot.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
    const totc = tot.getCell(2 + visibleGroups.length);
    totc.value = netVal;
    totc.numFmt = '"$"#,##0';
    totc.font = { name: 'Calibri', bold: true, color: { argb: YELLOW }, size: 13 };
    totc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    totc.alignment = { horizontal: 'right' };
    s3.getRow(mr).height = 26;
    mr = appendFeeShareXlsx(s3, mr, visibleGroups, netVal);
  } else {
    // ----- by-phase footer: gross subtotal, credits, net -----
    mr++;
    const sub = s3.getRow(mr);
    sub.getCell(1).value = 'Gross subtotal';
    sub.getCell(1).font = { name: 'Calibri', bold: true, color: { argb: YELLOW } };
    sub.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    visibleGroups.forEach((g, i) => {
      const c = sub.getCell(2 + i);
      c.value = grandTotalsByGroup[g.id];
      c.numFmt = '"$"#,##0';
      c.font = { name: 'Calibri', bold: true, color: { argb: WHITE } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      c.alignment = { horizontal: 'right' };
    });
    const grtc = sub.getCell(2 + visibleGroups.length);
    grtc.value = grandGross;
    grtc.numFmt = '"$"#,##0';
    grtc.font = { name: 'Calibri', bold: true, color: { argb: WHITE } };
    grtc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    grtc.alignment = { horizontal: 'right' };
    s3.getRow(mr).height = 22;

    if (state.assumptions.rateLock && lockVal > 0.5) {
      mr++;
      const lr = s3.getRow(mr);
      lr.getCell(1).value = 'Less Rate Lock credit';
      lr.getCell(1).font = { name: 'Calibri', bold: true, color: { argb: RED } };
      const lc = lr.getCell(2 + visibleGroups.length);
      lc.value = -lockVal;
      lc.numFmt = '"$"#,##0';
      lc.font = { name: 'Calibri', bold: true, color: { argb: RED } };
      lc.alignment = { horizontal: 'right' };
    }
    if (state.assumptions.discount > 0) {
      mr++;
      const dr = s3.getRow(mr);
      dr.getCell(1).value = `Less ${state.assumptions.discount}% discount`;
      dr.getCell(1).font = { name: 'Calibri', bold: true, color: { argb: RED } };
      const dc = dr.getCell(2 + visibleGroups.length);
      dc.value = -discVal;
      dc.numFmt = '"$"#,##0';
      dc.font = { name: 'Calibri', bold: true, color: { argb: RED } };
      dc.alignment = { horizontal: 'right' };
    }
    mr++;
    const tot = s3.getRow(mr);
    tot.getCell(1).value = 'Total proposed fee';
    tot.getCell(1).font = { name: 'Calibri', bold: true, color: { argb: NAVY }, size: 13 };
    tot.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
    const totc = tot.getCell(2 + visibleGroups.length);
    totc.value = grandGross - lockVal - discVal;
    totc.numFmt = '"$"#,##0';
    totc.font = { name: 'Calibri', bold: true, color: { argb: YELLOW }, size: 13 };
    totc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    totc.alignment = { horizontal: 'right' };
    s3.getRow(mr).height = 26;
    mr = appendFeeShareXlsx(s3, mr, visibleGroups, grandGross - lockVal - discVal);
  }

  /** Append "Less fee share" + "Revenue" rows to the monthly sheet when fee share is on. */
  function appendFeeShareXlsx(sheet, row, vGroups, proposalFee) {
    const fs = state.assumptions.feeShare;
    if (!fs || !fs.enabled) return row;
    const pct = parseFloat(fs.pct) || 0;
    const share = proposalFee * (pct / 100);
    row++;
    const sr = sheet.getRow(row);
    sr.getCell(1).value = `Less ${pct}% fee share · broker`;
    sr.getCell(1).font = { name: 'Calibri', bold: true, color: { argb: RED } };
    const sc = sr.getCell(2 + vGroups.length);
    sc.value = -share; sc.numFmt = '"$"#,##0';
    sc.font = { name: 'Calibri', bold: true, color: { argb: RED } };
    sc.alignment = { horizontal: 'right' };
    row++;
    const rr = sheet.getRow(row);
    rr.getCell(1).value = 'Revenue · net of fee share';
    rr.getCell(1).font = { name: 'Calibri', bold: true, color: { argb: WHITE }, size: 13 };
    rr.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL } };
    const rc = rr.getCell(2 + vGroups.length);
    rc.value = proposalFee - share; rc.numFmt = '"$"#,##0';
    rc.font = { name: 'Calibri', bold: true, color: { argb: WHITE }, size: 13 };
    rc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL } };
    rc.alignment = { horizontal: 'right' };
    sheet.getRow(row).height = 26;
    return row;
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
