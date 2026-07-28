/* ============================================================
   SAVILLS PPM · FEE & REVENUE SYSTEM · PROJECT INTAKE
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
  const RED = 'color:#CE181E;font-weight:bold;';   // pre-filled but MUST be confirmed
  const NAME_CONFIRM = 'Please confirm that this is the name you want this project referred to in Salesforce and Clockify.';

  function dstr(m, y) { return (m && y) ? `${String(m).padStart(2, '0')}/01/${y}` : ''; }
  function money(n) { return (n == null || isNaN(n)) ? '' : '$' + Math.round(n).toLocaleString(); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  function intakeSignature(state, netFee) {
    const t = state.timeline || {};
    return [Math.round(netFee || 0), t.startMonth, t.startYear, t.endMonth, t.endYear].join('|');
  }

  /** Rows: [num, question, value, needsInput, kind].
      needsInput → yellow highlight. kind 'confirm' → red, pre-filled but must be
      verified before sending. Order and wording follow DOC A · Project Intake
      Process & Form (2026.06.08). */
  function intakeRows(state, opts) {
    const p = state.project || {};
    const t = state.timeline || {};
    const fs = state.assumptions && state.assumptions.feeShare;
    const feeShare = fs && fs.enabled;
    const scope = (opts.serviceLines || []).join(', ');
    return [
      ['SECTION', 'Authorization'],
      [1, 'Is this the first authorization/contract for this client?', '', true],
      [2, 'If not, does the client expect this authorization to be tracked and invoiced separately (standalone), or is this WA additive to prior WAs (i.e. where does this fit within the client’s portfolio)?', '', true],
      [3, 'If additive, which authorizations/contracts go together?', 'N/A', false],
      ['SECTION', 'Client & Project Information'],
      [4, 'Project Name', p.name || '', !p.name, 'confirm'],
      [5, 'Client Industry / Sector', p.industry || '', !p.industry],
      [6, 'Services / Scope', scope, !scope],
      [7, 'Project’s Complete Address', p.location || '', !p.location],
      [8, 'RSF', '', true],
      [9, 'Project Budget', '', true],
      ['SECTION', 'Client Payer Information'],
      [10, 'Contracting Entity Name — is it different from the payer entity?', p.client || '', !p.client],
      [11, 'Client “short name” [i.e. Comcast]', p.client || '', !p.client],
      [12, 'Payer’s Physical Address', '', true],
      [13, 'Payer POC', p.clientContact || '', !p.clientContact],
      [14, 'Payer Email', '', true],
      [15, 'Payer Terms', '', true],
      [16, 'Provide the names and emails of those who should be copied on invoices.', '', true],
      [17, 'Provide payment schedule', '', true],
      [18, 'Does the client require any vendor onboarding forms to be completed, banking authorization letter, W9, etc.?', '', true],
      ['SECTION', 'Fees and Dates'],
      [19, 'Total Fee [explain if this is fixed fee or timecard]', money(opts.netFee), opts.netFee == null],
      [20, 'Total NTE reimbursable expenses', '', true],
      [21, 'Start Date [explain if contract start differs from work start]', dstr(t.startMonth, t.startYear), !(t.startMonth && t.startYear)],
      [22, 'End Date [explain if contract end differs from work end]', dstr(t.endMonth, t.endYear), !(t.endMonth && t.endYear)],
      ['SECTION', 'Commission'],
      [23, 'Does a fee share apply? [if yes, include a co-broker agreement or co-broker understanding email with this email]', feeShare ? `Yes — ${fs.pct}% to broker (attach co-broker agreement)` : 'No', false],
      [24, 'Percentage split [be specific, especially if this is not a simple % to one broker]', feeShare ? `${fs.pct}%` : 'N/A', feeShare],
      [25, 'Is this a domestic (U.S.) fee split? [if yes, state the % split, broker name(s), office, and team]', feeShare ? '' : 'N/A', feeShare],
      [26, 'Is this an international fee split? [if yes, state the % split, broker name(s), office, team, and international Savills entity]', 'N/A', false],
      [27, 'Third Party Commission / Fees [if applicable — for us this would be a subcontractor, rarely applicable]', 'N/A', false],
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
      const [num, q, val, needs, kind] = r;
      const isConfirm = kind === 'confirm';
      let valStyle = needs ? HL : '';
      let valText = needs ? (val ? esc(val) + ' &nbsp;<i>(confirm)</i>' : '&nbsp;') : esc(val);
      if (isConfirm) {
        // Pre-filled from the calculator, but names repeat across projects — so it
        // reads in red with an explicit confirmation note.
        valStyle = val ? RED : HL;
        valText = (val ? `<span style="${RED}">${esc(val)}</span>` : '&nbsp;')
          + `<div style="color:#CE181E;font-size:11px;font-style:italic;margin-top:3px;">${NAME_CONFIRM}</div>`;
      }
      body += `<tr>`
        + `<td style="padding:5px 8px;border:1px solid #c9c9c4;text-align:center;color:#79828c;">${num}</td>`
        + `<td style="padding:5px 8px;border:1px solid #c9c9c4;">${esc(q)}</td>`
        + `<td style="padding:5px 8px;border:1px solid #c9c9c4;${valStyle}">${valText}</td>`
        + `</tr>`;
    });
    const reflag = opts.reflag ? `<p style="color:#CE181E;font-weight:bold;">NOTE: fee or schedule CHANGED since the last intake — please process as a change order.</p>` : '';
    const FF = "'Gotham','Montserrat',Tahoma,Arial,sans-serif";
    return `<div style="font-family:${FF};font-size:13px;color:#25273A;">`
      + `<p>PPM Project Intake — <b>${esc(p.name || 'New Project')}</b>${p.client ? ' · ' + esc(p.client) : ''}</p>`
      + `<p style="color:#79828c;">Yellow cells need to be completed/confirmed by the submitter before sending. <span style="color:#CE181E;">Red</span> is pre-filled from the fee record and must be confirmed.</p>`
      + reflag
      + `<table style="border-collapse:collapse;border:1px solid #c9c9c4;width:100%;max-width:760px;font-family:${FF};">`
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
      if (r[4] === 'confirm') L.push(`    >> ${NAME_CONFIRM}`);
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
    const subject = `PPM Project Intake - ${(state.project || {}).name || 'New Project'}`;
    document.getElementById('ufc-intake-modal')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'ufc-intake-modal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(20,21,34,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:30px;';
    wrap.innerHTML = `
      <div style="background:#fff;max-width:840px;width:100%;max-height:90vh;overflow:auto;box-shadow:0 24px 60px rgba(0,0,0,0.3);">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 22px;border-bottom:1px solid #e6e2dc;position:sticky;top:0;background:#fff;">
          <div>
            <div style="font-family:var(--font-display),'Gotham',Arial,sans-serif;font-weight:900;font-size:18px;color:#25273A;">Project Intake — ready to send</div>
            <div style="font-family:var(--font-body),'Gotham',Arial,sans-serif;font-size:12px;color:#79828c;margin-top:3px;">To: <b>${INTAKE_TO}</b> &nbsp;·&nbsp; Subject: <b>${esc(subject)}</b></div>
          </div>
          <div style="display:flex;gap:8px;">
            <button id="ufc-intake-copy" style="font-family:var(--font-display),'Gotham',Arial,sans-serif;font-weight:700;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;padding:11px 16px;border:0;background:#25273A;color:#fff;cursor:pointer;">${copied ? '✓ Copied — paste into email' : 'Copy table'}</button>
            <button id="ufc-intake-mailto" style="font-family:var(--font-display),'Gotham',Arial,sans-serif;font-weight:700;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;padding:11px 16px;border:2px solid #25273A;background:#fff;color:#25273A;cursor:pointer;">Open blank email</button>
            <button id="ufc-intake-close" style="font-size:20px;border:0;background:transparent;cursor:pointer;color:#79828c;">×</button>
          </div>
        </div>
        <div style="padding:22px;">
          <div style="font-family:var(--font-body),'Gotham',Arial,sans-serif;font-size:12px;color:#79828c;margin-bottom:12px;">The table below is selected and ready. Click <b>Copy table</b> (or just press Ctrl/Cmd+C), then <b>Open blank email</b> and paste (Ctrl/Cmd+V) — it pastes as a formatted table. Yellow cells need completing before you send.</div>
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
