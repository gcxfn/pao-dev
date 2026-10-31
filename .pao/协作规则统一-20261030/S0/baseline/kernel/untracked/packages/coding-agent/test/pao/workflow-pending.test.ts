import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { changeCardStatus, loadCard, parseCardRef, serializeCard } from "../../src/pao/cards/index.ts";
import {
	addNodeCards,
	bindMinister,
	controlPath,
	expirePending,
	type NodeIdentity,
	readControl,
	readControlReport,
	readPending,
	recordPending,
	requestRuling,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { renderReport } from "../../src/pao/workflow/driver.ts";
import { pendingKey, type WorkflowRunMode } from "../../src/pao/workflow/policy.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";
import { queryWorkflowCore } from "../../src/pao/workflow/tools.ts";
import { createDeviationPending } from "../../src/pao/workflow/transition.ts";

const ENV_KEYS = ["PAO_HOME", "PAO_RUN_MODE", "PI_OFFLINE", "PI_NO_LOCAL_LLM"] as const;
const roots: string[] = [];
let environmentBackup: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let isolatedParent: string;

interface Scenario {
	root: string;
	project: string;
	cardsDir: string;
	recipe: ReturnType<typeof parseRecipe>;
	now: string;
	options: {
		cardsDir: string;
		ownerSessionId: string;
		workspaceDir: string;
		runMode: WorkflowRunMode;
		now: () => string;
	};
}

function scenario(
	input: {
		runMode?: WorkflowRunMode;
		gated?: boolean;
		allowMainRuling?: boolean;
		nodes?: Array<{ name: string; dependsOn?: string[] }>;
	} = {},
): Scenario {
	const root = mkdtempSync(join(isolatedParent, "pao-workflow-pending-"));
	roots.push(root);
	const project = join(root, "project");
	const paoDir = join(project, ".pao");
	const cardsDir = join(paoDir, "卡");
	mkdirSync(cardsDir, { recursive: true });
	const nodes = (input.nodes ?? [{ name: "开发" }]).map((node, index) => ({
		名字: node.name,
		部门: "开发",
		目标: `任务 ${index + 1}`,
		验收: "文件存在",
		depends_on: node.dependsOn ?? [],
		人工确认: input.gated === true,
		允许请求主控裁定: input.allowMainRuling === true,
	}));
	const recipeName = `待决样例-${root.split("-").at(-1)}`;
	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: recipeName,
			参数: [],
			节点: nodes,
		})}---\n`,
		join(root, `${recipeName}.md`),
	);
	let now = "2026-10-30 10:00";
	const options = {
		cardsDir,
		ownerSessionId: "owner",
		workspaceDir: paoDir,
		runMode: input.runMode ?? "attended",
		now: () => now,
	};
	return {
		root,
		project,
		cardsDir,
		recipe,
		options,
		get now() {
			return now;
		},
		set now(value: string) {
			now = value;
		},
	} as Scenario;
}

function rewriteFlow(s: Scenario, change: (flow: ReturnType<typeof readControl>) => void): void {
	const flow = readControl(s.recipe, s.options);
	change(flow);
	if (flow.暂停 || flow.待决) flow.状态 = "挂起";
	writeFileSync(controlPath(s.recipe, s.options), `---\n${stringify(flow)}---\n`, "utf8");
}

async function bind(s: Scenario, node: string): Promise<NodeIdentity> {
	await bindMinister(s.recipe, s.options, node, `minister-${node}`);
	const flow = readControl(s.recipe, s.options);
	return {
		实例: flow.实例,
		节点: node,
		轮次: flow.节点.find((candidate) => candidate.名字 === node)!.轮次,
		部长会话: `minister-${node}`,
	};
}

async function cardAtAttemptOne(s: Scenario) {
	await startControl(s.recipe, {}, s.options);
	const identity = await bind(s, "开发");
	const [ref] = await addNodeCards(s.recipe, s.options, identity, [{ goal: "待决绑定", acceptance: "文件存在" }]);
	changeCardStatus(loadCard(s.cardsDir, parseCardRef(ref)), {
		操作者: "owner",
		to: "in_progress",
		时间: "2026-10-30 10:00",
	});
	const card = loadCard(s.cardsDir, parseCardRef(ref));
	return { identity, ref, card };
}

function deviation(
	identity: NodeIdentity,
	cardRef: string,
	attempt: number,
	input: {
		reason?: string;
		createdAt?: string;
		deadline?: string;
		round?: number;
	} = {},
) {
	return createDeviationPending({
		instance: identity.实例,
		node: identity.节点,
		round: input.round ?? identity.轮次,
		cardRef,
		cardNo: parseCardRef(cardRef),
		attempt,
		reason: input.reason ?? "自报未运行，须逐项依据",
		items: [{ verification_index: 0, 条件: "实际运行", 自报结论: "not_run" }],
		createdAt: input.createdAt ?? "2026-10-30T02:00:00.000Z",
		deadline: input.deadline ?? "2026-10-30T02:30:00.000Z",
	});
}

beforeEach(() => {
	const parent = process.env.PAO_HOME?.trim();
	if (!parent) throw new Error("待决测试须先设置显式隔离 PAO_HOME 作为临时目录父级");
	mkdirSync(parent, { recursive: true });
	isolatedParent = resolve(parent);
	for (const key of ENV_KEYS) environmentBackup[key] = process.env[key];
	process.env.PAO_HOME = parent;
	process.env.PI_OFFLINE = "1";
	process.env.PI_NO_LOCAL_LLM = "1";
	delete process.env.PAO_RUN_MODE;
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const previous = environmentBackup[key];
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	}
	environmentBackup = {};
	for (const root of roots.splice(0)) {
		const child = relative(isolatedParent, resolve(root));
		if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
			throw new Error(`拒绝清理隔离 PAO_HOME 外的路径：${root}`);
		rmSync(root, { recursive: true, force: true });
	}
});

describe("I1-2 结构化待决与普通裁定路由", () => {
	it("同一 instance/node/round/card/attempt 生成稳定 key，并写入真实控制正本", async () => {
		const s = scenario();
		const { identity, ref, card } = await cardAtAttemptOne(s);
		const pending = deviation(identity, ref, card.frontmatter.attempt);
		expect(pending.key).toBe(
			pendingKey({
				kind: "普通偏差",
				instance: identity.实例,
				node: identity.节点,
				round: identity.轮次,
				cardRef: ref,
				attempt: card.frontmatter.attempt,
			}),
		);

		await recordPending(s.recipe, s.options, pending);
		const persisted = readFileSync(controlPath(s.recipe, s.options), "utf8");
		expect(persisted).toContain("待决:");
		expect(persisted).toContain(pending.key);
		expect(await readPending(s.recipe, s.options, pending.key)).toEqual(pending);
	});

	it("同 key 重复只保留同一暂停事实，不叠加 flow.暂停 或审计项", async () => {
		const s = scenario();
		const { identity, ref, card } = await cardAtAttemptOne(s);
		const first = deviation(identity, ref, card.frontmatter.attempt);
		const second = deviation(identity, ref, card.frontmatter.attempt, {
			createdAt: "2026-10-30T02:05:00.000Z",
			deadline: "2026-10-30T02:35:00.000Z",
		});

		await recordPending(s.recipe, s.options, first);
		const before = readControl(s.recipe, s.options);
		await recordPending(s.recipe, s.options, second);
		const after = readControl(s.recipe, s.options);
		expect(after.暂停).toBe(before.暂停);
		expect(after.待决?.created_at).toBe(first.created_at);
		expect(after.待决?.deadline).toBe(first.deadline);
		expect(after.记录.filter((record) => record.事件 === "登记普通偏差待决")).toHaveLength(1);
	});

	it("新无人值守实例的普通请求走主控，即使冻结配方禁止主控裁定", async () => {
		const s = scenario({ runMode: "unattended", allowMainRuling: false });
		await startControl(s.recipe, {}, s.options);
		const identity = await bind(s, "开发");

		const pending = await requestRuling(s.recipe, s.options, identity, "当前边界需要判断", true);
		expect(pending).toMatchObject({ kind: "普通裁定", channel: "主控", default_action: "failed" });
		const flow = readControl(s.recipe, s.options);
		expect(flow.冻结配方.节点[0]!.允许请求主控裁定).toBe(false);
		expect(flow.裁定).toMatchObject({ 通道: "主控", 理由: "当前边界需要判断" });
		expect(flow.运行方式).toBe("无人值守");
	});

	it("明确人工确认门仍走人工；无人值守在启动前拒绝含人工门的配方", async () => {
		const attended = scenario({ gated: true, allowMainRuling: true });
		await startControl(attended.recipe, {}, attended.options);
		const identity = await bind(attended, "开发");
		const pending = await requestRuling(attended.recipe, attended.options, identity, "请用户确认", true);
		expect(pending).toMatchObject({ kind: "人工确认", channel: "人工", default_action: "stop_unconfirmed" });

		const unattended = scenario({ gated: true, runMode: "unattended" });
		await expect(startControl(unattended.recipe, {}, unattended.options)).rejects.toThrow(/人工确认门/);
		expect(() => readControl(unattended.recipe, unattended.options)).toThrow(/缺少控制清单/);
	});

	it("可注入时钟到期后只记录 failed，保留待决、暂停与执行占位", async () => {
		const s = scenario({ runMode: "unattended" });
		const { identity, ref, card } = await cardAtAttemptOne(s);
		const pending = deviation(identity, ref, card.frontmatter.attempt, {
			reason: "三项未运行",
			createdAt: "2026-10-30T02:00:00.000Z",
			deadline: "2026-10-30T02:30:00.000Z",
		});
		await recordPending(s.recipe, s.options, pending);
		const pauseBefore = readControl(s.recipe, s.options).暂停;

		s.now = "2026-10-30 10:29";
		await expect(expirePending(s.recipe, s.options)).resolves.toBeUndefined();
		s.now = "2026-10-30 10:30";
		await expirePending(s.recipe, s.options);

		const flow = readControl(s.recipe, s.options);
		expect(flow.待决).toMatchObject({ key: pending.key, phase: "已过期" });
		expect(flow.暂停).toBe(pauseBefore);
		expect(flow.结果).toEqual([
			expect.objectContaining({
				state: "failed",
				pending_key: pending.key,
				writer_stop_confirmed: false,
			}),
		]);
		expect(loadCard(s.cardsDir, parseCardRef(ref)).frontmatter.status).toBe("in_progress");
		expect((await readControlReport(flow, s.options)).stop_reason).toContain("待决已过期");
	});

	it("旧有人值守实例保持原通道：未授权走人工，授权且 owner 在场走主控", async () => {
		const manual = scenario({ allowMainRuling: false });
		await startControl(manual.recipe, {}, manual.options);
		const manualIdentity = await bind(manual, "开发");
		const manualPending = await requestRuling(manual.recipe, manual.options, manualIdentity, "旧通道人工", true);
		expect(manualPending).toMatchObject({ kind: "人工确认", channel: "人工" });

		const main = scenario({ allowMainRuling: true });
		await startControl(main.recipe, {}, main.options);
		const mainIdentity = await bind(main, "开发");
		const mainPending = await requestRuling(main.recipe, main.options, mainIdentity, "旧通道主控", true);
		expect(mainPending).toMatchObject({ kind: "普通裁定", channel: "主控" });
	});

	it("旧 attempt、旧节点轮次和已启动下游后的迟到请求均在落盘前拒绝", async () => {
		const attemptCase = scenario();
		const { identity, ref, card } = await cardAtAttemptOne(attemptCase);
		const staleAttempt = deviation(identity, ref, card.frontmatter.attempt);
		writeFileSync(
			card.path,
			serializeCard({ ...card.frontmatter, attempt: card.frontmatter.attempt + 1 }, card.body),
			"utf8",
		);
		await expect(recordPending(attemptCase.recipe, attemptCase.options, staleAttempt)).rejects.toThrow(
			/attempt 已过期/,
		);

		const roundCase = scenario();
		const roundBound = await cardAtAttemptOne(roundCase);
		const staleRound = deviation(roundBound.identity, roundBound.ref, roundBound.card.frontmatter.attempt, {
			round: roundBound.identity.轮次 + 1,
		});
		await expect(recordPending(roundCase.recipe, roundCase.options, staleRound)).rejects.toThrow(/轮次过期/);

		const downstreamCase = scenario({
			nodes: [{ name: "开发" }, { name: "审查", dependsOn: ["开发"] }],
		});
		await startControl(downstreamCase.recipe, {}, downstreamCase.options);
		const developer = await bind(downstreamCase, "开发");
		rewriteFlow(downstreamCase, (flow) => {
			flow.节点.find((node) => node.名字 === "审查")!.部长会话 = "minister-审查";
		});
		await expect(
			requestRuling(downstreamCase.recipe, downstreamCase.options, developer, "下游已启动后的迟到请求", true),
		).rejects.toThrow(/下游已经启动/);
		expect(readControl(downstreamCase.recipe, downstreamCase.options).待决).toBeUndefined();
	});

	it("另一节点的新请求不能覆盖已有待决", async () => {
		const s = scenario({
			allowMainRuling: true,
			nodes: [{ name: "开发" }, { name: "旁支" }],
		});
		await startControl(s.recipe, {}, s.options);
		const developer = await bind(s, "开发");
		const sibling = await bind(s, "旁支");
		const first = await requestRuling(s.recipe, s.options, developer, "开发节点请求", true);

		await expect(requestRuling(s.recipe, s.options, sibling, "旁支节点请求", true)).rejects.toThrow(
			/已有另一现场待决/,
		);
		expect(await readPending(s.recipe, s.options)).toEqual(first);
	});

	it("query 与报告从结构化待决读取同一 key，不从暂停文案反解析", async () => {
		const s = scenario({ runMode: "unattended" });
		const { identity, ref, card } = await cardAtAttemptOne(s);
		const pending = deviation(identity, ref, card.frontmatter.attempt);
		await recordPending(s.recipe, s.options, pending);
		rewriteFlow(s, (flow) => {
			flow.暂停 = "伪造暂停：普通裁定:不是结构化事实";
		});

		const flow = readControl(s.recipe, s.options);
		const report = await readControlReport(flow, s.options);
		const queried = await queryWorkflowCore(s.recipe, s.options);
		expect(report.stop_reason).toContain(pending.key);
		expect(report.stop_reason).toContain("等待主控逐项裁决");
		expect(renderReport(report)).toContain(pending.key);
		expect(queried).toContain(pending.key);
		expect(queried).not.toContain("伪造暂停");
	});
});
