/* ============================================================
   VERCEL SCHEDULED FUNCTION · the daily org-chart drop
   ------------------------------------------------------------
   Path:  /api/org-daily   (run by the schedule in vercel.json; callable by
          hand with the same secret for a first run)

   Pulls the current employee list with reporting lines from BambooHR
   (api/_bamboo.js) and writes ONE file, org-latest.json, into the shared
   Box folder (Main Source), beside clockify-latest.json. It never touches
   staff.json: the first browser that opens the staffing page after a newer
   drop commits it into the staffing store (UFC_Staff.setOrg), which is how
   a revenue leader's team is known.

   ENV  BAMBOO_SUBDOMAIN, BAMBOO_API_KEY  (api/_bamboo.js)
        BOX_CCG_CLIENT_ID, BOX_CCG_CLIENT_SECRET, BOX_ENTERPRISE_ID, CRON_SECRET,
        BOX_FOLDER_ID (optional)          (api/_boxserver.js)
   ============================================================ */
import { fetchOrg, BambooError } from './_bamboo.js';
import { boxToken, writeDrop, cronAuthorized } from './_boxserver.js';

export const config = { maxDuration: 60 };
const DROP_NAME = 'org-latest.json';

export default async function handler(req, res) {
  if (!cronAuthorized(req, res)) return;
  try {
    const tok = await boxToken();
    const drop = await fetchOrg();
    const out = await writeDrop(tok, DROP_NAME, drop);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, pulledAt: drop.pulledAt, elapsedMs: drop.elapsedMs, people: drop.count, withEmail: drop.withEmail, withSupervisor: drop.withSupervisor, box: out });
  } catch (e) {
    const code = e instanceof BambooError ? 502 : (e && e.code) || 500;
    res.status(code).json({ error: e instanceof BambooError ? 'bamboohr ' + e.status : 'org pull failed', detail: String((e && (e.detail || e.message)) || e).slice(0, 400) });
  }
}
