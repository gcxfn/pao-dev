// O12 独立复核探针：文件型快照(E12)、来源继承(E11)、checkOwnerSourceLinksIntact 拒绝场景。
// 运行：node --experimental-vm-modules o12-probe.mjs（在 PAO/packages/coding-agent 下）
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const SRC = "file:///D:/AI/workspace/pao-dev/PAO/packages/coding-agent/src/pao";
const { openMemoryStore } = await import(`${SRC}/memory/store.ts`);
const { registerResource, snapshotResourceFiles } = await import(`${SRC}/evolution/resources.ts`);
const { readResourceVersion } = await import(`${SRC}/evolution/versions.ts`);
const { checkOwnerSourceLinksIntact, dbCleanupSourceReferences } = await import(`${SRC}/evolution/observe.ts`);
const { evolutionPaths } = await import(`${SRC}/memory/paths.ts`);

const home = mkdtempSync(join(tmpdir(), "o12-probe-"));
const store = openMemoryStore(home, "readwrite");
const results = [];
const rec = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };

// ── E12a：template（工作流/x.md 单文件）登记→快照→读回 ──────────────────
mkdirSync(join(home, "工作流"), { recursive: true });
writeFileSync(join(home, "工作流", "revision.md"), "# 模板正文模板正文\nline2\n", "utf8");
const regT = registerResource(store, { kind: "template", name: "revision", paoHome: home });
rec("template registerResource", regT.ok === true, regT.ok ? `root=${regT.relativeRoot}` : JSON.stringify(regT.error));

const snapT = snapshotResourceFiles(store, { resourceId: "template:revision", paoHome: home });
rec("template snapshotResourceFiles", snapT.ok === true && snapT.files?.length === 1,
    snapT.ok ? `versionId=${snapT.versionId} files=${snapT.files?.length}` : JSON.stringify(snapT.error));

const readT = readResourceVersion(store, { resourceId: "template:revision", versionId: snapT.versionId, paoHome: home });
const tplContent = readT.ok ? readT.files?.find(f => f.path === "revision.md")?.content : undefined;
rec("template readResourceVersion 读回单文件", tplContent === "# 模板正文模板正文\nline2\n",
    readT.ok ? `path=${readT.files?.[0]?.path}` : JSON.stringify(readT.error));

// ── E12b：recipe（部门/y/配方.md 单文件）────────────────────────────────
mkdirSync(join(home, "部门", "finanzas"), { recursive: true });
writeFileSync(join(home, "部门", "finanzas", "配方.md"), "配方内容配方内容\n", "utf8");
const regR = registerResource(store, { kind: "recipe", name: "finanzas", paoHome: home });
rec("recipe registerResource", regR.ok === true, regR.ok ? `root=${regR.relativeRoot}` : JSON.stringify(regR.error));

const snapR = snapshotResourceFiles(store, { resourceId: "recipe:finanzas", paoHome: home });
rec("recipe snapshotResourceFiles", snapR.ok === true && snapR.files?.length === 1,
    snapR.ok ? `versionId=${snapR.versionId}` : JSON.stringify(snapR.error));

const readR = readResourceVersion(store, { resourceId: "recipe:finanzas", versionId: snapR.versionId, paoHome: home });
rec("recipe readResourceVersion 读回单文件", readR.ok && readR.files?.[0]?.content === "配方内容配方内容\n",
    readR.ok ? `path=${readR.files?.[0]?.path}` : JSON.stringify(readR.error));

// ── E12c：目录技能回归（不应受文件分派影响）────────────────────────────
mkdirSync(join(home, "pao配置", "skills", "dirskill"), { recursive: true });
writeFileSync(join(home, "pao配置", "skills", "dirskill", "SKILL.md"), "# dir\n", "utf8");
writeFileSync(join(home, "pao配置", "skills", "dirskill", "extra.md"), "e\n", "utf8");
const regS = registerResource(store, { kind: "skill", name: "dirskill", paoHome: home });
const snapS = regS.ok && snapshotResourceFiles(store, { resourceId: "skill:dirskill", paoHome: home });
rec("skill 目录快照回归", snapS && snapS.ok === true && snapS.files?.length === 2,
    snapS?.ok ? `files=${snapS.files.length}` : JSON.stringify(snapS?.error ?? regS.error));

// ── E11：checkOwnerSourceLinksIntact 拒绝场景 ──────────────────────────
const db = store.db;
const insLink = db.prepare(`INSERT INTO evolution_source_links (link_id, owner_kind, owner_id, source_id, memory_id, revision, created_at) VALUES (?,?,?,?,?,?,?)`);
const AT = "2026-11-15T00:00:00.000Z";

// owner 无 links → 拒绝（空 links）
let v = checkOwnerSourceLinksIntact(db, { owners: [{ ownerKind: "problem", ownerId: "prob-x", label: "问题" }] });
rec("check: 空 links 拒绝", v !== undefined && v.includes("没有登记"), v);

// src- 来源不在 sources 表 → 拒绝
insLink.run("l1", "problem", "prob-del-src", "src-gone", null, null, AT);
v = checkOwnerSourceLinksIntact(db, { owners: [{ ownerKind: "problem", ownerId: "prob-del-src", label: "问题" }] });
rec("check: sources 行已删拒绝", v !== undefined && v.includes("已被删除"), v);

// source_exclusions 命中 → 拒绝（source existe en sources para aislar el check de exclusion）
db.prepare(`INSERT INTO sources (source_id, session_id, entry_id, event_type, captured_at) VALUES ('src-exc1','s','e','user',?)`).run(AT);
insLink.run("l2", "problem", "prob-exc", "src-exc1", null, null, AT);
db.prepare(`INSERT INTO source_exclusions (exclusion_id, memory_id, source_id, session_id, entry_id, reason, created_at) VALUES ('e1','m-x','src-exc1',NULL,NULL,'r',?)`).run(AT);
v = checkOwnerSourceLinksIntact(db, { owners: [{ ownerKind: "problem", ownerId: "prob-exc", label: "问题" }] });
rec("check: source_exclusions 命中拒绝", v !== undefined && v.includes("已被排除"), v);

// memory_id 指向不存在的记忆 → 拒绝（source existe para aislar el check de memory）
db.prepare(`INSERT INTO sources (source_id, session_id, entry_id, event_type, captured_at) VALUES ('src-m1','s','e2','user',?)`).run(AT);
insLink.run("l3", "problem", "prob-mem", "src-m1", "mem-gone", 1, AT);
v = checkOwnerSourceLinksIntact(db, { owners: [{ ownerKind: "problem", ownerId: "prob-mem", label: "问题" }] });
rec("check: memory_id 已删拒绝", v !== undefined && v.includes("已被删除排除"), v);

// revision 过期：插入真记忆 current_revision=1，link 要 r3 → 拒绝
const memCols = db.prepare(`SELECT sql FROM sqlite_master WHERE name='memories'`).get().sql;
db.prepare(`INSERT INTO sources (source_id, session_id, entry_id, event_type, captured_at) VALUES ('src-r1','s','e3','user',?)`).run(AT);
db.prepare(`INSERT INTO memories (id, kind, scope_json, current_revision, created_at, updated_at) VALUES ('mem-r1','fact','{}',1,?,?)`).run(AT, AT);
insLink.run("l4", "problem", "prob-rev", "src-r1", "mem-r1", 3, AT);
v = checkOwnerSourceLinksIntact(db, { owners: [{ ownerKind: "problem", ownerId: "prob-rev", label: "问题" }] });
rec("check: revision 过期拒绝", v !== undefined && v.includes("低于关联修订"), v);

// 全部有效 → undefined（通过）
db.prepare(`INSERT INTO sources (source_id, session_id, entry_id, event_type, captured_at) VALUES ('src-ok','s','e4','user',?)`).run(AT);
insLink.run("l5", "problem", "prob-ok", "src-ok", null, null, AT);
v = checkOwnerSourceLinksIntact(db, { owners: [{ ownerKind: "problem", ownerId: "prob-ok", label: "问题" }] });
rec("check: 来源有效通过", v === undefined, v ?? "undefined");

// ── E11：dbCleanupSourceReferences 清理 problem 受管正文 ───────────────
// problem 唯一证据 = src-ok → 删除后 summary/expected/actual 清空 + 状态回 pending_classification
db.prepare(`INSERT INTO evolution_problems (problem_id, kind, action, summary, expected_behavior, actual_behavior, evidence_refs_json, occurrence_count, resource_id, base_version, status, disposition, created_at, updated_at) VALUES ('prob-clean','implementation_defect','modify','S','E','A',?,1,'skill:dirskill','v-x','classified','candidate',?,?)`)
  .run(JSON.stringify(["src-ok"]), AT, AT);
insLink.run("l6", "problem", "prob-clean", "src-ok", null, null, AT);
const clean = dbCleanupSourceReferences(db, { sourceId: "src-ok", paoHome: home });
const probRow = db.prepare(`SELECT summary, status FROM evolution_problems WHERE problem_id='prob-clean'`).get();
rec("cleanup: problem 唯一证据→正文清空+pending", probRow.summary === "[cleared]" && probRow.status === "observed",
    `summary=${probRow.summary} status=${probRow.status} problemsCleaned=${clean.problemsCleaned} pending=${JSON.stringify(clean.pendingObjects)}`);

// 部分证据：problem 有 [src-ok, evidence:keep] → 只缩减 refs，不清正文
db.prepare(`INSERT INTO evolution_problems (problem_id, kind, action, summary, expected_behavior, actual_behavior, evidence_refs_json, occurrence_count, resource_id, base_version, status, disposition, created_at, updated_at) VALUES ('prob-part','implementation_defect','modify','S2','E2','A2',?,1,'skill:dirskill','v-x','classified','candidate',?,?)`)
  .run(JSON.stringify(["src-ok", "evidence:keep-9"]), AT, AT);
insLink.run("l7", "problem", "prob-part", "src-ok", null, null, AT);
dbCleanupSourceReferences(db, { sourceId: "src-ok", paoHome: home });
const partRow = db.prepare(`SELECT summary, evidence_refs_json FROM evolution_problems WHERE problem_id='prob-part'`).get();
rec("cleanup: 共享来源保留未删范围", partRow.summary === "S2" && JSON.parse(partRow.evidence_refs_json).includes("evidence:keep-9"),
    `refs=${partRow.evidence_refs_json}`);

// ── E11：cleanup 级联到 candidate + plan.json invalidated ─────────────
db.prepare(`INSERT INTO evolution_candidates (candidate_id, problem_id, resource_id, base_version, test_plan_id, diffs_json, rationale, usage_refs_json, status, created_at, updated_at) VALUES ('cand-cl','prob-part','skill:dirskill','v-x','tp-cl',?,'rat','[]','proposed',?,?)`)
  .run(JSON.stringify([{ path: "SKILL.md", kind: "edit", newContent: "x" }]), AT, AT);
insLink.run("l8", "candidate", "cand-cl", "src-ok", null, null, AT);
const planDir = join(evolutionPaths(home).validations, "tp-cl");
mkdirSync(planDir, { recursive: true });
writeFileSync(join(planDir, "plan.json"), JSON.stringify({ testPlanId: "tp-cl" }), "utf8");
insLink.run("l9", "validation", "tp-cl", "src-ok", null, null, AT);
const candDir = join(evolutionPaths(home).candidates, "skill_dirskill", "cand-cl");
mkdirSync(candDir, { recursive: true });
writeFileSync(join(candDir, "SKILL.md"), "p\n", "utf8");

dbCleanupSourceReferences(db, { sourceId: "src-ok", paoHome: home });
const candRow = db.prepare(`SELECT status, diffs_json, rationale FROM evolution_candidates WHERE candidate_id='cand-cl'`).get();
const planJson = JSON.parse(readFileSync(join(planDir, "plan.json"), "utf8"));
rec("cleanup: candidate cancelled+正文清空+目录移除+plan invalidated",
    candRow.status === "cancelled" && candRow.diffs_json === "[]" && candRow.rationale === "[cleared]" && !existsSync(candDir) && planJson.invalidated === true,
    `status=${candRow.status} dir=${existsSync(candDir)} invalidated=${planJson.invalidated}`);

store.close();
rmSync(home, { recursive: true, force: true });
const fails = results.filter(r => !r.pass);
console.log(`\n${results.length - fails.length}/${results.length} 通过`);
process.exit(fails.length ? 1 : 0);
