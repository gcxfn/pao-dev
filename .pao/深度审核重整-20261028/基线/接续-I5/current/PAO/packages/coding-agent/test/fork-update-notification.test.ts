import type { Component } from "@earendil-works/pi-tui";
import { beforeEach, expect, it, vi } from "vitest";
import type * as ConfigModule from "../src/config.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

const distribution = vi.hoisted(() => ({ appName: "pao" }));
vi.mock("../src/config.ts", async (original) => ({
	...(await original<typeof ConfigModule>()),
	get APP_NAME() {
		return distribution.appName;
	},
}));
beforeEach(() => initTheme(undefined, false));

function notification(appName: string, packages = false): string {
	distribution.appName = appName;
	const children: Component[] = [];
	const context = {
		chatContainer: { addChild: (child: Component) => children.push(child) },
		ui: { requestRender: vi.fn() },
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
	} as unknown as InteractiveMode;
	if (packages) InteractiveMode.prototype.showPackageUpdateNotification.call(context, ["fixture-extension"]);
	else
		InteractiveMode.prototype.showNewVersionNotification.call(context, {
			version: "9.0.0",
			note: "UPSTREAM_NOTE: Run pi update",
		});
	return children
		.flatMap((child) => child.render(250))
		.join("\n")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

it("PAO directs kernel and extension notices to fork maintenance without upstream update instructions", () => {
	for (const packages of [false, true]) {
		const text = notification("pao", packages);
		expect(text).toContain("plans/持续维护与升级.md");
		expect(text).toContain("rebase");
		expect(text).toContain("勿运行 pao update");
		expect(text).not.toContain("Run pao update");
		expect(text).not.toContain("UPSTREAM_NOTE");
	}
});

it("official Pi retains update commands and release notes", () => {
	const text = notification("pi");
	expect(text).toContain("New version 9.0.0 is available. Run pi update");
	expect(text).toContain("UPSTREAM_NOTE: Run pi update");
	expect(notification("pi", true)).toContain("Package updates are available. Run pi update --extensions");
});
