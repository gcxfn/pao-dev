// S1-B 探针：DEMO_DECISION_JSON 的 T1→T5 流转 + 冲突/缺来源/合并场景。
// 用法：node --experimental-strip-types service-probe.mjs（PAO 仓根 node ≥22.19 即可跑 TS import?
//   —— 不，node:sqlite 的 TS 源由 jiti 或 tsx 跑；本脚本用 tsx 注册或直接 jiti。
//   实际执行方式见下方命令行，用 vitest 的 node 环境太重，这里用 jiti require。
//
// 断言点：
//   T1 create → id+rev1、tentative、scopeRevision=1
//   T2 correct → rev2、supersedes=rev-1、conflict 旧号被拒
//   T3 stop → rev3、usageState=stopped（内容不变）
//   T4 restore → rev4、usageState=active
//   T5 history → 4 条修订 + 来源摘要 + supersessionChain
//   另测：缺来源 create 被拒、merge 后旧 ID 带 mergedInto。

import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire("D:/AI/workspace/pao-dev/PAO/packages/coding-agent/package.json");
const jiti = require("jiti")("D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/service.ts", {
	interopDefault: true,
});

const { openMemoryService } = jiti("D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/service.ts");
const { registerSource } = jiti("D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/sources.ts");

const results = [];
function log(step, ok, detail = "") {
	results.push({ step, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? `: ${detail}` : ""}`);
}
function eq(actual, expected) {
	return JSON.stringify(actual) === JSON.stringify(expected);
}

const paoHome = mkdtempSync(join(tmpdir(), "pao-mem-probe-"));

try {
	const svc = openMemoryService({ paoHome, mode: "readwrite" });
	const db = svc.__db ?? null; // 无后门——来源走 svc 之外另开? 不行，registerSource 需要 db。
	// 探针需要 db 来 registerSource；服务不暴露 db。方案：打开同一 store 拿 db。
	const { openMemoryStore } = jiti("D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/store.ts");
	const store = openMemoryStore(paoHome, "readwrite");

	// 预登记来源（对应 DEMO 的 src-sess-a-entry-*）
	const seedSources = [
		{ sessionId: "sess-a", entryId: "entry-001", eventType: "user", capturedAt: "2026-11-08T09:59:00Z" },
		{ sessionId: "sess-a", entryId: "entry-005", eventType: "user", capturedAt: "2026-11-08T10:04:00Z" },
	];
	const srcIds = seedSources.map((s) => registerSource(store.db, s));
	log("registerSource 预登记", srcIds.length === 2, srcIds.join(","));

	// 幂等：同参数重复登记返回既有 ID；同 entry 不同 eventType 各得独立 ID。
	const dup = registerSource(store.db, seedSources[0]);
	log("registerSource 幂等", dup === srcIds[0], `${dup} === ${srcIds[0]}`);
	const otherType = registerSource(store.db, {
		sessionId: "sess-a",
		entryId: "entry-001",
		eventType: "assistant",
		capturedAt: "2026-11-08T09:59:30Z",
	});
	log("同 entry 不同 eventType 独立 ID", otherType !== srcIds[0] && otherType.length > 0, otherType);

	// ── T1 create ──
	const create = await svc.createMemory({
		kind: "decision",
		scope: { projectId: "pao-dev", sessionId: "sess-a", branch: "main" },
		conclusion: "内置记忆存储使用 SQLite",
		conditions: "需要本地持久化且支持并发读写",
		evidenceKind: "user_statement",
		confirmation: "tentative",
		sourceIds: [srcIds[0]],
		createdBy: "model",
		createdAt: "2026-11-08T10:00:00Z",
	});
	log("T1 create ok", create.ok === true, JSON.stringify(create));
	const memId = create.ok ? create.id : undefined;
	log("T1 revision=1", create.ok && create.revision === 1);

	const scopeRev1 = await svc.readScopeRevision({ scopeId: "pao-dev" });
	log("T1 scopeRevision=1", scopeRev1.ok && scopeRev1.revision === 1, JSON.stringify(scopeRev1));

	// ── T2 correct ──
	const correct = await svc.correctMemory({
		id: memId,
		expectedRevision: 1,
		replacement: {
			conclusion: "内置记忆存储使用 SQLite，带 WAL 模式",
			conditions: "需要本地持久化且支持并发读写",
			rationale: "用户明确确认，WAL 是多进程读写的必要条件",
			evidenceKind: "user_statement",
			confirmation: "confirmed",
		},
		source: { sessionId: "sess-a", entryId: "entry-005", userId: "user" },
		sourceIds: [srcIds[1]],
		createdAt: "2026-11-08T10:05:00Z",
	});
	log("T2 correct ok", correct.ok === true && correct.revision === 2, JSON.stringify(correct));

	// CAS 冲突：用旧 expectedRevision=1 再纠正应失败并带回 currentRevision=2
	const conflict = await svc.correctMemory({
		id: memId,
		expectedRevision: 1,
		replacement: {
			conclusion: "恶意覆盖",
			evidenceKind: "model_inference",
			confirmation: "tentative",
		},
		source: { sessionId: "sess-a", entryId: "entry-999", userId: "user" },
	});
	log(
		"T2b revision_conflict",
		conflict.ok === false && conflict.error.code === "revision_conflict" && conflict.error.currentRevision === 2,
		JSON.stringify(conflict),
	);

	// 缺来源 create 被拒
	const missingSrc = await svc.createMemory({
		kind: "experience",
		scope: { projectId: "pao-dev" },
		conclusion: "x",
		evidenceKind: "model_inference",
		sourceIds: ["src-nonexistent"],
	});
	log("缺来源 create 被拒", missingSrc.ok === false && missingSrc.error.code === "source_missing", JSON.stringify(missingSrc));

	// ── T3 stop ──
	const stop = await svc.setMemoryUsage({
		id: memId,
		expectedRevision: 2,
		target: "stopped",
		source: { sessionId: "sess-a", entryId: "entry-010", userId: "user" },
		createdAt: "2026-11-08T10:10:00Z",
	});
	log("T3 stop ok", stop.ok === true && stop.revision === 3 && stop.usageState === "stopped", JSON.stringify(stop));

	// ── T4 restore ──
	const restore = await svc.setMemoryUsage({
		id: memId,
		expectedRevision: 3,
		target: "active",
		source: { sessionId: "sess-a", entryId: "entry-015", userId: "user" },
		createdAt: "2026-11-08T10:15:00Z",
	});
	log("T4 restore ok", restore.ok === true && restore.revision === 4 && restore.usageState === "active", JSON.stringify(restore));

	// ── T5 history ──
	const history = await svc.getMemory({ id: memId, includeHistory: true });
	const h = history.ok ? history : null;
	log("T5 history ok", h !== null);
	if (h) {
		log("T5 currentRevision=4", h.memory.currentRevision === 4);
		log("T5 usageState=active", h.memory.usageState === "active");
		log("T5 4 revisions", (h.revisions ?? []).length === 4, `revs=${(h.revisions ?? []).length}`);
		log("T5 rev2 supersedes=rev-1", h.revisions?.[1]?.content.supersedes === "rev-1");
		log("T5 rev1 supersededBy=rev-2", h.revisions?.[0]?.content.supersededBy === "rev-2");
		log("T5 chain len=4", h.supersessionChain.length === 4, JSON.stringify(h.supersessionChain));
		log("T5 sourceSummaries≥4", h.sourceSummaries.length >= 4, `n=${h.sourceSummaries.length}`);
	}

	// ── merge ──
	// 建第二条 confirmed 记忆，与第一条结论文本相同 → 放行合并
	const src3 = registerSource(store.db, { sessionId: "sess-b", entryId: "entry-001", eventType: "user", capturedAt: "2026-11-08T11:00:00Z" });
	const m2 = await svc.createMemory({
		kind: "decision",
		scope: { projectId: "pao-dev" },
		conclusion: "内置记忆存储使用 SQLite，带 WAL 模式",
		evidenceKind: "user_statement",
		confirmation: "confirmed",
		sourceIds: [src3],
		createdAt: "2026-11-08T11:01:00Z",
	});
	const m2Id = m2.ok ? m2.id : undefined;
	const merge = await svc.mergeMemories({
		keepId: memId,
		keepExpectedRevision: 4,
		mergeId: m2Id,
		mergeExpectedRevision: 1,
		rationale: "同一决定的重复记录，保留较早的",
		source: { sessionId: "sess-b", userId: "user" },
		createdAt: "2026-11-08T11:05:00Z",
	});
	log("merge ok", merge.ok === true && merge.mergeInto === memId, JSON.stringify(merge));
	const merged = await svc.getMemory({ id: m2Id });
	log("merge 后旧 ID mergedInto", merged.ok && merged.memory.mergedInto === memId, JSON.stringify(merged.ok ? merged.memory.mergedInto : merged));
	const canonical = await svc.getMemory({ id: memId });
	log("canonical mergedFrom", canonical.ok && (canonical.memory.mergedFrom ?? []).includes(m2Id), JSON.stringify(canonical.ok ? canonical.memory.mergedFrom : canonical));

	// 矛盾拒合并：两条 confirmed 但结论文本不同
	const src4 = registerSource(store.db, { sessionId: "sess-c", entryId: "entry-001", eventType: "user", capturedAt: "2026-11-08T12:00:00Z" });
	const m3 = await svc.createMemory({
		kind: "decision",
		scope: { projectId: "pao-dev" },
		conclusion: "内置记忆存储使用文件",
		evidenceKind: "user_statement",
		confirmation: "confirmed",
		sourceIds: [src4],
		createdAt: "2026-11-08T12:01:00Z",
	});
	const m3Id = m3.ok ? m3.id : undefined;
	const blocked = await svc.mergeMemories({
		keepId: memId,
		keepExpectedRevision: 5,
		mergeId: m3Id,
		mergeExpectedRevision: 1,
		rationale: "试一下",
		source: { sessionId: "sess-c", userId: "user" },
	});
	log("confirmed+confirmed 结论不同拒合并", blocked.ok === false && blocked.error.code === "merge_conflict", JSON.stringify(blocked));

	// 空 projectId 被拒
	const badScope = await svc.createMemory({
		kind: "decision",
		scope: { projectId: "" },
		conclusion: "x",
		evidenceKind: "user_statement",
		sourceIds: [src3],
	});
	log("空 projectId 拒", badScope.ok === false && badScope.error.code === "invalid_input");

	store.close();
	await svc.close();
} catch (error) {
	log("unexpected error", false, error instanceof Error ? error.message : String(error));
	console.error(error);
}

try {
	rmSync(paoHome, { recursive: true, force: true });
} catch {}

const failed = results.filter((r) => !r.ok);
console.log(`\n--- ${results.length - failed.length}/${results.length} passed ---`);
if (failed.length > 0) {
	console.log("Failed:", failed.map((f) => f.step).join(" | "));
	process.exit(1);
}
