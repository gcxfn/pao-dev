import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createCard } from "../../src/pao/cards/cardfile.ts";
import { bindExecutionContext, resolveExecutionContext } from "../../src/pao/cards/execution-context.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import { createSingleRootWorktreeHost } from "../../src/pao/worktrees/types.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
	const parent = process.env.PAO_HOME;
	if (!parent || !isAbsolute(parent)) throw new Error("测试须显式设置隔离 PAO_HOME");
	mkdirSync(parent, { recursive: true });
	const root = mkdtempSync(join(parent, "primary-context-"));
	roots.push(root);
	const projectRoot = join(root, "project");
	mkdirSync(projectRoot);
	const cardsDir = join(root, "records", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const card = await createCard(cardsDir, {
		目标: "普通目录任务",
		部门: "测试",
		验收: "完成",
		创建: "2026-10-30 01:00",
	});
	changeCardStatus(card, { 操作者: "测试", to: "in_progress", 时间: "2026-10-30 01:01" });
	const worktree = await createSingleRootWorktreeHost(projectRoot).resolveForDispatch({
		requestId: "primary-context-test",
		projectRoot,
		target: { kind: "primary" },
	});
	const binding = await bindExecutionContext(
		{
			key: { cardsDir, cardNo: card.card_no, attempt: 1 },
			projectRoot,
			repositoryRoot: projectRoot,
			executionRoot: projectRoot,
			worktree,
			snapshotRef: join(root, "snapshot.json"),
			snapshotDigest: `sha256:${"a".repeat(64)}`,
		},
		{ expectedCurrentAttempt: 1 },
	);
	return { root, projectRoot, binding };
}

it("普通非 Git 目录可按当前 attempt 核验原生 primary 执行绑定", async () => {
	const f = await fixture();
	expect(f.binding.worktree.commonGitDir).toBe("");
	const live = await resolveExecutionContext(f.binding.key, {
		expectedCurrentAttempt: 1,
		requireLiveExecutionRoot: true,
	});
	expect(live.canonicalExecutionRoot).toBe(realpathSync.native(f.projectRoot));
	expect(live.bindingDigest).toBe(f.binding.bindingDigest);
});

it("普通执行目录被替换为文件后不能沿用原绑定", async () => {
	const f = await fixture();
	// 卡和绑定位于独立证据目录，只替换执行根，避免缺卡错误遮蔽现场核验。
	const moved = join(f.root, "moved");
	renameSync(f.projectRoot, moved);
	writeFileSync(f.projectRoot, "已替换为文件");
	await expect(
		resolveExecutionContext(f.binding.key, {
			expectedCurrentAttempt: 1,
			requireLiveExecutionRoot: true,
		}),
	).rejects.toThrow("普通执行根已被替换或不是目录");
});
