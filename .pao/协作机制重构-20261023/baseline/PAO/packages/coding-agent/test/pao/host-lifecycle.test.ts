import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as handoff from "../../src/pao/host/handoff.ts";
import { MinisterHost } from "../../src/pao/host/host.ts";

/**
 * 部长会话在线宿主·生命周期(定案1/2/7):
 * 载体＝pi RPC 常驻子进程(测试打假进程),env 强制 PAO_ROLE=部长＋PAO_DEPT,
 * 配方快照进人设,绑定 key 同键单会话,进程登记表带「部长」标签,主会话关闭全停。
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
	const dir = mkdtempSync(join(tmpdir(), `pao-host-life-${prefix}-`));
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

/** 假部长会话:RPC 最低限度仿真——应答 get_state,回 N 轮 message_end＋M 次工具调用,
 * stdin 每行追加进 dump 文件(供注入断言),随后挂住不退 */
const FAKE_MINISTER = `
const fs = require("node:fs");
const dump = process.argv[2];
const rounds = Number(process.argv[3] || 0);
const toolCalls = Number(process.argv[4] || 0);
if (dump) fs.writeFileSync(dump, JSON.stringify({ role: process.env.PAO_ROLE, dept: process.env.PAO_DEPT, args: process.argv.slice(2) }));
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (dump) fs.appendFileSync(dump, "\\nSTDIN\\t" + line);
    try {
      const cmd = JSON.parse(line);
      if (cmd.type === "get_state")
        console.log(JSON.stringify({ type: "response", id: cmd.id, command: "get_state", success: true, data: { sessionId: "fake-pi-session-1" } }));
      // 注入回执(审查第 7 项):宿主按这条 response 结算注入,不再发完就报成功
      if (cmd.type === "prompt")
        console.log(JSON.stringify({ type: "response", id: cmd.id, command: "prompt", success: true, data: { disposition: "queued" } }));
    } catch {}
  }
});
for (let i = 0; i < toolCalls; i++)
  console.log(JSON.stringify({ type: "message_update", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "t" + i, toolName: "read" } }));
for (let i = 0; i < rounds; i++)
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "回执标题" + i }], stopReason: "end", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 } } } }));
setInterval(() => {}, 1000);
`;

interface FakeFixture {
	host: MinisterHost;
	脚本: string;
	项目根: string;
	home: string;
	dump: string;
}

/** 造一个假部长会话拉起环境:PAO_HOME(含配方)＋项目根＋假脚本 */
function makeFixture(prefix: string, recipe = ""): FakeFixture {
	const home = tempDir(`${prefix}-home`);
	mkdirSync(join(home, "pao配置"), { recursive: true });
	if (recipe) {
		mkdirSync(join(home, "部门", "前端"), { recursive: true });
		writeFileSync(join(home, "部门", "前端", "配方.md"), recipe, "utf8");
	}
	const projectRoot = tempDir(`${prefix}-proj`);
	mkdirSync(projectRoot, { recursive: true });
	const script = join(tempDir(`${prefix}-bin`), "fake-minister.cjs");
	writeFileSync(script, FAKE_MINISTER, "utf8");
	const host = new MinisterHost({ paoHome: home });
	hosts.push(host);
	return { host, 脚本: script, 项目根: projectRoot, home, dump: `${script}.dump` };
}

describe("真实 RPC 子后台机械事件(不调用模型)", () => {
	it("readonly 部长 settled 后 child 仍运行:30 分钟部门检查、熔断保活;清零后退出并只回投短摘要", async () => {
		let now = Date.parse("2026-10-22T00:00:00.000Z");
		const home = tempDir("childbg-home");
		mkdirSync(join(home, "pao配置"), { recursive: true });
		writeFileSync(join(home, "pao配置", "保温.json"), JSON.stringify({ 空闲分钟: 30 }), "utf8");
		const projectRoot = tempDir("childbg-proj");
		const notices: string[] = [];
		const host = new MinisterHost({
			paoHome: home,
			时钟: () => new Date(now),
			监督分钟: () => ({ 工人: 0, 部门: 30 }),
			通知: (text) => notices.push(text),
		});
		hosts.push(host);
		const record = join(tempDir("childbg-record"), "minister.jsonl");
		writeFileSync(record, "", "utf8");
		const script = join(tempDir("childbg-bin"), "minister.cjs");
		writeFileSync(
			script,
			[
				'const readline=require("node:readline");',
				'readline.createInterface({input:process.stdin}).on("line",line=>{',
				" const cmd=JSON.parse(line);const emit=v=>console.log(JSON.stringify(v));",
				' if(cmd.type==="get_state") emit({type:"response",id:cmd.id,command:cmd.type,success:true,data:{sessionId:"child-session"}});',
				' if(cmd.type==="prompt"){',
				'  if(cmd.message==="clear"){emit({type:"background_work",running:0,unread:0});emit({type:"response",id:cmd.id,command:cmd.type,success:true,data:{disposition:"handled"}});return;}',
				'  emit({type:"response",id:cmd.id,command:cmd.type,success:true,data:{disposition:"started"}});',
				'  emit({type:"agent_start"});',
				'  emit({type:"background_work",running:2,unread:0});',
				'  emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"部长已派两个工人，等待结果"}],stopReason:"stop"}});',
				'  emit({type:"agent_settled"});',
				'  require("node:fs").appendFileSync(process.argv[2], JSON.stringify({pid:process.pid})+"\\n");',
				" }",
				"});setInterval(()=>{},1000);",
			].join("\n"),
			"utf8",
		);
		const spawned = await host.spawn({
			部门: "规划",
			项目根: projectRoot,
			脉络: "owner-child",
			命令: process.execPath,
			参数: [script, record],
		});
		if (!spawned.ok) throw new Error(spawned.原因);
		expect(
			await waitUntil(() => host.hotSession("规划", projectRoot, "owner-child")?.会话标识 === "child-session", 1000),
		).toBe(true);
		const injected = await host.inject("规划", projectRoot, "只读部长任务", "owner-child", "followUp");
		expect(injected.ok).toBe(true);
		expect(
			await waitUntil(
				() =>
					host.backgroundCountFor({
						department: "规划",
						projectRoot,
						context: "owner-child",
						sessionId: "child-session",
					}).inFlight === 2,
			),
		).toBe(true);
		now += 30 * 60_000;
		await host.flushSupervision();
		const checks = notices.filter((text) => text.includes("[监督检查]") && text.includes("部门检查间隔 30 分钟"));
		expect(checks).toHaveLength(1);
		expect(checks[0]).toContain("真实子后台运行中 2");
		expect(checks[0]).toContain('pao_ack_supervision(key="department:规划:');
		expect(await host.checkFuse()).toEqual([]);
		expect(host.backgroundCount().inFlight).toBe(2);
		expect(notices.some((text) => text.includes("[部长完成]"))).toBe(false);
		expect((await host.inject("规划", projectRoot, "clear", "owner-child", "followUp")).ok).toBe(true);
		expect(await waitUntil(() => notices.some((text) => text.includes("[部长完成]")))).toBe(true);
		const completion = notices.filter((text) => text.includes("[部长完成]"));
		expect(completion).toHaveLength(1);
		expect(completion[0]).toContain("部门 规划｜会话 child-session｜项目");
		expect(completion[0]).toContain("摘要:部长已派两个工人，等待结果");
		await host.flushSupervision();
		expect(notices.filter((text) => text.includes("[部长完成]"))).toHaveLength(1);
	}, 20_000);
});

describe("工作流 RPC 任务桥（模拟协议进程，不调用模型）", () => {
	const script = `const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const cmd=JSON.parse(line);const emit=v=>console.log(JSON.stringify(v));
 if(cmd.type==='get_state') emit({type:'response',id:cmd.id,command:cmd.type,success:true,data:{sessionId:'task-session'}});
 if(cmd.type==='prompt') {
  if(cmd.message==='fail') return emit({type:'response',id:cmd.id,command:cmd.type,success:false,error:'fixture rejection'});
  emit({type:'agent_start'});
  if(cmd.message==='wait') return;
  if(cmd.message==='provider-error'||cmd.message==='provider-aborted') {
   emit({type:'message_end',message:{role:'assistant',content:[],stopReason:cmd.message==='provider-error'?'error':'aborted',errorMessage:'fixture provider terminal'}});
   return setTimeout(()=>emit({type:'agent_settled'}),50);
  }
  emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'simulated complete'}],stopReason:'stop'}});
  emit({type:'agent_settled'});
 }
});setInterval(()=>{},1000);`;
	async function start(f: FakeFixture, context: string) {
		writeFileSync(f.脚本, script);
		const result = await f.host.spawn({
			部门: "前端",
			项目根: f.项目根,
			脉络: context,
			命令: process.execPath,
			参数: [f.脚本],
		});
		if (!result.ok) throw new Error(result.原因);
		return { 部门: "前端", 项目根: f.项目根, 脉络: context, 会话标识: result.handle.会话标识 };
	}
	it("按脉络隔离，同步等待真实协议结束并拒绝错误身份", async () => {
		const f = makeFixture("task");
		const first = await start(f, "flow-one");
		await start(f, "flow-two");
		expect(f.host.list()).toHaveLength(2);
		await expect(f.host.executeTask({ ...first, 会话标识: "forged", 文本: "ok" })).rejects.toThrow("身份失配");
		await expect(f.host.executeTask({ ...first, 文本: "ok" })).resolves.toBe("simulated complete");
		await expect(f.host.executeTask({ ...first, 文本: "fail" })).rejects.toThrow("fixture rejection");
		await expect(f.host.executeTask({ ...first, 文本: "provider-error" })).rejects.toThrow(
			"fixture provider terminal",
		);
		await expect(f.host.executeTask({ ...first, 文本: "provider-aborted" })).rejects.toThrow(
			"fixture provider terminal",
		);
		await f.host.teardown("前端", f.项目根, "only first", "flow-one");
		expect(f.host.list().map((h) => h.脉络)).toEqual(["flow-two"]);
	}, 20000);
	it("取消等待中的任务会杀进程且不会返回成功", async () => {
		const f = makeFixture("abort");
		const context = await start(f, "flow-abort");
		const controller = new AbortController();
		const task = f.host.executeTask({ ...context, 文本: "wait", signal: controller.signal });
		const checked = expect(task).rejects.toThrow(/停止|退出|取消/);
		controller.abort();
		await checked;
		await waitUntil(() => f.host.list().length === 0);
		expect(f.host.list()).toHaveLength(0);
	}, 20000);
});

async function spawnFakeMinister(
	fixture: FakeFixture,
	dept = "前端",
	rounds = 0,
	toolCalls = 0,
	projectRoot = fixture.项目根,
) {
	const result = await fixture.host.spawn({
		部门: dept,
		项目根: projectRoot,
		命令: process.execPath,
		参数: [fixture.脚本, fixture.dump, String(rounds), String(toolCalls)],
	});
	if (!result.ok) throw new Error(`拉起失败:${result.原因}`);
	// 等握手:会话标识从 rpc-<pid> 换成假进程应答的 id
	await waitUntil(() => fixture.host.hotSession(dept, projectRoot)?.会话标识 === "fake-pi-session-1");
	return result;
}

describe("拉起:RPC 子进程＋身份注入＋配方快照(定案1/2)", () => {
	it("env 强制 PAO_ROLE=部长＋PAO_DEPT;配方快照以 --append-system-prompt 进人设", async () => {
		const fixture = makeFixture("env", "# 配方\n- 名字: 前端\n- 默认档位: 主力\n");
		const { handle } = await spawnFakeMinister(fixture);
		const dump = JSON.parse(readFileSync(fixture.dump, "utf8").split("\n")[0]) as {
			role: string;
			dept: string;
			args: string[];
		};
		expect(dump.role).toBe("部长");
		expect(dump.dept).toBe("前端");
		const snapshotSlot = dump.args.indexOf("--append-system-prompt");
		expect(snapshotSlot).toBeGreaterThan(-1);
		const snapshot = dump.args[snapshotSlot + 1];
		expect(snapshot).toContain("截至");
		expect(snapshot).toContain("默认档位: 主力");
		expect(handle.部门).toBe("前端");
		expect(handle.项目根.length).toBeGreaterThan(0);
		expect(handle.配方指纹).toMatch(/^[0-9a-f]{40}$/);
		expect(handle.pid).toBeGreaterThan(0);
	});

	it("无配方:指纹为 null 且不带快照参数;句柄照常建立", async () => {
		const fixture = makeFixture("norecipe");
		const { handle } = await spawnFakeMinister(fixture);
		expect(handle.配方指纹).toBeNull();
		const dump = JSON.parse(readFileSync(fixture.dump, "utf8").split("\n")[0]) as { args: string[] };
		expect(dump.args).not.toContain("--append-system-prompt");
	});

	it("缺部门/缺项目根:拒绝拉起", async () => {
		const fixture = makeFixture("reject");
		const noDept = await fixture.host.spawn({ 部门: "  ", 项目根: fixture.项目根 });
		expect(noDept.ok).toBe(false);
		const noRoot = await fixture.host.spawn({ 部门: "前端", 项目根: "  " });
		expect(noRoot.ok).toBe(false);
	});

	it("部门带路径成分(../、反斜杠、盘符、绝对路径):拒绝拉起,不产生任何子进程与越界路径", async () => {
		const fixture = makeFixture("evildept");
		for (const dept of [
			"../../evil",
			"前端/../evil",
			"a\\b",
			"..\\evil",
			"C:\\evil",
			"C:evil",
			"/abs",
			"部门/../../x",
		]) {
			const result = await fixture.host.spawn({ 部门: dept, 项目根: fixture.项目根 });
			expect(result.ok, dept).toBe(false);
			expect(fixture.host.list()).toHaveLength(0);
		}
	});

	it("拉起命令不存在:异步 spawn error 被消费(通知留痕),主控不崩", async () => {
		const fixture = makeFixture("spawnerr");
		const notice: string[] = [];
		fixture.host.receiveNotice((text) => notice.push(text));
		const result = await fixture.host.spawn({
			部门: "前端",
			项目根: fixture.项目根,
			命令: "pao-不存在的命令-xyz",
		});
		expect(result.ok).toBe(false);
		// 给异步 error 事件发出来的机会:无人消费即未捕获异常,测试进程直接崩
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(notice.join("\n")).toContain("spawn error");
	});
});

describe("绑定 key=部门＋项目根:同键单会话,归一化命中(定案2)", () => {
	it("同 key 二次拉起返回既有句柄(已有热会话),不双开;大小写/斜杠差异命中同键", async () => {
		const fixture = makeFixture("samekey");
		const first = await spawnFakeMinister(fixture);
		const again = await spawnFakeMinister(fixture);
		expect(again.已有热会话).toBe(true);
		expect(again.handle.pid).toBe(first.handle.pid);
		const root2 = fixture.项目根.replaceAll("\\", "/").toUpperCase();
		const hit = await fixture.host.spawn({
			部门: "前端",
			项目根: root2,
			命令: process.execPath,
			参数: [fixture.脚本, fixture.dump, "0", "0"],
		});
		expect(hit.ok && hit.已有热会话).toBe(true);
		expect(fixture.host.list()).toHaveLength(1);
	});
});

describe("登记表(定案7):部长条目标签=部长,卡号为空,理由留空", () => {
	it("register 归一:部长条目带标签;worker 侧不填标签归一 null", async () => {
		const fixture = makeFixture("registry");
		await spawnFakeMinister(fixture);
		const entry = fixture.host.registry.list().find((item) => item.tags === "部长");
		expect(entry).toBeDefined();
		expect(entry?.card_no).toBe("");
		expect(entry?.dept).toBe("前端");
		expect(entry?.dispatch_reason).toBeNull();
		expect(entry?.running).toBe(true);
		const probe = fixture.host.registry.register({ pid: 999999, card_no: "0001", command: "x" });
		expect(probe).toBeUndefined();
		const workerEntry = fixture.host.registry.list().find((item) => item.pid === 999999);
		expect(workerEntry?.tags).toBeNull();
	});
});

describe("输入投递(保温三类输入的通道)与会话标识握手", () => {
	it.each(["timeout", "wrong-id", "failed", "exit"])("握手异常 %s 不报告启动成功，并清除所建进程", async (mode) => {
		const fixture = makeFixture(`handshake-${mode}`);
		const host = new MinisterHost({ paoHome: fixture.home, 握手超时毫秒: 700 });
		hosts.push(host);
		writeFileSync(
			fixture.脚本,
			`
process.stdin.setEncoding("utf8");
process.stdin.on("data", data => {
  const cmd = JSON.parse(data.trim());
  if (${JSON.stringify(mode)} === "exit") process.exit(1);
  if (${JSON.stringify(mode)} === "timeout") return;
  console.log(JSON.stringify({type:"response",command:"get_state",id:${JSON.stringify(mode)} === "wrong-id" ? "other" : cmd.id,success:false,data:{sessionId:"untrusted"}}));
});
setInterval(() => {}, 1000);
`,
			"utf8",
		);
		const result = await host.spawn({
			部门: "前端",
			项目根: fixture.项目根,
			命令: process.execPath,
			参数: [fixture.脚本],
		});
		expect(result.ok).toBe(false);
		expect(host.list()).toEqual([]);
		for (const entry of host.registry.list()) {
			expect(entry.running).toBe(false);
			expect(await waitUntil(() => !alive(entry.pid))).toBe(true);
		}
	});

	it("get_state 握手取得 pi 会话标识;注入的 prompt 经 stdin 抵达子进程", async () => {
		const fixture = makeFixture("inject");
		await spawnFakeMinister(fixture);
		const result = await fixture.host.inject("前端", fixture.项目根, "卡0009 已建,请审排程");
		expect(result.ok).toBe(true);
		const arrived = await waitUntil(() => {
			const text = existsSync(fixture.dump) ? readFileSync(fixture.dump, "utf8") : "";
			return text.includes("STDIN") && text.includes("卡0009 已建,请审排程");
		});
		expect(arrived).toBe(true);
	});

	it("无热会话注入:拒绝并说明,不静默丢消息", async () => {
		const fixture = makeFixture("inject2");
		const result = await fixture.host.inject("前端", fixture.项目根, "插话");
		expect(result.ok).toBe(false);
		expect(result.原因).toContain("无热部长会话");
	});
});

describe("事件边界同步与部长账落行(真实线型端到端,落账门 轮完成?.含用量 触发验证)", () => {
	it("N 轮 message_end＋M 次工具调用:盘点行轮次/调用/成本非零,部长账逐轮落行", async () => {
		const fixture = makeFixture("ledger");
		await spawnFakeMinister(fixture, "前端", 3, 2);
		await waitUntil(() => (fixture.host.hotSession("前端", fixture.项目根)?.累计.轮次 ?? 0) >= 3);
		const line = fixture.host.inventoryView()[0];
		expect(line.轮次).toBe(3);
		expect(line.工具调用).toBe(2);
		expect(line.成本).toBeCloseTo(0.03, 6);
		const ledger = readFileSync(join(fixture.项目根, ".pao", "四指标账.txt"), "utf8")
			.trim()
			.split("\n")
			.filter((line) => !line.startsWith("#"));
		expect(ledger).toHaveLength(3);
		expect(ledger[0]).toContain("部长");
		expect(ledger[0]).toContain("第1轮");
		expect(ledger[2]).toContain("第3轮");
		expect(ledger[0].split("	")[4]).toBe("0.01");
	});
});

describe("主会话关闭全停与崩溃摘除(定案7,架构 §1 无常驻)", () => {
	it("stopAll:树杀全部热会话(进程真死)＋登记表摘除＋句柄清空", async () => {
		const fixture = makeFixture("stopall");
		const { handle } = await spawnFakeMinister(fixture);
		expect(alive(handle.pid)).toBe(true);
		const records = await fixture.host.stopAll("测试全停");
		expect(records).toHaveLength(1);
		expect(records[0].原因).toBe("测试全停");
		expect(await waitUntil(() => !alive(handle.pid))).toBe(true);
		expect(fixture.host.list()).toHaveLength(0);
		expect(fixture.host.registry.list().find((item) => item.pid === handle.pid)?.running).toBe(false);
	});

	it("子进程崩溃:句柄摘除＋登记表标退出(不落交接,崩溃窗口归 S3 口径)", async () => {
		const fixture = makeFixture("crash");
		const { handle } = await spawnFakeMinister(fixture);
		process.kill(handle.pid);
		expect(await waitUntil(() => fixture.host.hotSession("前端", fixture.项目根) === undefined)).toBe(true);
		expect(fixture.host.registry.list().find((item) => item.pid === handle.pid)?.running).toBe(false);
	});

	it("进程死亡留证:stderr 尾部落 <项目根>/.pao/部长留证/,握手失败 spawn 原因带 stderr尾", async () => {
		const fixture = makeFixture("stderrlog");
		writeFileSync(
			fixture.脚本,
			`
process.stderr.write("Model \\"primary\\" not found: fixture fatal detail\
");
process.exit(1);
`,
			"utf8",
		);
		const result = await fixture.host.spawn({
			部门: "前端",
			项目根: fixture.项目根,
			命令: process.execPath,
			参数: [fixture.脚本],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.原因).toContain("stderr尾");
			expect(result.原因).toContain("Model");
		}
		const dir = join(fixture.项目根, ".pao", "部长留证");
		expect(await waitUntil(() => existsSync(dir) && readdirSync(dir).length > 0)).toBe(true);
		const files = readdirSync(dir);
		expect(files[0]).toMatch(/^前端-pid\d+-退出-\d{8}-\d{6}-\d{3}\.md$/);
		const text = readFileSync(join(dir, files[0]), "utf8");
		expect(text).toContain('Model "primary" not found');
		expect(text).toContain("留证原因:进程退出");
		expect(text).toContain("会话标识:");
	}, 20000);

	it("常规散场不落盘:干净散场(stderr 尾为空)不写 部长留证,close 也不补写", async () => {
		const fixture = makeFixture("evidence-clean");
		const { handle } = await spawnFakeMinister(fixture);
		await fixture.host.teardown("前端", fixture.项目根, "工作流切换节点任务边界");
		expect(await waitUntil(() => !alive(handle.pid))).toBe(true);
		// 给 close 事件处理留时间(树杀后进程退出才触发),确认粘性标记让 close 也不落
		await new Promise((resolve) => setTimeout(resolve, 300));
		const dir = join(fixture.项目根, ".pao", "部长留证");
		const files = existsSync(dir) ? readdirSync(dir) : [];
		expect(files).toHaveLength(0);
	}, 20000);

	it("散场 stderr 尾非空才落一份:树杀前散场已留证,close 不再补写「进程退出」覆盖真实死因", async () => {
		const fixture = makeFixture("evidence-once");
		// 假部长补一行 stderr:散场留证的轮转条件是「stderr 尾非空」(干净散场不落盘)
		writeFileSync(
			fixture.脚本,
			`${FAKE_MINISTER}process.stderr.write("fixture stderr clue\
");
`,
			"utf8",
		);
		const { handle } = await spawnFakeMinister(fixture);
		await fixture.host.teardown("前端", fixture.项目根, "测试散场原因");
		expect(await waitUntil(() => !alive(handle.pid))).toBe(true);
		// 给 close 事件处理留时间(树杀后进程退出才触发),再数文件
		await new Promise((resolve) => setTimeout(resolve, 300));
		const dir = join(fixture.项目根, ".pao", "部长留证");
		const files = existsSync(dir) ? readdirSync(dir) : [];
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^前端-pid\d+-散场-\d{8}-\d{6}-\d{3}\.md$/);
		const text = readFileSync(join(dir, files[0]), "utf8");
		expect(text).toContain("留证原因:测试散场原因");
		expect(text).toContain("fixture stderr clue");
	}, 20000);

	it("交接落盘期间进程死亡:散场留证已先置位,close 不补写「退出」,仍只落一份", async () => {
		const fixture = makeFixture("evidence-during-handoff");
		writeFileSync(
			fixture.脚本,
			`${FAKE_MINISTER}process.stderr.write("fixture stderr clue\
");
`,
			"utf8",
		);
		const { handle } = await spawnFakeMinister(fixture);
		// 复现时序窗口:进程恰在交接页写入期间死亡(close 先到,散场还没走到留证后段)
		const realWrite = handoff.writeHandoffPage;
		const spy = vi.spyOn(handoff, "writeHandoffPage").mockImplementation(async (input) => {
			process.kill(handle.pid);
			await new Promise((resolve) => setTimeout(resolve, 300)); // 让 close 处理先跑完
			return realWrite(input);
		});
		try {
			await fixture.host.teardown("前端", fixture.项目根, "交接期间死亡");
		} finally {
			spy.mockRestore();
		}
		expect(await waitUntil(() => !alive(handle.pid))).toBe(true);
		const dir = join(fixture.项目根, ".pao", "部长留证");
		const files = existsSync(dir) ? readdirSync(dir) : [];
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^前端-pid\d+-散场-\d{8}-\d{6}-\d{3}\.md$/);
		expect(readFileSync(join(dir, files[0]), "utf8")).toContain("留证原因:交接期间死亡");
	}, 20000);

	it("stopAll 后可再拉起(主控 reload/new 后同进程扩展重注册,宿主不封锁)", async () => {
		const fixture = makeFixture("relaunch");
		const first = await spawnFakeMinister(fixture);
		await fixture.host.stopAll();
		const second = await spawnFakeMinister(fixture);
		expect(second.ok).toBe(true);
		expect(second.handle.pid).not.toBe(first.handle.pid);
	});
});
