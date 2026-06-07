/* ============================================================
   SAVILLS PPM · FEE SYSTEM · SYNC STATUS INDICATOR
   ------------------------------------------------------------
   A small, self-injecting pill (bottom-right) that makes the Box
   sync state impossible to miss — so a failed/expired token can
   never silently strand changes in the browser again.

   Listens for the 'ufc:sync' events broadcast by box-adapter.js:
     pending  → changes saved locally, waiting to push
     syncing  → upload in flight
     synced   → up to date in Box
     error    → push/pull failed (network, etag, etc.) — retryable
     signedout→ no valid token — changes are local only
     local    → Box layer is off (no pill)

   Click the pill to force a sync ("Sync now"); when signed out it
   sends you to sign in. Include AFTER box-adapter.js + boot.js.
   ============================================================ */
(function () {
  'use strict';
  const Box = window.UFC_Box;
  // Box layer off → nothing to show.
  if (!Box || !Box.enabled) return;

  const SAV = {
    navy: '#25273A', teal: '#0E7C7B', red: '#CE181E', redPress: '#A6131A',
    yellow: '#FFDF00', steel: '#79828C', cream: '#EEE8E3', white: '#FFFFFF',
  };

  // ---- styles (layout only; colors are applied inline per-state in render) ----
  const css = `
  #ufc-sync {
    position: fixed; right: 18px; bottom: 18px; z-index: 99999;
    display: inline-flex; align-items: center; gap: 9px;
    padding: 9px 14px; border-radius: 999px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 12px; font-weight: 700; letter-spacing: 0.04em;
    line-height: 1; cursor: pointer; user-select: none;
    border: 1px solid transparent;
    box-shadow: 0 4px 16px rgba(37,39,58,0.16);
    transition: background .18s, color .18s, border-color .18s, opacity .3s;
  }
  #ufc-sync .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  #ufc-sync .label { white-space: nowrap; }
  #ufc-sync .act {
    font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
    padding-left: 9px; margin-left: 2px; border-left: 1px solid currentColor;
    opacity: 0.75;
  }
  #ufc-sync.pulse .dot { animation: ufc-pulse 1.05s ease-in-out infinite; }
  @keyframes ufc-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
  @media print { #ufc-sync { display: none !important; } }
  `;

  // state → { bg, fg, dot, border, pulse, showAct }
  const STATE_STYLE = {
    pending:   { bg: SAV.navy, fg: SAV.white, dot: SAV.yellow, border: SAV.navy, pulse: true,  showAct: false },
    syncing:   { bg: SAV.navy, fg: SAV.white, dot: SAV.yellow, border: SAV.navy, pulse: true,  showAct: false },
    synced:    { bg: SAV.white, fg: SAV.navy, dot: SAV.teal,  border: 'rgba(37,39,58,0.14)', pulse: false, showAct: false },
    error:     { bg: SAV.red,  fg: SAV.white, dot: SAV.white, border: SAV.redPress, pulse: true,  showAct: true },
    signedout: { bg: SAV.red,  fg: SAV.white, dot: SAV.white, border: SAV.redPress, pulse: true,  showAct: true },
  };

  function mount() {
    if (document.getElementById('ufc-sync')) return;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const el = document.createElement('button');
    el.id = 'ufc-sync';
    el.type = 'button';
    el.innerHTML = '<span class="dot"></span><span class="label">Connecting…</span><span class="act">Sync now</span>';
    el.addEventListener('click', () => {
      const st = el.getAttribute('data-state');
      if (st === 'signedout') {
        if (Box.login) Box.login();
        return;
      }
      if (Box.syncNow) Box.syncNow();
    });
    document.body.appendChild(el);
    render(Box.syncState || { state: 'pending' });
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    let h = d.getHours(), m = d.getMinutes();
    const ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
  }

  const COPY = {
    pending:   { label: 'Saving…' },
    syncing:   { label: 'Syncing to Box…' },
    synced:    { label: 'Synced to Box' },
    error:     { label: 'Not synced', act: 'Retry' },
    signedout: { label: 'Sign in to sync', act: 'Sign in' },
  };

  function render(detail) {
    const el = document.getElementById('ufc-sync');
    if (!el) return;
    const state = (detail && detail.state) || 'pending';
    if (state === 'local') { el.style.display = 'none'; return; }
    el.style.display = 'inline-flex';
    el.setAttribute('data-state', state);

    const s = STATE_STYLE[state] || STATE_STYLE.pending;
    el.style.background = s.bg;
    el.style.color = s.fg;
    el.style.borderColor = s.border;
    el.classList.toggle('pulse', !!s.pulse);
    const dot = el.querySelector('.dot');
    if (dot) dot.style.background = s.dot;

    const c = COPY[state] || COPY.pending;
    let label = c.label;
    if (state === 'synced' && detail && detail.at) label = 'Synced · ' + fmtTime(detail.at);
    el.querySelector('.label').textContent = label;

    const act = el.querySelector('.act');
    if (s.showAct && c.act) { act.textContent = c.act; act.style.display = ''; }
    else { act.style.display = 'none'; }

    el.setAttribute('title', (detail && detail.message) ? detail.message : label);
  }

  document.addEventListener('ufc:sync', (e) => render(e.detail));

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
