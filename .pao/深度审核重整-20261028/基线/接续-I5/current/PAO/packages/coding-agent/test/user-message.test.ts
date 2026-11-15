import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

describe("UserMessageComponent", () => {
	test("frames user text while retaining shell integration markers", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(5);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(stripAnsi(lines[0])).toMatch(/^┌─+┐$/);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[2]).toContain("hello");
		expect(lines[4].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(stripAnsi(lines[4])).toMatch(/^└─+┘$/);
	});

	test("chains Markdown transformers with user message context", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new UserMessageComponent("The input is $x^2$.", undefined, 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "user", isStreaming: false, availableWidth: 76 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The input is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("reapplies Markdown transformers when invalidated", () => {
		initTheme("dark");
		let suffix = "before";
		const component = new UserMessageComponent("Message", undefined, 1, [(markdown) => `${markdown} ${suffix}`]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message before");

		suffix = "after";
		component.invalidate();

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message after");
	});

	test("preserves long Chinese multiline text while resizing and scrolling", () => {
		initTheme("dark");
		const text = `${"中文用户约束".repeat(15)}\n第二行必须保留\n末行`;
		const component = new UserMessageComponent(text);
		for (const width of [80, 20, 8, 40]) {
			const lines = component.render(width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			const content = stripAnsi(lines.join("\n")).replace(/[┌┐└┘│─\s]/g, "");
			expect(content).toBe(text.replace(/\s/g, ""));
			expect(lines.slice(2, 5)).toHaveLength(3);
		}
	});
});
