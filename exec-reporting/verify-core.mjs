/* Verify harness for exec-reporting/core.js.

   Runs against the fixtures checked in beside it (exec-reporting/fixtures,
   generated from the real store with the test rate catalog) and checks the
   IDENTITIES the module must hold for any book, plus that its model matches
   the store's. It used to assert dollar totals from a frozen drop held in a
   sibling repo that is not here — it exited 2 on every machine but one — and
   those totals were computed with rating weights the app no longer uses.

   Dev + CI: `node exec-reporting/verify-core.mjs`. Exits 1 on any failure. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
(0, eval)(readFileSync(join(here, 'core.js'), 'utf8'));
const CORE = globalThis.EXEC_CORE;

const projects = JSON.parse(readFileSync(join(here, 'fixtures', 'projects.json'), 'utf8'));
const studio = JSON.parse(readFileSync(join(here, 'fixtures', 'studio.json'), 'utf8'));

/* The store's model, as the app injects it. Kept here verbatim from store.js
   so the harness fails the day the two drift. */
const STORE_RATINGS = [
  { n: 1, weight: 1.00 }, { n: 2, weight: 0.95 }, { n: 3, weight: 0.82 }, { n: 4, weight: 0.62 },
  { n: 5, weight: 0.37 }, { n: 6, weight: 0.15 }, { n: 7, weight: 0.00 },
];
const STORE_STATUS_RATING = { active: 1, won: 2, closed: 1, negotiation: 4, submitted: 4, draft: 5, hold: 6, lost: 7 };
CORE.configure({ ratings: STORE_RATINGS.map((r) => ({ n: r.n, label: 'R' + r.n, short: 'R' + r.n, weight: r.weight })), statusDefaultRating: STORE_STATUS_RATING });

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
ck('live + soft-deleted = every record in the file',
  m.counts.projects + m.counts.deleted === Object.keys(projects.projects).length,
  m.counts.projects + ' + ' + m.counts.deleted + ' vs ' + Object.keys(projects.projects).length);

// ---- the model matches the store ----
for (const r of STORE_RATINGS) ck('rating ' + r.n + ' weighs ' + r.weight + ' (the store\'s table)', CORE.weightFor(r.n) === r.weight, String(CORE.weightFor(r.n)));
ck('a closed project is booked (rating 1), not dropped', CORE.ratingFromStatus('closed') === 1, String(CORE.ratingFromStatus('closed')));
ck('the closed fixture lands in the booked tier', (() => {
  const p = m.projects.find((x) => x.source_id === 'fx_closed');
  return p && p.rating === 1;
})());
ck('money: negatives in parentheses, as the store prints them', CORE.fmtMoney(-12_000) === '($12K)', CORE.fmtMoney(-12_000));
ck('money: 22800500 -> $22.80M', CORE.fmtMoney(22_800_500) === '$22.80M', CORE.fmtMoney(22_800_500));
ck('leader alias resolves (BLJ -> Benay Josselson)', CORE.leaderDisplay('BLJ') === 'Benay Josselson');
ck('a vocabulary-added leader resolves once injected', (() => {
  CORE.configure({ leaders: CORE.REVENUE_LEADERS.concat([{ id: 'newlead', displayName: 'New Leader', username: 'newlead@savills.us', aliases: ['NL'] }]) });
  const ok = CORE.leaderDisplay('NL') === 'New Leader';
  CORE.configure({ leaders: CORE.REVENUE_LEADERS.filter((l) => l.id !== 'newlead') });
  return ok;
})());

// ---- identities that hold for any book ----
const o = CORE.pipelineOverview(m, s);
ck('year resolves to the budget year', o.year === 2026, String(o.year));
ck('budget equals the baseline total', near(o.budget, s.baselines[0].total), o.budget + ' vs ' + s.baselines[0].total);
ck('booked <= projected <= all-ratings total', o.booked <= o.projected + 0.5 && o.projected <= o.total + 0.5, [o.booked, o.projected, o.total].join(' / '));
ck('weighted <= projected', o.weighted <= o.projected + 0.5, o.weighted + ' vs ' + o.projected);
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
ck('coverage strip identity: shortfall = gap - openWeighted', near(o.shortfall, o.gap - o.openWeighted));
ck('gap = budget - booked', near(o.gap, o.budget - o.booked));
ck('a dead project contributes nothing to weighted', (() => {
  const yr = CORE.projectYearRevenue(m);
  const lost = m.projects.find((x) => x.source_id === 'fx_lost');
  return lost && CORE.weightFor(lost.rating) === 0;
})());

// ---- activity: the trail reaches the mapper ----
ck('material edits in the activity trail are mapped', m.activityChanges.length > 0, String(m.activityChanges.length));

// ---- Tab 1 panels ----
const NOW = Date.parse('2026-09-03T12:00:00-04:00');
const p = CORE.tab1Panels(m, s, o, NOW);
ck('top-10 + other reconcile to the projected total', near(p.topClients.total.projected, o.projected),
  p.topClients.total.projected + ' vs ' + o.projected);
ck('top-10 long shots + projected reconcile to all-ratings total', near(p.topClients.total.projected + p.topClients.total.longShots, o.total));
ck('monthly tracking: 12 rows, flat = budget/12', p.monthly.rows.length === 12 && near(p.monthly.flat, o.budget / 12));
ck('catch-up identity: last cumulative = year total - budget', (() => {
  const sumTotals = p.monthly.rows.reduce((a, r) => a + r.total, 0);
  return near(p.monthly.rows[11].cumVsBudget, sumTotals - o.budget, 1);
})());
ck('leader split: tier totals match tier revenue', p.leaderRows.every((row) => near(row.segs.reduce((a, s2) => a + s2.value, 0), row.total)));
ck('staleness: bands account for every open R2-R4 deal', (() => {
  const yr = CORE.projectYearRevenue(m);
  let n = 0;
  for (const pr of m.projects) { const years = yr.get(pr.source_id); if (years && years.has(o.year) && pr.rating >= 2 && pr.rating <= 4) n += 1; }
  return p.stale.bands.green + p.stale.bands.amber + p.stale.bands.red === n;
})());
ck('staleness history is real (a material move resolves a day count)', p.stale.rows.some((r) => r.days !== null));

// ---- Tab 2 · Leaders ----
const t2 = CORE.tab2Data(m, s, o, NOW);
ck('tab2: leader books sum to the all-projects year revenue', (() => {
  const yr = CORE.projectYearRevenue(m);
  let all = 0; for (const [, years] of yr) all += years.get(o.year) || 0;
  return near(t2.books.reduce((a, b) => a + b.revenue, 0), all) && near(t2.kpis.revenue, all);
})());
ck('tab2: booked equals the overview booked', near(t2.kpis.booked, o.booked));
ck('tab2: projects KPI counts the whole live snapshot', t2.kpis.projects === m.counts.projects);

// ---- Tab 3 · Clients ----
const t3 = CORE.tab3Data(m, o.year, NOW);
ck('tab3: a tagged record keeps its own industry as its sector', (() => {
  const rows = t3.sectorMonths || [];
  return rows.some((x) => /Life Sciences/.test(String(x.sector || x.name || '')));
})(), 'no Life Sciences sector row — the client-name guess is still winning: ' + JSON.stringify((t3.sectorMonths || []).map((x) => x.sector || x.name)));
ck('tab3: sector revenue is non-zero (the engine series reached the Clients tab)', (t3.sectorMonths || []).length > 0);

console.log('\n' + (checks - fails) + '/' + checks + ' checks passed');
process.exit(fails ? 1 : 0);
