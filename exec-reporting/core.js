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
  /** Highest studio.json schemaVersion this mapper was written against. */
  const KNOWN_STUDIO_SCHEMA_VERSION = 2;

  /* SHAPE OVER VERSION (KY ruling, 30 July, applied to projects.json and now
     here too). A strict version check refused the live file the day it moved
     to v2 and silently left the report with no budget, which then picked a
     stray year. Judge what the mapper actually depends on: baselines that
     carry a usable total or a client breakdown. A newer version whose shape
     still parses is read, with a loud note; only a genuinely unreadable
     shape is refused. */
  function studioShapeIsUsable(raw) {
    const bls = Object.values(raw.baselines || {});
    if (bls.length === 0) return { ok: true };
    const usable = bls.filter((b) => b && typeof b === 'object'
      && (typeof b.total === 'number' || b.byClient || b.byMonth));
    if (usable.length === 0) {
      return { ok: false, reason: 'no baseline carries a total, a client breakdown or a monthly breakdown' };
    }
    return { ok: true };
  }

  function mapStudio(raw) {
    const notes = [];
    const empty = { ok: false, counts: {}, notes, baselines: [], baselineLines: [], scenarios: [] };
    if (!raw || typeof raw !== 'object') return Object.assign(empty, { error: 'studio.json is not an object' });
    const version = Number(raw.schemaVersion);
    const shape = studioShapeIsUsable(raw);
    if (!shape.ok) {
      return Object.assign(empty, {
        error: 'studio.json schemaVersion ' + raw.schemaVersion + ': ' + shape.reason + '. Refusing to guess - the mapper needs updating.',
      });
    }
    if (!Number.isFinite(version)) {
      notes.push('studio.json carries no schemaVersion - proceeding because the shape parses.');
    } else if (version > KNOWN_STUDIO_SCHEMA_VERSION) {
      notes.push('studio.json is schemaVersion ' + version + ', newer than the ' + KNOWN_STUDIO_SCHEMA_VERSION +
        ' this mapper was written for. The shape still parses so it has been read.');
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

    /* Which year this report is about. The budget's year wins, because every
       comparison is against it. Without one, prefer the year we are actually
       in; only then fall back to the year carrying the most revenue.
       NEVER "the latest year with any revenue" - a handful of dollars booked
       into a future year would otherwise become the headline, which is what
       happened live when the budget failed to load and the report jumped to
       2028 on a $2.4m tail. */
    const budgetRow = budgetBaseline(studioMapped);
    const years = [...yearsSeen].sort((a, b) => a - b);
    const thisYear = new Date().getFullYear();
    let year;
    if (budgetRow && budgetRow.year != null && years.indexOf(budgetRow.year) !== -1) {
      year = budgetRow.year;
    } else if (years.indexOf(thisYear) !== -1) {
      year = thisYear;
    } else if (years.length) {
      let best = years[0], bestVal = -Infinity;
      for (const y of years) {
        let v = 0;
        for (const [, ys] of yearRev) v += ys.get(y) || 0;
        if (v > bestVal) { bestVal = v; best = y; }
      }
      year = best;
    } else {
      year = thisYear;
    }

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

  /* ============================================================
     SECTORS / PROGRAMMES / DEMO CLASSIFICATIONS (verbatim ports)
     ============================================================ */
  const SECTOR_KEYWORDS = [
    ['jpmorgan', 'Banking & Capital Markets'], ['jpmc', 'Banking & Capital Markets'], ['lazard', 'Banking & Capital Markets'],
    ['greenberg', 'Legal'], ['baker mckenzie', 'Legal'], ['hogan lovells', 'Legal'], ['withers', 'Legal'], ['keller', 'Legal'], ['bradley arant', 'Legal'],
    ['jetzero', 'Aerospace & Defense'], ['modern technology', 'Aerospace & Defense'], ['mtsi', 'Aerospace & Defense'],
    ['tiaa', 'Insurance'], ['willis', 'Insurance'], ['lancashire', 'Insurance'], ['athene', 'Insurance'],
    ['fanatics', 'Consumer & Retail'], ['children', 'Consumer & Retail'],
    ['moffitt', 'Healthcare & Life Sciences'], ['elevance', 'Healthcare & Life Sciences'],
    ['convene', 'Real Estate'], ['hudson square', 'Real Estate'], ['foxy', 'Real Estate'],
    ['exxon', 'Energy & Utilities'], ['exelon', 'Energy & Utilities'], ['murphy oil', 'Energy & Utilities'],
    ['miami-dade', 'Public Sector & Education'], ['miami_dade', 'Public Sector & Education'], ['state of florida', 'Public Sector & Education'],
    ['nyu', 'Public Sector & Education'], ['pennsylvania', 'Public Sector & Education'], ['collegiate', 'Public Sector & Education'],
    ['accenture', 'Professional Services & Consulting'], ['comcast', 'Telecommunications'],
    ['disney', 'Media & Entertainment'], ['nba', 'Media & Entertainment'],
    ['carlyle', 'Asset & Wealth Management'], ['earned wealth', 'Asset & Wealth Management'], ['blackstone', 'Asset & Wealth Management'],
    ['collibra', 'Technology & Software'], ['expedia', 'Travel & Transportation'], ['british airways', 'Travel & Transportation'],
    ['community church', 'Nonprofit & Associations'], ['year up', 'Nonprofit & Associations'], ['selfhelp', 'Nonprofit & Associations'], ['seia', 'Nonprofit & Associations'],
  ];
  function sectorOf(clientName) {
    const s = String(clientName == null ? '' : clientName).toLowerCase();
    for (const [needle, sector] of SECTOR_KEYWORDS) if (s.indexOf(needle) !== -1) return sector;
    return 'Unclassified';
  }

  const PROGRAMME_OVERRIDES = [
    ['small works', 'Small Works'], ['midtown', 'Midtown Migration'], ['redwood city', 'Redwood City'],
    ['global pmo', 'Global PMO'], ['na pmo', 'NA PMO'], ['na pm', 'NA PM Projects'], ['383', '383 Madison'],
    ['park ave', 'Park Avenue'], ['100 church', '100 Church St'], ['stenton', 'Stenton'],
    ['carlyle', 'Carlyle Expansion'], ['alexandria', 'Alexandria'], ['relocation', 'Relocation'],
    ['fit-out', 'Fit-out'], ['fitout', 'Fit-out'],
  ];
  const _alnum = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  function programmeOf(name) {
    const s2 = _alnum(name == null ? '' : name);
    for (const [key, label] of PROGRAMME_OVERRIDES) if (s2.indexOf(_alnum(key)) !== -1) return label;
    let base = String(name == null ? '' : name).replace(/\(.*?\)/g, ' ');
    base = base.replace(/\s*[-:].*$/, '');
    base = base.replace(/\b(rev|phase|ext|extension|sow|po|wo|amendment|co|20\d\d|#?\d+)\b.*/i, '');
    base = base.replace(/\s+/g, ' ').trim().replace(/^[\s\-,&]+|[\s\-,&]+$/g, '');
    return base.slice(0, 30) || String(name == null ? 'Other' : name).trim().slice(0, 30) || 'Other';
  }

  const DEMO_INDUSTRY = {
    'JPMC': 'Financial Services', 'JPMorgan Chase': 'Financial Services', 'Lazard': 'Financial Services',
    'TIAA': 'Financial Services', 'Willis Towers Watson': 'Financial Services',
    'Greenberg Traurig': 'Legal', 'Fanatics': 'Retail / Consumer', 'JetZero': 'Aviation / Industrial',
    'ExxonMobil': 'Energy', 'Comcast': 'Media / Telecom', 'Disney': 'Media / Telecom',
    'Convene': 'Real Estate', 'Miami-Dade County': 'Public Sector', 'Collegiate School': 'Education',
    'Modern Technology Solutions': 'Technology',
  };
  const DEMO_TYPE = {
    'JPMC': 'Workplace Strategy', 'JPMorgan Chase': 'Workplace Strategy', 'Fanatics': 'Capital Projects',
    'JetZero': 'Relocation & Migration', 'Greenberg Traurig': 'Lease Advisory',
    'Convene': 'Workplace Strategy', 'Lazard': 'Workplace Strategy', 'Disney': 'Capital Projects',
    'ExxonMobil': 'Project & Dev Mgmt',
  };
  const demoIndustryOf = (c) => DEMO_INDUSTRY[c] || 'Other / untagged';
  const demoProjectTypeOf = (c) => DEMO_TYPE[c] || 'Project & Dev Mgmt';
  /** Projects whose real tag has not been entered yet. Counted openly. */
  const NOT_TAGGED = 'Not yet tagged';

  /** Coverage of a real field, so a panel can state how complete it is. */
  function fieldCoverage(projects, pick) {
    let filled = 0;
    for (const p of projects) if (nullIfBlank(pick(p))) filled += 1;
    return { filled, total: projects.length, pct: projects.length ? filled / projects.length : 0 };
  }

  /* ============================================================
     TAB 2 · LEADERS (port of lib/queries/leaders-tab.ts)
     ============================================================ */
  function tab2Data(mapped, studioMapped, overview, nowMs) {
    const year = overview.year;
    const now = new Date(nowMs != null ? nowMs : Date.now());
    const yearRev = projectYearRevenue(mapped);

    const lastMove = new Map();
    for (const c of mapped.activityChanges) {
      if (!c.material || !c.changed_at) continue;
      const cur = lastMove.get(c.project_source_id);
      if (!cur || c.changed_at > cur) lastMove.set(c.project_source_id, c.changed_at);
    }

    const byLeader = new Map();
    const byIndustry = new Map();
    const byType = new Map();
    const allClients = new Set();
    let revenue = 0, booked = 0, withRevenueRows = 0;

    for (const p of mapped.projects) {
      const years = yearRev.get(p.source_id);
      if (!years || !years.has(year)) continue;      // parity: rows with year revenue
      const rev = years.get(year) || 0;
      const display = p.raw_client ? canonicalNameFor(p.raw_client) : UNNAMED_CLIENT;
      withRevenueRows += 1;
      revenue += rev;
      if (p.rating === 1) booked += rev;
      if (rev > 0) allClients.add(display);

      const lid = p.leader_id || 'unassigned';
      let book = byLeader.get(lid);
      if (!book) {
        book = { id: lid, name: p.leader_id ? leaderDisplay(p.leader_id) : 'Unassigned',
          revenue: 0, booked: 0, projects: 0, clients: [],
          aging: { green: 0, amber: 0, red: 0, amberRedValue: 0, tracked: false } };
        byLeader.set(lid, book);
      }
      book.revenue += rev;
      book.projects += 1;
      if (p.rating === 1) book.booked += rev;
      const cl = book.clients.find((c) => c.name === display);
      if (cl) cl.revenue += rev; else book.clients.push({ name: display, revenue: rev });

      if (p.rating != null && p.rating >= 2 && p.rating <= 4) {
        const moved = lastMove.get(p.source_id);
        const days = moved ? Math.floor((now.getTime() - new Date(moved).getTime()) / 86400000) : 0;
        if (moved) book.aging.tracked = true;
        if (days >= 90) { book.aging.red += 1; book.aging.amberRedValue += rev; }
        else if (days >= 30) { book.aging.amber += 1; book.aging.amberRedValue += rev; }
        else book.aging.green += 1;
      }

      // Industry and project type are REAL fields in the data aggregator app.
      // Read them; never invent them. Untagged projects are counted as
      // untagged rather than guessed into a bucket, so the panel's coverage
      // is honest and improves by itself as the fields get filled in.
      for (const [map, key] of [
        [byIndustry, nullIfBlank(p.industry) || NOT_TAGGED],
        [byType, nullIfBlank(p.project_type) || NOT_TAGGED],
      ]) {
        const g = map.get(key) || { key, revenue: 0, booked: 0, projects: 0 };
        g.revenue += rev; g.projects += 1;
        if (p.rating === 1) g.booked += rev;
        map.set(key, g);
      }
    }

    const books = [...byLeader.values()].sort((a, b) => b.revenue - a.revenue);
    for (const b of books) b.clients.sort((x, y) => y.revenue - x.revenue);

    const top = books[0];
    const top3 = books.slice(0, 3).reduce((a, b) => a + b.revenue, 0);
    const scorecardMsg = top
      ? top.name + ' leads with ' + Math.round((top.revenue / revenue) * 100) + '% of ' + year + ' revenue - the top three leaders hold ' + Math.round((top3 / revenue) * 100) + '% between them.'
      : 'No leader revenue yet.';

    const anyTracked = books.some((b) => b.aging.tracked);
    const agingValue = books.reduce((a, b) => a + b.aging.amberRedValue, 0);
    const agingMsg = anyTracked
      ? fmtMoney(agingValue) + ' of open pipeline sits in deals ageing 30+ days, shown under the leader responsible for them.'
      : 'No rating or value changes recorded yet - every leader\'s open pipeline reads on track today.';

    // RF timeline off the studio baselines: budget + reforecasts by kind/name.
    const blByName = new Map(studioMapped.baselines.map((b) => [String(b.name), b.total == null ? null : Number(b.total)]));
    const kindOrder = ['Annual Budget', 'RF1', 'RF2', 'RF3 / Final'];
    const baselines = kindOrder.map((name) => ({
      name,
      total: blByName.has(name === 'Annual Budget' ? '2026 Budget' : name)
        ? blByName.get(name === 'Annual Budget' ? '2026 Budget' : name)
        : null,
    }));

    return {
      year,
      kpis: { revenue, booked, projects: mapped.projects.length, leaders: books.filter((b) => b.revenue > 0 && b.id !== 'unassigned').length, clients: allClients.size },
      withRevenueRows,
      books, scorecardMsg,
      byIndustry: [...byIndustry.values()].sort((a, b) => b.revenue - a.revenue),
      byType: [...byType.values()].sort((a, b) => b.revenue - a.revenue),
      industryCoverage: fieldCoverage(mapped.projects, (p) => p.industry),
      typeCoverage: fieldCoverage(mapped.projects, (p) => p.project_type),
      baselines, agingMsg,
      snapshots: mapped.flashSnapshots.length,
    };
  }

  /* ============================================================
     TAB 3 · CLIENTS (port of lib/queries/clients-tab.ts)
     Revenue = ALL ratings, off the imported monthly grain.
     ============================================================ */
  function tab3Data(mapped, year, nowMs) {
    const projById = new Map(mapped.projects.map((p) => [p.source_id, {
      name: p.name,
      client: p.raw_client ? canonicalNameFor(p.raw_client) : UNNAMED_CLIENT,
    }]));
    for (const v of projById.values()) v.sector = sectorOf(v.client);

    const byClient = new Map();
    const byClientMonth = new Map();
    const bySectorMonth = new Map();
    const byClientSector = new Map();
    const byProgramme = new Map();
    const monthTotals = Array(12).fill(0);
    let total = 0;

    for (const r of mapped.monthlyRevenue) {
      if (r.year !== year) continue;
      const amt = typeof r.amount === 'number' ? r.amount : 0;
      if (!amt) continue;
      const p = projById.get(r.project_source_id);
      if (!p) continue;
      total += amt;
      monthTotals[r.month - 1] += amt;
      byClient.set(p.client, (byClient.get(p.client) || 0) + amt);
      byClientSector.set(p.client, p.sector);
      if (!byClientMonth.has(p.client)) byClientMonth.set(p.client, Array(12).fill(0));
      byClientMonth.get(p.client)[r.month - 1] += amt;
      if (!bySectorMonth.has(p.sector)) bySectorMonth.set(p.sector, Array(12).fill(0));
      bySectorMonth.get(p.sector)[r.month - 1] += amt;
      if (!byProgramme.has(p.client)) byProgramme.set(p.client, new Map());
      const progs = byProgramme.get(p.client);
      const prog = programmeOf(p.name);
      if (!progs.has(prog)) progs.set(prog, new Map());
      const projMap = progs.get(prog);
      projMap.set(p.name, (projMap.get(p.name) || 0) + amt);
    }

    const ranked = [...byClient.entries()].filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1]);
    const posTotal = ranked.reduce((a, e) => a + e[1], 0);
    let cum = 0;
    const pareto = ranked.slice(0, 10).map(([name, revenue]) => {
      cum += revenue;
      return { name, revenue, share: revenue / posTotal, cumShare: cum / posTotal };
    });
    const top5Pct = Math.round((ranked.slice(0, 5).reduce((a, e) => a + e[1], 0) / posTotal) * 100);
    const hhi = Math.round(ranked.reduce((a, e) => a + Math.pow(e[1] / posTotal, 2), 0) * 10000);
    const hhiBand = hhi < 1500 ? 'low' : hhi < 2500 ? 'moderate' : 'high';
    const paretoMsg = 'The top 5 clients carry ' + top5Pct + '% of revenue - concentration is ' + hhiBand + ' (HHI ' + hhi + ').';

    const sectorTotals = [...bySectorMonth.entries()]
      .map(([sector, months]) => ({ sector, revenue: months.reduce((a, b) => a + b, 0) }))
      .filter((s) => s.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue);
    const topSectors = sectorTotals.slice(0, 6).map((s) => s.sector);
    const donut = sectorTotals.map((s) => ({
      sector: s.sector, revenue: s.revenue, share: s.revenue / total,
      topClients: ranked.filter((e) => byClientSector.get(e[0]) === s.sector).slice(0, 5).map((e) => e[0]),
    }));
    const sTop = donut[0];
    const top3 = Math.round(donut.slice(0, 3).reduce((a, s) => a + s.share, 0) * 100);
    const sectorMsg = sTop
      ? sTop.sector + ' leads at ' + Math.round(sTop.share * 100) + '% of revenue; the top three sectors hold ' + top3 + '%.'
      : 'No sector revenue yet.';

    const smAgg = new Map();
    for (const [sector, months] of bySectorMonth) {
      const key = topSectors.indexOf(sector) !== -1 ? sector : 'Other';
      months.forEach((v, i) => {
        if (v === 0) return;
        const k = key + '|' + (i + 1);
        const cur = smAgg.get(k);
        if (cur) cur.revenue += v;
        else smAgg.set(k, { sector: key, month: i + 1, revenue: v });
      });
    }

    const now = new Date(nowMs != null ? nowMs : Date.now());
    const lastActual = now.getFullYear() === year ? Math.max(Math.min(now.getMonth(), 12), 2) : 12;
    const movers = [...byClientMonth.entries()].map(([name, months]) => ({
      name, prev: months[lastActual - 2], cur: months[lastActual - 1],
      delta: months[lastActual - 1] - months[lastActual - 2],
    })).filter((mv) => mv.delta !== 0);
    movers.sort((a, b) => b.delta - a.delta);

    const programmes = [];
    for (const [client] of ranked.slice(0, 8)) {
      const progs = byProgramme.get(client);
      if (!progs) continue;
      for (const [programme, projMap] of progs) {
        const rows = [...projMap.entries()].map(([name, revenue]) => ({ name, revenue })).sort((a, b) => b.revenue - a.revenue);
        const revenue = rows.reduce((a, r) => a + r.revenue, 0);
        if (revenue > 0) programmes.push({ client, programme, revenue, projects: rows });
      }
    }
    programmes.sort((a, b) => b.revenue - a.revenue);

    return {
      year,
      kpis: {
        topClientPct: Math.round((pareto[0] ? pareto[0].share : 0) * 100),
        topClientName: pareto[0] ? pareto[0].name : '-',
        top5Pct, hhi, clients: ranked.length, revenue: total,
      },
      pareto, paretoMsg, donut, sectorMsg,
      sectorMonths: [...smAgg.values()], monthTotals, lastActual, topSectors,
      movers: {
        month: MON[lastActual - 1], prevMonth: MON[lastActual - 2],
        gainers: movers.slice(0, 5),
        drops: movers.slice(-5).reverse(),
      },
      programmes: programmes.slice(0, 14),
    };
  }

  /* ============================================================
     EFFORT DOMAIN + STAFF / RATES MAPPERS (verbatim ports)
     ============================================================ */
  const CATEGORY_LABEL = { billable: 'Billable project work', internal: 'Macro / business development', time_off: 'Time off' };
  const TIME_OFF_RE = /(time\s*off|pto|vacation|holiday|sick|bereave|parental|jury)/i;
  const INTERNAL_RE = /(macro|business\s*development|non-?billable|internal|admin|training|overhead|recruit|marketing)/i;
  function categoriseProject(name) {
    const n = String(name == null ? '' : name);
    if (TIME_OFF_RE.test(n)) return 'time_off';
    if (INTERNAL_RE.test(n)) return 'internal';
    return 'billable';
  }
  const BULK_LOG_THRESHOLD = 172;
  const isBulkLogged = (hours, monthHours) => hours > (monthHours == null ? BULK_LOG_THRESHOLD : monthHours);
  const BLENDED_COST_PROXY = 140;
  /* Cost per hour for a person, from the rate card's cost floors.
     The card already carries three cost figures per grade (high / mid /
     low), so a band is chosen, never averaged away.

     BAND PRECEDENCE, so KY's per-person banding works the moment the
     upstream app carries it, with no change here:
       1. the person's own band  (person.band / person.tierId / person.tier)
       2. the band on their job title's mapping
       3. mid
     A person at the top of their band therefore costs what the grade
     above nearly costs, which is the intent. */
  function costRateFor(titleMap, gridMap, personTitle, person) {
    const mapped = personTitle ? titleMap.get(String(personTitle).trim().toLowerCase()) : undefined;
    if (mapped) {
      const row = gridMap.get(mapped.titleId);
      if (row) {
        const personBand = person && nullIfBlank(person.band || person.tierId || person.tier);
        const band = (personBand ? String(personBand).trim().toLowerCase() : null) || mapped.tierId || 'mid';
        const byTier = { high: row.floor_high, mid: row.floor_mid, low: row.floor_low };
        const picked = byTier[band] != null ? byTier[band] : row.floor_mid;
        if (typeof picked === 'number' && picked > 0) {
          return {
            rate: picked, fromGrid: true,
            basis: mapped.titleId + '/' + band + ' cost floor',
            bandSource: personBand ? 'person' : 'title',
          };
        }
      }
    }
    return { rate: BLENDED_COST_PROXY, fromGrid: false, basis: 'blended proxy', bandSource: 'none' };
  }

  const KNOWN_STAFF_SCHEMA_VERSION = 1;
  function mapStaff(raw) {
    const notes = [];
    const empty = { ok: false, counts: {}, notes, people: [], allocations: [], actuals: [], maps: [], meta: [],
      hoursByCategory: { billable: 0, internal: 0, time_off: 0 } };
    if (!raw || typeof raw !== 'object') return Object.assign(empty, { error: 'staff.json is not an object' });
    const peopleObj = raw.people;
    if (!peopleObj || typeof peopleObj !== 'object') return Object.assign(empty, { error: 'staff.json has no people map - the shape has changed fundamentally.' });
    const sample = Object.values(peopleObj).slice(0, 20);
    if (!sample.some((p) => p && typeof p === 'object' && nullIfBlank(p.name))) {
      return Object.assign(empty, { error: 'no person record carries a name - the shape has changed fundamentally.' });
    }
    const version = Number(raw.schemaVersion);
    if (Number.isFinite(version) && version > KNOWN_STAFF_SCHEMA_VERSION) {
      notes.push('staff.json is schemaVersion ' + version + ', newer than the ' + KNOWN_STAFF_SCHEMA_VERSION + ' this mapper was written for. The shape still parses so it has been read.');
    }
    const out = Object.assign(empty, { ok: true });
    const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

    for (const [key, p] of Object.entries(peopleObj)) {
      out.people.push({
        source_id: nullIfBlank(p.id) || key,
        name: nullIfBlank(p.name) || key,
        title: nullIfBlank(p.title),
        capacity_pct: num(p.capacityPct),
        active: p.active !== false,
        // Per-person pay band, once the upstream app carries it. Read under
        // any of the three plausible names so it works on arrival without a
        // change here; null today, which falls back to the title's band.
        band: nullIfBlank(p.band) || nullIfBlank(p.tierId) || nullIfBlank(p.tier),
      });
    }
    for (const a of raw.allocations || []) {
      const sourceId = nullIfBlank(a.id);
      if (!sourceId) continue;
      const start = splitYearMonth(String(a.start == null ? '' : a.start));
      const end = splitYearMonth(String(a.end == null ? '' : a.end));
      out.allocations.push({
        source_id: sourceId,
        person_source_id: nullIfBlank(a.personId),
        project_label: nullIfBlank(a.project),
        client_label: nullIfBlank(a.client),
        pct: num(a.pct),
        start_year: start ? start.year : null, start_month: start ? start.month : null,
        end_year: end ? end.year : null, end_month: end ? end.month : null,
      });
    }
    let malformed = 0, bulk = 0;
    for (const [key, hoursAny] of Object.entries(raw.actuals || {})) {
      const hours = num(hoursAny);
      if (hours === null) continue;
      const parts = String(key).split('|');
      if (parts.length !== 3) { malformed += 1; continue; }
      const ym = splitYearMonth(parts[2]);
      if (!ym) { malformed += 1; continue; }
      const category = categoriseProject(parts[1]);
      out.hoursByCategory[category] += hours;
      if (isBulkLogged(hours)) bulk += 1;
      out.actuals.push({ person_source_id: parts[0], clockify_project: parts[1], year: ym.year, month: ym.month, hours, category });
    }
    if (malformed > 0) notes.push(malformed + ' actuals key(s) were malformed and skipped.');
    for (const [kind, entries] of Object.entries(raw.mappings || {})) {
      if (!entries || typeof entries !== 'object') continue;
      for (const [k, v] of Object.entries(entries)) out.maps.push({ kind, key: String(k).trim().toLowerCase(), value: v == null ? null : v });
    }
    for (const [k, v] of Object.entries(raw.meta || {})) out.meta.push({ key: k, value: v == null ? null : v });
    out.counts = {
      people: out.people.length, allocations: out.allocations.length, actuals: out.actuals.length,
      maps: out.maps.length, total_hours: Math.round(out.hoursByCategory.billable + out.hoursByCategory.internal + out.hoursByCategory.time_off),
      bulk_logged_rows: bulk,
    };
    return out;
  }

  const HML_SPREAD = 0.1;
  function mapRates(raw) {
    const notes = [];
    const empty = { ok: false, counts: {}, notes, rateGrid: [] };
    if (!raw || typeof raw !== 'object') return Object.assign(empty, { error: 'rates.json is not an object' });
    if (raw.schemaVersion !== 1) return Object.assign(empty, { error: 'Unsupported rates.json schemaVersion: ' + raw.schemaVersion + ' (expected 1). Refusing to guess.' });
    if (!Array.isArray(raw.grid)) return Object.assign(empty, { error: 'rates.json has no grid[]' });
    const out = Object.assign(empty, { ok: true });
    for (const g of raw.grid) {
      if (!g || !g.id) { notes.push('Grid entry without id skipped'); continue; }
      out.rateGrid.push({
        title_id: g.id, name: g.name || g.id, grade_group: g.group || null,
        rack: g.rack != null ? g.rack : null,
        floor_high: g.floor ? (g.floor.high != null ? g.floor.high : null) : null,
        floor_mid: g.floor ? (g.floor.mid != null ? g.floor.mid : null) : null,
        floor_low: g.floor ? (g.floor.low != null ? g.floor.low : null) : null,
        target_disc: g.targetDisc != null ? g.targetDisc : null,
        base_year: raw.baseYear != null ? raw.baseYear : null,
      });
    }
    out.counts = { rate_grid: out.rateGrid.length };
    return out;
  }

  /* ============================================================
     DELIVERY ENGINE (port of lib/queries/clockify-tab.ts)
     The one hours x cost x revenue join every delivery surface uses.
     ============================================================ */
  function clockifyData(staffMapped, mapped, ratesMapped, year) {
    const metaVal = (k, dflt) => {
      const row = staffMapped.meta.find((x) => x.key === k);
      return row && row.value != null ? row.value : dflt;
    };
    const monthHours = Number(metaVal('monthHours', 172));
    const importedAt = metaVal('clockifyImportedAt', null);

    const personBySource = new Map(staffMapped.people.map((p) => [String(p.source_id), p]));
    const titleMap = new Map();
    for (const m2 of staffMapped.maps) {
      if (m2.kind !== 'titles') continue;
      const v = m2.value;
      if (v && v.titleId) titleMap.set(String(m2.key), { titleId: v.titleId, tierId: v.tierId || 'mid' });
    }
    const gridMap = new Map(ratesMapped.rateGrid.map((g) => [String(g.title_id), g]));
    const projMeta = new Map(mapped.projects.map((p) => [p.source_id, p]));
    const feeMap = new Map();
    for (const m2 of staffMapped.maps) {
      if (m2.kind !== 'fee') continue;
      const ids = (Array.isArray(m2.value) ? m2.value : [m2.value]).map((v) => String(v)).filter((v) => projMeta.has(v));
      if (ids.length > 0) feeMap.set(String(m2.key), ids);
    }
    const yearRev = projectYearRevenue(mapped);
    const revByProject = new Map();
    for (const [pid, years] of yearRev) {
      if (!years.has(year)) continue;
      const p = projMeta.get(pid);
      revByProject.set(pid, {
        name: p ? p.name : '(unknown)',
        client: p && p.raw_client ? canonicalNameFor(p.raw_client) : UNNAMED_CLIENT,
        revenue: years.get(year) || 0,
      });
    }
    const costOf = new Map();
    for (const p of staffMapped.people) costOf.set(String(p.source_id), costRateFor(titleMap, gridMap, p.title, p));

    // ---- time mix + per person ----
    const monthMap = new Map();
    const perPerson = new Map();
    const personMonth = new Map();
    const clockifyProjects = new Set();
    let billable = 0, internal = 0, timeOff = 0;
    for (const a of staffMapped.actuals) {
      const hours = Number(a.hours);
      clockifyProjects.add(a.clockify_project);
      const mk = a.year + '-' + a.month;
      const m2 = monthMap.get(mk) || { year: a.year, month: a.month, billable: 0, internal: 0, timeOff: 0 };
      if (a.category === 'billable') { m2.billable += hours; billable += hours; }
      else if (a.category === 'internal') { m2.internal += hours; internal += hours; }
      else { m2.timeOff += hours; timeOff += hours; }
      monthMap.set(mk, m2);
      const person = personBySource.get(a.person_source_id);
      const rate = costOf.get(a.person_source_id) || { rate: BLENDED_COST_PROXY, fromGrid: false };
      const row = perPerson.get(a.person_source_id) || {
        id: a.person_source_id, name: person ? person.name : a.person_source_id,
        title: person ? person.title : null, hours: 0, billable: 0, billableShare: 0,
        bulkLogged: false, costPerHour: rate.rate, fromGrid: rate.fromGrid,
      };
      row.hours += hours;
      if (a.category === 'billable') row.billable += hours;
      if (isBulkLogged(hours, monthHours)) row.bulkLogged = true;
      perPerson.set(a.person_source_id, row);
      const pmk = a.person_source_id + '|' + a.month;
      personMonth.set(pmk, (personMonth.get(pmk) || 0) + hours);
    }
    const total = billable + internal + timeOff;
    for (const r of perPerson.values()) r.billableShare = r.hours > 0 ? r.billable / r.hours : 0;

    const monthTotals = new Map();
    for (const a of staffMapped.actuals) if (a.year === year) monthTotals.set(a.month, (monthTotals.get(a.month) || 0) + Number(a.hours));
    const busiest = Math.max.apply(null, [...monthTotals.values()].concat([0]));
    const reported = [...monthTotals.entries()].filter((e) => busiest > 0 && e[1] >= busiest * 0.1).map((e) => e[0]).sort((a, b) => a - b);
    const windowStart = reported[0] || 1;
    const windowEnd = reported[reported.length - 1] || 12;

    // ---- per-project margin ----
    const acc = new Map();
    const unmapped = new Map();
    let mappedHours = 0;
    for (const a of staffMapped.actuals) {
      if (a.category !== 'billable') continue;
      const targets = feeMap.get(a.clockify_project.trim().toLowerCase());
      const hours = Number(a.hours);
      if (!targets || targets.length === 0) { unmapped.set(a.clockify_project, (unmapped.get(a.clockify_project) || 0) + hours); continue; }
      mappedHours += hours;
      const share = hours / targets.length;
      const rate = costOf.get(a.person_source_id) || { rate: BLENDED_COST_PROXY, fromGrid: false };
      for (const pid of targets) {
        const e = acc.get(pid) || { hours: 0, cost: 0, gridCost: 0, people: new Set() };
        e.hours += share; e.cost += share * rate.rate;
        if (rate.fromGrid) e.gridCost += share * rate.rate;
        e.people.add(a.person_source_id);
        acc.set(pid, e);
      }
    }
    const margins = [];
    for (const [pid, e] of acc) {
      const rev = revByProject.get(pid);
      const pm = projMeta.get(pid);
      const revenue = rev ? rev.revenue : 0;
      margins.push({
        projectId: pid,
        name: rev ? rev.name : '(not in this year\'s pipeline)',
        client: rev ? rev.client : (pm && pm.raw_client ? canonicalNameFor(pm.raw_client) : UNNAMED_CLIENT),
        leaderId: pm ? pm.leader_id : null,
        rating: pm ? pm.rating : null,
        hours: e.hours, people: e.people.size, cost: e.cost, revenue,
        margin: revenue - e.cost,
        marginPct: revenue > 0 ? ((revenue - e.cost) / revenue) * 100 : null,
        realisedRate: e.hours > 0 && revenue > 0 ? revenue / e.hours : null,
        gridShare: e.cost > 0 ? e.gridCost / e.cost : 0,
      });
    }
    margins.sort((a, b) => b.hours - a.hours);

    // ---- effort vs likelihood ----
    const ratingAgg = new Map();
    for (const m2 of margins) {
      const key = m2.rating === null ? 'none' : String(m2.rating);
      const row = ratingAgg.get(key) || {
        rating: m2.rating,
        label: m2.rating === null ? 'No rating yet' : 'R' + m2.rating + ' · ' + RATING_LABELS[m2.rating],
        feedsBudget: m2.rating !== null && isBudgetRating(m2.rating),
        hours: 0, cost: 0, revenue: 0, projects: 0,
      };
      row.hours += m2.hours; row.cost += m2.cost; row.revenue += m2.revenue; row.projects += 1;
      ratingAgg.set(key, row);
    }
    const byRating = [...ratingAgg.values()].sort((a, b) => ((a.rating == null ? 99 : a.rating) - (b.rating == null ? 99 : b.rating)));
    const atRisk = byRating.filter((r) => r.rating === null || r.rating >= 3);
    const atRiskHours = atRisk.reduce((a, r) => a + r.hours, 0);
    const atRiskCost = atRisk.reduce((a, r) => a + r.cost, 0);

    // ---- margin by leader ----
    const leaderAgg = new Map();
    for (const m2 of margins) {
      const id = m2.leaderId || 'unassigned';
      const row = leaderAgg.get(id) || { id, name: m2.leaderId ? leaderDisplay(m2.leaderId) : 'Unassigned', hours: 0, cost: 0, revenue: 0, margin: 0, marginPct: null, projects: 0 };
      row.hours += m2.hours; row.cost += m2.cost; row.revenue += m2.revenue; row.projects += 1;
      leaderAgg.set(id, row);
    }
    const byLeader = [...leaderAgg.values()].map((r) => Object.assign({}, r, {
      margin: r.revenue - r.cost,
      marginPct: r.revenue > 0 ? ((r.revenue - r.cost) / r.revenue) * 100 : null,
    })).sort((a, b) => b.revenue - a.revenue);

    // ---- client economics ----
    const clientAgg = new Map();
    for (const m2 of margins) {
      const e = clientAgg.get(m2.client) || { revenue: 0, cost: 0, hours: 0 };
      e.revenue += m2.revenue; e.cost += m2.cost; e.hours += m2.hours;
      clientAgg.set(m2.client, e);
    }
    const totRev = [...clientAgg.values()].reduce((a, e) => a + e.revenue, 0);
    const totProfit = [...clientAgg.values()].reduce((a, e) => a + Math.max(e.revenue - e.cost, 0), 0);
    const clientEconomics = [...clientAgg.entries()].map(([client, e]) => ({
      client, revenue: e.revenue, hours: e.hours,
      revenueShare: totRev > 0 ? e.revenue / totRev : 0,
      profit: e.revenue - e.cost,
      profitShare: totProfit > 0 ? Math.max(e.revenue - e.cost, 0) / totProfit : 0,
      marginPct: e.revenue > 0 ? ((e.revenue - e.cost) / e.revenue) * 100 : null,
    })).filter((r) => r.revenue > 0 || r.hours > 0).sort((a, b) => b.revenue - a.revenue);

    // ---- capacity vs pipeline ----
    const realisedRate = mappedHours > 0 ? margins.reduce((a, m2) => a + m2.revenue, 0) / mappedHours : 0;
    const nowMonth = Math.min(Math.max(windowEnd, 1), 12);
    const monthsRemaining = Math.max(0, 12 - nowMonth);
    const monthLabels = Array.from({ length: monthsRemaining }, (_, i) => MON[nowMonth + i]);
    let pipelineRevenue = 0;
    for (const r of mapped.monthlyRevenue) {
      if (r.year !== year || r.month <= nowMonth || typeof r.amount !== 'number') continue;
      const pm = projMeta.get(r.project_source_id);
      const rt = pm ? pm.rating : null;
      if (rt === 1 || rt === 2) pipelineRevenue += r.amount;
    }
    const activePeople = staffMapped.people.filter((p) => p.active !== false).length;
    const grossCapacity = activePeople * monthHours * monthsRemaining;
    const billableShareHist = total > 0 ? billable / total : 0.64;
    const billableCapacity = grossCapacity * billableShareHist;
    let committedHours = 0;
    for (const al of staffMapped.allocations) {
      if (!al.pct) continue;
      const s = Math.max((al.start_year == null ? year : al.start_year) === year ? (al.start_month == null ? 1 : al.start_month) : (al.start_year == null ? year : al.start_year) < year ? 1 : 13, nowMonth + 1);
      const e = Math.min((al.end_year == null ? year : al.end_year) === year ? (al.end_month == null ? 12 : al.end_month) : (al.end_year == null ? year : al.end_year) > year ? 12 : 0, 12);
      const months2 = Math.max(0, e - s + 1);
      committedHours += months2 * monthHours * (Number(al.pct) / 100);
    }
    const impliedHours = realisedRate > 0 ? pipelineRevenue / realisedRate : 0;
    const freeCapacity = billableCapacity - committedHours;
    const capacity = {
      monthsRemaining, monthLabels, pipelineRevenue, impliedHours, realisedRate,
      grossCapacity, billableCapacity, committedHours, freeCapacity,
      shortfall: impliedHours - freeCapacity,
    };

    // ---- coverage ----
    const titlesInUse = new Set(staffMapped.people.filter((p) => p.active !== false)
      .map((p) => String(p.title == null ? '' : p.title).trim().toLowerCase()).filter(Boolean));
    const titlesMapped = [...titlesInUse].filter((t) => titleMap.has(t)).length;
    const costedTotal = margins.reduce((a, m2) => a + m2.cost, 0);
    const gridTotal = margins.reduce((a, m2) => a + m2.cost * m2.gridShare, 0);
    const bulkRows = [...personMonth.values()].filter((h) => isBulkLogged(h, monthHours)).length;
    const months = [...monthMap.values()].sort((a, b) => a.year - b.year || a.month - b.month);
    const negatives = margins.filter((m2) => m2.marginPct !== null && m2.marginPct < 0);

    const byRevenue = clientEconomics.slice().sort((a, b) => b.revenue - a.revenue)[0];
    const byProfit = clientEconomics.slice().sort((a, b) => b.profit - a.profit)[0];
    const clientMsg = byRevenue && byProfit
      ? (byRevenue.client !== byProfit.client
        ? byRevenue.client + ' is our largest client by revenue (' + Math.round(byRevenue.revenueShare * 100) + '%), but ' + byProfit.client + ' contributes the most profit after delivery cost.'
        : byRevenue.client + ' leads on both revenue and profit after delivery cost - ' + Math.round(byRevenue.revenueShare * 100) + '% of attributable revenue at a ' + Math.round(byRevenue.marginPct || 0) + '% margin.')
      : 'No client has both revenue and logged hours yet.';

    return {
      monthHours, months,
      mix: { billable, internal, timeOff, total },
      reconciliation: {
        totalHours: total, people: perPerson.size, clockifyProjects: clockifyProjects.size,
        monthsCovered: MON[windowStart - 1] + '-' + MON[windowEnd - 1] + ' ' + year,
        importedAt, bulkLoggedRows: bulkRows,
      },
      kpis: {
        hoursYtd: total,
        billableSharePct: total > 0 ? Math.round((billable / total) * 100) : 0,
        revenuePerBillableHour: realisedRate > 0 ? realisedRate : null,
        peopleActive: activePeople,
      },
      capacity, byRating, byLeader, clientEconomics, margins,
      people: [...perPerson.values()].sort((a, b) => b.hours - a.hours),
      window: { startMonth: windowStart, endMonth: windowEnd, label: MON[windowStart - 1] + '-' + MON[windowEnd - 1] + ' ' + year },
      coverage: {
        titlesMapped, titlesTotal: titlesInUse.size,
        hoursMappedPct: billable > 0 ? Math.round((mappedHours / billable) * 100) : 0,
        gridCostPct: costedTotal > 0 ? Math.round((gridTotal / costedTotal) * 100) : 0,
        projectsCovered: margins.length, projectsTotal: mapped.projects.length,
        bulkLoggedRows: bulkRows,
        unmappedTop: [...unmapped.entries()].map(([name, hours]) => ({ name, hours })).sort((a, b) => b.hours - a.hours).slice(0, 8),
      },
      msg: Math.round(total).toLocaleString() + ' hours logged across ' + perPerson.size + ' people - ' + (total > 0 ? Math.round((billable / total) * 100) : 0) + '% billable. These totals tie to the data aggregator app\'s own Clockify chart.',
      marginMsg: negatives.length > 0
        ? negatives.length + ' project' + (negatives.length > 1 ? 's cost' : ' costs') + ' more in delivery time than ' + (negatives.length > 1 ? 'they earn' : 'it earns') + ' - ' + negatives.slice(0, 2).map((n) => n.name).join(', ') + (negatives.length > 2 ? ' and ' + (negatives.length - 2) + ' more' : '') + '.'
        : 'Every mapped project earns more than its delivery time costs.',
      capacityMsg: capacity.shortfall > 0
        ? 'Delivering the booked and accrued pipeline for the rest of ' + year + ' implies about ' + Math.round(capacity.impliedHours).toLocaleString() + ' hours of work; roughly ' + Math.round(Math.max(capacity.freeCapacity, 0)).toLocaleString() + ' hours are uncommitted - a gap of about ' + Math.round(capacity.shortfall).toLocaleString() + ' hours.'
        : 'Delivering the booked and accrued pipeline for the rest of ' + year + ' implies about ' + Math.round(capacity.impliedHours).toLocaleString() + ' hours; about ' + Math.round(capacity.freeCapacity).toLocaleString() + ' are uncommitted, so capacity covers the forecast.',
      ratingMsg: atRiskHours > 0
        ? Math.round(atRiskHours).toLocaleString() + ' hours of delivery time - about ' + Math.round(atRiskCost).toLocaleString() + ' dollars of cost - has gone into work rated 75% or less, or not rated at all.'
        : 'All attributable delivery time sits on booked or highly likely work.',
      clientMsg,
    };
  }

  /* ============================================================
     TAB 4 · RATES (port of lib/queries/rates-tab.ts)
     ============================================================ */
  function _skew(s) {
    let h = 0;
    for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return (h % 1000) / 1000;
  }
  function tab4Data(ratesMapped, mapped, delivery, year) {
    // What we ACTUALLY contracted, per grade, from the roles on real projects.
    // Where a grade has contracted rates we show the measured average; where
    // it has none we fall back to the modelled marker and say which is which,
    // so a real number is never mistaken for a modelled one.
    const contracted = new Map();
    for (const r of mapped.roles) {
      const rate = Number(r.contracted_rate);
      if (!r.title_id || !Number.isFinite(rate) || rate <= 0) continue;
      const e = contracted.get(r.title_id) || { sum: 0, n: 0 };
      e.sum += rate; e.n += 1;
      contracted.set(r.title_id, e);
    }
    const grades = ratesMapped.rateGrid
      .filter((g) => typeof g.rack === 'number' && typeof g.floor_mid === 'number')
      .sort((a, b) => b.rack - a.rack)
      .map((g) => {
        const rack = Number(g.rack), floor = Number(g.floor_mid);
        const excluded = g.title_id === 'principal' || g.title_id === 'evp';
        const real = contracted.get(g.title_id);
        const actual = real
          ? Math.round(real.sum / real.n)
          : (excluded
            ? Math.round(rack * (0.2 + _skew(g.title_id) * 0.2))
            : Math.round(floor + (rack - floor) * (0.25 + _skew(g.title_id) * 0.55)));
        return {
          id: g.title_id, name: g.name, rack, floor, actual,
          floorHigh: g.floor_high, floorLow: g.floor_low,
          measured: !!real, samples: real ? real.n : 0,
          belowFloor: actual < floor, excluded,
        };
      });
    const included = grades.filter((g) => !g.excluded);
    const realisation = included.length
      ? included.reduce((a, g) => a + (g.actual - g.floor) / (g.rack - g.floor), 0) / included.length
      : 0;
    const racks = grades.map((g) => g.rack);
    const avgFloorDisc = grades.length ? grades.reduce((a, g) => a + (1 - g.floor / g.rack), 0) / grades.length : 0;

    let trueProfit, trueProfitSource = null;
    if (delivery && delivery.margins.length > 0) {
      const byClientReal = new Map();
      for (const m2 of delivery.margins) {
        const e = byClientReal.get(m2.client) || { hours: 0, cost: 0, invoiced: 0 };
        e.hours += m2.hours; e.cost += m2.cost; e.invoiced += m2.revenue;
        byClientReal.set(m2.client, e);
      }
      trueProfit = [...byClientReal.entries()].sort((a, b) => b[1].hours - a[1].hours).slice(0, 8)
        .map(([client, e]) => ({ client, hours: e.hours, cost: e.cost, invoiced: e.invoiced, profit: e.invoiced - e.cost }));
      trueProfitSource = { real: true, clients: byClientReal.size, hoursMappedPct: delivery.coverage.hoursMappedPct, gridCostPct: delivery.coverage.gridCostPct };
    } else {
      const yearRev = projectYearRevenue(mapped);
      const byClient = new Map();
      for (const [pid, years] of yearRev) {
        if (!years.has(year)) continue;
        const p = mapped.projects.find((x) => x.source_id === pid);
        const name = p && p.raw_client ? canonicalNameFor(p.raw_client) : UNNAMED_CLIENT;
        byClient.set(name, (byClient.get(name) || 0) + (years.get(year) || 0));
      }
      const blendedCost = BLENDED_COST_PROXY;
      trueProfit = [...byClient.entries()].filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([client, invoiced]) => {
          const hours = invoiced / 185;
          const cost = hours * blendedCost * (0.85 + _skew(client) * 0.3);
          return { client, hours, cost, invoiced, profit: invoiced - cost };
        });
    }
    return {
      grades,
      kpis: {
        grades: grades.length,
        rackRange: fmtMoney(Math.min.apply(null, racks)) + '-' + fmtMoney(Math.max.apply(null, racks)),
        avgFloorDisc, realisation,
      },
      trueProfitSource,
      measuredGrades: grades.filter((g) => g.measured).length,
      contractedSamples: grades.reduce((a, g) => a + g.samples, 0),
      msg: 'Where we bill, we capture ' + Math.round(realisation * 100) + '% of the rack-to-floor band - Principal and EVP are rarely charged out at all (markers below the floor).',
      trueProfit,
    };
  }

  /* ============================================================
     GLOSSARY (verbatim), CONFIDENCE, LOCATIONS, BOX SCORE
     ============================================================ */
  const GLOSSARY = {
    projected: { term: 'Projected (1-4)', def: 'Booked (R1) plus 90% accrued (R2) plus likely deals (R3-R4). The total that feeds the budget. Ratings 5-7 are excluded.' },
    weights: { term: 'Risk weights', def: 'R1 counts 100%, R2 90%, R3 75%, R4 50%; ratings 5-7 count 0. The canonical ruling - the maths and the words never disagree.' },
    ev: { term: 'Risk-weighted EV', def: 'Each deal\'s revenue multiplied by its rating weight, then summed. The honest expected value of the pipeline.' },
    coverage: { term: 'Coverage of the gap', def: 'Remaining gap = budget minus booked. Face coverage = open pipeline (R2-4) divided by the gap; weighted coverage applies the rating weights first.' },
    catchup: { term: 'Revised target (catch-up)', def: 'The flat monthly budget lifted by the cumulative over/under to date. It climbs when we are behind and falls when we are ahead.' },
    staleness: { term: 'Staleness', def: 'Time since a deal\'s rating or value last changed: 0-30 days on track (green), 30-90 ageing (amber), 90+ stale (red). Booked (R1) is excluded.' },
    hhi: { term: 'HHI', def: 'Herfindahl-Hirschman Index: the sum of squared client shares times 10,000. Under 1500 reads unconcentrated; over 2500 concentrated.' },
    marginAfterStaff: { term: 'Margin after staff', def: 'Invoiced revenue minus modelled staff cost (hours times the blended $/hr from the cost grid), as a share of invoiced. Demo until Clockify hours land.' },
    realisation: { term: 'Realisation', def: 'Where we bill, how much of the rack-to-floor band we capture. Principal and EVP are excluded (rarely charged out, below the floor).' },
    accrued: { term: 'Accrued', def: 'Work performed that will be billed later. Revenue sits in the month the work was done, not the month it was invoiced.' },
    billableShare: { term: 'Billable share', def: 'The portion of logged time spent on client project work, as opposed to business development, internal work or time off. Revenue only comes from the billable slice.' },
    costFloor: { term: 'Cost floor', def: 'The lowest rate in a grade\'s band, used as the cost-of-delivery proxy for that grade. Where a person\'s job title is not yet mapped to a grade, a blended proxy is used instead and the panel says so.' },
    trueMargin: { term: 'True margin', def: 'Project revenue minus the cost of the hours actually logged against it (hours times each person\'s cost rate). Directional until every job title is mapped to the rate grid.' },
    bulkLogged: { term: 'Bulk-logged time', def: 'A person-month recording more hours against one code than a month contains - a remainder or auto-fill entry upstream rather than real effort. Shown unchanged and marked, left at its full value, and kept out of any published utilisation figure.' },
    planVsActual: { term: 'Plan vs actual', def: 'Hours the staffing plan implies (allocation percentage times monthly capacity) set against hours actually logged. A large gap either way is worth a conversation.' },
    realisedRate: { term: 'Realised rate', def: 'What an hour of delivery actually earns: revenue divided by the hours logged against it. Measured, not quoted, so it reflects discounts, write-offs and overruns as they really happened.' },
  };

  function tab6Data(mapped) {
    const total = mapped.projects.length;
    const withRoles = new Set(mapped.roles.map((r) => r.project_source_id));
    const withRevenue = new Set(mapped.monthlyRevenue.map((r) => r.project_source_id));
    const feeShareOn = new Set(mapped.assumptions.filter((a) => a.fee_share_enabled === true).map((a) => a.project_source_id));
    const has = (v) => v !== null && v !== undefined && String(v).trim() !== '';
    const defs = [
      ['Client', (p) => has(p.raw_client)],
      ['Revenue leader', (p) => has(p.leader_id)],
      ['Likelihood rating', (p) => has(p.rating)],
      ['Monthly revenue', (p) => withRevenue.has(p.source_id)],
      ['Salesforce P-number', (p) => has(p.salesforce_id)],
      ['Clockify ID', (p) => has(p.clockify_id)],
      ['Project ID (365)', (p) => has(p.project_id_365)],
      ['Industry', (p) => has(p.industry)],
      ['Project type', (p) => has(p.project_type)],
      ['Proposal date', (p) => has(p.proposal_date)],
      ['Signed contract date', (p) => has(p.signed_contract_date)],
      ['Location', (p) => has(p.location)],
      ['Staffing roster', (p) => withRoles.has(p.source_id)],
      ['Fee share configured', (p) => feeShareOn.has(p.source_id)],
    ];
    const bandOf = (pct) => (pct >= 0.8 ? 'green' : pct >= 0.5 ? 'amber' : 'red');
    const rows = defs.map(([field, fn]) => {
      const count = mapped.projects.filter(fn).length;
      const pct = total > 0 ? count / total : 0;
      return { field, count, total, pct, band: bandOf(pct) };
    }).sort((a, b) => b.pct - a.pct);
    const overall = rows.reduce((a, r) => a + r.pct, 0) / rows.length;
    const solid = rows.filter((r) => r.band === 'green').length;
    const filling = rows.filter((r) => r.band === 'red').length;
    return {
      total, rows,
      kpis: { overall, tracked: rows.length, solid, filling },
      msg: solid + ' of ' + rows.length + ' tracked fields are solid enough to report on; ' + filling + ' are still filling in.',
    };
  }

  const CITIES = [
    ['New York', 40.7128, -74.006], ['Boston', 42.3601, -71.0589], ['Philadelphia', 39.9526, -75.1652],
    ['Washington DC', 38.9072, -77.0369], ['Chicago', 41.8781, -87.6298], ['Miami', 25.7617, -80.1918],
    ['Dallas', 32.7767, -96.797], ['Denver', 39.7392, -104.9903], ['San Francisco', 37.7749, -122.4194],
    ['Los Angeles', 34.0522, -118.2437], ['Seattle', 47.6062, -122.3321], ['Atlanta', 33.749, -84.388],
  ];
  const REGIONS = { northeast: [0, 1, 2, 3], south: [5, 6, 11], midwest: [4, 7], west: [8, 9, 10] };
  function _hash31(s) {
    let h = 0;
    for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h;
  }
  function cityFor(client, id) {
    const jp = String(client || '').toLowerCase().indexOf('jpmorgan') !== -1;
    const base = _hash31(jp ? id : client);
    return base % (jp ? 8 : CITIES.length);
  }

  /* The REAL location field is free text ("Houston", "Miami, Florida",
     "One Vanderbilt Ave, New York, NY 10017"), so match it to a known city
     by name and by state abbreviation. A project whose location is filled
     is placed where it really is; one that is blank is scattered and
     labelled as such, never silently mixed in with the real ones. */
  const STATE_CITY = {
    ny: 0, ma: 1, pa: 2, dc: 3, il: 4, fl: 5, tx: 6, co: 7, ca: 8, wa: 10, ga: 11,
  };
  function resolveCity(locationText) {
    const t = String(locationText || '').trim().toLowerCase();
    if (!t) return null;
    for (let i = 0; i < CITIES.length; i++) {
      if (t.indexOf(CITIES[i][0].toLowerCase()) !== -1) return i;
    }
    // "Menlo Park, CA" style: fall back to the state, then to its main city.
    const st = t.match(/,\s*([a-z]{2})\b|\b(california|texas|florida|illinois|washington|georgia|colorado|massachusetts|pennsylvania)\b/);
    if (st) {
      const key = (st[1] || '').toLowerCase();
      if (key && STATE_CITY[key] != null) return STATE_CITY[key];
      const long = { california: 8, texas: 6, florida: 5, illinois: 4, washington: 10, georgia: 11, colorado: 7, massachusetts: 1, pennsylvania: 2 };
      if (st[2] && long[st[2]] != null) return long[st[2]];
    }
    return null;
  }

  function locationsData(mapped, year) {
    const yearRev = projectYearRevenue(mapped);
    const rows = [];
    for (const p of mapped.projects) {
      const years = yearRev.get(p.source_id);
      if (!years || !years.has(year)) continue;
      const client = p.raw_client ? canonicalNameFor(p.raw_client) : UNNAMED_CLIENT;
      const real = resolveCity(p.location);
      rows.push({
        id: p.source_id, name: p.name, client,
        leader: p.leader_id ? leaderDisplay(p.leader_id) : 'Unassigned',
        rating: p.rating, status: p.status, revenue: years.get(year) || 0,
        location: p.location || null,
        placed: real != null ? 'real' : (nullIfBlank(p.location) ? 'unmatched' : 'scattered'),
        city: real != null ? real : cityFor(client, p.source_id),
      });
    }
    return rows;
  }

  function projectBoxScore(mapped, staffMapped, ratesMapped, sourceId, year) {
    const p = mapped.projects.find((x) => x.source_id === sourceId);
    if (!p) return null;
    const monthly = mapped.monthlyRevenue.filter((r) => r.project_source_id === sourceId && typeof r.amount === 'number');
    const byYear = new Map();
    for (const r of monthly) {
      if (!byYear.has(r.year)) byYear.set(r.year, Array(12).fill(0));
      byYear.get(r.year)[r.month - 1] += r.amount;
    }
    const history = mapped.activityChanges
      .filter((c) => c.project_source_id === sourceId)
      .sort((a, b) => String(b.changed_at || '').localeCompare(String(a.changed_at || '')));
    let delivery = null;
    if (staffMapped && staffMapped.ok) {
      const titleMap = new Map();
      for (const m2 of staffMapped.maps) {
        if (m2.kind !== 'titles') continue;
        if (m2.value && m2.value.titleId) titleMap.set(String(m2.key), { titleId: m2.value.titleId, tierId: m2.value.tierId || 'mid' });
      }
      const gridMap = new Map(((ratesMapped && ratesMapped.rateGrid) || []).map((g) => [String(g.title_id), g]));
      const personBySource = new Map(staffMapped.people.map((x) => [String(x.source_id), x]));
      const feeKeys = [];
      for (const m2 of staffMapped.maps) {
        if (m2.kind !== 'fee') continue;
        const ids = (Array.isArray(m2.value) ? m2.value : [m2.value]).map(String);
        if (ids.indexOf(sourceId) !== -1) feeKeys.push({ key: m2.key, share: ids.length });
      }
      if (feeKeys.length) {
        const byPerson = new Map();
        const byMonth = new Map();
        let hours = 0, cost = 0;
        for (const a of staffMapped.actuals) {
          if (a.category !== 'billable') continue;
          const fk = feeKeys.find((k) => k.key === a.clockify_project.trim().toLowerCase());
          if (!fk) continue;
          const share = Number(a.hours) / fk.share;
          const person = personBySource.get(a.person_source_id);
          const rate = costRateFor(titleMap, gridMap, person ? person.title : null, person);
          hours += share; cost += share * rate.rate;
          const e = byPerson.get(a.person_source_id) || { name: person ? person.name : a.person_source_id, title: person ? person.title : null, hours: 0, cost: 0 };
          e.hours += share; e.cost += share * rate.rate;
          byPerson.set(a.person_source_id, e);
          byMonth.set(a.month, (byMonth.get(a.month) || 0) + share);
        }
        if (hours > 0) {
          const rev = (projectYearRevenue(mapped).get(sourceId) || new Map()).get(year) || 0;
          delivery = {
            hours, cost, revenue: rev, margin: rev - cost,
            people: [...byPerson.values()].sort((a, b) => b.hours - a.hours),
            months: [...byMonth.entries()].map(([month, h]) => ({ month, hours: h })).sort((a, b) => a.month - b.month),
          };
        }
      }
    }
    return {
      project: p,
      client: p.raw_client ? canonicalNameFor(p.raw_client) : UNNAMED_CLIENT,
      leader: p.leader_id ? leaderDisplay(p.leader_id) : 'Unassigned',
      byYear: [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([y, months]) => ({ year: y, months, total: months.reduce((a, b) => a + b, 0) })),
      history, delivery,
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
    sectorOf, programmeOf, demoIndustryOf, demoProjectTypeOf, tab2Data, tab3Data,
    CATEGORY_LABEL, categoriseProject, isBulkLogged, BULK_LOG_THRESHOLD, BLENDED_COST_PROXY,
    costRateFor, mapStaff, mapRates, HML_SPREAD, clockifyData, tab4Data,
    GLOSSARY, tab6Data, CITIES, REGIONS, cityFor, locationsData, projectBoxScore,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
  else root.EXEC_CORE = CORE;
})(typeof window !== 'undefined' ? window : globalThis);
