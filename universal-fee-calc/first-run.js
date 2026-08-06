/* ============================================================
   SAVILLS PPM · FIRST-RUN POINTER
   ------------------------------------------------------------
   One-time dismissible banner pointing new users at the Getting
   Started guide. Shows until dismissed (flag in localStorage),
   then never again on any page. Purely additive — include on the
   pages revenue leaders land on (Home, Projects Index, Revenue
   Projections). No data access, no dependencies.
   ============================================================ */
(function () {
  'use strict';
  const KEY = 'ufc-welcome-v1';
  try { if (localStorage.getItem(KEY)) return; } catch (e) { return; }

  function mount() {
    if (document.getElementById('ufc-welcome')) return;
    const el = document.createElement('div');
    el.id = 'ufc-welcome';
    // right padding clears the fixed hamburger button (top:16px right:16px)
    el.style.cssText = 'position:sticky;top:0;z-index:9000;background:#25273A;color:#fff;padding:11px 76px 11px 18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-family:"Helvetica Neue",Arial,sans-serif;font-size:13px;box-shadow:0 2px 10px rgba(37,39,58,.25)';
    el.innerHTML = `
      <span style="flex:1;min-width:240px"><b style="color:#FFDF00">New here?</b> The 5-minute guide explains how the tools fit together, what you're expected to keep current, and what every number means.</span>
      <a href="Getting Started.html" style="color:#25273A;background:#FFDF00;font-weight:800;text-decoration:none;padding:7px 14px;font-size:12px;letter-spacing:.04em">READ GETTING STARTED →</a>
      <button type="button" aria-label="Dismiss" style="background:none;border:1px solid rgba(255,255,255,.4);color:#fff;cursor:pointer;padding:6px 12px;font-size:12px">Dismiss</button>`;
    el.querySelector('button').addEventListener('click', () => {
      try { localStorage.setItem(KEY, new Date().toISOString()); } catch (e) {}
      el.remove();
    });
    document.body.prepend(el);
  }

  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
