# Executive Reporting module - build state

Branch: `claude/executive-reporting`. The module ports the Financial Analysis
Part 2 production app (KYRI101/financial-analysis-2) into this repo as a
read-only page over the four Box files. The bible for behaviour and notation
is the Part 2 App Build Spec; the production app is the reference
implementation. Never write to projects/rates/staff/studio from here.

## Done

- `exec-reporting/core.js`: domain rulings (rating weights 100/90/75/50,
  the one money formatter, favourability engine, 14-leader directory,
  service lines, material-change classification, client canonicalisation
  register), pure mappers for projects.json (schemaVersion 2, shape-over-
  version, soft deletes, activity log) and studio.json, pipeline overview
  on the parity-view semantics (imported amounts), resolved monthly
  (overrides win), full Tab 1 panel maths.
- `exec-reporting/verify-core.mjs`: 26/26 against the frozen 30 Jul
  fixtures, canonical dollars TO THE DOLLAR (booked 14,854,120 / projected
  21,211,553 / weighted 19,977,168 / total 27,869,952 / budget 22,800,500),
  conservation identities, JPMorgan Chase canonicalisation, staleness from
  the real activity log. Run: `node exec-reporting/verify-core.mjs`
  (fixtures read from the sibling financial-analysis-2 repo).
- `Executive Reporting.html` + `exec-reporting/app.js` + `styles.css`:
  boot via UFC_Box.boot() (opening the page IS the refresh), gate on
  Store.seesAllProjects only (fail closed, tool admins excluded), Tab 1
  complete (KPI row, budget bridge, coverage strip, variance table,
  rating mix with hatched bars, leader split, top-10 canonical clients,
  monthly tracking with cumulative/run-rate toggle + catch-up target +
  backing table, vintage panel honest awaiting-history state, staleness
  bands + table). Dev fixtures mode: localhost + `?dev=fixtures&base=…`.
- `universal-fee-calc/nav.js`: teal Executive Reporting box, own headline
  group below Data Admin (after Migration / One-Time Tools), above Help;
  hidden until identity confirms; reveals only for seesAllProjects.
  Browser-proven: hidden with no identity, visible for kyerou, hidden for
  bjosselson (tool admin), matching the store's data-visibility rule.

## Done since (harness now 48/48)

- Leaders tab: KPI row, scorecard (booked-vs-book bars, top clients on
  hover, per-leader ageing), deal-ageing table, RF timeline from studio
  baselines, industry/type DEMO panels. Staff-cost planner + margin
  quadrant still marked port-in-progress.
- Clients tab: KPIs (top client/top-5/HHI), pareto with cumulative
  shares, sector donut + month stack (SEEDED CLASSIFICATION flags - the
  curated sector edits lived in the database app), MoM movers, programme
  drill (DEMO GROUPING), reported-vs-billed honest NOT AVAILABLE.
- Delivery & Effort: full clockifyData port. Fixture-proven identical to
  the app's validated findings: 85,803h / 64-24-11 mix / 53 mapped
  projects / 82% billable hours joined / 10 negative-margin projects /
  $354 per billable hour. Panels: time mix by month, capacity vs
  pipeline, effort vs likelihood, true margin by project, client
  economics, effort by person, coverage + reconciliation.
- Rates: grade KPIs, floor-to-rack dumbbell with demo actual markers
  (flagged), true-profit by client running PART-LIVE on the same
  delivery engine. Box path pulls staff.json via UFC_Box.pullStaff();
  rates arrive through the page-local RATES_CATALOG shim at boot.

## Next (in order)

1. Locations (map without any CDN - vendored tiles impossible offline;
   degrade honestly to region/city table with filters), Confidence
   (coverage index), Glossary page, project box score drill.
2. Client-side Excel/PDF exports; print pass.
3. Update repo docs (Maintainers Runbook gains the module section);
   then PR to main.

## Watchpoints

- Leader-split totals exceed tier revenue when projects carry credits
  (positive-only rule) - faithful to the app, not a bug.
- The fee tool repo is `"type": "module"`: core.js loads as a classic
  script in the browser and via eval in the Node harness.
- financial-analysis-2 keeps accruing DB-side monthly vintages; Box files
  carry none yet, so the vintage panel shows its awaiting state by design.
