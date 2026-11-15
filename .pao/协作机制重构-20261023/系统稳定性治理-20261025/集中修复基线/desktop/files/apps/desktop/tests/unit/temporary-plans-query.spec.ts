import { expect, test } from "@playwright/test";
import { createTemporaryPlansQuery } from "../../electron/platform/pao/temporary-plans-query";
import type { PaoDesktopPlanModule } from "@pi-gui/pi-sdk-driver";

/** fork 侧的返回形状（中文键）：本用例只验桌面桥的收窄与规范化，不读真实磁盘。 */
function fakeModule(read: () => Promise<unknown>): PaoDesktopPlanModule {
  return { readDesktopPlans: read } as unknown as PaoDesktopPlanModule;
}

const 一份计划 = {
  计划ID: "p-20261014-abc123",
  显示名: "小说创作",
  定义版本: 3,
  已撤销: false,
  来源会话: "sess-1",
  创建时刻: "2026-10-14 10:00",
  更新时刻: "2026-10-14 11:00",
  步骤: [
    {
      步骤ID: "s1",
      标题: "讨论计划",
      部门: "策划部",
      要求: "把方向讨论清楚",
      依赖: [],
      人工门: true,
      只读: false,
      审核: false,
    },
    {
      步骤ID: "s2",
      标题: "写初稿",
      部门: "写作部",
      要求: "按计划写初稿",
      预期成果: "创作成果/初稿.md",
      依赖: ["s1"],
      人工门: false,
      只读: false,
      审核: true,
    },
  ],
  启动: [
    {
      启动请求ID: "start-1",
      实例: "inst-9",
      配方名: "临时-p-20261014-abc123",
      工作区: "/p/.pao/临时工作流/p-20261014-abc123/执行/start-1",
      卡目录: "/p/.pao/临时工作流/p-20261014-abc123/执行/start-1/卡",
      控制清单: "/p/.pao/临时工作流/p-20261014-abc123/执行/start-1/工作流实例-x.md",
      owner会话: "sess-1",
      受理时刻: "2026-10-14 12:00",
      状态: "运行中",
      进度: [
        {
          步骤ID: "s1",
          状态: "delivered",
          轮次: 1,
          已确认: "2026-10-14 12:30",
          需要人工确认: true,
          等待人工确认: false,
          卡: ["0001"],
          记录: [
            { 轮次: 1, 卡: ["0001"], 判定: "change", 原因: "初稿缺结尾" },
            { 轮次: 2, 卡: ["0004"] },
          ],
          产出: [
            {
              路径: "创作成果/初稿.md",
              相对路径: "创作成果/初稿.md",
              轮次: 1,
              卡号: "0001",
              版本依据: "第 1 轮（卡 0001）",
              当前轮: false,
              存在: true,
            },
            {
              路径: "创作成果/缺失.md",
              相对路径: "创作成果/缺失.md",
              轮次: 2,
              卡号: "0004",
              版本依据: "第 2 轮（卡 0004）",
              当前轮: true,
              存在: false,
              说明: "盘上找不到这个文件（可能被移动，或这一轮还没真正产出）",
            },
          ],
        },
        {
          步骤ID: "s2",
          状态: "in_progress",
          轮次: 2,
          需要人工确认: false,
          等待人工确认: true,
          卡: ["0002", "0003"],
          记录: [],
          读取问题: "卡 0002 读不出来：frontmatter 缺 status",
          产出: [],
        },
      ],
    },
  ],
  意见: [
    {
      意见ID: "fb-1",
      计划ID: "p-20261014-abc123",
      定义版本: 3,
      目标: { 类型: "步骤", 步骤ID: "s1" },
      正文: "把第三章并进来",
      状态: "已记录",
      记录时刻: "2026-10-14 13:00",
      更新时刻: "2026-10-14 13:00",
    },
    {
      意见ID: "fb-2",
      计划ID: "p-20261014-abc123",
      定义版本: 3,
      目标: { 类型: "文件", 步骤ID: "s2", 轮次: 1, 路径: "创作成果/初稿.md", 版本依据: "轮次1" },
      正文: "开头太慢",
      状态: "投递失败",
      记录时刻: "2026-10-14 13:10",
      更新时刻: "2026-10-14 13:20",
      投递: { 送达: false, 结果: "部长会话已停止", 时刻: "2026-10-14 13:20" },
    },
  ],
};

test("计划投影收窄：步骤 ID 稳定、启动关联与意见状态如实、问题一并交出", async () => {
  const query = createTemporaryPlansQuery({
    loadModule: async () =>
      fakeModule(async () => ({
        计划: [一份计划],
        问题: [{ 路径: "/p/.pao/临时工作流/p-bad/计划.md", 说明: "缺「计划ID」" }],
      })),
  });
  const result = await query.collect("/p", { workspaceId: "ws-a" });
  expect(result.state).toBe("ok");
  if (result.state !== "ok") return;
  expect(result.issues).toEqual([
    { path: "/p/.pao/临时工作流/p-bad/计划.md", message: "缺「计划ID」" },
  ]);
  const plan = result.plans[0]!;
  expect(plan.planId).toBe("p-20261014-abc123");
  expect(plan.definitionVersion).toBe(3);
  expect(plan.undone).toBe(false);
  expect(plan.sourceSessionId).toBe("sess-1");
  expect(plan.steps.map((step) => step.stepId)).toEqual(["s1", "s2"]);
  expect(plan.steps[0]!.humanGate).toBe(true);
  expect(plan.steps[1]!.dependsOn).toEqual(["s1"]);
  expect(plan.steps[1]!.audit).toBe(true);
  expect(plan.starts[0]!.instanceId).toBe("inst-9");
  expect(plan.starts[0]!.status).toBe("运行中");
  const progress = plan.starts[0]!.progress;
  expect(progress.map((row) => [row.stepId, row.status, row.round])).toEqual([
    ["s1", "delivered", 1],
    ["s2", "in_progress", 2],
  ]);
  expect(progress[0]!.needsConfirmation).toBe(true);
  expect(progress[0]!.confirmed).toBe("2026-10-14 12:30");
  expect(progress[0]!.artifacts.map((row) => [row.path, row.exists])).toEqual([
    ["创作成果/初稿.md", true],
    ["创作成果/缺失.md", false],
  ]);
  expect(progress[0]!.artifacts[1]!.note).toContain("盘上找不到");
  // 同路径跨轮次的历史不吞：版本依据与当前轮位原样投影，界面据此提示「有新版本」而不抢换正文。
  expect(progress[0]!.artifacts.map((row) => [row.round, row.versionBasis, row.currentRound])).toEqual([
    [1, "第 1 轮（卡 0001）", false],
    [2, "第 2 轮（卡 0004）", true],
  ]);
  // 卡读不出来时产物清单不完整，原因必须交给界面，不静默当「没有产物」。
  expect(progress[1]!.readProblem).toContain("卡 0002 读不出来");
  // 停卡入口要点名真实卡引用，界面不自己编卡号。
  expect(progress[0]!.cards).toEqual(["0001"]);
  expect(progress[1]!.cards).toEqual(["0002", "0003"]);
  // 人工门等待位是内核真值：界面据它显示「待你确认」，不靠挂起文案猜。
  expect(progress[0]!.awaitingConfirmation).toBe(false);
  expect(progress[1]!.awaitingConfirmation).toBe(true);
  // 执行记录照抄内核原文：第几次、判定与原因，界面不翻译成猜测值。
  expect(progress[0]!.records).toEqual([
    { round: 1, cards: ["0001"], verdict: "change", reason: "初稿缺结尾" },
    { round: 2, cards: ["0004"] },
  ]);
  expect(progress[1]!.records).toEqual([]);
  expect(progress[1]!.artifacts).toEqual([]);
  expect(plan.feedback.map((row) => [row.targetKind, row.target, row.status])).toEqual([
    ["步骤", "s1", "已记录"],
    ["文件", "创作成果/初稿.md", "投递失败"],
  ]);
  expect(plan.feedback[1]!.detail).toBe("部长会话已停止");
});

test("按稳定计划 ID 过滤：查不到就是「不在当前项目」，不返回空列表冒充还没有计划", async () => {
  const query = createTemporaryPlansQuery({
    loadModule: async () => fakeModule(async () => ({ 计划: [一份计划], 问题: [] })),
  });
  const found = await query.collect("/p", { workspaceId: "ws-a", planId: "p-20261014-abc123" });
  expect(found.state).toBe("ok");
  if (found.state === "ok") expect(found.plans).toHaveLength(1);

  const missing = await query.collect("/p", { workspaceId: "ws-a", planId: "p-20261014-nope" });
  expect(missing).toEqual({ state: "failed", message: "计划不在当前项目：p-20261014-nope" });
});

test("读失败落成可展示的失败，不抛到主进程顶层，也不伪装成没有计划", async () => {
  const query = createTemporaryPlansQuery({
    loadModule: async () => {
      throw new Error("PAO desktop bridge is missing readDesktopPlans in the build products.");
    },
  });
  const result = await query.collect("/p", { workspaceId: "ws-a" });
  expect(result.state).toBe("failed");
  if (result.state === "failed") expect(result.message).toContain("readDesktopPlans");
});

test("坏形状显式失败：步骤缺标题不算空计划", async () => {
  const query = createTemporaryPlansQuery({
    loadModule: async () =>
      fakeModule(async () => ({
        计划: [{ ...一份计划, 步骤: [{ 步骤ID: "s1", 部门: "策划部", 要求: "x", 依赖: [] }] }],
        问题: [],
      })),
  });
  const result = await query.collect("/p", { workspaceId: "ws-a" });
  expect(result.state).toBe("failed");
  if (result.state === "failed") expect(result.message).toContain("步骤标题");
});

test("坏形状显式失败：产物缺版本依据不静默补默认值", async () => {
  const query = createTemporaryPlansQuery({
    loadModule: async () =>
      fakeModule(async () => ({
        计划: [
          {
            ...一份计划,
            启动: [
              {
                ...一份计划.启动[0]!,
                进度: [
                  {
                    ...一份计划.启动[0]!.进度[0]!,
                    产出: [
                      {
                        路径: "创作成果/初稿.md",
                        相对路径: "创作成果/初稿.md",
                        轮次: 1,
                        卡号: "0001",
                        当前轮: true,
                        存在: true,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        问题: [],
      })),
  });
  const result = await query.collect("/p", { workspaceId: "ws-a" });
  expect(result.state).toBe("failed");
  if (result.state === "failed") expect(result.message).toContain("产物版本依据");
});

test("意见版本绑定与流程级意见都投影给界面：空步骤 ID 不连累整份查询", async () => {
  const query = createTemporaryPlansQuery({
    loadModule: async () =>
      fakeModule(async () => ({
        计划: [
          {
            ...一份计划,
            意见: [
              ...一份计划.意见,
              // 流程级意见：内核的目标是 { 类型: "流程" }，没有步骤 ID。
              {
                意见ID: "fb-3",
                计划ID: "p-20261014-abc123",
                定义版本: 3,
                目标: { 类型: "流程" },
                正文: "整个过程要保留验收结果",
                状态: "已应用",
                记录时刻: "2026-10-14 13:30",
                更新时刻: "2026-10-14 13:40",
                应用: { 依据: "已并入定义版本 4 的目标描述", 时刻: "2026-10-14 13:40" },
              },
            ],
          },
        ],
        问题: [],
      })),
  });
  const result = await query.collect("/p", { workspaceId: "ws-a" });
  expect(result.state).toBe("ok");
  if (result.state !== "ok") return;
  const feedback = result.plans[0]!.feedback;
  // 版本绑定一路带到界面：定义版本、记录时刻、文件意见的轮次与版本依据。
  expect(feedback.map((row) => [row.feedbackId, row.definitionVersion, row.recordedAt])).toEqual([
    ["fb-1", 3, "2026-10-14 13:00"],
    ["fb-2", 3, "2026-10-14 13:10"],
    ["fb-3", 3, "2026-10-14 13:30"],
  ]);
  expect([feedback[1]!.stepId, feedback[1]!.round, feedback[1]!.versionBasis]).toEqual([
    "s2",
    1,
    "轮次1",
  ]);
  // 流程级意见：target 是「流程」而不是空串，界面据此显示「整个流程」。
  expect([feedback[2]!.targetKind, feedback[2]!.target]).toEqual(["流程", "流程"]);
  expect(feedback[2]!.appliedBasis).toBe("已并入定义版本 4 的目标描述");
  // 步骤意见不该凭空长出文件字段。
  expect(feedback[0]!.stepId).toBeUndefined();
  expect(feedback[0]!.round).toBeUndefined();
});
