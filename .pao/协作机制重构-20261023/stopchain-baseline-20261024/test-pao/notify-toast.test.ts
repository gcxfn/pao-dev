/**
 * §23 toast 单测：脚本纯文本经 env 传参（无拼接注入面）、开关关/非 win32 零 spawn、
 * spawner 注入面收 title/body、close 即 resolve、超时 kill 兜底；
 * toastEnabled 各态（缺省开/显式 false 关/坏 JSON 开）。
 * 真实 Windows 通知弹出属手验面（通知中心受系统设置影响）,不进自动化。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { toastEnabled } from "../../src/pao/host/config.ts";
import { buildToastScript, sendToast, type ToastSpawner } from "../../src/pao/notify/toast.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-toast-"));
	tempDirs.push(dir);
	return dir;
}

describe("buildToastScript", () => {
	it("固定脚本文本:读 env 变量,无标题/正文字符串拼接(零注入面)", () => {
		const script = buildToastScript();
		expect(script).toContain("$env:PAO_TOAST_TITLE");
		expect(script).toContain("$env:PAO_TOAST_BODY");
		expect(script).toContain("ToastNotificationManager");
		expect(script).not.toContain("${");
	});
});

describe("sendToast", () => {
	it("开关关:零 spawn 直接 resolve", async () => {
		const spawns: unknown[][] = [];
		const spawner: ToastSpawner = (...args) => {
			spawns.push(args);
			return { on: () => {}, kill: () => {} };
		};
		await sendToast("t", "b", { enabled: false, spawner });
		expect(spawns).toHaveLength(0);
	});

	it("spawn 收 title/body 与脚本;close 即 resolve", async () => {
		const spawns: { title: string; body: string; script: string }[] = [];
		let fireClose: (() => void) | undefined;
		const spawner: ToastSpawner = (title, body, script) => {
			spawns.push({ title, body, script });
			return {
				on: (event, handler) => {
					if (event === "close") fireClose = handler;
				},
				kill: () => {},
			};
		};
		const promise = sendToast("标题", "正文", { spawner, timeoutMs: 5_000 });
		expect(spawns).toHaveLength(1);
		expect(spawns[0]).toMatchObject({ title: "标题", body: "正文" });
		expect(spawns[0].script).toContain("PAO_TOAST_TITLE");
		fireClose?.();
		await promise; // close 后 resolve,不再等 5s
	});

	it("超时兜底:3s(测试缩到 20ms)未 close 则 kill 并 resolve", async () => {
		const killed: boolean[] = [];
		const spawner: ToastSpawner = () => ({
			on: () => {},
			kill: () => killed.push(true),
		});
		const start = Date.now();
		await sendToast("t", "b", { spawner, timeoutMs: 20 });
		expect(Date.now() - start).toBeLessThan(2_000);
		expect(killed).toEqual([true]);
	});
});

describe("toastEnabled·落盘各态", () => {
	function write(warmth: string): string {
		const home = tempDir();
		writeFileSync(join(home, "保温.json"), warmth, "utf8");
		// toastEnabled 读 <home>/pao配置/保温.json——把文件放对位置
		const dir = join(home, "pao配置");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "保温.json"), warmth, "utf8");
		return home;
	}

	it("显式 false→关;true/缺键/坏 JSON→开", () => {
		expect(toastEnabled(write('{ "toast 通知": false }'))).toBe(false);
		expect(toastEnabled(write('{ "toast 通知": true }'))).toBe(true);
		expect(toastEnabled(write("{ }"))).toBe(true);
		expect(toastEnabled(write("{ 坏"))).toBe(true);
	});
});
