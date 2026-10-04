// 用途：从正式SDK装载现场search-boost并执行免费Bing公开查询；不请求模型、不加载其他扩展、不修改搜索层配置。
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DefaultResourceLoader} from '../../PAO/packages/coding-agent/dist/core/resource-loader.js';
import {SettingsManager} from '../../PAO/packages/coding-agent/dist/core/settings-manager.js';
import {SessionManager} from '../../PAO/packages/coding-agent/dist/core/session-manager.js';
import {createAgentSession} from '../../PAO/packages/coding-agent/dist/core/sdk.js';
import {emitSessionShutdownEvent} from '../../PAO/packages/coding-agent/dist/core/extensions/runner.js';
const evidence=join(dirname(fileURLToPath(import.meta.url)),'S7-真实搜索-工具装载修正');
const agentDir='D:\\AI\\workspace\\临时文件夹\\PAO-搜索验收-20261004\\agent';
mkdirSync(agentDir,{recursive:true});mkdirSync(evidence,{recursive:true});
process.env.PI_CODING_AGENT_DIR=agentDir;
process.env.PAO_CODING_AGENT_DIR=agentDir;
const extension='C:\\Users\\ASUS\\.pi\\agent\\extensions\\search-boost.js';
const settingsManager=SettingsManager.inMemory({retry:{enabled:false}});
const loader=new DefaultResourceLoader({cwd:agentDir,agentDir,settingsManager,noExtensions:true,additionalExtensionPaths:[extension],noSkills:true,noPromptTemplates:true,noContextFiles:true});
await loader.reload();
const {session}=await createAgentSession({cwd:agentDir,agentDir,resourceLoader:loader,settingsManager,sessionManager:SessionManager.inMemory(agentDir),noTools:'builtin',tools:['fused_search']});
const result={time:new Date().toISOString(),extension,status:'未完成',query:{query:'TypeScript official documentation',engines:['bing'],engine_pool:'free',complexity:'simple',max_results:3},updates:[]};
try{
 await session.bindExtensions({});
 result.loaded=session.getAllTools().filter(tool=>tool.name==='fused_search').map(tool=>({name:tool.name,sourceInfo:tool.sourceInfo}));
 const tool=session.getToolDefinition('fused_search');assert.ok(tool,'现场扩展未装载');
 result.output=await tool.execute('真实搜索-20261004',result.query,AbortSignal.timeout(60000),update=>result.updates.push(update),session.extensionRunner.createContext());
 const text=result.output.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
 assert.match(text,/bing/);assert.match(text,/https?:\/\//);assert.ok(!/No results\./.test(text));
 assert.equal(session.messages.filter(m=>m.role==='assistant').length,0);
 result.status='正式SDK装载与真实Bing搜索通过，无模型请求';
}catch(error){result.status='失败或外部阻塞';result.error=String(error);process.exitCode=1;}
finally{
 await emitSessionShutdownEvent(session.extensionRunner,{type:'session_shutdown',reason:'quit'});session.dispose();
 writeFileSync(join(evidence,'结果.json'),JSON.stringify(result,null,2),{flag:'wx'});
 console.log(JSON.stringify({status:result.status,error:result.error}));
}
