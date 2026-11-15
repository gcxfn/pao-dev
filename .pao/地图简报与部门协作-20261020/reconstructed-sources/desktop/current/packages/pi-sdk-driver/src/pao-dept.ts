/**
 * 部门桥（桌面阶段 E2b）：部门目录与单部门详情的只读投影直调。
 *
 * 与 pao-plans.ts / pao-workflow.ts 同一条深引路径（dist/pao/desktop/index.js）：必须与桌面会话
 * 内置 pao 扩展是同一模块实例，owner 表才共享，否则会话校验找不到 owner。
 *
 * 本桥只声明内核真的提供的两件事（计划 §5.1 表、§5.2 第 1/2/3/7 条）：
 * - readDesktopDeptCatalog：全量部门目录（总览与选择器用；名单唯一来自注册表，只带摘要不塞配方全文）；
 * - readDesktopDeptDetail：单部门详情（职责原文/工具白名单/技能真实路径/默认档位/标准/知识入口/
 *   配置问题/负载）。
 *
 * 部门解析与校验的单一来源在 PAO 的 dept/catalog.ts，桌面层不另写一套：
 * 本桥只做类型声明，不翻译字段名、不补默认值——内核说什么就渲染什么。
 * 会话与项目由调用方传入（走 owner 口径），PAO_HOME 由内核自行解析，不在这里猜路径。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 投影选项：PAO_HOME 缺省取环境（与其它读桥一致，不猜路径）。 */
export interface PaoDeptViewOptions {
  readonly paoHome?: string;
}

/** 一处配置问题：级别/部门/类别/问题/修法/证据路径，全部来自 dept 模块的集中校验。 */
export interface PaoDeptIssue {
  readonly 级别: "阻止启动" | "警告" | "提示";
  readonly 部门: string;
  readonly 类别: string;
  readonly 问题: string;
  readonly 修法: string;
  readonly 证据: string;
}

/** 目录里一个部门的摘要行（总览与选择器用；不塞配方全文）。 */
export interface PaoDeptCatalogRow {
  readonly 名字: string;
  readonly 标签: readonly string[];
  /** 生效档名（卡面未指定档位时） */
  readonly 默认档位: string;
  /** 该档解析出的 provider/model；未配置/查无此档为 null */
  readonly 模型: string | null;
  /** 职责摘要（人设首句，至多内核的摘要上限；未写时为空串） */
  readonly 职责摘要: string;
  readonly 技能数: number;
  readonly 工具数: number;
  readonly 问题数: number;
  /** 阻止启动问题数（>0 表示该部门派发必失败） */
  readonly 阻止启动数: number;
  readonly 知识入口: string;
  readonly 配方路径: string;
  /** 这个条目能不能选来派发；不能时原因见 不可用原因 */
  readonly 可用: boolean;
  readonly 不可用原因?: string;
}

/** 全量部门目录（唯一名单来自 <PAO_HOME>/部门/注册表.md，前端不得硬编码）。 */
export interface PaoDeptCatalog {
  readonly 版本: 1;
  readonly session: string;
  readonly project: string;
  readonly paoHome: string;
  readonly 读取时间: string;
  readonly 注册表路径: string;
  /** 按注册表顺序 */
  readonly 部门: readonly PaoDeptCatalogRow[];
  /** 全局配置问题（含注册表级、档位级；部门级问题也在这里，按「部门」字段过滤） */
  readonly 问题: readonly PaoDeptIssue[];
  /** 「工具/技能/人设」三种东西的区别：唯一正本在 dept/catalog，桌面直接透传渲染 */
  readonly 工具技能人设区别: readonly {
    readonly 角色: string;
    readonly 含义: string;
    readonly 真实性判据: string;
  }[];
}

/** 默认档位落到真实模型：查无此档不猜，model/thinkingLevel 一律 null 并给原因。 */
export interface PaoDeptTier {
  readonly 生效: string;
  readonly 来源: "配方" | "档位.json 部门默认" | "缺省兜底";
  readonly provider: string | null;
  readonly model: string | null;
  readonly thinkingLevel: string | null;
  readonly 未配置原因?: string;
}

/** 一处标准引用：只定位真实文件/小节，不复制正文。 */
export interface PaoDeptStandard {
  readonly 原始: string;
  readonly 文件: string | null;
  readonly 可读: boolean;
}

/** 一个技能引用：目录与 SKILL.md 的真实位置与可用性。 */
export interface PaoDeptSkillView {
  readonly 引用: string;
  readonly 目录: string;
  readonly skillFile: string;
  readonly 目录存在: boolean;
  /** SKILL.md 存在且非空＝派发真能装载 */
  readonly 可用: boolean;
  /** 来自建部模板的占位文字（不是真引用） */
  readonly 占位符: boolean;
}

/** 按需正文的可读性：只回「能不能读、多大、多少行」，不回正文。 */
export interface PaoDeptSourceRef {
  readonly 路径: string;
  readonly 相对路径: string | null;
  readonly 可读: boolean;
  readonly 字节: number | null;
  readonly 行数: number | null;
}

/** 项目/部门负载：卡片数与挂起节点数来自内核卡快照与控制清单，不在桌面侧重算。 */
export interface PaoDeptLoad {
  /** 本部门在役卡数：status 不是 delivered/canceled */
  readonly 活卡数: number;
  readonly 卡片总数: number;
  /** 本部门在本进程内的热部长数（本进程外会话不在内，不造心跳） */
  readonly 热部长数: number;
  readonly 挂起节点数: number;
  /** 已归档的历史卡数 */
  readonly 归档卡数: number;
  /** 卡片与挂起节点的读取问题（不拖其他段） */
  readonly 读取问题: readonly PaoDeptReadIssue[];
}

/** 读到但某部分没读到时的如实说明（不拖其他段）。 */
export interface PaoDeptReadIssue {
  readonly 路径: string;
  readonly 说明: string;
}

/** 单部门详情（计划 §5.2 第 1 条七段：职责/技能/档位/标准/知识入口/配置问题/负载）。 */
export interface PaoDeptDetail {
  readonly 版本: 1;
  readonly session: string;
  readonly project: string;
  readonly paoHome: string;
  readonly 读取时间: string;
  /** 注册表里的真实名字（＝部门目录名） */
  readonly 名字: string;
  readonly 标签: readonly string[];
  /** 知识库路径（相对 PAO_HOME） */
  readonly 库路径: string;
  readonly 建部日期?: string;
  /** 部门目录、配方、知识库门面的真实路径 */
  readonly 路径: {
    readonly 部门目录: string;
    readonly 配方: string;
    readonly 知识库: string;
  };
  /** 职责/边界/口吻：人设原文 + 出处（真实文件路径）；未写时为空串 */
  readonly 职责: {
    readonly 原文: string;
    readonly 出处: string | null;
    /** 原文是否还是建部模板的「<待填…>」占位 */
    readonly 待填: boolean;
  };
  /** 工具白名单：派发时的内置工具名（表外名原样保留并标非内置） */
  readonly 工具: {
    readonly 原值: string | null;
    readonly 白名单: readonly { readonly 名字: string; readonly 内置: boolean }[];
    /** 旧配方把技能名混写在「工具」行时的疑似技能名（供提示拆分） */
    readonly 混写技能名: readonly string[];
  };
  /** 技能列表：每个技能的真实目录 + SKILL.md 是否存在 */
  readonly 技能: readonly PaoDeptSkillView[];
  /** 默认档位（落到 档位.json 的 provider/model/thinkingLevel） */
  readonly 默认档位: PaoDeptTier;
  /** 配方声明的标准（只给真实文件/小节位置） */
  readonly 标准: readonly PaoDeptStandard[];
  /** 知识入口（门面索引）＋干法段（详细步骤按需读原文件） */
  readonly 知识入口: {
    readonly 索引: PaoDeptSourceRef;
    readonly 干法: PaoDeptSourceRef | null;
  };
  /** 本部门的配置问题：每项带级别/类别/问题/修法/证据路径 */
  readonly 配置问题: readonly PaoDeptIssue[];
  /** 负载：与本进程热部长、卡快照、控制清单同源 */
  readonly 负载: PaoDeptLoad;
  /** 读到但这部分没读到时的如实说明（不拖其他段） */
  readonly 读取问题: readonly PaoDeptReadIssue[];
}

/** fork desktop 桥的部门面纯签名（只读同步）。 */
export interface PaoDesktopDeptModule {
  readonly readDesktopDeptCatalog: (
    sessionId: string,
    project: string,
    options?: PaoDeptViewOptions,
  ) => PaoDeptCatalog;
  readonly readDesktopDeptDetail: (
    sessionId: string,
    project: string,
    deptName: string,
    options?: PaoDeptViewOptions,
  ) => PaoDeptDetail;
}

/** 本桥要求内核提供的两个入口，缺一即视为构建产物不完整。 */
const REQUIRED_EXPORTS = ["readDesktopDeptCatalog", "readDesktopDeptDetail"] as const;

/** 动态加载 fork 构建产物里的部门桥；缺函数即抛错，由调用方降级为不可用。 */
export async function loadPaoDesktopDept(): Promise<PaoDesktopDeptModule> {
  const resolve = (import.meta as ImportMeta & { resolve?: (specifier: string) => string }).resolve;
  if (typeof resolve !== "function") {
    throw new Error("import.meta.resolve is unavailable in this runtime.");
  }
  const paoEntryPath = fileURLToPath(resolve("@earendil-works/pi-coding-agent/pao"));
  const forkPaoDistDir = dirname(paoEntryPath);
  const module = (await import(
    pathToFileURL(join(forkPaoDistDir, "desktop", "index.js")).href
  )) as Partial<PaoDesktopDeptModule>;
  for (const key of REQUIRED_EXPORTS) {
    if (typeof module[key] !== "function") {
      throw new Error(`PAO desktop bridge is missing ${key} in the build products.`);
    }
  }
  return module as PaoDesktopDeptModule;
}
