/* ============================================================
   SAVILLS PPM · FEE SYSTEM · localStorage data store
   Schema-versioned project records.
   ============================================================ */
(function () {
  'use strict';
  const KEY = 'savills-ppm-fee-db:v1';
  const SCHEMA = 1;

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
    'General Office Fitout',
    'Public Sector',
    'Education',
    'Hospitality',
    'Other',
  ];

  function defaultDb() {
    return { schemaVersion: SCHEMA, projects: {} };
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

  function listProjects() {
    const db = readDb();
    return Object.values(db.projects).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  function getProject(id) {
    return readDb().projects[id] || null;
  }

  function saveProject(record) {
    const db = readDb();
    if (!record.id) record.id = 'proj_' + Math.random().toString(36).slice(2, 11);
    if (!record.createdAt) record.createdAt = new Date().toISOString();
    record.updatedAt = new Date().toISOString();
    db.projects[record.id] = record;
    writeDb(db);
    return record;
  }

  function deleteProject(id) {
    const db = readDb();
    delete db.projects[id];
    writeDb(db);
  }

  function exportDb() {
    return JSON.stringify(readDb(), null, 2);
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
        const fte = (r.fte?.[ph.id] || 0) / 100;
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

    let gross = 0, lockCredit = 0, fteMonths = 0;
    p.roles.forEach(r => {
      const tierRate = getTierRate(r);
      p.phases.forEach(ph => {
        const slice = monthsByPhase[ph.id] || [];
        const fte = (r.fte?.[ph.id] || 0) / 100;
        if (!fte || !slice.length) return;
        fteMonths += fte * slice.length;
        slice.forEach(mObj => {
          const unlocked = tierRate * Math.pow(1 + esc, mObj.year - baseYear);
          const locked   = tierRate * Math.pow(1 + esc, startYear - baseYear);
          // Gross at the PUBLISHED (unlocked) rate; Rate Lock surfaces once as lockCredit.
          // Using the locked rate here AND subtracting the credit would double-remove it.
          gross += fte * unlocked * hrs;
          if (lockOn) lockCredit += Math.max(0, (unlocked - locked) * fte * hrs);
        });
      });
    });
    const discount = (gross) * discPct;
    const net = gross - lockCredit - discount;
    return { gross, lockCredit, discount, net, fteMonths };
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

  /** Manual monthly overrides (set in Revenue Projections) replace the computed
      amount for that month. Stored as p.monthlyOverrides = { "YYYY-M": number }.
      Only applied to the whole-project view, not service-line slices. */
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
    const tier = title.tiers.find(x => x.id === role.tierId) || title.tiers[0];
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
    'salim@savills.us',      // Salim — owner
    'esobel@savills.us',     // Emily Sobel
    'jsantoro@savills.us',   // Jeff Santoro
    'mhadim@savills.us',     // Maria Hadim
    'kspiegel@savills.us',   // Kathy Spiegel
    'eglatt@savills.us',     // Emily Glatt
  ].map(s => s.toLowerCase()));

  /* Only this login may use the "Viewing as" impersonation switch to preview
     other people's restricted views. Everyone else never sees the control. */
  const SUPERUSER = 'salim@savills.us';

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
    { id: 'acpeters',  displayName: 'Andrew Peters',    username: 'acpeters@savills.us',   aliases: ['Andrew Peters', 'A. Peters', 'Peters'] },
    { id: 'bjosselson',displayName: 'Benay Josselson',  username: 'bjosselson@savills.us',  aliases: ['Benay Josselson', 'B. Josselson', 'Josselson'] },
    { id: 'bking',     displayName: 'Brianna King',     username: 'bshepparding@savills.us',aliases: ['Brianna King', 'B. King', 'King', 'Brianna Sheppard King'] },
    { id: 'esobel',    displayName: 'Emily Sobel',      username: 'esobel@savills.us',      aliases: ['Emily Sobel', 'E. Sobel', 'Sobel'] },
    { id: 'fbuscaglia',displayName: 'Fred Buscaglia',   username: 'fbuscaglia@savills.us',  aliases: ['Fred Buscaglia', 'F. Buscaglia', 'Buscaglia'] },
    { id: 'jbergen',   displayName: 'Jason Bergen',     username: 'jbergen@savills.us',     aliases: ['Jason Bergen', 'J. Bergen', 'Bergen'] },
    { id: 'jsantoro',  displayName: 'Jeff Santoro',     username: 'jsantoro@savills.us',    aliases: ['Jeff Santoro', 'J. Santoro', 'Santoro', 'Jeffrey Santoro'] },
    { id: 'jjeffrey',  displayName: 'Jessica Jeffrey',  username: 'jjeffrey@savills.us',    aliases: ['Jessica Jeffrey', 'J. Jeffrey', 'Jeffrey'] },
    { id: 'kmartinez', displayName: 'Kathryn Martinez', username: 'kmartinez@savills.us',   aliases: ['Kathryn Martinez', 'K. Martinez', 'Martinez'] },
    { id: 'kraymond',  displayName: 'Kristen Raymond',  username: 'kraymond@savills.us',    aliases: ['Kristen Raymond', 'K. Raymond', 'Raymond'] },
    { id: 'msmessina', displayName: 'Marc Messina',     username: 'msmessina@savills.us',   aliases: ['Marc Messina', 'M. Messina', 'Messina'] },
    { id: 'mmclane',   displayName: 'Michael McLane',   username: 'mmclane@savills.us',     aliases: ['Michael McLane', 'M. McLane', 'McLane', 'Mike McLane'] },
    { id: 'tmwilliams',displayName: 'Tonya Williams',   username: 'tmwilliams@savills.us',  aliases: ['Tonya Williams', 'T. Williams', 'Williams'] },
    { id: 'zsargent',  displayName: 'Zac Sargent',      username: 'zsargent@savills.us',    aliases: ['Zac Sargent', 'Z. Sargent', 'Sargent', 'Zachary Sargent'] },
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
    return !!r && r.username.toLowerCase() === SUPERUSER;
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
    return false;
  }
  /** The access wall: admins get everything; members get only their own. */
  function visibleProjects(projects, user) {
    const u = user || getCurrentUser();
    if (isAdmin(u)) return projects;
    return projects.filter(p => userOwnsProject(p, u));
  }

  window.UFC_Store = {
    SCHEMA, STATUSES, STATUS_LABELS, INDUSTRIES,
    RATINGS, ratingFor, ratingMeta, STATUS_DEFAULT_RATING,
    SERVICE_LINES, serviceLineOfGroup, serviceLinesOfGroup, projectServiceLines, inferServiceLine,
    listProjects, getProject, saveProject, deleteProject,
    exportDb, importDb, downloadJson,
    FLASH_LABELS, captureSnapshot, getSnapshots, deleteSnapshot, periodKey,
    projectFinancials, getTierRateFromCatalog, resolveRoleRate, monthlySeries,
    enumerateMonths, computeMonthsByPhase,
    getCurrentUser, setCurrentUser, isAdmin, userOwnsProject, visibleProjects,
    setRealIdentity, getRealIdentity, canImpersonate, setImpersonation, clearImpersonation, getImpersonation, roleFor, impersonationRoster,
    REVENUE_LEADERS, leaderById, resolveLeader, leaderDisplay,
    attachRemote, hydrateFromRemote, defaultDb,
  };
})();
