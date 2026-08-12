/* ============================================================
   SAVILLS PPM · REVENUE RECONCILIATION  (admin / finance only)
   ------------------------------------------------------------
   The other half of Revenue Projections. Projections say what a
   project SHOULD bill; this page takes what Finance actually
   recognised, billed and accrued in a closed month and puts the
   two side by side, one month at a time.

   WHY IT IS ITS OWN PAGE
     Finance owns the input and revenue leaders must not be able to
     type over a closed month — so the write path lives here, behind
     the admin allowlist, and Revenue Projections stays read-only
     against the ledger. It is also inherently period-at-a-time work:
     you post July, rule on July's exceptions, then move on.

   THE FLOW
     ① Import the monthly close workbook (the "YTD <Month> <Year>"
        tab of Revenue by Month by Client).
     ② Every row is matched to a project, footed against the file's
        own reported-revenue column, and landed as a ledger period.
     ③ Anything the close disagrees with the forecast about becomes an
        exception; Finance picks a disposition from a closed list.
     ④ Flash exports the reconciled month to Excel.

   FEE SHARES
     The close file carries co-broker fee shares as their own rows,
     named for it ("HOFFMAN FEE SHARE", "… - Hoffman Fee Share"). They
     are kept as separate ledger lines rather than netted into the
     parent, because the invoice really did go out gross — the client
     was billed the full amount, and the co-broker's cut comes off
     Savills' revenue afterwards. So a fee share renders as an indented
     line UNDER the project's billed figure and moves recognised
     revenue, which is exactly what it does.

     Two things the book teaches that the obvious implementation gets
     wrong: a fee share is SIGNED, not always a deduction (a reversal
     of a prior-period share shows as a positive month against a large
     negative accrual balance), and it must be identified by name only
     — Finance's Comments column discusses fee shares on rows that are
     ordinary projects, and classifying on that pulls real billings
     out of revenue.

   ONE YEAR AT A TIME
     The page works a single calendar year, 2026 forward. Prior-year
     accrual reversals are read only to prove the sheet parsed correctly
     and are then discarded — they are a whole-year opening adjustment
     about work done last year, and folding them in would dump a lump
     into January and make month-on-month revenue unreadable. So this
     ledger's YTD deliberately differs from the file's "YTD Reported
     Revenue" by exactly that reversal.

   CATCHING UP
     Accruals are BALANCES, so a month cannot be reconciled alone —
     July's recognised revenue depends on June's closing balance.
     Periods are therefore imported oldest-first, and the page refuses
     to foot a period whose predecessor is missing rather than quietly
     treating the gap as zero.
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
     (Hoffman's February line is +$43,112 against a −$775,330 accrual). So
     the label follows the sign rather than asserting one. */
  const feeLabel = (v) => (v > 0 ? 'fee share reversal' : 'less fee share');
  const ymOf = (y, m) => y + '-' + String(m).padStart(2, '0');
  const splitYm = (ym) => ({ year: +String(ym).slice(0, 4), month: +String(ym).slice(5, 7) });
  const ymLabel = (ym) => { const { year, month } = splitYm(ym); return MONTHS[month - 1] + ' ' + year; };

  let CATALOG = null;
  let YEAR = null;            // the calendar year being reconciled (2026 forward)
  let PERIOD = null;          // the ym currently being viewed
  let VIEW = 'month';         // 'month' (single close) | 'ytd' (12-column matrix)
  let PENDING = null;         // a parsed-but-not-yet-posted import

  /* ============================================================
     1 · PARSE THE CLOSE WORKBOOK
     Columns are found by matching header TEXT, never by index. The
     source file's headers are known to lie — the January tab labels
     its accrual column "February 2026 Revenue Accruals" and every tab
     says "Dec-2025 Accruals Reversed Jan-2025" — so we match on the
     stable part of each phrase and ignore the dates inside it.
     ============================================================ */
  const MONTH_RX = [/^jan/i, /^feb/i, /^mar/i, /^apr/i, /^may/i, /^jun/i, /^jul/i, /^aug/i, /^sep/i, /^oct/i, /^nov/i, /^dec/i];

  /* Fee-share detection reads the PROJECT NAME only, never the Comments
     column. Finance writes commentary there that mentions fee shares about
     rows which are ordinary projects — "Billings adjusted for 2025 fee share",
     "Brokerage revenue allocation" — and treating those as fee-share lines
     pulls real billings out of revenue. The comment still matters, so it is
     surfaced as a hint for a human to rule on instead of being applied.
     The negation guard is not hypothetical: the book contains a project
     literally called "Baxter Bardy MN (NO FEE SHARE)". */
  const FEESHARE_RX = /\bfee\s*shar/i;
  const FEESHARE_NOT_RX = /\bno\s+fee\s*shar/i;
  const FEEHINT_RX = /fee\s*shar|brokerage\s+(revenue\s+)?(alloc|adjust)/i;
  const isFeeShareName = (name) => FEESHARE_RX.test(name || '') && !FEESHARE_NOT_RX.test(name || '');

  function findHeaderRow(aoa) {
    for (let i = 0; i < Math.min(12, aoa.length); i++) {
      const row = (aoa[i] || []).map(c => String(c == null ? '' : c).toLowerCase());
      const hasName = row.some(c => /project\s*name/.test(c));
      const hasClient = row.some(c => /customer\s*name/.test(c));
      if (hasName && hasClient) return i;
    }
    return -1;
  }

  function mapColumns(header) {
    const h = header.map(c => String(c == null ? '' : c).trim());
    const find = (rx) => h.findIndex(c => rx.test(c));
    const months = MONTH_RX.map(rx => h.findIndex(c => rx.test(c)));
    return {
      client: find(/customer\s*name/i),
      name: find(/project\s*name/i),
      code: h.findIndex(c => /^project$/i.test(c)),
      account: find(/customer\s*account/i),
      months,
      ytd: find(/ytd.*billing/i),
      reversal: find(/accruals?\s*reversed/i),
      accrual: find(/revenue\s*accruals?/i),
      reported: find(/reported\s*revenue/i),
      billingSummary: find(/billing\s*summary/i),
      comment: find(/^comment/i),
    };
  }

  /** Normalised join key: the D365/SF project code where there is one,
      else the project name. Codes repeat in the file (one project split
      across several lines), so rows sharing a key are summed. */
  const normName = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  function rowKey(code, name) {
    const c = String(code || '').trim();
    return c ? c.toUpperCase() : 'name:' + normName(name);
  }

  function parseSheet(aoa, sheetName, ym) {
    const hi = findHeaderRow(aoa);
    if (hi < 0) throw new Error('Could not find the header row — expected columns "Customer name" and "Project Name".');
    const col = mapColumns(aoa[hi]);
    const { month } = splitYm(ym);
    const mIdx = col.months[month - 1];
    if (mIdx == null || mIdx < 0) throw new Error(`This sheet has no "${MONTHS_LONG[month - 1]}" column — is it the right tab for ${ymLabel(ym)}?`);
    if (col.accrual < 0) throw new Error('Could not find the revenue accruals column.');

    const grouped = {};       // key → aggregated row
    const warnings = [];
    let footFails = 0, parsed = 0;

    for (let i = hi + 1; i < aoa.length; i++) {
      const r = aoa[i] || [];
      const code = col.code >= 0 ? String(r[col.code] == null ? '' : r[col.code]).trim() : '';
      const name = col.name >= 0 ? String(r[col.name] == null ? '' : r[col.name]).trim() : '';
      const client = col.client >= 0 ? String(r[col.client] == null ? '' : r[col.client]).trim() : '';
      if (!code && !name && !client) continue;                 // spacer row
      parsed++;

      const monthVal = num(r[mIdx]);
      const accrual = num(r[col.accrual]);
      // Read only to foot the row against the sheet's own arithmetic below;
      // prior-year reversals never enter the ledger.
      const reversal = col.reversal >= 0 ? num(r[col.reversal]) : 0;
      const bsum = col.billingSummary >= 0 ? num(r[col.billingSummary]) : 0;
      const note = col.comment >= 0 ? String(r[col.comment] == null ? '' : r[col.comment]).trim() : '';

      // Foot this row against the file's own arithmetic:
      //   reported = sum(all month columns) + reversal + accrual
      if (col.reported >= 0) {
        const monthsSum = col.months.reduce((a, ci) => a + (ci >= 0 ? num(r[ci]) : 0), 0);
        const reported = num(r[col.reported]);
        if (Math.abs(monthsSum + reversal + accrual - reported) > 1) footFails++;
      }

      const isFee = isFeeShareName(name);
      const key = rowKey(code, name);
      const g = grouped[key] || (grouped[key] = {
        key, code: code.toUpperCase(), name, client,
        billed: 0, feeShare: 0, accrual: 0, billingSummary: 0,
        note: '', isFeeShare: isFee, feeHint: false, lines: 0,
      });
      // Comment mentions a fee share / brokerage allocation but the row is not
      // named as one — flag it for Finance rather than reclassifying it.
      if (!isFee && note && FEEHINT_RX.test(note)) g.feeHint = true;
      // A fee-share line's monthly figure IS the share (negative); it is
      // never billing. Everything else is gross billing for the month.
      if (isFee) { g.isFeeShare = true; g.feeShare += monthVal; }
      else g.billed += monthVal;
      g.accrual += accrual;
      g.billingSummary += bsum;
      g.lines++;
      if (note && !g.note) g.note = note;
      if (!g.client && client) g.client = client;
      if (!g.name && name) g.name = name;
    }

    const rows = Object.values(grouped);
    if (!rows.length) throw new Error('No data rows found under the header.');

    // Attach each fee share to the project it comes out of, so it can be
    // rendered as an indented deduction rather than floating on its own.
    const parents = rows.filter(r => !r.isFeeShare);
    rows.filter(r => r.isFeeShare).forEach(fs => {
      const stripped = fs.name.replace(FEESHARE_RX, '').replace(/[-–(),]/g, ' ').trim();
      let best = null, bestScore = 0;
      parents.forEach(p => {
        const s = tokenScore(stripped, p.name);
        if (s > bestScore) { bestScore = s; best = p; }
      });
      if (best && bestScore >= 0.6) fs.parentKey = best.key;
    });

    if (footFails) warnings.push(`${footFails} of ${parsed} rows don't foot against the sheet's own Reported Revenue column — check the tab before posting.`);
    const orphanFee = rows.filter(r => r.isFeeShare && !r.parentKey).length;
    if (orphanFee) warnings.push(`${orphanFee} fee-share line(s) couldn't be matched to a project — they'll post as standalone deductions.`);

    return { rows, warnings, sheet: sheetName, parsed, footFails };
  }

  /* ---------- token matcher (same approach as revenue-import.js) ---------- */
  const STOP = new Set(['the', 'of', 'and', 'a', 'an', 'for', 'to', 'at', 'in', 'on', 'llc', 'inc', 'corp', 'project', 'phase', 'ltd', 'lp']);
  function nameTokens(s) {
    return String(s || '').toLowerCase().replace(/&/g, ' and ')
      .split(/[^a-z0-9]+/).filter(t => t && t.length > 1 && !STOP.has(t));
  }
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
     2 · MATCH TO PROJECTS + SUGGEST A DISPOSITION
     ============================================================ */
  function projectIndex() {
    return STORE.listProjects().filter(p => !STORE.isChangeOrder(p)).map(p => ({
      id: p.id, rec: p,
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

  /** What the fee record says this project bills in this month — the
      figure the close is being reconciled against. Mirrors Revenue
      Projections' monthRevenueFor(), change orders included. */
  function planFor(pid, ym) {
    if (!pid) return 0;
    const p = STORE.getProject(pid);
    if (!p) return 0;
    const { year, month } = splitYm(ym);
    const hit = (STORE.monthlySeries(p, CATALOG) || []).find(s => s.year === year && s.month === month);
    let amt = hit ? hit.amount : 0;
    (STORE.approvedChangeOrders ? STORE.approvedChangeOrders(pid) : []).forEach(co => {
      STORE.changeOrderDelta(co).byMonth.forEach(x => {
        const [y, m] = x.ym.split('-').map(Number);
        if (y === year && m === month) amt += x.net;
      });
    });
    return amt;
  }

  /** A first guess, never a verdict — Finance confirms every line. */
  function suggestDisposition(row, priorAccrual, plan) {
    if (row.isFeeShare) return 'feeshare';
    const near = (a, b, tol) => Math.abs(a - b) <= Math.max(tol || 0, Math.abs(b) * 0.02 + 1);
    const dAcc = (row.accrual || 0) - (priorAccrual || 0);
    const rec = STORE.rowRecognised(row, priorAccrual);
    const billed = row.billed || 0;

    if (rec < -1 && billed <= 0) return 'writeoff';
    if (/offset|reclass/i.test(row.note || '')) return 'reclass';
    if (Math.abs(plan) < 1 && billed > 1) return 'unfcast';
    if (Math.abs(billed) < 1 && dAcc > 1) return 'accrued';
    if (plan > 1 && Math.abs(billed) < 1 && Math.abs(dAcc) < 1) return 'slip';
    if (billed > 1 && plan > 1 && billed > plan * 1.5) return 'early';
    if (near(billed, plan)) return 'billed';
    return 'trueup';
  }

  /* ============================================================
     3 · IMPORT UI
     ============================================================ */
  function wireImport() {
    const fileEl = $('#close-file');
    if (!fileEl) return;
    fileEl.addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const msg = $('#import-msg');
      msg.innerHTML = '<div class="msg">Reading…</div>';
      try {
        const buf = await f.arrayBuffer();
        const wb = XLSX.read(new Uint8Array(buf), { type: 'array', raw: true });
        PENDING = { file: f.name, wb, sheets: wb.SheetNames };
        // Default to the tab whose name mentions the selected period's month.
        const { month, year } = splitYm(PERIOD);
        const guess = wb.SheetNames.find(n =>
          new RegExp(MONTHS_LONG[month - 1], 'i').test(n) && new RegExp(String(year)).test(n))
          || wb.SheetNames.find(n => new RegExp(MONTHS_LONG[month - 1], 'i').test(n))
          || wb.SheetNames[0];
        $('#sheet-pick').innerHTML = wb.SheetNames.map(n =>
          `<option value="${esc(n)}" ${n === guess ? 'selected' : ''}>${esc(n)}</option>`).join('');
        $('#sheet-row').hidden = false;
        previewSheet();
      } catch (err) {
        msg.innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
      }
    });
    $('#sheet-pick')?.addEventListener('change', previewSheet);
    $('#post-period')?.addEventListener('click', postPending);
  }

  function previewSheet() {
    if (!PENDING) return;
    const msg = $('#import-msg');
    const sheet = $('#sheet-pick').value;
    try {
      const aoa = XLSX.utils.sheet_to_json(PENDING.wb.Sheets[sheet], { header: 1, raw: true, defval: null });
      const res = parseSheet(aoa, sheet, PERIOD);
      const idx = projectIndex();
      const prevYm = STORE.priorLedgerPeriod(PERIOD);
      const prevRows = prevYm ? (STORE.getLedgerPeriod(prevYm) || {}).rows || {} : {};

      res.rows.forEach(r => {
        const m = matchRow(idx, r);
        r.pid = m.pid; r.matchVia = m.via;
        const prior = (prevRows[r.key] || {}).accrual || 0;
        r.plan = planFor(m.pid, PERIOD);
        r.suggested = suggestDisposition(r, prior, r.plan);
        // Fee shares and clean on-plan billings don't need a human — they are
        // auto-dispositioned so the queue only holds real questions.
        if (r.suggested === 'feeshare' || r.suggested === 'billed') {
          r.disposition = r.suggested; r.auto = true;
        }
      });
      PENDING.parsed = res;

      const matched = res.rows.filter(r => r.pid).length;
      const fee = res.rows.filter(r => r.isFeeShare).length;
      const queue = res.rows.filter(r => !r.auto).length;
      const gapWarn = (!prevYm && PERIOD.slice(5) !== '01')
        ? `<div class="msg warn">No earlier period is posted. Accruals are balances — recognised revenue for ${ymLabel(PERIOD)} will treat the opening accrual as zero. Import the earlier months first if you are catching up.</div>` : '';

      msg.innerHTML = gapWarn + `
        <div class="msg ok">Parsed <b>${esc(sheet)}</b> — ${res.rows.length} projects
          (${matched} matched to the tool, ${res.rows.length - matched} unmatched, ${fee} fee-share line${fee === 1 ? '' : 's'}).
          <b>${queue}</b> line${queue === 1 ? '' : 's'} need a disposition.</div>`
        + res.warnings.map(w => `<div class="msg warn">${esc(w)}</div>`).join('');
      $('#post-period').disabled = false;
    } catch (err) {
      PENDING.parsed = null;
      msg.innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
      $('#post-period').disabled = true;
    }
  }

  function postPending() {
    if (!PENDING || !PENDING.parsed) return;
    const existing = STORE.getLedgerPeriod(PERIOD);
    if (existing && !confirm(`${ymLabel(PERIOD)} was already posted on ${new Date(existing.postedAt).toLocaleDateString()}.\n\nRe-posting replaces the figures but keeps every disposition already made. Continue?`)) return;
    try {
      STORE.postLedgerPeriod(PERIOD, PENDING.parsed.rows, { file: PENDING.file, sheet: PENDING.parsed.sheet });
      PENDING = null;
      $('#sheet-row').hidden = true;
      $('#close-file').value = '';
      $('#import-msg').innerHTML = `<div class="msg ok">${ymLabel(PERIOD)} posted.</div>`;
      render();
    } catch (err) {
      $('#import-msg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
    }
  }

  /* ============================================================
     4 · RENDER
     ============================================================ */
  /** Years the page will offer: the ledger's first year forward, always far
      enough ahead to plan into, and never behind a year already posted. */
  function yearOptions() {
    const first = STORE.LEDGER_FIRST_YEAR;
    const posted = STORE.ledgerPeriods().map(p => +p.slice(0, 4));
    const last = Math.max(new Date().getFullYear() + 2, first + 2, ...(posted.length ? posted : [first]));
    const out = [];
    for (let y = first; y <= last; y++) out.push(y);
    return out;
  }
  const monthsOfYear = (year) => MONTHS.map((_, i) => ymOf(year, i + 1));
  /** The month to land on when the year changes: the latest close posted in
      that year, else January. */
  function defaultPeriodFor(year) {
    const inYear = STORE.ledgerPeriods().filter(p => +p.slice(0, 4) === year);
    return inYear.length ? inYear[inYear.length - 1] : ymOf(year, 1);
  }

  function buildPeriodBar() {
    const posted = new Set(STORE.ledgerPeriods());
    $('#year-pick').innerHTML = yearOptions().map(y =>
      `<option value="${y}" ${y === YEAR ? 'selected' : ''}>${y}</option>`).join('');
    $('#period-pick').innerHTML = monthsOfYear(YEAR).map(ym =>
      `<option value="${ym}" ${ym === PERIOD ? 'selected' : ''}>${MONTHS[splitYm(ym).month - 1]}${posted.has(ym) ? ' · posted' : ''}</option>`).join('');

    const per = STORE.getLedgerPeriod(PERIOD);
    const open = STORE.openExceptions(PERIOD).length;
    const status = $('#period-status');
    if (!per) {
      status.className = 'p-status none';
      status.textContent = 'Not imported';
    } else if (open) {
      status.className = 'p-status open';
      status.textContent = `${open} exception${open === 1 ? '' : 's'} open`;
    } else {
      status.className = 'p-status done';
      status.textContent = 'Reconciled';
    }
    const meta = $('#period-meta');
    meta.innerHTML = per
      ? `Posted ${new Date(per.postedAt).toLocaleDateString()} by <b>${esc(per.postedBy)}</b>${per.sourceFile ? ' · ' + esc(per.sourceFile) : ''}${per.sourceSheet ? ' · ' + esc(per.sourceSheet) : ''}`
      : 'Import the close workbook for this month to reconcile it.';

    // Catch-up strip: all twelve months of the selected year, so what is still
    // outstanding is obvious at a glance.
    $('#catchup').innerHTML = monthsOfYear(YEAR).map(cur => {
      const has = posted.has(cur);
      const ex = has ? STORE.openExceptions(cur).length : 0;
      return `<button class="chip ${has ? (ex ? 'chip-open' : 'chip-done') : 'chip-none'} ${cur === PERIOD ? 'chip-cur' : ''}"
        data-ym="${cur}" title="${has ? (ex ? ex + ' exceptions open' : 'Reconciled') : 'Not imported'}">${MONTHS[splitYm(cur).month - 1]}</button>`;
    }).join('');
    $$('#catchup .chip').forEach(b => b.addEventListener('click', () => { PERIOD = b.dataset.ym; render(); }));
  }

  /** Every ledger row for the period, decorated with plan, prior accrual,
      recognised revenue and its fee-share children. */
  function periodRows(ym) {
    const per = STORE.getLedgerPeriod(ym);
    if (!per) return [];
    const prevYm = STORE.priorLedgerPeriod(ym);
    const prevRows = prevYm ? (STORE.getLedgerPeriod(prevYm) || {}).rows || {} : {};
    const rows = Object.entries(per.rows || {}).map(([key, r]) => {
      const prior = (prevRows[key] || {}).accrual || 0;
      return {
        key, ...r,
        priorAccrual: prior,
        accrualDelta: (r.accrual || 0) - prior,
        recognised: STORE.rowRecognised(r, prior),
        plan: r.pid != null ? planFor(r.pid, ym) : (r.plan || 0),
      };
    });
    // Nest fee shares under their parent so they render as deductions.
    const byKey = {}; rows.forEach(r => { byKey[r.key] = r; r.children = []; });
    const top = [];
    rows.forEach(r => {
      const parent = r.isFeeShare && r.parentKey ? byKey[r.parentKey] : null;
      if (parent) parent.children.push(r); else top.push(r);
    });
    return top;
  }

  function kpis(ym) {
    const t = STORE.periodTotals(ym);
    const el = $('#kpis');
    if (!t) { el.innerHTML = ''; return; }
    const rows = periodRows(ym);
    const flat = rows.concat(...rows.map(r => r.children || []));
    const sumWhere = (fn) => flat.reduce((a, r) => a + (fn(r) ? r.recognised : 0), 0);
    const planTot = rows.reduce((a, r) => a + (r.plan || 0), 0);
    const slipped = rows.filter(r => r.disposition === 'slip').reduce((a, r) => a + (r.plan || 0), 0);
    const written = sumWhere(r => r.disposition === 'writeoff');
    const unfc = sumWhere(r => r.disposition === 'unfcast');

    const cards = [
      { l: 'Billed gross', v: compact(t.billed), s: 'invoices out this month' },
      { l: 'Fee share (net)', v: compact(t.feeShare), s: 'co-broker cut, off recognised revenue', cls: t.feeShare < 0 ? 'neg' : '' },
      { l: 'Accrual movement', v: compact(t.accrual - t.priorAccrual), s: `balance ${compact(t.accrual)} at close`, cls: 'acc' },
      { l: 'Recognised revenue', v: compact(t.recognised), s: 'billed + fee share + accrual Δ', navy: true },
      { l: 'Variance vs plan', v: compact(t.recognised - planTot), s: `plan was ${compact(planTot)}`, cls: (t.recognised - planTot) < 0 ? 'neg' : '' },
      { l: 'Slipped / written off', v: compact(-slipped + written), s: unfc ? `${compact(unfc)} unforecast found` : 'pushed out or removed', cls: 'neg' },
    ];
    el.innerHTML = cards.map(c => `
      <div class="kpi ${c.navy ? 'navy' : ''}">
        <div class="k-lbl">${c.l}</div>
        <div class="k-val ${c.cls || ''}">${c.v}</div>
        <div class="k-sub">${c.s}</div>
      </div>`).join('');
  }

  /* ---------- month view: the reconciliation worksheet ---------- */
  const DISP_CLASS = {
    billed: 'billed', accrued: 'accrued', slip: 'slip', early: 'early',
    trueup: 'trueup', writeoff: 'wo', unfcast: 'new', reclass: 'reclass', feeshare: 'fee',
  };

  function renderMonth(ym) {
    const rows = periodRows(ym);
    const t = $('#worksheet');
    if (!rows.length) {
      t.innerHTML = '';
      $('#empty').hidden = false;
      return;
    }
    $('#empty').hidden = true;

    const carryOpts = (sel) => {
      const { year, month } = splitYm(ym);
      let out = '<option value="">— month —</option>';
      for (let m = month + 1; m <= 12; m++) {
        const k = ymOf(year, m);
        out += `<option value="${k}" ${sel === k ? 'selected' : ''}>${MONTHS[m - 1]}</option>`;
      }
      // A fee pushed past December lands in next year's plan, not this ledger.
      out += `<option value="${ymOf(year + 1, 1)}" ${sel === ymOf(year + 1, 1) ? 'selected' : ''}>${year + 1} →</option>`;
      return out;
    };

    let h = `<thead><tr>
      <th class="l">Project</th>
      <th>Plan</th><th>Billed gross</th><th>Fee share</th>
      <th>Accrual Δ</th><th>Recognised</th><th>Variance</th>
      <th class="l">Disposition</th></tr></thead><tbody>`;

    // Unreviewed lines first — this table is a work queue, not a report.
    const sorted = rows.slice().sort((a, b) => {
      const ao = (a.disposition && !a.auto) || a.auto ? 1 : 0;
      const bo = (b.disposition && !b.auto) || b.auto ? 1 : 0;
      if (ao !== bo) return ao - bo;
      return Math.abs(b.recognised - b.plan) - Math.abs(a.recognised - a.plan);
    });

    sorted.forEach(r => {
      const varc = r.recognised - (r.plan || 0);
      const d = r.disposition || '';
      h += `<tr class="wrow ${d ? 'ruled' : 'unruled'}" data-key="${esc(r.key)}">
        <td class="l">
          <div class="wp-name">${esc(r.name || '(unnamed)')}</div>
          <div class="wp-meta">${esc(r.client || '—')}${r.code ? ' · ' + esc(r.code) : ''}
            ${r.pid ? '' : '<span class="unmatched">no project in tool</span>'}
            ${r.feeHint ? '<span class="feehint">comment mentions a fee share</span>' : ''}</div>
          ${r.note ? `<div class="wp-note">“${esc(r.note)}”</div>` : ''}
        </td>
        <td>${r.plan ? money(r.plan) : '—'}</td>
        <td class="strong">${r.billed ? money(r.billed) : '—'}</td>
        <td class="${r.feeShare ? 'fee-cell' : ''}">${r.feeShare ? money(r.feeShare) : '—'}</td>
        <td class="${r.accrualDelta ? 'acc-cell' : ''}">${r.accrualDelta ? money(r.accrualDelta) : '—'}</td>
        <td class="strong">${money(r.recognised)}</td>
        <td class="${varc < -0.5 ? 'neg' : varc > 0.5 ? 'pos' : ''}">${Math.abs(varc) > 0.5 ? money(varc) : '—'}</td>
        <td class="l">
          <select class="disp-pick ${d ? 'set' : ''}" data-key="${esc(r.key)}" aria-label="Disposition for ${esc(r.name)}">
            <option value="">— pick a disposition —</option>
            ${STORE.DISPOSITIONS.map(x => `<option value="${x.id}" ${d === x.id ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}
          </select>
          <span class="carry-wrap" ${d === 'slip' ? '' : 'hidden'}>
            <span class="carry-lbl">bills in</span>
            <select class="carry-pick" data-key="${esc(r.key)}" aria-label="Carry month for ${esc(r.name)}">${carryOpts(r.carryTo)}</select>
          </span>
          ${r.suggested && !r.disposition ? `<div class="suggest">suggested: <b>${esc(STORE.DISPOSITION_LABEL(r.suggested))}</b></div>` : ''}
        </td>
      </tr>`;

      // Fee-share children — an indented deduction directly beneath the
      // billed figure they come out of.
      (r.children || []).forEach(fs => {
        h += `<tr class="fee-row">
          <td class="l">${feeLabel(fs.feeShare)} — ${esc(fs.name || 'co-broker')}</td>
          <td>—</td><td>—</td>
          <td class="fee-cell">${money(fs.feeShare)}</td>
          <td>—</td>
          <td class="fee-cell">${money(fs.recognised)}</td>
          <td>—</td><td class="l"><span class="tag fee">Fee share out</span></td>
        </tr>`;
      });
    });

    // Totals, stacked the way the number is actually built up.
    const flat = rows.concat(...rows.map(r => r.children || []));
    const sum = (f) => flat.reduce((a, r) => a + (f(r) || 0), 0);
    const planT = rows.reduce((a, r) => a + (r.plan || 0), 0);
    h += `</tbody><tfoot>
      <tr class="tot"><td class="l">Total</td>
        <td>${money(planT)}</td>
        <td>${money(sum(r => r.billed))}</td>
        <td>${money(sum(r => r.feeShare))}</td>
        <td>${money(sum(r => r.accrualDelta))}</td>
        <td>${money(sum(r => r.recognised))}</td>
        <td>${money(sum(r => r.recognised) - planT)}</td>
        <td></td></tr>
    </tfoot>`;
    t.innerHTML = h;

    $$('.disp-pick').forEach(sel => sel.addEventListener('change', () => {
      const key = sel.dataset.key;
      STORE.setLedgerDisposition(PERIOD, key, sel.value || null);
      const wrap = sel.parentElement.querySelector('.carry-wrap');
      if (wrap) wrap.hidden = sel.value !== 'slip';
      sel.classList.toggle('set', !!sel.value);
      sel.closest('tr').classList.toggle('ruled', !!sel.value);
      sel.closest('tr').classList.toggle('unruled', !sel.value);
      buildPeriodBar(); kpis(PERIOD);
    }));
    $$('.carry-pick').forEach(sel => sel.addEventListener('change', () => {
      STORE.setLedgerDisposition(PERIOD, sel.dataset.key, 'slip', { carryTo: sel.value || null });
    }));
  }

  /* ---------- YTD view: recognised revenue by month, per project ---------- */
  function renderYtd(ym) {
    const year = YEAR;
    const periods = STORE.ledgerPeriods().filter(p => splitYm(p).year === year);
    const t = $('#worksheet');
    if (!periods.length) { t.innerHTML = ''; $('#empty').hidden = false; return; }
    $('#empty').hidden = true;

    // Union of every project seen in any posted month of this year.
    const meta = {}, cells = {};
    periods.forEach(p => {
      periodRows(p).forEach(r => {
        meta[r.key] = meta[r.key] || { name: r.name, client: r.client, code: r.code, isFeeShare: r.isFeeShare, parentKey: r.parentKey };
        (cells[r.key] = cells[r.key] || {})[p] = r;
        (r.children || []).forEach(fs => {
          meta[fs.key] = meta[fs.key] || { name: fs.name, client: fs.client, code: fs.code, isFeeShare: true, parentKey: fs.parentKey };
          (cells[fs.key] = cells[fs.key] || {})[p] = fs;
        });
      });
    });

    let h = '<thead><tr><th class="l">Project</th>';
    MONTHS.forEach((m, i) => {
      const k = ymOf(year, i + 1);
      const posted = periods.includes(k);
      h += `<th class="${posted ? 'closed-h' : 'open-h'}">${m}<span class="sub">${posted ? 'ACTUAL' : '—'}</span></th>`;
    });
    h += '<th>YTD</th></tr></thead><tbody>';

    const order = Object.keys(meta).filter(k => !meta[k].isFeeShare)
      .sort((a, b) => (meta[a].name || '').localeCompare(meta[b].name || ''));

    const line = (key, isChild) => {
      const m = meta[key]; let tot = 0;
      let s = `<tr class="${isChild ? 'fee-row' : ''}"><td class="l">`;
      s += isChild ? `${feeLabel(((cells[key] || {})[periods[0]] || {}).feeShare || 0)} — ${esc(m.name || 'co-broker')}`
                   : `<div class="wp-name">${esc(m.name || '(unnamed)')}</div><div class="wp-meta">${esc(m.client || '—')}${m.code ? ' · ' + esc(m.code) : ''}</div>`;
      s += '</td>';
      MONTHS.forEach((_, i) => {
        const k = ymOf(year, i + 1);
        const r = (cells[key] || {})[k];
        if (!r) { s += `<td class="zero">—</td>`; return; }
        tot += r.recognised;
        const cls = r.disposition ? 's-' + (DISP_CLASS[r.disposition] || '') : '';
        s += `<td class="${cls}" title="${esc(STORE.DISPOSITION_LABEL(r.disposition) || 'no disposition')}">${r.recognised ? money(r.recognised) : '—'}</td>`;
      });
      return s + `<td class="strong">${money(tot)}</td></tr>`;
    };

    order.forEach(key => {
      h += line(key, false);
      Object.keys(meta).filter(k => meta[k].isFeeShare && meta[k].parentKey === key).forEach(fk => { h += line(fk, true); });
    });
    Object.keys(meta).filter(k => meta[k].isFeeShare && !meta[k].parentKey).forEach(fk => { h += line(fk, true); });

    // Three total lanes — the stack Finance reads.
    const laneTot = (label, cls, pick) => {
      let s = `<tr class="tot ${cls}"><td class="l">${label}</td>`, tot = 0;
      MONTHS.forEach((_, i) => {
        const k = ymOf(year, i + 1);
        if (!periods.includes(k)) { s += '<td>—</td>'; return; }
        const rows = periodRows(k);
        const flat = rows.concat(...rows.map(r => r.children || []));
        const v = flat.reduce((a, r) => a + (pick(r) || 0), 0);
        tot += v;
        s += `<td>${v ? money(v) : '—'}</td>`;
      });
      return s + `<td>${money(tot)}</td></tr>`;
    };
    h += '</tbody><tfoot>';
    h += laneTot('Billed gross', 'lane-bill', r => r.billed);
    h += laneTot('Fee share (net)', 'lane-fee', r => r.feeShare);
    h += laneTot('Accrual movement', 'lane-acc', r => r.accrualDelta);
    h += laneTot('Recognised revenue', '', r => r.recognised);
    h += '</tfoot>';
    t.innerHTML = h;
  }

  /* ---------- flash ---------- */
  function flashRows(ym) {
    const rows = periodRows(ym);
    const flat = [];
    rows.forEach(r => { flat.push(r); (r.children || []).forEach(fs => flat.push(fs)); });
    return flat;
  }

  function renderFlash(ym) {
    const rows = flashRows(ym).filter(r => r.recognised || r.billed || r.plan);
    const t = $('#flash-table');
    if (!rows.length) { t.innerHTML = ''; return; }
    let h = `<thead><tr>
      <th class="l">Project</th><th class="l">Client</th>
      <th>Plan</th><th>Billed gross</th><th>Fee share</th><th>Accrued</th>
      <th>Recognised</th><th>Variance</th><th class="l">Disposition</th></tr></thead><tbody>`;
    const tot = { plan: 0, billed: 0, fee: 0, acc: 0, rec: 0 };
    rows.sort((a, b) => Math.abs(b.recognised) - Math.abs(a.recognised)).forEach(r => {
      tot.plan += r.plan || 0; tot.billed += r.billed || 0; tot.fee += r.feeShare || 0;
      tot.acc += r.accrualDelta || 0; tot.rec += r.recognised || 0;
      const v = r.recognised - (r.plan || 0);
      h += `<tr class="${r.isFeeShare ? 'fee-row' : ''}">
        <td class="l">${r.isFeeShare ? feeLabel(r.feeShare) + ' — ' : ''}${esc(r.name || '')}</td>
        <td class="l">${esc(r.client || '—')}</td>
        <td>${r.plan ? money(r.plan) : '—'}</td>
        <td>${r.billed ? money(r.billed) : '—'}</td>
        <td class="${r.feeShare ? 'fee-cell' : ''}">${r.feeShare ? money(r.feeShare) : '—'}</td>
        <td class="${r.accrualDelta ? 'acc-cell' : ''}">${r.accrualDelta ? money(r.accrualDelta) : '—'}</td>
        <td class="strong">${money(r.recognised)}</td>
        <td class="${v < -0.5 ? 'neg' : v > 0.5 ? 'pos' : ''}">${Math.abs(v) > 0.5 ? money(v) : '—'}</td>
        <td class="l">${r.disposition ? `<span class="tag ${DISP_CLASS[r.disposition] || ''}">${esc(STORE.DISPOSITION_LABEL(r.disposition))}</span>` : '<span class="tag none">unruled</span>'}</td>
      </tr>`;
    });
    h += `</tbody><tfoot><tr class="tot"><td class="l">Total</td><td></td>
      <td>${money(tot.plan)}</td><td>${money(tot.billed)}</td><td>${money(tot.fee)}</td>
      <td>${money(tot.acc)}</td><td>${money(tot.rec)}</td><td>${money(tot.rec - tot.plan)}</td><td></td>
    </tr></tfoot>`;
    t.innerHTML = h;
  }

  /* ============================================================
     5 · EXCEL EXPORT — the flash, exactly as reconciled
     ============================================================ */
  async function exportFlash() {
    if (typeof ExcelJS === 'undefined') { alert('Excel library not loaded — reload the page and try again.'); return; }
    const ym = PERIOD;
    const per = STORE.getLedgerPeriod(ym);
    if (!per) { alert('Nothing to export — ' + ymLabel(ym) + ' has not been imported yet.'); return; }
    const rows = flashRows(ym);
    const NAVY = 'FF25273A', YEL = 'FFFFDF00', RED = 'FFCE181E', GRN = 'FF1F8A5B', AMB = 'FFC07A00', STEEL = 'FF79828C';
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Savills PPM · Revenue Reconciliation';

    /* --- Sheet 1: the flash --- */
    const ws = wb.addWorksheet(ymLabel(ym) + ' Flash');
    ws.mergeCells('A1:K1');
    ws.getCell('A1').value = `Savills PPM — Monthly Flash · ${ymLabel(ym)}`;
    ws.getCell('A1').font = { bold: true, size: 15, color: { argb: NAVY } };
    ws.mergeCells('A2:K2');
    ws.getCell('A2').value = `Close posted ${new Date(per.postedAt).toLocaleDateString()} by ${per.postedBy}`
      + (per.sourceFile ? ` · source: ${per.sourceFile}${per.sourceSheet ? ' / ' + per.sourceSheet : ''}` : '')
      + ` · exported ${new Date().toLocaleString()}`;
    ws.getCell('A2').font = { italic: true, size: 10, color: { argb: STEEL } };
    ws.addRow([]);

    const head = ws.addRow(['Project', 'Client', 'Project #', 'Plan', 'Billed gross', 'Fee share', 'Accrual movement', 'Recognised revenue', 'Variance vs plan', 'Disposition', 'Finance note']);
    head.eachCell(c => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      c.alignment = { horizontal: 'center', wrapText: true };
    });
    [1, 2, 3, 10, 11].forEach(i => head.getCell(i).alignment = { horizontal: 'left', wrapText: true });

    const fmt = '"$"#,##0;[Red]("$"#,##0)';
    const tot = { plan: 0, billed: 0, fee: 0, acc: 0, rec: 0 };
    rows.sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach(r => {
      tot.plan += r.plan || 0; tot.billed += r.billed || 0; tot.fee += r.feeShare || 0;
      tot.acc += r.accrualDelta || 0; tot.rec += r.recognised || 0;
      const v = r.recognised - (r.plan || 0);
      const row = ws.addRow([
        (r.isFeeShare ? '    ' + feeLabel(r.feeShare) + ' — ' : '') + (r.name || ''),
        r.client || '', r.code || '',
        r.plan || 0, r.billed || 0, r.feeShare || 0, r.accrualDelta || 0, r.recognised || 0, v,
        STORE.DISPOSITION_LABEL(r.disposition) || 'unruled', r.note || '',
      ]);
      [4, 5, 6, 7, 8, 9].forEach(i => row.getCell(i).numFmt = fmt);
      if (r.isFeeShare) {
        row.eachCell(c => { c.font = { italic: true, color: { argb: RED } }; });
      }
      row.getCell(6).font = { color: { argb: RED } };
      if (r.accrualDelta) row.getCell(7).font = { color: { argb: AMB } };
      row.getCell(8).font = { bold: true, color: { argb: NAVY } };
      if (Math.abs(v) > 0.5) row.getCell(9).font = { bold: true, color: { argb: v < 0 ? RED : GRN } };
      if (!r.disposition) row.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDF0D8' } };
    });

    const t = ws.addRow(['TOTAL', '', '', tot.plan, tot.billed, tot.fee, tot.acc, tot.rec, tot.rec - tot.plan, '', '']);
    t.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; });
    [4, 5, 6, 7, 8, 9].forEach(i => t.getCell(i).numFmt = fmt);
    t.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YEL } };
    t.getCell(8).font = { bold: true, color: { argb: NAVY } };
    ws.columns = [{ width: 46 }, { width: 30 }, { width: 12 }, { width: 15 }, { width: 15 }, { width: 14 }, { width: 18 }, { width: 20 }, { width: 17 }, { width: 26 }, { width: 52 }];
    ws.views = [{ state: 'frozen', ySplit: 4, xSplit: 1 }];

    /* --- Sheet 2: how the number is built --- */
    const rc = wb.addWorksheet('Reconciliation');
    rc.mergeCells('A1:C1');
    rc.getCell('A1').value = `How ${ymLabel(ym)} recognised revenue is built`;
    rc.getCell('A1').font = { bold: true, size: 14, color: { argb: NAVY } };
    rc.addRow([]);
    const pt = STORE.periodTotals(ym);
    const lines = [
      ['Billed gross (invoices out)', pt.billed, 'What the client was invoiced this month.'],
      ['Fee share (net)', pt.feeShare, 'Co-broker share. Billed to the client gross, but not Savills revenue.'],
      ['Accrual balance at close', pt.accrual, 'Earned, not yet invoiced.'],
      ['less: opening accrual balance', -pt.priorAccrual, 'Prior month\'s balance — accruals are balances, not flows.'],
      ['RECOGNISED REVENUE', pt.recognised, 'billed + fee share + accrual movement'],
    ];
    const rh = rc.addRow(['Line', 'Amount', 'What it is']);
    rh.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; });
    lines.forEach((l, i) => {
      const r = rc.addRow(l);
      r.getCell(2).numFmt = fmt;
      if (i === lines.length - 1) {
        r.eachCell(c => { c.font = { bold: true, color: { argb: NAVY } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YEL } }; });
      }
    });
    rc.columns = [{ width: 34 }, { width: 18 }, { width: 62 }];

    /* --- Sheet 3: still open --- */
    const open = STORE.openExceptions(ym);
    const ex = wb.addWorksheet('Open exceptions');
    ex.mergeCells('A1:E1');
    ex.getCell('A1').value = open.length ? `${open.length} line(s) awaiting a disposition` : 'No open exceptions — the month is fully reconciled.';
    ex.getCell('A1').font = { bold: true, size: 13, color: { argb: open.length ? RED : GRN } };
    ex.addRow([]);
    const eh = ex.addRow(['Project', 'Client', 'Project #', 'Recognised', 'Finance note']);
    eh.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; });
    const prevYm = STORE.priorLedgerPeriod(ym);
    const prevRows = prevYm ? (STORE.getLedgerPeriod(prevYm) || {}).rows || {} : {};
    open.forEach(o => {
      const r = ex.addRow([o.name || '', o.client || '', o.code || '',
        STORE.rowRecognised(o, (prevRows[o.key] || {}).accrual || 0), o.note || '']);
      r.getCell(4).numFmt = fmt;
    });
    ex.columns = [{ width: 46 }, { width: 30 }, { width: 12 }, { width: 16 }, { width: 60 }];

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Savills PPM Flash ${ym}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ============================================================
     6 · BOOT
     ============================================================ */
  function render() {
    buildPeriodBar();
    kpis(PERIOD);
    if (VIEW === 'month') renderMonth(PERIOD); else renderYtd(PERIOD);
    renderFlash(PERIOD);
    $('#view-month').classList.toggle('on', VIEW === 'month');
    $('#view-ytd').classList.toggle('on', VIEW === 'ytd');
    $('#worksheet').className = VIEW === 'month' ? 'ws month' : 'ws ytd';
    const per = STORE.getLedgerPeriod(PERIOD);
    $('#flash-card').hidden = !per;
    $('#remove-period').hidden = !per;
  }

  function boot() {
    // Loaded somewhere other than the reconciliation page (the test harness
    // pulls this file in for the parser alone) — expose the parser, do no UI.
    if (!$('#period-pick')) return;
    CATALOG = window.RATES_CATALOG;
    // Default to the most recent posted close, else last month — the flash is
    // always "for the month just finished".
    const posted = STORE.closedThrough();
    if (posted) { YEAR = +posted.slice(0, 4); PERIOD = posted; }
    else {
      const d = new Date(); d.setMonth(d.getMonth() - 1);
      YEAR = Math.max(STORE.LEDGER_FIRST_YEAR, d.getFullYear());
      PERIOD = YEAR === d.getFullYear() ? ymOf(YEAR, d.getMonth() + 1) : ymOf(YEAR, 1);
    }

    const clearPending = () => { PENDING = null; $('#sheet-row').hidden = true; $('#import-msg').innerHTML = ''; };
    $('#year-pick').addEventListener('change', e => { YEAR = +e.target.value; PERIOD = defaultPeriodFor(YEAR); clearPending(); render(); });
    $('#period-pick').addEventListener('change', e => { PERIOD = e.target.value; clearPending(); render(); });
    $('#view-month').addEventListener('click', () => { VIEW = 'month'; render(); });
    $('#view-ytd').addEventListener('click', () => { VIEW = 'ytd'; render(); });
    $('#flash-export').addEventListener('click', exportFlash);
    $('#remove-period').addEventListener('click', () => {
      if (!confirm(`Remove the posted close for ${ymLabel(PERIOD)}?\n\nThe figures and every disposition made against them are deleted. Re-importing starts the month over.`)) return;
      STORE.deleteLedgerPeriod(PERIOD);
      render();
    });
    wireImport();
    render();
  }

  /* Test surface — the workbook parser is pure (AOA in, rows out) and is the
     one piece that must not break when Finance's file changes shape. Exposed
     so tests.html can drive it against a real sheet without a DOM. */
  window.UFC_ReconcileParse = { parseSheet, findHeaderRow, mapColumns, rowKey, tokenScore, suggestDisposition };

  if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(boot);
  else document.addEventListener('DOMContentLoaded', boot);
})();
