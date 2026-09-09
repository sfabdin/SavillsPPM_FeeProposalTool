/* ============================================================
   MONTHLY CONFIRMED BOOK · page controller
   ------------------------------------------------------------
   Three tabs. My book: the signed-in leader's projects and the one
   CONFIRM button. Tracker: every leader × the last months, green /
   yellow / red. Months: admins open a month, set its deadline, lock
   it, reopen it. The rules live in confirmed-book.js; this file only
   draws them and wires the buttons.
   ============================================================ */
(function () {
  'use strict';
  const S = window.UFC_Store, C = window.UFC_Confirm, Box = window.UFC_Box, UI = window.UFC_UI;
  const $ = (q, el) => (el || document).querySelector(q);
  const esc = UI.esc;
  const toast = UI.toast;
  const money = (n) => S.fmtMoney(n);
  const TAB_KEY = 'ufc_cb_tab_v1';
  const MONTHS_SHOWN = 6;
  let tab = 'book';
  try { tab = localStorage.getItem(TAB_KEY) || 'book'; } catch (e) {}
  let detail = '';
  const pulled = new Set();

  const records = () => S.listProjects();
  const byIdOf = (list) => { const m = {}; list.forEach(r => { m[r.id] = r; }); return m; };
  const ratingLabel = (r) => { const n = S.ratingFor(r); const m = S.ratingMeta(n); return n + ' · ' + (m.short || m.label); };
  const fmtDate = (ymd) => { const d = new Date(String(ymd) + 'T12:00:00'); return isNaN(d) ? String(ymd || '') : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); };
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const announce = () => { try { document.dispatchEvent(new CustomEvent('ufc:confirmed-updated')); } catch (e) {} };

  /* ---------- identity bar (same control as the Change Log) ---------- */
  function buildIdentityBar() {
    const sel = $('#id-user'); const label = $('.identity-bar .id-label');
    const cur = S.getCurrentUser();
    if (!S.canImpersonate()) {
      if (sel) sel.style.display = 'none';
      if (label) label.textContent = 'Signed in as';
      let nameEl = document.getElementById('id-static-name');
      if (!nameEl && sel) {
        nameEl = document.createElement('span'); nameEl.id = 'id-static-name';
        nameEl.style.cssText = 'font-family:var(--font-display);font-weight:700;font-size:13px;color:#fff;margin:0 4px;';
        sel.parentNode.insertBefore(nameEl, sel.nextSibling);
      }
      if (nameEl) nameEl.textContent = cur.name || '(unrecognized)';
    } else {
      if (label) label.textContent = 'Viewing as';
      if (sel) sel.style.display = '';
      const roster = S.impersonationRoster(); const imp = S.getImpersonation();
      sel.innerHTML = ['<option value="__me__">Me</option>']
        .concat(roster.map(r => '<option value="' + esc(r.username) + '">' + esc(r.name) + (r.role === 'admin' ? ' · admin' : '') + '</option>')).join('');
      sel.value = imp ? esc(imp) : '__me__';
      if (sel.selectedIndex < 0) sel.value = '__me__';
      sel.onchange = () => { const v = sel.value; if (v === '__me__') S.clearImpersonation(); else S.setImpersonation(v); render(); };
    }
    const roleEl = $('#id-role'), noteEl = $('#id-note');
    const me = C.myLeaderId(cur);
    if (C.isLeadership(cur)) { roleEl.textContent = 'Leadership · opens and locks months'; roleEl.className = 'id-role admin'; }
    else if (me) { roleEl.textContent = 'Revenue leader'; roleEl.className = 'id-role member'; }
    else { roleEl.textContent = 'Not a revenue leader'; roleEl.className = 'id-role member'; }
    noteEl.textContent = cur.impersonating ? 'Previewing ' + (cur.name || 'this person') : (me ? 'Confirms as ' + C.leaderName(me) : '');
  }

  /* ---------- tabs ---------- */
  function wireTabs() {
    document.querySelectorAll('.cb-tabs button').forEach(b => b.addEventListener('click', () => {
      tab = b.dataset.tab; try { localStorage.setItem(TAB_KEY, tab); } catch (e) {}
      render();
    }));
  }
  function showTab() {
    const lead = C.isLeadership();
    $('#tab-months').hidden = !lead;
    if (tab === 'months' && !lead) tab = 'book';
    document.querySelectorAll('.cb-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    ['book', 'tracker', 'months'].forEach(k => { $('#pane-' + k).hidden = k !== tab; });
  }

  /* ================= MY BOOK ================= */
  function paneBook() {
    const recs = records(); const cur = C.currentCycle(); const me = C.myLeaderId(); const lead = C.isLeadership();
    const w = C.widgetState();
    let html = '';
    if (w.kind === 'missed') html += missedBanner(w.cycle, me, recs);
    if (!cur) {
      html += '<div class="empty"><b>No month is open for confirmation.</b><br>' + (lead ? 'Open one from the Months tab.' : 'An admin opens each month; the countdown appears on every page once it is open.') + '</div>';
    } else if (me) {
      html += leaderBook(cur, me, recs);
    } else if (!lead) {
      html += '<div class="empty">You are not in the revenue leaders directory, so there is nothing for you to confirm.</div>';
    }
    if (lead && cur) {
      const orphans = C.bookFor(C.UNASSIGNED, recs).filter(C.isActiveRecord);
      if (orphans.length) html += leaderBook(cur, C.UNASSIGNED, recs);
    }
    return html;
  }

  function missedBanner(cycle, me, recs) {
    const mine = C.bookFor(me, recs);
    return '<div class="banner red" id="missed">' +
      '<b>' + esc(C.ymLong(cycle.cycle)) + ' was locked on ' + esc(C.fmtDay(cycle.lockedAt)) + (cycle.lockedByName ? ' by ' + esc(cycle.lockedByName) : '') + ' without your confirmation.</b> ' +
      'Your ' + plural(mine.length, 'live project') + ' were carried into the confirmed book and flagged “not confirmed”. Confirm now with a short reason — an admin will review it.' +
      '<div class="reason"><textarea id="missed-reason" placeholder="Why the confirmation is late (a sentence is enough)"></textarea>' +
      '<div class="row"><button class="btn btn-primary" id="missed-confirm" data-ym="' + esc(cycle.cycle) + '" data-l="' + esc(me) + '">Confirm ' + esc(C.monthName(cycle.cycle)) + ' with this reason</button>' +
      '<span class="sub">Stamps ' + plural(mine.length, 'project') + ' with your name and the time, replacing the carried copies.</span></div></div></div>';
  }

  function leaderBook(cycle, leaderId, recs) {
    const ym = cycle.cycle, year = +ym.slice(0, 4);
    const byId = byIdOf(recs);
    const mine = C.bookFor(leaderId, recs).sort((a, b) => ((a.project || {}).client || '').localeCompare((b.project || {}).client || '') || ((a.project || {}).name || '').localeCompare((b.project || {}).name || ''));
    const st = C.statusFor(cycle, leaderId, recs);
    const k = cycle.confirmations[leaderId];
    const fee = C.feeInYear(mine, year);
    const shared = mine.filter(r => C.leadersOf(r, byId).length > 1).length;
    const d = C.daysUntil(cycle.deadline); const over = C.pastDeadline(cycle.deadline);
    const who = leaderId === C.UNASSIGNED ? 'the unassigned projects' : 'your book';
    const eyebrow = C.ymLong(ym) + ' · open · confirm by ' + fmtDate(cycle.deadline) + ' · ' +
      (over ? 'OVERDUE · ' + plural(-d, 'day') + ' late' : d === 0 ? 'due today' : plural(d, 'day') + ' left');
    const pillCls = st.k === 'overdue' ? 'rr' : st.tone;
    const pillTxt = { confirmed: 'Confirmed', changed: 'Confirmed · edited since', due: 'Not confirmed', overdue: 'Overdue', missed: 'Not confirmed', none: 'Nothing to confirm' }[st.k];
    let stamp, btn;
    if (k) {
      stamp = '<b>Confirmed ' + esc(C.fmtStamp(k.at)) + ' by ' + esc(k.name) + '.</b> Locked in for ' + esc(C.monthName(ym)) + '.' +
        (st.k === 'changed' ? ' <b>' + plural(st.changed, 'project') + ' edited since</b> — noted on the tracker; the changes carry into next month\'s confirmation.' : ' One confirmation per month; changes from here carry into next month.') +
        (k.afterLock ? '<div class="sub">Confirmed after the month was locked — reason: “' + esc(k.reason || '') + '”' + (k.reviewedAt ? ' · reviewed by ' + esc(k.reviewedBy) : ' · awaiting admin review') + '</div>' : '');
      btn = '<button class="btn btn-primary" disabled>Confirmed</button>';
    } else {
      stamp = (over ? '<b>The deadline was ' + esc(fmtDate(cycle.deadline)) + '. ' + esc(C.monthName(ym)) + ' is not confirmed.</b> ' : '<b>Not yet confirmed for ' + esc(C.ymLong(ym)) + '.</b> ') +
        'Confirming stamps ' + plural(mine.length, 'project') + ' with your name and the current time. One confirmation per month — check the list first.';
      btn = '<button class="btn btn-primary" id="confirm-' + esc(leaderId) + '" data-ym="' + esc(ym) + '" data-l="' + esc(leaderId) + '"' + (mine.length ? '' : ' disabled') + '>' +
        (leaderId === C.UNASSIGNED ? 'Confirm unassigned projects' : over ? 'Confirm my book now' : 'Confirm my book') + '</button>';
    }
    const rows = mine.map(r => {
      const pj = r.project || {};
      const ps = C.projectStatus(cycle, r, byId);
      const others = ps.leaders.filter(l => l !== leaderId).map(C.leaderName);
      let inBook;
      if (!ps.copy) inBook = '<span class="pill r"><i></i>Not yet</span>';
      else if (ps.copy._carried) inBook = '<span class="pill y"><i></i>Carried · not confirmed</span>';
      else if (ps.copy._confirmedBy === leaderId) inBook = '<span class="pill g"><i></i>You · ' + esc(C.fmtStamp(ps.copy._confirmedAt)) + '</span>' +
        (ps.waiting.length ? '<div class="sub">awaiting ' + esc(ps.waiting.map(C.leaderName).join(', ')) + '</div>' : ps.leaders.length > 1 ? '<div class="sub">fully confirmed</div>' : '') +
        (ps.editedSince ? '<div class="sub">edited since · noted</div>' : '');
      else inBook = '<span class="pill g"><i></i>' + esc(C.leaderName(ps.copy._confirmedBy)) + ' · ' + esc(C.fmtStamp(ps.copy._confirmedAt)) + '</span>' +
        '<div class="sub">' + (k ? 'shared · their copy stands' : 'shared · awaiting you') + '</div>';
      return '<tr><td>' + esc(pj.client || '') + '</td>' +
        '<td><a href="Universal Fee Calculator.html?id=' + encodeURIComponent(r.id) + '" style="color:inherit;font-weight:600">' + esc(pj.name || 'Untitled') + '</a><div class="mono">' + esc(pj.projectNumber || r.id) + '</div></td>' +
        '<td>' + esc(ratingLabel(r)) + '</td>' +
        '<td class="money">' + money(C.feeInYear([r], year)) + '</td>' +
        '<td>' + esc(C.fmtStamp(r.updatedAt)) + '</td>' +
        '<td>' + (others.length ? esc(others.join(', ')) : '<span class="sub">—</span>') + '</td>' +
        '<td>' + inBook + '</td></tr>';
    }).join('');
    return '<div class="cb-head"><div><div class="eyebrow' + (over && !k ? ' late' : '') + '">' + esc(eyebrow) + '</div>' +
      '<h2>' + (k ? esc(C.monthName(ym)) + ' book confirmed' : 'Confirm ' + (leaderId === C.UNASSIGNED ? 'the unassigned projects' : 'your book') + ' for ' + esc(C.monthName(ym))) + '</h2>' +
      '<p>Every project ' + (leaderId === C.UNASSIGNED ? 'with no revenue leader' : 'you lead') + ', as it stands right now. Confirming copies these records into the ' + esc(C.monthName(ym)) + ' confirmed book.</p></div>' +
      '<div><span class="pill ' + pillCls + '"><i></i>' + esc(pillTxt) + '</span></div></div>' +
      '<div class="panel"><div class="kpis">' +
      '<div class="kpi"><div class="v">' + mine.length + '</div><div class="s">projects in ' + esc(who) + '</div></div>' +
      '<div class="kpi"><div class="v">' + money(fee) + '</div><div class="s">' + year + ' fee</div></div>' +
      '<div class="kpi"><div class="v">' + shared + '</div><div class="s">shared with another leader</div></div>' +
      '<div class="kpi"><div class="v small">' + (k ? esc(C.fmtStamp(k.at)) : '—') + '</div><div class="s">' + (k ? 'confirmed' : 'not confirmed yet') + '</div></div>' +
      '</div><div class="confirm' + (over && !k ? ' overdue' : '') + '"><div class="stamp">' + stamp + '</div>' + btn + '</div></div>' +
      '<div class="panel"><div class="ph"><h3>Projects in this confirmation</h3><span class="sub">' + plural(mine.length, 'project') + '</span></div>' +
      '<div class="tw"><table class="cb-table"><thead><tr><th>Client</th><th>Project</th><th>Rating</th><th class="money">' + year + ' fee</th><th>Last edited</th><th>Shared with</th><th>In the ' + esc(C.monthName(ym)) + ' book</th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="7" class="sub">No projects.</td></tr>') + '</tbody></table></div></div>';
  }

  function wireBook(host) {
    host.querySelectorAll('button[data-ym][data-l]').forEach(b => b.addEventListener('click', () => {
      const ym = b.dataset.ym, l = b.dataset.l;
      const reasonEl = b.id === 'missed-confirm' ? $('#missed-reason', host) : null;
      const reason = reasonEl ? reasonEl.value : '';
      const n = C.bookFor(l, records()).length;
      if (!window.confirm('Confirm ' + plural(n, 'project') + ' for ' + C.ymLong(ym) + '? This is your one confirmation for the month — it cannot be redone.')) return;
      try {
        C.confirm(ym, l, { reason });
        toast(C.monthName(ym) + ' book confirmed — ' + plural(n, 'project') + ' stamped.', 'ok');
        if (Box && Box.flushConfirm) Box.flushConfirm().catch(() => {});
        announce(); render();
      } catch (e) { toast(e.message || String(e)); }
    }));
  }

  /* ================= TRACKER ================= */
  function trackerMonths() {
    const known = C.knownCycles();
    return known.slice(-MONTHS_SHOWN);
  }
  function ensureMonthsLoaded(yms) {
    if (!Box || !Box.enabled || !Box.pullConfirmCycle) return;
    const missing = yms.filter(y => !C.getCycle(y) && !pulled.has(y));
    if (!missing.length) return;
    missing.forEach(y => pulled.add(y));
    Promise.all(missing.map(y => Box.pullConfirmCycle(y).catch(() => null))).then(() => { if (tab === 'tracker') render(); });
  }
  function paneTracker() {
    const recs = records(); const yms = trackerMonths();
    ensureMonthsLoaded(yms);
    if (!yms.length) return '<div class="empty">No months have been opened yet.</div>';
    const cycles = yms.map(C.getCycle);
    const cur = C.currentCycle() || cycles.filter(Boolean).pop();
    const me = C.myLeaderId(); const lead = C.isLeadership();
    const expected = C.expectedLeaders(recs);
    const seen = new Set(expected);
    cycles.forEach(c => { if (c) Object.keys(c.confirmations).forEach(id => seen.add(id)); });
    const leaders = [...seen].filter(id => id !== C.UNASSIGNED).sort((a, b) => C.leaderName(a).localeCompare(C.leaderName(b)));
    if (seen.has(C.UNASSIGNED)) leaders.push(C.UNASSIGNED);

    let kpis = '';
    if (cur) {
      const due = expected.filter(id => C.statusFor(cur, id, recs).k !== 'none');
      const cnt = (ks) => due.filter(id => ks.indexOf(C.statusFor(cur, id, recs).k) >= 0).length;
      const d = C.daysUntil(cur.deadline); const over = C.pastDeadline(cur.deadline);
      kpis = '<div class="kpis">' +
        '<div class="kpi"><div class="v">' + cnt(['confirmed']) + ' <span style="font-size:14px;color:#79828C">of ' + due.length + '</span></div><div class="s">confirmed and current for ' + esc(C.ymShort(cur.cycle)) + '</div></div>' +
        '<div class="kpi"><div class="v">' + cnt(['changed']) + '</div><div class="s">confirmed, then edited</div></div>' +
        '<div class="kpi"><div class="v"' + (cnt(['overdue', 'missed']) ? ' style="color:var(--sav-red)"' : '') + '>' + cnt(['due', 'overdue', 'missed']) + '</div><div class="s">not confirmed' + (cnt(['overdue', 'missed']) ? ' · ' + cnt(['overdue', 'missed']) + ' overdue' : '') + '</div></div>' +
        '<div class="kpi"><div class="v"' + (over ? ' style="color:var(--sav-red)"' : '') + '>' + (cur.lockedAt ? 'Locked' : over ? 'Passed' : d) + '</div><div class="s">' + (cur.lockedAt ? 'locked ' + esc(C.fmtDay(cur.lockedAt)) : (over ? 'deadline was ' : 'days until ') + esc(fmtDate(cur.deadline))) + '</div></div></div>';
    }
    const head = '<tr><th>Revenue leader</th>' + yms.map((y, i) => '<th>' + esc(C.ymShort(y)) + '<span class="st">' +
      (!cycles[i] ? 'loading…' : cycles[i].lockedAt ? 'locked' : 'open · by ' + esc(C.fmtDay(cycles[i].deadline + 'T12:00:00'))) + '</span></th>').join('') + '</tr>';
    const body = leaders.map(id => '<tr' + (id === me ? ' class="me"' : '') + '><td>' + esc(C.leaderName(id)) + (id === me ? ' <span class="sub">(you)</span>' : '') + '</td>' +
      yms.map((y, i) => {
        const c = cycles[i];
        const s = c ? C.statusFor(c, id, recs) : { k: 'none', tone: 'n', text: '…' };
        const rr = s.bold;
        return '<td><button class="cell' + (rr ? ' rr' : '') + '" data-l="' + esc(id) + '" data-m="' + esc(y) + '" aria-label="' + esc(C.leaderName(id) + ' ' + C.ymShort(y) + ': ' + s.text) + '"><span class="dot ' + s.tone + '"></span><span class="t">' + esc(s.text) + '</span></button></td>';
      }).join('') + '</tr>').join('');

    let reviews = '';
    if (lead) {
      const items = [];
      cycles.forEach(c => { if (!c) return; Object.keys(c.confirmations).forEach(id => { const k = c.confirmations[id]; if (k.afterLock) items.push({ c, id, k }); }); });
      if (items.length) reviews = '<div class="panel"><div class="ph"><h3>Late confirmations</h3><span class="sub">confirmed after the month was locked</span></div>' +
        '<div class="tw"><table class="cb-table"><thead><tr><th>Month</th><th>Leader</th><th>Confirmed</th><th>Reason</th><th>Review</th></tr></thead><tbody>' +
        items.map(x => '<tr><td>' + esc(C.ymLong(x.c.cycle)) + '</td><td>' + esc(C.leaderName(x.id)) + '</td><td>' + esc(C.fmtStamp(x.k.at)) + '</td><td>' + esc(x.k.reason || '') + '</td>' +
          '<td>' + (x.k.reviewedAt ? '<span class="pill g"><i></i>Reviewed · ' + esc(x.k.reviewedBy) + '</span>' : '<button class="btn btn-ghost small" data-review="' + esc(x.c.cycle) + '" data-l="' + esc(x.id) + '">Mark reviewed</button>') + '</td></tr>').join('') +
        '</tbody></table></div></div>';
    }
    return '<div class="cb-head"><div><div class="eyebrow">All revenue leaders</div><h2>Who has confirmed, month by month</h2>' +
      '<p>Everyone sees this. Your own row is highlighted. Click a cell for the stamp behind it.</p></div></div>' +
      '<div class="panel">' + kpis + '<div class="tracker tw"><table class="cb-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="legend"><span><i class="dot g"></i> Confirmed, nothing changed since</span><span><i class="dot y"></i> Confirmed, then projects edited</span>' +
      '<span><i class="dot r"></i> Not confirmed</span><span><i class="dot r" style="box-shadow:0 0 0 2px var(--sav-red)"></i> Overdue, or locked without them</span><span><i class="dot n"></i> Nothing to confirm</span></div>' +
      '<div class="detail" id="tr-detail">' + (detail || 'Click a cell to see who confirmed, when, and how many projects it covered.') + '</div></div>' + reviews;
  }
  function wireTracker(host) {
    host.querySelectorAll('.cell').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.l, y = b.dataset.m, c = C.getCycle(y); const recs = records();
      const nm = C.leaderName(id);
      if (!c) detail = 'Still loading ' + C.ymLong(y) + '.';
      else {
        const k = c.confirmations[id]; const s = C.statusFor(c, id, recs);
        if (s.k === 'none') detail = '<b>' + esc(nm) + '</b> had no active projects in ' + esc(C.ymLong(y)) + ', so nothing was expected.';
        else if (!k) detail = '<b>' + esc(nm) + '</b> has not confirmed ' + esc(C.ymLong(y)) + '. ' + (c.lockedAt ? 'The month was locked on ' + esc(C.fmtDay(c.lockedAt)) + ' with their live projects carried in and flagged.' : 'Confirm by ' + esc(fmtDate(c.deadline)) + '.');
        else detail = '<b>' + esc(nm) + '</b> confirmed ' + esc(C.ymLong(y)) + ' on <b>' + esc(C.fmtStamp(k.at)) + '</b> · ' + plural(k.projects, 'project') + ' · ' + money(k.fee) + ' ' + y.slice(0, 4) + ' fee' +
          (k.afterLock ? ' · <span class="pill y"><i></i>after lock</span>' : k.late ? ' · <span class="pill y"><i></i>after the deadline</span>' : '') +
          (s.k === 'changed' ? ' · <span class="pill y"><i></i>' + plural(s.changed, 'project') + ' edited since</span>' : '');
      }
      $('#tr-detail', host).innerHTML = detail;
    }));
    host.querySelectorAll('button[data-review]').forEach(b => b.addEventListener('click', () => {
      try { C.reviewLate(b.dataset.review, b.dataset.l); toast('Marked as reviewed.', 'ok'); render(); } catch (e) { toast(e.message); }
    }));
  }

  /* ================= MONTHS (admin) ================= */
  function paneMonths() {
    const recs = records(); const cycles = C.listCycles().slice().reverse();
    const known = C.knownCycles();
    const last = known.length ? known[known.length - 1] : null;
    const today = new Date().toISOString().slice(0, 7);
    const nextYm = last ? C.nextYm(last) : today;
    const rows = cycles.map(c => {
      const y = c.cycle; const year = +y.slice(0, 4);
      const exp = C.expectedLeaders(recs).filter(id => C.statusFor(c, id, recs).k !== 'none');
      const done = exp.filter(id => c.confirmations[id]).length;
      const copies = Object.values(c.projects);
      const carriedN = copies.filter(p => p._carried).length;
      const fee = C.feeInYear(copies, year);
      const state = c.lockedAt ? '<span class="pill n"><i></i>Locked ' + esc(C.fmtDay(c.lockedAt)) + '</span>' : (C.pastDeadline(c.deadline) ? '<span class="pill rr"><i></i>Open · past deadline</span>' : '<span class="pill g"><i></i>Open</span>');
      const dl = c.lockedAt ? esc(fmtDate(c.deadline)) : '<input type="date" value="' + esc(c.deadline) + '" data-dl="' + esc(y) + '" aria-label="Confirm-by date"> <button class="btn btn-ghost small" data-savedl="' + esc(y) + '">Save</button>';
      const act = c.lockedAt
        ? '<button class="btn btn-ghost small" data-reopen="' + esc(y) + '">Reopen</button> '
        : '<button class="btn small btn-secondary" data-lock="' + esc(y) + '">Lock month</button> ';
      return '<tr><td><b>' + esc(C.ymLong(y)) + '</b></td><td class="mono">confirmed-' + esc(y) + '.json</td><td>' + state + '</td><td>' + dl + '</td>' +
        '<td>' + done + ' of ' + exp.length + '</td><td>' + (c.lockedAt ? (c.carried || []).length + (carriedN ? ' · ' + plural(carriedN, 'project') : '') : '—') + '</td>' +
        '<td class="money">' + (copies.length ? money(fee) : '—') + '</td><td>' + esc(C.fmtDay(c.openedAt)) + (c.openedByName ? '<div class="sub">' + esc(c.openedByName) + '</div>' : '') + '</td>' +
        '<td style="white-space:nowrap">' + act + '<button class="btn btn-ghost small" data-dl-json="' + esc(y) + '">JSON</button></td></tr>';
    }).join('');
    return '<div class="cb-head"><div><div class="eyebrow">Leadership admins</div><h2>Open a month, set its deadline, lock it</h2>' +
      '<p>Opening a month writes a new file in the shared Box folder; nothing lands in it until a leader confirms. Locking freezes it, carries in anyone who never confirmed (flagged), and makes it the book Executive Reporting reads.</p></div></div>' +
      '<div class="panel"><div class="ph"><h3>Open the next month</h3></div><div class="pb"><div class="form">' +
      '<div class="field"><label for="ad-month">Month</label><input id="ad-month" type="month" value="' + esc(nextYm) + '"><div class="hint">Creates <span class="mono">confirmed-' + esc(nextYm) + '.json</span></div></div>' +
      '<div class="field"><label for="ad-deadline">Confirm by</label><input id="ad-deadline" type="date" value="' + esc(C.defaultDeadline(nextYm)) + '"><div class="hint">Counted down on every page; bold red once it passes</div></div>' +
      '<div class="field"><button class="btn btn-primary" id="ad-create">Open ' + esc(C.ymLong(nextYm)) + '</button></div>' +
      '</div><p class="sub" style="margin:14px 0 0">Everyone with at least one active project is expected, even if nothing changed. Leaders with no projects show grey, never red. On lock, a Revenue Diff snapshot of the confirmed book is saved so any two months can be compared.</p></div></div>' +
      '<div class="panel"><div class="ph"><h3>Months</h3><span class="sub">one file each, in the same Box folder as projects.json</span></div>' +
      '<div class="tw"><table class="cb-table"><thead><tr><th>Month</th><th>File</th><th>State</th><th>Confirm by</th><th>Confirmed</th><th>Carried in</th><th class="money">Book fee</th><th>Opened</th><th></th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="9" class="sub">No months yet.</td></tr>') + '</tbody></table></div></div>';
  }
  async function snapshotLocked(ym) {
    if (!Box || !Box.enabled || !Box.pullHistory) return false;
    await Box.pullHistory();
    const c = C.getCycle(ym); const asOf = String(c.lockedAt).slice(0, 10);
    const body = S.snapshotBook(C.bookRecords(ym), window.RATES_CATALOG);
    const cu = S.getCurrentUser() || {};
    S.putBookSnapshot(Object.assign({ id: asOf + ' · Confirmed ' + C.ymShort(ym), asOf, cycle: ym, label: 'Confirmed ' + C.ymShort(ym), source: 'confirmed',
      takenAt: new Date().toISOString(), takenBy: cu.name || cu.username || '' }, body));
    if (Box.flushHistory) await Box.flushHistory();
    return true;
  }
  function wireMonths(host) {
    const monthEl = $('#ad-month', host), dlEl = $('#ad-deadline', host), createBtn = $('#ad-create', host);
    if (monthEl) monthEl.addEventListener('input', () => { if (C.isYm(monthEl.value)) { createBtn.textContent = 'Open ' + C.ymLong(monthEl.value); dlEl.value = C.defaultDeadline(monthEl.value); } });
    if (createBtn) createBtn.addEventListener('click', () => {
      try {
        const c = C.createCycle({ cycle: monthEl.value, deadline: dlEl.value });
        toast(C.ymLong(c.cycle) + ' is open — confirm by ' + fmtDate(c.deadline) + '.', 'ok');
        if (Box && Box.flushConfirm) Box.flushConfirm().catch(() => {});
        announce(); render();
      } catch (e) { toast(e.message); }
    });
    host.querySelectorAll('button[data-savedl]').forEach(b => b.addEventListener('click', () => {
      const y = b.dataset.savedl; const inp = host.querySelector('input[data-dl="' + y + '"]');
      try { C.setDeadline(y, inp.value); toast('Deadline for ' + C.ymLong(y) + ' is now ' + fmtDate(inp.value) + '.', 'ok'); announce(); render(); } catch (e) { toast(e.message); }
    }));
    host.querySelectorAll('button[data-lock]').forEach(b => b.addEventListener('click', async () => {
      const y = b.dataset.lock; const recs = records(); const c = C.getCycle(y);
      const missing = C.expectedLeaders(recs).filter(id => !c.confirmations[id] && C.statusFor(c, id, recs).k !== 'none');
      const msg = 'Lock ' + C.ymLong(y) + '?\n\n' + (missing.length ? missing.length + ' have not confirmed: ' + missing.map(C.leaderName).join(', ') + '.\nTheir live projects will be carried in and flagged "not confirmed".' : 'Everyone expected has confirmed.') +
        '\n\nThe locked book becomes the default in Executive Reporting and a Revenue Diff snapshot is saved.';
      if (!window.confirm(msg)) return;
      let res;
      try { res = C.lockCycle(y); } catch (e) { toast(e.message); return; }
      toast(C.ymLong(y) + ' locked — ' + plural(res.carried.length, 'leader') + ' carried in.', 'ok');
      if (Box && Box.flushConfirm) Box.flushConfirm().catch(() => {});
      announce(); render();
      try { if (await snapshotLocked(y)) toast('Revenue Diff snapshot saved for ' + C.ymShort(y) + '.', 'info'); }
      catch (e) { toast('Locked, but the Revenue Diff snapshot could not be saved: ' + (e.message || e)); }
    }));
    host.querySelectorAll('button[data-reopen]').forEach(b => b.addEventListener('click', () => {
      const y = b.dataset.reopen;
      if (!window.confirm('Reopen ' + C.ymLong(y) + '? Leaders who have not confirmed can then confirm without a reason. Executive Reporting stops treating it as a locked book until it is locked again.')) return;
      try { C.reopenCycle(y); toast(C.ymLong(y) + ' reopened.', 'ok'); if (Box && Box.flushConfirm) Box.flushConfirm().catch(() => {}); announce(); render(); } catch (e) { toast(e.message); }
    }));
    host.querySelectorAll('button[data-dl-json]').forEach(b => b.addEventListener('click', () => {
      const y = b.dataset.dlJson; S.downloadJson('confirmed-' + y + '.json', JSON.stringify(C.getCycle(y), null, 2));
    }));
  }

  /* ================= render ================= */
  function render() {
    buildIdentityBar(); showTab();
    if (tab === 'book') { const h = $('#pane-book'); h.innerHTML = paneBook(); wireBook(h); }
    else if (tab === 'tracker') { const h = $('#pane-tracker'); h.innerHTML = paneTracker(); wireTracker(h); }
    else { const h = $('#pane-months'); h.innerHTML = paneMonths(); wireMonths(h); }
  }
  function start() {
    wireTabs(); render();
    document.addEventListener('ufc:remote-updated', render);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !Box || !Box.enabled || !Box.syncConfirmed) return;
      const at = C.listedAt();
      if (at && (Date.now() - new Date(at).getTime()) < 3 * 60 * 1000) return;
      Box.syncConfirmed().then(render).catch(() => {});
    });
    setInterval(() => { if (!document.hidden) render(); }, 5 * 60 * 1000);   // the countdown keeps time
  }
  if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(start, start); else start();
})();
