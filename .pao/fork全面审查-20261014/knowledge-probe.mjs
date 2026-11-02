// 用途：只读审查的隔离复现；输入为仓内当前源码与模拟供应商，输出为审查目录下的隔离样本和控制台证据。
// 不调用真实模型、端点或正式 PAO_HOME，不改源码。
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, 'knowledge-probe-data');
mkdirSync(root, { recursive: true });
const src = 'file:///D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/';
const { registerMemoryVendor, MemoryVendorManager } = await import(src + 'memory/memory-vendor.ts');
let starts = 0, closes = 0;
let releases = [];
registerMemoryVendor('audit-mock', () => ({ vendorName: 'audit-mock', capabilities: {}, start: () => { starts++; return new Promise(r => releases.push(r)); }, close: async () => { closes++; }, write: async () => {}, recall: async () => [] }));
const manager = new MemoryVendorManager({供应商:'audit-mock',参数:{}}, () => {});
const a = manager.acquire(), b = manager.acquire();
releases.splice(0).forEach(r => r());
const both = await Promise.all([a,b]);
await manager.close();
console.log(JSON.stringify({case:'parallel-acquire',starts,closes,same:both[0]===both[1],status:manager.status}));
const late = new MemoryVendorManager({供应商:'audit-mock',参数:{}}, () => {});
const pending = late.acquire();
await late.close();
releases.splice(0).forEach(r => r());
await pending;
console.log(JSON.stringify({case:'close-during-start',status:late.status,closes}));
await late.close();
const { searchLibrary } = await import(src + 'knowledge/search.ts');
const lib = join(root, 'library');
mkdirSync(join(lib,'做法'), {recursive:true});
writeFileSync(join(lib,'做法','未验证.md'), '未验证操作 2026-10-14\n适用范围: 测试项目\n状态: 正式\n正文：尚无真实验证出处。\n');
const results = await searchLibrary({libRoot:lib,query:'未验证操作',embed:null,now:new Date('2026-10-14T12:00:00+08:00')});
console.log(JSON.stringify({case:'unverified-formal',hits:results.hits.map(h=>({file:h.fileName,status:h.status})),riskHits:results.riskHits.length}));
const { ingestEntry } = await import(src + 'knowledge/ingest.ts');
mkdirSync(join(lib,'待验证'),{recursive:true});
const candidate = join(lib,'待验证','跨区.md');
writeFileSync(candidate,'跨区操作 2026-10-14\n适用范围: 测试项目\n状态: 待验证\n');
let failure;
try { await ingestEntry({libRoot:lib,candidatePath:candidate,type:'做法',newFileName:'../跨区.md'}); } catch(e) { failure=e.message; }
console.log(JSON.stringify({case:'ingest-path',failure,sourceExists:existsSync(candidate),movedToRoot:existsSync(join(lib,'跨区.md')),index:readFileSync(join(lib,'做法','子索引.md'),'utf8')}));
const { createDept } = await import(src + 'dept/scaffold.ts');
const { readRegistry } = await import(src + 'dept/registry.ts');
const home = join(root,'dept-home');
await createDept({paoHome:home,名字:'AuditDemo'});
await createDept({paoHome:home,名字:'auditdemo'});
console.log(JSON.stringify({case:'case-departments',registry:readRegistry(join(home,'部门','注册表.md')),folderContent:readFileSync(join(home,'部门','auditdemo','配方.md'),'utf8').split('\n')[0]}));
try {
 const { dropPatrolCard } = await import(src + 'patrol/drop.ts');
 const cardsDir = join(root,'project','.pao','卡'); mkdirSync(cardsDir,{recursive:true});
 const draft={目标:'巡库：模拟并发',部门:'审查',输入:[],约束:'只读',验收:'模拟',档位:'fast'};
 const drop=await Promise.all([dropPatrolCard(cardsDir,draft,'2026-10-14 12:00'),dropPatrolCard(cardsDir,draft,'2026-10-14 12:00')]);
 console.log(JSON.stringify({case:'parallel-patrol',cards:drop.map(x=>({number:x.card.card_no,exists:x.exists}))}));
} catch(e) { console.log(JSON.stringify({case:'parallel-patrol',error:e.message})); }
