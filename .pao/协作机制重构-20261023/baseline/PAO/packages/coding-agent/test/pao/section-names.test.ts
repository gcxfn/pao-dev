/**
 * pao 系统提示段名回归钉（2026-10-03 真机翻车后立）：
 * pi 核心对 section 名有严格正则(^[a-z][a-z0-9_-]*$,system-prompt.ts)——中文段名
 * 「pao-主控记忆」让 buildSystemPrompt 抛错＝整回合失败。此前各模块测试只 mock
 * sections 对象、从未过真校验,故 1045 例全绿仍真机炸。
 * 本文件把 pao 全部注入段名过一遍真 buildSystemPromptSections:段名再出非 ASCII
 * 或大写,这里先红,不等到真机。
 */
import { describe, expect, it } from "vitest";

import { buildSystemPromptSections } from "../../src/core/system-prompt.ts";
import { REGISTRY_SECTION_NAME } from "../../src/pao/dept/index.ts";
import { FANOUT_BACKGROUND_SECTION } from "../../src/pao/fanout/index.ts";
import { HOST_NOTICE_SECTION } from "../../src/pao/host/tools.ts";
import { AUTO_RECALL_SECTION, RESIDENT_MEMORY_SECTION } from "../../src/pao/memory/resident.ts";
import { WORKFLOW_REVIEW_SECTION } from "../../src/pao/workflow/review.ts";

/** pao 会在 before_agent_start 写进 systemPromptOptions.sections 的全部段名 */
const ALL_SECTIONS = [
	REGISTRY_SECTION_NAME,
	FANOUT_BACKGROUND_SECTION,
	HOST_NOTICE_SECTION,
	RESIDENT_MEMORY_SECTION,
	AUTO_RECALL_SECTION,
	WORKFLOW_REVIEW_SECTION,
] as const;

describe("系统提示段名:pao 全部注入段过真校验(pi 正则)", () => {
	it("六个段名各过一遍真 buildSystemPromptSections,不抛错", () => {
		expect(ALL_SECTIONS).toHaveLength(6);
		for (const name of ALL_SECTIONS) {
			expect(() =>
				buildSystemPromptSections({ cwd: process.cwd(), sections: { [name]: "内容(标题在内容里,不在段名)" } }),
			).not.toThrow();
		}
	});

	it("真校验确实会拦中文段名(反向钉:删了校验或正则放松时这里红)", () => {
		expect(() => buildSystemPromptSections({ cwd: process.cwd(), sections: { "pao-主控记忆": "x" } })).toThrow(
			/Invalid system prompt section name/,
		);
	});

	it("六个段名互不相同且非空", () => {
		expect(new Set(ALL_SECTIONS).size).toBe(ALL_SECTIONS.length);
		for (const name of ALL_SECTIONS) expect(name.length).toBeGreaterThan(0);
	});
});
