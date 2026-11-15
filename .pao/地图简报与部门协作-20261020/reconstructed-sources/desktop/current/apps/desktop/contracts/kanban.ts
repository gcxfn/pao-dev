/** 看板状态来自卡现读；本契约不允许直接写状态。 */
export type KanbanCardStatus = "unclaimed" | "in_progress" | "delivered" | "failed" | "canceled";

/**
 * 卡当前尝试的 worker 活性（同进程只读）。
 * 缺省＝没有信号——看板要显式提示，不能用卡的创建时间兜底成「正常」。
 */
export interface KanbanCardActivity {
  /** 派出 worker 的桌面会话（owner）。 */
  readonly owner: string;
  /** 执行标识；登记条目没记时为空串。 */
  readonly executionId: string;
  /** 登记条目的尝试号（-1＝登记时未记）。 */
  readonly attempt: number;
  readonly registeredAt: string;
  /** 最近一次 stdout/stderr 输出时间；缺省＝登记以来没有任何输出。 */
  readonly lastOutputAt?: string;
  readonly running: boolean;
  /** 静默阈值（分钟；0＝预警已关）。 */
  readonly silenceMinutes: number;
  /** 登记条目的尝试号是否等于卡面当前尝试。 */
  readonly current: boolean;
  /**
   * 认领租约四字段（S5 包3 透传占位；内核 DesktopCardActivity 已带）。
   * 旧构建产物/旧登记没有这些字段＝unknown，不编造；amber/red 完整呈现归 S7-B。
   */
  readonly claimAt?: string;
  readonly leaseExpiresAt?: string;
  readonly claimGeneration?: number;
  readonly takenOver?: boolean;
}

export interface KanbanCard {
  readonly path: string;
  readonly project: string;
  readonly number: number;
  readonly goal: string;
  readonly department: string;
  readonly status: KanbanCardStatus;
  readonly acceptance: string;
  readonly constraints?: string;
  readonly inputs: readonly string[];
  readonly dependencies: readonly string[];
  readonly parent?: string;
  readonly owner?: string;
  readonly tier?: string;
  readonly budget?: Readonly<Record<string, unknown>>;
  readonly priority: string;
  readonly attempts: number;
  readonly created: string;
  readonly completed?: string;
  readonly body: string;
  readonly receipts: readonly Readonly<Record<string, unknown>>[];
  readonly executions: readonly Readonly<Record<string, unknown>>[];
  /** 当前尝试的 worker 活性；缺省＝无信号。 */
  readonly activity?: KanbanCardActivity;
}

/**
 * 工作流节点的卡映射（内核 readDesktopFlows 已送达，看板侧消费）：
 * 卡号引用格式冻结为「卡NNNN」（内核 formatCardNumber），在此目录内按卡号联接卡。
 */
export interface KanbanWorkflowNode {
  readonly name: string;
  readonly title?: string;
  readonly round: number;
  /** 该工作流的卡目录（卡号在此目录内唯一，可与项目内 .pao/卡 同号不冲突）。 */
  readonly cardsDir: string;
  readonly cardRefs: readonly string[];
  readonly department?: string;
  readonly ministerSessionId?: string;
  readonly status?: string;
  readonly hold?: string;
  readonly historicalCardRefs?: readonly string[];
}

/** 一条工作流实例（只读投影）：节点→卡号映射全量列出，多卡节点不截断到首卡。 */
export interface KanbanWorkflow {
  readonly path: string;
  readonly project: string;
  readonly instance: string;
  readonly workflow: string;
  readonly status: string;
  readonly ownerSessionId?: string;
  readonly nodes: readonly KanbanWorkflowNode[];
}

/** 只读执行会话：提交已发现的身份，不能指定磁盘路径。 */
export type WorkboardSessionInput = { readonly workspaceId: string; readonly offset?: number } & (
  | { readonly kind: "worker"; readonly executionId: string }
  | {
      readonly kind: "minister";
      readonly instanceId: string;
      readonly nodeName: string;
      readonly round: number;
    }
);

export type WorkboardSessionResult =
  | {
      readonly state: "ok";
      readonly nextOffset: number;
      readonly more: boolean;
      readonly incomplete: boolean;
      readonly lines: readonly {
        readonly type: string;
        readonly role?: string;
        readonly content?: unknown;
        readonly model?: string;
      }[];
    }
  | { readonly state: "failed"; readonly message: string };

export type KanbanResult =
  | {
      readonly state: "available";
      readonly cards: readonly KanbanCard[];
      readonly issues: readonly { readonly path: string; readonly message: string }[];
      /** 已送达的工作流实例投影；无工作流或旧构建产物缺字段时为空数组。 */
      readonly workflows: readonly KanbanWorkflow[];
    }
  | { readonly state: "unavailable"; readonly message: string };

/**
 * 看板卡操作（S7-B 操作桥）：桌面只代「用户」执行取消这一个动作。
 * 完成必须走验收链（卡协议），认领/重试要求 owner 身份——都不是桌面动作，
 * 不进本联合类型；内核状态机（迁移白名单＋单写者）是唯一权限判据。
 */
export const KANBAN_CARD_ACTIONS = ["取消"] as const;
export type KanbanCardAction = (typeof KANBAN_CARD_ACTIONS)[number];

/** 卡操作入参：只提交身份（workspace）与意图；卡路径主进程按工作区复核，不裸信。 */
export interface KanbanCardOpInput {
  readonly workspaceId: string;
  /** 看板现读卡路径；主进程复核在项目内＋文件名卡号与 cardNumber 一致后才读卡。 */
  readonly cardPath: string;
  readonly cardNumber: number;
  readonly action: KanbanCardAction;
  /** 取消依据，落卡审计区；可省略。 */
  readonly reason?: string;
}

/** 单卡操作结果：成败与原因逐卡如实返回，调用方不得把一张成功扩大成整批成功。 */
export type KanbanCardOpResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string };
