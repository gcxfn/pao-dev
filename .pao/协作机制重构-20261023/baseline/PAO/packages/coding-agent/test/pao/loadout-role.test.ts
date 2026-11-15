/**
 * M1-04 角色装载门控(R10/G1-12):PAO_ROLE=worker 的会话在扩展注册层跳过
 * 派发/全库管理/自动推进/后台管理类模块;主控注册面完整。含 WorkerRunner 对
 * 子进程的角色强制注入(直接+间接入口都验:工具、命令、事件钩子)。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listPaoSubcommands, resetPaoSubcommandsForTest } from "../../src/pao/command-router.ts";
import paoExtension from "../../src/pao/index.ts";
import { MINISTER_SKIPPED_MODULES, PAO_ROLE_ENV, resolvePaoRole, WORKER_SKIPPED_MODULES } from "../../src/pao/role.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-loadout-"));
	tempDirs.push(dir);
	return dir;
}

/** 带合法两档配置的 PAO_HOME(registerTiers 在两个角色下都应注册成功);
 * 记忆供应商给最小合法配置——worker 面断言零工具才有区分度:缺席必须源于角色门控,不是配置缺失 */
function tempPaoHome(): string {
	const home = tempDir();
	mkdirSync(join(home, "pao配置"), { recursive: true });
	writeFileSync(
		join(home, "pao配置", "档位.json"),
		JSON.stringify({ 档位: [{ 名: "快", provider: "faux", model: "m", thinkingLevel: "low" }] }),
		"utf8",
	);
	writeFileSync(join(home, "pao配置", "记忆供应商.json"), JSON.stringify({ 供应商: "mnemosyne" }), "utf8");
	return home;
}

/** 记录型 mock(与 wiring-smoke 同款) */
function mockPi() {
	const tools: string[] = [];
	const toolDefinitions: Array<{ name: string; defaultActive?: boolean }> = [];
	const commands: string[] = [];
	const events: string[] = [];
	const models: string[] = [];
	return {
		tools,
		toolDefinitions,
		commands,
		events,
		models,
		pi: {
			registerTool: (tool: { name: string; defaultActive?: boolean }) => {
				tools.push(tool.name);
				toolDefinitions.push(tool);
			},
			registerCommand: (name: string) => void commands.push(name),
			registerVirtualModel: (model: { id: string }) => void models.push(model.id),
			registerMessageRenderer: () => undefined,
			on: (event: string) => void events.push(event),
			sendMessage: () => undefined,
		},
	};
}

describe("PAO 角色解析", () => {
	it("未设置/主控值 → 主控;worker(大小写/空白)→ worker;部长(中文/英文)→ 部长", () => {
		expect(resolvePaoRole({})).toBe("主控");
		expect(resolvePaoRole({ [PAO_ROLE_ENV]: "主控" })).toBe("主控");
		expect(resolvePaoRole({ [PAO_ROLE_ENV]: "worker" })).toBe("worker");
		expect(resolvePaoRole({ [PAO_ROLE_ENV]: " WORKER " })).toBe("worker");
		expect(resolvePaoRole({ [PAO_ROLE_ENV]: "master" })).toBe("主控");
		expect(resolvePaoRole({ [PAO_ROLE_ENV]: "部长" })).toBe("部长");
		expect(resolvePaoRole({ [PAO_ROLE_ENV]: " Minister " })).toBe("部长");
	});

	it("worker 跳过清单覆盖派发/全库管理/自动推进/后台管理/主控诊断类模块", () => {
		for (const module of [
			"cards",
			"collab",
			"worker",
			"cleanup",
			"dept",
			"knowledge",
			"fanout",
			"healthcheck",
			"delivery",
			"worktrees",
			"workflow",
		]) {
			expect(WORKER_SKIPPED_MODULES).toContain(module);
		}
	});

	it("部长跳过清单只含扇出、协作中转、宿主与常驻记忆门面(中转是主控专属路由器;拉起/散场部长是主控唯一唤醒源;§18.1 注入面是主控门面)", () => {
		expect([...MINISTER_SKIPPED_MODULES].sort()).toEqual(["collab", "fanout", "host", "resident"]);
	});
});

describe("worker 会话装载面(扩展注册层跳过,非藏提示词)", () => {
	it("PAO_ROLE=worker 且注入宿主:仍无 worktree/整合/普通 append 管理面，只留侦察保存与执行步骤工具", async () => {
		vi.stubEnv(PAO_ROLE_ENV, "worker");
		const home = tempPaoHome();
		vi.stubEnv("PAO_HOME", home);
		resetPaoSubcommandsForTest();
		const mock = mockPi();
		const { createSingleRootWorktreeHost } = await import("../../src/pao/worktrees/index.ts");
		paoExtension(mock.pi as never, {
			resolvePaoHome: () => home,
			worktreeHost: createSingleRootWorktreeHost(tempDir()),
		});
		// S8 会话 todo 是执行步骤工具(非 pao_ 派发/管理面),worker 也注册——回执对账(S8.4)
		// 正依赖 worker 会话有 todo。read 是同一内置工具的增强覆盖，默认不激活。
		// 侦察保存是唯一 pao_ 写工具；宿主存在也不能让 worker 管理工作树。
		expect(mock.tools).toEqual(["read", "todo_write", "pao_save_dispatch_recon"]);
		expect(mock.toolDefinitions.find((tool) => tool.name === "read")?.defaultActive).toBe(false);
		for (const name of [
			"pao_worktree_create",
			"pao_worktree_list",
			"pao_worktree_cleanup",
			"pao_integrate_delivery",
			"pao_dispatch_brief",
			"pao_create_card",
			"pao_change_status",
			"pao_submit_receipt",
		])
			expect(mock.tools).not.toContain(name);
		expect(mock.commands).toEqual([]);
		expect(listPaoSubcommands(mock.pi as never)).toHaveLength(0);
		expect(mock.models).toEqual(["快"]);
		// 间接入口随模块消失:worker 模块的 session_shutdown 停后台钩子不再注册;
		// session_shutdown 七项：任务快照清理、预压缩取消与费用收齐、用量结账、todo 状态清理、
		// 停止活动观察、后台生命周期清理、释放后台宿主，
		// 均不是派发后台管理。
		// session_start(品牌指示器＋页脚记账重置;档位失注册守卫只读警告)
		expect(mock.events.filter((event) => event === "session_shutdown")).toEqual([
			"session_shutdown",
			"session_shutdown",
			"session_shutdown",
			"session_shutdown",
			"session_shutdown",
			"session_shutdown",
			"session_shutdown",
		]);
		expect(mock.events).toContain("session_start");
	});

	it("PAO_ROLE=部长:去扇出/协作中转/宿主/常驻记忆门面,其余 owner 面全保留(含记忆三工具与 queue 子命令)", () => {
		vi.stubEnv(PAO_ROLE_ENV, "部长");
		const home = tempPaoHome();
		vi.stubEnv("PAO_HOME", home);
		resetPaoSubcommandsForTest();
		const mock = mockPi();
		return import("../../src/pao/worktrees/index.ts").then(({ createSingleRootWorktreeHost }) => {
			paoExtension(mock.pi as never, {
				resolvePaoHome: () => home,
				worktreeHost: createSingleRootWorktreeHost(tempDir()),
			});
			// 去的三个:fanout 的 pao_fanout、collab 的 pao_collab_relay 与 派 命令、host 的拉起/散场部长
			expect(mock.tools).not.toContain("pao_fanout");
			expect(mock.tools).not.toContain("pao_collab_relay");
			expect(mock.tools).not.toContain("pao_spawn_minister");
			expect(mock.tools).not.toContain("pao_dismiss_minister");
			expect(listPaoSubcommands(mock.pi as never).map((sub) => sub.name)).not.toContain("collab"); // collab 子命令随模块消失
			// 保留的 owner 面:卡终态、全库、记忆插拔、worker 派遣登记面、部门
			for (const name of [
				"pao_create_card",
				"pao_change_status",
				"pao_query_kb",
				"pao_ingest_kb",
				"pao_memory_write",
				"pao_memory_recall",
				"pao_memory_forget",
				"pao_inventory",
				"pao_stop_background",
				"pao_create_dept",
				"pao_integrate_delivery",
			]) {
				expect(mock.tools).toContain(name);
			}
			expect(mock.commands).toContain("pao");
			expect(listPaoSubcommands(mock.pi as never).map((sub) => sub.name)).toContain("queue");
			expect(mock.models).toEqual(["快"]);
		});
	});

	it("主控(默认):全部工具与命令注册齐全(与接线冒烟同口径)", () => {
		vi.stubEnv(PAO_ROLE_ENV, "");
		const home = tempPaoHome();
		vi.stubEnv("PAO_HOME", home);
		resetPaoSubcommandsForTest();
		const mock = mockPi();
		return import("../../src/pao/worktrees/index.ts").then(({ createSingleRootWorktreeHost }) => {
			paoExtension(mock.pi as never, {
				resolvePaoHome: () => home,
				worktreeHost: createSingleRootWorktreeHost(tempDir()),
			});
			for (const name of [
				"pao_create_card",
				"pao_submit_receipt",
				"pao_change_status",
				"pao_query_queue",
				"pao_collab_relay",
				"pao_inventory",
				"pao_stop_background",
				"pao_query_kb",
				"pao_restricted_query",
				"pao_ingest_kb",
				"pao_inspect_kb",
				"pao_create_dept",
				"pao_fanout",
				"pao_integrate_delivery",
			]) {
				expect(mock.tools).toContain(name);
			}
			expect(mock.commands).toContain("pao");
			// 唯一 pao 命令＋S8-TUI1 /todo(待办常驻摘要的展开/收起切换,计划 §S8 条 6 授权;worker 侧
			// 随 todo-summary 模块跳过,零命令纪律不变)。
			expect(mock.commands.filter((name) => name !== "pao" && name !== "todo")).toEqual([]);
			expect(
				listPaoSubcommands(mock.pi as never)
					.map((sub) => sub.name)
					.sort(),
			).toEqual([
				// H0-B 总预算人工巡检：只挂命令面，worker 侧整模块跳过（见 WORKER_SKIPPED_MODULES）
				"budget",
				"collab",
				"context",
				"flow",
				"memory",
				"model",
				"pano",
				"pending",
				"preflight",
				"queue",
				"recipe-del",
				"runtime",
				"status",
			]);
			expect(mock.models).toEqual(["快"]);
		});
	});
});

describe("WorkerRunner 对子进程的角色强制注入", () => {
	const ARGV_ENV_SCRIPT = `
require("node:fs").writeFileSync(process.env.PAO_ENV_OUT, JSON.stringify({ PAO_ROLE: process.env.PAO_ROLE, PAO_ENV_PROBE: process.env.PAO_ENV_PROBE }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, stopReason: "end" } }));
`;

	it("默认强制 PAO_ROLE=worker(主控忘了设也不是主控面)", async () => {
		vi.stubEnv(PAO_ROLE_ENV, ""); // 主控进程自身未设角色
		const dir = tempDir();
		const script = join(dir, "env-dump.cjs");
		writeFileSync(script, ARGV_ENV_SCRIPT, "utf8");
		const runner = new WorkerRunner();
		const receipt = await runner.run({
			卡号: "9001",
			提示词: "角色注入",
			命令: process.execPath,
			参数: [script],
			环境变量: { PAO_ENV_OUT: join(dir, "env.json") },
		});
		expect(receipt.status).toBe("success");
		const dumped = JSON.parse(
			await import("node:fs/promises").then((fs) => fs.readFile(join(dir, "env.json"), "utf8")),
		);
		expect(dumped.PAO_ROLE).toBe("worker");
	});

	it("显式环境不能覆盖 worker 角色，其他环境变量正常透传", async () => {
		const dir = tempDir();
		const script = join(dir, "env-dump2.cjs");
		writeFileSync(script, ARGV_ENV_SCRIPT, "utf8");
		const runner = new WorkerRunner();
		const receipt = await runner.run({
			卡号: "9002",
			提示词: "验证角色与环境透传",
			命令: process.execPath,
			参数: [script],
			环境变量: { PAO_ENV_OUT: join(dir, "env2.json"), [PAO_ROLE_ENV]: "主控", PAO_ENV_PROBE: "测试透传值" },
		});
		expect(receipt.status).toBe("success");
		const dumped = JSON.parse(
			await import("node:fs/promises").then((fs) => fs.readFile(join(dir, "env2.json"), "utf8")),
		);
		expect(dumped.PAO_ROLE).toBe("worker");
		expect(dumped.PAO_ENV_PROBE).toBe("测试透传值");
	});
});
