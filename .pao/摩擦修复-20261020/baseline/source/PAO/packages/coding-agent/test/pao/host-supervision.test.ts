import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assessLiveness, type LivenessInput } from "../../src/pao/host/handle.ts";
import { MinisterHost } from "../../src/pao/host/host.ts";

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
