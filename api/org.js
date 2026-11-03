/* ============================================================
   VERCEL SERVERLESS FUNCTION · the org chart, on demand
   ------------------------------------------------------------
   Path:  /api/org            → the org drop as JSON (BambooHR, current
                                 employees, reporting lines by email)
          /api/org?write=1    → the same, also written to Box as
                                 org-latest.json when the server-side Box app
                                 is configured; otherwise the browser writes
                                 it with the signed-in session (Box.writeOrgDrop)

   Who may call it: a signed-in collaborator on the team folder, like the
   Clockify proxy (api/_auth.js). The BambooHR key never leaves the server.
   ============================================================ */
import { requireCollaborator } from './_auth.js';
import { fetchOrg, BambooError, bambooConfigured } from './_bamboo.js';
import { boxToken, writeDrop, serverAuthConfigured } from './_boxserver.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const login = await requireCollaborator(req, res, { limit: 10 });
  if (!login) return;
  if (!bambooConfigured()) { res.status(501).json({ error: 'not configured', detail: 'Set BAMBOO_SUBDOMAIN and BAMBOO_API_KEY in Vercel env vars.' }); return; }
  try {
    const drop = await fetchOrg();
    drop.pulledBy = login;
    let box = null;
    if (req.query.write && serverAuthConfigured()) { try { box = await writeDrop(await boxToken(), 'org-latest.json', drop); } catch (e) { box = { error: String(e && e.message || e).slice(0, 200) }; } }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, drop, box });
  } catch (e) {
    const code = e instanceof BambooError ? 502 : (e && e.code) || 500;
    res.status(code).json({ error: e instanceof BambooError ? 'bamboohr ' + e.status : 'org pull failed', detail: String((e && (e.detail || e.message)) || e).slice(0, 400) });
  }
}
