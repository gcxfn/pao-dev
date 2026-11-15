// 用途：经正式 CLI 的 /pao flow save 安装两份隔离配方。turns=0，不发模型。
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const root='D:/AI/workspace/临时文件夹/PAO-G3活任务-20261004';
const cli='D:/AI/workspace/pao-dev/PAO/packages/coding-agent/dist/bundle/cli.js';
const results=[];
for(const mode of ['正常关窗','强杀main']){
 const dir=join(root,mode),config=JSON.parse(readFileSync(join(dir,'运行输入.json'),'utf8'));
 const env={...process.env,PAO_HOME:config.home,PAO_CODING_AGENT_DIR:config.agentDir,PAO_SESSION_BUDGET:'{"turns":0}',PAO_REQUEST_BUDGET:JSON.stringify({path:config.budgetPath,requests:600,concurrency:2})};
 for(const key of Object.keys(env))if(/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET/.test(key))delete env[key];
 const run=spawnSync(process.execPath,[cli,'--mode','json','-p','--no-session',readFileSync(join(dir,'安装命令.txt'),'utf8')],{env,cwd:config.project,encoding:'utf8',timeout:30000,windowsHide:true});
 writeFileSync(join(dir,'配方安装.log'),run.stdout+'\n'+run.stderr);
 const installed=existsSync(join(config.home,'工作流',config.command.名字+'.md'));
 results.push({mode,code:run.status,installed});
 if(run.status!==0||!installed)throw Error('正式安装失败；见隔离日志');
}
console.log(JSON.stringify(results));
