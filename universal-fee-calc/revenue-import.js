/* ============================================================
   SAVILLS PPM · INGESTION STUDIO — REVENUE PROJECTIONS (BULK)
   ------------------------------------------------------------
   Upload a revenue leader's "3. Detailed Revenues" workbook, diff it
   against what's already in the system, and let an admin pick which
   projects to bring in — never a blind overwrite.

     • Parses the "3. Detailed Revenues" tab by locating its header row
       (matches on "Client"/"Project" columns) and its monthly columns
       by DATE VALUE rather than a hardcoded column index, so a sheet
       that gains/loses a year block or a column still parses.
     • A "project" in the sheet may span several rows (Base Contract +
       amendments) sharing one Project ID — these are summed into one
       group before anything else happens.
     • Only groups with revenue in 2026 or 2027 are kept (leadership's
       cutoff for this cycle) — a group with $0 in both years is
       dropped before matching even runs.
     • Matches each group to an existing project: Project ID first
       (best-effort — the sheet's IDs are D365/Salesforce codes that
       may not always line up with what's stored), then a token-based
       name+client match (same approach as staff.js's matchFeeProject).
       Every row also gets a manual override control, because the
       auto-match is a starting point, not a verdict.
     • Diffs against monthlySeries(p, catalog) — the SAME figure the
       app already shows everywhere (override-if-set, else computed,
       else a locked original import) — so "what would change" here
       means what would actually change on that project's page.
     • Import writes into project.monthlyOverrides, the exact field
       Revenue Projections' manual "✎ Edit" already writes to. Nothing
       new is invented; this is that same mechanism, in bulk.
   ============================================================ */
(function () {
  'use strict';
  const STORE = window.UFC_Store;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => (n == null || isNaN(n)) ? '—' : (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString();
  const uid = () => 'proj_' + Math.random().toString(36).slice(2, 11);

  /* ---------- token-based name matching (same approach as staff.js) ---------- */
  const STOP_WORDS = new Set(['the', 'of', 'and', 'a', 'an', 'for', 'to', 'at', 'in', 'on', 'llc', 'inc', 'corp', 'project', 'phase']);
  function nameTokens(s) { return String(s || '').toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(t => t && t.length > 1 && !STOP_WORDS.has(t)); }
  function tokenScore(a, b) {
    const ta = nameTokens(a), tb = nameTokens(b);
    if (!ta.length || !tb.length) return 0;
    const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    let hit = 0;
    small.forEach(t => {
      if (big.includes(t)) { hit += 1; return; }
      if (big.some(bt => (bt.length >= 3 && t.startsWith(bt)) || (t.length >= 3 && bt.startsWith(t)))) hit += 0.75;
    });
    return hit / small.length;
  }
  /** Does anyone's work depend on this project's roster? A project with real
      staffing is a project a revenue leader has spent time on — its numbers
      are never auto-changed by an import. */
  function hasStaffing(p) {
    return !!(p && (p.roles || []).some(r =>
      Object.values(r.fte || {}).some(v => +v > 0) || Object.values(r.fteMonthly || {}).some(v => +v > 0)));
  }
  /** Sticky match memory. A confirmed sheet-row → project link is written onto
      the project (source.sheetKeys) so the NEXT revision of the workbook
      matches instantly instead of re-running the whole guessing exercise.
      Record-level, so it survives the Box merge like everything else. */
  function sheetKeysOf(p) { return ((p.source && p.source.sheetKeys) || []).map(k => String(k).toLowerCase()); }
  function rememberMatch(projectId, groupKey) {
    const p = STORE.getProject(projectId);
    if (!p) return;
    const keys = sheetKeysOf(p);
    if (keys.includes(String(groupKey).toLowerCase())) return;
    const next = { ...p, source: { ...(p.source || {}), sheetKeys: keys.concat([String(groupKey).toLowerCase()]) } };
    try { STORE.saveProject(next, { baseUpdatedAt: p.updatedAt }); } catch (e) { /* non-fatal: matching still works this session */ }
  }
  /** The other half rememberMatch never had: strip this sheet row's remembered
      key from EVERY project that holds it. Without this, changing your mind
      leaves the old link behind and the row keeps snapping back to it. */
  function forgetMatch(groupKey) {
    const gk = String(groupKey).toLowerCase();
    STORE.listProjects().forEach(p => {
      const keys = sheetKeysOf(p);
      if (!keys.includes(gk)) return;
      const next = { ...p, source: { ...(p.source || {}), sheetKeys: keys.filter(k => k !== gk) } };
      try { STORE.saveProject(next, { baseUpdatedAt: p.updatedAt }); } catch (e) { /* non-fatal */ }
    });
  }

  function buildProjectIndex() {
    return STORE.listProjects().map(p => ({
      id: p.id,
      name: (p.project && p.project.name) || '',
      client: (p.project && p.project.client) || '',
      sf: String((p.project && p.project.salesforceId) || '').trim().toLowerCase(),
      keys: sheetKeysOf(p),
      staffed: hasStaffing(p),
      label: ((p.project && p.project.client) || '') + ' — ' + ((p.project && p.project.name) || ''),
    }));
  }
  function matchGroup(idx, g) {
    // 1) a link a human already confirmed on a previous revision — trusted absolutely
    const gk = String(g.key).toLowerCase();
    const remembered = idx.find(p => p.keys.includes(gk));
    if (remembered) return { id: remembered.id, label: remembered.label, via: 'confirmed' };
    if (g.projectId) {
      const key = g.projectId.trim().toLowerCase();
      const hit = idx.find(p => p.sf && p.sf === key);
      if (hit) return { id: hit.id, label: hit.label, via: 'id' };
    }
    let best = null, bestScore = 0;
    idx.forEach(p => {
      let s = tokenScore(g.project, p.name);
      if (g.client && p.client) s = s * 0.8 + tokenScore(g.client, p.client) * 0.2;
      if (s > bestScore) { bestScore = s; best = p; }
    });
    if (best && bestScore >= 0.6) return { id: best.id, label: best.label, via: 'name', score: Math.round(bestScore * 100) };
    return null;
  }

  /* ---------- parse "3. Detailed Revenues" ---------- */
  async function parseWorkbook(file) {
    const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const sheetName = wb.SheetNames.find(n => /3[.\s]*detailed\s*revenues/i.test(n)) || wb.SheetNames.find(n => /detailed\s*revenues/i.test(n));
    if (!sheetName) throw new Error(`No "3. Detailed Revenues" tab found. Sheets in this file: ${wb.SheetNames.join(', ')}`);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
    return rows;
  }

  function findCol(header, re) { return header.findIndex(c => re.test(String(c == null ? '' : c).trim())); }

  function extractRows(rows) {
    const headerRowIdx = rows.findIndex(r => Array.isArray(r) && findCol(r, /^client$/i) >= 0 && findCol(r, /^project$/i) >= 0);
    if (headerRowIdx < 0) throw new Error('Could not find the header row — expected columns named "Client" and "Project".');
    const header = rows[headerRowIdx];
    const col = {
      client: findCol(header, /^client$/i),
      project: findCol(header, /^project$/i),
      projectId: findCol(header, /^project\s*id$/i),
      startDate: findCol(header, /^start\s*date$/i),
      endDate: findCol(header, /^end\s*date$/i),
      newOrEdit: findCol(header, /^new\s*or\s*edit$/i),
      revenueType: findCol(header, /^revenue\s*type$/i),
      contractType: findCol(header, /^contract\s*type$/i),
      rating: findCol(header, /rating.*likeli/i),
      leader: findCol(header, /revenue\s*leader/i),
      originator: findCol(header, /revenue\s*originator/i),
      support: findCol(header, /revenue\s*support/i),
    };
    // Finance's own rationale lives in a "Comments" column after each year
    // block. Carrying it through is the whole point of the review report —
    // "why did this move?" is answered by the person who moved it.
    const commentCols = [];
    header.forEach((v, i) => { if (/^comments?$/i.test(String(v == null ? '' : v).trim())) commentCols.push(i); });
    // Month columns are literal Date values in the header row; group by year.
    // "Total YYYY" columns are labeled text, found the same way.
    const monthCols = {}, totalCols = {};
    header.forEach((v, i) => {
      if (v instanceof Date) {
        const y = v.getFullYear(), m = v.getMonth() + 1;
        (monthCols[y] = monthCols[y] || []).push({ col: i, month: m });
      } else {
        const m = /^total\s+(\d{4})/i.exec(String(v == null ? '' : v).trim());
        if (m) totalCols[+m[1]] = i;
      }
    });
    Object.keys(monthCols).forEach(y => monthCols[y].sort((a, b) => a.month - b.month));
    const years = Object.keys(monthCols).map(Number).sort();

    const out = [];
    for (let r = headerRowIdx + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const client = row[col.client];
      if (!client || !String(client).trim()) continue;   // real-row rule: a legend/total/adjustment row never has a Client
      const byYear = {}, totalsByYear = {};
      years.forEach(y => {
        byYear[y] = {};
        monthCols[y].forEach(mc => { byYear[y][mc.month] = Number(row[mc.col]) || 0; });
        totalsByYear[y] = totalCols[y] != null ? (Number(row[totalCols[y]]) || 0) : Object.values(byYear[y]).reduce((s, v) => s + v, 0);
      });
      out.push({
        rowNum: r + 1,
        client: String(client).trim(),
        project: String(row[col.project] || '').trim(),
        projectId: col.projectId >= 0 ? String(row[col.projectId] || '').trim() : '',
        startDate: col.startDate >= 0 ? row[col.startDate] : null,
        endDate: col.endDate >= 0 ? row[col.endDate] : null,
        newOrEdit: col.newOrEdit >= 0 ? row[col.newOrEdit] : null,
        revenueType: col.revenueType >= 0 ? String(row[col.revenueType] || '') : '',
        contractType: col.contractType >= 0 ? String(row[col.contractType] || '') : '',
        rating: col.rating >= 0 ? String(row[col.rating] || '') : '',
        leader: col.leader >= 0 ? String(row[col.leader] || '') : '',
        originator: col.originator >= 0 ? String(row[col.originator] || '') : '',
        support: col.support >= 0 ? String(row[col.support] || '') : '',
        comments: commentCols.map(c => String(row[c] == null ? '' : row[c]).trim()).filter(Boolean).join(' · '),
        byYear, totalsByYear,
      });
    }
    return { rows: out, years };
  }

  /** A fee-share-to-another-party row is booked as its OWN row on the sheet —
      same Client/Project/Project ID as the "real" revenue rows for that
      project, just with this revenue type and a negative $ sign. It's not a
      separate project; it's a deduction from the one it shares an ID with. */
  const FEESHARE_OUT_RX = /revenue\s*out|fee\s*shar.*other\s*party/i;
  function isFeeShareOutRow(r) {
    if (!FEESHARE_OUT_RX.test(r.revenueType || '')) return false;
    return Object.values(r.totalsByYear).some(v => v < 0);
  }

  /** EVERY sheet row is its own contract/engagement — rows are NEVER summed,
      even when they share a Project ID (Base Contract + amendment are two
      engagements that must map to two separate project records). The single
      exception is a fee-share-out row: the sheet books the broker deduction
      as its own negative row against the same Project ID, and that is an
      adjustment to an engagement, not an engagement — it attaches to the
      sibling row whose revenue months it overlaps. Gross revenue and the
      deduction stay tracked separately (byYear is gross-only, matching what
      "revenue" means everywhere else in the app) so feeSharePct can be
      computed without silently netting.
      Keys: a lone row keeps the historical key (id:… / nc:…) so remembered
      matches survive; siblings sharing a base key get #e1, #e2… in sheet
      order. */
  function groupRows(dataRows, years) {
    const zeroByYear = () => { const o = {}; years.forEach(y => { o[y] = {}; for (let m = 1; m <= 12; m++) o[y][m] = 0; }); return o; };
    const zeroTotals = () => { const o = {}; years.forEach(y => { o[y] = 0; }); return o; };
    const baseOf = (r) => r.projectId ? 'id:' + r.projectId.toLowerCase() : 'nc:' + r.client.toLowerCase() + '|' + r.project.toLowerCase();
    const engRows = dataRows.filter(r => !isFeeShareOutRow(r));
    const feeRows = dataRows.filter(isFeeShareOutRow);
    const byBase = {};
    engRows.forEach(r => { (byBase[baseOf(r)] = byBase[baseOf(r)] || []).push(r); });
    const out = []; const groupsByBase = {};
    Object.entries(byBase).forEach(([base, rs]) => {
      rs.forEach((r, i) => {
        const g = {
          key: rs.length === 1 ? base : base + '#e' + (i + 1),
          client: r.client, project: r.project, projectId: r.projectId,
          rating: r.rating, revenueType: r.revenueType, contractType: r.contractType, leader: r.leader,
          newOrEdit: r.newOrEdit, originator: r.originator, support: r.support,
          comments: r.comments || '',
          startDate: r.startDate, endDate: r.endDate,
          byYear: zeroByYear(), totalsByYear: zeroTotals(),
          brokerByYear: zeroByYear(), brokerTotalsByYear: zeroTotals(),
          rows: [r],
          engIdx: rs.length > 1 ? i + 1 : 0, engCount: rs.length,
        };
        years.forEach(y => {
          Object.keys(r.byYear[y] || {}).forEach(m => { g.byYear[y][m] += r.byYear[y][m] || 0; });
          g.totalsByYear[y] += r.totalsByYear[y] || 0;
        });
        out.push(g); (groupsByBase[base] = groupsByBase[base] || []).push(g);
      });
    });
    // attach each fee-share-out row to the sibling engagement its months overlap
    feeRows.forEach(r => {
      const sibs = groupsByBase[baseOf(r)] || [];
      let target = null, best = -1;
      sibs.forEach(g => {
        let ov = 0;
        years.forEach(y => { for (let m = 1; m <= 12; m++) if (Math.abs(r.byYear[y][m] || 0) >= 0.5 && Math.abs(g.byYear[y][m] || 0) >= 0.5) ov++; });
        const score = ov * 1e9 + Object.values(g.totalsByYear).reduce((s, v) => s + v, 0);
        if (score > best) { best = score; target = g; }
      });
      if (!target) return;   // orphan deduction with no gross sibling — nothing to net against, and a $0-gross group would be filtered anyway
      target.rows.push(r);
      if (r.comments && target.comments.indexOf(r.comments) < 0) target.comments = (target.comments ? target.comments + ' · ' : '') + r.comments;
      years.forEach(y => {
        Object.keys(r.byYear[y] || {}).forEach(m => { target.brokerByYear[y][m] += Math.abs(r.byYear[y][m] || 0); });
        target.brokerTotalsByYear[y] += Math.abs(r.totalsByYear[y] || 0);
      });
    });
    out.forEach(g => {
      const gross = Object.values(g.totalsByYear).reduce((s, v) => s + v, 0);
      const broker = Object.values(g.brokerTotalsByYear).reduce((s, v) => s + v, 0);
      g.feeSharePct = gross > 0 ? Math.round((broker / gross) * 1000) / 10 : 0;
    });
    return out;
  }

  /** Leadership's cutoff for this cycle: drop anything with $0 in both 2026 and 2027. */
  function filterGroups(groups) {
    return groups.filter(g => Math.round(g.totalsByYear[2026] || 0) !== 0 || Math.round(g.totalsByYear[2027] || 0) !== 0);
  }

  /* ---------- diff against what's currently in effect ---------- */
  function currentSeriesByYear(project, years) {
    const catalog = window.RATES_CATALOG;
    const series = STORE.monthlySeries(project, catalog) || [];
    const out = {};
    years.forEach(y => { out[y] = {}; for (let m = 1; m <= 12; m++) out[y][m] = 0; });
    series.forEach(s => { if (out[s.year]) out[s.year][s.month] = s.amount || 0; });
    return out;
  }
  function lockedByOriginalImport(project) {
    return !!(project && project.source && project.source.importedByMonth && !project.source.reconciled);
  }

  /** What KIND of staffing sits on a project. 'zeroSeed' = every role was
      written by OUR matrix seeding at a $0 contracted placeholder — the
      revenue is override-driven regardless of the roster, so moving the
      dollars can't fight anyone's fee model. 'priced' = someone has real
      rates on it. */
  function staffingKind(p) {
    if (!hasStaffing(p)) return 'none';
    const roles = p.roles || [];
    return roles.every(r => r.rateSource === 'contracted' && !(+r.contractedRate || 0)) ? 'zeroSeed' : 'priced';
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ymLbl = (y, m) => MON[m - 1] + ' ’' + String(y).slice(2);
  /** First and last month the sheet actually carries revenue for this group. */
  function sheetSpan(g, years) {
    let first = null, last = null;
    years.slice().sort((a, b) => a - b).forEach(y => {
      for (let m = 1; m <= 12; m++) if (Math.abs(g.byYear[y][m] || 0) >= 0.5) { if (!first) first = { y, m }; last = { y, m }; }
    });
    return first ? { first, last, label: ymLbl(first.y, first.m) + ' – ' + ymLbl(last.y, last.m) } : null;
  }
  function toolSpan(p) {
    const t = p && p.timeline;
    if (!t || !t.startYear) return null;
    return { first: { y: t.startYear, m: t.startMonth }, last: { y: t.endYear, m: t.endMonth }, label: ymLbl(t.startYear, t.startMonth) + ' – ' + ymLbl(t.endYear, t.endMonth) };
  }
  /** Timeframes "match" when the sheet's revenue months fall inside the tool's
      project timeline — the sheet only shows 2026/27, so demanding equality
      would flag every multi-year project. */
  function spanFits(sheet, tool) {
    if (!sheet || !tool) return false;
    const k = (x) => x.y * 12 + x.m;
    return k(sheet.first) >= k(tool.first) && k(sheet.last) <= k(tool.last);
  }
  function toolTotalFor(p, years) {
    const cur = currentSeriesByYear(p, years);
    let t = 0; years.forEach(y => { for (let m = 1; m <= 12; m++) t += cur[y][m] || 0; });
    return t;
  }

  function diffGroup(g, matchedProject, years) {
    const sheetTotal = years.reduce((s, y) => s + (g.totalsByYear[y] || 0), 0);
    if (!matchedProject) {
      return { isNew: true, changedMonths: 0, totalDelta: sheetTotal, sheetTotal, toolTotal: 0, current: null, sheetSpan: sheetSpan(g, years), toolSpan: null, spanOk: false };
    }
    const current = currentSeriesByYear(matchedProject, years);
    let changedMonths = 0, totalDelta = 0;
    years.forEach(y => {
      for (let m = 1; m <= 12; m++) {
        const sheetV = Math.round((g.byYear[y][m] || 0) * 100) / 100;
        const curV = Math.round((current[y][m] || 0) * 100) / 100;
        if (Math.abs(sheetV - curV) >= 0.5) { changedMonths++; totalDelta += (sheetV - curV); }
      }
    });
    const sSpan = sheetSpan(g, years), tSpan = toolSpan(matchedProject);
    return {
      isNew: false, changedMonths, totalDelta, current,
      sheetTotal, toolTotal: toolTotalFor(matchedProject, years),
      sheetSpan: sSpan, toolSpan: tSpan, spanOk: spanFits(sSpan, tSpan),
      locked: lockedByOriginalImport(matchedProject),
      staffed: hasStaffing(matchedProject),
      staffKind: staffingKind(matchedProject),
      reconciled: !!(matchedProject.source && matchedProject.source.reconciled),
    };
  }

  /* ---------- classification: what KIND of decision is each row? ----------
     Drives both the default selection and the review report. The rule that
     matters: nothing auto-applies to a project someone has already staffed,
     and nothing auto-creates from a row we couldn't match. */
  const CLASS = {
    unchanged:  { label: 'No change',            tone: '',     auto: false },
    safe:       { label: 'Money moved · safe',   tone: 'ok',   auto: true  },
    review:     { label: 'Money moved · PRICED STAFFING — review', tone: 'warn', auto: false },
    reconciledChanged: { label: 'RECONCILED — number changed', tone: 'bad', auto: false },
    newProj:    { label: 'New project',          tone: 'warn', auto: false },
    unmatched:  { label: 'No match — needs a human', tone: 'bad', auto: false },
  };
  function classify(g, matchedId) {
    if (!matchedId) {
      // finance flagged it New → it genuinely is one; otherwise it's a row we
      // failed to match, and creating it blind is how duplicates are born.
      return /new/i.test(String(g.newOrEdit || '')) ? 'newProj' : 'unmatched';
    }
    const p = STORE.getProject(matchedId);
    const d = diffGroup(g, p, state.years);
    if (!d.changedMonths) return 'unchanged';
    // A project someone MARKED RECONCILED runs on its fee model now — the
    // sheet moving its number is a conversation, never an auto-apply.
    if (d.reconciled) return 'reconciledChanged';
    // Staffing WE seeded at $0 placeholder rates doesn't price anything —
    // the dollars are override-driven either way, so moving them is safe.
    if (d.staffKind === 'priced') return 'review';
    return 'safe';
  }

  /* ---------- new lightweight project (override-driven, no roster) ---------- */
  function monthsFromDates(startDate, endDate, years) {
    if (startDate instanceof Date && endDate instanceof Date) {
      return { startMonth: startDate.getMonth() + 1, startYear: startDate.getFullYear(), endMonth: endDate.getMonth() + 1, endYear: endDate.getFullYear() };
    }
    // fall back to spanning the years the sheet actually carries revenue for
    const y0 = Math.min(...years), y1 = Math.max(...years);
    return { startMonth: 1, startYear: y0, endMonth: 12, endYear: y1 };
  }
  /** THE WORKBOOK IS THE RECORD OF WHAT WAS BILLED. Its past months are
      actuals — late-billed work, deliberate accrual timing, GL adjustments —
      so they are imported as-is and BECOME the history in the tool. The
      history that must never be rewritten is the sheet's, not the tool's:
      a past month is preserved by taking the sheet's number, not by keeping
      whatever the fee model happened to compute.
      (Landing in monthlyOverrides is what makes that stick — an override
      always wins over the roster-derived figure, so a later staffing edit
      can't retroactively restate a billed month.)
      `futureOnly` exists for the rare case where finance wants forward-only
      movement; it is OFF by default. */
  function currentYM() { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth() + 1 }; }
  function isPastMonth(y, m) { const c = currentYM(); return y < c.y || (y === c.y && m < c.m); }
  function buildOverrides(g, years, opts) {
    const futureOnly = !!(opts && opts.futureOnly);
    const ov = {};
    years.forEach(y => {
      for (let m = 1; m <= 12; m++) {
        if (futureOnly && isPastMonth(y, m)) continue;
        const v = g.byYear[y][m] || 0;
        if (v) ov[y + '-' + m] = Math.round(v * 100) / 100;
      }
    });
    return ov;
  }
  /** How much of a proposed change lands on already-closed months — worth
      seeing in the report, because restating a billed month is a fact
      finance should notice even when it's the right thing to do. */
  function pastImpact(g, matchedProject, years) {
    if (!matchedProject) return { months: 0, delta: 0 };
    const current = currentSeriesByYear(matchedProject, years);
    let months = 0, delta = 0;
    years.forEach(y => {
      for (let m = 1; m <= 12; m++) {
        if (!isPastMonth(y, m)) continue;
        const sheetV = Math.round((g.byYear[y][m] || 0) * 100) / 100;
        const curV = Math.round((current[y][m] || 0) * 100) / 100;
        if (Math.abs(sheetV - curV) >= 0.5) { months++; delta += sheetV - curV; }
      }
    });
    return { months, delta };
  }
  function buildBrokerByMonth(g, years) {
    const ov = {};
    years.forEach(y => { for (let m = 1; m <= 12; m++) { const v = (g.brokerByYear[y] || {})[m] || 0; if (v) ov[y + '-' + m] = Math.round(v * 100) / 100; } });
    return ov;
  }
  function createLightweightProject(g, years) {
    const tl = monthsFromDates(g.startDate, g.endDate, years);
    const totalMonths = Math.max(1, (tl.endYear - tl.startYear) * 12 + (tl.endMonth - tl.startMonth) + 1);
    const booked = /^1\s*:/.test(g.rating || '');
    const hasFeeShare = g.feeSharePct > 0;
    const record = {
      project: {
        name: g.project || 'Untitled', client: g.client || '', lead: '', proposalDate: new Date().toISOString().slice(0, 10),
        location: '', status: booked ? 'won' : 'negotiation', industry: '',
        firstProposalDate: '', signedContractDate: '', clientContact: '', clientRelOwner: '',
        salesforceId: g.projectId || '',
      },
      timeline: { startMonth: tl.startMonth, startYear: tl.startYear, endMonth: tl.endMonth, endYear: tl.endYear },
      phases: [{ id: uid(), name: 'Full term', length: totalMonths }],
      groups: [{ id: uid(), name: 'Core team' }],
      roles: [],
      assumptions: {
        hrsPerMo: 173.33, escalation: 3.0, industryAdj: 20, discount: 0, rateLock: false, billingMode: 'phase',
        catalogBaseYear: (window.RATES_CATALOG && window.RATES_CATALOG.baseYear) || 2024,
        feeShare: { enabled: hasFeeShare, pct: hasFeeShare ? g.feeSharePct : 0, mode: 'offtop' },
      },
      // a brand-new project has no history to protect — take every month
      monthlyOverrides: buildOverrides(g, years, { futureOnly: false }),
      source: {
        type: 'revenue-import', name: state.fileName || 'revenue projections', ingestedAt: new Date().toISOString(),
        sheetProjectId: g.projectId || null, sheetRating: g.rating || null,
        sheetKeys: [String(g.key).toLowerCase()],
        brokerByMonth: hasFeeShare ? buildBrokerByMonth(g, years) : undefined,
      },
    };
    return STORE.saveProject(record);
  }
  function applyOverridesToProject(projectId, g, years, opts) {
    const p = STORE.getProject(projectId);
    if (!p) throw new Error('Matched project no longer exists — it may have been deleted.');
    // ONLY monthlyOverrides move. The roster, rates, phases and every other
    // field a revenue leader has been working on are left exactly as they are.
    const ov = Object.assign({}, p.monthlyOverrides || {}, buildOverrides(g, years, opts));
    const keys = sheetKeysOf(p);
    const gk = String(g.key).toLowerCase();
    const next = {
      ...p,
      monthlyOverrides: ov,
      source: { ...(p.source || {}), sheetKeys: keys.includes(gk) ? keys : keys.concat([gk]) },
    };
    return STORE.saveProject(next, { baseUpdatedAt: p.updatedAt });
  }

  /* ---------- state + render ---------- */
  const state = { fileName: '', years: [], groups: [], projectIndex: [], overrides: {}, included: new Set(), futureOnly: false };

  function setStatus(msg, cls) {
    const el = $('#ri-status'); if (!el) return;
    el.textContent = msg || ''; el.className = 'src-status' + (cls ? ' ' + cls : '');
  }

  function matchedIdFor(g) {
    return state.overrides[g.key] !== undefined ? state.overrides[g.key] : ((g.match && g.match.id) || null);
  }
  /** The other direction of a full-book comparison: projects in the tool
      that no sheet row matched. Only projects that actually carry revenue in
      the sheet's years — a dormant record absent from the sheet is no news. */
  function missingFromSheet() {
    const matched = new Set();
    state.groups.forEach(g => { const id = matchedIdFor(g); if (id) matched.add(id); });
    return state.projectIndex
      .filter(p => !matched.has(p.id))
      .map(p => {
        const rec = STORE.getProject(p.id);
        if (!rec) return null;
        const tot = toolTotalFor(rec, state.years);
        if (Math.abs(tot) < 1) return null;
        return { id: p.id, label: p.label, rec, tot, span: toolSpan(rec), kind: staffingKind(rec), reconciled: !!(rec.source && rec.source.reconciled) };
      })
      .filter(Boolean)
      .sort((a, b) => Math.abs(b.tot) - Math.abs(a.tot));
  }

  /** Of the ticked rows, which would UPDATE an existing project (a match
      exists — only its monthly $ move) vs CREATE a brand-new one (no match). */
  function selectionSplit() {
    let updates = 0; const creates = [];
    state.groups.forEach(g => {
      if (!state.included.has(g.key)) return;
      if (matchedIdFor(g)) updates++; else creates.push((g.client ? g.client + ' — ' : '') + g.project);
    });
    return { updates, creates };
  }

  function summarize() {
    const counts = { unchanged: 0, safe: 0, review: 0, reconciledChanged: 0, newProj: 0, unmatched: 0 };
    state.groups.forEach(g => { counts[classify(g, matchedIdFor(g))]++; });
    return { total: state.groups.length, ...counts, feeShare: state.groups.filter(g => g.feeSharePct > 0).length, selected: state.included.size, missing: state.groups.length ? missingFromSheet().length : 0 };
  }

  function renderSummary() {
    const s = summarize();
    $('#ri-sum').innerHTML = `
      <div class="sumcard"><div class="lbl">Engagements (sheet rows)</div><div class="val">${s.total}</div></div>
      <div class="sumcard ok"><div class="lbl">Safe to apply</div><div class="val">${s.safe}</div></div>
      <div class="sumcard warn"><div class="lbl">Priced staffing · review</div><div class="val">${s.review}</div></div>
      <div class="sumcard bad"><div class="lbl">Reconciled · changed</div><div class="val">${s.reconciledChanged}</div></div>
      <div class="sumcard warn"><div class="lbl">New projects</div><div class="val">${s.newProj}</div></div>
      <div class="sumcard bad"><div class="lbl">No match — human needed</div><div class="val">${s.unmatched}</div></div>
      <div class="sumcard"><div class="lbl">No change</div><div class="val">${s.unchanged}</div></div>
      <div class="sumcard ${s.missing ? 'warn' : ''}"><div class="lbl">In tool, not in sheet</div><div class="val">${s.missing}</div></div>`;
    const split = selectionSplit();
    $('#ri-apply-btn').textContent = s.selected === 0 ? 'Import selected (0) →'
      : `Import — ${split.updates} update${split.updates === 1 ? '' : 's'} · ${split.creates.length} new →`;
    $('#ri-apply-btn').title = s.selected === 0 ? ''
      : `${split.updates} ticked row${split.updates === 1 ? '' : 's'} UPDATE existing projects (monthly revenue only)` +
        (split.creates.length ? ` · ${split.creates.length} CREATE new: ${split.creates.slice(0, 6).join(', ')}${split.creates.length > 6 ? '…' : ''}` : ' · nothing new is created');
    $('#ri-apply-btn').disabled = s.selected === 0;
    const rb = $('#ri-report-btn'); if (rb) rb.disabled = !state.groups.length;
    const fo = $('#ri-future-only'); if (fo) fo.checked = !state.futureOnly;   // checked = reconcile past months too
  }

  /* ---------- the review report: what WOULD change, before anything does ----------
     This is the artifact finance asked for — every proposed move, by revenue
     leader, carrying the sheet's own comment explaining why. */
  async function buildReviewReport() {
    if (typeof ExcelJS === 'undefined') throw new Error('Excel library not loaded on this page.');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Savills PPM'; wb.created = new Date();
    const NAVY = 'FF25273A', WHITE = 'FFFFFFFF', YEL = 'FFFFDF00';
    const tone = { safe: 'FFE7F0EE', review: 'FFFDF3D7', reconciledChanged: 'FFFBE9EA', newProj: 'FFE7EEF0', unmatched: 'FFF7DEDC', unchanged: 'FFF7F7F5' };
    const ws = wb.addWorksheet('Proposed changes', { views: [{ state: 'frozen', ySplit: 1 }] });
    const cols = [
      { h: 'Decision', w: 26 }, { h: 'Revenue leader', w: 14 }, { h: 'Client', w: 24 }, { h: 'Project (sheet)', w: 40 },
      { h: 'Matched to', w: 40 }, { h: 'Match via', w: 13 }, { h: 'Sheet flag', w: 10 }, { h: 'Rating', w: 14 },
      { h: '2026 (sheet)', w: 14 }, { h: '2027 (sheet)', w: 14 }, { h: 'Change vs tool', w: 15 },
      { h: 'Months affected', w: 14 }, { h: 'Closed months restated', w: 18 }, { h: 'Has staffing?', w: 12 }, { h: 'Finance comment', w: 60 },
    ];
    ws.columns = cols.map(c => ({ width: c.w }));
    cols.forEach((c, i) => {
      const cell = ws.getRow(1).getCell(i + 1);
      cell.value = c.h;
      cell.font = { name: 'Calibri', bold: true, color: { argb: WHITE }, size: 10 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
      cell.alignment = { vertical: 'middle', wrapText: true };
    });
    ws.getRow(1).height = 22;
    const order = { reconciledChanged: 0, review: 1, unmatched: 2, newProj: 3, safe: 4, unchanged: 5 };
    const rows = state.groups.slice().sort((a, b) => {
      const ca = classify(a, matchedIdFor(a)), cb = classify(b, matchedIdFor(b));
      return order[ca] - order[cb] || (a.leader || '').localeCompare(b.leader || '') || a.client.localeCompare(b.client);
    });
    let r = 2;
    rows.forEach(g => {
      const mid = matchedIdFor(g);
      const p = mid ? STORE.getProject(mid) : null;
      const cls = classify(g, mid);
      const d = diffGroup(g, p, state.years);
      const past = pastImpact(g, p, state.years);
      const vals = [
        CLASS[cls].label, g.leader || '', g.client, g.project + (g.engIdx ? ` · engagement ${g.engIdx}/${g.engCount} (sheet row ${g.rows[0].rowNum})` : ''),
        p ? (((p.project || {}).client || '') + ' — ' + ((p.project || {}).name || '')) : '(would be created)',
        mid ? (g.match ? g.match.via : 'manual') : '—',
        g.newOrEdit || '', g.rating || '',
        Math.round(g.totalsByYear[2026] || 0), Math.round(g.totalsByYear[2027] || 0),
        cls === 'unchanged' ? 0 : Math.round(d.totalDelta || 0),
        d.isNew ? '' : d.changedMonths,
        state.futureOnly ? 'skipped' : (past.months ? `${past.months} mo · ${past.delta >= 0 ? '+' : '−'}$${Math.abs(Math.round(past.delta)).toLocaleString()}` : ''),
        p ? (d.reconciled ? 'RECONCILED' : d.staffKind === 'priced' ? 'PRICED' : d.staffKind === 'zeroSeed' ? '$0 seed (ours)' : 'no') : '—',
        g.comments || '',
      ];
      vals.forEach((v, i) => {
        const cell = ws.getRow(r).getCell(i + 1);
        cell.value = v;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: tone[cls] } };
        if (i >= 8 && i <= 11 && typeof v === 'number') { cell.numFmt = i === 11 ? '#,##0' : '#,##0;[Red]-#,##0'; cell.alignment = { horizontal: 'right' }; }
        if (i === 14) cell.alignment = { wrapText: true, vertical: 'top' };
        if (i === 13 && (v === 'PRICED' || v === 'RECONCILED')) cell.font = { name: 'Calibri', bold: true, color: { argb: 'FFB3413B' } };
      });
      r++;
    });
    ws.autoFilter = { from: 'A1', to: `O${Math.max(2, r - 1)}` };

    // The reverse half of the full-book comparison: in the tool, not in the sheet.
    const missing = missingFromSheet();
    const mw = wb.addWorksheet('In tool, not in sheet', { views: [{ state: 'frozen', ySplit: 1 }] });
    const mcols = [{ h: 'Project (tool)', w: 46 }, { h: 'Status', w: 14 }, { h: 'Timeframe', w: 20 }, { h: 'Staffing', w: 16 }, { h: `Tool revenue ${state.years.join('+')}`, w: 18 }];
    mw.columns = mcols.map(c => ({ width: c.w }));
    mcols.forEach((c, i) => {
      const cell = mw.getRow(1).getCell(i + 1);
      cell.value = c.h;
      cell.font = { name: 'Calibri', bold: true, color: { argb: WHITE }, size: 10 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    });
    missing.forEach((x, i) => {
      const row = mw.getRow(i + 2);
      row.getCell(1).value = x.label;
      row.getCell(2).value = ((x.rec.project || {}).status) || '';
      row.getCell(3).value = x.span ? x.span.label : '';
      row.getCell(4).value = x.reconciled ? 'RECONCILED' : x.kind === 'priced' ? 'PRICED' : x.kind === 'zeroSeed' ? '$0 seed (ours)' : 'no';
      row.getCell(5).value = Math.round(x.tot); row.getCell(5).numFmt = '#,##0'; row.getCell(5).alignment = { horizontal: 'right' };
    });

    // A short cover so the file is self-explanatory when it's forwarded on.
    const s = summarize();
    const cv = wb.addWorksheet('Read me', { views: [{ showGridLines: false }] });
    cv.columns = [{ width: 34 }, { width: 86 }];
    cv.getCell('A1').value = 'Revenue projections — proposed changes for review';
    cv.getCell('A1').font = { name: 'Calibri', bold: true, size: 15, color: { argb: NAVY } };
    cv.getCell('A2').value = `Source: ${state.fileName || 'workbook'} · prepared ${new Date().toISOString().slice(0, 10)} · NOTHING HAS BEEN APPLIED`;
    cv.getCell('A2').font = { name: 'Calibri', italic: true, size: 10, color: { argb: 'FF79828C' } };
    let cr = 4;
    [
      ['Safe to apply', `${s.safe} — confident match, money moved, and either unstaffed or staffed only by OUR $0-rate matrix seed (revenue stays override-driven, so the update can't fight anyone's fee model). These are pre-selected.`],
      ['Priced staffing · needs review', `${s.review} — a revenue leader has real rates on this roster. NOT selected; each one is a conversation.`],
      ['Reconciled · number changed', `${s.reconciledChanged} — the project was marked reconciled (projections follow its fee model) and the sheet now disagrees. NEVER auto-applied; see the "In tool, not in sheet" tab for the reverse gaps too.`],
      ['New projects', `${s.newProj} — flagged "New" by finance and not found in the tool. Opt-in to create.`],
      ['No match — human needed', `${s.unmatched} — the tool could not find these and finance did not flag them new. Link them by hand; importing blind would create duplicates.`],
      ['No change', `${s.unchanged} — sheet agrees with the tool already.`],
      ['Past months', state.futureOnly
        ? 'SKIPPED — forward-only movement was explicitly selected. The tool keeps whatever history it holds today.'
        : 'RECONCILED to this workbook — its closed months are the record of what was actually billed, so they are imported as-is. The "Closed months restated" column shows where that changes a figure the tool held.'],
      ['What an import touches', 'Only the monthly revenue figures (monthlyOverrides). Rosters, rates, phases and every other field are never touched. Because the figures land as overrides, a later staffing edit cannot retroactively restate a billed month.'],
    ].forEach(([k, v]) => {
      cv.getCell(`A${cr}`).value = k;
      cv.getCell(`A${cr}`).font = { name: 'Calibri', bold: true, color: { argb: NAVY } };
      cv.getCell(`A${cr}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YEL } };
      cv.getCell(`B${cr}`).value = v;
      cv.getCell(`B${cr}`).alignment = { wrapText: true, vertical: 'top' };
      cr++;
    });

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `Revenue-Import-Review_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { rows: rows.length };
  }

  function projectOptionsHtml(selectedId) {
    return state.projectIndex.map(p => `<option value="${esc(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.label)}</option>`).join('');
  }

  function monthDiffTable(g, matchedProjectId) {
    const p = matchedProjectId ? STORE.getProject(matchedProjectId) : null;
    const current = p ? currentSeriesByYear(p, state.years) : null;
    return state.years.map(y => {
      const cells = [];
      for (let m = 1; m <= 12; m++) {
        const sheetV = g.byYear[y][m] || 0;
        const curV = current ? (current[y][m] || 0) : null;
        const changed = curV != null && Math.abs(sheetV - curV) >= 0.5;
        cells.push(`<td class="num ${changed ? 'ri-changed' : ''}" title="${esc(String(y))}-${m}">${sheetV ? money(sheetV) : '·'}${curV != null && changed ? `<div class="ri-was">was ${money(curV)}</div>` : ''}</td>`);
      }
      return `<tr><td class="ri-yr">${y}</td>${cells.join('')}<td class="num" style="font-weight:700">${money(g.totalsByYear[y] || 0)}</td></tr>`;
    }).join('');
  }

  function renderTable() {
    const tb = $('#ri-tbody');
    if (!state.groups.length) { tb.innerHTML = `<tr><td colspan="8" class="empty">Drop a revenue projections workbook above.</td></tr>`; renderMissing(); return; }
    // how many rows point at each tool project — engagements must stay 1:1
    const linkCounts = {};
    state.groups.forEach(g => { const id = matchedIdFor(g); if (id) linkCounts[id] = (linkCounts[id] || 0) + 1; });
    tb.innerHTML = state.groups.map((g, i) => {
      const matchedId = state.overrides[g.key] !== undefined ? state.overrides[g.key] : (g.match && g.match.id) || '';
      const matchedProject = matchedId ? STORE.getProject(matchedId) : null;
      const d = diffGroup(g, matchedProject, state.years);
      const checked = state.included.has(g.key);
      const cls = classify(g, matchedId);
      const via = g.match && g.match.via;
      const overridden = state.overrides[g.key] !== undefined;
      const matchBadge = overridden
        ? (matchedId
          ? `<span class="ri-badge ri-id" title="You picked this project by hand just now">✓ Your pick</span>`
          : `<span class="ri-badge ri-new" title="You cleared the link — importing this row creates its own new project">Will create new</span>`)
        : !matchedId
          ? (cls === 'newProj' ? `<span class="ri-badge ri-new">New</span>` : `<span class="ri-badge" style="background:#f7dedc;color:#a3352d">No match</span>`)
          : (via === 'confirmed' ? `<span class="ri-badge ri-id" title="You linked this on a previous revision — remembered">✓ Confirmed</span>`
            : via === 'id' ? `<span class="ri-badge ri-id">ID match</span>`
            : `<span class="ri-badge ri-name" title="Fuzzy name match — check it">Name match${g.match && g.match.score ? ' · ' + g.match.score + '%' : ''}</span>`);
      const matchCtl = overridden
        ? ` <a href="#" class="ri-match-reset" data-key="${esc(g.key)}" style="font-size:10.5px;font-weight:700" title="Undo your pick and go back to what the importer matched automatically">↺ back to auto</a>`
        : (matchedId ? ` <a href="#" class="ri-match-clear" data-key="${esc(g.key)}" style="font-size:10.5px;color:#79828C" title="Unlink — importing this row would then create its own new project">✕ unlink</a>` : '');
      const clsBadge = `<div class="ri-cls ${CLASS[cls].tone}" title="${cls === 'review' ? 'A revenue leader has priced staffing on this project — importing changes their numbers underneath them' : cls === 'reconciledChanged' ? 'This project was marked reconciled — its projections follow the fee model now, so a sheet change here is a conversation, not an auto-apply' : ''}">${CLASS[cls].label}</div>`;
      const comment = g.comments ? `<div class="raw" style="color:#4a4f5e"><b>Finance:</b> ${esc(g.comments.slice(0, 160))}${g.comments.length > 160 ? '…' : ''}</div>` : '';
      const lockWarn = d.locked ? `<div class="ri-warn">⚠ locked to its original import — a new override won't show until this project is reconciled</div>` : '';
      const feeShareNote = g.feeSharePct > 0
        ? `<div class="raw" style="color:#8a6d00">− broker ${g.feeSharePct}%${matchedId ? ' (existing project — set feeShare manually if needed, not auto-applied)' : ' — applied on create'}</div>`
        : '';
      // revenue cell: both sides + the delta, so "matches or different" reads at a glance
      const revCell = d.isNew
        ? `<div class="num">sheet <b>${money(d.sheetTotal)}</b></div><div class="raw">no tool side — would be created</div>`
        : d.changedMonths
          ? `<div class="num">sheet <b>${money(d.sheetTotal)}</b> · tool ${money(d.toolTotal)}</div><div class="num ri-delta">${d.totalDelta >= 0 ? '+' : ''}${money(d.totalDelta)} across ${d.changedMonths} mo</div>${lockWarn}`
          : `<div class="num">✓ matches · ${money(d.sheetTotal)}</div>`;
      // timeframe cell: sheet revenue months vs the tool's project timeline
      const tfCell = !d.sheetSpan ? '<span class="raw">—</span>'
        : d.isNew ? `<div>${esc(d.sheetSpan.label)}</div><div class="raw">sheet only</div>`
        : d.spanOk
          ? `<div>✓ fits · ${esc(d.sheetSpan.label)}</div><div class="raw">tool runs ${esc(d.toolSpan ? d.toolSpan.label : '—')}</div>`
          : `<div style="color:#a3352d;font-weight:700">≠ sheet ${esc(d.sheetSpan.label)}</div><div class="raw">tool runs ${esc(d.toolSpan ? d.toolSpan.label : 'no timeline')} — revenue would land outside the project window</div>`;
      // staffing cell: whose staffing is it, and does it block a $ change?
      const stCell = d.isNew ? '<span class="raw">—</span>'
        : d.reconciled ? `<span class="ri-badge" style="background:#fbe9ea;color:#b3151b" title="Marked reconciled in the calculator — projections follow its fee model">✓ reconciled</span>`
        : d.staffKind === 'priced' ? `<span class="ri-badge" style="background:#fdf3d7;color:#8a6d00" title="Real rates on the roster — a revenue leader owns these numbers">priced staffing</span>`
        : d.staffKind === 'zeroSeed' ? `<span class="ri-badge" style="background:#e7f0ee;color:#0E7C7B" title="Staffing WE seeded from the matrix at a $0 placeholder rate — revenue stays override-driven, safe to update">$0 seed (ours)</span>`
        : `<span class="raw">not staffed</span>`;
      return `<tr class="ri-row" data-key="${esc(g.key)}">
        <td><input type="checkbox" class="ri-check" data-key="${esc(g.key)}" ${checked ? 'checked' : ''}></td>
        <td>${esc(g.client)}</td>
        <td>${esc(g.project)}${g.engIdx ? `<span class="raw" style="color:#2f5d8f;font-weight:700" title="This Project ID appears on ${g.engCount} sheet rows — each is a separate contract/engagement and maps to its own project record">engagement ${g.engIdx} of ${g.engCount} · sheet row ${g.rows[0].rowNum}</span>` : ''}${g.rows.length > 1 ? `<span class="raw">fee-share deduction row attached</span>` : ''}${g.rating ? `<span class="raw">${esc(g.rating)}</span>` : ''}${g.newOrEdit ? `<span class="raw" style="color:#8a6d00">sheet: ${esc(String(g.newOrEdit))}</span>` : ''}${clsBadge}${feeShareNote}${comment}</td>
        <td>${matchBadge}${matchCtl}${matchedId && linkCounts[matchedId] > 1 ? `<div class="ri-warn">⚠ another sheet row links to this same project — engagements must stay separate; relink one of them or clear it to create new</div>` : ''}${!matchedId && g.claimLostTo ? `<div class="raw" style="color:#a3352d">Project ID already claimed by “${esc(g.claimLostTo)}” — link this one by hand, or leave blank to create its own record</div>` : ''}<div class="ri-match-pick"><input list="ri-projects-${i}" class="ri-match-input" data-key="${esc(g.key)}" value="${matchedProject ? esc(((matchedProject.project||{}).client||'') + ' — ' + ((matchedProject.project||{}).name||'')) : ''}" placeholder="type any part of the name, Enter to link"><datalist id="ri-projects-${i}">${projectOptionsDatalist()}</datalist></div></td>
        <td>${revCell}</td>
        <td>${tfCell}</td>
        <td>${stCell}</td>
        <td><button class="ri-expand" data-key="${esc(g.key)}" title="Month-by-month detail">▸</button></td>
      </tr>
      <tr class="ri-detail-row" data-detail="${esc(g.key)}" hidden><td colspan="8">
        <table class="ri-detail"><thead><tr><th>Yr</th>${Array.from({length:12},(_,i)=>`<th>${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][i]}</th>`).join('')}<th>Total</th></tr></thead>
        <tbody>${monthDiffTable(g, matchedId)}</tbody></table>
      </td></tr>`;
    }).join('');
    renderMissing();

    $$('.ri-check').forEach(cb => cb.onchange = () => { const k = cb.dataset.key; if (cb.checked) state.included.add(k); else state.included.delete(k); renderSummary(); });
    $$('.ri-expand').forEach(b => b.onclick = () => {
      const row = $(`.ri-detail-row[data-detail="${CSS.escape(b.dataset.key)}"]`);
      if (row) { row.hidden = !row.hidden; b.textContent = row.hidden ? '▸' : '▾'; }
    });
    // Manual mapping — the human says which project a row belongs to, and the
    // tool obeys without fighting back:
    //  · partial text resolves if it uniquely identifies one project
    //  · picking FIRST forgets any previously-remembered link for this row
    //    (the old sticky behavior: the stale key kept snapping the row back)
    //  · no match found → the typed text STAYS, box goes red, nothing resets
    const applyPick = (k, hit) => {
      forgetMatch(k);                       // un-stick whatever was remembered before
      state.overrides[k] = hit ? hit.id : null;
      if (hit) rememberMatch(hit.id, k);    // the new link is what future Revs see
      const g = state.groups.find(x => x.key === k);
      if (g) g.claimLostTo = null;          // a human decision outranks the auto-claim note
      state.projectIndex = buildProjectIndex();
      renderTable(); renderSummary();
    };
    $$('.ri-match-input').forEach(inp => inp.onchange = () => {
      const k = inp.dataset.key;
      const typed = inp.value.trim();
      if (!typed) { applyPick(k, null); return; }
      const low = typed.toLowerCase();
      let hit = state.projectIndex.find(p => p.label.toLowerCase() === low);
      if (!hit) {
        const subs = state.projectIndex.filter(p => p.label.toLowerCase().includes(low));
        if (subs.length === 1) hit = subs[0];
        else if (subs.length > 1) { inp.style.borderColor = '#C0392B'; inp.title = subs.length + ' projects match “' + typed + '” — keep typing until only one does'; return; }
      }
      if (!hit) { inp.style.borderColor = '#C0392B'; inp.title = 'No project matches “' + typed + '” — check the spelling, or clear the box to create a new project from this row'; return; }
      applyPick(k, hit);
    });
    $$('.ri-match-reset').forEach(a => a.onclick = (e) => {
      e.preventDefault();
      const k = a.dataset.key;
      forgetMatch(k);                       // drop the remembered pick so auto really is auto again
      delete state.overrides[k];
      const g = state.groups.find(x => x.key === k);
      if (g) { state.projectIndex = buildProjectIndex(); g.match = matchGroup(state.projectIndex, g); }
      renderTable(); renderSummary();
    });
    $$('.ri-match-clear').forEach(a => a.onclick = (e) => {
      e.preventDefault();
      applyPick(a.dataset.key, null);
    });
  }
  function projectOptionsDatalist() {
    return state.projectIndex.map(p => `<option value="${esc(p.label)}">`).join('');
  }

  /* The reverse half of the comparison: tool projects the sheet never
     mentions. Read-only — the fix is either "sheet is incomplete, tell
     finance" or "it's a rename, link it on a sheet row above". */
  function renderMissing() {
    const card = document.getElementById('ri-missing-card');
    const host = document.getElementById('ri-missing');
    if (!card || !host) return;
    if (!state.groups.length) { card.hidden = true; host.innerHTML = ''; return; }
    const list = missingFromSheet();
    card.hidden = false;
    if (!list.length) { host.innerHTML = '<p class="hint" style="margin:6px 0 2px">Every tool project with revenue in these years appears in the sheet — full book accounted for. ✓</p>'; return; }
    host.innerHTML = `<p class="hint" style="margin:6px 0 10px">${list.length} project${list.length === 1 ? '' : 's'} carr${list.length === 1 ? 'ies' : 'y'} ${money(list.reduce((s, x) => s + x.tot, 0))} of ${state.years.join('/')} revenue in the tool but never appear${list.length === 1 ? 's' : ''} in this workbook.</p>
      <table class="ri"><thead><tr><th>Project (tool)</th><th>Status</th><th>Timeframe</th><th>Staffing</th><th class="num">Tool revenue · ${state.years.join('+')}</th></tr></thead><tbody>
      ${list.map(x => `<tr>
        <td>${esc(x.label)}</td>
        <td>${esc(((x.rec.project || {}).status) || '—')}</td>
        <td>${esc(x.span ? x.span.label : '—')}</td>
        <td>${x.reconciled ? '<span class="ri-badge" style="background:#fbe9ea;color:#b3151b">✓ reconciled</span>' : x.kind === 'priced' ? '<span class="ri-badge" style="background:#fdf3d7;color:#8a6d00">priced staffing</span>' : x.kind === 'zeroSeed' ? '<span class="ri-badge" style="background:#e7f0ee;color:#0E7C7B">$0 seed (ours)</span>' : '<span class="raw">not staffed</span>'}</td>
        <td class="num">${money(x.tot)}</td>
      </tr>`).join('')}
      </tbody></table>`;
  }

  async function applySelected() {
    // Say exactly what is about to happen — update vs create — before it does.
    const split = selectionSplit();
    const lines = [
      `${split.updates} UPDATE existing projects — only their monthly revenue figures move; rosters, rates and phases are untouched.`,
      split.creates.length
        ? `${split.creates.length} CREATE brand-new projects:\n   • ${split.creates.slice(0, 12).join('\n   • ')}${split.creates.length > 12 ? `\n   • …and ${split.creates.length - 12} more` : ''}`
        : 'Nothing new is created.',
    ];
    if (!confirm(`Import ${split.updates + split.creates.length} selected rows?\n\n` + lines.join('\n\n'))) return;
    const btn = $('#ri-apply-btn'); const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Importing…';
    let created = 0, updated = 0, failed = [];
    for (const g of state.groups) {
      if (!state.included.has(g.key)) continue;
      const matchedId = state.overrides[g.key] !== undefined ? state.overrides[g.key] : (g.match && g.match.id);
      try {
        if (matchedId) { applyOverridesToProject(matchedId, g, state.years, { futureOnly: !!state.futureOnly }); updated++; }
        else { createLightweightProject(g, state.years); created++; }
      } catch (e) { failed.push(`${g.client} — ${g.project}: ${e.message}`); }
    }
    state.included.clear();
    state.projectIndex = buildProjectIndex();   // new projects now exist — refresh matching pool
    renderTable(); renderSummary();
    btn.textContent = orig; btn.disabled = false;
    setStatus(`Imported: ${updated} updated, ${created} created` + (failed.length ? ` — ${failed.length} failed (${failed.join(' · ')})` : ''), failed.length ? 'bad' : '');
  }

  /** Everything after the raw sheet_to_json rows are in hand — shared by the
      real upload path and the test seam below, so both exercise identical
      grouping/filtering/matching/selection logic. */
  function processParsedRows(rows) {
    const { rows: dataRows, years } = extractRows(rows);
    const groups = filterGroups(groupRows(dataRows, years));
    state.years = years;
    state.projectIndex = buildProjectIndex();
    state.overrides = {};
    state.included = new Set();
    groups.forEach(g => { g.match = matchGroup(state.projectIndex, g); });
    // ONE tool project per sheet row: sibling engagements sharing a Project ID
    // all ID-match the same record, but only one of them can BE that record.
    // Best claim wins (confirmed > ID > name, then largest $); the losers drop
    // to unmatched with a note, so each engagement gets its own project.
    {
      const prio = (g) => !g.match ? 9 : g.match.via === 'confirmed' ? 0 : g.match.via === 'id' ? 1 : 2;
      const totalOf = (g) => Object.values(g.totalsByYear).reduce((s, v) => s + Math.abs(v), 0);
      const claimed = {};
      groups.slice().sort((a, b) => prio(a) - prio(b) || totalOf(b) - totalOf(a)).forEach(g => {
        if (!g.match || !g.match.id) return;
        const winner = claimed[g.match.id];
        if (!winner) { claimed[g.match.id] = g; return; }
        g.claimLostTo = winner.project + (winner.engIdx ? ` (engagement ${winner.engIdx})` : '');
        g.match = null;
      });
    }
    groups.sort((a, b) => a.client.localeCompare(b.client) || a.project.localeCompare(b.project) || (a.engIdx || 0) - (b.engIdx || 0));
    state.groups = groups;
    // Default selection = ONLY the safe class: a confident match, money moved,
    // and nobody has staffed it yet. Staffed projects, new projects and
    // unmatched rows are all opt-in — a human decides those, every time.
    groups.forEach(g => {
      const matchedId = g.match && g.match.id;
      if (classify(g, matchedId) === 'safe') state.included.add(g.key);
    });
    renderTable(); renderSummary();
    return { dataRows, groups, years };
  }

  async function handleFile(file) {
    state.fileName = file.name;
    setStatus(`Reading ${file.name}…`, 'busy');
    try {
      const rows = await parseWorkbook(file);
      const { dataRows, groups, years } = processParsedRows(rows);
      setStatus(`Parsed ${dataRows.length} sheet rows → ${groups.length} projects with 2026/2027 revenue (years found: ${years.join(', ')}).`, '');
    } catch (e) {
      setStatus('Could not read that workbook: ' + e.message, 'bad');
    }
  }

  function wire() {
    const dz = $('#ri-dropzone'), fi = $('#ri-file-input');
    if (!dz || !fi) return;
    $('#ri-choose-btn').addEventListener('click', (e) => { e.stopPropagation(); fi.click(); });
    dz.addEventListener('click', () => fi.click());
    fi.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); fi.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'dragend', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
    $('#ri-apply-btn').addEventListener('click', applySelected);
    const rb = $('#ri-report-btn');
    if (rb) rb.addEventListener('click', async () => {
      const orig = rb.textContent; rb.disabled = true; rb.textContent = 'Building…';
      try { const r = await buildReviewReport(); setStatus(`Review report downloaded — ${r.rows} rows. Nothing has been applied.`, ''); }
      catch (e) { setStatus('Could not build the report: ' + e.message, 'bad'); }
      finally { rb.textContent = orig; rb.disabled = false; }
    });
    const fo = $('#ri-future-only');
    if (fo) fo.addEventListener('change', () => {
      // checked = reconcile past months to the workbook (the default and the
      // normal case: the workbook is the record of what was billed)
      state.futureOnly = !fo.checked;
      if (state.futureOnly && !confirm('Skip PAST months?\n\nThe workbook is the record of what was actually billed, so its closed months are normally imported as-is.\n\nSkipping them leaves whatever is in the tool today as the history. Only do this if finance asked for forward-only movement.')) {
        fo.checked = true; state.futureOnly = false;
      }
      renderTable(); renderSummary();
    });
    renderTable(); renderSummary();
  }

  function boot() {
    const start = () => wire();
    if (window.ufcReady && window.ufcReady.then) window.ufcReady.then(start); else start();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.UFC_RevenueImport = { handleFile, processParsedRows };   // exposed for tests
})();
