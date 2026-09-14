/* Export tie-out check: builds a client workbook from a seeded project on the
   real calculator page (Box stubbed, rate lock + discount + a contracted role
   on) and inspects the .xlsx it downloads.

   Formulas are live, so no library here can evaluate them; what this proves
   is that the workbook is WIRED to tie out — the lock credit is one named
   figure referenced by every sheet rather than a number baked in at export,
   the per-month credit carries the discount the engine applies, contracted
   roles escalate from the project start, and the Setup inputs are the state.

   Run: node scripts/check-export.mjs   (exits 1 on any failure) */
import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { execFileSync } from 'node:child_process';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.otf': 'font/otf' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]); const f = path.join(root, u);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('nf'); }
  r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f)); });
await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const page = await browser.newPage(); const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.route('**/box-adapter.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.UFC_Box={enabled:false,boot:async()=>({backend:"local"})};' }));
await page.addInitScript(() => { localStorage.setItem('ufc_real_identity_v1', JSON.stringify({ username: 'sabdin@savills.us', name: 'Export Check' })); });
await page.goto(`http://127.0.0.1:${port}/Universal%20Fee%20Calculator.html`);
await page.waitForFunction(() => !!window.UFC_Store && !!window.__UFC__);
await page.evaluate(() => {
  const S = window.UFC_Store; S.setRealIdentity({ username: 'sabdin@savills.us', name: 'Export Check' });
  S.saveProject({ id: 'p_export', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    project: { name: 'Export Tie-Out', client: 'Acme', status: 'submitted', rating: 2 },
    timeline: { startMonth: 1, startYear: 2026, endMonth: 12, endYear: 2027 },
    phases: [{ id: 'p1', name: 'Design', length: 8 }, { id: 'p2', name: 'Build', length: 16 }],
    groups: [{ id: 'core', name: 'Core' }],
    roles: [
      { id: 'r1', titleId: 'pm', tierId: 'mid', rateSource: 'grid', groupId: 'core', fte: { p1: 100, p2: 50 }, fteMonthly: {} },
      { id: 'r2', titleId: 'pm', tierId: 'mid', rateSource: 'contracted', contractedRate: 200, groupId: 'core', fte: { p1: 50, p2: 50 }, fteMonthly: {} },
    ],
    assumptions: { hrsPerMo: 173.33, discount: 10, rateLock: true, escalation: 3, industryAdj: 0, catalogBaseYear: 2024, feeShare: { enabled: false, pct: 0, mode: 'offtop' }, feeBasis: 'fixed', nteCeiling: 0 } });
});
await page.goto(`http://127.0.0.1:${port}/Universal%20Fee%20Calculator.html?id=p_export`);
await page.waitForFunction(() => !!window.__UFC__ && window.__UFC__.getState().id === 'p_export');
await page.waitForTimeout(500);
const dl = page.waitForEvent('download', { timeout: 20000 });
await page.click('#xlsx-btn');
const file = await dl; const tmp = path.join(os.tmpdir(), 'ufc-export-check.xlsx'); await file.saveAs(tmp);

// The Revenue Projections export (shared writer with the Books tab): the
// seeded project is in the page's book, so the matrix has a row to write.
page.on('dialog', (d) => { errs.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
await page.goto(`http://127.0.0.1:${port}/Revenue%20Projections.html`);
await page.waitForSelector('#xlsx-export', { timeout: 20000 });
await page.waitForTimeout(800);
const dl2 = page.waitForEvent('download', { timeout: 30000 });
await page.click('#xlsx-export');
const tmp2 = path.join(os.tmpdir(), 'ufc-export-check-rp.xlsx'); await (await dl2).saveAs(tmp2);
await browser.close(); srv.close();

// unzip and read the XML — no evaluation, just wiring
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-xlsx-')); execFileSync('unzip', ['-q', '-o', tmp, '-d', dir]);
const wbXml = fs.readFileSync(path.join(dir, 'xl', 'workbook.xml'), 'utf8');
const sheets = fs.readdirSync(path.join(dir, 'xl', 'worksheets')).filter((f) => f.endsWith('.xml')).map((f) => fs.readFileSync(path.join(dir, 'xl', 'worksheets', f), 'utf8'));
const formulas = sheets.flatMap((x) => [...x.matchAll(/<f>([^<]*)<\/f>/g)].map((m) => m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')));
let checks = 0, fails = 0;
const ck = (name, ok, detail) => { checks++; if (!ok) { fails++; console.log('  FAIL ' + name + (detail ? '   [' + detail + ']' : '')); } else console.log('  ok   ' + name); };

ck('workbook built and downloaded', fs.statSync(tmp).size > 10000, fs.statSync(tmp).size + ' bytes');
ck('no page errors during export', errs.length === 0, errs.join(' | '));
ck('lock_credit is a defined name', /definedName name="lock_credit"/.test(wbXml));
ck('rate_lock, discount_pct, escalation_pct, project_start_year, hrs_per_mo are defined names',
  ['rate_lock', 'discount_pct', 'escalation_pct', 'project_start_year', 'hrs_per_mo'].every((n) => new RegExp('definedName name="' + n + '"').test(wbXml)));
const baked = formulas.filter((f) => /\d{3,}\.\d{2}\s*\*\s*rate_lock/.test(f));
ck('no lock formula carries a dollar constant baked in at export', baked.length === 0, baked.slice(0, 2).join(' | '));
ck('every sheet that shows the lock references lock_credit', formulas.filter((f) => /^-?lock_credit$/.test(f)).length >= 3, String(formulas.filter((f) => /lock_credit/.test(f)).length));
const perMonth = formulas.filter((f) => /POWER\(1\+escalation_pct\/100, project_start_year-\d{4}\)/.test(f));
ck('per-month lock credit exists', perMonth.length > 0);
ck('per-month lock credit carries (1-discount_pct/100), as the engine does', perMonth.length > 0 && perMonth.every((f) => f.includes('(1-discount_pct/100)')), perMonth[0]);
ck('contracted roles escalate from project_start_year (row 8 factors)', formulas.some((f) => /POWER\(1\+escalation_pct\/100, \d{4} - project_start_year\)/.test(f)));
ck('grid roles still escalate from catalog_base_year (row 7 factors)', formulas.some((f) => /POWER\(1\+escalation_pct\/100, \d{4} - catalog_base_year\)/.test(f)));
const shared = fs.existsSync(path.join(dir, 'xl', 'sharedStrings.xml')) ? fs.readFileSync(path.join(dir, 'xl', 'sharedStrings.xml'), 'utf8') : '';
ck('no cost floor or rack rate in the client workbook', !/Cost floor|Rack \$/.test(shared + sheets.join('')));

/* ---- Excel-strict checks on the raw XML, both workbooks ----
   ExcelJS reads back anything it writes and LibreOffice forgives element
   order, so neither would ever see what Excel rejects. Excel validates the
   worksheet part against the schema and "repairs" a failing sheet away —
   which is how the Revenue Projections matrix came up blank while the Data
   and Dashboard sheets survived (<outlinePr> written after <pageSetUpPr>). */
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-xlsx-')); execFileSync('unzip', ['-q', '-o', tmp2, '-d', dir2]);
const sheetsOf = (d) => fs.readdirSync(path.join(d, 'xl', 'worksheets')).filter((f) => f.endsWith('.xml')).map((f) => ({ name: f, xml: fs.readFileSync(path.join(d, 'xl', 'worksheets', f), 'utf8') }));
const strict = (label, list) => {
  const ORDER = ['tabColor', 'outlinePr', 'pageSetUpPr'];
  const badOrder = list.filter(({ xml }) => {
    const m = /<sheetPr>(.*?)<\/sheetPr>/.exec(xml); if (!m) return false;
    const kids = [...m[1].matchAll(/<(\w+)/g)].map((k) => k[1]).map((k) => ORDER.indexOf(k));
    return kids.some((k, i) => k < 0 || (i && k <= kids[i - 1]));
  }).map((x) => x.name);
  ck(label + ': sheet properties in schema order (tabColor, outlinePr, pageSetUpPr)', badOrder.length === 0, badOrder.join(','));
  const badVals = list.flatMap(({ name, xml }) => [...xml.matchAll(/<c r="([A-Z]+\d+)"([^>]*)>(?:<f>[^<]*<\/f>)?<v>([^<]*)<\/v>/g)]
    .filter((m) => !/t="(s|str|b|e|inlineStr)"/.test(m[2]) && !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(m[3])).map((m) => name + ' ' + m[1] + '=' + m[3]));
  ck(label + ': every numeric cell value is a number (no NaN, undefined, Infinity)', badVals.length === 0, badVals.slice(0, 3).join(' | '));
  const badOutline = list.filter(({ xml }) => {
    const lv = Math.max(0, ...[...xml.matchAll(/<col [^>]*outlineLevel="(\d+)"/g)].map((m) => +m[1]));
    const fp = /<sheetFormatPr[^>]*outlineLevelCol="(\d+)"/.exec(xml);
    return lv > 0 && (!fp || +fp[1] < lv);
  }).map((x) => x.name);
  ck(label + ': grouped columns declare outlineLevelCol on the sheet', badOutline.length === 0, badOutline.join(','));
};
ck('Revenue Projections workbook built and downloaded', fs.statSync(tmp2).size > 5000, fs.statSync(tmp2).size + ' bytes');
strict('Revenue Projections', sheetsOf(dir2));
strict('Calculator', sheetsOf(dir));
ck('no page errors or dialogs during either export', errs.length === 0, errs.join(' | '));
console.log('\n' + (checks - fails) + '/' + checks + ' export checks passed');
process.exit(fails ? 1 : 0);
