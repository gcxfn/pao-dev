// 用途：真实等长文件改写的缓存观察；仅虚构凭证，无端点调用。
import {mkdtempSync,writeFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AuthStorage} from '../../PAO/packages/coding-agent/src/core/auth-storage.ts';
const root=mkdtempSync(fileURLToPath(new URL('./S7-auth缓存-',import.meta.url)));
const revision=p=>{const s=statSync(p,{bigint:true});return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`};
let stale=0,collision=0; const examples=[];
for(let i=0;i<200;i++){
 const p=join(root,`auth-${i}.json`); const put=key=>writeFileSync(p,JSON.stringify({anthropic:{type:'api_key',key}}));
 put('old');const storage=AuthStorage.create(p);const before=revision(p);put('new');const after=revision(p);const result=await storage.read('anthropic');
 if(before===after)collision++; if(result.key!=='new'){stale++;if(examples.length<5)examples.push({i,before,after,result});}
}
console.log(JSON.stringify({iterations:200,collision,stale,examples,root},null,2));


