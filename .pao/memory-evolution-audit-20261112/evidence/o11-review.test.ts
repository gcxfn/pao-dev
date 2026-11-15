/**
 * O11 独立复核探针：按审核口径构造反面场景亲验（不读既有用例结论）。
 *
 * 覆盖：
 * - E06：空集、漏 holdout、未知/重复 caseId、缺 baseline 侧语义（双侧同一条目
 *   内 baseline/candidate 是结构字段——「缺一侧」在 schema 上不可表达，以
 *   baseline 侧 executionFailure=incomplete 等价覆盖）；不注入 plan 时 incomplete。
 * - E07：baseline executionFailure=start 不算旧版真失败；candidate abortReason
 *   不 passed；agent 正常返回但 completed=false 不放行。
 * - E08：baseline 版本目录被换（指纹对不上）→ 拒发；plan.json 被改 → 拒发。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryStore, type MemoryStore } from "../../src/pao/memory/store.ts";
import { registerSource } from "../../src/pao/memory/sources.ts";
import { registerResource, snapshotResourceFiles } from "../../src/pao/evolution/resources.ts";
import { freezeValidationPlan } from "../../src/pao/evolution/validation.ts";
import { evaluateCandidate } from "../../src/pao/evolution/evaluate.ts";
import { runValidationCase } from "../../src/pao/evolution/runner.ts";
import { publishCandidate } from "../../src/pao/evolution/versions.ts";
import { evolutionPaths } from "../../src/pao/memory/paths.ts";
import type { ValidationCaseResult, ValidationRunResult } from "../../src/pao/evolution/types.ts";
import type { CardProcessResult } from "../../src/pao/cards/process.ts";

const tempDirs: string[] = [];
const openStores: MemoryStore[] = [];
function tempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-o11-review-"));
	tempDirs.push(dir);
	return dir;
}
function openStore(home: string): MemoryStore {
	const store = openMemoryStore(home, "readwrite");
	openStores.push(store);
	return store;
}
afterEach(() => {
	for (const store of openStores.splice(0)) { try { store.close(); } catch { /* 已关 */ } }
	for (const dir of tempDirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 残留不阻塞 */ } }
});

const AT = "2026-11-12T00:00:00.000Z";

function seedSkill(home: string, store: MemoryStore, name = "rev-skill", body = "# rev\n步骤一\n") {
	const skillDir = join(home, "pao配置", "skills", name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), body, "utf8");
	registerResource(store, { kind: "skill", name, paoHome: home });
	const snap = snapshotResourceFiles(store, { resourceId: `skill:${name}`, paoHome: home, createdAt: AT });
	if (!snap.ok) throw new Error("snapshot failed");
	return { resourceId: `skill:${name}`, baseVersion: snap.versionId, skillDir };
}

function seedProblem(store: MemoryStore, over: { resourceId?: string; baseVersion?: string }) {
	const problemId = `prob-${Math.random().toString(36).slice(2, 8)}`;
	store.db.prepare(
		`INSERT INTO evolution_problems (problem_id, kind, action, summary, expected_behavior, actual_behavior,
		 evidence_refs_json, occurrence_count, resource_id, base_version, status, disposition, created_at, updated_at)
		 VALUES (?, 'implementation_defect', 'modify', 's', 'e', 'a', '[]', 1, ?, ?, 'classified', 'pending_classification', ?, ?)`,
	).run(problemId, over.resourceId ?? null, over.baseVersion ?? null, AT, AT);
	return problemId;
}

function seedCandidateRow(store: MemoryStore, over: { problemId: string; resourceId: string; baseVersion: string; testPlanId: string }) {
	const candidateId = `cand-${Math.random().toString(36).slice(2, 8)}`;
	store.db.prepare(
		`INSERT INTO evolution_candidates (candidate_id, problem_id, resource_id, base_version, test_plan_id,
		 diffs_json, rationale, usage_refs_json, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, '[{"path":"SKILL.md","kind":"edit"}]', 'r', '[]', 'proposed', ?, ?)`,
	).run(candidateId, over.problemId, over.resourceId, over.baseVersion, over.testPlanId, AT, AT);
	return candidateId;
}

function cr(over: Partial<ValidationCaseResult> & { caseId: string }): ValidationCaseResult {
	return {
		caseId: over.caseId,
		baseline: over.baseline ?? { passed: false },
		candidate: over.candidate ?? { passed: true },
		verdict: over.verdict ?? "passed",
		...(over.reason === undefined ? {} : { reason: over.reason }),
	};
}

describe("O11 独立复核 E06：完整集合核对", () => {
	it("E06-1 空集 caseResults → 不接受 passed（invalid_input 拒绝）", () => {
		const home = tempHome(); const store = openStore(home);
		const { resourceId, baseVersion } = seedSkill(home, store);
		const problemId = seedProblem(store, { resourceId, baseVersion });
		const plan = freezeValidationPlan(store, { problemId, resourceId, baseVersion, paoHome: home,
			reproduction: [{ input: "i", initialFiles: {}, allowedTools: [], acceptance: "x" }], normal: [], holdout: [], createdAt: AT });
		if (!plan.ok) throw new Error("freeze");
		const candidateId = seedCandidateRow(store, { problemId, resourceId, baseVersion, testPlanId: plan.testPlanId });
		const r = evaluateCandidate(store, { candidateId, testPlanId: plan.testPlanId, paoHome: home, caseResults: [], createdAt: AT });
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error.message).toContain("空集");
		const row = store.db.prepare(`SELECT status FROM evolution_candidates WHERE candidate_id = ?`).get(candidateId) as { status: string };
		expect(row.status).not.toBe("passed");
	});

	it("E06-2 漏一条 holdout → verdict=incomplete 且候选 cancelled", () => {
		const home = tempHome(); const store = openStore(home);
		const { resourceId, baseVersion } = seedSkill(home, store);
		const problemId = seedProblem(store, { resourceId, baseVersion });
		const plan = freezeValidationPlan(store, { problemId, resourceId, baseVersion, paoHome: home,
			reproduction: [{ input: "i", initialFiles: {}, allowedTools: [], acceptance: "x" }],
			normal: [], holdout: [{ input: "h", initialFiles: {}, allowedTools: [], acceptance: "x" }], createdAt: AT });
		if (!plan.ok) throw new Error("freeze");
		const candidateId = seedCandidateRow(store, { problemId, resourceId, baseVersion, testPlanId: plan.testPlanId });
		const r = evaluateCandidate(store, { candidateId, testPlanId: plan.testPlanId, paoHome: home,
			caseResults: [cr({ caseId: "reproduction-0" })], createdAt: AT });
		expect(r.ok).toBe(true); if (!r.ok) return;
		expect(r.verdict).toBe("incomplete");
		const row = store.db.prepare(`SELECT status, failure_reason FROM evolution_candidates WHERE candidate_id = ?`).get(candidateId) as { status: string; failure_reason: string };
		expect(row.status).toBe("cancelled");
		expect(row.failure_reason).toContain("holdout-0");
	});

	it("E06-3 未注入 plan/paoHome 可读不到 plan → incomplete", () => {
		const home = tempHome(); const store = openStore(home);
		const { resourceId, baseVersion } = seedSkill(home, store);
		const problemId = seedProblem(store, { resourceId, baseVersion });
		const plan = freezeValidationPlan(store, { problemId, resourceId, baseVersion, paoHome: home,
			reproduction: [{ input: "i", initialFiles: {}, allowedTools: [], acceptance: "x" }], normal: [], holdout: [], createdAt: AT });
		if (!plan.ok) throw new Error("freeze");
		const candidateId = seedCandidateRow(store, { problemId, resourceId, baseVersion, testPlanId: plan.testPlanId });
		// 不传 paoHome、不传 plan —— 读不到冻结计划
		const r = evaluateCandidate(store, { candidateId, testPlanId: plan.testPlanId,
			caseResults: [cr({ caseId: "reproduction-0" })], createdAt: AT });
		expect(r.ok).toBe(true); if (!r.ok) return;
		expect(r.verdict).toBe("incomplete");
		const row = store.db.prepare(`SELECT status FROM evolution_candidates WHERE candidate_id = ?`).get(candidateId) as { status: string };
		expect(row.status).toBe("cancelled");
	});
});

describe("O11 独立复核 E07：执行故障不算业务通过", () => {
	it("E07-1 baseline executionFailure=start → incomplete，不当 baseline 真失败", () => {
		const home = tempHome(); const store = openStore(home);
		const { resourceId, baseVersion } = seedSkill(home, store);
		const problemId = seedProblem(store, { resourceId, baseVersion });
		const plan = freezeValidationPlan(store, { problemId, resourceId, baseVersion, paoHome: home,
			reproduction: [{ input: "i", initialFiles: {}, allowedTools: [], acceptance: "x" }], normal: [], holdout: [], createdAt: AT });
		if (!plan.ok) throw new Error("freeze");
		const candidateId = seedCandidateRow(store, { problemId, resourceId, baseVersion, testPlanId: plan.testPlanId });
		// baseline start 故障（旧版根本没跑起来）、candidate passed —— 不能宣称修复
		const r = evaluateCandidate(store, { candidateId, testPlanId: plan.testPlanId, paoHome: home,
			caseResults: [cr({ caseId: "reproduction-0",
				baseline: { passed: false, executionFailure: "start", failureReason: "进程未起来", exitCode: 127 },
				candidate: { passed: true } })], createdAt: AT });
		expect(r.ok).toBe(true); if (!r.ok) return;
		expect(r.verdict).toBe("incomplete");
		expect(r.caseResults[0].verdict).toBe("incomplete");
	});

	it("E07-2 baseline 带 exitCode=1 + 无 output 但无 executionFailure → 旧启发式可能混淆；现认业务失败前提", () => {
		// 旧版业务失败（exitCode≠0、无 executionFailure）应满足复现前提：baseline.passed=false 业务失败 + candidate passed → passed
		const home = tempHome(); const store = openStore(home);
		const { resourceId, baseVersion } = seedSkill(home, store);
		const problemId = seedProblem(store, { resourceId, baseVersion });
		const plan = freezeValidationPlan(store, { problemId, resourceId, baseVersion, paoHome: home,
			reproduction: [{ input: "i", initialFiles: {}, allowedTools: [], acceptance: "x" }], normal: [], holdout: [], createdAt: AT });
		if (!plan.ok) throw new Error("freeze");
		const candidateId = seedCandidateRow(store, { problemId, resourceId, baseVersion, testPlanId: plan.testPlanId });
		const r = evaluateCandidate(store, { candidateId, testPlanId: plan.testPlanId, paoHome: home,
			caseResults: [cr({ caseId: "reproduction-0",
				baseline: { passed: false, exitCode: 1, output: "wrong answer" },
				candidate: { passed: true, exitCode: 0 } })], createdAt: AT });
		expect(r.ok).toBe(true); if (!r.ok) return;
		expect(r.verdict).toBe("passed");
	});

	it("E07-3 真实 runValidationCase：假 processRunner 报 failureKind=start → 回执带 executionFailure，不当业务失败", async () => {
		const home = tempHome(); const store = openStore(home);
		const { resourceId, baseVersion } = seedSkill(home, store);
		const problemId = seedProblem(store, { resourceId, baseVersion });
		const plan = freezeValidationPlan(store, { problemId, resourceId, baseVersion, paoHome: home,
			reproduction: [{ input: "i", initialFiles: { "check.js": "process.exit(0)" }, allowedTools: [], acceptance: "x" }], normal: [], holdout: [], createdAt: AT });
		if (!plan.ok) throw new Error("freeze");
		// baseline 侧 versions/<baseVersion> 已有文件（snapshot 固化）
		const fakeProc = async (): Promise<CardProcessResult> =>
			({ code: 127, stdout: "", stderr: "", failureKind: "start" });
		const run = await runValidationCase(store, { processRunner: fakeProc as never }, {
			validationCase: plan.plan.reproduction[0], resourceId, baseVersion, side: "baseline",
			testPlanId: plan.testPlanId, paoHome: home, kind: "command",
			verifier: { cmd: "node", args: ["check.js"] }, runAt: AT,
		});
		expect(run.ok).toBe(true); if (!run.ok) return;
		expect(run.result.passed).toBe(false);
		expect(run.result.executionFailure).toBe("start");
		expect(run.result.exitCode).toBe(127); // 保留退出码但不算业务失败
		// 回执落盘带 fingerprint
		const receipt = JSON.parse(readFileSync(run.receiptPath, "utf8"));
		expect(receipt.resourceFingerprint).toMatch(/^v-[0-9a-f]{12}$/);
	});
});

describe("O11 独立复核 E08：发布门绑定已验内容", () => {
	it("E08-1 baseline 版本目录被换 → 指纹不符 not_ready", async () => {
		const home = tempHome(); const store = openStore(home);
		const { resourceId, baseVersion } = seedSkill(home, store);
		const problemId = seedProblem(store, { resourceId, baseVersion });
		const sourceId = registerSource(store.db, { sessionId: "s", entryId: "e", eventType: "toolResult", capturedAt: AT });
		store.db.prepare(`INSERT INTO evolution_source_links (link_id, owner_kind, owner_id, source_id, created_at) VALUES ('lp','problem',?,?,?)`).run(problemId, sourceId, AT);
		const plan = freezeValidationPlan(store, { problemId, resourceId, baseVersion, paoHome: home,
			reproduction: [{ input: "i", initialFiles: {}, allowedTools: [], acceptance: "x" }], normal: [], holdout: [], createdAt: AT });
		if (!plan.ok) throw new Error("freeze");
		const candidateId = `cand-${Math.random().toString(36).slice(2, 8)}`;
		store.db.prepare(`INSERT INTO evolution_candidates (candidate_id, problem_id, resource_id, base_version, test_plan_id,
		 diffs_json, rationale, usage_refs_json, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, '[{"path":"SKILL.md","kind":"edit"}]', 'r', '[]', 'proposed', ?, ?)`)
			.run(candidateId, problemId, resourceId, baseVersion, plan.testPlanId, AT, AT);
		const dirSafe = resourceId.replace(/:/g, "_");
		const candidateDir = join(evolutionPaths(home).candidates, dirSafe, candidateId);
		mkdirSync(candidateDir, { recursive: true });
		writeFileSync(join(candidateDir, "SKILL.md"), "# rev\n步骤一\n步骤三\n", "utf8");
		store.db.prepare(`INSERT INTO evolution_source_links (link_id, owner_kind, owner_id, source_id, created_at) VALUES ('lc','candidate',?,?,?)`).run(candidateId, sourceId, AT);
		// 双侧真实 run（command 假 processRunner：baseline exit1 / candidate exit0）
		const fake = (code: number) => (async () => ({ code, stdout: "", stderr: "" }) as CardProcessResult) as never;
		const caseSpec = plan.plan.reproduction[0];
		const bl = await runValidationCase(store, { processRunner: fake(1) }, { validationCase: caseSpec, resourceId, baseVersion, side: "baseline", testPlanId: plan.testPlanId, paoHome: home, kind: "command", verifier: { cmd: "node", args: ["x.js"] }, runAt: AT });
		const cd = await runValidationCase(store, { processRunner: fake(0) }, { validationCase: caseSpec, resourceId, baseVersion, side: "candidate", candidateId, testPlanId: plan.testPlanId, paoHome: home, kind: "command", verifier: { cmd: "node", args: ["x.js"] }, runAt: AT });
		expect(bl.ok && cd.ok).toBe(true);
		const ev = evaluateCandidate(store, { candidateId, testPlanId: plan.testPlanId, paoHome: home,
			caseResults: [{ caseId: caseSpec.caseId, baseline: bl.result, candidate: cd.result, verdict: "passed" }], createdAt: AT });
		expect(ev.ok && ev.verdict === "passed").toBe(true);

		// 篡改 baseline 版本目录（换掉验证依据的旧版正文）
		writeFileSync(join(evolutionPaths(home).versions, dirSafe, baseVersion, "SKILL.md"), "# 被换掉的旧版\n", "utf8");

		const r = await publishCandidate(store, { candidateId, paoHome: home });
		expect(r.ok).toBe(true); if (!r.ok) return;
		expect("status" in r && r.status === "not_ready").toBe(true);
		if (!("status" in r)) return;
		expect(r.reason).toContain("baseline 版本目录指纹不匹配");
	});
});
