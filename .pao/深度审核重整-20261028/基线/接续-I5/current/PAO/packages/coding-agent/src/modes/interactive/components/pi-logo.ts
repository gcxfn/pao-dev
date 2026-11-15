import { backgroundAnsi, foregroundAnsi, rgbColor, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

const CORAL = rgbColor(228, 138, 122);
const BLUE = rgbColor(79, 142, 179);
const YELLOW = rgbColor(234, 182, 93);
const RESET = "\x1b[0m";

/**
 * The pi logo: 4 cells wide and 2 lines tall. Each cell shows two square pixels with half blocks:
 *
 *   coral coral coral .
 *   blue  .     coral .
 *   blue  blue  .     yellow
 *   blue  .     .     yellow
 *
 * The brand colors stay fixed across themes; they follow the terminal's color mode.
 */
export function piLogoLines(): [string, string] {
	const mode = theme.getColorMode();
	const fg = (color: typeof CORAL) => foregroundAnsi(color, mode);
	// The fourth cell of the top line is empty, so it is padded to the same width as the bottom line.
	const top = `${fg(CORAL)}${backgroundAnsi(BLUE, mode)}▀${RESET}${fg(CORAL)}▀█${RESET} `;
	const bottom = `${fg(BLUE)}█▀${RESET} ${fg(YELLOW)}█${RESET}`;
	return [top, bottom];
}

/**
 * pao fork 品牌定案（2026-10-02）：启动头不用上游 pi 像素 logo，一律走文字字标，
 * 故本 fork 里恒为 false（连带关掉 pi logo 点击彩蛋动画）。上游语义保留在 piLogoLines。
 */
export function supportsPiLogo(): boolean {
	return false;
}

/** pao 字标："pao" 三字母沿用品牌三色（珊瑚/蓝/黄），与加载动画 p-a-o 帧同源。 */
export function piWordmark(): string {
	const mode = theme.getColorMode();
	return `${foregroundAnsi(CORAL, mode)}p${RESET}${foregroundAnsi(BLUE, mode)}a${RESET}${foregroundAnsi(YELLOW, mode)}o${RESET}`;
}

// ============================================================================
// pao 启动大横幅（用户拍板 2026-10-03：块状阴影字＋科幻渐变配色,刻意不用 pi 品牌三色;
// 下方小字 Personal Agent OS）。渲染位＝interactive-mode 启动头部（withLogo）。
// ============================================================================

/** 科幻三停靠点：青 → 靛 → 紫,横向扫过字身。 */
const BANNER_STOPS = [rgbColor(34, 211, 238), rgbColor(99, 102, 241), rgbColor(168, 85, 247)];

/**
 * 块状阴影字 PAO（6 行 ×27 列;空格是字距与阴影,着色时跳过;用户拍板保持大写）。
 * 字形取自 figlet「ANSI Shadow」字体逐字符拷贝,不做手绘改笔——2026-10-03 教训:
 * 手绘版 P 画成双碗读成 B、O 缺右竖读成 C,用户看到的是 "bac" 而不是 PAO。
 */
const PAO_BANNER_GLYPHS = [
	"██████╗   █████╗   ██████╗ ",
	"██╔══██╗ ██╔══██╗ ██╔═══██╗",
	"██████╔╝ ███████║ ██║   ██║",
	"██╔═══╝  ██╔══██║ ██║   ██║",
	"██║      ██║  ██║ ╚██████╔╝",
	"╚═╝      ╚═╝  ╚═╝  ╚═════╝ ",
];

/** 横向放大 ×2：每个字符（含空格）重复一次,27 列 → 54 列;垂直方向不放大。 */
const PAO_BANNER_SCALED = PAO_BANNER_GLYPHS.map((line) =>
	Array.from(line)
		.map((ch) => ch + ch)
		.join(""),
);

function lerpChannel(a: number, b: number, t: number): number {
	return Math.round(a + (b - a) * t);
}

/** t∈[0,1] 沿三停靠点取渐变色（0.5 处在靛蓝停靠点上）。 */
function bannerColorAt(t: number): ReturnType<typeof rgbColor> {
	const clamped = Math.max(0, Math.min(1, t));
	const [start, mid, end] = BANNER_STOPS;
	const local =
		clamped <= 0.5 ? { from: start, to: mid, k: clamped / 0.5 } : { from: mid, to: end, k: (clamped - 0.5) / 0.5 };
	return rgbColor(
		lerpChannel(local.from.r, local.to.r, local.k),
		lerpChannel(local.from.g, local.to.g, local.k),
		lerpChannel(local.from.b, local.to.b, local.k),
	);
}

/** 启动大横幅：每行逐字按横向位置取渐变色（空格不着色）,随终端色彩模式降级。 */
export function paoBannerLines(): string[] {
	const mode = theme.getColorMode();
	const width = PAO_BANNER_SCALED[0].length;
	return PAO_BANNER_SCALED.map((line) =>
		Array.from(line)
			.map((ch, i) => (ch === " " ? ch : `${foregroundAnsi(bannerColorAt(i / (width - 1)), mode)}${ch}${RESET}`))
			.join(""),
	);
}

/** 按可见宽（ANSI 转义不计宽）把各行前导补空格居中;终端放不下时 pad 0。逐行独立。 */
export function centerLines(lines: string[], width: number): string[] {
	return lines.map((line) => {
		const pad = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
		return " ".repeat(pad) + line;
	});
}

/** 横幅下小字：字距拉开的 Personal Agent OS（横幅起始色）＋暗色版本号。 */
export function paoBannerSubtitle(version: string): string {
	const mode = theme.getColorMode();
	const spaced = "Personal Agent OS".split("").join(" "); // 词间空格也拉开,天然成三格
	return `${foregroundAnsi(BANNER_STOPS[0], mode)}${spaced}${RESET}  ${theme.fg("dim", `v${version}`)}`;
}
