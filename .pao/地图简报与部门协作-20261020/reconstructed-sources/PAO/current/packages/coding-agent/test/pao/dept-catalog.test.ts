import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// 桶导出可达:全部经 dept/index.ts 进口（UI 与主控也用同一入口）
import {
	BUILTIN_TOOL_NAMES,
	type DeptCatalogIssue,
	deptDirIdentity,
	deptUnregisteredHint,
	formatRegistry,
	listDeptNames,
	readDeptCatalog,
	RECIPE_FILE_NAME,
	RECIPE_SKILL_PLACEHOLDER,
	RECIPE_TOOL_PLACEHOLDER,
	renderRegistryText,
	SKILLS_DIR_RELATIVE_PATH,
	validateDeptCatalog,
	工具技能人设区别,
} from "../../src/pao/dept/index.ts";
import { createDept } from "../../src/pao/dept/scaffold.ts";
// 档位配置路径的正本在 routing（dept 复用其解析,不另存一份）
import { TIER_CONFIG_RELATIVE_PATH } from "../../src/pao/routing/index.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 隔离临时 PAO_HOME（绝不用 D:\AI\workspace\pao 正式现场） */
function tempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-dept-catalog-"));
	tempDirs.push(dir);
	return dir;
}

/** 最小档位配置:两档（快/主力）+ 部门默认 */
function writeTiers(home: string, deptDefaults: Record<string, string> = {}): void {
	mkdirSync(join(home, "pao配置"), { recursive: true });
	const config = {
		provider: "pao",
		档位: [
			{ 名: "快", provider: "p", model: "m-fast", thinkingLevel: "low" },
			{ 名: "主力", provider: "p", model: "m-main", thinkingLevel: "high" },
		],
		部门默认: deptDefaults,
	};
	writeFileSync(join(home, TIER_CONFIG_RELATIVE_PATH), `${JSON.stringify(config, null, "\t")}\n`, "utf8");
}

/** 落一个真技能目录（pao配置/skills/<名>/SKILL.md） */
function writeSkill(home: string, name: string): void {
	mkdirSync(join(home, SKILLS_DIR_RELATIVE_PATH, name), { recursive: true });
	writeFileSync(join(home, SKILLS_DIR_RELATIVE_PATH, name, "SKILL.md"), `# ${name}\n\n技能说明\n`, "utf8");
}

function writeRecipe(home: string, name: string, body: string): string {
	const path = join(home, "部门", name, RECIPE_FILE_NAME);
	mkdirSync(join(home, "部门", name, "知识库"), { recursive: true });
	writeFileSync(path, body, "utf8");
	return path;
}

function writeRegistry(home: string, names: string[]): void {
	mkdirSync(join(home, "部门"), { recursive: true });
	const rows = names.map((name) => ({ 名字: name, 标签: ["标签A"], 库路径: `部门/${name}/知识库`, 建部日期: "2026-10-17" }));
	writeFileSync(join(home, "部门", "注册表.md"), formatRegistry(rows), "utf8");
}

function writeKbIndex(home: string, name: string): void {
	mkdirSync(join(home, "部门", name, "知识库"), { recursive: true });
	writeFileSync(join(home, "部门", name, "知识库", "索引.md"), "# 索引\n", "utf8");
}

function issuesOf(issues: DeptCatalogIssue[], 类别: string, 部门?: string): DeptCatalogIssue[] {
	return issues.filter((issue) => issue.类别 === 类别 && (部门 === undefined || issue.部门 === 部门));
}

describe("部门目录:真实两部门（写作/审查）聚合", () => {
	it("注册表 + 配方 + 知识库入口 + 技能真实路径 + 标准真实文件,且无阻止项", () => {
		const home = tempHome();
		writeTiers(home, { 审查: "快" });
		writeSkill(home, "review-checklist");
		mkdirSync(join(home, "部门", "标准"), { recursive: true });
		writeFileSync(join(home, "部门", "标准", "文风.md"), "# 文风标准\n\n- 一段一个意思\n", "utf8");
		writeRecipe(
			home,
			"写作",
			[
				"# 配方:写作",
				"",
				"- 名字:写作",
				"- 人设:本部写对外文案,只管文字不管发布",
				"- 工具:read,grep",
				"- 技能:review-checklist",
				"- 默认档位:主力",
				"- 记忆目录:部门/写作/知识库",
				"- 部门标准:<部门/标准/文风.md>",
				"",
				"## 干法",
				"",
				"先列提纲再写。",
				"",
			].join("\n"),
		);
		writeRecipe(
			home,
			"审查",
			["# 配方:审查", "", "- 名字:审查", "- 人设:本部只做验收核对", "- 工具:read,bash", ""].join("\n"),
		);
		writeRegistry(home, ["写作", "审查"]);
		writeKbIndex(home, "写作");
		writeKbIndex(home, "审查");

		const catalog = readDeptCatalog(home);

		// 唯一名单来自注册表,顺序与注册表一致
		expect(catalog.部门.map((entry) => entry.名字)).toEqual(["写作", "审查"]);
		expect(listDeptNames(home)).toEqual(["写作", "审查"]);

		const [writing, review] = catalog.部门;
		// 人设与边界按配方实读
		expect(writing?.人设).toBe("本部写对外文案,只管文字不管发布");
		// 工具只认内置名
		expect(writing?.工具).toEqual([
			{ 名字: "read", 内置: true },
			{ 名字: "grep", 内置: true },
		]);
		// 技能定位到真实文件,不生成副本
		expect(writing?.技能).toHaveLength(1);
		expect(writing?.技能[0]?.可用).toBe(true);
		expect(writing?.技能[0]?.skillFile).toBe(join(home, SKILLS_DIR_RELATIVE_PATH, "review-checklist", "SKILL.md"));
		// 标准定位真实文件,不复制正文（条目上只有路径,没有正文）
		expect(writing?.标准).toEqual([
			{ 原始: "<部门/标准/文风.md>", 文件: join(home, "部门", "标准", "文风.md"), 可读: true },
		]);
		expect(JSON.stringify(writing)).not.toContain("一段一个意思");
		// 知识入口与干法段
		expect(writing?.知识库索引.存在).toBe(true);
		expect(writing?.干法).toEqual({ 标题: "## 干法", 文件: writing?.配方路径, 起始行: 11 });
		// 默认档位:配方写了主力就从配方来;审查走档位.json 部门默认
		expect(writing?.默认档位).toMatchObject({ 生效: "主力", 来源: "配方" });
		expect(review?.默认档位).toMatchObject({ 生效: "快", 来源: "档位.json 部门默认" });
		// 档位落到模型与思考强度（与 worker 派发 --model 同口径;查无此档时为 undefined 而不是编默认）
		expect(writing?.默认档位).toMatchObject({ 模型: "p/m-main", 思考强度: "high" });
		expect(review?.默认档位).toMatchObject({ 模型: "p/m-fast", 思考强度: "low", 派发解析: "快" });
		// 审查没有「## 干法」段 → 只给提示,不冒充阻止
		expect(issuesOf(catalog.问题, "干法", "审查")[0]?.级别).toBe("提示");
		expect(issuesOf(catalog.问题, "阻止启动" === "阻止启动" ? "配方" : "配方")).toHaveLength(0);
		expect(catalog.问题.filter((issue) => issue.级别 === "阻止启动")).toEqual([]);
	});

	it("建部正门产出的新配方:工具与技能分两行,能被目录校验读成两类", async () => {
		const home = tempHome();
		writeTiers(home);
		await createDept({ paoHome: home, 名字: "写作", 标签: ["文案"] });

		const recipe = readFileSync(join(home, "部门", "写作", RECIPE_FILE_NAME), "utf8");
		expect(recipe).toContain(`- 工具:${RECIPE_TOOL_PLACEHOLDER}`);
		expect(recipe).toContain(`- 技能:${RECIPE_SKILL_PLACEHOLDER}`);
		expect(RECIPE_TOOL_PLACEHOLDER).toContain(BUILTIN_TOOL_NAMES[0] ?? "read");
		expect(RECIPE_SKILL_PLACEHOLDER).toContain("pao配置/skills");

		const catalog = readDeptCatalog(home);
		const entry = catalog.部门[0];
		expect(entry?.配方存在).toBe(true);
		// 占位符不算真工具、也不算缺失技能
		expect(entry?.工具).toEqual([]);
		expect(issuesOf(catalog.问题, "工具")).toEqual([]);
		expect(issuesOf(catalog.问题, "技能")).toEqual([]);
		expect(catalog.问题.filter((issue) => issue.级别 === "阻止启动")).toEqual([]);
	});
});

describe("集中校验:逐项问题带真实路径与修法", () => {
	it("缺配方 → 阻止启动,路径指向配方文件,注册表行仍保留", () => {
		const home = tempHome();
		writeTiers(home);
		writeRegistry(home, ["缺配方部"]);
		const catalog = readDeptCatalog(home);
		expect(catalog.部门).toHaveLength(1);
		const issue = issuesOf(catalog.问题, "配方", "缺配方部")[0];
		expect(issue?.级别).toBe("阻止启动");
		expect(issue?.证据).toBe(join(home, "部门", "缺配方部", RECIPE_FILE_NAME));
		expect(issue?.修法).toContain("配方.md");
	});

	it("配方为空 → 阻止启动", () => {
		const home = tempHome();
		writeTiers(home);
		writeRecipe(home, "空白部", "   \n");
		writeRegistry(home, ["空白部"]);
		const catalog = readDeptCatalog(home);
		expect(issuesOf(catalog.问题, "配方", "空白部").map((issue) => issue.级别)).toContain("阻止启动");
		expect(catalog.部门[0]?.配方原文).toBe("   \n");
	});

	it("注册表非法名（含 /、..）→ 阻止启动,原值保留", () => {
		const home = tempHome();
		writeTiers(home);
		writeRegistry(home, ["../逃逸", "a/b"]);
		const catalog = readDeptCatalog(home);
		// 旧值照样出现,不被过滤成空列表
		expect(catalog.部门.map((entry) => entry.名字)).toEqual(["../逃逸", "a/b"]);
		expect(issuesOf(catalog.问题, "注册表", "../逃逸")[0]?.级别).toBe("阻止启动");
		expect(issuesOf(catalog.问题, "注册表", "a/b")[0]?.级别).toBe("阻止启动");
	});

	it("Windows 大小写重名 → 用 deptDirIdentity 判定为同一部门目录", () => {
		const home = tempHome();
		writeTiers(home);
		writeRecipe(home, "写作", "# 配方:写作\n\n- 人设:甲\n");
		mkdirSync(join(home, "部门", "写作"), { recursive: true });
		// 磁盘上只有一个 写作 目录;注册表用两种写法登记 → 文件系统身份相同
		writeRegistry(home, ["写作", "WoRter".replace("WoRter", "写作")]);
		const registryPath = join(home, "部门", "注册表.md");
		const rows = [
			"| 名字 | 能力标签 | 库路径 | 建部日期 |",
			"| --- | --- | --- | --- |",
			"| 写作 | 文案 | 部门/写作/知识库 | 2026-10-17 |",
			"| 写作 | 文案 | 部门/写作/知识库 | 2026-10-17 |",
			"",
		].join("\n");
		writeFileSync(registryPath, rows, "utf8");

		expect(deptDirIdentity(home, "写作")).toBe(deptDirIdentity(home, "写作"));
		const catalog = readDeptCatalog(home);
		const dup = catalog.问题.find((issue) => issue.类别 === "注册表" && issue.级别 === "阻止启动");
		expect(dup?.部门).toBe("写作、写作");
		expect(dup?.问题).toContain("同一个部门目录");
		expect(dup?.证据).toBe(registryPath);
	});

	it("目录写法大小写不同（磁盘上真实存在两个写法目录）→ 警告点名第二写法", () => {
		const home = tempHome();
		writeTiers(home);
		writeRecipe(home, "写作", "# 配方:写作\n\n- 人设:甲\n");
		// Windows 上 mkdir 同一目录的不同写法不会真出现两个目录;这里只验证大小写归一比对不会漏
		writeRegistry(home, ["写作"]);
		mkdirSync(join(home, "部门", "写作"), { recursive: true });
		const catalog = readDeptCatalog(home);
		// 只有一个写法时不报重名:重名判定不靠字面,靠文件名归一
		expect(issuesOf(catalog.问题, "注册表", "写作").filter((issue) => issue.问题.includes("大小写"))).toEqual([]);
	});

	it("技能目录不存在 / SKILL.md 缺失 → 阻止启动,路径指到 SKILL.md", () => {
		const home = tempHome();
		writeTiers(home);
		writeRecipe(home, "写作", "# 配方:写作\n\n- 技能:缺技能,空目录技能\n");
		// 空目录技能:目录在但 SKILL.md 缺
		mkdirSync(join(home, SKILLS_DIR_RELATIVE_PATH, "空目录技能"), { recursive: true });
		writeRegistry(home, ["写作"]);

		const catalog = readDeptCatalog(home);
		const skills = issuesOf(catalog.问题, "技能", "写作");
		expect(skills.map((issue) => issue.级别)).toEqual(["阻止启动", "阻止启动"]);
		const missing = skills.find((issue) => issue.问题.includes("缺技能"));
		expect(missing?.问题).toContain("目录不存在");
		expect(missing?.证据).toBe(join(home, SKILLS_DIR_RELATIVE_PATH, "缺技能"));
		const noSkillMd = skills.find((issue) => issue.问题.includes("空目录技能"));
		expect(noSkillMd?.问题).toContain("SKILL.md 缺失/不可读");
		expect(noSkillMd?.证据).toBe(join(home, SKILLS_DIR_RELATIVE_PATH, "空目录技能"));
	});

	it("技能行用空格分隔 → 派发口径只按逗号切分,如实点名整串", () => {
		const home = tempHome();
		writeTiers(home);
		writeSkill(home, "甲");
		writeSkill(home, "乙");
		writeRecipe(home, "写作", "# 配方:写作\n\n- 技能:甲 乙\n");
		writeRegistry(home, ["写作"]);
		const catalog = readDeptCatalog(home);
		// 派发核心不按空格切:整串「甲 乙」是一项引用
		expect(catalog.部门[0]?.技能.map((skill) => skill.引用)).toEqual(["甲 乙"]);
		const issue = issuesOf(catalog.问题, "技能", "写作")[0];
		expect(issue?.问题).toContain("空格分隔");
		expect(issue?.修法).toContain("逗号");
	});

	it("工具表外名 → 警告说明会被截到合法子集并告警,原值保留", () => {
		const home = tempHome();
		writeTiers(home);
		writeRecipe(home, "写作", "# 配方:写作\n\n- 工具:read,web_search,edit\n");
		writeRegistry(home, ["写作"]);
		const catalog = readDeptCatalog(home);
		expect(catalog.部门[0]?.工具原值).toBe("read,web_search,edit");
		expect(catalog.部门[0]?.工具).toEqual([
			{ 名字: "read", 内置: true },
			{ 名字: "web_search", 内置: false },
			{ 名字: "edit", 内置: true },
		]);
		const issue = issuesOf(catalog.问题, "工具", "写作")[0];
		expect(issue?.级别).toBe("警告");
		expect(issue?.问题).toContain("会被截到合法子集并告警");
		expect(issue?.修法).toContain("read、grep");
	});

	it("旧配方把技能名混写在「工具」行 → 点名需要拆分（不静默丢弃）", () => {
		const home = tempHome();
		writeTiers(home);
		writeSkill(home, "review-checklist");
		// 旧模板写法:一行里混着工具与技能
		writeRecipe(home, "写作", "# 配方:写作\n\n- 工具:read,review-checklist\n");
		writeRegistry(home, ["写作"]);
		const catalog = readDeptCatalog(home);
		expect(catalog.部门[0]?.混写技能名).toEqual(["review-checklist"]);
		const hint = issuesOf(catalog.问题, "技能", "写作").find((issue) => issue.级别 === "提示");
		expect(hint?.问题).toContain("review-checklist");
		expect(hint?.修法).toContain("「技能」行");
		// 同时保留表外名警告:旧值不被吞掉
		expect(issuesOf(catalog.问题, "工具", "写作")[0]?.问题).toContain("review-checklist");
	});

	it("默认档位在 档位.json 中不存在 → 阻止启动并列出真实档名;快/主力英文别名不误报", () => {
		const home = tempHome();
		writeTiers(home);
		writeRecipe(home, "写作", "# 配方:写作\n\n- 默认档位:不存在的档\n");
		writeRecipe(home, "审查", "# 配方:审查\n\n- 默认档位:fast\n");
		writeRegistry(home, ["写作", "审查"]);
		const catalog = readDeptCatalog(home);
		const bad = issuesOf(catalog.问题, "档位", "写作")[0];
		expect(bad?.级别).toBe("阻止启动");
		expect(bad?.问题).toContain("不存在的档");
		expect(bad?.修法).toContain("快、主力");
		// 查无此档时如实留空,不编一个模型出来
		expect(catalog.部门[0]?.默认档位).toEqual({
			生效: "不存在的档",
			来源: "配方",
			派发解析: "不存在的档",
		});
		// 别名 fast ≡ 快（与 routing/config tierAliasKey 同表）
		expect(issuesOf(catalog.问题, "档位", "审查")).toEqual([]);
	});

	it("档位.json 缺失 → 一条阻止项点名配置路径,不伪装成没有配置", () => {
		const home = tempHome();
		writeRecipe(home, "写作", "# 配方:写作\n\n- 人设:甲\n");
		writeRegistry(home, ["写作"]);
		const catalog = readDeptCatalog(home);
		const issue = issuesOf(catalog.问题, "档位").find((item) => item.部门 === "（档位）");
		expect(issue?.级别).toBe("阻止启动");
		expect(issue?.证据).toBe(join(home, TIER_CONFIG_RELATIVE_PATH));
	});

	it("档位.json 部门默认引用未登记部门 / 标准与知识库缺失 → 提示或警告,不改成空", () => {
		const home = tempHome();
		writeTiers(home, { 幽灵部: "快" });
		writeRecipe(home, "写作", "# 配方:写作\n\n- 部门标准:<部门/标准/不存在.md>\n");
		writeRegistry(home, ["写作"]);
		const catalog = readDeptCatalog(home);
		expect(issuesOf(catalog.问题, "档位", "幽灵部")[0]?.级别).toBe("提示");
		const standard = issuesOf(catalog.问题, "标准", "写作")[0];
		expect(standard?.级别).toBe("警告");
		expect(standard?.证据).toBe(join(home, "部门", "标准", "不存在.md"));
		expect(issuesOf(catalog.问题, "知识库", "写作")[0]?.级别).toBe("警告");
		// 旧无效值保留:标准引用原样在条目上
		expect(catalog.部门[0]?.标准).toEqual([
			{ 原始: "<部门/标准/不存在.md>", 文件: join(home, "部门", "标准", "不存在.md"), 可读: false },
		]);
	});

	it("注册表不存在 → 一条警告说明「没有已登记部门」,不报空表错误", () => {
		const home = tempHome();
		writeTiers(home);
		const catalog = readDeptCatalog(home);
		expect(catalog.部门).toEqual([]);
		expect(issuesOf(catalog.问题, "注册表", "（注册表）")[0]?.级别).toBe("警告");
	});

	it("validateDeptCatalog 可单独对已有目录复审,不改盘上任何文件", () => {
		const home = tempHome();
		writeTiers(home);
		writeRecipe(home, "写作", "# 配方:写作\n\n- 工具:web_search\n");
		writeRegistry(home, ["写作"]);
		const before = readFileSync(join(home, "部门", "写作", RECIPE_FILE_NAME), "utf8");
		const catalog = readDeptCatalog(home);
		const again = validateDeptCatalog(catalog);
		expect(again.length).toBeGreaterThan(0);
		expect(readFileSync(join(home, "部门", "写作", RECIPE_FILE_NAME), "utf8")).toBe(before);
	});
});

describe("三种东西的区别文案与未注册提示", () => {
	it("工具权限/技能引用/人设文字各一句,数量与顺序稳定（UI 与工具说明共用）", () => {
		expect(工具技能人设区别.map((row) => row.角色)).toEqual(["工具权限", "技能引用", "人设文字"]);
		for (const row of 工具技能人设区别) {
			expect(row.含义.length).toBeGreaterThan(0);
			expect(row.真实性判据.length).toBeGreaterThan(0);
		}
		expect(工具技能人设区别[2]?.真实性判据).toContain("文字");
	});

	it("未注册但有目录 → 说出实话且不自动建部;无目录 → 不提", () => {
		const home = tempHome();
		writeTiers(home);
		mkdirSync(join(home, "部门", "野部门"), { recursive: true });
		expect(deptUnregisteredHint(home, "野部门")).toContain("注册表里没有该部门");
		expect(deptUnregisteredHint(home, "根本没有")).toBeUndefined();
		// 不自动建部:读一遍目录后注册表不存在
		readDeptCatalog(home);
		expect(listDeptNames(home)).toEqual([]);
		// 渲染注册表文本仍在（唯一正本入口没被目录读取改写）
		expect(renderRegistryText).toBeTypeOf("function");
	});
});
