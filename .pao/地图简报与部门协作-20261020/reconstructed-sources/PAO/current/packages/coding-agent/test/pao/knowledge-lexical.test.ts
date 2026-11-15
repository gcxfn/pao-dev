import { describe, expect, test } from "vitest";
import { splitQueryTerms } from "../../src/pao/knowledge/lexical.ts";

describe("splitQueryTerms 查询切词", () => {
	test("标点切分｜整句回退｜中文不拆字｜空串", () => {
		// 切分块之外整句（trim 后）也作为一个词块追加（lexical.ts:27 回退，兼顾完整短语命中）
		expect(splitQueryTerms("修复,登录。超时")).toEqual(["修复", "登录", "超时", "修复,登录。超时"]);
		expect(splitQueryTerms("修复 登录")).toContain("修复 登录");
		expect(splitQueryTerms("中文查询不拆字")).toEqual(["中文查询不拆字"]);
		expect(splitQueryTerms("")).toEqual([]);
		expect(splitQueryTerms("   ")).toEqual([]);
	});
});
