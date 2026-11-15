/**
 * PAO 结构化图形符号（TUI 美化·二批）：给各 render 函数的文本本体加
 * 进度条／状态符号等纯文本图形——模型面与终端同源（文本即渲染）。
 * 纯函数零依赖：不读盘、不依赖主题，任何渲染端（工具结果/面板/TUI）直接复用。
 * 风格参照 oh-my-pi：进度条填充 ━ 空槽 ─；状态点 ●◐○✅⏸✗⚠；树形 ├─ └─。
 */

/**
 * 进度条：done/total 按比例填充 ━，剩余空槽 ─。
 * total<=0 视为无进度可显，返回全空槽；done 夹取到 [0,total]，永不越界。
 */
export function bar(done: number, total: number, width = 10): string {
	if (total <= 0) return "─".repeat(width);
	const clamped = Math.max(0, Math.min(done, total));
	const filled = Math.min(width, Math.max(0, Math.round((clamped / total) * width)));
	return "━".repeat(filled) + "─".repeat(width - filled);
}

/**
 * 状态符号表：键＝关键词（包含匹配的锚点），值＝图形符号。
 * 同义关键词并列（完成/交付 同符），语义序：好→✅✓、动→◐◉、门→⏸、待→○、坏→✗⚠、空→◌。
 */
export const STATUS_GLYPH: Record<string, string> = {
	完成: "✅",
	交付: "✅",
	completed: "✅",
	delivered: "✅",
	进行中: "◐",
	运行: "◐",
	in_progress: "◐",
	running: "◐",
	派发: "◐",
	待验收: "◐",
	人工门: "⏸",
	挂起: "⏸",
	待确认: "⏸",
	停审: "⏸",
	待办: "○",
	待解锁: "○",
	就绪: "○",
	待认领: "○",
	unclaimed: "○",
	待审: "○",
	未落卡: "○",
	no_card: "○",
	失败: "✗",
	failed: "✗",
	警示: "⚠",
	成功: "✓",
	在途: "◉",
	空闲: "○",
	未接入: "◌",
};

/**
 * 状态 → 图形符号：按关键词包含匹配（如「人工门待确认」命中「人工门」）。
 * 无命中返回空串——调用方自行决定留白还是回落符号。
 */
export function glyphFor(status: string): string {
	for (const [keyword, glyph] of Object.entries(STATUS_GLYPH)) {
		if (status.includes(keyword)) return glyph;
	}
	return "";
}

/** 树形连接符：列表首尾——非末行 ├─，末行 └─（count<=0 兜底按末行）。 */
export function treePrefix(index: number, count: number): string {
	return index < count - 1 ? "├─" : "└─";
}
