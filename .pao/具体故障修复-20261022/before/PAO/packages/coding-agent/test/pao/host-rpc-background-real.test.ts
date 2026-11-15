import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MinisterHost } from "../../src/pao/host/host.ts";
import { registerHostTools } from "../../src/pao/host/tools.ts";

/**
 * 真实 Node RPC 子进程验证部长后台长锁。
 *
 * 子进程只使用 node:readline 消费 MinisterHost 写入 stdin 的 JSONL，并用 stdout 回放
 * 受控事件；不加载 pi、不连接模型、网络或 Docker。主机时钟由测试注入，真实 IO 与监督
 * 计时分离。每次推进时序都等子进程写入的握手记录，不使用固定 sleep 掩盖接线错误。
 */

const CHILD_SOURCE = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");

const controlPath = process.argv[2];
const readyPath = process.argv[3];
const record = (event, extra = {}) =>
  fs.appendFileSync(controlPath, JSON.stringify({ event, at: Date.now(), ...extra }) + "\n");
const emit = (event) => {
  record("emit", { type: event.type });
  process.stdout.write(JSON.stringify(event) + "\n");
};
record("start", { pid: process.pid, role: process.env.PAO_ROLE, dept: process.env.PAO_DEPT });
fs.writeFileSync(readyPath, String(process.pid));

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  record("stdin", { id: command.id, type: command.type });

  if (command.type === "get_state") {
    emit({
      type: "response",
      id: command.id,
      command: "get_state",
      success: true,
      data: { sessionId: "real-rpc-background-session" },
    });
    return;
  }

  if (command.type !== "prompt") return;
  if (command.message === "验收:已受理未开轮") {
    emit({type:"response",id:command.id,command:"prompt",success:true,data:{disposition:"queued"}});
    return;
  }
  if (command.message.startsWith("验收:末态:")) {
    const reason = command.message.slice("验收:末态:".length);
    emit({ type: "agent_start" });
    emit({type:"response",id:command.id,command:"prompt",success:true,data:{disposition:"started"}});
    emit({type:"message_end",message:{role:"assistant",content:[],stopReason:reason,errorMessage:"controlled terminal"}});
    emit({type:"agent_settled"});
    return;
  }
  if (command.message === "验收:进入子后台") {
    emit({ type: "agent_start" });
    emit({ type: "background_work", running: 1, unread: 0 });
    record("checkpoint", { name: "background-one-emitted" });
    process.stdout.write(
      JSON.stringify({
        type: "response",
        id: command.id,
        command: "prompt",
        success: true,
        data: { disposition: "started" },
      }) + "\n",
    );
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "只读分析已交付,后台任务继续" }],
        stopReason: "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    });
    emit({ type: "agent_settled" });
    return;
  }

  if (command.message === "验收:后台清零") {
    emit({ type: "background_work", running: 0, unread: 0 });
    record("checkpoint", { name: "background-zero-emitted" });
    process.stdout.write(JSON.stringify({
      type: "response",
      id: command.id,
      command: "prompt",
      success: true,
      data: { disposition: "handled" },
    }) + "\n");
    return;
  }

  record("unknown-prompt", { id: command.id, message: command.message });
});
`;

interface Fixture {
	host: MinisterHost;
	script: string;
	control: string;
	ready: string;
	projectRoot: string;
	notices: string[];
	mainTools: Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>;
	now: number;
}

const tempDirs: string[] = [];
const hosts: MinisterHost[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-rpc-background-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	} catch {
		// 进程句柄释放慢时保留系统临时目录，不把清理延迟伪装成测试结论。
	}
}

afterEach(async () => {
	for (const host of hosts.splice(0)) await host.stopAll("测试清理").catch(() => {});
	for (const dir of tempDirs.splice(0)) cleanupDir(dir);
}, 60_000);

function readControl(fixture: Fixture): Record<string, unknown>[] {
	if (!existsSync(fixture.control)) return [];
	return readFileSync(fixture.control, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForControl(
	fixture: Fixture,
	check: (entries: Record<string, unknown>[]) => boolean,
	label: string,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const entries = readControl(fixture);
		if (check(entries)) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`等待真实子进程握手超时:${label};控制记录=${JSON.stringify(readControl(fixture), null, 2)}`);
}

function makeFixture(prefix: string): Fixture {
	const home = tempDir(`${prefix}-home`);
	mkdirSync(join(home, "pao配置"), { recursive: true });
	writeFileSync(join(home, "pao配置", "保温.json"), JSON.stringify({ 空闲分钟: 30 }), "utf8");
	const projectRoot = tempDir(`${prefix}-project`);
	const script = join(tempDir(`${prefix}-script`), "controlled-minister.cjs");
	writeFileSync(script, CHILD_SOURCE, "utf8");
	const control = join(tempDir(`${prefix}-control`), "events.jsonl");
	const ready = join(tempDir(`${prefix}-ready`), "pid");
	const now = 0;
	const notices: string[] = [];
	const fixture = {} as Fixture;
	const mainTools = new Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>();
	const host = new MinisterHost({
		paoHome: home,
		时钟: () => new Date(fixture.now),
		监督分钟: () => ({ 工人: 0, 部门: 30 }),
	});
	Object.assign(fixture, {
		host,
		script,
		control,
		ready,
		projectRoot,
		notices,
		mainTools,
		now,
	});
	hosts.push(host);
	const pi = {
		registerTool: (tool: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) => {
			mainTools.set(tool.name, tool);
		},
		registerCommand: () => undefined,
		registerVirtualModel: () => undefined,
		on: () => undefined,
	};
	registerHostTools(pi as never, {
		host,
		时钟: () => new Date(fixture.now),
		notifySurface: {
			notify: (body: string) => notices.push(body),
			unreadCount: () => 0,
			shutdown: () => undefined,
		},
	});
	return fixture;
}

async function spawn(fixture: Fixture, context: string) {
	const result = await fixture.host.spawn({
		部门: "规划",
		项目根: fixture.projectRoot,
		脉络: context,
		命令: process.execPath,
		参数: [fixture.script, fixture.control, fixture.ready],
	});
	if (!result.ok) throw new Error(result.原因);
	expect(result.handle.会话标识).toBe("real-rpc-background-session");
	await waitForControl(
		fixture,
		(entries) => entries.some((entry) => entry.event === "stdin" && entry.type === "get_state"),
		"get_state 已经过真实 stdin",
	);
	return result.handle;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitPidDead(pid: number, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!alive(pid)) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`显式停止后 pid ${pid} 仍存活`);
}

async function inject(fixture: Fixture, context: string, text: string) {
	const result = await fixture.host.inject("规划", fixture.projectRoot, text, context, "followUp");
	expect(result, text).toMatchObject({ ok: true });
	return result;
}

function route(handle: Awaited<ReturnType<typeof spawn>>, context: string) {
	return {
		department: handle.部门,
		projectRoot: handle.项目根,
		context,
		sessionId: handle.会话标识,
	};
}

describe("真实 RPC 子进程:后台保活、监督确认、完成摘要和迟到事件", () => {
	it("RPC 已受理而 agent_start 尚未到达的任务仍受监督且不按空闲杀停", async () => {
		const fixture = makeFixture("accepted");
		const context = "accepted-owner";
		const handle = await spawn(fixture, context);
		expect((await inject(fixture, context, "验收:已受理未开轮")).处置).toBe("queued");
		expect(fixture.host.backgroundCountFor(route(handle, context))).toEqual({ inFlight: 1 });
		fixture.now += 30 * 60_000;
		await fixture.host.flushSupervision();
		expect(fixture.notices.filter((text) => text.includes("[监督检查]"))).toHaveLength(1);
		expect(await fixture.host.checkFuse()).toEqual([]);
		expect(alive(handle.pid)).toBe(true);
		expect(fixture.notices.some((text) => text.includes("[部长完成]"))).toBe(false);
	});
	it.each(["error", "aborted"])("热会话注入的 %s 末态不冒充正常完成", async (reason) => {
		const fixture = makeFixture(`terminal-${reason}`);
		const context = `terminal-${reason}`;
		const handle = await spawn(fixture, context);
		await inject(fixture, context, `验收:末态:${reason}`);
		await waitForControl(
			fixture,
			() => fixture.host.backgroundCountFor(route(handle, context)).inFlight === 0,
			"末态已由父宿主结算",
		);
		expect(fixture.notices.some((text) => text.includes("[部长完成]"))).toBe(false);
		const failures = fixture.notices.filter((text) => text.includes("[部长失败]"));
		if (reason === "error") {
			expect(failures).toHaveLength(1);
			expect(failures[0]).toContain("controlled terminal");
		} else expect(failures).toHaveLength(0);
	});
	it("运行中的只读后台跨 30 分钟保活；确认后重计并可再次检查；清零后再普通完成摘要一次", async () => {
		const fixture = makeFixture("main");
		const context = "background-owner";
		const handle = await spawn(fixture, context);
		const target = route(handle, context);

		expect((await inject(fixture, context, "验收:进入子后台")).处置).toBe("started");
		await waitForControl(
			fixture,
			(entries) =>
				entries.some((entry) => entry.event === "emit" && entry.type === "agent_settled") &&
				entries.some((entry) => entry.event === "emit" && entry.type === "background_work"),
			"后台 running=1 已从真实 stdout 发出",
		);
		await waitForControl(
			fixture,
			() => fixture.host.backgroundCountFor(target).inFlight === 1,
			"父宿主已消费真实 background_work",
		);
		await waitForControl(
			fixture,
			(entries) => entries.some((entry) => entry.event === "checkpoint" && entry.name === "background-one-emitted"),
			"真实子进程后台事件写入完成",
		);
		fixture.host.refreshActivity();
		expect(fixture.host.backgroundCountFor(target)).toEqual({ inFlight: 1 });
		expect(fixture.host.backgroundCount().inFlight).toBeGreaterThan(0);
		expect(fixture.host.backgroundCountFor(target).inFlight).toBeGreaterThan(0);
		expect(fixture.host.hotSession("规划", fixture.projectRoot, context)?.pid).toBe(handle.pid);

		fixture.now += 30 * 60_000;
		await fixture.host.flushSupervision();
		await waitForControl(
			fixture,
			() => fixture.notices.some((text) => text.includes("[监督检查] 部门检查间隔 30 分钟")),
			"第一次 30 分钟部门检查抵达主控通知面",
		);
		const checksBeforeAck = fixture.notices.filter((text) => text.includes("[监督检查] 部门检查间隔 30 分钟"));
		expect(checksBeforeAck).toHaveLength(1);
		const supervisionKey = checksBeforeAck[0]?.match(/pao_ack_supervision\(key="([^"]+)"\)/)?.[1];
		expect(supervisionKey).toMatch(/^department:规划:/);
		expect(fixture.host.backgroundCountFor(target).inFlight).toBeGreaterThan(0);
		expect(await fixture.host.checkFuse()).toEqual([]);
		expect(alive(handle.pid)).toBe(true);
		await fixture.host.flushSupervision();
		expect(fixture.notices.filter((text) => text.includes("[监督检查] 部门检查间隔 30 分钟"))).toHaveLength(1);

		const mainAck = fixture.mainTools.get("pao_ack_supervision");
		expect(mainAck).toBeDefined();
		const ackResult = (await mainAck!.execute("main-ack", { key: supervisionKey })) as {
			isError?: boolean;
			details?: unknown;
		};
		expect(ackResult.isError).toBeUndefined();
		expect(ackResult.details).toEqual({ type: "pao_supervision_ack", key: supervisionKey });

		fixture.now += 29 * 60_000;
		await fixture.host.flushSupervision();
		expect(fixture.notices.filter((text) => text.includes("[监督检查] 部门检查间隔 30 分钟"))).toHaveLength(1);
		fixture.now += 60_000;
		await fixture.host.flushSupervision();
		expect(fixture.notices.filter((text) => text.includes("[监督检查] 部门检查间隔 30 分钟"))).toHaveLength(2);
		expect(fixture.host.backgroundCountFor(target).inFlight).toBeGreaterThan(0);
		expect(await fixture.host.checkFuse()).toEqual([]);
		expect(alive(handle.pid)).toBe(true);

		expect(fixture.notices.filter((text) => text.includes("[部长完成]"))).toHaveLength(0);
		await inject(fixture, context, "验收:后台清零");
		await waitForControl(
			fixture,
			(entries) => entries.filter((entry) => entry.event === "emit" && entry.type === "background_work").length >= 2,
			"后台清零已从真实 stdout 发出",
		);
		await waitForControl(
			fixture,
			() => fixture.host.backgroundCountFor(target).inFlight === 0,
			"宿主按清零事件重算后台计数",
		);
		await waitForControl(
			fixture,
			() => fixture.notices.filter((text) => text.includes("[部长完成]")).length === 1,
			"清零后普通部长完成摘要只投递一次",
		);
		const completion = fixture.notices.filter((text) => text.includes("[部长完成]"));
		expect(completion).toHaveLength(1);
		expect(completion[0]).toContain("摘要:只读分析已交付,后台任务继续");

		fixture.now += 30 * 60_000;
		await fixture.host.flushSupervision();
		expect(fixture.notices.filter((text) => text.includes("[部长完成]"))).toHaveLength(1);
	}, 30_000);

	it("stopAll 树杀真实子进程后，监督不再通知、后台计数不复活且进程不存活", async () => {
		const fixture = makeFixture("late");
		const context = "late-owner";
		const handle = await spawn(fixture, context);
		const target = route(handle, context);
		await inject(fixture, context, "验收:进入子后台");
		await waitForControl(
			fixture,
			(entries) => entries.some((entry) => entry.event === "emit" && entry.type === "background_work"),
			"后台事件在停止前已抵达",
		);
		await waitForControl(
			fixture,
			() => fixture.host.backgroundCountFor(target).inFlight === 1,
			"父宿主已消费停止前的后台事件",
		);
		await waitForControl(
			fixture,
			(entries) => entries.some((entry) => entry.event === "checkpoint" && entry.name === "background-one-emitted"),
			"真实子进程后台事件写入完成",
		);
		fixture.host.refreshActivity();
		expect(fixture.host.backgroundCountFor(target)).toEqual({ inFlight: 1 });
		fixture.now += 30 * 60_000;
		await fixture.host.flushSupervision();
		await waitForControl(
			fixture,
			() => fixture.notices.some((text) => text.includes("[监督检查]")),
			"停止前已生成待确认监督项",
		);

		const completionBeforeStop = fixture.notices.filter((text) => text.includes("[部长完成]")).length;
		const checksBeforeStop = fixture.notices.filter((text) => text.includes("[监督检查]")).length;
		let wakeups = 0;
		const unsubscribe = fixture.host.subscribeBackground(() => {
			wakeups++;
		});
		const stopRecords = await fixture.host.stopAll("显式停止");
		expect(stopRecords).toHaveLength(1);
		expect(stopRecords[0]?.pid).toBe(handle.pid);
		await waitPidDead(handle.pid);

		const wakeupsAfterStop = wakeups;
		const controlCountAfterStop = fixture.notices.length;
		await fixture.host.flushSupervision();
		fixture.host.refreshActivity();
		expect(fixture.host.backgroundCount()).toEqual({ inFlight: 0 });
		expect(fixture.host.backgroundCountFor(target)).toEqual({ inFlight: 0 });
		expect(fixture.host.hotSession("规划", fixture.projectRoot, context)).toBeUndefined();
		expect(fixture.notices.filter((text) => text.includes("[监督检查]"))).toHaveLength(checksBeforeStop);
		expect(fixture.notices.filter((text) => text.includes("[部长完成]"))).toHaveLength(completionBeforeStop);
		expect(fixture.notices).toHaveLength(controlCountAfterStop);
		expect(wakeups).toBe(wakeupsAfterStop);
		expect(alive(handle.pid)).toBe(false);
		unsubscribe();
	}, 30_000);
});
