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

it.each(["success", "failed"])("上一尝试 %s 且执行根相符时延续原会话，映射和尝试仍独立", (status) => {
	const root = mkdtempSync(join(tmpdir(), "pao-session-resume-"));
	dirs.push(root);
	const common = { 任务根: root, 卡路径: join(root, "卡0001.md"), executionRoot: root };
	const first = createWorkerSessionBridge({ ...common, 尝试: 1, 执行标识: randomUUID() });
	const session = join(first.会话目录, `2026-10-23_${first.执行标识}.jsonl`);
	writeFileSync(session, `${JSON.stringify({ type: "session", id: first.执行标识, cwd: root })}\n`);
	first.record(status, { 会话路径: session });
	const original = readFileSync(first.映射路径, "utf8");
	const next = createWorkerSessionBridge({ ...common, 尝试: 2, 执行标识: randomUUID() });
	expect(next.延续会话).toBe(session);
	expect(next.sessionPath()).toBe(session);
	expect(next.映射路径).not.toBe(first.映射路径);
	expect(readFileSync(first.映射路径, "utf8")).toBe(original);
	const args = buildArgs({ 卡号: "0001", 提示词: "重新核对当前任务与权限后返修", 延续会话: next.延续会话 });
	expect(args).toContain("--session");
	expect(args).not.toContain("--session-id");
	expect(args).not.toContain("--no-session");
});

it.each(["运行中", "unknown", "停止未确认", "canceled"])("上一尝试为 %s 时不自动续用会话", (status) => {
	const root = mkdtempSync(join(tmpdir(), "pao-session-refuse-"));
	dirs.push(root);
	const common = { 任务根: root, 卡路径: join(root, "卡0001.md"), executionRoot: root };
	const first = createWorkerSessionBridge({ ...common, 尝试: 1, 执行标识: randomUUID() });
	first.record(status, { 会话路径: join(first.会话目录, "不存在.jsonl") });
	expect(createWorkerSessionBridge({ ...common, 尝试: 2, 执行标识: randomUUID() }).延续会话).toBeUndefined();
});

it("换执行根不延续，互斥会话参数拒绝", () => {
	const root = mkdtempSync(join(tmpdir(), "pao-session-root-"));
	dirs.push(root);
	const common = { 任务根: root, 卡路径: join(root, "卡0001.md") };
	const first = createWorkerSessionBridge({ ...common, executionRoot: root, 尝试: 1, 执行标识: randomUUID() });
	first.record("success", { 会话路径: join(first.会话目录, "不存在.jsonl") });
	expect(
		createWorkerSessionBridge({ ...common, executionRoot: join(root, "other"), 尝试: 2, 执行标识: randomUUID() })
			.延续会话,
	).toBeUndefined();
	expect(() => buildArgs({ 卡号: "0001", 提示词: "任务", 会话标识: "new", 延续会话: "old" })).toThrow("不能同时");
});

it("原会话文件丢失时新开并记录原因，不伪造延续", () => {
	const root = mkdtempSync(join(tmpdir(), "pao-session-missing-"));
	dirs.push(root);
	const common = { 任务根: root, 卡路径: join(root, "卡0001.md"), executionRoot: root };
	const first = createWorkerSessionBridge({ ...common, 尝试: 1, 执行标识: randomUUID() });
	first.record("success", { 会话路径: join(first.会话目录, "missing.jsonl") });
	const next = createWorkerSessionBridge({ ...common, 尝试: 2, 执行标识: randomUUID() });
	expect(next.延续会话).toBeUndefined();
	expect(JSON.parse(readFileSync(next.映射路径, "utf8")).会话恢复说明[0]).toContain("已不存在");
});
