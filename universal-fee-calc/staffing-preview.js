/* ============================================================
   SAVILLS PPM · STAFFING & BANDWIDTH — PREVIEW of the redesign
   ------------------------------------------------------------
   Three modes, one question each, read from the live staffing store and
   the live fee book through the same engine the current page uses.
   Nothing here writes: no allocation, mapping, fee record or staff.json
   is touched. The one "action" (the review stamp) lives in this
   browser's localStorage and says so on screen.

     My team    a revenue leader's own work: unplanned, not showing up,
                what the next months need, people on their projects.
     Bandwidth  everyone: load heat by month, a capacity forecast by
                title (supply vs firm demand vs pursuits), an "if we win"
                scenario, who is over the line, who comes free.
     Data room  the health line and a ranked worklist with an owner on
                every item, linking to where it is fixed on the live page.
   ============================================================ */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const S = () => window.UFC_Staff;
  const ST = () => window.UFC_Store;
  const CAT = () => window.RATES_CATALOG;
  const esc = (v) => window.UFC_UI.esc(v);
  const n1 = (v) => (v == null || isNaN(v)) ? '—' : (Math.round(v * 10) / 10).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const n0 = (v) => (v == null || isNaN(v)) ? '—' : Math.round(v).toLocaleString();
  const pct = (v) => (v == null || isNaN(v)) ? '—' : Math.round(v) + '%';
  const money = (v) => (v == null || isNaN(v)) ? '—' : '$' + Math.round(v).toLocaleString();
  const dateS = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(); };
  const ageDays = (iso) => { if (!iso) return null; const d = new Date(iso); return isNaN(d) ? null : Math.floor((Date.now() - d.getTime()) / 86400000); };
  const LIVE = 'Staffing Matrix.html';
  const calcLink = (id) => 'Universal Fee Calculator.html?id=' + encodeURIComponent(id);
  const REVIEW_KEY = 'ufc_staff_preview_review_v1';

  const state = { mode: 'band', horizon: 3, leaderId: '', scen: new Set(), admin: false, me: null, open: new Set(), heatAll: false };
  const HEAT_CAP = 30;

  /* ---------- months ---------- */
  function months() { const out = []; let c = S().currentYM(); for (let i = 0; i < state.horizon; i++) { out.push(c); c = S().ymAdd(c, 1); } return out; }
  const nowYm = () => S().currentYM();
  const lastDone = () => S().ymAdd(nowYm(), -1);
  const shortYm = (ym) => S().ymLabel(ym);

  /* ---------- the fee book, as the staffing engine sees it ---------- */
  function liveRecords() {
    const st = ST();
    return st.listProjects().filter(p => p && p.project
      && !(st.isChangeOrder && st.isChangeOrder(p))
      && !(st.isDeadPursuit && st.isDeadPursuit(p))
      && !(st.isFinished && st.isFinished(p)));
  }
  const isFirm = (p) => /^(won|active)$/.test((p.project || {}).status || '');
  const leaderOf = (p) => { const pj = p.project || {}; return ST().resolveLeader(pj.leadId || pj.lead); };
  const leaderName = (p) => { const l = leaderOf(p); return l ? l.displayName : ((p.project || {}).lead || 'no leader'); };
  const ratingOf = (p) => { const st = ST(); const n = st.ratingFor ? st.ratingFor(p) : 5; return st.ratingMeta ? st.ratingMeta(n) : { n, short: String(n), weight: 0.5 }; };
  const statusLabel = (s) => (ST().STATUS_LABELS || {})[s] || s || '—';
  const isPursuitAlloc = (a) => a.status === 'Pursuit' || a.type === 'Opportunity';

  /** Contract FTE by month per title for one record: { ym: { titleId: fte } }. */
  function recordDemand(p, ms) {
    const st = ST(); const out = {};
    if (!p.roles || !p.roles.length || !p.timeline) return out;
    let byPhase; try { byPhase = st.computeMonthsByPhase(p); } catch (e) { return out; }
    const phaseOf = {}; (p.phases || []).forEach(ph => (byPhase[ph.id] || []).forEach(m => { phaseOf[m.year + '-' + m.month] = ph.id; }));
    const want = new Set(ms);
    st.enumerateMonths(p.timeline).forEach(m => {
      const ym = m.year + '-' + String(m.month).padStart(2, '0'); if (!want.has(ym)) return;
      const mk = m.year + '-' + m.month;
      p.roles.forEach(r => {
        const fte = ((r.fteMonthly && r.fteMonthly[mk] != null) ? r.fteMonthly[mk] : ((r.fte && r.fte[phaseOf[mk]]) || 0)) / 100;
        if (!fte) return;
        const o = out[ym] || (out[ym] = {}); o[r.titleId || 'other'] = (o[r.titleId || 'other'] || 0) + fte;
      });
    });
    return out;
  }
  const sumDemand = (d, ms) => ms.reduce((s, m) => s + Object.values(d[m] || {}).reduce((a, b) => a + b, 0), 0);

  /* ---------- load per person per month under a scenario ---------- */
  function loadMap(ms, scen) {
    const s = S(); const by = {};
    s.listAllocations().forEach(a => {
      if (!a.personId) return;
      if (a.internal === 'leave' || (s.isLeaveProject && s.isLeaveProject(a.project))) return;
      const pursuit = isPursuitAlloc(a);
      if (pursuit && !(scen && a.feeId && scen.has(a.feeId))) return;
      const row = by[a.personId] || (by[a.personId] = { firm: {}, scen: {} });
      ms.forEach(m => { if (!s.allocActiveIn(a, m)) return; const b = pursuit ? row.scen : row.firm; b[m] = (b[m] || 0) + (a.pct || 0); });
    });
    return by;
  }
  function actualMap(ms) {
    const s = S(); const by = {}; if (!s.hasActuals()) return { by, covered: new Set() };
    const covered = new Set((s.actualsMeta().months || []).filter(m => m <= nowYm()));
    s.varianceMatrix(ms, {}).forEach(r => { ms.forEach(m => { const c = r.byMonth[m]; if (!c || !c.a) return; const p = by[r.person.id] || (by[r.person.id] = {}); p[m] = (p[m] || 0) + c.a; }); });
    return { by, covered };
  }
  const band = (v) => !v ? 'u0' : v <= 85 ? 'u1' : v <= 100 ? 'u2' : v <= 120 ? 'u3' : v <= 150 ? 'u4' : 'u5';
  function onLeave(pid, ym) { return (S().leaveStatus() || []).some(l => l.person.id === pid && l.start <= ym && ym <= l.end); }

  /* ---------- pursuits available to the scenario ---------- */
  function pursuitList(ms) {
    const s = S(); const planned = new Set(s.listAllocations().filter(a => a.feeId && isPursuitAlloc(a)).map(a => a.feeId));
    return liveRecords().filter(p => !isFirm(p)).map(p => {
      const d = recordDemand(p, ms); const need = sumDemand(d, ms);
      if (!need && !planned.has(p.id)) return null;
      const r = ratingOf(p);
      return { p, id: p.id, name: p.project.name || 'Untitled', client: p.project.client || '', lead: leaderName(p), rating: r, need, avgFte: ms.length ? need / ms.length : 0, planned: planned.has(p.id) };
    }).filter(Boolean).sort((a, b) => (a.rating.n - b.rating.n) || (b.need - a.need));
  }

  /* ============================================================
     BANDWIDTH
     ============================================================ */
  function renderBand() {
    const s = S(), ms = months(), now = nowYm();
    const people = s.listPeople().filter(p => s.inView(p) && p.active !== false && !p.isPool);
    const L = loadMap(ms, state.scen); const A = actualMap(ms);
    const rows = people.map(p => {
      const l = L[p.id] || { firm: {}, scen: {} };
      const tot = {}; let peak = 0, sum = 0, n = 0;
      ms.forEach(m => { const v = (l.firm[m] || 0) + (l.scen[m] || 0); tot[m] = v; if (v > peak) peak = v; if (v > 0 || m >= now) { sum += v; n++; } });
      return { p, l, tot, peak, avg: n ? sum / n : 0, leave: ms.some(m => onLeave(p.id, m)) };
    }).filter(r => r.peak > 0 || (A.by[r.p.id] && Object.keys(A.by[r.p.id]).length));
    rows.sort((a, b) => b.peak - a.peak || a.p.name.localeCompare(b.p.name));

    const next = ms[0];
    const over = rows.filter(r => (r.tot[next] || 0) > 110);
    const under = rows.filter(r => !r.p.nonBillable && r.avg > 0 && r.avg < 60 && !r.leave);
    const idle = rows.filter(r => !r.p.nonBillable && r.avg === 0);
    const freeing = s.comingAvailable({ minFreedPct: 25 });
    const gaps = s.contractStaffingGaps().filter(g => !g.dismissed);
    const firmGapProjects = [...new Set(gaps.filter(g => !g.pursuit).map(g => g.feeId))].length;
    const unm = s.unmappedClockify(); const unmH = unm.reduce((t, u) => t + u.hours, 0);

    /* capacity by title */
    const titles = (CAT().titles || []);
    const titleName = (id) => (titles.find(t => t.id === id) || {}).name || (id === 'other' ? 'Unassigned title' : id);
    const supply = {}, dFirm = {}, dW = {}, dScen = {}, dAll = {};
    const add = (o, t, v) => { o[t] = (o[t] || 0) + v; };
    people.forEach(p => {
      if (p.nonBillable) return;
      const fam = s.titleFamily(p.title); const t = fam ? fam.titleId : 'other';
      ms.forEach(m => { if (s.hasLeftBy(p, m) || onLeave(p.id, m)) return; add(supply, t, (p.capacityPct != null ? p.capacityPct : 100) / 100); });
    });
    liveRecords().forEach(p => {
      const d = recordDemand(p, ms); const w = isFirm(p) ? 1 : ratingOf(p).weight;
      ms.forEach(m => Object.entries(d[m] || {}).forEach(([t, fte]) => {
        add(dAll, t, fte);
        if (isFirm(p)) add(dFirm, t, fte); else { add(dW, t, fte * w); if (state.scen.has(p.id)) add(dScen, t, fte); }
      }));
    });
    const nM = ms.length || 1;
    const tIds = titles.map(t => t.id).concat(['other']).filter(id => supply[id] || dFirm[id] || dW[id] || dScen[id]);
    const capRows = tIds.map(id => {
      const sup = (supply[id] || 0) / nM, firm = (dFirm[id] || 0) / nM, w = (dW[id] || 0) / nM, sc = (dScen[id] || 0) / nM;
      const ask = firm + (state.scen.size ? sc : w);
      return { id, name: titleName(id), sup, firm, w, sc, ask, gap: sup - ask };
    }).sort((a, b) => a.gap - b.gap);
    const short = capRows.filter(r => r.gap < -0.5);
    const maxBar = Math.max(1, ...capRows.map(r => Math.max(r.sup, r.ask)));

    const verdict = [
      v(over.length, `<b>over 110%</b> in ${esc(shortYm(next))}${state.scen.size ? ' with the chosen pursuits won' : ''}`, over.length ? 'bad' : 'ok', '#band-heat'),
      v(firmGapProjects, `won or active project${firmGapProjects === 1 ? '' : 's'} with <b>contract roles nobody is planned on</b>`, firmGapProjects ? 'warn' : 'ok', '#band-gaps'),
      v(short.length, `title${short.length === 1 ? '' : 's'} <b>short of people</b> over the horizon${short.length ? ': ' + esc(short.slice(0, 3).map(r => r.name).join(', ')) : ''}`, short.length ? 'bad' : 'ok', '#band-cap'),
      v(under.length + idle.length, `people <b>under 60% planned</b> on average (${idle.length} with nothing)`, (under.length + idle.length) ? 'info' : 'ok', '#band-free'),
      v(freeing.length, `<b>coming free</b> in the next 3 months (25%+ of their month)`, 'info', '#band-free'),
      v(Math.round(unmH), `Clockify hours <b>landing on no project</b>, all time${unm.length ? ', across ' + unm.length + ' names' : ''}`, unmH > 40 ? 'warn' : 'ok', '#p-data'),
    ].join('');

    /* heat */
    const heatShown = state.heatAll ? rows : rows.slice(0, HEAT_CAP);
    const heatRows = heatShown.map(r => {
      const nm = esc(r.p.name); const fam = s.titleFamily(r.p.title);
      const meta = [r.p.title ? esc(r.p.title) : '<span class="muted">no title</span>', r.p.capacityPct != null && r.p.capacityPct < 100 ? `PT ${r.p.capacityPct}%` : '', r.p.nonBillable ? 'internal' : '', r.leave ? 'leave in window' : ''].filter(Boolean).join(' · ');
      const cells = ms.map(m => {
        const vF = r.l.firm[m] || 0, vS = r.l.scen[m] || 0, vT = vF + vS;
        const lv = onLeave(r.p.id, m);
        const act = A.covered.has(m) && A.by[r.p.id] ? Math.round((A.by[r.p.id][m] || 0) / Math.max(s.capacityHours(r.p), 1) * 100) : null;
        const tip = lv ? 'On leave' : `${Math.round(vT)}% planned${vS ? ` (${Math.round(vS)} from pursuits)` : ''}${act != null ? ` · ${act}% logged` : ''}`;
        return `<td class="h ${m === now ? 'today' : ''}"><span class="cell ${lv ? 'nodata' : band(Math.round(vT))} ${vS ? 'ghost' : ''}" title="${esc(tip)}">${lv ? 'leave' : (Math.round(vT) || '·')}${act != null && !lv ? `<div class="muted" style="font-size:9.5px;line-height:1.1;margin-top:1px">${act}</div>` : ''}</span></td>`;
      }).join('');
      const open = state.open.has(r.p.id);
      const drawer = open ? `<tr><td colspan="${ms.length + 3}" class="drawer">${s.listAllocations().filter(a => a.personId === r.p.id && ms.some(m => s.allocActiveIn(a, m))).sort((a, b) => (b.pct || 0) - (a.pct || 0)).map(a => { const d = s.describeKey(s.allocKey(a)); return `<div>${isPursuitAlloc(a) ? '<span class="chip p">pursuit</span> ' : ''}<b>${esc(d.label)}</b>${d.client ? ' · ' + esc(d.client) : ''} · ${a.pct}% · ${esc(shortYm(a.start))}–${a.end ? esc(shortYm(a.end)) : 'open'}${a.updatedBy ? ` <span class="muted">· ${esc(a.updatedBy.split('@')[0])} ${dateS(a.updatedAt)}</span>` : ''}</div>`; }).join('') || '<div class="muted">No allocations in this window.</div>'}</td></tr>` : '';
      return `<tr data-open="${esc(r.p.id)}" style="cursor:pointer"><td><div class="tt">${nm}</div><div class="muted">${meta}</div></td>${cells}<td class="num ${r.peak > 110 ? 'tt' : ''}" style="${r.peak > 110 ? 'color:var(--bad)' : ''}">${Math.round(r.peak)}%</td><td class="num">${Math.round(r.avg)}%</td></tr>${drawer}`;
    }).join('');

    /* scenario */
    const purs = pursuitList(ms);
    const scenHtml = purs.length ? `<div class="scen">${purs.map(x => `<label><input type="checkbox" data-scen="${esc(x.id)}" ${state.scen.has(x.id) ? 'checked' : ''}><span><b>${esc(x.name)}</b> <span class="muted">· ${esc(x.client)} · ${esc(x.lead)} · ${esc(x.rating.short)}</span></span><span class="muted">${n1(x.avgFte)} FTE${x.planned ? ' · people named' : ''}</span></label>`).join('')}</div>` : '<div class="empty">No pursuits carry staffing in this horizon.</div>';

    /* free + over lists */
    const overRows = over.slice(0, 12).map(r => `<tr><td class="tt">${esc(r.p.name)}<div class="muted">${esc(r.p.title || '')}</div></td><td class="num" style="color:var(--bad);font-weight:700">${Math.round(r.tot[next])}%</td><td class="num">${ms.filter(m => r.tot[m] > 100).length} of ${ms.length}</td><td class="muted">${esc(topProjects(r.p.id, next))}</td></tr>`).join('');
    const freeRows = freeing.map(f => `<tr><td class="tt">${esc(f.person.name)}<div class="muted">${esc(f.person.title || '')}</div></td><td class="num">${Math.round(f.cur)}%</td><td class="num" style="color:var(--ok);font-weight:700">${Math.round(f.to)}%</td><td class="num">${Math.round(f.freedPct)}%</td><td>${esc(shortYm(f.m))}</td></tr>`).join('');
    const underRows = under.concat(idle).sort((a, b) => a.avg - b.avg).slice(0, 12).map(r => `<tr><td class="tt">${esc(r.p.name)}<div class="muted">${esc(r.p.title || '')}</div></td><td class="num">${Math.round(r.avg)}%</td><td class="muted">${r.avg ? esc(topProjects(r.p.id, next)) : 'nothing planned'}</td></tr>`).join('');

    /* gaps */
    const gapGroups = {}; gaps.filter(g => !g.pursuit).forEach(g => { const k = g.feeId; (gapGroups[k] = gapGroups[k] || { name: g.project, client: g.client, lead: g.lead, rows: [] }).rows.push(g); });
    const gapRows = Object.values(gapGroups).sort((a, b) => b.rows.reduce((s2, g) => s2 + g.totalNeedFteMo, 0) - a.rows.reduce((s2, g) => s2 + g.totalNeedFteMo, 0)).slice(0, 12).map(g => `<tr><td class="tt">${esc(g.name)}<div class="muted">${esc(g.client)}</div></td><td>${esc(g.lead || '—')}</td><td>${g.rows.map(r => esc(r.roleTitle) + (r.resource ? ' <span class="muted">(' + esc(r.resource) + ')</span>' : '')).join('<br>')}</td><td class="num">${n1(g.rows.reduce((s2, r) => s2 + r.totalNeedFteMo, 0))}</td></tr>`).join('');

    $('#p-band').innerHTML = `
      <div class="verdict">${verdict}</div>
      <div class="card" id="band-cap">
        <div class="card-head"><h2>Do we have the people?</h2><span class="hint">Average FTE over ${ms.length === 1 ? shortYm(ms[0]) : shortYm(ms[0]) + '–' + shortYm(ms[ms.length - 1])}. Supply is the roster by title, minus leave. Demand is contract FTE from the fee book: firm (won or active) plus ${state.scen.size ? 'the pursuits you ticked below' : 'pursuits weighted by rating'}.</span></div>
        <div class="scroll"><table class="tbl"><thead><tr><th>Title</th><th>Supply vs demand</th><th class="num">People (FTE)</th><th class="num">Firm demand</th><th class="num">${state.scen.size ? 'If won' : 'Weighted pursuits'}</th><th class="num">Gap</th></tr></thead><tbody>
          ${capRows.map(r => `<tr><td class="tt">${esc(r.name)}</td><td><div class="bar2"><i class="s" style="width:${(r.sup / maxBar * 100).toFixed(1)}%"></i><i class="d ${state.scen.size ? 'p' : ''}" style="width:${(r.ask / maxBar * 100).toFixed(1)}%"></i></div></td><td class="num">${n1(r.sup)}</td><td class="num">${n1(r.firm)}</td><td class="num">${n1(state.scen.size ? r.sc : r.w)}</td><td class="num tt" style="color:${r.gap < -0.5 ? 'var(--bad)' : r.gap > 1 ? 'var(--ok)' : 'inherit'}">${r.gap > 0 ? '+' : ''}${n1(r.gap)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No titled people or priced roles in this horizon.</td></tr>'}
        </tbody></table></div>
        <div class="legend"><span><i style="background:var(--sav-teal);opacity:.55"></i>people available</span><span><i style="background:var(--sav-navy);height:6px"></i>demand</span><span>A negative gap is the hiring signal; a large positive one is bench.</span></div>
      </div>
      <div class="card" id="band-scen">
        <div class="card-head"><h2>If we win…</h2><span class="hint">Tick a pursuit to count its staffing as firm everywhere on this page. Rating shown; people already named on it show hatched in the heat map.</span><div class="right">${state.scen.size ? `<button class="btn ghost" id="scen-clear">Clear ${state.scen.size}</button>` : ''}</div></div>
        ${scenHtml}
      </div>
      <div class="card" id="band-heat">
        <div class="card-head"><h2>Who is carrying what.</h2><span class="hint">Planned load by month, heaviest first. Small number = Clockify hours as a share of capacity where we have them. Click a person for their rows.</span></div>
        <div class="scroll"><table class="tbl heat"><thead><tr><th>Person</th>${ms.map(m => `<th class="c ${m === now ? 'today' : ''}">${esc(shortYm(m))}</th>`).join('')}<th class="num">Peak</th><th class="num">Avg</th></tr></thead><tbody>${heatRows || `<tr><td colspan="${ms.length + 3}" class="empty">Nobody is planned in this window.</td></tr>`}</tbody></table></div>
        ${rows.length > HEAT_CAP ? `<div style="margin-top:10px"><button class="btn ghost" id="heat-more">${state.heatAll ? 'Show the heaviest ' + HEAT_CAP : 'Show all ' + rows.length + ' people'}</button></div>` : ''}
        <div class="legend"><span><i class="u1"></i>under 85</span><span><i class="u2"></i>86–100</span><span><i class="u3"></i>101–120</span><span><i class="u4"></i>121–150</span><span><i class="u5"></i>over 150</span><span><i class="cell ghost" style="background:#cfe6e4"></i>includes a ticked pursuit</span><span><i style="box-shadow:inset 2px 0 0 var(--sav-yellow);background:#fff;border:1px solid var(--hair)"></i>this month</span></div>
      </div>
      <div class="card" id="band-gaps">
        <div class="card-head"><h2>Signed work with nobody on it.</h2><span class="hint">Contract roles on won or active projects with no one planned against them. The leader is who to ask.</span><div class="right"><a class="btn ghost" href="${LIVE}">Accept on the live page · Allocations</a></div></div>
        ${gapRows ? `<table class="tbl"><thead><tr><th>Project</th><th>Leader</th><th>Role (named in the contract)</th><th class="num">FTE-months</th></tr></thead><tbody>${gapRows}</tbody></table>` : '<div class="empty">Every signed role has someone planned on it.</div>'}
      </div>
      <div class="card" id="band-free">
        <div class="card-head"><h2>Over the line, and coming free.</h2></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
          <div><div class="sub" style="margin-bottom:8px"><b>Over 110% in ${esc(shortYm(next))}</b></div>${overRows ? `<table class="tbl"><thead><tr><th>Person</th><th class="num">Load</th><th class="num">Months over</th><th>Where</th></tr></thead><tbody>${overRows}</tbody></table>${over.length > 12 ? `<div class="muted" style="margin-top:6px">+${over.length - 12} more in the heat map above</div>` : ''}` : '<div class="empty">Nobody over the line.</div>'}</div>
          <div><div class="sub" style="margin-bottom:8px"><b>Coming free in the next 3 months</b> · pursuits excluded</div>${freeRows ? `<table class="tbl"><thead><tr><th>Person</th><th class="num">Now</th><th class="num">Drops to</th><th class="num">Frees</th><th>When</th></tr></thead><tbody>${freeRows}</tbody></table>` : '<div class="empty">Nobody frees 25% or more.</div>'}
            <div class="sub" style="margin:16px 0 8px"><b>Under 60% on average</b></div>${underRows ? `<table class="tbl"><thead><tr><th>Person</th><th class="num">Avg</th><th>Where</th></tr></thead><tbody>${underRows}</tbody></table>` : '<div class="empty">Everyone is planned above 60%.</div>'}</div>
        </div>
      </div>`;
    $$('#p-band [data-scen]').forEach(cb => cb.addEventListener('change', () => { if (cb.checked) state.scen.add(cb.dataset.scen); else state.scen.delete(cb.dataset.scen); renderBand(); }));
    const hm = $('#heat-more'); if (hm) hm.addEventListener('click', () => { state.heatAll = !state.heatAll; const y = window.scrollY; renderBand(); window.scrollTo(0, y); });
    const clr = $('#scen-clear'); if (clr) clr.addEventListener('click', () => { state.scen.clear(); renderBand(); });
    $$('#p-band tr[data-open]').forEach(tr => tr.addEventListener('click', () => { const id = tr.dataset.open; if (state.open.has(id)) state.open.delete(id); else state.open.add(id); const y = window.scrollY; renderBand(); window.scrollTo(0, y); }));
  }
  function topProjects(pid, ym) {
    const s = S();
    return s.listAllocations().filter(a => a.personId === pid && s.allocActiveIn(a, ym) && !isPursuitAlloc(a)).sort((a, b) => (b.pct || 0) - (a.pct || 0)).slice(0, 3).map(a => s.describeKey(s.allocKey(a)).label + ' ' + a.pct + '%').join(' · ');
  }
  function v(n, text, tone, href) { return `<a class="v ${tone}" href="${href}"><span class="n">${n}</span><span class="t">${text}</span></a>`; }

  /* ============================================================
     MY TEAM
     ============================================================ */
  function leaderChoices() {
    const counts = {}; liveRecords().forEach(p => { const l = leaderOf(p); if (l) counts[l.id] = (counts[l.id] || 0) + 1; });
    return (ST().REVENUE_LEADERS || []).map(l => ({ l, n: counts[l.id] || 0 })).filter(x => x.n).sort((a, b) => b.n - a.n || a.l.displayName.localeCompare(b.l.displayName));
  }
  function renderTeam() {
    const s = S(), st = ST(), ms = months(), now = nowYm(), done = lastDone();
    const L = st.leaderById(state.leaderId);
    const out = $('#p-team');
    if (!L) { out.innerHTML = '<div class="empty">Pick a revenue leader.</div>'; return; }
    const allMine = liveRecords().filter(p => { const l = leaderOf(p); return l && l.id === L.id; });
    const smallWorks = allMine.filter(p => st.isSmallWorks && st.isSmallWorks(p));
    const mine = allMine.filter(p => !(st.isSmallWorks && st.isSmallWorks(p)));
    const allAllocs = s.listAllocations();
    const covered = new Set((s.actualsMeta().months || []).filter(m => m <= now));
    const haveDone = covered.has(done);

    const rows = mine.map(p => {
      const plan = s.feeProjectPlan(p.id, ms);                       // contract hours by month
      const act = s.feeProjectActuals(p.id, ms);                     // people on it: e (planned hours) / a (logged)
      const allocs = allAllocs.filter(a => a.feeId === p.id);
      const allocBy = {}, actBy = {};
      act.rows.forEach(r => ms.forEach(m => { const c = r.byMonth[m] || { e: 0, a: 0 }; allocBy[m] = (allocBy[m] || 0) + c.e; actBy[m] = (actBy[m] || 0) + c.a; }));
      const contractH = plan ? ms.reduce((t, m) => t + (plan.byMonth[m] || 0), 0) : 0;
      const allocH = ms.reduce((t, m) => t + (allocBy[m] || 0), 0);
      const cover = contractH ? allocH / contractH : null;
      // last complete month: what the people on it logged vs what was planned for them
      let lastE = 0, lastA = 0;
      if (haveDone) { const dm = [done]; s.feeProjectActuals(p.id, dm).rows.forEach(r => { const c = r.byMonth[done] || { e: 0, a: 0 }; lastE += c.e; lastA += c.a; }); }
      const pace = haveDone && lastE > 0 ? lastA / lastE : null;
      const mapped = (s.clockifyNamesFor('fee:' + p.id) || []).length > 0;
      const touched = allocs.reduce((t, a) => (a.updatedAt && a.updatedAt > t) ? a.updatedAt : t, '');
      const stale = isFirm(p) && allocs.length && ageDays(touched) != null && ageDays(touched) > 60;
      const firm = isFirm(p);
      let tone = 'ok', text = 'planned';
      if (!plan && !allocs.length) { tone = 'n'; text = 'no roster priced'; }
      else if (!allocs.length) { tone = firm ? 'bad' : 'warn'; text = 'nobody planned'; }
      else if (cover != null && cover < 0.6) { tone = firm ? 'bad' : 'warn'; text = pct(cover * 100) + ' of contract staffed'; }
      else if (cover != null && cover > 1.25) { tone = 'warn'; text = pct(cover * 100) + ' of contract staffed'; }
      else if (!mapped && firm) { tone = 'warn'; text = 'no Clockify project mapped'; }
      const people = [...new Set(allocs.filter(a => ms.some(m => s.allocActiveIn(a, m))).map(a => a.personId))].length;
      return { p, firm, plan, allocs, allocBy, actBy, contractH, allocH, cover, pace, lastE, lastA, mapped, touched, stale, tone, text, people, rating: ratingOf(p) };
    });
    const order = { bad: 0, warn: 1, n: 2, ok: 3 };
    // Pursuits with nothing priced yet are one quiet line, not a row each.
    const quietPursuits = rows.filter(r => !r.firm && r.tone === 'n');
    const shown = rows.filter(r => !(!r.firm && r.tone === 'n'));
    shown.sort((a, b) => (a.firm === b.firm ? 0 : a.firm ? -1 : 1) || order[a.tone] - order[b.tone] || b.contractH - a.contractH);

    const unplannedFirm = rows.filter(r => r.firm && (r.tone === 'bad'));
    const quiet = rows.filter(r => r.pace != null && r.pace < 0.5 && r.lastE >= 20);
    const unmapped = rows.filter(r => r.firm && !r.mapped && (r.allocs.length || r.plan));
    const stale = rows.filter(r => r.stale);
    const needFte = rows.filter(r => r.firm).reduce((t, r) => t + r.contractH, 0) / (s.monthHours() * (ms.length || 1));
    const haveFte = rows.filter(r => r.firm).reduce((t, r) => t + r.allocH, 0) / (s.monthHours() * (ms.length || 1));

    const verdict = [
      v(unplannedFirm.length, `signed project${unplannedFirm.length === 1 ? '' : 's'} <b>with nobody, or under 60%, planned</b>`, unplannedFirm.length ? 'bad' : 'ok', '#team-proj'),
      v(quiet.length, haveDone ? `project${quiet.length === 1 ? '' : 's'} where the people planned <b>logged under half</b> of it in ${esc(shortYm(done))}` : 'Clockify has no complete month to judge yet', quiet.length ? 'warn' : (haveDone ? 'ok' : 'info'), '#team-proj'),
      v(n1(needFte), `FTE the <b>signed contracts need</b> over the horizon · <b>${n1(haveFte)}</b> planned`, haveFte < needFte * 0.8 ? 'warn' : 'ok', '#team-proj'),
      v(unmapped.length, `signed project${unmapped.length === 1 ? '' : 's'} <b>with no Clockify project mapped</b>, so nothing can be measured`, unmapped.length ? 'warn' : 'ok', '#team-proj'),
      v(stale.length, `plan${stale.length === 1 ? '' : 's'} <b>untouched for 60+ days</b> on signed work`, stale.length ? 'info' : 'ok', '#team-proj'),
    ].join('');

    const covBar = (r) => `<div class="cov">${ms.map(m => {
      const c = r.plan ? (r.plan.byMonth[m] || 0) : 0, a = r.allocBy[m] || 0, l = covered.has(m) ? (r.actBy[m] || 0) : null;
      const top = Math.max(c, a, l || 0, 1);
      const over = c && a > c * 1.25;
      return `<div class="m ${m === now ? 'today' : ''}" title="${esc(shortYm(m))}: contract ${n0(c)} h · planned ${n0(a)} h${l != null ? ' · logged ' + n0(l) + ' h' : ''}"><div class="fill ${r.firm ? '' : 'p'} ${over ? 'over' : ''}" style="height:${(a / top * 100).toFixed(0)}%"></div>${l != null ? `<div class="act" style="bottom:${(l / top * 100).toFixed(0)}%"></div>` : ''}</div>`;
    }).join('')}</div>`;

    const projRows = shown.map(r => `<tr>
      <td><div class="tt"><a href="${calcLink(r.p.id)}" target="_blank" rel="noopener">${esc(r.p.project.name || 'Untitled')}</a></div><div class="muted">${esc(r.p.project.client || '')} · <span class="status">${esc(statusLabel(r.p.project.status))}</span>${r.firm ? '' : ' · ' + esc(r.rating.short)}</div></td>
      <td><span class="chip ${r.tone}">${esc(r.text)}</span>${r.stale ? `<div class="muted">last touched ${dateS(r.touched)}</div>` : ''}</td>
      <td style="min-width:${Math.max(90, ms.length * 22)}px">${covBar(r)}</td>
      <td class="num">${r.plan ? n1(r.contractH / s.monthHours() / (ms.length || 1)) : '—'}</td>
      <td class="num">${r.allocs.length ? n1(r.allocH / s.monthHours() / (ms.length || 1)) : '—'}</td>
      <td class="num">${r.people || '—'}</td>
      <td class="num">${r.pace == null ? '<span class="muted">—</span>' : `<span class="chip ${r.pace < 0.5 ? 'bad' : r.pace < 0.9 ? 'warn' : r.pace > 1.1 ? 'warn' : 'ok'}">${pct(r.pace * 100)}</span>`}</td>
      <td class="c">${r.mapped ? '<span class="chip ok">yes</span>' : (r.allocs.length || r.plan ? '<span class="chip bad">no</span>' : '<span class="muted">—</span>')}</td>
    </tr>`).join('');

    /* people on my projects */
    const pids = [...new Set(rows.flatMap(r => r.allocs.filter(a => ms.some(m => s.allocActiveIn(a, m))).map(a => a.personId)))];
    const Lm = loadMap(ms, new Set());
    const ppl = pids.map(pid => {
      const person = s.getPerson(pid) || { id: pid, name: pid };
      const mineBy = {}; rows.forEach(r => r.allocs.forEach(a => { if (a.personId !== pid || isPursuitAlloc(a)) return; ms.forEach(m => { if (s.allocActiveIn(a, m)) mineBy[m] = (mineBy[m] || 0) + (a.pct || 0); }); }));
      const tot = (Lm[pid] || { firm: {} }).firm;
      let e = 0, a = 0; if (haveDone) rows.forEach(r => s.feeProjectActuals(r.p.id, [done]).rows.forEach(x => { if (x.person.id !== pid) return; const c = x.byMonth[done] || { e: 0, a: 0 }; e += c.e; a += c.a; }));
      const onMine = rows.filter(r => r.allocs.some(x => x.personId === pid && ms.some(m => s.allocActiveIn(x, m)))).map(r => r.p.project.name);
      return { person, mineBy, tot, e, a, onMine, peakTot: Math.max(0, ...ms.map(m => tot[m] || 0)) };
    }).sort((a, b) => b.peakTot - a.peakTot);
    const pplRows = ppl.map(x => `<tr><td><div class="tt">${esc(x.person.name)}</div><div class="muted">${esc(x.person.title || '')}</div></td>${ms.map(m => `<td class="h ${m === now ? 'today' : ''}"><span class="cell ${band(Math.round(x.tot[m] || 0))}" title="${Math.round(x.tot[m] || 0)}% across everything · ${Math.round(x.mineBy[m] || 0)}% on ${esc(L.displayName)}'s projects">${Math.round(x.mineBy[m] || 0) || '·'}<div class="muted" style="font-size:9.5px;line-height:1.1">of ${Math.round(x.tot[m] || 0)}</div></span></td>`).join('')}<td class="num">${haveDone ? (x.e ? `<span class="chip ${x.a / x.e < 0.5 ? 'bad' : x.a / x.e < 0.9 ? 'warn' : 'ok'}">${pct(x.a / x.e * 100)}</span>` : '<span class="muted">—</span>') : '<span class="muted">—</span>'}</td><td class="muted">${esc(x.onMine.slice(0, 3).join(' · '))}${x.onMine.length > 3 ? ' +' + (x.onMine.length - 3) : ''}</td></tr>`).join('');

    /* review stamp (local only) */
    let stamps = {}; try { stamps = JSON.parse(localStorage.getItem(REVIEW_KEY) || '{}'); } catch (e) {}
    const sk = L.id + '|' + now; const st2 = stamps[sk];
    const u = st.getCurrentUser();

    out.innerHTML = `
      <div class="verdict">${verdict}</div>
      <div class="card" id="team-proj">
        <div class="card-head"><h2>${esc(L.displayName)}'s projects.</h2><span class="hint">Signed work first, worst first. Bars: dashed frame = contract hours, fill = people planned, yellow line = Clockify hours. Purple = pursuit.</span><div class="right"><a class="btn ghost" href="${LIVE}?view=leader">Edit on the live page</a></div></div>
        ${shown.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>Project</th><th>State</th><th>Contract · planned · logged</th><th class="num">Contract FTE</th><th class="num">Planned FTE</th><th class="num">People</th><th class="num">${haveDone ? esc(shortYm(done)) + ' logged vs plan' : 'Logged vs plan'}</th><th class="c">Clockify mapped</th></tr></thead><tbody>${projRows}</tbody></table></div>` : '<div class="empty">No live projects with a roster to staff.</div>'}
        ${quietPursuits.length ? `<div class="muted" style="margin-top:10px"><b>${quietPursuits.length} pursuit${quietPursuits.length === 1 ? '' : 's'} with no roster priced yet</b>, so nothing to staff: ${esc(quietPursuits.slice(0, 6).map(r => r.p.project.name).join(' · '))}${quietPursuits.length > 6 ? ' +' + (quietPursuits.length - 6) + ' more' : ''}</div>` : ''}
        ${smallWorks.length ? `<div class="muted" style="margin-top:6px"><b>${smallWorks.length} Small Works record${smallWorks.length === 1 ? '' : 's'}</b> left out: pass-through only, nothing to staff.</div>` : ''}
      </div>
      <div class="card" id="team-ppl">
        <div class="card-head"><h2>People on these projects.</h2><span class="hint">Big number = their % on ${esc(L.displayName)}'s projects; small = their load across everything. Colour follows the total.</span></div>
        ${pplRows ? `<div class="scroll"><table class="tbl heat"><thead><tr><th>Person</th>${ms.map(m => `<th class="c ${m === now ? 'today' : ''}">${esc(shortYm(m))}</th>`).join('')}<th class="num">${haveDone ? esc(shortYm(done)) + ' logged' : 'Logged'}</th><th>On</th></tr></thead><tbody>${pplRows}</tbody></table></div>` : '<div class="empty">Nobody is planned on these projects in this window.</div>'}
      </div>
      <div class="card">
        <div class="card-head"><h2>Reviewed this month?</h2><span class="hint">The staffing equivalent of confirming the book. In this preview the stamp is kept in your browser only and never reaches Box.</span></div>
        <div class="stamp">${st2 ? `<span class="done">✓ Reviewed for ${esc(shortYm(now))} by <b>${esc(st2.by)}</b> on ${dateS(st2.at)} <span class="muted">(preview, local only)</span></span><button class="btn ghost" id="unstamp">Undo</button>` : `<button class="btn primary" id="stamp">I reviewed ${esc(L.displayName)}'s plan for ${esc(shortYm(now))}</button><span class="muted">Admins would see who has and has not reviewed, the way the tracker shows confirmations.</span>`}</div>
      </div>`;
    const sb = $('#stamp'); if (sb) sb.addEventListener('click', () => { stamps[sk] = { by: (u && (u.name || u.username)) || 'me', at: new Date().toISOString() }; try { localStorage.setItem(REVIEW_KEY, JSON.stringify(stamps)); } catch (e) {} renderTeam(); });
    const ub = $('#unstamp'); if (ub) ub.addEventListener('click', () => { delete stamps[sk]; try { localStorage.setItem(REVIEW_KEY, JSON.stringify(stamps)); } catch (e) {} renderTeam(); });
  }

  /* ============================================================
     DATA ROOM
     ============================================================ */
  function renderData() {
    const s = S(), st = ST(), ms = months(), now = nowYm();
    const am = s.actualsMeta(); const aAge = ageDays(am.importedAt);
    const unm = s.unmappedClockify(); const unmH = unm.reduce((t, u) => t + u.hours, 0);
    const dups = s.duplicateAllocations ? s.duplicateAllocations() : [];
    const legacy = s.legacyProjects ? s.legacyProjects() : [];
    const shifts = s.pendingContractShifts ? s.pendingContractShifts().filter(x => x.months) : [];
    const people = s.listPeople().filter(p => s.inView(p) && p.active !== false && !p.isPool && !p.nonBillable);
    const noTitle = people.filter(p => !p.title);
    const noRate = people.filter(p => p.title && !s.personCostRate(p));
    const noAlloc = s.hasActuals() ? s.loggingWithoutAllocation(ms.filter(m => m <= now)) : [];
    const gaps = s.contractStaffingGaps().filter(g => !g.dismissed && !g.pursuit);
    const gapProj = {}; gaps.forEach(g => { (gapProj[g.feeId] = gapProj[g.feeId] || { name: g.project, lead: g.lead, fte: 0 }).fte += g.totalNeedFteMo; });
    const leaves = (s.leaveStatus() || []).filter(l => l.returningSoon || l.startingSoon);

    // stale plans on signed work
    const allocs = s.listAllocations();
    const staleProj = liveRecords().filter(isFirm).map(p => { const mine = allocs.filter(a => a.feeId === p.id); if (!mine.length) return null; const t = mine.reduce((x, a) => (a.updatedAt && a.updatedAt > x) ? a.updatedAt : x, ''); const d = ageDays(t); return d != null && d > 60 ? { p, days: d } : null; }).filter(Boolean).sort((a, b) => b.days - a.days);

    // burning over plan, last 3 complete months
    const past = []; for (let i = 1; i <= 3; i++) past.push(s.ymAdd(now, -i));
    const burn = {};
    if (s.hasActuals()) s.varianceMatrix(past, {}).forEach(r => { const d = s.describeKey(r.key || s.keyForRef(r.project) || ''); if (!d.feeId) return; const b = burn[d.feeId] || (burn[d.feeId] = { name: d.label, client: d.client, e: 0, a: 0 }); past.forEach(m => { const c = r.byMonth[m]; if (c) { b.e += c.e; b.a += c.a; } }); });
    const hot = Object.entries(burn).map(([id, b]) => ({ id, ...b, over: b.a - b.e, ratio: b.e ? b.a / b.e : null })).filter(b => b.e > 20 && b.ratio > 1.15).sort((a, b) => b.over - a.over);
    const leadFor = (id) => { const p = st.getProject(id); return p ? leaderName(p) : ''; };

    const items = [];
    hot.slice(0, 5).forEach(b => items.push({ sev: 'money', what: `<b>${esc(b.name)}</b> logged ${n0(b.a)} h against ${n0(b.e)} h planned over the last three months (${pct(b.ratio * 100)})`, own: leadFor(b.id), fix: `<a href="${LIVE}">Compare tab</a>` }));
    Object.entries(gapProj).sort((a, b) => b[1].fte - a[1].fte).slice(0, 6).forEach(([id, g]) => items.push({ sev: 'revenue', what: `<b>${esc(g.name)}</b> is signed and has contract roles with nobody planned (${n1(g.fte)} FTE-months)`, own: g.lead, fix: `<a href="${LIVE}">Allocations · bridge</a>` }));
    shifts.forEach(x => items.push({ sev: 'revenue', what: `<b>${esc(x.name)}</b> moved ${x.months > 0 ? '+' : ''}${x.months} month${Math.abs(x.months) === 1 ? '' : 's'} in Reconciliation; its ${x.allocations} people row${x.allocations === 1 ? '' : 's'} did not`, own: leadFor(x.id), fix: `<a href="${LIVE}">banner on the live page</a>` }));
    if (unm.length) items.push({ sev: 'hygiene', what: `<b>${unm.length} Clockify project${unm.length === 1 ? '' : 's'}</b> with ${n0(unmH)} h land on no fee project: ${esc(unm.slice(0, 3).map(u => u.name).join(', '))}${unm.length > 3 ? '…' : ''}`, own: 'admins', fix: `<a href="${LIVE}">Mapping</a>` });
    if (legacy.length) items.push({ sev: 'hygiene', what: `<b>${legacy.length} old matrix name${legacy.length === 1 ? '' : 's'}</b> still carry ${legacy.reduce((t, l) => t + l.rows, 0)} allocation rows with no fee project`, own: 'admins', fix: `<a href="${LIVE}">Allocations · banner</a>` });
    if (dups.length) items.push({ sev: 'hygiene', what: `<b>${dups.length} double-counted allocation${dups.length === 1 ? '' : 's'}</b> (same person, same project, overlapping months)`, own: 'admins', fix: `<a href="${LIVE}">Allocations · double counted</a>` });
    noAlloc.slice(0, 4).forEach(x => items.push({ sev: 'people', what: `<b>${esc(x.person.name)}</b> logged ${n0(x.hours)} h on client work with no allocation anywhere: ${esc(x.projects.slice(0, 2).map(p => p.name).join(', '))}`, own: 'their manager', fix: `<a href="${LIVE}">Allocations</a>` }));
    staleProj.slice(0, 4).forEach(x => items.push({ sev: 'people', what: `<b>${esc(x.p.project.name)}</b> is ${esc(statusLabel(x.p.project.status))} and its plan has not been touched in ${x.days} days`, own: leaderName(x.p), fix: `<a href="${LIVE}?view=leader">My allocations</a>` }));
    if (noRate.length) items.push({ sev: 'hygiene', what: `<b>${noRate.length} people</b> have a title the rate grid cannot price, so their hours cost $0 on Profitability: ${esc(noRate.slice(0, 3).map(p => p.name).join(', '))}${noRate.length > 3 ? '…' : ''}`, own: 'admins', fix: `<a href="${LIVE}">Mapping · titles</a>` });
    if (noTitle.length) items.push({ sev: 'hygiene', what: `<b>${noTitle.length} people</b> have no title, so they sit outside the capacity forecast`, own: 'admins', fix: `<a href="${LIVE}">Mapping · roster</a>` });
    leaves.forEach(l => items.push({ sev: 'people', what: `<b>${esc(l.person.name)}</b> ${l.status === 'out' ? 'returns from leave ' + esc(shortYm(s.ymAdd(l.end, 1))) : 'starts leave ' + esc(shortYm(l.start))}; plan the hand-off`, own: 'their manager', fix: `<a href="${LIVE}">By Person</a>` }));
    const sevOrder = { money: 0, revenue: 1, people: 2, hygiene: 3 };
    items.sort((a, b) => sevOrder[a.sev] - sevOrder[b.sev]);

    const h = (dot, text) => `<span><i class="${dot}"></i>${text}</span>`;
    const health = [
      h(aAge == null ? 'bad' : aAge <= 7 ? 'ok' : aAge <= 21 ? 'warn' : 'bad', aAge == null ? 'Clockify never pulled' : `Clockify pulled ${aAge} day${aAge === 1 ? '' : 's'} ago · ${(am.months || []).length} months`),
      h(unm.length ? 'warn' : 'ok', `${unm.length} unmapped Clockify project${unm.length === 1 ? '' : 's'}`),
      h(legacy.length ? 'warn' : 'ok', `${legacy.length} legacy name${legacy.length === 1 ? '' : 's'}`),
      h(dups.length ? 'warn' : 'ok', `${dups.length} overlap${dups.length === 1 ? '' : 's'}`),
      h(shifts.length ? 'bad' : 'ok', `${shifts.length} schedule shift${shifts.length === 1 ? '' : 's'} pending`),
      h(noRate.length + noTitle.length ? 'warn' : 'ok', `${noRate.length + noTitle.length} people the grid cannot price`),
      h(staleProj.length ? 'warn' : 'ok', `${staleProj.length} stale plan${staleProj.length === 1 ? '' : 's'} on signed work`),
      h(Object.keys(gapProj).length ? 'warn' : 'ok', `${Object.keys(gapProj).length} signed project${Object.keys(gapProj).length === 1 ? '' : 's'} with unstaffed roles`),
    ].join('');

    $('#p-data').innerHTML = `
      <div class="health">${health}</div>
      <div class="card">
        <div class="card-head"><h2>What to fix, in order.</h2><span class="hint">Money first (fixed-fee work burning over plan), then revenue (signed work nobody is planned on), then people, then hygiene. Every line names who owns it.</span><div class="right"><a class="btn ghost" href="${LIVE}">Open the live page</a></div></div>
        ${items.length ? `<ul class="rank">${items.map(i => `<li><span class="sev ${i.sev}">${i.sev}</span><div class="what">${i.what}<div class="own">Owner: ${esc(i.own || '—')}</div></div><span class="fix">${i.fix}</span></li>`).join('')}</ul>` : '<div class="empty">Clean. Nothing to fix.</div>'}
      </div>
      <div class="card">
        <div class="card-head"><h2>What feeds this page.</h2><span class="hint">Where each number comes from and how fresh it is.</span></div>
        <table class="tbl"><thead><tr><th>Feed</th><th>What it gives</th><th>Freshness</th><th>Maintained on</th></tr></thead><tbody>
          <tr><td class="tt">Fee book (Box · projects.json)</td><td>Contract roles, FTE by month, status, rating, leader</td><td>live</td><td>Calculator</td></tr>
          <tr><td class="tt">Staffing store (Box · staff.json)</td><td>People, allocations, mappings, leave</td><td>live</td><td>${LIVE.replace('.html', '')} · Allocations, Mapping</td></tr>
          <tr><td class="tt">Clockify</td><td>Hours by person and project</td><td>${aAge == null ? 'never pulled' : aAge + ' days'}</td><td>${LIVE.replace('.html', '')} · Data Sources</td></tr>
          <tr><td class="tt">Rate grid (Box · rates.json)</td><td>Cost floors behind the $ views</td><td>${CAT().hydrated ? 'loaded' : 'not loaded'}</td><td>Rate Reconciliation</td></tr>
        </tbody></table>
      </div>`;
  }

  /* ---------- modes ---------- */
  function setMode(m) {
    state.mode = m;
    $$('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    $$('.panel').forEach(p => p.classList.toggle('on', p.id === 'p-' + m));
    $('#leader-field').hidden = !(m === 'team' && state.admin);
    $('#h1').textContent = m === 'team' ? 'Is my work planned, and is it showing up?' : m === 'band' ? 'Who is free, who is drowning, what is unplanned.' : 'Is the data clean enough to trust?';
    render();
  }
  function render() {
    try {
      if (state.mode === 'team') renderTeam();
      else if (state.mode === 'band') renderBand();
      else renderData();
    } catch (e) { console.error(e); $('#p-' + state.mode).innerHTML = `<div class="empty">Something in this view failed: ${esc(e.message)}</div>`; }
  }

  function denied() {
    document.querySelector('.wrap').innerHTML = `<div class="empty" style="padding:70px 20px"><div style="font-weight:800;font-size:20px;margin-bottom:8px">This preview is for staffing leadership and revenue leaders.</div><a class="btn" href="Fee Generator.html">System home</a></div>`;
  }

  async function boot() {
    const st = ST(), s = S();
    const u = st.getCurrentUser();
    state.admin = !!(st.isAdmin && st.isAdmin());
    state.me = st.resolveLeader(u.username) || st.resolveLeader(u.name) || null;
    if (!state.admin && !state.me) { denied(); return; }
    // The staffing store, read from Box the same way the live page does — merged, never pushed.
    const Box = window.UFC_Box;
    if (Box && Box.enabled && Box.pullStaff) { try { const r = await Box.pullStaff(); if (r) { if (s.mergeFromRemote) s.mergeFromRemote(r); else s.hydrateFromRemote(r); } } catch (e) { console.warn('staff pull', e); } }
    $('#who').innerHTML = `<b>${esc(u.name || u.username || '')}</b><br>${state.admin ? 'leadership · every project' : 'revenue leader · own projects'}`;
    // leader choices
    const ch = leaderChoices();
    $('#leader').innerHTML = ch.map(x => `<option value="${esc(x.l.id)}">${esc(x.l.displayName)} · ${x.n}</option>`).join('');
    state.leaderId = state.me ? state.me.id : (ch[0] ? ch[0].l.id : '');
    if ([...$('#leader').options].some(o => o.value === state.leaderId)) $('#leader').value = state.leaderId;
    $('#leader').addEventListener('change', e => { state.leaderId = e.target.value; render(); });
    $('#horizon').addEventListener('change', e => { state.horizon = +e.target.value; render(); });
    $$('#modes button').forEach(b => { if (!state.admin && b.dataset.mode !== 'team') b.disabled = true; b.addEventListener('click', () => { if (!b.disabled) setMode(b.dataset.mode); }); });
    $('#gloss-btn').addEventListener('click', () => { const g = $('#gloss'); g.hidden = !g.hidden; if (!g.hidden) g.scrollIntoView({ behavior: 'smooth' }); });
    let m = null; try { m = new URLSearchParams(location.search).get('mode'); } catch (e) {}
    setMode(state.admin ? (['team', 'band', 'data'].includes(m) ? m : 'band') : 'team');
  }
  if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(boot); else document.addEventListener('ufc:ready', boot);
})();
