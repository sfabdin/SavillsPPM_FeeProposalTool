/* ============================================================
   SAVILLS PPM · UNIVERSAL FEE CALCULATOR · core logic + UI
   ============================================================ */

(function () {
  'use strict';

  const CATALOG = window.RATES_CATALOG;
  const STORE = window.UFC_Store;

  // Parse ?id= from URL
  function getProjectIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    // Accept every spelling the other pages link with — ?id= is canonical,
    // but Reconciliation and the slips banner historically used ?project=.
    return params.get('id') || params.get('project') || params.get('pid');
  }
  function setProjectIdInUrl(id) {
    const url = new URL(window.location);
    if (id) url.searchParams.set('id', id);
    else url.searchParams.delete('id');
    window.history.replaceState({}, '', url);
  }

  /* ---------- Constants ---------- */
  const MONTH_NAMES = window.UFC_UI.MONTHS;
  const MONTH_FULL  = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  /* ---------- Initial state ---------- */
  const DEFAULT_STATE = () => ({
    id: null,            // project id (from store)
    createdAt: null,
    updatedAt: null,
    project: {
      name: '',
      client: '',
      lead: '',
      proposalDate: new Date().toISOString().slice(0,10),
      location: '',
      status: 'draft',
      industry: '',
      projectType: '',     // service line / engagement type (distinct from Industry)
      projectSubtypes: [], // selected sub-services within the project type
      assumptionsList: [], // proposal assumptions / exclusions (library + custom)
      accessGrant: '',     // comma-separated emails granted access (besides lead/owner/admins)
      firstProposalDate: '',
      signedContractDate: '',
      clientContact: '',
      clientRelOwner: '',
      salesforceId: '',   // pasted in once Booked — bridges to Salesforce → Clockify reporting
      intakeSent: false,  // user-confirmed the intake email actually went out (clicking ≠ sent)
    },
    timeline: {
      startMonth: 1,   // 1..12
      startYear: 2027,
      endMonth: 12,
      endYear: 2027,
    },
    phases: [
      // { id, name, length }  length in months; auto-balanced to project length
      { id: 'p1', name: 'Mobilization', length: 1 },
      { id: 'p2', name: 'Planning',     length: 5 },
      { id: 'p3', name: 'Execution',    length: 5 },
      { id: 'p4', name: 'Closeout',     length: 1 },
    ],
    groups: [
      { id: 'core',     name: 'Core team' },
      { id: 'field',    name: 'Field team' },
      { id: 'advisory', name: 'PIC / Advisory' },
    ],
    roles: [],   // { id, titleId, tierId, resource, groupId, fte: {phaseId: pct} }
    assumptions: {
      hrsPerMo: STORE.PRICING_HOURS_PER_MONTH,
      escalation: 3.0,
      industryAdj: 20,   // rate-wide “industry standard” trim off the high PPM rack rates
      discount: 0,       // client / fixed-fee discount, applied at total level
      rateLock: false,
      feeBasis: 'fixed',   // 'fixed' = fixed fee (frozen on booking) · 'nte' = not-to-exceed (live forecast)
      nteCeiling: 0,       // NTE cap (locked at booking); revenue = actuals-to-date + planned future, capped here
      billingMode: 'phase', // 'phase' = resource-loaded as accrued · 'flatline' = net ÷ months, even monthly
      feeShare: { enabled: false, pct: 10, mode: 'offtop' }, // broker cut · 'offtop'=% off invoice · 'ontop'=markup added for client
      catalogBaseYear: CATALOG.baseYear,
    },
    // Pass-through / principal billing: vendor cost billed THROUGH Savills.
    // Cost flows straight out to the vendor; only the markup is Savills revenue.
    passthrough: { enabled: false, lines: [] },
  });

  let state = DEFAULT_STATE();
  let dirty = false;
  let autosaveTimer = null;
  /* The record version this editor loaded / last wrote. Used for optimistic
     concurrency so we never silently overwrite a teammate's newer save. */
  let baseUpdatedAt = null;
  let conflicted = false;

  /* ---------- Helpers ---------- */
  const uid = () => 'r' + Math.random().toString(36).slice(2, 9);
  const fmtMoney = (n) => {
    if (!n || Math.abs(n) < 0.5) return '$0';
    const sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(Math.round(n)).toLocaleString();
  };
  const fmtMoneyDecimal = (n) => '$' + (Math.round(n * 100) / 100).toFixed(2);
  const fmtMoneyCents = (n) => { const sign = n < 0 ? '-' : ''; return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  /** Trim a number for display: up to 6 decimals, no trailing zeros. Keeps the
      stored value exact while showing a readable string (e.g. 12.345678). */
  const trimNum = (n) => { if (n == null || isNaN(n)) return ''; return parseFloat(Number(n).toFixed(6)).toString(); };
  /* The discount input shows two decimals. State keeps the exact figure a
     reconcile-to-target produced (so net ties to the penny); the display only
     feeds back if the user types over it. */
  const trimPct = (n) => { if (n == null || isNaN(n)) return ''; return parseFloat(Number(n).toFixed(2)).toString(); };
  const fmtMoneySmall = (n) => (!n || Math.abs(n) < 0.5) ? '—' : '$' + Math.abs(Math.round(n)).toLocaleString();
  const monthLabel = (y, m) => window.UFC_UI.monthLabel(y, m);   // 'Sep-26' — the one month format
  const monthLabelLong = (y, m) => `${MONTH_FULL[m-1]} ${y}`;

  function getMonths() {
    const out = [];
    const { startMonth, startYear, endMonth, endYear } = state.timeline;
    let y = startYear, m = startMonth;
    let safety = 0;
    while ((y < endYear) || (y === endYear && m <= endMonth)) {
      out.push({ year: y, month: m, label: monthLabel(y, m), longLabel: monthLabelLong(y, m) });
      m++;
      if (m > 12) { m = 1; y++; }
      if (++safety > 200) break;  // safety
    }
    return out;
  }

  function projectMonthCount() { return getMonths().length; }

  function resolveTitleId(titleId) {
    if (CATALOG.titles.some(t => t.id === titleId)) return titleId;
    const a = CATALOG.legacyAlias && CATALOG.legacyAlias[titleId];
    return a ? a.titleId : titleId;
  }
  function getTitle(titleId)   { return CATALOG.titles.find(t => t.id === resolveTitleId(titleId)); }
  function getTier(titleId, tierId) {
    const t = getTitle(titleId);
    if (!t) return null;
    if (t.tiers.some(x => x.id === tierId)) return t.tiers.find(x => x.id === tierId);
    // Stored tier not found — map a legacy alias's tier, else fall back to Mid (never the High default).
    const a = CATALOG.legacyAlias && CATALOG.legacyAlias[titleId];
    const fallbackId = (a && a.tierId) || 'mid';
    return t.tiers.find(x => x.id === fallbackId) || t.tiers.find(x => x.id === 'mid') || t.tiers[0];
  }
  function getGroup(groupId)   { return state.groups.find(g => g.id === groupId) || state.groups[0]; }
  function getPhase(phaseId)   { return state.phases.find(p => p.id === phaseId); }

  /** Make sure each role has an fte entry per current phase; trim removed phases. */
  function reconcileRoleFte() {
    state.roles.forEach(r => {
      const next = {};
      state.phases.forEach(p => { next[p.id] = r.fte[p.id] ?? 0; });
      r.fte = next;
    });
  }

  /** Rebalance phases to total = projectMonthCount, distributing leftover to last phase. */
  function rebalancePhases() {
    if (!state.phases.length) {
      state.phases = [{ id: 'p1', name: 'Phase 1', length: projectMonthCount() }];
      return;
    }
    const total = projectMonthCount();
    let sum = state.phases.reduce((s, p) => s + Math.max(0, p.length || 0), 0);
    if (sum === total) return;
    if (sum === 0) { state.phases[state.phases.length - 1].length = total; return; }
    // proportionally scale, but round to integers
    const scale = total / sum;
    let acc = 0;
    state.phases.forEach((p, i) => {
      if (i < state.phases.length - 1) {
        p.length = Math.max(1, Math.round((p.length || 0) * scale));
        acc += p.length;
      }
    });
    state.phases[state.phases.length - 1].length = Math.max(1, total - acc);
  }

  /** Returns months grouped by phase, in order. Length normalized to projectMonthCount. */
  function getMonthsByPhase() {
    const months = getMonths();
    const out = [];
    let i = 0;
    state.phases.forEach(p => {
      const slice = months.slice(i, i + p.length);
      out.push({ phase: p, months: slice });
      i += p.length;
    });
    return out;
  }

  /* ---------- Calc ---------- */
  /** The competitive base rate: catalog rack rate trimmed by the
      rate-wide industry-standard adjustment. The cost floor is NOT
      adjusted — it is a constant. */
  function adjustedBase(tier) {
    if (!tier || tier.isNoCharge) return 0;
    const adj = (state.assumptions.industryAdj || 0) / 100;
    return tier.rate * (1 - adj);
  }
  /** Rounded adjusted rate for display in dropdowns / role rows. */
  function shownRate(tier) { return Math.round(adjustedBase(tier)); }

  /** Resolve a role's base rate and the year that base is anchored to.
      • Grid roles  → adjusted rack rate, anchored at the catalog base year (2024).
      • Contracted  → the entered rate, anchored at the project START year, so
                      escalation compounds forward from year one (and the typed
                      number is exactly what's billed in the start year). The
                      industry-standard adjustment is bypassed entirely. */
  function roleBaseInfo(role) {
    if (role && role.rateSource === 'contracted') {
      const cr = parseFloat(role.contractedRate);
      return { base: isNaN(cr) ? 0 : cr, anchorYear: state.timeline.startYear, contracted: true };
    }
    const tier = getTier(role.titleId, role.tierId);
    if (!tier || tier.isNoCharge) return { base: 0, anchorYear: state.assumptions.catalogBaseYear };
    return { base: adjustedBase(tier), anchorYear: state.assumptions.catalogBaseYear };
  }

  /** Effective hourly rate for a role for a given calendar year. */
  function rateForYear(role, year) {
    const { base, anchorYear } = roleBaseInfo(role);
    if (!base) return 0;
    const esc = state.assumptions.escalation / 100;
    if (state.assumptions.rateLock) {
      // Lock at the project's start year
      return base * Math.pow(1 + esc, state.timeline.startYear - anchorYear);
    }
    return base * Math.pow(1 + esc, year - anchorYear);
  }

  /** Without lock — used for credit calc. */
  function unlockedRateForYear(role, year) {
    const { base, anchorYear } = roleBaseInfo(role);
    if (!base) return 0;
    const esc = state.assumptions.escalation / 100;
    return base * Math.pow(1 + esc, year - anchorYear);
  }

  /** Per-month FTE override key. */
  function monthKey(monthObj) { return monthObj.year + '-' + monthObj.month; }
  /** Current month key ("YYYY-M") for the today marker. */
  function currentMonthKey() { const n = new Date(); return n.getFullYear() + '-' + (n.getMonth() + 1); }
  /** A month is past if it ends before the current month (for NTE actuals lock). */
  function isPastMonth(m) { const n = new Date(); return (m.year < n.getFullYear()) || (m.year === n.getFullYear() && m.month < (n.getMonth() + 1)); }
  function isCurrentMonth(m) { return monthKey(m) === currentMonthKey(); }
  /** Effective FTE % for a role in a given month: a per-month override wins over
      the phase-level value. role.fteMonthly = { "YYYY-M": pct }. */
  function effectiveFte(role, monthObj, phaseId) {
    const mk = monthKey(monthObj);
    if (role.fteMonthly && role.fteMonthly[mk] != null) return role.fteMonthly[mk];
    return role.fte[phaseId] || 0;
  }

  /* ----- Option A: group-as-scope helpers -----
     Groups double as concurrent scopes. Months are canonical, so overlapping
     scopes already sum correctly; these helpers just make a scope's active
     window legible and let you slide a whole team when a milestone slips. */
  const absIdx = (y, m) => y * 12 + (m - 1);          // "YYYY-M" → absolute month index
  function parseMk(mk) { const [y, m] = mk.split('-').map(Number); return { y, m }; }
  function mkFromIdx(i) { return Math.floor(i / 12) + '-' + ((i % 12) + 1); }
  /** Active month span for a group: earliest → latest month with any nonzero allocation. */
  function groupActiveSpan(groupId) {
    let lo = Infinity, hi = -Infinity;
    state.roles.filter(r => r.groupId === groupId).forEach(r => {
      Object.keys(r.fteMonthly || {}).forEach(mk => {
        if ((r.fteMonthly[mk] || 0) <= 0) return;
        const { y, m } = parseMk(mk); const i = absIdx(y, m);
        if (i < lo) lo = i; if (i > hi) hi = i;
      });
    });
    if (lo === Infinity) return null;
    const lab = (i) => `${MONTH_NAMES[i % 12]} ${Math.floor(i / 12)}`;
    return { lo, hi, months: (hi - lo + 1), label: lo === hi ? lab(lo) : `${lab(lo)} – ${lab(hi)}` };
  }
  /** Slide every role in a group by delta months (keys remapped, values kept).
      Refuses if any allocation would land outside the project timeline. */
  function shiftGroupMonths(groupId, delta) {
    if (!delta) return;
    const tl = getMonths().map(m => absIdx(m.year, m.month));
    const loT = Math.min(...tl), hiT = Math.max(...tl);
    const roles = state.roles.filter(r => r.groupId === groupId);
    // preflight: would any nonzero allocation fall off the timeline?
    for (const r of roles) {
      for (const mk of Object.keys(r.fteMonthly || {})) {
        if ((r.fteMonthly[mk] || 0) <= 0) continue;
        const { y, m } = parseMk(mk); const ni = absIdx(y, m) + delta;
        if (ni < loT || ni > hiT) {
          UFC_UI.toast('That shift would push this scope past the project timeline. Extend the project dates first, then shift.');
          return;
        }
      }
    }
    roles.forEach(r => {
      const next = {};
      Object.keys(r.fteMonthly || {}).forEach(mk => {
        const { y, m } = parseMk(mk); const ni = absIdx(y, m) + delta;
        next[mkFromIdx(ni)] = r.fteMonthly[mk];
      });
      r.fteMonthly = next;
      // phase display values are recomputed from months on render; clear stale mirror
      state.phases.forEach(p => { if (r.fte) r.fte[p.id] = phaseAvgFte(r, p.id); });
    });
    renderMatrix(); renderMonthly(); renderSummary();
    markDirty();
  }
  /** Recompute a phase's stored fte as the average of its months' effective FTE
      (called after a per-month edit, so the collapsed phase reflects the months). */
  function recomputePhaseAvg(role, phase) {
    const months = getMonthsByPhase().find(x => x.phase.id === phase.id)?.months || [];
    if (!months.length) return;
    const sum = months.reduce((s, m) => s + effectiveFte(role, m, phase.id), 0);
    role.fte[phase.id] = Math.round((sum / months.length) * 10) / 10;
  }

  /** Published (list) monthly fee — ALWAYS at the full escalated rate, never the
      locked rate. Rate Lock is NOT baked in here; it surfaces once as the Rate
      Lock credit line (gross − credit = what the client actually pays). Using
      the locked rate here AND subtracting the credit would double-remove it. */
  function monthlyFee(role, monthObj, phaseId) {
    const fte = effectiveFte(role, monthObj, phaseId) / 100;
    if (!fte) return 0;
    const rate = unlockedRateForYear(role, monthObj.year);
    return fte * rate * state.assumptions.hrsPerMo;
  }

  /** Rate Lock credit — RAW (pre-discount): (unlocked − locked) × hours × FTE, per role per month. Always positive when lock is on. */
  function monthlyLockCreditRaw(role, monthObj, phaseId) {
    if (!state.assumptions.rateLock) return 0;
    const fte = effectiveFte(role, monthObj, phaseId) / 100;
    if (!fte) return 0;
    const diff = unlockedRateForYear(role, monthObj.year) - rateForYear(role, monthObj.year);
    return Math.max(0, diff) * fte * state.assumptions.hrsPerMo;
  }
  /** Rate Lock credit on the DISCOUNTED basis. The same (1 − discount) that scales the
      fee scales the credit, so gross − credit − discount reconciles exactly to
      lockedRate × (1 − discount) × hours × FTE — and the credit stays consistent when a
      team is shifted across months (it never re-derives off the changing total). */
  function monthlyLockCredit(role, monthObj, phaseId) {
    const d = (state.assumptions.discount || 0) / 100;
    return monthlyLockCreditRaw(role, monthObj, phaseId) * (1 - d);
  }

  /** Fee for a role over one phase (sum of months in that phase). */
  function rolePhaseFee(role, phase) {
    const monthsInPhase = getMonthsByPhase().find(x => x.phase.id === phase.id)?.months || [];
    return monthsInPhase.reduce((s, m) => s + monthlyFee(role, m, phase.id), 0);
  }
  function rolePhaseLockCredit(role, phase) {
    const monthsInPhase = getMonthsByPhase().find(x => x.phase.id === phase.id)?.months || [];
    return monthsInPhase.reduce((s, m) => s + monthlyLockCredit(role, m, phase.id), 0);
  }

  function roleTotal(role) {
    return state.phases.reduce((s, p) => s + rolePhaseFee(role, p), 0);
  }
  function roleLockCredit(role) {
    return state.phases.reduce((s, p) => s + rolePhaseLockCredit(role, p), 0);
  }
  function phaseTotal(phase) {
    return state.roles.reduce((s, r) => s + rolePhaseFee(r, phase), 0);
  }
  function phaseLockCredit(phase) {
    return state.roles.reduce((s, r) => s + rolePhaseLockCredit(r, phase), 0);
  }
  function grossTotal() {
    return state.roles.reduce((s, r) => s + roleTotal(r), 0);
  }
  function lockCredit() {
    return state.roles.reduce((s, r) => s + roleLockCredit(r), 0);
  }
  /** Total RAW (pre-discount) rate-lock credit — used only by fit-to-target's solve. */
  function lockCreditRaw() {
    let s = 0;
    state.roles.forEach(r => state.phases.forEach(p => {
      const months = getMonthsByPhase().find(x => x.phase.id === p.id)?.months || [];
      months.forEach(m => { s += monthlyLockCreditRaw(r, m, p.id); });
    }));
    return s;
  }
  function discountAmt() {
    return grossTotal() * (state.assumptions.discount / 100);
  }
  function netTotal() {
    return grossTotal() - lockCredit() - discountAmt();
  }
  /* Fee share = broker referral cut. TWO MODES (broker $ is the same either way —
     base fee × pct — what differs is who absorbs it):
       • 'offtop' (default): broker takes a % OFF the invoice. Client pays the proposal
         fee (netTotal); broker gets fee×pct; Savills keeps fee×(1−pct). Effective % of
         the invoice = pct.
       • 'ontop': broker % is added ON TOP as a markup. netTotal is what Savills keeps;
         client pays fee×(1+pct); broker gets fee×pct. Effective % of the invoice =
         pct/(1+pct). (e.g. 25% on top of $80k = $20k broker on a $100k invoice = 20%.) */
  function feeShareOn() { return !!(state.assumptions.feeShare && state.assumptions.feeShare.enabled); }
  function feeShareMode() { return (state.assumptions.feeShare && state.assumptions.feeShare.mode) || 'offtop'; }
  function feeSharePct() { return (state.assumptions.feeShare && parseFloat(state.assumptions.feeShare.pct)) || 0; }
  function feeShareAmt() { return feeShareOn() ? netTotal() * (feeSharePct() / 100) : 0; }   // broker $ — same in both modes
  function clientBillTotal() { return (feeShareOn() && feeShareMode() === 'ontop') ? netTotal() + feeShareAmt() : netTotal(); }
  function revenueTotal() { return (feeShareOn() && feeShareMode() === 'offtop') ? netTotal() - feeShareAmt() : netTotal(); }
  function effectiveBrokerPct() { const cb = clientBillTotal(); return cb > 0 ? (feeShareAmt() / cb) * 100 : 0; }
  /* Pass-through / principal billing. Cost flows to the vendor; only markup is revenue.
     Walled off from discount / rate-lock / NTE fee math — reads only its own lines. */
  function ptState() { return state.passthrough || (state.passthrough = { enabled: false, lines: [] }); }
  function ptOn() { return !!(ptState().enabled && (ptState().lines || []).length); }
  function ptLines() { return ptState().lines || []; }
  function ptIsManaged(l) { return l && l.mode === 'managed'; }
  // Cost that flows OUT to the vendor — billed lines only (managed = direct bill, no pass-through).
  function ptCostTotal() { return ptOn() ? ptLines().reduce((s, l) => s + (ptIsManaged(l) ? 0 : (parseFloat(l.cost) || 0)), 0) : 0; }
  // Markup fee = Savills revenue — both modes.
  function ptMarkupTotal() { return ptOn() ? ptLines().reduce((s, l) => s + (parseFloat(l.cost) || 0) * ((parseFloat(l.markupPct) || 0) / 100), 0) : 0; }
  // What the client is billed THROUGH Savills: billed = cost + markup; managed = markup fee only.
  function ptClientTotal() { return ptOn() ? ptLines().reduce((s, l) => { const c = parseFloat(l.cost) || 0, m = c * ((parseFloat(l.markupPct) || 0) / 100); return s + (ptIsManaged(l) ? m : c + m); }, 0) : 0; }
  /** Per-month CLIENT-BILLED pass-through (through Savills), keyed 'YYYY-M'. Billed lines =
      cost + markup; managed lines = markup fee only. Explicit monthly distribution wins. */
  function ptBilledMap() {
    const map = {}; if (!ptOn()) return map;
    const keys = getMonths().map(m => m.year + '-' + m.month);
    ptLines().forEach(l => {
      const cost = parseFloat(l.cost) || 0; if (!cost) return;
      const mkFrac = (parseFloat(l.markupPct) || 0) / 100;
      const managed = ptIsManaged(l);
      const toClient = (c) => managed ? c * mkFrac : c * (1 + mkFrac);
      const mo = (l.monthly && Object.keys(l.monthly).length) ? l.monthly : null;
      if (mo) {
        Object.keys(mo).forEach(ym => {
          const norm = ym.split('-')[0] + '-' + parseInt(ym.split('-')[1], 10);
          map[norm] = (map[norm] || 0) + toClient(parseFloat(mo[ym]) || 0);
        });
      } else if (keys.length) {
        const per = toClient(cost) / keys.length;
        keys.forEach(k => { map[k] = (map[k] || 0) + per; });
      }
    });
    return map;
  }
  /** A phase's display FTE for a role = the rounded average of its months'
      effective FTE. Phase is a derived rollup; months are canonical. */
  function phaseAvgFte(role, phaseId) {
    const months = getMonthsByPhase().find(x => x.phase.id === phaseId)?.months || [];
    if (!months.length) return 0;
    const sum = months.reduce((s, m) => s + effectiveFte(role, m, phaseId), 0);
    return Math.round((sum / months.length) * 10) / 10;
  }
  /** Keep every role's fte[phaseId] mirror in sync with its months (display only). */
  function syncPhaseRollups() {
    state.roles.forEach(r => state.phases.forEach(p => { r.fte[p.id] = phaseAvgFte(r, p.id); }));
  }
  function totalFteMonths() {
    const byPhase = getMonthsByPhase();
    return state.roles.reduce((s, r) =>
      s + byPhase.reduce((sp, b) =>
        sp + b.months.reduce((sm, m) => sm + effectiveFte(r, m, b.phase.id) / 100, 0), 0), 0);
  }

  /* ---------- Cost-rate floor check ----------
     Col E (PowerBI) / Col G (Clockify) = the LOWEST rate we may bill,
     discount included. We compare each role's effective billed rate —
     escalated to the project start year (the lowest-billed month) and
     net of the global discount — against that floor. */
  function effectiveMinRate(role) {
    const tier = getTier(role.titleId, role.tierId);
    if (!tier || tier.isNoCharge) return null;       // no-charge roles are exempt
    const startYear = state.timeline.startYear;
    const rate = rateForYear(role, startYear);       // honors escalation + Rate Lock
    if (!rate) return null;                          // contracted but rate not yet entered
    return rate * (1 - (state.assumptions.discount || 0) / 100);
  }
  function roleCostFloor(role) {
    const tier = getTier(role.titleId, role.tierId);
    return (tier && !tier.isNoCharge) ? (tier.costFloor || 0) : 0;
  }
  function roleFloorViolation(role) {
    const floor = roleCostFloor(role);
    if (!floor) return false;
    const eff = effectiveMinRate(role);
    if (eff == null) return false;
    return eff < floor - 0.005;
  }
  function floorViolations() { return state.roles.filter(roleFloorViolation); }

  /* ============================================================
     RENDERERS
     ============================================================ */
  function $(sel, root=document) { return root.querySelector(sel); }
  function $$(sel, root=document) { return [...root.querySelectorAll(sel)]; }

  function renderAll() {
    rebalancePhases();
    reconcileRoleFte();
    syncPhaseRollups();
    renderProjectMeta();
    renderProjFlag();
    renderTimeline();
    renderPhases();
    renderGroups();
    renderCatalog();
    renderSelectedRoles();
    renderAssumptions();
    renderSummary();
    renderPassthrough();
    renderMatrix();
    renderMonthly();
    renderFloorCheck();
    renderReconcile();
    renderFitMonth();
  }

  /* ----- Reconcile to proposal (back-solve to a target fee) ----- */
  let fitTargetOverride = null;   // user-typed target; falls back to extracted total

  function currentTargetFee() {
    if (fitTargetOverride != null && !isNaN(fitTargetOverride)) return fitTargetOverride;
    const ext = state.source && state.source.extractedTotalFee;
    return (ext != null && !isNaN(ext)) ? ext : null;
  }

  function renderReconcile(noteOverride) {
    const panel = $('#reconcile-panel');
    if (!panel) return;
    const target = currentTargetFee();
    const hasBasis = target != null || (state.source && state.source.type === 'ingest');
    if (!hasBasis && !state.roles.length) { panel.hidden = true; return; }
    panel.hidden = false;

    const input = $('#fit-target');
    if (input && document.activeElement !== input) input.value = target != null ? fmtMoney(target).replace('$','') : '';

    const net = netTotal();
    $('#rc-current').textContent = fmtMoney(net);
    const deltaEl = $('#rc-delta');
    if (target == null) {
      deltaEl.textContent = '— set a target';
      deltaEl.className = 'rc-delta';
    } else {
      const delta = net - target;
      const pct = target ? (delta / target) * 100 : 0;
      const within = Math.abs(delta) < 0.005;          // reconciled = correct to the penny
      deltaEl.textContent = within ? '✓ reconciled to the penny' : `${delta > 0 ? '+' : '−'}${fmtMoney(Math.abs(delta))} (${delta > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)`;
      deltaEl.className = 'rc-delta' + (within ? ' ok' : ' off');
    }
    if (noteOverride) $('#rc-note').innerHTML = noteOverride;
    renderImportReconcile();
  }

  /* ===== Fit to month — step 2 =====
     Fit to target settles HOW MUCH (it solves the client discount).
     Fit to month settles WHEN: it moves allocations so each month's fee lands
     on a number you choose, without touching rates, the discount, or the total.

     Why it can be exact rather than iterative: with the discount fixed, a
     month's net fee is LINEAR in that month's FTE values —

         net(m) = Σ_roles  fte(r,m) × v(r,m)
         v(r,m) = hrsPerMo × (1 − discount) × effectiveRate(r, year(m)) / 100

     — so hitting a month's target is one multiplication: scale every role in
     that month by k = target / current. And because the targets are held to
     the same sum as the settled total, total gross is unchanged, which is
     precisely why the discount never has to move and Fit to target survives. */
  let fmOpen = false;
  let fmTargets = null;              // { 'YYYY-M': dollars } — session only, never saved
  let fmPinned = new Set();          // months the user typed; the rest absorb the difference
  let fmUndo = null;                 // pre-apply roles snapshot
  let fmOverwrite = false;           // import-locked project: rewrite the imported months too

  /** Net dollars produced by ONE percent of FTE for this role in this month.
      Mirrors monthlyFee − monthlyLockCredit exactly, at fte = 1%. */
  function fmUnitNet(role, monthObj) {
    const d = (state.assumptions.discount || 0) / 100;
    const unlocked = unlockedRateForYear(role, monthObj.year);
    const lockDiff = state.assumptions.rateLock
      ? Math.max(0, unlocked - rateForYear(role, monthObj.year)) : 0;
    return (unlocked - lockDiff) * (state.assumptions.hrsPerMo || 0) * (1 - d) / 100;
  }
  /** Every project month with the phase that owns it (needed for FTE fallback). */
  function fmMonthList() {
    const out = [];
    getMonthsByPhase().forEach(b => (b.months || []).forEach(m => {
      out.push({ m, phaseId: b.phase.id, mk: monthKey(m), label: m.label });
    }));
    return out;
  }
  /** What each month currently bills, from the live allocations. */
  function fmCurrentByMonth() {
    const out = {};
    fmMonthList().forEach(({ m, phaseId, mk }) => {
      let sum = 0;
      state.roles.forEach(r => { sum += effectiveFte(r, m, phaseId) * fmUnitNet(r, m); });
      out[mk] = sum;
    });
    return out;
  }

  /* ---- gates ---- */
  function fmReconciled() {
    const t = currentTargetFee();
    return t != null && t > 0 && Math.abs(netTotal() - t) < 0.005;
  }
  function fmImportLock() {
    const src = state.source;
    return !!(src && src.importedByMonth && !src.reconciled);
  }
  function fmBlockReason() {
    if (state.assumptions.billingMode === 'flatline') return 'flatline';
    if (!state.roles.length) return 'noroles';
    if (!fmReconciled()) return 'unreconciled';
    if (fmImportLock()) return 'importlock';
    return null;
  }

  /* ---- targets: typed months pin, the rest absorb, sum always equals the total ---- */
  function fmSeedTargets() {
    fmTargets = fmCurrentByMonth();
    fmPinned = new Set();
  }
  /** Re-spread the unpinned months so the column still totals the settled fee,
      then round to cents and give the residual to the largest unpinned month —
      so what you READ is exactly what gets applied, to the penny. */
  function fmRebalance() {
    const total = currentTargetFee();
    const base = fmCurrentByMonth();
    const list = fmMonthList().map(x => x.mk);
    let pinnedSum = 0;
    const free = [];
    list.forEach(mk => { if (fmPinned.has(mk)) pinnedSum += (fmTargets[mk] || 0); else free.push(mk); });
    const rest = total - pinnedSum;
    if (!free.length) return rest;                       // everything pinned — caller reports the gap
    const baseSum = free.reduce((s, mk) => s + (base[mk] || 0), 0);
    if (baseSum > 0.005) free.forEach(mk => { fmTargets[mk] = rest * (base[mk] || 0) / baseSum; });
    else free.forEach(mk => { fmTargets[mk] = rest / free.length; });
    // cents, with the rounding residual parked on the biggest free month
    let acc = 0;
    free.forEach(mk => { fmTargets[mk] = Math.round(fmTargets[mk] * 100) / 100; acc += fmTargets[mk]; });
    const resid = Math.round((rest - acc) * 100) / 100;
    if (Math.abs(resid) >= 0.005) {
      const big = free.slice().sort((a, b) => (fmTargets[b] || 0) - (fmTargets[a] || 0))[0];
      fmTargets[big] = Math.round((fmTargets[big] + resid) * 100) / 100;
    }
    return 0;
  }
  function fmAllocated() {
    return fmMonthList().reduce((s, x) => s + (fmTargets[x.mk] || 0), 0);
  }

  /* ---- the solve ---- */
  function fmSolve() {
    const rows = [], blocked = [], over = [];
    const byRole = {};                                   // roleId → { mk: pct }
    fmMonthList().forEach(({ m, phaseId, mk, label }) => {
      const target = fmTargets[mk] || 0;
      let cur = 0;
      const parts = [];
      state.roles.forEach(r => {
        const fte = effectiveFte(r, m, phaseId);
        const v = fmUnitNet(r, m);
        if (fte > 0 && v > 0) { cur += fte * v; parts.push({ r, fte, v }); }
        else if (v > 0) parts.push({ r, fte: 0, v });     // billable but idle this month
      });
      const payload = { mk, label, target, current: cur, k: null, movers: [] };
      if (cur <= 0.005) {
        // Nothing billable is staffed here — there is no allocation to scale.
        if (target > 0.005) blocked.push({ mk, label, target });
        rows.push(payload); return;
      }
      const k = target / cur;
      payload.k = k;
      parts.forEach(({ r, fte }) => {
        if (fte <= 0) return;                            // 0 × k is still 0 — leave it alone
        const next = fte * k;
        (byRole[r.id] = byRole[r.id] || {})[mk] = next;
        payload.movers.push({ role: r, from: fte, to: next });
        if (next > 100.0001) over.push({ label, role: r, pct: next });
      });
      rows.push(payload);
    });
    return { byRole, rows, blocked, over };
  }

  /* ---- apply / undo ---- */
  function fmApply() {
    // Rule 4 is structural, not a UI courtesy: rebalance and re-check the sum
    // HERE, so no path — button, keyboard, or API — can drift the total away
    // from what Fit to target settled.
    if (!fmTargets) fmSeedTargets();
    fmRebalance();
    const t = currentTargetFee();
    if (Math.abs(fmAllocated() - t) >= 0.005) {
      renderFitMonth('<b>Not applied.</b> The months don&rsquo;t total ' + fmtMoneyCents(t) + ' — unpin a month so it can absorb the difference.');
      return;
    }
    const solved = fmSolve();
    if (solved.blocked.length) { renderFitMonth(); return; }
    fmUndo = { roles: JSON.parse(JSON.stringify(state.roles)), imported: fmOverwrite && state.source ? JSON.parse(JSON.stringify(state.source.importedByMonth || {})) : null };
    const list = fmMonthList();
    Object.entries(solved.byRole).forEach(([roleId, months]) => {
      const role = state.roles.find(r => r.id === roleId);
      if (!role) return;
      // Pin every month to its current effective value first — same rule the
      // per-month cell editor uses — so months we don't touch can't drift when
      // the phase average is recomputed below.
      role.fteMonthly = role.fteMonthly || {};
      list.forEach(({ m, phaseId, mk }) => {
        if (role.fteMonthly[mk] == null) role.fteMonthly[mk] = effectiveFte(role, m, phaseId);
      });
      Object.entries(months).forEach(([mk, pct]) => { role.fteMonthly[mk] = pct; });
    });
    // Import-locked project the user chose to overwrite rather than unlock:
    // the projection reads source.importedByMonth, so put the same numbers there.
    if (fmOverwrite && state.source) {
      const imp = { ...(state.source.importedByMonth || {}) };
      fmMonthList().forEach(({ m, mk }) => { imp[m.year + '-' + m.month] = Math.round((fmTargets[mk] || 0) * 100) / 100; });
      state.source.importedByMonth = imp;
    }
    // Phase cells are a display average of the months (they don't feed them).
    state.phases.forEach(p => state.roles.forEach(r => recomputePhaseAvg(r, p)));
    markDirty();
    renderAll();
    renderFitMonth(`<strong>Months reconciled to the penny.</strong> Allocations moved; rates, discount and the ${fmtMoneyCents(currentTargetFee())} total are untouched.`);
  }
  function fmUndoApply() {
    if (!fmUndo) return;
    state.roles = JSON.parse(JSON.stringify(fmUndo.roles));
    if (fmUndo.imported && state.source) state.source.importedByMonth = fmUndo.imported;
    fmUndo = null;
    markDirty();
    renderAll();
    renderFitMonth('Reverted to the allocations from before the fit.');
  }

  /* ---- render ---- */
  function renderFitMonth(note) {
    const panel = $('#fitmonth-panel');
    if (!panel) return;
    const body = $('#fm-body'), sub = $('#fm-sub'), caret = $('#fm-caret');
    const reason = fmBlockReason();

    // The panel only exists once there is a target to distribute.
    const t = currentTargetFee();
    if (t == null || !state.roles.length) { panel.hidden = true; return; }
    panel.hidden = false;
    panel.classList.toggle('is-locked', !!reason && reason !== 'importlock');

    if (reason && reason !== 'importlock') {
      fmOpen = false;
      body.hidden = true; caret.classList.remove('open');
      sub.textContent = reason === 'flatline'
        ? 'Unavailable on flatline billing — the fee is spread evenly no matter how the time sits. Switch to phase-based to use it.'
        : reason === 'noroles'
          ? 'Add roles first — there is no allocation to move.'
          : 'Available once Fit to target reconciles the total to the penny.';
      return;
    }
    sub.textContent = 'Distribute the settled fee across the months — moves allocations, never rates.';
    caret.classList.toggle('open', fmOpen);
    body.hidden = !fmOpen;
    if (!fmOpen) return;

    // Import-locked: the projection ignores staffing entirely, so say so and
    // offer the two ways through rather than silently doing nothing.
    if (reason === 'importlock' && !fmOverwrite) {
      body.innerHTML = `
        <div class="fm-warn"><b>This project's projections are locked to its imported figures.</b>
          Monthly revenue comes from the import, not from staffing, so moving allocations would change nothing you can see.
          <div style="margin-top:8px">
            <button class="btn btn-primary" id="fm-unlock" type="button">Unlock — projections follow the fee model</button>
            <button class="btn btn-ghost" id="fm-overwrite" type="button" style="margin-left:8px">Overwrite the imported months instead</button>
          </div>
        </div>
        <div class="fm-note">“Unlock” marks the project reconciled, exactly like the button on the import panel — from then on the monthly figures are whatever the staffing computes.
          “Overwrite” keeps it locked but rewrites the imported months to the targets you set here.</div>`;
      $('#fm-unlock').onclick = () => {
        state.source.reconciled = true;
        markDirty(); renderAll();
        fmSeedTargets(); renderFitMonth('Unlocked — projections now follow the fee model.');
      };
      $('#fm-overwrite').onclick = () => { fmOverwrite = true; fmSeedTargets(); renderFitMonth('Applying will also rewrite this project&rsquo;s imported months to the targets below.'); };
      return;
    }

    if (!fmTargets) fmSeedTargets();
    const gap = fmRebalance();
    const solved = fmSolve();
    const allocated = fmAllocated();
    const remaining = Math.round((t - allocated) * 100) / 100;
    const balanced = Math.abs(remaining) < 0.005;

    const fmt = (n) => fmtMoneyCents(n);
    const rowsHtml = solved.rows.map(r => {
      const pinned = fmPinned.has(r.mk);
      const delta = (fmTargets[r.mk] || 0) - r.current;
      const kTxt = r.k == null ? '—' : (Math.abs(r.k - 1) < 0.0005 ? 'no change' : '×' + r.k.toFixed(3));
      const eff = r.movers.length
        ? r.movers.slice(0, 3).map(mv => `${escapeHtml(mv.role.resource || mv.role.projectRole || 'role')} ${trimNum(Math.round(mv.from * 10) / 10)}→${trimNum(Math.round(mv.to * 10) / 10)}%`).join(' · ')
          + (r.movers.length > 3 ? ` +${r.movers.length - 3} more` : '')
        : '<span class="fm-eff">nobody billable staffed</span>';
      const overHere = solved.over.some(o => o.label === r.label);
      return `<tr class="${pinned ? 'is-pinned' : ''}">
        <td><button class="fm-pin ${pinned ? 'on' : ''}" data-pin="${r.mk}" title="${pinned ? 'Pinned — unpin to let this month absorb changes' : 'Unpinned — absorbs the difference automatically'}">${pinned ? '📌' : '○'}</button> ${escapeHtml(r.label)}</td>
        <td class="num">${fmt(r.current)}</td>
        <td class="num"><input class="fm-in" data-month="${r.mk}" value="${(fmTargets[r.mk] || 0).toFixed(2)}" inputmode="decimal"></td>
        <td class="num">${Math.abs(delta) < 0.005 ? '—' : (delta > 0 ? '+' : '−') + fmt(Math.abs(delta))}</td>
        <td class="fm-eff ${overHere ? 'over' : (r.k > 1 ? 'up' : r.k < 1 ? 'down' : '')}">${kTxt}${r.movers.length ? ' · ' + eff : ''}</td>
      </tr>`;
    }).join('');

    body.innerHTML = `
      <div class="fm-note">Type the months you care about — they <b>pin</b>, and the rest re-spread so the column always totals
        <b>${fmt(t)}</b>. Applying scales each month's allocations so the fee lands exactly there; rates and the discount never move.</div>
      ${note ? `<div class="fm-warn">${note}</div>` : ''}
      ${solved.blocked.length ? `<div class="fm-bad"><b>${solved.blocked.length} month${solved.blocked.length === 1 ? '' : 's'} can't be targeted:</b>
        ${solved.blocked.map(b => `${escapeHtml(b.label)} (${fmt(b.target)})`).join(' · ')} — nobody billable is staffed there, so there is no allocation to scale.
        Add a role to ${solved.blocked.length === 1 ? 'that month' : 'those months'}, or move the money elsewhere.</div>` : ''}
      ${solved.over.length ? `<div class="fm-warn"><b>${solved.over.length} allocation${solved.over.length === 1 ? '' : 's'} above 100%:</b>
        ${solved.over.slice(0, 6).map(o => `${escapeHtml(o.label)} — ${escapeHtml(o.role.resource || o.role.projectRole || 'role')} ${trimNum(Math.round(o.pct))}%`).join(' · ')}${solved.over.length > 6 ? ' …' : ''}.
        Applied as-is (one person can't really exceed 100% — check it's a pool line or an overtime month).</div>` : ''}
      <div class="fm-strip">
        <div class="fm-stat"><label>Settled total</label><b>${fmt(t)}</b></div>
        <div class="fm-stat"><label>Allocated</label><b>${fmt(allocated)}</b></div>
        <div class="fm-stat"><label>Remaining</label><b class="${balanced ? 'ok' : 'off'}">${balanced ? '$0.00' : fmt(remaining)}</b></div>
        <div class="fm-stat"><label>Pinned</label><b>${fmPinned.size} of ${solved.rows.length}</b></div>
      </div>
      <table class="fm-tbl">
        <thead><tr><th>Month</th><th class="num">Currently</th><th class="num">Target</th><th class="num">Δ</th><th>Effect on allocations</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div class="fm-actions">
        <button class="btn btn-primary" id="fm-apply" type="button" ${(!balanced || solved.blocked.length) ? 'disabled' : ''}>Apply to allocations</button>
        <button class="btn btn-ghost" id="fm-even" type="button">Even split</button>
        <button class="btn btn-ghost" id="fm-reset" type="button">Reset to current</button>
        ${fmUndo ? '<button class="btn btn-ghost" id="fm-undo" type="button">↺ Undo the fit</button>' : ''}
        <span class="fm-hint">${gap ? 'Every month is pinned and they don\'t sum to the total — unpin one to absorb the difference.' : 'Nothing is written until you apply. Targets are not saved with the project.'}</span>
      </div>`;

    body.querySelectorAll('[data-pin]').forEach(b => b.onclick = () => {
      const mk = b.dataset.pin;
      if (fmPinned.has(mk)) fmPinned.delete(mk); else fmPinned.add(mk);
      renderFitMonth();
    });
    body.querySelectorAll('.fm-in').forEach(inp => {
      inp.onchange = () => {
        const mk = inp.dataset.month;
        const v = parseFloat(String(inp.value).replace(/[$,\s]/g, ''));
        if (!isFinite(v)) { renderFitMonth(); return; }
        fmTargets[mk] = Math.round(v * 100) / 100;
        fmPinned.add(mk);
        renderFitMonth();
      };
      inp.onfocus = () => inp.select();
    });
    const ap = $('#fm-apply'); if (ap) ap.onclick = fmApply;
    const ev = $('#fm-even'); if (ev) ev.onclick = () => {
      const list = fmMonthList();
      fmPinned = new Set(); fmTargets = {};
      list.forEach(({ mk }) => { fmTargets[mk] = 0; });
      const each = Math.round((t / list.length) * 100) / 100;
      list.forEach(({ mk }) => { fmTargets[mk] = each; fmPinned.add(mk); });
      const resid = Math.round((t - each * list.length) * 100) / 100;
      if (Math.abs(resid) >= 0.005) fmTargets[list[list.length - 1].mk] += resid;
      renderFitMonth();
    };
    const rs = $('#fm-reset'); if (rs) rs.onclick = () => { fmSeedTargets(); renderFitMonth(); };
    const un = $('#fm-undo'); if (un) un.onclick = fmUndoApply;
  }

  /** Import reconciliation panel: imported $ (locked, from the source sheet)
      vs. calculated $ (from current staffing) per month, with variance — so
      allocations can be tuned to match without disturbing the locked projection.
      Self-injects above the monthly schedule; only shows for imported projects. */
  function renderImportReconcile() {
    let panel = $('#import-reconcile');
    const src = state.source;
    const isImport = !!(src && src.importedByMonth);
    if (!isImport) { if (panel) panel.hidden = true; return; }
    const cat = window.RATES_CATALOG;
    const rec = STORE.reconcileImport(stateAsRecord ? stateAsRecord() : JSON.parse(JSON.stringify(state)), cat);
    if (!rec) { if (panel) panel.hidden = true; return; }

    if (!panel) {
      // Inject above the monthly schedule section.
      const anchor = $('#monthly-thead') ? $('#monthly-thead').closest('.cover-section, section, .matrix-wrap, div') : null;
      panel = document.createElement('div');
      panel.id = 'import-reconcile';
      panel.className = 'import-reconcile';
      const host = $('#monthly-tbody') ? $('#monthly-tbody').closest('table') : null;
      if (host && host.parentNode) host.parentNode.insertBefore(panel, host);
      else document.body.appendChild(panel);
    }
    panel.hidden = false;
    const reconciled = rec.reconciled;
    const vAbs = Math.abs(rec.variance);
    const within = vAbs < Math.max(1, rec.importedTotal * 0.005);
    const cls = reconciled ? 'done' : (within ? 'match' : 'off');
    const rows = rec.byMonth.filter(m => m.imported || m.calculated).map(m => {
      const v = m.variance, vc = Math.abs(v) < 1 ? 'ok' : (v > 0 ? 'over' : 'under');
      return `<tr>
        <td>${monthLabelFromYM(m.ym)}</td>
        <td class="num">${m.imported ? fmtMoney(m.imported) : '·'}</td>
        <td class="num">${m.calculated ? fmtMoney(m.calculated) : '·'}</td>
        <td class="num ${vc}">${Math.abs(v) < 1 ? '✓' : (v > 0 ? '+' : '−') + fmtMoney(Math.abs(v))}</td>
      </tr>`;
    }).join('');
    panel.innerHTML = `
      <div class="ir-head">
        <div>
          <div class="ir-title">Imported vs. calculated · reconciliation</div>
          <div class="ir-sub">Imported total is <strong>locked</strong> for revenue projections. Build staffing until calculated matches, then mark reconciled to switch projections onto your fee model.</div>
        </div>
        <div class="ir-stat ${cls}">
          <div class="ir-stat-row"><span>Imported</span><b>${fmtMoney(rec.importedTotal)}</b></div>
          <div class="ir-stat-row"><span>Calculated</span><b>${fmtMoney(rec.calculatedTotal)}</b></div>
          <div class="ir-stat-row var"><span>Variance</span><b>${rec.variance >= 0 ? '+' : '−'}${fmtMoney(vAbs)}</b></div>
        </div>
      </div>
      <div class="ir-actions">
        <button type="button" class="ir-btn" id="ir-toggle">${reconciled ? '↺ Re-lock to imported' : '✓ Mark reconciled (use fee model)'}</button>
        ${!reconciled && state.roles.length ? `<button type="button" class="ir-btn" id="ir-precalc" title="Preview contracted rates that back into the imported totals using the current staffing shape — nothing is locked in until you confirm">⚡ Pre-calculate rates from staffing</button>` : ''}
        <span class="ir-flag ${reconciled ? 'on' : ''}">${reconciled ? 'Reconciled — projections follow the fee model' : 'Locked — projections follow the imported sheet'}</span>
      </div>
      <details class="ir-detail"><summary>Month-by-month (${rec.byMonth.filter(m=>m.imported||m.calculated).length})</summary>
        <table class="ir-table"><thead><tr><th>Month</th><th class="num">Imported</th><th class="num">Calculated</th><th class="num">Variance</th></tr></thead><tbody>${rows}</tbody></table>
      </details>`;
    const tg = $('#ir-toggle');
    if (tg) tg.addEventListener('click', () => {
      state.source.reconciled = !state.source.reconciled;
      markDirty();
      renderImportReconcile();
    });
    const pc = $('#ir-precalc');
    if (pc) pc.addEventListener('click', openPrecalcModal);
  }
  function monthLabelFromYM(ym) {
    const [y, m] = ym.split('-').map(Number);
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1] + ' ' + y;
  }

  /* ----- Pre-calculate contracted rates from the imported sheet -----
     For historical/imported projects the leader has the fees per month and
     the staffing shape, but no rates. This backs INTO the imported total:
     weight each active role by its rack rate (so the seniority spread stays
     sensible), scale every weight by one factor so calculated ≈ imported,
     and preview the result month by month. Discussion aid only — Confirm
     writes contracted rates onto the roles and NOTHING else; the imported
     projection stays locked until the leader marks it reconciled, and the
     leader is expected to sanity-check the staffing shape first. */
  function precalcRates() {
    const cat = window.RATES_CATALOG;
    const rec0 = stateAsRecord();
    if (!rec0.source || !rec0.source.importedByMonth) return null;
    const hasFte = (r) => (r.fteMonthly && Object.values(r.fteMonthly).some(v => +v > 0)) ||
                          Object.values(r.fte || {}).some(v => +v > 0);
    // Solve every role that actually works months. Deliberately-free roles
    // (grid source on a no-charge tier) stay free.
    const solve = {};
    state.roles.forEach(r => {
      if (!hasFte(r)) return;
      const tier = getTier(r.titleId, r.tierId);
      if (r.rateSource !== 'contracted' && tier && tier.isNoCharge) return;
      const cr = parseFloat(r.contractedRate);
      solve[r.id] = (tier && !tier.isNoCharge && tier.rate) ? tier.rate : (cr > 0 ? cr : 100);
    });
    if (!Object.keys(solve).length) return { empty: 'nofte' };
    const runWith = (rates) => {
      const clone = JSON.parse(JSON.stringify(rec0));
      clone.roles.forEach(r => {
        if (rates[r.id] != null) { r.rateSource = 'contracted'; r.contractedRate = rates[r.id]; }
      });
      return STORE.reconcileImport(clone, cat);
    };
    let rates = solve, rec = runWith(rates);
    if (!rec || !rec.importedTotal) return { empty: 'noimport' };
    if (!rec.calculatedTotal) return { empty: 'nofte' };
    // One scale is exact when fee is proportional to the rates (the usual
    // case); the extra passes absorb fixed pieces (rate-lock credits) and
    // the rounding of each rate to cents.
    for (let i = 0; i < 4; i++) {
      const k = rec.importedTotal / rec.calculatedTotal;
      const next = {};
      Object.keys(rates).forEach(id => { next[id] = Math.round(rates[id] * k * 100) / 100; });
      rates = next;
      rec = runWith(rates);
      if (!rec.calculatedTotal || Math.abs(rec.variance) < 1) break;
    }
    return { rates, rec };
  }

  function openPrecalcModal() {
    if (document.getElementById('precalc-modal')) return;
    const res = precalcRates();
    if (!res) return;
    const ov = document.createElement('div');
    ov.id = 'precalc-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99000;background:rgba(37,39,58,.55);display:flex;align-items:center;justify-content:center;padding:20px;';
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });

    let body;
    if (res.empty) {
      body = `<div class="pcm-note">${res.empty === 'noimport'
        ? 'This project has no imported monthly fees to back into.'
        : 'The roster has no billable FTE yet — the pre-calculation needs a staffing shape to price. Add FTE (or seed the roster from the staffing matrix) first.'}</div>
        <div class="pcm-foot"><button type="button" class="pcm-btn" data-close>Close</button></div>`;
    } else {
      const { rates, rec } = res;
      const roleRows = state.roles.filter(r => rates[r.id] != null).map(r => {
        const title = getTitle(r.titleId);
        const tier = getTier(r.titleId, r.tierId);
        const label = (r.projectRole || '').trim() || (title ? title.name : 'Role');
        const cur = r.rateSource === 'contracted'
          ? (r.contractedRate != null && r.contractedRate !== '' ? '$' + r.contractedRate + '/hr contracted' : 'contracted · no rate')
          : (tier ? 'grid $' + shownRate(tier) + '/hr' : 'grid');
        return `<tr>
          <td>${escapeHtml(label)}${r.resource ? `<span class="pcm-res">${escapeHtml(r.resource)}</span>` : ''}</td>
          <td>${escapeHtml(tier ? tier.label : '')}</td>
          <td class="num muted">${escapeHtml(cur)}</td>
          <td class="num"><b>${fmtMoneyDecimal(rates[r.id])}</b>/hr</td>
        </tr>`;
      }).join('');
      const monthRows = rec.byMonth.filter(m => m.imported || m.calculated).map(m => {
        const v = m.variance;
        return `<tr>
          <td>${monthLabelFromYM(m.ym)}</td>
          <td class="num">${m.imported ? fmtMoney(m.imported) : '·'}</td>
          <td class="num">${m.calculated ? fmtMoney(m.calculated) : '·'}</td>
          <td class="num ${Math.abs(v) < 1 ? 'ok' : (v > 0 ? 'over' : 'under')}">${Math.abs(v) < 1 ? '✓' : (v > 0 ? '+' : '−') + fmtMoney(Math.abs(v))}</td>
        </tr>`;
      }).join('');
      const vAbs = Math.abs(rec.variance);
      body = `
        <div class="pcm-note">These contracted rates <b>back into the imported total</b> using the staffing shape already on this project — the seniority spread follows the rate grid, scaled as one block. <b>For discussion only:</b> nothing locks in. Confirm the staffing below matches what was originally worked before applying, and the imported projection stays locked either way until you mark the project reconciled.</div>
        <div class="pcm-tot">
          <span>Imported <b>${fmtMoney(rec.importedTotal)}</b></span>
          <span>Pre-calculated <b>${fmtMoney(rec.calculatedTotal)}</b></span>
          <span>Residual <b>${vAbs < 1 ? '✓ to the dollar' : (rec.variance > 0 ? '+' : '−') + fmtMoney(vAbs) + (vAbs < 50 ? ' (rate rounding)' : '')}</b></span>
        </div>
        <div class="pcm-sec">Proposed rates (${Object.keys(rates).length} role${Object.keys(rates).length === 1 ? '' : 's'})</div>
        <table class="pcm-table"><thead><tr><th>Role</th><th>Tier</th><th class="num">Current</th><th class="num">Proposed</th></tr></thead><tbody>${roleRows}</tbody></table>
        <div class="pcm-sec">Month by month</div>
        <div class="pcm-scroll"><table class="pcm-table"><thead><tr><th>Month</th><th class="num">Imported</th><th class="num">Pre-calculated</th><th class="num">Δ</th></tr></thead><tbody>${monthRows}</tbody></table></div>
        <div class="pcm-foot">
          <button type="button" class="pcm-btn" data-close>Cancel — keep as is</button>
          <button type="button" class="pcm-btn primary" data-apply>Apply these rates to the roster</button>
        </div>`;
    }

    ov.innerHTML = `
      <style>
        #precalc-modal .pcm-panel{background:#fff;max-width:680px;width:100%;max-height:86vh;overflow-y:auto;box-shadow:0 18px 60px rgba(37,39,58,.45);font-size:13px;}
        #precalc-modal .pcm-head{background:#25273A;color:#fff;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;}
        #precalc-modal .pcm-head b{font-size:14px;letter-spacing:.02em;}
        #precalc-modal .pcm-x{background:none;border:0;color:#fff;font-size:20px;cursor:pointer;line-height:1;}
        #precalc-modal .pcm-note{padding:14px 20px;background:#fdf3d7;color:#5a4a00;line-height:1.5;}
        #precalc-modal .pcm-tot{display:flex;gap:22px;flex-wrap:wrap;padding:12px 20px;border-bottom:1px solid rgba(37,39,58,.12);color:#4a4f5c;}
        #precalc-modal .pcm-tot b{color:#25273A;margin-left:5px;}
        #precalc-modal .pcm-sec{padding:14px 20px 6px;font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#8a8f9a;}
        #precalc-modal .pcm-table{width:100%;border-collapse:collapse;}
        #precalc-modal .pcm-table th,#precalc-modal .pcm-table td{padding:7px 20px;text-align:left;border-bottom:1px solid rgba(37,39,58,.07);}
        #precalc-modal .pcm-table th{font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#8a8f9a;}
        #precalc-modal .pcm-table .num{text-align:right;}
        #precalc-modal .pcm-table .muted{color:#8a8f9a;}
        #precalc-modal .pcm-table .over{color:#0E7C7B;}
        #precalc-modal .pcm-table .under{color:#B3413B;}
        #precalc-modal .pcm-table .ok{color:#0E7C7B;}
        #precalc-modal .pcm-res{display:block;font-size:11px;color:#8a8f9a;}
        #precalc-modal .pcm-scroll{max-height:240px;overflow-y:auto;}
        #precalc-modal .pcm-foot{display:flex;justify-content:flex-end;gap:10px;padding:16px 20px;border-top:1px solid rgba(37,39,58,.12);position:sticky;bottom:0;background:#fff;}
        #precalc-modal .pcm-btn{border:1px solid rgba(37,39,58,.3);background:#fff;color:#25273A;padding:9px 16px;font-size:12px;font-weight:700;cursor:pointer;}
        #precalc-modal .pcm-btn.primary{background:#0E7C7B;border-color:#0E7C7B;color:#fff;}
        #precalc-modal .pcm-btn:hover{filter:brightness(.96);}
      </style>
      <div class="pcm-panel" role="dialog" aria-modal="true" aria-label="Pre-calculated rates">
        <div class="pcm-head"><b>⚡ Pre-calculated option — back into the imported fees</b><button type="button" class="pcm-x" data-close aria-label="Close">×</button></div>
        ${body}
      </div>`;
    document.body.appendChild(ov);
    ov.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
    const ap = ov.querySelector('[data-apply]');
    if (ap) ap.addEventListener('click', () => {
      state.roles.forEach(r => {
        if (res.rates[r.id] != null) { r.rateSource = 'contracted'; r.contractedRate = res.rates[r.id]; }
      });
      // The imported lock and reconciled flag are deliberately untouched —
      // this only prices the roster; the leader still reconciles themselves.
      markDirty();
      renderAll();
      close();
    });
  }

  /* Logical staffing SHAPE by seniority — relative weights, not absolute FTE.
     Mid-tier delivery roles (PM / Sr PM) carry the load; principals / EVPs are
     light-touch oversight; coordinators sit in between. At scale factor k=1 this
     IS a sensible fully-loaded team; the solver scales it up or down to hit the
     target. These are the ONLY assumed numbers, and only ever used when the
     proposal states no hours at all. */
  const SENIORITY_WEIGHT = {
    principal: 0.12, evp: 0.18, ed: 0.32, sd: 0.55, director: 0.70,
    'assoc-dir': 0.85, 'senior-pm': 1.0, pm: 1.0, 'assistant-pm': 0.85,
    'cost-control': 0.55, 'proj-coord': 0.65,
  };
  function seniorityWeight(role) {
    const id = resolveTitleId(role.titleId);
    return SENIORITY_WEIGHT[id] != null ? SENIORITY_WEIGHT[id] : 0.6;
  }
  /** A role's NET fee at 100% FTE across all phases (what 100% contributes to
      the target). Net is separable per role — discount and lock are per-role —
      so this is exact. Returns 0 for no-charge / unpriced roles. */
  function roleNetAtFull(role) {
    const tier = getTier(role.titleId, role.tierId);
    if (tier && tier.isNoCharge) return 0;
    const { base } = roleBaseInfo(role);
    if (!base) return 0;                       // contracted w/ no rate yet, etc.
    const saved = { ...role.fte };
    state.phases.forEach(p => { role.fte[p.id] = 100; });
    const d = (state.assumptions.discount || 0) / 100;
    const gross = roleTotal(role);
    const net = gross - roleLockCredit(role) - gross * d;
    role.fte = saved;
    return net;
  }

  /** Seed a LOGICAL staffing mock-up that bridges to a target fee when the
      proposal named people but stated no hours. Every named person gets some
      allocation, shaped by seniority, scaled (with 100% caps, water-filled) so
      the billable net lands on the target. Roles that can't be priced are given
      a nominal seniority-shaped allocation but excluded from the solve. If
      nothing can be priced, allocations are left blank — nothing is invented. */
  function seedAllocationsToTarget(target) {
    if (!state.roles.length) { renderReconcile('<span class="rc-warn">No people to staff. Add roles first.</span>'); return; }
    // Per-role net at 100% FTE and seniority weight.
    const info = state.roles.map(r => ({ r, c: roleNetAtFull(r) / 100, w: seniorityWeight(r) }));
    const billable = info.filter(x => x.c > 0.0001);
    if (!billable.length) {
      // No priced roles → can't bridge to a dollar figure. Leave blank, don't invent.
      state.roles.forEach(r => { r.fteMonthly = {}; state.phases.forEach(p => { r.fte[p.id] = 0; }); });
      renderAll();
      renderReconcile('<span class="rc-warn">These roles have no usable rate, so there\'s no logical way to bridge to the fee — allocations left blank. Set tiers or contracted rates, then reconcile.</span>');
      markDirty();
      return;
    }

    // Water-fill: x_i = min(100, k · w_i · 100) for billable roles, solve k so
    // Σ x_i·c_i = target. Cap roles that exceed 100%, redistribute to the rest.
    const capped = new Set();
    let k = 0, solved = false, maxedOut = false;
    for (let iter = 0; iter < billable.length + 2; iter++) {
      let capNet = 0, coef = 0;
      billable.forEach(x => {
        if (capped.has(x)) capNet += 100 * x.c;
        else coef += x.w * 100 * x.c;
      });
      if (coef <= 0) { maxedOut = true; break; }
      k = (target - capNet) / coef;
      if (k <= 0) { k = 0; }
      // Which uncapped roles now want > 100%?
      const newCaps = billable.filter(x => !capped.has(x) && k * x.w * 100 > 100 + 1e-9);
      if (!newCaps.length) { solved = true; break; }
      newCaps.forEach(x => capped.add(x));
      if (capped.size === billable.length) { maxedOut = true; break; }
    }

    // Assign FTEs. Billable: water-filled. Unpriced/no-charge: nominal weight shape.
    state.roles.forEach(r => {
      const x = info.find(i => i.r === r);
      let pct;
      if (billable.includes(x)) {
        pct = capped.has(x) || maxedOut ? 100 : Math.min(100, k * x.w * 100);
      } else {
        pct = Math.min(100, x.w * 100);          // staffed presence, contributes $0 to fee
      }
      pct = Math.max(0, Math.round(pct * 10) / 10);   // one-decimal FTE
      // Broadcast to months (canonical) + mirror the phase display.
      r.fteMonthly = r.fteMonthly || {};
      getMonthsByPhase().forEach(b => b.months.forEach(m => { r.fteMonthly[monthKey(m)] = pct; }));
      state.phases.forEach(p => { r.fte[p.id] = pct; });
    });
    renderAll();

    const net = netTotal();
    let msg;
    if (maxedOut && net < target - 0.005) {
      const shortBy = target - net;
      msg = `<span class="rc-warn">Staffed everyone to a sensible max — this team can bill <strong>${fmtMoney(net)}</strong>, <strong>${fmtMoney(shortBy)}</strong> short of <strong>${fmtMoney(target)}</strong>. Add people, extend the term, or raise rates; nothing was invented past 100%.</span>`;
    } else {
      msg = `<strong>Staffing mocked up to ${fmtMoneyCents(target)}.</strong> Allocations shaped by seniority (delivery roles carry the load, principals lighter) so every named person is staffed and the fee bridges to the target. Redistribute per phase to match the real plan, then <em>Fit to target</em> to lock the penny.`;
    }
    const viol = floorViolations().length;
    if (viol) msg += ` <span class="rc-warn">${viol} role${viol === 1 ? '' : 's'} below cost floor (advisory).</span>`;
    renderReconcile(msg);
    markDirty();
  }

  /** Back-solve to the target by adjusting ONLY the client discount — staffing
      allocations and per-role rates are held fixed (they come from the actual
      proposal). The rate-lock credit rides the discount too, so
      net = (gross − lockRaw) × (1 − discount); for a target net we solve
      discount = 1 − target / (gross − lockRaw). If the target is ABOVE what current
      rates can bill, discount can't help (it can't go negative) — we flag that and
      leave it for a manual rate change. Floor advisory still applies after. */
  function fitToTarget() {
    const target = currentTargetFee();
    if (target == null || target <= 0) {
      renderReconcile('<span class="rc-warn">Enter a target fee to reconcile against.</span>');
      return;
    }
    if (!state.roles.length) {
      renderReconcile('<span class="rc-warn">Add roles first — there is no staffing to solve.</span>');
      return;
    }

    const grossNow = grossTotal();
    const lockRaw = lockCreditRaw();
    const maxNet = grossNow - lockRaw;         // net with 0% discount — the ceiling

    // No allocations loaded (e.g. an ingested proposal with a fee but a blank
    // matrix) → SEED allocations to hit the target instead of failing.
    if (grossNow <= 0.5) {
      seedAllocationsToTarget(target);
      return;
    }

    let d = (grossNow - lockRaw > 0) ? 1 - target / (grossNow - lockRaw) : 1;
    let undershoot = false;                    // target is above what current rates can bill
    if (d < 0) { d = 0; undershoot = true; }
    d = Math.min(0.95, d);
    // Store the EXACT discount (full float) so net reconciles to the penny — even
    // if that means a discount like 12.34567%. The input shows a trimmed value for
    // readability, but that display never feeds back unless the user edits it, so
    // the exact value in state is what drives the math.
    state.assumptions.discount = d * 100;
    const discInput = $('#a-disc');
    if (discInput) discInput.value = trimPct(state.assumptions.discount);

    renderAll();

    let msg;
    if (undershoot) {
      const shortBy = target - maxNet;
      msg = `<span class="rc-warn">At current rates the most you can bill (0% discount) is <strong>${fmtMoney(maxNet)}</strong> — <strong>${fmtMoney(shortBy)}</strong> short of the target. Allocations are held to the proposal, so raise the rates (grid tier or contracted rate) to close the gap.</span>`;
    } else {
      const exactPct = trimNum(state.assumptions.discount);
      msg = `<strong>Reconciled to ${fmtMoneyCents(target)}.</strong> Held staffing &amp; rates; solved a <strong>${exactPct}%</strong> client discount — exact to the penny.`;
    }
    const viol = floorViolations().length;
    if (viol) msg += ` <span class="rc-warn">${viol} role${viol === 1 ? '' : 's'} now below cost floor (advisory).</span>`;
    renderReconcile(msg);
    markDirty();
  }

  /* ----- Project meta ----- */
  /** Show the representative sub-services for the selected Project Type as
      clickable pills; selections are stored in project.projectSubtypes. */
  function renderProjectTypeSubs() {
    const el = $('#pm-ptype-subs');
    if (!el) return;
    const subs = STORE.projectTypeSubs(state.project.projectType || '');
    if (!subs.length) { el.hidden = true; el.innerHTML = ''; return; }
    const chosen = Array.isArray(state.project.projectSubtypes) ? state.project.projectSubtypes : [];
    el.hidden = false;
    el.innerHTML = `<span class="pt-subs-lbl">Includes</span>` +
      subs.map(s => `<span class="pt-sub ${chosen.includes(s) ? 'is-on' : ''}" data-sub="${escapeHtml(s)}">${escapeHtml(s)}</span>`).join('');
    $$('.pt-sub', el).forEach(pill => pill.addEventListener('click', () => {
      const s = pill.dataset.sub;
      let arr = Array.isArray(state.project.projectSubtypes) ? state.project.projectSubtypes.slice() : [];
      if (arr.includes(s)) arr = arr.filter(x => x !== s); else arr.push(s);
      state.project.projectSubtypes = arr;
      pill.classList.toggle('is-on');
      markDirty();
    }));
  }

  /** Assumptions & exclusions: library chips (toggle) + any custom lines the
      user added. Selections + custom entries are stored in project.assumptionsList. */
  /* ---- Who can actually see this project ----
     Jeff on the Aug 13 call could not tell whether Mark would see Lazard, and
     nothing on the record answered it. Rather than restating the rules (which
     would drift the moment the wall changes), this ASKS the wall: it builds a
     candidate user for every leader and admin and reports what
     userOwnsProject / seesAllProjects actually return, plus which rule let
     them through. If the access model changes, this changes with it. */
  function renderWhoSees() {
    const el = $('#pm-whosees');
    if (!el || !STORE.impersonationRoster || !STORE.userOwnsProject) return;
    const rec = { id: state.id, project: { ...(state.project || {}) }, groups: state.groups || [] };
    // The typed-but-unsaved grant should be reflected immediately.
    const accessEl = $('#pm-access');
    if (accessEl) rec.project.accessGrant = accessEl.value;
    let roster = [];
    try { roster = STORE.impersonationRoster() || []; } catch (e) { return; }
    const named = [];
    roster.forEach(u => {
      if (!u.username) return;
      let all = false, owns = false;
      try { all = STORE.seesAllProjects(u); owns = STORE.userOwnsProject(rec, u); } catch (e) { return; }
      if (all || !owns) return;                       // admins are covered by the blanket line below
      const pj = rec.project || {};
      const me = STORE.resolveLeader(u.username);
      const isLead = me && STORE.resolveLeader(pj.leadId || pj.lead) && STORE.resolveLeader(pj.leadId || pj.lead).id === me.id;
      const isOwner = me && STORE.resolveLeader(pj.clientRelOwner) && STORE.resolveLeader(pj.clientRelOwner).id === me.id;
      const granted = (STORE.accessGrantList(rec) || []).includes(String(u.username).toLowerCase());
      const why = isLead ? 'lead' : isOwner ? 'relationship owner' : granted ? 'granted by email' : 'team / group rule';
      named.push({ name: u.name || u.username, why });
    });
    let nAdmin = 0;
    try { nAdmin = roster.filter(u => u.username && STORE.seesAllProjects(u)).length; } catch (e) {}
    el.hidden = false;
    el.innerHTML = '<b>Who can see this project</b>'
      + (named.length
          ? named.map(n => `<div class="ws-row">· ${escapeHtml(n.name)} <span class="ws-why">— ${escapeHtml(n.why)}</span></div>`).join('')
          : '<div class="ws-row ws-why">· nobody outside the admin group — only the people below</div>')
      + `<div class="ws-row ws-why">· plus everyone with firm-wide access${nAdmin ? ' (' + nAdmin + ')' : ''}</div>`;
  }

  function renderAssumptions() {
    const el = $('#pm-assumptions');
    if (!el) return;
    const chosen = Array.isArray(state.project.assumptionsList) ? state.project.assumptionsList : [];
    const lib = STORE.ASSUMPTION_LIBRARY;
    const custom = chosen.filter(a => !lib.includes(a));
    const chips = lib.map(a => `<span class="asm-chip ${chosen.includes(a) ? 'is-on' : ''}" data-asm="${escapeHtml(a)}">${escapeHtml(a)}</span>`)
      .concat(custom.map(a => `<span class="asm-chip is-on is-custom" data-asm="${escapeHtml(a)}">${escapeHtml(a)} <span class="asm-x" data-rm="${escapeHtml(a)}">×</span></span>`));
    el.innerHTML = chips.join('');
    $$('.asm-chip', el).forEach(chip => chip.addEventListener('click', (e) => {
      if (e.target.classList.contains('asm-x')) return;   // handled below
      const a = chip.dataset.asm;
      let arr = Array.isArray(state.project.assumptionsList) ? state.project.assumptionsList.slice() : [];
      if (arr.includes(a)) arr = arr.filter(x => x !== a); else arr.push(a);
      state.project.assumptionsList = arr;
      renderAssumptions();
      markDirty();
    }));
    $$('.asm-x', el).forEach(x => x.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = x.dataset.rm;
      state.project.assumptionsList = (state.project.assumptionsList || []).filter(v => v !== a);
      renderAssumptions();
      markDirty();
    }));
  }

  function renderProjectMeta() {
    const f = state.project;
    $('#pm-name').value = f.name;
    $('#pm-client').value = f.client;
    // Lead + relationship-owner dropdowns from the Revenue Leaders directory
    const leadOptsHtml = '<option value="">— select —</option>' +
      STORE.REVENUE_LEADERS.map(l => `<option value="${l.id}">${escapeHtml(l.displayName)}</option>`).join('');
    const leadSel = $('#pm-lead');
    if (leadSel && leadSel.tagName === 'SELECT') {
      leadSel.innerHTML = leadOptsHtml;
      const ll = STORE.resolveLeader(f.leadId || f.lead);
      leadSel.value = ll ? ll.id : '';
    }
    $('#pm-date').value = f.proposalDate || '';
    $('#pm-location').value = f.location;
    { const nt = $('#pm-notes'); if (nt) nt.value = f.notes || ''; }

    // Status dropdown
    const statusSel = $('#pm-status');
    if (!statusSel.options.length) {
      STORE.STATUSES.forEach(s => {
        const o = document.createElement('option');
        o.value = s; o.textContent = STORE.STATUS_LABELS[s];
        statusSel.appendChild(o);
      });
    }
    statusSel.value = f.status || 'draft';

    // Lost-reason dropdown (only visible when status = lost)
    const lostSel = $('#pm-lostReason');
    if (lostSel && !lostSel.options.length) {
      const blank = document.createElement('option'); blank.value = ''; blank.textContent = '— select —';
      lostSel.appendChild(blank);
      STORE.LOST_REASONS.forEach(r => {
        const o = document.createElement('option'); o.value = r; o.textContent = r;
        lostSel.appendChild(o);
      });
    }
    if (lostSel) lostSel.value = f.lostReason || '';
    const lostField = $('#lost-reason-field');
    if (lostField) lostField.style.display = (f.status === 'lost') ? '' : 'none';

    // Projection rating dropdown (1–7)
    const ratingSel = $('#pm-rating');
    if (ratingSel && !ratingSel.options.length) {
      STORE.RATINGS.forEach(r => {
        const o = document.createElement('option');
        o.value = r.n; o.textContent = `${r.n} · ${r.label}`;
        ratingSel.appendChild(o);
      });
    }
    if (ratingSel) ratingSel.value = STORE.ratingFor(state);
    updateStatusRatingHints();

    // Industry dropdown
    const indSel = $('#pm-industry');
    if (!indSel.options.length) {
      const blank = document.createElement('option');
      blank.value = ''; blank.textContent = '— select —';
      indSel.appendChild(blank);
      STORE.INDUSTRIES.forEach(i => {
        const o = document.createElement('option');
        o.value = i; o.textContent = i;
        indSel.appendChild(o);
      });
    }
    indSel.value = f.industry || '';

    // Project Type dropdown (+ sub-services shown once selected)
    const ptSel = $('#pm-ptype');
    if (ptSel && !ptSel.options.length) {
      const blank = document.createElement('option');
      blank.value = ''; blank.textContent = '— select —';
      ptSel.appendChild(blank);
      STORE.PROJECT_TYPES.forEach(t => {
        const o = document.createElement('option');
        o.value = t.name; o.textContent = t.name;
        ptSel.appendChild(o);
      });
    }
    if (ptSel) ptSel.value = f.projectType || '';
    renderProjectTypeSubs();
    renderAssumptions();

    const accessEl = $('#pm-access'); if (accessEl) accessEl.value = f.accessGrant || '';
    try { renderWhoSees(); } catch (e) {}

    $('#pm-firstProposal').value = f.firstProposalDate || '';
    $('#pm-signed').value = f.signedContractDate || '';
    const sfidEl = $('#pm-sfid'); if (sfidEl) sfidEl.value = f.salesforceId || '';
    $('#pm-clientContact').value = f.clientContact || '';
    const relSel = $('#pm-clientRel');
    if (relSel && relSel.tagName === 'SELECT') {
      relSel.innerHTML = leadOptsHtml;
      const rl = STORE.resolveLeader(f.clientRelOwner);
      relSel.value = rl ? rl.id : '';
    }

    $('#hdr-project').textContent = f.name || 'Untitled project';
    $('#hdr-client').textContent  = f.client ? `for ${f.client}` : '';
    const statusLabel = STORE.STATUS_LABELS[f.status] || '';
    $('#hdr-status').innerHTML = statusLabel ? ` <span style="font-weight:700;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;padding:3px 8px;background:var(--sav-yellow);color:var(--sav-navy);margin-left:8px;">${statusLabel}</span>` : '';
  }

  /* ----- Timeline ----- */
  function renderTimeline() {
    const t = state.timeline;
    $('#tl-start-month').value = t.startMonth;
    $('#tl-start-year').value  = t.startYear;
    $('#tl-end-month').value   = t.endMonth;
    $('#tl-end-year').value    = t.endYear;
    const n = projectMonthCount();
    $('#tl-count').textContent = n + ' month' + (n === 1 ? '' : 's');
    const months = getMonths();
    if (months.length) {
      $('#tl-range').textContent = `${months[0].longLabel} → ${months[months.length-1].longLabel}`;
    } else {
      $('#tl-range').textContent = 'End must be on or after start.';
    }
  }

  /* ----- Phases ----- */
  function renderPhases() {
    const tbody = $('#phases-list');
    tbody.innerHTML = '';
    const total = projectMonthCount();
    state.phases.forEach((p, idx) => {
      const isLast = idx === state.phases.length - 1;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="ix-cell">${idx + 1}</td>
        <td><input class="ph-name" data-id="${p.id}" type="text" value="${escapeHtml(p.name)}" placeholder="Phase name"></td>
        <td class="num">
          <div class="stepper">
            <button class="step-btn" data-act="dec" data-id="${p.id}" ${isLast ? 'disabled' : ''}>−</button>
            <input class="ph-len" data-id="${p.id}" type="number" min="0" step="1" value="${p.length}" ${isLast ? 'disabled' : ''}>
            <button class="step-btn" data-act="inc" data-id="${p.id}" ${isLast ? 'disabled' : ''}>+</button>
          </div>
        </td>
        <td class="ph-range">${phaseDateRange(p, idx)}</td>
        <td class="actions-cell">
          <button class="icon-btn ph-up" data-id="${p.id}" title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon-btn ph-down" data-id="${p.id}" title="Move down" ${idx === state.phases.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="icon-btn ph-rm" data-id="${p.id}" title="Remove phase" ${state.phases.length === 1 ? 'disabled' : ''}>×</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    // Phase strip visualization
    renderPhaseStrip();

    // Wire inputs
    $$('.ph-name').forEach(i => i.addEventListener('input', e => {
      const p = getPhase(e.target.dataset.id);
      if (p) p.name = e.target.value;
      renderMatrix(); renderMonthly(); renderPhaseStrip();
      markDirty();
    }));
    $$('.ph-len').forEach(i => i.addEventListener('change', e => {
      const p = getPhase(e.target.dataset.id);
      if (!p) return;
      const val = Math.max(0, parseInt(e.target.value) || 0);
      p.length = val;
      // The last phase auto-balances, so don't allow value to exceed total - sum-of-others
      renderAll();
      markDirty();
    }));
    $$('.step-btn').forEach(b => b.addEventListener('click', e => {
      const p = getPhase(e.target.dataset.id);
      if (!p) return;
      const idx = state.phases.indexOf(p);
      if (idx === state.phases.length - 1) return;
      const last = state.phases[state.phases.length - 1];
      if (e.target.dataset.act === 'inc') {
        if (last.length > 0) { p.length++; last.length--; }
      } else {
        if (p.length > 0) { p.length--; last.length++; }
      }
      renderAll();
      markDirty();
    }));
    $$('.ph-up').forEach(b => b.addEventListener('click', e => { reorderById(state.phases, e.target.dataset.id, -1); renderAll(); markDirty(); }));
    $$('.ph-down').forEach(b => b.addEventListener('click', e => { reorderById(state.phases, e.target.dataset.id, 1); renderAll(); markDirty(); }));
    $$('.ph-rm').forEach(b => b.addEventListener('click', e => {
      const id = e.target.dataset.id;
      const idx = state.phases.findIndex(p => p.id === id);
      if (idx < 0 || state.phases.length === 1) return;
      const removed = state.phases.splice(idx, 1)[0];
      // Merge length into the now-last phase (or whichever phase is last)
      state.phases[state.phases.length - 1].length += removed.length;
      renderAll();
      markDirty();
    }));
    $('#phase-add').onclick = () => {
      const last = state.phases[state.phases.length - 1];
      const split = Math.max(1, Math.floor(last.length / 2));
      last.length -= split;
      state.phases.push({ id: uid(), name: 'New phase', length: split });
      renderAll();
      markDirty();
    };
  }

  function phaseDateRange(phase, idx) {
    const all = getMonthsByPhase();
    const slice = all.find(x => x.phase.id === phase.id)?.months || [];
    if (!slice.length) return '—';
    if (slice.length === 1) return slice[0].longLabel;
    return `${slice[0].longLabel} → ${slice[slice.length-1].longLabel}`;
  }

  function renderPhaseStrip() {
    const strip = $('#phase-strip');
    strip.innerHTML = '';
    const months = getMonths();
    if (!months.length) return;
    const total = months.length;
    const buckets = getMonthsByPhase();
    buckets.forEach((b, i) => {
      const seg = document.createElement('div');
      seg.className = 'strip-seg seg-' + (i % 5);
      seg.style.flex = b.months.length;
      seg.innerHTML = `<span class="strip-name">${escapeHtml(b.phase.name)}</span><span class="strip-meta">${b.months.length} mo</span>`;
      strip.appendChild(seg);
    });
    const stripMonths = $('#phase-strip-months');
    stripMonths.innerHTML = months.map(m => `<div class="strip-month">${m.label}</div>`).join('');
  }

  /* ----- Groups ----- */
  function renderGroups() {
    const ul = $('#groups-list');
    ul.innerHTML = '';
    state.groups.forEach(g => {
      const li = document.createElement('li');
      const sl = STORE.serviceLineOfGroup(g);
      const opts = STORE.SERVICE_LINES.map(s => `<option value="${escapeHtml(s)}" ${s === sl ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('');
      li.innerHTML = `
        <div class="g-row">
          <input type="text" class="g-name" data-id="${g.id}" value="${escapeHtml(g.name)}">
          <button class="icon-btn g-rm" data-id="${g.id}" title="Remove group" ${state.groups.length === 1 ? 'disabled' : ''}>×</button>
        </div>
        <div class="g-sl-row"><span class="g-sl-lbl">Revenue attributed to</span><select class="g-sl" data-id="${g.id}">${opts}</select></div>
      `;
      ul.appendChild(li);
    });
    $$('.g-name').forEach(i => i.addEventListener('input', e => {
      const g = state.groups.find(x => x.id === e.target.dataset.id);
      if (g) g.name = e.target.value;
      renderMatrix(); renderMonthly(); renderSelectedRoles();
      markDirty();
    }));
    $$('.g-sl').forEach(s => s.addEventListener('change', e => {
      const g = state.groups.find(x => x.id === e.target.dataset.id);
      if (!g) return;
      g.serviceLine = e.target.value;
      delete g.serviceLines;            // single-select: drop any legacy multi-tag array
      markDirty();
    }));
    $$('.g-rm').forEach(b => b.addEventListener('click', e => {
      const id = e.target.dataset.id;
      if (state.groups.length === 1) return;
      const remaining = state.groups.filter(g => g.id !== id);
      // reassign roles in deleted group to first remaining
      state.roles.forEach(r => { if (r.groupId === id) r.groupId = remaining[0].id; });
      state.groups = remaining;
      renderAll();
      markDirty();
    }));
    $('#group-add').onclick = () => {
      state.groups.push({ id: uid(), name: 'New group' });
      renderAll();
      markDirty();
    };
  }

  /* ----- Catalog ----- */
  function renderCatalog() {
    const wrap = $('#catalog-grid');
    wrap.innerHTML = '';
    CATALOG.titles.forEach(t => {
      const instanceCount = state.roles.filter(r => r.titleId === t.id).length;
      const card = document.createElement('div');
      card.className = 'cat-card' + (instanceCount ? ' is-active' : '');
      const tierOptions = t.tiers.map(tier => {
        const label = tier.isNoCharge
          ? `${tier.label} — no charge`
          : `${tier.label} — $${shownRate(tier)}/hr · floor $${tier.costFloor}`;
        return `<option value="${tier.id}">${label}</option>`;
      }).join('');
      card.innerHTML = `
        <div class="cat-card-head">
          <label class="cat-check">
            <input type="checkbox" data-tid="${t.id}" ${instanceCount ? 'checked' : ''}>
            <span class="cat-check-box"></span>
          </label>
          <div class="cat-title">
            <div class="cat-name">${escapeHtml(t.name)}</div>
            ${t.note ? `<div class="cat-note">${escapeHtml(t.note)}</div>` : ''}
          </div>
          ${instanceCount ? `<span class="cat-count">${instanceCount}×</span>` : ''}
        </div>
        <div class="cat-card-foot">
          <select class="cat-tier" data-tid="${t.id}">${tierOptions}</select>
          <button class="cat-add" data-tid="${t.id}" title="Add another instance">+ Add</button>
        </div>
      `;
      wrap.appendChild(card);
    });

    // Wire
    $$('.cat-card input[type=checkbox]').forEach(c => c.addEventListener('change', e => {
      const titleId = e.target.dataset.tid;
      if (e.target.checked) {
        addRoleInstance(titleId);
      } else {
        // remove all instances
        state.roles = state.roles.filter(r => r.titleId !== titleId);
        renderAll();
        markDirty();
      }
    }));
    $$('.cat-add').forEach(b => b.addEventListener('click', e => {
      const titleId = e.target.dataset.tid;
      const card = e.target.closest('.cat-card');
      const tierSel = card.querySelector('.cat-tier');
      addRoleInstance(titleId, tierSel.value);
    }));
  }

  function addRoleInstance(titleId, tierId) {
    const title = getTitle(titleId);
    if (!title) return;
    const tier = tierId ? title.tiers.find(t => t.id === tierId) : title.tiers[0];
    const fte = {};
    state.phases.forEach(p => fte[p.id] = 0);
    const groupId = state.groups.find(g => g.id === title.defaultGroup)?.id || state.groups[0].id;
    state.roles.push({
      id: uid(),
      titleId,
      tierId: tier.id,
      resource: '',
      projectRole: '',
      rateSource: 'grid',
      contractedRate: null,
      groupId,
      fte,
    });
    renderAll();
    markDirty();
  }

  /* ----- Selected roles editor ----- */
  function renderSelectedRoles() {
    const list = $('#roles-list');
    list.innerHTML = '';
    if (!state.roles.length) {
      list.innerHTML = `<div class="empty">No roles selected yet. Check titles above to add them.</div>`;
      $('#roles-count').textContent = '0 roles';
      return;
    }
    $('#roles-count').textContent = `${state.roles.length} role${state.roles.length === 1 ? '' : 's'}`;
    state.roles.forEach((r, idx) => {
      const title = getTitle(r.titleId);
      if (!title) return;
      const tierOptions = title.tiers.map(t => {
        const lbl = t.isNoCharge ? `${t.label} — no charge` : `${t.label} — $${shownRate(t)}/hr · floor $${t.costFloor}`;
        return `<option value="${t.id}" ${r.tierId === t.id ? 'selected' : ''}>${lbl}</option>`;
      }).join('');
      const groupOptions = state.groups.map(g =>
        `<option value="${g.id}" ${r.groupId === g.id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`
      ).join('');
      const row = document.createElement('div');
      row.className = 'role-row' + (roleFloorViolation(r) ? ' is-violation' : '');
      const floor = roleCostFloor(r);
      const eff = effectiveMinRate(r);
      const bad = roleFloorViolation(r);
      const tierObj = getTier(r.titleId, r.tierId);
      const isContracted = r.rateSource === 'contracted';

      // chip reflects the floor advisory in either mode
      let chipHtml;
      if (tierObj && tierObj.isNoCharge && !isContracted) {
        chipHtml = `<span class="chip muted">No charge</span>`;
      } else if (isContracted && (r.contractedRate == null || r.contractedRate === '')) {
        chipHtml = `<span class="chip muted">Enter rate</span>`;
      } else {
        chipHtml = `<span class="chip">${bad ? '⚠ Potentially unprofitable' : 'Floor OK'}</span>`;
      }

      // detail differs by source
      let detailHtml;
      if (isContracted) {
        detailHtml = `<span class="rr-floor-detail">contracted${eff != null ? ` · billed <strong>${fmtMoneyDecimal(eff)}</strong>/hr in ${state.timeline.startYear}` : ''} · escalates ${state.assumptions.escalation}%/yr · client discount applies · bypasses industry adj${floor ? ` · floor <strong>$${floor}</strong>` : ''}${bad ? ' — below cost; margin may be thin or negative' : ''}</span>`;
      } else if (floor && eff != null) {
        const rack = tierObj ? tierObj.rate : 0;
        const adj = shownRate(tierObj);
        detailHtml = `<span class="rr-floor-detail">Rack <strong>$${rack}</strong> · adj <strong>$${adj}</strong> · effective <strong>${fmtMoneyDecimal(eff)}</strong>/hr vs. floor <strong>$${floor}</strong>${bad ? ' — included below cost; margin may be thin or negative' : ''}</span>`;
      } else {
        detailHtml = `<span class="rr-floor-detail">Exempt from the cost-rate floor.</span>`;
      }

      const crInput = isContracted
        ? `<span class="rr-cr"><span class="rr-cr-$">$</span><input class="rr-crate" data-id="${r.id}" type="number" step="1" min="0" value="${r.contractedRate != null ? r.contractedRate : ''}" placeholder="rate"><span class="rr-cr-unit">/hr</span></span>`
        : '';

      const floorHtml = `<div class="rr-floor ${bad ? 'bad' : ''}">
          <div class="rr-src" role="group" aria-label="Rate source">
            <button type="button" class="rr-src-btn ${!isContracted ? 'on' : ''}" data-id="${r.id}" data-src="grid">Grid</button>
            <button type="button" class="rr-src-btn ${isContracted ? 'on' : ''}" data-id="${r.id}" data-src="contracted">Contracted</button>
          </div>
          ${crInput}
          ${chipHtml}
          ${detailHtml}
        </div>`;
      row.innerHTML = `
        <div class="rr-ix">${idx + 1}</div>
        <div class="rr-title">${escapeHtml(title.name)}<span class="rr-title-sub">staff title</span></div>
        <div class="rr-field">
          <label>Project role</label>
          <input class="rr-projrole" data-id="${r.id}" type="text" value="${escapeHtml(r.projectRole || '')}" placeholder="e.g. Tactical Execution Mgr">
        </div>
        <div class="rr-field">
          <label>Tier</label>
          <select class="rr-tier" data-id="${r.id}">${tierOptions}</select>
        </div>
        <div class="rr-field">
          <label>Resource</label>
          <input class="rr-resource" data-id="${r.id}" type="text" value="${escapeHtml(r.resource)}" placeholder="TBD or name">
        </div>
        <div class="rr-field">
          <label>Group</label>
          <select class="rr-group" data-id="${r.id}">${groupOptions}</select>
        </div>
        <div class="rr-reorder">
          <button class="icon-btn rr-up" data-id="${r.id}" title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon-btn rr-down" data-id="${r.id}" title="Move down" ${idx === state.roles.length - 1 ? 'disabled' : ''}>↓</button>
        </div>
        <button class="icon-btn rr-rm" data-id="${r.id}" title="Remove role">×</button>
        ${floorHtml}
      `;
      list.appendChild(row);
    });
    $$('.rr-tier').forEach(s => s.addEventListener('change', e => {
      const r = state.roles.find(x => x.id === e.target.dataset.id);
      if (r) r.tierId = e.target.value;
      renderSummary(); renderMatrix(); renderMonthly(); renderSelectedRoles(); renderFloorCheck();
      markDirty();
    }));
    $$('.rr-projrole').forEach(i => i.addEventListener('input', e => {
      const r = state.roles.find(x => x.id === e.target.dataset.id);
      if (r) r.projectRole = e.target.value;
      renderMatrix(); renderMonthly();
      markDirty();
    }));
    $$('.rr-src-btn').forEach(b => b.addEventListener('click', e => {
      const r = state.roles.find(x => x.id === e.target.dataset.id);
      if (!r) return;
      const src = e.target.dataset.src;
      if (r.rateSource === src) return;
      r.rateSource = src;
      // Seed a sensible contracted rate from the current grid rate on first switch
      if (src === 'contracted' && (r.contractedRate == null || r.contractedRate === '')) {
        const tier = getTier(r.titleId, r.tierId);
        if (tier && !tier.isNoCharge) r.contractedRate = shownRate(tier);
      }
      renderSelectedRoles(); renderSummary(); renderMatrix(); renderMonthly(); renderFloorCheck();
      markDirty();
    }));
    $$('.rr-crate').forEach(i => i.addEventListener('input', e => {
      const r = state.roles.find(x => x.id === e.target.dataset.id);
      if (!r) return;
      const v = e.target.value;
      r.contractedRate = v === '' ? null : (parseFloat(v) || 0);
      renderSummary(); renderMatrix(); renderMonthly(); renderFloorCheck();
      // update just this row's chip/detail without stealing focus
      const row = e.target.closest('.role-row');
      if (row) {
        const bad = roleFloorViolation(r);
        row.classList.toggle('is-violation', bad);
        row.querySelector('.rr-floor')?.classList.toggle('bad', bad);
      }
      markDirty();
    }));
    $$('.rr-resource').forEach(i => i.addEventListener('input', e => {
      const r = state.roles.find(x => x.id === e.target.dataset.id);
      if (r) r.resource = e.target.value;
      renderMatrix(); renderMonthly();
      markDirty();
    }));
    $$('.rr-group').forEach(s => s.addEventListener('change', e => {
      const r = state.roles.find(x => x.id === e.target.dataset.id);
      if (r) r.groupId = e.target.value;
      renderMatrix(); renderMonthly();
      markDirty();
    }));
    $$('.rr-rm').forEach(b => b.addEventListener('click', e => {
      state.roles = state.roles.filter(r => r.id !== e.target.dataset.id);
      renderAll();
      markDirty();
    }));
    $$('.rr-up').forEach(b => b.addEventListener('click', e => { reorderById(state.roles, e.target.dataset.id, -1); renderAll(); markDirty(); }));
    $$('.rr-down').forEach(b => b.addEventListener('click', e => { reorderById(state.roles, e.target.dataset.id, 1); renderAll(); markDirty(); }));
  }

  /** Move the item with `id` up (dir -1) or down (dir +1) within arr, in place. */
  function reorderById(arr, id, dir) {
    const i = arr.findIndex(x => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    const [item] = arr.splice(i, 1);
    arr.splice(j, 0, item);
  }

  /* ----- Assumptions ----- */
  function renderAssumptions() {
    const a = state.assumptions;
    $('#a-hrs').value = a.hrsPerMo;
    $('#a-esc').value = a.escalation;
    $('#a-ind').value = a.industryAdj;
    $('#a-disc').value = trimPct(a.discount);
    $('#a-lock').checked = a.rateLock;
    $('#a-catbase').textContent = a.catalogBaseYear;
    // Fee basis (Fixed / NTE)
    const fb = (a.feeBasis === 'nte') ? 'nte' : 'fixed';
    const fbSel = $('#a-feebasis'); if (fbSel) fbSel.value = fb;
    const nteField = $('#a-nte-field'); if (nteField) nteField.hidden = (fb !== 'nte');
    const nteInput = $('#a-nte'); if (nteInput) nteInput.value = a.nteCeiling || '';
    updateNteHint();
  }

  /** Live "over ceiling" hint on the NTE field. */
  function updateNteHint() {
    const a = state.assumptions;
    const hintEl = $('#a-nte-hint');
    if (!hintEl || a.feeBasis !== 'nte') return;
    const ceiling = parseFloat(a.nteCeiling) || 0;
    const planned = netTotal();
    if (ceiling > 0 && planned > ceiling + 0.005) {
      hintEl.innerHTML = `<strong style="color:var(--sav-red);">⚠ Over cap by ${fmtMoney(planned - ceiling)}</strong> — planned ${fmtMoney(planned)} exceeds the ${fmtMoney(ceiling)} ceiling. Trim allocations.`;
    } else if (ceiling > 0) {
      hintEl.innerHTML = `Planned ${fmtMoney(planned)} of ${fmtMoney(ceiling)} ceiling — ${fmtMoney(ceiling - planned)} of headroom.`;
    } else {
      hintEl.textContent = 'The cap the client gave us. Locked at booking. Planned fee is flagged if it exceeds this.';
    }
  }

  /** Guidance text under the Status + Projection-rating dropdowns, and an aging hint. */
  function ratingGuidanceText(status) {
    switch (status) {
      case 'draft':       return 'Early estimate — usually 4–5 until it goes out.';
      case 'submitted':   return 'Proposal is out — default 4 (50–74%). Raise it if confidence is higher.';
      case 'negotiation': return 'In active negotiation — typically 3–5 by confidence.';
      case 'won':         return 'Is the contract signed? In hand → 1 (Booked). Verbal / imminent → 2.';
      case 'active':      return 'Active work — Booked (1).';
      case 'hold':        return 'On hold — 6 (<25%) until it revives.';
      case 'lost':        return 'Lost — 7 (Dead Pursuit); excluded from the forecast.';
      case 'closed':      return 'Closed out — completed/past work.';
      default:            return '';
    }
  }
  /** Months between the project's last billing month and today (positive = in the past). */
  function monthsSinceLastBilling() {
    const t = state.timeline; if (!t) return 0;
    const now = new Date();
    return (now.getFullYear() - t.endYear) * 12 + (now.getMonth() + 1 - t.endMonth);
  }
  /** Flag when Revenue Projections has manual overrides on this record that
      diverge from the calculator's computed fee — prompting a reconcile.
      Names the specific months and shows override vs. computed. */
  function renderProjFlag() {
    const el = $('#proj-flag');
    if (!el) return;
    const ov = state.monthlyOverrides;
    if (!ov || !Object.keys(ov).length) { el.hidden = true; el.innerHTML = ''; return; }
    const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    // Computed (pre-override) monthly net, to show the delta per month.
    const computed = {};
    try {
      const series = (window.UFC_Store.monthlySeries(JSON.parse(JSON.stringify(state)), CATALOG) || []);
      // re-run WITHOUT overrides for the comparison
      const bare = JSON.parse(JSON.stringify(state)); delete bare.monthlyOverrides;
      (window.UFC_Store.monthlySeries(bare, CATALOG) || []).forEach(s => { computed[s.year + '-' + s.month] = s.amount; });
    } catch (e) {}
    const keys = Object.keys(ov).sort();
    const chips = keys.map(k => {
      const [y, m] = k.split('-').map(Number);
      const oVal = ov[k], cVal = computed[k];
      const delta = (cVal != null) ? oVal - cVal : null;
      const dtxt = (delta != null && Math.abs(delta) > 0.5) ? ` (${delta > 0 ? '+' : '−'}${fmtMoneySmall(Math.abs(delta))})` : '';
      return `<span class="pf-chip">${MN[m-1]} ${y}: <strong>${fmtMoneySmall(oVal)}</strong>${dtxt}</span>`;
    }).join('');
    const n = keys.length;
    el.hidden = false;
    el.innerHTML = `<div class="pf-icon">⚖</div>
      <div class="pf-body">
        <div class="pf-title">${n} month${n===1?' was':'s were'} overridden in Revenue Projections — reconcile here.</div>
        <div class="pf-detail">These months are billed at a manual figure that no longer matches the computed schedule. Adjust staffing (expand the phase to edit by month) or the discount to make the computed fee match, then the override can be cleared.</div>
        <div class="pf-chips">${chips}</div>
      </div>
      <button class="pf-clear" id="pf-clear" type="button">Clear overrides</button>`;
    $('#pf-clear').addEventListener('click', () => {
      delete state.monthlyOverrides;
      renderProjFlag();
      markDirty();
    });
  }

  /** Show the intake button on Won/Active; re-flag if fee/schedule drifted since last intake. */
  /** Change-order banner: on a booked PARENT, offer "Process as change order"
      and show the revised-contract rollup; on a CO record, show the live delta
      vs. the contract it amends, plus Approve. */
  /** Differences-only summary for a CO: added / removed / changed roles. */
  function renderCoDiff() {
    if (!STORE.changeOrderRoleDiff) return '';
    const d = STORE.changeOrderRoleDiff(stateAsRecord());
    const bits = [];
    d.added.forEach(x => bits.push(`<span class="co-diff add">+ ${escapeHtml(x.label)} (${x.fteMonths.toFixed(1)} fte-mo)</span>`));
    d.removed.forEach(x => bits.push(`<span class="co-diff rem">− ${escapeHtml(x.label)} (${x.fteMonths.toFixed(1)} fte-mo)</span>`));
    d.changed.forEach(x => {
      const fteTxt = Math.abs(x.fteDelta) > 0.01 ? `${x.fteDelta > 0 ? '+' : '−'}${Math.abs(x.fteDelta).toFixed(1)} fte-mo` : '';
      const rateTxt = x.rateChanged ? 'rate' : '';
      bits.push(`<span class="co-diff chg">~ ${escapeHtml(x.label)}${(fteTxt || rateTxt) ? ' (' + [fteTxt, rateTxt].filter(Boolean).join(', ') + ')' : ''}</span>`);
    });
    if (!bits.length) return `<div class="co-diffs"><span class="co-diff none">No staffing changes yet — edit the matrix to build the change.</span></div>`;
    return `<div class="co-diffs"><div class="co-diffs-lbl">Differences from the contract</div>${bits.join('')}</div>`;
  }

  function updateChangeOrderBanner() {
    const banner = $('#co-banner');
    if (!banner || !STORE.createChangeOrder) return;
    const titleEl = $('#co-title'), detailEl = $('#co-detail'), actionsEl = $('#co-actions'), markEl = $('#co-mark');
    const isCO = !!(state.changeOrder && state.changeOrder.parentId);
    const booked = STORE.BOOKED_STATUSES.has(state.project.status);

    if (isCO) {
      // Viewing a change order.
      const parent = STORE.getProject(state.changeOrder.parentId);
      const parentName = (parent && parent.project && parent.project.name) || 'the original project';
      const delta = STORE.changeOrderDelta(stateAsRecord());
      const approved = state.project.status === 'active' && state.financials && !state.financials.stale;
      markEl.textContent = '⇄';
      titleEl.textContent = `Change Order ${state.changeOrder.coNumber} · amends ${parentName.replace(/ — CHANGE ORDER.*$/, '')}`;
      const cls = delta.net >= 0 ? 'co-delta-pos' : 'co-delta-neg';
      const sign = delta.net >= 0 ? '+' : '−';
      detailEl.innerHTML = `Incremental value <span class="${cls}"><strong>${sign}${fmtMoney(Math.abs(delta.net))}</strong></span>`
        + (delta.effectiveYM ? ` from <strong>${delta.effectiveYM}</strong>` : '')
        + ` · shares Salesforce ID <strong>${escapeHtml(state.project.salesforceId || '—')}</strong> with the parent.`
        + (approved ? ' <strong>Approved</strong> — rolled into the revised contract.' : ' Edit the staffing, then approve to roll it into the revised contract.')
        + renderCoDiff();
      actionsEl.innerHTML = approved
        ? `<a class="co-btn secondary" href="?id=${encodeURIComponent(state.changeOrder.parentId)}">View parent →</a>`
        : `<button class="co-btn" id="co-approve" type="button">Approve change order</button>`
          + `<a class="co-btn secondary" href="?id=${encodeURIComponent(state.changeOrder.parentId)}">View parent →</a>`;
      const ap = $('#co-approve');
      if (ap) ap.addEventListener('click', onApproveChangeOrder);
      banner.hidden = false;
      return;
    }

    if (booked && state.id && state.financials) {
      // Booked parent — show rollup if COs exist, offer to create one.
      const rc = STORE.revisedContract(state.id);
      const stale = state.financials.stale;
      markEl.textContent = stale ? '⚠' : '⇄';
      banner.classList.toggle('co-stale', !!stale);
      if (stale) {
        titleEl.textContent = 'Contract changed since it was booked — restamp or process a change order.';
        detailEl.innerHTML = `The staffing or assumptions no longer match the <strong>frozen contract</strong> (${fmtMoney(state.financials.net)}). Either <strong>restamp</strong> the booked figures to the current scope, or <strong>process a change order</strong> to capture the difference as a signed amendment.`;
        actionsEl.innerHTML = `<button class="co-btn" id="co-create" type="button">Process as change order →</button>`
          + `<button class="co-btn secondary" id="co-restamp" type="button">Restamp contract</button>`;
        const cb = $('#co-create'); if (cb) cb.addEventListener('click', onCreateChangeOrder);
        const rs = $('#co-restamp'); if (rs) rs.addEventListener('click', onRestampContract);
        banner.hidden = false;
        return;
      }
      titleEl.textContent = rc.coCount
        ? `Revised contract · ${fmtMoney(rc.revisedNet)}`
        : `Booked contract · ${fmtMoney(rc.baselineNet)}`;
      detailEl.innerHTML = rc.coCount
        ? `Original <strong>${fmtMoney(rc.baselineNet)}</strong> ${rc.coNetSum >= 0 ? '+' : '−'} ${rc.coCount} change order${rc.coCount === 1 ? '' : 's'} <strong>${fmtMoney(Math.abs(rc.coNetSum))}</strong> = <strong>${fmtMoney(rc.revisedNet)}</strong>. A change order amends this contract without touching the frozen original.`
        : `This contract is frozen for reporting. To revise scope, process a <strong>change order</strong> — it forks an editable copy, prices only the incremental change, and shares this project's Salesforce ID.`;
      actionsEl.innerHTML = `<button class="co-btn" id="co-create" type="button">Process as change order →</button>`;
      const cb = $('#co-create');
      if (cb) cb.addEventListener('click', onCreateChangeOrder);
      banner.hidden = false;
      return;
    }

    banner.hidden = true;
  }

  /** Shape current editor state as a record for STORE helpers. */
  function stateAsRecord() { return JSON.parse(JSON.stringify(state)); }

  function onCreateChangeOrder() {
    // Save the parent first so the contract baseline is current, then fork.
    saveToStore({ silent: true });
    const res = STORE.createChangeOrder(state.id);
    if (!res || res.error) { UFC_UI.toast(res && res.error || 'Could not create change order.'); return; }
    window.location.search = '?id=' + encodeURIComponent(res.co.id);
  }

  function onApproveChangeOrder() {
    if (!confirm('Approve this change order? Its figures freeze and roll into the revised contract.')) return;
    saveToStore({ silent: true });
    const res = STORE.approveChangeOrder(state.id);
    if (!res || res.error) { UFC_UI.toast(res && res.error || 'Could not approve.'); return; }
    window.location.reload();
  }

  function onRestampContract() {
    if (!confirm('Restamp the booked contract to the current scope? This refreshes the frozen figures and clears the changed flag.')) return;
    saveToStore({ silent: true });
    const res = STORE.restampFinancials(state.id);
    if (!res) { UFC_UI.toast('Could not restamp — check that the project is priced.'); return; }
    window.location.reload();
  }

  function updateIntakeButton() {
    const btn = $('#intake-btn');
    if (!btn || !window.UFC_Intake) return;
    const eligible = STORE.CO_ELIGIBLE_STATUSES.has(state.project.status);
    btn.style.display = eligible ? '' : 'none';
    if (!eligible) return;
    const sig = window.UFC_Intake.intakeSignature(state, netTotal());
    const drifted = state.intakeSnapshot && state.intakeSnapshot !== sig;
    btn.textContent = drifted ? '⚠ Re-submit Intake (changed) →' : 'Salesforce Intake →';
    btn.classList.toggle('intake-drift', !!drifted);
  }

  /** Booked-state callout: drives the intake action, owns SF ID visibility + "sent" confirmation. */
  function updateIntakeCallout() {
    const callout = $('#intake-callout');
    const sfRow = $('#sf-id-row');
    const eligible = STORE.CO_ELIGIBLE_STATUSES.has(state.project.status);
    if (sfRow) sfRow.hidden = !eligible;
    if (!callout) return;
    callout.hidden = !eligible;
    if (!eligible) return;

    const sent = !!state.project.intakeSent;
    const sig = window.UFC_Intake ? window.UFC_Intake.intakeSignature(state, netTotal()) : '';
    const drifted = !!(state.intakeSnapshot && sig && state.intakeSnapshot !== sig);
    const cb = $('#pm-intake-sent'); if (cb) cb.checked = sent;
    const mark = $('#ic-mark'), title = $('#ic-title'), detail = $('#ic-detail');

    if (sent && !drifted) {
      callout.classList.add('confirmed');
      if (mark) mark.textContent = '✓';
      if (title) title.textContent = 'Intake submitted for this booked project.';
      if (detail) detail.innerHTML = 'Logged as sent. Change the fee or schedule and you’ll be prompted to re-submit. Make sure the <strong>Salesforce ID</strong> below is filled in so reporting can link this project to Clockify.';
    } else {
      callout.classList.remove('confirmed');
      if (mark) mark.textContent = '⚑';
      if (drifted && sent) {
        if (title) title.textContent = 'Fee or schedule changed — re-submit the Salesforce intake.';
        if (detail) detail.innerHTML = 'Something changed since the last intake. Press <strong>⚠ Re-submit Intake →</strong> in the top bar, re-send the email, then re-confirm below — or process it as a change order.';
      } else {
        if (title) title.textContent = 'This project is booked — submit the Salesforce intake.';
        if (detail) detail.innerHTML = 'Press <strong>Salesforce Intake →</strong> in the top bar to generate the intake email, send it from your mailbox, then confirm below. Paste the <strong>Salesforce ID</strong> into the project record once the opportunity exists.';
      }
    }
  }

  /** Show the placeholder tick only where it can mean something.
      On booked work the dollars are contractual by definition, so the
      question doesn't arise and the field is hidden.

      This is DISPLAY ONLY — it never writes to the record. Clearing a
      stale flag here would mark a project dirty the instant you opened
      it, which reads as "someone changed something" when nobody did.
      Reads are already safe: STORE.isPlaceholder() refuses to call
      booked work a placeholder no matter what the field says. The
      rating handler does the actual cleanup, because that is the moment
      a human made the change. */
  function updatePlaceholderField() {
    const field = $('#ph-field'), hint = $('#ph-hint'), box = $('#pm-placeholder');
    if (!field || !box) return;
    const booked = STORE.ratingMeta(STORE.ratingFor(state)).booked;
    field.style.display = booked ? 'none' : '';
    if (hint) hint.style.display = booked ? 'none' : '';
    box.checked = !booked && !!state.project.placeholder;
  }

  function updateStatusRatingHints() {
    updateIntakeButton();
    updateIntakeCallout();
    updateChangeOrderBanner();
    const rh = $('#rating-hint');
    if (rh) rh.textContent = ratingGuidanceText(state.project.status);
    updatePlaceholderField();
    const sh = $('#status-hint');
    if (sh) {
      const aged = monthsSinceLastBilling() >= 2;   // last billing > ~60 days ago
      const liveish = STORE.CO_ELIGIBLE_STATUSES.has(state.project.status);
      if (aged && liveish) {
        sh.innerHTML = `Last billing was &gt;60 days ago — consider <strong>Closed out</strong>.`;
        sh.classList.add('warn');
      } else { sh.textContent = ''; sh.classList.remove('warn'); }
    }
  }

  /* ----- Pass-through / principal billing editor ----- */
  function renderPassthrough() {
    const pt = ptState();
    const on = $('#pt-on'), body = $('#pt-body');
    if (!on) return;
    on.checked = !!pt.enabled;
    if (body) body.hidden = !pt.enabled;
    if (!pt.enabled) return;
    const tb = $('#pt-lines');
    if (tb) {
      if (!pt.lines.length) {
        tb.innerHTML = `<tr class="pt-empty"><td colspan="6">No lines yet — add a vendor / pass-through cost below.</td></tr>`;
      } else {
        tb.innerHTML = pt.lines.map(l => {
          const cost = parseFloat(l.cost) || 0;
          const mk = parseFloat(l.markupPct) || 0;
          const mkAmt = cost * mk / 100;
          const managed = l.mode === 'managed';
          const clientBilled = managed ? mkAmt : cost + mkAmt;
          return `<tr data-id="${l.id}">
            <td class="pt-c-lbl"><input type="text" class="pt-label" data-id="${l.id}" value="${escapeHtml(l.label || '')}" placeholder="e.g. AV vendor — direct contract"></td>
            <td class="pt-c-type"><select class="pt-mode" data-id="${l.id}"><option value="billed" ${!managed ? 'selected' : ''}>Pass-through billed</option><option value="managed" ${managed ? 'selected' : ''}>Managed · direct bill</option></select></td>
            <td class="pt-c-num"><input type="text" inputmode="decimal" class="pt-cost" data-id="${l.id}" value="${cost || ''}" placeholder="0"></td>
            <td class="pt-c-num"><input type="text" inputmode="decimal" class="pt-mk" data-id="${l.id}" value="${l.markupPct != null && l.markupPct !== '' ? l.markupPct : ''}" placeholder="0"><span class="pt-pct">%</span></td>
            <td class="pt-c-num pt-ro pt-fee" data-id="${l.id}">${fmtMoney(mkAmt)}</td>
            <td class="pt-c-num pt-ro pt-client" data-id="${l.id}">${fmtMoney(clientBilled)}</td>
            <td class="pt-c-x"><button type="button" class="icon-btn pt-rm" data-id="${l.id}" title="Remove line">×</button></td>
          </tr>`;
        }).join('');
      }
    }
    const tot = $('#pt-totals');
    if (tot) {
      const c = ptCostTotal(), m = ptMarkupTotal(), cb = ptClientTotal();
      tot.innerHTML = `
        <span class="pt-t"><b>Cost passed through (out)</b> ${fmtMoney(c)}</span>
        <span class="pt-t"><b>Fee · Savills revenue</b> ${fmtMoney(m)}</span>
        <span class="pt-t pt-t-strong"><b>Client billed through Savills</b> ${fmtMoney(cb)}</span>`;
    }
    // wire line inputs — text/number inputs update state + derived cells IN PLACE
    // (never rebuild the rows on keystroke, or the focused field would deselect).
    $$('.pt-label').forEach(i => i.addEventListener('input', e => { const l = ptLines().find(x => x.id === e.target.dataset.id); if (l) { l.label = e.target.value; markDirty(); } }));
    $$('.pt-cost').forEach(i => i.addEventListener('input', e => { const l = ptLines().find(x => x.id === e.target.dataset.id); if (l) { l.cost = e.target.value; refreshPtLive(); } }));
    $$('.pt-mk').forEach(i => i.addEventListener('input', e => { const l = ptLines().find(x => x.id === e.target.dataset.id); if (l) { l.markupPct = e.target.value; refreshPtLive(); } }));
    $$('.pt-mode').forEach(s => s.addEventListener('change', e => { const l = ptLines().find(x => x.id === e.target.dataset.id); if (l) { l.mode = e.target.value; refreshPtLive(); } }));
    $$('.pt-rm').forEach(b => b.addEventListener('click', e => { const id = e.target.dataset.id; ptState().lines = ptLines().filter(x => x.id !== id); onPtChange(); }));
  }
  /** Recompute derived cells + totals + summary/monthly WITHOUT rebuilding the
      input rows, so the field being typed in keeps focus. */
  function refreshPtLive() {
    ptLines().forEach(l => {
      const cost = parseFloat(l.cost) || 0;
      const mkAmt = cost * (parseFloat(l.markupPct) || 0) / 100;
      const clientBilled = (l.mode === 'managed') ? mkAmt : cost + mkAmt;
      const feeCell = document.querySelector(`.pt-fee[data-id="${l.id}"]`);
      const cliCell = document.querySelector(`.pt-client[data-id="${l.id}"]`);
      if (feeCell) feeCell.textContent = fmtMoney(mkAmt);
      if (cliCell) cliCell.textContent = fmtMoney(clientBilled);
    });
    const tot = $('#pt-totals');
    if (tot) {
      const c = ptCostTotal(), m = ptMarkupTotal(), cb = ptClientTotal();
      tot.innerHTML = `
        <span class="pt-t"><b>Cost passed through (out)</b> ${fmtMoney(c)}</span>
        <span class="pt-t"><b>Fee · Savills revenue</b> ${fmtMoney(m)}</span>
        <span class="pt-t pt-t-strong"><b>Client billed through Savills</b> ${fmtMoney(cb)}</span>`;
    }
    renderSummary(); renderMonthly(); if (typeof updateNteHint === 'function') updateNteHint(); markDirty();
  }
  function onPtChange() { renderPassthrough(); renderSummary(); renderMonthly(); if (typeof updateNteHint === 'function') updateNteHint(); markDirty(); }
  function wirePassthrough() {
    const on = $('#pt-on');
    if (on) on.addEventListener('change', e => { ptState().enabled = e.target.checked; if (e.target.checked && !ptLines().length) ptState().lines.push({ id: uid(), label: '', cost: '', markupPct: '' }); onPtChange(); });
    const add = $('#pt-add');
    if (add) add.addEventListener('click', () => { ptState().lines.push({ id: uid(), label: '', cost: '', markupPct: '' }); onPtChange(); });
  }

  /* ----- Summary ----- */
  function renderSummary() {
    const gross = grossTotal();
    const lock = lockCredit();
    const disc = discountAmt();
    const net = gross - lock - disc;
    if (typeof updateNteHint === 'function') updateNteHint();
    $('#sum-fte').innerHTML = `${totalFteMonths().toFixed(1)}<span class="unit">fte-mo</span>`;
    $('#sum-gross').textContent = fmtMoney(gross);
    $('#sum-lock').textContent = fmtMoney(-lock);
    $('#sum-discount').textContent = fmtMoney(-disc);
    // Imported project with no staffing yet: show the imported total as the
    // headline (the number we're bridging to) instead of a calculated $0.
    const imp = state.source && state.source.importedByMonth && !state.source.reconciled;
    const impTotal = imp ? Object.values(state.source.importedByMonth).reduce((a, b) => a + (+b || 0), 0) : 0;
    if (imp && net === 0) {
      $('#sum-total').innerHTML = `${fmtMoney(impTotal)}<span class="unit" style="display:block;font-size:11px;color:var(--sav-teal);">imported · build staffing to reconcile</span>`;
    } else {
      // "What the client pays": with an on-top fee share that is the bill, not the net.
      $('#sum-total').textContent = fmtMoney(clientBillTotal());
    }
    $('#sum-discount-pct').textContent = `${state.assumptions.discount}% client discount — applied at total.`;
    $('#sum-lock-detail').textContent = state.assumptions.rateLock
      ? `Active — start-year rate held through ${state.timeline.endYear}.`
      : 'Off — escalation applied normally.';
    $('#sum-lock-card').classList.toggle('is-active', state.assumptions.rateLock);
  }

  /* ----- Cost-rate floor banner + export gating ----- */
  function renderFloorCheck() {
    const banner = $('#floor-banner');
    const viols = floorViolations();
    const xlsxBtn = $('#xlsx-btn');
    const printBtn = $('#print-btn');
    const hasViol = viols.length > 0;

    if (banner) {
      if (hasViol) {
        const names = viols.map(r => {
          const t = getTitle(r.titleId);
          const pr = (r.projectRole || '').trim();
          const who = (r.resource || '').trim();
          const label = pr || (t ? t.name : 'Role');
          return escapeHtml(label + (who ? ` (${who})` : ''));
        });
        banner.hidden = false;
        banner.innerHTML = `
          <div class="fb-icon">⚠</div>
          <div class="fb-body">
            <div class="fb-title">${viols.length} role${viols.length === 1 ? ' is' : 's are'} included at a potentially unprofitable rate.</div>
            <div class="fb-detail">The effective rate (discount included) sits below the Col E / Col G cost rate for: <strong>${names.join(', ')}</strong>. This is allowed — the schedule will still export — but margin on these roles may be thin or negative. Raise the tier or reduce the client discount to clear the flag.</div>
          </div>`;
      } else {
        banner.hidden = true;
        banner.innerHTML = '';
      }
    }
    // Below-floor is advisory only — never blocks export.
    if (xlsxBtn) { xlsxBtn.disabled = false; xlsxBtn.title = ''; }
    if (printBtn) { printBtn.disabled = false; printBtn.title = ''; }
  }

  /* ----- Matrix ----- */
  let expandedPhases = new Set();

  /* Allocation entry unit — a DISPLAY-ONLY preference. The stored data is always
     % FTE; hours are just a converted view (hours = % × hrsPerMo / 100). Persisted
     per-browser, never written into the project record, so engines/exports/snapshots
     are untouched. Calculator page only. */
  let matrixUnit = 'percent';
  try { const u = localStorage.getItem('ufc_matrix_unit'); if (u === 'hours' || u === 'percent') matrixUnit = u; } catch (e) {}
  const hrsPerMo = () => state.assumptions.hrsPerMo || STORE.PRICING_HOURS_PER_MONTH;
  /** % → displayed cell value (rounded to 0.1) in the current unit. */
  const pctToUnit = (pct) => matrixUnit === 'hours' ? Math.round((pct / 100) * hrsPerMo() * 10) / 10 : pct;
  /** entered cell value (current unit) → stored % (rounded to 0.1). */
  const unitToPct = (val) => {
    if (matrixUnit !== 'hours') return val;
    const h = hrsPerMo() || STORE.PRICING_HOURS_PER_MONTH;
    return Math.round((val / h) * 100 * 10) / 10;
  };
  const unitSuffix = () => matrixUnit === 'hours' ? 'h' : '%';
  const unitStep = () => matrixUnit === 'hours' ? 5 : 5;
  const unitMax = () => matrixUnit === 'hours' ? Math.round(hrsPerMo() * 2) : 200;

  /** Flat list of matrix columns: a phase, or (if expanded) its months. */
  function matrixColumns() {
    const cols = [];
    state.phases.forEach(p => {
      if (expandedPhases.has(p.id)) {
        const months = getMonthsByPhase().find(x => x.phase.id === p.id)?.months || [];
        months.forEach(m => cols.push({ type: 'month', phase: p, month: m, key: monthKey(m) }));
      } else {
        cols.push({ type: 'phase', phase: p });
      }
    });
    return cols;
  }
  function renderMatrix() {
    const tbody = $('#matrix-tbody');
    const thead = $('#matrix-thead');
    if (!state.roles.length) {
      thead.innerHTML = '';
      tbody.innerHTML = `<tr><td class="empty-matrix" colspan="3">Add roles from the catalog above to build the matrix.</td></tr>`;
      return;
    }
    // Header
    let hdr = `<tr>
      <th class="role-col">Role · Resource</th>`;
    const cols = matrixColumns();
    state.phases.forEach(p => {
      if (expandedPhases.has(p.id)) {
        const months = getMonthsByPhase().find(x => x.phase.id === p.id)?.months || [];
        hdr += `<th class="ph-grouphead" colspan="${months.length}"><span class="ph-toggle" data-toggle="${p.id}" title="Collapse to phase">▾</span> ${escapeHtml(p.name)} <span class="months">${p.length} mo · by month</span></th>`;
      } else {
        const slice = getMonthsByPhase().find(x => x.phase.id === p.id)?.months || [];
        const range = slice.length ? `${slice[0].label}${slice.length > 1 ? ' – ' + slice[slice.length-1].label : ''}` : '—';
        const wk = (p.weeks != null) ? `${p.weeks} wk · ` : '';
        const tgt = (p.targetFee != null) ? `<span class="ph-target" title="Stated fee from the proposal — reference only">target ${fmtMoneySmall(p.targetFee)}</span>` : '';
        const canExpand = p.length > 1 ? `<span class="ph-toggle" data-toggle="${p.id}" title="Expand into months">▸</span>` : '';
        hdr += `<th>${canExpand} ${escapeHtml(p.name)}<span class="sub">${range}</span><span class="months">${wk}${p.length} mo</span>${tgt}</th>`;
      }
    });
    hdr += `<th class="fee-col">Role total</th></tr>`;
    // Second header row with month labels for expanded phases
    if (cols.some(c => c.type === 'month')) {
      let sub = `<tr class="month-subhead"><th class="role-col"></th>`;
      cols.forEach(c => {
        sub += c.type === 'month' ? `<th class="mcol ${isCurrentMonth(c.month) ? 'today' : ''} ${isPastMonth(c.month) ? 'past' : ''}">${isCurrentMonth(c.month) ? '<span class="today-tag">CURRENT</span>' : ''}${c.month.label}</th>` : `<th></th>`;
      });
      sub += `<th></th></tr>`;
      hdr += sub;
    }
    thead.innerHTML = hdr;

    tbody.innerHTML = '';
    // Group rows by group
    state.groups.forEach(g => {
      const rolesInGroup = state.roles.filter(r => r.groupId === g.id);
      if (!rolesInGroup.length) return;
      const ghdr = document.createElement('tr');
      ghdr.className = 'group-head';
      const span = groupActiveSpan(g.id);
      const spanLbl = span
        ? `<span class="gh-span" title="Active window for this scope — earliest to latest month with staffing">${escapeHtml(span.label)} · ${span.months} mo</span>`
        : '';
      const shiftCtl = span
        ? `<span class="gh-shift" title="Slide this whole scope's staffing earlier or later — use when a milestone slips">
             <button class="gh-shift-btn" data-shift="${g.id}" data-delta="-1" title="Shift 1 month earlier">◀</button>
             <span class="gh-shift-lbl">shift</span>
             <button class="gh-shift-btn" data-shift="${g.id}" data-delta="1" title="Shift 1 month later">▶</button>
           </span>`
        : '';
      ghdr.innerHTML = `<td colspan="${matrixColumns().length + 2}"><span class="gh-name">${escapeHtml(g.name)}</span>${spanLbl}${shiftCtl}</td>`;
      tbody.appendChild(ghdr);
      rolesInGroup.forEach(r => {
        const title = getTitle(r.titleId);
        const tier = getTier(r.titleId, r.tierId);
        const tr = document.createElement('tr');
        tr.dataset.rid = r.id;
        const viol = roleFloorViolation(r);
        if (viol) tr.className = 'row-violation';
        const projRole = (r.projectRole || '').trim();
        const staffName = title?.name || '—';
        const headline = projRole || staffName;                 // bold top = the project role you typed
        const subBits = [];
        if (projRole) subBits.push(staffName);                  // staff title moves to the line below
        subBits.push(r.resource || 'TBD');
        let html = `<td class="role">
          <div class="role-name">${escapeHtml(headline)}<span class="role-tier">${escapeHtml(tier?.label || '')}</span></div>
          <div class="role-resource">${escapeHtml(subBits.join(' · '))}${viol ? ' <span class="role-floor-flag">below cost</span>' : ''}</div>
        </td>`;
        state.phases.forEach(p => {
          if (expandedPhases.has(p.id)) {
            const months = getMonthsByPhase().find(x => x.phase.id === p.id)?.months || [];
            months.forEach(m => {
              const mk = monthKey(m);
              const v = (r.fteMonthly && r.fteMonthly[mk] != null) ? r.fteMonthly[mk] : (r.fte[p.id] || 0);
              const isNTE = state.assumptions.feeBasis === 'nte';
              const past = isPastMonth(m), today = isCurrentMonth(m);
              const lockCell = isNTE && past;   // NTE: past months lock as actuals
              html += `<td class="fte mcol ${v === 0 ? 'zero' : ''} ${today ? 'today' : ''} ${past ? 'past' : ''} ${lockCell ? 'actual-locked' : ''}">
                <input type="number" data-role="${r.id}" data-month="${mk}" data-phase="${p.id}" value="${pctToUnit(v)}" min="0" max="${unitMax()}" step="${unitStep()}" ${lockCell ? 'title="Past month — actual (NTE)"' : ''}>${unitSuffix()}
              </td>`;
            });
          } else {
            const v = phaseAvgFte(r, p.id);
            html += `<td class="fte ${v === 0 ? 'zero' : ''}">
              <input type="number" data-role="${r.id}" data-phase="${p.id}" value="${pctToUnit(v)}" min="0" max="${unitMax()}" step="${unitStep()}">${unitSuffix()}
            </td>`;
          }
        });
        const rt = roleTotal(r);
        html += `<td class="fee role-fee ${rt === 0 ? 'zero' : ''}">${fmtMoneySmall(rt)}</td>`;
        tr.innerHTML = html;
        tbody.appendChild(tr);
      });
    });

    appendMatrixSubtotals(tbody);

    // Wire FTE inputs — update state + derived cells WITHOUT rebuilding the
    // inputs (rebuilding steals focus and limits you to one keystroke).
    $$('#matrix-tbody input[data-role][data-phase]').forEach(i => {
      i.addEventListener('input', e => {
        const role = state.roles.find(r => r.id === e.target.dataset.role);
        const val = unitToPct(parseFloat(e.target.value) || 0);   // entered unit → stored %
        const mk = e.target.dataset.month;
        if (role && mk) {
          // Per-month edit. FIRST pin every month in this phase to its current
          // effective value (explicit overrides), so changing ONE month never
          // drags the others toward an average. Then apply just this month.
          role.fteMonthly = role.fteMonthly || {};
          const phase = state.phases.find(p => p.id === e.target.dataset.phase);
          if (phase) {
            const months = getMonthsByPhase().find(x => x.phase.id === phase.id)?.months || [];
            months.forEach(m => {
              const k = monthKey(m);
              if (role.fteMonthly[k] == null) role.fteMonthly[k] = (role.fte[phase.id] || 0);
            });
          }
          role.fteMonthly[mk] = val;                 // this month's new value
          // Phase cell now just DISPLAYS the calculated average of the months —
          // it no longer feeds the other months, so they stay put.
          if (phase) recomputePhaseAvg(role, phase);
        } else if (role) {
          // Phase-level edit is a SHORTCUT: broadcast the value to every month in
          // the phase (months are canonical), and mirror it as the phase display.
          const phaseId = e.target.dataset.phase;
          role.fteMonthly = role.fteMonthly || {};
          const months = getMonthsByPhase().find(x => x.phase.id === phaseId)?.months || [];
          months.forEach(m => { role.fteMonthly[monthKey(m)] = val; });
          role.fte[phaseId] = val;
        }
        const td = e.target.closest('td.fte');
        if (td) td.classList.toggle('zero', !(val > 0));
        refreshMatrixDerived(e.target.dataset.role);
        renderSummary(); renderMonthly();
        markDirty();
      });
      i.addEventListener('focus', e => e.target.select());
    });
    // Expand / collapse phase columns
    $$('#matrix-thead .ph-toggle').forEach(t => t.addEventListener('click', e => {
      const pid = e.target.dataset.toggle;
      if (expandedPhases.has(pid)) expandedPhases.delete(pid); else expandedPhases.add(pid);
      renderMatrix();
    }));
    // Option A: slide a whole scope's staffing when a milestone slips
    $$('#matrix-tbody .gh-shift-btn').forEach(b => b.addEventListener('click', e => {
      shiftGroupMonths(e.currentTarget.dataset.shift, parseInt(e.currentTarget.dataset.delta, 10));
    }));
  }

  /** Wire the % FTE ↔ Hours unit toggle (once, on boot). */
  function wireUnitToggle() {
    const wrap = $('#unit-toggle');
    if (!wrap) return;
    $$('.unit-opt', wrap).forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.unit === matrixUnit);
      btn.addEventListener('click', () => {
        if (matrixUnit === btn.dataset.unit) return;
        matrixUnit = btn.dataset.unit;
        try { localStorage.setItem('ufc_matrix_unit', matrixUnit); } catch (e) {}
        $$('.unit-opt', wrap).forEach(b => b.classList.toggle('is-active', b.dataset.unit === matrixUnit));
        renderMatrix();
      });
    });
  }

  /** Recompute the editable matrix's derived cells (role totals + all
      subtotal rows) in place, leaving the FTE <input>s untouched. */
  function refreshMatrixDerived(changedRoleId) {
    const tbody = $('#matrix-tbody');
    if (!tbody) return;
    if (changedRoleId) {
      const row = tbody.querySelector(`tr[data-rid="${changedRoleId}"]`);
      const role = state.roles.find(r => r.id === changedRoleId);
      if (row && role) {
        const cell = row.querySelector('.role-fee');
        const rt = roleTotal(role);
        if (cell) { cell.textContent = fmtMoneySmall(rt); cell.classList.toggle('zero', rt === 0); }
        const viol = roleFloorViolation(role);
        row.classList.toggle('row-violation', viol);
      }
    }
    // Rebuild the (input-free) subtotal + grand-total rows.
    tbody.querySelectorAll('tr.subtotal, tr.grand-total').forEach(el => el.remove());
    appendMatrixSubtotals(tbody);
  }

  /** Append the FTE / gross / credit / net / grand-total summary rows. */
  function colFteSum(col) {
    if (col.type === 'month') return state.roles.reduce((s, r) => s + effectiveFte(r, col.month, col.phase.id) / 100, 0);
    return state.roles.reduce((s, r) => s + phaseAvgFte(r, col.phase.id) / 100, 0);
  }
  function colGross(col) {
    if (col.type === 'month') return state.roles.reduce((s, r) => s + monthlyFee(r, col.month, col.phase.id), 0);
    return phaseTotal(col.phase);
  }
  function colLockCredit(col) {
    if (col.type === 'month') return state.roles.reduce((s, r) => s + monthlyLockCredit(r, col.month, col.phase.id), 0);
    return phaseLockCredit(col.phase);
  }
  function appendMatrixSubtotals(tbody) {
    const cols = matrixColumns();
    const discPct = state.assumptions.discount || 0;
    // FTEs
    const trFte = document.createElement('tr');
    trFte.className = 'subtotal';
    let fteHtml = `<td class="role">Total FTEs</td>`;
    cols.forEach(c => { fteHtml += `<td>${colFteSum(c).toFixed(1)}</td>`; });
    fteHtml += `<td class="fee">${totalFteMonths().toFixed(1)} fte-mo</td>`;
    trFte.innerHTML = fteHtml;
    tbody.appendChild(trFte);

    // Gross
    const trGross = document.createElement('tr');
    trGross.className = 'subtotal';
    let grossHtml = `<td class="role">${cols.some(c=>c.type==='month') ? 'Month' : 'Phase'} fee · gross (published)</td>`;
    cols.forEach(c => { grossHtml += `<td>${fmtMoneySmall(colGross(c))}</td>`; });
    grossHtml += `<td class="fee">${fmtMoneySmall(grossTotal())}</td>`;
    trGross.innerHTML = grossHtml;
    tbody.appendChild(trGross);

    // Rate Lock
    if (state.assumptions.rateLock && lockCredit() > 0.5) {
      const trLock = document.createElement('tr');
      trLock.className = 'subtotal credit';
      let lockHtml = `<td class="role">Less Rate Lock (waive escalation)</td>`;
      cols.forEach(c => { const v = colLockCredit(c); lockHtml += `<td>${v > 0.5 ? '−' + fmtMoneySmall(v) : '—'}</td>`; });
      lockHtml += `<td class="fee">−${fmtMoneySmall(lockCredit())}</td>`;
      trLock.innerHTML = lockHtml;
      tbody.appendChild(trLock);
    }

    // Discount
    if (discPct > 0) {
      const trDisc = document.createElement('tr');
      trDisc.className = 'subtotal credit';
      let discHtml = `<td class="role">Less ${discPct}% client discount</td>`;
      cols.forEach(c => { const d = colGross(c) * (discPct / 100); discHtml += `<td>${d > 0.5 ? '−' + fmtMoneySmall(d) : '—'}</td>`; });
      discHtml += `<td class="fee">−${fmtMoneySmall(discountAmt())}</td>`;
      trDisc.innerHTML = discHtml;
      tbody.appendChild(trDisc);
    }

    // Net
    if (state.assumptions.rateLock || discPct > 0) {
      const trNet = document.createElement('tr');
      trNet.className = 'subtotal';
      let netHtml = `<td class="role">${cols.some(c=>c.type==='month') ? 'Month' : 'Phase'} fee · net (after credits)</td>`;
      cols.forEach(c => { const g = colGross(c); netHtml += `<td>${fmtMoneySmall(g - colLockCredit(c) - g * (discPct / 100))}</td>`; });
      netHtml += `<td class="fee">${fmtMoneySmall(netTotal())}</td>`;
      trNet.innerHTML = netHtml;
      tbody.appendChild(trNet);
    }

    // Grand total
    const trGrand = document.createElement('tr');
    trGrand.className = 'grand-total';
    const parts = [];
    if (state.assumptions.rateLock) parts.push('Rate Lock');
    if (discPct > 0) parts.push(`${discPct}% discount`);
    const label = parts.length
      ? `Total proposed fee · NET (after ${parts.join(' + ')})`
      : `Total proposed fee · published rates`;
    let gHtml = `<td class="role">${label}</td>`;
    for (let i = 0; i < matrixColumns().length; i++) gHtml += `<td>&nbsp;</td>`;
    gHtml += `<td class="fee">${fmtMoney(netTotal())}</td>`;
    trGrand.innerHTML = gHtml;
    tbody.appendChild(trGrand);
  }

  /* ----- Monthly schedule ----- */
  let monthlyMode = 'bottom';   // 'bottom' = discount as credit line · 'spread' = net baked into each month

  /** Reflect billingMode on the toggle buttons + hide the discount-view toggle when flatlined. */
  function syncBillingToggle() {
    const mode = state.assumptions.billingMode || 'phase';
    $$('.bm-btn').forEach(x => x.classList.toggle('on', x.dataset.bm === mode));
    const dt = $('#disc-toggle');
    if (dt) dt.style.display = (mode === 'flatline') ? 'none' : '';
  }

  /** Sync the fee-share control to state + enable/disable the % input. */
  function syncFeeShare() {
    const fs = state.assumptions.feeShare || { enabled: false, pct: 10, mode: 'offtop' };
    const on = $('#fs-on'), pct = $('#fs-pct'), ctl = $('#fee-share-ctl');
    if (on) on.checked = !!fs.enabled;
    if (pct && document.activeElement !== pct) pct.value = fs.pct != null ? fs.pct : 10;
    if (pct) pct.disabled = !fs.enabled;
    if (ctl) ctl.classList.toggle('is-on', !!fs.enabled);
    // Mode segmented buttons
    const mode = feeShareMode();
    const offBtn = $('#fsm-offtop'), onBtn = $('#fsm-ontop'), modeWrap = $('#fs-mode-wrap');
    if (offBtn) offBtn.classList.toggle('on', mode === 'offtop');
    if (onBtn) onBtn.classList.toggle('on', mode === 'ontop');
    if (modeWrap) modeWrap.style.opacity = fs.enabled ? '' : '0.4';
    // Effective-% readout: on-top markups net to a lower share of the (bigger) invoice.
    const eff = $('#fs-eff');
    if (eff) {
      if (!fs.enabled) { eff.textContent = 'to broker'; }
      else if (mode === 'ontop') { eff.innerHTML = `added on top · <strong>${(effectiveBrokerPct()).toFixed(1)}%</strong> of invoice`; }
      else { eff.innerHTML = `off invoice · client pays the fee`; }
    }
  }

  /** Append broker + revenue reconciliation rows under a monthly grand-total.
      The grand "Total proposed fee" row above is the client-facing number
      (on-top: grossed up incl. broker; off-top: the fee). Both modes then show
      the broker coming OUT to reach Savills revenue. */
  /** Reconciliation rows under the monthly grand total. `baseNet` = the PPM fee
      (what Savills earns). Layout depends on mode:
        • billed on-top (invoice column present): net the broker OUT of the invoice
          column → PPM revenue.
        • bottom on-top (no invoice column): ADD the broker markup → client invoice.
        • off-top (either view): net the broker OUT of the billed column → revenue. */
  function appendFeeShareRows(tbody, visibleGroups, baseNet, onTop, showInvoiceCol) {
    if (!feeShareOn()) return;
    const N = visibleGroups.length;
    const share = baseNet * (feeSharePct() / 100);
    const fs = document.createElement('tr'); fs.className = 'credit-row fee-share-row';
    const rev = document.createElement('tr'); rev.className = 'total grand revenue-row';
    if (showInvoiceCol) {
      // value sits in the rightmost (Invoice) column
      fs.innerHTML = `<td class="month-col">Less ${feeSharePct()}% broker fee</td><td colspan="${N}"></td><td></td><td class="bk-col"></td><td class="bk-col inv-col">${fmtMoney(-share)}</td>`;
      rev.innerHTML = `<td class="month-col">PPM revenue · net of broker</td><td colspan="${N}"></td><td></td><td class="bk-col"></td><td class="bk-col inv-col">${fmtMoney(baseNet)}</td>`;
    } else if (onTop) {
      // bottom-mode on-top: build up to the client invoice
      fs.innerHTML = `<td class="month-col">Plus ${feeSharePct()}% broker markup · on top</td><td colspan="${N}"></td><td>${fmtMoney(share)}</td><td class="bk-col"></td>`;
      rev.innerHTML = `<td class="month-col">Client invoice · incl. broker</td><td colspan="${N}"></td><td>${fmtMoney(baseNet + share)}</td><td class="bk-col"></td>`;
    } else {
      fs.innerHTML = `<td class="month-col">Less ${feeSharePct()}% fee share · broker</td><td colspan="${N}"></td><td>${fmtMoney(-share)}</td><td class="bk-col"></td>`;
      rev.innerHTML = `<td class="month-col">Revenue · net of fee share</td><td colspan="${N}"></td><td>${fmtMoney(baseNet - share)}</td><td class="bk-col"></td>`;
    }
    tbody.appendChild(fs);
    tbody.appendChild(rev);
  }

  /** Pass-through reconciliation rows under the monthly grand total. Shown whenever
      pass-through is on. Builds on the client-facing fee number: + cost (to vendor)
      + markup (Savills revenue) = total client contract; then Savills net revenue.
      Values are whole-project totals in the value column (mirrors the broker rows). */
  function appendPassThroughRows(tbody, visibleGroups, columnShown) {
    if (!ptOn()) return;
    const bk = feeShareOn();
    const showInvoiceCol = bk && feeShareMode() === 'ontop';
    const N = visibleGroups.length + (columnShown ? 1 : 0);
    const cost = ptCostTotal(), markup = ptMarkupTotal();
    const feeClient = clientBillTotal();
    const feeRev = revenueTotal();
    const cells = (val) => {
      if (showInvoiceCol) return `<td colspan="${N}"></td><td></td><td class="bk-col"></td><td class="bk-col inv-col">${fmtMoney(val)}</td>`;
      if (bk) return `<td colspan="${N}"></td><td>${fmtMoney(val)}</td><td class="bk-col"></td>`;
      return `<td colspan="${N}"></td><td>${fmtMoney(val)}</td>`;
    };
    // When the pass-through COLUMN is shown, the grand total already folds in the
    // client-billed pass-through — so just break out the vendor cost and Savills revenue.
    const rows = columnShown
      ? [
          ['credit-row pt-row',       'of which pass-through cost · to vendor (flows out)', -cost],
          ['total grand revenue-row', 'Savills net revenue · fee + markup',                feeRev + markup],
        ]
      : [
          ['credit-row pt-row',       'Plus pass-through cost · to vendor',         cost],
          ['credit-row pt-row',       'Plus pass-through markup · Savills revenue', markup],
          ['total grand pt-contract', 'Total client contract · incl. pass-through', feeClient + cost + markup],
          ['total grand revenue-row', 'Savills net revenue · incl. markup',         feeRev + markup],
        ];
    rows.forEach(([cls, label, val]) => {
      const tr = document.createElement('tr'); tr.className = cls;
      tr.innerHTML = `<td class="month-col">${label}</td>${cells(val)}`;
      tbody.appendChild(tr);
    });
  }

  function renderMonthly() {
    const thead = $('#monthly-thead');
    const tbody = $('#monthly-tbody');
    syncBillingToggle();
    syncFeeShare();
    const months = getMonths();
    if (!months.length || (!state.roles.length && !ptOn())) {
      thead.innerHTML = '';
      tbody.innerHTML = `<tr><td class="empty-matrix" colspan="3">Add roles (or a pass-through line) + a valid timeline to see the monthly schedule.</td></tr>`;
      return;
    }
    const d = (state.assumptions.discount || 0) / 100;
    const flat = state.assumptions.billingMode === 'flatline';
    const spread = !flat && monthlyMode === 'spread' && d > 0;

    // Broker columns (only when fee share is on).
    const bk = feeShareOn();
    const bkPct = feeSharePct() / 100;
    const onTop = feeShareMode() === 'ontop';
    const billed = flat || spread;
    // The 3rd "Invoice amount" column appears only for on-top in the billed views
    // (flatline/spread). Bottom mode keeps its gross→net waterfall + broker column.
    const showInvoiceCol = bk && onTop;
    // per-row trailing cells; n = the PPM (base) billed amount for that row
    const bkRow = (n) => {
      if (!bk) return '';
      const b = n * bkPct;
      let s = `<td class="bk-col">${b ? fmtMoneySmall(b) : ''}</td>`;
      if (showInvoiceCol) s += `<td class="bk-col inv-col">${fmtMoneySmall(n + b)}</td>`;
      return s;
    };
    // broker total with an EMPTY invoice cell — for gross / pre-discount rows in bottom mode
    const bkTotNoInv = (n) => {
      if (!bk) return '';
      const b = n * bkPct;
      return `<td class="bk-col"><strong>${fmtMoney(b)}</strong></td>` + (showInvoiceCol ? '<td class="bk-col inv-col"></td>' : '');
    };
    // bold total-row trailing cells
    const bkTot = (n) => {
      if (!bk) return '';
      const b = n * bkPct;
      let s = `<td class="bk-col"><strong>${fmtMoney(b)}</strong></td>`;
      if (showInvoiceCol) s += `<td class="bk-col inv-col"><strong>${fmtMoney(n + b)}</strong></td>`;
      return s;
    };
    const nBk = bk ? (showInvoiceCol ? 2 : 1) : 0;
    const emptyBk = bk ? ('<td class="bk-col"></td>' + (showInvoiceCol ? '<td class="bk-col inv-col"></td>' : '')) : '';

    // Pass-through billed as its own column (client-billed cost + markup per month).
    const pt = ptOn();
    const ptMap = pt ? ptBilledMap() : {};
    const ptBilledTotal = pt ? Object.values(ptMap).reduce((a, b) => a + b, 0) : 0;
    const nPt = pt ? 1 : 0;
    const ptCell = (m) => pt ? `<td class="pt-col">${fmtMoneySmall(ptMap[m.year + '-' + m.month] || 0)}</td>` : '';
    const ptGap = pt ? '<td class="pt-col"></td>' : '';

    // header: Month + each group + [Pass-through] + main total (+ Broker [+ Invoice])
    let hdr = `<tr><th class="month-col">Month</th>`;
    state.groups.forEach(g => {
      const has = state.roles.some(r => r.groupId === g.id);
      if (has) hdr += `<th>${escapeHtml(g.name)}</th>`;
    });
    if (pt) hdr += `<th class="pt-col" title="Client-billed pass-through · vendor cost + markup">Pass-through</th>`;
    const mainLbl = !bk ? `Monthly ${billed ? 'billed' : 'total'}`
      : (showInvoiceCol && billed ? 'Monthly PPM billed' : (billed ? 'Monthly billed' : 'Monthly total'));
    hdr += `<th>${mainLbl}</th>`;
    if (bk) {
      hdr += `<th class="bk-col" title="Dollar amount to the broker each month">Broker${onTop ? ' (on top)' : ''}</th>`;
      if (showInvoiceCol) hdr += `<th class="bk-col inv-col" title="What the client is invoiced = PPM fee + broker markup">Invoice amount</th>`;
    }
    hdr += `</tr>`;
    thead.innerHTML = hdr;

    tbody.innerHTML = '';
    const byPhase = getMonthsByPhase();
    let totalsByGroup = {};
    let grandGross = 0, grandNet = 0, grandNetForBroker = 0;
    state.groups.forEach(g => totalsByGroup[g.id] = 0);
    const visibleGroups = state.groups.filter(g => state.roles.some(r => r.groupId === g.id));
    const SPAN = visibleGroups.length + 2 + nBk + nPt;   // full-width colspan for caption/phase rows

    // ===== FLATLINE billing: net total ÷ months = even fixed monthly =====
    if (flat) {
      const net = netTotal();
      const monthCount = months.length;
      const flatMonthly = monthCount ? net / monthCount : 0;
      // Distribute each month's flat amount across groups by their share of resource-loaded gross.
      const groupGross = {};
      let totalGross = 0;
      visibleGroups.forEach(g => {
        let gg = 0;
        byPhase.forEach(bucket => bucket.months.forEach(m => {
          state.roles.filter(r => r.groupId === g.id).forEach(r => { gg += monthlyFee(r, m, bucket.phase.id); });
        }));
        groupGross[g.id] = gg; totalGross += gg;
      });

      const cap = document.createElement('tr');
      cap.className = 'spread-caption';
      cap.innerHTML = `<td colspan="${SPAN}">Flat monthly fee — net total ÷ ${monthCount} month${monthCount === 1 ? '' : 's'}. Resource loading drives the total; billing is levelized into equal monthly invoices.</td>`;
      tbody.appendChild(cap);

      byPhase.forEach(bucket => {
        if (!bucket.months.length) return;
        const phRow = document.createElement('tr');
        phRow.className = 'phase';
        phRow.innerHTML = `<td colspan="${SPAN}">${escapeHtml(bucket.phase.name)} · ${bucket.months.length} mo</td>`;
        tbody.appendChild(phRow);
        bucket.months.forEach(m => {
          const tr = document.createElement('tr');
          let html = `<td class="month-col">${m.label}</td>`;
          visibleGroups.forEach(g => {
            const share = totalGross > 0 ? groupGross[g.id] / totalGross : 1 / visibleGroups.length;
            const cell = flatMonthly * share;
            totalsByGroup[g.id] += cell;
            html += `<td>${fmtMoneySmall(cell)}</td>`;
          });
          const ptb = pt ? (ptMap[m.year + '-' + m.month] || 0) : 0;
          html += ptCell(m);
          html += `<td><strong>${fmtMoneySmall(flatMonthly + ptb)}</strong></td>`;
          html += bkRow(flatMonthly);
          tr.innerHTML = html;
          tbody.appendChild(tr);
        });
      });

      const sub = document.createElement('tr');
      sub.className = 'total';
      let subHtml = `<td class="month-col">Flat monthly fee</td>`;
      visibleGroups.forEach(g => { subHtml += `<td>${fmtMoneySmall(totalsByGroup[g.id] / (monthCount || 1))}</td>`; });
      const ptAvg = pt ? ptBilledTotal / (monthCount || 1) : 0;
      if (pt) subHtml += `<td class="pt-col">${fmtMoneySmall(ptAvg)}</td>`;
      subHtml += `<td>${fmtMoney(flatMonthly + ptAvg)}</td>`;
      subHtml += bkTot(flatMonthly);
      sub.innerHTML = subHtml;
      tbody.appendChild(sub);

      const tr = document.createElement('tr');
      tr.className = 'total grand';
      tr.innerHTML = `<td class="month-col">${pt ? 'Total client contract · incl. pass-through' : 'Total proposed fee'}</td><td colspan="${visibleGroups.length + nPt}"></td><td>${fmtMoney(net + (pt ? ptClientTotal() : 0))}</td>${bkTot(net)}`;
      tbody.appendChild(tr);
      appendFeeShareRows(tbody, visibleGroups, net, onTop, showInvoiceCol);
      appendPassThroughRows(tbody, visibleGroups, pt);
      return;
    }

    if (spread) {
      const cap = document.createElement('tr');
      cap.className = 'spread-caption';
      cap.innerHTML = `<td colspan="${SPAN}">Each month is net of the ${state.assumptions.discount}% client discount${state.assumptions.rateLock ? ' and Rate Lock credit' : ''} — what you actually invoice.</td>`;
      tbody.appendChild(cap);
    }

    if (!flat && !spread && bk && onTop) {
      const cap = document.createElement('tr');
      cap.className = 'spread-caption';
      cap.innerHTML = `<td colspan="${SPAN}">Rows show the gross monthly fee (pre-discount) for the audit trail. The <strong>Invoice amount</strong> column is the client's actual monthly bill — net of the ${state.assumptions.discount}% discount${state.assumptions.rateLock ? ' and Rate Lock credit' : ''}, plus the ${feeSharePct()}% broker markup on top.</td>`;
      tbody.appendChild(cap);
    }

    byPhase.forEach(bucket => {
      if (bucket.months.length) {
        const phRow = document.createElement('tr');
        phRow.className = 'phase';
        phRow.innerHTML = `<td colspan="${SPAN}">${escapeHtml(bucket.phase.name)} · ${bucket.months.length} mo</td>`;
        tbody.appendChild(phRow);
      }
      bucket.months.forEach(m => {
        const tr = document.createElement('tr');
        let html = `<td class="month-col">${m.label}</td>`;
        let monthTotal = 0, monthNet = 0;
        state.groups.forEach(g => {
          if (!state.roles.some(r => r.groupId === g.id)) return;
          const rolesInG = state.roles.filter(r => r.groupId === g.id);
          const gross = rolesInG.reduce((s, r) => s + monthlyFee(r, m, bucket.phase.id), 0);
          const lockC = rolesInG.reduce((s, r) => s + monthlyLockCredit(r, m, bucket.phase.id), 0);
          const netCell = gross * (1 - d) - lockC;   // true net billed this month for this group
          const cell = spread ? netCell : gross;
          totalsByGroup[g.id] += cell;
          monthTotal += cell;
          monthNet += netCell;
          grandGross += gross;
          html += `<td>${fmtMoneySmall(cell)}</td>`;
        });
        grandNet += monthTotal;
        grandNetForBroker += monthNet;
        const ptb = pt ? (ptMap[m.year + '-' + m.month] || 0) : 0;
        html += ptCell(m);
        html += `<td><strong>${fmtMoneySmall(monthTotal + ptb)}</strong></td>`;
        html += bkRow(monthNet);
        tr.innerHTML = html;
        tbody.appendChild(tr);
      });
    });

    const lock = lockCredit();
    const disc = grandGross * d;

    if (spread) {
      // Everything is baked in — show only the net billed subtotal + headline total.
      const sub = document.createElement('tr');
      sub.className = 'total';
      let subHtml = `<td class="month-col">Net billed subtotal</td>`;
      visibleGroups.forEach(g => { subHtml += `<td>${fmtMoneySmall(totalsByGroup[g.id])}</td>`; });
      if (pt) subHtml += `<td class="pt-col">${fmtMoneySmall(ptBilledTotal)}</td>`;
      subHtml += `<td>${fmtMoney(grandNet + (pt ? ptBilledTotal : 0))}</td>`;
      subHtml += bkTot(grandNetForBroker);
      sub.innerHTML = subHtml;
      tbody.appendChild(sub);

      const tr = document.createElement('tr');
      tr.className = 'total grand';
      tr.innerHTML = `<td class="month-col">${pt ? 'Total client contract · incl. pass-through' : 'Total proposed fee'}</td><td colspan="${visibleGroups.length + nPt}"></td><td>${fmtMoney(grandNet + (pt ? ptClientTotal() : 0))}</td>${bkTot(grandNet)}`;
      tbody.appendChild(tr);
      appendFeeShareRows(tbody, visibleGroups, grandNet, onTop, showInvoiceCol);
      appendPassThroughRows(tbody, visibleGroups, pt);
      return;
    }

    // ----- bottom mode: gross, then credits as lines -----
    const net = grandGross - lock - disc;
    const sub = document.createElement('tr');
    sub.className = 'total';
    let subHtml = `<td class="month-col">Gross subtotal</td>`;
    visibleGroups.forEach(g => { subHtml += `<td>${fmtMoneySmall(totalsByGroup[g.id])}</td>`; });
    if (pt) subHtml += `<td class="pt-col">${fmtMoneySmall(ptBilledTotal)}</td>`;
    subHtml += `<td>${fmtMoney(grandGross + (pt ? ptBilledTotal : 0))}</td>`;
    subHtml += bkTotNoInv(grandNetForBroker);
    sub.innerHTML = subHtml;
    tbody.appendChild(sub);

    if (state.assumptions.rateLock && lock > 0.5) {
      const lr = document.createElement('tr');
      lr.className = 'credit-row';
      lr.innerHTML = `<td class="month-col">Less Rate Lock credit</td><td colspan="${visibleGroups.length + nPt}"></td><td>${fmtMoney(-lock)}</td>${emptyBk}`;
      tbody.appendChild(lr);
    }
    if (state.assumptions.discount > 0) {
      const dr = document.createElement('tr');
      dr.className = 'credit-row';
      dr.innerHTML = `<td class="month-col">Less ${state.assumptions.discount}% client discount</td><td colspan="${visibleGroups.length + nPt}"></td><td>${fmtMoney(-disc)}</td>${emptyBk}`;
      tbody.appendChild(dr);
    }
    const tr = document.createElement('tr');
    tr.className = 'total grand';
    tr.innerHTML = `<td class="month-col">${pt ? 'Total client contract · incl. pass-through' : 'Total proposed fee'}</td><td colspan="${visibleGroups.length + nPt}"></td><td>${fmtMoney(net + (pt ? ptClientTotal() : 0))}</td>${bkTot(net)}`;
    tbody.appendChild(tr);
    appendFeeShareRows(tbody, visibleGroups, net, onTop, showInvoiceCol);
    appendPassThroughRows(tbody, visibleGroups, pt);
  }

  /* ============================================================
     EVENT WIRING — non-list controls
     ============================================================ */
  function wireControls() {
    wireUnitToggle();
    wireVersions();
    wirePassthrough();
    // Monthly schedule discount-view toggle
    $$('.mt-btn').forEach(b => b.addEventListener('click', () => {
      monthlyMode = b.dataset.mode;
      $$('.mt-btn').forEach(x => x.classList.toggle('on', x.dataset.mode === monthlyMode));
      renderMonthly();
    }));
    // Billing-mode toggle (saved with the project)
    $$('.bm-btn').forEach(b => b.addEventListener('click', () => {
      state.assumptions.billingMode = b.dataset.bm;
      syncBillingToggle();
      renderMonthly();
      markDirty();
    }));
    // Fee share (broker referral cut taken off the revenue side)
    const fsOn = $('#fs-on'), fsPct = $('#fs-pct');
    if (fsOn) fsOn.addEventListener('change', e => {
      state.assumptions.feeShare = state.assumptions.feeShare || { enabled: false, pct: 10, mode: 'offtop' };
      state.assumptions.feeShare.enabled = e.target.checked;
      syncFeeShare(); renderMonthly(); renderSummary(); markDirty();
    });
    if (fsPct) fsPct.addEventListener('input', e => {
      state.assumptions.feeShare = state.assumptions.feeShare || { enabled: false, pct: 10, mode: 'offtop' };
      state.assumptions.feeShare.pct = parseFloat(e.target.value) || 0;
      syncFeeShare(); renderMonthly(); renderSummary(); markDirty();
    });
    // Broker fee mode: off-invoice (default) vs on-top markup
    $$('.fsm-btn').forEach(b => b.addEventListener('click', () => {
      state.assumptions.feeShare = state.assumptions.feeShare || { enabled: false, pct: 10, mode: 'offtop' };
      if (!state.assumptions.feeShare.enabled) return;   // no-op until fee share is turned on
      state.assumptions.feeShare.mode = b.dataset.fsm;
      syncFeeShare(); renderMonthly(); renderSummary(); markDirty();
    }));
    // Reconcile to proposal
    const fitBtn = $('#fit-btn');
    if (fitBtn) fitBtn.addEventListener('click', fitToTarget);
    const fmT = $('#fm-toggle');
    if (fmT) fmT.addEventListener('click', () => {
      if (fmBlockReason() && fmBlockReason() !== 'importlock') return;   // locked: nothing to open
      fmOpen = !fmOpen;
      fmT.setAttribute('aria-expanded', String(fmOpen));
      if (fmOpen && !fmTargets) fmSeedTargets();
      renderFitMonth();
    });
    const fitInput = $('#fit-target');
    if (fitInput) {
      fitInput.addEventListener('input', e => {
        const n = parseFloat(String(e.target.value).replace(/[$,\s]/g, ''));
        fitTargetOverride = isNaN(n) ? null : n;
        renderReconcile();
      });
    }
    // Project meta
    $('#pm-name').addEventListener('input', e => {
      state.project.name = e.target.value;
      $('#hdr-project').textContent = state.project.name || 'Untitled project';
      markDirty();
    });
    $('#pm-client').addEventListener('input', e => {
      state.project.client = e.target.value;
      $('#hdr-client').textContent = e.target.value ? `for ${e.target.value}` : '';
      markDirty();
    });
    $('#pm-lead').addEventListener('change',  e => {
      const l = STORE.leaderById(e.target.value);
      state.project.leadId = l ? l.id : '';
      state.project.lead = l ? l.displayName : '';
      markDirty();
    });
    $('#pm-date').addEventListener('input',  e => { state.project.proposalDate = e.target.value; markDirty(); });
    $('#pm-location').addEventListener('input', e => { state.project.location = e.target.value; markDirty(); });
    { const nt = $('#pm-notes'); if (nt) nt.addEventListener('input', e => { state.project.notes = e.target.value; markDirty(); }); }
    $('#pm-status').addEventListener('change', e => {
      state.project.status = e.target.value;
      const statusLabel = STORE.STATUS_LABELS[e.target.value] || '';
      $('#hdr-status').innerHTML = statusLabel ? ` <span style="font-weight:700;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;padding:3px 8px;background:var(--sav-yellow);color:var(--sav-navy);margin-left:8px;">${statusLabel}</span>` : '';
      // Status drives a default projection rating (user can still override).
      const def = STORE.STATUS_DEFAULT_RATING[e.target.value];
      if (def) {
        state.project.rating = def;
        const rs = $('#pm-rating'); if (rs) rs.value = def;
      }
      updateStatusRatingHints();
      const lostField = $('#lost-reason-field');
      if (lostField) lostField.style.display = (e.target.value === 'lost') ? '' : 'none';
      markDirty();
    });
    const lostSelEl = $('#pm-lostReason');
    if (lostSelEl) lostSelEl.addEventListener('change', e => { state.project.lostReason = e.target.value; markDirty(); });
    $('#pm-industry').addEventListener('change', e => { state.project.industry = e.target.value; markDirty(); });
    const ptypeEl = $('#pm-ptype');
    if (ptypeEl) ptypeEl.addEventListener('change', e => { state.project.projectType = e.target.value; state.project.projectSubtypes = []; renderProjectTypeSubs(); markDirty(); });
    const accessInput = $('#pm-access');
    if (accessInput) accessInput.addEventListener('input', e => { state.project.accessGrant = e.target.value; markDirty(); try { renderWhoSees(); } catch (err) {} });
    const asmCustom = $('#pm-asm-custom');
    if (asmCustom) asmCustom.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const val = (e.target.value || '').trim();
      if (!val) return;
      const arr = Array.isArray(state.project.assumptionsList) ? state.project.assumptionsList.slice() : [];
      if (!arr.includes(val)) arr.push(val);
      state.project.assumptionsList = arr;
      e.target.value = '';
      renderAssumptions();
      markDirty();
    });
    const ratingSelEl = $('#pm-rating');
    if (ratingSelEl) ratingSelEl.addEventListener('change', e => {
      state.project.rating = parseInt(e.target.value) || null;
      /* Rating a project Booked settles the dollars question: they are
         contractual now. Drop any placeholder flag rather than leaving one
         behind on a record whose UI no longer shows it. */
      if (STORE.ratingMeta(STORE.ratingFor(state)).booked) delete state.project.placeholder;
      updateStatusRatingHints(); markDirty();
    });
    const phBox = $('#pm-placeholder');
    if (phBox) phBox.addEventListener('change', e => {
      if (e.target.checked) state.project.placeholder = true; else delete state.project.placeholder;
      markDirty();
    });
    $('#pm-firstProposal').addEventListener('input', e => { state.project.firstProposalDate = e.target.value; markDirty(); });
    $('#pm-signed').addEventListener('input', e => { state.project.signedContractDate = e.target.value; markDirty(); });
    const sfidInput = $('#pm-sfid');
    if (sfidInput) sfidInput.addEventListener('input', e => { state.project.salesforceId = e.target.value; markDirty(); });
    const intakeSentInput = $('#pm-intake-sent');
    if (intakeSentInput) intakeSentInput.addEventListener('change', e => { state.project.intakeSent = e.target.checked; updateIntakeCallout(); markDirty(); });
    $('#pm-clientContact').addEventListener('input', e => { state.project.clientContact = e.target.value; markDirty(); });
    $('#pm-clientRel').addEventListener('change', e => {
      const l = STORE.leaderById(e.target.value);
      state.project.clientRelOwner = l ? l.displayName : '';
      state.project.clientRelOwnerId = l ? l.id : '';
      markDirty();
    });

    // Timeline
    const tlChange = () => {
      const sy = parseInt($('#tl-start-year').value), ey = parseInt($('#tl-end-year').value);
      // A year that isn't a year yet is not a timeline change.
      if (!(sy >= 1900 && sy <= 2200 && ey >= 1900 && ey <= 2200)) return;
      state.timeline.startMonth = parseInt($('#tl-start-month').value);
      state.timeline.startYear  = sy;
      state.timeline.endMonth   = parseInt($('#tl-end-month').value);
      state.timeline.endYear    = ey;
      renderAll();
      markDirty();
    };
    /* On change only. Firing on each keystroke re-ran rebalancePhases against
       whatever a half-typed year implied ("2" → a 200-month span), rewrote
       every phase length to fit it, and autosaved the result. */
    ['#tl-start-month','#tl-start-year','#tl-end-month','#tl-end-year'].forEach(s => {
      $(s).addEventListener('change', tlChange);
    });

    // Assumptions
    /* The value lands in state on every keystroke; the matrix/monthly rebuild
       (the expensive part) waits until typing pauses. */
    const debounceUI = (window.UFC_UI && window.UFC_UI.debounce) || ((fn) => fn);
    const assumptionsChanged = debounceUI(() => { renderCatalog(); renderSelectedRoles(); renderSummary(); renderMatrix(); renderMonthly(); renderFloorCheck(); markDirty(); }, 150);
    $('#a-hrs').addEventListener('input',  e => { state.assumptions.hrsPerMo = parseFloat(e.target.value) || 0; assumptionsChanged(); });
    $('#a-esc').addEventListener('input',  e => { state.assumptions.escalation = parseFloat(e.target.value) || 0; assumptionsChanged(); });
    $('#a-ind').addEventListener('input',  e => { state.assumptions.industryAdj = parseFloat(e.target.value) || 0; assumptionsChanged(); });
    $('#a-disc').addEventListener('input', e => { state.assumptions.discount = parseFloat(e.target.value) || 0; assumptionsChanged(); });
    $('#a-lock').addEventListener('change', e => { state.assumptions.rateLock = e.target.checked; renderSummary(); renderMatrix(); renderMonthly(); renderSelectedRoles(); renderFloorCheck(); markDirty(); });
    const fbSel = $('#a-feebasis');
    if (fbSel) fbSel.addEventListener('change', e => {
      state.assumptions.feeBasis = e.target.value;
      const nteField = $('#a-nte-field'); if (nteField) nteField.hidden = (e.target.value !== 'nte');
      updateNteHint(); renderSummary(); markDirty();
    });
    const nteInput = $('#a-nte');
    if (nteInput) nteInput.addEventListener('input', e => { state.assumptions.nteCeiling = parseFloat(e.target.value) || 0; updateNteHint(); renderSummary(); markDirty(); });

    // Header actions
    $('#reset-btn').addEventListener('click', () => {
      if (!confirm('Start a blank project? The project you have open stays saved as it is.')) return;
      /* A pending autosave fired on the empty state and created an orphan
         record; and nothing here ever deleted the old one, whatever the old
         confirm text said. */
      clearTimeout(autosaveTimer); autosaveTimer = null;
      dirty = false; conflicted = false; baseUpdatedAt = null;
      state = DEFAULT_STATE();
      setProjectIdInUrl(null);
      renderAll();
      setSavedLabel('');
    });
    $('#save-btn').addEventListener('click', () => {
      saveToStore({ explicit: true });
    });
    // Safety net: flush a pending autosave if the tab closes within the debounce window.
    window.addEventListener('beforeunload', (e) => {
      if (!dirty) return;
      const worthSaving = state.id || (state.project && state.project.name && state.project.name.trim()) || (state.roles && state.roles.length);
      if (!worthSaving) return;
      const keep = () => { e.preventDefault(); e.returnValue = ''; };   // the browser's "leave page?" prompt
      // In conflict nothing autosaves, so leaving now discards everything typed since.
      if (conflicted) { keep(); return; }
      clearTimeout(autosaveTimer);
      try { saveToStore({ silent: true }); }
      catch (err) { keep(); }        // maintenance, a stale write, a validation refusal — don't lose it silently
    });
    $('#print-btn').addEventListener('click', () => {
      window.print();
    });
    $('#xlsx-btn').addEventListener('click', exportExcel);
    $('#intake-btn').addEventListener('click', () => {
      const leadObj = STORE.resolveLeader(state.project.leadId || state.project.lead);
      const wasReflag = !!(state.intakeSnapshot && state.intakeSnapshot !== window.UFC_Intake.intakeSignature(state, netTotal()));
      window.UFC_Intake.openIntake(state, {
        netFee: netTotal(),
        serviceLines: STORE.projectServiceLines ? STORE.projectServiceLines(state) : [],
        leadName: leadObj ? leadObj.displayName : (state.project.lead || ''),
        statusLabel: STORE.STATUS_LABELS[state.project.status] || '',
        reflag: wasReflag,
      });
      // Snapshot the fee+schedule so future drift re-flags the button.
      state.intakeSnapshot = window.UFC_Intake.intakeSignature(state, netTotal());
      // A re-submit (drift) demands a fresh "sent" confirmation — clicking ≠ sending.
      if (wasReflag) state.project.intakeSent = false;
      updateIntakeButton();
      updateIntakeCallout();
      markDirty();
    });

    // Cover collapse
    $('#cover-toggle').addEventListener('click', () => {
      const cover = $('#cover-pane');
      cover.classList.toggle('collapsed');
      $('#cover-toggle').textContent = cover.classList.contains('collapsed') ? 'Show setup' : 'Hide setup';
    });
  }

  // expose for export script
  window.__UFC__ = {
    getState: () => state,
    setState: (s) => { state = s; },
    renderPassthrough, renderMonthly, renderSummary,
    ptCostTotal, ptMarkupTotal, ptClientTotal, ptOn,
    getMonths,
    getMonthsByPhase,
    rateForYear,
    unlockedRateForYear,
    effectiveFte,
    monthlyFee,
    monthlyLockCredit,
    rolePhaseFee,
    phaseTotal,
    grossTotal,
    lockCredit,
    discountAmt,
    netTotal,
    feeShareAmt, revenueTotal, clientBillTotal, effectiveBrokerPct, feeShareMode,
    totalFteMonths,
    getTitle,
    getTier,
    getGroup,
    effectiveMinRate,
    roleCostFloor,
    roleFloorViolation,
    seedAllocationsToTarget,
    fitToTarget,
    fmSolve, fmSeedTargets, fmApply, fmUndoApply, fmCurrentByMonth, fmMonthList, fmBlockReason, fmAllocated,
    fmSetTarget: (mk, v) => { if (!fmTargets) fmSeedTargets(); fmTargets[mk] = v; fmPinned.add(mk); renderFitMonth(); },
    fmTargetsNow: () => fmTargets,
    renderMatrix,
    renderMonthly,
    renderProjectMeta,
    updateChangeOrderBanner,
    CATALOG,
  };

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  /* ----- Excel export ----- */
  async function exportExcel() {
    const btn = $('#xlsx-btn');
    const orig = btn.textContent;
    btn.textContent = 'Building…';
    btn.disabled = true;
    try {
      // ExcelJS is loaded on demand. Ask for it here, then check — the old
      // order checked first and so refused every click.
      if (window.UFC_Vendor && window.UFC_Vendor.excel) await window.UFC_Vendor.excel();
      if (typeof ExcelJS === 'undefined') throw new Error('the Excel library did not load — check your connection and try again');
      await window.UFC_buildAndDownloadExcel();
    } catch (e) {
      console.error(e);
      UFC_UI.toast('Excel export failed: ' + e.message);
    } finally {
      btn.textContent = orig;
      btn.disabled = false;
    }
  }

  /* ----- Boot ----- */
  document.addEventListener('DOMContentLoaded', () => {
    const start = () => {
    wireControls();
    // Attempt to load from store
    const id = getProjectIdFromUrl();
    if (id) {
      const rec = STORE.getProject(id);
      if (rec) {
        // Access wall: a restricted member may only open projects they own.
        if (!STORE.seesAllProjects() && !STORE.userOwnsProject(rec)) {
          document.body.innerHTML = `<div style="max-width:560px;margin:18vh auto;text-align:center;font-family:var(--font-display),sans-serif;color:#25273a;padding:0 24px;">
            <div style="font-size:13px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:#ce181e;margin-bottom:14px;">Access restricted</div>
            <div style="font-size:26px;font-weight:900;letter-spacing:-0.01em;margin-bottom:12px;">This project isn't assigned to you.</div>
            <div style="font-family:var(--font-body),sans-serif;font-size:14px;line-height:1.6;color:#6b7280;margin-bottom:24px;">You're signed in as <strong>${escapeHtml(STORE.getCurrentUser().name || 'a restricted user')}</strong>. Only the project's lead, relationship owner, or leadership can open it.</div>
            <a href="Projects Index.html" style="display:inline-block;font-family:var(--font-display),sans-serif;font-weight:700;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;padding:13px 22px;background:#25273a;color:#fff;text-decoration:none;">← Back to Projects Index</a>
          </div>`;
          return;
        }
        // Hydrate state from record; preserve defaults for any missing fields
        const defaults = DEFAULT_STATE();
        state = {
          ...defaults,
          ...rec,
          project: { ...defaults.project, ...(rec.project || {}) },
          timeline: { ...defaults.timeline, ...(rec.timeline || {}) },
          assumptions: { ...defaults.assumptions, ...(rec.assumptions || {}) },
          phases: rec.phases || defaults.phases,
          groups: rec.groups || defaults.groups,
          roles: rec.roles || [],
        };
        setSavedLabel('Loaded · ' + formatTime(rec.updatedAt));
        baseUpdatedAt = rec.updatedAt || null;
      } else {
        setSavedLabel('Project not found');
      }
    }
    /* A new project's catalogBaseYear was read before rates.json arrived, so
       it anchored at the shipped default whatever the catalog said. */
    if (!state.id && CATALOG && CATALOG.baseYear) state.assumptions.catalogBaseYear = CATALOG.baseYear;
    const cb = $('#a-catbase'); if (cb && CATALOG && CATALOG.baseYear) cb.textContent = String(CATALOG.baseYear);
    renderAll();
    refreshVersionCount();
    };
    // Gate on the data layer (instant on localStorage; pulls from Box when enabled).
    if (window.ufcReady && window.ufcReady.then) { window.ufcReady.then(start); } else { start(); }
  });

  /* ----- Store integration ----- */
  function markDirty() {
    dirty = true;
    // Autosave both existing AND new projects. A new project (no id yet) is
    // created on first autosave the moment it has anything worth saving (a name
    // or at least one role) — so forgetting to click Save can't lose work.
    const worthSaving = state.id || (state.project && state.project.name && state.project.name.trim()) || (state.roles && state.roles.length);
    if (worthSaving) {
      if (conflicted) { setSavedLabel('Not saved — conflict'); return; }   // wait for the user to resolve
      clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => saveToStore({ silent: true }), 800);
      setSavedLabel('Unsaved…');
    } else {
      setSavedLabel('Not saved');
    }
  }

  function markDirtyFromRender() {
    // Some renderers mutate state (rebalancePhases, reconcileRoleFte). Don't autosave on init.
  }

  function saveToStore(opts = {}) {
    try {
      const record = JSON.parse(JSON.stringify(state));
      const saved = STORE.saveProject(record, {
        baseUpdatedAt: opts.force ? null : baseUpdatedAt,
        force: !!opts.force,
      });
      state.id = saved.id;
      state.createdAt = saved.createdAt;
      state.updatedAt = saved.updatedAt;
      baseUpdatedAt = saved.updatedAt;
      conflicted = false;
      clearConflictBanner();
      setProjectIdInUrl(saved.id);
      setSavedLabel('Saved · ' + formatTime(saved.updatedAt));
      refreshVersionCount();
      dirty = false;
      if (opts.explicit) {
        const btn = $('#save-btn');
        const o = btn.textContent;
        btn.textContent = 'Saved ✓';
        setTimeout(() => { btn.textContent = o; }, 1100);
      }
    } catch (e) {
      if (e && e.code === 'STALE_WRITE') { showConflictBanner(e.remote); return; }
      if (e && e.code === 'INVALID_RECORD') { setSavedLabel('Not saved — fix the fields'); UFC_UI.toast(e.message); return; }
      console.error('Save failed', e);
      UFC_UI.toast('Save failed: ' + e.message);
    }
  }

  /* ----- Concurrent-edit conflict ----------------------------------------
     Two people (or two tabs) on the same project: whoever saved last used to
     win, silently reverting the other's work. Now the second write is refused
     and we ask. Nothing is lost either way — the unsaved edits stay in this
     tab until the user chooses. */
  function clearConflictBanner() {
    document.getElementById('ufc-conflict')?.remove();
  }
  function showConflictBanner(remote) {
    conflicted = true;
    dirty = true;
    clearTimeout(autosaveTimer);
    setSavedLabel('Not saved — conflict');
    if (document.getElementById('ufc-conflict')) return;
    const who = (remote && remote.by) ? escapeHtml(remote.by) : 'Someone else';
    const when = (remote && remote.updatedAt) ? formatTime(remote.updatedAt) : 'just now';
    const el = document.createElement('div');
    el.id = 'ufc-conflict';
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9998;background:#CE181E;color:#fff;padding:14px 22px;display:flex;align-items:center;gap:18px;flex-wrap:wrap;box-shadow:0 -6px 24px rgba(0,0,0,.25);font-family:var(--font-body),sans-serif;';
    el.innerHTML = `
      <div style="flex:1;min-width:280px;font-size:13px;line-height:1.5;">
        <strong style="font-family:var(--font-display),sans-serif;font-weight:700;">${who} saved this project at ${escapeHtml(when)}, while you were editing.</strong><br>
        Your changes are still here on screen but are <b>not saved</b>. Reload theirs to start from the current version, or keep yours to overwrite it.
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button id="ufc-conflict-reload" style="font-family:var(--font-display),sans-serif;font-weight:700;font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:11px 16px;border:0;background:#fff;color:#CE181E;cursor:pointer;">Reload their version</button>
        <button id="ufc-conflict-force" style="font-family:var(--font-display),sans-serif;font-weight:700;font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:11px 16px;border:2px solid #fff;background:transparent;color:#fff;cursor:pointer;">Keep mine · overwrite</button>
      </div>`;
    document.body.appendChild(el);
    document.getElementById('ufc-conflict-reload').onclick = () => {
      clearConflictBanner();
      conflicted = false;
      window.location.reload();
    };
    document.getElementById('ufc-conflict-force').onclick = () => {
      if (!confirm('Overwrite their version with yours? Their changes since you opened this project will be replaced. A version snapshot is kept either way.')) return;
      // Snapshot what's currently stored so their work is recoverable.
      try { if (state.id) STORE.saveVersion(state.id, { label: 'Before overwrite (conflict)', auto: true }); } catch (err) {}
      clearConflictBanner();
      saveToStore({ force: true, explicit: true });
    };
  }

  function setSavedLabel(text) {
    const el = $('#hdr-saved');
    if (el) el.textContent = text || '';
  }

  /* ----- Version history ----- */
  function refreshVersionCount() {
    const el = $('#versions-count');
    if (!el) return;
    const rec = state.id ? STORE.getProject(state.id) : null;
    const n = rec && rec.versions ? rec.versions.length : 0;
    if (n > 0) { el.textContent = n; el.hidden = false; } else { el.hidden = true; }
  }

  function openVersions() {
    // Flush any pending edit so the latest state is captured/compared.
    if (dirty) { clearTimeout(autosaveTimer); saveToStore({ silent: true }); }
    renderVersionList();
    $('#ver-overlay').hidden = false;
  }
  function closeVersions() { $('#ver-overlay').hidden = true; $('#ver-diff').hidden = true; }

  function renderVersionList() {
    const rec = state.id ? STORE.getProject(state.id) : null;
    const versions = rec ? STORE.listVersions(rec) : [];
    const list = $('#ver-list');
    if (!versions.length) {
      list.innerHTML = '<div class="ver-empty">No versions yet. Click <strong>+ Save current as version</strong> to capture this proposal — or it auto-captures when you move it to Submitted, Awarded, or Lost.</div>';
      $('#ver-compare').hidden = true;
      return;
    }
    list.innerHTML = versions.slice().reverse().map(v => {
      const who = v.savedBy && (v.savedBy.name || v.savedBy.username) || '—';
      const lbl = v.label || ('Version ' + v.n);
      const net = (v.net != null) ? fmtMoney(v.net) : '—';
      return `<div class="ver-row">
        <div class="vr-n">v${v.n}</div>
        <div class="vr-main">
          <div class="vr-label">${escapeHtml(lbl)}${v.auto ? '<span class="vr-auto">Auto</span>' : ''}</div>
          <div class="vr-meta">${escapeHtml(STORE.STATUS_LABELS[v.status] || v.status || '')} · ${escapeHtml(who)} · ${formatVerDate(v.savedAt)}${v.note ? ' · ' + escapeHtml(v.note) : ''}</div>
        </div>
        <div class="vr-right">
          <div class="vr-net">${net} <span>net</span></div>
          <button class="vr-restore" data-restore="${v.id}">Restore</button>
        </div>
      </div>`;
    }).join('');

    // Compare selectors
    const cmp = $('#ver-compare');
    cmp.hidden = false;
    const opts = versions.map(v => `<option value="${v.id}">v${v.n} · ${escapeHtml(v.label || ('Version ' + v.n))}</option>`).join('');
    const curOpt = '<option value="current">Current (live)</option>';
    $('#ver-a').innerHTML = opts;
    $('#ver-b').innerHTML = opts + curOpt;
    $('#ver-a').value = versions[0].id;
    $('#ver-b').value = 'current';
    renderVersionDiff();
  }

  function renderVersionDiff() {
    const rec = state.id ? STORE.getProject(state.id) : null;
    if (!rec) return;
    const a = $('#ver-a').value, b = $('#ver-b').value;
    if (!a || !b || a === b) { $('#ver-diff').hidden = true; return; }
    const d = STORE.versionDiff(rec, a, b);
    const dNet = (d.b.net != null && d.a.net != null) ? d.b.net - d.a.net : null;
    const chips = (arr, cls, fmt) => arr.length ? arr.map(fmt).join('') : '';
    const addC = chips(d.roles.added, 'add', r => `<span class="vd-chip add">+ ${escapeHtml(r.label)} (${r.fteMonths.toFixed(1)} fte-mo)</span>`);
    const remC = chips(d.roles.removed, 'rem', r => `<span class="vd-chip rem">− ${escapeHtml(r.label)} (${r.fteMonths.toFixed(1)} fte-mo)</span>`);
    const chgC = chips(d.roles.changed, 'chg', r => `<span class="vd-chip chg">~ ${escapeHtml(r.label)}${r.rateChanged ? ' (rate)' : ''}${Math.abs(r.fteDelta) > 0.01 ? ' ' + (r.fteDelta > 0 ? '+' : '') + r.fteDelta.toFixed(1) + ' fte-mo' : ''}</span>`);
    const anyRole = addC || remC || chgC;
    const deltaCls = dNet == null ? '' : dNet > 0 ? 'pos' : dNet < 0 ? 'neg' : '';
    const deltaStr = dNet == null ? '—' : (dNet > 0 ? '+' : '') + fmtMoney(dNet);
    $('#ver-diff').hidden = false;
    $('#ver-diff').innerHTML = `
      <div class="vd-totals">
        <div class="vd-tot"><span>From (net)</span><b>${d.a.net != null ? fmtMoney(d.a.net) : '—'}</b></div>
        <div class="vd-tot"><span>To (net)</span><b>${d.b.net != null ? fmtMoney(d.b.net) : '—'}</b></div>
        <div class="vd-tot"><span>Change</span><b class="vd-delta ${deltaCls}">${deltaStr}</b></div>
      </div>
      <div>${anyRole || '<span class="vd-none">No staffing differences between these versions.</span>'}</div>`;
  }

  function onSaveVersion() {
    if (!state.id) { saveToStore({ silent: true }); }
    if (!state.id) { UFC_UI.toast('Add a project name or a role first, then save a version.'); return; }
    const label = prompt('Name this version (e.g. "Client counteroffer", "v2 after Kathy review"):', '');
    if (label === null) return;   // cancelled
    STORE.saveVersion(state.id, { label: label || '' });
    // saveVersion stamps the record; without this the next autosave sees a
    // newer updatedAt than it started from and reports the user to themself.
    const fresh = STORE.getProject(state.id);
    if (fresh) baseUpdatedAt = fresh.updatedAt || baseUpdatedAt;
    refreshVersionCount();
    renderVersionList();
  }

  function onRestoreVersion(vid) {
    const rec = state.id ? STORE.getProject(state.id) : null;
    if (!rec) return;
    const v = (rec.versions || []).find(x => x.id === vid);
    if (!v) return;
    if (!confirm(`Restore ${v.label || ('version ' + v.n)}? This loads that version's inputs into the calculator. Your current state is preserved as long as you saved it as a version — otherwise save one first.`)) return;
    // Capture the current state as a version before overwriting, so nothing is lost.
    STORE.saveVersion(state.id, { label: 'Before restore of v' + v.n, auto: true });
    const restored = STORE.restoreVersionRecord(STORE.getProject(state.id), vid);
    const defaults = DEFAULT_STATE();
    state = {
      ...defaults, ...restored,
      project: { ...defaults.project, ...(restored.project || {}) },
      timeline: { ...defaults.timeline, ...(restored.timeline || {}) },
      assumptions: { ...defaults.assumptions, ...(restored.assumptions || {}) },
      phases: restored.phases || defaults.phases,
      groups: restored.groups || defaults.groups,
      roles: restored.roles || [],
    };
    // Restoring is a deliberate act on this record — bypass the staleness guard
    // (saveVersion above just touched the stored copy).
    saveToStore({ silent: true, force: true });
    renderAll();
    refreshVersionCount();
    closeVersions();
    setSavedLabel('Restored v' + v.n);
  }

  function formatVerDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function wireVersions() {
    $('#versions-btn') && $('#versions-btn').addEventListener('click', openVersions);
    $('#ver-close') && $('#ver-close').addEventListener('click', closeVersions);
    $('#ver-overlay') && $('#ver-overlay').addEventListener('click', e => { if (e.target.id === 'ver-overlay') closeVersions(); });
    $('#ver-save-btn') && $('#ver-save-btn').addEventListener('click', onSaveVersion);
    $('#ver-a') && $('#ver-a').addEventListener('change', renderVersionDiff);
    $('#ver-b') && $('#ver-b').addEventListener('change', renderVersionDiff);
    $('#ver-list') && $('#ver-list').addEventListener('click', e => {
      const b = e.target.closest('[data-restore]');
      if (b) onRestoreVersion(b.dataset.restore);
    });
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
})();
