const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const targets = ['PAO/memory-restored.ts', 'desktop/f1', '.pao/鍗忎綔瑙勫垯缁熶竴-20261030', '.pao/协作规则统一-20261030', '.pao/test-runs', '.pao/test-pao-home-review', 'desktop/.pao', 'PAO/pnpm-lock.yaml', 'PAO/pnpm-workspace.yaml', 'PAO/tui-plan.md', 'desktop/video', '.pao/卡号.txt', '.pao/四指标账.txt', '.zcodeignore'];
function measure(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { bytes: stat.size, files: 1, latest: stat.mtimeMs };
  const children = fs.readdirSync(file).map(name => measure(path.join(file, name)));
  return { bytes: children.reduce((n, v) => n + v.bytes, 0), files: children.reduce((n, v) => n + v.files, 0), latest: Math.max(stat.mtimeMs, ...children.map(v => v.latest)) };
}
const records = targets.map(target => {
  const file = path.join(root, target);
  const repo = target.startsWith('PAO/') ? 'PAO' : target.startsWith('desktop/') ? 'desktop' : '';
  const rel = repo ? target.slice(repo.length + 1) : target;
  const tracked = spawnSync('git', ['ls-files', '-z', '--', rel], { cwd: path.join(root, repo), encoding: 'utf8' });
  if (tracked.status !== 0) throw new Error(tracked.stderr);
  const exists = fs.existsSync(file);
  return { target, exists, trackedFiles: tracked.stdout.split('\0').filter(Boolean).length, ...(exists ? { ...measure(file), directoryMtime: fs.statSync(file).mtime.toISOString() } : {}) };
});
fs.writeFileSync(path.resolve(__dirname, '../checks/E03-inventory.json'), JSON.stringify(records, null, 2));
console.log(JSON.stringify(records, null, 2));
