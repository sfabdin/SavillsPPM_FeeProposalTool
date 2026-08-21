# Savills PPM · Fee Proposal Generator

A multi-page, Box-backed system for building, pricing, storing, and reporting on
fee proposals. The app is a **front door to Box after OAuth** — all project data
lives in Box (`projects.json`, `studio.json`, `staff.json`, `revenue.json`); the
confidential rate grid (`rates.json`) is pulled from Box only after sign-in and is
**never** in this repo.

## Pages (all wired into the shared hamburger nav)

**Build**
- `Fee Generator.html` — home / launchpad
- `Universal Fee Calculator.html` — the calculator: roster, phase matrix, monthly
  schedule, rate lock, discount, broker fee-share (off-top / on-top), NTE ceiling,
  version history, Excel export
- `Ingestion Studio.html` — parse a proposal/matrix into a project (Claude extract)

**Manage**
- `Projects Index.html` — every project; client rollup; per-project fees
- `Revenue Projections.html` — monthly invoice matrix (reads the materialized
  billing series), broker split toggle, current-month marker, Excel export,
  **open revenue slips banner** (months Finance moved, shown red until reconciled)
- (retired) Revenue Studio — replaced by Revenue Reconciliation for the monthly close;
  drill-down (bucket → client → project), Exec Report tab
- `Benchmarking Dashboard.html` — rate spread + scope/assumptions comparison
- `Proposal Analytics.html` — funnel, win/loss, discount analytics, health score,
  client profile

**Admin**
- `Revenue Reconciliation.html` — the monthly close, Finance-owned: map every
  line in the close file to a fee-tool project, import the actuals workbook,
  give each earned month an accrual / billed / realized month, disposition
  every variance, export the monthly flash to Excel. Four views —
  **EARNED** (the fee tool), **ACCRUED**, **BILLED**, **REALIZED** (the finance
  team's report) — are the same dollars read on four calendars. One calendar
  year at a time, 2026 forward
- `Import Revenues.html` — bulk-import monthly billing (admin only)

**Docs**
- `Maintainers Runbook.html` (deployed) · `docs/` (repo-only: migration guide, roadmap, readiness report)

## Modules — `universal-fee-calc/`
- `revenue-reconcile.js` — Revenue Reconciliation: close-workbook parser (columns
  found by header text, rows footed against the sheet's own reported revenue),
  the mapping workspace, the three-calendar allocation lane, disposition queue,
  flash + Excel export
- `store.js` — data layer: projects + studio stores, the calc engines
  (`computeFinancials`, `monthlySeries`, `projectFinancials`), the **revenue ledger**
  (its own store, backed by `revenue.json`; `recognised = billed + fee share + accrued`),
  **revenue slips** (Finance moving a missed fee to a later month — moves money,
  never creates it; open slips flag the affected months for the red on Projections),
  change-order ledger,
  version history, **schema migrations**, **tombstone soft-delete**, **activity log**,
  access wall + leader directory
- `box-adapter.js` — Box OAuth, pull/push with etag concurrency + union merge
  (tombstones + activity), flush-on-hide, rates pull, config
- `boot.js` — gates each page on auth + data load; runs migrations + tombstone purge
- `sync-status.js` — on-page "Synced to Box" indicator + manual Sync now
- `nav.js` — shared hamburger nav (admin-aware)
- `app.js` — calculator engine + UI
- `intake.js` — Salesforce intake email + drift detection
- `export-excel.js` — calculator Excel export (setup, matrix, monthly, billing summary)
- `rates-catalog.js` — rate-grid shell, hydrated from Box `rates.json`
- `ingest.js`, `import-revenues.js`, `proposal-analytics.js`, `revenue-studio.js`,
  `bench.js`, `bench-data.js` — page controllers
- `styles.css`, `studio.css`

## `api/` (Vercel serverless)
- `extract.js` — proposal extraction via Claude (self-healing model fallback chain)
- `box-token.js` — OAuth token exchange / refresh

## Testing
Open `tests.html` in a browser — a self-contained regression suite that asserts the
engine invariants (waterfall identity, rate-lock single-removal, broker direction,
monthly decomposition) and the data layer (tombstones, migrations, activity log).
It uses an in-memory storage shim, so it never touches real Box-synced data.
**Run it before every deploy** — a red row means the math or data layer broke.

## Deploy
Host on Vercel. Required env vars: `BOX_CLIENT_ID`, `BOX_CLIENT_SECRET`,
`ANTHROPIC_API_KEY`. `rates.json` is uploaded to the Box folder (not here);
its file id is set in `box-adapter.js` config.

## Box files
- `projects.json` — project records only. Nothing else is written here.
- `rates.json` — the confidential rate grid (pulled post-login, never in this repo).
- `studio.json` — retired Revenue Studio baselines + scenarios (kept in Box for the Budget/RF baseline decision; no page writes it).
- `staff.json` — the living staffing matrix.
- `revenue.json` — Revenue Reconciliation's actuals ledger, keyed by year then
  project, plus the **mapping book** (`mapping.entries` / `mapping.ignored`,
  keyed by ledger line rather than by year, so a line mapped once carries into
  every future close). **Self-configuring**: with no file id set it is found by name in the
  shared folder and created on first run, so every admin lands on the same file.
  Merged per ROW (each carries `updatedAt`), because everything lives under one
  year — a whole-year newest-wins would let two admins erase each other.

## Data model
Project records store **inputs only** (roles, FTE %, assumptions) — never dollar
figures, which are recomputed live. Booked records additionally freeze a
`financials` snapshot; pursuits keep a live-refreshed materialized billing series
that Revenue Projections / Studio read directly. Schema is versioned (`SCHEMA`) with
a migration pipeline in `store.js`; deletes are soft (tombstones) so they propagate
across devices through the Box merge.
