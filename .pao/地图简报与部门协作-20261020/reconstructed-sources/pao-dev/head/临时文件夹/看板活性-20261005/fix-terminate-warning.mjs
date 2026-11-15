import { readFileSync, writeFileSync } from "node:fs";
const cmd = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/src/features/workboard/kanban-command.ts";
const spec = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/tests/unit/kanban-command.spec.ts";
let t = readFileSync(cmd, "utf8");
const must = (text, needle) => {
  if (!text.includes(needle)) throw new Error("锚点不匹配: " + needle.slice(0, 40));
};
const old = `/** 终止只对进行中的卡；同样只生成指令，且要求先读 live 输出确认卡死。 */
export function buildTerminateCommand(card: KanbanCard): string {
  const params = { 卡号: formatCardNumber(card.number), 卡目录: cardDirectory(card.path) };
  return [
    "请回到原主控会话，先读 live 输出确认卡死，再执行下面这条指令（不要在看板直接终止）：",
    "工具：pao_终止卡",
    \`参数：\${JSON.stringify(params)}\`,
    ...identityLines(card),
    "只终止本会话派出的运行中 worker；执行后刷新看板核对。未执行前不要对外声称已终止。",
  ].join("\\n");
}`;
must(t, old);
const next = `/**
 * 终止只对进行中的卡；同样只生成指令。
 * 现读工具局限（已核 worker/index.ts）：pao_终止卡 只按卡号匹配本会话运行中条目，
 * 不按项目/卡目录过滤，所以必须先盘点确认卡号唯一；同号多目标时本指令不精确，不执行。
 */
export function buildTerminateCommand(card: KanbanCard): string {
  const params = { 卡号: formatCardNumber(card.number), 卡目录: cardDirectory(card.path) };
  return [
    "请回到原主控会话，按顺序核对，不要在看板直接终止：",
    "1. 先执行 pao_盘点，确认这个卡号在本会话的运行中条目唯一；同号卡在多项目同时存在时不要执行，改由主控人工定位处理。",
    "2. 再读 live 输出确认卡死。",
    "3. 确认无误后执行下面这条指令：",
    "工具：pao_终止卡",
    \`参数：\${JSON.stringify(params)}\`,
    ...identityLines(card),
    "已知局限：pao_终止卡 现按卡号匹配本会话运行中 worker，不按项目/卡目录过滤；卡目录只用于回执落卡定位。同号多目标时本指令无法只终止本卡。",
    "执行后刷新看板核对；未执行前不要对外声称已终止。",
  ].join("\\n");
}`;
t = t.replace(old, next);
writeFileSync(cmd, t);

let s = readFileSync(spec, "utf8");
const oldSpec = `  const terminate = buildTerminateCommand(target);
  expect(terminate).toContain("pao_终止卡");
  expect(terminate).toContain('"卡目录":"D:/项目/.pao/卡"');
  expect(terminate).toContain("D:/项目/.pao/卡/卡0017-修复退出.md");
  expect(terminate).not.toContain("pao_改状态");`;
if (!s.includes(oldSpec)) throw new Error("终止断言不匹配");
s = s.replace(
  oldSpec,
  `  const terminate = buildTerminateCommand(target);
  expect(terminate).toContain("pao_终止卡");
  expect(terminate).toContain("pao_盘点");
  expect(terminate).toContain("卡号在本会话的运行中条目唯一");
  expect(terminate).toContain('"卡目录":"D:/项目/.pao/卡"');
  expect(terminate).toContain("D:/项目/.pao/卡/卡0017-修复退出.md");
  expect(terminate).toContain("不按项目/卡目录过滤");
  expect(terminate).not.toContain("pao_改状态");`,
);
writeFileSync(spec, s);
console.log("ok: 终止指令已写清工具局限");