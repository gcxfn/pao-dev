import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { expect, test } from "vitest";
import { MinisterHost } from "../../src/pao/host/host.ts";

test("可信宿主目录惰性传给真实 RPC 子进程，单次环境仍不能覆盖部长身份", async () => {
	const parent = process.env.PAO_HOME;
	if (!parent || !isAbsolute(parent)) throw new Error("测试须显式设置隔离 PAO_HOME");
	mkdirSync(parent, { recursive: true });
	const root = mkdtempSync(join(parent, "child-environment-"));
	const script = join(root, "rpc-fixture.cjs");
	const output = join(root, "environment.json");
	// 仅模拟 RPC 应答，不调用模型；子进程和 IPC 通道是真实的。
	writeFileSync(
		script,
		[
			'const fs = require("node:fs");',
			'const readline = require("node:readline");',
			"fs.writeFileSync(process.argv[2], JSON.stringify({home:process.env.PAO_HOME,agentDir:process.env.PAO_CODING_AGENT_DIR,role:process.env.PAO_ROLE,marker:process.env.FIXTURE_MARKER,managed:process.env.PAO_MANAGED_PARENT,ipc:process.connected}));",
			'readline.createInterface({input:process.stdin}).on("line", line => {',
			"const cmd = JSON.parse(line);",
			'if (cmd.type === "get_state") console.log(JSON.stringify({type:"response",id:cmd.id,command:cmd.type,success:true,data:{sessionId:"environment-fixture"}}));',
			"});",
			'process.on("disconnect", () => process.exit(0));',
		].join("\n"),
	);
	let resolutions = 0;
	const home = join(root, "injected-home");
	const agentDir = join(root, "agent-config");
	const host = new MinisterHost({
		paoHome: home,
		childEnvironment: () => {
			resolutions++;
			return { PAO_HOME: home, PAO_CODING_AGENT_DIR: agentDir, FIXTURE_MARKER: "host" };
		},
		processInvocation: () => ({ command: process.execPath, args: [script, output] }),
	});
	try {
		expect(resolutions).toBe(0);
		const spawned = await host.spawn({
			部门: "规划",
			项目根: root,
			环境变量: { PAO_ROLE: "主控", FIXTURE_MARKER: "per-run" },
		});
		expect(spawned.ok).toBe(true);
		expect(resolutions).toBe(1);
		expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
			home,
			agentDir,
			role: "部长",
			marker: "per-run",
			managed: "1",
			ipc: true,
		});
	} finally {
		await host.stopAll("测试完成");
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}, 30_000);
