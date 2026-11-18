const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const terms = ['memory-restored', 'desktop/f1', '"f1"', "'f1'", '鍗忎綔瑙勫垯缁熶竴-20261030', 'test-pao-home-review', '.pao/test-runs', 'desktop/.pao', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tui-plan.md', '@pi-app/video', '卡号.txt', '四指标账.txt', '.zcodeignore'];
const results = terms.map(term => {
  const args = ['--files-with-matches', '--hidden', '--no-ignore', '--fixed-strings', term, '.', '-g', '!临时文件夹/**', '-g', '!**/.git/**', '-g', '!**/node_modules/**', '-g', '!**/dist/**', '-g', '!**/out/**', '-g', '!**/release*/**', '-g', '!**/vendor/**', '-g', '!**/checks/**', '-g', '!**/*.log', '-g', '!**/*.jsonl', '-g', '!**/E01-文件分类清单.json', '-g', '!**/package-lock.json', '-g', '!**/pnpm-lock.yaml'];
  const result = spawnSync('rg', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr);
  const files = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return { term, files };
});
fs.writeFileSync(path.resolve(__dirname, '../checks/E03-reference-files.json'), JSON.stringify(results, null, 2));
for (const result of results) console.log(result.term + ': ' + result.files.length + ' files; live: ' + result.files.filter(file => /^\.\\(PAO|desktop|scripts)\\/.test(file) && !/\\(archive|test-results)\\/.test(file)).slice(0, 12).join(', '));
