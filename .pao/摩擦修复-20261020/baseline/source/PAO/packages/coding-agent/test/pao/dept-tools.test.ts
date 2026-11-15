import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "../../src/core/extensions/types.ts";
import {
	type DeptRegistryRow,
	parseRegistry,
	readRegistry,
	registerDeptTools,
	renderRegistrySnapshot,
	renderRegistryText,
	today,
} from "../../src/pao/dept/index.ts";
import type { CreateDeptReport } from "../../src/pao/dept/scaffold.ts";
import { createDept } from "../../src/pao/dept/scaffold.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-dept-"));
	tempDirs.push(dir);
	return dir;
}

/** 骨架应生成的全部文件与目录(架构 §6.2:索引门面 + 六目录,四类型区各带子索引) */
const SKELETON_FILES = [
	"配方.md",
	join("知识库", "索引.md"),
	join("知识库", "待验证"),
	join("知识库", "归档"),
	join("知识库", "教训", "子索引.md"),
	join("知识库", "导览", "子索引.md"),
	join("知识库", "做法", "子索引.md"),
	join("知识库", "评测", "子索引.md"),
];

describe("建部:库骨架完整且与注册表联动", () => {
	it("一次建部落齐配方、六目录、四子索引与注册表行", async () => {
		const home = tempHome();
		const report = await createDept({ paoHome: home, 名字: "后端", 标签: ["api", "数据库"] });

		const deptDir = join(home, "部门", "后端");
		for (const relative of SKELETON_FILES) {
			expect(statSync(join(deptDir, relative)), relative).toBeTruthy();
		}
		// 配方五要素
		const recipe = readFileSync(join(deptDir, "配方.md"), "utf8");
		expect(recipe).toContain("名字:后端");
		expect(recipe).toContain("人设:");
		expect(recipe).toContain("工具:");
		expect(recipe).toContain("默认档位:主力");
		expect(recipe).toContain("记忆目录:部门/后端/知识库");
		// 门面:各区导引与条数占位
		const kbIndex = readFileSync(join(deptDir, "知识库", "索引.md"), "utf8");
		expect(kbIndex).toContain("本部答什么问题");
		for (const zone of ["待验证", "归档", "教训", "导览", "做法", "评测"]) {
			expect(kbIndex).toContain(zone);
			expect(kbIndex).toContain("0 条");
		}
		// 注册表是唯一真相,行内容 = 名字/标签/库路径/建部日期(建部日期由代码取当天写入)
		const rows = readRegistry(join(home, "部门", "注册表.md"));
		expect(rows).toEqual([{ 名字: "后端", 标签: ["api", "数据库"], 库路径: "部门/后端/知识库", 建部日期: today() }]);
		expect(report.注册表).toBe("created");
	});

	it("不写标签时注册表标签为空数组;自定义默认档位写进配方", async () => {
		const home = tempHome();
		await createDept({ paoHome: home, 名字: "侦察", 默认档位: "快" });
		const recipe = readFileSync(join(home, "部门", "侦察", "配方.md"), "utf8");
		expect(recipe).toContain("默认档位:快");
		expect(readRegistry(join(home, "部门", "注册表.md"))[0].标签).toEqual([]);
	});

	it("非法部门名字报错,不落任何文件", async () => {
		const home = tempHome();
		for (const name of ["", "a/b", "..", "a\\b"]) {
			await expect(createDept({ paoHome: home, 名字: name }), name).rejects.toThrow(/非法|为空/);
		}
		expect(existsSync(join(home, "部门"))).toBe(false);
	});
});

describe("建部幂等:重跑不覆盖已有内容,缺啥补啥", () => {
	it("两次建部后目录内容与一次相同;已有自定义内容不丢;注册表不重复", async () => {
		const home = tempHome();
		await createDept({ paoHome: home, 名字: "后端", 标签: ["api"] });

		// 用户自定义:配方追加内容、教训区加条目
		const recipePath = join(home, "部门", "后端", "配方.md");
		appendFileSync(recipePath, "\n自定义人设内容-XYZ\n", "utf8");
		const lessonDir = join(home, "部门", "后端", "知识库", "教训");
		writeFileSync(join(lessonDir, "Windows路径坑.md"), "首行钩子+日期(2026-10-02)", "utf8");

		const report2 = await createDept({ paoHome: home, 名字: "后端", 标签: ["api", "数据库"] });
		expect(report2.新建).toEqual([]);
		expect(readFileSync(recipePath, "utf8")).toContain("自定义人设内容-XYZ");
		expect(existsSync(join(lessonDir, "Windows路径坑.md"))).toBe(true);
		expect(readFileSync(join(lessonDir, "Windows路径坑.md"), "utf8")).toBe("首行钩子+日期(2026-10-02)");

		// 注册表仍只有一行(同名不覆盖、不重复追加)
		const rows = readRegistry(join(home, "部门", "注册表.md"));
		expect(rows.length).toBe(1);
		expect(report2.注册表).toBe("exists");

		// 缺啥补啥:删掉子索引后重跑,只补缺的文件,自定义内容不丢
		rmSync(join(home, "部门", "后端", "知识库", "导览", "子索引.md"));
		const report3 = await createDept({ paoHome: home, 名字: "后端" });
		expect(report3.新建).toEqual(["后端/知识库/导览/子索引.md"]);
		expect(readFileSync(recipePath, "utf8")).toContain("自定义人设内容-XYZ");
	});
});

describe("注册表读写", () => {
	it("parseRegistry 解析表格行,跳过表头与分隔行,容忍中文顿号标签", () => {
		const text = [
			"# 部门注册表",
			"| 名字 | 能力标签 | 库路径 |",
			"| --- | --- | --- |",
			"| 后端 | api、数据库 | 部门/后端/知识库 |",
			"| 侦察 | 搜索 | 部门/侦察/知识库 |",
		].join("\n");
		expect(parseRegistry(text)).toEqual([
			{ 名字: "后端", 标签: ["api", "数据库"], 库路径: "部门/后端/知识库" },
			{ 名字: "侦察", 标签: ["搜索"], 库路径: "部门/侦察/知识库" },
		]);
	});

	it("文件不存在时 readRegistry 返回空数组,不报错", () => {
		expect(readRegistry(join(tempHome(), "部门", "注册表.md"))).toEqual([]);
	});

	it("多次经锁追加不丢行,同名幂等(与生产同一条锁代码)", async () => {
		const home = tempHome();
		await createDept({ paoHome: home, 名字: "后端", 标签: ["api"] });
		await createDept({ paoHome: home, 名字: "侦察", 标签: ["搜索"] });
		await createDept({ paoHome: home, 名字: "后端" });
		const rows = readRegistry(join(home, "部门", "注册表.md"));
		expect(rows.map((entry) => entry.名字)).toEqual(["后端", "侦察"]);
	});
});

describe("大小写不同的部门名（审查第 14 项）", () => {
	// Windows 文件名不敏感：部门/AuditDemo 与 部门/auditdemo 是同一个目录。其它平台这是两个真目录，不适用。
	const 只测不敏感文件系统 = process.platform === "win32" || process.platform === "darwin";

	it.skipIf(!只测不敏感文件系统)("连续建 AuditDemo/auditdemo 只留一行注册,并回显既有显示名", async () => {
		const home = tempHome();
		const first = await createDept({ paoHome: home, 名字: "AuditDemo", 标签: ["审计"] });
		const second = await createDept({ paoHome: home, 名字: "auditdemo", 标签: ["审计"] });

		const rows = readRegistry(join(home, "部门", "注册表.md"));
		// 不能出现两行指向同一目录
		expect(rows.map((entry) => entry.名字)).toEqual(["AuditDemo"]);
		expect(first.注册表).toBe("created");
		expect(second.注册表).toBe("exists");
		// 返回既有部门（显示名与库路径都归到第一次的名字），调用方不会以为新建了一个
		expect(second.既有名字).toBe("AuditDemo");
		expect(second.名字).toBe("AuditDemo");
		expect(second.库路径).toBe("部门/AuditDemo/知识库");
		// 目录里读到的配方标题仍是第一个部门的（共用同一份目录）
		expect(readFileSync(join(home, "部门", "auditdemo", "配方.md"), "utf8").split("\n")[0]).toBe("# 配方:AuditDemo");
	});

	it.skipIf(!只测不敏感文件系统)("并发建两个大小写变体也只留一行注册", async () => {
		const home = tempHome();
		await Promise.all([
			createDept({ paoHome: home, 名字: "AuditDemo" }),
			createDept({ paoHome: home, 名字: "auditdemo" }),
		]);
		const rows = readRegistry(join(home, "部门", "注册表.md"));
		expect(rows).toHaveLength(1);
		expect(rows[0].名字).toBe("AuditDemo");
	});

	it("历史冲突数据保持可见,不自动合并也不删除（只挡新增行）", async () => {
		const home = tempHome();
		const registryPath = join(home, "部门", "注册表.md");
		mkdirSync(join(home, "部门"), { recursive: true });
		// 模拟修复前留下的现场：两行指向同一目录
		writeFileSync(
			registryPath,
			[
				"# 部门注册表",
				"",
				"| 名字 | 能力标签 | 库路径 | 建部日期 |",
				"| --- | --- | --- | --- |",
				"| AuditDemo | 审计 | 部门/AuditDemo/知识库 | 2026-10-14 |",
				"| auditdemo |  | 部门/auditdemo/知识库 | 2026-10-14 |",
				"",
			].join("\n"),
			"utf8",
		);
		await createDept({ paoHome: home, 名字: "AUDITDEMO" });
		// 既有的两行一个不删、一个不改（历史冲突可见）
		const rows = readRegistry(registryPath);
		expect(rows.map((entry) => entry.名字)).toEqual(["AuditDemo", "auditdemo"]);
		expect(readFileSync(registryPath, "utf8")).toContain("| auditdemo |");
	});
});

describe("注册表渲染(纯函数)", () => {
	const rows: DeptRegistryRow[] = [
		{ 名字: "后端", 标签: ["api", "数据库"], 库路径: "部门/后端/知识库" },
		{ 名字: "侦察", 标签: ["搜索"], 库路径: "部门/侦察/知识库" },
	];

	it("快照含全部部门行与「截至」日期,不自包 XML 标签(外层由 pi sections 机制补)", () => {
		const snapshot = renderRegistrySnapshot(rows, "2026-10-02");
		expect(snapshot).toContain("截至");
		expect(snapshot).toContain("2026-10-02");
		expect(snapshot).toContain("后端");
		expect(snapshot).toContain("api、数据库");
		expect(snapshot).toContain("部门/后端/知识库");
		expect(snapshot).toContain("侦察");
		expect(snapshot).toContain("部门/侦察/知识库");
		expect(snapshot).not.toContain("<pao_dept_registry");
	});

	it("注册表为空时渲染空态说明,不报错", () => {
		const snapshot = renderRegistrySnapshot([], "2026-10-02");
		expect(snapshot).toContain("为空");
		expect(snapshot).toContain("2026-10-02");
		expect(snapshot).not.toContain("<pao_dept_registry");
	});

	it("渲染函数从注册表文本读,不另有硬编码部门清单", async () => {
		const home = tempHome();
		await createDept({ paoHome: home, 名字: "写作", 标签: ["文档"] });
		const registryText = readFileSync(join(home, "部门", "注册表.md"), "utf8");
		const snapshot = renderRegistryText(registryText, "2026-10-02");
		expect(snapshot).toContain("写作");
		expect(snapshot).not.toContain("后端");
	});
});

describe("pao_create_dept 工具与启动渲染注册", () => {
	interface CapturedPi {
		tools: ToolDefinition[];
		handlers: Map<string, (event: never, ctx: never) => unknown>;
		pi: ExtensionAPI;
	}

	/** 极简注册口:截获工具与事件 handler,供直接调用(不接真实端点) */
	function capturePi(): CapturedPi {
		const tools: ToolDefinition[] = [];
		const handlers = new Map<string, (event: never, ctx: never) => unknown>();
		const pi = {
			registerTool: (tool: ToolDefinition) => tools.push(tool),
			on: (event: string, handler: (event: never, ctx: never) => unknown) => {
				handlers.set(event, handler);
				return () => {};
			},
		} as unknown as ExtensionAPI;
		return { tools, handlers, pi };
	}

	async function runBeforeAgentStart(captured: CapturedPi): Promise<Record<string, string>> {
		const sections: Record<string, string> = {};
		await captured.handlers.get("before_agent_start")!({ systemPromptOptions: { sections } } as never, {} as never);
		return sections;
	}

	it("注册 pao_create_dept 工具,执行即建部;PAO_HOME 缺失时报错不静默", async () => {
		const captured = capturePi();
		registerDeptTools(captured.pi, { paoHome: tempHome() });
		const tool = captured.tools.find((entry) => entry.name === "pao_create_dept");
		expect(tool).toBeDefined();
		const result = await tool!.execute("t1", { name: "后端" }, undefined, undefined, {} as never);
		expect((result.content[0] as { type: string; text: string }).text).toContain("后端");
		expect((result.details as CreateDeptReport).新建.length).toBeGreaterThan(0);

		const oldHome = process.env.PAO_HOME;
		delete process.env.PAO_HOME;
		try {
			const missing = capturePi();
			registerDeptTools(missing.pi, {});
			await expect(
				missing.tools[0].execute("t2", { name: "后端" }, undefined, undefined, {} as never),
			).rejects.toThrow(/PAO_HOME/);
		} finally {
			if (oldHome !== undefined) process.env.PAO_HOME = oldHome;
		}
	});

	it("before_agent_start 挂注册表快照 section;为空渲染空态;PAO_HOME 缺失不渲染不报错", async () => {
		const home = tempHome();
		await createDept({ paoHome: home, 名字: "后端", 标签: ["api"] });
		const captured = capturePi();
		registerDeptTools(captured.pi, { paoHome: home });
		const sections = await runBeforeAgentStart(captured);
		expect(sections.pao_dept_registry).toContain("后端");
		expect(sections.pao_dept_registry).toContain("截至");

		// 注册表为空(文件不存在)→ 空态说明
		const emptyHome = tempHome();
		const capturedEmpty = capturePi();
		registerDeptTools(capturedEmpty.pi, { paoHome: emptyHome });
		const emptySections = await runBeforeAgentStart(capturedEmpty);
		expect(emptySections.pao_dept_registry).toContain("为空");

		// PAO_HOME 缺失 → 不渲染、不报错
		const oldHome = process.env.PAO_HOME;
		delete process.env.PAO_HOME;
		try {
			const capturedNone = capturePi();
			registerDeptTools(capturedNone.pi, {});
			const noneSections = await runBeforeAgentStart(capturedNone);
			expect(noneSections.pao_dept_registry).toBeUndefined();
		} finally {
			if (oldHome !== undefined) process.env.PAO_HOME = oldHome;
		}
	});
});
