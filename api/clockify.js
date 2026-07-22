/* ============================================================
   VERCEL SERVERLESS FUNCTION · Clockify → aggregated actuals CSV
   ------------------------------------------------------------
   Paths:
     /api/clockify?start=2026-01-01&end=2026-06-30   → actuals CSV
     /api/clockify?list=projects                     → project list CSV
     /api/clockify?lateness=1&start&end              → entry-lateness stats CSV
       (creation time is decoded from each entry's MongoDB ObjectID — first
        4 bytes are a unix timestamp — vs the day the work happened; the
        detailed report is paged server-side and only per-user aggregates
        travel to the browser, so it stays fast)

   WHY THIS EXISTS
     The Staffing & Bandwidth page needs ACTUAL hours by
     user × project × month. Pulling raw time entries is huge and slow;
     Clockify's Reports API aggregates server-side, so ONE request
     returns a few hundred rows no matter how many entries exist.
     The API key must never live in browser code, so this proxy holds
     it as an environment variable and returns a small CSV the page's
     existing importer ingests directly.

   SETUP (Vercel project → Settings → Environment Variables)
     CLOCKIFY_API_KEY       = Profile → Advanced → API Key  (use a
                              reporting/service account, not a personal one)
     CLOCKIFY_WORKSPACE_ID  = Workspace Settings URL: /workspaces/{THIS}/…

   RESPONSE  text/csv:
     User,Project,Client,Duration (decimal),Start Date
   (Start Date = first of the month — the importer buckets by month.)
   ============================================================ */

const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
function normMonth(name) {
  const s = String(name || '').trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})/))) return m[1] + '-' + m[2];                    // 2026-04…
  if ((m = s.match(/^([A-Za-z]{3,9})[ ,]+(\d{4})$/))) {                                // Apr 2026 / April 2026
    const mm = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mm) return m[2] + '-' + mm;
  }
  if ((m = s.match(/^(\d{1,2})\/(\d{4})$/))) return m[2] + '-' + String(+m[1]).padStart(2, '0'); // 04/2026
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 7);
  return null;
}
function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

export default async function handler(req, res) {
  const key = process.env.CLOCKIFY_API_KEY;
  const ws = process.env.CLOCKIFY_WORKSPACE_ID;
  if (!key || !ws) { res.status(501).json({ error: 'not configured', detail: 'Set CLOCKIFY_API_KEY and CLOCKIFY_WORKSPACE_ID in Vercel env vars.' }); return; }

  // ---- project list mode: canonical names for the one-time matrix rename ----
  if (req.query.list === 'projects') {
    try {
      const out = [];
      for (let page = 1; page <= 10; page++) {
        const r = await fetch(`https://api.clockify.me/api/v1/workspaces/${ws}/projects?page-size=500&page=${page}&archived=false`, { headers: { 'X-Api-Key': key } });
        if (!r.ok) { res.status(502).json({ error: 'clockify ' + r.status, detail: (await r.text()).slice(0, 300) }); return; }
        const batch = await r.json();
        batch.forEach(p => out.push([p.name || '', p.clientName || '']));
        if (batch.length < 500) break;
      }
      const csv = 'Project,Client\n' + out.map(r2 => r2.map(csvCell).join(',')).join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(csv);
    } catch (e) { res.status(500).json({ error: 'proxy failed', detail: String(e && e.message || e).slice(0, 300) }); }
    return;
  }

  const start = String(req.query.start || '').slice(0, 10);
  const end = String(req.query.end || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    res.status(400).json({ error: 'pass start=YYYY-MM-DD&end=YYYY-MM-DD' }); return;
  }

  // ---- lateness mode: per-user entry-timeliness aggregates ----
  if (req.query.lateness) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) { res.status(400).json({ error: 'pass start=YYYY-MM-DD&end=YYYY-MM-DD' }); return; }
    try {
      const agg = {};   // user|ym -> stats
      let page = 1;
      while (page <= 25) {   // hard cap: 25k entries per pull
        const rep = await fetch(`https://reports.api.clockify.me/v1/workspaces/${ws}/reports/detailed`, {
          method: 'POST',
          headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dateRangeStart: start + 'T00:00:00.000', dateRangeEnd: end + 'T23:59:59.999',
            detailedFilter: { page, pageSize: 1000 }, exportType: 'JSON',
          }),
        });
        if (!rep.ok) { res.status(502).json({ error: 'clockify ' + rep.status, detail: (await rep.text()).slice(0, 300) }); return; }
        const data = await rep.json();
        const entries = data.timeentries || [];
        entries.forEach(t => {
          const id = t._id || t.id || '';
          const startIso = t.timeInterval && t.timeInterval.start; if (!startIso || id.length < 8) return;
          const created = parseInt(id.slice(0, 8), 16) * 1000;             // ObjectID timestamp
          const workDay = new Date(startIso);
          const lagDays = Math.max(0, (created - workDay.getTime()) / 86400000);
          const ym = startIso.slice(0, 7);
          const hrs = (t.timeInterval.duration || 0) / 3600;
          const k2 = (t.userName || '') + '|' + ym;
          const a = agg[k2] || (agg[k2] = { user: t.userName || '', ym, entries: 0, hours: 0, lagSum: 0, lagMax: 0, within3: 0, within7: 0 });
          a.entries++; a.hours += hrs; a.lagSum += lagDays; a.lagMax = Math.max(a.lagMax, lagDays);
          if (lagDays <= 3) a.within3++; if (lagDays <= 7) a.within7++;
        });
        if (entries.length < 1000) break;
        page++;
      }
      const csv = 'User,Month,Entries,Hours,AvgLagDays,MaxLagDays,PctWithin3d,PctWithin7d\n'
        + Object.values(agg).map(a => [a.user, a.ym, a.entries, Math.round(a.hours * 10) / 10, Math.round(a.lagSum / a.entries * 10) / 10, Math.round(a.lagMax), Math.round(a.within3 / a.entries * 100), Math.round(a.within7 / a.entries * 100)].map(csvCell).join(',')).join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(csv);
    } catch (e) { res.status(500).json({ error: 'proxy failed', detail: String(e && e.message || e).slice(0, 300) }); }
    return;
  }

  try {
    // Summary report, grouped USER → PROJECT → MONTH — aggregated server-side.
    const rep = await fetch(`https://reports.api.clockify.me/v1/workspaces/${ws}/reports/summary`, {
      method: 'POST',
      headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dateRangeStart: start + 'T00:00:00.000',
        dateRangeEnd: end + 'T23:59:59.999',
        summaryFilter: { groups: ['USER', 'PROJECT', 'MONTH'] },
        exportType: 'JSON',
      }),
    });
    if (!rep.ok) { res.status(502).json({ error: 'clockify ' + rep.status, detail: (await rep.text()).slice(0, 400) }); return; }
    const data = await rep.json();

    // Flatten nested groups → rows. duration is in seconds.
    const rows = [];
    (data.groupOne || []).forEach(user => {
      (user.children || []).forEach(proj => {
        const client = proj.clientName || '';
        (proj.children || []).forEach(mon => {
          const ym = normMonth(mon.name);
          const hrs = Math.round(((mon.duration || 0) / 3600) * 100) / 100;
          if (!ym || !hrs) return;
          rows.push([user.name || '', proj.name || '', client, hrs, ym + '-01']);
        });
      });
    });

    const csv = 'User,Project,Client,Duration (decimal),Start Date\n'
      + rows.map(r => r.map(csvCell).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(csv);
  } catch (e) {
    res.status(500).json({ error: 'proxy failed', detail: String(e && e.message || e).slice(0, 300) });
  }
}
