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

export const config = { maxDuration: 60 };

const FOLDER_ID = () => process.env.BOX_FOLDER_ID || '387228486391';
const DROP_NAME = 'clockify-latest.json';

async function boxToken() {
  const id = process.env.BOX_CCG_CLIENT_ID, secret = process.env.BOX_CCG_CLIENT_SECRET, ent = process.env.BOX_ENTERPRISE_ID;
  if (!id || !secret || !ent) throw Object.assign(new Error('Box server auth not configured — set BOX_CCG_CLIENT_ID, BOX_CCG_CLIENT_SECRET and BOX_ENTERPRISE_ID.'), { code: 501 });
  const r = await fetch('https://api.box.com/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, box_subject_type: 'enterprise', box_subject_id: ent }) });
  if (!r.ok) throw Object.assign(new Error('Box refused the server credentials (' + r.status + '): ' + (await r.text()).slice(0, 200) + ' — is the app authorised in the Admin Console?'), { code: 502 });
  return (await r.json()).access_token;
}
async function boxJson(tok, path) { const r = await fetch('https://api.box.com/2.0' + path, { headers: { Authorization: 'Bearer ' + tok } }); if (!r.ok) throw Object.assign(new Error('Box ' + r.status + ' on ' + path + ': ' + (await r.text()).slice(0, 200)), { code: 502 }); return r.json(); }

/** The folder the drop lives in: the "Main Source" subfolder when it exists, else the root. */
async function targetFolder(tok) {
  const root = await boxJson(tok, '/folders/' + FOLDER_ID() + '/items?fields=name,type&limit=1000');
  const items = root.entries || [];
  const main = items.find(e => e.type === 'folder' && String(e.name || '').toLowerCase() === 'main source');
  if (!main) return { id: FOLDER_ID(), items };
  const sub = await boxJson(tok, '/folders/' + main.id + '/items?fields=name,type&limit=1000');
  return { id: main.id, items: (sub.entries || []).concat(items) };
}
async function writeDrop(tok, drop) {
  const { id: folderId, items } = await targetFolder(tok);
  const existing = items.find(e => e.type === 'file' && e.name === DROP_NAME);
  const form = new FormData();
  form.append('attributes', JSON.stringify(existing ? { name: DROP_NAME } : { name: DROP_NAME, parent: { id: folderId } }));
  form.append('file', new Blob([JSON.stringify(drop)], { type: 'application/json' }), DROP_NAME);
  const url = existing ? 'https://upload.box.com/api/2.0/files/' + existing.id + '/content' : 'https://upload.box.com/api/2.0/files/content';
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: form });
  if (!r.ok) throw Object.assign(new Error('Box upload failed (' + r.status + '): ' + (await r.text()).slice(0, 200)), { code: 502 });
  const j = await r.json(); const f = (j.entries && j.entries[0]) || {};
  return { fileId: f.id || (existing && existing.id) || '', folderId, replaced: !!existing };
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) { res.status(501).json({ error: 'not configured', detail: 'Set CRON_SECRET in Vercel env vars; Vercel sends it on scheduled runs.' }); return; }
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  if (!m || m[1] !== secret) { res.status(401).json({ error: 'unauthorized' }); return; }
  const key = process.env.CLOCKIFY_API_KEY, ws = process.env.CLOCKIFY_WORKSPACE_ID;
  if (!key || !ws) { res.status(501).json({ error: 'not configured', detail: 'Set CLOCKIFY_API_KEY and CLOCKIFY_WORKSPACE_ID.' }); return; }
  try {
    const tok = await boxToken();                       // fail fast on the Box side before spending a minute in Clockify
    const drop = await buildDrop({ key, ws });
    const out = await writeDrop(tok, drop);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, pulledAt: drop.pulledAt, elapsedMs: drop.elapsedMs, timing: drop.timing, actuals: { start: drop.actuals.start, end: drop.actuals.end, rows: drop.actuals.rows },
      lateness: drop.lateness.error ? { error: drop.lateness.error } : { start: drop.lateness.start, end: drop.lateness.end, rows: drop.lateness.rows },
      users: drop.users.count, projects: drop.projects.count, box: out });
  } catch (e) {
    const code = e instanceof ClockifyError ? 502 : (e && e.code) || 500;
    res.status(code).json({ error: e instanceof ClockifyError ? 'clockify ' + e.status : 'daily pull failed', detail: String((e && (e.detail || e.message)) || e).slice(0, 400) });
  }
}
