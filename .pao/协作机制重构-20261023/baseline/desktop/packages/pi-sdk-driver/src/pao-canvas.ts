/**
 * PAO 工作流画布只读出口（桌面 P4-2）：把 fork 的 readDesktopCanvas（P4-1 数据桥）
 * 收拢成一个加载点，桌面壳一次 IPC 拉取画布整页数据（配方库＋实例＋异常行），
 * 不在桌面层重造解析。
 *
 * 画布与运行态读取都经公开的 pao/desktop 入口加载；Node 原生 ESM 缓存复用同一模块
 * 实例，因而保留 owner 表；驱动包不反推内部构建目录，也不再维护第二层 Promise 缓存。
 * 这里不写任何文件，也不缓存读取结果。
 * readDesktopPreflight 预检桥留给向导批次（P4-3），此处不加载。
 */
import { loadPaoDesktopModule } from "./pao-desktop-module.js";

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

/** fork readDesktopCanvasFresh 的纯读签名（读取异步并核对当前内容树）。 */
export type PaoDesktopCanvasReader = (paoHome: string) => Promise<PaoCanvasView>;

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
  const module = await loadPaoDesktopModule();
  if (typeof module.readDesktopCanvasFresh !== "function") {
    throw new Error("PAO 构建产物缺少画布入口 readDesktopCanvasFresh。");
  }
  return module.readDesktopCanvasFresh as unknown as PaoDesktopCanvasReader;
}

/** 动态加载 D8d 节点详情深读（与 loadPaoDesktopCanvas 同一公开模块）。 */
export async function loadPaoDesktopNodeDetail(): Promise<PaoDesktopNodeDetailReader> {
  const module = await loadPaoDesktopModule();
  if (typeof module.readDesktopNodeDetail !== "function") {
    throw new Error("PAO 构建产物缺少节点详情入口 readDesktopNodeDetail。");
  }
  return module.readDesktopNodeDetail as unknown as PaoDesktopNodeDetailReader;
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
  ) => Promise<PaoDesktopProjectSnapshot>;
  readonly readDesktopSessionIncrement: (
    path: string,
    offset?: number,
  ) => PaoDesktopSessionIncrement;
}

/** 动态加载运行态只读桥（与 canvas.js 同属公开 pao/desktop 入口）。 */
export async function loadPaoDesktopRuntimeReader(): Promise<PaoDesktopRuntimeReader> {
  const module = await loadPaoDesktopModule();
  const { readDesktopProjectFresh, readDesktopSessionIncrement } = module;
  if (
    typeof readDesktopProjectFresh !== "function" ||
    typeof readDesktopSessionIncrement !== "function"
  ) {
    if (typeof readDesktopProjectFresh !== "function") {
      throw new Error("PAO 构建产物缺少运行态入口 readDesktopProjectFresh。");
    }
    throw new Error("PAO 构建产物缺少运行态入口 readDesktopSessionIncrement。");
  }
  // 公开类型保留历史最小投影；真实内核函数接受完整卡/执行结构并返回更丰富字段。
  // 两者已在项目快照和会话增量的真实读取流程中核对，断言只发生在这一加载边界。
  return {
    readDesktopProject: readDesktopProjectFresh,
    readDesktopSessionIncrement,
  } as unknown as PaoDesktopRuntimeReader;
}
