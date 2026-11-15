import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MinisterHost } from "../../src/pao/host/host.ts";
import { killTree } from "../../src/utils/kill-tree.ts";

/**
 * 事件边界保险丝(定案3/4):只有「空闲分钟」熔断——先落短交接→树杀→登记表摘除;
 * 轮次/工具调用是提示线(一次性通知,不杀);零定时器零轮询,核对全挂事件边界;
 * 缺保温.json=不保温(保险丝/提示线/监督全关,计数照记)。
 */

const tempDirs: string[] = [];
const hosts: MinisterHost[] = [];

// Windows 下被杀进程的 cwd 句柄释放有延迟,rmSync 可能 EPERM——清理尽力而为,不让收尾失败连累已通过的断言
function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	} catch {
		// 残留目录交给系统临时目录清理,不影响测试结果
	}
}

afterEach(async () => {
	for (const host of hosts.splice(0)) await host.stopAll("测试清理").catch(() => {});
	for (const dir of tempDirs.splice(0)) cleanupDir(dir);
}, 60_000);

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-host-fuse-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

function waitUntil(fn: () => boolean, timeoutMs = 10000): Promise<boolean> {
	return new Promise((resolve) => {
		const start = Date.now();
		const tick = (): void => {
			if (fn() || Date.now() - start > timeoutMs) resolve(fn());
			else setTimeout(tick, 50);
		};
		tick();
	});
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const FAKE_MINISTER = `
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const cmd = JSON.parse(line);
  if (cmd.type === "get_state") console.log(JSON.stringify({type:"response",id:cmd.id,command:"get_state",success:true,data:{sessionId:"fake-fuse"}}));
  // 注入回执(审查第 7 项):宿主按这条 response 结算注入,不再发完就报成功
  if (cmd.type === "prompt") console.log(JSON.stringify({type:"response",id:cmd.id,command:"prompt",success:true,data:{disposition:"queued"}}));
});
const fs = require("node:fs");
const rounds = Number(process.argv[2] || 0);
for (let i = 0; i < rounds; i++)
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "第" + i + "轮" }], stopReason: "end", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 } } } }));
setInterval(() => {}, 1000);
`;

interface FuseFixture {
	host: MinisterHost;
	脚本: string;
	home: string;
	项目根: string;
	通知: string[];
	前进分钟: (minute: number) => void;
	诊断: { wall: string; phase: string; pid?: number; elapsedMs?: number; error?: string }[];
}

function makeFixture(prefix: string, warmth: object | null): FuseFixture {
	const home = tempDir(`${prefix}-home`);
	mkdirSync(join(home, "pao配置"), { recursive: true });
	if (warmth) writeFileSync(join(home, "pao配置", "保温.json"), JSON.stringify(warmth), "utf8");
	const projectRoot = tempDir(`${prefix}-proj`);
	mkdirSync(projectRoot, { recursive: true });
	const script = join(tempDir(`${prefix}-bin`), "fake-minister.cjs");
	writeFileSync(script, FAKE_MINISTER, "utf8");
	let now = new Date("2026-10-03T09:00:00");
	const notice: string[] = [];
	const diagnose: FuseFixture["诊断"] = [];
	const host = new MinisterHost({
		paoHome: home,
		时钟: () => now,
		通知: (text) => notice.push(text),
		树杀: async (pid) => {
			const start = performance.now();
			diagnose.push({ wall: new Date().toISOString(), phase: "树杀开始（交接已返回）", pid });
			try {
				const result = await killTree(pid);
				diagnose.push({
					wall: new Date().toISOString(),
					phase: "树杀完成",
					pid,
					elapsedMs: performance.now() - start,
				});
				return result;
			} catch (error) {
				diagnose.push({
					wall: new Date().toISOString(),
					phase: "树杀失败",
					pid,
					elapsedMs: performance.now() - start,
					error: String(error),
				});
				throw error;
			}
		},
	});
	hosts.push(host);
	return {
		host,
		脚本: script,
		home,
		项目根: projectRoot,
		通知: notice,
		诊断: diagnose,
		前进分钟: (minute: number) => {
			now = new Date(now.getTime() + minute * 60_000);
		},
	};
}

async function spawn(fixture: FuseFixture, dept = "前端", rounds = 0) {
	const result = await fixture.host.spawn({
		部门: dept,
		项目根: fixture.项目根,
		命令: process.execPath,
		参数: [fixture.脚本, String(rounds)],
	});
	if (!result.ok) throw new Error(`拉起失败:${result.原因}`);
	expect(
		await waitUntil(() => (fixture.host.hotSession(dept, fixture.项目根)?.累计.轮次 ?? 0) >= rounds),
		`假部长轮次未收齐：${dept}`,
	).toBe(true);
	fixture.诊断.push({ wall: new Date().toISOString(), phase: `握手完成:${dept}`, pid: result.handle.pid });
	return result;
}

describe("空闲熔断(唯一熔断线):先落短交接→树杀→登记表摘除", () => {
	it("超空闲分钟的事件边界核对把闲置会话散场;交接页落盘", async () => {
		const fixture = makeFixture("idle", { 空闲分钟: 30 });
		const { handle } = await spawn(fixture);
		fixture.前进分钟(31);
		const fuse = await fixture.host.checkFuse();
		expect(fuse).toHaveLength(1);
		expect(fuse[0].原因).toContain("空闲熔断");
		expect(fuse[0].交接路径).toContain(join("部门", "前端", "交接"));
		expect(await waitUntil(() => !alive(handle.pid))).toBe(true);
		expect(fixture.host.list()).toHaveLength(0);
		expect(fixture.host.registry.list().find((item) => item.pid === handle.pid)?.running).toBe(false);
	});

	it("未超线的会话不动;另一会话的事件边界顺带核对闲置会话(零定时器)", async () => {
		const fixture = makeFixture("idle2", { 空闲分钟: 30 });
		const a = await spawn(fixture, "前端");
		const b = await spawn(fixture, "后端");
		const advanceBefore = fixture.host
			.list()
			.map((handle) => ({ 部门: handle.部门, pid: handle.pid, 最近事件时间: handle.最近事件时间 }));
		fixture.前进分钟(31);
		// 后端会话来事件(注入)→边界核对把闲置的前端熔断,后端自己刚有输入不动
		const inject = await fixture.host.inject("后端", fixture.项目根, "新卡到达");
		expect(inject.ok).toBe(true);
		const removed = await waitUntil(() => fixture.host.hotSession("前端", fixture.项目根) === undefined);
		const diagnosis = () =>
			JSON.stringify({
				前进前: advanceBefore,
				当前: fixture.host.list(),
				登记: fixture.host.registry.list(),
				前端存活: alive(a.handle.pid),
				后端存活: alive(b.handle.pid),
				阶段: fixture.诊断,
				通知: fixture.通知,
			});
		if (process.env.PAO_FUSE_DIAGNOSTICS === "1") console.error(`host-fuse阶段：${diagnosis()}`);
		expect(removed, `前端10秒内未摘除；${removed ? "" : diagnosis()}`).toBe(true);
		expect(fixture.host.hotSession("后端", fixture.项目根)?.pid).toBe(b.handle.pid);
	});
	it("保险丝核对失败(树杀异常):事件边界吞掉 rejection 记 stderr,不崩进程", async () => {
		const home = tempDir("fuseerr-home");
		mkdirSync(join(home, "pao配置"), { recursive: true });
		writeFileSync(join(home, "pao配置", "保温.json"), JSON.stringify({ 空闲分钟: 30 }), "utf8");
		const projectRoot = tempDir("fuseerr-proj");
		mkdirSync(projectRoot, { recursive: true });
		const script = join(tempDir("fuseerr-bin"), "fake-minister.cjs");
		writeFileSync(script, FAKE_MINISTER, "utf8");
		let now = new Date("2026-10-03T09:00:00");
		const host = new MinisterHost({
			paoHome: home,
			时钟: () => now,
			树杀: async () => {
				throw new Error("树杀失败(测试注入)");
			},
		});
		hosts.push(host);
		const result = await host.spawn({
			部门: "前端",
			项目根: projectRoot,
			命令: process.execPath,
			参数: [script, "0"],
		});
		if (!result.ok) throw new Error(`拉起失败:${result.原因}`);
		// 第二个会话供注入:注入只刷新自己的最近事件时间,前端保持闲置可熔断
		const b = await host.spawn({ 部门: "后端", 项目根: projectRoot, 命令: process.execPath, 参数: [script, "0"] });
		if (!b.ok) throw new Error(`拉起失败:${b.原因}`);
		now = new Date(now.getTime() + 31 * 60_000);
		const stderr: string[] = [];
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			stderr.push(String(chunk));
			return true;
		}) as never);
		try {
			// 注入触发事件边界 → void 检查保险丝:此前树杀异常会成为 unhandled rejection 崩进程
			expect((await host.inject("后端", projectRoot, "触发边界核对")).ok).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(stderr.join("")).toContain("保险丝核对失败");
			expect(stderr.join("")).toContain("树杀失败");
		} finally {
			spy.mockRestore();
		}
		// 失败的散场没杀掉进程,测试收尾补杀(生产侧由下个事件边界再核对)
		await killTree(result.handle.pid);
		await killTree(b.handle.pid);
	}, 20_000);
});

describe("监督动作审计留痕(催办/熔断可查证):$PAO_HOME/部门/审查/监督审计.jsonl", () => {
	it("提示线与空闲熔断各留一行 JSONL(时间戳/动作/目标/原因)", async () => {
		const fixture = makeFixture("audit", { 空闲分钟: 30, 轮次提示: 1 });
		const { handle } = await spawn(fixture, "前端", 1);
		fixture.前进分钟(31);
		expect(await fixture.host.checkFuse()).toHaveLength(1);
		const auditPath = join(fixture.home, "部门", "审查", "监督审计.jsonl");
		const rows = readFileSync(auditPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { 时间: string; 动作: string; 目标: string; 原因: string });
		const hintLine = rows.filter((row) => row.动作 === "提示线");
		expect(hintLine).toHaveLength(1);
		expect(hintLine[0].目标).toContain("前端");
		expect(hintLine[0].目标).toContain(`pid ${handle.pid}`);
		expect(hintLine[0].原因).toContain("累计轮次达 1");
		const teardown = rows.find((row) => row.动作 === "散场");
		expect(teardown?.原因).toContain("空闲熔断");
		expect(teardown?.目标).toContain(`pid ${handle.pid}`);
		expect(/^\d{4}-\d{2}-\d{2}T/.test(teardown?.时间 ?? "")).toBe(true);
	});
});

describe("提示线(200/2000 口径的一次性通知):只提示不杀", () => {
	it("轮次/调用达标各通知一次,后续边界不重复;进程不散场", async () => {
		const fixture = makeFixture("hint", { 空闲分钟: 30, 轮次提示: 2, 调用提示: 3 });
		await spawn(fixture, "前端", 2);
		expect(fixture.通知.filter((text) => text.includes("[提示线]"))).toHaveLength(1);
		expect(fixture.通知[0]).toContain("累计轮次达 2");
		expect(fixture.通知[0]).toContain("提示不杀");
		// 再来一个边界(注入):一次性标记已置,不重复通知,会话仍在
		expect((await fixture.host.inject("前端", fixture.项目根, "插话")).ok).toBe(true);
		expect(fixture.通知.filter((text) => text.includes("[提示线]"))).toHaveLength(1);
		expect(fixture.host.hotSession("前端", fixture.项目根)).toBeDefined();
	});
});

describe("缺保温.json=不保温(功能缺省关)", () => {
	it("无保温文件:不熔断、不通知,句柄计数照记", async () => {
		const fixture = makeFixture("nowarm", null);
		const { handle } = await spawn(fixture, "前端", 2);
		fixture.前进分钟(10_000);
		expect(await fixture.host.checkFuse()).toEqual([]);
		expect(fixture.通知).toEqual([]);
		expect(fixture.host.hotSession("前端", fixture.项目根)?.累计.轮次).toBe(2);
		expect(fixture.host.hotSession("前端", fixture.项目根)?.累计.成本).toBeCloseTo(0.02, 6);
		expect(alive(handle.pid)).toBe(true);
		// 保险丝关着,但显式散场照常可用(按需起、用完即散)
		const record = await fixture.host.teardown("前端", fixture.项目根, "主控显式散场");
		expect(record?.方式).toBeTruthy();
		expect(await waitUntil(() => !alive(handle.pid))).toBe(true);
	});
});
