// 用途：保存本轮开始时的开发文件与版本；输入：三个开发仓；输出：同目录只读基线副本和索引。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const output = dirname(fileURLToPath(import.meta.url));
const root = resolve(output, '../..');
const indexPath = join(output, '基线索引.json');
if (existsSync(indexPath)) throw new Error('本轮基线已存在，拒绝覆盖');
const records = [];
for (const [name, directory, scopes] of [
  ['root', root, ['plans', 'README.md']],
  ['PAO', join(root, 'PAO'), ['packages/coding-agent/src/pao', 'packages/coding-agent/test/pao', 'packages/coding-agent/package.json', 'packages/coding-agent/vitest.config.ts']],
  ['desktop', join(root, 'desktop'), ['apps/desktop/electron', 'apps/desktop/tests', 'packages/pi-sdk-driver', 'package.json']],
]) {
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { maxBuffer: 32 * 1024 * 1024 });
  const files = [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...scopes).toString().split('\0').filter(Boolean))];
  const saved = [];
  for (const file of files) {
    const source = join(directory, file);
    if (!existsSync(source)) continue;
    const bytes = readFileSync(source);
    const destination = join(output, 'baseline', name, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    saved.push({ file, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  writeFileSync(join(output, `${name}-before.diff`), git('diff', '--binary'));
  writeFileSync(join(output, `${name}-staged-before.diff`), git('diff', '--cached', '--binary'));
  records.push({ name, directory, head: git('rev-parse', 'HEAD').toString().trim(), status: git('status', '--porcelain', '-uno').toString(), files: saved });
}
writeFileSync(indexPath, JSON.stringify({ capturedAt: new Date().toISOString(), records }, null, 2));
console.log(JSON.stringify(records.map(({ name, head, files }) => ({ name, head, savedFiles: files.length }))));
