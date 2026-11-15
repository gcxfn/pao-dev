// 用途：打包基准宿主所需的既有桌面模块；输入当前桌面源码，输出本轮隔离验收文件，不修改产品。
import { build } from '../../desktop/node_modules/esbuild/lib/main.js';
import { fileURLToPath } from 'node:url';
await build({entryPoints:[fileURLToPath(new URL('benchmark-host-entry.ts',import.meta.url))],outfile:fileURLToPath(new URL('benchmark-worktree-host.mjs',import.meta.url)),bundle:true,platform:'node',target:'node22',format:'esm',metafile:true}).then(result=>console.log(JSON.stringify({inputs:Object.keys(result.metafile.inputs),outputs:result.metafile.outputs})));
