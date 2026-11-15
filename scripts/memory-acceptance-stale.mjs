import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { ModelRegistry, ModelRuntime, SessionManager } from "../PAO/packages/coding-agent/dist/index.js";
import { ReadOnlyAuthStorage } from "../PAO/packages/coding-agent/dist/core/auth-storage.js";
import { InMemoryCodingAgentModelsStore } from "../PAO/packages/coding-agent/dist/core/models-store.js";
import {
	commitExtractionCandidates,
	createCapture,
	initializeMemoryConfig,
	openMemoryService,
	resolveMemoryScope,
	requestExtraction,
} from "../PAO/packages/coding-agent/dist/pao/memory/index.js";
import { openMemoryStore } from "../PAO/packages/coding-agent/dist/pao/memory/store.js";
import { embedCurrentMemories, resolveMemoryOutboundContext } from "../PAO/packages/coding-agent/dist/pao/memory/runtime-embedding.js";
import {
	mutateDesktopMemory,
	readDesktopMemoryDetail,
	readDesktopMemoryList,
	readDesktopMemorySource,
} from "../PAO/packages/coding-agent/dist/pao/desktop/index.js";
import { loadTierConfig } from "../PAO/packages/coding-agent/dist/pao/routing/config.js";
import { ensureFixtureGitWorkspace } from "../PAO/packages/coding-agent/scripts/memory-acceptance-fixture-git.mjs";
import { runSynonymAcceptance } from "../PAO/packages/coding-agent/scripts/memory-semantic-validation.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const FROZEN_SCENARIO_PATH = join(
	REPO_ROOT,
	"PAO",
	"packages",
	"coding-agent",
	"test",
	"pao",
	"fixtures",
	"memory",
	"scenarios",
	"I04.json",
);
const PAGE_OPERATION_SESSION_ID = "desktop-page-operations";
const SOURCE_ALIAS_CHAT = "src-sess-e-001";
const SOURCE_ALIAS_PAGE = "src-sess-e-page-001";
const MEMORY_ALIAS_TOP3 = "mem-recall-top3";
const MEMORY_ALIAS_TOP5 = "mem-recall-top5";

class GateError extends Error {
	name = "GateError";
}

class ScenarioFailure extends Error {
	name = "ScenarioFailure";
}

function nowIso() {
	return new Date().toISOString();
}

function normalizeConclusion(text) {
	return String(text ?? "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ");
}

function isTop3(text) {
	return /top\s*3\b/i.test(String(text ?? ""));
}

function isTop5(text) {
	return /top\s*5\b/i.test(String(text ?? ""));
}

function serializeError(error) {
	return {
		name: error instanceof Error ? error.name : "Error",
		message: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error ? error.stack : undefined,
	};
}

function requireNonEmptyString(value, field) {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new GateError(`${field} 必须是非空字符串`);
	}
	return value;
}

function requireReadableFile(path, field) {
	const absolute = resolve(requireNonEmptyString(path, field));
	if (!existsSync(absolute) || !statSync(absolute).isFile()) {
		throw new GateError(`${field} 指向的文件不存在或不是普通文件：${absolute}`);
	}
	return absolute;
}

function prepareRunRoot(input) {
	const runRoot = resolve(requireNonEmptyString(input, "options.runRoot"));
	mkdirSync(runRoot, { recursive: true });
	if (readdirSync(runRoot).length > 0) {
		throw new GateError(`options.runRoot 必须为空，避免覆盖已有验收数据：${runRoot}`);
	}
	return runRoot;
}

function createDirs(runRoot) {
	const paths = {
		run: join(runRoot, "run.json"),
		failure: join(runRoot, "failure.json"),
		executionOrder: join(runRoot, "execution-order.jsonl"),
		frozenInput: join(runRoot, "frozen-input", "I04.json"),
		session: join(runRoot, "sessions.json"),
		sources: join(runRoot, "sources.json"),
		related: join(runRoot, "related-memories.json"),
		initialInput: join(runRoot, "extraction-initial-input.json"),
		initialOutput: join(runRoot, "extraction-initial-output.json"),
		initialModel: join(runRoot, "extraction-initial-model.json"),
		initialCommit: join(runRoot, "extraction-initial-commit.json"),
		embedding: join(runRoot, "embedding.json"),
		staleInput: join(runRoot, "extraction-stale-input.json"),
		staleOutput: join(runRoot, "extraction-stale-output.json"),
		staleModel: join(runRoot, "extraction-stale-model.json"),
		staleCommit: join(runRoot, "extraction-stale-commit.json"),
		correction: join(runRoot, "page-correction.json"),
		semanticSample: join(runRoot, "semantic-sample.json"),
		ledger: join(runRoot, "ledger-session.json"),
		finalState: join(runRoot, "final-state.json"),
		home: join(runRoot, "home"),
		agent: join(runRoot, "agent"),
		workspace: join(runRoot, "workspace"),
		sessions: join(runRoot, "sessions"),
	};
	mkdirSync(dirname(paths.frozenInput), { recursive: true });
	mkdirSync(paths.workspace, { recursive: true });
	mkdirSync(paths.sessions, { recursive: true });
	mkdirSync(paths.home, { recursive: true });
	mkdirSync(paths.agent, { recursive: true });
	writeFileSync(paths.executionOrder, "", "utf8");
	return paths;
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeFixtureOutboundPermission(home, executionRoot) {
	const { project } = resolveMemoryOutboundContext(home, executionRoot);
	const configDir = join(home, "知识库配置");
	const path = join(configDir, "外发许可.json");
	mkdirSync(configDir, { recursive: true });
	writeJson(path, {
		projects: {
			[project]: {
				allowed: true,
				asOf: "2099-12-31",
			},
		},
	});
	return { path, project };
}

async function embedWithFixturePermission(input) {
	const previous = process.env.PAO_OUTBOUND_CONFIG;
	process.env.PAO_OUTBOUND_CONFIG = input.permissionPath;
	try {
		return await embedCurrentMemories({
			home: input.home,
			db: input.db,
			projectId: input.scope.projectId,
			executionPath: input.scope.executionRoot,
			ledger: input.ledger,
			requestId: input.requestId,
			attribution: input.attribution,
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});
	} finally {
		if (previous === undefined) delete process.env.PAO_OUTBOUND_CONFIG;
		else process.env.PAO_OUTBOUND_CONFIG = previous;
	}
}

function vectorEvidence(store, memoryId, revisions) {
	if (revisions.length === 0) return [];
	const placeholders = revisions.map(() => "?").join(",");
	return store.db
		.prepare(
			`SELECT memory_id, revision, model, dimension, length(vector) AS byte_length
			 FROM memory_vectors
			 WHERE memory_id = ? AND revision IN (${placeholders})
			 ORDER BY revision, model`,
		)
		.all(memoryId, ...revisions);
}

function createRecorder(paths, executeReal) {
	let sequence = 0;
	const record = (phase, details = {}) => {
		sequence += 1;
		const event = {
			seq: sequence,
			at: nowIso(),
			phase,
			mode: executeReal ? "real" : "simulated",
			...(executeReal ? {} : { simulated: true }),
			...details,
		};
		appendFileSync(paths.executionOrder, `${JSON.stringify(event)}\n`, "utf8");
		return event;
	};
	Object.defineProperty(record, "count", {
		get() {
			return sequence;
		},
	});
	return record;
}

function abortError(signal) {
	const error = new Error("操作已取消", { cause: signal?.reason });
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal) {
	if (signal?.aborted) throw abortError(signal);
}

function waitForRelease(releasePromise, signal) {
	if (!signal) return releasePromise;
	if (signal.aborted) return Promise.reject(abortError(signal));
	return new Promise((resolvePromise, rejectPromise) => {
		const onAbort = () => {
			cleanup();
			rejectPromise(abortError(signal));
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		releasePromise.then(
			(value) => {
				cleanup();
				resolvePromise(value);
			},
			(error) => {
				cleanup();
				rejectPromise(error);
			},
		);
	});
}

function createDeliveryGate(signal, record, kind) {
	let release;
	const released = new Promise((resolvePromise) => {
		release = resolvePromise;
	});
	let resolveReady;
	let readyResolved = false;
	const ready = new Promise((resolvePromise) => {
		resolveReady = resolvePromise;
	});
	return {
		ready,
		markReady(details = {}) {
			if (readyResolved) return;
			readyResolved = true;
			record(kind === "real" ? "stale_stream_result_ready" : "stale_parsed_result_ready", {
				deliveryGate: kind,
				...details,
			});
			resolveReady(details);
		},
		release(reason) {
			record("stale_result_released", { deliveryGate: kind, reason });
			release();
		},
		async waitForRelease() {
			await waitForRelease(released, signal);
		},
	};
}

function costEvidence(message, simulated) {
	const usage = message?.usage;
	const normalizedTotal = usage?.cost?.total;
	const finite = typeof normalizedTotal === "number" && Number.isFinite(normalizedTotal);
	const positive = finite && normalizedTotal > 0;
	return {
		providerFee: "unknown",
		normalizedTotal: finite ? normalizedTotal : null,
		amount: positive ? normalizedTotal : null,
		currency: positive ? "USD" : "unknown",
		source: simulated
			? "simulated"
			: positive
				? "provider_or_catalog_normalized_nonzero"
				: "unknown",
		zeroNormalizationTreatedAsUnknown: finite && normalizedTotal === 0,
	};
}

function sanitizeStreamOptions(options = {}) {
	return {
		maxTokens: options.maxTokens,
		reasoning: options.reasoning,
		signalProvided: options.signal instanceof AbortSignal,
	};
}

function createRecordingRegistry(baseRegistry, state) {
	return {
		find(provider, modelId) {
			return baseRegistry.find(provider, modelId);
		},
		streamSimple(model, context, options = {}) {
			const stage = state.activeStage ?? "unknown";
			const call = {
				stage,
				index: state.calls.length,
				provider: model.provider,
				model: model.id,
				api: model.api,
				requestedAt: nowIso(),
				context,
				options: sanitizeStreamOptions(options),
				rawResponse: null,
				usage: null,
				responseId: null,
				latencyMs: null,
				cost: costEvidence(null, false),
			};
			state.calls.push(call);
			state.actualModelCalls += 1;
			state.record("model_stream_created", {
				stage,
				callIndex: call.index,
				provider: call.provider,
				model: call.model,
			});
			const started = performance.now();
			let stream;
			try {
				stream = baseRegistry.streamSimple(model, context, options);
			} catch (error) {
				call.latencyMs = performance.now() - started;
				call.error = serializeError(error);
				state.record("model_stream_failed", {
					stage,
					callIndex: call.index,
					error: call.error,
					latencyMs: call.latencyMs,
				});
				throw error;
			}
			return {
				async result() {
					try {
						const message = await stream.result();
						call.latencyMs = performance.now() - started;
						call.rawResponse = message;
						call.usage = message.usage ?? null;
						call.responseId = message.responseId ?? null;
						call.actualModel = message.responseModel ?? message.model ?? call.model;
						call.cost = costEvidence(message, false);
						state.record("model_stream_result_received", {
							stage,
							callIndex: call.index,
							provider: message.provider ?? call.provider,
							model: call.actualModel,
							responseId: call.responseId,
							usage: call.usage,
							cost: call.cost,
							latencyMs: call.latencyMs,
						});
						if (stage === "stale" && state.staleGate) {
							state.staleGate.markReady({
								stage,
								callIndex: call.index,
								provider: message.provider ?? call.provider,
								model: call.actualModel,
								responseId: call.responseId,
							});
							await state.staleGate.waitForRelease();
						}
						state.record("model_stream_result_delivered_to_request", {
							stage,
							callIndex: call.index,
						});
						return message;
					} catch (error) {
						call.latencyMs = performance.now() - started;
						call.error = serializeError(error);
						state.record("model_stream_result_failed", {
							stage,
							callIndex: call.index,
							error: call.error,
							latencyMs: call.latencyMs,
						});
						throw error;
					}
				},
			};
		},
	};
}

function modelEvidenceForStage(state, stage, requestId, totalLatencyMs) {
	const calls = state.calls.filter((call) => call.stage === stage);
	const primary = calls[0];
	return {
		mode: state.executeReal ? "real" : "simulated",
		requestId: requestId ?? null,
		modelInvoked: calls.length > 0,
		callCount: calls.length,
		provider: primary?.provider ?? null,
		model: primary?.actualModel ?? primary?.model ?? null,
		responseId: primary?.responseId ?? null,
		usage: primary?.usage ?? null,
		totalLatencyMs,
		calls: calls.map((call) => ({
			...call,
			requestId: requestId ?? null,
			cost: call.cost ?? costEvidence(null, !state.executeReal),
		})),
	};
}

function readFrozenScenario() {
	const text = readFileSync(FROZEN_SCENARIO_PATH, "utf8");
	const value = JSON.parse(text);
	if (value?.id !== "I04" || !Array.isArray(value.sessions)) {
		throw new GateError(`冻结 I04 输入格式不匹配：${FROZEN_SCENARIO_PATH}`);
	}
	return { text, value };
}

function appendFrozenMessages(sessionManager, scenarios) {
	const messages = scenarios.find((scenario) => scenario.sessionId === "sess-e")?.messages;
	if (!Array.isArray(messages) || messages.length === 0) {
		throw new GateError("冻结 I04 缺少 sess-e 原始消息");
	}
	const entryIds = [];
	for (const frozen of messages) {
		if (frozen.role !== "user" && frozen.role !== "assistant") {
			throw new GateError(`冻结 I04 含不支持的消息角色：${String(frozen.role)}`);
		}
		const timestamp = Date.parse(frozen.timestamp);
		if (!Number.isFinite(timestamp)) {
			throw new GateError(`冻结 I04 消息时间非法：${String(frozen.timestamp)}`);
		}
		const entryId = sessionManager.appendMessage({
			role: frozen.role,
			content: frozen.content,
			timestamp,
		});
		entryIds.push(entryId);
	}
	sessionManager.flush();
	return entryIds;
}

function pageCorrectionFromFrozen(frozen) {
	const pageSession = frozen.sessions.find((scenario) => scenario.sessionId === "sess-e-page");
	const content = pageSession?.messages?.[0]?.content;
	if (typeof content !== "string") throw new GateError("冻结 I04 缺少页面纠正原文");
	const match = /「([^」]+)」纠正为「([^」]+)」/.exec(content);
	if (!match) throw new GateError(`无法从冻结页面操作原文提取纠正目标：${content}`);
	return {
		originalConclusion: match[1],
		replacementConclusion: match[2],
		pageOperationText: content,
	};
}

async function buildExtractionEntries(service, sourceRefs) {
	const entries = [];
	for (const ref of sourceRefs) {
		const read = await service.readMemorySource({
			sourceId: ref.sourceId,
			offset: 0,
			limit: 1,
		});
		if (!read.ok) {
			throw new ScenarioFailure(`来源回读失败 ${ref.sourceId}: ${read.error.message}`);
		}
		entries.push({
			sourceId: ref.sourceId,
			entryId: ref.entryId,
			eventType: ref.eventType,
			content: read.content,
		});
	}
	return entries;
}

async function relatedMemoriesFromPage(listInput) {
	const list = await readDesktopMemoryList(listInput);
	if (!list.ok) throw new ScenarioFailure(`读取 relatedMemories 失败：${list.error.message}`);
	const related = [];
	const details = [];
	for (const item of list.items) {
		const detail = await readDesktopMemoryDetail({ home: listInput.home, id: item.memoryId });
		if (!detail.ok) throw new ScenarioFailure(`读取记忆详情失败 ${item.memoryId}: ${detail.error.message}`);
		details.push(detail);
		related.push({
			memoryId: detail.memory.id,
			kind: detail.memory.kind,
			currentRevision: detail.currentRevision,
			conclusion: detail.memory.content.conclusion,
			...(detail.memory.content.conditions === undefined
				? {}
				: { conditions: detail.memory.content.conditions }),
			confirmation: detail.memory.content.confirmation,
			usageState: detail.memory.usageState,
		});
	}
	return { related, details, list };
}

function outcomeForCandidate(commit, candidates, predicate) {
	if (!commit) return undefined;
	for (const outcome of commit.outcomes) {
		const candidate = candidates[outcome.candidateIndex];
		if (candidate && predicate(candidate)) return outcome;
	}
	return undefined;
}

function observableRevisions(store, scope) {
	const rows = store.db
		.prepare(
			`SELECT m.id, m.kind, m.current_revision, m.usage_state, m.merged_into,
			        m.created_at, m.updated_at, r.content_json
			 FROM memories m
			 JOIN memory_revisions r ON r.memory_id = m.id AND r.revision = m.current_revision
			 WHERE json_extract(m.scope_json, '$.projectId') = ?
			 ORDER BY m.updated_at, m.id`,
		)
		.all(scope.projectId);
	return rows.map((row) => ({
		id: row.id,
		kind: row.kind,
		currentRevision: row.current_revision,
		usageState: row.usage_state,
		mergedInto: row.merged_into,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		content: JSON.parse(row.content_json),
	}));
}

function revisionLinksFor(store, memoryIds) {
	if (memoryIds.length === 0) return [];
	const placeholders = memoryIds.map(() => "?").join(",");
	return store.db
		.prepare(
			`SELECT memory_id, revision, relation, target_memory_id, target_revision
			 FROM revision_links
			 WHERE memory_id IN (${placeholders}) OR target_memory_id IN (${placeholders})
			 ORDER BY memory_id, revision, relation, target_memory_id`,
		)
		.all(...memoryIds, ...memoryIds);
}

async function performExtraction({
	stage,
	jobId,
	sourceSessionId,
	entries,
	relatedMemories,
	signal,
	executeReal,
	registry,
	mockRequestExtraction,
	tierConfig,
	tierName,
	modelRuntime,
	onStarted,
}) {
	const input = {
		jobId,
		sourceSessionId,
		entries,
		...(relatedMemories.length > 0 ? { relatedMemories } : {}),
		...(signal ? { signal } : {}),
	};
	onStarted?.(input);
	const startedAt = nowIso();
	const started = performance.now();
	if (executeReal) {
		modelRuntime.activeStage = stage;
		try {
			return {
				input,
				startedAt,
				output: await requestExtraction(
					{
						modelRegistry: registry,
						ledger: modelRuntime.ledger,
						tierConfig,
						tierName,
					},
					input,
				),
				latencyMs: performance.now() - started,
			};
		} finally {
			modelRuntime.activeStage = undefined;
		}
	}
	const output = await mockRequestExtraction({
		stage,
		input,
		mode: "simulated",
		signal,
	});
	if (!output || typeof output !== "object" || typeof output.ok !== "boolean") {
		throw new ScenarioFailure(`离线 mockRequestExtraction 在 ${stage} 未返回 MemoryResult 形状`);
	}
	if (stage === "stale" && modelRuntime.staleGate) {
		modelRuntime.staleGate.markReady({
			stage,
			mock: true,
			requestId: output.requestId ?? null,
		});
		await modelRuntime.staleGate.waitForRelease();
	}
	return {
		input,
		startedAt,
		output,
		latencyMs: performance.now() - started,
	};
}

function summarizeNeedsReDiscussion(detail) {
	return {
		memoryId: detail.memory.id,
		conclusion: detail.memory.content.conclusion,
		confirmation: detail.memory.content.confirmation,
		usageState: detail.memory.usageState,
		currentRevision: detail.currentRevision,
		needsReDiscussion: detail.memory.content.needsReDiscussion === true,
		sources: detail.sources,
	};
}

/**
 * 执行 I04：页面纠正后旧提炼结果返回。
 *
 * @param {{
 *   runRoot: string,
 *   executeReal?: boolean,
 *   signal?: AbortSignal,
 *   mockRequestExtraction?: Function,
 *   authPath?: string,
 *   modelsPath?: string,
 *   tierConfig?: object,
 *   tierConfigPath?: string,
 *   tierName?: string,
 *   scope?: { taskId?: string, department?: string },
 *   allowFixtureEmbedding?: boolean,
 *   semanticSample?: boolean,
 * }} options
 */
export async function runStaleScenario(options = {}) {
	const runRoot = prepareRunRoot(options.runRoot);
	const executeReal = options.executeReal === true;
	const allowFixtureEmbedding = options.allowFixtureEmbedding === true;
	const semanticSample = options.semanticSample === true;
	const paths = createDirs(runRoot);
	await ensureFixtureGitWorkspace(runRoot, paths.workspace);
	const record = createRecorder(paths, executeReal);
	const runId = `i04-${randomUUID()}`;
	const startedAt = nowIso();
	const started = performance.now();
	const signal = options.signal;
	const state = {
		executeReal,
		activeStage: undefined,
		staleGate: undefined,
		calls: [],
		actualModelCalls: 0,
		record,
	};
	let service;
	let store;
	let result;
	const cleanupErrors = [];

	try {
		throwIfAborted(signal);
		if (semanticSample && (!executeReal || !allowFixtureEmbedding)) {
			throw new GateError("semanticSample=true 需要 executeReal=true 且 allowFixtureEmbedding=true");
		}
		const { text: frozenText, value: frozen } = readFrozenScenario();
		writeFileSync(paths.frozenInput, frozenText, "utf8");
		record("frozen_i04_loaded", {
			sourcePath: FROZEN_SCENARIO_PATH,
			sessionCount: frozen.sessions.length,
		});

		if (executeReal) {
			if (typeof options.mockRequestExtraction === "function") {
				throw new GateError("executeReal=true 时禁止提供 mockRequestExtraction");
			}
			const authPath = requireReadableFile(options.authPath, "options.authPath");
			const modelsPath = requireReadableFile(options.modelsPath, "options.modelsPath");
			let tierConfig = options.tierConfig;
			let tierConfigSource = "object";
			if (tierConfig === undefined) {
				const tierConfigPath = requireReadableFile(options.tierConfigPath, "options.tierConfigPath");
				tierConfig = loadTierConfig(tierConfigPath);
				tierConfigSource = "file";
			}
			if (!tierConfig || typeof tierConfig !== "object") {
				throw new GateError("executeReal=true 需要 options.tierConfig 或 options.tierConfigPath");
			}
			record("real_gate_passed", {
				authPath,
				modelsPath,
				tierConfigSource,
				tierName: options.tierName ?? "fast",
				credentialStore: "ReadOnlyAuthStorage",
				modelsStore: "InMemoryCodingAgentModelsStore",
				allowModelNetwork: false,
				refreshOnCreate: false,
			});
			const runtime = await ModelRuntime.create({
				credentials: new ReadOnlyAuthStorage(authPath),
				modelsPath,
				modelsStore: new InMemoryCodingAgentModelsStore(),
				allowModelNetwork: false,
				refreshOnCreate: false,
				signal,
			});
			state.baseRegistry = new ModelRegistry(runtime);
			state.registry = createRecordingRegistry(state.baseRegistry, state);
			state.tierConfig = tierConfig;
			state.tierName = options.tierName ?? "fast";
		} else {
			if (typeof options.mockRequestExtraction !== "function") {
				throw new GateError("executeReal 未显式设为 true 时，必须提供 mockRequestExtraction");
			}
			record("offline_mock_gate_selected", {
				modelRuntimeCreated: false,
				realModelCalls: 0,
			});
		}

		const workspace = paths.workspace;
		const chatSession = SessionManager.create(workspace, paths.sessions, {
			id: `session-${randomUUID()}`,
		});
		const ledgerSession = SessionManager.create(workspace, paths.sessions, {
			id: `ledger-${randomUUID()}`,
		});
		ledgerSession.flush();
		state.ledger = ledgerSession;
		const entryIds = appendFrozenMessages(chatSession, frozen.sessions);
		record("frozen_session_entries_appended", {
			logicalSessionId: "sess-e",
			actualSessionId: chatSession.getSessionId(),
			entryIds,
			sessionFile: chatSession.getSessionFile(),
		});

		initializeMemoryConfig(paths.home);
		service = openMemoryService({ paoHome: paths.home, mode: "readwrite" });
		store = openMemoryStore(paths.home, "readwrite");
		const capture = createCapture({ store, paoHome: paths.home });
		capture.registerSession(chatSession.getSessionId(), chatSession.getSessionFile());
		const captured = capture.captureCommittedEntries(
			chatSession.getSessionId(),
			entryIds.map((entryId) => chatSession.getEntry(entryId)).filter(Boolean),
		);
		record("capture_committed", { captured });
		const sourceRefs = [];
		for (const entryId of entryIds) {
			const entry = chatSession.getEntry(entryId);
			if (entry?.type !== "message") continue;
			const eventType = entry.message.role;
			const sourceId = capture.sourceForEntry(chatSession.getSessionId(), entryId, eventType);
			if (!sourceId) throw new ScenarioFailure(`真实会话条目未生成 source：${entryId}`);
			sourceRefs.push({
				sourceId,
				sessionId: chatSession.getSessionId(),
				entryId,
				eventType,
			});
		}
		const extractionEntries = await buildExtractionEntries(service, sourceRefs);
		const chatSourceAlias = sourceRefs[sourceRefs.length - 1] ?? sourceRefs[0];
		writeJson(paths.session, {
			logicalSessions: {
				"sess-e": chatSession.getSessionId(),
				"sess-e-page": PAGE_OPERATION_SESSION_ID,
			},
			chat: {
				sessionId: chatSession.getSessionId(),
				sessionFile: chatSession.getSessionFile(),
				entries: chatSession.getEntries(),
			},
			ledger: {
				sessionId: ledgerSession.getSessionId(),
				sessionFile: ledgerSession.getSessionFile(),
			},
			captured,
			initialExtractionEntries: extractionEntries,
		});

		const scope = resolveMemoryScope(workspace, {
			sessionId: chatSession.getSessionId(),
			...(typeof options.scope?.taskId === "string" && options.scope.taskId.trim()
				? { taskId: options.scope.taskId.trim() }
				: {}),
			...(typeof options.scope?.department === "string" && options.scope.department.trim()
				? { department: options.scope.department.trim() }
				: {}),
		});
		const initialJobId = `${runId}:initial`;
		const staleJobId = `${runId}:stale`;
		const initial = await performExtraction({
			stage: "initial",
			jobId: initialJobId,
			sourceSessionId: chatSession.getSessionId(),
			entries: extractionEntries,
			relatedMemories: [],
			signal,
			executeReal,
			registry: state.registry,
			mockRequestExtraction: options.mockRequestExtraction,
			tierConfig: state.tierConfig,
			tierName: state.tierName,
			modelRuntime: state,
			onStarted(input) {
				writeJson(paths.initialInput, input);
				record("initial_extraction_started", {
					jobId: initialJobId,
					entryCount: input.entries.length,
				});
			},
		});
		throwIfAborted(signal);
		writeJson(paths.initialOutput, initial.output);
		writeJson(
			paths.initialModel,
			modelEvidenceForStage(
				state,
				"initial",
				initial.output?.requestId,
				initial.latencyMs,
			),
		);
		record("initial_extraction_finished", {
			requestId: initial.output?.requestId ?? null,
			ok: initial.output?.ok ?? false,
			failure: initial.output?.failure ?? initial.output?.error ?? null,
			candidateCount: initial.output?.candidates?.length ?? 0,
			rejectedCount: initial.output?.rejected?.length ?? 0,
			latencyMs: initial.latencyMs,
		});
		if (
			!initial.output?.ok ||
			initial.output.failure !== undefined ||
			!Array.isArray(initial.output.candidates) ||
			initial.output.candidates.length === 0
		) {
			throw new ScenarioFailure("初始提炼没有可提交候选，页面纠正场景无法建立 top5");
		}
		record("initial_candidates_commit_started", {
			jobId: initialJobId,
			candidateCount: initial.output.candidates.length,
		});
		const initialCommit = await commitExtractionCandidates(store, service, {
			jobId: initialJobId,
			scope,
			candidates: initial.output.candidates,
			relatedMemories: initial.input.relatedMemories ?? [],
			sourceRefs,
			now: nowIso(),
		});
		writeJson(paths.initialCommit, initialCommit);
		record("initial_candidates_committed", {
			jobId: initialJobId,
			outcomes: initialCommit.outcomes,
		});
		const top5Outcome = outcomeForCandidate(
			initialCommit,
			initial.output.candidates,
			(candidate) => isTop5(candidate.conclusion),
		);
		if (top5Outcome?.status !== "submitted") {
			throw new ScenarioFailure("初始提炼的 top5 候选没有实际提交为新记忆");
		}
		const initialTop5Id = top5Outcome.memoryId;
		const initialTop5Revision = top5Outcome.revision;
		const embeddingEvidence = {
			mode: executeReal ? "real" : "simulated",
			enabled: executeReal && allowFixtureEmbedding,
			permission: null,
			r1: null,
			r2: null,
			vectors: [],
		};
		if (executeReal && allowFixtureEmbedding) {
			const permission = writeFixtureOutboundPermission(paths.home, scope.executionRoot);
			embeddingEvidence.permission = permission;
			const r1 = await embedWithFixturePermission({
				home: paths.home,
				db: store.db,
				scope,
				ledger: ledgerSession,
				requestId: `${runId}:embed:r1`,
				attribution: {
					acceptanceId: "I04",
					jobId: initialJobId,
					sourceSessionId: chatSession.getSessionId(),
					phase: "r1-current-before-page-correction",
				},
				permissionPath: permission.path,
				signal,
			});
			embeddingEvidence.r1 = r1;
			embeddingEvidence.vectors = vectorEvidence(store, initialTop5Id, [initialTop5Revision]);
			writeJson(paths.embedding, embeddingEvidence);
			record("revision_1_embedding_finished", {
				embedded: r1.embedded,
				skipped: r1.skipped,
				skippedByPolicy: r1.skippedByPolicy,
				reason: r1.reason ?? null,
			});
			if (r1.skippedByPolicy || r1.embedded !== 1) {
				throw new ScenarioFailure(
					r1.skippedByPolicy
						? `r1 嵌入被许可或配置门槛跳过：${r1.reason ?? "unknown"}`
						: `r1 未产生预期的一条产品向量：embedded=${r1.embedded}`,
				);
			}
		} else {
			embeddingEvidence.r1 = {
				status: "skipped",
				reason: executeReal
					? "allowFixtureEmbedding 未显式为 true"
					: "executeReal 未显式为 true",
			};
			writeJson(paths.embedding, embeddingEvidence);
			record("revision_1_embedding_skipped", {
				reason: embeddingEvidence.r1.reason,
			});
		}

		const relatedSnapshot = await relatedMemoriesFromPage({
			home: paths.home,
			scope,
			query: "",
			status: "active",
			pageSize: 200,
		});
		writeJson(paths.related, {
			relatedMemories: relatedSnapshot.related,
			detailSnapshots: relatedSnapshot.details.map(summarizeNeedsReDiscussion),
		});
		record("related_memories_snapshotted", {
			count: relatedSnapshot.related.length,
			memoryIds: relatedSnapshot.related.map((memory) => memory.memoryId),
		});

		const deliveryGate = createDeliveryGate(
			signal,
			record,
			executeReal ? "real" : "simulated",
		);
		state.staleGate = deliveryGate;
		const stalePromise = performExtraction({
			stage: "stale",
			jobId: staleJobId,
			sourceSessionId: chatSession.getSessionId(),
			entries: extractionEntries,
			relatedMemories: relatedSnapshot.related,
			signal,
			executeReal,
			registry: state.registry,
			mockRequestExtraction: options.mockRequestExtraction,
			tierConfig: state.tierConfig,
			tierName: state.tierName,
			modelRuntime: state,
			onStarted(input) {
				writeJson(paths.staleInput, input);
				record("stale_extraction_started", {
					jobId: staleJobId,
					entryCount: input.entries.length,
					relatedMemoryCount: input.relatedMemories?.length ?? 0,
				});
			},
		});
		void stalePromise.catch(() => {});
		const first = await Promise.race([
			deliveryGate.ready.then((details) => ({ kind: "ready", details })),
			stalePromise.then(
				(value) => ({ kind: "finished", value }),
				(error) => ({ kind: "error", error }),
			),
		]);

		let correction;
		let correctionSource;
		if (first.kind === "ready") {
			throwIfAborted(signal);
			const page = pageCorrectionFromFrozen(frozen);
			correction = await mutateDesktopMemory({
				home: paths.home,
				op: {
					op: "correct",
					id: initialTop5Id,
					expectedRevision: initialTop5Revision,
					replacement: {
						conclusion: page.replacementConclusion,
						evidenceKind: "user_statement",
						confirmation: "confirmed",
					},
				},
			});
			const correctedDetail = await readDesktopMemoryDetail({ home: paths.home, id: initialTop5Id });
			if (correctedDetail.ok) {
				const pageSource = correctedDetail.sources.find(
					(source) => source.sessionId === PAGE_OPERATION_SESSION_ID,
				);
				if (pageSource) {
					const read = await readDesktopMemorySource({
						home: paths.home,
						sourceId: pageSource.sourceId,
					});
					correctionSource = { summary: pageSource, read };
				}
			}
			writeJson(paths.correction, {
				requestedAt: nowIso(),
				frozenPageOperation: page.pageOperationText,
				initialMemoryId: initialTop5Id,
				expectedRevision: initialTop5Revision,
				result: correction,
				source: correctionSource,
			});
			record("page_correction_finished", {
				deliveryWasHeld:
					executeReal ? "real_stream_result" : "simulated_parsed_result",
				ok: correction.ok,
				revision: correction.ok ? correction.revision : null,
			});
			if (correction.ok && executeReal && allowFixtureEmbedding) {
				const r2 = await embedWithFixturePermission({
					home: paths.home,
					db: store.db,
					scope,
					ledger: ledgerSession,
					requestId: `${runId}:embed:r2`,
					attribution: {
						acceptanceId: "I04",
						jobId: staleJobId,
						sourceSessionId: PAGE_OPERATION_SESSION_ID,
						phase: "r2-after-page-correction",
					},
					permissionPath: embeddingEvidence.permission.path,
					signal,
				});
				embeddingEvidence.r2 = r2;
				embeddingEvidence.vectors = vectorEvidence(store, initialTop5Id, [
					initialTop5Revision,
					correction.revision,
				]);
				writeJson(paths.embedding, embeddingEvidence);
				record("revision_2_embedding_finished", {
					embedded: r2.embedded,
					skipped: r2.skipped,
					skippedByPolicy: r2.skippedByPolicy,
					reason: r2.reason ?? null,
				});
				if (r2.skippedByPolicy || r2.embedded !== 1) {
					throw new ScenarioFailure(
						r2.skippedByPolicy
							? `r2 嵌入被许可或配置门槛跳过：${r2.reason ?? "unknown"}`
							: `r2 未产生预期的一条产品向量：embedded=${r2.embedded}`,
					);
				}
			}
		}
		deliveryGate.release(first.kind === "ready" ? "after_page_correction" : "stale_request_finished_first");

		if (first.kind === "error") throw first.error;
		const stale = first.kind === "finished" ? first.value : await stalePromise;
		state.staleGate = undefined;
		throwIfAborted(signal);
		writeJson(paths.staleOutput, stale.output);
		writeJson(
			paths.staleModel,
			modelEvidenceForStage(state, "stale", stale.output?.requestId, stale.latencyMs),
		);
		record("stale_extraction_finished", {
			requestId: stale.output?.requestId ?? null,
			ok: stale.output?.ok ?? false,
			failure: stale.output?.failure ?? stale.output?.error ?? null,
			candidateCount: stale.output?.candidates?.length ?? 0,
			rejectedCount: stale.output?.rejected?.length ?? 0,
			latencyMs: stale.latencyMs,
		});

		let staleCommit;
		if (
			stale.output?.ok &&
			stale.output.failure === undefined &&
			Array.isArray(stale.output.candidates) &&
			stale.output.candidates.length > 0
		) {
			record("stale_candidates_commit_started", {
				jobId: staleJobId,
				candidateCount: stale.output.candidates.length,
			});
			staleCommit = await commitExtractionCandidates(store, service, {
				jobId: staleJobId,
				scope,
				candidates: stale.output.candidates,
				relatedMemories: stale.input.relatedMemories ?? [],
				sourceRefs,
				now: nowIso(),
			});
			writeJson(paths.staleCommit, staleCommit);
			record("stale_candidates_committed", {
				jobId: staleJobId,
				outcomes: staleCommit.outcomes,
			});
		} else {
			staleCommit = {
				outcomes: [],
				submitted: 0,
				duplicates: 0,
				flagged: 0,
				skipped: 0,
				rejected: stale.output?.rejected?.length ?? 0,
				extractionRejected: stale.output?.rejected ?? [],
			};
			writeJson(paths.staleCommit, staleCommit);
		}

		const top3Detail = await readDesktopMemoryDetail({ home: paths.home, id: initialTop5Id });
		const finalList = await readDesktopMemoryList({
			home: paths.home,
			scope,
			query: "",
			status: "active",
			pageSize: 200,
		});
		const finalSearch = await readDesktopMemoryList({
			home: paths.home,
			scope,
			query: "召回条数",
			status: "active",
			pageSize: 200,
		});
		if (!top3Detail.ok) {
			throw new ScenarioFailure(`最终读取 top3 目标失败：${top3Detail.error.message}`);
		}
		if (!finalList.ok) {
			throw new ScenarioFailure(`最终读取 active 记忆失败：${finalList.error.message}`);
		}
		if (!finalSearch.ok) {
			throw new ScenarioFailure(`最终读取召回结果失败：${finalSearch.error.message}`);
		}
		const activeRows = observableRevisions(store, scope);
		const staleOutcomeStatuses = staleCommit.outcomes.map((outcome) => outcome.status);
		const staleOutcomeMemoryIds = staleCommit.outcomes
			.map((outcome) => outcome.memoryId)
			.filter((memoryId) => typeof memoryId === "string");
		const relatedIds = [initialTop5Id, ...staleOutcomeMemoryIds];
		const links = revisionLinksFor(store, relatedIds);
		const pageSourceSummary =
			correctionSource?.summary ??
			top3Detail.sources.find((source) => source.sessionId === PAGE_OPERATION_SESSION_ID);
		const activeListHasTop3 = finalList.items.some(
			(item) => item.memoryId === initialTop5Id && isTop3(item.conclusion),
		);
		const activeListHasTop5 = finalList.items.some((item) => isTop5(item.conclusion));
		const searchHasTop3 = finalSearch.items.some(
			(item) => item.memoryId === initialTop5Id && isTop3(item.conclusion),
		);
		const searchHasTop5 = finalSearch.items.some((item) => isTop5(item.conclusion));
		const staleDispositionAccepted =
			staleOutcomeStatuses.length > 0 &&
			staleCommit.outcomes.every(
				(outcome) =>
					outcome.status === "skipped" &&
					outcome.reason === "stale_request_snapshot",
			);
		const top3Content = top3Detail.memory.content;
		const criteria = {
			pageCorrectionSucceeded: correction?.ok === true,
			top3Active:
				top3Detail.memory.usageState === "active" &&
				top3Detail.memory.mergedInto === undefined,
			onlyTop3Active:
				activeRows.length === 1 &&
				activeRows[0].id === initialTop5Id &&
				activeRows[0].currentRevision === 2 &&
				isTop3(activeRows[0].content.conclusion),
			top3Conclusion: isTop3(top3Content.conclusion),
			top3Revision2: top3Detail.currentRevision === 2,
			top3HasPageSource: pageSourceSummary?.sessionId === PAGE_OPERATION_SESSION_ID,
			staleSkippedByRequestSnapshot: staleDispositionAccepted,
			noActiveTop5: !activeListHasTop5,
			searchReturnsTop3: searchHasTop3,
			searchExcludesTop5: !searchHasTop5,
		};
		const scenarioSatisfied = Object.values(criteria).every(Boolean);
		const status = executeReal ? (scenarioSatisfied ? "passed" : "failed") : "incomplete";
		const reason = executeReal
			? scenarioSatisfied
				? "真实 I04 顺序与最终状态均满足冻结期望"
				: "真实 I04 已执行，但至少一项冻结期望未满足"
			: "离线模拟只验证门控、隔离持久数据和页面纠正/迟到交付接缝；没有真实模型结果，不判定 I04 通过";

		const observedSourceRows = store.db
			.prepare(
				`SELECT source_id, session_id, entry_id, event_type, location, segment_id, captured_at
				 FROM sources ORDER BY captured_at, source_id`,
			)
			.all();
		const observedSources = [];
		for (const row of observedSourceRows) {
			const read = await service.readMemorySource({ sourceId: row.source_id });
			observedSources.push({
				sourceId: row.source_id,
				sessionId: row.session_id,
				entryId: row.entry_id,
				eventType: row.event_type,
				location: row.location,
				segmentId: row.segment_id,
				capturedAt: row.captured_at,
				read,
			});
		}
		writeJson(paths.sources, {
			allCapturedSources: observedSources,
			historyEntries: chatSession.getEntries(),
			ledgerEntries: ledgerSession.getEntries(),
			aliases: {
				[SOURCE_ALIAS_CHAT]: chatSourceAlias,
				[SOURCE_ALIAS_PAGE]: pageSourceSummary
					? {
							sourceId: pageSourceSummary.sourceId,
							sessionId: pageSourceSummary.sessionId,
							entryId: pageSourceSummary.entryId,
							eventType: pageSourceSummary.eventType,
							logicalAlias: "sess-e-page→desktop-page-operations",
						}
					: null,
			},
		});
		writeJson(paths.ledger, {
			sessionId: ledgerSession.getSessionId(),
			entries: ledgerSession.getEntries(),
		});
		writeJson(paths.finalState, {
			scope,
			top3: {
				memoryId: initialTop5Id,
				detail: summarizeNeedsReDiscussion(top3Detail),
				fullDetail: top3Detail,
			},
			activeMemories: activeRows,
			activeList: finalList,
			search: finalSearch,
			staleExtraction: {
				requestId: stale.output?.requestId ?? null,
				failure: stale.output?.failure ?? stale.output?.error ?? null,
				rejected: stale.output?.rejected ?? [],
				commit: staleCommit,
				outcomeStatuses: staleOutcomeStatuses,
			},
			relationEvidence: links,
			memoryAliases: {
				[MEMORY_ALIAS_TOP5]: {
					initialMemoryId: initialTop5Id,
					historicalRevision: initialTop5Revision,
					initialCommitOutcome: top5Outcome,
				},
				[MEMORY_ALIAS_TOP3]: {
					finalMemoryId: activeListHasTop3 ? initialTop5Id : null,
					currentRevision: top3Detail.currentRevision,
				},
			},
			criteria,
			embedding: embeddingEvidence,
		});
		record("final_state_inspected", { criteria, status });
		let semantic;
		if (semanticSample) {
			semantic = await runSynonymAcceptance({
				paoHome: paths.home,
				scope,
				executeReal: true,
				allowRealEmbedding: true,
				aliasMap: {
					[MEMORY_ALIAS_TOP5]: {
						memoryId: initialTop5Id,
						revision: initialTop5Revision,
					},
					[MEMORY_ALIAS_TOP3]: {
						memoryId: initialTop5Id,
						revision: top3Detail.currentRevision,
					},
				},
				signal,
			});
			writeJson(paths.semanticSample, semantic);
			record("semantic_sample_finished", {
				status: semantic.status,
				passed: semantic.summary.passed,
				failed: semantic.summary.failed,
				incomplete: semantic.summary.incomplete,
			});
		}
		result = {
			status,
			reason,
			mode: executeReal ? "real" : "simulated",
			realModelExecuted: state.actualModelCalls > 0,
			modelCallCount: state.actualModelCalls,
			criteria,
			top3: summarizeNeedsReDiscussion(top3Detail),
			stale: {
				requestId: stale.output?.requestId ?? null,
				outcomeStatuses: staleOutcomeStatuses,
				rejected: stale.output?.rejected ?? [],
			},
			semanticSample: semantic
				? {
						status: semantic.status,
						summary: semantic.summary,
					}
				: { status: "not_requested" },
			runRoot,
		};
	} catch (error) {
		const cancelled = signal?.aborted || error?.name === "AbortError";
		const failure = {
			status: cancelled ? "cancelled" : "failed",
			at: nowIso(),
			error: serializeError(error),
			modelCallCount: state.actualModelCalls,
			mode: executeReal ? "real" : "simulated",
		};
		writeJson(paths.failure, failure);
		record(cancelled ? "run_cancelled" : "run_failed", failure);
		result = {
			status: failure.status,
			reason: cancelled ? "收到取消信号；已保留失败记录" : failure.error.message,
			mode: failure.mode,
			realModelExecuted: state.actualModelCalls > 0,
			modelCallCount: state.actualModelCalls,
			runRoot,
		};
	} finally {
		state.staleGate?.release("cleanup");
		if (service) {
			try {
				await service.close();
			} catch (error) {
				cleanupErrors.push(serializeError(error));
			}
		}
		if (store) {
			try {
				store.close();
			} catch (error) {
				cleanupErrors.push(serializeError(error));
			}
		}
		if (cleanupErrors.length > 0) {
			result = {
				...(result ?? {}),
				status: "failed",
				reason: `资源关闭失败：${cleanupErrors.map((entry) => entry.message).join("; ")}`,
			};
			writeJson(paths.failure, {
				status: "failed",
				at: nowIso(),
				error: cleanupErrors[0],
				cleanupErrors,
				modelCallCount: state.actualModelCalls,
				mode: executeReal ? "real" : "simulated",
			});
		}
		const endedAt = nowIso();
		writeJson(paths.run, {
			schemaVersion: 1,
			acceptanceId: "I04",
			runId,
			scenario: "页面纠正后旧提炼任务返回",
			executeReal,
			mode: executeReal ? "real" : "simulated",
			actualModelInvoked: state.actualModelCalls > 0,
			modelCallCount: state.actualModelCalls,
			startedAt,
			endedAt,
			durationMs: performance.now() - started,
			eventCount: record.count,
			cleanupErrors,
			result,
			artifacts: paths,
		});
	}

	return result;
}

