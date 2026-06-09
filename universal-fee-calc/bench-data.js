/* ============================================================
   SAVILLS PPM · BENCHMARKING · data layer
   Reads project records from the store and derives per-role
   rate facts consistent with the calculator:
     • quoted rate   — start-year rate, before client discount
     • effective rate— quoted × (1 − client discount)   ← what client paid
     • cost floor     — tier's Col E / Col G floor (constant)
     • below floor    — effective < floor (potentially unprofitable)
   Plus a realistic sample dataset so the dashboard has data to show.
   ============================================================ */
(function () {
  'use strict';
  const CATALOG = window.RATES_CATALOG;
  const STORE = window.UFC_Store;

  /* ---------- Rate math (mirrors app.js) ---------- */
  function tierOf(role) {
    const title = CATALOG.titles.find(t => t.id === role.titleId);
    if (!title) return { title: null, tier: null };
    const tier = title.tiers.find(x => x.id === role.tierId) || title.tiers.find(x => x.id === 'mid') || title.tiers[0];
    return { title, tier };
  }
  function roleBase(role, p) {
    if (role.rateSource === 'contracted') {
      const cr = parseFloat(role.contractedRate);
      return { base: isNaN(cr) ? 0 : cr, anchor: p.timeline.startYear };
    }
    const { tier } = tierOf(role);
    if (!tier || tier.isNoCharge) return { base: 0, anchor: p.assumptions.catalogBaseYear || CATALOG.baseYear };
    const adj = (p.assumptions.industryAdj || 0) / 100;
    return { base: tier.rate * (1 - adj), anchor: p.assumptions.catalogBaseYear || CATALOG.baseYear };
  }
  function rateAtYear(role, p, year) {
    const { base, anchor } = roleBase(role, p);
    if (!base) return 0;
    const esc = (p.assumptions.escalation || 0) / 100;
    if (p.assumptions.rateLock) return base * Math.pow(1 + esc, (p.timeline.startYear) - anchor);
    return base * Math.pow(1 + esc, year - anchor);
  }
  function roleFteMonths(role, p) {
    const months = STORE.computeMonthsByPhase(p);
    return (p.phases || []).reduce((s, ph) => s + (months[ph.id] || []).reduce((a, m) => {
      const mk = m.year + '-' + m.month;
      return a + ((role.fteMonthly && role.fteMonthly[mk] != null ? role.fteMonthly[mk] : (role.fte?.[ph.id] || 0)) / 100);
    }, 0), 0);
  }
  function roleFee(role, p) {
    const hrs = p.assumptions.hrsPerMo || 173.33;
    const months = STORE.computeMonthsByPhase(p);
    let fee = 0;
    (p.phases || []).forEach(ph => {
      (months[ph.id] || []).forEach(m => {
        const mk = m.year + '-' + m.month;
        const fte = (role.fteMonthly && role.fteMonthly[mk] != null ? role.fteMonthly[mk] : (role.fte?.[ph.id] || 0)) / 100;
        if (!fte) return;
        fee += fte * rateAtYear(role, p, m.year) * hrs;
      });
    });
    return fee;
  }

  /* ---------- Per-role facts across all projects ---------- */
  function roleFacts(projects) {
    const out = [];
    (projects || []).forEach(p => {
      const discPct = (p.assumptions?.discount || 0) / 100;
      const startYear = p.timeline?.startYear;
      const groupName = (gid) => (p.groups || []).find(g => g.id === gid)?.name || '';
      (p.roles || []).forEach(r => {
        const { title, tier } = tierOf(r);
        if (!title) return;
        const quoted = rateAtYear(r, p, startYear);
        if (!quoted) return;                       // no-charge / unpriced → skip from rate stats
        const effective = quoted * (1 - discPct);
        const floor = (tier && !tier.isNoCharge) ? (tier.costFloor || 0) : 0;
        out.push({
          projectId: p.id,
          projectName: p.project?.name || 'Untitled',
          client: p.project?.client || '',
          industry: p.project?.industry || '',
          status: p.project?.status || '',
          startYear,
          titleId: title.id,
          titleName: title.name,
          tierId: tier?.id,
          tierLabel: tier?.label || '',
          projectRole: r.projectRole || '',
          team: groupName(r.groupId),
          resource: r.resource || '',
          rateSource: r.rateSource || 'grid',
          quoted,
          effective,
          floor,
          belowFloor: floor > 0 && effective < floor - 0.005,
          fteMonths: roleFteMonths(r, p),
          fee: roleFee(r, p),
        });
      });
    });
    return out;
  }

  /* ---------- Per-project rollup ---------- */
  function projectFacts(projects) {
    return (projects || []).map(p => {
      const fin = STORE.projectFinancials(p, (r) => {
        // base-year-equivalent rate so the store's escalation math reproduces ours
        const { base, anchor } = roleBase(r, p);
        const baseYear = p.assumptions.catalogBaseYear || CATALOG.baseYear;
        const esc = (p.assumptions.escalation || 0) / 100;
        return base * Math.pow(1 + esc, baseYear - anchor); // re-anchor to baseYear (cancels store's year-baseYear)
      });
      const months = STORE.enumerateMonths(p.timeline).length;
      const facts = roleFacts([p]);
      return {
        id: p.id,
        name: p.project?.name || 'Untitled',
        client: p.project?.client || '',
        industry: p.project?.industry || '',
        status: p.project?.status || '',
        startYear: p.timeline?.startYear,
        durationMonths: months,
        gross: fin.gross,
        net: fin.net,
        discountPct: p.assumptions?.discount || 0,
        roleCount: (p.roles || []).length,
        belowFloorCount: facts.filter(f => f.belowFloor).length,
        isSample: p.source?.type === 'sample',
        roleFacts: facts,
      };
    });
  }

  /* ---------- Stats helpers ---------- */
  function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function quantile(arr, q) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const pos = (s.length - 1) * q;
    const base = Math.floor(pos), rest = pos - base;
    return s[base + 1] !== undefined ? s[base] + rest * (s[base + 1] - s[base]) : s[base];
  }

  /** Group role facts by staff title → summary stats. */
  function statsByTitle(facts) {
    const order = CATALOG.titles.map(t => t.id);
    const groups = {};
    facts.forEach(f => { (groups[f.titleId] = groups[f.titleId] || []).push(f); });
    return order.filter(id => groups[id]).map(id => {
      const g = groups[id];
      const q = g.map(x => x.quoted), e = g.map(x => x.effective);
      const title = CATALOG.titles.find(t => t.id === id);
      const floors = title.tiers.filter(t => !t.isNoCharge).map(t => t.costFloor);
      return {
        titleId: id,
        titleName: title.name,
        rack: title.rackRate,
        floorLow: Math.min(...floors),
        floorHigh: Math.max(...floors),
        n: g.length,
        quotedMin: Math.min(...q), quotedMed: median(q), quotedMax: Math.max(...q),
        effMin: Math.min(...e), effMed: median(e), effMax: Math.max(...e),
        belowFloor: g.filter(x => x.belowFloor).length,
        items: g,
      };
    });
  }

  /* ============================================================
     SAMPLE DATASET — realistic historicals across industries
     ============================================================ */
  function uid() { return 'r' + Math.random().toString(36).slice(2, 9); }
  function ph(name, length) { return { id: uid(), name, length }; }
  // role(titleId, tierId, projectRole, teamIdx, allocPct, contractedRate?)
  function mkProject(spec) {
    const groups = spec.teams.map(n => ({ id: uid(), name: n }));
    const phases = spec.phases.map(p => ph(p[0], p[1]));
    const roles = spec.roles.map(r => {
      const fte = {};
      phases.forEach(p => fte[p.id] = r.alloc);
      return {
        id: uid(),
        titleId: r.title, tierId: r.tier,
        resource: r.name || 'TBD',
        projectRole: r.role || '',
        rateSource: r.contracted != null ? 'contracted' : 'grid',
        contractedRate: r.contracted != null ? r.contracted : null,
        groupId: groups[r.team || 0].id,
        fte,
      };
    });
    const dur = phases.reduce((s, p) => s + p.length, 0);
    const endTotal = (spec.startMonth - 1) + dur - 1;
    return {
      id: 'sample_' + spec.key,
      project: { name: spec.name, client: spec.client, lead: spec.lead || '', industry: spec.industry,
        status: spec.status, proposalDate: spec.proposalDate || '', location: spec.location || '',
        clientContact: '', clientRelOwner: '' },
      timeline: { startMonth: spec.startMonth, startYear: spec.startYear,
        endMonth: (endTotal % 12) + 1, endYear: spec.startYear + Math.floor(endTotal / 12) },
      phases, groups, roles,
      assumptions: { hrsPerMo: 173.33, escalation: 3.0, industryAdj: 20,
        discount: spec.discount || 0, rateLock: !!spec.rateLock, catalogBaseYear: CATALOG.baseYear },
      source: { type: 'sample', name: 'seeded sample', ingestedAt: new Date().toISOString() },
      createdAt: new Date(spec.startYear, spec.startMonth - 1, 1).toISOString(),
    };
  }

  const SAMPLE_SPECS = [
    { key: 'amex', key2: 1, name: 'AMEX HQ Relocation & Change Mgmt', client: 'American Express', industry: 'Financial Services',
      status: 'won', lead: 'K. Spiegel', startMonth: 6, startYear: 2026, discount: 9,
      teams: ['Change Management', 'Relocation Management'],
      phases: [['Discovery', 3], ['Design', 9], ['Construction', 28], ['Closeout', 8]],
      roles: [
        { title: 'evp', tier: 'mid', name: 'Benay Josselson', role: 'Executive Sponsor', team: 0, alloc: 10, contracted: 300 },
        { title: 'sd', tier: 'mid', name: 'Kathy Spiegel', role: 'Project Principal', team: 1, alloc: 100, contracted: 234 },
        { title: 'senior-pm', tier: 'mid', name: 'Artie Benoit', role: 'PM & Administration', team: 1, alloc: 100, contracted: 170 },
        { title: 'pm', tier: 'mid', name: 'Mike DeLeo', role: 'Logistics Planning', team: 1, alloc: 20, contracted: 190 },
        { title: 'senior-pm', tier: 'low', name: 'Sarah Alim', role: 'Reporting & Analysis', team: 1, alloc: 100, contracted: 155 },
        { title: 'director', tier: 'mid', name: 'Kelly Creighton', role: 'Change Principal', team: 0, alloc: 50, contracted: 300 },
        { title: 'assoc-dir', tier: 'mid', name: 'Alli Hochberg', role: 'Comms & LOB Lead', team: 0, alloc: 30, contracted: 275 },
        { title: 'proj-coord', tier: 'mid', name: 'Karenna Laufer', role: 'Comms Coordinator', team: 0, alloc: 30, contracted: 175 },
      ] },
    { key: 'bloomberg', name: 'Bloomberg Trading Floor Fit-Out', client: 'Bloomberg', industry: 'Financial Services',
      status: 'active', lead: 'D. Marsh', startMonth: 1, startYear: 2025, discount: 6,
      teams: ['Project Management', 'Cost'],
      phases: [['Pre-Construction', 5], ['Construction', 14], ['Closeout', 3]],
      roles: [
        { title: 'ed', tier: 'mid', name: 'David Marsh', role: 'Account Lead', team: 0, alloc: 15 },
        { title: 'director', tier: 'mid', name: 'Priya Nair', role: 'Project Director', team: 0, alloc: 60 },
        { title: 'senior-pm', tier: 'high', name: 'Tom Reilly', role: 'Senior PM', team: 0, alloc: 100 },
        { title: 'pm', tier: 'mid', name: 'Grace Lee', role: 'Project Manager', team: 0, alloc: 100 },
        { title: 'cost-control', tier: 'mid', name: 'Owen Black', role: 'Cost Manager', team: 1, alloc: 50 },
        { title: 'proj-coord', tier: 'mid', name: 'Maya Singh', role: 'Coordinator', team: 0, alloc: 100 },
      ] },
    { key: 'latham', name: 'Latham & Watkins Office Consolidation', client: 'Latham & Watkins', industry: 'Law',
      status: 'won', lead: 'R. Osei', startMonth: 9, startYear: 2025, discount: 12,
      teams: ['Project Management'],
      phases: [['Planning', 4], ['Design', 6], ['Construction', 12], ['Closeout', 2]],
      roles: [
        { title: 'sd', tier: 'mid', name: 'Rachel Osei', role: 'Program Lead', team: 0, alloc: 25 },
        { title: 'director', tier: 'high', name: 'Sam Whitfield', role: 'Project Director', team: 0, alloc: 80 },
        { title: 'pm', tier: 'mid', name: 'Lena Hart', role: 'Project Manager', team: 0, alloc: 100, contracted: 120 },
        { title: 'assistant-pm', tier: 'mid', name: 'Jordan Kim', role: 'Assistant PM', team: 0, alloc: 100 },
        { title: 'proj-coord', tier: 'low', name: 'Eva Roman', role: 'Coordinator', team: 0, alloc: 100 },
      ] },
    { key: 'pfizer', name: 'Pfizer Lab & Office Campus', client: 'Pfizer', industry: 'Life Sciences',
      status: 'won', lead: 'M. Chen', startMonth: 3, startYear: 2024, discount: 0,
      teams: ['Project Management', 'Cost & Controls'],
      phases: [['Programming', 4], ['Design', 10], ['Construction', 22], ['Closeout', 4]],
      roles: [
        { title: 'evp', tier: 'mid', name: 'Marcus Chen', role: 'Executive Sponsor', team: 0, alloc: 10 },
        { title: 'ed', tier: 'mid', name: 'Helen Park', role: 'Account Director', team: 0, alloc: 30 },
        { title: 'director', tier: 'mid', name: 'Nina Alvarez', role: 'Project Director', team: 0, alloc: 70 },
        { title: 'senior-pm', tier: 'mid', name: 'Carlos Ruiz', role: 'Senior PM', team: 0, alloc: 100 },
        { title: 'pm', tier: 'mid', name: 'Ade Bello', role: 'Project Manager', team: 0, alloc: 100 },
        { title: 'cost-control', tier: 'high', name: 'Wendy Cho', role: 'Cost Lead', team: 1, alloc: 75 },
        { title: 'assistant-pm', tier: 'mid', name: 'Ravi Menon', role: 'Assistant PM', team: 0, alloc: 100 },
      ] },
    { key: 'equinix', name: 'Equinix Data Center NY9 Build', client: 'Equinix', industry: 'Data Center',
      status: 'lost', lead: 'P. Nair', startMonth: 5, startYear: 2025, discount: 0,
      teams: ['Project Management'],
      phases: [['Pre-Construction', 6], ['Construction', 18], ['Commissioning', 4]],
      roles: [
        { title: 'sd', tier: 'high', name: 'TBD', role: 'Program Director', team: 0, alloc: 30 },
        { title: 'director', tier: 'high', name: 'TBD', role: 'Project Director', team: 0, alloc: 100 },
        { title: 'senior-pm', tier: 'high', name: 'TBD', role: 'MEP PM', team: 0, alloc: 100 },
        { title: 'senior-pm', tier: 'mid', name: 'TBD', role: 'Senior PM', team: 0, alloc: 100 },
        { title: 'cost-control', tier: 'mid', name: 'TBD', role: 'Cost Manager', team: 0, alloc: 50 },
      ] },
    { key: 'nike', name: 'Nike Flagship Retail Rollout', client: 'Nike', industry: 'Retail',
      status: 'active', lead: 'G. Lee', startMonth: 2, startYear: 2026, discount: 6,
      teams: ['Program Management', 'Field'],
      phases: [['Prototype', 3], ['Rollout Wave 1', 9], ['Rollout Wave 2', 9]],
      roles: [
        { title: 'director', tier: 'mid', name: 'Gemma Lawson', role: 'Program Director', team: 0, alloc: 40 },
        { title: 'senior-pm', tier: 'mid', name: 'Hugo Reyes', role: 'Rollout Lead', team: 0, alloc: 100 },
        { title: 'pm', tier: 'mid', name: 'Tina Fields', role: 'Regional PM', team: 1, alloc: 100, contracted: 100 },
        { title: 'pm', tier: 'low', name: 'Drew Olsen', role: 'Regional PM', team: 1, alloc: 100, contracted: 100 },
        { title: 'proj-coord', tier: 'mid', name: 'Bea Cortez', role: 'Field Coordinator', team: 1, alloc: 100 },
      ] },
    { key: 'nyu', name: 'NYU Academic Building Renovation', client: 'New York University', industry: 'Education',
      status: 'submitted', lead: 'S. Whitfield', startMonth: 8, startYear: 2026, discount: 0,
      teams: ['Project Management'],
      phases: [['Planning', 5], ['Design', 8], ['Construction', 16], ['Closeout', 3]],
      roles: [
        { title: 'director', tier: 'mid', name: 'TBD', role: 'Project Director', team: 0, alloc: 50 },
        { title: 'senior-pm', tier: 'mid', name: 'TBD', role: 'Senior PM', team: 0, alloc: 100 },
        { title: 'pm', tier: 'mid', name: 'TBD', role: 'Project Manager', team: 0, alloc: 100 },
        { title: 'assistant-pm', tier: 'mid', name: 'TBD', role: 'Assistant PM', team: 0, alloc: 100 },
        { title: 'proj-coord', tier: 'mid', name: 'TBD', role: 'Coordinator', team: 0, alloc: 100 },
      ] },
    { key: 'google', name: 'Google Campus Workplace Program', client: 'Google', industry: 'TAMI',
      status: 'won', lead: 'M. Chen', startMonth: 11, startYear: 2024, discount: 9,
      teams: ['Program Management', 'Change'],
      phases: [['Discovery', 4], ['Design', 8], ['Construction', 20], ['Closeout', 4]],
      roles: [
        { title: 'evp', tier: 'mid', name: 'TBD', role: 'Executive Sponsor', team: 0, alloc: 8 },
        { title: 'sd', tier: 'mid', name: 'TBD', role: 'Program Principal', team: 0, alloc: 30 },
        { title: 'director', tier: 'mid', name: 'TBD', role: 'Project Director', team: 0, alloc: 80 },
        { title: 'senior-pm', tier: 'mid', name: 'TBD', role: 'Senior PM', team: 0, alloc: 100 },
        { title: 'pm', tier: 'mid', name: 'TBD', role: 'Project Manager', team: 0, alloc: 100 },
        { title: 'assoc-dir', tier: 'mid', name: 'TBD', role: 'Change Lead', team: 1, alloc: 50 },
        { title: 'cost-control', tier: 'mid', name: 'TBD', role: 'Cost Manager', team: 0, alloc: 50 },
      ] },
  ];

  function ensureSamples() {
    const existing = STORE.listProjects();
    const hasSamples = existing.some(p => p.source?.type === 'sample');
    if (hasSamples) return 0;
    let n = 0;
    SAMPLE_SPECS.forEach(spec => { STORE.saveProject(mkProject(spec)); n++; });
    return n;
  }
  function removeSamples() {
    STORE.listProjects().filter(p => p.source?.type === 'sample').forEach(p => STORE.deleteProject(p.id));
  }

  window.BENCH = {
    roleFacts, projectFacts, statsByTitle, median, quantile,
    ensureSamples, removeSamples,
    rateAtYear, tierOf,
  };
})();
