// 用途：single 的 SDK 薄入口；只读取同一已解包源码的 dist，不下载或替换内核。
// 输入：PAO_BENCH_SOURCE、Harbor Pi 的固定参数；输出：原生 JSON 事件和会话。
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

export async function createSingle({ source, cwd, agentDir, sessionDir, tools, thinking, provider, modelId, probe = false }) {
  if (tools.join(',') !== 'read,bash,edit,write') throw new Error('共同初始工具必须为 pi 的四项默认工具');
  const load = (file) => import(pathToFileURL(join(source, 'packages/coding-agent/dist', file)).href);
  // 不导入 extensions/index.js：它静态导入 PAO，会在模块加载时注册业务钩子。
  const sdk = await load('core/sdk.js');
  const { SettingsManager } = await load('core/settings-manager.js');
  const { SessionManager } = await load('core/session-manager.js');
  const { createAgentSessionServices, createAgentSessionFromServices } = await load('core/agent-session-services.js');
  const { createAgentSessionRuntime } = await load('core/agent-session-runtime.js');
  const extensionFactories = [];
  for (const [name, file] of [['llama.cpp', 'llama'], ['codemode', 'codemode'], ['tool-search', 'tool-search'], ['mcp', 'mcp']]) {
    extensionFactories.push({ name, factory: (await load(`extensions/${file}/index.js`)).default, builtin: true, replaceable: name !== 'llama.cpp' });
  }
  const sessionManager = probe ? SessionManager.inMemory(cwd) : SessionManager.create(cwd, sessionDir);
  const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      resourceLoaderOptions: { extensionFactories },
    });
    const errors = services.diagnostics.filter((d) => d.type === 'error');
    if (errors.length) throw new Error(JSON.stringify(errors));
    const model = provider && modelId ? services.modelRuntime.getModel(provider, modelId) : undefined;
    if (!probe && !model) throw new Error(`模型不存在：${provider}/${modelId}`);
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model,
      thinkingLevel: thinking }); // 沿原生默认装配，保留 find/grep/ls 与共同扩展的可发现能力。
    return { ...created, services, diagnostics: services.diagnostics };
  }, { cwd, agentDir, sessionManager });
  return { runtime, sdk, load };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    print: { type: 'boolean' }, mode: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
    thinking: { type: 'string' }, tools: { type: 'string' }, 'session-dir': { type: 'string' },
  } });
  if (!values.print || values.mode !== 'json' || positionals.length !== 1) throw new Error('只支持固定的 Harbor print/json 单题入口');
  const source = process.env.PAO_BENCH_SOURCE;
  const agentDir = process.env.PI_CODING_AGENT_DIR || process.env.PAO_CODING_AGENT_DIR;
  if (!source || !agentDir) throw new Error('缺少隔离源码或配置目录');
  const { runtime, load } = await createSingle({ source, cwd: process.cwd(), agentDir, sessionDir: values['session-dir'],
    tools: values.tools.split(','), thinking: values.thinking, provider: values.provider, modelId: values.model });
  const loader = runtime.services.resourceLoader;
  writeFileSync(join(values['session-dir'], 'single-boundary.json'), JSON.stringify({
    activeTools: runtime.session.getActiveToolNames(), allTools: runtime.session.getAllTools().map((t) => t.name),
    rules: loader.getAgentsFiles().agentsFiles.map((f) => f.path), skills: loader.getSkills().skills.map((s) => s.name),
    extensions: loader.getExtensions().extensions.map((e) => e.path),
  }, null, 2));
  const { runPrintMode } = await load('modes/print-mode.js');
  process.exitCode = await runPrintMode(runtime, { mode: 'json', initialMessage: positionals[0] });
}
