/**
 * PAO 工作流画布只读出口（桌面 P4-2）：把 fork 的 readDesktopCanvas（P4-1 数据桥）
 * 收拢成一个加载点，桌面壳一次 IPC 拉取画布整页数据（配方库＋实例＋异常行），
 * 不在桌面层重造解析。
 *
 * readDesktopCanvas 未列入 fork 包入口 exports，只能按构建产物的真实路径深引——
 * 从 ./pao 入口的落盘位置反推 dist/pao 目录，再以 file URL 动态 import
 * dist/pao/desktop/canvas.js（与 pao-workboard 的 status 深引同模式），
 * 绝不引 fork 源码、不写任何文件、不缓存数据。readDesktopPreflight 预检桥
 * 留给向导批次（P4-3），此处不加载。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** fork canvas.ts 的配方节点概要（包入口未导出类型，此处按结构声明）。 */
export interface PaoCanvasReviewEdge {
  readonly target: string;
  readonly limit: number;
  readonly overflowAction: "停滞" | "修完这轮放行";
}

export interface PaoCanvasParallelGroup {
  readonly id: string;
  readonly maxConcurrency?: number;
  readonly failurePolicy?: "fail_fast" | "allow_partial" | "any_success";
  readonly cancelPolicy?: "cancel_pending" | "drain_started";
}

export interface PaoCanvasNodeSummary {
  readonly 名字: string;
  readonly 部门: string;
  readonly depends_on: readonly string[];
  readonly 人工确认: boolean;
  readonly 模型?: string;
  readonly 思考强度?: string;
  readonly parallelGroupId?: string;
  readonly branchId?: string;
  readonly joinId?: string;
  readonly reviewEdges?: readonly PaoCanvasReviewEdge[];
}

/** fork canvas.ts 的配方精简摘要（画布 DAG 与向导共用）。 */
export interface PaoCanvasRecipeSummary {
  readonly ui?: {
    readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  };
  readonly parallelGroups?: readonly PaoCanvasParallelGroup[];
  readonly 版本: 1 | 2;
  readonly 自动执行: boolean;
  readonly 参数: readonly string[];
  readonly 占位符: readonly string[];
  readonly 拓扑序: readonly string[];
  readonly 节点: readonly PaoCanvasNodeSummary[];
}

/** fork canvas.ts 的配方条目：坏配方显错误不拖全页。 */
export type PaoCanvasRecipeEntry =
  | { readonly 名字: string; readonly 可用: true; readonly 配方: PaoCanvasRecipeSummary }
  | {
      readonly 名字: string;
      readonly 可用: false;
      readonly 错误: { readonly 代码: string; readonly 说明: string };
    };

/** fork canvas.ts 的实例节点：清单映射＋卡现读状态＋关联键会话锚点。 */
export interface PaoCanvasNodeInstance {
  readonly 名字: string;
  readonly 卡号?: string;
  readonly 卡列表?: readonly {
    readonly 卡号: string;
    readonly 状态: string;
    readonly 错误?: string;
  }[];
  readonly 状态: string;
  readonly 挂起?: string;
  readonly 确认?: string;
  readonly 会话标识?: string;
  readonly 会话路径?: string;
  readonly 会话状态?: string;
  readonly parallelGroupId?: string;
  readonly branchId?: string;
  readonly joinId?: string;
  readonly reviewEdges?: readonly PaoCanvasReviewEdge[];
}

/** fork canvas.ts 的画布实例：清单字段＋逐节点卡现读快照。 */
export interface PaoCanvasInstance {
  readonly frozenRecipe?: PaoCanvasRecipeSummary;
  readonly frozenRecipeError?: string;
  readonly 名字: string;
  readonly 路径: string;
  readonly 工作流: string;
  readonly 卡目录: string;
  readonly 启动: string;
  readonly 状态: string;
  readonly 参数: Readonly<Record<string, string>>;
  readonly 节点: readonly PaoCanvasNodeInstance[];
}

/** fork canvas.ts 的画布整页视图（中文键，redact 后直返）。 */
export interface PaoCanvasView {
  readonly 配方: readonly PaoCanvasRecipeEntry[];
  readonly 实例: readonly PaoCanvasInstance[];
  readonly 异常: readonly { readonly 路径: string; readonly 原因: string }[];
  readonly 错误?: string;
}

/** fork readDesktopCanvas 的纯读签名（同步聚合）。 */
export type PaoDesktopCanvasReader = (paoHome: string) => PaoCanvasView;

/** fork canvas.ts 的 D8d 回执轮次行（中文键，redact 后直返）。 */
export interface PaoNodeReceiptRound {
  readonly 尝试号: number;
  readonly 时间: string;
  readonly 结果?: string;
  readonly 失败类型?: string;
  readonly 摘要?: string;
  readonly 证据?: readonly string[];
  readonly 留档标记?: string;
}

/** fork canvas.ts 的执行锚点（与画布实例节点同源，中文键）。 */
export interface PaoNodeExecutionRef {
  readonly 执行标识: string;
  readonly 映射状态?: string;
  readonly 会话路径?: string;
  readonly 时间?: string;
  readonly 来源: string;
}

/** fork canvas.ts 的 D8d 节点详情（中文键，redact 后直返）。 */
export interface PaoNodeDetail {
  readonly 节点: string;
  readonly 实例: string;
  readonly 模板?: {
    readonly 部门: string;
    readonly 模型?: string;
    readonly 档位?: string;
    readonly 思考强度?: string;
    readonly 预算?: Readonly<Record<string, unknown>>;
    readonly 技能?: readonly string[];
  };
  readonly 卡?: {
    readonly 卡号: string;
    readonly 状态: string;
    readonly 档位?: string;
    readonly 预算?: Readonly<Record<string, unknown>>;
    readonly 尝试: number;
    readonly 创建: string;
    readonly 完成?: string;
    readonly 路径: string;
    readonly 回执: readonly PaoNodeReceiptRound[];
  };
  readonly 执行: readonly PaoNodeExecutionRef[];
  readonly 升档理由?: string;
  readonly 错误?: string;
}

/** fork readDesktopNodeDetail 的纯读签名（同步聚合）。 */
export type PaoDesktopNodeDetailReader = (
  paoHome: string,
  instancePath: string,
  nodeName: string,
  cardRef?: string,
) => PaoNodeDetail;

/** 动态加载 fork 构建产物里的 readDesktopCanvas；加载失败抛错，由调用方降级为不可用。 */
export async function loadPaoDesktopCanvas(): Promise<PaoDesktopCanvasReader> {
  const resolve = (import.meta as ImportMeta & { resolve?: (specifier: string) => string }).resolve;
  if (typeof resolve !== "function") {
    throw new Error("import.meta.resolve is unavailable in this runtime.");
  }
  const paoEntryPath = fileURLToPath(resolve("@earendil-works/pi-coding-agent/pao"));
  // ./pao 入口（dist/pao/index.js）所在目录即 fork 构建产物的 dist/pao。
  const forkPaoDistDir = dirname(paoEntryPath);
  const module = (await import(
    pathToFileURL(join(forkPaoDistDir, "desktop", "canvas.js")).href
  )) as {
    readDesktopCanvas?: PaoDesktopCanvasReader;
  };
  if (typeof module.readDesktopCanvas !== "function") {
    throw new Error("readDesktopCanvas is not available in the PAO build products.");
  }
  return module.readDesktopCanvas;
}

/** 动态加载 D8d 节点详情深读（与 loadPaoDesktopCanvas 同一模块，同一深引模式）。 */
export async function loadPaoDesktopNodeDetail(): Promise<PaoDesktopNodeDetailReader> {
  const resolve = (import.meta as ImportMeta & { resolve?: (specifier: string) => string }).resolve;
  if (typeof resolve !== "function") {
    throw new Error("import.meta.resolve is unavailable in this runtime.");
  }
  const paoEntryPath = fileURLToPath(resolve("@earendil-works/pi-coding-agent/pao"));
  const forkPaoDistDir = dirname(paoEntryPath);
  const module = (await import(
    pathToFileURL(join(forkPaoDistDir, "desktop", "canvas.js")).href
  )) as {
    readDesktopNodeDetail?: PaoDesktopNodeDetailReader;
  };
  if (typeof module.readDesktopNodeDetail !== "function") {
    throw new Error("readDesktopNodeDetail is not available in the PAO build products.");
  }
  return module.readDesktopNodeDetail;
}

// ── 运行态数据桥（read-model.js）：卡面全文/执行映射/会话增量 ────────────────
// 节点详情深读只带模板值与回执子集；输入、产物路径、用量、执行映射的尝试号与会话
// 统计在 readDesktopProject / readDesktopSessionIncrement 里已有，桌面侧按需组合。
// 这里只声明结构，不重造解析；readDesktopSessionIncrement 的路径必须来自 readDesktopProject
// 已校验的 executions[].会话路径，绝不接收渲染层路径。

/** fork ParsedCard.frontmatter（S9 迁移后英文键）：只声明桌面运行态会读的键，其余不猜。 */
export interface PaoCardFrontmatter {
  readonly goal: string;
  readonly dept: string;
  readonly inputs?: readonly string[];
  readonly constraints?: string;
  readonly acceptance: string;
  readonly depends_on?: readonly string[];
  readonly parent?: string;
  readonly tier?: string;
  readonly budget?: Readonly<Record<string, unknown>>;
  readonly priority?: string;
  readonly owner?: string;
  readonly attempt: number;
  readonly created: string;
  readonly completed?: string;
  readonly status: string;
}

/** fork Receipt（S9 迁移后英文键）：用量是事件流快照（自由 Record，缺＝未记录）。 */
export interface PaoCardReceipt {
  readonly card_no: number;
  readonly attempt: number;
  readonly time: string;
  readonly result?: string;
  readonly summary?: string;
  readonly artifact_path?: readonly string[];
  readonly evidence?: readonly string[];
  readonly usage?: Readonly<Record<string, unknown>>;
  readonly worth_distilling?: string;
  readonly failure_type?: string;
  readonly archive_flag?: string;
}

/** fork ParsedCard（S9 迁移后英文键）：卡面真值（来源 readDesktopProject；只读不改写）。 */
export interface PaoDesktopCard {
  readonly path: string;
  readonly filename: string;
  readonly card_no: number;
  readonly frontmatter: PaoCardFrontmatter;
  readonly body: string;
  readonly receipts: readonly PaoCardReceipt[];
}

/** fork DesktopExecution：执行映射最近一条（含尝试号/当前尝试/会话路径）。 */
export interface PaoDesktopExecution {
  readonly 执行标识: string;
  readonly 卡路径: string;
  readonly 尝试: number;
  readonly 状态: string;
  readonly 时间: string;
  readonly 映射路径: string;
  readonly 会话路径?: string;
  readonly 当前尝试: boolean;
}

/** fork DesktopSessionIncrement：会话 JSONL 增量与本段统计（token 来自 usage 行）。 */
export interface PaoDesktopSessionIncrement {
  readonly 会话路径: string;
  readonly 下次偏移: number;
  readonly 末行未完: boolean;
  readonly 还有更多: boolean;
  readonly 行: readonly Readonly<Record<string, unknown>>[];
  readonly 本段统计: {
    readonly 响应: number;
    readonly 工具: number;
    readonly token: number;
    readonly 未知用量: number;
  };
}

/** fork DesktopProjectSnapshot（§10 收口批容器键迁英）：只声明桌面运行态聚合要用的三段。 */
export interface PaoDesktopProjectSnapshot {
  readonly projectRoot: string;
  readonly cards: readonly PaoDesktopCard[];
  readonly execution: readonly PaoDesktopExecution[];
  readonly issues: readonly { readonly 路径: string; readonly 说明: string }[];
}

/** 运行态只读桥：项目聚合（卡＋执行映射）与会话增量（token 统计）。 */
export interface PaoDesktopRuntimeReader {
  readonly readDesktopProject: (
    projectRoot: string,
    sessionId: string,
  ) => PaoDesktopProjectSnapshot;
  readonly readDesktopSessionIncrement: (
    path: string,
    offset?: number,
  ) => PaoDesktopSessionIncrement;
}

/** 动态加载运行态只读桥（read-model.js，与 canvas.js 同 dist/pao/desktop）。 */
export async function loadPaoDesktopRuntimeReader(): Promise<PaoDesktopRuntimeReader> {
  const resolve = (import.meta as ImportMeta & { resolve?: (specifier: string) => string }).resolve;
  if (typeof resolve !== "function") {
    throw new Error("import.meta.resolve is unavailable in this runtime.");
  }
  const paoEntryPath = fileURLToPath(resolve("@earendil-works/pi-coding-agent/pao"));
  const forkPaoDistDir = dirname(paoEntryPath);
  const module = (await import(
    pathToFileURL(join(forkPaoDistDir, "desktop", "read-model.js")).href
  )) as Partial<PaoDesktopRuntimeReader>;
  for (const key of ["readDesktopProject", "readDesktopSessionIncrement"] as const) {
    if (typeof module[key] !== "function") {
      throw new Error(`PAO desktop read model is missing ${key} in the build products.`);
    }
  }
  return module as PaoDesktopRuntimeReader;
}
