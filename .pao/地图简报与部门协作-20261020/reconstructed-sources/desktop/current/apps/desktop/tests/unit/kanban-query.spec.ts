import { expect, test } from "@playwright/test";
import { createKanbanQuery, normalizeKanban } from "../../electron/platform/pao/kanban-query";

test("全卡聚合区分同卡号的不同项目，单卡损坏保留错误及其余卡", () => {
  const card = (path: string, status = "unclaimed") => ({
    path,
    card_no: 1,
    body: "正文",
    receipts: [],
    frontmatter: {
      goal: "做事",
      dept: "工程",
      acceptance: "检查",
      status,
      attempt: 0,
      created: "2026-10-05 10:00",
    },
  });
  const result = normalizeKanban({
    issues: [{ 路径: "/unreachable", 说明: "目录不可读" }],
    projects: [
      { projectRoot: "/a", issues: [], execution: [], cards: [card("/a/卡1.md"), card("/a/坏卡.md", "completed")] },
      { projectRoot: "/b", issues: [], execution: [], cards: [card("/b/卡1.md", "delivered")] },
    ],
  });
  expect(result.state).toBe("available");
  if (result.state !== "available") throw new Error(result.message);
  expect(result.cards.map((row) => [row.project, row.number, row.status])).toEqual([
    ["/a", 1, "unclaimed"],
    ["/b", 1, "delivered"],
  ]);
  expect(result.issues).toEqual([
    { path: "/unreachable", message: "目录不可读" },
    { path: "/a/坏卡.md", message: "未知卡状态：completed" },
  ]);
});

test("读取失败显式不可用，不把失败显示成空看板", async () => {
  const query = createKanbanQuery({
    loadReader: async () => {
      throw new Error("缺少构建产物");
    },
  });
  expect(await query.collect("/home", "/project")).toEqual({
    state: "unavailable",
    message: "缺少构建产物",
  });
  expect(() => normalizeKanban({ projects: [], issues: "坏列表" })).toThrow("列表字段缺失");
});

test("活性按卡路径合并：当前尝试照带，无信号不编造，阈值 0 原样保留", () => {
  const card = (path: string, attempt: number, status = "in_progress") => ({
    path,
    card_no: 1,
    body: "正文",
    receipts: [],
    frontmatter: {
      goal: "做事",
      dept: "工程",
      acceptance: "检查",
      status,
      attempt,
      created: "2026-10-05 10:00",
    },
  });
  const activity = (path: string, attempt: number, current: boolean, silenceMinutes: number) => ({
    卡路径: path,
    会话: "owner-1",
    执行标识: `exec-${attempt}`,
    尝试: attempt,
    登记时间: "2026-10-05T10:00:00.000Z",
    最近输出时间: "2026-10-05T10:05:00.000Z",
    运行中: true,
    静默分钟: silenceMinutes,
    当前尝试: current,
  });
  const result = normalizeKanban({
    issues: [],
    projects: [
      {
        projectRoot: "/a",
        issues: [],
        execution: [],
        cards: [card("/a/卡1.md", 2), card("/a/卡2.md", 3)],
        liveness: [activity("/a/卡1.md", 2, true, 30), activity("/a/卡2.md", 2, false, 0)],
      },
      { projectRoot: "/b", issues: [], execution: [], cards: [card("/b/卡1.md", 1)] },
    ],
  });
  expect(result.state).toBe("available");
  if (result.state !== "available") throw new Error(result.message);
  const first = result.cards[0];
  const second = result.cards[1];
  const third = result.cards[2];
  if (!first || !second || !third) throw new Error("期望读到三张卡，实际不足三张");
  expect(first.activity).toEqual({
    owner: "owner-1",
    executionId: "exec-2",
    attempt: 2,
    registeredAt: "2026-10-05T10:00:00.000Z",
    lastOutputAt: "2026-10-05T10:05:00.000Z",
    running: true,
    silenceMinutes: 30,
    current: true,
  });
  // 登记属于旧尝试：照带 current=false，由看板判无信号，不冒充当前。
  expect(second.activity?.current).toBe(false);
  expect(second.activity?.silenceMinutes).toBe(0);
  // 旧构建产物没有「活性」字段：缺省＝无信号，不编造。
  expect(third.activity).toBeUndefined();
});

test("活性租约四字段透传占位：带则原样带出、缺省为 unknown 不编造", () => {
  const card = (path: string) => ({
    path,
    card_no: 1,
    body: "正文",
    receipts: [],
    frontmatter: {
      goal: "做事",
      dept: "工程",
      acceptance: "检查",
      status: "in_progress",
      attempt: 2,
      created: "2026-10-05 10:00",
    },
  });
  const base = {
    卡路径: "/a/卡1.md",
    会话: "owner-1",
    执行标识: "exec-2",
    尝试: 2,
    登记时间: "2026-10-05T10:00:00.000Z",
    运行中: true,
    静默分钟: 30,
    当前尝试: true,
  };
  const result = normalizeKanban({
    issues: [],
    projects: [
      {
        projectRoot: "/a",
        issues: [],
        execution: [],
        cards: [card("/a/卡1.md"), { ...card("/a/卡2.md"), card_no: 2, path: "/a/卡2.md" }],
        liveness: [
          {
            ...base,
            认领时间: "2026-10-05T10:01:00.000Z",
            租约到期: "2026-10-05T11:00:00.000Z",
            认领代数: 2,
            被接管: false,
          },
          { ...base, 卡路径: "/a/卡2.md" },
        ],
      },
    ],
  });
  expect(result.state).toBe("available");
  if (result.state !== "available") throw new Error(result.message);
  const leased = result.cards[0]?.activity;
  const legacy = result.cards[1]?.activity;
  if (!leased || !legacy) throw new Error("期望两张卡都带活性行");
  expect(leased.claimAt).toBe("2026-10-05T10:01:00.000Z");
  expect(leased.leaseExpiresAt).toBe("2026-10-05T11:00:00.000Z");
  expect(leased.claimGeneration).toBe(2);
  expect(leased.takenOver).toBe(false);
  // 旧构建产物/旧登记没有租约字段：缺省＝unknown，不把没有读成正常。
  expect(legacy.claimAt).toBeUndefined();
  expect(legacy.leaseExpiresAt).toBeUndefined();
  expect(legacy.claimGeneration).toBeUndefined();
  expect(legacy.takenOver).toBeUndefined();
});

test("工作流节点→卡号映射原样带出：多卡节点全量、坏工作流只落问题不拖卡", () => {
  const card = (path: string, number: number) => ({
    path,
    card_no: number,
    body: "正文",
    receipts: [],
    frontmatter: {
      goal: "做事",
      dept: "工程",
      acceptance: "检查",
      status: "unclaimed",
      attempt: 0,
      created: "2026-10-05 10:00",
    },
  });
  const flow = {
    路径: "/a/.pao/任务甲/工作流实例-发布.md",
    控制: {
      实例: "实例甲",
      工作流: "发布",
      状态: "运行中",
      卡目录: "/a/.pao/任务甲/卡",
      节点: [{ 名字: "实现", 轮次: 1, 卡: ["卡0002", "卡0003"] }],
    },
  };
  const result = normalizeKanban({
    issues: [],
    projects: [
      {
        projectRoot: "/a",
        issues: [],
        execution: [],
        cards: [
          card("/a/.pao/卡/卡0001-甲.md", 1),
          card("/a/.pao/任务甲/卡/卡0002-乙.md", 2),
          card("/a/.pao/任务甲/卡/卡0003-丙.md", 3),
        ],
        workflow: [flow, { 路径: "/a/.pao/任务甲/坏工作流.md", 控制: "坏控制" }],
      },
      { projectRoot: "/b", issues: [], execution: [], cards: [card("/b/.pao/卡/卡0001-b.md", 1)] },
    ],
  });
  expect(result.state).toBe("available");
  if (result.state !== "available") throw new Error(result.message);
  // 旧构建产物可能没有「工作流」字段：缺省＝空数组。
  expect(result.cards).toHaveLength(4);
  expect(result.workflows).toEqual([
    {
      path: "/a/.pao/任务甲/工作流实例-发布.md",
      project: "/a",
      instance: "实例甲",
      workflow: "发布",
      status: "运行中",
      nodes: [
        { name: "实现", round: 1, cardsDir: "/a/.pao/任务甲/卡", cardRefs: ["卡0002", "卡0003"] },
      ],
    },
  ]);
  expect(result.issues).toHaveLength(1);
  const bad = result.issues[0];
  if (!bad) throw new Error("坏工作流必须显式进问题");
  expect(bad.path).toBe("/a/.pao/任务甲/坏工作流.md");
  expect(bad.message).toContain("工作流字段无效");
});

test("坏活性行只丢这一条信号并留问题，不拖掉整张卡", () => {
  const result = normalizeKanban({
    issues: [],
    projects: [
      {
        projectRoot: "/a",
        issues: [],
        execution: [],
        cards: [
          {
            path: "/a/卡1.md",
            card_no: 1,
            body: "正文",
            receipts: [],
            frontmatter: {
              goal: "做事",
              dept: "工程",
              acceptance: "检查",
              status: "in_progress",
              attempt: 1,
              created: "2026-10-05 10:00",
            },
          },
        ],
        liveness: [{ 卡路径: "/a/卡1.md" }],
      },
    ],
  });
  expect(result.state).toBe("available");
  if (result.state !== "available") throw new Error(result.message);
  expect(result.cards).toHaveLength(1);
  expect(result.issues).toHaveLength(1);
  const kept = result.cards[0];
  const raised = result.issues[0];
  if (!kept || !raised) throw new Error("期望坏活性行只丢信号：卡仍在、问题已落");
  expect(kept.activity).toBeUndefined();
  expect(raised.message).toContain("活性字段无效");
});

test("显式接管后旧代活性行不覆盖新代呈现：同卡多行按认领代数取最大（旧行后到也不赢）", () => {
  const card = {
    path: "/a/卡1.md",
    card_no: 1,
    body: "正文",
    receipts: [],
    frontmatter: {
      goal: "做事",
      dept: "工程",
      acceptance: "检查",
      status: "in_progress",
      attempt: 2,
      created: "2026-10-05 10:00",
    },
  };
  const row = (overrides: Record<string, unknown>) => ({
    卡路径: "/a/卡1.md",
    会话: "owner-1",
    执行标识: "exec",
    尝试: 2,
    登记时间: "2026-10-05T10:00:00.000Z",
    运行中: true,
    静默分钟: 30,
    当前尝试: true,
    ...overrides,
  });
  const 新代 = row({
    认领时间: "2026-10-05T12:00:00.000Z",
    租约到期: "2026-10-06T12:00:00.000Z",
    认领代数: 2,
    被接管: false,
  });
  const 旧代 = row({
    认领时间: "2026-10-05T09:00:00.000Z",
    租约到期: "2026-10-05T10:00:00.000Z",
    认领代数: 1,
    被接管: true,
  });
  const read = (rows: unknown[]) =>
    normalizeKanban({ issues: [], projects: [{ projectRoot: "/a", issues: [], execution: [], cards: [card], liveness: rows }] });
  // 旧行在后（当前实现＝后到者胜）：修复后必须仍取新代。
  const worst = read([新代, 旧代]);
  if (worst.state !== "available") throw new Error(worst.message);
  expect(worst.cards[0]?.activity?.claimGeneration).toBe(2);
  expect(worst.cards[0]?.activity?.leaseExpiresAt).toBe("2026-10-06T12:00:00.000Z");
  expect(worst.cards[0]?.activity?.takenOver).toBe(false);
  // 旧行在前：同取新代。
  const natural = read([旧代, 新代]);
  if (natural.state !== "available") throw new Error(natural.message);
  expect(natural.cards[0]?.activity?.claimGeneration).toBe(2);
  // 无代数的旧构建行视为最低：不得覆盖带代数的行；无代数行之间保持后到者。
  const legacy = row({});
  const mixed = read([新代, legacy]);
  if (mixed.state !== "available") throw new Error(mixed.message);
  expect(mixed.cards[0]?.activity?.claimGeneration).toBe(2);
  const bothLegacy = read([legacy, { ...legacy, 执行标识: "exec-late" }]);
  if (bothLegacy.state !== "available") throw new Error(bothLegacy.message);
  expect(bothLegacy.cards[0]?.activity?.executionId).toBe("exec-late");
});
