// S1 批次A 探针：验证 paths.ts 与 store.ts 的最小链路
// 验证点：
//   1. memoryPaths 不随 cwd 改变归属
//   2. openMemoryStore 打开→建表→写一行→close→重开→读回
//   3. 同一 PAO_HOME 两个 store 句柄引用计数关闭正确
//   4. transaction 回滚不残留
//   5. nextScopeRevision 单调递增
//
// 用法：node store-probe.cjs
// 本探针通过 require() 已编译 TS 路径不可行（文件是 .ts ESM），
// 改用 Node 24 的内置 type-stripping 直接 import .ts。

const { mkdtempSync, rmSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

// 动态 import .ts：Node 24 strip 模式直接支持
async function main() {
	const { memoryPaths } = await import(
		"file:///D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/paths.ts"
	);
	const { openMemoryStore, nextScopeRevision } = await import(
		"file:///D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao/memory/store.ts"
	);

	const results = [];
	function log(step, ok, detail = "") {
		results.push({ step, ok });
		console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ": " + detail : ""}`);
	}

	// ── 1. memoryPaths 不随 cwd 改变归属 ─────────────────────
	const homeA = join(tmpdir(), "probe-home-A");
	const pathsA = memoryPaths(homeA);
	log("paths.database 归属 home", pathsA.database === join(homeA, "memory", "memory.sqlite"), pathsA.database);
	log("paths.archives", pathsA.archives === join(homeA, "memory", "archives"));
	log("paths.artifacts", pathsA.artifacts === join(homeA, "memory", "artifacts"));
	log("paths.attachments", pathsA.attachments === join(homeA, "memory", "attachments"));
	log("返回冻结对象", Object.isFrozen(pathsA));
	// 模拟切 cwd：再调用一次，结果不变
	const cwdBefore = process.cwd();
	process.chdir(tmpdir());
	const pathsA2 = memoryPaths(homeA);
	process.chdir(cwdBefore);
	log("切 cwd 后 home 归属不变", pathsA2.database === pathsA.database);

	// ── 2. 打开→建表→写→关→重开→读回 ──────────────────────────
	const tmpHome = mkdtempSync(join(tmpdir(), "pao-store-probe-"));
	try {
		const store1 = openMemoryStore(tmpHome, "readwrite");
		log("openMemoryStore 打开", typeof store1.db.prepare === "function");
		log("目录已按需创建", existsSync(join(tmpHome, "memory")));

		// 建表验证：往 memories 写一行
		try {
			store1.db
				.prepare(
					`INSERT INTO memories (id, kind, scope_json, current_revision, usage_state, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run("mem-1", "decision", '{"projectId":"probe"}', 1, "active", "2026-11-08T00:00:00Z", "2026-11-08T00:00:00Z");
			store1.close();
			log("写入并 close", true);
		} catch (err) {
			log("写入并 close", false, err instanceof Error ? err.message : String(err));
		}

		// 重开读回
		const store2 = openMemoryStore(tmpHome, "readwrite");
		const row = store2.db.prepare("SELECT id, kind, current_revision FROM memories WHERE id = ?").get("mem-1");
		log("重开读回", row?.id === "mem-1" && row?.current_revision === 1, JSON.stringify(row));
		store2.close();

		// ── 3. 引用计数：两个句柄共享连接 ─────────────────────────
		const s1 = openMemoryStore(tmpHome, "readwrite");
		const s2 = openMemoryStore(tmpHome, "readwrite");
		log("同 home 句柄共享同一连接", s1.db === s2.db);
		s1.close();
		// s1 close 后连接还活着：s2 仍可查询
		const stillOpen = s2.db.prepare("SELECT 1 AS ok").get();
		log("引用计数：一个 close 后连接仍可用", stillOpen?.ok === 1);
		s2.close();
		// 全部 close 后库已关闭：再 prepare 应抛错（或另开新库验证可重新打开）
		const s3 = openMemoryStore(tmpHome, "readwrite");
		const reRow = s3.db.prepare("SELECT id FROM memories WHERE id = ?").get("mem-1");
		log("全关后重开读回", reRow?.id === "mem-1");
		s3.close();

		// ── 4. transaction 回滚 ──────────────────────────────────
		const store4 = openMemoryStore(tmpHome, "readwrite");
		try {
			store4.transaction(() => {
				store4.db
					.prepare(
						`INSERT INTO memories (id, kind, scope_json, current_revision, usage_state, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					)
					.run("mem-rollback", "decision", "{}", 1, "active", "t", "t");
				throw new Error("模拟失败");
			});
			log("transaction 回滚", false, "未抛错");
		} catch {
			const rolledBack = store4.db.prepare("SELECT id FROM memories WHERE id = ?").get("mem-rollback");
			log("transaction 回滚", rolledBack === undefined, "无残留");
		}
		store4.close();

		// ── 5. nextScopeRevision 单调递增 ─────────────────────────
		const store5 = openMemoryStore(tmpHome, "readwrite");
		const r1 = store5.transaction(() => nextScopeRevision(store5.db, "scope-x", "2026-11-08T01:00:00Z"));
		const r2 = store5.transaction(() => nextScopeRevision(store5.db, "scope-x", "2026-11-08T02:00:00Z"));
		log("nextScopeRevision 递增", r1 === 1 && r2 === 2, `r1=${r1} r2=${r2}`);
		const scopeRow = store5.db.prepare("SELECT revision, last_changed_at FROM scope_revisions WHERE scope_id = ?").get("scope-x");
		log("last_changed_at 更新", scopeRow?.last_changed_at === "2026-11-08T02:00:00Z");
		store5.close();

		// ── 6. readonly 模式不建目录 ─────────────────────────────
		const emptyHome = mkdtempSync(join(tmpdir(), "pao-store-ro-"));
		// readonly 打开不存在的库应该失败（SQLite readOnly 不创建文件）
		let roFailed = false;
		try {
			const roStore = openMemoryStore(emptyHome, "readonly");
			roStore.close();
		} catch {
			roFailed = true;
		}
		log("readonly 打开不存在的库报错（不建目录）", roFailed && !existsSync(join(emptyHome, "memory")));
		rmSync(emptyHome, { recursive: true, force: true });
	} finally {
		rmSync(tmpHome, { recursive: true, force: true });
	}

	// ── 汇总 ────────────────────────────────────────────────
	const failed = results.filter((r) => !r.ok);
	console.log(`\n--- ${results.length - failed.length}/${results.length} passed ---`);
	if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
	console.error("探针异常:", err);
	process.exit(1);
});
