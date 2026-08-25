# PPM Fee & Revenue System — Deployment

Static site + three serverless functions. Built for Vercel; any host that runs
Node serverless functions from `/api` will work.

## 1. Deploy

Drop this folder into a Vercel project (or `vercel --prod` from inside it).
No build step — `package.json` has no build script on purpose. Everything in
the root is served as-is; `/api/*.js` become serverless functions automatically.

Entry point is `Fee Generator.html` (the home page). Filenames are kept from
the original build so existing links and bookmarks keep working.

## 2. Environment variables (Vercel → Settings → Environment Variables)

| Variable | Required | Used by | Notes |
|---|---|---|---|
| `BOX_CLIENT_ID` | **Yes** | `api/box-token.js` | The Box app's client id. Safe to be public; it is also pinned in `box-adapter.js`. |
| `BOX_CLIENT_SECRET` | **Yes** | `api/box-token.js` | Sign-in breaks without it. Never expose client-side. |
| `ANTHROPIC_API_KEY` | For Ingestion Studio | `api/extract.js` | Only needed for PDF proposal extraction. |
| `CLOCKIFY_API_KEY` | For actuals | `api/clockify.js` | Server-side only. |
| `CLOCKIFY_WORKSPACE_ID` | For actuals | `api/clockify.js` | The workspace the Reports API aggregates over. |

Set for **Production, Preview, and Development**, then redeploy — Vercel does
not apply new vars to existing deployments.

## 3. Box app configuration

In the Box developer console for the app, add the redirect URI:

```
https://<your-domain>/oauth-callback.html
```

Add it for **every** domain that serves the app, including the
`*.vercel.app` preview domain if you use it. A missing redirect URI is the
single most common cause of a failed sign-in.

## 4. Box data files

Five JSON files live in one Box folder, pinned by file id in
`universal-fee-calc/box-adapter.js`. Confirm these ids point at the right
folder before going live:

- `rates.json` — the PPM rate grid. **The app gates until this loads.**
- `projects.json` — all project records + the activity log
- `staff.json` — staffing matrix, Clockify actuals, mapping tables
- `studio.json` — retired Revenue Studio baselines and scenarios (kept for the
  Budget/RF baseline; only Executive Reporting reads it)
- `revenue.json` — the Revenue Reconciliation ledger + mapping book.
  **No file id needed** — it is found by name in the folder and created on
  first run, so every admin lands on the same file.

Everyone who uses the app needs at least Viewer access to that folder;
editors need Editor. Access is two steps: granted in the app **and** in Box.

`rates.json` is **not in this repo** — `.gitignore` blocks it and
`.vercelignore` keeps it off the public origin. Maintain it directly in Box and
put its file id in `box-adapter.js`. If you stage a local copy to upload,
delete it afterwards; anything in the deployed bundle is readable at its URL
with no login.

## 5. Verify after deploy

1. Load the home page → sign in with Box.
2. `tests.html` → the regression suite should be all-green (158/158). You can
   also run it headless before deploying: `node scripts/run-tests.mjs`.
3. Projects Index → confirm records load (proves `projects.json` is wired).
4. Create a throwaway project, save, then check **Change Log** shows you as
   the actor with the right fields.
5. Delete the throwaway and confirm it restores from the index.

## What's excluded

`.vercelignore` keeps these off the public origin: `rates.json`, `research/`
(real fee sheets), `docs/` (repo-only reference), and the old working-backup
folders `_changed*/` and `screenshots/`. Everything else at the root deploys
as-is.
