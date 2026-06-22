/* ============================================================
   SAVILLS PPM · IMPORT REVENUES
   ------------------------------------------------------------
   Parse the "3 · Detailed Revenues" sheet into project records.
   Column mapping (0-based array index from sheet_to_json header:1):
     2 leader · 3 originator · 4 support · 5 revenue type
     6 client · 7 project · 8 project# · 9 billing type
     12 clockify id · 13 rating ("1: Booked"…"6: Less than 25%")
     15..50 = WP-month $ , Jan 2025 → Dec 2027 (36 cols)
   Rules:
     • import only rows with 2026 OR 2027 dollars (any sign)
     • skip all-zero rows
     • a net-negative row matching the project above = its fee share →
       folded in as brokerByMonth + feeShare flag (not its own project)
     • one project per remaining row
   ============================================================ */
(function () {
  'use strict';
  const STORE = window.UFC_Store;
  const $ = (s) => document.querySelector(s);
  const fmt = (n) => '$' + Math.round(n).toLocaleString();

  const COL = { leader: 2, originator: 3, support: 4, type: 5, client: 6, project: 7, projNum: 8, billing: 9, clockify: 12, rating: 13 };
  const MFIRST = 15, MLAST = 50;             // WP month columns
  const idxToYM = (idx) => { const t = idx - MFIRST; return { year: 2025 + Math.floor(t / 12), month: (t % 12) + 1 }; };

  let PREP = null;

  function wire() {
  $('#file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const msg = $('#parse-msg');
    msg.innerHTML = '<div class="msg">Reading…</div>';
    try {
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: false });
      const dn = wb.SheetNames.find(n => /detail/i.test(n)) || wb.SheetNames[2];
      if (!dn) throw new Error('Could not find the "Detailed Revenues" sheet.');
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[dn], { header: 1, raw: true, defval: null });
      PREP = prepare(aoa);
      msg.innerHTML = `<div class="msg ok">Parsed “${dn}” — ${PREP.projects.length} projects to import (${PREP.skipped} rows skipped, ${PREP.feeShares} fee-share lines folded in).</div>`;
      renderPreview();
    } catch (err) {
      msg.innerHTML = `<div class="msg err">${err.message}</div>`;
    }
  });

  function num(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; }
  function ratingNum(v) { const m = /^\s*(\d)/.exec(String(v || '')); return m ? Math.max(1, Math.min(7, +m[1])) : 5; }
  function statusFor(r) { return r === 1 ? 'active' : (r <= 4 ? 'negotiation' : 'draft'); }
  function baseName(s) { return String(s || '').toLowerCase().replace(/\s*[-–(].*$/, '').replace(/fee\s*shar.*$/, '').trim(); }

  function rowMonths(row) {
    const out = {}; let sum = 0, y26 = 0, y27 = 0, first = null, last = null;
    for (let i = MFIRST; i <= MLAST; i++) {
      const v = num(row[i]);
      if (v === 0) continue;
      const { year, month } = idxToYM(i);
      const k = year + '-' + month;
      out[k] = v; sum += v;
      if (year === 2026) y26 += v; if (year === 2027) y27 += v;
      const ord = year * 12 + month;
      if (first == null || ord < first.ord) first = { ord, year, month };
      if (last == null || ord > last.ord) last = { ord, year, month };
    }
    return { out, sum, y26, y27, first, last, count: Object.keys(out).length };
  }

  function prepare(aoa) {
    const projects = []; let skipped = 0, feeShares = 0;
    // data rows start at row 8 (index 7); header is row 7 (index 6)
    for (let r = 7; r < aoa.length; r++) {
      const row = aoa[r]; if (!row) continue;
      const client = (row[COL.client] || '').toString().trim();
      const project = (row[COL.project] || '').toString().trim();
      if (!client && !project) continue;
      const m = rowMonths(row);
      if (m.count === 0) { skipped++; continue; }

      // Fee-share fold-in: net-negative row matching the previous imported project.
      const prev = projects[projects.length - 1];
      const looksFee = /fee\s*shar|fee$|\bfee\b/i.test(project);
      if (m.sum < 0 && prev && (baseName(project) === baseName(prev.project.name) || looksFee)) {
        prev.source.brokerByMonth = prev.source.brokerByMonth || {};
        Object.keys(m.out).forEach(k => { prev.source.brokerByMonth[k] = (prev.source.brokerByMonth[k] || 0) + Math.abs(m.out[k]); });
        prev.assumptions.feeShare = { enabled: true, pct: blendedPct(prev) };
        prev.source.feeShareNote = project;
        feeShares++;
        continue;
      }

      // Filter: must have 2026 or 2027 dollars.
      if (m.y26 === 0 && m.y27 === 0) { skipped++; continue; }

      const rating = ratingNum(row[COL.rating]);
      const billing = (row[COL.billing] || '').toString().trim().toUpperCase();
      const rec = {
        project: {
          name: project || '(unnamed)', client: client || '—',
          status: statusFor(rating), rating,
          lead: (row[COL.leader] || '').toString().trim(),
          salesforceId: (row[COL.projNum] || '').toString().trim(),
          clockifyId: (row[COL.clockify] || '').toString().trim(),
          industry: '', projectType: '',
        },
        assumptions: { hrsPerMo: 173.33, escalation: 0, industryAdj: 0, discount: 0, rateLock: false,
          billingMode: 'phase', catalogBaseYear: 2024,
          feeBasis: /NTE/.test(billing) ? 'nte' : 'fixed', nteCeiling: 0,
          feeShare: { enabled: false, pct: 0 } },
        timeline: { startMonth: m.first.month, startYear: m.first.year, endMonth: m.last.month, endYear: m.last.year },
        phases: [{ id: 'p1', name: 'Engagement', length: (m.last.ord - m.first.ord + 1) }],
        groups: [{ id: 'core', name: 'Core team' }],
        roles: [],
        source: { type: 'import', sourceRow: r + 1, importedAt: new Date().toISOString(),
          importedByMonth: m.out, importedTotal: m.sum, reconciled: false, revenueType: (row[COL.type] || '').toString().trim() },
      };
      projects.push(rec);
    }
    return { projects, skipped, feeShares };
  }

  function blendedPct(rec) {
    const gross = rec.source.importedTotal || 0;
    const broker = Object.values(rec.source.brokerByMonth || {}).reduce((a, b) => a + b, 0);
    return gross ? Math.round((broker / gross) * 1000) / 10 : 0;
  }

  function renderPreview() {
    $('#preview-card').hidden = false;
    $('#commit-card').hidden = false;
    const total = PREP.projects.reduce((a, p) => a + p.source.importedTotal, 0);
    const fs = PREP.projects.filter(p => p.assumptions.feeShare.enabled).length;
    $('#stats').innerHTML = `
      <div class="stat"><b>${PREP.projects.length}</b><span>Projects</span></div>
      <div class="stat"><b>${fmt(total)}</b><span>Total imported</span></div>
      <div class="stat"><b>${fs}</b><span>With fee share</span></div>
      <div class="stat"><b>${PREP.skipped}</b><span>Rows skipped</span></div>`;
    $('#commit-n').textContent = PREP.projects.length;
    const rows = PREP.projects.slice(0, 200).map(p => {
      const months = Object.keys(p.source.importedByMonth).length;
      const br = p.assumptions.feeShare.enabled ? `<span class="fs">− broker ${p.assumptions.feeShare.pct}%</span>` : '';
      return `<tr>
        <td>${esc(p.project.client)}</td>
        <td>${esc(p.project.name)} ${br}</td>
        <td>${p.project.rating} · ${esc(STORE.ratingMeta(p.project.rating).short || '')}</td>
        <td>${esc(p.assumptions.feeBasis.toUpperCase())}</td>
        <td>${p.timeline.startMonth}/${p.timeline.startYear}–${p.timeline.endMonth}/${p.timeline.endYear}</td>
        <td class="num">${months}</td>
        <td class="num">${fmt(p.source.importedTotal)}</td>
      </tr>`;
    }).join('');
    $('#preview').innerHTML = `<thead><tr><th>Client</th><th>Project</th><th>Rating</th><th>Basis</th><th>Span (WP)</th><th class="num">Mo</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody>`
      + (PREP.projects.length > 200 ? `<tfoot><tr><td colspan="7" class="note">…and ${PREP.projects.length - 200} more</td></tr></tfoot>` : '');
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  $('#commit').addEventListener('click', () => {
    if (!PREP || !PREP.projects.length) return;
    let n = 0;
    try {
      PREP.projects.forEach(rec => { STORE.saveProject(rec); n++; });
      $('#commit-msg').innerHTML = `<div class="msg ok">Imported ${n} projects into the local store. Open Projects Index while signed in to Box to sync them up.</div>`;
      $('#commit').disabled = true;
    } catch (e) {
      $('#commit-msg').innerHTML = `<div class="msg err">Imported ${n} before error: ${e.message}</div>`;
    }
  });
  } // end wire()

  /* ADMIN-ONLY gate. Boot signs in via Box; only admins may import. */
  function init() {
    const me = STORE.getCurrentUser();
    if (!STORE.isAdmin(me)) {
      document.querySelector('.wrap').innerHTML =
        '<h1>Import Revenue Projections</h1>' +
        '<div class="card"><h2>Admin only</h2><p class="note">This tool is restricted to administrators. You\u2019re signed in as <strong>' +
        (me.name ? me.name.replace(/[&<>"]/g, '') : 'unknown') +
        '</strong>. Ask an admin if you need to import revenue data.</p></div>';
      return;
    }
    wire();
  }
  if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(init); else window.addEventListener('load', init);
})();
