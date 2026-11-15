/**
 * ui/glyphs 单测（TUI 美化·二批）：进度条边界、状态关键词命中与未命中、树形首尾。
 * 纯函数钉住——图形符号是模型面文本的一部分，改动即断言红。
 */
import { describe, expect, it } from "vitest";

import { bar, glyphFor, STATUS_GLYPH, treePrefix } from "../../src/pao/ui/glyphs.ts";

describe("bar 进度条", () => {
	it("零进度＝全空槽；满进度＝全填充", () => {
		expect(bar(0, 10)).toBe("──────────");
		expect(bar(10, 10)).toBe("━━━━━━━━━━");
	});

	it("比例填充：一半对一半", () => {
		expect(bar(5, 10)).toBe("━━━━━─────");
	});

	it("done 夹取 [0,total]：负数与超额都不越界", () => {
		expect(bar(-3, 10)).toBe("──────────");
		expect(bar(99, 10)).toBe("━━━━━━━━━━");
	});

	it("total<=0 返回全空槽（不除零）", () => {
		expect(bar(3, 0)).toBe("──────────");
		expect(bar(0, -1)).toBe("──────────");
	});

	it("宽度可自定义", () => {
		expect(bar(1, 4, 8)).toBe("━━──────");
	});
});

describe("STATUS_GLYPH 与 glyphFor", () => {
	it("关键词包含匹配：多字状态命中其中的关键词", () => {
		expect(glyphFor("已完成")).toBe("✅");
		expect(glyphFor("已交付")).toBe("✅");
		expect(glyphFor("运行中")).toBe("◐");
		expect(glyphFor("人工门待确认")).toBe("⏸");
		expect(glyphFor("流程挂起")).toBe("⏸");
		expect(glyphFor("就绪未派")).toBe("○");
		expect(glyphFor("回执失败")).toBe("✗");
		expect(glyphFor("在途 2 批")).toBe("◉");
	});

	it("无命中返回空串（调用方决定留白）", () => {
		expect(glyphFor("自定义阶段")).toBe("");
		expect(glyphFor("")).toBe("");
	});

	it("域内状态词全覆盖（审查补齐:工作流树行不再有裸行）", () => {
		expect(glyphFor("待认领")).toBe("○");
		expect(glyphFor("未落卡")).toBe("○");
		expect(glyphFor("no_card")).toBe("○"); // S10 投影单域英文后 v2 控制流无卡节点同符
		expect(glyphFor("派发")).toBe("◐");
		expect(glyphFor("待验收")).toBe("◐");
		expect(glyphFor("停审")).toBe("⏸");
		expect(glyphFor("待审")).toBe("○");
	});

	it("符号表映射钉住（防手滑改符）", () => {
		expect(STATUS_GLYPH.待确认).toBe("⏸");
		expect(STATUS_GLYPH.未接入).toBe("◌");
		expect(STATUS_GLYPH.警示).toBe("⚠");
	});
});

describe("treePrefix 树形连接符", () => {
	it("非末行 ├─，末行 └─", () => {
		expect(treePrefix(0, 3)).toBe("├─");
		expect(treePrefix(1, 3)).toBe("├─");
		expect(treePrefix(2, 3)).toBe("└─");
	});

	it("单元素列表直接是末行", () => {
		expect(treePrefix(0, 1)).toBe("└─");
	});
});
