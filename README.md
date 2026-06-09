# Savills PPM · Fee Proposal Generator

A multi-page, Box-backed system for building, pricing, storing, and reporting on
fee proposals. Pure static front-end (HTML + vanilla JS) plus two Vercel
serverless functions. No build step.

**Read `Maintainers Runbook.html` first** — it documents the architecture, the
calculation pipeline, caveats, config, deploy steps, and known limits in full.

---

## Structure

```
/
├── Fee Generator.html            ← HOME / hub (links to everything below)
├── Universal Fee Calculator.html ← build & price a proposal (the core tool)
├── Projects Index.html           ← the project database (all records)
├── Revenue Projections.html      ← pipeline / revenue forecast
├── Ingestion Studio.html         ← import a historical proposal (uses Claude)
├── Benchmarking Dashboard.html   ← "what have we charged before?"
├── Enterprise Migration Guide.html · Fee System Roadmap.html  ← internal docs
├── Maintainers Runbook.html      ← THE handoff doc (architecture + math + ops)
├── oauth-callback.html           ← Box OAuth redirect target (REQUIRED)
│
├── api/                          ← Vercel serverless functions
│   ├── box-token.js              ← Box OAuth token exchange + refresh (holds the secret)
│   └── extract.js                ← proposal extraction via Claude (Ingestion)
│
├── universal-fee-calc/           ← the application code (shared by every page)
│   ├── rates-catalog.js          ← rate ENGINE only — NO confidential numbers
│   ├── store.js                  ← data layer, access rules, financials snapshot
│   ├── box-adapter.js            ← Box sync (auth, pull/push, rates pull, config)
│   ├── boot.js                   ← gates each page on auth + data load
│   ├── sync-status.js            ← the on-page "Synced to Box" indicator
│   ├── app.js                    ← the calculator engine + UI
│   ├── intake.js                 ← Salesforce intake email + drift detection
│   ├── ingest.js · bench*.js      ← Ingestion + Benchmarking
│   ├── export-excel.js           ← the 4-tab Excel export (live formulas)
│   └── styles.css
│
├── design-system/                ← brand: colours, type, Gotham fonts, logo
├── package.json
├── .vercelignore                 ← keeps confidential files off the public origin
└── .gitignore

NOT in this repo (by design — confidential, lives in Box):
   rates.json   ← the Macro rate grid (rack rates, cost floors, discounts)
```

## The one rule
The rate numbers must NEVER be committed. The grid lives only in Box as
`rates.json`; the app pulls it after login and hydrates the engine in memory.
`.gitignore` blocks it from being committed; `.vercelignore` blocks it (and
`research/`) from deploying.

## Setup (one-time) — see the Runbook §12–13 for detail
1. **Box app** (Developer Console): User Auth (OAuth 2.0), PKCE enabled, redirect
   URI `https://<your-vercel-domain>/oauth-callback.html`, read/write scope.
2. **Box folder**: put `projects.json` (`{"schemaVersion":1,"projects":{}}`) and
   the confidential `rates.json` in it; copy both file ids + the folder id into
   `universal-fee-calc/box-adapter.js` → `BOX_CONFIG`.
3. **Vercel env vars**: `BOX_CLIENT_ID`, `BOX_CLIENT_SECRET`, `ANTHROPIC_API_KEY`.
4. Confirm `BOX_CONFIG`: `enabled:true`, `testMode:false`, `clientId`,
   `dataFileId`, `ratesFileId`, `folderId`.

Until `rates.json` exists in Box with its id set, every page shows a
"Rate card unavailable" gate by design.

## Access (fail-closed)
Admins (allowlist in `store.js`) see everything; everyone else sees only their
own projects; an unrecognized login sees nothing. Box folder permission is the
true boundary — see Runbook §6.
