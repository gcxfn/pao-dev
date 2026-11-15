// 用途：按开工快照区分本轮和既有修改；输入：baseline/source 与当前文件；输出：本轮文件清单。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
const root = 'D:/AI/workspace/pao-dev';
const evidence = join(root, '.pao/摩擦修复-20261020');
const baseline = join(evidence, 'baseline/source');
function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}
const groups = ['PAO/packages/coding-agent/src/pao', 'PAO/packages/coding-agent/test/pao'];
const candidates = new Set(files(baseline).map(file => relative(baseline, file)));
for (const group of groups) for (const file of files(join(root, group))) candidates.add(relative(root, file));
for (const file of files(join(root, 'PAO/packages/coding-agent/test')).filter(file => /(?:write|script-encoding|powershell).*\.test\.ts$/.test(file))) candidates.add(relative(root, file));
const changes = [...candidates].sort().flatMap(file => {
  const before = join(baseline, file), after = join(root, file);
  if (!existsSync(after)) return [{ file, status: 'deleted' }];
  if (!existsSync(before)) return [{ file, status: 'added' }];
  return readFileSync(before).equals(readFileSync(after)) ? [] : [{ file, status: 'modified' }];
});
writeFileSync(join(evidence, '本轮文件清单.json'), JSON.stringify(changes, null, 2));
process.stdout.write(JSON.stringify(changes, null, 2));
