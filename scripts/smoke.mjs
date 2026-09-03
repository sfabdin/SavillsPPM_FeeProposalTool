/* ============================================================
   PAGE SMOKE — opens every page in Chromium against a local static
   server with Box stubbed out (no network) and an admin identity, and
   fails on any page error or console error. Catches the class of bug
   where a page loads its scripts in the wrong order, references a
   helper that moved, or renders NaN into an SVG.
     node scripts/smoke.mjs            # every page
     node scripts/smoke.mjs "Change Log.html"
   ============================================================ */
import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root=process.cwd();  // run from the repo root: node scripts/smoke.mjs [page.html …]
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.otf':'font/otf','.woff2':'font/woff2'};
const srv=http.createServer((q,r)=>{const u=decodeURIComponent(q.url.split('?')[0]);const f=path.join(root,u);
 if(!f.startsWith(root)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){r.writeHead(404);return r.end('nf');}
 r.writeHead(200,{'content-type':types[path.extname(f)]||'application/octet-stream'});r.end(fs.readFileSync(f));});
await new Promise(r=>srv.listen(0,r)); const port=srv.address().port;
const browser=await chromium.launch();
const pages=process.argv.slice(2).length?process.argv.slice(2):['Change Log.html','Staffing Matrix.html','Revenue Reconciliation.html','Projects Index.html','Universal Fee Calculator.html','Profitability.html','Executive Reporting.html','Bulk Editor.html','Revenue Projections.html','Data Repair.html','Fee Generator.html','Benchmarking Dashboard.html','Ingestion Studio.html','Proposal Analytics.html','Data Entry Status.html','Rate Grid Reconciliation.html','Import Small Works.html','Getting Started.html','Change Log.html'];
let bad=0;
for (const p of [...new Set(pages)]){const page=await browser.newPage();const errs=[];
 page.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));page.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE: '+m.text());});
 await page.route('**/box-adapter.js',r=>r.fulfill({contentType:'text/javascript',body:'window.UFC_Box={enabled:false,boot:async()=>({backend:"local"})};'}));
 await page.addInitScript(()=>{localStorage.setItem('ufc_real_identity_v1',JSON.stringify({username:'sabdin@savills.us',name:'Test Admin'}));});
 await page.goto(`http://127.0.0.1:${port}/${encodeURIComponent(p)}`);await page.waitForTimeout(1300);
 const real=errs.filter(e=>!/favicon|404|ERR_FILE/i.test(e));
 console.log((real.length?'✗':'✓')+' '+p+(real.length?'\n    '+real.slice(0,2).join('\n    '):''));if(real.length)bad++;
 await page.close();}
await browser.close();srv.close();process.exit(bad?1:0);
