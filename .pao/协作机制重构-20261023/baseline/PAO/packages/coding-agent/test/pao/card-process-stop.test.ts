import { type ChildProcess, type ExecFileOptions, execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCard, loadCard } from "../../src/pao/cards/cardfile.ts";
import { CardProcessStopUnconfirmedError, runCardProcess } from "../../src/pao/cards/process.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import { refreshShadowSandbox, verifyCard } from "../../src/pao/cards/verifier.ts";
import { killTree } from "../../src/utils/kill-tree.ts";
import { withTestCleanup } from "../with-test-cleanup.ts";

/**
 * 停止链健壮性（S1-2 包1）钉住测试：
 * - 取消语义优先：AbortError 不被树杀失败错误（stopError）掩盖（process.ts 判定顺序）；
 * - 真超时/树杀失败仍报错不被吞（runCardProcess 以 stopError 拒绝）；
 * - verifier 跑命令条目遇停止链失败降级为「无法判」条目而非炸穿 verifyCard；
 * - 取消传播端到端：即便树杀失败，verifyCard 仍以 AbortError 拒绝。
 * killTree 以 mock 注入（确定性触发同一拒绝代码路径）；kill.ts 自身行为另见 kill-tree-retry.test.ts。
 */

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: vi.fn(actual.execFile) };
});
vi.mock("../../src/utils/kill-tree.ts", () => ({ killTree: vi.fn() }));
const execFileMock = vi.mocked(execFile);
const killTreeMock = vi.mocked(killTree);

type TestExecFileCallback = NonNullable<Parameters<typeof execFile>[3]>;

const tempDirs: string[] = [];

afterEach(async () => {
	execFileMock.mockClear();
	killTreeMock.mockReset();
	for (const dir of tempDirs.splice(0)) {
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				rmSync(dir, { recursive: true, force: true });
				break;
			} catch (error) {
				if (attempt === 19 || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
				await delay(50 * (attempt + 1));
			}
		}
	}
});

function tempDir(prefix = "pao-card-stop-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function hangArgs(): string[] {
	return ["-e", "setInterval(()=>{},1000)"];
}

function fakeChild(pid: number): ChildProcess {
	return {
		pid,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
	} as unknown as ChildProcess;
}

function makeRepo(): string {
	const repo = tempDir();
	writeFileSync(join(repo, "源.txt"), "PAO 停止链测试项目\n");
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "init"], { cwd: repo, stdio: "ignore" });
	return repo;
}

async function makeClaimedCard(repo: string, acceptance: string): Promise<string> {
	const cardDir = join(repo, ".pao", "卡");
	mkdirSync(cardDir, { recursive: true });
	const card = await createCard(cardDir, {
		目标: "停止链钉住卡",
		部门: "核心机制",
		验收: acceptance,
		创建: "2026-10-07 05:00",
	});
	changeCardStatus(card, { 操作者: "部长A", to: "in_progress", 时间: "2026-10-07 05:01" });
	return cardDir;
}

describe("runCardProcess：取消语义与树杀失败的优先级", () => {
	it("取消时 AbortError 优先于树杀失败（stopError 不掩盖取消语义，挂 cause＋留日志不丢）", async () => {
		const stopError = new Error("模拟：PowerShell 树杀超时失败");
		killTreeMock.mockRejectedValue(stopError);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const controller = new AbortController();
		const op = runCardProcess(process.execPath, hangArgs(), tempDir(), 60000, undefined, controller.signal);
		try {
			await delay(200);
			controller.abort();
			const captured = await op.then(
				() => null,
				(error: unknown) => error as Error,
			);
			expect(captured).toMatchObject({ name: "AbortError" });
			expect(captured).toBeInstanceOf(CardProcessStopUnconfirmedError);
			expect(captured?.cause).toBe(stopError);
			expect((captured as CardProcessStopUnconfirmedError).abortReason).toBe(controller.signal.reason);
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			controller.abort();
			warnSpy.mockRestore();
			await op.catch(() => {});
		}
	});

	it.each(["用户取消", Object.freeze({ why: "取消" })])(
		"取消原因是原始值或冻结对象时仍报告停止未确认：%s",
		async (reason) => {
			killTreeMock.mockRejectedValue(new Error("模拟停止失败"));
			const controller = new AbortController();
			const op = runCardProcess(process.execPath, hangArgs(), tempDir(), 60000, undefined, controller.signal);
			await delay(100);
			controller.abort(reason);
			await expect(op).rejects.toBeInstanceOf(CardProcessStopUnconfirmedError);
			await expect(op).rejects.toMatchObject({ name: "AbortError" });
			await expect(op).rejects.toHaveProperty("abortReason", reason);
		},
	);

	it("无取消时树杀失败仍以错误拒绝（真超时报错不被吞）", async () => {
		killTreeMock.mockRejectedValue(new Error("模拟：PowerShell 树杀超时失败"));
		const op = runCardProcess(process.execPath, hangArgs(), tempDir(), 100);
		await expect(op).rejects.toBeInstanceOf(CardProcessStopUnconfirmedError);
		await expect(op).rejects.toThrow("PowerShell 树杀超时失败");
		await op.catch(() => {});
	});

	it("输出超过 16 MiB 后即使直接父进程先退出，也进入树级停止并报告停止未确认", async () => {
		const root = tempDir("pao-card-overflow-tree-");
		const pidFile = join(root, "overflow-pids.json");
		const childScript = join(root, "overflow-parent.cjs");
		const stopError = new Error("模拟：超限后整树停止未确认");
		killTreeMock.mockRejectedValue(stopError);
		writeFileSync(
			childScript,
			[
				"const {spawn}=require('node:child_process');",
				"const {writeFileSync}=require('node:fs');",
				`const pidFile=${JSON.stringify(pidFile)};`,
				"const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});",
				"writeFileSync(pidFile,JSON.stringify({parent:process.pid,child:child.pid}));",
				"process.stdout.write('x'.repeat(17*1024*1024));",
				"setTimeout(()=>{},30000);",
			].join("\n"),
		);
		const operation = runCardProcess(process.execPath, [childScript], root, 30000);
		await withTestCleanup(
			async () => {
				const pids = await new Promise<{ parent: number; child: number }>((resolve, reject) => {
					const deadline = Date.now() + 10000;
					const interval = setInterval(() => {
						if (existsSync(pidFile)) {
							clearInterval(interval);
							resolve(JSON.parse(readFileSync(pidFile, "utf8")) as { parent: number; child: number });
						} else if (Date.now() > deadline) {
							clearInterval(interval);
							reject(new Error("输出超限父子进程未就绪"));
						}
					}, 10);
				});
				await expect(operation).rejects.toBeInstanceOf(CardProcessStopUnconfirmedError);
				await expect(operation).rejects.toMatchObject({
					cause: stopError,
					message: expect.stringContaining("日志不完整"),
				});
				expect(() => process.kill(pids.parent, 0)).toThrow();
				expect(() => process.kill(pids.child, 0)).not.toThrow();
				for (const pid of [pids.child, pids.parent]) {
					try {
						process.kill(pid);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
					}
				}
			},
			async () => {
				await operation.catch(() => {});
				if (existsSync(pidFile)) {
					const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { parent: number; child: number };
					for (const pid of [pids.child, pids.parent]) {
						try {
							process.kill(pid);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
						}
					}
				}
			},
		);
	}, 40000);

	it("原生 maxBuffer 先于主动采集触发时，父进程已死也拒绝而不是普通 code=1", async () => {
		const maxBufferError = Object.assign(new Error("原生 maxBuffer 先触发"), {
			code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
		});
		execFileMock.mockImplementationOnce(
			(
				_cmd: string,
				_args: readonly string[] | undefined | null,
				_options: ExecFileOptions | undefined | null,
				callback: TestExecFileCallback | undefined | null,
			) => {
				const child = fakeChild(43001);
				queueMicrotask(() => callback?.(maxBufferError, Buffer.alloc(0), Buffer.alloc(0)));
				return child;
			},
		);

		const operation = runCardProcess("fake-native-overflow", [], process.cwd(), 60000);
		await expect(operation).rejects.toMatchObject({
			name: "CardProcessStopUnconfirmedError",
			message: expect.stringContaining("原生命令输出上限先触发"),
			cause: maxBufferError,
		});
		expect(killTreeMock).not.toHaveBeenCalled();
	});

	it("主动达到采集上限后命令正常退出，即使树杀返回成功也不得伪装 code=0", async () => {
		killTreeMock.mockResolvedValue("taskkill /PID 43002 /T /F");
		execFileMock.mockImplementationOnce(
			(
				_cmd: string,
				_args: readonly string[] | undefined | null,
				_options: ExecFileOptions | undefined | null,
				callback: TestExecFileCallback | undefined | null,
			) => {
				const child = fakeChild(43002);
				const stdout = child.stdout as PassThrough;
				queueMicrotask(() => {
					stdout.write(Buffer.alloc(16 * 1024 * 1024));
					setTimeout(() => callback?.(null, Buffer.alloc(0), Buffer.alloc(0)), 0);
				});
				return child;
			},
		);

		const operation = runCardProcess("fake-output-limit", [], process.cwd(), 60000);
		await expect(operation).rejects.toMatchObject({
			name: "CardProcessStopUnconfirmedError",
			message: expect.stringContaining("命令自行退出"),
		});
		expect(killTreeMock).toHaveBeenCalledWith(43002, 0, expect.any(Number));
	});
});

describe("verifyCard：跑命令条目遇停止链失败的降级", () => {
	it("树杀失败降级为「无法判」条目而非炸穿 verifyCard；沙箱按卡保留", async () => {
		killTreeMock.mockRejectedValue(new Error("模拟：PowerShell 树杀超时失败"));
		const repo = makeRepo();
		const cardDir = await makeClaimedCard(repo, '跑: node -e "setInterval(function(){},1000)"');
		const root = tempDir("pao-card-stop-sbx-");
		const { result } = await verifyCard(cardDir, 1, {
			operator: "部长A",
			sandbox_root: root,
			命令超时毫秒: 150,
		});

		expect(result.结论).toBe("无法机械判");
		expect(result.条目结果[0]?.结果).toBe("无法判");
		expect(result.条目结果[0]?.说明).toContain("PowerShell 树杀超时失败");
		expect(result.自动交付).toBeUndefined();
		expect(result.沙箱保留路径).toBeTruthy();
		expect(loadCard(cardDir, 1).frontmatter.status).toBe("in_progress");
	}, 20000);

	it("降级说明保留错误尾部：长报文里真实原因（在 1000+ 字符之后）不被截断丢掉", async () => {
		// execFile 报文结构：Command failed: <powershell 全路径＋整段脚本回显>…<真实原因在尾部>
		const real = "Tree member still alive: 4242";
		killTreeMock.mockRejectedValue(
			new Error(`Command failed: powershell.exe -NoProfile -Command <脚本回显>${"x".repeat(900)}…${real}`),
		);
		const repo = makeRepo();
		const cardDir = await makeClaimedCard(repo, '跑: node -e "setInterval(function(){},1000)"');
		const root = tempDir("pao-card-stop-tail-");
		const { result } = await verifyCard(cardDir, 1, {
			operator: "部长A",
			sandbox_root: root,
			命令超时毫秒: 150,
		});

		expect(result.条目结果[0]?.结果).toBe("无法判");
		expect(result.条目结果[0]?.说明).toContain(real);
	}, 20000);

	it("即便树杀失败，取消仍以 AbortError 向上传播（端到端取消语义）", async () => {
		killTreeMock.mockRejectedValue(new Error("模拟：PowerShell 树杀超时失败"));
		const repo = makeRepo();
		const cardDir = await makeClaimedCard(
			repo,
			"跑: node -e \"require('fs').writeFileSync('ready','yes'),setInterval(function(){},1000)\"",
		);
		const root = tempDir("pao-card-stop-sbx-");
		// 先把沙箱拷好，命令跑起来（ready 落地）再中止，确保走「真停树失败＋取消」路径
		const { workDir } = await refreshShadowSandbox(repo, { sandbox_root: root });
		const controller = new AbortController();
		const op = verifyCard(cardDir, 1, {
			operator: "部长A",
			sandbox_root: root,
			命令超时毫秒: 60000,
			signal: controller.signal,
		});
		try {
			const deadline = Date.now() + 10000;
			while (!existsSync(join(workDir, "ready"))) {
				if (Date.now() > deadline) throw new Error("沙箱命令未就绪");
				await delay(20);
			}
			controller.abort();
			await expect(op).rejects.toMatchObject({ name: "AbortError" });
		} finally {
			controller.abort();
			await op.catch(() => {});
		}
	}, 20000);
});
