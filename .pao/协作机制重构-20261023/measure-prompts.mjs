// 用途：比较冻结基线与当前 worker 实际装配函数的固定输入输出；输出字符数，不冒充供应商 token。
import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const root = new URL('../../', import.meta.url);
function load(relative) {
  const text = readFileSync(new URL(relative, root), 'utf8');
  const start = text.indexOf('export function buildWorkerPrompt(');
  const end = text.indexOf('\n/**', start + 1);
  const source = text.slice(start, end).replace('export function', 'function');
  const js = stripTypeScriptTypes(source);
  return new Function('formatCardNumber', 'process', `${js}\nreturn buildWorkerPrompt;`)(n => `卡${String(n).padStart(4,'0')}`, process);
}
const before = load('.pao/协作机制重构-20261023/baseline/PAO/packages/coding-agent/src/pao/worker/dispatch-core.ts');
const after = load('PAO/packages/coding-agent/src/pao/worker/dispatch-core.ts');
const card = {card_no:1,path:'D:/offline/project/.pao/卡/卡0001.md',frontmatter:{inputs:[]},body:''};
const brief = {briefMarkdown:'# 执行简报\n目标：修复明确缺陷。\n范围：src/example.ts。\n验收：执行既有单元测试。',brief:{ref:'pao-brief://offline',digest:'fixture'},snapshotDigest:'fixture'};
const claim = {available:true,snapshotPath:'D:/offline/project/.pao/baseline.json',existingEntryCount:1};
const rows = [
  {name:'无简报旧调用',args:[card,1]},
  {name:'明确任务冻结简报与认领基线',args:[card,1,brief,claim]},
  {name:'侦察任务',args:[{...card,body:'<!-- pao-dispatch-result -->'},1,brief,claim]},
].map(({name,args}) => ({name,beforeCharacters:before(...args).length,afterCharacters:after(...args).length}));
writeFileSync(new URL('提示词字符比较.json',import.meta.url), JSON.stringify({at:new Date().toISOString(),unit:'JavaScript UTF-16 code units',scope:'worker 用户消息装配函数；固定离线任务输入。含冻结简报和协议，不含系统提示、工具 schema、历史会话或供应商 token；不能据此推算费用或实际模型质量。',rows},null,2)+'\n');
console.log(rows);
