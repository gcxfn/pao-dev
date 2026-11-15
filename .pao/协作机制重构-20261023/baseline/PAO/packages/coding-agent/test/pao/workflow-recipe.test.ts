/**
 * 工作流配方解析与校验（架构 §11.2）：
 * 合法配方解析、未知引用/自依赖/环被拒、占位符校验、坏文件结构化报错。
 * PAO_HOME 用临时 fixture 目录注入，不碰真实配置。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
	isWorkflowRecipeError,
	listRecipes,
	loadRecipe,
	parseRecipe,
	recipePath,
	requireParams,
	substituteParams,
	WorkflowRecipeError,
} from "../../src/pao/workflow/recipe.ts";

let paoHome: string;

beforeEach(() => {
	paoHome = mkdtempSync(join(tmpdir(), "pao-flow-recipe-"));
	mkdirSync(join(paoHome, "工作流"), { recursive: true });
});

afterEach(() => {
	rmSync(paoHome, { recursive: true, force: true });
});

const validRecipe = `---
名字: 大活流程
适用: 需要侦察与规划的大活
参数: [仓库, 期限]
节点:
  - 名字: 澄清
    部门: 规划部
    目标: "澄清 {仓库} 的原始意图与边界"
    验收: 澄清纪要落盘
  - 名字: 侦察
    部门: 核心机制
    目标: "侦察 {仓库} 的现有实现"
    验收: 侦察笔记落盘
    depends_on: [澄清]
  - 名字: 规划
    部门: 规划部
    目标: "产出 {仓库} 的实施计划（期限 {期限}）"
    验收: 计划落盘
    depends_on: [侦察]
    人工确认: true
---
用法：/流 大活流程 仓库=xxx 期限=yyy。
`;

function writeRecipe(name: string, content: string): string {
	const path = recipePath(paoHome, name);
	writeFileSync(path, content, "utf8");
	return path;
}

describe("合法配方解析", () => {
	test("并行组元数据保留且仅作展示，不改变旧配方默认行为", () => {
		const content = `---
版本: 2
名字: 并行流
参数: []
parallelGroups:
  - id: 调研
    maxConcurrency: 2
    failurePolicy: fail_fast
    cancelPolicy: cancel_pending
节点:
  - 名字: 接口调研
    部门: 规划
    目标: 调研接口
    验收: 记录完成
    parallelGroupId: 调研
    branchId: 接口
    joinId: 调研汇聚
  - 名字: 数据调研
    部门: 规划
    目标: 调研数据
    验收: 记录完成
    parallelGroupId: 调研
    branchId: 数据
    joinId: 调研汇聚
---
说明
`;
		const recipe = parseRecipe(content, join(paoHome, "并行流.md"));
		expect(recipe.parallelGroups).toEqual([
			{
				id: "调研",
				maxConcurrency: 2,
				failurePolicy: "fail_fast",
				cancelPolicy: "cancel_pending",
			},
		]);
		expect(
			recipe.节点.map(({ parallelGroupId, branchId, joinId }) => ({ parallelGroupId, branchId, joinId })),
		).toEqual([
			{ parallelGroupId: "调研", branchId: "接口", joinId: "调研汇聚" },
			{ parallelGroupId: "调研", branchId: "数据", joinId: "调研汇聚" },
		]);
		const old = parseRecipe(validRecipe, join(paoHome, "大活流程.md"));
		expect(old.parallelGroups).toBeUndefined();
		expect(old.节点[0].parallelGroupId).toBeUndefined();
	});

	test("并行元数据的未知组、分支孤立和非法策略结构化拒绝", () => {
		const content = `---
版本: 2
名字: 坏并行流
参数: []
parallelGroups:
  - id: 调研
    maxConcurrency: 0
    failurePolicy: unknown
节点:
  - 名字: 节点
    部门: 规划
    目标: 做事
    验收: 完成
    parallelGroupId: 不存在
    branchId: 分支
---
`;
		expect(() => parseRecipe(content, join(paoHome, "坏并行流.md"))).toThrow(
			/maxConcurrency|failurePolicy|未声明对应并行组/,
		);
	});

	test("未声明任何并行组时，节点并行标识也必须被拒绝", () => {
		const content = `---
版本: 2
名字: 未声明并行组
参数: []
节点:
  - 名字: 节点
    部门: 规划
    目标: 做事
    验收: 完成
    parallelGroupId: 调研
---
`;
		expect(() => parseRecipe(content, join(paoHome, "未声明并行组.md"))).toThrow(/未声明对应并行组/);
	});

	test("loadRecipe：frontmatter 字段、拓扑序、占位符、人工确认齐备", () => {
		const path = writeRecipe("大活流程", validRecipe);
		const recipe = loadRecipe(paoHome, "大活流程");
		expect(recipe.名字).toBe("大活流程");
		expect(recipe.适用).toBe("需要侦察与规划的大活");
		expect(recipe.参数).toEqual(["仓库", "期限"]);
		expect(recipe.文件路径).toBe(path);
		expect(recipe.说明).toContain("/流 大活流程");
		expect(recipe.节点).toHaveLength(3);
		expect(recipe.拓扑序).toEqual(["澄清", "侦察", "规划"]);
		expect(recipe.占位符).toEqual(["仓库", "期限"]);
		expect(recipe.节点[1].depends_on).toEqual(["澄清"]);
		expect(recipe.节点[2].人工确认).toBe(true);
		expect(recipe.节点[0].人工确认).toBe(false);
	});

	test("listRecipes：列出目录下全部配方名", () => {
		writeRecipe("大活流程", validRecipe);
		writeRecipe("小活流程", validRecipe.replace("大活流程", "小活流程"));
		expect(listRecipes(paoHome)).toEqual(["大活流程", "小活流程"]);
	});

	test("substituteParams：代入声明参数，缺值原样保留", () => {
		expect(substituteParams("侦察 {仓库}（期限 {期限}）", { 仓库: "pao" })).toBe("侦察 pao（期限 {期限}）");
	});

	test("requireParams：占位符全有值放行，缺值抛 RECIPE_PARAM_MISSING", () => {
		writeRecipe("大活流程", validRecipe);
		const recipe = loadRecipe(paoHome, "大活流程");
		expect(() => requireParams(recipe, { 仓库: "pao", 期限: "周五" })).not.toThrow();
		try {
			requireParams(recipe, { 仓库: "pao" });
			expect.unreachable("缺参数应抛错");
		} catch (error) {
			expect(isWorkflowRecipeError(error)).toBe(true);
			expect((error as WorkflowRecipeError).code).toBe("RECIPE_PARAM_MISSING");
			expect((error as WorkflowRecipeError).details.缺).toEqual(["期限"]);
		}
	});
});

describe("坏配方被拒（结构化错误）", () => {
	test("不存在的配方 → RECIPE_NOT_FOUND，附可用清单", () => {
		writeRecipe("大活流程", validRecipe);
		try {
			loadRecipe(paoHome, "不存在的流");
			expect.unreachable("应抛 RECIPE_NOT_FOUND");
		} catch (error) {
			expect((error as WorkflowRecipeError).code).toBe("RECIPE_NOT_FOUND");
			expect((error as WorkflowRecipeError).message).toContain("大活流程");
		}
	});

	test("坏 YAML frontmatter → RECIPE_PARSE 不崩", () => {
		writeRecipe("坏流", "---\n名字: [坏\n  结构: {{{\n---\n正文");
		try {
			loadRecipe(paoHome, "坏流");
			expect.unreachable("应抛 RECIPE_PARSE");
		} catch (error) {
			expect((error as WorkflowRecipeError).code).toBe("RECIPE_PARSE");
		}
	});

	test("缺必需字段一次列全 → RECIPE_FIELD", () => {
		writeRecipe(
			"缺字段流",
			`---
名字: 缺字段流
节点:
  - 名字: 侦察
    部门: 核心机制
---
正文
`,
		);
		try {
			loadRecipe(paoHome, "缺字段流");
			expect.unreachable("应抛 RECIPE_FIELD");
		} catch (error) {
			const err = error as WorkflowRecipeError;
			expect(err.code).toBe("RECIPE_FIELD");
			const problems = err.details.problems as string[];
			expect(problems.some((p) => p.includes("目标"))).toBe(true);
			expect(problems.some((p) => p.includes("验收"))).toBe(true);
		}
	});

	test("名字与文件名不一致 → RECIPE_FIELD", () => {
		writeRecipe("甲流", validRecipe.replace("名字: 大活流程", "名字: 乙流"));
		expect(() => loadRecipe(paoHome, "甲流")).toThrowError(/不一致/);
	});

	test("loadRecipe 名字带路径穿越 → RECIPE_FIELD，先拒名字不读库外文件", () => {
		expect(() => loadRecipe(paoHome, "../pao配置/装载清单")).toThrowError(WorkflowRecipeError);
		try {
			loadRecipe(paoHome, "../pao配置/装载清单");
			expect.unreachable("应抛 RECIPE_FIELD");
		} catch (error) {
			const err = error as WorkflowRecipeError;
			expect(err.code).toBe("RECIPE_FIELD");
			expect(err.message).toContain("非法字符");
			expect(err.message).not.toContain("找不到");
		}
	});

	test("loadRecipe 名字带空格 → RECIPE_FIELD（带空格的流名写得出、读不回）", () => {
		expect(() => loadRecipe(paoHome, "带 空格")).toThrowError(/空白/);
	});

	test("配方 frontmatter 名字带空格 → RECIPE_FIELD 列进 problems", () => {
		writeRecipe("空格流", validRecipe.replace("名字: 大活流程", "名字: 带 空格流").replace("大活流程", "带 空格流"));
		try {
			loadRecipe(paoHome, "空格流");
			expect.unreachable("应抛 RECIPE_FIELD");
		} catch (error) {
			const err = error as WorkflowRecipeError;
			expect(err.code).toBe("RECIPE_FIELD");
			expect((err.details.problems as string[]).some((p) => p.includes("空白"))).toBe(true);
		}
	});

	test("depends_on 引用不存在的节点（未知卡）→ RECIPE_DEP_UNKNOWN", () => {
		writeRecipe(
			"未知卡流",
			`---
名字: 未知卡流
节点:
  - 名字: 侦察
    部门: 核心机制
    目标: 侦察
    验收: 落盘
    depends_on: [幽灵节点]
---
`,
		);
		try {
			loadRecipe(paoHome, "未知卡流");
			expect.unreachable("应抛 RECIPE_DEP_UNKNOWN");
		} catch (error) {
			const err = error as WorkflowRecipeError;
			expect(err.code).toBe("RECIPE_DEP_UNKNOWN");
			expect(err.details.引用).toBe("幽灵节点");
		}
	});

	test("自依赖 → RECIPE_DEP_SELF", () => {
		writeRecipe(
			"自依赖流",
			`---
名字: 自依赖流
节点:
  - 名字: 侦察
    部门: 核心机制
    目标: 侦察
    验收: 落盘
    depends_on: [侦察]
---
`,
		);
		expect(() => loadRecipe(paoHome, "自依赖流")).toThrowError(/依赖自身/);
	});

	test("依赖成环 → RECIPE_CYCLE 拒绝加载", () => {
		writeRecipe(
			"成环流",
			`---
名字: 成环流
节点:
  - 名字: 甲
    部门: 规划部
    目标: 甲
    验收: 落盘
    depends_on: [丙]
  - 名字: 乙
    部门: 规划部
    目标: 乙
    验收: 落盘
    depends_on: [甲]
  - 名字: 丙
    部门: 规划部
    目标: 丙
    验收: 落盘
    depends_on: [乙]
---
`,
		);
		try {
			loadRecipe(paoHome, "成环流");
			expect.unreachable("应抛 RECIPE_CYCLE");
		} catch (error) {
			const err = error as WorkflowRecipeError;
			expect(err.code).toBe("RECIPE_CYCLE");
			expect(err.details.成环节点).toContain("甲");
		}
	});

	test("非审核节点声明回边 → 报错同时含索引与节点名（0 基）", () => {
		writeRecipe(
			"回边流",
			`---
名字: 回边流
版本: 2
节点:
  - 名字: 侦察
    部门: 核心机制
    目标: 侦察
    验收: 落盘
    回边:
      - 目标: 侦察
        上限: 1
        超限动作: 停滞
---
`,
		);
		try {
			loadRecipe(paoHome, "回边流");
			expect.unreachable("应抛 RECIPE_FIELD");
		} catch (error) {
			const err = error as WorkflowRecipeError;
			expect(err.code).toBe("RECIPE_FIELD");
			expect(err.message).toContain("节点[0]");
			expect(err.message).toContain("「侦察」");
			expect(err.message).toContain("仅审核节点可声明回边");
		}
	});

	test("未声明的参数占位符 → RECIPE_PARAM_PLACEHOLDER", () => {
		writeRecipe(
			"占位符流",
			`---
名字: 占位符流
参数: [仓库]
节点:
  - 名字: 侦察
    部门: 核心机制
    目标: "侦察 {仓库}（期限 {期限}）"
    验收: 落盘
---
`,
		);
		try {
			loadRecipe(paoHome, "占位符流");
			expect.unreachable("应抛 RECIPE_PARAM_PLACEHOLDER");
		} catch (error) {
			const err = error as WorkflowRecipeError;
			expect(err.code).toBe("RECIPE_PARAM_PLACEHOLDER");
			expect(err.details.未声明).toEqual(["期限"]);
		}
	});

	test("parseRecipe 对无 frontmatter 内容报 RECIPE_PARSE", () => {
		expect(() => parseRecipe("就是一段正文", "某目录/某流.md")).toThrowError(WorkflowRecipeError);
	});
});
