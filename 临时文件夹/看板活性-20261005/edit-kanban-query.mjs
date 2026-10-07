import { readFileSync, writeFileSync } from "node:fs";
const src = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/electron/platform/pao/kanban-query.ts";
let text = readFileSync(src, "utf8");
const must = (needle) => {
  if (!text.includes(needle)) throw new Error("锚点不匹配: " + needle.slice(0, 40));
};

const importOld = 'import type { KanbanCard, KanbanCardStatus, KanbanResult } from "../../../contracts/kanban";';
must(importOld);
text = text.replace(
  importOld,
  'import type { KanbanCard, KanbanCardActivity, KanbanCardStatus, KanbanResult } from "../../../contracts/kanban";',
);

const countFn = `function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("卡号或尝试号无效。");
  return value;
}`;
must(countFn);
text = text.replace(
  countFn,
  countFn +
    `

function signed(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("尝试号无效。");
  return value;
}
function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("卡聚合布尔字段无效。");
  return value;
}
function normalizeActivity(row: Record<string, unknown>): KanbanCardActivity {
  return {
    owner: text(row.会话),
    executionId: text(row.执行标识),
    attempt: signed(row.尝试),
    registeredAt: text(row.登记时间),
    lastOutputAt: optionalText(row.最近输出时间),
    running: flag(row.运行中),
    silenceMinutes: count(row.静默分钟),
    current: flag(row.当前尝试),
  };
}`,
);

const projectHead = `    const projectPath = text(project.项目根);
    appendIssues(project.问题);
    const executions = list(project.执行).map(record);`;
must(projectHead);
text = text.replace(
  projectHead,
  `    const projectPath = text(project.项目根);
    appendIssues(project.问题);
    const activities = new Map<string, Record<string, unknown>>();
    // 旧构建产物可能还没有「活性」字段：缺省＝无信号，不把没有读成正常。
    if (project.活性 !== undefined) {
      for (const row of list(project.活性)) {
        const entry = record(row);
        if (typeof entry.卡路径 === "string") activities.set(entry.卡路径, entry);
      }
    }
    const executions = list(project.执行).map(record);`,
);

const pathLine = `      const path = text(card.路径);
      if (seen.has(path)) continue;`;
must(pathLine);
text = text.replace(
  pathLine,
  `      const path = text(card.路径);
      const activityRow = activities.get(path);
      if (seen.has(path)) continue;`,
);

const pushTail = `          executions: executions.filter((row) => row.卡路径 === path),
        });`;
must(pushTail);
text = text.replace(
  pushTail,
  `          executions: executions.filter((row) => row.卡路径 === path),
          activity: activityRow === undefined ? undefined : normalizeActivity(activityRow),
        });`,
);

writeFileSync(src, text);
console.log("ok: kanban-query.ts 已改");