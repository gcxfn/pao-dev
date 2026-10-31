import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCard } from "../../src/pao/cards/cardfile.ts";
import {
	bindExecutionContext,
	executionContextPath,
	type ExecutionBinding,
} from "../../src/pao/cards/execution-context.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import { PAO_ROLE_ENV } from "../../src/pao/role.ts";
import {
	absorbEvent,
	createEventState,
	evaluateWorkerResult,
	RECEIPT_TOOL_NAME,
	validateWorkerResultInput,
} from "../../src/pao/worker/receipt.ts";
import { createWorkerResultToolDefinition } from "../../src/pao/worker/result-tool.ts";
import { WorkerRunner } from "../../src/pao/worker/runner.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

function tempDir(prefix = "pao-worker-result-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeScript(body: string): string {
	const file = join(tempDir(), "fixture.js");
	writeFileSync(file, body, "utf8");
	return file;
}

function eventLine(event: Record<string, unknown>): string {
	return `console.log(${JSON.stringify(JSON.stringify(event))});`;
}

function validReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		result: "success",
		artifact_path: [],
		summary: "结构化结果",
		任务态: "completed",
		...overrides,
	};
}

function git(cwd: string, args: string[]): string {
	return execFileSync(
		"git",
		["-c", "core.quotepath=off", "-c", "user.email=test@example.invalid", "-c", "user.name=test", ...args],
		{
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	).trim();
}

async function executionFixture(): Promise<{
	sharedRoot: string;
	executionRoot: string;
	cardPath: string;
	binding: ExecutionBinding;
}> {
	const root = tempDir();
	const sharedRoot = join(root, "shared");
	const executionRoot = join(root, "execution");
	mkdirSync(sharedRoot);
	mkdirSync(executionRoot);
	writeFileSync(join(executionRoot, "tracked.txt"), "v1\n", "utf8");
	git(executionRoot, ["init"]);
	git(executionRoot, ["add", "-A"]);
	git(executionRoot, ["commit", "--no-gpg-sign", "-m", "base"]);

	const cardsDir = join(sharedRoot, ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const card = await createCard(cardsDir, {
		目标: "I3 worker 结构化结果",
		部门: "测试",
		验收: "工具结果按当前绑定解析",
		创建: "2026-10-29 10:00",
	});
	changeCardStatus(card, { 操作者: "主控", to: "in_progress", 时间: "2026-10-29 10:01" });
	const head = git(executionRoot, ["rev-parse", "HEAD"]);
	const binding = await bindExecutionContext(
		{
			key: { cardsDir, cardNo: card.card_no, attempt: 1 },
			projectRoot: sharedRoot,
			repositoryRoot: executionRoot,
			executionRoot,
			worktree: {
				kind: "primary",
				taskRoot: sharedRoot,
				executionRoot,
				commonGitDir: git(executionRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
				inputVersion: head,
				bindingDigest: `sha256:${createHash("sha256").update("test-host-binding").digest("hex")}`,
			},
			snapshotRef: "pao://brief/i3-worker-result",
			snapshotDigest: `sha256:${"a".repeat(64)}`,
		},
		{ expectedCurrentAttempt: 1 },
	);
	return { sharedRoot, executionRoot, cardPath: card.path, binding };
}

function workerScript(receipt: Record<string, unknown>, finalText = "结构化回执已提交"): string {
	return [
		eventLine({ type: "turn_start" }),
		eventLine({
			type: "tool_execution_start",
			toolCallId: "receipt-1",
			toolName: RECEIPT_TOOL_NAME,
			args: receipt,
		}),
		eventLine({
			type: "tool_execution_end",
			toolCallId: "receipt-1",
			toolName: RECEIPT_TOOL_NAME,
			isError: false,
		}),
		eventLine({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: finalText }],
				usage: { input: 1, output: 1, cost: 0 },
				stopReason: "end",
			},
		}),
	].join("\n");
}

describe("worker 窄结构化结果工具", () => {
	it("execute 当场使用共享验证器报具体字段错误，成功时只返回待宿主复核的自报结果", async () => {
		const cwd = tempDir();
		const tool = createWorkerResultToolDefinition();
		const ctx = { cwd } as never;

		for (const field of ["卡号", "card", "attempt", "owner"]) {
			await expect(
				tool.execute("identity", validReceipt({ [field]: "伪造身份" }) as never, undefined, undefined, ctx),
			).rejects.toThrow(`不允许由 worker 提交的字段：${field}`);
		}
		await expect(
			tool.execute(
				"failure",
				validReceipt({ result: "failed", summary: "执行失败" }) as never,
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("failure_type");
		await expect(
			tool.execute("empty-summary", validReceipt({ summary: "  \n " }) as never, undefined, undefined, ctx),
		).rejects.toThrow("非空且不超过 3 行");
		await expect(
			tool.execute(
				"summary",
				validReceipt({ summary: "一\n二\n三\n四" }) as never,
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("不超过 3 行");
		await expect(
			tool.execute(
				"absolute",
				validReceipt({ artifact_path: [join(cwd, "artifact.txt")] }) as never,
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("相对当前执行根");
		await expect(
			tool.execute(
				"outside",
				validReceipt({ artifact_path: ["../outside.txt"] }) as never,
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("越出当前执行根");
		await expect(
			tool.execute(
				"missing",
				validReceipt({ artifact_path: ["missing.txt"] }) as never,
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("产物不存在");

		const result = await tool.execute("valid", validReceipt() as never, undefined, undefined, ctx);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain("仍是 worker 声明");
		expect(result.details).toEqual({
			receipt_kind: "worker_self_report",
			host_verification: "pending",
		});
		expect(existsSync(join(cwd, ".pao"))).toBe(false);
	});

	it("结束事件必须同时匹配工具名与 call id，失败、缺结束和双来源都不能交卷", () => {
		const start = createEventState();
		absorbEvent(
			start,
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "same-id",
				toolName: RECEIPT_TOOL_NAME,
				args: validReceipt(),
			}),
		);
		absorbEvent(
			start,
			JSON.stringify({
				type: "tool_execution_end",
				toolCallId: "same-id",
				toolName: "another_tool",
				isError: false,
			}),
		);
		expect(start.receipt_tool_calls[0]?.succeeded).toBeUndefined();
		expect(() =>
			evaluateWorkerResult({
				toolReceipts: start.receipt_tool_calls,
				finalText: JSON.stringify(validReceipt()),
				executionRoot: process.cwd(),
			}),
		).toThrow("未收到成功结束事件");

		const failed = createEventState();
		absorbEvent(
			failed,
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "failed-id",
				toolName: RECEIPT_TOOL_NAME,
				args: validReceipt(),
			}),
		);
		absorbEvent(
			failed,
			JSON.stringify({
				type: "tool_execution_end",
				toolCallId: "failed-id",
				toolName: RECEIPT_TOOL_NAME,
				isError: true,
			}),
		);
		expect(() =>
			evaluateWorkerResult({
				toolReceipts: failed.receipt_tool_calls,
				finalText: JSON.stringify(validReceipt()),
				executionRoot: process.cwd(),
			}),
		).toThrow("执行失败");

		const succeeded = createEventState();
		absorbEvent(
			succeeded,
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "ok-id",
				toolName: RECEIPT_TOOL_NAME,
				args: validReceipt(),
			}),
		);
		absorbEvent(
			succeeded,
			JSON.stringify({
				type: "tool_execution_end",
				toolCallId: "ok-id",
				toolName: RECEIPT_TOOL_NAME,
				isError: false,
			}),
		);
		expect(
			evaluateWorkerResult({
				toolReceipts: succeeded.receipt_tool_calls,
				finalText: JSON.stringify(validReceipt()),
				executionRoot: process.cwd(),
			}),
		).toMatchObject({
			source: "tool",
			result: { result: "success", summary: "结构化结果", 任务态: "completed" },
		});

		const duplicateEnd = createEventState();
		for (const isError of [false, false]) {
			absorbEvent(
				duplicateEnd,
				JSON.stringify({
					type: "tool_execution_end",
					toolCallId: "duplicate-end",
					toolName: RECEIPT_TOOL_NAME,
					isError,
				}),
			);
		}
		absorbEvent(
			duplicateEnd,
			JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "duplicate-end",
				toolName: RECEIPT_TOOL_NAME,
				args: validReceipt(),
			}),
		);
		// 先到的孤立结束不属于本次 start；它和后续未结束状态都不能组成成功配对。
		expect(duplicateEnd.receipt_tool_calls[0]?.succeeded).toBeUndefined();

		absorbEvent(
			duplicateEnd,
			JSON.stringify({
				type: "tool_execution_end",
				toolCallId: "duplicate-end",
				toolName: RECEIPT_TOOL_NAME,
				isError: false,
			}),
		);
		absorbEvent(
			duplicateEnd,
			JSON.stringify({
				type: "tool_execution_end",
				toolCallId: "duplicate-end",
				toolName: RECEIPT_TOOL_NAME,
				isError: false,
			}),
		);
		expect(duplicateEnd.receipt_tool_calls[0]?.succeeded).toBe(false);
	});

	it("协议模拟：真实 node 子进程让 WorkerRunner 收取成功工具参数，最后消息可只写普通说明", async () => {
		const cwd = tempDir();
		const receipt = await new WorkerRunner().run({
			卡号: "0020",
			提示词: "",
			命令: process.execPath,
			参数: [writeScript(workerScript(validReceipt()))],
			cwd,
			证据目录: cwd,
			要求回执: true,
		});

		expect(receipt).toMatchObject({
			status: "success",
			summary: "结构化结果",
			result_source: "tool",
			任务态: "completed",
			card_no: "0020",
			attempt: 1,
			exitCode: 0,
		});
		expect(receipt.run_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(receipt.evidence_path).toBeTruthy();
		expect(existsSync(receipt.evidence_path)).toBe(true);
		expect(receipt.usage).toEqual({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 });
		expect(receipt.verification).toBeUndefined();
		expect(receipt.changes).toBeUndefined();
	});

	it("协议模拟：成功工具后附相同 JSON 尾文时仍只采信工具结果", async () => {
		const cwd = tempDir();
		const submitted = validReceipt({ summary: "工具与尾文相同" });
		const receipt = await new WorkerRunner().run({
			卡号: "0029",
			提示词: "",
			命令: process.execPath,
			参数: [writeScript(workerScript(submitted, JSON.stringify(submitted)))],
			cwd,
			证据目录: cwd,
			要求回执: true,
		});

		expect(receipt).toMatchObject({
			status: "success",
			summary: "工具与尾文相同",
			result_source: "tool",
			任务态: "completed",
			card_no: "0029",
			attempt: 1,
		});
		expect(receipt.failure_type).toBeUndefined();
	});

	it("协议模拟：成功工具后的不同 JSON 尾文不得成为第二份回执或覆盖工具结果", async () => {
		const cwd = tempDir();
		const submitted = validReceipt({ summary: "工具权威结果" });
		const conflictingTail = JSON.stringify({
			result: "failed",
			artifact_path: [],
			summary: "尾文不得覆盖",
			failure_type: "transient",
			任务态: "blocked",
		});
		const receipt = await new WorkerRunner().run({
			卡号: "0030",
			提示词: "",
			命令: process.execPath,
			参数: [writeScript(workerScript(submitted, conflictingTail))],
			cwd,
			证据目录: cwd,
			要求回执: true,
		});

		expect(receipt).toMatchObject({
			status: "success",
			summary: "工具权威结果",
			result_source: "tool",
			任务态: "completed",
			card_no: "0030",
			attempt: 1,
		});
		expect(receipt.failure_type).toBeUndefined();
	});

	it("协议模拟：真实 node 子进程的 isError=true 工具事件不被采纳，也不回退有效文本", async () => {
		const cwd = tempDir();
		const validText = JSON.stringify(validReceipt({ summary: "不能借文本回退" }));
		const script = writeScript(
			[
				eventLine({
					type: "tool_execution_start",
					toolCallId: "rejected",
					toolName: RECEIPT_TOOL_NAME,
					args: validReceipt({ attempt: 1 }),
				}),
				eventLine({
					type: "tool_execution_end",
					toolCallId: "rejected",
					toolName: RECEIPT_TOOL_NAME,
					isError: true,
				}),
				eventLine({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: validText }],
						usage: { input: 1, output: 1, cost: 0 },
						stopReason: "end",
					},
				}),
			].join("\n"),
		);
		const receipt = await new WorkerRunner().run({
			卡号: "0021",
			提示词: "",
			命令: process.execPath,
			参数: [script],
			cwd,
			证据目录: cwd,
			要求回执: true,
		});

		expect(receipt.status).toBe("failed");
		expect(receipt.failure_type).toBe("unknown_outcome");
		expect(receipt.summary).toContain("回执工具执行失败");
		expect(receipt.result_source).toBeUndefined();
	});

	it("协议模拟：被拒绝的调用不算已交结果，后续唯一成功调用可被 runner 采纳", async () => {
		const cwd = tempDir();
		const script = writeScript(
			[
				eventLine({
					type: "tool_execution_start",
					toolCallId: "rejected-first",
					toolName: RECEIPT_TOOL_NAME,
					args: validReceipt({ summary: "" }),
				}),
				eventLine({
					type: "tool_execution_end",
					toolCallId: "rejected-first",
					toolName: RECEIPT_TOOL_NAME,
					isError: true,
				}),
				eventLine({
					type: "tool_execution_start",
					toolCallId: "corrected",
					toolName: RECEIPT_TOOL_NAME,
					args: validReceipt({ summary: "修正后提交" }),
				}),
				eventLine({
					type: "tool_execution_end",
					toolCallId: "corrected",
					toolName: RECEIPT_TOOL_NAME,
					isError: false,
				}),
				eventLine({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "已完成修正并提交" }],
						usage: { input: 2, output: 2, cost: 0 },
						stopReason: "end",
					},
				}),
			].join("\n"),
		);
		const receipt = await new WorkerRunner().run({
			卡号: "0028",
			提示词: "",
			命令: process.execPath,
			参数: [script],
			cwd,
			证据目录: cwd,
			要求回执: true,
		});

		expect(receipt.status).toBe("success");
		expect(receipt.summary).toBe("修正后提交");
		expect(receipt.result_source).toBe("tool");
		expect(receipt.usage.turns).toBe(1);
	});

	it("协议模拟：工具名或调用 ID 未配对时，真实 WorkerRunner 不采纳参数也不回退文本", async () => {
		const cwd = tempDir();
		const text = JSON.stringify(validReceipt({ summary: "未配对不能回退" }));
		const script = writeScript(
			[
				eventLine({
					type: "tool_execution_start",
					toolCallId: "current-call",
					toolName: RECEIPT_TOOL_NAME,
					args: validReceipt(),
				}),
				eventLine({
					type: "tool_execution_end",
					toolCallId: "current-call",
					toolName: "another_tool",
					isError: false,
				}),
				eventLine({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text }],
						usage: { input: 1, output: 1, cost: 0 },
						stopReason: "end",
					},
				}),
			].join("\n"),
		);
		const receipt = await new WorkerRunner().run({
			卡号: "0024",
			提示词: "",
			命令: process.execPath,
			参数: [script],
			cwd,
			证据目录: cwd,
			要求回执: true,
		});

		expect(receipt.status).toBe("failed");
		expect(receipt.summary).toContain("未收到成功结束事件");
		expect(receipt.result_source).toBeUndefined();
	});

	it("协议模拟：真实 node 子进程提交两次工具结果时按来源冲突拒绝", async () => {
		const cwd = tempDir();
		const script = writeScript(
			[
				eventLine({
					type: "tool_execution_start",
					toolCallId: "first",
					toolName: RECEIPT_TOOL_NAME,
					args: validReceipt({ summary: "第一份" }),
				}),
				eventLine({
					type: "tool_execution_end",
					toolCallId: "first",
					toolName: RECEIPT_TOOL_NAME,
					isError: false,
				}),
				eventLine({
					type: "tool_execution_start",
					toolCallId: "second",
					toolName: RECEIPT_TOOL_NAME,
					args: validReceipt({ summary: "第二份" }),
				}),
				eventLine({
					type: "tool_execution_end",
					toolCallId: "second",
					toolName: RECEIPT_TOOL_NAME,
					isError: false,
				}),
				eventLine({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "普通说明" }],
						usage: { input: 1, output: 1, cost: 0 },
						stopReason: "end",
					},
				}),
			].join("\n"),
		);
		const receipt = await new WorkerRunner().run({
			卡号: "0025",
			提示词: "",
			命令: process.execPath,
			参数: [script],
			cwd,
			证据目录: cwd,
			要求回执: true,
		});

		expect(receipt.status).toBe("failed");
		expect(receipt.summary).toContain("收到 2 次成功回执工具调用");
		expect(receipt.result_source).toBeUndefined();
	});

	it("同一 WorkerRunner 的旧 run 成功结果不会串入下一次派发", async () => {
		const runner = new WorkerRunner();
		const cwd = tempDir();
		const first = await runner.run({
			卡号: "0026",
			提示词: "",
			命令: process.execPath,
			参数: [writeScript(workerScript(validReceipt({ summary: "旧 run" })))],
			cwd,
			证据目录: cwd,
			要求回执: true,
		});
		expect(first.status).toBe("success");

		const second = await runner.run({
			卡号: "0026",
			提示词: "",
			命令: process.execPath,
			参数: [
				writeScript(
					eventLine({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "本次没有提交结构化结果" }],
							usage: { input: 1, output: 1, cost: 0 },
							stopReason: "end",
						},
					}),
				),
			],
			cwd,
			证据目录: cwd,
			要求回执: true,
		});
		expect(second.failure_type).toBe("unknown_outcome");
		expect(second.summary).toContain("无有效回执");
		expect(second.summary).not.toContain("旧 run");
	});

	it("旧最终文本 JSON 回执继续兼容，并同样由宿主补身份、证据、退出码和用量", async () => {
		const cwd = tempDir();
		const absoluteArtifact = join(cwd, "旧文本产物.txt");
		const forgedEvidence = join(cwd, "forged-evidence.jsonl");
		writeFileSync(absoluteArtifact, "旧回执产物", "utf8");
		writeFileSync(forgedEvidence, "{}", "utf8");
		const textReceipt = JSON.stringify(
			validReceipt({
				artifact_path: [absoluteArtifact],
				summary: "旧文本回执",
				card_no: "9999",
				attempt: 99,
				usage: { input: 999, output: 999, cost: 999 },
				evidence_path: forgedEvidence,
				exitCode: 99,
			}),
		);
		const receipt = await new WorkerRunner().run({
			卡号: "0027",
			提示词: "",
			命令: process.execPath,
			参数: [
				writeScript(
					eventLine({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: textReceipt }],
							usage: { input: 2, output: 3, cost: 0 },
							stopReason: "end",
						},
					}),
				),
			],
			cwd,
			证据目录: cwd,
			要求回执: true,
		});

		expect(receipt).toMatchObject({
			status: "success",
			card_no: "0027",
			attempt: 1,
			summary: "旧文本回执",
			result_source: "text",
			artifact_path: ["旧文本产物.txt"],
			exitCode: 0,
		});
		expect(receipt.evidence_path).toBeTruthy();
		expect(receipt.evidence_path).not.toBe(forgedEvidence);
		expect(existsSync(receipt.evidence_path)).toBe(true);
		expect(receipt.usage).toEqual({ input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 });
	});

	it("旧文本回执拒绝执行根外的绝对产物路径", async () => {
		const cwd = tempDir();
		const outside = tempDir();
		const outsideArtifact = join(outside, "outside.txt");
		writeFileSync(outsideArtifact, "根外产物", "utf8");
		const textReceipt = JSON.stringify(validReceipt({ artifact_path: [outsideArtifact] }));
		const receipt = await new WorkerRunner().run({
			卡号: "0031",
			提示词: "",
			命令: process.execPath,
			参数: [
				writeScript(
					eventLine({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: textReceipt }],
							usage: { input: 1, output: 1, cost: 0 },
							stopReason: "end",
						},
					}),
				),
			],
			cwd,
			证据目录: cwd,
			要求回执: true,
		});

		expect(receipt.status).toBe("failed");
		expect(receipt.failure_type).toBe("unknown_outcome");
		expect(receipt.summary).toContain("旧文本回执声明的绝对产物越出当前执行根");
		expect(receipt.result_source).toBeUndefined();
	});

	it("旧文本根内绝对路径经链接逃逸时仍拒绝", async () => {
		const cwd = tempDir();
		const outside = tempDir();
		const outsideArtifact = join(outside, "outside.txt");
		writeFileSync(outsideArtifact, "链接目标在根外", "utf8");
		const link = join(cwd, "linked");
		symlinkSync(outside, link, "junction");
		const textReceipt = JSON.stringify(validReceipt({ artifact_path: [join(link, "outside.txt")] }));
		const receipt = await new WorkerRunner().run({
			卡号: "0032",
			提示词: "",
			命令: process.execPath,
			参数: [
				writeScript(
					eventLine({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: textReceipt }],
							usage: { input: 1, output: 1, cost: 0 },
							stopReason: "end",
						},
					}),
				),
			],
			cwd,
			证据目录: cwd,
			要求回执: true,
		});

		expect(receipt.status).toBe("failed");
		expect(receipt.failure_type).toBe("unknown_outcome");
		expect(receipt.summary).toContain("经链接越出当前执行根");
		expect(receipt.result_source).toBeUndefined();
	});
});

describe("worker 结果与 ExecutionBinding 一致性", () => {
	it("产物只按当前 attempt 的实时执行根解析，不从任务根同名文件回退", async () => {
		const fixture = await executionFixture();
		writeFileSync(join(fixture.executionRoot, "artifact.txt"), "execution", "utf8");
		writeFileSync(join(fixture.sharedRoot, "artifact.txt"), "task-root fallback", "utf8");
		const request = validReceipt({ artifact_path: ["artifact.txt"] });
		const base = {
			卡号: "0001",
			卡路径: fixture.cardPath,
			提示词: "",
			命令: process.execPath,
			cwd: fixture.executionRoot,
			taskRoot: fixture.sharedRoot,
			executionRoot: fixture.executionRoot,
			executionBinding: fixture.binding,
			要求回执: true as const,
		};

		const first = await new WorkerRunner().run({
			...base,
			参数: [writeScript(workerScript(request))],
			证据目录: fixture.sharedRoot,
		});
		expect(first).toMatchObject({
			status: "success",
			artifact_path: ["artifact.txt"],
			result_source: "tool",
		});

		unlinkSync(join(fixture.executionRoot, "artifact.txt"));
		const second = await new WorkerRunner().run({
			...base,
			参数: [writeScript(workerScript(request))],
			证据目录: fixture.sharedRoot,
		});
		expect(second.status).toBe("failed");
		expect(second.failure_type).toBe("unknown_outcome");
		expect(second.summary).toContain("产物不存在");
		expect(second.artifact_path).toEqual([]);
	});

	it("持久绑定损坏时拒绝采信工具结果，不改用任务根或 run cwd 的产物", async () => {
		const fixture = await executionFixture();
		writeFileSync(join(fixture.sharedRoot, "task-only.txt"), "same-name", "utf8");
		const persistedPath = executionContextPath(fixture.binding.key);
		const persisted = JSON.parse(readFileSync(persistedPath, "utf8")) as Record<string, unknown>;
		persisted.executionRoot = fixture.sharedRoot;
		writeFileSync(persistedPath, JSON.stringify(persisted), "utf8");
		const request = validReceipt({ artifact_path: ["task-only.txt"] });

		const receipt = await new WorkerRunner().run({
			卡号: "0001",
			卡路径: fixture.cardPath,
			提示词: "",
			命令: process.execPath,
			参数: [writeScript(workerScript(request))],
			cwd: fixture.executionRoot,
			taskRoot: fixture.sharedRoot,
			executionRoot: fixture.executionRoot,
			executionBinding: fixture.binding,
			证据目录: fixture.sharedRoot,
			要求回执: true,
		});

		expect(receipt.status).toBe("failed");
		expect(receipt.failure_type).toBe("unknown_outcome");
		expect(receipt.summary).toContain("执行绑定复核失败");
		expect(receipt.summary).not.toContain("task-only.txt");
		expect(receipt.artifact_path).toEqual([]);
		expect(receipt.result_source).toBeUndefined();
	});

	it("绝对路径、父目录越界和链接逃逸都拒绝", () => {
		const root = tempDir();
		const outside = tempDir();
		writeFileSync(join(root, "inside.txt"), "inside", "utf8");
		writeFileSync(join(outside, "outside.txt"), "outside", "utf8");
		expect(() => validateWorkerResultInput(validReceipt({ artifact_path: [join(root, "inside.txt")] }), root)).toThrow(
			"相对当前执行根",
		);
		expect(() =>
			validateWorkerResultInput(validReceipt({ artifact_path: ["../outside.txt"] }), root),
		).toThrow("越出当前执行根");

		const link = join(root, "linked");
		try {
			symlinkSync(outside, link, "junction");
		} catch {
			return;
		}
		expect(() => validateWorkerResultInput(validReceipt({ artifact_path: ["linked/outside.txt"] }), root)).toThrow(
			"经链接越出当前执行根",
		);
	});
});

describe("WorkerRunner 可信子进程环境", () => {
	it("按 process.env→childEnvironment→本次派发→强制身份顺序合并，且不打印环境值", async () => {
		const parentKey = "PAO_I3_TEST_INHERITED";
		const childOverrideKey = "PAO_I3_TEST_CHILD_OVERRIDE";
		const childOnlyKey = "PAO_I3_TEST_CHILD_ONLY";
		const optionsOnlyKey = "PAO_I3_TEST_OPTIONS_ONLY";
		const secretKey = "PAO_I3_TEST_SECRET_TOKEN";
		const oldValue = process.env[parentKey];
		const oldChildOverride = process.env[childOverrideKey];
		process.env[parentKey] = "process";
		process.env[childOverrideKey] = "process";
		try {
			const cwd = tempDir();
			const output = join(cwd, "environment.json");
			const script = writeScript(
				[
					'const fs = require("node:fs");',
					`fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({`,
					`inherited: process.env.${parentKey},`,
					`childOverride: process.env.${childOverrideKey},`,
					`childOnly: process.env.${childOnlyKey},`,
					`optionsOnly: process.env.${optionsOnlyKey},`,
					`role: process.env.${PAO_ROLE_ENV},`,
					`managed: process.env.PAO_MANAGED_PARENT,`,
					`secretPresent: Boolean(process.env.${secretKey})`,
					"}));",
					eventLine({ type: "turn_start" }),
					eventLine({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "环境检查完成" }],
							usage: { input: 1, output: 1, cost: 0 },
							stopReason: "end",
						},
					}),
				].join("\n"),
			);
			const runner = new WorkerRunner({
				childEnvironment: () => ({
					[parentKey]: "child",
					[childOverrideKey]: "child",
					[childOnlyKey]: "child-only",
					[secretKey]: "i3-child-secret",
					[PAO_ROLE_ENV]: "child-role",
					PAO_MANAGED_PARENT: "child-managed",
				}),
			});
			const receipt = await runner.run({
				卡号: "0022",
				提示词: "",
				命令: process.execPath,
				参数: [script],
				cwd,
				证据目录: cwd,
				环境变量: {
					[parentKey]: "options",
					[optionsOnlyKey]: "options-only",
					[PAO_ROLE_ENV]: "options-role",
					PAO_MANAGED_PARENT: "options-managed",
				},
			});

			expect(receipt.status).toBe("success");
			expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
				inherited: "options",
				childOverride: "child",
				childOnly: "child-only",
				optionsOnly: "options-only",
				role: "worker",
				managed: "0",
				secretPresent: true,
			});
			expect(`${receipt.summary}\n${receipt.stderrTail ?? ""}`).not.toContain("i3-child-secret");
		} finally {
			if (oldValue === undefined) delete process.env[parentKey];
			else process.env[parentKey] = oldValue;
			if (oldChildOverride === undefined) delete process.env[childOverrideKey];
			else process.env[childOverrideKey] = oldChildOverride;
		}
	});

	it("childEnvironment 抛错时派发失败并向外暴露原因", async () => {
		await expect(
			new WorkerRunner({
				childEnvironment: () => {
					throw new Error("可信环境读取失败");
				},
			}).run({
				卡号: "0023",
				提示词: "",
				命令: process.execPath,
				参数: ["-e", ""],
				cwd: tempDir(),
			}),
		).rejects.toThrow("可信环境读取失败");
	});
});
