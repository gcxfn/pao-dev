import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildPendingDetails, checkPreflight } from "../../src/pao/preflight/index.ts";

vi.mock("node:child_process", { spy: true });

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
	const root = mkdtempSync(join(tmpdir(), "pao-preflight-"));
	roots.push(root);
	const project = join(root, "项目");
	const paoHome = join(root, "现场");
	mkdirSync(project);
	mkdirSync(join(paoHome, "pao配置"), { recursive: true });
	writeFileSync(
		join(paoHome, "pao配置", "档位.json"),
		JSON.stringify({ 档位: [{ 名: "快", provider: "offline", model: "fake", thinkingLevel: "off" }] }),
	);
	return { root, project, paoHome };
}
function snapshot(root: string): string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		return entry.isDirectory()
			? [path, ...snapshot(path)]
			: [`${path}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`];
	});
}

function texts(result: ReturnType<typeof checkPreflight>): string {
	return result.items
		.map((item) => `${item.subject}\n${item.reason}\n${item.suggestion}\n${item.evidence ?? ""}`)
		.join("\n");
}

it("只读预检不落盘、不创建进程、不发网络或模型请求", () => {
	const input = setup();
	const before = snapshot(input.root);
	const spawn = vi.spyOn(childProcess, "spawn");
	const exec = vi.spyOn(childProcess, "execFile");
	const spawnSync = vi.spyOn(childProcess, "spawnSync");
	const fetch = vi.spyOn(globalThis, "fetch");
	const result = checkPreflight({ ...input, budget: { turns: 1 }, tier: "快" });
	expect(result.canStart).toBe(true);
	expect(result.items.some((item) => item.subject === "可选记忆" && item.level === "警告")).toBe(true);
	expect(snapshot(input.root)).toEqual(before);
	expect(spawn).not.toHaveBeenCalled();
	expect(exec).not.toHaveBeenCalled();
	expect(spawnSync).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
});

it("缺必需参数、部门、技能、配置及零预算均阻断", () => {
	const input = setup();
	const result = checkPreflight({
		...input,
		budget: { turns: 0 },
		tier: "不存在",
		departments: ["开发"],
		skills: ["缺技能"],
		requiredParameters: ["目标"],
		requiredFiles: [join(input.root, "不存在.json")],
	});
	expect(result.canStart).toBe(false);
	expect(result.items.filter((item) => item.level === "阻止启动").map((item) => item.subject)).toEqual(
		expect.arrayContaining(["预算", "档位", "部门", "技能", "参数", "必需配置"]),
	);
});

it("已有写锁显示可排队，可选记忆损坏降级不误阻断", () => {
	const input = setup();
	mkdirSync(join(input.project, ".pao", "项目锁.lock"), { recursive: true });
	writeFileSync(join(input.paoHome, "pao配置", "记忆供应商.json"), "bad");
	const before = snapshot(input.root);
	const result = checkPreflight(input);
	expect(result.canStart).toBe(true);
	expect(result.items.some((item) => item.level === "可排队")).toBe(true);
	expect(result.items.some((item) => item.subject === "可选记忆" && item.level === "警告")).toBe(true);
	expect(snapshot(input.root)).toEqual(before);
});

it("配置变更后重新检查能发现，预检不缓存通行证", () => {
	const input = setup();
	expect(checkPreflight(input).canStart).toBe(true);
	writeFileSync(join(input.paoHome, "pao配置", "档位.json"), "{}");
	expect(checkPreflight(input).canStart).toBe(false);
});

it("共享额度耗尽阻断，并发占满可等待且不清账", () => {
	const input = setup();
	const path = join(input.root, "额度.json");
	const env = { PAO_REQUEST_BUDGET: JSON.stringify({ path, requests: 2, concurrency: 1 }) };
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			requests: 2,
			concurrency: 1,
			used: 1,
			active: [{ token: "test", pid: process.pid }],
		}),
	);
	const before = readFileSync(path, "utf8");
	expect(
		checkPreflight(input, env).items.some((item) => item.subject === "共享请求额度" && item.level === "可排队"),
	).toBe(true);
	expect(readFileSync(path, "utf8")).toBe(before);
	writeFileSync(path, JSON.stringify({ version: 1, requests: 2, concurrency: 1, used: 2, active: [] }));
	expect(checkPreflight(input, env).canStart).toBe(false);
});

it("终端待处理保留坏卡错误而不假报空队列", () => {
	const input = setup();
	const cards = join(input.project, ".pao", "卡");
	mkdirSync(cards, { recursive: true });
	writeFileSync(join(cards, "卡0001-坏卡.md"), "invalid");
	const before = snapshot(input.root);
	expect(buildPendingDetails(input.paoHome, input.project)).toContain("卡读取失败，未当作空列表");
	expect(snapshot(input.root)).toEqual(before);
});

it("PAO_HOME 不可用时显示绝对根、缺失路径与初始化建议；无部门本身不阻断", () => {
	const input = setup();
	const wrongRoot = join(input.root, "另一个现场");
	const result = checkPreflight({ ...input, paoHome: wrongRoot });
	const report = texts(result);
	expect(result.items.find((item) => item.subject === "PAO_HOME")).toMatchObject({
		level: "阻止启动",
		reason: expect.stringContaining(wrongRoot),
		suggestion: expect.stringContaining("PAO_HOME"),
		evidence: wrongRoot,
	});
	expect(report).toContain(join(wrongRoot, "部门", "注册表.md"));
	expect(report).toContain(join(wrongRoot, "pao配置", "档位.json"));

	const freshRoot = join(input.root, "空现场");
	mkdirSync(freshRoot);
	const fresh = checkPreflight({ ...input, paoHome: freshRoot });
	expect(fresh.items.some((item) => item.subject === "PAO_HOME")).toBe(false);
	const registry = fresh.items.find((item) => item.subject === "部门注册");
	expect(registry).toMatchObject({
		level: "警告",
		reason: expect.stringContaining("尚未建部"),
		suggestion: expect.stringContaining("可继续初始化"),
		evidence: join(freshRoot, "部门", "注册表.md"),
	});
});

it("部门注册表 IO 错误保留实际错误，不误报缺少注册表", () => {
	const input = setup();
	mkdirSync(join(input.paoHome, "部门", "注册表.md"), { recursive: true });
	const result = checkPreflight({ ...input, departments: ["开发"] });
	const item = result.items.find((candidate) => candidate.subject === "部门");
	expect(item).toMatchObject({
		level: "阻止启动",
		reason: expect.stringContaining("所需部门无法核验"),
		suggestion: expect.not.stringContaining("未发现部门注册表"),
		evidence: join(input.paoHome, "部门", "注册表.md"),
	});
});
