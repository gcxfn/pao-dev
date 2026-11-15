// 用途：仅在离线请求测量进程中，将 PAO 业务导入重定向到开工快照；SDK及外部依赖保持当前构建。
// 不写源码、不替换现有 dist；缺失旧模块直接失败，禁止混入新业务模块冒充旧版。
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const before=new URL('baseline/PAO/packages/coding-agent/src/pao/',import.meta.url).href;
const after=new URL('../../PAO/packages/coding-agent/dist/pao/',import.meta.url).href;
process.env.PAO_MEASUREMENT_BASELINE='1';
registerHooks({resolve(specifier,context,nextResolve){
  let effective=context;
  if(context.parentURL?.startsWith(before)){
    const parentURL=context.parentURL.replace(before,after).replace(/\.ts$/,'.js');
    if(!specifier.startsWith('.')||!new URL(specifier,context.parentURL).href.startsWith(before)){
      effective={...context,parentURL};
      specifier=specifier.replace(/\.ts$/,'.js');
    }
  }
  const result=nextResolve(specifier,effective);
  if(result.url.startsWith(after)){
    const url=result.url.replace(after,before).replace(/\.js$/,'.ts');
    if(!existsSync(fileURLToPath(url)))throw Error(`开工快照缺少对应业务模块：${url}`);
    return nextResolve(url,context);
  }
  return result;
}});
