import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCard, loadCard } from "../../src/pao/cards/cardfile.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import type { ParsedCard } from "../../src/pao/cards/types.ts";
import {
	refreshShadowSandbox,
	registerVerifierTools,
	removeSandboxSafe,
	settleSandbox,
	verifyCard,
} from "../../src/pao/cards/verifier.ts";

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

describe("影子沙箱（§12.2）：拷贝面与隔离", () => {
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
			const { workDir } = await refreshShadowSandbox(repo, { sandbox_root: root });
			const independent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
			const controller = new AbortController();
			const operation = verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: root, signal: controller.signal });
			const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError" });
			try {
				const deadline = Date.now() + 10000;
				while (!existsSync(join(workDir, "ready")) || !existsSync(join(workDir, "ticks"))) {
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
		expect(result.条目结果[0]).toMatchObject({ 类型: "存在", 结果: "未过", 说明: "文件不存在" });
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

	it("跑命令读沙箱副本而非真项目：真项目文件被删除后命令仍能看到拷贝时点快照", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(
			repo,
			"跑: node -e \"process.exit(require('fs').existsSync('源.txt')?0:1)\"\n存在: 源.txt",
		);
		// 先刷新一次沙箱（把 源.txt 拷进去），再删真项目文件，跑命令仍应看到副本里的 源.txt
		const root = sandboxRoot();
		await refreshShadowSandbox(repo, { sandbox_root: root });
		rmSync(join(repo, "源.txt"));
		const { result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: root });
		// 跑命令在副本里找到 源.txt → 过；存在句直查真项目 → 未过（两核对面隔离的正确性）
		expect(result.条目结果[0]).toMatchObject({ 类型: "跑", 结果: "过" });
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
	});

	it("项目根内的相对 ..（如 src/../源.txt）不误伤，照常核对", async () => {
		const repo = makeRepo();
		const { cardDir } = await makeClaimedCard(repo, "存在: src/../源.txt");
		const { result } = await verifyCard(cardDir, 1, { operator: "部长A", sandbox_root: sandboxRoot() });

		expect(result.结论).toBe("全过自动交付");
		expect(result.条目结果[0]).toMatchObject({ 类型: "存在", 结果: "过" });
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
		expect(text).toContain("文件不存在");
		expect(text).toContain("owner 复核");
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
