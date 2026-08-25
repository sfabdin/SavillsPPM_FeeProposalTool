# Executive Reporting module - build state

Merged to `main` from `claude/executive-reporting` (PR #77). The module
ports the Financial Analysis Part 2 production app
(KYRI101/financial-analysis-2) into this repo as a read-only page over the
four Box files it reads. The bible for behaviour and notation
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

## Done - all tabs complete (harness 55/55)

- Locations: self-contained SVG city-cluster map (no Leaflet, no tiles,
  no CDN), same stable-hash demo geography + JPMC 8-city spread as the
  app, DEMO GEOGRAPHY banner, rating/leader/region filters, city table.
- Confidence: 14-field coverage index, RAG bands, INTERNAL badge and
  deliberately no export.
- Definitions: all 16 canonical glossary terms, two columns.
- Project box score: drill from any project link (staleness, margins),
  chips + per-year monthly bars + movement history (material vs admin
  edits) + delivery-effort block; Back returns to the tab.
- Exports: per-tab Excel via ExcelJS from the same CDN the Bulk Editor
  already uses (loaded on first click), confidentiality footer, and PDF
  via the print pipeline. Confidence has no export by design.
- Maintainers Runbook page table now documents the module and its gate.

## Leaders interactive block - DONE (last port-in-progress item)

- Leader multi-select recomputes the six-KPI scorecard, leader bars and
  client list live; manual staff-cost grid (11 grades, round planning
  defaults, NOT the rate card) recomputes blend/profit/margin on edit;
  margin quadrant (bubbles = modelled hours, 20% placeholder target,
  white-backed labels - no stroke halo, which doubles text in PDF).
- Browser-proven: selection filters to a single book, a cost edit moves
  the blended readout, 51 bubbles, zero console errors.

## Merged

PR #77 landed on `main` (commit `debb5c9`) and the module has shipped.
Nothing on the page is marked port-in-progress. Commits since the merge:
the plain-language pass below, the responsive pass, fixes from the first
live Box run, the two panels the port had dropped, and the shared
vendor-lazy / opt-in-store work that the module picked up along with every
other page.

Still open, and not a code task:

- Retire the separate local app, export the Supabase vintage snapshots to
  an archive, then close Supabase (KY's call).

## Watchpoints

- Leader-split totals exceed tier revenue when projects carry credits
  (positive-only rule) - faithful to the app, not a bug.
- The fee tool repo is `"type": "module"`: core.js loads as a classic
  script in the browser and via eval in the Node harness.
- financial-analysis-2 keeps accruing DB-side monthly vintages; Box files
  carry none yet, so the vintage panel shows its awaiting state by design.

## 13 Aug 2026 - plain-language pass + two robustness fixes (v=20260813f)

KY ran three language audits over the module and approved a full list of
rewrites. All applied: no em dashes anywhere in module files, no
developer vocabulary on screen (render/engine/seed/grain), one name for
the other tool ("the fee system"), the at-risk cost line now uses the
house money formatter, and the capacity message says plainly when the
team is overbooked instead of flooring free hours to zero.

Code fixes in the same commit:
- rates.json mapper moved to shape-over-version (the last strict version
  check left; same failure mode that zeroed the budget when studio.json
  went to v2 on launch day).
- Movement vs prior panel can no longer flag LIVE while the comparison
  view is unbuilt.

Harness: 73 checks, all passing. The MG margin-target placeholder stays
by KY's ruling.
