/* ============================================================
   SAVILLS PPM · SMALL WORKS IMPORT — the Smartsheet export, reconciled
   ------------------------------------------------------------
   The JPMC small-works team keeps "INTERNAL - Macro Fee Tracking" in
   Smartsheet: one row per job, keyed by a Project ID (P-0001…), with the
   anticipated billing month, the invoice (Anticipated Billing), what was
   actually billed and paid to the vendor, and the Fee — Savills's 10%.

   This module takes the monthly Excel export of that sheet and:
     parseRows   → one entry per row, the money read into pass-through
                   lines (contractor WO billed at cost + markup; managed
                   vendor invoiced as the fee alone) and the sheet's
                   status read into the book's.
     buildPlan   → every entry matched to the book by Project ID (a
                   smallWorksId on the record, the legacy "Project ID:"
                   note, or the name) and classified: new, update, close,
                   cancel, same, skip; plus the book records the sheet no
                   longer carries.
     applyPlan   → the picked items, with the reviewer's edits (month,
                   fee, costs, status), written as projects.
   Nothing is written until applyPlan. The page is the review window.
   ============================================================ */
(function () {
  'use strict';
  const S = () => window.UFC_Store;
  const CLIENT = 'JPMC', PREFIX = 'SMALLWORKS - ', SWP = PREFIX, LEAD = 'bking';
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const r4 = (n) => Math.round((Number(n) || 0) * 1000000) / 1000000;   // markup %, six decimals, so a typed fee survives the round trip to the cent
  const norm = (h) => String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9%&]+/g, ' ').trim();
  const num = (v) => { if (v == null || v === '') return 0; if (typeof v === 'number') return isFinite(v) ? v : 0; if (typeof v === 'object' && v.result != null) return num(v.result); const n = parseFloat(String(v).replace(/[$,\s]/g, '')); return isFinite(n) ? n : 0; };
  const bool = (v) => { if (v === true) return true; if (v == null) return false; const s = String(typeof v === 'object' && v.result != null ? v.result : v).trim().toLowerCase(); return s === 'true' || s === '1' || s === 'yes' || s === 'x' || s === '✓'; };
  const text = (v) => { if (v == null) return ''; if (typeof v === 'object') { if (v.result != null) return text(v.result); if (v.richText) return v.richText.map(t => t.text).join(''); if (v instanceof Date) return v.toISOString().slice(0, 10); } return String(v).trim(); };

  /** The columns we read, by the export's header, tolerant of case, spacing and the sheet's spelling. */
  const HEADERS = {
    id: ['project id'], name: ['location & project name', 'location project name', 'project name'], region: ['region'], pmweb: ['pmweb id', 'pm web id'],
    committed: ['committed?', 'committed'], billed: ['billed?', 'billed'], status: ['status'], month: ['anticipated billing month'], closeOut: ['projected close out date', 'projected closeout date'],
    ab: ['anticipated billing'], actual: ['actual billing'], paid: ['paid to vendor'], fee: ['fee'],
    wo: ['contractor wo value blue anticipated', 'contractor wo value'], mv: ['managed vendor contract value'],
    closedOut: ['closed out bsk only', 'closed out'], likely: ['% likelyhood over 50%', '% likelihood over 50%', 'likelyhood over 50%', 'likelihood over 50%'],
    billedDate: ['billed date'], paidDate: ['billing paid date'], description: ['description'],
  };
  function mapHeaders(headers) {
    const idx = {}; const have = headers.map(norm);
    Object.keys(HEADERS).forEach(k => { for (const want of HEADERS[k]) { const i = have.indexOf(norm(want)); if (i >= 0) { idx[k] = i; break; } } });
    return idx;
  }
  /** "8- October 2026" → "2026-10"; also a bare "October 2026" or a date. */
  function ymOf(v) {
    const s = text(v); if (!s) return null;
    let m = /^(\d{4})-(\d{2})/.exec(s); if (m) return m[1] + '-' + m[2];
    m = /([a-z]+)\s+(\d{4})/i.exec(s); if (m) { const i = MONTHS.indexOf(m[1].toLowerCase()); if (i >= 0) return m[2] + '-' + String(i + 1).padStart(2, '0'); }
    const d = new Date(s); if (!isNaN(d)) return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    return null;
  }
  function statusKind(s) {
    const t = String(s || '').toLowerCase();
    if (!t) return '';
    if (/cancel|void/.test(t)) return 'cancelled';
    if (/on hold/.test(t)) return 'hold';
    if (/^completed?$/.test(t)) return 'completed';
    return 'open';
  }
  function typeOf(nm) {
    const s = String(nm).toLowerCase();
    if (/\bav\b|audio|visual|broadcast|technolog|infrastructure|cabling|network/.test(s)) return 'Technology & Infrastructure Deployment';
    if (/workstation|\bchair|\bseat|coat rack|furnitur|ff&e|bench|\bdesk|\bart\b|locker|casework/.test(s)) return 'Furniture, Equipment & Procurement';
    if (/reloc|\bmove\b|migration|restack|densif/.test(s)) return 'Relocation & Migration';
    return 'Capital Projects & Construction';
  }
  /** The money, as pass-through lines. The hidden WO / managed-vendor columns
      when the export carries them; else from the invoice and the fee: an
      invoice above the fee is a billed line (cost = invoice − fee), an invoice
      equal to the fee is a managed line (Savills invoices the fee alone). */
  function linesOf(e) {
    const out = []; const issues = [];
    const wo = r2(e.wo), mv = r2(e.mv), ab = r2(e.ab), fee = r2(e.fee);
    if (wo > 0 || mv > 0) {
      const base = wo + mv; const mk = fee > 0 ? r4(fee / base * 100) : 10;
      if (wo > 0) out.push({ mode: 'billed', cost: wo, markupPct: mk });
      if (mv > 0) out.push({ mode: 'managed', cost: mv, markupPct: mk });
      if (fee > 0 && Math.abs(mk - 10) > 0.5) issues.push('fee is ' + mk + '% of the contract values, not 10%');
    } else if (fee > 0 && ab > fee + 0.5) {
      const cost = r2(ab - fee); out.push({ mode: 'billed', cost, markupPct: r4(fee / cost * 100) });
      if (Math.abs(fee / cost * 100 - 10) > 0.5) issues.push('fee is ' + r2(fee / cost * 100) + '% of the cost, not 10%');
    } else if (fee > 0) {
      out.push({ mode: 'managed', cost: r2(fee / 0.1), markupPct: 10 });
      if (ab > 0 && Math.abs(ab - fee) > 0.5) issues.push('invoice below the fee');
    } else if (ab > 0) {
      out.push({ mode: 'billed', cost: ab, markupPct: 0 }); issues.push('invoice with no fee');
    }
    return { lines: out, issues };
  }
  const invoiceOf = (lines) => r2(lines.reduce((t, l) => t + (l.mode === 'managed' ? l.cost * l.markupPct / 100 : l.cost * (1 + l.markupPct / 100)), 0));
  const revenueOf = (lines) => r2(lines.reduce((t, l) => t + l.cost * l.markupPct / 100, 0));
  /** The sheet's state → the book's status and rating. */
  function bookStatus(e) {
    if (e.kind === 'cancelled') return { status: 'lost', rating: 7 };
    if (e.billed || e.closedOut) return { status: 'closed', rating: 1 };
    if (e.kind === 'completed' || e.committed) return { status: 'active', rating: 1 };
    if (e.kind === 'hold') return { status: 'hold', rating: 4 };
    return { status: 'submitted', rating: e.likely ? 2 : 4 };
  }

  /** rows: [{ headers: [...], values: [...] }] or arrays with the header row first. */
  function parseRows(rows) {
    let headers, body;
    if (rows && rows.headers) { headers = rows.headers; body = rows.values || []; }
    else { headers = (rows && rows[0]) || []; body = (rows || []).slice(1); }
    const idx = mapHeaders(headers);
    const missing = ['id', 'name', 'month', 'ab', 'fee'].filter(k => idx[k] == null);
    const get = (row, k) => idx[k] == null ? undefined : row[idx[k]];
    const entries = []; const seen = {};
    body.forEach((row, n) => {
      if (!row || !row.length) return;
      const id = text(get(row, 'id')).toUpperCase().replace(/\s+/g, '');
      const name = text(get(row, 'name'));
      if (!id && !name) return;
      const e = {
        row: n + 2, id, name, region: text(get(row, 'region')), pmweb: text(get(row, 'pmweb')), status: text(get(row, 'status')),
        committed: bool(get(row, 'committed')), billed: bool(get(row, 'billed')), likely: bool(get(row, 'likely')), closedOut: bool(get(row, 'closedOut')),
        ym: ymOf(get(row, 'month')) || ymOf(get(row, 'closeOut')), monthText: text(get(row, 'month')), closeOut: text(get(row, 'closeOut')),
        ab: r2(num(get(row, 'ab'))), actual: r2(num(get(row, 'actual'))), paid: r2(num(get(row, 'paid'))), fee: r2(num(get(row, 'fee'))), wo: r2(num(get(row, 'wo'))), mv: r2(num(get(row, 'mv'))),
        billedDate: text(get(row, 'billedDate')), paidDate: text(get(row, 'paidDate')), description: text(get(row, 'description')), issues: [],
      };
      e.kind = statusKind(e.status);
      if (!e.id) e.issues.push('no Project ID');
      else if (!/^P-\d+$/i.test(e.id)) e.issues.push('Project ID "' + e.id + '" is not P-nnnn');
      if (!e.name) e.issues.push('no project name');
      if (e.id && seen[e.id]) { e.issues.push('duplicate of row ' + seen[e.id]); } else if (e.id) seen[e.id] = e.row;
      const L = linesOf(e); e.lines = L.lines; e.issues.push(...L.issues);
      e.invoice = invoiceOf(e.lines); e.revenue = revenueOf(e.lines);
      if (!e.ym && e.kind !== 'cancelled') e.issues.push('no billing month (and no close-out date)');
      Object.assign(e, bookStatus(e));
      entries.push(e);
    });
    return { entries, headers, idx, missing };
  }

  /** The book record for an entry: by smallWorksId, then the legacy note, then the name. */
  function indexBook(projects) {
    const byId = {}, byName = {};
    (projects || []).forEach(p => {
      if (!p || p._deleted) return; const pj = p.project || {};
      const sid = String(pj.smallWorksId || '').toUpperCase(); if (sid && !byId[sid]) byId[sid] = p;
      const m = /Project ID:\s*(P-\d+)/i.exec(pj.notes || ''); if (m && !byId[m[1].toUpperCase()]) byId[m[1].toUpperCase()] = p;
      byName[String(pj.name || '').toLowerCase()] = p;
    });
    return { byId, byName };
  }
  function targetOf(e, existing) {
    const pj = (existing && existing.project) || {}; const ym = e.ym; const [y, m] = ym ? ym.split('-').map(Number) : [null, null];
    const monthly = {}; if (ym) monthly[ym] = 1;
    const lines = e.lines.map((l, i) => ({ id: l.mode === 'managed' ? 'sw-mv' : 'sw-wo', label: l.mode === 'managed' ? 'Managed vendor' : 'Contractor WO', cost: l.cost, markupPct: l.markupPct, mode: l.mode, monthly: ym ? { [ym]: l.cost } : {} }));
    return {
      project: Object.assign({}, pj, { name: pj.name || (PREFIX + e.name), client: CLIENT, status: e.status, rating: e.rating, smallWorksId: e.id, smallWorks: true,
        projectType: pj.projectType || typeOf(e.name), industry: pj.industry || 'Financial Services', lead: pj.lead || LEAD, clientRelOwner: pj.clientRelOwner || LEAD,
        notes: pj.notes || ('Project ID: ' + e.id + (e.pmweb ? ' · PMWeb: ' + e.pmweb : '') + (e.region ? ' · Region: ' + e.region : '')),
        sheet: { id: e.id, pmweb: e.pmweb, region: e.region, status: e.status, month: e.monthText, closeOut: e.closeOut, anticipatedBilling: e.ab, actualBilling: e.actual, paidToVendor: e.paid, fee: e.fee, committed: e.committed, billed: e.billed, billedDate: e.billedDate, paidDate: e.paidDate, likely: e.likely, closedOut: e.closedOut, row: e.row } }),
      timeline: ym ? { startYear: y, startMonth: m, endYear: y, endMonth: m, months: 1 } : (existing && existing.timeline) || null,
      phases: (existing && existing.phases) || [{ id: 'p1', name: 'Delivery', length: 1 }],
      groups: (existing && existing.groups) || [{ id: 'core', name: 'Core team' }],
      roles: (existing && existing.roles) || [],
      assumptions: (existing && existing.assumptions) || S().defaultAssumptions({ catalogBaseYear: 2024 }),
      passthrough: { enabled: lines.length > 0, lines },
      source: Object.assign({}, (existing && existing.source) || {}, { origin: 'smallworks', batch: 'Macro Fee Tracking export', importedAt: new Date().toISOString().slice(0, 10) }),
    };
  }
  const lineSig = (lines) => (lines || []).filter(l => l && (parseFloat(l.cost) || 0) > 0).map(l => (l.mode || 'billed') + ':' + r2(l.cost) + ':' + r2(l.markupPct)).sort().join('|');   // compared at 2dp: a markup that differs in the fourth decimal is the same line
  function buildPlan(parsed, projects) {
    const P = parsed.entries ? parsed : parseRows(parsed); const book = indexBook(projects || S().listProjects());
    const items = []; const seen = new Set();
    P.entries.forEach(e => {
      const existing = (e.id && book.byId[e.id]) || book.byName[(PREFIX + e.name).toLowerCase()] || null;
      if (existing) seen.add(existing.id);
      const blocking = e.issues.some(x => /no Project ID|not P-nnnn|duplicate|no project name/.test(x)) || (!e.ym && e.kind !== 'cancelled' && !existing);
      const target = blocking ? null : targetOf(e, existing);
      const changes = [];
      let kind;
      if (blocking) kind = 'skip';
      else if (!existing) kind = 'new';
      else {
        const pj = existing.project || {}; const tl = existing.timeline || {};
        const oldYm = tl.startYear ? tl.startYear + '-' + String(tl.startMonth).padStart(2, '0') : null;
        if (e.ym && oldYm !== e.ym) changes.push({ field: 'month', from: oldYm, to: e.ym });
        if (pj.status !== target.project.status) changes.push({ field: 'status', from: pj.status, to: target.project.status });
        if ((pj.rating || null) !== target.project.rating) changes.push({ field: 'rating', from: pj.rating || null, to: target.project.rating });
        if (lineSig((existing.passthrough || {}).lines) !== lineSig(target.passthrough.lines)) changes.push({ field: 'lines', from: lineSig((existing.passthrough || {}).lines) || '—', to: lineSig(target.passthrough.lines) || '—' });
        if (String(pj.name || '').toLowerCase() !== (SWP + e.name).toLowerCase()) e.issues.push('named "' + pj.name + '" in the book; the name is kept');
        if (e.kind === 'cancelled' && pj.status !== 'lost') kind = 'cancel';
        else if (target.project.status === 'closed' && pj.status !== 'closed') kind = 'close';
        else kind = changes.length ? 'update' : 'same';
      }
      items.push({ key: e.id || ('row' + e.row), entry: e, existing, target, kind, changes, issues: e.issues.slice(), picked: ['new', 'update', 'close', 'cancel'].includes(kind), edits: {} });
    });
    const fromSheet = (p) => { const pj = p.project || {}; return !!(pj.smallWorksId || /Project ID:\s*P-\d+/i.test(pj.notes || '') || ((p.source || {}).origin === 'smallworks')); };   // records that came from the sheet, not every project with "small works" in its name
    const missing = (projects || S().listProjects()).filter(p => p && !p._deleted && fromSheet(p) && !seen.has(p.id) && (p.project || {}).status !== 'lost' && (p.project || {}).status !== 'closed')
      .map(p => ({ key: 'missing:' + p.id, existing: p, kind: 'missing', entry: null, target: null, changes: [], issues: ['in the book, not in this export'], picked: false, edits: {} }));
    const counts = {}; items.concat(missing).forEach(i => { counts[i.kind] = (counts[i.kind] || 0) + 1; });
    return { items, missing, counts, headers: P.headers, missingHeaders: P.missing, revenue: r2(items.filter(i => i.kind !== 'skip' && i.entry && i.entry.kind !== 'cancelled').reduce((t, i) => t + i.entry.revenue, 0)) };
  }
  /** The reviewer's edits over the target: month, fee, the two costs, status. */
  function withEdits(item) {
    const t = JSON.parse(JSON.stringify(item.target)); const ed = item.edits || {}; const e = item.entry;
    let lines = t.passthrough.lines;
    if (ed.wo != null || ed.mv != null) {
      const wo = ed.wo != null ? r2(ed.wo) : (lines.find(l => l.mode === 'billed') || {}).cost || 0;
      const mv = ed.mv != null ? r2(ed.mv) : (lines.find(l => l.mode === 'managed') || {}).cost || 0;
      const mk = (lines[0] && lines[0].markupPct != null) ? lines[0].markupPct : 10;
      lines = []; if (wo > 0) lines.push({ id: 'sw-wo', label: 'Contractor WO', cost: wo, markupPct: mk, mode: 'billed', monthly: {} }); if (mv > 0) lines.push({ id: 'sw-mv', label: 'Managed vendor', cost: mv, markupPct: mk, mode: 'managed', monthly: {} });
    }
    if (ed.fee != null) {
      const fee = r2(ed.fee); const base = lines.reduce((s, l) => s + l.cost, 0);
      if (base > 0) lines.forEach(l => { l.markupPct = r4(fee / base * 100); });
      else if (fee > 0) lines = [{ id: 'sw-mv', label: 'Managed vendor', cost: r2(fee / 0.1), markupPct: 10, mode: 'managed', monthly: {} }];
    }
    const ym = ed.ym || e.ym || (t.timeline ? t.timeline.startYear + '-' + String(t.timeline.startMonth).padStart(2, '0') : null);
    if (ym) { const [y, m] = ym.split('-').map(Number); t.timeline = { startYear: y, startMonth: m, endYear: y, endMonth: m, months: 1 }; lines.forEach(l => { l.monthly = { [ym]: l.cost }; }); }
    t.passthrough = { enabled: lines.length > 0, lines };
    if (ed.status) { t.project.status = ed.status; if (ed.status === 'closed') t.project.rating = 1; if (ed.status === 'lost') t.project.rating = 7; }
    t.project.sheet.fee = r2(revenueOf(lines)); t.project.sheet.anticipatedBilling = ed.fee != null || ed.wo != null || ed.mv != null ? invoiceOf(lines) : t.project.sheet.anticipatedBilling;
    return t;
  }
  function applyPlan(plan, opts) {
    const o = opts || {}; const st = S(); const out = { created: 0, updated: 0, closed: 0, cancelled: 0, skipped: 0, ids: [] };
    plan.items.forEach(item => {
      if (!item.picked || !item.target) { out.skipped++; return; }
      const rec = withEdits(item);
      if (item.existing) rec.id = item.existing.id;
      const saved = st.saveProject(rec, { force: true });
      out.ids.push(saved.id);
      if (item.kind === 'new') out.created++; else if (item.kind === 'close') out.closed++; else if (item.kind === 'cancel') out.cancelled++; else out.updated++;
    });
    try { st.logSystem && st.logSystem('smallworks-import', { created: out.created, updated: out.updated, closed: out.closed, cancelled: out.cancelled, rows: plan.items.length, file: o.file || '', edited: plan.items.filter(i => i.picked && Object.keys(i.edits || {}).length).length }); } catch (e) {}
    return out;
  }
  /** The Excel export → rows for parseRows. The first sheet, the first row with a "Project ID" header. */
  async function readWorkbook(file) {
    await window.UFC_Vendor.excel();
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await file.arrayBuffer());
    let best = null;
    wb.eachSheet(ws => {
      if (best) return;
      let headerRow = 0; ws.eachRow((row, n) => { if (!headerRow && row.values.some(v => norm(text(v)) === 'project id')) headerRow = n; });
      if (!headerRow) return;
      const headers = ws.getRow(headerRow).values.slice(1).map(text);
      const values = []; ws.eachRow((row, n) => { if (n > headerRow) values.push(row.values.slice(1).map(v => (v && typeof v === 'object' && !(v instanceof Date) && v.result !== undefined) ? v.result : v)); });
      best = { headers, values, sheet: ws.name };
    });
    if (!best) throw new Error('No sheet with a "Project ID" column — is this the Macro Fee Tracking export?');
    return best;
  }
  window.UFC_SmallWorks = { parseRows, buildPlan, applyPlan, withEdits, readWorkbook, linesOf, ymOf, invoiceOf, revenueOf, HEADERS, PREFIX };
})();
