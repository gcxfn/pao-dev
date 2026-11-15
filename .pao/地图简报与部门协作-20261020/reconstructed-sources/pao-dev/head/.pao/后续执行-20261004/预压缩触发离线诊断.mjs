// 离线诊断：禁网络，只检查真实补验会话及同构SDK初始化，不发prompt。
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const base='file:///D:/AI/workspace/pao-dev/PAO/packages/coding-agent/dist/';
const load=p=>import(base+p);
globalThis.fetch=()=>{throw Error('离线诊断禁止HTTP')};
const {prepareCompaction,estimateTokens}=await load('core/compaction/index.js');
const {SessionManager,buildSessionProjection}=await load('core/session-manager.js');
const {SettingsManager}=await load('core/settings-manager.js');
const {ModelRuntime}=await load('core/model-runtime.js');
const {createAgentSessionServices}=await load('core/agent-session-runtime.js');
const {createAgentSession}=await load('core/sdk.js');
const {registerPrecompaction}=await load('pao/context/precompaction.js');
const dir='D:/AI/workspace/pao-dev/.pao/后续执行-20261004/S4-取消补验-b7f4dec1-19e2-4495-bc08-94e9c1b6e7cf';
const r=JSON.parse(readFileSync(dir+'/结果.json','utf8'));
const manager=SessionManager.open(r.cases[0].sessionFile);
const initialBranch=manager.getBranch().map(e=>({id:e.id,type:e.type,role:e.message?.role}));
const isolation=dir+'/离线空配置';mkdirSync(isolation,{recursive:true});
const modelRuntime=await ModelRuntime.create({authPath:isolation+'/auth.json',modelsPath:isolation+'/models.json',allowModelNetwork:false});
const model=modelRuntime.getPhysicalModel('zai-coding-cn','glm-5.3-flash');
const settingsManager=SettingsManager.inMemory({compaction:{enabled:true,reserveTokens:model.contextWindow-4477,keepRecentTokens:16}});
let registered=0;
const services=await createAgentSessionServices({cwd:manager.getCwd(),agentDir:isolation,modelRuntime,settingsManager,resourceLoaderOptions:{noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[pi=>{registered++;registerPrecompaction(pi)}]}});
const created=await createAgentSession({cwd:manager.getCwd(),agentDir:isolation,modelRuntime,settingsManager,resourceLoader:services.resourceLoader,model,thinkingLevel:'low',noTools:'all',sessionManager:manager,experimentalPrecompaction:true});
await created.session.bindExtensions({});
const settings=settingsManager.getCompactionSettings(model), prep=prepareCompaction(manager.getBranch(),settings);
const grid=[1,8,16,32,64,100,500].map(n=>({keep:n,prepared:!!prepareCompaction(manager.getBranch(),{...settings,keepRecentTokens:n})})); const projection=buildSessionProjection(manager.getBranch()).entries.map(e=>({id:e.sourceEntry.id,m:e.messages.map(m=>({role:m.role,tokens:estimateTokens(m)}))}));
const harness=readFileSync('D:/AI/workspace/pao-dev/.pao/后续执行-20261004/真实预压缩取消补验.mjs','utf8'); const triggerInput=harness.match(/const triggerInput='([^']+)'/)[1]; const firstBranch=manager.getBranch().slice(0,5); const pendingInput={role:'user',content:triggerInput,timestamp:Date.now()}; const correctedPrep=prepareCompaction([...firstBranch,{type:'message',id:'offline-trigger-check',parentId:firstBranch.at(-1).id,timestamp:new Date().toISOString(),message:pendingInput}],settings); const corrected={estimatedTokens:estimateTokens(pendingInput),prepared:!!correctedPrep,summarizeMessages:correctedPrep?.messagesToSummarize.length}; if(corrected.estimatedTokens<32||!corrected.prepared) throw Error('修正样本预检失败');
const output={corrected,grid,projection,initialBranch,finalBranch:manager.getBranch().map(e=>({id:e.id,type:e.type,role:e.message?.role})),registered,diagnostics:services.diagnostics,extensions:services.resourceLoader.getExtensions().extensions.map(e=>({path:e.path,events:[...e.handlers.keys()]})),hasTurnEnd:created.session.extensionRunner.hasHandlers('turn_end'),sameManager:created.session.extensionRunner.createContext().sessionManager===manager,model:{id:model.id,contextWindow:model.contextWindow},settings,preparation:prep?{messages:prep.messagesToSummarize.length,prefix:prep.turnPrefixMessages.length}:null};
created.session.dispose();writeFileSync(dir+'/离线触发诊断.json',JSON.stringify(output,null,2));console.log(JSON.stringify(output));



