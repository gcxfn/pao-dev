// 用途：通过实际内核 SDK 捕获离线供应商收到的上下文组成；输入固定两轮问答，输出本轮验收目录，不调用网络或执行任务。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = new URL('../../', import.meta.url);
const coding = new URL('PAO/packages/coding-agent/', root);
const load = name => import(new URL(`dist/${name}.js`, coding));
const { fauxProvider, fauxAssistantMessage, InMemoryModelsStore } = await import(new URL('PAO/packages/ai/dist/index.js', root));
const { default: paoExtension } = await load('pao/index');
const { AuthStorage } = await load('core/auth-storage');
const { ModelRuntime } = await load('core/model-runtime');
const { SettingsManager } = await load('core/settings-manager');
const { SessionManager } = await load('core/session-manager');
const { createAgentSessionServices, createAgentSessionFromServices } = await load('core/agent-session-runtime');
const output = new URL(process.env.PAO_MEASUREMENT_BASELINE === '1' ? '请求组成测量-基线/' : '请求组成测量/', import.meta.url);
mkdirSync(output, {recursive:true});
const rows = [];
const length = value => value === undefined ? 0 : JSON.stringify(value).length;
for (const role of ['主控', '部长', 'worker']) {
  const cwd = fileURLToPath(new URL(`请求组成测量/${role}/project/`, import.meta.url));
  const home = join(cwd, 'isolated-home');
  mkdirSync(join(home, 'pao配置'), {recursive:true});
  writeFileSync(join(home, 'pao配置/档位.json'), JSON.stringify({档位:[{名:'primary',provider:'faux',model:'faux-1',thinkingLevel:'off'}]}));
  process.env.PAO_HOME = home;
  process.env.PAO_ROLE = role;
  process.env.PAO_DEPT = '';
  const runtime = await ModelRuntime.create({credentials:AuthStorage.inMemory(),modelsStore:new InMemoryModelsStore(),modelsPath:null,allowModelNetwork:false});
  const faux = fauxProvider({tokensPerSecond:1_000_000});
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({allowNetwork:false});
  let turn = 0;
  const response = ctx => {
    turn++;
    const systems = ctx.messages.filter(message => message.role === 'system');
    const history = ctx.messages.filter(message => message.role !== 'system');
    const row = {role,turn,systemMessageCharacters:length(systems),systemFields:systems.map(message => Object.fromEntries(Object.entries(message).map(([key,value]) => [key,{characters:length(value),...(Array.isArray(value)?{items:value.length}:{})}]))),historyCharacters:length(history),legacySystemPromptCharacters:length(ctx.systemPrompt),legacyToolsCharacters:length(ctx.tools),serializedContextCharacters:length(ctx)};
    rows.push(row);
    writeFileSync(new URL(`${role}-${turn}.json`, output), JSON.stringify(ctx,null,2)+'\n');
    return fauxAssistantMessage('离线固定回复；未执行任务。');
  };
  faux.setResponses([response,response]);
  const services = await createAgentSessionServices({cwd,agentDir:join(cwd,'agent'),modelRuntime:runtime,settingsManager:SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}}),resourceLoaderOptions:{extensionFactories:[pi => paoExtension(pi,{resolveProjectRoot:()=>cwd,resolvePaoHome:()=>home})],noSkills:true,noPromptTemplates:true,noThemes:true}});
  if (services.diagnostics.some(item => item.type === 'error')) throw Error(JSON.stringify(services.diagnostics));
  const {session} = await createAgentSessionFromServices({services,sessionManager:SessionManager.inMemory(cwd),model:faux.getModel()});
  try {
    await session.bindExtensions({});
    await session.prompt('仅测量上下文组成。请返回一句固定说明，不调用工具。');
    await session.prompt('第二轮仍只返回固定说明，不调用工具。');
  } finally { session.dispose(); }
  if (turn !== 2) throw Error(`${role} 实际请求数异常：${turn}`);
}
writeFileSync(new URL('汇总.json',output),JSON.stringify({at:new Date().toISOString(),scope:'最终构建经实际SDK到离线faux供应商的两轮上下文；隔离配置、固定输入，无实际任务或供应商网络。字符为JSON序列化UTF-16长度，包含JSON结构开销；不是HTTP请求字节、token、费用或前后质量比较。角色工具沿SDK实际默认装配；部长未绑定工作流节点。系统消息可能内含工具声明。',rows},null,2)+'\n');
console.log(JSON.stringify(rows));
