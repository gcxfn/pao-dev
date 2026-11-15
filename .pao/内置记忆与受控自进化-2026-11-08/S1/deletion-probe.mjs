// S1-D 探针：previewMemoryDeletion + deleteMemory + resumeDeletion 全链验证。
// 用法：node deletion-probe.mjs（jiti 加载 TS 源；隔离 PAO_HOME 放 tmpdir）。
//
// 场景：2 条记忆共享 1 个来源、各 1 个独有来源；归档段各挂 1 个（含 1 个已封存 gzip 段）。
// 断言：
//   P1 preview：targets 两条、共享来源进 unmanagedSources、affectedSessions 列出会话
//   P2 delete complete：记忆行/修订/links/FTS 清掉、source_exclusions 有行、
//      共享来源 sources 行保留、独有来源 sources 行删除、未封存段条目剔除、
//      已封存段解压剔除后仍可读其他条目
//   P3 registerSource 重放已删来源：幂等返回新 ID 但不复活记忆
//   P4 pending → resumeDeletion：人为制造段失败（删掉段文件前注册 unmanaged，
//      或直接构造 pending 行）验证续作到 complete
//   P5 修订号不匹配 → failed，不先报完成

import { createRequire } from "node:module";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

const PKG = "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/package.json";
const SRC = "D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory";
const require = createRequire(PKG);
const jiti = require("jiti")(join(SRC, "service.ts"), { interopDefault: true });

const { openMemoryService } = jiti(join(SRC, "service.ts"));
const { openMemoryStore } = jiti(join(SRC, "store.ts"));
const { registerSource } = jiti(join(SRC, "sources.ts"));
const { memoryPaths } = jiti(join(SRC, "paths.ts"));
const { resumeDeletion } = jiti(join(SRC, "deletion.ts"));

const results = [];
function log(step, ok, detail = "") {
	results.push({ step, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? `: ${detail}` : ""}`);
}

const paoHome = mkdtempSync(join(tmpdir(), "pao-mem-del-"));
const archivesRoot = memoryPaths(paoHome).archives;
const AT = "2026-11-08T12:00:00Z";

try {
	const store = openMemoryStore(paoHome, "readwrite");
	const svc = openMemoryService({ paoHome, mode: "readwrite" });
	const db = store.db;

	// ── 造数：2 会话 3 来源；seg-A（未封存）挂共享来源，seg-B（已封存 gz）挂 mem1 独有 ──
	const sharedSrc = registerSource(db, {
		sessionId: "sess-a", entryId: "entry-shared", eventType: "user",
		segmentId: "seg-a", capturedAt: AT,
	});
	const ownSrc1 = registerSource(db, {
		sessionId: "sess-a", entryId: "entry-own1", eventType: "user",
		segmentId: "seg-b", capturedAt: AT,
	});
	const ownSrc2 = registerSource(db, {
		sessionId: "sess-b", entryId: "entry-own2", eventType: "user",
		segmentId: "seg-d", capturedAt: AT,
	});

	// 段文件：seg-a 未封存 JSONL（含共享+其他条目）；seg-b 已封存 .gz
	mkdirSync(join(archivesRoot, "sess-a"), { recursive: true });
	const segAPath = join(archivesRoot, "sess-a", "seg-a.jsonl");
	writeFileSync(segAPath, [
		JSON.stringify({ v: 1, sessionId: "sess-a", entryId: "entry-shared", eventType: "user", content: { text: "共享" } }),
		JSON.stringify({ v: 1, sessionId: "sess-a", entryId: "entry-other", eventType: "user", content: { text: "保留" } }),
	].join("\n") + "\n", "utf8");
	const segBPath = join(archivesRoot, "sess-a", "seg-b.jsonl.gz");
	writeFileSync(segBPath, gzipSync(Buffer.from(
		JSON.stringify({ v: 1, sessionId: "sess-a", entryId: "entry-own1", eventType: "user", content: { text: "独有" } }) + "\n", "utf8")),
	);
	const insSeg = db.prepare(
		`INSERT INTO archive_segments (segment_id, session_id, original_path, compressed_path, status, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);
	insSeg.run("seg-a", "sess-a", segAPath, null, "unsealed", AT);
	insSeg.run("seg-b", "sess-a", join(archivesRoot, "sess-a", "seg-b.jsonl"), segBPath, "sealed", AT);
	// seg-d：m2 独有来源的未封存段（验证未封存段剔除路径）。
	mkdirSync(join(archivesRoot, "sess-b"), { recursive: true });
	const segDPath = join(archivesRoot, "sess-b", "seg-d.jsonl");
	writeFileSync(segDPath, [
		JSON.stringify({ v: 1, sessionId: "sess-b", entryId: "entry-own2", eventType: "user", content: { text: "独有2" } }),
		JSON.stringify({ v: 1, sessionId: "sess-b", entryId: "entry-keep", eventType: "user", content: { text: "保留" } }),
	].join("\n") + "\n", "utf8");
	insSeg.run("seg-d", "sess-b", segDPath, null, "unsealed", AT);

	// 记忆：mem1 = shared + own1；mem2 = shared + own2
	const mk = async (sourceIds) => svc.createMemory({
		kind: "decision",
		scope: { projectId: "pao-dev" },
		conclusion: `结论-${sourceIds.join("+")}`,
		evidenceKind: "user_statement",
		sourceIds,
		createdAt: AT,
	});
	const m1 = await mk([sharedSrc, ownSrc1]);
	const m2 = await mk([sharedSrc, ownSrc2]);
	log("造数 create×2", m1.ok && m2.ok, `${m1.id} / ${m2.id}`);

	// ── P1 preview ──
	const preview = await svc.previewMemoryDeletion({ memoryId: m1.id });
	const sharedInUnmanaged = preview.ok && preview.unmanagedSources.some((u) => u.sourceId === sharedSrc);
	log("P1 preview targets 含 m1", preview.ok && preview.targets.some((t) => t.memoryId === m1.id));
	log("P1 共享来源标 referencedBy/unmanaged", sharedInUnmanaged, JSON.stringify(preview.unmanagedSources));
	log("P1 affectedSessions 列 sess-a", preview.ok && preview.affectedSessions.some((s) => s.sessionId === "sess-a"));

	// ── P5 修订号不符 → failed ──
	const stale = await svc.deleteMemory({
		memoryIds: [m1.id], revisions: { [m1.id]: 99 },
		source: { sessionId: "sess-del", entryId: "del-1" },
	});
	log("P5 修订号不符 → failed", stale.ok && stale.status === "failed", stale.failureReason);

	// ── P2 delete m1 → complete ──
	const del = await svc.deleteMemory({
		memoryIds: [m1.id], revisions: { [m1.id]: m1.revision },
		source: { sessionId: "sess-del", entryId: "del-2" },
	});
	log("P2 delete complete", del.ok && del.status === "complete", JSON.stringify(del));

	const gone = db.prepare("SELECT COUNT(*) c FROM memories WHERE id = ?").get(m1.id).c === 0;
	const revGone = db.prepare("SELECT COUNT(*) c FROM memory_revisions WHERE memory_id = ?").get(m1.id).c === 0;
	const linkGone = db.prepare("SELECT COUNT(*) c FROM memory_source_links WHERE memory_id = ?").get(m1.id).c === 0;
	const m2Alive = db.prepare("SELECT COUNT(*) c FROM memories WHERE id = ?").get(m2.id).c === 1;
	const excl = db.prepare("SELECT COUNT(*) c FROM source_exclusions WHERE source_id IN (?, ?)").get(sharedSrc, ownSrc1).c;
	const sharedAlive = db.prepare("SELECT COUNT(*) c FROM sources WHERE source_id = ?").get(sharedSrc).c === 1;
	const own1Gone = db.prepare("SELECT COUNT(*) c FROM sources WHERE source_id = ?").get(ownSrc1).c === 0;
	log("P2 记忆行/修订/links 清除", gone && revGone && linkGone);
	log("P2 mem2 存活", m2Alive);
	log("P2 source_exclusions 有行", excl >= 2, `${excl} 行`);
	log("P2 共享来源 sources 行保留", sharedAlive);
	log("P2 独有来源 sources 行删除", own1Gone);

	// 段内容：seg-a 中 entry-shared 是共享来源（保留），entry-other 保留；
	// seg-b(gz) 的 entry-own1 是独有来源 → 剔除后段空仍可读。
	const segAText = readFileSync(segAPath, "utf8");
	const segAOk = segAText.includes("entry-shared") && segAText.includes("entry-other");
	const segBLines = gunzipSync(readFileSync(segBPath)).toString("utf8").trim();
	log("P2 共享来源条目保留在段内（只删引用）", segAOk);
	log("P2 已封存段独有来源解压剔除", segBLines === "" || !segBLines.includes("entry-own1"), segBLines.length === 0 ? "(段空)" : segBLines);

	// ── P3 重放已删来源 registerSource：幂等返回新行但不复活记忆 ──
	const replayed = registerSource(db, {
		sessionId: "sess-a", entryId: "entry-own1", eventType: "user", capturedAt: AT,
	});
	const memStillGone = db.prepare("SELECT COUNT(*) c FROM memories WHERE id = ?").get(m1.id).c === 0;
	log("P3 已删来源可再登记但不复活记忆", replayed.length > 0 && memStillGone, replayed);

	// ── P4 pending → resume：构造一个删除 m2 的操作，先破坏 seg 引用制造 pending ──
	// m2 的 ownSrc2 无段（unmanaged 路径走 sources 行删除，不 pending）。
	// 为制造 pending：给 m2 加一个指向不存在段文件的来源。
	const badSrc = registerSource(db, {
		sessionId: "sess-b", entryId: "entry-bad", eventType: "user",
		segmentId: "seg-missing", capturedAt: AT,
	});
	db.prepare("UPDATE sources SET segment_id = 'seg-missing' WHERE source_id = ?").run(badSrc);
	db.prepare(
		`INSERT INTO archive_segments (segment_id, session_id, original_path, compressed_path, status, created_at)
		 VALUES ('seg-missing', 'sess-b', '/nonexistent/dir/seg-missing.jsonl', NULL, 'unsealed', ?)`,
	).run(AT);
	// 手动把 badSrc 挂到 m2 rev1
	db.prepare("INSERT INTO memory_source_links (memory_id, revision, source_id) VALUES (?, 1, ?)").run(m2.id, badSrc);

	const del2 = await svc.deleteMemory({
		memoryIds: [m2.id], revisions: { [m2.id]: m2.revision },
		source: { sessionId: "sess-del", entryId: "del-3" },
	});
	log("P4 段外路径 → pending", del2.ok && del2.status === "pending", JSON.stringify(del2.pendingObjects));
	// seg-d（未封存、m2 独有）应已剔除 entry-own2、保留 entry-keep
	const segDText = readFileSync(segDPath, "utf8");
	log("P4 未封存段独有来源剔除、其他保留", !segDText.includes("entry-own2") && segDText.includes("entry-keep"));

	// resume：段在受管目录外 → 重试跳过、仍 pending（如实语义，不静默完成）。
	const resume = resumeDeletion(store, archivesRoot, del2.operationId);
	log("P4 resume 后仍 pending（段在受管目录外）", resume.ok && resume.status === "pending", JSON.stringify(resume.pendingObjects));

	// resume → complete：手工塞一条可重试的 pending（段文件暂时缺席），
	// 放回文件后 resume 应清完到 complete。
	const okSrc = registerSource(db, {
		sessionId: "sess-c", entryId: "entry-ok", eventType: "user",
		segmentId: "seg-c", capturedAt: AT,
	});
	const segCPath = join(archivesRoot, "sess-c", "seg-c.jsonl");
	mkdirSync(dirname(segCPath), { recursive: true });
	writeFileSync(segCPath, JSON.stringify({ v: 1, sessionId: "sess-c", entryId: "entry-ok", eventType: "user", content: {} }) + "\n", "utf8");
	db.prepare(
		`INSERT INTO archive_segments (segment_id, session_id, original_path, compressed_path, status, created_at)
		 VALUES ('seg-c', 'sess-c', ?, NULL, 'unsealed', ?)`,
	).run(segCPath, AT);
	const m3 = await mk([okSrc]);
	// 先把文件挪走制造 pending，再挪回来 resume
	const segCHide = `${segCPath}.hidden`;
	const { renameSync } = await import("node:fs");
	renameSync(segCPath, segCHide);
	const del3 = await svc.deleteMemory({
		memoryIds: [m3.id], revisions: { [m3.id]: m3.revision },
		source: { sessionId: "sess-del", entryId: "del-4" },
	});
	log("P4 段文件缺席 → pending", del3.ok && del3.status === "pending", JSON.stringify(del3.pendingObjects));
	renameSync(segCHide, segCPath);
	const resume3 = resumeDeletion(store, archivesRoot, del3.operationId);
	log("P4 resume → complete", resume3.ok && resume3.status === "complete", JSON.stringify(resume3));
	const segCText = readFileSync(segCPath, "utf8");
	log("P4 resume 后段已剔除目标条目", !segCText.includes("entry-ok"));

	const summary = `${results.filter(r => r.ok).length}/${results.length} PASS`;
	console.log(`\n=== ${summary} ===`);
	await svc.close();
	store.close();
	process.exit(results.every(r => r.ok) ? 0 : 1);
} finally {
	try {
		rmSync(paoHome, { recursive: true, force: true });
	} catch (error) {
		// Windows 下 SQLite 句柄释放与文件可见性有延迟；清理失败不掩盖断言结果。
		console.warn(`清理隔离目录失败（可手工删）:${paoHome}:${error instanceof Error ? error.message : error}`);
	}
}
