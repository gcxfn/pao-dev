/**
 * PAO 卡操作桥（桌面 S7-B）：把内核卡文件层的合法写入口收拢成一个加载点。
 *
 * 只暴露内核 cards/index.js 已导出的纯库函数（readCard／changeCardStatus）：
 * changeCardStatus 内部自带迁移白名单、单写者校验、读-合并-写与盘上状态一致性检查，
 * 桌面层不重造任何状态机规则、不绕 owner 校验；操作者身份与目标状态由桌面桥给定
 * （只代「用户」执行取消），业务判定唯一留在内核。
 */
/** 内核卡最小形状；公开替身只需要读卡号和当前状态，其余卡面字段不进入桌面契约。 */
export interface PaoCardOpsCard {
  readonly path: string;
  readonly card_no: number;
  readonly frontmatter: { readonly status: string; readonly [key: string]: unknown };
  readonly [key: string]: unknown;
}

/** 状态操作入参；`to` 保持旧公开字符串契约，业务状态值仍由内核状态机校验。 */
export interface PaoCardStatusChangeInput {
  readonly 操作者: string;
  readonly to: string;
  readonly 失败类型?: string;
  readonly 依据?: string;
  readonly 时间: string;
  readonly 尝试上限?: number;
}

/** loader 的返回签名来自内核；公开替身类型只在模块适配边界使用。 */
export interface PaoCardOpsModule {
  readonly readCard: (path: string) => PaoCardOpsCard;
  readonly changeCardStatus: (
    card: PaoCardOpsCard,
    input: PaoCardStatusChangeInput,
  ) => PaoCardOpsCard;
}

/** 动态加载 fork 构建产物里的卡文件层；缺函数即抛错，由调用方降级为操作不可用。 */
export async function loadPaoCardOps(): Promise<PaoCardOpsModule> {
  const module = await import("@earendil-works/pi-coding-agent/pao");
  const { readCard, changeCardStatus } = module;
  if (typeof readCard !== "function") throw new Error("PAO 构建产物缺少卡操作入口 readCard。");
  if (typeof changeCardStatus !== "function")
    throw new Error("PAO 构建产物缺少卡操作入口 changeCardStatus。");
  // 内核实现接受完整 ParsedCard/StatusChangeInput，公开层继续保留历史最小契约。
  // 两种形状已由真实卡文件上的 readCard/changeCardStatus 流程测试核实。
  const bridge = module as unknown as PaoCardOpsModule;
  return {
    readCard: bridge.readCard,
    changeCardStatus: bridge.changeCardStatus,
  };
}
