/* ============================================================
   SAVILLS PPM · FEE SYSTEM · BOOT
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

  function renderRatesGate(detail) {
    document.documentElement.style.background = '#f3f3f0';
    document.body.innerHTML = `
      <div style="height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;color:#25273a;">
        <div style="text-align:center;max-width:460px;padding:0 24px;">
          <div style="font-weight:800;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:#6b7280;margin-bottom:14px;">Savills PPM · Fee System</div>
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
          <div style="font-weight:800;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:#6b7280;margin-bottom:14px;">Savills PPM · Fee System</div>
          <div style="font-weight:900;font-size:28px;letter-spacing:-0.01em;margin-bottom:12px;">Sign in to continue</div>
          <div style="font-size:14px;line-height:1.6;color:#6b7280;margin-bottom:26px;">Your projects are stored in Box. Sign in with your Savills account to load them.</div>
          <button id="ufc-box-login" style="font-family:system-ui,sans-serif;font-weight:700;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;padding:14px 28px;background:#25273a;color:#fff;border:0;cursor:pointer;">Sign in with Box</button>
        </div>
      </div>`;
    document.getElementById('ufc-box-login').addEventListener('click', () => window.UFC_Box.login());
  }

  window.ufcReady = run().then((r) => {
    try { document.dispatchEvent(new CustomEvent('ufc:ready', { detail: r })); } catch (e) {}
    return r;
  });
})();
