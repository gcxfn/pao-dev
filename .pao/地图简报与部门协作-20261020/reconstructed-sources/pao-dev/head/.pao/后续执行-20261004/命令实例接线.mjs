// 用途：将命令读写改为显式会话实例；输入源码与测试；输出原文件最小机械替换。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const base = new URL('../../PAO/packages/coding-agent/', import.meta.url);
function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir,e.name)) : e.name.endsWith('.ts') ? [join(dir,e.name)] : []); }
for (const file of files(fileURLToPath(new URL('src/pao/', base)))) {
  if (file.endsWith('command-router.ts') || file.endsWith('panel\\index.ts') || file.endsWith('panel/index.ts')) continue;
  const source = readFileSync(file, 'utf8');
  const updated = source.replaceAll('addPaoSubcommand({', 'addPaoSubcommand(pi, {');
  if (updated !== source) writeFileSync(file, updated);
}
for (const file of files(fileURLToPath(new URL('test/pao/', base)))) {
  const source = readFileSync(file,'utf8');
  const updated = source.replaceAll('listPaoSubcommands()', 'listPaoSubcommands(pi)');
  if (updated !== source) writeFileSync(file, updated);
}
const replacements = {
  'loadout-role.test.ts': [['listPaoSubcommands(pi)', 'listPaoSubcommands(mock.pi as never)']],
  'wiring-smoke.test.ts': [['listPaoSubcommands(pi)', 'listPaoSubcommands(mock.pi as never)']],
  'routing-model-command.test.ts': [['listPaoSubcommands(pi)', 'listPaoSubcommands(captured.pi)']],
  'workflow-auto-chain.test.ts': [['listPaoSubcommands(pi)', 'listPaoSubcommands(f.captured.pi)']],
  'collab-tools.test.ts': [['expect(listPaoSubcommands(pi)', 'expect(listPaoSubcommands(captured.pi)']],
  'status-command.test.ts': [[`listPaoSubcommands(pi).find((entry) => entry.name === "status")`, `listPaoSubcommands(captured.pi).find((entry) => entry.name === "status")`]],
};
for (const [file, pairs] of Object.entries(replacements)) {
  const path = new URL('test/pao/' + file, base);
  let text = readFileSync(path,'utf8');
  for (const [from,to] of pairs) text = text.replaceAll(from,to);
  writeFileSync(path,text);
}
