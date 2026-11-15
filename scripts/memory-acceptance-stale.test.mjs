import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runStaleScenario } from "./memory-acceptance-stale.mjs";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

async function createRunRoot(t, label) {
	const base = await mkdtemp(join(tmpdir(), `pao-i04-${label}-`));
	t.after(async () => {
		await rm(base, { recursive: true, force: true });
	});
	return {
		base,
		runRoot: join(base, "run"),
	};
}

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

async function readEvents(runRoot) {
	const text = await readFile(join(runRoot, "execution-order.jsonl"), "utf8");
	return text
		.trim()
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function assertPhaseOrder(events, expectedPhases) {
	let previous = -1;
	for (const phase of expectedPhases) {
		const index = events.findIndex((event, eventIndex) => eventIndex > previous && event.phase === phase);
		assert.notEqual(index, -1, `执行顺序缺少 ${phase}`);
		assert.ok(index > previous, `${phase} 未出现在前一阶段之后`);
		previous = index;
	}
}

function staleOutput(input, stage) {
	const source = input.entries.find((entry) => entry.content.includes("改成 top5。"));
	if (!source) throw new Error("模拟提炼输入缺少冻结的 top5 用户消息");
	const quote = "改成 top5。";
	return {
		ok: true,
		requestId: `offline-${stage}-request`,
		candidates: [
			{
				kind: "decision",
				conclusion: "自动召回每轮 top5",
				evidenceKind: "user_statement",
				confirmation: "confirmed",
				sourceIds: [source.sourceId],
				quotedSpans: [{ sourceId: source.sourceId, text: quote }],
				spanLocations: [
					{
						sourceId: source.sourceId,
						match: "exact",
						offset: source.content.indexOf(quote),
					},
				],
			},
		],
		rejected: [],
		usage: ZERO_USAGE,
	};
}

function archivedMessageText(entry) {
	return JSON.parse(entry.content).content.content;
}

function createMockExtraction(options = {}) {
	const calls = [];
	return {
		calls,
		mock: async (request) => {
			calls.push({
				stage: request.stage,
				entryContents: request.input.entries.map((entry) => entry.content),
				relatedMemoryIds: (request.input.relatedMemories ?? []).map((memory) => memory.memoryId),
				relatedMemories: structuredClone(request.input.relatedMemories ?? []),
			});
			options.onCall?.(request, calls);
			return staleOutput(request.input, request.stage);
		},
	};
}

test("未显式 executeReal=true 时不创建模型运行时", async (t) => {
	const first = await createRunRoot(t, "gate-false");
	const falseResult = await runStaleScenario({
		runRoot: first.runRoot,
		executeReal: false,
	});
	assert.equal(falseResult.status, "failed");
	assert.match(falseResult.reason, /必须提供 mockRequestExtraction/);
	assert.equal(falseResult.realModelExecuted, false);
	assert.equal(falseResult.modelCallCount, 0);
	const falseRun = await readJson(join(first.runRoot, "run.json"));
	assert.equal(falseRun.actualModelInvoked, false);
	assert.equal(falseRun.modelCallCount, 0);
	const falseEvents = await readEvents(first.runRoot);
	assert.equal(falseEvents.some((event) => event.phase === "model_stream_created"), false);

	const second = await createRunRoot(t, "gate-string");
	const stringResult = await runStaleScenario({
		runRoot: second.runRoot,
		executeReal: "true",
	});
	assert.equal(stringResult.status, "failed");
	assert.match(stringResult.reason, /executeReal 未显式设为 true/);
	assert.equal(stringResult.modelCallCount, 0);
	const stringEvents = await readEvents(second.runRoot);
	assert.equal(stringEvents.some((event) => event.phase === "offline_mock_gate_selected"), false);
	assert.equal(stringEvents.some((event) => event.phase === "model_stream_created"), false);
});

test("真实门控在 auth/models 不完整时不触达模型", async (t) => {
	const { base, runRoot } = await createRunRoot(t, "real-gate");
	const authPath = join(base, "auth.json");
	await writeFile(authPath, "{}\n", "utf8");
	const result = await runStaleScenario({
		runRoot,
		executeReal: true,
		authPath,
		modelsPath: join(base, "missing-models.json"),
		tierConfig: { tiers: {} },
	});
	assert.equal(result.status, "failed");
	assert.match(result.reason, /options\.modelsPath/);
	assert.equal(result.realModelExecuted, false);
	assert.equal(result.modelCallCount, 0);
	const events = await readEvents(runRoot);
	assert.equal(events.some((event) => event.phase === "real_gate_passed"), false);
	assert.equal(events.some((event) => event.phase === "model_stream_created"), false);
});

test("离线模拟跑真实 SessionManager/capture/desktop mutate/commit，并保留模拟顺序证据", async (t) => {
	const { base, runRoot } = await createRunRoot(t, "offline");
	const mock = createMockExtraction();
	const result = await runStaleScenario({
		runRoot,
		executeReal: false,
		mockRequestExtraction: mock.mock,
	});

	assert.equal(result.status, "incomplete");
	assert.equal(result.mode, "simulated");
	assert.equal(result.realModelExecuted, false);
	assert.equal(result.modelCallCount, 0);
	assert.equal(mock.calls.length, 2);
	assert.deepEqual(
		mock.calls.map((call) => call.stage),
		["initial", "stale"],
	);
	assert.deepEqual(mock.calls[0].relatedMemoryIds, []);
	assert.equal(mock.calls[1].relatedMemoryIds.length, 1);
	assert.deepEqual((await readdir(base)).sort(), ["run"]);
	assert.equal(
		(await readFile(join(runRoot, "workspace", ".git", "HEAD"), "utf8")).trim(),
		"ref: refs/heads/main",
	);

	const run = await readJson(join(runRoot, "run.json"));
	assert.equal(run.mode, "simulated");
	assert.equal(run.actualModelInvoked, false);
	assert.equal(run.modelCallCount, 0);

	const session = await readJson(join(runRoot, "sessions.json"));
	assert.deepEqual(
		session.initialExtractionEntries.map(archivedMessageText),
		["自动召回每轮取几条？", "目前缺省 top3。", "改成 top5。"],
	);
	assert.equal(session.chat.entries.length, 3);

	const initialModel = await readJson(join(runRoot, "extraction-initial-model.json"));
	assert.equal(initialModel.mode, "simulated");
	assert.equal(initialModel.modelInvoked, false);
	assert.equal(initialModel.provider, null);
	assert.equal(initialModel.usage, null);
	assert.deepEqual(initialModel.calls, []);
	const initialOutput = await readJson(join(runRoot, "extraction-initial-output.json"));
	assert.equal(initialOutput.candidates[0].conclusion, "自动召回每轮 top5");
	assert.equal(initialOutput.usage.cost.total, 0);
	const initialInput = await readJson(join(runRoot, "extraction-initial-input.json"));
	assert.equal("relatedMemories" in initialInput, false);
	const initialCommit = await readJson(join(runRoot, "extraction-initial-commit.json"));
	assert.equal(initialCommit.outcomes[0].status, "submitted");
	assert.equal(initialCommit.outcomes[0].revision, 1);
	const initialMemoryId = initialCommit.outcomes[0].memoryId;

	const related = await readJson(join(runRoot, "related-memories.json"));
	assert.equal(related.relatedMemories.length, 1);
	assert.equal(related.relatedMemories[0].memoryId, initialMemoryId);
	assert.equal(related.relatedMemories[0].currentRevision, 1);
	assert.equal(related.relatedMemories[0].conclusion, "自动召回每轮 top5");
	assert.equal(related.detailSnapshots[0].sources[0].sessionId, session.chat.sessionId);
	assert.deepEqual(mock.calls[1].relatedMemories, related.relatedMemories);
	const staleInput = await readJson(join(runRoot, "extraction-stale-input.json"));
	assert.deepEqual(staleInput.relatedMemories, related.relatedMemories);

	const staleCommit = await readJson(join(runRoot, "extraction-stale-commit.json"));
	assert.deepEqual(staleCommit.outcomes, [
		{
			status: "skipped",
			candidateIndex: 0,
			reason: "stale_request_snapshot",
			memoryId: initialMemoryId,
			snapshotRevision: 1,
			sourceIds: [staleInput.entries[2].sourceId],
		},
	]);
	assert.equal(staleCommit.submitted, 0);
	assert.equal(staleCommit.skipped, 1);

	const correction = await readJson(join(runRoot, "page-correction.json"));
	assert.equal(correction.result.ok, true);
	assert.equal(correction.result.revision, 2);
	assert.equal(correction.source.summary.sessionId, "desktop-page-operations");
	assert.match(correction.source.summary.entryId, /^page-operation-/);
	assert.equal(correction.source.read.ok, true);
	assert.equal(correction.source.read.events[0].content.operation, "correct");

	const finalState = await readJson(join(runRoot, "final-state.json"));
	assert.equal(finalState.top3.detail.conclusion, "自动召回每轮 top3");
	assert.equal(finalState.top3.detail.currentRevision, 2);
	assert.equal(finalState.top3.detail.needsReDiscussion, false);
	assert.equal(finalState.top3.detail.sources[0].sessionId, "desktop-page-operations");
	assert.deepEqual(finalState.staleExtraction.outcomeStatuses, ["skipped"]);
	assert.equal(
		finalState.staleExtraction.commit.outcomes[0].reason,
		"stale_request_snapshot",
	);
	assert.deepEqual(
		finalState.activeMemories.map((memory) => ({
			id: memory.id,
			revision: memory.currentRevision,
			usageState: memory.usageState,
			conclusion: memory.content.conclusion,
		})),
		[
			{
				id: initialMemoryId,
				revision: 2,
				usageState: "active",
				conclusion: "自动召回每轮 top3",
			},
		],
	);
	assert.equal(finalState.criteria.pageCorrectionSucceeded, true);
	assert.equal(finalState.criteria.top3Active, true);
	assert.equal(finalState.criteria.onlyTop3Active, true);
	assert.equal(finalState.criteria.top3Conclusion, true);
	assert.equal(finalState.criteria.top3Revision2, true);
	assert.equal(finalState.criteria.top3HasPageSource, true);
	assert.equal(finalState.criteria.staleSkippedByRequestSnapshot, true);
	assert.equal(finalState.criteria.noActiveTop5, true);

	const embedding = await readJson(join(runRoot, "embedding.json"));
	assert.equal(embedding.enabled, false);
	assert.equal(embedding.r1.status, "skipped");
	assert.equal(embedding.r2, null);
	assert.deepEqual(result.semanticSample, { status: "not_requested" });

	const sources = await readJson(join(runRoot, "sources.json"));
	assert.equal(sources.aliases["src-sess-e-001"].entryId, session.chat.entries[2].id);
	assert.equal(sources.aliases["src-sess-e-001"].eventType, "user");
	assert.equal(sources.aliases["src-sess-e-page-001"].sessionId, "desktop-page-operations");
	assert.match(sources.aliases["src-sess-e-page-001"].entryId, /^page-operation-/);

	const events = await readEvents(runRoot);
	assertPhaseOrder(events, [
		"stale_parsed_result_ready",
		"page_correction_finished",
		"stale_result_released",
		"stale_candidates_commit_started",
		"stale_candidates_committed",
	]);
	assert.equal(events.every((event) => event.simulated === true), true);
	assert.equal(events.some((event) => event.phase === "model_stream_created"), false);
	assert.equal(run.artifacts.home.startsWith(`${runRoot}\\`) || run.artifacts.home.startsWith(`${runRoot}/`), true);
});

test("signal 取消迟到交付后保留 cancelled 与 failure 记录", async (t) => {
	const { runRoot } = await createRunRoot(t, "cancel");
	const controller = new AbortController();
	const mock = createMockExtraction({
		onCall(request) {
			if (request.stage === "stale") controller.abort(new Error("test cancellation"));
		},
	});
	const result = await runStaleScenario({
		runRoot,
		executeReal: false,
		mockRequestExtraction: mock.mock,
		signal: controller.signal,
	});
	assert.equal(result.status, "cancelled");
	assert.equal(result.realModelExecuted, false);
	assert.equal(result.modelCallCount, 0);
	const failure = await readJson(join(runRoot, "failure.json"));
	assert.equal(failure.status, "cancelled");
	assert.equal(failure.error.name, "AbortError");
	const events = await readEvents(runRoot);
	assert.equal(events.some((event) => event.phase === "stale_parsed_result_ready"), true);
	assert.equal(events.some((event) => event.phase === "run_cancelled"), true);
	assert.equal(events.some((event) => event.phase === "model_stream_created"), false);
	const staleInput = await readJson(join(runRoot, "extraction-stale-input.json"));
	assert.equal(staleInput.entries.length, 3);
	assert.equal(staleInput.relatedMemories.length, 1);
});
