import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCard, parseCardRef } from "../../src/pao/cards/index.ts";
import { resolveDispatchParameters } from "../../src/pao/worker/dispatch-core.ts";
import {
	addNodeCards,
	bindMinister,
	prepareDirectNode,
	readControl,
	startControl,
} from "../../src/pao/workflow/control.ts";
import { resolveWorkflowDispatch } from "../../src/pao/workflow/dispatch-context.ts";
import { emitRecipeMarkdown } from "../../src/pao/workflow/distill.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";
import {
	inspectTemplateInstall,
	installStarterTemplate,
	listStarterTemplates,
} from "../../src/pao/workflow/templates.ts";

describe("出厂模板与冻结参数（离线，不调用模型）", () => {
	it("三模板均可解析，预算为实际卡预算，默认审查只读", () => {
		const templates = listStarterTemplates({ budget: { turns: 3, cost: 1 } });
		expect(templates).toHaveLength(3);
		for (const template of templates) {
			const recipe = parseRecipe(template.content, `${template.name}.md`);
			expect(recipe.节点.every((node) => node.预算?.turns === 3)).toBe(true);
			expect(recipe.节点.at(-1)?.只读).toBe(true);
		}
	});
	it("同名修改展示差异并保留，另存不动原件，非法路径拒绝", async () => {
		const home = mkdtempSync(join(tmpdir(), "pao-template-install-"));
		const first = await installStarterTemplate(home, "bugfix");
		expect(first.status).toBe("已安装");
		writeFileSync(first.path, `${first.content}\n用户自定义说明\n`);
		const second = await installStarterTemplate(home, "bugfix");
		expect(second.status).toBe("保留用户版本");
		expect(second.diff).toContain("用户自定义说明");
		expect(readFileSync(first.path, "utf8")).toContain("用户自定义说明");
		const another = await installStarterTemplate(home, "bugfix", { name: "另存小修复" });
		expect(another.status).toBe("已安装");
		expect(another.path).not.toBe(first.path);
		expect(() => inspectTemplateInstall(home, "bugfix", { name: "../越界" })).toThrow();
	});
	it("项目/范围/部门/预算进入真实任务书，普通只读规划机械拒绝交卡", async () => {
		const root = mkdtempSync(join(tmpdir(), "pao-template-readonly-"));
		const template = listStarterTemplates().find((item) => item.id === "review")!;
		const recipe = parseRecipe(template.content, `${template.name}.md`);
		recipe.节点[0].审核 = false;
		recipe.节点[0].部门标准 = undefined;
		const options = { cardsDir: join(root, "卡"), ownerSessionId: "owner" };
		await startControl(
			recipe,
			{ 项目: root, 目标: "核对加法", 范围: "src/add.ts", 验收: "引用代码行", 审查部门: "现场审查" },
			options,
		);
		const sheet = await bindMinister(recipe, options, "审查", "session");
		expect(sheet).toContain("src/add.ts");
		expect(sheet).toContain('"turns":12');
		expect(sheet).toContain(root);
		const flow = readControl(recipe, options);
		expect(flow.冻结配方.节点[0].部门).toBe("现场审查");
		await expect(
			addNodeCards(recipe, options, { 实例: flow.实例, 节点: "审查", 轮次: 1, 部长会话: "session" }, [
				{ goal: "绕过只读", acceptance: "文件存在" },
			]),
		).rejects.toThrow("只读规划节点");
	});
	it("改安装配方不能改变 v2 卡的冻结技能，旧轮次卡拒派", async () => {
		const home = mkdtempSync(join(tmpdir(), "pao-template-frozen-"));
		const template = listStarterTemplates().find((item) => item.id === "bugfix")!;
		const recipe = parseRecipe(template.content, `${template.name}.md`);
		recipe.节点[0].技能 = ["original"];
		recipe.节点[0].档位 = undefined;
		const options = {
			cardsDir: join(home, "任务", "卡"),
			ownerSessionId: "owner",
			counterPath: join(home, "counter"),
		};
		mkdirSync(join(home, "pao配置", "skills", "original"), { recursive: true });
		// S5 包2:仓内工作流声明的技能（original）须经本地允许清单确认才挂载（fail-closed）
		writeFileSync(join(home, "pao配置", "skills", "允许清单.json"), '["original"]\n', "utf8");
		mkdirSync(join(home, "工作流"), { recursive: true });
		await startControl(
			recipe,
			{
				项目: home,
				目标: "修复",
				范围: "a.ts",
				验收: "文件存在",
				执行部门: "开发",
				测试部门: "开发",
				审查部门: "审查",
			},
			options,
		);
		await prepareDirectNode(recipe, options, "开发");
		const flow = readControl(recipe, options);
		const refs = flow.节点.find((node) => node.名字 === "开发")!.卡;
		recipe.节点[0].技能 = ["missing-new-skill"];
		writeFileSync(join(home, "工作流", `${recipe.名字}.md`), emitRecipeMarkdown(recipe));
		const card = loadCard(options.cardsDir, parseCardRef(refs[0]));
		// 旧实例只用冻结快照:改安装配方不影响技能,也不使实例失效
		const workflow = resolveWorkflowDispatch(card, { cardsDir: options.cardsDir, paoHome: home });
		expect(resolveDispatchParameters(card, options.cardsDir, home, workflow?.skills).skills).toEqual([
			join(home, "pao配置", "skills", "original"),
		]);
		card.body = card.body.replace("轮次=1", "轮次=0");
		expect(() => resolveWorkflowDispatch(card, { cardsDir: options.cardsDir, paoHome: home })).toThrow(
			"当前实例/轮次",
		);
	});
});
