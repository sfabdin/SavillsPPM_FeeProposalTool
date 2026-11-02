/* ============================================================
   SAVILLS PPM · FINANCIAL TRACKING (TEST) — page controller
   ------------------------------------------------------------
   Finance's working sheet, one month of WORK PERFORMED at a time,
   in the shape of the accrual/billing book Finance keeps today:

     one row per project line (gross revenue, fee share to a named
     broker, pass-through), the revenue leader's EARNED figure locked,
     then PRIOR EOM · FLASH · FINAL · EOM side by side with the deltas
     between them, the billing with its invoice and date, and what is
     accrued but not yet billed. Row colour is the status Finance uses.

   The three snapshots are taken from the stepper at the top: Flash
   early in the billing month, Final when the approval number is set,
   EOM at month end. The EOM column is the one thing typed on the
   sheet; everything else is a snapshot or derived. A click on any row
   opens the one pop-up: earned (locked), accrued month + amount,
   billed month + amount + invoice + date, hold, flag, note.

   Runs beside the original Financial Tracking page and shares nothing
   with its statuses: the data is rev.fin (store.js, "FINANCIAL
   TRACKING (TEST)"). Admin/Finance only.
   ============================================================ */
(function () {
  'use strict';
  const STORE = window.UFC_Store, CATALOG = window.RATES_CATALOG, Box = window.UFC_Box;
  const $ = (s, r) => (r || document).querySelector(s), $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const toast = (m, k) => { if (window.UFC_UI && window.UFC_UI.toast) window.UFC_UI.toast(m, k); else console.log(m); };
  const now = new Date();
  const ym = (y, m) => y + '-' + String(m).padStart(2, '0');
  const NOW_KEY = ym(now.getFullYear(), now.getMonth() + 1);
  const ymLabel = (s) => { if (!s) return ''; const [y, m] = String(s).split('-').map(Number); return MONTHS[m - 1] + ' ' + y; };
  const ymLong = (s) => { const [y, m] = String(s).split('-').map(Number); return MONTHS_LONG[m - 1] + ' ' + y; };
  const money = (n, blank) => (n == null || (blank && Math.abs(n) < 0.005)) ? (blank ? '·' : '—') : ((n < 0 ? '−' : '') + '$' + Math.round(Math.abs(n)).toLocaleString());
  const delta = (n) => n == null ? '<span class="sub">—</span>' : Math.abs(n) < 0.5 ? '<span class="d0">0</span>' : '<span class="' + (n < 0 ? 'dneg' : 'dpos') + '">' + (n < 0 ? '−' : '+') + '$' + Math.round(Math.abs(n)).toLocaleString() + '</span>';
  const fmtStamp = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
  const admin = () => STORE.isAdmin(STORE.getCurrentUser());
  const flush = () => { if (Box && Box.enabled && Box.flushRevenue) Box.flushRevenue().catch(() => {}); };

  /* ---------- state ---------- */
  const KEY = 'ufc_fin_test_v1';
  const VIEWS = [['sheet', 'Monthly sheet', 'One month of work performed: earned, the three snapshots, the billing.'], ['unbilled', 'Unbilled schedule', 'Accrued less billed, month by month, to a running balance per line.'], ['followups', 'Follow-ups', 'What tripped a rule, by revenue leader. Tick, preview, send.']];
  let VIEW = 'sheet', CYCLE = STORE.finYmPlus(NOW_KEY, -1), ASOF = CYCLE, TAB = 'all', LEADER = '', Q = '';
  try { const sv = JSON.parse(localStorage.getItem(KEY) || '{}'); if (/^\d{4}-\d{2}$/.test(sv.cycle || '')) CYCLE = sv.cycle; if (/^\d{4}-\d{2}$/.test(sv.asOf || '')) ASOF = sv.asOf; if (['all', 'fixed', 'timecard'].includes(sv.tab)) TAB = sv.tab; if (VIEWS.some(v => v[0] === sv.view)) VIEW = sv.view; } catch (e) {}
  if (ASOF > NOW_KEY) ASOF = NOW_KEY;
  const remember = () => { try { localStorage.setItem(KEY, JSON.stringify({ view: VIEW, cycle: CYCLE, asOf: ASOF, tab: TAB })); } catch (e) {} };
  const viewsHtml = () => '<div class="ft-view" role="tablist">' + VIEWS.map(([k, l, d]) => '<button type="button" role="tab" data-view="' + k + '" class="' + (VIEW === k ? 'on' : '') + '"><b>' + l + '</b><small>' + d + '</small></button>').join('') + '</div>';
  const wireViews = (host) => $$('.ft-view [data-view]', host).forEach(b => b.addEventListener('click', () => { VIEW = b.dataset.view; remember(); render(); }));

  const leaderName = (p) => { const pj = p.project || {}; const l = STORE.resolveLeader && STORE.resolveLeader(pj.leadId || pj.lead); return l ? l.displayName : (pj.lead || ''); };
  function cycleOptions() {
    const out = []; let k = '2026-01'; const last = STORE.finYmPlus(NOW_KEY, 1);
    while (k <= last) { out.push(k); k = STORE.finYmPlus(k, 1); }
    return out;
  }
  function endLabel(p) {
    const t = p.timeline || {}; if (!(t.endMonth && t.endYear)) return '';
    const last = new Date(t.endYear, t.endMonth, 0).getDate();
    return 'through ' + t.endMonth + '/' + last + '/' + t.endYear;
  }
  function rowsNow() {
    let rows = STORE.finRows(CYCLE, CATALOG);
    if (LEADER) rows = rows.filter(r => r.leader === LEADER);
    if (Q) { const q = Q.toLowerCase(); rows = rows.filter(r => ((r.pj.client || '') + ' ' + (r.pj.name || '') + ' ' + r.broker + ' ' + r.projectId).toLowerCase().includes(q)); }
    return rows;
  }
  const sum = (rows, f) => rows.reduce((t, r) => { const v = f(r); return v == null ? t : t + v; }, 0);
  const any = (rows, f) => rows.some(r => f(r) != null);

  /* ---------- render ---------- */
  function render() {
    const host = $('#fin'); if (!host) return;
    if (!admin()) { host.innerHTML = '<div class="panel"><h2>Admins only</h2><p class="sub">Financial Tracking is Finance\'s book.</p></div>'; return; }
    if (VIEW === 'unbilled') { host.innerHTML = viewsHtml() + unbilledHtml(); wireViews(host); wireUnbilled(host); return; }
    if (VIEW === 'followups') { host.innerHTML = viewsHtml() + followUpsHtml(); wireViews(host); wireFollowUps(host); return; }
    const st = STORE.finCycleState(CYCLE);
    const rows = rowsNow();
    const fixed = rows.filter(r => !r.timecard), tcard = rows.filter(r => r.timecard);
    const shown = TAB === 'fixed' ? fixed : TAB === 'timecard' ? tcard : rows;
    const leaders = [...new Set(STORE.finRows(CYCLE, CATALOG).map(r => r.leader).filter(Boolean))].sort();
    const billingYm = STORE.finYmPlus(CYCLE, 1);
    // ---- header: cycle, stepper, export ----
    const step = (kind, n, label, hint) => { const s = st[kind]; const on = !st.flash ? kind === 'flash' : !st.final ? kind === 'final' : kind === 'eom';
      return '<div class="ft-step' + (s ? ' done' : on ? ' now' : '') + '"><b>' + n + ' ' + label + '</b><small>' + (s ? 'taken ' + esc(fmtStamp(s.at)) + (s.byName ? ' · ' + esc(s.byName) : '') : hint) + '</small>' +
        '<button type="button" class="btn ' + (s ? 'btn-ghost' : 'btn-primary') + ' small" data-snap="' + kind + '">' + (s ? 'Retake' : 'Take ' + label) + '</button></div>'; };
    let h = viewsHtml() + '<div class="ft-bar">' +
      '<div class="ft-cycle"><label for="ft-cycle">Work performed</label><select id="ft-cycle">' + cycleOptions().map(k => '<option value="' + k + '"' + (k === CYCLE ? ' selected' : '') + '>' + ymLong(k) + '</option>').join('') + '</select><div class="sub">billed in ' + esc(ymLong(billingYm)) + (st.lockedAt ? ' · <b>locked</b>' : '') + '</div></div>' +
      '<div class="ft-steps">' + step('flash', '①', 'Flash', 'early in ' + MONTHS[+billingYm.slice(5) - 1]) + step('final', '②', 'Final', 'the approval number') + step('eom', '③', 'EOM', 'at month end') + '</div>' +
      '<div class="ft-actions"><button type="button" class="btn btn-primary" id="ft-export">⤓ Export EOM file</button></div></div>';
    if (!st.priorEom) h += '<div class="sub ft-note">No EOM snapshot exists for ' + esc(ymLabel(STORE.finYmPlus(CYCLE, -1))) + ' work performed, so the Prior EOM column is empty this month. Take the EOM snapshot on each month as you work through them and the next month fills in.</div>';
    // ---- filters + tabs ----
    h += '<div class="ft-filt"><input type="search" id="ft-q" placeholder="Search client, project, broker or ID" value="' + esc(Q) + '"><select id="ft-leader"><option value="">All revenue leaders</option>' + leaders.map(l => '<option value="' + esc(l) + '"' + (l === LEADER ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>' +
      '<div class="ft-tabs">' + [['all', 'All lines', rows.length], ['fixed', 'Fixed fee', fixed.length], ['timecard', 'Time card', tcard.length]].map(([k, l, n]) => '<button type="button" class="ft-tab' + (TAB === k ? ' on' : '') + '" data-tab="' + k + '">' + l + ' <span>' + n + '</span></button>').join('') + '</div></div>';
    // ---- the sheet ----
    const head = '<thead><tr><th class="st">Status</th><th>Project</th><th>Line · party due</th><th class="money">Earned<small>leader · locked</small></th>' +
      '<th class="money">Prior EOM<small>' + (st.priorEom ? esc(fmtStamp(st.priorEom.at)) : '—') + '</small></th><th class="money">① Flash<small>' + (st.flash ? esc(fmtStamp(st.flash.at)) : '—') + '</small></th><th class="money">② Final<small>' + (st.final ? esc(fmtStamp(st.final.at)) : '—') + '</small></th><th class="money eom">③ EOM<small>working</small></th>' +
      '<th class="money">Billed<small>invoice · date</small></th><th class="money">Δ prior → Flash</th><th class="money">Δ Final → EOM</th><th class="money">Δ Billed → EOM</th><th class="money">Accrued, not billed</th><th>Note</th><th></th></tr></thead>';
    const rowHtml = (r) => {
      const w = r.work; const sub = r.kind !== 'fee';
      const proj = sub ? '<td class="pj sub-pj">↳ ' + (r.kind === 'share' ? 'fee share' : 'pass-through') + '</td>'
        : '<td class="pj"><a href="Universal Fee Calculator.html?id=' + encodeURIComponent(r.pid) + '"><b>' + esc(r.pj.client || '—') + ' — ' + esc(r.pj.name || 'Untitled') + '</b></a><div class="sub">' + esc([r.projectId, endLabel(r.p), r.leader, r.timecard ? 'time card' : ''].filter(Boolean).join(' · ')) + '</div></td>';
      const line = r.kind === 'fee' ? 'Gross revenue' : r.kind === 'share' ? 'Fee share · <b>' + esc(r.broker || 'broker') + '</b>' : esc(r.label);
      const billed = w.billedAmt != null ? money(w.billedAmt) + '<div class="sub">' + esc([w.billedDate || ymLabel(w.billedIn), w.invoice].filter(Boolean).join(' · ')) + '</div>' : (w.billedIn ? '<span class="sub">' + esc(ymLabel(w.billedIn)) + ' · amount?</span>' : '<span class="sub">—</span>');
      return '<tr class="ft-row s-' + w.status + (sub ? ' ln-' + r.kind : '') + '" data-key="' + esc(r.key) + '">' +
        '<td class="st">' + (sub ? '' : '<span class="dot"></span>' + esc(w.statusLabel)) + '</td>' + proj + '<td>' + line + '</td>' +
        '<td class="money lock" title="The revenue leader\'s figure, from Revenue Projections. Not editable here.">' + (sub ? '' : '🔒 ') + money(r.earned, true) + '</td>' +
        '<td class="money snap">' + money(r.priorEom) + '</td><td class="money snap">' + money(r.flash) + '</td><td class="money snap">' + money(r.final) + '</td>' +
        '<td class="money eom"><input type="number" step="1" class="ft-eom" value="' + Math.round(r.eom) + '" data-key="' + esc(r.key) + '"' + (st.lockedAt ? ' disabled' : '') + '></td>' +
        '<td class="money">' + billed + '</td>' +
        '<td class="money">' + delta(r.dPriorFlash) + '</td><td class="money">' + delta(r.dEomFinal) + '</td><td class="money">' + delta(r.dBilledEom) + '</td>' +
        '<td class="money' + (Math.abs(w.accruedNotBilled) > 0.5 ? ' anb' : '') + '">' + money(w.accruedNotBilled, true) + '</td>' +
        '<td class="note">' + esc(w.note) + '</td><td><button type="button" class="btn btn-ghost small" data-open="' + esc(r.key) + '">Edit</button></td></tr>';
    };
    const totRow = (label, list, cls) => '<tr class="' + (cls || 'ft-sub') + '"><td></td><td colspan="2">' + label + ' <span class="sub">· ' + list.length + ' line' + (list.length === 1 ? '' : 's') + '</span></td>' +
      '<td class="money">' + money(sum(list, r => r.earned)) + '</td><td class="money">' + (any(list, r => r.priorEom) ? money(sum(list, r => r.priorEom)) : '—') + '</td><td class="money">' + (any(list, r => r.flash) ? money(sum(list, r => r.flash)) : '—') + '</td><td class="money">' + (any(list, r => r.final) ? money(sum(list, r => r.final)) : '—') + '</td>' +
      '<td class="money eom"><b>' + money(sum(list, r => r.eom)) + '</b></td><td class="money">' + money(sum(list, r => r.work.billedAmt)) + '</td>' +
      '<td class="money">' + delta(any(list, r => r.dPriorFlash) ? sum(list, r => r.dPriorFlash) : null) + '</td><td class="money">' + delta(any(list, r => r.dEomFinal) ? sum(list, r => r.dEomFinal) : null) + '</td><td class="money">' + delta(any(list, r => r.dBilledEom) ? sum(list, r => r.dBilledEom) : null) + '</td>' +
      '<td class="money"><b>' + money(sum(list, r => r.work.accruedNotBilled)) + '</b></td><td></td><td></td></tr>';
    let body = '';
    if (!shown.length) body = '<tr><td colspan="15" class="sub">Nothing earned in ' + esc(ymLong(CYCLE)) + (LEADER || Q ? ' for this filter' : '') + '.</td></tr>';
    else if (TAB === 'all') {
      body = fixed.map(rowHtml).join('') + (fixed.length ? totRow('Subtotal · fixed fee', fixed) : '') + tcard.map(rowHtml).join('') + (tcard.length ? totRow('Subtotal · time card', tcard) : '');
    } else body = shown.map(rowHtml).join('') + totRow('Subtotal · ' + (TAB === 'fixed' ? 'fixed fee' : 'time card'), shown);
    const gross = shown.filter(r => r.kind !== 'share'), share = shown.filter(r => r.kind === 'share');
    body += totRow('Net revenue · ' + esc(ymLong(CYCLE)) + ' work performed', shown, 'ft-tot') + totRow('of which · gross revenue', gross) + totRow('of which · fee share out', share, 'ft-sub ft-share');
    h += '<div class="panel ft-panel"><div class="tw"><table class="cb-table ft-table">' + head + '<tbody>' + body + '</tbody></table></div>' +
      '<div class="ft-legend"><span><i class="s-confirm"></i>Not yet billed · requires confirmation</span><span><i class="s-approval"></i>Awaiting invoice approval</span><span><i class="s-cr"></i>Discuss with CR</span><span><i class="s-billed"></i>Billed</span><span><i class="s-hold"></i>Accrued · bill TBD</span><span><i class="s-planned"></i>Planned · month not reached</span><span class="grow"></span><span class="sub">Yellow = what you type this cycle. Everything else is a snapshot or derived.</span></div></div>';
    host.innerHTML = h;
    wireViews(host); wire(host, st);
  }

  /* ---------- the unbilled schedule ---------- */
  function unbilledNow() {
    const U = STORE.finUnbilled(ASOF, CATALOG);
    let rows = U.rows;
    if (LEADER) rows = rows.filter(r => r.leader === LEADER);
    if (Q) { const q = Q.toLowerCase(); rows = rows.filter(r => ((r.pj.client || '') + ' ' + (r.pj.name || '') + ' ' + r.broker + ' ' + r.projectId).toLowerCase().includes(q)); }
    return Object.assign({}, U, { rows, all: U.rows });
  }
  const monthEnd = (k) => { const [y, m] = k.split('-').map(Number); return m + '/' + new Date(y, m, 0).getDate() + '/' + y; };
  const act = (n) => Math.abs(n) < 0.5 ? '<span class="d0">·</span>' : '<span class="' + (n < 0 ? 'dneg' : 'dpos') + '">' + (n < 0 ? '−' : '+') + Math.round(Math.abs(n)).toLocaleString() + '</span>';
  const bal = (n, strong) => { const t = (n < 0 ? '−' : '') + Math.round(Math.abs(n)).toLocaleString(); return strong ? '<b>' + t + '</b>' : (Math.abs(n) < 0.5 ? '<span class="d0">0</span>' : t); };
  function unbilledHtml() {
    const U = unbilledNow(); const rows = U.rows; const year = ASOF.slice(0, 4); const prev = Number(year) - 1;
    const leaders = [...new Set(U.all.map(r => r.leader).filter(Boolean))].sort();
    const opts = []; for (let k = year + '-01'; k <= NOW_KEY; k = STORE.finYmPlus(k, 1)) opts.push(k);
    const T = { opening: sum(rows, r => r.opening), closing: sum(rows, r => r.closing), acc: sum(rows, r => U.months.reduce((t, m) => t + r.byMonth[m].acc, 0)), bill: sum(rows, r => U.months.reduce((t, m) => t + r.byMonth[m].bill, 0)) };
    let h = '<div class="ft-bar">' +
      '<div class="ft-cycle"><label for="ft-asof">Balances at</label><select id="ft-asof">' + opts.map(k => '<option value="' + k + '"' + (k === ASOF ? ' selected' : '') + '>' + monthEnd(k) + '</option>').join('') + '</select><div class="sub">opening balance at 12/31/' + prev + '</div></div>' +
      '<div class="ft-sum"><div><small>Opening · 12/31/' + prev + '</small><b>' + money(T.opening) + '</b></div><div><small>Accrued ' + year + ' to date</small><b>' + money(T.acc) + '</b></div><div><small>Billed ' + year + ' to date</small><b>' + money(T.bill) + '</b></div><div class="now"><small>Unbilled at ' + esc(monthEnd(ASOF)) + '</small><b>' + money(T.closing) + '</b></div></div>' +
      '<div class="ft-actions"><button type="button" class="btn btn-primary" id="ft-ub-export">⤓ Export schedule</button></div></div>';
    h += '<div class="ft-filt"><input type="search" id="ft-q" placeholder="Search client, project, broker or ID" value="' + esc(Q) + '"><select id="ft-leader"><option value="">All revenue leaders</option>' + leaders.map(l => '<option value="' + esc(l) + '"' + (l === LEADER ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>' +
      '<span class="sub grow">' + rows.length + ' line' + (rows.length === 1 ? '' : 's') + ' with a balance or activity this year. Nothing is retyped: the opening balance is typed once from last year\'s schedule, each month is the sheet\'s accruals less its billings.</span></div>';
    const last = U.months[U.months.length - 1];
    const head = '<thead><tr><th>Project</th><th class="money">Balance<small>12/31/' + prev + '</small></th>' + U.months.map(m => '<th class="money">' + MONTHS[+m.slice(5) - 1] + '</th><th class="money' + (m === last ? ' eom' : '') + '">YTD<small>' + monthEnd(m) + '</small></th>').join('') + '<th>Comment</th></tr></thead>';
    const rowHtml = (r) => {
      const sub = r.kind !== 'fee';
      const proj = sub ? '<td class="pj sub-pj">↳ ' + (r.kind === 'share' ? 'fee share · <b>' + esc(r.broker || 'broker') + '</b>' : esc(r.label)) + '</td>'
        : '<td class="pj"><a href="Universal Fee Calculator.html?id=' + encodeURIComponent(r.pid) + '"><b>' + esc(r.pj.client || '—') + ' — ' + esc(r.pj.name || 'Untitled') + '</b></a><div class="sub">' + esc([r.projectId, r.leader, r.timecard ? 'time card' : ''].filter(Boolean).join(' · ')) + '</div></td>';
      return '<tr class="ft-row' + (sub ? ' ln-' + r.kind : '') + '" data-key="' + esc(r.key) + '">' + proj +
        '<td class="money open"><input type="number" step="1" class="ft-open" data-key="' + esc(r.key) + '" value="' + (r.openingSet ? Math.round(r.opening) : '') + '" placeholder="0" title="Accrued and not yet billed at 12/31/' + prev + ' — typed once from last year\'s schedule"></td>' +
        U.months.map(m => { const c = r.byMonth[m]; return '<td class="money">' + act(c.net) + '</td><td class="money' + (m === last ? ' eom' : '') + '">' + bal(c.ytd, m === last) + '</td>'; }).join('') +
        '<td class="cmt"><input type="text" class="ft-cmt" data-key="' + esc(r.key) + '" value="' + esc(r.comment) + '" placeholder="' + esc(r.autoComment) + '"></td></tr>';
    };
    let body = rows.length ? rows.map(rowHtml).join('') : '<tr><td colspan="' + (3 + U.months.length * 2) + '" class="sub">No balances or activity in ' + year + (LEADER || Q ? ' for this filter' : '') + '. Type the opening balances from last year\'s schedule, or work a month on the sheet.</td></tr>';
    const gross = rows.filter(r => r.kind !== 'share'), share = rows.filter(r => r.kind === 'share');
    const tot = (label, list, cls) => '<tr class="' + (cls || 'ft-sub') + '"><td>' + label + ' <span class="sub">· ' + list.length + ' line' + (list.length === 1 ? '' : 's') + '</span></td><td class="money">' + bal(sum(list, r => r.opening)) + '</td>' +
      U.months.map(m => '<td class="money">' + act(sum(list, r => r.byMonth[m].net)) + '</td><td class="money' + (m === last ? ' eom' : '') + '">' + bal(sum(list, r => r.byMonth[m].ytd), m === last) + '</td>').join('') + '<td></td></tr>';
    body += tot('Unbilled · all lines', rows, 'ft-tot') + tot('of which · gross revenue', gross) + tot('of which · fee share out', share, 'ft-sub ft-share');
    h += '<div class="panel ft-panel"><div class="tw"><table class="cb-table ft-table ft-ub">' + head + '<tbody>' + body + '</tbody></table></div>' +
      '<div class="ft-legend"><span><span class="dpos">+</span> accrued in the month</span><span><span class="dneg">−</span> billed in the month</span><span>YTD = the running balance at the month end</span><span class="grow"></span><span class="sub">A grey comment is derived from the line; type over it to keep your own.</span></div></div>';
    return h;
  }
  function wireUnbilled(host) {
    $('#ft-asof', host).addEventListener('change', e => { ASOF = e.target.value; remember(); render(); });
    $('#ft-q', host).addEventListener('input', e => { Q = e.target.value; render(); const q = $('#ft-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } });
    $('#ft-leader', host).addEventListener('change', e => { LEADER = e.target.value; render(); });
    $('#ft-ub-export', host).addEventListener('click', () => exportUnbilled().catch(e => toast('Export failed: ' + (e.message || e))));
    const save = (inp, patch) => { const [pid, line] = inp.dataset.key.split('|'); try { STORE.setFinOpening(pid, line, patch); flush(); } catch (e) { toast(e.message); } const y = window.scrollY; render(); window.scrollTo(0, y); };
    $$('.ft-open', host).forEach(inp => inp.addEventListener('change', () => save(inp, { amount: inp.value === '' ? null : Number(inp.value) })));
    $$('.ft-cmt', host).forEach(inp => inp.addEventListener('change', () => save(inp, { comment: inp.value })));
  }
  /* ---------- follow-ups: rules, ticks, one email per leader ---------- */
  const FU = { rule: '', picked: null, preview: null, cc: '', deadline: '', edits: {} };
  function defaultDeadline() {
    const d = new Date(); d.setSeconds(0, 0); const dow = d.getDay(); let add = (5 - dow + 7) % 7;
    if (add === 0 && d.getHours() >= 17) add = 7; d.setDate(d.getDate() + add); d.setHours(17, 0, 0, 0); return d;
  }
  const toLocalInput = (d) => { const p2 = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()); };
  const deadlineDate = () => { const d = FU.deadline ? new Date(FU.deadline) : null; return (d && !isNaN(d)) ? d : defaultDeadline(); };
  const deadlineLabel = (d) => { try { return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d); } catch (e) { return d.toLocaleString(); } };
  const splitAddrs = (v) => String(v || '').split(/[;,\s]+/).map(x => x.trim().toLowerCase()).filter(x => /@/.test(x));
  const htmlToText = (h) => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<\/(p|div|tr|h\d|li)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
  const recentlyAsked = (i) => !!(i.asked && (Date.now() - new Date(i.asked.at)) < 7 * 86400000);
  const fuWho = () => { let by = '', login = ''; try { const u = STORE.getCurrentUser() || {}; login = u.username || ''; by = u.name || login; } catch (e) {} return { by, login }; };
  function groupsOf(items) {
    const g = {}; items.forEach(i => { const k = i.leaderId || i.leader || '—'; (g[k] = g[k] || { key: k, leader: i.leader || 'No revenue leader', email: i.email, items: [] }).items.push(i); });
    return Object.values(g).sort((a, b) => a.leader.localeCompare(b.leader));
  }
  const mailFor = (grp, picked) => {
    const gen = STORE.finFollowUpEmail(grp.leader, picked, { deadline: deadlineDate(), by: fuWho().by });
    const e = FU.edits[grp.key]; if (!e) return Object.assign(gen, { edited: false });
    return { subject: e.subject || gen.subject, html: e.html != null ? e.html : gen.html, text: htmlToText(e.html != null ? e.html : gen.html), count: gen.count, edited: true };
  };
  function followUpsHtml() {
    const R = STORE.finFollowUps(CATALOG); const all = R.items;
    if (!FU.picked) FU.picked = {};   // nothing ticked to start with: a send is deliberate
    if (!FU.cc) FU.cc = fuWho().login;
    let items = all; if (FU.rule) items = items.filter(i => i.rule === FU.rule);
    if (LEADER) items = items.filter(i => i.leader === LEADER);
    if (Q) { const q = Q.toLowerCase(); items = items.filter(i => ((i.pj.client || '') + ' ' + (i.pj.name || '') + ' ' + i.projectId).toLowerCase().includes(q)); }
    const groups = groupsOf(items); const leaders = [...new Set(all.map(i => i.leader).filter(Boolean))].sort();
    if (!FU.preview || !groups.some(g => g.key === FU.preview)) FU.preview = groups.length ? groups[0].key : null;
    const pickedAll = all.filter(i => FU.picked[i.id] && i.email); const sendGroups = groupsOf(pickedAll).filter(g => g.email);
    const dl = deadlineDate(); const authed = !!(Box && Box.enabled && Box.notify && (!Box.isAuthed || Box.isAuthed()));
    let h = '<div class="ft-rules">' + Object.keys(STORE.FIN_RULES).map(k => { const r = STORE.FIN_RULES[k]; return '<button type="button" class="ft-rule' + (FU.rule === k ? ' on' : '') + '" data-rule="' + k + '"><b>' + esc(r.label) + '</b><span>' + esc(r.hint) + '</span><div class="k">' + R.counts[k] + '</div></button>'; }).join('') + '</div>';
    h += '<div class="ft-filt"><input type="search" id="ft-q" placeholder="Search client, project or ID" value="' + esc(Q) + '"><select id="ft-leader"><option value="">All revenue leaders</option>' + leaders.map(l => '<option value="' + esc(l) + '"' + (l === LEADER ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>' +
      '<span class="sub grow">' + all.length + ' item' + (all.length === 1 ? '' : 's') + ' · ' + groupsOf(all).length + ' leader' + (groupsOf(all).length === 1 ? '' : 's') + (FU.rule ? ' · showing one rule, click it again for all' : '') + '. Nothing is ticked to start with: tick a leader\'s whole list with the box on their row, or item by item. Items asked in the last week say so.</span></div>';
    h += '<div class="ft-sendbar"><label>Due by<input type="datetime-local" id="ft-due" value="' + esc(toLocalInput(dl)) + '" step="900"></label><label>Cc<input type="text" id="ft-cc" value="' + esc(FU.cc) + '" placeholder="addresses separated by ;"></label>' +
      '<span class="sub grow">Every email says <b>' + esc(deadlineLabel(dl)) + '</b>. Change it and all of them rebuild, reworded ones too.</span>' +
      '<button type="button" class="btn btn-primary" id="ft-send"' + (authed && sendGroups.length ? '' : ' disabled') + '>Send ' + pickedAll.length + ' follow-up' + (pickedAll.length === 1 ? '' : 's') + ' · ' + sendGroups.length + ' email' + (sendGroups.length === 1 ? '' : 's') + '</button>' + (authed ? '' : '<span class="sub">Sign in to Box to send; the preview still works.</span>') + '</div>';
    if (!groups.length) h += '<div class="panel ft-panel"><p class="sub">Nothing trips a rule' + (FU.rule || LEADER || Q ? ' for this filter' : '') + '. The sheet is caught up.</p></div>';
    groups.forEach(g => {
      const n = g.items.filter(i => FU.picked[i.id]).length;
      h += '<div class="ft-grp' + (g.key === FU.preview ? ' sel' : '') + '" data-grp="' + esc(g.key) + '"><label><input type="checkbox" data-grpall="' + esc(g.key) + '"' + (n && n === g.items.filter(i => i.email).length ? ' checked' : '') + (g.email ? '' : ' disabled') + '></label><b>' + esc(g.leader) + '</b><span class="sub">' + (g.email ? esc(g.email) : 'no address on the leader list') + ' · ' + g.items.length + ' item' + (g.items.length === 1 ? '' : 's') + (n ? ' · ' + n + ' ticked' : '') + (FU.edits[g.key] ? ' · <i>reworded</i>' : '') + '</span><span class="grow"></span><span class="sub">' + (g.key === FU.preview ? 'previewing below' : 'click to preview') + '</span></div>';
      h += '<div class="panel ft-panel ft-fu"><div class="tw"><table class="cb-table ft-table"><thead><tr><th></th><th>Project</th><th>Month</th><th>What tripped</th><th class="money">Amount</th><th>Since</th><th>Suggested ask</th><th></th></tr></thead><tbody>' +
        g.items.map(i => '<tr class="ft-row r-' + i.rule + (i.kind !== 'fee' ? ' ln-' + i.kind : '') + '" data-id="' + esc(i.id) + '"><td><input type="checkbox" data-pick="' + esc(i.id) + '"' + (FU.picked[i.id] ? ' checked' : '') + (i.email ? '' : ' disabled') + '></td>' +
          '<td class="pj"><a href="Universal Fee Calculator.html?id=' + encodeURIComponent(i.pid) + '"><b>' + esc(i.pj.client || '—') + ' — ' + esc(i.pj.name || 'Untitled') + '</b></a><div class="sub">' + esc([i.projectId, i.kind === 'fee' ? (STORE.finTimecard(i.p) ? 'time card' : 'fixed fee') : i.label].filter(Boolean).join(' · ')) + '</div></td>' +
          '<td>' + esc(/^\d{4}-\d{2}$/.test(i.ym) ? ymLabel(i.ym) : i.ym) + '</td><td><span class="ft-pill r-' + i.rule + '">' + esc(i.ruleLabel) + '</span>' + (i.audience === 'finance' ? '<div class="sub">for Finance</div>' : '') + '</td>' +
          '<td class="money">' + money(i.amount) + '</td><td class="sub">' + (i.since != null ? i.since + ' days' : '—') + (i.asked ? '<div>asked ' + esc(fmtStamp(i.asked.at)) + '</div>' : '') + '</td><td class="ask">' + esc(i.ask) + '</td>' +
          '<td>' + (/^\d{4}-\d{2}$/.test(i.ym) && i.rule !== 'share-no-broker' ? '<button type="button" class="btn btn-ghost small" data-openfu="' + esc(i.pid + '|' + i.line + '|' + i.ym) + '">Open</button>' : '') + '</td></tr>').join('') + '</tbody></table></div></div>';
    });
    const pg = groups.find(g => g.key === FU.preview);
    if (pg) {
      const picked = pg.items.filter(i => FU.picked[i.id]); const list = picked.length ? picked : pg.items; const m = mailFor(pg, list);
      h += '<div class="panel ft-panel ft-mail"><div class="ft-mailhead"><b>Preview · to ' + esc(pg.leader) + (pg.email ? ' &lt;' + esc(pg.email) + '&gt;' : '') + (FU.cc ? ' · cc ' + esc(FU.cc) : '') + '</b><span class="sub">' + (picked.length ? picked.length + ' ticked item' + (picked.length === 1 ? '' : 's') : 'nothing ticked yet, showing all ' + pg.items.length) + (m.edited ? ' · reworded by hand' : '') + '</span><span class="grow"></span>' + (m.edited ? '<button type="button" class="btn btn-ghost small" id="ft-unedit">Back to the generated wording</button>' : '<span class="sub">Click into the email to reword it for this leader only.</span>') + '</div>' +
        '<label class="ft-subj">Subject<input type="text" id="ft-subj" value="' + esc(m.subject) + '"></label><div class="ft-mailprev" id="ft-mailprev" contenteditable="true" spellcheck="false">' + m.html + '</div></div>';
    }
    h += '<div class="ft-legend"><span class="sub">Rules: a past month with nothing recorded after 30 days; an accrual with no billing after 60 days and no hold; an EOM figure that moved from the Final snapshot with no note; a fee share with no broker named. Finance items stay on the list for Finance and are not emailed unless ticked.</span></div>';
    return h;
  }
  function wireFollowUps(host) {
    $$('.ft-rule', host).forEach(b => b.addEventListener('click', () => { FU.rule = FU.rule === b.dataset.rule ? '' : b.dataset.rule; render(); }));
    $('#ft-q', host).addEventListener('input', e => { Q = e.target.value; render(); const q = $('#ft-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } });
    $('#ft-leader', host).addEventListener('change', e => { LEADER = e.target.value; render(); });
    $('#ft-due', host).addEventListener('change', e => { const d = new Date(e.target.value); if (isNaN(d)) return; FU.deadline = e.target.value; FU.edits = {}; render(); });
    $('#ft-cc', host).addEventListener('change', e => { FU.cc = e.target.value; render(); });
    $$('[data-pick]', host).forEach(cb => cb.addEventListener('change', () => { FU.picked[cb.dataset.pick] = cb.checked; const y = window.scrollY; render(); window.scrollTo(0, y); }));
    $$('[data-grpall]', host).forEach(cb => cb.addEventListener('change', (e) => { e.stopPropagation(); const R = STORE.finFollowUps(CATALOG); R.items.forEach(i => { if ((i.leaderId || i.leader || '—') === cb.dataset.grpall && i.email && (!cb.checked || (i.audience === 'leader' && !recentlyAsked(i)))) FU.picked[i.id] = cb.checked; }); const y = window.scrollY; render(); window.scrollTo(0, y); }));
    $$('.ft-grp', host).forEach(g => g.addEventListener('click', (e) => { if (e.target.closest('input')) return; FU.preview = g.dataset.grp; const y = window.scrollY; render(); window.scrollTo(0, y); }));
    $$('[data-openfu]', host).forEach(b => b.addEventListener('click', () => { const [pid, line, k] = b.dataset.openfu.split('|'); CYCLE = k; remember(); openLine(pid + '|' + line + '|' + k); }));
    const prev = $('#ft-mailprev', host), subj = $('#ft-subj', host);
    if (prev) { prev.addEventListener('input', () => { const e = FU.edits[FU.preview] = FU.edits[FU.preview] || {}; e.html = prev.innerHTML; }); }
    if (subj) { subj.addEventListener('input', () => { const e = FU.edits[FU.preview] = FU.edits[FU.preview] || {}; e.subject = subj.value; }); }
    const un = $('#ft-unedit', host); if (un) un.addEventListener('click', () => { delete FU.edits[FU.preview]; render(); });
    const send = $('#ft-send', host); if (send) send.addEventListener('click', sendFollowUps);
  }
  function sendFollowUps() {
    const B = Box; if (!(B && B.enabled && B.notify)) { toast('Sign in to Box to send.'); return; }
    const R = STORE.finFollowUps(CATALOG); const picked = R.items.filter(i => FU.picked[i.id] && i.email); const groups = groupsOf(picked).filter(g => g.email);
    if (!groups.length) { toast('Tick at least one item for a leader with an address.'); return; }
    const dl = deadlineDate(); const who = fuWho();
    if (!confirm('Send ' + picked.length + ' follow-up' + (picked.length === 1 ? '' : 's') + ' as ' + groups.length + ' email' + (groups.length === 1 ? '' : 's') + ' (' + groups.map(g => g.leader).join(', ') + ')?\n\nEach leader gets only their own items, due ' + deadlineLabel(dl) + '.')) return;
    let sent = 0;
    try {
      groups.forEach(g => {
        const m = mailFor(g, g.items);
        B.notify({ event: 'fin-followup', to: [g.email], cc: splitAddrs(FU.cc), subject: m.subject, html: m.html, text: m.text, data: { leaderId: g.key, leader: g.leader, items: g.items.length, ids: g.items.map(i => i.id), deadline: dl.toISOString(), edited: m.edited } });
        STORE.markFinAsked(g.items, { leader: g.leader, to: g.email, deadline: dl.toISOString(), edited: m.edited }); sent++;
      });
      flush(); if (B.flushNotify) B.flushNotify().catch(() => {});
      toast(sent + ' follow-up email' + (sent === 1 ? '' : 's') + ' queued.', 'ok');
      FU.picked = null; FU.edits = {};
    } catch (e) { toast('Could not send: ' + (e.message || e)); }
    render();
  }
  async function exportUnbilled() {
    await window.UFC_Vendor.excel();
    if (typeof ExcelJS === 'undefined') { toast('Excel library not loaded.'); return; }
    const U = STORE.finUnbilled(ASOF, CATALOG); const year = ASOF.slice(0, 4); const prev = Number(year) - 1;
    const NAVY = 'FF25273A', WHITE = 'FFFFFFFF', RED = 'FFCE181E'; const fmt = '#,##0;[Red]-#,##0;"-"';
    const wb = new ExcelJS.Workbook(); wb.creator = 'Savills PPM · Financial Tracking (TEST)';
    const ws = wb.addWorksheet(MONTHS[+ASOF.slice(5) - 1] + ' ' + year + ' Unbilled Sched', { views: [{ state: 'frozen', ySplit: 4, xSplit: 3 }] });
    const ncol = 4 + U.months.length * 2;
    ws.getCell('B1').value = 'P&PM — Schedule of Unbilled Fees'; ws.getCell('B1').font = { name: 'Calibri', bold: true, size: 14, color: { argb: NAVY } };
    ws.getCell('B2').value = 'Balances at ' + ymLong(ASOF).replace(/^(\w+) /, (m, w) => w + ' ' + new Date(+year, +ASOF.slice(5), 0).getDate() + ', '); ws.getCell('B2').font = { name: 'Calibri', bold: true };
    const h3 = ws.addRow(['Project ID', 'Client', 'Project', 'Balance'].concat(...U.months.map(m => [MONTHS_LONG[+m.slice(5) - 1], 'YTD']), ['Comments']));
    const h4 = ws.addRow(['', '', '', new Date(prev, 11, 31)].concat(...U.months.map(m => ['', new Date(+m.slice(0, 4), +m.slice(5), 0)]), ['']));
    [h3, h4].forEach(r => r.eachCell(c => { c.font = { name: 'Calibri', bold: true, color: { argb: WHITE } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { horizontal: 'center' }; }));
    h4.eachCell((c, i) => { if (i >= 4) c.numFmt = 'm/d/yyyy'; });
    const put = (vals, opts) => { const x = ws.addRow(vals); x.eachCell((c, i) => { if (i >= 4 && i < ncol) c.numFmt = fmt; if (opts && opts.bold) c.font = { name: 'Calibri', bold: true }; if (opts && opts.red) c.font = { name: 'Calibri', bold: !!opts.bold, color: { argb: RED } }; if (opts && opts.fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } }; }); return x; };
    U.rows.forEach(r => put([r.projectId, r.pj.client || '', (r.pj.name || '') + (r.kind === 'share' ? ' — FEE SHARE (' + r.broker + ')' : r.kind === 'pass' ? ' — ' + r.label : ''), r.opening].concat(...U.months.map(m => [r.byMonth[m].net || null, r.byMonth[m].ytd]), [r.comment || r.autoComment]), { red: r.kind === 'share' }));
    const tot = (label, list, o) => put(['', label, '', sum(list, r => r.opening)].concat(...U.months.map(m => [sum(list, r => r.byMonth[m].net), sum(list, r => r.byMonth[m].ytd)]), ['']), Object.assign({ bold: true, fill: 'FFEEE8E3' }, o || {}));
    ws.addRow([]);
    const t = tot('Unbilled — all lines', U.rows); t.eachCell(c => { c.font = { name: 'Calibri', bold: true, color: { argb: WHITE } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; });
    tot('Gross revenue', U.rows.filter(r => r.kind !== 'share')); tot('Fee share', U.rows.filter(r => r.kind === 'share'), { red: true });
    ws.columns = [{ width: 12 }, { width: 24 }, { width: 46 }, { width: 13 }].concat(...U.months.map(() => [{ width: 11 }, { width: 12 }]), [{ width: 44 }]);
    const buf = await wb.xlsx.writeBuffer(); const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'Savills PPM - ' + ASOF.slice(5) + '.' + year.slice(2) + ' Unbilled Schedule.xlsx'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    try { STORE.logSystem && STORE.logSystem('fin-export', { ym: ASOF, kind: 'unbilled', lines: U.rows.length }); } catch (e) {}
  }

  function wire(host, st) {
    $('#ft-cycle', host).addEventListener('change', e => { CYCLE = e.target.value; remember(); render(); });
    $$('.ft-tab', host).forEach(b => b.addEventListener('click', () => { TAB = b.dataset.tab; remember(); render(); }));
    $('#ft-q', host).addEventListener('input', e => { Q = e.target.value; render(); const q = $('#ft-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } });
    $('#ft-leader', host).addEventListener('change', e => { LEADER = e.target.value; render(); });
    $('#ft-export', host).addEventListener('click', () => exportEom().catch(e => toast('Export failed: ' + (e.message || e))));
    $$('[data-snap]', host).forEach(b => b.addEventListener('click', () => {
      const kind = b.dataset.snap; const have = st[kind];
      const lines = Object.keys(STORE.finSnapshotValues(CYCLE, CATALOG)).length;
      const msg = (have ? 'Retake the ' + kind + ' snapshot for ' + ymLong(CYCLE) + '?\n\nThe one taken ' + fmtStamp(have.at) + ' is replaced.' : 'Take the ' + kind + ' snapshot for ' + ymLong(CYCLE) + ' work performed?') + '\n\n' + lines + ' line-months are frozen as they stand now' + (kind === 'eom' ? ', and this becomes next month\'s Prior EOM column.' : '.');
      if (!confirm(msg)) return;
      try { STORE.takeFinSnapshot(CYCLE, kind, STORE.finSnapshotValues(CYCLE, CATALOG), { replace: !!have }); flush(); toast(kind[0].toUpperCase() + kind.slice(1) + ' snapshot taken.', 'ok'); } catch (e) { toast(e.message); }
      render();
    }));
    $$('.ft-eom', host).forEach(inp => inp.addEventListener('change', () => {
      const [pid, line, k] = inp.dataset.key.split('|'); const v = inp.value === '' ? null : Number(inp.value);
      try { STORE.setFinLine(pid, line, k, { accruedAmt: v }); flush(); } catch (e) { toast(e.message); }
      const y = window.scrollY; render(); window.scrollTo(0, y);
    }));
    $$('[data-open]', host).forEach(b => b.addEventListener('click', () => openLine(b.dataset.open)));
    $$('tr.ft-row', host).forEach(tr => tr.addEventListener('dblclick', (e) => { if (e.target.closest('input,button,a')) return; openLine(tr.dataset.key); }));
  }

  /* ---------- the pop-up: one line-month ---------- */
  function monthOpts(fromYm, selected, blankLabel) {
    const [y, m] = fromYm.split('-').map(Number); const out = blankLabel ? ['<option value=""' + (!selected ? ' selected' : '') + '>' + blankLabel + '</option>'] : [];
    for (let i = -1; i <= 14; i++) { const d = new Date(y, m - 1 + i, 1); const v = ym(d.getFullYear(), d.getMonth() + 1); out.push('<option value="' + v + '"' + (v === selected ? ' selected' : '') + '>' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + '</option>'); }
    if (selected && !out.some(o => o.indexOf('value="' + selected + '"') >= 0)) out.push('<option value="' + selected + '" selected>' + ymLabel(selected) + '</option>');
    return out.join('');
  }
  function openLine(key) {
    const r = STORE.finRows(CYCLE, CATALOG).find(x => x.key === key); if (!r) return;
    const w = r.work; const st = STORE.finCycleState(CYCLE); const lk = !!st.lockedAt;
    const siblings = STORE.finRows(CYCLE, CATALOG).filter(x => x.pid === r.pid && x.key !== key);
    let ov = $('#ft-ov'); if (!ov) { ov = document.createElement('div'); ov.id = 'ft-ov'; ov.className = 'ra-ov'; document.body.appendChild(ov); }
    const dis = lk ? ' disabled' : '';
    const lineLabel = r.kind === 'fee' ? 'Gross revenue' : r.kind === 'share' ? 'Fee share · ' + (r.broker || 'broker') : r.label;
    ov.innerHTML = '<div class="ra-modal ft-modal" role="dialog" aria-modal="true"><div class="mh"><div><h3>' + esc((r.pj.client ? r.pj.client + ' — ' : '') + (r.pj.name || 'Untitled')) + '</h3><div class="sub">' + esc(lineLabel) + ' · ' + esc(ymLong(CYCLE)) + ' work performed' + (r.projectId ? ' · ' + esc(r.projectId) : '') + (lk ? ' · <b>locked</b>' : '') + '</div></div><button type="button" class="x" id="ft-x" aria-label="Close">×</button></div>' +
      '<div class="mb"><div class="ft-lanes">' +
        '<div class="ft-lane locked"><h4>Earned · locked</h4><div class="big">' + money(r.earned) + '</div><div class="sub">' + esc(ymLabel(CYCLE)) + ' · the revenue leader\'s projection' + (r.leader ? ' · ' + esc(r.leader) : '') + '. Only the leader moves this, in Revenue Projections.</div><a class="sub" href="Revenue Projections.html">Open Revenue Projections →</a></div>' +
        '<div class="ft-lane"><h4>Accrued</h4><label>Month<select id="ft-ain"' + dis + '>' + monthOpts(CYCLE, w.accruedIn) + '</select></label><label>Amount<input type="number" step="1" id="ft-aamt" value="' + (w.accruedAmt != null ? Math.round(w.accruedAmt) : '') + '" placeholder="' + Math.round(r.earned) + '"' + dis + '></label><div class="sub">Defaults to the earned amount' + (r.timecard ? ', or the billed amount on a time-card line' : '') + '. Type what Finance is confident in.</div><label class="chk"><input type="checkbox" id="ft-hold"' + (w.hold ? ' checked' : '') + dis + '> Hold · accrued, bill TBD</label></div>' +
        '<div class="ft-lane"><h4>Billed</h4><label>Month<select id="ft-bin"' + dis + '>' + monthOpts(CYCLE, w.billedIn, '— not yet —') + '</select></label><label>Amount<input type="number" step="1" id="ft-bamt" value="' + (w.billedAmt != null ? Math.round(w.billedAmt) : '') + '" placeholder="' + Math.round(w.accruedAmt) + '"' + dis + '></label><div class="two"><label>Invoice<input type="text" id="ft-inv" value="' + esc(w.invoice) + '" placeholder="US02-…"' + dis + '></label><label>Date issued<input type="date" id="ft-bdate" value="' + esc(w.billedDate) + '"' + dis + '></label></div><div class="sub">Leave the month empty to hold it. Fill it when the invoice goes.</div></div>' +
      '</div>' +
      '<div class="ft-flagrow"><span class="ft-status s-' + w.status + '"><i></i>' + esc(w.statusLabel) + '</span><span class="sub">Status follows the three lanes. Override only for the two Finance states:</span><select id="ft-flag"' + dis + '><option value=""' + (!w.flag ? ' selected' : '') + '>— automatic —</option><option value="approval"' + (w.flag === 'approval' ? ' selected' : '') + '>Awaiting invoice approval</option><option value="cr"' + (w.flag === 'cr' ? ' selected' : '') + '>Discuss with CR</option></select>' +
        '<span class="grow"></span><span class="sub">Prior EOM ' + money(r.priorEom) + ' · Flash ' + money(r.flash) + ' · Final ' + money(r.final) + '</span></div>' +
      '<label class="ft-note-field">Note<input type="text" id="ft-note" value="' + esc(w.note) + '" placeholder="What happened — PO pending, milestone, credit via JE…"' + dis + '></label>' +
      (siblings.length ? '<div class="ft-sibs">' + siblings.map(s => '<button type="button" class="ft-sib ln-' + s.kind + '" data-open="' + esc(s.key) + '">' + (s.kind === 'share' ? 'Fee share · ' + esc(s.broker || 'broker') : esc(s.label)) + ' · ' + money(s.eom) + ' · ' + esc(s.work.statusLabel) + ' →</button>').join('') + '<div class="sub">Same project, this month. A fee share goes out with the billing of the fee line.</div></div>' : '') +
      '</div><div class="mf">' + (w.at ? '<span class="sub">Last saved ' + esc(fmtStamp(w.at)) + (w.byName ? ' by ' + esc(w.byName) : '') + '</span>' : '') + '<span class="grow"></span><button type="button" class="btn btn-secondary" id="ft-cancel">' + (lk ? 'Close' : 'Cancel') + '</button>' + (lk ? '' : '<button type="button" class="btn btn-primary" id="ft-save">Save</button>') + '</div></div>';
    ov.classList.add('open');
    const close = () => { ov.classList.remove('open'); ov.innerHTML = ''; };
    $('#ft-x', ov).onclick = close; $('#ft-cancel', ov).onclick = close; ov.onclick = (e) => { if (e.target === ov) close(); };
    $$('[data-open]', ov).forEach(b => b.onclick = () => openLine(b.dataset.open));
    const save = $('#ft-save', ov);
    if (save) save.onclick = () => {
      try {
        STORE.setFinLine(r.pid, r.line, CYCLE, {
          accruedIn: $('#ft-ain', ov).value, accruedAmt: $('#ft-aamt', ov).value === '' ? null : Number($('#ft-aamt', ov).value),
          billedIn: $('#ft-bin', ov).value || null, billedAmt: $('#ft-bamt', ov).value === '' ? null : Number($('#ft-bamt', ov).value),
          invoice: $('#ft-inv', ov).value, billedDate: $('#ft-bdate', ov).value, hold: $('#ft-hold', ov).checked, flag: $('#ft-flag', ov).value, note: $('#ft-note', ov).value,
        });
        flush(); close(); toast('Saved.', 'ok');
      } catch (e) { toast(e.message || String(e)); return; }
      const y = window.scrollY; render(); window.scrollTo(0, y);
    };
  }

  /* ---------- the EOM file: Finance's sheet, as Excel ---------- */
  async function exportEom() {
    await window.UFC_Vendor.excel();
    if (typeof ExcelJS === 'undefined') { toast('Excel library not loaded.'); return; }
    const st = STORE.finCycleState(CYCLE); const rows = STORE.finRows(CYCLE, CATALOG); const billingYm = STORE.finYmPlus(CYCLE, 1);
    const NAVY = 'FF25273A', WHITE = 'FFFFFFFF', RED = 'FFCE181E', FILL = { confirm: 'FFFFE0A8', approval: 'FFD6E7F5', cr: 'FFFFF59E', hold: 'FFECEBE6' };
    const fmt = '#,##0;[Red]-#,##0;"-"';
    const wb = new ExcelJS.Workbook(); wb.creator = 'Savills PPM · Financial Tracking (TEST)';
    const ws = wb.addWorksheet(MONTHS[+CYCLE.slice(5) - 1].toUpperCase() + ' WP', { views: [{ state: 'frozen', ySplit: 4, xSplit: 4 }] });
    ws.mergeCells('A1:V1'); ws.getCell('A1').value = 'Savills PPM — ' + CYCLE.slice(0, 4) + ' Revenue — ' + ymLong(billingYm) + ' billing for ' + ymLong(CYCLE) + ' work performed'; ws.getCell('A1').font = { name: 'Calibri', bold: true, size: 14, color: { argb: NAVY } };
    ws.mergeCells('A2:V2'); ws.getCell('A2').value = 'Prior EOM ' + (st.priorEom ? fmtStamp(st.priorEom.at) : 'none') + ' · Flash ' + (st.flash ? fmtStamp(st.flash.at) : 'not taken') + ' · Final ' + (st.final ? fmtStamp(st.final.at) : 'not taken') + ' · EOM ' + (st.eom ? fmtStamp(st.eom.at) : 'working copy') + ' · exported ' + new Date().toLocaleString(); ws.getCell('A2').font = { name: 'Calibri', italic: true, size: 10 };
    ws.addRow([]);
    const hdr = ws.addRow(['#', 'Project ID', 'Client', 'Project Name', 'Project Details', 'Category', 'Party Due Revenue', 'Earned (leader)', 'Prior EOM', '#1 Flash', '#2 Final', '#3 EOM', 'Date Issued', 'Billings', 'Ranking', 'Status', 'Prior EOM vs Flash', 'Final vs Flash', 'EOM vs Final', 'Billings vs EOM', 'Accrued, not billed', 'Notes']);
    hdr.eachCell(c => { c.font = { name: 'Calibri', bold: true, color: { argb: WHITE } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { wrapText: true, vertical: 'middle' }; });
    let n = 0;
    const put = (r) => {
      const w = r.work; n++;
      const x = ws.addRow([n, r.projectId, r.pj.client || '', r.pj.name || '', endLabel(r.p), r.kind === 'fee' ? 'Gross Revenue' : r.kind === 'share' ? 'Fee Share' : 'Pass-through', r.kind === 'share' ? r.broker : '',
        r.earned, r.priorEom, r.flash, r.final, r.eom, w.billedDate || (w.billedIn ? ymLabel(w.billedIn) : ''), w.billedAmt, 'Ranking #' + STORE.ratingFor(r.p), w.statusLabel,
        r.dPriorFlash, r.dFinalFlash, r.dEomFinal, r.dBilledEom, w.accruedNotBilled, w.note]);
      [8, 9, 10, 11, 12, 14, 17, 18, 19, 20, 21].forEach(i => { x.getCell(i).numFmt = fmt; });
      if (FILL[w.status]) x.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[w.status] } }; });
      if (r.kind === 'share') x.eachCell(c => { c.font = { name: 'Calibri', color: { argb: RED } }; });
      return x.number;
    };
    const subtotal = (label, list) => {
      const x = ws.addRow(['', label, '', '', '', '', '', sum(list, r => r.earned), any(list, r => r.priorEom) ? sum(list, r => r.priorEom) : null, any(list, r => r.flash) ? sum(list, r => r.flash) : null, any(list, r => r.final) ? sum(list, r => r.final) : null, sum(list, r => r.eom), '', sum(list, r => r.work.billedAmt), '', '', any(list, r => r.dPriorFlash) ? sum(list, r => r.dPriorFlash) : null, any(list, r => r.dFinalFlash) ? sum(list, r => r.dFinalFlash) : null, any(list, r => r.dEomFinal) ? sum(list, r => r.dEomFinal) : null, any(list, r => r.dBilledEom) ? sum(list, r => r.dBilledEom) : null, sum(list, r => r.work.accruedNotBilled), '']);
      x.eachCell(c => { c.font = { name: 'Calibri', bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEE8E3' } }; });
      [8, 9, 10, 11, 12, 14, 17, 18, 19, 20, 21].forEach(i => { x.getCell(i).numFmt = fmt; });
      return x;
    };
    const fixed = rows.filter(r => !r.timecard), tcard = rows.filter(r => r.timecard);
    fixed.forEach(put); subtotal('Subtotal #1: FIXED FEE', fixed);
    tcard.forEach(put); subtotal('Subtotal #2: TIME CARD', tcard);
    const tot = subtotal('GRAND TOTAL: NET REVENUE — ' + ymLong(CYCLE).toUpperCase() + ' WORK PERFORMED', rows);
    tot.eachCell(c => { c.font = { name: 'Calibri', bold: true, color: { argb: WHITE } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; });
    subtotal('Gross Revenue', rows.filter(r => r.kind !== 'share'));
    const sh = subtotal('Fee Share', rows.filter(r => r.kind === 'share')); sh.eachCell(c => { c.font = { name: 'Calibri', bold: true, color: { argb: RED } }; });
    ws.columns = [{ width: 5 }, { width: 12 }, { width: 22 }, { width: 40 }, { width: 24 }, { width: 14 }, { width: 24 }, { width: 14 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 12 }, { width: 13 }, { width: 11 }, { width: 30 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 16 }, { width: 44 }];
    const buf = await wb.xlsx.writeBuffer(); const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'Savills PPM - ' + CYCLE.slice(0, 4) + ' Revenue - ' + ymLong(billingYm) + ' for ' + ymLong(CYCLE) + ' Work Performed - EOM ' + new Date().toISOString().slice(0, 10) + '.xlsx'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    try { STORE.logSystem && STORE.logSystem('fin-export', { ym: CYCLE, lines: rows.length }); } catch (e) {}
  }

  /* ---------- boot ---------- */
  function start() {
    render();
    document.addEventListener('ufc:remote-updated', () => render());
    document.addEventListener('ufc:rates', () => render());
    document.addEventListener('ufc:revenue-updated', () => render());
  }
  if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(start, start); else start();
  window.UFC_FinTest = { render, openLine, exportEom, exportUnbilled, sendFollowUps, FU };
})();
