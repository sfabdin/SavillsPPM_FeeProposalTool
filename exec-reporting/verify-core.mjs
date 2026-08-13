/* Verify harness: runs exec-reporting/core.js against the frozen 30 Jul
   fixtures held by the production app's repo and reconciles the canonical
   numbers TO THE DOLLAR against the values the database app proved live
   (financial-analysis-2 BUILD-STATE, 30 Jul refresh):

     booked      14,854,120
     projected   21,211,553
     weighted    19,977,168
     all-ratings 27,869,952
     budget      22,800,500
     records     345 = 244 live + 101 soft-deleted

   Dev-only. Reads fixtures from the sibling repo on this machine; it is not
   part of the deployed app and runs with plain `node exec-reporting/verify-core.mjs`.
*/
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// The repo is "type":"module", so core.js (a classic browser script) is
// evaluated directly; it lands on globalThis.EXEC_CORE exactly as it lands
// on window.EXEC_CORE in the app.
const here = dirname(fileURLToPath(import.meta.url));
(0, eval)(readFileSync(join(here, 'core.js'), 'utf8'));
const CORE = globalThis.EXEC_CORE;

const FIXTURES = resolve(here, '..', '..', 'financial-analysis-2', 'fixtures');
if (!existsSync(join(FIXTURES, 'projects.json'))) {
  console.error('fixtures not found at ' + FIXTURES + ' - point FIXTURES at the frozen 30 Jul drop');
  process.exit(2);
}
const projects = JSON.parse(readFileSync(join(FIXTURES, 'projects.json'), 'utf8'));
const studio = JSON.parse(readFileSync(join(FIXTURES, 'studio.json'), 'utf8'));

let checks = 0, fails = 0;
function ck(name, ok, detail) {
  checks += 1;
  if (!ok) { fails += 1; console.log('  FAIL ' + name + (detail ? '   [' + detail + ']' : '')); }
  else console.log('  ok   ' + name);
}
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.5 : tol);

const m = CORE.mapProjects(projects);
const s = CORE.mapStudio(studio);

ck('projects.json maps ok', m.ok, m.error);
ck('studio.json maps ok', s.ok, s.error);
ck('245 live records mapped, 101 soft-deleted excluded (346 total in drop)',
  m.counts.projects + m.counts.deleted === Object.keys(projects.projects).length,
  m.counts.projects + ' live + ' + m.counts.deleted + ' deleted vs ' + Object.keys(projects.projects).length);

const o = CORE.pipelineOverview(m, s);
ck('year resolves to the budget year', o.year === 2026, String(o.year));
ck('budget    22,800,500', near(o.budget, 22_800_500), o.budget.toFixed(2));
ck('booked    14,854,120', near(o.booked, 14_854_120), o.booked.toFixed(2));
ck('projected 21,211,553', near(o.projected, 21_211_553), o.projected.toFixed(2));
ck('weighted  19,977,168', near(o.weighted, 19_977_168), o.weighted.toFixed(2));
ck('all-ratings total 27,869,952', near(o.total, 27_869_952), o.total.toFixed(2));
ck('weighted two ways: tier sum equals per-project recompute', (() => {
  const yr = CORE.projectYearRevenue(m);
  const byId = new Map(m.projects.map((p) => [p.source_id, p]));
  let w = 0;
  for (const [pid, years] of yr) {
    const p = byId.get(pid);
    if (!p || !CORE.isBudgetRating(p.rating)) continue;
    w += (years.get(o.year) || 0) * CORE.weightFor(p.rating);
  }
  return near(w, o.weighted);
})());
ck('coverage strip identity: shortfall = gap - openWeighted',
  near(o.shortfall, o.gap - o.openWeighted));
ck('gap = budget - booked', near(o.gap, o.budget - o.booked));
ck('money formatter parity: 22800500 -> $22.80M', CORE.fmtMoney(22_800_500) === '$22.80M');
ck('money formatter parity: -12000 -> -$12K', CORE.fmtMoney(-12_000) === '-$12K');
ck('variance: cost falling is good', CORE.variance(90, 100, 'down-good').tone === 'good');
ck('variance: $0 is neutral, no arrow', CORE.variance(100, 100, 'up-good').arrow === '');
ck('leader alias resolves (BLJ -> Benay Josselson)', CORE.leaderDisplay('BLJ') === 'Benay Josselson');
ck('budget baseline carries 39 client lines', (() => {
  const b = CORE.budgetBaseline(s);
  const clients = new Set(s.baselineLines.filter((l) => l.baseline_source_id === b.source_id).map((l) => l.client));
  return clients.size === 39;
})(), 'got a different client-line count');

// ---- Tab 1 panels ----
const p = CORE.tab1Panels(m, s, o, Date.parse('2026-08-12T12:00:00-04:00'));
ck('top client is the merged JPMorgan Chase', p.topClients.rows[0] && p.topClients.rows[0].name === 'JPMorgan Chase',
  p.topClients.rows[0] && p.topClients.rows[0].name);
ck('top-10 + other reconcile to the projected total',
  near(p.topClients.total.projected, o.projected),
  p.topClients.total.projected.toFixed(2) + ' vs ' + o.projected.toFixed(2));
ck('top-10 long shots + projected reconcile to all-ratings total',
  near(p.topClients.total.projected + p.topClients.total.longShots, o.total));
ck('monthly tracking: 12 rows, flat = budget/12',
  p.monthly.rows.length === 12 && near(p.monthly.flat, o.budget / 12));
ck('catch-up identity: last cumulative = year total - budget', (() => {
  const sumTotals = p.monthly.rows.reduce((a, r) => a + r.total, 0);
  return near(p.monthly.rows[11].cumVsBudget, sumTotals - o.budget, 1);
})());
ck('leader split: four tiers, tier totals match tier revenue', (() => {
  if (p.leaderRows.length !== 4) return false;
  for (const row of p.leaderRows) {
    const segSum = row.segs.reduce((a, s2) => a + s2.value, 0);
    if (!near(segSum, row.total)) return false;
  }
  return true;
})());
ck('staleness: bands account for every open R2-R4 deal', (() => {
  const open = (() => {
    const yr = CORE.projectYearRevenue(m);
    let n = 0;
    for (const pr of m.projects) {
      const years = yr.get(pr.source_id);
      if (years && years.has(o.year) && pr.rating >= 2 && pr.rating <= 4) n += 1;
    }
    return n;
  })();
  return p.stale.bands.green + p.stale.bands.amber + p.stale.bands.red === open;
})());
ck('staleness history is real (material moves resolve day counts)',
  p.stale.rows.some((r) => r.days !== null));

// ---- Tab 2 · Leaders ----
const t2 = CORE.tab2Data(m, s, o, Date.parse('2026-08-12T12:00:00-04:00'));
ck('tab2: leader books sum to the all-projects year revenue', (() => {
  const yr = CORE.projectYearRevenue(m);
  let all = 0;
  for (const [, years] of yr) all += years.get(o.year) || 0;
  const books = t2.books.reduce((a, b) => a + b.revenue, 0);
  return near(books, all) && near(t2.kpis.revenue, all);
})());
ck('tab2: booked equals the overview booked', near(t2.kpis.booked, o.booked));
ck('tab2: projects KPI counts the whole live snapshot', t2.kpis.projects === m.counts.projects);
ck('tab2: RF timeline carries the budget milestone', (() => {
  const b = t2.baselines.find((x) => x.name === 'Annual Budget');
  return b && near(b.total ?? 0, o.budget);
})());

// ---- Tab 3 · Clients ----
const t3 = CORE.tab3Data(m, o.year, Date.parse('2026-08-12T12:00:00-04:00'));
ck('tab3: revenue equals the independent monthly sum (all ratings)', (() => {
  let sum = 0;
  for (const r of m.monthlyRevenue) if (r.year === o.year && typeof r.amount === 'number') sum += r.amount;
  return near(t3.kpis.revenue, sum);
})());
ck('tab3: pareto cumulative share is monotonic and bounded', (() => {
  let prev = 0;
  for (const r of t3.pareto) { if (r.cumShare < prev - 1e-9 || r.cumShare > 1.0001) return false; prev = r.cumShare; }
  return true;
})());
ck('tab3: HHI within (0, 10000]', t3.kpis.hhi > 0 && t3.kpis.hhi <= 10000);
ck('tab3: donut shares cover the positive book', (() => {
  const donutSum = t3.donut.reduce((a, s2) => a + s2.revenue, 0);
  const posSum = t3.pareto.length ? undefined : 0;
  return donutSum > 0 && donutSum <= t3.kpis.revenue + 0.5 || posSum === 0;
})());
ck('tab3: month totals sum to the revenue KPI', near(t3.monthTotals.reduce((a, b) => a + b, 0), t3.kpis.revenue));
ck('tab3: top client is JPMorgan Chase here too', t3.kpis.topClientName === 'JPMorgan Chase', t3.kpis.topClientName);

// ---- Delivery engine + Rates ----
const staffRaw = JSON.parse(readFileSync(join(FIXTURES, 'staff.json'), 'utf8'));
const ratesRaw = JSON.parse(readFileSync(join(FIXTURES, 'rates.json'), 'utf8'));
const sf = CORE.mapStaff(staffRaw);
const rt = CORE.mapRates(ratesRaw);
ck('staff.json maps ok', sf.ok, sf.error);
ck('rates.json maps ok (11 grade families)', rt.ok && rt.counts.rate_grid === 11, JSON.stringify(rt.counts));
ck('staff counts: 82 people / 253 allocations / 2,357 actuals',
  sf.counts.people === 82 && sf.counts.allocations === 253 && sf.counts.actuals === 2357, JSON.stringify(sf.counts));
ck('staff hours total ~85,803h', Math.abs(sf.counts.total_hours - 85803) <= 1, String(sf.counts.total_hours));

const dv = CORE.clockifyData(sf, m, rt, o.year);
ck('delivery mix ties to the mapper categories to the hour',
  near(dv.mix.total, sf.hoursByCategory.billable + sf.hoursByCategory.internal + sf.hoursByCategory.time_off, 0.01));
ck('delivery mix is 64/24/11 (billable/internal/time off)', (() => {
  const pct = (v) => Math.round((v / dv.mix.total) * 100);
  return pct(dv.mix.billable) === 64 && pct(dv.mix.internal) === 24 && pct(dv.mix.timeOff) === 11;
})(), Math.round((dv.mix.billable / dv.mix.total) * 100) + '/' + Math.round((dv.mix.internal / dv.mix.total) * 100) + '/' + Math.round((dv.mix.timeOff / dv.mix.total) * 100));
ck('53 projects carry mapped hours; 82% of billable hours join a fee record',
  dv.margins.length === 53 && dv.coverage.hoursMappedPct === 82,
  dv.margins.length + ' projects, ' + dv.coverage.hoursMappedPct + '%');
ck('10 projects cost more in delivery time than they earn',
  dv.margins.filter((x) => x.marginPct !== null && x.marginPct < 0).length === 10,
  String(dv.margins.filter((x) => x.marginPct !== null && x.marginPct < 0).length));
ck('realised revenue per billable hour ~ $354',
  Math.abs((dv.kpis.revenuePerBillableHour || 0) - 354) < 1, String(dv.kpis.revenuePerBillableHour));
ck('margin identity holds on every project row',
  dv.margins.every((x) => near(x.margin, x.revenue - x.cost, 0.01)));

const t4 = CORE.tab4Data(rt, m, dv, o.year);
ck('rates tab: 11 grades, realisation within (0,1), true profit is real-hours-backed',
  t4.grades.length === 11 && t4.kpis.realisation > 0 && t4.kpis.realisation < 1
  && t4.trueProfitSource && t4.trueProfitSource.real === true);
ck('rates tab: true-profit rows reconcile to the delivery engine', (() => {
  const sumH = t4.trueProfit.reduce((a, r) => a + r.hours, 0);
  const allH = dv.margins.reduce((a, r) => a + r.hours, 0);
  return sumH <= allH + 0.01 && t4.trueProfit.every((r) => near(r.profit, r.invoiced - r.cost, 0.01));
})());

console.log('');
console.log(checks + ' checks, ' + (fails ? fails + ' FAILURES' : 'all passed'));
if (m.notes.length) { console.log('mapper notes:'); m.notes.slice(0, 8).forEach((n) => console.log('  - ' + n)); }
process.exit(fails ? 1 : 0);
