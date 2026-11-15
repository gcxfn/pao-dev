import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { METRICS_LEDGER_HEADER } from "../../src/pao/cards/metrics.ts";
import { MinisterHost } from "../../src/pao/host/host.ts";
import { buildMinisterLedgerLine, ministerLedgerPath } from "../../src/pao/host/ledger.ts";

/**
 * 部长会话用量落账(定案8):每轮 usage 按「部门＋项目」聚合追加
 * <项目根>/.pao/四指标账.txt——与结卡四指标账同文件同写入器(appendMetricsLine:
 * 首行口径注释＋原子写),卡号位标「部长」。落账不依赖保温开关(对账不是保温功能),
 * 缺 usage 的轮不落账不填零(R07)。
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
	const dir = mkdtempSync(join(tmpdir(), `pao-host-ledger-${prefix}-`));
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

/** 假部长:回 N 轮顶层 message_end(真实 RPC 线型),每轮 cost 0.01;第 2 轮起不带 usage(缺账轮)由参数控制 */
const FAKE_ROUNDS = `
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const cmd = JSON.parse(line);
  if (cmd.type === "get_state") console.log(JSON.stringify({type:"response",id:cmd.id,command:"get_state",success:true,data:{sessionId:"fake-ledger"}}));
});
const rounds = Number(process.argv[2] || 0);
const 缺账轮 = Number(process.argv[3] || 0);
for (let i = 0; i < rounds; i++) {
  const usage = i < rounds - 缺账轮 ? { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 } } : undefined;
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "第" + i + "轮" }], stopReason: "end", ...(usage ? { usage } : {}) } }));
}
setInterval(() => {}, 1000);
`;

describe("每轮 usage 聚合落账:四指标账同款格式,卡号位标「部长」", () => {
	it("两轮 usage → 首行口径注释＋两行数据;列映射与写入器复用", async () => {
		const home = tempDir("home");
		mkdirSync(join(home, "pao配置"), { recursive: true });
		const projectRoot = tempDir("proj");
		mkdirSync(projectRoot, { recursive: true });
		const script = join(tempDir("bin"), "fake-minister.cjs");
		writeFileSync(script, FAKE_ROUNDS, "utf8");
		const host = new MinisterHost({ paoHome: home, 保温: () => ({ 存在: false }) });
		hosts.push(host);
		const spawn = await host.spawn({
			部门: "前端",
			项目根: projectRoot,
			命令: process.execPath,
			参数: [script, "2", "0"],
		});
		expect(spawn.ok).toBe(true);
		await waitUntil(() => (host.hotSession("前端", projectRoot)?.累计.轮次 ?? 0) >= 2);

		const ledgerPath = ministerLedgerPath(projectRoot);
		expect(existsSync(ledgerPath)).toBe(true);
		const lines = readFileSync(ledgerPath, "utf8").trimEnd().split("\n");
		expect(lines[0]).toBe(METRICS_LEDGER_HEADER);
		expect(lines).toHaveLength(3);
		const line1 = lines[1].split("\t");
		const line2 = lines[2].split("\t");
		expect(line1).toHaveLength(6);
		expect(line1[0]).toBe("部长");
		expect(line1[1]).toContain("部门:前端｜项目:");
		expect(line1[2]).toBe("第1轮");
		expect(line1[4]).toBe("0.01");
		expect(line1[5]).toBe("0");
		expect(line2[2]).toBe("第2轮");
	});

	it("缺 usage 的轮不落账不填零(R07);落账不依赖保温开关", async () => {
		const home = tempDir("home2");
		mkdirSync(join(home, "pao配置"), { recursive: true });
		const projectRoot = tempDir("proj2");
		mkdirSync(projectRoot, { recursive: true });
		const script = join(tempDir("bin2"), "fake-minister.cjs");
		writeFileSync(script, FAKE_ROUNDS, "utf8");
		const host = new MinisterHost({ paoHome: home, 保温: () => ({ 存在: false }) });
		hosts.push(host);
		await host.spawn({ 部门: "前端", 项目根: projectRoot, 命令: process.execPath, 参数: [script, "2", "1"] });
		await waitUntil(() => (host.hotSession("前端", projectRoot)?.累计.轮次 ?? 0) >= 2);

		const lines = readFileSync(ministerLedgerPath(projectRoot), "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(2); // 口径注释＋仅第 1 轮有 usage 的一行
		expect(lines[1].split("\t")[2]).toBe("第1轮");
		// 句柄缺账轮如实登记,盘点/快照可见
		const handle = host.hotSession("前端", projectRoot);
		expect(handle?.累计.轮次).toBe(2);
	});

	it("buildMinisterLedgerLine 纯函数:目标位 Tab/换行压空格,轮次非负取整", () => {
		const line = buildMinisterLedgerLine({
			部门: "前\t端",
			项目根: "x",
			轮次: 3.7,
			该轮成本: 0.0123456789,
			会话秒: 12.6,
		});
		const cells = line.split("\t");
		expect(cells).toHaveLength(6);
		expect(cells[1]).toBe("部门:前 端｜项目:x"); // Tab 压成空格
		expect(cells[2]).toBe("第3轮");
		expect(cells[4]).toBe("0.012346");
		expect(cells[5]).toBe("0");
	});
});
