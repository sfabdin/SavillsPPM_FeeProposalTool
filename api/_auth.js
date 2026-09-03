/* Shared authorisation for the serverless functions.

   A caller proves who they are with their own Box access token: we round-trip
   it to Box (/users/me), require a Savills login, and — new — require that
   the same token can see the app's shared folder. Being a Savills Box user is
   not the same as being on this team; the folder ACL is the real boundary
   everywhere else in the app, so it is the boundary here too.

   Underscore-prefixed files in api/ are not routes. */
const FOLDER_ID = process.env.BOX_FOLDER_ID || '387228486391';   // the shared data folder (see box-adapter BOX_CONFIG.folderId)

export async function requireCollaborator(req, res, opts) {
  const o = opts || {};
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  if (!m) { res.status(401).json({ error: 'sign in required', detail: 'Missing session token — reload the app and sign in with Box.' }); return null; }
  const tok = m[1];
  const H = { Authorization: 'Bearer ' + tok };
  try {
    const r = await fetch('https://api.box.com/2.0/users/me?fields=login', { headers: H });
    if (!r.ok) { res.status(401).json({ error: 'session expired', detail: 'Box rejected the token (' + r.status + ') — reload and sign in again.' }); return null; }
    const me = await r.json();
    const login = String(me.login || '').toLowerCase();
    if (!/@savills\.(us|com)$/.test(login)) { res.status(403).json({ error: 'not authorized', detail: login + ' is not a Savills account.' }); return null; }
    // Can this token see the team folder? A collaborator gets 200; anyone else 403/404.
    const f = await fetch('https://api.box.com/2.0/folders/' + FOLDER_ID + '?fields=id', { headers: H });
    if (!f.ok) { res.status(403).json({ error: 'not authorized', detail: 'Your Box account is not a collaborator on the PPM data folder.' }); return null; }
    if (o.limit && !allow(login, o.limit)) { res.status(429).json({ error: 'too many requests', detail: 'Slow down — try again in a minute.' }); return null; }
    return login;
  } catch (e) { res.status(401).json({ error: 'auth check failed', detail: String(e && e.message || e).slice(0, 200) }); return null; }
}

/* Best-effort per-instance rate limit: N calls per login per minute. A warm
   serverless instance keeps this map between invocations; a cold one starts
   fresh. That is enough to stop a script from burning credit in a loop. */
const _hits = new Map();
function allow(login, perMinute) {
  const now = Date.now(), win = 60000;
  const list = (_hits.get(login) || []).filter(t => now - t < win);
  if (list.length >= perMinute) { _hits.set(login, list); return false; }
  list.push(now); _hits.set(login, list);
  return true;
}
