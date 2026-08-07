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
  // Every tool in the system, in order of importance and daily use.
  // `admin:true` = only show to admins. `desc` = the mouseover explanation.
  // `cta:true` = the yellow "start here" action. `sub:'…'` = rendered under
  // an indented sub-heading inside its group (rarely-used one-time tools).
  const LINKS = [
    // ── Projects — the daily loop for every revenue leader ──
    { href: 'Projects Index.html',           label: 'Projects Index',      group: 'Projects',
      desc: 'Every proposal and project in one place — search, filter, and open.' },
    { href: 'Universal Fee Calculator.html', label: '+ New Project',       group: 'Projects', cta: true,
      desc: 'Start a new fee proposal in the Fee Calculator — team, rates, phases, monthly schedule.' },
    { href: 'Revenue Projections.html',      label: 'Revenue Projections', group: 'Projects',
      desc: 'Monthly revenue outlook across the whole portfolio — booked plus probability-weighted pipeline.' },
    { href: 'Benchmarking Dashboard.html',   label: 'Benchmarking',        group: 'Projects',
      desc: 'Compare proposals against each other — fee levels, team shapes, and pricing patterns.' },
    { href: 'Proposal Analytics.html',       label: 'Proposal Analytics',  group: 'Projects',
      desc: 'Pipeline and win/loss analytics — where proposals come from and why we win or lose.' },
    // ── Operations — running the business (admin) ──
    { href: 'Staffing Matrix.html',          label: 'Staffing & Bandwidth', group: 'Operations', admin: true,
      desc: 'Who is working on what and how loaded they are — allocations, bandwidth, and contract-vs-staffing checks.' },
    { href: 'Revenue Studio.html',           label: 'Revenue Studio',      group: 'Operations', admin: true,
      desc: 'Slice, compare, and shape revenue against frozen baselines — without touching project data.' },
    { href: 'Profitability.html',            label: 'Profitability Analysis', group: 'Operations', admin: true,
      desc: 'Revenue with Clockify burn (hours × cost rate) laid against it — margin per project, per month.' },
    { href: 'Data Entry Status.html',        label: 'Data Entry Status',   group: 'Operations', admin: true,
      desc: 'Completeness tracker — projects by revenue leader, with the fields still missing.' },
    // ── Data Admin — keeping the data right (admin) ──
    { href: 'Change Log.html',               label: 'Change Log',          group: 'Data Admin', admin: true,
      desc: 'Who changed what, and when — every create, edit, status change, and deletion across the system.' },
    { href: 'Ingestion Studio.html',         label: 'Ingestion Studio',    group: 'Data Admin', admin: true,
      desc: 'Paste or upload proposal documents and map them into project records.' },
    { href: 'Import Small Works.html',       label: 'Import Small Works',  group: 'Data Admin', admin: true, sub: 'Migration / One-Time Tools',
      desc: 'One-time import of the small-works project book.' },
    { href: 'Data Repair.html',              label: 'Data Repair',         group: 'Data Admin', admin: true, sub: 'Migration / One-Time Tools',
      desc: 'Scan-and-fix for known data damage — duplicates, stale renames, sparse months. Preview first, then repair.' },
    { href: 'Ingestion Studio.html?mode=bulk', label: 'Import Revenues',   group: 'Data Admin', admin: true, sub: 'Migration / One-Time Tools',
      desc: 'Bulk-import the legacy revenue projection sheet, with a diff to review before anything lands.' },
    { href: 'Rate Grid Reconciliation.html', label: 'Rate Reconciliation', group: 'Data Admin', admin: true, sub: 'Migration / One-Time Tools',
      desc: 'Dry-run a new rate grid against every project to see what would change before committing it.' },
    // ── Help ──
    { href: 'Getting Started.html',          label: 'Getting Started',     group: 'Help',
      desc: 'The 5-minute orientation — how the tools fit together and what you are expected to keep current.' },
    { href: 'Maintainers Runbook.html',      label: 'Maintainer’s Runbook', group: 'Help',
      desc: 'Deep technical reference — architecture, data flow, and the exact fee math.' },
    { href: 'Enterprise Migration Guide.html', label: 'Migration Guide',   group: 'Help',
      desc: 'How to move the system from Box + static pages onto enterprise infrastructure.' },
    { href: 'Fee System Roadmap.html',       label: 'Development Roadmap', group: 'Help',
      desc: 'Where the tool is going — what has shipped, what is in progress, and what is planned.' },
  ];
  const ADMIN_GROUPS = ['Operations', 'Data Admin'];
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
  #ppm-nav-panel .pn-head a.pn-home{color:inherit;text-decoration:none;display:block;}
  #ppm-nav-panel .pn-head a.pn-home:hover .pn-t{color:${YEL};}
  #ppm-nav-panel .pn-head .pn-t{font-weight:800;font-size:14px;letter-spacing:.04em;}
  #ppm-nav-panel .pn-head .pn-s{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,.6);margin-top:3px;}
  #ppm-nav-panel .pn-x{background:0;border:0;color:#fff;font-size:22px;cursor:pointer;line-height:1;}
  #ppm-nav-list{overflow-y:auto;padding:8px 0 24px;}
  #ppm-nav-list .pn-grp{font-size:9.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#9aa0aa;padding:16px 22px 5px;display:flex;align-items:center;gap:8px;}
  #ppm-nav-list .pn-grp .pn-adm{font-size:8px;font-weight:800;letter-spacing:.1em;color:#8a6d00;background:#fdf3d7;padding:2px 6px;}
  #ppm-nav-list .pn-grp.pn-subgrp{font-size:8.5px;color:#b3b8c2;padding:12px 22px 3px 34px;}
  #ppm-nav-list a{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 22px;color:${NAVY};text-decoration:none;font-size:14px;font-weight:600;border-left:3px solid transparent;}
  #ppm-nav-list a:hover{background:#f4f2ef;}
  #ppm-nav-list a.here{border-left-color:${TEAL};background:#f0efec;color:${TEAL};}
  #ppm-nav-list a.here::after{content:'●';color:${TEAL};font-size:9px;}
  #ppm-nav-list a.pn-sub{padding-left:34px;font-weight:500;font-size:13px;color:#5a6070;}
  #ppm-nav-list a.pn-cta{margin:6px 22px 4px;padding:11px 16px;background:${YEL};color:${NAVY};font-weight:800;letter-spacing:.03em;border-left:0;justify-content:center;}
  #ppm-nav-list a.pn-cta:hover{background:#ffe94d;}
  #ppm-nav-list a.pn-cta.here{background:${YEL};color:${NAVY};}
  #ppm-nav-list a.pn-cta.here::after{content:'';}
  #ppm-nav-search{padding:12px 16px 4px;}
  #ppm-nav-search input{width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid rgba(37,39,58,.25);font-size:13px;font-family:inherit;outline:none;}
  #ppm-nav-search input:focus{border-color:${TEAL};}
  #ppm-nav-list .pn-grp.pn-docs{border-top:1px solid rgba(37,39,58,.12);margin-top:12px;padding-top:16px;}
  #ppm-nav-list a.pn-doc{font-weight:500;font-size:13px;color:#6a707c;}
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
    let inner = `<div class="pn-head"><a class="pn-home" href="Fee Generator.html" title="Home — the Fee &amp; Revenue System landing page"><div class="pn-t">PPM · Fee &amp; Revenue System</div><div class="pn-s">Navigate</div></a><button class="pn-x" aria-label="Close">×</button></div>
      <div id="ppm-nav-search"><input type="search" placeholder="Jump to a tool… (type to filter)" aria-label="Filter tools"></div><div id="ppm-nav-list">`;
    groups.forEach(g => {
      const adminGrp = ADMIN_GROUPS.includes(g);
      inner += `<div class="pn-grp${g === 'Help' ? ' pn-docs' : ''}"${adminGrp ? ' data-admin="1"' : ''}>${g}${adminGrp ? '<span class="pn-adm">admin only</span>' : ''}</div>`;
      let subShown = null;
      LINKS.filter(l => l.group === g).forEach(l => {
        if (l.sub && l.sub !== subShown) {
          subShown = l.sub;
          inner += `<div class="pn-grp pn-subgrp" data-admin="${l.admin ? 1 : 0}">${l.sub}</div>`;
        }
        const cur = l.href.toLowerCase() === here ? ' here' : '';
        const cls = (g === 'Help' ? 'pn-doc ' : '') + (l.sub ? 'pn-sub ' : '') + (l.cta ? 'pn-cta ' : '');
        inner += `<a href="${l.href}" data-admin="${l.admin ? 1 : 0}" class="${(cls + cur).trim()}" title="${l.desc || ''}">${l.label}</a>`;
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
        // A sub-heading owns links until the NEXT heading of any kind; a main
        // group heading owns everything (incl. sub-headings' links) until the
        // next MAIN heading — so filtering can't strand either kind of header.
        const isSub = h.classList.contains('pn-subgrp');
        let el = h.nextElementSibling, any = false;
        while (el && !(el.classList.contains('pn-grp') && (isSub || !el.classList.contains('pn-subgrp')))) {
          if (el.tagName === 'A' && el.style.display !== 'none') any = true;
          el = el.nextElementSibling;
        }
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
