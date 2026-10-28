// The daily Clockify drop, against a fake Clockify: the shared builders in
// api/_clockify.js produce the CSVs the browser importer reads, and the
// scheduled handler refuses a call without the cron secret.
import { buildDrop, actualsCsv, latenessCsv, usersCsv, projectsCsv, normMonth } from '../api/_clockify.js';
import handler from '../api/clockify-daily.js';

let checks = 0, fails = 0;
const ck = (name, ok, detail) => { checks++; if (!ok) { fails++; console.log('  FAIL ' + name + (detail ? '   [' + detail + ']' : '')); } else console.log('  ok   ' + name); };
const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
const oid = (date) => Math.floor(date.getTime() / 1000).toString(16).padStart(8, '0') + '0000000000000000';
const fakeFetch = async (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : {};
  if (/\/users\?/.test(url)) return json([{ id: 'u1', name: 'Ada Lovelace', email: 'ada@savills.us', status: 'ACTIVE', customFields: [{ customFieldName: 'Title', value: 'Director' }] }]);
  if (/\/projects\?/.test(url)) return json([{ name: 'Acme — Lobby', clientName: 'Acme' }, { name: 'PPM', clientName: '' }]);
  if (/reports\/summary/.test(url) && body.summaryFilter.groups[1] === 'PROJECT') return json({ groupOne: [{ name: 'Ada Lovelace', children: [{ name: 'Acme — Lobby', clientName: 'Acme', children: [{ name: 'Sep 2026', duration: 36000 }, { name: '2026-10', duration: 7200 }] }] }] });
  if (/reports\/summary/.test(url)) return json({ groupOne: [{ name: 'Ada Lovelace', children: [{ name: '2026-10-07' }, { name: '2026-09-30' }] }] });
  if (/reports\/detailed/.test(url)) return json({ timeentries: [
    { _id: oid(new Date('2026-10-09T12:00:00Z')), userName: 'Ada Lovelace', timeInterval: { start: '2026-10-07T09:00:00Z', duration: 3600 } },     // 2 days late
    { _id: oid(new Date('2026-10-20T12:00:00Z')), userName: 'Ada Lovelace', timeInterval: { start: '2026-10-08T09:00:00Z', duration: 3600 } },     // 12 days late
  ] });
  return { ok: false, status: 404, text: async () => 'no route ' + url };
};

ck('normMonth reads every month label shape', normMonth('Sep 2026') === '2026-09' && normMonth('2026-10') === '2026-10' && normMonth('04/2026') === '2026-04');
const a = await actualsCsv({ key: 'k', ws: 'w', start: '2026-09-01', end: '2026-10-31', fetch: fakeFetch });
ck('actuals: one row per user × project × month with hours and the last worked day', a.rows === 2 && /Ada Lovelace,Acme — Lobby,Acme,10,2026-09-01,2026-10-07/.test(a.csv) && /,2,2026-10-01,2026-10-07/.test(a.csv), a.csv);
const l = await latenessCsv({ key: 'k', ws: 'w', start: '2026-10-01', end: '2026-10-31', fetch: fakeFetch });
ck('lateness: per person-month, average lag and the within-a-week share', /Ada Lovelace,2026-10,2,2,7.1,12,50,50,2026-10-08,2026-10-20/.test(l.csv), l.csv);
const u = await usersCsv({ key: 'k', ws: 'w', fetch: fakeFetch });
ck('users: the title custom field rides along', /Ada Lovelace,ada@savills.us,ACTIVE,Director/.test(u.csv), u.csv);
const p = await projectsCsv({ key: 'k', ws: 'w', fetch: fakeFetch });
ck('projects: name and client', /Acme — Lobby,Acme/.test(p.csv) && p.rows.length === 2);
const drop = await buildDrop({ key: 'k', ws: 'w', fetch: fakeFetch, now: new Date('2026-10-28T10:00:00Z') });
ck('drop: 13 months of actuals ending this month, 6 of lateness ending today', drop.actuals.start === '2025-10-01' && drop.actuals.end === '2026-10-31' && drop.lateness.start === '2026-05-01' && drop.lateness.end === '2026-10-28', JSON.stringify([drop.actuals, drop.lateness].map(x => [x.start, x.end])));
ck('drop: stamped, with every part and its timing', drop.pulledAt === '2026-10-28T10:00:00.000Z' && drop.users.count === 1 && drop.projects.count === 2 && ['actuals', 'users', 'projects', 'lateness'].every(k => k in drop.timing));
const lateFail = await buildDrop({ key: 'k', ws: 'w', now: new Date('2026-10-28T10:00:00Z'), fetch: async (url, o) => /detailed/.test(url) ? { ok: false, status: 500, text: async () => 'boom' } : fakeFetch(url, o) });
ck('a lateness failure does not sink the drop', lateFail.actuals.rows === 2 && /clockify 500/.test(lateFail.lateness.error || ''), JSON.stringify(lateFail.lateness));
// the handler's gate
const res = () => { const r = { code: 0, body: null, headers: {} }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.setHeader = () => {}; return r; };
process.env.CRON_SECRET = 's3cret';
let r1 = res(); await handler({ headers: {} }, r1); ck('no secret → 401', r1.code === 401);
let r2 = res(); await handler({ headers: { authorization: 'Bearer wrong' } }, r2); ck('wrong secret → 401', r2.code === 401);
delete process.env.CLOCKIFY_API_KEY; let r3 = res(); await handler({ headers: { authorization: 'Bearer s3cret' } }, r3); ck('right secret, Clockify not configured → 501 with the fix', r3.code === 501 && /CLOCKIFY_API_KEY/.test(r3.body.detail));
process.env.CLOCKIFY_API_KEY = 'k'; process.env.CLOCKIFY_WORKSPACE_ID = 'w'; delete process.env.BOX_CCG_CLIENT_ID;
let r4 = res(); await handler({ headers: { authorization: 'Bearer s3cret' } }, r4); ck('Box server auth not configured → 501 naming the three variables', r4.code === 501 && /BOX_CCG_CLIENT_ID/.test(r4.body.detail), JSON.stringify(r4.body));
console.log(`\n${checks - fails}/${checks} daily-pull checks passed`);
process.exit(fails ? 1 : 0);
