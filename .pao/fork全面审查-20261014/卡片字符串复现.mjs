// 用途：验证合法数字父卡引用的落盘与后续协作；输入为当前源码，输出为隔离样本和控制台，无模型调用。
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), 'scalar-data-'));
const src = 'file:///D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/';
const { createDept } = await import(src + 'dept/scaffold.ts');
const { createCard, listCards } = await import(src + 'cards/cardfile.ts');
const { registerCollab } = await import(src + 'collab/index.ts');
const home = join(root, 'home'), cardsDir = join(root, 'project', '.pao', '卡');
mkdirSync(cardsDir, { recursive: true });
await createDept({ paoHome: home, 名字: '审查' });
await createCard(cardsDir, { 目标: '父卡', 部门: '审查', 验收: '隔离复现', 创建: '2026-10-14 20:00' });
let tool;
registerCollab({ registerTool(value) { tool = value; } }, {
  resolveCardsDir: () => cardsDir,
  resolveRegistryPath: () => join(home, '部门', '注册表.md'),
  resolvePaoHome: () => home,
});
const params = { goal: '第一次协作', dept: '审查', acceptance: '隔离复现', parent: '1' };
const first = await tool.execute('first', params);
assert.equal(first.details.裁决, '放行');
const child = listCards(cardsDir).find(c => c.card_no === 2);
assert.equal(typeof child.frontmatter.parent, 'number');
let error;
try { await tool.execute('second', { ...params, goal: '第二次协作' }); }
catch (e) { error = e.message; }
assert.match(error ?? '', /parent.trim is not a function/);
console.log(JSON.stringify({ firstVerdict: first.details.裁决, storedParent: child.frontmatter.parent, storedType: typeof child.frontmatter.parent, secondError: error, fixture: root }));
