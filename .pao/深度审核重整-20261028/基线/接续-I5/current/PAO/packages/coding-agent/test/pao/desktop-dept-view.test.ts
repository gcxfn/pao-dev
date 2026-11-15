/**
 * 桌面部门只读投影（src/pao/desktop/dept.ts）验收：
 * 目录字段齐全、问题项带真实路径、跨会话拒绝、越界拒绝、负载与卡目录实际数量一致。
 * 全部用隔离临时 PAO_HOME 与临时项目根，不碰正式 PAO_HOME，不调真实供应商。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { createDept } from "../../src/pao/dept/scaffold.ts";
import { DEPT_SUMMARY_LIMIT, readDesktopDeptCatalog, readDesktopDeptDetail } from "../../src/pao/desktop/dept.ts";
import { registerDesktopOwner } from "../../src/pao/desktop/owners.ts";
import { readDesktopProjectFresh } from "../../src/pao/desktop/read-model.ts";
import type { MinisterHandle } from "../../src/pao/host/handle.ts";
import { TIER_CONFIG_RELATIVE_PATH } from "../../src/pao/routing/index.ts";

const tempDirs: string[] = [];
const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** 最小档位配置：两档（快/主力）+ 部门默认 */
function writeTiers(home: string, deptDefaults: Record<string, string> = {}): void {
	mkdirSync(join(home, "pao配置"), { recursive: true });
	const config = {
		provider: "pao",
		档位: [
			{ 名: "快", provider: "p", model: "m-fast", thinkingLevel: "low" },
			{ 名: "主力", provider: "p", model: "m-main", thinkingLevel: "high" },
		],
		部门默认: deptDefaults,
	};
	writeFileSync(join(home, TIER_CONFIG_RELATIVE_PATH), `${JSON.stringify(config, null, "\t")}\n`, "utf8");
}

/** 落一个真技能目录（pao配置/skills/<名>/SKILL.md） */
function writeSkill(home: string, name: string): void {
	mkdirSync(join(home, "pao配置", "skills", name), { recursive: true });
	writeFileSync(join(home, "pao配置", "skills", name, "SKILL.md"), `# ${name}\n\n技能说明\n`, "utf8");
}

/** 一个卡文件：只写 frontmatter 必需字段（与 cards/cardfile 的解析口径一致） */
function writeCard(cardsDir: string, number: number, dept: string, status: string): string {
	mkdirSync(cardsDir, { recursive: true });
	const path = join(cardsDir, `卡${String(number).padStart(4, "0")}-${dept}-验收.md`);
	const lines = [
		"---",
		`goal: 第 ${number} 张卡的验收目标`,
		`dept: ${dept}`,
		"acceptance: 有证据",
		"attempt: 1",
		"created: 2026-10-17 10:00",
		`status: ${status}`,
		"---",
		"",
		"正文",
		"",
	];
	writeFileSync(path, lines.join("\n"), "utf8");
	return path;
}

/** 注册一个桌面 owner 会话（真实 registerDesktopOwner，返回可注销的闭包） */
function makeOwner(ctx: { cwd: string; sessionId: string; ministers?: MinisterHandle[] }): void {
	const handlers = new Map<string, (event: unknown, context: ExtensionContext) => void>();
	const pi = {
		on: (name: string, handler: (event: unknown, context: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	const context = {
		cwd: ctx.cwd,
		sessionManager: { getSessionId: () => ctx.sessionId },
		isIdle: () => true,
		ui: { notify: () => undefined },
	} as unknown as ExtensionContext;
	registerDesktopOwner(pi, { getMinisters: () => ctx.ministers ?? [] });
	handlers.get("session_start")!({}, context);
	cleanups.push(() => handlers.get("session_shutdown")!({}, context));
}

/** 搭两个部门：写作（完整）+ 审查（缺配方/缺技能/档位不存在），返回临时 PAO_HOME 与项目根 */
async function setup(): Promise<{ home: string; project: string; sessionId: string }> {
	const home = tempDir("pao-desktop-dept-home-");
	const project = tempDir("pao-desktop-dept-project-");
	writeTiers(home);
	writeSkill(home, "review-checklist");
	// 完整部门：人设清楚、工具都在内置白名单、技能真实存在、档位有效
	await createDept({ paoHome: home, 名字: "写作", 标签: ["文案", "对外"] });
	writeFileSync(
		join(home, "部门", "写作", "配方.md"),
		[
			"# 配方:写作",
			"",
			"- 名字:写作",
			"- 人设:本部写对外文案,只管文字不管发布",
			"- 工具:read,grep",
			"- 技能:review-checklist",
			"- 默认档位:主力",
			"- 记忆目录:部门/写作/知识库",
			"- 部门标准:<部门/写作/知识库/索引.md>",
			"",
			"## 干法",
			"",
			"先读索引,再写正文。",
			"",
		].join("\n"),
		"utf8",
	);
	// 坏部门：配方声明了不存在的技能与不存在的档位
	await createDept({ paoHome: home, 名字: "审查", 标签: ["评审"] });
	writeFileSync(
		join(home, "部门", "审查", "配方.md"),
		[
			"# 配方:审查",
			"",
			"- 名字:审查",
			"- 人设:本部审别人的交付",
			"- 工具:read,frobnicate",
			"- 技能:missing-skill",
			"- 默认档位:不存在的档",
			"- 记忆目录:部门/审查/知识库",
			"",
			"## 干法",
			"",
			"按清单核。",
			"",
		].join("\n"),
		"utf8",
	);
	// 第三个部门：目录在、注册表也在，但配方文件被删掉——验证「缺配方」如实呈现
	await createDept({ paoHome: home, 名字: "断配方", 标签: [] });
	rmSync(join(home, "部门", "断配方", "配方.md"), { force: true });
	const sessionId = "desktop-dept-view";
	makeOwner({ cwd: project, sessionId });
	return { home, project, sessionId };
}

describe("部门目录只读投影", () => {
	it("目录字段齐全：名字/标签/档位/职责摘要/技能数/工具数/问题数/知识入口/配方路径", async () => {
		const { home, project, sessionId } = await setup();
		const catalog = readDesktopDeptCatalog(sessionId, project, { paoHome: home });
		expect(catalog.版本).toBe(1);
		expect(catalog.session).toBe(sessionId);
		expect(catalog.注册表路径).toBe(join(home, "部门", "注册表.md"));
		expect(catalog.部门.map((row) => row.名字)).toEqual(["写作", "审查", "断配方"]);

		const good = catalog.部门[0]!;
		expect(good.标签).toEqual(["文案", "对外"]);
		expect(good.默认档位).toBe("主力");
		expect(good.模型).toBe("pao/m-main");
		expect(good.职责摘要).toBe("本部写对外文案,只管文字不管发布");
		expect(good.技能数).toBe(1);
		expect(good.工具数).toBe(2);
		expect(good.问题数).toBe(0);
		expect(good.阻止启动数).toBe(0);
		expect(good.可用).toBe(true);
		expect(good.不可用原因).toBeUndefined();
		expect(good.知识入口).toBe(join(home, "部门", "写作", "知识库", "索引.md"));
		expect(good.配方路径).toBe(join(home, "部门", "写作", "配方.md"));

		// 坏部门：原值保留、问题点名、档位不猜
		const bad = catalog.部门[1]!;
		expect(bad.默认档位).toBe("不存在的档");
		expect(bad.模型).toBeNull();
		expect(bad.技能数).toBe(1);
		expect(bad.工具数).toBe(2);
		expect(bad.问题数).toBeGreaterThanOrEqual(3);
		// 阻止启动的有三项：缺技能 + 查无此档 + 表外工具「frobnicate」按警告计——这里只硬验前两项
		expect(bad.阻止启动数).toBeGreaterThanOrEqual(2);
		expect(bad.可用).toBe(false);
		expect(bad.不可用原因).toContain("不存在的档");

		const noRecipe = catalog.部门[2]!;
		expect(noRecipe.可用).toBe(false);
		expect(noRecipe.不可用原因).toContain("配方不可读");

		// 问题集带真实证据路径与修法；「工具/技能/人设」区别文案来自 dept/catalog 正本
		expect(catalog.问题.length).toBeGreaterThanOrEqual(3);
		expect(catalog.工具技能人设区别.length).toBe(3);
		expect(catalog.工具技能人设区别.map((row) => row.角色)).toEqual(["工具权限", "技能引用", "人设文字"]);
	});

	it("职责摘要只给首句且截断，正文不塞进投影；空人设显示空串", async () => {
		const { home, project, sessionId } = await setup();
		const long = `${"甲".repeat(DEPT_SUMMARY_LIMIT + 20)}。后半句不该出现`;
		writeFileSync(
			join(home, "部门", "写作", "配方.md"),
			`# 配方:写作\n\n- 名字:写作\n- 人设:${long}\n- 工具:read\n- 默认档位:主力\n`,
			"utf8",
		);
		const catalog = readDesktopDeptCatalog(sessionId, project, { paoHome: home });
		const row = catalog.部门.find((item) => item.名字 === "写作")!;
		expect(row.职责摘要.endsWith("…")).toBe(true);
		expect(row.职责摘要).toHaveLength(DEPT_SUMMARY_LIMIT + 1);
		expect(row.职责摘要).not.toContain("后半句不该出现");
		// 目录行不带配方原文
		expect(Object.keys(row)).not.toContain("配方原文");
	});
});

describe("单部门详情", () => {
	it("七段齐全：职责出处、工具白名单、技能真实路径、标准定位、知识入口只给元信息", async () => {
		const { home, project, sessionId } = await setup();
		const detail = await readDesktopDeptDetail(sessionId, project, "写作", { paoHome: home });
		expect(detail.名字).toBe("写作");
		expect(detail.标签).toEqual(["文案", "对外"]);
		expect(detail.库路径).toBe("部门/写作/知识库");
		expect(detail.路径.配方).toBe(join(home, "部门", "写作", "配方.md"));
		expect(detail.路径.知识库).toBe(join(home, "部门", "写作", "知识库"));

		// 职责：原文 + 真实出处，不复制到第二处
		expect(detail.职责.原文).toBe("本部写对外文案,只管文字不管发布");
		expect(detail.职责.出处).toBe(join(home, "部门", "写作", "配方.md"));
		expect(detail.职责.待填).toBe(false);

		// 工具：内置白名单，表外名原样保留并标非内置
		expect(detail.工具.白名单).toEqual([
			{ 名字: "read", 内置: true },
			{ 名字: "grep", 内置: true },
		]);

		// 技能：真实目录 + SKILL.md 是否存在
		expect(detail.技能).toHaveLength(1);
		expect(detail.技能[0]!.目录).toBe(join(home, "pao配置", "skills", "review-checklist"));
		expect(detail.技能[0]!.skillFile).toBe(join(home, "pao配置", "skills", "review-checklist", "SKILL.md"));
		expect(detail.技能[0]!.目录存在).toBe(true);
		expect(detail.技能[0]!.可用).toBe(true);

		// 默认档位：档名 → 真实模型。思考强度不随投影外发（脱敏口径统一遮蔽，见 context/redact）
		expect(detail.默认档位).toMatchObject({
			生效: "主力",
			来源: "配方",
			provider: "pao",
			model: "m-main",
		});

		// 标准：只给真实文件，可读
		expect(detail.标准).toEqual([
			{ 原始: "<部门/写作/知识库/索引.md>", 文件: join(home, "部门", "写作", "知识库", "索引.md"), 可读: true },
		]);

		// 知识入口：路径 + 可读 + 字节/行数，不带正文
		expect(detail.知识入口.索引.路径).toBe(join(home, "部门", "写作", "知识库", "索引.md"));
		expect(detail.知识入口.索引.可读).toBe(true);
		expect(detail.知识入口.索引.字节).toBeGreaterThan(0);
		expect(detail.知识入口.索引.行数).toBeGreaterThan(0);
		expect(detail.知识入口.索引.相对路径).toBe(join("部门", "写作", "知识库", "索引.md"));
		expect(Object.keys(detail.知识入口.索引)).toEqual(["路径", "相对路径", "可读", "字节", "行数"]);
		// 干法段只定位，不摘正文
		expect(detail.知识入口.干法?.路径).toBe(join(home, "部门", "写作", "配方.md"));

		expect(detail.配置问题).toEqual([]);
		expect(detail.读取问题).toEqual([]);
	});

	it("坏部门的问题项带真实路径与修法；旧值不被过滤成空列表", async () => {
		const { home, project, sessionId } = await setup();
		const detail = await readDesktopDeptDetail(sessionId, project, "审查", { paoHome: home });
		const recipe = join(home, "部门", "审查", "配方.md");
		const categories = detail.配置问题.map((issue) => issue.类别);
		expect(categories).toContain("技能");
		expect(categories).toContain("档位");
		expect(categories).toContain("工具");
		for (const issue of detail.配置问题) {
			expect(issue.修法.length).toBeGreaterThan(0);
			expect(issue.证据.length).toBeGreaterThan(0);
		}
		const missingSkill = detail.配置问题.find((issue) => issue.类别 === "技能")!;
		expect(missingSkill.证据).toBe(join(home, "pao配置", "skills", "missing-skill"));
		expect(missingSkill.级别).toBe("阻止启动");
		const badTier = detail.配置问题.find((issue) => issue.类别 === "档位")!;
		expect(badTier.证据).toBe(recipe);
		// 旧无效值原样保留
		expect(detail.技能.map((skill) => skill.引用)).toEqual(["missing-skill"]);
		expect(detail.技能[0]!.目录存在).toBe(false);
		expect(detail.技能[0]!.可用).toBe(false);
		expect(detail.工具.白名单).toEqual([
			{ 名字: "read", 内置: true },
			{ 名字: "frobnicate", 内置: false },
		]);
		// 查无此档不猜模型
		expect(detail.默认档位.生效).toBe("不存在的档");
		expect(detail.默认档位.model).toBeNull();
		expect(detail.默认档位.未配置原因).toContain("快、主力");
	});

	it("缺配方部门：职责出处为 null、技能/标准为空，但条目仍在目录里", async () => {
		const { home, project, sessionId } = await setup();
		const detail = await readDesktopDeptDetail(sessionId, project, "断配方", { paoHome: home });
		expect(detail.职责.原文).toBe("");
		expect(detail.职责.出处).toBeNull();
		expect(detail.技能).toEqual([]);
		expect(detail.标准).toEqual([]);
		expect(detail.配置问题.some((issue) => issue.级别 === "阻止启动" && issue.类别 === "配方")).toBe(true);
	});

	it("未登记部门报错并说清目录在不在，不自动建部、不返回空对象", async () => {
		const { home, project, sessionId } = await setup();
		await expect(readDesktopDeptDetail(sessionId, project, "查无此部", { paoHome: home })).rejects.toThrow("未登记");
		mkdirSync(join(home, "部门", "野生部门"), { recursive: true });
		await expect(readDesktopDeptDetail(sessionId, project, "野生部门", { paoHome: home })).rejects.toThrow(
			"没有该部门",
		);
		await expect(readDesktopDeptDetail(sessionId, project, "  ", { paoHome: home })).rejects.toThrow("部门名为空");
	});
});

describe("负载：与本进程热部长、卡目录、控制清单同源", () => {
	it("卡片总数/活卡数/归档卡数与卡目录实际条数一致，热部长只算本项目本部门", async () => {
		const project = tempDir("pao-desktop-dept-load-");
		const home = tempDir("pao-desktop-dept-home-");
		const other = tempDir("pao-desktop-dept-other-");
		writeTiers(home);
		await createDept({ paoHome: home, 名字: "写作", 标签: [] });
		// 「审查」也要真登记：投影只认注册表名字（未登记部门不参与任何计数）
		await createDept({ paoHome: home, 名字: "审查", 标签: [] });
		const cardsDir = join(project, ".pao", "卡");
		writeCard(cardsDir, 1, "写作", "unclaimed");
		writeCard(cardsDir, 2, "写作", "in_progress");
		writeCard(cardsDir, 3, "写作", "delivered");
		writeCard(cardsDir, 4, "写作", "canceled");
		writeCard(cardsDir, 5, "审查", "unclaimed");
		mkdirSync(join(project, ".pao", "归档"), { recursive: true });
		writeFileSync(join(project, ".pao", "归档", "卡0001-写作-旧稿.md"), "# 旧\n", "utf8");
		writeFileSync(join(project, ".pao", "归档", "卡0002-审查-旧稿.md"), "# 旧\n", "utf8");
		const sessionId = "desktop-dept-load";
		const ministers = [
			{ 部门: "写作", 项目根: project },
			{ 部门: "写作", 项目根: project },
			{ 部门: "写作", 项目根: other },
			{ 部门: "审查", 项目根: project },
		] as unknown as MinisterHandle[];
		makeOwner({ cwd: project, sessionId, ministers });
		const detail = await readDesktopDeptDetail(sessionId, project, "写作", { paoHome: home });
		expect(detail.负载.卡片总数).toBe(4);
		expect(detail.负载.活卡数).toBe(2);
		expect(detail.负载.归档卡数).toBe(1);
		expect(detail.负载.热部长数).toBe(2);
		// 卡目录里另一个部门的卡不计入本部门（卡快照是唯一读数口径）
		const cardsOnly = (await readDesktopProjectFresh(project, sessionId)).cards.filter(
			(card) => card.frontmatter.dept === "审查",
		);
		expect(cardsOnly).toHaveLength(1);
	});
});

describe("会话与越界防护", () => {
	it("跨会话/换项目一律拒绝，不返回别人的数据", async () => {
		const { home, project, sessionId } = await setup();
		expect(() => readDesktopDeptCatalog("other-session", project, { paoHome: home })).toThrow("owner 不可用");
		expect(() => readDesktopDeptCatalog(sessionId, join(project, "别处"), { paoHome: home })).toThrow("owner 不可用");
		await expect(readDesktopDeptDetail("other-session", project, "写作", { paoHome: home })).rejects.toThrow(
			"owner 不可用",
		);
	});

	it("知识入口被注册表指到 PAO_HOME 之外时报越界，不静默返回空", async () => {
		const { home, project, sessionId } = await setup();
		const outside = tempDir("pao-desktop-dept-outside-");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "索引.md"), "# 外部索引\n", "utf8");
		// 唯一能逃出 PAO_HOME 的入口是注册表「库路径」（部门目录/配方都是 join(paoHome, ...) 得来）——
		// 这里把写作的库路径改成 PAO_HOME 外的绝对路径，知识入口与知识库都必须拒绝。
		writeFileSync(
			join(home, "部门", "注册表.md"),
			[
				"| 名字 | 能力标签 | 库路径 | 建部日期 |",
				"| --- | --- | --- | --- |",
				`| 写作 | 文案 | ${outside} | 2026-10-17 |`,
				"",
			].join("\n"),
			"utf8",
		);
		expect(() => readDesktopDeptCatalog(sessionId, project, { paoHome: home })).toThrow("越出 PAO_HOME 或项目根");
		await expect(readDesktopDeptDetail(sessionId, project, "写作", { paoHome: home })).rejects.toThrow(
			"越出 PAO_HOME 或项目根",
		);
	});

	it("不传 paoHome 时按环境变量 PAO_HOME 解析（与其它读桥同一解析点）", async () => {
		const { home, project, sessionId } = await setup();
		const previous = process.env.PAO_HOME;
		process.env.PAO_HOME = home;
		try {
			const catalog = readDesktopDeptCatalog(sessionId, project);
			expect(catalog.paoHome).toBe(home);
			expect(catalog.部门).toHaveLength(3);
		} finally {
			if (previous === undefined) delete process.env.PAO_HOME;
			else process.env.PAO_HOME = previous;
		}
	});
});
