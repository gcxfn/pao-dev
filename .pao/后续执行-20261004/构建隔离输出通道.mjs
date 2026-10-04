// 用途：隔离构建当前输出通道补丁；输入正式dist+单个源码补丁；不覆盖正式dist。
import {cpSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {transform} from 'file:///D:/AI/workspace/pao-dev/PAO/node_modules/esbuild/lib/main.js';
const root='D:/AI/workspace/pao-dev/PAO';
const pkg=join(root,'packages/coding-agent');
const isolated=join(pkg,'.channel-check');
mkdirSync(isolated,{recursive:true});
cpSync(join(pkg,'dist'),join(isolated,'dist'),{recursive:true});
const guard=await transform(readFileSync(join(pkg,'src/core/output-guard.ts'),'utf8'),{loader:'ts',format:'esm',target:'node22'});
writeFileSync(join(isolated,'dist/core/output-guard.js'),guard.code);
let build=readFileSync(join(root,'scripts/build-coding-agent-bundle.mjs'),'utf8');
build=build.replace('const repoRoot = resolve(scriptDir, "..");',`const repoRoot = ${JSON.stringify(root)};`).replace('const codingAgentDistDir = join(codingAgentDir, "dist");','const codingAgentDistDir = join(codingAgentDir, ".channel-check", "dist");').replaceAll('packages/coding-agent/dist/','packages/coding-agent/.channel-check/dist/');
const script=join(isolated,'build-isolated.mjs');writeFileSync(script,build);
await import(pathToFileURL(script).href);
