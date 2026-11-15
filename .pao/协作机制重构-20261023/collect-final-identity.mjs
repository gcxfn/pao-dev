// 用途：相对本轮开工快照生成源码差异清单与构建身份；只读源码，写本轮验收目录，不读取凭证。
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '../..');
const out = import.meta.dirname;
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    if (['node_modules', 'dist', 'out', 'release', '.git', '__pycache__'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
const repos = [
  {name: 'PAO', roots: ['packages/coding-agent/src/pao', 'packages/coding-agent/test/pao']},
  {name: 'desktop', roots: ['packages/pi-sdk-driver/src', 'packages/pi-sdk-driver/test']},
];
const changes = [];
for (const repo of repos) {
  const directory = join(root, repo.name);
  const baseline = join(out, 'baseline', repo.name);
  const names = new Set(repo.roots.flatMap(area => [
    ...files(join(directory, area)).map(path => relative(directory, path)),
    ...files(join(baseline, area)).map(path => relative(baseline, path)),
  ]));
  for (const name of [...names].sort()) {
    const before = join(baseline, name), after = join(directory, name);
    const a = existsSync(before) ? sha(before) : null;
    const b = existsSync(after) ? sha(after) : null;
    if (a !== b) changes.push({repo: repo.name, path: name.replaceAll('\\', '/'), before: a, after: b});
  }
}
const artifacts = ['PAO/packages/coding-agent/dist/pao/index.js',
  'PAO/packages/coding-agent/dist/pao/worker/post-dispatch.js',
  'desktop/apps/desktop/release/win-unpacked/PAO.exe',
  'desktop/apps/desktop/release/win-unpacked/resources/app.asar',
  '.pao/地图简报与部门协作-20261020/benchmark/bench_controller.py'];
const value = {at: new Date().toISOString(), scope: '本轮快照相对差异，非 git HEAD 总差异；只列本次涉及的内核与 driver 范围。模型质量及正式数据迁移未验。',
  heads: ['.', 'PAO', 'desktop'].map(repo => ({repo, head: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: join(root, repo), encoding:'utf8'}).trim()})),
  changes, artifacts: artifacts.map(path => ({path, sha256: sha(join(root, path))}))};
writeFileSync(join(out, '最终源码与发行身份.json'), JSON.stringify(value, null, 2) + '\n');
console.log(JSON.stringify({changes: changes.length, production: changes.filter(x => x.path.includes('/src/')).length, artifacts: artifacts.length}));
