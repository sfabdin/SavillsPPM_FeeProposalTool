/* ============================================================
   VERCEL SERVERLESS FUNCTION · Clockify → aggregated actuals CSV
   ------------------------------------------------------------
   Paths:
     /api/clockify?start=2026-01-01&end=2026-06-30   → actuals CSV
     /api/clockify?list=projects                     → project list CSV
     /api/clockify?list=users                        → user list CSV
     /api/clockify?lateness=1&start&end              → entry-lateness stats CSV
       (creation time is decoded from each entry's MongoDB ObjectID — first
        4 bytes are a unix timestamp — vs the day the work happened; the
        detailed report is paged server-side and only per-user aggregates
        travel to the browser, so it stays fast)

   WHY THIS EXISTS
     The Staffing & Bandwidth page needs ACTUAL hours by
     user × project × month. Pulling raw time entries is huge and slow;
     Clockify's Reports API aggregates server-side, so ONE request
     returns a few hundred rows no matter how many entries exist.
     The API key must never live in browser code, so this proxy holds
     it as an environment variable and returns a small CSV the page's
     existing importer ingests directly.

   SETUP (Vercel project → Settings → Environment Variables)
     CLOCKIFY_API_KEY       = Profile → Advanced → API Key  (use a
                              reporting/service account, not a personal one)
     CLOCKIFY_WORKSPACE_ID  = Workspace Settings URL: /workspaces/{THIS}/…

   RESPONSE  text/csv:
     User,Project,Client,Duration (decimal),Start Date
   (Start Date = first of the month — the importer buckets by month.)
   ============================================================ */

import { usersCsv, projectsCsv, latenessCsv, actualsCsv, isDay, ClockifyError } from './_clockify.js';

/* AUTH: this endpoint returns employee names, hours and project assignments —
   it must not be publicly callable. See api/_auth.js: a valid Box session,
   a Savills login, AND collaborator access to the team folder. */
import { requireCollaborator } from './_auth.js';

export default async function handler(req, res) {
  const login = await requireCollaborator(req, res, { limit: 60 });
  if (!login) return;
  const key = process.env.CLOCKIFY_API_KEY;
  const ws = process.env.CLOCKIFY_WORKSPACE_ID;
  if (!key || !ws) { res.status(501).json({ error: 'not configured', detail: 'Set CLOCKIFY_API_KEY and CLOCKIFY_WORKSPACE_ID in Vercel env vars.' }); return; }

  const sendCsv = (csv) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.status(200).send(csv); };
  const fail = (e) => { if (e instanceof ClockifyError) res.status(502).json({ error: 'clockify ' + e.status, detail: e.detail }); else res.status(500).json({ error: 'proxy failed', detail: String(e && e.message || e).slice(0, 300) }); };
  try {
    // ---- user list: canonical people names for the people mapping, job title riding along as a custom field ----
    if (req.query.list === 'users') {
      const u = await usersCsv({ key, ws });
      if (req.query.debug) { res.setHeader('Content-Type', 'application/json'); res.status(200).json(u.users.slice(0, 5)); return; }
      sendCsv(u.csv); return;
    }
    // ---- project list: canonical names for the mapping tab ----
    if (req.query.list === 'projects') { sendCsv((await projectsCsv({ key, ws })).csv); return; }
    const start = String(req.query.start || '').slice(0, 10), end = String(req.query.end || '').slice(0, 10);
    if (!isDay(start) || !isDay(end)) { res.status(400).json({ error: 'pass start=YYYY-MM-DD&end=YYYY-MM-DD' }); return; }
    // ---- lateness: per-user entry-timeliness aggregates ----
    if (req.query.lateness) { sendCsv((await latenessCsv({ key, ws, start, end })).csv); return; }
    // ---- actuals: hours by user × project × month ----
    sendCsv((await actualsCsv({ key, ws, start, end })).csv);
  } catch (e) { fail(e); }
}
