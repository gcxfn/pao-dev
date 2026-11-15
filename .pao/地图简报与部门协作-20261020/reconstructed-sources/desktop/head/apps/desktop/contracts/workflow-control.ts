/**
 * 运行控制契约（P5，窄接口）：身份只读查询＋三类人工动作。
 *
 * 真值来源是 PAO fork 的控制清单（工作流实例-<配方名>.md）经 readDesktopFlows 的投影：
 * 节点行来自 controlReport（卡现读状态、人工确认门、当前轮次、挂起原因），
 * 不是渲染层缓存，也不是桌面重造的解析。
 *
 * 动作名与 fork 的 pao_control_node 协议一致，只放行内核真的支持且本批次需要的三种：
 * - 确认：放行人工确认门（内核会再核对节点确实处于等待确认且卡已交付）；
 * - 暂停：暂停推进——只写入控制清单的挂起原因（理由必填，内核侧同样要求），
 *   挡住后续节点的启动；不会停掉已在跑的 worker 进程或已认领的在途卡；
 * - 恢复：显式人工恢复（现场核查说明必填，内核侧同样要求）；若仍有在途卡，内核会拒绝。
 * 桌面桥没有「停止实例」入口，本批次也不造这个语义。
 * 「裁定」在三态结果之外还要引用证据，不在本批次范围，故不在联合类型里出现。
 *
 * 渲染层只提交身份与意图（workspace/session/实例/节点/轮次/动作/理由）；
 * 配方名、卡目录与原 owner 一律由主进程从磁盘真值填充，不接受渲染层提供。
 */

/** 放行动作；与内核动作字面量同源，增速即此处与内核不一致时为显式错误。 */
export const WORKFLOW_CONTROL_ACTIONS = ["confirm", "pause", "resume"] as const;

export type WorkflowControlAction = (typeof WORKFLOW_CONTROL_ACTIONS)[number];

/** 界面展示文案：动作值保持内核协议值；暂停必须写成「暂停推进」，不得写成停止实例。 */
export const WORKFLOW_CONTROL_ACTION_LABELS: Record<WorkflowControlAction, string> = {
  confirm: "确认放行",
  pause: "暂停推进",
  resume: "人工恢复",
};

/** 控制清单里的一个节点：内核 controlReport 的投影（中文含义，英文键）。 */
export interface WorkflowControlNodeRow {
  readonly name: string;
  /** 当前轮次；动作必须带同一轮次，过期即拒绝。 */
  readonly round: number;
  /** 配方声明的人工确认门。 */
  readonly requiresConfirmation: boolean;
  /** 已确认时间戳；缺省＝该轮尚未确认。 */
  readonly confirmed?: string;
  /** 挂起说明（等待前置/等待部长/等待判定/等待人工确认等）；暂停推进时这里也是流级暂停原因。 */
  readonly hold?: string;
  /** 节点现读状态（controlView 投影单域英文，S10）：delivered/in_progress/no_card/failed/canceled，另有 v1 本地态「读取异常」。 */
  readonly status: string;
}

/** 控制身份：UI 据它显示节点与是否可动作；ownerSessionId 是动作要回的会话。 */
export interface WorkflowControlIdentity {
  readonly instanceId: string;
  readonly ownerSessionId: string;
  readonly recipeName: string;
  readonly cardDir: string;
  /** 控制清单文件路径（工作流实例-<配方名>.md）。 */
  readonly path: string;
  /** controlReport 的流级状态：运行中/挂起/已完成；挂起也可能来自卡失败或等待裁定。 */
  readonly status: string;
  /** 人工暂停推进的原因；有值＝暂停中。其他原因挂起不会写这里，避免与暂停混淆。 */
  readonly pauseReason?: string;
  readonly nodes: readonly WorkflowControlNodeRow[];
}

/**
 * 只读查询入参：实例名＝配方名；同一配方可同时存在多个实例（内核每次启动生成独立工作目录），
 * 这时必须带 instancePath 精确定位。路径只与磁盘发现行做规范化比较，不按它读盘。
 */
export interface WorkflowControlQueryInput {
  readonly workspaceId: string;
  readonly instanceName: string;
  /**
   * 实例清单绝对路径（画布实例行的 path）；同名多实例时用它精确选择。
   * 缺省＝仅当当前项目内同名实例唯一时可用，多匹配直接拒绝，不猜。
   */
  readonly instancePath?: string;
}

/** 动作入参：只提交身份与意图，配方名/卡目录/原 owner 由主进程填真值。 */
export interface WorkflowControlCommandInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly nodeName: string;
  readonly round: number;
  readonly action: WorkflowControlAction;
  /** 暂停的挂起原因／恢复的现场核查说明（两者必填）；确认时可省略。 */
  readonly reason?: string;
}

export type WorkflowControlResult =
  | { readonly state: "ok"; readonly control: WorkflowControlIdentity }
  | { readonly state: "failed"; readonly message: string };

export type WorkflowControlCommandResult =
  | { readonly state: "ok" }
  | { readonly state: "error"; readonly message: string };
