/**
 * pao 品牌视觉常量(TUI 美化·一批)。三色与 pi-logo.ts 字标同源
 * (珊瑚 228,138,122 / 蓝 79,142,179 / 黄 234,182,93);此处内嵌 ANSI 真彩码,
 * 供 setWorkingIndicator 帧使用(结束用 \x1b[39m 只复位前景色,不炸外层着色)。
 */

const fg256 = (r: number, g: number, b: number, ch: string) => `\x1b[38;2;${r};${g};${b}m${ch}\x1b[39m`;

/** 加载动画帧:p/a/o 各持品牌一色 */
export const BRAND_SPINNER_FRAMES: readonly string[] = [
	fg256(228, 138, 122, "p"),
	fg256(79, 142, 179, "a"),
	fg256(234, 182, 93, "o"),
];

/** 帧间隔(与原 p-a-o 帧一致) */
export const BRAND_SPINNER_INTERVAL_MS = 200;
