/* ============================================================
   SAVILLS PPM · BENCHMARKING · data layer
   Reads project records from the store and derives per-role
   rate facts consistent with the calculator:
     • quoted rate   — start-year rate, before client discount
     • effective rate— quoted × (1 − client discount)   ← what client paid
     • cost floor     — tier's Col E / Col G floor (constant)
     • below floor    — effective < floor (potentially unprofitable)
   Per-project rollups add the staffing plan (FTE-months, team mix by
   title, FTE by phase), fee intensity (per month, per FTE-month, blended
   effective rate) and the cohort statistics the "Benchmark a proposal"
   view reads. Change orders, dead pursuits and no-charge roles never
   enter a benchmark: benchmarkable() is the one gate.
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
    const hrs = p.assumptions.hrsPerMo || STORE.PRICING_HOURS_PER_MONTH;
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
          projectType: p.project?.projectType || '',
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

  /* ---------- What may be benchmarked ---------- */
  const REALISED = new Set(['won', 'active', 'closed']);
  const HOURS = () => STORE.PRICING_HOURS_PER_MONTH || 173.33;
  /** Records that count: a priced proposal in its own right. Change orders
      ride on their parent and dead pursuits (lost, or rated 7) never
      happened — neither belongs in a rate or staffing statistic. */
  function benchmarkable(projects) {
    return (projects || []).filter(p => p && p.project
      && !(STORE.isChangeOrder && STORE.isChangeOrder(p))
      && !(STORE.isDeadPursuit && STORE.isDeadPursuit(p)));
  }
  /** A role that is actually priced: no-charge tiers and $0 contracted rates
      are left out of every rate AND staffing statistic. */
  function priced(role, p) { return rateAtYear(role, p, p.timeline && p.timeline.startYear) > 0; }

  const SIZE_BANDS = [
    { key: '< $500K', test: (v) => v < 5e5 },
    { key: '$500K–1M', test: (v) => v >= 5e5 && v < 1e6 },
    { key: '$1M–3M', test: (v) => v >= 1e6 && v < 3e6 },
    { key: '$3M–5M', test: (v) => v >= 3e6 && v < 5e6 },
    { key: '$5M+', test: (v) => v >= 5e6 },
  ];
  const sizeBand = (v) => (SIZE_BANDS.find(b => b.test(v)) || SIZE_BANDS[SIZE_BANDS.length - 1]).key;

  /** Priced FTE per month of the plan: [{ ym, year, month, phaseId, total, byTitle }]. */
  function fteByMonth(p) {
    const months = STORE.computeMonthsByPhase(p);
    const out = [];
    const roles = (p.roles || []).map(r => ({ r, title: tierOf(r).title })).filter(x => x.title && priced(x.r, p));
    (p.phases || []).forEach(ph => (months[ph.id] || []).forEach(m => {
      const mk = m.year + '-' + m.month;
      const row = { ym: mk, year: m.year, month: m.month, phaseId: ph.id, total: 0, byTitle: {} };
      roles.forEach(({ r, title }) => {
        const fte = (r.fteMonthly && r.fteMonthly[mk] != null ? r.fteMonthly[mk] : (r.fte?.[ph.id] || 0)) / 100;
        if (!fte) return;
        row.total += fte;
        row.byTitle[title.id] = (row.byTitle[title.id] || 0) + fte;
      });
      out.push(row);
    }));
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
      const fm = fteByMonth(p);
      const fteMonths = facts.reduce((s, f) => s + f.fteMonths, 0);
      const hrs = p.assumptions?.hrsPerMo || HOURS();
      const net = fin.net || 0;

      // Team mix: share of the plan's FTE-months by staff title.
      const mixMap = {};
      facts.forEach(f => {
        const m = mixMap[f.titleId] || (mixMap[f.titleId] = { titleId: f.titleId, titleName: f.titleName, fteMonths: 0, fee: 0, roles: 0 });
        m.fteMonths += f.fteMonths; m.fee += f.fee; m.roles += 1;
      });
      const mix = CATALOG.titles.map(t => mixMap[t.id]).filter(Boolean)
        .map(m => Object.assign(m, { pct: fteMonths ? m.fteMonths / fteMonths * 100 : 0 }));

      // FTE by phase.
      const byPhase = (p.phases || []).map(ph => {
        const rows = fm.filter(m => m.phaseId === ph.id);
        const ftem = rows.reduce((s, m) => s + m.total, 0);
        const byTitle = {};
        rows.forEach(m => Object.keys(m.byTitle).forEach(t => { byTitle[t] = (byTitle[t] || 0) + m.byTitle[t]; }));
        return { id: ph.id, name: ph.name || 'Phase', months: rows.length, fteMonths: ftem,
          avgFte: rows.length ? ftem / rows.length : 0, pct: fteMonths ? ftem / fteMonths * 100 : 0, byTitle };
      });

      // Rates by title (this project only).
      const ratesByTitle = {};
      facts.forEach(f => {
        const r = ratesByTitle[f.titleId] || (ratesByTitle[f.titleId] = { n: 0, quoted: [], eff: [], floor: 0, below: 0 });
        r.n++; r.quoted.push(f.quoted); r.eff.push(f.effective); r.floor = Math.max(r.floor, f.floor); if (f.belowFloor) r.below++;
      });
      Object.values(ratesByTitle).forEach(r => { r.quotedMed = median(r.quoted); r.effMed = median(r.eff); });

      const status = p.project?.status || '';
      const pj = p.project || {};
      return {
        id: p.id,
        name: pj.name || 'Untitled',
        client: pj.client || '',
        lead: STORE.leaderDisplay ? STORE.leaderDisplay(pj.leadId || pj.lead) : (pj.lead || ''),
        industry: pj.industry || '',
        projectType: pj.projectType || '',
        status,
        realised: REALISED.has(status),
        startYear: p.timeline?.startYear,
        durationMonths: months,
        gross: fin.gross,
        net,
        sizeBand: sizeBand(net),
        discountPct: p.assumptions?.discount || 0,
        hrsPerMo: hrs,
        roleCount: (p.roles || []).length,
        pricedRoles: facts.length,
        belowFloorCount: facts.filter(f => f.belowFloor).length,
        pctBelowFloor: facts.length ? facts.filter(f => f.belowFloor).length / facts.length * 100 : 0,
        fteMonths,
        hasPlan: fteMonths > 0,
        avgFte: months ? fteMonths / months : 0,
        peakFte: fm.reduce((m, r) => Math.max(m, r.total), 0),
        feePerMonth: months ? net / months : 0,
        feePerFteMonth: fteMonths ? net / fteMonths : 0,
        blendedRate: fteMonths ? net / (fteMonths * hrs) : 0,
        mix,
        byPhase,
        ratesByTitle,
        fteByMonth: fm,
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
  function spread(arr) {
    const v = arr.filter(x => x != null && isFinite(x));
    return { n: v.length, min: v.length ? Math.min(...v) : 0, p25: quantile(v, 0.25), med: median(v), p75: quantile(v, 0.75), max: v.length ? Math.max(...v) : 0, values: v };
  }
  /** Where a value sits in a sample, 0–100 (ties count half). null when the sample is empty. */
  function percentileOf(v, arr) {
    const s = (arr || []).filter(x => x != null && isFinite(x));
    if (!s.length || v == null || !isFinite(v)) return null;
    let below = 0, equal = 0;
    s.forEach(x => { if (x < v) below++; else if (x === v) equal++; });
    return Math.round((below + equal / 2) / s.length * 100);
  }

  /** The headline metrics a proposal is positioned on. `plan` metrics only
      read projects that carry a staffing plan; `lowerBetter` flips the
      reading of a high percentile. */
  const METRICS = [
    { key: 'net', label: 'Net fee', fmt: 'money' },
    { key: 'durationMonths', label: 'Duration', fmt: 'months' },
    { key: 'feePerMonth', label: 'Fee per month', fmt: 'money' },
    { key: 'feePerFteMonth', label: 'Fee per FTE-month', fmt: 'money', plan: true },
    { key: 'blendedRate', label: 'Blended effective rate', fmt: 'rate', plan: true, hint: 'net fee ÷ (FTE-months × hours per month)' },
    { key: 'discountPct', label: 'Client discount', fmt: 'pct', lowerBetter: true },
    { key: 'avgFte', label: 'Average team size', fmt: 'fte', plan: true },
    { key: 'peakFte', label: 'Peak team size', fmt: 'fte', plan: true },
    { key: 'pricedRoles', label: 'Priced roles', fmt: 'int' },
    { key: 'pctBelowFloor', label: 'Roles below cost floor', fmt: 'pct', plan: true, lowerBetter: true },
  ];

  /** Cohort statistics over a set of project facts: per-metric spreads, team
      mix by title (share when staffed + how often staffed), and effective
      rates by title (one median per project so a big team doesn't outvote). */
  function cohortStats(fs) {
    const out = { n: fs.length, realised: fs.filter(f => f.realised).length, metrics: {}, mix: {}, rates: {} };
    METRICS.forEach(m => {
      const pool = m.plan ? fs.filter(f => f.hasPlan) : fs;
      out.metrics[m.key] = spread(pool.map(f => f[m.key]));
    });
    const withPlan = fs.filter(f => f.hasPlan);
    CATALOG.titles.forEach(t => {
      const shares = withPlan.map(f => (f.mix.find(x => x.titleId === t.id) || {}).pct || 0);
      const used = shares.filter(v => v > 0);
      if (!used.length) return;
      out.mix[t.id] = Object.assign(spread(used), { titleName: t.name, projects: withPlan.length, usedOn: used.length,
        usedPct: withPlan.length ? used.length / withPlan.length * 100 : 0, all: spread(shares) });
    });
    CATALOG.titles.forEach(t => {
      const eff = fs.map(f => f.ratesByTitle[t.id] && f.ratesByTitle[t.id].effMed).filter(v => v > 0);
      if (!eff.length) return;
      const quoted = fs.map(f => f.ratesByTitle[t.id] && f.ratesByTitle[t.id].quotedMed).filter(v => v > 0);
      const floors = t.tiers.filter(x => !x.isNoCharge).map(x => x.costFloor || 0);
      out.rates[t.id] = Object.assign(spread(eff), { titleName: t.name, quoted: spread(quoted), rack: t.rackRate,
        floorLow: floors.length ? Math.min(...floors) : 0, floorHigh: floors.length ? Math.max(...floors) : 0 });
    });
    return out;
  }

  /** Nearest comparables: distance in log-fee, duration and team size. */
  function nearest(target, fs, k) {
    const scale = (vals) => { const s = spread(vals); return (s.p75 - s.p25) || (s.max - s.min) || 1; };
    const lf = (f) => Math.log10(Math.max(1, f.net || 1));
    const sF = scale(fs.map(lf)), sD = scale(fs.map(f => f.durationMonths)), sT = scale(fs.map(f => f.avgFte));
    return fs.filter(f => f.id !== target.id).map(f => {
      const d = Math.sqrt(
        Math.pow((lf(f) - lf(target)) / sF, 2) +
        Math.pow((f.durationMonths - target.durationMonths) / sD, 2) +
        (target.hasPlan && f.hasPlan ? Math.pow((f.avgFte - target.avgFte) / sT, 2) : 0));
      return { f, d };
    }).sort((a, b) => a.d - b.d).slice(0, k || 5).map(x => x.f);
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

  /* The fabricated sample book (real company names, invented staff) is gone.
     Its seeder had no caller; removeSamples stays so a book that still holds
     a legacy sample record purges it on the next Benchmarking open. */
  function removeSamples() {
    STORE.listProjects().filter(p => p.source?.type === 'sample').forEach(p => STORE.deleteProject(p.id));
  }

  window.BENCH = {
    benchmarkable, priced, SIZE_BANDS, sizeBand, fteByMonth,
    roleFacts, projectFacts, statsByTitle, median, quantile, spread, percentileOf,
    METRICS, cohortStats, nearest,
    removeSamples,
    rateAtYear, tierOf,
  };
})();
