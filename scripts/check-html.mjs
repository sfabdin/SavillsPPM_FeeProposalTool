/* ============================================================
   HTML HYGIENE — every page must parse to the same tree a browser
   would build from properly nested tags: no unclosed <div>/<section>/
   <table> etc., no stray closers, exactly one <html>/<head>/<body>,
   a charset and a viewport meta, a <title>, and no duplicate ids.
     node scripts/check-html.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const RAW = new Set(['script', 'style']);
let bad = 0;

function check(file) {
  const src = fs.readFileSync(file, 'utf8');
  const problems = [];
  const stack = [];
  const ids = new Map();
  const line = (i) => src.slice(0, i).split('\n').length;
  const re = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(src))) {
    const [whole, tag, attrs, selfClose] = m;
    if (!tag) continue;                                   // comment / doctype
    const name = tag.toLowerCase();
    if (whole.startsWith('</')) {
      const top = stack[stack.length - 1];
      if (!top) { problems.push(`line ${line(m.index)}: stray </${name}>`); continue; }
      if (top.name !== name) {
        const idx = stack.map(s => s.name).lastIndexOf(name);
        if (idx === -1) { problems.push(`line ${line(m.index)}: </${name}> closes nothing that is open`); continue; }
        stack.splice(idx).slice(1).forEach(s => problems.push(`line ${s.line}: <${s.name}> never closed (closed implicitly by </${name}> at line ${line(m.index)})`));
        continue;
      }
      stack.pop();
      continue;
    }
    const idm = /\sid\s*=\s*"([^"]*)"/.exec(attrs || '');
    if (idm) { if (ids.has(idm[1])) problems.push(`line ${line(m.index)}: duplicate id "${idm[1]}" (first at line ${ids.get(idm[1])})`); else ids.set(idm[1], line(m.index)); }
    if (VOID.has(name) || selfClose) continue;
    if (RAW.has(name)) {                                  // skip to the matching close, ignoring '<' inside code/CSS
      const end = src.indexOf('</' + name, re.lastIndex);
      if (end === -1) { problems.push(`line ${line(m.index)}: <${name}> never closed`); break; }
      re.lastIndex = src.indexOf('>', end) + 1;          // consume the closer too
      continue;
    }
    stack.push({ name, line: line(m.index) });
  }
  stack.forEach(s => problems.push(`line ${s.line}: <${s.name}> never closed`));
  for (const req of [['<html', 'html element'], ['<head', 'head'], ['<body', 'body'], ['<title', 'title'], ['charset=', 'charset meta']]) {
    if (!src.includes(req[0])) problems.push(`missing ${req[1]}`);
  }
  if (!/name="viewport"/.test(src)) problems.push('missing viewport meta');
  const count = (t) => (src.match(new RegExp('<' + t + '[\\s>]', 'g')) || []).length;
  ['html', 'head', 'body'].forEach(t => { if (count(t) !== 1) problems.push(`${count(t)} <${t}> elements`); });
  return problems;
}

const pages = fs.readdirSync(root).filter(f => f.endsWith('.html') && !f.startsWith('_')).sort();
for (const p of pages) {
  const problems = check(path.join(root, p));
  console.log((problems.length ? '✗ ' : '✓ ') + p);
  problems.forEach(x => console.log('    ' + x));
  if (problems.length) bad++;
}
console.log(`\n${pages.length - bad}/${pages.length} pages clean`);
process.exit(bad ? 1 : 0);
