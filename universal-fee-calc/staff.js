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

  /* Working hours in a month at 100% capacity. The fee engine bills at
     173.33 hrs/mo; people don't LOG that many (PTO, internal, non-billable),
     so capacity defaults lower and is user-tunable on the page. */
  const DEFAULT_MONTH_HOURS = 160;

  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // ---------- id / name helpers ----------
  function slug(s) {
    return String(s || '').toLowerCase().replace(/\[new hire\]/g, 'newhire')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';
  }
  function isNewHireName(n) { return /\[new hire\]/i.test(n || ''); }
  function cleanName(n) { return String(n || '').replace(/\[new hire\]/ig, '').trim().replace(/\s+/g, ' '); }
  function nkey(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  /** Tolerant name match (surname fallback), mirrors the fee store. */
  function namesMatch(a, b) {
    const x = nkey(cleanName(a)), y = nkey(cleanName(b));
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
  function defaultDb() { return { schemaVersion: SCHEMA, people: {}, allocations: [], actuals: {}, meta: { monthHours: DEFAULT_MONTH_HOURS } }; }

  function seedFromMatrix(db) {
    const seed = (typeof window !== 'undefined' && window.STAFF_SEED) || [];
    db.people = {}; db.allocations = [];
    const peopleSeen = {};
    seed.forEach(r => {
      const pid = slug(r.person);
      if (!peopleSeen[pid]) {
        peopleSeen[pid] = true;
        db.people[pid] = {
          id: pid, name: cleanName(r.person), isNewHire: isNewHireName(r.person),
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
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) { const db = seedFromMatrix(defaultDb()); writeDb(db); return db; }
      const p = JSON.parse(raw);
      if (!p.people || !p.allocations) return seedFromMatrix(defaultDb());
      if (!p.actuals) p.actuals = {};
      if (!p.meta) p.meta = { monthHours: DEFAULT_MONTH_HOURS };
      if (p.meta.monthHours == null) p.meta.monthHours = DEFAULT_MONTH_HOURS;
      return p;
    } catch (e) { console.error('staff db read failed', e); return seedFromMatrix(defaultDb()); }
  }
  function writeDb(db) { db.schemaVersion = SCHEMA; localStorage.setItem(KEY, JSON.stringify(db)); }

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
      feeProject: matchFeeProject(b.project),
    })).sort((a, b) => a.project.localeCompare(b.project));
  }

  /** Best-effort match of a matrix project name to a fee-tool project. */
  let _feeIndex = null;
  function feeIndex() {
    if (_feeIndex) return _feeIndex;
    _feeIndex = [];
    try {
      const S = window.UFC_Store;
      if (S && S.listProjects) _feeIndex = S.listProjects().map(p => ({ id: p.id, name: (p.project && p.project.name) || '', key: projKey((p.project && p.project.name) || '') }));
    } catch (e) {}
    return _feeIndex;
  }
  function matchFeeProject(name) {
    const k = projKey(name); if (!k) return null;
    const idx = feeIndex();
    let hit = idx.find(p => p.key === k);
    if (!hit) hit = idx.find(p => p.key && (p.key.includes(k) || k.includes(p.key)) && Math.abs(p.key.length - k.length) < 8);
    return hit ? { id: hit.id, name: hit.name } : null;
  }

  /** Salesforce-ID index over fee-tool projects — Clockify project names carry
      the SF ID, so it's the authoritative cross-system join. */
  let _sfIndex = null;
  function sfIndex() {
    if (_sfIndex) return _sfIndex;
    _sfIndex = [];
    try {
      const S2 = window.UFC_Store;
      if (S2 && S2.listProjects) S2.listProjects().forEach(p => {
        const sf = String((p.project && p.project.salesforceId) || '').trim().toLowerCase();
        if (sf.length >= 4) _sfIndex.push({ sf, id: p.id, name: (p.project && p.project.name) || '' });
      });
      _sfIndex.sort((a, b) => b.sf.length - a.sf.length);   // longest id first — avoids prefix collisions
    } catch (e) {}
    return _sfIndex;
  }
  /** Resolve a Clockify project name → matrix project name. Order:
      1. exact normalized name match to the matrix;
      2. a fee-tool Salesforce ID embedded in the Clockify name → that fee
         project → the matrix project with the matching name (else the fee name);
      3. fuzzy name containment. Returns { name, via } or null. */
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
    hit = all.find(pn => (projKey(pn).includes(k) || k.includes(projKey(pn))) && Math.abs(projKey(pn).length - k.length) < 8);
    if (hit) return { name: hit, via: 'fuzzy' };
    return null;
  }

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
    const link = matchFeeProject(projectName);
    if (!link) return null;
    const S2 = window.UFC_Store;
    const p = S2 && S2.getProject && S2.getProject(link.id);
    if (!p || !p.roles || !p.roles.length || !p.timeline) return null;
    const hrs = (p.assumptions && p.assumptions.hrsPerMo) || 173.33;
    const byPhase = S2.computeMonthsByPhase(p);
    const phaseOf = {};
    (p.phases || []).forEach(ph => (byPhase[ph.id] || []).forEach(m => { phaseOf[m.year + '-' + m.month] = ph.id; }));
    const inWin = new Set(months);
    const byMonth = {}; let total = 0, any = false;
    S2.enumerateMonths(p.timeline).forEach(m => {
      const ym = m.year + '-' + String(m.month).padStart(2, '0');
      if (!inWin.has(ym)) return;
      const mk = m.year + '-' + m.month;              // fee tool keys are non-padded
      let h = 0;
      p.roles.forEach(r => {
        const fte = ((r.fteMonthly && r.fteMonthly[mk] != null) ? r.fteMonthly[mk] : ((r.fte && r.fte[phaseOf[mk]]) || 0)) / 100;
        h += fte * hrs;
      });
      if (h > 0) any = true;
      byMonth[ym] = h; total += h;
    });
    return any ? { byMonth, total: Math.round(total * 10) / 10, feeProject: link } : null;
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
    if (!cProject) return { error: 'Could not find a "Project" column. Export a Clockify Detailed or Summary report as CSV.' };
    if (!cDur) return { error: 'Could not find a duration/time column. Include "Duration (decimal)" or "Time (h)" in the export.' };

    const agg = {}; // key personId|project|ym -> hours
    const unmatchedUsers = {}, unmatchedProjects = {}, monthsSeen = new Set();
    const db = readDb();
    let totalHours = 0, rowCount = 0, sfHits = 0;
    rows.forEach(r => {
      const uname = cUser ? r[cUser] : (cEmail ? r[cEmail] : '');
      const proj = r[cProject]; if (!proj) return;
      const hrs = toHours(r[cDur]); if (!hrs) return;
      const ym = toYm(cDate ? r[cDate] : '', defaultMonth); if (!ym) return;
      monthsSeen.add(ym);
      // match person
      let person = Object.values(db.people).find(p => namesMatch(p.name, uname));
      const personId = person ? person.id : ('unmatched:' + nkey(uname));
      if (!person) unmatchedUsers[uname] = (unmatchedUsers[uname] || 0) + hrs;
      // match project: exact name → Salesforce ID in the Clockify name → fuzzy
      const res = resolveClockifyProject(proj);
      const projName = res ? res.name : proj;
      if (res && res.via === 'salesforce') sfHits++;
      if (!res) unmatchedProjects[proj] = (unmatchedProjects[proj] || 0) + hrs;
      const key = actualKey(personId, projName, ym);
      agg[key] = (agg[key] || 0) + hrs;
      totalHours += hrs; rowCount++;
    });
    return {
      ok: true, agg, totalHours: Math.round(totalHours * 10) / 10, rowCount, sfHits,
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
    writeDb(db);
    return { written, skipped };
  }

  function clearActuals() { const db = readDb(); db.actuals = {}; delete db.meta.clockifyImportedAt; delete db.meta.clockifyMonths; writeDb(db); }

  // ---------- export ----------
  function exportJson() { return JSON.stringify(readDb(), null, 2); }

  window.UFC_Staff = {
    MON, DEFAULT_MONTH_HOURS,
    // month utils
    ymLabel, ymAdd, monthsBetween, currentYM, isPastYM, ymCmp,
    // store
    readDb, reseedMatrix, resetAll, exportJson,
    // roster
    listPeople, getPerson, savePerson, monthHours, setMonthHours, capacityHours,
    // allocations
    listAllocations, saveAllocation, deleteAllocation, personIdForName,
    distinctProjects, distinctClients, allocationWindow, defaultWindow,
    // engine
    personLoad, personAllocationsIn, bandwidthGrid, projectRollup, matchFeeProject,
    expectedHours, actualHours, varianceMatrix, hasActuals, actualsMeta, feePlanHours,
    // clockify
    analyzeClockify, commitClockify, clearActuals,
    // helpers
    namesMatch, cleanName, isNewHireName,
  };
})();
