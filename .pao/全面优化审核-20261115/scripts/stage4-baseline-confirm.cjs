const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const rel='PAO/packages/coding-agent/src/pao/cards/delivery.ts';
const file=path.join(root,rel);
const before=path.resolve(__dirname,'../checks/stage4/before',rel);
const final=fs.readFileSync(file,'utf8');
const saved=path.resolve(__dirname,'../checks/stage4/after',rel);
fs.mkdirSync(path.dirname(saved),{recursive:true});fs.writeFileSync(saved,final);
function run(phase){
 const home=path.resolve(root,'../临时文件夹',`pao-stage4-S10-confirm-${phase}-${Date.now()}`);fs.mkdirSync(home,{recursive:true});
 const log=path.resolve(__dirname,`../checks/S10-confirm-${phase}.log`),fd=fs.openSync(log,'w');
 const r=spawnSync(process.execPath,[path.join(root,'PAO/node_modules/vitest/vitest.mjs'),'--run','test/pao/workflow-auto-chain.test.ts','--maxWorkers=1','-t','命令面 confirm 与工具面同口径'],{cwd:path.join(root,'PAO/packages/coding-agent'),env:{...process.env,PAO_HOME:home},stdio:['ignore',fd,fd]});
 fs.closeSync(fd);console.log(`${phase}: ${r.status}`);
}
try{fs.copyFileSync(before,file);run('before');}finally{fs.writeFileSync(file,final);}
run('after');
