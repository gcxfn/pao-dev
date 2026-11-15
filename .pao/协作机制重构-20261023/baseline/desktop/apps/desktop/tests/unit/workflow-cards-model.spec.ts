import { expect, test } from "@playwright/test";
import type {
  TemporaryPlanArtifactRow,
  TemporaryPlanFeedbackRow,
  TemporaryPlanRow,
  TemporaryPlanStepProgressRow,
  TemporaryPlanStepRow,
} from "../../contracts/temporary-plans";
import type {
  WorkflowControlIdentity,
  WorkflowControlNodeRow,
} from "../../contracts/workflow-control";
import {
  artifactVersions,
  canSubmitDraft,
  completedStepCount,
  deriveTodos,
  detectDraftConflict,
  draftKey,
  fileOpinionGroups,
  fileScopeLabel,
  filterStepCards,
  flowStatusText,
  groupFeedbackByStatus,
  isActionableState,
  isTodoStale,
  modifyStepInstruction,
  needsAttentionState,
  nextPendingStepId,
  opinionInstruction,
  parallelStepGroups,
  pickArtifactVersion,
  saveTemplateInstruction,
  scopeLabel,
  staleTodoText,
  stepCardCounts,
  stepCardProgressCounts,
  stepCardRefs,
  stepCardViews,
  stepDuration,
  stepDurationText,
  stepHoldText,
  stepOpinions,
  stepOutputEntries,
  stepParallelGroup,
  stepRoundExecutions,
  stepRoundText,
  stopCardInstruction,
  todoKey,
  undoInstruction,
  STEP_CARD_STATE_ICONS,
  STEP_CARD_STATE_LABELS,
  TODO_KIND_ICONS,
  TODO_KIND_LABELS,
} from "../../src/features/workflow-cards/workflow-cards-model";

function 步骤(
  patch: Partial<TemporaryPlanStepRow> & { stepId: string; title: string },
): TemporaryPlanStepRow {
  return {
    dept: "开发",
    requirement: "把这件事做完",
    dependsOn: [],
    humanGate: false,
    readOnly: false,
    audit: false,
    ...patch,
  };
}

function 意见(
  patch: Partial<TemporaryPlanFeedbackRow> & { feedbackId: string; target: string },
): TemporaryPlanFeedbackRow {
  return {
    targetKind: "步骤",
    status: "已记录",
    definitionVersion: 1,
    recordedAt: "2026-10-14 10:30",
    ...patch,
  };
}

function 计划(patch: Partial<TemporaryPlanRow> = {}): TemporaryPlanRow {
  return {
    planId: "p-20261014-abc123",
    displayName: "界面优化",
    definitionVersion: 2,
    undone: false,
    sourceSessionId: "sess-1",
    createdAt: "2026-10-14 10:00",
    updatedAt: "2026-10-14 11:00",
    steps: [
      步骤({ stepId: "s1", title: "梳理需求" }),
      步骤({ stepId: "s2", title: "确定方案", dependsOn: ["s1"], humanGate: true }),
      步骤({ stepId: "s3", title: "检查", dependsOn: ["s2"] }),
    ],
    starts: [],
    feedback: [],
    ...patch,
  };
}

function 节点(
  patch: Partial<WorkflowControlNodeRow> & { name: string; status: string },
): WorkflowControlNodeRow {
  return { round: 1, requiresConfirmation: false, ...patch };
}

function 进度(
  patch: Partial<TemporaryPlanStepProgressRow> & { stepId: string },
): TemporaryPlanStepProgressRow {
  return {
    status: "in_progress",
    needsConfirmation: false,
    awaitingConfirmation: false,
    cards: [],
    artifacts: [],
    ...patch,
  };
}

function 产物(
  patch: Partial<TemporaryPlanArtifactRow> &
    { round: number; card: string },
): TemporaryPlanArtifactRow {
  return {
    path: `D:\\项目\\创作成果\\初稿.md`,
    relativePath: "成果/初稿.md",
    versionBasis: `第 ${patch.round} 轮（${patch.card}）`,
    currentRound: false,
    exists: true,
    ...patch,
  };
}

function 控制(patch: Partial<WorkflowControlIdentity> = {}): WorkflowControlIdentity {  return {
    instanceId: "i-1",
    ownerSessionId: "sess-1",
    recipeName: "临时-p-20261014-abc123",
    cardDir: "D:\\项目\\.pao\\卡",
    path: "D:\\项目\\工作流实例-临时-p-20261014-abc123.md",
    status: "运行中",
    nodes: [],
    ...patch,
  };
}

test.describe("步骤卡状态归并", () => {
  test("没有实例时：无依赖的步骤未开始，依赖未完成的步骤等待前序", () => {
    const views = stepCardViews(计划(), undefined);
    expect(views.map((view) => view.state)).toEqual(["pending", "waiting", "waiting"]);
    expect(views.every((view) => view.node === undefined)).toBe(true);
    expect(completedStepCount(views)).toBe(0);
  });

  test("控制正本按节点名（＝步骤 ID）对回步骤，交付/执行中/失败/取消/读取异常各自归位", () => {
    const views = stepCardViews(
      计划(),
      控制({
        nodes: [
          节点({ name: "s1", status: "delivered" }),
          节点({ name: "s2", status: "in_progress" }),
          节点({ name: "s3", status: "failed" }),
        ],
      }),
    );
    expect(views.map((view) => view.state)).toEqual(["done", "running", "failed"]);
    expect(views[0]?.delivered).toBe(true);
    expect(views[1]?.delivered).toBe(false);
    expect(completedStepCount(views)).toBe(1);
  });

  test("人工确认门：活干完但本轮未确认＝等待你的确认，确认后＝完成", () => {
    // 内核在人工确认通过前不会报 delivered（controlView 的 completion 把人工门算进去），
    // 所以「等待确认」必须来自内核投影的等待人工确认位，界面不去猜挂起文案。
    const 未确认 = stepCardViews(
      计划(),
      控制({
        nodes: [
          节点({ name: "s1", status: "delivered" }),
          节点({ name: "s2", status: "in_progress" }),
        ],
      }),
      [
        进度({
          stepId: "s2",
          needsConfirmation: true,
          awaitingConfirmation: true,
          cards: ["卡0002"],
        }),
      ],
    );
    expect(未确认[1]?.state).toBe("review");
    // 等待确认也算已交付（卡已交、门没放行），但不算完成。
    expect(未确认[1]?.delivered).toBe(true);
    expect(completedStepCount(未确认)).toBe(1);

    const 已确认 = stepCardViews(
      计划(),
      控制({
        nodes: [
          节点({ name: "s1", status: "delivered" }),
          节点({ name: "s2", status: "delivered", confirmed: "2026-10-14 12:00" }),
        ],
      }),
      [进度({ stepId: "s2", status: "delivered", needsConfirmation: true })],
    );
    expect(已确认[1]?.state).toBe("done");
    expect(completedStepCount(已确认)).toBe(2);
  });

  test("内核报执行中且没有等待确认位时仍是执行中（人工门不能靠 humanGate 猜）", () => {
    const views = stepCardViews(
      计划(),
      控制({
        nodes: [
          节点({ name: "s1", status: "delivered" }),
          节点({ name: "s2", status: "in_progress" }),
        ],
      }),
      [进度({ stepId: "s2", needsConfirmation: true, awaitingConfirmation: false })],
    );
    expect(views[1]?.state).toBe("running");
    expect(completedStepCount(views)).toBe(1);
  });

  test("取消与读取异常都不冒充成功", () => {
    const views = stepCardViews(
      计划(),
      控制({
        nodes: [节点({ name: "s1", status: "canceled" }), 节点({ name: "s2", status: "读取异常" })],
      }),
    );
    expect(views[0]?.state).toBe("canceled");
    expect(views[1]?.state).toBe("unreadable");
    expect(completedStepCount(views)).toBe(0);
  });

  test("只有等待确认的步骤可动作，其余不给假按钮", () => {
    expect(isActionableState("review")).toBe(true);
    for (const state of [
      "done",
      "running",
      "failed",
      "canceled",
      "pending",
      "waiting",
      "unreadable",
    ] as const) {
      expect(isActionableState(state)).toBe(false);
    }
  });
});

test.describe("流级状态文案", () => {
  test("暂停原因优先显示，没有实例时不编状态", () => {
    expect(flowStatusText(undefined)).toBeUndefined();
    expect(flowStatusText(控制())).toBe("运行中");
    expect(flowStatusText(控制({ status: "挂起", pauseReason: "等人工确认" }))).toBe(
      "挂起 · 等人工确认",
    );
  });
});

test.describe("意见归并", () => {
  test("步骤意见按步骤 ID 过滤，文件意见按路径分组且同名不同目录不合并", () => {
    const plan = 计划({
      feedback: [
        意见({ feedbackId: "f1", target: "s1", status: "已记录" }),
        意见({ feedbackId: "f2", target: "s2", status: "投递失败", detail: "部长会话已停止" }),
        意见({ feedbackId: "f3", target: "成果/初稿.md", targetKind: "文件", status: "已送达" }),
        意见({ feedbackId: "f4", target: "别的目录/初稿.md", targetKind: "文件" }),
        意见({ feedbackId: "f5", target: "成果/初稿.md", targetKind: "文件" }),
      ],
    });
    expect(stepOpinions(plan, "s1").map((row) => row.feedbackId)).toEqual(["f1"]);
    expect(stepOpinions(plan, "s2")[0]?.detail).toBe("部长会话已停止");

    const groups = fileOpinionGroups(plan);
    expect(groups.map((group) => group.path)).toEqual(["成果/初稿.md", "别的目录/初稿.md"]);
    expect(groups[0]?.opinions.map((row) => row.feedbackId)).toEqual(["f3", "f5"]);
    expect(groups[1]?.opinions).toHaveLength(1);
  });

  test("未知意见状态归到「其他」，不丢行", () => {
    const grouped = groupFeedbackByStatus([
      意见({ feedbackId: "f1", target: "s1", status: "已应用" }),
      意见({ feedbackId: "f2", target: "s1", status: "内核新状态" }),
      意见({ feedbackId: "f3", target: "s1", status: "已记录" }),
    ]);
    expect([...grouped.keys()]).toEqual(["已记录", "已应用", "其他"]);
    expect(grouped.get("其他")?.map((row) => row.feedbackId)).toEqual(["f2"]);
  });

  test("成果文件页每步一行预期成果，并标出是否已交付", () => {
    const plan = 计划({
      steps: [
        步骤({ stepId: "s1", title: "梳理需求", expectedArtifacts: "操作问题清单.md" }),
        步骤({ stepId: "s2", title: "确定方案", dependsOn: ["s1"] }),
      ],
    });
    const views = stepCardViews(plan, 控制({ nodes: [节点({ name: "s1", status: "delivered" })] }));
    const entries = stepOutputEntries(plan, views);
    expect(entries.map((entry) => [entry.stepId, entry.expected, entry.delivered])).toEqual([
      ["s1", "操作问题清单.md", true],
      ["s2", undefined, false],
    ]);
  });
});

test.describe("交给主控的现成指令", () => {
  test("修改步骤：只列真的改了的字段，并带当前定义版本", () => {
    const plan = 计划();
    const step = plan.steps[1]!;
    const text = modifyStepInstruction(plan, step, {
      title: "确定方案",
      dept: "写作",
      requirement: "换成写作负责",
      expectedArtifacts: step.expectedArtifacts ?? "",
    });
    expect(text).toContain("p-20261014-abc123");
    expect(text).toContain("定义版本 2");
    expect(text).toContain("第 2 步");
    expect(text).toContain("步骤 s2");
    expect(text).toContain("- 负责部门：写作");
    expect(text).toContain("- 任务要求：换成写作负责");
    expect(text).not.toContain("- 标题：");
    expect(text).not.toContain("- 预期成果：");
    expect(text).toContain("action=modify，expected_version=2");
  });

  test("撤销与存模板分别指向 pao_plan_update 与 pao_plan_save_template", () => {
    const plan = 计划();
    expect(undoInstruction(plan)).toContain("action=modify，expected_version=2");
    expect(saveTemplateInstruction(plan, "界面优化流程")).toContain(
      "pao_plan_save_template（definition_version=2）",
    );
    expect(saveTemplateInstruction(plan, "界面优化流程")).toContain("界面优化流程");
  });

  test("停卡指令：点名真实卡引用，并说清只停卡不改计划", () => {
    const plan = 计划();
    const step = plan.steps[1]!;
    const text = stopCardInstruction(plan, step, ["0002", "0003"]);
    expect(text).toContain("第 2 步");
    expect(text).toContain("步骤 s2");
    expect(text).toContain("0002、0003");
    expect(text).toContain("pao_change_status");
    expect(text).toContain("不要动计划定义");
  });

  test("意见指令：步骤带步骤 ID，文件带路径，流程不编步骤 ID", () => {
    const plan = 计划();
    const 步骤意见 = opinionInstruction(plan, { kind: "step", stepId: "s2" }, " 保留现有导航 ");
    expect(步骤意见).toContain("【第 2 步 · 确定方案】保留现有导航");
    expect(步骤意见).toContain("目标类型=步骤，步骤ID=s2");

    const 文件意见 = opinionInstruction(
      plan,
      { kind: "file", path: "成果/初稿.md" },
      "补上失败反馈",
    );
    expect(文件意见).toContain("目标类型=文件，路径=成果/初稿.md");

    const 流程意见 = opinionInstruction(plan, { kind: "flow" }, "整个过程保留验收结果");
    expect(流程意见).toContain("【整个流程】");
    // 整体意见是独立形态：走「目标类型=流程」，绝不写成空步骤 ID（空 ID 在内核侧就是无对象的孤儿）。
    expect(流程意见).toContain("目标类型=流程");
    expect(流程意见).not.toContain("步骤ID=");
  });

  test("讨论对象文案：流程、步骤、文件，以及找不到的步骤 ID 原样显示", () => {
    const plan = 计划();
    expect(scopeLabel({ kind: "flow" }, plan)).toBe("整个流程");
    expect(scopeLabel({ kind: "step", stepId: "s1" }, plan)).toBe("第 1 步 · 梳理需求");
    expect(scopeLabel({ kind: "step", stepId: "s9" }, plan)).toBe("s9");
    expect(scopeLabel({ kind: "file", path: "成果/初稿.md" }, plan)).toBe("成果/初稿.md");
  });
});

test.describe("预览锁定版本：同路径多轮次各算一版", () => {
  test("产物版本按轮次升序排列，同路径多轮次不被去重吞掉", () => {
    const progress = new Map<string, TemporaryPlanStepProgressRow>([
      [
        "s1",
        进度({
          stepId: "s1",
          artifacts: [
            产物({ round: 2, card: "卡0004", currentRound: true }),
            产物({ round: 1, card: "卡0001" }),
            产物({ path: "别的.md", relativePath: "别的.md", round: 1, card: "卡0002" }),
          ],
        }),
      ],
    ]);
    const versions = artifactVersions(progress, "成果/初稿.md");
    expect(versions.map((row) => row.round)).toEqual([1, 2]);
    expect(versions.map((row) => row.versionBasis)).toEqual(["第 1 轮（卡0001）", "第 2 轮（卡0004）"]);
  });

  test("钉住哪一轮就取哪一轮；没钉轮次取最新一版", () => {
    const versions = [产物({ round: 1, card: "卡0001" }), 产物({ round: 2, card: "卡0004" })];
    expect(pickArtifactVersion(versions, 1)?.round).toBe(1);
    expect(pickArtifactVersion(versions, 2)?.round).toBe(2);
    // 没钉轮次（从预期成果或文件意见进来）＝看最新一版。
    expect(pickArtifactVersion(versions, undefined)?.round).toBe(2);
    // 钉的那一轮已不在记录里：退回最新一版，由界面如实说明版本漂移。
    expect(pickArtifactVersion(versions, 9)?.round).toBe(2);
    expect(pickArtifactVersion([], 1)).toBeUndefined();
  });

  test("讨论对象文案带版本依据：同路径两轮能分辨，不再只显示裸路径", () => {
    expect(
      fileScopeLabel({ path: "成果/初稿.md", round: 2, versionBasis: "第 2 轮（卡0004）" }),
    ).toBe("成果/初稿.md（第 2 轮（卡0004））");
    expect(fileScopeLabel({ path: "成果/初稿.md", round: 2 })).toBe("成果/初稿.md（第 2 轮）");
    expect(fileScopeLabel({ path: "成果/初稿.md" })).toBe("成果/初稿.md");
    // 意见指令必须把版本钉死在那一轮上，否则新稿一出旧意见会被读成对新稿说的。
    const plan = 计划();
    const 文件意见 = opinionInstruction(
      plan,
      { kind: "file", path: "成果/初稿.md", round: 1, versionBasis: "第 1 轮（卡0001）" },
      "这一版结尾太急",
    );
    expect(文件意见).toContain("版本依据=第 1 轮（卡0001）");
    const 无版本依据 = opinionInstruction(
      plan,
      { kind: "file", path: "成果/初稿.md", round: 3 },
      "第三轮的意见",
    );
    expect(无版本依据).toContain("round=3");
  });
});

test.describe("摘要计数、筛选与下个待处理", () => {
  test("计数含筛选外步骤，各状态分别计数", () => {
    const control = 控制({
      nodes: [
        节点({ name: "s1", status: "delivered" }),
        节点({ name: "s2", status: "in_progress" }),
        节点({ name: "s3", status: "读取异常" }),
      ],
    });
    const counts = stepCardCounts(stepCardViews(计划(), control));
    expect(counts).toEqual({
      total: 3,
      done: 1,
      running: 1,
      review: 0,
      failed: 0,
      canceled: 0,
      pending: 0,
      waiting: 0,
      waitLead: 0,
      waitReview: 0,
      paused: 0,
      budget: 0,
      unreadable: 1,
      unknown: 0,
      // 未收尾＝完成与取消以外：s2 执行中 + s3 读取异常。
      open: 2,
    });
  });

  test("待办计数是复合位：总数含筛选外，未收尾不含完成与取消", () => {
    const control = 控制({
      nodes: [
        节点({ name: "s1", status: "delivered" }),
        节点({ name: "s2", status: "canceled" }),
        节点({ name: "s3", status: "in_progress" }),
      ],
    });
    const views = stepCardViews(计划(), control);
    expect(stepCardProgressCounts(views)).toEqual({ total: 3, done: 1, open: 1 });
    // 筛选只改显示，复合位的总数不看筛选结果（计划 §7.1：全局统计仍含筛选外步骤）。
    const filtered = filterStepCards(views, { states: ["running"] });
    expect(filtered).toHaveLength(1);
    expect(stepCardProgressCounts(views).total).toBe(3);
  });

  test("筛选按关键词与状态生效，空条件返回全部", () => {
    const control = 控制({
      nodes: [
        节点({ name: "s1", status: "delivered" }),
        节点({ name: "s2", status: "in_progress" }),
      ],
    });
    const views = stepCardViews(计划(), control);
    expect(filterStepCards(views, {}).length).toBe(3);
    expect(filterStepCards(views, { query: "确定" }).map((view) => view.step.stepId)).toEqual([
      "s2",
    ]);
    expect(filterStepCards(views, { query: "开发" }).length).toBe(3);
    expect(filterStepCards(views, { states: ["running"] }).map((view) => view.step.stepId)).toEqual(
      ["s2"],
    );
    expect(filterStepCards(views, { states: [] }).length).toBe(3);
  });

  test("下个待处理：当前这步自己待处理就留在它身上，否则按定义顺序往后绕圈找", () => {
    const control = 控制({ nodes: [节点({ name: "s1", status: "delivered" })] });
    const views = stepCardViews(计划(), control);
    expect(nextPendingStepId(views)).toBe("s2");
    // s2 自己就待处理（执行中）：留在 s2，不跳过它去找 s3。
    expect(nextPendingStepId(views, "s2")).toBe("s2");
    // s1 已完成：从 s1 往后找第一个待处理的是 s2。
    expect(nextPendingStepId(views, "s1")).toBe("s2");
    // s3 待处理：从 s3 之后绕圈，回到 s2。
    expect(nextPendingStepId(views, "s3")).toBe("s2");
    expect(
      nextPendingStepId(
        stepCardViews(
          计划(),
          控制({
            nodes: [
              节点({ name: "s1", status: "delivered" }),
              节点({ name: "s2", status: "delivered", confirmed: "2026-10-14 12:00" }),
              节点({ name: "s3", status: "delivered" }),
            ],
          }),
        ),
      ),
    ).toBeUndefined();
    // 等人工确认的步骤没完成，仍算「待处理」：确认门是下一件要管的事。
    expect(
      nextPendingStepId(
        stepCardViews(
          计划(),
          控制({
            nodes: [
              节点({ name: "s1", status: "delivered" }),
              节点({ name: "s2", status: "in_progress" }),
              节点({ name: "s3", status: "no_card" }),
            ],
          }),
          [进度({ stepId: "s2", needsConfirmation: true, awaitingConfirmation: true })],
        ),
      ),
    ).toBe("s2");
  });

  test("等待原因：具体等哪几步优先，说不出来才照抄内核", () => {
    const plan = 计划();
    const blocked = stepCardViews(plan, undefined)[2]!;
    expect(stepHoldText(plan, blocked)).toBe("等待第 2 步");

    const held = stepCardViews(
      plan,
      控制({ nodes: [节点({ name: "s3", status: "in_progress", hold: "等待部长回执" })] }),
    )[2]!;
    expect(stepHoldText(plan, held)).toBe("等待部长回执");

    // 等待态说得出具体前置时，用「等待第 N 步」，不照抄内核那句笼统的「等待前置节点」（计划 §5.1）。
    const generic = stepCardViews(
      plan,
      控制({ nodes: [节点({ name: "s3", status: "no_card", hold: "等待前置节点" })] }),
    )[2]!;
    expect(generic.state).toBe("waiting");
    expect(stepHoldText(plan, generic)).toBe("等待第 2 步");

    const started = stepCardViews(
      plan,
      控制({ nodes: [节点({ name: "s1", status: "delivered" })] }),
    )[0]!;
    expect(stepHoldText(plan, started)).toBeUndefined();
  });
});

test.describe("状态语义细分与未知不译成成功", () => {
  test("等前序/等部长/待审/预算不足/暂停各自有独立语义，不只靠颜色", () => {
    const plan = 计划({
      steps: [
        步骤({ stepId: "s1", title: "梳理需求" }),
        步骤({ stepId: "s2", title: "等部长" }),
        步骤({ stepId: "s3", title: "待审稿" }),
        步骤({ stepId: "s4", title: "预算卡住" }),
        步骤({ stepId: "s5", title: "被暂停" }),
      ],
    });
    const views = stepCardViews(
      plan,
      控制({
        nodes: [
          节点({ name: "s1", status: "no_card", hold: "等待前置节点" }),
          节点({ name: "s2", status: "in_progress", hold: "等待部长回执" }),
          节点({ name: "s3", status: "in_progress", hold: "等待判定（待审）" }),
          节点({ name: "s4", status: "in_progress", hold: "本轮预算不足，已停" }),
          节点({ name: "s5", status: "in_progress", hold: "人工暂停推进" }),
        ],
      }),
    );
    const byId = new Map(views.map((view) => [view.step.stepId, view]));
    expect(byId.get("s1")?.state).toBe("pending");
    expect(byId.get("s2")?.state).toBe("waitLead");
    expect(byId.get("s3")?.state).toBe("waitReview");
    expect(byId.get("s4")?.state).toBe("budget");
    expect(byId.get("s5")?.state).toBe("paused");
    // 五种状态两两不同：界面才能分别解释（计划 §7.1 第 3 条）。
    expect(new Set(["pending", "waitLead", "waitReview", "budget", "paused"]).size).toBe(5);
  });

  test("流级暂停原因让所有活节点都算暂停推进，而不只是写 hold 的那个", () => {
    const views = stepCardViews(
      计划(),
      控制({
        pauseReason: "现场核查后暂停",
        nodes: [节点({ name: "s1", status: "in_progress" })],
      }),
    );
    expect(views[0]?.state).toBe("paused");
  });

  test("每个状态都有独立图标与文案：未知不等于成功，图标也各不相同", () => {
    const states = Object.keys(STEP_CARD_STATE_LABELS) as (keyof typeof STEP_CARD_STATE_LABELS)[];
    // 状态不只靠颜色：每个状态都要有可读标识。
    for (const state of states) {
      expect(STEP_CARD_STATE_ICONS[state]).toBeTruthy();
      expect(STEP_CARD_STATE_LABELS[state]).toBeTruthy();
    }
    // 未知与成功必须给出不同的文案与不同信号。
    expect(STEP_CARD_STATE_LABELS.unknown).not.toBe(STEP_CARD_STATE_LABELS.done);
    expect(STEP_CARD_STATE_ICONS.unknown).not.toBe(STEP_CARD_STATE_ICONS.done);
    expect(STEP_CARD_STATE_LABELS.unreadable).not.toBe(STEP_CARD_STATE_LABELS.done);
  });

  test("内核给了桌面认不出的状态值：判成 unknown，不当成功也不当失败", () => {
    const views = stepCardViews(
      计划(),
      控制({ nodes: [节点({ name: "s1", status: "内核新状态值" })] }),
    );
    expect(views[0]?.state).toBe("unknown");
    expect(views[0]?.delivered).toBe(false);
    expect(completedStepCount(views)).toBe(0);
    // 未知状态算「要人看一眼」，不算已收尾。
    expect(needsAttentionState("unknown")).toBe(true);
  });

  test("进度行报读不出来的原因：这一步判成读取异常并带出原因，正常节点继续可读", () => {
    const views = stepCardViews(
      计划(),
      控制({
        nodes: [
          节点({ name: "s1", status: "delivered" }),
          节点({ name: "s2", status: "in_progress" }),
        ],
      }),
      [进度({ stepId: "s2", readProblem: "卡文件被锁" })],
    );
    expect(views[0]?.state).toBe("done");
    expect(views[1]?.state).toBe("unreadable");
    expect(views[1]?.progress?.readProblem).toBe("卡文件被锁");
  });

  test("结果不写默认值：没有控制正本时读不出状态，界面拿到的是 undefined 而不是编出来的值", () => {
    const views = stepCardViews(计划(), undefined);
    expect(views.every((view) => view.node === undefined)).toBe(true);
    // 没有实例不等于读取异常：按定义顺序判未开始/等前序。
    expect(views.map((view) => view.state)).toEqual(["pending", "waiting", "waiting"]);
    // 没有轮次、没有等待原因就不给字段，界面不能显示假轮次。
    expect(views[0]?.round).toBeUndefined();
    expect(views[0]?.holdReason).toBeUndefined();
    expect(stepRoundText(views[0]!)).toBeUndefined();
  });

  test("等人工门的前序要单独报：前序活干完了、等的是人", () => {
    const plan = 计划();
    const views = stepCardViews(
      plan,
      控制({ nodes: [节点({ name: "s2", status: "delivered" })] }),
      [进度({ stepId: "s2", needsConfirmation: true, awaitingConfirmation: true })],
    );
    const s3 = views[2]!;
    expect(s3.state).toBe("waiting");
    // s2 卡在人工门上，s3 等的是「人放行」，不是「活没干完」。
    expect(s3.gateWaitingOn).toEqual(["s2"]);
  });

  test("取消掉的前序不再挡路，也不进等待名单", () => {
    const plan = 计划({
      steps: [
        步骤({ stepId: "s1", title: "梳理需求" }),
        步骤({ stepId: "s2", title: "被取消", dependsOn: ["s1"] }),
        步骤({ stepId: "s3", title: "下游", dependsOn: ["s2"] }),
      ],
    });
    const views = stepCardViews(
      plan,
      控制({
        nodes: [
          节点({ name: "s1", status: "delivered" }),
          节点({ name: "s2", status: "canceled" }),
        ],
      }),
    );
    expect(views[2]?.waitingOn).toEqual([]);
  });
});

test.describe("多卡与每轮执行信息", () => {
  test("多卡汇总全部卡并可逐一取用，不能取首卡代表完成", () => {
    const views = stepCardViews(
      计划(),
      控制({ nodes: [节点({ name: "s1", status: "in_progress" })] }),
      [进度({ stepId: "s1", cards: ["卡0001", "卡0002", "卡0003"] })],
    );
    const refs = stepCardRefs(views[0]!);
    expect(refs.cards).toEqual(["卡0001", "卡0002", "卡0003"]);
    expect(refs.hasCards).toBe(true);
  });

  test("零卡审查：没有卡时如实说没卡，不拿别的卡顶上", () => {
    const views = stepCardViews(
      计划(),
      控制({ nodes: [节点({ name: "s1", status: "in_progress" })] }),
      [进度({ stepId: "s1", cards: [] })],
    );
    expect(stepCardRefs(views[0]!)).toEqual({ cards: [], hasCards: false });
  });

  test("每轮执行信息按轮次升序，带卡与判定原文；没有记录就不编轮次", () => {
    const views = stepCardViews(
      计划(),
      控制({ nodes: [节点({ name: "s1", status: "in_progress", round: 3 })] }),
      [
        进度({
          stepId: "s1",
          round: 3,
          records: [
            { round: 3, cards: ["卡0005"], verdict: "通过" },
            { round: 1, cards: ["卡0001"], verdict: "打回", reason: "结尾太急" },
          ],
        }),
      ],
    );
    expect(views[0]?.round).toBe(3);
    expect(stepRoundText(views[0]!)).toBe("第 3 轮");
    const rounds = stepRoundExecutions(views[0]?.progress);
    expect(rounds.map((row) => row.round)).toEqual([1, 3]);
    expect(rounds[0]?.reason).toBe("结尾太急");
    expect(rounds[1]?.cards).toEqual(["卡0005"]);
    // 没有进度行就没有执行记录，不补一条假轮次。
    expect(stepRoundExecutions(undefined)).toEqual([]);
  });

  test("没有任何判定的轮次不补『通过』：verdict 缺省就是缺省", () => {
    const rounds = stepRoundExecutions(
      进度({ stepId: "s1", records: [{ round: 2, cards: [] }] }),
    );
    expect(rounds[0]?.verdict).toBeUndefined();
    expect(rounds[0]?.reason).toBeUndefined();
  });
});

test.describe("显式并行分组", () => {
  test("同组只读、不同部门、同前置才算并行；单步自成一组", () => {
    const plan = 计划({
      steps: [
        步骤({ stepId: "s1", title: "前置" }),
        步骤({
          stepId: "s2",
          title: "只读 A",
          dept: "开发",
          dependsOn: ["s1"],
          readOnly: true,
        }),
        步骤({
          stepId: "s3",
          title: "只读 B",
          dept: "设计",
          dependsOn: ["s1"],
          readOnly: true,
        }),
        步骤({ stepId: "s4", title: "写任务", dept: "写作", dependsOn: ["s1"] }),
      ],
    });
    const groups = parallelStepGroups(plan);
    const 并行组 = groups.find((group) => group.parallel);
    expect(并行组?.stepIds).toEqual(["s2", "s3"]);
    expect(并行组?.sharedDependency).toBe("s1");
    // 写任务不进并行组：写任务/同部门要排队。
    expect(stepParallelGroup(groups, "s4")?.parallel).toBe(false);
    expect(stepParallelGroup(groups, "s1")?.stepIds).toEqual(["s1"]);
  });

  test("同部门的只读任务不算并行（内核按部门串行）", () => {
    const plan = 计划({
      steps: [
        步骤({ stepId: "s1", title: "前置" }),
        步骤({ stepId: "s2", title: "A", dept: "开发", dependsOn: ["s1"], readOnly: true }),
        步骤({ stepId: "s3", title: "B", dept: "开发", dependsOn: ["s1"], readOnly: true }),
      ],
    });
    expect(parallelStepGroups(plan).every((group) => !group.parallel)).toBe(true);
  });

  test("有人工门的步骤不进并行组（门没放行就谈不上一起开工）", () => {
    const plan = 计划({
      steps: [
        步骤({ stepId: "s1", title: "前置" }),
        步骤({
          stepId: "s2",
          title: "A",
          dept: "开发",
          dependsOn: ["s1"],
          readOnly: true,
          humanGate: true,
        }),
        步骤({ stepId: "s3", title: "B", dept: "设计", dependsOn: ["s1"], readOnly: true }),
      ],
    });
    expect(parallelStepGroups(plan).every((group) => !group.parallel)).toBe(true);
  });

  test("不在任何组里的步骤 ID：返回 undefined，界面按单卡处理，不编分组", () => {
    expect(stepParallelGroup(parallelStepGroups(计划()), "不存在")).toBeUndefined();
  });
});

test.describe("待办派生（含待确认、缺输入、失败、未送达、恢复）", () => {
  test("待确认/缺输入/失败/未送达/恢复五类都能从真值派生出来，并绑定实例/步骤/轮次/版本", () => {
    const plan = 计划({
      feedback: [
        意见({
          feedbackId: "f1",
          target: "成果/初稿.md",
          targetKind: "文件",
          status: "投递失败",
          detail: "部长会话已停止",
          stepId: "s1",
          round: 1,
        }),
      ],
    });
    const control = 控制({
      nodes: [
        节点({ name: "s1", status: "in_progress", hold: "本轮预算不足" }),
        节点({ name: "s2", status: "in_progress", hold: "等待部长回执" }),
        节点({ name: "s3", status: "failed" }),
      ],
    });
    const views = stepCardViews(
      plan,
      control,
      [
        进度({ stepId: "s2", needsConfirmation: true, awaitingConfirmation: true, round: 2 }),
        进度({ stepId: "s3", readProblem: "卡目录不存在", round: 1 }),
      ],
    );
    const todos = deriveTodos({ plan, control, views });
    const kinds = todos.map((todo) => todo.kind);
    // 待确认（s2）、缺输入（s3）、需要处理（s1 预算不足 + s3 失败）、未送达（f1）。
    expect(kinds).toContain("confirm");
    expect(kinds).toContain("missing_input");
    expect(kinds).toContain("failed");
    expect(kinds).toContain("undelivered");
    expect(kinds).not.toContain("recovery");

    const confirm = todos.find((todo) => todo.kind === "confirm")!;
    expect(confirm.identity).toEqual({
      instanceId: "i-1",
      stepId: "s2",
      round: 2,
      definitionVersion: 2,
    });
    expect(confirm.planId).toBe("p-20261014-abc123");
    expect(confirm.stepTitle).toBe("确定方案");
    expect(confirm.label).toBe("待你确认");
    // 非颜色记号是「形状」：有，且不是可读英文词（否则会与中文 label 混排成两种写法）。
    expect(confirm.icon).toBe("[check]");

    const undelivered = todos.find((todo) => todo.kind === "undelivered")!;
    expect(undelivered.reason).toBe("部长会话已停止");
    // 未送达的待办身份用意见自己带的定义版本，不用当前版本顶替。
    expect(undelivered.identity.definitionVersion).toBe(1);
    expect(undelivered.identity.stepId).toBe("s1");
    // 未送达只给中文 label，不给记号：记号若是 `[unsent]`，中文界面会渲染成
    // 「`[unsent]` 未送达」两种写法（这是真实发生过的混排回归）。
    expect(undelivered.label).toBe("未送达");
    expect(undelivered.icon).toBeUndefined();

    const missing = todos.find((todo) => todo.kind === "missing_input")!;
    expect(missing.reason).toBe("卡目录不存在");
  });

  test("没有控制正本或计划被撤销：派生恢复类待办，不假装一切正常", () => {
    const plan = 计划();
    const 无实例 = deriveTodos({ plan, control: undefined, views: stepCardViews(plan, undefined) });
    expect(无实例.map((todo) => todo.kind)).toEqual(["recovery"]);
    expect(无实例[0]?.stepTitle).toBeUndefined();

    const control = 控制();
    const 已撤销 = deriveTodos({
      plan: 计划({ undone: true }),
      control,
      views: stepCardViews(计划({ undone: true }), control),
    });
    expect(已撤销.map((todo) => todo.kind)).toEqual(["recovery"]);
    expect(已撤销[0]?.reason).toBe("这份计划已被撤销");
  });

  test("待办稳定键：同一视图条件下的同一条待办键一致；多视图同一待办只生效一次", () => {
    const plan = 计划();
    const control = 控制({ nodes: [节点({ name: "s2", status: "in_progress" })] });
    const views = stepCardViews(
      plan,
      control,
      [进度({ stepId: "s2", needsConfirmation: true, awaitingConfirmation: true, round: 1 })],
    );
    const a = deriveTodos({ plan, control, views });
    const b = deriveTodos({ plan, control, views });
    expect(a.map((todo) => todo.key)).toEqual(b.map((todo) => todo.key));
    expect(new Set(a.map((todo) => todo.key)).size).toBe(a.length);

    // 键里带轮次与版本：下一轮的待办与这一轮的键不同，因此不会被当成同一条重复处理。
    expect(
      todoKey("confirm", { instanceId: "i-1", stepId: "s2", round: 1, definitionVersion: 2 }),
    ).not.toBe(
      todoKey("confirm", { instanceId: "i-1", stepId: "s2", round: 2, definitionVersion: 2 }),
    );
  });

  test("旧提醒不推进新轮次：轮次/版本对不上就是过期，且说过期原因", () => {
    const plan = 计划();
    const control = 控制({ nodes: [节点({ name: "s2", status: "in_progress", round: 2 })] });
    const views = stepCardViews(
      plan,
      control,
      [进度({ stepId: "s2", needsConfirmation: true, awaitingConfirmation: true, round: 2 })],
    );
    const todo = deriveTodos({ plan, control, views })[0]!;
    expect(isTodoStale(todo, { instanceId: "i-1", round: 2, definitionVersion: 2 })).toBe(false);
    // 轮次翻篇：旧提醒不能拿去推进新轮次。
    expect(isTodoStale(todo, { instanceId: "i-1", round: 3, definitionVersion: 2 })).toBe(true);
    expect(
      staleTodoText(todo, { round: 3, definitionVersion: 2 }),
    ).toContain("第 2 轮");
    // 定义改过：同样过期。
    expect(isTodoStale(todo, { instanceId: "i-1", round: 2, definitionVersion: 3 })).toBe(true);
    expect(staleTodoText(todo, { round: 2, definitionVersion: 3 })).toContain("版定义");
    // 不同实例的待办绝不互相顶替。
    expect(isTodoStale(todo, { instanceId: "i-2", round: 2, definitionVersion: 2 })).toBe(true);
    // 当前信息里没有轮次时不做轮次判定，避免把好待办误杀。
    expect(isTodoStale(todo, { instanceId: "i-1", definitionVersion: 2 })).toBe(false);
  });

  test("待办按步骤定义顺序稳定排序，恢复类排最前", () => {
    const plan = 计划();
    const control = 控制({
      nodes: [
        节点({ name: "s1", status: "failed" }),
        节点({ name: "s2", status: "in_progress" }),
        节点({ name: "s3", status: "failed" }),
      ],
    });
    const views = stepCardViews(
      plan,
      control,
      [进度({ stepId: "s2", needsConfirmation: true, awaitingConfirmation: true })],
    );
    expect(deriveTodos({ plan, control, views }).map((todo) => todo.identity.stepId)).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
  });

  test("坏数据不补默认值：没有状态的步骤派生不出任何待办，不编一条假的", () => {
    const plan = 计划({ steps: [步骤({ stepId: "s1", title: "正常" })] });
    const control = 控制({ nodes: [] });
    const views = stepCardViews(plan, control);
    expect(deriveTodos({ plan, control, views })).toEqual([]);
  });

  test("待办记号只放形状不放可读英文词：未送达不给记号，其余四种各给一个形状", () => {
    // 回归护栏：`undelivered` 曾导出 `[unsent]`，与中文 label「未送达」并排渲染成
    // 「`[unsent]` 未送达」两种写法。模型层不该替视图决定展示形状，只放形状不放能读的词。
    expect(TODO_KIND_LABELS.undelivered).toBe("未送达");
    expect(TODO_KIND_ICONS.undelivered).toBeUndefined();
    for (const kind of ["confirm", "missing_input", "failed", "recovery"] as const) {
      const icon = TODO_KIND_ICONS[kind];
      expect(icon).toBeTruthy();
      // 形状不是中文 label 的英文对译：断言它不与 label 同义（拿不到 label 的英文写法，
      // 就用「label 全中文、icon 不含中文」这一条可核事实把两者区分开）。
      expect(icon).not.toBe(TODO_KIND_LABELS[kind]);
      expect(/[\u4e00-\u9fa5]/.test(icon!)).toBe(false);
    }
  });
});

test.describe("版本感知文案与草稿身份键", () => {
  test("草稿身份键按对象与定义版本区分：换对象/换版本不串草稿", () => {
    const 基线 = draftKey({
      planId: "p-1",
      scope: { kind: "step", stepId: "s2" },
      definitionVersion: 2,
      purpose: "opinion",
    });
    expect(
      draftKey({
        planId: "p-1",
        scope: { kind: "step", stepId: "s2" },
        definitionVersion: 2,
        purpose: "opinion",
      }),
    ).toBe(基线);
    // 换步骤、换计划、换版本、换用途，都必须是另一份草稿。
    expect(
      draftKey({
        planId: "p-1",
        scope: { kind: "step", stepId: "s3" },
        definitionVersion: 2,
        purpose: "opinion",
      }),
    ).not.toBe(基线);
    expect(
      draftKey({
        planId: "p-2",
        scope: { kind: "step", stepId: "s2" },
        definitionVersion: 2,
        purpose: "opinion",
      }),
    ).not.toBe(基线);
    expect(
      draftKey({
        planId: "p-1",
        scope: { kind: "step", stepId: "s2" },
        definitionVersion: 3,
        purpose: "opinion",
      }),
    ).not.toBe(基线);
    // 同一对象上的「意见」与「改步骤」是两份草稿，不能互相顶掉。
    expect(
      draftKey({
        planId: "p-1",
        scope: { kind: "step", stepId: "s2" },
        definitionVersion: 2,
        purpose: "step_edit",
      }),
    ).not.toBe(基线);
    // 文件对象按路径＋轮次区分：第 1 轮的意见不会被读成对第 2 轮说的。
    expect(
      draftKey({
        planId: "p-1",
        scope: { kind: "file", path: "成果/初稿.md", round: 1 },
        definitionVersion: 2,
        purpose: "opinion",
      }),
    ).not.toBe(
      draftKey({
        planId: "p-1",
        scope: { kind: "file", path: "成果/初稿.md", round: 2 },
        definitionVersion: 2,
        purpose: "opinion",
      }),
    );
  });

  test("同对象外部修改：保留草稿并提示版本冲突，不能静默覆盖", () => {
    const plan = 计划();
    const draft = {
      key: "draft-1",
      text: "把结尾改一下",
      definitionVersion: 1,
      round: 1,
    };
    const 冲突 = detectDraftConflict(draft, {
      plan,
      scope: { kind: "step", stepId: "s2" },
      round: 1,
    });
    expect(冲突.kind).toBe("definition_changed");
    expect(冲突.message).toContain("第 1 版定义");
    expect(冲突.currentValue).toBe("第 2 版定义");
    // 有冲突就不许静默提交。
    expect(canSubmitDraft(冲突)).toBe(false);
  });

  test("轮次变了也算冲突：旧稿草稿不能贴到新稿上", () => {
    const plan = 计划();
    const 冲突 = detectDraftConflict(
      { key: "d", text: "意见", definitionVersion: 2, round: 1 },
      { plan, scope: { kind: "file", path: "成果/初稿.md" }, round: 2 },
    );
    expect(冲突.kind).toBe("round_changed");
    expect(冲突.message).toContain("第 1 轮");
    expect(冲突.message).toContain("第 2 轮");
  });

  test("对象没了单独报：草稿挂的步骤/文件已不在计划里", () => {
    const plan = 计划();
    expect(
      detectDraftConflict(
        { key: "d", text: "意见", definitionVersion: 2 },
        { plan, scope: { kind: "step", stepId: "s9" } },
      ).kind,
    ).toBe("object_gone");
    // 流程对象永远在，不会因为改定义就判成消失。
    expect(
      detectDraftConflict(
        { key: "d", text: "整体意见", definitionVersion: 2 },
        { plan, scope: { kind: "flow" } },
      ).kind,
    ).toBe("none");
  });

  test("版本一致时允许提交；判不出冲突不给假冲突", () => {
    const plan = 计划();
    const 无冲突 = detectDraftConflict(
      { key: "d", text: "意见", definitionVersion: 2 },
      { plan, scope: { kind: "step", stepId: "s1" } },
    );
    expect(无冲突).toEqual({ kind: "none" });
    expect(canSubmitDraft(无冲突)).toBe(true);
    // 草稿没记轮次：不做轮次比较，不拦住正常提交。
    expect(
      detectDraftConflict(
        { key: "d", text: "意见", definitionVersion: 2 },
        { plan, scope: { kind: "file", path: "成果/初稿.md" }, round: 5 },
      ).kind,
    ).toBe("none");
  });

  test("文件草稿的对象是否存在按内核记录的路径核，不按标题猜", () => {
    const plan = 计划({
      feedback: [意见({ feedbackId: "f1", target: "成果/初稿.md", targetKind: "文件" })],
    });
    expect(
      detectDraftConflict(
        { key: "d", text: "意见", definitionVersion: 2, round: 1 },
        { plan, scope: { kind: "file", path: "成果/初稿.md", round: 1 }, round: 1 },
      ).kind,
    ).toBe("none");
    // 内核没记录过这个路径：不是「对象还在」。
    expect(
      detectDraftConflict(
        { key: "d", text: "意见", definitionVersion: 2 },
        { plan, scope: { kind: "file", path: "成果/别的.md" } },
      ).kind,
    ).toBe("object_gone");
  });

  test("耗时只认卡面 created→completed，算不出就说清原因，不写 0", () => {
    // 有卡且两端都记得：按分钟算秒数（与内核 metricsDurationSeconds 同口径）。
    expect(stepDuration({ created: "2026-10-16 09:05", completed: "2026-10-16 09:20" })).toEqual({
      kind: "measured",
      seconds: 900,
      created: "2026-10-16 09:05",
      finished: "2026-10-16 09:20",
    });
    // 没卡：不能拿会话时长或轮次顶上。
    expect(stepDuration(undefined)).toEqual({ kind: "no_card" });
    // 有卡没完成时间：如实说未记录，不能写 0 秒。
    expect(stepDuration({ created: "2026-10-16 09:05" })).toEqual({
      kind: "unrecorded",
      reason: "卡面没有记录完成时间（还没交付或交付时未写）",
    });
    // 时间读不懂：同样不编。
    expect(stepDuration({ created: "2026/10/16", completed: "2026-10-16 09:20" }).kind).toBe(
      "unrecorded",
    );
    // 时钟回拨：不做负数（与内核一致收在 0）。
    expect(stepDuration({ created: "2026-10-16 09:20", completed: "2026-10-16 09:05" })).toMatchObject(
      { kind: "measured", seconds: 0 },
    );
  });

  test("耗时文案覆盖秒/分/小时，并且不把「未记录」说成 0", () => {
    expect(stepDurationText({ kind: "no_card" })).toBe("暂无卡，没有耗时可算");
    expect(stepDurationText({ kind: "unrecorded", reason: "卡面没有记录完成时间（还没交付或交付时未写）" })).toBe(
      "未记录：卡面没有记录完成时间（还没交付或交付时未写）",
    );
    expect(stepDurationText({ kind: "measured", seconds: 45, created: "a", finished: "b" })).toBe("45 秒");
    expect(stepDurationText({ kind: "measured", seconds: 900, created: "a", finished: "b" })).toBe("15 分钟");
    expect(
      stepDurationText({ kind: "measured", seconds: 5400, created: "a", finished: "b" }),
    ).toBe("1 小时 30 分钟");
  });
});
