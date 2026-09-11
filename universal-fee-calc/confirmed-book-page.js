/* ============================================================
   MONTHLY CONFIRMED BOOK · page controller
   ------------------------------------------------------------
   Three tabs. My book: the signed-in leader's projects and the one
   CONFIRM button per open book. Tracker: every leader × the last
   books, green / yellow / red. Books: admins create a book (name,
   period month, confirm-by date), lock it, reopen it. The rules live
   in confirmed-book.js; this file only draws them and wires the buttons.
   ============================================================ */
(function () {
  'use strict';
  const S = window.UFC_Store, C = window.UFC_Confirm, Box = window.UFC_Box, UI = window.UFC_UI;
  const $ = (q, el) => (el || document).querySelector(q);
  const esc = UI.esc;
  const toast = UI.toast;
  const money = (n) => S.fmtMoney(n);
  const TAB_KEY = 'ufc_cb_tab_v1';
  const BOOKS_SHOWN = 6;
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
    if (C.isLeadership(cur)) { roleEl.textContent = 'Leadership · creates and locks books'; roleEl.className = 'id-role admin'; }
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
    if (tab === 'months' && !lead) tab = 'book';   // 'months' is the Books tab's id
    document.querySelectorAll('.cb-tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    ['book', 'tracker', 'months'].forEach(k => { $('#pane-' + k).hidden = k !== tab; });
  }

  /* ================= MY BOOK ================= */
  function paneBook() {
    const recs = records(); const open = C.openCycles(); const me = C.myLeaderId(); const lead = C.isLeadership();
    const w = C.widgetState();
    let html = '';
    if (w.kind === 'missed') html += missedBanner(w.cycle, me, recs);
    if (!open.length) {
      html += '<div class="empty"><b>No book is open for confirmation.</b><br>' + (lead ? 'Create one from the Books tab.' : 'An admin creates each book; the countdown appears on every page once one is open.') + '</div>';
    } else if (!me && !lead) {
      html += '<div class="empty">You are not in the revenue leaders directory, so there is nothing for you to confirm.</div>';
    }
    // Every open book, the one due first at the top. Usually one; can be more.
    open.sort((a, b) => String(a.deadline).localeCompare(String(b.deadline))).forEach(cur => {
      if (me) html += leaderBook(cur, me, recs);
      if (lead) {
        const orphans = C.bookFor(C.UNASSIGNED, recs).filter(C.isActiveRecord);
        if (orphans.length) html += leaderBook(cur, C.UNASSIGNED, recs);
      }
    });
    return html;
  }

  function missedBanner(cycle, me, recs) {
    const mine = C.bookFor(me, recs);
    return '<div class="banner red" id="missed">' +
      '<b>“' + esc(C.bookTitle(cycle)) + '” was locked on ' + esc(C.fmtDay(cycle.lockedAt)) + (cycle.lockedByName ? ' by ' + esc(cycle.lockedByName) : '') + ' without your confirmation.</b> ' +
      'Your ' + plural(mine.length, 'live project') + ' were carried into the confirmed book and flagged “not confirmed”. Confirm now with a short reason — an admin will review it.' +
      '<div class="reason"><textarea id="missed-reason" placeholder="Why the confirmation is late (a sentence is enough)"></textarea>' +
      '<div class="row"><button class="btn btn-primary" id="missed-confirm" data-ym="' + esc(cycle.id) + '" data-l="' + esc(me) + '">Confirm “' + esc(C.bookTitle(cycle)) + '” with this reason</button>' +
      '<span class="sub">Stamps ' + plural(mine.length, 'project') + ' with your name and the time, replacing the carried copies.</span></div></div></div>';
  }

  function leaderBook(cycle, leaderId, recs) {
    const ym = cycle.id, year = C.bookYear(cycle), title = C.bookTitle(cycle), period = C.periodLabel(cycle);
    const byId = byIdOf(recs);
    const mine = C.bookFor(leaderId, recs).sort((a, b) => ((a.project || {}).client || '').localeCompare((b.project || {}).client || '') || ((a.project || {}).name || '').localeCompare((b.project || {}).name || ''));
    const st = C.statusFor(cycle, leaderId, recs);
    const k = cycle.confirmations[leaderId];
    // Every reporting year, not just the book's: a leader confirms the whole
    // snapshot, and the reviewers read next year alongside this one.
    const years = S.getReportYears ? S.getReportYears() : [year];
    if (years.indexOf(year) < 0) years.unshift(year);
    const feeBy = {}; years.forEach(y => { feeBy[y] = C.feeInYear(mine, y); });
    const fee = feeBy[year];
    const shared = mine.filter(r => C.leadersOf(r, byId).length > 1).length;
    const d = C.daysUntil(cycle.deadline); const over = C.pastDeadline(cycle.deadline);
    const who = leaderId === C.UNASSIGNED ? 'the unassigned projects' : 'your book';
    const eyebrow = (period && period !== title ? period + ' · ' : '') + 'open · confirm by ' + fmtDate(cycle.deadline) + ' · ' +
      (over ? 'OVERDUE · ' + plural(-d, 'day') + ' late' : d === 0 ? 'due today' : plural(d, 'day') + ' left');
    const pillCls = st.k === 'overdue' ? 'rr' : st.tone;
    const pillTxt = { confirmed: 'Confirmed', changed: 'Confirmed · edited since', due: 'Not confirmed', overdue: 'Overdue', missed: 'Not confirmed', none: 'Nothing to confirm' }[st.k];
    let stamp, btn;
    if (k) {
      stamp = '<b>Confirmed ' + esc(C.fmtStamp(k.at)) + ' by ' + esc(k.name) + '.</b> Locked in to “' + esc(title) + '”.' +
        (st.k === 'changed' ? ' <b>' + plural(st.changed, 'project') + ' edited since</b> — noted on the tracker; the changes carry into the next book.' : ' One confirmation per book; changes from here carry into the next book.') +
        (k.afterLock ? '<div class="sub">Confirmed after the book was locked — reason: “' + esc(k.reason || '') + '”' + (k.reviewedAt ? ' · reviewed by ' + esc(k.reviewedBy) : ' · awaiting admin review') + '</div>' : '');
      btn = '<button class="btn btn-primary" disabled>Confirmed</button>';
    } else {
      stamp = (over ? '<b>The deadline was ' + esc(fmtDate(cycle.deadline)) + '. “' + esc(title) + '” is not confirmed.</b> ' : '<b>Not yet confirmed into “' + esc(title) + '”.</b> ') +
        'Confirming stamps ' + plural(mine.length, 'project') + ' with your name and the current time. One confirmation per book — check the list first.';
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
        years.map(y => '<td class="money">' + money(C.feeInYear([r], y)) + '</td>').join('') +
        '<td>' + esc(C.fmtStamp(r.updatedAt)) + '</td>' +
        '<td>' + (others.length ? esc(others.join(', ')) : '<span class="sub">—</span>') + '</td>' +
        '<td>' + inBook + '</td></tr>';
    }).join('');
    return '<div class="cb-head"><div><div class="eyebrow' + (over && !k ? ' late' : '') + '">' + esc(eyebrow) + '</div>' +
      '<h2>' + (k ? esc(title) + ' · confirmed' : 'Confirm ' + (leaderId === C.UNASSIGNED ? 'the unassigned projects' : 'your book') + ' into “' + esc(title) + '”') + '</h2>' +
      '<p>Every project ' + (leaderId === C.UNASSIGNED ? 'with no revenue leader' : 'you lead') + ', as it stands right now. Confirming copies these records into the confirmed book “' + esc(title) + '”.</p></div>' +
      '<div><span class="pill ' + pillCls + '"><i></i>' + esc(pillTxt) + '</span></div></div>' +
      '<div class="panel"><div class="kpis">' +
      '<div class="kpi"><div class="v">' + mine.length + '</div><div class="s">projects in ' + esc(who) + '</div></div>' +
      years.map(y => '<div class="kpi"><div class="v">' + money(feeBy[y]) + '</div><div class="s">' + y + ' fee</div></div>').join('') +
      '<div class="kpi"><div class="v">' + shared + '</div><div class="s">shared with another leader</div></div>' +
      '<div class="kpi"><div class="v small">' + (k ? esc(C.fmtStamp(k.at)) : '—') + '</div><div class="s">' + (k ? 'confirmed' : 'not confirmed yet') + '</div></div>' +
      '</div><div class="confirm' + (over && !k ? ' overdue' : '') + '"><div class="stamp">' + stamp + '</div>' + btn + '</div></div>' +
      '<div class="panel"><div class="ph"><h3>Projects in this confirmation</h3><span class="sub">' + plural(mine.length, 'project') + '</span></div>' +
      '<div class="tw"><table class="cb-table"><thead><tr><th>Client</th><th>Project</th><th>Rating</th>' + years.map(y => '<th class="money">' + y + ' fee</th>').join('') + '<th>Last edited</th><th>Shared with</th><th>In this book</th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="' + (6 + years.length) + '" class="sub">No projects.</td></tr>') + '</tbody></table></div></div>';
  }

  function wireBook(host) {
    host.querySelectorAll('button[data-ym][data-l]').forEach(b => b.addEventListener('click', () => {
      const ym = b.dataset.ym, l = b.dataset.l;
      const reasonEl = b.id === 'missed-confirm' ? $('#missed-reason', host) : null;
      const reason = reasonEl ? reasonEl.value : '';
      const n = C.bookFor(l, records()).length;
      const title = C.bookTitle(C.getCycle(ym));
      if (!window.confirm('Confirm ' + plural(n, 'project') + ' into “' + title + '”? This is your one confirmation for this book — it cannot be redone.')) return;
      try {
        C.confirm(ym, l, { reason });
        toast('“' + title + '” confirmed — ' + plural(n, 'project') + ' stamped.', 'ok');
        if (Box && Box.flushConfirm) Box.flushConfirm().catch(() => {});
        announce(); render();
      } catch (e) { toast(e.message || String(e)); }
    }));
  }

  /* ================= TRACKER ================= */
  /** The last few books, oldest first: what this browser holds sorted by
      creation, plus any Box knows about that are not loaded yet. */
  function trackerMonths() {
    const loaded = C.listCycles().map(c => c.id);
    const known = C.knownCycles().filter(id => loaded.indexOf(id) < 0);
    return known.concat(loaded).slice(-BOOKS_SHOWN);
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
    if (!yms.length) return '<div class="empty">No books have been created yet.</div>';
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
        '<div class="kpi"><div class="v">' + cnt(['confirmed']) + ' <span style="font-size:14px;color:#79828C">of ' + due.length + '</span></div><div class="s">confirmed and current · ' + esc(C.bookTitle(cur)) + '</div></div>' +
        '<div class="kpi"><div class="v">' + cnt(['changed']) + '</div><div class="s">confirmed, then edited</div></div>' +
        '<div class="kpi"><div class="v"' + (cnt(['overdue', 'missed']) ? ' style="color:var(--sav-red)"' : '') + '>' + cnt(['due', 'overdue', 'missed']) + '</div><div class="s">not confirmed' + (cnt(['overdue', 'missed']) ? ' · ' + cnt(['overdue', 'missed']) + ' overdue' : '') + '</div></div>' +
        '<div class="kpi"><div class="v"' + (over ? ' style="color:var(--sav-red)"' : '') + '>' + (cur.lockedAt ? 'Locked' : over ? 'Passed' : d) + '</div><div class="s">' + (cur.lockedAt ? 'locked ' + esc(C.fmtDay(cur.lockedAt)) : (over ? 'deadline was ' : 'days until ') + esc(fmtDate(cur.deadline))) + '</div></div></div>';
    }
    const head = '<tr><th>Revenue leader</th>' + yms.map((y, i) => '<th>' + esc(cycles[i] ? C.bookTitle(cycles[i]) : y) + '<span class="st">' +
      (!cycles[i] ? 'loading…' : (C.periodLabel(cycles[i]) && C.periodLabel(cycles[i]) !== C.bookTitle(cycles[i]) ? esc(C.periodLabel(cycles[i])) + ' · ' : '') +
        (cycles[i].lockedAt ? 'locked ' + esc(C.fmtDay(cycles[i].lockedAt)) : 'open · by ' + esc(C.fmtDay(cycles[i].deadline + 'T12:00:00')))) + '</span></th>').join('') + '</tr>';
    const body = leaders.map(id => '<tr' + (id === me ? ' class="me"' : '') + '><td>' + esc(C.leaderName(id)) + (id === me ? ' <span class="sub">(you)</span>' : '') + '</td>' +
      yms.map((y, i) => {
        const c = cycles[i];
        const s = c ? C.statusFor(c, id, recs) : { k: 'none', tone: 'n', text: '…' };
        const rr = s.bold;
        return '<td><button class="cell' + (rr ? ' rr' : '') + '" data-l="' + esc(id) + '" data-m="' + esc(y) + '" aria-label="' + esc(C.leaderName(id) + ' · ' + (c ? C.bookTitle(c) : y) + ': ' + s.text) + '"><span class="dot ' + s.tone + '"></span><span class="t">' + esc(s.text) + '</span></button></td>';
      }).join('') + '</tr>').join('');

    let reviews = '';
    if (lead) {
      const items = [];
      cycles.forEach(c => { if (!c) return; Object.keys(c.confirmations).forEach(id => { const k = c.confirmations[id]; if (k.afterLock) items.push({ c, id, k }); }); });
      if (items.length) reviews = '<div class="panel"><div class="ph"><h3>Late confirmations</h3><span class="sub">confirmed after the book was locked</span></div>' +
        '<div class="tw"><table class="cb-table"><thead><tr><th>Book</th><th>Leader</th><th>Confirmed</th><th>Reason</th><th>Review</th></tr></thead><tbody>' +
        items.map(x => '<tr><td>' + esc(C.bookTitle(x.c)) + '</td><td>' + esc(C.leaderName(x.id)) + '</td><td>' + esc(C.fmtStamp(x.k.at)) + '</td><td>' + esc(x.k.reason || '') + '</td>' +
          '<td>' + (x.k.reviewedAt ? '<span class="pill g"><i></i>Reviewed · ' + esc(x.k.reviewedBy) + '</span>' : '<button class="btn btn-ghost small" data-review="' + esc(x.c.id) + '" data-l="' + esc(x.id) + '">Mark reviewed</button>') + '</td></tr>').join('') +
        '</tbody></table></div></div>';
    }
    return '<div class="cb-head"><div><div class="eyebrow">All revenue leaders</div><h2>Who has confirmed, book by book</h2>' +
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
      if (!c) detail = 'Still loading that book.';
      else {
        const k = c.confirmations[id]; const s = C.statusFor(c, id, recs); const title = C.bookTitle(c);
        if (s.k === 'none') detail = '<b>' + esc(nm) + '</b> had no active projects when “' + esc(title) + '” was open, so nothing was expected.';
        else if (!k) detail = '<b>' + esc(nm) + '</b> has not confirmed “' + esc(title) + '”. ' + (c.lockedAt ? 'The book was locked on ' + esc(C.fmtDay(c.lockedAt)) + ' with their live projects carried in and flagged.' : 'Confirm by ' + esc(fmtDate(c.deadline)) + '.');
        else detail = '<b>' + esc(nm) + '</b> confirmed “' + esc(title) + '” on <b>' + esc(C.fmtStamp(k.at)) + '</b> · ' + plural(k.projects, 'project') + ' · ' + money(k.fee) + ' ' + C.bookYear(c) + ' fee' +
          (k.afterLock ? ' · <span class="pill y"><i></i>after lock</span>' : k.late ? ' · <span class="pill y"><i></i>after the deadline</span>' : '') +
          (s.k === 'changed' ? ' · <span class="pill y"><i></i>' + plural(s.changed, 'project') + ' edited since</span>' : '');
      }
      $('#tr-detail', host).innerHTML = detail;
    }));
    host.querySelectorAll('button[data-review]').forEach(b => b.addEventListener('click', () => {
      try { C.reviewLate(b.dataset.review, b.dataset.l); toast('Marked as reviewed.', 'ok'); render(); } catch (e) { toast(e.message); }
    }));
  }

  /* ================= BOOKS (admin) ================= */
  function paneMonths() {
    const recs = records(); const cycles = C.listCycles().slice().reverse();
    const years = S.getReportYears();
    const today = new Date().toISOString().slice(0, 7);
    const last = cycles.length ? cycles[0] : null;
    const nextYm = last && C.isYm(last.period) && last.period >= today ? C.nextYm(last.period) : today;
    const rows = cycles.map(c => {
      const y = c.id; const year = C.bookYear(c);
      const exp = C.expectedLeaders(recs).filter(id => C.statusFor(c, id, recs).k !== 'none');
      const done = exp.filter(id => c.confirmations[id]).length;
      const copies = Object.values(c.projects);
      const carriedN = copies.filter(p => p._carried).length;
      const fee = C.feeInYear(copies, year);
      const state = c.lockedAt ? '<span class="pill n"><i></i>Locked ' + esc(C.fmtDay(c.lockedAt)) + '</span>' : (C.pastDeadline(c.deadline) ? '<span class="pill rr"><i></i>Open · past deadline</span>' : '<span class="pill g"><i></i>Open</span>');
      const dl = c.lockedAt ? esc(fmtDate(c.deadline)) : '<input type="date" value="' + esc(c.deadline) + '" data-dl="' + esc(y) + '" aria-label="Confirm-by date"> <button class="btn btn-ghost small" data-savedl="' + esc(y) + '">Save</button>';
      const nameCell = '<input type="text" value="' + esc(c.name || '') + '" data-name="' + esc(y) + '" placeholder="' + esc(C.bookTitle(c)) + '" aria-label="Book name" style="font:inherit;font-weight:700;font-size:13px;padding:4px 6px;border:1px solid rgba(37,39,58,.25);width:210px"> <button class="btn btn-ghost small" data-savename="' + esc(y) + '">Save</button>' +
        '<div class="mono" style="margin-top:4px">confirmed-' + esc(y) + '.json</div>';
      const periodCell = '<input type="month" value="' + esc(c.period || '') + '" data-period="' + esc(y) + '" aria-label="Period month" style="font:inherit;font-size:12px;padding:4px 6px;border:1px solid rgba(37,39,58,.25)"> <button class="btn btn-ghost small" data-saveperiod="' + esc(y) + '">Save</button>';
      const act = c.lockedAt
        ? '<button class="btn btn-ghost small" data-reopen="' + esc(y) + '">Reopen</button> '
        : '<button class="btn small btn-secondary" data-lock="' + esc(y) + '">Lock book</button> ' +
          (Object.keys(c.confirmations || {}).length ? '' : '<button class="btn btn-ghost small" data-delete="' + esc(y) + '" title="Nobody has confirmed into this book yet — it can be deleted outright">Delete</button> ');
      return '<tr><td>' + nameCell + '</td><td>' + periodCell + '</td><td>' + state + '</td><td>' + dl + '</td>' +
        '<td>' + done + ' of ' + exp.length + '</td><td>' + (c.lockedAt ? (c.carried || []).length + (carriedN ? ' · ' + plural(carriedN, 'project') : '') : '—') + '</td>' +
        '<td class="money">' + (copies.length ? money(fee) : '—') + '</td><td>' + esc(C.fmtDay(c.openedAt)) + (c.openedByName ? '<div class="sub">' + esc(c.openedByName) + '</div>' : '') + '</td>' +
        '<td style="white-space:nowrap">' + act + '<button class="btn btn-ghost small" data-dl-xlsx="' + esc(y) + '" title="Revenue Projections format for ' + esc(years.join(' and ')) + ', plus a pivotable data sheet">Excel</button> <button class="btn btn-ghost small" data-dl-json="' + esc(y) + '">JSON</button></td></tr>';
    }).join('');
    return '<div class="cb-head"><div><div class="eyebrow">Leadership admins</div><h2>Create a book, set its deadline, lock it</h2>' +
      '<p>A book is one named confirmation round — “Revenue Projections #12” — with a period month as its label and a confirm-by date. Creating it writes a new file in the shared Box folder; nothing lands in it until a leader confirms. Locking freezes it, carries in anyone who never confirmed (flagged), and makes it the book Executive Reporting reads. Any number of books can share a month.</p></div></div>' +
      '<div class="panel"><div class="ph"><h3>Create a confirmed book</h3></div><div class="pb"><div class="form">' +
      '<div class="field"><label for="ad-name">Name</label><input id="ad-name" type="text" placeholder="Revenue Projections #12" maxlength="80"><div class="hint">What everyone will see — on the tracker, the countdown and the exports</div></div>' +
      '<div class="field"><label for="ad-month">Period</label><input id="ad-month" type="month" value="' + esc(nextYm) + '"><div class="hint">The month this book is for — a label, nothing more</div></div>' +
      '<div class="field"><label for="ad-deadline">Confirm by</label><input id="ad-deadline" type="date" value="' + esc(C.defaultDeadline(nextYm)) + '"><div class="hint">Counted down on every page; bold red once it passes</div></div>' +
      '<div class="field"><button class="btn btn-primary" id="ad-create">Create book</button></div>' +
      '</div><p class="sub" style="margin:14px 0 0">Everyone with at least one active project is expected, even if nothing changed. Leaders with no projects show grey, never red. On lock, a Revenue Diff snapshot of the confirmed book is saved so any two books can be compared.</p></div></div>' +
      reportYearsPanel(years) +
      '<div class="panel"><div class="ph"><h3>Books</h3><span class="sub">newest first · one file each, in the same Box folder as projects.json</span></div>' +
      '<div class="tw"><table class="cb-table"><thead><tr><th>Name</th><th>Period</th><th>State</th><th>Confirm by</th><th>Confirmed</th><th>Carried in</th><th class="money">Book fee</th><th>Created</th><th></th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="9" class="sub">No books yet.</td></tr>') + '</tbody></table></div></div>';
  }
  /* The calendar years every report and export covers. Moved forward by a
     leadership admin as the year turns; synced to everyone through the book. */
  function reportYearsPanel(years) {
    const now = new Date().getFullYear(); const set = S.getReportYearsSetting();
    const opts = (sel) => { let h = ''; for (let y = now - 2; y <= now + 5; y++) h += '<option value="' + y + '"' + (y === sel ? ' selected' : '') + '>' + y + '</option>'; return h; };
    return '<div class="panel"><div class="ph"><h3>Reporting years</h3><span class="sub">' +
      (set ? 'set ' + esc(C.fmtDay(set.setAt)) + (set.setBy ? ' by ' + esc(S.displayNameForLogin ? S.displayNameForLogin(set.setBy) : set.setBy) : '') : 'default · this year and next') + '</span></div>' +
      '<div class="pb"><div class="form">' +
      '<div class="field"><label for="ry-from">First year</label><select id="ry-from">' + opts(years[0]) + '</select></div>' +
      '<div class="field"><label for="ry-to">Last year</label><select id="ry-to">' + opts(years[years.length - 1]) + '</select></div>' +
      '<div class="field"><button class="btn btn-secondary" id="ry-save">Save reporting years</button></div>' +
      '</div><p class="sub" style="margin:14px 0 0">The Excel download of a confirmed book covers these years in full — every month of ' + esc(years.join(' and ')) + ' — and so will other reports as they adopt the setting. Come November, move it forward a year.</p></div></div>';
  }
  async function exportBookExcel(ym) {
    const X = window.UFC_ProjectionsXlsx;
    if (!window.UFC_Vendor || !X) { toast('The Excel writer is not loaded on this page.'); return; }
    await window.UFC_Vendor.excel();
    if (typeof ExcelJS === 'undefined') { toast('Excel library not loaded.'); return; }
    const c = C.getCycle(ym); if (!c) { toast('That book is not loaded.'); return; }
    const title = C.bookTitle(c), period = C.periodLabel(c);
    const years = S.getReportYears();
    const rows = X.bookRows(C.bookRecords(ym), C.changeOrderIndex(ym), window.RATES_CATALOG);
    if (!rows.length) { toast('Nothing in “' + title + '” yet — no one has confirmed.'); return; }
    const V = X.viewFor(rows, years);
    const sum = C.cycleSummary(ym);
    const state = c.lockedAt ? 'locked ' + C.fmtStamp(c.lockedAt) + (c.lockedByName ? ' by ' + c.lockedByName : '') : 'still open · ' + sum.confirmed + ' confirmed so far';
    const wb = new ExcelJS.Workbook(); wb.creator = 'Savills PPM';
    X.writeProjectionsSheet(wb, V, {
      title: 'Revenue Projections · ' + title + ' (confirmed book)',
      subtitle: V.rows.length + ' projects · ' + (period && period !== title ? 'period ' + period + ' · ' : '') + years.join(' and ') + ' · ' + state + (sum.carried.length ? ' · ' + sum.carried.length + ' leader' + (sum.carried.length === 1 ? '' : 's') + ' carried in unconfirmed' : ''),
    });
    const data = X.writeDataSheet(wb, V, {
      extraHeaders: ['Confirmed by', 'Confirmed at', 'Carried in (not confirmed)'],
      extra: (row) => [row.p._carried ? '' : C.leaderName(row.p._confirmedBy), row.p._confirmedAt ? C.fmtStamp(row.p._confirmedAt) : '', row.p._carried ? 'Yes' : ''],
    });
    X.writeDashboardSheet(wb, V, { title: title + ' · dashboard', dataRows: data.__lastRow });
    // About: the cycle and who confirmed when.
    const ab = wb.addWorksheet('About');
    ab.getColumn(1).width = 26; ab.getColumn(2).width = 22; ab.getColumn(3).width = 12; ab.getColumn(4).width = 16; ab.getColumn(5).width = 16; ab.getColumn(6).width = 40;
    const put = (r, a, b) => { ab.getCell(r, 1).value = a; ab.getCell(r, 1).font = { name: 'Calibri', bold: true }; ab.getCell(r, 2).value = b; };
    put(1, 'Book', title); put(2, 'State', state); put(3, 'Confirm by', c.deadline + (period ? ' · period ' + period : ''));
    put(4, 'Opened', C.fmtStamp(c.openedAt) + (c.openedByName ? ' by ' + c.openedByName : '')); put(5, 'Reporting years', years.join(', '));
    put(6, 'Projects in the book', Object.keys(c.projects).length); put(7, 'Carried in unconfirmed', sum.carried.map(C.leaderName).join(', ') || 'none');
    put(8, 'Exported', new Date().toLocaleString());
    const hr = 10;
    ['Revenue leader', 'Confirmed at', 'Projects', 'Fee (' + C.bookYear(c) + ')', 'Timing', 'Reason'].forEach((h, i) => { const cell = ab.getCell(hr, i + 1); cell.value = h; cell.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF25273A' } }; });
    let r = hr + 1;
    Object.keys(c.confirmations).sort((a, b) => C.leaderName(a).localeCompare(C.leaderName(b))).forEach(id => {
      const k = c.confirmations[id];
      ab.getCell(r, 1).value = C.leaderName(id); ab.getCell(r, 2).value = C.fmtStamp(k.at); ab.getCell(r, 3).value = k.projects;
      ab.getCell(r, 4).value = k.fee; ab.getCell(r, 4).numFmt = '#,##0';
      ab.getCell(r, 5).value = k.afterLock ? 'After lock' : k.late ? 'After deadline' : 'On time'; ab.getCell(r, 6).value = k.reason || '';
      r++;
    });
    sum.carried.forEach(id => { ab.getCell(r, 1).value = C.leaderName(id); ab.getCell(r, 5).value = 'Not confirmed · carried in'; r++; });
    await X.download(wb, 'Confirmed Book · ' + title.replace(/[\\/:*?"<>|]+/g, '-') + '.xlsx');
  }
  async function snapshotLocked(ym) {
    if (!Box || !Box.enabled || !Box.pullHistory) return false;
    await Box.pullHistory();
    const c = C.getCycle(ym); const asOf = String(c.lockedAt).slice(0, 10); const title = C.bookTitle(c);
    const body = S.snapshotBook(C.bookRecords(ym), window.RATES_CATALOG);
    const cu = S.getCurrentUser() || {};
    S.putBookSnapshot(Object.assign({ id: asOf + ' · ' + title, asOf, cycle: c.period || asOf.slice(0, 7), label: title, source: 'confirmed',
      takenAt: new Date().toISOString(), takenBy: cu.name || cu.username || '' }, body));
    if (Box.flushHistory) await Box.flushHistory();
    return true;
  }
  function wireMonths(host) {
    const monthEl = $('#ad-month', host), dlEl = $('#ad-deadline', host), createBtn = $('#ad-create', host), nameEl = $('#ad-name', host);
    if (monthEl) monthEl.addEventListener('input', () => { if (C.isYm(monthEl.value)) dlEl.value = C.defaultDeadline(monthEl.value); });
    if (createBtn) createBtn.addEventListener('click', () => {
      try {
        const c = C.createCycle({ name: nameEl.value, period: monthEl.value, deadline: dlEl.value });
        toast('“' + C.bookTitle(c) + '” is open — confirm by ' + fmtDate(c.deadline) + '.', 'ok');
        if (Box && Box.flushConfirm) Box.flushConfirm().catch(() => {});
        announce(); render();
      } catch (e) { toast(e.message); }
    });
    const flush = () => { if (Box && Box.flushConfirm) Box.flushConfirm().catch(() => {}); };
    host.querySelectorAll('button[data-savedl]').forEach(b => b.addEventListener('click', () => {
      const y = b.dataset.savedl; const inp = host.querySelector('input[data-dl="' + y + '"]');
      try { const c = C.setDeadline(y, inp.value); toast('“' + C.bookTitle(c) + '” is now due ' + fmtDate(inp.value) + '.', 'ok'); flush(); announce(); render(); } catch (e) { toast(e.message); }
    }));
    host.querySelectorAll('button[data-savename]').forEach(b => b.addEventListener('click', () => {
      const y = b.dataset.savename; const inp = host.querySelector('input[data-name="' + y + '"]');
      try { const c = C.setName(y, inp.value); toast('Renamed to “' + C.bookTitle(c) + '”.', 'ok'); flush(); announce(); render(); } catch (e) { toast(e.message); }
    }));
    host.querySelectorAll('button[data-saveperiod]').forEach(b => b.addEventListener('click', () => {
      const y = b.dataset.saveperiod; const inp = host.querySelector('input[data-period="' + y + '"]');
      try { const c = C.setPeriod(y, inp.value); toast('“' + C.bookTitle(c) + '” is now labelled ' + C.periodLabel(c) + '.', 'ok'); flush(); announce(); render(); } catch (e) { toast(e.message); }
    }));
    host.querySelectorAll('button[data-lock]').forEach(b => b.addEventListener('click', async () => {
      const y = b.dataset.lock; const recs = records(); const c = C.getCycle(y);
      const missing = C.expectedLeaders(recs).filter(id => !c.confirmations[id] && C.statusFor(c, id, recs).k !== 'none');
      const msg = 'Lock “' + C.bookTitle(c) + '”?\n\n' + (missing.length ? missing.length + ' have not confirmed: ' + missing.map(C.leaderName).join(', ') + '.\nTheir live projects will be carried in and flagged "not confirmed".' : 'Everyone expected has confirmed.') +
        '\n\nThe locked book becomes the default in Executive Reporting and a Revenue Diff snapshot is saved.';
      if (!window.confirm(msg)) return;
      let res;
      try { res = C.lockCycle(y); } catch (e) { toast(e.message); return; }
      toast('“' + C.bookTitle(c) + '” locked — ' + plural(res.carried.length, 'leader') + ' carried in.', 'ok');
      if (Box && Box.flushConfirm) Box.flushConfirm().catch(() => {});
      announce(); render();
      try { if (await snapshotLocked(y)) toast('Revenue Diff snapshot saved for “' + C.bookTitle(c) + '”.', 'info'); }
      catch (e) { toast('Locked, but the Revenue Diff snapshot could not be saved: ' + (e.message || e)); }
    }));
    host.querySelectorAll('button[data-reopen]').forEach(b => b.addEventListener('click', () => {
      const y = b.dataset.reopen; const title = C.bookTitle(C.getCycle(y));
      if (!window.confirm('Reopen “' + title + '”? Leaders who have not confirmed can then confirm without a reason. Executive Reporting stops treating it as a locked book until it is locked again.')) return;
      try { C.reopenCycle(y); toast('“' + title + '” reopened.', 'ok'); if (Box && Box.flushConfirm) Box.flushConfirm().catch(() => {}); announce(); render(); } catch (e) { toast(e.message); }
    }));
    host.querySelectorAll('button[data-delete]').forEach(b => b.addEventListener('click', async () => {
      const y = b.dataset.delete; const title = C.bookTitle(C.getCycle(y));
      if (!window.confirm('Delete “' + title + '”? Nobody has confirmed into it. The file is removed from Box and the countdown stops for everyone within a few minutes.')) return;
      let name;
      try { name = C.deleteCycle(y); } catch (e) { toast(e.message); return; }
      try { if (Box && Box.enabled && Box.deleteConfirmCycle) await Box.deleteConfirmCycle(y); }
      catch (e) { toast('Removed here, but the Box file could not be deleted: ' + (e.message || e)); announce(); render(); return; }
      toast('“' + name + '” deleted.', 'ok'); announce(); render();
    }));
    host.querySelectorAll('button[data-dl-xlsx]').forEach(b => b.addEventListener('click', () => {
      exportBookExcel(b.dataset.dlXlsx).catch(e => toast('Excel export failed: ' + (e.message || e)));
    }));
    const rySave = $('#ry-save', host);
    if (rySave) rySave.addEventListener('click', () => {
      try { const ys = S.setReportYears($('#ry-from', host).value, $('#ry-to', host).value); toast('Reporting years: ' + ys.join(', ') + '.', 'ok'); render(); }
      catch (e) { toast(e.message); }
    });
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
