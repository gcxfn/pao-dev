import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { createPowerShellToolDefinition } from "../../src/core/tools/powershell.ts";
import { readWorkerExecutionFacts } from "../../src/pao/worker/evidence-facts.ts";
import { createTestExtensionToolContext } from "../extension-tool-context.ts";

/**
 * 所有新证据 fixture 都放在隔离 PAO_HOME 的任务父目录，不触碰正式 PAO_HOME。
 * 这里的真实工具测试直接执行产品 shell 工具，零模型；其余事件由测试显式构造。
 */
const FIXTURE_PARENT = "D:\\AI\\workspace\\临时文件夹\\深度审核重整-20261028\\i3-evidence-facts";
const PAO_HOME = join(FIXTURE_PARENT, "PAO_HOME");
const FIXTURE_ROOT = join(PAO_HOME, ".pao", "tasks", "i3-evidence-facts");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
	rmSync(FIXTURE_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
afterAll(() => rmSync(FIXTURE_PARENT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

interface EvidenceIdentity {
	cardPath: string;
	attempt: number;
	runId: string;
}

function tempDir(): { dir: string; identity: EvidenceIdentity } {
	mkdirSync(FIXTURE_ROOT, { recursive: true });
	const dir = mkdtempSync(join(FIXTURE_ROOT, "case-"));
	tempDirs.push(dir);
	const cardPath = join(dir, "卡0001.md");
	writeFileSync(cardPath, "---\n卡号: '0001'\n---\n", "utf8");
	return { dir, identity: { cardPath, attempt: 2, runId: "run-current" } };
}

function evidenceLines(
	identity: EvidenceIdentity,
	events: readonly Record<string, unknown>[],
	options: { header?: boolean; trailer?: boolean; brokenLine?: boolean } = {},
): string {
	const lines = [
		...(options.header === false
			? []
			: [
					JSON.stringify({
						type: "pao_worker_live",
						卡号: "0001",
						卡路径: identity.cardPath,
						尝试: identity.attempt,
						执行标识: identity.runId,
						pid: 1234,
						开始时间: "2026-10-30T00:00:00.000Z",
					}),
				]),
		...events.map((event) => JSON.stringify(event)),
		...(options.brokenLine ? ['{"type":"tool_execution_start"'] : []),
		...(options.trailer === false
			? []
			: [
					JSON.stringify({
						type: "pao_worker_evidence",
						卡号: "0001",
						卡路径: identity.cardPath,
						尝试: identity.attempt,
						执行标识: identity.runId,
						exitCode: 0,
						stderrTail: "",
					}),
				]),
	];
	return `${lines.join("\n")}\n`;
}

function writeEvidence(dir: string, name: string, body: string, compressed = false): string {
	const path = join(dir, name);
	writeFileSync(compressed ? `${path}.gz` : path, compressed ? gzipSync(body) : body);
	return compressed ? `${path}.gz` : path;
}

function start(callId: string, command: string, toolName = "bash"): Record<string, unknown> {
	return { type: "tool_execution_start", toolCallId: callId, toolName, args: { command } };
}

function end(callId: string, result: unknown, isError: boolean, toolName = "bash"): Record<string, unknown> {
	return { type: "tool_execution_end", toolCallId: callId, toolName, result, isError };
}

function structuredExit(exitCode: unknown, output = ""): Record<string, unknown> {
	return { content: [{ type: "text", text: output }], structuredContent: { exit_code: exitCode } };
}

describe("worker 证据程序事实", () => {
	it("真实产品 shell 工具退出码（零模型）经普通与 gzip 证据读取得到相同结果", async () => {
		const { dir, identity } = tempDir();
		const windows = process.platform === "win32";
		const toolOptions = { exposeSessionEnvironment: false };
		const definition = windows
			? createPowerShellToolDefinition(dir, toolOptions)
			: createBashToolDefinition(dir, toolOptions);
		const successCommand = windows ? "Write-Output 'facts-real'" : "printf 'facts-real\\n'";
		const failedCommand = windows ? "exit 3" : "exit 3";
		const ctx = await createTestExtensionToolContext(dir);

		// 直接调用产品工具定义；不是伪造 structuredContent，也不是模型调用。
		const success = await definition.execute("real-success", { command: successCommand }, undefined, undefined, ctx);
		const failed = await definition.execute("real-failed", { command: failedCommand }, undefined, undefined, ctx);
		const successStructured = success.structuredContent as { exit_code?: unknown } | undefined;
		const failedStructured = failed.structuredContent as { exit_code?: unknown } | undefined;
		expect(successStructured?.exit_code).toBe(0);
		expect(failedStructured?.exit_code).toBe(3);

		const events = [
			start("real-success", successCommand, definition.name),
			end("real-success", success, success.isError === true, definition.name),
			start("real-failed", failedCommand, definition.name),
			end("real-failed", failed, failed.isError === true, definition.name),
		];
		const body = evidenceLines(identity, events);
		const plain = writeEvidence(dir, "run.live.jsonl", body);
		const compressed = writeEvidence(dir, "archive.live.jsonl", body, true);
		const expected = { cardPath: identity.cardPath, attempt: identity.attempt, runId: identity.runId };

		const plainFacts = await readWorkerExecutionFacts(plain, expected);
		const compressedFacts = await readWorkerExecutionFacts(compressed, expected);

		expect(plainFacts).toEqual({
			commands: [
				{
					toolCallId: "real-success",
					toolName: definition.name,
					command: successCommand,
					exitCode: 0,
					completed: true,
				},
				{
					toolCallId: "real-failed",
					toolName: definition.name,
					command: failedCommand,
					exitCode: 3,
					completed: true,
				},
			],
			complete: true,
			issues: [],
		});
		expect(compressedFacts).toEqual(plainFacts);
		expect(readFileSync(plain, "utf8")).toContain("tool_execution_end");
	});

	it.each([
		["缺头", { header: false }],
		["缺尾", { trailer: false }],
		["坏 JSON", { brokenLine: true }],
	] as const)("%s 时明确标记证据不完整", async (_label, options) => {
		const { dir, identity } = tempDir();
		const path = writeEvidence(
			dir,
			"broken.live.jsonl",
			evidenceLines(identity, [start("call", "echo ok"), end("call", structuredExit(0), false)], options),
		);
		const facts = await readWorkerExecutionFacts(path, {
			cardPath: identity.cardPath,
			attempt: identity.attempt,
			runId: identity.runId,
		});

		expect(facts.complete).toBe(false);
		expect(facts.issues.join("\n")).toMatch(/头|尾|JSON/);
		expect(facts.commands).toEqual([]);
	});

	it("未结束、孤立结束、缺结构化退出码和错误结束都可见为不完整", async () => {
		const { dir, identity } = tempDir();
		const events = [
			start("pending", "echo pending"),
			end("orphan", structuredExit(0), false),
			start("no-exit", "exit 3"),
			end("no-exit", { content: [{ type: "text", text: "exit code 3" }] }, false),
			start("errored", "false"),
			end("errored", { content: [{ type: "text", text: "Command aborted" }] }, true),
		];
		const path = writeEvidence(dir, "partial.live.jsonl", evidenceLines(identity, events));
		const facts = await readWorkerExecutionFacts(path, {
			cardPath: identity.cardPath,
			attempt: identity.attempt,
			runId: identity.runId,
		});

		expect(facts.complete).toBe(false);
		expect(facts.commands).toEqual([
			{
				toolCallId: "pending",
				toolName: "bash",
				command: "echo pending",
				exitCode: null,
				completed: false,
			},
			{
				toolCallId: "no-exit",
				toolName: "bash",
				command: "exit 3",
				exitCode: null,
				completed: true,
			},
			{
				toolCallId: "errored",
				toolName: "bash",
				command: "false",
				exitCode: null,
				completed: true,
			},
		]);
		expect(facts.issues.join("\n")).toMatch(/未结束|没有对应开始|structuredContent\.exit_code/);
	});

	it("isError=false 不猜退出码 0，文本中的 exit code 不进入程序事实", async () => {
		const { dir, identity } = tempDir();
		const path = writeEvidence(
			dir,
			"no-structured.live.jsonl",
			evidenceLines(identity, [
				start("text-only", "anything"),
				end("text-only", structuredExit(null, "Command exited with code 3"), false),
			]),
		);
		const facts = await readWorkerExecutionFacts(path, {
			cardPath: identity.cardPath,
			attempt: identity.attempt,
			runId: identity.runId,
		});

		expect(facts.commands[0]?.exitCode).toBeNull();
		expect(facts.complete).toBe(false);
	});

	it("重复或冲突调用不被最后一条覆盖", async () => {
		const { dir, identity } = tempDir();
		const path = writeEvidence(
			dir,
			"duplicate.live.jsonl",
			evidenceLines(identity, [
				start("duplicate-start", "first"),
				start("duplicate-start", "second"),
				end("duplicate-start", structuredExit(0), false),
				start("duplicate-end", "third"),
				end("duplicate-end", structuredExit(0), false),
				end("duplicate-end", structuredExit(9), true),
			]),
		);
		const facts = await readWorkerExecutionFacts(path, {
			cardPath: identity.cardPath,
			attempt: identity.attempt,
			runId: identity.runId,
		});

		expect(facts.complete).toBe(false);
		expect(facts.commands).toEqual([]);
		expect(facts.issues.join("\n")).toMatch(/重复开始|重复结束/);
	});

	it("message_end 的 summary、模型 verification 和非 shell 事件不进入 commands", async () => {
		const { dir, identity } = tempDir();
		const path = writeEvidence(
			dir,
			"noise.live.jsonl",
			evidenceLines(identity, [
				{
					type: "message_end",
					message: {
						role: "assistant",
						summary: "虚构 summary",
						verification: [{ 条件: "声称已运行", 结论: "pass", 证据: "命令 exit 0" }],
						content: [{ type: "text", text: '{"command":"ignored"}' }],
					},
				},
				{ type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "x" } },
				{ type: "tool_execution_end", toolCallId: "read", toolName: "read", result: {}, isError: false },
				start("real", "echo fact"),
				end("real", structuredExit(0), false),
			]),
		);
		const facts = await readWorkerExecutionFacts(path, {
			cardPath: identity.cardPath,
			attempt: identity.attempt,
			runId: identity.runId,
		});

		expect(facts.complete).toBe(true);
		expect(facts.commands).toEqual([
			{
				toolCallId: "real",
				toolName: "bash",
				command: "echo fact",
				exitCode: 0,
				completed: true,
			},
		]);
	});

	const identityMismatches: Array<[string, { cardPath?: string; attempt?: number; runId?: string }]> = [
		["card", { cardPath: "D:\\other\\卡0001.md" }],
		["attempt", { attempt: 1 }],
		["run", { runId: "run-old" }],
	];
	it.each(identityMismatches)("拒绝 %s 身份错配且不返回事实", async (_label, patch) => {
		const { dir, identity } = tempDir();
		const path = writeEvidence(
			dir,
			"identity.live.jsonl",
			evidenceLines(identity, [start("call", "echo ok"), end("call", structuredExit(0), false)]),
		);
		const facts = await readWorkerExecutionFacts(path, {
			cardPath: patch.cardPath ?? identity.cardPath,
			attempt: patch.attempt ?? identity.attempt,
			runId: patch.runId ?? identity.runId,
		});

		expect(facts.complete).toBe(false);
		expect(facts.commands).toEqual([]);
		expect(facts.issues.join("\n")).toMatch(/身份不匹配/);
	});
});
