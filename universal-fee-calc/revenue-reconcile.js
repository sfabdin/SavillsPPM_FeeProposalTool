/* ============================================================
   SAVILLS PPM · REVENUE RECONCILIATION  (admin / finance only)
   ------------------------------------------------------------
   The other half of Revenue Projections. Projections say what a
   project SHOULD bill; this page takes what Finance actually
   invoiced and accrued, lays the two side by side per project per
   month, and lets a human put a billing status on every figure.

   ONE UPLOAD IS A YEAR, NOT A MONTH
     Finance's book is a running year-to-date sheet: the "YTD July
     2026" tab already carries January through July in its monthly
     columns. So one upload lands the whole year to date, and next
     month's tab refreshes it in place. The accrual column states a
     single balance — the one at that tab's close date — so accruals
     are recorded only for the close month each tab actually knows
     about, never interpolated across the months between.

   THE GRID IS THE POINT
     Rows are projects, columns are months, and the unit of work is
     the CELL, because that is the grain at which the question gets
     asked: this project, this month, did it bill, was it accrued,
     did it slip, was it never forecast? Each cell carries a billing
     status and a variance against the project's own fee record.

   FEE SHARES
     Carried as their own rows in the book, named for it ("HOFFMAN
     FEE SHARE"). They stay separate lines, indented under the
     project they come out of, because the invoice really did go out
     gross. Two things the book teaches that the obvious
     implementation gets wrong: a fee share is SIGNED, not always a
     deduction (a reversal of a prior-period share shows as a
     positive month), and it must be identified by project NAME only
     — Finance's Comments column discusses fee shares on rows that
     are ordinary projects, and classifying on that pulls real
     billings out of revenue.
   ============================================================ */
(function () {
  'use strict';
  const STORE = window.UFC_Store;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => (n == null || isNaN(n)) ? '—' : (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString();
  const compact = (n) => {
    if (n == null || isNaN(n)) return '—';
    const a = Math.abs(n);
    const s = a >= 1e6 ? '$' + (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? '$' + Math.round(a / 1e3) + 'K' : '$' + Math.round(a);
    return (n < 0 ? '−' : '') + s;
  };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  /* A fee share is a signed adjustment, not always a deduction: the book
     carries reversals of prior-period shares as POSITIVE monthly figures
     (Hoffman's February line is +$43,112 against a −$775,330 accrual). */
  const feeLabel = (v) => (v > 0 ? 'fee share reversal' : 'less fee share');

  let CATALOG = null;
  let YEAR = null;
  let MODE = 'actual';        // actual | plan | variance
  let FOCUS = 0;              // 0 = whole year, 1–12 = one month
  let PENDING = null;
  let SHOW_ZERO = false;
  let ONLY_UNMAPPED = false;

  /* ============================================================
     1 · PARSE — one tab, every month it carries
     Columns are found by header TEXT, never index: the source headers
     lie (the January tab labels its accrual column "February 2026
     Revenue Accruals", and every tab says "Accruals Reversed Jan-2025").
     ============================================================ */
  /* A month column's header is JUST a month — "January", "Sept", "Jan-2026".
     Matching on a mere prefix is not safe here: the accrual column is headed
     "July 2026 Revenue Accruals", which starts with a month name and would be
     read as July's billings on any tab whose real July column went missing or
     sat to its right. So the whole cell must be one month word plus at most a
     year, and nothing else. */
  const MONTH_FULL = ['january', 'february', 'march', 'april', 'may', 'june',
                      'july', 'august', 'september', 'october', 'november', 'december'];
  function monthIndexOf(cell) {
    const t = String(cell == null ? '' : cell).trim().toLowerCase()
      .replace(/[.\-_/]+/g, ' ').replace(/\s+/g, ' ');
    const m = /^([a-z]+)(?: (\d{2,4}))?$/.exec(t);
    if (!m || m[1].length < 3) return -1;
    return MONTH_FULL.findIndex(f => f.startsWith(m[1]));
  }
  const FEESHARE_RX = /\bfee\s*shar/i;
  const FEESHARE_NOT_RX = /\bno\s+fee\s*shar/i;
  const FEEHINT_RX = /fee\s*shar|brokerage\s+(revenue\s+)?(alloc|adjust)/i;
  const isFeeShareName = (name) => FEESHARE_RX.test(name || '') && !FEESHARE_NOT_RX.test(name || '');

  function findHeaderRow(aoa) {
    for (let i = 0; i < Math.min(12, aoa.length); i++) {
      const row = (aoa[i] || []).map(c => String(c == null ? '' : c).toLowerCase());
      if (row.some(c => /project\s*name/.test(c)) && row.some(c => /customer\s*name/.test(c))) return i;
    }
    return -1;
  }
  function mapColumns(header) {
    const h = header.map(c => String(c == null ? '' : c).trim());
    const find = (rx) => h.findIndex(c => rx.test(c));
    return {
      client: find(/customer\s*name/i), name: find(/project\s*name/i),
      code: h.findIndex(c => /^project$/i.test(c)),
      months: MONTH_FULL.map((_, mi) => h.findIndex(c => monthIndexOf(c) === mi)),
      ytd: find(/ytd.*billing/i), reversal: find(/accruals?\s*reversed/i),
      accrual: find(/revenue\s*accruals?/i), reported: find(/reported\s*revenue/i),
      billingSummary: find(/billing\s*summary/i), comment: find(/^comment/i),
      header: h,
    };
  }
  /** Which month does this tab close at? The "YTD <Month>-<Year> Billings"
      header is the reliable statement of it — the accrual column's own header
      is mislabelled on at least one tab in the book. Falls back to the sheet
      name, then to the last month carrying any figure. */
  function detectClose(col, sheetName, rows) {
    const probe = (txt) => {
      for (let i = 0; i < 12; i++) if (new RegExp(MONTHS_LONG[i], 'i').test(txt) || new RegExp('\\b' + MONTHS[i] + '\\b', 'i').test(txt)) return i + 1;
      return 0;
    };
    let m = col.ytd >= 0 ? probe(col.header[col.ytd]) : 0;
    if (!m) m = probe(sheetName || '');
    if (!m && col.accrual >= 0) m = probe(col.header[col.accrual]);
    if (!m) for (let i = 12; i >= 1; i--) if (rows.some(r => (r.billed || {})[i])) { m = i; break; }
    return m;
  }
  function detectYear(col, sheetName) {
    const txt = (col.ytd >= 0 ? col.header[col.ytd] : '') + ' ' + (sheetName || '');
    const m = /(20\d\d)/.exec(txt);
    return m ? +m[1] : new Date().getFullYear();
  }

  const normName = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const rowKey = (code, name) => String(code || '').trim() ? String(code).trim().toUpperCase() : 'name:' + normName(name);

  function parseSheet(aoa, sheetName) {
    const hi = findHeaderRow(aoa);
    if (hi < 0) throw new Error('Could not find the header row — expected columns "Customer name" and "Project Name".');
    const col = mapColumns(aoa[hi]);
    if (col.accrual < 0) throw new Error('Could not find the revenue accruals column.');
    if (!col.months.some(i => i >= 0)) throw new Error('Could not find any month columns (January … December).');

    const grouped = {};
    const warnings = [];
    let footFails = 0, parsed = 0;

    for (let i = hi + 1; i < aoa.length; i++) {
      const r = aoa[i] || [];
      const code = col.code >= 0 ? String(r[col.code] == null ? '' : r[col.code]).trim() : '';
      const name = col.name >= 0 ? String(r[col.name] == null ? '' : r[col.name]).trim() : '';
      const client = col.client >= 0 ? String(r[col.client] == null ? '' : r[col.client]).trim() : '';
      if (!code && !name && !client) continue;
      parsed++;

      const accrual = num(r[col.accrual]);
      // Read only to foot the row against the sheet's own arithmetic;
      // prior-year reversals never enter the ledger.
      const reversal = col.reversal >= 0 ? num(r[col.reversal]) : 0;
      const note = col.comment >= 0 ? String(r[col.comment] == null ? '' : r[col.comment]).trim() : '';
      if (col.reported >= 0) {
        const monthsSum = col.months.reduce((a, ci) => a + (ci >= 0 ? num(r[ci]) : 0), 0);
        if (Math.abs(monthsSum + reversal + accrual - num(r[col.reported])) > 1) footFails++;
      }

      const isFee = isFeeShareName(name);
      const key = rowKey(code, name);
      const g = grouped[key] || (grouped[key] = {
        key, code: String(code).toUpperCase(), name, client,
        billed: {}, feeShare: {}, accrualBal: {}, billingSummary: 0,
        note: '', isFeeShare: isFee, feeHint: false, _accrual: 0,
      });
      // Every month column on the tab, not just the close month — this is
      // where a year-to-date sheet earns its name.
      col.months.forEach((ci, mi) => {
        if (ci < 0) return;
        const v = num(r[ci]);
        if (!v) return;
        const m = mi + 1;
        if (isFee) g.feeShare[m] = (g.feeShare[m] || 0) + v;
        else g.billed[m] = (g.billed[m] || 0) + v;
      });
      g._accrual += accrual;
      g.billingSummary += col.billingSummary >= 0 ? num(r[col.billingSummary]) : 0;
      if (!isFee && note && FEEHINT_RX.test(note)) g.feeHint = true;
      if (note && !g.note) g.note = note;
      if (!g.client && client) g.client = client;
      if (!g.name && name) g.name = name;
      if (isFee) g.isFeeShare = true;
    }

    const rows = Object.values(grouped);
    if (!rows.length) throw new Error('No data rows found under the header.');
    const closeMonth = detectClose(col, sheetName, rows);
    const year = detectYear(col, sheetName);
    // The accrual lump belongs to this tab's close month and no other. It is
    // a target for a human to allocate, never a monthly figure in itself.
    rows.forEach(r => { if (r._accrual) r.accrualBal[closeMonth] = r._accrual; delete r._accrual; });

    // Attach fee shares to the project they come out of.
    const parents = rows.filter(r => !r.isFeeShare);
    rows.filter(r => r.isFeeShare).forEach(fs => {
      const stripped = fs.name.replace(FEESHARE_RX, '').replace(/[-–(),]/g, ' ').trim();
      let best = null, bestScore = 0;
      parents.forEach(p => { const s = tokenScore(stripped, p.name); if (s > bestScore) { bestScore = s; best = p; } });
      if (best && bestScore >= 0.6) fs.parentKey = best.key;
    });

    if (footFails) warnings.push(`${footFails} of ${parsed} rows don't foot against the sheet's own Reported Revenue column — check the tab before posting.`);
    const orphan = rows.filter(r => r.isFeeShare && !r.parentKey).length;
    if (orphan) warnings.push(`${orphan} fee-share line(s) couldn't be matched to a project — they'll post as standalone deductions.`);
    return { rows, warnings, sheet: sheetName, parsed, footFails, closeMonth, year };
  }

  /* ---------- token matcher (same approach as revenue-import.js) ---------- */
  const STOP = new Set(['the', 'of', 'and', 'a', 'an', 'for', 'to', 'at', 'in', 'on', 'llc', 'inc', 'corp', 'project', 'phase', 'ltd', 'lp']);
  const nameTokens = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(t => t && t.length > 1 && !STOP.has(t));
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

  /* ============================================================
     2 · MATCH TO projects.json + SUGGEST A STATUS
     ============================================================ */
  function projectIndex() {
    return STORE.listProjects().filter(p => !STORE.isChangeOrder(p)).map(p => ({
      id: p.id,
      name: (p.project && p.project.name) || '',
      client: (p.project && p.project.client) || '',
      code: String((p.project && (p.project.projectId365 || p.project.salesforceId)) || '').trim().toUpperCase(),
    }));
  }
  function matchRow(idx, row) {
    if (row.code) {
      const hit = idx.find(p => p.code && p.code === row.code);
      if (hit) return { pid: hit.id, via: 'code' };
    }
    let best = null, bestScore = 0;
    idx.forEach(p => {
      let s = tokenScore(row.name, p.name);
      if (row.client && p.client) s = s * 0.8 + tokenScore(row.client, p.client) * 0.2;
      if (s > bestScore) { bestScore = s; best = p; }
    });
    if (best && bestScore >= 0.6) return { pid: best.id, via: 'name', score: Math.round(bestScore * 100) };
    return { pid: null, via: null };
  }

  /** What the fee record says this project bills in this month — the figure
      the actual is reconciled against. Mirrors Revenue Projections. */
  let _planCache = {};
  function planFor(pid, year, month) {
    if (!pid) return 0;
    const ck = pid + '|' + year;
    if (!_planCache[ck]) {
      const p = STORE.getProject(pid);
      const arr = Array.from({ length: 13 }, () => 0);
      if (p) {
        (STORE.monthlySeries(p, CATALOG) || []).forEach(s => { if (s.year === year) arr[s.month] += s.amount; });
        (STORE.approvedChangeOrders ? STORE.approvedChangeOrders(pid) : []).forEach(co => {
          STORE.changeOrderDelta(co).byMonth.forEach(x => {
            const [y, m] = x.ym.split('-').map(Number);
            if (y === year) arr[m] += x.net;
          });
        });
      }
      _planCache[ck] = arr;
    }
    return _planCache[ck][month] || 0;
  }

  /** A first guess for one cell, never a verdict. */
  function suggestStatus(row, month, plan) {
    if (row.isFeeShare) return 'feeshare';
    const billed = STORE.billedOf(row, month);
    const accMove = STORE.accruedOf(row, month);
    const rec = STORE.cellRecognised(row, month);
    const near = (a, b) => Math.abs(a - b) <= Math.abs(b) * 0.02 + 1;
    if (rec < -1 && billed <= 0) return 'writeoff';
    if (/offset|reclass/i.test(row.note || '')) return 'reclass';
    if (Math.abs(plan) < 1 && billed > 1) return 'unfcast';
    if (Math.abs(billed) < 1 && accMove > 1) return 'accrued';
    if (plan > 1 && Math.abs(billed) < 1 && Math.abs(accMove) < 1) return 'slip';
    if (billed > 1 && plan > 1 && billed > plan * 1.5) return 'early';
    if (near(billed, plan)) return 'billed';
    return 'trueup';
  }

  /* ============================================================
     3 · IMPORT
     ============================================================ */
  function wireImport() {
    $('#close-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      $('#import-msg').innerHTML = '<div class="msg">Reading…</div>';
      try {
        const wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array', raw: true });
        PENDING = { file: f.name, wb };
        const guess = wb.SheetNames.find(n => /ytd/i.test(n) && new RegExp(String(YEAR)).test(n)) || wb.SheetNames[0];
        $('#sheet-pick').innerHTML = wb.SheetNames.map(n => `<option value="${esc(n)}" ${n === guess ? 'selected' : ''}>${esc(n)}</option>`).join('');
        $('#sheet-row').hidden = false;
        previewSheet();
      } catch (err) { $('#import-msg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    });
    $('#sheet-pick').addEventListener('change', previewSheet);
    $('#post-year').addEventListener('click', postPending);
  }

  function previewSheet() {
    if (!PENDING) return;
    const sheet = $('#sheet-pick').value;
    try {
      const aoa = XLSX.utils.sheet_to_json(PENDING.wb.Sheets[sheet], { header: 1, raw: true, defval: null });
      const res = parseSheet(aoa, sheet);
      const idx = projectIndex();
      res.rows.forEach(r => { const m = matchRow(idx, r); r.pid = m.pid; r.matchVia = m.via; });
      PENDING.parsed = res;

      const matched = res.rows.filter(r => r.pid).length;
      const monthsWith = MONTHS.map((_, i) => i + 1).filter(m => res.rows.some(r => r.billed[m] || r.feeShare[m]));
      const span = monthsWith.length ? `${MONTHS[monthsWith[0] - 1]}–${MONTHS[monthsWith[monthsWith.length - 1] - 1]}` : 'none';
      const yearWarn = res.year !== YEAR
        ? `<div class="msg warn">This tab looks like <b>${res.year}</b> but you are viewing <b>${YEAR}</b>. Posting will write into ${YEAR}.</div>` : '';

      $('#import-msg').innerHTML = yearWarn + `
        <div class="msg ok">Parsed <b>${esc(sheet)}</b> — <b>${res.rows.length} projects</b> across
          <b>${span}</b> (${monthsWith.length} month${monthsWith.length === 1 ? '' : 's'} of billings).
          Accrual balance recorded at <b>${MONTHS[res.closeMonth - 1] || '—'}</b>, the tab's close month.
          ${matched} matched to a project record, ${res.rows.length - matched} unmatched.</div>`
        + res.warnings.map(w => `<div class="msg warn">${esc(w)}</div>`).join('');
      $('#post-year').disabled = false;
    } catch (err) {
      PENDING.parsed = null;
      $('#import-msg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
      $('#post-year').disabled = true;
    }
  }

  function postPending() {
    if (!PENDING || !PENDING.parsed) return;
    const p = PENDING.parsed;
    const existing = STORE.getLedgerYear(YEAR);
    if (existing && !confirm(`${YEAR} already has actuals posted.\n\nThis refreshes the figures from the sheet and keeps every billing status you have already set. Continue?`)) return;
    try {
      STORE.postLedgerYear(YEAR, p.rows, { file: PENDING.file, sheet: p.sheet, closeMonth: p.closeMonth });
      autoStatus();
      PENDING = null;
      $('#sheet-row').hidden = true; $('#close-file').value = '';
      $('#import-msg').innerHTML = `<div class="msg ok">${YEAR} posted through ${MONTHS[p.closeMonth - 1]}.</div>`;
      render();
    } catch (err) { $('#import-msg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
  }

  /** Pre-fill the obvious cells so the queue only holds real questions:
      fee shares and billings that land on plan. Everything else stays blank
      for a human. */
  function autoStatus() {
    const y = STORE.getLedgerYear(YEAR);
    if (!y) return;
    Object.entries(y.rows).forEach(([key, r]) => {
      for (let m = 1; m <= 12; m++) {
        if ((r.status || {})[m]) continue;
        if (!STORE.cellHasValue(r, m)) continue;
        const s = suggestStatus(r, m, planFor(r.pid, YEAR, m));
        if (s === 'feeshare' || s === 'billed') STORE.setCellStatus(YEAR, key, m, s);
      }
    });
  }

  /* ============================================================
     4 · RENDER
     ============================================================ */
  const ST_CLASS = { billed: 'billed', accrued: 'accrued', slip: 'slip', early: 'early',
    trueup: 'trueup', writeoff: 'wo', unfcast: 'new', reclass: 'reclass', feeshare: 'fee' };

  function ledgerRows() {
    const y = STORE.getLedgerYear(YEAR);
    if (!y) return [];
    const all = Object.entries(y.rows || {}).map(([key, r]) => ({ key, ...r }));
    const byKey = {}; all.forEach(r => { byKey[r.key] = r; r.children = []; });
    const top = [];
    all.forEach(r => {
      const parent = r.isFeeShare && r.parentKey ? byKey[r.parentKey] : null;
      if (parent) parent.children.push(r); else top.push(r);
    });
    return top.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }
  const cellMoved = (r, m) => STORE.cellHasValue(r, m);
  const rowActive = (r) => { for (let m = 1; m <= 12; m++) if (cellMoved(r, m) || planFor(r.pid, YEAR, m)) return true; return false; };

  function cellValue(r, m) {
    if (MODE === 'plan') return planFor(r.pid, YEAR, m);
    if (MODE === 'variance') return STORE.cellRecognised(r, m) - planFor(r.pid, YEAR, m);
    return STORE.cellRecognised(r, m);
  }

  function buildBar() {
    const y = STORE.getLedgerYear(YEAR);
    $('#year-pick').innerHTML = (() => {
      const first = STORE.LEDGER_FIRST_YEAR;
      const last = Math.max(new Date().getFullYear() + 2, first + 2, ...STORE.ledgerYears().map(Number));
      let o = '';
      for (let yy = first; yy <= last; yy++) o += `<option value="${yy}" ${yy === YEAR ? 'selected' : ''}>${yy}</option>`;
      return o;
    })();
    const open = STORE.openCells(YEAR).length;
    const st = $('#year-status');
    if (!y) { st.className = 'p-status none'; st.textContent = 'No actuals'; }
    else if (open) { st.className = 'p-status open'; st.textContent = `${open} cell${open === 1 ? '' : 's'} unruled`; }
    else { st.className = 'p-status done'; st.textContent = 'Fully ruled'; }
    $('#year-meta').innerHTML = y
      ? `Through <b>${MONTHS[STORE.closedThrough(YEAR) - 1] || '—'}</b> · last updated ${new Date(y.updatedAt).toLocaleDateString()} by <b>${esc(y.updatedBy)}</b>`
        + (y.imports || []).map(i => `<span class="imp-chip" title="${esc(i.file)}">${MONTHS[i.closeMonth - 1] || '?'} tab</span>`).join('')
      : 'Upload the year-to-date tab to bring in this year\'s actuals.';
    $('#focus-pick').innerHTML = '<option value="0">Whole year</option>'
      + MONTHS.map((m, i) => `<option value="${i + 1}" ${FOCUS === i + 1 ? 'selected' : ''}>${m} only</option>`).join('');
    $('#remove-year').hidden = !y;
  }

  /** Every line in the sheet needs a home on Projections, or the book does
      not reconcile. This is the running count of what still doesn't. */
  function renderCoverage() {
    const el = $('#coverage');
    if (!el) return;
    const c = STORE.ledgerCoverage(YEAR);
    if (!c || !c.total) { el.hidden = true; return; }
    el.hidden = false;
    const pct = Math.round((c.mapped / c.total) * 100);
    el.className = 'coverage ' + (c.unmapped ? 'off' : 'ok');
    el.innerHTML = `
      <div class="cv-top">
        <span class="cv-t">${c.unmapped ? 'Unmapped revenue' : 'Every line has a home'}</span>
        <span class="cv-sub">${c.mapped} of ${c.total} lines mapped to a project on Revenue Projections`
      + (c.unmapped ? ` — <b>${c.unmapped} still without one, ${money(c.unmappedAmt)} of recognised revenue nobody is measured on</b>.` : ' — the billed book reconciles.')
      + `</span>
        ${c.unmapped ? '<button class="cv-btn" id="cv-jump">Show only unmapped</button>' : ''}
      </div>
      <div class="cv-bar"><span style="width:${pct}%"></span></div>`;
    $('#cv-jump')?.addEventListener('click', () => { ONLY_UNMAPPED = !ONLY_UNMAPPED;
      $('#cv-jump').textContent = ONLY_UNMAPPED ? 'Show all lines' : 'Show only unmapped';
      renderGrid(); });
  }

  function kpis() {
    const t = STORE.yearTotals(YEAR);
    if (!t) { $('#kpis').innerHTML = ''; return; }
    const rows = ledgerRows();
    const flat = rows.concat(...rows.map(r => r.children || []));
    const inScope = (m) => FOCUS ? m === FOCUS : true;
    let plan = 0, slip = 0, wo = 0, unf = 0;
    flat.forEach(r => {
      for (let m = 1; m <= 12; m++) {
        if (!inScope(m)) continue;
        plan += planFor(r.pid, YEAR, m);
        const s = (r.status || {})[m];
        if (s === 'slip') slip += planFor(r.pid, YEAR, m);
        if (s === 'writeoff') wo += STORE.cellRecognised(r, m);
        if (s === 'unfcast') unf += STORE.cellRecognised(r, m);
      }
    });
    const pick = (arr) => FOCUS ? arr[FOCUS] : arr.reduce((a, b) => a + b, 0);
    const rec = pick(t.recognised), bil = pick(t.billed), fee = pick(t.feeShare), acc = pick(t.accrued);
    /* The year as it now stands: what was actually recognised in the months
       Finance has closed, plus the plan for the months still ahead. Reading
       the plan across the whole year would double-count everything already
       reconciled. */
    const closeM = STORE.closedThrough(YEAR);
    let recClosed = 0, planOpen = 0;
    for (let m = 1; m <= 12; m++) {
      if (m <= closeM) recClosed += t.recognised[m];
      else planOpen += flat.reduce((a, r) => a + planFor(r.pid, YEAR, m), 0);
    }
    const forecast = recClosed + planOpen;
    const cards = [
      { l: 'Recognised YTD', v: compact(rec), s: FOCUS ? MONTHS[FOCUS - 1] + ', from the close file' : 'from the close file' },
      { l: 'Billed YTD', v: compact(bil), s: 'invoices actually out the door' },
      { l: 'Accrued, not billed', v: compact(acc), s: Math.abs(t.unallocated) < 1 ? 'earned, invoice still to go' : compact(t.unallocated) + ' still to place', cls: 'acc' },
      { l: 'Slipped out of period', v: compact(-slip), s: 'not billed, not accrued', cls: 'neg' },
      { l: 'Written off', v: compact(wo), s: 'reversed, never billable', cls: 'neg' },
      { l: `${YEAR} forecast`, v: compact(forecast), s: `plan was ${compact(plan)}` + (Math.abs(forecast - plan) >= 1 ? ` — ${compact(forecast - plan)} after reconciliation` : ' — unchanged so far'), navy: true },
    ];
    $('#kpis').innerHTML = cards.map(c => `
      <div class="kpi ${c.navy ? 'navy' : ''}"><div class="k-lbl">${c.l}</div>
      <div class="k-val ${c.cls || ''}">${c.v}</div><div class="k-sub">${c.s}</div></div>`).join('');
  }

  function renderGrid() {
    const rows = ledgerRows()
      .filter(r => SHOW_ZERO || rowActive(r) || (r.children || []).some(rowActive))
      .filter(r => !ONLY_UNMAPPED || !r.pid);
    const t = $('#grid');
    if (!rows.length) { t.innerHTML = ''; $('#empty').hidden = false; return; }
    $('#empty').hidden = true;
    const closeM = STORE.closedThrough(YEAR);

    let h = '<thead><tr><th class="l">Project</th>';
    MONTHS.forEach((m, i) => {
      const mm = i + 1;
      h += `<th class="${mm <= closeM ? 'closed-h' : 'open-h'} ${FOCUS === mm ? 'focus-h' : ''}">${m}<span class="sub">${mm <= closeM ? 'ACTUAL' : 'FORECAST'}</span></th>`;
    });
    h += `<th>${YEAR}</th><th class="acc-h">Accrual<span class="sub">IMPORTED</span></th></tr></thead><tbody>`;

    /* One figure per project-month — recognised revenue, with a stripe under it
       saying how it settled. The three lanes behind that figure open on click,
       because they are the detail you go looking for, not the thing you read
       across a book of 176 projects. */
    const group = (r, ri, isChild) => {
      let s = '', tot = 0;
      s += `<tr class="prow ${isChild ? 'fee-row' : ''}" data-i="${ri}" data-key="${esc(r.key)}">`;
      s += `<td class="l pcell" tabindex="0" role="button" aria-expanded="false">`;
      if (isChild) s += `<div class="wp-name fee">${feeLabel(Object.values(r.feeShare || {})[0] || 0)} — ${esc(r.name || 'co-broker')}</div>`;
      else {
        s += `<span class="chev">▸</span><div class="wp-name">${esc(r.name || '(unnamed)')}</div>`;
        s += `<div class="wp-meta">${esc(r.client || '—')}${r.code ? ' · ' + esc(r.code) : ''}`;
        // Remap is always offered. The auto-matcher is a starting point, and a
        // line quietly matched to the WRONG project is worse than an unmatched one.
        const mp = r.pid ? (STORE.getProject(r.pid) || {}).project : null;
        s += r.pid
          ? ` <span class="mapped" title="${esc((mp && mp.name) || '')}">→ ${esc((mp && mp.name) || 'project')}</span>`
            + ` <button class="map-btn" data-key="${esc(r.key)}">change</button>`
            + ` <a class="proj-link" href="Universal Fee Calculator.html?project=${encodeURIComponent(r.pid)}" title="Open in the calculator">open ↗</a>`
          : ` <button class="map-btn unmapped" data-key="${esc(r.key)}">no home on projections — map or create</button>`;
        s += r.feeHint ? ' <span class="feehint">comment mentions a fee share</span>' : '';
        s += `</div>`;
      }
      s += `</td>`;
      for (let m = 1; m <= 12; m++) {
        const plan = planFor(r.pid, YEAR, m), moved = cellMoved(r, m);
        const v = cellValue(r, m);
        tot += v;
        const focus = FOCUS === m ? 'focus-c' : '';
        if (!moved && !plan) { s += `<td class="num zero ${focus}">—</td>`; continue; }
        const st = (r.status || {})[m];
        const cls = st ? 's-' + (ST_CLASS[st] || '') : 'unruled-c';
        const title = `${MONTHS[m - 1]} · recognised ${money(STORE.cellRecognised(r, m))} · plan ${money(plan)}`
          + (st ? ' · ' + STORE.DISPOSITION_LABEL(st) : ' · no status yet');
        s += `<td class="num cell ${cls} ${focus} ${v ? '' : 'zero'}" data-key="${esc(r.key)}" data-m="${m}"
                 tabindex="0" title="${esc(title)}">${v ? money(v) : '—'}</td>`;
      }
      s += `<td class="num strong">${money(tot)}</td>`;
      const c = STORE.accrualCheck(r);
      s += (!c.imported && !c.allocated) ? `<td class="acc-c zero">—</td>`
        : `<td class="acc-c ${c.ok ? 'ok' : 'off'}"><div class="acc-n">${money(c.imported)}</div>
             <div class="acc-d">${c.ok ? 'allocated ✓' : (c.diff > 0 ? 'over by ' : 'left ') + money(Math.abs(c.diff))}</div>
             ${!c.ok && c.imported ? `<button class="spread-btn" data-key="${esc(r.key)}">spread…</button>` : ''}</td>`;
      s += '</tr>';

      /* The three lanes — hidden until the row is opened. Billed and Accrued
         are typed into here; Tool writes a reconcilable plan adjustment. */
      const lane = (kind, label, hint) => {
        let x = `<tr class="lane lane-${kind} lane-of-${ri}" hidden><td class="l">${label}<span class="lane-hint">${hint}</span></td>`;
        for (let m = 1; m <= 12; m++) {
          const plan = planFor(r.pid, YEAR, m);
          const val = kind === 'perf' ? plan : kind === 'bill' ? STORE.billedOf(r, m) + STORE.feeShareOf(r, m) : STORE.accruedOf(r, m);
          const focus = FOCUS === m ? 'focus-c' : '';
          const editable = kind !== 'perf' || !!r.pid;
          if (!editable) { x += `<td class="num zero ${focus}">${val ? money(val) : '—'}</td>`; continue; }
          const f = kind === 'perf' ? 'tool' : kind === 'bill' ? 'billed' : 'accrued';
          const edited = f === 'billed' && (r.billedEdit || {})[m] != null;
          x += `<td class="num ed ${focus} ${edited ? 'edited' : ''} ${val ? '' : 'zero'}"
                   data-key="${esc(r.key)}" data-m="${m}" data-f="${f}" contenteditable="true"
                   inputmode="decimal" role="textbox" aria-label="${label} ${MONTHS[m - 1]} ${esc(r.name || '')}"
                   >${val ? Math.round(val).toLocaleString() : ''}</td>`;
        }
        return x + '<td class="num"></td><td class="acc-c"></td></tr>';
      };
      s += lane('perf', 'Performed', 'contract schedule');
      s += lane('acc', 'Accrued', 'P&amp;L');
      s += lane('bill', 'Billed', 'invoice out');
      if (r.note) s += `<tr class="lane-note lane-of-${ri}" hidden><td colspan="15">“${esc(r.note)}”</td></tr>`;
      return s;
    };

    let ri = 0;
    rows.forEach(r => { h += group(r, ri++, false); (r.children || []).forEach(fs => { h += group(fs, ri++, true); }); });

    const flat = rows.concat(...rows.map(r => r.children || []));
    const lane = (label, cls, fn, endCell) => {
      let s = `<tr class="tot ${cls}"><td class="l">${label}</td>`, tot = 0;
      for (let m = 1; m <= 12; m++) { const v = flat.reduce((a, r) => a + fn(r, m), 0); tot += v; s += `<td class="num ${FOCUS === m ? 'focus-c' : ''}">${v ? money(v) : '—'}</td>`; }
      return s + `<td class="num">${money(tot)}</td><td class="acc-c">${endCell || ''}</td></tr>`;
    };
    const unalloc = flat.reduce((a, r) => { const c = STORE.accrualCheck(r); return a + (c.imported - c.allocated); }, 0);
    h += '</tbody><tfoot>';
    h += lane('Of which accrued, not billed', 'lane-acc', (r, m) => STORE.accruedOf(r, m),
      `<div class="acc-n">${money(flat.reduce((a, r) => a + STORE.accrualCheck(r).imported, 0))}</div>
       <div class="acc-d">${Math.abs(unalloc) < 1 ? 'all allocated ✓' : money(Math.abs(unalloc)) + ' unallocated'}</div>`);
    h += lane('Billed (invoice out)', 'lane-bill', (r, m) => STORE.billedOf(r, m) + STORE.feeShareOf(r, m));
    h += lane('Recognised revenue', '', (r, m) => STORE.cellRecognised(r, m));
    h += '</tfoot>';
    t.innerHTML = h;
    wireGrid();
  }

  /* Expansion, editing, and the status picker. */
  function wireGrid() {
    const toggle = (row) => {
      const i = row.dataset.i;
      const open = row.classList.toggle('open');
      row.querySelector('.pcell')?.setAttribute('aria-expanded', String(open));
      $$('#grid .lane-of-' + i).forEach(el => { el.hidden = !open; });
    };
    $$('#grid tr.prow .pcell').forEach(td => {
      const row = td.closest('tr');
      td.addEventListener('click', (e) => { if (e.target.closest('a,button')) return; toggle(row); });
      td.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(row); } });
    });
    $$('#grid td.cell').forEach(td => {
      td.addEventListener('click', (e) => openStatusMenu(td, e));
      td.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openStatusMenu(td, e); } });
    });
    $$('#grid td.ed').forEach(td => {
      td.addEventListener('focus', () => { td.dataset.before = td.textContent.trim(); });
      td.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); td.blur(); }
        else if (e.key === 'Escape') { td.textContent = td.dataset.before || ''; td.blur(); }
      });
      td.addEventListener('blur', () => {
        const raw = td.textContent.replace(/[$,\s]/g, '').replace(/[−–—]/g, '-').trim();
        if (raw === (td.dataset.before || '').replace(/[$,\s]/g, '')) return;
        if (raw !== '' && isNaN(Number(raw))) { td.textContent = td.dataset.before || ''; return; }
        const openKeys = $$('#grid tr.prow.open').map(x => x.dataset.i);
        if (td.dataset.f === 'tool') adjustPlan(td.dataset.key, +td.dataset.m, raw === '' ? null : Number(raw));
        else STORE.setCellAmount(YEAR, td.dataset.key, +td.dataset.m, td.dataset.f, raw === '' ? null : Number(raw));
        buildBar(); kpis(); renderGrid(); renderFlash(); renderLeader();
        // keep whatever the user had open, open
        openKeys.forEach(i => { const r = $(`#grid tr.prow[data-i="${i}"]`); if (r && !r.classList.contains('open')) r.querySelector('.pcell').click(); });
      });
    });
    $$('#grid .map-btn').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); openMapMenu(b); }));
    $$('#grid .spread-btn').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); openSpreadMenu(b); }));
  }

  /* ---- "What changed on your projects" — the same reconciliation, written
     for the person who owns the client. ---- */
  function renderLeader() {
    const el = $('#leader-list');
    if (!el) return;
    const rows = ledgerRows();
    const flat = rows.concat(...rows.map(r => r.children || []));
    const items = [];
    flat.forEach(r => {
      for (let m = 1; m <= 12; m++) {
        const st = (r.status || {})[m];
        if (!st || st === 'billed' || st === 'feeshare') continue;
        const rec = STORE.cellRecognised(r, m), plan = planFor(r.pid, YEAR, m);
        const to = (r.carryTo || {})[m];
        const say = {
          slip: ['down', money(plan - rec), `${MONTHS[m - 1]} was planned and never invoiced or accrued.` + (to ? ` Finance has moved the billing to <b>${MONTHS[to - 1]}</b>.` : ' Finance has not yet said which month it moves to.') + ' Your year is unchanged — but if that work is not happening, say so and it comes out.'],
          accrued: ['defer', money(rec), `${MONTHS[m - 1]} is earned and in the P&amp;L; the invoice goes out next month. <b>Nothing for you to do</b> — this is what a healthy month looks like.`],
          unfcast: ['up', money(rec), `Billing in ${MONTHS[m - 1]} with <b>no project record behind it</b>. Build the record so the run rate is forecast rather than discovered at the next close.`],
          writeoff: ['down', money(rec), `A prior accrual that is no longer billable. <b>Written off</b> and out of the forecast for good.`],
          early: ['up', money(rec), `Invoiced ahead of the plan in ${MONTHS[m - 1]}. Revenue is right for the year; the monthly shape is off by one.`],
          trueup: [rec >= plan ? 'up' : 'down', money(rec - plan), `${MONTHS[m - 1]} settled at a different figure from the plan. Finance has trued it up.`],
          reclass: ['defer', money(rec), `A <b>reclass</b> — the same work moved between project codes. Read it with its offsetting line or it looks like a win and a collapse.`],
        }[st];
        if (say) items.push({ kind: say[0], amt: say[1], txt: say[2], name: r.name, client: r.client, sort: Math.abs(rec - plan) });
      }
    });
    items.sort((a, b) => b.sort - a.sort);
    $('#leader-card').hidden = !items.length;
    el.innerHTML = items.slice(0, 12).map(i => `
      <div class="icard ${i.kind}">
        <div class="ic-top"><span class="ic-proj">${esc(i.name || '')}${i.client ? ' · ' + esc(i.client) : ''}</span><span class="ic-amt">${i.amt}</span></div>
        <div class="ic-txt">${i.txt}</div>
      </div>`).join('');
  }

  /* ---- spread an accrual lump across a run of months ---- */
  function openSpreadMenu(btn) {
    closeMenus();
    const key = btn.dataset.key;
    const row = STORE.getLedgerYear(YEAR).rows[key];
    const c = STORE.accrualCheck(row);
    const closeM = STORE.closedThrough(YEAR) || 12;
    const pop = document.createElement('div');
    pop.className = 'popover spread';
    pop.innerHTML = `
      <div class="pop-head">Spread the accrual · <b>${esc(row.name || '')}</b></div>
      <div class="pop-nums"><span>Imported lump <b>${money(c.imported)}</b></span>
        <span>Allocated <b>${money(c.allocated)}</b></span></div>
      <div class="sp-body">
        <label>Amount <input class="sp-amt" type="text" value="${Math.round(c.imported)}"></label>
        <label>From <select class="sp-from">${MONTHS.map((m, i) => `<option value="${i + 1}" ${i + 1 === 1 ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label>To <select class="sp-to">${MONTHS.map((m, i) => `<option value="${i + 1}" ${i + 1 === closeM ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <div class="sp-preview"></div>
        <button class="btn btn-primary sp-go">Spread evenly</button>
      </div>`;
    document.body.appendChild(pop);
    const rect = btn.getBoundingClientRect();
    pop.style.top = (rect.bottom + window.scrollY + 4) + 'px';
    pop.style.left = Math.max(8, Math.min(rect.left + window.scrollX - 160, window.innerWidth - pop.offsetWidth - 12)) + 'px';
    const preview = () => {
      const a = +pop.querySelector('.sp-from').value, b = +pop.querySelector('.sp-to').value;
      const amt = Number(String(pop.querySelector('.sp-amt').value).replace(/[$,\s]/g, '')) || 0;
      const n = b - a + 1;
      pop.querySelector('.sp-preview').textContent = n > 0
        ? `${money(amt / n)} in each of ${MONTHS[a - 1]}–${MONTHS[b - 1]} (${n} month${n === 1 ? '' : 's'})`
        : 'Pick a range that runs forwards.';
    };
    pop.querySelectorAll('.sp-from,.sp-to,.sp-amt').forEach(el => el.addEventListener('input', preview));
    preview();
    pop.querySelector('.sp-go').addEventListener('click', () => {
      const a = +pop.querySelector('.sp-from').value, b = +pop.querySelector('.sp-to').value;
      const amt = Number(String(pop.querySelector('.sp-amt').value).replace(/[$,\s]/g, ''));
      try { STORE.spreadAccrual(YEAR, key, a, b, amt); } catch (err) { alert(err.message); return; }
      closeMenus(); buildBar(); kpis(); renderGrid(); renderFlash();
    });
  }

  /* ---- per-cell status popover ---- */
  function closeMenus() { $$('.popover').forEach(p => p.remove()); }
  document.addEventListener('click', (e) => { if (!e.target.closest('.popover') && !e.target.closest('.map-btn') && !e.target.closest('.spread-btn')) closeMenus(); });

  function openStatusMenu(td, ev) {
    ev.stopPropagation(); closeMenus();
    const key = td.dataset.key, m = +td.dataset.m;
    const y = STORE.getLedgerYear(YEAR); const row = y.rows[key];
    const cur = (row.status || {})[m] || '';
    const plan = planFor(row.pid, YEAR, m), act = STORE.cellRecognised(row, m);
    const sug = suggestStatus(row, m, plan);
    const pop = document.createElement('div');
    pop.className = 'popover';
    pop.innerHTML = `
      <div class="pop-head">${esc(row.name || '')} · <b>${MONTHS[m - 1]} ${YEAR}</b></div>
      <div class="pop-nums">
        <span>Billed <b>${money(STORE.billedOf(row, m))}</b></span>
        ${STORE.feeShareOf(row, m) ? `<span class="fee">Fee share <b>${money(STORE.feeShareOf(row, m))}</b></span>` : ''}
        ${STORE.accruedOf(row, m) ? `<span class="acc">Accrued <b>${money(STORE.accruedOf(row, m))}</b></span>` : ''}
        <span>Plan <b>${money(plan)}</b></span>
        <span class="${act - plan < 0 ? 'neg' : 'pos'}">Variance <b>${money(act - plan)}</b></span>
      </div>
      <div class="pop-list">
        ${STORE.DISPOSITIONS.map(d => `<button class="pop-opt ${cur === d.id ? 'on' : ''}" data-s="${d.id}">
          <span class="dot ${ST_CLASS[d.id]}"></span>${esc(d.label)}${sug === d.id && !cur ? '<em>suggested</em>' : ''}</button>`).join('')}
        <button class="pop-opt clear" data-s="">Clear status</button>
      </div>
      <div class="pop-carry" ${cur === 'slip' ? '' : 'hidden'}>
        <label>Bills instead in
          <select class="carry-pick">
            <option value="">— month —</option>
            ${MONTHS.map((mn, i) => i + 1 > m ? `<option value="${i + 1}" ${(row.carryTo || {})[m] === i + 1 ? 'selected' : ''}>${mn}</option>` : '').join('')}
          </select>
        </label>
        ${(row.carryTo || {})[m] && row.pid ? `<button class="btn sm shift-btn" data-pid="${esc(row.pid)}" data-n="${(row.carryTo[m] - m)}">Shift schedule +${row.carryTo[m] - m} &amp; staffing</button>` : ''}
      </div>`;
    document.body.appendChild(pop);
    const rect = td.getBoundingClientRect();
    const top = Math.min(rect.bottom + window.scrollY + 4, window.scrollY + window.innerHeight - pop.offsetHeight - 12);
    pop.style.top = top + 'px';
    pop.style.left = Math.max(8, Math.min(rect.left + window.scrollX - 90, window.innerWidth - pop.offsetWidth - 12)) + 'px';

    pop.querySelectorAll('.pop-opt').forEach(b => b.addEventListener('click', () => {
      const next = b.dataset.s || null;
      STORE.setCellStatus(YEAR, key, m, next);
      // Stepping away from 'slipped' takes the money back off the project.
      if (cur === 'slip' && next !== 'slip' && row.pid) {
        try { STORE.removeSlip(row.pid, { ledgerKey: key, fromYm: ymOf(YEAR, m) }); } catch (e) {}
      }
      closeMenus(); buildBar(); kpis(); renderGrid(); renderFlash(); renderLeader();
    }));
    pop.querySelector('.shift-btn')?.addEventListener('click', () => {
      const n = +pop.querySelector('.shift-btn').dataset.n;
      if (!confirm(`Move this project's whole schedule out by ${n} month${n === 1 ? '' : 's'}?\n\nPhase lengths stay the same; the start date and every month of staffing move with it, so effort and revenue stay in step.`)) return;
      try { STORE.shiftSchedule(pop.querySelector('.shift-btn').dataset.pid, n); } catch (e) { alert(e.message); return; }
      _planCache[row.pid + '|' + YEAR] = null; delete _planCache[row.pid + '|' + YEAR];
      closeMenus(); buildBar(); kpis(); renderGrid(); renderFlash();
    });
    pop.querySelector('.carry-pick')?.addEventListener('change', (e) => {
      const to = +e.target.value || null;
      STORE.setCellStatus(YEAR, key, m, 'slip', { carryTo: to });
      applySlipToProject(key, m, to);
      closeMenus(); buildBar(); kpis(); renderGrid(); renderFlash();
    });
  }

  const ymOf = (y, m) => y + '-' + String(m).padStart(2, '0');

  /** Change what the project SAYS it should bill in a month. Recorded as a
      reconcilable adjustment rather than a silent overwrite, so it shows red
      on Revenue Projections and in the calculator until someone signs it off.
      The delta is measured against the UNADJUSTED plan, so typing twice lands
      where you typed rather than compounding. */
  function adjustPlan(key, month, value) {
    const row = STORE.getLedgerYear(YEAR).rows[key];
    if (!row || !row.pid) { alert('Map this line to a project first — there is no plan to change.'); return; }
    const ym = ymOf(YEAR, month);
    const existing = (STORE.projectSlips(STORE.getProject(row.pid)) || [])
      .find(x => (x.kind || 'slip') === 'adjust' && x.ledgerKey === key && x.ym === ym);
    const shown = planFor(row.pid, YEAR, month);
    const bare = shown - (existing ? (Number(existing.delta) || 0) : 0);
    try {
      if (value == null || Math.abs(value - bare) < 0.005) {
        if (existing) STORE.removeSlip(row.pid, { id: existing.id });     // back to the plan
      } else {
        STORE.recordAdjustment(row.pid, {
          ledgerKey: key, ym, delta: Math.round((value - bare) * 100) / 100,
          was: bare, now: value,
          note: `${MONTHS[month - 1]} ${YEAR} plan corrected to match what was billed`,
        });
      }
      delete _planCache[row.pid + '|' + YEAR];
    } catch (e) { alert(e.message); }
  }

  /** A slip is the one thing on this page that writes into a project record:
      the fee was planned, it did not bill, so it moves to a later month and the
      project carries a flag until someone reconciles it. Unmatched rows cannot
      slip — there is no forecast to move. */
  function applySlipToProject(key, month, toMonth) {
    const row = STORE.getLedgerYear(YEAR).rows[key];
    if (!row) return;
    if (!row.pid) {
      alert('This line is not mapped to a project yet, so there is no forecast to move.\n\nUse “map to project…” on the row first.');
      return;
    }
    if (!toMonth) { try { STORE.removeSlip(row.pid, { ledgerKey: key, fromYm: ymOf(YEAR, month) }); } catch (e) {} return; }
    // The amount is what the plan expected and the month did not deliver. Settled
    // once, at creation: the plan has moved by the time we look again.
    const shortfall = planFor(row.pid, YEAR, month) - STORE.cellRecognised(row, month);
    try {
      STORE.recordSlip(row.pid, {
        ledgerKey: key, fromYm: ymOf(YEAR, month), toYm: ymOf(YEAR, toMonth),
        amount: Math.round(shortfall * 100) / 100,
        note: `${MONTHS[month - 1]} ${YEAR} did not bill or accrue — moved to ${MONTHS[toMonth - 1]}`,
      });
      _planCache[row.pid + '|' + YEAR] = null; delete _planCache[row.pid + '|' + YEAR];
    } catch (e) { alert(e.message); }
  }

  function openMapMenu(btn) {
    closeMenus();
    const key = btn.dataset.key;
    const y = STORE.getLedgerYear(YEAR); const row = y.rows[key];
    const idx = projectIndex().sort((a, b) => (a.client + a.name).localeCompare(b.client + b.name));
    let ytd = 0; for (let m = 1; m <= 12; m++) ytd += STORE.cellRecognised(row, m);
    const pop = document.createElement('div');
    pop.className = 'popover map';
    pop.innerHTML = `
      <div class="pop-head">Give this line a home · <b>${esc(row.name || '')}</b></div>
      <div class="pop-nums"><span>${esc(row.client || 'no client')}${row.code ? ' · ' + esc(row.code) : ''}</span>
        <span>${YEAR} recognised <b>${money(ytd)}</b></span></div>
      <button class="pop-opt create" data-create="1"><span class="dot new"></span>Create a new project from this line
        <em>adds it to Projections</em></button>
      <input class="map-search" type="search" placeholder="…or search existing projects" aria-label="Search projects">
      <div class="pop-list map-list">
        ${idx.map(p => `<button class="pop-opt ${p.id === row.pid ? 'on' : ''}" data-pid="${p.id}"><span class="mp-n">${esc(p.name)}</span><span class="mp-c">${esc(p.client)}${p.code ? ' · ' + esc(p.code) : ''}</span></button>`).join('')}
      </div>
      <button class="pop-opt clear" data-pid="">Leave unmapped</button>`;
    document.body.appendChild(pop);
    const rect = btn.getBoundingClientRect();
    pop.style.top = (rect.bottom + window.scrollY + 4) + 'px';
    pop.style.left = Math.max(8, rect.left + window.scrollX) + 'px';
    const search = pop.querySelector('.map-search');
    search.addEventListener('input', () => {
      const q = search.value.toLowerCase();
      pop.querySelectorAll('.map-list .pop-opt').forEach(b => { b.style.display = b.textContent.toLowerCase().includes(q) ? '' : 'none'; });
    });
    search.focus();
    pop.querySelectorAll('.pop-opt').forEach(b => b.addEventListener('click', () => {
      try {
        if (b.dataset.create) STORE.createProjectFromLedgerRow(YEAR, key);
        else STORE.setRowMatch(YEAR, key, b.dataset.pid || null);
      } catch (e) { alert(e.message); return; }
      _planCache = {};
      closeMenus(); buildBar(); kpis(); renderGrid(); renderFlash(); renderLeader(); renderCoverage();
    }));
  }

  /* ---- flash: one month, ready to send ---- */
  function flashMonth() { return FOCUS || STORE.closedThrough(YEAR) || 1; }
  function flashRows() {
    const m = flashMonth();
    const rows = ledgerRows();
    const flat = [];
    rows.forEach(r => { flat.push(r); (r.children || []).forEach(fs => flat.push(fs)); });
    return flat.filter(r => cellMoved(r, m) || planFor(r.pid, YEAR, m)).map(r => ({
      row: r, m,
      billed: STORE.billedOf(r, m),
      fee: STORE.feeShareOf(r, m),
      acc: STORE.accruedOf(r, m),
      rec: STORE.cellRecognised(r, m),
      plan: planFor(r.pid, YEAR, m),
      status: (r.status || {})[m] || '',
    }));
  }
  function renderFlash() {
    const m = flashMonth();
    const rows = flashRows();
    $('#flash-title').textContent = `Month view · ${MONTHS_LONG[m - 1]} ${YEAR}`;
    const t = $('#flash-table');
    if (!rows.length) { t.innerHTML = ''; return; }
    /* The mockup's read, left to right: what the fee tool said, what we
       recognised, and the two figures that make up the difference. The three
       that did not exist before the ledger are highlighted, so it is obvious
       what this page added to a report people already knew. */
    let h = `<thead><tr><th class="l">Project</th><th class="l">Client</th>
      <th>Projected<span class="sub">FEE TOOL</span></th>
      <th class="new-col">Recognised</th><th class="new-col">Billed</th><th class="new-col">Accrued</th>
      <th>Fee share</th><th>Variance</th><th class="l new-col">Disposition</th></tr></thead><tbody>`;
    const tot = { plan: 0, billed: 0, fee: 0, acc: 0, rec: 0 };
    rows.sort((a, b) => Math.abs(b.rec) - Math.abs(a.rec)).forEach(x => {
      tot.plan += x.plan; tot.billed += x.billed; tot.fee += x.fee; tot.acc += x.acc; tot.rec += x.rec;
      const v = x.rec - x.plan;
      h += `<tr class="${x.row.isFeeShare ? 'fee-row' : ''}">
        <td class="l">${x.row.isFeeShare ? feeLabel(x.fee) + ' — ' : ''}${esc(x.row.name || '')}</td>
        <td class="l">${esc(x.row.client || '—')}</td>
        <td>${x.plan ? money(x.plan) : '—'}</td>
        <td class="new-col strong">${money(x.rec)}</td>
        <td class="new-col">${x.billed ? money(x.billed) : '—'}</td>
        <td class="new-col ${x.acc ? 'acc-cell' : ''}">${x.acc ? money(x.acc) : '—'}</td>
        <td class="${x.fee ? 'fee-cell' : ''}">${x.fee ? money(x.fee) : '—'}</td>
        <td class="${v < -0.5 ? 'neg' : v > 0.5 ? 'pos' : ''}">${Math.abs(v) > 0.5 ? money(v) : '—'}</td>
        <td class="l new-col"><select class="disp-pick ${x.status ? 'set' : ''}" data-key="${esc(x.row.key)}" data-m="${x.m}"
              aria-label="Billing status for ${esc(x.row.name || '')}">
            <option value="">— pick a disposition —</option>
            ${STORE.DISPOSITIONS.map(d => `<option value="${d.id}" ${x.status === d.id ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}
          </select>
          <span class="carry-wrap" ${x.status === 'slip' ? '' : 'hidden'}><span class="carry-lbl">bills in</span>
            <select class="carry-pick" data-key="${esc(x.row.key)}" data-m="${x.m}" aria-label="Carry month">
              <option value="">— month —</option>
              ${MONTHS.map((mn, i) => i + 1 > x.m ? `<option value="${i + 1}" ${(x.row.carryTo || {})[x.m] === i + 1 ? 'selected' : ''}>${mn}</option>` : '').join('')}
            </select></span>
        </td></tr>`;
    });
    h += `</tbody><tfoot><tr class="tot"><td class="l">Total</td><td></td><td>${money(tot.plan)}</td>
      <td class="new-col">${money(tot.rec)}</td><td class="new-col">${money(tot.billed)}</td>
      <td class="new-col">${money(tot.acc)}</td><td>${money(tot.fee)}</td>
      <td>${money(tot.rec - tot.plan)}</td><td class="new-col"></td></tr></tfoot>`;
    t.innerHTML = h;
    $$('#flash-table .disp-pick').forEach(sel => sel.addEventListener('change', () => {
      const key = sel.dataset.key, m = +sel.dataset.m, prev = (STORE.getLedgerYear(YEAR).rows[key].status || {})[m];
      STORE.setCellStatus(YEAR, key, m, sel.value || null);
      const row = STORE.getLedgerYear(YEAR).rows[key];
      if (prev === 'slip' && sel.value !== 'slip' && row.pid) { try { STORE.removeSlip(row.pid, { ledgerKey: key, fromYm: ymOf(YEAR, m) }); } catch (e) {} }
      buildBar(); kpis(); renderGrid(); renderFlash(); renderLeader();
    }));
    $$('#flash-table .carry-pick').forEach(sel => sel.addEventListener('change', () => {
      const key = sel.dataset.key, m = +sel.dataset.m, to = +sel.value || null;
      STORE.setCellStatus(YEAR, key, m, 'slip', { carryTo: to });
      applySlipToProject(key, m, to);
      buildBar(); kpis(); renderGrid(); renderFlash(); renderLeader();
    }));
  }

  /* ============================================================
     5 · EXCEL
     ============================================================ */
  function xlHead(ws, title, sub, span) {
    const NAVY = 'FF25273A', STEEL = 'FF79828C';
    ws.mergeCells('A1:' + span + '1');
    ws.getCell('A1').value = title;
    ws.getCell('A1').font = { bold: true, size: 15, color: { argb: NAVY } };
    ws.mergeCells('A2:' + span + '2');
    ws.getCell('A2').value = sub;
    ws.getCell('A2').font = { italic: true, size: 10, color: { argb: STEEL } };
    ws.addRow([]);
  }
  function xlBook() {
    const wb = new (window.ExcelJS.Workbook)();
    wb.creator = 'Savills PPM · Revenue Reconciliation';
    return wb;
  }
  async function xlSave(wb, filename) {
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  /** Every unruled figure — carried by both exports, because "what is still
      open" is the question anyone receiving either one will ask. */
  function xlUnruled(wb) {
    const NAVY = 'FF25273A', RED = 'FFCE181E', GRN = 'FF1F8A5B';
    const fmt = '"$"#,##0;[Red]("$"#,##0)';
    const open = STORE.openCells(YEAR);
    const ex = wb.addWorksheet('Unruled');
    ex.mergeCells('A1:F1');
    ex.getCell('A1').value = open.length ? `${open.length} figure(s) with no billing status` : 'Every figure has a billing status.';
    ex.getCell('A1').font = { bold: true, size: 13, color: { argb: open.length ? RED : GRN } };
    ex.addRow([]);
    const eh = ex.addRow(['Project', 'Client', 'Project #', 'Month', 'Recognised', 'Finance note']);
    eh.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; });
    open.forEach(o => {
      const r = ex.addRow([o.row.name || '', o.row.client || '', o.row.code || '', MONTHS[o.month - 1], o.recognised, o.row.note || '']);
      r.getCell(5).numFmt = fmt;
    });
    ex.columns = [{ width: 44 }, { width: 28 }, { width: 12 }, { width: 9 }, { width: 16 }, { width: 56 }];
  }

  /** THE YEAR — every project across twelve months, with the three lanes
      behind each one written out underneath it, because a spreadsheet cannot
      expand a row on click. */
  async function exportYear() {
    if (typeof ExcelJS === 'undefined') { alert('Excel library not loaded — reload the page and try again.'); return; }
    const y = STORE.getLedgerYear(YEAR);
    if (!y) { alert('Nothing to export — no actuals posted for ' + YEAR + '.'); return; }
    const NAVY = 'FF25273A', YEL = 'FFFFDF00', RED = 'FFCE181E', GRN = 'FF1F8A5B', AMB = 'FFC07A00', TEAL = 'FF1D6B78';
    const fmt = '"$"#,##0;[Red]("$"#,##0)';
    const wb = xlBook();
    const ws = wb.addWorksheet(String(YEAR));
    xlHead(ws, `Savills PPM — Revenue Reconciliation · ${YEAR}`,
      `Actuals through ${MONTHS_LONG[STORE.closedThrough(YEAR) - 1] || '—'} · last updated ${new Date(y.updatedAt).toLocaleDateString()} by ${y.updatedBy} · exported ${new Date().toLocaleString()}`, 'R');
    const head = ws.addRow(['Project', 'Client', 'Project #', 'Lane', ...MONTHS, 'Total', 'Plan', 'Variance']);
    head.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { horizontal: 'center' }; });
    [1, 2, 3, 4].forEach(i => head.getCell(i).alignment = { horizontal: 'left' });

    const rows = ledgerRows();
    const flat = []; rows.forEach(r => { flat.push(r); (r.children || []).forEach(f => flat.push(f)); });
    flat.forEach(r => {
      const lanes = [
        ['Recognised', (m) => STORE.cellRecognised(r, m), true],
        ['Performed (plan)', (m) => planFor(r.pid, YEAR, m), false],
        ['Accrued', (m) => STORE.accruedOf(r, m), false],
        ['Billed', (m) => STORE.billedOf(r, m) + STORE.feeShareOf(r, m), false],
      ];
      lanes.forEach(([label, fn, isMain], li) => {
        const cells = []; let tt = 0, pp = 0;
        for (let m = 1; m <= 12; m++) { const v = fn(m); tt += v; pp += planFor(r.pid, YEAR, m); cells.push(v || null); }
        const row = ws.addRow([
          li === 0 ? (r.isFeeShare ? '    ' + feeLabel(Object.values(r.feeShare || {})[0] || 0) + ' — ' : '') + (r.name || '') : '',
          li === 0 ? (r.client || '') : '', li === 0 ? (r.code || '') : '', label,
          ...cells, tt, isMain ? pp : null, isMain ? tt - pp : null,
        ]);
        for (let i = 5; i <= 19; i++) row.getCell(i).numFmt = fmt;
        if (isMain) {
          row.eachCell(c => { c.font = { bold: true, color: { argb: NAVY } }; });
          // The status on each month rides along as a cell note.
          for (let m = 1; m <= 12; m++) { const st = (r.status || {})[m]; if (st) row.getCell(4 + m).note = STORE.DISPOSITION_LABEL(st); }
        } else {
          row.getCell(4).font = { italic: true, color: { argb: label === 'Accrued' ? AMB : label === 'Billed' ? GRN : TEAL } };
        }
        if (r.isFeeShare) row.eachCell(c => { c.font = { ...(c.font || {}), italic: true, color: { argb: RED } }; });
      });
    });

    const t = STORE.yearTotals(YEAR);
    const totRow = (label, arr, fill) => {
      const row = ws.addRow(['', '', '', label, ...MONTHS.map((_, i) => arr[i + 1] || null), arr.reduce((a, b) => a + b, 0), null, null]);
      row.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }; });
      for (let i = 5; i <= 17; i++) row.getCell(i).numFmt = fmt;
      return row;
    };
    totRow('Of which accrued, not billed', t.accrued, 'FF3B3A34');
    totRow('Billed (invoice out)', t.billed, 'FF2F3147');
    const rec = totRow('RECOGNISED REVENUE', t.recognised, NAVY);
    rec.getCell(17).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YEL } };
    rec.getCell(17).font = { bold: true, color: { argb: NAVY } };
    ws.columns = [{ width: 42 }, { width: 26 }, { width: 11 }, { width: 20 }, ...MONTHS.map(() => ({ width: 13 })), { width: 15 }, { width: 14 }, { width: 14 }];
    ws.views = [{ state: 'frozen', ySplit: 4, xSplit: 4 }];
    xlUnruled(wb);
    await xlSave(wb, `Savills PPM Reconciliation ${YEAR}.xlsx`);
  }

  async function exportFlash() {
    if (typeof ExcelJS === 'undefined') { alert('Excel library not loaded — reload the page and try again.'); return; }
    const y = STORE.getLedgerYear(YEAR);
    if (!y) { alert('Nothing to export — no actuals posted for ' + YEAR + '.'); return; }
    const m = flashMonth(), rows = flashRows();
    const NAVY = 'FF25273A', YEL = 'FFFFDF00', RED = 'FFCE181E', GRN = 'FF1F8A5B', AMB = 'FFC07A00', STEEL = 'FF79828C';
    const fmt = '"$"#,##0;[Red]("$"#,##0)';
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Savills PPM · Revenue Reconciliation';

    const ws = wb.addWorksheet(`${MONTHS[m - 1]} ${YEAR} Flash`);
    ws.mergeCells('A1:J1');
    ws.getCell('A1').value = `Savills PPM — Monthly Flash · ${MONTHS_LONG[m - 1]} ${YEAR}`;
    ws.getCell('A1').font = { bold: true, size: 15, color: { argb: NAVY } };
    ws.mergeCells('A2:J2');
    ws.getCell('A2').value = `Actuals through ${MONTHS_LONG[STORE.closedThrough(YEAR) - 1] || '—'} · last updated ${new Date(y.updatedAt).toLocaleDateString()} by ${y.updatedBy} · exported ${new Date().toLocaleString()}`;
    ws.getCell('A2').font = { italic: true, size: 10, color: { argb: STEEL } };
    ws.addRow([]);
    const head = ws.addRow(['Project', 'Client', 'Project #', 'Projected (fee tool)', 'Recognised', 'Billed', 'Accrued', 'Fee share', 'Variance vs projected', 'Billing status', 'Finance note']);
    head.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { horizontal: 'center', wrapText: true }; });
    [1, 2, 3, 10, 11].forEach(i => head.getCell(i).alignment = { horizontal: 'left', wrapText: true });
    const tot = { plan: 0, billed: 0, fee: 0, acc: 0, rec: 0 };
    rows.sort((a, b) => (a.row.name || '').localeCompare(b.row.name || '')).forEach(x => {
      tot.plan += x.plan; tot.billed += x.billed; tot.fee += x.fee; tot.acc += x.acc; tot.rec += x.rec;
      const v = x.rec - x.plan;
      const row = ws.addRow([(x.row.isFeeShare ? '    ' + feeLabel(x.fee) + ' — ' : '') + (x.row.name || ''),
        x.row.client || '', x.row.code || '', x.plan, x.rec, x.billed, x.acc, x.fee, v,
        STORE.DISPOSITION_LABEL(x.status) || 'unruled', x.row.note || '']);
      [4, 5, 6, 7, 8, 9].forEach(i => row.getCell(i).numFmt = fmt);
      if (x.row.isFeeShare) row.eachCell(c => { c.font = { italic: true, color: { argb: RED } }; });
      row.getCell(5).font = { bold: true, color: { argb: NAVY } };
      if (x.acc) row.getCell(7).font = { color: { argb: AMB } };
      if (x.fee) row.getCell(8).font = { color: { argb: RED } };
      if (Math.abs(v) > 0.5) row.getCell(9).font = { bold: true, color: { argb: v < 0 ? RED : GRN } };
      if (!x.status) row.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDF0D8' } };
    });
    const tr = ws.addRow(['TOTAL', '', '', tot.plan, tot.rec, tot.billed, tot.acc, tot.fee, tot.rec - tot.plan, '', '']);
    tr.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; });
    [4, 5, 6, 7, 8, 9].forEach(i => tr.getCell(i).numFmt = fmt);
    tr.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YEL } };
    tr.getCell(5).font = { bold: true, color: { argb: NAVY } };
    ws.columns = [{ width: 46 }, { width: 30 }, { width: 12 }, { width: 15 }, { width: 15 }, { width: 14 }, { width: 18 }, { width: 20 }, { width: 17 }, { width: 26 }, { width: 52 }];
    ws.views = [{ state: 'frozen', ySplit: 4, xSplit: 1 }];

    /* --- Sheet 2: the whole year, month by month, as reconciled --- */
    const gs = wb.addWorksheet(`${YEAR} by month`);
    gs.mergeCells('A1:P1');
    gs.getCell('A1').value = `${YEAR} — recognised revenue by project and month (status in the cell note)`;
    gs.getCell('A1').font = { bold: true, size: 14, color: { argb: NAVY } };
    gs.addRow([]);
    const gh = gs.addRow(['Project', 'Client', 'Project #', ...MONTHS, 'Total', 'Plan', 'Variance']);
    gh.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { horizontal: 'center' }; });
    const grows = ledgerRows();
    const flat = []; grows.forEach(r => { flat.push(r); (r.children || []).forEach(f => flat.push(f)); });
    flat.forEach(r => {
      const cells = [], notes = [];
      let tt = 0, pp = 0;
      for (let mm = 1; mm <= 12; mm++) {
        const v = STORE.cellRecognised(r, mm); tt += v; pp += planFor(r.pid, YEAR, mm);
        cells.push(v || null);
        notes.push((r.status || {})[mm]);
      }
      const row = gs.addRow([(r.isFeeShare ? '    ' + feeLabel(Object.values(r.feeShare || {})[0] || 0) + ' — ' : '') + (r.name || ''),
        r.client || '', r.code || '', ...cells, tt, pp, tt - pp]);
      for (let i = 4; i <= 18; i++) row.getCell(i).numFmt = fmt;
      notes.forEach((st, i) => { if (st) row.getCell(4 + i).note = STORE.DISPOSITION_LABEL(st); });
      if (r.isFeeShare) row.eachCell(c => { c.font = { italic: true, color: { argb: RED } }; });
    });
    const yt = STORE.yearTotals(YEAR);
    const gt = gs.addRow(['RECOGNISED', '', '', ...MONTHS.map((_, i) => yt.recognised[i + 1]), yt.total.recognised, '', '']);
    gt.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; });
    for (let i = 4; i <= 16; i++) gt.getCell(i).numFmt = fmt;
    gs.columns = [{ width: 44 }, { width: 26 }, { width: 11 }, ...MONTHS.map(() => ({ width: 13 })), { width: 15 }, { width: 15 }, { width: 15 }];
    gs.views = [{ state: 'frozen', ySplit: 3, xSplit: 1 }];

    /* --- Sheet 3: still unruled --- */
    const open = STORE.openCells(YEAR);
    const ex = wb.addWorksheet('Unruled cells');
    ex.mergeCells('A1:F1');
    ex.getCell('A1').value = open.length ? `${open.length} figure(s) with no billing status` : 'Every figure has a billing status.';
    ex.getCell('A1').font = { bold: true, size: 13, color: { argb: open.length ? RED : GRN } };
    ex.addRow([]);
    const eh = ex.addRow(['Project', 'Client', 'Project #', 'Month', 'Recognised', 'Finance note']);
    eh.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; });
    open.forEach(o => {
      const r = ex.addRow([o.row.name || '', o.row.client || '', o.row.code || '', MONTHS[o.month - 1], o.recognised, o.row.note || '']);
      r.getCell(5).numFmt = fmt;
    });
    ex.columns = [{ width: 44 }, { width: 28 }, { width: 12 }, { width: 9 }, { width: 16 }, { width: 56 }];

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Savills PPM Flash ${MONTHS[m - 1]} ${YEAR}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ============================================================
     6 · BOOT
     ============================================================ */
  function render() { buildBar(); renderCoverage(); kpis(); renderGrid(); renderFlash(); renderLeader();
    ['actual', 'plan', 'variance'].forEach(k => $('#mode-' + k).classList.toggle('on', MODE === k));
    $('#flash-card').hidden = !STORE.getLedgerYear(YEAR);
  }

  function boot() {
    if (!$('#year-pick')) return;      // loaded elsewhere (the test harness) — parser only
    CATALOG = window.RATES_CATALOG;
    const years = STORE.ledgerYears();
    YEAR = years.length ? +years[years.length - 1] : Math.max(STORE.LEDGER_FIRST_YEAR, new Date().getFullYear());

    $('#year-pick').addEventListener('change', e => {
      YEAR = +e.target.value; PENDING = null;
      $('#sheet-row').hidden = true; $('#import-msg').innerHTML = ''; render();
    });
    $('#focus-pick').addEventListener('change', e => { FOCUS = +e.target.value; render(); });
    ['actual', 'plan', 'variance'].forEach(k => $('#mode-' + k).addEventListener('click', () => { MODE = k; render(); }));
    $('#show-zero').addEventListener('change', e => { SHOW_ZERO = e.target.checked; renderGrid(); });
    $('#flash-export').addEventListener('click', exportFlash);
    $('#year-export').addEventListener('click', exportYear);
    $('#remove-year').addEventListener('click', () => {
      if (!confirm(`Remove all ${YEAR} actuals?\n\nThe figures and every billing status set against them are deleted.`)) return;
      STORE.deleteLedgerYear(YEAR); render();
    });
    wireImport();
    render();
  }

  /* Test surface — the workbook parser is pure (AOA in, rows out) and is the
     one piece that must not break when Finance's file changes shape. */
  window.UFC_ReconcileParse = { parseSheet, findHeaderRow, mapColumns, rowKey, tokenScore, detectClose, monthIndexOf };

  if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(boot);
  else document.addEventListener('DOMContentLoaded', boot);
})();
