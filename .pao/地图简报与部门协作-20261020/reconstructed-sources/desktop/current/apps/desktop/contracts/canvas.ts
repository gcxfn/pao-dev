/**
 * 工作流画布（只读，P4-2）契约：一次 IPC 拉取画布整页数据——配方库（含坏配方条目级
 * 错误）、工作流实例（清单字段＋按卡号现读的节点状态快照＋关联键会话锚点）、实例异常行。
 * 数据全部来自 PAO fork 的 readDesktopCanvas（P4-1 数据桥），桌面层只做整形，
 * 不重造解析、不落盘、不轮询、不缓存；实例清单永不反向成为任务真相。
 *
 * 整体状态二值：available（配方/实例/异常三段，段内坏条目显式上报不伪装空）
 * 与 unavailable（PAO home 缺失/不可达/数据桥加载失败，message 是可直接展示的原因）。
 */

/** 配方节点概要（画布 DAG 与节点详情的模板值来源）。 */
export interface CanvasReviewEdge {
  readonly target: string;
  readonly limit: number;
  readonly overflowAction: "停滞" | "修完这轮放行";
}

export interface CanvasParallelGroup {
  readonly id: string;
  readonly maxConcurrency?: number;
  readonly failurePolicy?: "fail_fast" | "allow_partial" | "any_success";
  readonly cancelPolicy?: "cancel_pending" | "drain_started";
}

export interface CanvasNodeTemplate {
  readonly name: string;
  readonly dept: string;
  readonly dependsOn: readonly string[];
  readonly requiresConfirmation: boolean;
  readonly model?: string;
  readonly thinkingLevel?: string;
  /** 只读并行/分支元数据；缺省表示旧配方未声明。 */
  readonly parallelGroupId?: string;
  readonly branchId?: string;
  readonly joinId?: string;
  /** 审核退回上游的可解释连线。 */
  readonly reviewEdges?: readonly CanvasReviewEdge[];
}

/** 配方精简摘要（画布左侧列表与 DAG 结构共用；向导批次复用同一契约）。 */
export interface CanvasRecipeSummary {
  readonly ui?: {
    readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  };
  readonly parallelGroups?: readonly CanvasParallelGroup[];
  readonly version: 1 | 2;
  readonly autoExecute: boolean;
  readonly params: readonly string[];
  readonly placeholders: readonly string[];
  readonly topoOrder: readonly string[];
  readonly nodes: readonly CanvasNodeTemplate[];
}

/** 配方条目：坏配方（校验失败/读失败）显错误不拖全页。 */
export type CanvasRecipeEntry =
  | { readonly name: string; readonly available: true; readonly recipe: CanvasRecipeSummary }
  | {
      readonly name: string;
      readonly available: false;
      readonly error: { readonly code: string; readonly detail: string };
    };

/** 实例节点：清单映射＋卡现读状态＋关联键会话锚点（卡状态为准，清单不作数）。 */
export interface CanvasNodeInstanceRow {
  readonly name: string;
  readonly cardRef?: string;
  readonly cards?: readonly {
    readonly cardRef: string;
    readonly status: string;
    readonly error?: string;
  }[];
  /** 节点现读状态；无卡＝no_card（S10 投影单域英文），卡缺失/损坏＝「读取异常」。 */
  readonly status: string;
  readonly suspended?: string;
  readonly confirmation?: string;
  /** 关联键：worker 会话标识（＝派发执行标识）。 */
  readonly sessionId?: string;
  readonly sessionPath?: string;
  readonly sessionState?: string;
  /** 冻结配方中的只读并行/分支元数据；旧实例缺省。 */
  readonly parallelGroupId?: string;
  readonly branchId?: string;
  readonly joinId?: string;
  /** 审核退回上游的可解释连线。 */
  readonly reviewEdges?: readonly CanvasReviewEdge[];
}

/** 画布实例：清单字段＋逐节点卡现读快照。 */
export interface CanvasInstanceRow {
  readonly frozenRecipe?: CanvasRecipeSummary;
  readonly frozenRecipeError?: string;
  readonly name: string;
  readonly path: string;
  readonly workflow: string;
  readonly cardDir: string;
  readonly startedAt: string;
  readonly status: string;
  readonly params: Readonly<Record<string, string>>;
  readonly nodes: readonly CanvasNodeInstanceRow[];
}

/** 实例异常行（坏清单/版本不识别/目录不可读——显式上报，不与「无实例」混同）。 */
export interface CanvasAnomalyRow {
  readonly path: string;
  readonly reason: string;
}

/**
 * 视图信封（S6-K4 冻结契约，桌面消费侧只透传与比对）：容器在内核视图顶层键「envelope」，
 * 四个英文字段名为冻结契约。指纹算法只在内核（pi-sdk-driver re-export 供给），桌面侧
 * 不自实现指纹；version 是传输/视图信息，不能替代卡状态（真相仍在卡与控制正本）。
 */
export interface CanvasViewEnvelope {
  /** 信封契约版本：字段结构变更才递增，消费方按此分派。 */
  readonly version: 1;
  /** 作用域代际：切会话/工作流即换值；事件代际≠当前基准＝旧作用域拒收。 */
  readonly sessionGeneration: string;
  /** 内容指纹：同代际下内容未变＝同值（不含时间字段），去重用。 */
  readonly revision: string;
  /** 本投影发布时间；每次投影都变，不参与指纹。 */
  readonly publishedAt: string;
}

export interface CanvasSnapshot {
  readonly state: "available";
  readonly recipes: readonly CanvasRecipeEntry[];
  readonly instances: readonly CanvasInstanceRow[];
  readonly anomalies: readonly CanvasAnomalyRow[];
  /** 配方目录整段不可读等顶层错误（配方段为空时说明原因）。 */
  readonly error?: string;
  /** 投影信封（S6-D2 透传）；旧内核 dist 无 envelope 键＝缺省，消费按「未知不拒」兜底。 */
  readonly envelope?: CanvasViewEnvelope;
}

export type CanvasUnavailableCode =
  "pao-home-missing" | "pao-home-unreachable" | "pao-home-not-directory" | "aggregates-unavailable";

export interface CanvasUnavailable {
  readonly state: "unavailable";
  readonly code: CanvasUnavailableCode;
  readonly message: string;
}

export type CanvasResult = CanvasSnapshot | CanvasUnavailable;

// ── D8d 节点详情（P4-4，只读深读） ──────────────────────────────────────────

/** 单次回执里的用量快照（事件流记录）；字段缺省＝该字段未记录，不补零。 */
export interface CanvasNodeUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cost?: number;
  readonly turns?: number;
  readonly toolCalls?: number;
  /** 事件流里未回 usage 的轮数；>0 时其余数字只是已知下界。 */
  readonly unknownRounds?: number;
}

/** 节点累计用量：只把回执真有的数字相加；缺失/未知时 partial＋note 明示下界。 */
export interface CanvasNodeUsageTotal extends CanvasNodeUsage {
  readonly attemptsWithUsage: number;
  readonly attemptsWithoutUsage: readonly number[];
  readonly attemptsWithUnknownRounds: readonly number[];
  readonly partial: boolean;
  /** 人话说明（缺失轮次/尝试号）；缺省＝全部回执都有完整用量。 */
  readonly note?: string;
}

/** 执行会话日志统计（readDesktopSessionIncrement 本段统计；complete=false 只读了前 1 MiB）。 */
export interface CanvasNodeSessionStats {
  readonly responses: number;
  readonly toolCalls: number;
  /** provider usage 行的 totalTokens 合计；unknownUsage>0 时是已知下界。 */
  readonly tokens: number;
  readonly unknownUsage: number;
  readonly complete: boolean;
  readonly nextOffset: number;
  readonly more: boolean;
}

/** 回执轮次行：两轮打回差异的原始记录，证据/产物/用量原样带出（不解析不推断）。 */
export interface CanvasNodeReceiptRound {
  readonly attempt: number;
  readonly time: string;
  readonly result?: string;
  readonly failureType?: string;
  readonly summary?: string;
  /** 回执声明的产物路径（输出产物）；缺省＝未记录。 */
  readonly artifacts?: readonly string[];
  readonly evidence?: readonly string[];
  /** 回执用量快照（含 cost/toolCalls/缺用量轮次）；缺省＝该次尝试未记用量。 */
  readonly usage?: CanvasNodeUsage;
  readonly worthRecording?: string;
  readonly archived?: string;
}

/** 执行会话锚点（节点→会话跳转数据源；execId＝worker 会话标识）。 */
export interface CanvasNodeExecutionRef {
  readonly execId: string;
  readonly status?: string;
  readonly sessionPath?: string;
  readonly time?: string;
  readonly source: string;
  /** 执行映射里的尝试号/当前尝试；卡回执补的锚点缺省。 */
  readonly attempt?: number;
  readonly current?: boolean;
  /** 会话日志统计；没有可读会话或缺省。 */
  readonly sessionStats?: CanvasNodeSessionStats;
  /** 会话统计读取失败原因（锚点本身仍可用）。 */
  readonly statsError?: string;
}

/** D8d 节点详情：模板值（实例参数代入后）vs 卡面实际值＋回执轮次＋执行锚点＋升档理由。 */
export interface CanvasNodeDetailData {
  readonly node: string;
  readonly instance: string;
  /** 配方模板值；配方不可读时缺省并带 error，不编造。 */
  readonly template?: {
    readonly dept: string;
    readonly model?: string;
    readonly tier?: string;
    readonly thinkingLevel?: string;
    readonly budget?: Readonly<Record<string, unknown>>;
    readonly skills?: readonly string[];
  };
  /** 卡面实际值；未落卡＝缺省（卡缺失/损坏记 error）。 */
  readonly card?: {
    readonly cardRef: string;
    readonly status: string;
    readonly tier?: string;
    readonly budget?: Readonly<Record<string, unknown>>;
    readonly attempts: number;
    readonly created: string;
    readonly completed?: string;
    readonly path: string;
    /** 卡面输入与验收口径（readDesktopProject 的 frontmatter 真值；缺省＝未记录）。 */
    readonly target?: string;
    readonly inputs?: readonly string[];
    readonly constraints?: string;
    readonly acceptance?: string;
    readonly dependsOn?: readonly string[];
    readonly owner?: string;
    /** 创建→完成秒数（与四指标账同口径）；完成未记录则不产出。 */
    readonly durationSeconds?: number;
    readonly receipts: readonly CanvasNodeReceiptRound[];
  };
  readonly executions: readonly CanvasNodeExecutionRef[];
  /** 回执用量累计；有卡且回了回执才产出，partial 明示已知下界。 */
  readonly usage?: CanvasNodeUsageTotal;
  /** 升档理由：卡正文记录行原样透出；缺省＝无记录（界面如实显示，不编造）。 */
  readonly tierNote?: string;
  /** 运行时数据桥读取失败说明（基础详情仍可用；缺省＝运行时数据已读到）。 */
  readonly runtimeError?: string;
  readonly error?: string;
}

export type CanvasNodeDetailResult =
  | { readonly state: "ok"; readonly detail: CanvasNodeDetailData }
  | { readonly state: "failed"; readonly message: string };

/** 节点详情选择子（D8d 深读与「查看卡」共用；主进程按它自行重解析路径，不信渲染层传路径）。 */
export interface CanvasNodeDetailInput {
  readonly instancePath: string;
  readonly nodeName: string;
  readonly cardRef?: string;
}

export type CanvasMutationResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string };
