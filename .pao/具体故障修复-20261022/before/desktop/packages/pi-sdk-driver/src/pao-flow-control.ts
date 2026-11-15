/**
 * PAO 运行控制桥（桌面 P5）：把 fork desktop 桥的两个入口收拢成一个加载点——
 * 只读控制清单 readDesktopFlows，与人工动作直调 runDesktopFlowCommand。
 *
 * 真实动作值以 fork 的 pao_control_node 工具协议为准（PAO/packages/coding-agent/src/pao/
 * workflow/tools.ts）：动作只有 confirm/pause/resume/rule 四种（S9 迁移后）。桌面本批
 * 只放行 confirm/pause/resume；rule（裁定）要带三态结果与引用证据，不在范围，也不在本桥声明。
 *
 * runDesktopFlowCommand 会把每个参数拿磁盘真值复核（实例唯一、卡目录、节点与轮次、
 * owner/原 owner），桌面层不重造规则、不绕 owner 校验；本模块只负责加载与形状声明。
 * 「暂停」是内核真实的 pauseControl：只记挂起原因以暂停推进，不停在途进程；桌面桥没有停止入口。
 *
 * 与 pao-workflow.ts 共用公开桌面入口：必须与桌面会话内置 pao 扩展是同一模块实例，
 * owner 表才共享，否则 runDesktopFlowCommand 找不到会话。
 */
import { loadPaoDesktopModule } from "./pao-desktop-module.js";

/** fork NodeReport（controlReport 逐节点产物，中文键；字段与 fork 同源）。 */
export interface PaoFlowNodeReport {
  readonly 名字: string;
  readonly 轮次?: number;
  readonly 状态: string;
  readonly 人工确认: boolean;
  readonly 已确认?: string;
  readonly 挂起?: string;
  readonly 卡号?: string;
  readonly 卡号列表?: readonly string[];
}

/** fork DriveReport（controlReport 整实例产物）。 */
export interface PaoFlowProgress {
  readonly 工作流: string;
  readonly 状态: string;
  readonly 新建卡: readonly { readonly 节点: string; readonly 卡号: string }[];
  readonly 节点: readonly PaoFlowNodeReport[];
  readonly 说明?: string;
}

/** fork FlowControl 的桌面只读投影：只声明本桥真的读到的键，其余不猜。 */
export interface PaoFlowControlManifest {
  readonly 实例: string;
  readonly owner: string;
  readonly 工作流: string;
  readonly 卡目录: string;
  readonly 状态: string;
  /** 暂停推进的挂起原因；内核 pauseControl 只写这里，不停在途进程。 */
  readonly 暂停?: string;
  /** 控制正本里的节点与当前轮次；动作前的复核用它，不拿报告反推。 */
  readonly 节点: readonly { readonly 名字: string; readonly 轮次: number }[];
}

/** fork DesktopFlow：控制清单文件路径＋控制正本＋进度报告。 */
export interface PaoDesktopFlow {
  readonly 路径: string;
  readonly 控制: PaoFlowControlManifest;
  readonly 进度: PaoFlowProgress;
}

/** fork readDesktopFlows 的返回；问题行是坏清单，不当空实例。 */
export interface PaoDesktopFlowReadResult {
  readonly 工作流: readonly PaoDesktopFlow[];
  readonly 问题: readonly { readonly 路径: string; readonly 说明: string }[];
}

/** fork runDesktopFlowCommand 的参数（迁移后英文键）；由桌面层从磁盘真值填充后原样交给 fork。 */
export interface PaoFlowCommandParams {
  readonly name: string;
  readonly cards_dir: string;
  readonly instance: string;
  readonly node: string;
  readonly round: number;
  readonly action: "confirm" | "pause" | "resume";
  readonly reason?: string;
  readonly prev_owner?: string;
  readonly [extra: string]: unknown;
}

/** fork desktop 桥的控制面纯签名（读同步、动作异步且带 owner 校验）。 */
export interface PaoDesktopFlowControlModule {
  readonly readDesktopFlows: (project: string) => PaoDesktopFlowReadResult;
  readonly runDesktopFlowCommand: (
    sessionId: string,
    project: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<void>;
}

/** 动态加载 fork 构建产物里的控制桥；缺函数即抛错，由调用方降级为不可用。 */
export async function loadPaoDesktopFlowControl(): Promise<PaoDesktopFlowControlModule> {
  const module = await loadPaoDesktopModule();
  const { readDesktopFlows, runDesktopFlowCommand } = module;
  if (typeof readDesktopFlows !== "function")
    throw new Error("PAO 构建产物缺少控制入口 readDesktopFlows。");
  if (typeof runDesktopFlowCommand !== "function")
    throw new Error("PAO 构建产物缺少控制入口 runDesktopFlowCommand。");
  // 内核入口返回完整 native 类型；公开层仍以历史最小投影声明同一真实函数。
  // 加载边界只跨越投影差异，函数行为和参数已由真实控制流程测试核实。
  return { readDesktopFlows, runDesktopFlowCommand } as unknown as PaoDesktopFlowControlModule;
}
