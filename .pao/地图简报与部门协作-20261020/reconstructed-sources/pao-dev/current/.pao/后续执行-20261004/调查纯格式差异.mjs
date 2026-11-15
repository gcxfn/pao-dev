// 用途：只读列出词法token完全相同的格式候选；不还原。
import {transformSync} from 'file:///D:/AI/workspace/pao-dev/PAO/node_modules/esbuild/lib/main.js';import {execFileSync} from 'node:child_process';import {readFileSync,writeFileSync} from 'node:fs';
const root='D:/AI/workspace/pao-dev/PAO';const git=(...a)=>execFileSync('git',['-C',root,...a],{encoding:'utf8'});const tokens=s=>transformSync(s,{loader:'ts',minifyWhitespace:true,legalComments:'none'}).code;
const rows=[];for(const file of git('diff','--name-only').trim().split('\n').filter(x=>x.endsWith('.ts'))){const before=git('show','HEAD:'+file),after=readFileSync(root+'/'+file,'utf8');if(tokens(before)===tokens(after))rows.push({file,diff:git('diff','--',file)});}
writeFileSync('D:/AI/workspace/pao-dev/.pao/后续执行-20261004/纯格式候选.json',JSON.stringify(rows,null,2));console.log(rows.map(x=>x.file).join('\n'));console.log('count='+rows.length);
