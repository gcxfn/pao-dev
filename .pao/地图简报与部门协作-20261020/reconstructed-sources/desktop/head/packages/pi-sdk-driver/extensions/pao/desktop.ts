import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DesktopViewContext } from "@pi-gui/extension-ui/browser";
import { Pao, PaoPulse, type Identity, type PaoView } from "./contract.ts";

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
    }
    view = next;
    mustRefresh = false;
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
      // 部门详情态：返回入口＋部门标题＋该部门热部长（无热部长如实提示）。
      main.append(
        button("← 返回部门列表", async () => {
          selectedDept = undefined;
        }),
        element("h2", `部门 · ${selectedDept}`),
      );
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
      const deptNames = [...stats.keys()].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
      main.append(element("h2", "部门总览"));
      if (!deptNames.length) main.append(element("p", emptyHint));
      else {
        const grid = element("div", undefined, "dept-grid");
        for (const dept of deptNames) {
          const row = stats.get(dept)!;
          const card = element("article", undefined, "dept-card");
          card.append(element("h2", dept));
          const badges = element("div", undefined, "chips");
          // 热部长计数只覆盖当前查看会话注册的部长（内核 readDesktopMinisters 按 owner 取）；卡片计数
          // 全量、活卡剔 delivered/canceled，与详情卡列表行上的状态 badge 同口径对照。
          badges.append(
            element("span", `本会话热部长 ${row.热部长}`, row.热部长 ? "badge ok" : "badge"),
            element("span", `卡片 ${row.卡片} · 活卡 ${row.活卡}`, "badge"),
            element("span", `挂起节点 ${row.挂起节点}`, row.挂起节点 ? "badge dropped" : "badge"),
          );
          card.append(badges);
          card.append(
            button("进入部门", async () => {
              selectedDept = dept;
            }),
          );
          grid.append(card);
        }
        main.append(grid);
      }
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
  return dispose;
}
