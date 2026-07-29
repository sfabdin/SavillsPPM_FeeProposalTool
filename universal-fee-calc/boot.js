/* ============================================================
   SAVILLS PPM · FEE & REVENUE SYSTEM · BOOT
   ------------------------------------------------------------
   One include that prepares the data layer before a page renders.
   • Box disabled  → resolves instantly, app runs on localStorage (today).
   • Box enabled   → ensures login, pulls projects.json, sets identity,
                     THEN lets the page render.

   USAGE — put this AFTER store.js + box-adapter.js and BEFORE the page's
   own app script, and have the page wait for window.ufcReady:

     <script src="universal-fee-calc/store.js"></script>
     <script src="universal-fee-calc/box-adapter.js"></script>
     <script src="universal-fee-calc/boot.js"></script>
     ...
     <script>
       window.ufcReady.then(() => { renderThePage(); });
     </script>

   For pages whose script can't easily be deferred, boot.js also fires a
   'ufc:ready' DOM event you can listen for.
   ============================================================ */
(function () {
  'use strict';
  const Box = window.UFC_Box;

  async function run() {
    if (!Box || !Box.enabled) return { backend: 'local' };
    const res = await Box.boot();
    if (res && res.needsDevToken) {
      renderTokenGate();
      return new Promise(() => {});       // halt until token entered + reload
    }
    if (res && res.needsLogin) {
      renderLoginGate();
      return new Promise(() => {});       // halt until OAuth redirect
    }
    if (res && res.needsRates) {
      renderRatesGate(res.error);
      return new Promise(() => {});       // halt — calculator can't run without the rate card
    }
    return res;
  }

  /* Last-resort gate: only reached if boot() rejects unexpectedly (something
     it doesn't already try/catch internally — e.g. storage blocked entirely by
     browser privacy settings). Without this, window.ufcReady rejected with no
     handler, and every page waiting on ufcReady.then(start) just hung with a
     blank screen and no console-visible explanation for a non-technical user. */
  function renderBootErrorGate(err) {
    document.documentElement.style.background = '#f3f3f0';
    document.body.innerHTML = `
      <div style="height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;color:#25273a;">
        <div style="text-align:center;max-width:460px;padding:0 24px;">
          <div style="font-weight:800;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:#6b7280;margin-bottom:14px;">Savills PPM · Fee &amp; Revenue System</div>
          <div style="font-weight:900;font-size:26px;letter-spacing:-0.01em;margin-bottom:10px;">Couldn't start the app</div>
          <div style="font-size:14px;line-height:1.6;color:#6b7280;margin-bottom:20px;">Something went wrong loading data before the page could render. This is usually temporary — a network hiccup or a browser storage restriction.</div>
          <button onclick="window.location.reload()" style="font-family:system-ui,sans-serif;font-weight:700;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;padding:13px 26px;background:#25273a;color:#fff;border:0;cursor:pointer;">Retry</button>
          <div style="color:#a0a0a0;font-size:11px;margin-top:14px;">${err ? String((err && err.message) || err).replace(/</g, '&lt;') : ''}</div>
        </div>
      </div>`;
  }

  function renderRatesGate(detail) {
    document.documentElement.style.background = '#f3f3f0';
    document.body.innerHTML = `
      <div style="height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;color:#25273a;">
        <div style="text-align:center;max-width:460px;padding:0 24px;">
          <div style="font-weight:800;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:#6b7280;margin-bottom:14px;">Savills PPM · Fee &amp; Revenue System</div>
          <div style="font-weight:900;font-size:26px;letter-spacing:-0.01em;margin-bottom:10px;">Rate card unavailable</div>
          <div style="font-size:14px;line-height:1.6;color:#6b7280;margin-bottom:20px;">The confidential rate grid couldn't be loaded from Box, so the calculator can't run. This usually means <strong>rates.json</strong> hasn't been added to the Box folder yet, or the file id isn't set in the app config.</div>
          <button onclick="window.location.reload()" style="font-family:system-ui,sans-serif;font-weight:700;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;padding:13px 26px;background:#25273a;color:#fff;border:0;cursor:pointer;">Retry</button>
          <div style="color:#a0a0a0;font-size:11px;margin-top:14px;">${detail ? String(detail).replace(/</g, '&lt;') : ''}</div>
        </div>
      </div>`;
  }

  function renderTokenGate() {
    document.documentElement.style.background = '#f3f3f0';
    document.body.innerHTML = `
      <div style="height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;color:#25273a;">
        <div style="text-align:center;max-width:480px;padding:0 24px;">
          <div style="font-weight:800;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:#6b7280;margin-bottom:14px;">Box test mode</div>
          <div style="font-weight:900;font-size:26px;letter-spacing:-0.01em;margin-bottom:10px;">Paste your Box Developer Token</div>
          <div style="font-size:13px;line-height:1.6;color:#6b7280;margin-bottom:18px;">From Box → your app → <strong>Developer Token → Copy</strong>. It lasts ~60 min and is stored only in this browser tab — never saved to the code.</div>
          <input id="ufc-tok" type="password" placeholder="Paste token here" style="width:100%;padding:12px 14px;font-size:14px;border:1px solid #c9c9c4;margin-bottom:12px;box-sizing:border-box;">
          <button id="ufc-tok-go" style="font-family:system-ui,sans-serif;font-weight:700;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;padding:13px 26px;background:#25273a;color:#fff;border:0;cursor:pointer;width:100%;">Connect to Box</button>
          <div id="ufc-tok-err" style="color:#ce181e;font-size:12px;margin-top:10px;min-height:16px;"></div>
        </div>
      </div>`;
    const go = () => {
      const v = document.getElementById('ufc-tok').value.trim();
      if (!v) { document.getElementById('ufc-tok-err').textContent = 'Paste a token first.'; return; }
      window.UFC_Box.setTestToken(v);
      window.location.reload();
    };
    document.getElementById('ufc-tok-go').addEventListener('click', go);
    document.getElementById('ufc-tok').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  }

  function renderLoginGate() {
    document.documentElement.style.background = '#f3f3f0';
    document.body.innerHTML = `
      <div style="height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;color:#25273a;">
        <div style="text-align:center;max-width:420px;padding:0 24px;">
          <div style="font-weight:800;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:#6b7280;margin-bottom:14px;">Savills PPM · Fee &amp; Revenue System</div>
          <div style="font-weight:900;font-size:28px;letter-spacing:-0.01em;margin-bottom:12px;">Sign in to continue</div>
          <div style="font-size:14px;line-height:1.6;color:#6b7280;margin-bottom:26px;">Your projects are stored in Box. Sign in with your Savills account to load them.</div>
          <button id="ufc-box-login" style="font-family:system-ui,sans-serif;font-weight:700;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;padding:14px 28px;background:#25273a;color:#fff;border:0;cursor:pointer;">Sign in with Box</button>
        </div>
      </div>`;
    document.getElementById('ufc-box-login').addEventListener('click', () => window.UFC_Box.login());
  }

  /* Live refresh: while Box is enabled and a tab stays open, periodically check
     projects.json/studio.json for a teammate's save and merge it in — same
     pattern the staffing page already uses for staff.json. A page doesn't have
     to do anything to benefit: this just keeps the local cache from going
     stale, which is what lets saveProject()'s existing STALE_WRITE guard catch
     a real conflict instead of it only surfacing later as a silent Box merge.
     Pages that want to visually refresh can listen for 'ufc:remote-updated'. */
  function startLiveRefresh() {
    if (!Box || !Box.enabled) return;
    let busy = false;
    const refresh = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const projects = Box.refreshProjectsIfChanged ? await Box.refreshProjectsIfChanged() : false;
        const studio = Box.refreshStudioIfChanged ? await Box.refreshStudioIfChanged() : false;
        if (projects || studio) {
          try { document.dispatchEvent(new CustomEvent('ufc:remote-updated', { detail: { projects, studio } })); } catch (e) {}
        }
      } catch (e) { /* a missed refresh just tries again next tick */ }
      finally { busy = false; }
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    setInterval(refresh, 180000);   // same 3-min cadence as staff.json's live refresh
  }

  window.ufcReady = run().then((r) => {
    // Normalize local cache: run schema migrations + sweep old tombstones once.
    try { if (window.UFC_Store) { window.UFC_Store.runMigrations(); window.UFC_Store.purgeTombstones(); } } catch (e) {}
    try { document.dispatchEvent(new CustomEvent('ufc:ready', { detail: r })); } catch (e) {}
    if (r && r.backend === 'box') startLiveRefresh();
    return r;
  }).catch((e) => {
    console.error('Boot failed unexpectedly', e);
    renderBootErrorGate(e);
    return new Promise(() => {});   // halt — same convention as the other gates
  });
})();
