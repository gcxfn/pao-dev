// 用途：隔离基准的 SDK 宿主；保留完整 PAO 和原生 print 模式，注入既有桌面工作树服务。
// 输入：冻结源码根、隔离配置及 Harbor 固定参数；输出：原生事件、会话及真实隔离工作目录。
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBenchmarkWorktreeHost } from './benchmark-worktree-host.mjs';

export async function createOrganized({source,cwd,agentDir,sessionDir,thinking,provider,modelId,probe=false,modelRuntime}) {
  const load = file => import(pathToFileURL(join(source,'packages/coding-agent/dist',file)));
  const {SettingsManager}=await load('core/settings-manager.js');
  const {SessionManager}=await load('core/session-manager.js');
  const {createAgentSessionServices,createAgentSessionFromServices,createAgentSessionRuntime}=await load('core/agent-session-runtime.js');
  const {builtInExtensions}=await load('extensions/index.js');
  const {default:paoExtension}=await load('pao/index.js');
  const locks=await load('pao/worker/lock.js');
  const host=createBenchmarkWorktreeHost(join(agentDir,'benchmark-worktrees'),locks);
  const extensionFactories=builtInExtensions.map(extension => extension.name==='pao'?{...extension,factory:pi=>paoExtension(pi,{worktreeHost:host})}:extension);
  const runtime=await createAgentSessionRuntime(async ({cwd,agentDir,sessionManager,sessionStartEvent})=>{
    const services=await createAgentSessionServices({cwd,agentDir,modelRuntime,settingsManager:SettingsManager.create(cwd,agentDir),resourceLoaderOptions:{extensionFactories}});
    const errors=services.diagnostics.filter(item=>item.type==='error');
    if(errors.length)throw Error(JSON.stringify(errors));
    const model=provider&&modelId?services.modelRuntime.getModel(provider,modelId):undefined;
    if(!probe&&!model)throw Error(`模型不存在：${provider}/${modelId}`);
    const result=await createAgentSessionFromServices({services,sessionManager,sessionStartEvent,model,thinkingLevel:thinking});
    return {...result,services,diagnostics:services.diagnostics};
  },{cwd,agentDir,sessionManager:probe?SessionManager.inMemory(cwd):SessionManager.create(cwd,sessionDir)});
  return {runtime,host,load};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {values,positionals}=parseArgs({allowPositionals:true,options:{print:{type:'boolean'},mode:{type:'string'},provider:{type:'string'},model:{type:'string'},thinking:{type:'string'},tools:{type:'string'},'session-dir':{type:'string'}}});
  if(!values.print||values.mode!=='json'||positionals.length!==1||values.tools!=='read,bash,edit,write')throw Error('只支持 Harbor 固定 print/json 参数与共同初始工具');
  const source=process.env.PAO_BENCH_SOURCE;
  const agentDir=process.env.PI_CODING_AGENT_DIR||process.env.PAO_CODING_AGENT_DIR;
  if(!source||!agentDir)throw Error('缺少隔离源码或配置目录');
  const {runtime,load}=await createOrganized({source,cwd:process.cwd(),agentDir,sessionDir:values['session-dir'],thinking:values.thinking,provider:values.provider,modelId:values.model});
  const {runPrintMode}=await load('modes/print-mode.js');
  process.exitCode=await runPrintMode(runtime,{mode:'json',initialMessage:positionals[0]});
}
