import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCard } from "../../src/pao/cards/cardfile.ts";
import {
	bindExecutionContext,
	ExecutionContextError,
	type ExecutionKey,
	executionContextPath,
	resolveExecutionContext,
} from "../../src/pao/cards/execution-context.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "pao-execution-context-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		encoding: "utf8",
	}).trim();
}

async function fixture() {
	const root = tempDir();
	const sharedRoot = join(root, "shared");
	mkdirSync(sharedRoot);
	const execution = join(root, "repo");
	mkdirSync(execution);
	writeFileSync(join(execution, "file.txt"), "v1\n");
	git(execution, ["init"]);
	git(execution, ["add", "-A"]);
	git(execution, ["commit", "--no-gpg-sign", "-m", "base"]);
	const cardsDir = join(sharedRoot, ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const card = await createCard(cardsDir, {
		目标: "执行上下文",
		部门: "测试",
		验收: "存在: file.txt",
		创建: "2026-10-20 20:00",
	});
	changeCardStatus(card, { 操作者: "E", to: "in_progress", 时间: "2026-10-20 20:01" });
	const head = git(execution, ["rev-parse", "HEAD"]);
	const commonGitDir = git(execution, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const branchName = git(execution, ["branch", "--show-current"]);
	return { root, sharedRoot, execution, cardsDir, card, head, commonGitDir, branchName };
}

function input(f: Awaited<ReturnType<typeof fixture>>) {
	return {
		key: { cardsDir: f.cardsDir, cardNo: f.card.card_no, attempt: 1 },
		projectRoot: f.sharedRoot,
		repositoryRoot: f.execution,
		executionRoot: f.execution,
		worktree: {
			kind: "primary" as const,
			taskRoot: f.sharedRoot,
			executionRoot: f.execution,
			commonGitDir: f.commonGitDir,
			inputVersion: f.head,
			bindingDigest: "host:primary:1",
		},
		snapshotRef: "pao://brief/snap-1",
		snapshotDigest: `sha256:${"a".repeat(64)}`,
		briefRef: `pao-brief://snap-1?digest=sha256:${"b".repeat(64)}`,
	};
}

describe("execution-context 持久关联", () => {
	it("回执相对产物使用对应尝试的执行根，损坏绑定不回退到共享目录", async () => {
		const f = await fixture();
		const key = input(f).key;
		await bindExecutionContext(input(f), { expectedCurrentAttempt: 1 });
		const receipt = { 尝试号: 1, 时间: "2026-10-21 10:00", 结果: "success", 产物路径: ["file.txt"] };
		expect(appendReceipt(f.card, receipt)).toMatchObject({ kind: "已记录" });
		expect(f.card.receipts[0].artifact_path).toEqual(["file.txt"]);
		const saved = JSON.parse(readFileSync(executionContextPath(key), "utf8"));
		saved.executionRoot = f.sharedRoot;
		writeFileSync(executionContextPath(key), JSON.stringify(saved));
		writeFileSync(join(f.sharedRoot, "file.txt"), "不能借共享目录文件掩盖坏绑定");
		expect(() => appendReceipt(f.card, receipt)).toThrow(ExecutionContextError);
	});

	it("旧尝试回执仍按旧执行根验产物，不借当前主目录的同名文件放行", async () => {
		const f = await fixture();
		await bindExecutionContext(input(f), { expectedCurrentAttempt: 1 });
		changeCardStatus(f.card, { 操作者: "E", to: "failed", 失败类型: "transient", 时间: "2026-10-21 10:00" });
		changeCardStatus(f.card, { 操作者: "E", to: "unclaimed", 时间: "2026-10-21 10:01" });
		changeCardStatus(f.card, { 操作者: "E", to: "in_progress", 时间: "2026-10-21 10:02" });
		const receipt = { 尝试号: 1, 时间: "2026-10-21 10:00", 结果: "success", 产物路径: ["file.txt"] };
		expect(appendReceipt(f.card, receipt)).toMatchObject({ kind: "旧尝试留档" });
		rmSync(join(f.execution, "file.txt"));
		writeFileSync(join(f.sharedRoot, "file.txt"), "新目录同名产物");
		expect(() => appendReceipt(f.card, receipt)).toThrow("回执产物路径不存在");
	});

	it("一次性写入、同内容幂等、摘要重算与固定路径", async () => {
		const f = await fixture();
		const first = await bindExecutionContext(input(f), { expectedCurrentAttempt: 1 });
		const second = await bindExecutionContext(input(f), { expectedCurrentAttempt: 1 });

		expect(second).toEqual(first);
		expect(first.bindingDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(executionContextPath(first.key)).toBe(
			join(f.sharedRoot, ".pao", "execution-contexts", "card-0001-attempt-1.json"),
		);
		expect(JSON.parse(readFileSync(executionContextPath(first.key), "utf8"))).toEqual(first);
	});

	it("同 attempt 不同宿主证明返回 BINDING_CONFLICT，绝不覆盖首条", async () => {
		const f = await fixture();
		await bindExecutionContext(input(f), { expectedCurrentAttempt: 1 });
		const changed = input(f);
		changed.snapshotDigest = `sha256:${"c".repeat(64)}`;

		await expect(bindExecutionContext(changed, { expectedCurrentAttempt: 1 })).rejects.toMatchObject({
			code: "BINDING_CONFLICT",
		});
		const persisted = await resolveExecutionContext(input(f).key);
		expect(persisted.snapshotDigest).toBe(`sha256:${"a".repeat(64)}`);
	});

	it("默认按显式历史 attempt 回读，即使卡面已推进且旧 worktree 已清理", async () => {
		const f = await fixture();
		const key: ExecutionKey = input(f).key;
		await bindExecutionContext(input(f), { expectedCurrentAttempt: 1 });
		changeCardStatus((await import("../../src/pao/cards/cardfile.ts")).readCard(f.card.path), {
			操作者: "E",
			to: "failed",
			失败类型: "transient",
			时间: "2026-10-20 20:02",
		});
		changeCardStatus((await import("../../src/pao/cards/cardfile.ts")).readCard(f.card.path), {
			操作者: "E",
			to: "unclaimed",
			时间: "2026-10-20 20:03",
		});
		rmSync(f.execution, { recursive: true, force: true });

		const historical = await resolveExecutionContext(key);
		expect(historical.key.attempt).toBe(1);
		expect(historical.canonicalExecutionRoot).toBe(f.execution);
	});

	it("动作显式要求当前 attempt 与活动执行根时，拦截旧 attempt、目录消失和任意目录", async () => {
		const f = await fixture();
		const key = input(f).key;
		await bindExecutionContext(input(f), { expectedCurrentAttempt: 1 });

		await expect(
			resolveExecutionContext(key, { expectedCurrentAttempt: 1, requireLiveExecutionRoot: true }),
		).resolves.toMatchObject({ executionRoot: f.execution });
		renameSync(f.execution, `${f.execution}-moved`);
		await expect(
			resolveExecutionContext(key, { expectedCurrentAttempt: 1, requireLiveExecutionRoot: true }),
		).rejects.toMatchObject({ code: "EXECUTION_ROOT_UNAVAILABLE" });
	});

	it("拒绝 projectRoot 与 taskRoot、executionRoot 与宿主执行根不一致", async () => {
		const f = await fixture();
		const wrongTask = input(f);
		wrongTask.worktree.taskRoot = join(f.root, "other");
		await expect(bindExecutionContext(wrongTask, { expectedCurrentAttempt: 1 })).rejects.toBeInstanceOf(
			ExecutionContextError,
		);

		const wrongExecution = input(f);
		wrongExecution.worktree.executionRoot = join(f.execution, "sub");
		await expect(bindExecutionContext(wrongExecution, { expectedCurrentAttempt: 1 })).rejects.toMatchObject({
			code: "INVALID_EXECUTION_CONTEXT",
		});
	});

	it("持久记录摘要合法但 repositoryRoot 指向另一个真实 Git 仓时，实时解析仍拒绝", async () => {
		const f = await fixture();
		const binding = await bindExecutionContext(input(f), { expectedCurrentAttempt: 1 });
		const other = join(f.root, "other-repository");
		mkdirSync(other);
		writeFileSync(join(other, "other.txt"), "other\n");
		git(other, ["init"]);
		git(other, ["add", "-A"]);
		git(other, ["commit", "--no-gpg-sign", "-m", "other"]);

		const path = executionContextPath(binding.key);
		const tampered = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		tampered.repositoryRoot = other;
		// 攻击者重算外层摘要只能让持久文件“自洽”，不能改变宿主 Git 事实。
		const stable = (value: unknown): unknown => {
			if (Array.isArray(value)) return value.map(stable);
			if (value !== null && typeof value === "object")
				return Object.fromEntries(
					Object.entries(value as Record<string, unknown>)
						.sort(([left], [right]) => left.localeCompare(right))
						.map(([key, child]) => [key, stable(child)]),
				);
			return value;
		};
		const stableFields = {
			key: tampered.key,
			projectRoot: tampered.projectRoot,
			repositoryRoot: tampered.repositoryRoot,
			executionRoot: tampered.executionRoot,
			worktree: tampered.worktree,
			snapshotRef: tampered.snapshotRef,
			snapshotDigest: tampered.snapshotDigest,
			...(typeof tampered.briefRef === "string" ? { briefRef: tampered.briefRef } : {}),
		};
		tampered.bindingDigest = `sha256:${createHash("sha256")
			.update(JSON.stringify(stable(stableFields)), "utf8")
			.digest("hex")}`;
		writeFileSync(path, `${JSON.stringify(tampered, null, 2)}\n`);

		await expect(
			resolveExecutionContext(binding.key, {
				expectedCurrentAttempt: 1,
				requireLiveExecutionRoot: true,
			}),
		).rejects.toMatchObject({ code: "INVALID_EXECUTION_CONTEXT" });
	});

	it("拒绝无效 snapshotDigest 与 briefRef，且持久记录被篡改时重算摘要拒绝回读", async () => {
		const f = await fixture();
		const invalidDigest = input(f);
		invalidDigest.snapshotDigest = "sha256:not-a-digest";
		await expect(bindExecutionContext(invalidDigest, { expectedCurrentAttempt: 1 })).rejects.toMatchObject({
			code: "INVALID_EXECUTION_CONTEXT",
		});

		const invalidBrief = input(f);
		invalidBrief.briefRef = "pao://other/brief.md";
		await expect(bindExecutionContext(invalidBrief, { expectedCurrentAttempt: 1 })).rejects.toMatchObject({
			code: "INVALID_EXECUTION_CONTEXT",
		});

		const valid = input(f);
		const binding = await bindExecutionContext(valid, { expectedCurrentAttempt: 1 });
		const path = executionContextPath(binding.key);
		const tampered = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		tampered.snapshotRef = "tampered";
		writeFileSync(path, `${JSON.stringify(tampered, null, 2)}\n`);
		await expect(resolveExecutionContext(binding.key)).rejects.toMatchObject({
			code: "INVALID_EXECUTION_CONTEXT",
		});
	});
});
