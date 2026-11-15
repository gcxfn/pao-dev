import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inventory } from "../../src/pao/worker/inventory.ts";
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

function makeWorkspace(repoRoot: string): string {
	const workspace = join(repoRoot, ".pao", "任务A-20261002");
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

describe("重启只读盘点:未完卡 + git 基线差异,零写入", () => {
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

		const report2 = await inventory({ 工作区: tempDir("inv"), 项目根: tempDir("inv") });
		expect(report2.git.可用).toBe(false);
		expect(report2.git.原因).toBeTruthy();
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
		expect(existsSync(join(repo, ".pao", "项目锁"))).toBe(true);
	});
});
