/**
 * TUI 面板渲染器(美化·一批)单测:行分类纯函数、文本提取、注册齐全、
 * 组件渲染冒烟(假主题注入 [[token]] 标记,断言行级着色与「## 」剥离)。
 * 文案零改动的契约:渲染输入即各 render 函数原样输出。
 */
import { describe, expect, it } from "vitest";
import type { PanelTheme } from "../../src/pao/ui/panel-renderer.ts";
import {
	classifyPanelLine,
	extractPanelText,
	PANEL_LABELS,
	registerPaoPanels,
} from "../../src/pao/ui/panel-renderer.ts";

describe("classifyPanelLine 行分类", () => {
	it("标题行:── 包裹与 markdown H2 都算 header", () => {
		expect(classifyPanelLine("── 首跑清单（§16.1）──")).toBe("header");
		expect(classifyPanelLine("## 待认领（3）")).toBe("header");
		expect(classifyPanelLine("  ── 任务区 ──")).toBe("header");
	});

	it("警示行:⚠️/警示/挂起", () => {
		expect(classifyPanelLine("- 挂起工作流 2:人工门")).toBe("warn");
		expect(classifyPanelLine("- 内容部 ⚠️ 教训 1")).toBe("warn");
		expect(classifyPanelLine("警示:越界")).toBe("warn");
	});

	it("失败行:失败/✗;── 开头的降级行按标题先判(header)", () => {
		expect(classifyPanelLine("成功 2,失败 1")).toBe("error");
		expect(classifyPanelLine("── 任务区读取失败:路径不存在")).toBe("header");
	});

	it("整行括注→muted;普通行→body;标题先判不被失败字样抢走", () => {
		expect(classifyPanelLine("(机械摘要,被监督者不暂停)")).toBe("muted");
		expect(classifyPanelLine("（运行态,重启归零;卡文件状态与回执是真相,R25）")).toBe("muted");
		expect(classifyPanelLine("- 卡0001 做甲 [待审]")).toBe("body");
		// 顺序敏感:header 含「失败」仍按 header(如错误降级行不以 ── 开头,归 error)
		expect(classifyPanelLine("── 用量区（跨会话累计 · 用量账.jsonl）──")).toBe("header");
	});
});

describe("extractPanelText", () => {
	it("字符串原样;分块数组拼接 text 块", () => {
		expect(extractPanelText("abc")).toBe("abc");
		expect(
			extractPanelText([
				{ type: "text", text: "a" },
				{ type: "image", url: "x" } as never,
				{ type: "text", text: "b" },
			]),
		).toBe("a\nb");
		expect(extractPanelText(undefined)).toBe("");
	});
});

describe("registerPaoPanels", () => {
	const fakeTheme: PanelTheme = {
		fg: (token, text) => `[[${token}]]${text}`,
		bg: (token, text) => `[[bg:${token}]]${text}`,
	};

	it("PANEL_LABELS 每个 customType 都注册 renderer", () => {
		const registered = new Map<string, unknown>();
		registerPaoPanels({
			registerMessageRenderer: (customType, renderer) => registered.set(customType, renderer),
		});
		for (const customType of Object.keys(PANEL_LABELS)) {
			expect(registered.has(customType)).toBe(true);
		}
	});

	it("组件渲染冒烟:行级着色+标题加粗+「## 」剥离+空行保留", () => {
		const registered = new Map<string, (m: unknown, o: unknown, t: unknown) => unknown>();
		registerPaoPanels({
			registerMessageRenderer: (customType, renderer) => registered.set(customType, renderer as never),
		});
		const renderer = registered.get("pao-status") as
			| ((m: unknown, o: unknown, t: unknown) => { render(width: number): string[] })
			| undefined;
		expect(renderer).toBeDefined();
		const message = {
			content: [
				{
					type: "text",
					text: [
						"── 任务区（demo）──",
						"",
						"## 待认领（2）",
						"- 卡0001 做甲 [待审]",
						"- 挂起工作流 1:人工门待确认",
						"（运行态,重启归零）",
					].join("\n"),
				},
			],
		};
		const component = renderer?.(message, { expanded: false, outputPad: 1 }, fakeTheme);
		expect(component).toBeDefined();
		const lines = component?.render(120).join("\n") ?? "";
		// 标签行只含中文标签,不再带 pao 品牌字标（面板去品牌化批）
		expect(lines).toContain("状态");
		expect(lines).not.toContain("pao");
		expect(lines).not.toContain("[[mdLink]]"); // 字标专用的三色 token 不再出现在标签行
		// 标题行 accent 且保留原文
		expect(lines).toContain("[[accent]]── 任务区（demo）──");
		// markdown H2 剥 ## 后按 header 着色
		expect(lines).toContain("[[accent]]待认领（2）");
		expect(lines).not.toContain("## 待认领");
		// 正文 body、挂起 warn、括注 muted
		expect(lines).toContain("[[text]]- 卡0001 做甲 [待审]");
		expect(lines).toContain("[[warning]]- 挂起工作流 1:人工门待确认");
		expect(lines).toContain("[[muted]]（运行态,重启归零）");
	});
});
