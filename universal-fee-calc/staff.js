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
  const NAME_ALIASES = { 'sarah alim': 'Sarah Abdin' };
  function canonicalName(n) { const c = cleanName(n); return NAME_ALIASES[c.toLowerCase()] || c; }
  function nkey(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  /** Tolerant name match (surname fallback), mirrors the fee store. */
  function namesMatch(a, b) {
    const x = nkey(canonicalName(a)), y = nkey(canonicalName(b));
    if (!x || !y) return false;
    if (x === y) return true;
    const xl = x.split(' ').pop(), yl = y.split(' ').pop();
    return xl === y || yl === x || (xl === yl && xl.length > 3);
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
  function defaultDb() { return { schemaVersion: SCHEMA, people: {}, allocations: [], actuals: {}, mappings: { users: {}, projects: {} }, meta: { monthHours: DEFAULT_MONTH_HOURS } }; }

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
      db.allocations.push({
        id: 'al_' + Math.random().toString(36).slice(2, 9),
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
    if (!db.meta) db.meta = { monthHours: DEFAULT_MONTH_HOURS };
    db.schemaVersion = SCHEMA;
    localStorage.setItem(KEY, JSON.stringify(db));
    _dbCache = db;
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
    // ensure the person exists in the roster
    if (a.personId && !db.people[a.personId]) {
      db.people[a.personId] = { id: a.personId, name: a.personName || a.personId, isNewHire: false, title: '', homeTeam: '', capacityPct: 100, active: true };
    }
    a.updatedAt = new Date().toISOString();
    try { const u = window.UFC_Store && window.UFC_Store.getCurrentUser(); if (u && u.username) a.updatedBy = u.username; } catch (e) {}
    if (!a.id) { a.id = 'al_' + Math.random().toString(36).slice(2, 9); db.allocations.push(a); }
    else { const i = db.allocations.findIndex(x => x.id === a.id); if (i >= 0) db.allocations[i] = a; else db.allocations.push(a); }
    writeDb(db); return a;
  }
  function deleteAllocation(id) { const db = readDb(); db.allocations = db.allocations.filter(x => x.id !== id); writeDb(db); }

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
    const db = readDb();
    const byProj = {};
    db.allocations.forEach(a => {
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
    // 0) saved manual link wins
    const feeMap = (readDb().mappings || {}).fee || {};
    const mapped = feeMap[nkey(name)];
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
      or carries no staffing. { byMonth:{ym:hrs}, total, feeProject } */
  function feePlanHours(projectName, months) {
    const cp = contractPlan(projectName, months);
    return cp ? { byMonth: cp.byMonth, total: cp.total, feeProject: cp.feeProject } : null;
  }

  /** CONTRACT plan — the fee-tool staffing for a window, with a per-TITLE
      breakdown (contract knows titles + allocations, not names). Rate-free.
      { byMonth:{ym:hrs}, total, roles:[{title, fteMonths, hours}], feeProject } */
  function contractPlan(projectName, months, client) {
    const link = matchFeeProject(projectName, client);
    if (!link) return null;
    const S2 = window.UFC_Store;
    const p = feeRecords().find(x => x.id === link.id);
    if (!p || !p.roles || !p.roles.length || !p.timeline) return null;
    const hrs = (p.assumptions && p.assumptions.hrsPerMo) || 173.33;
    const byPhase = S2.computeMonthsByPhase(p);
    const phaseOf = {};
    (p.phases || []).forEach(ph => (byPhase[ph.id] || []).forEach(m => { phaseOf[m.year + '-' + m.month] = ph.id; }));
    const inWin = new Set(months);
    const cat = (typeof window !== 'undefined') && window.RATES_CATALOG;
    const titleOf = (r) => {
      const t = cat && cat.titles && cat.titles.find(x => x.id === r.titleId);
      return (r.projectRole || '').trim() || (t && (t.name || t.label)) || r.titleId || 'Role';
    };
    const byMonth = {}; const roleAgg = {}; let total = 0, any = false;
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
    if (!any) return null;
    const roles = Object.values(roleAgg).map(r => ({ title: r.title, fteMonths: Math.round(r.fteMonths * 100) / 100, hours: Math.round(r.hours * 10) / 10 })).sort((a, b) => b.hours - a.hours);
    return { byMonth, total: Math.round(total * 10) / 10, roles, feeProject: link };
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
      // match person: saved mapping → name match
      let person = (uMap && db.people[uMap]) ? db.people[uMap] : Object.values(db.people).find(p => namesMatch(p.name, uname));
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

  /* ---------- saved Clockify → roster mappings (map once, keeps forever;
     lives in staff.json so the whole team shares it) ---------- */
  function getMappings() { const db = readDb(); return db.mappings || { users: {}, projects: {} }; }
  function setUserMapping(clockifyName, personId) {
    const db = readDb(); db.mappings = db.mappings || { users: {}, projects: {} };
    if (personId) db.mappings.users[nkey(clockifyName)] = personId; else delete db.mappings.users[nkey(clockifyName)];
    writeDb(db);
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
  /** Manual matrix-project → fee-tool-project link (map once, shared via staff.json). */
  function setFeeMapping(matrixProject, feeProjectId) {
    const db = readDb(); db.mappings = db.mappings || { users: {}, projects: {} };
    db.mappings.fee = db.mappings.fee || {};
    if (feeProjectId) db.mappings.fee[nkey(matrixProject)] = feeProjectId; else delete db.mappings.fee[nkey(matrixProject)];
    writeDb(db);
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
    parseMatrixFile, importMatrix,
    // roster
    listPeople, getPerson, savePerson, monthHours, setMonthHours, capacityHours,
    // allocations
    listAllocations, saveAllocation, deleteAllocation, personIdForName,
    distinctProjects, distinctClients, allocationWindow, defaultWindow,
    // engine
    personLoad, personAllocationsIn, bandwidthGrid, projectRollup, matchFeeProject, listFeeProjects,
    expectedHours, actualHours, varianceMatrix, hasActuals, actualsMeta, feePlanHours, contractPlan,
    // clockify
    analyzeClockify, commitClockify, clearActuals, resolveClockifyProject,
    getMappings, setUserMapping, setProjectMapping, setFeeMapping, tokenScore,
    proposeCanonical, commitRenames, parseCsvRows: parseCsv,
    // helpers
    namesMatch, cleanName, isNewHireName,
  };
})();
