const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const checks = path.resolve(__dirname, '../checks');
const names = ['before-count', 'before-fsck', 'prune', 'after-count', 'after-fsck', 'before-log', 'after-log', 'before-status', 'after-status', 'comparison'];
for (const name of names) fs.writeFileSync(path.join(checks, 'E04-' + name + (name === 'comparison' ? '.json' : '.log')), '');
function git(name, args) {
  const result = spawnSync('git', ['-c', 'core.longpaths=true', '-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  fs.writeFileSync(path.join(checks, 'E04-' + name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  if (result.status !== 0) throw new Error(name + ': git exit ' + result.status + ', see log');
  console.log(name + ': exit 0');
  return result.stdout;
}
function ensureNoGit() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'if (Get-Process git -ErrorAction SilentlyContinue) { exit 1 }'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('另有 Git 进程，未清理');
}
ensureNoGit();
const beforeCount = git('before-count', ['count-objects', '-vH']);
const beforeLog = git('before-log', ['log', '-3', '--format=%H %s']);
const beforeStatus = git('before-status', ['status', '--porcelain=v1', '-z']);
git('before-fsck', ['fsck', '--full']);
ensureNoGit();
git('prune', ['prune', '--expire=now']);
const afterCount = git('after-count', ['count-objects', '-vH']);
git('after-fsck', ['fsck', '--full']);
const afterLog = git('after-log', ['log', '-3', '--format=%H %s']);
const afterStatus = git('after-status', ['status', '--porcelain=v1', '-z']);
const comparison = { beforeCount, afterCount, logUnchanged: beforeLog === afterLog, statusUnchanged: beforeStatus === afterStatus, beforeStatusItems: beforeStatus.split('\0').filter(Boolean).length, afterStatusItems: afterStatus.split('\0').filter(Boolean).length };
fs.writeFileSync(path.join(checks, 'E04-comparison.json'), JSON.stringify(comparison, null, 2));
console.log(JSON.stringify(comparison, null, 2));
if (!comparison.logUnchanged || !comparison.statusUnchanged || !/^garbage: 0$/m.test(afterCount)) process.exitCode = 1;
