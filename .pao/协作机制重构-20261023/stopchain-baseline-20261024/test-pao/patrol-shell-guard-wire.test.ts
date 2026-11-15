/**
 * 巡库 shell 护栏接线验收（需求 §6 预案①，M2-05 无人值守硬前置）：
 * registerShellGuard 三态（未装/装上后 bash 拒绝与放行/powershell 同门）＋
 * buildDispatchRunOptions 巡库卡注入 锁定工作区（非巡库卡不注入）＋
 * runner env 转发（锁定工作区 → PAO_SHELL_GUARD_WORKSPACE）。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ParsedCard } from "../../src/pao/cards/types.ts";
import { isPatrolGoal } from "../../src/pao/patrol/draft.ts";
import { registerShellGuard, SHELL_GUARD_ENV } from "../../src/pao/patrol/wire.ts";
import { buildDispatchRunOptions } from "../../src/pao/worker/dispatch-core.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

interface ToolCallRecord {
	toolName: string;
	input: { command: string };
}

function mockPi() {
	const handlers = new Map<string, (event: never) => unknown>();
	const events: string[] = [];
	return {
		events,
		handlers,
		pi: {
			on: (event: string, handler?: (event: never) => unknown) => {
				events.push(event);
				if (handler) handlers.set(event, handler);
			},
		},
	};
}

function fireToolCall(
	mock: ReturnType<typeof mockPi>,
	call: ToolCallRecord,
): { block?: boolean; reason?: string } | undefined {
	return mock.handlers.get("tool_call")?.(call as never) as { block?: boolean; reason?: string } | undefined;
}

describe("registerShellGuard：env 门控注册", () => {
	it("显式 env 未设值与空串都不装（零行为：不挂 tool_call 钩子）", () => {
		for (const env of [{}, { [SHELL_GUARD_ENV]: "" }, { [SHELL_GUARD_ENV]: "   " }]) {
			const mock = mockPi();
			expect(registerShellGuard(mock.pi as never, { env })).toBe(false);
			expect(mock.events).toEqual([]);
		}
	});

	it("生产形态（不传 options）：env 缺省回退 process.env——未设不装，设了才装", () => {
		const saved = process.env[SHELL_GUARD_ENV];
		try {
			delete process.env[SHELL_GUARD_ENV];
			const off = mockPi();
			expect(registerShellGuard(off.pi as never)).toBe(false);
			expect(off.events).toEqual([]);
			process.env[SHELL_GUARD_ENV] = "D:\\pao-ws\\巡库";
			const on = mockPi();
			expect(registerShellGuard(on.pi as never)).toBe(true);
			expect(on.events).toEqual(["tool_call"]);
		} finally {
			if (saved === undefined) delete process.env[SHELL_GUARD_ENV];
			else process.env[SHELL_GUARD_ENV] = saved;
		}
	});

	it("env 设了才装：装上返回 true 并挂 tool_call 钩子", () => {
		const mock = mockPi();
		expect(registerShellGuard(mock.pi as never, { env: { [SHELL_GUARD_ENV]: "D:\\ws" } })).toBe(true);
		expect(mock.events).toEqual(["tool_call"]);
	});

	it("工作区直供优先于 env（测试注入口）", () => {
		const mock = mockPi();
		expect(registerShellGuard(mock.pi as never, { env: {}, 工作区: "D:\\直供" })).toBe(true);
	});
});

describe("registerShellGuard：门禁行为（真调 审查Shell命令）", () => {
	const workspaceDir = "D:\\pao-ws\\巡库";

	function installGuard() {
		const mock = mockPi();
		registerShellGuard(mock.pi as never, { 工作区: workspaceDir, env: {} });
		return mock;
	}

	it("工作区内命令放行（返回 undefined 不拦截）", () => {
		const mock = installGuard();
		expect(fireToolCall(mock, { toolName: "bash", input: { command: "cat 教训/a.md && ls 做法" } })).toBeUndefined();
		expect(
			fireToolCall(mock, { toolName: "bash", input: { command: `type ${workspaceDir}\\教训\\a.md` } }),
		).toBeUndefined();
	});

	it("越界与敏感命令 block，reason 带 pao 巡库护栏口径", () => {
		const mock = installGuard();
		for (const command of [
			"cat C:\\Windows\\system32\\config\\sam", // 系统目录
			"cat .env", // 敏感文件名（相对也算）
			"cat ../../库外.md", // 粘连 .. 出工作区
			"cat $SECRET/key", // 未知变量
		]) {
			const verdict = fireToolCall(mock, { toolName: "bash", input: { command } });
			expect(verdict?.block, command).toBe(true);
			expect(verdict?.reason, command).toContain("pao 巡库护栏");
		}
	});

	it("powershell 同门；非 shell 工具（read）不拦", () => {
		const mock = installGuard();
		const verdict = fireToolCall(mock, {
			toolName: "powershell",
			input: { command: "Get-Content C:\\Windows\\x.ini" },
		});
		expect(verdict?.block).toBe(true);
		expect(fireToolCall(mock, { toolName: "read", input: { command: "C:\\Windows\\x.ini" } })).toBeUndefined();
	});
});

describe("派发链接线：巡库卡注入锁定工作区", () => {
	function fakeCard(goal: string): ParsedCard {
		return {
			卡号: 7,
			路径: "D:\\cards\\卡0007-x.md",
			frontmatter: { goal, dept: "后端", status: "unclaimed" },
		} as never as ParsedCard;
	}

	it("巡库卡：锁定工作区＝解析后的 cwd（公共参数优先于 process.cwd）", () => {
		const ws = mkdtempSync(join(tmpdir(), "pao-guard-ws-"));
		tempDirs.push(ws);
		const goal = "巡库：后端知识库机械复检（初判）";
		expect(isPatrolGoal(goal)).toBe(true);
		const options = buildDispatchRunOptions({ card: fakeCard(goal), 尝试号: 1, 公共参数: { cwd: ws } });
		expect(options.锁定工作区).toBe(ws);
		// 缺省 cwd 回落 process.cwd() 的解析值（与 runner.spawn 实际 cwd 一致）
		const withoutCwd = buildDispatchRunOptions({ card: fakeCard(goal), 尝试号: 1 });
		expect(withoutCwd.锁定工作区).toBe(resolve(process.cwd()));
	});

	it("非巡库卡不注入（有人盯的日常派发零行为）", () => {
		const options = buildDispatchRunOptions({
			card: fakeCard("实现登录页"),
			尝试号: 1,
			公共参数: { cwd: "D:\\ws" },
		});
		expect(options.锁定工作区).toBeUndefined();
	});

	it("runner 把锁定工作区转进子进程 env（PAO_SHELL_GUARD_WORKSPACE）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pao-guard-env-"));
		tempDirs.push(dir);
		const dump = join(dir, "env.json");
		const runner = new WorkerRunner();
		// 假命令模式：子进程 dump env 后即退
		const receipt = await runner.run({
			卡号: "0007",
			卡路径: "D:\\cards\\卡0007-x.md",
			提示词: "x",
			命令: process.execPath,
			参数: [
				"-e",
				"require('node:fs').writeFileSync(process.argv[1], JSON.stringify({g: process.env.PAO_SHELL_GUARD_WORKSPACE ?? null}))",
				dump,
			],
			锁定工作区: "D:\\pao-ws\\巡库",
			超时毫秒: 15_000,
		});
		expect(receipt).toBeDefined();
		const env = JSON.parse(readFileSync(dump, "utf8")) as { g: string | null };
		expect(env.g).toBe("D:\\pao-ws\\巡库");
	}, 30_000);

	it("runner 未设锁定工作区时不注入 env（键缺席而非空串）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pao-guard-env2-"));
		tempDirs.push(dir);
		const dump = join(dir, "env.json");
		const runner = new WorkerRunner();
		await runner.run({
			卡号: "0008",
			卡路径: "D:\\cards\\卡0008-y.md",
			提示词: "x",
			命令: process.execPath,
			参数: [
				"-e",
				"require('node:fs').writeFileSync(process.argv[1], JSON.stringify({has: Object.prototype.hasOwnProperty.call(process.env,'PAO_SHELL_GUARD_WORKSPACE')}))",
				dump,
			],
			超时毫秒: 15_000,
		});
		const env = JSON.parse(readFileSync(dump, "utf8")) as { has: boolean };
		// 主进程自身 env 若已带该键会透传——先清掉再断言不注入
		expect(env.has).toBe(SHELL_GUARD_ENV in process.env);
	}, 30_000);
});
