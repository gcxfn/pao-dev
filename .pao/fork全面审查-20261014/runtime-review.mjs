// 用途：只读复现档位编辑截断与部长忙碌插话丢失；输入：当前 fork 源码；输出：本地模拟结果 JSON。
// 不调用真实模型、不读取正式 PAO_HOME；本目录 review-fixture 为脚本专用隔离运行数据。
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { registerModelCommand } from '../../PAO/packages/coding-agent/src/pao/routing/model-command.ts';
import { listPaoSubcommands } from '../../PAO/packages/coding-agent/src/pao/command-router.ts';
import { MinisterHost } from '../../PAO/packages/coding-agent/src/pao/host/host.ts';
import { WorkerRunner } from '../../PAO/packages/coding-agent/src/pao/worker/runner.ts';
const base = join(dirname(fileURLToPath(import.meta.url)), 'review-fixture');
mkdirSync(base, { recursive: true });
const configPath = join(base, '档位.json');
writeFileSync(configPath, JSON.stringify({ provider: 'pao', 档位: [{ 名: 'primary', provider: 'openrouter', model: 'anthropic/claude-sonnet-4', thinkingLevel: 'high' }] }));
const pi = { registerVirtualModel() {} };
registerModelCommand(pi, { configPath, resolvePaoHome: () => base });
let selects = 0;
const notices = [];
const ctx = { model: { id: 'primary' }, modelRegistry: { getAll: () => [{ provider: 'openrouter', id: 'anthropic/claude-sonnet-4' }] }, ui: {
  select: async (_title, options) => { selects++; return selects === 1 ? '编辑档位…' : selects === 2 ? options[0] : selects === 3 ? options[0] : 'high ●'; },
  confirm: async () => true,
  notify: (value) => notices.push(value)
} };
await listPaoSubcommands(pi).find(s => s.name === 'model').run(pi, '', ctx);
console.log(JSON.stringify({ scenario: 'tier-selection', selected: 'openrouter/anthropic/claude-sonnet-4', saved: JSON.parse(readFileSync(configPath, 'utf8')).档位[0], notices }));

const fakePath = join(base, 'busy-rpc.cjs');
const dump = join(base, 'rpc-events.jsonl');
writeFileSync(dump, '');
writeFileSync(fakePath, `const fs=require('node:fs');const readline=require('node:readline');let busy=false;readline.createInterface({input:process.stdin}).on('line',line=>{const cmd=JSON.parse(line);const emit=x=>{fs.appendFileSync(process.argv[2],JSON.stringify(x)+'\\n');console.log(JSON.stringify(x));};if(cmd.type==='get_state')emit({type:'response',command:cmd.type,id:cmd.id,success:true,data:{sessionId:'review-session'}});if(cmd.type==='prompt'){if(busy&&!cmd.streamingBehavior)return emit({type:'response',command:cmd.type,id:cmd.id,success:false,error:'Agent is already processing. Specify streamingBehavior'});busy=true;emit({type:'agent_start'});}});`);
const host = new MinisterHost({ paoHome: join(base, 'home'), 树杀: async pid => { await new Promise((resolve,reject)=>{const p=spawn(process.env.SystemRoot+'\\System32\\taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true});p.once('error',reject);p.once('close',()=>resolve());});return 'isolated test taskkill'; } });
try {
  const started = await host.spawn({ 部门: '测试', 项目根: base, 命令: process.execPath, 参数: [fakePath, dump] });
  if (!started.ok) throw new Error(started.原因);
  const first = host.inject('测试', base, 'start');
  await new Promise(resolve => setTimeout(resolve, 150));
  const second = host.inject('测试', base, 'busy follow-up');
  await new Promise(resolve => setTimeout(resolve, 150));
  console.log(JSON.stringify({ scenario: 'busy-inject-protocol-simulation', first, second, actual: readFileSync(dump,'utf8').trim().split('\n').map(JSON.parse).at(-1) }));
} finally { await host.stopAll('review cleanup'); }

const runner = new WorkerRunner({ 证据目录: join(base, 'evidence') });
const childCode = "console.log(JSON.stringify({type:'turn_start'}));setTimeout(()=>{console.log(JSON.stringify({type:'turn_start'}));setTimeout(()=>{console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'reminder-final'}],stopReason:'stop',usage:{input:1,output:1,cost:{total:0}}}}));process.exit(0);},2000)},50);";
const receipt = await runner.run({ 卡号: 'review-budget', 命令: process.execPath, 参数: ['-e', childCode], 提示词: 'fixture', 预算: { turns: 1 }, 超时毫秒: 15000 });
console.log(JSON.stringify({ scenario: 'worker-reminder-protocol-simulation', status: receipt.status, stopReason: receipt.stopReason, summary: receipt.summary }));
