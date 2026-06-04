/* ============================================================
   SAVILLS PPM · FEE SYSTEM · BOX BACKEND ADAPTER
   ------------------------------------------------------------
   Turns the (otherwise localStorage) app into a shared, multi-user
   system backed by a single projects.json in a Box folder — without
   touching the rest of the app.

   HOW IT PLUGS IN
     • localStorage stays the synchronous working store (every existing
       sync call — listProjects(), saveProject(), etc. — is unchanged).
     • This adapter is a SYNC LAYER on top:
         boot()  → pulls projects.json from Box into localStorage.
         push()  → after every local write, debounce-mirrors local → Box,
                   using the file's etag for optimistic concurrency so two
                   people saving at once can't silently clobber.
     • Identity: Box /users/me → login email → drives Store.getCurrentUser()
       so the access wall runs off the real SSO login.

   SECURITY
     • OAuth 2.0 with PKCE — NO client secret in the browser. Box must
       have the app configured for Authorization Code Grant with PKCE.
     • Each person logs into their own Box account; Box folder permissions
       are the outer authorization gate, the in-app wall is the view filter.

   SETUP (Box Developer Console → My Apps → Create New App)
     1. "Custom App" → "User Authentication (OAuth 2.0)".
     2. Configuration:
          - OAuth 2.0 Redirect URI = your hosted app URL (e.g.
            https://ppm-fee-generator.vercel.app/oauth-callback.html)
          - Enable "Authorization Code Grant with PKCE"
          - Application Scopes: "Read and write all files and folders"
        Copy the Client ID into BOX_CONFIG below (no secret needed).
     3. Put an empty projects.json ({"schemaVersion":1,"projects":{}}) in a
        Box folder; copy that FILE id and the FOLDER id into BOX_CONFIG.
     4. Host the app (Vercel/etc.) so its origin matches the redirect URI.

   This file is inert until BOX_CONFIG.enabled = true.
   ============================================================ */

(function () {
  'use strict';

  const BOX_CONFIG = {
    enabled: true,                        // Box layer ON
    testMode: true,                       // dev-token paste flow (no OAuth yet); set false for production
    clientId: 'jujkzyorzo9ttx8vnisaezi43wm3rofc',
    clientSecret: '',                     // NEVER in the browser for prod — use the serverless exchange. Empty here on purpose.
    redirectUri: window.location.origin + '/oauth-callback.html',
    tokenExchangeUrl: '/api/box-token',   // your Vercel serverless function (holds the secret)
    dataFileId: '2265137344562',          // projects.json in Box
    folderId: 'PASTE_FOLDER_ID',          // used only to (re)create the file if missing
    pushDebounceMs: 1500,

    /* TEST MODE — paste a Box Developer Token here to validate read/write of
       projects.json WITHOUT OAuth. Lasts ~60 min. Leave '' for production. */
    devToken: '',
  };

  const Store = window.UFC_Store;
  if (!Store) { console.error('box-adapter: store.js must load first'); return; }

  // Public surface even when disabled, so pages can call boot() unconditionally.
  const Box = {
    enabled: BOX_CONFIG.enabled,
    config: BOX_CONFIG,
    boot,            // async: ensure auth + pull remote → local + set identity
    login,           // start the OAuth redirect
    logout,
    isAuthed: () => !!getToken(),
    pushNow,         // force an immediate flush
  };
  window.UFC_Box = Box;

  if (!BOX_CONFIG.enabled) return;        // inert until configured

  // ---- Token storage (access token in sessionStorage; short-lived) ----
  const TOK_KEY = 'ufc_box_token_v1';
  const PKCE_KEY = 'ufc_box_pkce_v1';
  const TEST_TOK_KEY = 'ufc_box_devtoken';
  function getToken() {
    if (BOX_CONFIG.devToken) return BOX_CONFIG.devToken;          // (left empty in repo on purpose)
    if (BOX_CONFIG.testMode) { return sessionStorage.getItem(TEST_TOK_KEY) || null; }  // runtime paste — never committed
    try { const t = JSON.parse(sessionStorage.getItem(TOK_KEY)); if (t && t.access_token && t.exp > Date.now()) return t.access_token; } catch (e) {}
    return null;
  }
  function setTestToken(tok) { sessionStorage.setItem(TEST_TOK_KEY, (tok || '').trim()); }
  Box.setTestToken = setTestToken;
  function setToken(tok) {
    // Box access tokens last ~60min; refresh requires a token endpoint exchange.
    sessionStorage.setItem(TOK_KEY, JSON.stringify({ access_token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000, refresh_token: tok.refresh_token }));
  }
  function clearToken() { sessionStorage.removeItem(TOK_KEY); }

  // ---- PKCE helpers ----
  function b64url(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  async function sha256(str) { return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)); }
  function randomStr(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a.buffer); }

  async function login() {
    const verifier = randomStr(48);
    sessionStorage.setItem(PKCE_KEY, verifier);
    const challenge = b64url(await sha256(verifier));
    const url = new URL('https://account.box.com/api/oauth2/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', BOX_CONFIG.clientId);
    url.searchParams.set('redirect_uri', BOX_CONFIG.redirectUri);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', randomStr(12));
    window.location.assign(url.toString());
  }
  function logout() { clearToken(); Store.setCurrentUser(null); }

  /* Exchange the ?code from the redirect for a token. Call this from
     oauth-callback.html. PKCE means no client secret is exposed; the
     token exchange still needs to happen somewhere that can POST the
     verifier. Box's token endpoint accepts PKCE without a secret for
     public clients. */
  async function exchangeCode(code) {
    const verifier = sessionStorage.getItem(PKCE_KEY);
    // Your Box app has a Client Secret, so the exchange runs server-side
    // (a Vercel serverless function holds the secret). The browser POSTs the
    // code + PKCE verifier to that endpoint, which returns the token.
    const res = await fetch(BOX_CONFIG.tokenExchangeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: BOX_CONFIG.redirectUri }),
    });
    if (!res.ok) throw new Error('Box token exchange failed: ' + res.status);
    const tok = await res.json();
    setToken(tok);
    sessionStorage.removeItem(PKCE_KEY);
    return tok;
  }
  Box.exchangeCode = exchangeCode;

  // ---- Box REST helpers ----
  async function boxFetch(path, opts = {}) {
    const token = getToken();
    if (!token) throw new Error('not authenticated');
    const res = await fetch('https://api.box.com/2.0' + path, {
      ...opts,
      headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
    });
    return res;
  }

  async function getIdentity() {
    const res = await boxFetch('/users/me?fields=login,name');
    if (!res.ok) throw new Error('identity fetch failed');
    return res.json();   // { login: 'esobel@savills.us', name: 'Emily Sobel' }
  }

  // Download projects.json + capture its etag for concurrency.
  let _etag = null;
  async function pullRemote() {
    const meta = await boxFetch('/files/' + BOX_CONFIG.dataFileId + '?fields=etag');
    if (meta.ok) { const m = await meta.json(); _etag = m.etag; }
    const res = await boxFetch('/files/' + BOX_CONFIG.dataFileId + '/content');
    if (res.status === 404) return Store.defaultDb();
    if (!res.ok) throw new Error('pull failed: ' + res.status);
    try { return JSON.parse(await res.text()); } catch (e) { return Store.defaultDb(); }
  }

  // Upload a new version of projects.json, guarded by If-Match (etag).
  async function uploadRemote(db) {
    const form = new FormData();
    const attrs = { name: 'projects.json' };
    form.append('attributes', JSON.stringify(attrs));
    form.append('file', new Blob([JSON.stringify(db)], { type: 'application/json' }), 'projects.json');
    const res = await fetch('https://upload.box.com/api/2.0/files/' + BOX_CONFIG.dataFileId + '/content', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + getToken(), ...(_etag ? { 'If-Match': _etag } : {}) },
      body: form,
    });
    if (res.status === 412) {
      // Etag mismatch: someone else saved first. Pull, merge, retry once.
      const remote = await pullRemote();
      const merged = mergeDb(remote, db);
      Store.hydrateFromRemote(merged);
      return uploadRemote(merged);
    }
    if (!res.ok) throw new Error('upload failed: ' + res.status);
    const out = await res.json();
    if (out.entries && out.entries[0]) _etag = out.entries[0].etag;
    return out;
  }

  /* Merge strategy: newest-updatedAt wins per project. Good enough for a
     small team; prevents the classic last-write-wins data loss. */
  function mergeDb(remote, local) {
    const out = Store.defaultDb();
    const all = { ...(remote.projects || {}) };
    Object.entries(local.projects || {}).forEach(([id, lp]) => {
      const rp = all[id];
      if (!rp || (lp.updatedAt || '') >= (rp.updatedAt || '')) all[id] = lp;
    });
    out.projects = all;
    return out;
  }

  // ---- Debounced push (attached to store via attachRemote) ----
  let _pushTimer = null, _pending = null;
  function schedulePush(db) {
    _pending = db;
    clearTimeout(_pushTimer);
    _pushTimer = setTimeout(pushNow, BOX_CONFIG.pushDebounceMs);
  }
  async function pushNow() {
    if (!_pending || !getToken()) return;
    const db = _pending; _pending = null;
    try { await uploadRemote(db); } catch (e) { console.error('Box push failed', e); _pending = db; }
  }

  // ---- Boot: auth → pull → identity → attach push ----
  async function boot() {
    if (!BOX_CONFIG.enabled) return { ok: true, backend: 'local' };
    if (!getToken()) {
      return BOX_CONFIG.testMode ? { ok: false, needsDevToken: true } : { ok: false, needsLogin: true };
    }
    // Identity → drives the access wall
    try {
      const me = await getIdentity();
      const leader = Store.resolveLeader(me.login) || Store.resolveLeader(me.name);
      // Anyone in the leaders directory is a 'member' (sees own); everyone else
      // is treated as admin/ops by default — flip this rule to your policy.
      Store.setCurrentUser(leader
        ? { name: leader.displayName, username: me.login, role: 'member' }
        : { name: me.name, username: me.login, role: 'admin' });
    } catch (e) { console.warn('identity failed', e); }
    // Pull remote → local
    try {
      const remote = await pullRemote();
      const local = JSON.parse(localStorage.getItem('savills-ppm-fee-db:v1') || 'null');
      const merged = local ? mergeDb(remote, local) : remote;
      Store.hydrateFromRemote(merged);
    } catch (e) { console.error('Box pull failed — running on local cache', e); }
    // Attach the push hook so future writes mirror to Box
    Store.attachRemote(schedulePush);
    return { ok: true, backend: 'box' };
  }

})();
