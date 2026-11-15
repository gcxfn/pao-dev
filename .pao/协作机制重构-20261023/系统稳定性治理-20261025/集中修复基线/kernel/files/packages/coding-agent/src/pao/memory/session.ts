/** 会话内的实际召回与纠正记录；不建共享记忆副本、不改变已发送历史。 */
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { addPaoSubcommand } from "../command-router.ts";
import { checkOutbound, loadOutboundConfig, projectFromCwd } from "../knowledge/outbound.ts";
import { writeFileAtomic } from "../shared/atomic.ts";
import type { MemoryHit, MemoryVendor, MemoryVendorManager, MemoryWriteReceipt } from "./memory-vendor.ts";

export interface InjectedMemory extends MemoryHit {
	编号: number;
	供应商: string;
	作用范围: "本会话";
	注入时间: string;
	排除: boolean;
}

export const AUTO_RECALL_BODY_LIMIT = 2000;
export const AUTO_RECALL_HIT_LIMIT = 800;

export interface RecallSelection {
	hits: MemoryHit[];
	truncated: {
		hit?: { 记忆ID?: string; 原正文码点: number; 保留正文码点: number };
		因纠正排除: number;
		因当前上下文已有: number;
		因正文预算省略: number;
	};
}

function normalizeRecallText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

interface IdentityMemoryHit extends MemoryHit {
	__paoContentIdentity?: string;
}

function contentIdentity(hit: IdentityMemoryHit): string | undefined {
	if (hit.__paoContentIdentity) return hit.__paoContentIdentity;
	const normalized = normalizeRecallText(hit.内容);
	return normalized ? `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}` : undefined;
}

function visibleText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				Boolean(block) &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

interface RecallMessageDetails {
	hits?: MemoryHit[];
	vendor?: string;
	memories?: MemoryHit[];
	provider?: string;
}

function messageDetails(message: unknown): RecallMessageDetails | undefined {
	if (!message || typeof message !== "object") return;
	const details = (message as { details?: unknown }).details;
	return details && typeof details === "object" ? (details as RecallMessageDetails) : undefined;
}

interface RecallMessage {
	message: Record<string, unknown>;
	kind: "automatic" | "manual";
	vendor: string;
	hits: MemoryHit[];
}

function recallMessage(message: unknown): RecallMessage | undefined {
	if (!message || typeof message !== "object") return;
	const value = message as Record<string, unknown>;
	const details = messageDetails(value);
	if (value.role === "custom" && value.customType === "pao-auto-recall" && details?.hits && details.vendor) {
		return { message: value, kind: "automatic", vendor: details.vendor, hits: details.hits };
	}
	if (value.role === "toolResult" && value.toolName === "pao_memory_recall" && details?.memories && details.provider) {
		return { message: value, kind: "manual", vendor: details.provider, hits: details.memories };
	}
}

function sameRecallContent(hit: MemoryHit, content: string): boolean {
	const text = visibleText(content);
	if (!text) return false;
	const normalized = normalizeRecallText(hit.内容);
	return normalized.length > 0 && normalizeRecallText(text).includes(normalized);
}

function contextText(messages: readonly unknown[]): string {
	return messages
		.map((message) => visibleText((message as { content?: unknown })?.content))
		.filter((text) => text.length > 0)
		.join("\n");
}

export class SessionMemory {
	generation = 0;
	readonly injected: InjectedMemory[] = [];
	readonly corrections: string[] = [];
	private excluded = new Set<string>();
	key(hit: IdentityMemoryHit & { 供应商?: string }, vendor?: string): string {
		const provider = normalizeRecallText(vendor ?? hit.供应商 ?? "");
		return JSON.stringify([
			provider,
			hit.记忆ID?.trim() ? `id:${hit.记忆ID.trim()}` : `text:${contentIdentity(hit) ?? ""}`,
		]);
	}
	reset(): void {
		this.generation++;
		this.injected.length = 0;
		this.corrections.length = 0;
		this.excluded.clear();
	}
	snapshot(): unknown {
		return { version: 1, injected: this.injected, corrections: this.corrections, excluded: [...this.excluded] };
	}
	restore(value: unknown): void {
		if (!value || typeof value !== "object") throw new Error("会话记忆记录损坏");
		const saved = value as { version?: unknown; injected?: unknown; corrections?: unknown; excluded?: unknown };
		if (
			saved.version !== 1 ||
			!Array.isArray(saved.injected) ||
			!Array.isArray(saved.corrections) ||
			!Array.isArray(saved.excluded) ||
			!saved.corrections.every((x) => typeof x === "string") ||
			!saved.excluded.every((x) => typeof x === "string") ||
			!saved.injected.every(
				(x) => x && typeof x === "object" && typeof x.内容 === "string" && typeof x.编号 === "number",
			)
		)
			throw new Error("会话记忆记录损坏，不能假装恢复成功");
		this.reset();
		this.injected.push(...(saved.injected as InjectedMemory[]));
		this.corrections.push(...(saved.corrections as string[]));
		this.excluded = new Set(saved.excluded as string[]);
	}
	record(hits: MemoryHit[], vendor: string): MemoryHit[] {
		const seen = new Set<string>();
		const accepted = hits.filter((hit) => {
			const contentKey = this.key({ ...hit, 记忆ID: undefined }, vendor);
			if (this.isExcluded(hit, vendor) || seen.has(this.key(hit, vendor)) || seen.has(contentKey)) return false;
			seen.add(this.key(hit, vendor));
			seen.add(contentKey);
			return true;
		});
		for (const hit of accepted) {
			this.injected.push({
				...hit,
				编号: this.injected.length + 1,
				供应商: vendor,
				作用范围: "本会话",
				注入时间: new Date().toISOString(),
				排除: false,
			});
		}
		return accepted;
	}
	isExcluded(hit: IdentityMemoryHit, vendor: string): boolean {
		const keys = new Set([this.key(hit, vendor), this.key({ ...hit, 记忆ID: undefined }, vendor)]);
		// 旧版本无 ID 记录直接保存规范化正文；继续识别这类已持久化排除，避免升级后复活。
		keys.add(JSON.stringify([normalizeRecallText(vendor), `text:${normalizeRecallText(hit.内容)}`]));
		return [...keys].some((key) => this.excluded.has(key));
	}
	/** 按本轮最终上下文选择可追加的召回；过滤与字符预算都在发送前完成。 */
	selectForContext(
		hits: MemoryHit[],
		vendor: string,
		messages: readonly unknown[],
		residentText = "",
	): RecallSelection {
		const visibleMessages = this.filterVisibleMessages(messages);
		const selected: MemoryHit[] = [];
		const seen = new Set<string>();
		const existingKeys = new Set<string>();
		const truncated: RecallSelection["truncated"] = {
			因纠正排除: 0,
			因当前上下文已有: 0,
			因正文预算省略: 0,
		};
		const existing = visibleMessages.flatMap((message) => recallMessage(message) ?? []);
		for (const recall of existing) {
			for (const hit of recall.hits) {
				existingKeys.add(this.key(hit, recall.vendor));
				existingKeys.add(this.key({ ...hit, 记忆ID: undefined }, recall.vendor));
			}
		}
		let bodyChars = existing.reduce(
			(total, recall) =>
				recall.kind === "automatic"
					? total + recall.hits.reduce((sum, hit) => sum + Array.from(hit.内容).length, 0)
					: total,
			0,
		);
		const duplicateText = contextText(
			visibleMessages.filter((message) => {
				const recall = recallMessage(message);
				return !recall || recall.vendor === vendor;
			}),
		);
		const residentFacts = residentText
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("["));
		for (const rawHit of hits) {
			const hit: IdentityMemoryHit = {
				...rawHit,
				__paoContentIdentity:
					(rawHit as IdentityMemoryHit).__paoContentIdentity ??
					`sha256:${createHash("sha256").update(normalizeRecallText(rawHit.内容), "utf8").digest("hex")}`,
			};
			const key = this.key(hit, vendor);
			const contentKey = this.key({ ...hit, 记忆ID: undefined }, vendor);
			const normalized = normalizeRecallText(hit.内容);
			if (this.isExcluded(hit, vendor)) {
				truncated.因纠正排除++;
				continue;
			}
			if (seen.has(key) || seen.has(contentKey) || existingKeys.has(key) || existingKeys.has(contentKey)) {
				truncated.因当前上下文已有++;
				continue;
			}
			seen.add(key);
			seen.add(contentKey);
			const inContext =
				sameRecallContent(hit, duplicateText) ||
				(normalized.length > 0 && residentFacts.some((line) => line.includes(normalized)));
			if (inContext) {
				truncated.因当前上下文已有++;
				continue;
			}
			const chars = Array.from(hit.内容);
			const remaining = AUTO_RECALL_BODY_LIMIT - bodyChars;
			if (remaining <= 0) {
				truncated.因正文预算省略++;
				continue;
			}
			const keep = Math.min(chars.length, AUTO_RECALL_HIT_LIMIT, remaining);
			if (keep <= 0) {
				truncated.因正文预算省略++;
				continue;
			}
			const body = chars.slice(0, keep).join("");
			const limitNote =
				keep >= AUTO_RECALL_HIT_LIMIT && chars.length > AUTO_RECALL_HIT_LIMIT
					? `单条上限 ${AUTO_RECALL_HIT_LIMIT} 码点`
					: `累计正文上限 ${AUTO_RECALL_BODY_LIMIT} 码点`;
			selected.push({
				...hit,
				内容:
					keep < chars.length
						? `${body}\n[自动召回截断：原正文 ${chars.length} 码点，保留 ${keep} 码点；${limitNote}]`
						: body,
			});
			bodyChars += keep;
			if (keep < chars.length) {
				truncated.hit ??= { 记忆ID: hit.记忆ID, 原正文码点: chars.length, 保留正文码点: keep };
			}
		}
		return { hits: selected, truncated };
	}
	/**
	 * 只修改下一次模型可见副本，不改原始会话记录。
	 * 自动召回整块已无可用事实时删掉；手动工具结果须保留 toolCallId，改为明确的排除说明。
	 */
	filterVisibleMessages(messages: readonly unknown[]): unknown[] {
		return messages.flatMap((raw) => {
			const recall = recallMessage(raw);
			if (!recall) return [raw];
			const remaining = recall.hits.filter((hit) => !this.isExcluded(hit, recall.vendor));
			if (remaining.length === recall.hits.length) return [raw];
			if (remaining.length === 0) {
				if (recall.kind === "automatic") return [];
				return [
					{
						...recall.message,
						content: [
							{
								type: "text" as const,
								text: "[pao_memory_recall] 召回事实已被本会话纠正，内容不进入模型上下文。",
							},
						],
					},
				];
			}
			const text =
				recall.kind === "automatic"
					? [
							`[pao 自动召回] 当前可见 ${remaining.length} 条（其余已被本会话纠正）:`,
							...remaining.map((hit, index) => {
								const meta = [
									hit.记忆ID ? `记忆ID ${hit.记忆ID}` : undefined,
									hit.相关度 !== undefined ? `相关度 ${hit.相关度}` : undefined,
									hit.来源,
								].filter(Boolean);
								return `${index + 1}. ${hit.内容}${meta.length > 0 ? `（${meta.join("｜")}）` : ""}`;
							}),
						].join("\n")
					: [
							`召回 ${remaining.length} 条（其余已被本会话纠正）:`,
							...remaining.map((hit, index) => {
								const meta = [
									hit.记忆ID ? `记忆ID ${hit.记忆ID}` : undefined,
									hit.相关度 !== undefined ? `相关度 ${hit.相关度}` : undefined,
									hit.来源,
								].filter(Boolean);
								return `${index + 1}. ${hit.内容}${meta.length > 0 ? `（${meta.join("｜")}）` : ""}`;
							}),
						].join("\n");
			return [
				{
					...recall.message,
					content: recall.kind === "automatic" ? text : [{ type: "text" as const, text }],
					details: {
						...messageDetails(recall.message),
						...(recall.kind === "automatic" ? { hits: remaining } : { memories: remaining }),
					},
				},
			];
		});
	}
	exclude(hit: InjectedMemory, replacement?: string): void {
		this.excluded.add(this.key(hit));
		for (const previous of this.injected) if (this.key(previous) === this.key(hit)) previous.排除 = true;
		this.corrections.push(
			`此前召回“${hit.内容}”（ID：${hit.记忆ID ?? "未知"}）不再采用。${replacement ? `用户纠正为：${replacement}` : "后续不要以此作为事实依据。"} 已发送内容无法撤回。`,
		);
	}
	view(): string {
		if (!this.injected.length) return "本会话尚无实际注入的自动召回。记忆时间、置信度由供应商未提供时均为未知。";
		return this.injected
			.map(
				(hit) =>
					`${hit.编号}. ${hit.内容}\nID：${hit.记忆ID ?? "未知"}；来源：${hit.来源 ?? "未知"}；供应商：${hit.供应商}；作用范围：${hit.作用范围}；记忆时间：未知；置信度：未知；注入时间：${hit.注入时间}；${hit.排除 ? "后续排除，已发送不能撤回" : "已加入请求消息"}`,
			)
			.join("\n\n");
	}
}

const sessions = new WeakMap<ExtensionAPI, SessionMemory>();
export function sessionMemory(pi: ExtensionAPI): SessionMemory {
	let state = sessions.get(pi);
	if (!state) {
		state = new SessionMemory();
		sessions.set(pi, state);
	}
	return state;
}

export interface CorrectionResult {
	状态: "完成" | "部分成功";
	新记忆?: MemoryWriteReceipt;
	说明: string;
}

/** 两步更新的证据不能在忘旧失败时丢失。缺写入 ID 的供应商不删旧条。 */
export async function correctMemory(
	vendor: MemoryVendor,
	id: string,
	text: string,
	isCurrent: () => boolean = () => true,
): Promise<CorrectionResult> {
	if (!id.trim()) throw new Error("缺准确 ID，不能纠正共享记忆");
	if (!text.trim()) throw new Error("纠正内容不能为空");
	if (!vendor.capabilities.忘却 || !vendor.forget) throw new Error("供应商不支持忘却，未改共享记忆");
	if (!isCurrent()) throw new Error("会话已变化或操作已取消，未写共享记忆");
	const receipt = await vendor.write(text, ["用户纠正"]);
	if (!receipt) return { 状态: "部分成功", 说明: "新文已写入，但供应商未返回准确 ID；保留旧条，不能确认完整纠正。" };
	if (!isCurrent())
		return { 状态: "部分成功", 新记忆: receipt, 说明: "新文已写入，但会话已变化或操作已取消；旧条未删。" };
	if (receipt.记忆ID === id)
		return { 状态: "部分成功", 新记忆: receipt, 说明: "供应商返回旧 ID，无法证明已替代旧内容；未执行忘却。" };
	try {
		await vendor.forget(id);
		return { 状态: "完成", 新记忆: receipt, 说明: "新文写入后旧条已忘却（两步操作）。" };
	} catch (error) {
		return {
			状态: "部分成功",
			新记忆: receipt,
			说明: `新文已写入，旧条忘却失败：${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function registerMemoryCommand(
	pi: ExtensionAPI,
	getManager: () => MemoryVendorManager | undefined,
	home: () => string,
): void {
	const state = sessionMemory(pi);
	addPaoSubcommand(pi, {
		name: "memory",
		label: "记忆来源与纠正",
		description: "查看实际召回；排除只影响本会话，共享纠正与忘却需确认",
		run: async (_pi, args, rawCtx) => {
			const ctx = rawCtx as ExtensionCommandContext;
			if (!args.trim()) {
				ctx.ui.notify(state.view(), "info");
				return;
			}
			const match = /^(exclude|correct|forget)\s+(\d+)(?:\s+([\s\S]+))?$/.exec(args.trim());
			if (!match) {
				ctx.ui.notify(
					"用法：/pao memory；memory exclude 编号；memory correct 编号 新内容；memory forget 编号",
					"warning",
				);
				return;
			}
			const hit = state.injected.find((item) => item.编号 === Number(match[2]));
			if (!hit) {
				ctx.ui.notify("没有该注入编号；请先查看 /pao memory。", "warning");
				return;
			}
			if (match[1] === "exclude") {
				state.exclude(hit);
				pi.appendEntry("pao-memory-state", state.snapshot());
				ctx.ui.notify("本会话后续不再采用此条；已发送内容不能撤回。", "info");
				return;
			}
			if (!hit.记忆ID) {
				ctx.ui.notify("来源未提供准确 ID，不能修改或忘却共享记忆。", "warning");
				return;
			}
			const replacement = match[1] === "correct" ? match[3]?.trim() : undefined;
			if (match[1] === "correct" && !replacement) {
				ctx.ui.notify("纠正内容不能为空。", "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("共享修改需要可交互确认；本次未执行。", "warning");
				return;
			}
			const generation = state.generation;
			const originalSessionId = ctx.sessionManager.getSessionId();
			const current = () =>
				generation === state.generation &&
				ctx.sessionManager.getSessionId() === originalSessionId &&
				!ctx.signal?.aborted;
			const confirmed = await ctx.ui.confirm(
				"确认共享记忆修改",
				`原文：${hit.内容}\n新文：${replacement ?? "（忘却）"}\n准确 ID：${hit.记忆ID}\n影响：供应商共享库，其他会话也可能受影响。${replacement ? "先写新再忘旧，两步可能部分成功。" : ""}`,
			);
			if (!confirmed) {
				ctx.ui.notify("已取消，未修改共享记忆。", "info");
				return;
			}
			if (!current()) {
				ctx.ui.notify("会话已切换，旧确认失效；未修改共享记忆。", "warning");
				return;
			}
			try {
				const project = projectFromCwd(ctx.cwd);
				const check = checkOutbound(project ? [project] : [], loadOutboundConfig(home()));
				if (!check.allowed) throw new Error("当前项目未获外发许可，未修改共享记忆");
				const vendor = await getManager()?.acquire();
				if (!current()) throw new Error("会话已切换或操作已取消，未修改共享记忆。");
				if (!vendor) throw new Error("记忆供应商未启用或不可用");
				if (vendor.vendorName !== hit.供应商)
					throw new Error("当前供应商与此条来源不同，未修改；请从当前供应商重新召回后操作。");
				if (!vendor.capabilities.忘却 || !vendor.forget) throw new Error("供应商不支持忘却，未修改共享记忆");
				if (replacement) {
					const result = await correctMemory(vendor, hit.记忆ID, replacement, current);
					if (!current()) {
						const evidence = join(ctx.cwd, ".pao", "记忆操作", `${randomUUID()}.json`);
						writeFileAtomic(
							evidence,
							JSON.stringify({ sessionId: originalSessionId, oldId: hit.记忆ID, result }, null, 2),
						);
						ctx.ui.notify(`原会话的记忆操作返回：${result.说明}。未注入当前会话。证据：${evidence}`, "warning");
						return;
					}
					state.exclude(hit, replacement);
					pi.appendEntry("pao-memory-state", state.snapshot());
					pi.appendEntry("pao-memory-correction", { oldId: hit.记忆ID, result });
					ctx.ui.notify(
						`${result.状态}：${result.说明} 新 ID：${result.新记忆?.记忆ID ?? "未知"}`,
						result.状态 === "完成" ? "info" : "warning",
					);
				} else {
					const count = await vendor.forget(hit.记忆ID);
					if (!current()) {
						const evidence = join(ctx.cwd, ".pao", "记忆操作", `${randomUUID()}.json`);
						writeFileAtomic(
							evidence,
							JSON.stringify({ sessionId: originalSessionId, oldId: hit.记忆ID, forgotten: count }, null, 2),
						);
						ctx.ui.notify(`原会话忘却已返回，未注入当前会话。证据：${evidence}`, "warning");
						return;
					}
					state.exclude(hit);
					pi.appendEntry("pao-memory-state", state.snapshot());
					ctx.ui.notify("已执行忘却；已发送内容无法撤回。", "info");
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
