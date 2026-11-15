import { loadDriver } from "./bridge-common";
import type { PaoKanbanReader } from "@pi-gui/pi-sdk-driver";
import type {
  KanbanCard,
  KanbanCardActivity,
  KanbanCardStatus,
  KanbanResult,
  KanbanWorkflow,
} from "../../../contracts/kanban";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("卡聚合记录不是对象。");
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("卡聚合列表字段缺失。");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("卡聚合文本字段无效。");
  return value;
}
function optionalText(value: unknown): string | undefined {
  return value === undefined ? undefined : text(value);
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("卡号或尝试号无效。");
  return value;
}

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
    // S5 包3 租约四字段透传占位：旧构建产物/旧登记没有＝undefined（unknown），不编造。
    claimAt: optionalText(row.认领时间),
    leaseExpiresAt: optionalText(row.租约到期),
    claimGeneration: row.认领代数 === undefined ? undefined : signed(row.认领代数),
    takenOver: row.被接管 === undefined ? undefined : flag(row.被接管),
  };
}

export function normalizeKanban(value: unknown): KanbanResult {
  const root = record(value);
  const cards: KanbanCard[] = [];
  const workflows: KanbanWorkflow[] = [];
  const issues: { path: string; message: string }[] = [];
  const appendIssues = (value: unknown) => {
    for (const row of list(value)) {
      const item = record(row);
      issues.push({ path: text(item.路径), message: text(item.说明) });
    }
  };
  appendIssues(root.issues);
  const seen = new Set<string>();
  for (const item of list(root.projects)) {
    const project = record(item);
    const projectPath = text(project.projectRoot);
    appendIssues(project.issues);
    // 工作流节点→卡号映射（路径 b）：内核已校验工作流形状，坏形状只落问题不拖卡。
    // 旧构建产物可能没有「workflow」字段：缺省＝空数组。
    for (const entry of project.workflow === undefined ? [] : list(project.workflow)) {
      let flowPath = projectPath;
      try {
        const flow = record(entry);
        if (typeof flow.路径 === "string") flowPath = flow.路径;
        const control = record(flow.控制);
        workflows.push({
          path: flowPath,
          project: projectPath,
          instance: text(control.实例),
          workflow: text(control.工作流),
          status: text(control.状态),
          nodes: list(control.节点).map((entry) => {
            const node = record(entry);
            return {
              name: text(node.名字),
              round: count(node.轮次),
              cardsDir: text(control.卡目录),
              cardRefs: list(node.卡).map(text),
            };
          }),
        });
      } catch (error) {
        issues.push({
          path: flowPath,
          message: `工作流字段无效：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const activities = new Map<string, Record<string, unknown>>();
    /** 认领代数（S5 包3）：缺失（旧构建产物/旧登记）视为最低，只在无代数行之间保持后到者。 */
    const generationOf = (row: Record<string, unknown>): number =>
      typeof row.认领代数 === "number" && Number.isSafeInteger(row.认领代数) ? row.认领代数 : -1;
    // 显式接管后旧 worker 活性行不得覆盖新代呈现：同卡多行按认领代数取最大，
    // 同代保持后到者（多 worker 同代重试的既有口径）；低代行后到也不赢。
    if (project.liveness !== undefined) {
      for (const row of list(project.liveness)) {
        const entry = record(row);
        if (typeof entry.卡路径 !== "string") continue;
        const existing = activities.get(entry.卡路径);
        if (existing === undefined || generationOf(entry) >= generationOf(existing)) {
          activities.set(entry.卡路径, entry);
        }
      }
    }
    const executions = list(project.execution).map(record);
    for (const item of list(project.cards)) {
      const card = record(item);
      const path = text(card.path);
      const activityRow = activities.get(path);
      if (seen.has(path)) continue;
      try {
        const fields = record(card.frontmatter);
        const status = text(fields.status);
        // 状态字面量单源＝内核 CARD_STATUSES（cards/types.ts，./pao 的 require 出口已补，
        // 主进程 require(esm) 车道实测可通）。但 playwright 单测把内核文件按 CJS 转译
        // （经符号链接的真实路径不在 node_modules 下），内核图第二跳兄弟工作区包
        // （pi-ai/pi-agent-core/pi-mcp）exports 仍只有 import 条件，require 解析报
        // No "exports" main defined——单测车道仍消费不到，维持本地字面量
        // （S11-导出面微批实测，证据/接线-kanban-query.log）。
        if (!["unclaimed", "in_progress", "delivered", "failed", "canceled"].includes(status))
          throw new Error(`未知卡状态：${status}`);
        let activity: KanbanCardActivity | undefined;
        if (activityRow !== undefined) {
          try {
            activity = normalizeActivity(activityRow);
          } catch (error) {
            // 坏活性行不拖掉整张卡：照常显示卡，但把无信号原因登记成问题。
            issues.push({
              path,
              message: `活性字段无效：${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
        cards.push({
          path,
          project: projectPath,
          number: count(card.card_no),
          goal: text(fields.goal),
          department: text(fields.dept),
          status: status as KanbanCardStatus,
          acceptance: text(fields.acceptance),
          constraints: optionalText(fields.constraints),
          inputs: fields.inputs === undefined ? [] : list(fields.inputs).map(text),
          dependencies: fields.depends_on === undefined ? [] : list(fields.depends_on).map(text),
          parent: optionalText(fields.parent),
          owner: optionalText(fields.owner),
          tier: optionalText(fields.tier),
          budget: fields.budget === undefined ? undefined : record(fields.budget),
          priority: optionalText(fields.priority) ?? "medium",
          attempts: count(fields.attempt),
          created: text(fields.created),
          completed: optionalText(fields.completed),
          body: text(card.body),
          receipts: list(card.receipts).map(record),
          executions: executions.filter((row) => row.卡路径 === path),
          activity,
        });
        seen.add(path);
      } catch (error) {
        issues.push({ path, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { state: "available", cards, workflows, issues };
}

/** project 只能由主进程根据已登记 workspaceId 解析，不能接浏览器任意路径。 */
export function createKanbanQuery(
  options: { readonly loadReader?: () => Promise<PaoKanbanReader> } = {},
) {
  return {
    async collect(home: string, project: string): Promise<KanbanResult> {
      if (!home.trim()) return { state: "unavailable", message: "请先配置 PAO 数据目录。" };
      try {
        const reader = options.loadReader
          ? await options.loadReader()
          : await (
              await loadDriver("loadPaoKanbanReader")
            )();
        return normalizeKanban(reader(home, project));
      } catch (error) {
        return {
          state: "unavailable",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
