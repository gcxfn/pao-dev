/** 压缩前保留任务原文；不推断哪些约束已经失效，不写入共享事实库。 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";

export interface TaskSnapshot {
	version: 1;
	items: { kind: "用户约束与待确认原文" | "工具错误" | "任务进展原文"; text: string; entryId: string }[];
}

function visibleText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export function captureTaskSnapshot(entries: readonly SessionEntry[], previous?: TaskSnapshot): TaskSnapshot {
	const items = [...(previous?.items ?? [])];
	let lastAssistant: TaskSnapshot["items"][number] | undefined;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const text = visibleText(entry.message);
		if (!text.trim()) continue;
		if (entry.message.role === "user") items.push({ kind: "用户约束与待确认原文", text, entryId: entry.id });
		else if (entry.message.role === "toolResult" && entry.message.isError)
			items.push({ kind: "工具错误", text, entryId: entry.id });
		else if (entry.message.role === "assistant") {
			lastAssistant = { kind: "任务进展原文", text, entryId: entry.id };
			// 保留明确未完成、确认、约束、诊断的段落；最后一次答复始终完整保留。
			const lines = text
				.split(/\r?\n/)
				.filter((line) =>
					/\[ \]|待办|待确认|未完成|未解决|阻塞|约束|必须|不得|TODO|pending|blocked|must not/i.test(line),
				);
			if (lines.length) items.push({ kind: "任务进展原文", text: lines.join("\n"), entryId: entry.id });
		}
	}
	if (lastAssistant) items.push(lastAssistant);
	const seen = new Set<string>();
	return {
		version: 1,
		items: items.filter((item) => {
			const key = `${item.kind}:${item.entryId}:${item.text}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		}),
	};
}

export function renderTaskSnapshot(snapshot: TaskSnapshot): string {
	return [
		"[本会话压缩前任务原文；不是共享用户事实。按原顺序保留，后来的用户纠正优先；助手进展是当时陈述，不等于验收通过。]",
		...snapshot.items.map((item) => `[${item.kind}；会话条目 ${item.entryId}]\n${item.text}`),
	].join("\n\n");
}

function isSnapshot(value: unknown): value is TaskSnapshot {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<TaskSnapshot>;
	return (
		candidate.version === 1 &&
		Array.isArray(candidate.items) &&
		candidate.items.every(
			(item) =>
				item &&
				typeof item.text === "string" &&
				typeof item.entryId === "string" &&
				["用户约束与待确认原文", "工具错误", "任务进展原文"].includes(item.kind),
		)
	);
}

export function registerTaskCompactionState(pi: ExtensionAPI): void {
	let snapshot: TaskSnapshot | undefined;
	let pending: TaskSnapshot | undefined;
	const restore = (ctx: ExtensionContext) => {
		snapshot = undefined;
		pending = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "pao-task-snapshot" && isSnapshot(entry.data))
				snapshot = entry.data;
		}
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", () => {
		snapshot = undefined;
		pending = undefined;
	});
	pi.on("session_before_compact", (event) => {
		pending = captureTaskSnapshot(event.branchEntries, snapshot);
	});
	pi.on("session_compact_failed", () => {
		pending = undefined;
	});
	pi.on("session_compact", () => {
		if (!pending) return;
		snapshot = pending;
		pending = undefined;
		pi.appendEntry("pao-task-snapshot", snapshot);
	});
	pi.on("context", (event) => {
		if (!snapshot?.items.length) return;
		return {
			messages: [
				...event.messages,
				{
					role: "custom" as const,
					customType: "pao-task-snapshot",
					content: renderTaskSnapshot(snapshot),
					display: false,
					timestamp: 0,
				},
			],
		};
	});
}
