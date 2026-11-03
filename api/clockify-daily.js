/* ============================================================
   VERCEL SCHEDULED FUNCTION · the daily Clockify drop
   ------------------------------------------------------------
   Path:  /api/clockify-daily   (run by the schedule in vercel.json;
          callable by hand with the same secret for a first run)

   WHAT IT DOES
     Pulls from Clockify everything the Staffing, Bandwidth & Clockify page
     imports — hours by user × project × month for the last 13 months, the
     entry-lateness stats for the last 6, the user list with titles, the
     project list — and writes ONE file, clockify-latest.json, into the
     shared Box folder (Main Source). It never touches staff.json: the first
     browser that opens the staffing page after a newer drop commits it
     through the same code the Import button runs, and records which drop
     it took, so nobody clicks anything and nothing is imported twice.

   SETUP (Vercel project → Settings → Environment Variables)
     CLOCKIFY_API_KEY, CLOCKIFY_WORKSPACE_ID   (already there for the proxy)
     BOX_CCG_CLIENT_ID, BOX_CCG_CLIENT_SECRET  the Box Platform App with
                                               server authentication (Client
                                               Credentials Grant), authorised
                                               by a Box admin, its service
                                               account an Editor on the folder
     BOX_ENTERPRISE_ID                         from the app's General Settings
     CRON_SECRET                               any long random string; Vercel
                                               sends it on scheduled runs, and a
                                               manual run must carry it as
                                               Authorization: Bearer <secret>
     BOX_FOLDER_ID (optional)                  the shared folder; defaults to
                                               the app's folder id
   ============================================================ */
import { buildDrop, ClockifyError } from './_clockify.js';
import { boxToken, writeDrop, cronAuthorized } from './_boxserver.js';

export const config = { maxDuration: 60 };

const DROP_NAME = 'clockify-latest.json';

export default async function handler(req, res) {
  if (!cronAuthorized(req, res)) return;
  const key = process.env.CLOCKIFY_API_KEY, ws = process.env.CLOCKIFY_WORKSPACE_ID;
  if (!key || !ws) { res.status(501).json({ error: 'not configured', detail: 'Set CLOCKIFY_API_KEY and CLOCKIFY_WORKSPACE_ID.' }); return; }
  try {
    const tok = await boxToken();                       // fail fast on the Box side before spending a minute in Clockify
    const drop = await buildDrop({ key, ws });
    const out = await writeDrop(tok, DROP_NAME, drop);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, pulledAt: drop.pulledAt, elapsedMs: drop.elapsedMs, timing: drop.timing, actuals: { start: drop.actuals.start, end: drop.actuals.end, rows: drop.actuals.rows },
      lateness: drop.lateness.error ? { error: drop.lateness.error } : { start: drop.lateness.start, end: drop.lateness.end, rows: drop.lateness.rows },
      users: drop.users.count, projects: drop.projects.count, box: out });
  } catch (e) {
    const code = e instanceof ClockifyError ? 502 : (e && e.code) || 500;
    res.status(code).json({ error: e instanceof ClockifyError ? 'clockify ' + e.status : 'daily pull failed', detail: String((e && (e.detail || e.message)) || e).slice(0, 400) });
  }
}
