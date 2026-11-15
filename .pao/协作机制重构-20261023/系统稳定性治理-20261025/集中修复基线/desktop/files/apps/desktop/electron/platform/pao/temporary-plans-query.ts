/**
 * 临时计划只读查询桥（通用工作台阶段 4）。
 *
 * 与 flow-control-query 同一口径：project 只由主进程按已登记 workspaceId 解析后传入，
 * 本模块不收渲染层路径；所有失败都落成可展示的 failed 结果，不把异常抛到主进程顶层，
 * 也绝不把读失败伪装成「还没有计划」（坏定义/坏关联进 issues）。
 *
 * 本模块只有查询：创建/修改/撤销/启动/保存模板由主控经内核工具发起，桌面不另开写入通道。
 */
import { loadDriver, reasonOf } from "./bridge-common";
import type { PaoDesktopPlanModule } from "@pi-gui/pi-sdk-driver";
import type {
  TemporaryPlanArtifactContentInput,
  TemporaryPlanArtifactContentResult,
  TemporaryPlanArtifactReadCode,
  TemporaryPlanArtifactRow,
  TemporaryPlanBackEdgeRow,
  TemporaryPlanBudgetRow,
  TemporaryPlanFeedbackRow,
  TemporaryPlanReadProblemRow,
  TemporaryPlanRow,
  TemporaryPlanStartRow,
  TemporaryPlanStepProgressRow,
  TemporaryPlanStepRecordRow,
  TemporaryPlanStepRow,
  TemporaryPlanWaitRow,
  TemporaryPlansIssueRow,
  TemporaryPlansQueryInput,
  TemporaryPlansResult,
} from "../../../contracts/temporary-plans";

function fail(message: string): never {
  throw new Error(`[TEMPORARY_PLANS_QUERY] ${message}`);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name}不是对象。`);
  return value as Record<string, unknown>;
}

function list(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) fail(`${name}列表字段缺失。`);
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${name}缺失或为空。`);
  return value;
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(`${name}不是文本。`);
  return value.trim() ? value : undefined;
}

function bool(value: unknown): boolean {
  return value === true;
}

function positiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    fail(`${name}不是正整数。`);
  return value;
}

/**
 * 可选文本列表：字段缺失就是 `undefined`（不是空数组）——「没登记输入」与「登记了空输入」
 * 在定义里本就不该混同；给了就必须每项是非空文本，坏形状显式失败不静默丢弃。
 */
function optionalTextList(value: unknown, name: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const items = list(value, name);
  if (items.length === 0) return undefined;
  return items.map((item, index) => text(item, `${name}[${index}]`));
}

/** 可选正整数（预算各项）：给 0 是形状错误（0 轮上限无意义），缺失才算「没设」。 */
function optionalPositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    fail(`${name}不是正整数。`);
  return value;
}

/**
 * 预算对象：四项都可缺，**没设就不写这个键，界面不许填 0**。
 * 整个对象四项全缺时返回 undefined（＝未配预算），而不是 `{}` 或全零——
 * 「未配预算」与「预算为 0」在语义上是两件事，合并会让界面把没配预算显示成没有额度。
 */
function normalizeBudget(value: unknown): TemporaryPlanBudgetRow | undefined {
  if (value === undefined || value === null) return undefined;
  const row = record(value, "步骤预算");
  const turns = optionalPositiveInt(row.turns, "预算轮次");
  const toolCalls = optionalPositiveInt(row.toolCalls, "预算工具调用");
  const cost = optionalPositiveInt(row.cost, "预算费用");
  const collabQuota = optionalPositiveInt(row.collab_quota, "预算协作额度");
  if (
    turns === undefined &&
    toolCalls === undefined &&
    cost === undefined &&
    collabQuota === undefined
  )
    return undefined;
  return {
    ...(turns === undefined ? {} : { turns }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(cost === undefined ? {} : { cost }),
    ...(collabQuota === undefined ? {} : { collabQuota }),
  };
}

/** 审核退回边：目标/上限/超限动作都是内核配方原文，界面对超限动作只显示不翻译。 */
function normalizeBackEdge(value: unknown): TemporaryPlanBackEdgeRow {
  const row = record(value, "步骤回边");
  const maxRounds = row.上限;
  if (typeof maxRounds !== "number" || !Number.isSafeInteger(maxRounds) || maxRounds < 1)
    fail("步骤回边上限不是正整数。");
  return {
    target: text(row.目标, "回边目标"),
    maxRounds,
    overLimitAction: text(row.超限动作, "回边超限动作"),
  };
}

function normalizeStep(value: unknown): TemporaryPlanStepRow {
  const row = record(value, "计划步骤");
  const expected = optionalText(row.预期成果, "步骤预期成果");
  const inputs = optionalTextList(row.输入, "步骤输入");
  const deptStandard = optionalText(row.部门标准, "步骤部门标准");
  const constraints = optionalText(row.约束, "步骤约束");
  const tier = optionalText(row.档位, "步骤档位");
  const priority = optionalText(row.优先级, "步骤优先级");
  const skills = optionalTextList(row.技能, "步骤技能");
  const budget = normalizeBudget(row.预算);
  const backEdges =
    row.回边 === undefined || row.回边 === null
      ? undefined
      : list(row.回边, "步骤回边").map(normalizeBackEdge);
  return {
    stepId: text(row.步骤ID, "步骤ID"),
    title: text(row.标题, "步骤标题"),
    dept: text(row.部门, "步骤部门"),
    requirement: text(row.要求, "步骤要求"),
    ...(expected === undefined ? {} : { expectedArtifacts: expected }),
    ...(inputs === undefined ? {} : { inputs }),
    dependsOn: list(row.依赖, "步骤依赖").map((item, index) =>
      text(item, `步骤依赖第 ${index + 1} 项`),
    ),
    humanGate: bool(row.人工门),
    readOnly: bool(row.只读),
    audit: bool(row.审核),
    ...(deptStandard === undefined ? {} : { deptStandard }),
    ...(constraints === undefined ? {} : { constraints }),
    ...(tier === undefined ? {} : { tier }),
    ...(budget === undefined ? {} : { budget }),
    ...(priority === undefined ? {} : { priority }),
    ...(skills === undefined ? {} : { skills }),
    ...(backEdges === undefined || backEdges.length === 0 ? {} : { backEdges }),
  };
}

function normalizeArtifact(value: unknown): TemporaryPlanArtifactRow {
  const row = record(value, "步骤产物");
  const note = optionalText(row.说明, "步骤产物说明");
  return {
    path: text(row.路径, "产物路径"),
    relativePath: text(row.相对路径, "产物相对路径"),
    round: positiveInt(row.轮次, "产物轮次"),
    card: text(row.卡号, "产物卡号"),
    versionBasis: text(row.版本依据, "产物版本依据"),
    currentRound: bool(row.当前轮),
    exists: bool(row.存在),
    ...(note === undefined ? {} : { note }),
  };
}

/** 审核步骤没登记部门标准：定义缺陷单独说，不补一个默认标准冒充有标准。 */
const AUDIT_STANDARD_MISSING = "审核步骤未登记部门标准。";

/**
 * 读不出来的原因 → 稳定错误码。原因文本在主进程与渲染层之间只走一次，
 * 界面要分支时必须落在这些码上，不去猜中文（§8.3 稳定错误码）。
 */
const READ_PROBLEM_CODES: readonly (readonly [RegExp, string])[] = [
  [/目录不存在|不存在|找不到/, "missing"],
  [/越界|不在工作区|不在计划/, "out-of-root"],
  [/链接|符号/, "symlink"],
  [/权限|EACCES|EPERM|拒绝/, "permission-denied"],
  [/过大|太大|超出/, "too-large"],
  [/不支持|二进制|编码/, "unsupported"],
];

function readProblemCode(message: string): string {
  for (const [pattern, code] of READ_PROBLEM_CODES) if (pattern.test(message)) return code;
  return "unknown";
}

/** 从「读不了控制清单」这类问题文本里认出对应步骤；认不出就让界面说「有步骤读不出来」。 */
function stepIdOfReadProblem(message: string): string | undefined {
  const id = /stepId=([^\s]+)/.exec(message)?.[1];
  if (id) return id;
  const chinese = /步骤\s*([^\s（(]+)/.exec(message)?.[1];
  return chinese || undefined;
}

function normalizeReadProblem(value: unknown): TemporaryPlanReadProblemRow {
  const row = record(value, "步骤读取问题");
  const message = text(row.说明, "读取问题说明");
  const rawStep = optionalText(row.步骤ID, "读取问题步骤ID");
  const stepId = rawStep ?? stepIdOfReadProblem(message);
  return {
    ...(stepId === undefined ? {} : { stepId }),
    code: readProblemCode(message),
    message,
  };
}

function normalizeRecord(value: unknown): TemporaryPlanStepRecordRow {
  const row = record(value, "步骤执行记录");
  const verdict = optionalText(row.判定, "执行记录判定");
  const reason = optionalText(row.原因, "执行记录原因");
  return {
    round: positiveInt(row.轮次, "执行记录轮次"),
    cards: list(row.卡, "执行记录卡引用").map((item, index) =>
      text(item, `执行记录卡引用[${index}]`),
    ),
    ...(verdict === undefined ? {} : { verdict }),
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * 等待阻塞来源：内核把依赖完成情况算在控制正本里，这里直接投影成「还差哪几步」。
 * 没给出可判定的依赖信息时返回 `undefined`，界面按「等待前序」显示但不编造步骤号。
 */
function normalizeBlockedBy(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) fail("阻塞依赖不是列表。");
  return value.map((item, index) => text(item, `阻塞依赖[${index}]`));
}

/** 等待归类：内核明确给出才认，未给则按状态与挂起原文保守归类，不把未知译成成功。 */
function normalizeWaitKind(value: unknown, status: string, hold: string | undefined): string {
  const declared = optionalText(value, "等待归类");
  if (declared !== undefined) return declared;
  if (hold === undefined) return "none";
  if (/部长|拆解|绑定/.test(hold)) return "minister";
  if (/审核|复核|判定/.test(hold)) return "audit";
  if (/确认|人工/.test(hold)) return "confirm";
  if (/预算|额度|费用/.test(hold)) return "budget";
  if (/暂停/.test(hold)) return "paused";
  if (/失败|取消|终止/.test(hold)) return "failed";
  return "unknown";
}

function normalizeProgress(value: unknown): TemporaryPlanStepProgressRow {
  const row = record(value, "步骤进度");
  const round = row.轮次 === undefined ? undefined : positiveInt(row.轮次, "步骤轮次");
  const hold = optionalText(row.挂起, "步骤挂起原因");
  const confirmed = optionalText(row.已确认, "步骤确认时刻");
  const readProblem = optionalText(row.读取问题, "步骤读取问题");
  const status = text(row.状态, "步骤状态");
  const cards = list(row.卡, "步骤卡引用").map((item, index) => text(item, `步骤卡引用[${index}]`));
  // 历史轮次的卡引用：多卡步骤要逐一可打开，只看当前轮会把上一轮的稿子藏掉。
  // 这是本批新增的投影字段：旧内核不给就没有，不是坏形状——缺了退回只看当前轮卡的旧口径。
  const rawExtraCards = row.全部卡;
  const extraCards =
    rawExtraCards === undefined || rawExtraCards === null
      ? []
      : list(rawExtraCards, "步骤全部卡引用").map((item, index) =>
          text(item, `步骤全部卡引用[${index}]`),
        );
  const allCards = [...cards, ...extraCards.filter((card) => !cards.includes(card))];
  const declaredBlockedBy = normalizeBlockedBy(row.阻塞依赖);
  // 内核没给阻塞来源但有挂起原文时，只能确定「在等」，等谁不知道——给空列表而不猜步骤号。
  const blockedBy = declaredBlockedBy ?? [];
  const waitKind = normalizeWaitKind(row.等待归类, status, hold);
  const wait: TemporaryPlanWaitRow =
    hold === undefined && waitKind === "none"
      ? { blockedBy, waitKind: "none" }
      : { blockedBy, waitKind };
  const rawProblems =
    row.读取问题列表 === undefined || row.读取问题列表 === null
      ? []
      : list(row.读取问题列表, "步骤读取问题列表").map(normalizeReadProblem);
  const readProblems =
    rawProblems.length > 0
      ? rawProblems.map((problem) =>
          problem.stepId === undefined
            ? { ...problem, stepId: text(row.步骤ID, "进度步骤ID") }
            : problem,
        )
      : readProblem === undefined
        ? []
        : [
            {
              stepId: text(row.步骤ID, "进度步骤ID"),
              code: readProblemCode(readProblem),
              message: readProblem,
            },
          ];
  return {
    stepId: text(row.步骤ID, "进度步骤ID"),
    status,
    ...(round === undefined ? {} : { round }),
    ...(hold === undefined ? {} : { hold }),
    wait,
    ...(confirmed === undefined ? {} : { confirmed }),
    needsConfirmation: bool(row.需要人工确认),
    awaitingConfirmation: bool(row.等待人工确认),
    cards,
    allCards,
    depsSettled: bool(row.依赖已完成),
    records: list(row.记录, "步骤执行记录").map(normalizeRecord),
    ...(readProblem === undefined ? {} : { readProblem }),
    readProblems,
    artifacts: list(row.产出, "步骤产物").map(normalizeArtifact),
  };
}

/** 步骤引用集合：多卡步骤的卡引用与执行记录里的卡引用合并，界面据它反复核实任意一张卡。 */
function referencedCards(plan: TemporaryPlanRow): readonly string[] {
  const cards = new Set<string>();
  for (const start of plan.starts)
    for (const progress of start.progress) {
      for (const card of progress.cards) cards.add(card);
      for (const card of progress.allCards) cards.add(card);
      for (const record of progress.records) for (const card of record.cards) cards.add(card);
    }
  return [...cards];
}

/**
 * 逐条提取卡/控制读不出来的问题（§7.1「坏卡/缺映射单独报，正常节点继续可读」）：
 * 每张读不出来的卡单独上报，声明了步骤的挂到那一步，没有的只做计划级提示——
 * 不合成一句「控制清单读取失败」，也不因为其中一张卡坏掉就让整份计划变成不可读。
 */
function extractReadProblems(
  bridge: PaoDesktopPlanModule,
  project: string,
  plan: TemporaryPlanRow,
): {
  readonly planProblems: readonly TemporaryPlanReadProblemRow[];
  readonly byStep: ReadonlyMap<string, readonly TemporaryPlanReadProblemRow[]>;
} {
  const probe = (
    bridge as unknown as {
      describePlanReadProblems?: (
        project: string,
        planId: string,
        cards: readonly string[],
      ) => unknown;
    }
  ).describePlanReadProblems;
  if (typeof probe !== "function") return { planProblems: [], byStep: new Map() };
  let rows: unknown;
  try {
    rows = probe.call(bridge, project, plan.planId, referencedCards(plan));
  } catch {
    // 逐条上报取不到不应该让整份计划读不出来：主读路径已经有过 issues，这里退化成"没有问题明细"。
    return { planProblems: [], byStep: new Map() };
  }
  const planProblems: TemporaryPlanReadProblemRow[] = [];
  const byStep = new Map<string, TemporaryPlanReadProblemRow[]>();
  for (const value of Array.isArray(rows) ? rows : []) {
    const problem = normalizeReadProblem(value);
    planProblems.push(problem);
    if (problem.stepId === undefined) continue;
    const bucket = byStep.get(problem.stepId);
    if (bucket) bucket.push(problem);
    else byStep.set(problem.stepId, [problem]);
  }
  return { planProblems, byStep };
}

/** 把逐条问题挂到步骤上：只加不减，重复的按 code+message 去重，避免同一坏卡报两遍。 */
function attachReadProblems(
  plan: TemporaryPlanRow,
  extras: ReadonlyMap<string, readonly TemporaryPlanReadProblemRow[]>,
): TemporaryPlanRow {
  if (extras.size === 0) return plan;
  const starts = plan.starts.map((start) => ({
    ...start,
    progress: start.progress.map((progress) => {
      const more = extras.get(progress.stepId);
      if (!more || more.length === 0) return progress;
      const seen = new Set(progress.readProblems.map((row) => `${row.code}\u0000${row.message}`));
      const merged = [...progress.readProblems];
      for (const row of more)
        if (!seen.has(`${row.code}\u0000${row.message}`)) {
          seen.add(`${row.code}\u0000${row.message}`);
          merged.push(row);
        }
      return merged.length === progress.readProblems.length
        ? progress
        : { ...progress, readProblems: merged, readProblem: merged[0]?.message };
    }),
  }));
  return { ...plan, starts };
}

function normalizeStart(value: unknown): TemporaryPlanStartRow {
  const row = record(value, "启动关联");
  return {
    startRequestId: text(row.启动请求ID, "启动请求ID"),
    instanceId: text(row.实例, "实例"),
    recipeName: text(row.配方名, "配方名"),
    workspace: text(row.工作区, "工作区"),
    cardDir: text(row.卡目录, "卡目录"),
    controlPath: text(row.控制清单, "控制清单"),
    ownerSessionId: text(row.owner会话, "owner 会话"),
    acceptedAt: text(row.受理时刻, "受理时刻"),
    status: text(row.状态, "控制状态"),
    progress: list(row.进度, "启动进度").map(normalizeProgress),
  };
}

/**
 * 意见目标：流程用固定标签，步骤用稳定步骤 ID，文件用已确认路径＋轮次；界面据此把三种对象分开显示。
 * 版本绑定（定义版本、文件意见的步骤/轮次/版本依据）必须一起投影：丢了它们，界面分不清
 * 「这条意见是对哪一版说的」，旧稿意见看上去就会像贴在新稿上。
 */
function normalizeFeedback(value: unknown): TemporaryPlanFeedbackRow {
  const row = record(value, "计划意见");
  const target = record(row.目标, "意见目标");
  const kind = text(target.类型, "意见目标类型");
  // 流程级意见没有步骤 ID：不给它一个空串（空串会被 text() 判失败，连累整份计划查询）。
  const targetId =
    kind === "文件"
      ? text(target.路径, "意见文件路径")
      : kind === "流程"
        ? "流程"
        : text(target.步骤ID, "意见步骤ID");
  const delivery = row.投递 === undefined ? undefined : record(row.投递, "意见投递");
  const application = row.应用 === undefined ? undefined : record(row.应用, "意见应用");
  const detail = optionalText(delivery?.结果, "意见投递结果") ?? optionalText(row.正文, "意见正文");
  const stepId = kind === "文件" ? optionalText(target.步骤ID, "意见文件步骤ID") : undefined;
  const round = kind === "文件" ? positiveInt(target.轮次, "意见文件轮次") : undefined;
  const versionBasis =
    kind === "文件" ? optionalText(target.版本依据, "意见文件版本依据") : undefined;
  const appliedBasis = optionalText(application?.依据, "意见应用依据");
  return {
    feedbackId: text(row.意见ID, "意见ID"),
    target: targetId,
    targetKind: kind,
    status: text(row.状态, "意见状态"),
    definitionVersion: positiveInt(row.定义版本, "意见定义版本"),
    ...(stepId === undefined ? {} : { stepId }),
    ...(round === undefined ? {} : { round }),
    ...(versionBasis === undefined ? {} : { versionBasis }),
    recordedAt: text(row.记录时刻, "意见记录时刻"),
    ...(appliedBasis === undefined ? {} : { appliedBasis }),
    ...(detail === undefined ? {} : { detail }),
  };
}

function normalizePlan(value: unknown): TemporaryPlanRow {
  const row = record(value, "计划");
  const source = optionalText(row.来源会话, "来源会话");
  const rawProblems =
    row.读取问题 === undefined || row.读取问题 === null
      ? []
      : list(row.读取问题, "计划读取问题").map(normalizeReadProblem);
  return {
    planId: text(row.计划ID, "计划ID"),
    displayName: text(row.显示名, "显示名"),
    definitionVersion: positiveInt(row.定义版本, "定义版本"),
    undone: bool(row.已撤销),
    ...(source === undefined ? {} : { sourceSessionId: source }),
    createdAt: text(row.创建时刻, "创建时刻"),
    updatedAt: text(row.更新时刻, "更新时刻"),
    steps: list(row.步骤, "计划步骤").map((step) => normalizeStep(step)),
    starts: list(row.启动, "计划启动").map(normalizeStart),
    feedback: list(row.意见, "计划意见").map(normalizeFeedback),
    readProblems: rawProblems,
  };
}

async function loadDefaultModule(
  options: TemporaryPlansQueryOptions = {},
): Promise<PaoDesktopPlanModule> {
  return options.loadModule?.() ?? (await loadDriver("loadPaoDesktopPlans"))();
}

export interface TemporaryPlansQueryOptions {
  /** Overrides the lazy driver import (tests). */
  readonly loadModule?: () => Promise<PaoDesktopPlanModule>;
  /** 读盘实现（测试注入）；缺省走 Node fs。 */
  readonly fs?: ArtifactFs;
  /** 取真实路径（越界与符号链接判定）；缺省走 Node fs。 */
  readonly realpath?: (path: string) => Promise<string>;
}

/** 读盘接口：正文读取只用到这四件事，测试可整体替换，不必真去碰盘。 */
export interface ArtifactFs {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<ArtifactStat>;
  readFile(path: string): Promise<Buffer>;
  /** 只读前 `length` 字节（超限文件不全读，避免为了报错把大文件灌进内存）。 */
  readPrefix(path: string, length: number): Promise<Buffer>;
}

/** 文件状态的最小子集：只要判定类型、大小和时刻，不留 Node 类型依赖。 */
export interface ArtifactStat {
  readonly size: number;
  readonly mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface TemporaryPlansQuery {
  collect(project: string, input: TemporaryPlansQueryInput): Promise<TemporaryPlansResult>;
  /** 成果正文只读读取：身份、范围、目标三段核完才给正文，任何一段不过都明确报原因。 */
  readArtifactContent(
    project: string,
    input: TemporaryPlanArtifactContentInput,
  ): Promise<TemporaryPlanArtifactContentResult>;
}

export function createTemporaryPlansQuery(
  options: TemporaryPlansQueryOptions = {},
): TemporaryPlansQuery {
  const module = () => options.loadModule?.() ?? loadDefaultModule();
  return {
    async collect(project, input): Promise<TemporaryPlansResult> {
      try {
        const bridge = await module();
        const read = record(await bridge.readDesktopPlans(project), "临时计划返回");
        const issues: TemporaryPlansIssueRow[] = list(read.问题, "临时计划问题").map((value) => {
          const row = record(value, "临时计划问题行");
          return { path: text(row.路径, "问题路径"), message: text(row.说明, "问题说明") };
        });
        const rawPlans = list(read.计划, "临时计划");
        // 读不出来的卡逐条上报：坏一张卡只牵连它自己那一步，正常节点照旧可读。
        const problems = rawPlans.map((value) =>
          extractReadProblems(bridge, project, normalizePlan(value)),
        );
        const normalized = rawPlans.map((value, index) =>
          attachReadProblems(normalizePlan(value), problems[index]?.byStep ?? new Map()),
        );
        const wanted = input.planId?.trim();
        if (!wanted) return { state: "ok", plans: normalized, issues };
        const matchedIndex = normalized.findIndex((plan) => plan.planId === wanted);
        if (matchedIndex < 0) {
          // 计划 ID 是主控给出的稳定身份：查不到就是「不在当前项目」，
          // 不能返回空列表让界面显示成「还没有计划」。
          return { state: "failed", message: `计划不在当前项目：${wanted}` };
        }
        const matchedProblems = problems[matchedIndex]?.planProblems ?? [];
        return {
          state: "ok",
          plans: [normalized[matchedIndex]!],
          issues:
            matchedProblems.length === 0
              ? issues
              : [
                  ...issues,
                  ...matchedProblems.map((problem) => ({
                    path: problem.stepId === undefined ? wanted : `${wanted}#${problem.stepId}`,
                    message: problem.message,
                  })),
                ],
        };
      } catch (error) {
        return { state: "failed", message: reasonOf(error) };
      }
    },
    async readArtifactContent(project, input) {
      return readArtifactContent(options, project, input);
    },
  };
}

/** 正文上限：超过就只给前一段并明确标记截断，不静默给半截冒充全文。 */
export const ARTIFACT_CONTENT_LIMIT_BYTES = 256 * 1024;

/** 文本扩展名白名单：不在里面的按「不支持」拒绝，不做「大概能读」的猜测。 */
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".csv",
  ".tsv",
  ".log",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".ps1",
  ".sh",
  ".bat",
  ".sql",
  ".diff",
  ".patch",
]);

function nodeModule(): Promise<typeof import("node:fs/promises")> {
  return import("node:fs/promises");
}

function readCodeOf(error: unknown): { code: TemporaryPlanArtifactReadCode; message: string } {
  const code = (error as { code?: string } | null | undefined)?.code;
  const raw = reasonOf(error);
  if (code === "ENOENT") return { code: "missing", message: `文件不存在：${raw}` };
  if (code === "EACCES" || code === "EPERM")
    return { code: "permission-denied", message: `没有读取权限：${raw}` };
  if (code === "EISDIR") return { code: "unsupported", message: `这是目录不是文件：${raw}` };
  if (code === "ELOOP") return { code: "symlink", message: `路径是符号链接：${raw}` };
  return { code: "unknown", message: raw };
}

/**
 * 取「正文读取要认的那条产物」：四元身份全对上才算数——
 * 启动请求 ID + 步骤 ID + 相对路径 + 轮次，再核版本依据。
 * 只有一条能匹配；匹配不上就报身份不对，不去猜「大概是这一条」。
 */
function findArtifact(
  plan: TemporaryPlanRow,
  input: TemporaryPlanArtifactContentInput,
): { readonly artifact: TemporaryPlanArtifactRow } | { readonly problem: string } {
  const start = plan.starts.find((row) => row.startRequestId === input.startRequestId);
  if (!start) return { problem: `计划里没有这次启动：${input.startRequestId}` };
  const progress = start.progress.find((row) => row.stepId === input.stepId);
  if (!progress) return { problem: `这次启动里没有这个步骤：${input.stepId}` };
  const matches = progress.artifacts.filter(
    (row) => row.relativePath === input.artifactPath && row.round === input.round,
  );
  if (matches.length === 0)
    return { problem: `产物不在计划记录里：第 ${input.round} 轮 ${input.artifactPath} 的稿子` };
  if (matches.length > 1)
    return { problem: `计划记录里有 ${matches.length} 条同样的产物，无法确定读哪一份。` };
  const artifact = matches[0]!;
  if (!artifact.exists) return { problem: `内核记录这份产物不存在：${artifact.relativePath}` };
  if (artifact.versionBasis !== input.versionBasis)
    return {
      problem: `版本依据对不上：界面显示 ${input.versionBasis}，内核记录 ${artifact.versionBasis}`,
    };
  return { artifact };
}

/**
 * 成果正文只读读取（§6.4.2/6.4.3）。三段检查，任何一段不过都明确报原因：
 * 1) 身份：路径必须是**内核投影里已核实的产物**，渲染层没法拿它读任意文件；
 * 2) 范围：真实路径（两侧 realpath）必须落在项目根内，符号链接与越界都拒绝；
 * 3) 目标：只读常规文件，限扩展名与大小，超限明确截断而不是静默给半截。
 */
async function readArtifactContent(
  options: TemporaryPlansQueryOptions,
  project: string,
  input: TemporaryPlanArtifactContentInput,
): Promise<TemporaryPlanArtifactContentResult> {
  const failWith = (code: TemporaryPlanArtifactReadCode, message: string) =>
    ({ state: "failed", code, message }) as const;
  try {
    const bridge = await loadDefaultModule(options);
    const read = record(await bridge.readDesktopPlans(project), "临时计划返回");
    const planRow = list(read.计划, "临时计划").find((value) => {
      try {
        return record(value, "计划").计划ID === input.planId;
      } catch {
        return false;
      }
    });
    if (planRow === undefined)
      return failWith("not-found-in-plan", `计划不在当前项目：${input.planId}`);
    const plan = normalizePlan(planRow);
    const found = findArtifact(plan, input);
    if ("problem" in found)
      return failWith(
        found.problem.startsWith("版本依据") ? "version-mismatch" : "not-found-in-plan",
        found.problem,
      );
    const artifact = found.artifact;

    const relative = artifact.relativePath.replace(/\\/g, "/");
    if (relative.startsWith("/") || /^[A-Za-z]:/.test(relative))
      return failWith("out-of-root", `产物路径是绝对路径，拒绝读取：${artifact.relativePath}`);
    if (relative.split("/").some((part) => part === ".." || part === ""))
      return failWith("out-of-root", `产物路径不合法：${artifact.relativePath}`);

    const fs = options.fs ?? (await nodeArtifactFs());
    // 两侧都取真实路径再比：只解目标侧会在项目根本身是符号链接时误判越界，只解项目根则漏掉目标侧链接。
    let root: string;
    try {
      root = await fs.realpath(project);
    } catch (error) {
      const mapped = readCodeOf(error);
      return failWith(mapped.code, mapped.message);
    }
    const target = joinPath(root, relative);
    let realTarget: string;
    try {
      realTarget = await fs.realpath(target);
    } catch (error) {
      const mapped = readCodeOf(error);
      return failWith(mapped.code, mapped.message);
    }
    const rootPrefix = root.endsWith("\\") || root.endsWith("/") ? root : root + "\\";
    if (realTarget !== root && !realTarget.startsWith(rootPrefix))
      return failWith("out-of-root", `真实路径落在项目外，拒绝读取：${artifact.relativePath}`);
    if (!samePathIgnoringCase(realTarget, target))
      return failWith("symlink", `路径经过符号链接，拒绝读取：${artifact.relativePath}`);

    let stats: ArtifactStat;
    try {
      stats = await fs.stat(realTarget);
    } catch (error) {
      const mapped = readCodeOf(error);
      return failWith(mapped.code, mapped.message);
    }
    if (stats.isDirectory()) return failWith("unsupported", `这是目录不是文件：${relative}`);
    if (!stats.isFile())
      return failWith("unsupported", `不是常规文件（可能是设备或管道）：${relative}`);
    const extension = extensionOf(relative);
    if (!TEXT_EXTENSIONS.has(extension))
      return failWith(
        "unsupported",
        `不支持读取这类文件：${extension || "无扩展名"}（${relative}）`,
      );

    const truncated = stats.size > ARTIFACT_CONTENT_LIMIT_BYTES;
    let buffer: Buffer;
    try {
      buffer = truncated
        ? await fs.readPrefix(realTarget, ARTIFACT_CONTENT_LIMIT_BYTES)
        : await fs.readFile(realTarget);
    } catch (error) {
      const mapped = readCodeOf(error);
      return failWith(mapped.code, mapped.message);
    }
    if (truncated && buffer.length > ARTIFACT_CONTENT_LIMIT_BYTES)
      buffer = buffer.subarray(0, ARTIFACT_CONTENT_LIMIT_BYTES);
    if (buffer.includes(0))
      return failWith("unsupported", `文件里有二进制内容，按文本读会失真：${relative}`);

    return {
      state: "ok",
      relativePath: relative,
      versionBasis: artifact.versionBasis,
      round: artifact.round,
      card: artifact.card,
      content: buffer.toString("utf8").replace(/^\uFEFF/, ""),
      byteLength: stats.size,
      truncated,
      modifiedAt: new Date(stats.mtimeMs).toISOString(),
    };
  } catch (error) {
    const mapped = readCodeOf(error);
    return failWith(mapped.code, mapped.message);
  }
}

/** 拼接项目根与相对路径：相对路径已在前面校验过不含分隔符逃逸，这里只做规范化拼接。 */
function joinPath(root: string, relative: string): string {
  const base = root.endsWith("\\") || root.endsWith("/") ? root.slice(0, -1) : root;
  return `${base}\\${relative.replace(/\//g, "\\")}`;
}

/** 大小写无关比较（Windows 路径大小写不敏感）：用相等即视为同一条路径，不误判成符号链接。 */
function samePathIgnoringCase(left: string, right: string): boolean {
  return left.replace(/\//g, "\\").toLowerCase() === right.replace(/\//g, "\\").toLowerCase();
}

function extensionOf(relative: string): string {
  const name = relative.slice(relative.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/**
 * 默认读盘实现：只暴露本模块用到的四件事，不让查询层顺手拿到任意 fs 能力。
 * 超限文件只读前 `length` 字节，避免为了报「太大」把整个大文件读进内存。
 */
async function nodeArtifactFs(): Promise<ArtifactFs> {
  const fs = await import("node:fs/promises");
  return {
    realpath: (path) => fs.realpath(path),
    stat: async (path) => {
      const info = await fs.stat(path);
      return {
        size: info.size,
        mtimeMs: info.mtimeMs,
        isFile: () => info.isFile(),
        isDirectory: () => info.isDirectory(),
        isSymbolicLink: () => info.isSymbolicLink(),
      };
    },
    readFile: (path) => fs.readFile(path),
    readPrefix: async (path, length) => {
      const handle = await fs.open(path, "r");
      try {
        const slice = Buffer.alloc(length);
        const { bytesRead } = await handle.read(slice, 0, length, 0);
        return slice.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  };
}

/** 导出供测试直接验形；与 collect 用的是同一份规范化。 */
export { normalizePlan as normalizeTemporaryPlan };
