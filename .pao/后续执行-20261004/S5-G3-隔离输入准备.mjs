// 用途：仅准备两场真实退出验收的隔离输入；不启动模型、不安装配方。
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const root='D:/AI/workspace/临时文件夹/PAO-G3活任务-20261004';
const out='D:/AI/workspace/pao-dev/.pao/后续执行-20261004';
const {emitRecipeMarkdown}=await import('file:///D:/AI/workspace/pao-dev/PAO/packages/coding-agent/dist/pao/workflow/distill.js');
const {parseRecipe}=await import('file:///D:/AI/workspace/pao-dev/PAO/packages/coding-agent/dist/pao/workflow/recipe.js');
const auth=JSON.parse(readFileSync('C:/Users/ASUS/.pi/agent/auth.json','utf8'));
if(!auth['zai-coding-cn'])throw Error('已授权单provider不存在');
for(const mode of ['正常关窗','强杀main']){
 const dir=join(root,mode),project=join(dir,'项目'),agentDir=join(dir,'agent'),profile=join(dir,'profile');
 for(const path of [project,agentDir,profile])mkdirSync(path,{recursive:true});
 writeFileSync(join(agentDir,'auth.json'),JSON.stringify({'zai-coding-cn':auth['zai-coding-cn']}));
 writeFileSync(join(agentDir,'settings.json'),JSON.stringify({defaultProvider:'zai-coding-cn',defaultModel:'glm-5.3-flash',defaultThinkingLevel:'low',retry:{enabled:false,maxRetries:0},experimentalPrecompaction:false}));
 writeFileSync(join(project,'样本输入.txt'),'明确隔离生命周期样本，不是正式业务成果。\n需要读取本文件并执行本目录校验脚本。\n');
 writeFileSync(join(project,'校验.cjs'),`// 实际读取样本并反复校验内容；留档代表实际检查，不是空心跳。\nconst fs=require('node:fs'),crypto=require('node:crypto'); let n=0; const timer=setInterval(()=>{const b=fs.readFileSync(__dirname+'/样本输入.txt'); if(!b.includes(Buffer.from('明确隔离')))throw Error('输入错误');fs.appendFileSync(__dirname+'/校验结果.jsonl',JSON.stringify({n:++n,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')})+'\\n');if(n>=240)clearInterval(timer)},500);\n`);
 const name=`G3退出-${mode}-20261004`;
 const content=emitRecipeMarkdown({版本:2,名字:name,自动执行:true,参数:[],节点:[{名字:'实际校验',部门:'开发',目标:`必须交给1名worker：在 ${project} 读取样本输入.txt，然后用bash运行 node 校验.cjs，等待实际校验结束。不要自己替代worker。此为本地生命周期验收样本。`,验收:'校验结果.jsonl有240条真实内容校验记录；若被关闭中断，不得假报完成。',输入:[join(project,'样本输入.txt')],约束:`只许读取 ${project} 及执行该目录校验.cjs；只写本项目校验结果.jsonl和.pao卡。禁止修改其他目录。`,工人数量:1,预算:{turns:3,toolCalls:12},档位:'快',depends_on:[],人工确认:false}],说明:'隔离进程生命周期样本。真实模型只负责派发和执行实际校验；并不证明业务收益。'});
 parseRecipe(content,`${name}.md`);
 const config={project,profile,agentDir,home:'D:/AI/workspace/pao',evidence:join(out,`S5-G3活任务-${mode}`),command:{名字:name,卡目录:join(project,'.pao','工作流','卡')},mode,budgetPath:join(out,'真实请求额度.json'),baselineUsed:null,independentPid:null,independentProgressPath:join(root,'独立对照','实际结果.jsonl')};
 writeFileSync(join(dir,'运行输入.json'),JSON.stringify(config,null,2));
 writeFileSync(join(dir,'安装命令.txt'),`/pao flow save ${JSON.stringify({名字:name,内容:content})}`);
}
const control=join(root,'独立对照');mkdirSync(control,{recursive:true});
for(let i=0;i<600;i++)writeFileSync(join(control,`输入-${i}.txt`),`独立本地实际校验样本 ${i}\n`);
writeFileSync(join(control,'执行.cjs'),`const fs=require('node:fs'),crypto=require('node:crypto');let n=0;const t=setInterval(()=>{const file=__dirname+'/输入-'+n+'.txt';const b=fs.readFileSync(file);if(b.toString()!=='独立本地实际校验样本 '+n+'\\n')throw Error('内容不符');fs.appendFileSync(__dirname+'/实际结果.jsonl',JSON.stringify({file,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex'),n:n++,at:new Date().toISOString()})+'\\n');if(n>=600)clearInterval(t)},1000);`);
console.log(JSON.stringify({prepared:true,root,scenarios:2,providerNames:['zai-coding-cn'],modelsStarted:0,recipeInstalled:false}));
