/* ============================================================
   SAVILLS PPM · GLOBAL NAV  (self-injecting hamburger menu)
   ------------------------------------------------------------
   Drop <script src="universal-fee-calc/nav.js"></script> on any
   page and it adds a fixed hamburger button + slide-out menu
   linking every tool. Highlights the current page. Admin-only
   items (Revenue Studio) hide for non-admins once the data layer
   reports identity; shown by default so it never blocks.
   ============================================================ */
(function () {
  'use strict';
  // Every tool in the system. `admin:true` = only show to admins.
  const LINKS = [
    { href: 'Fee Generator.html',            label: 'Home',                group: 'Build' },
    { href: 'Universal Fee Calculator.html', label: 'Fee Calculator',      group: 'Build' },
    { href: 'Ingestion Studio.html',         label: 'Ingestion Studio',    group: 'Admin', admin: true },
    { href: 'Projects Index.html',           label: 'Projects Index',      group: 'Manage' },
    { href: 'Staffing Matrix.html',          label: 'Staffing & Bandwidth', group: 'Admin', admin: true },
    { href: 'Profitability.html',            label: 'Profitability',       group: 'Admin', admin: true },
    { href: 'Revenue Projections.html',      label: 'Revenue Projections', group: 'Manage' },
    { href: 'Revenue Studio.html',           label: 'Revenue Studio',      group: 'Manage' },
    { href: 'Benchmarking Dashboard.html',   label: 'Benchmarking',        group: 'Manage' },
    { href: 'Proposal Analytics.html',        label: 'Proposal Analytics',  group: 'Manage' },
    { href: 'Data Entry Status.html',        label: 'Data Entry Status',   group: 'Manage' },
    { href: 'Change Log.html',               label: 'Change Log',          group: 'Manage' },
    { href: 'Ingestion Studio.html?mode=bulk', label: 'Import Revenues',   group: 'Admin', admin: true },
    { href: 'Import Small Works.html',       label: 'Import Small Works',  group: 'Admin', admin: true, note: 'one-time' },
    { href: 'Rate Grid Reconciliation.html', label: 'Rate Reconciliation', group: 'Admin', admin: true },
    { href: 'Getting Started.html',          label: 'Getting Started',     group: 'Docs' },
    { href: 'Enterprise Migration Guide.html', label: 'Migration Guide',   group: 'Docs' },
    { href: 'Fee System Roadmap.html',       label: 'Roadmap',             group: 'Docs' },
    { href: 'Maintainers Runbook.html',      label: 'Maintainer’s Runbook', group: 'Docs' },
  ];
  const NAVY = '#25273A', YEL = '#FFDF00', TEAL = '#0E7C7B';
  const here = (location.pathname.split('/').pop() || '').toLowerCase();

  const css = `
  #ppm-nav-btn{position:fixed;top:16px;right:16px;z-index:100000;width:44px;height:44px;border:0;cursor:pointer;
    background:${NAVY};color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;box-shadow:0 3px 12px rgba(37,39,58,.28);}
  #ppm-nav-btn span{display:block;width:20px;height:2px;background:#fff;transition:.2s;}
  #ppm-nav-btn:hover{background:${TEAL};}
  #ppm-nav-ov{position:fixed;inset:0;background:rgba(37,39,58,.45);z-index:100000;opacity:0;pointer-events:none;transition:opacity .2s;}
  #ppm-nav-ov.open{opacity:1;pointer-events:auto;}
  #ppm-nav-panel{position:fixed;top:0;right:0;height:100%;width:300px;max-width:84vw;background:#fff;z-index:100001;
    transform:translateX(102%);transition:transform .22s ease;box-shadow:-6px 0 30px rgba(37,39,58,.22);display:flex;flex-direction:column;
    font-family:"Helvetica Neue",Arial,sans-serif;}
  #ppm-nav-panel.open{transform:translateX(0);}
  #ppm-nav-panel .pn-head{background:${NAVY};color:#fff;padding:20px 22px;display:flex;justify-content:space-between;align-items:center;}
  #ppm-nav-panel .pn-head .pn-t{font-weight:800;font-size:14px;letter-spacing:.04em;}
  #ppm-nav-panel .pn-head .pn-s{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,.6);margin-top:3px;}
  #ppm-nav-panel .pn-x{background:0;border:0;color:#fff;font-size:22px;cursor:pointer;line-height:1;}
  #ppm-nav-list{overflow-y:auto;padding:8px 0 24px;}
  #ppm-nav-list .pn-grp{font-size:9.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#9aa0aa;padding:16px 22px 5px;}
  #ppm-nav-list a{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 22px;color:${NAVY};text-decoration:none;font-size:14px;font-weight:600;border-left:3px solid transparent;}
  #ppm-nav-list a:hover{background:#f4f2ef;}
  #ppm-nav-list a.here{border-left-color:${TEAL};background:#f0efec;color:${TEAL};}
  #ppm-nav-list a.here::after{content:'●';color:${TEAL};font-size:9px;}
  #ppm-nav-search{padding:12px 16px 4px;}
  #ppm-nav-search input{width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid rgba(37,39,58,.25);font-size:13px;font-family:inherit;outline:none;}
  #ppm-nav-search input:focus{border-color:${TEAL};}
  #ppm-nav-list .pn-grp.pn-docs{border-top:1px solid rgba(37,39,58,.12);margin-top:12px;padding-top:16px;}
  #ppm-nav-list a.pn-doc{font-weight:500;font-size:13px;color:#6a707c;}
  #ppm-nav-list .pn-note{font-size:8.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#8a6d00;background:#fdf3d7;padding:3px 7px;flex:none;}
  @media print{#ppm-nav-btn,#ppm-nav-ov,#ppm-nav-panel{display:none!important;}}
  `;

  function build() {
    if (document.getElementById('ppm-nav-btn')) return;
    const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'ppm-nav-btn'; btn.setAttribute('aria-label', 'Open menu');
    btn.innerHTML = '<span></span><span></span><span></span>';
    const ov = document.createElement('div'); ov.id = 'ppm-nav-ov';
    const panel = document.createElement('nav'); panel.id = 'ppm-nav-panel';

    const groups = [...new Set(LINKS.map(l => l.group))];
    let inner = `<div class="pn-head"><div><div class="pn-t">PPM · Fee &amp; Revenue System</div><div class="pn-s">Navigate</div></div><button class="pn-x" aria-label="Close">×</button></div>
      <div id="ppm-nav-search"><input type="search" placeholder="Jump to a tool… (type to filter)" aria-label="Filter tools"></div><div id="ppm-nav-list">`;
    groups.forEach(g => {
      inner += `<div class="pn-grp${g === 'Docs' ? ' pn-docs' : ''}">${g}</div>`;
      LINKS.filter(l => l.group === g).forEach(l => {
        const cur = l.href.toLowerCase() === here ? ' here' : '';
        inner += `<a href="${l.href}" data-admin="${l.admin ? 1 : 0}" class="${(g === 'Docs' ? 'pn-doc' : '') + cur}">${l.label}${l.note ? `<span class="pn-note">${l.note}</span>` : ''}</a>`;
      });
    });
    inner += `</div>`;
    panel.innerHTML = inner;

    document.body.appendChild(btn); document.body.appendChild(ov); document.body.appendChild(panel);
    const search = panel.querySelector('#ppm-nav-search input');
    const open = () => { ov.classList.add('open'); panel.classList.add('open'); search.value = ''; applyFilter(); setTimeout(() => search.focus(), 220); };
    const close = () => { ov.classList.remove('open'); panel.classList.remove('open'); };
    btn.addEventListener('click', open);
    ov.addEventListener('click', close);
    panel.querySelector('.pn-x').addEventListener('click', close);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

    // Quick-search: filter links as you type; groups hide when emptied; Enter
    // opens the single remaining match.
    function applyFilter() {
      const q = search.value.trim().toLowerCase();
      panel.querySelectorAll('#ppm-nav-list a').forEach(a => {
        const hidden = a.dataset.roleHidden === '1' || (q && !a.textContent.toLowerCase().includes(q));
        a.style.display = hidden ? 'none' : '';
      });
      panel.querySelectorAll('.pn-grp').forEach(h => {
        let el = h.nextElementSibling, any = false;
        while (el && !el.classList.contains('pn-grp')) { if (el.tagName === 'A' && el.style.display !== 'none') any = true; el = el.nextElementSibling; }
        h.style.display = any ? '' : 'none';
      });
    }
    search.addEventListener('input', applyFilter);
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const vis = [...panel.querySelectorAll('#ppm-nav-list a')].filter(a => a.style.display !== 'none');
      if (vis.length === 1) location.href = vis[0].href;
    });

    // Hide admin-only items for non-admins once identity is known.
    function applyRole() {
      try {
        const S = window.UFC_Store; if (!S || !S.getCurrentUser) return;
        const admin = S.isAdmin(S.getCurrentUser());
        panel.querySelectorAll('a[data-admin="1"]').forEach(a => { a.dataset.roleHidden = admin ? '0' : '1'; });
        applyFilter();
      } catch (e) {}
    }
    if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(applyRole); else applyRole();
  }

  if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
})();
