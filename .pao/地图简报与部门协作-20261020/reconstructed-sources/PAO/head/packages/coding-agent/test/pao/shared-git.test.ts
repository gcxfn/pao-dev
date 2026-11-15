/**
 * shared/git 单测（S11 spawn git ENOENT 文案）：git 未安装/不在 PATH 时 spawn ENOENT
 * 原文无信息量，文案须说清「未找到、查安装与 PATH」且不吞原始错误。
 */
import { describe, expect, it } from "vitest";

import { gitSpawnErrorText } from "../../src/pao/shared/git.ts";

describe("gitSpawnErrorText", () => {
	it("ENOENT：附可诊断提示，原始错误文本保留在结果里", () => {
		const raw = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
		const text = gitSpawnErrorText(raw);
		expect(text).toContain("git 未找到");
		expect(text).toContain("PATH");
		expect(text).toContain("spawn git ENOENT");
	});

	it("非 ENOENT 错误与字符串原样透传，不添乱", () => {
		expect(gitSpawnErrorText(new Error("fatal: not a git repository"))).toBe("fatal: not a git repository");
		expect(gitSpawnErrorText("boom")).toBe("boom");
	});
});
