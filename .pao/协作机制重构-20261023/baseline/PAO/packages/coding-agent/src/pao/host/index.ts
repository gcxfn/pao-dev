/**
 * PAO 在线宿主(M2-01 S2):部长会话(RPC 常驻子进程)拉起、保温、事件边界保险丝、
 * 监督周期唤醒、用量落账。公共面从这里导出;接线(src/pao/index.ts)由主控统一接。
 */

export * from "./config.ts";
export * from "./events.ts";
export * from "./handle.ts";
export * from "./handoff.ts";
export * from "./host.ts";
export * from "./ledger.ts";
export * from "./tools.ts";

import { MinisterHost } from "./host.ts";

/**
 * 模块级默认宿主:一个会话一个调度轮次的默认持有面(与 worker/index.ts 的
 * defaultWorkerRunner 同款形态)。pao_inventory 的部长会话行与 pao_dispatch_card 的交接指针接线
 * 都读它;正式接线可在注册时传独立实例替换。
 */
export const defaultMinisterHost = new MinisterHost();
