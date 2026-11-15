import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../../src/core/extensions/types.ts";
import {
	changeCardStatus,
	listCards,
	loadCard,
	parseCardRef,
	projectRootForCards,
	serializeCard,
} from "../../src/pao/cards/index.ts";
import { loadDispatchMapArtifact, parseDispatchUri, prepareDispatchBrief } from "../../src/pao/dispatch-brief/index.ts";
import * as atomic from "../../src/pao/shared/atomic.ts";
import {
	addNodeCards,
	bindMinister,
	buildDecisionPackage,
	confirmControl,
	controlPath,
	controlReport,
	controlView,
	decideNode,
	endDecomposition,
	type NodeIdentity,
	readControl,
	readControlReport,
	readControlView,
	prepareDirectNode,
	requestRuling,
	resumeControl,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { resolveWorkflowDispatch } from "../../src/pao/workflow/dispatch-context.ts";
import { emitRecipeMarkdown } from "../../src/pao/workflow/distill.ts";
import {
	readWorkerReviewDecision,
	registerWorkflowMinisterTools,
	requestWorkerReview,
	WORKFLOW_WORKER_REVIEW_REQUEST_EVENT,
} from "../../src/pao/workflow/minister.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";

function setup(limit = 3, action = "停滞", gated = false) {
	const root = mkdtempSync(join(tmpdir(), "pao-v2-test-"));
	writeFileSync(join(root, "source.txt"), "baseline\n");
	execFileSync("git", ["init", "--quiet"], { cwd: root });
	execFileSync("git", ["add", "source.txt"], { cwd: root });
	execFileSync("git", ["-c", "user.name=test", "-c", "user.email=t@t", "commit", "-qm", "baseline"], { cwd: root });
	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: "验流",
			参数: [],
			节点: [
				{ 名字: "开发", 部门: "开发", 目标: "改代码", 验收: "文件存在", 工人数量: 2 },
				{ 名字: "旁支", 部门: "审查", 目标: "独立检查", 验收: "文件存在" },
				{
					名字: "审查",
					部门: "审查",
					目标: "审阅",
					验收: "文件存在",
					depends_on: ["开发"],
					审核: true,
					只读: true,
					部门标准: "可维护",
					人工确认: gated,
					允许请求主控裁定: true,
					回边: [{ 目标: "开发", 上限: limit, 超限动作: action }],
				},
			],
		})}---\n`,
		join(root, "验流.md"),
	);
	const options = {
		cardsDir: join(root, ".pao", "卡"),
		ownerSessionId: "owner",
		counterPath: join(root, ".pao", "卡号.txt"),
	};
	return { recipe, options };
}
async function minister(s: ReturnType<typeof setup>, name: string): Promise<NodeIdentity> {
	await bindMinister(s.recipe, s.options, name, `minister-${name}`);
	const flow = readControl(s.recipe, s.options);
	return {
		实例: flow.实例,
		节点: name,
		轮次: flow.节点.find((n) => n.名字 === name)!.轮次,
		部长会话: `minister-${name}`,
	};
}
// 明确模拟机械交付：经真实卡状态机完成待认领→进行中→已交付，得到合法 attempt；
// 不运行 worker/模型，也不伪造 execution-context，因此审核证据仍是“未验证运行”。
function deliver(s: ReturnType<typeof setup>, refs: string[]) {
	for (const ref of refs) {
		const time = "2026-10-23 00:00";
		const card = loadCard(s.options.cardsDir, parseCardRef(ref));
		if (card.frontmatter.status === "unclaimed") {
			changeCardStatus(card, { 操作者: "owner", to: "in_progress", 时间: time });
		}
		changeCardStatus(loadCard(s.options.cardsDir, parseCardRef(ref)), {
			操作者: "owner",
			to: "delivered",
			时间: time,
		});
	}
}
async function finished(s: ReturnType<typeof setup>, name: string) {
	const identity = await minister(s, name);
	const refs = await addNodeCards(s.recipe, s.options, identity, [{ goal: "任务", acceptance: "文件存在" }]);
	deliver(s, refs);
	await endDecomposition(s.recipe, s.options, identity);
	return identity;
}
describe("v2 控制清单（模拟卡结果）", () => {
	it("显式新节点审核打回保留原卡和累计尝试，不重新拆解；第二次尝试仍受上限约束", async () => {
		const s = setup();
		s.recipe.节点[0].执行方式 = "直接";
		s.recipe.节点[2].执行方式 = "拆解";
		await startControl(s.recipe, {}, s.options);
		await prepareDirectNode(s.recipe, s.options, "开发");
		const ref = readControl(s.recipe, s.options).节点[0].卡[0];
		deliver(s, [ref]);
		const audit = await minister(s, "审查");
		await endDecomposition(s.recipe, s.options, audit, "模拟静态审查，不运行工人");
		await decideNode(s.recipe, s.options, audit, {
			结果: "change",
			理由: "验收范围内的缺陷",
			失败轴: "card",
			引用: ["source.txt:1"],
			目标: "开发",
		});
		let flow = readControl(s.recipe, s.options);
		expect(flow.节点[0].卡).toEqual([ref]);
		expect(flow.节点[0].历史[0].卡).toEqual([ref]);
		expect(flow.节点[0].轮次).toBe(2);
		expect(flow.节点[0].拆解结束).toBe(true);
		expect(flow.暂停).toBeUndefined();
		let card = loadCard(s.options.cardsDir, parseCardRef(ref));
		expect(card.frontmatter.attempt).toBe(1);
		expect(card.frontmatter.status).toBe("unclaimed");
		expect(card.body).toContain("轮次=2");
		expect(card.body).toContain("审核返修");
		expect(() => resolveWorkflowDispatch(card, { cardsDir: s.options.cardsDir, owner: "owner" })).not.toThrow();
		deliver(s, [ref]);
		card = loadCard(s.options.cardsDir, parseCardRef(ref));
		expect(card.frontmatter.attempt).toBe(2);
		const nextAudit = await minister(s, "审查");
		await endDecomposition(s.recipe, s.options, nextAudit, "再次模拟静态审查");
		await expect(
			decideNode(s.recipe, s.options, nextAudit, {
				结果: "change",
				理由: "仍有范围内缺陷",
				失败轴: "card",
				引用: ["source.txt:1"],
				目标: "开发",
			}),
		).rejects.toThrow("已达上限");
		flow = readControl(s.recipe, s.options);
		expect(flow.暂停).toContain("返修");
		expect(listCards(s.options.cardsDir)).toHaveLength(1);
		expect(loadCard(s.options.cardsDir, parseCardRef(ref)).frontmatter.status).toBe("delivered");
	});
	it("卡首次落盘有完整身份；控制保存失败的孤儿卡不能派发或重复交卡", async () => {
		const s = setup();
		await startControl(s.recipe, {}, s.options);
		const id = await minister(s, "开发");
		const realWrite = atomic.writeFileAtomic;
		const writes = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, text) => {
			if (path === controlPath(s.recipe, s.options)) throw new Error("模拟控制盘满");
			realWrite(path, text);
		});
		try {
			await expect(
				addNodeCards(s.recipe, s.options, id, [{ goal: "任务", acceptance: "文件存在" }]),
			).rejects.toThrow("模拟控制盘满");
		} finally {
			writes.mockRestore();
		}
		const cards = listCards(s.options.cardsDir);
		expect(cards).toHaveLength(1);
		expect(cards[0].body).toContain(`pao-workflow-v2:实例=${id.实例}/轮次=1`);
		expect(readControl(s.recipe, s.options).节点[0].卡).toEqual([]);
		expect(() => resolveWorkflowDispatch(cards[0], { cardsDir: s.options.cardsDir, owner: "owner" })).toThrow(
			"不属于当前实例",
		);
		await expect(addNodeCards(s.recipe, s.options, id, [{ goal: "再试", acceptance: "文件存在" }])).rejects.toThrow(
			"未登记",
		);
		expect(listCards(s.options.cardsDir)).toHaveLength(1);
	});
	it("一张坏卡只影响对应节点，下游等待；独立旁支仍能读取", async () => {
		const s = setup();
		await startControl(s.recipe, {}, s.options);
		const id = await minister(s, "开发");
		const refs = await addNodeCards(s.recipe, s.options, id, [{ goal: "任务", acceptance: "文件存在" }]);
		writeFileSync(loadCard(s.options.cardsDir, parseCardRef(refs[0])).path, "模拟损坏卡");
		const report = controlReport(readControl(s.recipe, s.options));
		expect(report.status).toBe("hold");
		expect(report.nodes[0].status).toBe("读取异常");
		expect(report.nodes.find((node) => node.name === "旁支")?.status).toBe("no_card");
		expect(report.nodes.find((node) => node.name === "审查")?.hold).toBe("等待前置节点");
	});
	it("部长工具从真实上下文校验身份，旧轮次不能冒领新轮次", async () => {
		const s = setup();
		await startControl(s.recipe, {}, s.options);
		const id = await minister(s, "开发");
		const tools = new Map<string, ToolDefinition>();
		const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
		registerWorkflowMinisterTools(pi, { 名字: s.recipe.名字, ...id, owner: "owner", cardsDir: s.options.cardsDir });
		const ctx = (session: string) =>
			({ sessionManager: { getSessionId: () => session } }) as unknown as ExtensionToolContext;
		const end = tools.get("pao_breakdown_done")!;
		await expect(
			end.execute("bad", { zero_cards_reason: "模拟检查" }, undefined, undefined, ctx("forged")),
		).rejects.toThrow("真实部长");
		await end.execute("ok", { zero_cards_reason: "模拟检查" }, undefined, undefined, ctx(id.部长会话));
		const flow = readControl(s.recipe, s.options);
		flow.节点[0].轮次++;
		writeFileSync(controlPath(s.recipe, s.options), `---\n${stringify(flow)}---\n`);
		await expect(
			end.execute("late", { zero_cards_reason: "迟到" }, undefined, undefined, ctx(id.部长会话)),
		).rejects.toThrow("真实部长");
	});
	it("节点地图贯穿部长身份、轮次、摘要、替代版本和下游 worker 简报", async () => {
		const root = mkdtempSync(join(tmpdir(), "pao-node-map-"));
		const project = join(root, "项目");
		const cardsDir = join(project, ".pao", "任务", "卡");
		mkdirSync(join(project, "src"), { recursive: true });
		writeFileSync(join(project, "src", "入口.ts"), "export const 入口 = true;\n");
		const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "pipe" });
		git("init");
		git("add", "-A");
		git("-c", "user.email=pao@test", "-c", "user.name=pao", "commit", "--no-gpg-sign", "-m", "base");
		const recipe = parseRecipe(
			`---\n${stringify({
				版本: 2,
				名字: "地图流",
				节点: [
					{ 名字: "侦察", 部门: "规划", 目标: "调查入口", 验收: "给出事实", 只读: true },
					{ 名字: "实现", 部门: "开发", 目标: "实现", 验收: "存在: src/入口.ts", depends_on: ["侦察"] },
				],
			})}---\n`,
			join(root, "地图流.md"),
		);
		const options = { cardsDir, ownerSessionId: "owner", counterPath: join(root, "卡号.txt") };
		await startControl(recipe, {}, options);
		const id = await minister({ recipe, options }, "侦察");
		const tools = new Map<string, ToolDefinition>();
		const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
		registerWorkflowMinisterTools(pi, { 名字: recipe.名字, ...id, owner: "owner", cardsDir });
		const ctx = { sessionManager: { getSessionId: () => id.部长会话 } } as unknown as ExtensionToolContext;
		const save = tools.get("pao_minister_save_node_map")!;
		await expect(
			save.execute(
				"map",
				{
					coverage: ["src"],
					facts: ["入口在 src/入口.ts"],
					scope_basis: ["src 覆盖实际调用目录"],
					scope_confirmed: true,
				},
				undefined,
				undefined,
				{ sessionManager: { getSessionId: () => "伪造会话" } } as unknown as ExtensionToolContext,
			),
		).rejects.toThrow("真实部长");
		const first = await save.execute(
			"map",
			{
				coverage: ["src"],
				facts: ["入口在 src/入口.ts", "旧版事实"],
				scope_basis: ["src 覆盖实际调用目录"],
				scope_confirmed: true,
			},
			undefined,
			undefined,
			ctx,
		);
		const firstRef = first.content[0].type === "text" ? first.content[0].text.split("\n")[0] : "";
		expect(loadDispatchMapArtifact(firstRef, { cardsDir }).facts).toContain("旧版事实");
		await expect(
			save.execute(
				"bad-supersession",
				{
					coverage: ["src"],
					facts: ["新版事实"],
					scope_basis: ["src 覆盖实际调用目录"],
					scope_confirmed: true,
					previous_ref: firstRef,
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("同时提供");
		const replacement = await save.execute(
			"replacement",
			{
				coverage: ["src"],
				facts: ["新版事实"],
				scope_basis: ["src 覆盖实际调用目录"],
				scope_confirmed: true,
				previous_ref: firstRef,
				supersession_reason: "入口迁移后更新事实",
			},
			undefined,
			undefined,
			ctx,
		);
		const ref = replacement.content[0].type === "text" ? replacement.content[0].text.split("\n")[0] : "";
		expect(ref).not.toBe(firstRef);
		await expect(
			save.execute(
				"branch-from-old",
				{
					coverage: ["src"],
					facts: ["从旧分支重复替代"],
					scope_basis: ["src 覆盖实际调用目录"],
					scope_confirmed: true,
					previous_ref: firstRef,
					supersession_reason: "试图从更早版本分叉",
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("最新");
		expect(loadDispatchMapArtifact(ref, { cardsDir })).toMatchObject({
			facts: ["新版事实"],
			previousRef: firstRef,
			supersessionReason: "入口迁移后更新事实",
			status: "valid",
		});
		const damagedRef = ref.replace(
			/digest=sha256%3A[^&]+/,
			`digest=${encodeURIComponent(`sha256:${"f".repeat(64)}`)}`,
		);
		expect(() => loadDispatchMapArtifact(damagedRef, { cardsDir })).toThrow("摘要不符");
		await endDecomposition(recipe, options, id, "只读零卡，已保存节点地图");
		const implementation = await minister({ recipe, options }, "实现");
		const implementTools = new Map<string, ToolDefinition>();
		const implementPi = {
			registerTool: (tool: ToolDefinition) => implementTools.set(tool.name, tool),
		} as unknown as ExtensionAPI;
		registerWorkflowMinisterTools(implementPi, { 名字: recipe.名字, ...implementation, owner: "owner", cardsDir });
		const implementCtx = {
			sessionManager: { getSessionId: () => implementation.部长会话 },
		} as unknown as ExtensionToolContext;
		await expect(
			implementTools.get("pao_minister_save_node_map")!.execute(
				"write-map",
				{
					coverage: ["src"],
					facts: ["实现节点不能冒充侦察地图"],
					scope_basis: ["src"],
					scope_confirmed: true,
				},
				undefined,
				undefined,
				implementCtx,
			),
		).rejects.toThrow("只读");
		const submitted = await implementTools
			.get("pao_minister_submit_cards")!
			.execute(
				"submit",
				{ cards: [{ goal: "实现入口", acceptance: "存在: src/入口.ts" }] },
				undefined,
				undefined,
				implementCtx,
			);
		const cardRef = submitted.content[0].type === "text" ? submitted.content[0].text.split(":")[1] : "";
		const card = loadCard(cardsDir, parseCardRef(cardRef));
		expect(card.frontmatter.inputs).not.toContain(ref);
		const brief = await prepareDispatchBrief({
			cardsDir,
			cardPath: card.path,
			projectRoot: project,
			executionRoot: project,
			upstreamRefs: [{ ref, purpose: "派发时从控制正本注入" }],
		});
		expect(brief.evidence.some((entry) => entry.ref === ref)).toBe(true);
		expect(brief.briefMarkdown).toContain("新版事实");
		expect(brief.briefMarkdown).toContain(`替代旧版：\`${firstRef}\``);
		expect(brief.briefMarkdown).toContain("入口迁移后更新事实");

		const damagedMapPath = join(cardsDir, "..", "输入快照", "map", `${parseDispatchUri(ref).id}.json`);
		const originalMap = readFileSync(damagedMapPath, "utf8");
		writeFileSync(damagedMapPath, originalMap.replace("新版事实", "被篡改事实"));
		await expect(
			implementTools
				.get("pao_minister_submit_cards")!
				.execute(
					"bad-map",
					{ cards: [{ goal: "不应入队", acceptance: "存在: src/入口.ts" }] },
					undefined,
					undefined,
					implementCtx,
				),
		).rejects.toThrow("摘要不符");
		writeFileSync(damagedMapPath, originalMap);

		const stale = readControl(recipe, options);
		stale.节点.find((node) => node.名字 === "侦察")!.轮次++;
		writeFileSync(controlPath(recipe, options), `---\n${stringify(stale)}---\n`);
		await expect(
			save.execute(
				"late-round",
				{
					coverage: ["src"],
					facts: ["旧轮次不能再保存"],
					scope_basis: ["src 覆盖实际调用目录"],
					scope_confirmed: true,
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("真实部长");
	});
	it("主控仅在匹配的授权裁定请求下决定，裁定原子落入审计记录", async () => {
		const s = setup();
		await startControl(s.recipe, {}, s.options);
		await finished(s, "开发");
		const id = await finished(s, "审查");
		const decision = { 结果: "pass" as const, 理由: "未验证运行，采纳证据", 引用: ["code.ts:1"] };
		await expect(decideNode(s.recipe, s.options, id, decision, "主控")).rejects.toThrow("裁定请求");
		await requestRuling(s.recipe, s.options, id, "边界不明确", true);
		await decideNode(s.recipe, s.options, id, decision, "主控");
		const flow = readControl(s.recipe, s.options);
		expect(flow.暂停).toBeUndefined();
		expect(flow.记录.some((item) => item.事件 === "主控裁定")).toBe(true);
	});
	it("部长单卡审核只消费当前请求与当前机械材料，旧轮次、坏摘要和自报未达项均拒绝", async () => {
		const s = setup();
		await startControl(s.recipe, {}, s.options);
		const id = await minister(s, "开发");
		const [cardRef] = await addNodeCards(s.recipe, s.options, id, [
			{ goal: "完成产物", acceptance: "存在: code.ts\n人工检查可维护性" },
		]);
		const card = changeCardStatus(loadCard(s.options.cardsDir, parseCardRef(cardRef)), {
			操作者: "owner",
			to: "in_progress",
			时间: "2026-10-22 10:00",
		});
		card.body = `${card.body.trimEnd()}

## 回执 尝试1 2026-10-22 10:00
- result: success
- summary: 已实现并运行测试
- evidence: ["evidence.jsonl"]
- verification: [{"条件":"人工检查可维护性","结论":"pass","证据":"代码结构清楚"}]

## 机械验收 2026-10-22 10:01
- 结论: 全过停人工审
- 尝试: 1
- [存在] code.ts → 过（文件存在）
- 人话句 1 条待主控审
- [人话句] "人工检查可维护性"
`;
		writeFileSync(card.path, serializeCard(card.frontmatter, card.body));
		const root = resolve(s.options.cardsDir, "..");
		const requestInput = {
			requestId: "review-1",
			cardRef,
			attempt: 1,
			executionRoot: root,
			evidencePath: "evidence.jsonl",
			artifactPaths: ["code.ts"],
			requirements: ["人工检查可维护性"],
			mechanicalResultCount: 1,
			unmetReportCount: 0,
		};
		const request = await requestWorkerReview(s.recipe, s.options, id, requestInput);
		expect(request.ministerSession).toBe(id.部长会话);
		await expect(requestWorkerReview(s.recipe, s.options, id, requestInput)).rejects.toThrow("重复");
		await expect(
			requestWorkerReview(s.recipe, s.options, id, {
				...requestInput,
				requestId: "review-bad-evidence",
				evidencePath: "不属于当前回执的证据.jsonl",
			}),
		).rejects.toThrow("未包含审核请求指定的原始证据");

		const tools = new Map<string, ToolDefinition>();
		const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
		registerWorkflowMinisterTools(pi, { 名字: s.recipe.名字, ...id, owner: "owner", cardsDir: s.options.cardsDir });
		const ctx = (session: string) =>
			({ sessionManager: { getSessionId: () => session } }) as unknown as ExtensionToolContext;
		const review = tools.get("pao_minister_review_worker")!;
		await expect(
			review.execute(
				"wrong-request",
				{ request_id: "unknown", card_ref: cardRef, attempt: 1, result: "pass", basis: "合格" },
				undefined,
				undefined,
				ctx(id.部长会话),
			),
		).rejects.toThrow("没有匹配");
		await expect(
			review.execute(
				"wrong-session",
				{ request_id: "review-1", card_ref: cardRef, attempt: 1, result: "pass", basis: "合格" },
				undefined,
				undefined,
				ctx("伪造会话"),
			),
		).rejects.toThrow("真实部长");
		await expect(
			review.execute(
				"wrong-attempt",
				{ request_id: "review-1", card_ref: cardRef, attempt: 2, result: "pass", basis: "尝试不符" },
				undefined,
				undefined,
				ctx(id.部长会话),
			),
		).rejects.toThrow("卡或尝试");

		const changed = loadCard(s.options.cardsDir, parseCardRef(cardRef));
		changed.body = changed.body.replace(/^- \[人话句\].*$/m, '- [人话句] "被替换的条件"');
		writeFileSync(changed.path, serializeCard(changed.frontmatter, changed.body));
		await expect(
			review.execute(
				"bad-summary",
				{ request_id: "review-1", card_ref: cardRef, attempt: 1, result: "pass", basis: "合格" },
				undefined,
				undefined,
				ctx(id.部长会话),
			),
		).rejects.toThrow("待人工判断条件");

		const restored = loadCard(s.options.cardsDir, parseCardRef(cardRef));
		restored.body = restored.body.replace('- [人话句] "被替换的条件"', '- [人话句] "人工检查可维护性"');
		writeFileSync(restored.path, serializeCard(restored.frontmatter, restored.body));
		const failedMechanically = loadCard(s.options.cardsDir, parseCardRef(cardRef));
		failedMechanically.body = failedMechanically.body.replace(
			"- [存在] code.ts → 过（文件存在）",
			"- [存在] code.ts → 未过（文件不存在）",
		);
		writeFileSync(failedMechanically.path, serializeCard(failedMechanically.frontmatter, failedMechanically.body));
		await expect(
			review.execute(
				"mechanical-fail",
				{ request_id: "review-1", card_ref: cardRef, attempt: 1, result: "pass", basis: "试图覆盖机械失败" },
				undefined,
				undefined,
				ctx(id.部长会话),
			),
		).rejects.toThrow("不是全机械通过");
		const mechanicalRestore = loadCard(s.options.cardsDir, parseCardRef(cardRef));
		mechanicalRestore.body = mechanicalRestore.body.replace(
			"- [存在] code.ts → 未过（文件不存在）",
			"- [存在] code.ts → 过（文件存在）",
		);
		writeFileSync(mechanicalRestore.path, serializeCard(mechanicalRestore.frontmatter, mechanicalRestore.body));
		const decision = await review.execute(
			"ok",
			{ request_id: "review-1", card_ref: cardRef, attempt: 1, result: "pass", basis: "已看 code.ts，结构可维护" },
			undefined,
			undefined,
			ctx(id.部长会话),
		);
		expect(decision.details).toMatchObject({ type: "pao_worker_review", requestId: "review-1", result: "pass" });
		const flow = readControl(s.recipe, s.options);
		expect(readWorkerReviewDecision(flow, "review-1")).toMatchObject({
			cardRef,
			attempt: 1,
			result: "pass",
			ministerSession: id.部长会话,
		});
		expect(flow.记录.some((record) => record.事件 === WORKFLOW_WORKER_REVIEW_REQUEST_EVENT)).toBe(true);
		await expect(
			review.execute(
				"duplicate",
				{ request_id: "review-1", card_ref: cardRef, attempt: 1, result: "hold", basis: "重复" },
				undefined,
				undefined,
				ctx(id.部长会话),
			),
		).rejects.toThrow("重复提交");

		await deliver(s, readControl(s.recipe, s.options).节点.find((node) => node.名字 === "开发")!.卡);
		const noPass = await minister(s, "旁支");
		const [noPassCard] = await addNodeCards(s.recipe, s.options, noPass, [
			{ goal: "自报未达", acceptance: "人工判断" },
		]);
		const blocked = loadCard(s.options.cardsDir, parseCardRef(noPassCard));
		blocked.frontmatter.status = "in_progress";
		blocked.frontmatter.attempt = 1;
		blocked.body = `${blocked.body.trimEnd()}

## 回执 尝试1 2026-10-22 10:02
- result: success
- summary: 有一项未达
- evidence: ["evidence.jsonl"]
- verification: [{"条件":"人工判断","结论":"fail","证据":"仍需修改"}]

## 机械验收 2026-10-22 10:03
- 结论: 全过停人工审
- 尝试: 1
- [自报复核] #0 人工判断 → fail（仍需修改）
- 人话句 1 条待主控审
- [人话句] "人工判断"
`;
		writeFileSync(blocked.path, serializeCard(blocked.frontmatter, blocked.body));
		await expect(
			requestWorkerReview(s.recipe, s.options, noPass, {
				...requestInput,
				requestId: "review-fail",
				cardRef: noPassCard,
				requirements: ["人工判断"],
				mechanicalResultCount: 0,
				unmetReportCount: 1,
			}),
		).resolves.toMatchObject({ unmetReportCount: 1 });
		const noPassTools = new Map<string, ToolDefinition>();
		const noPassPi = {
			registerTool: (tool: ToolDefinition) => noPassTools.set(tool.name, tool),
		} as unknown as ExtensionAPI;
		registerWorkflowMinisterTools(noPassPi, {
			名字: s.recipe.名字,
			...noPass,
			owner: "owner",
			cardsDir: s.options.cardsDir,
		});
		await expect(
			noPassTools
				.get("pao_minister_review_worker")!
				.execute(
					"cannot-pass",
					{ request_id: "review-fail", card_ref: noPassCard, attempt: 1, result: "pass", basis: "试图放行" },
					undefined,
					undefined,
					ctx(noPass.部长会话),
				),
		).rejects.toThrow("不能提交 pass");
	});
	it("v2 配方字段往返与非法回边拒绝", () => {
		const s = setup();
		const emitted = emitRecipeMarkdown(s.recipe);
		const parsed = parseRecipe(emitted, s.recipe.文件路径);
		expect(parsed.节点).toEqual(s.recipe.节点);
		expect(() => parseRecipe(emitted.replace('"目标":"开发"', '"目标":"旁支"'), s.recipe.文件路径)).toThrow("上游");
		expect(() => parseRecipe(emitted.replace("版本: 2", "版本: 9"), s.recipe.文件路径)).toThrow("版本");
	});
	it("真实 git 内容基线与自足判定包（无模型调用）", async () => {
		const s = setup();
		const root = projectRootForCards(s.options.cardsDir);
		const git = (...args: string[]) => execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "pipe" });
		git("init");
		git("config", "user.email", "fixture@example.invalid");
		git("config", "user.name", "fixture");
		writeFileSync(join(root, "code.txt"), "before\n");
		git("add", "code.txt");
		git("commit", "-m", "fixture");
		await startControl(s.recipe, {}, s.options);
		const id = await minister(s, "开发");
		writeFileSync(join(root, "code.txt"), "after\n");
		const path = await buildDecisionPackage(s.recipe, s.options, id);
		const contents = readFileSync(path, "utf8");
		expect(contents).toContain("-before");
		expect(contents).toContain("+after");
		expect(contents).toContain("部门标准轴");
	});
	it("子项目基线和判定包只读取本项目内容，不夹带兄弟项目或编排文件", async () => {
		const s = setup();
		const repo = mkdtempSync(join(tmpdir(), "pao-subproject-baseline-"));
		const project = join(repo, "project");
		mkdirSync(project);
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
		git("init");
		writeFileSync(join(project, "code.txt"), "before\n");
		writeFileSync(join(repo, "sibling.txt"), "sibling-before\n");
		git("add", ".");
		git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
		writeFileSync(join(project, "existing.txt"), "existing project file\n");
		writeFileSync(join(repo, "sibling-new.txt"), "outside project\n");
		writeFileSync(join(repo, "sibling.txt"), "sibling-dirty-before-baseline\n");
		s.options.cardsDir = join(project, ".pao", "task", "cards");
		await startControl(s.recipe, {}, s.options);
		const id = await minister(s, "开发");
		const baseline = readControl(s.recipe, s.options).节点[0].基线!;
		expect(resolve(baseline.项目根)).toBe(resolve(project));
		expect(baseline.未跟踪).toEqual(["existing.txt"]);
		expect(git("diff", "--cached", "--name-only").trim()).toBe("");
		writeFileSync(join(project, "code.txt"), "project-after\n");
		writeFileSync(join(project, "new.txt"), "new project artifact\n");
		writeFileSync(join(project, ".pao", "private.txt"), "private orchestration marker\n");
		writeFileSync(join(repo, "sibling.txt"), "sibling-after-baseline\n");
		const contents = readFileSync(await buildDecisionPackage(s.recipe, s.options, id), "utf8");
		expect(contents).toContain("+project-after");
		expect(contents).toContain("new project artifact");
		expect(contents).not.toContain("sibling-");
		expect(contents).not.toContain("private orchestration marker");
	});
	it("多批卡交齐但没有结束信号不能完成；零卡须有理由", async () => {
		const s = setup();
		await startControl(s.recipe, {}, s.options);
		const id = await minister(s, "开发");
		const a = await addNodeCards(s.recipe, s.options, id, [{ goal: "一", acceptance: "文件存在" }]);
		const b = await addNodeCards(s.recipe, s.options, id, [{ goal: "二", acceptance: "文件存在" }]);
		deliver(s, [...a, ...b]);
		expect(controlReport(readControl(s.recipe, s.options)).nodes[0].status).not.toBe("delivered");
		await endDecomposition(s.recipe, s.options, id);
		expect(controlReport(readControl(s.recipe, s.options)).nodes[0].status).toBe("delivered");
		await expect(addNodeCards(s.recipe, s.options, id, [{ goal: "三", acceptance: "文件存在" }])).rejects.toThrow(
			"拆解已结束",
		);
		const other = await minister(s, "旁支");
		await expect(endDecomposition(s.recipe, s.options, other)).rejects.toThrow("零卡");
		await endDecomposition(s.recipe, s.options, other, "经核没有变更需处理");
	});
	it("冻结图独立于原对象，owner 与卡目录不匹配拒绝", async () => {
		const s = setup();
		await startControl(s.recipe, {}, s.options);
		s.recipe.节点[0].目标 = "事后改图";
		expect(readControl(s.recipe, s.options).冻结配方.节点[0].目标).toBe("改代码");
		await expect(bindMinister(s.recipe, { ...s.options, ownerSessionId: "other" }, "开发", "x")).rejects.toThrow(
			"owner",
		);
		expect(() =>
			readControl(s.recipe, {
				...s.options,
				cardsDir: join(s.options.cardsDir, "别项目"),
				workspaceDir: join(s.options.cardsDir, ".."),
			}),
		).toThrow("归属");
	});
	it("打回只作废受影响下游，旧轮次与旧卡不推进新轮次", async () => {
		const s = setup();
		await startControl(s.recipe, {}, s.options);
		const old = await finished(s, "开发");
		await finished(s, "旁支");
		const review = await finished(s, "审查");
		await decideNode(s.recipe, s.options, review, {
			结果: "change",
			目标: "开发",
			理由: "缺边界",
			失败轴: "card",
			引用: ["src/a.ts:1"],
		});
		const flow = readControl(s.recipe, s.options);
		expect(flow.节点.find((n) => n.名字 === "开发")!.轮次).toBe(2);
		expect(flow.节点.find((n) => n.名字 === "旁支")!.轮次).toBe(1);
		expect(controlReport(flow).nodes.find((n) => n.name === "开发")!.status).not.toBe("delivered");
		await expect(endDecomposition(s.recipe, s.options, old)).rejects.toThrow("旧轮次");
		const current = await minister(s, "开发");
		const refs = await addNodeCards(s.recipe, s.options, current, [{ goal: "重做", acceptance: "文件存在" }]);
		expect(loadCard(s.options.cardsDir, parseCardRef(refs[0])).frontmatter.inputs).toContain("本轮重做理由:缺边界");
	});
	it.each([
		[1, "停滞"],
		[1, "修完这轮放行"],
		[0, "停滞"],
	])("回边上限 %s 动作 %s", async (limit, action) => {
		const s = setup(limit as number, action as string);
		await startControl(s.recipe, {}, s.options);
		await finished(s, "旁支");
		for (let i = 0; i < 2; i++) {
			await finished(s, "开发");
			const id = await finished(s, "审查");
			await decideNode(s.recipe, s.options, id, {
				结果: "change",
				目标: "开发",
				理由: "仍需修复",
				失败轴: "dept_standard",
				引用: ["a.ts:2"],
			});
		}
		const flow = readControl(s.recipe, s.options);
		if (limit === 1 && action === "停滞") expect(flow.暂停).toContain("超限");
		else if (action === "修完这轮放行") {
			expect(flow.节点.find((n) => n.名字 === "审查")!.放行修复).toBe(true);
			expect(controlReport(flow).note).toContain("按配置放行，仍有未解决项");
			expect(flow.状态).not.toBe("已完成");
		} else expect(flow.暂停).toBeUndefined();
	});
	it("修完这轮放行在开发与审核不再判定时完成", async () => {
		const s = setup(1, "修完这轮放行");
		await startControl(s.recipe, {}, s.options);
		await finished(s, "旁支");
		for (let i = 0; i < 2; i++) {
			await finished(s, "开发");
			const id = await finished(s, "审查");
			await decideNode(s.recipe, s.options, id, {
				结果: "change",
				目标: "开发",
				理由: "仍需修复",
				失败轴: "dept_standard",
				引用: ["a.ts:2"],
			});
		}
		const released = readControl(s.recipe, s.options);
		const oldReview = released.节点.find((node) => node.名字 === "审查")!;
		expect(oldReview.放行修复).toBe(true);
		expect(oldReview.判定).toBeUndefined();

		await finished(s, "开发");
		await finished(s, "审查");
		const flow = readControl(s.recipe, s.options);
		expect(flow.节点.find((node) => node.名字 === "审查")!.判定).toBeUndefined();
		const report = await readControlReport(flow, s.options);
		expect(report.status).toBe("completed");
		expect(flow.节点.find((node) => node.名字 === "审查")!.历史.length).toBeGreaterThan(0);
	});
	it("异步控制视图与同步内容树投影一致，报告复用同一读入口", async () => {
		const s = setup();
		await startControl(s.recipe, {}, s.options);
		const flow = readControl(s.recipe, s.options);
		const view = await readControlView(flow, s.options);
		expect(view).toEqual(controlView(flow));
		expect(await readControlReport(flow, s.options)).toEqual(controlReport(flow));
	});
	it("缺证pass须明示未验证运行；reject停流；人工恢复记说明", async () => {
		const s = setup();
		await startControl(s.recipe, {}, s.options);
		await finished(s, "开发");
		const id = await finished(s, "审查");
		await expect(
			decideNode(s.recipe, s.options, id, { 结果: "pass", 理由: "好了", 引用: ["a.ts:1"] }),
		).rejects.toThrow("未验证运行");
		await decideNode(s.recipe, s.options, id, { 结果: "reject", 理由: "不满足", 失败轴: "card", 引用: ["a.ts:1"] });
		expect(readControl(s.recipe, s.options).暂停).toContain("拒绝");
		await expect(
			resumeControl(s.recipe, s.options, { 实例: id.实例, 原owner: "owner", 现场核查: "" }),
		).rejects.toThrow("核查");
	});
	it("范围外改进仅保存建议，不重开已交付卡或增加任务", async () => {
		const s = setup();
		await startControl(s.recipe, {}, s.options);
		await finished(s, "开发");
		const id = await finished(s, "审查");
		const before = listCards(s.options.cardsDir).map((card) => [
			card.path,
			card.frontmatter.status,
			card.frontmatter.attempt,
		]);
		await decideNode(s.recipe, s.options, id, {
			结果: "pass",
			理由: "未验证运行，范围内条件符合",
			引用: ["source.txt:1"],
			建议: ["另行考虑新增展示页面"],
		});
		const flow = readControl(s.recipe, s.options);
		expect(flow.节点.find((node) => node.名字 === "审查")?.判定?.建议).toEqual(["另行考虑新增展示页面"]);
		expect(
			listCards(s.options.cardsDir).map((card) => [card.path, card.frontmatter.status, card.frontmatter.attempt]),
		).toEqual(before);
		expect(flow.节点.every((node) => node.轮次 === 1)).toBe(true);
	});
	it("裁定通道按开关降级人工；旧确认拒绝", async () => {
		const s = setup(3, "停滞", true);
		await startControl(s.recipe, {}, s.options);
		await finished(s, "开发");
		const id = await finished(s, "审查");
		await decideNode(s.recipe, s.options, id, { 结果: "pass", 理由: "未验证运行，diff符合", 引用: ["a.ts:1"] });
		await expect(confirmControl(s.recipe, s.options, "审查", 9)).rejects.toThrow("旧确认");
		await confirmControl(s.recipe, s.options, "审查", 1);
		const other = await minister(s, "旁支");
		await requestRuling(s.recipe, s.options, other, "请明确", true);
		expect(readControl(s.recipe, s.options).裁定?.通道).toBe("人工");
	});
	it("旧格式与损坏清单不得盲恢复", async () => {
		const s = setup();
		await startControl(s.recipe, {}, s.options);
		const path = controlPath(s.recipe, s.options);
		const original = readFileSync(path, "utf8");
		writeFileSync(path, "---\n工作流: 验流\n节点: []\n---\n");
		expect(() => readControl(s.recipe, s.options)).toThrow("旧实例");
		writeFileSync(path, original.replace("轮次: 1", "轮次: 0"));
		expect(() => readControl(s.recipe, s.options)).toThrow("损坏");
	});
	it("controlView 传 deadMinisters：死绑定未拆解节点的挂起文案切换；不传或集合不含该会话时行为不变", async () => {
		const s = setup();
		await startControl(s.recipe, {}, s.options);
		await minister(s, "开发");
		const flow = readControl(s.recipe, s.options);
		expect(controlView(flow).节点[0].挂起).toBe("等待部长本轮拆解结束");
		expect(controlView(flow, new Set(["minister-开发"])).节点[0].挂起).toContain("部长会话已断开");
		expect(controlView(flow, new Set(["minister-开发"])).节点[0].挂起).toContain("重推流将按同会话重开");
		expect(controlView(flow, new Set()).节点[0].挂起).toBe("等待部长本轮拆解结束");
		// 说明行带卡目录（桌面注入的工作区目录由此明示）
		expect(controlView(flow).说明).toContain(`卡目录 ${flow.卡目录}`);
	});
	it("controlView 与 controlReport 保留并行组、分支、汇聚和审核回边元数据", async () => {
		const s = setup();
		s.recipe.parallelGroups = [
			{ id: "主组", maxConcurrency: 2, failurePolicy: "allow_partial", cancelPolicy: "drain_started" },
		];
		s.recipe.节点[0].parallelGroupId = "主组";
		s.recipe.节点[0].branchId = "分支甲";
		s.recipe.节点[0].joinId = "汇聚";
		await startControl(s.recipe, {}, s.options);
		const flow = readControl(s.recipe, s.options);
		const node = controlView(flow).节点.find((item) => item.名字 === "开发")!;
		expect(node.parallelGroupId).toBe("主组");
		expect(node.branchId).toBe("分支甲");
		expect(node.joinId).toBe("汇聚");
		const reportNode = controlReport(flow).nodes.find((item) => item.name === "开发")!;
		expect(reportNode.parallel_group_id).toBe("主组");
		expect(reportNode.branch_id).toBe("分支甲");
		expect(reportNode.join_id).toBe("汇聚");
		const reviewNode = controlView(flow).节点.find((item) => item.名字 === "审查")!;
		expect(reviewNode.回边).toEqual([{ 目标: "开发", 上限: 3, 超限动作: "停滞" }]);
		expect(controlReport(flow).nodes.find((item) => item.name === "审查")!.review_edges).toEqual([
			{ target: "开发", limit: 3, overflow_action: "停滞" },
		]);
	});
	it("startControl 卡目录不可建：按本函数失败口径报中文（卡目录不可建），不裸抛 ENOENT/EACCES", async () => {
		const s = setup();
		// 卡目录位置被同名普通文件占住 → mkdir 必失败
		mkdirSync(join(s.options.cardsDir, ".."), { recursive: true });
		writeFileSync(s.options.cardsDir, "占位文件", "utf8");
		await expect(startControl(s.recipe, {}, s.options)).rejects.toThrow(/\[FLOW_CONTROL\].*卡目录不可建/);
	});
});
