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
  function readDb() {
    try {
      const raw = localStorage.getItem(KEY);
      const p = raw ? JSON.parse(raw) : null;
      if (!p || typeof p !== 'object' || !p.cycles) return defaultDb();
      if (!Array.isArray(p.dirty)) p.dirty = [];
      if (!Array.isArray(p.known)) p.known = [];
      Object.keys(p.cycles).forEach(k => normalize(p.cycles[k], k));
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
    return c;
  }
  function writeDb(db, opts) {
    db.schemaVersion = 1;
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) {
      /* Out of storage: shed the oldest LOCKED cycle (safe in Box) and retry. */
      const yms = Object.keys(db.cycles).filter(k => db.cycles[k].lockedAt && db.dirty.indexOf(k) < 0).sort();
      if (yms.length) { delete db.cycles[yms[0]]; try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e2) { return db; } }
      else return db;
    }
    if (!(opts && opts.quiet) && _remote) { try { _remote(db.dirty.slice()); } catch (e) { console.warn('confirmed-book push failed', e); } }
    return db;
  }
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
    const byId = indexById(list);
    return list.filter(r => {
      if (!r || r._deleted) return false;
      const ls = leadersOf(r, byId);
      return leaderId === UNASSIGNED ? ls.length === 0 : ls.indexOf(leaderId) >= 0;
    });
  }
  /** Who is expected this month: every leader with at least one active
      record, plus "unassigned" when active records have no leader at all. */
  function expectedLeaders(records) {
    const list = records || S().listProjects();
    const byId = indexById(list);
    const set = new Set(); let orphans = false;
    list.forEach(r => {
      if (!isActiveRecord(r)) return;
      const ls = leadersOf(r, byId);
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
      try { (st.billingSeries(r, cat) || []).forEach(s => { if (s.year === year) t += (s.invoice || 0); }); } catch (e) { /* unpriced */ }
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
      confirmations: {}, projects: {}, carried: [],
    };
    markDirty(db, id);
    writeDb(db);
    st.logSystem('cycle-open', { cycle: id, name, period: db.cycles[id].period, deadline });
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
    if (c.lockedAt && reason.length < 5) throw new Error('“' + bookTitle(c) + '” is locked. Add a short reason with your late confirmation — an admin will review it.');
    const records = bookFor(leaderId, o.records || st.listProjects());
    if (!records.length) throw new Error('There is nothing to confirm — no projects are on your book.');
    const now = o.now || new Date().toISOString();
    records.forEach(r => { c.projects[r.id] = stampCopy(r, leaderId, now, false); });
    const a = actorStamp();
    const fee = feeInYear(records, bookYear(c));
    c.confirmations[leaderId] = {
      at: now, by: a.by, name: leaderId === UNASSIGNED ? a.name + ' (admin)' : leaderName(leaderId),
      projects: records.length, fee,
      late: pastDeadline(c.deadline, now), afterLock: !!c.lockedAt,
      reason: reason || '', reviewedAt: null, reviewedBy: '', updatedAt: now,
    };
    c.carried = (c.carried || []).filter(x => x !== leaderId);
    c.updatedAt = now;
    markDirty(db, ym); writeDb(db);
    st.logSystem('confirm-book', { cycle: ym, name: c.name, period: c.period, leaderId, projects: records.length, fee, late: c.confirmations[leaderId].late, afterLock: !!c.lockedAt, reason: reason || undefined });
    return c.confirmations[leaderId];
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
    return c;
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
      const when = fmtDay(k.at);
      // Edits after the stamp matter while the book is open; once it is
      // locked they belong to the next book, so a locked book stays green.
      if (changed.length && !cycle.lockedAt) return { k: 'changed', tone: 'y', at: k.at, changed: changed.length,
        text: when + ' · ' + changed.length + ' edited since' };
      return { k: 'confirmed', tone: 'g', at: k.at, text: when + (k.afterLock ? ' · after lock' : k.late ? ' · late' : '') };
    }
    if (cycle.lockedAt) return { k: 'missed', tone: 'r', bold: true, text: 'not confirmed · carried in' };
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
    const missed = me ? listCycles().filter(c => c.lockedAt && !c.confirmations[me] && (c.carried || []).indexOf(me) >= 0)
      .filter(c => (t - new Date(c.lockedAt)) < 60 * 86400000).pop() : null;
    if (missed) return { kind: 'missed', cycle: missed, leaderId: me, status: statusFor(missed, me, records, t) };
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
      confirmed: Object.keys(c.confirmations).length, carried: (c.carried || []).slice(),
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
      confirmations: {}, projects: {}, carried: [],
    });
    const stamp = (k) => String((k && (k.updatedAt || k.at)) || '');
    [remote, local].forEach(s => Object.entries((s && s.confirmations) || {}).forEach(([id, k]) => {
      if (!out.confirmations[id] || stamp(k) > stamp(out.confirmations[id])) out.confirmations[id] = k;
    }));
    [remote, local].forEach(s => Object.entries((s && s.projects) || {}).forEach(([id, p]) => {
      const have = out.projects[id];
      if (!have) { out.projects[id] = p; return; }
      if (have._carried && !p._carried) { out.projects[id] = p; return; }
      if (!have._carried && p._carried) return;
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
    readDb, defaultDb, attachRemote, dirtyCycles, markCycleClean, rememberKnown, knownCycles, listedAt,
    ymShort, ymLong, monthName, isYm, daysUntil, pastDeadline, defaultDeadline, nextYm, fmtDay, fmtStamp,
    bookTitle, periodLabel, bookYear, normalize,
    leadersOf, isActiveRecord, bookFor, expectedLeaders, leaderName, myLeaderId, feeInYear, isLeadership,
    getCycle, listCycles, openCycles, currentCycle, latestLocked, createCycle, setDeadline, setName, setPeriod, confirm, lockCycle, reopenCycle, reviewLate,
    statusFor, projectStatus, widgetState,
    asProjectsDb, bookRecords, changeOrderIndex, cycleSummary,
    mergeCycle, hydrateCycle, serialize,
  };
})();
