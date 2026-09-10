/* ============================================================
   SAVILLS PPM · REVENUE PROJECTIONS WORKBOOK (shared writer)
   ------------------------------------------------------------
   One writer for the projections matrix, so the Revenue Projections
   page's "⤓ Excel" and the Monthly Confirmed Book's per-month
   download produce the same sheet — same columns, same colours,
   same totals rows — from whichever book they are handed.

     const X = window.UFC_ProjectionsXlsx;
     const rows = X.bookRows(records, coIndex, catalog);   // one row per project
     const V    = X.viewFor(rows, [2026, 2027]);            // matrix model
     X.writeProjectionsSheet(wb, V, { title, subtitle });   // the matrix
     X.writeDataSheet(wb, V, { extraHeaders, extra });      // pivotable dump

   The page builds its own V (filters, sort, hidden ratings) and calls the
   writer; the confirmed book builds V from the month's copies with the
   reporting years from the store. Needs ExcelJS loaded (UFC_Vendor.excel()).
   ============================================================ */
(function () {
  'use strict';
  const S = () => window.UFC_Store;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtFull = (n) => (n < 0 ? '-' : '') + '$' + Math.round(Math.abs(n)).toLocaleString();
  const NAVY = 'FF25273A', YEL = 'FFFFDF00', TEAL = 'FF0E7C7B', CREAM = 'FFEEE8E3', STEEL = 'FF79828C', WHITE = 'FFFFFFFF', HAIR = 'FFE2DFDA';
  const RCOL = { 1: 'FF1F8A5B', 2: 'FF3AA95C', 3: 'FFD9A300', 4: 'FFD2691E', 5: STEEL, 6: STEEL, 7: STEEL };

  /** One matrix row per parent project: the monthly invoice map (change
      orders folded into their parent), broker and pass-through maps, rating
      and leaders — the same shape Revenue Projections builds for itself. */
  function bookRows(records, coIndex, catalog) {
    const STORE = S();
    const list = (records || []).filter(p => p && !p._deleted && !(STORE.isChangeOrder && STORE.isChangeOrder(p)));
    return list.map(p => {
      const map = {}, brokerMap = {}, passMap = {};
      let total = 0;
      try {
        (STORE.billingSeries(p, catalog) || []).forEach(s => {
          const k = s.year + '-' + s.month;
          map[k] = (map[k] || 0) + s.invoice;
          brokerMap[k] = (brokerMap[k] || 0) + (s.broker || 0);
          passMap[k] = (passMap[k] || 0) + (s.passCost || 0);
          total += s.invoice;
        });
      } catch (e) { /* an unpriced record has no series */ }
      const cos = coIndex ? (coIndex[p.id] || []) : [];
      cos.forEach(co => {
        try {
          STORE.changeOrderDelta(co).byMonth.forEach(x => {
            const [y, m] = String(x.ym).split('-').map(Number);
            const k = y + '-' + m;
            map[k] = (map[k] || 0) + x.net; total += x.net;
          });
        } catch (e) { /* a CO that cannot be priced adds nothing */ }
      });
      const pj = p.project || {};
      const leaders = [...new Set([pj.leadId || pj.lead, pj.clientRelOwner]
        .map(x => (STORE.leaderDisplay ? STORE.leaderDisplay(x) : (x || '')).trim()).filter(Boolean))];
      const fs = (p.assumptions && p.assumptions.feeShare) || {};
      return { p, pj, rating: STORE.ratingFor(p), map, brokerMap, passMap, total, ov: p.monthlyOverrides || null,
               coCount: cos.length, feeSharePct: fs.enabled ? (parseFloat(fs.pct) || 0) : 0,
               ptCost: (p.financials && p.financials.passThroughCost) || 0,
               status: (pj.status || '').trim(), client: (pj.client || '').trim(), leaders,
               serviceLines: STORE.projectServiceLines ? STORE.projectServiceLines(p) : [],
               industry: (pj.industry || '').trim(), projectType: (pj.projectType || '').trim() };
    });
  }

  /** The matrix model for a set of rows over whole calendar years: month
      columns, totals (rated 1–4), probability-weighted totals (all), and the
      KPI figures for the first year. Rows sorted client, then project. */
  function viewFor(rows, years, opts) {
    const STORE = S(); const o = opts || {};
    const ys = (years && years.length ? years : [new Date().getFullYear()]).map(Number).sort((a, b) => a - b);
    const cols = [];
    ys.forEach(y => { for (let m = 1; m <= 12; m++) cols.push({ y, m, key: y + '-' + m }); });
    const yearsSpan = ys.map(y => ({ y, span: 12 }));
    const sorted = rows.slice().sort((a, b) => (a.client || '').localeCompare(b.client || '') || ((a.pj.name || '').localeCompare(b.pj.name || '')));
    const colTot = {}, colWt = {}; let grandTot = 0, grandWt = 0;
    cols.forEach(c => { colTot[c.key] = 0; colWt[c.key] = 0; });
    sorted.forEach(r => {
      const w = (STORE.ratingMeta(r.rating) || {}).weight || 0;
      cols.forEach(c => {
        const v = r.map[c.key] || 0;
        if (r.rating >= 1 && r.rating <= 4) { colTot[c.key] += v; grandTot += v; }
        colWt[c.key] += v * w; grandWt += v * w;
      });
    });
    const cy = ys[0];
    const yrTotal = (r, y) => cols.filter(c => c.y === y).reduce((a, c) => a + (r.map[c.key] || 0), 0);
    const booked = sorted.filter(r => r.rating === 1).reduce((s, r) => s + yrTotal(r, cy), 0);
    const pipeline14 = sorted.filter(r => r.rating >= 2 && r.rating <= 4).reduce((s, r) => s + yrTotal(r, cy), 0);
    const longshot = sorted.filter(r => r.rating >= 5 && r.rating <= 6).reduce((s, r) => s + yrTotal(r, cy), 0);
    return { rows: sorted, cols, years: yearsSpan, colTot, colWt, grandTot, grandWt, booked, pipeline14, longshot,
             filters: o.filters || {}, showExcluded: o.showExcluded !== false, showClosed: o.showClosed !== false, kpiYear: cy };
  }

  /** The matrix sheet. `V` is the view model above (or the page's own). */
  function writeProjectionsSheet(wb, V, opts) {
    const STORE = S(); const o = opts || {};
    const ws = wb.addWorksheet(o.sheetName || 'Revenue Projections', {
      views: [{ state: 'frozen', xSplit: 1, ySplit: 6 }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    const nCols = V.cols.length;
    const M0 = 5;                            // first month column (1 Client, 2 Project, 3 Rating, 4 Leader)
    const lastCol = M0 + nCols;              // months + total
    ws.getColumn(1).width = 22; ws.getColumn(2).width = 30; ws.getColumn(3).width = 16; ws.getColumn(4).width = 18;
    for (let i = 0; i < nCols; i++) ws.getColumn(M0 + i).width = 10;
    ws.getColumn(lastCol).width = 14;
    const leaderName = (pj) => { const l = STORE.resolveLeader && STORE.resolveLeader(pj.leadId || pj.lead); return l ? l.displayName : (pj.lead || ''); };
    const setMoney = (cell, n, so = {}) => {
      cell.value = n ? n : (so.dash ? '·' : null);
      cell.numFmt = '#,##0.00';
      cell.alignment = { horizontal: 'right' };
      if (so.font) cell.font = so.font;
      if (so.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: so.fill } };
    };

    // ----- Title + subtitle + KPI band (rows 1-4) -----
    ws.mergeCells(1, 1, 1, lastCol);
    const t = ws.getCell('A1');
    t.value = o.title || 'Revenue Projections';
    t.font = { name: 'Calibri', bold: true, size: 18, color: { argb: NAVY } };
    ws.getRow(1).height = 26;
    ws.mergeCells(2, 1, 2, lastCol);
    const sub = ws.getCell('A2');
    sub.value = o.subtitle || (V.rows.length + ' projects · as of ' + new Date().toLocaleDateString());
    sub.font = { name: 'Calibri', italic: true, size: 10, color: { argb: STEEL } };
    const ky = V.kpiYear ? ' · ' + V.kpiYear : '';
    const kpis = [
      ['Booked (rated 1)' + ky, V.booked, NAVY, WHITE],
      ['Pipeline (2–4)' + ky, V.pipeline14, CREAM, NAVY],
      ['Projected total (1–4)', V.grandTot, TEAL, WHITE],
      ['Probability-weighted', V.grandWt, CREAM, NAVY],
    ];
    let kc = 1;
    const kpiSpan = Math.max(2, Math.floor(lastCol / 4));
    kpis.forEach((k, idx) => {
      const c0 = kc, c1 = (idx === 3) ? lastCol : Math.min(lastCol, kc + kpiSpan - 1);
      ws.mergeCells(4, c0, 4, c1);
      const cell = ws.getCell(4, c0);
      cell.value = k[0] + ':  ' + fmtFull(k[1]);
      cell.font = { name: 'Calibri', bold: true, size: 11, color: { argb: k[3] } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: k[2] } };
      cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
      kc = c1 + 1;
    });
    ws.getRow(4).height = 22;

    // ----- Header: year spans (row 5) + months (row 6) -----
    const yearRow = 5, monRow = 6;
    [[1, 'Client'], [2, 'Project · ' + V.rows.length], [3, 'Rating'], [4, 'Revenue Leader']].forEach(([col, label]) => {
      ws.mergeCells(yearRow, col, monRow, col);
      const hc = ws.getCell(yearRow, col);
      hc.value = label;
      hc.font = { name: 'Calibri', bold: true, color: { argb: WHITE } };
      hc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      hc.alignment = { vertical: 'middle' };
    });
    let ci = M0;
    V.years.forEach(yr => {
      ws.mergeCells(yearRow, ci, yearRow, ci + yr.span - 1);
      const yc = ws.getCell(yearRow, ci);
      yc.value = yr.y;
      yc.font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
      yc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YEL } };
      yc.alignment = { horizontal: 'center' };
      ci += yr.span;
    });
    ws.mergeCells(yearRow, lastCol, monRow, lastCol);
    const tc = ws.getCell(yearRow, lastCol);
    tc.value = 'Total';
    tc.font = { name: 'Calibri', bold: true, color: { argb: WHITE } };
    tc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    tc.alignment = { horizontal: 'right', vertical: 'middle' };
    V.cols.forEach((c, i) => {
      const cell = ws.getCell(monRow, M0 + i);
      cell.value = MONTHS[c.m - 1];
      cell.font = { name: 'Calibri', size: 9, bold: true, color: { argb: STEEL } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };
      cell.alignment = { horizontal: 'center' };
    });

    // ----- Body: (rating groups when asked) + project rows -----
    let r = monRow + 1;
    let lastRating = null;
    V.rows.forEach(row => {
      const excluded = row.rating > 4;
      if (excluded && !V.showExcluded) return;
      const meta = STORE.ratingMeta(row.rating);
      if (o.groupByRating && row.rating !== lastRating) {
        lastRating = row.rating;
        ws.mergeCells(r, 1, r, lastCol);
        const g = ws.getCell(r, 1);
        g.value = '  ' + row.rating + ' · ' + meta.label + (excluded ? ' — excluded from totals' : '');
        g.font = { name: 'Calibri', bold: true, size: 10, color: { argb: excluded ? STEEL : NAVY } };
        g.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: excluded ? 'FFF4F4F3' : 'FFF0EFEC' } };
        ws.getRow(r).height = 18;
        r++;
      }
      const pj = row.p.project || {};
      ws.getCell(r, 1).value = pj.client || '';
      ws.getCell(r, 1).font = { name: 'Calibri', size: 10, bold: true, color: { argb: excluded ? STEEL : NAVY } };
      ws.getCell(r, 1).alignment = { vertical: 'middle' };
      ws.getCell(r, 2).value = (pj.name || 'Untitled') + (row.coCount ? '  (incl. ' + row.coCount + ' CO' + (row.coCount === 1 ? '' : 's') + ')' : '');
      ws.getCell(r, 2).font = { name: 'Calibri', size: 11, color: { argb: excluded ? STEEL : NAVY } };
      ws.getCell(r, 3).value = row.rating + ' · ' + (meta.short || meta.label || '') + (STORE.isPlaceholder(row.p) ? ' · ESTIMATE' : '');
      ws.getCell(r, 3).font = { name: 'Calibri', size: 10, color: { argb: RCOL[row.rating] || NAVY }, bold: true };
      if (STORE.isPlaceholder(row.p)) {
        ws.getCell(r, 3).note = 'The dollars on this row were assumed to hold the space, not priced from scope. Counted at full value; treat the amount as an estimate.';
      }
      ws.getCell(r, 4).value = leaderName(pj);
      ws.getCell(r, 4).font = { name: 'Calibri', size: 10, color: { argb: STEEL } };
      let rvt = 0;
      V.cols.forEach((c, i) => {
        const v = row.map[c.key] || 0; rvt += v;
        const isOv = row.ov && row.ov[c.key] != null;
        setMoney(ws.getCell(r, M0 + i), v, { dash: true, font: { name: 'Calibri', size: 10, color: { argb: isOv ? TEAL : (excluded ? STEEL : NAVY) }, bold: !!isOv } });
      });
      setMoney(ws.getCell(r, lastCol), rvt, { font: { name: 'Calibri', bold: true, color: { argb: RCOL[row.rating] || NAVY } } });
      r++;
    });

    // ----- Totals rows -----
    const totRow = r + 1;
    ws.mergeCells(totRow, 1, totRow, 4);
    ws.getCell(totRow, 1).value = 'Projected (rated 1–4)';
    ws.getCell(totRow, 1).font = { name: 'Calibri', bold: true, color: { argb: WHITE } };
    ws.getCell(totRow, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    [2, 3, 4].forEach(cc => { ws.getCell(totRow, cc).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; });
    V.cols.forEach((c, i) => setMoney(ws.getCell(totRow, M0 + i), V.colTot[c.key], { dash: true, font: { name: 'Calibri', bold: true, color: { argb: WHITE } }, fill: NAVY }));
    setMoney(ws.getCell(totRow, lastCol), V.grandTot, { font: { name: 'Calibri', bold: true, color: { argb: YEL } }, fill: NAVY });
    ws.getRow(totRow).height = 20;

    const wtRow = totRow + 1;
    ws.mergeCells(wtRow, 1, wtRow, 4);
    ws.getCell(wtRow, 1).value = 'Probability-weighted (all)';
    ws.getCell(wtRow, 1).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
    ws.getCell(wtRow, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };
    [2, 3, 4].forEach(cc => { ws.getCell(wtRow, cc).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } }; });
    V.cols.forEach((c, i) => setMoney(ws.getCell(wtRow, M0 + i), V.colWt[c.key], { dash: true, font: { name: 'Calibri', color: { argb: NAVY } }, fill: CREAM }));
    setMoney(ws.getCell(wtRow, lastCol), V.grandWt, { font: { name: 'Calibri', bold: true, color: { argb: NAVY } }, fill: CREAM });

    for (let rr = yearRow; rr <= wtRow; rr++) for (let cc = 1; cc <= lastCol; cc++) {
      ws.getCell(rr, cc).border = { bottom: { style: 'thin', color: { argb: HAIR } }, right: { style: 'thin', color: { argb: HAIR } } };
    }
    return ws;
  }

  /** The flat dump: one row per project × month with revenue, every
      dimension a pivot table could want alongside it. */
  function writeDataSheet(wb, V, opts) {
    const STORE = S(); const o = opts || {};
    const ws = wb.addWorksheet(o.sheetName || 'Data', { views: [{ state: 'frozen', ySplit: 1 }] });
    const headers = ['Client', 'Project', 'Project ID', 'Revenue leader', 'Relationship owner', 'Status', 'Rating', 'Rating label', 'Confidence',
      'Industry', 'Project type', 'Service line', 'Year', 'Month', 'Month #', 'Period', 'Revenue', 'Broker fee', 'Pass-through cost', 'Weighted revenue', 'Overridden']
      .concat(o.extraHeaders || []);
    const widths = [24, 34, 14, 20, 20, 14, 8, 14, 11, 18, 22, 18, 7, 7, 8, 9, 14, 12, 16, 16, 11].concat((o.extraHeaders || []).map(() => 20));
    headers.forEach((h, i) => {
      const c = ws.getCell(1, i + 1);
      c.value = h; c.font = { name: 'Calibri', bold: true, color: { argb: WHITE } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      ws.getColumn(i + 1).width = widths[i] || 14;
    });
    const money = (cell) => { cell.numFmt = '#,##0.00'; cell.alignment = { horizontal: 'right' }; };
    let r = 2;
    V.rows.forEach(row => {
      const pj = row.pj || row.p.project || {};
      const meta = STORE.ratingMeta(row.rating) || {};
      const lead = STORE.resolveLeader && STORE.resolveLeader(pj.leadId || pj.lead);
      const owner = STORE.resolveLeader && STORE.resolveLeader(pj.clientRelOwner);
      const extra = o.extra ? (o.extra(row) || []) : [];
      V.cols.forEach(c => {
        const v = row.map[c.key] || 0;
        const b = (row.brokerMap && row.brokerMap[c.key]) || 0;
        const pt = (row.passMap && row.passMap[c.key]) || 0;
        if (!v && !b && !pt) return;
        const vals = [pj.client || '', pj.name || 'Untitled', pj.projectNumber || pj.projectId365 || pj.salesforceId || row.p.id,
          lead ? lead.displayName : (pj.lead || ''), owner ? owner.displayName : (pj.clientRelOwner || ''),
          (STORE.STATUS_LABELS && STORE.STATUS_LABELS[pj.status]) || pj.status || '', row.rating, meta.label || '', meta.weight || 0,
          pj.industry || '', pj.projectType || '', (row.serviceLines || []).join('; '),
          c.y, MONTHS[c.m - 1], c.m, MONTHS[c.m - 1] + '-' + String(c.y).slice(2),
          v, b, pt, v * (meta.weight || 0), (row.ov && row.ov[c.key] != null) ? 'Yes' : ''].concat(extra);
        const xr = ws.addRow(vals);
        [17, 18, 19, 20].forEach(i => money(xr.getCell(i)));
        xr.getCell(9).numFmt = '0%';
        r++;
      });
    });
    ws.autoFilter = { from: 'A1', to: String.fromCharCode(64 + Math.min(headers.length, 26)) + String(Math.max(r - 1, 1)) };
    if (headers.length > 26) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(r - 1, 1), column: headers.length } };
    return ws;
  }

  async function download(wb, filename) {
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  window.UFC_ProjectionsXlsx = { bookRows, viewFor, writeProjectionsSheet, writeDataSheet, download, MONTHS };
})();
