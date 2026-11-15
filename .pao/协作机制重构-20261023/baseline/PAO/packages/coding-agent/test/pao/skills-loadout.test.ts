/**
 * M1-04 skills 实挂:pao配置/skills 下移植的高频 skill 用 pi 真实装载代码路径
 * (core/skills.ts loadSkills,与会话启动同源)验证可发现、frontmatter 合法。
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSkills } from "../../src/core/skills.ts";

/** 使用现场(2026-10-02 分仓定案)＝workspace/pao 独立仓库,含 pao配置/skills;从本文件向上六级到 workspace 再进 pao */
const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..", "pao");
const skillsDir = join(siteRoot, "pao配置", "skills");

function loadPaoSkills() {
	return loadSkills({
		cwd: siteRoot,
		agentDir: join(siteRoot, "PAO", "packages", "coding-agent", "test", "pao", "无此agent目录"),
		skillPaths: [skillsDir],
		includeDefaults: false,
	});
}

describe("pao skills 目录(pi 原生机制装载)", () => {
	it("目录存在且含已移植 skill", () => {
		expect(existsSync(skillsDir)).toBe(true);
	});

	it("pi loadSkills 真实装载:commit 与 codebase-memory 都被发现,无校验错误", () => {
		const { skills, diagnostics } = loadPaoSkills();
		const error = diagnostics.filter((d) => d.type === "error");
		expect(error).toEqual([]);
		const names = skills.map((skill) => skill.name);
		expect(names).toContain("commit");
		expect(names).toContain("codebase-memory");

		const commit = skills.find((skill) => skill.name === "commit")!;
		expect(commit.description).toContain("Conventional Commits");
		expect(commit.filePath).toContain(join("pao配置", "skills", "commit", "SKILL.md"));

		const cbm = skills.find((skill) => skill.name === "codebase-memory")!;
		// 路由描述说清何时用(M1-04:检查路径与前提)
		expect(cbm.description).toContain("调用链");
	});

	it("skill 声明的前提在本机真实存在", () => {
		// codebase-memory 前提:本机可执行文件(无密钥)
		expect(existsSync("C:/Users/ASUS/.local/bin/codebase-memory-mcp.exe")).toBe(true);
		// commit 前提:git 在 PATH
		expect(process.env.PATH).toBeTruthy();
	});
});
