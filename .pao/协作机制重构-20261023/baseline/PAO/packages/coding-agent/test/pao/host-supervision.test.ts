import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assessLiveness, type LivenessInput } from "../../src/pao/host/handle.ts";
import { type HostActivity, MinisterHost } from "../../src/pao/host/host.ts";
import type { DispatchNotifyCategory } from "../../src/pao/worker/notify.ts";

/**
 * 监督周期唤醒(定案6/设计包 §4):被监督会话每累计 N 轮(usage 事件边界计数,零新增
 * 探针)向直接上级注入机械摘要,被监督者不暂停;0/缺省=关。活性三判据只标不杀。
 * worker 级注入面(工人监督轮次)按 R05 如实声明:计数→向热部长会话注入或落待办标记,
 * 当前无生产者接线,本测试只验证注入面本身。
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
	const dir = mkdtempSync(join(tmpdir(), `pao-host-sup-${prefix}-`));
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

const FAKE_MINISTER = `
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const cmd = JSON.parse(line);
  if (cmd.type === "get_state") console.log(JSON.stringify({type:"response",id:cmd.id,command:"get_state",success:true,data:{sessionId:"fake-supervision"}}));
  // 注入回执(审查第 7 项):宿主按这条 response 结算注入,不再发完就报成功
  if (cmd.type === "prompt") console.log(JSON.stringify({type:"response",id:cmd.id,command:"prompt",success:true,data:{disposition:"queued"}}));
});
const fs = require("node:fs");
const rounds = Number(process.argv[2] || 0);
const toolCalls = Number(process.argv[3] || 0);
const toolName = process.argv[4] || "read";
const dump = process.argv[5];
for (let i = 0; i < toolCalls; i++)
  console.log(JSON.stringify({ type: "message_update", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "t" + i, toolName } }));
for (let i = 0; i < rounds; i++)
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "最近回执标题" + i }], stopReason: "end", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 } } } }));
if (dump) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      fs.appendFileSync(dump, buf.slice(0, i) + "\\n");
      buf = buf.slice(i + 1);
    }
  });
}
setInterval(() => {}, 1000);
`;

interface SupFixture {
	host: MinisterHost;
	脚本: string;
	项目根: string;
	home: string;
	dump: string;
	通知: string[];
}

function makeFixture(prefix: string, warmth: object | null): SupFixture {
	const home = tempDir(`${prefix}-home`);
	mkdirSync(join(home, "pao配置"), { recursive: true });
	if (warmth) writeFileSync(join(home, "pao配置", "保温.json"), JSON.stringify(warmth), "utf8");
	const projectRoot = tempDir(`${prefix}-proj`);
	mkdirSync(projectRoot, { recursive: true });
	const script = join(tempDir(`${prefix}-bin`), "fake-minister.cjs");
	writeFileSync(script, FAKE_MINISTER, "utf8");
	const notice: string[] = [];
	const host = new MinisterHost({ paoHome: home, 通知: (text) => notice.push(text) });
	hosts.push(host);
	return { host, 脚本: script, 项目根: projectRoot, home, dump: `${script}.dump`, 通知: notice };
}

async function spawn(fixture: SupFixture, rounds = 0, toolCalls = 0, toolName = "read", dept = "前端") {
	const result = await fixture.host.spawn({
		部门: dept,
		项目根: fixture.项目根,
		命令: process.execPath,
		参数: [fixture.脚本, String(rounds), String(toolCalls), toolName, fixture.dump],
	});
	if (!result.ok) throw new Error(`拉起失败:${result.原因}`);
	await waitUntil(() => (fixture.host.hotSession(dept, fixture.项目根)?.累计.轮次 ?? 0) >= rounds);
	return result;
}

describe("部门级监督唤醒(部长被主控监督,挂 usage 事件边界)", () => {
	it("每累计 N 轮注入一次机械摘要(轮次/调用/成本＋活性＋最近输出);周期反复触发", async () => {
		const fixture = makeFixture("waken", { 部门监督轮次: 2 });
		await spawn(fixture, 4);
		const snapshot = fixture.通知.filter((text) => text.includes("[监督快照]"));
		expect(snapshot).toHaveLength(2); // 第 2、4 轮各一次
		expect(snapshot[0]).toContain("部长会话〔前端@");
		expect(snapshot[0]).toContain("轮次 2｜工具调用");
		expect(snapshot[0]).toContain("成本 0.02");
		expect(snapshot[0]).toContain("最近输出:最近回执标题");
		expect(snapshot[0]).toContain("被监督者不暂停");
	});

	it("0/缺省=该级关唤醒;提示线未达标不发通知", async () => {
		const fixture = makeFixture("off", { 空闲分钟: 30 });
		await spawn(fixture, 3);
		expect(fixture.通知).toEqual([]);
	});
});

describe("活性三判据(只标不杀,零新增探针)", () => {
	it("盘点视图标出:疑似循环(最近 K 次调用同名)＋到顶(达提示线);无异常标记为「无异常标记」", async () => {
		const fixture = makeFixture("activity", { 空闲分钟: 30, 循环K: 3, 轮次提示: 1 });
		await spawn(fixture, 1, 3, "read");
		const view = fixture.host.inventoryView();
		expect(view).toHaveLength(1);
		expect(view[0].活性.join("；")).toContain("疑似循环(最近 3 次调用同为 read)");
		expect(view[0].活性.join("；")).toContain("到顶(达提示线)");
	});

	it("评估活性纯函数:疑似停滞(运行中且最近事件超阈值);不运行不标", () => {
		const base: LivenessInput = {
			运行中: true,
			最近事件毫秒: 0,
			当前毫秒: 16 * 60_000,
			停滞阈值分钟: 15,
			最近工具签名: [],
			循环K: 5,
			累计轮次: 0,
			累计工具调用: 0,
		};
		expect(assessLiveness(base)[0]).toContain("疑似停滞");
		expect(assessLiveness({ ...base, 运行中: false })).toEqual([]);
		expect(assessLiveness({ ...base, 当前毫秒: 14 * 60_000 })).toEqual([]);
	});
});

describe("worker 监督注入面(R05:计数→向热部长会话注入或落待办标记)", () => {
	it("监督动作审计留痕:部门监督唤醒/worker 监督唤醒/待办各留一行 JSONL", async () => {
		const fixture = makeFixture("audit", { 部门监督轮次: 2, 工人监督轮次: 2 });
		await spawn(fixture, 4);
		const wakeup = await fixture.host.recordSupervisedUsage({
			身份: "卡0007-修登录.md",
			部门: "前端",
			项目根: fixture.项目根,
			累计轮次: 2,
		});
		expect(wakeup.唤醒).toBeDefined();
		const todo = await fixture.host.recordSupervisedUsage({
			身份: "卡0009-清缓存.md",
			部门: "后端",
			项目根: fixture.项目根,
			累计轮次: 2,
		});
		expect(todo.待办).toBeDefined();
		const rows = readFileSync(join(fixture.home, "部门", "审查", "监督审计.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { 时间: string; 动作: string; 目标: string; 原因: string });
		const action = rows.map((row) => row.动作);
		expect(action.filter((a) => a === "监督唤醒")).toHaveLength(2); // 第 2、4 轮各一次
		expect(action).toContain("worker监督唤醒");
		expect(action).toContain("worker监督待办");
		const wakeupLine = rows.find((row) => row.动作 === "worker监督唤醒");
		expect(wakeupLine?.目标).toContain("卡0007-修登录.md");
		expect(wakeupLine?.原因).toContain("间隔 2");
		expect(rows.find((row) => row.动作 === "worker监督待办")?.目标).toContain("卡0009-清缓存.md");
	});
	it("工人监督轮次达标:热部长会话在场 → 快照经注入通道抵达(会话 stdin 可见)", async () => {
		const fixture = makeFixture("worker-wake", { 工人监督轮次: 3 });
		await spawn(fixture, 0);
		const firstTime = await fixture.host.recordSupervisedUsage({
			身份: "卡0007-修登录.md",
			部门: "前端",
			项目根: fixture.项目根,
			累计轮次: 2,
			累计工具调用: 9,
		});
		expect(firstTime).toEqual({});
		const trigger = await fixture.host.recordSupervisedUsage({
			身份: "卡0007-修登录.md",
			部门: "前端",
			项目根: fixture.项目根,
			累计轮次: 3,
			累计工具调用: 12,
			最近回执标题: "登录页已修",
		});
		expect(trigger.唤醒).toContain("[监督快照] worker 卡0007-修登录.md");
		const arrived = await waitUntil(() => {
			const text = existsSync(fixture.dump) ? readFileSync(fixture.dump, "utf8") : "";
			return text.includes("worker 卡0007-修登录.md") && text.includes("上级监督唤醒");
		});
		expect(arrived).toBe(true);
		// 同一 worker 下一轮再记,差值不足间隔不重复唤醒
		expect(
			await fixture.host.recordSupervisedUsage({
				身份: "卡0007-修登录.md",
				部门: "前端",
				项目根: fixture.项目根,
				累计轮次: 4,
			}),
		).toEqual({});
	});

	it("无热部长会话可注入 → 落待办标记(盘点可见),不静默丢", async () => {
		const fixture = makeFixture("worker-todo", { 工人监督轮次: 2 });
		const result = await fixture.host.recordSupervisedUsage({
			身份: "卡0009-清缓存.md",
			部门: "前端",
			项目根: fixture.项目根,
			累计轮次: 2,
		});
		expect(result.待办).toContain("卡0009-清缓存.md");
		expect(result.待办).toContain("无热部长会话可注入");
		const todo = fixture.host.todoView();
		expect(todo).toHaveLength(1);
		expect(todo[0].标记[0]).toContain("卡0009-清缓存.md");
	});

	it("缺保温文件:worker 监督计数直接关闭(缺文件=不保温)", async () => {
		const fixture = makeFixture("worker-off", null);
		expect(
			await fixture.host.recordSupervisedUsage({
				身份: "卡0001.md",
				部门: "前端",
				项目根: fixture.项目根,
				累计轮次: 999,
			}),
		).toEqual({});
	});
});

describe("分层监督宿主接线", () => {
	it("observeActivity 可在构造后接入真实 host,取消后清理活动并停止空闲时钟", async () => {
		let now = 0;
		let active: readonly HostActivity[];
		active = [
			{
				key: "worker:observed",
				kind: "worker",
				department: "前端",
				projectRoot: "D:/observed",
				context: "owner-observed",
				running: true,
			},
		];
		const notices: string[] = [];
		const host = new MinisterHost({
			时钟: () => new Date(now),
			监督分钟: () => ({ 工人: 15, 部门: 30 }),
			本地上级: {
				department: "前端",
				projectRoot: "D:/observed",
				context: "owner-observed",
			},
			本地通知: (body) => notices.push(body),
		});
		hosts.push(host);
		const stop = host.observeActivity(() => active);
		now = 15 * 60_000;
		await host.flushSupervision();
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("worker:observed");
		stop();
		active = [];
		await host.flushSupervision();
		expect(host.markSupervisionHandled("worker:observed")).toBe(false);
	});

	it("活动源初始为空时,直接登记对象会启动时钟并在15分钟自动投递", async () => {
		let now = 0;
		let activityReads = 0;
		const notices: string[] = [];
		vi.useFakeTimers();
		const host = new MinisterHost({
			时钟: () => new Date(now),
			监督分钟: () => ({ 工人: 15, 部门: 30 }),
			监督检查毫秒: 10,
			本地上级: {
				department: "前端",
				projectRoot: "D:/timer-start",
				context: "owner-timer",
			},
			本地通知: (body) => notices.push(body),
		});
		hosts.push(host);
		host.observeActivity(() => {
			activityReads++;
			return [];
		});
		host.trackSupervision({
			key: "worker:timer-start",
			kind: "worker",
			department: "前端",
			projectRoot: "D:/timer-start",
			context: "owner-timer",
		});
		now = 15 * 60_000;
		await vi.advanceTimersByTimeAsync(10);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("worker:timer-start");
		await host.finishSupervision({
			key: "worker:timer-start",
			outcome: "canceled",
			detail: "测试终止",
		});
		const readsAfterCancel = activityReads;
		await vi.advanceTimersByTimeAsync(100);
		expect(activityReads).toBe(readsAfterCancel);
		vi.useRealTimers();
	});

	it("普通部长进程用本地上级接收工人提醒,不查找另一个热部长", async () => {
		let now = 0;
		const notices: string[] = [];
		const host = new MinisterHost({
			时钟: () => new Date(now),
			监督分钟: () => ({ 工人: 15, 部门: 30 }),
			本地上级: {
				department: "前端",
				projectRoot: "D:/local-project",
				context: "owner-local",
				sessionId: "minister-local",
			},
			本地通知: (body) => notices.push(body),
		});
		hosts.push(host);
		host.trackSupervision({
			key: "worker:local",
			kind: "worker",
			department: "前端",
			projectRoot: "D:/local-project",
			context: "owner-local",
			sessionId: "worker-session",
			progress: {
				goal: "完成本地派工",
				recentProgress: "已改一半",
				evidence: [".pao/evidence/local.log"],
			},
		});
		now = 15 * 60_000;
		await host.flushSupervision();
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("【工人】worker:local");
		expect(notices[0]).toContain("目标:完成本地派工");
		expect(notices[0]).toContain("证据入口: .pao/evidence/local.log");
		expect(host.markLocalSupervisionHandled("worker:local")).toBe(true);
		now += 14 * 60_000;
		await host.flushSupervision();
		expect(notices).toHaveLength(1);
		now += 60_000;
		await host.flushSupervision();
		expect(notices).toHaveLength(2);
	});

	it("工人完成立即投本地部长,投递失败不把对象冒充成已处理", async () => {
		const notices: string[] = [];
		const host = new MinisterHost({
			监督分钟: () => ({ 工人: 15, 部门: 30 }),
			本地上级: {
				department: "前端",
				projectRoot: "D:/local-project",
				context: "owner-local",
			},
			本地通知: (body) => notices.push(body),
		});
		hosts.push(host);
		host.trackSupervision({
			key: "worker:done",
			kind: "worker",
			department: "前端",
			projectRoot: "D:/local-project",
			context: "owner-local",
		});
		const result = await host.finishSupervision({
			key: "worker:done",
			outcome: "needs_ruling",
			detail: "需要部长选择回退方案",
		});
		expect(result.ok).toBe(true);
		expect(notices.at(-1)).toContain("[待裁决] 工人 worker:done");
		expect(notices.at(-1)).toContain("需要部长选择回退方案");
	});

	it.each(["completed", "failed", "needs_ruling"] as const)(
		"工人%s结果投递失败后取消:清除待重试且不再通知或唤醒",
		async (outcome) => {
			const localNotices: string[] = [];
			const injections: string[] = [];
			const host = new MinisterHost({
				监督分钟: () => ({ 工人: 15, 部门: 30 }),
				通知: (body) => localNotices.push(body),
			});
			hosts.push(host);
			host.inject = async (dept, projectRoot, text) => {
				injections.push(`${dept}\u0000${projectRoot}\u0000${text}`);
				return { ok: false, 原因: "注入故意失败" };
			};
			host.trackSupervision({
				key: "worker:pending-cancel",
				kind: "worker",
				department: "前端",
				projectRoot: "D:/cancel-project",
				context: "local-owner",
			});

			// 让首次 completion/failure/needs_ruling 投递留下可重试结果。
			const failed = await host.finishSupervision({
				key: "worker:pending-cancel",
				outcome,
				detail: `${outcome} 投递失败`,
				noticeKey: "finish-pending-cancel",
			});
			expect(failed).toMatchObject({ ok: false });
			// 投递失败的对象进入待重试队列；取消必须把它静默移除。
			host.trackSupervision({
				key: "worker:pending-cancel",
				kind: "worker",
				department: "前端",
				projectRoot: "D:/cancel-project",
				context: "local-owner",
			});
			const noticesBeforeCancel = localNotices.length;
			const injectionsBeforeCancel = injections.length;
			const canceled = await host.finishSupervision({
				key: "worker:pending-cancel",
				outcome: "canceled",
				detail: "用户显式终止",
				noticeKey: "finish-pending-cancel",
			});
			expect(canceled).toEqual({ ok: true });
			await host.flushSupervision();
			expect(localNotices).toHaveLength(noticesBeforeCancel);
			expect(injections).toHaveLength(injectionsBeforeCancel);
			expect(host.markSupervisionHandled("worker:pending-cancel")).toBe(false);
		},
	);

	it("外部活动快照含只读部门仍到期,待人工部门不唤醒", async () => {
		let now = 0;
		const notices: string[] = [];
		const host = new MinisterHost({
			时钟: () => new Date(now),
			监督分钟: () => ({ 工人: 15, 部门: 30 }),
			活动: () => [
				{
					key: "department:readonly",
					kind: "department",
					department: "规划",
					projectRoot: "D:/p",
					ownerSessionId: "owner-1",
					readonly: true,
					running: true,
				},
				{
					key: "department:waiting",
					kind: "department",
					department: "验收",
					projectRoot: "D:/p",
					ownerSessionId: "owner-1",
					waitingForHuman: true,
					running: true,
				},
			],
			通知: (body) => notices.push(body),
		});
		hosts.push(host);
		now = 30 * 60_000;
		await host.flushSupervision();
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("【部门】department:规划:");
		expect(notices[0]).not.toContain("【部门】department:验收:");
	});

	it("宿主通知保留显式类别:提示线为 progress,部门监督为 supervision,终态按结果分类", async () => {
		let now = 0;
		const notices: Array<{ body: string; category: DispatchNotifyCategory }> = [];
		const host = new MinisterHost({
			时钟: () => new Date(now),
			监督分钟: () => ({ 工人: 0, 部门: 30 }),
			通知: (body, category) => notices.push({ body, category }),
		});
		hosts.push(host);
		host.receiveNotice((body, category) => notices.push({ body, category }));

		host.trackSupervision({
			key: "department:classified",
			kind: "department",
			department: "前端",
			projectRoot: "D:/classified",
			ownerSessionId: "owner-classified",
		});
		now = 30 * 60_000;
		await host.flushSupervision();
		expect(notices.at(-1)).toMatchObject({ category: "supervision" });
		expect(notices.at(-1)?.body).toContain("[监督检查]");

		host.trackSupervision({
			key: "department:completed",
			kind: "department",
			department: "前端",
			projectRoot: "D:/classified",
			ownerSessionId: "owner-classified",
		});
		await host.finishSupervision({
			key: "department:completed",
			outcome: "completed",
			detail: "全部核验通过",
		});
		expect(notices.at(-1)).toMatchObject({ category: "result" });

		host.trackSupervision({
			key: "department:failed",
			kind: "department",
			department: "前端",
			projectRoot: "D:/classified",
			ownerSessionId: "owner-classified",
		});
		await host.finishSupervision({
			key: "department:failed",
			outcome: "failed",
			detail: "机械验收失败",
		});
		expect(notices.at(-1)).toMatchObject({ category: "failure" });

		host.trackSupervision({
			key: "department:ruling",
			kind: "department",
			department: "前端",
			projectRoot: "D:/classified",
			ownerSessionId: "owner-classified",
		});
		await host.finishSupervision({
			key: "department:ruling",
			outcome: "needs_ruling",
			detail: "需要人工选择",
		});
		expect(notices.at(-1)).toMatchObject({ category: "ruling" });
	});
});
