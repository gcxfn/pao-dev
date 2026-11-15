import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@pao/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/core/extensions/types.ts";
import { SessionManager } from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/core/session-manager.ts";
import { createCapture } from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/capture.ts";
import {
	advanceCursor,
	claimJob,
	createJob,
	failJob,
	MAX_ATTEMPTS,
	recoverJobs,
} from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extraction-jobs.ts";
import { readSegmentLines, sealSegment } from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/archive.ts";
import { registerExtractionScheduler } from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extraction-scheduler.ts";
import { openMemoryService } from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/service.ts";
import { openMemoryStore } from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/store.ts";
import type {
	ExtractModelInput,
	ExtractModelOutput,
	MemoryScope,
	RelatedMemorySummary,
} from "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/types.ts";

const requestState = vi.hoisted(() => ({
	handle: undefined as ((deps: unknown, input: ExtractModelInput) => Promise<ExtractModelOutput>) | undefined,
}));

vi.mock("D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extract-model.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/extract-model.ts")>();
	return {
		...actual,
		requestExtraction: (deps: unknown, input: ExtractModelInput) => {
			if (requestState.handle === undefined) throw new Error("测试未安装提炼响应");
			return requestState.handle(deps, input);
		},
	};
});

const tempDirs: string[] = [];
const AT = "2026-11-09T10:00:00.000Z";
const AT2 = "2026-11-09T10:01:00.000Z";
const AT3 = "2026-11-09T10:02:00.000Z";
const SCOPE: MemoryScope = { projectId: "proj-scheduler-stale" };

afterEach(() => {
	requestState.handle = undefined;
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// SQLite/WAL handles may still be closing on Windows.
		}
	}
});

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("等待 scheduler 收尾超时");
}

describe("extraction scheduler", () => {
	it("stale 候选保留 failed 与 cursor，其他候选正常提交且 recovery 不自动重放", async () => {
		const home = mkdtempSync(join(tmpdir(), "pao-mem-scheduler-"));
		tempDirs.push(home);
		const store = openMemoryStore(home, "readwrite");
		const service = openMemoryService({ paoHome: home, mode: "readwrite" });
		const sessionId = "sess-scheduler-stale";
		const manager = SessionManager.create(home, join(home, "agent", "sessions"), { id: sessionId });
		const assistantEntryId = manager.appendMessage(
			fauxAssistantMessage("目前缺省 top3。", { timestamp: Date.parse(AT) }),
		);
		const userEntryId = manager.appendMessage({
			role: "user",
			content: "改成 top5。",
			timestamp: Date.parse(AT),
		});
		const independentEntryId = manager.appendMessage({
			role: "user",
			content: "侧边栏宽度固定为 320px。",
			timestamp: Date.parse(AT),
		});
		const capture = createCapture({ store, paoHome: home, now: () => AT });
		capture.registerSession(sessionId, manager.getSessionFile()!);
		const assistantSourceId = capture.captureCommittedEntry(
			sessionId,
			manager.getEntry(assistantEntryId)!,
			undefined,
			AT,
		).sourceId!;
		const userSourceId = capture.captureCommittedEntry(sessionId, manager.getEntry(userEntryId)!, undefined, AT)
			.sourceId!;
		const independentSourceId = capture.captureCommittedEntry(
			sessionId,
			manager.getEntry(independentEntryId)!,
			undefined,
			AT,
		).sourceId!;
		const sourceIds = [assistantSourceId, userSourceId];
		const old = await service.createMemory({
			kind: "decision",
			scope: { ...SCOPE, sessionId },
			conclusion: "自动召回每轮的取条数由缺省 top3 改为 top5。",
			evidenceKind: "user_statement",
			confirmation: "confirmed",
			sourceIds,
			createdBy: "user",
			createdAt: AT,
		});
		if (!old.ok) throw new Error(old.error.message);
		const existingJob = createJob(store, {
			sourceScope: JSON.stringify({ sessionId, projectId: SCOPE.projectId }),
			scopeKey: `session:${sessionId}`,
			createdAt: AT,
		});
		advanceCursor(store, {
			jobId: existingJob.jobId,
			cursor: "cursor-before-stale-batch",
			advancedAt: AT,
		});

		let requestSnapshot: RelatedMemorySummary[] | undefined;
		let requestCount = 0;
		requestState.handle = async (_deps, input) => {
			requestCount += 1;
			requestSnapshot = input.relatedMemories;
			const corrected = await service.correctMemory({
				id: old.id,
				expectedRevision: 1,
				replacement: {
					conclusion: "自动召回每轮 top3",
					evidenceKind: "user_statement",
					confirmation: "confirmed",
				},
				source: { sessionId },
				createdAt: AT2,
			});
			if (!corrected.ok) throw new Error(corrected.error.message);
			return {
				candidates: [
					{
						kind: "decision",
						conclusion: "自动召回每轮取条数由缺省 top3 改为 top5。",
						evidenceKind: "user_statement",
						confirmation: "confirmed",
						sourceIds,
						quotedSpans: [
							{ sourceId: assistantSourceId, text: "缺省 top3" },
							{ sourceId: userSourceId, text: "改成 top5" },
						],
						spanLocations: [
							{ sourceId: assistantSourceId, match: "exact", offset: 0 },
							{ sourceId: userSourceId, match: "exact", offset: 0 },
						],
					},
					{
						kind: "decision",
						conclusion: "侧边栏宽度固定为 320px。",
						evidenceKind: "user_statement",
						confirmation: "confirmed",
						sourceIds: [independentSourceId],
						quotedSpans: [{ sourceId: independentSourceId, text: "320px" }],
						spanLocations: [{ sourceId: independentSourceId, match: "exact", offset: 0 }],
					},
				],
				rejected: [],
				requestId: "req-scheduler-stale",
			};
		};

		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const pi = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
				handlers.set(event, handler);
				return () => handlers.delete(event);
			},
		} as unknown as ExtensionAPI;
		const unmount = registerExtractionScheduler(pi, {
			store,
			service,
			paoHome: home,
			ledger: {
				appendUsage: vi.fn(),
				appendCustomEntry: vi.fn(),
			} as never,
			resolveScope: () => ({ ...SCOPE, sessionId }),
			now: () => AT,
		});
		const ctx = {
			sessionManager: manager,
			cwd: home,
			modelRegistry: {},
		} as unknown as ExtensionContext;

		try {
			await handlers.get("turn_end")?.({}, ctx);
			await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
			await waitFor(() => {
				const row = store.db
					.prepare("SELECT status FROM extraction_jobs WHERE scope_key = ?")
					.get(`session:${sessionId}`) as { status: string } | undefined;
				return row?.status === "failed";
			});

			expect(requestSnapshot).toEqual([
				expect.objectContaining({
					memoryId: old.id,
					currentRevision: 1,
					conclusion: "自动召回每轮的取条数由缺省 top3 改为 top5。",
				}),
			]);
			const job = store.db
				.prepare(
					`SELECT status, cursor, attempt_count, last_error
					 FROM extraction_jobs WHERE scope_key = ?`,
				)
				.get(`session:${sessionId}`) as {
				status: string;
				cursor: string | null;
				attempt_count: number;
				last_error: string | null;
			};
			expect(job).toMatchObject({
				status: "failed",
				cursor: "cursor-before-stale-batch",
				attempt_count: 1,
			});
			expect(job.last_error).toContain("stale_request_snapshot:");
			expect(job.last_error).toContain(`${old.id}@rev1`);
			expect(job.last_error).toContain("已提交候选=1");

			const recovered = recoverJobs(store, AT2);
			expect(recovered.recovered).toEqual([]);
			const stillFailed = store.db
				.prepare("SELECT status FROM extraction_jobs WHERE job_id = ?")
				.get(existingJob.jobId) as { status: string };
			expect(stillFailed.status).toBe("failed");
			expect(requestCount).toBe(1);

			const activeRows = store.db
				.prepare(
					`SELECT m.id, m.current_revision, r.content_json
					 FROM memories m
					 JOIN memory_revisions r ON r.memory_id = m.id AND r.revision = m.current_revision
					 WHERE m.usage_state = 'active'
					   AND json_extract(m.scope_json, '$.projectId') = ?`,
				)
				.all(SCOPE.projectId) as Array<{ id: string; current_revision: number; content_json: string }>;
			expect(activeRows).toHaveLength(2);
			const corrected = activeRows.find((row) => row.id === old.id);
			expect(corrected!.current_revision).toBe(2);
			expect(JSON.parse(corrected!.content_json).conclusion).toBe("自动召回每轮 top3");
			expect(
				activeRows.filter((row) => JSON.parse(row.content_json).conclusion === "侧边栏宽度固定为 320px。"),
			).toHaveLength(1);
		} finally {
			unmount();
			await service.close();
			store.close();
		}
	});

	// ════════════════════════════════════════════════════════════════════
	// O03 定向用例：跨会话续作 / 重试预算 / 读失败游标 / 停用不复活 / 忙不新领
	// ════════════════════════════════════════════════════════════════════

	interface SchedulerFixture {
		home: string;
		store: ReturnType<typeof openMemoryStore>;
		service: ReturnType<typeof openMemoryService>;
		manager: SessionManager;
		capture: ReturnType<typeof createCapture>;
		handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
		ctx: ExtensionContext;
		unmount: () => void;
		sessionId: string;
	}

	/** 装配一个会话 + 调度器（ledger 用空实现；ctx 只带调度器用到的字段）。 */
	async function schedulerFixture(
		sessionId: string,
		scope: MemoryScope,
		opts: {
			home?: string;
			store?: ReturnType<typeof openMemoryStore>;
			service?: ReturnType<typeof openMemoryService>;
			readSegment?: (
				segment: { segmentId: string },
			) => Promise<{ lines: string[]; archived: boolean } | undefined>;
		} = {},
	): Promise<SchedulerFixture> {
		const home = opts.home ?? mkdtempSync(join(tmpdir(), "pao-mem-scheduler-"));
		tempDirs.push(home);
		const store = opts.store ?? openMemoryStore(home, "readwrite");
		const service = opts.service ?? openMemoryService({ paoHome: home, mode: "readwrite" });
		const manager = SessionManager.create(home, join(home, "agent", "sessions"), { id: sessionId });
		const capture = createCapture({ store, paoHome: home, now: () => AT });
		capture.registerSession(sessionId, manager.getSessionFile()!);
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		const pi = {
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
				handlers.set(event, handler);
				return () => handlers.delete(event);
			},
		} as unknown as ExtensionAPI;
		const unmount = registerExtractionScheduler(pi, {
			store,
			service,
			paoHome: home,
			ledger: { appendUsage: vi.fn(), appendCustomEntry: vi.fn() } as never,
			resolveScope: () => scope,
			...(opts.readSegment === undefined ? {} : { readSegment: opts.readSegment }),
			now: () => AT,
		});
		const ctx = { sessionManager: manager, cwd: home, modelRegistry: {} } as unknown as ExtensionContext;
		return { home, store, service, manager, capture, handlers, ctx, unmount, sessionId };
	}

	function appendUserSource(fx: SchedulerFixture, text: string, sessionId = fx.sessionId, at = AT): string {
		const entryId = fx.manager.appendMessage({ role: "user", content: text, timestamp: Date.parse(at) });
		const captured = fx.capture.captureCommittedEntry(sessionId, fx.manager.getEntry(entryId)!, undefined, at);
		return captured.sourceId!;
	}

	function jobRow(store: ReturnType<typeof openMemoryStore>, scopeKey: string) {
		return store.db
			.prepare(
				`SELECT job_id, status, cursor, attempt_count, consecutive_failures, last_error
				 FROM extraction_jobs WHERE scope_key = ?`,
			)
			.get(scopeKey) as
			| { job_id: string; status: string; cursor: string | null; attempt_count: number; consecutive_failures: number; last_error: string | null }
			| undefined;
	}

	it("O03/F06：A 会话退出后，B 会话的调度器捞起库内 pending job 并按 A 的身份续作", async () => {
		// 会话 A：建库留 1 条用户来源 + 1 个 pending job（A 随后「退出」=不再装配）。
		const scopeA: MemoryScope = { projectId: "proj-a", sessionId: "sess-a" };
		const fxA = await schedulerFixture("sess-a", scopeA);
		const sourceA = appendUserSource(fxA, "构建命令固定为 pnpm build。");
		createJob(fxA.store, {
			sourceScope: JSON.stringify({ sessionId: "sess-a", projectId: "proj-a" }),
			scopeKey: "session:sess-a",
			createdAt: AT,
		});
		// A 的调度器不触发任何 drain——模拟 A 直接退出（保留库内 pending）。
		fxA.unmount();

		// 会话 B：同一 PAO_HOME、不同 SessionManager/scope——B 不该拿自己的身份做 A 的 job。
		const scopeB: MemoryScope = { projectId: "proj-b", sessionId: "sess-b" };
		const fxB = await schedulerFixture("sess-b", scopeB, {
			home: fxA.home,
			store: fxA.store,
			service: fxA.service,
		});
		let requestCount = 0;
		let requestSourceSession: string | undefined;
		requestState.handle = async (_deps, input) => {
			requestCount += 1;
			requestSourceSession = input.sourceSessionId;
			return {
				candidates: [
					{
						kind: "decision",
						conclusion: "构建命令固定为 pnpm build。",
						evidenceKind: "user_statement",
						confirmation: "confirmed",
						sourceIds: [sourceA],
						quotedSpans: [{ sourceId: sourceA, text: "pnpm build" }],
						spanLocations: [{ sourceId: sourceA, match: "exact" as const, offset: 0 }],
					},
				],
				rejected: [],
				requestId: "req-continuation",
			};
		};

		try {
			await fxB.handlers.get("agent_settled")?.({ type: "agent_settled" }, fxB.ctx);
			await waitFor(() => jobRow(fxB.store, "session:sess-a")?.status === "done");

			expect(requestCount).toBe(1);
			// 提炼请求的归属会话是 job 自带的 A，不是消费方 B。
			expect(requestSourceSession).toBe("sess-a");
			// 记忆落 A 的 scope（projectId=proj-a、sessionId=sess-a），不借 B 的身份。
			const memory = fxB.store.db
				.prepare(
					`SELECT m.scope_json FROM memories m
					 JOIN memory_revisions r ON r.memory_id = m.id AND r.revision = m.current_revision
					 WHERE json_extract(r.content_json, '$.conclusion') = ?`,
				)
				.get("构建命令固定为 pnpm build。") as { scope_json: string } | undefined;
			expect(memory).toBeDefined();
			const scope = JSON.parse(memory!.scope_json) as { projectId: string; sessionId?: string };
			expect(scope.projectId).toBe("proj-a");
			expect(scope.sessionId).toBe("sess-a");
		} finally {
			fxB.unmount();
			await fxB.service.close();
			fxB.store.close();
		}
	});

	it("O03/F07：连续失败按未提交批次计——成功批次清零 consecutive_failures，临时失败可恢复", async () => {
		const scope: MemoryScope = { projectId: "proj-f07", sessionId: "sess-f07" };
		const fx = await schedulerFixture("sess-f07", scope);
		const store = fx.store;
		const job = createJob(store, {
			sourceScope: JSON.stringify({ sessionId: "sess-f07", projectId: "proj-f07" }),
			scopeKey: "session:sess-f07",
			createdAt: AT,
		});
		// 三次连续失败（未提交批次）：consecutive_failures 到上限 → 终态不恢复。
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			claimJob(store, { jobId: job.jobId, ownerProcess: `pid-${process.pid}`, claimedAt: AT });
			failJob(store, { jobId: job.jobId, reason: `第${i + 1}次失败`, failedAt: AT });
			if (i < MAX_ATTEMPTS - 1) recoverJobs(store, AT);
		}
		expect(recoverJobs(store, AT2).recovered).toHaveLength(0);
		const afterMax = jobRow(store, "session:sess-f07")!;
		expect(afterMax.status).toBe("failed");
		expect(afterMax.consecutive_failures).toBe(MAX_ATTEMPTS);

		// 模拟「失败之间有成功批次」：advanceCursor（已提交批次边界）清零连续失败，
		// 此后一次临时失败不应触终态——这正是 attempt_count 口径会误杀的场景。
		store.db
			.prepare("UPDATE extraction_jobs SET status='running', consecutive_failures=2 WHERE job_id=?")
			.run(job.jobId);
		advanceCursor(store, { jobId: job.jobId, cursor: "src-batch-committed", advancedAt: AT2 });
		const reset = jobRow(store, "session:sess-f07")!;
		expect(reset.consecutive_failures).toBe(0);
		failJob(store, { jobId: job.jobId, reason: "临时失败", failedAt: AT2 });
		// consecutive_failures=1 < 上限：recoverJobs 恢复为 pending。
		const recovered = recoverJobs(store, AT3);
		expect(recovered.recovered.map((r) => r.jobId)).toContain(job.jobId);
		fx.unmount();
		await fx.service.close();
		store.close();
	});

	it("O03/F13：批内中间来源读取失败 → 游标停在失败批前，恢复后不重跑已提交候选", async () => {
		const scope: MemoryScope = { projectId: "proj-f13", sessionId: "sess-f13" };
		const fx = await schedulerFixture("sess-f13", scope);
		// captured_at 递增保证来源顺序（同刻回退 source_id 排序不可控）。
		const s1 = appendUserSource(fx, "第一条：保留窗口一。", fx.sessionId, AT);
		const s2 = appendUserSource(fx, "第二条：保留窗口二。", fx.sessionId, AT2);
		const s3 = appendUserSource(fx, "第三条：保留窗口三。", fx.sessionId, AT3);
		// 末尾再挂一条全排除批：task-c 的 s4 记进 source_exclusions——
		// 整批被排除时游标应照常推进（确定状态，不发请求）。
		const s4 = appendUserSource(fx, "第四条：已被删除排除。", fx.sessionId, "2026-11-09T10:03:00.000Z");
		fx.store.db
			.prepare(
				`INSERT INTO source_exclusions (exclusion_id, source_id, session_id, entry_id, reason, created_at)
				 VALUES (?, ?, ?, NULL, ?, ?)`,
			)
			.run("exc-f13", s4, "sess-f13", "memory 删除:mem-x", AT3);
		// 把来源切成三批：s1 归 task-a，s2/s3 归 task-b，s4 归 task-c——
		// 批1提交后批2读失败；恢复后批2续跑、批3全排除只推游标。
		fx.store.db.prepare("UPDATE sources SET project_id='proj-f13', task_id='task-a' WHERE source_id=?").run(s1);
		fx.store.db
			.prepare("UPDATE sources SET project_id='proj-f13', task_id='task-b' WHERE source_id IN (?, ?)")
			.run(s2, s3);
		fx.store.db.prepare("UPDATE sources SET project_id='proj-f13', task_id='task-c' WHERE source_id=?").run(s4);

		// 让 s2 回读失败：来源行的段引用指向不存在的段——readSourceEvents 如实
		// 返回 source_missing（同会话三个来源共用同一段文件，动文件会误伤 s1/s3）。
		const s2Segment = (fx.store.db
			.prepare("SELECT segment_id FROM sources WHERE source_id=?")
			.get(s2) as { segment_id: string }).segment_id;
		fx.store.db.prepare("UPDATE sources SET segment_id='seg-gone' WHERE source_id=?").run(s2);

		const seenBatches: string[][] = [];
		requestState.handle = async (_deps, input) => {
			seenBatches.push(input.entries.map((e) => e.sourceId));
			return {
				candidates: [
					{
						kind: "experience",
						conclusion: `经验-${input.entries[0]!.sourceId}`,
						evidenceKind: "user_statement",
						confirmation: "confirmed",
						sourceIds: [input.entries[0]!.sourceId],
						quotedSpans: [{ sourceId: input.entries[0]!.sourceId, text: input.entries[0]!.content.slice(0, 10) }],
						spanLocations: [{ sourceId: input.entries[0]!.sourceId, match: "exact" as const, offset: 0 }],
					},
				],
				rejected: [],
				requestId: `req-${seenBatches.length}`,
			};
		};

		try {
			// s1 先提交（批1）→ s2 读失败（批2）→ failJob，游标停在 s1（失败批前）。
			await fx.handlers.get("turn_end")?.({}, fx.ctx);
			await fx.handlers.get("agent_settled")?.({ type: "agent_settled" }, fx.ctx);
			await waitFor(() => jobRow(fx.store, "session:sess-f13")?.status === "failed");

			const failed = jobRow(fx.store, "session:sess-f13")!;
			expect(failed.cursor).toBe(s1);
			expect(failed.last_error).toContain("来源读取失败");
			expect(failed.last_error).toContain(s2);
			expect(seenBatches).toEqual([[s1]]); // 只请求过批1

			// 恢复 s2 段引用 → 下轮从 s2 续，不重跑 s1（不重复提交）。
			fx.store.db.prepare("UPDATE sources SET segment_id=? WHERE source_id=?").run(s2Segment, s2);
			await fx.handlers.get("agent_settled")?.({ type: "agent_settled" }, fx.ctx);
			await waitFor(() => jobRow(fx.store, "session:sess-f13")?.status === "done");
			// 批2 续跑 s2/s3；批3（s4）整批排除不发请求，游标仍推进到 s4 → job done。
			expect(seenBatches).toEqual([[s1], [s2, s3]]);
			expect(jobRow(fx.store, "session:sess-f13")!.cursor).toBe(s4);
			const memoryCount = fx.store.db
				.prepare("SELECT COUNT(*) AS c FROM memories")
				.get() as { c: number };
			expect(memoryCount.c).toBe(2); // s1 一条 + s2/s3 批一条，s1 未重复。
		} finally {
			fx.unmount();
			await fx.service.close();
			fx.store.close();
		}
	});

	it("O03/F05：同来源候选不复活已停用记忆；全新来源同结论可正常新建", async () => {
		const scope: MemoryScope = { projectId: "proj-f05", sessionId: "sess-f05" };
		const fx = await schedulerFixture("sess-f05", scope);
		const s1 = appendUserSource(fx, "构建命令固定为 pnpm build。");
		const created = await fx.service.createMemory({
			kind: "decision",
			scope: { ...scope },
			conclusion: "构建命令固定为 pnpm build。",
			evidenceKind: "user_statement",
			confirmation: "confirmed",
			sourceIds: [s1],
			createdBy: "user",
			createdAt: AT,
		});
		if (!created.ok) throw new Error(created.error.message);
		// 用户明确停用该记忆（rev2 继承来源链接）。
		const stopped = await fx.service.setMemoryUsage({
			id: created.id,
			expectedRevision: 1,
			target: "stopped",
			source: { sessionId: "sess-f05" },
			createdAt: AT2,
		});
		if (!stopped.ok) throw new Error(stopped.error.message);

		requestState.handle = async (_deps, _input) => ({
			candidates: [
				{
					kind: "decision",
					conclusion: "构建命令固定为 pnpm build。",
					evidenceKind: "user_statement",
					confirmation: "confirmed",
					sourceIds: [s1],
					quotedSpans: [{ sourceId: s1, text: "pnpm build" }],
					spanLocations: [{ sourceId: s1, match: "exact" as const, offset: 0 }],
				},
			],
			rejected: [],
			requestId: "req-f05",
		});

		try {
			// 同来源重放：候选命中 stopped 记忆 → source_resting_stopped → 需重评，不新建。
			await fx.handlers.get("turn_end")?.({}, fx.ctx);
			await fx.handlers.get("agent_settled")?.({ type: "agent_settled" }, fx.ctx);
			await waitFor(() => jobRow(fx.store, "session:sess-f05")?.status === "failed");
			const failed = jobRow(fx.store, "session:sess-f05")!;
			// source_resting_stopped 与语义冲突同口径：记需重评前缀 + stopped=<memoryId>，
			// 游标不推进（last_error 前缀即「不自动重放」的 needs-reevaluation 标记）。
			expect(failed.last_error).toContain("stale_request_snapshot:");
			expect(failed.last_error).toContain(`stopped=${created.id}`);
			const activeCount = fx.store.db
				.prepare("SELECT COUNT(*) AS c FROM memories WHERE usage_state='active'")
				.get() as { c: number };
			expect(activeCount.c).toBe(0); // 没有复活出 active 副本

			// 全新来源同结论：不在 stopped 记忆的 source_links 里 → 正常新建。
			// captured_at 用更晚的 AT3：来源表按 (captured_at, source_id) 排序——
			// 同刻时 sourceId 是 uuid 无序，晚到的「新来源」须排在尝试边界之后。
			const s2 = appendUserSource(fx, "再确认一次：构建命令固定为 pnpm build。", fx.sessionId, AT3);
			requestState.handle = async (_deps, _input) => ({
				candidates: [
					{
						kind: "decision",
						conclusion: "构建命令固定为 pnpm build。（复核）",
						evidenceKind: "user_statement",
						confirmation: "confirmed",
						sourceIds: [s2],
						quotedSpans: [{ sourceId: s2, text: "pnpm build" }],
						spanLocations: [{ sourceId: s2, match: "exact" as const, offset: 0 }],
					},
				],
				rejected: [],
				requestId: "req-f05b",
			});
			// 真实事件链：turn_end 登记新来源 → settled → failed job 检出
			// 上次尝试边界之后的新来源 → reopenFailedJobForNewSources 重开续跑（O03/I01）。
			await fx.handlers.get("turn_end")?.({}, fx.ctx);
			await fx.handlers.get("agent_settled")?.({ type: "agent_settled" }, fx.ctx);
			await waitFor(() => jobRow(fx.store, "session:sess-f05")?.status === "done");
			const rows = fx.store.db
				.prepare(
					`SELECT m.usage_state FROM memories m
					 JOIN memory_revisions r ON r.memory_id=m.id AND r.revision=m.current_revision
					 WHERE json_extract(r.content_json,'$.conclusion') LIKE '%pnpm build%'`,
				)
				.all() as Array<{ usage_state: string }>;
			expect(rows.filter((r) => r.usage_state === "active")).toHaveLength(1);
			expect(rows.filter((r) => r.usage_state === "stopped")).toHaveLength(1);
		} finally {
			fx.unmount();
			await fx.service.close();
			fx.store.close();
		}
	});

	it("O03/F03：本进程前台忙（agent_start 未 settled）时 drain 不新领后台 job", async () => {
		// 两个会话各留一个 pending job；处理第一个时在请求里触发 agent_start——
		// busy 置位后，drain 的 per-target 检查应让第二个 job 留在 pending。
		const scope1: MemoryScope = { projectId: "proj-busy", sessionId: "sess-busy-1" };
		const fx1 = await schedulerFixture("sess-busy-1", scope1);
		appendUserSource(fx1, "会话一的决定。");
		createJob(fx1.store, {
			sourceScope: JSON.stringify({ sessionId: "sess-busy-1", projectId: "proj-busy" }),
			scopeKey: "session:sess-busy-1",
			createdAt: AT,
		});
		// 会话二的 job 也由同一调度器捞起（跨会话 pending 扫描）。
		const manager2 = SessionManager.create(fx1.home, join(fx1.home, "agent", "sessions"), { id: "sess-busy-2" });
		fx1.capture.registerSession("sess-busy-2", manager2.getSessionFile()!);
		const e2 = manager2.appendMessage({ role: "user", content: "会话二的决定。", timestamp: Date.parse(AT) });
		fx1.capture.captureCommittedEntry("sess-busy-2", manager2.getEntry(e2)!, undefined, AT);
		createJob(fx1.store, {
			sourceScope: JSON.stringify({ sessionId: "sess-busy-2", projectId: "proj-busy" }),
			scopeKey: "session:sess-busy-2",
			createdAt: AT,
		});

		const processed: string[] = [];
		requestState.handle = async (_deps, input) => {
			processed.push(input.sourceSessionId);
			// 第一个 job 的请求进行中前台来活：agent_start 置 busy → 后续 target 不领。
			if (processed.length === 1) {
				await fx1.handlers.get("agent_start")?.({ type: "agent_start" }, fx1.ctx);
			}
			return {
				candidates: [],
				rejected: [],
				requestId: `req-busy-${processed.length}`,
			};
		};

		try {
			await fx1.handlers.get("agent_settled")?.({ type: "agent_settled" }, fx1.ctx);
			await waitFor(() => jobRow(fx1.store, "session:sess-busy-1")?.status === "done");
			// 第二个 job 应仍是 pending——busy 期间 drain 提前返回，没有领取它。
			expect(jobRow(fx1.store, "session:sess-busy-2")?.status).toBe("pending");
			expect(processed).toEqual(["sess-busy-1"]);

			// 下一轮 settled（busy 复位）才领第二个。
			await fx1.handlers.get("agent_settled")?.({ type: "agent_settled" }, fx1.ctx);
			await waitFor(() => jobRow(fx1.store, "session:sess-busy-2")?.status === "done");
			expect(processed).toEqual(["sess-busy-1", "sess-busy-2"]);
		} finally {
			fx1.unmount();
			await fx1.service.close();
			fx1.store.close();
		}
	});

	it("O03/I01 反例：needs-reevaluation 后无新来源，settled 不反复重跑", async () => {
		// 与 F05 同前置：stopped 拦截 → failed(stale 前缀)。此后没有新来源——
		// 已尝试未提交的游标后旧批不算新依据，普通 settled 保持 failed 不重跑。
		const scope: MemoryScope = { projectId: "proj-i01-neg", sessionId: "sess-i01-neg" };
		const fx = await schedulerFixture("sess-i01-neg", scope);
		const s1 = appendUserSource(fx, "构建命令固定为 pnpm build。");
		const created = await fx.service.createMemory({
			kind: "decision",
			scope: { ...scope },
			conclusion: "构建命令固定为 pnpm build。",
			evidenceKind: "user_statement",
			confirmation: "confirmed",
			sourceIds: [s1],
			createdBy: "user",
			createdAt: AT,
		});
		if (!created.ok) throw new Error(created.error.message);
		const stopped = await fx.service.setMemoryUsage({
			id: created.id,
			expectedRevision: 1,
			target: "stopped",
			source: { sessionId: "sess-i01-neg" },
			createdAt: AT2,
		});
		if (!stopped.ok) throw new Error(stopped.error.message);

		let requestCount = 0;
		requestState.handle = async () => {
			requestCount += 1;
			return {
				candidates: [
					{
						kind: "decision",
						conclusion: "构建命令固定为 pnpm build。",
						evidenceKind: "user_statement",
						confirmation: "confirmed",
						sourceIds: [s1],
						quotedSpans: [{ sourceId: s1, text: "pnpm build" }],
						spanLocations: [{ sourceId: s1, match: "exact" as const, offset: 0 }],
					},
				],
				rejected: [],
				requestId: `req-i01-neg-${requestCount}`,
			};
		};

		try {
			await fx.handlers.get("turn_end")?.({}, fx.ctx);
			await fx.handlers.get("agent_settled")?.({ type: "agent_settled" }, fx.ctx);
			await waitFor(() => jobRow(fx.store, "session:sess-i01-neg")?.status === "failed");
			expect(requestCount).toBe(1);
			expect(jobRow(fx.store, "session:sess-i01-neg")!.last_error).toContain("stale_request_snapshot:");

			// 无新来源的空闲事件：job 保持 failed，不再发模型请求（不自动重放）。
			await fx.handlers.get("agent_settled")?.({ type: "agent_settled" }, fx.ctx);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(requestCount).toBe(1);
			expect(jobRow(fx.store, "session:sess-i01-neg")!.status).toBe("failed");
		} finally {
			fx.unmount();
			await fx.service.close();
			fx.store.close();
		}
	});

	it("O03/I02：同 home 同进程两调度器共享前台忙——A 忙时 B 的 settled 不领", async () => {
		// 同 home 同 store 装两个会话调度器（桌面 session-supervisor 同进程多会话）。
		const scopeA: MemoryScope = { projectId: "proj-i02", sessionId: "sess-i02-a" };
		const fxA = await schedulerFixture("sess-i02-a", scopeA);
		const sourceA = appendUserSource(fxA, "会话一的持久任务。");
		createJob(fxA.store, {
			sourceScope: JSON.stringify({ sessionId: "sess-i02-a", projectId: "proj-i02" }),
			scopeKey: "session:sess-i02-a",
			createdAt: AT,
		});
		const scopeB: MemoryScope = { projectId: "proj-i02", sessionId: "sess-i02-b" };
		const fxB = await schedulerFixture("sess-i02-b", scopeB, {
			home: fxA.home,
			store: fxA.store,
			service: fxA.service,
		});

		let requestCount = 0;
		requestState.handle = async () => {
			requestCount += 1;
			return {
				candidates: [
					{
						kind: "decision",
						conclusion: "会话一的持久任务。",
						evidenceKind: "user_statement",
						confirmation: "confirmed",
						sourceIds: [sourceA],
						quotedSpans: [{ sourceId: sourceA, text: "持久任务" }],
						spanLocations: [{ sourceId: sourceA, match: "exact" as const, offset: 0 }],
					},
				],
				rejected: [],
				requestId: "req-i02",
			};
		};

		try {
			// A 前台忙（agent_start 未 settled）；B 的 settled 不能把 A 的忙清掉。
			await fxA.handlers.get("agent_start")?.({ type: "agent_start" }, fxA.ctx);
			await fxB.handlers.get("agent_settled")?.({ type: "agent_settled" }, fxB.ctx);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(requestCount).toBe(0);
			expect(jobRow(fxB.store, "session:sess-i02-a")?.status).toBe("pending");

			// A settled 后 B 的空闲轮可正常领取续作。
			await fxA.handlers.get("agent_settled")?.({ type: "agent_settled" }, fxA.ctx);
			await waitFor(() => jobRow(fxB.store, "session:sess-i02-a")?.status === "done");
			expect(requestCount).toBe(1);
		} finally {
			fxB.unmount();
			fxA.unmount();
			await fxB.service.close();
			fxB.store.close();
		}
	});

	it("O03/I03：本侧 abort 释放为 pending 不耗重试额度，settled 后续跑成功；真失败仍计数", async () => {
		const scope: MemoryScope = { projectId: "proj-i03", sessionId: "sess-i03" };
		const fx = await schedulerFixture("sess-i03", scope);
		const s1 = appendUserSource(fx, "构建命令固定为 pnpm build。");
		createJob(fx.store, {
			sourceScope: JSON.stringify({ sessionId: "sess-i03", projectId: "proj-i03" }),
			scopeKey: "session:sess-i03",
			createdAt: AT,
		});

		let requestCount = 0;
		// 请求挂起直到 abort：模拟前台抢占取消在途提炼。
		requestState.handle = async (_deps, input) => {
			requestCount += 1;
			const signal = input.signal;
			return new Promise<ExtractModelOutput>((resolve) => {
				const release = () =>
					resolve({
						candidates: [],
						rejected: [],
						requestId: `req-i03-abort-${requestCount}`,
						failure: { stage: "request" as const, message: "请求被取消:前台任务优先" },
					});
				if (signal?.aborted) return release();
				signal?.addEventListener("abort", release, { once: true });
			});
		};

		try {
			// 抢占：settled 领取 → agent_start abort → releaseJob 回 pending 不计失败。
			await fx.handlers.get("agent_settled")?.({ type: "agent_settled" }, fx.ctx);
			await waitFor(() => requestCount === 1);
			await fx.handlers.get("agent_start")?.({ type: "agent_start" }, fx.ctx);
			await waitFor(() => jobRow(fx.store, "session:sess-i03")?.status === "pending");
			const released = jobRow(fx.store, "session:sess-i03")!;
			expect(released.consecutive_failures).toBe(0);
			expect(released.last_error).toBeNull();

			// 抢占后空闲续跑成功（不耗额度才能继续）。
			requestState.handle = async () => {
				requestCount += 1;
				return {
					candidates: [
						{
							kind: "decision",
							conclusion: "构建命令固定为 pnpm build。",
							evidenceKind: "user_statement",
							confirmation: "confirmed",
							sourceIds: [s1],
							quotedSpans: [{ sourceId: s1, text: "pnpm build" }],
							spanLocations: [{ sourceId: s1, match: "exact" as const, offset: 0 }],
						},
					],
					rejected: [],
					requestId: "req-i03-ok",
				};
			};
			await fx.handlers.get("agent_settled")?.({ type: "agent_settled" }, fx.ctx);
			await waitFor(() => jobRow(fx.store, "session:sess-i03")?.status === "done");
			expect(requestCount).toBe(2);
			expect(jobRow(fx.store, "session:sess-i03")!.consecutive_failures).toBe(0);

			// 对照：非 abort 的请求失败仍按 consecutive_failures 计数。
			const scope2: MemoryScope = { projectId: "proj-i03-fail", sessionId: "sess-i03-fail" };
			const fx2 = await schedulerFixture("sess-i03-fail", scope2, {
				home: fx.home,
				store: fx.store,
				service: fx.service,
			});
			appendUserSource(fx2, "另一条决定。");
			createJob(fx2.store, {
				sourceScope: JSON.stringify({ sessionId: "sess-i03-fail", projectId: "proj-i03-fail" }),
				scopeKey: "session:sess-i03-fail",
				createdAt: AT,
			});
			requestState.handle = async () => {
				requestCount += 1;
				return {
					candidates: [],
					rejected: [],
					requestId: "req-i03-fail",
					failure: { stage: "request" as const, message: "请求失败:供应商 500" },
				};
			};
			await fx2.handlers.get("agent_settled")?.({ type: "agent_settled" }, fx2.ctx);
			await waitFor(() => jobRow(fx2.store, "session:sess-i03-fail")?.status === "failed");
			expect(jobRow(fx2.store, "session:sess-i03-fail")!.consecutive_failures).toBe(1);
			expect(jobRow(fx2.store, "session:sess-i03-fail")!.last_error).toContain("供应商 500");
			fx2.unmount();
		} finally {
			fx.unmount();
			await fx.service.close();
			fx.store.close();
		}
	});

	it("O14：同段多来源一批只读段文件一次（读盘次数探针）", async () => {
		// 验收口径要求的改善证据：批内 3 个来源同属同一段（同会话采集进同一
		// 段文件），readSourceEventsBatch 按段分组后整批只读 1 次段文件；
		// 改前逐来源 readMemorySource 各读一次（本场景 3 次）。
		const scope: MemoryScope = { projectId: "proj-o14-seg", sessionId: "sess-o14-seg" };
		let segmentReads = 0;
		const fx = await schedulerFixture("sess-o14-seg", scope, {
			readSegment: async (segment) => {
				segmentReads += 1;
				return readSegmentLines(segment as Parameters<typeof readSegmentLines>[0]);
			},
		});
		const s1 = appendUserSource(fx, "第一条：窗口边界。", fx.sessionId, AT);
		const s2 = appendUserSource(fx, "第二条：同段批量读。", fx.sessionId, AT2);
		const s3 = appendUserSource(fx, "第三条：同段复用。", fx.sessionId, AT3);
		// 三条来源确属同一段（同会话同采集段）。
		const segmentIds = new Set(
			[s1, s2, s3].map(
				(sourceId) =>
					(
						fx.store.db
							.prepare("SELECT segment_id FROM sources WHERE source_id = ?")
							.get(sourceId) as { segment_id: string }
					).segment_id,
			),
		);
		expect(segmentIds.size).toBe(1);
		createJob(fx.store, {
			sourceScope: JSON.stringify({ sessionId: "sess-o14-seg", projectId: scope.projectId }),
			scopeKey: "session:sess-o14-seg",
			createdAt: AT,
		});

		const seenBatches: string[][] = [];
		requestState.handle = async (_deps, input) => {
			seenBatches.push(input.entries.map((e) => e.sourceId));
			return {
				candidates: [
					{
						kind: "experience",
						conclusion: `经验-${input.entries[0]!.sourceId}`,
						evidenceKind: "user_statement",
						confirmation: "confirmed",
						sourceIds: [input.entries[0]!.sourceId],
						quotedSpans: [{ sourceId: input.entries[0]!.sourceId, text: input.entries[0]!.content.slice(0, 10) }],
						spanLocations: [{ sourceId: input.entries[0]!.sourceId, match: "exact" as const, offset: 0 }],
					},
				],
				rejected: [],
				requestId: "req-o14-seg",
			};
		};

		try {
			await fx.handlers.get("agent_settled")?.({ type: "agent_settled" }, fx.ctx);
			await waitFor(() => jobRow(fx.store, "session:sess-o14-seg")?.status === "done");
			// 3 个来源同批发出、段文件只读 1 次（改前 3 次）。
			expect(seenBatches).toEqual([[s1, s2, s3]]);
			expect(segmentReads).toBe(1);
		} finally {
			fx.unmount();
			await fx.service.close();
			fx.store.close();
		}
	});
});
