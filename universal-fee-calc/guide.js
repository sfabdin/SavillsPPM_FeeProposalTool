/* ============================================================
   SAVILLS PPM · GUIDE — reusable info markers
   ------------------------------------------------------------
   Drop a marker anywhere:
     <span class="ppm-info" data-info="Plain text. Use \n for breaks.
       **Bold** with double-asterisks. • bullet lines with a leading dot."></span>
   The script injects its own CSS (so it works on every page regardless
   of which stylesheet is loaded), then wires hover/focus/click popovers.
   Content is escaped — only **bold** and line breaks are interpreted.
   ============================================================ */
(function () {
  'use strict';
  if (window.__ppmGuideLoaded) return;
  window.__ppmGuideLoaded = true;

  var CSS = ''
    + '.ppm-info{display:inline-flex;align-items:center;justify-content:center;'
    + 'width:15px;height:15px;border-radius:50%;border:1px solid rgba(37,39,58,0.35);'
    + 'color:#5b6472;font-family:Georgia,"Times New Roman",serif;font-style:italic;font-weight:700;'
    + 'font-size:10px;line-height:1;cursor:help;vertical-align:middle;margin-left:6px;'
    + 'user-select:none;transition:background .12s,color .12s,border-color .12s;flex:none;}'
    + '.ppm-info:hover,.ppm-info.on{background:#0E7C7B;border-color:#0E7C7B;color:#fff;}'
    + '.ppm-info::after{content:"i";}'
    + '.ppm-info-pop{position:fixed;z-index:9999;max-width:320px;background:#25273A;color:#EDEEF2;'
    + 'font-family:inherit;font-size:12.5px;line-height:1.5;padding:12px 14px;border-radius:6px;'
    + 'box-shadow:0 8px 30px rgba(0,0,0,0.28);pointer-events:none;opacity:0;transform:translateY(4px);'
    + 'transition:opacity .12s,transform .12s;}'
    + '.ppm-info-pop.show{opacity:1;transform:translateY(0);}'
    + '.ppm-info-pop b{color:#fff;font-weight:700;}'
    + '.ppm-info-pop .ex{display:block;margin-top:7px;padding-top:7px;border-top:1px solid rgba(255,255,255,0.14);'
    + 'color:#B9C0CC;font-size:11.5px;}'
    + '.ppm-info-pop .arw{position:absolute;width:9px;height:9px;background:#25273A;transform:rotate(45deg);}'
    + '@media print{.ppm-info{display:none;}.ppm-info-pop{display:none;}}';

  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  var pop = null;

  const esc = window.UFC_UI.esc;
  function fmt(txt) {
    // escape, then interpret **bold**, newlines, and an "Example:" trailer
    var h = esc(txt).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    // split an "Example:"/"e.g." trailer into a subtle footer block
    h = h.replace(/\n?(Example:|e\.g\.)([\s\S]*)$/i, function (_, lead, rest) {
      return '<span class="ex"><b>' + lead + '</b>' + rest.replace(/\n/g, '<br>') + '</span>';
    });
    return h.replace(/\n/g, '<br>');
  }
  function place(marker) {
    if (!pop) return;
    var r = marker.getBoundingClientRect();
    pop.style.visibility = 'hidden';
    pop.classList.add('show');
    var pr = pop.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight, gap = 10;
    var left = r.left + r.width / 2 - pr.width / 2;
    left = Math.max(8, Math.min(left, vw - pr.width - 8));
    var below = r.bottom + gap;
    var top, arwTop;
    if (below + pr.height > vh - 8 && r.top - gap - pr.height > 8) {
      top = r.top - gap - pr.height; arwTop = pr.height - 4;   // above
    } else {
      top = below; arwTop = -4;                                 // below
    }
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    var arw = pop.querySelector('.arw');
    var arwLeft = r.left + r.width / 2 - left - 4;
    arw.style.left = Math.max(8, Math.min(arwLeft, pr.width - 16)) + 'px';
    arw.style.top = arwTop + 'px';
    pop.style.visibility = 'visible';
  }
  function show(marker) {
    hide();
    pop = document.createElement('div');
    pop.className = 'ppm-info-pop';
    pop.innerHTML = fmt(marker.getAttribute('data-info') || '') + '<span class="arw"></span>';
    document.body.appendChild(pop);
    marker.classList.add('on');
    place(marker);
    requestAnimationFrame(function () { pop && pop.classList.add('show'); });
    pop.__marker = marker;
  }
  function hide() {
    document.querySelectorAll('.ppm-info.on').forEach(function (m) { m.classList.remove('on'); });
    if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
    pop = null;
  }

  document.addEventListener('mouseover', function (e) {
    var m = e.target.closest && e.target.closest('.ppm-info');
    if (m) show(m);
  });
  document.addEventListener('mouseout', function (e) {
    var m = e.target.closest && e.target.closest('.ppm-info');
    if (m && (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('.ppm-info'))) hide();
  });
  document.addEventListener('click', function (e) {
    var m = e.target.closest && e.target.closest('.ppm-info');
    if (m) { e.stopPropagation(); if (pop && pop.__marker === m) hide(); else show(m); }
    else if (pop) hide();
  });
  document.addEventListener('focusin', function (e) {
    var m = e.target.closest && e.target.closest('.ppm-info');
    if (m) show(m);
  });
  window.addEventListener('scroll', function () { if (pop && pop.__marker) place(pop.__marker); }, true);
  window.addEventListener('resize', hide);

  // make markers keyboard-focusable
  function tag() {
    document.querySelectorAll('.ppm-info:not([tabindex])').forEach(function (m) {
      m.setAttribute('tabindex', '0');
      m.setAttribute('role', 'button');
      m.setAttribute('aria-label', 'More information');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tag);
  else tag();
  // re-tag after dynamic renders
  window.PPMGuide = { retag: tag };
})();
