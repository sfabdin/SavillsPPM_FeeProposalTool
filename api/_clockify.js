/* Clockify pulls, shared by the on-demand proxy (api/clockify.js) and the
   daily scheduled job (api/clockify-daily.js). Every function returns the
   same CSV the browser importer already ingests, so the daily drop lands
   through the exact code path the Import button uses.

   Underscore-prefixed files in api/ are not routes. */

const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
export function normMonth(name) {
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
export function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
export const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** An error carrying the upstream status so a handler can answer 502 with detail. */
export class ClockifyError extends Error { constructor(status, detail) { super('clockify ' + status); this.status = status; this.detail = String(detail || '').slice(0, 400); } }

const API = 'https://api.clockify.me/api/v1', REPORTS = 'https://reports.api.clockify.me/v1';
const hdr = (key) => ({ 'X-Api-Key': key, 'Content-Type': 'application/json' });
async function getJson(fetchFn, url, key) { const r = await fetchFn(url, { headers: { 'X-Api-Key': key } }); if (!r.ok) throw new ClockifyError(r.status, await r.text()); return r.json(); }
async function report(fetchFn, ws, key, kind, body) { const r = await fetchFn(`${REPORTS}/workspaces/${ws}/reports/${kind}`, { method: 'POST', headers: hdr(key), body: JSON.stringify(body) }); if (!r.ok) throw new ClockifyError(r.status, await r.text()); return r.json(); }

/** Users with the job title that rides along as a workspace custom field. */
export async function usersCsv({ key, ws, fetch: fetchFn = fetch }) {
  const users = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await getJson(fetchFn, `${API}/workspaces/${ws}/users?page-size=500&page=${page}&status=ALL&memberships=ALL`, key);
    batch.forEach(u => {
      let title = '';
      const cfs = Array.isArray(u.customFields) ? u.customFields : [];
      const hit = cfs.find(c => /title/i.test(c.customFieldName || '')) || cfs.find(c => c.value);
      if (hit && hit.value != null) title = String(hit.value).trim();
      users.push({ id: u.id, name: u.name || '', email: u.email || '', status: u.status || '', title });
    });
    if (batch.length < 500) break;
  }
  return { users, csv: 'User,Email,Status,JobTitle\n' + users.map(u => [u.name, u.email, u.status, u.title].map(csvCell).join(',')).join('\n') };
}

/** Active projects with their client. */
export async function projectsCsv({ key, ws, fetch: fetchFn = fetch }) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await getJson(fetchFn, `${API}/workspaces/${ws}/projects?page-size=500&page=${page}&archived=false`, key);
    batch.forEach(p => out.push([p.name || '', p.clientName || '']));
    if (batch.length < 500) break;
  }
  return { rows: out, csv: 'Project,Client\n' + out.map(r2 => r2.map(csvCell).join(',')).join('\n') };
}

/** Per-user entry-timeliness aggregates for a date range (creation time is
    decoded from each entry's MongoDB ObjectID, vs the day the work happened). */
export async function latenessCsv({ key, ws, start, end, fetch: fetchFn = fetch, maxPages = 25 }) {
  const agg = {};
  let page = 1;
  while (page <= maxPages) {
    const data = await report(fetchFn, ws, key, 'detailed', { dateRangeStart: start + 'T00:00:00.000', dateRangeEnd: end + 'T23:59:59.999', detailedFilter: { page, pageSize: 1000 }, exportType: 'JSON' });
    const entries = data.timeentries || [];
    entries.forEach(t => {
      const id = t._id || t.id || '';
      const startIso = t.timeInterval && t.timeInterval.start; if (!startIso || id.length < 8) return;
      const created = parseInt(id.slice(0, 8), 16) * 1000;
      const workDay = new Date(startIso);
      const lagDays = Math.max(0, (created - workDay.getTime()) / 86400000);
      const ym = startIso.slice(0, 7);
      const hrs = (t.timeInterval.duration || 0) / 3600;
      const k2 = (t.userName || '') + '|' + ym;
      const a = agg[k2] || (agg[k2] = { user: t.userName || '', ym, entries: 0, hours: 0, lagSum: 0, lagMax: 0, within3: 0, within7: 0, lastWorked: '', lastEntered: '' });
      a.entries++; a.hours += hrs; a.lagSum += lagDays; a.lagMax = Math.max(a.lagMax, lagDays);
      const workDate = startIso.slice(0, 10), enteredDate = new Date(created).toISOString().slice(0, 10);
      if (workDate > a.lastWorked) a.lastWorked = workDate;
      if (enteredDate > a.lastEntered) a.lastEntered = enteredDate;
      if (lagDays <= 3) a.within3++; if (lagDays <= 7) a.within7++;
    });
    if (entries.length < 1000) break;
    page++;
  }
  const csv = 'User,Month,Entries,Hours,AvgLagDays,MaxLagDays,PctWithin3d,PctWithin7d,LastWorked,LastEntered\n'
    + Object.values(agg).map(a => [a.user, a.ym, a.entries, Math.round(a.hours * 10) / 10, Math.round(a.lagSum / a.entries * 10) / 10, Math.round(a.lagMax), Math.round(a.within3 / a.entries * 100), Math.round(a.within7 / a.entries * 100), a.lastWorked, a.lastEntered].map(csvCell).join(',')).join('\n');
  return { rows: Object.values(agg).length, csv };
}

/** Hours by user × project × month, with the day each person last logged time for. */
export async function actualsCsv({ key, ws, start, end, fetch: fetchFn = fetch }) {
  const data = await report(fetchFn, ws, key, 'summary', { dateRangeStart: start + 'T00:00:00.000', dateRangeEnd: end + 'T23:59:59.999', summaryFilter: { groups: ['USER', 'PROJECT', 'MONTH'] }, exportType: 'JSON' });
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
  const lastWorked = {};
  const toDay = (name) => { const n = String(name || '').trim(); if (/^\d{4}-\d{2}-\d{2}/.test(n)) return n.slice(0, 10); const t = Date.parse(n); return isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10); };
  try {
    const dj = await report(fetchFn, ws, key, 'summary', { dateRangeStart: start + 'T00:00:00.000', dateRangeEnd: end + 'T23:59:59.999', summaryFilter: { groups: ['USER', 'DATE'] }, exportType: 'JSON' });
    (dj.groupOne || []).forEach(user => { const u = user.name || ''; if (!u) return; (user.children || []).forEach(d => { const day = toDay(d.name); if (day && (!lastWorked[u] || day > lastWorked[u])) lastWorked[u] = day; }); });
  } catch (e) { /* fall through to the detailed walk */ }
  try {
    const users = new Set(rows.map(r => r[0]).filter(Boolean));
    let page = 1;
    while (page <= 5 && users.size > Object.keys(lastWorked).length) {
      const dj = await report(fetchFn, ws, key, 'detailed', { dateRangeStart: start + 'T00:00:00.000', dateRangeEnd: end + 'T23:59:59.999', sortOrder: 'DESCENDING', detailedFilter: { page, pageSize: 1000, sortColumn: 'DATE' }, exportType: 'JSON' });
      const entries = dj.timeentries || [];
      entries.forEach(t => { const u = t.userName || ''; const s = t.timeInterval && t.timeInterval.start; if (!u || !s) return; const day = s.slice(0, 10); if (!lastWorked[u] || day > lastWorked[u]) lastWorked[u] = day; });
      if (entries.length < 1000) break;
      page++;
    }
  } catch (e) { /* the dates are a bonus */ }
  const csv = 'User,Project,Client,Duration (decimal),Start Date,Last Worked\n' + rows.map(r => r.concat([lastWorked[r[0]] || '']).map(csvCell).join(',')).join('\n');
  return { rows: rows.length, csv };
}

/** The daily drop: everything the staffing page imports, in one JSON file.
    `now` is injectable for tests. Actuals cover the last 13 months, lateness
    the last 6 — the windows the page pulls by hand, bounded so the job
    finishes well inside a serverless minute. */
export async function buildDrop({ key, ws, fetch: fetchFn = fetch, now = new Date() }) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();   // 0-based
  const first = (yy, mm) => new Date(Date.UTC(yy, mm, 1)).toISOString().slice(0, 10);
  const last = (yy, mm) => new Date(Date.UTC(yy, mm + 1, 0)).toISOString().slice(0, 10);
  const aStart = first(y, m - 12), aEnd = last(y, m);
  const lStart = first(y, m - 5), lEnd = now.toISOString().slice(0, 10);
  const t0 = Date.now(); const timing = {};
  const step = async (name, fn) => { const s = Date.now(); const r = await fn(); timing[name] = Date.now() - s; return r; };
  const actuals = await step('actuals', () => actualsCsv({ key, ws, start: aStart, end: aEnd, fetch: fetchFn }));
  const users = await step('users', () => usersCsv({ key, ws, fetch: fetchFn }));
  const projects = await step('projects', () => projectsCsv({ key, ws, fetch: fetchFn }));
  let lateness = null, latenessError = '';
  try { lateness = await step('lateness', () => latenessCsv({ key, ws, start: lStart, end: lEnd, fetch: fetchFn, maxPages: 12 })); } catch (e) { latenessError = String(e && e.message || e); }
  return {
    version: 1, pulledAt: now.toISOString(), elapsedMs: Date.now() - t0, timing,
    actuals: { start: aStart, end: aEnd, rows: actuals.rows, csv: actuals.csv },
    users: { count: users.users.length, csv: users.csv },
    projects: { count: projects.rows.length, csv: projects.csv },
    lateness: lateness ? { start: lStart, end: lEnd, rows: lateness.rows, csv: lateness.csv } : { error: latenessError || 'skipped' },
  };
}
