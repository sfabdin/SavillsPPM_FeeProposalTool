/* ============================================================
   SAVILLS PPM · SHARED UI — toasts instead of alert()
   ------------------------------------------------------------
   window.UFC_UI.toast(message, kind)
   window.UFC_UI.debounce(fn, ms)   — trailing-edge debounce for search
                                      boxes that rebuild a whole tab
     kind: 'err' (default — most former alerts are blockers),
           'ok'   (green-teal accent, shorter life),
           'info' (neutral)

   Non-blocking replacement for alert(): the message appears as a
   card bottom-centre, stays long enough to read (errors longer),
   stacks up to 4, dismisses on click. Multi-line messages keep
   their line breaks. Include on any page whose controller calls
   UFC_UI.toast — before that controller.
   ============================================================ */
(function () {
  'use strict';
  if (window.UFC_UI) return;

  const NAVY = '#25273A', TEAL = '#0E7C7B', RED = '#CE181E', YEL = '#FFDF00';

  const css = `
  #ufc-toasts { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
    z-index: 100002; display: flex; flex-direction: column; gap: 10px; align-items: center;
    pointer-events: none; max-width: min(560px, calc(100vw - 32px)); }
  .ufc-toast { pointer-events: auto; cursor: pointer; box-sizing: border-box; width: 100%;
    background: ${NAVY}; color: #fff; padding: 13px 18px 13px 16px;
    border-left: 4px solid ${YEL}; box-shadow: 0 8px 30px rgba(37,39,58,.35);
    font-family: "Helvetica Neue", Arial, sans-serif; font-size: 13px; line-height: 1.5;
    white-space: pre-line; overflow-wrap: break-word;
    animation: ufc-toast-in .18s ease; }
  .ufc-toast.err  { border-left-color: ${RED}; }
  .ufc-toast.ok   { border-left-color: ${TEAL}; }
  .ufc-toast.out  { opacity: 0; transition: opacity .3s; }
  @keyframes ufc-toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  @media print { #ufc-toasts { display: none !important; } }
  `;

  let holder = null;
  function mount() {
    if (holder) return holder;
    const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
    holder = document.createElement('div'); holder.id = 'ufc-toasts';
    holder.setAttribute('role', 'status'); holder.setAttribute('aria-live', 'polite');
    document.body.appendChild(holder);
    return holder;
  }

  function toast(message, kind) {
    const k = kind || 'err';
    const life = k === 'ok' ? 4500 : k === 'info' ? 6000 : 9000;
    const h = mount();
    while (h.children.length >= 4) h.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = 'ufc-toast ' + k;
    el.textContent = String(message == null ? '' : message);
    const kill = () => { el.classList.add('out'); setTimeout(() => el.remove(), 320); };
    el.addEventListener('click', kill);
    h.appendChild(el);
    setTimeout(kill, life);
    return el;
  }

  /** Trailing-edge debounce: the wrapped function runs once, `ms` after the
      last call. Used where a keystroke would otherwise rebuild a whole tab's
      innerHTML — the rebuild waits until typing pauses. */
  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(self, args); }, ms == null ? 150 : ms);
    };
  }

  window.UFC_UI = { toast, debounce };
})();
