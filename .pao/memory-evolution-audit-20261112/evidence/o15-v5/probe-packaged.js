/**
 * O15-V5 发行物脱离开发仓 + S9-11 跨进程恢复验收。
 *
 * 模式 A|B：
 *   A 进程：用打包产物 dist 打开 home，写 evolution_resources +
 *           evolution_task_bindings（手工 INSERT 同生产 schema）→ 退出。
 *   B 进程：另一个 node 进程同样加载打包 dist → recoverEvolutionState
 *           消费 + listTaskBindings 读到 A 写入的绑定。
 *
 * 只用打包产物 dist 的 API，不 import pao-dev 源码——发行物脱离开发仓的关键路径。
 */
const path = require("node:path");
const fs = require("node:fs");
const PACKAGED_DIST =
	"D:/AI/workspace/pao-dev/desktop/apps/desktop/release/win-unpacked/resources/app.asar.unpacked/node_modules/@pao/coding-agent/dist";

const mode = process.argv[2]; // "A" | "B"
const home = process.argv[3];
if (!mode || !home) {
	console.error("用法: node probe-packaged.js <A|B> <home>");
	process.exit(2);
}
const outFile = process.argv[4] || path.join(__dirname, `probe-${mode}.json`);

const { openMemoryStore } = require(`${PACKAGED_DIST}/pao/memory/store.js`);
const { recoverEvolutionState } = require(`${PACKAGED_DIST}/pao/evolution/recovery.js`);
const { listTaskBindings } = require(`${PACKAGED_DIST}/pao/evolution/binding.js`);

const evidence = { kind: "o15-v5-packaged-dist", mode, home, steps: [] };
function step(name, data) {
	evidence.steps.push({ name, data });
	console.log(`[v5-${mode}] ${name}:`, JSON.stringify(data).slice(0, 300));
}

if (mode === "A") {
	fs.mkdirSync(path.join(home, "pao配置"), { recursive: true });
	const store = openMemoryStore(home, "readwrite");
	const now = new Date().toISOString();
	// 写资源 + 绑定（与生产 schema 同形；effective_version 指向待建版本目录）
	const resourceId = "res-o15v5-skill";
	const versionId = "v0-o15v5";
	// 手工建版本目录使 recoverEvolutionState.dirOk=true
	const dirSafe = resourceId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const versionDir = path.join(home, "evolution", "versions", dirSafe, versionId);
	fs.mkdirSync(versionDir, { recursive: true });
	fs.writeFileSync(path.join(versionDir, "SKILL.md"), "# o15v5 test skill\n");

	store.db
		.prepare(
			`INSERT INTO evolution_resources
			 (resource_id, kind, relative_root, allowed_ops_json, capability_scope_json,
			  load_method, effective_version, auto_evolution_enabled, registered_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			resourceId,
			"skill",
			`pao配置/skills/${resourceId}`,
			JSON.stringify(["read"]),
			JSON.stringify({ projectId: "v5-proj" }),
			"skill-path",
			versionId,
			0,
			now,
			now,
		);
	step("resource-inserted", { resourceId, versionId });

	store.db
		.prepare(
			`INSERT INTO evolution_task_bindings
			 (binding_id, task_id, resource_id, version_id, bound_at, active, switch_history_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(`bind-o15v5-${Date.now()}`, "task-v5", resourceId, versionId, now, 1, "[]");
	step("binding-inserted", { resourceId, taskId: "task-v5", versionId });

	const read = listTaskBindings(store, { taskId: "task-v5", activeOnly: true });
	step("read-back", { ok: read.ok, count: read.items?.length ?? 0, items: read.items });
	store.close();
} else if (mode === "B") {
	const store = openMemoryStore(home, "readonly");
	const report = recoverEvolutionState(store, { paoHome: home });
	step("recover", {
		resourceCount: report.resources.length,
		needsAttention: report.needsAttention,
		unfinishedActivations: report.unfinishedActivations?.length ?? 0,
	});
	const bindings = listTaskBindings(store, { taskId: "task-v5", activeOnly: true });
	step("bindings-consumed", {
		ok: bindings.ok,
		count: bindings.items?.length ?? 0,
		items: bindings.items?.map((b) => ({
			taskId: b.taskId,
			resourceId: b.resourceId,
			versionId: b.versionId,
			active: b.active,
		})),
	});
	store.close();
	evidence.summary = {
		pass:
			report.resources.length >= 1 &&
			(bindings.items?.length ?? 0) === 1 &&
			bindings.items[0]?.resourceId === "res-o15v5-skill",
		resourceCount: report.resources.length,
		bindingCount: bindings.items?.length ?? 0,
	};
}

fs.writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`);
process.exit(0);
