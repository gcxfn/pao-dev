// 用途：审查 fork 协作配额和桌面日志统计；输入为当前源码及隔离本地文件；输出为控制台证据和本目录样本。不接正式 PAO_HOME 或模型。
import {mkdirSync,writeFileSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=mkdtempSync(join(fileURLToPath(new URL('.',import.meta.url)),'core-data-'));
const source='file:///D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/';
const {createDept}=await import(source+'dept/scaffold.ts');
const {createCard,listCards}=await import(source+'cards/cardfile.ts');
const {registerCollab}=await import(source+'collab/index.ts');
const home=join(root,'home'),cardsDir=join(root,'project','.pao','卡');
mkdirSync(cardsDir,{recursive:true});
await createDept({paoHome:home,名字:'审查'});
const parent=await createCard(cardsDir,{目标:'父卡',部门:'审查',验收:'模拟',创建:'2026-10-14 20:00',预算:{collab_quota:1}});
let tool;
registerCollab({registerTool(value){tool=value;}},{resolveCardsDir:()=>cardsDir,resolveRegistryPath:()=>join(home,'部门','注册表.md'),resolvePaoHome:()=>home});
const params={goal:'同一协作任务',dept:'审查',acceptance:'模拟',parent:`卡${String(parent.card_no).padStart(4,'0')}`};
const results=await Promise.all([tool.execute('a',params),tool.execute('b',params)]);
const children=listCards(cardsDir).filter(c=>c.frontmatter.parent===params.parent);
assert.equal(children.length,2);
assert.deepEqual(results.map(r=>r.details.裁决),['放行','放行']);
console.log(JSON.stringify({case:'collab-concurrency',configuredQuota:1,children:children.map(c=>c.card_no),verdicts:results.map(r=>r.details.裁决)}));
let failTool;
const auditAsDirectory=join(root,'audit-directory');mkdirSync(auditAsDirectory);
registerCollab({registerTool(value){failTool=value;}},{resolveCardsDir:()=>cardsDir,resolveRegistryPath:()=>join(home,'部门','注册表.md'),resolveAuditPath:()=>auditAsDirectory});
const parent2=await createCard(cardsDir,{目标:'父卡2',部门:'审查',验收:'模拟',创建:'2026-10-14 20:00'});
let failure;
try{await failTool.execute('c',{...params,parent:`卡${String(parent2.card_no).padStart(4,'0')}`,goal:'审计写入失败的协作卡'});}catch(e){failure=e.message;}
assert.ok(failure);
assert.equal(listCards(cardsDir).filter(c=>c.frontmatter.parent===`卡${String(parent2.card_no).padStart(4,'0')}`).length,1);
console.log(JSON.stringify({case:'collab-audit-error',toolRejected:true,cardStillCreated:true,error:failure}));
const {readDesktopSessionIncrement}=await import(source+'desktop/read-model.ts');
const usage=n=>({input:n,output:0,cacheRead:0,cacheWrite:0,totalTokens:n,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}});
const records=[{id:'m1',type:'message',message:{role:'assistant',content:[],usage:usage(100)}},{id:'c1',type:'compaction',usage:usage(40)},{id:'b1',type:'branch_summary',usage:usage(30)}];
const log=join(root,'session.jsonl');writeFileSync(log,records.map(r=>JSON.stringify(r)).join('\n')+'\n');
const actual=readDesktopSessionIncrement(log).本段统计;
assert.equal(actual.token,100);assert.equal(actual.未知用量,0);
const {nativeUsageTotals}=await import(source+'worker/native-usage.ts');
const expected=nativeUsageTotals(records);
console.log(JSON.stringify({case:'desktop-usage-omission',actual,expectedTokens:expected.usage.input+expected.usage.output+expected.usage.cacheRead+expected.usage.cacheWrite,expectedUnknown:expected.unknown}));
const scalars=[];
for(const goal of ['123','true','null']){
 let error,actualType,actual;
 try{const card=await createCard(cardsDir,{目标:goal,部门:'审查',验收:'模拟',创建:'2026-10-14 20:00'});actualType=typeof card.frontmatter.goal;actual=card.frontmatter.goal;}catch(e){error=e.message;}
 scalars.push({goal,error,actualType,actual});assert.ok(error||actual!==goal);
}
const numericParent=await createCard(cardsDir,{目标:'数字父引用',部门:'审查',验收:'模拟',创建:'2026-10-14 20:00',parent:'1'});
assert.equal(typeof numericParent.frontmatter.parent,'number');
console.log(JSON.stringify({case:'card-scalar-roundtrip',scalars,parentType:typeof numericParent.frontmatter.parent,parentValue:numericParent.frontmatter.parent}));
console.log(JSON.stringify({fixture:root}));
