/* ============================================================
   SAVILLS PPM · UNIVERSAL FEE CALCULATOR
   Rates Catalog — PRODUCTION (Macro 2024 Hourly Rate Grid)

   Source: "MACRO 2024 Hourly Rate Grid" (updated 9/9/2024).
   HIGHLY CONFIDENTIAL — internal use only.

   ── How the grid maps into this catalog ──────────────────────
   • Col B  "2023/2024 Rack/Standard Hourly Rate"  → the 2024 BASE RATE.
            This is the anchor for each title family and is used as the
            MID billable tier.
   • Col E  "Base Rates for PowerBI"  → the COST RATE = the LOWEST rate
            we may bill for that role, INCLUSIVE of any discount.
            Where Col E is blank in the source, Col G "Base Rates for
            Clockify" carries the same floor and is used instead.
   • Col F  "SA Check / Annual Fee"  ≈ cost rate × 2,064 hrs (sanity).
   • Col H  "Target Rate (% discount from Rack)"  → stored as targetDiscPct.

   ── High / Mid / Low ─────────────────────────────────────────
   Each family's rack rate (Col B) is the MID tier. HIGH and LOW are
   extrapolated by HML_SPREAD (default ±10%). The cost-rate FLOOR for
   each tier comes from the grid's three sub-levels (1 / 2 / 3):
   sub-level 1 → High, 2 → Mid, 3 → Low.

   To switch to the alternative "midway between this family and the
   adjacent family" method, set HML_MODE = 'midway' below.
   ============================================================ */

(function () {
  'use strict';

  /* The single knob for High/Low spread off the Col B rack rate. */
  const HML_SPREAD = 0.10;          // ±10% off the Mid (rack) rate
  const HML_MODE   = 'percent';     // 'percent' | 'midway'
  const ANNUAL_HRS = 2064;          // Col F basis (cost rate × 2,064 ≈ annual fee)

  const round = (n) => Math.round(n);

  /* ── Raw grid data, transcribed from the Macro 2024 PDF ──────
     rack      = Col B (2024 base / rack rate)
     floor     = { high, mid, low } cost floors from Col E (→ Col G fallback)
                 mapped from sub-levels 1 / 2 / 3
     comcastRE = Col C, comcastMC = Col D (reference only)
     targetDisc= Col H target discount off rack (reference only)        */
  const GRID = [
    { id: 'principal',    name: 'Principal',                  group: 'advisory',
      rack: 455, floor: { high: 380, mid: 380, low: 380 },
      comcastRE: null, comcastMC: null, targetDisc: null,
      note: 'Top of house. Source grid only partially populated for Principal — confirm rack & floor. Often a no-charge / PIC role under a standing relationship.' },

    { id: 'evp',          name: 'Executive Vice President',   group: 'core',
      rack: 455, floor: { high: 415, mid: 390, low: 375 },
      comcastRE: 380, comcastMC: 390, targetDisc: 14,
      note: 'Maps from Managing Director & EVP staff titles.' },

    { id: 'ed',           name: 'Executive Director',         group: 'core',
      rack: 428, floor: { high: 351, mid: 325, low: 313 },
      comcastRE: 380, comcastMC: 325, targetDisc: 24 },

    { id: 'sd',           name: 'Senior Director',            group: 'core',
      rack: 401, floor: { high: 279, mid: 260, low: 255 },
      comcastRE: 335, comcastMC: 260, targetDisc: 35 },

    { id: 'director',     name: 'Director',                   group: 'core',
      rack: 369, floor: { high: 250, mid: 220, low: 213 },
      comcastRE: 305, comcastMC: 220, targetDisc: 40,
      note: 'Maps from Director, Director (Client Services / Operations).' },

    { id: 'assoc-dir',    name: 'Associate Director',         group: 'core',
      rack: 337, floor: { high: 201, mid: 195, low: 191 },
      comcastRE: 295, comcastMC: 250, targetDisc: 42 },

    { id: 'senior-pm',    name: 'Senior Project Manager',     group: 'core',
      rack: 321, floor: { high: 182, mid: 175, low: 157 },
      comcastRE: 275, comcastMC: 195, targetDisc: 45,
      note: 'Maps from Senior Manager, Senior Program Manager, Senior PM.' },

    { id: 'pm',           name: 'Project Manager',            group: 'core',
      rack: 284, floor: { high: 138, mid: 125, low: 109 },
      comcastRE: 190, comcastMC: 180, targetDisc: 56,
      note: 'Maps from Manager, Program Manager, Administrative Manager, PM.' },

    { id: 'assistant-pm', name: 'Assistant Project Manager',  group: 'field',
      rack: 203, floor: { high: 90, mid: 80, low: 78 },
      comcastRE: 165, comcastMC: 165, targetDisc: 61,
      note: 'Maps from Associate Project Manager, Senior Associate.' },

    { id: 'cost-control', name: 'Cost Control & Data Analysis', group: 'core',
      rack: 182, floor: { high: 74, mid: 70, low: 66 },
      comcastRE: 135, comcastMC: 155, targetDisc: 62,
      note: 'Reporting & analysis / data roles.' },

    { id: 'proj-coord',   name: 'Project Coordinator',        group: 'field',
      rack: 182, floor: { high: 63, mid: 60, low: 56 },
      comcastRE: 135, comcastMC: 155, targetDisc: 67,
      note: 'Maps from Project Coordinator, Program Coordinator.' },
  ];

  /* ── Derive High / Mid / Low billable rates from the rack rate ── */
  function tiersFor(fam, idx, all) {
    const rack = fam.rack;
    let hi, lo;
    if (HML_MODE === 'midway') {
      // Midway between this family's rack and the adjacent family's rack.
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

  const titles = GRID.map((fam, idx, all) => ({
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

  /* ── Page 2: Macro Title → Rate Level mapping ────────────────
     Bridges arbitrary HR / "Savills" staff titles to a rate family
     + tier. Used to normalise a person's staff title to a billable
     level (and, in ingestion, to back into a role from a parsed rate).
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

  /* ── Legacy alias: resolve old placeholder catalog ids so any
     project saved against the pre-production catalog still loads.
     Maps old titleId → new {titleId, tierId}.                     */
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

  window.RATES_CATALOG = {
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
    titles,
    staffTitleMap,
    legacyAlias,
  };
})();
