import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCard, readCard, serializeCard } from "../../src/pao/cards/index.ts";
import {
	CLEANUP_DECLARATION_HEADING,
	checkCleanupReadyForDispatch,
	cleanupConfirmationPath,
	confirmCleanup,
	parseCleanupDeclaration,
	previewCleanup,
	workerEvidenceDirForCards,
} from "../../src/pao/worker/cleanup.ts";
import { executeDispatch } from "../../src/pao/worker/dispatch-core.ts";
import type { WorkerReceipt } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner, type WorkerRunOptions } from "../../src/pao/worker/runner.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix = "pao-cleanup-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-C", root, "-c", "user.name=测试", "-c", "user.email=test@example.invalid", ...args], {
		encoding: "utf8",
	});
}

async function card(root: string, body: string, owner?: string): Promise<ReturnType<typeof readCard>> {
	const cardsDir = join(root, "任务", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const created = await createCard(
		cardsDir,
		{
			目标: "删除预演",
			部门: "运维",
			验收: "目标删除并保护证据",
			创建: "2026-10-20 10:00",
			...(owner ? { owner } : {}),
		},
		{ counterPath: join(root, "任务", "卡号.txt") },
	);
	writeFileSync(created.path, serializeCard(created.frontmatter, body), "utf8");
	return readCard(created.path);
}

function declaration(targets: string[]): string {
	return [
		"## 执行",
		"按明确目标清理。",
		"",
		CLEANUP_DECLARATION_HEADING,
		...targets.map((target) => `- \`${target.replaceAll("\\", "/")}\``),
		"",
		"## 验收",
		"完成。",
	].join("\n");
}

class StubRunner extends WorkerRunner {
	runs: WorkerRunOptions[] = [];
	override async run(options: WorkerRunOptions): Promise<WorkerReceipt> {
		this.runs.push(options);
		return {
			card_no: options.卡号,
			card_path: options.卡路径,
			attempt: options.尝试号 ?? 1,
			status: "success",
			artifact_path: [],
			summary: "离线假回执",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			evidence_path: join(options.卡路径 ?? "", "..", "证据.jsonl"),
			command: "stub",
			pid: 0,
			duration_ms: 0,
			exitCode: 0,
		};
	}
}

function dispatch(cardsDir: string, runner: StubRunner, cardNo = "1", operator = "主控") {
	return executeDispatch(
		{ cardsDir, card_no: cardNo, operator, time: "2026-10-20 10:01" },
		{ 运行器: runner, workflowCheck: () => undefined },
		async () => "ok",
	);
}

describe("删除声明和真实目录预演", () => {
	it("只认固定正文段；自然语言和普通卡不触发", () => {
		expect(parseCleanupDeclaration("请删除旧文件")).toBeUndefined();
		const parsed = parseCleanupDeclaration(declaration(["缓存/a.txt", "C:/明确目录"]));
		expect(parsed?.targets).toEqual([
			{ declaredPath: "缓存/a.txt", normalizedPath: "缓存/a.txt", absolute: false },
			{ declaredPath: "C:/明确目录", normalizedPath: "C:\\明确目录", absolute: true },
		]);
		expect(() => parseCleanupDeclaration(`${CLEANUP_DECLARATION_HEADING}\n普通文字`)).toThrow(/反引号|列表项/);
	});

	it("递归列出普通叶子文件，不跟随 junction/symlink；显式项目外绝对目录可预演", async () => {
		const root = temp();
		const outside = temp("pao-cleanup-outside-");
		const nested = join(outside, "明确待删目录", "子目录");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(outside, "明确待删目录", "a.txt"), "a", "utf8");
		writeFileSync(join(nested, "b.log"), "b", "utf8");
		const linked = join(outside, "外部链接");
		const outsideTarget = temp("pao-cleanup-link-target-");
		writeFileSync(join(outsideTarget, "不能扫到.txt"), "x", "utf8");
		symlinkSync(outsideTarget, linked, process.platform === "win32" ? "junction" : "dir");
		const parsedCard = await card(root, declaration([join(outside, "明确待删目录")]), "运维owner");
		const result = await previewCleanup(join(root, "任务", "卡"), "1");

		expect(result.preview.快照.targets[0]?.absolutePath).toBe(join(outside, "明确待删目录"));
		expect(result.preview.快照.targets[0]?.files.map((file) => file.path).sort()).toEqual(
			[join(outside, "明确待删目录", "a.txt"), join(nested, "b.log")].sort(),
		);
		expect(result.preview.快照.git.unverifiedTargets).toEqual([
			expect.objectContaining({
				target: join(outside, "明确待删目录").replaceAll("\\", "/"),
				reason: expect.stringContaining("未核查"),
			}),
		]);
		expect(result.text).toContain("Git 未核查");
		expect(result.text).not.toContain("Git 未跟踪");
		expect(result.preview.快照.risks).toEqual([]);
		expect(readCard(parsedCard.path).frontmatter.attempt).toBe(0);

		const linkedCard = await (async () => {
			const secondRoot = temp();
			const target = temp("pao-cleanup-symlink-parent-");
			mkdirSync(join(target, "link-parent"), { recursive: true });
			symlinkSync(
				outsideTarget,
				join(target, "link-parent", "链接"),
				process.platform === "win32" ? "junction" : "dir",
			);
			writeFileSync(join(target, "link-parent", "本地.txt"), "local", "utf8");
			const body = declaration([join(target, "link-parent", "链接")]);
			const created = await card(secondRoot, body, "运维owner");
			const preview = await previewCleanup(join(secondRoot, "任务", "卡"), "1");
			expect(preview.preview.快照.risks).toContainEqual(
				expect.objectContaining({ code: "SYMLINK_OR_JUNCTION", path: join(target, "link-parent", "链接") }),
			);
			return created;
		})();
		expect(readCard(linkedCard.path).frontmatter.attempt).toBe(0);
	});
});

describe("Git 按目标所属仓核查", () => {
	it("两个实际仓分组各列一次，项目外不冒充项目根 Git；目录变化后旧确认失效", async () => {
		const root = temp();
		const repoA = temp("pao-cleanup-repo-a-");
		const repoB = temp("pao-cleanup-repo-b-");
		for (const repo of [repoA, repoB]) {
			git(repo, "init");
			mkdirSync(join(repo, "目标"), { recursive: true });
			writeFileSync(join(repo, "目标", "a.txt"), "a", "utf8");
			writeFileSync(join(repo, "未跟踪.txt"), "u", "utf8");
			git(repo, "add", "目标/a.txt");
		}
		git(repoA, "commit", "-m", "fixture");
		git(repoB, "commit", "-m", "fixture");
		const parsedCard = await card(root, declaration([join(repoA, "目标"), join(repoB, "目标")]), "运维owner");
		const preview = await previewCleanup(join(root, "任务", "卡"), "1");
		expect(preview.preview.快照.git.repositories).toHaveLength(2);
		expect(preview.preview.快照.git.repositories.map((item) => item.repositoryRoot).sort()).toEqual(
			[repoA, repoB].sort(),
		);
		for (const repository of preview.preview.快照.git.repositories) {
			expect(repository.trackedFiles).toEqual(["目标/a.txt"]);
			expect(repository.targets).toEqual([join(repository.repositoryRoot, "目标").replaceAll("\\", "/")]);
		}
		expect(preview.preview.快照.targets.every((target) => target.gitAvailable)).toBe(true);
		expect(preview.preview.快照.targets.every((target) => target.gitTrackedFiles.length === 1)).toBe(true);

		await confirmCleanup(join(root, "任务", "卡"), "1", { operator: "运维owner", confirm: true });
		writeFileSync(join(repoA, "目标", "新增.txt"), "changed", "utf8");
		const gate = await checkCleanupReadyForDispatch(join(root, "任务", "卡"), readCard(parsedCard.path));
		expect(gate.ok).toBe(false);
		if (!gate.ok) expect(gate.reason).toContain("变化");
	});

	it("目标范围含 .git 时硬拒绝；无 Git 合法预演标记未核查但不阻断确认", async () => {
		const root = temp();
		const repo = temp("pao-cleanup-git-protection-");
		git(repo, "init");
		mkdirSync(join(repo, "普通目录"), { recursive: true });
		writeFileSync(join(repo, "普通目录", "x.txt"), "x", "utf8");
		await card(root, declaration([repo]), "运维owner");
		const guarded = await previewCleanup(join(root, "任务", "卡"), "1");
		expect(guarded.preview.快照.risks).toContainEqual(
			expect.objectContaining({ code: "GIT_DIR_PROTECTED", path: join(repo, ".git") }),
		);
		await expect(
			confirmCleanup(join(root, "任务", "卡"), "1", { operator: "运维owner", confirm: true }),
		).rejects.toThrow(/风险/);

		const explicitRoot = temp();
		await card(explicitRoot, declaration([join(repo, ".git"), join(repo, ".git", "config")]), "运维owner");
		const explicit = await previewCleanup(join(explicitRoot, "任务", "卡"), "1");
		expect(explicit.preview.快照.risks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "GIT_DIR_PROTECTED", path: join(repo, ".git") }),
				expect.objectContaining({ code: "GIT_DIR_PROTECTED", path: join(repo, ".git", "config") }),
			]),
		);
		expect(explicit.preview.快照.targets.every((target) => target.files.length === 0)).toBe(true);
		await expect(
			confirmCleanup(join(explicitRoot, "任务", "卡"), "1", { operator: "运维owner", confirm: true }),
		).rejects.toThrow(/风险/);

		const root2 = temp();
		const plain = temp("pao-cleanup-no-git-");
		mkdirSync(join(plain, "空目标"), { recursive: true });
		writeFileSync(join(plain, "空目标", "x.txt"), "x", "utf8");
		await card(root2, declaration([join(plain, "空目标")]), "运维owner");
		const clean = await previewCleanup(join(root2, "任务", "卡"), "1");
		expect(clean.preview.快照.git.unverifiedTargets[0]?.reason).toContain("Git");
		await expect(
			confirmCleanup(join(root2, "任务", "卡"), "1", { operator: "运维owner", confirm: true }),
		).resolves.toMatchObject({ confirmation: { 确认人: "运维owner" } });
	});
});

describe("owner 确认、sidecar 与共享派发门禁", () => {
	it("无 owner、非 owner、未确认都拒绝；owner 确认不改认领状态，卡/证据/sidecar 及祖先保护", async () => {
		const root = temp();
		const target = temp("pao-cleanup-target-");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "a.txt"), "a", "utf8");
		await card(root, declaration([target]));
		const cardsDir = join(root, "任务", "卡");
		const noOwnerPreview = await previewCleanup(cardsDir, "1");
		expect(noOwnerPreview.preview.快照.risks).toEqual([]);
		await expect(confirmCleanup(cardsDir, "1", { operator: "运维owner", confirm: true })).rejects.toThrow(/owner/);

		const ownedRoot = temp();
		await card(ownedRoot, declaration([target]), "运维owner");
		const ownedCardsDir = join(ownedRoot, "任务", "卡");
		await previewCleanup(ownedCardsDir, "1");
		await expect(() => confirmCleanup(ownedCardsDir, "1", { operator: "别人", confirm: true })).rejects.toThrow(
			/owner|无权/,
		);
		await expect(() => confirmCleanup(ownedCardsDir, "1", { operator: "运维owner", confirm: false })).rejects.toThrow(
			/confirm=true/,
		);
		await confirmCleanup(ownedCardsDir, "1", { operator: "运维owner", confirm: true });
		const after = readCard(join(ownedCardsDir, "卡0001-删除预演.md"));
		expect(after.frontmatter.owner).toBe("运维owner");
		expect(after.frontmatter.status).toBe("unclaimed");
		expect(existsSync(cleanupConfirmationPath(ownedCardsDir, 1))).toBe(true);
		mkdirSync(join(ownedRoot, "任务", "cleanup", "其他卡"), { recursive: true });

		const protectedTargets = [
			dirname(ownedCardsDir),
			ownedCardsDir,
			join(ownedCardsDir, "其他"),
			join(workerEvidenceDirForCards(ownedCardsDir), "尝试1.jsonl"),
			join(ownedRoot, "任务", "cleanup", "其他卡"),
		];
		for (const protectedTarget of protectedTargets) {
			writeFileSync(after.path, serializeCard(after.frontmatter, declaration([protectedTarget])), "utf8");
			const preview = await previewCleanup(ownedCardsDir, "1");
			expect(preview.preview.快照.risks, protectedTarget).toEqual(
				expect.arrayContaining([expect.objectContaining({ code: "TARGET_PROTECTED" })]),
			);
			await expect(confirmCleanup(ownedCardsDir, "1", { operator: "运维owner", confirm: true })).rejects.toThrow(
				/风险|保护/,
			);
		}
	});

	it("确认文件被改不能通行；首次预演和缺确认时 executeDispatch 不调 runner、尝试号不变", async () => {
		const root = temp();
		const target = temp("pao-cleanup-dispatch-");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "a.txt"), "a", "utf8");
		await card(root, declaration([target]), "运维owner");
		const cardsDir = join(root, "任务", "卡");
		const runner = new StubRunner();

		const first = await dispatch(cardsDir, runner);
		expect(first.可派).toBe(false);
		if (!first.可派) expect(first.原因).toContain("只读预演");
		expect(runner.runs).toHaveLength(0);
		expect(readCard(join(cardsDir, "卡0001-删除预演.md")).frontmatter.attempt).toBe(0);

		await previewCleanup(cardsDir, "1");
		const second = await dispatch(cardsDir, runner);
		expect(second.可派).toBe(false);
		if (!second.可派) expect(second.原因).toContain("没有 owner 删除确认");
		expect(runner.runs).toHaveLength(0);
		expect(readCard(join(cardsDir, "卡0001-删除预演.md")).frontmatter.attempt).toBe(0);

		await confirmCleanup(cardsDir, "1", { operator: "运维owner", confirm: true });
		const confirmationPath = cleanupConfirmationPath(cardsDir, 1);
		const confirmation = JSON.parse(readFileSync(confirmationPath, "utf8")) as Record<string, unknown>;
		confirmation.确认人 = "冒名者";
		writeFileSync(confirmationPath, JSON.stringify(confirmation), "utf8");
		const tampered = await dispatch(cardsDir, runner);
		expect(tampered.可派).toBe(false);
		expect(runner.runs).toHaveLength(0);
		expect(readCard(join(cardsDir, "卡0001-删除预演.md")).frontmatter.attempt).toBe(0);
	});

	it("完整预演+owner确认后才启动假 runner；普通卡仍零影响", async () => {
		const root = temp();
		const target = temp("pao-cleanup-success-");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "a.txt"), "a", "utf8");
		await card(root, declaration([target]), "运维owner");
		const cardsDir = join(root, "任务", "卡");
		await previewCleanup(cardsDir, "1");
		await confirmCleanup(cardsDir, "1", { operator: "运维owner", confirm: true });
		const runner = new StubRunner();
		const dispatched = await dispatch(cardsDir, runner, "1", "运维owner");
		expect(dispatched.可派).toBe(true);
		expect(runner.runs).toHaveLength(1);
		expect(readCard(join(cardsDir, "卡0001-删除预演.md")).frontmatter.attempt).toBe(1);

		const ordinaryRoot = temp();
		const ordinary = await card(ordinaryRoot, "## 执行\n普通任务，不删除。");
		const ordinaryRunner = new StubRunner();
		const ordinaryResult = await dispatch(join(ordinaryRoot, "任务", "卡"), ordinaryRunner);
		expect(ordinaryResult.可派).toBe(true);
		expect(ordinaryRunner.runs).toHaveLength(1);
		expect(readCard(ordinary.path).frontmatter.attempt).toBe(1);
	});
});
