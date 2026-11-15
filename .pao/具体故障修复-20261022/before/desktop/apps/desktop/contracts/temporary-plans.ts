/**
 * 临时计划契约（通用工作台阶段 4，只读窄接口）。
 *
 * 真值来源是 PAO fork 的临时计划投影（readDesktopPlans）：定义读
 * `<项目>/.pao/临时工作流/<计划ID>/计划.md`，启动关联读同目录 `启动/<启动请求ID>.md`，
 * 实例状态向控制正本核一次。桌面不重造解析，也不缓存。
 *
 * 本契约只有查询：创建/修改/撤销/启动/保存模板一律由主控经内核工具发起，
 * 桌面不提供「创建临时工作流」按钮，也不收渲染层提供的磁盘路径。
 */

/**
 * 一步的预算对象（§6.1 费用/待办：原生声明式预算，不是实耗）。四项都可缺：
 * **没设就是 `undefined`，界面不许填 0**——0 轮上限与「没配预算」是两件事。
 * 展开显示时每项要带单位（轮次／次／费用／协作额度），且只是上限声明，不是费用授权。
 */
export interface TemporaryPlanBudgetRow {
  /** 模型轮次上限。 */
  readonly turns?: number;
  /** 工具调用次数上限。 */
  readonly toolCalls?: number;
  /** 费用上限。 */
  readonly cost?: number;
  /** 协作额度（原协作配额）。 */
  readonly collabQuota?: number;
}

/** 审核退回边：回到哪个上游步骤、上限几轮、超限怎么办（原文照抄内核配方字段）。 */
export interface TemporaryPlanBackEdgeRow {
  readonly target: string;
  readonly maxRounds: number;
  readonly overLimitAction: string;
}

/** 计划里一个步骤：步骤 ID 是稳定身份（改标题不动 ID，意见对象因此不丢）。 */
export interface TemporaryPlanStepRow {
  readonly stepId: string;
  readonly title: string;
  readonly dept: string;
  readonly requirement: string;
  /** 预期成果（要求，不是已产出的事实）。 */
  readonly expectedArtifacts?: string;
  /** 上游成果或资料（进卡面「输入」）；没登记就是 `undefined`，不是空数组。 */
  readonly inputs?: readonly string[];
  readonly dependsOn: readonly string[];
  readonly humanGate: boolean;
  readonly readOnly: boolean;
  readonly audit: boolean;
  /** 审核步骤的部门标准；没登记就是 `undefined`（审核步骤缺它是定义缺陷，界面照实说，不补默认）。 */
  readonly deptStandard?: string;
  readonly constraints?: string;
  readonly tier?: string;
  /** 每卡预算对象；未配预算时整项缺省（不是零值对象）。 */
  readonly budget?: TemporaryPlanBudgetRow;
  readonly priority?: string;
  readonly skills?: readonly string[];
  readonly backEdges?: readonly TemporaryPlanBackEdgeRow[];
}

/**
 * 等待原因的真实来源：`hold` 是内核控制正本投影出的中文原文（照抄，界面不翻译成猜测值），
 * `blockedBy` 给出**机器可读的上游阻塞来源**，界面据此显示「等待第 2、3 步」而不是从中文文案里抠数字。
 * - `deps`：还有哪些依赖步骤没完成（步骤 ID，升序）；等待前序时为非空。
 * - `kind`：内核还没给出「为什么没动」时的归类；`hold` 非空时以 `hold` 为准。
 */
export interface TemporaryPlanWaitRow {
  /** 阻塞它的依赖步骤 ID（该步骤还没完成）；`waitKind` 不是 `deps` 时通常为空。 */
  readonly blockedBy: readonly string[];
  /**
   * 等待归类，只表示「卡在流程的哪一类条件上」，不是状态：
   * `deps` 等前序／`minister` 等部长绑定或拆解／`audit` 等审核判定／`confirm` 等人工确认／
   * `budget` 预算相关／`paused` 实例已暂停／`failed` 卡失败或取消／`read-error` 卡或控制读不出来／
   * `none` 没在等。
   */
  readonly waitKind: string;
}

/**
 * 一步的真实产物：路径原文来自卡回执的 `artifact_path`，`exists` 由内核在盘上核一次。
 * 界面只显示内核核过的真值；`exists: false` 时看 `note` 的原因，不拿预期成果冒充产物。
 * 同一 `relativePath` 在不同轮次各有一条（内核不去重吞历史）：`currentRound` 标出哪条是当前轮次，
 * 界面据此提示「有新版本」但不抢换正文，由用户主动切换；`versionBasis` 说明这份文件是哪一轮哪张卡产出的。
 */
export interface TemporaryPlanArtifactRow {
  readonly path: string;
  /** 相对工作区的路径，可用于只读文件预览。 */
  readonly relativePath: string;
  readonly round: number;
  readonly card: string;
  /** 版本识别依据，形如「第 2 轮（卡 0004）」：界面用它分清同路径的不同版本。 */
  readonly versionBasis: string;
  /** 是否属于该步骤的当前轮次；历史轮次为 false。 */
  readonly currentRound: boolean;
  readonly exists: boolean;
  readonly note?: string;
}

/** 一步的一次执行记录：第几次、该轮卡引用、判定原文与原因（原文照抄，界面不翻译成猜测值）。 */
export interface TemporaryPlanStepRecordRow {
  readonly round: number;
  readonly cards: readonly string[];
  readonly verdict?: string;
  readonly reason?: string;
}

/** 一次启动里某个步骤的运行投影：状态沿用内核单域英文值。 */
export interface TemporaryPlanStepProgressRow {
  readonly stepId: string;
  readonly status: string;
  readonly round?: number;
  readonly hold?: string;
  /**
   * 等待原因的真实来源（§7.1）：`hold` 是内核原文，这里再给机器可读的阻塞来源与归类。
   * 卡片不拿首卡代表整步，也不从中文文案里猜等待对象。
   */
  readonly wait: TemporaryPlanWaitRow;
  readonly confirmed?: string;
  readonly needsConfirmation: boolean;
  /** 活干完、只等人确认放行：内核在确认通过前不报 delivered，界面据它显示「待你确认」。 */
  readonly awaitingConfirmation: boolean;
  /** 控制正本里这一步当前的卡引用（可能是多张）；停卡入口据它点名，界面不自己编卡号。 */
  readonly cards: readonly string[];
  /**
   * 这一步的全部卡引用（当前轮＋历史轮，去重后按出现顺序）：多卡步骤逐一可打开，
   * 不能取首卡代表完成。**坏卡/缺映射单独报**，见 `readProblem` 与 `records`，正常卡继续可读。
   */
  readonly allCards: readonly string[];
  /** 依赖步骤是否都已交付（内核 completion 口径）；缺依赖信息时为 false，不当成已完成。 */
  readonly depsSettled: boolean;
  /** 执行记录（第几次、打回原因摘要）；没有控制信息就是空列表。 */
  readonly records: readonly TemporaryPlanStepRecordRow[];
  /** 卡读不出来时的原因（人话，兼容字段）；有值表示这一步的产物清单不完整。 */
  readonly readProblem?: string;
  /** 同上，但逐条且带稳定码与认领到的步骤；界面用它把问题挂在具体卡边。 */
  readonly readProblems: readonly TemporaryPlanReadProblemRow[];
  readonly artifacts: readonly TemporaryPlanArtifactRow[];
}

/** 一次启动受理的关联真值：实例号/工作区/卡目录都从盘上读，不从请求参数推。 */
export interface TemporaryPlanStartRow {
  readonly startRequestId: string;
  readonly instanceId: string;
  readonly recipeName: string;
  readonly workspace: string;
  readonly cardDir: string;
  readonly controlPath: string;
  readonly ownerSessionId: string;
  readonly acceptedAt: string;
  /** 控制正本当前状态；读不到控制正本时这里写明原因，不冒充「运行中」。 */
  readonly status: string;
  /** 控制正本读不到时为空数组：界面按「状态读不到」处理，不显示成「还没有产出」。 */
  readonly progress: readonly TemporaryPlanStepProgressRow[];
}

/**
 * 一条意见：状态是内核真值（已记录/待送达/已送达/投递失败/已应用），桌面不改写。
 * 版本绑定必须一起带过来：`definitionVersion` 是提交时那一版定义；文件意见再带 `stepId`/`round`/`versionBasis`，
 * 界面才能显示「这条意见是对哪一轮哪一版说的」，旧稿意见不会被误贴到新稿上。
 * `targetKind === "流程"` 表示针对整份计划目标的整体意见，此时 `target` 为「流程」而不是空串
 * （空串会让桥的字段校验整份查询失败）。
 */
export interface TemporaryPlanFeedbackRow {
  readonly feedbackId: string;
  readonly target: string;
  readonly targetKind: string;
  readonly status: string;
  /** 提交时正在看的定义版本。 */
  readonly definitionVersion: number;
  /** 文件意见：所属步骤 ID。 */
  readonly stepId?: string;
  /** 文件意见：第几轮次的稿子。 */
  readonly round?: number;
  /** 文件意见：用户读的是哪一版（版本识别依据）。 */
  readonly versionBasis?: string;
  readonly recordedAt: string;
  /** 「已应用」的业务处理依据；没有就是没关联到可核查的处理。 */
  readonly appliedBasis?: string;
  readonly detail?: string;
}

/** 一份计划：定义摘要＋启动关联＋意见；同名计划靠稳定计划 ID 区分。 */
export interface TemporaryPlanRow {
  readonly planId: string;
  readonly displayName: string;
  readonly definitionVersion: number;
  readonly undone: boolean;
  readonly sourceSessionId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly steps: readonly TemporaryPlanStepRow[];
  readonly starts: readonly TemporaryPlanStartRow[];
  readonly feedback: readonly TemporaryPlanFeedbackRow[];
  /**
   * 本次查询里读不出来的卡/控制记录（计划级汇总）：改计划本身的问题进 `issues`，
   * 「某个节点的卡读不出来」进这里——两者混在一起，界面就没法只停一个节点。
   */
  readonly readProblems: readonly TemporaryPlanReadProblemRow[];
}

/** 坏定义/坏关联/越界目录：不静默当「还没有计划」。 */
export interface TemporaryPlansIssueRow {
  readonly path: string;
  readonly message: string;
}

/**
 * 卡/控制读不出来的**逐条上报**（§7.1「坏卡/缺映射单独报，正常节点继续可读」）：
 * 出现在计划的 `readProblems` 与对应步骤的 `readProblems` 上，
 * 界面把它挂在那一张卡边上，不让整个看板变成一句「加载失败」；
 * `stepId` 只在与问题文本对得上时给出，认不出就不给假 ID。
 */
export interface TemporaryPlanReadProblemRow {
  readonly stepId?: string;
  readonly code: string;
  readonly message: string;
}

/** 只读查询入参：project 由主进程按已登记 workspaceId 解析，渲染层不传路径。 */
export interface TemporaryPlansQueryInput {
  readonly workspaceId: string;
  /** 只看某一份计划时给稳定计划 ID；缺省＝列全部。 */
  readonly planId?: string;
}

export type TemporaryPlansResult =
  | {
      readonly state: "ok";
      readonly plans: readonly TemporaryPlanRow[];
      readonly issues: readonly TemporaryPlansIssueRow[];
    }
  | { readonly state: "failed"; readonly message: string };

/**
 * 成果正文只读读取入参（§6.4.2/6.4.3）：渲染层**只报身份**，不报磁盘路径。
 * 主进程按 `workspaceId` 解析项目、重新读一遍计划投影，用
 * `startRequestId + stepId + artifactPath + round` 在**已核实的产物行**里定位，
 * 再读正文。渲染层因此拿不到任意读盘能力：路径必须先是内核投影里的一条真实产物。
 * `round` 与 `versionBasis` 一起递交，防止界面把旧轮次的路由到新版本（读错版本比读不到更糟）。
 */
export interface TemporaryPlanArtifactContentInput {
  readonly workspaceId: string;
  readonly planId: string;
  readonly startRequestId: string;
  readonly stepId: string;
  /** 内核投影里的相对路径原文（`TemporaryPlanArtifactRow.relativePath`）。 */
  readonly artifactPath: string;
  /** 第几轮的稿子；同路径不同轮次是不同版本，必须点名。 */
  readonly round: number;
  /** 调用方当时看到的版本依据；与重新核实的真值不一致时拒绝，不贴旧标签读新文件。 */
  readonly versionBasis: string;
}

/**
 * 正文读取结果：成功给正文与已核实的路径/版本依据；失败给**明确原因**，不静默给空正文。
 * 六类显式失败（§6.4.3 缺失/越界/链接/权限/过大/不支持）都在 `reason` 里说出人话，
 * `code` 供界面分支与测试断言，不用自然语言猜。
 */
export type TemporaryPlanArtifactContentResult =
  | {
      readonly state: "ok";
      /** 已核实的相对路径（正斜杠）与版本依据，界面显示与复制都用它。 */
      readonly relativePath: string;
      readonly versionBasis: string;
      readonly round: number;
      readonly card: string;
      /** 正文文本（按 UTF-8 解码；带 BOM 已剥离）。 */
      readonly content: string;
      /** 文件字节数。 */
      readonly byteLength: number;
      /** 是否被截断（超过上限只给前一段，界面须说明「只显示了前 N 字节」）。 */
      readonly truncated: boolean;
      /** 盘上文件的最后修改时刻（ISO）；不是版本依据，只作参考。 */
      readonly modifiedAt: string;
    }
  | {
      readonly state: "failed";
      readonly code: TemporaryPlanArtifactReadCode;
      readonly message: string;
    };

/**
 * 读取失败码：缺失 / 越界 / 链接 / 权限 / 过大 / 不支持 / 版本对不上 / 身份查不到。
 * `version-mismatch` 与 `not-found-in-plan` 是身份核对失败，不是文件问题，单独分开。
 */
export type TemporaryPlanArtifactReadCode =
  | "missing"
  | "out-of-root"
  | "symlink"
  | "permission-denied"
  | "too-large"
  | "unsupported"
  | "version-mismatch"
  | "not-found-in-plan"
  | "unknown";
