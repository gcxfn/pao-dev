import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DesktopViewContext } from "@pi-gui/extension-ui/browser";
import {
  Pao,
  PaoPulse,
  type Identity,
  type PaoDeptCatalog,
  type PaoDeptDetail,
  type PaoDeptSourceRef,
  type PaoView,
} from "./contract.ts";

const css = `*{box-sizing:border-box}body{margin:0}main{font:14px/1.55 system-ui;color:var(--foreground);background:var(--background);padding:18px;min-height:100vh}h1{font-size:20px}h2{font-size:16px}h3{font-size:14px;margin:12px 0 4px}button,input,select,textarea{font:inherit;color:inherit;background:var(--background);border:1px solid color-mix(in srgb,var(--foreground) 25%,transparent);border-radius:6px;padding:6px 10px}button{cursor:pointer;margin:4px}button:disabled{opacity:.45}nav{display:flex;flex-wrap:wrap;border-bottom:1px solid #8885;padding-bottom:8px}.muted{opacity:.65;font-size:12px;overflow-wrap:anywhere}.kv{white-space:pre-wrap}.error{color:#dc6262;white-space:pre-wrap}article{border:1px solid #8885;border-radius:8px;padding:12px;margin:10px 0}details{border:1px solid #8885;border-radius:8px;padding:8px;margin:8px 0}summary{cursor:pointer}pre,.log-line{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 monospace}pre{max-height:420px;overflow:auto}textarea{width:100%;min-height:70px}input{max-width:100%}.badge{padding:2px 8px;border-radius:5px;background:#8882}.badge.ok{background:color-mix(in srgb,#2e7d43 45%,var(--background))}.badge.dropped{background:color-mix(in srgb,#b0563b 45%,var(--background))}.toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.dept-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}.dept-card{display:flex;flex-direction:column;margin:0}.dept-card h2{margin:0 0 6px}.chips{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 8px}.log-box{max-height:420px;overflow:auto;border:1px solid #8885;border-radius:8px;padding:8px;margin:8px 0}.log-line{border-left:2px solid #8883;padding-left:8px;margin:2px 0}`;
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  cls?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

/** 已完成实例列出上限（D8c 拍板 3：超出显示计数提示，不做分页）。 */
const COMPLETED_RESULTS_LIMIT = 20;
/** 恢复摘要口径提示：已完成/中断行的判读口径，随结构化摘要展示。 */
const RECOVERY_HINTS =
  "已改未验：请结合节点实际 diff 和卡机械验收记录判断；不从回执推断\n拟续跑：需上方明确理由和内核确认，未自动批准";
/** pao/status/results.ts 聚合载荷的展示侧结构（只读；字段缺失如实标未知，不编造）。 */
interface ResultsDiffView {
  可用: boolean;
  原因?: string;
  摘要?: string;
  文件?: { 状态: string; 文件: string }[];
  新增未跟踪?: string[];
}
interface ResultsNodeView {
  节点: string;
  轮次: number;
  卡: string[];
  要求: { 卡面轴: string; 部门标准轴: string };
  实际diff: ResultsDiffView;
  验收: {
    记录: { 卡: string; 时间: string; 结论: string }[];
    判定?: { 结果: string; 理由: string; 时间: string };
    缺失说明?: string;
  };
  遗留: string[];
}
interface ResultsRowView {
  项目: string;
  项目根: string;
  工作流: string;
  实例: string;
  路径: string;
  状态: string;
  说明?: string;
  节点结果: ResultsNodeView[];
  孤儿卡: { 卡号: number; 节点: string; 卡状态: string }[];
  恢复: {
    已完成: boolean;
    已中断: boolean;
    已改未验: boolean;
    拟续跑: boolean;
    行: { 态: string; 文案: string; 证据: string[] }[];
  };
}
interface ResultsSnapshotView {
  line: ResultsRowView[];
  exception: { 路径: string; 文件: string; 原因: string }[];
}
/**
 * 恢复摘要「已完成」名单。进度.节点.状态是 controlView 投影，S10 起单域英文：
 * 完成态＝delivered（内核 complete 才给，control.ts controlView 节点映射）；坏卡透传
 * failed/canceled 是中断原因（经挂起字段进「中断或挂起」），不计入完成。
 */
export function completedNodeNames(nodes: readonly { 名字: string; 状态: string }[]): string[] {
  return nodes.filter((node) => node.状态 === "delivered").map((node) => node.名字);
}
/** 节点进度状态显示名：controlView 单域英文投影回中文；未知值原样透传。 */
const PROGRESS_STATUS_LABELS: Readonly<Record<string, string>> = {
  delivered: "已交付",
  in_progress: "进行中",
  no_card: "未落卡",
};
export function progressStatusLabel(status: string): string {
  return PROGRESS_STATUS_LABELS[status] ?? status;
}
/** 折叠 JSON 兜底：结构化摘要在上，原始载荷默认收起，审计需要时可展开。 */
export function jsonFallback(label: string, value: unknown): HTMLDetailsElement {
  const details = element("details");
  details.append(element("summary", label), element("pre", JSON.stringify(value, null, 2)));
  return details;
}
/** worker 会话单行渲染：行是内核 DesktopSessionIncrement.行 投影对象（类型/角色/模型/思考强度/内容），
 *  内容块 text 取原文、toolCall 取名字＋参数，其余块（脱敏 thinking 等）跳过。 */
export function workerLineText(item: unknown): string {
  const row = item as {
    类型: string;
    角色?: string;
    模型?: string;
    思考强度?: string;
    内容?: unknown;
  };
  const head = [
    row.类型,
    ...(row.角色 ? [row.角色] : []),
    ...(row.模型 ? [row.模型] : []),
    ...(row.思考强度 ? [`思考 ${row.思考强度}`] : []),
  ].join(" · ");
  const parts: string[] = [];
  if (typeof row.内容 === "string") {
    if (row.内容.trim()) parts.push(row.内容);
  } else if (Array.isArray(row.内容))
    for (const block of row.内容 as Record<string, unknown>[]) {
      if (typeof block.text === "string" && block.text.trim()) parts.push(block.text);
      else if (block.type === "toolCall")
        parts.push(
          `工具调用 ${String(block.name ?? "未知")} ${
            block.arguments === undefined ? "" : JSON.stringify(block.arguments)
          }`.trimEnd(),
        );
    }
  const body = parts.join("\n");
  return body ? `${head}：${body}` : head;
}
/** 节点部门归属：冻结配方节点定义带 部门（readControl 已校验冻结图与控制节点一一对应）。 */
export function deptOfNode(
  flow: { 冻结配方: { 节点: readonly { 名字: string; 部门?: string }[] } },
  name: string,
): string | undefined {
  return flow.冻结配方.节点.find((def) => def.名字 === name)?.部门;
}
/** 部门详情态取该部门节点；dept 未设（待处理等 tab）取全部。 */
export function nodesOfDept<T extends { 名字: string }>(
  flow: { 冻结配方: { 节点: readonly { 名字: string; 部门?: string }[] }; 节点: readonly T[] },
  dept: string | undefined,
): T[] {
  return dept === undefined
    ? [...flow.节点]
    : flow.节点.filter((node) => deptOfNode(flow, node.名字) === dept);
}
/** 死断定（摩擦④）：节点绑定部长会话不在热清单＝无热进程。热清单只覆盖当前查看会话注册的
 *  部长，因此只对本 owner 的流判死；异 owner 的流不判死（对方部长可能正热）。 */
export function ministerDropped(
  flow: { owner: string },
  node: { 部长会话?: string },
  session: string,
  hotSessions: ReadonlySet<string>,
): boolean {
  return flow.owner === session && node.部长会话 !== undefined && !hotSessions.has(node.部长会话);
}
/** 终态卡口径：delivered/canceled 不计活卡（部门总览活卡与待处理卡过滤共用，防两处漂移）。 */
const DEAD_STATUSES: readonly string[] = ["delivered", "canceled"];
/** 部门总览统计：部门集合＝冻结配方节点部门 ∪ 热部长部门 ∪ 卡部门，三处并集去重；
 *  活卡剔 DEAD_STATUSES（与卡列表行上的状态 badge 对照）。 */
export function deptStats(
  view: PaoView,
): Map<string, { 热部长: number; 卡片: number; 活卡: number; 挂起节点: number }> {
  const stats = new Map<string, { 热部长: number; 卡片: number; 活卡: number; 挂起节点: number }>();
  const touch = (dept: string) => {
    const row = stats.get(dept);
    if (row) return row;
    const fresh = { 热部长: 0, 卡片: 0, 活卡: 0, 挂起节点: 0 };
    stats.set(dept, fresh);
    return fresh;
  };
  for (const minister of view.部长) touch(minister.部门).热部长++;
  for (const card of view.项目.cards) {
    const row = touch(card.frontmatter.dept);
    row.卡片++;
    if (!DEAD_STATUSES.includes(card.frontmatter.status)) row.活卡++;
  }
  for (const entry of view.项目.workflow)
    for (const node of entry.控制.节点) {
      const dept = deptOfNode(entry.控制, node.名字);
      if (dept && entry.进度.节点.some((row) => row.名字 === node.名字 && row.挂起))
        touch(dept).挂起节点++;
    }
  return stats;
}
export async function mount(root: HTMLElement, host: DesktopViewContext) {
  let view: PaoView | undefined;
  let error = "";
  let busy = false;
  let disposed = false;
  let tab = "任务";
  let selected: string | undefined;
  // 部门钻取状态：未设＝总览态（部门卡 grid）；已设＝该部门详情（热部长＋节点＋卡）。
  let selectedDept: string | undefined;
  /**
   * E2b 部门配置面（目录/详情）：
   * - 与 `view`（卡会话运行态）分两条通道：配置读失败不该拖垮整页，反过来也一样；
   * - 只在需要时拉：总览/选择器用 catalog（轻），进某个部门才拉 detail（含七段原文与负载）；
   * - 失败不吞成空列表——`deptError` 存内核抛的原文，界面如实显示「读不了」而不是「没有」。
   */
  let deptCatalog: PaoDeptCatalog | undefined;
  let deptDetail: PaoDeptDetail | undefined;
  /** 详情对应的部门名：切换部门时旧详情必须先作废，避免显示上一个部门的配置。 */
  let deptDetailName: string | undefined;
  let deptError = "";
  let deptLoading = false;
  let executionId: string | undefined;
  let offset = 0;
  let lines: unknown[] = [];
  let streamStatus = "";
  let sessionPath = "";
  let diff: unknown;
  let results: ResultsSnapshotView | undefined;
  let selectedInstance: string | undefined;
  let mustRefresh = false;
  let totals = { 响应: 0, 工具: 0, token: 0, 未知用量: 0 };
  const binding = host.services.open({
    // observe 的服务必须全列在此：连接清单就是渲染层 allowlist（chord consumer 按
    // 传入 services 冻结），漏列的 observe 直接抛 not allowlisted、整个视图挂掉（S12 故障④）。
    services: [Pao, PaoPulse],
    assertAccess: () => host.signal.throwIfAborted(),
    onError: (reason) => {
      error = String(reason);
      render();
    },
  });
  const service = binding.use(Pao);
  // 会话脉冲（turn/agent 事件）驱动自动刷新：同窗口多事件合并一次；面板关闭后不再触发。
  let autoRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleAutoRefresh = () => {
    if (disposed || autoRefreshTimer !== undefined) return;
    autoRefreshTimer = setTimeout(() => {
      autoRefreshTimer = undefined;
      if (disposed) return;
      if (busy) {
        // 忙碌时顺延到下一窗口，避免丢失最后一次刷新。
        scheduleAutoRefresh();
        return;
      }
      void perform(refresh);
    }, 500);
  };
  binding.observe(PaoPulse, scheduleAutoRefresh);
  const identity = (): Identity => {
    if (!view) throw new Error("请先刷新");
    return { sessionId: view.项目.session, project: view.项目.projectRoot };
  };
  const perform = async (action: () => Promise<void>) => {
    if (busy || disposed) return;
    busy = true;
    error = "";
    render();
    try {
      await action();
    } catch (reason) {
      error = String(reason);
    } finally {
      busy = false;
      if (!disposed) render();
    }
  };
  const refresh = async () => {
    const next = await service.refresh(BACKGROUND_CONTEXT);
    host.signal.throwIfAborted();
    if (
      view &&
      (view.项目.session !== next.项目.session || view.项目.projectRoot !== next.项目.projectRoot)
    ) {
      selected = undefined;
      selectedDept = undefined;
      executionId = undefined;
      lines = [];
      offset = 0;
      totals = { 响应: 0, 工具: 0, token: 0, 未知用量: 0 };
      sessionPath = "";
      results = undefined;
      selectedInstance = undefined;
      // 部门配置面随会话/项目换代：旧的快照与错误都不属于新上下文，必须清掉。
      deptCatalog = undefined;
      deptDetail = undefined;
      deptDetailName = undefined;
      deptError = "";
    }
    view = next;
    mustRefresh = false;
  };
  /**
   * 拉部门目录（总览与选择器用）。失败把内核原文存 `deptError`，不清空既有快照——
   * 一次读失败不该让已经读到的部门突然消失，界面靠 `deptError` 提示这是旧值。
   */
  const loadDeptCatalog = async () => {
    deptLoading = true;
    deptError = "";
    try {
      deptCatalog = await service.deptCatalog(identity(), BACKGROUND_CONTEXT);
    } catch (reason) {
      deptError = String(reason);
    } finally {
      deptLoading = false;
    }
  };
  /**
   * 拉单部门详情。先按名字清掉旧详情（切部门时绝不能显示上一个部门的配置），
   * 失败同样只记 `deptError`，不伪造空对象——空对象会让七段全部显示成「未配置」。
   */
  const loadDeptDetail = async (name: string) => {
    deptLoading = true;
    deptError = "";
    if (deptDetailName !== name) {
      deptDetail = undefined;
      deptDetailName = name;
    }
    try {
      deptDetail = await service.deptDetail({ ...identity(), deptName: name }, BACKGROUND_CONTEXT);
    } catch (reason) {
      deptError = String(reason);
    } finally {
      deptLoading = false;
    }
  };
  const button = (label: string, action: () => Promise<void>) => {
    const node = element("button", label);
    node.disabled = busy;
    node.onclick = () => {
      perform(action).catch((reason) => {
        error = String(reason);
        render();
      });
    };
    return node;
  };
  const openFile = (path: string) => host.actions.openFile({ path });
  const mutate = async (action: () => Promise<void>) => {
    if (mustRefresh) throw new Error("上一次动作结果待核对；请先刷新正本，不重复发送。");
    mustRefresh = true;
    await action();
    await refresh();
  };
  /** D8c 结果页聚合：打开拉一次＋手动刷新，不轮询不缓存（纯读服务，零动作）。 */
  const loadResults = async () => {
    const next = await service.results(identity(), BACKGROUND_CONTEXT);
    host.signal.throwIfAborted();
    results = next as ResultsSnapshotView;
    if (!results.line.some((row) => row.路径 === selectedInstance)) selectedInstance = undefined;
  };
  async function readMore(id: string, minister = false) {
    if (executionId !== id) {
      executionId = id;
      offset = 0;
      lines = [];
      totals = { 响应: 0, 工具: 0, token: 0, 未知用量: 0 };
    }
    const result = await (minister
      ? service.minister({ ...identity(), id, offset }, BACKGROUND_CONTEXT)
      : service.execution({ ...identity(), id, offset }, BACKGROUND_CONTEXT));
    host.signal.throwIfAborted();
    offset = result.下次偏移;
    lines.push(...result.行);
    for (const key of ["响应", "工具", "token", "未知用量"] as const)
      totals[key] += result.本段统计[key];
    const dropped = Math.max(0, lines.length - 500);
    if (dropped) lines = lines.slice(-500);
    sessionPath = result.会话路径;
    streamStatus = `${result.末行未完 ? "末行尚未写完，等待刷新。" : "已读到完整行。"}${result.还有更多 ? "还有内容，请继续读取。" : ""}${dropped ? "视图仅保留最近500行，完整记录在原文件。" : ""} 字节位置 ${offset}`;
    streamStatus += ` 已读取 ${totals.响应} 轮模型响应 / ${totals.工具} 次工具调用 / ${totals.token} 已知 token；${totals.未知用量} 条用量未知。模型/思考强度以记录中的变更和响应为准，配置不代表实际执行。`;
  }
  function render() {
    if (disposed) return;
    root.replaceChildren();
    const style = element("style", css);
    root.append(style);
    const main = element("main");
    root.append(main);
    const toolbar = element("div", undefined, "toolbar");
    toolbar.append(
      element("h1", "部门详情"),
      button("刷新正本", refresh),
      // 画布↔主控跳转（P4-4）：从部门详情切到工作流画布整页视图
      button("打开画布", () => host.actions.openView("canvas")),
    );
    main.append(toolbar);
    main.append(
      element(
        "p",
        "只读视图不调用模型。项目和会话跟随左侧当前对话；需要操作的任务请回到原 owner 会话。",
        "muted",
      ),
    );
    if (error) main.append(element("p", error, "error"));
    if (!view) {
      main.append(element("p", "正在读取会话…"));
      return;
    }
    const data = view.项目;
    // 任务 tab 两态判式一次计算：总览态（部门卡 grid）与部门详情态互斥；其余 tab 两者皆否。
    const overview = tab === "任务" && selectedDept === undefined;
    const inDept = tab === "任务" && selectedDept !== undefined;
    const emptyHint = data.issues.length
      ? "有读取问题，不能据此判断队列为空。"
      : "当前范围没有卡片。";
    main.append(
      element(
        "p",
        `项目：${data.projectRoot}\n会话：${data.session}\n更新时间：${data.读取时间}`,
        "muted",
      ),
    );
    const nav = element("nav");
    for (const name of ["任务", "待处理", "结果与恢复"])
      nav.append(
        button(name, async () => {
          tab = name;
          // tab 切换即退出部门详情，防止切回任务 tab 时旧部门详情意外复活。
          selectedDept = undefined;
          // 结果页聚合按需拉取：首次进 tab 读一次，之后用 tab 内「刷新结果聚合」手动重拉
          if (name === "结果与恢复" && results === undefined) await loadResults();
        }),
      );
    main.append(nav);
    for (const issue of data.issues)
      main.append(element("p", `${issue.路径}\n${issue.说明}`, "error"));
    // 热部长会话标识集合：节点绑定的部长会话不在其中＝无热进程（摩擦④）。
    const hotSessions = new Set(view.部长.map((minister) => minister.会话标识));
    const ministerRow = (minister: PaoView["部长"][number]) => {
      main.append(
        element(
          "p",
          `${minister.部门} · PID ${minister.pid} · ${minister.会话标识} · ${minister.脉络 ?? "普通对话"}`,
        ),
        button("钻取部长会话", () => readMore(minister.会话标识, true)),
      );
    };
    if (tab === "任务") main.append(element("pre", data.queue));
    if (overview) {
      // 总览态：跨部门热会话速览（本 owner 部长会话）保留在部门总览顶部。
      main.append(element("h2", "本 owner 部长会话"));
      for (const minister of view.部长) ministerRow(minister);
      if (view.部长错误) main.append(element("p", view.部长错误, "error"));
      if (!view.部长.length && !view.部长错误)
        main.append(element("p", "此 owner 没有热部长；历史工作流部长见节点详情。", "muted"));
    }
    if (inDept) {
      // 部门详情态：返回入口＋标题＋七段（职责/工具/技能/档位/标准/知识入口/配置问题）＋负载＋热部长。
      // 七段全部来自内核 dept 投影（唯一来源 readDeptCatalog + validateDeptCatalog），
      // 桌面不解析配方、不补默认值；缺失就显示"未配置"，坏值原样保留并给修法。
      main.append(
        button("← 返回部门列表", async () => {
          selectedDept = undefined;
          deptDetail = undefined;
          deptDetailName = undefined;
        }),
        element("h2", `部门 · ${selectedDept ?? ""}`),
      );
      // 详情还没到手：先给一句准确的中间态，不留空白让人以为页面坏了。
      if (deptLoading && !deptDetail) main.append(element("p", "正在读取部门配置…", "muted"));
      if (deptError) main.append(element("p", `部门配置读取失败：${deptError}`, "error"));
      if (!deptDetail && !deptLoading)
        main.append(
          button("重读本部门配置", async () => {
            if (selectedDept) await loadDeptDetail(selectedDept);
          }),
        );
      if (deptDetail) {
        const detail = deptDetail;
        const section = (title: string) => {
          const node = element("section");
          node.append(element("h2", title));
          return node;
        };
        // ── 一段：职责 / 人设原文（配方的「人设」行；出处是真实文件，不复制正文） ──
        const duty = section("职责与人设");
        if (detail.职责.原文) {
          duty.append(element("p", detail.职责.原文, "kv"));
          if (detail.职责.待填)
            duty.append(
              element(
                "p",
                "这条人设还是建部模板的占位文字（<待填…>），派发时不会提供有效的职责边界。",
                "error",
              ),
            );
          if (detail.职责.出处)
            duty.append(
              button("打开配方原文", async () => {
                openFile(detail.职责.出处!);
              }),
              element("p", detail.职责.出处, "muted"),
            );
          else duty.append(element("p", "配方不可读，出处未知。", "error"));
        } else duty.append(element("p", "未配置：配方里没有「人设」行。", "error"));
        main.append(duty);

        // ── 二段：工具白名单（内置判定来自内核；表外名原样保留） ──
        const tools = section("工具白名单");
        if (detail.工具.白名单.length) {
          const chips = element("div", undefined, "chips");
          for (const tool of detail.工具.白名单)
            chips.append(
              element("span", tool.内置 ? tool.名字 : `${tool.名字}（表外）`, tool.内置 ? "badge ok" : "badge dropped"),
            );
          tools.append(chips);
        } else tools.append(element("p", "未配置：配方里没有可识别的工具。", "error"));
        if (detail.工具.原值 && !detail.工具.白名单.length)
          tools.append(element("p", `配方原值：${detail.工具.原值}`, "muted"));
        if (detail.工具.混写技能名.length)
          tools.append(
            element(
              "p",
              `「工具」行里混写了疑似技能名：${detail.工具.混写技能名.join("、")}（技能应写在「技能」行，混写不会被装载）`,
              "error",
            ),
          );
        main.append(tools);

        // ── 三段：技能（每个技能的真实目录 + SKILL.md 是否存在；当前无"未信任"概念） ──
        const skills = section("技能清单");
        if (!detail.技能.length) skills.append(element("p", "未配置：配方里没有引用技能。", "muted"));
        for (const skill of detail.技能) {
          const line = element("p");
          const state = skill.占位符
            ? "占位文字"
            : skill.可用
              ? "可用"
              : skill.目录存在
                ? "SKILL.md 缺失或为空"
                : "目录不存在";
          line.append(
            element("span", `${skill.引用} · ${state}`, skill.可用 ? "badge ok" : "badge dropped"),
            element("br"),
            element("span", skill.skillFile, "muted"),
          );
          skills.append(line);
          skills.append(
            button(`打开 ${skill.引用}`, async () => {
              openFile(skill.skillFile);
            }),
          );
        }
        main.append(skills);

        // ── 四段：默认档位（档位.json 解析出的 provider/model/思考强度；查无此档不入猜） ──
        const tier = section("默认档位");
        tier.append(element("p", `生效档位：${detail.默认档位.生效}（来源：${detail.默认档位.来源}）`));
        tier.append(
          element(
            "p",
            `模型：${detail.默认档位.provider && detail.默认档位.model ? `${detail.默认档位.provider}/${detail.默认档位.model}` : "未配置"}\n思考强度：${detail.默认档位.thinkingLevel ?? "未配置"}`,
            detail.默认档位.model ? "kv" : "error",
          ),
        );
        if (detail.默认档位.未配置原因)
          tier.append(element("p", detail.默认档位.未配置原因, "error"));
        main.append(tier);

        // ── 五段：标准（只给真实文件位置与可读性，不复制正文） ──
        const standards = section("标准");
        if (!detail.标准.length) standards.append(element("p", "未配置：配方里没有声明标准。", "muted"));
        for (const standard of detail.标准) {
          standards.append(
            element(
              "p",
              `${standard.原始} · ${standard.可读 ? "可读" : "不可读"}`,
              standard.可读 ? "badge ok" : "badge dropped",
            ),
            element("p", standard.文件 ?? "（未定位到文件）", "muted"),
          );
          if (standard.文件 && standard.可读)
            standards.append(
              button(`打开 ${standard.原始}`, async () => {
                openFile(standard.文件!);
              }),
            );
        }
        main.append(standards);

        // ── 六段：知识入口（门面索引 + 干法段；只定位，正文按需读原文件） ──
        const kb = section("知识入口");
        const sourceRow = (label: string, ref: PaoDeptSourceRef | null) => {
          if (!ref) {
            kb.append(element("p", `${label}：未配置`, "muted"));
            return;
          }
          kb.append(
            element(
              "p",
              `${label}：${ref.可读 ? "可读" : "不可读"}${ref.行数 !== null ? ` · ${ref.行数} 行` : ""}`,
              ref.可读 ? "badge ok" : "badge dropped",
            ),
            element("p", ref.相对路径 ?? ref.路径, "muted"),
          );
          kb.append(
            button(`打开${label}`, async () => {
              openFile(ref.路径);
            }),
          );
        };
        sourceRow("知识库索引", detail.知识入口.索引);
        sourceRow("干法", detail.知识入口.干法);
        main.append(kb);

        // ── 七段：配置问题（级别/类别/问题/修法/证据路径；阻止启动必须显眼） ──
        const issues = section(`配置问题（${detail.配置问题.length}）`);
        if (!detail.配置问题.length)
          issues.append(element("p", "没有发现问题。", "badge ok"));
        for (const issue of detail.配置问题) {
          const block = element("article");
          block.append(
            element(
              "p",
              `[${issue.级别}] ${issue.类别}：${issue.问题}`,
              issue.级别 === "阻止启动" ? "error" : "muted",
            ),
            element("p", `修法：${issue.修法}`, "kv"),
            element("p", issue.证据, "muted"),
          );
          issues.append(block);
        }
        main.append(issues);

        // ── 负载（与本进程热部长、卡快照、控制清单同源；不是配置面） ──
        const load = section("负载");
        const chips = element("div", undefined, "chips");
        chips.append(
          element("span", `热部长 ${detail.负载.热部长数}`, detail.负载.热部长数 ? "badge ok" : "badge"),
          element("span", `卡片 ${detail.负载.卡片总数} · 活卡 ${detail.负载.活卡数}`, "badge"),
          element(
            "span",
            `挂起节点 ${detail.负载.挂起节点数}`,
            detail.负载.挂起节点数 ? "badge dropped" : "badge",
          ),
          element("span", `归档卡 ${detail.负载.归档卡数}`, "badge"),
        );
        load.append(chips);
        for (const issue of detail.负载.读取问题)
          load.append(element("p", `${issue.路径}\n${issue.说明}`, "error"));
        main.append(load);

        // ── 路径与登记信息（真实路径，便于核对与复制） ──
        const where = section("位置");
        where.append(
          element(
            "p",
            [
              `部门目录：${detail.路径.部门目录}`,
              `配方：${detail.路径.配方}`,
              `知识库：${detail.路径.知识库}`,
              `库路径（相对 PAO_HOME）：${detail.库路径}`,
              ...(detail.建部日期 ? [`建部日期：${detail.建部日期}`] : []),
              ...(detail.标签.length ? [`标签：${detail.标签.join("、")}`] : []),
            ].join("\n"),
            "kv",
          ),
        );
        main.append(where);

        // 读到了详情但某一部分没读到：单独列出，不混进"配置问题"（那是配置本身的毛病）。
        if (detail.读取问题.length) {
          const reads = section("读取问题");
          for (const issue of detail.读取问题)
            reads.append(element("p", `${issue.路径}\n${issue.说明}`, "error"));
          main.append(reads);
        }
      }
      const ministers = view.部长.filter((minister) => minister.部门 === selectedDept);
      if (ministers.length) {
        main.append(element("h2", "该部门热部长（本会话）"));
        for (const minister of ministers) ministerRow(minister);
      } else main.append(element("p", "本会话在该部门没有热部长。", "muted"));
      if (view.部长错误) main.append(element("p", view.部长错误, "error"));
    }
    if (tab === "待处理")
      for (const issue of [
        ...view.待处理.issues,
        ...view.待处理.projects.flatMap((project) => project.issues),
      ])
        main.append(element("p", `${issue.路径}\n${issue.说明}`, "error"));
    // 结果与恢复 tab 走下方聚合视图（实例选择→四样＋恢复摘要，零动作），不渲染带续跑按钮的流程文章
    const projects = tab === "待处理" ? view.待处理.projects : tab === "结果与恢复" ? [] : [data];
    for (const project of projects)
      for (const entry of project.workflow) {
        const flow = entry.控制;
        const article = element("article");
        article.append(
          element("h2", `工作流 ${flow.工作流} · ${flow.状态}`),
          element(
            "p",
            `项目 ${project.projectRoot}\n实例 ${flow.实例}\nowner ${flow.owner}\n正本 ${entry.路径}`,
            "muted",
          ),
        );
        article.append(
          button("打开控制正本", () => openFile(entry.路径)),
          button("跳转 owner 会话", () => host.actions.openThread(flow.owner)),
        );
        if (flow.暂停 || flow.裁定)
          article.append(
            element("pre", JSON.stringify({ 暂停: flow.暂停, 待裁定: flow.裁定 }, null, 2)),
          );
        if (overview) {
          // 总览态：工作流 article 只保留头部信息，节点与卡并入部门详情视图。
          article.append(element("p", "选择部门查看节点与卡。", "muted"));
        } else {
          // 部门详情态只渲染所选部门节点；待处理 tab 保持全节点（同一结构化渲染）。
          const nodes = nodesOfDept(flow, inDept ? selectedDept : undefined);
          if (inDept && !nodes.length)
            article.append(element("p", `该工作流没有部门「${selectedDept}」的节点。`, "muted"));
          for (const node of nodes) {
            const progress = entry.进度.节点.find((row) => row.名字 === node.名字);
            const box = element("article");
            box.append(
              element(
                "h3",
                `${node.名字} · 第${node.轮次}轮 · ${progress ? progressStatusLabel(progress.状态) : "未知"}`,
              ),
            );
            if (progress?.挂起) box.append(element("p", `挂起：${progress.挂起}`, "error"));
            // 摩擦④：节点绑定部长会话但热部长清单查无此会话＝无热进程；热清单只覆盖当前项目、
            // 且只对本 owner 的流判死——异 owner 的流对方部长可能正热，不误标断开。
            if (
              project.projectRoot === data.projectRoot &&
              ministerDropped(flow, node, data.session, hotSessions)
            )
              box.append(element("span", "部长会话已断开(无热进程)", "badge dropped"));
            box.append(
              element(
                "p",
                `为什么停在这里：${progress?.挂起 ?? "无挂起原因"}\n需要决定：${flow.裁定?.节点 === node.名字 ? "核对两轴证据并裁定" : progress?.人工确认 && !progress.已确认 ? "核对结果后人工确认" : "查看现场后决定是否继续"}\n建议：先核对卡、实际差异和回执；不要把执行结束当成验收通过。`,
              ),
            );
            // 节点详情结构化：卡 chips＋判定＋历史轮次＋基线，替代整块 JSON dump。
            const chips = element("div", undefined, "chips");
            if (node.卡.length)
              for (const ref of node.卡) chips.append(element("span", `卡 ${ref}`, "badge"));
            else chips.append(element("span", "无卡", "badge"));
            box.append(chips);
            box.append(
              node.判定
                ? element(
                    "p",
                    `判定：${node.判定.结果}（${node.判定.时间}）\n理由：${node.判定.理由}\n引用 ${node.判定.引用.length} 条`,
                    "kv",
                  )
                : element("p", "判定：未判定", "muted"),
            );
            if (node.历史.length) {
              box.append(element("p", `历史 ${node.历史.length} 轮：`, "kv"));
              for (const round of node.历史)
                box.append(element("p", `第${round.轮次}轮 · ${round.原因}`, "kv"));
            } else box.append(element("p", "历史 0 轮（首次执行）", "muted"));
            if (node.基线)
              box.append(
                element(
                  "p",
                  `基线：${node.基线.提交.slice(0, 12)} · 未跟踪 ${node.基线.未跟踪.length} 个`,
                  "kv",
                ),
              );
            if (node.基线错误) box.append(element("p", `基线错误：${node.基线错误}`, "error"));
            if (!node.基线 && !node.基线错误) box.append(element("p", "基线：无记录", "muted"));
            box.append(
              jsonFallback("原始 JSON（卡／判定／历史轮次／基线）", {
                卡: node.卡,
                判定: node.判定,
                历史轮次: node.历史,
                基线: node.基线,
                基线错误: node.基线错误,
              }),
            );
            if (project.projectRoot === data.projectRoot) {
              if (node.部长会话)
                box.append(button("查看节点部长会话", () => readMore(node.部长会话!, true)));
              box.append(
                button("读取节点实际 diff", async () => {
                  diff = await service.diff(
                    { ...identity(), instance: flow.实例, node: node.名字 },
                    BACKGROUND_CONTEXT,
                  );
                }),
              );
              const reason = element("textarea");
              reason.placeholder = "本次决定理由；恢复前说明已完成、中断、已改未验与拟续跑事项";
              const decision = element("select");
              for (const value of ["pass", "change", "reject"] as const) {
                const option = element("option", value);
                option.value = value;
                decision.append(option);
              }
              const refs = element("textarea");
              refs.placeholder = "裁定证据 file:line，每行一个";
              const target = element("input");
              target.placeholder = "change 回边目标（需要时）";
              const axis = element("select");
              for (const value of ["card", "dept_standard", "both"] as const) {
                const option = element("option", value);
                option.value = value;
                axis.append(option);
              }
              box.append(reason);
              const act = async (action: "confirm" | "pause" | "resume" | "rule") => {
                await mutate(() =>
                  service.flow(
                    {
                      ...identity(),
                      instance: flow.实例,
                      node: node.名字,
                      round: node.轮次,
                      action,
                      reason: reason.value,
                      ...(action === "rule"
                        ? {
                            result: decision.value as "pass" | "change" | "reject",
                            references: refs.value.split("\n").filter(Boolean),
                            target: target.value,
                            failure_axis: axis.value as "card" | "dept_standard" | "both",
                          }
                        : {}),
                    },
                    BACKGROUND_CONTEXT,
                  ),
                );
              };
              if (flow.owner === data.session) {
                if (progress?.人工确认 && !progress.已确认)
                  box.append(button("核对后人工确认本轮", () => act("confirm")));
                box.append(button("暂停新派发", () => act("pause")));
                if (flow.裁定?.节点 === node.名字)
                  box.append(
                    decision,
                    refs,
                    axis,
                    target,
                    button("提交裁定给原 owner", () => act("rule")),
                  );
              }
              if (flow.状态 !== "已完成")
                box.append(button("核对现场并申请恢复", () => act("resume")));
            }
            article.append(box);
          }
          // 恢复前现场摘要结构化：完成名单＋中断挂起逐条＋记录逐条。
          const doneNames = completedNodeNames(entry.进度.节点);
          const interruptions = entry.进度.节点.filter((node) => node.挂起);
          article.append(element("h2", "恢复前现场摘要"));
          article.append(
            element(
              "p",
              doneNames.length
                ? `已完成节点（${doneNames.length}）：${doneNames.join("、")}`
                : "已完成节点：无",
              doneNames.length ? "kv" : "muted",
            ),
          );
          if (interruptions.length) {
            article.append(element("p", `中断或挂起（${interruptions.length}）：`, "kv"));
            for (const node of interruptions)
              article.append(element("p", `${node.名字}：${node.挂起}`, "kv"));
          } else article.append(element("p", "中断或挂起：无", "muted"));
          article.append(element("p", RECOVERY_HINTS, "muted"));
          if (flow.记录.length) {
            article.append(element("p", `记录 ${flow.记录.length} 条：`, "kv"));
            for (const row of flow.记录)
              article.append(
                element(
                  "p",
                  `${row.时间} · ${row.事件}${row.节点 ? ` · ${row.节点}` : ""}${
                    row.轮次 !== undefined ? ` 第${row.轮次}轮` : ""
                  } · ${row.理由}`,
                  "kv",
                ),
              );
          } else article.append(element("p", "记录 0 条", "muted"));
        }
        main.append(article);
      }
    if (overview) {
      const stats = deptStats(view);
      // 配置面的部门名单（注册表）与运行态部门集合（节点∪热部长∪卡）可能不一致：
      // 后者有而前者没有＝配方引用了未登记部门；前者有而后者没有＝已登记但当前没用起来。
      // 两处都列出来，各自标来源，不合并成一张"看起来完整"的表。
      const configNames = deptCatalog?.部门.map((row) => row.名字) ?? [];
      const deptNames = [...new Set([...stats.keys(), ...configNames])].sort((a, b) =>
        a.localeCompare(b, "zh-Hans-CN"),
      );
      const configOf = (name: string) => deptCatalog?.部门.find((row) => row.名字 === name);
      main.append(element("h2", "部门总览"));
      if (deptLoading && !deptCatalog) main.append(element("p", "正在读取部门配置…", "muted"));
      // 配置读失败如实显示：不能因为读不到注册表就把部门列表显示成"没有部门"。
      if (deptError) main.append(element("p", `部门配置读取失败：${deptError}`, "error"));
      if (!deptNames.length)
        main.append(
          element("p", deptCatalog ? emptyHint : `部门配置未读到，${emptyHint}`),
        );
      else {
        const grid = element("div", undefined, "dept-grid");
        for (const dept of deptNames) {
          const row = stats.get(dept);
          const config = configOf(dept);
          // 章节层级：整页标题 h1、列表/详情段 h2、每张部门卡 h3。
          // 曾经用 h2 且与「部门总览」「部门 · X」同级，读屏按标题跳转时同层混排。
          const card = element("article", undefined, "dept-card");
          card.append(element("h3", dept));
          const badges = element("div", undefined, "chips");
          // 热部长计数只覆盖当前查看会话注册的部长（内核 readDesktopMinisters 按 owner 取）；卡片计数
          // 全量、活卡剔 delivered/canceled，与详情卡列表行上的状态 badge 同口径对照。
          badges.append(
            element(
              "span",
              `本会话热部长 ${row?.热部长 ?? 0}`,
              row?.热部长 ? "badge ok" : "badge",
            ),
            element("span", `卡片 ${row?.卡片 ?? 0} · 活卡 ${row?.活卡 ?? 0}`, "badge"),
            element(
              "span",
              `挂起节点 ${row?.挂起节点 ?? 0}`,
              row?.挂起节点 ? "badge dropped" : "badge",
            ),
          );
          if (config) {
            // 配置摘要：档位与模型名来自档位.json 的真实解析，查不到就如实"未配置"。
            badges.append(
              element(
                "span",
                `档位 ${config.默认档位} · 模型 ${config.模型 ?? "未配置"}`,
                "badge",
              ),
              element("span", `技能 ${config.技能数} · 工具 ${config.工具数}`, "badge"),
            );
            if (config.阻止启动数 > 0)
              badges.append(
                element("span", `${config.阻止启动数} 项阻止启动`, "badge dropped"),
              );
            else if (config.问题数 > 0)
              badges.append(element("span", `${config.问题数} 项问题`, "badge"));
          } else if (deptCatalog) {
            // 有运行态但注册表里没有：这是"配方引用了未登记部门"，派发会失败，必须显眼。
            badges.append(element("span", "未在注册表登记", "badge dropped"));
          }
          card.append(badges);
          if (config?.职责摘要) card.append(element("p", config.职责摘要, "muted"));
          if (config && !config.可用)
            card.append(element("p", config.不可用原因 ?? "不可选", "muted"));
          // 切部门必须走 perform：它在 finally 里 render()，否则这一屏还停在总览。
          // 只切不读：详情态自己会在读到详情前显示「正在读取部门配置…」并自动补读，
          // 这里再 await 一次会让按钮一直停在「点不动」的观感上（读慢时尤其明显）。
          card.append(
            button("进入部门", async () => {
              selectedDept = dept;
              deptDetail = undefined;
              deptDetailName = undefined;
              // 切完必须真去读：此前的「只切不读」指望详情态自己补读，实际补读只挂在
              // 「重读本部门配置」按钮上，进详情后永远停在「未配置」占位。
              await loadDeptDetail(dept);
            }),
          );
          grid.append(card);
        }
        main.append(grid);
      }
      // 目录级问题（注册表本身、档位.json）：这些条目的「部门」是非部门名占位，不会摊进任何
      // 部门行，因此必须在这里单独列出来。不列就等于把「读不出来」说成「没有部门」——
      // 这正是 §8.3 禁止的「未知译成成功」。
      if (deptCatalog?.问题.length) {
        const catalogIssues = element("section");
        catalogIssues.append(element("h2", `部门配置问题（${deptCatalog.问题.length}）`));
        for (const issue of deptCatalog.问题)
          catalogIssues.append(
            element(
              "p",
              `[${issue.级别}] ${issue.类别}：${issue.问题}\n修法：${issue.修法}`,
              issue.级别 === "阻止启动" ? "error" : "muted",
            ),
          );
        main.append(catalogIssues);
      }
      // 三种东西的区别：正本在 dept/catalog，这里只透传渲染一次。
      if (deptCatalog?.工具技能人设区别.length) {
        const glossary = element("details");
        glossary.append(element("summary", "工具、技能、人设有什么区别"));
        for (const item of deptCatalog.工具技能人设区别)
          glossary.append(
            element("p", `${item.角色}：${item.含义}\n判据：${item.真实性判据}`, "muted"),
          );
        main.append(glossary);
      }
      // 没有已登记部门时不能只留空白：如实说名单读不出来/没登记，并给唯一正门。
      if (deptCatalog && deptCatalog.部门.length === 0)
        main.append(
          element(
            "p",
            deptCatalog.问题.length
              ? "部门名单读不出来：先按上面的修法恢复 部门/注册表.md，不要清空重建。"
              : "还没有登记过任何部门。用 pao_create_dept 建部（唯一正门）后再回来查看。",
            deptCatalog.问题.length ? "error" : "muted",
          ),
        );
      if (deptCatalog)
        main.append(
          button("重读部门配置", async () => {
            await loadDeptCatalog();
          }),
        );
    }
    if (tab === "结果与恢复") {
      main.append(
        button("读取当前项目实际 diff", async () => {
          diff = await service.diff(identity(), BACKGROUND_CONTEXT);
        }),
        button("刷新结果聚合", async () => {
          await loadResults();
        }),
      );
      if (results === undefined)
        main.append(
          element("p", busy ? "正在读取结果聚合…" : "尚未读取；点「刷新结果聚合」拉取。", "muted"),
        );
      else {
        // 已完成实例排后并限 20（拍板 3），超出计数提示；非完成实例全列
        const ordered = [...results.line].sort((a, b) =>
          a.恢复?.已完成 === b.恢复?.已完成 ? 0 : a.恢复?.已完成 ? 1 : -1,
        );
        const 完成 = ordered.filter((row) => row.恢复?.已完成);
        const shown = [...ordered.filter((row) => !row.恢复?.已完成)];
        if (完成.length > COMPLETED_RESULTS_LIMIT)
          main.append(
            element(
              "p",
              `已完成实例共 ${完成.length} 个，列出上限 ${COMPLETED_RESULTS_LIMIT}，另有 ${完成.length - COMPLETED_RESULTS_LIMIT} 个未列出（零落盘无历史索引，不排新旧行，按扫描序取前 ${COMPLETED_RESULTS_LIMIT} 个）。`,
              "muted",
            ),
          );
        shown.push(...完成.slice(0, COMPLETED_RESULTS_LIMIT));
        const select = element("select");
        if (!shown.length) select.append(element("option", "（无实例）"));
        for (const row of shown) {
          const option = element(
            "option",
            `${row.项目} · ${row.工作流} · ${row.状态} · ${row.实例 ? `实例 ${row.实例.slice(0, 8)}` : "（v1 无实例 ID）"}`,
          );
          option.value = row.路径;
          select.append(option);
        }
        if (!shown.some((row) => row.路径 === selectedInstance)) selectedInstance = shown[0]?.路径;
        select.value = selectedInstance ?? "";
        select.onchange = () => {
          selectedInstance = select.value;
          render();
        };
        main.append(element("h2", "实例选择"), select);
        const row = shown.find((entry) => entry.路径 === selectedInstance);
        if (!row) {
          main.append(
            element(
              "p",
              results.exception.length
                ? "没有可聚合的实例；异常见下。"
                : "项目清单范围内没有工作流实例（散卡不进结果面，见「待处理」tab）。",
              "muted",
            ),
          );
        } else {
          const article = element("article");
          article.append(
            element("h2", `工作流 ${row.工作流} · ${row.状态}`),
            element(
              "p",
              `项目 ${row.项目}（${row.项目根}）\n实例 ${row.实例 || "（v1 无实例 ID）"}\n正本 ${row.路径}`,
              "muted",
            ),
            button("打开控制正本", () => openFile(row.路径)),
          );
          if (row.说明) article.append(element("p", row.说明, "muted"));
          // 恢复摘要区：四态布尔＋依据行；「拟续跑」只给建议命令＋证据路径，零动作按钮
          const 恢复 = row.恢复 ?? {
            已完成: false,
            已中断: false,
            已改未验: false,
            拟续跑: false,
            行: [],
          };
          article.append(element("h2", "恢复摘要（四态判据来自正本结构化字段，可并存）"));
          const badges = element("p");
          for (const [label, on] of [
            ["已完成", 恢复.已完成],
            ["已中断", 恢复.已中断],
            ["已改未验", 恢复.已改未验],
            ["拟续跑建议", 恢复.拟续跑],
          ] as const)
            badges.append(
              element("span", `${label}：${on ? "是" : "否"}`, on ? "badge ok" : "badge"),
            );
          article.append(badges);
          if (!恢复.行.length) article.append(element("p", "四态均无依据行。", "muted"));
          for (const line of 恢复.行)
            article.append(
              element(
                "p",
                `[${line.态}] ${line.文案}\n证据：${line.证据.join("；")}`,
                line.态 === "拟续跑" ? "muted" : undefined,
              ),
            );
          article.append(
            element(
              "p",
              "「拟续跑」仅为机械建议命令＋证据路径；续跑必须回原会话对话或控制入口显式发起，本页无任何续跑按钮。",
              "muted",
            ),
          );
          // 分节点四样：要求／实际 diff（文件级）／验收／遗留
          article.append(element("h2", "分节点结果（要求／实际 diff／验收／遗留）"));
          if (!row.节点结果?.length)
            article.append(element("p", "无节点级结构化结果（见上方说明）。", "muted"));
          for (const node of row.节点结果 ?? []) {
            const box = element("article");
            box.append(element("h3", `${node.节点} · 第${node.轮次}轮`));
            box.append(
              element(
                "p",
                `要求（卡面轴）：${node.要求?.卡面轴 ?? "未知"}\n要求（部门标准轴）：${node.要求?.部门标准轴 ?? "未知"}`,
                "kv",
              ),
            );
            const d = node.实际diff;
            if (d?.可用)
              box.append(
                element(
                  "p",
                  `实际 diff（文件级，含新增未跟踪；「已改未验」按此计数）：${d.摘要 ?? ""}\n${
                    (d.文件 ?? []).map((f) => `${f.状态} ${f.文件}`).join("\n") ||
                    "（无已跟踪差异）"
                  }${d.新增未跟踪?.length ? `\n新增未跟踪：\n${d.新增未跟踪.join("\n")}` : ""}`,
                  "kv",
                ),
              );
            else box.append(element("p", `实际 diff：不可用——${d?.原因 ?? "未知原因"}`, "kv"));
            const a = node.验收;
            const 验收行 = [
              ...(a?.缺失说明 ? [a.缺失说明] : []),
              ...(a?.记录 ?? []).map((r) => `机械验收 卡${r.卡} ${r.时间}：${r.结论}`),
              ...(a?.判定 ? [`判定 ${a.判定.结果}（${a.判定.时间}）：${a.判定.理由}`] : []),
            ];
            box.append(
              element("p", `验收：${验收行.length ? `\n${验收行.join("\n")}` : "无记录"}`, "kv"),
            );
            box.append(
              element("p", `遗留：${node.遗留?.length ? `\n${node.遗留.join("\n")}` : "无"}`, "kv"),
            );
            if (row.项目根 === data.projectRoot && row.实例)
              box.append(
                button("按需读取该节点实际 diff（全文）", async () => {
                  diff = await service.diff(
                    { ...identity(), instance: row.实例, node: node.节点 },
                    BACKGROUND_CONTEXT,
                  );
                }),
              );
            article.append(box);
          }
          article.append(
            element("h2", "遗留：孤儿卡（标记节点不在配方，配方改版遗留，点名不丢弃）"),
            element(
              "p",
              row.孤儿卡?.length
                ? row.孤儿卡
                    .map((c) => `卡${String(c.卡号).padStart(4, "0")} → ${c.节点}（${c.卡状态}）`)
                    .join("\n")
                : "无",
              row.孤儿卡?.length ? "error" : "muted",
            ),
          );
          main.append(article);
        }
        for (const anomaly of results.exception)
          main.append(
            element(
              "p",
              `实例异常（不拖垮其他行，原样上报）：${anomaly.路径}\n${anomaly.原因}`,
              "error",
            ),
          );
      }
    }
    if (diff !== undefined)
      main.append(
        element("h2", "实际 Git 差异（按需读取）"),
        element("pre", JSON.stringify(diff, null, 2)),
      );
    // 卡列表：待处理＝清单项目未完成卡；结果与恢复＝当前项目全卡；任务＝部门详情态只列所选部门的卡。
    const cards =
      tab === "待处理"
        ? view.待处理.projects
            .flatMap((project) => project.cards)
            .filter((card) => !DEAD_STATUSES.includes(card.frontmatter.status))
        : tab === "结果与恢复"
          ? data.cards
          : inDept
            ? data.cards.filter((card) => card.frontmatter.dept === selectedDept)
            : [];
    if (!overview && !cards.length)
      main.append(element("p", tab === "任务" ? "该部门当前没有卡片。" : emptyHint));
    for (const card of cards) {
      const article = element("article");
      const fm = card.frontmatter;
      article.append(
        element("h2", `卡${card.card_no} · ${fm.goal}`),
        element("span", `${fm.status} · 尝试 ${fm.attempt} · ${fm.dept}`, "badge"),
      );
      article.append(
        element("p", `来源：${card.path}\nowner：${fm.owner ?? "未知，不能猜测"}`, "muted"),
      );
      if (tab === "待处理")
        article.append(
          element(
            "p",
            `为什么停在这里：${fm.status}；${card.receipts.length ? "存在回执，须核对当前尝试验收" : "尚无回执"}\n需要决定：核对证据后由原会话决定继续、打回或停止。\n建议：先打开卡面并核对尝试号，不自动恢复。`,
          ),
        );
      article.append(
        button(selected === card.path ? "收起详情" : "查看卡／执行详情", async () => {
          selected = selected === card.path ? undefined : card.path;
        }),
        button("打开卡正本", () => openFile(card.path)),
      );
      // 卡详情按需展开钻取：frontmatter 结构化摘要＋折叠原始 JSON；回执逐条行；执行映射＋worker 增量。
      if (selected === card.path) {
        article.append(
          element("h2", "原始要求与验收"),
          element(
            "p",
            `目标：${fm.goal}\n验收：${fm.acceptance}\n约束：${fm.constraints ?? "（未声明）"}\n输入：${
              fm.inputs?.length ? fm.inputs.join("；") : "（未声明）"
            }`,
            "kv",
          ),
          jsonFallback("frontmatter 原始 JSON", fm),
        );
        article.append(
          element("h2", "结果／证据／遗留"),
          element("pre", card.body || "暂无正文；未提供实际 diff 的任务不推断已完成。"),
        );
        article.append(element("h2", "回执"));
        if (!card.receipts.length) article.append(element("p", "暂无回执。", "muted"));
        for (const receipt of card.receipts) {
          article.append(
            element(
              "p",
              `回执 卡${receipt.card_no} · 尝试${receipt.attempt} · ${receipt.time}${
                receipt.result ? ` · ${receipt.result}` : ""
              }${receipt.failure_type ? ` · ${receipt.failure_type}` : ""}${
                receipt.archive_flag ? ` · ${receipt.archive_flag}` : ""
              }`,
              "kv",
            ),
          );
          if (receipt.summary) article.append(element("p", `摘要：${receipt.summary}`, "kv"));
        }
        article.append(
          element(
            "p",
            `恢复前摘要：${fm.status === "delivered" ? "卡面已交付；仍以验收证据为准" : fm.status === "in_progress" ? "需核对 owner 进程和执行映射，不能只凭卡面推断仍在运行" : fm.status === "failed" ? "上次失败／中断，可能有已改未验内容" : "尚待原 owner 明确决定下一步"}。拟续跑：未自动批准。`,
          ),
        );
        const executions = data.execution.filter((entry) => entry.卡路径 === card.path);
        if (!executions.length) article.append(element("p", "尚无可核对执行映射。"));
        for (const execution of executions) {
          article.append(
            element(
              "p",
              `执行 ${execution.执行标识} · 尝试${execution.尝试} · ${execution.状态} · ${execution.当前尝试 ? "当前" : "历史"}`,
            ),
          );
          article.append(button("读取 worker 增量", () => readMore(execution.执行标识)));
        }
      }
      main.append(article);
    }
    if (executionId) {
      main.append(
        element("h2", `worker 会话 · ${executionId}`),
        element("p", streamStatus, "muted"),
      );
      if (lines.length) {
        // 行列表替代整块 JSON dump：等宽小字逐行，容器限高滚动；截断逻辑见 readMore（最近 500 行）。
        const box = element("div", undefined, "log-box");
        for (const line of lines) box.append(element("div", workerLineText(line), "log-line"));
        main.append(box);
      } else main.append(element("p", "尚未读到内容；点上方「钻取／读取增量」继续。", "muted"));
      if (sessionPath) main.append(button("打开完整会话原文", () => openFile(sessionPath)));
    }
  }
  const dispose = () => {
    disposed = true;
    if (autoRefreshTimer !== undefined) {
      clearTimeout(autoRefreshTimer);
      autoRefreshTimer = undefined;
    }
    host.signal.removeEventListener("abort", dispose);
    binding
      .dispose(BACKGROUND_CONTEXT)
      .catch((reason) => console.error("PAO 视图连接释放失败", reason));
    root.replaceChildren();
  };
  host.signal.addEventListener("abort", dispose, { once: true });
  await binding.ready(BACKGROUND_CONTEXT);
  host.signal.throwIfAborted();
  await perform(refresh);
  // 首屏总览就要带配置摘要（档位/技能数/问题数），所以目录跟首刷一起拉；
  // 失败只落 deptError，不影响卡会话那一半照常显示。
  await perform(loadDeptCatalog);
  return dispose;
}
