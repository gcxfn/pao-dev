/**
 * worker 流式落盘 + 登记表活性时间戳 + 终路径回执对照(B 档「派卡非阻塞+静默提醒」的地基):
 * - stdout/stderr 逐 chunk 追加 live 文件:进程半路被杀/崩溃 live 里已有钱(中途时刻可读);
 * - 正本证据结算时照旧落盘(flag wx),live 保留不删,结算后含后段行与证据尾行;
 * - 登记表 最近输出时间 随输出到达刷新(B 档静默检测信号源);
 * - 超时/取消/spawn 失败终路径的回执形状钉死(回执化审计对照表)。
 * 造假进程用真小进程(node -e 脚本文件),模式同 worker-run.test.ts;一律 tmpdir,不碰运行目录。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateReceipt } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";

const tempDirs: string[] = [];
const scripts: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	scripts.length = 0;
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-worker-stream-"));
	tempDirs.push(dir);
	return dir;
}

/** 往临时目录写假 worker 脚本(不依赖模型端点) */
function writeScript(body: string): string {
	const file = join(tempDir(), `fake-${scripts.length}.js`);
	scripts.push(file);
	writeFileSync(file, body, "utf8");
	return file;
}

const ASSISTANT_LINE = (text: string): string =>
	JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
			stopReason: "end",
		},
	});

/** 轮询等待条件成立(子进程时序不进断言,只进等待) */
async function until(check: () => boolean, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function findLive(evidenceDir: string, suffix: string): string | undefined {
	if (!existsSync(evidenceDir)) return undefined;
	const name = readdirSync(evidenceDir).find((f) => f.endsWith(suffix));
	return name ? join(evidenceDir, name) : undefined;
}

describe("流式落盘(live 边跑边追加)", () => {
	it("中途时刻 live 已有前段行与 stderr,结束后正本完整、live 保留且补齐", async () => {
		const runner = new WorkerRunner();
		const evidenceDir = tempDir();
		const script = writeScript(
			[
				`console.log(${JSON.stringify(ASSISTANT_LINE("前段输出"))});`,
				'console.error("中途错误输出");',
				`setTimeout(() => console.log(${JSON.stringify(ASSISTANT_LINE("后段输出"))}), 600);`,
			].join("\n"),
		);
		const runPromise = runner.run({
			卡号: "3001",
			提示词: "",
			命令: process.execPath,
			参数: [script],
			证据目录: evidenceDir,
			cwd: evidenceDir,
		});

		// 中途时刻:live 文件出现且已含前段行(此刻后段 600ms 定时器还没到,进程未退)
		let livePath = "";
		let midLive = "";
		await until(() => {
			const live = findLive(evidenceDir, ".live.jsonl");
			if (!live) return false;
			livePath = live;
			midLive = readFileSync(live, "utf8");
			return midLive.includes("前段输出");
		});
		expect(midLive).toContain("pao_worker_live"); // 首行 header 标明归属
		// stderr live 同样中途已落(独立文件,不混写破坏 stdout JSONL 可解析性)
		let midStderr = "";
		await until(() => {
			const live = findLive(evidenceDir, ".live.stderr.log");
			if (!live) return false;
			midStderr = readFileSync(live, "utf8");
			return midStderr.includes("中途错误输出");
		});
		expect(midStderr).toContain("中途错误输出");

		const receipt = await runPromise;
		expect(receipt.status).toBe("success");
		// 正本照旧一次性落盘:前段+后段+证据尾行齐全
		const evidence = readFileSync(receipt.evidence_path, "utf8");
		expect(evidence).toContain("前段输出");
		expect(evidence).toContain("后段输出");
		expect(evidence).toContain("pao_worker_evidence");
		// live 保留不删,结算后也含后段与证据尾行(事后仅凭 live 也能对账)
		expect(existsSync(livePath)).toBe(true);
		const finalLive = readFileSync(livePath, "utf8");
		expect(finalLive).toContain("前段输出");
		expect(finalLive).toContain("后段输出");
		expect(finalLive).toContain("pao_worker_evidence");
		expect(receipt.live_evidence_path).toBe(livePath);
		expect(receipt.live_stderr_path).toBeTruthy();
		expect(validateReceipt(receipt).有效).toBe(true);
	});

	it("半路树杀:live 里已有钱,取消回执形状完整(取消路径对照)", async () => {
		const runner = new WorkerRunner();
		const evidenceDir = tempDir();
		const script = writeScript(
			[`console.log(${JSON.stringify(ASSISTANT_LINE("被杀前输出"))});`, "setInterval(() => {}, 1000);"].join("\n"),
		);
		const runPromise = runner.run({
			卡号: "3002",
			提示词: "",
			命令: process.execPath,
			参数: [script],
			证据目录: evidenceDir,
			cwd: evidenceDir,
		});
		// 中途时刻:live 已有钱,且 listActive 暴露中途输出路径(B 档读取口)
		let livePath = "";
		await until(() => {
			const live = findLive(evidenceDir, ".live.jsonl");
			if (!live || !readFileSync(live, "utf8").includes("被杀前输出")) return false;
			livePath = live;
			return true;
		});
		expect(runner.listActive().find((entry) => entry.卡号 === "3002")?.中途输出路径).toBe(livePath);

		await runner.cancel("3002");
		const receipt = await runPromise;
		expect(receipt.status).toBe("canceled");
		expect(validateReceipt(receipt).有效).toBe(true);
		// 被杀前的输出在 live 里保住了;正本结算照常落盘
		expect(readFileSync(livePath, "utf8")).toContain("被杀前输出");
		expect(existsSync(receipt.evidence_path)).toBe(true);
		expect(readFileSync(receipt.evidence_path, "utf8")).toContain("pao_worker_evidence");
	});
});

describe("登记表活性时间戳(B 档静默检测信号源)", () => {
	it("输出到达即刷新 最近输出时间:第二拍输出后时间戳严格前进", async () => {
		const runner = new WorkerRunner();
		const evidenceDir = tempDir();
		const script = writeScript(
			[
				`console.log(${JSON.stringify(ASSISTANT_LINE("第一拍"))});`,
				`setTimeout(() => console.log(${JSON.stringify(ASSISTANT_LINE("第二拍"))}), 600);`,
			].join("\n"),
		);
		const runPromise = runner.run({
			卡号: "3003",
			提示词: "",
			命令: process.execPath,
			参数: [script],
			证据目录: evidenceDir,
			cwd: evidenceDir,
		});
		// t1 = 第一拍已到、第二拍未到时刻的时间戳
		let t1 = "";
		await until(() => {
			const entry = runner.registry.list().find((e) => e.card_no === "3003");
			const live = findLive(evidenceDir, ".live.jsonl");
			const content = live ? readFileSync(live, "utf8") : "";
			if (entry?.最近输出时间 && content.includes("第一拍") && !content.includes("第二拍")) {
				t1 = entry.最近输出时间;
				return true;
			}
			return false;
		});
		await runPromise;
		const entry = runner.registry.list().find((e) => e.card_no === "3003");
		expect(entry).toBeDefined();
		expect(entry!.running).toBe(false);
		expect(entry!.最近输出时间).toBeTruthy();
		// 第二拍输出刷新了时间戳;时间戳不早于登记时刻
		expect(entry!.最近输出时间! > t1).toBe(true);
		expect(entry!.最近输出时间! >= entry!.登记时间).toBe(true);
	});
});

describe("终路径回执对照(回执化审计)", () => {
	it("超时路径:状态=失败、stopReason=timeout、证据与 live 齐全、回执有效", async () => {
		const runner = new WorkerRunner();
		const evidenceDir = tempDir();
		const script = writeScript("setInterval(() => {}, 1000);");
		const receipt = await runner.run({
			卡号: "3004",
			提示词: "",
			命令: process.execPath,
			参数: [script],
			证据目录: evidenceDir,
			超时毫秒: 250,
		});
		expect(receipt.status).toBe("failed");
		expect(receipt.stopReason).toBe("timeout");
		expect(existsSync(receipt.evidence_path)).toBe(true);
		expect(existsSync(receipt.live_evidence_path ?? "")).toBe(true);
		expect(validateReceipt(receipt).有效).toBe(true);
	});

	it("spawn 失败路径:状态=未知、exitCode<0、回执仍统一形状", async () => {
		const receipt = await new WorkerRunner().run({
			卡号: "3005",
			提示词: "",
			命令: "pao-无此命令-xyz",
			证据目录: tempDir(),
		});
		expect(receipt.status).toBe("unknown");
		expect(receipt.exitCode).toBeLessThan(0);
		expect(receipt.summary).toContain("[spawn error]");
		expect(validateReceipt(receipt).有效).toBe(true);
	});
});
