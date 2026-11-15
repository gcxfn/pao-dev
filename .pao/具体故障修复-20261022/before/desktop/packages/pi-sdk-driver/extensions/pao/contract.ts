import { defineService, type Context } from "@earendil-works/chord";
import type {
  DesktopProjectSnapshot,
  DesktopSessionIncrement,
} from "@earendil-works/pi-coding-agent/pao/desktop";

/**
 * 部门目录与详情（E2b）：类型镜像自 PAO 的 `src/pao/desktop/dept.ts`。
 *
 * 为什么不在 `@earendil-works/pi-coding-agent/pao/desktop` 直接 import type：该入口目前
 * 没有桶导出那份文件，跨包拿不到；等内核补齐之前先镜像，字段名与形状逐字对齐，
 * 好处是这份契约能在浏览器端编译（不依赖内核类型），坏处是内核改字段要同步。
 * 渲染层只用本文件声明的类型，不 import 内核模块——保持扩展与内核的窄边界。
 */
export interface PaoDeptIssue {
  级别: "阻止启动" | "警告" | "提示";
  部门: string;
  类别: string;
  问题: string;
  修法: string;
  证据: string;
}
export interface PaoDeptCatalogRow {
  名字: string;
  标签: string[];
  /** 生效档名（卡面未指定档位时）；字段名与内核 dept.ts 的 DesktopDeptCatalogRow 逐字一致。 */
  默认档位: string;
  模型: string | null;
  职责摘要: string;
  技能数: number;
  工具数: number;
  问题数: number;
  阻止启动数: number;
  知识入口: string;
  配方路径: string;
  可用: boolean;
  不可用原因?: string;
}
export interface PaoDeptCatalog {
  版本: 1;
  session: string;
  project: string;
  paoHome: string;
  读取时间: string;
  注册表路径: string;
  部门: PaoDeptCatalogRow[];
  问题: PaoDeptIssue[];
  工具技能人设区别: { 角色: string; 含义: string; 真实性判据: string }[];
}
export interface PaoDeptTier {
  生效: string;
  来源: "配方" | "档位.json 部门默认" | "缺省兜底";
  provider: string | null;
  model: string | null;
  thinkingLevel: string | null;
  未配置原因?: string;
}
export interface PaoDeptStandard {
  原始: string;
  文件: string | null;
  可读: boolean;
}
export interface PaoDeptSkillView {
  引用: string;
  目录: string;
  skillFile: string;
  目录存在: boolean;
  可用: boolean;
  占位符: boolean;
}
export interface PaoDeptSourceRef {
  路径: string;
  相对路径: string | null;
  可读: boolean;
  字节: number | null;
  行数: number | null;
}
export interface PaoDeptReadIssue {
  路径: string;
  说明: string;
}
export interface PaoDeptLoad {
  活卡数: number;
  卡片总数: number;
  热部长数: number;
  挂起节点数: number;
  归档卡数: number;
  读取问题: PaoDeptReadIssue[];
}
export interface PaoDeptDetail {
  版本: 1;
  session: string;
  project: string;
  paoHome: string;
  读取时间: string;
  名字: string;
  标签: string[];
  库路径: string;
  建部日期?: string;
  路径: { 部门目录: string; 配方: string; 知识库: string };
  职责: { 原文: string; 出处: string | null; 待填: boolean };
  工具: { 原值: string | null; 白名单: { 名字: string; 内置: boolean }[]; 混写技能名: string[] };
  技能: PaoDeptSkillView[];
  默认档位: PaoDeptTier;
  标准: PaoDeptStandard[];
  知识入口: { 索引: PaoDeptSourceRef; 干法: PaoDeptSourceRef | null };
  配置问题: PaoDeptIssue[];
  负载: PaoDeptLoad;
  读取问题: PaoDeptReadIssue[];
}
export interface PaoView {
  项目: DesktopProjectSnapshot;
  部长错误?: string;
  待处理: { projects: DesktopProjectSnapshot[]; issues: { 路径: string; 说明: string }[] };
  部长: { 会话标识: string; 部门: string; 项目根: string; pid: number; 脉络?: string }[];
}
export interface Identity {
  sessionId: string;
  project: string;
}
export interface PaoService {
  refresh(context: Context): Promise<PaoView>;
  execution(
    request: Identity & { id: string; offset: number },
    context: Context,
  ): Promise<DesktopSessionIncrement>;
  memory(request: Identity & { args: string; revision: string }, context: Context): Promise<void>;
  minister(
    request: Identity & { id: string; offset: number },
    context: Context,
  ): Promise<DesktopSessionIncrement>;
  diff(
    request: Identity & { instance?: string; node?: string },
    context: Context,
  ): Promise<unknown>;
  /** D8c 结果页聚合（按实例四样＋恢复摘要四态＋异常行）；载荷结构见 pao/status/results.ts。 */
  results(request: Identity, context: Context): Promise<unknown>;
  /**
   * E2b 全量部门目录（总览与选择器）：名单唯一来源是 <PAO_HOME>/部门/注册表.md，
   * 只带摘要（职责摘要/技能数/工具数/问题数/可用性），不塞配方全文。
   * 读取失败原样抛给前端（不吞成空列表：空列表会让界面显示「没有部门」而真相是「读不了」）。
   */
  deptCatalog(request: Identity, context: Context): Promise<PaoDeptCatalog>;
  /**
   * E2b 单部门详情（职责/工具/技能/档位/标准/知识入口/配置问题/负载）。
   * `deptName` 必须是注册表里的真实名字；未登记时内核抛错并给「目录在不在」的实话，不自动建部。
   */
  deptDetail(request: Identity & { deptName: string }, context: Context): Promise<PaoDeptDetail>;
  flow(
    request: Identity & {
      instance: string;
      node: string;
      round: number;
      action: "confirm" | "pause" | "resume" | "rule";
      reason: string;
      result?: "pass" | "change" | "reject";
      references?: string[];
      target?: string;
      /** 与内核 schema 同名（§10 收口批统一，消掉后端 index.ts 的 axis→failure_axis 映射）。 */
      failure_axis?: "card" | "dept_standard" | "both";
    },
    context: Context,
  ): Promise<void>;
}
export const Pao = defineService<PaoService>("pao.desktop.v1");

/** 键控脉冲服务：会话 turn/agent 事件时后端补一个实例，前端 observe 到即节流刷新一次。载荷无意义。 */
export interface PaoPulseService {
  ping(): Promise<number>;
}
export const PaoPulse = defineService<PaoPulseService>("pao.desktop.pulse.v1");
