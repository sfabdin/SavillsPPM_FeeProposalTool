# CLAUDE.md

Guidance for AI assistants working in this repository.

## What this is

**Savills PPM · Fee & Revenue System** — a multi-page browser app for
building, pricing, storing and reporting on project-management fee proposals.

- **No build step, no framework, no bundler, no npm dependencies.** Plain HTML
  + classic `<script>` files served as-is. `package.json` has no build script
  on purpose (`"type": "module"` is there only so `scripts/*.mjs` run as ESM).
- **The app is a front door to Box.** All shared state lives in JSON files in
  one Box folder. The deployed bundle ships with zero fees and zero rates.
- **Vercel static hosting + three serverless functions** in `api/`.

## Working agreement

### Ship by default

Work is not finished when it is committed. It is finished when it is on
`main` and a person can see it in the app.

Merging is part of doing the task, not a separate permission to ask for.
Do not leave a completed, tested change sitting on a branch waiting for a
nod — that reads as "done" from the outside while nothing has actually
changed for anyone.

Two exceptions, and only two:

- **Something is genuinely unresolved** — a failing test, a decision that
  is the user's to make, a risk worth naming. Then say so plainly at the
  TOP of the reply, in the first line, not buried under a summary of what
  was built.
- **The user asked to hold.**

If a change is built but not live for any other reason, that is a bug in
the process. Say **"built, not live"** in the first sentence.

#### Before merging

- `main` has not moved under the branch (or rebase and re-verify if it has)
- the full suite passes on the exact tree being merged — `tests.html`, plus
  the browser checks for anything touched
- only intended files in the diff; no scratch harnesses (`_*.html`) leaked in

#### After merging

Say where the change surfaces — which page, which tab — and whether it
needs a one-time action before it shows anything. A feature that renders
an empty state until someone runs a backfill looks broken if nobody says
so first.

### Reporting

State outcomes plainly. If tests failed, say so with the output. If a step
was skipped, say that. When something is done and verified, say it without
hedging. Never describe work as delivered when it is not deployed.

## The one rule that matters most

**Confidential numbers never enter the repo.** `rates.json` (the PPM rate
grid) and any real fee sheet live only in Box, pulled after sign-in. Anything
in the deployed bundle is readable at its URL with no login. `.gitignore`
blocks `rates.json` and `research/` from commits; `.vercelignore` blocks them
(plus `docs/`) from deploying. `rates-catalog.js` in the repo is the *engine*
— the High/Mid/Low math and title→family mapping — with no numbers in it.

## Layout

```
*.html                    one file per page, at the repo root (spaces in
                          filenames are deliberate — bookmarks depend on them)
universal-fee-calc/       all shared app code + page controllers
exec-reporting/           Executive Reporting module (read-only, own namespace)
api/                      Vercel serverless functions
vendor/                   ExcelJS + SheetJS, vendored (no CDN at runtime)
design-system/            brand colours, type, Gotham fonts, logo, favicon
docs/                     repo-only reference (migration guide, roadmap, readiness)
scripts/run-tests.mjs     headless runner for tests.html
tests.html                the regression suite
oauth-callback.html       Box sign-in lands here — REQUIRED, do not rename
```

### Core modules — `universal-fee-calc/`

| File | Role |
|---|---|
| `store.js` (~4.1k lines) | The data layer and the whole engine. Project store, studio store, revenue ledger; `computeFinancials` / `monthlySeries` / `projectFinancials`; schema migrations; tombstones; activity log; version history; change orders; revenue slips; the ledger + mapping book; access rules. |
| `box-adapter.js` | Box OAuth (PKCE), pull/push with etag concurrency + union merge, flush-on-hide, rates pull, `BOX_CONFIG` (file ids live here). |
| `boot.js` | Gates every page on auth + data load. Publishes `window.ufcReady`. Runs migrations + tombstone purge, starts the 3-min live refresh. |
| `nav.js` | Self-injecting hamburger nav. The `LINKS` array is the canonical page list; `admin:true` / `exec:true` control visibility. |
| `sync-status.js` | The on-page "Synced to Box" pill + manual Sync now. |
| `rates-catalog.js` | Rate engine shell (`window.RATES_CATALOG`), hydrated from Box `rates.json`. |
| `vendor-lazy.js` | `UFC_Vendor.excel()` / `.xlsx()` — loads the 900KB libraries on first use, never at page load. |
| `ui.js`, `guide.js`, `first-run.js`, `doc-page.js` | Toasts, ⓘ help markers, the one-time welcome banner, the print/paged shell for guides. |

### Page controllers

Each page loads the shared stack, then its own controller:

| Page | Controller(s) |
|---|---|
| `Universal Fee Calculator.html` | `app.js`, `intake.js`, `export-excel.js` |
| `Projects Index.html` | `projects-index-page.js` |
| `Revenue Projections.html` | `revenue-projections-page.js` |
| `Revenue Reconciliation.html` | `revenue-reconcile.js` (injected *after* an inline admin gate) |
| `Staffing Matrix.html` | `staff.js`, `staffing-page.js`, `staffing-export.js`, `staff-seed.js` |
| `Profitability.html` | `staff.js`, `profitability-page.js` |
| `Ingestion Studio.html` | `ingest.js`, `revenue-import.js` |
| `Bulk Editor.html` | `bulk-excel.js` |
| `Benchmarking Dashboard.html` | `bench.js`, `bench-data.js` |
| `Proposal Analytics.html` | `proposal-analytics.js` |
| `Rate Grid Reconciliation.html` | `rate-reconcile.js` |
| `Executive Reporting.html` | `exec-reporting/core.js`, `exec-reporting/app.js` |
| `Change Log.html`, `Data Entry Status.html`, `Fee Generator.html` | inline `<script>` in the page |

`Import Revenues.html` is a redirect stub → `Ingestion Studio.html?mode=bulk`.
The root-level `guide.js` is an unreferenced duplicate of
`universal-fee-calc/guide.js`; edit the latter.

### `api/` — Vercel serverless

- `box-token.js` — OAuth code→token exchange and refresh. Holds
  `BOX_CLIENT_SECRET`. The only place the secret is used.
- `extract.js` — proposal extraction via Claude. Holds `ANTHROPIC_API_KEY`.
  Has a self-healing model fallback chain — normally leave `CLAUDE_MODEL`
  unset so a retired model never breaks the tool.
- `clockify.js` — Clockify Reports proxy returning aggregated actuals CSV.
  Holds `CLOCKIFY_API_KEY` / `CLOCKIFY_WORKSPACE_ID`.

## Module conventions

Every module is an **IIFE that hangs one global off `window`**. No ESM in the
browser, no imports, no exports.

```js
/* ============================================================
   SAVILLS PPM · <WHAT THIS IS>
   ------------------------------------------------------------
   Why it exists, how it plugs in, how to use it.
   ============================================================ */
(function () {
  'use strict';
  // ...
  window.UFC_Thing = { /* public surface */ };
})();
```

Globals in use: `UFC_Store`, `UFC_Box`, `UFC_UI`, `UFC_Vendor`, `UFC_Staff`,
`UFC_Intake`, `UFC_BulkExcel`, `UFC_RevenueImport`, `UFC_ReconcileParse`,
`UFC_Perf`, `RATES_CATALOG`, `BENCH`, `STAFF_SEED`, `SMALLWORKS_RECORDS`,
`PPMGuide`, `EXEC_CORE`.

### Page boot sequence

Script order matters — `store.js` must precede `box-adapter.js`, which must
precede `boot.js`:

```html
<script src="universal-fee-calc/vendor-lazy.js"></script>
<script src="universal-fee-calc/rates-catalog.js"></script>
<script src="universal-fee-calc/store.js"></script>
<script src="universal-fee-calc/box-adapter.js"></script>
<script>window.UFC_NEEDS = ['revenue'];</script>   <!-- opt-in stores only -->
<script src="universal-fee-calc/boot.js"></script>
<script src="universal-fee-calc/sync-status.js"></script>
<script src="universal-fee-calc/<page>.js"></script>
<script src="universal-fee-calc/guide.js"></script>
<script src="universal-fee-calc/nav.js"></script>
```

A page controller **must** wait on the ready promise before touching data:

```js
window.ufcReady.then(() => render());
// or listen for the 'ufc:ready' DOM event
```

Boot always pulls `projects.json` + `rates.json`. `studio.json` and
`revenue.json` are read by one page each, so those pages declare
`window.UFC_NEEDS = ['studio']` / `['revenue']` **before** `boot.js` and
everyone else never fetches them. Both are read-write — rendering (and
therefore saving) before the pull landed would push a local-only copy over a
teammate's.

Other events worth knowing: `ufc:sync` (sync pill state), `ufc:remote-updated`
(a teammate's save merged in during the 3-min live refresh).

### Comment style

This codebase comments **why**, at length, in prose — including the history of
a decision and the failure it prevents. See the PARSED-DB CACHE block in
`store.js` or the header of `vendor-lazy.js`. Match that register; do not strip
existing explanatory comments when editing around them.

Em dashes and plain-English wording are the house style in user-facing strings
(the Executive Reporting module is the exception — no em dashes there, by
review ruling).

## Data model

### Box files (the shared source of truth)

| File | Contents |
|---|---|
| `projects.json` | Every project record + the activity log. Nothing else. |
| `rates.json` | The confidential rate grid. **Never in this repo.** The app gates with "Rate card unavailable" if it fails to load. |
| `staff.json` | The living staffing matrix — allocations, notes, Clockify actuals, mappings. |
| `studio.json` | Retired Revenue Studio baselines + scenarios. Kept for the Budget/RF baseline; only Executive Reporting reads it. |
| `revenue.json` | Revenue Reconciliation's actuals ledger, keyed year → project, plus the mapping book. **Self-configuring** — with no file id set it is found by name in the folder and created on first run. Merged **per row** (each carries `updatedAt`), because a whole-year newest-wins would let two admins erase each other. |

File ids are pinned in `BOX_CONFIG` at the top of `box-adapter.js`.

### Two mirrored copies

`localStorage` is the synchronous working store — every edit writes there
instantly and every existing sync call (`listProjects()`, `saveProject()`) is
unchanged. `box-adapter.js` is a sync layer on top: pull on boot, debounced
push after writes (etag-guarded), flush the moment the tab hides. Concurrent
saves merge newest-edit-wins per project; tombstones beat stale copies;
activity logs union. Sign-out clears the local copy.

### Inputs vs. frozen snapshots

**This is the most important thing about the data model.** Project records
store **inputs only** — roles, tiers, monthly FTE %, assumptions, dates. Every
dollar on screen is recomputed live from those inputs, so a math fix corrects
every project with no migration.

Exceptions:
- **Booked records** (won / active / closed) additionally freeze a `financials`
  snapshot — a contractual fact, it does not recompute.
- **Pursuits** carry a live-refreshed materialized `billingSeries` so
  Projections read one stored series everywhere instead of recomputing.
- **NTE-basis** projects auto-restamp on edit (an estimate, not a contract).

Also in the data layer: schema versioning (`SCHEMA` + a migration pipeline —
old records upgrade on load), soft-delete tombstones (purged after 120 days, so
deletes propagate through the merge instead of resurrecting), append-only
activity log, per-project version history with diff and restore.

### The revenue vocabulary

Revenue Reconciliation reads the same dollars on four calendars: **EARNED**
(what the fee tool says), **ACCRUED**, **BILLED**, **REALIZED** (Finance's
report). `recognised = billed + fee share + accrued`. A **slip** is Finance
moving a missed fee to a later month — it moves money, never creates it, and an
open slip flags the affected months red on Revenue Projections.

## Access control

Sign-in is Box OAuth — no Box login, no app. Visibility is **fail-closed**.

Two functions, two jobs — **mixing them up is the easy way to leak data**:

- `isAdmin(user)` → may they open this **tool**? True for admins *and* tool
  admins. Use it for page gates and nav links.
- `seesAllProjects(user)` → may they see **every project's data**? True for
  full `ADMINS` only. Every data-visibility decision must use this —
  `visibleProjects`, the calculator's access wall, Change Log scope,
  Proposal Analytics, Executive Reporting.

`ADMINS`, `TOOL_ADMINS` and `SUPERUSERS` are hardcoded near the identity block
in `store.js` as the bootstrap floor. Granting admin without a deploy: a
superuser runs `UFC_Store.addVocab({ admins: ['name@savills.us'] })` in the
console — it syncs like any other data edit. Removals still require a deploy,
deliberately.

Hiding a nav link is not access control — a page that posts numbers the
business reports on gates itself too (see the inline gate in
`Revenue Reconciliation.html`).

Superusers get "Viewing as" impersonation (session-scoped) and can set
maintenance mode, which blocks *writes* for everyone else during a bulk scrub.

## Testing

`tests.html` is a self-contained regression suite — **158 assertions across 37
groups** covering the engine invariants (waterfall identity, rate lock, broker
direction, monthly decomposition, NTE), the data layer (tombstones, migrations,
activity), the revenue ledger, allocations, the three calendars, mapping, the
close-file parser, staffing, and the revenue diff. It installs an in-memory
`localStorage` shim before `store.js` loads, so it can never touch real
Box-synced data, and uses a synthetic rate grid (PM @ $200 rack) — never the
confidential one.

Run it headless:

```bash
npm install --no-save playwright
npx playwright install chromium          # first time only
node scripts/run-tests.mjs               # exits non-zero on any failure
```

In an environment with a pre-installed Chromium whose version doesn't match
Playwright's pin, the runner honours `CHROMIUM_PATH`:

```bash
CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node scripts/run-tests.mjs
```

Or just open `tests.html` in a browser. CI (`.github/workflows/tests.yml`) runs
the same runner on every push and PR.

**Adding a test:** append a `test('Group · subgroup', 'what it asserts', fn)`
call in `tests.html`. Return `true`/`undefined` to pass, or a string describing
the failure. `eq(a, b, label)` compares within a 0.02 epsilon.

`exec-reporting/verify-core.mjs` is a **dev-only** harness (73 checks) that
reconciles the Executive Reporting core against frozen fixtures held in a
sibling repo. It will not run here without those fixtures — that is expected,
not a break.

Tests alone are not the bar for anything that renders. The working agreement
above requires browser checks for anything touched.

## Deploy

Vercel, no build step. Everything at the root is served as-is; `api/*.js`
become functions automatically. Entry point is `Fee Generator.html`.

Required env vars: `BOX_CLIENT_ID`, `BOX_CLIENT_SECRET`, `ANTHROPIC_API_KEY`,
`CLOCKIFY_API_KEY`, `CLOCKIFY_WORKSPACE_ID`. Set them for Production, Preview
*and* Development, then redeploy — Vercel does not apply new vars to existing
deployments.

The Box app needs `https://<domain>/oauth-callback.html` as a redirect URI for
**every** domain that serves the app, preview domains included. A missing
redirect URI is the single most common cause of a failed sign-in.

`vercel.json` sets `must-revalidate` on html/js/css/json and a 1-day cache on
`vendor/`. `DEPLOY.md` has the full runbook and the post-deploy verification
checklist.

## Gotchas

- **Cache-busting stamps.** `Executive Reporting.html`, `Profitability.html`
  and `Staffing Matrix.html` carry `?v=YYYYMMDDx` on their script tags. If you
  edit a file those pages load, bump the stamp or browsers keep serving the old
  copy after a deploy.
- **`readDb()` returns the cached object, not a clone.** Callers mutate it and
  then `writeDb()` — that is the contract. The cache is keyed on the raw
  localStorage string, so it stays correct even when something writes without
  going through `writeDb()`.
- **Never load a CDN at runtime.** ExcelJS and SheetJS are vendored so the app
  works on a locked-down network. Go through `UFC_Vendor`, never a `<script>`
  tag — a blocking tag puts up to 1.8MB back on page load.
- **Filenames with spaces are load-bearing.** Existing links and bookmarks
  depend on them. Don't rename pages.
- **`exec-reporting/` never writes.** It is read-only over the four Box files,
  gated on `seesAllProjects` alone (tool admins excluded).
- **Performance is a feature here.** Recent work took Projects Index from 9.8s
  to 0.4s and navigation from ~1s to ~200ms. `UFC_Perf.report()` in the console
  prints the boot timing table. Don't reintroduce full-book parses in a loop.

## Git

- Branch from `main`; push with `git push -u origin <branch>`.
- Commit subjects are **plain-English statements of the user-visible outcome**,
  not conventional-commit prefixes. Real examples:
  `Renaming a project no longer breaks its Clockify link`,
  `Cache the parsed project book — Projects Index 9.8s to 0.4s`,
  `Revenue Projections: option to hide closed-out projects`.
  A `Page: what changed` prefix is common and welcome.
- Scratch harnesses (`_*.html`) must never land in a diff.

## Deeper reference

- `README.md` — page-by-page map and module list.
- `README - how this system fits together.md` — the aggregation vs. reporting split.
- `DEPLOY.md` — deployment and post-deploy verification.
- `Maintainers Runbook.html` (deployed) — the deep technical reference:
  architecture, data flow, the exact fee math, config table.
- `exec-reporting/BUILD-STATE.md` — that module's port history and watchpoints.
- `docs/` — repo-only: migration guide, roadmap, readiness report.
