/**
 * O13 独立复核反面场景探针（复核代理临时文件，跑完即删；副本留 evidence/）。
 *
 * 场景：
 *  R1. E15 两轮激活 + 首轮后人工改资源根 → 第二轮激活仍 conflict（根基线防线）。
 *  R2. 同 R1 但不改根 → 第二轮激活成功（对照）。
 *  R3. recordUsed 同 receiptRef 连写两次 → 是否重复行。
 *  R4. handleRegression：任务绑坏版但坏版无任何 used 行 → 是否误归因。
 *  R5. handleRegression：别的任务有 used 行 + 本任务绑坏版 → normal_breakage。
 *  R6. ensureTaskBindings 对已绑任务再 ensure：effective 前进后重 ensure 是否
 *     把绑定静默刷到新版本（且不进 switch_history）。
 *  R7. declare 填充口径：多条绑定时 boundResource 取 items[0]（代码阅读确认，
 *     此处验证 listTaskBindings 的排序以判断 items[0] 是哪一个）。
 *  R8. 进程A写→进程B（新 store 句柄）recover 一致（已在 o13 测试覆盖，复核跑通即可）。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryStore, type MemoryStore } from "../../src/pao/memory/store.ts";
import { evolutionPaths } from "../../src/pao/memory/paths.ts";
import { registerResource, snapshotResourceFiles } from "../../src/pao/evolution/resources.ts";
import { publishCandidate } from "../../src/pao/evolution/versions.ts";
import { activateCandidate } from "../../src/pao/evolution/activation.ts";
import { bindTaskResources, listTaskBindings } from "../../src/pao/evolution/binding.ts";
import { ensureTaskBindings } from "../../src/pao/evolution/host-mount.ts";
import { recordUsed, countUsageByVersion } from "../../src/pao/evolution/observe.ts";
import { handleRegression } from "../../src/pao/evolution/regression.ts";
import { recoverEvolutionState } from "../../src/pao/evolution/recovery.ts";
import { legalPassedChain, seedClassifiedProblem } from "./fixtures/evolution-legal-chain.ts";

const tempDirs: string[] = [];
const openStores: MemoryStore[] = [];
const LOG: string[] = [];
function log(line: string) {
	LOG.push(line);
	console.log(`[o13-review] ${line}`);
}

function tempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-o13-review-"));
	tempDirs.push(dir);
	return dir;
}
function openStore(home: string): MemoryStore {
	const store = openMemoryStore(home, "readwrite");
	openStores.push(store);
	return store;
}
afterEach(async () => {
	for (const store of openStores.splice(0)) {
		try {
			store.close();
		} catch {}
	}
	for (const dir of tempDirs.splice(0)) {
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				rmSync(dir, { recursive: true, force: true });
				break;
			} catch (error) {
				if (attempt === 4) throw error;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
	}
});

const AT = "2026-11-11T10:00:00.000Z";
const AT2 = "2026-11-11T10:01:00.000Z";

function seedSkill(home: string, store: MemoryStore, name = "test-skill") {
	const skillDir = join(home, "pao配置", "skills", name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), `# ${name}\n\n步骤一: 输入\n`, "utf8");
	registerResource(store, { kind: "skill", name, paoHome: home });
	const snap = snapshotResourceFiles(store, { resourceId: `skill:${name}`, paoHome: home, createdAt: AT });
	if (!snap.ok) throw new Error("snapshot failed");
	return { resourceId: `skill:${name}` as string, baseVersion: snap.versionId, skillDir };
}

async function runChain(
	home: string,
	store: MemoryStore,
	over: { name: string; resourceId: string; baseVersion: string; newContent: string; expectedEffective: string },
) {
	const problemId = seedClassifiedProblem(store, {
		problemId: `prob-${over.name}`,
		resourceId: over.resourceId,
		baseVersion: over.baseVersion,
	});
	const { candidateId } = await legalPassedChain(store, home, {
		problemId,
		resourceId: over.resourceId,
		baseVersion: over.baseVersion,
		files: { "SKILL.md": over.newContent },
	});
	const pub = await publishCandidate(store, { candidateId, paoHome: home, createdAt: AT2 });
	if (!pub.ok || !("versionId" in pub)) throw new Error(`publish failed: ${JSON.stringify(pub)}`);
	const act = await activateCandidate(store, {
		candidateId,
		expectedEffectiveVersion: over.expectedEffective,
		paoHome: home,
		createdAt: AT2,
	});
	return { candidateId, act };
}

describe("R1/R2 E15 两轮激活与根基线", () => {
	it("R2 对照：不改根 → v2 激活成功", async () => {
		const home = tempHome();
		const store = openStore(home);
		const { resourceId, baseVersion } = seedSkill(home, store);
		const r1 = await runChain(home, store, {
			name: "v1",
			resourceId,
			baseVersion,
			newContent: "# test-skill\n\n步骤一: 输入\n步骤三: v1\n",
			expectedEffective: baseVersion,
		});
		if (!r1.act.ok || !("versionId" in r1.act)) throw new Error(`activate v1 failed: ${JSON.stringify(r1.act)}`);
		const r2 = await runChain(home, store, {
			name: "v2",
			resourceId,
			baseVersion: r1.act.versionId,
			newContent: "# test-skill\n\n步骤一: 输入\n步骤三: v2\n",
			expectedEffective: r1.act.versionId,
		});
		log(`R2 v2 activate: ${JSON.stringify(r2.act)}`);
		expect(r2.act.ok).toBe(true);
		expect("versionId" in r2.act).toBe(true);
	});

	it("R1 反面：首轮激活成功后人工改资源根 → 第二轮激活必须 conflict（根基线）", async () => {
		const home = tempHome();
		const store = openStore(home);
		const { resourceId, baseVersion, skillDir } = seedSkill(home, store);
		const r1 = await runChain(home, store, {
			name: "v1",
			resourceId,
			baseVersion,
			newContent: "# test-skill\n\n步骤一: 输入\n步骤三: v1\n",
			expectedEffective: baseVersion,
		});
		if (!r1.act.ok || !("versionId" in r1.act)) throw new Error(`activate v1 failed: ${JSON.stringify(r1.act)}`);
		// 首轮后人工改根。
		writeFileSync(join(skillDir, "SKILL.md"), "# test-skill\n\n步骤一: 输入\n步骤三: 人工补丁\n", "utf8");
		const r2 = await runChain(home, store, {
			name: "v2",
			resourceId,
			baseVersion: r1.act.versionId,
			newContent: "# test-skill\n\n步骤一: 输入\n步骤三: v2\n",
			expectedEffective: r1.act.versionId,
		});
		log(`R1 v2 activate(改根后): ${JSON.stringify(r2.act)}`);
		expect(r2.act.ok).toBe(true);
		if (!r2.act.ok) return;
		expect("status" in r2.act && r2.act.status === "conflict").toBe(true);
	});

	it("R1b 反面：人工改根后且恶意删 v1 版本目录 → v2 激活仍 conflict（两层防线之一必拦）", async () => {
		const home = tempHome();
		const store = openStore(home);
		const { resourceId, baseVersion, skillDir } = seedSkill(home, store);
		const r1 = await runChain(home, store, {
			name: "v1",
			resourceId,
			baseVersion,
			newContent: "# test-skill\n\n步骤一: 输入\n步骤三: v1\n",
			expectedEffective: baseVersion,
		});
		if (!r1.act.ok || !("versionId" in r1.act)) throw new Error(`activate v1 failed`);
		writeFileSync(join(skillDir, "SKILL.md"), "# test-skill\n\n步骤一: 输入\n步骤三: 人工补丁\n", "utf8");
		// 破坏 base 版本目录。
		const dirSafe = resourceId.replace(/:/g, "_");
		writeFileSync(join(evolutionPaths(home).versions, dirSafe, r1.act.versionId, "SKILL.md"), "tampered", "utf8");
		// 坏 base 目录在 publish 门即被拦（publish 核对 baseline 目录指纹）——比激活更早的防线。
		const problemId = seedClassifiedProblem(store, { problemId: "prob-v2b", resourceId, baseVersion: r1.act.versionId });
		const { candidateId } = await legalPassedChain(store, home, {
			problemId,
			resourceId,
			baseVersion: r1.act.versionId,
			files: { "SKILL.md": "# test-skill\n\n步骤一: 输入\n步骤三: v2\n" },
		});
		const pub = await publishCandidate(store, { candidateId, paoHome: home, createdAt: AT2 });
		log(`R1b publish(坏base目录): ${JSON.stringify(pub)}`);
		expect(pub.ok).toBe(true);
		if (!pub.ok) return;
		expect("status" in pub && pub.status === "not_ready").toBe(true);
	});
});

describe("R3 recordUsed 幂等", () => {
	it("同 (taskId,resourceId,receiptRef) 连写两次 → 观察行数", () => {
		const home = tempHome();
		const store = openStore(home);
		const { resourceId } = seedSkill(home, store);
		bindTaskResources(store, { taskId: "sess-1", resourceIds: [resourceId] });
		const w1 = recordUsed(store, { resourceId, taskId: "sess-1", receiptRef: "receipt:x" });
		const w2 = recordUsed(store, { resourceId, taskId: "sess-1", receiptRef: "receipt:x" });
		const rows = store.db
			.prepare(`SELECT COUNT(*) AS n FROM evolution_observations WHERE resource_id = ? AND action = 'used'`)
			.get(resourceId) as { n: number };
		log(`R3 两次同 receiptRef 写入 ok=${w1.ok}/${w2.ok}，used 行数=${rows.n}`);
		// 如实记录行为（不断言方向——复核先摸清事实）。
		expect(w1.ok && w2.ok).toBe(true);
	});
});

describe("R4/R5 handleRegression 判定前提", () => {
	it("R4：绑坏版 + 无任何 used 行 + 无 problemId → 应 isRegression=false", async () => {
		const home = tempHome();
		const store = openStore(home);
		const { resourceId, baseVersion } = seedSkill(home, store);
		const r1 = await runChain(home, store, {
			name: "v1",
			resourceId,
			baseVersion,
			newContent: "# test-skill\n\n步骤一: 输入\n步骤三: v1\n",
			expectedEffective: baseVersion,
		});
		if (!r1.act.ok || !("versionId" in r1.act)) throw new Error("activate v1 failed");
		bindTaskResources(store, { taskId: "sess-nofail", resourceIds: [resourceId] });
		const reg = handleRegression(store, {
			resourceId,
			taskId: "sess-nofail",
			failureDescription: "坏了",
			paoHome: home,
		});
		log(`R4 judge: ${JSON.stringify(reg.ok ? reg.judgement : reg)}`);
		expect(reg.ok).toBe(true);
		if (!reg.ok) return;
		expect(reg.judgement.isRegression).toBe(false);
		expect(reg.rolledBack).toBe(false);
	});

	it("R5：坏版有 used 行（别的任务写的）+ 本任务绑坏版 → normal_breakage 判定", async () => {
		const home = tempHome();
		const store = openStore(home);
		const { resourceId, baseVersion } = seedSkill(home, store);
		const r1 = await runChain(home, store, {
			name: "v1",
			resourceId,
			baseVersion,
			newContent: "# test-skill\n\n步骤一: 输入\n步骤三: v1\n",
			expectedEffective: baseVersion,
		});
		if (!r1.act.ok || !("versionId" in r1.act)) throw new Error("activate v1 failed");
		bindTaskResources(store, { taskId: "sess-A", resourceIds: [resourceId] });
		recordUsed(store, { resourceId, taskId: "sess-A", receiptRef: "rA", outcome: "success" });
		// sess-B 也绑坏版但自己没写过 used——失败归因仍成立（判据=坏版有 used 行+本任务绑坏版）。
		bindTaskResources(store, { taskId: "sess-B", resourceIds: [resourceId] });
		const reg = handleRegression(store, {
			resourceId,
			taskId: "sess-B",
			failureDescription: "sess-B 失败",
			paoHome: home,
		});
		log(`R5 judge: ${JSON.stringify(reg.ok ? reg.judgement : reg)}`);
		expect(reg.ok).toBe(true);
		if (!reg.ok) return;
		expect(reg.judgement.isRegression).toBe(true);
		expect(reg.judgement.kind).toBe("normal_breakage");
	});
});

describe("R6 ensure 重绑语义", () => {
	it("R6：effective 前进后对已绑会话再 ensure → 绑定刷新与否/历史追加与否", async () => {
		const home = tempHome();
		const store = openStore(home);
		const { resourceId, baseVersion } = seedSkill(home, store);
		ensureTaskBindings(store, { taskId: "sess-x", paoHome: home });
		const r1 = await runChain(home, store, {
			name: "v1",
			resourceId,
			baseVersion,
			newContent: "# test-skill\n\n步骤一: 输入\n步骤三: v1\n",
			expectedEffective: baseVersion,
		});
		if (!r1.act.ok || !("versionId" in r1.act)) throw new Error("activate v1 failed");
		ensureTaskBindings(store, { taskId: "sess-x", paoHome: home });
		const bindings = listTaskBindings(store, { taskId: "sess-x", activeOnly: true });
		expect(bindings.ok).toBe(true);
		if (!bindings.ok) return;
		log(`R6 重 ensure 后绑定: versionId=${bindings.items[0]!.versionId} history=${JSON.stringify(bindings.items[0]!.switchHistory)}`);
		// 事实记录：绑定被刷到新 effective；switch_history 是否追加。
		expect(bindings.items[0]!.versionId).toBe(r1.act.versionId);
	});
});

describe("R7 declare 资源归属", () => {
	it("R7：两条 active 绑定时 listTaskBindings 排序（items[0] 是 bound_at 最新者）", () => {
		const home = tempHome();
		const store = openStore(home);
		seedSkill(home, store, "skill-first");
		seedSkill(home, store, "skill-second");
		ensureTaskBindings(store, { taskId: "sess-multi", paoHome: home });
		const bindings = listTaskBindings(store, { taskId: "sess-multi", activeOnly: true });
		expect(bindings.ok).toBe(true);
		if (!bindings.ok) return;
		log(`R7 绑定顺序: ${bindings.items.map((b) => `${b.resourceId}@${b.boundAt}`).join(", ")}`);
		expect(bindings.items.length).toBe(2);
	});
});

describe("R9 declare 多绑定误归因→真实回退", () => {
	it("R9：会话绑 A+B、A 的 effective 有 used 行 → declare 后 handleRegression 是否回退无辜资源", async () => {
		const home = tempHome();
		const store = openStore(home);
		// 资源 A 做过一轮进化（effective=v1A）；资源 B 只有快照。
		const a = seedSkill(home, store, "skill-a");
		const r1 = await runChain(home, store, {
			name: "a-v1",
			resourceId: a.resourceId,
			baseVersion: a.baseVersion,
			newContent: "# skill-a\n\n步骤一: 输入\n步骤三: v1\n",
			expectedEffective: a.baseVersion,
		});
		if (!r1.act.ok || !("versionId" in r1.act)) throw new Error("activate a-v1 failed");
		const b = seedSkill(home, store, "skill-b");
		// 会话绑两资源（主会话全量口径），模拟 settled 写过 used（绑 A 的 v1 版）。
		ensureTaskBindings(store, { taskId: "sess-multi", paoHome: home });
		recordUsed(store, { resourceId: a.resourceId, taskId: "sess-multi", sessionId: "sess-multi", receiptRef: "session:sess-multi:settled:1" });
		recordUsed(store, { resourceId: b.resourceId, taskId: "sess-multi", sessionId: "sess-multi", receiptRef: "session:sess-multi:settled:1" });
		// 模拟 declare 的填充：items[0] 是哪个资源？
		const sessionBindings = listTaskBindings(store, { taskId: "sess-multi", activeOnly: true });
		if (!sessionBindings.ok) throw new Error("list failed");
		const boundResource = sessionBindings.items[0]!;
		log(`R9 items[0]=${boundResource.resourceId} v=${boundResource.versionId}`);
		// declare 受理后宿主调的 handleRegression（problemId=新问题，其无候选 → original_problem 不成立，
		// 走 normal_breakage 判据：本任务绑坏版 + 坏版有 used 行）。
		const reg = handleRegression(store, {
			resourceId: boundResource.resourceId,
			problemId: "prob-brand-new",
			taskId: "sess-multi",
			failureDescription: "模型抱怨了点什么（可能是 B 的问题）",
			paoHome: home,
		});
		log(`R9 regression: ${JSON.stringify(reg.ok ? { isReg: reg.judgement.isRegression, kind: reg.judgement.kind, rolledBack: reg.rolledBack, bad: reg.badVersion } : reg)}`);
		expect(reg.ok).toBe(true);
		if (!reg.ok) return;
		if (reg.judgement.isRegression) {
			log(`R9 !!回退发生: ${boundResource.resourceId} badVersion=${reg.badVersion} rolledBack=${reg.rolledBack}`);
		}
		// 补强：items[0] 落在进化过的资源 A 上时，回退是否真执行（A 有上一有效版可回）。
		const regA = handleRegression(store, {
			resourceId: a.resourceId,
			problemId: "prob-brand-new-2",
			taskId: "sess-multi",
			failureDescription: "模型抱怨了点什么（与 A 无关）",
			paoHome: home,
		});
		log(`R9-A regression: ${JSON.stringify(regA.ok ? { isReg: regA.judgement.isRegression, kind: regA.judgement.kind, rolledBack: regA.rolledBack, bad: regA.badVersion, prev: regA.previousVersion } : regA)}`);
		const effA = (store.db.prepare(`SELECT effective_version FROM evolution_resources WHERE resource_id = ?`).get(a.resourceId) as { effective_version: string }).effective_version;
		log(`R9-A effective 现状: ${effA}（原 v1A=${r1.act.versionId}）`);
	});
});

describe("R8 跨进程 recover", () => {
	it("R8：进程A写入→新 store 句柄 recover", async () => {
		const home = tempHome();
		{
			const storeA = openStore(home);
			const { resourceId, baseVersion } = seedSkill(home, storeA);
			const r1 = await runChain(home, storeA, {
				name: "v1",
				resourceId,
				baseVersion,
				newContent: "# test-skill\n\n步骤一: 输入\n步骤三: v1\n",
				expectedEffective: baseVersion,
			});
			if (!r1.act.ok || !("versionId" in r1.act)) throw new Error("activate v1 failed");
			ensureTaskBindings(storeA, { taskId: "sess-p", paoHome: home });
			storeA.close();
		}
		const storeB = openStore(home);
		const report = recoverEvolutionState(storeB, { paoHome: home });
		log(`R8 recover: attention=${JSON.stringify(report.ok ? report.needsAttention : report)}`);
		expect(report.ok).toBe(true);
		if (!report.ok) return;
		expect(report.needsAttention).toEqual([]);
	});
});
