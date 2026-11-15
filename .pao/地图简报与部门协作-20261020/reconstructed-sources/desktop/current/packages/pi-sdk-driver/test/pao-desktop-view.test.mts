// S10-A 单源化包：扩展面板控制视图单域英文消费回归。
// 值域事实（内核 controlView，PAO/.../workflow/control.ts 节点映射，S10 单源化 2026-10-08）
// ＝单域英文：delivered/in_progress/no_card（投影面值）＋ failed/canceled（坏卡卡面透传）。
// 夹具全部用内核实际投影值，不造理想值。纯内存，零文件、零网络。
// 部门详情视图（本轮 A3）：纯函数用真实内核投影结构夹具；DOM 面（jsonFallback/mount）用
// 极简 document 桩，只实现被测代码用到的 createElement/append/replaceChildren。
import test from "node:test";
import assert from "node:assert/strict";
import type { DesktopViewContext } from "@pi-gui/extension-ui/browser";
import type { PaoView } from "../extensions/pao/contract.ts";
import { nodeToneClass } from "../extensions/pao/flow-desktop.ts";
import {
  completedNodeNames,
  progressStatusLabel,
  jsonFallback,
  workerLineText,
  deptOfNode,
  nodesOfDept,
  ministerDropped,
  deptStats,
  mount,
} from "../extensions/pao/desktop.ts";

test("flow 节点着色对单域英文命中", () => {
  // controlView 投影面值（完成/进行中的实际值）
  assert.equal(nodeToneClass("delivered"), "done");
  assert.equal(nodeToneClass("in_progress"), "running");
  // 坏卡卡面英文透传值
  assert.equal(nodeToneClass("failed"), "failed");
  assert.equal(nodeToneClass("canceled"), "failed");
  // 非完成/非进行中一律无着色（no_card、未知、缺进度）
  assert.equal(nodeToneClass("no_card"), "");
  assert.equal(nodeToneClass("待认领"), "");
  assert.equal(nodeToneClass(undefined), "");
});

test("恢复摘要「已完成」名单对 controlView 实际投影值命中", () => {
  // 内核 controlView 节点状态实际值域：delivered（complete）/in_progress/no_card/failed/canceled
  const 节点 = [
    { 名字: "审", 状态: "delivered" },
    { 名字: "写", 状态: "in_progress" },
    { 名字: "发", 状态: "no_card" },
    { 名字: "验", 状态: "failed" },
    { 名字: "归", 状态: "canceled" },
  ];
  assert.deepEqual(completedNodeNames(节点), ["审"]);
});

test("节点进度状态显示名对单域英文投影回中文，未知透传", () => {
  assert.equal(progressStatusLabel("delivered"), "已交付");
  assert.equal(progressStatusLabel("in_progress"), "进行中");
  assert.equal(progressStatusLabel("no_card"), "未落卡");
  // 卡面透传值与未知值原样透传（h2 兜底「未知」仅限缺进度条目）
  assert.equal(progressStatusLabel("failed"), "failed");
  assert.equal(progressStatusLabel("什么值"), "什么值");
});

/** 极简 DOM 桩：只实现 desktop.ts 用到的 createElement/append/replaceChildren。 */
class StubElement {
  readonly tag: string;
  children: StubElement[] = [];
  textContent = "";
  className = "";
  [key: string]: unknown;
  constructor(tag: string) {
    this.tag = tag;
  }
  append(...nodes: StubElement[]) {
    this.children.push(...nodes);
  }
  replaceChildren() {
    this.children = [];
  }
}
/** 桩只在回调运行期间生效（含 await 之后），不泄漏给其他用例。 */
async function withDom<T>(run: () => T | Promise<T>): Promise<T> {
  const holder = globalThis as { document?: unknown };
  const previous = holder.document;
  holder.document = { createElement: (tag: string) => new StubElement(tag) };
  try {
    return await run();
  } finally {
    holder.document = previous;
  }
}

test("jsonFallback：details 里 summary 标签＋pre 原始 JSON，审计可展开", async () => {
  await withDom(() => {
    const node = jsonFallback("原始 JSON（恢复摘要）", { 已完成: ["审"], 记录: [] });
    assert.equal(node.tag, "details");
    assert.equal(node.children.length, 2);
    const [summary, pre] = node.children;
    assert.equal(summary.tag, "summary");
    assert.equal(summary.textContent, "原始 JSON（恢复摘要）");
    assert.equal(pre.tag, "pre");
    assert.equal(pre.textContent, JSON.stringify({ 已完成: ["审"], 记录: [] }, null, 2));
  });
});

test("workerLineText：内核行投影的头部字段与内容块拼接", () => {
  // message 行：类型 · 角色 · 模型 ＋ text 内容（内容块取原文，空白块跳过）
  assert.equal(
    workerLineText({
      类型: "message",
      角色: "assistant",
      模型: "capture-test/scripted",
      内容: [
        { type: "text", text: "第一段" },
        { type: "text", text: "   " },
        { type: "text", text: "第二段" },
      ],
    }),
    "message · assistant · capture-test/scripted：第一段\n第二段",
  );
  // toolCall 块取名字＋参数；脱敏 thinking（无 text 字段）跳过
  assert.equal(
    workerLineText({
      类型: "message",
      内容: [
        { type: "thinking", omitted: "隐藏推理或二进制内容不展示" },
        { type: "toolCall", name: "write", arguments: { path: "result.txt" } },
      ],
    }),
    'message：工具调用 write {"path":"result.txt"}',
  );
  // 字符串内容（结构过深时的脱敏回退也是字符串）整段作为正文
  assert.equal(
    workerLineText({ 类型: "message", 角色: "user", 内容: "照做" }),
    "message · user：照做",
  );
  // 非内容行：head 拼接后无正文，不补冒号
  assert.equal(workerLineText({ 类型: "model_change", 模型: "p/m" }), "model_change · p/m");
  assert.equal(
    workerLineText({ 类型: "thinking_level_change", 思考强度: "high" }),
    "thinking_level_change · 思考 high",
  );
});

/** 冻结配方与控制节点的最小同构夹具（真实投影的字段子集）。 */
const flow = {
  owner: "session-a",
  冻结配方: {
    节点: [
      { 名字: "审卡", 部门: "审查部" },
      { 名字: "写码", 部门: "开发部" },
    ],
  },
  节点: [{ 名字: "审卡" }, { 名字: "写码" }, { 名字: "无配方孤儿" }],
};

test("节点部门归属按冻结配方定义取，未定义如实 undefined", () => {
  assert.equal(deptOfNode(flow, "审卡"), "审查部");
  assert.equal(deptOfNode(flow, "写码"), "开发部");
  assert.equal(deptOfNode(flow, "无配方孤儿"), undefined);
  assert.equal(deptOfNode(flow, "不存在"), undefined);
});

test("部门过滤：按部门取节点，dept 未设取全部", () => {
  assert.deepEqual(
    nodesOfDept(flow, "审查部").map((node) => node.名字),
    ["审卡"],
  );
  assert.deepEqual(
    nodesOfDept(flow, undefined).map((node) => node.名字),
    ["审卡", "写码", "无配方孤儿"],
  );
});

test("死断定 badge 判定：只对本 owner 的流判死，异 owner 与热部长不判（A1）", () => {
  const hot = new Set(["m-hot"]);
  // 本 owner＋绑定部长会话不在热清单＝死断
  assert.equal(
    ministerDropped({ owner: "session-a" }, { 部长会话: "m-gone" }, "session-a", hot),
    true,
  );
  // 异 owner 的流不判死（热清单只覆盖当前查看会话注册的部长，对方部长可能正热）
  assert.equal(
    ministerDropped({ owner: "session-b" }, { 部长会话: "m-gone" }, "session-a", hot),
    false,
  );
  // 本 owner 但部长在热清单＝活进程
  assert.equal(
    ministerDropped({ owner: "session-a" }, { 部长会话: "m-hot" }, "session-a", hot),
    false,
  );
  // 未绑定部长会话的节点不判
  assert.equal(ministerDropped({ owner: "session-a" }, {}, "session-a", hot), false);
});

test("部门总览统计：配方部门 ∪ 热部长部门 ∪ 卡部门并集，活卡剔 delivered/canceled", () => {
  const base = makeView();
  const card = (status: "in_progress" | "delivered" | "canceled") => ({
    ...base.项目.cards[0],
    frontmatter: { ...base.项目.cards[0].frontmatter, dept: "开发部", status },
  });
  const view: PaoView = {
    ...base,
    部长: [{ 会话标识: "m1", 部门: "运营部", 项目根: "D:/p", pid: 1 }],
    项目: {
      ...base.项目,
      cards: [card("in_progress"), card("delivered"), card("canceled")],
      workflow: [
        {
          控制: flow,
          进度: { 节点: [{ 名字: "审卡", 挂起: "等核对" }, { 名字: "写码" }] },
        },
      ] as PaoView["项目"]["workflow"],
    },
  };
  const stats = deptStats(view);
  // 三处来源并集：配方（审查部/开发部）∪ 热部长（运营部）∪ 卡（开发部）；sort 为码点序仅断言集合
  assert.deepEqual([...stats.keys()].sort(), ["审查部", "开发部", "运营部"]);
  assert.deepEqual(stats.get("开发部"), { 热部长: 0, 卡片: 3, 活卡: 1, 挂起节点: 0 });
  assert.deepEqual(stats.get("审查部"), { 热部长: 0, 卡片: 0, 活卡: 0, 挂起节点: 1 });
  assert.deepEqual(stats.get("运营部"), { 热部长: 1, 卡片: 0, 活卡: 0, 挂起节点: 0 });
});

/** mount 用最小 PaoView 夹具：两部门各一张活卡，无工作流、无热部长。 */
function makeView(): PaoView {
  const card = (no: number, dept: string) => ({
    path: `D:/p/卡${no}-x.md`,
    filename: `卡${no}-x.md`,
    card_no: no,
    body: "",
    receipts: [],
    frontmatter: {
      goal: `目标${no}`,
      dept,
      acceptance: "验收",
      attempt: 0,
      created: "2026-10-10 10:00",
      status: "in_progress" as const,
    },
  });
  return {
    项目: {
      projectRoot: "D:/p",
      session: "session-a",
      读取时间: "2026-10-10T10:00:00.000Z",
      envelope: {} as PaoView["项目"]["envelope"],
      cards: [card(1, "审查部"), card(2, "开发部")],
      execution: [],
      liveness: [],
      issues: [],
      queue: "",
      workflow: [],
    },
    待处理: { projects: [], issues: [] },
    部长: [],
  };
}

/** 在 DOM 桩上挂载视图并驱动按钮点击；texts 取整棵树的文本快照。 */
async function mountOnStub(view: PaoView) {
  const root = new StubElement("div");
  const texts = () => {
    const out: string[] = [];
    const walk = (node: StubElement) => {
      out.push(node.textContent);
      for (const child of node.children) walk(child);
    };
    for (const child of root.children) walk(child);
    return out.join("\n");
  };
  const click = async (label: string) => {
    const buttons: StubElement[] = [];
    const walk = (node: StubElement) => {
      if (node.tag === "button" && node.textContent === label) buttons.push(node);
      for (const child of node.children) walk(child);
    };
    for (const child of root.children) walk(child);
    assert.ok(buttons.length >= 1, `按钮「${label}」应存在`);
    (buttons[0].onclick as () => void)();
    // click 内部的 perform→action→render 链最多几个微任务；轮询等渲染落定。
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  };
  const host = {
    signal: {
      throwIfAborted: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    actions: { openFile: () => {}, openView: () => {}, openThread: () => {} },
    services: {
      open: () => ({
        use: () => ({ refresh: async () => view }),
        observe: () => {},
        ready: async () => {},
        dispose: async () => {},
      }),
    },
  } as unknown as DesktopViewContext;
  const dispose = await mount(root as unknown as HTMLElement, host);
  return { texts, click, dispose };
}

test("selectedDept 跨 tab 不残留：切走再切回任务 tab 回到部门总览（A5）", async () => {
  await withDom(async () => {
    const ui = await mountOnStub(makeView());
    try {
      // 初始总览态：部门卡 grid 渲染出部门与「进入部门」入口
      assert.ok(ui.texts().includes("部门总览"));
      assert.ok(ui.texts().includes("审查部") && ui.texts().includes("开发部"));
      // 进入部门详情（排序取首个，不依赖 localeCompare 顺序）
      await ui.click("进入部门");
      assert.ok(/部门 · (审查部|开发部)/.test(ui.texts()));
      assert.ok(!ui.texts().includes("部门总览"));
      // 切到待处理再切回任务：selectedDept 已清，回到总览而非复活旧部门详情
      await ui.click("待处理");
      await ui.click("任务");
      assert.ok(ui.texts().includes("部门总览"));
      assert.ok(!/部门 · /.test(ui.texts()));
    } finally {
      (ui.dispose as () => void)();
    }
  });
});

test("部门详情态只列所选部门的卡", async () => {
  await withDom(async () => {
    const ui = await mountOnStub(makeView());
    try {
      await ui.click("进入部门");
      const entered = ui.texts().match(/部门 · (审查部|开发部)/)?.[1];
      assert.ok(entered, "应显示部门详情标题");
      const text = ui.texts();
      assert.ok(text.includes(entered === "开发部" ? "目标2" : "目标1"));
      assert.ok(!text.includes(entered === "开发部" ? "目标1" : "目标2"));
    } finally {
      (ui.dispose as () => void)();
    }
  });
});
