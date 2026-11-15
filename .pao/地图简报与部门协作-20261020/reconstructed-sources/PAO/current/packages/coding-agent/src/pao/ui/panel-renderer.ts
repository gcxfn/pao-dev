/**
 * PAO 面板渲染器(TUI 美化·一批):给 5+1 个 customType 消息(pao-status/queue/
 * workflow/firstrun/dispatch/panorama)注册统一的彩色 TUI 组件,替代默认渲染
 * (紫色底盒+单色 markdown)。文案一字不改——模型面与测试断言零影响,只有 TUI
 * 展示层变。行级着色规则见 classifyPanelLine;renderer 抛错时上游
 * CustomMessageComponent 自动回落默认渲染,天然安全网。
 */
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";

import type { MessageRenderer } from "../../core/extensions/types.ts";

/** 结构化最小主题面(renderer 实参即可满足;避免 pao 层反向依赖 modes/interactive) */
export interface PanelTheme {
	fg(token: string, text: string): string;
	bg(token: string, text: string): string;
}

/** 行分类:着色 token 的唯一依据(纯函数,单测钉住) */
export type PanelLineKind = "header" | "warn" | "error" | "muted" | "body";

/** PAO 输出的行级分类规则:标题行(──/## )→accent;⚠️/警示/挂起→warning;
 * 失败/✗→error;整行括注→muted;其余→text。顺序敏感:标题先判。 */
export function classifyPanelLine(line: string): PanelLineKind {
	const s = line.trimStart();
	if (s.startsWith("──") || s.startsWith("## ")) return "header";
	if (/⚠️|警示|挂起/.test(line)) return "warn";
	if (/失败|✗/.test(line)) return "error";
	if (/^[（(].*[）)]$/.test(s)) return "muted";
	return "body";
}

const KIND_TOKEN: Record<PanelLineKind, string> = {
	header: "accent",
	warn: "warning",
	error: "error",
	muted: "muted",
	body: "text",
};

/** 单行着色:分类→token;「## 」标记剥掉(不走 markdown 渲染);标题行加粗 */
export function colorizePanelLine(line: string, theme: PanelTheme): string {
	const kind = classifyPanelLine(line);
	const display = line.replace(/^## /, "");
	const colored = theme.fg(KIND_TOKEN[kind], display);
	return kind === "header" ? `\x1b[1m${colored}\x1b[22m` : colored;
}

/** 从 custom 消息 content 提取纯文本(与上游 CustomMessageComponent 同口径) */
export function extractPanelText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c): c is { type: "text"; text: string } => c?.type === "text")
			.map((c) => c.text)
			.join("\n");
	}
	return "";
}

/** 面板组件:Spacer + 标签行 + Box(1,1) 行级着色(空行保留为空行) */
class PaoPanelComponent extends Container {
	constructor(options: { label: string; text: string; theme: PanelTheme }) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(new Text(options.label, 0, 0));
		const box = new Box(1, 1, (t: string) => options.theme.bg("customMessageBg", t));
		for (const raw of options.text.split("\n")) {
			if (raw.trim() === "") {
				box.addChild(new Spacer(1));
				continue;
			}
			box.addChild(new Text(colorizePanelLine(raw, options.theme), 0, 0));
		}
		this.addChild(box);
	}
}

/** 面板渲染注册入口:pi.registerMessageRenderer 逐 customType 挂面板组件 */
export function registerPaoPanels(pi: {
	registerMessageRenderer: (customType: string, renderer: MessageRenderer) => void;
}): void {
	for (const [customType, label] of Object.entries(PANEL_LABELS)) {
		pi.registerMessageRenderer(
			customType,
			(message, _options, theme) =>
				new PaoPanelComponent({
					label,
					text: extractPanelText((message as { content?: unknown }).content),
					theme: theme as unknown as PanelTheme,
				}),
		);
	}
}

/** customType → 面板标签(全景随三批接线;面板随命令统一批) */
export const PANEL_LABELS: Record<string, string> = {
	"pao-status": "状态",
	"pao-queue": "队列",
	"pao-workflow": "工作流",
	"pao-firstrun": "首跑清单",
	"pao-dispatch": "派单",
	"pao-panorama": "全景",
	"pao-panel": "面板",
};
