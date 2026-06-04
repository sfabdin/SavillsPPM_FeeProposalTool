/* ============================================================
   SAVILLS PPM · INGESTION STUDIO
   Parse a historical fee matrix / proposal into a normalised
   project record:
     • extract a roster (name · staff title · project role · team · allocation · rate)
     • normalise each staff title to a Macro-grid rate family
     • validate each rate against the grid band  [Col E cost floor ↔ Col B rack]
     • "back into" the title implied by the rate alone, flag mismatches
     • save as a project record (opens in the calculator / Projects Index)
   ============================================================ */
(function () {
  'use strict';
  const CATALOG = window.RATES_CATALOG;
  const STORE = window.UFC_Store;

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const uid = () => 'r' + Math.random().toString(36).slice(2, 9);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const money = (n) => (n == null || isNaN(n)) ? '—' : '$' + Math.round(n).toLocaleString();
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const MONTHS_FULL = ['january','february','march','april','may','june','july','august','september','october','november','december'];

  /* ---------- State ---------- */
  let state = {
    project: { name:'', client:'', industry:'', startMonth:1, startYear:2026, endMonth:12, endYear:2026, totalFee:null, oneTimeDiscount:null, billingMode:'phase', sourceName:'' },
    phases: [],
    narrative: '',
    rows: [],   // { id, name, staffTitleRaw, titleId, tierId, projectRole, team, allocation, rate }
  };

  /* ============================================================
     RATE ↔ TITLE ENGINE
     ============================================================ */
  /** A family's billable band: [lowest cost floor, rack rate]. */
  function familyBand(title) {
    const floors = title.tiers.filter(t => !t.isNoCharge).map(t => t.costFloor || 0).filter(Boolean);
    const minFloor = floors.length ? Math.min(...floors) : 0;
    return { floor: minFloor, rack: title.rackRate };
  }

  /** Normalise an arbitrary staff/HR title to a grid family + tier. */
  function normalizeStaffTitle(raw) {
    if (!raw) return null;
    const s = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
    const map = CATALOG.staffTitleMap;
    let hit = map.find(m => m.staffTitle.toLowerCase() === s);
    if (hit) return { titleId: hit.titleId, tierId: hit.tierId, via: 'exact' };
    hit = map.find(m => s.includes(m.staffTitle.toLowerCase()) || m.staffTitle.toLowerCase().includes(s));
    if (hit) return { titleId: hit.titleId, tierId: hit.tierId, via: 'contains' };
    const rules = [
      [/(exec\w*\s+vice|managing director|\bevp\b)/, 'evp'],
      [/executive director/, 'ed'],
      [/senior director/, 'sd'],
      [/associate director/, 'assoc-dir'],
      [/\bdirector\b/, 'director'],
      [/senior (project|program) manager|senior manager/, 'senior-pm'],
      [/(assistant|associate) (project|program) manager|senior associate/, 'assistant-pm'],
      [/coordinator/, 'proj-coord'],
      [/cost|data analy|reporting|analyst/, 'cost-control'],
      [/principal|president/, 'principal'],
      [/\bmanager\b/, 'pm'],
      [/project manager|\bpm\b/, 'pm'],
    ];
    for (const [re, id] of rules) if (re.test(s)) return { titleId: id, tierId: 'mid', via: 'heuristic' };
    return null;
  }

  /** Pick the tier within a family whose billable rate is closest to the observed rate. */
  function bestTier(titleId, rate) {
    const t = CATALOG.titles.find(x => x.id === titleId);
    if (!t) return 'mid';
    if (rate == null || isNaN(rate)) return 'mid';
    let best = t.tiers[0], bestD = Infinity;
    t.tiers.forEach(tier => {
      const d = Math.abs((tier.rate || 0) - rate);
      if (d < bestD) { bestD = d; best = tier; }
    });
    return best.id;
  }

  /** Validate an observed rate against a family's band. */
  function validateRate(titleId, rate) {
    const t = CATALOG.titles.find(x => x.id === titleId);
    if (!t || rate == null || isNaN(rate)) return { status: 'unknown' };
    const band = familyBand(t);
    if (rate < band.floor)  return { status: 'below-floor', band };
    if (rate > band.rack)   return { status: 'above-rack', band };
    return { status: 'in-range', band };
  }

  /** Families whose band contains the rate, sorted by tightest ceiling (smallest rack first). */
  function impliedFamilies(rate) {
    if (rate == null || isNaN(rate)) return [];
    return CATALOG.titles
      .map(t => ({ t, band: familyBand(t) }))
      .filter(x => rate >= x.band.floor && rate <= x.band.rack)
      .sort((a, b) => a.band.rack - b.band.rack)
      .map(x => x.t);
  }

  function rowValidation(r) {
    const v = validateRate(r.titleId, r.rate);
    const implied = impliedFamilies(r.rate);
    const stated = r.titleId;
    const impliedIds = implied.map(t => t.id);
    const mismatch = stated && implied.length && !impliedIds.includes(stated);
    return { ...v, implied, mismatch };
  }

  /* ============================================================
     PARSERS
     ============================================================ */
  /** Deterministic parse of a pasted table (pipe / tab / comma delimited). */
  function parseTable(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    // pick delimiter by what appears most
    const delim = lines[0].includes('|') ? '|' : (lines[0].includes('\t') ? '\t' : ',');
    const split = (l) => l.split(delim).map(c => c.trim());
    let header = null, rows = [];
    lines.forEach(l => {
      const cells = split(l);
      const low = cells.map(c => c.toLowerCase());
      const looksHeader = low.some(c => /name/.test(c)) && low.some(c => /title|role/.test(c));
      if (!header && looksHeader) { header = low; return; }
      if (!header) return;
      // map by header keywords
      const get = (re) => { const i = header.findIndex(h => re.test(h)); return i >= 0 ? cells[i] : ''; };
      const name = get(/name|resource/);
      if (!name || /^name$/i.test(name)) return;
      const staff = get(/savills title|staff title|^title$/) || get(/title/);
      const role  = get(/project role|role title|^role$/);
      const team  = get(/team|workstream|group/);
      const allocRaw = get(/alloc|fte|%/);
      const rateRaw  = get(/rate|hourly|\$\/hr|hr/);
      rows.push(makeRow({ name, staffTitle: staff, projectRole: role, team, allocation: parseAlloc(allocRaw), rate: parseRate(rateRaw) }));
    });
    return rows;
  }

  function parseAlloc(v) {
    if (v == null || v === '') return null;
    const n = parseFloat(String(v).replace('%', '').trim());
    if (isNaN(n)) return null;
    return n > 1.5 ? n / 100 : n; // 100 -> 1.0, 0.5 stays
  }
  function parseRate(v) {
    if (v == null || v === '') return null;
    const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
    return isNaN(n) ? null : n;
  }

  function makeRow(d) {
    const norm = normalizeStaffTitle(d.staffTitle);
    const titleId = norm ? norm.titleId : 'pm';
    const tierId = (d.rate != null) ? bestTier(titleId, d.rate) : (norm ? norm.tierId : 'mid');
    return {
      id: uid(),
      name: d.name || '',
      staffTitleRaw: d.staffTitle || '',
      titleId,
      tierId,
      projectRole: d.projectRole || '',
      team: d.team || '',
      allocation: d.allocation ?? null,
      rate: d.rate ?? null,
      normVia: norm ? norm.via : 'none',
    };
  }

  /** Call the extractor: prefer the deployed serverless endpoint (works on the
      live site with the API key), fall back to window.claude in the Anthropic
      preview. Accepts text and/or page images (for vision on designed PDFs). */
  async function callExtractor({ text, images }) {
    // Keep the request under the serverless body limit (~4.5MB): drop trailing
    // page images until the payload fits, rather than 413-ing.
    let imgs = (images || []).slice();
    const budget = 3_600_000;   // ~3.6MB of base64 image data
    const sizeOf = (arr) => arr.reduce((s, d) => s + (d ? d.length : 0), 0);
    while (imgs.length > 1 && sizeOf(imgs) > budget) imgs = imgs.slice(0, imgs.length - 1);
    // 1) Serverless endpoint (production)
    try {
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text || '', images: imgs }),
      });
      if (res.ok) return await res.json();
      // If the function exists but errored, surface it (don't silently fall back to a worse path)
      if (res.status !== 404) { const e = await res.json().catch(() => ({})); throw new Error(e.error || ('extract failed: ' + res.status)); }
    } catch (e) {
      if (!/Failed to fetch|NetworkError|404/.test(String(e.message))) throw e;
      // else: endpoint not present (e.g. local preview) → fall through to window.claude
    }
    // 2) Preview fallback — text only (no vision)
    if (window.claude && window.claude.complete) {
      const prompt = buildTextPrompt(text || '');
      const raw = await window.claude.complete({ messages: [{ role: 'user', content: prompt }] });
      let s = String(raw).trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
      const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b >= 0) s = s.slice(a, b + 1);
      return JSON.parse(s);
    }
    throw new Error('No extractor available. On the live site set ANTHROPIC_API_KEY; in preview use Parse table.');
  }

  function buildTextPrompt(text) {
    return 'Read this fee proposal / matrix and return ONLY minified JSON (no prose, no fence) with shape '
      + '{"narrative":string,"project":{"name":string,"client":string,"startDate":"MON YYYY"|null,"endDate":"MON YYYY"|null,"totalFee":number|null,"oneTimeDiscount":number|null,"billing":"flat"|"phase"|null},'
      + '"phases":[{"name":string,"weeks":number|null,"startDate":"MON YYYY"|null,"endDate":"MON YYYY"|null,"fee":number|null}],'
      + '"people":[{"name":string,"staffTitle":string,"projectRole":string,"team":string,"allocation":number,"rate":number|null}]}. '
      + 'narrative = 2-4 sentences telling the story (client, period, headcount, structure, total fee, billing). '
      + 'phases = schedule; weeks duration (months×4.345); per-phase fee if shown. people = roster; allocation is decimal FTE; rate hourly USD; use the NON-DISCOUNTED rate when multiple discount columns exist; correlate rates across sheets; null when unknown; capture EVERY person.\n\nSOURCE:\n'
      + text.slice(0, 20000);
  }

  /** Apply an extraction result to state; returns roster rows. */
  function applyExtraction(data) {
    if (!data) return [];
    state.narrative = data.narrative || '';
    if (data.project) {
      if (data.project.name)   state.project.name = data.project.name;
      if (data.project.client) state.project.client = data.project.client;
      if (data.project.totalFee != null) state.project.totalFee = data.project.totalFee;
      if (data.project.oneTimeDiscount != null) state.project.oneTimeDiscount = data.project.oneTimeDiscount;
      if (data.project.billing) state.project.billingMode = data.project.billing === 'flat' ? 'flatline' : 'phase';
      applyDate(data.project.startDate, 'start');
      applyDate(data.project.endDate, 'end');
    }
    if (Array.isArray(data.phases) && data.phases.length) {
      state.phases = ingestPhases(data.phases);
    }
    return (data.people || []).map(p => makeRow({
      name: p.name, staffTitle: p.staffTitle, projectRole: p.projectRole,
      team: p.team, allocation: p.allocation, rate: p.rate,
    }));
  }

  /** Back-compat: text-only extraction entry. */
  async function extractWithClaude(text) {
    const data = await callExtractor({ text });
    return applyExtraction(data);
  }

  /** Convert extracted phases into engine-ready phases. Keeps the original
      `weeks` and `targetFee` as reference metadata, and assigns INTEGER month
      lengths (the engine bills whole months) proportional to weeks via
      largest-remainder, summing to the timeline's whole-month count. */
  function ingestPhases(rawPhases) {
    const WK_PER_MO = 4.345;
    const cleaned = rawPhases.map(ph => ({
      name: (ph.name || 'Phase').trim(),
      weeks: (ph.weeks != null && !isNaN(ph.weeks)) ? Number(ph.weeks) : null,
      targetFee: (ph.fee != null && !isNaN(ph.fee)) ? Number(ph.fee) : null,
    }));
    const totalMonths = Math.max(cleaned.length, monthsBetween(state.project));
    // weight by weeks; fall back to equal weights when weeks missing
    const weights = cleaned.map(p => (p.weeks && p.weeks > 0) ? p.weeks / WK_PER_MO : null);
    const haveWeeks = weights.some(w => w != null);
    const wsum = haveWeeks ? weights.reduce((s, w) => s + (w || 0), 0) : cleaned.length;
    const ideal = cleaned.map((p, i) => haveWeeks
      ? (weights[i] || 0) / wsum * totalMonths
      : totalMonths / cleaned.length);
    // largest-remainder rounding to integers summing to totalMonths (min 1 each)
    let floors = ideal.map(x => Math.max(1, Math.floor(x)));
    let used = floors.reduce((s, x) => s + x, 0);
    let remainder = totalMonths - used;
    const order = ideal
      .map((x, i) => ({ i, frac: x - Math.floor(x) }))
      .sort((a, b) => b.frac - a.frac);
    let oi = 0;
    while (remainder > 0 && order.length) { floors[order[oi % order.length].i]++; remainder--; oi++; }
    while (remainder < 0) { // too many months assigned; trim from smallest, keep >=1
      const idx = floors.indexOf(Math.max(...floors));
      if (floors[idx] > 1) { floors[idx]--; remainder++; } else break;
    }
    return cleaned.map((p, i) => ({ name: p.name, length: floors[i], weeks: p.weeks, targetFee: p.targetFee }));
  }

  function applyDate(str, which) {
    if (!str) return;
    const m = String(str).toLowerCase().match(/([a-z]+)\s*'?(\d{2,4})/);
    if (!m) return;
    const mi = MONTHS_FULL.findIndex(mm => mm.startsWith(m[1].slice(0, 3)));
    let y = parseInt(m[2]); if (y < 100) y += 2000;
    if (mi < 0) return;
    if (which === 'start') { state.project.startMonth = mi + 1; state.project.startYear = y; }
    else { state.project.endMonth = mi + 1; state.project.endYear = y; }
  }

  /* ============================================================
     M MOSER EXAMPLE (authentic data from the AMEX relocation matrix)
     ============================================================ */
  function loadExample() {
    state.project = {
      name: 'AMEX Relocation & Change Management',
      client: 'M Moser / American Express',
      industry: 'Financial Services',
      startMonth: 6, startYear: 2026, endMonth: 12, endYear: 2031,
      totalFee: 6991713,
      sourceName: 'M Moser_CM Project Timeline Fee_05.06.26.xlsx',
    };
    state.phases = [
      { name: 'Project Discovery (Interior Fit-Out)', length: 3 },
      { name: 'Schematic Design', length: 4 },
      { name: 'Design Development', length: 9 },
      { name: 'Construction Documents', length: 8 },
      { name: 'Bidding, Procurement & Permitting', length: 7 },
      { name: 'Interior Construction (phased)', length: 28 },
      { name: 'Project Closeout', length: 8 },
    ];
    const people = [
      ['Benay Josselson','Executive Vice President','Executive Sponsor','Change Management',0.10,300],
      ['Kathy Spiegel','Senior Director','Project Principal (Move Management)','Relocation Management',1.0,234],
      ['Artie Benoit','Senior Project Manager','Project Management & Administration','Relocation Management',1.0,170],
      ['Mike DeLeo','Project Manager','Logistics Planning','Relocation Management',0.20,190],
      ['Sarah Alim','Senior Manager','Reporting and Analysis 1','Relocation Management',1.0,170],
      ['Sabrina Jones','Senior Manager','Reporting and Analysis 2','Relocation Management',1.0,170],
      ['Amanda Hirsch','Senior Manager','Line of Business Coordinator 2','Relocation Management',1.0,155],
      ['Kelly Creighton','Director','Project Principal (Change & Communications Mgmt)','Change Management',0.50,300],
      ['Alli Hochberg','Associate Director','Change & Communications Lead, LOB Lead','Change Management',0.30,275],
      ['Rachel Haberman','Associate Program Manager','Change & Communications Mgr, LOB Coordinator 1','Change Management',0.30,175],
      ['Karenna Laufer','Project Coordinator','Change & Communications Manager','Change Management',0.30,175],
    ];
    state.rows = people.map(p => makeRow({ name:p[0], staffTitle:p[1], projectRole:p[2], team:p[3], allocation:p[4], rate:p[5] }));
    $('#src').value =
      'Name | Savills Title | Project Role | Team | Allocation | Hourly Rate\n' +
      people.map(p => `${p[0]} | ${p[1]} | ${p[2]} | ${p[3]} | ${Math.round(p[4]*100)}% | $${p[5]}`).join('\n');
    renderAll();
  }

  /* ============================================================
     RENDER
     ============================================================ */
  function renderAll() { renderProject(); renderTable(); renderSummary(); }

  function renderProject() {
    const p = state.project;
    $('#p-name').value = p.name;
    $('#p-client').value = p.client;
    $('#p-start').value = p.startYear ? `${MONTHS[p.startMonth-1]} ${p.startYear}` : '';
    $('#p-end').value = p.endYear ? `${MONTHS[p.endMonth-1]} ${p.endYear}` : '';
    $('#p-fee').value = p.totalFee != null ? money(p.totalFee) : '';
    $('#p-source').textContent = p.sourceName || 'manual / pasted';
    const sp = $('#story-panel'), st = $('#story-text');
    if (sp && st) {
      if (state.narrative) { sp.hidden = false; st.textContent = state.narrative; }
      else { sp.hidden = true; st.textContent = ''; }
    }
    renderPhasesPanel();
    const indSel = $('#p-industry');
    if (!indSel.options.length) {
      const blank = document.createElement('option'); blank.value=''; blank.textContent='— industry —'; indSel.appendChild(blank);
      STORE.INDUSTRIES.forEach(i => { const o=document.createElement('option'); o.value=i; o.textContent=i; indSel.appendChild(o); });
    }
    indSel.value = p.industry || '';
  }

  function titleOptions(sel) {
    return CATALOG.titles.map(t => `<option value="${t.id}" ${t.id===sel?'selected':''}>${esc(t.name)}</option>`).join('');
  }
  function tierOptions(titleId, sel) {
    const t = CATALOG.titles.find(x => x.id === titleId) || CATALOG.titles[0];
    return t.tiers.map(tr => `<option value="${tr.id}" ${tr.id===sel?'selected':''}>${tr.label} · floor $${tr.costFloor}</option>`).join('');
  }

  function renderTable() {
    const tb = $('#roster-tbody');
    if (!state.rows.length) {
      tb.innerHTML = `<tr><td colspan="8" class="empty">No roster yet. Load the example, paste a fee table, or extract from a proposal.</td></tr>`;
      return;
    }
    tb.innerHTML = '';
    state.rows.forEach((r, i) => {
      const v = rowValidation(r);
      const tr = document.createElement('tr');
      if (v.status === 'below-floor') tr.className = 'bad';
      else if (v.status === 'above-rack' || v.mismatch) tr.className = 'warn';

      let badge = '';
      if (v.status === 'below-floor') badge = `<span class="vb vb-bad">⚠ Potentially unprofitable</span>`;
      else if (v.status === 'above-rack') badge = `<span class="vb vb-warn">Above rack</span>`;
      else if (v.status === 'in-range') badge = `<span class="vb vb-ok">In range</span>`;
      else badge = `<span class="vb vb-muted">—</span>`;

      let detail = '';
      if (v.band) detail += `<span class="vd">grid band $${v.band.floor}–$${v.band.rack}</span>`;
      if (v.status === 'below-floor') {
        const imp = v.implied.length ? v.implied.slice(0,3).map(t=>t.name).join(', ') : 'none';
        detail += `<span class="vd vd-bad">rate implies: ${esc(imp)}</span>`;
      } else if (v.mismatch && v.implied.length) {
        detail += `<span class="vd vd-warn">rate fits: ${esc(v.implied.slice(0,2).map(t=>t.name).join(', '))}</span>`;
      }

      tr.innerHTML = `
        <td class="ix">${i+1}</td>
        <td><input class="cell name" data-id="${r.id}" data-k="name" value="${esc(r.name)}" placeholder="Name"></td>
        <td>
          <select class="cell title" data-id="${r.id}" data-k="titleId">${titleOptions(r.titleId)}</select>
          ${r.staffTitleRaw && normalizeStaffTitle(r.staffTitleRaw)?.via!=='exact' ? `<span class="raw">from “${esc(r.staffTitleRaw)}”</span>` : ''}
        </td>
        <td><input class="cell role" data-id="${r.id}" data-k="projectRole" value="${esc(r.projectRole)}" placeholder="Project role"></td>
        <td><input class="cell team" data-id="${r.id}" data-k="team" value="${esc(r.team)}" placeholder="Team"></td>
        <td class="num"><input class="cell alloc" data-id="${r.id}" data-k="allocation" value="${r.allocation!=null?Math.round(r.allocation*100):''}" placeholder="%">%</td>
        <td class="num"><span class="dollar">$</span><input class="cell rate" data-id="${r.id}" data-k="rate" value="${r.rate!=null?r.rate:''}" placeholder="rate"></td>
        <td class="vcell">
          <select class="cell tier" data-id="${r.id}" data-k="tierId">${tierOptions(r.titleId, r.tierId)}</select>
          <div class="vwrap">${badge}<span class="vdetails">${detail}</span></div>
          <button class="row-rm" data-id="${r.id}" title="Remove">×</button>
        </td>`;
      tb.appendChild(tr);
    });

    // wire cells
    $$('#roster-tbody .cell').forEach(el => {
      const ev = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, e => {
        const r = state.rows.find(x => x.id === e.target.dataset.id);
        if (!r) return;
        const k = e.target.dataset.k;
        let val = e.target.value;
        if (k === 'allocation') val = parseAlloc(val);
        else if (k === 'rate') val = parseRate(val);
        r[k] = val;
        if (k === 'titleId') { r.tierId = bestTier(r.titleId, r.rate); renderTable(); }
        else if (k === 'rate') { r.tierId = bestTier(r.titleId, r.rate); renderTable(); }
        else renderTable();
        renderSummary();
      });
    });
    $$('#roster-tbody .row-rm').forEach(b => b.addEventListener('click', e => {
      state.rows = state.rows.filter(x => x.id !== e.target.dataset.id);
      renderAll();
    }));
  }

  function renderPhasesPanel() {
    const panel = $('#phases-panel');
    const list = $('#phases-list');
    if (!panel || !list) return;
    const phases = state.phases || [];
    if (!phases.length) { panel.hidden = true; list.innerHTML = ''; return; }
    panel.hidden = false;
    const totalMo = phases.reduce((s, p) => s + (p.length || 0), 0);
    list.innerHTML = phases.map((p, i) => {
      const wk = (p.weeks != null) ? `${p.weeks} wk` : '';
      const mo = `${p.length} mo`;
      const fee = (p.targetFee != null) ? money(p.targetFee) : '';
      return `<div class="phase-chip">
        <span class="pc-ix">${i + 1}</span>
        <span class="pc-name">${esc(p.name)}</span>
        <span class="pc-dur">${wk ? wk + ' · ' : ''}${mo}</span>
        ${fee ? `<span class="pc-fee">target ${fee}</span>` : ''}
      </div>`;
    }).join('');
    const bits = [`${phases.length} phases · ${totalMo} mo`];
    if (state.project.billingMode === 'flatline') bits.push('flat monthly billing');
    if (state.project.oneTimeDiscount) bits.push(`one-time discount ${money(state.project.oneTimeDiscount)}`);
    $('#phases-note').textContent = bits.join('  ·  ') + ' — fees are reference targets; staffing drives the live fee. Tune per-phase FTE in the calculator.';
  }

  function renderSummary() {
    const n = state.rows.length;
    const bad = state.rows.filter(r => rowValidation(r).status === 'below-floor').length;
    const warn = state.rows.filter(r => { const v = rowValidation(r); return v.status === 'above-rack' || v.mismatch; }).length;
    const ok = n - bad - warn;
    $('#sum-total').textContent = n;
    $('#sum-ok').textContent = ok;
    $('#sum-warn').textContent = warn;
    $('#sum-bad').textContent = bad;
    const create = $('#create-btn');
    create.disabled = n === 0;
    $('#create-note').innerHTML = bad
      ? `<strong>${bad} role${bad===1?'':'s'} included at a potentially unprofitable rate.</strong> That's allowed — these will save with an advisory flag you'll see in the calculator.`
      : (n ? `Ready to save ${n} role${n===1?'':'s'} as a project record.` : 'Load or paste a roster to begin.');
  }

  /* ============================================================
     CREATE PROJECT RECORD
     ============================================================ */
  function monthsBetween(p) {
    return (p.endYear - p.startYear) * 12 + (p.endMonth - p.startMonth) + 1;
  }
  function createProjectRecord() {
    const p = state.project;
    // groups from unique teams
    const teams = [...new Set(state.rows.map(r => (r.team || 'Core').trim()).filter(Boolean))];
    const groups = teams.length ? teams.map(t => ({ id: uid(), name: t })) : [{ id: uid(), name: 'Core team' }];
    const groupFor = (team) => (groups.find(g => g.name === (team||'').trim()) || groups[0]).id;

    const totalMonths = Math.max(1, monthsBetween(p));
    let phases = state.phases.length ? state.phases.map(ph => ({ id: uid(), name: ph.name, length: ph.length, weeks: ph.weeks ?? null, targetFee: ph.targetFee ?? null }))
                                     : [{ id: uid(), name: 'Full term', length: totalMonths, weeks: null, targetFee: null }];
    // normalise phase lengths to the timeline
    const sum = phases.reduce((s, x) => s + x.length, 0);
    if (sum !== totalMonths && phases.length) {
      const diff = totalMonths - sum;
      phases[phases.length - 1].length = Math.max(1, phases[phases.length - 1].length + diff);
    }

    const roles = state.rows.map(r => {
      const fte = {};
      const pct = r.allocation != null ? Math.round(r.allocation * 100) : 0;
      phases.forEach(ph => fte[ph.id] = pct);
      const hasRate = r.rate != null && !isNaN(r.rate);
      return {
        id: uid(),
        titleId: r.titleId,
        tierId: r.tierId,
        resource: r.name,
        projectRole: r.projectRole,
        // Ingested rates ARE negotiated/contracted figures — preserve them exactly
        // rather than re-deriving from the grid. Title+tier still anchor the cost floor.
        rateSource: hasRate ? 'contracted' : 'grid',
        contractedRate: hasRate ? r.rate : null,
        groupId: groupFor(r.team),
        fte,
        ingest: { observedRate: r.rate, staffTitleRaw: r.staffTitleRaw, team: r.team },
      };
    });

    const record = {
      project: {
        name: p.name || 'Ingested project',
        client: p.client || '',
        lead: '',
        proposalDate: new Date().toISOString().slice(0,10),
        location: '',
        status: 'won',
        industry: p.industry || '',
        firstProposalDate: '',
        signedContractDate: '',
        clientContact: '',
        clientRelOwner: '',
      },
      timeline: { startMonth: p.startMonth, startYear: p.startYear, endMonth: p.endMonth, endYear: p.endYear },
      phases,
      groups,
      roles,
      assumptions: { hrsPerMo: 173.33, escalation: 3.0, industryAdj: 20, discount: 0, rateLock: false, billingMode: p.billingMode || 'phase', catalogBaseYear: CATALOG.baseYear },
      source: { type: 'ingest', name: p.sourceName || 'pasted', extractedTotalFee: p.totalFee, oneTimeDiscount: p.oneTimeDiscount ?? null, ingestedAt: new Date().toISOString() },
    };
    const saved = STORE.saveProject(record);
    window.location.href = 'Universal Fee Calculator.html?id=' + encodeURIComponent(saved.id);
  }

  /* ============================================================
     FILE UPLOAD — in-browser .xlsx / .csv / .pdf parsing
     ============================================================ */
  function setStatus(msg, cls) {
    const el = $('#src-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'src-status' + (cls ? ' ' + cls : '');
  }

  function rowsLookRoster(rows) {
    return rows.slice(0, 25).some(r => {
      const low = r.map(c => String(c).toLowerCase());
      return low.some(c => /name|resource/.test(c)) && low.some(c => /title|role/.test(c));
    });
  }

  /** Convert an xlsx/xls workbook → { roster, full }.
      roster = pipe text of the first roster-like sheet (clean view for the table parser);
      full   = every sheet dumped with markers, so Claude can correlate rates that
               live on separate scenario/fee sheets. */
  async function xlsxToText(file) {
    const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sheetRows = sn => XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, blankrows: false, defval: '' });
    const toText = rows => rows
      .map(r => r.map(c => String(c).replace(/\|/g, '/').trim()).join(' | '))
      .filter(l => l.replace(/[|\s]/g, '').length)
      .join('\n');
    let roster = '';
    for (const sn of wb.SheetNames) {
      const rows = sheetRows(sn);
      if (rowsLookRoster(rows)) { roster = toText(rows); break; }
    }
    const full = wb.SheetNames
      .map(sn => `### SHEET: ${sn}\n` + toText(sheetRows(sn)))
      .join('\n\n');
    return { roster, full };
  }

  /** Extract text from a PDF (proposals are prose → feed to Claude). */
  async function pdfToText(file) {
    const mod = await import('https://cdn.jsdelivr.net/npm/pdf-parse@2.4.5/dist/pdf-parse/web/pdf-parse.es.js');
    const PDFParse = mod.PDFParse;
    PDFParse.setWorker('https://cdn.jsdelivr.net/npm/pdf-parse@2.4.5/dist/pdf-parse/web/pdf.worker.min.mjs');
    const parser = new PDFParse({ data: new Uint8Array(await file.arrayBuffer()) });
    const res = await parser.getText();
    return res.text || '';
  }

  /** Render PDF pages to PNG data-URLs for Claude vision (handles designed/
      tabular proposals that text extraction mangles). Capped for payload size. */
  async function pdfToImages(file, maxPages = 6) {
    const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs';
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const n = Math.min(doc.numPages, maxPages);
    const out = [];
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      // Cap the rendered width so JPEG payloads stay under the serverless limit.
      const raw = page.getViewport({ scale: 1 });
      const scale = Math.min(1.4, 1400 / raw.width);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width; canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      out.push(canvas.toDataURL('image/jpeg', 0.7));   // JPEG ~5-8x smaller than PNG
    }
    return out;
  }

  let lastWorkbookText = '';   // full multi-sheet dump for Claude when a workbook is uploaded
  let lastImages = [];         // PDF page images for vision extraction

  async function handleFile(file) {
    if (!file) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    state.project.sourceName = file.name;
    lastWorkbookText = '';
    setStatus(`Reading ${file.name}…`, 'busy');
    try {
      if (ext === 'csv' || ext === 'txt') {
        $('#src').value = await file.text();
        runTableParse(`Loaded ${file.name}`);
      } else if (ext === 'xlsx' || ext === 'xls') {
        const { roster, full } = await xlsxToText(file);
        lastWorkbookText = full;
        $('#src').value = roster || full;
        renderProject();
        const rows = parseTable($('#src').value);
        if (rows.length) {
          state.rows = rows; renderAll();
          const noRates = rows.every(r => r.rate == null);
          setStatus(noRates
            ? `Parsed ${rows.length} roles — but no rates on the roster sheet. Hit “Extract with Claude” to pull rates from the other sheets.`
            : `Parsed ${file.name} — ${rows.length} roles. Review below.`, noRates ? 'busy' : '');
        } else {
          renderAll();
          setStatus(`Read ${file.name}, but no roster table detected — try “Extract with Claude”.`, 'bad');
        }
      } else if (ext === 'pdf') {
        const text = await pdfToText(file);
        $('#src').value = text;
        renderProject();
        setStatus(`Reading ${file.name} pages for Claude vision…`, 'busy');
        try { lastImages = await pdfToImages(file); } catch (e) { lastImages = []; }
        if (!text.trim() && !lastImages.length) { setStatus('Could not read this PDF. Paste the content manually.', 'bad'); return; }
        setStatus(`Read ${file.name} — extracting with Claude…`, 'busy');
        await runClaudeExtract();
      } else {
        setStatus(`Unsupported type “.${ext}”. Use .xlsx, .csv or .pdf.`, 'bad');
        return;
      }
    } catch (e) {
      setStatus('Could not read file: ' + e.message, 'bad');
    } finally {
      renderProject();
    }
  }

  function runTableParse(prefix) {
    const rows = parseTable($('#src').value);
    if (rows.length) {
      state.rows = rows; renderAll();
      setStatus(`${prefix} — ${rows.length} role${rows.length===1?'':'s'} parsed. Review below.`, '');
    } else {
      renderAll();
      setStatus(`${prefix}, but no roster table detected — try “Extract with Claude”.`, 'bad');
    }
  }

  async function runClaudeExtract() {
    const btn = $('#extract-btn'), o = btn.textContent;
    btn.textContent = 'Extracting…'; btn.disabled = true;
    try {
      const data = await callExtractor({ text: lastWorkbookText || $('#src').value, images: lastImages });
      const rows = applyExtraction(data);
      renderProject();
      if (!rows.length && !state.narrative) throw new Error('Nothing recognized in the document.');
      state.rows = rows; renderAll();
      const bits = [`${rows.length} role${rows.length===1?'':'s'}`];
      if (state.phases.length) bits.push(`${state.phases.length} phases`);
      if (state.project.totalFee) bits.push(money(state.project.totalFee));
      setStatus(`Extracted ${bits.join(' · ')}. Review the story & roster below.`, '');
    } catch (e) {
      setStatus('Extraction failed: ' + e.message, 'bad');
    } finally {
      btn.textContent = o; btn.disabled = false;
    }
  }

  /* ============================================================
     BOOT
     ============================================================ */
  document.addEventListener('DOMContentLoaded', () => {
    const startStudio = () => {
    $('#example-btn').addEventListener('click', loadExample);
    $('#parse-btn').addEventListener('click', () => {
      const rows = parseTable($('#src').value);
      if (!rows.length) { alert('Could not find a roster table. Expect a header row with Name + Title/Role columns, pipe- or tab-delimited.'); return; }
      state.rows = rows; renderAll();
    });
    $('#extract-btn').addEventListener('click', runClaudeExtract);

    // File upload — dropzone + picker
    const dz = $('#dropzone'), fi = $('#file-input');
    $('#choose-btn').addEventListener('click', (e) => { e.stopPropagation(); fi.click(); });
    dz.addEventListener('click', () => fi.click());
    fi.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); fi.value = ''; });
    ['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave','dragend','drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
    $('#clear-btn').addEventListener('click', () => {
      state.rows = []; state.phases = [];
      lastWorkbookText = '';
      state.project = { name:'', client:'', industry:'', startMonth:1, startYear:2026, endMonth:12, endYear:2026, totalFee:null, sourceName:'' };
      $('#src').value = ''; setStatus(''); renderAll();
    });
    $('#create-btn').addEventListener('click', createProjectRecord);

    // project meta inputs
    $('#p-name').addEventListener('input', e => state.project.name = e.target.value);
    $('#p-client').addEventListener('input', e => state.project.client = e.target.value);
    $('#p-industry').addEventListener('change', e => state.project.industry = e.target.value);
    $('#p-start').addEventListener('change', e => applyDate(e.target.value, 'start'));
    $('#p-end').addEventListener('change', e => applyDate(e.target.value, 'end'));

    renderAll();
    };
    if (window.ufcReady && window.ufcReady.then) { window.ufcReady.then(startStudio); } else { startStudio(); }
  });
})();
