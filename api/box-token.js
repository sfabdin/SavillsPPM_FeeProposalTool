/* ============================================================
   VERCEL SERVERLESS FUNCTION · Box OAuth token exchange
   ------------------------------------------------------------
   Path:  /api/box-token   (Vercel maps /api/*.js automatically)

   WHY THIS EXISTS
     Your Box app has a Client Secret. The OAuth code→token exchange
     must include that secret, and a secret must NEVER live in browser
     code. This function runs on the server, holds the secret as an
     environment variable, and is the only place it's used.

   SETUP (Vercel project → Settings → Environment Variables)
     BOX_CLIENT_ID      = your Box app Client ID
     BOX_CLIENT_SECRET  = your Box app Client Secret
   (Do NOT hardcode the secret here.)

   The browser (box-adapter.js → exchangeCode) POSTs:
     { code, code_verifier, redirect_uri }
   and gets back Box's token JSON { access_token, expires_in, ... }.
   ============================================================ */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  try {
    const { code, code_verifier, redirect_uri, grant_type, refresh_token } = req.body || {};

    // --- Refresh grant: swap a refresh token for a fresh access token ---
    if (grant_type === 'refresh_token') {
      if (!refresh_token) { res.status(400).json({ error: 'missing refresh_token' }); return; }
      const rbody = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token,
        client_id: process.env.BOX_CLIENT_ID,
        client_secret: process.env.BOX_CLIENT_SECRET,
      });
      const rRes = await fetch('https://api.box.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: rbody,
      });
      const rData = await rRes.json();
      if (!rRes.ok) { res.status(rRes.status).json(rData); return; }
      res.status(200).json({
        access_token: rData.access_token,
        expires_in: rData.expires_in,
        refresh_token: rData.refresh_token,
      });
      return;
    }

    // --- Authorization-code grant (initial sign-in) ---
    if (!code) { res.status(400).json({ error: 'missing code' }); return; }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.BOX_CLIENT_ID,
      client_secret: process.env.BOX_CLIENT_SECRET,
      redirect_uri: redirect_uri,
    });
    // PKCE verifier is included when present (defense in depth).
    if (code_verifier) body.set('code_verifier', code_verifier);

    const boxRes = await fetch('https://api.box.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await boxRes.json();
    if (!boxRes.ok) { res.status(boxRes.status).json(data); return; }

    // Return only what the client needs.
    res.status(200).json({
      access_token: data.access_token,
      expires_in: data.expires_in,
      refresh_token: data.refresh_token,
    });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
