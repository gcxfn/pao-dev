/**
 * G3 格式版本收口（§8.3 第 2 段）：格式版本与编辑版本分离，未知新版/损坏保留原件 + 阻止不可靠写 + 正常对象继续展示。
 *
 * 考的三条硬线（缺一即假成功）：
 * 1. **保留原件**：读到未知格式版本或损坏时，盘上字节一字不动，不自动修、不重写、不删；
 * 2. **阻止不可靠写**：不得把未知新版当旧格式续跑/续写，也不得补默认值假装读成功；
 * 3. **正常对象继续展示**：同目录里好的实例照常出现，坏的只进「异常」行，一条坏不拖垮整次扫描。
 *
 * 另考「格式版本 vs 编辑版本」不混用：实例 frontmatter 的 `版本` 是格式版本（1/2），
 * 计划的 `定义版本` 与配方的 revision 属编辑版本，两套编号互不替代。
 *
 * fixture 全在临时目录，不碰正式 PAO_HOME，不起进程、不调供应商。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { scanWorkflowInstances, readWorkflowInstance } from "../../src/pao/status/workflow-instances.ts";
import { readDesktopFlows } from "../../src/pao/desktop/workflow.ts";
import { readControl, startControl } from "../../src/pao/workflow/control.ts";
import { parseManifest } from "../../src/pao/workflow/driver.ts";
import { parseRecipe } from "../../src/pao/workflow/recipe.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-format-version-"));
	tempDirs.push(dir);
	return dir;
}

/** 登记一个项目到 项目清单.md，返回该项目根（扫描面按清单找 .pao） */
function setupProject(paoHome: string, projectName: string): string {
	const projectRoot = tempDir();
	writeFileSync(
		join(paoHome, "项目清单.md"),
		`| 项目名 | 项目根 | 首次服务 | 最近服务 |\n| --- | --- | --- | --- |\n| ${projectName} | ${projectRoot} | 2026-10-04 10:00 | 2026-10-04 10:00 |\n`,
		"utf8",
	);
	return projectRoot;
}

/** 落一个 v1 旧清单；行内容由用例给定，便于构造「未知版本」「坏字段」 */
function writeV1(paoDir: string, flowName: string, lines: string[]): string {
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

/** 起一个真 v2 实例（控制正本落盘），返回控制正本路径与读取参数 */
async function setupV2(paoDir: string, flowName: string) {
	mkdirSync(paoDir, { recursive: true });
	const recipe = parseRecipe(
		`---\n${stringify({
			版本: 2,
			名字: flowName,
			参数: [],
			节点: [{ 名字: "开发", 部门: "开发", 目标: "改代码", 验收: "文件存在" }],
		})}---\n`,
		join(paoDir, `${flowName}.md`),
	);
	const options = { cardsDir: join(paoDir, "卡"), ownerSessionId: "owner" };
	await startControl(recipe, {}, options);
	return { recipe, options, controlFile: join(paoDir, `工作流实例-${flowName}.md`) };
}

describe("未知格式版本：保留原件 + 阻止按旧格式读", () => {
	it("实例格式版本 3 → 明确报出实际版本号与文件路径，不降级当 v1 清单", () => {
		const paoDir = join(tempDir(), ".pao");
		const lines = healthyV1Lines("未来流", "挂起", paoDir);
		// 字段齐全到「当 v1 也能读通」的程度——这正是假成功的入口
		const content = `---\n版本: 3\n${lines.join("\n")}\n---\n`;
		expect(() => parseManifest(content)).toThrow(/格式版本「3」不认识/);
		// 带路径时报错里必须出现该路径，模型才知道改哪个文件
		expect(() => parseManifest(content, join(paoDir, "工作流实例-未来流.md"))).toThrow(
			/工作流实例-未来流\.md/,
		);
		// 点名可走的路与禁走的路
		expect(() => parseManifest(content)).toThrow(/原件保留不动/);
		expect(() => parseManifest(content)).toThrow(/不得当旧清单续跑/);
	});

	it("格式版本 2 走控制入口的实例：提示改用 v2 入口，且不许手工改版本号", () => {
		const content = `---\n版本: 2\n工作流: 现在流\n卡目录: /x\n启动: 2026-10-04 10:00\n状态: 挂起\n节点: []\n---\n`;
		expect(() => parseManifest(content)).toThrow(/须经 v2 控制入口读取/);
		expect(() => parseManifest(content)).toThrow(/不要手工改版本号/);
	});

	it("控制正本版本被改成 3 → readControl 拒绝续跑，报出路径与实际版本，原件逐字节保留", async () => {
		const paoDir = join(tempDir(), ".pao");
		const { recipe, options, controlFile } = await setupV2(paoDir, "改版流");
		const before = readFileSync(controlFile, "utf8");
		const tampered = before.replace(/^版本: 2$/m, "版本: 3");
		expect(tampered).not.toBe(before);
		writeFileSync(controlFile, tampered, "utf8");

		let message = "";
		try {
			readControl(recipe, options);
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain("[FLOW_CONTROL]");
		expect(message).toContain("未知版本");
		expect(message).toContain("3");
		expect(message).toContain(controlFile);
		expect(message).toContain("原件保留不动");
		// 保留原件：坏版本号的字节一个没被修掉
		expect(readFileSync(controlFile, "utf8")).toBe(tampered);
	});
});

describe("损坏对象：保留原件 + 不拖累正常对象", () => {
	it("同一目录一好一坏：好的照常展示，坏的只进异常行并带原件路径", () => {
		const paoHome = tempDir();
		const projectRoot = setupProject(paoHome, "双流项目");
		const paoDir = join(projectRoot, ".pao");
		mkdirSync(paoDir, { recursive: true });

		// 好的 v1 实例
		writeV1(paoDir, "好流", healthyV1Lines("好流", "挂起", paoDir));
		// 坏的：未知格式版本
		const badPath = writeV1(paoDir, "坏流", ["版本: 9", ...healthyV1Lines("坏流", "挂起", paoDir)]);
		const badBefore = readFileSync(badPath, "utf8");

		const scan = scanWorkflowInstances(paoHome);
		// 好对象继续展示：挂起清单里有它
		expect(scan.挂起.map((row) => row.工作流)).toContain("好流");
		// 坏对象进异常行，且不当空闲、不进挂起
		expect(scan.挂起.map((row) => row.工作流)).not.toContain("坏流");
		const anomaly = scan.异常.find((row) => row.文件 === "工作流实例-坏流.md");
		expect(anomaly, "坏实例必须出现在异常行").toBeDefined();
		expect(anomaly!.路径).toBe(badPath);
		expect(anomaly!.原因).toMatch(/格式版本「9」不认识/);
		// 原件逐字节保留
		expect(readFileSync(badPath, "utf8")).toBe(badBefore);
	});

	it("损坏字段实例：报错点名字段并声明不得自动续跑，原件保留", () => {
		const paoDir = join(tempDir(), ".pao");
		const lines = healthyV1Lines("缺状态流", "挂起", paoDir).filter((line) => !line.startsWith("状态:"));
		const path = writeV1(paoDir, "缺状态流", lines);
		const before = readFileSync(path, "utf8");
		let message = "";
		try {
			readWorkflowInstance(path);
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain("实例清单损坏");
		expect(message).toContain("「状态」");
		expect(message).toContain("保留原件");
		expect(readFileSync(path, "utf8")).toBe(before);
	});
});

describe("桌面读面同口径：坏实例不拖垮整页", () => {
	it("readDesktopFlows 一好一坏：好实例照常返回，坏实例只记问题带路径", async () => {
		const projectRoot = tempDir();
		const paoDir = join(projectRoot, ".pao");
		const { controlFile } = await setupV2(paoDir, "活流");
		const goodBefore = readFileSync(controlFile, "utf8");

		// 坏实例：格式版本 9
		const badPath = writeV1(paoDir, "坏流", ["版本: 9", ...healthyV1Lines("坏流", "挂起", paoDir)]);
		const badBefore = readFileSync(badPath, "utf8");

		const result = readDesktopFlows(projectRoot);
		expect(result.工作流).toHaveLength(1);
		expect(result.工作流[0]!.控制.工作流).toBe("活流");
		const issue = result.问题.find((row) => row.路径 === badPath);
		expect(issue, "坏实例必须进问题列表").toBeDefined();
		// 桌面读面先定位冻结配方再读控制正本，未知版本在这条链上会以「配方缺失/归属失配」先失败；
		// 考的是「坏对象有可诊断原因、不被静默跳过」，不锁死具体文案（锁死会把未来更早的守卫变成假红）。
		expect(issue!.说明.trim().length).toBeGreaterThan(0);
		expect(issue!.说明).not.toContain("[object Object]");
		// 这条原因必须能指回坏实例本身，而不是只报个笼统错误
		expect(issue!.路径).toBe(badPath);
		// 两面原件都在
		expect(readFileSync(controlFile, "utf8")).toBe(goodBefore);
		expect(readFileSync(badPath, "utf8")).toBe(badBefore);
	});
});

describe("格式版本与编辑版本不混用", () => {
	it("配方的格式版本只有 1/2：写 3 直接拒，不猜、不补默认", () => {
		expect(() =>
			parseRecipe(`---\n${stringify({ 版本: 3, 名字: "未来配方", 参数: [], 节点: [] })}---\n`, "/x/未来配方.md"),
		).toThrow(/配方版本仅支持 1 或 2/);
	});

	it("同一实例的格式版本（1/2）与计划定义版本（编辑版本）各自编号，互不替代", async () => {
		const paoDir = join(tempDir(), ".pao");
		const { controlFile } = await setupV2(paoDir, "编号流");
		const content = readFileSync(controlFile, "utf8");
		// 这个是格式版本=2 的控制正本
		expect(content).toMatch(/^版本: 2$/m);
		// 控制正本里没有「定义版本」——它是计划侧的编辑版本，不塞进实例格式版本里冒充
		expect(content).not.toMatch(/^定义版本:/m);
		// 同一份正本里两条编号若被混用，轮次/版本会互相顶替；这里断言各自的键都在自己该在的位置
		expect(content).toMatch(/^实例: /m);
		expect(content).toMatch(/^轮次|节点:/m);
	});
});
