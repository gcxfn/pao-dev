/**
 * PAO 运行控制桥（P5，窄接口）：只读控制身份＋三类人工动作。
 *
 * 与 canvas-query/workflow-wizard 同一口径——所有失败都落成可展示的 failed/error 结果，
 * 不把异常抛到主进程顶层，也绝不把读失败伪装成“没有实例”。
 *
 * 安全边界（渲染层不能越过的三条）：
 * 1. project 只由主进程按已登记 workspaceId 解析后传入，本模块不收渲染层路径；
 * 2. 配方名、卡目录、原 owner 一律从磁盘真值填充，渲染层提交的字段不原样透传；
 * 3. 节点与轮次在调用内核前与磁盘真值复核——这是请求关联校验（用户确认的是所见状态），
 *    内核看不到渲染层展示，无可替代；owner、理由、实例唯一性等业务判定只在内核
 *    runDesktopFlowCommand/control.ts 存在一份（T08 终端/桌面共用业务），本桥不重复。
 *
 * 真动作名以 fork 的 pao_control_node 协议为准，只有「确认」「暂停」「恢复」「裁定」四种；
 * 本批次放行前三种。「暂停」的准确含义是「暂停推进」：pauseControl 只把挂起原因写进
 * 控制清单，挡住后续节点启动，不会停掉在途 worker 进程或已认领的卡；桌面桥没有停止入口，
 * 本模块不提供也不暗示「停止实例」。恢复遇到仍在途的卡时会被内核拒绝，错误原样上抛。
 */
import { basename, resolve } from "node:path";
import { desktopPathKey } from "../../../contracts/path-identity";
import { loadDriver, reasonOf } from "./bridge-common";
import type {
  PaoDesktopFlow,
  PaoDesktopFlowControlModule,
  PaoDesktopFlowReadResult,
  PaoFlowCommandParams,
} from "@pi-gui/pi-sdk-driver";
import type {
  WorkflowControlCommandInput,
  WorkflowControlCommandResult,
  WorkflowControlIdentity,
  WorkflowControlNodeRow,
  WorkflowControlResult,
} from "../../../contracts/workflow-control";

function fail(message: string): never {
  throw new Error(`[FLOW_CONTROL_QUERY] ${message}`);
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

function positiveRound(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    fail("控制节点轮次不是正整数。");
  return value;
}

function normalizeNode(value: unknown): WorkflowControlNodeRow {
  const row = record(value, "控制节点");
  return {
    name: text(row.名字, "控制节点名字"),
    round: positiveRound(row.轮次),
    requiresConfirmation: row.人工确认 === true,
    confirmed: optionalText(row.已确认, "控制节点确认时间"),
    hold: optionalText(row.挂起, "控制节点挂起原因"),
    status: text(row.状态, "控制节点状态"),
  };
}

/** 把 fork 的 DesktopFlow 一行整形成控制身份；缺字段即显式失败，不猜默认值。 */
export function normalizeFlowControl(value: PaoDesktopFlow): WorkflowControlIdentity {
  const flow = record(value, "控制清单行");
  const control = record(flow.控制, "控制清单");
  const progress = record(flow.进度, "控制进度");
  return {
    instanceId: text(control.实例, "实例"),
    ownerSessionId: text(control.owner, "owner"),
    recipeName: text(control.工作流, "工作流"),
    cardDir: text(control.卡目录, "卡目录"),
    path: text(flow.路径, "控制清单路径"),
    status: text(progress.状态, "控制进度状态"),
    pauseReason: optionalText(control.暂停, "暂停原因"),
    nodes: list(progress.节点, "控制进度节点").map(normalizeNode),
  };
}

/** Load the fork flow-control bridge re-export; overridable so unit tests stay hermetic. */
async function loadDefaultModule(): Promise<PaoDesktopFlowControlModule> {
  return (await loadDriver("loadPaoDesktopFlowControl"))();
}

export interface FlowControlQueryOptions {
  /** Overrides the lazy driver import (tests). */
  readonly loadModule?: () => Promise<PaoDesktopFlowControlModule>;
}

export interface FlowControlQuery {
  /**
   * 只读：按实例名（＝配方名）取控制身份。同名多实例时用 instancePath 精确定位；
   * 路径只与 readDesktopFlows 的发现行做规范化比较，不按它读盘；缺省且多匹配＝显式拒绝。
   */
  collect(
    project: string,
    instanceName: string,
    instancePath?: string,
  ): Promise<WorkflowControlResult>;
  /** 动作：请求关联（节点/轮次）复核后直调内核；owner/理由等业务判定由内核执行；失败落 error，不抛顶层。 */
  run(project: string, command: WorkflowControlCommandInput): Promise<WorkflowControlCommandResult>;
}

interface FlowLookup {
  readonly flow?: PaoDesktopFlow;
  readonly message?: string;
}

/**
 * fork 行逐字段收窄为本桥真读的三键（路径/控制/进度），不再整行裸断言。
 * 内层字段不在此校验：定位/匹配走可选链容错，终读由 normalizeFlowControl fail-fast——
 * 这里加严会在坏形态时提前改写报错面，破坏既有容错路径。
 */
function toFlowRow(value: unknown): PaoDesktopFlow {
  const row = record(value, "控制清单行");
  return { 路径: row["路径"], 控制: row["控制"], 进度: row["进度"] } as PaoDesktopFlow;
}

/** 读控制清单；只认 fork 的真实返回形状，坏形状显式失败。 */
function readFlows(bridge: PaoDesktopFlowControlModule, project: string): PaoDesktopFlowReadResult {
  const value = record(bridge.readDesktopFlows(project), "控制清单返回");
  return {
    工作流: list(value.工作流, "控制清单").map(toFlowRow),
    问题: list(value.问题, "控制清单问题").map((row) => {
      const issue = record(row, "控制清单问题行");
      return { 路径: text(issue.路径, "问题路径"), 说明: text(issue.说明, "问题说明") };
    }),
  };
}

/** 实例必须唯一定位；坏清单按文件名对上时给出真实原因，不谎报“不存在”。 */
function pickFlow(
  read: PaoDesktopFlowReadResult,
  label: string,
  predicate: (flow: PaoDesktopFlow) => boolean,
  expectedFile?: string,
): FlowLookup {
  const matches = read.工作流.filter(predicate);
  if (matches.length === 1) return { flow: matches[0] };
  const broken = expectedFile
    ? read.问题.find((row) => basename(row.路径) === expectedFile)
    : undefined;
  if (broken) return { message: `控制清单不可读：${broken.说明}` };
  if (matches.length === 0) return { message: `运行记录不在当前项目：${label}` };
  return { message: `运行记录不唯一，拒绝猜测：${label}` };
}

/**
 * 路径比较键：纯字符串规范化（resolve＋统一分隔符＋Windows 折叠大小写），不按渲染层路径读盘。
 * resolve 由主进程负责，字符串比较规则与画布和看板共用。
 */
function pathKey(path: string): string {
  return desktopPathKey(resolve(path), process.platform === "win32");
}

/**
 * 实例定位：当前项目内按配方名（＝实例名）筛出候选；带 instancePath 时只与磁盘发现行的
 * 路径比对（不读渲染层给的路径），同名多实例缺路径＝显式拒绝，绝不猜。
 */
function locateFlow(
  read: PaoDesktopFlowReadResult,
  instanceName: string,
  instancePath?: string,
): FlowLookup {
  const named = read.工作流.filter((flow) => flow.控制?.工作流 === instanceName);
  if (instancePath) {
    const key = pathKey(instancePath);
    const matched = named.filter((flow) => pathKey(String(flow.路径)) === key);
    if (matched.length === 1) return { flow: matched[0] };
    const broken = read.问题.find((row) => pathKey(row.路径) === key);
    if (broken) return { message: `控制清单不可读：${broken.说明}` };
    if (matched.length === 0) return { message: `运行记录路径不在当前项目：${instancePath}` };
    return { message: `运行记录路径不唯一，拒绝猜测：${instancePath}` };
  }
  if (named.length === 1) return { flow: named[0] };
  const broken = read.问题.find((row) => basename(row.路径) === `工作流实例-${instanceName}.md`);
  if (broken) return { message: `控制清单不可读：${broken.说明}` };
  if (named.length === 0) return { message: `运行记录不在当前项目：${instanceName}` };
  return { message: `运行记录不唯一，拒绝猜测：${instanceName}` };
}

export function createFlowControlQuery(options: FlowControlQueryOptions = {}): FlowControlQuery {
  const module = () => options.loadModule?.() ?? loadDefaultModule();
  return {
    async collect(project, instanceName, instancePath): Promise<WorkflowControlResult> {
      try {
        const bridge = await module();
        const found = locateFlow(readFlows(bridge, project), instanceName, instancePath);
        if (!found.flow) return { state: "failed", message: found.message ?? "运行记录不可用。" };
        return { state: "ok", control: normalizeFlowControl(found.flow) };
      } catch (error) {
        return { state: "failed", message: reasonOf(error) };
      }
    },
    async run(project, command): Promise<WorkflowControlCommandResult> {
      try {
        const bridge = await module();
        const found = pickFlow(
          readFlows(bridge, project),
          `运行记录 ${command.instanceId}`,
          (flow) => flow.控制?.实例 === command.instanceId,
        );
        if (!found.flow) return { state: "error", message: found.message ?? "运行记录不可用。" };
        const control = found.flow.控制;
        // 请求关联校验（唯一留在桌面层的业务判定）：提交的动作必须仍是用户所见的节点与轮次；
        // owner、理由、实例合法性由内核统一复核，这里不预判，避免与内核规则分叉。
        const node = (control.节点 ?? []).find((row) => row.名字 === command.nodeName);
        if (!node || node.轮次 !== command.round) {
          return { state: "error", message: "节点或轮次已变化，请刷新后重试。" };
        }
        const reason = command.reason?.trim();
        const params: PaoFlowCommandParams = {
          name: text(control.工作流, "工作流"),
          cards_dir: text(control.卡目录, "卡目录"),
          instance: text(control.实例, "实例"),
          node: node.名字,
          round: node.轮次,
          action: command.action,
          ...(reason ? { reason } : {}),
          prev_owner: text(control.owner, "owner"),
        };
        await bridge.runDesktopFlowCommand(command.sessionId, project, { ...params });
        return { state: "ok" };
      } catch (error) {
        return { state: "error", message: reasonOf(error) };
      }
    },
  };
}
