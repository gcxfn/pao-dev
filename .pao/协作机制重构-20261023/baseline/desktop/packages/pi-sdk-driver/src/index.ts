export {
  applyHostUiRequestToExtensionUiState,
  createEmptyExtensionUiState,
  isExtensionUiDialogRequest,
} from "./extension-ui-state.js";
export type {
  ExtensionUiDialogRequest,
  ExtensionUiState,
  ExtensionUiWidgetState,
} from "./extension-ui-state.js";
export type { BuiltinExtension } from "./builtin-extensions.js";
export type { PiSdkDriverConfig } from "./pi-sdk-driver.js";
export { createPiSdkDriver, PiSdkDriver } from "./pi-sdk-driver.js";
export {
  SideChatBusyError,
  SideChatSupervisor,
  type CapturedSideChatSource,
} from "./side-chat.js";
export {
  CUSTOM_PROVIDER_ID_PATTERN,
  isValidHttpBaseUrl,
  OPENAI_COMPLETIONS_API,
  RuntimeSupervisor,
} from "./runtime-supervisor.js";
export type {
  PiSdkDriverOptions,
  SideChatSourceSnapshot,
  SyncWorkspaceResult,
} from "./session-supervisor.js";
export { SessionSupervisor } from "./session-supervisor.js";
export { SessionLeasedError } from "./session-lease.js";
export type { LeaseInfo } from "./session-lease.js";
export { startPaoMaintenance } from "./pao-maintenance.js";
export { loadPaoTierAdmin } from "./pao-tier-admin.js";
export type { PaoTierAdmin, PaoTierWrite } from "./pao-tier-admin.js";
export { loadPaoWorkboardAggregates } from "./pao-workboard.js";
export type {
  DeptBacklogRow,
  PaoInstanceAnomalyRow,
  PaoPendingItem,
  PaoPendingLimits,
  PaoSuspendedInstanceRow,
  PaoWorkboardAggregates,
  PaoWorkflowInstanceScan,
} from "./pao-workboard.js";
export {
  loadPaoDesktopCanvas,
  loadPaoDesktopNodeDetail,
  loadPaoDesktopRuntimeReader,
} from "./pao-canvas.js";
export {
  loadPaoKanbanReader,
  loadPaoWorkboardSessionReader,
  type PaoKanbanReader,
  type PaoWorkboardSessionReader,
} from "./pao-kanban.js";
export { loadPaoCardOps } from "./pao-card-ops.js";
export type { PaoCardOpsCard, PaoCardOpsModule, PaoCardStatusChangeInput } from "./pao-card-ops.js";
export type {
  PaoCanvasInstance,
  PaoCanvasNodeInstance,
  PaoCanvasNodeSummary,
  PaoCanvasParallelGroup,
  PaoCanvasReviewEdge,
  PaoCanvasRecipeEntry,
  PaoCanvasRecipeSummary,
  PaoCanvasView,
  PaoDesktopCanvasReader,
  PaoDesktopNodeDetailReader,
  PaoNodeDetail,
  PaoNodeExecutionRef,
  PaoNodeReceiptRound,
  PaoCardFrontmatter,
  PaoCardReceipt,
  PaoDesktopCard,
  PaoDesktopExecution,
  PaoDesktopProjectSnapshot,
  PaoDesktopRuntimeReader,
  PaoDesktopSessionIncrement,
} from "./pao-canvas.js";
export { loadPaoDesktopWorkflow } from "./pao-workflow.js";
export type {
  PaoDesktopWorkflowModule,
  PaoNodeBudget,
  PaoPreflightItem,
  PaoPreflightReport,
  PaoRecipeCatalog,
  PaoStarterTemplate,
  PaoTierEntry,
  PaoWorkflowPreview,
  PaoWorkflowRecipe,
  PaoWorkflowRecipeNode,
} from "./pao-workflow.js";
export { loadPaoDesktopFlowControl } from "./pao-flow-control.js";
export type {
  PaoDesktopFlow,
  PaoDesktopFlowControlModule,
  PaoDesktopFlowReadResult,
  PaoFlowCommandParams,
  PaoFlowControlManifest,
  PaoFlowNodeReport,
  PaoFlowProgress,
} from "./pao-flow-control.js";
export { loadPaoDesktopPlans } from "./pao-plans.js";
export type {
  PaoDesktopPlanModule,
  PaoPlanArtifact,
  PaoPlanFeedback,
  PaoPlanReadResult,
  PaoPlanStartLink,
  PaoPlanStep,
  PaoPlanStepProgress,
  PaoPlanStepRecord,
  PaoPlanView,
} from "./pao-plans.js";
// 部门详情薄桥必须在模块顶层 re-export：宿主主进程体积是懒加载的，只有被静态求值的
// 导入才会进产物；放在惰性 import() 里拿不到（core lane 曾因此在真实 Electron 里
// 一直跑到旧渲染层，报错却指向新源码）。
export { loadPaoDesktopDept } from "./pao-dept.js";
export type {
  PaoDeptCatalog,
  PaoDeptCatalogRow,
  PaoDeptDetail,
  PaoDeptIssue,
  PaoDeptLoad,
  PaoDeptReadIssue,
  PaoDeptSkillView,
  PaoDeptSourceRef,
  PaoDeptStandard,
  PaoDeptTier,
  PaoDeptViewOptions,
  PaoDesktopDeptModule,
} from "./pao-dept.js";
export {
  loadPaoWorktreeRuntime,
  type PaoWorktreeRuntime,
} from "./pao-worktree-runtime.js";
export { RUNTIME_SCHEMA_VERSION } from "./session-schema.js";
export type { GenerateThreadTitleOptions } from "./thread-title-generator.js";
export type {
  PiDesktopExtensionObserver,
  PiDesktopExtensionRuntime,
} from "./desktop-extension-bridge.js";
export type {
  McpServerListing,
  McpServerScope,
  McpServerSummary,
  NewMcpServer,
} from "./mcp-config.js";
