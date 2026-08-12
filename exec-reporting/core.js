/* ============================================================
   EXECUTIVE REPORTING · CORE (domain rulings + pure mappers)
   ------------------------------------------------------------
   Faithful vanilla-JS port of the Financial Analysis Part 2
   production app's lib/domain + lib/ingest layers (repo:
   KYRI101/financial-analysis-2). The maths and rulings here are
   the bible's (App Build Spec §4/§7/§8); if the two ever
   disagree, the bible wins.

   READ-ONLY BY DESIGN. This module consumes the four Box files
   (projects.json, rates.json, staff.json, studio.json) exactly
   as the data aggregator app writes them, and never writes any
   of them. Shape over version: a newer schemaVersion whose
   shape still parses is accepted with a loud note; a genuinely
   unreadable shape is refused with an error, never guessed at.

   Runs in the browser (window.EXEC_CORE) and in Node (module
   exports) so the verify harness exercises THIS file, not a
   copy of it.
   ============================================================ */
(function (root) {
  'use strict';

  /* ---------------- ratings (§8, KY's canonical ruling) ---------------- */
  const RATING_WEIGHTS = { 1: 1.0, 2: 0.9, 3: 0.75, 4: 0.5, 5: 0, 6: 0, 7: 0 };
  const RATING_LABELS = {
    1: 'Booked', 2: '90% (accrued)', 3: 'Likely ~75%', 4: 'Likely ~50%',
    5: '<50%', 6: '<25%', 7: 'Dead',
  };
  const BUDGET_RATINGS = [1, 2, 3, 4];
  const isBudgetRating = (r) => r != null && BUDGET_RATINGS.indexOf(r) !== -1;
  const weightFor = (r) => (r == null ? 0 : (RATING_WEIGHTS[r] || 0));
  function ratingFromStatus(status) {
    switch (status) {
      case 'active': return 1;
      case 'won': return 2;
      case 'negotiation':
      case 'submitted': return 4;
      case 'draft': return 5;
      case 'hold': return 6;
      case 'lost': return 7;
      default: return null;
    }
  }

  /* ---------------- money (§10: the ONE formatter) ---------------- */
  function fmtMoney(x) {
    const v = x == null ? 0 : x;
    const a = Math.abs(v);
    const s = v < 0 ? '-' : '';
    if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return s + '$' + Math.round(a / 1e3) + 'K';
    return s + '$' + Math.round(a);
  }
  function fmtMoneyFull(x) {
    const v = x == null ? 0 : x;
    const s = v < 0 ? '-' : '';
    return s + '$' + Math.abs(Math.round(v)).toLocaleString('en-US');
  }
  function fmtPct(fraction, decimals) {
    const d = decimals == null ? 1 : decimals;
    return ((fraction == null ? 0 : fraction) * 100).toFixed(d) + '%';
  }

  /* ------------- favourability (§4 rule 5: arrow=direction, colour=favourability) ------------- */
  function variance(current, reference, polarity) {
    if (current == null || reference == null || Number.isNaN(current) || Number.isNaN(reference)) {
      return { delta: 0, direction: 'flat', arrow: '', tone: 'neutral' };
    }
    const delta = current - reference;
    if (Math.abs(delta) < 0.5) return { delta, direction: 'flat', arrow: '', tone: 'neutral' };
    const direction = delta > 0 ? 'up' : 'down';
    const favourable = polarity === 'up-good' ? delta > 0 : delta < 0;
    return { delta, direction, arrow: direction === 'up' ? '↑' : '↓', tone: favourable ? 'good' : 'bad' };
  }

  /* ---------------- revenue leaders (verbatim directory) ---------------- */
  const REVENUE_LEADERS = [
    { id: 'acpeters',   displayName: 'Andrew Peters',    username: 'acpeters@savills.us',    aliases: ['Andrew Peters', 'A. Peters', 'Peters', 'AP'] },
    { id: 'bjosselson', displayName: 'Benay Josselson',  username: 'bjosselson@savills.us',  aliases: ['Benay Josselson', 'B. Josselson', 'Josselson', 'BLJ'] },
    { id: 'bking',      displayName: 'Brianna King',     username: 'bshepparding@savills.us', aliases: ['Brianna King', 'B. King', 'King', 'Brianna Sheppard King', 'BSK'] },
    { id: 'esobel',     displayName: 'Emily Sobel',      username: 'esobel@savills.us',      aliases: ['Emily Sobel', 'E. Sobel', 'Sobel', 'ES'] },
    { id: 'fbuscaglia', displayName: 'Fred Buscaglia',   username: 'fbuscaglia@savills.us',  aliases: ['Fred Buscaglia', 'F. Buscaglia', 'Buscaglia', 'FB'] },
    { id: 'jbergen',    displayName: 'Jason Bergen',     username: 'jbergen@savills.us',     aliases: ['Jason Bergen', 'J. Bergen', 'Bergen', 'JB'] },
    { id: 'jsantoro',   displayName: 'Jeff Santoro',     username: 'jsantoro@savills.us',    aliases: ['Jeff Santoro', 'J. Santoro', 'Santoro', 'Jeffrey Santoro', 'JS'] },
    { id: 'jjeffrey',   displayName: 'Jessica Jeffrey',  username: 'jjeffrey@savills.us',    aliases: ['Jessica Jeffrey', 'J. Jeffrey', 'Jeffrey', 'JJ'] },
    { id: 'kmartinez',  displayName: 'Kathryn Martinez', username: 'kmartinez@savills.us',   aliases: ['Kathryn Martinez', 'K. Martinez', 'Martinez', 'KM'] },
    { id: 'kraymond',   displayName: 'Kristen Raymond',  username: 'kraymond@savills.us',    aliases: ['Kristen Raymond', 'K. Raymond', 'Raymond', 'KR'] },
    { id: 'msmessina',  displayName: 'Marc Messina',     username: 'msmessina@savills.us',   aliases: ['Marc Messina', 'M. Messina', 'Messina', 'MSM'] },
    { id: 'mmclane',    displayName: 'Michael McLane',   username: 'mmclane@savills.us',     aliases: ['Michael McLane', 'M. McLane', 'McLane', 'Mike McLane', 'MHM'] },
    { id: 'tmwilliams', displayName: 'Tonya Williams',   username: 'tmwilliams@savills.us',  aliases: ['Tonya Williams', 'T. Williams', 'Williams', 'TW'] },
    { id: 'zsargent',   displayName: 'Zac Sargent',      username: 'zsargent@savills.us',    aliases: ['Zac Sargent', 'Z. Sargent', 'Sargent', 'Zachary Sargent', 'ZS'] },
  ];
  function resolveLeader(value) {
    if (!value) return null;
    const v = String(value).trim();
    const vk = v.toLowerCase();
    for (const l of REVENUE_LEADERS) {
      if (l.id === v || l.username.toLowerCase() === vk || l.displayName.toLowerCase() === vk) return l;
      for (const a of l.aliases) if (a.toLowerCase() === vk) return l;
    }
    return null;
  }
  const leaderDisplay = (v) => { const l = resolveLeader(v); return l ? l.displayName : (v || ''); };

  /* ---------------- service lines ---------------- */
  const SERVICE_LINES = ['PPM', 'Change Management', 'Relocation Management', 'Workplace', 'Other Savills Group'];
  const EXPLICIT_SL = {
    'program & project management': 'PPM', 'ppm': 'PPM',
    'change management': 'Change Management', 'workplace': 'Workplace',
    'relocation': 'Relocation Management', 'relocation management': 'Relocation Management',
    'other savills group': 'Other Savills Group',
  };
  const canonicalServiceLine = (v) => (v ? (EXPLICIT_SL[String(v).trim().toLowerCase()] || null) : null);
  function inferServiceLine(name) {
    const n = (name || '').toLowerCase();
    if (n.indexOf('change') !== -1) return 'Change Management';
    if (n.indexOf('workplace') !== -1) return 'Workplace';
    if (n.indexOf('reloc') !== -1 || n.indexOf('move management') !== -1) return 'Relocation Management';
    return 'PPM';
  }
  function resolveServiceLine(group) {
    return canonicalServiceLine(group.serviceLine)
      || canonicalServiceLine(group.serviceLines && group.serviceLines[0])
      || inferServiceLine(group.name);
  }

  /* ---------------- client canonicalisation (Data Dictionary register) ---------------- */
  const UNNAMED_CLIENT = '(unnamed client)';
  const KNOWN_ALIASES = {
    'jpmc': 'JPMorgan Chase',
    'jp morgan chase': 'JPMorgan Chase',
    'savillls': 'Savills',
    'fanatics holdings, inc. (fanatics betting & gaming)': 'Fanatics',
    'speros / moffitt': 'Speros Moffitt',
    'speros moffitt itc': 'Speros Moffitt',
  };
  function canonicalNameFor(raw) {
    const trimmed = String(raw == null ? '' : raw).trim();
    let hasAlnum = false;
    for (const ch of trimmed) if (/[a-z0-9]/i.test(ch)) { hasAlnum = true; break; }
    if (!hasAlnum) return UNNAMED_CLIENT;
    return KNOWN_ALIASES[trimmed.toLowerCase()] || trimmed;
  }

  /* ---------------- material changes (bible §6) ---------------- */
  const MATERIAL_FIELDS = new Set([
    'rating', 'team', 'phases', 'timeline', 'fee basis', 'client discount %',
    'broker fee share', 'rate lock', 'escalation %', 'industry adjustment %',
    'pass-through', 'nte ceiling', 'target fee',
  ]);
  const isMaterialChange = (f) => !!f && MATERIAL_FIELDS.has(String(f).trim().toLowerCase());

  /* ---------------- shared helpers ---------------- */
  const nullIfBlank = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
  };
  function splitYearMonth(key) {
    const m = /^(\d{4})-(\d{1,2})$/.exec(String(key).trim());
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return { year, month };
  }

  /* ============================================================
     MAPPER: projects.json -> row objects (pure, tolerant, loud)
     ============================================================ */
  const KNOWN_SCHEMA_VERSION = 2;
  const KNOWN_RECORD_KEYS = new Set([
    'id', 'createdAt', 'updatedAt', 'project', 'timeline', 'phases', 'groups', 'roles',
    'assumptions', 'source', 'monthlyOverrides', 'intakeSnapshot', 'financials', 'changeOrder',
    '_deleted', 'deletedAt', 'deletedBy', 'lastSavedBy', 'passthrough', 'versions',
  ]);

  function shapeIsUsable(projectsObj) {
    const records = Object.values(projectsObj);
    if (records.length === 0) return { ok: true };
    const sample = records.slice(0, 25);
    const withProject = sample.filter((r) => r && typeof r === 'object' && r.project && typeof r.project === 'object');
    if (withProject.length === 0) return { ok: false, reason: 'no record carries a `project` object - the shape has changed fundamentally' };
    const named = withProject.filter((r) => nullIfBlank(r.project.name));
    if (named.length === 0) return { ok: false, reason: 'no record carries `project.name` - the shape has changed fundamentally' };
    return { ok: true };
  }

  function mapProjects(raw) {
    const notes = [];
    const empty = {
      ok: false, counts: {}, notes, projects: [], groups: [], phases: [], roles: [],
      assumptions: [], monthlyRevenue: [], monthlyOverrides: [], financialSnapshots: [],
      flashSnapshots: [], flashRows: [], rawClients: [], deletedSourceIds: [], activityChanges: [],
    };
    if (!raw || typeof raw !== 'object') return Object.assign(empty, { error: 'projects.json is not an object' });
    const projectsObj = raw.projects;
    if (!projectsObj || typeof projectsObj !== 'object') return Object.assign(empty, { error: 'projects.json has no projects map' });

    // DB-level flash snapshots { "YYYY-MM": { label: { asOf, rows } } } - the
    // by-month grain rides along so vintages can be recomputed per year.
    for (const [period, byLabel] of Object.entries(raw.snapshots || {})) {
      const ym = splitYearMonth(String(period).replace(/-0?(\d+)$/, '-$1'));
      if (!ym) continue;
      for (const [label, snap] of Object.entries(byLabel || {})) {
        empty.flashSnapshots.push({ year: ym.year, month: ym.month, label, as_of: nullIfBlank(snap && snap.asOf) });
        for (const [pid, row] of Object.entries((snap && snap.rows) || {})) {
          empty.flashRows.push({
            snapshot_key: ym.year + '-' + ym.month + '-' + label,
            project_source_id: pid,
            rating: row && row.rating != null ? row.rating : null,
            amount: row && row.amount != null ? row.amount : null,
            by_month: (row && (row.byMonth || row.by_month)) || null,
          });
        }
      }
    }

    const version = Number(raw.schemaVersion);
    const shape = shapeIsUsable(projectsObj);
    if (!shape.ok) {
      return Object.assign(empty, {
        error: 'projects.json schemaVersion ' + raw.schemaVersion + ': ' + shape.reason + '. Refusing to guess - the mapper needs updating.',
      });
    }
    if (!Number.isFinite(version)) {
      notes.push('projects.json carries no schemaVersion - proceeding because the shape parses.');
    } else if (version > KNOWN_SCHEMA_VERSION) {
      notes.push('projects.json is schemaVersion ' + version + ', newer than the ' + KNOWN_SCHEMA_VERSION +
        ' this mapper was written for. The shape still parses so it has been read - CHECK the notes for unknown fields.');
    }

    const out = Object.assign(empty, { ok: true });
    const rawClientSet = new Set();
    const unknownKeys = new Set();
    let deletedCount = 0;

    for (const [key, rec] of Object.entries(projectsObj)) {
      const sourceId = nullIfBlank(rec.id) || key;
      for (const k of Object.keys(rec)) if (!KNOWN_RECORD_KEYS.has(k)) unknownKeys.add(k);
      if (rec._deleted) { deletedCount += 1; out.deletedSourceIds.push(sourceId); continue; }

      const p = rec.project || {};
      const timeline = rec.timeline || {};
      const source = rec.source || {};

      const leader = resolveLeader(p.leadId != null ? p.leadId : p.lead);
      const relOwner = resolveLeader(p.clientRelOwnerId != null ? p.clientRelOwnerId : p.clientRelOwner);
      if ((p.leadId || p.lead) && !leader) notes.push('Unresolved leader "' + (p.leadId || p.lead) + '" on ' + sourceId);

      const rawClient = nullIfBlank(p.client);
      if (rawClient) rawClientSet.add(rawClient);

      const rating = typeof p.rating === 'number' ? p.rating : ratingFromStatus(p.status);

      out.projects.push({
        source_id: sourceId,
        salesforce_id: nullIfBlank(p.salesforceId),
        clockify_id: nullIfBlank(p.clockifyId),
        project_id_365: nullIfBlank(p.projectId365),
        name: nullIfBlank(p.name) || '(unnamed project)',
        raw_client: rawClient,
        leader_id: leader ? leader.id : null,
        rel_owner_id: relOwner ? relOwner.id : null,
        rating: rating == null ? null : rating,
        status: nullIfBlank(p.status),
        project_type: nullIfBlank(p.projectType),
        industry: nullIfBlank(p.industry),
        proposal_date: nullIfBlank(p.proposalDate),
        start_month: timeline.startMonth != null ? timeline.startMonth : null,
        start_year: timeline.startYear != null ? timeline.startYear : null,
        end_month: timeline.endMonth != null ? timeline.endMonth : null,
        end_year: timeline.endYear != null ? timeline.endYear : null,
        is_change_order: sourceId.indexOf('co_') === 0 || Boolean(rec.changeOrder),
        parent_source_id: nullIfBlank(rec.changeOrder && rec.changeOrder.parentId),
        location: nullIfBlank(p.location),
        signed_contract_date: nullIfBlank(p.signedContractDate),
        created_at: nullIfBlank(rec.createdAt),
        updated_at: nullIfBlank(rec.updatedAt),
      });

      for (const g of rec.groups || []) {
        out.groups.push({
          project_source_id: sourceId,
          source_id: nullIfBlank(g.id),
          name: nullIfBlank(g.name),
          service_line: resolveServiceLine(g),
        });
      }

      (rec.phases || []).forEach((ph, i) => {
        out.phases.push({
          project_source_id: sourceId,
          source_id: nullIfBlank(ph.id),
          name: nullIfBlank(ph.name),
          order_index: i,
          length_months: ph.length != null ? ph.length : null,
          weeks: ph.weeks != null ? ph.weeks : null,
          target_fee: ph.targetFee != null ? ph.targetFee : null,
        });
      });

      for (const r of rec.roles || []) {
        out.roles.push({
          project_source_id: sourceId,
          group_source_id: nullIfBlank(r.groupId),
          source_id: nullIfBlank(r.id),
          title_id: nullIfBlank(r.titleId),
          tier_id: nullIfBlank(r.tierId),
          rate_source: nullIfBlank(r.rateSource),
          contracted_rate: r.contractedRate != null ? r.contractedRate : null,
          resource: nullIfBlank(r.resource),
          project_role: nullIfBlank(r.projectRole),
          fte_by_phase: r.fte != null ? r.fte : null,
          fte_by_month: r.fteMonthly != null ? r.fteMonthly : null,
        });
      }

      const a = rec.assumptions || {};
      out.assumptions.push({
        project_source_id: sourceId,
        hrs_per_mo: a.hrsPerMo != null ? a.hrsPerMo : null,
        escalation_pct: a.escalation != null ? a.escalation : null,
        industry_adj_pct: a.industryAdj != null ? a.industryAdj : null,
        discount_pct: a.discount != null ? a.discount : null,
        rate_lock: a.rateLock != null ? a.rateLock : null,
        fee_basis: nullIfBlank(a.feeBasis),
        nte_ceiling: a.nteCeiling != null ? a.nteCeiling : null,
        billing_mode: nullIfBlank(a.billingMode),
        fee_share_enabled: a.feeShare ? (a.feeShare.enabled != null ? a.feeShare.enabled : null) : null,
        fee_share_pct: a.feeShare ? (a.feeShare.pct != null ? a.feeShare.pct : null) : null,
      });

      // Monthly revenue: importedByMonth is canonical; broker folds in.
      // Duplicate keys naming the same month aggregate by summing.
      const byMonth = source.importedByMonth || {};
      const brokerByMonth = source.brokerByMonth || {};
      const agg = new Map();
      const addKey = (k, amount, broker) => {
        const ym = splitYearMonth(k);
        if (!ym) { notes.push('Malformed month key "' + k + '" on ' + sourceId + ' - skipped'); return; }
        const kk = ym.year + '-' + ym.month;
        const cur = agg.get(kk);
        if (!cur) {
          agg.set(kk, { year: ym.year, month: ym.month, amount, broker });
        } else {
          notes.push('Duplicate month key for ' + kk + ' on ' + sourceId + ' - amounts summed');
          cur.amount = amount == null ? cur.amount : (cur.amount || 0) + amount;
          cur.broker += broker;
        }
      };
      for (const k of Object.keys(byMonth)) addKey(k, typeof byMonth[k] === 'number' ? byMonth[k] : null, 0);
      for (const k of Object.keys(brokerByMonth)) {
        const broker = typeof brokerByMonth[k] === 'number' ? brokerByMonth[k] : 0;
        const ym = splitYearMonth(k);
        const kk = ym ? ym.year + '-' + ym.month : null;
        if (kk && agg.has(kk)) agg.get(kk).broker += broker;
        else addKey(k, null, broker);
      }
      for (const v of agg.values()) {
        out.monthlyRevenue.push({
          project_source_id: sourceId, year: v.year, month: v.month,
          amount: v.amount, broker_amount: v.broker, basis: 'imported',
        });
      }

      for (const [k, v] of Object.entries(rec.monthlyOverrides || {})) {
        const ym = splitYearMonth(k);
        if (!ym || typeof v !== 'number') continue;
        out.monthlyOverrides.push({ project_source_id: sourceId, year: ym.year, month: ym.month, amount: v });
      }

      const f = rec.financials;
      if (f && typeof f === 'object') {
        out.financialSnapshots.push({
          project_source_id: sourceId,
          gross: f.gross != null ? f.gross : null,
          discount: f.discount != null ? f.discount : null,
          net: f.net != null ? f.net : null,
          fee_share_pct: f.feeSharePct != null ? f.feeSharePct : null,
          fee_share: f.feeShare != null ? f.feeShare : null,
          revenue: f.revenue != null ? f.revenue : null,
          fte_months: f.fteMonths != null ? f.fteMonths : null,
          fee_basis: nullIfBlank(f.feeBasis),
          stale: f.stale != null ? f.stale : false,
          computed_at: nullIfBlank(f.computedAt),
        });
      }
    }

    // Upstream activity log -> real field-level history.
    for (const a of raw.activity || []) {
      const changes = a && a.meta && a.meta.changes;
      if (!a || !a.id || !a.projectId || !Array.isArray(changes)) continue;
      changes.forEach((c, i) => {
        const field = nullIfBlank(c && c.field);
        if (!field) return;
        out.activityChanges.push({
          source_id: a.id + '#' + i,
          project_source_id: String(a.projectId),
          field,
          old_value: c.from === null || c.from === undefined ? null : String(c.from),
          new_value: c.to === null || c.to === undefined ? null : String(c.to),
          changed_at: nullIfBlank(a.ts),
          actor: nullIfBlank(a.actorName) || nullIfBlank(a.actor),
          action: nullIfBlank(a.action),
          material: isMaterialChange(field),
        });
      });
    }

    if (deletedCount > 0) notes.push(deletedCount + ' record(s) are soft-deleted upstream and were excluded.');
    if (unknownKeys.size > 0) {
      notes.push('Unknown top-level record field(s) seen and NOT mapped: ' + [...unknownKeys].sort().join(', ') + '. Mapper may need extending.');
    }

    out.rawClients = [...rawClientSet].sort();
    out.counts = {
      projects: out.projects.length,
      deleted: deletedCount,
      activity_changes: out.activityChanges.length,
      groups: out.groups.length,
      phases: out.phases.length,
      roles: out.roles.length,
      monthly_revenue: out.monthlyRevenue.length,
      monthly_overrides: out.monthlyOverrides.length,
      financial_snapshots: out.financialSnapshots.length,
      raw_clients: out.rawClients.length,
    };
    return out;
  }

  /* ============================================================
     MAPPER: studio.json -> baselines (budget) + scenarios
     ============================================================ */
  function mapStudio(raw) {
    const notes = [];
    const empty = { ok: false, counts: {}, notes, baselines: [], baselineLines: [], scenarios: [] };
    if (!raw || typeof raw !== 'object') return Object.assign(empty, { error: 'studio.json is not an object' });
    if (raw.schemaVersion !== 1) {
      return Object.assign(empty, { error: 'Unsupported studio.json schemaVersion: ' + raw.schemaVersion + ' (expected 1). Refusing to guess.' });
    }
    const out = Object.assign(empty, { ok: true });
    let order = 0;
    for (const [key, bl] of Object.entries(raw.baselines || {})) {
      const sourceId = bl.id || key;
      out.baselines.push({
        source_id: sourceId,
        name: bl.name || sourceId,
        kind: bl.kind != null ? bl.kind : null,
        year: bl.year != null ? bl.year : null,
        total: bl.total != null ? bl.total : null,
        submitted_at: bl.submittedAt != null ? bl.submittedAt : null,
        order_index: typeof bl.order === 'number' ? bl.order : order,
      });
      order += 1;
      for (const [client, c] of Object.entries(bl.byClient || {})) {
        for (const [k, v] of Object.entries((c && c.byMonth) || {})) {
          const ym = splitYearMonth(k);
          if (!ym || typeof v !== 'number') {
            if (!ym) notes.push('Malformed month key "' + k + '" under baseline ' + sourceId + ' client "' + client + '"');
            continue;
          }
          out.baselineLines.push({
            baseline_source_id: sourceId, client, year: ym.year, month: ym.month, amount: v,
          });
        }
      }
    }
    for (const [key, sc] of Object.entries(raw.scenarios || {})) {
      out.scenarios.push({ source_id: (sc && sc.id) || key, name: (sc && sc.name) || key, updated_at: (sc && sc.updatedAt) || null });
    }
    out.counts = {
      baselines: out.baselines.length,
      baseline_lines: out.baselineLines.length,
      scenarios: out.scenarios.length,
    };
    return out;
  }

  /* ============================================================
     PIPELINE OVERVIEW (port of lib/queries/pipeline.ts on top of
     the parity view: project-year revenue = SUM of the imported
     monthly amounts, joined to the canonical rating weights)
     ============================================================ */
  function projectYearRevenue(mapped) {
    // project_source_id -> { year -> revenue }, imported amounts only.
    const byProject = new Map();
    for (const r of mapped.monthlyRevenue) {
      if (typeof r.amount !== 'number') continue;
      let years = byProject.get(r.project_source_id);
      if (!years) { years = new Map(); byProject.set(r.project_source_id, years); }
      years.set(r.year, (years.get(r.year) || 0) + r.amount);
    }
    return byProject;
  }

  function budgetBaseline(studioMapped) {
    const budgets = studioMapped.baselines
      .filter((b) => b.kind === 'budget')
      .sort((a, b) => a.order_index - b.order_index);
    return budgets.length ? budgets[0] : null;
  }

  function pipelineOverview(mapped, studioMapped, asOfLabel) {
    const yearRev = projectYearRevenue(mapped);
    const projBySource = new Map(mapped.projects.map((p) => [p.source_id, p]));

    // Tier totals per year (only rows whose project carries a 1-7 rating).
    const perYear = new Map(); // year -> rating -> { revenue }
    const yearsSeen = new Set();
    for (const [pid, years] of yearRev) {
      const p = projBySource.get(pid);
      if (!p || p.rating == null || !(p.rating in RATING_WEIGHTS)) continue;
      for (const [year, revenue] of years) {
        yearsSeen.add(year);
        let byRating = perYear.get(year);
        if (!byRating) { byRating = new Map(); perYear.set(year, byRating); }
        byRating.set(p.rating, (byRating.get(p.rating) || 0) + revenue);
      }
    }

    const budgetRow = budgetBaseline(studioMapped);
    const years = [...yearsSeen].sort((a, b) => a - b);
    const year = budgetRow && budgetRow.year != null && years.indexOf(budgetRow.year) !== -1
      ? budgetRow.year
      : (years.length ? years[years.length - 1] : new Date().getFullYear());

    // Counts cover every project per rating, whatever year its revenue sits in.
    const countByRating = new Map();
    for (const p of mapped.projects) {
      if (p.rating == null || !(p.rating in RATING_WEIGHTS)) continue;
      countByRating.set(p.rating, (countByRating.get(p.rating) || 0) + 1);
    }

    const revByRating = perYear.get(year) || new Map();
    const tiers = [1, 2, 3, 4, 5, 6, 7].map((rating) => {
      const revenue = revByRating.get(rating) || 0;
      return {
        rating,
        label: RATING_LABELS[rating],
        weight: RATING_WEIGHTS[rating],
        feeds_budget: isBudgetRating(rating),
        projects: countByRating.get(rating) || 0,
        revenue,
        weighted: revenue * RATING_WEIGHTS[rating],
      };
    });

    const sum = (f, pred) => tiers.filter(pred || (() => true)).reduce((a, t) => a + f(t), 0);
    const budget = budgetRow && budgetRow.total != null ? Number(budgetRow.total) : 0;
    const booked = sum((t) => t.revenue, (t) => t.rating === 1);
    const projected = sum((t) => t.revenue, (t) => t.feeds_budget);
    const weighted = sum((t) => t.weighted, (t) => t.feeds_budget);
    const total = sum((t) => t.revenue);
    const overUnder = projected - budget;

    const gap = budget - booked;
    const openFace = projected - booked;
    const openWeighted = weighted - booked;
    const shortfall = gap - openWeighted;

    const bridgeMsg = shortfall > 0
      ? 'We still need ' + fmtMoney(gap) + ' to hit budget. At realistic odds on open deals, we are about ' + fmtMoney(shortfall) + ' short.'
      : 'We still need ' + fmtMoney(gap) + ' to hit budget - and at realistic odds on open deals, the pipeline covers the gap.';
    const bookedPct = projected > 0 ? Math.round((booked / projected) * 100) : 0;
    const mixMsg = bookedPct + '% of projected revenue is already booked - ' + fmtMoney(openFace) + ' rides on the open pipeline.';

    return {
      year,
      asOf: asOfLabel || '',
      budget, booked, projected, weighted, total, overUnder,
      tiers, gap, openFace, openWeighted, shortfall, bridgeMsg, mixMsg,
    };
  }

  /* ============================================================
     TAB 1 PANELS (port of lib/queries/pipeline-panels.ts)
     ============================================================ */
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** Resolved monthly revenue: overrides win per (project, year, month);
      override-only months join in. Port of v_monthly_revenue_resolved. */
  function resolvedMonthly(mapped) {
    const key = (pid, y, m) => pid + '|' + y + '|' + m;
    const out = new Map();
    for (const r of mapped.monthlyRevenue) {
      out.set(key(r.project_source_id, r.year, r.month), {
        project_source_id: r.project_source_id, year: r.year, month: r.month,
        amount: typeof r.amount === 'number' ? r.amount : null,
      });
    }
    for (const o of mapped.monthlyOverrides) {
      out.set(key(o.project_source_id, o.year, o.month), {
        project_source_id: o.project_source_id, year: o.year, month: o.month, amount: o.amount,
      });
    }
    return [...out.values()];
  }

  function tab1Panels(mapped, studioMapped, overview, nowMs) {
    const year = overview.year;
    const budget = overview.budget;
    const now = new Date(nowMs != null ? nowMs : Date.now());

    // Per-project display name (canonical) + year revenue + rating.
    const yearRev = projectYearRevenue(mapped);
    const projects = [];
    for (const p of mapped.projects) {
      const years = yearRev.get(p.source_id);
      const revenue = years ? (years.get(year) || 0) : 0;
      if (!years || !years.has(year)) continue;   // parity view inner-joins on revenue rows
      projects.push({
        project_id: p.source_id,
        name: p.name,
        rating: p.rating,
        leader_id: p.leader_id,
        display: p.raw_client ? canonicalNameFor(p.raw_client) : UNNAMED_CLIENT,
        revenue,
      });
    }

    // ---- Revenue by rating, split by leader (top 5 + Other), R1-R4 ----
    const leaderRows = [1, 2, 3, 4].map((rating) => {
      const byLeader = new Map();
      for (const p of projects) {
        if (p.rating !== rating || p.revenue <= 0) continue;
        const k = p.leader_id ? leaderDisplay(p.leader_id) : 'Unassigned';
        byLeader.set(k, (byLeader.get(k) || 0) + p.revenue);
      }
      const sorted = [...byLeader.entries()].sort((a, b) => b[1] - a[1]);
      const segs = sorted.slice(0, 5).map(([name, value]) => ({ name, value }));
      const other = sorted.slice(5).reduce((a, e) => a + e[1], 0);
      if (other > 0) segs.push({ name: 'Other', value: other });
      return { rating, label: RATING_LABELS[rating], total: sorted.reduce((a, e) => a + e[1], 0), segs };
    });

    // ---- Top 10 clients by projected revenue --------------------------
    const byClient = new Map();
    for (const p of projects) {
      const row = byClient.get(p.display) || { name: p.display, r1: 0, r2: 0, r34: 0, projected: 0, longShots: 0, budget: null };
      if (p.rating === 1) row.r1 += p.revenue;
      else if (p.rating === 2) row.r2 += p.revenue;
      else if (p.rating === 3 || p.rating === 4) row.r34 += p.revenue;
      else row.longShots += p.revenue;
      row.projected = row.r1 + row.r2 + row.r34;
      byClient.set(p.display, row);
    }
    const budgetByClient = new Map();
    const budgetRow = budgetBaseline(studioMapped);
    if (budgetRow) {
      for (const l of studioMapped.baselineLines) {
        if (l.baseline_source_id !== budgetRow.source_id || l.year !== year) continue;
        const k = canonicalNameFor(l.client);
        budgetByClient.set(k, (budgetByClient.get(k) || 0) + l.amount);
      }
    }
    for (const row of byClient.values()) {
      row.budget = budgetByClient.has(row.name) ? budgetByClient.get(row.name) : null;
    }
    const ranked = [...byClient.values()].sort((a, b) => b.projected - a.projected);
    const top10 = ranked.slice(0, 10);
    const rest = ranked.slice(10);
    const sumRows = (rows, name) => ({
      name,
      r1: rows.reduce((a, r) => a + r.r1, 0),
      r2: rows.reduce((a, r) => a + r.r2, 0),
      r34: rows.reduce((a, r) => a + r.r34, 0),
      projected: rows.reduce((a, r) => a + r.projected, 0),
      longShots: rows.reduce((a, r) => a + r.longShots, 0),
      budget: rows.reduce((a, r) => a + (r.budget || 0), 0),
    });
    const other = sumRows(rest, 'Other (' + rest.length + ' clients)');
    const total = sumRows(ranked, 'Total (all clients)');
    const topShare = total.projected > 0 ? Math.round(((top10[0] ? top10[0].projected : 0) / total.projected) * 100) : 0;
    const topMsg = (top10[0] ? top10[0].name : '-') + ' alone carries ' + topShare + '% of projected revenue (' + fmtMoney(top10[0] ? top10[0].projected : 0) + ').';

    // ---- Monthly tracking + catch-up target (§8) ----------------------
    const flat = budget / 12;
    const projByIdRating = new Map(mapped.projects.map((p) => [p.source_id, p.rating]));
    const mm = new Map();
    for (const r of resolvedMonthly(mapped)) {
      if (r.year !== year || typeof r.amount !== 'number') continue;
      const rating = projByIdRating.get(r.project_source_id);
      if (rating == null) continue;
      const slot = mm.get(r.month) || { r1: 0, r2: 0, r34: 0 };
      if (rating === 1) slot.r1 += r.amount;
      else if (rating === 2) slot.r2 += r.amount;
      else if (rating === 3 || rating === 4) slot.r34 += r.amount;
      mm.set(r.month, slot);
    }
    let cum = 0;
    const monthRows = [];
    for (let m = 1; m <= 12; m++) {
      const s = mm.get(m) || { r1: 0, r2: 0, r34: 0 };
      const totalM = s.r1 + s.r2 + s.r34;
      const revised = flat + cum;
      cum += flat - totalM;
      monthRows.push({ month: m, r1: s.r1, r2: s.r2, r34: s.r34, total: totalM, flat, revised, variance: totalM - flat, cumVsBudget: -cum });
    }
    const todayMonth = now.getFullYear() === year ? now.getMonth() + 1 : 13;
    const lastActual = Math.min(todayMonth - 1, 12);
    const ytdVar = monthRows.slice(0, Math.max(lastActual, 0)).reduce((a, r) => a + r.variance, 0);
    const posLabel = lastActual === 6 ? 'Half-year position' : 'Position after ' + (MON[lastActual - 1] || '-');
    const monthlyMsg = posLabel + ': ' + fmtMoney(Math.abs(ytdVar)) + ' ' + (ytdVar < 0 ? 'behind' : 'ahead of') + ' the flat budget pace after ' + (MON[lastActual - 1] || '-') + '.';

    // ---- Full-year projection by vintage (frozen snapshots, if any) ----
    const snapRows = new Map();
    for (const r of mapped.flashRows) {
      const list = snapRows.get(r.snapshot_key) || [];
      list.push(r);
      snapRows.set(r.snapshot_key, list);
    }
    const vintages = [...mapped.flashSnapshots]
      .sort((a, b) => String(a.as_of || '').localeCompare(String(b.as_of || '')))
      .map((s) => {
        const v = { r1: 0, r2: 0, r3: 0, r4: 0 };
        for (const row of snapRows.get(s.year + '-' + s.month + '-' + s.label) || []) {
          if (!row.rating || row.rating > 4 || !row.by_month) continue;
          let yearSum = 0;
          for (const [k, amt] of Object.entries(row.by_month)) {
            if (String(k).indexOf(year + '-') === 0 && typeof amt === 'number') yearSum += amt;
          }
          if (row.rating === 1) v.r1 += yearSum;
          else if (row.rating === 2) v.r2 += yearSum;
          else if (row.rating === 3) v.r3 += yearSum;
          else v.r4 += yearSum;
        }
        return { label: MON[s.month - 1] + ' ' + s.year, asOf: s.as_of, r1: v.r1, r2: v.r2, r3: v.r3, r4: v.r4, total: v.r1 + v.r2 + v.r3 + v.r4 };
      });

    // ---- Staleness (bible §6): time since the last MATERIAL move -------
    const lastMove = new Map();
    for (const c of mapped.activityChanges) {
      if (!c.material || !c.changed_at) continue;
      const cur = lastMove.get(c.project_source_id);
      if (!cur || c.changed_at > cur) lastMove.set(c.project_source_id, c.changed_at);
    }
    let earliest = null;
    for (const c of mapped.activityChanges) {
      if (!c.changed_at) continue;
      if (!earliest || c.changed_at < earliest) earliest = c.changed_at;
    }
    const started = earliest
      ? new Date(earliest).getDate() + ' ' + MON[new Date(earliest).getMonth()] + ' ' + new Date(earliest).getFullYear()
      : 'with the first upstream change log';
    const staleRows = projects
      .filter((p) => p.rating != null && p.rating >= 2 && p.rating <= 4)
      .map((p) => {
        const moved = lastMove.get(p.project_id);
        const days = moved ? Math.floor((now.getTime() - new Date(moved).getTime()) / 86400000) : null;
        return { projectId: p.project_id, name: p.name, client: p.display, rating: p.rating, value: p.revenue, days };
      })
      .sort((a, b) => ((b.days == null ? -1 : b.days) - (a.days == null ? -1 : a.days)));
    const bands = { green: 0, amber: 0, red: 0, greenV: 0, amberV: 0, redV: 0 };
    for (const r of staleRows) {
      const d = r.days == null ? 0 : r.days;
      if (d >= 90) { bands.red += 1; bands.redV += r.value; }
      else if (d >= 30) { bands.amber += 1; bands.amberV += r.value; }
      else { bands.green += 1; bands.greenV += r.value; }
    }
    const anyHistory = staleRows.some((r) => r.days !== null);
    const staleMsg = anyHistory
      ? fmtMoney(bands.amberV + bands.redV) + ' of open pipeline has not moved in 30+ days (' + fmtMoney(bands.redV) + ' of it for 90+).'
      : 'No rating or value changes recorded yet - the change history started accruing ' + started + ', so every open deal reads on track today.';

    return {
      year,
      leaderRows,
      topClients: { rows: top10, other, total, otherCount: rest.length },
      topMsg,
      monthly: { rows: monthRows, flat, todayMonth, msg: monthlyMsg },
      vintages,
      stale: { rows: staleRows.slice(0, 15), msg: staleMsg, started, bands },
    };
  }

  /* ---------------- public surface ---------------- */
  const CORE = {
    RATING_WEIGHTS, RATING_LABELS, BUDGET_RATINGS, isBudgetRating, weightFor, ratingFromStatus,
    fmtMoney, fmtMoneyFull, fmtPct, variance,
    REVENUE_LEADERS, resolveLeader, leaderDisplay,
    SERVICE_LINES, canonicalServiceLine, inferServiceLine, resolveServiceLine,
    isMaterialChange, splitYearMonth, nullIfBlank,
    KNOWN_SCHEMA_VERSION, mapProjects, mapStudio,
    projectYearRevenue, budgetBaseline, pipelineOverview,
    UNNAMED_CLIENT, canonicalNameFor, resolvedMonthly, tab1Panels, MON,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
  else root.EXEC_CORE = CORE;
})(typeof window !== 'undefined' ? window : globalThis);
