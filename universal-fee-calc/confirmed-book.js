/* ============================================================
   SAVILLS PPM · MONTHLY CONFIRMED BOOK
   ------------------------------------------------------------
   A leadership admin creates a BOOK — "Revenue Projections #12" —
   with a period month as its label and a confirm-by date. Every
   revenue leader then confirms their projects into it. Each
   confirmation copies each project they lead into the book's file —
   confirmed-<book id>.json in the shared Box folder — with their name
   and a timestamp on every copy. That file is the confirmed book:
   what Executive Reporting reads by default, and what the next one
   is compared against. Books are not tied to months: three books in
   one month are three files. (Books created before names existed
   are keyed by their month and show the month as their name.)

   Rules, as agreed with the revenue leaders:
     • One confirmation per leader per book. It is locked in. If a
       project changes afterwards the tracker says so (yellow), but
       the change waits for the next book.
     • Confirm covers every project the person leads, shared ones
       included. One copy per project; the most recent confirmation
       supplies it. A shared project is fully confirmed only once
       every leader on it has confirmed.
     • Everyone with at least one active project is expected, even
       when nothing changed since the last book.
     • Past the deadline without confirming: red, bold, everywhere.
     • When an admin LOCKS the book, leaders who never confirmed
       have their live projects carried in, flagged "not confirmed".
       They can still confirm afterwards — with a reason, which an
       admin reviews.

   Local cache: savills-ppm-confirmed-db:v1. Same shape of sync as
   the activity trail — a dirty list survives a reload, the Box
   adapter merges before every upload, and the merge is keyed so two
   people confirming at once cannot clobber each other.
   ============================================================ */
(function () {
  'use strict';
  const S = () => window.UFC_Store;
  const KEY = 'savills-ppm-confirmed-db:v1';
  const UNASSIGNED = 'unassigned';

  /* ---------- local store ---------- */
  let _remote = null;
  function attachRemote(fn) { _remote = typeof fn === 'function' ? fn : null; }
  const defaultDb = () => ({ schemaVersion: 1, cycles: {}, dirty: [], listedAt: null, known: [] });
  /* PARSED CACHE. A book with everyone's copies in it is about a megabyte, and
     the tracker asked for it (getCycle, listCycles, currentCycle, knownCycles)
     a dozen times per draw — a dozen full parses. The cache is keyed on the raw
     string, as the project store's is: comparing the text is far cheaper than
     parsing it, and it stays right when another tab or the test harness writes
     the key behind our back. Callers mutate the object and writeDb() it; that
     is the contract, so the cached object itself is handed out. */
  let _cache = null, _raw = null, _memOnly = false;
  function readDb() {
    if (_memOnly && _cache) return _cache;           // storage is full: memory is the truth, see writeDb
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) { _cache = null; _raw = null; return defaultDb(); }
      if (_cache && raw === _raw) return _cache;
      const p = JSON.parse(raw);
      if (!p || typeof p !== 'object' || !p.cycles) return defaultDb();
      if (!Array.isArray(p.dirty)) p.dirty = [];
      if (!Array.isArray(p.known)) p.known = [];
      Object.keys(p.cycles).forEach(k => normalize(p.cycles[k], k));
      _cache = p; _raw = raw;
      return p;
    } catch (e) { return defaultDb(); }
  }
  /** Every book carries id, name and period, whichever version wrote it.
      A book from before names existed is keyed by its month: the month
      becomes its period and, failing a name, its title. */
  function normalize(c, key) {
    if (!c) return c;
    if (!c.id) c.id = c.cycle || key;
    if (!c.cycle) c.cycle = c.id;
    if (!c.period) c.period = isYm(c.cycle) ? c.cycle : (isYm(String(c.deadline || '').slice(0, 7)) ? String(c.deadline).slice(0, 7) : '');
    if (c.name == null) c.name = '';
    if (!c.acknowledgements || typeof c.acknowledgements !== 'object') c.acknowledgements = {};
    return c;
  }
  const trySet = (raw) => { try { localStorage.setItem(KEY, raw); return true; } catch (e) { return false; } };
  function writeDb(db, opts) {
    db.schemaVersion = 1;
    let raw = JSON.stringify(db);
    let ok = trySet(raw);
    if (!ok) {
      /* Out of storage: shed the oldest LOCKED cycle (safe in Box) and retry. */
      const yms = Object.keys(db.cycles).filter(k => db.cycles[k].lockedAt && db.dirty.indexOf(k) < 0).sort();
      if (yms.length) { delete db.cycles[yms[0]]; raw = JSON.stringify(db); ok = trySet(raw); }
    }
    if (ok) {
      _cache = db; _raw = raw;
      if (_memOnly) { _memOnly = false; try { document.dispatchEvent(new CustomEvent('ufc:sync', { detail: { state: 'synced', message: '', at: Date.now() } })); } catch (e) {} }
    } else {
      /* The write failed and nothing could be shed. This used to return here —
         BEFORE the push — so a leader's confirmation showed a green toast, was
         never written anywhere, and had vanished on the next draw. Now memory
         holds the book for the rest of this page (readDb serves it), the push
         to Box still goes out, and the sync pill says why. */
      _cache = db; _raw = null; _memOnly = true;
      console.warn('confirmed-book: local cache write failed (storage full?) — holding the book in memory and pushing to Box');
      try { document.dispatchEvent(new CustomEvent('ufc:sync', { detail: { state: 'error', at: Date.now(),
        message: 'Browser storage is full — the confirmed book is held in memory on this page and still saves to Box. Clear old site data or contact the maintainer.' } })); } catch (e) {}
    }
    if (!(opts && opts.quiet) && _remote) { try { _remote(db.dirty.slice()); } catch (e) { console.warn('confirmed-book push failed', e); } }
    return db;
  }
  /** Test hook: forget the cache and the storage-full state. */
  function _resetCache() { _cache = null; _raw = null; _memOnly = false; }
  function markDirty(db, ym) { if (db.dirty.indexOf(ym) < 0) db.dirty.push(ym); }
  function dirtyCycles() { return readDb().dirty.slice(); }
  function markCycleClean(ym) {
    const db = readDb(); const i = db.dirty.indexOf(ym);
    if (i >= 0) { db.dirty.splice(i, 1); writeDb(db, { quiet: true }); }
  }
  /** Months Box holds, from the last folder listing (ids live in the adapter). */
  function rememberKnown(yms, at) {
    const db = readDb();
    db.known = [...new Set([...(yms || []), ...Object.keys(db.cycles)])].sort();
    db.listedAt = at || new Date().toISOString();
    writeDb(db, { quiet: true });
  }
  const knownCycles = () => { const db = readDb(); return [...new Set([...db.known, ...Object.keys(db.cycles)])].sort(); };
  const listedAt = () => readDb().listedAt;

  /* ---------- time helpers ---------- */
  const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const isYm = (s) => /^\d{4}-\d{2}$/.test(String(s || ''));
  const ymShort = (ym) => isYm(ym) ? MN[+ym.slice(5, 7) - 1] + '-' + ym.slice(2, 4) : String(ym || '');
  const ymLong = (ym) => isYm(ym) ? LONG[+ym.slice(5, 7) - 1] + ' ' + ym.slice(0, 4) : String(ym || '');
  const monthName = (ym) => isYm(ym) ? LONG[+ym.slice(5, 7) - 1] : String(ym || '');
  /** The deadline runs to the end of that day, local time. */
  const deadlineEnd = (deadline) => { const d = new Date(String(deadline) + 'T23:59:59'); return isNaN(d) ? null : d; };
  /** Whole days from now to the end of the deadline day (negative = late). */
  function daysUntil(deadline, now) {
    const end = deadlineEnd(deadline); if (!end) return null;
    const t = now ? new Date(now) : new Date();
    const dayStart = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    const dlStart = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    return Math.round((dlStart - dayStart) / 86400000);
  }
  const pastDeadline = (deadline, now) => { const end = deadlineEnd(deadline); return !!end && (now ? new Date(now) : new Date()) > end; };
  /** Default deadline for a month: the 15th. */
  const defaultDeadline = (ym) => isYm(ym) ? ym + '-15' : '';
  const nextYm = (ym) => { const y = +ym.slice(0, 4), m = +ym.slice(5, 7); return m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0'); };
  /** What a book is called: its name, else its period month, else its id. */
  const bookTitle = (c) => c ? (c.name || (isYm(c.period) ? ymLong(c.period) : String(c.id || c.cycle || ''))) : '';
  const periodLabel = (c) => c && isYm(c.period) ? ymLong(c.period) : '';
  /** The calendar year a book's fee figures are quoted in. */
  const bookYear = (c) => { const p = c && (c.period || String(c.deadline || '').slice(0, 7)); return isYm(p) ? +p.slice(0, 4) : new Date().getFullYear(); };
  const cleanName = (v) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const slug = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'book';

  /* ---------- who leads what ---------- */
  /** Revenue-leader ids on a record: lead PE and client relationship owner,
      resolved through the directory. A change order with none of its own
      inherits its parent's. */
  function leadersOf(rec, byId) {
    const st = S(); const pj = (rec && rec.project) || {};
    const ids = [];
    [pj.leadId || pj.lead, pj.clientRelOwner].forEach(v => {
      if (!v) return;
      const l = st.resolveLeader(v);
      if (l && ids.indexOf(l.id) < 0) ids.push(l.id);
    });
    if (!ids.length && st.isChangeOrder && st.isChangeOrder(rec) && byId) {
      const parent = byId[rec.changeOrder && rec.changeOrder.parentId];
      if (parent) return leadersOf(parent, null);
    }
    return ids;
  }
  const indexById = (records) => { const m = {}; (records || []).forEach(r => { if (r && r.id) m[r.id] = r; }); return m; };
  /* Who leads each record, worked out once per records array. The tracker
     asks statusFor() for every leader × every book, and each asked bookFor()
     to resolve the leaders of all 300 records again — 62,000 directory
     lookups per draw. Keyed on the array itself (a WeakMap), so a page that
     passes the same list through one draw pays once and nothing is ever
     stale across draws. */
  const _leadMemo = new WeakMap();
  function leadersIndex(records) {
    const list = records || [];
    let m = _leadMemo.get(list);
    if (m) return m;
    const byId = indexById(list); const leaders = new Map();
    list.forEach(r => { if (r) leaders.set(r, leadersOf(r, byId)); });
    m = { byId, leaders };
    _leadMemo.set(list, m);
    return m;
  }
  /** A record still in play: not lost or closed out, not a placeholder. */
  function isActiveRecord(rec) {
    const st = S(); const pj = (rec && rec.project) || {};
    if (!rec || rec._deleted) return false;
    if (st.ENDED_STATUSES && st.ENDED_STATUSES.has(pj.status)) return false;
    if (st.isPlaceholder && st.isPlaceholder(rec)) return false;
    return true;
  }
  /** Everything a leader confirms: every live record they lead, whatever its
      status — the confirmed book must be as complete as the live one. */
  function bookFor(leaderId, records) {
    const list = records || S().listProjects();
    const idx = leadersIndex(list);
    return list.filter(r => {
      if (!r || r._deleted) return false;
      const ls = idx.leaders.get(r) || [];
      return leaderId === UNASSIGNED ? ls.length === 0 : ls.indexOf(leaderId) >= 0;
    });
  }
  /** Who is expected this month: every leader with at least one active
      record, plus "unassigned" when active records have no leader at all. */
  function expectedLeaders(records) {
    const list = records || S().listProjects();
    const idx = leadersIndex(list);
    const set = new Set(); let orphans = false;
    list.forEach(r => {
      if (!isActiveRecord(r)) return;
      const ls = idx.leaders.get(r) || [];
      if (!ls.length) orphans = true;
      ls.forEach(id => set.add(id));
    });
    const out = [...set].sort((a, b) => leaderName(a).localeCompare(leaderName(b)));
    if (orphans) out.push(UNASSIGNED);
    return out;
  }
  function leaderName(id) {
    if (id === UNASSIGNED) return 'Unassigned projects';
    const st = S(); const l = st.leaderById ? st.leaderById(id) : null;
    return l ? l.displayName : String(id || '');
  }
  /** The leader id the signed-in person confirms as, or null. */
  function myLeaderId(user) {
    const st = S(); const u = user || st.getCurrentUser();
    const l = st.resolveLeader(u.username) || st.resolveLeader(u.name);
    return l ? l.id : null;
  }
  /** Fee in the cycle's year, from the same series Revenue Projections draws. */
  function feeInYear(records, year) {
    const st = S(); const cat = window.RATES_CATALOG; let t = 0;
    (records || []).forEach(r => {
      try { ((st.revenueSeries || st.billingSeries)(r, cat) || []).forEach(s => { if (s.year === year) t += (s.invoice || 0); }); } catch (e) { /* unpriced */ }
    });
    return Math.round(t);
  }

  /* ---------- cycles ---------- */
  const getCycle = (id) => readDb().cycles[String(id)] || null;
  /** Every book this browser holds, oldest first (by when it was created). */
  function listCycles() {
    const c = readDb().cycles;
    return Object.keys(c).map(k => c[k]).sort((a, b) => String(a.openedAt || '').localeCompare(String(b.openedAt || '')) || String(a.id).localeCompare(String(b.id)));
  }
  /** The book everyone is confirming now: the open one due first. */
  function currentCycle() {
    const open = listCycles().filter(c => !c.lockedAt);
    return open.sort((a, b) => String(a.deadline || '').localeCompare(String(b.deadline || '')) || String(a.openedAt || '').localeCompare(String(b.openedAt || '')))[0] || null;
  }
  const openCycles = () => listCycles().filter(c => !c.lockedAt);
  /** The most recently locked book — Executive Reporting's default. */
  function latestLocked() {
    const l = listCycles().filter(c => c.lockedAt).sort((a, b) => String(a.lockedAt).localeCompare(String(b.lockedAt)));
    return l.length ? l[l.length - 1] : null;
  }
  /** The book that closed this one for confirmations: once a newer book has
      opened after the lock, the old one can only be acknowledged, not
      confirmed late. Null while nothing newer is open. */
  function supersededBy(c) {
    if (!c || !c.lockedAt) return null;
    const later = listCycles().filter(o => o.id !== c.id && String(o.openedAt || '') > String(c.lockedAt || ''))
      .sort((a, b) => String(a.openedAt || '').localeCompare(String(b.openedAt || '')));
    return later[0] || null;
  }
  const isLeadership = (user) => { const st = S(); return !!(st.seesAllProjects && st.seesAllProjects(user || st.getCurrentUser())); };
  const actorStamp = () => { const u = S().getCurrentUser() || {}; return { by: u.username || '', name: u.name || u.username || '' }; };

  /** Create a book: a name, a period month (its label), a confirm-by date.
      The id is date + name, so files sort by when they were created and
      read like "confirmed-2026-09-10-revenue-projections-12.json". */
  function createCycle(opts) {
    const st = S(); const o = opts || {};
    if (!isLeadership()) throw new Error('Only a leadership admin can create a book.');
    const name = cleanName(o.name);
    if (name.length < 2) throw new Error('Give the book a name — “Revenue Projections #12”, for example.');
    const period = String(o.period || o.cycle || '').trim();
    if (period && !isYm(period)) throw new Error('The period should be a month.');
    const deadline = String(o.deadline || defaultDeadline(period || new Date().toISOString().slice(0, 7))).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || !deadlineEnd(deadline)) throw new Error('Pick a confirm-by date.');
    const db = readDb();
    const now = o.now || new Date().toISOString(); const a = actorStamp();
    let id = now.slice(0, 10) + '-' + slug(name), n = 2;
    while (db.cycles[id] || db.known.indexOf(id) >= 0) { id = now.slice(0, 10) + '-' + slug(name) + '-' + (n++); }
    db.cycles[id] = {
      schemaVersion: 2, id, cycle: id, name, period: period || deadline.slice(0, 7), deadline,
      openedAt: now, openedBy: a.by, openedByName: a.name,
      lockedAt: null, lockedBy: '', lockedByName: '', reopenedAt: null,
      metaUpdatedAt: now, updatedAt: now,
      confirmations: {}, acknowledgements: {}, projects: {}, carried: [],
    };
    markDirty(db, id);
    writeDb(db);
    st.logSystem('cycle-open', { cycle: id, name, period: db.cycles[id].period, deadline });
    {
      const c = db.cycles[id]; const title = bookTitle(c); const due = fmtDay(deadline + 'T12:00:00');
      const to = expectedLeaders(o.records || st.listProjects()).filter(x => x !== UNASSIGNED).map(leaderEmail).filter(Boolean);
      sendNotice({ event: 'book-opened', at: now, to, cc: adminEmails(), data: { cycle: id, deadline },
        subject: '“' + title + '” is open — confirm your book by ' + due,
        text: a.name + ' opened “' + title + '”. Confirm every project you lead by ' + due + ' in the Monthly Confirmed Book.',
        html: noticeHtml('“' + title + '” is open', [
          escH(a.name || 'An admin') + ' opened the book <b>“' + escH(title) + '”</b>' + (c.period ? ' for ' + escH(ymLong(c.period)) : '') + '.',
          'Please confirm every project you lead by <b>' + escH(due) + '</b>. Confirming copies your projects, as they stand, into the book leadership reports on. One confirmation per book.',
          'The countdown pill at the bottom-left of every page shows where you stand.'],
          { href: pageUrl('Monthly Confirmed Book.html'), label: 'Open the Monthly Confirmed Book' }) });
      publishStatus(o.records);
    }
    return db.cycles[id];
  }
  function editHeader(id, what, apply) {
    if (!isLeadership()) throw new Error('Only a leadership admin can change a book\'s ' + what + '.');
    const db = readDb(); const c = db.cycles[id]; if (!c) throw new Error('No such book.');
    apply(c);
    const now = new Date().toISOString();
    c.metaUpdatedAt = now; c.updatedAt = now;
    markDirty(db, id); writeDb(db);
    return c;
  }
  function setDeadline(id, deadline) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(deadline || '')) || !deadlineEnd(deadline)) throw new Error('Pick a confirm-by date.');
    const c = editHeader(id, 'deadline', b => { b.deadline = deadline; });
    S().logSystem('cycle-deadline', { cycle: id, name: c.name, deadline });
    publishStatus();
    return c;
  }
  function setName(id, name) {
    const nm = cleanName(name);
    if (nm.length < 2) throw new Error('A book needs a name.');
    const c = editHeader(id, 'name', b => { b.name = nm; });
    S().logSystem('cycle-name', { cycle: id, name: nm });
    return c;
  }
  function setPeriod(id, period) {
    const p = String(period || '').trim();
    if (!isYm(p)) throw new Error('The period should be a month.');
    const c = editHeader(id, 'period', b => { b.period = p; });
    S().logSystem('cycle-period', { cycle: id, name: c.name, period: p });
    return c;
  }

  /* ---------- notices (email, through the Box outbox) ----------
     The book is the one place people must act on time, so it is the one
     place the app sends mail: book opened, confirmed, locked without you,
     acknowledged. Each is a small JSON message the Box adapter files for a
     Power Automate flow to send; nothing here waits on it or can fail on it. */
  const escH = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function pageUrl(page) { try { return location.origin + location.pathname.replace(/[^/]*$/, '') + encodeURIComponent(page); } catch (e) { return page; } }
  function leaderEmail(id) { const l = S().leaderById ? S().leaderById(id) : null; const u = l && String(l.username || '').toLowerCase(); return (u && /@/.test(u)) ? u : ''; }
  function adminEmails() { try { return S().adminEmails ? S().adminEmails() : []; } catch (e) { return []; } }
  function noticeHtml(title, paras, cta) {
    const btn = cta ? '<p style="margin:18px 0"><a href="' + escH(cta.href) + '" style="background:#25273A;color:#fff;padding:10px 16px;text-decoration:none;font-weight:700">' + escH(cta.label) + '</a></p>' : '';
    return '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#25273A;line-height:1.5;max-width:640px">' +
      '<p style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#79828C;margin:0 0 6px">Savills PPM · Fee tool</p>' +
      '<h2 style="margin:0 0 12px;font-size:18px">' + escH(title) + '</h2>' +
      paras.map(p => '<p style="margin:0 0 10px">' + p + '</p>').join('') + btn +
      '<p style="font-size:12px;color:#79828C;margin-top:20px">Sent automatically by the fee tool when the confirmed book changed.</p></div>';
  }
  function sendNotice(evt) { try { const B = window.UFC_Box; if (B && B.enabled && B.notify) return B.notify(evt); } catch (e) { /* mail is never on the critical path */ } return null; }
  /** Where the open book stands, for the daily reminder flow: who still owes
      a confirmation, and from when to remind them (three days out). */
  function publishStatus(records) {
    try {
      const B = window.UFC_Box; if (!(B && B.enabled && B.writeNotifyStatus)) return null;
      const st = S(); const recs = records || st.listProjects();
      const cur = currentCycle();
      const status = { updatedAt: new Date().toISOString(), app: (typeof location !== 'undefined' ? location.origin : ''), page: pageUrl('Monthly Confirmed Book.html'), admins: adminEmails(),
        cc: (B.notifyAlwaysCc ? B.notifyAlwaysCc() : []).join(';'), book: null, pending: [], confirmed: [] };
      if (cur) {
        let remindFrom = ''; try { const d = new Date(String(cur.deadline) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 3); remindFrom = d.toISOString(); } catch (e) {}
        status.book = { id: cur.id, title: bookTitle(cur), period: cur.period || '', deadline: cur.deadline, deadlineText: fmtDay(cur.deadline + 'T12:00:00'), remindFrom, lockedAt: cur.lockedAt || null, openedAt: cur.openedAt || null };
        expectedLeaders(recs).forEach(id => {
          if (id === UNASSIGNED) return;
          const k = cur.confirmations[id];
          const row = { id, name: leaderName(id), email: leaderEmail(id) };
          if (k) status.confirmed.push(Object.assign(row, { at: k.at })); else status.pending.push(row);
        });
      }
      B.writeNotifyStatus(status);
      return status;
    } catch (e) { return null; }
  }

  /** One deep copy of a live record, stamped for the book. */
  function stampCopy(rec, leaderId, at, carried) {
    const copy = JSON.parse(JSON.stringify(rec));
    copy._confirmedBy = carried ? null : leaderId;
    copy._confirmedAt = at;
    copy._editedAt = rec.updatedAt || null;
    copy._carried = !!carried;
    return copy;
  }

  /** THE confirmation. Once per leader per book. */
  function confirm(ym, leaderId, opts) {
    const st = S(); const o = opts || {};
    const db = readDb(); const c = db.cycles[ym];
    if (!c) throw new Error('That book is not open for confirmation.');
    const me = myLeaderId();
    const allowed = leaderId === UNASSIGNED ? isLeadership() : (me && me === leaderId);
    if (!allowed) throw new Error('You can only confirm your own book.');
    if (c.confirmations[leaderId]) throw new Error('“' + bookTitle(c) + '” is already confirmed and locked in. Changes since then are noted and carry into the next book.');
    const reason = String(o.reason || '').trim();
    const now = o.now || new Date().toISOString();
    const a = actorStamp();
    if (c.lockedAt) {
      /* LATE, AFTER LOCK. The book's figures are closed: a late confirmation
         is a SIGNATURE on the carried copies — name, time, reason — and the
         numbers stay exactly as they were locked. And only until the next
         book opens: after that the old book can only be acknowledged. */
      const next = supersededBy(c);
      if (next) throw new Error('“' + bookTitle(c) + '” closed for confirmations when “' + bookTitle(next) + '” opened. Acknowledge the missed confirmation instead, then confirm “' + bookTitle(next) + '”.');
      if (reason.length < 5) throw new Error('“' + bookTitle(c) + '” is locked. Add a short reason with your late confirmation — an admin will review it.');
      const copies = bookFor(leaderId, Object.values(c.projects));
      const carried = copies.filter(p => p._carried);
      if (!copies.length) throw new Error('There is nothing to confirm — none of your projects are in “' + bookTitle(c) + '”.');
      carried.forEach(p => { p._lateConfirmedBy = leaderId; p._lateConfirmedAt = now; p._lateReason = reason; });
      const fee = feeInYear(copies, bookYear(c));
      c.confirmations[leaderId] = {
        at: now, by: a.by, name: leaderId === UNASSIGNED ? a.name + ' (admin)' : leaderName(leaderId),
        projects: copies.length, fee,
        late: true, afterLock: true, stamped: true, carriedProjects: carried.length,
        reason, reviewedAt: null, reviewedBy: '', updatedAt: now,
      };
      c.carried = (c.carried || []).filter(x => x !== leaderId);
      c.updatedAt = now;
      markDirty(db, ym); writeDb(db);
      st.logSystem('confirm-book', { cycle: ym, name: c.name, period: c.period, leaderId, projects: copies.length, fee, late: true, afterLock: true, stamped: true, reason });
      const who = c.confirmations[leaderId].name, title = bookTitle(c);
      sendNotice({ event: 'book-confirmed-late', at: now, to: adminEmails(), data: { cycle: ym, leaderId, reason },
        subject: who + ' confirmed “' + title + '” late — reason to review',
        text: who + ' confirmed “' + title + '” after it was locked. Reason: ' + reason + '. The locked figures did not change.',
        html: noticeHtml(who + ' confirmed “' + title + '” late', [
          '<b>' + escH(who) + '</b> confirmed after the book was locked, on ' + escH(fmtStamp(now)) + '. The locked figures did not change; the confirmation and reason are stamped on the ' + carried.length + ' carried project' + (carried.length === 1 ? '' : 's') + '.',
          'Reason given: <i>“' + escH(reason) + '”</i>',
          'It is waiting for review on the Tracker tab.'],
          { href: pageUrl('Monthly Confirmed Book.html'), label: 'Review on the Tracker' }) });
      publishStatus();
      return c.confirmations[leaderId];
    }
    const records = bookFor(leaderId, o.records || st.listProjects());
    if (!records.length) throw new Error('There is nothing to confirm — no projects are on your book.');
    records.forEach(r => { c.projects[r.id] = stampCopy(r, leaderId, now, false); });
    const fee = feeInYear(records, bookYear(c));
    c.confirmations[leaderId] = {
      at: now, by: a.by, name: leaderId === UNASSIGNED ? a.name + ' (admin)' : leaderName(leaderId),
      projects: records.length, fee,
      late: pastDeadline(c.deadline, now), afterLock: false,
      reason: reason || '', reviewedAt: null, reviewedBy: '', updatedAt: now,
    };
    c.carried = (c.carried || []).filter(x => x !== leaderId);
    c.updatedAt = now;
    markDirty(db, ym); writeDb(db);
    st.logSystem('confirm-book', { cycle: ym, name: c.name, period: c.period, leaderId, projects: records.length, fee, late: c.confirmations[leaderId].late, afterLock: false, reason: reason || undefined });
    {
      const k = c.confirmations[leaderId]; const title = bookTitle(c);
      const left = expectedLeaders(o.records || st.listProjects()).filter(id => id !== UNASSIGNED && !c.confirmations[id]);
      sendNotice({ event: 'book-confirmed', at: now, to: adminEmails(), data: { cycle: ym, leaderId, projects: k.projects, fee: k.fee, late: k.late },
        subject: k.name + ' confirmed “' + title + '”' + (k.late ? ' (after the deadline)' : '') + ' · ' + left.length + ' still to go',
        text: k.name + ' confirmed “' + title + '”: ' + k.projects + ' projects, ' + bookYear(c) + ' fee $' + Math.round(k.fee).toLocaleString() + '. ' + left.length + ' leader' + (left.length === 1 ? '' : 's') + ' still to confirm.',
        html: noticeHtml(k.name + ' confirmed “' + title + '”', [
          '<b>' + escH(k.name) + '</b> confirmed on ' + escH(fmtStamp(now)) + (k.late ? ' — <b>after the deadline</b>' : '') + ': ' + k.projects + ' project' + (k.projects === 1 ? '' : 's') + ', ' + bookYear(c) + ' fee <b>$' + Math.round(k.fee).toLocaleString() + '</b>.',
          left.length ? 'Still to confirm: ' + escH(left.map(leaderName).join(', ')) + '.' : 'Everyone expected has now confirmed.'],
          { href: pageUrl('Monthly Confirmed Book.html'), label: 'Open the Tracker' }) });
      publishStatus(o.records);
    }
    return c.confirmations[leaderId];
  }

  /** A leader who missed a book that has since been closed by a newer one
      cannot confirm it any more. They acknowledge it instead: that they did
      not confirm, and that invoicing may be delayed for want of reporting
      compliance. The carried copies are stamped with the acknowledgement;
      the figures do not change. */
  function acknowledgeMissed(ym, leaderId, opts) {
    const st = S(); const o = opts || {};
    const db = readDb(); const c = db.cycles[ym];
    if (!c) throw new Error('No such book.');
    const me = myLeaderId();
    const allowed = leaderId === UNASSIGNED ? isLeadership() : (me && me === leaderId);
    if (!allowed) throw new Error('You can only acknowledge your own book.');
    if (!c.lockedAt) throw new Error('“' + bookTitle(c) + '” is still open — confirm it instead.');
    if (c.confirmations[leaderId]) throw new Error('“' + bookTitle(c) + '” is already confirmed.');
    c.acknowledgements = c.acknowledgements || {};
    if (c.acknowledgements[leaderId]) return c.acknowledgements[leaderId];
    const now = o.now || new Date().toISOString(); const a = actorStamp();
    const copies = bookFor(leaderId, Object.values(c.projects)).filter(p => p._carried);
    copies.forEach(p => { p._acknowledgedBy = leaderId; p._acknowledgedAt = now; });
    c.acknowledgements[leaderId] = {
      at: now, by: a.by, name: leaderId === UNASSIGNED ? a.name + ' (admin)' : leaderName(leaderId),
      projects: copies.length, updatedAt: now,
    };
    c.updatedAt = now;
    markDirty(db, ym); writeDb(db);
    st.logSystem('cycle-acknowledge', { cycle: ym, name: c.name, period: c.period, leaderId, projects: copies.length });
    {
      const who = c.acknowledgements[leaderId].name, title = bookTitle(c);
      sendNotice({ event: 'book-acknowledged', at: now, to: adminEmails(), data: { cycle: ym, leaderId },
        subject: who + ' acknowledged missing “' + title + '”',
        text: who + ' acknowledged on ' + fmtStamp(now) + ' that they did not confirm “' + title + '” and that invoicing may be delayed.',
        html: noticeHtml(who + ' acknowledged missing “' + title + '”', [
          '<b>' + escH(who) + '</b> recorded on ' + escH(fmtStamp(now)) + ' that they did not confirm “' + escH(title) + '”, and that invoicing may be delayed for lack of reporting compliance. Their ' + copies.length + ' carried project' + (copies.length === 1 ? '' : 's') + ' stay in the book as locked.'],
          { href: pageUrl('Monthly Confirmed Book.html'), label: 'Open the Tracker' }) });
      publishStatus();
    }
    return c.acknowledgements[leaderId];
  }

  /** Lock the book. Leaders who never confirmed are carried in from the live
      book, flagged, so the confirmed book is still whole. */
  function lockCycle(ym, opts) {
    const st = S(); const o = opts || {};
    if (!isLeadership()) throw new Error('Only a leadership admin can lock a book.');
    const db = readDb(); const c = db.cycles[ym];
    if (!c) throw new Error('No such book.');
    if (c.lockedAt) throw new Error('“' + bookTitle(c) + '” is already locked.');
    const records = o.records || st.listProjects();
    const now = o.now || new Date().toISOString();
    const carried = []; let carriedProjects = 0;
    expectedLeaders(records).forEach(id => {
      if (c.confirmations[id]) return;
      carried.push(id);
      bookFor(id, records).forEach(r => {
        const have = c.projects[r.id];
        if (have && !have._carried) return;           // a peer's confirmation stands
        c.projects[r.id] = stampCopy(r, id, now, true); carriedProjects++;
      });
    });
    const a = actorStamp();
    c.lockedAt = now; c.lockedBy = a.by; c.lockedByName = a.name;
    c.carried = carried; c.metaUpdatedAt = now; c.updatedAt = now;
    markDirty(db, ym); writeDb(db);
    st.logSystem('cycle-lock', { cycle: ym, name: c.name, period: c.period, carried: carried.length, carriedProjects, confirmed: Object.keys(c.confirmations).length });
    {
      const title = bookTitle(c);
      carried.filter(id => id !== UNASSIGNED).forEach(id => {
        const email = leaderEmail(id); if (!email) return;
        const n = bookFor(id, records).length;
        sendNotice({ event: 'book-locked-missed', at: now, to: [email], cc: adminEmails(), data: { cycle: ym, leaderId: id },
          subject: '“' + title + '” was locked without your confirmation',
          text: a.name + ' locked “' + title + '” on ' + fmtDay(now) + ' without your confirmation. Your ' + n + ' projects were carried in flagged “not confirmed”. Confirm late with a reason in the Monthly Confirmed Book before the next book opens; after that you can only acknowledge the miss.',
          html: noticeHtml('“' + title + '” was locked without your confirmation', [
            escH(a.name || 'An admin') + ' locked <b>“' + escH(title) + '”</b> on ' + escH(fmtDay(now)) + '. Your ' + n + ' project' + (n === 1 ? '' : 's') + ' were carried into the book as they stood and flagged <b>“not confirmed”</b>.',
            'Until the next book opens you can still confirm it late with a short reason — the locked figures stay as they are; your name, time and reason are stamped on them. Once the next book has opened you can only acknowledge the missed confirmation, and invoicing may be delayed for lack of reporting compliance.'],
            { href: pageUrl('Monthly Confirmed Book.html'), label: 'Confirm late now' }) });
      });
      sendNotice({ event: 'book-locked', at: now, to: adminEmails(), data: { cycle: ym, carried: carried.length, carriedProjects },
        subject: '“' + title + '” locked — ' + Object.keys(c.confirmations).length + ' confirmed, ' + carried.length + ' carried in',
        text: a.name + ' locked “' + title + '”. ' + Object.keys(c.confirmations).length + ' confirmed; carried in unconfirmed: ' + (carried.map(leaderName).join(', ') || 'none') + '.',
        html: noticeHtml('“' + title + '” is locked', [
          escH(a.name || 'An admin') + ' locked the book on ' + escH(fmtStamp(now)) + '. <b>' + Object.keys(c.confirmations).length + '</b> confirmed.',
          carried.length ? 'Carried in unconfirmed (' + carriedProjects + ' project' + (carriedProjects === 1 ? '' : 's') + '): <b>' + escH(carried.map(leaderName).join(', ')) + '</b>. Each has been emailed.' : 'Everyone expected had confirmed.'],
          { href: pageUrl('Monthly Confirmed Book.html'), label: 'Open the book' }) });
      publishStatus(records);
    }
    return { carried, carriedProjects };
  }
  function reopenCycle(ym) {
    if (!isLeadership()) throw new Error('Only a leadership admin can reopen a book.');
    const db = readDb(); const c = db.cycles[ym];
    if (!c) throw new Error('No such book.');
    if (!c.lockedAt) throw new Error('“' + bookTitle(c) + '” is not locked.');
    const now = new Date().toISOString();
    c.lockedAt = null; c.lockedBy = ''; c.lockedByName = ''; c.reopenedAt = now;
    c.metaUpdatedAt = now; c.updatedAt = now;
    markDirty(db, ym); writeDb(db);
    S().logSystem('cycle-reopen', { cycle: ym, name: c.name });
    publishStatus();
    return c;
  }
  /** Delete a book outright — a test, a mistake. Only while nobody has
      confirmed into it; a book with confirmations is history, so lock or
      reopen it instead. */
  function deleteCycle(id) {
    if (!isLeadership()) throw new Error('Only a leadership admin can delete a book.');
    const db = readDb(); const c = db.cycles[id];
    if (!c) throw new Error('No such book.');
    if (Object.keys(c.confirmations || {}).length) throw new Error('“' + bookTitle(c) + '” has confirmations in it. A book with confirmations is history — lock it instead.');
    const title = bookTitle(c);
    delete db.cycles[id];
    db.dirty = db.dirty.filter(x => x !== id);
    db.known = db.known.filter(x => x !== id);
    writeDb(db, { quiet: true });
    S().logSystem('cycle-delete', { cycle: id, name: title });
    return title;
  }
  /** Box no longer has these: drop them from the cache so a deleted book
      stops showing (and nagging) everywhere. A dirty one is kept — it may be
      brand new and not yet pushed. */
  function pruneMissing(presentIds) {
    const db = readDb(); const keep = new Set(presentIds || []); let dropped = 0;
    Object.keys(db.cycles).forEach(id => {
      if (keep.has(id) || db.dirty.indexOf(id) >= 0) return;
      delete db.cycles[id]; dropped++;
    });
    db.known = db.known.filter(id => keep.has(id) || db.dirty.indexOf(id) >= 0);
    if (dropped) writeDb(db, { quiet: true });
    return dropped;
  }
  /** An admin has read a late confirmation's reason. */
  function reviewLate(ym, leaderId) {
    if (!isLeadership()) throw new Error('Only a leadership admin can review a late confirmation.');
    const db = readDb(); const c = db.cycles[ym]; const k = c && c.confirmations[leaderId];
    if (!k) throw new Error('No confirmation to review.');
    const now = new Date().toISOString(); const a = actorStamp();
    k.reviewedAt = now; k.reviewedBy = a.name || a.by; k.updatedAt = now; c.updatedAt = now;
    markDirty(db, ym); writeDb(db);
    S().logSystem('cycle-review', { cycle: ym, name: c.name, leaderId });
    return k;
  }

  /* ---------- status ---------- */
  /** The tracker's answer for one leader in one month.
        confirmed · green — confirmed, nothing edited since
        changed   · yellow — confirmed, then a project was edited
        due       · red — not yet, deadline ahead
        overdue   · red, bold — not yet, deadline passed
        missed    · red, bold — locked without them; carried in
        none      · grey — nothing to confirm */
  function statusFor(cycle, leaderId, records, now) {
    const t = now ? new Date(now) : new Date();
    const mine = bookFor(leaderId, records);
    const active = mine.filter(isActiveRecord);
    const k = cycle && cycle.confirmations && cycle.confirmations[leaderId];
    if (!cycle) return { k: 'none', text: 'not open', tone: 'n' };
    if (!k && !active.length) return { k: 'none', text: 'no projects', tone: 'n' };
    if (k) {
      const changed = mine.filter(r => (r.updatedAt || '') > k.at);
      const when = fmtDayTime(k.at);
      // Edits after the stamp matter while the book is open; once it is
      // locked they belong to the next book, so a locked book stays green.
      if (changed.length && !cycle.lockedAt) return { k: 'changed', tone: 'y', at: k.at, changed: changed.length,
        text: when + ' · ' + changed.length + ' edited since' };
      return { k: 'confirmed', tone: 'g', at: k.at, text: when + (k.afterLock ? ' · late · after lock' : k.late ? ' · late' : '') };
    }
    if (cycle.lockedAt) {
      const ack = (cycle.acknowledgements || {})[leaderId];
      if (ack) return { k: 'missed', tone: 'r', bold: false, acknowledged: true, at: ack.at, text: 'not confirmed · acknowledged ' + fmtDayTime(ack.at) };
      return { k: 'missed', tone: 'r', bold: true, text: 'not confirmed · carried in' };
    }
    const d = daysUntil(cycle.deadline, t);
    if (pastDeadline(cycle.deadline, t)) return { k: 'overdue', tone: 'r', bold: true, days: -d, text: 'OVERDUE · ' + (-d) + ' day' + (d === -1 ? '' : 's') + ' late' };
    return { k: 'due', tone: 'r', days: d, text: d === 0 ? 'due today' : 'due in ' + d + ' day' + (d === 1 ? '' : 's') };
  }
  /** One project's standing in a month: who has confirmed it, who has not,
      and whose copy is in the book. */
  function projectStatus(cycle, rec, byId) {
    const ls = leadersOf(rec, byId);
    const conf = ls.filter(id => cycle && cycle.confirmations && cycle.confirmations[id]);
    const waiting = ls.filter(id => conf.indexOf(id) < 0);
    const copy = cycle && cycle.projects && cycle.projects[rec.id];
    return { leaders: ls, confirmed: conf, waiting, full: ls.length > 0 && !waiting.length, copy: copy || null,
             editedSince: !!(copy && !copy._carried && (rec.updatedAt || '') > copy._confirmedAt) };
  }
  function fmtDay(iso) {
    const d = new Date(iso); if (isNaN(d)) return '';
    return MN[d.getMonth()] + ' ' + d.getDate();
  }
  /** "Sep 8 · 2:14 PM" — the tracker's cell: the day and the time it was submitted. */
  function fmtDayTime(iso) {
    const d = new Date(iso); if (isNaN(d)) return '';
    let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return MN[d.getMonth()] + ' ' + d.getDate() + ' · ' + h + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + ap;
  }
  function fmtStamp(iso) {
    const d = new Date(iso); if (isNaN(d)) return '';
    let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return MN[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + ' · ' + h + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + ap;
  }

  /** What the every-page widget and the banner show for the signed-in person. */
  function widgetState(user, now) {
    const st = S(); const u = user || st.getCurrentUser();
    const t = now ? new Date(now) : new Date();
    const me = myLeaderId(u); const lead = isLeadership(u);
    const records = st.listProjects();
    const cur = currentCycle();
    // A locked book they never confirmed keeps nagging until they do.
    // Until they confirm late (while no newer book has opened) or acknowledge
    // it (once one has) — the next book cannot be confirmed before that.
    const missed = me ? listCycles().filter(c => c.lockedAt && !c.confirmations[me] && !(c.acknowledgements || {})[me] && (c.carried || []).indexOf(me) >= 0)
      .filter(c => (t - new Date(c.lockedAt)) < 60 * 86400000).pop() : null;
    if (missed) { const next = supersededBy(missed); return { kind: 'missed', mode: next ? 'ack' : 'stamp', next, cycle: missed, leaderId: me, status: statusFor(missed, me, records, t) }; }
    if (!cur) return { kind: 'quiet', cycle: null };
    if (me) {
      const s = statusFor(cur, me, records, t);
      if (s.k === 'none' && !lead) return { kind: 'quiet', cycle: cur };
      if (s.k !== 'none') return { kind: s.k, cycle: cur, leaderId: me, status: s };
    }
    if (lead) {
      const exp = expectedLeaders(records);
      const done = exp.filter(id => cur.confirmations[id]).length;
      const d = daysUntil(cur.deadline, t);
      return { kind: 'admin', cycle: cur, done, expected: exp.length, days: d, overdue: pastDeadline(cur.deadline, t) };
    }
    return { kind: 'quiet', cycle: cur };
  }

  /* ---------- reading the book ---------- */
  /** The confirmed book in projects.json shape, for Executive Reporting. */
  function asProjectsDb(ym) {
    const c = getCycle(ym); if (!c) return null;
    const st = S();
    const db = st.defaultDb ? st.defaultDb() : { schemaVersion: 2, projects: {} };
    db.projects = {};
    Object.keys(c.projects).forEach(id => { db.projects[id] = c.projects[id]; });
    return db;
  }
  const bookRecords = (ym) => { const c = getCycle(ym); return c ? Object.values(c.projects) : []; };
  /** parentId → approved change orders, from the BOOK, not the live store. */
  function changeOrderIndex(ym) {
    const st = S(); const idx = {};
    bookRecords(ym).forEach(p => {
      if (!st.isChangeOrder || !st.isChangeOrder(p) || !st.isApprovedChangeOrder || !st.isApprovedChangeOrder(p)) return;
      (idx[p.changeOrder.parentId] = idx[p.changeOrder.parentId] || []).push(p);
    });
    return idx;
  }
  /** Summary for a locked month's badge. */
  function cycleSummary(ym) {
    const c = getCycle(ym); if (!c) return null;
    const ids = Object.keys(c.projects);
    return { cycle: ym, id: ym, name: c.name || '', period: c.period || '', title: bookTitle(c), label: periodLabel(c) || bookTitle(c),
      lockedAt: c.lockedAt, lockedByName: c.lockedByName, deadline: c.deadline,
      projects: ids.length, carriedProjects: ids.filter(id => c.projects[id]._carried).length,
      confirmed: Object.keys(c.confirmations).length, carried: (c.carried || []).slice(), acknowledged: Object.keys(c.acknowledgements || {}),
      lateReviews: Object.keys(c.confirmations).filter(k => c.confirmations[k].afterLock && !c.confirmations[k].reviewedAt).length };
  }

  /* ---------- sync ---------- */
  /** Union two copies of one month. Keyed all the way down, so nothing is lost:
      header from the later metaUpdatedAt; per leader the later stamp; per
      project a confirmed copy beats a carried one, else the later stamp. */
  function mergeCycle(remote, local) {
    if (!remote) return local; if (!local) return remote;
    const newerMeta = (String(local.metaUpdatedAt || '') > String(remote.metaUpdatedAt || '')) ? local : remote;
    const out = Object.assign({}, remote, local, {
      deadline: newerMeta.deadline, name: newerMeta.name || '', period: newerMeta.period || remote.period || local.period || '',
      lockedAt: newerMeta.lockedAt, lockedBy: newerMeta.lockedBy, lockedByName: newerMeta.lockedByName,
      reopenedAt: newerMeta.reopenedAt, metaUpdatedAt: newerMeta.metaUpdatedAt,
      openedAt: remote.openedAt || local.openedAt, openedBy: remote.openedBy || local.openedBy, openedByName: remote.openedByName || local.openedByName,
      confirmations: {}, acknowledgements: {}, projects: {}, carried: [],
    });
    const stamp = (k) => String((k && (k.updatedAt || k.at)) || '');
    [remote, local].forEach(s => Object.entries((s && s.confirmations) || {}).forEach(([id, k]) => {
      if (!out.confirmations[id] || stamp(k) > stamp(out.confirmations[id])) out.confirmations[id] = k;
    }));
    [remote, local].forEach(s => Object.entries((s && s.acknowledgements) || {}).forEach(([id, k]) => {
      if (!out.acknowledgements[id] || stamp(k) > stamp(out.acknowledgements[id])) out.acknowledgements[id] = k;
    }));
    [remote, local].forEach(s => Object.entries((s && s.projects) || {}).forEach(([id, p]) => {
      const have = out.projects[id];
      if (!have) { out.projects[id] = p; return; }
      if (have._carried && !p._carried) { out.projects[id] = p; return; }
      if (!have._carried && p._carried) return;
      // Two carried copies: the one that has since been signed or acknowledged wins.
      const mark = (x) => String(x._lateConfirmedAt || x._acknowledgedAt || '');
      if (mark(p) !== mark(have)) { if (mark(p) > mark(have)) out.projects[id] = p; return; }
      if (String(p._confirmedAt || '') > String(have._confirmedAt || '')) out.projects[id] = p;
    }));
    // Carried = expected leaders still without a confirmation, per the merged view.
    const carriedAll = new Set([...(remote.carried || []), ...(local.carried || [])]);
    out.carried = [...carriedAll].filter(id => !out.confirmations[id]);
    out.updatedAt = [remote.updatedAt, local.updatedAt].filter(Boolean).sort().pop() || null;
    return normalize(out, out.id || out.cycle);
  }
  function hydrateCycle(ym, remote) {
    const db = readDb(); const m = String(ym);
    db.cycles[m] = normalize(mergeCycle(remote, db.cycles[m]), m);
    writeDb(db, { quiet: true });
    return db.cycles[m];
  }
  /** The body the adapter uploads. */
  const serialize = (ym) => { const c = getCycle(ym); return c ? JSON.stringify(c) : null; };

  window.UFC_Confirm = {
    KEY, UNASSIGNED,
    readDb, defaultDb, attachRemote, dirtyCycles, markCycleClean, rememberKnown, knownCycles, listedAt, _resetCache,
    ymShort, ymLong, monthName, isYm, daysUntil, pastDeadline, defaultDeadline, nextYm, fmtDay, fmtDayTime, fmtStamp,
    bookTitle, periodLabel, bookYear, normalize,
    leadersOf, isActiveRecord, bookFor, expectedLeaders, leaderName, myLeaderId, feeInYear, isLeadership,
    getCycle, listCycles, openCycles, currentCycle, latestLocked, supersededBy, publishStatus, createCycle, setDeadline, setName, setPeriod, confirm, acknowledgeMissed, lockCycle, reopenCycle, reviewLate,
    statusFor, projectStatus, widgetState,
    asProjectsDb, bookRecords, changeOrderIndex, cycleSummary,
    mergeCycle, hydrateCycle, serialize, deleteCycle, pruneMissing,
  };
})();
