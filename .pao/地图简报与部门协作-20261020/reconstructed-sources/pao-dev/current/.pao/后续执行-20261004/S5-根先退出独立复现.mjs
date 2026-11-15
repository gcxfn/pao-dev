// 离线因果探针：实际Git bash→Node写文件；显式模拟根先退出，再调用旧树杀。不等于真实关窗时序已证明。
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const {killTree}=await import('file:///D:/AI/workspace/pao-dev/PAO/packages/coding-agent/dist/pao/worker/kill.js');
const root='D:/AI/workspace/临时文件夹/PAO-树杀因果-20261004';mkdirSync(root,{recursive:true});
const dir=join(root,randomUUID());mkdirSync(dir);
const script=join(dir,'实际工作.cjs'),progress=join(dir,'结果.txt');
writeFileSync(script,`const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(progress)},String(Date.now())+'\\n'),100)`);
const snap=()=>JSON.parse(execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-Command',"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name='Created';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},CommandLine | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true}));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const child=spawn('C:/Program Files/Git/bin/bash.exe',['-c',`node '${script.replaceAll('\\','/')}'`],{stdio:'ignore',windowsHide:true});
let identities=[];const result={dir,rootPid:child.pid};
try{
 for(let i=0;i<50&&!existsSync(progress);i++)await delay(100);
 if(!existsSync(progress))throw Error('未进入实际工作');
 const rows=snap(),ids=new Set([child.pid]);for(let n=-1;n!==ids.size;){n=ids.size;for(const r of rows)if(ids.has(r.ParentProcessId))ids.add(r.ProcessId);}
 identities=rows.filter(r=>ids.has(r.ProcessId));result.before=identities;
 child.kill();await new Promise(r=>child.once('exit',r));
 result.killResult=await killTree(child.pid);const before=readFileSync(progress,'utf8');await delay(500);
 result.continuedWriting=readFileSync(progress,'utf8').length>before.length;
 const remaining=snap();result.sameIdentitySurvivors=identities.filter(old=>remaining.some(now=>now.ProcessId===old.ProcessId&&now.Created===old.Created));
 result.boundary='显式根先退出重现；非真实关闭各taskkill时序记录';
}finally{
 const current=snap();for(const old of identities){if(current.some(now=>now.ProcessId===old.ProcessId&&now.Created===old.Created))try{execFileSync('C:/Windows/System32/taskkill.exe',['/PID',String(old.ProcessId),'/T','/F'],{stdio:'ignore',windowsHide:true})}catch{}}
 writeFileSync('D:/AI/workspace/pao-dev/.pao/后续执行-20261004/S5-根先退出独立复现.json',JSON.stringify(result,null,2));
}
console.log(JSON.stringify({continuedWriting:result.continuedWriting,survivors:result.sameIdentitySurvivors?.length,killResult:result.killResult}));
