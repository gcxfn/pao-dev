import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { acquireSessionControl } from "../../src/pao/runtime/session-lock.ts";
import { reserveSharedRequest } from "../../src/pao/runtime/shared-budget.ts";

const dirs: string[] = [];
const releases: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const release of releases.splice(0)) await release();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-runtime-"));
	dirs.push(dir);
	return dir;
}

it("并发预留不超额，失败取消释放名额不退请求数", async () => {
	const config = { path: join(directory(), "budget.json"), requests: 2, concurrency: 1 };
	const first = await reserveSharedRequest(config);
	await expect(reserveSharedRequest(config)).rejects.toThrow("并发名额已满");
	await first();
	await first();
	const second = await reserveSharedRequest(config);
	await second();
	await expect(reserveSharedRequest(config)).rejects.toThrow("额度耗尽");
	expect(JSON.parse(readFileSync(config.path, "utf8"))).toMatchObject({ used: 2, active: [] });
});

it("真实独立进程共享名额，强杀后仅回收名额不退计次", async () => {
	const path = join(directory(), "budget.json");
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", fileURLToPath(new URL("./runtime-budget-child.ts", import.meta.url)), path],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	try {
		const ready = await new Promise<string>((resolve, reject) => {
			child.stdout.once("data", (data: Buffer) => resolve(data.toString()));
			child.once("error", reject);
			child.once("exit", (code) => reject(new Error(`child exited ${code}`)));
		});
		expect(ready).toContain("reserved");
		await expect(reserveSharedRequest({ path, requests: 2, concurrency: 1 })).rejects.toThrow("并发名额已满");
		const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
		child.kill();
		await closed;
		const release = await reserveSharedRequest({ path, requests: 2, concurrency: 1 });
		await release();
		expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ used: 2, active: [] });
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill();
	}
}, 15000);

it("损坏与变更上限不重置已用额度", async () => {
	const config = { path: join(directory(), "budget.json"), requests: 2, concurrency: 1 };
	const release = await reserveSharedRequest(config);
	await release();
	await expect(reserveSharedRequest({ ...config, requests: 3 })).rejects.toThrow("配置不一致");
	writeFileSync(config.path, "bad");
	await expect(reserveSharedRequest(config)).rejects.toThrow();
});

it("同会话拒绝双控制，不同会话独立，释放后可重开", async () => {
	const paoHome = directory();
	const first = await acquireSessionControl({ paoHome, sessionId: "甲", surface: "terminal" });
	releases.push(first.release);
	await expect(
		acquireSessionControl({ paoHome, sessionId: "甲", surface: "desktop", takeoverToken: first.owner.token }),
	).rejects.toThrow("已有控制方");
	const other = await acquireSessionControl({ paoHome, sessionId: "乙", surface: "desktop" });
	releases.push(other.release);
	first.assertOwned();
	other.assertOwned();
	await first.release();
	expect(() => first.assertOwned()).toThrow("失效");
	const next = await acquireSessionControl({ paoHome, sessionId: "甲", surface: "desktop" });
	releases.push(next.release);
});

it("残留身份必须明确接管，旧 token 不得接管新控制方", async () => {
	const paoHome = directory();
	const first = await acquireSessionControl({ paoHome, sessionId: "甲", surface: "terminal" });
	const dir = join(paoHome, ".pao", "运行时锁");
	const file = join(dir, readdirSync(dir).find((name) => name.endsWith(".json"))!);
	const stale = readFileSync(file, "utf8");
	await first.release();
	writeFileSync(file, stale);
	await expect(acquireSessionControl({ paoHome, sessionId: "甲", surface: "desktop" })).rejects.toThrow("显式接管");
	const next = await acquireSessionControl({
		paoHome,
		sessionId: "甲",
		surface: "desktop",
		takeoverToken: first.owner.token,
	});
	releases.push(next.release);
	expect(next.owner.token).not.toBe(first.owner.token);
});
