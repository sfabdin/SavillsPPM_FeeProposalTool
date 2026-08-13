/* ============================================================
   SAVILLS PPM · FEE & REVENUE SYSTEM · localStorage data store
   Schema-versioned project records.
   ============================================================ */
(function () {
  'use strict';
  const KEY = 'savills-ppm-fee-db:v1';
  const STUDIO_KEY = 'savills-ppm-studio-db:v1';   // Revenue Studio — SEPARATE store/file
  const REVENUE_KEY = 'savills-ppm-revenue-db:v1'; // Revenue Reconciliation — SEPARATE store/file (revenue.json in Box)
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
  const BASE_LOST_REASONS = ['Too expensive', 'Relationship', 'Incumbent', 'Scope', 'Procurement', 'Client cancelled', 'Internal / no-bid', 'No decision', 'Other'];

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
  const BASE_INDUSTRIES = [
    'Financial Services',
    'Law',
    'TAMI',
    'Retail',
    'Data Center',
    'Energy',
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
  const BASE_PROJECT_TYPES = [
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
    { name: 'Cost Management', subs: ['Estimating', 'Cost planning & control', 'Change order management', 'Value engineering', 'Contingency management'] },
  ];
  /* ===== Vocabulary =====
     The built-in lists above are the floor, not the ceiling: a superuser can
     extend them (today from the Bulk Editor's Lists sheet) and the additions
     live on the shared db, so every dropdown in every browser picks them up
     through the normal sync. Exposed as GETTERS on the public object, so the
     ~30 call sites that read STORE.INDUSTRIES keep working unchanged. */
  function readVocab() {
    const v = (readDb() || {}).vocab || {};
    return { industries: v.industries || [], projectTypes: v.projectTypes || [], lossReasons: v.lossReasons || [], leaders: v.leaders || [] };
  }
  function allIndustries() {
    const extra = readVocab().industries.filter(x => x && !BASE_INDUSTRIES.includes(x));
    return BASE_INDUSTRIES.concat(extra);
  }
  function allLostReasons() {
    const extra = readVocab().lossReasons.filter(x => x && !BASE_LOST_REASONS.includes(x));
    return BASE_LOST_REASONS.concat(extra);
  }
  /** Custom types append; a custom entry naming a built-in type ADDS its
      sub-services to that type rather than replacing them. */
  function allProjectTypes() {
    const out = BASE_PROJECT_TYPES.map(t => ({ name: t.name, subs: t.subs.slice() }));
    readVocab().projectTypes.forEach(ct => {
      if (!ct || !ct.name) return;
      const hit = out.find(t => t.name === ct.name);
      if (hit) (ct.subs || []).forEach(s2 => { if (s2 && !hit.subs.includes(s2)) hit.subs.push(s2); });
      else out.push({ name: ct.name, subs: (ct.subs || []).slice() });
    });
    return out;
  }
  /** Add to the vocabulary. Superuser only — this reshapes every dropdown in
      the system. Additive by design: nothing already in use can be removed
      out from under the projects that reference it. */
  function addVocab(patch) {
    if (!isSuperuser()) throw new Error('Only a superuser can extend the vocabulary lists.');
    const db = readDb();
    const v = db.vocab = db.vocab || { industries: [], projectTypes: [], lossReasons: [] };
    v.industries = v.industries || []; v.projectTypes = v.projectTypes || []; v.lossReasons = v.lossReasons || []; v.leaders = v.leaders || [];
    let added = 0;
    (patch.industries || []).forEach(x => { if (x && !BASE_INDUSTRIES.includes(x) && !v.industries.includes(x)) { v.industries.push(x); added++; } });
    (patch.lossReasons || []).forEach(x => { if (x && !BASE_LOST_REASONS.includes(x) && !v.lossReasons.includes(x)) { v.lossReasons.push(x); added++; } });
    (patch.leaders || []).forEach(l => {
      if (!l || !l.id || !l.displayName) return;
      if (BASE_REVENUE_LEADERS.some(b => b.id === l.id) || v.leaders.some(x => x.id === l.id)) return;
      v.leaders.push({ id: l.id, displayName: l.displayName, username: l.username || '', aliases: l.aliases || [l.displayName] });
      added++;
    });
    (patch.projectTypes || []).forEach(ct => {
      if (!ct || !ct.name) return;
      const base = BASE_PROJECT_TYPES.find(t => t.name === ct.name);
      const subsNew = (ct.subs || []).filter(s2 => s2 && !(base ? base.subs : []).includes(s2));
      let cur = v.projectTypes.find(t => t.name === ct.name);
      if (!cur && !base) { cur = { name: ct.name, subs: [] }; v.projectTypes.push(cur); added++; }
      if (!cur && base && subsNew.length) { cur = { name: ct.name, subs: [] }; v.projectTypes.push(cur); }
      if (cur) subsNew.forEach(s2 => { if (!cur.subs.includes(s2)) { cur.subs.push(s2); added++; } });
    });
    if (added) writeDb(db);
    return added;
  }
  function projectTypeSubs(name) {
    const t = allProjectTypes().find(x => x.name === name);
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

  /* ===== Maintenance mode =====
     A superuser doing a bulk scrub (export → edit in Excel → reimport) needs
     the book to hold still: a teammate saving mid-scrub would either be
     clobbered by the reimport or trip its staleness guard. The flag lives on
     the shared db, so it reaches every browser through the normal Box sync,
     and it blocks WRITES only — everyone can still read, run reports and
     export while it's on. Superusers are exempt (they're the ones fixing it). */
  function getMaintenance() {
    const m = (readDb() || {}).maintenance;
    return (m && m.on) ? m : null;
  }
  function setMaintenance(on, note) {
    if (!isSuperuser()) throw new Error('Only a superuser can change maintenance mode.');
    const db = readDb();
    db.maintenance = on
      ? { on: true, note: note || '', at: new Date().toISOString(),
          by: ((getRealIdentity() || getCurrentUser() || {}).name) || ((getRealIdentity() || getCurrentUser() || {}).username) || 'superuser' }
      : { on: false, endedAt: new Date().toISOString() };
    writeDb(db);
    return db.maintenance;
  }
  /** Throws unless writing is allowed right now. opts.maintenanceOverride is
      for the bulk importer itself, which runs AS the superuser. */
  function assertWritable(opts) {
    const m = getMaintenance();
    if (!m) return;
    if (isSuperuser() || (opts && opts.maintenanceOverride)) return;
    const err = new Error('The tool is down for maintenance' + (m.note ? ' — ' + m.note : '') + '. Your change was not saved; try again once it reopens.');
    err.code = 'MAINTENANCE';
    throw err;
  }

  function writeDb(db) {
    db.schemaVersion = SCHEMA;
    // Quota-safe local write: if localStorage is full, the local cache write
    // fails but the Box push below STILL runs, so the save is never lost —
    // and the failure is surfaced loudly instead of silently.
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) {
      console.error('Local cache write failed (storage full?) — data will still sync to Box', e);
      try { document.dispatchEvent(new CustomEvent('ufc:sync', { detail: { state: 'error', message: 'Browser storage is full — your save is syncing to Box but cannot be cached locally. Clear old site data or contact the maintainer.', at: Date.now() } })); } catch (e2) {}
    }
    // Sync layer: if a remote backend (Box) is attached, mirror local → remote.
    // No-op when nothing is attached, so the offline/localStorage app is unchanged.
    if (typeof _remotePush === 'function') { try { _remotePush(db); } catch (e) { console.warn('remote push failed', e); } }
  }

  /* ===== Activity log — append-only audit trail =====
     Rides inside projects.json (so it syncs to Box with the data). Union-merged
     by entry id in box-adapter's mergeDb, capped to the most recent entries.
     Records who did what: create, save, status change, book, delete, access grant. */
  const ACTIVITY_CAP = 1500;
  function logActivity(action, projectId, meta) {
    try {
      const db = readDb();
      if (!Array.isArray(db.activity)) db.activity = [];
      const cu = getCurrentUser() || {};
      const ri = (typeof realIdentityLabel === 'function' ? realIdentityLabel() : null) || {};
      const actor = ri.username || cu.username || 'unknown';
      const entry = {
        id: 'act_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        ts: new Date().toISOString(),
        actor,
        actorName: ri.name || cu.name || '',
        action, projectId: projectId || null, meta: meta || null,
      };
      // Record when an admin acted while previewing someone else's view.
      if (cu.impersonating && cu.username && cu.username !== actor) entry.viewingAs = cu.username;
      db.activity.push(entry);
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

  /* ===== Field-level change description =====
     Compares the previous stored record to the one being saved and returns a
     list of plain-language changes ({field, from, to, detail}). This is what
     turns "someone saved" into "who changed what". Purely descriptive — it
     never blocks or alters a save. */
  const META_FIELDS = [
    ['name', 'Project name'], ['client', 'Client'], ['industry', 'Industry'],
    ['projectType', 'Project type'], ['salesforceId', 'Salesforce ID'],
    ['firstProposalDate', 'Proposal date'], ['proposalDate', 'Proposal date'],
    ['lossReason', 'Loss reason'], ['accessGrant', 'Granted access'],
    ['assumptionsText', 'Assumptions'], ['exclusions', 'Exclusions'], ['notes', 'Notes'],
  ];
  const ASSUMPTION_FIELDS = [
    ['hrsPerMo', 'Hours per month'], ['escalation', 'Escalation %'],
    ['industryAdj', 'Industry adjustment %'], ['discount', 'Client discount %'],
    ['rateLock', 'Rate lock'], ['billingMode', 'Fee basis'],
    ['catalogBaseYear', 'Rate grid year'], ['nteCeiling', 'NTE ceiling'],
  ];
  function shortVal(v) {
    if (v === true) return 'on'; if (v === false) return 'off';
    if (v == null || v === '') return '—';
    const s = String(v);
    return s.length > 60 ? s.slice(0, 57) + '…' : s;
  }
  function describeChanges(prev, next) {
    const out = [];
    if (!prev || !next) return out;
    const a = prev.project || {}, b = next.project || {};
    META_FIELDS.forEach(([k, label]) => {
      if ((a[k] || '') !== (b[k] || '')) out.push({ field: label, from: shortVal(a[k]), to: shortVal(b[k]) });
    });
    // Revenue leader resolves through the directory, so compare display names.
    const lead = (p) => { const pj = p.project || {}; const raw = pj.leadId || pj.lead; return raw ? (leaderDisplay ? leaderDisplay(raw) : raw) : ''; };
    if (lead(prev) !== lead(next)) out.push({ field: 'Revenue leader', from: shortVal(lead(prev)), to: shortVal(lead(next)) });
    if ((a.rating || '') !== (b.rating || '')) out.push({ field: 'Rating', from: shortVal(a.rating), to: shortVal(b.rating) });
    // Timeline
    const tl = (p) => { const t = p.timeline || {}; return [t.startYear, t.startMonth, t.endYear, t.endMonth].join('/'); };
    if (tl(prev) !== tl(next)) {
      const f = (p) => { const t = p.timeline || {}; return (t.startMonth || '?') + '/' + (t.startYear || '?') + ' → ' + (t.endMonth || '?') + '/' + (t.endYear || '?'); };
      out.push({ field: 'Timeline', from: f(prev), to: f(next) });
    }
    // Phases
    const ph = (p) => (p.phases || []).map(x => x.length).join(',');
    if (ph(prev) !== ph(next)) {
      const n1 = (prev.phases || []).length, n2 = (next.phases || []).length;
      out.push({ field: 'Phases', from: n1 + ' phase' + (n1 === 1 ? '' : 's'), to: n2 + ' phase' + (n2 === 1 ? '' : 's') + (n1 === n2 ? ' (lengths changed)' : '') });
    }
    // Groups
    const gp = (p) => (p.groups || []).map(g => (g.name || '') + ':' + (g.serviceLine || '')).join('|');
    if (gp(prev) !== gp(next)) {
      const n1 = (prev.groups || []).length, n2 = (next.groups || []).length;
      out.push({ field: 'Groups', from: n1 + '', to: n2 + (n1 === n2 ? ' (renamed / service line changed)' : '') });
    }
    // Assumptions
    const aa = prev.assumptions || {}, bb = next.assumptions || {};
    ASSUMPTION_FIELDS.forEach(([k, label]) => {
      if (String(aa[k] == null ? '' : aa[k]) !== String(bb[k] == null ? '' : bb[k])) {
        out.push({ field: label, from: shortVal(aa[k]), to: shortVal(bb[k]) });
      }
    });
    // Broker fee share
    const fs = (o) => { const f = (o || {}).feeShare || {}; return [!!f.enabled, f.pct || 0, f.mode || ''].join('/'); };
    if (fs(aa) !== fs(bb)) {
      const f = (o) => { const x = (o || {}).feeShare || {}; return x.enabled ? (x.pct || 0) + '% ' + (x.mode || '') : 'off'; };
      out.push({ field: 'Broker fee share', from: f(aa), to: f(bb) });
    }
    // Pass-through
    const ptSum = (p) => {
      const pt = p.passthrough || {}; const lines = Array.isArray(pt.lines) ? pt.lines : [];
      const cost = lines.reduce((s, l) => s + (parseFloat(l.cost) || 0), 0);
      return { on: !!pt.enabled, n: lines.length, cost };
    };
    const p1 = ptSum(prev), p2 = ptSum(next);
    if (p1.on !== p2.on || p1.n !== p2.n || Math.round(p1.cost) !== Math.round(p2.cost)) {
      const f = (x) => x.on ? x.n + ' line' + (x.n === 1 ? '' : 's') + ' · $' + Math.round(x.cost).toLocaleString() : 'off';
      out.push({ field: 'Pass-through', from: f(p1), to: f(p2) });
    }
    // Roles — reuse the roster diff that powers version history
    try {
      const rd = rosterDiff(rosterSnapshot(prev), rosterSnapshot(next));
      const bits = [];
      if (rd.added.length) bits.push(rd.added.length + ' added');
      if (rd.removed.length) bits.push(rd.removed.length + ' removed');
      if (rd.changed.length) bits.push(rd.changed.length + ' changed');
      if (bits.length) {
        out.push({
          field: 'Team', from: (prev.roles || []).length + ' role' + ((prev.roles || []).length === 1 ? '' : 's'),
          to: (next.roles || []).length + ' role' + ((next.roles || []).length === 1 ? '' : 's'),
          detail: bits.join(', ') + ' — ' + [].concat(
            rd.added.map(r => '+' + r.label), rd.removed.map(r => '−' + r.label),
            rd.changed.map(r => '~' + r.label)
          ).slice(0, 8).join(', '),
        });
      }
    } catch (e) {}
    return out;
  }

  /** Net fee before/after, when the rate grid is loaded. Null when it isn't. */
  function feeDelta(prev, next) {
    try {
      const catalog = (typeof window !== 'undefined') && window.RATES_CATALOG;
      if (!catalog || !catalog.hydrated) return null;
      const f1 = prev ? computeFinancials(prev, catalog) : null;
      const f2 = next ? computeFinancials(next, catalog) : null;
      if (!f1 || !f2) return null;
      const from = Math.round(f1.net), to = Math.round(f2.net);
      return from === to ? null : { from, to, delta: to - from };
    } catch (e) { return null; }
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

  function saveProject(record, opts) {
    opts = opts || {};
    assertWritable(opts);
    const db = readDb();
    const prev = record.id ? db.projects[record.id] : null;
    const isNew = !record.id;
    /* Optimistic concurrency. The editor tells us which version it started from
       (baseUpdatedAt). If the stored record has moved on since, someone else (or
       another tab) saved in the meantime — writing now would silently revert
       their work, which is exactly the "my entries don't stick" symptom. Refuse
       and let the caller decide. opts.force overrides after the user chooses. */
    if (prev && !prev._deleted && opts.baseUpdatedAt && !opts.force
        && (prev.updatedAt || '') > opts.baseUpdatedAt) {
      const err = new Error('This project was saved by someone else while you were editing.');
      err.code = 'STALE_WRITE';
      err.remote = {
        updatedAt: prev.updatedAt,
        by: (prev.lastSavedBy && (prev.lastSavedBy.name || prev.lastSavedBy.username)) || null,
      };
      throw err;
    }
    if (!record.id) record.id = 'proj_' + Math.random().toString(36).slice(2, 11);
    if (!record.createdAt) record.createdAt = new Date().toISOString();
    /* updatedAt must be STRICTLY increasing per record: it's both the Box merge
       tiebreaker and the concurrency token, and two saves inside the same
       millisecond would otherwise be indistinguishable. */
    {
      let ts = new Date().toISOString();
      const prevTs = (prev && prev.updatedAt) || '';
      if (prevTs && ts <= prevTs) ts = new Date(new Date(prevTs).getTime() + 1).toISOString();
      record.updatedAt = ts;
    }
    { const cu = getCurrentUser() || {};
      const ri = (typeof realIdentityLabel === 'function' ? realIdentityLabel() : null) || {};
      record.lastSavedBy = { username: ri.username || cu.username || null, name: ri.name || cu.name || null }; }
    maybeSnapshotFinancials(record);   // freeze derived figures once booked
    maybeAutoVersion(record, prev);    // capture a version when status crosses a lifecycle milestone
    db.projects[record.id] = record;
    writeDb(db);
    // Audit trail (never let logging failure break a save)
    try {
      const newStatus = record.project && record.project.status;
      const oldStatus = prev && prev.project && prev.project.status;
      const name = record.project && record.project.name;
      const client = record.project && record.project.client;
      if (isNew) {
        logActivity('create', record.id, { name, client, status: newStatus });
      } else {
        const changes = describeChanges(prev, record);
        const fee = feeDelta(prev, record);
        if (oldStatus !== newStatus) {
          const booked = ['won', 'active', 'closed'].includes(newStatus);
          logActivity(booked ? 'book' : 'status', record.id, {
            name, client, from: oldStatus, to: newStatus,
            changes: changes.length ? changes : undefined, fee: fee || undefined,
          });
        } else if (changes.length || fee) {
          logActivity('edit', record.id, { name, client, status: newStatus, changes, fee: fee || undefined });
        }
      }
    } catch (e) {}
    return record;
  }

  /* Soft-delete: leave a tombstone (not a hard delete) so the deletion
     propagates through the newest-updatedAt-wins Box merge. A hard delete only
     removes it locally and the record resurrects from another device's copy. */
  function deleteProject(id) {
    assertWritable();
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

  /* ============================================================
  /* ============================================================
     REVENUE LEDGER — the year's actuals, as posted by Finance
     ------------------------------------------------------------
     Everything above this line is a FORECAST: what the fee record says
     a project should bill. The ledger is the other half — what Finance
     actually invoiced and accrued — and it is never derived from
     project records, because the whole point is to disagree with them.

     SHAPE: A YEAR, NOT A MONTH.
     Finance's book is a running year-to-date sheet: one tab per close
     ("YTD July 2026") whose monthly columns already carry January
     through July. So one upload lands the whole year, and re-uploading
     next month's tab refreshes it. The unit of work is the CELL —
     one project in one month — because that is the grain at which a
     billing question actually gets asked and answered.

     revenue.json (Box) — never inside projects.json:
       revenue.ledger = {
         "2026": {
           updatedAt, updatedBy,
           imports: [{ file, sheet, closeMonth, at, by }],
           rows: { <key>: {
             code, name, client,
             pid,                      // matched project in projects.json
             billed:     { 1: 38000, … },  // AS IMPORTED from the sheet
             billedEdit: { 1: 40000, … },  // manual correction, wins over the import
             feeShare:   { 2: -7500, … },  // signed, its own line
             accrued:    { 4: 170000, … }, // MOVEMENT per month — entered by hand
             accrualBal: { 7: 680000 },    // the lump BALANCE as imported, per close
             status:     { 1: 'billed', … },
             carryTo:    { 6: 9 },
             note, billingSummary } }
         }
       }

     THE ACCRUAL LUMP IS A HUMAN'S JOB, NOT A DERIVATION
     A close tab states ONE accrual figure per project — a balance at
     its close date, with no month behind it. P009355 carries $680,000
     against no billings at all; that is really $170,000 earned in each
     of April, May, June and July, and nothing in the sheet says so.
     No arithmetic can recover that, so the ledger does not pretend to:
     the imported lump is kept as `accrualBal` (the target), and a human
     allocates it across months in `accrued`. The page shows both and
     flags when the allocation does not foot to the lump.

     `accrued[m]` is MOVEMENT, not a balance — what was earned but not
     invoiced in that month. Billing something previously accrued is a
     negative entry in the billing month, exactly as it unwinds in the
     ledger.

     RECOGNITION
       cell recognised = billed + feeShare + accrued
     where billed is the manual correction if one exists, else the
     imported figure.

     PRIOR-YEAR REVERSALS ARE EXCLUDED. The close file's "Dec-<PY>
     Accruals Reversed" column is a whole-year opening adjustment about
     last year's work, not activity in any month of this one. It is read
     at import to prove the sheet parsed correctly against its own
     arithmetic, then discarded — so this ledger's YTD deliberately
     differs from the file's "YTD Reported Revenue" by exactly that
     amount. Each year stands alone from LEDGER_FIRST_YEAR forward.
     ============================================================ */

  /** The ledger does not model anything before this year. */
  const LEDGER_FIRST_YEAR = 2026;

  /* Billing statuses — the vocabulary Finance already writes by hand in
     the close file's Comments column, turned into a closed list. `forecast`
     says what each one does to the rest of the year:
       keep   — timing only, the year is unchanged
       push   — the money moves to a later month (needs carryTo)
       drop   — it leaves the forecast for good
       add    — real revenue with no project record behind it
       pair   — a reclass; meaningless unless read with its offsetting code */
  const DISPOSITIONS = [
    { id: 'billed',   label: 'Billed as planned',            forecast: 'keep' },
    { id: 'accrued',  label: 'Accrued — invoice deferred',   forecast: 'keep' },
    { id: 'slip',     label: 'Slipped — push billing out',   forecast: 'push' },
    { id: 'early',    label: 'Billed early — prior period',  forecast: 'keep' },
    { id: 'trueup',   label: 'True-up — billing ≠ accrual',  forecast: 'keep' },
    { id: 'writeoff', label: 'Written off — not billable',   forecast: 'drop' },
    { id: 'unfcast',  label: 'Unforecast revenue',           forecast: 'add'  },
    { id: 'reclass',  label: 'Reclass — offset to another code', forecast: 'pair' },
    { id: 'feeshare', label: 'Fee share out',                forecast: 'keep' },
  ];
  const DISPOSITION_LABEL = (id) => (DISPOSITIONS.find(d => d.id === id) || {}).label || '';

  /* ------------------------------------------------------------
     The ledger is its OWN store, backed by revenue.json in Box —
     deliberately not part of projects.json. Actuals are a different
     kind of data on a different cadence: one admin re-posting a close
     would otherwise churn the file every project record shares, and
     projects.json's shape would grow a key that has nothing to do
     with project records. Same separation studio.json and staff.json
     already have.
     ------------------------------------------------------------ */
  let _revenuePush = null;
  function attachRevenueRemote(pushFn) { _revenuePush = typeof pushFn === 'function' ? pushFn : null; }
  function defaultRevenue() { return { schemaVersion: SCHEMA, ledger: {} }; }
  function readRevenue() {
    try {
      const raw = localStorage.getItem(REVENUE_KEY);
      if (!raw) return migrateLedgerOutOfProjects();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return defaultRevenue();
      parsed.ledger = parsed.ledger || {};
      return parsed;
    } catch (e) { return defaultRevenue(); }
  }
  function writeRevenue(r) {
    r.schemaVersion = SCHEMA;
    r.updatedAt = new Date().toISOString();
    localStorage.setItem(REVENUE_KEY, JSON.stringify(r));
    if (typeof _revenuePush === 'function') { try { _revenuePush(r); } catch (e) { console.warn('revenue push failed', e); } }
  }
  function hydrateRevenueFromRemote(r) {
    if (!r || typeof r !== 'object') return;
    r.schemaVersion = SCHEMA;
    r.ledger = r.ledger || {};
    localStorage.setItem(REVENUE_KEY, JSON.stringify(r));
  }
  /** One-time lift: early builds kept the ledger inside projects.json. Move it
      into revenue.json and strip it out, so projects.json goes back to holding
      only project records. Runs once, on the first read of the new store. */
  function migrateLedgerOutOfProjects() {
    const out = defaultRevenue();
    try {
      const db = readDb();
      if (db && db.ledger && Object.keys(db.ledger).length) {
        out.ledger = db.ledger;
        localStorage.setItem(REVENUE_KEY, JSON.stringify(out));
        delete db.ledger;
        writeDb(db);                                  // pushes the slimmed projects.json
        logActivity('ledger-migrate', null, { years: Object.keys(out.ledger) });
      }
    } catch (e) { /* a failed lift must never block reading the ledger */ }
    return out;
  }
  function readLedger() { return readRevenue().ledger || {}; }
  /** Years that have been imported, oldest first. */
  function ledgerYears() { return Object.keys(readLedger()).sort(); }
  function getLedgerYear(year) { return readLedger()[String(year)] || null; }
  /** The latest close month imported for a year (1–12), or 0 if none. */
  function closedThrough(year) {
    const y = getLedgerYear(year);
    if (!y || !y.imports || !y.imports.length) return 0;
    return y.imports.reduce((a, i) => Math.max(a, +i.closeMonth || 0), 0);
  }

  /** Land a parsed close tab into a year. Billed / fee-share figures are
      REPLACED from the sheet (it is the source of truth and a correction
      must win), while every human decision — the billing status on each
      cell, its carry month, a manual project match — is carried across.
      Re-importing next month's tab must never throw away review work. */
  function postLedgerYear(year, rows, meta) {
    if (!isAdmin(getCurrentUser())) throw new Error('Only an admin can post revenue actuals.');
    if (+year < LEDGER_FIRST_YEAR)
      throw new Error(`The ledger starts at ${LEDGER_FIRST_YEAR}. Earlier years stay in Finance's own files.`);
    const rev = readRevenue();
    rev.ledger = rev.ledger || {};
    const yk = String(year);
    const prev = rev.ledger[yk] || { rows: {}, imports: [] };
    const out = {};
    rows.forEach(r => {
      const old = prev.rows[r.key];
      out[r.key] = {
        ...r,
        // The sheet is the authority on what was invoiced, so `billed` is
        // replaced wholesale. Everything a human put in survives: their
        // billing corrections, their accrual allocation, statuses, matches.
        // Incoming first, then what a human already put in — so an existing
        // hand entry always wins, but nothing passed in is silently dropped.
        billedEdit: { ...(r.billedEdit || {}), ...((old && old.billedEdit) || {}) },
        accrued:    { ...(r.accrued || {}),    ...((old && old.accrued) || {}) },
        // Imported lumps accumulate: each tab contributes the one close
        // month it actually knows a figure for.
        accrualBal: { ...((old && old.accrualBal) || {}), ...(r.accrualBal || {}) },
        status:     { ...((old && old.status) || {}) },
        carryTo:    { ...((old && old.carryTo) || {}) },
        pid: (old && old.pidManual) ? old.pid : r.pid,     // a human's match outranks the matcher
        pidManual: !!(old && old.pidManual),
      };
    });
    // Rows that existed before but are absent from this tab keep their history.
    Object.entries(prev.rows || {}).forEach(([k, r]) => { if (!out[k]) out[k] = r; });
    const cu = getCurrentUser() || {};
    const stamp = new Date().toISOString();
    Object.values(out).forEach(r => { r.updatedAt = r.updatedAt || stamp; });
    rev.ledger[yk] = {
      updatedAt: stamp,
      updatedBy: cu.name || cu.username || 'admin',
      imports: [
        ...(prev.imports || []).filter(i => +i.closeMonth !== +(meta && meta.closeMonth)),
        { file: (meta && meta.file) || '', sheet: (meta && meta.sheet) || '',
          closeMonth: +(meta && meta.closeMonth) || 0, at: new Date().toISOString(),
          by: cu.name || cu.username || 'admin', rows: rows.length },
      ].sort((a, b) => a.closeMonth - b.closeMonth),
      rows: out,
    };
    writeRevenue(rev);
    logActivity('ledger-post', null, { year: yk, closeMonth: (meta && meta.closeMonth) || 0, rows: rows.length, file: (meta && meta.file) || '' });
    return rev.ledger[yk];
  }

  /** Set the billing status on ONE cell (project × month). */
  function setCellStatus(year, key, month, status, extra) {
    if (!isAdmin(getCurrentUser())) throw new Error('Only an admin can set a billing status.');
    const rev = readRevenue();
    const y = (rev.ledger || {})[String(year)];
    if (!y || !y.rows || !y.rows[key]) return null;
    const row = y.rows[key];
    row.status = row.status || {}; row.carryTo = row.carryTo || {};
    if (status) row.status[month] = status; else delete row.status[month];
    if (extra && 'carryTo' in extra) {
      if (extra.carryTo) row.carryTo[month] = extra.carryTo; else delete row.carryTo[month];
    }
    row.updatedAt = new Date().toISOString();          // row-level stamp drives the Box merge
    writeRevenue(rev);
    return row;
  }

  /** Point a ledger row at a project record (or clear it). Marked manual so a
      later import cannot silently re-match it to something else. */
  function setRowMatch(year, key, pid) {
    if (!isAdmin(getCurrentUser())) throw new Error('Only an admin can re-map a revenue line.');
    const rev = readRevenue();
    const y = (rev.ledger || {})[String(year)];
    if (!y || !y.rows || !y.rows[key]) return null;
    y.rows[key].pid = pid || null;
    y.rows[key].pidManual = !!pid;
    y.rows[key].updatedAt = new Date().toISOString();
    writeRevenue(rev);
    return y.rows[key];
  }

  /** Create a project record FROM a ledger line, so a line in the billed book
      that has no project can be given one without leaving the page.

      The record carries no roster and no pricing — it is not a priced
      proposal, it is a line in the billed book that needs a home on the
      forecast. Its monthly figures come straight from the sheet and land in
      monthlyOverrides, which is the mechanism Revenue Projections already
      reads, so it shows up there immediately at exactly the figures Finance
      reported. Someone can price it properly later; the point is that the
      book reconciles today. */
  function createProjectFromLedgerRow(year, key) {
    if (!isAdmin(getCurrentUser())) throw new Error('Only an admin can create a project.');
    const y = getLedgerYear(year);
    const row = y && y.rows && y.rows[key];
    if (!row) throw new Error('That line is no longer in the ledger.');
    if (row.pid) throw new Error('That line is already mapped to a project.');

    const months = [];
    for (let m = 1; m <= 12; m++) if (cellHasValue(row, m)) months.push(m);
    if (!months.length) throw new Error('That line has no figures to build a project from.');
    const first = months[0], last = months[months.length - 1];

    const overrides = {};
    for (let m = first; m <= last; m++) overrides[year + '-' + m] = Math.round(cellRecognised(row, m) * 100) / 100;

    const rec = {
      id: 'proj_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      project: {
        name: row.name || '(unnamed)', client: row.client || '',
        projectId365: row.code || '', status: 'active', rating: 1,
      },
      timeline: { startMonth: first, startYear: +year, endMonth: last, endYear: +year },
      phases: [{ id: 'p1', name: 'Delivery', length: last - first + 1 }],
      groups: [{ id: 'core', name: 'Core' }],
      roles: [],
      assumptions: { hrsPerMo: 173.33, discount: 0, rateLock: false, escalation: 0, industryAdj: 0,
                     catalogBaseYear: +year, feeShare: { enabled: false, pct: 0, mode: 'offtop' },
                     feeBasis: 'fixed', nteCeiling: 0 },
      monthlyOverrides: overrides,
      source: { fromReconciliation: true, ledgerKey: key, ledgerYear: String(year), note: row.note || '' },
    };
    const saved = saveProject(rec);
    setRowMatch(year, key, saved.id);
    logActivity('project-from-ledger', saved.id, { year: String(year), key, months: months.length });
    return saved;
  }

  /** How much of the billed book has a home on the forecast. This is the
      number that says whether the reconciliation can be trusted as a
      measure — an unmapped line is revenue nobody is being measured on. */
  function ledgerCoverage(year) {
    const y = getLedgerYear(year);
    if (!y) return null;
    let mapped = 0, unmapped = 0, mappedAmt = 0, unmappedAmt = 0;
    Object.values(y.rows || {}).forEach(r => {
      let amt = 0;
      for (let m = 1; m <= 12; m++) amt += cellRecognised(r, m);
      if (r.pid) { mapped++; mappedAmt += amt; } else { unmapped++; unmappedAmt += amt; }
    });
    return { mapped, unmapped, total: mapped + unmapped, mappedAmt, unmappedAmt };
  }

  function deleteLedgerYear(year) {
    if (!isAdmin(getCurrentUser())) throw new Error('Only an admin can remove revenue actuals.');
    const rev = readRevenue();
    if (rev.ledger && rev.ledger[String(year)]) {
      delete rev.ledger[String(year)]; writeRevenue(rev);
      logActivity('ledger-remove', null, { year: String(year) });
    }
  }

  const nnum = (v) => (typeof v === 'number' && isFinite(v)) ? v : 0;

  /** What was invoiced in this month: a manual correction if someone made
      one, otherwise whatever the sheet said. */
  function billedOf(row, month) {
    const e = (row && row.billedEdit) || {};
    return (month in e) ? nnum(e[month]) : nnum(((row && row.billed) || {})[month]);
  }
  const accruedOf = (row, month) => nnum(((row && row.accrued) || {})[month]);
  const feeShareOf = (row, month) => nnum(((row && row.feeShare) || {})[month]);

  /** Recognised revenue for one project in one month. */
  function cellRecognised(row, month) {
    if (!row) return 0;
    return billedOf(row, month) + feeShareOf(row, month) + accruedOf(row, month);
  }
  /** Has anything at all happened in this cell? */
  const cellHasValue = (row, month) => !!(billedOf(row, month) || feeShareOf(row, month) || accruedOf(row, month));

  /** The accrual lump as imported (the latest close's figure) versus what a
      human has actually allocated across the months. `ok` is the whole point
      of the column: an allocation that does not foot to the lump is wrong. */
  function accrualCheck(row) {
    const bal = (row && row.accrualBal) || {};
    const closes = Object.keys(bal).map(Number).sort((a, b) => a - b);
    const imported = closes.length ? nnum(bal[closes[closes.length - 1]]) : 0;
    let allocated = 0;
    for (let m = 1; m <= 12; m++) allocated += accruedOf(row, m);
    return { imported, allocated, diff: allocated - imported, ok: Math.abs(allocated - imported) < 1, closeMonth: closes[closes.length - 1] || 0 };
  }

  /** Write one figure into one cell. `field` is 'billed' (a correction that
      overrides the import) or 'accrued' (the human's allocation). Passing
      null clears the entry — for billed, that restores the imported figure. */
  function setCellAmount(year, key, month, field, value) {
    if (!isAdmin(getCurrentUser())) throw new Error('Only an admin can edit revenue actuals.');
    const rev = readRevenue();
    const y = (rev.ledger || {})[String(year)];
    if (!y || !y.rows || !y.rows[key]) return null;
    const row = y.rows[key];
    const bucket = field === 'billed' ? 'billedEdit' : 'accrued';
    row[bucket] = row[bucket] || {};
    if (value == null || value === '') delete row[bucket][month];
    else row[bucket][month] = Number(value) || 0;
    row.updatedAt = new Date().toISOString();
    writeRevenue(rev);
    return row;
  }

  /** Spread an accrual lump evenly across a run of months — the common case
      by far, and the reason the lump is unusable as imported. Remainder lands
      on the last month so the allocation foots to the cent. */
  function spreadAccrual(year, key, fromMonth, toMonth, amount) {
    if (!isAdmin(getCurrentUser())) throw new Error('Only an admin can edit revenue actuals.');
    const rev = readRevenue();
    const y = (rev.ledger || {})[String(year)];
    if (!y || !y.rows || !y.rows[key]) return null;
    const row = y.rows[key];
    const a = +fromMonth, b = +toMonth;
    if (!(a >= 1 && b <= 12 && a <= b)) throw new Error('Pick a month range inside the year.');
    const total = (amount == null) ? accrualCheck(row).imported : Number(amount) || 0;
    const n = b - a + 1;
    const each = Math.round((total / n) * 100) / 100;
    row.accrued = row.accrued || {};
    for (let m = a; m <= b; m++) row.accrued[m] = each;
    row.accrued[b] = Math.round((total - each * (n - 1)) * 100) / 100;   // remainder on the last month
    row.updatedAt = new Date().toISOString();
    writeRevenue(rev);
    return row;
  }

  /** Column totals for a year: billed, fee share, accrued and recognised,
      per month plus the year. */
  function yearTotals(year) {
    const y = getLedgerYear(year);
    if (!y) return null;
    const blank = () => Array.from({ length: 13 }, () => 0);
    const t = { billed: blank(), feeShare: blank(), accrued: blank(), plan: blank(), recognised: blank(), rows: 0 };
    Object.values(y.rows || {}).forEach(r => {
      t.rows++;
      for (let m = 1; m <= 12; m++) {
        t.billed[m] += billedOf(r, m);
        t.feeShare[m] += feeShareOf(r, m);
        t.accrued[m] += accruedOf(r, m);
        t.recognised[m] += cellRecognised(r, m);
      }
    });
    const sum = (a) => a.reduce((x, y2) => x + y2, 0);
    t.total = { billed: sum(t.billed), feeShare: sum(t.feeShare), accrued: sum(t.accrued), recognised: sum(t.recognised) };
    // The unallocated remainder across the book — money Finance has accrued
    // that nobody has placed in a month yet.
    t.unallocated = Object.values(y.rows || {}).reduce((a, r) => { const c = accrualCheck(r); return a + (c.imported - c.allocated); }, 0);
    return t;
  }

  /** Cells a human still has to rule on: money moved (or was planned and
      didn't) and nobody has said what that means. */
  function openCells(year) {
    const y = getLedgerYear(year);
    if (!y) return [];
    const out = [];
    Object.entries(y.rows || {}).forEach(([key, r]) => {
      for (let m = 1; m <= 12; m++) {
        if (!cellHasValue(r, m)) continue;
        if (!(r.status || {})[m]) out.push({ key, month: m, row: r, recognised: cellRecognised(r, m) });
      }
    });
    return out;
  }


  function importDb(jsonStr, mode = 'merge') {
    const incoming = JSON.parse(jsonStr);
    if (!incoming || typeof incoming !== 'object' || !incoming.projects || typeof incoming.projects !== 'object') throw new Error('Invalid file — no projects key.');
    const db = readDb();
    const inCount = Object.keys(incoming.projects).length;
    if (mode === 'replace') {
      const localCount = Object.keys(db.projects).length;
      // Never let an empty/near-empty file nuke a populated shared db.
      if (localCount > 0 && inCount === 0) throw new Error('Refusing to replace ' + localCount + ' project(s) with an empty file. Use merge, or delete projects individually.');
      // Preserve the audit trail across a replace.
      incoming.activity = [...(db.activity || []), ...(incoming.activity || [])].slice(-500);
      writeDb(incoming);
      return inCount;
    }
    // MERGE (default): newest-updatedAt wins per project, so importing an old
    // backup can never clobber newer work (matches the Box merge strategy).
    Object.entries(incoming.projects).forEach(([id, ip]) => {
      const cur = db.projects[id];
      if (!cur || ((ip && ip.updatedAt) || '') >= (cur.updatedAt || '')) db.projects[id] = ip;
    });
    writeDb(db);
    return inCount;
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
        if (lockOn) lockCredit += Math.max(0, (unlocked - locked) * fte * hrs) * (1 - discPct);
      });
    });
    const discount = (gross) * discPct;
    const net = gross - lockCredit - discount;
    // Pass-through lines carry Savills revenue as the markup (the fee %), walled
    // off from discount / rate-lock. Both modes (billed / managed) earn the markup.
    // Projects with NO priced roles (e.g. Small Works) live entirely here.
    const pt = p.passthrough || {};
    const ptLines = (pt.enabled && Array.isArray(pt.lines)) ? pt.lines : [];
    let ptMarkup = 0;
    ptLines.forEach(l => {
      const c = parseFloat(l.cost) || 0;
      const mk = (parseFloat(l.markupPct) || 0) / 100;
      ptMarkup += c * mk;
    });
    return { gross: gross + ptMarkup, lockCredit, discount, net: net + ptMarkup, fteMonths, passThroughMarkup: ptMarkup };
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

    // Per-month effective discount. Normally the single global discount; after a
    // Rate Grid Reconciliation run a project carries a per-month override vector
    // (rateReconcile.byMonth: ym → discount) that holds each month's billing
    // constant when the underlying grid changes. Absent → identical to before.
    const reconMap = (p.rateReconcile && p.rateReconcile.byMonth) || null;
    const dFor = (ymKey) => (reconMap && reconMap[ymKey] != null) ? reconMap[ymKey] : discPct;

    let gross = 0, fteMonths = 0;
    // Accumulate GRID-VALUE (discount-independent) per month so a per-month
    // discount can be applied uniformly afterward: gU = unlocked gross, lRaw =
    // raw (pre-discount) rate-lock credit.
    const groupGU = {}, groupLRaw = {}, monthGU = {}, monthLRaw = {};
    const groupMonthGU = {}, groupMonthLRaw = {};
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
        const lRaw = lockOn ? Math.max(0, (unlocked - locked) * fte * hrs) : 0;
        gross += g;
        const grp = r.groupId || 'core';
        const ymKey = m.year + '-' + String(m.month).padStart(2, '0');
        groupGU[grp] = (groupGU[grp] || 0) + g;
        groupLRaw[grp] = (groupLRaw[grp] || 0) + lRaw;
        monthGU[ymKey] = (monthGU[ymKey] || 0) + g;
        monthLRaw[ymKey] = (monthLRaw[ymKey] || 0) + lRaw;
        (groupMonthGU[grp] = groupMonthGU[grp] || {})[ymKey] = (groupMonthGU[grp][ymKey] || 0) + g;
        (groupMonthLRaw[grp] = groupMonthLRaw[grp] || {})[ymKey] = (groupMonthLRaw[grp][ymKey] || 0) + lRaw;
      });
    });
    if (!(gross > 0) && !(p.passthrough && p.passthrough.enabled && (p.passthrough.lines || []).some(l => (parseFloat(l.cost) || 0) > 0))) return null;   // nothing priced & no pass-through — don't freeze $0

    // Apply the (per-month) discount to grid values → net, credit, discount, monthNet.
    const monthNet = {};
    let lock = 0, discount = 0;
    Object.keys(monthGU).forEach(ym => {
      const d = dFor(ym), gU = monthGU[ym], lR = monthLRaw[ym] || 0;
      monthNet[ym] = (gU - lR) * (1 - d);           // held constant by the reconcile vector
      lock += lR * (1 - d);
      discount += gU * d;
    });
    const net = gross - lock - discount;
    const byGroup = Object.keys(groupGU).map(grp => {
      const gm = groupMonthGU[grp] || {}, lm = groupMonthLRaw[grp] || {};
      let gnet = 0;
      Object.keys(gm).forEach(ym => { gnet += (gm[ym] - (lm[ym] || 0)) * (1 - dFor(ym)); });
      return { group: grp, net: round2(gnet) };
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
        if (lockOn) lockC += Math.max(0, (unlocked - locked) * fte * hrs) * (1 - discPct);
      });
      totalGross += gross; totalLock += lockC;
      return { year: m.year, month: m.month, gross, lockC };
    });
    const net = totalGross - totalLock - totalGross * discPct;

    if ((p.assumptions?.billingMode) === 'flatline') {
      // Flatline distributes the project's net evenly; a service-line slice gets
      // its proportional share of each flat month.
      const flat = months.length ? net / months.length : 0;
      if (!slFilter) return applyOverrides(rows.map(r => ({ year: r.year, month: r.month, amount: flat })), p, slFilter, opts && opts.raw);
      const sliceGross = totalGross || 1;
      return rows.map(r => ({ year: r.year, month: r.month, amount: flat * (r.gross / sliceGross) }));
    }
    let series = rows.map(r => ({ year: r.year, month: r.month, amount: r.gross * (1 - discPct) - r.lockC }));
    return applyOverrides(series, p, slFilter, opts && opts.raw);
  }

  /** Imported broker (fee-share) series for a project, by month. */
  function importedBrokerSeries(p) {
    return (p.source && p.source.brokerByMonth) || null;
  }

  /* ============================================================
     RATE GRID RECONCILIATION
     ------------------------------------------------------------
     One-time batch: ingest a NEW rate grid and, per project, solve a
     per-MONTH reconciling discount so every frozen monthly billing figure
     (financials.byMonth[].net) holds EXACTLY against the new rack rates.
     The project total falls out as the sum of held months. Dry-run first;
     commit snapshots a version, writes the per-month vector, and re-stamps
     (billing unchanged). Floor breaches / uplifts / unsolvable months are
     FLAGGED, never auto-changed. */
  function reconcileTierFloor(newCat, role, p) {
    const title = newCat?.titles?.find(t => t.id === role.titleId);
    if (!title) return null;
    const tier = title.tiers.find(x => x.id === role.tierId)
      || title.tiers.find(x => x.id === 'mid') || title.tiers[0];
    return tier ? (tier.costFloor ?? null) : null;
  }
  /** Dry-run: reconcile ONE project to `newCat`. Returns per-month rows + flags. */
  function reconcileToGrid(p, newCat) {
    const fin = p.financials;
    if (!fin || !Array.isArray(fin.byMonth) || !fin.byMonth.length)
      return { status: 'no-frozen', reason: 'No frozen billing series — book/stamp the project first.' };
    if (p.source && p.source.importedByMonth && !(p.roles || []).length)
      return { status: 'no-grid', reason: 'Imported $ with no staffing — not grid-priced.' };
    const frozen = {}; fin.byMonth.forEach(x => { frozen[x.ym] = x.net; });
    const hrs = p.assumptions?.hrsPerMo || 173.33;
    const esc = (p.assumptions?.escalation || 0) / 100;
    const startYear = p.timeline?.startYear || (p.assumptions?.catalogBaseYear || 2024);
    const lockOn = !!p.assumptions?.rateLock;
    const months = enumerateMonths(p.timeline);
    const byPhase = computeMonthsByPhase(p);
    const phaseOfMonth = {};
    (p.phases || []).forEach(ph => (byPhase[ph.id] || []).forEach(m => { phaseOfMonth[m.year + '-' + m.month] = ph.id; }));
    // New-grid gross (unlocked) + raw lock per month; plus floor watch per role/month.
    const newGU = {}, newLRaw = {}; const flags = [];
    p.roles.forEach(r => {
      const { base, anchorYear } = resolveRoleRate(r, newCat, p);
      const floor = reconcileTierFloor(newCat, r, p);
      months.forEach(m => {
        const mk = m.year + '-' + m.month;
        const fte = ((r.fteMonthly && r.fteMonthly[mk] != null) ? r.fteMonthly[mk] : (r.fte?.[phaseOfMonth[mk]] || 0)) / 100;
        if (!fte || !base) return;
        const ym = m.year + '-' + String(m.month).padStart(2, '0');
        const unlocked = base * Math.pow(1 + esc, m.year - anchorYear);
        const locked = base * Math.pow(1 + esc, startYear - anchorYear);
        newGU[ym] = (newGU[ym] || 0) + fte * unlocked * hrs;
        newLRaw[ym] = (newLRaw[ym] || 0) + (lockOn ? Math.max(0, (unlocked - locked) * fte * hrs) : 0);
        r.__floorYm = floor;   // stash for post-discount check below
      });
    });
    const round2 = (n) => Math.round(n * 100) / 100;
    const round4 = (n) => Math.round(n * 10000) / 10000;
    const vector = {}; const rows = []; let heldTot = 0, frozenTot = 0;
    const yms = Array.from(new Set([...Object.keys(frozen), ...Object.keys(newGU)])).sort();
    yms.forEach(ym => {
      const fN = round2(frozen[ym] || 0);
      const base = (newGU[ym] || 0) - (newLRaw[ym] || 0);   // new-grid net base at 0% discount
      frozenTot += fN;
      let d = null, held = fN, note = '';
      if (base <= 0.005) {
        if (Math.abs(fN) > 0.005) { note = 'unsolvable'; flags.push({ ym, type: 'unsolvable', detail: `frozen $${fN.toFixed(0)} but new grid prices $0 this month` }); held = 0; }
      } else {
        const dRaw = 1 - fN / base;            // FULL precision — penny-exact on recompute
        d = dRaw;
        vector[ym] = dRaw;
        if (dRaw < 0) flags.push({ ym, type: 'uplift', detail: `new grid lower — needs ${(dRaw * 100).toFixed(1)}% uplift to hold` });
      }
      heldTot += held;
      rows.push({ ym, frozenNet: fN, newBase: round2(base), discount: d == null ? null : round4(d), held: round2(held), delta: round2(held - fN) });
    });
    // Floor watch: with the solved per-month discount, is any role below the new floor?
    p.roles.forEach(r => {
      const { base, anchorYear } = resolveRoleRate(r, newCat, p);
      const floor = reconcileTierFloor(newCat, r, p);
      if (!base || floor == null) return;
      months.forEach(m => {
        const mk = m.year + '-' + m.month;
        const fte = ((r.fteMonthly && r.fteMonthly[mk] != null) ? r.fteMonthly[mk] : (r.fte?.[phaseOfMonth[mk]] || 0)) / 100;
        if (!fte) return;
        const ym = m.year + '-' + String(m.month).padStart(2, '0');
        const d = vector[ym]; if (d == null) return;
        const yr = lockOn ? startYear : m.year;
        const effRate = base * Math.pow(1 + esc, yr - anchorYear) * (1 - d);
        if (effRate < floor - 0.005) flags.push({ ym, type: 'floor', detail: `${r.role || r.titleId}: billed $${effRate.toFixed(0)}/hr < floor $${floor.toFixed(0)}` });
      });
    });
    return {
      status: 'ok',
      grid: newCat.source || 'new grid',
      rows, vector, flags,
      frozenTotal: round2(frozenTot), heldTotal: round2(heldTot),
      totalDelta: round2(heldTot - frozenTot),
      exceptions: flags.length,
    };
  }
  /** Commit a reconciliation: snapshot a version, store the per-month vector +
      grid tag, and re-stamp financials (billing held by the vector). */
  function commitReconcile(id, newCat, report) {
    const db = readDb();
    const r = db.projects[id];
    if (!r || !report || report.status !== 'ok') return null;
    writeDb(db);
    saveVersion(id, { note: `Pre-reconciliation snapshot (→ ${newCat.source || 'new grid'})`, auto: true });
    const r2 = readDb().projects[id];
    r2.rateReconcile = {
      grid: newCat.source || 'new grid',
      committedAt: new Date().toISOString(),
      byMonth: report.vector,
      exceptions: report.flags,
    };
    if (r2.assumptions) r2.assumptions.catalogSource = newCat.source || 'new grid';
    const fin = computeFinancials(r2, newCat);   // honors rateReconcile → billing holds
    if (fin) { fin.inputsHash = financialsInputsHash(r2); fin.stale = false; fin.basis = r2.financials?.basis || 'booked'; r2.financials = fin; }
    r2.updatedAt = new Date().toISOString();
    const db2 = readDb(); db2.projects[id] = r2; writeDb(db2);
    return r2;
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
  function applyOverrides(series, p, slFilter, raw) {
    if (slFilter || raw) return series;             // a slice, or a deliberately raw read
    const ov = p.monthlyOverrides;
    const withOv = !ov ? series : series.map(s => {
      const k = s.year + '-' + s.month;
      return (ov[k] != null && !isNaN(ov[k])) ? { ...s, amount: Number(ov[k]), overridden: true } : s;
    });
    return applySlips(withOv, p);
  }

  /* ============================================================
     REVENUE SLIPS — Finance moving money between months
     ------------------------------------------------------------
     When a close shows a month that was planned to bill and didn't —
     neither invoiced nor accrued — the fee is not lost, it is late.
     Reconciliation records that as a SLIP against the project: an
     amount, the month it should have billed, and the month it is now
     expected in.

     A slip MOVES money, it never creates or destroys it: the same
     figure comes off the from-month and lands on the to-month, so a
     project's total is identical before and after. That invariant is
     what makes this safe to let Finance write into a revenue leader's
     forecast at all, and it is asserted in the test suite.

     Slips stay OPEN until someone reconciles them, and every page
     that reads monthlySeries gets `slipOut` / `slipIn` flags on the
     affected months so an open slip shows in red wherever the
     forecast is read. Reconciling does not undo the move — the money
     really did shift — it just stops the shouting.
     ============================================================ */
  const slipYm = (y, m) => y + '-' + String(m).padStart(2, '0');
  function projectSlips(p) { return (p && p.revenueSlips) || []; }
  function openSlips(p) { return projectSlips(p).filter(s => !s.reconciled); }
  const changeKind = (s) => s.kind || 'slip';       // records written before adjustments existed

  /** Fold open AND reconciled slips into a monthly series. Both move money —
      reconciling is an acknowledgement, not a reversal — but only open ones
      raise a flag for the UI to paint. */
  function applySlips(series, p) {
    const changes = projectSlips(p);
    if (!changes.length) return series;
    const byKey = {};
    series.forEach(s => { byKey[slipYm(s.year, s.month)] = { ...s }; });
    changes.forEach(sl => {
      if (changeKind(sl) === 'adjust') {
        // A plan correction: Finance found the month should have been a
        // different figure. Changes the year's total — that is the point.
        const d = Number(sl.delta) || 0;
        const cell = byKey[sl.ym];
        if (!d || !cell) return;
        cell.amount += d;
        if (!sl.reconciled) cell.adjusted = (cell.adjusted || 0) + d;
        return;
      }
      const amt = Number(sl.amount) || 0;
      if (!amt) return;
      const from = byKey[sl.fromYm], to = byKey[sl.toYm];
      if (from) { from.amount -= amt; if (!sl.reconciled) { from.slipOut = (from.slipOut || 0) + amt; } }
      if (to) { to.amount += amt; if (!sl.reconciled) { to.slipIn = (to.slipIn || 0) + amt; } }
    });
    return series.map(s => byKey[slipYm(s.year, s.month)] || s);
  }

  /** Record a plan ADJUSTMENT: this month should have been a different number.
      Unlike a slip it changes the year — money is added or removed, not moved —
      and like a slip it stays open (red everywhere) until someone reconciles it. */
  function recordAdjustment(projectId, adj) {
    if (!isAdmin(getCurrentUser())) throw new Error('Only an admin can adjust a project plan.');
    const db = readDb();
    const p = db.projects[projectId];
    if (!p) return null;
    p.revenueSlips = p.revenueSlips || [];
    const cu = getCurrentUser() || {};
    const idx = p.revenueSlips.findIndex(s => changeKind(s) === 'adjust' && s.ledgerKey === adj.ledgerKey && s.ym === adj.ym);
    const rec = {
      kind: 'adjust', ledgerKey: adj.ledgerKey || '', ym: adj.ym,
      delta: Number(adj.delta) || 0, was: Number(adj.was) || 0, now: Number(adj.now) || 0,
      note: adj.note || '', source: 'reconciliation', reconciled: false,
      at: new Date().toISOString(), by: cu.name || cu.username || 'admin',
    };
    if (idx >= 0) rec.id = p.revenueSlips[idx].id;
    else rec.id = 'adj_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (idx >= 0) p.revenueSlips[idx] = rec; else p.revenueSlips.push(rec);
    p.updatedAt = new Date().toISOString();
    writeDb(db);
    logActivity('plan-adjust', projectId, { ym: adj.ym, delta: rec.delta });
    return p;
  }

  /* ============================================================
     SCHEDULE SHIFT — moving the work, not just the money
     ------------------------------------------------------------
     A slip says the fee arrives later. Usually that is because the
     WORK is later, and until the schedule moves with it the roster
     still shows people booked in a month that earns nothing. This
     shifts a project's timeline by N months and carries the per-month
     staffing with it, so effort and revenue stay in step.

     Phase lengths are untouched — the shape of the job does not
     change, it just starts later, which is what "push it out two
     months" actually means.
     ============================================================ */
  function shiftSchedule(projectId, months) {
    if (!isAdmin(getCurrentUser())) throw new Error('Only an admin can move a project schedule.');
    const n = parseInt(months, 10);
    if (!n) return null;
    const db = readDb();
    const p = db.projects[projectId];
    if (!p || !p.timeline) return null;
    const bump = (y, m) => { const d = new Date(y, (m - 1) + n, 1); return { year: d.getFullYear(), month: d.getMonth() + 1 }; };
    const st = bump(p.timeline.startYear, p.timeline.startMonth);
    const en = bump(p.timeline.endYear || p.timeline.startYear, p.timeline.endMonth || p.timeline.startMonth);
    p.timeline = { ...p.timeline, startYear: st.year, startMonth: st.month, endYear: en.year, endMonth: en.month };
    // Carry the month-level staffing with the dates, or a shifted schedule
    // would keep pointing its FTE at the months it just left.
    (p.roles || []).forEach(r => {
      if (!r.fteMonthly) return;
      const moved = {};
      Object.entries(r.fteMonthly).forEach(([k, v]) => {
        const [y, m] = k.split('-').map(Number);
        const t = bump(y, m);
        moved[t.year + '-' + t.month] = v;
      });
      r.fteMonthly = moved;
    });
    // Monthly billing overrides are keyed by month too.
    if (p.monthlyOverrides) {
      const mo = {};
      Object.entries(p.monthlyOverrides).forEach(([k, v]) => {
        const [y, m] = k.split('-').map(Number);
        const t = bump(y, m);
        mo[t.year + '-' + t.month] = v;
      });
      p.monthlyOverrides = mo;
    }
    p.scheduleShiftedAt = new Date().toISOString();
    p.updatedAt = p.scheduleShiftedAt;
    // The frozen snapshot is now describing the wrong months — restamp it.
    const catalog = (typeof window !== 'undefined') && window.RATES_CATALOG;
    if (catalog && catalog.hydrated) {
      const fin = computeFinancials(p, catalog);
      if (fin) { fin.inputsHash = financialsInputsHash(p); fin.stale = false; p.financials = fin; }
    } else if (p.financials) { p.financials.stale = true; }
    writeDb(db);
    logActivity('schedule-shift', projectId, { months: n, start: st.year + '-' + st.month });
    return p;
  }

  /** THE canonical monthly billing series — what every page should read.
      ------------------------------------------------------------------
      Freezing protects the PRICE, not the CALENDAR. A booked record's
      frozen snapshot is the authority on what the work is worth (immune to
      later rate-grid changes), but the month-by-month distribution stays
      live, because overrides, slips and adjustments are exactly the things
      that must show up after a record is booked. Reading the frozen
      byMonth raw — which Revenue Projections and the staffing dollars view
      both did — meant a monthly edit was recorded, flagged in red, and
      then displayed at its old value. */
  function billingSeries(p, catalog) {
    const fs = (p.assumptions && p.assumptions.feeShare) || {};
    const pct = fs.enabled ? (parseFloat(fs.pct) || 0) / 100 : 0;
    const onTop = fs.mode === 'ontop';
    const fin = p.financials;
    const base = {};
    if (fin && Array.isArray(fin.byMonth) && fin.byMonth.length) {
      fin.byMonth.forEach(s => {
        const [y, m] = s.ym.split('-').map(Number);
        base[y + '-' + m] = { year: y, month: m, net: s.net || 0,
          broker: s.broker || 0, passCost: s.passCost || 0, passClient: s.passClient || 0 };
      });
    } else {
      (monthlySeries(p, catalog, { raw: true }) || []).forEach(s => {
        base[s.year + '-' + s.month] = { year: s.year, month: s.month, net: s.amount,
          broker: s.amount * pct, passCost: 0, passClient: 0 };
      });
    }
    // The live series carries the same months with overrides + changes folded
    // in; use it as the authority on `net` and on the flags.
    const live = monthlySeries(p, catalog) || [];
    const out = [];
    const seen = {};
    live.forEach(s => {
      const k = s.year + '-' + s.month;
      const b = base[k] || { net: s.amount, broker: 0, passCost: 0, passClient: 0 };
      const net = s.amount;
      // Broker/pass-through ride the ORIGINAL proportions — a monthly edit
      // changes what we bill, not the deal behind it.
      const ratio = b.net ? net / b.net : 1;
      const broker = (b.broker || 0) * ratio;
      out.push({
        ym: k, year: s.year, month: s.month, net,
        invoice: (onTop ? net + broker : net) + (b.passClient || 0),
        broker, passCost: b.passCost || 0, passClient: b.passClient || 0,
        overridden: !!s.overridden, slipOut: s.slipOut || 0, slipIn: s.slipIn || 0, adjusted: s.adjusted || 0,
      });
      seen[k] = true;
    });
    // Months the snapshot knows about that the live compute doesn't reach.
    Object.entries(base).forEach(([k, b]) => {
      if (seen[k]) return;
      out.push({ ym: k, year: b.year, month: b.month, net: b.net, invoice: (onTop ? b.net + b.broker : b.net) + (b.passClient || 0),
                 broker: b.broker, passCost: b.passCost, passClient: b.passClient, overridden: false, slipOut: 0, slipIn: 0, adjusted: 0 });
    });
    return out.sort((a, b) => a.year - b.year || a.month - b.month);
  }

  /** Record (or update) a slip on a project. Keyed by the ledger cell it came
      from, so re-picking the carry month moves the existing slip instead of
      stacking a second one on top. */
  function recordSlip(projectId, slip) {
    if (!isAdmin(getCurrentUser())) throw new Error('Only an admin can move revenue between months.');
    const db = readDb();
    const p = db.projects[projectId];
    if (!p) return null;
    p.revenueSlips = p.revenueSlips || [];
    const cu = getCurrentUser() || {};
    const idx = p.revenueSlips.findIndex(s => s.ledgerKey === slip.ledgerKey && s.fromYm === slip.fromYm);
    if (idx >= 0) {
      // Keep the amount settled at creation: the plan has already moved to
      // reflect this slip, so recomputing it here would shrink it each time.
      p.revenueSlips[idx] = { ...p.revenueSlips[idx], toYm: slip.toYm, note: slip.note || p.revenueSlips[idx].note, at: new Date().toISOString(), by: cu.name || cu.username || 'admin' };
    } else {
      p.revenueSlips.push({
        id: 'slip_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        ledgerKey: slip.ledgerKey || '', fromYm: slip.fromYm, toYm: slip.toYm,
        amount: Number(slip.amount) || 0, note: slip.note || '',
        source: 'reconciliation', reconciled: false,
        at: new Date().toISOString(), by: cu.name || cu.username || 'admin',
      });
    }
    p.updatedAt = new Date().toISOString();
    writeDb(db);
    logActivity('slip', projectId, { from: slip.fromYm, to: slip.toYm, amount: Number(slip.amount) || 0 });
    return p;
  }

  /** Drop a slip — used when a cell's status stops being 'slipped'. */
  function removeSlip(projectId, match) {
    if (!isAdmin(getCurrentUser())) throw new Error('Only an admin can move revenue between months.');
    const db = readDb();
    const p = db.projects[projectId];
    if (!p || !p.revenueSlips) return null;
    const before = p.revenueSlips.length;
    p.revenueSlips = p.revenueSlips.filter(s => match.id ? s.id !== match.id
      : !(s.ledgerKey === match.ledgerKey && s.fromYm === match.fromYm));
    if (p.revenueSlips.length !== before) {
      p.updatedAt = new Date().toISOString();
      writeDb(db);
      logActivity('slip-remove', projectId, { from: match.fromYm || null });
    }
    return p;
  }

  /** Mark a slip settled. The money stays where the slip put it; this only
      clears the red. */
  function reconcileSlip(projectId, slipId, on) {
    if (!isAdmin(getCurrentUser())) throw new Error('Only an admin can reconcile a slip.');
    const db = readDb();
    const p = db.projects[projectId];
    if (!p || !p.revenueSlips) return null;
    const sl = p.revenueSlips.find(s => s.id === slipId);
    if (!sl) return null;
    const cu = getCurrentUser() || {};
    sl.reconciled = on !== false;
    sl.reconciledAt = sl.reconciled ? new Date().toISOString() : null;
    sl.reconciledBy = sl.reconciled ? (cu.name || cu.username || 'admin') : null;
    p.updatedAt = new Date().toISOString();
    writeDb(db);
    logActivity(sl.reconciled ? 'slip-reconciled' : 'slip-reopened', projectId, { from: sl.fromYm, to: sl.toYm, amount: sl.amount });
    return p;
  }

  /** Every unreconciled slip in the book — drives the red banner on
      Revenue Projections. */
  function allOpenSlips() {
    const out = [];
    listProjects().forEach(p => openSlips(p).forEach(s => out.push({
      projectId: p.id,
      name: (p.project && p.project.name) || 'Untitled',
      client: (p.project && p.project.client) || '',
      ...s,
    })));
    return out.sort((a, b) => (a.fromYm || '').localeCompare(b.fromYm || ''));
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
    'kyerou@savills.us',      // Kyri Yerou — developer (on the Savills system now)
    'esobel@savills.us',     // Emily Sobel
    'jsantoro@savills.us',   // Jeff Santoro
    'mglatt@savills.us',     // Michael Glatt
    'mhadim@savills.us',     // Maria Hadim
    'eglatt@savills.us',     // Emily Glatt
    'cglatt@savills.us',     // Cara Glatt
  ].map(s => s.toLowerCase()));

  /* ------------------------------------------------------------
     TOOL ADMINS — admin TOOLS, member PROJECT ACCESS.
     These logins get the admin-only tools (Staffing & Bandwidth,
     Revenue Studio, Profitability, Ingestion, Data Repair, …) but
     their project visibility is unchanged: they still see only the
     projects they lead / own / are granted, exactly like a member.
     Use this for people who run an operational function without
     needing the whole firm's fee book.
     ------------------------------------------------------------ */
  const TOOL_ADMINS = new Set([
    'bjosselson@savills.us', // Benay Josselson — admin tools; project list stays her own
  ].map(s => s.toLowerCase()));

  /* Per-user EXTRA visibility: a member ALSO sees any project carrying a group
     whose name matches one of their patterns — on top of lead/team/grant access.
     Benay: every project with a "Change Management" group (plus her own and
     Tonya's projects via the normal team/lead path). */
  const GROUP_ACCESS = {
    'bjosselson@savills.us': [/change\s*(management|mgmt)/i],
  };
  function groupAccessRules(login) { return GROUP_ACCESS[String(login || '').trim().toLowerCase()] || null; }

  /* These logins may use the "Viewing as" impersonation switch to preview
     other people's restricted views. Everyone else never sees the control. */
  const SUPERUSERS = new Set([
    'sabdin@savills.us',
    'salim@savills.us',
    'kyerou@savills.us',
  ]);

  function roleFor(login) {
    const k = String(login || '').trim().toLowerCase();
    return (ADMINS.has(k) || TOOL_ADMINS.has(k)) ? 'admin' : 'member';
  }
  /** TRUE only for people who may see EVERY project. Tool admins are role
      'admin' (so the admin tools open for them) but are NOT here — their
      project list stays member-scoped. Every data-visibility decision must
      use this, never isAdmin(). */
  function seesAllProjects(user) {
    const u = user || getCurrentUser();
    return ADMINS.has(String(u.username || '').trim().toLowerCase());
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
  const BASE_REVENUE_LEADERS = [
    { id: 'acpeters',  displayName: 'Andrew Peters',    username: 'acpeters@savills.us',   aliases: ['Andrew Peters', 'A. Peters', 'Peters', 'AP'] },
    { id: 'bjosselson',displayName: 'Benay Josselson',  username: 'bjosselson@savills.us',  aliases: ['Benay Josselson', 'B. Josselson', 'Josselson', 'BLJ'] },
    { id: 'bking',     displayName: 'Brianna King',     username: 'bshepparding@savills.us',aliases: ['Brianna King', 'B. King', 'King', 'Brianna Sheppard King', 'BSK'] },
    { id: 'emerkelson',displayName: 'Eric Merkelson',   username: 'emerkelson@savills.us',  aliases: ['Eric Merkelson', 'E. Merkelson', 'Merkelson', 'EM'] },
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
  /** Base directory plus any leader added later (Bulk Editor Lists sheet).
      Custom entries carry the same shape, so ownership, impersonation and
      every dropdown treat them identically. */
  function allRevenueLeaders() {
    const extra = (readVocab().leaders || []).filter(l => l && l.id && !BASE_REVENUE_LEADERS.some(b => b.id === l.id));
    return BASE_REVENUE_LEADERS.concat(extra);
  }
  function leaderById(id) { return allRevenueLeaders().find(l => l.id === id) || null; }
  /** Resolve any stored value (id, displayName, alias, or username) to a leader. */
  function resolveLeader(value) {
    if (!value) return null;
    const v = String(value).trim();
    const vk = v.toLowerCase();
    return allRevenueLeaders().find(l =>
      l.id === v ||
      String(l.username || '').toLowerCase() === vk ||
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
  function isSuperuser() {
    const r = getRealIdentity();
    return !!r && SUPERUSERS.has(String(r.username || '').toLowerCase());
  }
  function canImpersonate() { return isSuperuser(); }
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
    allRevenueLeaders().forEach(l => { const k = String(l.username || '').toLowerCase(); if (k) seen.add(k); list.push({ username: l.username || '', name: l.displayName, role: roleFor(l.username || '') }); });
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
    // Group-based visibility (e.g. Benay sees every Change Management group).
    const rules = groupAccessRules(u.username);
    if (rules && (p.groups || []).some(g => rules.some(rx => rx.test((g && g.name) || '')))) return true;
    return false;
  }
  /** The access wall: admins get everything; members get only their own. */
  function visibleProjects(projects, user) {
    const u = user || getCurrentUser();
    if (seesAllProjects(u)) return projects;   // NOT isAdmin — tool admins stay scoped
    return projects.filter(p => userOwnsProject(p, u));
  }

  window.UFC_Store = {
    SCHEMA, STATUSES, STATUS_LABELS, ASSUMPTION_LIBRARY, projectTypeSubs, addVocab, readVocab,
    accessGrantList, parseAccessEmails,
    RATINGS, ratingFor, ratingMeta, STATUS_DEFAULT_RATING,
    SERVICE_LINES, serviceLineOfGroup, serviceLinesOfGroup, projectServiceLines, inferServiceLine,
    listProjects, getProject, saveProject, deleteProject, migrateLeadIds,
    allProjectsRaw, restoreDeleted, purgeTombstones, logActivity, listActivity, describeChanges,
    saveVersion, listVersions, versionDiff, restoreVersionRecord, rosterDiff,
    reconcileToGrid, commitReconcile,
    proposalHealth,
    exportDb, importDb, downloadJson,
    FLASH_LABELS, captureSnapshot, getSnapshots, deleteSnapshot, periodKey,
    DISPOSITIONS, DISPOSITION_LABEL, LEDGER_FIRST_YEAR,
    ledgerYears, getLedgerYear, closedThrough, postLedgerYear, deleteLedgerYear,
    setCellStatus, setRowMatch, setCellAmount, spreadAccrual,
    createProjectFromLedgerRow, ledgerCoverage,
    cellRecognised, cellHasValue, billedOf, accruedOf, feeShareOf, accrualCheck,
    yearTotals, openCells,
    projectFinancials, getTierRateFromCatalog, resolveRoleRate, monthlySeries,
    computeFinancials, financialsInputsHash, restampFinancials,
    isChangeOrder, childChangeOrders, approvedChangeOrders, createChangeOrder,
    importedBrokerSeries, reconcileImport,
    projectSlips, openSlips, recordSlip, removeSlip, reconcileSlip, allOpenSlips,
    recordAdjustment, shiftSchedule, billingSeries,
    approveChangeOrder, changeOrderDelta, changeOrderRoleDiff, revisedContract, clientRollup,
    enumerateMonths, computeMonthsByPhase,
    getCurrentUser, setCurrentUser, isAdmin, seesAllProjects, userOwnsProject, visibleProjects,
    setRealIdentity, getRealIdentity, isSuperuser, canImpersonate, setImpersonation, clearImpersonation, getImpersonation, roleFor, impersonationRoster,
    getMaintenance, setMaintenance, assertWritable,
    leaderById, resolveLeader, leaderDisplay,
    attachRemote, hydrateFromRemote, defaultDb, runMigrations,
    attachStudioRemote, hydrateStudioFromRemote, readStudio, defaultStudio,
    attachRevenueRemote, hydrateRevenueFromRemote, readRevenue, defaultRevenue,
    listBaselines, getBaseline, saveBaseline, deleteBaseline, baselineFromBudget, baselineGridForSlice,
    listScenarios, getScenario, saveScenario, deleteScenario,
  };
  /* Vocabulary reads stay dynamic without touching a single call site. */
  Object.defineProperties(window.UFC_Store, {
    INDUSTRIES:    { get: allIndustries,   enumerable: true },
    PROJECT_TYPES: { get: allProjectTypes, enumerable: true },
    LOST_REASONS:  { get: allLostReasons,  enumerable: true },
    REVENUE_LEADERS: { get: allRevenueLeaders, enumerable: true },
  });
})();
