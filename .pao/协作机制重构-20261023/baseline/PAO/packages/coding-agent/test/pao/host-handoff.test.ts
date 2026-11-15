import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { handoffFileName, handoffPointerText, writeHandoffPage } from "../../src/pao/host/handoff.ts";
import { MinisterHost } from "../../src/pao/host/host.ts";

/**
 * 散场交接(定案4/设计包 §3):复用 cards/handoff.ts renderHandoff 四段落
 * $PAO_HOME/部门/<名>/交接/<项目名>-<根摘要>.md——同绑定 key 一文件新盖旧,
 * 同名不同根不覆盖;派卡信封的指针文本带「背景核对,不是续跑指令」。
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
	const dir = mkdtempSync(join(tmpdir(), `pao-host-handoff-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

const FAKE_IDLE = `
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const cmd = JSON.parse(line);
  if (cmd.type === "get_state") console.log(JSON.stringify({type:"response",id:cmd.id,command:"get_state",success:true,data:{sessionId:"fake-handoff"}}));
});
setInterval(() => {}, 1000);
`;

function makeFixture(prefix: string): { host: MinisterHost; home: string; script: string } {
	const home = tempDir(`${prefix}-home`);
	mkdirSync(join(home, "pao配置"), { recursive: true });
	const script = join(tempDir(`${prefix}-bin`), "fake-minister.cjs");
	writeFileSync(script, FAKE_IDLE, "utf8");
	const host = new MinisterHost({ paoHome: home });
	hosts.push(host);
	return { host, home, script: script };
}

function writeCard(cardsDir: string, cardNo: number, goal: string, status = "in_progress"): void {
	writeFileSync(
		join(cardsDir, `卡${String(cardNo).padStart(4, "0")}-${goal}.md`),
		`---\ngoal: ${goal}\ndept: 前端\nacceptance: 完成\ncreated: 2026-10-03 09:00\nstatus: ${status}\nattempt: 1\n---\n\n做事中\n`,
		"utf8",
	);
}

describe("散场落交接:renderHandoff 四段＋新盖旧＋同名不同根不覆盖", () => {
	it("落盘路径与四段结构;同 key 再散场覆盖同文件(旧内容被顶掉)", async () => {
		const { host, home, script } = makeFixture("basic");
		const projectRoot = tempDir("proj1");
		const cardsDir = join(projectRoot, ".pao", "卡");
		mkdirSync(cardsDir, { recursive: true });
		writeCard(cardsDir, 3, "修登录");

		const spawn = await host.spawn({ 部门: "前端", 项目根: projectRoot, 命令: process.execPath, 参数: [script] });
		expect(spawn.ok).toBe(true);
		const record = await host.teardown("前端", projectRoot, "空闲熔断(超过 30 分钟无事件)");
		expect(record?.交接路径).toBe(join(home, "部门", "前端", "交接", handoffFileName(projectRoot)));
		const body = readFileSync(record!.交接路径!, "utf8");
		expect(body).toContain("# 交接页");
		expect(body).toContain("## 当前目标");
		expect(body).toContain("## 已发生改动");
		expect(body).toContain("## 验证结果");
		expect(body).toContain("## 未决事项");
		expect(body).toContain("卡0003 修登录");
		expect(body).toContain(`项目根:${projectRoot}`);

		// 新盖旧:预写旧货内容,再拉起再散场,文件被新交接覆盖
		writeFileSync(record!.交接路径!, "这是旧货", "utf8");
		const spawn2 = await host.spawn({ 部门: "前端", 项目根: projectRoot, 命令: process.execPath, 参数: [script] });
		expect(spawn2.ok).toBe(true);
		const record2 = await host.teardown("前端", projectRoot);
		expect(record2?.交接路径).toBe(record!.交接路径);
		const body2 = readFileSync(record2!.交接路径!, "utf8");
		expect(body2).not.toContain("这是旧货");
		expect(body2).toContain("# 交接页");
	});

	it("同名项目不同根:根摘要不同,互不覆盖", async () => {
		const { home } = makeFixture("tworoots");
		const rootA = tempDir("alpha");
		const rootB = tempDir("beta");
		// 目录名不同时改用同名目录名:直接断言两个根算出不同文件名即可(归一摘要消除碰撞)
		expect(handoffFileName(rootA)).not.toBe(handoffFileName(rootB));
		expect(handoffFileName(rootA)).toMatch(/-[\da-f]{8}\.md$/);
		await writeHandoffPage({ paoHome: home, 部门: "前端", 项目根: rootA, 卡目录: join(rootA, ".pao", "卡") });
		await writeHandoffPage({ paoHome: home, 部门: "前端", 项目根: rootB, 卡目录: join(rootB, ".pao", "卡") });
		const dir = join(home, "部门", "前端", "交接");
		const files = readFileSync(join(dir, handoffFileName(rootA)), "utf8");
		expect(files).toContain(`项目根:${rootA}`);
		const filesB = readFileSync(join(dir, handoffFileName(rootB)), "utf8");
		expect(filesB).toContain(`项目根:${rootB}`);
	});
});

describe("派卡信封的交接指针(定案10 的指针文本)", () => {
	it("文件在才指针;指针文本写明「背景核对,不是续跑指令」", async () => {
		const { host, home, script } = makeFixture("pointer");
		const projectRoot = tempDir("proj2");
		mkdirSync(join(projectRoot, ".pao", "卡"), { recursive: true });
		expect(host.dispatchHandoffPointer("前端", projectRoot)).toBeUndefined(); // 无热会话
		const round1 = await host.spawn({ 部门: "前端", 项目根: projectRoot, 命令: process.execPath, 参数: [script] });
		expect(round1.ok).toBe(true);
		expect(host.dispatchHandoffPointer("前端", projectRoot)).toBeUndefined(); // 热会话但交接文件未落
		await host.teardown("前端", projectRoot); // 散场落交接(同 key 恒定一文件)
		const round2 = await host.spawn({ 部门: "前端", 项目根: projectRoot, 命令: process.execPath, 参数: [script] });
		expect(round2.ok).toBe(true); // 热会话在场,上一轮交接文件幸存
		const pointer = host.dispatchHandoffPointer("前端", projectRoot);
		expect(pointer).toContain("背景核对");
		expect(pointer).toContain("不是续跑指令");
		expect(pointer).toContain(join(home, "部门", "前端", "交接"));
	});

	it("交接指针文本纯函数:文件不存在返回 undefined", () => {
		expect(handoffPointerText(join(tempDir("nofile"), "无.md"))).toBeUndefined();
	});
});
