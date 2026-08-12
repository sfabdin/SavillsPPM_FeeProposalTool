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

## Next (in order)

1. Leaders tab (scorecard, staff-cost grid manual inputs, margin quadrant,
   RF timeline, aging/movement provenance states).
2. Clients tab (concentration, programme drill, sector donut + by-month,
   MoM movers).
3. Rates tab (role-gated already by page gate; grid KPIs, dumbbell,
   true-profit via staff hours when staff.json wired).
4. Delivery & Effort tab (pullStaff(); time mix, true margin, plan vs
   actual, effort by person; effort.ts port).
5. Locations (map without Leaflet CDN - port bundled approach or degrade
   to the table), Confidence (coverage index), Glossary, project box score.
6. Client-side Excel/PDF exports; print pass; then PR to main.

## Watchpoints

- Leader-split totals exceed tier revenue when projects carry credits
  (positive-only rule) - faithful to the app, not a bug.
- The fee tool repo is `"type": "module"`: core.js loads as a classic
  script in the browser and via eval in the Node harness.
- financial-analysis-2 keeps accruing DB-side monthly vintages; Box files
  carry none yet, so the vintage panel shows its awaiting state by design.
