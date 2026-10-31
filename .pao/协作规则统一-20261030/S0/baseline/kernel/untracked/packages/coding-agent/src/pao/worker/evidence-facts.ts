import { resolve } from "node:path";
import { readWorkerEvidenceFile, resolveWorkerEvidencePath } from "../shared/evidence.ts";
import { parseWorkerToolExecutionEvent } from "./receipt.ts";

export type WorkerShellToolName = "bash" | "powershell";

export interface WorkerCommandFact {
	toolCallId: string;
	toolName: WorkerShellToolName;
	command: string;
	exitCode: number | null;
	completed: boolean;
}

export interface WorkerExecutionFactsResult {
	commands: WorkerCommandFact[];
	complete: boolean;
	issues: string[];
}

export interface WorkerExecutionFactsExpectation {
	cardPath: string;
	attempt: number;
	runId?: string;
}

interface EvidenceIdentity {
	cardPath: string;
	attempt: number;
	runId: string;
}

interface CommandState extends WorkerCommandFact {
	conflicted: boolean;
	endSeen: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCardPath(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameCardPath(left: string, right: string): boolean {
	return normalizeCardPath(left) === normalizeCardPath(right);
}

function readIdentity(value: Record<string, unknown>, label: string, issues: string[]): EvidenceIdentity | undefined {
	const cardPath = value.卡路径;
	const attempt = value.尝试;
	const runId = value.执行标识;
	if (typeof cardPath !== "string" || !cardPath.trim()) {
		issues.push(`${label}缺少有效卡路径`);
	}
	if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
		issues.push(`${label}缺少有效尝试号`);
	}
	if (typeof runId !== "string" || !runId.trim()) {
		issues.push(`${label}缺少有效执行标识`);
	}
	if (issues.length > 0) return undefined;
	return { cardPath: cardPath as string, attempt: attempt as number, runId: runId as string };
}

function issue(message: string): WorkerExecutionFactsResult {
	return { commands: [], complete: false, issues: [message] };
}

function validateEnvelope(
	events: readonly unknown[],
	expected: WorkerExecutionFactsExpectation,
): { issues: string[]; valid: boolean } {
	const issues: string[] = [];
	const first = events[0];
	const last = events.at(-1);
	if (!isRecord(first)) issues.push("证据缺少 pao_worker_live 头");
	else if (first.type !== "pao_worker_live") issues.push("证据缺少 pao_worker_live 头");
	if (!isRecord(last)) issues.push("证据缺少 pao_worker_evidence 尾");
	else if (last.type !== "pao_worker_evidence") issues.push("证据缺少 pao_worker_evidence 尾");
	if (issues.length > 0) return { issues, valid: false };

	if (!isRecord(first) || !isRecord(last)) return { issues, valid: false };
	const header = readIdentity(first, "证据头", issues);
	const trailer = readIdentity(last, "证据尾", issues);
	for (const [index, event] of events.entries()) {
		if (!isRecord(event)) continue;
		if (
			(index !== 0 && event.type === "pao_worker_live") ||
			(index !== events.length - 1 && event.type === "pao_worker_evidence")
		) {
			issues.push("证据头或尾位置重复");
		}
	}
	if (!header || !trailer) return { issues, valid: false };
	if (!sameCardPath(header.cardPath, trailer.cardPath)) issues.push("证据头尾卡路径不一致");
	if (header.attempt !== trailer.attempt) issues.push("证据头尾尝试号不一致");
	if (header.runId !== trailer.runId) issues.push("证据头尾执行标识不一致");
	if (!sameCardPath(header.cardPath, expected.cardPath)) issues.push("证据卡路径身份不匹配");
	if (header.attempt !== expected.attempt) issues.push("证据尝试号身份不匹配");
	if (expected.runId !== undefined && header.runId !== expected.runId) issues.push("证据执行标识身份不匹配");
	return { issues, valid: issues.length === 0 };
}

function isShellToolName(value: unknown): value is WorkerShellToolName {
	return value === "bash" || value === "powershell";
}

function structuredExitCode(result: unknown, label: string, issues: string[]): number | null {
	if (!isRecord(result) || !isRecord(result.structuredContent)) {
		issues.push(`${label}缺少 result.structuredContent.exit_code`);
		return null;
	}
	const value = result.structuredContent.exit_code;
	if (typeof value !== "number" || !Number.isInteger(value)) {
		issues.push(`${label}的 result.structuredContent.exit_code 不是整数`);
		return null;
	}
	return value;
}

function collectCommands(events: readonly unknown[]): { commands: WorkerCommandFact[]; issues: string[] } {
	const issues: string[] = [];
	const states: CommandState[] = [];
	const byCallId = new Map<string, CommandState>();
	const endedBeforeStart = new Set<string>();

	for (const [index, raw] of events.entries()) {
		if (!isRecord(raw)) continue;
		const parsed = parseWorkerToolExecutionEvent(raw);
		if (!parsed) {
			if (
				isShellToolName(raw.toolName) &&
				(raw.type === "tool_execution_start" || raw.type === "tool_execution_end")
			) {
				issues.push(`第 ${index + 1} 行 shell 工具事件字段损坏`);
			}
			continue;
		}
		if (!isShellToolName(parsed.toolName)) continue;

		if (parsed.type === "tool_execution_start") {
			const existing = byCallId.get(parsed.toolCallId);
			if (existing) {
				existing.conflicted = true;
				issues.push(`工具调用 ${parsed.toolCallId} 重复开始`);
				continue;
			}
			const command = isRecord(parsed.args) ? parsed.args.command : undefined;
			if (typeof command !== "string") {
				issues.push(`工具调用 ${parsed.toolCallId} 的 args.command 不是字符串`);
				continue;
			}
			const state: CommandState = {
				toolCallId: parsed.toolCallId,
				toolName: parsed.toolName,
				command,
				exitCode: null,
				completed: false,
				conflicted: endedBeforeStart.has(parsed.toolCallId),
				endSeen: false,
			};
			if (state.conflicted) issues.push(`工具调用 ${parsed.toolCallId} 在开始前已有结束事件`);
			states.push(state);
			byCallId.set(parsed.toolCallId, state);
			continue;
		}

		const state = byCallId.get(parsed.toolCallId);
		if (!state) {
			endedBeforeStart.add(parsed.toolCallId);
			issues.push(`工具调用 ${parsed.toolCallId} 的结束没有对应开始`);
			continue;
		}
		if (state.endSeen) {
			state.conflicted = true;
			issues.push(`工具调用 ${parsed.toolCallId} 重复结束`);
			continue;
		}
		if (state.toolName !== parsed.toolName) {
			state.conflicted = true;
			issues.push(`工具调用 ${parsed.toolCallId} 开始与结束的工具名不一致`);
			continue;
		}
		state.endSeen = true;
		state.completed = true;
		state.exitCode = structuredExitCode(parsed.result, `工具调用 ${parsed.toolCallId}`, issues);
	}

	for (const state of states) {
		if (!state.endSeen && !state.conflicted) issues.push(`工具调用 ${state.toolCallId} 未结束`);
	}
	return {
		commands: states
			.filter((state) => !state.conflicted)
			.map(({ toolCallId, toolName, command, exitCode, completed }) => ({
				toolCallId,
				toolName,
				command,
				exitCode,
				completed,
			})),
		issues,
	};
}

/**
 * 只读取既有 worker 证据中的程序执行命令事实，不写证据、不改卡，也不把结果当第二正本。
 * 身份不匹配或证据外壳损坏时不返回可能被误用的命令。
 */
export async function readWorkerExecutionFacts(
	evidencePath: string,
	expected: WorkerExecutionFactsExpectation,
): Promise<WorkerExecutionFactsResult> {
	let resolvedPath: string;
	let text: string;
	try {
		resolvedPath = await resolveWorkerEvidencePath(evidencePath);
		text = (await readWorkerEvidenceFile(resolvedPath)).toString("utf8");
	} catch (error) {
		return issue(`读取 worker 证据失败：${error instanceof Error ? error.message : String(error)}`);
	}

	const parsedLines: unknown[] = [];
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		try {
			parsedLines.push(JSON.parse(line));
		} catch (error) {
			return issue(
				`worker 证据第 ${index + 1} 行不是有效 JSON：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (parsedLines.length === 0) return issue("worker 证据为空");

	const envelope = validateEnvelope(parsedLines, expected);
	if (!envelope.valid) return { commands: [], complete: false, issues: envelope.issues };

	const commandFacts = collectCommands(parsedLines);
	return {
		commands: commandFacts.commands,
		complete: commandFacts.issues.length === 0,
		issues: commandFacts.issues,
	};
}
