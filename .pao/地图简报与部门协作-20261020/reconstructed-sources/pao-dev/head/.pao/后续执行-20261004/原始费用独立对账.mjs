// 用途：只读真实对照原始费用独立对账；每次输出新报告，不修改回执/结果，不调用模型。
// 用法：node 原始费用独立对账.mjs [--all15]；只处理结果.json已落盘的终态组。
import {readFileSync,readdirSync,existsSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
const base=dirname(fileURLToPath(import.meta.url)),root=join(base,'真实对照');
const out=join(base,'原始费用独立对账-'+new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(out);
const fields=['input','output','cacheRead','cacheWrite','cost'];
const zero=()=>Object.fromEntries(fields.map(k=>[k,0]));
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const parse=(path,strict=true)=>{if(!path||!existsSync(path))return {items:[],missing:true,malformed:0};let malformed=0;const items=[];for(const line of readFileSync(path,'utf8').split(/\r?\n/)){if(!line.trim())continue;try{items.push(JSON.parse(line));}catch{if(strict)malformed++;}}return {items,missing:false,malformed};};
const normalize=u=>{let unknown=!u;const values=zero();for(const key of fields){const value=key==='cost'?(typeof u?.cost==='number'?u.cost:u?.cost?.total):u?.[key];if(typeof value==='number'&&Number.isFinite(value)&&value>=0)values[key]=value;else unknown=true;}return {values,unknown};};
const add=(a,b)=>{for(const key of fields)a[key]+=b[key];};
const pre=m=>m?.stopReason==='aborted'&&m.errorMessage==='Operation aborted before provider request';
const fingerprint=m=>hash({role:m.role,id:m.id??null,timestamp:m.timestamp??null,provider:m.provider??null,model:m.model??null,stopReason:m.stopReason??null,content:m.content,usage:m.usage});
const multiset=items=>{const m=new Map;for(const item of items)m.set(item,(m.get(item)??0)+1);return [...m].sort(([a],[b])=>a.localeCompare(b));};
const roles=[],groups=[],pending=[];
for(const id of readdirSync(root).filter(n=>/^T[123]-[ABCON]$/.test(n)).sort()){
 const resultPath=join(root,id,'结果.json');if(!existsSync(resultPath)){pending.push(id);continue;}
 const result=JSON.parse(readFileSync(resultPath,'utf8'));const group={id,status:result.status,globalRequestWindow:result.budgetAfter&&result.budgetBefore?result.budgetAfter.used-result.budgetBefore.used:null,requestBoundary:'共享总账窗口增量，可能含同期其他任务；不可等同本角色HTTP次数',roles:[]};
 for(const role of result.roles??[]){const receipt=role.receipt;const session=parse(role.observed?.sessionFile);const stdout=parse(receipt.证据路径);const live=parse(receipt.live证据路径);const stderr=parse(receipt.liveStderr路径,false);const issues=[];const sessionHeader=session.items.find(e=>e.type==='session');const sessionId=role.sessionId;
 if(session.missing||stdout.missing||live.missing||stderr.missing)issues.push('至少一份原始来源缺失');if(sessionHeader?.id!==sessionId)issues.push('会话身份不匹配');
 for(const [name,data] of [['session',session],['stdout',stdout],['live',live]])if(data.malformed)issues.push(name+'含不可解析行:'+data.malformed);
 const totals=zero(),seen=new Map,usageEntries=[],messages=[],failures=[],unknown=[];let preAborted=0,duplicates=0;
 for(const entry of session.items){if(entry.type==='session')continue;if(!entry.id){issues.push('会话条目缺entryId');continue;}const digest=hash(entry);if(seen.has(entry.id)){duplicates++;if(seen.get(entry.id)!==digest)issues.push('同entryId内容冲突:'+entry.id);continue;}seen.set(entry.id,digest);
 let raw,kind=entry.type;const m=entry.message;if(entry.type==='message'&&m?.role==='assistant'){if(pre(m)){preAborted++;continue;}kind='assistant';raw=m.usage;messages.push(fingerprint(m));if(['error','aborted'].includes(m.stopReason))failures.push({entryId:entry.id,stopReason:m.stopReason,usageReturned:Boolean(raw),totalTokens:raw?.totalTokens??null});}
 else if(entry.type==='message'&&m?.role==='toolResult'&&m.usage){kind='toolResult';raw=m.usage;}
 else if(['usage','compaction','branch_summary'].includes(entry.type)&&entry.usage)raw=entry.usage;
 else if(entry.type==='custom'&&['pao-precompaction-usage-status','pao-native-usage-status'].includes(entry.customType)&&(entry.data?.usageReported===false||entry.data?.status==='请求未返回用量')){unknown.push({entryId:entry.id,reason:'原生未知费用标记'});continue;}
 else continue;
 const usage=normalize(raw);add(totals,usage.values);if(usage.unknown||(['error','aborted'].includes(m?.stopReason)&&!(raw?.totalTokens>0)))unknown.push({entryId:entry.id,reason:'用量缺项或错误/取消零用量'});usageEntries.push({entryId:entry.id,kind,usage:usage.values});
 }
 const expected=JSON.stringify(multiset(messages));const wireChecks=[];for(const [source,data] of [['stdout',stdout],['live',live]]){const headers=data.items.filter(e=>e.type==='session');if(headers.some(e=>e.id!==sessionId))issues.push(source+'包含其他会话头');const actual=data.items.filter(e=>e.type==='message_end'&&e.message?.role==='assistant'&&!pre(e.message)).map(e=>fingerprint(e.message));const same=JSON.stringify(multiset(actual))===expected;wireChecks.push({source,assistantEnds:actual.length,matchesSession:same});if(!same)issues.push(source+'最终assistant消息与会话不一致');}
 const markers=[];for(const [source,data] of [['stdout',stdout],['live',live],['stderr',stderr]])for(const e of data.items){if(e.type==='pao_usage_complete')markers.push({source,sessionId:e.sessionId,matches:e.sessionId===sessionId});if(e.type==='pao_usage_entry'){const native=usageEntries.find(n=>n.entryId===e.entryId);if(e.sessionId!==sessionId||!native||hash(native.usage)!==hash(normalize(e.usage).values))issues.push(source+'辅助usage无法按session+entry核对:'+e.entryId);}}
 const matching=markers.filter(m=>m.matches);if(!matching.length)issues.push('无匹配会话的费用发送完成标记');if(unknown.length)issues.push('原生账本仍有未知用量项:'+unknown.length);
 const delta=Object.fromEntries(fields.map(k=>[k,totals[k]-(receipt.用量?.[k]??0)]));const receiptMatches=fields.every(k=>Math.abs(delta[k])<1e-9);if(!receiptMatches)issues.push('会话原始usage与回执已知合计不同');
 const row={id,role:role.role,sessionId,originalReceiptStatus:receipt.状态,originalMissingUsage:receipt.缺用量轮次??0,processExitCode:receipt.exitCode,sessionUsage:totals,receiptUsage:receipt.用量,delta,receiptMatches,sessionEntriesDeduplicated:duplicates,assistantResponses:messages.length,preProviderAborted:preAborted,auxiliaryEntries:usageEntries.filter(e=>e.kind!=='assistant'),failures,unknown,wireChecks,completionMarkers:markers,requestCount:{actualHttpRequests:null,reason:'原会话/输出只有响应和预算标记，无逐角色HTTP请求流水；响应条数不能冒充请求次数'},assessment:issues.length?'原始证据仍有缺口':'事后原始usage与回执已知合计可对账；含发送完成来源，但不是供应商账单或未返回请求证明',issues,sourcePaths:{session:role.observed?.sessionFile,stdout:receipt.证据路径,live:receipt.live证据路径,stderr:receipt.liveStderr路径}};roles.push(row);group.roles.push({role:role.role,cost:totals.cost,originalMissing:row.originalMissingUsage,assessment:row.assessment});
 }groups.push(group);
}
const expectedIds=['T1-A','T1-B','T1-C','T2-A','T2-B','T2-C','T3-A','T3-B','T3-C','T1-O','T1-N','T2-O','T2-N','T3-O','T3-N'];
const absent=expectedIds.filter(id=>!groups.some(g=>g.id===id));const summary={generated:new Date().toISOString(),boundary:'只读事后证据对账；不修改原运行成功率/回执缺账，不将stderr完成标记当供应商结账；费用仍为目录估算',completedGroups:groups.length,absentOrRunning:absent,pending,all15Terminal:absent.length===0,groups,roles};
writeFileSync(join(out,'对账.json'),JSON.stringify(summary,null,2),{flag:'wx'});
const lines=['# 原始费用独立对账','',summary.boundary,'',`终态组 ${groups.length}/15；未终态或未开始：${absent.join('、')}`,'','|组/角色|原回执|原缺项|原生已知cost|事后核对|完成标记来源|','|---|---|---:|---:|---|---|',...roles.map(r=>`|${r.id}/${r.role}|${r.originalReceiptStatus}|${r.originalMissingUsage}|${r.sessionUsage.cost}|${r.issues.length?r.issues.join('；'):'已知usage一致'}|${[...new Set(r.completionMarkers.filter(m=>m.matches).map(m=>m.source))].join('、')}|`),'','逐角色真实HTTP请求数仍未知，组级共享账本窗口增量单列在JSON，不作角色请求数。所有source路径保留，绝不叠加stdout+session。'];writeFileSync(join(out,'报告.md'),lines.join('\n'),{flag:'wx'});console.log(JSON.stringify({out,completed:groups.length,roles:roles.length,issues:roles.filter(r=>r.issues.length).map(r=>({id:r.id,role:r.role,issues:r.issues})),all15Terminal:summary.all15Terminal}));if(process.argv.includes('--all15')&&!summary.all15Terminal)process.exitCode=2;
