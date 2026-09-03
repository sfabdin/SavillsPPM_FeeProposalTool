/* ============================================================
   SAVILLS PPM · RESOURCE / STAFFING MODULE — data store + engine
   ------------------------------------------------------------
   A SEPARATE localStorage store (savills-ppm-staff-db:v1) holding the
   bandwidth-allocation matrix (person → project → month-range → %), a
   people roster with capacity, and Clockify ACTUALS (hours logged per
   person × project × month). It answers three questions the fee tool
   can't yet, until every project is fully staffed:

     1. BANDWIDTH  — who is over/under-allocated, per calendar month
                     (point-in-time sum of % across live allocations).
     2. EXPECTED   — planned hours = capacity hrs × allocation %.
     3. ACTUAL     — hours logged in Clockify, and the variance vs. expected.

   Deliberately kept apart from projects.json: this is interim planning +
   decision notes. Where a project name matches a fee-tool project we link
   across, so the two converge as proposals get built out.

   Nothing here is confidential (no rates); it rides alongside the rest of
   the offline/localStorage app and can later sync as its own Box file.
   ============================================================ */
(function () {
  'use strict';
  const KEY = 'savills-ppm-staff-db:v1';
  const SCHEMA = 1;

  /* Working hours in a month at 100% capacity — per SA: assume 172 h/mo for
     Clockify comparisons. User-tunable on the page. */
  const DEFAULT_MONTH_HOURS = 172;   // = UFC_Store.CAPACITY_HOURS_PER_MONTH; kept as a local so staff.js parses without a store handle

  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // ---------- id / name helpers ----------
  function slug(s) {
    return String(s || '').toLowerCase().replace(/\[new hire\]/g, 'newhire')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';
  }
  function isNewHireName(n) { return /\[new hire\]/i.test(n || ''); }
  function cleanName(n) { return String(n || '').replace(/\[new hire\]/ig, '').trim().replace(/\s+/g, ' '); }
  /* Known name changes — old name (normalized) → current name. Applied at seed,
     re-import, and match time so both names resolve to ONE person. */
  const NAME_ALIASES = { 'sarah alim': 'Sarah Abdin', 'anastasia long': 'Tasia Long' };
  function canonicalName(n) { const c = cleanName(n); return NAME_ALIASES[c.toLowerCase()] || c; }
  function nkey(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  /** Tolerant name match (surname fallback), mirrors the fee store. */
  /** Tolerant name match. Surname fallback is guarded: full names must also
      agree on the first initial ("Eno Chen" ≠ "Mandy Chen"), and a bare
      surname token only matches if it's reasonably distinctive (>4 chars),
      so "Chen" alone doesn't glue every Chen together. */
  /* "Tester, Jane" is "Jane Tester" — sheets and Clockify disagree on order. */
  const flipComma = (s) => { const m = /^([^,]+),\s*(.+)$/.exec(String(s || '')); return m ? (m[2] + ' ' + m[1]) : s; };
  function namesMatch(a, b) {
    const x = nkey(flipComma(canonicalName(a))), y = nkey(flipComma(canonicalName(b)));
    if (!x || !y) return false;
    if (x === y) return true;
    const xp = x.split(' '), yp = y.split(' ');
    const xl = xp[xp.length - 1], yl = yp[yp.length - 1];
    if (xp.length > 1 && yp.length > 1) return xl === yl && xp[0][0] === yp[0][0];  // same surname + same first initial
    // one side is a single token: match against the other's surname only if distinctive
    return (xl === y || yl === x) && (xp.length === 1 ? x : y).length > 4;
  }
  /** Normalize a project name for cross-matching (drop spacing / punctuation). */
  function projKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

  // ---------- month helpers ----------
  function ymOf(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }
  /* A null or malformed month labels as a dash instead of throwing — one bad
     row used to take the whole Allocations tab down through its label. */
  function ymLabel(ym) {   // 'Sep-26' — the shared month format (see ui.js); kept on the staffing API for its callers
    const p = /^(\d{4})-(\d{1,2})$/.exec(String(ym || ''));
    if (!p || +p[2] < 1 || +p[2] > 12) return '—';
    return MON[+p[2] - 1] + '-' + p[1].slice(2);
  }
  /* AN ALLOCATION WITH NO END IS OPEN — active from its start onward. Three
     functions used to disagree: one read a missing end as forever, two read
     it as one month, so a person could read loaded in By Person and "logging,
     not allocated" in Insights at the same time. allocEnd is the one answer;
     enumerations clamp it to the window they are looking at. */
  const OPEN_END = '9999-12';
  const allocEnd = (a) => (a && a.end) || OPEN_END;
  const isOpenEnded = (a) => !!(a && a.start && !a.end);
  const clampPct = (v) => Math.max(0, Math.min(100, Number(v) || 0));
  function ymAdd(ym, n) { let [y, m] = ym.split('-').map(Number); m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return y + '-' + String(m).padStart(2, '0'); }
  function ymCmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function monthsBetween(a, b) { const out = []; let c = a; let g = 0; while (c <= b && g++ < 240) { out.push(c); c = ymAdd(c, 1); } return out; }
  function currentYM() { return ymOf(new Date()); }
  function isPastYM(ym) { return ym < currentYM(); }

  // ---------- store ----------
  function defaultDb() { return { schemaVersion: SCHEMA, people: {}, allocations: [], actuals: {}, mappings: { users: {}, projects: {} }, deleted: {}, meta: { monthHours: DEFAULT_MONTH_HOURS } }; }

  /* Parsed-db cache — the engine calls readDb() thousands of times per render
     (per person × project × month); without this every call re-JSON.parses the
     whole store and the Compare tab freezes. All writes flow through writeDb /
     hydrateFromRemote in this module, which refresh the cache. */
  let _dbCache = null;

  /* The shipped seed (staff-seed.js) is gone: it was 255 real allocations,
     ~105 named people and candid notes, served unauthenticated from the
     public origin because the access wall runs after the file downloads.
     A browser that has never synced now starts with an empty matrix until
     the first Box pull or xlsx import — which is the truthful state. */
  function seedFromMatrix(db) {
    const seed = (typeof window !== 'undefined' && window.STAFF_SEED) || [];
    db.people = {}; db.allocations = [];
    const peopleSeen = {};
    seed.forEach(r => {
      const pid = slug(canonicalName(r.person) + (isNewHireName(r.person) ? ' newhire' : ''));
      if (!peopleSeen[pid]) {
        peopleSeen[pid] = true;
        db.people[pid] = {
          id: pid, name: canonicalName(r.person), isNewHire: isNewHireName(r.person),
          title: '', homeTeam: '', capacityPct: 100, active: true,
        };
      }
      // DETERMINISTIC id — two browsers seeding independently mint IDENTICAL
      // ids, so a merge collides them into one row instead of duplicating
      // every allocation (the random ids here caused exactly that in prod).
      db.allocations.push({
        id: 'al_s_' + slug(r.person + ' ' + r.proj + ' ' + r.start + ' ' + r.pct) + '_' + db.allocations.length,
        personId: pid, project: r.proj, client: r.client,
        status: r.status || 'Active', type: r.type || 'Awarded',
        start: r.start, end: r.end, pct: +r.pct || 0, note: r.note || '',
      });
    });
    db.meta = db.meta || {}; db.meta.matrixImportedAt = new Date().toISOString();
    if (db.meta.monthHours == null) db.meta.monthHours = DEFAULT_MONTH_HOURS;
    return db;
  }

  function readDb() {
    if (_dbCache) return _dbCache;
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) { const db = seedFromMatrix(defaultDb()); writeDb(db); return db; }
      const p = JSON.parse(raw);
      if (!p.people || !p.allocations) return (_dbCache = seedFromMatrix(defaultDb()));
      if (!p.actuals) p.actuals = {};
      if (!p.mappings) p.mappings = { users: {}, projects: {} };
      if (!p.meta) p.meta = { monthHours: DEFAULT_MONTH_HOURS };
      if (p.meta.monthHours == null) p.meta.monthHours = DEFAULT_MONTH_HOURS;
      if (p.meta.monthHours === 160) p.meta.monthHours = DEFAULT_MONTH_HOURS;   // migrate old default → 172
      // apply known name changes to an existing store: display name + unify ids
      Object.values(p.people).forEach(per => { const c = NAME_ALIASES[nkey(per.name)]; if (c) per.name = c; });
      let remapped = false;
      Object.keys(NAME_ALIASES).forEach(oldName => {
        const oldId = slug(oldName), newId = slug(NAME_ALIASES[oldName]);
        if (oldId === newId || !p.people[oldId]) return;
        if (p.people[newId]) delete p.people[oldId];                       // merged already — drop dupe
        else { p.people[newId] = p.people[oldId]; p.people[newId].id = newId; delete p.people[oldId]; }
        p.allocations.forEach(a => { if (a.personId === oldId) a.personId = newId; });
        Object.keys(p.actuals).forEach(k => { if (k.startsWith(oldId + '|')) { p.actuals[newId + k.slice(oldId.length)] = (p.actuals[newId + k.slice(oldId.length)] || 0) + p.actuals[k]; delete p.actuals[k]; } });
        if (p.mappings && p.mappings.users) Object.keys(p.mappings.users).forEach(k => { if (p.mappings.users[k] === oldId) p.mappings.users[k] = newId; });
        remapped = true;
      });
      if (remapped) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) {} }
      _dbCache = p;
      return p;
    } catch (e) { console.error('staff db read failed', e); return (_dbCache = seedFromMatrix(defaultDb())); }
  }
  /* Remote sync — staff.json in Box (same pattern as studio.json). attachRemote
     is wired by the page after boot; hydrate never re-triggers a push. */
  let _push = null;
  function attachRemote(fn) { _push = typeof fn === 'function' ? fn : null; }
  /* Same reason as store.js: a bare setItem on a full browser throws inside
     boot. Loud, and never fatal. */
  function safeSet(value) {
    try { localStorage.setItem(KEY, value); return true; }
    catch (e) {
      console.error('Local cache write failed for the staffing matrix (storage full?)', e);
      try { document.dispatchEvent(new CustomEvent('ufc:sync', { detail: { state: 'error', message: 'Browser storage is full — the staffing matrix could not be cached locally.', at: Date.now() } })); } catch (e2) {}
      return false;
    }
  }
  function hydrateFromRemote(db) {
    if (!db || !db.people || !db.allocations) return false;
    if (!db.actuals) db.actuals = {};
    if (!db.mappings) db.mappings = { users: {}, projects: {} };
    if (!db.deleted) db.deleted = {};
    if (!db.meta) db.meta = { monthHours: DEFAULT_MONTH_HOURS };
    db.schemaVersion = SCHEMA;
    safeSet(JSON.stringify(db));
    _dbCache = db;
    _feeIndex = null; _feeRecords = null; _sfIndex = null;   // fee-tool project list may have changed too
    return true;
  }
  function writeDb(db) {
    db.schemaVersion = SCHEMA;
    db.meta = db.meta || {};
    db.meta.updatedAt = new Date().toISOString();
    try { const u = window.UFC_Store && window.UFC_Store.getCurrentUser && window.UFC_Store.getCurrentUser(); if (u && u.username) db.meta.updatedBy = u.username; } catch (e) {}
    safeSet(JSON.stringify(db));
    _dbCache = db;
    if (_push) { try { _push(db); } catch (e) { console.warn('staff push failed', e); } }
  }


  /* ===== Track changes ======================================================
     The staffing matrix is a living document — who is on what, at what
     percentage, from when — and until now every edit to it was anonymous. It
     is also the one store where "who moved Jane off Tower Alpha in March" is
     asked out loud, so it is exactly the store that needed a trail.

     Entries go into the SAME audit trail as everything else
     (UFC_Store.logActivity → activity-YYYY-MM.json), not a second log of its
     own. One page to read, one filter, one export. Actions are prefixed
     `staff-` so the Change Log can group them without having to know what
     each one means.

     WHERE THE ENTRY LANDS. An allocation names its project as free text; the
     trail keys on a fee-record id. So an allocation resolves through the same
     matcher the rest of this file uses, and the entry is filed against that
     fee project — which is what makes a project's history show its staffing
     changes next to its fee changes instead of in a separate place.

     DIFFS COME OFF DISK, NOT OFF THE CACHE. readDb() hands out a cached object
     graph and listAllocations() copies the ARRAY but not the rows in it, so a
     page that edits a row it was handed is editing the stored row too. Diffing
     against that gives "nothing changed" for every edit made the obvious way.
     The previous state therefore comes from a fresh parse, which is the only
     copy no caller can be holding. (Same trap, same fix, as saveProject.) */
  function logStaff(action, meta, projectId) {
    try {
      const S2 = window.UFC_Store;
      if (S2 && S2.logActivity) S2.logActivity(action, projectId || null, meta || null);
    } catch (e) { /* the trail must never break a save */ }
  }
  /** The staff db as it is ON DISK — no cache, shared with no caller. */
  function storedStaff() {
    try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; }
    catch (e) { return null; }
  }
  const storedPerson = (id) => { const d = storedStaff(); return (d && d.people && d.people[id]) || null; };
  const storedAlloc = (id) => { const d = storedStaff(); return (d && (d.allocations || []).find(x => x.id === id)) || null; };

  /** Which fee project this matrix line belongs to, so the entry files against
      it. Best-effort: an unmatched line still gets logged, just without a home. */
  function feeIdForAlloc(a) {
    try {
      const hits = matchFeeProjects(a.project, a.client) || [];
      return hits.length === 1 ? hits[0].id : null;      // ambiguous is worse than none
    } catch (e) { return null; }
  }

  const ALLOC_FIELDS = [
    ['personName', 'Person'], ['project', 'Project'], ['client', 'Client'],
    ['start', 'Start'], ['end', 'End'], ['pct', 'Allocation %'],
    ['status', 'Status'], ['type', 'Type'], ['note', 'Note'],
  ];
  const PERSON_FIELDS = [
    ['name', 'Name'], ['title', 'Title'], ['homeTeam', 'Home team'],
    ['capacityPct', 'Capacity %'], ['nonBillable', 'Non-billable'], ['active', 'Active'],
  ];
  /** Field-level changes in the shape the Change Log already renders, so a
      staffing edit reads the same way a fee edit does with no extra code. */
  function diffFields(prev, next, fields) {
    const out = [];
    const show = (v) => v === true ? 'yes' : v === false ? 'no' : (v == null || v === '') ? '—' : String(v);
    fields.forEach(([k, label]) => {
      const a = prev ? prev[k] : undefined, b = next ? next[k] : undefined;
      if (b === undefined) return;                       // a patch that does not mention the field
      if (show(a) === show(b)) return;
      out.push({ field: label, from: show(a), to: show(b) });
    });
    return out;
  }

  /** Wipe the matrix (there is no shipped seed any more, so this empties it). Keeps
      actuals and roster capacity edits? — no: full matrix reset. Actuals kept. */
  function reseedMatrix() {
    const db = readDb();
    const keepActuals = db.actuals || {};
    const keepCaps = {}; Object.values(db.people).forEach(p => { keepCaps[p.id] = { capacityPct: p.capacityPct, title: p.title, homeTeam: p.homeTeam, nonBillable: p.nonBillable }; });
    const fresh = seedFromMatrix(defaultDb());
    fresh.actuals = keepActuals;
    Object.values(fresh.people).forEach(p => { if (keepCaps[p.id]) Object.assign(p, keepCaps[p.id]); });
    const was = (db.allocations || []).length;
    writeDb(fresh);
    logStaff('staff-reseed', { replacedAllocations: was, allocations: (fresh.allocations || []).length });
    return fresh;
  }

  function resetAll() {
    const before = readDb();
    const was = { people: Object.keys(before.people || {}).length, allocations: (before.allocations || []).length };
    const db = seedFromMatrix(defaultDb()); writeDb(db);
    logStaff('staff-reset', { replacedPeople: was.people, replacedAllocations: was.allocations });
    return db;
  }

  // ---------- roster ----------
  function listPeople() { return Object.values(readDb().people).sort((a, b) => a.name.localeCompare(b.name)); }
  function getPerson(id) { return readDb().people[id] || null; }
  function savePerson(person) {
    const db = readDb();
    const isNew = !person.id || !storedPerson(person.id);
    // Off disk, BEFORE the Object.assign below mutates the stored row in place.
    const prev = person.id ? storedPerson(person.id) : null;
    if (!person.id) person.id = 'p_' + Math.random().toString(36).slice(2, 9);
    db.people[person.id] = Object.assign(db.people[person.id] || {}, person);
    /* Always stamped. Newest-wins merge compares updatedAt; a person edit
       without one lost to any remote copy that had one. */
    db.people[person.id].updatedAt = new Date().toISOString();
    writeDb(db);
    const next = db.people[person.id];
    const changes = diffFields(prev, next, PERSON_FIELDS);
    if (isNew) logStaff('staff-person-add', { person: next.name || person.id });
    else if (changes.length) logStaff('staff-person', { person: next.name || person.id, changes });
    return next;
  }
  /** Mark a person as pure overhead (non-billable): their internal time is
      EXPECTED, so burn insights stop flagging it, and staffing-availability
      lists stop offering them as project capacity. Stamped with updatedAt so
      the newest-wins people merge carries the flag across browsers. */
  function setPersonNonBillable(personId, flag) {
    return savePerson({ id: personId, nonBillable: !!flag, updatedAt: new Date().toISOString() });
  }
  /** Employment type in one control — the Mapping dropdown writes this.
      'full'     → billable, capacity 100% (the default everyone starts at)
      'part'     → billable, capacity = the given % of a full month; every
                   hours bar in the system (expected hours, time-entry
                   compliance, burn %, freed capacity) already computes
                   against capacityHours, so a 50% part-timer is judged
                   against ~86 h/mo instead of the full-time bar.
      'internal' → pure overhead (nonBillable): internal time expected,
                   excluded from burn flags and availability lists.
      Derive the current type with personEmploymentType(). */
  function setPersonEmployment(personId, opts) {
    opts = opts || {};
    const patch = { id: personId, updatedAt: new Date().toISOString() };
    if (opts.type === 'internal') patch.nonBillable = true;
    else if (opts.type === 'part' || opts.type === 'full') patch.nonBillable = false;
    if (opts.type === 'full') patch.capacityPct = 100;
    else if (opts.capacityPct != null) patch.capacityPct = Math.max(5, Math.min(100, Math.round(+opts.capacityPct) || 100));
    return savePerson(patch);
  }
  function personEmploymentType(person) {
    if (!person) return 'full';
    if (person.nonBillable) return 'internal';
    return (person.capacityPct != null && person.capacityPct < 100) ? 'part' : 'full';
  }
  function setMonthHours(h) {
    const db = readDb();
    const was = db.meta.monthHours;
    db.meta.monthHours = +h || DEFAULT_MONTH_HOURS;
    writeDb(db);
    // Every expected-hours, burn and compliance figure in the system is
    // measured against this, so a quiet change moves every one of them.
    if (was !== db.meta.monthHours) logStaff('staff-hours', { from: was, to: db.meta.monthHours });
  }
  function monthHours() { return readDb().meta.monthHours || DEFAULT_MONTH_HOURS; }

  // ---------- allocations ----------
  function listAllocations() { return readDb().allocations.slice(); }
  function saveAllocation(a) {
    const db = readDb();
    // ensure the person exists in the roster. Names like "Pooled Support"
    // are contract pools — a shared bucket several people bill toward, not
    // an individual — flagged so views can label them.
    if (a.personId && !db.people[a.personId]) {
      db.people[a.personId] = { id: a.personId, name: a.personName || a.personId, isNewHire: false, isPool: /\bpool/i.test(a.personName || ''), title: '', homeTeam: '', capacityPct: 100, active: true };
    }
    if (!a.start || !/^\d{4}-\d{2}$/.test(String(a.start))) throw new Error('An allocation needs a start month (YYYY-MM).');
    if (a.end && String(a.end) < String(a.start)) throw new Error('An allocation cannot end before it starts.');
    a.pct = clampPct(a.pct);
    a.updatedAt = new Date().toISOString();
    try { const u = window.UFC_Store && window.UFC_Store.getCurrentUser(); if (u && u.username) a.updatedBy = u.username; } catch (e) {}
    const prev = a.id ? storedAlloc(a.id) : null;
    if (!a.id) { a.id = 'al_' + Math.random().toString(36).slice(2, 9); db.allocations.push(a); }
    else { const i = db.allocations.findIndex(x => x.id === a.id); if (i >= 0) db.allocations[i] = a; else db.allocations.push(a); }
    writeDb(db);
    const who = a.personName || (db.people[a.personId] || {}).name || a.personId || 'someone';
    if (!prev) {
      logStaff('staff-alloc-add', { person: who, project: a.project || '', client: a.client || '',
        start: a.start || '', end: a.end || '', pct: a.pct }, feeIdForAlloc(a));
    } else {
      const changes = diffFields(prev, a, ALLOC_FIELDS);
      if (changes.length) logStaff('staff-alloc', { person: who, project: a.project || '',
        client: a.client || '', changes }, feeIdForAlloc(a));
    }
    return a;
  }
  /** Soft-delete: keep a tombstone so the deletion survives a merge with a
      teammate's copy instead of the row resurrecting from their file. */
  function deleteAllocation(id) {
    const db = readDb();
    const gone = db.allocations.find(x => x.id === id) || storedAlloc(id);
    db.allocations = db.allocations.filter(x => x.id !== id);
    db.deleted = db.deleted || {};
    db.deleted[id] = new Date().toISOString();
    writeDb(db);
    if (gone) logStaff('staff-alloc-remove', {
      person: gone.personName || (db.people[gone.personId] || {}).name || gone.personId || '',
      project: gone.project || '', client: gone.client || '',
      start: gone.start || '', end: gone.end || '', pct: gone.pct,
    }, feeIdForAlloc(gone));
  }

  /* ===== Multi-user merge =================================================
     staff.json is a whole-file document in Box, so two people editing at once
     used to mean last-write-wins: the second push replaced the first person's
     rows wholesale. This merges at the RECORD level instead — newest edit per
     allocation wins, tombstones are honoured, and roster/actuals/mapping keys
     are unioned. Called by the Box adapter when an upload hits a 412 (someone
     saved first) and on any refresh pull. */
  const TOMB_TTL_DAYS = 90;
  function mergeStaffDb(remote, local) {
    if (!remote || !remote.allocations) return local;
    if (!local || !local.allocations) return remote;
    const out = defaultDb();

    // Tombstones: union, keeping the latest delete time per id.
    const tombs = Object.assign({}, remote.deleted || {});
    Object.entries(local.deleted || {}).forEach(([id, ts]) => {
      if (!tombs[id] || ts > tombs[id]) tombs[id] = ts;
    });

    // Allocations: newest updatedAt wins per id; a record edited AFTER the
    // tombstone was written counts as a deliberate re-add and survives.
    const byId = {};
    (remote.allocations || []).forEach(a => { if (a && a.id) byId[a.id] = a; });
    (local.allocations || []).forEach(a => {
      if (!a || !a.id) return;
      const r = byId[a.id];
      if (!r || (a.updatedAt || '') >= (r.updatedAt || '')) byId[a.id] = a;
    });
    out.allocations = Object.values(byId).filter(a => {
      const t = tombs[a.id];
      return !t || (a.updatedAt || '') > t;
    });

    // Seed-dupe guard: identical person+project+window+pct rows under
    // DIFFERENT ids are two copies of the same auto-seeded allocation (per-
    // browser seed ids used to be random). Keep the newest-edited copy —
    // there is no legitimate reason for byte-identical twins.
    {
      const seen = {};
      out.allocations.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      out.allocations = out.allocations.filter(a => {
        const k = [a.personId, a.project, a.start, a.end, a.pct].join('|');
        if (seen[k]) return false;
        seen[k] = true;
        return true;
      });
    }

    // Drop tombstones older than the TTL, and any the winning record overrode.
    const cutoff = new Date(Date.now() - TOMB_TTL_DAYS * 86400000).toISOString();
    out.deleted = {};
    Object.entries(tombs).forEach(([id, ts]) => {
      if (ts >= cutoff && !out.allocations.some(a => a.id === id)) out.deleted[id] = ts;
    });

    // Roster: union by id. Per-person updatedAt decides when both sides have it;
    // otherwise the local edit wins (this user just acted).
    out.people = Object.assign({}, remote.people || {});
    Object.entries(local.people || {}).forEach(([id, lp]) => {
      const rp = out.people[id];
      if (!rp) { out.people[id] = lp; return; }
      if ((lp.updatedAt || '') >= (rp.updatedAt || '')) out.people[id] = lp;
    });
    // Person tombstones ('person:<id>' keys in deleted) — a duplicate person
    // record merged away by Data Repair must not resurrect from a stale tab.
    Object.keys(out.people).forEach(id => { if (tombs['person:' + id]) delete out.people[id]; });

    // Actuals + mappings: key-wise union, local wins on a clash. Every
    // mappings sub-key the app writes to (staff.js:setUserMapping,
    // setProjectMapping, setFeeMapping, setTitleMapping, setUserExclusion,
    // commitRenames) must be listed here — a key missing from this union is
    // silently dropped on every merge, not just when it clashes.
    out.actuals = Object.assign({}, remote.actuals || {}, local.actuals || {});
    const rMap = remote.mappings || {}, lMap = local.mappings || {};
    const unionUserX = () => {
      const merged = Object.assign({}, rMap.userX || {});
      Object.entries(lMap.userX || {}).forEach(([k, arr]) => { merged[k] = [...new Set([...(merged[k] || []), ...(arr || [])])]; });
      return merged;
    };
    // fee: each key is now an ARRAY of fee-project ids (multi-link) — union
    // rather than last-write-wins, so two people pinning DIFFERENT fee
    // projects to the same matrix project around the same time both survive
    // instead of one silently clobbering the other's addition.
    const unionFee = () => {
      const asArr = (v) => Array.isArray(v) ? v : (v ? [v] : []);
      const merged = {};
      new Set([...Object.keys(rMap.fee || {}), ...Object.keys(lMap.fee || {})]).forEach(k => {
        merged[k] = [...new Set([...asArr((rMap.fee || {})[k]), ...asArr((lMap.fee || {})[k])])];
      });
      return merged;
    };
    out.mappings = {
      users: Object.assign({}, rMap.users || {}, lMap.users || {}),
      projects: Object.assign({}, rMap.projects || {}, lMap.projects || {}),
      fee: unionFee(),
      titles: Object.assign({}, rMap.titles || {}, lMap.titles || {}),
      renames: Object.assign({}, rMap.renames || {}, lMap.renames || {}),
      personAliases: Object.assign({}, rMap.personAliases || {}, lMap.personAliases || {}),
      userX: unionUserX(),
    };

    /* Dismissed contract-staffing rows are a team decision, so they must
       survive the round trip like any other shared state. A top-level key
       left out of this merge is dropped on EVERY sync, not just on a clash —
       which is how a lock once vanished on refresh. Union, newest wins. */
    {
      const merged = Object.assign({}, remote.dismissedGaps || {});
      Object.entries(local.dismissedGaps || {}).forEach(([k, v]) => {
        const r = merged[k];
        if (!r || (v && v.at || '') >= (r.at || '')) merged[k] = v;
      });
      if (Object.keys(merged).length) out.dismissedGaps = merged;
    }

    // Straggler heal: a row arriving from a stale tab may still carry a
    // project name that was since renamed to its canonical form — the same
    // real project then exists under TWO names, splitting coverage. Apply
    // the saved renames here, then re-collapse twins renaming just created.
    {
      const ren = out.mappings.renames || {};
      if (Object.keys(ren).length) {
        const renLC = {};
        Object.entries(ren).forEach(([o, n]) => { renLC[o.toLowerCase()] = n; });
        out.allocations.forEach(a => {
          const t = ren[a.project] || renLC[(a.project || '').toLowerCase()];
          if (t && t !== a.project) a.project = t;
        });
        const seen = {};
        out.allocations.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        out.allocations = out.allocations.filter(a => {
          const k = [a.personId, a.project, a.start, a.end, a.pct].join('|');
          if (seen[k]) return false;
          seen[k] = true;
          return true;
        });
      }
    }

    // Meta: whichever side was written last.
    const rMeta = remote.meta || {}, lMeta = local.meta || {};
    const localNewer = (lMeta.updatedAt || '') >= (rMeta.updatedAt || '');
    out.meta = localNewer ? Object.assign({}, rMeta, lMeta) : Object.assign({}, lMeta, rMeta);
    // Lateness: its own stamp, because it arrives on its own schedule.
    out.lateness = (((lMeta.latenessAt || '') >= (rMeta.latenessAt || '')) ? local.lateness : remote.lateness)
                   || local.lateness || remote.lateness || [];
    /* Anything this function does not know about yet travels with whichever
       copy was written last instead of being dropped. `lateness` was lost on
       every refresh for exactly this reason; the next field must not be. */
    const newest = localNewer ? local : remote, other = localNewer ? remote : local;
    Object.keys(Object.assign({}, other, newest)).forEach(k => {
      if (!(k in out)) out[k] = newest[k] !== undefined ? newest[k] : other[k];
    });
    out.schemaVersion = SCHEMA;
    return out;
  }

  /** Merge a remote snapshot into the local db and persist WITHOUT pushing
      (the caller is mid-push and will upload the result itself). */
  /** A local db that is nothing but an untouched auto-seed (fresh browser,
      incognito, cleared cache) contributes NOTHING worth merging — and merging
      it into real Box data duplicates every seeded allocation, because seed
      row ids are minted per-browser. Detect and REPLACE instead. */
  function isPristineSeed(db) {
    return !!(db.meta && db.meta.matrixImportedAt)
      && (db.allocations || []).every(a => !a.updatedAt)
      && !Object.keys(db.actuals || {}).length
      && !Object.keys((db.mappings || {}).fee || {}).length
      && !Object.keys((db.mappings || {}).users || {}).length
      && !Object.keys(db.deleted || {}).length;
  }

  function mergeFromRemote(remote) {
    const local = readDb();
    const merged = isPristineSeed(local) ? remote : mergeStaffDb(remote, local);
    safeSet(JSON.stringify(merged));
    _dbCache = merged;
    _feeIndex = null; _feeRecords = null; _sfIndex = null;   // fee-tool project list may have changed too
    return merged;
  }

  /** Create a person id for a typed name (reuse if a matching person exists). */
  function personIdForName(name) {
    const db = readDb();
    const hit = Object.values(db.people).find(p => namesMatch(p.name, name));
    return hit ? hit.id : slug(name);
  }

  // ---------- window / distinct ----------
  function distinctProjects() {
    const s = new Set(); readDb().allocations.forEach(a => a.project && s.add(a.project));
    return [...s].sort();
  }
  function distinctClients() {
    const s = new Set(); readDb().allocations.forEach(a => a.client && s.add(a.client));
    return [...s].sort();
  }
  /** The month span covered by all allocations, clamped to something sane. */
  function allocationWindow() {
    const al = readDb().allocations; let lo = null, hi = null;
    al.forEach(a => { if (a.start && (!lo || a.start < lo)) lo = a.start; if (a.end && (!hi || a.end > hi)) hi = a.end; });
    return { lo: lo || currentYM(), hi: hi || ymAdd(currentYM(), 11) };
  }
  /** A default 12-month display window starting this calendar year's Jan (or
      the allocation start, whichever is later) — the planning horizon. */
  function defaultWindow() {
    const now = new Date();
    const lo = now.getUTCFullYear() + '-01';
    return { lo, hi: ymAdd(lo, 11) };
  }

  // ---------- ENGINE: bandwidth / utilization ----------
  function allocActiveIn(a, ym) { return !!(a && a.start && a.start <= ym && ym <= allocEnd(a)); }

  /* ---------- logging time with nothing planned against it ----------
     Two different holes, both of which end with real hours nobody is looking
     at, and both raised on the Aug 13 review:

     1. NOT ON THE ROSTER. Clockify hours under a name the roster doesn't
        know land under an 'unmatched:' id. Jeff's own hours were invisible
        for exactly this reason — no allocation meant no roster record meant
        no match. These already surface in the import's unmatched list.
     2. ON THE ROSTER, NO ALLOCATION. Quieter and worse: the person matches,
        their hours are stored and costed, but nothing is planned against
        them — so plan-vs-actual compares real burn to zero and the load
        chart shows them free while they are working.

     This reports (2), which had nowhere to appear at all. */
  function loggingWithoutAllocation(monthsList) {
    const db = readDb();
    const inWin = new Set(monthsList || []);
    const byPerson = {};
    Object.entries(db.actuals || {}).forEach(([k, h]) => {
      const i1 = k.indexOf('|'), i2 = k.lastIndexOf('|');
      const pid = k.slice(0, i1), proj = k.slice(i1 + 1, i2), ym = k.slice(i2 + 1);
      if (inWin.size && !inWin.has(ym)) return;
      if (isMacroProject(proj)) return;              // internal time needs no allocation
      const e = byPerson[pid] || (byPerson[pid] = { pid, hours: 0, projects: {} });
      e.hours += h; e.projects[proj] = (e.projects[proj] || 0) + h;
    });
    const out = [];
    Object.values(byPerson).forEach(e => {
      if (String(e.pid).startsWith('unmatched:')) return;    // case (1) — reported by the importer
      const person = db.people[e.pid];
      if (!person) return;
      if (person.nonBillable) return;                         // overhead staff need no allocation
      const winEnd = inWin.size ? [...inWin].sort().pop() : null;
      const covers = (db.allocations || []).some(a => a.personId === e.pid && a.start &&
        (!inWin.size || monthsBetween(a.start, a.end || winEnd).some(m => inWin.has(m))));
      if (covers) return;
      out.push({
        person, hours: Math.round(e.hours * 10) / 10,
        projects: Object.entries(e.projects).map(([name, hrs]) => ({ name, hours: Math.round(hrs * 10) / 10 }))
          .sort((a, b) => b.hours - a.hours),
      });
    });
    return out.sort((a, b) => b.hours - a.hours);
  }

  /* ---------- duplicate allocations ----------
     The same person allocated to the same project over OVERLAPPING months,
     across two or more rows. On the Aug 13 review this is what put Danielle
     at 200% ("I think it's the same thing twice") — the load charts add both
     rows, so every over-allocation number downstream is wrong until one goes.

     Sequential rows on one project (phase 1 then phase 2) are normal and are
     NOT flagged — only overlapping windows are. Two genuine concurrent roles
     are possible too, which is exactly why this REPORTS and never deletes:
     the rows are shown with their overlap so a human decides. */
  function duplicateAllocations() {
    const db = readDb();
    const ren = (db.mappings || {}).renames || {};
    const canon = (n) => nkey(ren[nkey(n)] || n || '');
    const groups = {};
    (db.allocations || []).forEach(a => {
      if (!a || !a.personId || !a.project) return;
      if (isLeaveProject(a.project)) return;            // leave rows legitimately repeat
      (groups[a.personId + '|' + canon(a.project)] = groups[a.personId + '|' + canon(a.project)] || []).push(a);
    });
    const overlaps = (x, y) => {
      const xs = x.start || '', xe = allocEnd(x);
      const ys = y.start || '', ye = allocEnd(y);
      if (!xs || !ys) return false;
      return xs <= ye && ys <= xe;
    };
    const out = [];
    Object.values(groups).forEach(rows => {
      if (rows.length < 2) return;
      // Only keep rows that actually collide with another row in the group.
      const hit = rows.filter(r => rows.some(o => o !== r && overlaps(r, o)));
      if (hit.length < 2) return;
      const person = db.people[hit[0].personId] || { id: hit[0].personId, name: hit[0].personName || hit[0].personId };
      // The months where the doubling actually bites, and by how much.
      const months = {};
      hit.forEach(r => monthsBetween(r.start, r.end || ymAdd(r.start, 11)).forEach(m => {
        months[m] = (months[m] || 0) + (parseFloat(r.pct) || 0);
      }));
      const worst = Object.entries(months).sort((a, b) => b[1] - a[1])[0] || ['', 0];
      out.push({
        person, project: hit[0].project,
        rows: hit.slice().sort((a, b) => (a.start || '').localeCompare(b.start || '')),
        worstMonth: worst[0], worstPct: Math.round(worst[1]),
        /* Byte-identical twins (same window AND same %) are almost certainly
           one row saved twice — worth saying so, since that needs no thought. */
        identical: hit.length === 2 && hit[0].start === hit[1].start
          && (hit[0].end || '') === (hit[1].end || '')
          && (parseFloat(hit[0].pct) || 0) === (parseFloat(hit[1].pct) || 0),
      });
    });
    return out.sort((a, b) => b.worstPct - a.worstPct || a.person.name.localeCompare(b.person.name));
  }

  /** Total allocation % for a person in a given month (point-in-time). */
  function personLoad(personId, ym, opts) {
    const includePursuit = !opts || opts.includePursuit !== false;
    return readDb().allocations.reduce((s, a) => {
      if (a.personId !== personId) return s;
      if (!includePursuit && (a.status === 'Pursuit' || a.type === 'Opportunity')) return s;
      return s + (allocActiveIn(a, ym) ? (a.pct || 0) : 0);
    }, 0);
  }

  /** A person's allocations active in a month, with project/pct. */
  function personAllocationsIn(personId, ym) {
    return readDb().allocations.filter(a => a.personId === personId && allocActiveIn(a, ym));
  }

  /** Bandwidth grid: rows = people, each with per-month load %. `opts.months`
      = array of YYYY-MM. Returns [{person, byMonth:{ym:pct}, peak, avg}]. */
  function bandwidthGrid(months, opts) {
    const db = readDb();
    const rows = Object.values(db.people).map(person => {
      const byMonth = {}; let peak = 0, sum = 0, n = 0;
      months.forEach(ym => {
        const v = personLoad(person.id, ym, opts);
        byMonth[ym] = v; if (v > peak) peak = v; if (v > 0) { sum += v; n++; }
      });
      return { person, byMonth, peak, avg: n ? sum / n : 0, activeMonths: n };
    });
    return rows;
  }

  // ---------- ENGINE: project roll-up ----------
  /** Per-project: distinct people, FTE this month (Σpct/100), and the fee-tool
      project it links to (name match), if any. */
  function projectRollup(months, opts) {
    const includePursuit = !opts || opts.includePursuit !== false;
    const db = readDb();
    const byProj = {};
    db.allocations.forEach(a => {
      if (!includePursuit && (a.status === 'Pursuit' || a.type === 'Opportunity')) return;
      const key = a.project || '—';
      const b = byProj[key] || (byProj[key] = { project: key, client: a.client || '', people: new Set(), status: a.status, type: a.type, byMonth: {}, allocs: [] });
      b.people.add(a.personId); b.allocs.push(a);
      if (a.client) b.client = a.client;
      months.forEach(ym => { if (allocActiveIn(a, ym)) b.byMonth[ym] = (b.byMonth[ym] || 0) + (a.pct || 0) / 100; });
    });
    return Object.values(byProj).map(b => ({
      project: b.project, client: b.client, headcount: b.people.size,
      peakFte: Math.max(0, ...months.map(m => b.byMonth[m] || 0)),
      byMonth: b.byMonth, allocs: b.allocs,
      feeProject: matchFeeProject(b.project, b.client),
    })).sort((a, b) => a.project.localeCompare(b.project));
  }

  /** Best-effort match of a matrix project name to a fee-tool project. */
  let _feeIndex = null, _feeRecords = null;
  // Invalidate when boot.js's live-refresh loop pulls a newer projects.json —
  // otherwise this cache goes stale for the rest of the tab's session the
  // moment a teammate adds/renames a project, and Staffing's fee-tool links
  // silently keep pointing at old data.
  if (typeof document !== 'undefined') {
    document.addEventListener('ufc:remote-updated', (e) => {
      if (e.detail && e.detail.projects) { _feeIndex = null; _feeRecords = null; _sfIndex = null; }
    });
  }
  /** Fee-tool project records, parsed ONCE per page load — UFC_Store.getProject
      re-parses the whole projects.json every call, which froze the Compare tab. */
  function feeRecords() {
    if (_feeRecords) return _feeRecords;
    try { const S2 = window.UFC_Store; _feeRecords = (S2 && S2.listProjects) ? S2.listProjects() : []; } catch (e) { _feeRecords = []; }
    return _feeRecords;
  }
  function feeIndex() {
    if (_feeIndex) return _feeIndex;
    _feeIndex = [];
    feeRecords().forEach(p => {
      const name = (p.project && p.project.name) || '';
      const client = (p.project && p.project.client) || '';
      const label = client ? client + ' — ' + name : name;
      _feeIndex.push({ id: p.id, name, client, label, key: projKey(name) });
      /* Former names resolve to the SAME project, so a Clockify job still
         matched by name survives the fee project being renamed. The entry
         carries the CURRENT name and label — only the match key is historic —
         so nothing downstream ever displays a stale name. */
      ((p.source || {}).priorNames || []).forEach(old => {
        const k = projKey(old);
        if (!k || k === projKey(name)) return;
        _feeIndex.push({ id: p.id, name, client, label, key: k, viaPriorName: old });
      });
    });
    return _feeIndex;
  }
  /** Token-based name similarity — the smart part of project mapping. Splits
      names into significant words (drops filler + punctuation + SF-id-ish
      tokens), scores overlap. "JPMC — 270 Park Relocation" ↔ "270P" style
      abbreviations get partial-prefix credit. */
  // The one matcher lives in the store (UFC_Store.tokenScore) so staffing,
  // revenue import and reconciliation all score names the same way.
  const nameTokens = (s) => window.UFC_Store.nameTokens(s);
  const tokenScore = (a, b) => window.UFC_Store.tokenScore(a, b);

  function matchFeeProject(name, client) {
    const k = projKey(name); if (!k) return null;
    // 0) saved manual link wins — a matrix project can be pinned to several fee
    // projects (setFeeMapping stores an array); this single-result function
    // returns the first/primary one for callers that only want one.
    const feeMap = (readDb().mappings || {}).fee || {};
    const mappedRaw = feeMap[nkey(name)];
    const mapped = Array.isArray(mappedRaw) ? mappedRaw[0] : mappedRaw;
    if (mapped) { const hit = feeIndex().find(p => p.id === mapped); if (hit) return { id: hit.id, name: hit.name, client: hit.client, via: 'mapped' }; }
    const idx = feeIndex();
    // prefer same-client candidates when a client is given and names collide
    const byClient = (list) => {
      if (list.length < 2 || !client) return list[0];
      const cHit = list.find(p => p.client && tokenScore(client, p.client) >= 0.7);
      return cHit || list[0];
    };
    // 1) exact normalized name
    let hits = idx.filter(p => p.key === k);
    if (hits.length) { const h = byClient(hits); return { id: h.id, name: h.name, client: h.client, via: 'name' }; }
    // 2) containment (old behavior, kept for tight names)
    hits = idx.filter(p => p.key && (p.key.includes(k) || k.includes(p.key)) && Math.abs(p.key.length - k.length) < 8);
    if (hits.length) { const h = byClient(hits); return { id: h.id, name: h.name, client: h.client, via: 'name' }; }
    // 3) token scoring — best fee project sharing ≥70% of significant words
    let best = null, bestScore = 0;
    idx.forEach(p => { let s = tokenScore(name, p.name); if (client && p.client) s = s * 0.8 + tokenScore(client, p.client) * 0.2; if (s > bestScore) { bestScore = s; best = p; } });
    if (best && bestScore >= 0.7) return { id: best.id, name: best.name, client: best.client, via: 'tokens', score: Math.round(bestScore * 100) };
    return null;
  }

  /** Every fee project pinned to a matrix project — plural counterpart to
      matchFeeProject(). Multiple manual links all count (their figures sum
      wherever this feeds contractPlan); falls back to the single best
      auto-match when nothing's pinned yet, same as before multi-link existed. */
  function matchFeeProjects(name, client) {
    const k = projKey(name); if (!k) return [];
    const feeMap = (readDb().mappings || {}).fee || {};
    const mappedRaw = feeMap[nkey(name)];
    if (mappedRaw) {
      const ids = Array.isArray(mappedRaw) ? mappedRaw : [mappedRaw];
      const idx = feeIndex();
      return ids.map(id => idx.find(p => p.id === id)).filter(Boolean).map(hit => ({ id: hit.id, name: hit.name, client: hit.client, via: 'mapped' }));
    }
    const auto = matchFeeProject(name, client);
    return auto ? [auto] : [];
  }

  /** Salesforce-ID index over fee-tool projects — Clockify project names carry
      the SF ID, so it's the authoritative cross-system join. */
  let _sfIndex = null;
  function sfIndex() {
    if (_sfIndex) return _sfIndex;
    _sfIndex = [];
    try {
      feeRecords().forEach(p => {
        const sf = String((p.project && p.project.salesforceId) || '').trim().toLowerCase();
        if (sf.length >= 4) _sfIndex.push({ sf, id: p.id, name: (p.project && p.project.name) || '' });
      });
      _sfIndex.sort((a, b) => b.sf.length - a.sf.length);   // longest id first — avoids prefix collisions
    } catch (e) {}
    return _sfIndex;
  }
  /** Numeric/code tokens (383, 270p, fbg) distinguish sibling projects of the
      same client — "JPMC - 383M" vs "JPMC - 270P". If BOTH names carry such
      tokens and NONE overlap (even by prefix), they are different projects. */
  function codeTokens(s) { return nameTokens(s).filter(t => /\d/.test(t)); }
  function codesConflict(a, b) {
    const ca = codeTokens(a), cb = codeTokens(b);
    if (!ca.length || !cb.length) return false;
    return !ca.some(t => cb.some(u => t === u || t.startsWith(u) || u.startsWith(t)));
  }

  /** Resolve a Clockify project name → matrix project name. Order:
      1. saved mapping (handled by caller); 2. exact normalized name;
      3. Salesforce ID; 4. containment — only when UNAMBIGUOUS (exactly one
      candidate) and no code conflict; 5. token score ≥ 0.7 with a clear
      margin over the runner-up and no code conflict. Ambiguity → null, so
      the row surfaces as unmatched instead of landing on a sibling project. */
  function resolveClockifyProject(raw) {
    const k = projKey(raw); if (!k) return null;
    const all = distinctProjects();
    let hit = all.find(pn => projKey(pn) === k);
    if (hit) return { name: hit, via: 'name' };
    const rawL = String(raw).toLowerCase();
    const sf = sfIndex().find(e => rawL.includes(e.sf) || k.includes(projKey(e.sf)));
    if (sf) {
      const fk = projKey(sf.name);
      const viaMatrix = all.find(pn => projKey(pn) === fk)
        || all.find(pn => (projKey(pn).includes(fk) || fk.includes(projKey(pn))) && Math.abs(projKey(pn).length - fk.length) < 8);
      return { name: viaMatrix || sf.name, via: 'salesforce' };
    }
    const contain = all.filter(pn => (projKey(pn).includes(k) || k.includes(projKey(pn))) && Math.abs(projKey(pn).length - k.length) < 8 && !codesConflict(raw, pn));
    if (contain.length === 1) return { name: contain[0], via: 'fuzzy' };
    // token scoring — best + margin, codes must not conflict
    const scored = all.filter(pn => !codesConflict(raw, pn)).map(pn => ({ pn, s: tokenScore(raw, pn) })).sort((x, y) => y.s - x.s);
    if (scored.length && scored[0].s >= 0.7 && (scored.length < 2 || scored[0].s - scored[1].s >= 0.15)) return { name: scored[0].pn, via: 'tokens' };
    return null;
  }

  /** Fee-tool projects for pickers: [{id, name, client, label}] — label is
      "Client — Project" because project names collide across clients. */
  function listFeeProjects() { return feeIndex().map(p => ({ id: p.id, name: p.name, client: p.client, label: p.label })).sort((a, b) => a.label.localeCompare(b.label)); }

  // ---------- ENGINE: expected vs actual ----------
  function capacityHours(person) { return monthHours() * ((person && person.capacityPct != null ? person.capacityPct : 100) / 100); }

  /** Expected hours for a person on a project in a month = capacity × alloc%. */
  function expectedHours(personId, project, ym) {
    const db = readDb(); const person = db.people[personId];
    const cap = capacityHours(person);
    return db.allocations.reduce((s, a) => {
      if (a.personId !== personId || a.project !== project) return s;
      return s + (allocActiveIn(a, ym) ? cap * (a.pct || 0) / 100 : 0);
    }, 0);
  }

  function actualKey(personId, project, ym) { return personId + '|' + project + '|' + ym; }
  function actualHours(personId, project, ym) { return readDb().actuals[actualKey(personId, project, ym)] || 0; }

  /** Full expected-vs-actual matrix over `months`, grouped by project then
      person. Rows carry expected + actual + variance per month and totals. */
  function varianceMatrix(months, opts) {
    const db = readDb();
    const wantProject = opts && opts.project;
    const wantPerson = opts && opts.person;
    // gather (person, project) pairs that have either an allocation or an actual in-window
    const pairs = {};
    db.allocations.forEach(a => {
      if (wantProject && a.project !== wantProject) return;
      if (wantPerson && a.personId !== wantPerson) return;
      if (!months.some(m => allocActiveIn(a, m))) return;
      pairs[a.personId + '|' + a.project] = { personId: a.personId, project: a.project, client: a.client };
    });
    Object.keys(db.actuals).forEach(k => {
      const [personId, project, ym] = k.split('|');
      if (!months.includes(ym)) return;
      if (wantProject && project !== wantProject) return;
      if (wantPerson && personId !== wantPerson) return;
      const pk = personId + '|' + project;
      if (!pairs[pk]) pairs[pk] = { personId, project, client: '' };
    });
    const rows = Object.values(pairs).map(pr => {
      const person = db.people[pr.personId] || { id: pr.personId, name: pr.personId };
      const byMonth = {}; let eTot = 0, aTot = 0;
      months.forEach(ym => {
        const e = expectedHours(pr.personId, pr.project, ym);
        const a = actualHours(pr.personId, pr.project, ym);
        byMonth[ym] = { e, a, v: a - e };
        eTot += e; aTot += a;
      });
      return { person, project: pr.project, client: pr.client, byMonth, expected: eTot, actual: aTot, variance: aTot - eTot };
    });
    return rows.sort((a, b) => a.project.localeCompare(b.project) || a.person.name.localeCompare(b.person.name));
  }

  function hasActuals() { return Object.keys(readDb().actuals).length > 0; }

  /** Planned hours per month from the MATCHED fee-tool project's staffing
      (roles × FTE × hrsPerMo) — the "once proposals are built out" baseline the
      matrix converges to. Returns null when the project isn't in the fee tool
      or carries no staffing. { byMonth:{ym:hrs}, total, feeProjects } */
  function feePlanHours(projectName, months) {
    const cp = contractPlan(projectName, months);
    return cp ? { byMonth: cp.byMonth, total: cp.total, feeProjects: cp.feeProjects } : null;
  }

  /** CONTRACT plan — the fee-tool staffing for a window, with a per-TITLE
      breakdown (contract knows titles + allocations, not names). Rate-free.
      A matrix project can be pinned to SEVERAL fee projects; their figures
      sum into one plan. { byMonth:{ym:hrs}, total, roles:[{title, fteMonths, hours}], feeProjects } */
  function contractPlan(projectName, months, client) {
    const links = matchFeeProjects(projectName, client);
    if (!links.length) return null;
    const S2 = window.UFC_Store;
    const cat = (typeof window !== 'undefined') && window.RATES_CATALOG;
    const inWin = new Set(months);
    const byMonth = {}; const roleAgg = {}; let total = 0, any = false;
    let feeByMonth = null, feeTotal = 0, anyFee = false;
    links.forEach(link => {
      const p = feeRecords().find(x => x.id === link.id);
      if (!p || !p.roles || !p.roles.length || !p.timeline) return;
      const hrs = (p.assumptions && p.assumptions.hrsPerMo) || S2.PRICING_HOURS_PER_MONTH;
      const byPhase = S2.computeMonthsByPhase(p);
      const phaseOf = {};
      (p.phases || []).forEach(ph => (byPhase[ph.id] || []).forEach(m => { phaseOf[m.year + '-' + m.month] = ph.id; }));
      const titleOf = (r) => {
        const t = cat && cat.titles && cat.titles.find(x => x.id === r.titleId);
        return (r.projectRole || '').trim() || (t && (t.name || t.label)) || r.titleId || 'Role';
      };
      S2.enumerateMonths(p.timeline).forEach(m => {
        const ym = m.year + '-' + String(m.month).padStart(2, '0');
        if (!inWin.has(ym)) return;
        const mk = m.year + '-' + m.month;              // fee tool keys are non-padded
        p.roles.forEach(r => {
          const fte = ((r.fteMonthly && r.fteMonthly[mk] != null) ? r.fteMonthly[mk] : ((r.fte && r.fte[phaseOf[mk]]) || 0)) / 100;
          if (!fte) return;
          const h = fte * hrs;
          byMonth[ym] = (byMonth[ym] || 0) + h;
          const tl = titleOf(r);
          const ra = roleAgg[tl] || (roleAgg[tl] = { title: tl, fteMonths: 0, hours: 0 });
          ra.fteMonths += fte; ra.hours += h;
          total += h; any = true;
        });
      });
      // billed fee $ by month (net of discounts/locks) — powers the dollars view
      if (cat && cat.hydrated) {
        try {
          const series = S2.monthlySeries(p, cat) || [];
          if (series.length) { feeByMonth = feeByMonth || {}; series.forEach(m => { const ym = m.year + '-' + String(m.month).padStart(2, '0'); if (inWin.has(ym)) { feeByMonth[ym] = (feeByMonth[ym] || 0) + m.amount; feeTotal += m.amount; anyFee = true; } }); }
        } catch (e) {}
      }
    });
    if (!any) return null;
    const roles = Object.values(roleAgg).map(r => ({ title: r.title, fteMonths: Math.round(r.fteMonths * 100) / 100, hours: Math.round(r.hours * 10) / 10 })).sort((a, b) => b.hours - a.hours);
    return { byMonth, total: Math.round(total * 10) / 10, roles, feeProjects: links, feeByMonth: anyFee ? feeByMonth : null, feeTotal: Math.round(feeTotal) };
  }

  function actualsMeta() { const m = readDb().meta || {}; return { importedAt: m.clockifyImportedAt, rows: Object.keys(readDb().actuals).length, months: m.clockifyMonths || [] }; }

  // ---------- Clockify import ----------
  /** Parse a CSV string into rows of objects keyed by header. Handles quoted
      fields with commas + escaped quotes. */
  function parseCsv(text) {
    const rows = []; let row = [], field = '', inQ = false;
    text = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); if (row.some(x => x !== '')) rows.push(row); row = []; field = ''; }
        else field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); if (row.some(x => x !== '')) rows.push(row); }
    if (!rows.length) return [];
    const header = rows[0].map(h => h.trim());
    return rows.slice(1).map(r => { const o = {}; header.forEach((h, i) => o[h] = (r[i] || '').trim()); return o; });
  }

  function findCol(obj, candidates) {
    const keys = Object.keys(obj);
    for (const cand of candidates) {
      const k = keys.find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === cand);
      if (k) return k;
    }
    for (const cand of candidates) {
      const k = keys.find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '').includes(cand));
      if (k) return k;
    }
    return null;
  }

  /** Convert a Clockify duration to decimal hours. Accepts "8.50", "8:30:00",
      "08:30" or a decimal string. */
  function toHours(v) {
    if (v == null || v === '') return 0;
    const s = String(v).trim();
    if (/^\d+:\d{2}(:\d{2})?$/.test(s)) { const p = s.split(':').map(Number); return p[0] + p[1] / 60 + (p[2] || 0) / 3600; }
    const n = parseFloat(s.replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  }

  /** Parse a date-ish string → YYYY-MM (Clockify uses MM/DD/YYYY or YYYY-MM-DD). */
  function toYm(v, fallback) {
    if (!v) return fallback || null;
    const s = String(v).trim();
    let m;
    if ((m = s.match(/^(\d{4})-(\d{2})/))) return m[1] + '-' + m[2];
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return m[3] + '-' + String(+m[1]).padStart(2, '0');
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\b/))) return '20' + m[3] + '-' + String(+m[1]).padStart(2, '0');
    const d = new Date(s); if (!isNaN(d)) return ymOf(d);
    return fallback || null;
  }

  /** Dry-run a Clockify CSV → aggregated {person, project, ym, hours} plus a
      match report (which users/projects resolve to the roster/matrix). Does NOT
      write. `defaultMonth` buckets rows with no parseable date. */
  function analyzeClockify(text, defaultMonth) {
    const rows = parseCsv(text);
    if (!rows.length) return { error: 'No rows found in the file.' };
    const sample = rows[0];
    const cUser = findCol(sample, ['user', 'username', 'member', 'name']);
    const cEmail = findCol(sample, ['email', 'useremail']);
    const cProject = findCol(sample, ['project']);
    const cDurDec = findCol(sample, ['timeh', 'timedecimal', 'durationdecimal', 'durationh', 'durationhours', 'timehours', 'timeh']);
    const cDur = cDurDec || findCol(sample, ['duration', 'time']);
    const cDate = findCol(sample, ['startdate', 'date', 'day']);
    const cTitle = findCol(sample, ['jobtitle', 'title', 'position']);
    const titles = {};
    if (!cProject) return { error: 'Could not find a "Project" column. Export a Clockify Detailed or Summary report as CSV.' };
    if (!cDur) return { error: 'Could not find a duration/time column. Include "Duration (decimal)" or "Time (h)" in the export.' };

    const agg = {}; // key personId|project|ym -> hours
    const unmatchedUsers = {}, unmatchedProjects = {}, monthsSeen = new Set();
    const matchDetail = {};   // clockify name -> {to, via, hours}
    const db = readDb();
    let totalHours = 0, rowCount = 0, sfHits = 0;
    rows.forEach(r => {
      const uname = cUser ? r[cUser] : (cEmail ? r[cEmail] : '');
      const proj = r[cProject]; if (!proj) return;
      const hrs = toHours(r[cDur]); if (!hrs) return;
      const ym = toYm(cDate ? r[cDate] : '', defaultMonth); if (!ym) return;
      // saved mappings first — '__ignore__' drops the row (e.g. non-delivery staff)
      const maps = db.mappings || { users: {}, projects: {} };
      const uMap = maps.users[nkey(uname)];
      const pMap = maps.projects[nkey(proj)];
      if (uMap === '__ignore__' || pMap === '__ignore__') return;
      monthsSeen.add(ym);
      // match person: saved mapping → name match (exclusions block the fuzzy path)
      let person = (uMap && db.people[uMap]) ? db.people[uMap] : Object.values(db.people).find(p => namesMatch(p.name, uname) && !((maps.userX || {})[nkey(uname)] || []).includes(p.id));
      const personId = person ? person.id : ('unmatched:' + nkey(uname));
      if (!person) unmatchedUsers[uname] = (unmatchedUsers[uname] || 0) + hrs;
      if (person && cTitle && r[cTitle] && !titles[personId]) titles[personId] = String(r[cTitle]).trim();
      // match project: saved mapping → exact name → Salesforce ID → fuzzy
      let projName, via = null;
      if (pMap) { projName = pMap; via = 'mapped'; }
      else { const res = resolveClockifyProject(proj); projName = res ? res.name : proj; via = res && res.via; }
      if (via === 'salesforce') sfHits++;
      if (!via) unmatchedProjects[proj] = (unmatchedProjects[proj] || 0) + hrs;
      // audit trail: where every Clockify project's hours landed
      const md = matchDetail[proj] || (matchDetail[proj] = { to: projName, via: via || 'unmatched', hours: 0 });
      md.hours += hrs;
      const key = actualKey(personId, projName, ym);
      agg[key] = (agg[key] || 0) + hrs;
      totalHours += hrs; rowCount++;
    });
    return {
      ok: true, agg, totalHours: Math.round(totalHours * 10) / 10, rowCount, sfHits, titles,
      matchDetail: Object.entries(matchDetail).map(([from, d]) => ({ from, to: d.to, via: d.via, hours: Math.round(d.hours * 10) / 10 })).sort((a, b) => b.hours - a.hours),
      months: [...monthsSeen].sort(),
      matchedUsers: Object.keys(db.people).length,
      unmatchedUsers: Object.entries(unmatchedUsers).map(([k, v]) => ({ name: k, hours: Math.round(v * 10) / 10 })).sort((a, b) => b.hours - a.hours),
      unmatchedProjects: Object.entries(unmatchedProjects).map(([k, v]) => ({ name: k, hours: Math.round(v * 10) / 10 })).sort((a, b) => b.hours - a.hours),
      cols: { user: cUser || cEmail, project: cProject, duration: cDur, date: cDate },
    };
  }

  /** Commit an analyzed Clockify report. mode 'replace' clears actuals for the
      report's months first (re-import a period cleanly); 'merge' adds. Drops
      rows whose person didn't match the roster (they carry no capacity). */
  function commitClockify(report, mode) {
    if (!report || !report.ok) return null;
    const db = readDb();
    if (mode === 'replace') {
      const set = new Set(report.months);
      Object.keys(db.actuals).forEach(k => { const ym = k.split('|')[2]; if (set.has(ym)) delete db.actuals[k]; });
    }
    let written = 0, skipped = 0;
    Object.entries(report.agg).forEach(([k, hrs]) => {
      if (k.startsWith('unmatched:')) { skipped++; return; }
      db.actuals[k] = Math.round((mode === 'merge' ? (db.actuals[k] || 0) : 0) + hrs * 10) / 10;
      written++;
    });
    db.meta.clockifyImportedAt = new Date().toISOString();
    db.meta.clockifyMonths = [...new Set([...(db.meta.clockifyMonths || []), ...report.months])].sort();
    // One entry for the run, not one per row: a Clockify import lands thousands
    // of cells, and a trail nobody can read is a trail nobody reads.
    logStaff('staff-actuals', { mode, months: (report.months || []).join(', '), written, skipped });
    // Clockify carries the job title — fill roster titles that are still blank.
    Object.entries(report.titles || {}).forEach(([pid, t]) => { if (db.people[pid] && !db.people[pid].title) { db.people[pid].title = t; db.people[pid].updatedAt = new Date().toISOString(); } });
    writeDb(db);
    return { written, skipped };
  }

  function clearActuals() {
    const db = readDb();
    const had = Object.keys(db.actuals || {}).length;
    db.actuals = {}; delete db.meta.clockifyImportedAt; delete db.meta.clockifyMonths;
    writeDb(db);
    logStaff('staff-actuals-clear', { cleared: had });
  }

  /* ---------- entry-lateness stats (from /api/clockify?lateness=1) ---------- */
  function setLateness(rows) { const db = readDb(); db.lateness = rows; db.meta.latenessAt = new Date().toISOString(); writeDb(db); }
  /** PROFITABILITY MATRIX — the whole revenue projection (same math and
      row set as Revenue Projections) with Clockify burn (hours × cost rate)
      laid against it by month. Fee projects with no hours still show;
      matrix/Clockify projects with hours but no fee link show as $0-revenue
      rows. Ratings 5–7 grey out downstream, like Projections. */
  function profitability(monthsList) {
    const db = readDb(); const inWin = new Set(monthsList);
    const S2 = window.UFC_Store; const cat = (typeof window !== 'undefined') && window.RATES_CATALOG;
    if (!S2 || !cat || !cat.hydrated) return { ok: false, why: 'rates' };
    // ---- burned $ per MATRIX project → resolved onto fee-project ids where linked ----
    const burnByFee = {}; const burnLoose = {}; const noRate = new Set();
    const overhead = { byMonth: {}, hours: 0, cost: 0, ppl: {}, byProj: {} };   // macro / non-billable — real staff cost outside any fee
    /* PTO / vacation / holiday is macro time, but it is NOT discretionary
       overhead the way BD and internal work are — nobody should read a
       colleague's vacation as unproductive cost sitting against the fee book.
       It gets its own bucket so the non-billable line means what it says. */
    const timeOff = { byMonth: {}, hours: 0, cost: 0, ppl: {}, byProj: {} };
    /* Hours we could not price (no cost rate for the person's title). They are
       real effort that is missing from every cost figure below, so carry the
       size of the hole rather than letting margin quietly read as better. */
    const unpriced = { hours: 0, byPerson: {} };
    const addTo = (buck, proj, pid, person, rate, ym, h) => {
      buck.byMonth[ym] = (buck.byMonth[ym] || 0) + h * rate;
      buck.hours += h; buck.cost += h * rate;
      buck.byProj[proj] = (buck.byProj[proj] || 0) + h * rate;
      const op = buck.ppl[pid] || (buck.ppl[pid] = { name: person.name, title: person.title || '', rate, hours: 0, cost: 0, byMonth: {} });
      op.hours += h; op.cost += h * rate;
      const om = op.byMonth[ym] || (op.byMonth[ym] = { hours: 0, cost: 0 });
      om.hours += h; om.cost += h * rate;
    };
    Object.entries(db.actuals || {}).forEach(([k, h]) => {
      const i1 = k.indexOf('|'), i2 = k.lastIndexOf('|');
      const pid = k.slice(0, i1), proj = k.slice(i1 + 1, i2), ym = k.slice(i2 + 1);
      if (!inWin.has(ym)) return;
      const person = db.people[pid];
      const rate = person ? costRateForTitle(person.title) : null;
      if (!rate) {
        const who = person ? (person.name + (person.title ? ' — ' + person.title : ' — no title')) : pid.replace(/^unmatched:/, '');
        noRate.add(who);
        unpriced.hours += h;
        unpriced.byPerson[who] = (unpriced.byPerson[who] || 0) + h;
        return;
      }
      if (isMacroProject(proj)) {
        addTo(isTimeOffProject(proj) ? timeOff : overhead, proj, pid, person, rate, ym, h);
        return;
      }
      const link = matchFeeProject(proj, '');
      const bucket = link ? (burnByFee[link.id] = burnByFee[link.id] || { byMonth: {}, hours: 0, cost: 0, ppl: {}, srcNames: new Set() })
                          : (burnLoose[proj] = burnLoose[proj] || { byMonth: {}, hours: 0, cost: 0, ppl: {}, srcNames: new Set([proj]) });
      if (link) bucket.srcNames.add(proj);
      bucket.byMonth[ym] = (bucket.byMonth[ym] || 0) + h * rate;
      bucket.hours += h; bucket.cost += h * rate;
      const pp = bucket.ppl[pid] || (bucket.ppl[pid] = { name: person.name, title: person.title || '', rate, hours: 0, cost: 0, byMonth: {} });
      pp.hours += h; pp.cost += h * rate;
      const pm = pp.byMonth[ym] || (pp.byMonth[ym] = { hours: 0, cost: 0 });
      pm.hours += h; pm.cost += h * rate;
    });
    // ---- revenue rows: SAME set + math as Revenue Projections ----
    const parents = (S2.listProjects() || []).filter(p => !(S2.isChangeOrder && S2.isChangeOrder(p)));
    const projects = S2.visibleProjects ? S2.visibleProjects(parents) : parents;
    const rows = [];
    const coIndex = S2.approvedChangeOrdersIndex ? S2.approvedChangeOrdersIndex() : null;
    projects.forEach(p => {
      const rating = S2.ratingFor ? S2.ratingFor(p) : 5;
      const revByMonth = {}; let revTotal = 0;
      const add = (ym, amt) => { if (inWin.has(ym)) { revByMonth[ym] = (revByMonth[ym] || 0) + amt; revTotal += amt; } };
      try {
        // One canonical series (store.billingSeries) — the frozen snapshot was
        // being read raw here too, so a slipped or adjusted month showed its
        // old figure against the moved effort.
        (S2.billingSeries(p, cat) || []).forEach(m => add(m.ym, m.invoice));
        (coIndex ? (coIndex[p.id] || []) : (S2.approvedChangeOrders ? S2.approvedChangeOrders(p.id) : [])).forEach(co => {
          try { S2.changeOrderDelta(co).byMonth.forEach(x => add(x.ym, x.net)); } catch (e) {}
        });
      } catch (e) {}
      const b = burnByFee[p.id];
      if (!revTotal && !b) return;                       // nothing in-window on either axis
      rows.push({
        key: 'fee:' + p.id, feeId: p.id, project: (p.project && p.project.name) || p.name || '(unnamed)', client: (p.project && p.project.client) || p.client || '', rating,
        included: rating >= 1 && rating <= 4, booked: rating === 1,
        revByMonth, revTotal: Math.round(revTotal),
        costByMonth: b ? b.byMonth : {}, cost: Math.round(b ? b.cost : 0), hours: b ? Math.round(b.hours * 10) / 10 : 0,
        ppl: b ? Object.values(b.ppl).sort((x, y) => y.cost - x.cost) : [],
        srcNames: b ? [...b.srcNames] : [],
      });
    });
    // ---- hours burning with NO fee link → $0-revenue rows ----
    Object.entries(burnLoose).forEach(([proj, b]) => {
      rows.push({ key: 'loose:' + proj, feeId: null, project: proj, client: '', rating: null, included: false, booked: false, revByMonth: {}, revTotal: 0, costByMonth: b.byMonth, cost: Math.round(b.cost), hours: Math.round(b.hours * 10) / 10, ppl: Object.values(b.ppl).sort((x, y) => y.cost - x.cost), srcNames: [proj], noLink: true });
    });
    rows.sort((a, b) => (a.rating || 9) - (b.rating || 9) || b.revTotal - a.revTotal || b.cost - a.cost);
    overhead.ppl = Object.values(overhead.ppl).sort((x, y) => y.cost - x.cost);
    timeOff.ppl = Object.values(timeOff.ppl).sort((x, y) => y.cost - x.cost);
    unpriced.people = Object.entries(unpriced.byPerson)
      .map(([name, hours]) => ({ name, hours: Math.round(hours * 10) / 10 }))
      .sort((a, b) => b.hours - a.hours);
    unpriced.hours = Math.round(unpriced.hours * 10) / 10;
    return { ok: true, rows, overhead, timeOff, unpriced, noRate: [...noRate], hasActuals: hasActuals() };
  }

  function getLateness() { const db = readDb(); return { rows: db.lateness || [], at: db.meta.latenessAt }; }

  /** TIME-ENTRY COMPLIANCE — who logged how much of the bar that applies to
      THEM, month by month. Shared by the Time Entry tab and its Excel export
      so the two can never diverge.

      Fairness rules baked in (all of them deliberate):
        • the bar is the person's own capacity (part-timers judged against
          their %, never the full-time number); current month is pro-rata
        • months before someone's first-ever logged hour aren't expected
          (new joiners) → cell = null, excluded from the score
        • months on a leave of absence aren't expected → cell = 'leave'
        • people with no hours on record at all can't be measured → they
          come back in `untracked`, not as a 0% row
      opts.clockifyUsers (optional) sharpens the untracked reason text.
      Returns { months, rows, untracked, prorata, nowYm }. */
  function complianceRows(monthsList, opts) {
    opts = opts || {};
    const nowYm = currentYM();
    const ms = (monthsList || []).filter(m => m <= nowYm);
    const now = new Date();
    const prorata = Math.min(1, now.getUTCDate() / 30);
    const db = readDb();
    const perPM = {};
    Object.entries(db.actuals).forEach(([k, h]) => { const [pid, , ym] = k.split('|'); (perPM[pid] = perPM[pid] || {})[ym] = (perPM[pid][ym] || 0) + h; });
    const firstEver = {};
    Object.keys(db.actuals).forEach(k => { const [pid, , ym] = k.split('|'); if (!firstEver[pid] || ym < firstEver[pid]) firstEver[pid] = ym; });
    const onLeave = {};
    leaveStatus().forEach(l => {
      const set = onLeave[l.person.id] || (onLeave[l.person.id] = new Set());
      let m = l.start, guard = 0;
      while (m <= l.end && guard++ < 240) { set.add(m); m = ymAdd(m, 1); }
    });
    const ckUsers = opts.clockifyUsers || [];
    const userMaps = (db.mappings || {}).users || {};
    const hasCkMapping = (person) => !ckUsers.length ? true : ckUsers.some(u => {
      const m = userMaps[u.name.toLowerCase().replace(/\s+/g, ' ').trim()];
      if (m) return m === person.id;
      return namesMatch(person.name, u.name) && !userExcluded(u.name, person.id);
    });

    const rows = [], untracked = [];
    listPeople().forEach(person => {
      if (person.isNewHire) return;
      const logged = perPM[person.id] || {};
      const joined = firstEver[person.id] || null;
      if (!joined) {
        const reason = !ckUsers.length ? 'no hours on record — not started, or not mapped to Clockify'
          : (hasCkMapping(person) ? 'mapped to Clockify, but no hours have arrived yet' : 'no Clockify user mapped');
        untracked.push({ person, reason });
        return;
      }
      const cap = capacityHours(person);
      const leaveMs = onLeave[person.id];
      const byMonth = {}; let expectedMonths = 0, okMonths = 0, totLogged = 0, totCap = 0, leaveMonths = 0;
      ms.forEach(ym => {
        if (ym < joined) { byMonth[ym] = null; return; }
        if (leaveMs && leaveMs.has(ym)) { byMonth[ym] = 'leave'; leaveMonths++; return; }
        const active = personAllocationsIn(person.id, ym).length > 0;
        const h = logged[ym] || 0;
        if (!active && !h) { byMonth[ym] = null; return; }
        const capM = cap * (ym === nowYm ? prorata : 1);
        const pct = capM ? h / capM : 0;
        byMonth[ym] = { h, capM, pct };
        expectedMonths++; totLogged += h; totCap += capM;
        if (pct >= 0.8) okMonths++;
      });
      if (!expectedMonths) { if (leaveMonths) untracked.push({ person, reason: 'on leave for this whole window' }); return; }
      const lastMs = ms.filter(m => byMonth[m] && byMonth[m] !== 'leave').slice(-1)[0];
      const lastPct = lastMs ? byMonth[lastMs].pct : 0;
      rows.push({
        person, byMonth, expectedMonths, okMonths, totLogged, totCap,
        compliance: expectedMonths ? okMonths / expectedMonths : 0,
        lastMs, lastPct, behindHrs: Math.max(0, totCap - totLogged),
        joinedMid: joined > ms[0], joined, leaveMonths,
      });
    });
    rows.sort((a, b) => b.behindHrs - a.behindHrs || a.lastPct - b.lastPct);
    return { months: ms, rows, untracked, prorata, nowYm };
  }

  /** Contract role titles with no allocated person whose title plausibly
      covers them — "who's this project's contract-priced role, unstaffed?"
      Shared by the Insights tab and the By Project view badge. */
  function unassignedRoles(months) {
    const out = [];
    distinctProjects().forEach(pn => {
      if (isLeaveProject(pn)) return;
      const client = (listAllocations().find(a => a.project === pn) || {}).client || '';
      const cp = contractPlan(pn, months, client); if (!cp || !cp.roles.length) return;
      const staffedTitles = [...new Set(listAllocations().filter(a => a.project === pn).map(a => ((getPerson(a.personId) || {}).title || '').trim()))].filter(Boolean);
      const famOf = (t) => { const f = titleFamily(t); return f ? f.titleId : null; };
      const fams = new Set(staffedTitles.map(famOf).filter(Boolean));
      cp.roles.forEach(r => {
        if (r.hours < 20) return;                                  // ignore slivers
        const fam = famOf(r.title);
        const covered = (fam && fams.has(fam)) || staffedTitles.some(t => tokenScore(t, r.title) >= 0.5);
        if (!covered) out.push({ project: pn, role: r.title, hours: r.hours, fte: r.fteMonths });
      });
    });
    return out.sort((a, b) => b.hours - a.hours);
  }

  /** Contract → Allocation bridge: EVERY fee-tool role whose demand the
      staffing matrix hasn't (fully) covered on that project — named or not.
      A named resource diffs against that person's own allocations; an
      unnamed/placeholder role (blank, TBD, [NEW HIRE]) is still open demand,
      diffed against project allocations from people whose TITLE matches the
      role, and the page prompts for a name before anything is created.
      NOTHING is written here — the page shows a preview and the leader
      confirms before any allocation is created.
      Returns [{ project, client, open, roleTitle, resource|null, roles[],
                 person|null, isNew, personId|null, topUp, via,
                 segments:[{start,end,need,want,have}], totalNeedFteMo }] */
  /* ---------- dismissed contract-staffing rows ----------
     Not every named contract role becomes an allocation. A pursuit that never
     closed, a person named in a proposal who was never going to do the work —
     these are noise that used to sit on the list forever with no way to clear
     it. Dismissing is a JUDGEMENT, recorded with who and why, never a delete:
     the row is hidden from the working list and kept in a roll-up so it can
     be reopened. Lives in staff.json, so the whole team sees one decision.

     The key must survive recomputation (rows are rebuilt from scratch every
     call) AND a project rename, so it is built from the CANONICAL project
     name plus either the open role or the contract-named person. */
  function gapKey(row) {
    const db = readDb();
    const ren = (db.mappings || {}).renames || {};
    const canon = ren[nkey(row.project)] || row.project;
    const who = row.open ? 'open:' + String(row.roleTitle || '').toLowerCase()
                         : 'who:' + nkey(canonicalName(row.resource || ''));
    return nkey(canon) + '|' + who;
  }
  function dismissedGaps() { const db = readDb(); return db.dismissedGaps || {}; }
  /** Hide a contract-staffing row from the working list, with a reason. */
  function dismissGap(key, reason) {
    if (!key) return null;
    const db = readDb();
    db.dismissedGaps = db.dismissedGaps || {};
    const S2 = window.UFC_Store;
    let by = '';
    try { by = (S2 && S2.getCurrentUser) ? (S2.getCurrentUser().name || S2.getCurrentUser().username || '') : ''; } catch (e) {}
    db.dismissedGaps[key] = { at: new Date().toISOString(), by, reason: String(reason || '').trim() };
    writeDb(db);
    logStaff('staff-gap-dismiss', { key, reason: db.dismissedGaps[key].reason || 'no reason given' });
    return db.dismissedGaps[key];
  }
  /** Put a dismissed row back on the working list. */
  function restoreGap(key) {
    const db = readDb();
    if (!db.dismissedGaps || !db.dismissedGaps[key]) return false;
    delete db.dismissedGaps[key];
    writeDb(db);
    logStaff('staff-gap-restore', { key });
    return true;
  }
  function contractStaffingGaps() {
    const S2 = window.UFC_Store;
    if (!S2 || !S2.computeMonthsByPhase) return [];
    const db = readDb();
    const nowYm = currentYM();
    const cat = (typeof window !== 'undefined') && window.RATES_CATALOG;
    const out = [];
    const visitedFee = new Set();

    // Project names must be compared through the saved rename table
    // (old sheet name → canonical Clockify name). Otherwise a fee record
    // under the OLD name and allocations under the NEW name never see each
    // other: the gap card keeps resurfacing, confirming it creates a row
    // that merge renames away, and the "phantom" loops forever.
    const ren = (db.mappings || {}).renames || {};
    const canonProjName = (n) => ren[nkey(n)] || n;
    const sameProj = (a, b) => nkey(canonProjName(a)) === nkey(canonProjName(b));

    // Diff ONE matrix project's contract demand (across its linked fee
    // projects) against existing allocations, pushing gap entries into out.
    const collect = (pn, client, links) => {
      // Contract demand per NAMED person, summed across roles and linked fee
      // projects (one person can hold two roles, or appear in two links).
      const byName = {};
      links.forEach(link => {
        const p = feeRecords().find(x => x.id === link.id);
        if (!p || !p.roles || !p.roles.length || !p.timeline) return;
        if (p.project && p.project.status === 'lost') return;   // dead proposals aren't staffing demand
        visitedFee.add(p.id);
        let byPhase; try { byPhase = S2.computeMonthsByPhase(p); } catch (e) { return; }
        const phaseOf = {};
        (p.phases || []).forEach(ph => (byPhase[ph.id] || []).forEach(m => { phaseOf[m.year + '-' + m.month] = ph.id; }));
        const pMonths = S2.enumerateMonths(p.timeline);
        p.roles.forEach(r => {
          // Blank, TBD and [NEW HIRE] resources aren't people — but the role
          // is still open demand: track it per role TITLE, to be named later.
          const nm = cleanName(r.resource || '');
          const isOpen = !nm || /^tbd\b/i.test(nm) || isNewHireName(r.resource);
          const t = cat && cat.titles && cat.titles.find(x => x.id === r.titleId);
          const roleLabel = (r.projectRole || '').trim() || (t && (t.name || t.label)) || 'Role';
          const key = isOpen ? ' open:' + roleLabel.toLowerCase() : nm.toLowerCase();
          const e = byName[key] || (byName[key] = { name: isOpen ? null : nm, open: isOpen, roleLabel, want: {}, roles: new Set(), via: link.via });
          e.roles.add(roleLabel);
          pMonths.forEach(m => {
            const ym = m.year + '-' + String(m.month).padStart(2, '0');
            const mk = m.year + '-' + m.month;                 // fee-tool keys are non-padded
            const fte = (r.fteMonthly && r.fteMonthly[mk] != null) ? r.fteMonthly[mk] : ((r.fte && r.fte[phaseOf[mk]]) || 0);
            if (fte) e.want[ym] = (e.want[ym] || 0) + fte;
          });
        });
      });
      Object.values(byName).forEach(e => {
        let person = null, existing = [];
        if (e.open) {
          // Open role: coverage = this project's allocations from people whose
          // TITLE matches the role (same heuristic as unassignedRoles), so a
          // PM already staffed against an open PM slot isn't double-demanded.
          const rf = titleFamily(e.roleLabel);
          const covers = (pt) => { if (!pt) return false; const f = titleFamily(pt); return (f && rf && f.titleId === rf.titleId) || tokenScore(pt, e.roleLabel) >= 0.5; };
          const roleKey = String(e.roleLabel).toLowerCase();
          existing = db.allocations.filter(a => sameProj(a.project, pn) && (
            // an allocation created FOR this open role always counts, whatever
            // the assignee's title says — otherwise confirming never clears it
            String(a.contractRole || '').toLowerCase() === roleKey ||
            covers(((db.people[a.personId] || {}).title || '').trim())
          ));
        } else {
          person = personForContractName(e.name);   // saved alias first, then tolerant match
          // The name may match SEVERAL roster records (duplicate people are a
          // real condition) — coverage must count rows from ALL of them, or a
          // fully-staffed person "reports unstaffed" because the lookup picked
          // the duplicate that holds no rows. Anchor the entry on whichever
          // record actually has allocations on this project.
          const matches = Object.values(db.people).filter(pp => namesMatch(pp.name, e.name));
          if (person && !matches.some(m => m.id === person.id)) matches.push(person);
          const matchIds = new Set(matches.map(m => m.id));
          const nameKey = nkey(canonicalName(e.name));
          existing = db.allocations.filter(a => sameProj(a.project, pn) && (
            matchIds.has(a.personId) ||
            // allocation created FOR this contract name (leader mapped it to
            // someone else) counts even before/without a saved alias
            nkey(canonicalName(a.contractResource || '')) === nameKey
          ));
          const onProj = matches.find(m => db.allocations.some(a => a.personId === m.id && sameProj(a.project, pn)));
          if (onProj) person = onProj;
        }
        const covAt = (ym) => existing.reduce((s, a) => s + (allocActiveIn(a, ym) ? (a.pct || 0) : 0), 0);
        // Month-by-month shortfall (contract minus what's already allocated),
        // compressed into consecutive equal-% segments — Option A: one
        // proposed allocation per distinct FTE window, faithful to the phases.
        const segs = []; let cur = null;
        Object.keys(e.want).sort().forEach(ym => {
          const want = Math.round(e.want[ym]);
          const have = Math.round(covAt(ym));
          const need = Math.max(0, want - have);
          if (!need) { cur = null; return; }
          if (cur && cur.need === need && ymAdd(cur.end, 1) === ym) { cur.end = ym; }
          else { cur = { start: ym, end: ym, need, want, have }; segs.push(cur); }
        });
        // Segments that ended before this month are history, not a staffing action.
        const future = segs.filter(sg => sg.end >= nowYm);
        if (!future.length) return;
        /* Judgement context, so "is this real?" can be answered on the row.
           A rating-6 pursuit naming someone is not a staffing decision; a
           rated-1 booked project is. The revenue leader is who to ask. */
        let rating = null, lead = '';
        try {
          const lp = links.map(l => feeRecords().find(x => x.id === l.id)).filter(Boolean)
            .sort((a, b) => (S2.ratingFor ? S2.ratingFor(a) : 9) - (S2.ratingFor ? S2.ratingFor(b) : 9))[0];
          if (lp) {
            rating = S2.ratingFor ? S2.ratingFor(lp) : null;
            const pj = lp.project || {};
            lead = (S2.leaderDisplay ? S2.leaderDisplay(pj.leadId || pj.lead) : (pj.lead || '')) || '';
          }
        } catch (err) {}
        const row = {
          project: pn, client,
          open: !!e.open, roleTitle: e.roleLabel || [...e.roles][0] || 'Role',
          resource: e.name, roles: [...e.roles],
          person, isNew: e.open ? false : !person,
          personId: e.open ? null : (person ? person.id : personIdForName(e.name)),
          topUp: existing.length > 0,
          via: e.via,
          rating, lead,
          segments: future,
          totalNeedFteMo: Math.round(future.reduce((s, sg) => s + sg.need * monthsBetween(sg.start, sg.end).length, 0)) / 100,
        };
        row.key = gapKey(row);
        row.dismissed = dismissedGaps()[row.key] || null;
        out.push(row);
      });
    };

    // 1) Matrix projects with allocations — diff against their linked fee
    // projects. Grouped by CANONICAL name so a project living under two
    // names (stale rows + renamed rows) is one project: links from every
    // spelling are unioned and the gap is anchored on the canonical name.
    const byCanon = {};
    distinctProjects().forEach(pn0 => {
      const pn = canonProjName(pn0);
      if (isLeaveProject(pn)) return;             // leaves aren't contract demand
      const ck = nkey(pn);
      (byCanon[ck] = byCanon[ck] || { pn, names: [] }).names.push(pn0);
    });
    Object.values(byCanon).forEach(({ pn, names }) => {
      const client = (db.allocations.find(a => names.includes(a.project)) || {}).client || '';
      const links = [], seenL = new Set();
      const lookups = names.includes(pn) ? names : names.concat([pn]);
      lookups.forEach(n => matchFeeProjects(n, client).forEach(l => { if (!seenL.has(l.id)) { seenL.add(l.id); links.push(l); } }));
      if (links.length) collect(pn, client, links);
    });

    // 2) SIGNED fee projects no matrix project links to — the most
    // under-staffed case of all: the contract exists and nobody is on it.
    // BUT: if the fee record's name closely matches an EXISTING matrix
    // project, this is most likely a DUPLICATE fee record for work the
    // matrix already tracks (hand-built copy + imported copy). Diff its
    // demand against THAT matrix project's real allocations instead of
    // inventing a parallel project name — fully-covered entries vanish,
    // under-covered ones surface flagged as a possible duplicate record.
    feeRecords().forEach(p => {
      if (visitedFee.has(p.id)) return;
      const st = (p.project && p.project.status) || '';
      if (st !== 'won' && st !== 'active') return;              // unsigned work doesn't demand staffing
      if (!p.roles || !p.roles.length || !p.timeline) return;
      const rawName = (p.project && p.project.name || '').trim();
      if (!rawName) return;
      // The fee record may carry a pre-rename spelling ("EM NALI") of a
      // project the matrix tracks canonically ("Exxon NALI") — resolve it
      // through the rename table first so demand lands on the real project.
      const name = canonProjName(rawName);
      let pn = name, client = (p.project && p.project.client) || '', dupNote = null;
      const mk = projKey(name);
      let best = null, bestScore = 0;
      distinctProjects().forEach(mp0 => {
        const mp = canonProjName(mp0);
        if (isLeaveProject(mp)) return;           // never near-match a fee record onto the leave bucket
        const k2 = projKey(mp);
        let s = 0;
        if (k2 && k2 === mk) s = 1;
        else if (k2 && (k2.includes(mk) || mk.includes(k2))) s = 0.9;
        else s = tokenScore(mp, name);
        if (s > bestScore) { bestScore = s; best = mp; }
      });
      if (best && bestScore >= 0.7 && !codesConflict(best, name)) {
        pn = best;
        client = (db.allocations.find(a => sameProj(a.project, best)) || {}).client || client;
        // A saved rename is a KNOWN alias, not a suspected duplicate record —
        // only flag when fuzzy matching (not the rename table) made the leap.
        if (nkey(name) === nkey(rawName) && nkey(best) !== nkey(rawName)) dupNote = rawName;
      }
      collect(pn, client, [{ id: p.id, via: 'direct' }]);
      if (dupNote) out.forEach(g => { if (g.project === pn && g.via === 'direct' && !g.possibleDupFee) g.possibleDupFee = dupNote; });
    });

    return out.sort((a, b) => b.totalNeedFteMo - a.totalNeedFteMo);
  }

  /* ===== Schedule shifts — carrying the PEOPLE with the contract =====
     When Reconciliation slips a project, shiftSchedule moves the contract
     staffing (fteMonthly) and stamps `staffingShiftPending` on the project.
     This store holds the NAMED-people allocations, so they don't move by
     themselves — these three close that loop: list what's waiting, find the
     rows, move them. The Staffing page surfaces it as a one-click banner. */

  /** Every allocation row whose matrix project resolves to this fee project
      (through the saved fee-link first, fuzzy match otherwise). */
  function allocationsForFeeProject(feeProjectId) {
    const byProject = {};   // resolve each distinct matrix name once
    return listAllocations().filter(a => {
      if (!a.project) return false;
      const k = nkey(a.project);
      if (byProject[k] === undefined)
        byProject[k] = matchFeeProjects(a.project, a.client).some(l => l.id === feeProjectId);
      return byProject[k];
    });
  }

  /** Shift every allocation on a fee project by N months (start and end move
      together, so row lengths are preserved). Returns how many rows moved. */
  function shiftAllocationsForFeeProject(feeProjectId, months) {
    const n = parseInt(months, 10);
    if (!n) return 0;
    const rows = allocationsForFeeProject(feeProjectId);
    rows.forEach(a => {
      if (a.start) a.start = ymAdd(a.start, n);
      if (a.end) a.end = ymAdd(a.end, n);
      saveAllocation(a);
    });
    return rows.length;
  }

  /** Projects whose schedule moved but whose people allocations haven't —
      the Staffing page's worklist. */
  function pendingContractShifts() {
    try {
      const S2 = window.UFC_Store;
      if (!S2 || !S2.listProjects) return [];
      return S2.listProjects().filter(p => p.staffingShiftPending).map(p => ({
        id: p.id,
        name: (p.project && p.project.name) || 'Untitled',
        months: +p.staffingShiftPending.months || 0,
        at: p.staffingShiftPending.at || '',
        by: p.staffingShiftPending.by || '',
        allocations: allocationsForFeeProject(p.id).length,
      }));
    } catch (e) { return []; }
  }

  /** REVERSE bridge: fee projects with an EMPTY roster whose linked matrix
      project already carries allocations — propose seeding the fee-tool
      roster FROM the matrix. Booked (won/active) and pipeline statuses both
      qualify ("if we have it"); only lost/closed are excluded. Proposed
      roles are month-faithful (fteMonthly), clipped to the fee timeline,
      and meant to be written at a $0 contracted rate so no project's
      revenue moves until a leader prices the roster in reconciliation.
      Read-only — the page previews and the leader confirms per project. */
  function matrixSeedCandidates() {
    const S2 = window.UFC_Store;
    if (!S2 || !S2.enumerateMonths) return [];
    const db = readDb();
    // reverse index: fee project id → matrix project names linked to it
    const revLinks = {};
    const linkCount = {};   // matrix project → how many fee projects it links to
    distinctProjects().forEach(pn => {
      if (isLeaveProject(pn)) return;             // the leave bucket never seeds a fee roster
      const client = (db.allocations.find(a => a.project === pn) || {}).client || '';
      const links = matchFeeProjects(pn, client);
      linkCount[pn] = links.length;
      links.forEach(l => { (revLinks[l.id] = revLinks[l.id] || []).push(pn); });
    });
    const out = [];
    feeRecords().forEach(p => {
      if (p.roles && p.roles.length) return;                 // never touch an existing roster
      const st = (p.project && p.project.status) || '';
      if (((window.UFC_Store && window.UFC_Store.ENDED_STATUSES) || new Set(['lost', 'closed'])).has(st)) return;
      if (!p.timeline) return;
      const matrixNames = revLinks[p.id] || [];
      if (!matrixNames.length) return;
      // A matrix project pinned to SEVERAL fee projects would seed the SAME
      // allocations into each one, multiplying apparent contract demand.
      // Skip — splitting that roster across contracts is a human decision.
      if (matrixNames.some(n => (linkCount[n] || 0) > 1)) return;
      const allocs = db.allocations.filter(a => matrixNames.includes(a.project));
      if (!allocs.length) return;
      let months;
      try { months = S2.enumerateMonths(p.timeline).map(m => ({ ym: m.year + '-' + String(m.month).padStart(2, '0'), mk: m.year + '-' + m.month })); } catch (e) { return; }
      if (!months.length) return;
      const inWin = new Set(months.map(m => m.ym));
      const byPerson = {};
      allocs.forEach(a => {
        const per = db.people[a.personId] || { id: a.personId, name: a.personId, title: '' };
        const e = byPerson[per.id] || (byPerson[per.id] = { person: per, allocs: [], pursuit: false });
        e.allocs.push(a);
        if (a.status === 'Pursuit' || a.type === 'Opportunity') e.pursuit = true;
      });
      let clippedMonths = 0;
      const roles = Object.values(byPerson).map(e => {
        const fteMonthly = {};                               // fee-tool keys are non-padded
        let tot = 0, activeMonths = 0;
        months.forEach(({ ym, mk }) => {
          const pct = e.allocs.reduce((s, a) => s + (allocActiveIn(a, ym) ? (a.pct || 0) : 0), 0);
          // EXPLICIT zero for inactive months — a missing key falls back to
          // the phase-average in the calculator, painting phantom % into
          // months the person was never allocated.
          fteMonthly[mk] = pct;
          if (pct) { tot += pct; activeMonths++; }
        });
        e.allocs.forEach(a => { if (a.start && a.end) monthsBetween(a.start, a.end).forEach(ym => { if (!inWin.has(ym)) clippedMonths++; }); });
        if (!activeMonths) return null;
        const fam = titleFamily((e.person.title || '').trim());
        return {
          person: e.person, pursuit: e.pursuit,
          fteMonthly, avgPct: Math.round(tot / activeMonths), activeMonths,
          titleId: fam ? fam.titleId : '', tierId: fam ? fam.tierId : 'mid',
          titleMapped: !!fam,
        };
      }).filter(Boolean);
      if (!roles.length) return;
      out.push({
        feeId: p.id, name: (p.project && p.project.name) || '', client: (p.project && p.project.client) || '',
        status: st, booked: st === 'won' || st === 'active',
        updatedAt: p.updatedAt || '',
        matrixNames, roles, clippedMonths,
        totalFteMo: Math.round(roles.reduce((s, r) => s + Object.values(r.fteMonthly).reduce((x, v) => x + v, 0), 0)) / 100,
        anyPursuit: roles.some(r => r.pursuit),
      });
    });
    return out.sort((a, b) => (b.booked ? 1 : 0) - (a.booked ? 1 : 0) || b.totalFteMo - a.totalFteMo);
  }

  /** Bandwidth freeing up over the next 3 months, per person — the biggest
      drop below the 100% line and when it lands. Always looks forward from
      "now", independent of whatever window the page happens to be showing. */
  function comingAvailable(opts) {
    const o = opts || {};
    /* PURSUITS ARE OUT by default. This report exists to start "who can take
       new work" conversations, and unwon pursuit load makes people look busy
       who are not actually committed. Callers must opt in explicitly. */
    const gridOpts = Object.assign({}, o, { includePursuit: !!o.includePursuit });
    /* The threshold is on capacity freed BELOW the 100% line, not on the raw
       drop. Someone at 315% falling to 90% sheds 225 points on paper but only
       frees 10 points of real capacity — they were over-committed, not
       available. Reading the raw drop is what put a 315%-allocated person at
       the top of a "coming available" list. */
    const minFreedPct = o.minFreedPct == null ? 25 : o.minFreedPct;
    const nowYm = currentYM();
    const nextMs = []; { let [fy, fm] = nowYm.split('-').map(Number); for (let i = 0; i < 4; i++) { nextMs.push(fy + '-' + String(fm).padStart(2, '0')); fm++; if (fm > 12) { fm = 1; fy++; } } }
    return bandwidthGrid(nextMs, gridOpts).filter(r => !(r.person && r.person.nonBillable)).map(r => {
      const cur = r.byMonth[nextMs[0]] || 0;
      const capped = Math.min(cur, 100);
      let best = null;
      nextMs.slice(1).forEach(m => {
        const v = r.byMonth[m] || 0;
        if (v < 100 && (capped - v) >= minFreedPct && (!best || v < best.v)) best = { m, v };
      });
      if (!best) return null;
      const freedPct = capped - best.v;
      const freedH = Math.round(freedPct / 100 * capacityHours(r.person));
      return freedH > 0 ? { person: r.person, cur, to: best.v, m: best.m, freedH, freedPct,
                            stillLoaded: cur > 100 } : null;
    }).filter(Boolean)
      /* Sorted by how AVAILABLE they end up — the person dropping to 20% is a
         better answer to "who can take this?" than one dropping to 95% who
         happens to have more raw hours. Hours freed breaks ties. */
      .sort((a, b) => a.to - b.to || b.freedH - a.freedH);
  }

  /** People with meaningfully large non-client ("macro") time in the window —
      the >40h leadership threshold. Dedicated BOH staff (≥90% internal) are
      split out separately since that's expected, not a flag. */
  function substantialMacroTime(months) {
    const all = (hasActuals() && macroHours) ? macroHours(months) : [];
    // People explicitly MARKED non-billable (Mapping tab) are pure overhead:
    // heavy internal time is their job, not a flag. They surface in their own
    // strip instead of the table — visible, never alarming.
    const isNB = (r) => !!(r.person && r.person.nonBillable);
    return {
      overhead: all.filter(r => isNB(r) && r.hours > 40),
      boh: all.filter(r => !isNB(r) && r.pct >= 0.9 && r.hours > 40),
      flagged: all.filter(r => !isNB(r) && r.pct < 0.9 && r.hours > 40),
    };
  }

  /** Apply Clockify job titles to the roster (Clockify is the source of truth
      for titles). users: [{name, title}] from /api/clockify?list=users&titles=1.
      Uses saved people-mappings first, then tolerant name match. */
  function applyClockifyTitles(users) {
    const db = readDb(); const maps = (db.mappings && db.mappings.users) || {};
    let set = 0;
    (users || []).forEach(u => {
      const t = (u.title || '').trim(); if (!t) return;
      let person = null;
      const mapped = maps[nkey(u.name)];
      if (mapped && db.people[mapped]) person = db.people[mapped];
      if (!person) person = Object.values(db.people).find(p => namesMatch(p.name, u.name));
      if (person && person.title !== t) { person.title = t; person.updatedAt = new Date().toISOString(); set++; }
    });
    if (set) { writeDb(db); logStaff('staff-titles', { titles: set }); }
    return set;
  }

  /* ---------- dollars: internal cost rates by title ----------
     A person's job title (captured from Clockify) maps to a rate family + tier
     via the catalog's staff-title map; the tier's costFloor is the internal
     cost rate. Rates exist only post-login (rates.json), never stored here. */
  function titleFamily(title) {
    const cat = (typeof window !== 'undefined') && window.RATES_CATALOG;
    if (!cat || !title) return null;
    const t = String(title).trim().toLowerCase(); if (!t) return null;
    // saved manual mapping (Mapping tab) wins — shared via staff.json
    const db = readDb();
    const saved = db.mappings && db.mappings.titles && db.mappings.titles[t];
    if (saved) return { titleId: saved.titleId, tierId: saved.tierId };
    const map = cat.staffTitleMap || [];
    let hit = map.find(m => m.staffTitle.toLowerCase() === t);
    if (!hit) hit = map.find(m => t.includes(m.staffTitle.toLowerCase()));
    if (!hit) hit = map.find(m => m.staffTitle.toLowerCase().includes(t));
    if (hit) return { titleId: hit.titleId, tierId: hit.tierId };
    const byName = (cat.titles || []).find(x => (x.name || '').toLowerCase() === t);
    return byName ? { titleId: byName.id, tierId: 'mid' } : null;
  }
  function costRateForTitle(title) {
    const cat = (typeof window !== 'undefined') && window.RATES_CATALOG;
    if (!cat || !cat.hydrated) return null;
    const fam = titleFamily(title); if (!fam) return null;
    const fx = (cat.titles || []).find(x => x.id === fam.titleId); if (!fx) return null;
    const tier = (fx.tiers || []).find(t => t.id === fam.tierId) || (fx.tiers || [])[1];
    return (tier && tier.costFloor) || null;
  }
  function personCostRate(person) { return person ? costRateForTitle(person.title) : null; }

  /* ---------- macro / non-client time ----------
     "PPM", "Macro" — General Non-Billable Work, Business Development: hours
     worked that are not attributed to a client. */
  const MACRO_RX = /\bmacro\b|non-?billable|business\s*development|^\s*ppm\b/i;
  function isMacroProject(name) { return MACRO_RX.test(String(name || '')); }
  /** PTO/vacation/holiday time — a distinct slice of "macro" worth breaking
      out on its own (e.g. "Macro- Time Off"), rather than blending into
      general non-billable/overhead time. */
  const TIMEOFF_RX = /time\s*-?\s*off|\bpto\b|\bvacation\b|\bholiday\b/i;
  function isTimeOffProject(name) { return TIMEOFF_RX.test(String(name || '')); }

  /* ---------- leaves of absence ----------
     A leave is logged as an ordinary allocation to a special "Leaves of
     Absence" project (typically 100%), so it consumes capacity like any
     commitment: load charts show the person as unavailable, and other
     rows on them correctly flag over-allocation. These helpers recognize
     the special project and report timing so the pages can style leave
     rows distinctly and flag returns 1–2 months out. */
  function isLeaveProject(name) {
    const k = nkey(name);
    return k === 'loa' || (k.includes('leave') && k.includes('absence'));
  }
  /** Every leave row, classified against the current month:
      out (on leave now) · upcoming (starts later) · past (already back).
      monthsToReturn/monthsToStart are whole months, 0 = this month. */
  function leaveStatus() {
    const db = readDb();
    const now = currentYM();
    const diff = (a, b) => { const [ay, am] = a.split('-').map(Number), [by, bm] = b.split('-').map(Number); return (ay - by) * 12 + (am - bm); };
    const out = [];
    db.allocations.forEach(a => {
      if (!isLeaveProject(a.project)) return;
      const person = db.people[a.personId] || { id: a.personId, name: a.personId };
      const start = a.start || now, end = a.end || start;
      const status = now < start ? 'upcoming' : (now > end ? 'past' : 'out');
      out.push({
        alloc: a, person, start, end, status,
        monthsToStart: status === 'upcoming' ? diff(start, now) : 0,
        monthsToReturn: status === 'past' ? 0 : Math.max(0, diff(end, now) + 1),
        returningSoon: status === 'out' && diff(end, now) <= 2,   // Jeff: heads-up 1–2 months before return
        startingSoon: status === 'upcoming' && diff(start, now) <= 2,
      });
    });
    return out.sort((a, b) => a.end.localeCompare(b.end) || a.person.name.localeCompare(b.person.name));
  }
  function macroHours(monthsList) {
    const db = readDb(); const inWin = new Set(monthsList); const per = {};
    Object.entries(db.actuals || {}).forEach(([k, h]) => {
      const i1 = k.indexOf('|'), i2 = k.lastIndexOf('|');
      const pid = k.slice(0, i1), proj = k.slice(i1 + 1, i2), ym = k.slice(i2 + 1);
      if (!inWin.has(ym)) return;
      const rec = per[pid] || (per[pid] = { person: db.people[pid] || { id: pid, name: pid.replace(/^unmatched:/, '') }, hours: 0, total: 0, ptoHours: 0, byProj: {} });
      rec.total += h;
      if (!isMacroProject(proj)) return;
      /* Time off is macro time but nobody should be flagged for taking it.
         `hours` counts WORK-type macro only (BD, internal, admin); PTO is
         tallied beside it so the detail still reconciles to the total. */
      if (isTimeOffProject(proj)) { rec.ptoHours += h; rec.byProj[proj] = (rec.byProj[proj] || 0) + h; return; }
      rec.hours += h; rec.byProj[proj] = (rec.byProj[proj] || 0) + h;
    });
    return Object.values(per).filter(r => r.hours > 0 || r.ptoHours > 0)
      .map(r => ({ ...r, pct: r.total ? r.hours / r.total : 0, ptoPct: r.total ? r.ptoHours / r.total : 0 }))
      .sort((a, b) => b.hours - a.hours);
  }

  /* ---------- saved Clockify → roster mappings (map once, keeps forever;
     lives in staff.json so the whole team shares it) ---------- */
  function getMappings() { const db = readDb(); return db.mappings || { users: {}, projects: {} }; }
  /** Pin a roster/Clockify job title to a rate-grid family + tier. Shared via
      staff.json. Pass null titleId to unpin. */
  function setTitleMapping(title, titleId, tierId) {
    const db = readDb(); db.mappings = db.mappings || { users: {}, projects: {} };
    db.mappings.titles = db.mappings.titles || {};
    const k = String(title || '').trim().toLowerCase(); if (!k) return;
    if (titleId) db.mappings.titles[k] = { titleId, tierId: tierId || 'mid' };
    else delete db.mappings.titles[k];
    writeDb(db);
    // Mappings decide how a name resolves — a wrong one silently moves hours
    // and cost onto the wrong person or project, so who set it matters.
    logStaff('staff-map', { kind: 'title', key: title, to: titleId ? titleId + ' / ' + (tierId || 'mid') : null });
  }

  function setUserMapping(clockifyName, personId) {
    const db = readDb(); db.mappings = db.mappings || { users: {}, projects: {} };
    const was = db.mappings.users[nkey(clockifyName)] || null;
    if (personId) db.mappings.users[nkey(clockifyName)] = personId; else delete db.mappings.users[nkey(clockifyName)];
    writeDb(db);
    logStaff('staff-map', { kind: 'person', key: clockifyName,
      from: was && (db.people[was] || {}).name || was, to: personId && (db.people[personId] || {}).name || personId });
  }
  /** Explicit "this Clockify user is NOT this person" — blocks the fuzzy match. */
  function setUserExclusion(clockifyName, personId, on) {
    const db = readDb(); db.mappings = db.mappings || { users: {}, projects: {} };
    db.mappings.userX = db.mappings.userX || {};
    const k = nkey(clockifyName);
    const list = db.mappings.userX[k] || [];
    db.mappings.userX[k] = on ? [...new Set([...list, personId])] : list.filter(x => x !== personId);
    if (!db.mappings.userX[k].length) delete db.mappings.userX[k];
    writeDb(db);
    logStaff('staff-map', { kind: 'person-exclusion', key: clockifyName,
      to: ((db.people[personId] || {}).name || personId) + (on ? ' — blocked' : ' — unblocked') });
  }
  function userExcluded(clockifyName, personId) {
    const x = (readDb().mappings || {}).userX || {};
    return (x[nkey(clockifyName)] || []).includes(personId);
  }
  function setProjectMapping(clockifyName, matrixProject) {
    const db = readDb(); db.mappings = db.mappings || { users: {}, projects: {} };
    if (matrixProject) db.mappings.projects[nkey(clockifyName)] = matrixProject; else delete db.mappings.projects[nkey(clockifyName)];
    // migrate actuals already committed under the Clockify-side name so plan and
    // actual land on ONE row immediately (no re-import needed). '__ignore__'
    // drops those hours.
    if (matrixProject) {
      Object.keys(db.actuals).forEach(k => {
        const parts = k.split('|');
        if (nkey(parts[1]) !== nkey(clockifyName) || parts[1] === matrixProject) return;
        if (matrixProject === '__ignore__') { delete db.actuals[k]; return; }
        const nk2 = parts[0] + '|' + matrixProject + '|' + parts[2];
        db.actuals[nk2] = Math.round(((db.actuals[nk2] || 0) + db.actuals[k]) * 10) / 10;
        delete db.actuals[k];
      });
    }
    writeDb(db);
    logStaff('staff-map', { kind: 'project', key: clockifyName,
      to: matrixProject === '__ignore__' ? 'ignored — hours dropped' : (matrixProject || null) });
  }
  /** Manual matrix-project → fee-tool-project link(s), shared via staff.json.
      A matrix project can be pinned to SEVERAL fee projects (their figures
      then sum in contractPlan) — stored as an array under the hood, but
      legacy single-string mappings from before multi-link still read fine.
      setFeeMapping(mp, id)                  → add id to the set
      setFeeMapping(mp, id, { remove: true }) → remove just that id
      setFeeMapping(mp, null)                → clear the whole set (revert to auto-match) */
  /* ---------- freeze auto-matched fee links before a rename ----------
     A matrix/Clockify project is joined to its fee record either by an
     explicit pin (stored as the fee project's ID, rename-proof) or by an
     automatic NAME match. Renaming the fee project silently breaks every
     automatic link pointing at it: the hours stop landing against that
     project and reappear as $0-revenue "loose" rows on Profitability, with
     nothing anywhere saying why.

     Call this with the fee project's id BEFORE its name changes. Every
     matrix project that currently auto-resolves to it is written down as an
     explicit pin, so the link survives the rename. Returns the names pinned,
     so a caller can report them.

     Deliberately does NOT touch matrix projects that already carry an
     explicit mapping — those are somebody's decision and are already safe. */
  function pinAutoLinksFor(feeProjectId) {
    if (!feeProjectId) return [];
    const db = readDb();
    const feeMap = (db.mappings || {}).fee || {};
    const pinned = [];
    distinctProjects().forEach(pn => {
      if (feeMap[nkey(pn)]) return;                       // already explicit
      let hit = null;
      try { hit = matchFeeProject(pn, ''); } catch (e) { return; }
      if (!hit || hit.id !== feeProjectId) return;
      if (hit.via === 'mapped') return;                   // belt and braces
      setFeeMapping(pn, feeProjectId);
      pinned.push(pn);
    });
    return pinned;
  }

  function setFeeMapping(matrixProject, feeProjectId, opts) {
    const db = readDb(); db.mappings = db.mappings || { users: {}, projects: {} };
    db.mappings.fee = db.mappings.fee || {};
    const key = nkey(matrixProject);
    if (!feeProjectId) {
      delete db.mappings.fee[key]; writeDb(db);
      logStaff('staff-map', { kind: 'fee link', key: matrixProject, to: null });
      return;
    }
    let arr = db.mappings.fee[key];
    arr = Array.isArray(arr) ? arr.slice() : (arr ? [arr] : []);
    if (opts && opts.remove) {
      arr = arr.filter(id => id !== feeProjectId);
      if (arr.length) db.mappings.fee[key] = arr; else delete db.mappings.fee[key];
    } else {
      if (!arr.includes(feeProjectId)) arr.push(feeProjectId);
      db.mappings.fee[key] = arr;
    }
    writeDb(db);
    logStaff('staff-map', { kind: 'fee link', key: matrixProject,
      to: (opts && opts.remove) ? 'unlinked' : 'linked' }, feeProjectId);
  }

  /** Persistent contract-name → roster-person link, shared via staff.json.
      Covers nicknames and spelling drift ("Anastasia Long" ↔ "Tasia Long"):
      once a leader maps a contract name onto an existing person, every
      future contract using that name resolves to them automatically. */
  function setPersonAlias(contractName, personId) {
    const k = nkey(cleanName(contractName)); if (!k || !personId) return;
    const db = readDb(); db.mappings = db.mappings || { users: {}, projects: {} };
    db.mappings.personAliases = db.mappings.personAliases || {};
    db.mappings.personAliases[k] = personId;
    writeDb(db);
    logStaff('staff-map', { kind: 'contract-name alias', key: contractName,
      to: (db.people[personId] || {}).name || personId });
  }
  function personForContractName(name) {
    const db = readDb();
    const aliasId = ((db.mappings || {}).personAliases || {})[nkey(canonicalName(name))];
    if (aliasId && db.people[aliasId]) return db.people[aliasId];
    return Object.values(db.people).find(pp => namesMatch(pp.name, name)) || null;
  }

  /* ---------- canonical name sync (Clockify project list → matrix renames) ----------
     One-time comparative match; the rename table (old JS-sheet name → canonical
     Clockify name) persists in mappings.renames so future sheet re-imports
     auto-rename on the way in. */
  /** Propose matches: for each matrix project, the best Clockify candidate.
      canon = [{name, client}] parsed from the project-list CSV. */
  function proposeCanonical(canonRows) {
    const canon = canonRows.filter(c => c.name);
    const renames = ((readDb().mappings || {}).renames) || {};
    return distinctProjects().map(mp => {
      const already = canon.find(c => nkey(c.name) === nkey(mp));
      if (already) return { matrix: mp, match: already.name, client: already.client, score: 100, kind: 'exact' };
      const saved = renames[nkey(mp)];
      if (saved) return { matrix: mp, match: saved, client: '', score: 100, kind: 'saved' };
      let best = null, bestScore = 0;
      canon.forEach(c => { const s = tokenScore(mp, c.name); if (s > bestScore) { bestScore = s; best = c; } });
      if (best && bestScore >= 0.55) return { matrix: mp, match: best.name, client: best.client, score: Math.round(bestScore * 100), kind: bestScore >= 0.8 ? 'strong' : 'weak' };
      return { matrix: mp, match: null, client: '', score: 0, kind: 'none' };
    });
  }
  /** Commit renames: [{from, to}] — rewrites allocation project names AND actuals
      keys, saves the rename table for future imports. */
  function commitRenames(pairs) {
    const db = readDb();
    db.mappings = db.mappings || { users: {}, projects: {} };
    db.mappings.renames = db.mappings.renames || {};
    let n = 0;
    pairs.forEach(({ from, to }) => {
      if (!from || !to || from === to) return;
      db.allocations.forEach(a => { if (a.project === from) { a.project = to; n++; } });
      Object.keys(db.actuals).forEach(k => { const parts = k.split('|'); if (parts[1] === from) { const nk2 = parts[0] + '|' + to + '|' + parts[2]; db.actuals[nk2] = (db.actuals[nk2] || 0) + db.actuals[k]; delete db.actuals[k]; } });
      db.mappings.renames[nkey(from)] = to;
      // keep any fee link pointing at the old name
      if (db.mappings.fee && db.mappings.fee[nkey(from)]) { db.mappings.fee[nkey(to)] = db.mappings.fee[nkey(from)]; delete db.mappings.fee[nkey(from)]; }
      // and every Clockify → matrix mapping that pointed at it, or the next
      // import lands under the old name and splits coverage across two rows
      Object.keys(db.mappings.projects || {}).forEach(k => { if (db.mappings.projects[k] === from) db.mappings.projects[k] = to; });
    });
    db.meta.canonSyncedAt = new Date().toISOString();
    writeDb(db);
    if (n) logStaff('staff-rename', { rows: n,
      pairs: pairs.filter(p => p && p.from && p.to && p.from !== p.to)
        .map(p => p.from + ' → ' + p.to).slice(0, 12).join('; ') });
    return n;
  }

  // ---------- Matrix ingest — JS's staffing sheet (xlsx or csv), repeatable ----------
  function excelSerialToYm(n) { const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }
  function anyToYm(v) {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    if (/^\d{4,6}(\.\d+)?$/.test(s)) { const n = +s; if (n > 20000 && n < 80000) return excelSerialToYm(n); }  // Excel serial
    return toYm(s, null);
  }
  const MATRIX_HEADS = {
    proj: ['projectname', 'project'], status: ['status'], type: ['type'],
    client: ['clientname', 'client'], person: ['personallocated', 'person', 'name', 'resource'],
    start: ['allocationstartdate', 'startdate', 'start'], end: ['allocationenddate', 'enddate', 'end'],
    pct: ['allocation', 'allocationpct', 'pct', 'percent'], note: ['comments', 'comment', 'notes', 'note'],
  };
  function mapMatrixHeader(cells) {
    const norm = cells.map(h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
    const col = {};
    Object.keys(MATRIX_HEADS).forEach(k => {
      for (const cand of MATRIX_HEADS[k]) { const i = norm.findIndex(h => h === cand || (cand.length > 4 && h.startsWith(cand))); if (i >= 0) { col[k] = i; return; } }
      const i2 = norm.findIndex(h => MATRIX_HEADS[k].some(c => h.includes(c)));
      if (i2 >= 0) col[k] = i2;
    });
    return (col.proj != null && col.person != null && col.pct != null) ? col : null;
  }
  function matrixRowsFromGrid(grid) {
    // find the header row (first row that maps), then read the rest
    for (let h = 0; h < Math.min(grid.length, 8); h++) {
      const col = mapMatrixHeader(grid[h]);
      if (!col) continue;
      const rows = [];
      for (let i = h + 1; i < grid.length; i++) {
        const r = grid[i];
        const proj = (r[col.proj] || '').toString().trim();
        const person = (r[col.person] || '').toString().trim();
        if (!proj || !person) continue;
        rows.push({
          proj, person,
          status: col.status != null ? String(r[col.status] || '').trim() : '',
          type: col.type != null ? String(r[col.type] || '').trim() : '',
          client: col.client != null ? String(r[col.client] || '').trim() : '',
          start: col.start != null ? anyToYm(r[col.start]) : null,
          end: col.end != null ? anyToYm(r[col.end]) : null,
          pct: col.pct != null ? (parseFloat(String(r[col.pct]).replace('%', '')) || 0) : 0,
          note: col.note != null ? String(r[col.note] || '').trim() : '',
        });
      }
      return rows;
    }
    return null;
  }
  /** Parse an uploaded staffing-matrix file (.xlsx Data tab, or CSV export).
      Returns { rows } or { error }. */
  async function parseMatrixFile(file) {
    try {
      if (/\.xlsx?$/i.test(file.name)) {
        const grid = await xlsxSheetGrid(await file.arrayBuffer(), 'data');
        if (!grid) return { error: 'Could not find a "Data" tab (or any sheet with Project / Person / Allocation % columns).' };
        const rows = matrixRowsFromGrid(grid);
        return rows && rows.length ? { rows } : { error: 'No allocation rows found — expected columns like Project Name, Person Allocated, Allocation %.' };
      }
      const parsed = parseCsv(String(await file.text()));
      if (!parsed.length) return { error: 'Empty file.' };
      const grid = [Object.keys(parsed[0])].concat(parsed.map(o => Object.values(o)));
      const rows = matrixRowsFromGrid(grid);
      return rows && rows.length ? { rows } : { error: 'Could not map the CSV columns — expected Project Name, Person Allocated, Allocation %…' };
    } catch (e) { return { error: 'Parse failed: ' + (e && e.message || e) }; }
  }
  /** Minimal XLSX reader: unzips in-browser (DecompressionStream) and returns the
      named sheet (fallback: first sheet that maps) as a 2-D grid of strings. */
  async function xlsxSheetGrid(buf, wantName) {
    const bytes = new Uint8Array(buf);
    const u16 = (o) => bytes[o] | (bytes[o + 1] << 8);
    const u32 = (o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
    let e = -1; for (let i = bytes.length - 22; i >= 0; i--) { if (u32(i) === 0x06054b50) { e = i; break; } }
    if (e < 0) return null;
    let p = u32(e + 16); const cc = u16(e + 10); const files = {};
    for (let i = 0; i < cc; i++) {
      if (u32(p) !== 0x02014b50) break;
      const comp = u16(p + 10), cs = u32(p + 20), nl = u16(p + 28), el = u16(p + 30), cl = u16(p + 32), lho = u32(p + 42);
      files[new TextDecoder().decode(bytes.slice(p + 46, p + 46 + nl))] = { comp, cs, lho };
      p += 46 + nl + el + cl;
    }
    async function ex(n) {
      const f = files[n]; if (!f) return null;
      const lh = f.lho, nl = u16(lh + 26), el = u16(lh + 28), st = lh + 30 + nl + el, d = bytes.slice(st, st + f.cs);
      if (f.comp === 0) return new TextDecoder().decode(d);
      const stream = new Response(d).body.pipeThrough(new DecompressionStream('deflate-raw'));
      return new TextDecoder().decode(new Uint8Array(await new Response(stream).arrayBuffer()));
    }
    const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    const wb = await ex('xl/workbook.xml'); if (!wb) return null;
    const rels = await ex('xl/_rels/workbook.xml.rels') || '';
    const relMap = {}; [...rels.matchAll(/Id="([^"]*)"[^>]*Target="([^"]*)"/g)].forEach(m => relMap[m[1]] = m[2].replace(/^\//, ''));
    const sheets = [...wb.matchAll(/<sheet [^>]*name="([^"]*)"[^>]*r:id="([^"]*)"/g)].map(m => ({ name: unesc(m[1]), path: 'xl/' + (relMap[m[2]] || '').replace(/^xl\//, '') }));
    const ssXml = await ex('xl/sharedStrings.xml') || '';
    const ss = []; for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) ss.push(unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')));
    async function grid(sheetPath) {
      const xml = await ex(sheetPath); if (!xml) return null;
      const colN = (c) => { let n = 0; for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
      const out = [];
      for (const rm of xml.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
        const row = [];
        for (const cm of rm[2].matchAll(/<c r="([A-Z]+)\d+"(?:[^>]*t="([^"]*)")?[^>]*>(?:<is><t[^>]*>([\s\S]*?)<\/t><\/is>|<v>([\s\S]*?)<\/v>)?/g)) {
          let v = cm[3] != null ? unesc(cm[3]) : cm[4];
          if (cm[2] === 's' && v != null) v = ss[+v];
          row[colN(cm[1])] = v == null ? '' : v;
        }
        out.push(row);
      }
      return out;
    }
    const want = sheets.find(s => s.name.toLowerCase().trim() === String(wantName).toLowerCase());
    if (want) { const g = await grid(want.path); if (g && matrixRowsFromGrid(g)) return g; }
    for (const s of sheets) { const g = await grid(s.path); if (g && matrixRowsFromGrid(g)) return g; }
    return null;
  }
  /** Replace the allocation matrix with freshly-parsed rows. Keeps actuals and
      per-person capacity/title edits; stamps the source for the meta line. */
  function importMatrix(rows, sourceName) {
    const db = readDb();
    const renames = ((db.mappings || {}).renames) || {};
    rows.forEach(r => { const c = renames[nkey(r.proj)]; if (c) r.proj = c; });   // auto-canonicalize on the way in
    const keepActuals = db.actuals || {};
    const keep = {}; Object.values(db.people).forEach(p => { keep[p.id] = { capacityPct: p.capacityPct, title: p.title, homeTeam: p.homeTeam, nonBillable: p.nonBillable }; });
    const fresh = defaultDb();
    fresh.actuals = keepActuals; fresh.meta = db.meta || fresh.meta;
    /* A person's id is a slug of their name, so a sheet that spells a name
       differently used to mint a second person: the old id's capacity, title
       and actuals orphaned. Resolve against the roster we already have first
       (namesMatch handles initials, order and diacritics); slug only for a
       genuinely new name. Rows with no start month are skipped and counted. */
    const roster = Object.values(db.people || {});
    let skipped = 0;
    rows.forEach(r => {
      if (!r.start || !/^\d{4}-\d{2}$/.test(String(r.start))) { skipped++; return; }
      const known = roster.find(p => namesMatch(p.name, r.person));
      const shown = flipComma(canonicalName(r.person));
      const pid = known ? known.id : slug(shown + (isNewHireName(r.person) ? ' newhire' : ''));
      if (!fresh.people[pid]) fresh.people[pid] = { id: pid, name: known ? known.name : shown, isNewHire: isNewHireName(r.person), title: '', homeTeam: '', capacityPct: 100, active: true };
      if (keep[pid]) Object.assign(fresh.people[pid], keep[pid]);
      fresh.allocations.push({ id: 'al_' + Math.random().toString(36).slice(2, 9), personId: pid, project: r.proj, client: r.client, status: r.status || 'Active', type: r.type || 'Awarded', start: r.start, end: r.end || '', pct: clampPct(r.pct), note: r.note || '' });
    });
    fresh.meta.matrixImportedAt = new Date().toISOString();
    fresh.meta.matrixSource = sourceName || 'upload';
    const before = { people: Object.keys(db.people || {}).length, allocations: (db.allocations || []).length };
    writeDb(fresh);
    logStaff('staff-import', { source: sourceName || 'upload',
      people: Object.keys(fresh.people).length, allocations: fresh.allocations.length,
      replacedPeople: before.people, replacedAllocations: before.allocations, skipped: skipped || undefined });
    return { people: Object.keys(fresh.people).length, allocations: fresh.allocations.length, skipped };
  }

  // ---------- export ----------
  function exportJson() { return JSON.stringify(readDb(), null, 2); }

  window.UFC_Staff = {
    MON, DEFAULT_MONTH_HOURS,
    // month utils
    ymLabel, ymAdd, monthsBetween, currentYM, isPastYM, ymCmp,
    // store
    readDb, reseedMatrix, resetAll, exportJson, attachRemote, hydrateFromRemote,
    mergeStaffDb, mergeFromRemote,
    parseMatrixFile, importMatrix,
    // roster
    listPeople, getPerson, savePerson, monthHours, setMonthHours, capacityHours,
    // allocations
    listAllocations, saveAllocation, deleteAllocation, personIdForName,
    distinctProjects, distinctClients, allocationWindow, defaultWindow,
    // engine
    personLoad, personAllocationsIn, allocActiveIn, bandwidthGrid, projectRollup, matchFeeProject, matchFeeProjects, listFeeProjects,
    expectedHours, actualHours, varianceMatrix, hasActuals, actualsMeta, feePlanHours, contractPlan,
    unassignedRoles, contractStaffingGaps, dismissGap, restoreGap, dismissedGaps, gapKey, duplicateAllocations, loggingWithoutAllocation, pinAutoLinksFor, matrixSeedCandidates, comingAvailable, substantialMacroTime, setPersonNonBillable, setPersonEmployment, personEmploymentType, complianceRows,
    allocationsForFeeProject, shiftAllocationsForFeeProject, pendingContractShifts,
    // clockify
    analyzeClockify, commitClockify, clearActuals, resolveClockifyProject,
    getMappings, setUserMapping, setProjectMapping, setFeeMapping, setTitleMapping, setPersonAlias, personForContractName, tokenScore,
    titleFamily, costRateForTitle, personCostRate, macroHours, isMacroProject, isTimeOffProject, isLeaveProject, leaveStatus, profitability,
    setLateness, getLateness, setUserExclusion, userExcluded, applyClockifyTitles,
    proposeCanonical, commitRenames, parseCsvRows: parseCsv,
    // helpers
    namesMatch, cleanName, isNewHireName, allocEnd, isOpenEnded, clampPct,
  };
})();
