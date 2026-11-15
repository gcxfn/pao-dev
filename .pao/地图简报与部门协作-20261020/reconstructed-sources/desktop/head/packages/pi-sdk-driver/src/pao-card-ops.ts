/**
 * PAO 卡操作桥（桌面 S7-B）：把内核卡文件层的合法写入口收拢成一个加载点。
 *
 * 只暴露内核 cards/index.js 已导出的纯库函数（readCard／changeCardStatus）：
 * changeCardStatus 内部自带迁移白名单、单写者校验、读-合并-写与盘上状态一致性检查，
 * 桌面层不重造任何状态机规则、不绕 owner 校验；操作者身份与目标状态由桌面桥给定
 * （只代「用户」执行取消），业务判定唯一留在内核。
 *
 * 与 pao-kanban.ts 同一条 dist 引路径：开发态经 pnpm link 指向 fork 构建产物，
 * 打包态用 vendor 物化副本；桌面不 import 内核 TS 源码。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 内核卡最小形状（S9 迁移后英文键；只声明本桥读到的键，其余不猜）。 */
export interface PaoCardOpsCard {
  readonly path: string;
  readonly card_no: number;
  readonly frontmatter: { readonly status: string; readonly [key: string]: unknown };
  readonly [key: string]: unknown;
}

/** 内核 changeCardStatus 的入参（中文键，与 fork cards/statemachine 同源）。 */
export interface PaoCardStatusChangeInput {
  readonly 操作者: string;
  readonly to: string;
  readonly 失败类型?: string;
  readonly 依据?: string;
  readonly 时间: string;
  readonly 尝试上限?: number;
}

/** 内核卡文件层纯签名（读同步、写原子；并发与一致性由内核自查）。 */
export interface PaoCardOpsModule {
  readonly readCard: (path: string) => PaoCardOpsCard;
  readonly changeCardStatus: (
    card: PaoCardOpsCard,
    input: PaoCardStatusChangeInput,
  ) => PaoCardOpsCard;
}

/** 动态加载 fork 构建产物里的卡文件层；缺函数即抛错，由调用方降级为操作不可用。 */
export async function loadPaoCardOps(): Promise<PaoCardOpsModule> {
  const resolve = (import.meta as ImportMeta & { resolve?: (specifier: string) => string }).resolve;
  if (typeof resolve !== "function") {
    throw new Error("import.meta.resolve is unavailable in this runtime.");
  }
  const paoEntryPath = fileURLToPath(resolve("@earendil-works/pi-coding-agent/pao"));
  const module = (await import(
    pathToFileURL(join(dirname(paoEntryPath), "cards", "index.js")).href
  )) as Partial<PaoCardOpsModule>;
  for (const key of ["readCard", "changeCardStatus"] as const) {
    if (typeof module[key] !== "function") {
      throw new Error(`PAO 构建产物缺少卡操作入口 ${key}。`);
    }
  }
  return module as PaoCardOpsModule;
}
