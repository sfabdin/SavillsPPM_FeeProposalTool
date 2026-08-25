# Savills PPM · Fee & Revenue System

A multi-page, Box-backed system for building, pricing, storing, and reporting on
fee proposals. The app is a **front door to Box after OAuth** — all shared data
lives in Box (`projects.json`, `staff.json`, `revenue.json`, `studio.json`); the
confidential rate grid (`rates.json`) is pulled from Box only after sign-in and is
**never** in this repo.

No build step, no framework, no bundler, no npm dependencies — plain HTML and
classic `<script>` files served as-is, plus three Vercel serverless functions.
Entry point is `Fee Generator.html`.

## Pages

Grouped as they appear in the shared hamburger nav (`universal-fee-calc/nav.js`,
whose `LINKS` array is the canonical page list). Admin-only pages are marked.

**Projects** — the daily loop for every revenue leader
- `Fee Generator.html` — home / launchpad
- `Projects Index.html` — every proposal and project; search, filter, client
  rollup, per-project fees, quick-edit on the row
- `Universal Fee Calculator.html` — the calculator: roster, phase matrix, monthly
  schedule, rate lock, discount, broker fee-share (off-top / on-top), NTE ceiling,
  version history, Excel export
- `Revenue Projections.html` — monthly invoice matrix (reads the materialized
  billing series), broker split toggle, current-month marker, Excel export,
  **open revenue slips banner** (months Finance moved, shown red until reconciled)
- `Benchmarking Dashboard.html` — rate spread + scope/assumptions comparison
- `Proposal Analytics.html` — funnel, win/loss, discount analytics, health score,
  client profile

**Operations** — running the business (admin)
- `Staffing Matrix.html` — who is working on what and how loaded they are:
  allocations, bandwidth, Clockify actuals, contract-vs-staffing checks
- `Revenue Reconciliation.html` — the monthly close, Finance-owned: map every
  line in the close file to a fee-tool project, import the actuals workbook,
  give each earned month an accrual / billed / realized month, disposition
  every variance, export the monthly flash to Excel. Four views —
  **EARNED** (the fee tool), **ACCRUED**, **BILLED**, **REALIZED** (the finance
  team's report) — are the same dollars read on four calendars. One calendar
  year at a time, 2026 forward
- `Profitability.html` — revenue with Clockify burn (hours × cost rate) laid
  against it: margin per project, per month
- `Data Entry Status.html` — completeness tracker: projects by revenue leader,
  with the fields still missing

**Data Admin** — keeping the data right (admin)
- `Change Log.html` — who changed what, and when, across the system
- `Ingestion Studio.html` — one door for ingestion: parse a single proposal or
  fee matrix into a project (Claude extract), or switch to bulk mode
  (`?mode=bulk`) to import the projections workbook full-book-vs-full-book with
  a diff of every row before anything lands
- `Bulk Editor.html` — superuser only: export the whole project book to Excel,
  scrub it, put it back with a full diff. Includes the maintenance lock that
  pauses everyone else's saves while you work

  *Migration / one-time tools*
- `Import Small Works.html` — one-time import of the small-works project book
- `Data Repair.html` — scan-and-fix for known data damage (duplicates, stale
  renames, sparse months); preview first, then repair
- `Rate Grid Reconciliation.html` — dry-run a new rate grid against every
  project to see what would change before committing it

**Executive Reporting** — leadership only
- `Executive Reporting.html` — read-only module (`exec-reporting/`) over all four
  Box files: pipeline against budget, leaders, clients, rates, locations,
  delivery and data confidence. Gated on the sees-all-projects list, **not** the
  wider admin-tools role, and it never writes

**Help & docs**
- `Getting Started.html` — the 5-minute revenue-leader orientation
- `Maintainers Runbook.html` (deployed) — the deep technical reference:
  architecture, data flow, the exact fee math, config table
- `Revenue Leader Guide.html`, `Revenue Leader Email.html` — rollout collateral,
  not wired into the nav
- `docs/` — repo-only: migration guide, roadmap, readiness report
- `oauth-callback.html` — where Box sign-in lands. **Required; do not rename.**

`Import Revenues.html` is a redirect stub → `Ingestion Studio.html?mode=bulk`.
Revenue Studio is retired; Revenue Reconciliation replaced it for the monthly
close, and `studio.json` is kept only for the Budget/RF baseline.

## Modules — `universal-fee-calc/`

Every module is an IIFE that hangs one global off `window` (`UFC_Store`,
`UFC_Box`, `UFC_Staff`, …). No ESM in the browser, no imports, no exports.

**Core stack** — loaded by every data-backed page, in this order
- `store.js` — the data layer and the whole engine: projects + studio stores, the
  calc engines (`computeFinancials`, `monthlySeries`, `projectFinancials`), the
  **revenue ledger** (its own store, backed by `revenue.json`;
  `recognised = billed + fee share + accrued`), **revenue slips** (Finance moving
  a missed fee to a later month — moves money, never creates it; open slips flag
  the affected months for the red on Projections), change-order ledger, version
  history, **schema migrations**, **tombstone soft-delete**, **activity log**,
  access wall + leader directory
- `box-adapter.js` — Box OAuth (PKCE), pull/push with etag concurrency + union
  merge (tombstones + activity), flush-on-hide, rates pull, `BOX_CONFIG`
  (the Box file ids live here)
- `boot.js` — gates each page on auth + data load, publishes `window.ufcReady`,
  runs migrations + tombstone purge, starts the 3-minute live refresh
- `rates-catalog.js` — the rate **engine** shell, hydrated from Box `rates.json`.
  No numbers in the repo
- `nav.js` — shared hamburger nav (admin-aware)
- `sync-status.js` — on-page "Synced to Box" indicator + manual Sync now
- `vendor-lazy.js` — `UFC_Vendor.excel()` / `.xlsx()`; loads the ~900KB Excel
  libraries on first use, never at page load. Only on the seven pages that
  export or import

**Page controllers**
- `app.js` — the calculator engine + UI · `intake.js` — Salesforce intake email
  and drift detection · `export-excel.js` — calculator Excel export (setup,
  matrix, monthly, billing summary)
- `projects-index-page.js` · `revenue-projections-page.js` ·
  `proposal-analytics.js` · `bench.js` + `bench-data.js`
- `revenue-reconcile.js` — Revenue Reconciliation: close-workbook parser (columns
  found by header text, rows footed against the sheet's own reported revenue),
  the mapping workspace, the three-calendar allocation lane, disposition queue,
  flash + Excel export
- `ingest.js` — single-proposal extraction · `revenue-import.js` — the bulk
  projections-workbook import and diff
- `staff.js` + `staffing-page.js` + `staffing-export.js` + `staff-seed.js` —
  the staffing matrix data layer, page, and Excel snapshot
- `profitability-page.js` · `rate-reconcile.js` · `bulk-excel.js` ·
  `smallworks-data.js`

**Shared UI**
- `ui.js` (toasts) · `guide.js` (ⓘ inline help markers) · `first-run.js`
  (one-time Getting Started banner) · `doc-page.js` (print/paged shell for the
  guides) · `styles.css`

`Change Log.html`, `Data Entry Status.html` and `Fee Generator.html` carry their
controller as an inline `<script>` rather than a file. `studio.css` and the
root-level `guide.js` are leftovers referenced by no page — edit
`universal-fee-calc/guide.js`.

## `api/` (Vercel serverless)
- `box-token.js` — OAuth code→token exchange and refresh. Holds
  `BOX_CLIENT_SECRET`; the only place the secret is used
- `extract.js` — proposal extraction via Claude (self-healing model fallback
  chain — leave `CLAUDE_MODEL` unset so a retired model never breaks the tool)
- `clockify.js` — Clockify Reports proxy returning aggregated actuals CSV

## Testing

`tests.html` is a self-contained regression suite — **158 assertions across 37
groups** covering the engine invariants (waterfall identity, rate lock, broker
direction, monthly decomposition, NTE), the data layer (tombstones, migrations,
activity log), the revenue ledger, allocations, the three calendars, mapping,
the close-file parser, staffing, and the revenue diff. It installs an in-memory
`localStorage` shim before `store.js` loads, so it can never touch real
Box-synced data, and uses a synthetic rate grid — never the confidential one.

Open it in a browser, or run it headless:

```bash
npm install --no-save playwright
npx playwright install chromium          # first time only
node scripts/run-tests.mjs               # exits non-zero on any failure
```

CI (`.github/workflows/tests.yml`) runs the same runner on every push and PR.
**Run it before every deploy** — a red row means the math or data layer broke.

## Deploy

Vercel, no build step. Everything at the root is served as-is; `api/*.js` become
functions automatically. Required env vars — set for Production, Preview **and**
Development, then redeploy:

| Variable | Used by |
|---|---|
| `BOX_CLIENT_ID`, `BOX_CLIENT_SECRET` | `api/box-token.js` — sign-in breaks without them |
| `ANTHROPIC_API_KEY` | `api/extract.js` — proposal extraction |
| `CLOCKIFY_API_KEY`, `CLOCKIFY_WORKSPACE_ID` | `api/clockify.js` — actuals |

The Box app needs `https://<domain>/oauth-callback.html` as a redirect URI for
**every** domain that serves the app, preview domains included — a missing
redirect URI is the most common cause of a failed sign-in. `rates.json` is
uploaded to the Box folder (not here); its file id goes in `box-adapter.js`.
`DEPLOY.md` has the full runbook and the post-deploy verification checklist.

## Box files
- `projects.json` — project records + the activity log. Nothing else is written here.
- `rates.json` — the confidential rate grid (pulled post-login, never in this repo).
- `staff.json` — the living staffing matrix: allocations, notes, Clockify actuals, mappings.
- `studio.json` — retired Revenue Studio baselines + scenarios (kept in Box for the Budget/RF baseline decision; only Executive Reporting reads it).
- `revenue.json` — Revenue Reconciliation's actuals ledger, keyed by year then
  project, plus the **mapping book** (`mapping.entries` / `mapping.ignored`,
  keyed by ledger line rather than by year, so a line mapped once carries into
  every future close). **Self-configuring**: with no file id set it is found by name in the
  shared folder and created on first run, so every admin lands on the same file.
  Merged per ROW (each carries `updatedAt`), because everything lives under one
  year — a whole-year newest-wins would let two admins erase each other.

Boot always pulls `projects.json` + `rates.json`. `studio.json` and
`revenue.json` are read by one page each, so those pages opt in with
`window.UFC_NEEDS = ['studio']` / `['revenue']` before `boot.js` and every other
page never fetches them.

## Data model

Project records store **inputs only** (roles, tiers, monthly FTE %, assumptions,
dates) — every dollar on screen is recomputed live from those inputs, so a math
fix corrects every project with no migration. Exceptions: booked records
(won / active / closed) additionally freeze a `financials` snapshot, a
contractual fact that does not recompute; pursuits keep a live-refreshed
materialized billing series that Revenue Projections reads directly; NTE-basis
projects auto-restamp on edit. Schema is versioned (`SCHEMA`) with a migration
pipeline in `store.js`; deletes are soft (tombstones, purged after 120 days) so
they propagate across devices through the Box merge instead of resurrecting.

`localStorage` is the synchronous working store — every edit writes there
instantly; `box-adapter.js` is a sync layer on top (pull on boot, debounced
etag-guarded push after writes, flush the moment the tab hides).

## More

- `CLAUDE.md` — conventions, boot sequence, access-control rules, gotchas.
- `README - how this system fits together.md` — the aggregation vs. reporting split.
- `DEPLOY.md` — deployment and post-deploy verification.
- `exec-reporting/BUILD-STATE.md` — that module's port history and watchpoints.
