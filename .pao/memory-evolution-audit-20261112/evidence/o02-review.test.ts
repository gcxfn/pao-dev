/** O02 完成情况复核：模型与嵌入为离线夹具；存储/SQLite/service/commit/调度为真实实现。 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../../../PAO/packages/coding-agent/src/core/extensions/types.ts";
import { SessionManager } from "../../../PAO/packages/coding-agent/src/core/session-manager.ts";
import { createCapture } from "../../../PAO/packages/coding-agent/src/pao/memory/capture.ts";
import { commitExtractionCandidates } from "../../../PAO/packages/coding-agent/src/pao/memory/extract-commit.ts";
import {
	advanceCursor,
	createJob,
	recoverJobs,
} from "../../../PAO/packages/coding-agent/src/pao/memory/extraction-jobs.ts";
import { registerExtractionScheduler } from "../../../PAO/packages/coding-agent/src/pao/memory/extraction-scheduler.ts";
import { requestExtraction } from "../../../PAO/packages/coding-agent/src/pao/memory/extract-model.ts";
import { openMemoryService } from "../../../PAO/packages/coding-agent/src/pao/memory/service.ts";
import {
	BUILTIN_PROVIDER,
	bindBuiltinMemoryService,
	registerMemoryCommand,
	sessionMemory,
} from "../../../PAO/packages/coding-agent/src/pao/memory/session.ts";
import { registerBuiltinMemory } from "../../../PAO/packages/coding-agent/src/pao/memory/tools.ts";
import { registerSource } from "../../../PAO/packages/coding-agent/src/pao/memory/sources.ts";
import { type MemoryStore, openMemoryStore } from "../../../PAO/packages/coding-agent/src/pao/memory/store.ts";
import { listPaoSubcommands } from "../../../PAO/packages/coding-agent/src/pao/command-router.ts";
import { assistantMsg, userMsg } from "../../../PAO/packages/coding-agent/test/utilities.ts";
import { fauxAssistantMessage } from "../../../PAO/packages/ai/src/index.ts";
import type {
	CommitSourceRef,
	ExtractionSourceEntry,
	ExtractModelInput,
	ExtractModelOutput,
	MemoryScope,
	MemoryService,
	RelatedMemorySummary,
	ValidatedCandidate,
} from "../../../PAO/packages/coding-agent/src/pao/memory/types.ts";
import type { ToolDefinition } from "../../../PAO/packages/coding-agent/src/core/extensions/types.ts";
import type { TierConfig } from "../../../PAO/packages/coding-agent/src/pao/routing/config.ts";

// ════════════════════════════════════════════════════════════════════════
// 顶层 mock：让 extraction-scheduler.ts 内的静态 requestExtraction 指向夹具。
// 必须在 import 链建立前生效——静态 import 会在收集时就把提取器绑定到真实现。
// ════════════════════════════════════════════════════════════════════════
const requestState = vi.hoisted(() => ({
	handle: undefined as ((deps: unknown, input: ExtractModelInput) => Promise<ExtractModelOutput>) | undefined,
}));
vi.mock("../../../PAO/packages/coding-agent/src/pao/memory/extract-model.ts", async (importOriginal) => {
	const actual = await importOriginal<
		typeof import("../../../PAO/packages/coding-agent/src/pao/memory/extract-model.ts")
	>();
	return {
		...actual,
		requestExtraction: (deps: unknown, input: ExtractModelInput) => {
			// 未安装夹具时回真实实现——R5/R6 直接调 requestExtraction 走真校验。
			if (requestState.handle === undefined) {
				return (actual.requestExtraction as (d: unknown, i: ExtractModelInput) => Promise<ExtractModelOutput>)(deps, input);
			}
			return requestState.handle(deps, input);
		},
	};
});

// ════════════════════════════════════════════════════════════════════════
// 夹具
// ════════════════════════════════════════════════════════════════════════
const dir = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
const closers: (() => unknown | Promise<unknown>)[] = [];
const resultsPath = join(dir, "o02-review-results.json");
const results: any[] = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")).results : [];
const AT = "2026-11-13T10:00:00.000Z";
const AT2 = "2026-11-13T10:01:00.000Z";
const AT3 = "2026-11-13T10:02:00.000Z";
const SCOPE: MemoryScope = { projectId: "proj-o02-review" };
const TIER = {
	provider: "pao",
	档位: [{ 名: "快", provider: "test", model: "m", thinkingLevel: "off" }],
} as TierConfig;

function home() {
	const root = mkdtempSync(join(dir, "o02-fixture-"));
	roots.push(root);
	return root;
}
function ok<T extends { ok: boolean }>(value: T): T {
	if (!value.ok) throw new Error(JSON.stringify(value));
	return value;
}
function usage() {
	return { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10,
		cost: { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 } };
}
function registry(reply: string) {
	return { find: () => ({}), streamSimple: () => ({ result: async () => ({
		...fauxAssistantMessage(reply), provider: "test", model: "m", responseModel: "m", usage: usage(),
	}) }) } as never;
}
function ledger() {
	return { appendUsage: () => ({}) as never, appendCustomEntry: () => ({}) as never };
}
function record(id: string, detail: unknown) {
	const previous = results.findIndex((item) => item.id === id);
	if (previous !== -1) results.splice(previous, 1);
	results.push({ id, detail });
}
afterEach(async () => {
	requestState.handle = undefined;
	for (const close of closers.splice(0).reverse()) await close();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	writeFileSync(resultsPath, JSON.stringify({ node: process.version, results }, null, 2));
	for (const root of roots.splice(0)) {
		for (let attempt = 0; attempt < 5; attempt++) {
			try { rmSync(root, { recursive: true, force: true }); break; }
			catch { if (attempt === 4) throw new Error(`清理失败:${root}`); await new Promise((r) => setTimeout(r, 50)); }
		}
	}
});

/** 在 sources 表登记一条来源；eventType 可指定（默认 user）。 */
function seedSource(
	store: MemoryStore,
	over: { sessionId?: string; entryId?: string; eventType?: string; capturedAt?: string; content?: string } = {},
): { sourceId: string; ref: CommitSourceRef; entry: ExtractionSourceEntry } {
	const sessionId = over.sessionId ?? "sess-1";
	const entryId = over.entryId ?? `e-${Math.random().toString(36).slice(2, 8)}`;
	const eventType = over.eventType ?? "user";
	const content = over.content ?? "用户拍板：内置记忆存储就用 SQLite，不要常驻服务。";
	const sourceId = registerSource(store.db, { sessionId, entryId, eventType, capturedAt: over.capturedAt ?? AT });
	return {
		sourceId,
		ref: { sourceId, sessionId, entryId, eventType },
		entry: { sourceId, entryId, eventType, content },
	};
}
/** 造合法候选；spanText 必须是来源 content 的真实子串才能过定位。 */
function candidate(over: Partial<ValidatedCandidate> & { sourceId: string }): ValidatedCandidate {
	const { sourceId, ...rest } = over;
	return {
		kind: "decision",
		conclusion: "内置记忆存储使用 SQLite",
		conditions: "不要常驻服务",
		rationale: "单机维护成本低",
		evidenceKind: "user_statement",
		confirmation: "confirmed",
		sourceIds: [sourceId],
		quotedSpans: [{ sourceId, text: "SQLite" }],
		spanLocations: [{ sourceId, match: "exact", offset: 0 }],
		...rest,
	};
}
async function relatedSnapshot(service: MemoryService, memoryId: string): Promise<RelatedMemorySummary> {
	const got = await service.getMemory({ id: memoryId });
	if (!got.ok) throw new Error(got.error.message);
	return {
		memoryId: got.memory.id,
		kind: got.memory.kind,
		currentRevision: got.memory.currentRevision,
		conclusion: got.memory.content.conclusion,
		...(got.memory.content.conditions === undefined ? {} : { conditions: got.memory.content.conditions }),
		confirmation: got.memory.content.confirmation,
		usageState: got.memory.usageState,
	};
}
function commit(
	store: MemoryStore,
	service: MemoryService,
	candidates: ValidatedCandidate[],
	sourceRefs: CommitSourceRef[],
	relatedMemories: RelatedMemorySummary[] = [],
	scope: MemoryScope = SCOPE,
	jobId = "job-1",
	now = AT,
) {
	return commitExtractionCandidates(store, service, { jobId, scope, candidates, relatedMemories, sourceRefs, now });
}
function revisionSourceIds(store: MemoryStore, memoryId: string, revision: number): string[] {
	return (store.db
		.prepare(`SELECT source_id FROM memory_source_links WHERE memory_id = ? AND revision = ? ORDER BY source_id`)
		.all(memoryId, revision) as Array<{ source_id: string }>).map((row) => row.source_id);
}
function currentContent(store: MemoryStore, memoryId: string): Record<string, unknown> {
	const row = store.db.prepare(
		`SELECT r.content_json FROM memories m JOIN memory_revisions r ON r.memory_id = m.id AND r.revision = m.current_revision WHERE m.id = ?`,
	).get(memoryId) as { content_json: string } | undefined;
	return row === undefined ? {} : (JSON.parse(row.content_json) as Record<string, unknown>);
}
function memoryRow(store: MemoryStore, memoryId: string) {
	return store.db.prepare(`SELECT id, current_revision, usage_state FROM memories WHERE id = ?`).get(memoryId) as
		| { id: string; current_revision: number; usage_state: string }
		| undefined;
}
function revisionContent(store: MemoryStore, memoryId: string, revision: number): Record<string, unknown> {
	const row = store.db
		.prepare(`SELECT content_json FROM memory_revisions WHERE memory_id = ? AND revision = ?`)
		.get(memoryId, revision) as { content_json: string } | undefined;
	return row === undefined ? {} : (JSON.parse(row.content_json) as Record<string, unknown>);
}
async function waitFor(check: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("等待超时");
}

// ════════════════════════════════════════════════════════════════════════
// R1：tentative→confirmed 升级——corrected、并集来源、createMemory 未调
// ════════════════════════════════════════════════════════════════════════
describe("O02-R1：tentative→confirmed 确认升级", () => {
	it("同结论同条件候选 confirmed → corrected 修订，来源并集，createMemory 未被调用", async () => {
		const root = home();
		const store = openMemoryStore(root, "readwrite");
		const service = openMemoryService({ paoHome: root, mode: "readwrite" });
		closers.push(async () => { await service.close(); store.close(); });

		const s1 = seedSource(store, { entryId: "e-old" });
		const first = await commit(store, service, [candidate({ sourceId: s1.sourceId, confirmation: "tentative" })], [s1.ref]);
		expect(first.outcomes[0].status).toBe("submitted");
		const memoryId = (first.outcomes[0] as { memoryId: string }).memoryId;
		expect(currentContent(store, memoryId).confirmation).toBe("tentative");

		const s2 = seedSource(store, { sessionId: "sess-2", entryId: "e-confirm", capturedAt: AT2 });
		const createSpy = vi.spyOn(service, "createMemory");
		const second = await commit(store, service, [
			candidate({ sourceId: s2.sourceId, confirmation: "confirmed" }),
		], [s2.ref], [await relatedSnapshot(service, memoryId)], SCOPE, "job-2", AT2);

		record("R1", { first: first.outcomes, second: second.outcomes, memoryId });
		expect(second.outcomes[0]).toMatchObject({ status: "corrected", memoryId, revision: 2 });
		expect(second.corrected).toBe(1);
		expect(createSpy).not.toHaveBeenCalled();
		expect(memoryRow(store, memoryId)?.current_revision).toBe(2);
		expect(currentContent(store, memoryId).confirmation).toBe("confirmed");
		expect(revisionContent(store, memoryId, 1).confirmation).toBe("tentative");
		expect(revisionSourceIds(store, memoryId, 2).sort()).toEqual([s1.sourceId, s2.sourceId].sort());
	});
});

// ════════════════════════════════════════════════════════════════════════
// R2：rationale 变化 → semantic_conflict + 游标不推进
// ════════════════════════════════════════════════════════════════════════
describe("O02-R2：rationale 变化 → semantic_conflict + 游标不推进", () => {
	it("commit 层：同结论同条件 rationale 不同 → skipped/semantic_conflict", async () => {
		const root = home();
		const store = openMemoryStore(root, "readwrite");
		const service = openMemoryService({ paoHome: root, mode: "readwrite" });
		closers.push(async () => { await service.close(); store.close(); });

		const s1 = seedSource(store, { entryId: "e-old" });
		const first = await commit(store, service, [candidate({ sourceId: s1.sourceId })], [s1.ref]);
		const memoryId = (first.outcomes[0] as { memoryId: string }).memoryId;

		const s2 = seedSource(store, { sessionId: "sess-2", entryId: "e-rationale", capturedAt: AT2 });
		const second = await commit(store, service, [
			candidate({ sourceId: s2.sourceId, rationale: "换了个理由" }),
		], [s2.ref], [await relatedSnapshot(service, memoryId)], SCOPE, "job-2", AT2);

		record("R2-commit", second.outcomes);
		expect(second.outcomes[0]).toMatchObject({ status: "skipped", reason: "semantic_conflict", memoryId });
		expect(second.submitted).toBe(0);
		expect(memoryRow(store, memoryId)?.current_revision).toBe(1);
		expect(currentContent(store, memoryId).rationale).toBe("单机维护成本低");
	});

	it("调度层：semantic_conflict 候选使 job 标 needsReevaluation 且游标不推进", async () => {
		const root = home();
		const store = openMemoryStore(root, "readwrite");
		const service = openMemoryService({ paoHome: root, mode: "readwrite" });
		closers.push(async () => { await service.close(); store.close(); });

		const sessionId = "sess-o02-r2";
		const manager = SessionManager.create(root, join(root, "agent", "sessions"), { id: sessionId });
		const entryId = manager.appendMessage(userMsg("理由变化触发重评估"));
		const capture = createCapture({ store, paoHome: root, now: () => AT });
		capture.registerSession(sessionId, manager.getSessionFile()!);
		const triggerSourceId = capture.captureCommittedEntry(sessionId, manager.getEntry(entryId)!, undefined, AT).sourceId!;

		const old = await service.createMemory({
			kind: "decision",
			scope: { ...SCOPE, sessionId },
			conclusion: "内置记忆存储使用 SQLite",
			conditions: "不要常驻服务",
			rationale: "旧理由",
			evidenceKind: "user_statement",
			confirmation: "confirmed",
			sourceIds: [triggerSourceId],
			createdBy: "user",
			createdAt: AT,
		});
		if (!old.ok) throw new Error(old.error.message);

		const job = createJob(store, {
			sourceScope: JSON.stringify({ sessionId, projectId: SCOPE.projectId }),
			scopeKey: `session:${sessionId}`,
			createdAt: AT,
		});
		advanceCursor(store, { jobId: job.jobId, cursor: "cursor-before-conflict", advancedAt: AT });

		requestState.handle = async () => ({
			candidates: [candidate({ sourceId: triggerSourceId, rationale: "新理由与旧不同" })],
			rejected: [],
			requestId: "req-o02-r2",
		});
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const pi = { on(event: string, h: (e: unknown, c: ExtensionContext) => unknown) { handlers.set(event, h); return () => handlers.delete(event); } } as unknown as ExtensionAPI;
		const unmount = registerExtractionScheduler(pi, {
			store, service, paoHome: root,
			ledger: ledger() as never,
			resolveScope: () => ({ ...SCOPE, sessionId }),
			now: () => AT,
		});
		const ctx = { sessionManager: manager, cwd: root, modelRegistry: {} } as unknown as ExtensionContext;
		try {
			await handlers.get("turn_end")?.({}, ctx);
			await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
			await waitFor(() => {
				const row = store.db.prepare(`SELECT status FROM extraction_jobs WHERE job_id = ?`).get(job.jobId) as { status: string } | undefined;
				return row?.status === "failed";
			});
			const jobRow = store.db
				.prepare(`SELECT status, cursor, last_error FROM extraction_jobs WHERE job_id = ?`).get(job.jobId) as
				{ status: string; cursor: string | null; last_error: string | null };
			record("R2-scheduler", jobRow);
			expect(jobRow.status).toBe("failed");
			expect(jobRow.last_error).toContain("stale_request_snapshot:");
			expect(jobRow.last_error).toContain("语义冲突候选需重新评估");
			expect(jobRow.last_error).toContain("rationaleChanged");
			expect(jobRow.cursor).toBe("cursor-before-conflict");
			const recovered = recoverJobs(store, AT2);
			expect(recovered.recovered.map((j) => j.jobId)).not.toContain(job.jobId);
			expect(currentContent(store, old.id).rationale).toBe("旧理由");
		} finally {
			unmount();
		}
	});
});

// ════════════════════════════════════════════════════════════════════════
// R3：confirmed→tentative 反向降级 → semantic_conflict
// ════════════════════════════════════════════════════════════════════════
describe("O02-R3：confirmed→tentative 反向降级", () => {
	it("库中 confirmed + 候选 tentative 同结论同条件 → skipped/semantic_conflict，不静默降级", async () => {
		const root = home();
		const store = openMemoryStore(root, "readwrite");
		const service = openMemoryService({ paoHome: root, mode: "readwrite" });
		closers.push(async () => { await service.close(); store.close(); });

		const s1 = seedSource(store, { entryId: "e-old" });
		const first = await commit(store, service, [candidate({ sourceId: s1.sourceId, confirmation: "confirmed" })], [s1.ref]);
		const memoryId = (first.outcomes[0] as { memoryId: string }).memoryId;

		const s2 = seedSource(store, { sessionId: "sess-2", entryId: "e-down", capturedAt: AT2 });
		const second = await commit(store, service, [
			candidate({ sourceId: s2.sourceId, confirmation: "tentative" }),
		], [s2.ref], [await relatedSnapshot(service, memoryId)], SCOPE, "job-2", AT2);

		record("R3", second.outcomes);
		expect(second.outcomes[0]).toMatchObject({ status: "skipped", reason: "semantic_conflict", memoryId });
		expect(currentContent(store, memoryId).confirmation).toBe("confirmed");
		expect(memoryRow(store, memoryId)?.current_revision).toBe(1);
	});
});

// ════════════════════════════════════════════════════════════════════════
// R4：同结论异条件 → flagged；新修订来源 = 旧 ∪ 触发
// ════════════════════════════════════════════════════════════════════════
describe("O02-R4：同结论异条件 → flagged 且来源并集", () => {
	it("条件不同触发重议；标记修订来源 = 旧来源 ∪ 本次触发来源", async () => {
		const root = home();
		const store = openMemoryStore(root, "readwrite");
		const service = openMemoryService({ paoHome: root, mode: "readwrite" });
		closers.push(async () => { await service.close(); store.close(); });

		const s1 = seedSource(store, { entryId: "e-old" });
		const first = await commit(store, service, [candidate({ sourceId: s1.sourceId })], [s1.ref]);
		const memoryId = (first.outcomes[0] as { memoryId: string }).memoryId;

		const s2 = seedSource(store, { sessionId: "sess-2", entryId: "e-new-cond", capturedAt: AT2 });
		const second = await commit(store, service, [
			candidate({ sourceId: s2.sourceId, conditions: "现在允许多机部署" }),
		], [s2.ref], [await relatedSnapshot(service, memoryId)], SCOPE, "job-2", AT2);

		record("R4", second.outcomes);
		expect(second.outcomes[0]).toMatchObject({ status: "flagged", memoryId });
		expect(revisionSourceIds(store, memoryId, 2).sort()).toEqual([s1.sourceId, s2.sourceId].sort());
		expect(revisionSourceIds(store, memoryId, 1)).toEqual([s1.sourceId]);
		expect(currentContent(store, memoryId).needsReDiscussion).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════════════
// R5：confirmed 证据身份闭合（validateCandidate 三路拒绝）
// ════════════════════════════════════════════════════════════════════════
describe("O02-R5：confirmed 证据身份", () => {
	it("confirmed/user_statement 但来源全是 toolResult → rejected", async () => {
		const root = home();
		const store = openMemoryStore(root, "readwrite");
		closers.push(() => store.close());
		const s = seedSource(store, { eventType: "toolResult", content: "测试通过：SQLite 可用" });
		const reply = JSON.stringify([{
			kind: "decision", conclusion: "用户拍板用 SQLite", evidenceKind: "user_statement",
			confirmation: "confirmed", sourceIds: [s.sourceId],
			quotedSpans: [{ sourceId: s.sourceId, text: "SQLite" }],
		}]);
		const out = await requestExtraction(
			{ modelRegistry: registry(reply), ledger: ledger() as never, tierConfig: TIER, paoHome: root },
			{ jobId: "j-r5a", sourceSessionId: "sess-1", entries: [s.entry] },
		);
		record("R5a", { rejected: out.ok ? out.rejected : out });
		expect(out.ok && out.candidates).toHaveLength(0);
		expect(out.ok && out.rejected[0].reasons.join()).toContain("eventType=user");
	});

	it("confirmed/user_statement 但 quotedSpan 挂 assistant 条目 → rejected", async () => {
		const root = home();
		const store = openMemoryStore(root, "readwrite");
		closers.push(() => store.close());
		const userS = seedSource(store, { eventType: "user", entryId: "e-user", content: "先不定" });
		const asstS = seedSource(store, { eventType: "assistant", entryId: "e-asst", content: "正式选用 SQLite" });
		const reply = JSON.stringify([{
			kind: "decision", conclusion: "正式选用 SQLite", evidenceKind: "user_statement",
			confirmation: "confirmed", sourceIds: [userS.sourceId, asstS.sourceId],
			quotedSpans: [{ sourceId: asstS.sourceId, text: "正式选用 SQLite" }],
		}]);
		const out = await requestExtraction(
			{ modelRegistry: registry(reply), ledger: ledger() as never, tierConfig: TIER, paoHome: root },
			{ jobId: "j-r5b", sourceSessionId: "sess-1", entries: [userS.entry, asstS.entry] },
		);
		record("R5b", { rejected: out.ok ? out.rejected : out });
		expect(out.ok && out.candidates).toHaveLength(0);
		expect(out.ok && out.rejected.length).toBeGreaterThan(0);
	});

	it("quotedSpan sourceId 不在 candidate.sourceIds 内 → rejected", async () => {
		const root = home();
		const store = openMemoryStore(root, "readwrite");
		closers.push(() => store.close());
		const s1 = seedSource(store, { eventType: "user", entryId: "e-1", content: "采用 SQLite" });
		const s2 = seedSource(store, { eventType: "user", entryId: "e-2", content: "另一段原文" });
		const reply = JSON.stringify([{
			kind: "decision", conclusion: "采用 SQLite", evidenceKind: "user_statement",
			confirmation: "confirmed", sourceIds: [s1.sourceId],
			quotedSpans: [{ sourceId: s2.sourceId, text: "另一段原文" }],
		}]);
		const out = await requestExtraction(
			{ modelRegistry: registry(reply), ledger: ledger() as never, tierConfig: TIER, paoHome: root },
			{ jobId: "j-r5c", sourceSessionId: "sess-1", entries: [s1.entry, s2.entry] },
		);
		record("R5c", { rejected: out.ok ? out.rejected : out });
		expect(out.ok && out.candidates).toHaveLength(0);
		expect(out.ok && out.rejected[0].reasons.join()).toContain("未列入 sourceIds");
	});
});

// ════════════════════════════════════════════════════════════════════════
// R6：confirmed/execution + toolResult 通过；只有 user 来源 → rejected
// ════════════════════════════════════════════════════════════════════════
describe("O02-R6：confirmed/execution 对偶面", () => {
	it("confirmed/execution + toolResult 来源 → 通过", async () => {
		const root = home();
		const store = openMemoryStore(root, "readwrite");
		closers.push(() => store.close());
		const s = seedSource(store, { eventType: "toolResult", content: "迁移脚本执行成功：SQLite 表已建" });
		const reply = JSON.stringify([{
			kind: "experience", conclusion: "SQLite 迁移脚本可建表", evidenceKind: "execution",
			confirmation: "confirmed", sourceIds: [s.sourceId],
			quotedSpans: [{ sourceId: s.sourceId, text: "SQLite 表已建" }],
		}]);
		const out = await requestExtraction(
			{ modelRegistry: registry(reply), ledger: ledger() as never, tierConfig: TIER, paoHome: root },
			{ jobId: "j-r6a", sourceSessionId: "sess-1", entries: [s.entry] },
		);
		record("R6a", { candidates: out.ok ? out.candidates.length : 0, rejected: out.ok ? out.rejected : out });
		expect(out.ok && out.rejected).toHaveLength(0);
		expect(out.ok && out.candidates).toHaveLength(1);
	});

	it("confirmed/execution + 只有 user 来源 → rejected", async () => {
		const root = home();
		const store = openMemoryStore(root, "readwrite");
		closers.push(() => store.close());
		const s = seedSource(store, { eventType: "user", content: "测试证明 SQLite 可用" });
		const reply = JSON.stringify([{
			kind: "experience", conclusion: "测试证明 SQLite 可用", evidenceKind: "execution",
			confirmation: "confirmed", sourceIds: [s.sourceId],
			quotedSpans: [{ sourceId: s.sourceId, text: "SQLite" }],
		}]);
		const out = await requestExtraction(
			{ modelRegistry: registry(reply), ledger: ledger() as never, tierConfig: TIER, paoHome: root },
			{ jobId: "j-r6b", sourceSessionId: "sess-1", entries: [s.entry] },
		);
		record("R6b", { rejected: out.ok ? out.rejected : out });
		expect(out.ok && out.candidates).toHaveLength(0);
		expect(out.ok && out.rejected[0].reasons.join()).toContain("eventType=toolResult");
	});
});

// ════════════════════════════════════════════════════════════════════════
// R7：pao_memory_write 带 correct_id——同一 ID 新修订、字段沿用、createMemory 未调；
//     correct_id 不存在/expected_revision 不匹配 → 失败
// ════════════════════════════════════════════════════════════════════════
describe("O02-R7：工具 correct_id 纠正", () => {
	async function setupToolCase(sessionId: string, paoHome: string) {
		const tools = new Map<string, ToolDefinition>();
		const pi = {
			registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
			on() { return () => undefined; },
			registerCommand() { return () => undefined; },
		} as unknown as ExtensionAPI;
		const manager = SessionManager.create(paoHome, join(paoHome, "agent", "sessions"), { id: sessionId });
		manager.appendMessage(userMsg("背景"));
		const assistant = assistantMsg("写入纠正");
		(assistant as Record<string, unknown>).content = [
			{ type: "toolCall", id: "call-correct", name: "pao_memory_write", arguments: { content: "correct" } },
		];
		manager.appendMessage(assistant);
		const ctx = { cwd: paoHome, sessionManager: manager, modelRegistry: { find: () => undefined } } as unknown as ExtensionContext;
		const registration = registerBuiltinMemory(pi, { paoHome });
		closers.push(() => registration.close());
		return { tools, ctx, manager, registration };
	}

	it("带 correct_id → 同一 ID 新修订，旧 conditions/rationale 保留，createMemory 未被调用", async () => {
		const root = home();
		const { tools, ctx, registration } = await setupToolCase("sess-tool-correct", root);
		const store = openMemoryStore(root, "readwrite");
		closers.push(() => store.close());
		const s = seedSource(store, { sessionId: "sess-tool-correct", entryId: "e-origin" });
		const created = await registration.service.createMemory({
			kind: "decision", scope: { projectId: "proj-tool", sessionId: "sess-tool-correct" },
			conclusion: "旧结论", conditions: "原条件", rationale: "原理由",
			evidenceKind: "user_statement", confirmation: "confirmed",
			sourceIds: [s.sourceId], createdBy: "user", createdAt: AT,
		});
		if (!created.ok) throw new Error(created.error.message);
		const createSpy = vi.spyOn(registration.service, "createMemory");
		const corrected = await tools.get("pao_memory_write")!.execute(
			"call-correct",
			{ content: "新结论", correct_id: created.id, expected_revision: 1 } as never,
			undefined, undefined, ctx,
		);
		record("R7", { corrected, createSpyCalls: createSpy.mock.calls.length });
		expect(corrected.isError).not.toBe(true);
		expect(createSpy).not.toHaveBeenCalled();
		expect(memoryRow(store, created.id)?.current_revision).toBe(2);
		expect(currentContent(store, created.id).conclusion).toBe("新结论");
		expect(currentContent(store, created.id).conditions).toBe("原条件");
		expect(currentContent(store, created.id).rationale).toBe("原理由");
		expect(revisionSourceIds(store, created.id, 2)).toContain(s.sourceId);
		expect((store.db.prepare(`SELECT COUNT(*) AS c FROM memories`).get() as { c: number }).c).toBe(1);
	});

	it("correct_id 不存在 → 如实失败（isError）", async () => {
		const root = home();
		const { tools, ctx } = await setupToolCase("sess-tool-missing", root);
		const result = await tools.get("pao_memory_write")!.execute(
			"call-correct",
			{ content: "新结论", correct_id: "nonexistent-id" } as never,
			undefined, undefined, ctx,
		);
		record("R7-missing", result);
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("记忆纠正失败");
	});

	it("expected_revision 不匹配 → 如实失败（修订号已变）", async () => {
		const root = home();
		const { tools, ctx, registration } = await setupToolCase("sess-tool-stale", root);
		const store = openMemoryStore(root, "readwrite");
		closers.push(() => store.close());
		const s = seedSource(store, { sessionId: "sess-tool-stale", entryId: "e-origin" });
		const created = await registration.service.createMemory({
			kind: "decision", scope: { projectId: "proj-tool", sessionId: "sess-tool-stale" },
			conclusion: "旧结论", evidenceKind: "user_statement", confirmation: "confirmed",
			sourceIds: [s.sourceId], createdBy: "user", createdAt: AT,
		});
		if (!created.ok) throw new Error(created.error.message);
		await registration.service.correctMemory({
			id: created.id, expectedRevision: 1,
			replacement: { conclusion: "中间修订", evidenceKind: "user_statement", confirmation: "confirmed" },
			source: { sessionId: "sess-tool-stale" }, createdAt: AT2,
		});
		const result = await tools.get("pao_memory_write")!.execute(
			"call-correct",
			{ content: "迟到纠正", correct_id: created.id, expected_revision: 1 } as never,
			undefined, undefined, ctx,
		);
		record("R7-stale", result);
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("修订号已变");
		expect(currentContent(store, created.id).conclusion).toBe("中间修订");
	});
});

// ════════════════════════════════════════════════════════════════════════
// R8：CLI 纠正经 registerMemoryCommand——字段保留、新修订可读 memoryCorrect、旧修订读原依据
// ════════════════════════════════════════════════════════════════════════
describe("O02-R8：CLI 纠正经 registerMemoryCommand", () => {
	it("带 conditions/rationale 条目经 /pao memory correct → 字段完整、新修订可读 memoryCorrect 正文、旧修订读原依据", async () => {
		const root = home();
		const sessionId = "sess-cli-correct";
		const manager = SessionManager.create(root, join(root, "agent", "sessions"), { id: sessionId });
		const store = openMemoryStore(root, "readwrite");
		const service = openMemoryService({ paoHome: root, mode: "readwrite" });
		closers.push(async () => { await service.close(); store.close(); });

		const s = seedSource(store, { sessionId, entryId: "e-origin" });
		const created = await service.createMemory({
			kind: "decision", scope: { projectId: "proj-cli", sessionId },
			conclusion: "旧结论", conditions: "原条件", rationale: "原理由",
			evidenceKind: "user_statement", confirmation: "confirmed",
			sourceIds: [s.sourceId], createdBy: "user", createdAt: AT,
		});
		if (!created.ok) throw new Error(created.error.message);

		const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
		bindBuiltinMemoryService(pi, () => service);
		registerMemoryCommand(pi, () => undefined, () => root);
		const state = sessionMemory(pi);
		state.record([{ 内容: "旧结论", 记忆ID: created.id, 修订号: 1, 来源: "内置记忆库" }], BUILTIN_PROVIDER);
		const ctx = {
			hasUI: true, cwd: root, sessionManager: manager,
			ui: { confirm: vi.fn(async () => true), notify: vi.fn() },
		};
		await listPaoSubcommands(pi).find((item) => item.name === "memory")?.run(pi, "correct 1 新结论", ctx as never);

		const got = await service.getMemory({ id: created.id, includeHistory: true });
		record("R8", { got, archivedSourceIds: got.ok ? got.revisions?.[1]?.sourceIds : [] });
		expect(got.ok).toBe(true);
		if (!got.ok) return;
		expect(got.memory.currentRevision).toBe(2);
		expect(got.memory.content.conclusion).toBe("新结论");
		expect(got.memory.content.conditions).toBe("原条件");
		expect(got.memory.content.rationale).toBe("原理由");
		const newSourceIds = revisionSourceIds(store, created.id, 2);
		expect(newSourceIds).toContain(s.sourceId);
		expect(newSourceIds.length).toBe(2);
		const archivedId = newSourceIds.find((id) => id !== s.sourceId)!;
		const archived = await service.readMemorySource({ sourceId: archivedId });
		expect(archived.ok).toBe(true);
		if (archived.ok) {
			expect(archived.content).toContain("memoryCorrect");
			expect(archived.content).toContain(created.id);
		}
		expect(revisionSourceIds(store, created.id, 1)).toEqual([s.sourceId]);
	});
});

// ════════════════════════════════════════════════════════════════════════
// R9：同项目两条不同结论 decision → revision_links 无 related
// ════════════════════════════════════════════════════════════════════════
describe("O02-R9：无关结论不建 related", () => {
	it("同项目两条不同结论 decision 入库后 revision_links 无 related 记录", async () => {
		const root = home();
		const store = openMemoryStore(root, "readwrite");
		const service = openMemoryService({ paoHome: root, mode: "readwrite" });
		closers.push(async () => { await service.close(); store.close(); });

		const s1 = seedSource(store, { entryId: "e-1" });
		await commit(store, service, [candidate({ sourceId: s1.sourceId, conclusion: "采用 SQLite 方案" })], [s1.ref]);

		const s2 = seedSource(store, { sessionId: "sess-2", entryId: "e-2", capturedAt: AT2 });
		const second = await commit(store, service, [
			candidate({ sourceId: s2.sourceId, conclusion: "放弃 SQLite 改用别的" }),
		], [s2.ref], [], SCOPE, "job-2", AT2);
		expect(second.outcomes[0].status).toBe("submitted");
		const newId = (second.outcomes[0] as { memoryId: string }).memoryId;
		const links = store.db
			.prepare(`SELECT relation, target_memory_id FROM revision_links WHERE memory_id = ? AND relation = 'related'`)
			.all(newId) as Array<{ relation: string; target_memory_id: string }>;
		record("R9", { newId, links });
		expect(links).toHaveLength(0);
	});
});

// ════════════════════════════════════════════════════════════════════════
// R10：批内同结论异 confirmation → 按既定规则处理不静默合并
// ════════════════════════════════════════════════════════════════════════
describe("O02-R10：批内同结论异 confirmation", () => {
	it("批内第一条 confirmed 第二条 tentative 同结论 → 第二条 semantic_conflict，不静默合并", async () => {
		const root = home();
		const store = openMemoryStore(root, "readwrite");
		const service = openMemoryService({ paoHome: root, mode: "readwrite" });
		closers.push(async () => { await service.close(); store.close(); });

		const s1 = seedSource(store, { entryId: "e-a" });
		const s2 = seedSource(store, { entryId: "e-b" });
		const out = await commit(store, service, [
			candidate({ sourceId: s1.sourceId, confirmation: "confirmed" }),
			candidate({ sourceId: s2.sourceId, confirmation: "tentative", conclusion: "内置记忆存储使用 SQLite" }),
		], [s1.ref, s2.ref]);
		record("R10", out.outcomes);
		expect(out.outcomes[0].status).toBe("submitted");
		// I01 修复后：tentative 对批内已 confirmed 的同结论目标走统一分派——
		// confirmationChanged 实质差异走 semantic_conflict，不再被批内去重吞掉。
		expect(out.outcomes[1]).toMatchObject({ status: "skipped", reason: "semantic_conflict" });
		expect(memoryRow(store, (out.outcomes[0] as { memoryId: string }).memoryId)?.current_revision).toBe(1);
		expect((store.db.prepare(`SELECT COUNT(*) AS c FROM memories`).get() as { c: number }).c).toBe(1);
	});
});

// ════════════════════════════════════════════════════════════════════════
// R11：老路径回归——同来源同内容同条件重复仍 duplicate 补链；全新来源独立事实仍 submitted
// ════════════════════════════════════════════════════════════════════════
describe("O02-R11：老路径回归", () => {
	it("同来源同内容同条件重放 → duplicate 补链；全新来源独立事实 → submitted", async () => {
		const root = home();
		const store = openMemoryStore(root, "readwrite");
		const service = openMemoryService({ paoHome: root, mode: "readwrite" });
		closers.push(async () => { await service.close(); store.close(); });

		const s1 = seedSource(store, { entryId: "e-1" });
		const mk = () => candidate({ sourceId: s1.sourceId });
		const first = await commit(store, service, [mk()], [s1.ref]);
		const firstId = (first.outcomes[0] as { memoryId: string }).memoryId;

		const dup = await commit(store, service, [mk()], [s1.ref], [await relatedSnapshot(service, firstId)], SCOPE, "job-2", AT2);
		record("R11-dup", dup.outcomes);
		expect(dup.outcomes[0]).toMatchObject({ status: "duplicate", memoryId: firstId });
		expect(dup.submitted).toBe(0);

		const s2 = seedSource(store, { sessionId: "sess-2", entryId: "e-independent", capturedAt: AT3 });
		const independent = await commit(store, service, [
			candidate({ sourceId: s2.sourceId, conclusion: "侧边栏宽度固定为 320px" }),
		], [s2.ref], [await relatedSnapshot(service, firstId)], SCOPE, "job-3", AT3);
		record("R11-independent", independent.outcomes);
		expect(independent.outcomes[0].status).toBe("submitted");
	});
});
