/**
 * 步骤卡工作台的纯投影与指令文案（通用工作台阶段 5）。
 *
 * 真值来源：
 * - 步骤定义来自临时计划投影（`<项目>/.pao/临时工作流/<计划ID>/计划.md`）；
 * - 步骤进度来自控制正本投影（内核 controlReport：卡现读状态、人工确认门、当前轮次、挂起原因）；
 * - 意见来自计划意见文件投影（已记录/待送达/已送达/投递失败/已应用，内核真值，界面不改写）。
 *
 * 这里只做展示归并与文案拼装，不造状态：
 * - 配方节点名就是稳定步骤 ID（plan.ts 的 planToRecipe），所以控制正本节点能按 ID 对回步骤；
 * - 「预期成果」是要求，不是已产出的事实，界面必须分开说；
 * - 页面不能自己写盘，改动一律变成一句现成指令交给主控，由主控用内核工具落盘。
 *
 * 只做纯函数，输入输出都是已有契约类型，不动盘、不缓存。
 */

import type {
  TemporaryPlanArtifactRow,
  TemporaryPlanFeedbackRow,
  TemporaryPlanRow,
  TemporaryPlanStepProgressRow,
  TemporaryPlanStepRow,
} from "../../../contracts/temporary-plans";
import type {
  WorkflowControlIdentity,
  WorkflowControlNodeRow,
} from "../../../contracts/workflow-control";

/**
 * 步骤卡状态：内核节点状态到界面语义的归并（不改写内核真值）。
 *
 * 一个状态一个语义，界面按它分别解释（计划 §7.1 第 3 条）：
 * - done 交付 / running 执行中 / review 待人工确认；
 * - pending 未开始 / waiting 等前序 / wait_lead 等部长 / wait_review 待审；
 * - paused 暂停推进 / budget 预算不足 / failed 失败 / canceled 取消 / unreadable 读取异常；
 * - unknown 状态读不懂：既不当成功也不当失败，如实说「读不懂」，界面照常给出其余真值。
 */
export type StepCardState =
  | "done"
  | "running"
  | "review"
  | "pending"
  | "waiting"
  | "waitLead"
  | "waitReview"
  | "paused"
  | "budget"
  | "failed"
  | "canceled"
  | "unreadable"
  | "unknown";

/** 状态文案（英文源串，界面经 t() 取中文）。 */
export const STEP_CARD_STATE_LABELS: Record<StepCardState, string> = {
  done: "Done",
  running: "Running",
  review: "Needs your confirmation",
  pending: "Not started yet",
  waiting: "Waiting for earlier steps",
  waitLead: "Waiting for the lead",
  waitReview: "Waiting for review",
  paused: "Paused",
  budget: "Out of budget",
  failed: "Failed",
  canceled: "Canceled",
  unreadable: "Card status unreadable",
  unknown: "Card status unknown",
};

/**
 * 非颜色信号：状态不能只靠颜色表达，每张卡还要给一个可读/可朗读的标识。
 * 取值都是 ASCII，界面直接渲染，不进词典；颜色只是补充。
 */
export const STEP_CARD_STATE_ICONS: Record<StepCardState, string> = {
  done: "[ok]",
  running: "[run]",
  review: "[check]",
  pending: "[idle]",
  waiting: "[wait]",
  waitLead: "[lead]",
  waitReview: "[review]",
  paused: "[pause]",
  budget: "[budget]",
  failed: "[fail]",
  canceled: "[cancel]",
  unreadable: "[read-error]",
  unknown: "[unknown]",
};

/** 未收尾的状态：完成与取消以外的都还没结束（未知状态也算没收尾，不能当成结束）。 */
export function isSettledState(state: StepCardState): boolean {
  return state === "done" || state === "canceled";
}

/**
 * 还在路上、可能自己走完的状态 = **3 态**：running / waitLead / waitReview。
 *
 * 口径（勿改）：这 3 态就是「已在途」，D1 的停止入口只在在途卡上出现（§7.1 第 259 条
 * 「停止在途走终止入口」）。pending（未开始）与 waiting（等前序）属**未在途**，它们还没
 * 开工，给停止入口就是假按钮，因此**不得**纳入本判定。
 * 早前有消息把它说成 8 态，以磁盘实现为准，已否。
 */
export function isInFlightState(state: StepCardState): boolean {
  return state === "running" || state === "waitLead" || state === "waitReview";
}

/** 真的有东西摆着等你动作的状态（人工门）。 */
export function isActionableState(state: StepCardState): boolean {
  return state === "review";
}

/** 需要人去救的状态：失败、预算不足、暂停推进、状态读不懂（取消是明确终态，不算要救）。 */
export function needsAttentionState(state: StepCardState): boolean {
  return (
    state === "failed" || state === "budget" || state === "paused" || state === "unknown"
  );
}

export interface StepCardView {
  readonly step: TemporaryPlanStepRow;
  readonly state: StepCardState;
  /** 控制正本里的同名节点；没有实例（或该节点还没落卡）时缺省。 */
  readonly node?: StepCardViewNode;
  /** 已交付＝控制正本说卡已交付；「等待你的确认」也算已交付（卡已交、门没放行）。 */
  readonly delivered: boolean;
  /** 这一步现读的进度行；没有实例或该步还没投影时缺省。 */
  readonly progress?: TemporaryPlanStepProgressRow;
  /** 内核说的等待原因原文，没有就不编。 */
  readonly holdReason?: string;
  /** 已确认放行那一刻的时间戳；没有＝这一轮没放行过。 */
  readonly confirmedAt?: string;
  /** 步骤自己的依赖（稳定 ID，按定义顺序）。 */
  readonly dependsOn: readonly string[];
  /** 依赖里这一步真正在等的那几个（已交付、已取消、正在跑的不算等）。 */
  readonly waitingOn: readonly string[];
  /** 依赖已交付但还卡在人工门上的前序：等的是人，不是活。 */
  readonly gateWaitingOn: readonly string[];
  /** 这一步的轮次：控制正本/进度行哪边有就用哪边，都没有就不编。 */
  readonly round?: number;
}

/**
 * 控制正本节点 + 一份「这份状态我们还读不读得懂」的判断。
 *
 * 内核的单域英文状态值是契约；`statusKnown: false` 表示这一版桌面还没见过这个值，
 * 界面必须按未知处理，不得往成功或失败上猜（计划 §8.3）。
 */
export interface StepCardViewNode extends WorkflowControlNodeRow {
  readonly statusKnown: boolean;
}

/** 生产端继续按契约类型收节点；多余字段（statusKnown）在入口剥掉，避免外部把它当真值传进来。 */
function toViewNode(node: WorkflowControlNodeRow): StepCardViewNode {
  return { ...node, statusKnown: isKnownNodeStatus(node.status) };
}

/** 能读懂的节点状态：上游契约出现的字面量 + 本文件历史上已按语义处理的空/未知值。 */
function isKnownNodeStatus(status: string): boolean {
  return (
    status === "delivered" ||
    status === "in_progress" ||
    status === "no_card" ||
    status === "failed" ||
    status === "canceled" ||
    status === "读取异常"
  );
}

/** 「还没开始」的进度状态：内核 plans.ts 用未开始/待启动表达这一步还没有活卡。 */
function isIdleProgressStatus(status: string | undefined): boolean {
  return status === undefined || status === "未开始" || status === "待启动";
}

/**
 * 停因原文里认「预算」的方式：内核把预算原因写在挂起说明里，没有独立字段可用。
 *
 * 已知投影局限：节点预算（`CardBudget`：turns/toolCalls/cost）只在内核配方/计划/模板侧
 * 存在，控制正本投影出来的节点行没有「预算不足」这个状态或结构化字段，所以这里只能照
 * 挂起说明的原文认。认不出就不认——宁可显示别的停因或读不懂，也不编一个「预算不足」，
 * 那会把没发生的事报成发生（§8.3：坏数据/未知不得补默认值假成功）。如需硬真值，需内核
 * 侧补字段后再改这里。
 */
function mentionsBudget(text: string | undefined): boolean {
  return text !== undefined && text.includes("预算");
}

/** 停因原文里认「等部长」的方式：内核 control.ts 的固定几种部长等待文案都含「部长」。 */
function mentionsLead(text: string | undefined): boolean {
  return text !== undefined && text.includes("部长");
}

/** 停因原文里认「待审」的方式：内核卡片口径「回执已交、状态未终」。 */
function mentionsReview(text: string | undefined): boolean {
  return text !== undefined && text.includes("待审");
}

/** 停因原文里认「暂停推进」的方式：只有人工暂停会把原因写在这里，挂起不算。 */
function mentionsPause(text: string | undefined): boolean {
  return text !== undefined && text.includes("暂停");
}

/** 步骤卡列表：按定义顺序（显示顺序只供阅读，身份仍是步骤 ID）。 */
export function stepCardViews(
  plan: TemporaryPlanRow,
  control: WorkflowControlIdentity | undefined,
  progress: readonly TemporaryPlanStepProgressRow[] = [],
): readonly StepCardView[] {
  const nodes = new Map<string, StepCardViewNode>();
  for (const node of control?.nodes ?? []) {
    nodes.set(node.name, toViewNode(node));
  }
  const progressByStep = new Map<string, TemporaryPlanStepProgressRow>();
  for (const row of progress) {
    progressByStep.set(row.stepId, row);
  }
  const resolved = new Map<string, StepCardState>();
  const views: StepCardView[] = [];
  for (const step of plan.steps) {
    const node = nodes.get(step.stepId);
    const row = progressByStep.get(step.stepId);
    const state = resolveStepState(step, node, row, resolved, control);
    resolved.set(step.stepId, state);
    const holdReason = holdReasonText(node, row);
    const confirmedAt = row?.confirmed ?? node?.confirmed;
    // 【修正二 · 轮次以进度行为准】
    // 现象：待确认类待办挂到了错误轮次，旧轮次的提醒能推进新轮次。
    // 根因：原来取 `node.round ?? row.round`，控制正本的 node.round 是控制面自己的记账，
    //   与这一步实际在跑的第几轮不一定同步，优先取它就会把待办挂错轮。
    // 改法：改为 `row.round ?? node.round`。进度行是内核按这一步自己的卡算出来的当前轮次，
    //   以卡为准（取不到再退回控制正本的记账）。这是旧提醒不推进新轮次的关键。
    const round = row?.round ?? node?.round;
    const waitingOn = waitingDependencies(step, resolved);
    const gateWaitingOn = gateDependencies(plan, step, nodes);
    views.push({
      step,
      state,
      ...(node === undefined ? {} : { node }),
      delivered: state === "done" || state === "review",
      ...(row === undefined ? {} : { progress: row }),
      ...(holdReason === undefined ? {} : { holdReason }),
      ...(confirmedAt === undefined ? {} : { confirmedAt }),
      dependsOn: [...step.dependsOn],
      waitingOn,
      gateWaitingOn,
      ...(round === undefined ? {} : { round }),
    });
  }
  return views;
}

/**
 * 内核节点状态 → 界面语义。
 *
 * 【修正一 · 挂起原因必须先于 in_progress】
 * 现象：内核把卡停在「本轮预算不足」「等待部长会话绑定」时，卡片仍显示为「执行中」。
 * 根因：原判定先看 `node.status === "in_progress"` 就返回 running，而这类停摆在内核里
 *   是「状态还挂着 in_progress、但挂起说明（hold）已经写了停因」，先判状态就把停因漏掉。
 * 改法：把 budget/paused/waitLead/waitReview 四类挂起判定整体提到 in_progress 之前，
 *   并让流级 `control.pauseReason` 覆盖所有活节点（不只是自己写了 hold 的那个）。
 *
 * 【修正二 · 轮次以进度行为准】见 stepCardViews 里 `round` 的取值处。
 *
 * 次序即优先级：
 * 1. 读取问题最先——读不到就不能假装知道；
 * 2. 明确终态与失败（失败/取消/交付）；
 * 3. 人工确认门；
 * 4. 挂起原因（暂停推进/预算不足/等部长/待审）——**先于 in_progress**：
 *    内核的卡即使还在 in_progress，只要挂起说明在，这一步就是停着的，
 *    报成「执行中」会把卡住的活说成还在跑；
 * 5. 等前序、未开始。
 * 认不出的状态一律 unknown，不落到成功上。
 *
 * 没有控制正本（`control === undefined`）不是「读不到」：那表示这份计划还没起过实例，
 * 步骤按定义顺序判成未开始/等前序，不报读取异常。
 */
function resolveStepState(
  step: TemporaryPlanStepRow,
  node: StepCardViewNode | undefined,
  row: TemporaryPlanStepProgressRow | undefined,
  resolved: ReadonlyMap<string, StepCardState>,
  control: WorkflowControlIdentity | undefined,
): StepCardState {
  if (row?.readProblem !== undefined || node?.status === "读取异常") {
    // 进度行说卡读不出来，或控制正本节点自报读取异常：都不能冒充成功。
    return "unreadable";
  }
  if (node !== undefined && !node.statusKnown) {
    // 状态值这一版桌面没见过：如实说读不懂，既不当成功也不当失败。
    return "unknown";
  }
  if (node?.status === "failed") {
    return "failed";
  }
  if (node?.status === "canceled") {
    return "canceled";
  }
  if (row?.awaitingConfirmation) {
    // 人工确认门：活已经干完、只等人放行。内核在确认通过前不会报 delivered，
    // 所以这一位必须由内核投影给出，界面不去猜 `挂起` 的中文文案。
    return "review";
  }
  if (node?.status === "delivered") {
    return "done";
  }
  const hold = row?.hold ?? node?.hold;
  if (mentionsBudget(hold)) {
    // 预算原因只在内核挂起说明里，没有独立字段；照原文认，认不出就不认。
    return "budget";
  }
  if (mentionsPause(hold) || control?.pauseReason !== undefined) {
    return "paused";
  }
  if (mentionsLead(hold)) {
    return "waitLead";
  }
  if (mentionsReview(hold)) {
    return "waitReview";
  }
  if (node?.status === "in_progress") {
    return "running";
  }
  if (hasUnfinishedDependency(step, resolved)) {
    return "waiting";
  }
  if (node === undefined || node.status === "no_card" || isIdleProgressStatus(row?.status)) {
    return "pending";
  }
  // 节点在、状态也是认得的字面量，但上面没有一个分支认领它：不猜，如实说读不懂。
  return "unknown";
}

/** 依赖里还有没走完的（未完成、失败、取消、状态读不懂都算没走完）。 */
function hasUnfinishedDependency(
  step: TemporaryPlanStepRow,
  resolved: ReadonlyMap<string, StepCardState>,
): boolean {
  return step.dependsOn.some((dep) => resolved.get(dep) !== "done");
}

/**
 * 真正在等的前序：依赖没交付、也没有被取消的，就是挡着这一步的活。
 * 取消掉的前序不再挡路（内核也认为取消是了结），所以不算进等待名单。
 */
function waitingDependencies(
  step: TemporaryPlanStepRow,
  resolved: ReadonlyMap<string, StepCardState>,
): readonly string[] {
  return step.dependsOn.filter((dep) => {
    const state = resolved.get(dep);
    return state !== "done" && state !== "canceled";
  });
}

/**
 * 依赖已交付但还压在人工门上的前序：这些前序的活干完了，等的是人放行，
 * 界面要把这两种「等」分开说（计划 §7.1：等前序与等人工确认分别解释）。
 */
function gateDependencies(
  plan: TemporaryPlanRow,
  step: TemporaryPlanStepRow,
  nodes: ReadonlyMap<string, StepCardViewNode>,
): readonly string[] {
  return step.dependsOn.filter((dep) => {
    const depStep = plan.steps.find((item) => item.stepId === dep);
    const depNode = nodes.get(dep);
    return (
      depStep !== undefined &&
      depStep.humanGate &&
      depNode?.status === "delivered" &&
      depNode.confirmed === undefined
    );
  });
}

/**
 * 等待原因：照抄内核说的原因（进度行优先，其次是控制正本节点）。
 * 说不出具体等哪几步时用内核原文；内核什么都没说就什么都不写，界面不给假原因。
 * 「具体等第几步」的呈现由 stepHoldText 拼，这里只保留原文。
 */
function holdReasonText(
  node: StepCardViewNode | undefined,
  row: TemporaryPlanStepProgressRow | undefined,
): string | undefined {
  return row?.hold ?? node?.hold;
}

/** 已完成的步数（只数真的交付完成的，确认门等待中不算完成）。 */
export function completedStepCount(views: readonly StepCardView[]): number {
  return views.filter((view) => view.state === "done").length;
}

/** 有实例时的流级状态文案：暂停原因优先，便于一眼看出是人工暂停。 */
export function flowStatusText(control: WorkflowControlIdentity | undefined): string | undefined {
  if (!control) {
    return undefined;
  }
  return control.pauseReason ? `${control.status} · ${control.pauseReason}` : control.status;
}

/** 顶部摘要的计数：总量是筛选外的全部步骤，界面必须同时显示「过滤后」数量，避免误读。 */
export interface StepCardCounts {
  readonly total: number;
  readonly done: number;
  readonly running: number;
  readonly review: number;
  readonly pending: number;
  readonly waiting: number;
  readonly waitLead: number;
  readonly waitReview: number;
  readonly paused: number;
  readonly budget: number;
  readonly failed: number;
  readonly canceled: number;
  readonly unreadable: number;
  readonly unknown: number;
  /** 还没收尾的状态合计（完成与取消以外的全部）。 */
  readonly open: number;
}

export function stepCardCounts(views: readonly StepCardView[]): StepCardCounts {
  const counts = {
    total: views.length,
    done: 0,
    running: 0,
    review: 0,
    pending: 0,
    waiting: 0,
    waitLead: 0,
    waitReview: 0,
    paused: 0,
    budget: 0,
    failed: 0,
    canceled: 0,
    unreadable: 0,
    unknown: 0,
    open: 0,
  } satisfies Record<keyof StepCardCounts, number>;
  for (const view of views) {
    counts[view.state] += 1;
    if (!isSettledState(view.state)) {
      counts.open += 1;
    }
  }
  return counts;
}

/** 「已完成 N / 进行中 M / 待办 K」这类摘要用的复合位：待办＝没收尾的全部。 */
export function stepCardProgressCounts(views: readonly StepCardView[]): {
  readonly total: number;
  readonly done: number;
  readonly open: number;
} {
  const counts = stepCardCounts(views);
  return { total: counts.total, done: counts.done, open: counts.open };
}

/**
 * 并行分组：只有显式声明的同组才算并行（计划 §7.1、§11「仅显式同组不同部门只读并行」）。
 *
 * 判据全部摆在数据上，不靠猜：
 * - 两个步骤必须都 `readOnly`（只读任务才允许同时跑）；
 * - 部门必须不同（同部门要排队，内核按部门串行）；
 * - 必须共享同一个前置（同一批前置产出的下游才谈得上一起开工）；
 * - 组里不能有人工确认门（门没放行就不能算可并行）。
 * 认不出的不出组：单步自成一组，界面按组渲染时不会把串行说成并行。
 */
export interface ParallelGroup {
  /** 组内的步骤 ID，按定义顺序。 */
  readonly stepIds: readonly string[];
  /** 只读并行（真并行）；false 表示这一步自成一组、按串行排队。 */
  readonly parallel: boolean;
  /** 一起开工时共享的那个前置；组内不止一步时必有。 */
  readonly sharedDependency?: string;
}

/**
 * 显式并行分组：把「可以一起开工」的只读步骤并成一组，其余各自成组串行排队。
 *
 * 已知投影局限：契约里没有并行组字段（`contracts/workflow-control.ts` 的节点行没有
 * `parallelGroupId`，只有 `contracts/canvas.ts` 有画布侧概念），所以这里是从现有字段
 * **推导**出来的，依据四条同时成立：
 *   1. 两步都是只读（`readOnly`）——只读才谈得上并行，写任务必须排队；
 *   2. 两步都不带人工门（`humanGate`）——门没放行就谈不上一起开工；
 *   3. 两步部门不同（`dept` 互异）——内核按部门串行，同部门的只读任务不算并行；
 *   4. 两步共享同一个前置（`dependsOn` 有交集）——同一批被放行的才算一组。
 * 单步自成一组（`parallel: false`）。
 *
 * 这是纯投影，不落盘、不写盘。推导不出来就不编：不在任何组里的步骤由
 * `stepParallelGroup` 返回 undefined，界面按单卡处理。如需硬真值（内核认定的并行组），
 * 需内核侧补字段后再改这里——当前 D 批界面按投影工作即可。
 */
export function parallelStepGroups(plan: TemporaryPlanRow): readonly ParallelGroup[] {
  const groups: ParallelGroup[] = [];
  const merged = new Set<string>();
  for (const step of plan.steps) {
    if (merged.has(step.stepId)) {
      continue;
    }
    const mates = plan.steps.filter(
      (other) =>
        other.stepId !== step.stepId &&
        !merged.has(other.stepId) &&
        isMutuallyParallel(step, other),
    );
    if (mates.length === 0) {
      groups.push({ stepIds: [step.stepId], parallel: false });
      continue;
    }
    const shared = step.dependsOn.find((dep) => mates.every((mate) => mate.dependsOn.includes(dep)));
    // 同组只保留部门唯一的成员：同部门的多步要排队，不能算进并行组。
    const depts = new Set<string>([step.dept]);
    const stepIds = [step.stepId];
    for (const mate of mates) {
      if (depts.has(mate.dept)) {
        continue;
      }
      depts.add(mate.dept);
      stepIds.push(mate.stepId);
      merged.add(mate.stepId);
    }
    merged.add(step.stepId);
    if (stepIds.length === 1) {
      groups.push({ stepIds, parallel: false });
      continue;
    }
    groups.push({
      stepIds,
      parallel: true,
      ...(shared === undefined ? {} : { sharedDependency: shared }),
    });
  }
  return groups;
}

/** 两步是否满足「显式只读并行」的全部条件。 */
function isMutuallyParallel(a: TemporaryPlanStepRow, b: TemporaryPlanStepRow): boolean {
  if (!a.readOnly || !b.readOnly) {
    return false;
  }
  if (a.humanGate || b.humanGate) {
    return false;
  }
  if (a.dept === b.dept) {
    return false;
  }
  return a.dependsOn.some((dep) => b.dependsOn.includes(dep));
}

/** 某一步所属的并行组；不在任何组里（坏数据）时返回 undefined，界面按单卡处理。 */
export function stepParallelGroup(
  groups: readonly ParallelGroup[],
  stepId: string,
): ParallelGroup | undefined {
  return groups.find((group) => group.stepIds.includes(stepId));
}

/**
 * 每轮执行信息：把进度行的执行记录按轮次归位，附带那一轮的卡与判定原文。
 * 没有记录就不编（空数组＝内核没给执行历史，界面显示「暂无记录」，不显示假轮次）。
 */
export interface StepRoundExecution {
  readonly round: number;
  readonly cards: readonly string[];
  /** 内核判定原文；没有就是没判定，界面不补「通过」。 */
  readonly verdict?: string;
  readonly reason?: string;
}

export function stepRoundExecutions(
  row: TemporaryPlanStepProgressRow | undefined,
): readonly StepRoundExecution[] {
  if (row === undefined) {
    return [];
  }
  return [...row.records]
    .sort((a, b) => a.round - b.round)
    .map((record) => ({
      round: record.round,
      cards: [...record.cards],
      ...(record.verdict === undefined ? {} : { verdict: record.verdict }),
      ...(record.reason === undefined ? {} : { reason: record.reason }),
    }));
}

/**
 * 多卡汇总：这一步当前的卡引用清单。
 * 没有卡就是零卡（内核可能还在审查），界面必须显示「当前无卡」而不是拿别的卡顶上。
 */
export interface StepCardRefs {
  readonly cards: readonly string[];
  readonly hasCards: boolean;
}

export function stepCardRefs(view: StepCardView): StepCardRefs {
  const cards = view.progress?.cards ?? [];
  return { cards: [...cards], hasCards: cards.length > 0 };
}

/**
 * 单张卡的耗时取数（只取卡面真值，不估）。
 *
 * 口径与内核 `cards/metrics.ts` 的 `metricsDurationSeconds` 一致：**创建 → 终态时刻**，
 * 两端都要能解析成分钟级时间才算得出；任一端缺或读不懂就是 `未记录`，界面写「未记录」，
 * 不许拿别的数（轮次、会话时长、当前时刻）顶上去。内核那边解析不出按 0 记，这里不跟：
 * 0 秒会读成「瞬间做完」，那是编造，所以显式分成「无卡」与「未记录」两种情况。
 */
export type StepDuration =
  | { readonly kind: "no_card" }
  | { readonly kind: "unrecorded"; readonly reason: string }
  | {
      readonly kind: "measured";
      readonly seconds: number;
      readonly created: string;
      readonly finished: string;
    };

/** "YYYY-MM-DD HH:mm" → 本地毫秒；解析不出 undefined（与 cards/metrics.ts 的 parseCardTime 同口径）。 */
function parseCardMinute(text: string | undefined): number | undefined {
  if (text === undefined) {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const [, y, m, d, h, min] = match;
  return new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min)).getTime();
}

/**
 * 逐步耗时：`card` 是本步当前那张卡的卡面真值（来自 `readNodeDetail` 的 `detail.card`）；
 * 没有卡面（没卡 / 读不到）时按「无卡」处理，不拿执行会话时长冒充。
 */
export function stepDuration(card: StepCardDurationCard | undefined): StepDuration {
  if (card === undefined) {
    return { kind: "no_card" };
  }
  const created = card.created.trim();
  const finished = card.completed?.trim() ?? "";
  if (created === "") {
    return { kind: "unrecorded", reason: "卡面没有记录创建时间" };
  }
  if (finished === "") {
    return { kind: "unrecorded", reason: "卡面没有记录完成时间（还没交付或交付时未写）" };
  }
  const start = parseCardMinute(created);
  const end = parseCardMinute(finished);
  if (start === undefined || end === undefined) {
    return { kind: "unrecorded", reason: "卡面时间读不懂（要 YYYY-MM-DD HH:mm）" };
  }
  return { kind: "measured", seconds: Math.max(0, Math.round((end - start) / 1000)), created, finished };
}

/** `stepDuration` 需要的最小卡面字段（`CanvasNodeDetailData["card"]` 的子集，主进程回什么就用什么）。 */
export interface StepCardDurationCard {
  readonly created: string;
  readonly completed?: string;
}

/**
 * 耗时文案：算得出就写「x 秒 / x 分钟 / x 小时 y 分钟」，算不出就说清为什么（不写 0、不写占位符）。
 * 90 秒以下保留秒（避免「0 分钟」又被读成瞬间做完）；满 1 小时才写小时，余数为 0 时不拖「0 分钟」。
 */
export function stepDurationText(duration: StepDuration): string {
  switch (duration.kind) {
    case "no_card":
      return "暂无卡，没有耗时可算";
    case "unrecorded":
      return `未记录：${duration.reason}`;
    case "measured": {
      const total = duration.seconds;
      if (total < 90) {
        return `${total} 秒`;
      }
      if (total < 3600) {
        return `${Math.round(total / 60)} 分钟`;
      }
      const hours = Math.floor(total / 3600);
      const minutes = Math.round((total % 3600) / 60);
      return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分钟`;
    }
  }
}

/** 这一步的轮次文案：有轮次就报，没有就不编。 */
export function stepRoundText(view: StepCardView): string | undefined {
  return view.round === undefined ? undefined : `第 ${view.round} 轮`;
}

/** 筛选条件：关键词只匹配标题/部门/要求/步骤 ID，空条件不过滤。 */
export interface StepCardFilter {
  readonly query?: string;
  readonly states?: readonly StepCardState[];
}

export function filterStepCards(
  views: readonly StepCardView[],
  filter: StepCardFilter,
): readonly StepCardView[] {
  const query = filter.query?.trim().toLowerCase() ?? "";
  const states = filter.states && filter.states.length > 0 ? new Set(filter.states) : undefined;
  return views.filter((view) => {
    if (states && !states.has(view.state)) {
      return false;
    }
    if (!query) {
      return true;
    }
    const step = view.step;
    return [step.stepId, step.title, step.dept, step.requirement]
      .join("\n")
      .toLowerCase()
      .includes(query);
  });
}

/**
 * 「下个待处理」：定义顺序里第一个真正要你管的步骤——完成、取消、以及「等待前序」
 * 都不算（等待中的步骤现在动不了）。
 * 当前这一步自己待处理时留在它身上（它就是要你管的那件事），否则往后绕圈找。
 */
export function nextPendingStepId(
  views: readonly StepCardView[],
  afterStepId?: string,
): string | undefined {
  const pending = (view: StepCardView) =>
    view.state !== "done" && view.state !== "canceled" && view.state !== "waiting";
  const startIndex = afterStepId ? views.findIndex((view) => view.step.stepId === afterStepId) : -1;
  if (startIndex >= 0 && pending(views[startIndex]!)) return views[startIndex]!.step.stepId;
  const ordered =
    startIndex >= 0 ? [...views.slice(startIndex + 1), ...views.slice(0, startIndex + 1)] : views;
  return ordered.find(pending)?.step.stepId;
}

/**
 * 等待原因：具体等哪几步优先（计划 §5.1 要求「多前置显示等待第 2、3 步」），
 * 说得出具体步骤时不用内核那句笼统的「等待前置节点」；说不出来才照抄内核。
 */
export function stepHoldText(plan: TemporaryPlanRow, view: StepCardView): string | undefined {
  if (view.state === "waiting" && view.step.dependsOn.length > 0) {
    const labels = view.step.dependsOn.map((dep) => {
      const index = plan.steps.findIndex((item) => item.stepId === dep);
      return index >= 0 ? `第 ${index + 1} 步` : dep;
    });
    return `等待${labels.join("、")}`;
  }
  return view.node?.hold;
}

export interface StepOutputEntry {
  readonly stepId: string;
  readonly title: string;
  readonly dept: string;
  /** 预期成果（计划定义里的要求，不是已产出事实）。 */
  readonly expected?: string;
  readonly delivered: boolean;
  readonly opinions: readonly TemporaryPlanFeedbackRow[];
}

/**
 * 成果文件页的分组：每步一行「预期成果」，已交付的标已交付。
 * 这里不列真实产物路径——产物路径要宿主核实过的来源，本投影里没有，宁缺不编。
 */
export function stepOutputEntries(
  plan: TemporaryPlanRow,
  views: readonly StepCardView[],
): readonly StepOutputEntry[] {
  return views.map((view) => ({
    stepId: view.step.stepId,
    title: view.step.title,
    dept: view.step.dept,
    ...(view.step.expectedArtifacts === undefined ? {} : { expected: view.step.expectedArtifacts }),
    delivered: view.delivered,
    opinions: stepOpinions(plan, view.step.stepId),
  }));
}

/** 某一步的意见（内核真值，按记录顺序）。 */
export function stepOpinions(
  plan: TemporaryPlanRow,
  stepId: string,
): readonly TemporaryPlanFeedbackRow[] {
  return plan.feedback.filter((row) => row.targetKind === "步骤" && row.target === stepId);
}

export interface FileOpinionGroup {
  /** 已确认的成果路径原文（内核记录的就是它）。 */
  readonly path: string;
  /** 同一路径不同轮次各成一组：版本不同的意见不能混成一组看。 */
  readonly round?: number;
  readonly versionBasis?: string;
  readonly opinions: readonly TemporaryPlanFeedbackRow[];
}

/**
 * 同一路径的全部版本，按轮次升序（同轮次按卡号）。
 * 内核不去重吞历史，所以同一路径出现多条是正常的；界面必须把它读成「同一份文件的多版」。
 */
export function artifactVersions(
  progress: ReadonlyMap<string, TemporaryPlanStepProgressRow>,
  path: string | undefined,
): readonly TemporaryPlanArtifactRow[] {
  if (!path) {
    return [];
  }
  return [...progress.values()]
    .flatMap((row) => row.artifacts)
    .filter((row) => row.relativePath === path || row.path === path)
    .sort(
      (a, b) => a.round - b.round || (a.card < b.card ? -1 : a.card > b.card ? 1 : 0),
    );
}

/**
 * 预览要显示的那一版：先按轮次钉住用户正在看的那一版（新版出现也不抢换），
 * 钉不住（没有指定轮次或那一版已消失）就退回最新一版，并如实说明换过。
 */
export function pickArtifactVersion(
  versions: readonly TemporaryPlanArtifactRow[],
  round: number | undefined,
): TemporaryPlanArtifactRow | undefined {
  if (versions.length === 0) {
    return undefined;
  }
  if (round !== undefined) {
    const pinned = versions.find((row) => row.round === round);
    if (pinned) {
      return pinned;
    }
  }
  return versions[versions.length - 1];
}

/** 文件意见按「路径＋轮次」分组：同名不同目录、同路径不同轮次都各自一组，不合并。 */
export function fileOpinionGroups(plan: TemporaryPlanRow): readonly FileOpinionGroup[] {
  const groups = new Map<
    string,
    { path: string; round?: number; versionBasis?: string; opinions: TemporaryPlanFeedbackRow[] }
  >();
  for (const row of plan.feedback) {
    if (row.targetKind !== "文件") {
      continue;
    }
    // 轮次是版本身份的一部分：同一路径第 1 轮与第 2 轮的意见不是一回事。
    const key = `${row.target}\u0000${row.round ?? ""}`;
    const existing = groups.get(key);
    if (existing) {
      existing.opinions.push(row);
    } else {
      groups.set(key, {
        path: row.target,
        ...(row.round === undefined ? {} : { round: row.round }),
        ...(row.versionBasis === undefined ? {} : { versionBasis: row.versionBasis }),
        opinions: [row],
      });
    }
  }
  return [...groups.values()].map((group) => ({
    path: group.path,
    ...(group.round === undefined ? {} : { round: group.round }),
    ...(group.versionBasis === undefined ? {} : { versionBasis: group.versionBasis }),
    opinions: group.opinions,
  }));
}

/**
 * 讨论对象：整个流程、某一步、或某个文件。
 * 文件对象带版本：同一路径可能有多轮稿子，用户是对着某一轮说的，意见必须钉在那一轮上，
 * 否则新稿一出，旧稿的意见就会被读成对新稿说的。
 */
export type DiscussionScope =
  | { readonly kind: "flow" }
  | { readonly kind: "step"; readonly stepId: string }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly round?: number;
      readonly versionBasis?: string;
    };

/** 文件对象的版本说明：有版本依据就用它，没有就只报轮次，都没有就不编。 */
export function fileScopeLabel(scope: {
  readonly path: string;
  readonly round?: number;
  readonly versionBasis?: string;
}): string {
  if (scope.versionBasis) {
    return `${scope.path}（${scope.versionBasis}）`;
  }
  if (scope.round !== undefined) {
    return `${scope.path}（第 ${scope.round} 轮）`;
  }
  return scope.path;
}

/**
 * 讨论对象的稳定身份，用来按对象存意见草稿。
 *
 * 必须是「哪个对象」而不是「第几个」：重排步骤、换轮次之后草稿不能跑到别的对象上。
 * 同一步骤的不同轮次、同一路径的不同轮次都各算一个对象，否则给旧稿写的意见会显示成对新稿写的。
 */
export function discussionScopeKey(scope: DiscussionScope): string {
  if (scope.kind === "flow") {
    return "flow";
  }
  if (scope.kind === "step") {
    return `step:${scope.stepId}`;
  }
  return `file:${scope.path}\u0000${scope.round ?? ""}`;
}

/** 讨论对象文案（进入对话指令，保持中文）。 */
export function scopeLabel(scope: DiscussionScope, plan: TemporaryPlanRow | undefined): string {
  if (scope.kind === "flow") {
    return "整个流程";
  }
  if (scope.kind === "file") {
    return fileScopeLabel(scope);
  }
  const step = plan?.steps.find((item) => item.stepId === scope.stepId);
  return step ? `第 ${stepIndexLabel(plan, step.stepId)} 步 · ${step.title}` : scope.stepId;
}

function stepIndexLabel(plan: TemporaryPlanRow | undefined, stepId: string): string {
  const index = plan?.steps.findIndex((item) => item.stepId === stepId) ?? -1;
  return index >= 0 ? String(index + 1) : stepId;
}

export interface StepChanges {
  readonly title?: string;
  readonly dept?: string;
  readonly requirement?: string;
  readonly expectedArtifacts?: string;
}

/**
 * 修改步骤 → 交给主控的现成指令。
 * 页面没有写通道：这里只把改动说清楚，落盘由主控用 pao_plan_update（带当前定义版本）执行。
 */
export function modifyStepInstruction(
  plan: TemporaryPlanRow,
  step: TemporaryPlanStepRow,
  changes: StepChanges,
): string {
  const lines = [
    `把临时计划「${plan.displayName}」（计划 ${plan.planId}，定义版本 ${plan.definitionVersion}）的第 ${stepIndexLabel(plan, step.stepId)} 步（步骤 ${step.stepId}「${step.title}」）改成：`,
  ];
  if (changes.title !== undefined && changes.title !== step.title) {
    lines.push(`- 标题：${changes.title}`);
  }
  if (changes.dept !== undefined && changes.dept !== step.dept) {
    lines.push(`- 负责部门：${changes.dept}`);
  }
  if (changes.requirement !== undefined && changes.requirement !== step.requirement) {
    lines.push(`- 任务要求：${changes.requirement}`);
  }
  if (
    changes.expectedArtifacts !== undefined &&
    changes.expectedArtifacts !== (step.expectedArtifacts ?? "")
  ) {
    lines.push(`- 预期成果：${changes.expectedArtifacts}`);
  }
  lines.push(
    `请用 pao_plan_update 落盘（action=modify，expected_version=${plan.definitionVersion}），改完把新的定义版本告诉我。`,
  );
  return lines.join("\n");
}

/** 撤销最近一次修改 → 交给主控的现成指令。 */
export function undoInstruction(plan: TemporaryPlanRow): string {
  return `把临时计划「${plan.displayName}」（计划 ${plan.planId}，定义版本 ${plan.definitionVersion}）改回上一版：请用 pao_plan_update 落盘（action=modify，expected_version=${plan.definitionVersion}），并在落盘前把要改回的内容给我确认。`;
}

/**
 * 单卡停止 → 交给主控的现成指令。
 * 停卡是改卡状态（pao_change_status），不是改计划定义；页面只提请求，落盘由主控执行。
 */
export function stopCardInstruction(
  plan: TemporaryPlanRow,
  step: TemporaryPlanStepRow,
  cardRefs: readonly string[],
): string {
  return `把临时计划「${plan.displayName}」（计划 ${plan.planId}）第 ${stepIndexLabel(plan, step.stepId)} 步（步骤 ${step.stepId}「${step.title}」）的卡 ${cardRefs.join("、")} 停掉：请用 pao_change_status 改成 canceled 并写明依据；只停这几张卡，不要动计划定义，也不要把整条流程停掉。`;
}

/** 保存为模板 → 交给主控的现成指令。 */
export function saveTemplateInstruction(plan: TemporaryPlanRow, templateName: string): string {
  return `把临时计划「${plan.displayName}」（计划 ${plan.planId}，定义版本 ${plan.definitionVersion}）保存为工作流模板，名字用「${templateName}」。请用 pao_plan_save_template（definition_version=${plan.definitionVersion}）落盘；如果里面有本次特有路径，先把路径列出来问我。`;
}

/** 意见 → 交给主控的现成指令：先记意见，再由主控决定投递。
 * 整体意见走 `目标类型=流程`（不是「空步骤 ID」——空 ID 在内核侧会被拒，也表达不了对象）。 */
export function opinionInstruction(
  plan: TemporaryPlanRow,
  scope: DiscussionScope,
  text: string,
): string {
  const trimmed = text.trim();
  if (scope.kind === "file") {
    const 版本 = scope.versionBasis
      ? `版本依据=${scope.versionBasis}`
      : scope.round !== undefined
        ? `round=${scope.round}`
        : "版本依据用你手上的真实轮次与文件版本";
    return `【${fileScopeLabel(scope)}】${trimmed}\n请用 pao_plan_feedback 记下这条针对文件的意见（计划 ${plan.planId}，定义版本 ${plan.definitionVersion}，目标类型=文件，路径=${scope.path}，${版本}），并告诉我投递结果。`;
  }
  if (scope.kind === "flow") {
    return `【整个流程】${trimmed}\n请用 pao_plan_feedback 记下这条针对整份计划目标的整体意见（计划 ${plan.planId}，定义版本 ${plan.definitionVersion}，目标类型=流程，不要给 step_id），并告诉我投递结果。`;
  }
  const label = scopeLabel(scope, plan);
  return `【${label}】${trimmed}\n请用 pao_plan_feedback 记下这条意见（计划 ${plan.planId}，定义版本 ${plan.definitionVersion}，目标类型=步骤，步骤ID=${scope.stepId}），并告诉我投递结果。`;
}

/** 意见状态分组顺序：未知状态归最后一组，不丢。 */
export const FEEDBACK_STATUS_ORDER = ["已记录", "待送达", "已送达", "投递失败", "已应用"] as const;

export function groupFeedbackByStatus(
  rows: readonly TemporaryPlanFeedbackRow[],
): ReadonlyMap<string, readonly TemporaryPlanFeedbackRow[]> {
  const grouped = new Map<string, TemporaryPlanFeedbackRow[]>();
  for (const row of rows) {
    const key = (FEEDBACK_STATUS_ORDER as readonly string[]).includes(row.status)
      ? row.status
      : "其他";
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }
  // 按固定顺序返回：状态分组在界面上要稳定，不随记录先后跳动；未知状态放最后。
  const ordered = new Map<string, readonly TemporaryPlanFeedbackRow[]>();
  for (const key of [...FEEDBACK_STATUS_ORDER, "其他"]) {
    const bucket = grouped.get(key);
    if (bucket) {
      ordered.set(key, bucket);
    }
  }
  return ordered;
}

/**
 * 待办种类（计划 §8.1）：能落地的五种，加一个「恢复」。
 * - confirm 待确认：人工门等人放行；
 * - missing_input 缺输入：卡读不出来或这一步没有可用的前置产出；
 * - failed 失败：卡失败、预算不足、暂停推进都要人去救；
 * - undelivered 未送达：意见投递失败；
 * - recovery 恢复：实例丢了控制正本 / 计划被撤销，需要人重新接上。
 * 认不出的情况不在这里造条目——宁可少一条，也不给假待办。
 */
export type TodoKind = "confirm" | "missing_input" | "failed" | "undelivered" | "recovery";

export const TODO_KIND_LABELS: Record<TodoKind, string> = {
  confirm: "待你确认",
  missing_input: "缺输入",
  failed: "需要处理",
  undelivered: "未送达",
  recovery: "需要恢复",
};

/**
 * 非颜色信号：待办同样不能只靠颜色区分（计划 §7.1）。
 *
 * 记号是**形状**，不是文案——`[check]`/`[input]`/`[fail]`/`[recover]` 与各自的中文
 * label 说的不是同一个词，并排渲染读得通。
 *
 * `undelivered` 故意**不在**这里：它的中文 label 是「未送达」，若再给个 `[unsent]`，
 * 那就成了同一个词的英文对译而不是形状，中文界面并排渲染会读成「`[unsent]` 未送达」
 * 两种写法（这个混排已经真实发生过）。所以模型不导出这一种的记号：
 * 非颜色信号由 label 本身（文字）承担，记号若有需要由视图决定怎么画，
 * 模型不替视图决定展示形状。新增种类时同理——**只放形状，不放可读文案**。
 */
export const TODO_KIND_ICONS: Partial<Record<TodoKind, string>> = {
  confirm: "[check]",
  missing_input: "[input]",
  failed: "[fail]",
  recovery: "[recover]",
};

/**
 * 一条待办的身份：必须是「哪个实例的哪一步第几轮、哪一版定义」（计划 §8.1）。
 * 旧提醒里带的轮次/版本与现状不一致时，这条待办就是过期的，不能推进新轮次。
 */
export interface TodoIdentity {
  readonly instanceId: string;
  readonly stepId: string;
  /** 第几轮；没有轮次信息就不编（身份里留空，重核对时按「无轮次」比）。 */
  readonly round?: number;
  /** 提出这条待办时看到的定义版本。 */
  readonly definitionVersion: number;
}

export interface TodoItem {
  readonly kind: TodoKind;
  /** 稳定键：多视图（侧栏/看板/主页面）对同一条待办必须得到同一个键，才能只生效一次。 */
  readonly key: string;
  readonly identity: TodoIdentity;
  /** 计划身份与显示名，供界面直接写文案，不让界面自己拼。 */
  readonly planId: string;
  readonly stepTitle?: string;
  /** 内核原文原因；说不出来就不写，界面不给假原因。 */
  readonly reason?: string;
  /** 待办种类文案（英文源串，界面经 t() 取中文）。 */
  readonly label: string;
  /**
   * 非颜色记号（形状）。**没有就是没有**：这类待办不给记号，界面不要拿别的顶上，
   * 也别自己编一个。目前 `undelivered` 没有（中文 label「未送达」本身就是文字信号，
   * 再给 `[unsent]` 会读成同一个词的两种写法）。
   */
  readonly icon?: string;
}

export interface TodoDerivationInput {
  readonly plan: TemporaryPlanRow;
  readonly control: WorkflowControlIdentity | undefined;
  readonly views: readonly StepCardView[];
  /** 界面当前在看的定义版本；缺省用计划自身的版本。 */
  readonly currentDefinitionVersion?: number;
}

/**
 * 待办派生：全部从控制正本、卡进度与持久投递重建，界面不自己存状态（计划 §8.1）。
 * 条目按「实例 → 步骤定义顺序 → 种类」稳定排序，重开/刷新后顺序不跳。
 */
export function deriveTodos(input: TodoDerivationInput): readonly TodoItem[] {
  const { plan, control, views } = input;
  const definitionVersion = input.currentDefinitionVersion ?? plan.definitionVersion;
  const instanceId = control?.instanceId ?? "";
  const items: TodoItem[] = [];
  const todos: TodoItem[] = [];

  // 恢复类：控制正本读不到、或计划已被撤销，都是「需要人重新接上」而不是「正常待办」。
  if (control === undefined) {
    todos.push(
      makeTodo("recovery", { instanceId, stepId: "", definitionVersion }, plan, {
        reason: "还没有运行实例，或控制正本读不到",
      }),
    );
  } else if (plan.undone) {
    todos.push(
      makeTodo("recovery", { instanceId, stepId: "", definitionVersion }, plan, {
        reason: "这份计划已被撤销",
      }),
    );
  }

  for (const view of views) {
    const round = view.round;
    const identity: TodoIdentity = {
      instanceId,
      stepId: view.step.stepId,
      ...(round === undefined ? {} : { round }),
      definitionVersion,
    };
    if (view.state === "review") {
      todos.push(
        makeTodo("confirm", identity, plan, {
          stepTitle: view.step.title,
          ...(view.holdReason === undefined ? {} : { reason: view.holdReason }),
        }),
      );
    }
    if (view.progress?.readProblem !== undefined || view.state === "unreadable") {
      todos.push(
        makeTodo("missing_input", identity, plan, {
          stepTitle: view.step.title,
          reason: view.progress?.readProblem ?? "这一步的卡读不出来",
        }),
      );
    }
    if (view.state === "failed" || view.state === "budget" || view.state === "paused") {
      todos.push(
        makeTodo("failed", identity, plan, {
          stepTitle: view.step.title,
          ...(view.holdReason === undefined ? {} : { reason: view.holdReason }),
        }),
      );
    }
  }

  // 未送达的意见：内核真值就是「投递失败」，界面不重投、只把它摆出来。
  for (const row of plan.feedback) {
    if (row.status !== "投递失败") {
      continue;
    }
    const stepId = row.stepId ?? "";
    const round = row.round;
    todos.push(
      makeTodo(
        "undelivered",
        {
          instanceId,
          stepId,
          ...(round === undefined ? {} : { round }),
          // 意见自己带了提交时的定义版本：待办身份用它，不用当前版本顶替。
          definitionVersion: row.definitionVersion,
        },
        plan,
        {
          ...(row.detail === undefined ? {} : { reason: row.detail }),
          feedbackId: row.feedbackId,
        },
      ),
    );
  }

  items.push(...todos);
  return items.sort(compareTodos(views, plan));
}

/** 待办排序：实例内按步骤定义顺序，同一步内按种类固定顺序；恢复类（无步骤）排最前。 */
function compareTodos(
  views: readonly StepCardView[],
  plan: TemporaryPlanRow,
): (a: TodoItem, b: TodoItem) => number {
  const order: readonly TodoKind[] = ["recovery", "confirm", "missing_input", "failed", "undelivered"];
  const stepIndex = (stepId: string): number => {
    if (stepId === "") {
      return -1;
    }
    const index = plan.steps.findIndex((step) => step.stepId === stepId);
    return index >= 0 ? index : views.length;
  };
  return (a, b) =>
    a.identity.instanceId.localeCompare(b.identity.instanceId) ||
    stepIndex(a.identity.stepId) - stepIndex(b.identity.stepId) ||
    order.indexOf(a.kind) - order.indexOf(b.kind) ||
    a.key.localeCompare(b.key);
}

function makeTodo(
  kind: TodoKind,
  identity: TodoIdentity,
  plan: TemporaryPlanRow,
  extra: { stepTitle?: string; reason?: string; feedbackId?: string },
): TodoItem {
  // 没有记号就不写这个字段（不是空串）：界面用 todo.icon 的真假决定画不画，
  // 空串会画出一个空的记号框，等于给了个假记号。
  const icon = TODO_KIND_ICONS[kind];
  return {
    kind,
    key: todoKey(kind, identity, extra.feedbackId),
    identity,
    planId: plan.planId,
    ...(extra.stepTitle === undefined ? {} : { stepTitle: extra.stepTitle }),
    ...(extra.reason === undefined ? {} : { reason: extra.reason }),
    label: TODO_KIND_LABELS[kind],
    ...(icon === undefined ? {} : { icon }),
  };
}

/**
 * 待办稳定键：同一条待办在不同视图（侧栏/看板/主页面）必须算出同一个键。
 * 键里带轮次与定义版本：旧轮次的提醒不会命中新轮次的待办，因此不会被重复处理。
 */
export function todoKey(
  kind: TodoKind,
  identity: TodoIdentity,
  feedbackId?: string,
): string {
  const parts = [
    kind,
    identity.instanceId,
    identity.stepId,
    identity.round === undefined ? "" : String(identity.round),
    String(identity.definitionVersion),
  ];
  if (feedbackId !== undefined) {
    parts.push(feedbackId);
  }
  return parts.join("\u0000");
}

/**
 * 待办是否还对着当前现实（计划 §8.1「处理绑定实例/步骤/轮次/版本，旧提醒不推进新轮次」）。
 *
 * 判据只有两条，都可核：
 * - 定义版本对不上＝提醒是照着旧定义提的（计划改过），不能拿它去推进新定义；
 * - 轮次对不上＝提醒说的是上一轮，那一轮已经翻篇（新轮次有自己的待办）。
 * 缺轮次信息的待办不做轮次比较（没有信息就不判过期，避免把好待办误杀）。
 */
export function isTodoStale(
  todo: TodoItem,
  current: { readonly instanceId: string; readonly round?: number; readonly definitionVersion: number },
): boolean {
  if (todo.identity.instanceId !== current.instanceId) {
    return true;
  }
  if (todo.identity.definitionVersion !== current.definitionVersion) {
    return true;
  }
  if (todo.identity.round !== undefined && current.round !== undefined) {
    return todo.identity.round !== current.round;
  }
  return false;
}

/** 过期待办的说明文案：说清为什么不能照着做，界面据此禁用动作。 */
export function staleTodoText(todo: TodoItem, current: {
  readonly round?: number;
  readonly definitionVersion: number;
}): string | undefined {
  if (todo.identity.definitionVersion !== current.definitionVersion) {
    return `这条待办是照着第 ${todo.identity.definitionVersion} 版定义提的，现在是第 ${current.definitionVersion} 版，请刷新后再处理`;
  }
  if (todo.identity.round !== undefined && current.round !== undefined && todo.identity.round !== current.round) {
    return `这条待办说的是第 ${todo.identity.round} 轮，现在是第 ${current.round} 轮，请刷新后再处理`;
  }
  return undefined;
}

/**
 * 草稿身份键（计划 §7.2「刷新/投影新对象不重置未提交字段，按稳定身份/版本判断初始值」）。
 *
 * 必须是「哪个对象的哪一版」：切步骤/项目/会话再返回要能找回同一份草稿，
 * 而换到别的对象（或同一对象的新版本）时不能串。所以键里带对象身份 + 定义版本。
 */
export type DraftPurpose = "opinion" | "note" | "step_edit";

export interface DraftIdentityInput {
  readonly planId: string;
  /** 讨论对象：整个流程、某一步、或某个文件轮次。 */
  readonly scope: DiscussionScope;
  /** 写这份草稿时正在看的定义版本。 */
  readonly definitionVersion: number;
  readonly purpose: DraftPurpose;
}

/**
 * 草稿稳定键。用途也进键里：同一步上的「意见草稿」与「修改步骤草稿」是两份东西，
 * 不能互相顶掉（计划 §7.2 表「仅形成草稿」）。
 */
export function draftKey(input: DraftIdentityInput): string {
  return [
    "draft",
    input.planId,
    input.purpose,
    discussionScopeKey(input.scope),
    String(input.definitionVersion),
  ].join("\u0000");
}

/** 一份草稿的当前状态：值是用户没提交的输入，版本是写下它时的依据。 */
export interface DraftState {
  readonly key: string;
  readonly text: string;
  /** 写下这份草稿时正在看的定义版本。 */
  readonly definitionVersion: number;
  /** 写下这份草稿时的轮次（文件/步骤对象有轮次时）。 */
  readonly round?: number;
}

/** 版本比对结论：只有「一致」才允许静默提交。 */
export type DraftConflictKind = "none" | "definition_changed" | "round_changed" | "object_gone";

export interface DraftConflict {
  readonly kind: DraftConflictKind;
  /** 冲突说明文案；kind=ok 时为 undefined。 */
  readonly message?: string;
  /** 新值摘要（可用定义版本/轮次/步骤标题），供界面「查看新值」。 */
  readonly currentValue?: string;
}

/**
 * 同对象外部修改的判定（计划 §7.2）：保留草稿，提示版本冲突，可查看新值/重提，不能静默覆盖。
 *
 * 只比对可核的版本事实，不比对正文内容（正文差异由用户决定要不要重提）：
 * - 轮次变了：文件/步骤翻到新一轮，旧草稿是对旧轮说的；
 * - 定义版本变了：外部改过这份计划；
 * - 对象没了：草稿挂的步骤/文件已不在当前计划里。
 *
 * 【修正三 · 判定次序与「没有底账」】
 * 现象：文件翻到新一轮时，草稿被报成「对象找不到了」；且第一次给某个文件提意见会被误拦。
 * 根因：(1) 原来先判对象是否存在，而轮次变化会让路径在新轮次里「看起来不在账上」，
 *   于是把「对象翻轮了」误报成「对象消失了」——话说岔了，用户会以为文件被删；
 *   (2) `scopeStillExists` 对文件按 feedback 记过的路径核，计划里一条文件意见都没有时
 *   返回 false，把「没有底账可比」当成了「文件没了」。
 * 改法：(1) 次序改为 轮次 → 定义版本 → 对象是否还在，让轮次差异先解释冲突；
 *   (2) 计划里没有任何文件意见时视为「无底账」，不判消失（有底账之后路径不在账上才算没了）。
 *
 * 已知投影局限：文件对象的存在性目前只能按 `plan.feedback` 记过的路径核——
 * `TemporaryPlanRow` 不含产物行（artifacts 只在进度行上），所以「文件被外部删除」这种
 * 边界判不出来，本轮不做。若要做硬判定需把 progress 传进来，那会改动本函数签名并波及
 * 调用点，收益仅此一种边界，故保持现状。
 *
 * 次序上先比轮次、再比定义版本、最后才判对象还在不在：轮次对不上本身就能解释
 * 「为什么对不上」，这时候报「对象找不到了」会把话说岔（对象只是翻轮了，没消失）。
 * 判不出来（比如草稿或当前对象本来就没轮次）就跳过该项，避免拦住正常提交。
 */
export function detectDraftConflict(
  draft: DraftState,
  current: {
    readonly plan: TemporaryPlanRow;
    readonly scope: DiscussionScope;
    /** 当前该对象的轮次；没有轮次信息的对象不给。 */
    readonly round?: number;
  },
): DraftConflict {
  if (draft.round !== undefined && current.round !== undefined && draft.round !== current.round) {
    return {
      kind: "round_changed",
      message: `你写这份草稿时是第 ${draft.round} 轮，现在是第 ${current.round} 轮；草稿保留着，请确认新值后再提交`,
      currentValue: `第 ${current.round} 轮`,
    };
  }
  if (draft.definitionVersion !== current.plan.definitionVersion) {
    return {
      kind: "definition_changed",
      message: `你写这份草稿时是第 ${draft.definitionVersion} 版定义，现在是第 ${current.plan.definitionVersion} 版；草稿保留着，请确认新值后再提交`,
      currentValue: `第 ${current.plan.definitionVersion} 版定义`,
    };
  }
  if (!scopeStillExists(current.plan, current.scope)) {
    return {
      kind: "object_gone",
      message: "这份草稿挂的对象在当前计划里已经找不到了，请重新选一个对象再提交",
    };
  }
  return { kind: "none" };
}

/** 草稿挂的对象还在不在当前计划里（步骤按 ID、文件按路径，绝不按序号/标题猜）。 */
export function scopeStillExists(plan: TemporaryPlanRow, scope: DiscussionScope): boolean {
  if (scope.kind === "flow") {
    return true;
  }
  if (scope.kind === "step") {
    return plan.steps.some((step) => step.stepId === scope.stepId);
  }
  // 文件的「在不在」只能按内核记过的路径核，不按标题猜。但计划里一条文件意见都没有时
  // 是「没有底账可比」，不是「这个文件没了」：没证据就不判消失，免得把第一次提意见
  // 都拦成对象已丢。有底账之后，路径不在账上才算真的找不到了。
  const fileRows = plan.feedback.filter((row) => row.targetKind === "文件");
  if (fileRows.length === 0) {
    return true;
  }
  return fileRows.some((row) => row.target === scope.path);
}

/** 草稿能提交吗：有冲突就不许静默覆盖，界面必须让用户先看新值。 */
export function canSubmitDraft(conflict: DraftConflict): boolean {
  return conflict.kind === "none";
}
