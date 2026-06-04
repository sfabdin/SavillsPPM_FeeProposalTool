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
    if (res && res.needsLogin) {
      // Show a minimal sign-in gate instead of an empty app.
      renderLoginGate();
      // Never resolves — the gate's button drives the OAuth redirect.
      return new Promise(() => {});
    }
    return res;
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
