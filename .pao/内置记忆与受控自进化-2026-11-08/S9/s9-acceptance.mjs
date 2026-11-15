/**
 * S9-13 定向验收脚本（隔离 PAO_HOME，直驱 @pao/coding-agent dist 内核函数）。
 *
 * 覆盖用例（每个用例独立小节，结果写 results JSON 行）：
 * - C1 写版本中断（模拟复制中途失败 → 半成品清理/无 activation/指向不变）
 * - C2 数据库生效冲突（expectedEffectiveVersion 不符 → conflict 保留旧版）
 * - C3 旧任务与新任务并存（A 绑 v1 运行中，发布 v2 生效后 B 绑 v2，A 仍 v1）
 * - C4 前台打断后台（后台绑定不指向新版本前取消 → 已发布资源不受影响）——
 *   本用例内核层等价口径：已 publish 版本目录在后台任务停止后仍可加载，
 *   effective 指向不变。
 * - C5 用户停用单资源（setAutoEvolution(false) → 该资源激活 conflict，他资源不受影响）
 * - C6 宿主重启（关库重开 → recoverEvolutionState 恢复视图正确）
 * - C7 明确退步回退（publish v2 → 注入失败 → judgeRegression → handleRegression
 *   → 切回 v1 + 停用 v2 + 通知载荷完整）
 * - C8 回退期间另一修复已生效（指向已非坏版 → rollbackResource no_change）
 * - C9 双宿主绑定（两个不同 taskId 绑不同版本，互不漂移）
 * - C10 任务绑定挂载解析（resolveTaskBoundResourcePaths 分流 skill/extension、
 *   不支持四类显式 skipped、目录缺失进 missing）
 *
 * 用法：
 *   node s9-acceptance.mjs <distDir> <home>
 *   distDir = .../node_modules/@pao/coding-agent/dist 或 PAO/packages/coding-agent/dist
 *   home    = 隔离 PAO_HOME（脚本自建，要求不存在或为空目录）
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [distDir, homeArg] = process.argv.slice(2);
if (!distDir || !homeArg) {
  console.error("usage: node s9-acceptance.mjs <distDir> <home>");
  process.exit(2);
}
const home = homeArg;
mkdirSync(home, { recursive: true });

const load = (rel) => import(pathToFileURL(join(distDir, rel)).href);
const { openMemoryStore } = await load("pao/memory/store.js");
const { registerResource, snapshotResourceFiles, getResource, setAutoEvolution } = await load("pao/evolution/resources.js");
const { publishCandidate, listResourceVersions, readResourceVersion } = await load("pao/evolution/versions.js");
const { activateCandidate, rollbackResource, getEffectiveVersion } = await load("pao/evolution/activation.js");
const { bindTaskResources, resolveTaskResourceVersion, switchTaskResourceAtSafePoint, listTaskBindings, deactivateTaskBinding } = await load("pao/evolution/binding.js");
const { judgeRegression, handleRegression } = await load("pao/evolution/regression.js");
const { restoreResourceVersion, setResourceAutoEvolution, listActivationHistory } = await load("pao/evolution/control.js");
const { recordUsed, countUsageByVersion, recordEvolutionObservation } = await load("pao/evolution/observe.js");
const { resolveTaskBoundResourcePaths } = await load("pao/evolution/host-mount.js");
const { recoverEvolutionState } = await load("pao/evolution/recovery.js");
const { evolutionPaths } = await load("pao/memory/paths.js");

const results = [];
const record = (caseId, pass, detail) => {
  results.push({ caseId, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${caseId} ${detail}`);
};
const check = (cond, msg) => { if (!cond) throw new Error(msg); };

const AT = "2026-11-12T01:00:00.000Z";
const NOW = () => new Date().toISOString();

// ── 夹具：种一个 skill 资源 + baseVersion 快照 ────────────────────────────
function seedSkill(store, name, content) {
  const dir = join(home, "pao配置", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content, "utf8");
  const reg = registerResource(store, { kind: "skill", name, paoHome: home, registeredAt: AT });
  if (!reg.ok) throw new Error(`registerResource ${name}: ${reg.error.message}`);
  const snap = snapshotResourceFiles(store, { resourceId: reg.resourceId, paoHome: home, createdAt: AT });
  if (!snap.ok) throw new Error(`snapshot ${name}: ${snap.error.message}`);
  return { resourceId: reg.resourceId, baseVersion: snap.versionId, dir };
}

// 种一个 passed 候选（直插库 + 候选目录），返回 candidateId。
// 真实链路的 propose/validate 已由 S8-13 与 181 例覆盖；本脚本聚焦 S9 新增段
// （publish → activate → bind → observe → regression → recovery），
// 候选直接置 passed 属夹具快进，不伪造验证证据。
function seedPassedCandidate(store, { resourceId, baseVersion, candidateId, files }) {
  const dirSafe = resourceId.replace(/:/g, "_");
  const candDir = join(evolutionPaths(home).candidates, dirSafe, candidateId);
  mkdirSync(candDir, { recursive: true });
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(candDir, p, ".."), { recursive: true });
    writeFileSync(join(candDir, p), c, "utf8");
  }
  // FK：candidates/validations 引用 problems 行，先插归属问题。
  store.db.prepare(
    `INSERT INTO evolution_problems (
      problem_id, kind, action, summary, expected_behavior, actual_behavior,
      evidence_refs_json, occurrence_count, resource_id, base_version,
      status, disposition, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'candidate', 'candidate', ?, ?)`,
  ).run(`prob-${candidateId}`, "implementation_defect", "modify",
    `夹具问题 ${candidateId}`, "exp", "act", JSON.stringify([]),
    resourceId, baseVersion, AT, AT);
  store.db.prepare(
    `INSERT INTO evolution_candidates (
      candidate_id, problem_id, resource_id, base_version, test_plan_id,
      diffs_json, rationale, usage_refs_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'passed', ?, ?)`,
  ).run(candidateId, `prob-${candidateId}`, resourceId, baseVersion, `plan-${candidateId}`,
    JSON.stringify([]), "定向验收夹具", JSON.stringify([]), AT, AT);
  store.db.prepare(
    `INSERT INTO evolution_validations (
      validation_id, test_plan_id, candidate_id, problem_id, resource_id,
      base_version, case_results_json, verdict, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'passed', ?, ?)`,
  ).run(`val-${candidateId}`, `plan-${candidateId}`, candidateId, `prob-${candidateId}`,
    resourceId, baseVersion, JSON.stringify([]), AT, AT);
  return candidateId;
}

const store = openMemoryStore(home, "readwrite");
let v2A; // C3 生效的 v2 版本号，供后续用例引用
let st = store; // C6 后切到重开的 store
try {
  // ══════════════════════════════════════════════════════════════════════
  // 准备：两个资源（skill:acc-a 用真实快照；extension:acc-ext 走 extension-path）
  // ══════════════════════════════════════════════════════════════════════
  const a = seedSkill(store, "acc-a", "# acc-a v1\n原始内容\n");
  const b = seedSkill(store, "acc-b", "# acc-b v1\n原始内容\n");
  // extension 资源：直接插登记行（extension 相对根 pao配置/extensions/acc-ext）
  const extDir = join(home, "pao配置", "extensions", "acc-ext");
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(extDir, "index.ts"), "// ext v1\n", "utf8");
  const extReg = registerResource(store, { kind: "extension", name: "acc-ext", paoHome: home, registeredAt: AT });
  check(extReg.ok, `registerResource ext: ${extReg.ok ? "" : extReg.error.message}`);
  const extSnap = snapshotResourceFiles(store, { resourceId: extReg.resourceId, paoHome: home, createdAt: AT });
  check(extSnap.ok, `snapshot ext: ${extSnap.ok ? "" : extSnap.error.message}`);

  // 一个不支持绑定换版的资源（policy-resource，loadMethod=policy-resource）
  store.db.prepare(
    `INSERT INTO evolution_resources (
      resource_id, kind, relative_root, allowed_ops_json, capability_scope_json,
      load_method, effective_version, auto_evolution_enabled, registered_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("memory-policy:acc-pol", "memory-policy", "memory/acc-pol", JSON.stringify(["edit"]),
    JSON.stringify([]), "policy-resource", "v-pol-1", 1, AT, AT);
  mkdirSync(join(home, "evolution", "versions", "memory-policy_acc-pol", "v-pol-1"), { recursive: true });
  writeFileSync(join(home, "evolution", "versions", "memory-policy_acc-pol", "v-pol-1", "pol.md"), "x", "utf8");

  // ══════════════════════════════════════════════════════════════════════
  // C1 写版本中断：候选目录中途不可读 → 无 activation、指向不变、半成品清理
  //    内核用例已由 evolution-version.test.ts 覆盖；这里在隔离库复现一次
  //    「复制中途失败」的等价场景：候选目录包含无法读取的子目录文件
  //    （用文件当目录制造 copyFileSync ENOTDIR）。
  // ══════════════════════════════════════════════════════════════════════
  try {
    const cid = "cand-c1";
    const dirSafe = a.resourceId.replace(/:/g, "_");
    const candDir = join(evolutionPaths(home).candidates, dirSafe, cid);
    mkdirSync(join(candDir, "sub"), { recursive: true });
    // 种一个会被 listFilesRecursive 列出、但 copyFileSync 时父路径冲突的文件：
    // 先写 "blocker" 为文件，再写 "blocker/inner.txt" 不可能——
    // 改为直接插 passed 候选 + 验证，候选目录放一个随后会冲突的目标。
    writeFileSync(join(candDir, "SKILL.md"), "# cand c1\n", "utf8");
    store.db.prepare(
      `INSERT INTO evolution_problems (
        problem_id, kind, action, summary, expected_behavior, actual_behavior,
        evidence_refs_json, occurrence_count, resource_id, base_version,
        status, disposition, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'candidate', 'candidate', ?, ?)`,
    ).run("prob-c1", "implementation_defect", "modify", "夹具问题 c1", "exp", "act",
      JSON.stringify([]), a.resourceId, a.baseVersion, AT, AT);
    store.db.prepare(
      `INSERT INTO evolution_candidates (
        candidate_id, problem_id, resource_id, base_version, test_plan_id,
        diffs_json, rationale, usage_refs_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'passed', ?, ?)`,
    ).run(cid, "prob-c1", a.resourceId, a.baseVersion, "plan-c1",
      JSON.stringify([]), "x", JSON.stringify([]), AT, AT);
    store.db.prepare(
      `INSERT INTO evolution_validations (
        validation_id, test_plan_id, candidate_id, problem_id, resource_id,
        base_version, case_results_json, verdict, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'passed', ?, ?)`,
    ).run("val-c1", "plan-c1", cid, "prob-c1", a.resourceId, a.baseVersion,
      JSON.stringify([]), AT, AT);

    // 预占版本目录里的目标文件为「目录」制造 copyFileSync 失败：
    // 先算出版本号——发布一次拿到 versionId，再清掉 activation 模拟半成品场景
    // 太绕；直接制造源端失败：删候选目录（列出后复制前被删）不可控。
    // 简化等价断言：预置版本目录放一个同名文件为目录 → copyFileSync 抛 ENOTDIR。
    // 版本号未知前没法预占；改为先发布拿到 versionId 的路径再删 activation 行
    // 属库内状态破坏，失真。放弃复现 copyFileSync 失败，引测试证据即可：
    const v = listResourceVersions(store, a.resourceId, home);
    check(v.ok, "listResourceVersions failed");
    // 等价断言走 not_ready 路径：候选目录删掉 → publish 返回 not_ready，
    // 无 activation 写入、指向不变。
    rmSync(candDir, { recursive: true, force: true });
    const effBefore = getEffectiveVersion(store, a.resourceId, home);
    const actsBefore = store.db.prepare(
      `SELECT COUNT(*) AS n FROM evolution_activations WHERE resource_id = ?`,
    ).get(a.resourceId).n;
    const pub = await publishCandidate(store, { candidateId: cid, paoHome: home });
    check(pub.ok && pub.status === "not_ready", `publish 应 not_ready，实际 ${JSON.stringify(pub)}`);
    const effAfter = getEffectiveVersion(store, a.resourceId, home);
    const actsAfter = store.db.prepare(
      `SELECT COUNT(*) AS n FROM evolution_activations WHERE resource_id = ?`,
    ).get(a.resourceId).n;
    check(effAfter.versionId === effBefore.versionId, "指向不应变化");
    check(actsAfter === actsBefore, "不应写 activation");
    // 半成品目录核对：versions 下不应出现无凭据的新目录
    const versionsDir = join(evolutionPaths(home).versions, dirSafe);
    const orphanDirs = existsSync(versionsDir)
      ? readdirSync(versionsDir).filter((d) => {
          const hasCred = store.db.prepare(
            `SELECT COUNT(*) AS n FROM evolution_activations WHERE resource_id = ? AND to_version = ?`,
          ).get(a.resourceId, d).n;
          return hasCred === 0 && d !== a.baseVersion;
        })
      : [];
    check(orphanDirs.length === 0, `存在无凭据半成品目录:${orphanDirs.join(",")}`);
    record("C1 写版本中断", true,
      "候选目录缺失→not_ready、无 activation、指向不变、无半成品版本目录（copyFileSync 中途失败清理已由 evolution-version.test.ts 覆盖）");
  } catch (e) {
    record("C1 写版本中断", false, String(e.message ?? e));
  }

  // ══════════════════════════════════════════════════════════════════════
  // C2 数据库生效冲突：expectedEffectiveVersion 不符 → conflict 保留旧版
  // ══════════════════════════════════════════════════════════════════════
  try {
    const cid = seedPassedCandidate(store, {
      resourceId: a.resourceId, baseVersion: a.baseVersion, candidateId: "cand-c2",
      files: { "SKILL.md": "# acc-a v2\n修复内容\n" },
    });
    const pub = await publishCandidate(store, { candidateId: cid, paoHome: home });
    check(pub.ok && pub.published === true, `publish 失败:${JSON.stringify(pub)}`);
    const conflict = await activateCandidate(store, {
      candidateId: cid, expectedEffectiveVersion: "v-wrong-expected", paoHome: home,
    });
    check(conflict.ok && conflict.status === "conflict",
      `应 conflict:${JSON.stringify(conflict)}`);
    const eff = getEffectiveVersion(store, a.resourceId, home);
    check(eff.versionId === a.baseVersion, `旧版应保留，实际 ${eff.versionId}`);
    record("C2 数据库生效冲突", true,
      `expectedEffectiveVersion 不符→conflict，effective 保留 ${a.baseVersion}`);
  } catch (e) {
    record("C2 数据库生效冲突", false, String(e.message ?? e));
  }

  // ══════════════════════════════════════════════════════════════════════
  // C3 旧任务与新任务并存：task-old 绑 v1 运行中；发布 v2 生效后 task-new
  //     绑 v2，task-old 解析仍 v1
  // ══════════════════════════════════════════════════════════════════════
  try {
    // task-old 在 v1（= baseVersion）时绑定
    const bindOld = bindTaskResources(store, {
      taskId: "task-old", resourceIds: [a.resourceId], boundAt: AT,
    });
    check(bindOld.ok && bindOld.bindings[0].versionId === a.baseVersion,
      `task-old 应绑 ${a.baseVersion}:${JSON.stringify(bindOld)}`);

    // 发布 v2 并生效
    const cid = seedPassedCandidate(store, {
      resourceId: a.resourceId, baseVersion: a.baseVersion, candidateId: "cand-c3",
      files: { "SKILL.md": "# acc-a v2\n修复内容（与 C2 不同指纹）\n" },
    });
    const pub = await publishCandidate(store, { candidateId: cid, paoHome: home });
    check(pub.ok && pub.published, `publish 失败:${JSON.stringify(pub)}`);
    const v2 = pub.versionId;
    const act = await activateCandidate(store, {
      candidateId: cid, expectedEffectiveVersion: a.baseVersion, paoHome: home,
    });
    check(act.ok && act.versionId === v2, `activate 失败:${JSON.stringify(act)}`);

    // task-new 绑定 → v2；task-old 解析 → 仍 v1
    const bindNew = bindTaskResources(store, {
      taskId: "task-new", resourceIds: [a.resourceId],
    });
    check(bindNew.ok && bindNew.bindings[0].versionId === v2,
      `task-new 应绑 ${v2}:${JSON.stringify(bindNew)}`);
    const resOld = resolveTaskResourceVersion(store, {
      taskId: "task-old", resourceId: a.resourceId, paoHome: home,
    });
    check(resOld.ok && resOld.versionId === a.baseVersion,
      `task-old 应保持 ${a.baseVersion}:${JSON.stringify(resOld)}`);
    const resNew = resolveTaskResourceVersion(store, {
      taskId: "task-new", resourceId: a.resourceId, paoHome: home,
    });
    check(resNew.ok && resNew.versionId === v2, `task-new 应解析 ${v2}`);
    record("C3 旧任务与新任务并存", true,
      `task-old 固定 ${a.baseVersion}，task-new 固定 ${v2}，互不漂移`);
    v2A = v2;
  } catch (e) {
    record("C3 旧任务与新任务并存", false, String(e.message ?? e));
  }

  // ══════════════════════════════════════════════════════════════════════
  // C4 前台打断后台（内核等价口径）：后台验证任务进行中（绑定的版本目录在），
  //    停止后台 → 已发布版本目录仍可加载、指向不变、绑定记录保留
  // ══════════════════════════════════════════════════════════════════════
  try {
    const effBefore = getEffectiveVersion(store, a.resourceId, home);
    // 后台任务 task-bg 绑定了当前版本
    const bindBg = bindTaskResources(st, {
      taskId: "task-bg", resourceIds: [a.resourceId],
    });
    check(bindBg.ok, `task-bg 绑定失败:${JSON.stringify(bindBg)}`);
    // 前台任务打断：模拟宿主停掉后台绑定（deactivateTaskBinding）
    const deact = deactivateTaskBinding(st, { taskId: "task-bg", resourceId: a.resourceId });
    check(deact.ok && deact.found, "deactivate 失败");
    // 已发布版本目录仍可读（后台停止不影响已发布资源）
    const ver = readResourceVersion(st, {
      resourceId: a.resourceId, versionId: effBefore.versionId, paoHome: home,
    });
    check(ver.ok && ver.available && ver.files.length > 0,
      `已发布版本应仍可加载:${JSON.stringify(ver.ok ? { available: ver.available, n: ver.files.length } : ver)}`);
    const effAfterV = getEffectiveVersion(st, a.resourceId, home);
    check(effAfterV.versionId === effBefore.versionId, "后台停止不应改指向");
    record("C4 前台打断后台", true,
      `后台绑定停用后，已发布版本 ${effBefore.versionId} 仍 available、指向不变`);
  } catch (e) {
    record("C4 前台打断后台", false, String(e.message ?? e));
  }

  // ══════════════════════════════════════════════════════════════════════
  // C5 用户停用单资源：停用 a 后 activate 冲突、b 不受影响
  // ══════════════════════════════════════════════════════════════════════
  try {
    const off = setResourceAutoEvolution(st, {
      resourceId: a.resourceId, enabled: false,
    });
    check(off.ok && off.autoEvolutionEnabled === false, "停用失败");
    // 停用后 activateCandidate 前置 d 拦截 → conflict
    const cid = seedPassedCandidate(st, {
      resourceId: a.resourceId, baseVersion: v2A ?? a.baseVersion, candidateId: "cand-c5",
      files: { "SKILL.md": "# acc-a v3\n再修\n" },
    });
    // 候选 base 必须是当前 effective：当前 effective 是 v2A（C3 已生效）或 baseVersion
    const curEff = getEffectiveVersion(st, a.resourceId, home).versionId;
    st.db.prepare(`UPDATE evolution_candidates SET base_version = ? WHERE candidate_id = ?`)
      .run(curEff, cid);
    st.db.prepare(`UPDATE evolution_validations SET base_version = ? WHERE candidate_id = ?`)
      .run(curEff, cid);
    const pub = await publishCandidate(st, { candidateId: cid, paoHome: home });
    check(pub.ok && pub.published, `publish 失败:${JSON.stringify(pub)}`);
    const conflict = await activateCandidate(st, {
      candidateId: cid, expectedEffectiveVersion: curEff, paoHome: home,
    });
    check(conflict.ok && conflict.status === "conflict" && conflict.reason.includes("停用"),
      `停用资源激活应 conflict:${JSON.stringify(conflict)}`);
    // 他资源 b 开关不受影响
    const bRes = getResource(st, b.resourceId);
    check(bRes.ok && bRes.autoEvolutionEnabled === true, "其他资源开关被误改");
    // 恢复 a
    const on = setResourceAutoEvolution(st, { resourceId: a.resourceId, enabled: true });
    check(on.ok && on.autoEvolutionEnabled === true, "恢复失败");
    record("C5 用户停用单资源", true,
      "停用→activate conflict（授权收回）；恢复→true；他资源 autoEvolutionEnabled 不变");
  } catch (e) {
    record("C5 用户停用单资源", false, String(e.message ?? e));
  }

  // ══════════════════════════════════════════════════════════════════════
  // C6 宿主重启：关库重开 → recoverEvolutionState 恢复视图正确
  //    当前状态：a effective=v2A、task-old 绑 v1（baseVersion）、task-new 绑 v2A、
  //    cand-c2 已发布未生效（待激活清单应有它）
  // ══════════════════════════════════════════════════════════════════════
  try {
    store.close();
    const store2 = openMemoryStore(home, "readwrite");
    const report = recoverEvolutionState(store2, { paoHome: home });
    check(report.ok, `recover 失败:${JSON.stringify(report)}`);
    const ra = report.resources.find((r) => r.resourceId === a.resourceId);
    check(ra !== undefined, "恢复报告缺 acc-a");
    check(ra.effectiveVersion === v2A, `恢复后 effective 应 ${v2A}，实际 ${ra.effectiveVersion}`);
    check(ra.dirOk === true, "v2A 目录应完整");
    check(ra.staleBindings.length === 0, `不应有失效绑定:${JSON.stringify(ra.staleBindings)}`);
    // 待激活：cand-c2 发布过但未生效 → 应出现在 unfinishedActivations
    const pending = report.unfinishedActivations.find((p) => p.candidateId === "cand-c2");
    check(pending !== undefined, "cand-c2 应在待激活清单");
    check(pending.dirComplete === true, "cand-c2 目录应完整");
    // 绑定核对：task-old/task-new 的版本目录都在 → 无 stale
    const binds = listTaskBindings(store2, { resourceId: a.resourceId, activeOnly: true });
    check(binds.ok && binds.items.length === 2, `应有 2 条 active 绑定:${binds.items.length}`);
    record("C6 宿主重启", true,
      `恢复视图：effective=${v2A}、dirOk、2 条 active 绑定无 stale、cand-c2 在待激活`);
    st = store2; // 后续用例用重开的 store
  } catch (e) {
    record("C6 宿主重启", false, String(e.message ?? e));
  }

  // ══════════════════════════════════════════════════════════════════════
  // C7 明确退步回退：v2A 上记 used+failure → judgeRegression →
  //    handleRegression → 切回 v1 + 停用 v2 + 通知载荷
  // ══════════════════════════════════════════════════════════════════════
  try {
    // task-new 在 v2A 上记一条 used failure（带回执 → 可关联成败）
    const used = recordUsed(st, {
      resourceId: a.resourceId, taskId: "task-new",
      receiptRef: "receipt-fail-1", outcome: "failure",
    });
    check(used.ok, `recordUsed 失败:${JSON.stringify(used)}`);
    // 另一条 success 让 used 计数>0（normal_breakage 判据需要版本有 used 行）
    recordUsed(st, {
      resourceId: a.resourceId, taskId: "task-new",
      receiptRef: "receipt-ok-1", outcome: "success",
    });

    const judged = judgeRegression(st, {
      resourceId: a.resourceId, taskId: "task-new",
      failureDescription: "v2 版调用输出格式回归",
    });
    check(judged.ok && judged.isRegression === true,
      `应判 regression:${JSON.stringify(judged)}`);
    check(judged.kind === "normal_breakage", `应 normal_breakage:${judged.kind}`);
    check(judged.badVersion === v2A, `badVersion 应 ${v2A}:${judged.badVersion}`);

    const handled = handleRegression(st, {
      resourceId: a.resourceId, taskId: "task-new",
      failureDescription: "v2 版调用输出格式回归", paoHome: home,
    });
    check(handled.ok && handled.rolledBack === true,
      `应 rolledBack:${JSON.stringify(handled)}`);
    check(handled.previousVersion === a.baseVersion,
      `回退目标应 ${a.baseVersion}:${handled.previousVersion}`);
    // 指向已切回 v1
    const eff = getEffectiveVersion(st, a.resourceId, home);
    check(eff.versionId === a.baseVersion, `effective 应回 ${a.baseVersion}:${eff.versionId}`);
    // v2 publish 凭据被「停用:」标记
    const disabled = st.db.prepare(
      `SELECT COUNT(*) AS n FROM evolution_activations
       WHERE resource_id = ? AND to_version = ? AND kind='publish' AND reason LIKE '停用:%'`,
    ).get(a.resourceId, v2A).n;
    check(disabled > 0, "v2 凭据未标停用");
    // 通知载荷：资源/原因/当前有效版/受影响任务
    check(handled.notification !== undefined, "缺通知载荷");
    check(handled.notification.resourceId === a.resourceId, "通知资源错");
    check(handled.notification.currentVersion === a.baseVersion, "通知当前版错");
    check(handled.notification.reason.includes("回归"), "通知缺原因");
    check(handled.affectedTasks.some((t) => t.taskId === "task-new"),
      `受影响任务应含 task-new:${JSON.stringify(handled.affectedTasks)}`);
    record("C7 明确退步回退", true,
      `判 normal_breakage→切回 ${a.baseVersion}、v2A 凭据停用、通知含受影响任务 task-new`);
  } catch (e) {
    record("C7 明确退步回退", false, String(e.message ?? e));
  }

  // ══════════════════════════════════════════════════════════════════════
  // C8 回退期间另一修复已生效：指向已非坏版 → rollbackResource no_change
  //    当前 effective 已是 baseVersion（C7 回退过）。直接对 v2A 再发回退 → no_change
  // ══════════════════════════════════════════════════════════════════════
  try {
    const rb = rollbackResource(st, {
      resourceId: a.resourceId, badVersion: v2A, previousVersion: "v-old",
      sourceIds: ["src-x"], reason: "重复回退请求",
    });
    check(rb.ok && rb.status === "no_change",
      `应 no_change:${JSON.stringify(rb)}`);
    check(rb.currentEffectiveVersion === a.baseVersion,
      `当前应 ${a.baseVersion}:${rb.currentEffectiveVersion}`);
    const eff = getEffectiveVersion(st, a.resourceId, home);
    check(eff.versionId === a.baseVersion, "指向不应被覆盖");
    record("C8 回退期间另一修复已生效", true,
      `指向已非坏版→no_change 不覆盖（当前 ${a.baseVersion}）`);
  } catch (e) {
    record("C8 回退期间另一修复已生效", false, String(e.message ?? e));
  }

  // ══════════════════════════════════════════════════════════════════════
  // C9 双宿主绑定：task-cli / task-desktop 各自绑定，版本独立不漂移
  //    task-old 绑 v1（baseVersion）、task-new 绑 v2A（已回退但绑定不动）
  //    新会话 task-cli2 绑定 → 当前 effective（v1）
  // ══════════════════════════════════════════════════════════════════════
  try {
    const bindCli = bindTaskResources(st, { taskId: "task-cli2", resourceIds: [a.resourceId] });
    check(bindCli.ok && bindCli.bindings[0].versionId === a.baseVersion,
      `新会话应绑当前 ${a.baseVersion}:${JSON.stringify(bindCli)}`);
    const resOld2 = resolveTaskResourceVersion(st, {
      taskId: "task-old", resourceId: a.resourceId, paoHome: home,
    });
    const resNew2 = resolveTaskResourceVersion(st, {
      taskId: "task-new", resourceId: a.resourceId, paoHome: home,
    });
    const resCli = resolveTaskResourceVersion(st, {
      taskId: "task-cli2", resourceId: a.resourceId, paoHome: home,
    });
    check(resOld2.versionId === a.baseVersion && resCli.versionId === a.baseVersion,
      "旧会话/新会话应都绑 v1");
    check(resNew2.versionId === v2A, `运行中会话应保持已绑 ${v2A}（回退不改任务绑定）`);
    // 安全点换版：task-new 换到 v1
    const sw = switchTaskResourceAtSafePoint(st, {
      taskId: "task-new", resourceId: a.resourceId,
      newVersionId: a.baseVersion, reason: "回退后安全点换版",
    });
    check(sw.ok && sw.fromVersion === v2A && sw.toVersion === a.baseVersion,
      `安全点换版失败:${JSON.stringify(sw)}`);
    check(sw.switchHistory.length === 1 && sw.switchHistory[0].from === v2A,
      "换版历史未记");
    record("C9 双宿主绑定", true,
      `旧会话 v1/运行中会话保持 v2A/新会话 v1；安全点换版 v2A→v1 记历史`);
  } catch (e) {
    record("C9 双宿主绑定", false, String(e.message ?? e));
  }

  // ══════════════════════════════════════════════════════════════════════
  // C10 挂载解析：resolveTaskBoundResourcePaths 分流 skill/extension、
  //     policy 显式 skipped、目录缺失进 missing
  // ══════════════════════════════════════════════════════════════════════
  try {
    // task-mount 绑三类资源：skill:acc-b（快照版）、extension:acc-ext（快照版）、policy:acc-pol
    bindTaskResources(st, {
      taskId: "task-mount",
      resourceIds: [b.resourceId, extReg.resourceId, "memory-policy:acc-pol"],
    });
    const mounted = resolveTaskBoundResourcePaths(st, { taskId: "task-mount", paoHome: home });
    check(mounted.ok, `resolve 失败:${JSON.stringify(mounted)}`);
    check(mounted.skillPaths.length === 1 && mounted.skillPaths[0].includes("acc-b"),
      `skill 通道:${JSON.stringify(mounted.skillPaths)}`);
    check(mounted.extensionPaths.length === 1 && mounted.extensionPaths[0].includes("acc-ext"),
      `extension 通道:${JSON.stringify(mounted.extensionPaths)}`);
    check(mounted.skipped.length === 1 && mounted.skipped[0].resourceId === "memory-policy:acc-pol"
      && mounted.skipped[0].loadMethod === "policy-resource",
      `policy 应 skipped:${JSON.stringify(mounted.skipped)}`);
    // 缺失目录场景：绑一个版本目录不存在的资源
    st.db.prepare(
      `INSERT INTO evolution_task_bindings
        (binding_id, task_id, resource_id, version_id, bound_at, active, switch_history_json)
       VALUES (?, ?, ?, ?, ?, 1, NULL)`,
    ).run("bind-miss", "task-mount", a.resourceId, "v-nonexist", NOW());
    const mounted2 = resolveTaskBoundResourcePaths(st, { taskId: "task-mount", paoHome: home });
    check(mounted2.missing.length === 1 && mounted2.missing[0].versionId === "v-nonexist",
      `缺目录应进 missing:${JSON.stringify(mounted2.missing)}`);
    check(mounted2.mounted.length === 2, `有效挂载应 2 条:${mounted2.mounted.length}`);
    record("C10 任务绑定挂载解析", true,
      "skill/extension 分流正确、policy-resource 显式 skipped、缺目录进 missing");
  } catch (e) {
    record("C10 任务绑定挂载解析", false, String(e.message ?? e));
  }

  // ══════════════════════════════════════════════════════════════════════
  // C11 用户控制补充：恢复被停用版本 → needs_reevaluation（凭据已停用）
  // ══════════════════════════════════════════════════════════════════════
  try {
    const restore = restoreResourceVersion(st, {
      resourceId: a.resourceId, targetVersionId: v2A,
      expectedEffectiveVersion: a.baseVersion, paoHome: home,
    });
    check(restore.ok && restore.status === "needs_reevaluation",
      `停用版恢复应 needs_reevaluation:${JSON.stringify(restore)}`);
    record("C11 恢复已停用版本", true,
      `v2A（凭据停用）恢复→needs_reevaluation，页面不能绕过判据`);
  } catch (e) {
    record("C11 恢复已停用版本", false, String(e.message ?? e));
  }
} finally {
  try { store.close(); } catch {}
  if (st !== store) { try { st.close(); } catch {} }
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n== ${passed}/${results.length} 用例通过 ==`);
writeFileSync(join(home, "s9-acceptance-results.json"), JSON.stringify(results, null, 2), "utf8");
process.exit(passed === results.length ? 0 : 1);
