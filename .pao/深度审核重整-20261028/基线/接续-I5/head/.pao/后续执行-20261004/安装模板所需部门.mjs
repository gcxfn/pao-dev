// 用途：经正式建部实现安装三模板必需部门；输入：已授权PAO_HOME；输出：保留原内容的配置及安装证据。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDept } from '../../PAO/packages/coding-agent/dist/pao/dept/scaffold.js';
const home='D:\\AI\\workspace\\pao';
const evidence=dirname(fileURLToPath(import.meta.url));
const audit=[];
for(const [name,role,tags] of [
 ['开发','按任务书实施必要代码修改，保留用户已有修改；先读源码与规则，按验收条件运行定向检查；记录真实结果、失败与未完成事项，不替审查下结论。',['编码','修复','功能开发']],
 ['测试','根据原始需求与实际代码核验行为，运行项目支持的检查；仅为验收需要新增或修正测试，不擅自扩大产品修改；失败如实报告，不降低断言，不用模拟结果代替真实集成。',['验证','回归测试','边界检查']]
]) {
 const path=join(home,'部门',name,'配方.md');const existed=existsSync(path);
 const before=existed?readFileSync(path):null;
 const report=await createDept({paoHome:home,名字:name,标签:tags,默认档位:'主力'});
 if(!existed){
   const template=readFileSync(path,'utf8');
   const content=template.replace('- 人设:<待填:本部答什么问题、职责边界、口吻>',`- 人设:${role}`)
     .replace('- 工具:<待填:本部装载的工具与 skills>','- 工具:复用 PAO 当前角色工具许可；部长拆卡和判定，worker 按任务书读、查、改、执行定向测试；不递归派工、不联网找答案、不改共享记忆。');
   if(content===template) throw new Error(`建部模板字段未匹配：${name}`);
   writeFileSync(path,content);
 } else if(!before.equals(readFileSync(path))) throw new Error(`已有配方被意外修改：${name}`);
 audit.push({name,report,preservedExisting:existed,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});
}
writeFileSync(join(evidence,'S6-必要部门安装.json'),JSON.stringify({time:new Date().toISOString(),home,audit},null,2),{flag:'wx'});
console.log(JSON.stringify(audit,null,2));
