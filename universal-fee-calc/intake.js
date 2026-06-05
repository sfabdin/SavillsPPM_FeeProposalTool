/* ============================================================
   SAVILLS PPM · FEE SYSTEM · SALESFORCE / PROJECT INTAKE
   ------------------------------------------------------------
   Drafts the Project Intake email to PPM Accounting, pre-filled
   from the project record. Fields the record can't supply are
   marked ">> TO COMPLETE >>" (mailto bodies are plain text, so we
   flag with a text marker rather than a yellow highlight).

   Appears when a project is Won or Active. If the FEE or SCHEDULE
   changes after an intake was generated, the button re-flags so a
   change order can be re-submitted.
   ============================================================ */
(function () {
  'use strict';

  // Who receives the intake. Adjust to your real distribution list.
  const INTAKE_TO = 'macrofinance@savills.us';
  const INTAKE_CC = '';
  const TODO = '>> TO COMPLETE >>';

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  function dstr(m, y) { return (m && y) ? `${String(m).padStart(2,'0')}/01/${y}` : TODO; }
  function money(n) { return (n == null || isNaN(n)) ? TODO : '$' + Math.round(n).toLocaleString(); }

  /** A compact signature of the fee + schedule — used to detect drift. */
  function intakeSignature(state, netFee) {
    const t = state.timeline || {};
    return [Math.round(netFee || 0), t.startMonth, t.startYear, t.endMonth, t.endYear].join('|');
  }

  /** Build the intake form body from the project state. */
  function buildBody(state, opts) {
    const p = state.project || {};
    const t = state.timeline || {};
    const netFee = opts.netFee;
    const serviceLines = (opts.serviceLines || []).join(', ') || (p.scope || TODO);
    const fs = state.assumptions && state.assumptions.feeShare;
    const feeShareApplies = fs && fs.enabled;
    const leadName = opts.leadName || p.lead || '';

    const L = [];
    L.push(`PPM Accounting,`);
    L.push(``);
    L.push(`Please find the project intake details below for ${p.name || TODO}. Fields marked "${TODO}" need Accounting to complete or confirm.`);
    L.push(``);
    L.push(`================  PROJECT INTAKE  ================`);
    L.push(``);
    L.push(`-- Authorization --`);
    L.push(`1. First authorization/contract for this client?  ${TODO}`);
    L.push(`2. Tracked standalone or additive to prior WAs?  ${TODO}`);
    L.push(`3. If additive, which authorizations go together?  N/A`);
    L.push(``);
    L.push(`-- Client Payer Information --`);
    L.push(`4. Entity Name (full legal):  ${p.client || TODO}`);
    L.push(`5. Client "short name":  ${p.client || TODO}`);
    L.push(`6. Payer's Physical Address:  ${TODO}`);
    L.push(`7. Payer POC:  ${p.clientContact || TODO}`);
    L.push(`8. Payer Phone:  ${TODO}`);
    L.push(`9. Payer Email:  ${TODO}`);
    L.push(``);
    L.push(`-- Fees and Dates --`);
    L.push(`10. Total Fee (fixed fee unless noted):  ${money(netFee)}`);
    L.push(`11. Total NTE reimbursable expenses:  ${TODO}`);
    L.push(`12. Start Date:  ${dstr(t.startMonth, t.startYear)}`);
    L.push(`13. End Date:  ${dstr(t.endMonth, t.endYear)}`);
    L.push(``);
    L.push(`-- Commission --`);
    L.push(`14. Does a fee share apply?  ${feeShareApplies ? `Yes — ${fs.pct}% to broker (share co-broker agreement)` : 'No'}`);
    L.push(`15. Percentage split:  ${feeShareApplies ? `${fs.pct}% ` + TODO : 'N/A'}`);
    L.push(`16. Domestic (U.S.) fee split?  ${feeShareApplies ? TODO : 'N/A'}`);
    L.push(`17. International fee split?  N/A`);
    L.push(`18. Third Party Commission / Fees:  N/A`);
    L.push(``);
    L.push(`-- Client & Project Information --`);
    L.push(`19. Client Industry / Sector:  ${p.industry || TODO}`);
    L.push(`20. Services / Scope:  ${serviceLines}`);
    L.push(`21. Project Address:  ${p.location || TODO}`);
    L.push(`22. RSF:  ${TODO}`);
    L.push(`23. Project Budget:  ${TODO}`);
    L.push(``);
    L.push(`=================================================`);
    L.push(``);
    L.push(`Savills lead: ${leadName || TODO}`);
    L.push(`Status: ${opts.statusLabel || ''}`);
    if (opts.reflag) L.push(`\n*** NOTE: fee or schedule CHANGED since the last intake — please process as a change order. ***`);
    return L.join('\n');
  }

  /** Open the drafted intake email. */
  function openIntake(state, opts) {
    const subject = `Macro Project Intake - ${(state.project && state.project.name) || 'New Project'}`;
    const body = buildBody(state, opts);
    const href = `mailto:${encodeURIComponent(INTAKE_TO)}`
      + `?cc=${encodeURIComponent(INTAKE_CC)}`
      + `&subject=${encodeURIComponent(subject)}`
      + `&body=${encodeURIComponent(body)}`;
    // mailto length guard: if too long for some clients, fall back to clipboard.
    if (href.length > 1900 && navigator.clipboard) {
      navigator.clipboard.writeText('To: ' + INTAKE_TO + '\nSubject: ' + subject + '\n\n' + body)
        .then(() => alert('The intake email was copied to your clipboard (too long for a direct draft) — paste it into a new email to ' + INTAKE_TO + '.'))
        .catch(() => { window.location.href = href; });
      return;
    }
    window.location.href = href;
  }

  window.UFC_Intake = { openIntake, intakeSignature, buildBody, INTAKE_TO };
})();
