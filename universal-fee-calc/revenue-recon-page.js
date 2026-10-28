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
  const NOW_KEY = ym(now.getFullYear(), now.getMonth() + 1);
  /* Two views on one book. ANNUAL is the Revenue Projections shape — every
     project, twelve months — where a tap on a number assigns its earned,
     accrued and billed months. MONTHLY is one month, every line, with the
     status, the carry-ins and the lock. Remembered per browser. */
  const VIEW_KEY = 'ufc_fin_view_v1';
  let VIEW = 'annual', BASIS = 'earned', MODE = 'projects', GROUP = 'client';
  try { const sv = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}'); if (sv.view === 'monthly') VIEW = 'monthly'; if (['earned', 'accrued', 'billed'].includes(sv.basis)) BASIS = sv.basis; if (sv.mode === 'rollup') MODE = 'rollup'; if (['client', 'leader', 'rating'].includes(sv.group)) GROUP = sv.group; } catch (e) {}
  const remember = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify({ view: VIEW, basis: BASIS, mode: MODE, group: GROUP })); } catch (e) {} };
  const ymPlus = (k, n) => { const [yy, mm] = String(k).split('-').map(Number); const d = new Date(yy, mm - 1 + n, 1); return ym(d.getFullYear(), d.getMonth() + 1); };
  const STATUSES = STORE.RECON_STATUSES;
  const KIND_ORDER = { fee: 0, pass: 1, share: 2 };
  /** Label + kind of a line id on a project (fee, share, pt:<id>). */
  const infoFor = (p, id) => { const e = linesAll().find(x => x.p.id === p.id); return STORE.reconLineInfo(e ? e.lines : null, id); };
  const statusLabel = (id) => (STATUSES.find(s => s.id === id) || {}).label || '';

  const admin = () => STORE.isAdmin(STORE.getCurrentUser());
  /** The project side's "ready to bill" mark on a fee month: { at, by, byName } or null. */
  const rtbOf = (p, key) => STORE.readyToBillOf ? STORE.readyToBillOf(p, key) : null;
  const rtbWho = (r) => r ? ((r.byName || (STORE.displayNameForLogin ? STORE.displayNameForLogin(r.by) : r.by) || 'the project') + (r.at ? ' · ' + fmtStamp(r.at) : '')) : '';

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
          if (L.kind === 'share' || L.kind === 'pass') {            // money OUT lands in the month it is paid (the pass-through is a wash — never billed/accrued revenue)
            const pm = paidMonth(y, p.id, L, key); if (pm && pm.y === y) (L.kind === 'share' ? share : pass)[pm.m] += v;
            if (L.kind === 'pass') return;
          }
          const c = STORE.reconCell(y, p.id, L.id, key);
          const st = c && c.status;
          if (!st || st === 'billed') billed[m] += v;
          else if (st === 'billed-diff') billed[m] += (c.amount != null ? c.amount : v);
          else if (st === 'accrued') {
            // the accrual sits in its own accrued month when the annual view set one, else here
            let am = m; if (c.accruedIn && c.accruedIn.startsWith(String(y))) { const [, a2] = c.accruedIn.split('-').map(Number); if (a2) am = a2; }
            accrued[am] += (c.amount != null ? c.amount : v);
            if (c.billedIn) { const [, bm] = c.billedIn.split('-').map(Number); if (c.billedIn.startsWith(String(y)) && bm) { billed[bm] += (c.billedAmount != null ? c.billedAmount : (c.amount != null ? c.amount : v)); accrued[bm] -= (c.amount != null ? c.amount : v); } }
          }
          // slipped / writeoff: nothing billed or accrued in this month
        });
      }
    });
    return { billed, accrued, earned, share, pass };
  }
  /* The month money OUT is paid: the paid month set in the pop-up, else the
     line's own billed month for a fee share, the month after it for a
     vendor (Finance: shares go with our billing; vendors are paid once we
     have been). */
  const monthOf = (k) => { if (!k) return null; const [yy, mm] = String(k).split('-').map(Number); return (yy && mm) ? { y: yy, m: mm } : null; };
  function paidMonth(y, pid, L, key) {
    const v = (L.byMonth || {})[key] || 0; const A = STORE.reconAssignment(y, pid, L.id, key, v);
    if (A.writeoff) return null;
    if (A.paidIn) return monthOf(A.paidIn);
    return monthOf(L.kind === 'pass' ? ymPlus(A.billedIn, 1) : A.billedIn);
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
    if (!admin()) { host.innerHTML = '<div class="panel"><h2>Admins only</h2><p class="sub">Financial Tracking is Finance\'s book. Leaders see its flags on their own projects in the calculator.</p></div>'; return; }
    const years = yearsAvailable();
    const R = STORE.reconYear(YEAR);
    const flags = lockFlags(YEAR);
    const rows = monthRows(YEAR, M);
    const mm = STORE.reconMonth(YEAR, M);
    const locked = !!(mm && mm.lockedAt);
    let h = viewToggle();
    if (VIEW === 'annual') { h += annualHtml(); host.innerHTML = h; wireAnnual(host); return; }
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
      (() => { const rtbN = own.filter(r => r.lkind === 'fee' && !(r.cell && r.cell.status) && rtbOf(r.p, r.ym)).length; return kpi(String(unruled(rows)), 'lines without a status' + (rtbN ? ' · <b>' + rtbN + '</b> marked ready to bill' : '')); })() + '</div>';
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
      const rtb = r.lkind === 'fee' && !(st === 'billed' || st === 'billed-diff' || st === 'writeoff') ? rtbOf(r.p, r.ym) : null;
      h += '<tr class="' + (st ? 'st-' + st : 'st-none') + ' ln-' + r.lkind + (rtb ? ' rtb' : '') + '"><td>' + esc(r.pj.client || '') + '</td><td><a href="Universal Fee Calculator.html?id=' + encodeURIComponent(id) + '">' + esc(r.pj.name || 'Untitled') + '</a>' + (c.flagged ? '<div class="sub red">flag on the project</div>' : '') + '</td><td>' + esc(r.leader) + '</td><td>' + esc(r.label) + (rtb ? ' <span class="pill y" title="' + esc(rtbWho(rtb)) + '"><i></i>ready to bill</span>' : '') + '</td>' +
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
      laneRow('Savills revenue · fee less fee share', L.earned) + laneRow('Billed', L.billed, 'lane-billed') + laneRow('Accrued (net)', L.accrued, 'lane-accrued') + laneRow('Fee share out · in the month paid', L.share, 'lane-share') + laneRow('Pass-through out · in the month paid', L.pass, 'lane-pass') +
      '</tbody></table></div></div>';
    host.innerHTML = h;
    wire(host, locked);
  }
  function kpi(v, s) { return '<div class="kpi"><div class="v">' + v + '</div><div class="s">' + s + '</div></div>'; }

  /* ============================================================
     ANNUAL VIEW
     ============================================================ */
  function viewToggle() {
    return '<div class="rc-view" role="tablist">' +
      '<button role="tab" data-view="annual" class="' + (VIEW === 'annual' ? 'on' : '') + '"><b>Annual</b><small>Every project, twelve months. Tap a number to assign its earned, accrued and billed months.</small></button>' +
      '<button role="tab" data-view="monthly" class="' + (VIEW === 'monthly' ? 'on' : '') + '"><b>Monthly</b><small>One month, every line: status, carry-ins, the flash and the lock.</small></button></div>';
  }
  const isLocked = (y, m) => { const meta = STORE.reconMonth(y, m); return !!(meta && meta.lockedAt); };
  /** One row per project with anything in the year: per month the fee line,
      the out lines (share, pass-through) and the fee line's cell. */
  function annualRows(y) {
    const out = [];
    linesAll().forEach(({ p, lines }) => {
      if (!passes(p)) return;
      const months = {}; let any = false;
      for (let m = 1; m <= 12; m++) {
        const key = ym(y, m);
        const fee = (lines.fee || {})[key] || 0;
        const outs = (lines.out || []).map(L => ({ L, v: (L.byMonth || {})[key] || 0 })).filter(x => Math.abs(x.v) > 0.005);
        const feeCell = STORE.reconCell(y, p.id, 'fee', key);
        const outStatus = outs.some(x => { const c = STORE.reconCell(y, p.id, x.L.id, key); return c && c.status; });
        if (Math.abs(fee) > 0.005 || outs.length || (feeCell && feeCell.status) || outStatus) {
          any = true;
          months[m] = { key, fee, outs, feeCell: feeCell || null, outStatus, rtb: rtbOf(p, key),
            share: outs.filter(x => x.L.kind === 'share').reduce((t, x) => t + x.v, 0), pass: outs.filter(x => x.L.kind === 'pass').reduce((t, x) => t + x.v, 0) };
        }
      }
      if (any) out.push({ p, pj: p.project || {}, leader: leaderName(p), months });
    });
    return out.sort((a, b) => (a.pj.client || '').localeCompare(b.pj.client || '') || (a.pj.name || '').localeCompare(b.pj.name || ''));
  }
  const moShort = (k) => { if (!k) return ''; const [, m] = String(k).split('-').map(Number); return MONTHS[m - 1] || k; };
  function cellHtml(row, m, y) {
    const c = row.months[m]; const key = ym(y, m); const lk = isLocked(y, m);
    if (!c) return '<td class="ra-cell empty' + (lk ? ' lk' : '') + '">·</td>';
    const fc = c.feeCell || {}; const st = fc.status || '';
    const due = key <= NOW_KEY;
    let cls = st ? 'st-' + st : (due ? 'st-due' : 'st-none'), badge = '', title = '';
    if (st === 'billed') { badge = '✓'; title = 'Billed as planned'; }
    else if (st === 'billed-diff') { badge = '≠'; title = 'Billed ' + money(fc.amount) + ' against ' + money(c.fee) + ' planned'; }
    else if (st === 'accrued') { const b = fc.billedIn || fc.billsIn; badge = (fc.billedIn ? 'B ' : 'A→') + moShort(b); title = 'Accrued' + (fc.accruedIn ? ' in ' + moShort(fc.accruedIn) : '') + (fc.billedIn ? ', billed ' + moShort(fc.billedIn) : b ? ', bills in ' + moShort(b) : ''); }
    else if (st === 'slipped') { badge = '→' + moShort(fc.earnedIn); title = 'Slipped: earned in ' + moShort(fc.earnedIn); }
    else if (st === 'writeoff') { badge = '✕'; title = 'Written off'; }
    else title = due ? 'No months assigned yet' : 'Planned';
    const shown = (st === 'billed-diff' && fc.amount != null) ? fc.amount : c.fee;
    // the project said this month can be invoiced — shown until Finance has billed it
    const rtb = c.rtb && !(st === 'billed' || st === 'billed-diff' || st === 'writeoff' || (st === 'accrued' && fc.billedIn));
    const extras = (rtb ? ' · READY TO BILL — ' + rtbWho(c.rtb) : '') + (c.share ? ' · fee share ' + money(c.share) : '') + (c.pass ? ' · pass-through ' + money(c.pass) : '') + (c.outStatus && !st ? ' · a share / pass-through line has a status' : '');
    return '<td class="ra-cell ' + cls + (lk ? ' lk' : '') + (rtb ? ' rtb' : '') + '"><button type="button" class="ra-btn" data-pid="' + esc(row.p.id) + '" data-m="' + m + '" title="' + esc(title + extras + (lk ? ' · locked' : '')) + '">' +
      '<span class="amt' + (shown < 0 ? ' neg' : '') + '">' + (Math.abs(shown) > 0.5 ? money(shown) : '·') + '</span>' +
      (badge ? '<span class="bd">' + esc(badge) + '</span>' : '') + (c.share ? '<i class="sh" aria-hidden="true"></i>' : '') + (c.pass ? '<i class="pt" aria-hidden="true"></i>' : '') + '</button></td>';
  }
  /** Where each fee line-month sits on each basis, with its amount:
      { pid → { earned:{m:amt}, accrued:{m:amt}, billed:{m:amt} } } for the year. */
  function feePlacements(y) {
    const out = {};
    linesAll().forEach(({ p, lines }) => {
      if (!passes(p)) return;
      const slot = { earned: {}, accrued: {}, billed: {}, src: {} };
      Object.keys(lines.fee || {}).forEach(key => {
        const v = lines.fee[key] || 0; if (Math.abs(v) < 0.005) return;
        const A = STORE.reconAssignment(y, p.id, 'fee', key, v);
        const amt = A.amount != null ? A.amount : v;
        const place = (basis, k, a) => { const mo = monthOf(k); if (!mo || mo.y !== y) return; slot[basis][mo.m] = (slot[basis][mo.m] || 0) + a; (slot.src[basis + mo.m] = slot.src[basis + mo.m] || []).push(key); };
        place('earned', A.earnedIn, A.writeoff ? 0 : amt);
        if (!A.writeoff) { place('accrued', A.accruedIn, amt); place('billed', A.billedIn, amt); }
      });
      if (Object.keys(slot.earned).length || Object.keys(slot.accrued).length || Object.keys(slot.billed).length) out[p.id] = slot;
    });
    return out;
  }
  const groupOf = (p) => GROUP === 'leader' ? (leaderName(p) || 'No leader') : GROUP === 'rating' ? (STORE.ratingMeta ? STORE.ratingMeta(STORE.ratingFor(p)).label : String(STORE.ratingFor(p))) : ((p.project || {}).client || 'No client');
  function rollupRows(y) {
    const P = feePlacements(y); const by = {};
    Object.keys(P).forEach(pid => { const p = STORE.getProject(pid); if (!p) return; const g = groupOf(p); const r = by[g] || (by[g] = { label: g, months: {}, n: 0 }); r.n++; const src = P[pid][BASIS]; Object.keys(src).forEach(m => { r.months[m] = (r.months[m] || 0) + src[m]; }); });
    return Object.values(by).map(r => Object.assign(r, { total: Object.values(r.months).reduce((a, b) => a + b, 0) })).sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  }
  function basisCell(slot, m) {
    const v = (slot[BASIS] || {})[m]; if (!v) return '<td class="ra-cell empty' + (isLocked(YEAR, m) ? ' lk' : '') + '">·</td>';
    const src = (slot.src[BASIS + m] || []).map(k => moShort(k)).join(', ');
    return '<td class="ra-cell ro' + (isLocked(YEAR, m) ? ' lk' : '') + '" title="' + esc(BASIS + ' here · earned ' + src) + '"><span class="amt' + (v < 0 ? ' neg' : '') + '">' + money(v) + '</span></td>';
  }
  function annualHtml() {
    const years = yearsAvailable();
    const rows = annualRows(YEAR);
    const L = lanes(YEAR);
    const P = feePlacements(YEAR);
    const basisBar = '<div class="ra-ctl"><div class="seg" role="tablist" aria-label="Basis">' + [['earned', 'Earned', 'the month the work is done'], ['accrued', 'Accrued', 'the month the revenue is recognised'], ['billed', 'Billed', 'the month the invoice goes']].map(([k, l, t]) => '<button type="button" data-basis="' + k + '" class="' + (BASIS === k ? 'on' : '') + '" title="' + t + '">' + l + '</button>').join('') + '</div>' +
      '<div class="seg" role="tablist" aria-label="Shape"><button type="button" data-mode="projects" class="' + (MODE === 'projects' ? 'on' : '') + '">By project</button><button type="button" data-mode="rollup" class="' + (MODE === 'rollup' ? 'on' : '') + '">Simple roll-up</button></div>' +
      (MODE === 'rollup' ? '<select id="ra-group"><option value="client"' + (GROUP === 'client' ? ' selected' : '') + '>By client</option><option value="leader"' + (GROUP === 'leader' ? ' selected' : '') + '>By revenue leader</option><option value="rating"' + (GROUP === 'rating' ? ' selected' : '') + '>By rating</option></select>' : '') +
      '<span class="grow"></span><button class="btn btn-secondary" id="ra-xlsx">⤓ Excel · ' + YEAR + ' ' + BASIS + (MODE === 'rollup' ? ' by ' + ({ client: 'client', leader: 'leader', rating: 'rating' })[GROUP] : '') + '</button></div>';
    const sum = (lane) => Object.values(lane).reduce((a, b) => a + b, 0);
    let cells = 0, assigned = 0, due = 0;
    rows.forEach(r => Object.keys(r.months).forEach(m => { const c = r.months[m]; if (Math.abs(c.fee) <= 0.5) return; cells++; if (c.feeCell && c.feeCell.status) assigned++; else if (c.key <= NOW_KEY) due++; }));
    const feeTot = rows.reduce((t, r) => t + Object.values(r.months).reduce((u, c) => u + c.fee, 0), 0);
    let h = '<div class="rc-bar"><div class="rc-year"><label for="ra-year">Year</label><select id="ra-year">' + years.map(y => '<option value="' + y + '"' + (y === YEAR ? ' selected' : '') + '>' + y + '</option>').join('') + '</select></div>' +
      '<div class="rc-filt" style="margin:0;flex:1"><input type="search" id="ra-q" placeholder="Search client or project" value="' + esc(Q) + '"><select id="ra-leader"><option value="">All revenue leaders</option>' +
      [...new Set(projects().map(leaderName).filter(Boolean))].sort().map(l => '<option value="' + esc(l) + '"' + (l === LEADER ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>' +
      '<span class="sub">' + rows.length + ' project' + (rows.length === 1 ? '' : 's') + ' · ' + assigned + ' of ' + cells + ' fee months assigned' + (due ? ' · <b class="red">' + due + ' past or current, not yet</b>' : '') + '</span></div></div>';
    h += '<div class="kpis rc-kpis">' +
      kpi(money(feeTot), 'fee billed to client · ' + YEAR) + kpi('<span class="red">' + money(sum(L.share)) + '</span>', 'fee share out · to brokers') + kpi('<b>' + money(sum(L.earned)) + '</b>', 'Savills revenue · fee less fee share') +
      kpi(money(sum(L.billed)), 'billed · incl. accruals settling') + kpi(money(sum(L.accrued)), 'accrued · still open at year end') + kpi(String(due), 'fee months due a decision') + '</div>';
    h += basisBar;
    const thead = (first) => '<thead><tr>' + first + MONTHS.map((mn, i) => '<th class="money' + (isLocked(YEAR, i + 1) ? ' lk' : '') + (ym(YEAR, i + 1) === NOW_KEY ? ' now' : '') + '">' + mn + (isLocked(YEAR, i + 1) ? ' 🔒' : '') + '</th>').join('') + '<th class="money">Year</th></tr></thead>';
    if (MODE === 'rollup') {
      const rr = rollupRows(YEAR); const gl = { client: 'Client', leader: 'Revenue leader', rating: 'Rating' }[GROUP];
      h += '<div class="panel"><div class="ph"><h3>' + YEAR + ' · fee billed to client, ' + BASIS + ' basis, by ' + gl.toLowerCase() + '</h3><span class="sub">The fee line only, placed in its ' + BASIS + ' month. Written-off lines are left out of accrued and billed.</span></div><div class="tw"><table class="cb-table ra-table ra-roll">' + thead('<th>' + gl + '</th><th class="money">Projects</th>') + '<tbody>';
      if (!rr.length) h += '<tr><td colspan="15" class="sub">Nothing in ' + YEAR + '.</td></tr>';
      rr.forEach(r => { h += '<tr><td><b>' + esc(r.label) + '</b></td><td class="money">' + r.n + '</td>' + MONTHS.map((_, i) => { const v = r.months[i + 1] || 0; return '<td class="money' + (v < 0 ? ' neg' : '') + (isLocked(YEAR, i + 1) ? ' lk' : '') + '">' + (Math.abs(v) > 0.5 ? money(v) : '·') + '</td>'; }).join('') + '<td class="money"><b>' + money(r.total) + '</b></td></tr>'; });
      const tot = {}; rr.forEach(r => Object.keys(r.months).forEach(m => { tot[m] = (tot[m] || 0) + r.months[m]; }));
      h += '</tbody><tfoot><tr class="ra-lane"><td colspan="2"><b>Total</b></td>' + MONTHS.map((_, i) => '<td class="money">' + (Math.abs(tot[i + 1] || 0) > 0.5 ? money(tot[i + 1]) : '·') + '</td>').join('') + '<td class="money"><b>' + money(Object.values(tot).reduce((a, b) => a + b, 0)) + '</b></td></tr></tfoot></table></div></div>';
      return h;
    }
    h += '<div class="panel"><div class="tw"><table class="cb-table ra-table">' + thead('<th>Client</th><th>Project</th><th>Leader</th>') + '<tbody>';
    if (!rows.length) h += '<tr><td colspan="16" class="sub">Nothing earned in ' + YEAR + (LEADER || Q ? ' for this filter' : '') + '.</td></tr>';
    rows.forEach(r => {
      const slot = P[r.p.id] || { earned: {}, accrued: {}, billed: {}, src: {} };
      const yr = BASIS === 'earned' ? Object.values(r.months).reduce((t, c) => t + c.fee, 0) : Object.values(slot[BASIS]).reduce((a, b) => a + b, 0);
      h += '<tr><td>' + esc(r.pj.client || '') + '</td><td><a href="Universal Fee Calculator.html?id=' + encodeURIComponent(r.p.id) + '">' + esc(r.pj.name || 'Untitled') + '</a></td><td>' + esc(r.leader) + '</td>' +
        MONTHS.map((_, i) => BASIS === 'earned' ? cellHtml(r, i + 1, YEAR) : basisCell(slot, i + 1)).join('') + '<td class="money"><b>' + money(yr) + '</b></td></tr>';
    });
    const laneRow = (label, lane, cls) => '<tr class="ra-lane ' + (cls || '') + '"><td colspan="3"><b>' + label + '</b></td>' + MONTHS.map((_, i) => { const v = lane[i + 1] || 0; return '<td class="money' + (v < 0 ? ' neg' : '') + (isLocked(YEAR, i + 1) ? ' lk' : '') + '">' + (Math.abs(v) > 0.5 ? money(v) : '·') + '</td>'; }).join('') + '<td class="money"><b>' + money(sum(lane)) + '</b></td></tr>';
    const feeLane = {}; for (let m = 1; m <= 12; m++) feeLane[m] = rows.reduce((t, r) => t + ((r.months[m] || {}).fee || 0), 0);
    h += '</tbody><tfoot>' + laneRow('Fee billed to client', feeLane) + laneRow('Fee share out · in the month paid', L.share, 'lane-share') + laneRow('Savills revenue · earned', L.earned, 'lane-rev') + laneRow('Billed', L.billed, 'lane-billed') + laneRow('Accrued (net)', L.accrued, 'lane-accrued') + laneRow('Pass-through out · in the month paid', L.pass, 'lane-pass') + '</tfoot></table></div>' +
      (BASIS === 'earned' ? '' : '<div class="sub" style="margin-top:8px">On the ' + BASIS + ' basis the grid is read-only; switch to Earned to assign months. Hover a number for the earned month it came from.</div>') +
      '<div class="legend"><span><i class="k st-none"></i>planned</span><span><i class="k st-due"></i>past or current, no months assigned</span><span><i class="k st-billed"></i>✓ billed as planned</span><span><i class="k st-billed-diff"></i>≠ billed a different amount</span><span><i class="k st-accrued"></i>A→ accrued, bills later · B billed</span><span><i class="k st-slipped"></i>→ slipped to a later month</span><span><i class="k st-writeoff"></i>✕ written off</span><span><i class="sh"></i>has a fee share</span><span><i class="pt"></i>has a pass-through</span><span><i class="rb"></i>ready to bill — marked on the project</span><span>🔒 locked month</span></div></div>';
    return h;
  }
  function wireAnnual(host) {
    $$('.rc-view [data-view]', host).forEach(b => b.addEventListener('click', () => { VIEW = b.dataset.view; try { localStorage.setItem(VIEW_KEY, VIEW); } catch (e) {} render(); }));
    $('#ra-year', host).addEventListener('change', e => { YEAR = +e.target.value; render(); });
    $('#ra-q', host).addEventListener('input', e => { Q = e.target.value; const y = window.scrollY; render(); const q = $('#ra-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } window.scrollTo(0, y); });
    $('#ra-leader', host).addEventListener('change', e => { LEADER = e.target.value; render(); });
    $$('.ra-btn', host).forEach(b => b.addEventListener('click', () => openAssign(b.dataset.pid, +b.dataset.m)));
    $$('[data-basis]', host).forEach(b => b.addEventListener('click', () => { BASIS = b.dataset.basis; remember(); render(); }));
    $$('[data-mode]', host).forEach(b => b.addEventListener('click', () => { MODE = b.dataset.mode; remember(); render(); }));
    const g = $('#ra-group', host); if (g) g.addEventListener('change', e => { GROUP = e.target.value; remember(); render(); });
    const x = $('#ra-xlsx', host); if (x) x.addEventListener('click', () => exportAnnual().catch(e => toast('Export failed: ' + (e.message || e))));
  }
  /* ---------- Excel: the annual grid as shown (basis, shape), plus the lanes ---------- */
  async function exportAnnual() {
    await window.UFC_Vendor.excel();
    if (typeof ExcelJS === 'undefined') { toast('Excel library not loaded.'); return; }
    const NAVY = 'FF25273A', WHITE = 'FFFFFFFF', CREAM = 'FFEEE8E3';
    const fmt = '#,##0;[Red]-#,##0;"·"';
    const wb = new ExcelJS.Workbook(); wb.creator = 'Savills PPM · Financial Tracking';
    const head = (ws, labels) => { const r = ws.addRow(labels); r.eachCell(c => { c.font = { name: 'Calibri', bold: true, color: { argb: WHITE } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; }); return r; };
    const moneyCols = (ws, from, to) => { for (let c = from; c <= to; c++) ws.getColumn(c).numFmt = fmt; };
    const title = 'Savills PPM — Financial Tracking · ' + YEAR + ' · ' + BASIS + ' basis' + (MODE === 'rollup' ? ' · by ' + GROUP : '');
    const ws = wb.addWorksheet(MODE === 'rollup' ? 'Roll-up' : 'By project', { views: [{ state: 'frozen', ySplit: 4, xSplit: MODE === 'rollup' ? 2 : 3 }] });
    ws.mergeCells('A1:P1'); ws.getCell('A1').value = title; ws.getCell('A1').font = { name: 'Calibri', bold: true, size: 16, color: { argb: NAVY } };
    ws.mergeCells('A2:P2'); ws.getCell('A2').value = 'Fee billed to client, placed in its ' + BASIS + ' month · exported ' + new Date().toLocaleString() + (LEADER || Q ? ' · filtered' : ''); ws.getCell('A2').font = { name: 'Calibri', italic: true, color: { argb: 'FF79828C' } };
    ws.addRow([]);
    if (MODE === 'rollup') {
      const gl = { client: 'Client', leader: 'Revenue leader', rating: 'Rating' }[GROUP];
      head(ws, [gl, 'Projects'].concat(MONTHS, ['Year']));
      rollupRows(YEAR).forEach(r => ws.addRow([r.label, r.n].concat(MONTHS.map((_, i) => r.months[i + 1] || 0), [r.total])));
      moneyCols(ws, 3, 15); ws.getColumn(1).width = 34; ws.getColumn(2).width = 10;
    } else {
      head(ws, ['Client', 'Project', 'Revenue leader'].concat(MONTHS, ['Year']));
      const P = feePlacements(YEAR);
      annualRows(YEAR).forEach(r => {
        const slot = P[r.p.id] || { earned: {}, accrued: {}, billed: {} };
        const vals = MONTHS.map((_, i) => BASIS === 'earned' ? ((r.months[i + 1] || {}).fee || 0) : (slot[BASIS][i + 1] || 0));
        ws.addRow([r.pj.client || '', r.pj.name || 'Untitled', r.leader].concat(vals, [vals.reduce((a, b) => a + b, 0)]));
      });
      moneyCols(ws, 4, 16); ws.getColumn(1).width = 24; ws.getColumn(2).width = 44; ws.getColumn(3).width = 20;
    }
    for (let c = 1; c <= 16; c++) if (ws.getColumn(c).width == null || ws.getColumn(c).width < 11) ws.getColumn(c).width = 11;
    // lanes
    const L = lanes(YEAR);
    const ws2 = wb.addWorksheet('Lanes');
    head(ws2, ['Lane'].concat(MONTHS, ['Year']));
    [['Savills revenue · earned', L.earned], ['Billed', L.billed], ['Accrued (net)', L.accrued], ['Fee share out · month paid', L.share], ['Pass-through out · month paid', L.pass]].forEach(([lab, lane]) => ws2.addRow([lab].concat(MONTHS.map((_, i) => lane[i + 1] || 0), [Object.values(lane).reduce((a, b) => a + b, 0)])));
    moneyCols(ws2, 2, 14); ws2.getColumn(1).width = 34;
    // the assignments behind the grid
    const ws3 = wb.addWorksheet('Assignments');
    head(ws3, ['Client', 'Project', 'Line', 'Earned in fee tool', 'Planned', 'Amount', 'Status', 'Earned', 'Accrued', 'Billed', 'Paid', 'Ready to bill', 'Note']);
    linesAll().forEach(({ p, lines }) => { if (!passes(p)) return; (lines.all || []).forEach(Lx => Object.keys(Lx.byMonth || {}).forEach(k => { if (!k.startsWith(String(YEAR))) return; const v = Lx.byMonth[k] || 0; const A = STORE.reconAssignment(YEAR, p.id, Lx.id, k, v); const rb = Lx.kind === 'fee' ? rtbOf(p, k) : null; if (!A.set && !rb) return; ws3.addRow([(p.project || {}).client || '', (p.project || {}).name || '', Lx.label, k, v, A.set ? A.amount : null, A.set ? (A.writeoff ? 'written off' : statusLabel(A.status)) : 'no status', A.set ? A.earnedIn : '', A.set ? A.accruedIn : '', A.set ? A.billedIn : '', A.paidIn || '', rb ? rtbWho(rb) : '', A.note]); })); });
    moneyCols(ws3, 5, 6); ws3.getColumn(2).width = 44; ws3.getColumn(3).width = 28;
    const buf = await wb.xlsx.writeBuffer(); const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'Savills PPM Financial Tracking ' + YEAR + ' ' + BASIS + (MODE === 'rollup' ? ' by ' + GROUP : '') + '.xlsx'; document.body.appendChild(a); a.click(); a.remove();
  }
  /* ---------- the pop-up: one project-month, every line, three months each ---------- */
  function monthOpts(fromYm, selected, back) {
    const [y, m] = fromYm.split('-').map(Number); const out = [];
    for (let i = -(back || 0); i <= 18; i++) { const d = new Date(y, m - 1 + i, 1); const v = ym(d.getFullYear(), d.getMonth() + 1); out.push('<option value="' + v + '"' + (v === selected ? ' selected' : '') + '>' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + '</option>'); }
    return out.join('');
  }
  function openAssign(pid, m) {
    const key = ym(YEAR, m); const entry = linesAll().find(x => x.p.id === pid); if (!entry) return;
    const p = entry.p, pj = p.project || {}; const lk = isLocked(YEAR, m);
    const lines = (entry.lines.all || []).filter(L => Math.abs((L.byMonth || {})[key] || 0) > 0.005 || (STORE.reconCell(YEAR, pid, L.id, key) || {}).status);
    let ov = $('#ra-ov'); if (!ov) { ov = document.createElement('div'); ov.id = 'ra-ov'; ov.className = 'ra-ov'; document.body.appendChild(ov); }
    const rowsHtml = lines.map(L => {
      const planned = (L.byMonth || {})[key] || 0; const A = STORE.reconAssignment(YEAR, pid, L.id, key, planned);
      const dis = lk ? ' disabled' : '';
      // money out carries the month it is PAID: a fee share with the bill, a vendor the month after
      const out = L.kind === 'share' || L.kind === 'pass';
      const paidDefault = L.kind === 'pass' ? ymPlus(A.billedIn, 1) : A.billedIn;
      const paid = A.paidIn || paidDefault;
      const rtb = L.kind === 'fee' ? rtbOf(p, key) : null;
      return '<tr class="ln-' + L.kind + '" data-line="' + esc(L.id) + '" data-kind="' + L.kind + '"' + (A.paidIn ? ' data-paid-set="1"' : '') + '><td><b>' + esc(L.label) + '</b>' + (A.set ? '<div class="sub">' + esc(statusLabel(A.status)) + (A.status === 'accrued' ? (A.settled ? ' · settled' : ' · open') : '') + '</div>' : '<div class="sub">not yet assigned</div>') + (rtb ? '<div class="sub rtb-who">ready to bill · ' + esc(rtbWho(rtb)) + '</div>' : '') + '</td>' +
        '<td class="c">' + (L.kind === 'fee' ? '<input type="checkbox" class="ra-rtb" title="The project side says this month can be invoiced. Tick it here on their behalf, or clear it."' + (rtb ? ' checked' : '') + ' data-was="' + (rtb ? '1' : '0') + '"' + dis + '>' : '<span class="sub">—</span>') + '</td>' +
        '<td class="money' + (planned < 0 ? ' neg' : '') + '">' + money(planned) + '</td>' +
        '<td><input type="number" step="1" class="ra-amt" value="' + (A.amount != null ? Math.round(A.amount) : '') + '" placeholder="' + Math.round(planned) + '"' + dis + '></td>' +
        '<td><select class="ra-e"' + dis + '>' + monthOpts(key, A.earnedIn, 0) + '</select></td>' +
        '<td><select class="ra-a"' + dis + '>' + monthOpts(key, A.accruedIn, 0) + '</select></td>' +
        '<td><select class="ra-b"' + dis + '>' + monthOpts(key, A.billedIn, 0) + '</select></td>' +
        '<td>' + (out ? '<select class="ra-p" title="' + (L.kind === 'pass' ? 'The month the vendor is paid — the month after we bill, unless you set another' : 'The month the share goes out — with our billing, unless you set another') + '"' + dis + '>' + monthOpts(key, paid, 0) + '</select>' : '<span class="sub">—</span>') + '</td>' +
        '<td class="c"><input type="checkbox" class="ra-wo"' + (A.writeoff ? ' checked' : '') + dis + '></td>' +
        '<td><input type="text" class="ra-note" value="' + esc(A.note) + '" placeholder="What happened"' + dis + '></td></tr>';
    }).join('');
    ov.innerHTML = '<div class="ra-modal" role="dialog" aria-modal="true"><div class="mh"><div><h3>' + esc(pj.name || 'Untitled') + ' <span class="sub">· ' + esc(pj.client || '') + '</span></h3><div class="sub">' + MONTHS_LONG[m - 1] + ' ' + YEAR + ' · earned in the fee tool' + (lk ? ' · <b>locked, read only</b>' : '') + '</div></div><button type="button" class="x" id="ra-x" aria-label="Close">×</button></div>' +
      '<div class="mb"><table class="cb-table ra-assign"><thead><tr><th>Line</th><th class="c" title="Ready to bill — marked on the project">Ready</th><th class="money">Planned</th><th>Amount</th><th>Earned</th><th>Accrued</th><th>Billed</th><th>Paid</th><th class="c">Written off</th><th>Note</th></tr></thead><tbody>' + (rowsHtml || '<tr><td colspan="10" class="sub">Nothing on this line-month.</td></tr>') + '</tbody></table>' +
      '<div class="sub ra-help"><b>Earned</b> is the month the work is done, <b>Accrued</b> the month the revenue is recognised, <b>Billed</b> the month the invoice goes. <b>Ready</b> is the project side saying the month can be invoiced — it clears from the grid once the line is billed. Leave all three on ' + MONTHS[m - 1] + ' and it is billed as planned. A later Billed month accrues it until then. Moving Earned slips the whole line; set its accrual and billing from the new month. <b>Paid</b> is the month money goes out: a fee share with our billing, a vendor the month after we bill — change it when it is not.</div></div>' +
      '<div class="mf">' + (lk ? '<span class="sub">Reopen ' + MONTHS[m - 1] + ' on the Monthly view to change it.</span>' : '') + '<span class="grow"></span><button type="button" class="btn btn-secondary" id="ra-cancel">' + (lk ? 'Close' : 'Cancel') + '</button>' + (lk ? '' : '<button type="button" class="btn btn-primary" id="ra-save">Save</button>') + '</div></div>';
    ov.classList.add('open');
    const close = () => { ov.classList.remove('open'); ov.innerHTML = ''; };
    $('#ra-x', ov).onclick = close; $('#ra-cancel', ov).onclick = close; ov.onclick = (e) => { if (e.target === ov) close(); };
    // earned moved → accrued and billed follow and lock; accrued moved → billed at least as late
    $$('tr[data-line]', ov).forEach(tr => {
      const E = $('.ra-e', tr), Aa = $('.ra-a', tr), B = $('.ra-b', tr), W = $('.ra-wo', tr), Pd = $('.ra-p', tr);
      if (Pd) Pd.addEventListener('change', () => { tr.dataset.paidSet = '1'; });
      const sync = () => {
        const moved = E.value !== key;
        if (moved) { Aa.value = E.value; B.value = E.value; }
        Aa.disabled = moved || lk || W.checked; B.disabled = moved || lk || W.checked; E.disabled = lk || W.checked;
        if (Aa.value < E.value) Aa.value = E.value; if (B.value < Aa.value) B.value = Aa.value;
        if (Pd) { Pd.disabled = lk || W.checked; if (!tr.dataset.paidSet) { Pd.value = tr.dataset.kind === 'pass' ? ymPlus(B.value, 1) : B.value; if (Pd.selectedIndex < 0) Pd.selectedIndex = Pd.options.length - 1; } }
        tr.classList.toggle('wo', W.checked);
      };
      [E, Aa, B, W].forEach(el => el.addEventListener('change', sync)); sync();
    });
    const save = $('#ra-save', ov);
    if (save) save.onclick = () => {
      let n = 0, err = null;
      $$('tr[data-line]', ov).forEach(tr => {
        if (err) return;
        const line = tr.dataset.line; const L = lines.find(x => x.id === line); const planned = (L.byMonth || {})[key] || 0;
        const amt = $('.ra-amt', tr).value;
        const Pd = $('.ra-p', tr);
        try { STORE.setReconAssignment(YEAR, pid, line, key, { earned: planned, amount: amt === '' ? null : Number(amt), earnedIn: $('.ra-e', tr).value, accruedIn: $('.ra-a', tr).value, billedIn: $('.ra-b', tr).value, paidIn: Pd ? Pd.value : null, writeoff: $('.ra-wo', tr).checked, note: $('.ra-note', tr).value }); n++; }
        catch (e) { err = e; }
      });
      if (err) { toast(err.message || String(err)); return; }
      // the ready-to-bill mark lives on the project record, not the book
      $$('tr[data-line] .ra-rtb', ov).forEach(cb => { if ((cb.checked ? '1' : '0') !== cb.dataset.was) { try { STORE.setReadyToBill(pid, key, cb.checked); _lines = null; } catch (e) { err = e; } } });
      if (err) { toast(err.message || String(err)); return; }
      flush(); close(); toast(n + ' line' + (n === 1 ? '' : 's') + ' assigned for ' + MONTHS[m - 1] + ' ' + YEAR + '.', 'ok');
      const y = window.scrollY; render(); window.scrollTo(0, y);
    };
  }
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
    $$('.rc-view [data-view]', host).forEach(b => b.addEventListener('click', () => { VIEW = b.dataset.view; try { localStorage.setItem(VIEW_KEY, VIEW); } catch (e) {} render(); }));
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
    const wb = new ExcelJS.Workbook(); wb.creator = 'Savills PPM · Financial Tracking'; wb.calcProperties = { fullCalcOnLoad: true };
    const head = (ws, labels) => { const r = ws.addRow(labels); r.eachCell(c => { c.font = { name: 'Calibri', bold: true, color: { argb: WHITE } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; }); return r; };
    // ---- Sheet 1: the month ----
    const ws = wb.addWorksheet(MONTHS[M - 1] + ' ' + YEAR + ' Flash', { views: [{ state: 'frozen', ySplit: 4 }] });
    ws.mergeCells('A1:M1'); ws.getCell('A1').value = 'Savills PPM — Revenue Flash · ' + MONTHS_LONG[M - 1] + ' ' + YEAR; ws.getCell('A1').font = { name: 'Calibri', bold: true, size: 16, color: { argb: NAVY } };
    ws.mergeCells('A2:M2'); ws.getCell('A2').value = (mm && mm.lockedAt ? 'LOCKED ' + fmtStamp(mm.lockedAt) + (mm.lockedByName ? ' by ' + mm.lockedByName : '') : 'Working copy — not locked') + ' · exported ' + new Date().toLocaleString() + (LEADER ? ' · leader: ' + LEADER : ''); ws.getCell('A2').font = { name: 'Calibri', italic: true, size: 10, color: { argb: mm && mm.lockedAt ? NAVY : RED } };
    ws.addRow([]);
    head(ws, ['Client', 'Project', 'Revenue leader', 'Line', 'Kind', 'Earned', 'Status', 'Billed', 'Accrued', 'Pass-through out', 'Fee share out', 'Bill / earn month', 'Note', 'Ready to bill']);
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
        r.kind === 'carry' ? null : r.earned, r.kind === 'carry' ? (r.settledHere ? 'Billed here' : 'Still accrued') : (statusLabel(st) || 'no status'), billed || null, accrued || null, pass || null, share || null, target, c.note || '',
        r.kind === 'earned' && r.lkind === 'fee' ? rtbWho(rtbOf(r.p, r.ym)) : '']);
      [6, 8, 9, 10, 11].forEach(i => { x.getCell(i).numFmt = fmt; x.getCell(i).alignment = { horizontal: 'right' }; });
      if (!st && r.kind === 'earned') x.getCell(7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDF0D8' } };
      if (r.lkind === 'share') x.eachCell(cell => { cell.font = { name: 'Calibri', color: { argb: RED } }; });
      if (r.lkind === 'pass') x.eachCell(cell => { cell.font = { name: 'Calibri', color: { argb: 'FF0E7C7B' } }; });
    });
    const r1 = r0 + rows.length - 1;
    const tot = ws.addRow(['TOTAL', '', '', '', '', null, '', null, null, null, null, '', '', '']);
    [6, 8, 9, 10, 11].forEach(i => { const L = String.fromCharCode(64 + i); tot.getCell(i).value = rows.length ? { formula: `SUM(${L}${r0}:${L}${r1})` } : 0; tot.getCell(i).numFmt = fmt; });
    tot.eachCell(c => { c.font = { name: 'Calibri', bold: true, color: { argb: WHITE } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; });
    tot.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YEL } }; tot.getCell(8).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
    ws.columns = [{ width: 24 }, { width: 40 }, { width: 20 }, { width: 16 }, { width: 24 }, { width: 14 }, { width: 28 }, { width: 14 }, { width: 14 }, { width: 15 }, { width: 13 }, { width: 14 }, { width: 50 }, { width: 30 }];
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(r1, r0), column: 14 } };
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
