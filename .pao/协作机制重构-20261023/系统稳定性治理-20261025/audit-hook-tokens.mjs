// 用途：核对提交钩子的格式变化。输入：钩子前快照与当前 PAO；输出：TS 语法树比较，忽略位置、注释和尾逗号，不修改文件。
import ts from '../../../desktop/node_modules/typescript/lib/typescript.js';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const baseline = fileURLToPath(new URL('./提交钩子前基线/', import.meta.url));
const current = fileURLToPath(new URL('../../../PAO/', import.meta.url));
function syntax(source) {
  function describe(node) {
    if (ts.isParenthesizedExpression(node)) return describe(node.expression);
    const children = [];
    ts.forEachChild(node, (child) => { children.push(describe(child)); });
    return [node.kind, ts.isSourceFile(node) ? undefined : node.text, node.isTypeOnly, children];
  }
  return JSON.stringify(describe(ts.createSourceFile('snapshot.ts', source, ts.ScriptTarget.Latest, true)));
}
for (const entry of await readdir(baseline, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const full = join(entry.parentPath, entry.name);
  const relative = full.slice(baseline.length);
  const equal = syntax(await readFile(full, 'utf8')) === syntax(await readFile(join(current, relative), 'utf8'));
  console.log(`${equal ? 'PASS' : 'FAIL'} ${relative}`);
  if (!equal) process.exitCode = 1;
}
