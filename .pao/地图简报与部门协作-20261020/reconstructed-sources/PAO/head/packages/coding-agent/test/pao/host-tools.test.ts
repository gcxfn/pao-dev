/**
 * 宿主接线层测试(S2 收口):pao_spawn_minister/pao_dismiss_minister 工具行为＋通知面接管＋
 * before_agent_start 的通知 section 与空闲保险丝钩。真实 Node 子进程假部长
 * (stdout 回 get_state 响应＋一轮 message_end 带 usage 后挂住;stdin 逐行 dump 供注入断言;
 * 宿主拉起直接传 命令 覆盖——工具层不 spawn 默认 pi)。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MinisterHost } from "../../src/pao/host/host.ts";
import { HOST_NOTICE_SECTION, registerHostTools } from "../../src/pao/host/tools.ts";

const FAKE_MINISTER = `
const fs = require("node:fs");
const dump = process.argv[process.argv.length - 1];
	if (dump) fs.writeFileSync(dump, JSON.stringify({ role: process.env.PAO_ROLE, dept: process.env.PAO_DEPT, budget: process.env.PAO_SESSION_BUDGET ?? null }));
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const cmd = JSON.parse(line);
  if (cmd.type === "get_state") console.log(JSON.stringify({type:"response",id:cmd.id,command:"get_state",success:true,data:{sessionId:"fake-host-tools-1"}}));
});
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "首轮完成" }], stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 } } } }));
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (dump) fs.appendFileSync(dump, "\\nSTDIN\\t" + line);
  }
});
setInterval(() => {}, 60000);
`;

const tempDirs: string[] = [];
const hosts: MinisterHost[] = [];

// 满载并行套件下真子进程停树＋Windows 临时目录重试可能超 vitest 钩子缺省 10s(单独跑 4s 内):
// 显式放宽清理钩子超时,不改任何测试期望。
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.stopAll("测试清理").catch(() => {});
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		} catch {
			/* Windows 句柄延迟,残留交系统临时目录清理 */
		}
	}
}, 30_000);

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-host-tools-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

function mockPi() {
	const tools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }> = [];
	const events: string[] = [];
	const handlers = new Map<string, (event: unknown) => unknown>();
	return {
		tools,
		events,
		handlers,
		pi: {
			registerTool: (tool: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) =>
				void tools.push(tool),
			registerCommand: () => undefined,
			registerVirtualModel: () => undefined,
			on: (event: string, handler?: (event: unknown) => unknown) => {
				events.push(event);
				if (handler) handlers.set(event, handler);
			},
		},
	};
}

interface ToolReply {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
}

function findTool(mock: ReturnType<typeof mockPi>, name: string) {
	const tool = mock.tools.find((t) => t.name === name);
	expect(tool, name).toBeDefined();
	return tool!;
}

function fireBeforeAgentStart(mock: ReturnType<typeof mockPi>): Record<string, string> {
	const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
	mock.handlers.get("before_agent_start")?.(event);
	return event.systemPromptOptions.sections;
}

function waitUntil(fn: () => boolean, timeoutMs = 10_000): Promise<boolean> {
	return new Promise((resolve) => {
		const start = Date.now();
		const tick = (): void => {
			if (fn() || Date.now() - start > timeoutMs) resolve(fn());
			else setTimeout(tick, 50);
		};
		tick();
	});
}

describe("宿主接线:pao_spawn_minister/pao_dismiss_minister", () => {
	it("注册两工具与 before_agent_start 钩子;理由/部门缺失拒绝(不 spawn)", async () => {
		const mock = mockPi();
		registerHostTools(mock.pi as never, { host: new MinisterHost() });
		expect(mock.tools.map((t) => t.name)).toContain("pao_spawn_minister");
		expect(mock.tools.map((t) => t.name)).toContain("pao_dismiss_minister");
		expect(mock.events).toContain("before_agent_start");

		const spawn = findTool(mock, "pao_spawn_minister");
		const noRationale = (await spawn.execute("t1", { dept: "后端", reason: "  " })) as ToolReply;
		expect(noRationale.isError).toBe(true);
		expect(noRationale.content[0]!.text).toContain("reason 必填");
		const noDept = (await spawn.execute("t2", { dept: " ", reason: "x" })) as ToolReply;
		expect(noDept.isError).toBe(true);
	});

	it("散场无热会话拒绝;命中热会话的散场落交接页并如实汇报", async () => {
		const dir = tempDir("dismiss");
		const host = new MinisterHost({ paoHome: dir });
		hosts.push(host);
		const mock = mockPi();
		registerHostTools(mock.pi as never, { host });
		const teardown = findTool(mock, "pao_dismiss_minister");

		const noSession = (await teardown.execute("t1", { dept: "后端", project_root: dir })) as ToolReply;
		expect(noSession.isError).toBe(true);
		expect(noSession.content[0]!.text).toContain("无热部长会话");

		// 直接经宿主拉起假部长(工具层不 spawn 默认 pi),再走工具散场
		const raised = await host.spawn({
			部门: "后端",
			项目根: dir,
			命令: process.execPath,
			参数: ["-e", FAKE_MINISTER, ""],
		});
		expect(raised.ok).toBe(true);
		const record = (await teardown.execute("t2", {
			dept: "后端",
			project_root: dir,
			cause: "测试散场",
		})) as ToolReply;
		expect(record.isError).toBeUndefined();
		expect(record.content[0]!.text).toContain("已散场");
		expect(record.content[0]!.text).toContain("交接页已落");
	}, 30_000);

	it("同 key 再拉起走已有热会话分支(不双开),首条消息经 stdin 抵达假部长", async () => {
		const dir = tempDir("reuse");
		const dump = join(dir, "dump.json");
		const host = new MinisterHost({ paoHome: dir });
		hosts.push(host);
		const raised = await host.spawn({
			部门: "后端",
			项目根: dir,
			命令: process.execPath,
			参数: ["-e", FAKE_MINISTER, dump],
		});
		expect(raised.ok).toBe(true);

		const mock = mockPi();
		registerHostTools(mock.pi as never, { host });
		const spawn = findTool(mock, "pao_spawn_minister");
		const result = (await spawn.execute("t1", {
			dept: "后端",
			reason: "承接连续审卡",
			project_root: dir,
			first_message: "新卡已到,请开始",
		})) as ToolReply;
		expect(result.isError).toBeUndefined();
		expect(result.content[0]!.text).toContain("已有热会话,直接复用");
		expect(result.content[0]!.text).toContain("已留痕");
		// 核对假部长启动时写出的环境身份。
		expect(
			await waitUntil(() => {
				try {
					readFileSync(dump, "utf8");
					return true;
				} catch {
					return false;
				}
			}),
		).toBe(true);
		const env = JSON.parse(readFileSync(dump, "utf8").split("\n")[0]!) as { role: string; dept: string };
		expect(env.role).toBe("部长");
		expect(env.dept).toBe("后端");
		// 注入经 stdin 抵达(假部长 dump 里应有 prompt 行)
		expect(await waitUntil(() => readFileSync(dump, "utf8").includes("新卡已到,请开始"))).toBe(true);
	}, 30_000);

	it("拉起带预算:PAO_SESSION_BUDGET 组装进 拉起 选项.环境变量,工具回显已注入;复用已有会话时如实回绝", async () => {
		// 假宿主捕获拉起选项(不真 spawn):预算注入是工具层的组装行为,宿主 env passthrough 已有 S2 测试覆盖
		const spawnOptions: unknown[] = [];
		let spawnCount = 0;
		const fakeHost = {
			receiveNotice: () => undefined,
			spawn: async (options: unknown) => {
				spawnCount++;
				spawnOptions.push(options);
				return {
					ok: true as const,
					已有热会话: spawnCount > 1,
					handle: { pid: 4321, 会话标识: "rpc-4321", 部门: "后端", 项目根: "D:\\x", 配方指纹: null },
				};
			},
			inject: () => ({ ok: true }),
		};
		const mock = mockPi();
		registerHostTools(mock.pi as never, { host: fakeHost as never });
		const spawn = findTool(mock, "pao_spawn_minister");

		const result = (await spawn.execute("t1", {
			dept: "后端",
			reason: "带预算拉起",
			项目根: "D:\\x",
			budget: { turns: 5, cost: 0.2 },
		})) as ToolReply;
		expect(result.isError).toBeUndefined();
		expect(result.content[0]!.text).toContain("已注入预算");
		expect(spawnOptions[0]).toMatchObject({
			环境变量: { PAO_SESSION_BUDGET: JSON.stringify({ turns: 5, cost: 0.2 }) },
		});

		// 同 key 再拉(带预算):命中已有热会话,回显如实回绝(选项仍带 env 键,宿主对已有会话忽略不双开)
		const reuse = (await spawn.execute("t2", {
			dept: "后端",
			reason: "复用",
			项目根: "D:\\x",
			budget: { turns: 9 },
		})) as ToolReply;
		expect(reuse.content[0]!.text).toContain("已有热会话");
		expect(reuse.content[0]!.text).toContain("预算未注入");

		// 不带预算:选项里没有环境变量键
		await spawn.execute("t3", { dept: "后端", reason: "无预算", 项目根: "D:\\x" });
		expect(spawnOptions[2]).not.toHaveProperty("环境变量");
	});

	it("通知面:一轮事件触发提示线/监督快照进通知,下一次 before_agent_start 渲染 section;空闲保险丝在请求边界散场", async () => {
		const dir = tempDir("notice");
		let now = Date.now();
		const host = new MinisterHost({
			paoHome: dir,
			时钟: () => new Date(now),
			保温: () => ({ 存在: true, 空闲分钟: 30, 部门监督轮次: 1, 轮次提示: 1, 调用提示: 1 }),
		});
		hosts.push(host);
		const mock = mockPi();
		registerHostTools(mock.pi as never, { host });

		// 无通知时 section 不渲染(零噪音)
		expect(fireBeforeAgentStart(mock)[HOST_NOTICE_SECTION]).toBeUndefined();

		const raised = await host.spawn({
			部门: "后端",
			项目根: dir,
			命令: process.execPath,
			参数: ["-e", FAKE_MINISTER, ""],
		});
		expect(raised.ok).toBe(true);
		// 假部长回一轮 message_end → 事件边界触发提示线(轮次 1≥1)与部门监督快照进通知
		expect(await waitUntil(() => host.hotSession("后端", dir)?.累计.轮次 === 1)).toBe(true);
		const sections = fireBeforeAgentStart(mock);
		expect(sections[HOST_NOTICE_SECTION]).toBeDefined();
		expect(sections[HOST_NOTICE_SECTION]).toContain("提示线");
		expect(sections[HOST_NOTICE_SECTION]).toContain("监督快照");

		// 时钟推 31 分钟(空闲超线) → 下一次请求边界的保险丝钩散场;散场记录也进通知。
		// 摘表是 delete-first 立即可见,但散场记录要等树杀/markExited 走完才进通知环——按面轮询
		now += 31 * 60_000;
		fireBeforeAgentStart(mock);
		expect(await waitUntil(() => host.hotSession("后端", dir) === undefined)).toBe(true);
		let sections2: Record<string, string> = {};
		expect(
			await waitUntil(() => {
				sections2 = fireBeforeAgentStart(mock);
				return sections2[HOST_NOTICE_SECTION]?.includes("散场") ?? false;
			}),
		).toBe(true);
	}, 45_000);
});
