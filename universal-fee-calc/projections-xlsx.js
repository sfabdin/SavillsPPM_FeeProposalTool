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
      const map = {}, brokerMap = {}, passMap = {}, netMap = {}, passClientMap = {};
      let total = 0;
      try {
        (STORE.billingSeries(p, catalog) || []).forEach(s => {
          const k = s.year + '-' + s.month;
          map[k] = (map[k] || 0) + s.invoice;
          netMap[k] = (netMap[k] || 0) + (s.net || 0);
          brokerMap[k] = (brokerMap[k] || 0) + (s.broker || 0);
          passMap[k] = (passMap[k] || 0) + (s.passCost || 0);
          passClientMap[k] = (passClientMap[k] || 0) + (s.passClient || 0);
          total += s.invoice;
        });
      } catch (e) { /* an unpriced record has no series */ }
      const cos = coIndex ? (coIndex[p.id] || []) : [];
      cos.forEach(co => {
        try {
          STORE.changeOrderDelta(co).byMonth.forEach(x => {
            const [y, m] = String(x.ym).split('-').map(Number);
            const k = y + '-' + m;
            map[k] = (map[k] || 0) + x.net; netMap[k] = (netMap[k] || 0) + x.net; total += x.net;
          });
        } catch (e) { /* a CO that cannot be priced adds nothing */ }
      });
      const pj = p.project || {};
      const leaders = [...new Set([pj.leadId || pj.lead, pj.clientRelOwner]
        .map(x => (STORE.leaderDisplay ? STORE.leaderDisplay(x) : (x || '')).trim()).filter(Boolean))];
      const fs = (p.assumptions && p.assumptions.feeShare) || {};
      let ptLines = []; try { ptLines = STORE.passThroughLines ? STORE.passThroughLines(p) : []; } catch (e) { ptLines = []; }
      return { p, pj, rating: STORE.ratingFor(p), map, brokerMap, passMap, netMap, passClientMap, ptLines, total, ov: p.monthlyOverrides || null,
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
    const colL = (n) => { let sN = ''; while (n > 0) { const r = (n - 1) % 26; sN = String.fromCharCode(65 + r) + sN; n = Math.floor((n - 1) / 26); } return sN; };
    const numFmt = '#,##0.00;[Red]-#,##0.00;"·"';
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
    let firstBody = null, lastBody = null;
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
      // Row total is a live SUM so a corrected month carries to the total.
      const tcell = ws.getCell(r, lastCol);
      tcell.value = { formula: `SUM(${colL(M0)}${r}:${colL(lastCol - 1)}${r})`, result: Math.round(rvt * 100) / 100 };
      tcell.numFmt = numFmt; tcell.alignment = { horizontal: 'right' };
      tcell.font = { name: 'Calibri', bold: true, color: { argb: RCOL[row.rating] || NAVY } };
      if (firstBody == null) firstBody = r;
      lastBody = r;
      r++;
    });

    // ----- Totals rows: one per rating 1–4, the 1–4 subtotal, the weighted
    // total — every one a live formula over the rows above (SUMIF on the
    // rating column), with the value cached for viewers that do not calc.
    const bodyFrom = firstBody == null ? monRow + 1 : firstBody, bodyTo = lastBody == null ? monRow + 1 : lastBody;
    const ratingCol = colL(3);
    const ratingSum = (n, c) => `SUMIF($${ratingCol}$${bodyFrom}:$${ratingCol}$${bodyTo},"${n} ·*",${colL(c)}${bodyFrom}:${colL(c)}${bodyTo})`;
    const ratingVal = (n, key) => V.rows.reduce((t, rw) => (rw.rating === n && (V.showExcluded || rw.rating <= 4)) ? t + (rw.map[key] || 0) : t, 0);
    const r2 = (n) => Math.round(n * 100) / 100;
    const styleRow = (rr, fill, color, bold) => {
      ws.mergeCells(rr, 1, rr, 4);
      ws.getCell(rr, 1).font = { name: 'Calibri', bold: !!bold, color: { argb: color } };
      for (let cc = 1; cc <= lastCol; cc++) ws.getCell(rr, cc).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    };
    const putF = (rr, cc, formula, result, color, bold) => {
      const cell = ws.getCell(rr, cc);
      cell.value = { formula, result: r2(result) };
      cell.numFmt = numFmt; cell.alignment = { horizontal: 'right' };
      cell.font = { name: 'Calibri', bold: !!bold, color: { argb: color } };
    };
    let rr = r + 1;
    const ratingRows = {};
    [1, 2, 3, 4].forEach(n => {
      const meta = STORE.ratingMeta(n) || {};
      ws.getCell(rr, 1).value = 'Total · ' + n + ' ' + (meta.label || '');
      styleRow(rr, 'FFF4F4F3', RCOL[n] || NAVY, true);
      V.cols.forEach((c, i) => putF(rr, M0 + i, ratingSum(n, M0 + i), ratingVal(n, c.key), NAVY, false));
      putF(rr, lastCol, `SUM(${colL(M0)}${rr}:${colL(lastCol - 1)}${rr})`, V.cols.reduce((t, c) => t + ratingVal(n, c.key), 0), RCOL[n] || NAVY, true);
      ratingRows[n] = rr; rr++;
    });
    const totRow = rr;
    ws.getCell(totRow, 1).value = 'Projected (rated 1–4)';
    styleRow(totRow, NAVY, WHITE, true);
    V.cols.forEach((c, i) => putF(totRow, M0 + i, [1, 2, 3, 4].map(n => `${colL(M0 + i)}${ratingRows[n]}`).join('+'), V.colTot[c.key], WHITE, true));
    putF(totRow, lastCol, `SUM(${colL(M0)}${totRow}:${colL(lastCol - 1)}${totRow})`, V.grandTot, YEL, true);
    ws.getRow(totRow).height = 20;

    const wtRow = totRow + 1;
    ws.getCell(wtRow, 1).value = 'Probability-weighted (all)';
    styleRow(wtRow, CREAM, NAVY, true);
    const weights = [1, 2, 3, 4, 5, 6, 7].map(n => ((STORE.ratingMeta(n) || {}).weight || 0));
    V.cols.forEach((c, i) => {
      const f = [1, 2, 3, 4, 5, 6, 7].filter(n => weights[n - 1]).map(n => `${weights[n - 1]}*${ratingSum(n, M0 + i)}`).join('+') || '0';
      putF(wtRow, M0 + i, f, V.colWt[c.key], NAVY, false);
    });
    putF(wtRow, lastCol, `SUM(${colL(M0)}${wtRow}:${colL(lastCol - 1)}${wtRow})`, V.grandWt, NAVY, true);

    // ----- Focus window: the current month and the two before it stay open;
    // every other month is grouped and collapsed — one click on the + above
    // the columns brings the full year back. The totals still cover every month.
    if (o.focus !== false) {
      const now = new Date(); const cur = now.getFullYear() * 12 + now.getMonth();
      const idxOf = (c) => c.y * 12 + (c.m - 1);
      const inWindow = (c) => { const d = cur - idxOf(c); return d >= 0 && d <= 2; };
      if (V.cols.some(inWindow)) {
        V.cols.forEach((c, i) => { if (!inWindow(c)) { const col = ws.getColumn(M0 + i); col.outlineLevel = 1; col.hidden = true; } });
        ws.properties.outlineProperties = { summaryRight: false, summaryBelow: false };
        const open = V.cols.filter(inWindow).map(c => MONTHS[c.m - 1] + ' ' + c.y);
        const sub = ws.getCell('A2');
        sub.value = (sub.value || '') + '  ·  showing ' + open[0] + ' – ' + open[open.length - 1] + '; other months are collapsed — click the + above the columns to expand';
      }
    }

    for (let rr = yearRow; rr <= wtRow; rr++) for (let cc = 1; cc <= lastCol; cc++) {
      ws.getCell(rr, cc).border = { bottom: { style: 'thin', color: { argb: HAIR } }, right: { style: 'thin', color: { argb: HAIR } } };
    }
    return ws;
  }

  /* ---------- The lines behind one project-month ----------
     What the client is billed, and what comes out of it, as SIGNED
     stand-alone lines so a pivot on Amount reads as a bridge:

         Fee billed              +   the fee invoiced (broker on top included)
         Pass-through billed     +   vendor cost + fee, invoiced through Savills
       = Total billed to client
         Broker fee share        −   the referral cut (either mode)
         Pass-through cost       −   the vendor cost that flows straight out
       = Savills revenue

     Rows built by the Revenue Projections page carry the same maps as
     bookRows; a row without them (an older caller) falls back to the invoice
     as the fee so nothing is silently lost. */
  const LINES = [
    { line: 'Fee billed',          group: 'Billed to client', sign: +1 },
    { line: 'Pass-through billed', group: 'Billed to client', sign: +1 },
    { line: 'Broker fee share',    group: 'Deduction',        sign: -1 },
    { line: 'Pass-through cost',   group: 'Deduction',        sign: -1 },
  ];
  /** Who receives the fee share — typed on the calculator beside the %. */
  function brokerOf(row) {
    const fs = (row.p && row.p.assumptions && row.p.assumptions.feeShare) || {};
    return fs.enabled ? String(fs.broker || '').trim() : '';
  }
  function linesFor(row, key) {
    const inv = (row.map && row.map[key]) || 0;
    const passClient = (row.passClientMap && row.passClientMap[key]) || 0;
    const broker = (row.brokerMap && row.brokerMap[key]) || 0;
    const passCost = (row.passMap && row.passMap[key]) || 0;
    const out = [];
    const push = (i, v, party) => { if (Math.abs(v) > 0.005) out.push({ line: LINES[i].line, group: LINES[i].group, amount: LINES[i].sign * v, party: party || '' }); };
    push(0, inv - passClient, '');
    // Pass-through: one line per line on the calculator, named as typed there —
    // "Pass-through · Unity Electric", "Pass-through · Dallas PM fee share" —
    // so the party is visible whether it is a vendor or a fee share.
    const lines = row.ptLines || [];
    if (lines.length) {
      lines.forEach(L => {
        const party = 'Pass-through · ' + (L.label || 'line');
        push(1, (L.client && L.client[key]) || 0, party);
        push(3, (L.cost && L.cost[key]) || 0, party);
      });
    } else {
      push(1, passClient, 'Pass-through');
      push(3, passCost, 'Pass-through');
    }
    push(2, broker, brokerOf(row) || 'Broker');
    return out;
  }

  /** The flat dump: one row per project × month × line, every dimension a
      pivot table could want alongside it. Amount is signed (see LINES), so
      a pivot summing Amount by Line is the revenue bridge, and by Line group
      splits what the client is billed from what flows out. */
  const DATA_HEADERS = ['Client', 'Project', 'Project ID', 'Revenue leader', 'Relationship owner', 'Status', 'Rating', 'Rating label', 'Confidence',
    'Industry', 'Project type', 'Service line', 'Party', 'Year', 'Month', 'Month #', 'Period', 'Line', 'Line group', 'Amount', 'Weighted amount', 'Overridden'];
  const DC = {};   // header → column letter, for the dashboard's SUMIFS
  DATA_HEADERS.forEach((h, i) => { DC[h] = String.fromCharCode(65 + i); });
  function writeDataSheet(wb, V, opts) {
    const STORE = S(); const o = opts || {};
    const ws = wb.addWorksheet(o.sheetName || 'Data', { views: [{ state: 'frozen', ySplit: 1 }] });
    const headers = DATA_HEADERS.concat(o.extraHeaders || []);
    const widths = [24, 34, 14, 20, 20, 14, 8, 14, 11, 18, 22, 18, 20, 7, 7, 8, 9, 20, 16, 14, 16, 11].concat((o.extraHeaders || []).map(() => 20));
    headers.forEach((h, i) => {
      const c = ws.getCell(1, i + 1);
      c.value = h; c.font = { name: 'Calibri', bold: true, color: { argb: WHITE } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      ws.getColumn(i + 1).width = widths[i] || 14;
    });
    const money = (cell) => { cell.numFmt = '#,##0.00;[Red]-#,##0.00'; cell.alignment = { horizontal: 'right' }; };
    let r = 2;
    V.rows.forEach(row => {
      const pj = row.pj || row.p.project || {};
      const meta = STORE.ratingMeta(row.rating) || {};
      const lead = STORE.resolveLeader && STORE.resolveLeader(pj.leadId || pj.lead);
      const owner = STORE.resolveLeader && STORE.resolveLeader(pj.clientRelOwner);
      const extra = o.extra ? (o.extra(row) || []) : [];
      const dims = [pj.client || '', pj.name || 'Untitled', pj.projectNumber || pj.projectId365 || pj.salesforceId || row.p.id,
        lead ? lead.displayName : (pj.lead || ''), owner ? owner.displayName : (pj.clientRelOwner || ''),
        (STORE.STATUS_LABELS && STORE.STATUS_LABELS[pj.status]) || pj.status || '', row.rating, meta.label || '', meta.weight || 0,
        pj.industry || '', pj.projectType || '', (row.serviceLines || []).join('; ')];
      V.cols.forEach(c => {
        const lines = linesFor(row, c.key);
        if (!lines.length) return;
        const ov = (row.ov && row.ov[c.key] != null) ? 'Yes' : '';
        lines.forEach(L => {
          const xr = ws.addRow(dims.concat([L.party || '', c.y, MONTHS[c.m - 1], c.m, MONTHS[c.m - 1] + '-' + String(c.y).slice(2),
            L.line, L.group, L.amount, L.amount * (meta.weight || 0), ov], extra));
          money(xr.getCell(20)); money(xr.getCell(21));
          xr.getCell(9).numFmt = '0%';
          if (L.amount < 0) xr.getCell(20).font = { name: 'Calibri', color: { argb: 'FFCE181E' } };
          r++;
        });
      });
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(r - 1, 1), column: headers.length } };
    ws.__lastRow = Math.max(r - 1, 1);
    return ws;
  }

  /** A dashboard that is nothing but SUMIFS over the Data sheet: the
      revenue bridge by year, then the same bridge by month, revenue leader,
      client and rating. Every figure is a live formula (Excel recalculates
      on open) with the number also cached, so the sheet reads in any viewer
      and keeps following the Data sheet if someone filters or edits it. The
      rating ceiling in one cell drives every table but the weighted column,
      the way the matrix counts rated 1–4 and weights all. */
  function writeDashboardSheet(wb, V, opts) {
    const STORE = S(); const o = opts || {};
    const data = o.dataSheet || 'Data';
    const N = Math.max(o.dataRows || 2, 2);
    const ws = wb.addWorksheet(o.sheetName || 'Dashboard', { views: [{ showGridLines: false }] });
    ws.getColumn(1).width = 30; for (let c = 2; c <= 10; c++) ws.getColumn(c).width = 16;
    const rng = (h) => `${data}!$${DC[h]}$2:$${DC[h]}$${N}`;
    const CEIL = '$C$4';
    const bridge = [
      { label: 'Fee billed',              line: 'Fee billed' },
      { label: 'Pass-through billed',     line: 'Pass-through billed' },
      { label: 'Total billed to client',  sum: [0, 1], bold: true },
      { label: 'Broker fee share',        line: 'Broker fee share' },
      { label: 'Pass-through cost',       line: 'Pass-through cost' },
      { label: 'Savills revenue',         sum: [2, 3, 4], bold: true, fill: YEL },
      { label: 'Probability-weighted revenue', weighted: true },
    ];
    // ---- the JS side of every formula, so the cached value is right ----
    let ceiling = 4;
    const rowsIn = V.rows;
    const val = (crit) => {   // crit: { line?, year?, key?, leader?, client?, rating?, weighted?, allRatings? }
      let t = 0;
      rowsIn.forEach(row => {
        const meta = STORE.ratingMeta(row.rating) || {};
        if (!crit.weighted && !crit.allRatings && !(row.rating <= ceiling)) return;
        if (crit.rating != null && row.rating !== crit.rating) return;
        if (crit.client != null && (row.client || '') !== crit.client) return;
        if (crit.leader != null && leaderOf(row) !== crit.leader) return;

        V.cols.forEach(c => {
          if (crit.year != null && c.y !== crit.year) return;
          if (crit.key != null && c.key !== crit.key) return;
          linesFor(row, c.key).forEach(L => {
            if (crit.line && L.line !== crit.line) return;
            if (crit.party != null && (L.party || '') !== crit.party) return;
            t += crit.weighted ? L.amount * (meta.weight || 0) : L.amount;
          });
        });
      });
      return Math.round(t * 100) / 100;
    };
    const leaderOf = (row) => { const pj = row.pj || row.p.project || {}; const l = STORE.resolveLeader && STORE.resolveLeader(pj.leadId || pj.lead); return l ? l.displayName : (pj.lead || ''); };
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    // ---- the Excel side ----
    const sumifs = (crit) => {
      const col = crit.weighted ? 'Weighted amount' : 'Amount';
      const parts = [rng(col)];
      if (crit.line) parts.push(rng('Line'), q(crit.line));
      if (!crit.weighted && !crit.allRatings) parts.push(rng('Rating'), '"<="&' + CEIL);
      if (crit.rating != null) parts.push(rng('Rating'), crit.rating);
      if (crit.year != null) parts.push(rng('Year'), crit.year);
      if (crit.key != null) { const [y, m] = crit.key.split('-').map(Number); parts.push(rng('Year'), y, rng('Month #'), m); }
      if (crit.client != null) parts.push(rng('Client'), q(crit.client));
      if (crit.leader != null) parts.push(rng('Revenue leader'), q(crit.leader));
      if (crit.party != null) parts.push(rng('Party'), q(crit.party));
      return 'SUMIFS(' + parts.join(',') + ')';
    };
    const put = (r, c, crit, style) => {
      const cell = ws.getCell(r, c);
      cell.value = { formula: sumifs(crit), result: val(crit) };
      cell.numFmt = '#,##0;[Red]-#,##0;"·"';
      cell.alignment = { horizontal: 'right' };
      Object.assign(cell, style || {});
      return cell;
    };
    const head = (r, labels, fill) => labels.forEach((t, i) => {
      const cell = ws.getCell(r, i + 1);
      cell.value = t; cell.font = { name: 'Calibri', bold: true, color: { argb: WHITE } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill || NAVY } };
      cell.alignment = { horizontal: i ? 'right' : 'left' };
    });
    const section = (r, title, note) => {
      ws.getCell(r, 1).value = title; ws.getCell(r, 1).font = { name: 'Calibri', bold: true, size: 13, color: { argb: NAVY } };
      if (note) { ws.getCell(r, 2).value = note; ws.getCell(r, 2).font = { name: 'Calibri', italic: true, size: 9, color: { argb: STEEL } }; ws.getCell(r, 2).alignment = { horizontal: 'left' }; }
      ws.getRow(r).height = 20;
    };

    ws.getCell('A1').value = o.title || 'Dashboard';
    ws.getCell('A1').font = { name: 'Calibri', bold: true, size: 18, color: { argb: NAVY } };
    ws.getCell('A2').value = 'Every figure here is a SUMIFS over the Data sheet — filter or correct a row there and these tables follow. Pivot the Data sheet for anything not shown.';
    ws.getCell('A2').font = { name: 'Calibri', italic: true, size: 10, color: { argb: STEEL } };
    ws.getCell('A4').value = 'Count ratings up to'; ws.getCell('A4').font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
    ws.getCell('B4').value = '(1 = booked … 4 = pipeline; 7 = everything)'; ws.getCell('B4').font = { name: 'Calibri', italic: true, size: 9, color: { argb: STEEL } };
    ws.getCell('C4').value = ceiling; ws.getCell('C4').font = { name: 'Calibri', bold: true, size: 12, color: { argb: NAVY } };
    ws.getCell('C4').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YEL } }; ws.getCell('C4').alignment = { horizontal: 'center' };
    ws.getCell('C4').dataValidation = { type: 'whole', operator: 'between', formulae: [1, 7], showErrorMessage: true, errorTitle: 'Rating', error: 'A rating from 1 to 7.' };

    const years = V.years.map(y => y.y);
    // ---- 1. bridge by year ----
    let r = 6;
    section(r, 'Savills revenue bridge', 'what the client is billed, less what flows out'); r++;
    head(r, ['', ...years, 'Total']); r++;
    const bridgeRows = {};
    bridge.forEach((b, bi) => {
      ws.getCell(r, 1).value = b.label;
      ws.getCell(r, 1).font = { name: 'Calibri', bold: !!b.bold, color: { argb: NAVY } };
      const cols = years.length + 1;
      for (let i = 0; i < cols; i++) {
        const c = 2 + i, year = i < years.length ? years[i] : null;
        const style = { font: { name: 'Calibri', bold: !!b.bold, color: { argb: NAVY } } };
        if (b.fill) style.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: b.fill } };
        if (b.sum) {
          const cell = ws.getCell(r, c);
          const refs = b.sum.map(j => ws.getCell(bridgeRows[j], c));
          cell.value = { formula: refs.map(x => x.address).join('+'), result: Math.round(refs.reduce((t, x) => t + ((x.value && x.value.result) || 0), 0) * 100) / 100 };
          cell.numFmt = '#,##0;[Red]-#,##0;"·"'; cell.alignment = { horizontal: 'right' }; Object.assign(cell, style);
          cell.border = { top: { style: 'thin', color: { argb: NAVY } } };
        } else {
          const crit = b.weighted ? { weighted: true } : { line: b.line };
          if (year != null) crit.year = year;
          put(r, c, crit, style);
        }
      }
      bridgeRows[bi] = r; r++;
    });
    r += 2;

    // ---- shared bridge-table writer for a dimension ----
    const COLS = ['Fee billed', 'Pass-through billed', 'Total billed', 'Broker fee share', 'Pass-through cost', 'Savills revenue', 'Weighted revenue'];
    const table = (title, note, items, critOf) => {
      section(r, title, note); r++;
      head(r, [title.replace(/^By /, ''), ...COLS], NAVY); r++;
      const r0 = r;
      items.forEach(it => {
        ws.getCell(r, 1).value = it.label; ws.getCell(r, 1).font = { name: 'Calibri', color: { argb: NAVY } };
        const base = critOf(it);
        put(r, 2, Object.assign({ line: 'Fee billed' }, base));
        put(r, 3, Object.assign({ line: 'Pass-through billed' }, base));
        ws.getCell(r, 4).value = { formula: `B${r}+C${r}`, result: Math.round((val(Object.assign({ line: 'Fee billed' }, base)) + val(Object.assign({ line: 'Pass-through billed' }, base))) * 100) / 100 };
        put(r, 5, Object.assign({ line: 'Broker fee share' }, base));
        put(r, 6, Object.assign({ line: 'Pass-through cost' }, base));
        ws.getCell(r, 7).value = { formula: `D${r}+E${r}+F${r}`, result: val(base) };
        put(r, 8, Object.assign({ weighted: true }, base));
        [4, 7].forEach(c => { const cell = ws.getCell(r, c); cell.numFmt = '#,##0;[Red]-#,##0;"·"'; cell.alignment = { horizontal: 'right' }; cell.font = { name: 'Calibri', bold: true, color: { argb: NAVY } }; });
        r++;
      });
      // totals
      ws.getCell(r, 1).value = 'Total'; ws.getCell(r, 1).font = { name: 'Calibri', bold: true, color: { argb: WHITE } };
      ws.getCell(r, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      for (let c = 2; c <= 8; c++) {
        const L = String.fromCharCode(64 + c);
        const cell = ws.getCell(r, c);
        let tot = 0; for (let rr = r0; rr < r; rr++) { const v = ws.getCell(rr, c).value; tot += (v && v.result) || 0; }
        cell.value = { formula: `SUM(${L}${r0}:${L}${r - 1})`, result: Math.round(tot * 100) / 100 };
        cell.numFmt = '#,##0;[Red]-#,##0;"·"'; cell.alignment = { horizontal: 'right' };
        cell.font = { name: 'Calibri', bold: true, color: { argb: c === 7 ? YEL : WHITE } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      }
      r += 3;
    };
    const uniq = (arr) => [...new Set(arr)].filter(Boolean).sort((a, b) => a.localeCompare(b));
    table('By month', 'every month of the reporting years', V.cols.map(c => ({ label: MONTHS[c.m - 1] + ' ' + c.y, key: c.key })), it => ({ key: it.key }));
    table('By revenue leader', 'the lead on the project', uniq(rowsIn.map(leaderOf)).map(l => ({ label: l, leader: l })), it => ({ leader: it.leader }));
    table('By client', '', uniq(rowsIn.map(rw => rw.client || '')).map(cl => ({ label: cl, client: cl })), it => ({ client: it.client }));
    const parties = uniq(rowsIn.flatMap(rw => V.cols.flatMap(c => linesFor(rw, c.key).map(L => L.party))));
    if (parties.length) table('By party', 'each pass-through line as named on the calculator, and each broker', parties.map(b => ({ label: b, party: b })), it => ({ party: it.party }));
    table('By rating', 'ignores the ceiling — every rating on its own row', [1, 2, 3, 4, 5, 6, 7].map(n => ({ label: n + ' · ' + ((STORE.ratingMeta(n) || {}).label || ''), rating: n })), it => ({ rating: it.rating, allRatings: true }));
    if (wb.calcProperties) wb.calcProperties.fullCalcOnLoad = true; else wb.calcProperties = { fullCalcOnLoad: true };
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

  window.UFC_ProjectionsXlsx = { bookRows, viewFor, writeProjectionsSheet, writeDataSheet, writeDashboardSheet, linesFor, brokerOf, download, MONTHS, DATA_HEADERS };
})();
