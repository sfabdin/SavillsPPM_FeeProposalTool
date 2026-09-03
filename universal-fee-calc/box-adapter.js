/* ============================================================
   SAVILLS PPM · FEE & REVENUE SYSTEM · BOX BACKEND ADAPTER
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
    testMode: false,                      // PRODUCTION OAuth (PKCE + serverless token exchange). Set true only to dev with a pasted token.
    clientId: 'jujkzyorzo9ttx8vnisaezi43wm3rofc',
    clientSecret: '',                     // NEVER in the browser for prod — use the serverless exchange. Empty here on purpose.
    redirectUri: window.location.origin + '/oauth-callback.html',
    tokenExchangeUrl: '/api/box-token',   // your Vercel serverless function (holds the secret)
    dataFileId: '2265137344562',          // projects.json in Box
    ratesFileId: '2269177726984',         // rates.json in Box (the confidential rate grid)
    studioFileId: '2302220793247',        // studio.json in Box (retired Revenue Studio baselines + scenarios; still synced)
    actualsFileId: '',                    // clockify-actuals.csv in Box — hours by user×project×month. '' = not configured (page falls back to manual drop / API proxy)
    staffFileId: '2364190093321',         // staff.json in Box — the LIVING staffing matrix (allocations + notes + actuals + mappings), shared by all admins
    revenueFileId: '',                    // revenue.json in Box — Revenue Reconciliation's actuals ledger. '' = SELF-CONFIGURING: found by name in the shared folder, created on first run.
    folderId: '387228486391',             // used only to (re)create the file if missing
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
    getAccessToken: () => ensureToken(),   // for authed calls to our own /api/* endpoints
    pushNow,         // force an immediate flush
    pullRates,       // fetch the confidential rate grid (post-login only)
    pullActuals,     // fetch the Clockify actuals CSV (clockify-actuals.csv in Box)
    pullRevenue,     // fetch revenue.json (the reconciliation ledger)
    pullStaff,       // fetch staff.json (staffing matrix + notes + actuals)
    pullStaffIfChanged, // etag-checked pull — null when nothing new
    uploadStaff,     // push staff.json (debounced by the staffing page)
  };
  window.UFC_Box = Box;

  // ---- Sync status broadcast (drives the on-page sync indicator) ----
  // states: 'pending' | 'syncing' | 'synced' | 'error' | 'signedout' | 'local'
  Box.syncState = { state: 'local', message: '', at: 0 };
  function emitSync(state, message) {
    Box.syncState = { state, message: message || '', at: Date.now() };
    try { document.dispatchEvent(new CustomEvent('ufc:sync', { detail: Box.syncState })); } catch (e) {}
  }
  Box.emitSync = emitSync;

  if (!BOX_CONFIG.enabled) return;        // inert until configured

  // ---- Token storage ----
  // Production token bundle {access_token, exp, refresh_token} lives in
  // localStorage so a login survives tab-close / refresh / next morning;
  // the access token is refreshed silently via the serverless endpoint when
  // it expires (~60 min), using the long-lived (~60 day) refresh token.
  const TOK_KEY = 'ufc_box_token_v1';
  const PKCE_KEY = 'ufc_box_pkce_v1';
  const STATE_KEY = 'ufc_box_state_v1';   // the login's anti-CSRF nonce, checked on the way back
  const TEST_TOK_KEY = 'ufc_box_devtoken';

  function readTok() { try { return JSON.parse(localStorage.getItem(TOK_KEY)); } catch (e) { return null; } }

  // Synchronous best-guess token (NO refresh) — used by the boot gate check.
  function getToken() {
    if (BOX_CONFIG.devToken) return BOX_CONFIG.devToken;          // (left empty in repo on purpose)
    if (BOX_CONFIG.testMode) { return sessionStorage.getItem(TEST_TOK_KEY) || null; }  // runtime paste — never committed
    const t = readTok();
    if (t && t.access_token && t.exp > Date.now()) return t.access_token;
    if (t && t.refresh_token) return '__needs_refresh__';        // truthy → not a login wall; ensureToken() will refresh
    return null;
  }

  // Async: ALWAYS returns a usable access token (refreshing if expired) or null.
  // Cross-tab-safe: Box rotates the refresh token on every use, so two tabs that
  // both try to refresh with the same token would knock each other out (the loser
  // gets invalid_grant → forced re-login). We coordinate via a short localStorage
  // lock so only one tab spends the token; the others wait and pick up the freshly
  // written bundle. The real safety net is the retry below: if we lose the race,
  // we re-read whatever a peer just rotated in and try once more before giving up.
  const REFRESH_LOCK = 'ufc_box_refreshing_v1';
  let _refreshing = null;
  async function ensureToken() {
    if (BOX_CONFIG.devToken) return BOX_CONFIG.devToken;
    if (BOX_CONFIG.testMode) return sessionStorage.getItem(TEST_TOK_KEY) || null;
    const t = readTok();
    if (t && t.access_token && t.exp > Date.now()) return t.access_token;
    if (t && t.refresh_token) {
      if (!_refreshing) _refreshing = refreshFlow().finally(() => { _refreshing = null; });
      try { const nt = await _refreshing; return nt ? nt.access_token : null; }
      catch (e) { return null; }
    }
    return null;
  }

  // Wait (up to ~8s) for a peer tab that's mid-refresh to write a fresh bundle.
  async function waitForPeerRefresh() {
    const lock = localStorage.getItem(REFRESH_LOCK);
    if (!lock) return null;
    if (Date.now() - Number(lock) > 10000) { localStorage.removeItem(REFRESH_LOCK); return null; } // stale (tab closed mid-refresh)
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 200));
      const t = readTok();
      if (t && t.access_token && t.exp > Date.now()) return t;   // peer wrote a fresh token
      if (!localStorage.getItem(REFRESH_LOCK)) break;            // peer finished (maybe failed) — fall through
    }
    return null;
  }

  async function refreshFlow() {
    const peer = await waitForPeerRefresh();
    if (peer) return peer;

    const mine = String(Date.now());
    localStorage.setItem(REFRESH_LOCK, mine);
    try {
      const tok = readTok();
      if (tok && tok.access_token && tok.exp > Date.now()) return tok;   // a peer beat us to it
      try {
        return await doRefresh(tok.refresh_token);
      } catch (e) {
        // Lost the rotation race? Re-read — a peer may have just rotated a new token in.
        const fresh = readTok();
        if (fresh && fresh.access_token && fresh.exp > Date.now()) return fresh;
        if (fresh && fresh.refresh_token && fresh.refresh_token !== tok.refresh_token) {
          try { return await doRefresh(fresh.refresh_token); } catch (e2) {}
        }
        clearToken();   // genuinely dead — only now force a re-login
        return null;
      }
    } finally {
      if (localStorage.getItem(REFRESH_LOCK) === mine) localStorage.removeItem(REFRESH_LOCK);
    }
  }

  async function doRefresh(refresh_token) {
    const res = await fetch(BOX_CONFIG.tokenExchangeUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token }),
    });
    if (!res.ok) throw new Error('token refresh failed: ' + res.status);
    const tok = await res.json();
    setToken(tok);
    return tok;
  }

  function setTestToken(tok) { sessionStorage.setItem(TEST_TOK_KEY, (tok || '').trim()); }
  Box.setTestToken = setTestToken;
  function setToken(tok) {
    const prev = readTok() || {};
    localStorage.setItem(TOK_KEY, JSON.stringify({
      access_token: tok.access_token,
      exp: Date.now() + ((tok.expires_in || 3600) - 60) * 1000,
      refresh_token: tok.refresh_token || prev.refresh_token,   // Box rotates these; keep prior if absent
    }));
  }
  function clearToken() { localStorage.removeItem(TOK_KEY); }

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
    /* `state` was generated here and never looked at again, so the callback
       would exchange any code it was handed — a login-CSRF that can bind this
       browser to someone else's Box account. Kept in sessionStorage (this tab,
       this login) and compared on return; PKCE covers code injection, not this. */
    const state = randomStr(24);
    sessionStorage.setItem(STATE_KEY, state);
    url.searchParams.set('state', state);
    window.location.assign(url.toString());
  }
  async function logout() {
    // Flush any unsynced changes BEFORE tearing down the session, so signing
    // out can never strand a save in this browser.
    try { if (_pending) { clearTimeout(_pushTimer); await pushNow(); } } catch (e) {}
    clearToken();
    try { Store.setRealIdentity(null); } catch (e) {}
    try { Store.clearImpersonation(); } catch (e) {}
    /* Clear EVERY local cache so nothing lingers on a shared machine. This
       used to drop only the project book, leaving the staffing matrix, the
       Revenue Studio store and the reconciliation ledger behind — and now the
       rate grid too, which is precisely why they are all listed here rather
       than one being singled out. */
    ['savills-ppm-fee-db:v1', 'savills-ppm-staff-db:v1', 'savills-ppm-studio-db:v1',
     'savills-ppm-revenue-db:v1', 'savills-ppm-history-db:v1', RATES_CACHE_KEY, 'ufc_box_etags_v1'
    ].forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
  }

  /* Exchange the ?code from the redirect for a token. Call this from
     oauth-callback.html. PKCE means no client secret is exposed; the
     token exchange still needs to happen somewhere that can POST the
     verifier. Box's token endpoint accepts PKCE without a secret for
     public clients. */
  async function exchangeCode(code, state) {
    const expected = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(STATE_KEY);                     // one login, one use
    if (!expected || !state || state !== expected) {
      throw new Error('Sign-in did not start from this tab. Open the app and sign in again.');
    }
    const verifier = sessionStorage.getItem(PKCE_KEY);
    if (!verifier) throw new Error('Sign-in did not start from this tab. Open the app and sign in again.');
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
  /* ============================================================
     BOOT INSTRUMENTATION
     ------------------------------------------------------------
     Every page load blocks on boot(), so "the tool feels slow" is
     really "boot() takes N seconds". This records where that time
     actually goes — per Box request and per boot phase — so the
     answer comes from measurement rather than assumption.

     Read it three ways:
       · window.UFC_Perf.report()  — console table, on demand
       · add ?perf=1 to the URL    — console table + on-screen overlay
       · localStorage ufc_perf=1   — console table on every boot
     Costs nothing when nobody is looking: it is a few timestamps
     and a running byte count.
     ============================================================ */
  const Perf = (() => {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    const reqs = [];    // { label, ms, bytes, status, at }
    const phases = [];  // { label, ms, at }
    let bootMs = 0;
    /* Requests are labelled by SHAPE, not by full URL — '/files/123/content'
       and '/files/456/content' are the same kind of cost, and the ids are
       noise in a summary. */
    function label(path) {
      return String(path || '')
        .replace(/\/files\/\d+\/content/, '/files/:id/content')
        .replace(/\/files\/\d+/, '/files/:id')
        .replace(/\/folders\/\d+/, '/folders/:id')
        .split('?')[0];
    }
    return {
      enabled: true,
      req(path, ms, bytes, status) {
        const rec = { label: label(path), ms: Math.round(ms), bytes: bytes || 0, status, at: Math.round(now()) };
        reqs.push(rec);
        return rec;
      },
      phase(l) { phases.push({ label: l, at: Math.round(now()) }); },
      finish() {
        bootMs = Math.round(now());
        /* Quiet by default: the console table prints only when someone asks
           (?perf=1 or localStorage ufc_perf=1). Production consoles stay clean. */
        let wanted = false;
        try { wanted = /[?&]perf=1/.test(location.search) || localStorage.getItem('ufc_perf') === '1'; } catch (e) {}
        if (!wanted) return;
        try { this.report(); } catch (e) {}
        try { if (/[?&]perf=1/.test(location.search)) this.overlay(); } catch (e) {}
      },
      totals() {
        const netMs = reqs.reduce((a, r) => a + r.ms, 0);
        const bytes = reqs.reduce((a, r) => a + r.bytes, 0);
        /* Requests run in PARALLEL now, so summing them says nothing about how
           long boot actually waited — the old build subtracted that sum, which
           on a parallel boot went negative, clamped to zero, and reported
           "parse/merge/hydrate 0 ms" no matter what the data layer was doing.
           (With nothing recorded yet it did the opposite and blamed the whole
           boot on parsing.)

           What we want is the wall-clock stretch with at least one request in
           flight: merge the [start, end] intervals and total the union. Time
           outside that union is boot doing its own work — parsing, merging,
           hydrating — and is the number worth chasing. */
        const spans = reqs.map(r => [r.at - r.ms, r.at]).sort((a, b) => a[0] - b[0]);
        let busy = 0, from = null, to = null;
        for (const [s, e] of spans) {
          if (from === null) { from = s; to = e; }
          else if (s <= to) { to = Math.max(to, e); }        // overlaps — extend
          else { busy += to - from; from = s; to = e; }      // gap — bank it
        }
        if (from !== null) busy += to - from;
        return { bootMs, requests: reqs.length, networkMs: Math.round(netMs),
                 waitingMs: Math.round(busy), bytes,
                 appMs: Math.max(0, bootMs - Math.round(busy)) };
      },
      data() { return { reqs: reqs.slice(), phases: phases.slice(), totals: this.totals() }; },
      report() {
        const t = this.totals();
        const kb = (n) => (n / 1024).toFixed(0) + ' KB';
        console.log('%c⏱ Boot: ' + t.bootMs + ' ms  ·  ' + t.waitingMs + ' ms waiting on Box  ·  '
          + t.appMs + ' ms app work  ·  ' + t.requests + ' request'
          + (t.requests === 1 ? '' : 's') + '  ·  ' + kb(t.bytes),
          'font-weight:700;color:#0E7C7B');
        if (console.table) console.table(reqs.map(r => ({ request: r.label, ms: r.ms, KB: +(r.bytes / 1024).toFixed(1), status: r.status, 'at ms': r.at })));
        if (console.table) console.table(phases);
        console.log('"Waiting on Box" is wall-clock time with at least one request open, '
          + 'not the sum of ' + t.networkMs + ' ms across ' + t.requests + ' parallel requests.');
        console.log('NOTE: boot returns as soon as the page can render — the background refresh '
          + 'keeps going, so anything that finishes later is not in the table above. '
          + 'Call UFC_Perf.report() again in a second to see it.');
      },
      overlay() {
        const t = this.totals();
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647;background:#25273A;color:#fff;font:12px/1.5 ui-monospace,Menlo,monospace;padding:12px 14px;max-width:420px;box-shadow:0 4px 18px rgba(0,0,0,.3)';
        el.innerHTML = '<div style="font-weight:700;color:#FFDF00;margin-bottom:6px">Boot ' + t.bootMs + ' ms</div>'
          + '<div>' + t.waitingMs + ' ms waiting on Box · ' + t.appMs + ' ms app work</div>'
          + '<div style="opacity:.7">' + t.requests + ' request' + (t.requests === 1 ? '' : 's')
          + ' · ' + (t.bytes / 1024).toFixed(0) + ' KB</div>'
          + '<div style="opacity:.55;margin-top:4px">background refresh may still be running</div>'
          + '<div style="margin-top:6px;border-top:1px solid rgba(255,255,255,.2);padding-top:6px">'
          + reqs.map(r => r.label + '  <b>' + r.ms + 'ms</b>' + (r.bytes ? '  ' + (r.bytes / 1024).toFixed(0) + 'KB' : '')).join('<br>')
          + '</div>';
        (document.body || document.documentElement).appendChild(el);
      },
    };
  })();
  window.UFC_Perf = Perf;

  async function boxFetch(path, opts = {}) {
    const token = await ensureToken();
    if (!token) throw new Error('not authenticated');
    const t = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const res = await fetch('https://api.box.com/2.0' + path, {
      ...opts,
      headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
    });
    /* Measure the BODY too, not just the headers. A 304 or a small metadata
       call and a multi-megabyte download look identical until the body is
       drained, and the download is usually the story. Cloning keeps the
       response usable by the caller. */
    /* Record the moment the RESPONSE lands, not when its body finishes being
       read. Waiting for arrayBuffer() meant a request that completed during
       boot was often logged AFTER the summary printed — which is why the
       overlay could claim "0 requests" on a boot that plainly made one. The
       byte count is patched into the same record if it arrives later. */
    try {
      const ms = (performance.now ? performance.now() : Date.now()) - t;
      const len = Number(res.headers.get('content-length')) || 0;
      const rec = Perf.req(path, ms, len, res.status);
      if (!len && rec) {
        res.clone().arrayBuffer().then(bufr => { rec.bytes = bufr.byteLength; }).catch(() => {});
      }
    } catch (e) {}
    return res;
  }

  async function getIdentity() {
    const res = await boxFetch('/users/me?fields=login,name');
    if (!res.ok) throw new Error('identity fetch failed');
    return res.json();   // { login: 'esobel@savills.us', name: 'Emily Sobel' }
  }

  // Download projects.json + capture its etag for concurrency.
  let _etag = null;
  let _remoteCount = 0;   // project count last seen in Box — drives the shrink guard
  async function pullRemote() {
    /* One round trip, not two. This used to ask for the etag and THEN download,
       which made sense when the file was assumed to be large — but production
       measurement says projects.json is ~73KB and a Box request costs 200-900ms
       regardless of size. At that ratio an extra round trip to maybe avoid a
       73KB transfer is a straight loss. The etag comes off the content
       response instead; if Box omits it, _etag stays null and the periodic
       refresh simply pulls, which is the old safe behaviour. */
    const res = await boxFetch('/files/' + BOX_CONFIG.dataFileId + '/content');
    try { const tag = res.headers.get('etag'); if (tag) _etag = tag.replace(/^W\//, '').replace(/"/g, ''); } catch (e) {}
    if (res.status === 404) return Store.defaultDb();
    if (!res.ok) throw new Error('pull failed: ' + res.status);
    let db;
    try { db = JSON.parse(await res.text()); } catch (e) { db = Store.defaultDb(); }
    _remoteCount = Object.keys((db && db.projects) || {}).length;
    return db;
  }

  // Download the confidential rate grid (rates.json) from Box.
  // Never cached to localStorage — it must not linger on a signed-out machine.
  /* ---------- local rate-grid cache ----------
     The rate card is not in the shipped code and is fetched from Box on every
     load, which put an ~800ms round trip on the critical path of every single
     page. Caching it locally is what lets a page render from cache instead of
     waiting for Box.

     On exposure: FETCHING it is still gated by Box auth — no token, no
     download. What changes is that a copy rests on disk in the browser
     profile. That is the same posture the project book already has (every
     negotiated fee and effective rate is cached in localStorage today), and
     logout() wipes it along with everything else, so nothing outlives the
     session on a shared machine. */
  const RATES_CACHE_KEY = 'savills-ppm-rates-cache:v1';
  function readRatesCache() {
    try { const j = JSON.parse(localStorage.getItem(RATES_CACHE_KEY)); return (j && j.grid) ? j : null; }
    catch (e) { return null; }
  }
  function writeRatesCache(payload) {
    try { if (payload && payload.grid) localStorage.setItem(RATES_CACHE_KEY, JSON.stringify(payload)); } catch (e) {}
  }

  async function pullRates() {
    const id = BOX_CONFIG.ratesFileId;
    if (!id || /PASTE/.test(id)) throw new Error('rates file id not configured');
    const res = await boxFetch('/files/' + id + '/content');
    if (!res.ok) throw new Error('rates pull failed: ' + res.status);
    const payload = JSON.parse(await res.text());
    writeRatesCache(payload);
    return payload;
  }

  // Upload a new version of projects.json, guarded by If-Match (etag).
  // SHRINK GUARD: refuse to overwrite Box with a copy that has lost most of the
  // projects Box knows about (a corrupted cache, a bad import, a cleared browser).
  // Deletes are tombstones, so a legitimate delete never shrinks the key count —
  // a big shrink always means something is wrong. Box.forcePush() overrides.
  let _forcePush = false;
  Box.forcePush = async function () { _forcePush = true; try { await syncNow(); } finally { _forcePush = false; } };
  async function uploadRemote(db, depth) {
    depth = depth || 0;
    if (depth > 3) throw new Error('sync conflict — too many concurrent saves, will retry');
    const localCount = Object.keys((db && db.projects) || {}).length;
    if (!_forcePush && _remoteCount >= 10 && localCount < _remoteCount * 0.5) {
      throw new Error('Sync blocked to protect data: this browser has ' + localCount + ' projects but Box has ' + _remoteCount + '. Reload the page to re-sync first.');
    }
    const token = await ensureToken();
    if (!token) throw new Error('not authenticated');
    const form = new FormData();
    const attrs = { name: 'projects.json' };
    form.append('attributes', JSON.stringify(attrs));
    form.append('file', new Blob([JSON.stringify(db)], { type: 'application/json' }), 'projects.json');
    const res = await fetch('https://upload.box.com/api/2.0/files/' + BOX_CONFIG.dataFileId + '/content', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, ...(_etag ? { 'If-Match': _etag } : {}) },
      body: form,
    });
    if (res.status === 412) {
      // Etag mismatch: someone else saved first. Pull, merge, retry once.
      const remote = await pullRemote();
      const merged = mergeDb(remote, db);
      Store.hydrateFromRemote(merged);
      return uploadRemote(merged, depth + 1);
    }
    if (!res.ok) throw new Error('upload failed: ' + res.status);
    const out = await res.json();
    if (out.entries && out.entries[0]) _etag = out.entries[0].etag;
    return out;
  }

  /** Cheap change check: compares the remote etag to the one we last saw;
      returns the fresh projects db only when a TEAMMATE saved since, else null. */
  async function pullRemoteIfChanged() {
    const meta = await boxFetch('/files/' + BOX_CONFIG.dataFileId + '?fields=etag');
    if (!meta.ok) return null;
    const m = await meta.json();
    if (_etag && m.etag === _etag) return null;                  // unchanged since our last pull/push
    return pullRemote();
  }
  /** Pull-if-changed + merge + hydrate, in one call. Existing per-project saves
      already refuse to overwrite a record someone else updated more recently
      (the STALE_WRITE guard in saveProject) — but that guard only protects a
      save if this tab's local cache is fresh enough to see the conflict. Without
      this periodic refresh, a long-lived tab's cache can go stale for as long as
      it's open, so its own save looks "clean" locally and the conflict only
      surfaces later at the Box 412 layer, where mergeDb's whole-record
      newest-wins can discard a teammate's edit to a DIFFERENT field of the same
      project. Keeping the local cache fresh lets the STALE_WRITE guard do its
      job — warn the human — instead of that silent loss. */
  Box.refreshProjectsIfChanged = async function () {
    const remote = await pullRemoteIfChanged();
    if (!remote) return false;
    const local = JSON.parse(localStorage.getItem('savills-ppm-fee-db:v1') || 'null') || Store.defaultDb();
    const merged = mergeDb(remote, local);
    Store.hydrateFromRemote(merged);
    return true;
  };

  /* Merge strategy: newest-updatedAt wins per project (tombstones included, so
     deletions propagate). Activity log is union-merged by entry id. */
  function mergeDb(remote, local) {
    const out = Store.defaultDb();
    const all = { ...(remote.projects || {}) };
    Object.entries(local.projects || {}).forEach(([id, lp]) => {
      const rp = all[id];
      if (!rp || (lp.updatedAt || '') >= (rp.updatedAt || '')) all[id] = lp;
    });
    out.projects = all;
    /* The audit trail is its own set of files now and is never written here.
       A teammate on an older build may still be appending to this array, and
       their work is history too — so union both sides, move it into the shards
       where the trail actually lives, and write back an EMPTY array. That last
       part is the point: projects.json only sheds the weight if the array is
       actually cleared, and the entries are safe because the ingest is a union
       by id that has already run. */
    const seen = {};
    [...(remote.activity || []), ...(local.activity || [])].forEach(e => {
      if (e && e.id) seen[e.id] = e;
    });
    const carried = Object.values(seen).sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    out.activity = Store.drainLegacyActivity ? Store.drainLegacyActivity(carried) : [];

    /* Everything else on the db is dropped unless it is merged here — this is
       what silently ate the maintenance flag on every sync. */
    // Maintenance: last writer wins, comparing when each side was set.
    const mStamp = (m) => (m && (m.at || m.endedAt)) || '';
    const rm = remote.maintenance, lm = local.maintenance;
    const win = mStamp(lm) >= mStamp(rm) ? lm : rm;
    if (win) out.maintenance = win;
    // Vocabulary: additive on both sides, so union it — a list value added in
    // one browser must never be removed by a save from another.
    const rv = remote.vocab || {}, lv = local.vocab || {};
    if (rv.industries || lv.industries || rv.projectTypes || lv.projectTypes || rv.lossReasons || lv.lossReasons || rv.leaders || lv.leaders) {
      const uniq = (a, b) => [...new Set([...(a || []), ...(b || [])])];
      const byId = (a, b, key) => {
        const map = {};
        [...(a || []), ...(b || [])].forEach(x => { if (!x || !x[key]) return; map[x[key]] = map[x[key]] ? { ...map[x[key]], ...x, subs: [...new Set([...(map[x[key]].subs || []), ...(x.subs || [])])] } : x; });
        return Object.values(map);
      };
      out.vocab = {
        industries: uniq(rv.industries, lv.industries),
        lossReasons: uniq(rv.lossReasons, lv.lossReasons),
        projectTypes: byId(rv.projectTypes, lv.projectTypes, 'name'),
        leaders: byId(rv.leaders, lv.leaders, 'id'),
      };
    }
    /* Revenue ledger + flash snapshots: union by PERIOD, never whole-key.
       Both are built up over time, often from different machines — Finance
       posts 2026 on their laptop while someone else works a prior year. The catch-all below takes whichever side wrote last for
       the entire key, which would silently drop the other month. Merging per
       period keeps every close that either side has, and only compares
       timestamps when the SAME period exists on both. */
    const unionByPeriod = (key, stamp) => {   // period = a year for the ledger, a month for snapshots
      const rp = remote[key], lp = local[key];
      if (!rp && !lp) return;
      const merged = { ...(rp || {}) };
      Object.entries(lp || {}).forEach(([ym, lv]) => {
        const rv = merged[ym];
        if (!rv) { merged[ym] = lv; return; }
        merged[ym] = (stamp(lv) >= stamp(rv)) ? lv : rv;
      });
      out[key] = merged;
    };
    unionByPeriod('ledger', (v) => (v && v.updatedAt) || '');
    // Snapshots nest a second level (period → label), so union that too: two
    // people capturing #1 FLASH and #2 FINAL for the same month both keep theirs.
    (function () {
      const rs = remote.snapshots, ls = local.snapshots;
      if (!rs && !ls) return;
      const merged = { ...(rs || {}) };
      Object.entries(ls || {}).forEach(([ym, labels]) => {
        if (!merged[ym]) { merged[ym] = labels; return; }
        const both = { ...merged[ym] };
        Object.entries(labels || {}).forEach(([lbl, snap]) => {
          const cur = both[lbl];
          if (!cur || ((snap && snap.asOf) || '') >= ((cur && cur.asOf) || '')) both[lbl] = snap;
        });
        merged[ym] = both;
      });
      out.snapshots = merged;
    })();

    // Anything added to the db in future: keep it rather than dropping it.
    Object.keys({ ...remote, ...local }).forEach(k => {
      if (k in out || k === 'schemaVersion') return;
      out[k] = (k in local) ? local[k] : remote[k];
    });
    return out;
  }

  // ---- Debounced push (attached to store via attachRemote) ----
  let _pushTimer = null, _pending = null;
  function schedulePush(db) {
    _pending = db;
    emitSync('pending', 'Changes saved locally — syncing to Box…');
    clearTimeout(_pushTimer);
    _pushTimer = setTimeout(pushNow, BOX_CONFIG.pushDebounceMs);
  }
  async function pushNow() {
    if (!_pending) return;
    const tok = await ensureToken();
    if (!tok) { emitSync('signedout', 'Not signed in — changes are local only'); return; }
    const db = _pending; _pending = null;
    emitSync('syncing', 'Syncing to Box…');
    try {
      await uploadRemote(db);
      emitSync('synced', '');
    } catch (e) {
      _pending = db;                       // keep the pending data so a retry can flush it
      emitSync('error', e.message || 'Sync failed');
      console.warn('Box push failed', e);
    }
  }
  // Manual "Sync now": flush pending, or re-push the current local db if nothing is pending.
  async function syncNow() {
    let db = _pending;
    if (!db) { try { db = JSON.parse(localStorage.getItem('savills-ppm-fee-db:v1') || 'null'); } catch (e) {} }
    if (!db) { emitSync('synced', ''); return; }
    _pending = db;
    await pushNow();
  }

  /* Flush the debounced push the moment the tab is hidden or closing, instead of
     waiting out the debounce — closes the window where a fast close loses the
     last save. And warn the user if a sync is still pending on unload. */
  function flushPending() {
    if (_pending) { clearTimeout(_pushTimer); pushNow(); }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushPending();
    });
    window.addEventListener('pagehide', flushPending);
    window.addEventListener('beforeunload', (e) => {
      if (_pending) { flushPending(); e.preventDefault(); e.returnValue = ''; }
    });
  }
  Box.syncNow = syncNow;

  // ---- Clockify actuals CSV (SEPARATE small file, written by the scheduled
  // Clockify pull or dropped into the Box folder by hand). Read-only here. ----
  async function pullActuals() {
    const id = BOX_CONFIG.actualsFileId;
    if (!id || /PASTE/.test(id)) throw new Error('actuals file id not configured — set actualsFileId in box-adapter.js');
    const res = await boxFetch('/files/' + id + '/content');
    if (!res.ok) throw new Error('actuals pull failed: ' + res.status);
    return await res.text();
  }

  // ---- Staffing matrix file (staff.json) — the living strategy doc.
  // Same newest-wins whole-file pattern as studio.json.
  // SELF-CONFIGURING: if staffFileId is blank the file is found BY NAME in the
  // shared Box folder (created on first run), so every admin lands on the SAME
  // staff.json with zero setup — mappings + allocations sync across the team. ----
  let _staffEtag = null;
  let _staffId = null;
  async function resolveStaffFileId() {
    const cfg = BOX_CONFIG.staffFileId;
    if (cfg && !/PASTE/.test(cfg)) return cfg;
    if (_staffId) return _staffId;
    try { const c = localStorage.getItem('ufc_staff_file_id'); if (c) return (_staffId = c); } catch (e) {}
    // 1) look it up by name in the shared folder
    const res = await boxFetch('/folders/' + BOX_CONFIG.folderId + '/items?fields=name&limit=1000');
    if (res.ok) {
      const j = await res.json();
      const hit = (j.entries || []).find(e => e.type === 'file' && e.name === 'staff.json');
      if (hit) { _staffId = hit.id; try { localStorage.setItem('ufc_staff_file_id', hit.id); } catch (e) {} return hit.id; }
    }
    // 2) not there yet — first admin in creates it for everyone
    const token = await ensureToken(); if (!token) throw new Error('not authenticated');
    const form = new FormData();
    form.append('attributes', JSON.stringify({ name: 'staff.json', parent: { id: BOX_CONFIG.folderId } }));
    form.append('file', new Blob(['{}'], { type: 'application/json' }), 'staff.json');
    const up = await fetch('https://upload.box.com/api/2.0/files/content', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
    if (up.status === 409) {                                     // raced another admin — use theirs
      try { const j = await up.json(); const cid = j.context_info && j.context_info.conflicts && j.context_info.conflicts.id; if (cid) { _staffId = cid; try { localStorage.setItem('ufc_staff_file_id', cid); } catch (e) {} return cid; } } catch (e) {}
      throw new Error('staff.json create conflict — reload to retry');
    }
    if (!up.ok) throw new Error('could not create staff.json: HTTP ' + up.status);
    const j = await up.json(); const nid = j.entries && j.entries[0] && j.entries[0].id;
    if (!nid) throw new Error('staff.json create returned no id');
    _staffId = nid; try { localStorage.setItem('ufc_staff_file_id', nid); } catch (e) {}
    return nid;
  }
  async function pullStaff() {
    const id = await resolveStaffFileId();
    if (!id) return null;
    const res = await boxFetch('/files/' + id + '/content');
    if (res.status === 404) { _staffId = null; try { localStorage.removeItem('ufc_staff_file_id'); } catch (e) {} return null; }  // stale cached id — re-resolve next load
    if (!res.ok) throw new Error('staff pull failed: ' + res.status);
    /* One round trip, not two: the content response carries the file's ETag
       (the same value the metadata call returned). Fall back to the metadata
       call only if the header is missing, so the If-Match on the next upload
       is never sent blind. */
    let tag = null;
    try { tag = res.headers.get('etag'); } catch (e) {}
    if (tag) _staffEtag = tag.replace(/^W\//, '').replace(/"/g, '');
    else { const meta = await boxFetch('/files/' + id + '?fields=etag'); if (meta.ok) { const m = await meta.json(); _staffEtag = m.etag; } }
    const txt = await res.text();
    if (!txt || !txt.trim()) return null;                        // empty placeholder file
    try { return JSON.parse(txt); } catch (e) { return null; }   // not yet valid JSON → seed from local
  }
  /** Cheap change check: compares the remote etag to the one we last saw;
      returns the fresh db only when a TEAMMATE saved since, else null. */
  async function pullStaffIfChanged() {
    const id = await resolveStaffFileId(); if (!id) return null;
    const meta = await boxFetch('/files/' + id + '?fields=etag');
    if (!meta.ok) return null;
    const m = await meta.json();
    if (_staffEtag && m.etag === _staffEtag) return null;        // unchanged since our last pull/push
    return pullStaff();
  }
  async function uploadStaff(db, depth) {
    const id = await resolveStaffFileId();
    if (!id) return;
    /* No etag means this page has never seen Box's copy of staff.json, and a
       PUT without If-Match replaces whatever is there — every teammate edit
       since this browser last synced. Look first; merge if there is anything
       to merge. Data Repair reached this path from a cold page. */
    if (!_staffEtag) {
      const remote = await pullStaff();          // sets _staffEtag when the file exists
      const Staff = window.UFC_Staff;
      if (remote && remote.allocations && Staff && Staff.mergeFromRemote) db = Staff.mergeFromRemote(remote);
    }
    const token = await ensureToken(); if (!token) throw new Error('not authenticated');
    const form = new FormData();
    form.append('attributes', JSON.stringify({ name: 'staff.json' }));
    form.append('file', new Blob([JSON.stringify(db)], { type: 'application/json' }), 'staff.json');
    const res = await fetch('https://upload.box.com/api/2.0/files/' + id + '/content', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, ...(_staffEtag ? { 'If-Match': _staffEtag } : {}) },
      body: form,
    });
    if (res.status === 412) {
      /* Someone else saved first. Re-uploading our copy would erase their rows,
         so PULL → MERGE at record level → push the merged result. */
      if ((depth || 0) >= 2) throw new Error('staff push failed: repeated conflicts');
      const remote = await pullStaff();          // also refreshes _staffEtag
      const Staff = window.UFC_Staff;
      let merged = db;
      if (remote && Staff && Staff.mergeFromRemote) merged = Staff.mergeFromRemote(remote);
      else if (remote && Staff && Staff.hydrateFromRemote) { Staff.hydrateFromRemote(remote); merged = remote; }
      return uploadStaff(merged, (depth || 0) + 1);
    }
    if (!res.ok) throw new Error('staff push failed: ' + res.status);
    try { const j = await res.json(); if (j.entries && j.entries[0]) _staffEtag = j.entries[0].etag; } catch (e) {}
  }

  // ---- studio.json (retired Revenue Studio) — SEPARATE from projects.json ----
  let _studioEtag = null;
  async function pullStudio() {
    const id = BOX_CONFIG.studioFileId;
    if (!id || /PASTE/.test(id)) return Store.defaultStudio();   // not configured yet → local only
    /* No metadata pre-call. It existed only to capture the etag for the next
       upload's If-Match, and the content response carries the same etag in a
       header — so the extra round trip bought nothing and cost a full one.
       Every Box call is ~800ms in production regardless of payload size, so
       this halves the wait for the one page that reads this file. */
    const res = await boxFetch('/files/' + id + '/content');
    _studioEtag = res.headers.get('etag') || _studioEtag;
    if (res.status === 404) return Store.defaultStudio();
    if (!res.ok) throw new Error('studio pull failed: ' + res.status);
    return JSON.parse(await res.text());
  }
  /* Merge strategy: baselines carry no updatedAt (they're frozen targets, rarely
     edited concurrently) so a same-id collision keeps the local copy — it's the
     one this upload is actively trying to save. Scenarios DO carry updatedAt, so
     those merge newest-wins per id, same pattern as projects. Either way, every
     record from BOTH sides survives the merge — nothing is silently dropped. */
  function mergeStudioDb(remote, local) {
    const out = Store.defaultStudio();
    out.baselines = { ...(remote.baselines || {}), ...(local.baselines || {}) };
    const scen = { ...(remote.scenarios || {}) };
    Object.entries(local.scenarios || {}).forEach(([id, ls]) => {
      const rs = scen[id];
      if (!rs || (ls.updatedAt || '') >= (rs.updatedAt || '')) scen[id] = ls;
    });
    out.scenarios = scen;
    return out;
  }
  async function uploadStudio(s, depth) {
    const id = BOX_CONFIG.studioFileId;
    if (!id || /PASTE/.test(id)) return;                         // local-only until configured
    const token = await ensureToken(); if (!token) throw new Error('not authenticated');
    const form = new FormData();
    form.append('attributes', JSON.stringify({ name: 'studio.json' }));
    form.append('file', new Blob([JSON.stringify(s)], { type: 'application/json' }), 'studio.json');
    const res = await fetch('https://upload.box.com/api/2.0/files/' + id + '/content', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, ...(_studioEtag ? { 'If-Match': _studioEtag } : {}) },
      body: form,
    });
    if (res.status === 412) {
      // Someone else saved first. Re-uploading our copy as-is would erase their
      // baselines/scenarios, so PULL → MERGE at record level → retry, same as
      // staff.json — this used to just give up silently here, dropping the edit.
      if ((depth || 0) >= 2) throw new Error('studio push failed: repeated conflicts');
      const remote = await pullStudio();          // also refreshes _studioEtag
      const merged = mergeStudioDb(remote, s);
      Store.hydrateStudioFromRemote(merged);
      return uploadStudio(merged, (depth || 0) + 1);
    }
    if (!res.ok) throw new Error('studio upload failed: ' + res.status);
    const j = await res.json(); if (j.entries && j.entries[0]) _studioEtag = j.entries[0].etag;
  }
  let _studioTimer = null, _studioPending = null;
  function scheduleStudioPush(s) {
    _studioPending = s;
    clearTimeout(_studioTimer);
    _studioTimer = setTimeout(studioPushNow, BOX_CONFIG.pushDebounceMs);
  }
  async function studioPushNow() {
    if (!_studioPending) return;
    const tok = await ensureToken(); if (!tok) return;
    const s = _studioPending; _studioPending = null;
    try { await uploadStudio(s); } catch (e) { _studioPending = s; console.warn('studio push failed', e); }
  }
  Box.pullStudio = pullStudio;
  /** Cheap change check: compares the remote etag to the one we last saw;
      returns the fresh studio db only when a TEAMMATE saved since, else null. */
  async function pullStudioIfChanged() {
    const id = BOX_CONFIG.studioFileId;
    if (!id || /PASTE/.test(id)) return null;
    const meta = await boxFetch('/files/' + id + '?fields=etag');
    if (!meta.ok) return null;
    const m = await meta.json();
    if (_studioEtag && m.etag === _studioEtag) return null;      // unchanged since our last pull/push
    return pullStudio();
  }
  /** Pull-if-changed + record-level merge + hydrate, in one call — used by the
      live-refresh loop so a long-lived tab's local cache never goes stale
      enough for the next save to conflict with (or clobber) a teammate's. */
  Box.refreshStudioIfChanged = async function () {
    const remote = await pullStudioIfChanged();
    if (!remote) return false;
    const merged = mergeStudioDb(remote, Store.readStudio());
    Store.hydrateStudioFromRemote(merged);
    return true;
  };

  /* ---- Revenue Reconciliation file (revenue.json) — SEPARATE from projects.json.
     Actuals are a different kind of data on a different cadence: re-posting a
     close would otherwise churn the file every project record shares. Uses the
     staff.json SELF-CONFIGURING pattern — with no file id set, it is found by
     name in the shared folder (created on first run), so every admin lands on
     the same revenue.json with zero Box setup. ---- */
  let _revEtag = null;
  let _revId = null;
  async function resolveRevenueFileId() {
    const cfg = BOX_CONFIG.revenueFileId;
    if (cfg && !/PASTE/.test(cfg)) return cfg;
    if (_revId) return _revId;
    try { const c = localStorage.getItem('ufc_revenue_file_id'); if (c) return (_revId = c); } catch (e) {}
    const res = await boxFetch('/folders/' + BOX_CONFIG.folderId + '/items?fields=name&limit=1000');
    if (res.ok) {
      const j = await res.json();
      const hit = (j.entries || []).find(e => e.type === 'file' && e.name === 'revenue.json');
      if (hit) { _revId = hit.id; try { localStorage.setItem('ufc_revenue_file_id', hit.id); } catch (e) {} return hit.id; }
    }
    const token = await ensureToken(); if (!token) throw new Error('not authenticated');
    const form = new FormData();
    form.append('attributes', JSON.stringify({ name: 'revenue.json', parent: { id: BOX_CONFIG.folderId } }));
    form.append('file', new Blob([JSON.stringify(Store.defaultRevenue())], { type: 'application/json' }), 'revenue.json');
    const up = await fetch('https://upload.box.com/api/2.0/files/content', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
    if (up.status === 409) {                                     // raced another admin — use theirs
      try { const j = await up.json(); const cid = j.context_info && j.context_info.conflicts && j.context_info.conflicts.id; if (cid) { _revId = cid; try { localStorage.setItem('ufc_revenue_file_id', cid); } catch (e) {} return cid; } } catch (e) {}
      throw new Error('revenue.json create conflict — reload to retry');
    }
    if (!up.ok) throw new Error('could not create revenue.json: HTTP ' + up.status);
    const j = await up.json(); const nid = j.entries && j.entries[0] && j.entries[0].id;
    if (!nid) throw new Error('revenue.json create returned no id');
    _revId = nid; try { localStorage.setItem('ufc_revenue_file_id', nid); } catch (e) {}
    return nid;
  }
  async function pullRevenue() {
    const id = await resolveRevenueFileId();
    if (!id) return Store.defaultRevenue();
    // Etag off the content response — see pullStudio for why the separate
    // metadata call was pure cost.
    const res = await boxFetch('/files/' + id + '/content');
    _revEtag = res.headers.get('etag') || _revEtag;
    if (res.status === 404) return Store.defaultRevenue();
    if (!res.ok) throw new Error('revenue pull failed: ' + res.status);
    const txt = await res.text();
    if (!txt.trim()) return Store.defaultRevenue();
    const parsed = JSON.parse(txt);
    parsed.ledger = parsed.ledger || {};
    return parsed;
  }
  /* Merge at ROW level, not year level. Everything lives under one year, so a
     whole-year newest-wins would be newest-wins for the entire ledger — two
     admins working different projects in 2026 would erase each other. Rows
     carry their own updatedAt, so each project's line survives on its merits;
     a year present on only one side is kept whole. */
  function mergeRevenueDb(remote, local) {
    const out = Store.defaultRevenue();
    const years = new Set([...Object.keys((remote && remote.ledger) || {}), ...Object.keys((local && local.ledger) || {})]);
    years.forEach(yk => {
      const ry = ((remote && remote.ledger) || {})[yk];
      const ly = ((local && local.ledger) || {})[yk];
      if (!ry) { out.ledger[yk] = ly; return; }
      if (!ly) { out.ledger[yk] = ry; return; }
      const rows = { ...(ry.rows || {}) };
      Object.entries(ly.rows || {}).forEach(([k, lr]) => {
        const rr = rows[k];
        if (!rr || ((lr && lr.updatedAt) || '') >= ((rr && rr.updatedAt) || '')) rows[k] = lr;
      });
      // Import history is append-only per close month — union it, newest wins
      // on a month both sides posted.
      const imps = {};
      [...(ry.imports || []), ...(ly.imports || [])].forEach(i => {
        const cur = imps[i.closeMonth];
        if (!cur || (i.at || '') >= (cur.at || '')) imps[i.closeMonth] = i;
      });
      out.ledger[yk] = {
        updatedAt: ((ly.updatedAt || '') >= (ry.updatedAt || '') ? ly.updatedAt : ry.updatedAt),
        updatedBy: ((ly.updatedAt || '') >= (ry.updatedAt || '') ? ly.updatedBy : ry.updatedBy),
        imports: Object.values(imps).sort((a, b) => a.closeMonth - b.closeMonth),
        rows,
      };
    });
    return out;
  }
  async function uploadRevenue(r, depth) {
    const id = await resolveRevenueFileId();
    if (!id) return;
    const token = await ensureToken(); if (!token) throw new Error('not authenticated');
    const form = new FormData();
    form.append('attributes', JSON.stringify({ name: 'revenue.json' }));
    form.append('file', new Blob([JSON.stringify(r)], { type: 'application/json' }), 'revenue.json');
    const res = await fetch('https://upload.box.com/api/2.0/files/' + id + '/content', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, ...(_revEtag ? { 'If-Match': _revEtag } : {}) },
      body: form,
    });
    if (res.status === 412) {
      // A teammate saved first. Re-uploading ours as-is would erase their work,
      // so pull → merge per row → retry.
      if ((depth || 0) >= 2) throw new Error('revenue push failed: repeated conflicts');
      const remote = await pullRevenue();          // also refreshes _revEtag
      const merged = mergeRevenueDb(remote, r);
      Store.hydrateRevenueFromRemote(merged);
      return uploadRevenue(merged, (depth || 0) + 1);
    }
    if (!res.ok) throw new Error('revenue upload failed: ' + res.status);
    const j = await res.json(); if (j.entries && j.entries[0]) _revEtag = j.entries[0].etag;
  }
  let _revTimer = null, _revPending = null;
  function scheduleRevenuePush(r) {
    _revPending = r;
    clearTimeout(_revTimer);
    _revTimer = setTimeout(revenuePushNow, BOX_CONFIG.pushDebounceMs);
  }
  async function revenuePushNow() {
    if (!_revPending) return;
    const tok = await ensureToken(); if (!tok) return;
    const r = _revPending; _revPending = null;
    try { await uploadRevenue(r); } catch (e) { _revPending = r; console.warn('revenue push failed', e); }
  }
  Box.pullRevenue = pullRevenue;
  /** Pull-if-changed + row-level merge + hydrate — so a tab left open all day
      picks up a teammate's reconciliation instead of overwriting it. */
  Box.refreshRevenueIfChanged = async function () {
    const id = await resolveRevenueFileId();
    if (!id) return false;
    const meta = await boxFetch('/files/' + id + '?fields=etag');
    if (!meta.ok) return false;
    const m = await meta.json();
    if (_revEtag && m.etag === _revEtag) return false;
    const remote = await pullRevenue();
    const merged = mergeRevenueDb(remote, Store.readRevenue());
    Store.hydrateRevenueFromRemote(merged);
    return true;
  };

  /* ---- Revenue Diff history (history.json) — LAZY BY DESIGN ---------------
     The one file the app never pulls on boot.

     Every other store is on the critical path because some page needs it to
     draw. This one is read by a single tab in Executive Reporting, it grows
     forever on purpose, and it is the only store whose size is unbounded —
     so putting it in boot would mean every page in the app paid, every load,
     for data almost nobody is looking at. Call Box.pullHistory() when the
     Revenue Diff tab opens; nothing else touches it.

     Self-configuring by name, same as revenue.json: no Box setup, and every
     admin lands on the same file. ---- */
  let _histEtag = null, _histId = null;
  async function resolveHistoryFileId() {
    if (_histId) return _histId;
    try { const c = localStorage.getItem('ufc_history_file_id'); if (c) return (_histId = c); } catch (e) {}
    const res = await boxFetch('/folders/' + BOX_CONFIG.folderId + '/items?fields=name&limit=1000');
    if (res.ok) {
      const j = await res.json();
      const hit = (j.entries || []).find(e => e.type === 'file' && e.name === 'history.json');
      if (hit) { _histId = hit.id; try { localStorage.setItem('ufc_history_file_id', hit.id); } catch (e) {} return hit.id; }
    }
    const token = await ensureToken(); if (!token) throw new Error('not authenticated');
    const form = new FormData();
    form.append('attributes', JSON.stringify({ name: 'history.json', parent: { id: BOX_CONFIG.folderId } }));
    form.append('file', new Blob([JSON.stringify({ schemaVersion: 1, snapshots: {} })], { type: 'application/json' }), 'history.json');
    const up = await fetch('https://upload.box.com/api/2.0/files/content', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
    if (up.status === 409) {
      try { const j = await up.json(); const cid = j.context_info && j.context_info.conflicts && j.context_info.conflicts.id; if (cid) { _histId = cid; try { localStorage.setItem('ufc_history_file_id', cid); } catch (e) {} return cid; } } catch (e) {}
      throw new Error('history.json create conflict — reload to retry');
    }
    if (!up.ok) throw new Error('could not create history.json: HTTP ' + up.status);
    const j = await up.json(); const nid = j.entries && j.entries[0] && j.entries[0].id;
    if (!nid) throw new Error('history.json create returned no id');
    _histId = nid; try { localStorage.setItem('ufc_history_file_id', nid); } catch (e) {}
    return nid;
  }
  const EMPTY_HIST = () => ({ schemaVersion: 1, snapshots: {} });
  async function pullHistory() {
    const id = await resolveHistoryFileId();
    if (!id) return EMPTY_HIST();
    const res = await boxFetch('/files/' + id + '/content');
    if (res.status === 404) return EMPTY_HIST();
    if (!res.ok) throw new Error('history pull failed: ' + res.status);
    _histEtag = res.headers.get('etag') || _histEtag;
    const txt = await res.text();
    if (!txt.trim()) return EMPTY_HIST();
    const parsed = JSON.parse(txt);
    parsed.snapshots = parsed.snapshots || {};
    return parsed;
  }
  async function uploadHistory(h, depth) {
    const id = await resolveHistoryFileId();
    if (!id) return;
    const token = await ensureToken(); if (!token) throw new Error('not authenticated');
    const form = new FormData();
    form.append('attributes', JSON.stringify({ name: 'history.json' }));
    form.append('file', new Blob([JSON.stringify(h)], { type: 'application/json' }), 'history.json');
    const res = await fetch('https://upload.box.com/api/2.0/files/' + id + '/content', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, ...(_histEtag ? { 'If-Match': _histEtag } : {}) },
      body: form,
    });
    if (res.status === 412) {
      /* A teammate wrote first. Snapshots are immutable once taken, so the
         merge is a plain union by id — no field-level conflict to resolve. */
      if ((depth || 0) >= 2) throw new Error('history push failed: repeated conflicts');
      const remote = await pullHistory();
      const merged = Store.mergeHistory(remote, h);
      Store.hydrateHistoryFromRemote(merged);
      return uploadHistory(merged, (depth || 0) + 1);
    }
    if (!res.ok) throw new Error('history upload failed: ' + res.status);
    const j = await res.json(); if (j.entries && j.entries[0]) _histEtag = j.entries[0].etag;
  }
  let _histTimer = null, _histPending = null;
  function scheduleHistoryPush(h) {
    _histPending = h;
    clearTimeout(_histTimer);
    _histTimer = setTimeout(historyPushNow, BOX_CONFIG.pushDebounceMs);
  }
  async function historyPushNow() {
    if (!_histPending) return;
    const tok = await ensureToken(); if (!tok) return;
    const h = _histPending; _histPending = null;
    try { await uploadHistory(h); } catch (e) { _histPending = h; console.warn('history push failed', e); }
  }
  /** Load history.json into the local store and start mirroring writes back.
      Idempotent — the Revenue Diff tab calls it every time it opens. */
  Box.pullHistory = async function () {
    const remote = await pullHistory();
    const merged = Store.mergeHistory(remote, Store.readHistory());
    Store.hydrateHistoryFromRemote(merged);
    Store.attachHistoryRemote(scheduleHistoryPush);
    return merged;
  };
  /** Flush any debounced history write immediately — the backfill writes a
      lot at once and shouldn't rely on the tab staying open. */
  Box.flushHistory = async function () { clearTimeout(_histTimer); await historyPushNow(); };

  /* ---- Reading the dated backups ------------------------------------------
     These are ordinary Box copies of projects.json, and until now nothing
     read them back. For Revenue Diff they are the raw material: the only
     record of what the forecast said before today. ---- */
  /** Dated backups, oldest first: [{ id, name, date }]. */
  Box.listBackups = async function () {
    const res = await boxFetch('/folders/' + BOX_CONFIG.folderId + '/items?fields=name,size&limit=1000');
    if (!res.ok) throw new Error('could not list the backup folder: ' + res.status);
    const j = await res.json();
    return (j.entries || [])
      .filter(e => e.type === 'file' && e.name.indexOf(BACKUP_PREFIX) === 0 && /\.json$/.test(e.name))
      .map(e => ({ id: e.id, name: e.name, size: e.size || 0,
                   date: e.name.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10) }))
      .filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e.date))
      .sort((a, b) => a.date.localeCompare(b.date));
  };
  /** The parsed project book out of one backup file. */
  Box.readBackup = async function (fileId) {
    const res = await boxFetch('/files/' + fileId + '/content');
    if (!res.ok) throw new Error('could not read backup ' + fileId + ': ' + res.status);
    const parsed = JSON.parse(await res.text());
    return parsed && parsed.projects ? parsed.projects : {};
  };


  /* ---- Activity trail (activity-YYYY-MM.json) — ONE FILE PER MONTH ---------
     The audit trail used to ride inside projects.json, which is why it had to
     be capped: an append-only log that grows forever cannot sit on the critical
     path of twenty pages that never read it.

     It is a file per month now, and the shape does the work:

       A WRITER touches only the CURRENT month. It never sees a byte of history,
       so logging costs the same in year five as on day one.

       A PAST MONTH is finished. Nothing re-uploads it, nothing re-merges it,
       so keeping every year costs nothing — which is what makes "we keep
       everything" true rather than just a larger number.

       A READER (the Change Log) pulls only the months it is showing.

     MERGES ARE UNIONS AND NOTHING IS EVER DELETED. Entries are keyed by a
     unique id, so merging two copies is a union of two maps: order-independent,
     safe to repeat, and impossible to lose an entry in. Two admins logging in
     the same second keep both entries; a retried push double-counts nothing; a
     backfill can be re-run with no effect.

     NEVER UPLOAD WITHOUT A MERGE BASE. If we hold no etag for a shard, we have
     not seen what is in Box, and PUTting our copy would erase whatever a
     teammate wrote. Every upload path below pulls first in that case. An audit
     trail that a sync bug can shorten is worth nothing in the month you need it.
     ---- */
  const ACT_PREFIX = 'activity-';
  const ACT_IDS_KEY = 'ufc_activity_file_ids';
  let _actEtags = {};                      // month -> etag of the copy we last saw
  let _actIds = null;                      // month -> Box file id

  function actIds() {
    if (_actIds) return _actIds;
    try { _actIds = JSON.parse(localStorage.getItem(ACT_IDS_KEY) || '{}') || {}; } catch (e) { _actIds = {}; }
    return _actIds;
  }
  function rememberActId(month, id) {
    const m = actIds(); m[month] = id;
    try { localStorage.setItem(ACT_IDS_KEY, JSON.stringify(m)); } catch (e) {}
  }
  function forgetActId(month) {
    const m = actIds(); delete m[month];
    try { localStorage.setItem(ACT_IDS_KEY, JSON.stringify(m)); } catch (e) {}
  }
  const actName = (month) => ACT_PREFIX + month + '.json';

  /** Which months exist in Box. One folder listing, no downloads — this is how
      the Change Log knows how far the trail reaches before fetching any of it. */
  Box.listActivityMonths = async function () {
    const res = await boxFetch('/folders/' + BOX_CONFIG.folderId + '/items?fields=name&limit=1000');
    if (!res.ok) return [];
    const j = await res.json();
    const out = [];
    (j.entries || []).forEach(e => {
      if (e.type !== 'file') return;
      const m = /^activity-(\d{4}-\d{2})\.json$/.exec(e.name || '');
      if (!m) return;
      rememberActId(m[1], e.id);
      out.push(m[1]);
    });
    return out.sort();
  };

  /** The Box id for one month's file. `create` makes it if missing — only the
      writer of the current month ever asks for that. */
  async function resolveActShardId(month, create) {
    const cached = actIds()[month];
    if (cached) return cached;
    const res = await boxFetch('/folders/' + BOX_CONFIG.folderId + '/items?fields=name&limit=1000');
    if (res.ok) {
      const j = await res.json();
      const hit = (j.entries || []).find(e => e.type === 'file' && e.name === actName(month));
      if (hit) { rememberActId(month, hit.id); return hit.id; }
    }
    if (!create) return null;
    const token = await ensureToken(); if (!token) throw new Error('not authenticated');
    const seed = JSON.stringify({ schemaVersion: 1, month, updatedAt: null, entries: {} });
    const form = new FormData();
    form.append('attributes', JSON.stringify({ name: actName(month), parent: { id: BOX_CONFIG.folderId } }));
    form.append('file', new Blob([seed], { type: 'application/json' }), actName(month));
    const up = await fetch('https://upload.box.com/api/2.0/files/content', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
    if (up.status === 409) {                                   // raced a teammate — use theirs
      try { const j = await up.json(); const cid = j.context_info && j.context_info.conflicts && j.context_info.conflicts.id;
            if (cid) { rememberActId(month, cid); return cid; } } catch (e) {}
      throw new Error(actName(month) + ' create conflict — reload to retry');
    }
    if (!up.ok) throw new Error('could not create ' + actName(month) + ': HTTP ' + up.status);
    const j = await up.json(); const nid = j.entries && j.entries[0] && j.entries[0].id;
    if (!nid) throw new Error(actName(month) + ' create returned no id');
    rememberActId(month, nid);
    return nid;
  }

  /** One month's file, as stored. null when it does not exist yet. */
  async function pullActShard(month) {
    const id = await resolveActShardId(month, false);
    if (!id) return null;
    const meta = await boxFetch('/files/' + id + '?fields=etag');
    if (meta.ok) { const m = await meta.json(); _actEtags[month] = m.etag; }
    const res = await boxFetch('/files/' + id + '/content');
    if (res.status === 404) { forgetActId(month); delete _actEtags[month]; return null; }   // stale cached id
    if (!res.ok) throw new Error('activity pull failed for ' + month + ': ' + res.status);
    const txt = await res.text();
    if (!txt || !txt.trim()) return null;
    try { const p = JSON.parse(txt); return (p && p.entries) ? p : null; } catch (e) { return null; }
  }

  /** Push one month. Always merges onto what Box holds first — see the note
      above about never uploading without a merge base. */
  async function uploadActShard(month, depth) {
    const local = Store.getActivityShard(month);
    if (!local) return;
    // No etag means we have never seen Box's copy of this month. Look first.
    if (!_actEtags[month]) {
      const remote = await pullActShard(month);
      if (remote) Store.hydrateActivityShard(month, remote);
    }
    const merged = Store.getActivityShard(month) || local;
    const id = await resolveActShardId(month, true);
    const token = await ensureToken(); if (!token) throw new Error('not authenticated');
    const body = JSON.stringify({ schemaVersion: 1, month, updatedAt: merged.updatedAt, entries: merged.entries });
    const form = new FormData();
    form.append('attributes', JSON.stringify({ name: actName(month) }));
    form.append('file', new Blob([body], { type: 'application/json' }), actName(month));
    const res = await fetch('https://upload.box.com/api/2.0/files/' + id + '/content', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, ...(_actEtags[month] ? { 'If-Match': _actEtags[month] } : {}) },
      body: form,
    });
    if (res.status === 412) {
      if ((depth || 0) >= 3) throw new Error('activity push failed: repeated conflicts on ' + month);
      const remote = await pullActShard(month);                // also refreshes the etag
      if (remote) Store.hydrateActivityShard(month, remote);   // union — their entries and ours
      return uploadActShard(month, (depth || 0) + 1);
    }
    if (!res.ok) throw new Error('activity push failed for ' + month + ': ' + res.status);
    try { const j = await res.json(); if (j.entries && j.entries[0]) _actEtags[month] = j.entries[0].etag; } catch (e) {}
    Store.markActivityShardClean(month);
  }

  let _actTimer = null, _actPushing = null;
  async function activityPushNow() {
    if (_actPushing) return _actPushing;                       // never two in flight for the same shards
    const months = Store.dirtyActivityShards();
    if (!months.length) return;
    _actPushing = (async () => {
      for (const m of months) {
        try { await uploadActShard(m); }
        catch (e) { console.warn('activity shard push failed (it stays queued)', m, e); }
      }
    })().finally(() => { _actPushing = null; });
    return _actPushing;
  }
  function scheduleActivityPush() {
    clearTimeout(_actTimer);
    _actTimer = setTimeout(activityPushNow, BOX_CONFIG.pushDebounceMs);
  }
  /** Flush now — the Change Log's backfill writes a lot at once and must not
      depend on the tab staying open. */
  Box.flushActivity = async function () { clearTimeout(_actTimer); await activityPushNow(); };

  /** Pull specific months into the local store. The Change Log asks for the
      window it is showing; nothing else asks at all. */
  Box.pullActivityMonths = async function (months) {
    const out = [];
    for (const m of (months || [])) {
      try { const sh = await pullActShard(m); if (sh) { Store.hydrateActivityShard(m, sh); out.push(m); } }
      catch (e) { console.warn('activity month pull failed', m, e); }
    }
    return out;
  };

  /** Recover history out of the weekly backups.

      Each projects-backup-YYYY-MM-DD.json is a whole copy of projects.json as
      it stood that week, and back when the trail lived inside that file, it
      carried whatever the trail held at the time. Those entries are the only
      surviving record of the days the old 500-entry cap threw away.

      Sampled, not continuous: a weekly copy taken while the cap held roughly
      two days means roughly two days recovered per week. Re-running is free —
      the ingest is a union by entry id. */
  Box.backfillActivityFromBackups = async function (onProgress) {
    const backups = await Box.listBackups();
    let scanned = 0, found = 0, added = 0;
    for (const b of backups) {
      try {
        const res = await boxFetch('/files/' + b.id + '/content');
        if (!res.ok) continue;
        const parsed = JSON.parse(await res.text());
        scanned++;
        const trail = Array.isArray(parsed && parsed.activity) ? parsed.activity : [];
        if (!trail.length) continue;
        found += trail.length;
        added += Store.ingestActivityEntries(trail);
      } catch (e) { /* one unreadable backup must not stop the sweep */ }
      if (typeof onProgress === 'function') onProgress({ scanned, total: backups.length, found, added, at: b.date });
    }
    if (added) await Box.flushActivity();
    return { backups: backups.length, scanned, found, added };
  };

  /* ---- Rolling weekly backup ----------------------------------------------
     Box already versions projects.json on every upload (first-line recovery:
     Box → projects.json → Version History). This adds a SECOND line: a dated
     copy (projects-backup-YYYY-MM-DD.json) in the same folder, refreshed at
     most weekly and KEPT INDEFINITELY — so a version-history mishap or a
     deleted file has cold copies to fall back on, and the series doubles as
     a dated history of the book for period-over-period comparison. Any
     signed-in user's boot can create it; a 409 means someone else already
     made today's. */
  const BACKUP_PREFIX = 'projects-backup-';
  /* KEEP THEM ALL. These dated copies were built as a disaster-recovery
     second line, so a rolling window of 8 (~2 months) was enough. They have
     since become the only record of what the book looked like at a point in
     time — the raw material for comparing the forecast across dates — and
     pruning them was quietly destroying history a week at a time.
     Set a positive number here to resume pruning; 0 means never prune. */
  const BACKUP_KEEP = 0;
  async function weeklyBackup() {
    try {
      const last = Number(localStorage.getItem('ufc_last_backup_check') || 0);
      if (Date.now() - last < 20 * 3600 * 1000) return;               // check at most ~daily per browser
      localStorage.setItem('ufc_last_backup_check', String(Date.now()));
      // limit=1000 is Box's page size. At one backup a week that is ~19 years
      // of history before this would need paging — but it IS a ceiling, so if
      // the folder ever approaches it, page this call rather than losing the
      // oldest entries silently.
      const res = await boxFetch('/folders/' + BOX_CONFIG.folderId + '/items?fields=name&limit=1000');
      if (!res.ok) return;
      const j = await res.json();
      const backups = (j.entries || []).filter(e => e.type === 'file' && e.name.indexOf(BACKUP_PREFIX) === 0)
        .sort((a, b) => a.name.localeCompare(b.name));
      const newest = backups.length ? backups[backups.length - 1].name.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10) : '';
      if (newest && (Date.now() - new Date(newest).getTime()) < 7 * 86400000) return;   // fresh enough
      const today = new Date().toISOString().slice(0, 10);
      const cp = await boxFetch('/files/' + BOX_CONFIG.dataFileId + '/copy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent: { id: BOX_CONFIG.folderId }, name: BACKUP_PREFIX + today + '.json' }),
      });
      if (!cp.ok && cp.status !== 409) return;                        // 409 = a teammate beat us to it
      if (BACKUP_KEEP > 0) {
        const excess = backups.length + 1 - BACKUP_KEEP;
        for (let i = 0; i < excess; i++) { try { await boxFetch('/files/' + backups[i].id, { method: 'DELETE' }); } catch (e) {} }
      }
    } catch (e) { /* backups must never break boot */ }
  }

  /* ---- OPT-IN STORES ------------------------------------------------------
     studio.json and revenue.json used to be pulled by every page in the app,
     on every load. Exactly one page reads each: Executive Reporting reads the
     budget baselines, Revenue Reconciliation reads the actuals ledger. The
     other twenty pages fetched them, parsed them, and never looked at them —
     and boot re-polled studio.json every three minutes on all of them.

     So a page now DECLARES what it needs, before boot.js runs:

       <script>window.UFC_NEEDS = ['revenue'];</script>

     and boot waits for those and nothing else.

     AWAITED, NOT BACKGROUNDED, and that is the important part. These two
     stores are read-write: the page that reads them also saves to them. If
     the page rendered before the pull landed, a save could push a local-only
     copy over a teammate's — and with no etag held yet, `If-Match` would be
     omitted and the overwrite would be blind. Waiting keeps the semantics
     byte-for-byte identical to what boot did before; the only thing that
     changed is WHO pays for it.

     Idempotent: repeated calls share the first promise. ---- */
  const _ensured = {};
  const STORES = {
    studio: async () => {
      const remote = await pullStudio();
      try { Store.hydrateStudioFromRemote(remote); } catch (e) { console.warn('studio hydrate failed', e); }
      Store.attachStudioRemote(scheduleStudioPush);
    },
    revenue: async () => {
      const remote = await pullRevenue();
      try { Store.hydrateRevenueFromRemote(mergeRevenueDb(remote, Store.readRevenue())); }
      catch (e) { console.warn('revenue hydrate failed', e); }
      Store.attachRevenueRemote(scheduleRevenuePush);
    },
    /* The audit trail. A page that only WRITES to it — every page that saves a
       project — declares nothing and pays nothing: the push path pulls the one
       month it is about to write, and only when there is something to write.
       Declaring 'activity' is for the page that READS the trail, and even then
       it takes only the current month; the Change Log asks for older months by
       name as you widen the window. */
    activity: async () => {
      Store.attachActivityRemote(scheduleActivityPush);
      Store.migrateActivityOutOfProjects();      // lift anything still in projects.json
      const month = Store.activityShardKey();
      try { const sh = await pullActShard(month); if (sh) Store.hydrateActivityShard(month, sh); }
      catch (e) { console.warn('activity pull failed — this page is on its local cache', e); }
    },
  };
  /** Load one opt-in store, once per page. */
  Box.ensureStore = function (name) {
    if (!STORES[name]) return Promise.reject(new Error('unknown store: ' + name));
    if (_ensured[name]) return _ensured[name];
    /* A failure must leave the page usable — the local cache is still there
       and the sync indicator carries the state — but it must NOT be cached as
       success, or a later retry would be swallowed. */
    return (_ensured[name] = STORES[name]().then(
      () => { Perf.phase(name + '.json'); return true; },
      (e) => { delete _ensured[name]; console.warn(name + ' pull failed — this page is on its local cache', e); return false; }
    ));
  };
  /** Load several, in parallel. Used by boot.js for window.UFC_NEEDS. */
  Box.ensureStores = function (names) {
    return Promise.all((names || []).map(n => Box.ensureStore(n).catch(() => false)));
  };
  /** True once a store has been asked for on this page — lets the live-refresh
      loop poll only what someone is actually looking at. */
  Box.storeLoaded = function (name) { return !!_ensured[name]; };

  // ---- Boot: auth → pull → identity → attach push ----
  /* The other half of the fast path. The page is already on screen from
     cache; this pulls the real thing and folds it in. Every page in the app
     already listens for ufc:remote-updated and redraws, so a figure that
     moved since the last visit corrects itself a second later without the
     user waiting for it up front.

     Failures here are deliberately quiet: the page is usable, the cache is
     what it is, and the sync indicator carries the state. */
  async function refreshInBackground(inflight) {
    const FEE_CACHE = 'savills-ppm-fee-db:v1';
    const p = inflight || { projects: pullRemote(), rates: pullRates() };
    const [projectsR, ratesR] = await Promise.allSettled([p.projects, p.rates]);
    let changed = false;
    if (projectsR.status === 'fulfilled' && projectsR.value) {
      try {
        const local = JSON.parse(localStorage.getItem(FEE_CACHE) || 'null');
        const merged = local ? mergeDb(projectsR.value, local) : projectsR.value;
        Store.hydrateFromRemote(merged);
        changed = true;
      } catch (e) { console.warn('background project merge failed', e); }
    }
    if (ratesR.status === 'fulfilled' && ratesR.value) {
      try { if (window.RATES_CATALOG && window.RATES_CATALOG.hydrate) window.RATES_CATALOG.hydrate(ratesR.value); }
      catch (e) { console.warn('background rates hydrate failed', e); }
    }
    weeklyBackup();
    emitSync(projectsR.status === 'fulfilled' ? 'synced' : 'error',
             projectsR.status === 'fulfilled' ? '' : 'Could not refresh from Box — showing the last copy');
    if (changed) {
      try { document.dispatchEvent(new CustomEvent('ufc:remote-updated', { detail: { projects: true, background: true } })); } catch (e) {}
    }
  }

  async function boot() {
    if (!BOX_CONFIG.enabled) { emitSync('local', ''); return { ok: true, backend: 'local' }; }
    Perf.phase('boot start');
    const tok = await ensureToken();
    Perf.phase('token');
    if (!tok) {
      emitSync('signedout', 'Not signed in');
      return BOX_CONFIG.testMode ? { ok: false, needsDevToken: true } : { ok: false, needsLogin: true };
    }
    /* ---------- PARALLEL FETCH ----------
       These five are independent of each other; only the order in which their
       results are APPLIED matters. Fetching them one after another meant every
       page load paid the sum of five round trips before rendering anything.
       Fetch together, apply in the old order.

       allSettled, not all: a failing studio or revenue pull must not take the
       whole boot down, exactly as the individual try/catches used to ensure. */
    const FEE_CACHE = 'savills-ppm-fee-db:v1';

    /* ---------- FAST PATH: render from cache, refresh behind ----------
       Measurement says every Box content call costs ~800ms regardless of
       size, that the whole dataset is well under 100KB, and that
       parse/merge/hydrate is 0ms. So the entire wait is round trips — and
       waiting for them before showing anything is the actual slowness.

       IDENTITY IS STILL AWAITED. It decides what the access wall lets
       through, so rendering before it resolves could show one person the
       previous user's book on a shared machine. One ~200ms call is a price
       worth paying; the other ~800ms of waiting is not.

       After that: if this browser already holds a project cache AND a rate
       grid, hydrate from them, let the page render, and refresh from Box in
       the background — pages already listen for ufc:remote-updated and
       redraw when it lands. */
    /* Start every pull NOW, before awaiting identity. On the fast path these
       in-flight requests simply BECOME the background refresh — nothing is
       wasted and nothing is fetched twice. On a cold boot they overlap the
       identity call instead of queueing behind it. */
    const inflight = { projects: pullRemote(), rates: pullRates() };
    // Attach catch handlers now so a rejection can never surface as an
    // unhandled promise rejection while we are awaiting something else.
    Object.keys(inflight).forEach(k => { inflight[k].catch(() => {}); });

    /* Start any store this page declared IN PARALLEL with the two above,
       rather than after boot finishes. boot.js still awaits them before
       resolving ufcReady — but by then they have been in flight the whole
       time, so the page that needs one waits roughly as long as a page that
       needs none. Starting them afterwards, which is the obvious way to write
       this, made Revenue Reconciliation pay three round trips end to end. */
    try {
      const needs = window.UFC_NEEDS;
      if (Array.isArray(needs) && needs.length) Box.ensureStores(needs);
    } catch (e) { /* a page that declares nothing is the common case */ }

    let me = null;
    try { me = await getIdentity(); Store.setRealIdentity({ username: me.login, name: me.name }); }
    catch (e) { console.warn('identity failed', e); }
    Perf.phase('identity');

    const cachedRates = readRatesCache();
    if (cachedRates && localStorage.getItem(FEE_CACHE)) {
      try {
        if (window.RATES_CATALOG && window.RATES_CATALOG.hydrate) window.RATES_CATALOG.hydrate(cachedRates);
        /* The store reads localStorage directly, so the project book is
           already live — there is nothing to hydrate for it here. */
        Store.attachRemote(schedulePush);
        Store.attachActivityRemote(scheduleActivityPush);   // see below — every page WRITES the trail
        Perf.phase('served from cache');
        Perf.finish();
        emitSync('syncing', 'Refreshing from Box…');
        refreshInBackground(inflight);               // deliberately not awaited
        return { ok: true, backend: 'box', fromCache: true };
      } catch (e) {
        console.warn('cache fast-path failed, falling back to a full boot', e);
      }
    }

    const [projectsR, ratesR] = await Promise.allSettled([inflight.projects, inflight.rates]);
    Perf.phase('all pulls settled (parallel)');


    // projects.json — null means the etag matched, so the local cache already
    // holds this exact content and there is nothing to merge.
    try {
      if (projectsR.status === 'rejected') throw projectsR.reason;
      const remote = projectsR.value;
      const local = JSON.parse(localStorage.getItem(FEE_CACHE) || 'null');
      const merged = local ? mergeDb(remote, local) : remote;
      Store.hydrateFromRemote(merged);
      Perf.phase('projects.json merged + hydrated');
      emitSync('synced', '');
    } catch (e) {
      emitSync('error', 'Could not load from Box — showing local cache');
      console.error('Box pull failed — running on local cache', e);
    }

    /* Rates are REQUIRED — they are not in the shipped code — so a failure
       here is still fatal and still shows the rate-card gate. */
    if (ratesR.status === 'rejected') {
      console.error('Rate card load failed', ratesR.reason);
      return { ok: false, needsRates: true, error: (ratesR.reason && ratesR.reason.message) || String(ratesR.reason) };
    }
    try {
      if (window.RATES_CATALOG && window.RATES_CATALOG.hydrate) window.RATES_CATALOG.hydrate(ratesR.value);
      Perf.phase('rates.json');
    } catch (e) {
      console.error('Rate card hydrate failed', e);
      return { ok: false, needsRates: true, error: (e && e.message) || String(e) };
    }

    // Attach the push hook so future writes mirror to Box (AFTER hydrate, so
    // hydrating cannot echo straight back out as an upload).
    Store.attachRemote(schedulePush);
    /* And the trail's. EVERY page writes it — a save, a status change, a close
       decision — so every page must be able to push it, whether or not it ever
       reads it. Attaching costs nothing: the hook only fires when something is
       actually logged, and the upload pulls the one month it is writing. */
    Store.attachActivityRemote(scheduleActivityPush);
    weeklyBackup();   // fire and forget; failures never affect boot

    /* studio.json and revenue.json are NOT pulled here any more — see the
       opt-in stores above. Pages that read them declare window.UFC_NEEDS and
       boot.js awaits them; everyone else no longer pays for two files they
       never open. */
    Perf.phase('boot done');
    Perf.finish();
    return { ok: true, backend: 'box' };
  }

})();
