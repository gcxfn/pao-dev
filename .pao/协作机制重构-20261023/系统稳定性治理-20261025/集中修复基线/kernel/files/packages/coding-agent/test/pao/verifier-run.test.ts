import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { snapshotClaimBaseline } from "../../src/pao/cards/baseline.ts";
import { createCard, loadCard, serializeCard } from "../../src/pao/cards/cardfile.ts";
import { appendReceipt } from "../../src/pao/cards/receipts.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import type { ParsedCard, Receipt } from "../../src/pao/cards/types.ts";
import {
	checkCommandSafety,
	refreshShadowSandbox,
	registerVerifierTools,
	removeSandboxSafe,
	settleSandbox,
	type VerificationCommandRunner,
	verifyCard,
} from "../../src/pao/cards/verifier.ts";

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	return { ...original, readdirSync: vi.fn(original.readdirSync) };
});

/**
 * §12 机械验收员·执行面：影子沙箱隔离与 .env 不拷、三种句式机械核对、
 * 过/不过/无法判三分结论、全过自动落已交付（§12.1 交付规则）、
 * junction 删除不穿透红线、指向外部的链接拒绝自动验收（R16）、pao_verify_card 工具接线。
 */

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "pao-verify-"): string {
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

/** 最小项目仓库：一个源文件 + 一个含密钥的 .env（拷贝排除面验证用）。父目录缺省建在系统临时目录下。 */
function makeRepo(prefix = "pao-verify-", parentDir?: string): string {
	const repo = mkdtempSync(join(parentDir ?? tmpdir(), prefix));
	writeFileSync(join(repo, "源.txt"), "PAO 影子沙箱测试项目\n");
	writeFileSync(join(repo, ".env"), "SECRET_TOKEN=绝不能进沙箱\n");
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src", "代码.ts"), "export {};\n");
	git(repo, ["init"]);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--no-gpg-sign", "-m", "开工基线"]);
	return repo;
}

async function makeClaimedCard(
	repo: string,
	acceptance: string,
	goal = "验收目标卡",
): Promise<{ cardDir: string; card: ParsedCard }> {
	const cardDir = join(repo, ".pao", "卡");
	mkdirSync(cardDir, { recursive: true });
	const card = await createCard(cardDir, { 目标: goal, 部门: "核心机制", 验收: acceptance, 创建: "2026-10-02 10:00" });
	changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 10:01" });
	return { cardDir: cardDir, card: loadCard(cardDir, card.card_no) };
}

function sandboxRoot(): string {
	return tempDir("pao-verify-sbx-");
}

function appendVerificationReceipt(
	card: ParsedCard,
	verification: NonNullable<Receipt["verification"]>,
	time = "2026-10-20 10:00",
	attempt = card.frontmatter.attempt,
): void {
	appendReceipt(loadCard(join(card.path, ".."), card.card_no), {
		尝试号: attempt,
		时间: time,
		结果: "完成",
		摘要: "机械验收定向测试回执",
		verification,
	});
}

it("外链扫描目录不可读或超出深度，明确阻止自动验收而不是当无外链", async () => {
	const root = tempDir();
	const scan = vi.spyOn(fs, "readdirSync").mockImplementation(() => {
		throw new Error("模拟 EACCES");
	});
	try {
		await expect(refreshShadowSandbox(root, { sandbox_root: sandboxRoot() })).rejects.toThrow("外链扫描不完整");
	} finally {
		scan.mockRestore();
	}
	let nested = root;
	for (let i = 0; i < 14; i++) {
		nested = join(nested, "nested");
		mkdirSync(nested);
	}
	await expect(refreshShadowSandbox(root, { sandbox_root: sandboxRoot() })).rejects.toThrow("超出扫描容量");
});

describe("影子沙箱（§12.2）：拷贝面与隔离", () => {
	it("宿主限制执行器拒绝业务脚本后，机械验收不能回退默认执行器", async () => {
		const repo = makeRepo();
		tempDirs.push(repo);
		writeFileSync(join(repo, "restricted.cjs"), "require('node:fs').writeFileSync('executed', 'bad');\n");
		const { cardDir } = await makeClaimedCard(repo, "跑: node restricted.cjs");
		const controller = new AbortController();
		let workDir = "";
		const runner = vi.fn<VerificationCommandRunner>(async (cmd, args, cwd, timeout, env, signal) => {
			expect(cmd).toBe("node");
			expect(args).toEqual(["restricted.cjs"]);
			expect(timeout).toBe(4321);
			expect(signal).toBe(controller.signal);
			expect(env?.PYTHONPYCACHEPREFIX).toBeTruthy();
			workDir = cwd;
			expect(existsSync(join(cwd, "restricted.cjs"))).toBe(true);
			return { code: 77, stdout: "", stderr: "host permission denied" };
		});
		const { result } = await verifyCard(cardDir, 1, {
			operator: "部长A",
			sandbox_root: sandboxRoot(),
			命令超时毫秒: 4321,
			signal: controller.signal,
			verificationCommandRunner: runner,
		});
		expect(runner).toHaveBeenCalledOnce();
		expect(result.结论).toBe("未过");
		expect(existsSync(join(workDir, "executed"))).toBe(false);
		expect(loadCard(cardDir, 1).frontmatter.status).not.toBe("delivered");
	});
	it("同项目两次验收互不刷新或删除对方的副本与依赖联接", async () => {
		const repo = makeRepo();
		tempDirs.push(repo);
		mkdirSync(join(repo, "node_modules"));
		writeFileSync(join(repo, "node_modules", "dependency.txt"), "dependency");
		const root = sandboxRoot();
		const first = await refreshShadowSandbox(repo, { sandbox_root: root });
		writeFileSync(join(first.workDir, "first-running.txt"), "working");
		const second = await refreshShadowSandbox(repo, { sandbox_root: root });
		expect(second.workDir).not.toBe(first.workDir);
		expect(readFileSync(join(first.workDir, "first-running.txt"), "utf8")).toBe("working");
		settleSandbox(first.workDir, 1, true);
		expect(readFileSync(join(second.workDir, "node_modules", "dependency.txt"), "utf8")).toBe("dependency");
		settleSandbox(second.workDir, 2, false);
		expect(readFileSync(join(repo, "node_modules", "dependency.txt"), "utf8")).toBe("dependency");
	});
	it("npx 验收只允许本地工具，缺依赖不能临时安装另一个同名包", () => {
		expect(checkCommandSafety("npx tsc --noEmit").过).toBe(false);
		expect(checkCommandSafety("npx --no-install tsc --noEmit").过).toBe(true);
	});
	it.skipIf(process.platform !== "win32")(
		"验收命令中取消：真实父孙进程停止，后续命令和交付不发生，独立进程存活",
		async () => {
			const repo = makeRepo();
			tempDirs.push(repo);
			writeFileSync(
				join(repo, "cancel.cjs"),
				`const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',"require('node:fs').writeFileSync('ready','yes');setInterval(()=>require('node:fs').appendFileSync('ticks','x'),20)"],{stdio:'ignore'});fs.writeFileSync('pids',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`,
			);
			const { cardDir } = await makeClaimedCard(
				repo,
				"跑: node cancel.cjs\n跑: node -e \"require('fs').writeFileSync('after','bad')\"",
			);
			const root = sandboxRoot();
			let workDir = "";
			const independent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
			const controller = new AbortController();
			const operation = verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: root, signal: controller.signal });
			const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError" });
			try {
				const deadline = Date.now() + 10000;
				while (!workDir || !existsSync(join(workDir, "ready")) || !existsSync(join(workDir, "ticks"))) {
					const running = fs
						.readdirSync(root)
						.map((name) => join(root, name, "work"))
						.find((dir) => existsSync(join(dir, "pids")));
					if (running) workDir = running;
					if (Date.now() > deadline) throw new Error("真实验收孙进程未就绪");
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				const pids = JSON.parse(readFileSync(join(workDir, "pids"), "utf8")) as number[];
				controller.abort();
				await rejected;
				for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
				expect(() => process.kill(independent.pid!, 0)).not.toThrow();
				expect(existsSync(join(workDir, "after"))).toBe(false);
				expect(loadCard(cardDir, 1).frontmatter.status).toBe("in_progress");
				expect(loadCard(cardDir, 1).body).not.toContain("## 机械验收");
			} finally {
				controller.abort();
				await operation.catch(() => {});
				independent.kill();
			}
		},
		20000,
	);

	it("跑命令写入落在沙箱副本，真项目零污染；.env 与密钥不进沙箱；有败沙箱按卡保留", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(
			repo,
			"跑: node -e \"require('fs').writeFileSync('沙箱写入.txt','x'),process.exit(1)\"",
		);
		const root = sandboxRoot();
		const { result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: root });

		expect(result.结论).toBe("未过");
		expect(result.条目结果[0]?.结果).toBe("未过");
		// 有败保留沙箱（按卡命名）供主控排障
		expect(result.沙箱保留路径).toBeTruthy();
		const keep = result.沙箱保留路径!;
		expect(existsSync(keep)).toBe(true);
		expect(keep).toContain("卡0001");
		// 命令写在沙箱副本里，真项目没有
		expect(existsSync(join(keep, "沙箱写入.txt"))).toBe(true);
		expect(existsSync(join(repo, "沙箱写入.txt"))).toBe(false);
		// 源码拷进来了；.env 不拷（密钥不进沙箱）
		expect(existsSync(join(keep, "源.txt"))).toBe(true);
		expect(existsSync(join(keep, ".env"))).toBe(false);
		expect(existsSync(join(keep, "src", "代码.ts"))).toBe(true);
		// 真项目 .env 原封不动
		expect(readFileSync(join(repo, ".env"), "utf8")).toContain("SECRET_TOKEN");
	});

	it("全过删沙箱，不留残留副本", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(repo, '跑: node -e "process.exit(0)"');
		const root = sandboxRoot();
		const { result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: root });
		expect(result.结论).toBe("全过自动交付");
		expect(result.沙箱保留路径).toBeUndefined();
		// 项目影子目录已随全过收尾清理
		const shadowProject = join(root, repo.split(/[\\/]/).pop()!);
		expect(existsSync(join(shadowProject, "work"))).toBe(false);
	});

	it("node_modules 以目录联接指回真目录（免拷依赖，引用解析可用）", async () => {
		const repo = makeRepo();
		mkdirSync(join(repo, "node_modules", "fake-dep"), { recursive: true });
		writeFileSync(join(repo, "node_modules", "fake-dep", "package.json"), '{"name":"fake-dep"}');
		const root = sandboxRoot();
		const { workDir } = await refreshShadowSandbox(repo, { sandbox_root: root });
		expect(existsSync(join(workDir, "node_modules"))).toBe(true);
		expect(existsSync(join(workDir, "node_modules", "fake-dep", "package.json"))).toBe(true);
		// 联接不拷贝内容本身：安全删沙箱不穿透，真目录完好
		removeSandboxSafe(workDir);
		expect(existsSync(join(repo, "node_modules", "fake-dep", "package.json"))).toBe(true);
	}, 20000);
});

describe("junction 安全红线：删除不穿透（pnpm#10707 级事故教训）", () => {
	it("removeSandboxSafe 先解除链接再删，绝不穿透 junction 删真目录", () => {
		const external = tempDir("pao-verify-外部-");
		writeFileSync(join(external, "哨兵.txt"), "真目录的文件还在吗\n");
		const sandbox = join(tempDir("pao-verify-沙箱-"), "work");
		mkdirSync(join(sandbox, "子目录"), { recursive: true });
		writeFileSync(join(sandbox, "普通.txt"), "副本内容\n");
		writeFileSync(join(sandbox, "子目录", "深.txt"), "深\n");
		symlinkSync(external, join(sandbox, "node_modules"), "junction");
		// 哨兵预检：穿透读取能读到（联接活着）
		expect(existsSync(join(sandbox, "node_modules", "哨兵.txt"))).toBe(true);

		removeSandboxSafe(sandbox);

		expect(existsSync(sandbox)).toBe(false);
		expect(existsSync(join(external, "哨兵.txt"))).toBe(true);
		expect(readFileSync(join(external, "哨兵.txt"), "utf8")).toContain("还在");
	});

	it("settleSandbox 保留排障副本时解除联接，真 node_modules 完好", () => {
		const realNode = tempDir("pao-verify-真node-");
		writeFileSync(join(realNode, "哨兵.txt"), "x\n");
		const shadowProject = join(tempDir("pao-verify-影子-"), "proj");
		const work = join(shadowProject, "work");
		mkdirSync(work, { recursive: true });
		writeFileSync(join(work, "日志.txt"), "排障现场\n");
		symlinkSync(realNode, join(work, "node_modules"), "junction");

		const keep = settleSandbox(work, 7, true);

		expect(keep).toBeTruthy();
		expect(existsSync(join(keep!, "日志.txt"))).toBe(true);
		expect(existsSync(join(realNode, "哨兵.txt"))).toBe(true);
		// 保留副本不带活联接
		expect(existsSync(join(keep!, "node_modules"))).toBe(false);
	});
});

describe("机械核对三分结论与自动交付（§12.1 交付规则）", () => {
	it("自报 fail/not_run 转 owner 逐项复核，结果保留原始 verification 索引", async () => {
		const repo = makeRepo();
		const { cardDir, card } = await makeClaimedCard(repo, "存在: 源.txt");
		appendVerificationReceipt(card, [
			{ 条件: "通过", 结论: "pass", 证据: "已运行" },
			{ 条件: "覆盖率", 结论: "fail", 证据: "61%" },
			{ 条件: "人工清单", 结论: "not_run" },
		]);

		const { result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot() });

		expect(result.结论).toBe("全过停人工审");
		expect(result.自动交付).toBeUndefined();
		expect(result.自报未达项).toMatchObject([
			{ 尝试: 1, verification_index: 1, 条件: "覆盖率", 自报结论: "fail", 证据: "61%" },
			{ 尝试: 1, verification_index: 2, 条件: "人工清单", 自报结论: "not_run" },
		]);
		expect(loadCard(cardDir, 1).frontmatter.status).toBe("in_progress");
	});

	it("只认当前 attempt 的非归档回执；旧 attempt、归档与文件末尾历史都不能遮挡当前结果", async () => {
		const repo = makeRepo();
		const { cardDir, card } = await makeClaimedCard(repo, "存在: 源.txt");
		appendVerificationReceipt(card, [{ 条件: "旧尝试失败", 结论: "fail" }], "2026-10-20 09:00", 1);
		changeCardStatus(loadCard(cardDir, 1), {
			操作者: "部长A",
			to: "failed",
			失败类型: "transient",
			时间: "2026-10-20 09:10",
		});
		changeCardStatus(loadCard(cardDir, 1), {
			操作者: "部长A",
			to: "unclaimed",
			时间: "2026-10-20 09:11",
		});
		changeCardStatus(loadCard(cardDir, 1), {
			操作者: "部长A",
			to: "in_progress",
			时间: "2026-10-20 09:12",
		});
		appendVerificationReceipt(loadCard(cardDir, 1), [{ 条件: "当前尝试通过", 结论: "pass" }], "2026-10-20 09:20", 2);
		const current = loadCard(cardDir, 1);
		expect(current.frontmatter.attempt).toBe(2);
		expect(current.receipts.at(-1)?.archive_flag).toBeUndefined();
		// 文件末尾追加当前 attempt 的归档/历史回执，确认选择逻辑先按 attempt，再排除 archive_flag。
		const body = current.body.trimEnd();
		writeFileSync(
			current.path,
			serializeCard(
				current.frontmatter,
				`${body}\n\n## 回执 尝试1 2026-10-20 09:30\n- archive_flag: late_receipt\n- result: 完成\n- verification: [${JSON.stringify({ 条件: "归档失败", 结论: "fail" })}]\n\n## 回执 尝试2 2026-10-20 09:40\n- archive_flag: old_attempt\n- result: 完成\n- verification: [${JSON.stringify({ 条件: "同尝试归档失败", 结论: "fail" })}]\n`,
			),
		);

		const { result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot() });

		expect(result.结论).toBe("全过自动交付");
		expect(result.自动交付).toBe(true);
		expect(result.自报未达项).toEqual([]);
	});

	it("同一时间与事实的机械验收只保留一段，既有不同历史段不替换", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(repo, "存在: 源.txt");
		const time = "2026-10-20 10:00";
		await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot(), 时间: time });
		const first = loadCard(cardDir, 1).body;
		await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot(), 时间: time });
		const second = loadCard(cardDir, 1).body;

		expect(second).toBe(first);
		expect(first.match(/^## 机械验收 /gm)).toHaveLength(1);
	});

	it("混合机械句与人话句完全重复时只保留一段，并保留真实人话原文", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(repo, "存在: 源.txt\n叙事需人工审阅\n命名需人工复核");
		const time = "2026-10-20 10:00";
		const options = { operator: "部长A", sandbox_root: sandboxRoot(), 时间: time };
		await verifyCard(cardDir, 1, options);
		const first = loadCard(cardDir, 1).body;
		await verifyCard(cardDir, 1, options);
		const second = loadCard(cardDir, 1).body;

		expect(second).toBe(first);
		expect(first.match(/^## 机械验收 /gm)).toHaveLength(1);
		expect(first).toContain("- 人话句 2 条待主控审");
		expect(first).toContain(`- [人话句] ${JSON.stringify("叙事需人工审阅")}`);
		expect(first).toContain(`- [人话句] ${JSON.stringify("命名需人工复核")}`);
	});

	it("同一时间但结果不同保留两段，用后缀区分，不覆盖原验收历史", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(repo, "存在: 待生.txt");
		const time = "2026-10-20 10:00";
		const failed = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot(), 时间: time });
		expect(failed.result.结论).toBe("未过");
		writeFileSync(join(repo, "待生.txt"), "已生成\n");
		const passed = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot(), 时间: time });
		const body = loadCard(cardDir, 1).body;

		expect(passed.result.结论).toBe("全过自动交付");
		expect(body).toContain("## 机械验收 2026-10-20 10:00");
		expect(body).toContain("## 机械验收 2026-10-20 10:00 #2");
		expect(body).toContain("- 结论: 未过");
		expect(body).toContain("- 结论: 全过自动交付");
	});

	it("同 attempt 同时间但越界核查结论变化时保留新段；核查完全相同时仍幂等", async () => {
		const repo = makeRepo();
		const { cardDir, card } = await makeClaimedCard(repo, "存在: 产物.txt");
		await snapshotClaimBaseline(cardDir, card.card_no, {
			owner: "部长A",
			时间: "2026-10-20 10:00",
			验收: card.frontmatter.acceptance,
		});
		writeFileSync(join(repo, "产物.txt"), "产物\n");
		appendVerificationReceipt(card, [{ 条件: "报告", 结论: "pass" }]);
		const time = "2026-10-20 10:01";
		const options = { operator: "部长A", sandbox_root: sandboxRoot(), 时间: time };

		// 先落一条声明相符的越界核查；再制造真实越界，同时间调用必须新增历史。
		const firstReceipt = loadCard(cardDir, 1);
		appendReceipt(firstReceipt, {
			尝试号: 1,
			时间: "2026-10-20 10:00:30",
			结果: "完成",
			摘要: "声明产物",
			changes: [{ 路径: "产物.txt", 类型: "created" }],
		});
		await verifyCard(cardDir, 1, options);
		writeFileSync(join(repo, "未声明.txt"), "私货\n");
		await verifyCard(cardDir, 1, options);
		await verifyCard(cardDir, 1, options);
		const body = loadCard(cardDir, 1).body;

		expect(body).toContain("## 机械验收 2026-10-20 10:01");
		expect(body).toContain("## 机械验收 2026-10-20 10:01 #2");
		expect(body).not.toContain("## 机械验收 2026-10-20 10:01 #3");
		expect(body).toContain("- 越界核查: 干净");
		expect(body).toContain("- 越界核查: 越界");
	});

	it("当前尝试有内容基线但缺执行凭证时，公共验收入口拒绝退回旧兼容逻辑", async () => {
		const repo = makeRepo();
		const { cardDir, card } = await makeClaimedCard(repo, "存在: 源.txt");
		const baseline = await snapshotClaimBaseline(cardDir, card.card_no, {
			owner: "部长A",
			时间: "2026-10-20 10:00",
			验收: card.frontmatter.acceptance,
			attempt: card.frontmatter.attempt,
		});
		expect(baseline.可用).toBe(true);

		await expect(
			verifyCard(cardDir, card.card_no, { operator: "部长A", sandbox_root: sandboxRoot() }),
		).rejects.toMatchObject({
			name: "ExecutionContextError",
			code: "EXECUTION_CONTEXT_NOT_FOUND",
		});
		expect(loadCard(cardDir, card.card_no).frontmatter.status).toBe("in_progress");
	});

	it("纯机械全过 → 自动落已交付：状态/完成时间/审计段/派生验收段齐全", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(repo, "存在: 源.txt\n包含: 源.txt :: 影子沙箱");
		const { card, result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot() });

		expect(result.结论).toBe("全过自动交付");
		expect(result.自动交付).toBe(true);
		expect(card.frontmatter.status).toBe("delivered");
		expect(card.frontmatter.completed).toBeTruthy();
		expect(card.body).toContain("## 机械验收");
		expect(card.body).toContain("- 结论: 全过自动交付");
		expect(card.body).toContain("状态改为 delivered"); // owner 审计段（经 statemachine，单写者校验过）
		// 14 字段协议不动：frontmatter 键集合不因验收新增
		expect(Object.keys(card.frontmatter)).not.toContain("验收条目");
	});

	it("混有人话句：机械部分全过也停给主控审，不自动交付", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(repo, '跑: node -e "process.exit(0)"\n命名统一需人工复核');
		const { card, result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot() });

		expect(result.结论).toBe("全过停人工审");
		expect(result.自动交付).toBeUndefined();
		expect(card.frontmatter.status).toBe("in_progress");
		expect(card.body).toContain("人话句 1 条待主控审");
	});

	it("存在句未过 → 结论未过，状态不动，结构化结果留 owner", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(repo, "存在: 不存在的产物.txt");
		const { card, result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot() });

		expect(result.结论).toBe("未过");
		expect(result.条目结果[0]).toMatchObject({ 类型: "存在", 结果: "未过" });
		expect(result.条目结果[0]?.说明).toContain(`项目根 ${repo}`);
		expect(result.条目结果[0]?.说明).toContain(`实际路径 ${join(repo, "不存在的产物.txt")}`);
		expect(result.条目结果[0]?.说明).toContain("ENOENT");
		expect(card.frontmatter.status).toBe("in_progress");
	});

	it("安检拦截算未过：删除类命令执行前被拦，不进沙箱", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(repo, "跑: rm -rf src");
		const { result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot() });

		expect(result.结论).toBe("未过");
		expect(result.条目结果[0]).toMatchObject({ 结果: "安检拦截" });
		expect(result.条目结果[0]?.说明).toContain("删除");
		expect(existsSync(join(repo, "src"))).toBe(true); // 真项目安然无恙
	});

	it("纯人话句卡 → 无法机械判，留 owner（人工/审查口径）", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(repo, "测试全绿\n代码评审过目");
		const { card, result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot() });

		expect(result.结论).toBe("无法机械判");
		expect(result.条目结果).toEqual([]);
		expect(result.人话句).toHaveLength(2);
		expect(card.frontmatter.status).toBe("in_progress");
		expect(card.body).toContain("- 结论: 无法机械判");
	});

	it("缺 worker JSON/结果未知时明确成果待复核，引导 pao_change_status + basis，不当作成功", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(repo, "测试全绿\n代码评审过目");
		const tools = setup(cardDir, sandboxRoot());
		const out = await tools.get("pao_verify_card")!.execute("t1", { card_ref: 1, operator: "部长A" });
		const text = out.content[0].text;

		expect(text).toContain("结果未知");
		expect(text).toContain("成果待 owner 复核");
		expect(text).toContain("pao_change_status");
		expect(text).toContain("basis");
		expect(text).not.toContain("已自动落已交付");
	});

	it("项目含指向外部的链接 → 跑命令无法判、拒绝自动验收并亮明原因（R16）", async () => {
		const repo = makeRepo();
		const external = tempDir("pao-verify-外部链接-");
		writeFileSync(join(external, "外面.txt"), "外部内容\n");
		symlinkSync(external, join(repo, "外链"), "junction");
		const { cardDir } = await makeClaimedCard(repo, '跑: node -e "process.exit(0)"');
		const { result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot() });

		expect(result.结论).toBe("无法机械判");
		expect(result.条目结果[0]?.结果).toBe("无法判");
		expect(result.条目结果[0]?.说明).toContain("拒绝自动验收");
		expect(result.自动交付).toBeUndefined();
	}, 20000);

	it("新一轮验收不能用旧副本的已删除文件放行", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(
			repo,
			"跑: node -e \"process.exit(require('fs').existsSync('源.txt')?0:1)\"\n存在: 源.txt",
		);
		// 旧副本曾包含该文件；新一轮验收必须反映当前项目已删除的事实。
		const root = sandboxRoot();
		await refreshShadowSandbox(repo, { sandbox_root: root });
		rmSync(join(repo, "源.txt"));
		const { result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: root });
		expect(result.条目结果[0]).toMatchObject({ 类型: "跑", 结果: "未过" });
		expect(result.条目结果[1]).toMatchObject({ 类型: "存在", 结果: "未过" });
		expect(result.结论).toBe("未过");
	}, 20000);
});

describe("存在/包含读侧路径安检（与跑命令安检门同等级，R16）", () => {
	it("包含 ../../ 越界读被拦：条目安检拦截，读不到项目根外的哨兵内容", async () => {
		const outer = tempDir();
		writeFileSync(join(outer, "越界哨兵.txt"), "越界内容\n");
		const repo = makeRepo("pao-verify-", outer);
		const { cardDir } = await makeClaimedCard(repo, "包含: ../../越界哨兵.txt :: 越界内容");
		const { result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot() });

		expect(result.结论).toBe("未过");
		expect(result.条目结果[0]).toMatchObject({ 类型: "包含", 结果: "安检拦截" });
		expect(result.条目结果[0]?.说明).toContain("项目根");
	});

	it("存在 ../ 越界命中根外文件被拦（旧口径 existsSync 可读到项目根外）", async () => {
		const outer = tempDir();
		writeFileSync(join(outer, "越界哨兵.txt"), "越界内容\n");
		const repo = makeRepo("pao-verify-", outer);
		const { cardDir } = await makeClaimedCard(repo, "存在: ../越界哨兵.txt");
		const { result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot() });

		expect(result.结论).toBe("未过");
		expect(result.条目结果[0]).toMatchObject({ 类型: "存在", 结果: "安检拦截" });
	});

	it("反斜杠、盘符、嵌套 .. 变体均拦：条目判失败不崩（fail-closed）", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(
			repo,
			["存在: ..\\源.txt", "存在: C:\\源.txt", "包含: src\\..\\..\\源.txt :: PAO", "存在: src/../../源.txt"].join(
				"\n",
			),
		);
		const { result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot() });

		expect(result.结论).toBe("未过");
		expect(result.条目结果).toHaveLength(4);
		for (const r of result.条目结果) expect(r.结果).toBe("安检拦截");
		expect(result.条目结果[0]?.说明).toContain(`项目根 ${repo}`);
	});

	it("项目根内的相对 ..（如 src/../源.txt）不误伤，照常核对", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(repo, "存在: src/../源.txt");
		const { result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot() });

		expect(result.结论).toBe("全过自动交付");
		expect(result.条目结果[0]).toMatchObject({ 类型: "存在", 结果: "过" });
	});

	it("包含缺文件明确 ENOENT、项目根和实际路径；目录不是普通文件时不冒充 ENOENT", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(repo, "包含: 缺失.txt :: 内容\n包含: src :: 内容");
		const { result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot() });

		expect(result.条目结果[0]?.结果).toBe("未过");
		expect(result.条目结果[0]?.说明).toContain("ENOENT，文件不存在");
		expect(result.条目结果[0]?.说明).toContain(`项目根 ${repo}`);
		expect(result.条目结果[0]?.说明).toContain(`实际路径 ${join(repo, "缺失.txt")}`);
		expect(result.条目结果[1]?.结果).toBe("未过");
		expect(result.条目结果[1]?.说明).toContain("目标不是普通文件");
		expect(result.条目结果[1]?.说明).toContain(`项目根 ${repo}`);
		expect(result.条目结果[1]?.说明).toContain(`实际路径 ${join(repo, "src")}`);
		expect(result.条目结果[1]?.说明).not.toContain("ENOENT");
	});
});

describe("项目根推导口径（与 cardfile.projectRootForCards 一致）", () => {
	it("非 git 任务工作区（.pao/<任务>/卡）：存在句对项目根核对，不再错取 .pao 为根", async () => {
		const repo = tempDir("pao-verify-ws-");
		writeFileSync(join(repo, "源.txt"), "PAO 影子沙箱测试项目\n");
		const cardDir = join(repo, ".pao", "任务A", "卡");
		mkdirSync(cardDir, { recursive: true });
		const card = await createCard(cardDir, {
			目标: "非git根卡",
			部门: "核心机制",
			验收: "存在: 源.txt",
			创建: "2026-10-02 10:00",
		});
		changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-02 10:01" });

		const { result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot() });

		expect(result.结论).toBe("全过自动交付");
		expect(result.条目结果[0]).toMatchObject({ 类型: "存在", 摘要: "源.txt", 结果: "过" });
	});
});

describe("跑命令超时树杀（复用 worker/kill.killTree）", () => {
	it("超时判 124 且不悬挂；Windows 下孙进程随整棵进程树终止不残留", async () => {
		const repo = makeRepo();
		const pidPath = join(repo, "孙进程.pid");
		writeFileSync(
			join(repo, "孙进程.js"),
			`require("fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));setInterval(function(){},60000);`,
		);
		const { cardDir } = await makeClaimedCard(
			repo,
			"跑: node -e \"require('child_process').spawn(process.execPath,['孙进程.js'],{stdio:'ignore'}),setInterval(function(){},60000)\"",
		);
		const { result } = await verifyCard(cardDir, 1, {
			operator: "部长A",
			sandbox_root: sandboxRoot(),
			命令超时毫秒: 1500,
		});

		expect(result.结论).toBe("未过");
		expect(result.条目结果[0]).toMatchObject({ 类型: "跑", 结果: "未过" });
		expect(result.条目结果[0]?.说明).toContain("超时");
		// 树杀只保证 Windows（killTree POSIX 侧孙进程可能残留，见 kill.ts 交付说明）
		if (process.platform === "win32") {
			const pid = Number(readFileSync(pidPath, "utf8"));
			expect(pid).toBeGreaterThan(0);
			let gone = false;
			const deadline = Date.now() + 10000;
			while (Date.now() < deadline) {
				try {
					process.kill(pid, 0);
					await new Promise((r) => setTimeout(r, 200));
				} catch {
					gone = true;
					break;
				}
			}
			expect(gone).toBe(true);
		}
	}, 30000);
});

describe("Python 字节码缓存隔离（真实解释器）", () => {
	const python = process.platform === "win32" ? "python" : "python3";

	function matchingFiles(root: string, matches: (name: string) => boolean): string[] {
		const found: string[] = [];
		const walk = (dir: string) => {
			for (const name of fs.readdirSync(dir)) {
				const path = join(dir, name);
				const stat = fs.lstatSync(path);
				if (stat.isDirectory()) walk(path);
				else if (matches(name)) found.push(path);
			}
		};
		if (existsSync(root)) walk(root);
		return found;
	}

	it("py_compile、import、嵌套子进程共用沙箱缓存，凭证不可见且真仓库零污染", async () => {
		const repo = makeRepo();
		tempDirs.push(repo);
		writeFileSync(join(repo, "demo.py"), "VALUE = 42\n");
		writeFileSync(
			join(repo, "nested_probe.py"),
			[
				"import json, os, subprocess, sys",
				"result = subprocess.run([sys.executable, '-c', 'import demo'], check=False)",
				"probe = {",
				"  'pycache_prefix': sys.pycache_prefix,",
				"  'env_prefix': os.environ.get('PYTHONPYCACHEPREFIX'),",
				"  'credential': os.environ.get('PAO_CREDENTIAL_PROBE'),",
				"  'child_returncode': result.returncode,",
				"}",
				"open('python-probe.json', 'w', encoding='utf-8').write(json.dumps(probe))",
				"",
			].join("\n"),
		);
		const { cardDir } = await makeClaimedCard(
			repo,
			[
				`跑: ${python} -m py_compile demo.py`,
				`跑: ${python} -c "import demo"`,
				`跑: ${python} nested_probe.py`,
				`跑: ${python} -c "raise SystemExit(7)"`,
			].join("\n"),
		);
		const previousCredential = process.env.PAO_CREDENTIAL_PROBE;
		process.env.PAO_CREDENTIAL_PROBE = "不得进入验收进程";
		try {
			const { result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot() });

			expect(result.结论).toBe("未过");
			expect(result.条目结果.map((entry) => entry.结果)).toEqual(["过", "过", "过", "未过"]);
			const keep = result.沙箱保留路径!;
			expect(keep && existsSync(keep)).toBe(true);
			const probe = JSON.parse(readFileSync(join(keep, "python-probe.json"), "utf8")) as {
				pycache_prefix: string;
				env_prefix: string;
				credential: string | null;
				child_returncode: number;
			};
			expect(probe.pycache_prefix).toBe(probe.env_prefix);
			expect(probe.pycache_prefix).toContain("python-cache-");
			expect(probe.credential).toBeNull();
			expect(probe.child_returncode).toBe(0);
			expect(matchingFiles(keep, (name) => name.endsWith(".pyc")).length).toBeGreaterThan(0);
			expect(existsSync(join(keep, ".env"))).toBe(false);
			expect(readFileSync(join(repo, ".env"), "utf8")).toBe("SECRET_TOKEN=绝不能进沙箱\n");
			expect(matchingFiles(repo, (name) => name.endsWith(".pyc") || name === "__pycache__")).toEqual([]);
		} finally {
			if (previousCredential === undefined) delete process.env.PAO_CREDENTIAL_PROBE;
			else process.env.PAO_CREDENTIAL_PROBE = previousCredential;
		}
	}, 30000);

	it("Python 子进程成功也不能掩盖真实源码未声明越界", async () => {
		const repo = makeRepo();
		tempDirs.push(repo);
		const { cardDir, card } = await makeClaimedCard(repo, `跑: ${python} -c "import sys"`);
		const baseline = await snapshotClaimBaseline(cardDir, card.card_no, {
			owner: "部长A",
			时间: "2026-10-24 10:00",
			验收: card.frontmatter.acceptance,
		});
		expect(baseline.可用).toBe(true);
		writeFileSync(join(repo, "产物.txt"), "已声明产物\n");
		writeFileSync(join(repo, "未声明.py"), "VALUE = 1\n");
		appendReceipt(loadCard(cardDir, 1), {
			尝试号: 1,
			时间: "2026-10-24 10:01",
			结果: "完成",
			摘要: "只声明已声明产物",
			changes: [{ 路径: "产物.txt", 类型: "created" }],
		});

		const { result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot() });

		expect(result.条目结果[0]).toMatchObject({ 类型: "跑", 结果: "过" });
		expect(result.越界核查?.结论).toBe("越界");
		expect(result.越界核查?.越界.join("\n")).toContain("未声明.py");
		expect(result.自动交付).toBeUndefined();
		expect(loadCard(cardDir, 1).frontmatter.status).toBe("in_progress");
		expect(matchingFiles(repo, (name) => name.endsWith(".pyc") || name === "__pycache__")).toEqual([]);
	}, 30000);
});

// ── pao_verify_card 工具接线 ──────────────────────────────────────────────────────

interface ToolDef {
	execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
}

function setup(cardDir: string, sandboxRoot: string) {
	const tools = new Map<string, ToolDef>();
	const pi = {
		registerTool: (def: { name: string; execute: ToolDef["execute"] }) =>
			tools.set(def.name, { execute: def.execute }),
		registerCommand: () => {},
		sendMessage: () => {},
		on: () => {},
	};
	registerVerifierTools(pi as never, { resolveCardsDir: () => cardDir, sandbox_root: sandboxRoot });
	return tools;
}

describe("pao_verify_card 工具接线", () => {
	it("全过自动交付：工具文本带结论、交付说明与落卡位置", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(repo, "存在: 源.txt");
		const root = sandboxRoot();
		const tools = setup(cardDir, root);
		const out = await tools.get("pao_verify_card")!.execute("t1", { card_ref: 1, operator: "部长A" });
		const text = out.content[0].text;
		expect(text).toContain("全过自动交付");
		expect(text).toContain("已自动落已交付");
		expect(text).toContain("派生段");
	});

	it("未过：工具文本带逐条结构化结果与 owner 处置指引", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(repo, "存在: 缺失.txt");
		const tools = setup(cardDir, sandboxRoot());
		const out = await tools.get("pao_verify_card")!.execute("t1", { card_ref: 1, operator: "部长A" });
		const text = out.content[0].text;
		expect(text).toContain("未过");
		expect(text).toContain("ENOENT");
		expect(text).toContain(`项目根 ${repo}`);
		expect(text).toContain(`实际路径 ${join(repo, "缺失.txt")}`);
		expect(text).toContain("请 owner 修复问题后重新验收");
	});

	it("非 owner 调用自动交付被单写者校验拒绝，机械结果照常落卡", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(repo, "存在: 源.txt");
		const tools = setup(cardDir, sandboxRoot());
		await expect(tools.get("pao_verify_card")!.execute("t1", { card_ref: 1, operator: "冒名者" })).rejects.toThrow(
			/FORBIDDEN_WRITER|只有 owner/,
		);
	}, 20000);
});
