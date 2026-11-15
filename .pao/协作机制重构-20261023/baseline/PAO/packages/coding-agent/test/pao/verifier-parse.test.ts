import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCommitMessage } from "../../src/pao/cards/delivery.ts";
import type { CardFrontmatter } from "../../src/pao/cards/types.ts";
import {
	checkCommandSafety,
	parseAcceptance,
	readLatestVerdict,
	validateAcceptance,
} from "../../src/pao/cards/verifier.ts";

/**
 * §12 机械验收员·纯函数面：三种句式解析（含与人话句混写）、句式安检门、
 * 卡上派生验收记录解析、§13 提交信息模板。
 */

function fm(overrides: Partial<CardFrontmatter> = {}): CardFrontmatter {
	return {
		goal: "巡库卡",
		dept: "核心机制",
		acceptance: "x",
		attempt: 1,
		created: "2026-10-02 10:00",
		status: "delivered",
		...overrides,
	};
}

describe("验收条目解析：三种句式 v1（跑/存在/包含）", () => {
	it("三种句式逐行识别，主体与子串拆解正确", () => {
		const { mechanicalEntry, plainSentence } = parseAcceptance(
			["跑: node --version", "存在: src/pao/cards/verifier.ts", "包含: README.md :: PAO"].join("\n"),
		);
		expect(mechanicalEntry).toHaveLength(3);
		expect(mechanicalEntry[0]).toMatchObject({ 类型: "跑", 主体: "node --version" });
		expect(mechanicalEntry[1]).toMatchObject({ 类型: "存在", 主体: "src/pao/cards/verifier.ts" });
		expect(mechanicalEntry[2]).toMatchObject({ 类型: "包含", 主体: "README.md", 子串: "PAO" });
		expect(plainSentence).toEqual([]);
	});

	it("机械条目与人话句可混写；人话句照旧归人工/审查口径", () => {
		const { mechanicalEntry, plainSentence } = parseAcceptance(
			'跑: node -e ""\n代码评审过目，命名统一中文拼音\n\n存在: 包.txt',
		);
		expect(mechanicalEntry.map((e) => e.类型)).toEqual(["跑", "存在"]);
		expect(plainSentence).toEqual(["代码评审过目，命名统一中文拼音"]);
	});

	it("容忍列表符前缀与全角冒号", () => {
		const { mechanicalEntry } = parseAcceptance('- 跑：node -e ""\n* 存在：a.txt');
		expect(mechanicalEntry.map((e) => e.类型)).toEqual(["跑", "存在"]);
		expect(mechanicalEntry[0].主体).toBe('node -e ""');
	});

	it("残句不入机械条目：空主体、包含缺 :: 分隔均归人话句", () => {
		const { mechanicalEntry, plainSentence } = parseAcceptance("跑:\n包含: 只有路径没有子串\n存在: ok.txt");
		expect(mechanicalEntry.map((e) => e.主体)).toEqual(["ok.txt"]);
		expect(plainSentence).toEqual(["跑:", "包含: 只有路径没有子串"]);
	});

	it("无机械条目 = 无法机械判的前置事实（人话句全量保留）", () => {
		const { mechanicalEntry, plainSentence } = parseAcceptance("测试全绿\n人工看过即可");
		expect(mechanicalEntry).toEqual([]);
		expect(plainSentence).toHaveLength(2);
	});
});

describe("建卡前验收静态预检", () => {
	const projectRoot = resolve(".");

	it("合法机械项不要求未来产物已存在；正常人话句原样保留", () => {
		expect(() =>
			validateAcceptance(
				'跑: node scripts/未来检查.js\n跑: node -e "process.exit(0)"\n存在: 未来产物.txt\n包含: README.md :: PAO\n人工看质量',
				projectRoot,
			),
		).not.toThrow();
	});

	it("包含句的 HTML、反引号和模板插值按文本字面值放行", () => {
		expect(() =>
			validateAcceptance(
				`\u5305\u542B: index.html :: <p>
\u5305\u542B: README.md :: \`\u793A\u4F8B\`
\u5305\u542B: config.txt :: \${value}`,
				projectRoot,
			),
		).not.toThrow();
	});

	it("机械残句逐行指出条目和可直接替换的写法", () => {
		let error: unknown;
		try {
			validateAcceptance("人工看质量\n包含: README.md\n跑:", projectRoot);
		} catch (caught) {
			error = caught;
		}
		expect(error).toMatchObject({ code: "INVALID_CARD" });
		expect((error as Error).message).toContain("第 2 行「包含: README.md」");
		expect((error as Error).message).toContain("包含: 相对路径 :: 要查找的文本");
		expect((error as Error).message).toContain("第 3 行「跑:」");
	});

	it("绝对读路径、命令串联和重定向在建卡预检中被拒", () => {
		for (const acceptance of ["存在: C:\\项目\\产物.txt", "跑: node a.js && node b.js", "跑: node a.js > out.txt"]) {
			expect(() => validateAcceptance(acceptance, projectRoot), acceptance).toThrow(/INVALID_CARD/);
		}
	});
});

describe("句式安检门（§12.2 R16）：执行前拦形状不对的命令", () => {
	it("合法命令放行：相对路径的普通命令", () => {
		expect(checkCommandSafety('node -e "process.exit(0)"').过).toBe(true);
		expect(checkCommandSafety("npx vitest run test/pao").过).toBe(true);
	});

	it("禁 shell 串联符：& ; | > < ` 均拒（整串扫描，非仅命令头）", () => {
		for (const cmd of [
			'node -e "" && echo done',
			"echo a; echo b",
			"node build.ts | tee log",
			"node gen.ts > out.txt",
			"node x.ts < in.txt",
		]) {
			const r = checkCommandSafety(cmd);
			expect(r.过, cmd).toBe(false);
			expect(r.违规.join()).toContain("串联符");
		}
	});

	it("禁删除类动词：任何位置的 rm/del/rmdir/remove-item 等均拒（验收只查不改）", () => {
		for (const cmd of [
			"rm -rf build",
			"node cleanup.ts del temp.txt",
			"cmd /c del build",
			"powershell -c Remove-Item temp",
		]) {
			const r = checkCommandSafety(cmd);
			expect(r.过, cmd).toBe(false);
			expect(r.违规.join()).toContain("删除");
		}
	});

	it("禁绝对路径：盘符、~/、/ 开头（含 git-bash 式盘符路径）一律拒", () => {
		for (const cmd of ["node C:\\proj\\x.ts", "node ~/tools/x.ts", "node /c/proj/x.ts", "node /usr/bin/tool"]) {
			const r = checkCommandSafety(cmd);
			expect(r.过, cmd).toBe(false);
			expect(r.违规.join()).toContain("绝对路径");
		}
	});

	it("禁嵌套壳调用：cmd/powershell/pwsh/bash/sh/wsl 作命令头即拒（拦无串联符绕过）", () => {
		for (const cmd of [
			"cmd /c echo hi",
			"powershell -c Get-Date",
			"pwsh -Command gci",
			"bash -c ls",
			"sh -c ls",
			"wsl ls",
		]) {
			const r = checkCommandSafety(cmd);
			expect(r.过, cmd).toBe(false);
			expect(r.违规.join()).toContain("嵌套壳");
		}
	});

	it("禁 node_modules 路径：联接指回真目录，写它＝写真项目（R16 知情声明）", () => {
		const r = checkCommandSafety("node test/node_modules/probe.js");
		expect(r.过).toBe(false);
		expect(r.违规.join()).toContain("node_modules");
	});

	it("禁换行与命令替换：多步拆多条目", () => {
		expect(checkCommandSafety("node a.js\ndelete x").过).toBe(false);
		expect(checkCommandSafety("echo $(rm x)").过).toBe(false);
	});
});

describe("卡上派生验收记录解析与 §13 提交信息模板", () => {
	it("readLatestVerdict 取最近一次机械验收段；无记录返回 undefined", () => {
		expect(readLatestVerdict("## 回执 尝试1 2026-10-02 10:00\n- 结果: 完成")).toBeUndefined();
		const body = [
			"## 机械验收 2026-10-02 10:00",
			"- 结论: 未过",
			"- [存在] a.txt → 未过（文件不存在）",
			"",
			"## 机械验收 2026-10-02 11:00",
			"- 结论: 全过自动交付",
			"- [存在] a.txt → 过（文件存在）",
		].join("\n");
		const v = readLatestVerdict(body);
		expect(v?.结论).toBe("全过自动交付");
		expect(v?.时间).toBe("2026-10-02 11:00");
		expect(v?.原文).toContain("全过自动交付");
		expect(v?.原文).not.toContain("未过（文件不存在）");
	});

	it("提交信息模板＝卡NNNN 目标 · 状态 · 验收结果（§13 冻结口径）", () => {
		const card = {
			card_no: 5,
			frontmatter: fm({ goal: "巡库卡" }),
			body: "## 机械验收 2026-10-02 11:00\n- 结论: 全过自动交付",
		} as unknown as Parameters<typeof buildCommitMessage>[0];
		expect(buildCommitMessage(card)).toBe("卡0005 巡库卡 · delivered · 机械验收通过");
	});

	it("无验收记录与未过各自的槽位文案；未过卡不可交卷（交卷侧拒，文案在此对齐）", () => {
		const noVerdict = { card_no: 1, frontmatter: fm({ goal: "甲" }), body: "" } as unknown as Parameters<
			typeof buildCommitMessage
		>[0];
		const failed = {
			card_no: 2,
			frontmatter: fm({ goal: "乙", status: "in_progress" }),
			body: "## 机械验收 2026-10-02 09:00\n- 结论: 未过",
		} as unknown as Parameters<typeof buildCommitMessage>[0];
		expect(buildCommitMessage(noVerdict)).toBe("卡0001 甲 · delivered · 未机械验收");
		expect(buildCommitMessage(failed)).toBe("卡0002 乙 · in_progress · 机械验收未过");
	});
});
