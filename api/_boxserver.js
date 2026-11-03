/* Box from the server side — the Platform App with server authentication
   (Client Credentials Grant). Used by the scheduled drops (clockify-daily,
   org-daily) and by the on-demand org pull when the app is authorised.
   Underscore-prefixed files in api/ are not routes.

   ENV  BOX_CCG_CLIENT_ID, BOX_CCG_CLIENT_SECRET, BOX_ENTERPRISE_ID,
        BOX_FOLDER_ID (optional; defaults to the app's shared folder). */
export const FOLDER_ID = () => process.env.BOX_FOLDER_ID || '387228486391';

export function serverAuthConfigured() { return !!(process.env.BOX_CCG_CLIENT_ID && process.env.BOX_CCG_CLIENT_SECRET && process.env.BOX_ENTERPRISE_ID); }

export async function boxToken() {
  const id = process.env.BOX_CCG_CLIENT_ID, secret = process.env.BOX_CCG_CLIENT_SECRET, ent = process.env.BOX_ENTERPRISE_ID;
  if (!id || !secret || !ent) throw Object.assign(new Error('Box server auth not configured — set BOX_CCG_CLIENT_ID, BOX_CCG_CLIENT_SECRET and BOX_ENTERPRISE_ID.'), { code: 501 });
  const r = await fetch('https://api.box.com/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, box_subject_type: 'enterprise', box_subject_id: ent }) });
  if (!r.ok) throw Object.assign(new Error('Box refused the server credentials (' + r.status + '): ' + (await r.text()).slice(0, 200) + ' — is the app authorised in the Admin Console?'), { code: 502 });
  return (await r.json()).access_token;
}
export async function boxJson(tok, path) {
  const r = await fetch('https://api.box.com/2.0' + path, { headers: { Authorization: 'Bearer ' + tok } });
  if (!r.ok) throw Object.assign(new Error('Box ' + r.status + ' on ' + path + ': ' + (await r.text()).slice(0, 200)), { code: 502 });
  return r.json();
}
/** The folder a drop lives in: the "Main Source" subfolder when it exists, else the root. */
export async function targetFolder(tok) {
  const root = await boxJson(tok, '/folders/' + FOLDER_ID() + '/items?fields=name,type&limit=1000');
  const items = root.entries || [];
  const main = items.find(e => e.type === 'folder' && String(e.name || '').toLowerCase() === 'main source');
  if (!main) return { id: FOLDER_ID(), items };
  const sub = await boxJson(tok, '/folders/' + main.id + '/items?fields=name,type&limit=1000');
  return { id: main.id, items: (sub.entries || []).concat(items) };
}
/** Create or replace one JSON file in the drop folder. */
export async function writeDrop(tok, name, drop) {
  const { id: folderId, items } = await targetFolder(tok);
  const existing = items.find(e => e.type === 'file' && e.name === name);
  const form = new FormData();
  form.append('attributes', JSON.stringify(existing ? { name } : { name, parent: { id: folderId } }));
  form.append('file', new Blob([JSON.stringify(drop)], { type: 'application/json' }), name);
  const url = existing ? 'https://upload.box.com/api/2.0/files/' + existing.id + '/content' : 'https://upload.box.com/api/2.0/files/content';
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: form });
  if (!r.ok) throw Object.assign(new Error('Box upload failed (' + r.status + '): ' + (await r.text()).slice(0, 200)), { code: 502 });
  const j = await r.json(); const f = (j.entries && j.entries[0]) || {};
  return { fileId: f.id || (existing && existing.id) || '', folderId, replaced: !!existing, name };
}
export function cronAuthorized(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) { res.status(501).json({ error: 'not configured', detail: 'Set CRON_SECRET in Vercel env vars; Vercel sends it on scheduled runs.' }); return false; }
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  if (!m || m[1] !== secret) { res.status(401).json({ error: 'unauthorized' }); return false; }
  return true;
}
