/**
 * pao 巡库卡模块（卡0006，架构 §6.7）。
 * 机械巡检数 ⚠️ 过阈值（默认 5）→ 自动落巡库卡到本部队列：确定性触发、零语义判断；
 * 巡库 worker 只准写 ⚠️ 标记与初判，不准动条目正文（红线写进卡 约束 字段）。
 * 本模块不注册独立工具：经 knowledge/tools.ts 的 afterInspect 可选回调接线
 * （仿 cards/tools.ts 的 appendQueueSections 先例，缺省时 pao_inspect_kb 行为不变），
 * 总入口 src/pao/index.ts 由主控统一接线。
 */
export * from "./draft.ts";
export * from "./drop.ts";
export * from "./hook.ts";
export * from "./shell-guard.ts";
export * from "./wire.ts";
