import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { recipeFingerprint } from "../../src/pao/dept/render.ts";
import { createDept } from "../../src/pao/dept/scaffold.ts";
import {
	handoffFreshnessMs,
	handoffPagePath,
	judgeHandoffTimeliness,
	richHandoffPointerText,
	writeHandoffPage,
} from "../../src/pao/host/handoff.ts";

/**
 * S3 短交接恢复门:落交接页头部带配方指纹;判定交接时效 纯函数 fail-closed
 * (缺时间/不可解析/缺指纹/指纹不匹配/超保鲜窗 任一命中即降级「仅历史参考,不授权续跑」);
 * 富交接指针文本 文件不在返回 undefined 同旧语义,在则指针＋时效结论。
 * 恢复唯一入口是主控派新卡——本门只降级参考价值,不是执行闸门。
 */

const tempDirs: string[] = [];

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	} catch {
		// 残留目录交给系统临时目录清理,不影响测试结果
	}
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) cleanupDir(dir);
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pao-handoff-gate-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

/** 造假部门结构:只落 部门/<名>/配方.md(本文件只测交接门,不测建部正门) */
function writeRecipe(home: string, dept = "前端"): void {
	mkdirSync(join(home, "部门", dept), { recursive: true });
	writeFileSync(join(home, "部门", dept, "配方.md"), `# 配方:${dept}\n`, "utf8");
}

/** 造一页标准交接页文本(与 落交接页 头部同款格式) */
function makePageText(options: { 时间?: string; 指纹?: string; 去时间?: boolean; 去指纹?: boolean }): string {
	const header = [
		"<!-- 部长会话散场交接",
		"|部门:前端",
		"|项目根:D:/demo",
		options.去时间 ? "" : `|最近服务:${options.时间 ?? "2026-10-03 09:00:00"}`,
		options.去指纹 ? "" : `|配方指纹:${options.指纹 ?? "a".repeat(40)}`,
		" -->",
	].join("");
	return `${header}\n# 交接页\n`;
}

const now = new Date("2026-10-03T10:00:00Z");

describe("判定交接时效:纯函数 fail-closed", () => {
	it("正例:新鲜＋指纹符 → 新鲜可参考,原因空", () => {
		const judgement = judgeHandoffTimeliness(makePageText({ 时间: "2026-10-03 09:00:00" }), {
			现在: now,
			当前指纹: "a".repeat(40),
		});
		expect(judgement.新鲜).toBe(true);
		expect(judgement.原因).toEqual([]);
	});

	it("负例:超保鲜窗(默认 24 小时)→ 降级,原因含超窗", () => {
		const judgement = judgeHandoffTimeliness(makePageText({ 时间: "2026-10-01 09:00:00" }), {
			现在: now,
			当前指纹: "a".repeat(40),
		});
		expect(judgement.新鲜).toBe(false);
		expect(judgement.原因.join(";")).toContain("超过保鲜窗");
	});

	it("负例:指纹不匹配——页有指纹当前不同 / 当前无配方而页有 / 当前有而页上「无」均降级", () => {
		const page = makePageText({ 指纹: "a".repeat(40) });
		expect(judgeHandoffTimeliness(page, { 现在: now, 当前指纹: "b".repeat(40) }).原因.join(";")).toContain(
			"配方指纹不匹配",
		);
		expect(judgeHandoffTimeliness(page, { 现在: now, 当前指纹: null }).原因.join(";")).toContain("配方指纹不匹配");
		expect(judgeHandoffTimeliness(makePageText({ 指纹: "无" }), { 现在: now, 当前指纹: "a".repeat(40) }).新鲜).toBe(
			false,
		);
	});

	it("负例:缺最近服务时间 / 时间不可解析 → 降级", () => {
		const missingTime = judgeHandoffTimeliness(makePageText({ 去时间: true }), {
			现在: now,
			当前指纹: "a".repeat(40),
		});
		expect(missingTime.新鲜).toBe(false);
		expect(missingTime.原因.join(";")).toContain("缺最近服务时间");
		const unparseable = judgeHandoffTimeliness(makePageText({ 时间: "三天前" }), {
			现在: now,
			当前指纹: "a".repeat(40),
		});
		expect(unparseable.新鲜).toBe(false);
		expect(unparseable.原因.join(";")).toContain("不可解析");
	});

	it("负例:缺配方指纹字段 / 头部注释整体缺失 → 降级", () => {
		const missingFingerprint = judgeHandoffTimeliness(makePageText({ 去指纹: true }), {
			现在: now,
			当前指纹: "a".repeat(40),
		});
		expect(missingFingerprint.新鲜).toBe(false);
		expect(missingFingerprint.原因.join(";")).toContain("缺配方指纹字段");
		const noHeader = judgeHandoffTimeliness("# 交接页\n正文", { 现在: now, 当前指纹: "a".repeat(40) });
		expect(noHeader.新鲜).toBe(false);
		expect(noHeader.原因.join(";")).toContain("缺最近服务时间");
		expect(noHeader.原因.join(";")).toContain("缺配方指纹字段");
	});

	it("保鲜窗可经 options 覆写;导出常量默认 24 小时", () => {
		const page = makePageText({ 时间: "2026-10-03 09:30:00" });
		// 半小时旧:默认窗内新鲜;收紧到 60 秒即降级
		expect(judgeHandoffTimeliness(page, { 现在: now, 当前指纹: "a".repeat(40) }).新鲜).toBe(true);
		expect(judgeHandoffTimeliness(page, { 现在: now, 当前指纹: "a".repeat(40), 保鲜窗毫秒: 1_000 }).新鲜).toBe(false);
		expect(handoffFreshnessMs).toBe(24 * 60 * 60 * 1000);
	});
});

describe("落交接页带指纹与富交接指针:临时目录端到端", () => {
	it("落盘头部带配方指纹;落盘→读回→判定 新鲜可参考", async () => {
		const home = tempDir("e2e");
		writeRecipe(home);
		const projectRoot = tempDir("proj");
		const path = await writeHandoffPage({
			paoHome: home,
			部门: "前端",
			项目根: projectRoot,
			卡目录: join(projectRoot, ".pao", "卡"), // 不存在的卡目录:renderHandoff 空态兜底
		});
		const body = readFileSync(path, "utf8");
		expect(body).toContain(`配方指纹:${recipeFingerprint("前端", home)}`);
		expect(body).toContain("最近服务:");

		const judgement = judgeHandoffTimeliness(readFileSync(path, "utf8"), {
			现在: new Date(),
			当前指纹: recipeFingerprint("前端", home),
		});
		expect(judgement.新鲜).toBe(true);
		expect(judgement.原因).toEqual([]);
	});

	it("落盘后配方变更再读:指纹不匹配 → 富指针降级「仅历史参考,不授权续跑」", async () => {
		const home = tempDir("stale");
		writeRecipe(home);
		const projectRoot = tempDir("proj");
		const path = await writeHandoffPage({
			paoHome: home,
			部门: "前端",
			项目根: projectRoot,
			卡目录: join(projectRoot, ".pao", "卡"),
		});

		// 新鲜:富指针给「背景核对」＋时效核对通过
		const fresh = richHandoffPointerText(home, "前端", projectRoot, { 现在: new Date() });
		expect(fresh).toBeDefined();
		expect(fresh!.文本).toContain("背景核对");
		expect(fresh!.文本).toContain("不是续跑指令");
		expect(fresh!.判定.新鲜).toBe(true);

		// 配方变更(指纹变)→ 降级:指针带「仅历史参考,不授权续跑」＋原因
		writeFileSync(join(home, "部门", "前端", "配方.md"), "# 配方:前端(改)\n", "utf8");
		const downgrade = richHandoffPointerText(home, "前端", projectRoot, { 现在: new Date() });
		expect(downgrade).toBeDefined();
		expect(downgrade!.文本).toContain("仅历史参考,不授权续跑");
		expect(downgrade!.文本).toContain("配方指纹不匹配");
		expect(downgrade!.判定.新鲜).toBe(false);
		expect(path).toBe(handoffPagePath(home, "前端", projectRoot));
	});

	it("超窗与保鲜窗覆写走富指针同样降级;页不存在返回 undefined 同旧语义", async () => {
		const home = tempDir("window");
		writeRecipe(home);
		const projectRoot = tempDir("proj");
		await writeHandoffPage({
			paoHome: home,
			部门: "前端",
			项目根: projectRoot,
			卡目录: join(projectRoot, ".pao", "卡"),
			时间: "2026-10-01 09:00:00", // 手工落一个旧时间(默认窗外)
		});
		const overWindow = richHandoffPointerText(home, "前端", projectRoot, { 现在: new Date() });
		expect(overWindow!.判定.新鲜).toBe(false);
		expect(overWindow!.文本).toContain("超过保鲜窗");

		expect(richHandoffPointerText(home, "前端", tempDir("missing"))).toBeUndefined();
	});
});

describe("scaffold 部长人设明文(S3 设计规格)", () => {
	it("建部配方模板带「交接页不得据此自行启动任何卡」明文", async () => {
		const home = tempDir("scaffold");
		await createDept({ paoHome: home, 名字: "前端" });
		const recipe = readFileSync(join(home, "部门", "前端", "配方.md"), "utf8");
		expect(recipe).toContain("交接页不得据此自行启动任何卡——启动卡是主控专属动作");
	});
});
