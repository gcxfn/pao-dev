import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createKanbanCardOps } from "../../electron/platform/pao/kanban-ops";
import type { PaoCardOpsModule } from "@pi-gui/pi-sdk-driver";

/**
 * 看板卡操作桥单测（隔离临时目录，不碰真实 PAO_HOME）：
 * 桥只代「用户」执行取消；内核 statemachine（迁移白名单＋单写者）是唯一权限判据，
 * 桥不预判业务，只做路径安全（项目内＋文件名与卡号一致）与错误如实透传。
 */

async function makeCardWorkspace(): Promise<{ root: string; cardPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "kanban-ops-"));
  const cardsDir = join(root, ".pao", "卡");
  mkdirSync(cardsDir, { recursive: true });
  const cardPath = join(cardsDir, "卡0002-乙卡.md");
  writeFileSync(
    cardPath,
    [
      "---",
      "目标: 乙卡",
      "部门: 工程",
      "验收: 检查",
      "状态: 进行中",
      "owner: 会话甲",
      "尝试: 1",
      "创建: 2026-10-05 09:00",
      "---",
      "正文",
      "",
    ].join("\n"),
  );
  return { root: realpathSync(root), cardPath: realpathSync(cardPath) };
}

/** 内核卡模块假身：记录 changeCardStatus 收到的参数，按需抛错模拟内核拒绝。 */
function fakeCardModule(
  options: {
    onChange?: (card: unknown, input: unknown) => unknown;
    onRead?: (path: string) => unknown;
  } = {},
): PaoCardOpsModule {
  return {
    readCard: (path: string) => {
      if (options.onRead) return options.onRead(path) as never;
      return { path, card_no: 2, frontmatter: { status: "in_progress" } } as never;
    },
    changeCardStatus: (card: never, input: never) => {
      if (options.onChange) return options.onChange(card, input) as never;
      return { path: (card as { path: string }).path } as never;
    },
  };
}

test("取消走内核 changeCardStatus：操作者恒为用户，卡路径经工作区复核后传入", async () => {
  const { root, cardPath } = await makeCardWorkspace();
  const seen: { card: unknown; input: unknown }[] = [];
  const ops = createKanbanCardOps({
    loadModule: async () =>
      fakeCardModule({
        onChange: (card, input) => {
          seen.push({ card, input });
          return { path: (card as { path: string }).path, frontmatter: { status: "canceled" } };
        },
      }),
  });
  const result = await ops.run(root, {
    workspaceId: "ws",
    cardPath,
    cardNumber: 2,
    action: "取消",
    reason: "看板取消",
  });
  expect(result.ok).toBe(true);
  expect(seen).toHaveLength(1);
  const input = seen[0]?.input as Record<string, unknown>;
  expect(input.操作者).toBe("用户");
  expect(input.to).toBe("canceled");
  expect(input.依据).toBe("看板取消");
  expect(typeof input.时间).toBe("string");
});

test("非法迁移（已交付→取消）如实失败：内核错误原文透传，不整批报成功", async () => {
  const { root, cardPath } = await makeCardWorkspace();
  const ops = createKanbanCardOps({
    loadModule: async () =>
      fakeCardModule({
        onRead: () => {
          throw new Error("不允许的状态迁移：已交付 → 取消");
        },
      }),
  });
  const result = await ops.run(root, {
    workspaceId: "ws",
    cardPath,
    cardNumber: 2,
    action: "取消",
  });
  expect(result.ok).toBe(false);
  expect(result.message).toContain("不允许的状态迁移");
});

test("路径安全：越出工作区、文件名卡号与卡号不一致、文件缺失一律拒绝且不触内核", async () => {
  const { root, cardPath } = await makeCardWorkspace();
  let kernelTouched = false;
  const ops = createKanbanCardOps({
    loadModule: async () =>
      fakeCardModule({
        onChange: () => {
          kernelTouched = true;
          return {};
        },
      }),
  });
  const outside = await ops.run(root, {
    workspaceId: "ws",
    cardPath: join(root, "..", "逃逸.md"),
    cardNumber: 2,
    action: "取消",
  });
  expect(outside.ok).toBe(false);

  const mismatch = await ops.run(root, {
    workspaceId: "ws",
    cardPath,
    cardNumber: 3,
    action: "取消",
  });
  expect(mismatch.ok).toBe(false);
  expect(mismatch.message).toContain("卡号");

  const missing = await ops.run(root, {
    workspaceId: "ws",
    cardPath: join(root, ".pao", "卡", "卡0009-没有.md"),
    cardNumber: 9,
    action: "取消",
  });
  expect(missing.ok).toBe(false);
  expect(kernelTouched).toBe(false);
});
