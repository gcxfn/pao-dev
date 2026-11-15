import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBashTool, createLocalBashOperations } from "../../src/core/tools/bash.ts";
import { killTree } from "../../src/utils/kill-tree.ts";

/**
 * bash 工具取消语义与树杀失败（stopError）优先级（S6-K5）钉住测试：
 * - 用户取消（signal.aborted）优先归类为取消：即便树杀失败，exec 仍以 "aborted" 拒绝，
 *   不被 killTree 错误文本掩盖（工具层 :393 精确匹配依赖该消息渲染 Command aborted）；
 * - stopError 不吞：取消并存树杀失败时挂 cause＋warn 留痕，树杀失败事实可追溯；
 * - 无取消时树杀失败仍以错误拒绝（真超时/停止失败报错不被吞）；
 * - 取消且树杀成功：纯 "aborted"，无 cause、无 warn。
 * killTree 以 mock 注入（确定性制造 stopError）；真实树杀链路由
 * worker-stoptree / windows-shell-stop / kill-tree-retry 覆盖。
 */

vi.mock("../../src/utils/kill-tree.ts", () => ({ killTree: vi.fn() }));
const killTreeMock = vi.mocked(killTree);

const tempDirs: string[] = [];

afterEach(() => {
	killTreeMock.mockReset();
	// killTree 被 mock 不会真杀子进程，命令均短命自退（≤2s）：重试删覆盖退出窗口；
	// 仍删不掉（shell 未及退）则留给系统临时目录，不让清理噪音污染红绿判定
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		} catch {
			/* 尽力而为 */
		}
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-bash-abort-"));
	tempDirs.push(dir);
	return dir;
}

// 命令写 ready 标记后短命自退（不永久挂住：killTree 被 mock 不会真杀，靠自退清理）
const HANG_COMMAND = "node -e \"process.stdout.write('ready');setTimeout(()=>{},1500)\"";

/** 跑命令直到 shell 子进程就绪（stdout 见 ready，spawn 已有 pid），返回挂起的 exec promise。 */
function startExec(
	dir: string,
	controller: AbortController,
): { promise: Promise<{ exitCode: number | null }>; firstData: Promise<void> } {
	let resolveFirst: () => void;
	const firstData = new Promise<void>((resolve) => {
		resolveFirst = resolve;
	});
	const promise = createLocalBashOperations().exec(HANG_COMMAND, dir, {
		onData: (chunk: Buffer) => {
			if (chunk.toString().includes("ready")) resolveFirst();
		},
		signal: controller.signal,
	});
	return { promise, firstData };
}

/** 工具层就绪探测：命令写 ready 文件后挂住；轮询文件存在即 shell 子进程已跑起来。 */
async function waitForReady(file: string): Promise<void> {
	const deadline = Date.now() + 10000;
	while (!existsSync(file)) {
		if (Date.now() > deadline) throw new Error("bash 工具命令未就绪");
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
}

describe.skipIf(process.platform !== "win32")("bash 工具：取消语义优先于树杀失败（stopError）", () => {
	it("取消＋树杀失败：exec 以 aborted 拒绝（不抛 killTree 错误文本），stopError 挂 cause＋warn 留痕", async () => {
		const stopError = new Error("模拟：PowerShell 树杀超时失败");
		killTreeMock.mockRejectedValue(stopError);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const controller = new AbortController();
		const { promise, firstData } = startExec(tempDir(), controller);
		try {
			await firstData;
			controller.abort();
			const captured = await promise.then(
				() => null,
				(error: unknown) => error as Error,
			);
			// 取消归类优先：消息恒为 "aborted"（工具层按此精确匹配渲染 Command aborted）
			expect(captured).toBeInstanceOf(Error);
			expect((captured as Error).message).toBe("aborted");
			// stopError 不吞：挂 cause 可追溯
			expect((captured as Error).cause).toBe(stopError);
			// 树杀失败留痕日志
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			controller.abort();
			warnSpy.mockRestore();
			await promise.catch(() => {});
		}
	});

	it("取消＋树杀失败：bash 工具层渲染 Command aborted（取消不被当普通命令错误）", async () => {
		killTreeMock.mockRejectedValue(new Error("模拟：PowerShell 树杀超时失败"));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const controller = new AbortController();
		const dir = tempDir();
		const readyFile = join(dir, "ready.txt");
		const command = `node -e "require('fs').writeFileSync(process.argv[1],'1'),setTimeout(()=>{},2000)" '${readyFile.replaceAll("\\", "/")}'`;
		const bashTool = createBashTool(dir);
		const op = bashTool.execute("test-call", { command }, controller.signal);
		try {
			await waitForReady(readyFile);
			controller.abort();
			await expect(op).rejects.toThrow("Command aborted");
		} finally {
			controller.abort();
			warnSpy.mockRestore();
			await op.catch(() => {});
		}
	});

	it("无取消（超时触发树杀）＋树杀失败：仍以树杀失败错误拒绝（报错不被吞）", async () => {
		killTreeMock.mockRejectedValue(new Error("模拟：PowerShell 树杀超时失败"));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const dir = tempDir();
		const op = createLocalBashOperations().exec(HANG_COMMAND, dir, {
			onData: () => {},
			timeout: 0.3,
		});
		try {
			await expect(op).rejects.toThrow("PowerShell 树杀超时失败");
		} finally {
			warnSpy.mockRestore();
			await op.catch(() => {});
		}
	});

	it("取消＋树杀成功：纯 aborted 拒绝，无 cause、无 warn", async () => {
		killTreeMock.mockResolvedValue("taskkill /PID 4242 /T /F");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const controller = new AbortController();
		const { promise, firstData } = startExec(tempDir(), controller);
		try {
			await firstData;
			controller.abort();
			const captured = await promise.then(
				() => null,
				(error: unknown) => error as Error,
			);
			expect(captured).toBeInstanceOf(Error);
			expect((captured as Error).message).toBe("aborted");
			expect((captured as Error).cause).toBeUndefined();
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			controller.abort();
			warnSpy.mockRestore();
			await promise.catch(() => {});
		}
	});
});
