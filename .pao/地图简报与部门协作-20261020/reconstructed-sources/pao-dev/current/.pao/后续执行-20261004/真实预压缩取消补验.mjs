// 用途：正式SDK+Runtime真实取消/换会话补验；需主代理新构建后显式授权执行。
// 最多6次fetch尝试，仍受唯一600/2共享门；不伪造事件或供应商回复，不证明远端停止计费。
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
const dist='D:/AI/workspace/pao-dev/PAO/packages/coding-agent/dist';
const {ModelRuntime}=await import(`file:///${dist}/core/model-runtime.js`);
const {SettingsManager}=await import(`file:///${dist}/core/settings-manager.js`);
const {SessionManager}=await import(`file:///${dist}/core/session-manager.js`);
const {createAgentSession}=await import(`file:///${dist}/core/sdk.js`);
const {createAgentSessionRuntime,createAgentSessionServices}=await import(`file:///${dist}/core/agent-session-runtime.js`);
const {prepareCompaction,estimateTokens}=await import(`file:///${dist}/core/compaction/index.js`);
const {registerPrecompaction}=await import(`file:///${dist}/pao/context/precompaction.js`);
assert.equal(process.argv[2],'--run-authorized','准备脚本：须新构建后由主代理显式执行 --run-authorized');
const root='D:/AI/workspace/临时文件夹/PAO-上下文验收-20261004';
const out=join('D:/AI/workspace/pao-dev/.pao/后续执行-20261004',`S4-取消补验-${randomUUID()}`);mkdirSync(out);
const privateDir=mkdtempSync(join(root,'取消私有-'));
const budgetPath='D:/AI/workspace/pao-dev/.pao/后续执行-20261004/真实请求额度.json';
const budget=()=>JSON.parse(readFileSync(budgetPath,'utf8'));
const result={started:new Date().toISOString(),scope:'取消和会话替换；不含修后真实兼容消费或配对收益',before:budget(),requests:[],cases:[]};
assert.ok(result.before.used<=594,'剩余额度不足6，不启动');
process.env.PAO_HOME='D:/AI/workspace/pao';
process.env.PAO_REQUEST_BUDGET=JSON.stringify({path:budgetPath,requests:600,concurrency:2});
const nativeFetch=globalThis.fetch;let activeCase,host,approvedBase;
globalThis.fetch=async(...args)=>{
 const url=new URL(typeof args[0]==='string'?args[0]:args[0] instanceof URL?args[0].href:args[0].url);
 const method=String(args[1]?.method??args[0]?.method??'GET').toUpperCase();
 assert.ok(approvedBase&&url.origin===approvedBase.origin&&url.pathname.startsWith(approvedBase.pathname.replace(/\/$/,'')+'/'),'拒绝未授权供应商地址');
 assert.equal(method,'POST','拒绝元数据或其他非POST请求');
 if(result.requests.length>=6)throw new Error('本补验6次HTTP尝试硬上限');
 const signal=args[1]?.signal??args[0]?.signal;
 const entry={number:result.requests.length+1,case:activeCase,url:url.origin+url.pathname,method,started:new Date().toISOString(),signalPresent:Boolean(signal)};result.requests.push(entry);
 signal?.addEventListener('abort',()=>{entry.abortObserved=new Date().toISOString();},{once:true});
 try{const response=await nativeFetch(...args);entry.headersReceived=new Date().toISOString();entry.status=response.status;return response;}
 catch(error){entry.fetchRejected=error?.name??'Error';throw error;}
};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label){const end=Date.now()+45000;while(!fn()){if(Date.now()>end)throw new Error('等待超时:'+label);await delay(25);}}
try{
 const auth=JSON.parse(readFileSync('C:/Users/ASUS/.pi/agent/auth.json','utf8'));assert.ok(auth['zai-coding-cn']);
 writeFileSync(join(privateDir,'auth.json'),JSON.stringify({'zai-coding-cn':auth['zai-coding-cn']}),{flag:'wx'});
 result.buildFiles=Object.fromEntries(['core/sdk.js','core/agent-session-runtime.js','pao/context/precompaction.js'].map(p=>[p,createHash('sha256').update(readFileSync(join(dist,p))).digest('hex')]));
 const modelRuntime=await ModelRuntime.create({authPath:join(privateDir,'auth.json'),modelsPath:join(privateDir,'models.json'),allowModelNetwork:false});
 const model=modelRuntime.getPhysicalModel('zai-coding-cn','glm-5.3-flash');assert.ok(model);
 approvedBase=new URL(model.baseUrl);
 for(const mode of ['abort','new-session']){
  activeCase=mode;const startRequests=result.requests.length;
  const settingsManager=SettingsManager.inMemory({compaction:{enabled:true,reserveTokens:16384,keepRecentTokens:16},retry:{enabled:false,maxRetries:0}});
  const factory=async options=>{const services=await createAgentSessionServices({cwd:root,agentDir:privateDir,modelRuntime,settingsManager,resourceLoaderOptions:{noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[pi=>registerPrecompaction(pi)]}});const created=await createAgentSession({cwd:root,agentDir:privateDir,modelRuntime,settingsManager,resourceLoader:services.resourceLoader,model,thinkingLevel:'low',noTools:'all',sessionManager:options.sessionManager,sessionStartEvent:options.sessionStartEvent,experimentalPrecompaction:true});return {...created,services,diagnostics:services.diagnostics};};
  const manager=SessionManager.create(root,join(out,mode));
  host=await createAgentSessionRuntime(factory,{cwd:root,agentDir:privateDir,sessionManager:manager});
  host.setRebindSession(s=>s.bindExtensions({}));await host.session.bindExtensions({});
  const c={mode,sessionId:manager.getSessionId(),sessionFile:manager.getSessionFile(),status:'未完成'};result.cases.push(c);
  assert.ok(manager.isPersisted()&&c.sessionFile,'需要持久会话以归属迟到费用');
  const input='隔离取消测试，不用工具。约束：只可改乙目录，甲已撤销。错误E_SAMPLE未解决，待核验收文件。'+ '样本背景，只用来触发摘要。'.repeat(450)+'仅回复已记录。';
  writeFileSync(join(out,mode+'-输入.txt'),input,{flag:'wx'});
  await host.session.prompt(input);
  const persistedHeader=JSON.parse(readFileSync(c.sessionFile,'utf8').split('\n')[0]);assert.equal(persistedHeader.id,c.sessionId,'持久会话身份不匹配');
  const last=host.session.messages.filter(x=>x.role==='assistant').at(-1);assert.equal(last.stopReason,'stop');
  const threshold=last.usage.totalTokens+400;c.threshold=threshold;
  settingsManager.applyOverrides({compaction:{enabled:true,reserveTokens:model.contextWindow-threshold,keepRecentTokens:16}});
  const triggerInput='最新纠正：只允许修改乙目录，甲目录的旧授权已经撤销。E_SAMPLE测试错误仍未解决，验收文件仍待核对。必须保留这些约束、错误和待办，不能把失败或未核验的内容写成已完成。当前只是隔离样本的摘要取消验收，不执行工具，不修改任何项目文件，不添加新任务。仅回复已记录。';
  const pendingInput={role:'user',content:triggerInput,timestamp:Date.now()};
  assert.ok(estimateTokens(pendingInput)>=32,'触发样本过短');
  const branch=structuredClone(manager.getBranch());
  const prepared=prepareCompaction([...branch,{type:'message',id:'offline-trigger-check',parentId:branch.at(-1)?.id??null,timestamp:new Date().toISOString(),message:pendingInput}],settingsManager.getCompactionSettings(model));
  assert.ok(prepared,'正式第二请求前须有可摘要前缀');
  c.offlinePreflight={inputEstimatedTokens:estimateTokens(pendingInput),summarizeMessages:prepared.messagesToSummarize.length,prefixMessages:prepared.turnPrefixMessages.length};
  writeFileSync(join(out,mode+'-触发输入.txt'),triggerInput,{flag:'wx'});
  const prompt=host.session.prompt(triggerInput).catch(error=>{c.promptError=error?.name??'Error';});
  // 同案第3次fetch应为真实后台摘要；真实usage kind稍后再验证，不凭计数单独断言。
  await wait(()=>result.requests.length>=startRequests+3,'后台摘要HTTP实际进入');
  const req=result.requests[startRequests+2];
  assert.equal(manager.getEntries().some(e=>e.type==='custom'&&e.customType==='pao-precompaction-status'&&e.data?.status==='就绪'),false,'摘要已完成，不能冒充在途取消');
  c.cancelStarted=new Date().toISOString();
  if(mode==='abort')await host.session.abort();else {const replaced=await host.newSession();assert.equal(replaced.cancelled,false);}
  await prompt.catch(error=>{c.promptError=error?.name??'Error';});
  await wait(()=>manager.getEntries().some(e=>(e.type==='usage'&&e.kind==='precompaction')||(e.type==='custom'&&e.customType==='pao-precompaction-usage-status')),'原会话摘要用量或未知结算');
  c.localSettled=new Date().toISOString();c.abortObserved=req.abortObserved;
  assert.ok(req.abortObserved,'未观察到真实fetch信号取消，不能判停止');
  await wait(()=>!budget().active.some(slot=>slot.pid===process.pid),'本进程共享账本活槽释放');
  c.budgetAfterSettlement=budget();const settledRequests=result.requests.length;
  await delay(1000);assert.equal(result.requests.length,settledRequests,'取消结算后仍产生新请求');c.stableObservationMs=1000;
  c.oldEntries=SessionManager.open(c.sessionFile,undefined,root).getEntries();
  assert.equal(c.oldEntries.some(e=>e.type==='custom'&&e.customType==='pao-precompaction-status'&&['就绪','已应用'].includes(e.data?.status)),false,'取消摘要仍被发布');
  if(mode==='new-session'){c.newSessionId=host.session.sessionManager.getSessionId();c.newEntries=host.session.sessionManager.getEntries();assert.notEqual(c.newSessionId,c.sessionId);assert.equal(c.newEntries.some(e=>e.type==='usage'||e.customType?.startsWith('pao-precompaction')),false,'旧费用或状态进入新会话');}
  c.status='本地取消信号、摘要结算/丢弃核实；远端费用未知仍按账本';
  await host.dispose();host=undefined;
 }
 result.status='两案完成；不等于远端停止计费证明';
}catch(error){result.status='失败或部分覆盖';result.error=String(error);process.exitCode=1;}
finally{try{if(host){await host.session.abort();await host.dispose();}}catch(error){result.cleanupError=String(error);}try{unlinkSync(join(privateDir,'auth.json'));}catch(error){result.cleanupCredentialError=String(error);}result.after=budget();result.finished=new Date().toISOString();writeFileSync(join(out,'结果.json'),JSON.stringify(result,null,2),{flag:'wx'});globalThis.fetch=nativeFetch;console.log(JSON.stringify({out,status:result.status,requests:result.requests.length,error:result.error}));}


