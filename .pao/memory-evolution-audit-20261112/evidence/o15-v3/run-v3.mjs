/**
 * O15-V3 真实技能改进闭环验收：
 *
 * 真实路径（不走测试替身，不用 s9-acceptance.mjs 的 seed-injection）：
 * 1. 隔离 PAO_HOME（mkdtemp）+ 真实技能文件 SKILL.md
 * 2. registerResource + snapshotResourceFiles → baseVersion=v0
 * 3. declareImprovementIntent（直 API，同 pao_evolution_declare 工具）
 * 4. classifyProblem → selectImprovement → freezeValidationPlan
 * 5. proposeCandidate 由真实模型驱动（magpie/group/deepseek thinkingLevel=low）
 *    产生真实 diff（付费调用计入账本）
 * 6. runValidationCase 双侧（kind=command 真实子进程跑 node verifier，
 *    不用 agent channel——O11 结构性留尾 a 已记录）
 * 7. evaluateCandidate → publishCandidate → activateCandidate
 * 8. 第二轮改进（E15）：v1→v2 再跑一遍
 * 9. 退步路径：declare on bad version → handleRegression → binding rollback
 *
 * 判定（运行前冻结）：
 * - 每轮 reproduction case baseline 必失败 / candidate 必通过（修复判据）
 * - 每轮 activateCandidate 后 effectiveVersion 指向新版
 * - handleRegression 后 effectiveVersion 回滚
 * - 账本/usage_refs 带真实 requestId
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createReadOnlyModelRuntime } from "../../../../PAO/packages/coding-agent/scripts/memory-acceptance-runtime.mjs";
import { openMemoryStore } from "../../../../PAO/packages/coding-agent/dist/pao/memory/store.js";
import { openPersistentMemoryLedger } from "../../../../PAO/packages/coding-agent/dist/pao/memory/runtime-embedding.js";

import { declareImprovementIntent, classifyProblem } from "../../../../PAO/packages/coding-agent/dist/pao/evolution/problems.js";
import { selectImprovement } from "../../../../PAO/packages/coding-agent/dist/pao/evolution/select.js";
import { freezeValidationPlan } from "../../../../PAO/packages/coding-agent/dist/pao/evolution/validation.js";
import { proposeCandidate } from "../../../../PAO/packages/coding-agent/dist/pao/evolution/candidates.js";
import { runValidationCase } from "../../../../PAO/packages/coding-agent/dist/pao/evolution/runner.js";
import { evaluateCandidate } from "../../../../PAO/packages/coding-agent/dist/pao/evolution/evaluate.js";
import { publishCandidate } from "../../../../PAO/packages/coding-agent/dist/pao/evolution/versions.js";
import { activateCandidate, getEffectiveVersion } from "../../../../PAO/packages/coding-agent/dist/pao/evolution/activation.js";
import { registerResource, snapshotResourceFiles, getResource } from "../../../../PAO/packages/coding-agent/dist/pao/evolution/resources.js";
import { bindTaskResources, resolveTaskResourceVersion } from "../../../../PAO/packages/coding-agent/dist/pao/evolution/binding.js";
import { handleRegression } from "../../../../PAO/packages/coding-agent/dist/pao/evolution/regression.js";
import { readBudgetLedger, budgetLedgerPath } from "../../../../PAO/packages/coding-agent/dist/pao/memory/budget.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ?? __dirname;
mkdirSync(outDir, { recursive: true });

const evidence = {
	kind: "o15-v3-real-skill-evolution",
	steps: [],
	rounds: [],
	regression: undefined,
	errors: [],
	summary: {},
};
function step(name, data) {
	evidence.steps.push({ name, data });
	console.log(`[v3] ${name}:`, JSON.stringify(data).slice(0, 400));
}
function save() {
	writeFileSync(join(outDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
}

// ── 0) 隔离 home + 真实技能 ────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "o15-v3-"));
const paoHome = join(root, "pao-home");
mkdirSync(join(paoHome, "pao配置", "skills", "answer-format"), { recursive: true });
mkdirSync(join(paoHome, "知识库配置"), { recursive: true });

// 技能 v0：明确带两个独立缺陷
//   缺陷 A：OUTPUT_LANGUAGE=en（应该 zh）
//   缺陷 B：没有「示例」段（应该补一节）
// 冻结判据（运行前定稿）：
//   R1 reproduction: SKILL.md 含 OUTPUT_LANGUAGE=zh 且不包含 OUTPUT_LANGUAGE=en
//   R2 reproduction: SKILL.md 含一级或二级「示例」标题（^#+\s*示例）
// normal/holdout 组放「SKILL.md 仍可解析为 UTF-8 文本且非空」的最小回归，
// 不依赖模型输出细节。
const SKILL_V0 = `---
name: answer-format
description: 回答格式约束
---
# 回答格式

- OUTPUT_LANGUAGE=en
- 所有回答使用英文段落
- 不使用项目符号
`;
writeFileSync(join(paoHome, "pao配置", "skills", "answer-format", "SKILL.md"), SKILL_V0);

// 档位：magpie/group/deepseek thinkingLevel low（同 V1/V4）
writeFileSync(
	join(paoHome, "pao配置", "档位.json"),
	`${JSON.stringify({
		provider: "pao",
		档位: [{ 名: "fast", provider: "magpie", model: "group/deepseek", thinkingLevel: "low" }],
	})}\n`,
);
// 预算 + 总预算授权（unlimited 直通；不消耗预留——O01 门仍要求文件存在）
writeFileSync(
	join(paoHome, "pao配置", "记忆后台预算.json"),
	`${JSON.stringify({ unlimited: true })}\n`,
);
writeFileSync(
	join(paoHome, "总预算账.json"),
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
// 外发许可（本 home 内的项目名 "pao-home"——proposeCandidate 用 outboundProjects 匹配）
writeFileSync(
	join(paoHome, "知识库配置", "外发许可.json"),
	`${JSON.stringify({ projects: { "pao-home": { allowed: true, asOf: "2099-12-31" } } })}\n`,
);

process.env.PAO_ENV_FILE = resolve("PAO/.env");
process.env.PAO_OUTBOUND_CONFIG = join(paoHome, "知识库配置", "外发许可.json");
delete process.env.PI_OFFLINE;
process.env.PI_NO_LOCAL_LLM = "1";
process.env.PI_TELEMETRY = "0";

step("setup", { paoHome });

// ── 1) 登记资源 + 快照 v0 ──────────────────────────────────────────────────
const store = openMemoryStore(paoHome, "readwrite");
const runtime = await createReadOnlyModelRuntime({
	agentDir: join(root, "agent"),
	authPath: "C:/Users/ASUS/.pi/agent/auth.json",
	modelsPath: "C:/Users/ASUS/.pi/agent/models.json",
});
const modelRegistry = {
	find: (provider, modelId) => runtime.getModel(provider, modelId),
	streamSimple: (model, context, options) => runtime.streamSimple(model, context, options),
};
const ledger = openPersistentMemoryLedger(paoHome, "job-o15v3-001");

// 插一条 source 行——declareImprovementIntent 的 src- 前缀 evidenceRefs 必须命中
// sources 表；publish 的来源依据核对要求 problem→candidate→plan→validation 链路
// 每级 owner 都挂有效 source。本验收用 src- 引用 + friction: 引用组合。
const seedSourceId = `src-o15v3-${Date.now()}`;
store.db
	.prepare(
		`INSERT INTO sources (source_id, session_id, entry_id, event_type, project_id, task_id, captured_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
	.run(seedSourceId, "session-o15v3", "entry-1", "user", "pao-home", "task-seed", new Date().toISOString());
step("seed-source", { seedSourceId });

const registered = registerResource(store, { kind: "skill", name: "answer-format", paoHome });
step("register", registered);
if (!registered.ok) {
	evidence.errors.push({ stage: "register", error: registered.error });
	save();
	process.exit(1);
}
const resourceId = registered.resourceId; // skill:answer-format

const snap0 = snapshotResourceFiles(store, { resourceId, paoHome });
step("snapshot-v0", { versionId: snap0.versionId, files: snap0.files?.length });
const v0 = snap0.versionId;

// ── 2) 第一轮：缺陷 A（OUTPUT_LANGUAGE=en→zh）──────────────────────────────
async function evolveOnce({ tag, summary, expected, actual, verifierCode, verifierArgs = ["check.js"], evidenceRefs }) {
	const round = { tag, steps: {}, usageRefs: [] };
	evidence.rounds.push(round);

	// 2.1 declare（宿主补 projectId——这里直接用 pao-home 名）
	const declared = declareImprovementIntent(store, {
		kind: "implementation_defect",
		summary,
		expectedBehavior: expected,
		actualBehavior: actual,
		evidenceRefs,
		resourceId,
		baseVersion: getResource(store, resourceId).effectiveVersion,
		projectId: "pao-home",
		taskId: `task-${tag}`,
	});
	round.steps.declare = declared;
	step(`${tag}-declare`, declared);
	if (!declared.ok || !declared.accepted) return { ok: false, reason: declared.reason ?? "declare rejected" };
	const problemId = declared.problemId;

	// 2.2 classify → select
	const classified = classifyProblem(store, { problemId });
	round.steps.classify = classified;
	if (!classified.ok) return { ok: false, reason: `classify ${classified.error.message}` };

	const selected = selectImprovement(store, { problemId });
	round.steps.select = selected;
	step(`${tag}-select`, selected);
	if (!selected.ok || selected.disposition !== "candidate" || selected.target === undefined) {
		return { ok: false, reason: `select disposition=${selected.disposition}` };
	}
	const baseVersion = selected.target.baseVersion;

	// 2.3 freeze（含 verifier 脚本进 initialFiles）
	const frozen = freezeValidationPlan(store, {
		problemId,
		resourceId,
		baseVersion,
		paoHome,
		reproduction: [
			{
				input: actual,
				initialFiles: { "check.js": verifierCode },
				allowedTools: [],
				acceptance: expected,
			},
		],
		normal: [
			{
				input: "SKILL.md 应为非空 UTF-8 文本",
				initialFiles: {
					"check.js": `import { readFileSync } from "node:fs";\nconst c = readFileSync("resource/SKILL.md","utf8");\nif (!c || c.trim().length === 0) { console.error("empty"); process.exit(1); }\nconsole.log("non-empty");\nprocess.exit(0);\n`,
				},
				allowedTools: [],
				acceptance: "SKILL.md 非空",
			},
		],
		holdout: [],
		sourceRefs: evidenceRefs.filter((r) => r.startsWith("src-")).map((sourceId) => ({ sourceId })),
	});
	round.steps.freeze = frozen;
	step(`${tag}-freeze`, { testPlanId: frozen.testPlanId });
	if (!frozen.ok) return { ok: false, reason: `freeze ${frozen.error.message}` };

	// 2.4 proposeCandidate 真实模型驱动
	const jobId = `job-o15v3-${tag}`;
	const proposed = await proposeCandidate(
		store,
		{
			modelRegistry,
			ledger,
			paoHome,
			budgetPaoHome: paoHome,
			outboundProjects: ["pao-home"],
			budget: { jobId, kind: "evolve" },
		},
		{
			problemId,
			resourceId,
			baseVersion,
			testPlanId: frozen.testPlanId,
			allowedFiles: [], // 不约束——assertCandidateWithinScope 仍核路径在资源根内
			devCases: [{ input: actual, failure: actual, expected }],
		},
	);
	round.steps.propose = proposed;
	step(`${tag}-propose`, proposed);
	if (!proposed.ok) return { ok: false, reason: `propose ${proposed.error?.message ?? proposed.reason}` };
	if (proposed.status !== "changed") return { ok: false, reason: `propose status=${proposed.status}` };
	const candidateId = proposed.candidateId;
	round.candidateId = candidateId;

	// 2.5 双侧 runValidationCase（kind=command，真实 node 子进程）
	const caseResults = [];
	for (const validationCase of [...frozen.plan.reproduction, ...frozen.plan.normal, ...frozen.plan.holdout]) {
		const pair = { caseId: validationCase.caseId };
		for (const side of ["baseline", "candidate"]) {
			const run = await runValidationCase(
				store,
				{}, // 不注入 processRunner / agentSessionFactory——走真实 runCardProcess
				{
					validationCase,
					resourceId,
					baseVersion,
					side,
					...(side === "candidate" ? { candidateId } : {}),
					testPlanId: frozen.testPlanId,
					paoHome,
					kind: "command",
					verifier: { cmd: "node", args: verifierArgs },
					loadMethod: "skill-path",
					timeoutMs: 60_000,
				},
			);
			if (!run.ok) return { ok: false, reason: `run ${side} ${run.error.message}` };
			pair[side] = run.result;
			step(`${tag}-run-${validationCase.caseId}-${side}`, {
				passed: run.result.passed,
				exitCode: run.result.exitCode,
				outHead: (run.result.output ?? "").slice(0, 200),
			});
		}
		caseResults.push({
			caseId: validationCase.caseId,
			baseline: pair.baseline,
			candidate: pair.candidate,
			verdict: "passed", // 占位——evaluate 内部按 baseline/candidate 重判
		});
	}
	round.steps.caseResults = caseResults.map((c) => ({
		caseId: c.caseId,
		baselinePassed: c.baseline.passed,
		candidatePassed: c.candidate.passed,
	}));

	// 2.6 evaluate
	const evaluated = evaluateCandidate(store, {
		candidateId,
		testPlanId: frozen.testPlanId,
		paoHome,
		caseResults,
	});
	round.steps.evaluate = evaluated;
	step(`${tag}-evaluate`, evaluated);
	if (!evaluated.ok || evaluated.verdict !== "passed") {
		return { ok: false, reason: `evaluate verdict=${evaluated.ok ? evaluated.verdict : evaluated.error.message}` };
	}

	// 2.7 publish
	const published = await publishCandidate(store, { candidateId, paoHome });
	round.steps.publish = published;
	step(`${tag}-publish`, published);
	if (!published.ok || !("versionId" in published)) {
		return { ok: false, reason: `publish ${published.ok ? published.reason : published.error.message}` };
	}
	const newVersionId = published.versionId;

	// 2.8 activate
	const currentEffective = getResource(store, resourceId).effectiveVersion;
	const activated = await activateCandidate(store, {
		candidateId,
		expectedEffectiveVersion: currentEffective,
		paoHome,
		reason: `${tag} 激活`,
	});
	round.steps.activate = activated;
	step(`${tag}-activate`, activated);
	if (!activated.ok) return { ok: false, reason: `activate ${activated.error.message}` };
	if ("status" in activated && activated.status === "conflict") {
		return { ok: false, reason: `activate conflict: ${activated.reason}` };
	}

	// 绑定验证：新任务绑定时该得新版
	const bound = bindTaskResources(store, { taskId: `task-${tag}-post`, resourceIds: [resourceId] });
	const resolvedVersion = bound.ok
		? resolveTaskResourceVersion(store, { taskId: `task-${tag}-post`, resourceId, paoHome })
		: { ok: false };
	round.steps.binding = { bound, resolvedVersion };
	step(`${tag}-binding`, { boundVersionId: resolvedVersion.ok ? resolvedVersion.versionId : "n/a" });

	return { ok: true, problemId, candidateId, versionId: newVersionId, baseVersion };
}

// ── 缺陷 A verifier：SKILL.md 必须含 OUTPUT_LANGUAGE=zh 且不含 =en ──────────
const VERIFIER_R1 = `import { readFileSync } from "node:fs";
const c = readFileSync("resource/SKILL.md","utf8");
if (c.includes("OUTPUT_LANGUAGE=en")) { console.error("still English"); process.exit(1); }
if (!c.includes("OUTPUT_LANGUAGE=zh")) { console.error("missing zh directive"); process.exit(1); }
console.log("ok: OUTPUT_LANGUAGE=zh");
process.exit(0);
`;

const r1 = await evolveOnce({
	tag: "r1",
	summary: "SKILL.md 让回答用英文，与用户中文沟通冲突",
	expected: "SKILL.md 指导用中文段落回答（OUTPUT_LANGUAGE=zh）",
	actual: "SKILL.md 第 4 行写着 OUTPUT_LANGUAGE=en 与 'use English paragraphs'",
	verifierCode: VERIFIER_R1,
	evidenceRefs: [seedSourceId, `friction:o15-v3-r1`],
});
step("r1-result", r1);
if (!r1.ok) {
	evidence.errors.push({ stage: "r1", error: r1.reason });
	save();
	process.exit(1);
}
const v1 = r1.versionId;

// 核对 r1 后的 SKILL.md（publish 落到 versions/）
const dirSafe = resourceId.replace(/:/g, "_");
const v1Dir = join(paoHome, "evolution", "versions", dirSafe, v1);
const v1Content = readFileSync(join(v1Dir, "SKILL.md"), "utf8");
step("r1-versioned-content", { path: v1Dir, head: v1Content.slice(0, 400) });

// ── 缺陷 B verifier：SKILL.md 必须含「示例」标题 ────────────────────────────
// r2 baseVersion 是 v1（publish 后的固化版）；如果 v1 已含「示例」，verifier
// 在 baseline 就通过 → reproduction 无法成立 → 报 incomplete。这是如实反馈，
// 不伪造 baseline 失败。
const VERIFIER_R2 = `import { readFileSync } from "node:fs";
const c = readFileSync("resource/SKILL.md","utf8");
const hasExample = /^#+\\s*示例/m.test(c);
if (!hasExample) { console.error("missing 示例 section"); process.exit(1); }
console.log("ok: has 示例 section");
process.exit(0);
`;

const r2 = await evolveOnce({
	tag: "r2",
	summary: "SKILL.md 缺少「示例」段，回答格式没有具体样例可参考",
	expected: "SKILL.md 包含「示例」标题（# 或 ## 级）+ 至少一个中文回答样例",
	actual: "SKILL.md 只有规则清单，没有任何「示例」段或样例",
	verifierCode: VERIFIER_R2,
	evidenceRefs: [seedSourceId, `friction:o15-v3-r2`],
});
step("r2-result", r2);
const v2 = r2.ok ? r2.versionId : undefined;
if (!r2.ok) {
	// r2 失败不阻断——仍继续退步路径与最终判定
	evidence.errors.push({ stage: "r2", error: r2.reason });
}

// ── 退步路径：对当前 effectiveVersion（v2 或 v1 视 r2 结果）报用户退步 ──────
const currentEff = getResource(store, resourceId).effectiveVersion;
step("pre-regression-effective", { currentEff });
const regression = handleRegression(store, {
	resourceId,
	userReported: true,
	failureDescription: "用户反馈新版技能引导出的回答格式异常",
	sourceIds: [`friction:o15-v3-regression`],
});
evidence.regression = regression;
step("regression", regression);

const postEff = getResource(store, resourceId).effectiveVersion;
step("post-regression-effective", { postEff });

// ── 账本核对：真实模型请求的 requestId / usageRef ─────────────────────────
const budgetLedger = readBudgetLedger(budgetLedgerPath(paoHome));
step("budget-ledger-reservations", {
	count: budgetLedger.reservations?.length ?? 0,
	keys: (budgetLedger.reservations ?? []).map((r) => r.idempotencyKey).slice(0, 10),
});

// 看 candidate 行的 usage_refs_json
const candRows = store.db
	.prepare(`SELECT candidate_id, problem_id, status, usage_refs_json, diffs_json FROM evolution_candidates`)
	.all();
step("candidates", {
	count: candRows.length,
	items: candRows.map((c) => ({
		candidateId: c.candidate_id,
		status: c.status,
		usageRefs: c.usage_refs_json ? JSON.parse(c.usage_refs_json).length : 0,
		diffCount: c.diffs_json ? JSON.parse(c.diffs_json).length : 0,
	})),
});

// ── 判定 ──────────────────────────────────────────────────────────────────
const round1 = evidence.rounds.find((r) => r.tag === "r1");
const round2 = evidence.rounds.find((r) => r.tag === "r2");
const r1Pass =
	r1.ok === true &&
	round1?.steps.evaluate?.verdict === "passed" &&
	round1?.steps.activate?.ok === true;
const r2Pass =
	r2.ok === true &&
	round2?.steps.evaluate?.verdict === "passed" &&
	round2?.steps.activate?.ok === true;
const regressionPass =
	regression.ok === true &&
	regression.rolledBack === true &&
	postEff !== currentEff &&
	postEff === regression.previousVersion;

evidence.summary = {
	pass: r1Pass && r2Pass && regressionPass, // 两轮+退步都要过；r2 失败如实记并算失败
	r1: { pass: r1Pass, versionId: v1, candidateId: r1.candidateId, evaluate: round1?.steps.evaluate?.verdict },
	r2: r2.ok
		? { pass: r2Pass, versionId: v2, candidateId: r2.candidateId, evaluate: round2?.steps.evaluate?.verdict }
		: { pass: false, reason: r2.reason },
	regression: {
		ok: regression.ok,
		rolledBack: regression.rolledBack,
		badVersion: regression.badVersion,
		previousVersion: regression.previousVersion,
		preEff: currentEff,
		postEff,
		pass: regressionPass,
	},
	o11StructuralNotes: {
		agentChannelReproduction:
			"本验收用 kind=command 而非 agent——O11 留尾 a 仍成立：agent channel 下" +
			"基线只跑「会话完整跑完」就 passed=true，reproduction 无法形成「baseline 失败→candidate 通过」" +
			"对比，结构上 fail-closed 到不了 passed。command 通道的 verifier 直接读" +
			"resource/SKILL.md 判内容差异，能稳定区分两侧。",
		acceptanceVsOutput:
			"evaluateCandidate 不读 acceptance 文本，只用 run.passed/executionFailure 与" +
			"baseline/candidate 双侧对比定 verdict。验收文本对输出的核对职责压在 verifier" +
			"（本验收 node 脚本断言文件内容）——O11 留尾 b 在 evaluate 层仍未闭合。",
	},
};
save();
console.log("==RESULT==");
console.log(JSON.stringify(evidence.summary, null, 2));
process.exit(evidence.summary.pass ? 0 : 1);
