// 用途：保存本轮会修改的源码开工快照；输入：当前开发仓；输出：本目录 baseline/source。
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = 'D:/AI/workspace/pao-dev';
const output = join(root, '.pao/摩擦修复-20261020/baseline');
const paths = [
  'PAO/packages/coding-agent/src/pao',
  'PAO/packages/coding-agent/src/core/tools/write.ts',
  'PAO/packages/coding-agent/src/core/tools/edit.ts',
  'PAO/packages/coding-agent/src/core/tools/powershell.ts',
  'PAO/packages/coding-agent/test/pao',
  'PAO/packages/coding-agent/test/tools.test.ts',
  'PAO/packages/coding-agent/test/powershell-tool.test.ts',
];
mkdirSync(join(output, 'source'), { recursive: true });
for (const entry of paths) {
  if (existsSync(join(root, entry))) cpSync(join(root, entry), join(output, 'source', entry), { recursive: true });
}
writeFileSync(join(output, 'heads.json'), JSON.stringify(Object.fromEntries(['.', 'PAO', 'desktop'].map(repo =>
  [repo, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(root, repo), encoding: 'utf8' }).trim()]
)), null, 2));
