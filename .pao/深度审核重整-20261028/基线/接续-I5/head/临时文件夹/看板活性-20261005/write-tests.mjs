import { readFileSync, writeFileSync } from "node:fs";

const querySpec = "D:/AI/workspace/pao-dev/桌面端/apps/desktop/tests/unit/kanban-query.spec.ts";
let q = readFileSync(querySpec, "utf8");
const extra = `
test("活性按卡路径合并：当前尝试照带，无信号不编造，阈值 0 原样保留", () => {
  const card = (path: string, attempt: number, status = "进行中") => ({
    路径: path,
    卡号: 1,
    正文: "正文",
    回执: [],
    frontmatter: {
      目标: "做事",
      部门: "工程",
      验收: "检查",
      状态: status,
      尝试: attempt,
      创建: "2026-10-05 10:00",
    },
  });
  const activity = (path: string, attempt: number, current: boolean, silenceMinutes: number) => ({
    卡路径: path,
    会话: "owner-1",
    执行标识: \`exec-\${attempt}\`,
    尝试: attempt,
    登记时间: "2026-10-05T10:00:00.000Z",
    最近输出时间: "2026-10-05T10:05:00.000Z",
    运行中: true,
    静默分钟: silenceMinutes,
    当前尝试: current,
  });
  const result = normalizeKanban({
    问题: [],
    项目: [
      {
        项目根: "/a",
        问题: [],
        执行: [],
        卡: [card("/a/卡1.md", 2), card("/a/卡2.md", 3)],
        活性: [activity("/a/卡1.md", 2, true, 30), activity("/a/卡2.md", 2, false, 0)],
      },
      { 项目根: "/b", 问题: [], 执行: [], 卡: [card("/b/卡1.md", 1)] },
    ],
  });
  expect(result.state).toBe("available");
  if (result.state !== "available") throw new Error(result.message);
  const [first, second, third] = result.cards;
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

test("坏活性行只丢这一条信号并留问题，不拖掉整张卡", () => {
  const result = normalizeKanban({
    问题: [],
    项目: [
      {
        项目根: "/a",
        问题: [],
        执行: [],
        卡: [
          {
            路径: "/a/卡1.md",
            卡号: 1,
            正文: "正文",
            回执: [],
            frontmatter: {
              目标: "做事",
              部门: "工程",
              验收: "检查",
              状态: "进行中",
              尝试: 1,
              创建: "2026-10-05 10:00",
            },
          },
        ],
        活性: [{ 卡路径: "/a/卡1.md" }],
      },
    ],
  });
  expect(result.state).toBe("available");
  if (result.state !== "available") throw new Error(result.message);
  expect(result.cards).toHaveLength(1);
  expect(result.cards[0].activity).toBeUndefined();
  expect(result.issues[0].message).toContain("活性字段无效");
});
`;
writeFileSync(querySpec, q + extra);

const activitySpec = `import { expect, test } from "@playwright/test";
import type { KanbanCard, KanbanCardActivity } from "../../contracts/kanban";
import { kanbanActivitySignal, kanbanSilenceMinutes } from "../../src/features/workboard/kanban-activity";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const MINUTE = 60_000;

function card(activity?: KanbanCardActivity): KanbanCard {
  return {
    path: "D:/p/卡1.md",
    project: "D:/p",
    number: 1,
    goal: "做事",
    department: "工程",
    status: "进行中",
    acceptance: "检查",
    inputs: [],
    dependencies: [],
    priority: "中",
    attempts: 3,
    created: "2026-10-05 10:00",
    body: "正文",
    receipts: [],
    executions: [],
    activity,
  };
}

function activity(over: Partial<KanbanCardActivity> = {}): KanbanCardActivity {
  return {
    owner: "owner-1",
    executionId: "exec-3",
    attempt: 3,
    registeredAt: new Date(NOW - 5 * MINUTE).toISOString(),
    lastOutputAt: new Date(NOW - 5 * MINUTE).toISOString(),
    running: true,
    silenceMinutes: 30,
    current: true,
    ...over,
  };
}

test("无当前信号、预警关闭、已停止都显式区分，不冒充正常", () => {
  expect(kanbanActivitySignal(card(), NOW)).toBe("unknown");
  expect(kanbanActivitySignal(card(activity({ current: false })), NOW)).toBe("unknown");
  expect(kanbanActivitySignal(card(activity({ silenceMinutes: 0 })), NOW)).toBe("off");
  expect(kanbanActivitySignal(card(activity({ running: false })), NOW)).toBe("unknown");
  expect(kanbanActivitySignal(card(activity({ lastOutputAt: "坏时间" })), NOW)).toBe("unknown");
});

test("amber 只在静默达到现读阈值时出现；最近输出缺失按登记时间算", () => {
  expect(kanbanActivitySignal(card(activity({ lastOutputAt: new Date(NOW - 29 * MINUTE).toISOString() })), NOW)).toBe(
    "active",
  );
  expect(kanbanActivitySignal(card(activity({ lastOutputAt: new Date(NOW - 30 * MINUTE).toISOString() })), NOW)).toBe(
    "stale",
  );
  expect(
    kanbanActivitySignal(
      card(activity({ lastOutputAt: undefined, registeredAt: new Date(NOW - 31 * MINUTE).toISOString() })),
      NOW,
    ),
  ).toBe("stale");
  expect(kanbanSilenceMinutes(card(activity({ lastOutputAt: new Date(NOW - 31.9 * MINUTE).toISOString() })), NOW)).toBe(31);
});
`;
writeFileSync("D:/AI/workspace/pao-dev/桌面端/apps/desktop/tests/unit/kanban-activity.spec.ts", activitySpec);

const commandSpec = `import { expect, test } from "@playwright/test";
import type { KanbanCard, KanbanCardStatus } from "../../contracts/kanban";
import {
  buildCancelCommand,
  buildTerminateCommand,
  canPrepareCancel,
  canPrepareTerminate,
  formatCardNumber,
} from "../../src/features/workboard/kanban-command";

function card(status: KanbanCardStatus): KanbanCard {
  return {
    path: "D:/项目/.pao/卡/卡0017-修复退出.md",
    project: "D:/项目",
    number: 17,
    goal: "修退出",
    department: "工程",
    status,
    acceptance: "检查",
    inputs: [],
    dependencies: [],
    priority: "中",
    attempts: 2,
    created: "2026-10-05 10:00",
    body: "正文",
    receipts: [],
    executions: [],
  };
}

test("终态不给取消，只有进行中给终止", () => {
  expect(canPrepareCancel(card("待认领"))).toBe(true);
  expect(canPrepareCancel(card("进行中"))).toBe(true);
  expect(canPrepareCancel(card("已交付"))).toBe(false);
  expect(canPrepareCancel(card("失败"))).toBe(false);
  expect(canPrepareCancel(card("取消"))).toBe(false);
  expect(canPrepareTerminate(card("进行中"))).toBe(true);
  expect(canPrepareTerminate(card("待认领"))).toBe(false);
});

test("生成的指令带齐卡路径/卡号/项目/状态与尝试，且只指向合法主控工具", () => {
  const target = card("进行中");
  const cancel = buildCancelCommand(target);
  for (const text of [
    "pao_改状态",
    '"新状态":"取消"',
    "D:/项目/.pao/卡/卡0017-修复退出.md",
    "D:/项目",
    "进行中 / 2",
    formatCardNumber(17),
  ])
    expect(cancel).toContain(text);
  expect(cancel).not.toContain("pao_终止卡");

  const terminate = buildTerminateCommand(target);
  expect(terminate).toContain("pao_终止卡");
  expect(terminate).toContain('"卡目录":"D:/项目/.pao/卡"');
  expect(terminate).toContain("D:/项目/.pao/卡/卡0017-修复退出.md");
  expect(terminate).not.toContain("pao_改状态");
});
`;
writeFileSync("D:/AI/workspace/pao-dev/桌面端/apps/desktop/tests/unit/kanban-command.spec.ts", commandSpec);
console.log("ok: 三个测试文件已写");