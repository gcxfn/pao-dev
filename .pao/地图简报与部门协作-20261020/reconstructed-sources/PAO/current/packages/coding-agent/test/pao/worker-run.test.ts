import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWorkerEvidenceFile } from "../../src/pao/shared/evidence.ts";
import { PaoWorkerError } from "../../src/pao/worker/errors.ts";
import { validateReceipt } from "../../src/pao/worker/receipt.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";
import { killTree } from "../../src/utils/kill-tree.ts";

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	return { ...original, openSync: vi.fn(original.openSync) };
});

const tempDirs: string[] = [];
const scripts: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	scripts.length = 0;
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-worker-run-"));
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

const SUCCESS_SCRIPT = `
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "第一行摘要\\n第二行摘要\\n第三行摘要\\n第四行不该出现" }], usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, cost: { total: 0.5 }, totalTokens: 155 }, stopReason: "end", model: "glm-4.7" } }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "最终输出" }], usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1 }, stopReason: "end" } }));
`;

const FAIL_SCRIPT = `
console.error("boom:测试用假失败");
process.exit(3);
`;

const ARGV_SCRIPT = `
require("node:fs").writeFileSync(process.env.PAO_ARGV_OUT, JSON.stringify(process.argv));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, stopReason: "end" } }));
`;

describe("worker 拉起与回执收集(假进程,不依赖模型端点)", () => {
	it("有卡路径时证据默认落在任务工作区 worker-evidence,不写系统临时目录", async () => {
		const project = tempDir();
		const workspace = join(project, ".pao", "任务-20261020");
		const cardPath = join(workspace, "卡", "卡0001-取证.md");
		mkdirSync(join(workspace, "卡"), { recursive: true });
		writeFileSync(cardPath, "---\ngoal: 取证\nstatus: in_progress\n---\n", "utf8");
		const receipt = await new WorkerRunner().run({
			卡号: "0001",
			卡路径: cardPath,
			提示词: "",
			命令: process.execPath,
			参数: [writeScript(SUCCESS_SCRIPT)],
		});
		const expectedDir = join(workspace, "worker-evidence");
		expect(receipt.evidence_path.startsWith(expectedDir)).toBe(true);
		expect(existsSync(receipt.evidence_path)).toBe(true);
	});

	it("无卡裸 run 默认使用实际执行 cwd 的 .pao/worker-evidence,不写系统临时目录", async () => {
		const dir = tempDir();
		const receipt = await new WorkerRunner().run({
			卡号: "0099",
			提示词: "",
			命令: process.execPath,
			参数: [writeScript(SUCCESS_SCRIPT)],
			cwd: dir,
		});
		const expectedDir = join(dir, ".pao", "worker-evidence");
		expect(receipt.evidence_path.startsWith(expectedDir)).toBe(true);
		expect(existsSync(receipt.evidence_path)).toBe(true);
	});

	it("显式证据目录仍优先于卡路径与 cwd 默认目录", async () => {
		const project = tempDir();
		const cardPath = join(project, ".pao", "任务-20261020", "卡", "卡0002-显式.md");
		mkdirSync(join(project, ".pao", "任务-20261020", "卡"), { recursive: true });
		writeFileSync(cardPath, "---\ngoal: 显式证据\nstatus: in_progress\n---\n", "utf8");
		const explicit = tempDir();
		const receipt = await new WorkerRunner().run({
			卡号: "0002",
			卡路径: cardPath,
			提示词: "",
			命令: process.execPath,
			参数: [writeScript(SUCCESS_SCRIPT)],
			cwd: project,
			证据目录: explicit,
		});
		expect(receipt.evidence_path.startsWith(explicit)).toBe(true);
		expect(existsSync(receipt.evidence_path)).toBe(true);
	});

	it("大输出流式证据完整、末行不重复；磁盘流失败的有限尾部不冒充成功", async () => {
		const dir = tempDir();
		const script = writeScript(
			`for(let i=0;i<1000;i++)console.log(JSON.stringify({type:'measurement',i,data:'x'.repeat(1000)}));process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'完成'}],usage:{input:1,output:1,cost:0},stopReason:'end'}}));`,
		);
		const run = () =>
			new WorkerRunner().run({
				卡号: "0031",
				提示词: "",
				命令: process.execPath,
				参数: [script],
				cwd: dir,
				证据目录: dir,
			});
		const receipt = await run();
		expect(receipt.status).toBe("success");
		const lines = (await readWorkerEvidenceFile(receipt.evidence_path))
			.toString("utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines.filter((line) => line.type === "measurement")).toHaveLength(1000);
		expect(lines.filter((line) => line.type === "message_end")).toHaveLength(1);
		expect(lines.at(-1).type).toBe("pao_worker_evidence");
		const open = fs.openSync;
		const broken = vi.spyOn(fs, "openSync").mockImplementation((file, ...args) => {
			if (String(file).includes(".live.")) throw new Error("模拟流式盘满");
			return open(file, ...args);
		});
		try {
			const fallback = await run();
			expect(fallback.status).toBe("failed");
			expect(fallback.failure_type).toBe("unknown_outcome");
			expect(fallback.summary).toContain("完整过程证据缺失");
			expect(readFileSync(fallback.evidence_path, "utf8").length).toBeLessThan(300000);
		} finally {
			broken.mockRestore();
		}
	});
	it("正式回执必须是 JSON 且产物存在；退出码 0 不替代完成证据", async () => {
		const cwd = tempDir();
		writeFileSync(join(cwd, "产物.txt"), "真实本地测试产物");
		const outputs = [
			"普通说明",
			JSON.stringify({ result: "success", artifact_path: ["不存在.txt"], summary: "虚报文件" }),
			JSON.stringify({ result: "failed", artifact_path: [], summary: "缺文件", failure_type: "missing_input" }),
			JSON.stringify({ result: "success", artifact_path: ["产物.txt"], summary: "有效回执" }),
		];
		for (const [index, output] of outputs.entries()) {
			const script = writeScript(
				`console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:${JSON.stringify(output)}}],usage:{input:1,output:1,cost:0},stopReason:"end"}}));`,
			);
			const result = await new WorkerRunner().run({
				卡号: String(index + 1),
				提示词: "",
				命令: process.execPath,
				参数: [script],
				cwd,
				证据目录: cwd,
				要求回执: true,
			});
			expect(result.status).toBe(index === 3 ? "success" : "failed");
			if (index < 2) expect(result.summary).toContain("无有效回执");
			if (index === 2) expect(result.failure_type).toBe("missing_input");
			if (index === 3) expect(result.artifact_path).toEqual(["产物.txt"]);
		}
	});
	it("最后一轮费用恰好触顶但已给有效回执时保留成功", async () => {
		const cwd = tempDir();
		const script = writeScript(
			'console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:JSON.stringify({result:"success",artifact_path:[],summary:"做完了"})}],usage:{input:1,output:1,cost:1},stopReason:"end"}}));setTimeout(()=>{},50);',
		);
		const result = await new WorkerRunner().run({
			卡号: "0001",
			提示词: "",
			命令: process.execPath,
			参数: [script],
			cwd,
			证据目录: cwd,
			要求回执: true,
			预算: { cost: 1 },
		});
		expect(result.status).toBe("success");
		expect(result.usage.cost).toBe(1);
	});
	it("拉起子进程:usage 逐项聚合、stopReason、exitCode、摘要、证据落盘齐全且回执有效", async () => {
		const runner = new WorkerRunner();
		const evidenceDir = tempDir();
		const receipt = await runner.run({
			卡号: "0001",
			提示词: "测试任务",
			命令: process.execPath,
			参数: [writeScript(SUCCESS_SCRIPT)],
			证据目录: evidenceDir,
			cwd: evidenceDir,
		});

		expect(receipt.card_no).toBe("0001");
		expect(receipt.attempt).toBe(1);
		expect(receipt.status).toBe("success");
		// 用量从事件流逐项分开取,不采信模型自报
		expect(receipt.usage).toEqual({ input: 110, output: 22, cacheRead: 30, cacheWrite: 5, cost: 0.6, turns: 2 });
		expect(receipt.stopReason).toBe("end");
		expect(receipt.exitCode).toBe(0);
		expect(receipt.summary.split("\n").length).toBeLessThanOrEqual(3);
		// 摘要取最后一条助手文本(最终输出),不是中间过程
		expect(receipt.summary).toBe("最终输出");
		// 证据:原始事件流 JSONL + 尾部证据行
		expect(receipt.evidence_path).toBeTruthy();
		expect(existsSync(receipt.evidence_path)).toBe(true);
		const evidence = readFileSync(receipt.evidence_path, "utf8");
		expect(evidence).toContain("message_end");
		expect(evidence).toContain("pao_worker_evidence");
		// 结构校验自洽
		expect(validateReceipt(receipt).有效).toBe(true);
	});

	it("子进程失败:exitCode/stderr 进回执,状态=失败", async () => {
		const runner = new WorkerRunner();
		const receipt = await runner.run({
			卡号: "0002",
			提示词: "任务",
			命令: process.execPath,
			参数: [writeScript(FAIL_SCRIPT)],
			证据目录: tempDir(),
		});
		expect(receipt.status).toBe("failed");
		expect(receipt.exitCode).toBe(3);
		expect(receipt.stderrTail).toContain("boom");
	});

	it("工具白名单与提示词确实传到子进程命令行", async () => {
		const runner = new WorkerRunner();
		const dir = tempDir();
		const argvFile = join(dir, "argv.json");
		const receipt = await runner.run({
			卡号: "0003",
			提示词: "侦察任务提示词",
			命令: process.execPath,
			参数: [writeScript(ARGV_SCRIPT)],
			工具白名单: ["read", "bash"],
			环境变量: { PAO_ARGV_OUT: argvFile },
			证据目录: dir,
		});
		expect(receipt.status).toBe("success");
		const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
		const toolsIndex = argv.indexOf("--tools");
		expect(toolsIndex).toBeGreaterThan(-1);
		expect(argv[toolsIndex + 1]).toBe("read,bash");
		expect(argv[argv.length - 1]).toBe("侦察任务提示词");
	});

	it("进程登记表:登记本轮拉起的全部进程(pid、命令、卡号),跑完标运行中=false", async () => {
		const runner = new WorkerRunner();
		await runner.run({
			卡号: "0004",
			提示词: "任务",
			命令: process.execPath,
			参数: [writeScript(SUCCESS_SCRIPT)],
			证据目录: tempDir(),
		});
		const entries = runner.registry.list();
		expect(entries.length).toBe(1);
		expect(entries[0].pid).toBeGreaterThan(0);
		expect(entries[0].card_no).toBe("0004");
		expect(entries[0].command).toContain("fake-");
		expect(entries[0].running).toBe(false);
	});
});

describe("尝试计数统一(同一调度轮次)", () => {
	it("同一卡逐次 +1,计数器可读;不同卡各自独立", async () => {
		const runner = new WorkerRunner();
		const opts = { 命令: process.execPath, 参数: [writeScript(SUCCESS_SCRIPT)], 证据目录: tempDir() };
		const r1 = await runner.run({ ...opts, 卡号: "0007", 提示词: "第一次" });
		const r2 = await runner.run({ ...opts, 卡号: "0007", 提示词: "第二次" });
		const r3 = await runner.run({ ...opts, 卡号: "0008", 提示词: "别的卡" });
		expect(r1.attempt).toBe(1);
		expect(r2.attempt).toBe(2);
		expect(r3.attempt).toBe(1);
		expect(runner.attemptCount("0007")).toBe(2);
		expect(runner.attemptTable()).toEqual({ "0007": 2, "0008": 1 });
	});

	it("子进程内部失败不触发独立重试:失败一次就是一次,无重试路径", async () => {
		const runner = new WorkerRunner();
		const dir = tempDir();
		const marker = join(dir, "starts.txt");
		const script = writeScript(
			`require("node:fs").appendFileSync(${JSON.stringify(marker)}, "start\\n");\nprocess.exit(1);`,
		);
		const receipt = await runner.run({
			卡号: "0009",
			提示词: "任务",
			命令: process.execPath,
			参数: [script],
			证据目录: dir,
		});

		expect(receipt.status).toBe("failed");
		expect(receipt.attempt).toBe(1);
		// 子进程只被拉起过一次;计数器也只记一次
		expect(readFileSync(marker, "utf8").split("\n").filter(Boolean).length).toBe(1);
		expect(runner.attemptCount("0009")).toBe(1);
	});
});

describe("PATH 垫片回退(defaultInvocation 回落入口在 Windows 真实可用)", () => {
	it("无当前脚本且无内嵌构建时回落 PATH 垫片:worker 经垫片真实拉起并出回执", async () => {
		const dir = tempDir();
		const worker = join(dir, "fake-worker.js");
		writeFileSync(worker, SUCCESS_SCRIPT, "utf8");
		const shim = join(dir, process.platform === "win32" ? "pao.cmd" : "pao");
		writeFileSync(
			shim,
			process.platform === "win32"
				? `@echo off\r\n"${process.execPath}" "%~dp0fake-worker.js" %*\r\n`
				: `#!/bin/sh\nexec "${process.execPath}" "${worker}" "$@"\n`,
			{ encoding: "utf8", mode: 0o755 },
		);
		const savedArgv1 = process.argv[1];
		const savedPath = process.env.PATH;
		// 内嵌构建优先(T12):用空包目录让内嵌 cli 不存在,才轮到 PATH 垫片回退。
		const savedPkgDir = process.env.PI_PACKAGE_DIR;
		process.env.PI_PACKAGE_DIR = tempDir();
		process.argv[1] = "";
		process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
		try {
			const receipt = await new WorkerRunner().run({ 卡号: "0010", 提示词: "", 证据目录: tempDir() });
			expect(receipt.status, receipt.stderrTail ?? receipt.summary).toBe("success");
			expect(receipt.command.startsWith("pao ")).toBe(true);
		} finally {
			process.argv[1] = savedArgv1;
			if (savedPath === undefined) delete process.env.PATH;
			else process.env.PATH = savedPath;
			if (savedPkgDir === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = savedPkgDir;
		}
	}, 15_000);
});

describe("派发名额口径统一(共享上限取 min(8, 并发上限))", () => {
	it("外部活进程顶满收敛上限时立即拒派不死等,即使并发上限超配(>8)", async () => {
		const runner = new WorkerRunner();
		for (let i = 0; i < 8; i++)
			runner.registry.register({
				pid: 700000 + i,
				card_no: `90${i}`,
				command: "占位",
				dept: "别人",
				dispatch_reason: "占位",
			});
		await expect(
			runner.reserveDispatchSlot({
				身份: join(tempDir(), "卡0016.md"),
				部门: "我的",
				部门上限: 3,
				并发上限: 16,
				等待: true,
			}),
		).rejects.toThrow("共享并发名额已达上限 8");
	});
});

describe("父层预算兜底与子会话同口径(审查第 2 项:到线后那一轮是最终回执轮)", () => {
	it("子会话没能自己收口时,父层主动硬停,不等它自己跑完", async () => {
		const cwd = tempDir();
		// 无预算门禁的假子进程:每 20ms 开一个新轮次,足够跑 10s。父层必须自己叫停。
		// 注意:Windows 树杀要经 PowerShell 枚举进程表,落地需 1 秒上下——期间子进程仍在输出,
		// 因此这里断言「明显早于自然结束」,不断言精确轮数(精确值取决于机器负载)。
		const 理论轮数 = 500;
		const script = writeScript(`
			let i = 0;
			const timer = setInterval(() => {
				if (i >= ${理论轮数}) { clearInterval(timer); return; }
				i++;
				console.log(JSON.stringify({ type: "turn_start" }));
				console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "第" + i + "轮" }], usage: { input: 1, output: 1, cost: 0 }, stopReason: "end" } }));
			}, 20);
		`);
		const 开始 = Date.now();
		const result = await new WorkerRunner().run({
			卡号: "0017",
			提示词: "",
			命令: process.execPath,
			参数: [script],
			cwd,
			证据目录: cwd,
			预算: { turns: 1 },
		});
		const 耗时 = Date.now() - 开始;
		expect(result.status).toBe("failed");
		expect(result.stopReason).toBe("budget:turns");
		expect(result.summary).toContain("预算已耗尽：turns");
		expect(result.usage.turns).toBeGreaterThanOrEqual(2); // 到线后放行的那一轮
		expect(result.usage.turns).toBeLessThan(理论轮数); // 没让它自己跑完
		expect(耗时).toBeLessThan(理论轮数 * 20 - 2000); // 明显早于自然结束(10s)
	});

	it("费用到线后子会话获准的最终回执轮不再被父层杀掉", async () => {
		const cwd = tempDir();
		const script = writeScript(`
			console.log(JSON.stringify({ type: "turn_start" }));
			console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "第一轮已花钱" }], usage: { input: 1, output: 1, cost: 1 }, stopReason: "end" } }));
			console.log(JSON.stringify({ type: "turn_start" }));
			console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ result: "success", artifact_path: [], summary: "预算内收尾" }) }], usage: { input: 1, output: 1, cost: 0 }, stopReason: "end" } }));
		`);
		const result = await new WorkerRunner().run({
			卡号: "0018",
			提示词: "",
			命令: process.execPath,
			参数: [script],
			cwd,
			证据目录: cwd,
			要求回执: true,
			预算: { cost: 1 },
		});
		expect(result.status).toBe("success");
		expect(result.summary).toBe("预算内收尾");
		expect(result.usage.turns).toBe(2);
		expect(result.usage.cost).toBe(1);
	});

	it("回执通道不计入工具次数预算(与子会话 tool_call 门禁同口径)", async () => {
		const cwd = tempDir();
		const script = writeScript(`
			console.log(JSON.stringify({ type: "turn_start" }));
			console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "probe" }));
			console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "用过一次工具" }], usage: { input: 1, output: 1, cost: 0 }, stopReason: "end" } }));
			console.log(JSON.stringify({ type: "turn_start" }));
			console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "t2", toolName: "pao_submit_receipt" }));
			console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ result: "success", artifact_path: [], summary: "回执通道放行" }) }], usage: { input: 1, output: 1, cost: 0 }, stopReason: "end" } }));
		`);
		const result = await new WorkerRunner().run({
			卡号: "0019",
			提示词: "",
			命令: process.execPath,
			参数: [script],
			cwd,
			证据目录: cwd,
			要求回执: true,
			预算: { toolCalls: 1 },
		});
		expect(result.status).toBe("success");
		expect(result.summary).toBe("回执通道放行");
	});
});

describe("停止确认失败 fail-closed(run 不抛,失败回执照落)", () => {
	it("超时触发的树杀失败:run 返回失败回执,证据落盘,摘要指向停止确认失败", async () => {
		const dir = tempDir();
		const script = writeScript("setInterval(() => {}, 1000);");
		let failOnce = true;
		const runner = new WorkerRunner({
			树杀: async (pid) => {
				if (failOnce) {
					failOnce = false;
					throw new PaoWorkerError("停止失败", "离线注入的树杀失败");
				}
				return killTree(pid);
			},
		});
		const receipt = await runner.run({
			卡号: "0011",
			提示词: "",
			命令: process.execPath,
			参数: [script],
			证据目录: dir,
			超时毫秒: 200,
		});
		expect(receipt.status).toBe("failed");
		expect(receipt.stopReason).toBe("timeout");
		expect(receipt.summary).toContain("停止确认失败");
		expect(receipt.summary).toContain("离线注入的树杀失败");
		expect(existsSync(receipt.evidence_path)).toBe(true);
		// 进程未确认真停前登记不除名;二次树杀(stopAll)收敛后运行中=false
		await runner.stopAll();
		expect(runner.registry.list()[0].running).toBe(false);
	});
});
