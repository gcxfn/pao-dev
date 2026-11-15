/**
 * F1 件三：桌面中间层错误文案补证（G 批自报未验项）。
 *
 * 背景：G3 给 `desktop/canvas.ts:528`（实例段扫描）与 `:702`（节点详情）补了
 * `parseManifest(content, path)` 的第二参数，让「未知格式版本」的报错里带**具体文件名**。
 * 当时只在 `driver.ts` 的单元口径里验过文案，**没有在真桌面读取入口上触发过**——
 * 也就是没人保证 canvas 那条 `parseManifest` 调用真的把 path 传下去了。
 *
 * 本文件只做一件事：造一个未知格式版本（`版本: 5`）的工作流实例放进项目 `.pao`，
 * 用 `readDesktopCanvas` 与 `readDesktopNodeDetail` 两个真实入口取回，断言：
 * 1. 文案含**真实版本号**「5」，不是只说「须经 v2 控制入口读取」（那是版本 2 的话）；
 * 2. 文案含**具体文件名**（`工作流实例-未来版.md`），用户能据此定位；
 * 3. 文案含**下一步**（「原件保留不动」「不得手工改版本号」）；
 * 4. 同一目录里正常的实例照常出现在 `实例` 段——一个坏文件不拖整段（不整体不可用）；
 * 5. 原件逐字节不变（读取不改写盘面，也不"顺手修复"）。
 *
 * hermetic：临时 PAO_HOME + 临时项目根，不碰正式 PAO_HOME，不 spawn 进程，不调真实供应商。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { formatProjectList } from "../../src/pao/dept/projects.ts";
import { readDesktopCanvas, readDesktopNodeDetail } from "../../src/pao/desktop/canvas.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), `pao-f-canvas-${prefix}-`));
	roots.push(root);
	return root;
}

interface ManifestData {
	工作流: string;
	卡目录: string;
	启动: string;
	状态: string;
	参数?: Record<string, string>;
	节点: Record<string, unknown>[];
	版本?: number;
}

/** 与 driver serializeManifest 同形状写实例清单（YAML frontmatter＋维护注释正文） */
function writeManifest(path: string, data: ManifestData): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `---\n${stringifyYaml(data)}---\n<!-- 驱动器维护：F1 用例 fixture -->\n`);
}

function registerProject(paoHome: string, projectRoot: string): void {
	writeFileSync(
		join(paoHome, "项目清单.md"),
		formatProjectList([
			{ 项目名: "项目", 项目根: projectRoot, 首次服务: "2026-10-17 09:00", 最近服务: "2026-10-17 09:00" },
		]),
	);
}

describe("F1 件三 桌面画布：未知格式版本实例的报错文案", () => {
	it("readDesktopCanvas 的异常行带真实版本号＋具体文件名＋下一步，且不拖累同目录好实例", () => {
		const root = makeRoot("scan");
		const paoHome = join(root, "现场");
		const project = join(root, "项目");
		const cardsDir = join(project, ".pao", "任务甲", "卡");
		mkdirSync(paoHome, { recursive: true });
		mkdirSync(cardsDir, { recursive: true });
		registerProject(paoHome, project);

		// 好实例：旧格式（无版本键）→ 走 parseManifest 正常分支
		const goodPath = join(project, ".pao", "任务甲", "工作流实例-旧清单.md");
		writeManifest(goodPath, {
			工作流: "旧清单",
			卡目录: cardsDir,
			启动: "2026-10-17 09:00",
			状态: "运行中",
			节点: [{ 名字: "实现" }],
		});
		// 坏实例：未知格式版本 5（未来版本）→ 必须被拒，且报错要能定位到文件
		const futurePath = join(project, ".pao", "工作流实例-未来版.md");
		writeManifest(futurePath, {
			版本: 5,
			工作流: "未来版",
			卡目录: cardsDir,
			启动: "2026-10-17 09:00",
			状态: "运行中",
			节点: [{ 名字: "实现" }],
		});
		const originalBytes = readFileSync(futurePath);

		const view = readDesktopCanvas(paoHome);

		// ① 异常行存在且指向那个文件
		const row = view.异常.find((item) => item.路径 === futurePath);
		expect(row, `异常行应包含 ${futurePath}；实际 ${JSON.stringify(view.异常.map((i) => i.路径))}`).toBeDefined();
			const 原因 = row?.原因 ?? "";
		// ② 真实版本号（不是 2）
		expect(原因).toContain("「5」");
		// ③ 具体文件名（canvas.ts 确实把 path 传给了 parseManifest）
		expect(原因).toContain("工作流实例-未来版.md");
		expect(原因).toContain(futurePath);
		// ④ 下一步：原件保留 + 不许手工改版本号掩盖
		expect(原因).toContain("原件保留不动");
		expect(原因).toContain("不得手工改版本号");
		// ⑤ 不能退化成「版本 2 的那句」——那句话对未知版本是误导（G3 修掉的正是这个）
		expect(原因).not.toContain("须经 v2 控制入口读取");

		// ⑥ 同目录好实例照常入段：一个坏文件不让整段不可用
		expect(view.实例.map((item) => item.名字)).toEqual(["旧清单"]);
		expect(view.异常).toHaveLength(1);

		// ⑦ 原件逐字节不变（只读投影，不改写盘面，也不顺手"修复"）
		expect(readFileSync(futurePath).equals(originalBytes)).toBe(true);
	});

	it("readDesktopNodeDetail 的错误字段同样带真实版本号与具体文件名", () => {
		const root = makeRoot("detail");
		const paoHome = join(root, "现场");
		const project = join(root, "项目");
		const cardsDir = join(project, ".pao", "任务甲", "卡");
		mkdirSync(paoHome, { recursive: true });
		mkdirSync(cardsDir, { recursive: true });
		registerProject(paoHome, project);

		const futurePath = join(project, ".pao", "任务甲", "工作流实例-未来版.md");
		writeManifest(futurePath, {
			版本: 5,
			工作流: "未来版",
			卡目录: cardsDir,
			启动: "2026-10-17 09:00",
			状态: "运行中",
			节点: [{ 名字: "实现" }],
		});
		const originalBytes = readFileSync(futurePath);

		const detail = readDesktopNodeDetail(paoHome, futurePath, "实现");

		// canvas.ts:702 的 parseManifest 调用点：path 必须传下去，否则这里只有「须经 v2」一句
		const 错误 = detail.错误 ?? "";
		expect(错误).toContain("实例清单不可读");
		expect(错误).toContain("「5」");
		expect(错误).toContain("工作流实例-未来版.md");
		expect(错误).toContain("原件保留不动");
		expect(错误).not.toContain("须经 v2 控制入口读取");
		// 读不出清单时不编造节点：不回填空节点数组、不假装模板存在
		expect(detail.节点).toBe("实现");
		expect(detail.模板).toBeUndefined();
		expect(readFileSync(futurePath).equals(originalBytes)).toBe(true);
	});
});
