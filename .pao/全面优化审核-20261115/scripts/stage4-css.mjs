import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsers } from '../../../desktop/node_modules/prettier/plugins/postcss.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../../..');
const rel='desktop/apps/desktop/src/styles/main.css';
const file=path.join(root,rel), entry=path.join(root,'desktop/apps/desktop/src/styles.css');
const backup=path.join(here,'../checks/stage4/before',rel);
const mode=process.argv[2];
const order=['terminal','settings','tree-modals','menus','extension-surfaces','composer'];
const header='/* Extracted from main.css */';
if(mode==='move'){
 const source=fs.readFileSync(file,'utf8');
 const ast=parsers.css.parse(source);
 const modelTail=source.indexOf('/* ── Models and providers');
 const out=Object.fromEntries(['main',...order].map(n=>[n,[]]));
 const records=[];
 function group(n){
  if(modelTail>=0 && n.source.start.offset>=modelTail)return 'main';
  const text=source.slice(n.source.start.offset,n.source.end.offset);
  const selector=n.raws?.selector??text.slice(0,text.indexOf('{')).trim();
  if(n.type==='css-atrule'){
   if(/@media\s*\((max-width|prefers-reduced-motion)/.test(text))return 'composer';
   if(/@keyframes\s+extension-notice-enter/.test(text))return 'extension-surfaces';
   return 'main';
  }
  if(n.type!=='css-rule')return null;
  if(/^\.terminal-panel/.test(selector))return 'terminal';
  if(/^\.(settings-|appearance-|theme-(?:tile|mode))/.test(selector))return 'settings';
  if(/^\.(tree-modal|fork-modal)/.test(selector))return 'tree-modals';
  if(/^\.(slash-menu|mention-menu|enable-transparency)/.test(selector))return 'menus';
  if(/^\.(skills-|extensions-|resource-|extension-|pinned-cards|custom-endpoint)/.test(selector))return 'extension-surfaces';
  if(/^\.(composer|queued-composer-|image-attachment-thumb|image-viewer|startup-diagnostics|model-onboarding-notice|schema-skew-notice)/.test(selector))return 'composer';
  return 'main';
 }
 let cursor=0;
 for(let i=0;i<ast.nodes.length;i++){
  const n=ast.nodes[i];
  let g=group(n);
  if(g===null){ const next=ast.nodes.slice(i+1).find(x=>x.type!=='css-comment'); g=next?group(next):'main'; }
  const end=n.source.end.offset;
  out[g].push(source.slice(cursor,end));cursor=end;
  records.push({line:n.source.start.line,group:g,type:n.type});
 }
 out.main.push(source.slice(cursor));
 fs.mkdirSync(path.dirname(backup),{recursive:true});
 if(fs.existsSync(backup))throw new Error('CSS snapshot already exists');
 fs.copyFileSync(file,backup);
 const entryBackup=path.join(here,'../checks/stage4/before/desktop/apps/desktop/src/styles.css');
 fs.copyFileSync(entry,entryBackup);
 fs.writeFileSync(file,out.main.join(''));
 for(const g of order){ const p=path.join(path.dirname(file),g+'.css'); if(fs.existsSync(p))throw new Error(p);fs.writeFileSync(p,header+'\n'+out[g].join('')+'\n'); }
 const original=fs.readFileSync(entry,'utf8');
 fs.writeFileSync(entry,original.replace('@import "./styles/main.css";', '@import "./styles/main.css";\n'+order.map(g=>`@import "./styles/${g}.css";`).join('\n')));
 fs.writeFileSync(path.join(here,'../checks/S07-rule-locations.json'),JSON.stringify(records,null,2)+'\n');
 console.log(Object.fromEntries(Object.entries(out).map(([g,parts])=>[g,parts.join('').split(/\r?\n/).length])));
}else if(mode==='verify'){
 const normalize=s=>s.replaceAll(header,'').replaceAll('extension-surfaces.css 的 .extension-dialog-backdrop','.extension-dialog-backdrop').split(/\r?\n/).map(l=>l.trimEnd()).filter(l=>l.trim()).sort();
 const before=normalize(fs.readFileSync(backup,'utf8'));
 const current=[file,...order.map(g=>path.join(path.dirname(file),g+'.css'))].map(p=>fs.readFileSync(p,'utf8')).join('\n');
 const after=normalize(current);
 if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('CSS text multiset differs');
 const result={identical:true,nonEmptyLines:before.length,files:[file,...order.map(g=>path.join(path.dirname(file),g+'.css'))].map(p=>({path:path.relative(root,p).replaceAll('\\','/'),lines:fs.readFileSync(p,'utf8').trimEnd().split(/\r?\n/).length}))};
 fs.writeFileSync(path.join(here,'../checks/S07-css-comparison.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
}
