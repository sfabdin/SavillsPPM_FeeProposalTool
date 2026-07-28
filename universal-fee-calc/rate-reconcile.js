/* ============================================================
   SAVILLS PPM · RATE GRID RECONCILIATION (admin)
   ------------------------------------------------------------
   Load a candidate rate grid → dry-run reconcile every project so
   each frozen MONTHLY billing figure holds against the new rack
   rates (per-month reconciling discount) → review flags → commit.
   Commit snapshots a version, stores the per-month vector, tags the
   grid, and re-stamps (billing unchanged). Dry-run only until commit.
   ============================================================ */
(function () {
  'use strict';
  const STORE = window.UFC_Store, RC = window.RATES_CATALOG;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (n) => (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString();
  const pct = (d) => (d == null ? '—' : (d * 100).toFixed(2) + '%');

  let newCat = null;                 // detached candidate catalog
  const reports = {};                // id → dry-run report (status ok only kept for commit)
  let okList = [];                   // project ids eligible to commit

  function readJsonFile(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => { try { resolve(JSON.parse(fr.result)); } catch (e) { reject(e); } };
      fr.onerror = () => reject(new Error('read failed'));
      fr.readAsText(file);
    });
  }

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const msg = $('#parse-msg');
    try {
      const payload = await readJsonFile(file);
      newCat = RC.detachedFrom(payload);
      msg.className = 'msg ok';
      msg.textContent = `Loaded ${newCat.titles.length} rate families · “${newCat.source}”. Running dry-run…`;
      runDryRun();
    } catch (err) {
      newCat = null;
      msg.className = 'msg err';
      msg.textContent = 'Could not read that file as a rate grid: ' + err.message;
    }
  }

  function runDryRun() {
    const projects = STORE.listProjects();
    let okCount = 0, skipCount = 0, exProjects = 0, totalDelta = 0, totalExc = 0, heldSum = 0;
    okList = [];
    const rowsHtml = [];
    projects.forEach(p => {
      const rep = STORE.reconcileToGrid(p, newCat);
      reports[p.id] = rep;
      const name = esc(p.project?.name || 'Untitled');
      const client = esc(p.project?.client || '');
      if (rep.status !== 'ok') {
        skipCount++;
        rowsHtml.push(`<tr class="proj-row skip"><td>${name}</td><td>${client}</td><td colspan="4" class="note">${esc(rep.reason || 'skipped')}</td><td><span class="pill skip">skip</span></td></tr>`);
        return;
      }
      okCount++; okList.push(p.id);
      totalDelta += rep.totalDelta; totalExc += rep.exceptions; heldSum += rep.heldTotal;
      if (rep.exceptions) exProjects++;
      const dcls = Math.abs(rep.totalDelta) < 0.005 ? 'delta-ok' : 'delta-bad';
      const exPill = rep.exceptions ? `<span class="pill ex">${rep.exceptions} flag${rep.exceptions > 1 ? 's' : ''}</span>` : `<span class="pill clean">clean</span>`;
      rowsHtml.push(
        `<tr class="proj-row" data-id="${p.id}"><td><span class="caret">▸</span> ${name}</td><td>${client}</td>` +
        `<td class="num">${money(rep.frozenTotal)}</td><td class="num">${money(rep.heldTotal)}</td>` +
        `<td class="num ${dcls}">${money(rep.totalDelta)}</td><td class="num">${rep.rows.filter(r => r.discount != null).length} mo</td>` +
        `<td>${exPill}</td></tr>` +
        `<tr class="detail" data-detail="${p.id}" hidden><td colspan="7"><div class="inner"></div></td></tr>`
      );
    });
    $('#report-card').hidden = false;
    $('#grid-tag').textContent = newCat.source;
    $('#stats').innerHTML =
      `<div class="stat"><b>${okCount}</b><span>Projects reconciled</span></div>` +
      `<div class="stat"><b>${money(heldSum)}</b><span>Held billing total</span></div>` +
      `<div class="stat"><b class="${Math.abs(totalDelta) < 0.5 ? 'delta-ok' : 'delta-bad'}">${money(totalDelta)}</b><span>Total delta (should be $0)</span></div>` +
      `<div class="stat"><b>${exProjects}</b><span>Projects with flags</span></div>` +
      `<div class="stat"><b>${skipCount}</b><span>Skipped</span></div>`;
    $('#report tbody').innerHTML = rowsHtml.join('');
    $('#parse-msg').textContent = '';

    // Exceptions roll-up
    const excCard = $('#exc-card'), excList = $('#exc-list');
    if (totalExc) {
      const items = [];
      okList.forEach(id => {
        const rep = reports[id]; if (!rep.exceptions) return;
        const nm = esc(STORE.getProject(id)?.project?.name || id);
        rep.flags.forEach(f => items.push(`<div><strong>${nm}</strong> · <span class="flag ${f.type}">${f.type.toUpperCase()}</span> ${esc(f.ym)} — ${esc(f.detail)}</div>`));
      });
      excList.innerHTML = items.join('');
      excCard.hidden = false;
    } else { excCard.hidden = true; }

    // Commit
    $('#commit-card').hidden = okCount === 0;
    $('#commit-n').textContent = okCount;
    if (window.PPMGuide) window.PPMGuide.retag();
  }

  function toggleDetail(id) {
    const dr = document.querySelector(`tr.detail[data-detail="${id}"]`);
    if (!dr) return;
    const open = !dr.hidden;
    if (open) { dr.hidden = true; return; }
    const rep = reports[id]; if (!rep || rep.status !== 'ok') return;
    const body = rep.rows.map(r => {
      const dcls = Math.abs(r.delta) < 0.005 ? 'delta-ok' : 'delta-bad';
      return `<tr><td>${esc(r.ym)}</td><td class="num">${money(r.frozenNet)}</td><td class="num">${money(r.newBase)}</td><td class="num">${pct(r.discount)}</td><td class="num">${money(r.held)}</td><td class="num ${dcls}">${money(r.delta)}</td></tr>`;
    }).join('');
    dr.querySelector('.inner').innerHTML =
      `<table><thead><tr><th>Month</th><th class="num">Frozen net</th><th class="num">New-grid base</th><th class="num">Recon. discount</th><th class="num">Held</th><th class="num">Δ</th></tr></thead><tbody>${body}</tbody></table>`;
    dr.hidden = false;
  }

  async function commitAll() {
    if (!newCat || !okList.length) return;
    if (!confirm(`Commit reconciliation to “${newCat.source}” for ${okList.length} projects?\n\nEach gets a reversible version snapshot. Billing is held; only rack/cost rates and the per-month discount change.`)) return;
    const btn = $('#commit'); btn.disabled = true;
    let done = 0;
    okList.forEach(id => { if (STORE.commitReconcile(id, newCat, reports[id])) done++; });
    const m = $('#commit-msg'); m.className = 'msg ok';
    m.textContent = `Committed ${done} projects to “${newCat.source}”. Snapshots saved. Syncing to Box…`;
    try { if (window.UFC_Box && window.UFC_Box.pushNow) await window.UFC_Box.pushNow(); } catch (e) {}
  }

  function wire() {
    $('#file').addEventListener('change', onFile);
    $('#report').addEventListener('click', (e) => {
      const row = e.target.closest('tr.proj-row[data-id]');
      if (row) toggleDetail(row.dataset.id);
    });
    $('#commit').addEventListener('click', commitAll);
  }

  function init() {
    const me = STORE.getCurrentUser();
    if (!STORE.isAdmin(me)) {
      document.querySelector('.wrap').innerHTML =
        '<h1>Rate Grid Reconciliation</h1>' +
        '<div class="card"><h2>Admin only</h2><p class="note">This tool is restricted to administrators. You\u2019re signed in as <strong>' +
        (me && me.name ? esc(me.name) : 'unknown') +
        '</strong>. Ask an admin if a rate-grid change is needed.</p></div>';
      return;
    }
    wire();
  }
  if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(init); else window.addEventListener('load', init);
})();
