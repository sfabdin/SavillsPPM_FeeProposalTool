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
  const DEFAULT_MONTH_HOURS = 172;

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
  function namesMatch(a, b) {
    const x = nkey(canonicalName(a)), y = nkey(canonicalName(b));
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
  function ymLabel(ym) { const [y, m] = ym.split('-').map(Number); return MON[m - 1] + " '" + String(y).slice(2); }
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
  function hydrateFromRemote(db) {
    if (!db || !db.people || !db.allocations) return false;
    if (!db.actuals) db.actuals = {};
    if (!db.mappings) db.mappings = { users: {}, projects: {} };
    if (!db.deleted) db.deleted = {};
    if (!db.meta) db.meta = { monthHours: DEFAULT_MONTH_HOURS };
    db.schemaVersion = SCHEMA;
    localStorage.setItem(KEY, JSON.stringify(db));
    _dbCache = db;
    _feeIndex = null; _feeRecords = null;   // fee-tool project list may have changed too
    return true;
  }
  function writeDb(db) {
    db.schemaVersion = SCHEMA;
    db.meta = db.meta || {};
    db.meta.updatedAt = new Date().toISOString();
    try { const u = window.UFC_Store && window.UFC_Store.getCurrentUser && window.UFC_Store.getCurrentUser(); if (u && u.username) db.meta.updatedBy = u.username; } catch (e) {}
    localStorage.setItem(KEY, JSON.stringify(db));
    _dbCache = db;
    if (_push) { try { _push(db); } catch (e) { console.warn('staff push failed', e); } }
  }

  /** Wipe + re-seed from the (possibly refreshed) window.STAFF_SEED. Keeps
      actuals and roster capacity edits? — no: full matrix reset. Actuals kept. */
  function reseedMatrix() {
    const db = readDb();
    const keepActuals = db.actuals || {};
    const keepCaps = {}; Object.values(db.people).forEach(p => { keepCaps[p.id] = { capacityPct: p.capacityPct, title: p.title, homeTeam: p.homeTeam }; });
    const fresh = seedFromMatrix(defaultDb());
    fresh.actuals = keepActuals;
    Object.values(fresh.people).forEach(p => { if (keepCaps[p.id]) Object.assign(p, keepCaps[p.id]); });
    writeDb(fresh);
    return fresh;
  }

  function resetAll() { const db = seedFromMatrix(defaultDb()); writeDb(db); return db; }

  // ---------- roster ----------
  function listPeople() { return Object.values(readDb().people).sort((a, b) => a.name.localeCompare(b.name)); }
  function getPerson(id) { return readDb().people[id] || null; }
  function savePerson(person) {
    const db = readDb();
    if (!person.id) person.id = 'p_' + Math.random().toString(36).slice(2, 9);
    db.people[person.id] = Object.assign(db.people[person.id] || {}, person);
    writeDb(db); return db.people[person.id];
  }
  function setMonthHours(h) { const db = readDb(); db.meta.monthHours = +h || DEFAULT_MONTH_HOURS; writeDb(db); }
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
    a.updatedAt = new Date().toISOString();
    try { const u = window.UFC_Store && window.UFC_Store.getCurrentUser(); if (u && u.username) a.updatedBy = u.username; } catch (e) {}
    if (!a.id) { a.id = 'al_' + Math.random().toString(36).slice(2, 9); db.allocations.push(a); }
    else { const i = db.allocations.findIndex(x => x.id === a.id); if (i >= 0) db.allocations[i] = a; else db.allocations.push(a); }
    writeDb(db); return a;
  }
  /** Soft-delete: keep a tombstone so the deletion survives a merge with a
      teammate's copy instead of the row resurrecting from their file. */
  function deleteAllocation(id) {
    const db = readDb();
    db.allocations = db.allocations.filter(x => x.id !== id);
    db.deleted = db.deleted || {};
    db.deleted[id] = new Date().toISOString();
    writeDb(db);
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
    out.meta = ((lMeta.updatedAt || '') >= (rMeta.updatedAt || '')) ? Object.assign({}, rMeta, lMeta) : Object.assign({}, lMeta, rMeta);
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
    localStorage.setItem(KEY, JSON.stringify(merged));
    _dbCache = merged;
    _feeIndex = null; _feeRecords = null;   // fee-tool project list may have changed too
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
  function allocActiveIn(a, ym) { return a.start && a.end ? (a.start <= ym && ym <= a.end) : (a.start ? a.start <= ym : false); }

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
      if (e.detail && e.detail.projects) { _feeIndex = null; _feeRecords = null; }
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
    _feeIndex = feeRecords().map(p => {
      const name = (p.project && p.project.name) || '';
      const client = (p.project && p.project.client) || '';
      return { id: p.id, name, client, label: client ? client + ' — ' + name : name, key: projKey(name) };
    });
    return _feeIndex;
  }
  /** Token-based name similarity — the smart part of project mapping. Splits
      names into significant words (drops filler + punctuation + SF-id-ish
      tokens), scores overlap. "JPMC — 270 Park Relocation" ↔ "270P" style
      abbreviations get partial-prefix credit. */
  const STOP_WORDS = new Set(['the', 'of', 'and', 'a', 'an', 'for', 'to', 'at', 'in', 'on', 'llc', 'inc', 'corp', 'project', 'phase']);
  function nameTokens(s) {
    return String(s || '').toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/)
      .filter(t => t && t.length > 1 && !STOP_WORDS.has(t) && !/^opp\d/.test(t));
  }
  function tokenScore(a, b) {
    const ta = nameTokens(a), tb = nameTokens(b);
    if (!ta.length || !tb.length) return 0;
    const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    let hit = 0;
    small.forEach(t => {
      if (big.includes(t)) { hit += 1; return; }
      // prefix credit: "270p" ~ "270", "reloc" ~ "relocation"
      if (big.some(bt => (bt.length >= 3 && t.startsWith(bt)) || (t.length >= 3 && bt.startsWith(t)))) hit += 0.75;
    });
    return hit / small.length;          // 1 = every significant word of the shorter name found
  }

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
      const hrs = (p.assumptions && p.assumptions.hrsPerMo) || 173.33;
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
    // Clockify carries the job title — fill roster titles that are still blank.
    Object.entries(report.titles || {}).forEach(([pid, t]) => { if (db.people[pid] && !db.people[pid].title) db.people[pid].title = t; });
    writeDb(db);
    return { written, skipped };
  }

  function clearActuals() { const db = readDb(); db.actuals = {}; delete db.meta.clockifyImportedAt; delete db.meta.clockifyMonths; writeDb(db); }

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
    Object.entries(db.actuals || {}).forEach(([k, h]) => {
      const i1 = k.indexOf('|'), i2 = k.lastIndexOf('|');
      const pid = k.slice(0, i1), proj = k.slice(i1 + 1, i2), ym = k.slice(i2 + 1);
      if (!inWin.has(ym)) return;
      const person = db.people[pid];
      const rate = person ? costRateForTitle(person.title) : null;
      if (!rate) { noRate.add(person ? (person.name + (person.title ? ' — ' + person.title : ' — no title')) : pid.replace(/^unmatched:/, '')); return; }
      if (isMacroProject(proj)) {
        overhead.byMonth[ym] = (overhead.byMonth[ym] || 0) + h * rate;
        overhead.hours += h; overhead.cost += h * rate;
        overhead.byProj[proj] = (overhead.byProj[proj] || 0) + h * rate;
        const op = overhead.ppl[pid] || (overhead.ppl[pid] = { name: person.name, title: person.title || '', rate, hours: 0, cost: 0, byMonth: {} });
        op.hours += h; op.cost += h * rate;
        const om = op.byMonth[ym] || (op.byMonth[ym] = { hours: 0, cost: 0 });
        om.hours += h; om.cost += h * rate;
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
    projects.forEach(p => {
      const rating = S2.ratingFor ? S2.ratingFor(p) : 5;
      const revByMonth = {}; let revTotal = 0;
      const add = (ym, amt) => { if (inWin.has(ym)) { revByMonth[ym] = (revByMonth[ym] || 0) + amt; revTotal += amt; } };
      try {
        const fin = p.financials;
        if (fin && !fin.stale && Array.isArray(fin.byMonth) && fin.byMonth.length) {
          fin.byMonth.forEach(s => add(s.ym, (s.invoice != null) ? s.invoice : s.net));
        } else {
          const fs0 = (p.assumptions && p.assumptions.feeShare) || {};
          const pct0 = fs0.enabled ? (parseFloat(fs0.pct) || 0) / 100 : 0;
          (S2.monthlySeries(p, cat) || []).forEach(m => add(m.year + '-' + String(m.month).padStart(2, '0'), fs0.mode === 'ontop' ? m.amount * (1 + pct0) : m.amount));
        }
        (S2.approvedChangeOrders ? S2.approvedChangeOrders(p.id) : []).forEach(co => {
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
    return { ok: true, rows, overhead, noRate: [...noRate], hasActuals: hasActuals() };
  }

  function getLateness() { const db = readDb(); return { rows: db.lateness || [], at: db.meta.latenessAt }; }

  /** Contract role titles with no allocated person whose title plausibly
      covers them — "who's this project's contract-priced role, unstaffed?"
      Shared by the Insights tab and the By Project view badge. */
  function unassignedRoles(months) {
    const out = [];
    distinctProjects().forEach(pn => {
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
  function contractStaffingGaps() {
    const S2 = window.UFC_Store;
    if (!S2 || !S2.computeMonthsByPhase) return [];
    const db = readDb();
    const nowYm = currentYM();
    const cat = (typeof window !== 'undefined') && window.RATES_CATALOG;
    const out = [];
    const visitedFee = new Set();

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
          existing = db.allocations.filter(a => a.project === pn && (
            // an allocation created FOR this open role always counts, whatever
            // the assignee's title says — otherwise confirming never clears it
            String(a.contractRole || '').toLowerCase() === roleKey ||
            covers(((db.people[a.personId] || {}).title || '').trim())
          ));
        } else {
          person = personForContractName(e.name);   // saved alias first, then tolerant match
          const nameKey = nkey(canonicalName(e.name));
          existing = db.allocations.filter(a => a.project === pn && (
            (person && a.personId === person.id) ||
            // allocation created FOR this contract name (leader mapped it to
            // someone else) counts even before/without a saved alias
            nkey(canonicalName(a.contractResource || '')) === nameKey
          ));
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
        out.push({
          project: pn, client,
          open: !!e.open, roleTitle: e.roleLabel || [...e.roles][0] || 'Role',
          resource: e.name, roles: [...e.roles],
          person, isNew: e.open ? false : !person,
          personId: e.open ? null : (person ? person.id : personIdForName(e.name)),
          topUp: existing.length > 0,
          via: e.via,
          segments: future,
          totalNeedFteMo: Math.round(future.reduce((s, sg) => s + sg.need * monthsBetween(sg.start, sg.end).length, 0)) / 100,
        });
      });
    };

    // 1) Matrix projects with allocations — diff against their linked fee projects.
    distinctProjects().forEach(pn => {
      const client = (db.allocations.find(a => a.project === pn) || {}).client || '';
      const links = matchFeeProjects(pn, client);
      if (links.length) collect(pn, client, links);
    });

    // 2) SIGNED fee projects no matrix project links to — the most
    // under-staffed case of all: the contract exists and nobody is on it.
    // Surfaced under the fee project's own name, so confirming seeds the
    // matrix project with a name that auto-links back to the fee record.
    feeRecords().forEach(p => {
      if (visitedFee.has(p.id)) return;
      const st = (p.project && p.project.status) || '';
      if (st !== 'won' && st !== 'active') return;              // unsigned work doesn't demand staffing
      if (!p.roles || !p.roles.length || !p.timeline) return;
      const name = (p.project && p.project.name || '').trim();
      if (!name) return;
      collect(name, (p.project && p.project.client) || '', [{ id: p.id, via: 'direct' }]);
    });

    return out.sort((a, b) => b.totalNeedFteMo - a.totalNeedFteMo);
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
      const client = (db.allocations.find(a => a.project === pn) || {}).client || '';
      const links = matchFeeProjects(pn, client);
      linkCount[pn] = links.length;
      links.forEach(l => { (revLinks[l.id] = revLinks[l.id] || []).push(pn); });
    });
    const out = [];
    feeRecords().forEach(p => {
      if (p.roles && p.roles.length) return;                 // never touch an existing roster
      const st = (p.project && p.project.status) || '';
      if (st === 'lost' || st === 'closed') return;
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
          if (pct) { fteMonthly[mk] = pct; tot += pct; activeMonths++; }
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
    const nowYm = currentYM();
    const nextMs = []; { let [fy, fm] = nowYm.split('-').map(Number); for (let i = 0; i < 4; i++) { nextMs.push(fy + '-' + String(fm).padStart(2, '0')); fm++; if (fm > 12) { fm = 1; fy++; } } }
    return bandwidthGrid(nextMs, opts).map(r => {
      const cur = r.byMonth[nextMs[0]] || 0;
      let best = null;
      nextMs.slice(1).forEach(m => { const v = r.byMonth[m] || 0; if (v < 100 && cur - v >= 25 && (!best || v < best.v)) best = { m, v }; });
      if (!best) return null;
      // freed = capacity that opens up BELOW the 100% line (loads over 100% free nothing until they cross it)
      const freedH = Math.round((Math.min(cur, 100) - best.v) / 100 * capacityHours(r.person));
      return freedH > 0 ? { person: r.person, cur, to: best.v, m: best.m, freedH } : null;
    }).filter(Boolean).sort((a, b) => b.freedH - a.freedH);
  }

  /** People with meaningfully large non-client ("macro") time in the window —
      the >40h leadership threshold. Dedicated BOH staff (≥90% internal) are
      split out separately since that's expected, not a flag. */
  function substantialMacroTime(months) {
    const all = (hasActuals() && macroHours) ? macroHours(months) : [];
    return {
      boh: all.filter(r => r.pct >= 0.9 && r.hours > 40),
      flagged: all.filter(r => r.pct < 0.9 && r.hours > 40),
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
      if (person && person.title !== t) { person.title = t; set++; }
    });
    if (set) writeDb(db);
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
  function macroHours(monthsList) {
    const db = readDb(); const inWin = new Set(monthsList); const per = {};
    Object.entries(db.actuals || {}).forEach(([k, h]) => {
      const i1 = k.indexOf('|'), i2 = k.lastIndexOf('|');
      const pid = k.slice(0, i1), proj = k.slice(i1 + 1, i2), ym = k.slice(i2 + 1);
      if (!inWin.has(ym)) return;
      const rec = per[pid] || (per[pid] = { person: db.people[pid] || { id: pid, name: pid.replace(/^unmatched:/, '') }, hours: 0, total: 0, byProj: {} });
      rec.total += h;
      if (!isMacroProject(proj)) return;
      rec.hours += h; rec.byProj[proj] = (rec.byProj[proj] || 0) + h;
    });
    return Object.values(per).filter(r => r.hours > 0).map(r => ({ ...r, pct: r.total ? r.hours / r.total : 0 })).sort((a, b) => b.hours - a.hours);
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
  }

  function setUserMapping(clockifyName, personId) {
    const db = readDb(); db.mappings = db.mappings || { users: {}, projects: {} };
    if (personId) db.mappings.users[nkey(clockifyName)] = personId; else delete db.mappings.users[nkey(clockifyName)];
    writeDb(db);
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
  }
  /** Manual matrix-project → fee-tool-project link(s), shared via staff.json.
      A matrix project can be pinned to SEVERAL fee projects (their figures
      then sum in contractPlan) — stored as an array under the hood, but
      legacy single-string mappings from before multi-link still read fine.
      setFeeMapping(mp, id)                  → add id to the set
      setFeeMapping(mp, id, { remove: true }) → remove just that id
      setFeeMapping(mp, null)                → clear the whole set (revert to auto-match) */
  function setFeeMapping(matrixProject, feeProjectId, opts) {
    const db = readDb(); db.mappings = db.mappings || { users: {}, projects: {} };
    db.mappings.fee = db.mappings.fee || {};
    const key = nkey(matrixProject);
    if (!feeProjectId) { delete db.mappings.fee[key]; writeDb(db); return; }
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
    });
    db.meta.canonSyncedAt = new Date().toISOString();
    writeDb(db);
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
    const keep = {}; Object.values(db.people).forEach(p => { keep[p.id] = { capacityPct: p.capacityPct, title: p.title, homeTeam: p.homeTeam }; });
    const fresh = defaultDb();
    fresh.actuals = keepActuals; fresh.meta = db.meta || fresh.meta;
    rows.forEach(r => {
      const pid = slug(canonicalName(r.person) + (isNewHireName(r.person) ? ' newhire' : ''));
      if (!fresh.people[pid]) fresh.people[pid] = { id: pid, name: canonicalName(r.person), isNewHire: isNewHireName(r.person), title: '', homeTeam: '', capacityPct: 100, active: true };
      if (keep[pid]) Object.assign(fresh.people[pid], keep[pid]);
      fresh.allocations.push({ id: 'al_' + Math.random().toString(36).slice(2, 9), personId: pid, project: r.proj, client: r.client, status: r.status || 'Active', type: r.type || 'Awarded', start: r.start, end: r.end, pct: +r.pct || 0, note: r.note || '' });
    });
    fresh.meta.matrixImportedAt = new Date().toISOString();
    fresh.meta.matrixSource = sourceName || 'upload';
    writeDb(fresh);
    return { people: Object.keys(fresh.people).length, allocations: fresh.allocations.length };
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
    unassignedRoles, contractStaffingGaps, matrixSeedCandidates, comingAvailable, substantialMacroTime,
    // clockify
    analyzeClockify, commitClockify, clearActuals, resolveClockifyProject,
    getMappings, setUserMapping, setProjectMapping, setFeeMapping, setTitleMapping, setPersonAlias, personForContractName, tokenScore,
    titleFamily, costRateForTitle, personCostRate, macroHours, isMacroProject, isTimeOffProject, profitability,
    setLateness, getLateness, setUserExclusion, userExcluded, applyClockifyTitles,
    proposeCanonical, commitRenames, parseCsvRows: parseCsv,
    // helpers
    namesMatch, cleanName, isNewHireName,
  };
})();
