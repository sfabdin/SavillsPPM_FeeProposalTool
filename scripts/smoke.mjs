/* ============================================================
   PAGE SMOKE — opens every page in Chromium against a local static
   server with Box stubbed out (no network) and an admin identity, and
   fails on any page error or console error. Catches the class of bug
   where a page loads its scripts in the wrong order, references a
   helper that moved, or renders NaN into an SVG.
     node scripts/smoke.mjs            # every page, empty book
     SEED=1 node scripts/smoke.mjs     # every page with a seeded book, matrix and trail
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
 /* SEED=1 — a small realistic book, a staffing matrix and a week of trail, so
    pages are smoked with DATA on screen, not only their empty states. */
 if (process.env.SEED) await page.addInitScript(()=>{
   const rec=(id,name,status,rating,upd)=>({id,createdAt:'2026-01-05T00:00:00Z',updatedAt:upd,
     project:{name,client:'Acme Corp',status,rating,lead:'Andrew Peters',leadId:'acpeters',industry:'Financial Services',projectType:'Relocation',location:'New York'},
     timeline:{startMonth:1,startYear:2026,endMonth:12,endYear:2026},phases:[{id:'p1',name:'Delivery',length:12}],groups:[{id:'core',name:'Core'}],
     roles:[{id:'r1',titleId:'pm',tierId:'mid',rateSource:'grid',groupId:'core',fte:{p1:100},fteMonthly:{}}],
     assumptions:{hrsPerMo:173.33,escalation:3,industryAdj:20,discount:5,rateLock:false,feeBasis:'fixed',nteCeiling:0,billingMode:'phase',feeShare:{enabled:false,pct:10,mode:'offtop'},catalogBaseYear:2024},
     financials:{net:120000,gross:126000,byMonth:Array.from({length:12},(_,i)=>({year:2026,month:i+1,amount:10000,invoice:10000,net:10000})),stale:false,frozenAt:'2026-01-10T00:00:00Z'}});
   const db={schemaVersion:2,projects:{},activity:[]};
   [rec('sm_a','Alpha Tower Relocation','active',1,'2026-08-30T00:00:00Z'),rec('sm_b','Beta Campus Fit-out','won',2,'2026-08-31T00:00:00Z'),rec('sm_c','Gamma HQ Pursuit','submitted',4,'2026-09-01T00:00:00Z'),rec('sm_d','Delta Lab (lost)','lost',7,'2026-07-01T00:00:00Z')].forEach(r=>db.projects[r.id]=r);
   localStorage.setItem('savills-ppm-fee-db:v1',JSON.stringify(db));
   const now=new Date(); const ym=now.toISOString().slice(0,7);
   const mk=(id,ts,action,pid,meta)=>({id,ts,actor:'sabdin@savills.us',actorName:'Test Admin',action,projectId:pid,meta});
   const act={schemaVersion:1,shards:{[ym]:{month:ym,updatedAt:now.toISOString(),entries:{
     a1:mk('a1',new Date(now-86400000).toISOString(),'edit','sm_a',{name:'Alpha Tower Relocation',changes:[{field:'rating',from:2,to:1}]}),
     a2:mk('a2',new Date(now-2*86400000).toISOString(),'book','sm_b',{name:'Beta Campus Fit-out'}),
     a3:mk('a3',new Date(now-3*86400000).toISOString(),'status','sm_d',{name:'Delta Lab (lost)',from:'submitted',to:'lost'})}}},dirty:[]};
   localStorage.setItem('savills-ppm-activity-db:v1',JSON.stringify(act));
   const staff={schemaVersion:3,people:{stp_1:{id:'stp_1',name:'Jane Tester',title:'Senior PM',capacityPct:100,updatedAt:now.toISOString()}},
     allocations:[{id:'al_1',personId:'stp_1',personName:'Jane Tester',project:'Alpha Tower Relocation',client:'Acme Corp',start:'2026-01',end:'2026-12',pct:50,status:'Active'}],
     actuals:{},mappings:{users:{},projects:{}},deleted:{},meta:{monthHours:172}};
   localStorage.setItem('savills-ppm-staff-db:v1',JSON.stringify(staff));
 });
 await page.goto(`http://127.0.0.1:${port}/${encodeURIComponent(p)}`);await page.waitForTimeout(1300);
 const real=errs.filter(e=>!/favicon|404|ERR_FILE/i.test(e));
 console.log((real.length?'✗':'✓')+' '+p+(real.length?'\n    '+real.slice(0,2).join('\n    '):''));if(real.length)bad++;
 await page.close();}
await browser.close();srv.close();process.exit(bad?1:0);
