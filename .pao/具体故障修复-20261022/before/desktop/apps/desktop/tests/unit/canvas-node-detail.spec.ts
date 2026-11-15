/**
 * D8d 节点详情＋画布↔主控跳转（P4-4）单元测试：
 * ① openView 宿主动作校验（白名单窄面）；② 查询桥 readNodeDetail（整形＋失败面）；
 * ③ D8d 渲染体（模板值 vs 卡面差异高亮/升档理由无记录/执行锚点跳转/查看卡禁用）；
 * ④ 主控提示词模板内容锚点。组件用 renderToString 直渲染，同 canvas.spec 模式。
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeAll, describe, expect, test } from "@playwright/test";
import type { PaoDesktopCard, PaoDesktopNodeDetailReader } from "@pi-gui/pi-sdk-driver";
import {
  createCanvasQuery,
  normalizeNodeDetail,
  withNodeRuntime,
} from "../../electron/platform/pao/canvas-query";
import { MASTER_PROMPT_TEMPLATE } from "../../src/features/canvas/master-prompt";

let CanvasNodeDetailBody: (typeof import("../../src/features/canvas/canvas-page"))["CanvasNodeDetailBody"];
let CanvasPageView: (typeof import("../../src/features/canvas/canvas-page"))["CanvasPageView"];
beforeAll(() => {
  const real = require("react/jsx-runtime");
  require.cache[require.resolve("playwright/jsx-runtime")] = {
    id: "react/jsx-runtime",
    filename: require.resolve("react/jsx-runtime"),
    loaded: true,
    exports: real,
  } as never;
  ({ CanvasNodeDetailBody, CanvasPageView } = require("../../src/features/canvas/canvas-page") as {
    CanvasNodeDetailBody: typeof CanvasNodeDetailBody;
    CanvasPageView: typeof CanvasPageView;
  });
});

describe("normalizeNodeDetail（D8d 中文键整形）", () => {
  test("全量载荷：模板/卡面/回执轮次/执行锚点/升档理由", () => {
    const shaped = normalizeNodeDetail({
      节点: "实现",
      实例: "/p/.pao/工作流实例-好流.md",
      模板: {
        部门: "工程",
        模型: "主力",
        档位: "标准",
        思考强度: "high",
        预算: { turns: 20, cost: 2 },
        技能: ["搜索", "代码评审"],
      },
      卡: {
        卡号: "卡0001",
        状态: "delivered",
        档位: "高配",
        预算: { turns: 40 },
        尝试: 2,
        创建: "2026-10-05 10:00",
        完成: "2026-10-05 11:00",
        路径: "/p/卡/卡0001.md",
        回执: [
          {
            尝试号: 1,
            时间: "2026-10-05 10:30",
            结果: "打回",
            失败类型: "验收不通过",
            摘要: "缺测试",
            证据: ["src/a.ts:12"],
          },
          { 尝试号: 2, 时间: "2026-10-05 11:00", 结果: "成功", 留档标记: "旧尝试" },
          { 时间: "坏行无尝试号" }, // 坏行剔除
        ],
      },
      执行: [
        { 执行标识: "exec-1", 映射状态: "运行中", 会话路径: "/p/s1.jsonl", 时间: "t1", 来源: "执行映射" },
        { 映射状态: "无标识坏行" }, // 坏行剔除
        { 执行标识: "exec-2", 来源: "卡回执" },
      ],
      升档理由: "升档：两轮打回后提到高配",
      错误: "",
    });
    expect(shaped.node).toBe("实现");
    expect(shaped.template).toEqual({
      dept: "工程",
      model: "主力",
      tier: "标准",
      thinkingLevel: "high",
      budget: { turns: 20, cost: 2 },
      skills: ["搜索", "代码评审"],
    });
    expect(shaped.card?.tier).toBe("高配");
    expect(shaped.card?.receipts).toHaveLength(2);
    expect(shaped.card?.receipts[0]).toEqual({
      attempt: 1,
      time: "2026-10-05 10:30",
      result: "打回",
      failureType: "验收不通过",
      summary: "缺测试",
      evidence: ["src/a.ts:12"],
    });
    expect(shaped.card?.receipts[1].archived).toBe("旧尝试");
    expect(shaped.executions).toEqual([
      { execId: "exec-1", source: "执行映射", status: "运行中", sessionPath: "/p/s1.jsonl", time: "t1" },
      { execId: "exec-2", source: "卡回执" },
    ]);
    expect(shaped.tierNote).toBe("升档：两轮打回后提到高配");
    expect(shaped.error).toBeUndefined(); // 空串不透出
  });

  test("缺身份抛错；未落卡节点＝模板在卡缺省；预算非对象丢弃", () => {
    expect(() => normalizeNodeDetail({ 节点: "", 实例: "/p/i" })).toThrow();
    expect(() => normalizeNodeDetail(42)).toThrow();
    const shaped = normalizeNodeDetail({
      节点: "复核",
      实例: "/p/i",
      模板: { 部门: "评审", 预算: ["坏数组"] },
      执行: [],
    });
    expect(shaped.template).toEqual({ dept: "评审" });
    expect(shaped.card).toBeUndefined();
    expect(shaped.executions).toEqual([]);
  });

  test("回执轮次带出产物路径/用量/值得沉淀；坏用量丢弃且不补零", () => {
    const shaped = normalizeNodeDetail({
      节点: "实现",
      实例: "/p/i",
      卡: {
        卡号: "卡0001",
        状态: "delivered",
        尝试: 1,
        创建: "2026-10-05 10:00",
        路径: "/p/卡/卡0001.md",
        回执: [
          {
            尝试号: 1,
            时间: "2026-10-05 10:30",
            结果: "成功",
            产物路径: ["src/a.ts", "", "src/b.ts"],
            用量: { input: 10, cost: 0.25, missing_usage_rounds: 2 },
            值得沉淀: "先写测试",
          },
          { 尝试号: 2, 时间: "2026-10-05 11:00", 用量: { input: "坏值", turns: -1 } },
        ],
      },
      执行: [],
    });
    expect(shaped.card?.receipts[0]?.artifacts).toEqual(["src/a.ts", "src/b.ts"]);
    expect(shaped.card?.receipts[0]?.usage).toEqual({ input: 10, cost: 0.25, unknownRounds: 2 });
    expect(shaped.card?.receipts[0]?.worthRecording).toBe("先写测试");
    expect(shaped.card?.receipts[1]?.usage).toBeUndefined(); // 坏用量整块丢弃，不补零
  });
});

describe("withNodeRuntime（运行态合并，缺数据不补零）", () => {
  function baseDetail() {
    return {
      node: "实现",
      instance: "/p/.pao/工作流实例-好流.md",
      card: {
        cardRef: "卡0001",
        status: "in_progress",
        attempts: 2,
        created: "2026-10-05 10:00",
        path: "/p/卡/卡0001.md",
        receipts: [],
      },
      executions: [{ execId: "exec-9", source: "卡回执" }],
    };
  }

  const card: PaoDesktopCard = {
    path: "/p/卡/卡0001.md",
    filename: "卡0001.md",
    card_no: 1,
    frontmatter: {
      goal: "实现画布",
      dept: "工程",
      inputs: ["plans/a.md", "plans/b.md"],
      constraints: "不许改主控 API",
      acceptance: "测试全绿",
      depends_on: ["调研"],
      owner: "主控",
      tier: "高配",
      attempt: 2,
      created: "2026-10-05 10:00",
      completed: "2026-10-05 11:00",
      status: "delivered",
    },
    body: "",
    receipts: [
      {
        card_no: 1,
        attempt: 1,
        time: "2026-10-05 10:30",
        result: "打回",
        artifact_path: ["src/a.ts"],
        usage: { input: 100, output: 50, cost: 0.5, toolCalls: 3, missing_usage_rounds: 1 },
        worth_distilling: "先查依赖",
      },
      { card_no: 1, attempt: 2, time: "2026-10-05 11:00", result: "成功" },
    ],
  };

  test("卡真值/回执产物与用量/执行锚点与会话统计", () => {
    const merged = withNodeRuntime(baseDetail(), {
      card,
      executions: [
        {
          执行标识: "exec-1",
          卡路径: "/p/卡/卡0001.md",
          尝试: 2,
          状态: "成功",
          时间: "2026-10-05 11:00",
          映射路径: "/p/.pao/执行映射/exec-1.jsonl",
          会话路径: "/p/.pao/worker会话/s_exec-1.jsonl",
          当前尝试: true,
        },
      ],
      sessions: new Map([
        [
          "exec-1",
          {
            stats: {
              responses: 4,
              toolCalls: 6,
              tokens: 900,
              unknownUsage: 1,
              complete: true,
              nextOffset: 1234,
              more: false,
            },
          },
        ],
      ]),
    });
    expect(merged.card?.target).toBe("实现画布");
    expect(merged.card?.inputs).toEqual(["plans/a.md", "plans/b.md"]);
    expect(merged.card?.constraints).toBe("不许改主控 API");
    expect(merged.card?.acceptance).toBe("测试全绿");
    expect(merged.card?.dependsOn).toEqual(["调研"]);
    expect(merged.card?.owner).toBe("主控");
    expect(merged.card?.tier).toBe("高配");
    expect(merged.card?.durationSeconds).toBe(3600);
    expect(merged.card?.receipts[0]?.artifacts).toEqual(["src/a.ts"]);
    expect(merged.card?.receipts[0]?.usage).toEqual({
      input: 100,
      output: 50,
      cost: 0.5,
      toolCalls: 3,
      unknownRounds: 1,
    });
    expect(merged.card?.receipts[0]?.worthRecording).toBe("先查依赖");
    expect(merged.usage?.partial).toBe(true);
    expect(merged.usage?.input).toBe(100);
    expect(merged.usage?.attemptsWithUsage).toBe(1);
    expect(merged.usage?.attemptsWithoutUsage).toEqual([2]);
    expect(merged.usage?.attemptsWithUnknownRounds).toEqual([1]);
    expect(merged.usage?.note).toContain("未记用量");
    expect(merged.usage).not.toHaveProperty("turns"); // 未记＝不补零
    const exec = merged.executions.find((item) => item.execId === "exec-1");
    expect(exec?.attempt).toBe(2);
    expect(exec?.current).toBe(true);
    expect(exec?.sessionStats?.tokens).toBe(900);
    expect(merged.executions.find((item) => item.execId === "exec-9")?.source).toBe("卡回执");
  });

  test("运行态失败＝runtimeError 且保留基础卡面；会话读失败＝statsError", () => {
    const kept = withNodeRuntime(baseDetail(), { error: "运行态不可读" });
    expect(kept.runtimeError).toBe("运行态不可读");
    expect(kept.card?.cardRef).toBe("卡0001");

    const statError = withNodeRuntime(baseDetail(), {
      executions: [
        {
          执行标识: "exec-1",
          卡路径: "/p/卡/卡0001.md",
          尝试: 1,
          状态: "失败",
          时间: "t",
          映射路径: "/p/.pao/执行映射/exec-1.jsonl",
          当前尝试: false,
        },
      ],
      sessions: new Map([["exec-1", { error: "会话被删" }]]),
    });
    const exec = statError.executions.find((item) => item.execId === "exec-1");
    expect(exec?.statsError).toBe("会话被删");
    expect(exec?.sessionStats).toBeUndefined();
    expect(statError.runtimeError).toBeUndefined();
  });
});

describe("createCanvasQuery.readNodeDetail（失败面不抛顶层）", () => {
  async function realDir(): Promise<string> {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    return mkdtemp(join(tmpdir(), "pi-gui-canvas-detail-"));
  }

  test("缺 PAO_HOME＝failed 且不加载读取器", async () => {
    let loaded = false;
    const query = createCanvasQuery({
      paoHome: "",
      loadDetailReader: async () => {
        loaded = true;
        throw new Error("unreachable");
      },
    });
    const result = await query.readNodeDetail("/p/i", "实现");
    expect(result.state).toBe("failed");
    expect(loaded).toBe(false);
  });

  test("读取器抛错＝failed 透传原因；整形抛错同面", async () => {
    const home = await realDir();
    const boom = createCanvasQuery({
      paoHome: home,
      loadDetailReader: async () => {
        throw new Error("fork build products missing");
      },
    });
    const failed = await boom.readNodeDetail("/p/i", "实现");
    expect(failed.state).toBe("failed");
    if (failed.state !== "failed") throw new Error("unreachable");
    expect(failed.message).toContain("fork build products missing");

    const bad = createCanvasQuery({
      paoHome: home,
      loadDetailReader: async () => (() => 42) as unknown as PaoDesktopNodeDetailReader,
    });
    const badResult = await bad.readNodeDetail("/p/i", "实现");
    expect(badResult.state).toBe("failed");
  });

  test("happy path：home/实例/节点透传给读取器", async () => {
    const home = await realDir();
    let seen: unknown[] = [];
    const reader: PaoDesktopNodeDetailReader = (h, i, n) => {
      seen = [h, i, n];
      return { 节点: n, 实例: i, 执行: [] };
    };
    const query = createCanvasQuery({
      paoHome: home,
      loadDetailReader: async () => reader,
      loadRuntimeReader: async () => {
        throw new Error("运行态未接线（测试注入）");
      },
    });
    const result = await query.readNodeDetail("/p/inst.md", "实现");
    expect(seen).toEqual([home, "/p/inst.md", "实现"]);
    expect(result.state).toBe("ok");
    if (result.state !== "ok") throw new Error("unreachable");
    expect(result.detail.node).toBe("实现");
  });

  test("运行态读取器加载失败＝基础详情仍 ok 且落 runtimeError", async () => {
    const home = await realDir();
    const query = createCanvasQuery({
      paoHome: home,
      loadDetailReader: async () => (_h, i, n) => ({ 节点: n, 实例: i, 执行: [] }),
      loadRuntimeReader: async () => {
        throw new Error("read-model.js missing");
      },
    });
    const result = await query.readNodeDetail("/p/.pao/工作流实例-好流.md", "实现");
    expect(result.state).toBe("ok");
    if (result.state !== "ok") throw new Error("unreachable");
    expect(result.detail.runtimeError).toContain("read-model.js missing");
    expect(result.detail.node).toBe("实现");
  });

  test("注入运行态读取器：合并卡面真值与执行锚点，越界会话路径落 statsError", async () => {
    const { realpath } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const home = await realpath(await realDir());
    const instancePath = join(home, ".pao", "工作流实例-好流.md");
    const cardPath = join(home, ".pao", "卡", "卡0001.md");
    const sessionPath = join(home, ".pao", "worker会话", "s_exec-1.jsonl");
    const outsidePath = join(home, "..", "外部", "s_exec-2.jsonl");
    const query = createCanvasQuery({
      paoHome: home,
      loadDetailReader: async () => (_h, i, n) => ({
        节点: n,
        实例: i,
        卡: {
          卡号: "卡0001",
          状态: "in_progress",
          尝试: 2,
          创建: "2026-10-05 10:00",
          路径: cardPath,
          回执: [],
        },
        执行: [{ 执行标识: "exec-9", 来源: "卡回执" }],
      }),
      loadRuntimeReader: async () => ({
        readDesktopProject: (root: string) => ({
          projectRoot: root,
          cards: [
            {
              path: cardPath,
              filename: "卡0001.md",
              card_no: 1,
              frontmatter: {
                goal: "实现画布",
                dept: "工程",
                acceptance: "测试全绿",
                attempt: 2,
                created: "2026-10-05 10:00",
                completed: "2026-10-05 10:30",
                status: "delivered",
              },
              body: "",
              receipts: [{ card_no: 1, attempt: 1, time: "2026-10-05 10:20", usage: { input: 10, output: 5 } }],
            },
          ],
          execution: [
            {
              执行标识: "exec-1",
              卡路径: cardPath,
              尝试: 2,
              状态: "运行中",
              时间: "2026-10-05 10:25",
              映射路径: join(home, ".pao", "执行映射", "exec-1.jsonl"),
              会话路径: sessionPath,
              当前尝试: true,
            },
            {
              执行标识: "exec-2",
              卡路径: cardPath,
              尝试: 1,
              状态: "失败",
              时间: "2026-10-05 10:10",
              映射路径: join(home, ".pao", "执行映射", "exec-2.jsonl"),
              会话路径: outsidePath,
              当前尝试: false,
            },
          ],
          issues: [],
        }),
        readDesktopSessionIncrement: (session: string) => ({
          会话路径: session,
          下次偏移: 12,
          末行未完: false,
          还有更多: false,
          行: [],
          本段统计: { 响应: 2, 工具: 1, token: 300, 未知用量: 0 },
        }),
      }),
    });
    const result = await query.readNodeDetail(instancePath, "实现");
    expect(result.state).toBe("ok");
    if (result.state !== "ok") throw new Error("unreachable");
    expect(result.detail.runtimeError).toBeUndefined();
    expect(result.detail.card?.target).toBe("实现画布");
    expect(result.detail.card?.durationSeconds).toBe(1800);
    expect(result.detail.usage?.input).toBe(10);
    expect(result.detail.usage?.partial).toBe(false);
    const exec1 = result.detail.executions.find((item) => item.execId === "exec-1");
    expect(exec1?.attempt).toBe(2);
    expect(exec1?.current).toBe(true);
    expect(exec1?.sessionStats?.tokens).toBe(300);
    const exec2 = result.detail.executions.find((item) => item.execId === "exec-2");
    expect(exec2?.statsError).toContain("越出");
    expect(result.detail.executions.find((item) => item.execId === "exec-9")?.source).toBe("卡回执");
  });
});

describe("D8d 渲染体（renderToString）", () => {
  function renderBody(
    detail: Parameters<typeof CanvasNodeDetailBody>[0]["detail"],
    extra: Partial<Parameters<typeof CanvasNodeDetailBody>[0]> = {},
  ): string {
    return renderToString(
      createElement(CanvasNodeDetailBody, {
        detail,
        onOpenCard: () => undefined,
        onOpenSession: () => undefined,
        ...extra,
      }),
    );
  }

  test("档位差异高亮（模板→卡面）；预算差异同款", () => {
    const html = renderBody({
      node: "实现",
      instance: "/p/i",
      template: { dept: "工程", tier: "标准", budget: { cost: 2, turns: 20 } },
      card: {
        cardRef: "卡0001",
        status: "delivered",
        tier: "高配",
        budget: { turns: 40 },
        attempts: 2,
        created: "2026-10-05 10:00",
        path: "/p/卡/卡0001.md",
        receipts: [],
      },
      executions: [],
    });
    expect(html).toContain("canvas-detail__value--diff");
    expect(html).toContain("标准 → 高配");
    expect(html).toContain("cost=2 turns=20 → turns=40");
  });

  test("升档理由无记录如实显示；回执轮次带证据；执行锚点带跳转按钮", () => {
    const html = renderBody({
      node: "实现",
      instance: "/p/i",
      template: { dept: "工程" },
      card: {
        cardRef: "卡0001",
        status: "delivered",
        attempts: 2,
        created: "2026-10-05 10:00",
        path: "/p/卡/卡0001.md",
        receipts: [
          {
            attempt: 1,
            time: "2026-10-05 10:30",
            result: "打回",
            failureType: "验收不通过",
            summary: "缺测试",
            evidence: ["src/a.ts:12"],
          },
        ],
      },
      executions: [{ execId: "exec-1", status: "运行中", source: "执行映射" }],
    });
    expect(html).toContain('data-testid="canvas-detail-tier-note"');
    expect(html).toContain("No record"); // 无 I18nProvider 回落英文键
    expect(html).toContain('data-testid="canvas-detail-rounds"');
    expect(html).toContain("src/a.ts:12");
    expect(html).toContain("验收不通过");
    expect(html).toContain('data-testid="canvas-detail-executions"');
    expect(html).toContain("exec-1");
    expect(html).toContain('data-testid="canvas-detail-open-session"');
  });

  test("未落卡：查看卡禁用＋「Not on a card yet」；错误行透出", () => {
    const html = renderBody({ node: "复核", instance: "/p/i", executions: [], error: "配方模板值不可读：坏档" });
    expect(html).toContain('data-testid="canvas-detail-view-card"');
    expect(html).toContain("disabled");
    expect(html).toContain("Not on a card yet");
    expect(html).toContain("配方模板值不可读：坏档");
  });
});

describe("画布头部（P4-4 按钮）", () => {
  test("传 onOpenMasterSession 时渲染主控会话按钮；D8d 外壳在 api＋实例节点下显示加载态", () => {
    const html = renderToString(
      createElement(CanvasPageView, {
        result: {
          state: "available",
          recipes: [],
          instances: [
            {
              name: "好流",
              path: "/p/.pao/工作流实例-好流.md",
              workflow: "好流",
              cardDir: "/p/卡",
              startedAt: "2026-10-05 10:00",
              status: "运行中",
              params: {},
              nodes: [{ name: "实现", status: "delivered" }],
            },
          ],
          anomalies: [],
        },
        loading: false,
        onRefresh: () => undefined,
        onOpenMasterSession: () => undefined,
        api: { getCanvasNodeDetail: () => Promise.resolve({ state: "failed", message: "x" }) } as never,
        selection: { kind: "instance", name: "好流" },
        selectedNode: "实现",
      }),
    );
    expect(html).toContain('data-testid="canvas-open-master-session"');
    expect(html).toContain('data-testid="canvas-node-detail-d8d"');
    // renderToString 不跑 effect：深读未完成时外壳先显示加载态，不伪装已有详情
    expect(html).toContain("Loading");
  });

  test("不传 onOpenMasterSession 时不渲染该按钮", () => {
    const html = renderToString(
      createElement(CanvasPageView, {
        result: { state: "available", recipes: [], instances: [], anomalies: [] },
        loading: false,
        onRefresh: () => undefined,
      }),
    );
    expect(html).not.toContain('data-testid="canvas-open-master-session"');
  });
});

describe("主控提示词模板（内容锚点）", () => {
  test("完整职责＋两段式协议要点齐全", () => {
    for (const phrase of [
      "主控",
      "三路分级",
      "棘轮",
      "一次只问一个",
      "建议答案",
      "写回你的理解",
      "过目",
      "监督",
    ]) {
      expect(MASTER_PROMPT_TEMPLATE).toContain(phrase);
    }
  });
});
