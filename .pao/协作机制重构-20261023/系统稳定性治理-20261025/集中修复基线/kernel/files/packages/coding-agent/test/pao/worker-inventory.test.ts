import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InventoryPathError, inventory, renderInventoryCards } from "../../src/pao/worker/inventory.ts";
import { acquireProjectLock, isProjectLocked } from "../../src/pao/worker/lock.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", "user.email=pao@test", "-c", "user.name=pao", ...args], {
		cwd,
		encoding: "utf8",
	});
}

function writeCard(cardDir: string, name: string, frontmatter: string, body: string): void {
	writeFileSync(join(cardDir, name), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
}

/** 递归快照目录内全部文件(相对路径+内容),用于断言盘点零写入 */
function snapshot(dir: string, base = dir): { path: string; content: string }[] {
	const out: { path: string; content: string }[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...snapshot(full, base));
		else out.push({ path: full.slice(base.length + 1), content: readFileSync(full, "utf8") });
	}
	return out.sort((a, b) => a.path.localeCompare(b.path));
}

function makeWorkspace(repoRoot: string, task = "任务A-20261002"): string {
	const workspace = join(repoRoot, ".pao", task);
	const cardDir = join(workspace, "卡", "前端");
	mkdirSync(cardDir, { recursive: true });
	writeCard(
		join(workspace, "卡"),
		"卡0001-修登录bug.md",
		"goal: 修登录 bug\ndept: 后端\nattempt: 2\nstatus: in_progress",
		"## 回执(尝试1)\n失败:测试环境起不来\n\n## 回执(尝试2)\n差一个断言没过,进度 80%\n证据在 产物/日志.txt",
	);
	writeCard(
		join(workspace, "卡"),
		"卡0002-写文档.md",
		"goal: 补文档\nattempt: 1\nstatus: delivered",
		"## 回执(尝试1)\n已写完",
	);
	writeCard(cardDir, "卡0003-侦察.md", "goal: 侦察路由结构\nattempt: 0\nstatus: unclaimed", "还没开工");
	return workspace;
}

function makeEmptyWorkspace(repoRoot: string, task: string): string {
	const workspace = join(repoRoot, ".pao", task);
	mkdirSync(join(workspace, "卡"), { recursive: true });
	return workspace;
}

describe("重启只读盘点:未完卡 + git 基线差异,零写入", () => {
	it.each([".pao", ".pao/临时工作流/计划/执行/请求"])("%s 布局缺省也从卡归属取得真实 Git 项目根", async (relative) => {
		const repo = tempDir("inv-root");
		git(repo, ["init"]);
		git(repo, ["commit", "--allow-empty", "-m", "fixture"]);
		const workspace = join(repo, relative);
		mkdirSync(join(workspace, "卡"), { recursive: true });
		const report = await inventory({ 工作区: workspace });
		expect(report.项目根).toBe(realpathSync(repo));
		expect(report.git.可用).toBe(true);
		expect(report.git.head).toBeTruthy();
	});
	it("列未完卡(状态+尝试数+最后回执摘要),不列已交付卡", async () => {
		const repo = tempDir("inv");
		const workspace = makeWorkspace(repo);

		const report = await inventory({ 工作区: workspace });
		expect(report.未完卡.length).toBe(2);
		const card1 = report.未完卡.find((c) => c.卡号 === "0001")!;
		expect(card1.状态).toBe("in_progress");
		expect(card1.当前尝试回执结果).toBe("无有效回执");
		expect(card1.最近收到回执结果).toBe("无回执");
		expect(card1.尝试).toBe(2);
		expect(card1.目标).toBe("修登录 bug");
		// 最后回执 = 尝试2 那段,不是尝试1
		expect(card1.最后回执摘要).toContain("差一个断言没过");
		expect(card1.最后回执摘要).not.toContain("测试环境起不来");
		const card3 = report.未完卡.find((c) => c.卡号 === "0003")!;
		expect(card3.状态).toBe("unclaimed");
		expect(report.未完卡.some((c) => c.卡号 === "0002")).toBe(false);
	});

	it("卡状态与最近收到的回执结果分开呈现:进行中卡面上有失败回执时两者都保留", async () => {
		const repo = tempDir("inv");
		const workspace = makeWorkspace(repo);
		writeCard(
			join(workspace, "卡"),
			"卡0005-有失败回执.md",
			"goal: 检查失败后仍进行中的现场\nattempt: 3\nstatus: in_progress",
			"## 回执 尝试2 2026-10-20 09:00\n- result: failed\n- summary: 上次尝试失败但卡仍在进行中",
		);

		const report = await inventory({ 工作区: workspace });
		const card5 = report.未完卡.find((c) => c.卡号 === "0005")!;
		expect(card5.状态).toBe("in_progress");
		expect(card5.当前尝试回执结果).toBe("无有效回执");
		expect(card5.最近收到回执结果).toBe("failed");
		expect(card5.最后回执摘要).toContain("上次尝试失败");
	});

	it("最近收到的回执结果只取最后一段回执,不把正文其他 result 行误认成回执字段", async () => {
		const repo = tempDir("inv");
		const workspace = makeWorkspace(repo);
		writeCard(
			join(workspace, "卡"),
			"卡0006-结果范围.md",
			"goal: 核对最近尝试范围\nattempt: 2\nstatus: in_progress",
			"## 回执 尝试1\n- result: success\n\n## 回执 尝试2\n- summary: 本轮没有结果字段\n\n这是正文的 result: success 说明,不是回执字段",
		);

		const report = await inventory({ 工作区: workspace });
		const card6 = report.未完卡.find((c) => c.卡号 === "0006")!;
		expect(card6.当前尝试回执结果).toBe("无有效回执");
		expect(card6.最近收到回执结果).toBe("无回执");
	});

	it("迟到归档旧 attempt 排在物理末尾时,当前尝试只认当前有效回执", async () => {
		const repo = tempDir("inv");
		const workspace = makeWorkspace(repo);
		writeCard(
			join(workspace, "卡"),
			"卡0007-迟到回执.md",
			"goal: 核对迟到回执语义\nattempt: 3\nstatus: in_progress",
			"## 回执 尝试3 2026-10-20 10:00\n- result: success\n- summary: 当前尝试已完成\n\n## 回执 尝试2 2026-10-20 11:00\n- archive_flag: old_attempt\n- result: failed\n- summary: 迟到的旧尝试记录",
		);

		const report = await inventory({ 工作区: workspace });
		const card7 = report.未完卡.find((c) => c.卡号 === "0007")!;
		expect(card7.状态).toBe("in_progress");
		expect(card7.当前尝试回执结果).toBe("success");
		expect(card7.最近收到回执结果).toBe("failed");
		expect(card7.最后回执摘要).toContain("迟到的旧尝试记录");
	});

	it("目标含冒号/井号时照常解析列出(复用 YAML 真解析,不再被手写正则截断)", async () => {
		const repo = tempDir("inv");
		const workspace = makeWorkspace(repo);
		writeCard(
			join(workspace, "卡"),
			"卡0004-特殊字符.md",
			'goal: "修复:登录#超时"\ndept: 后端\nattempt: 1\nstatus: unclaimed',
			"还没开工",
		);

		const report = await inventory({ 工作区: workspace });
		const card4 = report.未完卡.find((c) => c.卡号 === "0004")!;
		expect(card4.状态).toBe("unclaimed");
		expect(card4.目标).toBe("修复:登录#超时");
		expect(card4.尝试).toBe(1);
	});

	it("git status 差异摘要:改动+新增文件可见;非 git 目录如实报不可用", async () => {
		const repo = tempDir("inv");
		const workspace = makeWorkspace(repo);
		const tracked = join(repo, "src.txt");
		writeFileSync(tracked, "v1\n", "utf8");
		git(repo, ["init"]);
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "--no-gpg-sign", "-m", "开工基线"]);
		// 开工后:改一版 + 新增一文件
		writeFileSync(tracked, "v2\n", "utf8");
		writeFileSync(join(repo, "新产物.txt"), "本轮写的\n", "utf8");

		const report = await inventory({ 工作区: workspace });
		expect(report.git.可用).toBe(true);
		const files = report.git.变更.map((c) => c.文件.replace(/\\/g, "/"));
		expect(files.some((f) => f.endsWith("src.txt"))).toBe(true);
		expect(files.some((f) => f.endsWith("新产物.txt"))).toBe(true);
		expect(report.git.汇总).toContain("2 个文件");

		const nonGitRoot = tempDir("inv-nongit");
		const nonGitWorkspace = makeWorkspace(nonGitRoot);
		const report2 = await inventory({ 工作区: nonGitWorkspace, 项目根: nonGitRoot });
		expect(report2.git.可用).toBe(false);
		expect(report2.git.原因).toBeTruthy();
	});

	it("项目根误传为 workspace 时明确拒绝，并列出真实任务工作区而不自动选择", async () => {
		const repo = tempDir("inv");
		const workspace = makeWorkspace(repo);

		const error = await inventory({ 工作区: repo }).catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(InventoryPathError);
		expect((error as InventoryPathError).code).toBe("INVENTORY_PATH_INVALID");
		expect((error as Error).message).toContain("workspace 不是任务工作区");
		expect((error as Error).message).toContain(workspace);
		expect((error as Error).message).toContain("不能自动替你选");
		expect((error as Error).message).not.toContain("未完卡:无");
	});

	it("显式 project_root 与 workspace 所属项目一致时正常盘点；不一致时拒绝", async () => {
		const repo = tempDir("inv");
		const workspace = makeWorkspace(repo);
		const report = await inventory({ 工作区: workspace, 项目根: repo });
		expect(report.工作区).toBe(workspace);
		expect(report.项目根).toBe(resolve(repo));
		expect(report.未完卡.length).toBe(2);

		const otherRoot = tempDir("inv-other");
		const error = await inventory({ 工作区: workspace, 项目根: otherRoot }).catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(InventoryPathError);
		expect((error as Error).message).toContain("project_root 与任务工作区所属项目不一致");
		expect((error as Error).message).toContain(resolve(repo));
	});

	it("平铺 .pao/卡 可直接盘点；显式 project_root 可用符号链接路径表示同一项目", async () => {
		const repo = tempDir("inv-flat");
		const paoDir = join(repo, ".pao");
		mkdirSync(join(paoDir, "卡"), { recursive: true });
		writeCard(
			join(paoDir, "卡"),
			"卡0010-平铺任务.md",
			"goal: 验证平铺布局\nattempt: 0\nstatus: unclaimed",
			"还没开工",
		);
		const linkedRoot = `${repo}-link`;
		try {
			const symlinkType = process.platform === "win32" ? "junction" : "dir";
			symlinkSync(repo, linkedRoot, symlinkType);
		} catch (error) {
			if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
			return;
		}
		tempDirs.push(linkedRoot);

		const report = await inventory({ 工作区: paoDir, 项目根: linkedRoot });
		expect(report.工作区).toBe(paoDir);
		expect(report.项目根).toBe(resolve(repo));
		expect(report.未完卡.map((card) => card.卡号)).toEqual(["0010"]);
	});

	it("非 .pao 自定义任务工作区可显式指定合法 project_root", async () => {
		const repo = tempDir("inv-custom");
		const workspace = join(repo, "自定义", "任务");
		mkdirSync(join(workspace, "卡"), { recursive: true });
		writeCard(
			join(workspace, "卡"),
			"卡0011-自定义布局.md",
			"goal: 验证自定义任务目录\nattempt: 0\nstatus: unclaimed",
			"还没开工",
		);

		const report = await inventory({ 工作区: workspace, 项目根: repo });
		expect(report.项目根).toBe(repo);
		expect(report.未完卡.map((card) => card.卡号)).toEqual(["0011"]);
	});

	it("多个合法任务目录时列出全部候选并拒绝自动选第一个", async () => {
		const repo = tempDir("inv");
		const first = makeEmptyWorkspace(repo, "任务A-20261002");
		const second = makeEmptyWorkspace(repo, "任务B-20261003");

		const error = await inventory({ 工作区: repo }).catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(InventoryPathError);
		expect((error as InventoryPathError).details.候选任务目录).toEqual([first, second]);
		expect((error as Error).message).toContain(first);
		expect((error as Error).message).toContain(second);
		expect((error as Error).message).toContain("2 个候选任务目录");
	});

	it("合法空卡目录是空队列；坏卡读取失败进入问题清单，不伪装成干净结果", async () => {
		const repo = tempDir("inv");
		const emptyWorkspace = makeEmptyWorkspace(repo, "空任务-20261002");
		const empty = await inventory({ 工作区: emptyWorkspace });
		expect(empty.未完卡).toEqual([]);
		expect(empty.问题).toEqual([]);

		writeFileSync(join(emptyWorkspace, "卡", "卡0009-坏卡.md"), "---\ngoal: [\n---\n", "utf8");
		const broken = await inventory({ 工作区: emptyWorkspace });
		expect(broken.未完卡).toEqual([]);
		expect(broken.问题).toHaveLength(1);
		expect(broken.问题[0]?.路径).toContain("卡0009-坏卡.md");
		expect(broken.问题[0]?.原因).toContain("卡文件不可读或格式无效");
	});

	it("纯读保证:盘点前后工作区文件零变化,项目锁原样保留", async () => {
		const repo = tempDir("inv");
		const workspace = makeWorkspace(repo);
		git(repo, ["init"]);

		await acquireProjectLock({ 项目根: repo, 持有者: "卡0002" });
		const before = snapshot(repo);

		await inventory({ 工作区: workspace });

		expect(snapshot(repo)).toEqual(before);
		// 不清锁:锁还在,且没有清理动作留下的痕迹
		expect(await isProjectLocked(repo)).toBe(true);
		expect(existsSync(join(repo, ".pao", "共享锁"))).toBe(true);
	});

	it("默认盘点卡摘要精简并保留原卡入口，full 才展开全部目标与回执", async () => {
		const repo = tempDir("inv");
		const workspace = makeWorkspace(repo);
		writeCard(
			join(workspace, "卡"),
			"卡0008-长目标.md",
			`goal: "${"很长的目标".repeat(30)}"
attempt: 1
status: in_progress`,
			"## 回执 尝试1\n- result: success\n- summary: 第一行摘要\n- evidence: 第二行证据\n- verdict: 第三行结论",
		);
		const report = await inventory({ 工作区: workspace });
		const card = report.未完卡.find((candidate) => candidate.卡号 === "0008")!;
		const compact = renderInventoryCards({ 未完卡: [card], 已终结卡: [], 已终结卡截断: 0 });
		const full = renderInventoryCards(
			{
				未完卡: [{ ...card, 最后回执摘要: "first line\nsecond line\nthird line" }],
				已终结卡: [],
				已终结卡截断: 0,
			},
			{ full: true },
		);
		expect(compact).toContain(card.文件);
		expect(compact).toContain("需要完整目标和回执时按此路径读取");
		expect(compact).not.toContain(card.最后回执摘要);
		expect(full).toContain(card.目标);
		expect(full).toContain("    first line\n    second line\n    third line");
	});
});
