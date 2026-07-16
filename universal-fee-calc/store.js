/* ============================================================
   SAVILLS PPM · FEE SYSTEM · localStorage data store
   Schema-versioned project records.
   ============================================================ */
(function () {
  'use strict';
  const KEY = 'savills-ppm-fee-db:v1';
  const STUDIO_KEY = 'savills-ppm-studio-db:v1';   // Revenue Studio — SEPARATE store/file
  const SCHEMA = 2;

  const STATUSES = ['draft','submitted','negotiation','won','lost','active','closed','hold'];
  const STATUS_LABELS = {
    draft: 'Draft',
    submitted: 'Submitted',
    negotiation: 'In negotiation',
    won: 'Won',
    lost: 'Lost',
    active: 'Active',
    closed: 'Closed out',
    hold: 'On hold',
  };

  /* Why a proposal was lost — captured on the record when status = 'lost',
     so win/loss analytics can answer "why do we lose?". */
  const LOST_REASONS = ['Too expensive', 'Relationship', 'Incumbent', 'Scope', 'Procurement', 'Client cancelled', 'Internal / no-bid', 'No decision', 'Other'];

  /* Standard proposal assumptions / exclusions — the conditions a fee is
     priced under. Captured as a checklist on the record so two proposals are
     actually comparable (a $5M with decommissioning ≠ a $5M without). Users
     pick from this library and may add custom lines. */
  const ASSUMPTION_LIBRARY = [
    'Client provides movers',
    'Night / weekend work',
    'Standard business hours only',
    'No swing space required',
    'Single occupancy / phased move',
    'Furniture reused (no new FF&E)',
    'FF&E procurement included',
    'No IT disconnect / reconnect',
    'Client-managed IT/AV',
    'No decommissioning',
    'Decommissioning included',
    'Vendor-managed logistics',
    'Client provides building / security access',
    'Client supplies inventory & data',
    'No change management',
    'Permitting by others',
    'Single phase / single building',
  ];

  /* Revenue-projection probability rating (the 1–7 scale used today).
     Coexists with the lifecycle status above; `weight` is the probability
     used for any weighted view. 1 = booked, 7 = dead. */
  const RATINGS = [
    { n: 1, label: 'Booked',        short: 'Booked',   weight: 1.00, booked: true },
    { n: 2, label: '90% and up',    short: '90%+',     weight: 0.95 },
    { n: 3, label: '75–89%',        short: '75–89%',   weight: 0.82 },
    { n: 4, label: '50–74%',        short: '50–74%',   weight: 0.62 },
    { n: 5, label: '25–49%',        short: '25–49%',   weight: 0.37 },
    { n: 6, label: 'Less than 25%', short: '<25%',     weight: 0.15 },
    { n: 7, label: 'Dead Pursuit',  short: 'Dead',     weight: 0.00, dead: true },
  ];
  /* Default rating when a project hasn't been rated explicitly — derived
     from its lifecycle status so existing records still sort sensibly. */
  const STATUS_DEFAULT_RATING = {
    active: 1, won: 2, closed: 1,
    negotiation: 4, submitted: 4, draft: 5,
    hold: 6, lost: 7,
  };
  function ratingFor(p) {
    const r = p && p.project && p.project.rating;
    if (r != null && r >= 1 && r <= 7) return r;
    return STATUS_DEFAULT_RATING[(p && p.project && p.project.status) || 'draft'] || 5;
  }
  function ratingMeta(n) { return RATINGS.find(r => r.n === n) || RATINGS[RATINGS.length - 1]; }

  /* Controlled service-line list — the service area a group's fees roll up to.
     Each group in a project carries a serviceLine; roles inherit their group's.
     Drives the by-service-line projection roll-up. */
  const SERVICE_LINES = [
    'Program & Project Management',
    'Change Management',
    'Workplace',
    'Relocation',
    'Other Savills Group',
  ];
  /* Best-effort map from a free-text group name to a controlled service line. */
  function inferServiceLine(name) {
    const s = (name || '').toLowerCase();
    if (/change|comm|engagement/.test(s)) return 'Change Management';
    if (/workplace|fit.?out|design|occupanc/.test(s)) return 'Workplace';
    if (/reloc|move|logist|field/.test(s)) return 'Relocation';
    if (/program|project|\bpm\b|\bppm\b|core|leadership|management|cost|report|data|analy/.test(s)) return 'Program & Project Management';
    return 'Other Savills Group';
  }
  /** Service lines a group's fees roll up to (array). Explicit group.serviceLines
      if set, else a single inferred line from the name. */
  function serviceLinesOfGroup(group) {
    if (!group) return ['Other Savills Group'];
    const arr = group.serviceLines;
    if (Array.isArray(arr) && arr.length) return arr.filter(s => SERVICE_LINES.includes(s));
    if (group.serviceLine && SERVICE_LINES.includes(group.serviceLine)) return [group.serviceLine];
    return [inferServiceLine(group.name)];
  }
  /** Back-compat single-value accessor (first tagged line). */
  function serviceLineOfGroup(group) { return serviceLinesOfGroup(group)[0] || 'Other Savills Group'; }
  /** Distinct service lines present in a project. */
  function projectServiceLines(p) {
    const set = new Set();
    (p.groups || []).forEach(g => serviceLinesOfGroup(g).forEach(s => set.add(s)));
    return [...set];
  }
  const INDUSTRIES = [
    'Financial Services',
    'Law',
    'TAMI',
    'Retail',
    'Data Center',
    'Life Sciences',
    'Healthcare',
    'Industrial',
    'Public Sector',
    'Education',
    'Hospitality',
    'Other',
  ];

  /* Project Type — the service line / engagement type, distinct from the client's
     Industry. Each type has a bucket of representative sub-services shown once the
     type is selected. Drawn from the Savills PPM service taxonomy. */
  const PROJECT_TYPES = [
    { name: 'Relocation & Migration', subs: ['Corporate relocations', 'Restacks', 'Occupancy changes', 'Employee moves', 'Headquarters transitions'] },
    { name: 'Workplace Transformation', subs: ['Change management', 'Workplace strategy', 'Hybrid work initiatives', 'Employee engagement and readiness programs', 'Organizational transformation'] },
    { name: 'Capital Projects & Construction', subs: ['Tenant fit-outs', 'Renovations', 'New office development', 'Construction oversight', "Owner's representation"] },
    { name: 'Program & Portfolio Management', subs: ['PMO services', 'Multi-project governance', 'Portfolio planning', 'Executive reporting', 'Enterprise-wide initiatives'] },
    { name: 'Furniture, Equipment & Procurement', subs: ['FF&E management', 'Procurement support', 'Medical equipment projects', 'Vendor sourcing and selection', 'Asset deployment'] },
    { name: 'Real Estate Strategy & Advisory', subs: ['Site selection', 'Due diligence', 'Portfolio optimization', 'Occupancy planning', 'Strategic real estate consulting'] },
    { name: 'Operational Transition & Decommissioning', subs: ['Facility closures', 'Space decommissioning', 'Asset disposition', 'Business continuity planning', 'Transition management'] },
    { name: 'Technology & Infrastructure Deployment', subs: ['Technology relocations', 'Broadcast projects', 'Infrastructure migrations', 'Workplace technology implementations'] },
    { name: 'Specialized Consulting & Advisory', subs: ['Process improvement', 'Organizational assessments', 'Strategic planning', 'Custom client advisory engagements', 'Business case development'] },
    { name: 'Development Management', subs: ['New development', 'Core & shell', "Owner's representation"] },
  ];
  function projectTypeSubs(name) {
    const t = PROJECT_TYPES.find(x => x.name === name);
    return t ? t.subs : [];
  }

  function defaultDb() {
    return { schemaVersion: SCHEMA, projects: {}, activity: [] };
  }

  /* ===== Schema migration pipeline =====
     Each key upgrades the db FROM the prior version. Additive/defensive only —
     read sites all default their own fields, so an un-migrated db never crashes;
     this just normalizes shape and stamps the version. Runs once at boot. */
  const MIGRATIONS = {
    2: (db) => { if (!Array.isArray(db.activity)) db.activity = []; },
  };
  function runMigrations() {
    const raw = localStorage.getItem(KEY);
    if (!raw) return 0;
    let db;
    try { db = JSON.parse(raw); } catch (e) { return 0; }
    const from = db.schemaVersion || 1;
    if (from >= SCHEMA) return 0;
    for (let v = from + 1; v <= SCHEMA; v++) {
      if (MIGRATIONS[v]) { try { MIGRATIONS[v](db); } catch (e) { console.warn('migration ' + v + ' failed', e); } }
    }
    db.schemaVersion = SCHEMA;
    localStorage.setItem(KEY, JSON.stringify(db));   // local-only normalize; next real save pushes
    return SCHEMA - from;
  }

  function readDb() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaultDb();
      const parsed = JSON.parse(raw);
      if (!parsed.projects) return defaultDb();
      return parsed;
    } catch (e) {
      console.error('DB read failed', e);
      return defaultDb();
    }
  }

  function writeDb(db) {
    db.schemaVersion = SCHEMA;
    localStorage.setItem(KEY, JSON.stringify(db));
    // Sync layer: if a remote backend (Box) is attached, mirror local → remote.
    // No-op when nothing is attached, so the offline/localStorage app is unchanged.
    if (typeof _remotePush === 'function') { try { _remotePush(db); } catch (e) { console.warn('remote push failed', e); } }
  }

  /* ===== Activity log — append-only audit trail =====
     Rides inside projects.json (so it syncs to Box with the data). Union-merged
     by entry id in box-adapter's mergeDb, capped to the most recent entries.
     Records who did what: create, save, status change, book, delete, access grant. */
  const ACTIVITY_CAP = 500;
  function logActivity(action, projectId, meta) {
    try {
      const db = readDb();
      if (!Array.isArray(db.activity)) db.activity = [];
      const actor = (getCurrentUser() && getCurrentUser().username) || 'unknown';
      db.activity.push({
        id: 'act_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        ts: new Date().toISOString(),
        actor, action, projectId: projectId || null, meta: meta || null,
      });
      if (db.activity.length > ACTIVITY_CAP) db.activity = db.activity.slice(-ACTIVITY_CAP);
      // write WITHOUT re-logging; go straight to storage + push
      db.schemaVersion = SCHEMA;
      localStorage.setItem(KEY, JSON.stringify(db));
      if (typeof _remotePush === 'function') { try { _remotePush(db); } catch (e) {} }
    } catch (e) { /* logging must never break a save */ }
  }
  function listActivity(limit, projectId) {
    const db = readDb();
    let a = Array.isArray(db.activity) ? db.activity.slice() : [];
    if (projectId) a = a.filter(x => x.projectId === projectId);
    a.sort((x, y) => (y.ts || '').localeCompare(x.ts || ''));
    return limit ? a.slice(0, limit) : a;
  }

  /* Remote sync hook — set by a backend adapter (e.g. box-adapter.js) via
     Store.attachRemote(). Receives the full db after every local write so it
     can debounce-push to the remote store. */
  let _remotePush = null;
  function attachRemote(pushFn) { _remotePush = typeof pushFn === 'function' ? pushFn : null; }
  /** Replace local cache with a remote snapshot (used by boot/pull). Does NOT
      re-trigger a push. */
  function hydrateFromRemote(db) {
    if (!db || !db.projects) return;
    db.schemaVersion = SCHEMA;
    localStorage.setItem(KEY, JSON.stringify(db));
  }

  /* ===== Revenue Studio store — SEPARATE file (studio.json in Box) =====
     Baselines (frozen targets: Budget, RF1, RF2…) and named scenarios (what-if
     overlays). Kept apart from projects.json so manipulations never touch real
     project data and sync as their own file. */
  let _studioPush = null;
  function attachStudioRemote(pushFn) { _studioPush = typeof pushFn === 'function' ? pushFn : null; }
  function defaultStudio() { return { schemaVersion: SCHEMA, baselines: {}, scenarios: {} }; }
  function readStudio() {
    try {
      const raw = localStorage.getItem(STUDIO_KEY);
      if (!raw) return defaultStudio();
      const p = JSON.parse(raw);
      if (!p.baselines) p.baselines = {};
      if (!p.scenarios) p.scenarios = {};
      return p;
    } catch (e) { return defaultStudio(); }
  }
  function writeStudio(s) {
    s.schemaVersion = SCHEMA;
    localStorage.setItem(STUDIO_KEY, JSON.stringify(s));
    if (typeof _studioPush === 'function') { try { _studioPush(s); } catch (e) { console.warn('studio push failed', e); } }
  }
  function hydrateStudioFromRemote(s) {
    if (!s) return;
    if (!s.baselines) s.baselines = {};
    if (!s.scenarios) s.scenarios = {};
    s.schemaVersion = SCHEMA;
    localStorage.setItem(STUDIO_KEY, JSON.stringify(s));
  }

  const MONTHS12 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // ---- Baselines ----
  function listBaselines() {
    return Object.values(readStudio().baselines).sort((a, b) => (a.order || 0) - (b.order || 0) || (a.submittedAt || '').localeCompare(b.submittedAt || ''));
  }
  function getBaseline(id) { return readStudio().baselines[id] || null; }
  function saveBaseline(b) {
    const s = readStudio();
    if (!b.id) b.id = 'bl_' + Math.random().toString(36).slice(2, 10);
    if (b.order == null) b.order = Object.keys(s.baselines).length;
    s.baselines[b.id] = b;
    writeStudio(s);
    return b;
  }
  function deleteBaseline(id) { const s = readStudio(); delete s.baselines[id]; writeStudio(s); }

  /** Build a frozen baseline from a {client: annualAmount} map (the Budget sheet).
      Flatlines each client's annual ÷ 12 across the given year. */
  function baselineFromBudget(name, kind, year, clientAnnual, submittedAt) {
    const byClient = {}; const byMonth = {}; let total = 0;
    for (let m = 1; m <= 12; m++) byMonth[year + '-' + m] = 0;
    Object.keys(clientAnnual).forEach(client => {
      const annual = +clientAnnual[client] || 0;
      if (!annual) return;
      const per = annual / 12;
      const grid = {};
      for (let m = 1; m <= 12; m++) { const k = year + '-' + m; grid[k] = per; byMonth[k] += per; }
      byClient[client] = { annual, byMonth: grid };
      total += annual;
    });
    return {
      id: '', name, kind: kind || 'budget', year,
      submittedAt: submittedAt || (year + '-01-01'),
      monthlyMode: 'flatline',
      total, byMonth, byClient,
    };
  }

  /** A baseline's monthly grid for a slice (currently client or 'all'). */
  function baselineGridForSlice(baseline, slice) {
    if (!baseline) return {};
    if (!slice || slice.dim === 'all' || !slice.value) return baseline.byMonth || {};
    if (slice.dim === 'client') return (baseline.byClient[slice.value] || {}).byMonth || {};
    return baseline.byMonth || {};
  }

  // ---- Scenarios (named what-if overlays) ----
  function listScenarios() {
    return Object.values(readStudio().scenarios).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }
  function getScenario(id) { return readStudio().scenarios[id] || null; }
  function saveScenario(sc) {
    const s = readStudio();
    if (!sc.id) sc.id = 'sc_' + Math.random().toString(36).slice(2, 10);
    sc.updatedAt = new Date().toISOString();
    if (!sc.createdAt) sc.createdAt = sc.updatedAt;
    if (!sc.adjustments) sc.adjustments = [];
    s.scenarios[sc.id] = sc;
    writeStudio(s);
    return sc;
  }
  function deleteScenario(id) { const s = readStudio(); delete s.scenarios[id]; writeStudio(s); }

  function listProjects() {
    const db = readDb();
    return Object.values(db.projects)
      .filter(p => !p._deleted)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  /** Raw project map incl. tombstones — for migrations/merge only. */
  function allProjectsRaw() { return readDb().projects; }

  /** One-time cleanup: stamp the canonical leadId on records whose lead was
      stored as initials/free-text (e.g. imported "BLJ"). Resolves via the
      leaders directory (incl. the initials aliases) and persists once. */
  function migrateLeadIds() {
    const db = readDb();
    let changed = 0;
    Object.values(db.projects).forEach(p => {
      const pj = p.project || {};
      if (pj.leadId && leaderById(pj.leadId)) return;          // already canonical
      const l = resolveLeader(pj.leadId || pj.lead);
      if (l && pj.leadId !== l.id) { pj.leadId = l.id; pj.lead = l.displayName; changed++; }
    });
    if (changed) writeDb(db);
    return changed;
  }

  function getProject(id) {
    const p = readDb().projects[id];
    return (p && !p._deleted) ? p : null;
  }

  function saveProject(record) {
    const db = readDb();
    const prev = record.id ? db.projects[record.id] : null;
    const isNew = !record.id;
    if (!record.id) record.id = 'proj_' + Math.random().toString(36).slice(2, 11);
    if (!record.createdAt) record.createdAt = new Date().toISOString();
    record.updatedAt = new Date().toISOString();
    maybeSnapshotFinancials(record);   // freeze derived figures once booked
    maybeAutoVersion(record, prev);    // capture a version when status crosses a lifecycle milestone
    db.projects[record.id] = record;
    writeDb(db);
    // Audit trail (never let logging failure break a save)
    try {
      const newStatus = record.project && record.project.status;
      const oldStatus = prev && prev.project && prev.project.status;
      if (isNew) {
        logActivity('create', record.id, { name: record.project && record.project.name, status: newStatus });
      } else if (oldStatus !== newStatus) {
        const booked = ['won', 'active', 'closed'].includes(newStatus);
        logActivity(booked ? 'book' : 'status', record.id, { from: oldStatus, to: newStatus });
      }
    } catch (e) {}
    return record;
  }

  /* Soft-delete: leave a tombstone (not a hard delete) so the deletion
     propagates through the newest-updatedAt-wins Box merge. A hard delete only
     removes it locally and the record resurrects from another device's copy. */
  function deleteProject(id) {
    const db = readDb();
    const p = db.projects[id];
    if (!p) return;
    const now = new Date().toISOString();
    db.projects[id] = {
      id, _deleted: true, deletedAt: now, updatedAt: now,
      deletedBy: (getCurrentUser() && getCurrentUser().username) || null,
      // keep a minimal stub for audit/undelete; drop the heavy payload
      project: { name: (p.project && p.project.name) || '', client: (p.project && p.project.client) || '' },
    };
    writeDb(db);
    logActivity('delete', id, { name: db.projects[id].project.name });
  }

  /** Undo a soft-delete within the retention window (tombstone still present). */
  function restoreDeleted(id) {
    const db = readDb();
    const p = db.projects[id];
    if (p && p._deleted) { delete db.projects[id]; writeDb(db); }
    return null;
  }

  /** Sweep tombstones older than `days` (default 120) so the file doesn't grow
     unbounded. Runs once on load. */
  function purgeTombstones(days) {
    const cutoff = Date.now() - (days || 120) * 86400000;
    const db = readDb();
    let purged = 0;
    Object.entries(db.projects).forEach(([id, p]) => {
      if (p._deleted && p.deletedAt && new Date(p.deletedAt).getTime() < cutoff) {
        delete db.projects[id]; purged++;
      }
    });
    if (purged) writeDb(db);
    return purged;
  }

  function exportDb() {
    return JSON.stringify(readDb(), null, 2);
  }

  /* ============================================================
     PROPOSAL VERSION HISTORY — append-only snapshots of a proposal.
     ------------------------------------------------------------
     One project record carries its whole lifecycle: v1, v2, v3 …
     Each version freezes the COMPLETE input state (so it can be
     restored), the headline totals, and a roster snapshot (so any
     two versions diff like a change order). Captured two ways:
       • Manually  — "Save version" with an optional label + note.
       • Automatically — when status crosses a lifecycle milestone
         (Submitted / Awarded / Lost), so a history exists even if
         nobody clicks save.
     Versions never roll into any total — they are an audit trail.
     ============================================================ */
  const VERSION_MILESTONES = { submitted: 'Submitted', won: 'Awarded', lost: 'Lost' };

  function realIdentityLabel() {
    const r = getRealIdentity();
    if (!r) return { username: '', name: '' };
    return { username: r.username || '', name: r.name || '' };
  }

  function versionInputs(record) {
    return JSON.parse(JSON.stringify({
      project: record.project || {}, timeline: record.timeline || {},
      roles: record.roles || [], phases: record.phases || [],
      groups: record.groups || [], assumptions: record.assumptions || {},
      passthrough: record.passthrough || null,
    }));
  }

  function buildVersion(record, opts) {
    opts = opts || {};
    const catalog = (typeof window !== 'undefined') && window.RATES_CATALOG;
    let gross = null, net = null;
    if (catalog && catalog.hydrated) {
      const fin = computeFinancials(record, catalog);
      if (fin) { gross = fin.gross; net = fin.net; }
    }
    const existing = record.versions || [];
    return {
      id: 'v_' + Math.random().toString(36).slice(2, 10),
      n: existing.length + 1,
      label: (opts.label || '').trim(),
      note: (opts.note || '').trim(),
      auto: !!opts.auto,
      savedAt: new Date().toISOString(),
      savedBy: realIdentityLabel(),
      status: record.project && record.project.status,
      rating: record.project && record.project.rating,
      gross: gross, net: net,
      roster: rosterSnapshot(record),
      inputs: versionInputs(record),
    };
  }

  /** Capture the current state of project `id` as a new version. */
  function saveVersion(id, opts) {
    const db = readDb();
    const r = db.projects[id];
    if (!r) return null;
    r.versions = r.versions || [];
    const v = buildVersion(r, opts);
    r.versions.push(v);
    r.updatedAt = new Date().toISOString();
    writeDb(db);
    return v;
  }

  /** Internal: append a milestone version when status transitions. Runs inside saveProject. */
  function maybeAutoVersion(record, prev) {
    const status = record.project && record.project.status;
    const milestone = VERSION_MILESTONES[status];
    if (!milestone) return;
    const prevStatus = prev && prev.project && prev.project.status;
    if (prevStatus === status) return;                 // no transition this save → don't capture
    record.versions = record.versions || [];
    record.versions.push(buildVersion(record, { label: milestone, auto: true }));
  }

  function listVersions(project) {
    return ((project && project.versions) || []).slice().sort((a, b) => a.n - b.n);
  }

  /* ============================================================
     PROPOSAL HEALTH SCORE — a 0–100 composite that turns the
     calculator into a decision-support signal. Weighted blend of
     four robustly-computable signals; band thresholds give the
     🟢 / 🟡 / 🔴 triage. `fee` (net) is passed in so callers can
     reuse the fee they already computed.
     ============================================================ */
  function proposalHealth(p, fee) {
    const pj = p.project || {};
    const a = p.assumptions || {};
    const signals = [];

    // 1 · Win confidence (rating 1–7). weight 0.30
    const rating = ratingFor(p);
    const winMap = { 1: 100, 2: 85, 3: 65, 4: 50, 5: 30, 6: 15, 7: 0 };
    const winScore = winMap[rating] != null ? winMap[rating] : 50;
    signals.push({ key: 'win', label: 'Win confidence', score: winScore, weight: 0.30,
      detail: 'Rating ' + (rating || '—') });

    // 2 · Discount discipline. weight 0.25
    const disc = a.discount || 0;
    const discScore = disc <= 5 ? 100 : disc <= 10 ? 82 : disc <= 15 ? 64 : disc <= 20 ? 45 : disc <= 30 ? 25 : 8;
    signals.push({ key: 'discount', label: 'Discount discipline', score: discScore, weight: 0.25,
      detail: disc ? disc.toFixed(1) + '% discount' : 'no discount' });

    // 3 · Staffing defined — priced roles with allocation (imported / blank = can't validate). weight 0.25
    const roles = p.roles || [];
    const hasAlloc = roles.some(r => {
      const m = r.fteMonthly && Object.values(r.fteMonthly).some(v => v > 0);
      const ph = r.fte && Object.values(r.fte).some(v => v > 0);
      return m || ph;
    });
    const importedBlank = p.source && p.source.importedByMonth && !roles.length;
    const staffScore = hasAlloc ? 100 : importedBlank ? 25 : roles.length ? 55 : 10;
    signals.push({ key: 'staffing', label: 'Staffing defined', score: staffScore, weight: 0.25,
      detail: hasAlloc ? roles.length + ' roles allocated' : importedBlank ? 'imported $ only' : roles.length ? 'roles unallocated' : 'no staffing' });

    // 4 · Completeness — type, assumptions, lead, dates. weight 0.20
    let comp = 0;
    if (pj.projectType) comp += 30;
    if (Array.isArray(pj.assumptionsList) && pj.assumptionsList.length) comp += 25;
    if (pj.leadId || pj.lead) comp += 25;
    if (pj.firstProposalDate || pj.proposalDate) comp += 20;
    signals.push({ key: 'completeness', label: 'Completeness', score: comp, weight: 0.20,
      detail: comp >= 80 ? 'well documented' : comp >= 50 ? 'partly documented' : 'sparse' });

    const score = Math.round(signals.reduce((s, x) => s + x.score * x.weight, 0));
    const band = score >= 70 ? 'green' : score >= 45 ? 'yellow' : 'red';
    const bandLabel = band === 'green' ? 'Healthy' : band === 'yellow' ? 'Needs review' : 'Executive review';
    return { score, band, bandLabel, signals };
  }

  /** Generic role-level diff between two roster snapshots: added / removed / changed. */
  function rosterDiff(baseRoster, nowRoster) {
    const base = baseRoster || {}, now = nowRoster || {};
    const added = [], removed = [], changed = [];
    Object.keys(now).forEach(id => {
      const n = now[id], b = base[id];
      const label = (n.projectRole || '').trim() || n.resource || 'role';
      if (!b) { if (n.fteMonths > 0.001) added.push({ label, fteMonths: n.fteMonths }); return; }
      const rateChanged = b.titleId !== n.titleId || b.tierId !== n.tierId
        || b.rateSource !== n.rateSource || b.contractedRate !== n.contractedRate;
      const fteDelta = Math.round((n.fteMonths - b.fteMonths) * 100) / 100;
      if (rateChanged || Math.abs(fteDelta) > 0.01) changed.push({ label, fteDelta, rateChanged });
    });
    Object.keys(base).forEach(id => {
      if (!now[id] && base[id].fteMonths > 0.001) {
        const b = base[id];
        removed.push({ label: (b.projectRole || '').trim() || b.resource || 'role', fteMonths: b.fteMonths });
      }
    });
    return { added, removed, changed };
  }

  function versionRoster(project, vid) {
    if (vid === 'current') return rosterSnapshot(project);
    const v = (project.versions || []).find(x => x.id === vid);
    return v ? v.roster : {};
  }
  function versionTotals(project, vid) {
    if (vid === 'current') {
      const catalog = (typeof window !== 'undefined') && window.RATES_CATALOG;
      const fin = (catalog && catalog.hydrated) ? computeFinancials(project, catalog) : null;
      return fin ? { gross: fin.gross, net: fin.net } : { gross: null, net: null };
    }
    const v = (project.versions || []).find(x => x.id === vid);
    return v ? { gross: v.gross, net: v.net } : { gross: null, net: null };
  }
  /** Diff two versions (or a version vs 'current'): role changes + total deltas. */
  function versionDiff(project, vidA, vidB) {
    return {
      roles: rosterDiff(versionRoster(project, vidA), versionRoster(project, vidB)),
      a: versionTotals(project, vidA),
      b: versionTotals(project, vidB),
    };
  }

  /** Reconstruct a full record from a version's frozen inputs (id + history preserved).
      Returns a NEW object — NOT written — for the calculator to load into state. */
  function restoreVersionRecord(project, vid) {
    const v = (project.versions || []).find(x => x.id === vid);
    if (!v) return null;
    const rec = JSON.parse(JSON.stringify(project));          // keep id, versions, financials, createdAt
    Object.assign(rec, JSON.parse(JSON.stringify(v.inputs))); // overwrite inputs from the version
    return rec;
  }

  /* ============================================================
     FLASH SNAPSHOTS — point-in-time captures of monthly projections
     ------------------------------------------------------------
     Each snapshot freezes, for a billing period (YYYY-MM), every
     project's projected revenue for that month, tagged with a label
     (#1 FLASH / #2 FINAL / #3 EOM) and an as-of date. The flash
     export diffs these so you can see how the number moved between
     submissions. Stored in the db under `snapshots`.
       db.snapshots = { "2026-04": { "#1 FLASH": {asOf, rows:{pid:{...}}}, ... } }
     ============================================================ */
  const FLASH_LABELS = ['#1 FLASH', '#2 FINAL', '#3 EOM'];
  function periodKey(year, month) { return year + '-' + String(month).padStart(2, '0'); }

  /** Capture the current projection for a period under a label. `rowsFor` is a
      function(project) → { projId, name, client, rating, amount } for the month. */
  function captureSnapshot(year, month, label, projects, rowsFor) {
    const db = readDb();
    db.snapshots = db.snapshots || {};
    const pk = periodKey(year, month);
    db.snapshots[pk] = db.snapshots[pk] || {};
    const rows = {};
    projects.forEach(p => { const r = rowsFor(p); if (r) rows[p.id] = r; });
    db.snapshots[pk][label] = { asOf: new Date().toISOString(), rows };
    writeDb(db);
    return db.snapshots[pk][label];
  }
  function getSnapshots(year, month) {
    const db = readDb();
    return (db.snapshots && db.snapshots[periodKey(year, month)]) || {};
  }
  function deleteSnapshot(year, month, label) {
    const db = readDb();
    if (db.snapshots && db.snapshots[periodKey(year, month)]) {
      delete db.snapshots[periodKey(year, month)][label];
      writeDb(db);
    }
  }

  function importDb(jsonStr, mode = 'merge') {
    const incoming = JSON.parse(jsonStr);
    if (!incoming.projects) throw new Error('Invalid file — no projects key.');
    if (mode === 'replace') {
      writeDb(incoming);
      return Object.keys(incoming.projects).length;
    } else {
      const db = readDb();
      Object.assign(db.projects, incoming.projects);
      writeDb(db);
      return Object.keys(incoming.projects).length;
    }
  }

  function downloadJson(filename, jsonStr) {
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ===== Convenience computed fields =====
  function projectGrossFee(p) {
    // Replicates calc engine without depending on app.js
    if (!p || !p.roles || !p.phases) return 0;
    const hrs = p.assumptions?.hrsPerMo || 173.33;
    const esc = (p.assumptions?.escalation || 0) / 100;
    const baseYear = p.assumptions?.catalogBaseYear || 2025;
    const startYear = p.timeline?.startYear || baseYear;

    // months by phase
    const monthsByPhase = computeMonthsByPhase(p);

    return p.roles.reduce((sum, r) => {
      return sum + p.phases.reduce((phSum, ph) => {
        const slice = monthsByPhase[ph.id] || [];
        const fte = ((() => {
          // month-canonical: average the phase's months (fteMonthly ?? phase)
          if (!slice.length) return 0;
          const sum = slice.reduce((a, m) => a + ((r.fteMonthly && r.fteMonthly[m.year + '-' + m.month] != null) ? r.fteMonthly[m.year + '-' + m.month] : (r.fte?.[ph.id] || 0)), 0);
          return sum / slice.length;
        })()) / 100;
        if (!fte) return phSum;
        const tierRate = r.__rate ?? 0;  // expected to be set externally
        return phSum + slice.reduce((s, m) => {
          // Published (unlocked) rate. Rate Lock is shown as a credit, never baked into gross.
          const rate = tierRate * Math.pow(1 + esc, m.year - baseYear);
          return s + fte * rate * hrs;
        }, 0);
      }, 0);
    }, 0);
  }

  function computeMonthsByPhase(p) {
    const months = enumerateMonths(p.timeline);
    const out = {};
    let i = 0;
    (p.phases || []).forEach(ph => {
      out[ph.id] = months.slice(i, i + (ph.length || 0));
      i += (ph.length || 0);
    });
    return out;
  }

  function enumerateMonths(t) {
    const out = [];
    if (!t) return out;
    let y = t.startYear, m = t.startMonth;
    let safety = 0;
    while (y < t.endYear || (y === t.endYear && m <= t.endMonth)) {
      out.push({ year: y, month: m });
      m++; if (m > 12) { m = 1; y++; }
      if (++safety > 240) break;
    }
    return out;
  }

  /** Snapshot of total fee + net fee + fte-months for a project, using a rates resolver. */
  function projectFinancials(p, getTierRate) {
    if (!p || !p.roles || !p.phases) return { gross: 0, lockCredit: 0, discount: 0, net: 0, fteMonths: 0 };
    const hrs = p.assumptions?.hrsPerMo || 173.33;
    const esc = (p.assumptions?.escalation || 0) / 100;
    const baseYear = p.assumptions?.catalogBaseYear || 2025;
    const startYear = p.timeline?.startYear || baseYear;
    const lockOn = !!p.assumptions?.rateLock;
    const discPct = (p.assumptions?.discount || 0) / 100;

    const monthsByPhase = computeMonthsByPhase(p);
    const phaseOfMonth = {};
    (p.phases || []).forEach(ph => (monthsByPhase[ph.id] || []).forEach(m => { phaseOfMonth[m.year + '-' + m.month] = ph.id; }));
    const months = enumerateMonths(p.timeline);

    let gross = 0, lockCredit = 0, fteMonths = 0;
    p.roles.forEach(r => {
      const tierRate = getTierRate(r);
      months.forEach(mObj => {                          // MONTH-CANONICAL: iterate months
        const mk = mObj.year + '-' + mObj.month;
        const phId = phaseOfMonth[mk];
        const fte = ((r.fteMonthly && r.fteMonthly[mk] != null) ? r.fteMonthly[mk] : (r.fte?.[phId] || 0)) / 100;
        if (!fte) return;
        fteMonths += fte;
        const unlocked = tierRate * Math.pow(1 + esc, mObj.year - baseYear);
        const locked   = tierRate * Math.pow(1 + esc, startYear - baseYear);
        gross += fte * unlocked * hrs;
        if (lockOn) lockCredit += Math.max(0, (unlocked - locked) * fte * hrs);
      });
    });
    const discount = (gross) * discPct;
    const net = gross - lockCredit - discount;
    return { gross, lockCredit, discount, net, fteMonths };
  }

  /* ============================================================
     FINANCIALS SNAPSHOT — frozen derived figures for reporting.
     ------------------------------------------------------------
     Records store inputs; the pipeline derives dollars live. For
     reporting (Power BI), we FREEZE the derived waterfall onto the
     record when it becomes booked (won/active/closed), so a signed
     fee never silently changes if the rate card, a bug fix, or an
     assumption changes later. Pre-booking records get no snapshot.
     If a booked record's fee-affecting inputs later change, we mark
     the snapshot `stale` (a change-order / re-stamp prompt) rather
     than overwriting the frozen number.
     ============================================================ */
  const ENGINE_VERSION = '2026.06';
  const BOOKED_STATUSES = new Set(['won', 'active', 'closed']);

  /** Stable signature of every fee-affecting input. Any change flips a booked
      snapshot to `stale`. */
  function financialsInputsHash(p) {
    const a = p.assumptions || {};
    const sig = JSON.stringify({
      t: p.timeline,
      ph: (p.phases || []).map(x => [x.id, x.length]),
      as: [a.hrsPerMo, a.escalation, a.industryAdj, a.discount, a.rateLock, a.billingMode, a.catalogBaseYear,
           a.feeShare && a.feeShare.enabled, a.feeShare && a.feeShare.pct, a.feeShare && a.feeShare.mode],
      r: (p.roles || []).map(r => [r.titleId, r.tierId, r.rateSource, r.contractedRate, r.groupId,
           r.fte, r.fteMonthly]),
      pt: (p.passthrough && p.passthrough.enabled) ? (p.passthrough.lines || []).map(l =>
           [l.label, l.cost, l.markupPct, l.mode, l.monthly]) : 0,
    });
    // djb2 → short hex
    let h = 5381; for (let i = 0; i < sig.length; i++) h = ((h << 5) + h + sig.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  /** Compute the full derived waterfall + by-month + by-group for a project.
      Fully MONTH-CANONICAL: one month-aware loop honors per-month FTE overrides
      (phase FTE is the fallback), so totals, byGroup and byMonth always agree —
      including when a change order staffs specific months. Returns null if it
      can't be priced. */
  function computeFinancials(p, catalog) {
    if (!p || !p.roles || !p.phases || !catalog) return null;
    const hrs = p.assumptions?.hrsPerMo || 173.33;
    const esc = (p.assumptions?.escalation || 0) / 100;
    const baseYear = p.assumptions?.catalogBaseYear || catalog.baseYear || 2024;
    const startYear = p.timeline?.startYear || baseYear;
    const lockOn = !!p.assumptions?.rateLock;
    const discPct = (p.assumptions?.discount || 0) / 100;
    const round2 = (n) => Math.round(n * 100) / 100;

    const months = enumerateMonths(p.timeline);
    const byPhase = computeMonthsByPhase(p);
    const phaseOfMonth = {};
    (p.phases || []).forEach(ph => (byPhase[ph.id] || []).forEach(m => { phaseOfMonth[m.year + '-' + m.month] = ph.id; }));

    let gross = 0, lock = 0, fteMonths = 0;
    const groupGross = {}, groupLock = {}, monthNet = {};
    p.roles.forEach(r => {
      const { base, anchorYear } = resolveRoleRate(r, catalog, p);
      months.forEach(m => {
        const mk = m.year + '-' + m.month;
        const phId = phaseOfMonth[mk];
        const fte = ((r.fteMonthly && r.fteMonthly[mk] != null) ? r.fteMonthly[mk] : (r.fte?.[phId] || 0)) / 100;
        if (!fte) return;
        fteMonths += fte;                                  // each month = one FTE-month unit
        if (!base) return;
        const unlocked = base * Math.pow(1 + esc, m.year - anchorYear);
        const locked = base * Math.pow(1 + esc, startYear - anchorYear);
        const g = fte * unlocked * hrs;
        const l = lockOn ? Math.max(0, (unlocked - locked) * fte * hrs) : 0;
        gross += g; lock += l;
        const grp = r.groupId || 'core';
        groupGross[grp] = (groupGross[grp] || 0) + g;
        groupLock[grp] = (groupLock[grp] || 0) + l;
        const ymKey = m.year + '-' + String(m.month).padStart(2, '0');
        monthNet[ymKey] = (monthNet[ymKey] || 0) + (g - l - g * discPct);   // net accrued this month
      });
    });
    if (!(gross > 0) && !(p.passthrough && p.passthrough.enabled && (p.passthrough.lines || []).some(l => (parseFloat(l.cost) || 0) > 0))) return null;   // nothing priced & no pass-through — don't freeze $0

    const discount = gross * discPct;
    const net = gross - lock - discount;
    const byGroup = Object.keys(groupGross).map(grp => {
      const gg = groupGross[grp], gl = groupLock[grp] || 0;
      return { group: grp, net: round2(gg - gl - gg * discPct) };
    });
    const feeSharePct = (p.assumptions?.feeShare && p.assumptions.feeShare.enabled)
      ? (parseFloat(p.assumptions.feeShare.pct) || 0) : 0;
    const feeShareMode = (p.assumptions?.feeShare && p.assumptions.feeShare.mode === 'ontop') ? 'ontop' : 'offtop';
    const fsFrac = feeSharePct / 100;

    // ---- Pass-through / principal billing (vendor cost billed THROUGH Savills) ----
    // Not fee: the COST flows straight out to the vendor; only the MARKUP is Savills
    // revenue. Walled off from discount / rate-lock / escalation. Distributed per
    // line across the timeline (explicit monthly overrides, else spread evenly).
    const pt = p.passthrough || {};
    const ptLines = (pt.enabled && Array.isArray(pt.lines)) ? pt.lines : [];
    const ymAll = months.map(m => m.year + '-' + String(m.month).padStart(2, '0'));
    // Per-month: passClientM = billed THROUGH Savills; passCostM = vendor cost that
    // flows OUT (billed lines only — managed vendors bill the client direct, so no
    // cost passes through us); passMarkM = the markup fee (revenue, both modes).
    const passClientM = {}, passCostM = {}, passMarkM = {};
    let ptClientTot = 0, ptCostTot = 0, ptMarkTot = 0;
    ptLines.forEach(line => {
      const cost = parseFloat(line.cost) || 0;
      const mk = (parseFloat(line.markupPct) || 0) / 100;
      if (!cost) return;
      const managed = line.mode === 'managed';   // direct-bill: Savills invoices only the fee
      const dist = {};
      const explicit = line.monthly && Object.keys(line.monthly).length;
      if (explicit) {
        Object.keys(line.monthly).forEach(ym => {
          const norm = ym.split('-')[0] + '-' + String(parseInt(ym.split('-')[1], 10)).padStart(2, '0');
          dist[norm] = (dist[norm] || 0) + (parseFloat(line.monthly[ym]) || 0);
        });
      } else if (ymAll.length) {
        const per = cost / ymAll.length;
        ymAll.forEach(ym => { dist[ym] = per; });
      }
      Object.keys(dist).forEach(ym => {
        const c = dist[ym];
        const markup = c * mk;
        // managed → client billed = markup fee only; billed → cost + markup.
        const client = managed ? markup : (c + markup);
        passClientM[ym] = (passClientM[ym] || 0) + client;
        passMarkM[ym] = (passMarkM[ym] || 0) + markup;
        if (!managed) passCostM[ym] = (passCostM[ym] || 0) + c;   // only billed cost flows through us
        ptClientTot += client;
        ptMarkTot += markup;
        if (!managed) ptCostTot += c;
      });
    });
    const ptCostTotal = round2(ptCostTot);
    const ptMarkupTotal = round2(ptMarkTot);
    const ptClientTotal = round2(ptClientTot);   // what the client is billed for pass-through (through Savills)

    // Materialized monthly billing series — read directly by Revenue Projections / Studio
    // (no re-derivation downstream). invoice = TOTAL the CLIENT is billed (fee on-top grossed
    // up + pass-through billed through Savills); broker = referral cut; net = Savills fee before
    // broker; passCost = vendor cost (flows out); passMarkup = Savills margin on pass-through.
    const ymUnion = Array.from(new Set([...Object.keys(monthNet), ...Object.keys(passClientM)])).sort();
    const byMonth = ymUnion.map(ym => {
      const n = round2(monthNet[ym] || 0);
      const broker = round2(n * fsFrac);
      const feeInvoice = round2(feeShareMode === 'ontop' ? n + broker : n);
      const passCost = round2(passCostM[ym] || 0);
      const passMarkup = round2(passMarkM[ym] || 0);
      const passClient = round2(passClientM[ym] || 0);
      const invoice = round2(feeInvoice + passClient);
      // Savills revenue this month = fee revenue (mode-aware) + pass-through markup.
      const feeRev = feeShareMode === 'ontop' ? n : round2(n - broker);
      const revenue = round2(feeRev + passMarkup);
      return { ym, net: n, broker, feeInvoice, passCost, passMarkup, passClient, invoice, revenue };
    });

    const feeShare = round2(net * fsFrac);   // broker $ — same in both modes
    // off-top: broker comes OUT of the fee (Savills keeps net−broker; client pays net).
    // on-top:  broker is added ON (Savills keeps net; client is billed net+broker).
    const feeClientBill = round2(feeShareMode === 'ontop' ? net + feeShare : net);
    const feeRevenue = round2(feeShareMode === 'ontop' ? net : net - feeShare);
    const clientBill = round2(feeClientBill + ptClientTotal);          // TOTAL client contract value
    const revenue = round2(feeRevenue + ptMarkupTotal);               // Savills net revenue

    // NTE: pass-through sits INSIDE the ceiling — the client-facing planned total
    // (fee net + pass-through client billing) is what the cap governs.
    const feeBasis = (p.assumptions?.feeBasis === 'nte') ? 'nte' : 'fixed';
    const nteCeiling = round2(parseFloat(p.assumptions?.nteCeiling) || 0);
    const nteBase = round2(net + ptClientTotal);
    const overCeiling = feeBasis === 'nte' && nteCeiling > 0 && nteBase > nteCeiling + 0.005;

    return {
      computedAt: new Date().toISOString(),
      engineVersion: ENGINE_VERSION,
      basis: 'booked',
      feeBasis,
      nteCeiling,
      overCeiling,
      gross: round2(gross),
      rateLockCredit: round2(lock),
      discount: round2(discount),
      net: round2(net),
      feeSharePct,
      feeShareMode,
      feeShare,
      clientBill,
      revenue,
      passThroughCost: ptCostTotal,
      passThroughMarkup: ptMarkupTotal,
      passThroughClient: ptClientTotal,
      feeClientBill,
      feeRevenue,
      fteMonths: Math.round(fteMonths * 100) / 100,
      byGroup,
      byMonth,
    };
  }

  /** On save: snapshot the financials. Fixed-fee booked records freeze (first
      time) and mark stale on later drift. NTE booked records auto-restamp every
      save — the ceiling is the contract, the monthly forecast is meant to flex. */
  function maybeSnapshotFinancials(record) {
    const status = record.project && record.project.status;
    const catalog = (typeof window !== 'undefined') && window.RATES_CATALOG;
    if (!catalog || !catalog.hydrated) return;          // rates not loaded → can't price
    const hash = financialsInputsHash(record);
    if (!BOOKED_STATUSES.has(status)) {
      // Pursuit: keep a LIVE materialized series so downstream views read (not re-derive).
      // Refreshes every save; never frozen, never stale.
      const fin = computeFinancials(record, catalog);
      if (fin) { fin.inputsHash = hash; fin.stale = false; fin.basis = 'live'; record.financials = fin; }
      else record.financials = null;                    // nothing priced yet → fall back to live compute
      return;
    }
    const isNTE = (record.assumptions && record.assumptions.feeBasis) === 'nte';
    if (isNTE) {
      // Auto-restamp: the forecast tracks the current allocations; never stale.
      const fin = computeFinancials(record, catalog);
      if (fin) { fin.inputsHash = hash; fin.stale = false; record.financials = fin; }
      return;
    }
    if (!record.financials) {
      const fin = computeFinancials(record, catalog);
      if (fin) { fin.inputsHash = hash; fin.stale = false; record.financials = fin; }
    } else if (record.financials.inputsHash !== hash) {
      record.financials.stale = true;                   // diverged — prompt re-stamp / change order
    }
  }

  /** Explicit re-stamp (e.g. an approved change order) — refreshes the frozen
      figures to the current inputs and clears `stale`. */
  function restampFinancials(id) {
    const db = readDb();
    const r = db.projects[id];
    const catalog = (typeof window !== 'undefined') && window.RATES_CATALOG;
    if (!r || !catalog) return null;
    const fin = computeFinancials(r, catalog);
    if (!fin) return null;
    fin.inputsHash = financialsInputsHash(r);
    fin.stale = false;
    r.financials = fin;
    writeDb(db);
    return r;
  }

  /* ============================================================
     CHANGE ORDERS — amendments to a booked contract.
     ------------------------------------------------------------
     Model: original contract + Σ approved change orders = revised
     contract. Each CO is a LINKED record (its own row), forked as a
     full copy of the running revised scope, edited to the new total,
     and frozen on approval. The CO's *value* is the incremental net
     vs. the contract it forked from (can be negative = de-scope).
       • CO amends the PARENT's Salesforce ID (no new SF project).
       • Incremental scope — the baseline curve is never reset; the CO
         delta naturally starts wherever the months differ.
       • Per-month is canonical on a CO (phase FTE expanded to months).
       • Only APPROVED (booked + snapshotted) COs roll into the revised
         contract.
     ============================================================ */
  const MON3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function monYearLabel(d) { return MON3[d.getMonth()] + ' ' + d.getFullYear(); }

  function isChangeOrder(p) { return !!(p && p.changeOrder && p.changeOrder.parentId); }
  function childChangeOrders(parentId) {
    return listProjects().filter(p => isChangeOrder(p) && p.changeOrder.parentId === parentId)
      .sort((a, b) => (a.changeOrder.coNumber || 0) - (b.changeOrder.coNumber || 0));
  }
  function approvedChangeOrders(parentId) {
    return childChangeOrders(parentId).filter(co =>
      BOOKED_STATUSES.has(co.project && co.project.status) && co.financials && !co.financials.stale);
  }

  /** Expand every role's phase FTE into explicit per-month values, so a CO is
      edited and diffed at month granularity (phase becomes a rollup). */
  function expandRolesToMonthly(p) {
    const byPhase = computeMonthsByPhase(p);
    const phaseOfMonth = {};
    (p.phases || []).forEach(ph => (byPhase[ph.id] || []).forEach(m => { phaseOfMonth[m.year + '-' + m.month] = ph.id; }));
    const months = enumerateMonths(p.timeline);
    (p.roles || []).forEach(r => {
      const fm = r.fteMonthly || {};
      months.forEach(m => {
        const mk = m.year + '-' + m.month;
        if (fm[mk] == null) {
          const phId = phaseOfMonth[mk];
          fm[mk] = (r.fte && r.fte[phId]) || 0;
        }
      });
      r.fteMonthly = fm;
    });
  }

  /** A {ym: net} map from a financials byMonth array. */
  function byMonthMap(fin) {
    const out = {};
    (fin && fin.byMonth || []).forEach(x => { out[x.ym] = x.net; });
    return out;
  }

  /** The revised contract = baseline (parent's frozen contract) + Σ approved CO
      deltas. Returns totals + a per-CO ledger + the combined byMonth curve. */
  function revisedContract(parentId) {
    const parent = getProject(parentId);
    const baseFin = parent && parent.financials;
    const baselineNet = (baseFin && baseFin.net) || 0;
    const curve = byMonthMap(baseFin || {});
    const cos = approvedChangeOrders(parentId);
    let coNetSum = 0;
    const ledger = cos.map(co => {
      const d = changeOrderDelta(co);
      coNetSum += d.net;
      d.byMonth.forEach(x => { curve[x.ym] = (curve[x.ym] || 0) + x.net; });
      return { id: co.id, coNumber: co.changeOrder.coNumber, coDate: co.changeOrder.coDate, net: d.net, status: co.project.status };
    });
    const byMonth = Object.keys(curve).sort().map(ym => ({ ym, net: Math.round(curve[ym] * 100) / 100 }));
    return {
      parentId, baselineNet,
      coNetSum: Math.round(coNetSum * 100) / 100,
      revisedNet: Math.round((baselineNet + coNetSum) * 100) / 100,
      coCount: cos.length, ledger, byMonth,
    };
  }

  /** A compact roster snapshot (id → role identity + total FTE-months) for diffing. */
  function rosterSnapshot(p) {
    const months = enumerateMonths(p.timeline);
    const byPhase = computeMonthsByPhase(p);
    const phaseOfMonth = {};
    (p.phases || []).forEach(ph => (byPhase[ph.id] || []).forEach(m => { phaseOfMonth[m.year + '-' + m.month] = ph.id; }));
    const out = {};
    (p.roles || []).forEach(r => {
      let fteMonths = 0;
      months.forEach(m => {
        const mk = m.year + '-' + m.month;
        fteMonths += ((r.fteMonthly && r.fteMonthly[mk] != null) ? r.fteMonthly[mk] : (r.fte?.[phaseOfMonth[mk]] || 0)) / 100;
      });
      out[r.id] = {
        titleId: r.titleId, tierId: r.tierId, rateSource: r.rateSource,
        contractedRate: r.contractedRate,
        resource: r.resource || '', projectRole: r.projectRole || '',
        fteMonths: Math.round(fteMonths * 100) / 100,
      };
    });
    return out;
  }

  /** Role-level diff of a CO vs. its frozen baseline roster: added / removed /
      changed (rate or FTE-months). Drives the differences-only panel. */
  function changeOrderRoleDiff(co) {
    const base = (co.changeOrder && co.changeOrder.baselineRoster) || {};
    return rosterDiff(base, rosterSnapshot(co));
  }

  /** The incremental value of a CO vs. the contract it forked from. The CO side
      is computed LIVE (so the delta updates as you edit a draft CO); the baseline
      it's compared to was frozen onto the CO at fork time. */
  function changeOrderDelta(co) {
    const catalog = (typeof window !== 'undefined') && window.RATES_CATALOG;
    const coFin = (co.financials && !co.financials.stale) ? co.financials
      : (catalog ? computeFinancials(co, catalog) : null);
    const baseMap = (co.changeOrder && co.changeOrder.baselineByMonth) || {};
    const coMap = byMonthMap(coFin || {});
    const baselineNet = (co.changeOrder && co.changeOrder.baselineNet) || 0;
    const coNet = (coFin && coFin.net) || 0;
    const yms = new Set([...Object.keys(baseMap), ...Object.keys(coMap)]);
    const byMonth = [...yms].sort().map(ym => ({ ym, net: Math.round(((coMap[ym] || 0) - (baseMap[ym] || 0)) * 100) / 100 }))
      .filter(x => Math.abs(x.net) > 0.005);
    return {
      net: Math.round((coNet - baselineNet) * 100) / 100,
      effectiveYM: byMonth.length ? byMonth[0].ym : null,
      byMonth,
    };
  }

  /** Fork a change order from a booked parent (or its latest approved CO). The
      CO is a full, month-canonical copy of the running revised scope, named
      "{Parent} — CHANGE ORDER n (Mon YYYY)", sharing the parent's Salesforce ID,
      with the prior contract frozen onto it as the diff baseline. */
  function createChangeOrder(parentId) {
    const db = readDb();
    const parent = db.projects[parentId];
    if (!parent) return { error: 'Parent project not found.' };
    if (!BOOKED_STATUSES.has(parent.project && parent.project.status) || !parent.financials) {
      return { error: 'A change order can only amend a booked project that has a frozen contract.' };
    }
    const catalog = (typeof window !== 'undefined') && window.RATES_CATALOG;
    if (!catalog || !catalog.hydrated) return { error: 'Rate card not loaded — cannot price the change order yet.' };

    const approved = approvedChangeOrders(parentId);
    const forkFrom = approved.length ? approved[approved.length - 1] : parent;
    const prior = revisedContract(parentId);          // contract value BEFORE this CO
    const coNumber = childChangeOrders(parentId).reduce((m, co) => Math.max(m, co.changeOrder.coNumber || 0), 0) + 1;
    const now = new Date();

    const clone = JSON.parse(JSON.stringify(forkFrom));
    delete clone.financials; delete clone.createdAt; delete clone.updatedAt;
    const baseName = (parent.project && parent.project.name || 'Project').replace(/ — CHANGE ORDER.*$/, '');
    clone.id = 'co_' + Math.random().toString(36).slice(2, 11);
    clone.project = Object.assign({}, clone.project, {
      name: `${baseName} — CHANGE ORDER ${coNumber} (${monYearLabel(now)})`,
      status: 'draft',
      salesforceId: (parent.project && parent.project.salesforceId) || '',   // amend the parent's SF ID
      intakeSent: false,
    });
    clone.changeOrder = {
      parentId,
      coNumber,
      coDate: now.toISOString().slice(0, 10),
      baselineNet: prior.revisedNet,
      baselineByMonth: prior.byMonth.reduce((o, x) => { o[x.ym] = x.net; return o; }, {}),
      baselineRoster: rosterSnapshot(forkFrom),       // for the differences-only diff
    };
    expandRolesToMonthly(clone);                       // per-month canonical
    clone.createdAt = clone.updatedAt = now.toISOString();
    db.projects[clone.id] = clone;
    writeDb(db);
    return { ok: true, co: clone };
  }

  /** Approve a CO: freeze its financials snapshot and mark it booked-active so it
      rolls into the revised contract. */
  function approveChangeOrder(id) {
    const db = readDb();
    const co = db.projects[id];
    if (!co || !isChangeOrder(co)) return { error: 'Not a change order.' };
    const catalog = (typeof window !== 'undefined') && window.RATES_CATALOG;
    const fin = catalog && computeFinancials(co, catalog);
    if (!fin) return { error: 'Nothing priced to approve.' };
    fin.inputsHash = financialsInputsHash(co);
    fin.stale = false;
    co.financials = fin;
    co.project.status = 'active';
    co.updatedAt = new Date().toISOString();
    writeDb(db);
    return { ok: true, co };
  }

  /** Roll up projects by client: contract + revised + CO count. Parents only
      (COs fold into their parent's revised total). */
  function clientRollup(projects, feeOf) {
    const list = (projects || listProjects()).filter(p => !isChangeOrder(p));
    const byClient = {};
    list.forEach(p => {
      const c = (p.project && p.project.client) || '—';
      const rc = revisedContract(p.id);
      // Baseline net = frozen snapshot if present, else compute live via the
      // supplied resolver (handles imported-by-month + never-booked projects,
      // which carry no financials snapshot). Revised = baseline + Σ CO deltas.
      let baseline = (p.financials && p.financials.net);
      if (!baseline && typeof feeOf === 'function') { try { baseline = feeOf(p); } catch (e) {} }
      baseline = baseline || 0;
      const b = byClient[c] || (byClient[c] = { client: c, projects: 0, baseline: 0, revised: 0, coCount: 0 });
      b.projects++;
      b.baseline += baseline;
      b.revised += baseline + (rc.coNetSum || 0);
      b.coCount += rc.coCount;
    });
    return Object.values(byClient).map(b => ({
      ...b,
      baseline: Math.round(b.baseline * 100) / 100,
      revised: Math.round(b.revised * 100) / 100,
    })).sort((a, b) => b.revised - a.revised);
  }

  /** Per-calendar-month invoice series for a project — the amount billed each
      month, respecting billing mode (flatline = even net/months; phase = net
      accrued that month). Returns [{ year, month, amount }]. `catalog` is the
      rates catalog (window.RATES_CATALOG). */
  function monthlySeries(p, catalog, opts) {
    if (!p || !p.roles || !p.phases || !p.timeline) return [];
    const months = enumerateMonths(p.timeline);
    if (!months.length) return [];
    const slFilter = opts && opts.serviceLine;
    // Imported projects: the monthly $ from the source sheet is canonical and
    // stays locked (so projections never move as staffing is built) until the
    // project is explicitly reconciled. Not sliced by service line.
    const imp = p.source && p.source.importedByMonth;
    if (imp && !slFilter && !(p.source && p.source.reconciled)) {
      return months.map(m => ({ year: m.year, month: m.month, amount: +imp[m.year + '-' + m.month] || 0 }));
    }
    // Which group ids are in the requested service line (if filtering)
    let allowedGroups = null;
    if (slFilter) {
      allowedGroups = new Set((p.groups || []).filter(g => serviceLinesOfGroup(g).includes(slFilter)).map(g => g.id));
    }
    const roles = slFilter ? (p.roles || []).filter(r => allowedGroups.has(r.groupId)) : (p.roles || []);
    const hrs = p.assumptions?.hrsPerMo || 173.33;
    const esc = (p.assumptions?.escalation || 0) / 100;
    const startYear = p.timeline?.startYear || (p.assumptions?.catalogBaseYear || 2024);
    const lockOn = !!p.assumptions?.rateLock;
    const discPct = (p.assumptions?.discount || 0) / 100;

    const byPhase = computeMonthsByPhase(p);
    const phaseOfMonth = {};
    (p.phases || []).forEach(ph => (byPhase[ph.id] || []).forEach(m => { phaseOfMonth[m.year + '-' + m.month] = ph.id; }));

    let totalGross = 0, totalLock = 0;
    const rows = months.map(m => {
      const phId = phaseOfMonth[m.year + '-' + m.month];
      let gross = 0, lockC = 0;
      roles.forEach(r => {
        const mk = m.year + '-' + m.month;
        const fte = ((r.fteMonthly && r.fteMonthly[mk] != null ? r.fteMonthly[mk] : (r.fte?.[phId] || 0)) || 0) / 100;
        if (!fte) return;
        const { base, anchorYear } = resolveRoleRate(r, catalog, p);
        if (!base) return;
        const unlocked = base * Math.pow(1 + esc, m.year - anchorYear);
        const locked = base * Math.pow(1 + esc, startYear - anchorYear);
        // Published (unlocked) gross; Rate Lock surfaces once as lockC below.
        gross += fte * unlocked * hrs;
        if (lockOn) lockC += Math.max(0, (unlocked - locked) * fte * hrs);
      });
      totalGross += gross; totalLock += lockC;
      return { year: m.year, month: m.month, gross, lockC };
    });
    const net = totalGross - totalLock - totalGross * discPct;

    if ((p.assumptions?.billingMode) === 'flatline') {
      // Flatline distributes the project's net evenly; a service-line slice gets
      // its proportional share of each flat month.
      const flat = months.length ? net / months.length : 0;
      if (!slFilter) return applyOverrides(rows.map(r => ({ year: r.year, month: r.month, amount: flat })), p, slFilter);
      const sliceGross = totalGross || 1;
      return rows.map(r => ({ year: r.year, month: r.month, amount: flat * (r.gross / sliceGross) }));
    }
    let series = rows.map(r => ({ year: r.year, month: r.month, amount: r.gross * (1 - discPct) - r.lockC }));
    return applyOverrides(series, p, slFilter);
  }

  /** Imported broker (fee-share) series for a project, by month. */
  function importedBrokerSeries(p) {
    return (p.source && p.source.brokerByMonth) || null;
  }

  /** Reconciliation: imported $ vs. calculated $ (from current staffing) per
      month, with variance. Drives the calculator's side-by-side panel so
      allocations can be tuned to match the imported total without disturbing
      the (locked) projection numbers. */
  function reconcileImport(p, catalog) {
    const imp = p.source && p.source.importedByMonth;
    if (!imp) return null;
    const months = enumerateMonths(p.timeline);
    // Calculated series = what the staffing currently produces (ignores the
    // imported lock, so we can compare against it).
    const clone = JSON.parse(JSON.stringify(p));
    if (clone.source) delete clone.source.importedByMonth;   // force a real compute
    const calc = monthlySeries(clone, catalog) || [];
    const calcMap = {};
    calc.forEach(s => { calcMap[s.year + '-' + s.month] = s.amount; });
    let impTot = 0, calcTot = 0;
    const byMonth = months.map(m => {
      const k = m.year + '-' + m.month;
      const i = +imp[k] || 0, c = calcMap[k] || 0;
      impTot += i; calcTot += c;
      return { ym: k, year: m.year, month: m.month, imported: i, calculated: c, variance: c - i };
    });
    return { byMonth, importedTotal: impTot, calculatedTotal: calcTot, variance: calcTot - impTot, reconciled: !!(p.source && p.source.reconciled) };
  }

  /** Manual monthly overrides (set in Revenue Projections) replace the computed
      amount for that month. Stored as p.monthlyOverrides = { "YYYY-M": number }. */
  function applyOverrides(series, p, slFilter) {
    const ov = p.monthlyOverrides;
    if (slFilter || !ov) return series;
    return series.map(s => {
      const k = s.year + '-' + s.month;
      return (ov[k] != null && !isNaN(ov[k])) ? { ...s, amount: Number(ov[k]), overridden: true } : s;
    });
  }

  /** Resolve a role's base rate AND its escalation anchor year, matching the
      calculator's roleBaseInfo():
        • Contracted roles → the entered rate, anchored at the project start year
          (industry adjustment bypassed).
        • Grid roles       → rack rate × (1 − industry adj), anchored at catalog base year.
      Pass the full project `p` so assumptions (industryAdj, base year, start year)
      are honored. Falls back gracefully when `p` is omitted. */
  function resolveRoleRate(role, catalog, p) {
    const a = p?.assumptions || {};
    const baseYear = a.catalogBaseYear || catalog?.baseYear || 2024;
    if (role && role.rateSource === 'contracted') {
      const cr = parseFloat(role.contractedRate);
      return { base: isNaN(cr) ? 0 : cr, anchorYear: p?.timeline?.startYear || baseYear };
    }
    const title = catalog?.titles?.find(t => t.id === role.titleId)
      || (catalog?.legacyAlias?.[role.titleId] && catalog.titles.find(t => t.id === catalog.legacyAlias[role.titleId].titleId));
    if (!title) return { base: 0, anchorYear: baseYear };
    // Unknown/legacy tier id → fall back to MID (matches the calculator's getTier;
    // it must NOT silently fall to tiers[0] = High, which would over-price here).
    const tier = title.tiers.find(x => x.id === role.tierId)
      || title.tiers.find(x => x.id === 'mid')
      || title.tiers[0];
    if (!tier || tier.isNoCharge) return { base: 0, anchorYear: baseYear };
    const adj = (a.industryAdj || 0) / 100;
    return { base: tier.rate * (1 - adj), anchorYear: baseYear };
  }

  /** Base-year-equivalent rate so projectFinancials' baseYear-anchored escalation
      reproduces the calculator's per-role anchoring (contracted → start year). */
  function getTierRateFromCatalog(role, catalog, p) {
    const { base, anchorYear } = resolveRoleRate(role, catalog, p);
    if (!base) return 0;
    const baseYear = p?.assumptions?.catalogBaseYear || catalog?.baseYear || 2024;
    const esc = (p?.assumptions?.escalation || 0) / 100;
    // Re-anchor: projectFinancials applies (1+esc)^(year-baseYear), but the
    // calculator anchors contracted roles at startYear. Cancel the baseYear
    // exponent so composition reproduces (1+esc)^(year-anchorYear).
    return base * Math.pow(1 + esc, baseYear - anchorYear);
  }

  /* ============================================================
     SESSION / ACCESS WALL
     ------------------------------------------------------------
     Today this is a SIMULATED identity stored in localStorage so the
     access wall can be demoed. In production, replace getCurrentUser()
     with the real signed-in identity from Box / SharePoint / Entra:
     map the login (email / SID) → { name, role }. NOTHING else needs
     to change — every page reads access through this one function.

       role 'admin'  → leadership/ops: sees ALL projects.
       role 'member' → sees ONLY projects they lead or own.

     "Owns" = the person's name matches the project lead, the client
     relationship owner, or appears on the project's team list.
     ============================================================ */
  const SESSION_KEY = 'ufc_session_v1';
  const REAL_KEY = 'ufc_real_identity_v1';     // the TRUE Box SSO identity this session
  const IMP_KEY  = 'ufc_impersonate_v1';       // (Salim-only) identity being previewed

  /* ============================================================
     ADMIN ALLOWLIST  (fail-CLOSED)
     ------------------------------------------------------------
     These logins see ALL projects. Everyone else is a MEMBER who
     sees only the projects they lead/own. An unrecognized login is
     a member who owns nothing → sees nothing (no accidental admin).
     Match is on the Box SSO login (email), case-insensitive.
     Edit this list to grant/revoke all-access.                  */
  const ADMINS = new Set([
    'sabdin@savills.us',      // Salim — owner (current login)
    'salim@savills.us',      // Salim — owner (legacy login, kept for transition)
    'kyriacos.yerou@savills.com', // Kyri Yerou — developer (note .com)
    'esobel@savills.us',     // Emily Sobel
    'jsantoro@savills.us',   // Jeff Santoro
    'mhadim@savills.us',     // Maria Hadim
    'kspiegel@savills.us',   // Kathy Spiegel
    'eglatt@savills.us',     // Emily Glatt
  ].map(s => s.toLowerCase()));

  /* These logins may use the "Viewing as" impersonation switch to preview
     other people's restricted views. Everyone else never sees the control. */
  const SUPERUSERS = new Set([
    'sabdin@savills.us',
    'salim@savills.us',
    'kyriacos.yerou@savills.com',
  ]);

  function roleFor(login) {
    return ADMINS.has(String(login || '').trim().toLowerCase()) ? 'admin' : 'member';
  }

  /* ============================================================
     REVENUE LEADERS DIRECTORY
     ------------------------------------------------------------
     The single controlled list of people who can be a project's
     lead / relationship owner. Using a directory (not free text)
     stops the same person fragmenting into "K. Spiegel", "Kathy
     Spiegel", "Spiegel" across records — projects always store the
     stable `username` (→ later the Box/Entra SID), and the UI shows
     the friendly `displayName`.

     In production: populate this from your directory / an admin
     screen, and set `username` to the real login/SID so the access
     wall matches on identity, not on a typed name.

     id        → stable key stored on the project (project.leadId)
     displayName → shown in dropdowns & tables
     username  → login / email / SID the access wall matches against
     aliases   → older free-text spellings, so existing records migrate
     ============================================================ */
  const REVENUE_LEADERS = [
    { id: 'acpeters',  displayName: 'Andrew Peters',    username: 'acpeters@savills.us',   aliases: ['Andrew Peters', 'A. Peters', 'Peters', 'AP'] },
    { id: 'bjosselson',displayName: 'Benay Josselson',  username: 'bjosselson@savills.us',  aliases: ['Benay Josselson', 'B. Josselson', 'Josselson', 'BLJ'] },
    { id: 'bking',     displayName: 'Brianna King',     username: 'bshepparding@savills.us',aliases: ['Brianna King', 'B. King', 'King', 'Brianna Sheppard King', 'BSK'] },
    { id: 'esobel',    displayName: 'Emily Sobel',      username: 'esobel@savills.us',      aliases: ['Emily Sobel', 'E. Sobel', 'Sobel', 'ES'] },
    { id: 'fbuscaglia',displayName: 'Fred Buscaglia',   username: 'fbuscaglia@savills.us',  aliases: ['Fred Buscaglia', 'F. Buscaglia', 'Buscaglia', 'FB'] },
    { id: 'jbergen',   displayName: 'Jason Bergen',     username: 'jbergen@savills.us',     aliases: ['Jason Bergen', 'J. Bergen', 'Bergen', 'JB'] },
    { id: 'jsantoro',  displayName: 'Jeff Santoro',     username: 'jsantoro@savills.us',    aliases: ['Jeff Santoro', 'J. Santoro', 'Santoro', 'Jeffrey Santoro', 'JS'] },
    { id: 'jjeffrey',  displayName: 'Jessica Jeffrey',  username: 'jjeffrey@savills.us',    aliases: ['Jessica Jeffrey', 'J. Jeffrey', 'Jeffrey', 'JJ'] },
    { id: 'kmartinez', displayName: 'Kathryn Martinez', username: 'kmartinez@savills.us',   aliases: ['Kathryn Martinez', 'K. Martinez', 'Martinez', 'KM'] },
    { id: 'kraymond',  displayName: 'Kristen Raymond',  username: 'kraymond@savills.us',    aliases: ['Kristen Raymond', 'K. Raymond', 'Raymond', 'KR'] },
    { id: 'msmessina', displayName: 'Marc Messina',     username: 'msmessina@savills.us',   aliases: ['Marc Messina', 'M. Messina', 'Messina', 'MSM'] },
    { id: 'mmclane',   displayName: 'Michael McLane',   username: 'mmclane@savills.us',     aliases: ['Michael McLane', 'M. McLane', 'McLane', 'Mike McLane', 'MHM'] },
    { id: 'tmwilliams',displayName: 'Tonya Williams',   username: 'tmwilliams@savills.us',  aliases: ['Tonya Williams', 'T. Williams', 'Williams', 'TW'] },
    { id: 'zsargent',  displayName: 'Zac Sargent',      username: 'zsargent@savills.us',    aliases: ['Zac Sargent', 'Z. Sargent', 'Sargent', 'Zachary Sargent', 'ZS'] },
  ];
  function leaderById(id) { return REVENUE_LEADERS.find(l => l.id === id) || null; }
  /** Resolve any stored value (id, displayName, alias, or username) to a leader. */
  function resolveLeader(value) {
    if (!value) return null;
    const v = String(value).trim();
    const vk = v.toLowerCase();
    return REVENUE_LEADERS.find(l =>
      l.id === v ||
      l.username.toLowerCase() === vk ||
      l.displayName.toLowerCase() === vk ||
      (l.aliases || []).some(a => a.toLowerCase() === vk)
    ) || null;
  }
  function leaderDisplay(value) { const l = resolveLeader(value); return l ? l.displayName : (value || ''); }

  /* The TRUE signed-in identity for this session (set once at boot from Box SSO).
     Kept in-memory + a localStorage mirror so page navigations preserve it. */
  let _realIdentity = null;
  function setRealIdentity(u) {
    _realIdentity = (u && u.username) ? { username: String(u.username).trim(), name: u.name || '' } : null;
    try {
      if (_realIdentity) localStorage.setItem(REAL_KEY, JSON.stringify(_realIdentity));
      else localStorage.removeItem(REAL_KEY);
    } catch (e) {}
    return getCurrentUser();
  }
  function getRealIdentity() {
    if (_realIdentity) return _realIdentity;
    try { const r = JSON.parse(localStorage.getItem(REAL_KEY)); if (r && r.username) { _realIdentity = r; return r; } } catch (e) {}
    return null;
  }

  /* Impersonation — ONLY the SUPERUSER may preview another person's view. */
  function canImpersonate() {
    const r = getRealIdentity();
    return !!r && SUPERUSERS.has(r.username.toLowerCase());
  }
  function getImpersonation() {
    if (!canImpersonate()) return null;          // hard gate: ignored for everyone else
    try { return sessionStorage.getItem(IMP_KEY) || null; } catch (e) { return null; }
  }
  function setImpersonation(login) {
    if (!canImpersonate()) return;
    try { if (login) sessionStorage.setItem(IMP_KEY, login); else sessionStorage.removeItem(IMP_KEY); } catch (e) {}
  }
  function clearImpersonation() { try { sessionStorage.removeItem(IMP_KEY); } catch (e) {} }

  /* Build a user object for a login: display name from the leaders directory
     (else the login), role from the admin allowlist. */
  function identityFor(login, fallbackName) {
    const leader = resolveLeader(login);
    return {
      username: login,
      name: leader ? leader.displayName : (fallbackName || login),
      role: roleFor(login),
    };
  }

  function getCurrentUser() {
    // Salim-only impersonation wins (for testing restricted views).
    const imp = getImpersonation();
    if (imp) return { ...identityFor(imp), impersonating: true };
    const real = getRealIdentity();
    if (real) return identityFor(real.username, real.name);
    // FAIL-CLOSED: an unidentified session is a member that owns nothing → sees nothing.
    return { username: '', name: '', role: 'member' };
  }
  /* Back-compat shim: the Projects Index switcher routes through here. For the
     SUPERUSER it sets/clears impersonation; for anyone else it is a no-op. */
  function setCurrentUser(user) {
    if (!user || (!user.username && !user.name)) { clearImpersonation(); return getCurrentUser(); }
    if (!canImpersonate()) return getCurrentUser();
    if (user.role === 'admin' && !user.username) { clearImpersonation(); return getCurrentUser(); }
    const login = user.username || (resolveLeader(user.name)?.username) || user.name;
    setImpersonation(login);
    return getCurrentUser();
  }
  function isAdmin(user) { return (user || getCurrentUser()).role === 'admin'; }

  /* People the SUPERUSER can impersonate: every leader + every admin (deduped). */
  function impersonationRoster() {
    const seen = new Set(); const list = [];
    REVENUE_LEADERS.forEach(l => { const k = l.username.toLowerCase(); seen.add(k); list.push({ username: l.username, name: l.displayName, role: roleFor(l.username) }); });
    ADMINS.forEach(email => { if (!seen.has(email)) { seen.add(email); list.push({ username: email, name: email, role: 'admin' }); } });
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Normalize a name for tolerant matching ("Kathy Spiegel" ~ "Spiegel"). */
  function nameKey(s) { return String(s || '').trim().toLowerCase(); }
  function namesMatch(a, b) {
    const x = nameKey(a), y = nameKey(b);
    if (!x || !y) return false;
    if (x === y) return true;
    // last-name / surname tolerance: "Kathy Spiegel" vs "Spiegel"
    const xl = x.split(/\s+/).pop(), yl = y.split(/\s+/).pop();
    return xl === y || yl === x || xl === yl;
  }
  /** Does `user` own / is assigned to project `p`? Matches through the leaders
      directory so id / displayName / alias / username all resolve to one identity. */
  /** Parse a comma/semicolon/newline-separated string of emails into a clean,
      de-duped, lowercased list. Used for the per-project access grant. */
  function parseAccessEmails(raw) {
    if (!raw) return [];
    const seen = new Set();
    return String(raw).split(/[,;\n]+/).map(s => s.trim().toLowerCase())
      .filter(s => s && s.includes('@') && !seen.has(s) && seen.add(s));
  }
  /** The granted-access emails on a project (project.accessGrant is the raw string). */
  function accessGrantList(p) {
    return parseAccessEmails((p.project || {}).accessGrant);
  }

  /** Does `user` own / is assigned to project `p`? Matches through the leaders
      directory so id / displayName / alias / username all resolve to one identity. */
  function userOwnsProject(p, user) {
    const u = user || getCurrentUser();
    const pj = p.project || {};
    const me = resolveLeader(u.username) || resolveLeader(u.name);
    const sameLeader = (stored) => {
      if (!stored) return false;
      if (me) { const l = resolveLeader(stored); return !!l && l.id === me.id; }
      return namesMatch(stored, u.name);   // fallback when user isn't in the directory
    };
    if (sameLeader(pj.leadId || pj.lead)) return true;
    if (sameLeader(pj.clientRelOwner)) return true;
    const team = pj.team || pj.assignedTo || [];
    if (Array.isArray(team) && team.some(t => sameLeader(t))) return true;
    // Explicit per-project access grant — match the signed-in user's Box email.
    const grant = accessGrantList(p);
    if (grant.length && u.username && grant.includes(String(u.username).trim().toLowerCase())) return true;
    return false;
  }
  /** The access wall: admins get everything; members get only their own. */
  function visibleProjects(projects, user) {
    const u = user || getCurrentUser();
    if (isAdmin(u)) return projects;
    return projects.filter(p => userOwnsProject(p, u));
  }

  window.UFC_Store = {
    SCHEMA, STATUSES, STATUS_LABELS, LOST_REASONS, ASSUMPTION_LIBRARY, INDUSTRIES, PROJECT_TYPES, projectTypeSubs,
    accessGrantList, parseAccessEmails,
    RATINGS, ratingFor, ratingMeta, STATUS_DEFAULT_RATING,
    SERVICE_LINES, serviceLineOfGroup, serviceLinesOfGroup, projectServiceLines, inferServiceLine,
    listProjects, getProject, saveProject, deleteProject, migrateLeadIds,
    allProjectsRaw, restoreDeleted, purgeTombstones, logActivity, listActivity,
    saveVersion, listVersions, versionDiff, restoreVersionRecord, rosterDiff,
    proposalHealth,
    exportDb, importDb, downloadJson,
    FLASH_LABELS, captureSnapshot, getSnapshots, deleteSnapshot, periodKey,
    projectFinancials, getTierRateFromCatalog, resolveRoleRate, monthlySeries,
    computeFinancials, financialsInputsHash, restampFinancials,
    isChangeOrder, childChangeOrders, approvedChangeOrders, createChangeOrder,
    importedBrokerSeries, reconcileImport,
    approveChangeOrder, changeOrderDelta, changeOrderRoleDiff, revisedContract, clientRollup,
    enumerateMonths, computeMonthsByPhase,
    getCurrentUser, setCurrentUser, isAdmin, userOwnsProject, visibleProjects,
    setRealIdentity, getRealIdentity, canImpersonate, setImpersonation, clearImpersonation, getImpersonation, roleFor, impersonationRoster,
    REVENUE_LEADERS, leaderById, resolveLeader, leaderDisplay,
    attachRemote, hydrateFromRemote, defaultDb, runMigrations,
    attachStudioRemote, hydrateStudioFromRemote, readStudio, defaultStudio,
    listBaselines, getBaseline, saveBaseline, deleteBaseline, baselineFromBudget, baselineGridForSlice,
    listScenarios, getScenario, saveScenario, deleteScenario,
  };
})();
