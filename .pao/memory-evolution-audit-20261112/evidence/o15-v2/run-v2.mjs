/**
 * O15-V2 成果真实执行验收：
 *   任务 A（Git 仓）交付产物 → registerArtifact（Git 定位）
 *   任务 B 复用同版本 → resolveArtifactVersion（真实读取 git object）→ recordArtifactUse
 *   再跑一轮非 Git 任务：managed 副本路径。
 *
 * 真实执行：用 git init/commit 实际起子进程（不 mock），真实落库，真实读取。
 * 不通过测试替身或 faux provider。
 *
 * 用法：node run-v2.mjs <outDir>
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	openMemoryStore,
} from "../../../../PAO/packages/coding-agent/dist/pao/memory/store.js";
import {
	recordArtifactUse,
	registerArtifact,
	resolveArtifactVersion,
} from "../../../../PAO/packages/coding-agent/dist/pao/memory/artifacts.js";
import { memoryPaths } from "../../../../PAO/packages/coding-agent/dist/pao/memory/paths.js";
import { resolveMemoryProjectIdentity } from "../../../../PAO/packages/coding-agent/dist/pao/memory/project-identity.js";

const outDir = process.argv[2];
if (!outDir) throw new Error("用法: node run-v2.mjs <outDir>");
mkdirSync(outDir, { recursive: true });

const evidence = {
	kind: "o15-v2-artifact-real-execution",
	steps: [],
	errors: [],
	summary: {},
};
function step(name, data) {
	evidence.steps.push({ name, ...data });
	console.log(`[v2] ${name}:`, JSON.stringify(data).slice(0, 300));
}
function saveEvidence() {
	writeFileSync(join(outDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
}

// ── 0) 隔离 home + git 仓 ─────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "o15-v2-"));
const paoHome = join(root, "pao-home");
const repoDir = join(root, "repo");
const workDir = join(root, "work"); // 非 git 受管交付目录
mkdirSync(join(paoHome, "pao配置"), { recursive: true });
mkdirSync(repoDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
execFileSync("git", ["-C", repoDir, "config", "user.email", "o15@test.local"]);
execFileSync("git", ["-C", repoDir, "config", "user.name", "o15"]);
writeFileSync(join(repoDir, "README.md"), "test\n");
execFileSync("git", ["-C", repoDir, "add", "README.md"]);
execFileSync("git", ["-C", repoDir, "commit", "-m", "init"]);

step("setup", { paoHome, repoDir });

// ── 1) 任务 A（Git）：写交付文件、commit、登记 ────────────────────────
const store = openMemoryStore(paoHome, "readwrite");
const identity = resolveMemoryProjectIdentity(repoDir);
const projectId = identity.projectId;
step("identity", { projectId });

// 来源：登记一条人工 source（不借模型/会话——本验收走 API 层真实路径，不走 SDK）
// sourceIds 至少一条——用 createSource 风格的占位 source 由 registerArtifact 的
// resolveSources 校验。看 store 是否有 source 表入口——直接用 service 的
// createMemory 不现实（需要 SDK）。最低限度：registerArtifact 的 sourceIds
// 需要 sources 表里有匹配行；绕不开就改走 store.db 直接插一条 source。
// 但 O15 要真实链路——先看 sources 表 schema。

const tables = store.db
	.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'source%'")
	.all();
step("source-tables", { tables });

// 直接插一条 source 行（生产由 capture.ts 写入，这里手工插一条等价行——
// 任务书允许「真实 API 层」，没强制必须走 SDK；登记/解析/复用仍走真实 API）。
const sourceId = `src-o15v2-${Date.now()}`;
store.db
	.prepare(
		`INSERT INTO sources (source_id, session_id, entry_id, event_type, project_id, task_id, captured_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
	.run(sourceId, "session-o15v2-a", "entry-1", "user", projectId, "task-a", new Date().toISOString());

step("source-inserted", { sourceId });

// 写交付文件并 commit
const deliveryPath = join(repoDir, "deliverables", "plan-v1.md");
mkdirSync(join(repoDir, "deliverables"), { recursive: true });
writeFileSync(deliveryPath, "# 计划 v1\n\n- 内容来自任务 A 的真实交付\n");
execFileSync("git", ["-C", repoDir, "add", "deliverables/plan-v1.md"]);
execFileSync("git", ["-C", repoDir, "commit", "-m", "task-a: add plan-v1"]);
const commitSha = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
step("git-commit", { commitSha });

// 登记成果（Git 定位）
const regA = registerArtifact(store, paoHome, {
	name: "plan-doc",
	purpose: "任务 A 交付的计划文档",
	scope: { projectId, taskId: "task-a" },
	files: [
		{
			name: "plan-v1.md",
			path: deliveryPath,
			git: { commit: commitSha, path: "deliverables/plan-v1.md" },
		},
	],
	originTaskId: "task-a",
	sourceIds: [sourceId],
	sourceSessionId: "session-o15v2-a",
	sourceToolName: "o15-v2-script",
	receiptRef: "pass:receipt-task-a-001",
	usageRefs: [`req-${Date.now()}`],
	registrationKey: `task-a-register-${commitSha}`,
});
step("register-A", regA);

if (!regA.ok) {
	evidence.errors.push({ stage: "register-A", error: regA.error });
	saveEvidence();
	process.exit(1);
}
const versionA = regA.versions[0];
step("version-A", { versionId: versionA.versionId, location: versionA.location });

// ── 2) 任务 B（Git 复用）：resolveArtifactVersion + recordArtifactUse ─
// 在另一「会话」里 resolve + use——同 store 但不同 taskId。
const resolved = resolveArtifactVersion(store, { versionId: versionA.versionId });
step("resolve-B", {
	ok: resolved.ok,
	available: resolved.ok ? resolved.available : false,
	contentLen: resolved.ok && resolved.available ? resolved.content.length : 0,
});

if (!resolved.ok || !resolved.available) {
	evidence.errors.push({ stage: "resolve-B", error: resolved.ok ? "unavailable" : resolved.error });
	saveEvidence();
	process.exit(1);
}

// 真实读取 git object 字节比对
const expected = readFileSync(deliveryPath);
const match = resolved.content.equals(expected);
step("git-read-verify", { match, expectedLen: expected.length, actualLen: resolved.content.length });
if (!match) {
	evidence.errors.push({ stage: "git-read-verify", expectedLen: expected.length, actualLen: resolved.content.length });
	saveEvidence();
	process.exit(1);
}

// 任务 B 复用：recordArtifactUse（receiptRef 带 verdict 前缀——O13 F13 编码）
const use = recordArtifactUse(store, {
	versionId: versionA.versionId,
	taskId: "task-b",
	action: "reuse",
	receiptRef: "pass:receipt-task-b-001",
	sessionId: "session-o15v2-b",
});
step("record-use-B", use);

// 检查 aref 'task' 和 'use' 引用都落库
const refs = store.db
	.prepare(
		`SELECT ref_kind, owner_id FROM artifact_refs
		 WHERE artifact_id = ? AND version_id = ?`,
	)
	.all(versionA.artifactId, versionA.versionId);
step("refs-for-version-A", { refs });

// 检查 artifact_uses 表
const uses = store.db
	.prepare(`SELECT task_id, action, receipt_ref, session_id FROM artifact_uses WHERE version_id = ?`)
	.all(versionA.versionId);
step("artifact-uses", { uses });

// ── 3) 非 Git 任务（managed 副本）：任务 C 交付 + 任务 D 复用 ──────────
const managedFile = join(workDir, "notes.md");
writeFileSync(managedFile, "任务 C 的受管交付内容\n");
const regC = registerArtifact(store, paoHome, {
	name: "task-c-notes",
	purpose: "任务 C 的受管交付",
	scope: { projectId, taskId: "task-c" },
	files: [{ name: "notes.md", path: managedFile }],
	originTaskId: "task-c",
	sourceIds: [sourceId],
	sourceSessionId: "session-o15v2-c",
	sourceToolName: "o15-v2-script",
	receiptRef: "pass:receipt-task-c-001",
});
step("register-C", regC);

if (!regC.ok) {
	evidence.errors.push({ stage: "register-C", error: regC.error });
	saveEvidence();
	process.exit(1);
}
const versionC = regC.versions[0];
step("version-C", { versionId: versionC.versionId, location: versionC.location });

const resolvedC = resolveArtifactVersion(store, { versionId: versionC.versionId });
step("resolve-D", {
	ok: resolvedC.ok,
	available: resolvedC.ok ? resolvedC.available : false,
});
if (!resolvedC.ok || !resolvedC.available) {
	evidence.errors.push({ stage: "resolve-D", error: resolvedC.ok ? "unavailable" : resolvedC.error });
	saveEvidence();
	process.exit(1);
}
const expectedC = readFileSync(managedFile);
const matchC = resolvedC.content.equals(expectedC);
step("managed-read-verify", { match: matchC });
if (!matchC) {
	evidence.errors.push({ stage: "managed-read-verify" });
	saveEvidence();
	process.exit(1);
}

const useD = recordArtifactUse(store, {
	versionId: versionC.versionId,
	taskId: "task-d",
	action: "reuse",
	receiptRef: "pass:receipt-task-d-001",
	sessionId: "session-o15v2-d",
});
step("record-use-D", useD);

// ── 4) 失败/未知回执如实显示「有回执/结果待核」────────────────────────
// receiptRef 不带 verdict 前缀 → decodeArtifactReceiptRef 该给 verdict=undefined。
const { decodeArtifactReceiptRef } = await import(
	"../../../../PAO/packages/coding-agent/dist/pao/memory/artifacts.js"
);
const unknownRef = decodeArtifactReceiptRef("receipt-raw-no-prefix");
const passRef = decodeArtifactReceiptRef("pass:receipt-ok-001");
step("decode-receipt", { unknownRef, passRef });

// ── 5) 结论 ─────────────────────────────────────────────────────────
const pass =
	regA.ok &&
	resolved.ok &&
	resolved.available &&
	match &&
	use.ok &&
	regC.ok &&
	resolvedC.ok &&
	resolvedC.available &&
	matchC &&
	useD.ok &&
	unknownRef.verdict === undefined &&
	passRef.verdict === "pass";

evidence.summary = {
	pass,
	gitRegisterOk: regA.ok,
	gitResolveOk: resolved.ok && resolved.available,
	gitReadMatch: match,
	gitUseOk: use.ok,
	managedRegisterOk: regC.ok,
	managedResolveOk: resolvedC.ok && resolvedC.available,
	managedReadMatch: matchC,
	managedUseOk: useD.ok,
	decodeVerdictPass: passRef.verdict,
	decodeVerdictUnknown: unknownRef.verdict,
};
saveEvidence();
console.log("==RESULT==");
console.log(JSON.stringify(evidence.summary));
process.exit(pass ? 0 : 1);
