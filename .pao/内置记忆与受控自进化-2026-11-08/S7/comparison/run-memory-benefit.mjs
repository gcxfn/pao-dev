// S7-11：同组冻结任务「空记忆 vs 预置正确历史」对比运行。
//
// 做法：
// - 两遍使用同一隔离布局、同一冻结任务文本、同一模型与 thinkingLevel；
//   差别只在第二轮运行前按本文件的 PRESET_MEMORIES 向库内写入真实
//   记忆（createMemory 正式路径，decision/experience/lesson，confirmed，
//   挂真实来源），检索/注入全部走现有内核链路，不是构造的假注入。
// - 预置记忆的正文是冻结事实常量，不由模型生成，保证两遍模型设置一致。
// - 每遍重复 REPEAT 次，每次独立 runRoot/独立 home，不共享状态。
// - 证据：逐 request 的 normalized usage（含 cost.total 或 "unknown"）、
//   请求 payload 里是否可见预置结论（注入证据）、回答文本是否命中关键
//   事实与无关结论（人工核对正确性的原始材料）、前台耗时。
// - 计划要求「保留原始数字与失败样例；样本不足注明范围」——报告只列
//   实测分布与未知项，不把均值写成确定收益。
//
// 用法（在仓库根或任意目录执行）：
//   node run-memory-benefit.mjs <runId> --allow-real [--repeat 2]
//
// 授权：--allow-real 才发真实模型请求；凭证只读引用，不复制文件。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assemblePaoSession,
	closeRuntime,
	closeSession,
	createReadOnlyModelRuntime,
	isolatedLayout,
	observeStreamSimple,
	prepareDirectories,
	promptWithAbort,
	waitForExtractionJob,
} from "../../../../PAO/packages/coding-agent/scripts/memory-acceptance-runtime.mjs";
import { SessionManager } from "../../../../PAO/packages/coding-agent/dist/index.js";
import {
	createCapture,
	initializeMemoryConfig,
	openMemoryService,
	resolveMemoryProjectIdentity,
} from "../../../../PAO/packages/coding-agent/dist/pao/memory/index.js";
import { openMemoryStore } from "../../../../PAO/packages/coding-agent/dist/pao/memory/store.js";

const directory = fileURLToPath(new URL(".", import.meta.url));

// ── 冻结任务与预置历史 ────────────────────────────────────────────────────
// 同一任务输入两遍逐字相同；预置结论选生僻专有名词，回答命中即可判定
// 「无需再次解释」成立，跑题命中另一结论则判「决定错误/记忆污染」样例。
const FROZEN_TASK = {
	// 用户输入里刻意只给项目名和「按之前定好的来」，
	// 空记忆一遍必须重新解释或拒答，有记忆一遍应直接复用决定。
	prompt:
		"我们继续 pao-dev 的内置记忆工作。备份格式按之前定好的方案执行即可，" +
		"维护任务用什么方式防重复也按之前定的来。请用两三句话说明这两项按什么执行，" +
		"另外说下后台整理模型请求失败时按什么策略重试。不用调用工具。",
	// 预置正确历史：两条任务直接相关 + 一条无关诱饵。
	preset: [
		{
			kind: "decision",
			conclusion: "pao-dev 记忆备份使用 serialize 快照落地 memory.snapshot，配合 manifest.json 登记段文件",
			conditions: "一致性备份/恢复",
			rationale: "不直接复制活跃 WAL 主库，快照与段清单同源",
			factToken: "memory.snapshot",
		},
		{
			kind: "experience",
			conclusion: "维护作业用 extraction_jobs 的 owner_process+owner_token 领取防重复，进程确认退出后才回收 running 作业",
			conditions: "CLI/桌面双宿主同机",
			rationale: "同机存活判断复用进程检测，不仅凭时间到期抢任务",
			factToken: "owner_token",
		},
		{
			// 与「重试策略」提问弱相关的诱饵：真实结论不存在，模型应说明未定义
			// 或按通用保守策略回答；若它把无关结论当答案则为错误样例。
			kind: "lesson",
			conclusion: "删除会话正文用 acquireSessionControl 重写段文件，不能直接 unlink",
			conditions: "来源删除",
			rationale: "崩溃窗口下直接删文件会留下指向缺失段的登记行",
			factToken: "acquireSessionControl",
		},
	],
};

const MODEL = { provider: "magpie", id: "group/deepseek", thinkingLevel: "low" };
const AUTH_PATH = "C:/Users/ASUS/.pi/agent/auth.json";
const MODELS_PATH = "C:/Users/ASUS/.pi/agent/models.json";

// ── 参数 ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const runId = args[0];
if (!runId || !/^[a-zA-Z0-9-]+$/.test(runId) || !args.includes("--allow-real")) {
	throw new Error("用法：node run-memory-benefit.mjs <唯一runId> --allow-real [--repeat N]");
}
const repeatIndex = args.indexOf("--repeat");
const repeat = repeatIndex === -1 ? 2 : Number(args[repeatIndex + 1]);
if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat 需要正整数");

const outRoot = join(directory, "runs", runId);
if (existsSync(outRoot)) throw new Error(`结果目录已存在：${outRoot}`);
mkdirSync(outRoot, { recursive: true });

const evidence = {
	kind: "s7-11-memory-benefit-comparison",
	status: "running",
	runId,
	frozenTask: { prompt: FROZEN_TASK.prompt },
	model: MODEL,
	repeat,
	arms: [], // 每臂 {label, seeded, runs:[{status, modelRequests, text, hitTokens, ...}]}
	summary: {},
	error: undefined,
};
const persist = () =>
	writeFileSync(join(outRoot, "comparison.json"), `${JSON.stringify(evidence, null, 2)}\n`);
persist();

// ── 单轮运行 ──────────────────────────────────────────────────────────────
async function runOnce({ label, seeded, iteration }) {
	const runRoot = join(outRoot, `${label}-${iteration}`);
	const layout = isolatedLayout(runRoot);
	await prepareDirectories(layout);
	Object.assign(process.env, layout.childEnvironment, {
		PI_NO_LOCAL_LLM: "1",
		PI_TELEMETRY: "0",
	});
	delete process.env.PI_OFFLINE;
	initializeMemoryConfig(layout.home);
	writeFileSync(
		join(layout.home, "pao配置", "档位.json"),
		readFileSync(join(directory, "../../S4/real-validation/config/validation-tier.json")),
	);
	// O15：O01 落地的预算/外发许可门会拦截提炼 job 的真实模型请求。
	// 补「unlimited 预算 + 已授权外发」两份文件，保持冻结任务文本/模型设置不变。
	writeFileSync(
		join(layout.home, "pao配置", "记忆后台预算.json"),
		`${JSON.stringify({ unlimited: true })}\n`,
	);
	writeFileSync(
		join(layout.home, "总预算账.json"),
		`${JSON.stringify({
			version: 1,
			grants: [
				{
					version: 1,
					总预算: 999,
					授权时间: new Date().toISOString(),
					余额依据: { 已花: 0, 授权前总预算: 0 },
					授权人: "o15",
				},
			],
			reservations: [],
		})}\n`,
	);
	process.env.PAO_ENV_FILE = resolve(directory, "../../../../PAO/.env");
	process.env.PAO_OUTBOUND_CONFIG = resolve(
		directory,
		"../../S4/real-validation/config/fixture-outbound.json",
	);

	const identity = resolveMemoryProjectIdentity(layout.workspace);
	const record = {
		label,
		seeded,
		iteration,
		runRoot,
		projectId: identity.projectId,
		status: "running",
		seededMemoryIds: [],
		modelRequests: [],
		assistantText: "unknown",
		injectedTokens: [],
		promptLatencyMs: "unknown",
		extraction: "not_started",
		error: undefined,
	};

	const runtime = await createReadOnlyModelRuntime({
		agentDir: layout.agentDir,
		authPath: AUTH_PATH,
		modelsPath: MODELS_PATH,
	});
	const model = runtime.getModel(MODEL.provider, MODEL.id);
	if (!model) throw new Error(`未找到 ${MODEL.provider}/${MODEL.id}`);
	const observer = observeStreamSimple(runtime);
	const store = openMemoryStore(layout.home, "readwrite");
	const service = openMemoryService({ paoHome: layout.home, mode: "readwrite" });
	const capture = createCapture({ store, paoHome: layout.home });
	let handle;

	try {
		const sessionManager = SessionManager.create(layout.workspace, layout.sessionDir);
		const sessionId = sessionManager.getSessionId();
		handle = await assemblePaoSession({
			layout,
			sessionManager,
			modelRuntime: runtime,
			model,
			thinkingLevel: MODEL.thinkingLevel,
			settingsOverrides: {
				retry: { enabled: false },
				compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1 },
			},
		});

		// 预置正确历史：先造一条真实用户消息当来源，再用 createMemory 写
		// 正式记忆行——不绕服务直接 SQL，检索注入走内核既有链路。
		if (seeded) {
			const seedEntry = sessionManager.appendMessage({
				role: "user",
				content: "此前商定：记忆备份与维护防重方案已定，删除重写走会话控制。",
				timestamp: new Date().toISOString(),
			});
			const seedFile = sessionManager.getSessionFile();
			capture.registerSession(sessionId, seedFile);
			const captured = capture.captureCommittedEntry(
				sessionId,
				sessionManager.getEntry(seedEntry),
				"user",
				new Date().toISOString(),
			);
			if (!captured.sourceId) throw new Error("预置来源登记失败");
			for (const preset of FROZEN_TASK.preset) {
				const createdMemory = await service.createMemory({
					kind: preset.kind,
					scope: { projectId: identity.projectId },
					conclusion: preset.conclusion,
					conditions: preset.conditions,
					rationale: preset.rationale,
					evidenceKind: "user_statement",
					confirmation: "confirmed",
					sourceIds: [captured.sourceId],
					createdBy: "system",
				});
				if (!createdMemory.ok) throw new Error(`预置记忆失败:${createdMemory.error.message}`);
				record.seededMemoryIds.push(createdMemory.id);
			}
		}

		// 同一冻结任务输入，两遍逐字相同。
		observer.setSessionId(sessionId);
		const startedAt = performance.now();
		await promptWithAbort(handle.session, FROZEN_TASK.prompt, undefined);
		record.promptLatencyMs = Math.round(performance.now() - startedAt);
		record.extraction = await waitForExtractionJob(store, {
			executeReal: true,
			scopeKey: `session:${sessionId}`,
			timeoutMs: 120_000,
			pollIntervalMs: 250,
			waitForTerminal: true,
		});

		record.modelRequests = observer.records
			.filter((request) => request.callerSessionId === sessionId || request.sessionId === sessionId)
			.map((request) => ({
				requestIndex: request.requestIndex,
				startedAt: request.startedAt,
				latencyMs: request.observerLatencyMs,
				requestId: request.response?.requestId ?? "unknown",
				stopReason: request.output?.stopReason ?? "unknown",
				usage: request.output?.usage ?? "unknown",
				error: request.output?.errorMessage ?? "unknown",
			}));

		// 回答文本 + 注入证据（预置结论 token 是否出现在真实请求 payload）。
		const firstRequest = record.modelRequests.at(0);
		record.assistantText =
			observer.records.find((r) => r.requestIndex === firstRequest?.requestIndex)?.output?.text ??
			"unknown";
		// 注入证据只认首个前台请求的 context/payload——其后请求是提炼等后台作业，
		// 它们的 prompt 会带上全部记忆，不等于前台回答时可见。
		const firstRecord = observer.records.find(
			(r) => r.requestIndex === firstRequest?.requestIndex,
		);
		const firstPayload =
			JSON.stringify(firstRecord?.requestContext ?? {}) +
			JSON.stringify(firstRecord?.payload?.raw ?? {});
		record.injectedTokens = FROZEN_TASK.preset
			.filter((p) => firstPayload.includes(p.factToken))
			.map((p) => p.factToken);

		// 命中判定只做原始记录，正确性由报告人工对照：
		// hit = 回答里出现了哪几个冻结结论 token。
		record.answerHitTokens = FROZEN_TASK.preset
			.filter((p) => typeof record.assistantText === "string" && record.assistantText.includes(p.factToken))
			.map((p) => p.factToken);
		record.status = "completed";
	} catch (error) {
		record.status = "failed";
		record.error = { name: error.name, message: error.message };
	} finally {
		if (handle) await closeSession(handle.session, handle.session.sessionManager.getSessionId());
		await service.close();
		store.close();
		observer.restore();
		await closeRuntime(runtime);
		writeFileSync(
			join(runRoot, "model-requests.json"),
			`${JSON.stringify(observer.records, null, 2)}\n`,
		);
	}
	return record;
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
function usageTotal(requests) {
	// 只汇总供应商真实返回的数值；未知如实留 unknown，不构造虚假总数。
	const totals = { input: 0, output: 0, cacheRead: 0, costTotal: 0, costKnown: false, anyUnknown: false };
	for (const request of requests) {
		const usage = request.usage;
		if (usage === "unknown" || usage === undefined) {
			totals.anyUnknown = true;
			continue;
		}
		for (const key of ["input", "output", "cacheRead"]) {
			if (typeof usage[key] === "number") totals[key] += usage[key];
			else totals.anyUnknown = true;
		}
		if (typeof usage.cost?.total === "number") {
			totals.costTotal += usage.cost.total;
			totals.costKnown = true;
		}
	}
	if (!totals.costKnown) totals.costTotal = "unknown";
	return totals;
}

try {
	for (const [label, seeded] of [
		["empty", false],
		["preset", true],
	]) {
		const arm = { label, seeded, runs: [] };
		evidence.arms.push(arm);
		for (let iteration = 1; iteration <= repeat; iteration += 1) {
			const record = await runOnce({ label, seeded, iteration });
			record.usageTotal = usageTotal(record.modelRequests);
			arm.runs.push(record);
			persist();
		}
	}
	const failed = evidence.arms.flatMap((arm) => arm.runs.filter((r) => r.status !== "completed"));
	evidence.summary = {
		repeat,
		note:
			"样本量 = 每臂 " +
			repeat +
			" 次真实调用；模型有随机性，以下只报告实测分布，" +
			"小样本不足以证明确定收益。",
		failedRuns: failed.length,
	};
	evidence.status = failed.length === 0 ? "completed_pending_main_review" : "failed";
} catch (error) {
	evidence.status = "failed";
	evidence.error = { name: error.name, message: error.message };
}
persist();
console.log(
	JSON.stringify({
		runRoot: outRoot,
		status: evidence.status,
		arms: evidence.arms.map((arm) => ({
			label: arm.label,
			runs: arm.runs.map((r) => ({
				status: r.status,
				requests: r.modelRequests.length,
				usageTotal: r.usageTotal,
				answerHitTokens: r.answerHitTokens,
				injectedTokens: r.injectedTokens,
			})),
		})),
		error: evidence.error?.message,
	}),
);
process.exitCode = evidence.status === "completed_pending_main_review" ? 0 : 1;
