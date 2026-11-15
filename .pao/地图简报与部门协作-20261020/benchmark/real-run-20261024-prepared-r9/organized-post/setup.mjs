// 用途：先在官方任务根建立真实 Git 输入基线，再在隔离 PAO_HOME 内建部与流程；无模型调用。
// 输入：冻结源码根、新 run 根、隔离 home/agentDir、正式题卡根；输出：Git 与组织预检证据。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const [source, kitSource, paoHome, agentDir, evidence, officialTaskRoot] = process.argv.slice(2).map((path) => resolve(path));
const kitRoot = resolve(kitSource);
const kitPath = join(kitRoot, 'kit.json');
const kit = JSON.parse(readFileSync(kitPath, 'utf8'));
const load = (file) => import(pathToFileURL(join(source, 'packages/coding-agent/dist/pao', file)).href);
mkdirSync(evidence, { recursive: true });

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const baselineCreated = !existsSync(join(officialTaskRoot, '.git'));
if (baselineCreated) {
  git(officialTaskRoot, 'init');
  git(officialTaskRoot, 'config', 'user.email', 'benchmark@local');
  git(officialTaskRoot, 'config', 'user.name', 'PAO-benchmark');
  git(officialTaskRoot, 'add', '-A');
  git(officialTaskRoot, 'commit', '--allow-empty', '--no-gpg-sign', '-qm', 'benchmark input baseline');
}
const head = git(officialTaskRoot, 'rev-parse', 'HEAD').trim();
assert.match(head, /^[0-9a-f]{40}$/);
const statusAfterBaseline = git(officialTaskRoot, 'status', '--porcelain', '--untracked-files=all');
assert.equal(statusAfterBaseline, '', 'Git 输入基线建立后工作区必须干净');
const baseline = {
  ok: true,
  official_task_root: officialTaskRoot,
  baseline_created: baselineCreated,
  head,
  commit_message: 'benchmark input baseline',
  status_after_baseline: statusAfterBaseline,
  scope: '正式题目环境准备；未读取隐藏测试或答案',
};
writeFileSync(join(evidence, 'git-baseline.json'), JSON.stringify(baseline, null, 2) + '\n');

const { createDept } = await load('dept/scaffold.js');
const { readDeptCatalog, validateDeptCatalog } = await load('dept/catalog.js');
const { saveRecipe } = await load('workflow/distill.js');
const { loadRecipe } = await load('workflow/recipe.js');
const { checkPreflight } = await load('preflight/index.js');
const { stringify } = createRequire(join(source, 'package.json'))('yaml');
mkdirSync(paoHome, { recursive: true });
mkdirSync(join(paoHome, 'pao配置'), { recursive: true });
mkdirSync(join(agentDir, 'extensions'), { recursive: true });
writeFileSync(join(paoHome, 'pao配置/档位.json'), JSON.stringify({ provider: 'pao', 档位:
  ['fast', 'primary'].map((名) => ({ 名, provider: 'harbor-endpoint', model: 'minimax-code/MiniMax-M3.1-Flash', thinkingLevel: 'high' })) }));
const supervisionPath = join(paoHome, 'pao配置', '保温.json');
const supervision = existsSync(supervisionPath)
  ? JSON.parse(readFileSync(supervisionPath, 'utf8'))
  : {};
writeFileSync(supervisionPath, JSON.stringify({ ...supervision, 工人监督分钟: 15, 部门监督分钟: 30 }, null, 2) + '\n');
for (const department of kit.departments) {
  const created = await createDept({ paoHome, 名字: department.name, 标签: department.tags, 默认档位: 'primary' });
  assert.equal(created.注册表, 'created', '只允许在本题新建的隔离组织中初始化');
  writeFileSync(join(paoHome, '部门', department.name, '配方.md'), department.recipe);
}
const workflowText = '---\n' + stringify(kit.workflow) + '---\n' + kit.description + '\n';
saveRecipe(paoHome, kit.workflow.名字, workflowText, { 备份时间: new Date().toISOString() });
copyFileSync(join(kitRoot, 'activate-tools.mjs'), join(agentDir, 'extensions/benchmark-organization.js'));
const recipe = loadRecipe(paoHome, kit.workflow.名字);
assert.equal(recipe.版本, 2);
assert.equal(recipe.自动执行, true);
assert.deepEqual(recipe.拓扑序, ['侦察', '规划', '实施', '审核']);
const catalog = readDeptCatalog(paoHome);
const issues = validateDeptCatalog(catalog);
assert(!issues.some((issue) => issue.级别 === '阻止启动'), JSON.stringify(issues));
const preflight = checkPreflight({ project: officialTaskRoot, paoHome,
  departments: kit.departments.map((d) => d.name), parameters: { 任务: '仅做组织装载预检，不执行题目' },
  requiredParameters: recipe.参数 });
assert(preflight.canStart, JSON.stringify(preflight));
const result = { ok: true, kind: '真实 Git 基线、建部与配方 API；未调用模型、未启动题目',
  baseline, supervision: { 工人监督分钟: 15, 部门监督分钟: 30 },
  departments: catalog.部门.map((d) => d.名字), workflow: recipe.名字, nodes: recipe.拓扑序,
  version: recipe.版本, auto: recipe.自动执行, issues, preflight };
writeFileSync(join(evidence, 'organization-setup.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
