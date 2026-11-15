import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { diffAgainstBaseline, snapshotClaimBaseline } from "../../src/pao/cards/baseline.ts";
import { registerCardTools } from "../../src/pao/cards/tools.ts";

/**
 * R14 认领基线快照（架构 §14 交叉核对）：
 * 认领时把 git status 快照落工作区，交回执比对取当前减基线——
 * 用户既有未提交改动不算 worker 的账（G1-14「用户已有修改」侧）。
 */

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "pao-baseline-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", ["-c", "core.quotepath=off", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		stdio: "ignore",
	});
}

/** 建 git 仓库:提交基线后制造「用户既有改动」(1 个跟踪文件修改 + 1 个未跟踪文件) */
function makeRepo(prefix = "pao-baseline-"): string {
	const repo = tempDir(prefix);
	writeFileSync(join(repo, "已跟踪.txt"), "v1\n");
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src", "代码.ts"), "export {};\n");
	git(repo, ["init"]);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--no-gpg-sign", "-m", "开工基线"]);
	// 用户在派卡前自己的脏工作树
	writeFileSync(join(repo, "已跟踪.txt"), "v2-用户改的\n");
	writeFileSync(join(repo, "用户便签.txt"), "用户自己的未跟踪文件\n");
	return repo;
}

describe("认领基线快照:认领时落工作区,既有改动不入账", () => {
	it("认领当刻快照落盘:记录既有条目;随后 worker 改动只算基线之外的", async () => {
		const repo = makeRepo();
		const cardDir = join(repo, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });

		const baseline = await snapshotClaimBaseline(cardDir, 1, { owner: "部长A", 时间: "2026-10-02 22:00" });
		expect(baseline.可用).toBe(true);
		expect(baseline.既有条目数).toBe(2); // 用户既有:1 修改 + 1 未跟踪
		expect(baseline.快照路径).toBeTruthy();
		expect(existsSync(baseline.快照路径!)).toBe(true);
		// 快照落在任务工作区(卡目录上级 基线/),不进项目源码区
		expect(baseline.快照路径).toContain(join(".pao", "基线"));

		// 模拟 worker 干活:改另一个跟踪文件 + 新增自己的产物(用户既有文件不动)
		writeFileSync(join(repo, "src", "代码.ts"), "export const x = 1;\n");
		writeFileSync(join(repo, "产物.diff"), "+worker 的新产物\n");

		const diff = await diffAgainstBaseline(baseline.快照路径!);
		expect(diff.基线可用).toBe(true);
		expect(diff.既有条目数).toBe(2);
		expect(diff.worker改动.map((c) => c.文件).sort()).toEqual(["src/代码.ts", "产物.diff"]);
		// 用户已有修改不在 worker 账上(已跟踪.txt 的 v2 与 用户便签.txt 都在基线里)
		expect(diff.worker改动.map((c) => c.文件)).not.toContain("已跟踪.txt");
		expect(diff.worker改动.map((c) => c.文件)).not.toContain("用户便签.txt");
		expect(diff.汇总).toContain("基线外改动 2 个文件");
	});

	it("worker 没动现场:比对结果为「无基线外改动」,用户既有改动也不冒领", async () => {
		const repo = makeRepo();
		const cardDir = join(repo, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });
		const baseline = await snapshotClaimBaseline(cardDir, "2");
		const diff = await diffAgainstBaseline(baseline.快照路径!);
		expect(diff.worker改动).toEqual([]);
		expect(diff.汇总).toContain("无基线外改动");
	});

	it("干净工作树认领:基线 0 条,worker 任何改动都会亮出来", async () => {
		const repo = tempDir();
		writeFileSync(join(repo, "干净.txt"), "v1\n");
		git(repo, ["init"]);
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "--no-gpg-sign", "-m", "clean"]);
		const cardDir = join(repo, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });
		const baseline = await snapshotClaimBaseline(cardDir, 3);
		expect(baseline.既有条目数).toBe(0);
		writeFileSync(join(repo, "干净.txt"), "v2-worker改的\n");
		const diff = await diffAgainstBaseline(baseline.快照路径!);
		expect(diff.worker改动).toEqual([{ 状态: "M", 文件: "干净.txt" }]);
	});

	it("认领快照含卡号/owner/时间/项目根头信息,可审计", async () => {
		const repo = makeRepo();
		const cardDir = join(repo, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });
		const baseline = await snapshotClaimBaseline(cardDir, 7, { owner: "主控", 时间: "2026-10-02 23:00" });
		const text = readFileSync(baseline.快照路径!, "utf8");
		expect(text).toContain("# 卡0007 认领基线");
		expect(text).toContain("# owner: 主控");
		expect(text).toContain("# 时间: 2026-10-02 23:00");
		expect(text).toContain("# 项目根:");
		expect(text).toContain("??\t用户便签.txt");
	});

	it("非 git 目录:快照如实报不可用,不阻断认领流程", async () => {
		const dir = tempDir();
		const cardDir = join(dir, "卡");
		mkdirSync(cardDir, { recursive: true });
		const baseline = await snapshotClaimBaseline(cardDir, 1);
		expect(baseline.可用).toBe(false);
		expect(baseline.原因).toBeTruthy();
		expect(baseline.快照路径).toBeUndefined();
	});

	it("基线快照文件缺失:比对如实报不可用,不猜", async () => {
		const diff = await diffAgainstBaseline(join(tempDir(), "不存在-基线.txt"));
		expect(diff.基线可用).toBe(false);
		expect(diff.原因).toBeTruthy();
	});

	it("中文与空格路径的仓库:快照与比对照常工作(G1-14 路径侧)", async () => {
		const repo = tempDir("pao-baseline-中文 空格-");
		writeFileSync(join(repo, "说明 文档.txt"), "v1\n");
		git(repo, ["init"]);
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "--no-gpg-sign", "-m", "中文基线"]);
		const cardDir = join(repo, ".pao", "任务 卡片", "卡");
		mkdirSync(cardDir, { recursive: true });
		const baseline = await snapshotClaimBaseline(cardDir, 1);
		expect(baseline.可用).toBe(true);
		writeFileSync(join(repo, "说明 文档.txt"), "v2\n");
		const diff = await diffAgainstBaseline(baseline.快照路径!);
		expect(diff.worker改动).toEqual([{ 状态: "M", 文件: "说明 文档.txt" }]);
	});
});

// ── pao_change_status 接线:认领即落快照 ─────────────────────────────────────────

interface ToolDef {
	execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
}

function setup(cardDir: string) {
	const tools = new Map<string, ToolDef>();
	const pi = {
		registerTool: (def: { name: string; execute: ToolDef["execute"] }) =>
			tools.set(def.name, { execute: def.execute }),
		registerCommand: () => {},
		sendMessage: () => {},
		on: () => {},
	};
	registerCardTools(pi as never, { resolveCardsDir: () => cardDir });
	return tools;
}

describe("pao_change_status 认领接线:待认领→进行中 自动落 R14 基线", () => {
	it("经工具认领后,工作区 基线/ 出现该卡快照;返回文本说明基线位置", async () => {
		const repo = makeRepo();
		const cardDir = join(repo, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });
		const tools = setup(cardDir);
		await tools.get("pao_create_card")!.execute("t1", {
			cards_dir: cardDir,
			goal: "基线接线卡",
			dept: "核心机制",
			acceptance: "x",
			counter_path: join(cardDir, "..", "卡号.txt"), // 收在 .pao 内(差分已排除),不污染共享上级
		});
		const claim = await tools
			.get("pao_change_status")!
			.execute("t2", { cards_dir: cardDir, card_ref: 1, operator: "部长A", new_status: "in_progress" });
		const text = claim.content[0].text;
		expect(text).toContain("认领基线快照已落");
		expect(text).toContain("既有改动 2 条不计 worker 的账");
		const snapshotPath = /认领基线快照已落 (.+?)（既有改动/.exec(text)?.[1]?.trim();
		expect(snapshotPath).toBeTruthy();
		expect(existsSync(snapshotPath!)).toBe(true);
	});

	it("非 git 工作区认领:不阻断,返回文本如实标注基线不可用", async () => {
		const dir = tempDir();
		const cardDir = join(dir, "卡");
		mkdirSync(cardDir, { recursive: true });
		const tools = setup(cardDir);
		await tools.get("pao_create_card")!.execute("t1", {
			cards_dir: cardDir,
			goal: "非git卡",
			dept: "核心机制",
			acceptance: "x",
			counter_path: join(cardDir, "..", "卡号.txt"), // 不落共享 tmpdir(计数器缺省在 卡目录/../../卡号.txt)
		});
		const claim = await tools
			.get("pao_change_status")!
			.execute("t2", { cards_dir: cardDir, card_ref: 1, operator: "部长A", new_status: "in_progress" });
		expect(claim.content[0].text).toContain("认领基线快照不可用");
		expect(claim.content[0].text).toContain("unclaimed → in_progress"); // 认领本身成功
	});
});

// ── 未跟踪目录展开到文件级（2026-10-05 修：全新目录场景零误报） ──────────────
describe("未跟踪目录展开到文件级:全新目录不再误报「虚报+越界」", () => {
	it("全新未跟踪目录:git 目录级条目展开成文件级,文件级声明可对上", async () => {
		const repo = tempDir();
		writeFileSync(join(repo, "根.txt"), "v1\n");
		git(repo, ["init"]);
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "--no-gpg-sign", "-m", "clean"]);
		const cardDir = join(repo, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });
		const baseline = await snapshotClaimBaseline(cardDir, 21, { owner: "主控", 时间: "2026-10-05 10:00" });
		expect(baseline.可用).toBe(true);

		// worker 新建全新目录与产物（目录里没有任何已跟踪文件——修复前 git 只报目录级 `?? 产出/`）
		mkdirSync(join(repo, "产出"), { recursive: true });
		writeFileSync(join(repo, "产出", "hello.txt"), "hello\n");

		const diff = await diffAgainstBaseline(baseline.快照路径!);
		expect(diff.基线可用).toBe(true);
		// 文件级精度：不是目录级的 `产出/`
		expect(diff.worker改动).toEqual([{ 状态: "??", 文件: "产出/hello.txt" }]);
	});

	it("目录里已有已跟踪文件时回归不破:改动的与新增的都按文件级列出", async () => {
		const repo = tempDir();
		mkdirSync(join(repo, "src"));
		writeFileSync(join(repo, "src", "旧文件.ts"), "v1\n");
		git(repo, ["init"]);
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "--no-gpg-sign", "-m", "clean"]);
		const cardDir = join(repo, ".pao", "卡");
		mkdirSync(cardDir, { recursive: true });
		const baseline = await snapshotClaimBaseline(cardDir, 22, { owner: "主控", 时间: "2026-10-05 10:00" });

		// worker 在已有已跟踪文件的目录里改一个、新增一个
		writeFileSync(join(repo, "src", "旧文件.ts"), "v2-worker改的\n");
		writeFileSync(join(repo, "src", "新文件.ts"), "new\n");

		const diff = await diffAgainstBaseline(baseline.快照路径!);
		expect(diff.worker改动.map((c) => c.文件).sort()).toEqual(["src/新文件.ts", "src/旧文件.ts"]);
	});
});
