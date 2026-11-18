const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const specs=JSON.parse(fs.readFileSync(path.join(__dirname,'stage4-tasks.json'),'utf8'));
const checks=path.resolve(__dirname,'../checks');
function node(script,args) {
 const r=spawnSync(process.execPath,[path.join(__dirname,script),...args],{cwd:root,stdio:'inherit'});
 if(r.status!==0)process.exit(r.status??1);
}
function shell(command,cwd,name) {
 const r=spawnSync('powershell.exe',['-NoProfile','-Command',command],{cwd:path.join(root,cwd),encoding:'utf8',maxBuffer:64*1024*1024});
 fs.writeFileSync(path.join(checks,name+'.log'),(r.stdout??'')+(r.stderr??'')); console.log(`${name}: exit ${r.status}`);
 return r;
}
for(const task of process.argv.slice(2)) {
 const spec=specs[task]; if(!spec)throw new Error(task);
 process.env.PAO_HOME=path.join(root,'../临时文件夹',`pao-stage4-${task}-gates-${Date.now()}`);
 fs.mkdirSync(process.env.PAO_HOME,{recursive:true});
 console.log(`Starting ${task}`);
 const movedNames=spec.groups.flatMap(g=>g[1].split(','));
 shell('rg -n --glob "*.ts" --glob "*.tsx" --glob "*.mts" '+JSON.stringify(movedNames.join('|'))+' PAO/packages/coding-agent desktop/apps desktop/packages','.',task+'-references');
 node('stage4-task.cjs',[task,'before']);
 node('stage4-task.cjs',[task,'move']);
 const files=[spec.file,...spec.groups.map(g=>path.posix.join(path.posix.dirname(spec.file),g[0]))].map(p=>p.slice(4));
 const formatted=shell('npx biome check --write --linter-enabled=false '+files.join(' '),'PAO',task+'-format');
 if(formatted.status!==0)process.exit(1);
 shell('npx biome lint --write --only=style/useImportType '+files.join(' '),'PAO',task+'-import-types');
 shell('npx biome check --error-on-warnings '+files.join(' '),'PAO',task+'-after-targeted-biome');
 shell('npx biome check --error-on-warnings packages/coding-agent/src/pao packages/coding-agent/test/pao','PAO',task+'-after-biome');
 shell('npm run check:pao:kernel','PAO',task+'-after-kernel');
 shell('npm run check:gates','PAO/packages/coding-agent',task+'-after-gates');
 node('stage4-task.cjs',[task,'after']);
 const read=p=>fs.readFileSync(path.join(checks,`${task}-${p}-tests.log`),'utf8');
 const failures=s=>s.split(/\r?\n/).filter(l=>/^\s*FAIL\s/.test(l)).map(l=>l.trim()).sort();
 const before=failures(read('before')), after=failures(read('after'));
 if(after.some(l=>!before.includes(l)))throw new Error(`${task}: new test failures: ${after.filter(l=>!before.includes(l)).join('; ')}`);
 node('stage4-report.cjs',[task]);
 console.log(`Completed ${task}`);
}
