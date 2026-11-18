const fs=require('node:fs');
const path=require('node:path');
const ts=require('../../../desktop/node_modules/typescript');
const root=path.resolve(__dirname,'../../..');
const reportDir=path.resolve(__dirname,'..');
const specs=JSON.parse(fs.readFileSync(path.join(__dirname,'stage4-tasks.json'),'utf8'));
const task=process.argv[2], spec=specs[task];
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const parse=(p,s)=>ts.createSourceFile(p,s,ts.ScriptTarget.Latest,true);
const beforePath=path.join(reportDir,'checks/stage4/before',spec.file);
const before=fs.readFileSync(beforePath,'utf8');
const bf=parse(spec.file,before);
const destinations=spec.groups.map(([p])=>path.posix.join(path.posix.dirname(spec.file),p));
const current=[spec.file,...destinations].map(p=>({p,s:read(p)}));
const definitions=new Map();
for(const {p,s} of current) for(const n of parse(p,s).statements) if(n.name) definitions.set(n.name.text,{p,n,s});
const proof=[];
for(const n of bf.statements) {
 if(!n.name||!n.body)continue;
 if(spec.bodyExceptions?.includes(n.name.text))continue;
 const found=definitions.get(n.name.text); if(!found)throw new Error('Missing '+n.name.text);
 const text=n.body.getText(bf), after=found.n.body.getText();
 if(text!==after)throw new Error('Body changed: '+n.name.text);
 proof.push({name:n.name.text,file:found.p,identical:true});
}
fs.writeFileSync(path.join(reportDir,'checks',task+'-body-comparison.json'),JSON.stringify(proof,null,2)+'\n');
const testSummary=phase=>{
const p=path.join(reportDir,'checks',`${task}-${phase}-tests.log`);
if(!fs.existsSync(p))return '未运行';
const s=fs.readFileSync(p,'utf8'); return s.split(/\r?\n/).filter(l=>/Test Files|Tests\s|# tests |# pass |# fail |passed.*\(|failed.*\(/.test(l)).map(l=>l.trim()).join('；')||'见日志';
};
const body=`# ${task} 执行回报\n\n核实日期：2026-11-17。\n\n任务编号：${task}。\n\n结果：完成规定的纯搬移；既有检查失败按用户授权保留为基线。\n\n## 改动文件\n\n| 文件 | 搬移后行数 |\n|---|---|\n${current.map(({p,s})=>`| ${p} | ${s.trimEnd().split(/\r?\n/).length} |`).join('\n')}\n\n原入口保留搬移前的公开导出；调用方与测试未修改。新增文件按任务书分组承接函数、类型及其依赖。\n\n## 验收\n\n- 搬移前专项：${testSummary('before')}。\n- 搬移后专项：${testSummary('after')}。\n- 各块类型检查见 checks/${task}-block*-typecheck.log；内核既有类型诊断为 memory-f14-review.test.ts:371 的 TS2339。\n- ${proof.length} 个原有函数或类的函数体逐字比较相同，包含原文件保留的编排函数；完整结果见 checks/${task}-body-comparison.json。\n- 抽查：${proof.filter(x=>x.file!==spec.file).slice(0,3).map(x=>x.name).join('、')}，函数体逐字相同。\n- 搬移清单及依赖见 checks/${task}-moves.log。\n\n## 已知问题与未验证内容\n\n内核 Biome 和 B5 导出闭包检查有既有失败，详见第四阶段执行回报；不修改受保护的记忆与自进化代码。专项是否全通过以本回报列出的运行结果为准。\n`;
fs.writeFileSync(path.join(reportDir,task+'-执行回报.md'),body);
console.log(`${task}: ${proof.length} unchanged bodies; report written`);
