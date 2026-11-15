// 用途：无模型地实测 single 规则/技能和工具装配；输入：源码根、隔离输出目录；输出：JSON。
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSingle } from './single-entry.mjs';

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) throw new Error('参数：源码根 独立输出目录');
const source = resolve(sourceArg), output = resolve(outputArg);
process.env.PI_OFFLINE = '1';
process.env.PI_SKIP_VERSION_CHECK = '1';
process.env.PAO_HOME = join(output, 'pao-home');
process.env.PI_CODING_AGENT_DIR = join(output, 'agent');
process.env.PAO_CODING_AGENT_DIR = join(output, 'agent');
globalThis.fetch = async () => { throw new Error('离线探针禁止网络请求'); };
const cwd = join(output, 'project'), agentDir = join(output, 'agent');
mkdirSync(join(cwd, '.pi/skills/bench-offline'), { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(cwd, 'AGENTS.md'), 'OFFLINE_PROJECT_RULE_SENTINEL\n');
writeFileSync(join(cwd, '.pi/skills/bench-offline/SKILL.md'), '---\nname: bench-offline\ndescription: OFFLINE_SKILL_SENTINEL\n---\n仅用于离线装载探针。\n');
const tools = ['read', 'bash', 'edit', 'write'];
// 同时用源码证据防止误把未知属性当成生效选项。
const sdkSource = readFileSync(join(source, 'packages/coding-agent/src/core/sdk.ts'), 'utf8');
const hasRequestedOption = sdkSource.includes('includePaoBuiltinExtension');
const { runtime } = await createSingle({ source, cwd, agentDir, tools, thinking: 'off', probe: true });
try {
  await runtime.session.bindExtensions({ mode: 'json', onError: (e) => { throw new Error(JSON.stringify(e)); } });
  const loader = runtime.services.resourceLoader;
  const rules = loader.getAgentsFiles().agentsFiles;
  const skills = loader.getSkills().skills;
  const activeTools = runtime.session.getActiveToolNames();
  const allTools = runtime.session.getAllTools().map((t) => t.name);
  const extensions = loader.getExtensions().extensions.map((e) => e.path);
  assert(rules.some((f) => f.content.includes('OFFLINE_PROJECT_RULE_SENTINEL')));
  assert(runtime.session.systemPrompt.includes('OFFLINE_PROJECT_RULE_SENTINEL'));
  assert(skills.some((s) => s.name === 'bench-offline'));
  assert(runtime.session.systemPrompt.includes('OFFLINE_SKILL_SENTINEL'));
  assert.deepEqual([...activeTools].sort(), [...tools].sort());
  assert(['find', 'grep', 'ls'].every((n) => allTools.includes(n)));
  assert(!allTools.some((n) => n.startsWith('pao_')));
  assert(!extensions.some((p) => /builtin:pao|\/pao\//.test(p)));
  const result = { ok: true, kind: '真实 SDK 装配，样例规则与技能，无模型调用', source,
    nodeVersion: process.version, declaredNodeEngine: JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).engines.node,
    sdkSourceSha256: createHash('sha256').update(sdkSource).digest('hex'),
    sdkDistSha256: createHash('sha256').update(readFileSync(join(source, 'packages/coding-agent/dist/core/sdk.js'))).digest('hex'),
    cliBundleSha256: createHash('sha256').update(readFileSync(join(source, 'packages/coding-agent/dist/bundle/cli.js'))).digest('hex'),
    includePaoBuiltinExtensionExists: hasRequestedOption, activeTools, allTools, extensions,
    rules: rules.map((f) => ({ path: f.path, sentinel: f.content.includes('OFFLINE_PROJECT_RULE_SENTINEL') })),
    skills: skills.map((s) => ({ name: s.name, filePath: s.filePath })), ruleInSystemPrompt: true, skillInSystemPrompt: true };
  writeFileSync(join(output, 'single-probe.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await runtime.dispose(); }
