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
    studioFileId: '2302220793247',        // studio.json in Box (Revenue Studio baselines + scenarios)
    actualsFileId: '',                    // clockify-actuals.csv in Box — hours by user×project×month. '' = not configured (page falls back to manual drop / API proxy)
    staffFileId: '2364190093321',         // staff.json in Box — the LIVING staffing matrix (allocations + notes + actuals + mappings), shared by all admins
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
    url.searchParams.set('state', randomStr(12));
    window.location.assign(url.toString());
  }
  async function logout() {
    // Flush any unsynced changes BEFORE tearing down the session, so signing
    // out can never strand a save in this browser.
    try { if (_pending) { clearTimeout(_pushTimer); await pushNow(); } } catch (e) {}
    clearToken();
    try { Store.setRealIdentity(null); } catch (e) {}
    try { Store.clearImpersonation(); } catch (e) {}
    // Clear the local project cache so no fee data lingers on a shared machine.
    try { localStorage.removeItem('savills-ppm-fee-db:v1'); } catch (e) {}
  }

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
    const token = await ensureToken();
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
  let _remoteCount = 0;   // project count last seen in Box — drives the shrink guard
  async function pullRemote() {
    const meta = await boxFetch('/files/' + BOX_CONFIG.dataFileId + '?fields=etag');
    if (meta.ok) { const m = await meta.json(); _etag = m.etag; }
    const res = await boxFetch('/files/' + BOX_CONFIG.dataFileId + '/content');
    if (res.status === 404) return Store.defaultDb();
    if (!res.ok) throw new Error('pull failed: ' + res.status);
    let db;
    try { db = JSON.parse(await res.text()); } catch (e) { db = Store.defaultDb(); }
    _remoteCount = Object.keys((db && db.projects) || {}).length;
    return db;
  }

  // Download the confidential rate grid (rates.json) from Box.
  // Never cached to localStorage — it must not linger on a signed-out machine.
  async function pullRates() {
    const id = BOX_CONFIG.ratesFileId;
    if (!id || /PASTE/.test(id)) throw new Error('rates file id not configured');
    const res = await boxFetch('/files/' + id + '/content');
    if (!res.ok) throw new Error('rates pull failed: ' + res.status);
    return JSON.parse(await res.text());
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
    // Union the append-only activity logs by id, keep most recent 500.
    const seen = {};
    [...(remote.activity || []), ...(local.activity || [])].forEach(e => {
      if (e && e.id) seen[e.id] = e;
    });
    out.activity = Object.values(seen)
      .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''))
      .slice(-500);

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
       Both are built up one month at a time, often from different machines —
       Finance posts July on their laptop while someone else is still working
       through June. The catch-all below takes whichever side wrote last for
       the entire key, which would silently drop the other month. Merging per
       period keeps every close that either side has, and only compares
       timestamps when the SAME period exists on both. */
    const unionByPeriod = (key, stamp) => {
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
    unionByPeriod('ledger', (v) => (v && v.postedAt) || '');
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
    const meta = await boxFetch('/files/' + id + '?fields=etag');
    if (meta.ok) { const m = await meta.json(); _staffEtag = m.etag; }
    const res = await boxFetch('/files/' + id + '/content');
    if (res.status === 404) { _staffId = null; try { localStorage.removeItem('ufc_staff_file_id'); } catch (e) {} return null; }  // stale cached id — re-resolve next load
    if (!res.ok) throw new Error('staff pull failed: ' + res.status);
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

  // ---- Revenue Studio file (studio.json) — SEPARATE from projects.json ----
  let _studioEtag = null;
  async function pullStudio() {
    const id = BOX_CONFIG.studioFileId;
    if (!id || /PASTE/.test(id)) return Store.defaultStudio();   // not configured yet → local only
    const meta = await boxFetch('/files/' + id + '?fields=etag');
    if (meta.ok) { const m = await meta.json(); _studioEtag = m.etag; }
    const res = await boxFetch('/files/' + id + '/content');
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

  /* ---- Rolling weekly backup ----------------------------------------------
     Box already versions projects.json on every upload (first-line recovery:
     Box → projects.json → Version History). This adds a SECOND line: a dated
     copy (projects-backup-YYYY-MM-DD.json) in the same folder, refreshed at
     most weekly, keeping the last 8 — so even a version-history mishap or a
     deleted file has cold copies going back ~2 months. Any signed-in user's
     boot can create it; a 409 means someone else already made today's. */
  const BACKUP_PREFIX = 'projects-backup-';
  const BACKUP_KEEP = 8;
  async function weeklyBackup() {
    try {
      const last = Number(localStorage.getItem('ufc_last_backup_check') || 0);
      if (Date.now() - last < 20 * 3600 * 1000) return;               // check at most ~daily per browser
      localStorage.setItem('ufc_last_backup_check', String(Date.now()));
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
      const excess = backups.length + 1 - BACKUP_KEEP;
      for (let i = 0; i < excess; i++) { try { await boxFetch('/files/' + backups[i].id, { method: 'DELETE' }); } catch (e) {} }
    } catch (e) { /* backups must never break boot */ }
  }

  // ---- Boot: auth → pull → identity → attach push ----
  async function boot() {
    if (!BOX_CONFIG.enabled) { emitSync('local', ''); return { ok: true, backend: 'local' }; }
    const tok = await ensureToken();
    if (!tok) {
      emitSync('signedout', 'Not signed in');
      return BOX_CONFIG.testMode ? { ok: false, needsDevToken: true } : { ok: false, needsLogin: true };
    }
    // Identity → drives the access wall. The role is decided by the admin
    // allowlist in store.js (fail-closed); unknown logins see only their own.
    try {
      const me = await getIdentity();
      Store.setRealIdentity({ username: me.login, name: me.name });
    } catch (e) { console.warn('identity failed', e); }
    // Pull remote → local
    try {
      const remote = await pullRemote();
      const local = JSON.parse(localStorage.getItem('savills-ppm-fee-db:v1') || 'null');
      const merged = local ? mergeDb(remote, local) : remote;
      Store.hydrateFromRemote(merged);
      emitSync('synced', '');
    } catch (e) {
      emitSync('error', 'Could not load from Box — showing local cache');
      console.error('Box pull failed — running on local cache', e);
    }
    // Pull the confidential rate grid (rates.json) and hydrate the catalog.
    // This is REQUIRED — the rates aren't in the shipped code — so a failure
    // here is fatal (caller shows the rate-card gate rather than running blank).
    try {
      const ratesPayload = await pullRates();
      if (window.RATES_CATALOG && window.RATES_CATALOG.hydrate) window.RATES_CATALOG.hydrate(ratesPayload);
    } catch (e) {
      console.error('Rate card load failed', e);
      return { ok: false, needsRates: true, error: (e && e.message) || String(e) };
    }
    // Attach the push hook so future writes mirror to Box
    Store.attachRemote(schedulePush);
    // Rolling weekly backup of projects.json (on top of Box's own version
    // history) — fire and forget; failures never affect boot.
    weeklyBackup();
    // Revenue Studio file (separate). Pull → hydrate → attach its push hook.
    try {
      const studio = await pullStudio();
      Store.hydrateStudioFromRemote(studio);
    } catch (e) { console.warn('studio pull failed', e); }
    Store.attachStudioRemote(scheduleStudioPush);
    return { ok: true, backend: 'box' };
  }

})();
