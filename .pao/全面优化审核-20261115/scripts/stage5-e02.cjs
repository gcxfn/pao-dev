const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const checks = path.resolve(__dirname, '../checks');
const desktop = path.join(root, 'desktop');
const home = fs.mkdtempSync(path.resolve(root, '../临时文件夹/pao-stage5-e02-'));
const env = { ...process.env, PAO_HOME: home, PI_APP_TEST_LANE: 'core', PI_APP_REAL_AUTH: '0', PI_APP_TEST_MODE: 'background' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PI_APP_T21_PROOF_DIR;
delete env.PI_APP_T22_PROOF_DIR;
const proofRoot = path.join(root, '.pao/harness完善-20261017/F批-全链离线验证');
const snapshot = () => ['T21', 'T22'].flatMap(dir => fs.readdirSync(path.join(proofRoot, dir)).filter(name => name.endsWith('.png')).map(name => {
  const file = path.join(proofRoot, dir, name), stat = fs.statSync(file);
  return { file: path.relative(root, file), size: stat.size, mtimeMs: stat.mtimeMs };
}));
const before = snapshot();
const status = () => spawnSync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain', '--', '.pao/harness完善-20261017/'], { cwd: root, encoding: 'utf8' }).stdout;
const statusBefore = status();
function run(name, command, cwd, extra = {}) {
  const fd = fs.openSync(path.join(checks, name + '.log'), 'w');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { cwd, env: { ...env, ...extra }, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  console.log(name + ': exit ' + result.status);
  return result.status;
}
const build = run('E02-build', 'pnpm build', path.join(desktop, 'apps/desktop'));
if (build !== 0) process.exit(build ?? 1);
const tests = run('E02-default-tests', 'pnpm exec playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/core/f-desktop-t21-tech-display.spec.ts apps/desktop/tests/core/f-desktop-t22-a11y.spec.ts', desktop);
const custom = fs.mkdtempSync(path.join(os.tmpdir(), 'pao-t21-custom-'));
const customTests = run('E02-custom-tests', 'pnpm exec playwright test -c apps/desktop/playwright.config.ts apps/desktop/tests/core/f-desktop-t21-tech-display.spec.ts', desktop, { PI_APP_T21_PROOF_DIR: custom });
const listing = dir => fs.existsSync(dir) ? fs.readdirSync(dir).map(name => ({ name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs })) : [];
const after = snapshot(), statusAfter = status();
const evidence = { home, build, tests, customTests, before, after, historicalFilesUnchanged: JSON.stringify(before) === JSON.stringify(after), statusBefore, statusAfter, historicalStatusUnchanged: statusBefore === statusAfter, defaultT21: listing(path.join(os.tmpdir(), 'pao-t21-proof')), defaultT22: listing(path.join(os.tmpdir(), 'pao-t22-proof')), custom, customFiles: listing(custom) };
fs.writeFileSync(path.join(checks, 'E02-proof.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ...evidence, before: undefined, after: undefined, statusBefore: undefined, statusAfter: undefined }, null, 2));
