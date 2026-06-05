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
    return params.get('id');
  }
  function setProjectIdInUrl(id) {
    const url = new URL(window.location);
    if (id) url.searchParams.set('id', id);
    else url.searchParams.delete('id');
    window.history.replaceState({}, '', url);
  }

  /* ---------- Constants ---------- */
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
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
      firstProposalDate: '',
      signedContractDate: '',
      clientContact: '',
      clientRelOwner: '',
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
      hrsPerMo: 173.33,
      escalation: 3.0,
      industryAdj: 20,   // rate-wide “industry standard” trim off the high Macro rack rates
      discount: 0,       // client / fixed-fee discount, applied at total level
      rateLock: false,
      billingMode: 'phase', // 'phase' = resource-loaded as accrued · 'flatline' = net ÷ months, even monthly
      feeShare: { enabled: false, pct: 10 }, // broker referral cut off the revenue side
      catalogBaseYear: CATALOG.baseYear,
    },
  });

  let state = DEFAULT_STATE();
  let dirty = false;
  let autosaveTimer = null;

  /* ---------- Helpers ---------- */
  const uid = () => 'r' + Math.random().toString(36).slice(2, 9);
  const fmtMoney = (n) => {
    if (!n || Math.abs(n) < 0.5) return '$0';
    const sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(Math.round(n)).toLocaleString();
  };
  const fmtMoneyDecimal = (n) => '$' + (Math.round(n * 100) / 100).toFixed(2);
  const fmtMoneySmall = (n) => (!n || Math.abs(n) < 0.5) ? '—' : '$' + Math.abs(Math.round(n)).toLocaleString();
  const monthLabel = (y, m, opts={}) => `${MONTH_NAMES[m-1]} ’${String(y).slice(-2)}`;
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
  /** Effective FTE % for a role in a given month: a per-month override wins over
      the phase-level value. role.fteMonthly = { "YYYY-M": pct }. */
  function effectiveFte(role, monthObj, phaseId) {
    const mk = monthKey(monthObj);
    if (role.fteMonthly && role.fteMonthly[mk] != null) return role.fteMonthly[mk];
    return role.fte[phaseId] || 0;
  }
  /** Recompute a phase's stored fte as the average of its months' effective FTE
      (called after a per-month edit, so the collapsed phase reflects the months). */
  function recomputePhaseAvg(role, phase) {
    const months = getMonthsByPhase().find(x => x.phase.id === phase.id)?.months || [];
    if (!months.length) return;
    const sum = months.reduce((s, m) => s + effectiveFte(role, m, phase.id), 0);
    role.fte[phase.id] = Math.round((sum / months.length) * 10) / 10;
  }

  function monthlyFee(role, monthObj, phaseId) {
    const fte = effectiveFte(role, monthObj, phaseId) / 100;
    if (!fte) return 0;
    const rate = rateForYear(role, monthObj.year);
    return fte * rate * state.assumptions.hrsPerMo;
  }

  /** Rate Lock credit = (unlocked - locked) × hours × FTE, per role per month. Always positive when lock is on. */
  function monthlyLockCredit(role, monthObj, phaseId) {
    if (!state.assumptions.rateLock) return 0;
    const fte = effectiveFte(role, monthObj, phaseId) / 100;
    if (!fte) return 0;
    const diff = unlockedRateForYear(role, monthObj.year) - rateForYear(role, monthObj.year);
    return Math.max(0, diff) * fte * state.assumptions.hrsPerMo;
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
  function discountAmt() {
    return grossTotal() * (state.assumptions.discount / 100);
  }
  function netTotal() {
    return grossTotal() - lockCredit() - discountAmt();
  }
  /* Fee share = broker referral cut taken off the REVENUE side (invoicing),
     invisible to the client. Proposal fee = what the client pays (netTotal);
     revenue = proposal fee minus the broker's share. */
  function feeShareOn() { return !!(state.assumptions.feeShare && state.assumptions.feeShare.enabled); }
  function feeSharePct() { return (state.assumptions.feeShare && parseFloat(state.assumptions.feeShare.pct)) || 0; }
  function feeShareAmt() { return feeShareOn() ? netTotal() * (feeSharePct() / 100) : 0; }
  function revenueTotal() { return netTotal() - feeShareAmt(); }
  function totalFteMonths() {
    return state.roles.reduce((s, r) => {
      return s + state.phases.reduce((sp, p) => sp + ((r.fte[p.id] || 0) / 100) * p.length, 0);
    }, 0);
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
    renderProjectMeta();
    renderProjFlag();
    renderTimeline();
    renderPhases();
    renderGroups();
    renderCatalog();
    renderSelectedRoles();
    renderAssumptions();
    renderSummary();
    renderMatrix();
    renderMonthly();
    renderFloorCheck();
    renderReconcile();
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
      const within = Math.abs(delta) < Math.max(1, target * 0.001);
      deltaEl.textContent = within ? '✓ reconciled' : `${delta > 0 ? '+' : '−'}${fmtMoney(Math.abs(delta))} (${delta > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)`;
      deltaEl.className = 'rc-delta' + (within ? ' ok' : ' off');
    }
    if (noteOverride) $('#rc-note').innerHTML = noteOverride;
  }

  /** Seed FTE allocations to hit a target fee when the matrix is blank.
      Loads every billable role to 100% across all phases, measures that net,
      then scales all allocations by the ratio that lands net == target (at the
      current discount). Caps at 100%; reports a shortfall if even full load
      can't reach it. */
  function seedAllocationsToTarget(target) {
    const billable = state.roles.filter(r => { const t = getTier(r.titleId, r.tierId); return t && !t.isNoCharge; });
    if (!billable.length) { renderReconcile('<span class="rc-warn">No billable roles to allocate. Add staff or set rates first.</span>'); return; }
    state.roles.forEach(r => state.phases.forEach(p => { r.fte[p.id] = 100; }));
    const gross100 = grossTotal();
    const lock100 = lockCredit();
    const d = (state.assumptions.discount || 0) / 100;
    const net100 = (gross100 - lock100) - gross100 * d;
    if (net100 <= 0.5) { renderReconcile('<span class="rc-warn">Roles have no billable rate — can\'t solve allocations. Check tiers/rates.</span>'); return; }
    let k = target / net100, capped = false;
    if (k > 1) { k = 1; capped = true; }
    const pct = Math.round(100 * k * 10) / 10;   // one-decimal FTE → lands close to target
    state.roles.forEach(r => state.phases.forEach(p => { const t = getTier(r.titleId, r.tierId); r.fte[p.id] = (t && t.isNoCharge) ? 0 : pct; }));
    renderAll();
    let msg = capped
      ? `<span class="rc-warn">Loaded all roles at 100% — the most this team can bill is <strong>${fmtMoney(netTotal())}</strong>, under the <strong>${fmtMoney(target)}</strong> target. Add people, extend the term, or raise rates.</span>`
      : `<strong>Allocations seeded to ${fmtMoney(target)}.</strong> Every role set to <strong>${pct}%</strong> across all phases as a starting point — now redistribute per phase in the matrix to match the real plan.`;
    const viol = floorViolations().length;
    if (viol) msg += ` <span class="rc-warn">${viol} role${viol === 1 ? '' : 's'} below cost floor (advisory).</span>`;
    renderReconcile(msg);
    markDirty();
  }

  /** Back-solve to the target by adjusting ONLY the client discount — staffing
      allocations and per-role rates are held fixed (they come from the actual
      proposal). net = gross − lockCredit − discount×gross, so for a target net
      we solve discount = (gross − lock − target) / gross. If the target is
      ABOVE gross at current rates, discount can't help (it can't go negative) —
      we flag that and leave it for a manual rate change. Floor advisory still
      applies after. */
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
    const lock = lockCredit();
    const maxNet = grossNow - lock;            // net with 0% discount — the ceiling

    // No allocations loaded (e.g. an ingested proposal with a fee but a blank
    // matrix) → SEED allocations to hit the target instead of failing.
    if (grossNow <= 0.5) {
      seedAllocationsToTarget(target);
      return;
    }

    let d = (grossNow - lock - target) / grossNow;
    let undershoot = false;                    // target is above what current rates can bill
    if (d < 0) { d = 0; undershoot = true; }
    d = Math.min(0.95, d);
    state.assumptions.discount = Math.round(d * 10000) / 100;   // two decimals
    const discInput = $('#a-disc');
    if (discInput) discInput.value = state.assumptions.discount;

    renderAll();

    let msg;
    if (undershoot) {
      const shortBy = target - maxNet;
      msg = `<span class="rc-warn">At current rates the most you can bill (0% discount) is <strong>${fmtMoney(maxNet)}</strong> — <strong>${fmtMoney(shortBy)}</strong> short of the target. Allocations are held to the proposal, so raise the rates (grid tier or contracted rate) to close the gap.</span>`;
    } else {
      msg = `<strong>Reconciled to ${fmtMoney(target)}.</strong> Held staffing &amp; rates; solved a <strong>${state.assumptions.discount}%</strong> client discount.`;
    }
    const viol = floorViolations().length;
    if (viol) msg += ` <span class="rc-warn">${viol} role${viol === 1 ? '' : 's'} now below cost floor (advisory).</span>`;
    renderReconcile(msg);
    markDirty();
  }

  /* ----- Project meta ----- */
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

    $('#pm-firstProposal').value = f.firstProposalDate || '';
    $('#pm-signed').value = f.signedContractDate || '';
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
  }

  /* ----- Assumptions ----- */
  function renderAssumptions() {
    const a = state.assumptions;
    $('#a-hrs').value = a.hrsPerMo;
    $('#a-esc').value = a.escalation;
    $('#a-ind').value = a.industryAdj;
    $('#a-disc').value = a.discount;
    $('#a-lock').checked = a.rateLock;
    $('#a-catbase').textContent = a.catalogBaseYear;
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
      diverge from the calculator's computed fee — prompting a reconcile. */
  function renderProjFlag() {
    const el = $('#proj-flag');
    if (!el) return;
    const ov = state.monthlyOverrides;
    if (!ov || !Object.keys(ov).length) { el.hidden = true; el.innerHTML = ''; return; }
    const n = Object.keys(ov).length;
    el.hidden = false;
    el.innerHTML = `<div class="pf-icon">⚖</div>
      <div class="pf-body">
        <div class="pf-title">${n} month${n===1?' was':'s were'} manually overridden in Revenue Projections.</div>
        <div class="pf-detail">The projected billings for this project no longer match the calculator's computed fee. Reconcile the staffing/discount here, or clear the overrides to revert to the computed schedule.</div>
      </div>
      <button class="pf-clear" id="pf-clear" type="button">Clear overrides</button>`;
    $('#pf-clear').addEventListener('click', () => {
      delete state.monthlyOverrides;
      renderProjFlag();
      markDirty();
    });
  }

  /** Show the intake button on Won/Active; re-flag if fee/schedule drifted since last intake. */
  function updateIntakeButton() {
    const btn = $('#intake-btn');
    if (!btn || !window.UFC_Intake) return;
    const eligible = ['won', 'active'].includes(state.project.status);
    btn.style.display = eligible ? '' : 'none';
    if (!eligible) return;
    const sig = window.UFC_Intake.intakeSignature(state, netTotal());
    const drifted = state.intakeSnapshot && state.intakeSnapshot !== sig;
    btn.textContent = drifted ? '⚠ Re-submit Intake (changed) →' : 'Salesforce Intake →';
    btn.classList.toggle('intake-drift', !!drifted);
  }

  function updateStatusRatingHints() {
    updateIntakeButton();
    const rh = $('#rating-hint');
    if (rh) rh.textContent = ratingGuidanceText(state.project.status);
    const sh = $('#status-hint');
    if (sh) {
      const aged = monthsSinceLastBilling() >= 2;   // last billing > ~60 days ago
      const liveish = ['active', 'won'].includes(state.project.status);
      if (aged && liveish) {
        sh.innerHTML = `Last billing was &gt;60 days ago — consider <strong>Closed out</strong>.`;
        sh.classList.add('warn');
      } else { sh.textContent = ''; sh.classList.remove('warn'); }
    }
  }

  /* ----- Summary ----- */
  function renderSummary() {
    const gross = grossTotal();
    const lock = lockCredit();
    const disc = discountAmt();
    const net = gross - lock - disc;
    $('#sum-fte').innerHTML = `${totalFteMonths().toFixed(1)}<span class="unit">fte-mo</span>`;
    $('#sum-gross').textContent = fmtMoney(gross);
    $('#sum-lock').textContent = fmtMoney(-lock);
    $('#sum-discount').textContent = fmtMoney(-disc);
    $('#sum-total').textContent = fmtMoney(net);
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
        sub += c.type === 'month' ? `<th class="mcol">${c.month.label}</th>` : `<th></th>`;
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
      ghdr.innerHTML = `<td colspan="${matrixColumns().length + 2}">${escapeHtml(g.name)}</td>`;
      tbody.appendChild(ghdr);
      rolesInGroup.forEach(r => {
        const title = getTitle(r.titleId);
        const tier = getTier(r.titleId, r.tierId);
        const tr = document.createElement('tr');
        tr.dataset.rid = r.id;
        const viol = roleFloorViolation(r);
        if (viol) tr.className = 'row-violation';
        const projRole = (r.projectRole || '').trim();
        let html = `<td class="role">
          <div class="role-name">${escapeHtml(title?.name || '—')}<span class="role-tier">${escapeHtml(tier?.label || '')}</span></div>
          <div class="role-resource">${escapeHtml(projRole ? projRole + ' · ' : '')}${escapeHtml(r.resource || 'TBD')}${viol ? ' <span class="role-floor-flag">below cost</span>' : ''}</div>
        </td>`;
        state.phases.forEach(p => {
          if (expandedPhases.has(p.id)) {
            const months = getMonthsByPhase().find(x => x.phase.id === p.id)?.months || [];
            months.forEach(m => {
              const mk = monthKey(m);
              const v = (r.fteMonthly && r.fteMonthly[mk] != null) ? r.fteMonthly[mk] : (r.fte[p.id] || 0);
              html += `<td class="fte mcol ${v === 0 ? 'zero' : ''}">
                <input type="number" data-role="${r.id}" data-month="${mk}" data-phase="${p.id}" value="${v}" min="0" max="200" step="5">%
              </td>`;
            });
          } else {
            const v = r.fte[p.id] || 0;
            html += `<td class="fte ${v === 0 ? 'zero' : ''}">
              <input type="number" data-role="${r.id}" data-phase="${p.id}" value="${v}" min="0" max="200" step="5">%
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
        const val = parseFloat(e.target.value) || 0;
        const mk = e.target.dataset.month;
        if (role && mk) {
          // Per-month edit → store override + recompute the phase average.
          role.fteMonthly = role.fteMonthly || {};
          role.fteMonthly[mk] = val;
          const phase = state.phases.find(p => p.id === e.target.dataset.phase);
          if (phase) recomputePhaseAvg(role, phase);
        } else if (role) {
          // Phase-level edit → set phase value AND clear any month overrides in it
          // so the phase rate applies uniformly again.
          role.fte[e.target.dataset.phase] = val;
          if (role.fteMonthly) {
            const months = getMonthsByPhase().find(x => x.phase.id === e.target.dataset.phase)?.months || [];
            months.forEach(m => { delete role.fteMonthly[monthKey(m)]; });
            if (!Object.keys(role.fteMonthly).length) delete role.fteMonthly;
          }
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
    return state.roles.reduce((s, r) => s + (r.fte[col.phase.id] || 0) / 100, 0);
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
    const fs = state.assumptions.feeShare || { enabled: false, pct: 10 };
    const on = $('#fs-on'), pct = $('#fs-pct'), ctl = $('#fee-share-ctl');
    if (on) on.checked = !!fs.enabled;
    if (pct && document.activeElement !== pct) pct.value = fs.pct != null ? fs.pct : 10;
    if (pct) pct.disabled = !fs.enabled;
    if (ctl) ctl.classList.toggle('is-on', !!fs.enabled);
  }

  /** Append "Less fee share" + "Revenue" rows under a monthly grand-total, when fee share is on. */
  function appendFeeShareRows(tbody, visibleGroups) {
    if (!feeShareOn()) return;
    const share = feeShareAmt();
    const fs = document.createElement('tr');
    fs.className = 'credit-row fee-share-row';
    fs.innerHTML = `<td class="month-col">Less ${feeSharePct()}% fee share · broker</td><td colspan="${visibleGroups.length}"></td><td>${fmtMoney(-share)}</td>`;
    tbody.appendChild(fs);
    const rev = document.createElement('tr');
    rev.className = 'total grand revenue-row';
    rev.innerHTML = `<td class="month-col">Revenue · net of fee share</td><td colspan="${visibleGroups.length}"></td><td>${fmtMoney(revenueTotal())}</td>`;
    tbody.appendChild(rev);
  }

  function renderMonthly() {
    const thead = $('#monthly-thead');
    const tbody = $('#monthly-tbody');
    syncBillingToggle();
    syncFeeShare();
    const months = getMonths();
    if (!state.roles.length || !months.length) {
      thead.innerHTML = '';
      tbody.innerHTML = `<tr><td class="empty-matrix" colspan="3">Add roles + a valid timeline to see monthly schedule.</td></tr>`;
      return;
    }
    const d = (state.assumptions.discount || 0) / 100;
    const flat = state.assumptions.billingMode === 'flatline';
    const spread = !flat && monthlyMode === 'spread' && d > 0;

    // header: Month + each group + total
    let hdr = `<tr><th class="month-col">Month</th>`;
    state.groups.forEach(g => {
      const has = state.roles.some(r => r.groupId === g.id);
      if (has) hdr += `<th>${escapeHtml(g.name)}</th>`;
    });
    hdr += `<th>Monthly ${(flat || spread) ? 'billed' : 'total'}</th></tr>`;
    thead.innerHTML = hdr;

    tbody.innerHTML = '';
    const byPhase = getMonthsByPhase();
    let totalsByGroup = {};
    let grandGross = 0, grandNet = 0;
    state.groups.forEach(g => totalsByGroup[g.id] = 0);
    const visibleGroups = state.groups.filter(g => state.roles.some(r => r.groupId === g.id));


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
      cap.innerHTML = `<td colspan="${visibleGroups.length + 2}">Flat monthly fee — net total ÷ ${monthCount} month${monthCount === 1 ? '' : 's'}. Resource loading drives the total; billing is levelized into equal monthly invoices.</td>`;
      tbody.appendChild(cap);

      byPhase.forEach(bucket => {
        if (!bucket.months.length) return;
        const phRow = document.createElement('tr');
        phRow.className = 'phase';
        phRow.innerHTML = `<td colspan="${visibleGroups.length + 2}">${escapeHtml(bucket.phase.name)} · ${bucket.months.length} mo</td>`;
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
          html += `<td><strong>${fmtMoneySmall(flatMonthly)}</strong></td>`;
          tr.innerHTML = html;
          tbody.appendChild(tr);
        });
      });

      const sub = document.createElement('tr');
      sub.className = 'total';
      let subHtml = `<td class="month-col">Flat monthly fee</td>`;
      visibleGroups.forEach(g => { subHtml += `<td>${fmtMoneySmall(totalsByGroup[g.id] / (monthCount || 1))}</td>`; });
      subHtml += `<td>${fmtMoney(flatMonthly)}</td>`;
      sub.innerHTML = subHtml;
      tbody.appendChild(sub);

      const tr = document.createElement('tr');
      tr.className = 'total grand';
      tr.innerHTML = `<td class="month-col">Total proposed fee</td><td colspan="${visibleGroups.length}"></td><td>${fmtMoney(net)}</td>`;
      tbody.appendChild(tr);
      appendFeeShareRows(tbody, visibleGroups);
      return;
    }

    if (spread) {
      const cap = document.createElement('tr');
      cap.className = 'spread-caption';
      cap.innerHTML = `<td colspan="${visibleGroups.length + 2}">Each month is net of the ${state.assumptions.discount}% client discount${state.assumptions.rateLock ? ' and Rate Lock credit' : ''} — what you actually invoice.</td>`;
      tbody.appendChild(cap);
    }

    byPhase.forEach(bucket => {
      if (bucket.months.length) {
        const phRow = document.createElement('tr');
        phRow.className = 'phase';
        phRow.innerHTML = `<td colspan="${visibleGroups.length + 2}">${escapeHtml(bucket.phase.name)} · ${bucket.months.length} mo</td>`;
        tbody.appendChild(phRow);
      }
      bucket.months.forEach(m => {
        const tr = document.createElement('tr');
        let html = `<td class="month-col">${m.label}</td>`;
        let monthTotal = 0;
        state.groups.forEach(g => {
          if (!state.roles.some(r => r.groupId === g.id)) return;
          const rolesInG = state.roles.filter(r => r.groupId === g.id);
          const gross = rolesInG.reduce((s, r) => s + monthlyFee(r, m, bucket.phase.id), 0);
          let cell;
          if (spread) {
            const lockC = rolesInG.reduce((s, r) => s + monthlyLockCredit(r, m, bucket.phase.id), 0);
            cell = gross * (1 - d) - lockC;      // net billed this month for this group
          } else {
            cell = gross;
          }
          totalsByGroup[g.id] += cell;
          monthTotal += cell;
          grandGross += gross;
          html += `<td>${fmtMoneySmall(cell)}</td>`;
        });
        grandNet += monthTotal;
        html += `<td><strong>${fmtMoneySmall(monthTotal)}</strong></td>`;
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
      subHtml += `<td>${fmtMoney(grandNet)}</td>`;
      sub.innerHTML = subHtml;
      tbody.appendChild(sub);

      const tr = document.createElement('tr');
      tr.className = 'total grand';
      tr.innerHTML = `<td class="month-col">Total proposed fee</td><td colspan="${visibleGroups.length}"></td><td>${fmtMoney(grandNet)}</td>`;
      tbody.appendChild(tr);
      appendFeeShareRows(tbody, visibleGroups);
      return;
    }

    // ----- bottom mode: gross, then credits as lines -----
    const net = grandGross - lock - disc;
    const sub = document.createElement('tr');
    sub.className = 'total';
    let subHtml = `<td class="month-col">Gross subtotal</td>`;
    visibleGroups.forEach(g => { subHtml += `<td>${fmtMoneySmall(totalsByGroup[g.id])}</td>`; });
    subHtml += `<td>${fmtMoney(grandGross)}</td>`;
    sub.innerHTML = subHtml;
    tbody.appendChild(sub);

    if (state.assumptions.rateLock && lock > 0.5) {
      const lr = document.createElement('tr');
      lr.className = 'credit-row';
      lr.innerHTML = `<td class="month-col">Less Rate Lock credit</td><td colspan="${visibleGroups.length}"></td><td>${fmtMoney(-lock)}</td>`;
      tbody.appendChild(lr);
    }
    if (state.assumptions.discount > 0) {
      const dr = document.createElement('tr');
      dr.className = 'credit-row';
      dr.innerHTML = `<td class="month-col">Less ${state.assumptions.discount}% client discount</td><td colspan="${visibleGroups.length}"></td><td>${fmtMoney(-disc)}</td>`;
      tbody.appendChild(dr);
    }
    const tr = document.createElement('tr');
    tr.className = 'total grand';
    tr.innerHTML = `<td class="month-col">Total proposed fee</td><td colspan="${visibleGroups.length}"></td><td>${fmtMoney(net)}</td>`;
    tbody.appendChild(tr);
    appendFeeShareRows(tbody, visibleGroups);
  }

  /* ============================================================
     EVENT WIRING — non-list controls
     ============================================================ */
  function wireControls() {
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
      state.assumptions.feeShare = state.assumptions.feeShare || { enabled: false, pct: 10 };
      state.assumptions.feeShare.enabled = e.target.checked;
      syncFeeShare(); renderMonthly(); renderSummary(); markDirty();
    });
    if (fsPct) fsPct.addEventListener('input', e => {
      state.assumptions.feeShare = state.assumptions.feeShare || { enabled: false, pct: 10 };
      state.assumptions.feeShare.pct = parseFloat(e.target.value) || 0;
      renderMonthly(); renderSummary(); markDirty();
    });
    // Reconcile to proposal
    const fitBtn = $('#fit-btn');
    if (fitBtn) fitBtn.addEventListener('click', fitToTarget);
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
      markDirty();
    });
    $('#pm-industry').addEventListener('change', e => { state.project.industry = e.target.value; markDirty(); });
    const ratingSelEl = $('#pm-rating');
    if (ratingSelEl) ratingSelEl.addEventListener('change', e => { state.project.rating = parseInt(e.target.value) || null; updateStatusRatingHints(); markDirty(); });
    $('#pm-firstProposal').addEventListener('input', e => { state.project.firstProposalDate = e.target.value; markDirty(); });
    $('#pm-signed').addEventListener('input', e => { state.project.signedContractDate = e.target.value; markDirty(); });
    $('#pm-clientContact').addEventListener('input', e => { state.project.clientContact = e.target.value; markDirty(); });
    $('#pm-clientRel').addEventListener('change', e => {
      const l = STORE.leaderById(e.target.value);
      state.project.clientRelOwner = l ? l.displayName : '';
      state.project.clientRelOwnerId = l ? l.id : '';
      markDirty();
    });

    // Timeline
    const tlChange = () => {
      state.timeline.startMonth = parseInt($('#tl-start-month').value);
      state.timeline.startYear  = parseInt($('#tl-start-year').value);
      state.timeline.endMonth   = parseInt($('#tl-end-month').value);
      state.timeline.endYear    = parseInt($('#tl-end-year').value);
      renderAll();
      markDirty();
    };
    ['#tl-start-month','#tl-start-year','#tl-end-month','#tl-end-year'].forEach(s => {
      $(s).addEventListener('change', tlChange);
      $(s).addEventListener('input', tlChange);
    });

    // Assumptions
    $('#a-hrs').addEventListener('input',  e => { state.assumptions.hrsPerMo = parseFloat(e.target.value) || 0; renderSummary(); renderMatrix(); renderMonthly(); markDirty(); });
    $('#a-esc').addEventListener('input',  e => { state.assumptions.escalation = parseFloat(e.target.value) || 0; renderSummary(); renderMatrix(); renderMonthly(); renderSelectedRoles(); renderFloorCheck(); markDirty(); });
    $('#a-ind').addEventListener('input',  e => { state.assumptions.industryAdj = parseFloat(e.target.value) || 0; renderCatalog(); renderSelectedRoles(); renderSummary(); renderMatrix(); renderMonthly(); renderFloorCheck(); markDirty(); });
    $('#a-disc').addEventListener('input', e => { state.assumptions.discount = parseFloat(e.target.value) || 0; renderSummary(); renderMatrix(); renderMonthly(); renderSelectedRoles(); renderFloorCheck(); markDirty(); });
    $('#a-lock').addEventListener('change', e => { state.assumptions.rateLock = e.target.checked; renderSummary(); renderMatrix(); renderMonthly(); renderSelectedRoles(); renderFloorCheck(); markDirty(); });

    // Header actions
    $('#reset-btn').addEventListener('click', () => {
      if (!confirm('Reset all fields to a blank project? (Existing saved record will be cleared.)')) return;
      state = DEFAULT_STATE();
      setProjectIdInUrl(null);
      renderAll();
      setSavedLabel('');
    });
    $('#save-btn').addEventListener('click', () => {
      saveToStore({ explicit: true });
    });
    $('#print-btn').addEventListener('click', () => {
      window.print();
    });
    $('#xlsx-btn').addEventListener('click', exportExcel);
    $('#intake-btn').addEventListener('click', () => {
      const leadObj = STORE.resolveLeader(state.project.leadId || state.project.lead);
      window.UFC_Intake.openIntake(state, {
        netFee: netTotal(),
        serviceLines: STORE.projectServiceLines ? STORE.projectServiceLines(state) : [],
        leadName: leadObj ? leadObj.displayName : (state.project.lead || ''),
        statusLabel: STORE.STATUS_LABELS[state.project.status] || '',
        reflag: !!(state.intakeSnapshot && state.intakeSnapshot !== window.UFC_Intake.intakeSignature(state, netTotal())),
      });
      // Snapshot the fee+schedule so future drift re-flags the button.
      state.intakeSnapshot = window.UFC_Intake.intakeSignature(state, netTotal());
      updateIntakeButton();
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
    getMonths,
    getMonthsByPhase,
    rateForYear,
    unlockedRateForYear,
    monthlyFee,
    monthlyLockCredit,
    rolePhaseFee,
    phaseTotal,
    grossTotal,
    lockCredit,
    discountAmt,
    netTotal,
    totalFteMonths,
    getTitle,
    getTier,
    getGroup,
    effectiveMinRate,
    roleCostFloor,
    roleFloorViolation,
    CATALOG,
  };

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  /* ----- Excel export ----- */
  async function exportExcel() {
    if (typeof ExcelJS === 'undefined') { alert('Excel library failed to load.'); return; }
    const btn = $('#xlsx-btn');
    const orig = btn.textContent;
    btn.textContent = 'Building…';
    btn.disabled = true;
    try {
      await window.UFC_buildAndDownloadExcel();
    } catch (e) {
      console.error(e);
      alert('Excel export failed: ' + e.message);
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
        if (!STORE.isAdmin() && !STORE.userOwnsProject(rec)) {
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
      } else {
        setSavedLabel('Project not found');
      }
    }
    renderAll();
    };
    // Gate on the data layer (instant on localStorage; pulls from Box when enabled).
    if (window.ufcReady && window.ufcReady.then) { window.ufcReady.then(start); } else { start(); }
  });

  /* ----- Store integration ----- */
  function markDirty() {
    dirty = true;
    if (state.id) {
      // Autosave when working on an existing project
      clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => saveToStore({ silent: true }), 800);
    }
    setSavedLabel(state.id ? 'Unsaved…' : 'Not saved');
  }

  function markDirtyFromRender() {
    // Some renderers mutate state (rebalancePhases, reconcileRoleFte). Don't autosave on init.
  }

  function saveToStore(opts = {}) {
    try {
      const record = JSON.parse(JSON.stringify(state));
      const saved = STORE.saveProject(record);
      state.id = saved.id;
      state.createdAt = saved.createdAt;
      state.updatedAt = saved.updatedAt;
      setProjectIdInUrl(saved.id);
      setSavedLabel('Saved · ' + formatTime(saved.updatedAt));
      dirty = false;
      if (opts.explicit) {
        const btn = $('#save-btn');
        const o = btn.textContent;
        btn.textContent = 'Saved ✓';
        setTimeout(() => { btn.textContent = o; }, 1100);
      }
    } catch (e) {
      console.error('Save failed', e);
      alert('Save failed: ' + e.message);
    }
  }

  function setSavedLabel(text) {
    const el = $('#hdr-saved');
    if (el) el.textContent = text || '';
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
