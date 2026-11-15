// 只读原始会话，提取工具顺序及执行证据；不改原结果/受测副本。
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const root='D:/AI/workspace/pao-dev/.pao/后续执行-20261004/真实对照';
const output=[];
for(const id of ['T3-A','T3-B','T1-O','T1-N','T2-N','T2-O','T3-O','T3-N']){
 const path=`${root}/${id}/结果.json`;if(!existsSync(path))continue;
 const r=JSON.parse(readFileSync(path,'utf8'));const roles=[];
 for(const role of r.roles){const entries=readFileSync(role.observed.sessionFile,'utf8').trim().split('\n').map(JSON.parse);const calls=[];const results=new Map(entries.filter(e=>e.message?.role==='toolResult').map(e=>[e.message.toolCallId,e.message]));
 for(const e of entries)for(const c of e.message?.role==='assistant'?e.message.content??[]:[]){if(c.type!=='toolCall')continue;const result=results.get(c.id);calls.push({entry:e.id,name:c.name,args:c.arguments,error:result?.isError,output:result?.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')});}
 roles.push({role:role.role,receipt:role.receipt.状态,summary:role.receipt.摘要,cost:role.receipt.用量?.cost,missing:role.receipt.缺用量轮次,observed:role.observed,calls});}
 output.push({id,wallMilliseconds:r.wallMilliseconds,roles});
}
writeFileSync(new URL('./冻结剩余独审工具证据.json',import.meta.url),JSON.stringify(output,null,2));
console.log(JSON.stringify(output.map(r=>({id:r.id,wall:r.wallMilliseconds,roles:r.roles.map(x=>({status:x.receipt,cost:x.cost,missing:x.missing,calls:x.calls.length,compactions:x.observed.compactions,aux:x.observed.auxiliaryUsage}))})),null,2));
