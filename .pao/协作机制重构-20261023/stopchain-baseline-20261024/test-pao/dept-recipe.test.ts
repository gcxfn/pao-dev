import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// 桶导出可达:全部经 dept/index.ts 进口,不绕道 render.ts
import {
	createDept,
	RECIPE_FILE_NAME,
	recipeFingerprint,
	renderRecipeSnapshot,
	splitRecipeMethod,
} from "../../src/pao/dept/index.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-dept-recipe-"));
	tempDirs.push(dir);
	return dir;
}

/** 造假部门结构:只落 部门/<名>/配方.md,不建库不进注册表(本文件只测配方装载,不测建部正门) */
function fakeDept(home: string, name: string, recipeBody: string): string {
	const recipePath = join(home, "部门", name, RECIPE_FILE_NAME);
	mkdirSync(join(home, "部门", name), { recursive: true });
	writeFileSync(recipePath, recipeBody, "utf8");
	return recipePath;
}

describe("部门配方快照(renderRecipeSnapshot)", () => {
	it("无标记旧配方的全文、截至行和身份均保留", () => {
		const home = tempHome();
		const recipePath = fakeDept(home, "后端", "# 配方:后端\n\n- 人设:本部答 API 网关与数据库问题\n");
		// 钉死 mtime:本地时区 2026-10-02 08:30,与渲染口径逐字比对
		utimesSync(recipePath, new Date(2026, 9, 2, 8, 30), new Date(2026, 9, 2, 8, 30));

		const snapshot = renderRecipeSnapshot("后端", home);
		expect(snapshot).not.toBeNull();
		expect(snapshot).toContain("截至 2026-10-02 08:30");
		expect(snapshot).toContain("本部答 API 网关与数据库问题");
		expect(snapshot).toContain("部门「后端」");
		expect(snapshot).toContain("# 配方:后端");
		// 与注册表快照同口径:不自包 XML 标签
		expect(snapshot).not.toContain("<pao_dept_");
	});

	it("有标记配方只常驻概要,保留路径、按需读取与最新配方校验约束", () => {
		const home = tempHome();
		fakeDept(
			home,
			"后端",
			"# 配方:后端\n\n- 人设:负责 API\n\n## 干法\n\n干法正文不应常驻\n更多步骤\n",
		);

		const snapshot = renderRecipeSnapshot("后端", home);
		expect(snapshot).toContain("部门「后端」");
		expect(snapshot).toContain("负责 API");
		expect(snapshot).toContain(join(home, "部门", "后端", RECIPE_FILE_NAME));
		expect(snapshot).toContain("按需读取");
		expect(snapshot).toContain("最新配方为准");
		expect(snapshot).toContain("截至");
		expect(snapshot).not.toContain("干法正文不应常驻");
	});

	it("只有干法标记时明确说明没有常驻概要,并保留路径", () => {
		const home = tempHome();
		fakeDept(home, "后端", "## 干法\n\n只在干法里的步骤\n");

		const snapshot = renderRecipeSnapshot("后端", home);
		expect(snapshot).toContain("没有常驻概要");
		expect(snapshot).toContain(join(home, "部门", "后端", RECIPE_FILE_NAME));
		expect(snapshot).not.toContain("只在干法里的步骤");
	});

	it("配方文件不存在返回 null(调用方跳过):无部门目录与有目录无配方都算缺", () => {
		const home = tempHome();
		expect(renderRecipeSnapshot("后端", home)).toBeNull();
		mkdirSync(join(home, "部门", "后端"), { recursive: true });
		expect(renderRecipeSnapshot("后端", home)).toBeNull();
	});

	it("纯切分函数保留无标记全文,有标记只返回概要", () => {
		expect(splitRecipeMethod("# 旧配方\n规则\n")).toEqual({
			hasMethod: false,
			overview: "# 旧配方\n规则",
		});
		expect(splitRecipeMethod("# 新配方\n\n概要\n\n## 干法\n正文")).toEqual({
			hasMethod: true,
			overview: "# 新配方\n\n概要",
		});
	});
});

describe("配方指纹(recipeFingerprint)", () => {
	it("指纹稳定,等于配方内容的 sha1;mtime 变而内容不变时指纹不动", () => {
		const home = tempHome();
		const recipePath = fakeDept(home, "后端", "# 配方:后端\n\n- 人设:稳定规则\n");

		const fp1 = recipeFingerprint("后端", home);
		expect(fp1).not.toBeNull();
		expect(fp1).toMatch(/^[0-9a-f]{40}$/);
		expect(fp1).toBe(recipeFingerprint("后端", home));
		// 指纹锚定内容而非 mtime:只碰时间戳,指纹不动
		utimesSync(recipePath, new Date(2026, 9, 2, 23, 59), new Date(2026, 9, 2, 23, 59));
		expect(recipeFingerprint("后端", home)).toBe(fp1);
		// 与独立计算的 sha1 逐字一致(确实哈希的是文件字节)
		const expected = createHash("sha1").update(readFileSync(recipePath, "utf8"), "utf8").digest("hex");
		expect(fp1).toBe(expected);
	});

	it("内容变了指纹跟着变;配方文件不存在返回 null", () => {
		const home = tempHome();
		const recipePath = fakeDept(home, "后端", "# 配方:后端\n\n- 默认档位:主力\n");
		const fp1 = recipeFingerprint("后端", home);
		writeFileSync(recipePath, "# 配方:后端\n\n- 默认档位:快\n", "utf8");
		expect(recipeFingerprint("后端", home)).not.toBe(fp1);

		expect(recipeFingerprint("不存在部", home)).toBeNull();
	});

	it("只改干法正文时指纹仍变化,不因部长只常驻概要而合并指纹", () => {
		const home = tempHome();
		const recipePath = fakeDept(home, "后端", "# 配方:后端\n\n概要不变\n\n## 干法\n\n旧步骤\n");
		const fp1 = recipeFingerprint("后端", home);
		const before = renderRecipeSnapshot("后端", home);
		writeFileSync(recipePath, "# 配方:后端\n\n概要不变\n\n## 干法\n\n新步骤\n", "utf8");
		const fp2 = recipeFingerprint("后端", home);

		expect(fp2).not.toBe(fp1);
		expect(renderRecipeSnapshot("后端", home)).toBe(before);
	});
});

describe("桶导出与建部正门联动", () => {
	it("桶导出可达:renderRecipeSnapshot / recipeFingerprint 均为函数", () => {
		expect(typeof renderRecipeSnapshot).toBe("function");
		expect(typeof recipeFingerprint).toBe("function");
		expect(RECIPE_FILE_NAME).toBe("配方.md");
	});

	it("经 pao_create_dept 造出的真结构同样可渲染可指纹;配方模板带「任务结论写回执与库,不写进配方」提醒", async () => {
		const home = tempHome();
		await createDept({ paoHome: home, 名字: "侦察" });
		const snapshot = renderRecipeSnapshot("侦察", home);
		expect(snapshot).not.toBeNull();
		expect(snapshot).toContain("截至");
		expect(snapshot).toContain("记忆目录:部门/侦察/知识库");
		expect(recipeFingerprint("侦察", home)).toMatch(/^[0-9a-f]{40}$/);

		const template = readFileSync(join(home, "部门", "侦察", RECIPE_FILE_NAME), "utf8");
		expect(template).toContain("任务结论写回执与库,不写进配方");
		// 纯读:快照与指纹不落任何新文件
		const before = existsSync(join(home, "部门", "注册表.md"));
		renderRecipeSnapshot("侦察", home);
		recipeFingerprint("侦察", home);
		expect(existsSync(join(home, "部门", "注册表.md"))).toBe(before);
	});
});
