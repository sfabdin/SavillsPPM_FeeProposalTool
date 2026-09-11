/* ============================================================
   SAVILLS PPM · REVENUE RECONCILIATION (page controller)
   ------------------------------------------------------------
   Finance's own monthly book, built from the fee tool — no import.

   The unit is one project × one component × one month:
     Fee          what the client is billed for the fee (incl. the fee
                  on any pass-through)
     Pass-through the vendor cost billed through Savills and passed out, a minus
     Fee share    the broker / co-party cut, a minus

   Every month, an admin gives each line a STATUS — billed as planned,
   billed a different amount, accrued to a later month, slipped to a
   later month, written off — as many times as needed, then LOCKS the
   month. A locked month never changes here. If a project edit later
   moves a locked month's figure, it shows up red at the top of this
   page (and on the project) until an admin reopens the month.

   Leaders never see this page. They see the flags it puts on their
   projects: "billed a different amount — update the project", and
   "slipped — move the work".
   ============================================================ */
(function () {
  'use strict';
  const STORE = window.UFC_Store, CATALOG = window.RATES_CATALOG, Box = window.UFC_Box;
  const $ = (s, r) => (r || document).querySelector(s), $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const money = (n) => (n < 0 ? '−' : '') + '$' + Math.round(Math.abs(n || 0)).toLocaleString();
  const toast = (m, k) => { if (window.UFC_UI && window.UFC_UI.toast) window.UFC_UI.toast(m, k); else console.log(m); };
  const ym = (y, m) => y + '-' + String(m).padStart(2, '0');
  const ymLabel = (s) => { const [y, m] = String(s).split('-').map(Number); return MONTHS[m - 1] + ' ' + y; };
  const now = new Date();
  let YEAR = now.getFullYear(), M = now.getMonth() + 1, LEADER = '', Q = '';
  const STATUSES = STORE.RECON_STATUSES;
  const KIND_ORDER = { fee: 0, pass: 1, share: 2 };
  /** Label + kind of a line id on a project (fee, share, pt:<id>). */
  const infoFor = (p, id) => { const e = linesAll().find(x => x.p.id === p.id); return STORE.reconLineInfo(e ? e.lines : null, id); };
  const statusLabel = (id) => (STATUSES.find(s => s.id === id) || {}).label || '';

  const admin = () => STORE.isAdmin(STORE.getCurrentUser());

  /* ---------- data ---------- */
  let _lines = null, _linesRev = '';
  function projects() {
    return STORE.listProjects().filter(p => p && !p._deleted && !STORE.isChangeOrder(p));
  }
  /** Every project's three lines by month, cached per render. */
  function linesAll() {
    const ps = projects();
    const rev = ps.map(p => p.id + p.updatedAt).join('|');
    if (_lines && _linesRev === rev) return _lines;
    _lines = ps.map(p => ({ p, lines: STORE.reconLinesFor(p, CATALOG) }));
    _linesRev = rev;
    return _lines;
  }
  const leaderName = (p) => { const pj = p.project || {}; const l = STORE.resolveLeader && STORE.resolveLeader(pj.leadId || pj.lead); return l ? l.displayName : (pj.lead || ''); };
  const passes = (p) => {
    const pj = p.project || {};
    if (LEADER && leaderName(p) !== LEADER) return false;
    if (Q) { const q = Q.toLowerCase(); if (!((pj.client || '') + ' ' + (pj.name || '')).toLowerCase().includes(q)) return false; }
    return true;
  };
  /** Live snapshot of one month: { "pid|line": amount } across every project. */
  function liveSnapshot(y, m) {
    const key = ym(y, m), out = {};
    linesAll().forEach(({ p, lines }) => (lines.all || []).forEach(L => { const v = (L.byMonth || {})[key] || 0; if (Math.abs(v) > 0.005) out[p.id + '|' + L.id] = Math.round(v * 100) / 100; }));
    return out;
  }
  /** Rows for the month view: this month's earned lines, plus accruals from
      earlier months still open (or settled here). */
  function monthRows(y, m) {
    const key = ym(y, m), rows = [];
    const R = STORE.reconYear(y);
    linesAll().forEach(({ p, lines }) => {
      if (!passes(p)) return;
      const pj = p.project || {};
      (lines.all || []).forEach(L => {
        const v = (L.byMonth || {})[key] || 0;
        const cell = STORE.reconCell(y, p.id, L.id, key);
        if (Math.abs(v) > 0.005 || (cell && cell.status)) {
          rows.push({ kind: 'earned', p, pj, line: L.id, lkind: L.kind, label: L.label, ym: key, earned: v, cell: cell || null, leader: leaderName(p) });
        }
      });
      // a status set on a line that no longer prices (a removed pass-through line) still shows, so it is not lost
      Object.keys(R.cells || {}).forEach(k => {
        const [pid, line, cym] = k.split('|'); if (pid !== p.id || cym !== key) return;
        if ((lines.all || []).some(L => L.id === line)) return;
        const c = R.cells[k]; if (!c || !c.status) return;
        const info = STORE.reconLineInfo(lines, line);
        rows.push({ kind: 'earned', p, pj, line, lkind: info.kind, label: info.label + ' · no longer on the project', ym: key, earned: 0, cell: c, leader: leaderName(p) });
      });
    });
    // carry-ins: accrued earlier, not yet billed, or billed in this month
    Object.keys(R.cells || {}).forEach(k => {
      const c = R.cells[k]; if (!c || c.status !== 'accrued') return;
      const [pid, line, cym] = k.split('|');
      if (cym >= key) return;
      const settledHere = c.billedIn === key;
      const open = !c.billedIn;
      if (!settledHere && !open) return;
      const rec = STORE.getProject(pid); if (!rec || !passes(rec)) return;
      const info = infoFor(rec, line);
      const amt = c.amount != null ? c.amount : ((info.byMonth || {})[cym] || 0);
      rows.push({ kind: 'carry', p: rec, pj: rec.project || {}, line, lkind: info.kind, label: info.label, ym: key, fromYm: cym, earned: 0, carry: amt, cell: c, leader: leaderName(rec), settledHere });
    });
    rows.sort((a, b) => (a.pj.client || '').localeCompare(b.pj.client || '') || (a.pj.name || '').localeCompare(b.pj.name || '') || (KIND_ORDER[a.lkind] || 0) - (KIND_ORDER[b.lkind] || 0) || (a.label || '').localeCompare(b.label || ''));
    return rows;
  }
  /** Billed and accrued lanes by month for the year, from the cells. */
  function lanes(y) {
    const billed = {}, accrued = {}, earned = {}, share = {}, pass = {};
    for (let m = 1; m <= 12; m++) { billed[m] = 0; accrued[m] = 0; earned[m] = 0; share[m] = 0; pass[m] = 0; }
    const R = STORE.reconYear(y);
    linesAll().forEach(({ p, lines }) => {
      if (!passes(p)) return;
      for (let m = 1; m <= 12; m++) {
        const key = ym(y, m);
        (lines.all || []).forEach(L => {
          const v = (L.byMonth || {})[key] || 0; if (!v) return;
          if (L.kind !== 'pass') earned[m] += v;                    // ours: fee (incl. the fee on pass-through) + fee shares (minuses)
          if (L.kind === 'share') share[m] += v; if (L.kind === 'pass') { pass[m] += v; return; }   // the pass-through is a wash — not billed/accrued revenue
          const c = STORE.reconCell(y, p.id, L.id, key);
          const st = c && c.status;
          if (!st || st === 'billed') billed[m] += v;
          else if (st === 'billed-diff') billed[m] += (c.amount != null ? c.amount : v);
          else if (st === 'accrued') {
            accrued[m] += (c.amount != null ? c.amount : v);
            if (c.billedIn) { const [, bm] = c.billedIn.split('-').map(Number); if (c.billedIn.startsWith(String(y)) && bm) { billed[bm] += (c.billedAmount != null ? c.billedAmount : (c.amount != null ? c.amount : v)); accrued[bm] -= (c.amount != null ? c.amount : v); } }
          }
          // slipped / writeoff: nothing billed or accrued in this month
        });
      }
    });
    return { billed, accrued, earned, share, pass };
  }
  function lockFlags(y) {
    const R = STORE.reconYear(y); const out = [];
    Object.keys(R.months || {}).forEach(ms => {
      const mm = R.months[ms]; if (!mm || !mm.lockedAt) return;
      const live = liveSnapshot(y, +ms);
      const snap = mm.snapshot || {};
      const keys = new Set([...Object.keys(snap), ...Object.keys(live)]);
      keys.forEach(k => {
        const was = snap[k] || 0, is = live[k] || 0;
        if (Math.abs(was - is) <= 0.5) return;
        const [pid, line] = k.split('|'); const p = STORE.getProject(pid); const info = p ? infoFor(p, line) : { label: line, kind: 'fee' };
        out.push({ ym: ym(y, +ms), m: +ms, pid, line, label: info.label, lkind: info.kind, was, now: is, p, name: p ? ((p.project || {}).name || pid) : pid, client: p ? ((p.project || {}).client || '') : '',
                   by: p && p.lastSavedBy ? (p.lastSavedBy.name || p.lastSavedBy.username) : '', at: p ? p.updatedAt : '' });
      });
    });
    return out.sort((a, b) => a.ym.localeCompare(b.ym) || a.name.localeCompare(b.name));
  }
  const unruled = (rows) => rows.filter(r => r.kind === 'earned' && !(r.cell && r.cell.status)).length;

  /* ---------- render ---------- */
  function render() {
    const host = $('#recon'); if (!host) return;
    if (!admin()) { host.innerHTML = '<div class="panel"><h2>Admins only</h2><p class="sub">Revenue Reconciliation is Finance\'s book. Leaders see its flags on their own projects in the calculator.</p></div>'; return; }
    const years = yearsAvailable();
    const R = STORE.reconYear(YEAR);
    const flags = lockFlags(YEAR);
    const rows = monthRows(YEAR, M);
    const mm = STORE.reconMonth(YEAR, M);
    const locked = !!(mm && mm.lockedAt);
    let h = '';
    // ---- header bar ----
    h += '<div class="rc-bar"><div class="rc-year"><label for="rc-year">Year</label><select id="rc-year">' + years.map(y => '<option value="' + y + '"' + (y === YEAR ? ' selected' : '') + '>' + y + '</option>').join('') + '</select></div>' +
      '<div class="rc-strip">' + Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
        const meta = STORE.reconMonth(YEAR, m); const lk = !!(meta && meta.lockedAt);
        const fl = flags.filter(f => f.m === m).length;
        const un = m === M ? unruled(rows) : unruled(monthRows(YEAR, m));
        return '<button class="rc-mo' + (m === M ? ' on' : '') + (lk ? ' locked' : '') + (fl ? ' flagged' : '') + '" data-m="' + m + '" title="' + MONTHS_LONG[m - 1] + (lk ? ' · locked ' + esc(fmtStamp(meta.lockedAt)) : ' · open') + (fl ? ' · ' + fl + ' change' + (fl === 1 ? '' : 's') + ' since lock' : '') + '">' +
          '<span class="mo">' + MONTHS[m - 1] + '</span><span class="st">' + (lk ? '🔒' : (un ? un + ' open' : (m > (YEAR === now.getFullYear() ? now.getMonth() + 1 : 12) ? '' : '✓'))) + '</span>' + (fl ? '<span class="fl">' + fl + '</span>' : '') + '</button>';
      }).join('') + '</div>' +
      '<div class="rc-actions">' + (locked
        ? '<span class="pill n"><i></i>Locked ' + esc(fmtStamp(mm.lockedAt)) + (mm.lockedByName ? ' by ' + esc(mm.lockedByName) : '') + '</span> <button class="btn btn-ghost" id="rc-reopen">Reopen ' + MONTHS[M - 1] + '</button>'
        : '<button class="btn btn-primary" id="rc-lock">Lock ' + MONTHS_LONG[M - 1] + ' ' + YEAR + '</button>') +
      ' <button class="btn btn-secondary" id="rc-flash">⤓ Flash · ' + MONTHS[M - 1] + ' ' + YEAR + '</button></div></div>';
    // ---- flags ----
    if (flags.length) {
      h += '<div class="rc-flags"><div class="rc-flags-h">⚠ ' + flags.length + ' change' + (flags.length === 1 ? '' : 's') + ' to locked month' + (new Set(flags.map(f => f.m)).size === 1 ? '' : 's') + ' since the lock</div>' +
        '<table class="cb-table rc-flag-table"><thead><tr><th>Month</th><th>Client</th><th>Project</th><th>Line</th><th class="money">Locked at</th><th class="money">Now</th><th class="money">Change</th><th>Last saved</th><th></th></tr></thead><tbody>' +
        flags.map(f => '<tr><td><b>' + esc(ymLabel(f.ym)) + '</b></td><td>' + esc(f.client) + '</td><td><a href="Universal Fee Calculator.html?id=' + encodeURIComponent(f.pid) + '">' + esc(f.name) + '</a></td><td class="ln-' + f.lkind + '">' + esc(f.label) + '</td>' +
          '<td class="money">' + money(f.was) + '</td><td class="money">' + money(f.now) + '</td><td class="money ' + (f.now - f.was < 0 ? 'neg' : 'pos') + '"><b>' + money(f.now - f.was) + '</b></td><td>' + esc(f.by || '—') + (f.at ? '<div class="sub">' + esc(fmtStamp(f.at)) + '</div>' : '') + '</td>' +
          '<td>' + (f.m === M ? '' : '<button class="btn btn-ghost small" data-goto="' + f.m + '">Open ' + MONTHS[f.m - 1] + '</button>') + '</td></tr>').join('') +
        '</tbody></table><div class="sub">A locked month does not change here. To accept a change, <b>reopen the month</b>, re-check the statuses, and lock it again. Until then the flash for that month is what was locked.</div></div>';
    }
    // ---- KPIs ----
    const own = rows.filter(r => r.kind === 'earned');
    const tot = (kind) => own.filter(r => r.lkind === kind).reduce((t, r) => t + r.earned, 0);
    const billedToClient = tot('fee') - tot('pass');          // pass is negative: the vendor cost the client was invoiced
    const ours = tot('fee') + tot('share');                   // the pass-through is a wash; the fee on it is already in fee
    const billedNow = own.reduce((t, r) => { const st = r.cell && r.cell.status; if (!st || st === 'billed') return t + r.earned; if (st === 'billed-diff') return t + (r.cell.amount != null ? r.cell.amount : r.earned); return t; }, 0)
      + rows.filter(r => r.kind === 'carry' && r.settledHere).reduce((t, r) => t + (r.cell.billedAmount != null ? r.cell.billedAmount : r.carry), 0);
    const accruedNow = own.filter(r => r.cell && r.cell.status === 'accrued').reduce((t, r) => t + (r.cell.amount != null ? r.cell.amount : r.earned), 0);
    const carryOpen = rows.filter(r => r.kind === 'carry' && !r.settledHere).reduce((t, r) => t + r.carry, 0);
    h += '<div class="kpis rc-kpis">' +
      kpi(money(billedToClient), 'billed to client · ' + MONTHS[M - 1]) + kpi('<span class="teal">' + money(tot('pass')) + '</span>', 'pass-through out · to vendors') + kpi('<span class="red">' + money(tot('share')) + '</span>', 'fee share out · to brokers') +
      kpi('<b>' + money(ours) + '</b>', 'Savills revenue · fee incl. the fee on pass-through, less fee share') +
      kpi(money(billedNow), 'billed this month · incl. accruals settling') + kpi(money(accruedNow), 'accrued this month') + kpi(money(carryOpen), 'earlier accruals still open') +
      kpi(String(unruled(rows)), 'lines without a status') + '</div>';
    // ---- filters ----
    h += '<div class="rc-filt"><input type="search" id="rc-q" placeholder="Search client or project" value="' + esc(Q) + '"><select id="rc-leader"><option value="">All revenue leaders</option>' +
      [...new Set(projects().map(leaderName).filter(Boolean))].sort().map(l => '<option value="' + esc(l) + '"' + (l === LEADER ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>' +
      '<span class="sub">' + rows.length + ' line' + (rows.length === 1 ? '' : 's') + (locked ? ' · locked — read only' : '') + '</span></div>';
    // ---- month table ----
    h += '<div class="panel"><div class="tw"><table class="cb-table rc-table"><thead><tr><th>Client</th><th>Project</th><th>Leader</th><th>Line</th><th class="money">Earned · ' + MONTHS[M - 1] + '</th><th>Status</th><th class="money">Billed amount</th><th>Month</th><th>Note</th></tr></thead><tbody>';
    if (!rows.length) h += '<tr><td colspan="9" class="sub">Nothing earned in ' + MONTHS_LONG[M - 1] + ' ' + YEAR + (LEADER || Q ? ' for this filter' : '') + '.</td></tr>';
    rows.forEach((r, i) => {
      const c = r.cell || {}; const st = c.status || '';
      const dis = locked ? ' disabled' : '';
      const id = r.p.id;
      if (r.kind === 'carry') {
        const amt = r.cell.billedAmount != null ? r.cell.billedAmount : r.carry;
        h += '<tr class="rc-carry ln-' + r.lkind + (r.settledHere ? ' settled' : '') + '"><td>' + esc(r.pj.client || '') + '</td><td><a href="Universal Fee Calculator.html?id=' + encodeURIComponent(id) + '">' + esc(r.pj.name || 'Untitled') + '</a><div class="sub">accrued in <b>' + esc(ymLabel(r.fromYm)) + '</b>' + (r.cell.billsIn ? ' · expected ' + esc(ymLabel(r.cell.billsIn)) : '') + '</div></td><td>' + esc(r.leader) + '</td><td>' + esc(r.label) + ' <span class="pill y"><i></i>carry-in</span></td>' +
          '<td class="money"><span class="sub">' + money(r.carry) + ' accrued</span></td>' +
          '<td><select class="rc-settle" data-pid="' + esc(id) + '" data-line="' + esc(r.line) + '" data-from="' + esc(r.fromYm) + '"' + dis + '><option value=""' + (r.settledHere ? '' : ' selected') + '>Still accrued</option><option value="billed"' + (r.settledHere ? ' selected' : '') + '>Billed in ' + MONTHS[M - 1] + '</option></select></td>' +
          '<td class="money"><input class="rc-amt" type="number" step="1" data-pid="' + esc(id) + '" data-line="' + esc(r.line) + '" data-from="' + esc(r.fromYm) + '" data-settle="1" value="' + (r.settledHere ? Math.round(amt) : '') + '"' + (r.settledHere && !locked ? '' : ' disabled') + ' placeholder="' + Math.round(r.carry) + '"></td>' +
          '<td>' + (r.settledHere ? '<span class="pill g"><i></i>settles here</span>' : '<span class="sub">open</span>') + '</td><td><div class="rc-note" contenteditable="' + (locked ? 'false' : 'true') + '" data-pid="' + esc(id) + '" data-line="' + esc(r.line) + '" data-ym="' + esc(r.fromYm) + '">' + esc(c.note || '') + '</div></td></tr>';
        return;
      }
      const needsAmt = st === 'billed-diff', needsMonth = st === 'accrued' || st === 'slipped';
      const target = st === 'accrued' ? (c.billsIn || '') : st === 'slipped' ? (c.earnedIn || '') : '';
      h += '<tr class="' + (st ? 'st-' + st : 'st-none') + ' ln-' + r.lkind + '"><td>' + esc(r.pj.client || '') + '</td><td><a href="Universal Fee Calculator.html?id=' + encodeURIComponent(id) + '">' + esc(r.pj.name || 'Untitled') + '</a>' + (c.flagged ? '<div class="sub red">flag on the project</div>' : '') + '</td><td>' + esc(r.leader) + '</td><td>' + esc(r.label) + '</td>' +
        '<td class="money' + (r.earned < 0 ? ' neg' : '') + '">' + money(r.earned) + '</td>' +
        '<td><select class="rc-status" data-pid="' + esc(id) + '" data-line="' + esc(r.line) + '"' + dis + '><option value="">— status —</option>' + STATUSES.map(s => '<option value="' + s.id + '"' + (st === s.id ? ' selected' : '') + '>' + esc(s.label) + '</option>').join('') + '</select></td>' +
        '<td class="money"><input class="rc-amt" type="number" step="1" data-pid="' + esc(id) + '" data-line="' + esc(r.line) + '" value="' + (needsAmt && c.amount != null ? Math.round(c.amount) : '') + '"' + (needsAmt && !locked ? '' : ' disabled') + ' placeholder="' + Math.round(r.earned) + '"></td>' +
        '<td>' + (needsMonth ? '<select class="rc-month" data-pid="' + esc(id) + '" data-line="' + esc(r.line) + '"' + dis + '><option value="">— month —</option>' + monthOptions(r.ym, target) + '</select>' : '<span class="sub">—</span>') + '</td>' +
        '<td><div class="rc-note" contenteditable="' + (locked ? 'false' : 'true') + '" data-pid="' + esc(id) + '" data-line="' + esc(r.line) + '" data-ym="' + esc(r.ym) + '" data-ph="What happened">' + esc(c.note || '') + '</div></td></tr>';
    });
    h += '</tbody></table></div></div>';
    // ---- year lanes ----
    const L = lanes(YEAR);
    const laneRow = (label, lane, cls) => '<tr class="' + (cls || '') + '"><td><b>' + label + '</b></td>' + MONTHS.map((_, i) => { const v = lane[i + 1] || 0; const meta = STORE.reconMonth(YEAR, i + 1); return '<td class="money' + (v < 0 ? ' neg' : '') + (meta && meta.lockedAt ? ' lk' : '') + '">' + (Math.abs(v) > 0.5 ? money(v) : '·') + '</td>'; }).join('') + '<td class="money"><b>' + money(Object.values(lane).reduce((a, b) => a + b, 0)) + '</b></td></tr>';
    h += '<div class="panel"><div class="ph"><h3>' + YEAR + ' · billed and accrued by month</h3><span class="sub">Billed carries earlier accruals settling; Accrued shows this month\'s own accruals less any settling (the minus). Pass-through and fee share are money out. Locked months are shaded.</span></div>' +
      '<div class="tw"><table class="cb-table rc-year"><thead><tr><th></th>' + MONTHS.map((mn, i) => { const meta = STORE.reconMonth(YEAR, i + 1); return '<th class="money' + (meta && meta.lockedAt ? ' lk' : '') + '">' + mn + (meta && meta.lockedAt ? ' 🔒' : '') + '</th>'; }).join('') + '<th class="money">Year</th></tr></thead><tbody>' +
      laneRow('Savills revenue · fee less fee share', L.earned) + laneRow('Billed', L.billed, 'lane-billed') + laneRow('Accrued (net)', L.accrued, 'lane-accrued') + laneRow('Fee share out', L.share, 'lane-share') + laneRow('Pass-through out · to vendors', L.pass, 'lane-pass') +
      '</tbody></table></div></div>';
    host.innerHTML = h;
    wire(host, locked);
  }
  function kpi(v, s) { return '<div class="kpi"><div class="v">' + v + '</div><div class="s">' + s + '</div></div>'; }
  function monthOptions(fromYm, selected) {
    const [y, m] = fromYm.split('-').map(Number); const out = [];
    for (let i = 1; i <= 18; i++) { const d = new Date(y, m - 1 + i, 1); const v = ym(d.getFullYear(), d.getMonth() + 1); out.push('<option value="' + v + '"' + (v === selected ? ' selected' : '') + '>' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + '</option>'); }
    return out.join('');
  }
  function yearsAvailable() {
    const ys = new Set([now.getFullYear()]);
    linesAll().forEach(({ lines }) => (lines.all || []).forEach(L => Object.keys(L.byMonth || {}).forEach(k => ys.add(+k.slice(0, 4)))));
    Object.keys(STORE.reconYears ? STORE.reconYears() : {}).forEach(y => ys.add(+y));
    return [...ys].filter(y => y >= 2025 && y <= now.getFullYear() + 2).sort();
  }
  function fmtStamp(iso) { const d = new Date(iso); if (isNaN(d)) return ''; return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(); }
  const flush = () => { if (Box && Box.enabled && Box.flushRevenue) Box.flushRevenue().catch(() => {}); };

  function wire(host, locked) {
    $('#rc-year', host).addEventListener('change', e => { YEAR = +e.target.value; render(); });
    $$('.rc-mo', host).forEach(b => b.addEventListener('click', () => { M = +b.dataset.m; render(); }));
    $$('[data-goto]', host).forEach(b => b.addEventListener('click', () => { M = +b.dataset.goto; render(); }));
    $('#rc-q', host).addEventListener('input', e => { Q = e.target.value; render(); const q = $('#rc-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } });
    $('#rc-leader', host).addEventListener('change', e => { LEADER = e.target.value; render(); });
    const lockBtn = $('#rc-lock', host);
    if (lockBtn) lockBtn.addEventListener('click', () => {
      const open = unruled(monthRows(YEAR, M));
      const msg = 'Lock ' + MONTHS_LONG[M - 1] + ' ' + YEAR + '?\n\nEvery line\'s figure is frozen as it stands now. Nothing in this month can be changed here afterwards; a project edit that moves a locked figure shows up red at the top of this page until you reopen the month.' + (open ? '\n\n' + open + ' line' + (open === 1 ? ' has' : 's have') + ' no status yet.' : '');
      if (!confirm(msg)) return;
      if (!(CATALOG && CATALOG.hydrated)) { toast('The rate card has not loaded yet — the snapshot would be wrong. Try again in a moment.'); return; }
      _lines = null;   // price every line fresh for the snapshot
      try { STORE.lockReconMonth(YEAR, M, liveSnapshot(YEAR, M)); flush(); toast(MONTHS_LONG[M - 1] + ' ' + YEAR + ' locked.', 'ok'); } catch (e) { toast(e.message); }
      render();
    });
    const reopenBtn = $('#rc-reopen', host);
    if (reopenBtn) reopenBtn.addEventListener('click', () => {
      if (!confirm('Reopen ' + MONTHS_LONG[M - 1] + ' ' + YEAR + '?\n\nThe month becomes editable again and its flags clear once you lock it anew. The previous lock is kept in the trail.')) return;
      try { STORE.reopenReconMonth(YEAR, M); flush(); toast(MONTHS_LONG[M - 1] + ' reopened.', 'ok'); } catch (e) { toast(e.message); }
      render();
    });
    $('#rc-flash', host).addEventListener('click', () => exportFlash().catch(e => toast('Export failed: ' + (e.message || e))));
    if (locked) return;
    $$('.rc-status', host).forEach(sel => sel.addEventListener('change', () => {
      const pid = sel.dataset.pid, line = sel.dataset.line, key = ym(YEAR, M);
      const st = sel.value || null;
      const row = linesAll().find(x => x.p.id === pid); const Lx = row ? (row.lines.all || []).find(x => x.id === line) : null; const earned = Lx ? ((Lx.byMonth || {})[key] || 0) : 0;
      try { STORE.setReconStatus(YEAR, pid, line, key, st, { earned }); flush(); } catch (e) { toast(e.message); }
      render();
    }));
    $$('.rc-amt', host).forEach(inp => inp.addEventListener('change', () => {
      const pid = inp.dataset.pid, line = inp.dataset.line; const v = inp.value === '' ? null : Number(inp.value);
      try {
        if (inp.dataset.settle) STORE.settleReconAccrual(YEAR, pid, line, inp.dataset.from, { billedIn: ym(YEAR, M), amount: v });
        else STORE.setReconStatus(YEAR, pid, line, ym(YEAR, M), 'billed-diff', { amount: v });
        flush();
      } catch (e) { toast(e.message); }
      render();
    }));
    $$('.rc-month', host).forEach(sel => sel.addEventListener('change', () => {
      const pid = sel.dataset.pid, line = sel.dataset.line, key = ym(YEAR, M);
      const c = STORE.reconCell(YEAR, pid, line, key) || {}; const st = c.status;
      try { STORE.setReconStatus(YEAR, pid, line, key, st, st === 'accrued' ? { billsIn: sel.value || null } : { earnedIn: sel.value || null }); flush(); } catch (e) { toast(e.message); }
      render();
    }));
    $$('.rc-settle', host).forEach(sel => sel.addEventListener('change', () => {
      const pid = sel.dataset.pid, line = sel.dataset.line, from = sel.dataset.from;
      try { STORE.settleReconAccrual(YEAR, pid, line, from, sel.value === 'billed' ? { billedIn: ym(YEAR, M) } : { billedIn: null }); flush(); } catch (e) { toast(e.message); }
      render();
    }));
    $$('.rc-note', host).forEach(el => {
      el.addEventListener('focus', () => { el.dataset.before = el.textContent.trim(); });
      el.addEventListener('blur', () => {
        const v = el.textContent.trim(); if (v === (el.dataset.before || '')) return;
        try { STORE.setReconNote(YEAR, el.dataset.pid, el.dataset.line, el.dataset.ym, v); flush(); } catch (e) { toast(e.message); }
      });
    });
  }

  /* ---------- flash export ---------- */
  async function exportFlash() {
    await window.UFC_Vendor.excel();
    if (typeof ExcelJS === 'undefined') { toast('Excel library not loaded.'); return; }
    const rows = monthRows(YEAR, M), mm = STORE.reconMonth(YEAR, M);
    const NAVY = 'FF25273A', YEL = 'FFFFDF00', RED = 'FFCE181E', STEEL = 'FF79828C', WHITE = 'FFFFFFFF', CREAM = 'FFEEE8E3';
    const fmt = '#,##0;[Red]-#,##0;"·"';
    const wb = new ExcelJS.Workbook(); wb.creator = 'Savills PPM · Revenue Reconciliation'; wb.calcProperties = { fullCalcOnLoad: true };
    const head = (ws, labels) => { const r = ws.addRow(labels); r.eachCell(c => { c.font = { name: 'Calibri', bold: true, color: { argb: WHITE } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; }); return r; };
    // ---- Sheet 1: the month ----
    const ws = wb.addWorksheet(MONTHS[M - 1] + ' ' + YEAR + ' Flash', { views: [{ state: 'frozen', ySplit: 4 }] });
    ws.mergeCells('A1:M1'); ws.getCell('A1').value = 'Savills PPM — Revenue Flash · ' + MONTHS_LONG[M - 1] + ' ' + YEAR; ws.getCell('A1').font = { name: 'Calibri', bold: true, size: 16, color: { argb: NAVY } };
    ws.mergeCells('A2:M2'); ws.getCell('A2').value = (mm && mm.lockedAt ? 'LOCKED ' + fmtStamp(mm.lockedAt) + (mm.lockedByName ? ' by ' + mm.lockedByName : '') : 'Working copy — not locked') + ' · exported ' + new Date().toLocaleString() + (LEADER ? ' · leader: ' + LEADER : ''); ws.getCell('A2').font = { name: 'Calibri', italic: true, size: 10, color: { argb: mm && mm.lockedAt ? NAVY : RED } };
    ws.addRow([]);
    head(ws, ['Client', 'Project', 'Revenue leader', 'Line', 'Kind', 'Earned', 'Status', 'Billed', 'Accrued', 'Pass-through out', 'Fee share out', 'Bill / earn month', 'Note']);
    const r0 = 5;
    rows.forEach(r => {
      const c = r.cell || {}; const st = c.status || '';
      let billed = 0, accrued = 0, share = 0, pass = 0, target = '';
      if (r.kind === 'carry') { billed = r.settledHere ? (c.billedAmount != null ? c.billedAmount : r.carry) : 0; accrued = r.settledHere ? -r.carry : 0; target = c.billsIn ? ymLabel(c.billsIn) : ''; }
      else if (r.lkind === 'share') { share = r.earned; }
      else if (r.lkind === 'pass') { pass = r.earned; }
      else if (!st || st === 'billed') billed = r.earned;
      else if (st === 'billed-diff') billed = c.amount != null ? c.amount : r.earned;
      else if (st === 'accrued') { accrued = c.amount != null ? c.amount : r.earned; target = c.billsIn ? ymLabel(c.billsIn) : ''; }
      else if (st === 'slipped') target = c.earnedIn ? ymLabel(c.earnedIn) : '';
      const x = ws.addRow([r.pj.client || '', r.pj.name || 'Untitled', r.leader, r.label, r.kind === 'carry' ? 'Carry-in · accrued ' + ymLabel(r.fromYm) : 'Earned this month',
        r.kind === 'carry' ? null : r.earned, r.kind === 'carry' ? (r.settledHere ? 'Billed here' : 'Still accrued') : (statusLabel(st) || 'no status'), billed || null, accrued || null, pass || null, share || null, target, c.note || '']);
      [6, 8, 9, 10, 11].forEach(i => { x.getCell(i).numFmt = fmt; x.getCell(i).alignment = { horizontal: 'right' }; });
      if (!st && r.kind === 'earned') x.getCell(7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDF0D8' } };
      if (r.lkind === 'share') x.eachCell(cell => { cell.font = { name: 'Calibri', color: { argb: RED } }; });
      if (r.lkind === 'pass') x.eachCell(cell => { cell.font = { name: 'Calibri', color: { argb: 'FF0E7C7B' } }; });
    });
    const r1 = r0 + rows.length - 1;
    const tot = ws.addRow(['TOTAL', '', '', '', '', null, '', null, null, null, null, '', '']);
    [6, 8, 9, 10, 11].forEach(i => { const L = String.fromCharCode(64 + i); tot.getCell(i).value = rows.length ? { formula: `SUM(${L}${r0}:${L}${r1})` } : 0; tot.getCell(i).numFmt = fmt; });
    tot.eachCell(c => { c.font = { name: 'Calibri', bold: true, color: { argb: WHITE } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; });
    tot.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YEL } }; tot.getCell(8).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
    ws.columns = [{ width: 24 }, { width: 40 }, { width: 20 }, { width: 16 }, { width: 24 }, { width: 14 }, { width: 28 }, { width: 14 }, { width: 14 }, { width: 15 }, { width: 13 }, { width: 14 }, { width: 50 }];
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(r1, r0), column: 13 } };
    // by-client summary via SUMIFS
    const sr = tot.number + 2;
    ws.getCell(sr, 1).value = 'By client'; ws.getCell(sr, 1).font = { name: 'Calibri', bold: true, size: 12, color: { argb: NAVY } };
    head(ws, ['Client', '', '', '', '', 'Earned', '', 'Billed', 'Accrued', 'Pass-through out', 'Fee share out']);
    [...new Set(rows.map(r => r.pj.client || ''))].sort().forEach(cl => {
      const x = ws.addRow([cl]);
      [6, 8, 9, 10, 11].forEach(i => { const L = String.fromCharCode(64 + i); x.getCell(i).value = { formula: `SUMIFS(${L}${r0}:${L}${r1},$A$${r0}:$A$${r1},A${x.number})` }; x.getCell(i).numFmt = fmt; });
    });
    // ---- Sheet 2: the year, billed and accrued lanes ----
    const L = lanes(YEAR);
    const ys = wb.addWorksheet(YEAR + ' by month', { views: [{ state: 'frozen', ySplit: 3, xSplit: 1 }] });
    ys.mergeCells('A1:N1'); ys.getCell('A1').value = YEAR + ' — billed and accrued by month, as reconciled'; ys.getCell('A1').font = { name: 'Calibri', bold: true, size: 14, color: { argb: NAVY } };
    ys.addRow([]);
    head(ys, ['', ...MONTHS, 'Year']);
    const lockRow = ys.addRow(['Month status', ...MONTHS.map((_, i) => { const meta = STORE.reconMonth(YEAR, i + 1); return meta && meta.lockedAt ? 'LOCKED' : 'open'; }), '']);
    lockRow.eachCell((c, i) => { if (i > 1 && c.value === 'LOCKED') { c.font = { name: 'Calibri', bold: true, color: { argb: NAVY } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } }; } });
    const lane = (label, o) => { const r = ys.addRow([label, ...MONTHS.map((_, i) => o[i + 1] || null), null]); for (let c = 2; c <= 13; c++) r.getCell(c).numFmt = fmt; r.getCell(14).value = { formula: `SUM(B${r.number}:M${r.number})` }; r.getCell(14).numFmt = fmt; r.getCell(1).font = { name: 'Calibri', bold: true, color: { argb: NAVY } }; return r; };
    lane('Savills revenue · fee less fee share', L.earned); lane('Billed', L.billed); lane('Accrued (net)', L.accrued); lane('Fee share out', L.share); lane('Pass-through out · to vendors', L.pass);
    ys.columns = [{ width: 30 }, ...MONTHS.map(() => ({ width: 12 })), { width: 14 }];
    // ---- Sheet 3: flags ----
    const flags = lockFlags(YEAR);
    const fs = wb.addWorksheet('Changes since lock');
    fs.mergeCells('A1:H1'); fs.getCell('A1').value = flags.length ? flags.length + ' change(s) to locked months since they were locked' : 'No changes to locked months.'; fs.getCell('A1').font = { name: 'Calibri', bold: true, size: 13, color: { argb: flags.length ? RED : 'FF1F8A5B' } };
    fs.addRow([]);
    head(fs, ['Month', 'Client', 'Project', 'Line', 'Locked at', 'Now', 'Change', 'Last saved by']);
    flags.forEach(f => { const x = fs.addRow([ymLabel(f.ym), f.client, f.name, f.label, f.was, f.now, f.now - f.was, f.by + (f.at ? ' · ' + fmtStamp(f.at) : '')]); [5, 6, 7].forEach(i => x.getCell(i).numFmt = fmt); });
    fs.columns = [{ width: 12 }, { width: 24 }, { width: 40 }, { width: 13 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 30 }];
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'Savills PPM Flash ' + MONTHS[M - 1] + ' ' + YEAR + '.xlsx'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    try { STORE.logSystem && STORE.logSystem('recon-flash', { ym: ym(YEAR, M), lines: rows.length, locked: !!(mm && mm.lockedAt) }); } catch (e) {}
  }

  /* ---------- boot ---------- */
  function start() {
    // default month: the first open month up to today, else today
    const y = now.getFullYear();
    for (let m = 1; m <= now.getMonth() + 1; m++) { const meta = STORE.reconMonth(y, m); if (!(meta && meta.lockedAt)) { M = m; break; } }
    render();
    document.addEventListener('ufc:remote-updated', () => { _lines = null; render(); });
    document.addEventListener('ufc:rates', () => { _lines = null; render(); });
    document.addEventListener('ufc:revenue-updated', () => render());
  }
  if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(start, start); else start();
})();
