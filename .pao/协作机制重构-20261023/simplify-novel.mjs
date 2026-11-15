// 用途：合并被拆成顺序依赖用例的小说集成场景；输入/输出均为本轮目标测试文件。
import { readFileSync, writeFileSync } from 'node:fs';
const path = new URL('../../PAO/packages/coding-agent/test/pao/f-novel-loop.test.ts', import.meta.url);
let source = readFileSync(path, 'utf8');
source = source.replace('import { afterAll, afterEach, describe, expect, it, vi }', 'import { afterEach, describe, expect, it, vi }');
source = source.replace('let stagedFixture: Fixture | undefined;\n', '');
source = source.replace('\tif (stagedFixture) return;\n', '');
const start = source.indexOf('\tdescribe("五写任务后的只读审核、真实打回与返修", () => {');
const end = source.indexOf('\n\tit("五步链的模拟边界诚实', start);
if (start < 0 || end < 0) throw new Error('未定位待合并场景');
let block = source.slice(start, end);
const first = block.indexOf('\t\t\tfixture = makeFixture(');
const last = block.lastIndexOf('\n\t\t}, 60000);');
if (first < 0 || last < 0) throw new Error('未定位场景实现');
block = block.slice(first, last);
block = block.replace('\t\t\tfixture = makeFixture(', '\t\tconst fixture = makeFixture(');
block = block.replace('\t\t\tstagedFixture = fixture;\n', '');
block = block.replace(/\n\t\t}, 60000\);\n\t\tit\("([^"]+)", async \(\) => \{/g, '\n\t\t// $1');
block = block.replace(/^\t\t\t/gm, '\t\t');
// 合并后各阶段读盘结果仍各自成块，避免重复声明 flow。
block = block.replace(/\n\t\t\/\/ (后两项写作|五项写作|回边让|返修链|重做后的|第 5 步|人工确认后)/g, '\n\t\t}\n\t\t{\n\t\t// $1');
block = '\t\t{\n' + block + '\n\t\t}';
const replacement = '\tit("五项写作、只读审核打回、返修与人工确认形成完整闭环", async () => {\n' +
  '\t\tlet allowedNodes = new Set<string>();\n\t\tconst reports: AutoChainReport[] = [];\n' +
  block + '\n\t}, 240_000);';
// fixture 必须在各阶段共享，移出第一段块；其余阶段变量仍在各自块内。
const declaration = '\t\tconst fixture = makeFixture("novel-bounce", novelNodes());\n';
let combined = replacement.replace(declaration, '');
combined = combined.replace('\t\tlet allowedNodes', declaration + '\t\tlet allowedNodes');
combined = combined.replace('\t}, 240_000);', '\t// 实测完整九次写作交付与两次判定约三分钟，预算覆盖同一条链，不能拆成互相依赖的用例。\n\t}, 240_000);');
let inStage = false;
combined = combined.split('\n').map(line => {
  if (line === '\t\t{') { inStage = true; return line; }
  if (line === '\t\t}') { inStage = false; return line; }
  return inStage ? '\t' + line : line;
}).join('\n');
source = source.slice(0, start) + combined + source.slice(end);
source = source.replaceAll('\t}, 20_000);', '\t});');
writeFileSync(path, source);
