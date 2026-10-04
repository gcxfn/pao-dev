// 用途：通过真实Windows ConPTY验证pao app --terminal及正常退出；不做Windows窗口UI自动化，不请求模型。
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {copyFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const pty=require('../../桌面端/node_modules/node-pty');
const base=dirname(fileURLToPath(import.meta.url));
const root='D:\\AI\\workspace\\临时文件夹\\PAO-终端验收-20261004';
const suffix=process.argv[2];if(suffix)assert.match(suffix,/^[a-zA-Z0-9-]+$/);
const agent=join(root,suffix?'agent-'+suffix:'agent-v3');const evidence=join(base,suffix?'S6-终端回退-'+suffix:'S6-终端回退-工具就绪');
mkdirSync(agent,{recursive:true});mkdirSync(evidence,{recursive:true});
mkdirSync(join(agent,'bin'),{recursive:true});
for(const name of ['fd.exe','rg.exe'])copyFileSync(join('C:\\Users\\ASUS\\.pi\\agent\\bin',name),join(agent,'bin',name));
const kernel='D:\\AI\\workspace\\pao-dev\\PAO\\packages\\coding-agent';
writeFileSync(join(agent,'settings.json'),JSON.stringify({retry:{enabled:false},quietStartup:false}));
const terminal=pty.spawn(process.execPath,[join(kernel,'dist/bundle/cli.js'),'app','--terminal'],{name:'xterm-256color',cols:110,rows:32,cwd:root,env:{...process.env,PAO_HOME:'D:\\AI\\workspace\\pao',PAO_CODING_AGENT_DIR:agent,PAO_SESSION_BUDGET:'{"turns":0}',PAO_RUNTIME_SURFACE:'terminal'},useConpty:true});
let output='';let exited;
terminal.onData(text=>{output+=text;});terminal.onExit(event=>{exited=event;});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const result={started:new Date().toISOString(),pid:terminal.pid,status:'未完成',boundary:'真实ConPTY输入/输出；不是Windows Terminal窗口观感验收'};
try{
 const deadline=Date.now()+20000;while(!output.includes('escape interrupt')&&!exited&&Date.now()<deadline)await delay(100);
 assert.ok(!exited,'终端在操作前退出');assert.match(output,/pao/);
 await delay(2000);
 terminal.write('/pao status\r');await delay(1500);
 result.statusText=output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').slice(-10000);
 assert.ok(!/Run pao update/.test(result.statusText),'fork不能提示上游自更新');
 if(result.statusText.includes('Update Available'))assert.match(result.statusText,/PAO 是 fork[\s\S]*勿运行 pao update/,'更新横幅须保留fork升级指引');
 terminal.write('/quit\r');
 const quitDeadline=Date.now()+10000;while(!exited&&Date.now()<quitDeadline)await delay(100);
 assert.ok(exited,'正常quit未完成');assert.equal(exited.exitCode,0);
 result.exit=exited;result.status='正式app入口终端回退和正常退出通过';
}catch(error){result.status='失败';result.error=String(error);process.exitCode=1;}
finally{
 if(!exited){terminal.kill();await delay(1000);}
 writeFileSync(join(evidence,'终端原始输出.txt'),output,{flag:'wx'});
 writeFileSync(join(evidence,'结果.json'),JSON.stringify(result,null,2),{flag:'wx'});
 console.log(JSON.stringify({status:result.status,error:result.error,pid:result.pid,exit:result.exit}));
 if(exited) process.exit(process.exitCode??0);
}
