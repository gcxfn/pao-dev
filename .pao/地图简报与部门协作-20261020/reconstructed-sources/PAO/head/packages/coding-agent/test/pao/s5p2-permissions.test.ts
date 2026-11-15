import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCard } from "../../src/pao/cards/cardfile.ts";
import { loadSkillAllowList, resolveDispatchParameters } from "../../src/pao/worker/dispatch-core.ts";

/**
 * S5 包2（B-6／架构 §4:98 仓库内容不得自我提权）：
 * - 仓内工作流声明的技能（技能装载面）未经本地允许清单确认 → 整体忽略并告警；
 *   允许清单（PAO_HOME/pao配置/skills/允许清单.json）只读——「总是允许」只经本地用户确认写本地。
 * - 配方「工具」含表外名：截到合法子集（默认权限只可收紧，不整表放宽），并告警。
 */

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "pao-s5p2-perm-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** 假 PAO_HOME：部门配方＋技能目录；允许清单由用例决定是否落。
 *  配方不写「默认档位」行：写了（含占位值）会触发 resolveDispatchParameters 读档位.json，
 *  权限面测试与档位无关，不建该文件。 */
function makePaoHome(recipeTools?: string): { home: string; cardsDir: string } {
	const home = tempDir();
	const deptDir = join(home, "部门", "核心机制");
	mkdirSync(deptDir, { recursive: true });
	const recipe = ["# 配方", ...(recipeTools ? [`- 工具: ${recipeTools}`] : []), "- skills: 待填"];
	writeFileSync(join(deptDir, "配方.md"), `${recipe.join("\n")}\n`);
	const skillsDir = join(home, "pao配置", "skills");
	mkdirSync(skillsDir, { recursive: true });
	writeFileSync(join(skillsDir, "复盘.md"), "# 复盘技能\n");
	writeFileSync(join(skillsDir, "审计.md"), "# 审计技能\n");
	const cardsDir = join(tempDir(), ".pao", "卡");
	mkdirSync(cardsDir, { recursive: true });
	return { home, cardsDir };
}

async function makeCard(cardsDir: string) {
	return createCard(cardsDir, {
		目标: "权限收窄卡",
		部门: "核心机制",
		验收: "可判条件",
		创建: "2026-10-07 12:00",
	});
}

function writeAllowList(home: string, names: string[]): void {
	const dir = join(home, "pao配置", "skills");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "允许清单.json"), `${JSON.stringify(names)}\n`);
}

describe("技能装载面：仓内声明未经本地确认整体忽略并告警", () => {
	it("允许清单缺失 → 工作流声明技能全部忽略，派发告警点名", async () => {
		const { home, cardsDir } = makePaoHome();
		const card = await makeCard(cardsDir);
		const result = resolveDispatchParameters(card, cardsDir, home, [
			join(home, "pao配置", "skills", "复盘.md"),
			join(home, "pao配置", "skills", "审计.md"),
		]);
		expect(result.skills ?? []).toHaveLength(0);
		expect(result.派发告警?.join("\n") ?? "").toContain("复盘");
		expect(result.派发告警?.join("\n") ?? "").toContain("允许清单");
	});

	it("本地允许清单确认过的技能正常装载，未确认的仍忽略", async () => {
		const { home, cardsDir } = makePaoHome();
		// 清单条目＝技能文件名精确匹配（复盘.md 带扩展名；写「复盘」不算确认，fail-closed）
		writeAllowList(home, ["复盘.md"]);
		const card = await makeCard(cardsDir);
		const result = resolveDispatchParameters(card, cardsDir, home, [
			join(home, "pao配置", "skills", "复盘.md"),
			join(home, "pao配置", "skills", "审计.md"),
		]);
		expect(result.skills).toEqual([join(home, "pao配置", "skills", "复盘.md")]);
		expect(result.派发告警?.join("\n") ?? "").toContain("审计");
	});

	it("loadSkillAllowList 只读本地文件：坏 JSON 当空清单（fail-closed，不猜）", () => {
		const { home } = makePaoHome();
		writeFileSync(join(home, "pao配置", "skills", "允许清单.json"), "not json");
		expect(loadSkillAllowList(home).size).toBe(0);
		expect(loadSkillAllowList(join(home, "不存在的家")).size).toBe(0);
	});
});

describe("配方「工具」声明：默认权限只可收紧", () => {
	it("全合法名 → 白名单照旧（钉子：既有行为不变）", async () => {
		const { home, cardsDir } = makePaoHome("read, grep");
		const card = await makeCard(cardsDir);
		const result = resolveDispatchParameters(card, cardsDir, home);
		expect(result.工具白名单).toEqual(["read", "grep"]);
		expect(result.派发告警).toBeUndefined();
	});

	it("含表外名 → 截到合法子集并告警，不整表放宽回全默认面", async () => {
		const { home, cardsDir } = makePaoHome("read, 自造工具, edit");
		const card = await makeCard(cardsDir);
		const result = resolveDispatchParameters(card, cardsDir, home);
		expect(result.工具白名单).toEqual(["read", "edit"]);
		expect(result.派发告警?.join("\n") ?? "").toContain("自造工具");
	});
});
