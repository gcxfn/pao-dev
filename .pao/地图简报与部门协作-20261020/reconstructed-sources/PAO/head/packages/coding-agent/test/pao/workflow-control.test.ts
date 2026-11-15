import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../../src/core/extensions/types.ts";
import { loadCard, parseCardRef, serializeCard } from "../../src/pao/cards/index.ts";
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
	requestRuling,
	resumeControl,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { emitRecipeMarkdown } from "../../src/pao/workflow/distill.ts";
import { registerWorkflowMinisterTools } from "../../src/pao/workflow/minister.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";

function setup(limit = 3, action = "停滞", gated = false) {
	const root = mkdtempSync(join(tmpdir(), "pao-v2-test-"));
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
					部门标准: "可维护",
					人工确认: gated,
					允许请求主控裁定: true,
					回边: [{ 目标: "开发", 上限: limit, 超限动作: action }],
				},
			],
		})}---\n`,
		join(root, "验流.md"),
	);
	const options = { cardsDir: join(root, "卡"), ownerSessionId: "owner", counterPath: join(root, "卡号.txt") };
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
// 明确模拟机械交付，验证控制层；不是 worker/真实模型验收证据。
function deliver(s: ReturnType<typeof setup>, refs: string[]) {
	for (const ref of refs) {
		const card = loadCard(s.options.cardsDir, parseCardRef(ref));
		writeFileSync(card.path, serializeCard({ ...card.frontmatter, status: "delivered" }, card.body));
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
		const root = join(s.options.cardsDir, "..");
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
	it("startControl 卡目录不可建：按本函数失败口径报中文（卡目录不可建），不裸抛 ENOENT/EACCES", async () => {
		const s = setup();
		// 卡目录位置被同名普通文件占住 → mkdir 必失败
		writeFileSync(s.options.cardsDir, "占位文件", "utf8");
		await expect(startControl(s.recipe, {}, s.options)).rejects.toThrow(/\[FLOW_CONTROL\].*卡目录不可建/);
	});
});
