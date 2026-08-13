/* ============================================================
   HEADLESS TEST RUNNER — drives tests.html in Chromium and exits
   non-zero if any test fails. Used by CI (.github/workflows/tests.yml)
   and runnable locally:

     npx playwright install chromium   (first time only)
     node scripts/run-tests.mjs

   tests.html is fully self-contained (no CDN, in-memory localStorage
   shim), so this needs no server and no network once Chromium exists.
   ============================================================ */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testsPage = 'file://' + path.join(root, 'tests.html');

const launchOpts = {};
if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;

const browser = await chromium.launch(launchOpts);
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

await page.goto(testsPage);
await page.waitForFunction(() => window.__testResults, null, { timeout: 30000 });
const r = await page.evaluate(() => window.__testResults);

console.log(`\n${r.pass}/${r.total} passing, ${r.fail} failing\n`);
const groups = [...new Set(r.results.map(x => x.group))];
for (const g of groups) {
  const rows = r.results.filter(x => x.group === g);
  const bad = rows.filter(x => !x.ok);
  console.log(`  ${bad.length ? '✗' : '✓'} ${g.padEnd(36)} ${rows.length - bad.length}/${rows.length}`);
  bad.forEach(b => console.log(`      ✗ ${b.name} — ${b.detail}`));
}
if (errs.length) { console.log('\nPage errors:'); errs.slice(0, 12).forEach(e => console.log('  ' + e)); }

await browser.close();
process.exit(r.fail ? 1 : 0);
