/**
 * 临时计划桥（桌面阶段 4）：只读投影 + 与具体版本关联的启动确认直调。
 *
 * 与 pao-flow-control.ts 共用公开桌面入口：必须与桌面会话内置 pao 扩展是同一模块实例，
 * owner 表才共享，否则启动确认找不到会话。
 *
 * 本桥只声明内核真的提供的两件事：
 * - readDesktopPlans：项目内临时计划的只读投影（定义摘要、启动关联、意见状态），坏定义/坏关联进问题；
 * - 计划动作（创建/修改/撤销/启动/保存模板）不在这里另开一条写入通道——它们是主控经内核工具
 *   （pao_plan_*）发起的，页面只传已发现身份与用户意图，不重填表单、不伪造路径。
 */
import { loadPaoDesktopModule } from "./pao-desktop-module.js";

/** 步骤摘要（与 fork desktop/plans.ts 同源；步骤 ID 是稳定身份，标题可改）。 */
export interface PaoPlanStep {
  readonly 步骤ID: string;
  readonly 标题: string;
  readonly 部门: string;
  readonly 要求: string;
  readonly 预期成果?: string;
  readonly 依赖: readonly string[];
  readonly 人工门: boolean;
  readonly 只读: boolean;
  readonly 审核: boolean;
}

/** 一步的真实产物：路径原文来自卡回执的 `artifact_path`，`存在` 由内核在盘上核过。 */
export interface PaoPlanArtifact {
  readonly 路径: string;
  readonly 相对路径: string;
  readonly 轮次: number;
  readonly 卡号: string;
  readonly 存在: boolean;
  readonly 说明?: string;
}

/** 一步的一次执行记录：第几次、该轮卡引用、判定原文与原因。 */
export interface PaoPlanStepRecord {
  readonly 轮次: number;
  readonly 卡: readonly string[];
  readonly 判定?: string;
  readonly 原因?: string;
}

/** 一次启动里某个步骤的运行投影：状态沿用内核单域英文值，产物只取已交付卡的回执。 */
export interface PaoPlanStepProgress {
  readonly 步骤ID: string;
  readonly 状态: string;
  readonly 轮次?: number;
  readonly 挂起?: string;
  readonly 已确认?: string;
  readonly 需要人工确认: boolean;
  /** 活干完、只等人确认放行（controlView 在确认通过前不报 delivered）。 */
  readonly 等待人工确认: boolean;
  /** 控制正本里这一步当前的卡引用；停卡入口据它点名。 */
  readonly 卡: readonly string[];
  /** 执行记录（第几次、打回原因摘要）；没有控制信息就是空列表。 */
  readonly 记录: readonly PaoPlanStepRecord[];
  readonly 读取问题?: string;
  readonly 产出: readonly PaoPlanArtifact[];
}

/** 一次启动受理的关联真值；实例/工作区/卡目录都来自盘上记录。 */
export interface PaoPlanStartLink {
  readonly 启动请求ID: string;
  readonly 实例: string;
  readonly 配方名: string;
  readonly 工作区: string;
  readonly 卡目录: string;
  readonly 控制清单: string;
  readonly owner会话: string;
  readonly 受理时刻: string;
  /** 控制正本当前状态；读不到控制正本时写明原因，不冒充「运行中」。 */
  readonly 状态: string;
  /** 控制正本读不到时为空数组：界面按「状态读不到」处理，不显示成「还没有产出」。 */
  readonly 进度: readonly PaoPlanStepProgress[];
}

/** 意见条目（已记录/待送达/已送达/投递失败/已应用由状态字段表达，不合并成一个布尔）。 */
export interface PaoPlanFeedback {
  readonly 意见ID: string;
  readonly 计划ID: string;
  readonly 定义版本: number;
  readonly 目标: Readonly<Record<string, unknown>>;
  readonly 正文: string;
  readonly 状态: string;
  readonly 记录时刻: string;
  readonly 更新时刻: string;
  readonly 投递请求ID?: string;
  readonly 投递?: Readonly<Record<string, unknown>>;
  readonly 应用?: Readonly<Record<string, unknown>>;
}

/** 计划视图：定义摘要＋启动关联＋意见。 */
export interface PaoPlanView {
  readonly 计划ID: string;
  readonly 显示名: string;
  readonly 定义版本: number;
  readonly 已撤销: boolean;
  readonly 来源会话?: string;
  readonly 创建时刻: string;
  readonly 更新时刻: string;
  readonly 步骤: readonly PaoPlanStep[];
  readonly 启动: readonly PaoPlanStartLink[];
  readonly 意见: readonly PaoPlanFeedback[];
}

/** fork readDesktopPlans 的返回；问题行是坏定义/坏关联，不当空项目。 */
export interface PaoPlanReadResult {
  readonly 计划: readonly PaoPlanView[];
  readonly 问题: readonly { readonly 路径: string; readonly 说明: string }[];
}

/** fork desktop 桥的计划面纯签名（只读同步）。 */
export interface PaoDesktopPlanModule {
  readonly readDesktopPlans: (projectRoot: string) => PaoPlanReadResult;
}

/** 动态加载 fork 构建产物里的计划桥；缺函数即抛错，由调用方降级为不可用。 */
export async function loadPaoDesktopPlans(): Promise<PaoDesktopPlanModule> {
  const module = await loadPaoDesktopModule();
  if (typeof module.readDesktopPlans !== "function") {
    throw new Error("PAO 构建产物缺少计划入口 readDesktopPlans。");
  }
  // 内核返回完整计划视图；公开层保留历史最小投影。真实计划读取流程已覆盖这些字段。
  return { readDesktopPlans: module.readDesktopPlans } as unknown as PaoDesktopPlanModule;
}
