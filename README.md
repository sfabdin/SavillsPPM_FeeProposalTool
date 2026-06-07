# Savills PPM · Fee Proposal Tool

A multi-page, Box-backed system for building, storing, and reporting on fee
proposals. Pure static front-end (HTML + vanilla JS) plus two Vercel
serverless functions. No build step.

---

## Structure

```
/
├── Fee Generator.html            ← HOME / hub (links to everything below)
├── Universal Fee Calculator.html ← build a proposal (the core tool)
├── Projects Index.html           ← the project database (all records)
├── Ingestion Studio.html         ← import a historical proposal (uses Claude)
├── Benchmarking Dashboard.html   ← "what have we charged before?"
├── Revenue Projections.html      ← pipeline / revenue forecast view
├── Enterprise Migration Guide.html ← internal doc: going live / hosting
├── Fee System Roadmap.html       ← internal doc: phased roadmap
├── oauth-callback.html           ← Box OAuth redirect target (REQUIRED)
│
├── api/                          ← Vercel serverless functions
│   ├── box-token.js              ← Box OAuth token exchange + refresh (holds the secret)
│   └── extract.js                ← proposal extraction via Claude (Ingestion Studio)
│
├── universal-fee-calc/           ← the application code (shared by every page)
│   ├── rates-catalog.js          ← rate ENGINE only — NO confidential numbers
│   ├── store.js                  ← localStorage data layer + access rules
│   ├── box-adapter.js            ← Box sync layer (auth, pull/push, rates pull)
│   ├── boot.js                   ← gates each page on auth + data load
│   ├── sync-status.js            ← the on-page "Synced to Box" indicator
│   ├── app.js                    ← the calculator
│   ├── intake.js                 ← Salesforce intake email + drift detection
│   ├── ingest.js                 ← Ingestion Studio logic
│   ├── bench.js / bench-data.js  ← Benchmarking
│   ├── export-excel.js           ← Excel export (live formulas)
│   └── styles.css
│
├── design-system/                ← brand: colours, type, Gotham fonts, logo
├── package.json
├── .vercelignore                 ← keeps confidential files off the public origin
└── .gitignore

NOT in this repo (by design — confidential, lives in Box):
   rates.json   ← the Macro 2024 rate grid (rack rates, cost floors, discounts)
```

---

## The rate card is NOT in this code

The confidential rate grid (rack rates, cost-rate floors, target discounts) is
**not** in `rates-catalog.js` — anything in the deployed bundle is readable at
its URL with no login. The grid lives in **Box** as `rates.json` and is pulled
in only after a successful Box sign-in.

`rates-catalog.js` is the engine (the High/Mid/Low math + title mapping). On
boot it pulls `rates.json` from Box and hydrates the catalog in memory.

---

## Setup (one-time)

### 1. Box app (Developer Console → My Apps)
- Custom App → **User Authentication (OAuth 2.0)**
- Redirect URI = `https://<your-vercel-domain>/oauth-callback.html`
- Enable **Authorization Code Grant with PKCE**
- Scopes: **Read and write all files and folders**
- Copy the **Client ID** → `universal-fee-calc/box-adapter.js` → `BOX_CONFIG.clientId`

### 2. Box folder — two JSON files
- Put an empty `projects.json` → `{"schemaVersion":1,"projects":{}}` in a Box folder.
  Copy its **file id** → `BOX_CONFIG.dataFileId`.
- Upload **`rates.json`** (the confidential grid — supplied separately) into the
  same folder. Copy its **file id** → `BOX_CONFIG.ratesFileId`.

### 3. Vercel environment variables
- `BOX_CLIENT_ID`     — the Box app client id
- `BOX_CLIENT_SECRET` — the Box app client secret (server-side only)
- `ANTHROPIC_API_KEY` — for `api/extract.js` (Ingestion Studio)
- Redeploy after setting them.

### 4. Confirm config in `universal-fee-calc/box-adapter.js`
```
enabled:     true
testMode:    false           // production OAuth
clientId:    <your Box client id>
dataFileId:  <projects.json file id>
ratesFileId: <rates.json file id>   // currently "PASTE_RATES_FILE_ID"
```

Until `ratesFileId` is set and `rates.json` exists in Box, every page shows a
**"Rate card unavailable"** gate (by design — it refuses to run without rates).

---

## Security notes
- **Box folder permissions are the real access boundary.** The in-app per-person
  filter is a view convenience, not a hard wall — anyone who can authenticate
  could read the data file directly.
- `rates.json` and `research/` are kept off the public origin via `.vercelignore`,
  and `rates.json` is git-ignored so it can't be committed.
- No client secret ships to the browser — the OAuth exchange runs in
  `api/box-token.js`.
