import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkDesktopRecipeDelete,
	checkDesktopRecipeEdit,
	previewDesktopWorkflow,
	recipeRevision,
} from "../../src/pao/desktop/editor.ts";
import { readDesktopFlows } from "../../src/pao/desktop/workflow.ts";
import { emitRecipeMarkdown, saveRecipe } from "../../src/pao/workflow/distill.ts";
import { deleteRecipe, parseRecipe, type WorkflowRecipe } from "../../src/pao/workflow/recipe.ts";
import { listStarterTemplates } from "../../src/pao/workflow/templates.ts";

const deleteRoots: string[] = [];
afterEach(() => {
	for (const root of deleteRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("桌面编辑器离线边界", () => {
	it("参数化部门技能模型与思考使用同一份展开结果", () => {
		const root = mkdtempSync(join(tmpdir(), "pao-editor-parameters-"));
		const template = listStarterTemplates()[0];
		const recipe = parseRecipe(template.content, `${template.name}.md`);
		recipe.节点[0].部门 = "{执行部门}";
		recipe.节点[0].技能 = ["{所选技能}"];
		recipe.节点[0].模型 = "{所选档位}";
		recipe.节点[0].思考强度 = "{所选思考}";
		recipe.参数.push("所选档位", "所选思考", "所选技能");
		const result = previewDesktopWorkflow(root, root, recipe, {
			执行部门: "工程",
			所选技能: "测试技能",
			所选档位: "主力",
			所选思考: "high",
		});
		expect(result.节点[0]).toMatchObject({ 部门: "工程", 技能: ["测试技能"], 模型: "主力", 思考强度: "high" });
		expect(JSON.stringify(result.report)).not.toContain("{所选");
	});
	it("缺配置预检明确拒绝且不创建目录或状态", () => {
		const root = mkdtempSync(join(tmpdir(), "pao-editor-preflight-"));
		const template = listStarterTemplates()[0];
		const recipe = parseRecipe(template.content, `${template.name}.md`);
		const result = previewDesktopWorkflow(root, root, recipe, {});
		expect(result.report.canStart).toBe(false);
		expect(result.将落卡数).toContain("无法估算");
		expect(readdirSync(root)).toEqual([]);
	});
	it("旧版本与另存重名拒绝覆盖，读取检查保留原文", () => {
		const root = mkdtempSync(join(tmpdir(), "pao-editor-revision-"));
		mkdirSync(join(root, "工作流"));
		const template = listStarterTemplates()[0];
		const path = join(root, "工作流", `${template.name}.md`);
		writeFileSync(path, template.content);
		const recipe = parseRecipe(template.content, path);
		expect(() => checkDesktopRecipeEdit(root, root, recipe, null)).toThrow("其他入口修改");
		expect(() => checkDesktopRecipeEdit(root, root, recipe, recipeRevision("旧内容"))).toThrow("其他入口修改");
		expect(readFileSync(path, "utf8")).toBe(template.content);
	});
});

describe("桌面删除配方守卫与入口语义", () => {
	/** 删除链夹具：PAO_HOME＋项目根；返回两者与配方内容。 */
	function makeDeleteFixture(): { paoHome: string; project: string; content: string; path: string } {
		const root = mkdtempSync(join(tmpdir(), "pao-editor-delete-"));
		deleteRoots.push(root);
		const paoHome = join(root, "现场");
		const project = join(root, "项目");
		mkdirSync(join(paoHome, "工作流"), { recursive: true });
		mkdirSync(join(project, ".pao", "删除任务", "卡"), { recursive: true });
		const content = emitRecipeMarkdown({
			名字: "删除流",
			自动执行: false,
			参数: [],
			节点: [
				{
					名字: "侦察",
					目标: "扫仓库",
					部门: "侦察",
					验收: "存在: 地图.md",
					depends_on: [],
					人工确认: false,
				},
			],
			说明: "## 使用说明\n删除入口测试。",
		});
		const path = join(paoHome, "工作流", "删除流.md");
		return { paoHome, project, content, path };
	}

	/** v2 控制清单（JSON frontmatter）：冻结图取自清单自身，不回读配方文件。 */
	function v2InstanceManifest(frozen: WorkflowRecipe, cardsDir: string, 状态: string): string {
		return `---\n${JSON.stringify({
			版本: 2,
			工作流: frozen.名字,
			实例: frozen.名字,
			owner: "fixture-owner",
			脉络: "删除入口测试",
			卡目录: cardsDir,
			启动: "2026-10-07T00:00:00.000Z",
			状态,
			参数: {},
			回边次数: {},
			节点: frozen.节点.map((node) => ({
				名字: node.名字,
				轮次: 1,
				卡: [],
				拆解结束: true,
				零卡理由: "测试零卡完成",
				历史: [],
			})),
			记录: [],
			冻结配方: frozen,
		})}\n---\n删除入口测试实例\n`;
	}

	it("守卫通过后 deleteRecipe 删本体；revision 漂移拒且文件不动", () => {
		const { paoHome, project, content, path } = makeDeleteFixture();
		const first = saveRecipe(paoHome, "删除流", content, { 备份时间: "20261007-000001" });
		const second = saveRecipe(paoHome, "删除流", content.replace("扫仓库", "扫仓库v2"), {
			覆盖: true,
			备份时间: "20261007-000002",
		});
		expect(second.备份).toBe(`${first.路径}.bak-20261007-000002`);
		const stale = recipeRevision(content);
		const current = recipeRevision(readFileSync(path, "utf8"));
		expect(() => checkDesktopRecipeDelete(paoHome, project, "删除流", stale)).toThrow("其他入口修改");
		expect(existsSync(path)).toBe(true);
		checkDesktopRecipeDelete(paoHome, project, "删除流", current);
		checkDesktopRecipeDelete(paoHome, project, "删除流", null);
		const deleted = deleteRecipe(paoHome, "删除流");
		expect(existsSync(deleted.路径)).toBe(false);
		// 语义钉住：只删本体，同名 .bak 备份保留。
		expect(existsSync(`${first.路径}.bak-20261007-000002`)).toBe(true);
	});

	it("清单不可读拒：坏实例清单未处理前不删除", () => {
		const { paoHome, project, content, path } = makeDeleteFixture();
		saveRecipe(paoHome, "删除流", content, { 备份时间: "20261007-000003" });
		writeFileSync(join(project, ".pao", "删除任务", "工作流实例-删除流.md"), "---\n工作流: 删除流\n---\n坏实例\n");
		expect(() => checkDesktopRecipeDelete(paoHome, project, "删除流", recipeRevision(content))).toThrow(
			"存在不可读项目/控制清单",
		);
		expect(existsSync(path)).toBe(true);
	});

	it("运行中实例拒；已完成实例不拦且删除后冻结图仍可读", () => {
		const { paoHome, project, content, path } = makeDeleteFixture();
		saveRecipe(paoHome, "删除流", content, { 备份时间: "20261007-000004" });
		const frozen = parseRecipe(content, path);
		const cardsDir = join(project, ".pao", "删除任务", "卡");
		const manifestPath = join(project, ".pao", "删除任务", "工作流实例-删除流.md");
		writeFileSync(manifestPath, v2InstanceManifest(frozen, cardsDir, "运行中"));
		expect(() => checkDesktopRecipeDelete(paoHome, project, "删除流", recipeRevision(content))).toThrow(
			"运行中的冻结实例",
		);
		expect(existsSync(path)).toBe(true);
		writeFileSync(manifestPath, v2InstanceManifest(frozen, cardsDir, "已完成"));
		checkDesktopRecipeDelete(paoHome, project, "删除流", recipeRevision(content));
		deleteRecipe(paoHome, "删除流");
		// 语义钉住：配方删除后，实例冻结图（存实例清单侧）仍可完整读出。
		const flows = readDesktopFlows(project);
		expect(flows.问题).toEqual([]);
		expect(flows.工作流).toHaveLength(1);
		expect(flows.工作流[0]!.控制.冻结配方.节点.map((node) => node.名字)).toEqual(["侦察"]);
	});
});
