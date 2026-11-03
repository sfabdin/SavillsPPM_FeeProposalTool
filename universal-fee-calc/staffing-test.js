/* ============================================================
   SAVILLS PPM · STAFFING & BANDWIDTH (TEST) — the shell
   ------------------------------------------------------------
   The same module as the Staffing Matrix page (staffing-page.js renders
   every view, unchanged), put in the order the work happens:

     1 · Allocations   enter — who is on what, at what percent, when
     2 · Staffing      see   — by project, by person
     3 · Tracking      check — Compare, Insights, Clockify Reporting

   The dates stay up top; the data (freshness, Data Sources, Mapping) and
   the settings that are set once sit in a bar under them. The original
   tab row is still in the DOM, hidden: a tile or an inner tab here just
   clicks the matching tab there, so every goto link and remembered state
   keeps working. A revenue leader gets the same three tiles, scoped to
   their team (staffing-page.js 'team' view).
   ============================================================ */
(function () {
  'use strict';
  const $ = (q, el) => (el || document).querySelector(q), $$ = (q, el) => Array.from((el || document).querySelectorAll(q));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const S = () => window.UFC_Staff, H = () => window.__UFC_STAFF_HOOKS__ || {};
  const KEY = 'ufc_staff_test_v1';
  const TILES = [
    { id: 'allocations', n: '1', label: 'Allocations', tag: 'Enter · who is on what, at what percent, from when to when.', tabs: [['allocations', 'Allocations']] },
    { id: 'staffing', n: '2', label: 'Staffing', tag: 'See · who is free, who is drowning, by project and by person.', tabs: [['projects', 'By Project'], ['people', 'By Person']] },
    { id: 'tracking', n: '3', label: 'Tracking', tag: 'Check · did reality follow the plan: the contract, Clockify, the insights.', tabs: [['actuals', 'Compare · Plan / Contract / Actual'], ['insights', 'Insights'], ['compliance', 'Clockify Reporting']] },
  ];
  const DATA = { sources: 'Data Sources', mapping: 'Mapping' };
  const activeTab = () => { const t = $('#tabs .tab.active'); return t ? t.dataset.tab : ''; };
  const tileOf = (tab) => TILES.find(t => t.tabs.some(x => x[0] === tab)) || null;
  function go(tab) { const b = $('#tabs .tab[data-tab="' + tab + '"]'); if (b) b.click(); }
  const remember = (tab) => { try { localStorage.setItem(KEY, JSON.stringify({ tab })); } catch (e) {} };
  const remembered = () => { try { return (JSON.parse(localStorage.getItem(KEY) || '{}') || {}).tab || ''; } catch (e) { return ''; } };

  /* The numbers on each tile: what the view will show, before scrolling to it. */
  function summary(tile) {
    const St = S(); if (!St) return [];
    try {
      if (tile.id === 'allocations') {
        const al = St.listAllocations().filter(a => St.inView(a.personId));
        const ppl = new Set(al.map(a => a.personId)).size, pj = new Set(al.map(a => a.feeId || a.internal || a.project)).size, purs = al.filter(a => a.status === 'Pursuit' || a.type === 'Opportunity').length;
        return [[al.length, 'rows'], [ppl, 'people'], [pj, 'projects'], [purs, 'pursuit rows']];
      }
      if (tile.id === 'staffing') {
        const ppl = St.listPeople().filter(p => St.inView(p) && p.active !== false && !p.isPool); const ym = St.currentYM(); let over = 0, free = 0;
        ppl.forEach(p => { const l = St.personLoad(p.id, ym); if (l > 110) over++; else if (l < 50) free++; });
        return [[ppl.length, 'people'], [over, 'over 110% this month'], [free, 'under 50% this month']];
      }
      if (tile.id === 'tracking') {
        const am = St.actualsMeta ? St.actualsMeta() : {}; const d = am.importedAt ? Math.floor((Date.now() - new Date(am.importedAt)) / 86400000) : null;
        return [[d == null ? '—' : d + 'd', 'since the Clockify pull'], [am.rows ? am.rows.toLocaleString() : '—', 'hour rows'], [St.hasActuals && St.hasActuals() ? '③' : '—', 'actuals loaded']];
      }
    } catch (e) { console.warn('tile summary', e); }
    return [];
  }
  function render() {
    const host = $('#st-tiles'), sub = $('#st-subtabs'); if (!host || !sub) return;
    const cur = activeTab(); const tile = tileOf(cur);
    host.innerHTML = TILES.map(t => '<button type="button" class="st-tile' + (tile && tile.id === t.id ? ' on' : '') + '" data-tile="' + t.id + '"><span class="st-n">' + t.n + '</span><span class="st-body"><b>' + esc(t.label) + '</b><small>' + esc(t.tag) + '</small><span class="st-sum">' + summary(t).map(([v, l]) => '<span><b>' + esc(v) + '</b> ' + esc(l) + '</span>').join('') + '</span></span></button>').join('');
    if (tile) sub.innerHTML = (tile.tabs.length > 1 ? tile.tabs.map(([k, l]) => { const o = $('#tabs .tab[data-tab="' + k + '"] .cnt'); return '<button type="button" class="tab' + (k === cur ? ' active' : '') + '" data-go="' + k + '">' + esc(l) + (o && o.textContent ? ' <span class="cnt">' + esc(o.textContent) + '</span>' : '') + '</button>'; }).join('') : '') ;
    else if (DATA[cur]) sub.innerHTML = '<span class="st-crumb">Data · <b>' + esc(DATA[cur]) + '</b></span><button type="button" class="tab" data-go="' + (remembered() && tileOf(remembered()) ? remembered() : 'allocations') + '">← Back to the views</button>';
    else sub.innerHTML = '';
    sub.hidden = !sub.innerHTML;
    $$('[data-tile]', host).forEach(b => b.onclick = () => { const t = TILES.find(x => x.id === b.dataset.tile); const last = remembered(); go(t.tabs.some(x => x[0] === last) ? last : t.tabs[0][0]); });
    $$('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  }
  function wire() {
    // the hidden tab row is the source of truth; mirror it whenever it changes
    const tabs = $('#tabs'); if (!tabs) return;
    new MutationObserver(() => { const t = activeTab(); if (t && !DATA[t]) remember(t); render(); }).observe(tabs, { attributes: true, subtree: true, attributeFilter: ['class'] });
    document.addEventListener('ufc:remote-updated', render);
    // first landing: what was open last time, else the first view in the flow
    const want = remembered() || 'allocations';
    if (activeTab() !== want) go(want); else render();
  }
  function boot() {
    let tries = 0;
    const tick = () => { if (H().state && $('#tabs .tab.active') && $('#win-start option')) { wire(); return; } if (++tries < 400) setTimeout(tick, 100); };
    tick();
  }
  if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(boot, boot); else boot();
  window.UFC_StaffTest = { render, go, TILES };
})();
