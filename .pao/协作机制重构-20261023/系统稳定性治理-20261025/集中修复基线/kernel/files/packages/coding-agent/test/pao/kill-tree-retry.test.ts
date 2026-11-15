import { beforeEach, describe, expect, it, vi } from "vitest";

import { killTree } from "../../src/utils/kill-tree.ts";

/**
 * killTree Windows 树杀重试钉住测试（S1-2 包1）：
 * - PS 严格树杀单次失败（高负载超时/瞬时拒绝访问）重试一次，两次才报错；
 * - 杀序最深层优先，中途死后活残余仍可从根/活父走达，重试可续杀（漏孙进程兜底）；
 * - 首跳失败时已尝试成员随 stdout 报回（pid＋首跳快照创建时刻成对），二跳按身份双配对作附加 BFS 根
 *   续杀（空选≠树已灭，V2；配对防跨跳 pid 复用误杀＋收尾检查前预写清单，V3）；
 * - 首次成功不重试；杀阶段总预算封顶（首跳 60s＋二跳 30s，重试不放大最坏时延，V2）。
 * execFile 以 mock 注入确定性触发失败；真实 PS 链路由 worker-stoptree/windows-shell-stop 等覆盖。
 */

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
	execFile: (...args: unknown[]) => execFileMock(...args),
}));

type ExecCallback = (error: Error | null, stdout?: string) => void;

function failOnce(): ReturnType<typeof vi.fn> {
	return execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
		cb(new Error("模拟：PS 脚本超时"));
	});
}

function succeedOnce(): ReturnType<typeof vi.fn> {
	return execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
		cb(null);
	});
}

describe("killTree Windows 树杀：单次失败重试一次，两次才报错", () => {
	beforeEach(() => {
		execFileMock.mockReset();
	});

	it.skipIf(process.platform !== "win32")("首次失败重试成功：PS 调用两次、正常返回停止方式", async () => {
		failOnce();
		succeedOnce();
		await expect(killTree(4242)).resolves.toContain("taskkill");
		expect(execFileMock).toHaveBeenCalledTimes(2);
	});

	it.skipIf(process.platform !== "win32")("两次都失败才报错（真超时仍报错不吞），且不再第三次调用", async () => {
		failOnce();
		failOnce();
		await expect(killTree(4242)).rejects.toThrow("PS 脚本超时");
		expect(execFileMock).toHaveBeenCalledTimes(2);
	});

	it.skipIf(process.platform !== "win32")("首次成功只调一次：不重试，首跳预算 60000ms", async () => {
		// 钉住 A5（成功路径恰 1 次调用）与首跳 60000 预算值（A2 封顶契约的起点，防静默回退 15s）
		succeedOnce();
		await expect(killTree(4242)).resolves.toContain("taskkill");
		expect(execFileMock).toHaveBeenCalledTimes(1);
		const opts = execFileMock.mock.calls[0]?.[2] as { timeout?: number };
		expect(opts.timeout).toBe(60000);
	});

	it.skipIf(process.platform !== "win32")(
		"杀阶段总预算封顶：两次尝试超时之和不超 90 秒（重试不放大最坏时延）",
		async () => {
			failOnce();
			failOnce();
			await expect(killTree(4242)).rejects.toThrow("PS 脚本超时");
			const timeouts = execFileMock.mock.calls.map((call) => (call[2] as { timeout?: number }).timeout ?? 0);
			expect(timeouts).toHaveLength(2);
			expect(timeouts.reduce((sum, t) => sum + t, 0)).toBeLessThanOrEqual(90000);
		},
	);

	it.skipIf(process.platform !== "win32")(
		"死中游＋活深层：二跳把首跳存活成员（pid＋创建时刻成对）列为附加根续杀（空选不假报树已灭）",
		async () => {
			// 首跳：深层成员 taskkill 静默失败，杀循环推进杀到根，存活检查抛错并随 stdout 报存活成员；
			// 二跳：根/中游已死，Win32_Process 只列活进程，BFS 穿不过死中游——
			// 只有把存活 pid 本身作为附加根才能到达深层孤儿；修前二跳空选 exit 0＝假绿（A1）。
			execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
				cb(new Error("Command failed: Tree member still alive: 4244"), "4244:1339778498123\n");
			});
			execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
				cb(null, "");
			});
			await expect(killTree(4242)).resolves.toContain("taskkill");
			const retryScript = String((execFileMock.mock.calls[1]?.[1] as string[])?.[3] ?? "");
			expect(retryScript).toMatch(/\b4244\b/);
			expect(retryScript).toContain("@(4244,1339778498123)");
		},
	);

	it.skipIf(process.platform !== "win32")(
		"首跳存活 pid 被复用时二跳按创建时刻双配对丢弃该种子（不杀复用者并记录）",
		async () => {
			// 首跳报回 4244（创建时刻 1339778498123）；二跳快照里同 pid 若已是别的进程（创建时刻不同），
			// 该种子必须丢弃并记录——修前按裸 pid 无条件纳入 BFS 根，会误杀复用者及其子树（N2/B2）。
			// 种子身份成对下发＋丢弃记录由脚本文本钉住；真实 PS 行为由 V3 探针实证（配对一致杀/不匹配弃）。
			execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
				cb(new Error("Command failed: Tree member still alive: 4244"), "4244:1339778498123\n");
			});
			execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
				cb(null, "");
			});
			await expect(killTree(4242)).resolves.toContain("taskkill");
			const retryScript = String((execFileMock.mock.calls[1]?.[1] as string[])?.[3] ?? "");
			expect(retryScript).toContain("@(4244,1339778498123)");
			expect(retryScript).toContain("PID reused");
		},
	);

	it.skipIf(process.platform !== "win32")(
		"收尾检查前被超时杀：已尝试成员清单先于收尾写出，二跳仍拿到续杀种子",
		async () => {
			// B1 窗口：首跳杀到根后、收尾检查完成前 PS 被 60s 超时杀——若存活名单只在收尾检查里写，
			// 此窗口 stdout 为空、二跳无附加根，深层静默失败残余成假绿。
			// 修法：收尾检查之前先把整份已尝试成员（pid:创建时刻）写出——超时被杀时它已进 stdout，
			// 二跳拿到的是首跳快照真身（配对防复用），种子集合⊇存活集合，续杀面只增不减。
			execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
				cb(new Error("模拟：PS 脚本超时"), "4244:1339778498123,4245:1339778498124\n");
			});
			execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
				cb(null, "");
			});
			await expect(killTree(4242)).resolves.toContain("taskkill");
			const firstScript = String((execFileMock.mock.calls[0]?.[1] as string[])?.[3] ?? "");
			const emitIdx = firstScript.indexOf("'{0}:{1}' -f $_.ProcessId");
			const finalCheckIdx = firstScript.indexOf("$remaining=@(Get-CimInstance Win32_Process)");
			expect(emitIdx).toBeGreaterThanOrEqual(0);
			expect(emitIdx).toBeLessThan(finalCheckIdx);
			const retryScript = String((execFileMock.mock.calls[1]?.[1] as string[])?.[3] ?? "");
			expect(retryScript).toContain("@(4244,1339778498123)");
			expect(retryScript).toContain("@(4245,1339778498124)");
		},
	);
});
