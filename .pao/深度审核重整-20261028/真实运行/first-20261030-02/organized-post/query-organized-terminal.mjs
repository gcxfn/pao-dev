// 用途：从当前 PAO dist 的结构化读面查询 organized benchmark 的工作流终态。
// 输入：源码根、PAO_HOME、项目根、配方名。输出：stdout 单行严格 JSON；失败时非零退出。
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [source, paoHome, projectRoot, workflowName = '基准开发流水线'] =
  process.argv.slice(2);

function writeResult(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

try {
  if (!source || !paoHome || !projectRoot) throw new Error('缺少源码、PAO_HOME 或项目根参数');
  const load = (file) =>
    import(pathToFileURL(join(source, 'packages/coding-agent/dist/pao', file)).href);
  const { loadRecipe } = await load('workflow/recipe.js');
  const { readControl, readControlReport } = await load('workflow/control.js');
  const cardsDir = join(projectRoot, '.pao', 'benchmark', '卡');
  const options = { cardsDir, workspaceDir: join(projectRoot, '.pao', 'benchmark') };
  const recipe = loadRecipe(paoHome, workflowName);
  const flow = readControl(recipe, options);
  const report = await readControlReport(flow, options);
  if (!['running', 'hold', 'completed'].includes(report.status)) {
    throw new Error('工作流终态不是 running/hold/completed');
  }
  writeResult({
    ok: true,
    control: {
      instance: flow.实例,
      owner: flow.owner,
      workflow: flow.工作流,
      cards_dir: flow.卡目录,
    },
    report: {
      workflow: report.workflow,
      status: report.status,
    },
  });
} catch (error) {
  writeResult({
    ok: false,
    error: {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    },
  });
  process.exitCode = 1;
}
