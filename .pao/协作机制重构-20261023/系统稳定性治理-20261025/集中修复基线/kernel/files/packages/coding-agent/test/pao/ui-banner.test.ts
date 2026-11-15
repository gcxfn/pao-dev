/**
 * 启动大横幅单测（命令统一批·放大居中批·ANSI Shadow 字形批）：块状阴影 PAO 字形横向 ×2
 * （27 列 → 54 列,字形原样只放大）、科幻渐变配色（青→靛→紫,刻意不含 pi 品牌
 * 三色的 RGB）、Personal Agent OS 小字与版本号、centerLines 居中纯函数。
 * 剥 ANSI 后验字形结构（宽度一致/含块字符）,带 ANSI 验渐变与品牌隔离。
 * 字形＝figlet「ANSI Shadow」逐字符拷贝（2026-10-03 手绘 bac 教训）,断言钉住
 * P 单碗收口与 O 双竖——正是手绘版读成 bac 的两处。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { centerLines, paoBannerLines, paoBannerSubtitle } from "../../src/modes/interactive/components/pi-logo.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark"); // 横幅随主题色彩模式降级,测试按 dark(truecolor)断言
});

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (line: string): string => line.replace(ANSI, "");

describe("pao 启动大横幅", () => {
	it("6 行块状字横向 ×2:剥 ANSI 后 54 列等宽且含块字符", () => {
		const lines = paoBannerLines();
		expect(lines).toHaveLength(6);
		const widths = new Set(lines.map((line) => stripAnsi(line).length));
		expect(widths.size).toBe(1);
		expect([...widths][0]).toBe(54); // 27 列 ×2（每字符含空格重复一次）
		const joined = lines.map(stripAnsi).join("\n");
		// ×2 后的块字符特征（原字形逐字符翻倍,故 ╗/╚ 等单线字符也成对出现）
		expect(joined).toContain("████████████╗╗");
		expect(joined).toContain("╚╚████████████");
		// 字形钉住（手绘 bac 教训）:P 单碗收口（██╔═══╝ 翻倍）、O 右竖在场（██║   ██║ 翻倍）、A 中横
		expect(joined).toContain("████╔╔══════╝╝"); // P 第 4 行 ██╔═══╝ 翻倍——碗收口,不是第二个碗
		expect(joined).toContain("║║      ████║║"); // O 第 3/4 行 ██║   ██║ 翻倍——右竖在场,不读成 C
		expect(joined).toContain("██████████████║║"); // A 第 3 行 ███████║ 翻倍
	});

	it("科幻渐变：非空字符带色彩转义,横向起点与终点颜色不同", () => {
		const lines = paoBannerLines();
		const first = lines[0];
		expect(first).toMatch(/\x1b\[38;2;\d+;\d+;\d+m|\x1b\[38;5;\d+m/);
		const colors = [...first.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map((m) => `${m[1]};${m[2]};${m[3]}`);
		// truecolor 终端下首尾颜色应不同（渐变存在）;256 色降级由 foregroundAnsi 保证,不强断
		if (colors.length >= 2) expect(colors[0]).not.toBe(colors[colors.length - 1]);
		// 空格不着色：剥掉转义后行内不应有孤立的转义残留粘在空格上
		expect(stripAnsi(first)).not.toMatch(/\x1b/);
	});

	it("品牌隔离：横幅与横幅小字不含 pi 品牌三色 RGB（珊瑚/蓝/黄）", () => {
		const banner = [...paoBannerLines(), paoBannerSubtitle("1.0.0")].join("\n");
		expect(banner).not.toContain("228;138;122"); // 珊瑚
		expect(banner).not.toContain("79;142;179"); // 品牌蓝
		expect(banner).not.toContain("234;182;93"); // 品牌黄
	});

	it("小字：Personal Agent OS 字距拉开,带版本号", () => {
		const subtitle = paoBannerSubtitle("1.2.3");
		expect(stripAnsi(subtitle)).toContain("P e r s o n a l   A g e n t   O S");
		expect(stripAnsi(subtitle)).toContain("v1.2.3");
	});
});

describe("centerLines 居中", () => {
	it("偶数宽度差:左右各一半", () => {
		expect(centerLines(["ab"], 10)).toEqual(["    ab"]);
		expect(centerLines(["ab", "abcd"], 10)).toEqual(["    ab", "   abcd"]);
	});

	it("奇数宽度差:左 pad 取 floor,整体偏左半列", () => {
		expect(centerLines(["ab"], 9)).toEqual(["   ab"]); // (9-2)/2=3.5 → 3
		expect(centerLines(["abc"], 10)).toEqual(["   abc"]); // 3.5 → 3
	});

	it("行宽 ≥ 终端宽:pad 为 0,原样返回", () => {
		expect(centerLines(["abcdef"], 6)).toEqual(["abcdef"]);
		expect(centerLines(["abcdef"], 3)).toEqual(["abcdef"]);
	});

	it("含 ANSI 转义的行按可见宽计 pad", () => {
		const line = "\x1b[38;2;34;211;238m██\x1b[0m"; // 可见宽 2
		const [out] = centerLines([line], 10);
		expect(out.startsWith(" ".repeat(4))).toBe(true);
		expect(stripAnsi(out)).toBe("    ██");
	});
});
