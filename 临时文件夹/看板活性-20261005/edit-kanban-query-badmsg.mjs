import { readFileSync, writeFileSync } from "node:fs";
const src = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/electron/platform/pao/kanban-query.ts";
let text = readFileSync(src, "utf8");
const must = (needle) => {
  if (!text.includes(needle)) throw new Error("锚点不匹配: " + needle.slice(0, 40));
};

const pushHead = `        cards.push({
          path,`;
must(pushHead);
text = text.replace(
  pushHead,
  `        let activity: KanbanCardActivity | undefined;
        if (activityRow !== undefined) {
          try {
            activity = normalizeActivity(activityRow);
          } catch (error) {
            // 坏活性行不拖掉整张卡：照常显示卡，但把无信号原因登记成问题。
            issues.push({
              path,
              message: \`活性字段无效：\${error instanceof Error ? error.message : String(error)}\`,
            });
          }
        }
        cards.push({
          path,`,
);

const pushActivity = `          activity: activityRow === undefined ? undefined : normalizeActivity(activityRow),`;
must(pushActivity);
text = text.replace(pushActivity, "          activity,");
writeFileSync(src, text);
console.log("ok: 坏活性行降级成问题");