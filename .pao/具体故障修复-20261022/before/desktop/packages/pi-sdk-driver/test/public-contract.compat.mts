/**
 * 公开契约编译探针：本文件由 tsconfig.lint.json 编译，不参与运行测试。
 * 锁住本轮重构前的公开最小形状和函数签名，防止 loader 迁移再次收窄调用方替身。
 */
import type {
  PaoCanvasNodeSummary,
  PaoCanvasRecipeEntry,
  PaoCanvasView,
  PaoCardOpsCard,
  PaoCardOpsModule,
  PaoCardStatusChangeInput,
  PaoDesktopCanvasReader,
  PaoDesktopDeptModule,
  PaoDesktopFlowControlModule,
  PaoDesktopNodeDetailReader,
  PaoDesktopPlanModule,
  PaoDesktopRuntimeReader,
  PaoDesktopWorkflowModule,
  PaoDeptCatalog,
  PaoDeptDetail,
  PaoDeptViewOptions,
  PaoDesktopSessionIncrement,
  PaoFlowControlManifest,
  PaoPlanArtifact,
  PaoPlanReadResult,
  PaoPlanStep,
  PaoPlanStepProgress,
  PaoPlanStepRecord,
  PaoPreflightReport,
  PaoRecipeCatalog,
  PaoWorkflowPreview,
  PaoWorkflowRecipe,
} from "../dist/index.js";

const card: PaoCardOpsCard = {
  path: "卡0001-test.md",
  card_no: 1,
  frontmatter: { status: "in_progress" },
};

const statusChange: PaoCardStatusChangeInput = {
  操作者: "用户",
  to: "canceled",
  时间: "2026-10-22 12:00",
};

const cardOps: PaoCardOpsModule = {
  readCard: () => card,
  changeCardStatus: () => card,
};
void cardOps.changeCardStatus(card, statusChange);

const recipeNode: PaoCanvasNodeSummary = {
  名字: "实现",
  部门: "工程",
  depends_on: [],
  人工确认: false,
};
const recipeEntry: PaoCanvasRecipeEntry = {
  名字: "最小画布",
  可用: true,
  配方: {
    版本: 2,
    自动执行: false,
    参数: [],
    占位符: [],
    拓扑序: ["实现"],
    节点: [recipeNode],
  },
};
const canvas: PaoCanvasView = {
  配方: [recipeEntry],
  实例: [],
  异常: [],
};
const canvasReader: PaoDesktopCanvasReader = () => canvas;
const nodeDetailReader: PaoDesktopNodeDetailReader = (_home, _instance, node) => ({
  节点: node,
  实例: "最小实例",
  执行: [],
});
void nodeDetailReader("home", "instance.md", "实现", "卡0001");

const sessionIncrement: PaoDesktopSessionIncrement = {
  会话路径: "session.jsonl",
  下次偏移: 0,
  末行未完: false,
  还有更多: false,
  行: [],
  本段统计: { 响应: 0, 工具: 0, token: 0, 未知用量: 0 },
};
const runtimeReader: PaoDesktopRuntimeReader = {
  readDesktopProject: () => ({
    projectRoot: ".",
    cards: [],
    execution: [],
    issues: [],
  }),
  readDesktopSessionIncrement: () => sessionIncrement,
};
void runtimeReader.readDesktopSessionIncrement("session.jsonl");

const flow: PaoFlowControlManifest = {
  实例: "flow-1",
  owner: "session-1",
  工作流: "最小流程",
  卡目录: "cards",
  状态: "运行中",
  节点: [{ 名字: "实现", 轮次: 1 }],
};
const flowControl: PaoDesktopFlowControlModule = {
  readDesktopFlows: () => ({ 工作流: [], 问题: [] }),
  runDesktopFlowCommand: async () => {},
};
void flow.owner;
void flowControl.readDesktopFlows(".");

const recipe: PaoWorkflowRecipe = {
  名字: "最小流程",
  参数: [],
  节点: [{ 名字: "实现", 部门: "工程" }],
};
const preflight: PaoPreflightReport = {
  project: ".",
  checkedAt: "2026-10-22 12:00",
  canStart: true,
  items: [{ level: "自定义级别", subject: "主体", reason: "原因", suggestion: "建议" }],
};
const preview: PaoWorkflowPreview = {
  report: preflight,
  节点数: 1,
  节点: [
    { 名字: "实现", 部门: "工程", 工人上限: 1, 模型: "model", 思考强度: "high", 技能: [] },
  ],
  预算: { cost: null, turns: null, toolCalls: null, 说明: "" },
  将落卡数: "1",
};
const catalog: PaoRecipeCatalog = {
  recipes: [{ recipe, revision: "1", content: "content" }],
  departments: ["工程"],
  skills: [],
  tiers: [{ 名: "默认", provider: "p", model: "m", thinkingLevel: "high" }],
  thinkingLevels: ["high"],
  templates: [{ id: "starter" }],
  errors: [],
};
const workflow: PaoDesktopWorkflowModule = {
  readDesktopRecipeCatalog: () => catalog,
  previewDesktopWorkflow: () => preview,
  installDesktopTemplate: async () => {},
  saveDesktopRecipe: async () => {},
  deleteDesktopRecipe: async () => {},
  startDesktopWorkflow: async () => {},
};
void workflow.previewDesktopWorkflow(".", ".", recipe, {});

const planStep: PaoPlanStep = {
  步骤ID: "s1",
  标题: "实现",
  部门: "工程",
  要求: "完成",
  依赖: [],
  人工门: false,
  只读: false,
  审核: false,
};
const planArtifact: PaoPlanArtifact = {
  路径: "成果/实现.md",
  相对路径: "成果/实现.md",
  轮次: 1,
  卡号: "卡0001",
  存在: true,
};
const planStepRecord: PaoPlanStepRecord = {
  轮次: 1,
  卡: ["卡0001"],
  判定: "delivered",
};
const planStepProgress: PaoPlanStepProgress = {
  步骤ID: "s1",
  状态: "delivered",
  需要人工确认: false,
  等待人工确认: false,
  卡: ["卡0001"],
  记录: [planStepRecord],
  产出: [planArtifact],
};
const planRead: PaoPlanReadResult = {
  计划: [
    {
      计划ID: "p1",
      显示名: "最小计划",
      定义版本: 1,
      已撤销: false,
      创建时刻: "2026-10-22 12:00",
      更新时刻: "2026-10-22 12:00",
      步骤: [planStep],
      启动: [],
      意见: [],
    },
  ],
  问题: [],
};
const plans: PaoDesktopPlanModule = {
  readDesktopPlans: () => planRead,
};
void plans.readDesktopPlans(".");
void planStepProgress;

const viewOptions: PaoDeptViewOptions = { paoHome: "isolated-home" };
const deptCatalog: PaoDeptCatalog = {
  版本: 1,
  session: "session-1",
  project: ".",
  paoHome: "isolated-home",
  读取时间: "2026-10-22 12:00",
  注册表路径: "部门/注册表.md",
  部门: [],
  问题: [],
  工具技能人设区别: [],
};
const deptDetail: PaoDeptDetail = {
  版本: 1,
  session: "session-1",
  project: ".",
  paoHome: "isolated-home",
  读取时间: "2026-10-22 12:00",
  名字: "工程",
  标签: [],
  库路径: "知识库",
  路径: { 部门目录: "部门/工程", 配方: "配方.md", 知识库: "知识库" },
  职责: { 原文: "", 出处: null, 待填: false },
  工具: { 原值: null, 白名单: [], 混写技能名: [] },
  技能: [],
  默认档位: { 生效: "默认", 来源: "缺省兜底", provider: null, model: null, thinkingLevel: null },
  标准: [],
  知识入口: {
    索引: { 路径: "索引", 相对路径: null, 可读: false, 字节: null, 行数: null },
    干法: null,
  },
  配置问题: [],
  负载: { 活卡数: 0, 卡片总数: 0, 热部长数: 0, 挂起节点数: 0, 归档卡数: 0, 读取问题: [] },
  读取问题: [],
};
const dept: PaoDesktopDeptModule = {
  readDesktopDeptCatalog: (_session, _project, options) => {
    void options;
    return deptCatalog;
  },
  readDesktopDeptDetail: (_session, _project, _dept, options) => {
    void options;
    return deptDetail;
  },
};
void dept.readDesktopDeptCatalog("session-1", ".", viewOptions);
