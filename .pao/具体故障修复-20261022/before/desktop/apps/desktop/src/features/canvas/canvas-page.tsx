import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { WorkflowTabRecord, WorkspaceSessionTarget } from "../../../contracts/desktop-state";
import { workflowTabForSession } from "../../../contracts/desktop-state";
import { WorkflowTabs } from "./workflow-tabs";
import { EmbeddedChat } from "../conversation/embedded-chat";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { WorkflowCatalogSnapshot } from "../../../contracts/workflow-wizard";
import {
  RecipeCanvasEditor,
  type RecipeEditorActions,
  type RecipeEditorEntry,
} from "./recipe-canvas-editor";
import type {
  CanvasNodeDetailData,
  CanvasNodeReceiptRound,
  CanvasResult,
  CanvasSnapshot,
} from "../../../contracts/canvas";
import type { PiDesktopApi } from "../../../contracts/ipc";
import { useI18n } from "../../i18n/react";
import { useViewAutoRefresh } from "../../ui/view-auto-refresh";
import { trapDialogFocus } from "../../ui/dialog-focus";
import {
  AMBIGUOUS_INSTANCE_MESSAGE,
  canvasArrivalPlan,
  canvasBaselineOf,
  type CanvasEnvelopeBaseline,
  canvasNodeTone,
  cardStatusLabel,
  instanceDagNodes,
  locateNewInstances,
  recipeDagNodes,
  recipeForInstance,
  resolveInstance,
  type CanvasNodeView,
} from "./canvas-model";
import { WorkflowWizard, type WorkflowWizardIdentity } from "./workflow-wizard";
import { InstanceWorkflowView } from "./instance-workflow-view";
import { WorkflowRuntimeControls } from "./workflow-runtime-controls";
import { NodeRuntimeDetails } from "./node-runtime-details";
import { RecipeLibrary } from "./recipe-library";
import { WorkflowEditor } from "./workflow-editor";
import { readCanvasViewPreference, saveCanvasViewPreference } from "./canvas-view-preferences";

/**
 * 工作流画布整页视图 v1（只读，P4-2；P4-4 增 D8d 节点详情＋主控跳转）：打开视图拉一次
 * ＋手动刷新＋打开期间 30s 静默轮询（波3 §2a，卸载即停），不缓存。三区布局：左＝工作流列表（配方库校验态＋实例＋异常行），
 * 中＝画布 DAG（分层布局，节点框名字/部门/状态着色，depends_on 边，回边虚线），
 * 右＝节点详情（实例节点＝D8d 深读：模板值 vs 卡面实际值/回执轮次/执行锚点/升档理由；
 * 配方节点＝模板摘要）。unavailable 显示主进程给出的中文原因横幅。
 */

/** 左侧列表的选中源：配方（模板视图）或实例（清单＋卡现读）。 */
export interface CanvasSelection {
  readonly kind: "recipe" | "instance";
  readonly name: string;
  readonly path?: string;
}

/** 未保存新配方骨架的解析顺序（显式化，S3-1）：①当前标签自己的骨架 ②同名骨架兜底
 *  （标签切换竞态、无标签上下文；骨架名按新建避让规则全局唯一，同名即同物）③目录配方。
 *  骨架命中前不得退到目录，否则未保存草稿被旧配方顶掉（T08/T09）。 */
export function resolveEditorEntry(input: {
  readonly selection: CanvasSelection | null;
  readonly newEntries: Readonly<Record<string, RecipeEditorEntry>>;
  readonly activeTabId?: string;
  readonly catalog?: WorkflowCatalogSnapshot;
}): RecipeEditorEntry | undefined {
  if (input.selection?.kind !== "recipe") return undefined;
  const owned = input.activeTabId ? input.newEntries[input.activeTabId] : undefined;
  if (owned?.name === input.selection.name) return owned;
  const byName = Object.values(input.newEntries).find((row) => row.name === input.selection?.name);
  if (byName) return byName;
  return input.catalog?.recipes.find((row) => row.name === input.selection?.name);
}

/** 启动后补拉＋定位新运行记录（S6-D1/S6-D2；提为导出函数供守卫语义单测，行为同内联版）。
 * 数据面走 applyCanvasResult（requestId 竞速＋指纹去重），命中单个新实例自动开运行标签，
 * 0/多匹配如实报错不猜选。 */
export async function pullCanvasAfterStart(input: {
  readonly currentRequest: number;
  readonly requestId: { current: number };
  readonly getCanvas: () => Promise<CanvasResult>;
  readonly applyCanvasResult: (currentRequest: number, value: CanvasResult) => void;
  readonly name: string;
  readonly project?: string;
  readonly workspaceId?: string;
  readonly beforeStartPaths: { current: ReadonlySet<string> };
  readonly workflowTabs: readonly WorkflowTabRecord[];
  readonly changeTabs: (tabs: readonly WorkflowTabRecord[], activeId: string) => Promise<void>;
  readonly setLoadError: (message: string) => void;
  readonly setLoading: (loading: boolean) => void;
}): Promise<void> {
  try {
    const value = await input.getCanvas();
    input.applyCanvasResult(input.currentRequest, value);
    if (value.state !== "available" || !input.project || !input.workspaceId) return;
    const instances = locateNewInstances(
      value.instances,
      input.name,
      input.beforeStartPaths.current,
      input.project,
    );
    if (instances.length > 1) {
      input.setLoadError(
        "工作流已启动，请在左侧选择此次运行记录；发现多个同名运行记录，未自动猜选。",
      );
      return;
    }
    if (instances.length === 0) {
      // 0 匹配＝此次实例没进画布读模型（如 v1 旧版配方实例按契约不展示，
      // 读模型只认带冻结配方的 v2 实例）；如实告知，不能谎报同名冲突。
      input.setLoadError(
        "工作流已启动，但画布暂未读到此次运行记录；旧版工作流的运行记录不在画布展示范围，可在主控对话查看启动报告。",
      );
      return;
    }
    const instance = instances[0];
    if (!instance) return;
    // S4-1 唯一性：运行标签不继承编辑标签的 controller（同会话不绑两标签）。
    const tab: WorkflowTabRecord = {
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      title: instance.name,
      instanceName: instance.name,
      instancePath: instance.path,
      mode: "runtime",
    };
    await input.changeTabs([...input.workflowTabs, tab], tab.id);
  } catch (error: unknown) {
    // 与 refresh 守卫同款（波审 P2-1）：被更新请求取代的迟到失败不覆写新视图的错误态。
    if (input.requestId.current !== input.currentRequest) return;
    input.setLoadError(error instanceof Error ? error.message : String(error));
  } finally {
    if (input.requestId.current === input.currentRequest) input.setLoading(false);
  }
}

export interface CanvasPageViewProps {
  readonly catalog?: WorkflowCatalogSnapshot;
  readonly projectTabs?: readonly WorkflowTabRecord[];
  readonly activeTab?: WorkflowTabRecord;
  readonly onInstallTemplate?: (id: string, name?: string) => void;
  readonly canInstallTemplate?: boolean;
  /** 删除配方（S3-3）：父层负责离开守卫、内核确认与成功后的刷新/关标签。 */
  readonly onDeleteRecipe?: (name: string) => void;
  /** 「在新标签中打开」显式入口（S4-1⑤）：配方库行右键；不传则菜单项不显示。 */
  readonly onOpenInNewTab?: (name: string) => void;
  /** S4-2 单工作流嵌入视图：隐藏左侧工作流库（标签栏由不传 tabs 隐藏）。 */
  readonly hideLibrary?: boolean;
  /** 「返回工作流中心」退出嵌入视图；仅在嵌入视图时传入。 */
  readonly onExitSingleView?: () => void;
  readonly tabs?: ReactNode;
  readonly recipeEditor?: ReactNode;
  readonly canSelect?: (selection: CanvasSelection) => boolean;
  readonly result: CanvasResult;
  readonly loading: boolean;
  readonly loadError?: string;
  readonly onRefresh: () => void;
  /** 打开启流向导（P4-3）；画布页受控/组件测试可不传。 */
  readonly onStartWorkflow?: () => void;
  readonly onNewRecipe?: () => void;
  /** 打开主控会话（P4-4）：存在＝跳当前主控线程，不存在＝App 侧新建＋预填主控提示词。 */
  readonly onOpenMasterSession?: () => void;
  readonly masterSessionLabel?: string;
  readonly masterSessionDisabled?: boolean;
  /** 节点→会话跳转（P4-4）：返回是否在应用工作区里找到该会话。 */
  readonly onOpenSessionThread?: (sessionId: string) => boolean;
  /** 详情深读通道（P4-4）；受控组件测试可不传，右栏退化为 v1 摘要字段。 */
  readonly api?: PiDesktopApi;
  /** 选中态受控 props（组件测试用）；缺省时内部自持状态。 */
  readonly selection?: CanvasSelection | null;
  readonly onSelectionChange?: (selection: CanvasSelection) => void;
  readonly selectedNode?: string | null;
  readonly refreshToken?: number;
  readonly onSelectedNodeChange?: (name: string | null) => void;
}

export function CanvasPage({
  api,
  project,
  workspaceId,
  workflowTabs = [],
  activeWorkflowTabId,
  onUpdateTabs,
  onActivateController,
  embeddedChat,
  chatTarget,
  onCreateController,
  onOpenSessionThread,
  workflowEntryNonce,
}: {
  readonly api: PiDesktopApi;
  /** 标签所属项目；不能借用当前随机选中的普通会话。 */
  readonly project?: string;
  readonly workspaceId?: string;
  readonly workflowTabs?: readonly WorkflowTabRecord[];
  readonly activeWorkflowTabId?: string;
  readonly onUpdateTabs?: (tabs: readonly WorkflowTabRecord[], activeId: string) => Promise<void>;
  readonly onActivateController?: (target: WorkspaceSessionTarget) => Promise<void>;
  readonly embeddedChat?: ReactNode;
  readonly chatTarget?: WorkspaceSessionTarget;
  /** 建立属于此工作流的新主控会话，保持画布页面。 */
  readonly onCreateController?: (title: string, tabId?: string) => Promise<WorkflowWizardIdentity>;
  /** 节点→会话跳转；App 在全部工作区里解析会话标识。 */
  readonly onOpenSessionThread?: (sessionId: string) => boolean;
  /**
   * sidebar 工作流入口信号（S4-2）：每次点击自增。当前会话已绑定标签时消费该信号
   * 进入单工作流嵌入视图；未绑定为 no-op（完整中心是缺省形态）。
   */
  readonly workflowEntryNonce?: number;
}) {
  const [result, setResult] = useState<CanvasResult | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const [readAt, setReadAt] = useState<string>();
  const [wizardOpen, setWizardOpen] = useState(false);
  const beforeStartPaths = useRef<ReadonlySet<string>>(new Set());
  const [catalog, setCatalog] = useState<WorkflowCatalogSnapshot>();
  /** 未保存新配方骨架，按所属标签 id 存（无标签上下文用 "draft" 槽）；保存/关标签只删自己的。 */
  const [newEntries, setNewEntries] = useState<Record<string, RecipeEditorEntry>>({});
  const [selection, setSelection] = useState<CanvasSelection | null>(null);
  /** 编辑器上报的「有未保存内容或未落盘」（editorUnsaved 口径，与徽章同源）；
   *  离开守卫、标签圆点、activeTab 同步让位都用这一个值。 */
  const [dirty, setDirty] = useState(false);
  const [controllerBusy, setControllerBusy] = useState(false);
  const activeTab = workflowTabs.find(
    (tab) => tab.id === activeWorkflowTabId && tab.workspaceId === workspaceId,
  );
  const projectTabs = workflowTabs.filter((tab) => tab.workspaceId === workspaceId);
  // S4-1③：主控身份只从标签绑定派生（单源）。曾有 controllers 内存回退——controller 被归档/
  // 删除对账剥离后它仍供身份，导致「建立主控会话」保持禁用、保存用失效会话，无法重建；已删。
  const identity =
    activeTab?.controller && project
      ? { sessionId: activeTab.controller.sessionId, project }
      : undefined;
  const [tabBusy, setTabBusy] = useState(false);
  const tabSelectionRef = useRef({ workflowTabs, activeTab, onUpdateTabs, tabBusy });
  tabSelectionRef.current = { workflowTabs, activeTab, onUpdateTabs, tabBusy };
  const updateSelectedElement = useCallback((id: string | undefined) => {
    const current = tabSelectionRef.current;
    // 标签整表写入进行中时 props 必然滞后：这里再做一次全表写会把并行的新增/改名标签覆掉
    // （S3-1：新标签被骨架编辑器挂载时的 selectedElementId 上报整表覆写而消失）。选中恢复
    // 只是锦上添花，这次上报直接丢弃，等下一次选中变化再持久化。
    if (!current.activeTab || !current.onUpdateTabs || current.tabBusy) return;
    const tab = current.activeTab;
    if (tab.selectedElementId === id) return;
    const tabs = current.workflowTabs.map((row) =>
      row.id === tab.id ? { ...row, selectedElementId: id } : row,
    );
    void current
      .onUpdateTabs(tabs, tab.id)
      .catch((error: unknown) =>
        setLoadError(error instanceof Error ? error.message : String(error)),
      );
  }, []);
  useEffect(() => {
    const controller = activeTab?.controller;
    if (
      !controller ||
      !onActivateController ||
      tabBusy ||
      (chatTarget?.workspaceId === controller.workspaceId &&
        chatTarget.sessionId === controller.sessionId)
    )
      return;
    void onActivateController(controller).catch((error: unknown) =>
      setLoadError(error instanceof Error ? error.message : String(error)),
    );
  }, [activeTab?.controller, chatTarget, onActivateController, tabBusy]);
  const changeTabs = async (tabs: readonly WorkflowTabRecord[], activeId: string) => {
    if (!onUpdateTabs) return;
    setTabBusy(true);
    try {
      await onUpdateTabs(tabs, activeId);
      const tab = tabs.find((row) => row.id === activeId);
      if (tab?.controller) await onActivateController?.(tab.controller);
      setSelection(
        tab?.instanceName
          ? { kind: "instance", name: tab.instanceName, path: tab.instancePath }
          : tab?.recipeName
            ? { kind: "recipe", name: tab.recipeName }
            : null,
      );
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setTabBusy(false);
    }
  };
  /** 选中新工作流/运行记录：默认去重（edit 同配方/同实例路径复用既有标签）；
   *  forceNewTab＝「在新标签中打开」显式入口（S4-1⑤），同配方多标签各自独立。 */
  const openSelection = (next: CanvasSelection, forceNewTab = false) => {
    if (!workspaceId || !onUpdateTabs) {
      setSelection(next);
      return;
    }
    // 标签表取 ref 最新值：本函数会经守卫挂起后执行（requestAction 闭包），彼时 props
    // 可能滞后于刚落地的整表写入（如保存改名），闭包捕获的旧表会整表覆掉新名。
    const currentTabs = tabSelectionRef.current.workflowTabs;
    const existing = forceNewTab
      ? undefined
      : currentTabs.find(
          (tab) =>
            tab.workspaceId === workspaceId &&
            (next.kind === "recipe"
              ? tab.recipeName === next.name && tab.mode === "edit"
              : next.path
                ? tab.instancePath === next.path
                : tab.instanceName === next.name),
        );
    const tab: WorkflowTabRecord = existing ?? {
      id: crypto.randomUUID(),
      workspaceId,
      title: next.name,
      mode: next.kind === "recipe" ? "edit" : "runtime",
      ...(next.kind === "recipe"
        ? { recipeName: next.name }
        : { instanceName: next.name, instancePath: next.path }),
    };
    void changeTabs(existing ? currentTabs : [...currentTabs, tab], tab.id).catch(
      (error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)),
    );
  };
  useEffect(() => {
    if (!activeTab || dirty || tabBusy) return;
    if (activeTab.instanceName)
      setSelection({
        kind: "instance",
        name: activeTab.instanceName,
        path: activeTab.instancePath,
      });
    else if (activeTab.recipeName) setSelection({ kind: "recipe", name: activeTab.recipeName });
  }, [activeTab, dirty, tabBusy]);
  const editorRef = useRef<RecipeEditorActions>(null);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const pendingCancelRef = useRef<() => void>(() => {});
  const cancelPendingAction = () => {
    pendingCancelRef.current();
    pendingCancelRef.current = () => {};
    setPendingAction(null);
  };
  useEffect(
    () =>
      api.onWorkflowLeaveRequest(() => {
        if (!dirty) return Promise.resolve(true);
        // 已显示的保存选择继续处理原动作；后来的关窗请求先取消，不能覆盖回执。
        if (pendingAction) return Promise.resolve(false);
        return new Promise<boolean>((resolve) => {
          pendingCancelRef.current = () => resolve(false);
          setPendingAction(() => () => resolve(true));
        });
      }),
    [api, dirty, pendingAction],
  );
  useEffect(() => () => pendingCancelRef.current(), []);
  const [resolving, setResolving] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!pendingAction) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [pendingAction]);
  const requestAction = (action: () => void) => {
    if (pendingAction) return;
    if (dirty) {
      pendingCancelRef.current = () => {};
      setPendingAction(() => action);
    } else action();
  };

  /** 底部主控面板的渲染条件：身份在、活动标签绑有主控、全局当前会话就是这个主控
   *  （寄生激活模型：激活＝改写全局选择，画布内显示的必是标签主控）。 */
  const chatLive = Boolean(
    identity &&
    activeTab?.controller &&
    chatTarget?.workspaceId === activeTab.controller.workspaceId &&
    chatTarget.sessionId === identity.sessionId,
  );
  /** S4-2 单工作流嵌入视图：sidebar 入口且主控面板在位时隐藏标签栏与工作流库；
   *  「返回工作流中心」退出。嵌入态随画布卸载重置，重启/其他入口恢复完整中心。 */
  const [embedded, setEmbedded] = useState(false);
  const singleView = embedded && chatLive;
  const lastEntryNonceRef = useRef(0);
  useEffect(() => {
    if (!workflowEntryNonce || workflowEntryNonce === lastEntryNonceRef.current) return;
    lastEntryNonceRef.current = workflowEntryNonce;
    if (!workspaceId || !onUpdateTabs) return;
    // 反查索引（S4-1②）：当前会话绑定到哪个标签。未绑定＝完整中心，不动。
    const bound = chatTarget ? workflowTabForSession(workflowTabs, chatTarget) : undefined;
    if (!bound || bound.workspaceId !== workspaceId) return;
    if (activeTab?.id === bound.id) {
      setEmbedded(true);
      return;
    }
    // 绑定标签不是活动标签：经离开守卫（未保存内容仍受保护）切回绑定标签再进嵌入视图；
    // 守卫取消＝留在完整中心，不强行切换。
    requestAction(() => {
      void changeTabs(tabSelectionRef.current.workflowTabs, bound.id)
        .then(() => setEmbedded(true))
        .catch((error: unknown) =>
          setLoadError(error instanceof Error ? error.message : String(error)),
        );
    });
  }, [workflowEntryNonce, chatTarget, workflowTabs, activeTab?.id, workspaceId, onUpdateTabs]);

  // 刷新竞速守卫（kanban/workboard 同款 requestId 语义）＋视图信封消费（S6-D2）：
  // 旧 requestId 响应作废不覆新（换代际后的旧请求迟到同此作废）；同代际同 revision
  // 跳过提交不触发渲染更新；新代际随最新请求接管基准——拉模式下「切会话/工作流重置
  //  generation」即此形态：切作用域后新查询永远可采纳，事件通道落地后再叠加拒旧过滤
  // （canvasEventStale，K4 契约：消费方切换后以新查询的代际为基准）。
  const requestId = useRef(0);
  const baselineRef = useRef<CanvasEnvelopeBaseline>({});
  const applyCanvasResult = useCallback((currentRequest: number, value: CanvasResult) => {
    const arrival = canvasBaselineOf(value);
    const plan = canvasArrivalPlan({
      requestId: currentRequest,
      latestRequestId: requestId.current,
      arrival,
      baseline: baselineRef.current,
    });
    if (plan === "drop") return;
    if (value.state === "unavailable") {
      setLoadError(value.message);
      setResult((previous) => (previous?.state === "available" ? previous : value));
      return;
    }
    setRefreshToken((current) => current + 1);
    setReadAt(new Date().toLocaleTimeString());
    if (plan === "commit") {
      setResult(value);
      baselineRef.current = arrival;
    }
  }, []);

  // silent＝30s 轮询（波3 §2a）：不闪 Loading，结果与错误照常走竞速守卫；同 revision
  // 由 canvasArrivalPlan 指纹去重跳过提交，不触发渲染跳动。.then 补齐 requestId 守卫
  // ——轮询与手动刷新并行后，迟到响应不得覆写目录/错误态。
  const runRefresh = useCallback(
    (silent: boolean) => {
      const currentRequest = ++requestId.current;
      if (!silent) setLoading(true);
      Promise.all([api.getCanvas(), api.getWorkflowCatalog()])
        .then(([value, nextCatalog]) => {
          if (requestId.current !== currentRequest) return;
          applyCanvasResult(currentRequest, value);
          if (nextCatalog.state === "available") {
            setCatalog(nextCatalog);
            if (value.state === "available") setLoadError(undefined);
          } else setLoadError(nextCatalog.message);
        })
        .catch((error: unknown) => {
          if (requestId.current !== currentRequest) return;
          setLoadError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (requestId.current === currentRequest) setLoading(false);
        });
    },
    [api, applyCanvasResult],
  );
  const refresh = useCallback(() => runRefresh(false), [runRefresh]);
  const refreshSilently = useCallback(() => runRefresh(true), [runRefresh]);
  useViewAutoRefresh(refreshSilently);

  useEffect(() => {
    refresh();
    // 卸载（切视图/切会话）后旧响应不得再落状态：本地代际基准随组件重置，
    // 重挂后的首次拉取以新代际接管基准（K4：切换后以新查询的代际为基准）。
    return () => {
      requestId.current++;
    };
  }, [refresh]);
  const editorEntry = resolveEditorEntry({
    selection,
    newEntries,
    activeTabId: activeTab?.id,
    catalog,
  });
  const createNewRecipe = () =>
    requestAction(() => {
      let index = 1;
      while (
        catalog?.recipes.some((row) => row.name === `新工作流${index}`) ||
        projectTabs.some((tab) => tab.title === `新工作流${index}`) ||
        Object.values(newEntries).some((row) => row.name === `新工作流${index}`)
      )
        index++;
      const name = `新工作流${index}`;
      const entry: RecipeEditorEntry = {
        name,
        revision: null,
        recipe: { 版本: 2, 名字: name, 自动执行: false, 参数: [], 节点: [], ui: { positions: {} } },
      };
      setSelection({ kind: "recipe", name });
      if (workspaceId && onUpdateTabs) {
        // S4-1 唯一性：新标签不继承旧标签的 controller——同一会话不得绑两个标签，
        // 各标签需要主控时各自「建立主控会话」。
        const tab: WorkflowTabRecord = {
          id: crypto.randomUUID(),
          workspaceId,
          title: name,
          recipeName: name,
          mode: "edit",
        };
        setNewEntries((current) => ({ ...current, [tab.id]: entry }));
        // 同上：整表写基于 ref 最新表，避免守卫保存改名后被旧闭包表覆写（P3-1）。
        void changeTabs([...tabSelectionRef.current.workflowTabs, tab], tab.id).catch(
          (error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)),
        );
      } else {
        setNewEntries((current) => ({ ...current, draft: entry }));
      }
    });

  /** 删除工作流（S3-3）：走内核删除入口；确认弹窗在内核 ui.confirm（说明含 .bak 备份
   *  与冻结运行记录不受影响）。不进离开守卫（S12 故障②）：删除是配方库目录操作，不切走
   *  画布——活动标签是未保存骨架时「保存并继续」存不了盘，用户被三选循环卡死；被删配方
   *  的未保存修改随删除丢弃（文件已删，事后保存反而会重建文件），无关标签不受影响。
   *  确认会话取本工作区任一标签绑定的主控（内核只校验会话已注册＋项目相符），不要求
   *  活动标签；一个主控都没有时（刚开应用，标签绑定是内存态不随重启恢复）自动建一个
   *  再删（故障③续：删除确认需要会话通道，不能让用户先手动建主控）。
   *  失败如实透出不关标签；成功关闭对应编辑标签并刷新目录。 */
  const deleteRecipe = (name: string) => {
    const deleteWith = (sessionId: string, project: string) => {
      void (async () => {
        // 用目录最新指纹做乐观锁：期间被其他入口改动时由内核守卫拒绝删除。
        const nextCatalog = await api.getWorkflowCatalog();
        const revision =
          nextCatalog.state === "available"
            ? (nextCatalog.recipes.find((row) => row.name === name)?.revision ?? null)
            : null;
        const result = await api.deleteWorkflowRecipe({
          sessionId,
          project,
          name,
          revision,
        });
        if (result.state === "error") throw new Error(result.message);
        // 删除经内核确认后执行：标签表取 ref 最新值（执行时 props 可能滞后，同 P3-1 口径）。
        const currentTabs = tabSelectionRef.current.workflowTabs;
        const doomed = currentTabs.filter(
          (row) => row.workspaceId === workspaceId && row.recipeName === name,
        );
        if (doomed.length > 0 && workspaceId && onUpdateTabs) {
          const doomedIds = new Set(doomed.map((tab) => tab.id));
          setNewEntries((current) => {
            const next = { ...current };
            for (const id of doomedIds) delete next[id];
            return next;
          });
          const tabs = currentTabs.filter((row) => !doomedIds.has(row.id));
          const activeId = doomedIds.has(activeWorkflowTabId ?? "")
            ? (tabs.find((row) => row.workspaceId === workspaceId)?.id ?? "")
            : (activeWorkflowTabId ?? "");
          await changeTabs(tabs, activeId);
        }
        refresh();
      })().catch((error: unknown) =>
        setLoadError(error instanceof Error ? error.message : String(error)),
      );
    };
    const controller = projectTabs.find((tab) => tab.controller)?.controller;
    if (controller && project) {
      deleteWith(controller.sessionId, project);
      return;
    }
    if (!onCreateController || !project) {
      setLoadError("请先建立主控会话，再删除工作流。");
      return;
    }
    setControllerBusy(true);
    void onCreateController("主控", activeTab?.id)
      .then((identity) => deleteWith(identity.sessionId, project))
      .catch((error: unknown) =>
        setLoadError(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setControllerBusy(false));
  };

  return (
    <Group orientation="vertical" className="workflow-surface">
      <Panel id="workflow-surface-graph" defaultSize="70%" minSize="300px">
        {readAt ? (
          <p className="canvas-status">画布最近读取：{readAt} · 打开期间每 30 秒刷新</p>
        ) : null}
        {!loading && selection?.kind === "recipe" && !editorEntry && catalog ? (
          <p className="error-banner" role="alert">
            当前工作流尚未保存或已被移除。未保存的画布草稿不会在重启后恢复，请新建或从工作流库选择已有工作流。
          </p>
        ) : null}
        {/* 「保存并继续」会让内核确认框（扩展会话确认，z-index 30）叠在本守卫之上，
            守卫背景层必须低于它（26，向导 25 之上），否则确认框被压住点不到＝保存死锁（S3-1）。 */}
        {pendingAction ? (
          <div className="tree-modal-backdrop tree-modal-backdrop--guard">
            <section
              className="tree-modal tree-modal--compact"
              ref={dialogRef}
              tabIndex={-1}
              onKeyDown={(event) => {
                if (event.key === "Tab") trapDialogFocus(event, dialogRef.current);
                if (event.key === "Escape" && !resolving) {
                  event.preventDefault();
                  cancelPendingAction();
                }
              }}
              role="dialog"
              aria-modal="true"
              aria-label="未保存修改"
            >
              <h2>当前工作流有未保存修改</h2>
              <p>保存后继续，或放弃本次修改。取消会保留当前画布。</p>
              <div className="wizard-actions">
                <button
                  className="button"
                  disabled={resolving}
                  type="button"
                  onClick={cancelPendingAction}
                >
                  取消
                </button>
                <button
                  className="button"
                  disabled={resolving}
                  type="button"
                  onClick={() => {
                    editorRef.current?.discard();
                    // 不在此强设 dirty=false：未落盘骨架 discard 后 editorUnsaved 仍为 true，
                    // 编辑器会按值变化自行上报；强设会把骨架的二次切走保护悄悄拆掉（S3-1）。
                    setPendingAction(null);
                    pendingAction();
                  }}
                >
                  放弃并继续
                </button>
                <button
                  className="button button--primary"
                  disabled={resolving}
                  type="button"
                  onClick={() => {
                    setResolving(true);
                    const actions = editorRef.current;
                    if (!actions) {
                      setResolving(false);
                      setLoadError("编辑器尚未就绪，请取消后重试。");
                      return;
                    }
                    void actions
                      .save()
                      .then((saved) => {
                        if (saved) {
                          setDirty(false);
                          setPendingAction(null);
                          pendingAction();
                        } else cancelPendingAction();
                      })
                      .catch((error: unknown) => {
                        setLoadError(error instanceof Error ? error.message : String(error));
                        cancelPendingAction();
                      })
                      .finally(() => setResolving(false));
                  }}
                >
                  保存并继续
                </button>
              </div>
            </section>
          </div>
        ) : null}
        {wizardOpen ? (
          <WorkflowWizard
            api={api}
            identity={identity}
            onClose={() => setWizardOpen(false)}
            onStarted={(name) => {
              setWizardOpen(false);
              setLoading(true);
              // 与 refresh 同一 requestId 守卫：启动后补拉不得被先前的刷新响应覆盖，
              // 也不能反过来覆盖随后的一次显式刷新（同代际同 revision 去重同款生效）。
              const currentRequest = ++requestId.current;
              void pullCanvasAfterStart({
                currentRequest,
                requestId,
                getCanvas: () => api.getCanvas(),
                applyCanvasResult,
                name,
                project,
                workspaceId,
                beforeStartPaths,
                workflowTabs,
                changeTabs,
                setLoadError,
                setLoading,
              }).catch((error: unknown) =>
                setLoadError(error instanceof Error ? error.message : String(error)),
              );
            }}
            initialRecipeName={selection?.kind === "recipe" ? selection.name : undefined}
          />
        ) : null}
        {selection?.kind === "instance" && workspaceId ? (
          <WorkflowRuntimeControls
            key={JSON.stringify([workspaceId, selection.name, selection.path])}
            api={api}
            workspaceId={workspaceId}
            instanceName={selection.name}
            instancePath={selection.path}
            sessionId={identity?.sessionId}
            refreshToken={refreshToken}
            selectedNode={activeTab?.selectedElementId}
            onSelectNode={(name) => updateSelectedElement(name)}
            onChanged={refresh}
            onEdit={(name) => requestAction(() => openSelection({ kind: "recipe", name }))}
            onOpenOwner={async (sessionId) => {
              if (!onActivateController || !activeTab || !onUpdateTabs)
                throw new Error("当前标签无法绑定主控。");
              const controller = { workspaceId, sessionId };
              // S4-1：同一主控会话只绑一个标签。会话已绑到别的标签时做「迁绑」——旧标签
              // 解绑、本标签绑定，一次整表写入，唯一性任意瞬间都成立；直接二次绑定会被
              // 主进程守卫拒绝，按钮从此永久灰死（S11-B2⑧）。「激活已绑定标签」的纯导航
              // 方案与运行控制面板的选中同步打架：离开本标签即卸载面板，回到本标签又是
              // 无绑定态（死循环），故弃（详见 S11-尾批实施记录）。
              const bound = workflowTabForSession(workflowTabs, controller);
              await onUpdateTabs(
                workflowTabs.map((tab) => {
                  if (bound && bound.id !== activeTab.id && tab.id === bound.id) {
                    const { controller: _dropped, ...unbound } = tab;
                    return unbound;
                  }
                  return tab.id === activeTab.id ? { ...tab, controller } : tab;
                }),
                activeTab.id,
              );
            }}
          />
        ) : null}
        <CanvasPageView
          catalog={catalog}
          projectTabs={projectTabs}
          activeTab={activeTab}
          canInstallTemplate={!!identity && !controllerBusy}
          onDeleteRecipe={deleteRecipe}
          onOpenInNewTab={(name) =>
            requestAction(() => openSelection({ kind: "recipe", name }, true))
          }
          hideLibrary={singleView}
          onExitSingleView={singleView ? () => setEmbedded(false) : undefined}
          onInstallTemplate={(templateId, name) =>
            requestAction(() => {
              if (!identity) {
                setLoadError("请先建立主控会话，再安装模板。");
                return;
              }
              setControllerBusy(true);
              void api
                .installWorkflowTemplate({ ...identity, templateId, name })
                .then((value) => {
                  if (value.state === "error") throw new Error(value.message);
                  refresh();
                })
                .catch((error: unknown) =>
                  setLoadError(error instanceof Error ? error.message : String(error)),
                )
                .finally(() => setControllerBusy(false));
            })
          }
          tabs={
            !singleView && workspaceId && onUpdateTabs ? (
              <WorkflowTabs
                tabs={projectTabs}
                activeId={activeTab?.id}
                dirty={dirty}
                disabled={tabBusy}
                onNew={createNewRecipe}
                onSelect={(id) =>
                  requestAction(() => {
                    // 切换型 pendingAction：整表取 ref 最新值（守卫保存改名后旧闭包表
                    // 会整表覆写新名，后到者胜，P3-1）。
                    void changeTabs(tabSelectionRef.current.workflowTabs, id).catch(
                      (error: unknown) =>
                        setLoadError(error instanceof Error ? error.message : String(error)),
                    );
                  })
                }
                onClose={(id) =>
                  requestAction(() => {
                    // 关标签同时丢掉它的未保存骨架（守卫已在前面处理过保存/放弃）。
                    setNewEntries((current) => {
                      if (!(id in current)) return current;
                      const next = { ...current };
                      delete next[id];
                      return next;
                    });
                    const tabs = tabSelectionRef.current.workflowTabs.filter(
                      (row) => row.id !== id,
                    );
                    const activeId =
                      id === activeWorkflowTabId
                        ? (tabs.find((row) => row.workspaceId === workspaceId)?.id ?? "")
                        : (activeWorkflowTabId ?? "");
                    void changeTabs(tabs, activeId).catch((error: unknown) =>
                      setLoadError(error instanceof Error ? error.message : String(error)),
                    );
                  })
                }
              />
            ) : undefined
          }
          selection={selection}
          refreshToken={refreshToken}
          selectedNode={
            selection?.kind === "instance" ? (activeTab?.selectedElementId ?? null) : undefined
          }
          onSelectedNodeChange={
            selection?.kind === "instance"
              ? (name) => updateSelectedElement(name ?? undefined)
              : undefined
          }
          onSelectionChange={openSelection}
          canSelect={(next) => {
            if (
              !dirty ||
              (next.kind === selection?.kind &&
                next.name === selection.name &&
                next.path === selection.path)
            )
              return true;
            requestAction(() => openSelection(next));
            return false;
          }}
          recipeEditor={
            editorEntry && catalog ? (
              <RecipeCanvasEditor
                key={JSON.stringify([workspaceId, editorEntry.name, editorEntry.revision])}
                api={api}
                entry={editorEntry}
                catalog={catalog}
                editorRef={editorRef}
                identity={identity}
                initialSelectedElementId={activeTab?.selectedElementId}
                onSelectedElementIdChange={updateSelectedElement}
                onDirtyChange={setDirty}
                onSaved={(name) => {
                  setDirty(false);
                  // 只删本次保存的骨架（属主标签或同名槽），别的标签的骨架不动。
                  setNewEntries((current) => {
                    const next: Record<string, RecipeEditorEntry> = {};
                    for (const [key, value] of Object.entries(current)) {
                      if (key === activeTab?.id || value.name === name) continue;
                      next[key] = value;
                    }
                    return next;
                  });
                  setSelection({ kind: "recipe", name });
                  if (activeTab && onUpdateTabs) {
                    const tabs = workflowTabs.map((tab) =>
                      tab.id === activeTab.id ? { ...tab, title: name, recipeName: name } : tab,
                    );
                    // 这份整表写入就是最新标签事实：同步登记进 ref。守卫「保存并继续」
                    // 的 pendingAction 在保存 .then 微任务里立即执行，早于快照回传引发
                    // 的重渲染，届时只有 ref 能拿到改名后的表；否则旧闭包整表写会覆掉
                    // 新名（主进程整表替换后到者胜，S3 对抗审核 P3-1）。
                    tabSelectionRef.current = { ...tabSelectionRef.current, workflowTabs: tabs };
                    void onUpdateTabs(tabs, activeTab.id).catch((error: unknown) =>
                      setLoadError(error instanceof Error ? error.message : String(error)),
                    );
                  }
                  refresh();
                }}
              />
            ) : undefined
          }
          api={api}
          result={result ?? { state: "unavailable", code: "aggregates-unavailable", message: "" }}
          loading={loading}
          loadError={loadError}
          onRefresh={() => requestAction(refresh)}
          onStartWorkflow={() =>
            requestAction(() => {
              beforeStartPaths.current = new Set(
                result?.state === "available" ? result.instances.map((row) => row.path) : [],
              );
              setWizardOpen(true);
            })
          }
          onNewRecipe={createNewRecipe}
          masterSessionLabel={
            identity ? "主控会话已建立" : controllerBusy ? "正在建立主控会话…" : "建立主控会话"
          }
          masterSessionDisabled={controllerBusy || !!identity}
          onOpenMasterSession={
            onCreateController && selection
              ? () => {
                  if (controllerBusy || identity) return;
                  setControllerBusy(true);
                  // 创建即同批绑定到活动标签（主进程同次状态发布），身份随后由标签绑定派生。
                  void onCreateController(`${selection.name} · 主控`, activeTab?.id)
                    .catch((error: unknown) =>
                      setLoadError(error instanceof Error ? error.message : String(error)),
                    )
                    .finally(() => setControllerBusy(false));
                }
              : undefined
          }
          onOpenSessionThread={
            onOpenSessionThread
              ? (sessionId) => {
                  if (dirty) {
                    requestAction(() => {
                      onOpenSessionThread(sessionId);
                    });
                    return true;
                  }
                  return onOpenSessionThread(sessionId);
                }
              : undefined
          }
        />
      </Panel>
      {chatLive ? (
        <>
          <Separator className="workflow-chat-separator" />
          <Panel id="workflow-surface-chat" defaultSize="30%" minSize="100px">
            <EmbeddedChat key={identity!.sessionId}>{embeddedChat}</EmbeddedChat>
          </Panel>
        </>
      ) : null}
    </Group>
  );
}

export function CanvasPageView({
  catalog,
  projectTabs = [],
  activeTab,
  onInstallTemplate,
  canInstallTemplate,
  onDeleteRecipe,
  onOpenInNewTab,
  hideLibrary,
  onExitSingleView,
  tabs,
  recipeEditor,
  canSelect,
  result,
  loading,
  loadError,
  onRefresh,
  onStartWorkflow,
  onNewRecipe,
  onOpenMasterSession,
  masterSessionLabel,
  masterSessionDisabled,
  onOpenSessionThread,
  api,
  selection,
  onSelectionChange,
  selectedNode,
  refreshToken,
  onSelectedNodeChange,
}: CanvasPageViewProps) {
  const { t } = useI18n();
  const [innerSelection, setInnerSelection] = useState<CanvasSelection | null>(null);
  const [innerNode, setInnerNode] = useState<string | null>(null);
  const [layoutPreference, setLayoutPreference] = useState(() =>
    readCanvasViewPreference("pao:canvas-layout:v1"),
  );
  const libraryCollapsed = layoutPreference.libraryCollapsed ?? false;
  const detailOpen = layoutPreference.detailOpen ?? true;
  const setLibraryCollapsed = (value: boolean) =>
    setLayoutPreference((current) => ({ ...current, libraryCollapsed: value }));
  const setDetailOpen = (value: boolean) =>
    setLayoutPreference((current) => ({ ...current, detailOpen: value }));
  useEffect(() => {
    saveCanvasViewPreference("pao:canvas-layout:v1", layoutPreference);
  }, [layoutPreference]);
  const [canvasExpanded, setCanvasExpanded] = useState(false);
  useEffect(() => {
    if (!canvasExpanded) return;
    const exit = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCanvasExpanded(false);
    };
    window.addEventListener("keydown", exit);
    return () => window.removeEventListener("keydown", exit);
  }, [canvasExpanded]);
  const activeSelection = selection !== undefined ? selection : innerSelection;
  const activeNode = selectedNode !== undefined ? selectedNode : innerNode;
  const select = (next: CanvasSelection) => {
    if (canSelect && !canSelect(next)) return;
    setInnerSelection(next);
    setInnerNode(null);
    onSelectionChange?.(next);
  };
  const selectNode = (name: string | null) => {
    setInnerNode(name);
    onSelectedNodeChange?.(name);
  };

  return (
    <section
      className={`canvas canvas-view${canvasExpanded ? " canvas-view--expanded" : ""}`}
      data-testid="canvas-view"
      data-expanded={canvasExpanded}
    >
      {tabs}
      <header className="view-header">
        <div>
          <h1 className="view-header__title">{t("Workflow canvas")}</h1>
          <p className="view-header__body">
            {t(
              "Edit workflow recipes freely; instances show their frozen graph and current card statuses.",
            )}
          </p>
        </div>
        <div className="view-header__actions">
          {!(activeSelection?.kind === "recipe" && recipeEditor) ? (
            <button
              type="button"
              className="button canvas-expand"
              data-testid="canvas-expand"
              aria-pressed={canvasExpanded}
              onClick={() => setCanvasExpanded((current) => !current)}
            >
              {canvasExpanded ? "退出专注画布（Esc）" : "专注画布"}
            </button>
          ) : null}
          {onExitSingleView ? (
            <button
              className="button"
              data-testid="canvas-exit-single-view"
              type="button"
              onClick={onExitSingleView}
            >
              返回工作流中心
            </button>
          ) : null}
          {onNewRecipe ? (
            <button
              className="button"
              type="button"
              data-testid="canvas-new-workflow"
              onClick={onNewRecipe}
            >
              新建工作流
            </button>
          ) : null}
          {onStartWorkflow ? (
            <button
              className="button button--primary"
              data-testid="canvas-start-workflow"
              type="button"
              onClick={onStartWorkflow}
            >
              {t("Start a workflow")}
            </button>
          ) : null}
          {onOpenMasterSession ? (
            <button
              className="button"
              data-testid="canvas-open-master-session"
              type="button"
              onClick={onOpenMasterSession}
              disabled={masterSessionDisabled}
            >
              {masterSessionLabel ?? t("Open master session")}
            </button>
          ) : null}
          <button
            className="button"
            data-testid="canvas-refresh"
            type="button"
            disabled={loading}
            onClick={onRefresh}
          >
            {t("Refresh")}
          </button>
          {!(activeSelection?.kind === "recipe" && recipeEditor) && !detailOpen ? (
            <button
              className="button canvas-detail-toggle"
              data-testid="canvas-detail-open"
              type="button"
              onClick={() => setDetailOpen(true)}
            >
              显示详情
            </button>
          ) : null}
        </div>
      </header>

      {loading ? (
        <p className="canvas-status" role="status">
          {t("Loading…")}
        </p>
      ) : null}

      {loadError ? (
        <p className="error-banner" role="alert" data-testid="canvas-load-error">
          {t("The workflow canvas could not be loaded.")} {loadError}
          {result.state === "available" ? " 上次成功内容仍保留，可能已过期。" : ""}
          <button
            className="button"
            data-testid="canvas-load-error-retry"
            type="button"
            disabled={loading}
            onClick={onRefresh}
          >
            重新读取
          </button>
        </p>
      ) : null}

      {!loading && result.state === "unavailable" ? (
        <p className="error-banner" role="alert" data-testid="canvas-unavailable">
          {result.message}
        </p>
      ) : null}

      {/* S6-D1 视口不跳：刷新进行中（loading）只叠一行状态，不卸载已挂载的画布——
          整块卸载重挂会把 ReactFlow 视口重置回 fitView，用户平移/缩放全丢。
          首次加载时 result 是 unavailable 占位，本分支自然不进。 */}
      {result.state === "available" ? (
        <>
          {result.error ? (
            <p className="error-banner" role="alert" data-testid="canvas-top-error">
              {result.error} 上次成功内容仍保留，可能已过期，请刷新重试。
              <button
                className="button"
                data-testid="canvas-top-error-retry"
                type="button"
                disabled={loading}
                onClick={onRefresh}
              >
                重新读取
              </button>
            </p>
          ) : null}
          <div
            className={`canvas-layout${libraryCollapsed ? " canvas-layout--library-collapsed" : ""}${hideLibrary ? " canvas-layout--no-library" : ""}${!(activeSelection?.kind === "recipe" && recipeEditor) && !detailOpen ? " canvas-layout--detail-closed" : ""}`}
          >
            {hideLibrary ? null : libraryCollapsed ? (
              <button
                type="button"
                className="button canvas-library-expand"
                aria-label="展开工作流库"
                onClick={() => setLibraryCollapsed(false)}
              >
                工作流库 ›
              </button>
            ) : (
              <RecipeLibrary
                snapshot={result}
                catalog={catalog}
                projectTabs={projectTabs}
                activeTab={activeTab}
                canInstallTemplate={canInstallTemplate}
                onInstallTemplate={onInstallTemplate ?? (() => {})}
                onDeleteRecipe={onDeleteRecipe}
                onOpenInNewTab={onOpenInNewTab}
                selection={activeSelection}
                onSelect={select}
                onCollapse={() => setLibraryCollapsed(true)}
              />
            )}
            {activeSelection?.kind === "recipe" && recipeEditor ? (
              recipeEditor
            ) : (
              <CanvasDagPanel
                snapshot={result}
                selection={activeSelection}
                selectedNode={activeNode}
                onSelectNode={selectNode}
              />
            )}
            {!(activeSelection?.kind === "recipe" && recipeEditor) && detailOpen ? (
              <CanvasDetailPanel
                snapshot={result}
                selection={activeSelection}
                selectedNode={activeNode}
                api={api}
                refreshToken={refreshToken}
                onOpenSessionThread={onOpenSessionThread}
                onClose={() => setDetailOpen(false)}
              />
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

/** 当前选中的 DAG 节点视图集：配方＝模板，实例＝清单＋卡现读（配方不可读时退化清单-only）。 */
function dagNodesFor(
  snapshot: CanvasSnapshot,
  selection: CanvasSelection | null,
): { nodes: CanvasNodeView[]; degraded: boolean; ambiguous: boolean } {
  if (!selection) return { nodes: [], degraded: false, ambiguous: false };
  if (selection.kind === "recipe") {
    const entry = snapshot.recipes.find((row) => row.available && row.name === selection.name);
    return {
      nodes: entry?.available ? recipeDagNodes(entry.recipe) : [],
      degraded: false,
      ambiguous: false,
    };
  }
  const { instance, ambiguous } = resolveInstance(snapshot.instances, selection);
  if (!instance) return { nodes: [], degraded: false, ambiguous };
  const recipe = recipeForInstance(snapshot, instance);
  return {
    nodes: instanceDagNodes(instance, recipe),
    degraded: recipe === undefined,
    ambiguous: false,
  };
}

function CanvasDagPanel({
  snapshot,
  selection,
  selectedNode,
  onSelectNode,
}: {
  readonly snapshot: CanvasSnapshot;
  readonly selection: CanvasSelection | null;
  readonly selectedNode: string | null;
  readonly onSelectNode: (name: string | null) => void;
}) {
  const { t } = useI18n();
  const { nodes, degraded } = dagNodesFor(snapshot, selection);
  if (selection?.kind === "instance") {
    return (
      <InstanceWorkflowView
        snapshot={snapshot}
        instanceName={selection.name}
        instancePath={selection.path}
        selectedNode={selectedNode}
        onSelectNode={onSelectNode}
      />
    );
  }
  return (
    <div className="canvas-board" data-testid="canvas-dag">
      {degraded ? (
        <p className="canvas-status" role="status" data-testid="canvas-dag-degraded">
          {t("The recipe for this instance could not be read; nodes are listed without edges.")}
        </p>
      ) : null}
      {nodes.length === 0 ? (
        <p className="canvas-empty" data-testid="canvas-dag-empty">
          {t("Select a recipe or an instance on the left to see its graph.")}
        </p>
      ) : (
        <WorkflowEditor
          nodes={nodes}
          readOnly
          selectedNode={selectedNode}
          onSelectNode={(name) => onSelectNode(name)}
        />
      )}
    </div>
  );
}

/** 预算稳定串化（键排序），供模板值 vs 卡面值比对与展示。 */
function formatBudget(budget: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (!budget) return undefined;
  const keys = Object.keys(budget).sort();
  if (keys.length === 0) return undefined;
  return keys.map((key) => `${key}=${String(budget[key])}`).join(" ");
}

function CanvasDetailPanel({
  snapshot,
  selection,
  selectedNode,
  api,
  onOpenSessionThread,
  refreshToken,
  onClose,
}: {
  readonly snapshot: CanvasSnapshot;
  readonly selection: CanvasSelection | null;
  readonly selectedNode: string | null;
  /** 供 D8d 深读与「查看卡」；缺省＝右栏只渲染 v1 摘要字段（受控组件测试）。 */
  readonly api?: PiDesktopApi;
  readonly onOpenSessionThread?: (sessionId: string) => boolean;
  readonly refreshToken?: number;
  readonly onClose?: () => void;
}) {
  const { t } = useI18n();
  const { nodes, ambiguous: ambiguousInstance } = dagNodesFor(snapshot, selection);
  const node = selectedNode ? nodes.find((item) => item.name === selectedNode) : undefined;
  const instance =
    selection?.kind === "instance"
      ? resolveInstance(snapshot.instances, selection).instance
      : undefined;
  const [detail, setDetail] = useState<CanvasNodeDetailData | undefined>();
  const [detailMessage, setDetailMessage] = useState<string | undefined>();
  const [cardMessage, setCardMessage] = useState<string | undefined>();
  const [sessionNote, setSessionNote] = useState<string | undefined>();
  const [detailReadAt, setDetailReadAt] = useState<string>();
  const [cardSelection, setCardSelection] = useState<{ key: string; ref: string }>();
  const cardKey = `${instance?.path ?? ""}\u0000${selectedNode ?? ""}`;
  const selectedCard =
    cardSelection?.key === cardKey &&
    node?.cards?.some((card) => card.cardRef === cardSelection.ref)
      ? cardSelection.ref
      : undefined;

  const instancePath = instance?.path;
  useEffect(() => {
    setDetail(undefined);
    setDetailMessage(undefined);
    setCardMessage(undefined);
    setSessionNote(undefined);
    setDetailReadAt(undefined);
  }, [api, instancePath, selectedNode, selectedCard]);
  useEffect(() => {
    if (!api || !instancePath || !selectedNode) return;
    let cancelled = false;
    api
      .getCanvasNodeDetail({
        instancePath,
        nodeName: selectedNode,
        ...(selectedCard ? { cardRef: selectedCard } : {}),
      })
      .then((result) => {
        if (cancelled) return;
        if (result.state === "ok") {
          setDetail(result.detail);
          setDetailMessage(undefined);
          setDetailReadAt(new Date().toLocaleTimeString());
        } else setDetailMessage(result.message);
      })
      .catch((error: unknown) => {
        if (!cancelled) setDetailMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [api, instancePath, selectedNode, selectedCard, refreshToken]);

  const openCard = () => {
    if (!api || !instancePath || !selectedNode) return;
    setCardMessage(undefined);
    void api
      .openCanvasCard({
        instancePath,
        nodeName: selectedNode,
        ...(selectedCard ? { cardRef: selectedCard } : {}),
      })
      .then((result) => {
        if (!result.ok) setCardMessage(result.message);
      })
      .catch((error: unknown) =>
        setCardMessage(error instanceof Error ? error.message : String(error)),
      );
  };

  const openSession = (sessionId: string) => {
    setSessionNote(undefined);
    if (!onOpenSessionThread || !onOpenSessionThread(sessionId)) {
      setSessionNote(t("This session is not open in this app."));
    }
  };

  return (
    <aside className="canvas-detail" data-testid="canvas-node-detail">
      <div className="canvas-detail__header">
        <h2 className="canvas-panel__title">{t("Node details")}</h2>
        {onClose ? (
          <button
            className="button canvas-detail__close"
            data-testid="canvas-detail-close"
            type="button"
            onClick={onClose}
          >
            隐藏
          </button>
        ) : null}
      </div>
      {detailReadAt ? <p className="canvas-detail__note">详情最近读取：{detailReadAt}</p> : null}
      {ambiguousInstance ? (
        <p className="canvas-detail__error" role="alert" data-testid="canvas-instance-ambiguous">
          {AMBIGUOUS_INSTANCE_MESSAGE}
        </p>
      ) : !node ? (
        <p className="canvas-empty" data-testid="canvas-node-detail-empty">
          {t("Select a node on the canvas to see its details.")}
        </p>
      ) : (
        <>
          <dl className="canvas-detail__fields" data-testid="canvas-node-detail-fields">
            <DetailField label={t("Name")} value={node.name} />
            <DetailField label={t("Dept")} value={node.dept || t("Unknown dept")} />
            <DetailField
              label={t("Status")}
              value={node.status ? cardStatusLabel(node.status) : t("Not on a card yet")}
              tone={node.status}
              suspended={node.suspended}
            />
            <DetailField label={t("Card")} value={selectedCard ?? node.cardRef ?? t("None")} />
            <DetailField label={t("Suspended")} value={node.suspended ?? t("None")} />
            <DetailField label={t("Confirmed")} value={node.confirmation ?? t("None")} />
            <DetailField label={t("Session id")} value={node.sessionId ?? t("None")} />
            {!(instance && selectedNode && api) ? (
              <>
                <DetailField label={t("Model")} value={node.model ?? t("None")} />
                <DetailField label={t("Thinking level")} value={node.thinkingLevel ?? t("None")} />
              </>
            ) : null}
            <DetailField
              label={t("Human confirmation")}
              value={node.requiresConfirmation ? t("Yes") : t("No")}
            />
          </dl>
          {node.cards && node.cards.length > 1 ? (
            <section data-testid="canvas-node-cards">
              <h3 className="canvas-detail__section">本轮 {node.cards.length} 张卡</h3>
              {node.cards.map((card) => (
                <button
                  type="button"
                  className="canvas-node-result"
                  key={card.cardRef}
                  aria-pressed={(selectedCard ?? node.cardRef) === card.cardRef}
                  onClick={() => setCardSelection({ key: cardKey, ref: card.cardRef })}
                >
                  {card.cardRef} · {cardStatusLabel(card.status)}
                  {card.error ? <small>{card.error}</small> : null}
                </button>
              ))}
            </section>
          ) : null}
          {instance && selectedNode && api ? (
            <div className="canvas-detail__d8d" data-testid="canvas-node-detail-d8d">
              {detailMessage ? (
                <p className="canvas-detail__error" role="alert">
                  {detailMessage}。已有详情可能过期，请刷新重试。
                </p>
              ) : null}
              {detail ? (
                <CanvasNodeDetailBody
                  detail={detail}
                  cardMessage={cardMessage}
                  sessionNote={sessionNote}
                  onOpenCard={openCard}
                  onOpenSession={openSession}
                />
              ) : !detailMessage ? (
                <p className="canvas-detail__note" role="status">
                  {t("Loading…")}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}

/**
 * D8d 详情渲染体（导出供组件直测；fetch 外壳在 CanvasDetailPanel 的 effect 里）：
 * 模板值 vs 卡面实际值（档位/预算差异高亮）＋回执轮次＋执行锚点＋升档理由（无记录如实显示）。
 */
export function CanvasNodeDetailBody({
  detail,
  cardMessage,
  sessionNote,
  onOpenCard,
  onOpenSession,
}: {
  readonly detail: CanvasNodeDetailData;
  readonly cardMessage?: string;
  readonly sessionNote?: string;
  readonly onOpenCard: () => void;
  readonly onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {detail.error ? (
        <p className="canvas-detail__error" role="alert">
          {detail.error}
        </p>
      ) : null}
      <h3 className="canvas-detail__section">{t("Template vs card")}</h3>
      <dl className="canvas-detail__fields">
        <CompareField
          label={t("Tier")}
          template={detail.template?.tier}
          card={detail.card?.tier}
          missing={t("None")}
        />
        <CompareField
          label={t("Budget")}
          template={formatBudget(detail.template?.budget)}
          card={formatBudget(detail.card?.budget)}
          missing={t("None")}
        />
        <DetailField
          label={t("Model")}
          value={detail.template?.model ?? t("None")}
          note={t("Actual execution follows the session records.")}
        />
        <DetailField
          label={t("Thinking level")}
          value={detail.template?.thinkingLevel ?? t("None")}
          note={t("Actual execution follows the session records.")}
        />
        <DetailField
          label={t("Skills")}
          value={detail.template?.skills?.length ? detail.template.skills.join("、") : t("None")}
        />
        {detail.card ? (
          <>
            <DetailField label={t("Attempts")} value={String(detail.card.attempts)} />
            <DetailField label={t("Created")} value={detail.card.created} />
            <DetailField label={t("Completed")} value={detail.card.completed ?? t("None")} />
          </>
        ) : (
          <DetailField label={t("Card")} value={t("Not on a card yet")} />
        )}
      </dl>
      <NodeRuntimeDetails detail={detail} />
      <h3 className="canvas-detail__section">{t("Tier change note")}</h3>
      <p className="canvas-detail__note" data-testid="canvas-detail-tier-note">
        {detail.tierNote ?? t("No record")}
      </p>
      {detail.card && detail.card.receipts.length > 0 ? (
        <>
          <h3 className="canvas-detail__section">{t("Receipt rounds")}</h3>
          <ul className="canvas-detail__rounds" data-testid="canvas-detail-rounds">
            {detail.card.receipts.map((round) => (
              <ReceiptRoundRow key={round.attempt} round={round} />
            ))}
          </ul>
        </>
      ) : null}
      <h3 className="canvas-detail__section">{t("Executions")}</h3>
      {detail.executions.length === 0 ? (
        <p className="canvas-detail__note">{t("None")}</p>
      ) : (
        <ul className="canvas-detail__executions" data-testid="canvas-detail-executions">
          {detail.executions.map((ref) => (
            <li key={ref.execId}>
              <span>
                {ref.execId}
                {ref.status ? ` · ${ref.status}` : ""} · {ref.source}
                {ref.time ? ` · ${ref.time}` : ""}
              </span>
              <button
                className="button"
                data-testid="canvas-detail-open-session"
                type="button"
                onClick={() => onOpenSession(ref.execId)}
              >
                {t("Open session")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {sessionNote ? (
        <p className="canvas-detail__error" role="alert">
          {sessionNote}
        </p>
      ) : null}
      <div className="canvas-detail__actions">
        <button
          className="button"
          data-testid="canvas-detail-view-card"
          disabled={!detail.card}
          type="button"
          onClick={onOpenCard}
        >
          {t("View card")}
        </button>
        <span className="canvas-detail__actions-note">{cardMessage ?? ""}</span>
      </div>
    </>
  );
}

/** 模板值 vs 卡面实际值行：两侧都有且不等＝差异高亮（档位/预算覆盖才可比）。 */
function CompareField({
  label,
  template,
  card,
  missing,
}: {
  readonly label: string;
  readonly template?: string;
  readonly card?: string;
  readonly missing: string;
}) {
  const differs = template !== undefined && card !== undefined && template !== card;
  return (
    <div className="canvas-detail__field">
      <dt>{label}</dt>
      <dd
        className={`canvas-detail__value${differs ? " canvas-detail__value--diff" : ""}`}
        data-testid="canvas-detail-compare"
      >
        {differs ? `${template} → ${card}` : (template ?? card ?? missing)}
      </dd>
    </div>
  );
}

/** 回执轮次行：两轮打回差异的原始记录（结果/失败类型/摘要/证据原样带出）。 */
function ReceiptRoundRow({ round }: { readonly round: CanvasNodeReceiptRound }) {
  const { t } = useI18n();
  return (
    <li className="canvas-detail__round">
      <div className="canvas-detail__round-head">
        {t("Attempt")} {round.attempt} · {round.time}
        {round.result ? ` · ${round.result}` : ""}
        {round.failureType ? ` · ${t("Failure type")} ${round.failureType}` : ""}
        {round.archived ? ` · ${round.archived}` : ""}
      </div>
      {round.summary ? <p className="canvas-detail__note">{round.summary}</p> : null}
      {round.evidence && round.evidence.length > 0 ? (
        <ul className="canvas-detail__evidence">
          {round.evidence.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function DetailField({
  label,
  value,
  tone,
  suspended,
  note,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: string;
  readonly suspended?: string;
  readonly note?: string;
}) {
  const toneClass =
    tone !== undefined
      ? ` canvas-detail__value--${canvasNodeTone({ status: tone, suspended })}`
      : "";
  return (
    <div className="canvas-detail__field">
      <dt>{label}</dt>
      <dd className={`canvas-detail__value${toneClass}`}>
        {value}
        {note ? <span className="canvas-detail__value-note">{note}</span> : null}
      </dd>
    </div>
  );
}
