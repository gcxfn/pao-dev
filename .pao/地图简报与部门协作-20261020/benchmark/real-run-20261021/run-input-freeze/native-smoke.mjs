// 用途：在安装成功的合成容器中核对 single/PAO 原生模型、工具和文件链；不代表正式题目质量。
import {mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const profile=process.argv[2];
if (!['single','post-pao'].includes(profile)) throw new Error('unknown profile');
const output=`/logs/agent/native-smoke-${profile}`;
if(existsSync(output)) throw new Error('refuse overwrite');
mkdirSync(output,{recursive:true});
const agentDir=`/tmp/native-${profile}-agent`, home=`/tmp/native-${profile}-home`;
mkdirSync(agentDir,{recursive:true}); mkdirSync(join(home,'pao配置'),{recursive:true});
const model={id:'group/deepseek',reasoning:true,contextWindow:1048576,maxTokens:384000,
 input:['text','image'],thinkingLevelMap:{high:'high'}};
writeFileSync(join(agentDir,'models.json'),JSON.stringify({providers:{'harbor-endpoint':{
 baseUrl:'http://host.docker.internal:3425/v1',apiKey:'$PAO_BENCH_API_KEY',api:'openai-completions',
 compat:{sendSessionAffinityHeaders:true},models:[model]}}}));
writeFileSync(join(agentDir,'settings.json'),JSON.stringify({defaultProvider:'harbor-endpoint',defaultModel:model.id,
 defaultThinkingLevel:'high',retry:{enabled:false,provider:{maxRetries:0}}}));
writeFileSync(join(home,'pao配置/档位.json'),JSON.stringify({provider:'pao',档位:['fast','primary'].map(名=>({
 名,provider:'harbor-endpoint',model:model.id,thinkingLevel:'high'}))}));
const sessionDir=join(output,'sessions'); mkdirSync(sessionDir);
const file=`/app/native-${profile}-ready.txt`;
if(existsSync(file)) throw new Error('old result present');
const prompt=`Create ${file} containing exactly BENCH_READY followed by a newline. Use write, then read to verify the file. This is only a local environment integration smoke task. Finish after verification.`;
const source='/tmp/harbor-pao-source';
const entry=profile==='single'?'/tmp/harbor-pao-single.mjs':join(source,'packages/coding-agent/dist/bundle/cli.js');
const args=[entry,'--print','--mode','json','--session-dir',sessionDir,'--provider','harbor-endpoint','--model',model.id,'--thinking','high'];
if(profile==='single') args.push('--tools','read,bash,edit,write');
args.push(prompt);
const child=spawnSync(process.execPath,args,{cwd:'/app',env:{...process.env,PAO_HOME:home,PI_CODING_AGENT_DIR:agentDir,
 PAO_CODING_AGENT_DIR:agentDir,PAO_BENCH_SOURCE:source,PI_SKIP_VERSION_CHECK:'1',
 PATH:join(process.env.HOME,'.local/pao-node/bin')+':'+process.env.PATH},encoding:'utf8',timeout:180000,maxBuffer:20*1024*1024});
writeFileSync(join(output,'stdout.jsonl'),child.stdout||''); writeFileSync(join(output,'stderr.log'),child.stderr||'');
const entries=readdirSync(sessionDir).filter(n=>n.endsWith('.jsonl')).flatMap(n=>readFileSync(join(sessionDir,n),'utf8').trim().split('\n').map(JSON.parse));
const messages=entries.filter(e=>e.type==='message').map(e=>e.message);
const assistant=messages.filter(m=>m.role==='assistant');
const toolCalls=assistant.flatMap(m=>m.content||[]).filter(c=>c.type==='toolCall').map(c=>c.name);
const errors=assistant.filter(m=>['error','aborted'].includes(m.stopReason)).map(m=>m.errorMessage);
const verified=existsSync(file)&&readFileSync(file,'utf8')==='BENCH_READY\n';
const result={profile,exitCode:child.status,error:child.error?.message,fileVerified:verified,toolCalls,errors,
 modelCalls:assistant.map(m=>({model:m.model,provider:m.provider,thinkingLevel:m.thinkingLevel,usage:m.usage,stopReason:m.stopReason})),
 tiers:JSON.parse(readFileSync(join(home,'pao配置/档位.json'),'utf8')),
 scope:'合成运行检查；不纳入九题质量样本',costKnown:false};
result.ok=child.status===0&&verified&&errors.length===0&&toolCalls.includes('write')&&toolCalls.includes('read')&&assistant.length>0&&
 assistant.every(m=>m.thinkingLevel==='high'&&m.model==='group/deepseek');
writeFileSync(join(output,'result.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
process.exitCode=result.ok?0:1;
