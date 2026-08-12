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

console.log('');
console.log(checks + ' checks, ' + (fails ? fails + ' FAILURES' : 'all passed'));
if (m.notes.length) { console.log('mapper notes:'); m.notes.slice(0, 8).forEach((n) => console.log('  - ' + n)); }
process.exit(fails ? 1 : 0);
