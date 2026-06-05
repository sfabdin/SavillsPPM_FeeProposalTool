/* ============================================================
   SAVILLS PPM · FEE SYSTEM · PROJECT INTAKE
   ------------------------------------------------------------
   Builds the Project Intake as a FORMATTED TABLE (matching the
   standard intake form) and copies it to the clipboard as rich
   HTML, so the person doing intake pastes it straight into an
   email to ppmprojectintake@savills.us.

   Fields the system can pre-fill are filled; fields the submitter
   must complete are HIGHLIGHTED YELLOW. Appears when a project is
   Won or Active; re-flags if fee/schedule changes afterward.
   ============================================================ */
(function () {
  'use strict';

  const INTAKE_TO = 'ppmprojectintake@savills.us';
  const HL = 'background:#FFF36B;';        // yellow highlight for fields to complete
  const TODO = 'background:#FFF36B;color:#7a6a00;font-style:italic;';

  function dstr(m, y) { return (m && y) ? `${String(m).padStart(2, '0')}/01/${y}` : ''; }
  function money(n) { return (n == null || isNaN(n)) ? '' : '$' + Math.round(n).toLocaleString(); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  function intakeSignature(state, netFee) {
    const t = state.timeline || {};
    return [Math.round(netFee || 0), t.startMonth, t.startYear, t.endMonth, t.endYear].join('|');
  }

  /** Rows: [num, question, value, needsInput]. needsInput → yellow highlight. */
  function intakeRows(state, opts) {
    const p = state.project || {};
    const t = state.timeline || {};
    const fs = state.assumptions && state.assumptions.feeShare;
    const feeShare = fs && fs.enabled;
    const scope = (opts.serviceLines || []).join(', ');
    return [
      ['SECTION', 'Authorization'],
      [1, 'Is this the first authorization/contract for this client?', '', true],
      [2, 'Tracked separately (standalone) or additive to prior WAs?', '', true],
      [3, 'If additive, which authorizations/contracts go together?', 'N/A', false],
      ['SECTION', 'Client Payer Information'],
      [4, 'Entity Name (full legal name from contract)', p.client || '', !p.client],
      [5, 'Client "short name"', p.client || '', !p.client],
      [6, "Payer's Physical Address", '', true],
      [7, 'Payer POC', p.clientContact || '', !p.clientContact],
      [8, 'Payer Phone', '', true],
      [9, 'Payer Email', '', true],
      ['SECTION', 'Fees and Dates'],
      [10, 'Total Fee (note if fixed fee or timecard)', money(opts.netFee), opts.netFee == null],
      [11, 'Total NTE reimbursable expenses', '', true],
      [12, 'Start Date (note if contract start differs from work start)', dstr(t.startMonth, t.startYear), !(t.startMonth && t.startYear)],
      [13, 'End Date (note if contract end differs from work end)', dstr(t.endMonth, t.endYear), !(t.endMonth && t.endYear)],
      ['SECTION', 'Commission'],
      [14, 'Does a fee share apply?', feeShare ? `Yes — ${fs.pct}% to broker (attach co-broker agreement)` : 'No', false],
      [15, 'Percentage split', feeShare ? `${fs.pct}%` : 'N/A', feeShare],
      [16, 'Is this a domestic (U.S.) fee split?', feeShare ? '' : 'N/A', feeShare],
      [17, 'Is this an international fee split?', 'N/A', false],
      [18, 'Third Party Commission / Fees', 'N/A', false],
      ['SECTION', 'Client & Project Information'],
      [19, 'Client Industry / Sector', p.industry || '', !p.industry],
      [20, 'Services / Scope', scope, !scope],
      [21, 'Project Address (full street address with zip)', p.location || '', !p.location],
      [22, 'RSF', '', true],
      [23, 'Project Budget', '', true],
    ];
  }

  /** Build the rich-HTML intake table. */
  function buildTableHtml(state, opts) {
    const p = state.project || {};
    const rows = intakeRows(state, opts);
    let body = '';
    rows.forEach(r => {
      if (r[0] === 'SECTION') {
        body += `<tr><td colspan="3" style="background:#25273A;color:#fff;font-weight:bold;padding:6px 10px;border:1px solid #c9c9c4;">${esc(r[1])}</td></tr>`;
        return;
      }
      const [num, q, val, needs] = r;
      const valStyle = needs ? HL : '';
      const valText = needs ? (val ? esc(val) + ' &nbsp;<i>(confirm)</i>' : '&nbsp;') : esc(val);
      body += `<tr>`
        + `<td style="padding:5px 8px;border:1px solid #c9c9c4;text-align:center;color:#79828c;">${num}</td>`
        + `<td style="padding:5px 8px;border:1px solid #c9c9c4;">${esc(q)}</td>`
        + `<td style="padding:5px 8px;border:1px solid #c9c9c4;${valStyle}">${valText}</td>`
        + `</tr>`;
    });
    const reflag = opts.reflag ? `<p style="color:#CE181E;font-weight:bold;">NOTE: fee or schedule CHANGED since the last intake — please process as a change order.</p>` : '';
    return `<div style="font-family:Calibri,Arial,sans-serif;font-size:13px;color:#25273A;">`
      + `<p>PPM Project Intake — <b>${esc(p.name || 'New Project')}</b>${p.client ? ' · ' + esc(p.client) : ''}</p>`
      + `<p style="color:#79828c;">Yellow cells need to be completed/confirmed by the submitter before sending.</p>`
      + reflag
      + `<table style="border-collapse:collapse;border:1px solid #c9c9c4;width:100%;max-width:760px;">`
      + `<tr><td style="background:#25273A;color:#fff;font-weight:bold;padding:6px 8px;border:1px solid #c9c9c4;width:32px;">#</td>`
      + `<td style="background:#25273A;color:#fff;font-weight:bold;padding:6px 8px;border:1px solid #c9c9c4;">Inquiry</td>`
      + `<td style="background:#25273A;color:#fff;font-weight:bold;padding:6px 8px;border:1px solid #c9c9c4;">Response</td></tr>`
      + body + `</table></div>`;
  }

  /** Plain-text fallback for clients that don't accept HTML clipboard. */
  function buildPlainText(state, opts) {
    const rows = intakeRows(state, opts);
    const L = [`PPM Project Intake — ${(state.project || {}).name || 'New Project'}`, ''];
    rows.forEach(r => {
      if (r[0] === 'SECTION') { L.push('', '== ' + r[1] + ' =='); return; }
      L.push(`${r[0]}. ${r[1]}: ${r[3] && !r[2] ? '>> TO COMPLETE >>' : (r[2] || (r[3] ? '>> CONFIRM >>' : ''))}`);
    });
    return L.join('\n');
  }

  /** Select a DOM node's contents (so the user can Ctrl/Cmd+C, or we execCommand). */
  function selectNode(node) {
    if (!node) return null;
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    sel.removeAllRanges();
    sel.addRange(range);
    return sel;
  }

  /** Copy the RENDERED table from the modal. Selecting the live DOM and copying
      the selection is the most reliable way to get a true rich-table paste into
      Outlook/Gmail (more reliable than ClipboardItem text/html). */
  async function copyRenderedTable(wrap, state, opts) {
    const table = wrap.querySelector('table');
    if (!table) return false;
    selectNode(table);
    // 1) Try the legacy copy of the live selection — pastes as a real table.
    try { if (document.execCommand('copy')) return true; } catch (e) {}
    // 2) Fallback: async clipboard with html+plain.
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([table.outerHTML], { type: 'text/html' }),
        'text/plain': new Blob([buildPlainText(state, opts)], { type: 'text/plain' }),
      })]);
      return true;
    } catch (e) { return false; }
  }

  /** Open the intake preview modal (the table is rendered + auto-selected so a
      one-click Copy — or manual Ctrl/Cmd+C — yields a rich table). */
  async function copyIntake(state, opts) {
    const html = buildTableHtml(state, opts);
    showIntakeModal(state, opts, html, false);
  }

  /** Preview modal: shows the rendered table + a Copy button + recipient/subject. */
  function showIntakeModal(state, opts, html, copied) {
    const subject = `Macro Project Intake - ${(state.project || {}).name || 'New Project'}`;
    document.getElementById('ufc-intake-modal')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'ufc-intake-modal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(20,21,34,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:30px;';
    wrap.innerHTML = `
      <div style="background:#fff;max-width:840px;width:100%;max-height:90vh;overflow:auto;box-shadow:0 24px 60px rgba(0,0,0,0.3);">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 22px;border-bottom:1px solid #e6e2dc;position:sticky;top:0;background:#fff;">
          <div>
            <div style="font-family:'Savills Display',Georgia,serif;font-weight:800;font-size:18px;color:#25273A;">Project Intake — ready to send</div>
            <div style="font-family:Calibri,Arial,sans-serif;font-size:12px;color:#79828c;margin-top:3px;">To: <b>${INTAKE_TO}</b> &nbsp;·&nbsp; Subject: <b>${esc(subject)}</b></div>
          </div>
          <div style="display:flex;gap:8px;">
            <button id="ufc-intake-copy" style="font-family:'Savills Display',Arial,sans-serif;font-weight:700;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;padding:11px 16px;border:0;background:#25273A;color:#fff;cursor:pointer;">${copied ? '✓ Copied — paste into email' : 'Copy table'}</button>
            <button id="ufc-intake-mailto" style="font-family:'Savills Display',Arial,sans-serif;font-weight:700;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;padding:11px 16px;border:2px solid #25273A;background:#fff;color:#25273A;cursor:pointer;">Open blank email</button>
            <button id="ufc-intake-close" style="font-size:20px;border:0;background:transparent;cursor:pointer;color:#79828c;">×</button>
          </div>
        </div>
        <div style="padding:22px;">
          <div style="font-family:Calibri,Arial,sans-serif;font-size:12px;color:#79828c;margin-bottom:12px;">The table below is selected and ready. Click <b>Copy table</b> (or just press Ctrl/Cmd+C), then <b>Open blank email</b> and paste (Ctrl/Cmd+V) — it pastes as a formatted table. Yellow cells need completing before you send.</div>
          ${html}
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
    document.getElementById('ufc-intake-close').onclick = () => wrap.remove();
    document.getElementById('ufc-intake-copy').onclick = async () => {
      const btn = document.getElementById('ufc-intake-copy');
      const ok = await copyRenderedTable(wrap, state, opts);
      btn.textContent = ok ? '✓ Copied — paste into email' : 'Copy failed — select manually';
    };
    // Auto-select the table so the user can just Ctrl/Cmd+C if programmatic copy is blocked.
    setTimeout(() => selectNode(wrap.querySelector('table')), 60);
    document.getElementById('ufc-intake-mailto').onclick = () => {
      window.location.href = `mailto:${INTAKE_TO}?subject=${encodeURIComponent(subject)}`;
    };
  }

  window.UFC_Intake = { openIntake: copyIntake, intakeSignature, INTAKE_TO };
})();
