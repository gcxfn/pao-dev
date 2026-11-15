/** 当前构建 CLI + 原生模拟模型；真实启动、标准输入、会话落盘和重开，不访问供应商。 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill();
			await new Promise<void>((done) => child.once("close", () => done()));
		}
	}
	children.clear();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pao-cli-final-"));
	roots.push(root);
	return { root, log: join(root, "events.jsonl"), agent: join(root, "agent"), sessions: join(root, "sessions") };
}

function events(log: string): Array<Record<string, unknown>> {
	try {
		return readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function launch(f: ReturnType<typeof fixture>, args: string[], scenario = "normal", role?: string) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|PAO_HOME|PAO_ROLE|PAO_DEPT|PI_PACKAGE_DIR/.test(key)) delete env[key];
	}
	const child = spawn(
		process.execPath,
		[
			resolve("dist/bundle/cli.js"),
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			role ? "--no-builtin-tools" : "--no-tools",
			"-e",
			resolve("test/pao/cli-lifecycle-provider.mjs"),
			"--provider",
			"faux",
			"--model",
			"faux-1",
			"--session-dir",
			f.sessions,
			...args,
		],
		{
			cwd: f.root,
			windowsHide: true,
			env: {
				...env,
				HOME: f.root,
				USERPROFILE: f.root,
				PI_CODING_AGENT_DIR: f.agent,
				PAO_HOME: join(f.root, "pao"),
				PI_OFFLINE: "1",
				PAO_DISABLE_BUILTIN_EXTENSION: "1",
				PAO_CLI_TEST_LOG: f.log,
				PAO_CLI_TEST_CASE: scenario,
				...(role ? { PAO_ROLE: role, PAO_DEPT: "文档" } : {}),
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	children.add(child);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => done({ code, signal }));
	});
	return { child, closed, output: () => ({ stdout, stderr }) };
}

describe("最终 CLI 离线生命周期", () => {
	it.each(["主控", "部长", "worker"])("%s最终请求使用当前PAO角色提示与工具集合", async (role) => {
		const f = fixture();
		const run = launch(f, ["-p", "仅捕获上下文"], "role", role);
		run.child.stdin.end();
		expect(await run.closed, JSON.stringify(run.output())).toEqual({ code: 0, signal: null });
		const request = events(f.log).find((e) => e.type === "request")!;
		const tools = request.tools as Array<{ name: string }>;
		const names = tools.map((tool) => tool.name);
		expect(names.length).toBeGreaterThan(0);
		if (role === "主控") {
			expect(request.systemPrompt).toContain("将具体业务任务交给相应部门");
			expect(names).toContain("pao_spawn_minister");
		} else {
			expect(names).not.toContain("pao_spawn_minister");
			if (role === "部长") expect(request.systemPrompt).toContain("你负责本部门任务的组织");
		}
		expect(Buffer.byteLength(String(request.systemPrompt), "utf8")).toBeGreaterThan(0);
		expect(Buffer.byteLength(JSON.stringify(tools), "utf8")).toBeGreaterThan(0);
	});

	it("自然完成并保存，重新打开同一会话读取旧消息而不重放旧请求", async () => {
		const f = fixture();
		const first = launch(f, ["-p", "第一轮输入"]);
		first.child.stdin.end();
		expect(await first.closed, JSON.stringify(first.output())).toEqual({ code: 0, signal: null });
		expect(first.output().stdout).toContain("离线回应完成");
		const start = events(f.log).find((e) => e.type === "start")!;
		expect(start.file).toEqual(expect.any(String));
		const second = launch(f, ["--session", String(start.file), "-p", "第二轮输入"]);
		second.child.stdin.end();
		expect(await second.closed, JSON.stringify(second.output())).toEqual({ code: 0, signal: null });
		const log = events(f.log);
		expect(log.filter((e) => e.type === "start").map((e) => e.id)).toEqual([start.id, start.id]);
		const requests = log.filter((e) => e.type === "request");
		expect(requests).toHaveLength(2);
		expect(JSON.stringify(requests[1].messages)).toContain("第一轮输入");
		expect(JSON.stringify(requests[1].messages)).toContain("第二轮输入");
		expect(log.filter((e) => e.type === "shutdown")).toHaveLength(2);
	});

	it("供应商异常显式失败，执行关闭处理而不报告正常交付", async () => {
		const f = fixture();
		const run = launch(f, ["-p", "触发错误"], "error");
		run.child.stdin.end();
		expect((await run.closed).code, JSON.stringify(run.output())).not.toBe(0);
		expect(run.output().stderr).toContain("离线供应商故障");
		expect(events(f.log).filter((e) => e.type === "shutdown")).toHaveLength(1);
	});

	it("RPC主动abort结束请求，输入关闭后真实CLI自然退出", async () => {
		const f = fixture();
		const run = launch(f, ["--mode", "rpc"], "abort");
		run.child.stdin.write(`${JSON.stringify({ id: "prompt-one", type: "prompt", message: "长请求" })}\n`);
		await expect.poll(() => events(f.log).some((e) => e.type === "request"), { timeout: 15000 }).toBe(true);
		run.child.stdin.write(`${JSON.stringify({ id: "abort-one", type: "abort" })}\n`);
		await expect.poll(() => run.output().stdout, { timeout: 10000 }).toContain('"id":"abort-one"');
		expect(run.output().stdout).toContain('"stopReason":"aborted"');
		run.child.stdin.end();
		expect(await run.closed, JSON.stringify(run.output())).toEqual({ code: 0, signal: null });
		expect(events(f.log).filter((e) => e.type === "shutdown")).toHaveLength(1);
	});
});
