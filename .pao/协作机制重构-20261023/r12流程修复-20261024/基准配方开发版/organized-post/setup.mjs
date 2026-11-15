// 用途：在隔离 PAO_HOME 内通过现有建部/配方接口建立开发版测试组织；无模型调用。
// 输入：源码根、组织配置、隔离 home/agentDir、证据目录；输出：四部门、流水线与结构化预检证据。
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [source, kitPath, paoHome, agentDir, evidence] = process.argv.slice(2).map((path) => resolve(path));
const kit = JSON.parse(readFileSync(kitPath, 'utf8'));
const load = (file) => import(pathToFileURL(join(source, 'packages/coding-agent/dist/pao', file)).href);
const { createDept } = await load('dept/scaffold.js');
const { readDeptCatalog, validateDeptCatalog } = await load('dept/catalog.js');
const { saveRecipe } = await load('workflow/distill.js');
const { loadRecipe } = await load('workflow/recipe.js');
const { checkPreflight } = await load('preflight/index.js');
const { stringify } = createRequire(join(source, 'package.json'))('yaml');

assert.deepEqual(
  kit.workflow.节点.map((node) => node.名字),
  ['侦察', '规划', '实施', '审核'],
  '开发版配方节点顺序必须固定',
);
for (const node of kit.workflow.节点) {
  assert.equal(node.人工确认, false, `${node.名字} 的人工确认配置必须显式保留`);
  assert.equal(node.允许请求主控裁定, true, `${node.名字} 必须显式允许请求主控裁定`);
}

mkdirSync(paoHome, { recursive: true });
mkdirSync(join(paoHome, 'pao配置'), { recursive: true });
mkdirSync(join(agentDir, 'extensions'), { recursive: true });
mkdirSync(evidence, { recursive: true });
writeFileSync(join(paoHome, 'pao配置/档位.json'), JSON.stringify({ provider: 'pao', 档位:
  ['fast', 'primary'].map((名) => ({ 名, provider: 'harbor-endpoint', model: 'group/deepseek', thinkingLevel: 'high' })) }));
for (const department of kit.departments) {
  const created = await createDept({ paoHome, 名字: department.name, 标签: department.tags, 默认档位: 'primary' });
  assert.equal(created.注册表, 'created', '只允许在本题新建的隔离组织中初始化');
  writeFileSync(join(paoHome, '部门', department.name, '配方.md'), department.recipe);
}
const workflowText = '---\n' + stringify(kit.workflow) + '---\n' + kit.description + '\n';
saveRecipe(paoHome, kit.workflow.名字, workflowText, { 备份时间: new Date().toISOString() });
copyFileSync(join(resolve(kitPath, '..'), 'activate-tools.mjs'), join(agentDir, 'extensions/benchmark-organization.js'));
const recipe = loadRecipe(paoHome, kit.workflow.名字);
assert.equal(recipe.版本, 2);
assert.equal(recipe.自动执行, true);
assert.deepEqual(recipe.拓扑序, ['侦察', '规划', '实施', '审核']);
const nodeConfiguration = recipe.节点.map((node) => ({
  名字: node.名字,
  人工确认: node.人工确认,
  允许请求主控裁定: node.允许请求主控裁定,
}));
for (const node of nodeConfiguration) {
  assert.equal(node.人工确认, false, `${node.名字} 的人工确认配置读取结果不一致`);
  assert.equal(node.允许请求主控裁定, true, `${node.名字} 的主控裁定配置读取结果不一致`);
}
const catalog = readDeptCatalog(paoHome);
const issues = validateDeptCatalog(catalog);
assert(!issues.some((issue) => issue.级别 === '阻止启动'), JSON.stringify(issues));
const preflight = checkPreflight({ project: process.cwd(), paoHome,
  departments: kit.departments.map((d) => d.name), parameters: { 任务: '仅做组织装载预检，不执行题目' },
  requiredParameters: recipe.参数 });
assert(preflight.canStart, JSON.stringify(preflight));
const result = { ok: true, kind: '开发版组织装载预检，未调用模型、未启动题目',
  departments: catalog.部门.map((d) => d.名字), workflow: recipe.名字, nodes: recipe.拓扑序,
  version: recipe.版本, auto: recipe.自动执行, nodeConfiguration, issues, preflight };
writeFileSync(join(evidence, 'organization-setup.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
