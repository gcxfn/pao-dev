const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const checks = path.resolve(__dirname, '../checks');
const task = process.argv[2];
const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'stage4-tasks.json'), 'utf8'))[task];
if (!spec) throw new Error(task);
const run = (command, cwd, name) => {
  const log=path.join(checks,name+'.log');
  const fd=fs.openSync(log,'w');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { cwd: path.join(root, cwd), encoding: 'utf8', env: { ...process.env, PAO_HOME: process.env.PAO_HOME }, stdio:['ignore',fd,fd] });
  fs.closeSync(fd);
  console.log(`${name}: exit ${r.status}`);
  return { status:r.status, text:fs.readFileSync(log,'utf8') };
};
const home = path.resolve(root, '../临时文件夹', `pao-stage4-${task.toLowerCase()}-${Date.now()}`);
fs.mkdirSync(home,{recursive:true}); process.env.PAO_HOME=home;
const phase = process.argv[3] ?? 'before';
if (phase==='before'||phase==='after') {
  run(spec.tests, spec.testCwd??'PAO/packages/coding-agent', `${task}-${phase}-tests`);
} else if(phase==='move') {
  const start=Number(process.argv[4]??0);
  for(let i=start;i<spec.groups.length;i++) {
    const [dest,names,back]=spec.groups[i];
    const m=spawnSync(process.execPath,[path.join(__dirname,'stage4-move.cjs'),'move',spec.file,dest,names,back??''],{encoding:'utf8'});
    fs.appendFileSync(path.join(checks,task+'-moves.log'),m.stdout+m.stderr);
    console.log(m.stdout+m.stderr);
    if(m.status!==0)process.exit(m.status);
    const repo=spec.file.startsWith('PAO/')?'PAO':'desktop';
    const typeCommand=repo==='PAO'?'npx tsc --noEmit':spec.file.includes('/pi-sdk-driver/')?'node --max-old-space-size=8192 node_modules/typescript/bin/tsc -p packages/pi-sdk-driver/tsconfig.json --noEmit':spec.file.includes('/electron/')?'node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p apps/desktop/tsconfig.electron.json --noEmit':'node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p apps/desktop/tsconfig.json --noEmit';
    const r=run(typeCommand,repo,`${task}-block${i+1}-typecheck`);
    const errors=r.text.split(/\r?\n/).filter(l=>/error TS\d+/.test(l));
    const unexpected=errors.filter(l=>!l.includes('memory-f14-review.test.ts(371,16)'));
    if(unexpected.length || (r.status!==0&&!errors.length)) { console.log(r.text.slice(-12000));process.exit(1); }
  }
}
