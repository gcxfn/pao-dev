import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MinisterHost } from "../../src/pao/host/host.ts";

/**
 * 真实受控 Node RPC 子进程的协议替身。它只消费宿主的 JSONL stdin 并回放受控 stdout，
 * 不加载 pi、不连接模型、网络或 Docker；这里的“自动重试”由替身按事件顺序模拟。
 */
const CHILD_SOURCE = String.raw`
const readline = require("node:readline");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state") {
    emit({
      type: "response",
      id: command.id,
      command: "get_state",
      success: true,
      data: { sessionId: "retry-protocol-session" },
    });
    return;
  }
  if (command.type !== "prompt") return;

  emit({ type: "agent_start" });
  emit({
    type: "response",
    id: command.id,
    command: "prompt",
    success: true,
    data: { disposition: "started" },
  });

  if (command.message === "retry-success") {
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "controlled first-attempt error",
      },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "retry succeeded text" }],
        stopReason: "stop",
      },
    });
    emit({ type: "agent_settled" });
    return;
  }

  if (command.message === "final-error") {
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "controlled final error",
      },
    });
    emit({ type: "agent_settled" });
    return;
  }

  if (command.message === "final-aborted") {
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "aborted",
        errorMessage: "controlled abort",
      },
    });
    emit({ type: "agent_settled" });
    return;
  }

  throw new Error("unknown controlled prompt: " + command.message);
});
`;

interface Fixture {
	host: MinisterHost;
	projectRoot: string;
	script: string;
	notices: string[];
}

const tempDirs: string[] = [];
const hosts: MinisterHost[] = [];

afterEach(async () => {
	for (const host of hosts.splice(0)) await host.stopAll("测试清理").catch(() => {});
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		} catch {
			// Windows 偶尔延迟释放子进程句柄；残留目录交给系统临时目录清理。
		}
	}
}, 30_000);

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-rpc-retry-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

function makeFixture(prefix: string): Fixture {
	const home = tempDir(`${prefix}-home`);
	mkdirSync(join(home, "pao配置"), { recursive: true });
	writeFileSync(join(home, "pao配置", "保温.json"), JSON.stringify({ 空闲分钟: 30 }), "utf8");
	const projectRoot = tempDir(`${prefix}-project`);
	const script = join(tempDir(`${prefix}-script`), "controlled-minister.cjs");
	writeFileSync(script, CHILD_SOURCE, "utf8");

	const notices: string[] = [];
	const host = new MinisterHost({
		paoHome: home,
		通知: (text) => notices.push(text),
	});
	hosts.push(host);
	return { host, projectRoot, script, notices };
}

async function spawnMinister(fixture: Fixture, context: string) {
	const result = await fixture.host.spawn({
		部门: "规划",
		项目根: fixture.projectRoot,
		脉络: context,
		命令: process.execPath,
		参数: [fixture.script],
	});
	if (!result.ok) throw new Error(result.原因);
	expect(result.handle.会话标识).toBe("retry-protocol-session");
	return result.handle;
}

async function waitUntil(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`等待受控 RPC ${label} 超时`);
}

describe("热会话自动重试的任务结算(线上协议替身，不是真实模型)", () => {
	it("inject 首次 error 后重试成功，只报告一条部长完成", async () => {
		const fixture = makeFixture("inject-retry");
		const context = "inject-retry-owner";
		await spawnMinister(fixture, context);

		expect(
			await fixture.host.inject("规划", fixture.projectRoot, "retry-success", context, "followUp"),
		).toMatchObject({
			ok: true,
			处置: "started",
		});
		await waitUntil(() => fixture.notices.length > 0, "inject 重试成功结算");

		expect(fixture.notices.filter((text) => text.startsWith("[部长完成]"))).toHaveLength(1);
		expect(fixture.notices.filter((text) => text.startsWith("[部长失败]"))).toHaveLength(0);
		expect(fixture.notices.find((text) => text.startsWith("[部长完成]"))).toContain("摘要:retry succeeded text");
	});

	it("executeTask 首次 error 后重试成功，resolve 真实成功文本", async () => {
		const fixture = makeFixture("execute-retry");
		const context = "execute-retry-owner";
		const handle = await spawnMinister(fixture, context);

		await expect(
			fixture.host.executeTask({
				部门: handle.部门,
				项目根: handle.项目根,
				脉络: context,
				会话标识: handle.会话标识,
				文本: "retry-success",
			}),
		).resolves.toBe("retry succeeded text");
		expect(fixture.notices.filter((text) => text.startsWith("[部长完成]"))).toHaveLength(1);
		expect(fixture.notices.filter((text) => text.startsWith("[部长失败]"))).toHaveLength(0);
	});
});

describe("热会话终止边界(线上协议替身，不是真实模型)", () => {
	it("最终 error 仍报告部长失败且不报告完成", async () => {
		const fixture = makeFixture("final-error");
		const context = "final-error-owner";
		await spawnMinister(fixture, context);

		expect(await fixture.host.inject("规划", fixture.projectRoot, "final-error", context, "followUp")).toMatchObject({
			ok: true,
		});
		await waitUntil(() => fixture.notices.some((text) => text.startsWith("[部长失败]")), "最终 error 结算");

		expect(fixture.notices.filter((text) => text.startsWith("[部长失败]"))).toHaveLength(1);
		expect(fixture.notices.filter((text) => text.startsWith("[部长完成]"))).toHaveLength(0);
	});

	it("aborted 不报告完成或失败", async () => {
		const fixture = makeFixture("final-aborted");
		const context = "final-aborted-owner";
		await spawnMinister(fixture, context);

		expect(
			await fixture.host.inject("规划", fixture.projectRoot, "final-aborted", context, "followUp"),
		).toMatchObject({
			ok: true,
		});
		await waitUntil(
			() =>
				fixture.host.backgroundCountFor({
					department: "规划",
					projectRoot: fixture.projectRoot,
					context,
					sessionId: "retry-protocol-session",
				}).inFlight === 0,
			"aborted 结算",
		);

		expect(fixture.notices.filter((text) => text.startsWith("[部长完成]"))).toHaveLength(0);
		expect(fixture.notices.filter((text) => text.startsWith("[部长失败]"))).toHaveLength(0);
	});
});
