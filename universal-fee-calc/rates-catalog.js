/* ============================================================
   SAVILLS PPM · UNIVERSAL FEE CALCULATOR
   Rates Catalog — ENGINE (no confidential numbers in this file)

   ── WHY THIS FILE HAS NO RATES ───────────────────────────────
   The confidential PPM 2024 rate grid (rack rates, cost-rate
   FLOORS, target discounts, Comcast reference rates) is NOT in the
   shipped code — anything in the deployed bundle is world-readable
   at its URL with no login. The grid lives in Box as `rates.json`
   and is pulled in only AFTER a successful Box sign-in, then handed
   to `window.RATES_CATALOG.hydrate(payload)` below.

   ── HOW IT MAPS (unchanged) ──────────────────────────────────
   • grid.rack      → 2024 BASE/rack rate = the MID billable tier.
   • grid.floor.{high,mid,low}
                    → COST-RATE FLOOR per tier (Col E → Col G fallback);
                      the lowest rate we may bill, inclusive of discount.
   • grid.comcastRE / grid.comcastMC  → reference only.
   • grid.targetDisc → target % discount off rack (reference only).

   ── High / Mid / Low ─────────────────────────────────────────
   Each family's rack rate is MID; HIGH/LOW are ±HML_SPREAD off Mid
   (or "midway to the adjacent family" when HML_MODE = 'midway').

   ── BOOT CONTRACT ────────────────────────────────────────────
   This script runs synchronously and creates window.RATES_CATALOG
   as an EMPTY-but-stable shell (titles: []), so every consumer's
   `const CATALOG = window.RATES_CATALOG` capture stays valid.
   boot.js then pulls rates.json from Box and calls
   RATES_CATALOG.hydrate(payload), which fills `titles` IN PLACE
   before window.ufcReady resolves — so by the time any page renders,
   the rates are present. `RATES_CATALOG.hydrated` flips to true.
   ============================================================ */

(function () {
  'use strict';

  /* The single knob for High/Low spread off the rack rate. */
  const HML_SPREAD = 0.10;          // ±10% off the Mid (rack) rate
  const HML_MODE   = 'percent';     // 'percent' | 'midway'
  const ANNUAL_HRS = 2064;          // cost rate × 2,064 ≈ annual fee (sanity)

  const round = (n) => Math.round(n);

  /* ── Derive High / Mid / Low billable rates from the rack rate ── */
  function tiersFor(fam, idx, all) {
    const rack = fam.rack;
    let hi, lo;
    if (HML_MODE === 'midway') {
      const upper = all[idx - 1] ? all[idx - 1].rack : rack * (1 + HML_SPREAD);
      const lower = all[idx + 1] ? all[idx + 1].rack : rack * (1 - HML_SPREAD);
      hi = round((rack + upper) / 2);
      lo = round((rack + lower) / 2);
    } else {
      hi = round(rack * (1 + HML_SPREAD));
      lo = round(rack * (1 - HML_SPREAD));
    }
    return [
      { id: 'high', label: 'High', rate: hi,   costFloor: fam.floor.high, rackRate: rack },
      { id: 'mid',  label: 'Mid',  rate: rack, costFloor: fam.floor.mid,  rackRate: rack },
      { id: 'low',  label: 'Low',  rate: lo,   costFloor: fam.floor.low,  rackRate: rack },
    ];
  }

  /* Build the `titles` array from a confidential grid array. */
  function buildTitles(grid) {
    return grid.map((fam, idx, all) => ({
      id: fam.id,
      name: fam.name,
      defaultGroup: fam.group,
      note: fam.note || '',
      rackRate: fam.rack,
      comcastRE: fam.comcastRE,
      comcastMC: fam.comcastMC,
      targetDiscPct: fam.targetDisc,
      tiers: tiersFor(fam, idx, all),
    }));
  }

  /* ── Page 2: Staff Title → Rate Level mapping (NO rates — safe in code) ──
     Bridges arbitrary HR / "Savills" staff titles to a rate family + tier.
     sublevel 1 → high tier, 2 → mid, 3 → low.                      */
  const SUB_TO_TIER = { 1: 'high', 2: 'mid', 3: 'low' };
  const staffTitleMapRaw = [
    ['Project Coordinator',                         'proj-coord',   2],
    ['Program Coordinator',                         'proj-coord',   2],
    ['Associate Project Manager',                   'assistant-pm', 2],
    ['Project Manager',                             'pm',           2],
    ['Manager',                                     'pm',           2],
    ['Administrative Manager',                      'pm',           2],
    ['Program Manager',                             'pm',           2],
    ['Manager, Human Resources',                    'pm',           2],
    ['Manager, Finance',                            'pm',           2],
    ['Manager, Business Development',               'pm',           2],
    ['Senior Associate',                            'assistant-pm', 2],
    ['Senior Manager',                              'senior-pm',    2],
    ['Senior Program Manager',                      'senior-pm',    2],
    ['Senior Project Manager',                      'senior-pm',    2],
    ['Senior Manager, Finance',                     'senior-pm',    2],
    ['Senior Graphic Designer',                     'senior-pm',    2],
    ['Associate Director',                          'assoc-dir',    2],
    ['Associate Director, Operations',              'assoc-dir',    2],
    ['Director',                                    'director',     2],
    ['Director, Client Services',                   'director',     2],
    ['Director, Operations',                        'director',     2],
    ['Senior Director',                             'sd',           2],
    ['Executive Director',                          'ed',           2],
    ['Managing Director',                           'evp',          2],
    ['Executive Vice President',                    'evp',          2],
    ['President, North America Project Management', 'principal',    1],
  ];
  const staffTitleMap = staffTitleMapRaw.map(([staffTitle, titleId, sub]) => ({
    staffTitle, titleId, tierId: SUB_TO_TIER[sub], sublevel: sub,
  }));

  /* ── Legacy alias: resolve old placeholder catalog ids (no rates). ── */
  const legacyAlias = {
    pic:         { titleId: 'principal',    tierId: 'mid' },
    pe:          { titleId: 'sd',           tierId: 'mid' },
    pm:          { titleId: 'pm',           tierId: 'mid' },
    apm:         { titleId: 'assistant-pm', tierId: 'mid' },
    lf:          { titleId: 'director',     tierId: 'mid' },
    'rep-lead':  { titleId: 'director',     tierId: 'low' },
    'rep-sup':   { titleId: 'senior-pm',    tierId: 'mid' },
    lob:         { titleId: 'senior-pm',    tierId: 'mid' },
    comms:       { titleId: 'senior-pm',    tierId: 'mid' },
    xfunc:       { titleId: 'senior-pm',    tierId: 'mid' },
    'proc-lead': { titleId: 'director',     tierId: 'mid' },
    'proc-pm':   { titleId: 'senior-pm',    tierId: 'mid' },
    tem:         { titleId: 'pm',           tierId: 'low' },
    'field-admin': { titleId: 'proj-coord', tierId: 'mid' },
    bc:          { titleId: 'assoc-dir',    tierId: 'mid' },
    cm:          { titleId: 'assoc-dir',    tierId: 'high' },
    sched:       { titleId: 'senior-pm',    tierId: 'low' },
    cost:        { titleId: 'cost-control', tierId: 'mid' },
  };

  /* ── The stable shell. titles fills in on hydrate(). ── */
  const CATALOG = {
    baseYear: 2024,
    source: 'MACRO 2024 Hourly Rate Grid (9/9/2024)',
    hmlSpread: HML_SPREAD,
    hmlMode: HML_MODE,
    annualHrs: ANNUAL_HRS,
    groups: [
      { id: 'core',     name: 'Core team' },
      { id: 'field',    name: 'Field team' },
      { id: 'advisory', name: 'PIC / Advisory' },
    ],
    titles: [],            // ← populated by hydrate() from Box rates.json
    staffTitleMap,
    legacyAlias,
    hydrated: false,

    /* Fill the catalog IN PLACE from a Box rates.json payload.
       Mutates this object so existing captured references see the data. */
    hydrate(payload) {
      const grid = payload && Array.isArray(payload.grid) ? payload.grid
                 : Array.isArray(payload) ? payload : null;
      if (!grid) throw new Error('rates payload missing grid');
      this.titles = buildTitles(grid);
      if (payload && payload.baseYear) this.baseYear = payload.baseYear;
      if (payload && payload.source)   this.source = payload.source;
      this.hydrated = true;
      try { document.dispatchEvent(new CustomEvent('ufc:rates', { detail: { count: this.titles.length } })); } catch (e) {}
      return this;
    },

    /* Build a DETACHED catalog from a payload WITHOUT mutating the live one.
       Used by Rate Grid Reconciliation to price against a candidate grid
       (dry-run) before any commit. Shares the static maps; own titles. */
    detachedFrom(payload) {
      const grid = payload && Array.isArray(payload.grid) ? payload.grid
                 : Array.isArray(payload) ? payload : null;
      if (!grid) throw new Error('rates payload missing grid');
      return {
        baseYear: (payload && payload.baseYear) || this.baseYear,
        source: (payload && payload.source) || 'candidate grid',
        hmlSpread: this.hmlSpread, hmlMode: this.hmlMode, annualHrs: this.annualHrs,
        groups: this.groups, staffTitleMap: this.staffTitleMap, legacyAlias: this.legacyAlias,
        titles: buildTitles(grid), hydrated: true, detached: true,
      };
    },
  };

  window.RATES_CATALOG = CATALOG;
})();
