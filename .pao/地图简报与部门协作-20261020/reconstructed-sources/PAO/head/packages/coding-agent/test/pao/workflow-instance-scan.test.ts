/**
 * 工作流实例清单扫描负例（浅字段分流修复 2026-10-04）:
 * - parseManifest 坏必要控制字段/缺字段 → 抛错显式化,不降级伪装「运行中」;
 * - scanWorkflowInstances:坏字段实例 → 「异常」显式出行（文件名+原因）,不进挂起、不称空闲;
 *   目录不可达（非 ENOENT）→ 显式目录异常,不可达≠空;
 * - v2 实例走控制正本读真实状态:挂起（暂停）列出,运行中不列,损坏显式 [FLOW_CONTROL] 异常;
 * - firstrun 首跑清单与 pano 全景工作流区都渲染「实例异常」行。fixture 全部临时目录。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { buildPanoramaPage } from "../../src/pao/panorama/index.ts";
import { buildFirstRunList } from "../../src/pao/status/firstrun.ts";
import { scanWorkflowInstances } from "../../src/pao/status/workflow-instances.ts";
import { pauseControl, startControl } from "../../src/pao/workflow/control.ts";
import { parseManifest } from "../../src/pao/workflow/driver.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-instance-scan-"));
	tempDirs.push(dir);
	return dir;
}

/** 项目清单登记一行；返回该项目 .pao 目录（不预创建,由用例决定是目录还是坏文件） */
function setupProject(paoHome: string, projectName: string): string {
	const projectRoot = tempDir();
	writeFileSync(
		join(paoHome, "项目清单.md"),
		`| 项目名 | 项目根 | 首次服务 | 最近服务 |\n| --- | --- | --- | --- |\n| ${projectName} | ${projectRoot} | 2026-10-04 10:00 | 2026-10-04 10:00 |\n`,
		"utf8",
	);
	return join(projectRoot, ".pao");
}

/** 落一个 v1 实例清单;frontmatter 行原样写入,可任意构造坏字段 */
function writeV1Manifest(paoDir: string, flowName: string, lines: string[]): string {
	mkdirSync(paoDir, { recursive: true });
	const path = join(paoDir, `工作流实例-${flowName}.md`);
	writeFileSync(path, `---\n${lines.join("\n")}\n---\n<!-- 测试实例 -->\n`, "utf8");
	return path;
}

function healthyV1Lines(flowName: string, status: string, paoDir: string): string[] {
	return [
		`工作流: ${flowName}`,
		`卡目录: ${join(paoDir, "卡")}`,
		"启动: 2026-10-04 10:00",
		`状态: ${status}`,
		"参数: {}",
		"节点: []",
	];
}

/** v2 配方 + startControl 落控制正本到 <项目根>/.pao/工作流实例-验流.md */
function setupV2(paoDir: string) {
	mkdirSync(paoDir, { recursive: true });
	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: "验流",
			参数: [],
			节点: [{ 名字: "开发", 部门: "开发", 目标: "改代码", 验收: "文件存在" }],
		})}---\n`,
		join(paoDir, "验流.md"),
	);
	const options = { cardsDir: join(paoDir, "卡"), ownerSessionId: "owner" };
	return { recipe, options };
}

describe("parseManifest 必要控制字段严格校验（不降级伪装）", () => {
	it("缺「状态」字段 → 抛错,不降级为运行中", () => {
		const lines = healthyV1Lines("坏流", "挂起", join(tempDir(), ".pao")).filter((line) => !line.startsWith("状态:"));
		expect(() => parseManifest(`---\n${lines.join("\n")}\n---\n`)).toThrow(/实例清单损坏.*「状态」/);
	});
	it("「状态」坏值 → 抛错,不降级为运行中", () => {
		const lines = healthyV1Lines("坏流", "挂起", join(tempDir(), ".pao")).map((line) =>
			line === "状态: 挂起" ? "状态: 跑着" : line,
		);
		expect(() => parseManifest(`---\n${lines.join("\n")}\n---\n`)).toThrow(/「状态」.*不得降级为运行中/);
	});
	it("缺「工作流」「卡目录」→ 抛错并点名字段", () => {
		const lines = ["启动: 2026-10-04 10:00", "状态: 挂起", "参数: {}", "节点: []"];
		expect(() => parseManifest(`---\n${lines.join("\n")}\n---\n`)).toThrow(
			/「工作流」.*「卡目录」|「卡目录」.*「工作流」/,
		);
	});
	it("节点条目缺「名字」→ 抛错并带下标", () => {
		const lines = healthyV1Lines("坏流", "挂起", join(tempDir(), ".pao")).map((line) =>
			line === "节点: []" ? "节点:\n  - 卡号: 卡0001" : line,
		);
		expect(() => parseManifest(`---\n${lines.join("\n")}\n---\n`)).toThrow(/节点\[0\] 缺「名字」/);
	});
	it("健康清单原样解析,挂起保持挂起", () => {
		const paoDir = join(tempDir(), ".pao");
		const manifest = parseManifest(`---\n${healthyV1Lines("好流", "挂起", paoDir).join("\n")}\n---\n`);
		expect(manifest.状态).toBe("挂起");
		expect(manifest.工作流).toBe("好流");
	});
});

describe("scanWorkflowInstances 实例异常显式化（不伪装空闲）", () => {
	it("挂起列出;运行中/已完成不列且无异常", () => {
		const home = tempDir();
		const paoDir = setupProject(home, "项目A");
		writeV1Manifest(paoDir, "修复链", healthyV1Lines("修复链", "挂起", paoDir));
		writeV1Manifest(paoDir, "跑动链", healthyV1Lines("跑动链", "运行中", paoDir));
		writeV1Manifest(paoDir, "完成链", healthyV1Lines("完成链", "已完成", paoDir));
		const scan = scanWorkflowInstances(home);
		expect(scan.挂起.map((s) => s.工作流)).toEqual(["修复链"]);
		expect(scan.异常).toEqual([]);
	});
	it("坏「状态」字段 → 异常行带文件名与原因,不进挂起、不称空闲", () => {
		const home = tempDir();
		const paoDir = setupProject(home, "项目B");
		writeV1Manifest(
			paoDir,
			"坏流",
			healthyV1Lines("坏流", "挂起", paoDir).map((line) => (line === "状态: 挂起" ? "状态: 跑着" : line)),
		);
		const scan = scanWorkflowInstances(home);
		expect(scan.挂起).toEqual([]);
		expect(scan.异常).toHaveLength(1);
		expect(scan.异常[0].文件).toBe("工作流实例-坏流.md");
		expect(scan.异常[0].原因).toContain("「状态」");
		expect(scan.异常[0].原因).toContain("不得当空闲清理");
	});
	it("缺必要控制字段 → 异常行点名缺的字段", () => {
		const home = tempDir();
		const paoDir = setupProject(home, "项目C");
		writeV1Manifest(paoDir, "残流", ["启动: 2026-10-04 10:00", "状态: 挂起", "参数: {}", "节点: []"]);
		const scan = scanWorkflowInstances(home);
		expect(scan.挂起).toEqual([]);
		expect(scan.异常).toHaveLength(1);
		expect(scan.异常[0].原因).toContain("「工作流」");
	});
	it("目录不可达（.pao 是文件,非 ENOENT）→ 显式目录异常,不称无实例", () => {
		const home = tempDir();
		const paoDir = setupProject(home, "项目D");
		writeFileSync(paoDir, "不是目录", "utf8");
		const scan = scanWorkflowInstances(home);
		expect(scan.挂起).toEqual([]);
		expect(scan.异常).toHaveLength(1);
		expect(scan.异常[0].路径).toBe(paoDir);
		expect(scan.异常[0].原因).toContain("目录读取失败");
	});
	it("v2 暂停实例按控制正本列为挂起;运行中不列且无异常", async () => {
		const home = tempDir();
		const paoDir = setupProject(home, "项目E");
		const paused = setupV2(paoDir);
		await startControl(paused.recipe, {}, paused.options);
		await pauseControl(paused.recipe, paused.options, "等待人工");
		const running = setupV2(paoDir);
		running.recipe = parseRecipe(
			`---\n${stringify({
				版本: 2,
				名字: "验流二",
				参数: [],
				节点: [{ 名字: "开发", 部门: "开发", 目标: "改代码", 验收: "文件存在" }],
			})}---\n`,
			join(paoDir, "验流二.md"),
		);
		await startControl(running.recipe, {}, running.options);
		const scan = scanWorkflowInstances(home);
		expect(scan.挂起.map((s) => s.工作流)).toEqual(["验流"]);
		expect(scan.异常).toEqual([]);
	});
	it("v2 控制清单损坏（owner 字段坏）→ 显式异常带 [FLOW_CONTROL] 原因,不伪装空闲", async () => {
		const home = tempDir();
		const paoDir = setupProject(home, "项目F");
		const s = setupV2(paoDir);
		await startControl(s.recipe, {}, s.options);
		const path = join(paoDir, "工作流实例-验流.md");
		writeFileSync(path, readFileSync(path, "utf8").replace("owner: owner", "owner: 123"), "utf8");
		const scan = scanWorkflowInstances(home);
		expect(scan.挂起).toEqual([]);
		expect(scan.异常).toHaveLength(1);
		expect(scan.异常[0].文件).toBe("工作流实例-验流.md");
		expect(scan.异常[0].原因).toContain("[FLOW_CONTROL]");
	});
});

describe("呈现层渲染实例异常行", () => {
	it("首跑清单:实例异常出行,不报「今日待办:无」", () => {
		const home = tempDir();
		const paoDir = setupProject(home, "项目G");
		writeV1Manifest(paoDir, "坏流", ["工作流: 坏流", "状态: 挂起", "节点: []"]);
		const text = buildFirstRunList(home);
		expect(text).toContain("⚠ - 工作流实例异常 1:工作流实例-坏流.md（实例清单损坏");
		expect(text).not.toContain("今日待办:无");
	});
	it("全景工作流区:挂起无但异常有时,两行都如实（不与空闲混同）", () => {
		const home = tempDir();
		const paoDir = setupProject(home, "项目H");
		writeV1Manifest(paoDir, "坏流", ["状态: 跑着", "节点: []"]);
		const text = buildPanoramaPage({ paoHome: home });
		expect(text).toContain("── 工作流 ──\n挂起工作流:无\n实例异常 1:工作流实例-坏流.md（");
	});
	it("全景工作流区:无异常时维持原口径", () => {
		const home = tempDir();
		setupProject(home, "项目I");
		const text = buildPanoramaPage({ paoHome: home });
		expect(text).toContain("── 工作流 ──\n挂起工作流:无");
		expect(text).not.toContain("实例异常");
	});
});
