/* ============================================================
   SAVILLS PPM · CONFIRMED BOOK COUNTDOWN (every page)
   ------------------------------------------------------------
   A self-injecting pill, bottom-left, that says where the person
   stands on this month's confirmation and counts down to the
   deadline. Past the deadline without confirming it turns bold red
   and pulses; a locked month they never confirmed does the same
   until they submit with a reason. Click → Monthly Confirmed Book.

   Reads the local cache first (instant), then asks Box once per page
   load for the month list and the open month's etag — one or two
   small calls, no download unless something changed. Include after
   confirmed-book.js, box-adapter.js and boot.js.
   ============================================================ */
(function () {
  'use strict';
  const S = window.UFC_Store, C = window.UFC_Confirm, Box = window.UFC_Box;
  if (!S || !C) return;
  if (/monthly confirmed book/i.test(decodeURIComponent(location.pathname.split('/').pop() || ''))) return;   // the page itself has the full view

  const PAGE = 'Monthly Confirmed Book.html';
  const REFRESH_MS = 3 * 60 * 1000;
  const css = `
  #ufc-confirm{position:fixed;left:18px;bottom:18px;z-index:99998;display:none;align-items:center;gap:10px;
    padding:9px 14px 9px 12px;border-radius:999px;font-family:system-ui,-apple-system,sans-serif;font-size:12px;font-weight:700;
    letter-spacing:.04em;line-height:1;cursor:pointer;text-decoration:none;border:1px solid rgba(37,39,58,.14);
    background:#fff;color:#25273A;box-shadow:0 4px 16px rgba(37,39,58,.16);max-width:min(72vw,520px);}
  #ufc-confirm .dot{width:9px;height:9px;border-radius:50%;flex:none;background:#79828C}
  #ufc-confirm .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #ufc-confirm .k{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;opacity:.7;padding-right:9px;margin-right:-1px;border-right:1px solid currentColor}
  #ufc-confirm[data-tone="g"]{border-color:rgba(31,122,76,.35)} #ufc-confirm[data-tone="g"] .dot{background:#1E7A4C}
  #ufc-confirm[data-tone="y"]{border-color:rgba(217,164,0,.5)} #ufc-confirm[data-tone="y"] .dot{background:#D9A400}
  #ufc-confirm[data-tone="r"]{background:#25273A;color:#fff;border-color:#25273A} #ufc-confirm[data-tone="r"] .dot{background:#FFDF00}
  #ufc-confirm[data-tone="rr"]{background:#CE181E;color:#fff;border-color:#A6131A;font-weight:900;font-size:13px;letter-spacing:.06em;text-transform:uppercase}
  #ufc-confirm[data-tone="rr"] .dot{background:#fff;animation:ufc-cpulse 1.05s ease-in-out infinite}
  @keyframes ufc-cpulse{0%,100%{opacity:1}50%{opacity:.3}}
  @media (prefers-reduced-motion: reduce){#ufc-confirm[data-tone="rr"] .dot{animation:none}}
  @media print{#ufc-confirm{display:none!important}}
  @media (max-width:640px){#ufc-confirm{bottom:64px}}
  `;

  function mount() {
    if (document.getElementById('ufc-confirm')) return;
    const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
    const a = document.createElement('a');
    a.id = 'ufc-confirm'; a.href = PAGE; a.title = 'Monthly Confirmed Book';
    a.innerHTML = '<span class="dot"></span><span class="k"></span><span class="t"></span>';
    document.body.appendChild(a);
  }
  function paint() {
    const el = document.getElementById('ufc-confirm'); if (!el) return;
    let w; try { w = C.widgetState(); } catch (e) { w = { kind: 'quiet' }; }
    if (!w || w.kind === 'quiet') { el.style.display = 'none'; return; }
    const ym = w.cycle ? C.monthName(w.cycle.cycle) : '';
    const dl = w.cycle ? C.fmtDay(w.cycle.deadline + 'T12:00:00') : '';
    let tone = 'r', k = ym + ' book', text = '';
    const s = w.status || {};
    if (w.kind === 'confirmed') { tone = 'g'; text = 'Confirmed ' + C.fmtDay(s.at); }
    else if (w.kind === 'changed') { tone = 'y'; text = 'Confirmed ' + C.fmtDay(s.at) + ' · ' + s.changed + ' edited since'; }
    else if (w.kind === 'due') { tone = 'r'; text = (s.days === 0 ? 'Confirm today' : 'Confirm by ' + dl + ' · ' + s.days + ' day' + (s.days === 1 ? '' : 's') + ' left'); }
    else if (w.kind === 'overdue') { tone = 'rr'; text = 'Overdue · ' + s.days + ' day' + (s.days === 1 ? '' : 's') + ' late · confirm now'; }
    else if (w.kind === 'missed') { tone = 'rr'; text = 'Locked without your confirmation · submit with a reason'; }
    else if (w.kind === 'admin') {
      tone = w.overdue ? 'rr' : 'r';
      text = w.done + ' of ' + w.expected + ' confirmed · ' + (w.overdue ? 'deadline passed' : (w.days === 0 ? 'due today' : 'due ' + dl + ' · ' + w.days + ' day' + (w.days === 1 ? '' : 's')));
    }
    el.dataset.tone = tone;
    el.querySelector('.k').textContent = k;
    el.querySelector('.t').textContent = text;
    el.style.display = 'inline-flex';
  }
  async function refresh() {
    if (!Box || !Box.enabled || !Box.syncConfirmed) return;
    const at = C.listedAt();
    if (at && (Date.now() - new Date(at).getTime()) < REFRESH_MS) return;
    try { await Box.syncConfirmed(); paint(); } catch (e) { /* the cache is what it is */ }
  }
  function start() {
    mount(); paint();
    const go = () => { paint(); refresh(); };
    if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(go, go); else go();
    document.addEventListener('ufc:remote-updated', paint);
    document.addEventListener('ufc:confirmed-updated', paint);
    setInterval(paint, 60 * 1000);       // the countdown ticks over midnight without a reload
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
