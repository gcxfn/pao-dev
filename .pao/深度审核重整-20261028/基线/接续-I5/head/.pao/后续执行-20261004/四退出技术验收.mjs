// 用途：四退出Windows ConPTY技术验收；仅准备，主代理显式运行。无prompt、无模型请求、无假model。
// 输入：已构建正式CLI、node-pty、已有fd/rg；输出：独占新证据目录。只清理本轮PID。
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const pty=require('../../桌面端/node_modules/node-pty');
const base=dirname(fileURLToPath(import.meta.url));
const repo='D:/AI/workspace/pao-dev';
const kernel=join(repo,'PAO/packages/coding-agent');
const cli=join(kernel,'dist/bundle/cli.js');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const evidence=join(base,'四退出技术验收-'+stamp);mkdirSync(evidence,{recursive:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const wait=async(fn,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await delay(100);}throw new Error('超时:'+label);};
const kill=pid=>{if(pid&&alive(pid))spawnSync('taskkill',['/PID',String(pid),'/T','/F'],{stdio:'ignore'});};
const heartbeat=join(evidence,'heartbeat.cjs');
writeFileSync(heartbeat,`const fs=require('node:fs'); const file=process.argv[2]; let n=0; const tick=()=>fs.writeFileSync(file,JSON.stringify({pid:process.pid,n:++n,time:Date.now()}));tick();setInterval(tick,100);`);
const all=[];
for(const mode of ['quit','ctrl-c-double','kill-parent-only','close-conpty']){
 const dir=join(evidence,mode);mkdirSync(dir);const agent=join(dir,'agent');mkdirSync(join(agent,'extensions'),{recursive:true});mkdirSync(join(agent,'bin'),{recursive:true});
 for(const file of ['fd.exe','rg.exe'])copyFileSync(join('C:/Users/ASUS/.pi/agent/bin',file),join(agent,'bin',file));
 writeFileSync(join(agent,'settings.json'),JSON.stringify({retry:{enabled:false},quietStartup:false,packages:[],skills:[]}));
 const home=join(dir,'home');mkdirSync(join(home,'pao配置'),{recursive:true});
 copyFileSync('D:/AI/workspace/pao/pao配置/档位.json',join(home,'pao配置','档位.json'));
 const fixture=`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';import {join} from 'node:path';import {MinisterHost} from ${JSON.stringify(pathToFileURL(join(kernel,'dist/pao/host/host.js')).href)};
export default function(pi){let host;const root=process.env.PAO_EXIT_EVIDENCE;const role=process.env.PAO_ROLE;writeFileSync(join(root,'loaded-'+role+'.json'),JSON.stringify({pid:process.pid,role}));pi.on('session_start',async()=>{try{
 if(process.env.PAO_ROLE==='worker'){let n=0;const tick=()=>writeFileSync(join(root,'control-heartbeat.json'),JSON.stringify({pid:process.pid,n:++n}));tick();setInterval(tick,100);return;}
 if(process.env.PAO_ROLE==='部长'){const child=spawn(process.execPath,[${JSON.stringify(heartbeat)},join(root,'grandchild-heartbeat.json')],{stdio:'ignore',windowsHide:true});writeFileSync(join(root,'minister.json'),JSON.stringify({pid:process.pid,parent:process.ppid,grandchild:child.pid,connected:process.connected,managed:process.env.PAO_MANAGED_PARENT}));return;}
 host=new MinisterHost({paoHome:process.env.PAO_HOME});const result=await host.拉起({部门:'技术验收',项目根:root,参数:['--mode','rpc','--no-session','--no-tools','--no-skills']});if(!result.ok)throw new Error(result.原因);writeFileSync(join(root,'main.json'),JSON.stringify({pid:process.pid,minister:result.handle.pid,session:result.handle.会话标识}));
 }catch(error){writeFileSync(join(root,'startup-failed-'+role+'.json'),JSON.stringify({pid:process.pid,error:String(error)}));throw error;}});pi.on('session_shutdown',async()=>{await host?.stopAll('四退出技术验收正常shutdown');});}`;
 writeFileSync(join(agent,'extensions','exit-fixture.js'),fixture);
 const env={...process.env,PAO_HOME:home,PAO_CODING_AGENT_DIR:agent,PI_CODING_AGENT_DIR:agent,PAO_EXIT_EVIDENCE:dir,PAO_ROLE:'main',PAO_MANAGED_PARENT:'0',PAO_SESSION_BUDGET:'{"turns":0}',PAO_WORKER_BUDGET:'{"turns":0}',PAO_PRECOMPACTION:'0',PAO_RUNTIME_SURFACE:'terminal'};
 let control,terminal,exited,output='',controlErr='',identities,controlExit,controlError;
 const startupCheck=()=>{if(controlError)throw controlError;if(controlExit!==undefined)throw new Error('对照进程启动时退出:'+controlExit);if(exited)throw new Error('主进程启动时退出:'+JSON.stringify(exited));for(const role of ['main','worker','部长']){const path=join(dir,'startup-failed-'+role+'.json');if(existsSync(path))throw new Error('夹具启动失败:'+JSON.stringify(json(path)));}};
 const result={mode,started:new Date().toISOString(),status:'未完成',boundary:'Windows ConPTY技术关闭；不代表图形Windows Terminal窗口关闭体验',modelRequests:0};
 try{
  control=spawn(process.execPath,[cli,'--mode','rpc','--no-session','--no-tools','--no-skills'],{cwd:dir,env:{...env,PAO_ROLE:'worker'},stdio:['pipe','pipe','pipe'],windowsHide:true});control.stdout.on('data',()=>{});control.stderr.on('data',v=>controlErr+=v);
  control.on('error',error=>controlError=error);control.on('exit',(code,signal)=>controlExit={code,signal});
  await wait(()=>{startupCheck();return existsSync(join(dir,'loaded-worker.json'));},'自动扩展发现worker夹具',10000);
  await wait(()=>{startupCheck();return existsSync(join(dir,'control-heartbeat.json'));},'独立对照worker就绪');
  terminal=pty.spawn(process.execPath,[cli,'--no-session','--no-tools','--no-skills'],{cwd:dir,env,name:'xterm-256color',cols:110,rows:32,useConpty:true});terminal.onData(v=>output+=v);terminal.onExit(v=>exited=v);
  await wait(()=>{startupCheck();return existsSync(join(dir,'loaded-main.json'));},'自动扩展发现main夹具',10000);
  await wait(()=>{startupCheck();return existsSync(join(dir,'main.json'))&&existsSync(join(dir,'minister.json'))&&existsSync(join(dir,'grandchild-heartbeat.json'));},'正式宿主与孙进程就绪');
  const main=json(join(dir,'main.json')),minister=json(join(dir,'minister.json'));identities={parent:main.pid,minister:minister.pid,grandchild:minister.grandchild,control:control.pid};result.identities=identities;
  assert.equal(main.pid,terminal.pid);assert.equal(main.minister,minister.pid);assert.equal(minister.parent,main.pid);assert.equal(minister.connected,true);assert.equal(minister.managed,'1');
  await delay(1000);assert.ok(!exited,'操作前父进程已退出');for(const pid of Object.values(identities))assert.ok(alive(pid),'操作前PID不可见:'+pid);
  const beforeControl=json(join(dir,'control-heartbeat.json')).n;result.actionAt=new Date().toISOString();
  if(mode==='quit')terminal.write('/quit\r');
  else if(mode==='ctrl-c-double'){terminal.write('\x03');await delay(100);terminal.write('\x03');}
  else if(mode==='kill-parent-only'){const killed=spawnSync('taskkill',['/PID',String(main.pid),'/F'],{encoding:'utf8'});result.parentKill={args:['/PID',String(main.pid),'/F'],status:killed.status,stdout:killed.stdout,stderr:killed.stderr};assert.equal(killed.status,0);}
  else terminal.kill();
  await wait(()=>![main.pid,minister.pid,minister.grandchild].some(alive),'父/部长/孙进程全部停止');
  const stopped=readFileSync(join(dir,'grandchild-heartbeat.json'),'utf8');await delay(600);assert.equal(readFileSync(join(dir,'grandchild-heartbeat.json'),'utf8'),stopped);
  assert.ok(alive(control.pid),'独立对照worker被误杀');assert.ok(json(join(dir,'control-heartbeat.json')).n>beforeControl,'对照心跳未继续');
  result.status='通过';result.exit=exited;result.finalAlive=Object.fromEntries(Object.entries(identities).map(([name,pid])=>[name,alive(pid)]));
 }catch(error){result.status='失败';result.error=String(error);process.exitCode=1;}
 finally{
  result.checkedBeforeCleanup=true;
  writeFileSync(join(dir,'结果.json'),JSON.stringify(result,null,2),{flag:'wx'});writeFileSync(join(dir,'终端原始输出.txt'),output,{flag:'wx'});writeFileSync(join(dir,'对照stderr.txt'),controlErr,{flag:'wx'});
  // 结论已冻结后才清理；清理成功不改成验收通过。
  if(identities){kill(identities.parent);kill(identities.minister);kill(identities.grandchild);}else{if(terminal)kill(terminal.pid);if(existsSync(join(dir,'minister.json'))){const m=json(join(dir,'minister.json'));kill(m.pid);kill(m.grandchild);}}
  if(control)kill(control.pid);if(terminal&&!exited)terminal.kill();await delay(300);
  all.push(result);console.log(JSON.stringify({mode,status:result.status,error:result.error}));
 }
 if(result.status==='失败'&&!result.actionAt){all.push({status:'未运行',reason:'启动失败，停止其余case避免重复同因等待'});break;}
}
writeFileSync(join(evidence,'总结果.json'),JSON.stringify({results:all,graphicalWindowExperience:'用户真实体验授权跳过；本脚本未验收图形WindowsTerminal关窗'},null,2),{flag:'wx'});
console.log(evidence);
process.exit(process.exitCode??0);
