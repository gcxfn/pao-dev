// 用途：在隔离 PAO_HOME 内通过现有建部/配方接口建立测试组织；无模型调用。
// 输入：冻结源码根、组织配置、模型绑定、隔离 home/agentDir、证据目录；输出：四部门、流水线与预检证据。
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const [source, kitPath, paoHome, agentDir, evidence, project, explicitBindingPath] =
  process.argv.slice(2).map((path) => resolve(path));
// SDK 宿主沿用既有参数个数；父适配器已把同一绑定上传到固定位置。
const bindingPath = explicitBindingPath || '/tmp/benchmark-model-binding.json';
const kit = JSON.parse(readFileSync(kitPath, 'utf8'));
const binding = JSON.parse(readFileSync(bindingPath, 'utf8'));
assert(binding.model_name && binding.selected_model_name && binding.provider && binding.model && binding.thinking);
assert.equal(binding.provider, 'harbor-endpoint', '运行态必须使用已注册的 Harbor 路由');
assert.equal(binding.model_name, binding.provider + '/' + binding.model, '运行模型别名与绑定不一致');
const selectedProviderSeparator = binding.selected_model_name.indexOf('/');
assert(selectedProviderSeparator > 0, '外部选定模型名必须包含 provider/model');
assert.equal(binding.selected_model_name.slice(selectedProviderSeparator + 1), binding.model,
  '外部选定模型与运行 model id 不一致');
const load = (file) => import(pathToFileURL(join(source, 'packages/coding-agent/dist/pao', file)).href);
const { createDept } = await load('dept/scaffold.js');
const { readDeptCatalog, validateDeptCatalog } = await load('dept/catalog.js');
const { saveRecipe } = await load('workflow/distill.js');
const { loadRecipe } = await load('workflow/recipe.js');
const { checkPreflight } = await load('preflight/index.js');
const { stringify } = createRequire(join(source, 'package.json'))('yaml');
mkdirSync(paoHome, { recursive: true });
mkdirSync(join(paoHome, 'pao配置'), { recursive: true });
mkdirSync(join(agentDir, 'extensions'), { recursive: true });
mkdirSync(evidence, { recursive: true });
const tiers = ['fast', 'primary'].map((名) => ({
  名, provider: binding.provider, model: binding.model, thinkingLevel: binding.thinking,
}));
writeFileSync(join(paoHome, 'pao配置/档位.json'), JSON.stringify({ provider: 'pao', 档位: tiers }));
const tierModels = tiers.map((tier) => tier.provider + '/' + tier.model);
assert(tierModels.every((model) => model === binding.model_name), '主控与工人档位模型必须使用运行别名');
for (const node of kit.workflow.节点) {
  assert.equal(node.模型, binding.provider + '/' + binding.model, '流水线节点模型与选定模型不一致');
  assert.equal(node.思考强度, binding.thinking, '流水线节点思考强度与选定模型不一致');
  assert.equal(node.档位, 'primary');
}
const workflowModels = kit.workflow.节点.map((node) => node.模型);
assert(workflowModels.length > 0, '流水线必须至少有一个部长节点');
assert([...tierModels, ...workflowModels].every((model) => model === binding.model_name),
  '主控、部长和工人必须使用同一已注册 Harbor 运行别名');
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
const catalog = readDeptCatalog(paoHome);
const issues = validateDeptCatalog(catalog);
assert(!issues.some((issue) => issue.级别 === '阻止启动'), JSON.stringify(issues));
const preflight = checkPreflight({ project: process.cwd(), paoHome,
  departments: kit.departments.map((d) => d.name), parameters: { 任务: '仅做组织装载预检，不执行题目' },
  requiredParameters: recipe.参数 });
assert(preflight.canStart, JSON.stringify(preflight));
const result = { ok: true, kind: '真实建部与配方 API，未调用模型、未启动题目',
  departments: catalog.部门.map((d) => d.名字), workflow: recipe.名字, nodes: recipe.拓扑序,
  version: recipe.版本, auto: recipe.自动执行, issues, preflight,
  model_binding: binding,
  role_model_check: {
    主控: tierModels[1],
    部长: workflowModels[0],
    工人: tierModels[0],
    thinking: binding.thinking,
    consistent: true,
  } };
writeFileSync(join(evidence, 'organization-setup.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
