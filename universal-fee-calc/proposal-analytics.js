/* ============================================================
   SAVILLS PPM · Proposal Analytics
   ------------------------------------------------------------
   Proposal-process intelligence (NOT revenue forecasting):
     • Funnel KPIs  — count, avg fee, avg discount, hit rate,
                      avg duration, avg revisions.
     • Win / loss   — hit rate by deal size + "why we lose".
     • Discounting  — average discount sliced by client / leader /
                      industry / project type / deal size.
   Reads live from the project store (leader-scoped via
   visibleProjects). Change orders are excluded — they're
   amendments, not proposals.
   ============================================================ */
(function () {
  'use strict';
  const STORE = window.UFC_Store;
  const CATALOG = window.RATES_CATALOG;
  const $ = (s, r = document) => (r || document).querySelector(s);
  const esc = window.UFC_UI.esc;
  const fmt = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString();
  const fmtK = (n) => { const a = Math.abs(n); if (a >= 1e6) return (n < 0 ? '-' : '') + '$' + (a / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return (n < 0 ? '-' : '') + '$' + Math.round(a / 1e3) + 'K'; return fmt(n); };
  const pct = (n) => (n == null ? '—' : (Math.round(n * 10) / 10).toFixed(1) + '%');

  let discSlice = 'client';
  let ROWS = [];

  /* Fee resolver — mirrors Projects Index (imported records carry $ in the monthly series). */
  function projectFee(p) {
    if (p.source && p.source.importedByMonth && !(p.source && p.source.reconciled)) {
      const series = STORE.monthlySeries(p, CATALOG) || [];
      const net = series.reduce((a, s) => a + (s.amount || 0), 0);
      return { gross: net, net };
    }
    return STORE.projectFinancials(p, r => STORE.getTierRateFromCatalog(r, CATALOG, p));
  }

  const SIZE_BANDS = [
    { key: '< $500K', test: (v) => v < 5e5 },
    { key: '$500K–1M', test: (v) => v >= 5e5 && v < 1e6 },
    { key: '$1M–3M', test: (v) => v >= 1e6 && v < 3e6 },
    { key: '$3M–5M', test: (v) => v >= 3e6 && v < 5e6 },
    { key: '$5M+', test: (v) => v >= 5e6 },
  ];
  const sizeBand = (v) => (SIZE_BANDS.find(b => b.test(v)) || SIZE_BANDS[SIZE_BANDS.length - 1]).key;

  function durationDays(p) {
    const start = Date.parse(p.project?.firstProposalDate || p.createdAt || '');
    const status = p.project?.status;
    let end;
    if (STORE.BOOKED_STATUSES.has(status)) end = Date.parse(p.project?.signedContractDate || p.updatedAt || '');
    else if (status === 'lost') end = Date.parse(p.updatedAt || '');
    else end = Date.now();
    if (!isFinite(start) || !isFinite(end) || end < start) return null;
    return Math.round((end - start) / 86400000);
  }

  function prep() {
    const all = STORE.visibleProjects(STORE.listProjects());
    ROWS = all.filter(p => !STORE.isChangeOrder(p)).map(p => {
      const pj = p.project || {};
      const fin = projectFee(p);
      const leader = STORE.resolveLeader(pj.leadId || pj.lead);
      return {
        p, id: p.id,
        name: pj.name || '(untitled)',
        client: pj.client || '—',
        leader: leader ? leader.displayName : '—',
        industry: pj.industry || '—',
        ptype: pj.projectType || '—',
        status: pj.status || 'draft',
        rating: STORE.ratingFor(p),
        fee: fin.net || 0,
        discount: (p.assumptions && p.assumptions.discount) || 0,
        lostReason: pj.lostReason || '',
        revisions: (p.versions || []).length,
        duration: durationDays(p),
        size: sizeBand(fin.net || 0),
      };
    });
  }

  /* ---------- Funnel KPIs ---------- */
  function renderKpis() {
    const n = ROWS.length;
    const won = ROWS.filter(r => STORE.BOOKED_STATUSES.has(r.status));
    const lost = ROWS.filter(r => r.status === 'lost');
    const decided = won.length + lost.length;
    const hit = decided ? won.length / decided * 100 : null;
    const avgFee = n ? ROWS.reduce((a, r) => a + r.fee, 0) / n : 0;
    const discRows = ROWS.filter(r => r.discount > 0);
    const avgDisc = discRows.length ? discRows.reduce((a, r) => a + r.discount, 0) / discRows.length : 0;
    const durRows = ROWS.filter(r => r.duration != null && (STORE.BOOKED_STATUSES.has(r.status) || r.status === 'lost'));
    const avgDur = durRows.length ? Math.round(durRows.reduce((a, r) => a + r.duration, 0) / durRows.length) : null;
    const avgRev = n ? ROWS.reduce((a, r) => a + r.revisions, 0) / n : 0;

    const k = [
      [String(n), 'Proposals', 'change orders excluded'],
      [fmtK(avgFee), 'Avg fee (net)', n + ' priced'],
      [hit == null ? '—' : Math.round(hit) + '%', 'Hit rate', won.length + ' won · ' + lost.length + ' lost'],
      [pct(avgDisc), 'Avg discount', discRows.length + ' discounted'],
      [avgDur == null ? '—' : avgDur + 'd', 'Avg duration', 'proposal → decision'],
      [(Math.round(avgRev * 10) / 10).toString(), 'Avg versions', 'per proposal'],
    ];
    $('#kpis').innerHTML = k.map(x => `<div class="kpi"><b>${x[0]}</b><span>${x[1]}</span><small>${x[2]}</small></div>`).join('');
  }

  /* ---------- Win/loss by size ---------- */
  function renderWinSize() {
    const bands = SIZE_BANDS.map(b => b.key);
    const rows = bands.map(band => {
      const inBand = ROWS.filter(r => r.size === band && (STORE.BOOKED_STATUSES.has(r.status) || r.status === 'lost'));
      const won = inBand.filter(r => r.status !== 'lost').length;
      const lost = inBand.filter(r => r.status === 'lost').length;
      const dec = won + lost;
      return { band, won, lost, dec, hit: dec ? won / dec * 100 : null };
    }).filter(r => r.dec > 0);
    const head = `<thead><tr><th class="l">Deal size</th><th>Won</th><th>Lost</th><th>Hit rate</th><th class="l">&nbsp;</th></tr></thead>`;
    if (!rows.length) { $('#winsize').innerHTML = head + `<tbody><tr><td colspan="5" class="empty">No decided proposals yet (need Won or Lost records).</td></tr></tbody>`; return; }
    const body = rows.map(r => `<tr>
      <td class="l">${r.band}</td><td class="num">${r.won}</td><td class="num">${r.lost}</td>
      <td class="num">${r.hit == null ? '—' : Math.round(r.hit) + '%'}</td>
      <td class="l"><div class="bar win"><i style="width:${r.hit || 0}%"></i></div></td></tr>`).join('');
    const tw = rows.reduce((a, r) => a + r.won, 0), tl = rows.reduce((a, r) => a + r.lost, 0);
    const tot = `<tr class="tot"><td class="l">All</td><td class="num">${tw}</td><td class="num">${tl}</td><td class="num">${tw + tl ? Math.round(tw / (tw + tl) * 100) + '%' : '—'}</td><td></td></tr>`;
    $('#winsize').innerHTML = head + '<tbody>' + body + tot + '</tbody>';
  }

  /* ---------- Why we lose ---------- */
  function renderLossReasons() {
    const lost = ROWS.filter(r => r.status === 'lost');
    const head = `<thead><tr><th class="l">Reason</th><th>Count</th><th>Fee at stake</th><th class="l">&nbsp;</th></tr></thead>`;
    if (!lost.length) { $('#lossreasons').innerHTML = head + `<tbody><tr><td colspan="4" class="empty">No lost proposals recorded.</td></tr></tbody>`; return; }
    const by = {};
    lost.forEach(r => { const k = r.lostReason || 'Not recorded'; (by[k] = by[k] || { n: 0, fee: 0 }); by[k].n++; by[k].fee += r.fee; });
    const arr = Object.entries(by).map(([k, v]) => ({ k, ...v })).sort((a, b) => b.n - a.n);
    const maxN = Math.max(...arr.map(a => a.n));
    const body = arr.map(r => `<tr class="lr-row">
      <td class="l"><b>${esc(r.k)}</b></td><td class="num">${r.n}</td><td class="num">${fmtK(r.fee)}</td>
      <td class="l"><div class="bar loss"><i style="width:${r.n / maxN * 100}%"></i></div></td></tr>`).join('');
    const tot = `<tr class="tot"><td class="l">All lost</td><td class="num">${lost.length}</td><td class="num">${fmtK(lost.reduce((a, r) => a + r.fee, 0))}</td><td></td></tr>`;
    $('#lossreasons').innerHTML = head + '<tbody>' + body + tot + '</tbody>';
  }

  /* ---------- Discount analytics ---------- */
  function renderDiscount() {
    const keyOf = (r) => r[discSlice];
    const by = {};
    ROWS.forEach(r => {
      const k = keyOf(r) || '—';
      (by[k] = by[k] || { n: 0, disc: 0, discN: 0, fee: 0 });
      by[k].n++; by[k].fee += r.fee;
      if (r.discount > 0) { by[k].disc += r.discount; by[k].discN++; }
    });
    let arr = Object.entries(by).map(([k, v]) => ({
      k, n: v.n, fee: v.fee,
      avgDisc: v.discN ? v.disc / v.discN : 0,
      discShare: v.n ? v.discN / v.n * 100 : 0,
    }));
    // size band: keep canonical order; else sort by avg discount desc
    if (discSlice === 'size') arr.sort((a, b) => SIZE_BANDS.findIndex(s => s.key === a.k) - SIZE_BANDS.findIndex(s => s.key === b.k));
    else arr.sort((a, b) => b.avgDisc - a.avgDisc);
    const maxD = Math.max(0.0001, ...arr.map(a => a.avgDisc));
    const label = { client: 'Client', leader: 'Revenue leader', industry: 'Industry', ptype: 'Project type', size: 'Deal size' }[discSlice];
    const head = `<thead><tr><th class="l">${label}</th><th># props</th><th>Avg discount</th><th>% discounted</th><th>Fee (net)</th><th class="l">&nbsp;</th></tr></thead>`;
    if (!arr.length) { $('#disctable').innerHTML = head + `<tbody><tr><td colspan="6" class="empty">No proposals in scope.</td></tr></tbody>`; return; }
    const body = arr.map(r => `<tr>
      <td class="l">${esc(r.k)}</td>
      <td class="num">${r.n}</td>
      <td class="num">${r.avgDisc > 0 ? pct(r.avgDisc) : '—'}</td>
      <td class="num">${Math.round(r.discShare)}%</td>
      <td class="num">${fmtK(r.fee)}</td>
      <td class="l"><div class="bar disc"><i style="width:${r.avgDisc / maxD * 100}%"></i></div></td></tr>`).join('');
    $('#disctable').innerHTML = head + '<tbody>' + body + '</tbody>';
  }

  /* ---------- Proposal health ---------- */
  // "Live" = not yet decided dead/closed; the proposals worth triaging.
  function liveForHealth() {
    return ROWS.filter(r => !STORE.ENDED_STATUSES.has(r.status));
  }
  function renderHealth() {
    const live = liveForHealth().map(r => ({ r, h: STORE.proposalHealth(r.p, r.fee) }));
    const counts = { green: 0, yellow: 0, red: 0 };
    live.forEach(x => counts[x.h.band]++);
    $('#health-dist').innerHTML = `
      <div class="hd green"><b>${counts.green}</b><span>🟢 Healthy</span></div>
      <div class="hd yellow"><b>${counts.yellow}</b><span>🟡 Needs review</span></div>
      <div class="hd red"><b>${counts.red}</b><span>🔴 Exec review</span></div>`;
    const watch = live.filter(x => x.h.band !== 'green').sort((a, b) => a.h.score - b.h.score).slice(0, 10);
    const head = `<thead><tr><th class="l">Proposal</th><th class="l">Client</th><th>Fee</th><th>Score</th><th class="l">Top flag</th></tr></thead>`;
    if (!watch.length) { $('#health-watch').innerHTML = head + `<tbody><tr><td colspan="5" class="empty">All live proposals are healthy. 🟢</td></tr></tbody>`; return; }
    const body = watch.map(x => {
      const worst = x.h.signals.slice().sort((a, b) => a.score - b.score)[0];
      return `<tr>
        <td class="l">${esc(x.r.name)}</td>
        <td class="l">${esc(x.r.client)}</td>
        <td class="num">${fmtK(x.r.fee)}</td>
        <td class="num"><span class="score-pill ${x.h.band}">${x.h.score}</span></td>
        <td class="l">${esc(worst.label)} <span style="color:#9aa0aa">(${esc(worst.detail)})</span></td></tr>`;
    }).join('');
    $('#health-watch').innerHTML = head + '<tbody>' + body + '</tbody>';
  }

  /* ---------- Client profile ---------- */
  function populateClients() {
    const sel = $('#client-sel');
    const clients = [...new Set(ROWS.map(r => r.client).filter(c => c && c !== '—'))].sort();
    const cur = sel.value;
    sel.innerHTML = clients.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    if (cur && clients.includes(cur)) sel.value = cur;
  }
  function renderClientProfile() {
    const host = $('#client-profile');
    const sel = $('#client-sel');
    const client = sel.value;
    if (!client) { host.innerHTML = '<div class="empty">No clients in scope.</div>'; return; }
    const rows = ROWS.filter(r => r.client === client);
    const won = rows.filter(r => STORE.BOOKED_STATUSES.has(r.status));
    const lost = rows.filter(r => r.status === 'lost');
    const dec = won.length + lost.length;
    const hit = dec ? Math.round(won.length / dec * 100) + '%' : '—';
    const totalFee = rows.reduce((a, r) => a + r.fee, 0);
    const wonFee = won.reduce((a, r) => a + r.fee, 0);
    const discRows = rows.filter(r => r.discount > 0);
    const avgDisc = discRows.length ? discRows.reduce((a, r) => a + r.discount, 0) / discRows.length : 0;
    const leaders = [...new Set(rows.map(r => r.leader).filter(l => l && l !== '—'))];
    const list = rows.slice().sort((a, b) => b.fee - a.fee).map(r => {
      const h = STORE.proposalHealth(r.p, r.fee);
      return `<tr>
        <td class="l">${esc(r.name)}</td>
        <td class="l">${esc(STORE.STATUS_LABELS[r.status] || r.status)}</td>
        <td class="num">${fmtK(r.fee)}</td>
        <td class="num">${r.discount > 0 ? pct(r.discount) : '—'}</td>
        <td class="num"><span class="score-pill ${h.band}">${h.score}</span></td></tr>`;
    }).join('');
    host.innerHTML = `
      <div class="cp-kpis">
        <div class="k"><b>${rows.length}</b><span>Proposals</span></div>
        <div class="k"><b>${hit}</b><span>Hit rate</span></div>
        <div class="k"><b>${fmtK(wonFee)}</b><span>Won fee</span></div>
        <div class="k"><b>${avgDisc > 0 ? pct(avgDisc) : '—'}</b><span>Avg discount</span></div>
      </div>
      <div class="cp-rel">Relationship: <b>${leaders.length ? esc(leaders.join(', ')) : '—'}</b> · ${fmtK(totalFee)} total proposed across ${rows.length}</div>
      <table class="an"><thead><tr><th class="l">Proposal</th><th class="l">Status</th><th>Fee</th><th>Disc.</th><th>Health</th></tr></thead><tbody>${list}</tbody></table>`;
  }

  function renderAll() { prep(); renderKpis(); renderWinSize(); renderLossReasons(); renderDiscount(); renderHealth(); populateClients(); renderClientProfile(); }

  function ready() {
    const me = STORE.getCurrentUser();
    if (!me || !me.username) {
      $('#gate').hidden = false;
      $('#gate').innerHTML = '<div style="font-family:var(--font-display);font-size:20px;font-weight:800;">Sign in required</div><p style="color:#79828C;font-size:13px;">Proposal Analytics needs a signed-in Box identity.</p>';
      return;
    }
    $('#body').hidden = false;
    if (!STORE.seesAllProjects()) {
      $('#scope-sub').textContent = 'Your proposals only — funnel, win/loss, and discounting. Change orders excluded.';
    }
    $('#disc-slice').addEventListener('click', e => {
      const b = e.target.closest('button[data-slice]'); if (!b) return;
      discSlice = b.dataset.slice;
      [...document.querySelectorAll('#disc-slice button')].forEach(x => x.classList.toggle('on', x.dataset.slice === discSlice));
      renderDiscount();
    });
    $('#client-sel').addEventListener('change', renderClientProfile);
    renderAll();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(ready);
    else ready();
  });
})();
