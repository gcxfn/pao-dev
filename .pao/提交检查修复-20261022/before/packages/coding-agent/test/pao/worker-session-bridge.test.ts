import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildArgs } from "../../src/pao/worker/runner.ts";
import { createWorkerSessionBridge } from "../../src/pao/worker/session-bridge.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("同号不同项目和重试保留独立映射，取消不覆盖历史", () => {
	const root = mkdtempSync(join(tmpdir(), "pao-session-bridge-"));
	dirs.push(root);
	const first = createWorkerSessionBridge({
		项目根: root,
		卡路径: join(root, ".pao/卡/卡0001.md"),
		尝试: 1,
		执行标识: randomUUID(),
	});
	first.record("运行中", { pid: 123 });
	first.record("取消");
	const before = readFileSync(first.映射路径, "utf8");
	const next = createWorkerSessionBridge({
		项目根: root,
		卡路径: join(root, ".pao/卡/卡0001.md"),
		尝试: 2,
		执行标识: randomUUID(),
	});
	expect(next.映射路径).not.toBe(first.映射路径);
	expect(readFileSync(first.映射路径, "utf8")).toBe(before);
	expect(
		before
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).状态),
	).toEqual(["启动", "运行中", "取消"]);
	expect(first.sessionPath()).toBeUndefined();
	const file = join(first.会话目录, `2026-10-04_${first.执行标识}.jsonl`);
	writeFileSync(file, "模拟会话内容\n");
	expect(first.sessionPath()).toBe(file);
	expect(next.sessionPath()).toBeUndefined();
});

it("正式持久会话参数不带 no-session，重复执行身份拒绝覆盖", () => {
	const root = mkdtempSync(join(tmpdir(), "pao-session-bridge-"));
	dirs.push(root);
	const input = { 项目根: root, 卡路径: join(root, "卡0001.md"), 尝试: 1, 执行标识: randomUUID() };
	const bridge = createWorkerSessionBridge(input);
	expect(() => createWorkerSessionBridge(input)).toThrow();
	const args = buildArgs({ 卡号: "0001", 提示词: "目标", 会话标识: bridge.执行标识, 会话目录: bridge.会话目录 });
	expect(args).not.toContain("--no-session");
	expect(args).toContain("--session-id");
	expect(args).toContain(bridge.执行标识);
});
