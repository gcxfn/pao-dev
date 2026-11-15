/**
 * §22 /model 档位化命令体单测：列表内容（档位行/当前标记/部门默认标记/三个入口）、
 * 选中切档（registry.find→pi.setModel）、args 直达、未注册警告、鉴权失败、
 * 引导式编辑流（写回＋备份＋重注册）、部门默认流、配置坏不炸、取消零副作用。
 * TUI 薄改道（interactive-mode 4 行）属接线面,由既有 wiring 冒烟与真实 TUI 手验覆盖。
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { listPaoSubcommands, resetPaoSubcommandsForTest } from "../../src/pao/command-router.ts";
import { loadTierConfig } from "../../src/pao/routing/config.ts";
import { registerModelCommand } from "../../src/pao/routing/model-command.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-model-cmd-"));
	tempDirs.push(dir);
	return dir;
}

const CONFIG = {
	provider: "pao",
	档位: [
		{ 名: "快", provider: "faux", model: "m-fast", thinkingLevel: "low" as const },
		{ 名: "主力", provider: "faux", model: "m-main", thinkingLevel: "high" as const },
	],
	部门默认: { 测试部: "主力" },
};

function setupConfig(): { dir: string; configPath: string } {
	const dir = tempDir();
	const configPath = join(dir, "档位.json");
	writeFileSync(configPath, JSON.stringify(CONFIG), "utf8");
	return { dir, configPath };
}

/** 假 Model(registry.find 返回) */
const FAKE_MODEL = { id: "快", provider: "pao", name: "快" };

/** 脚本化 ctx:select/confirm/input 按队列应答并记录全部弹窗 */
function makeCtx(
	script: { select?: (string | undefined)[]; confirm?: boolean[]; input?: (string | undefined)[] },
	currentModel = "主力",
) {
	const base = {
		selects: [] as { title: string; options: string[] }[],
		confirms: [] as string[],
		inputs: [] as string[],
		notifications: [] as { message: string; type?: string }[],
		model: currentModel ? { id: currentModel } : undefined,
		modelRegistry: {
			find: (_provider: string, id: string) =>
				id === CONFIG.档位[0].名 || id === CONFIG.档位[1].名 ? FAKE_MODEL : undefined,
			getAll: () => [
				{ provider: "faux", id: "m-fast" },
				{ provider: "faux", id: "m2-new" },
			],
		},
	};
	return {
		...base,
		ui: {
			select: async (title: string, options: string[]) => {
				base.selects.push({ title, options });
				return script.select?.shift();
			},
			confirm: async (_title: string, message: string) => {
				base.confirms.push(message);
				return script.confirm?.shift() ?? false;
			},
			input: async (title: string, _placeholder?: string) => {
				base.inputs.push(title);
				return script.input?.shift();
			},
			notify: (message: string, type?: "info" | "warning" | "error") => {
				base.notifications.push({ message, type });
			},
		},
	};
}

function capturePi() {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const setModels: unknown[] = [];
	const virtualModels: { id: string }[] = [];
	const pi = {
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, options),
		setModel: async (model: unknown) => {
			setModels.push(model);
			return true;
		},
		registerVirtualModel: (model: { id: string }) => virtualModels.push(model),
	} as unknown as ExtensionAPI;
	resetPaoSubcommandsForTest();
	return { commands, setModels, virtualModels, pi };
}

async function run(args: string, ctx: unknown, configPath?: string): Promise<ReturnType<typeof capturePi>> {
	const captured = capturePi();
	registerModelCommand(captured.pi, {
		configPath,
		resolvePaoHome: () => tempDir(),
	});
	const sub = listPaoSubcommands(captured.pi).find((entry) => entry.name === "model");
	if (!sub) throw new Error("model 子命令未注册");
	await sub.run(captured.pi, args, ctx);
	return captured;
}

describe("/pao model 档位制·列表与切换", () => {
	it("无参数:档位列表(行含物理模型·思考档/当前标记/部门默认标记)＋编辑/部门两入口(专家后门已随命令统一取消——原生 /model 即物理直选)", async () => {
		const ctx = makeCtx({ select: [undefined] });
		await run("", ctx, setupConfig().configPath);
		const main = ctx.selects[0];
		expect(main.title).toContain("档位");
		expect(main.options[0]).toBe("快 ＝ faux/m-fast·low");
		expect(main.options[1]).toBe("主力 ＝ faux/m-main·high（●当前｜部门默认:测试部）");
		expect(main.options).toContain("编辑档位…");
		expect(main.options).toContain("编辑部门默认…");
		expect(main.options.some((o) => o.includes("--物理"))).toBe(false); // 专家后门取消
	});

	it("选中档位行:registry.find 出虚拟模型→pi.setModel,notify 已切(本会话生效)", async () => {
		const ctx = makeCtx({ select: ["快 ＝ faux/m-fast·low"] });
		const captured = await run("", ctx, setupConfig().configPath);
		expect(captured.setModels).toEqual([FAKE_MODEL]);
		expect(ctx.notifications[0].message).toContain("已切到档位「快」");
	});

	it("args 直达档名(/pao model 快):不弹列表直接切", async () => {
		const ctx = makeCtx({});
		const captured = await run("快", ctx, setupConfig().configPath);
		expect(ctx.selects).toHaveLength(0);
		expect(captured.setModels).toHaveLength(1);
	});

	it("args 未知档名:报错列现有档并指原生 /model", async () => {
		const ctx = makeCtx({});
		await run("不存在的档", ctx, setupConfig().configPath);
		expect(ctx.notifications[0].message).toContain("未找到档位「不存在的档」");
		expect(ctx.notifications[0].message).toContain("原生 /model");
	});

	it("选中行不在行集内:显式 miss 报错不切档(旧文本前缀口径会静默吞掉)", async () => {
		const ctx = makeCtx({ select: ["伪造行 ＝ faux/m-fast·low"] });
		const captured = await run("", ctx, setupConfig().configPath);
		expect(ctx.notifications[0].message).toContain("未识别的档位选项");
		expect(captured.setModels).toHaveLength(0);
	});

	it("虚拟模型未注册(find 无):警告提示 reload 或编辑重注册,不 setModel", async () => {
		const ctx = makeCtx({}, "别的");
		// find 只认 快/主力;主列表两档都命中——用 args 直达一个 find 不认的名字走不到;
		// 改 registry.find 全 undefined 模拟
		ctx.modelRegistry.find = () => undefined;
		const captured = await run("快", ctx, setupConfig().configPath);
		expect(captured.setModels).toHaveLength(0);
		expect(ctx.notifications[0].message).toContain("未注册");
	});

	it("setModel 返回 false:notify 鉴权未配置(error)", async () => {
		const ctx = makeCtx({});
		const captured = capturePi();
		(captured.pi as unknown as { setModel: (m: unknown) => Promise<boolean> }).setModel = async () => false;
		registerModelCommand(captured.pi, { configPath: setupConfig().configPath, resolvePaoHome: () => tempDir() });
		const sub = listPaoSubcommands(captured.pi).find((entry) => entry.name === "model");
		await sub?.run(captured.pi, "快", ctx);
		expect(ctx.notifications[0].message).toContain("未配置鉴权");
	});

	it("配置坏:notify error 不炸", async () => {
		const dir = tempDir();
		const configPath = join(dir, "档位.json");
		writeFileSync(configPath, "{ 坏 json", "utf8");
		const ctx = makeCtx({});
		await run("", ctx, configPath);
		expect(ctx.notifications[0].message).toContain("档位配置读失败");
		expect(ctx.selects).toHaveLength(0);
	});
});

describe("/model 档位制·引导式编辑流", () => {
	it("改既有档:选档→选物理模型→选思考档→确认→写回(备份生成)＋重注册该档", async () => {
		const { dir, configPath } = setupConfig();
		const ctx = makeCtx({
			select: ["编辑档位…", "快 ＝ faux/m-fast·low", "faux/m2-new", "high"], // 桩须用真实行形状:严格按下标回取后,假后缀/假 ● 即显式 miss
			confirm: [true],
		});
		const captured = await run("", ctx, configPath);
		const reread = loadTierConfig(configPath);
		expect(reread.档位.find((t) => t.名 === "快")).toMatchObject({
			provider: "faux",
			model: "m2-new",
			thinkingLevel: "high",
		});
		expect(reread.部门默认).toEqual({ 测试部: "主力" }); // 未动的字段保留
		expect(readdirSync(dir).some((f) => f.startsWith("档位.json.bak-"))).toBe(true);
		expect(captured.virtualModels.map((m) => m.id)).toEqual(["快"]);
		expect(ctx.notifications.at(-1)?.message).toContain("已写回并重注册");
	});

	it("取消(confirm false):零写回零注册", async () => {
		const { configPath } = setupConfig();
		const ctx = makeCtx({
			select: ["编辑档位…", "快 ＝ faux/m-fast·low", "faux/m2-new", "low ●"],
			confirm: [false],
		});
		const captured = await run("", ctx, configPath);
		expect(loadTierConfig(configPath).档位.find((t) => t.名 === "快")?.model).toBe("m-fast");
		expect(captured.virtualModels).toHaveLength(0);
	});

	it("新建档位:input 档名→池选模型→档位→确认→追加落盘", async () => {
		const { configPath } = setupConfig();
		const ctx = makeCtx({
			select: ["编辑档位…", "新建档位…", "faux/m2-new", "medium"],
			input: ["省电"],
			confirm: [true],
		});
		await run("", ctx, configPath);
		const reread = loadTierConfig(configPath);
		expect(reread.档位.map((t) => t.名)).toEqual(["快", "主力", "省电"]);
		expect(reread.档位[2]).toMatchObject({ provider: "faux", model: "m2-new", thinkingLevel: "medium" });
	});

	it("手输 provider/model 后门:input 形如 zai/glm", async () => {
		const { configPath } = setupConfig();
		const ctx = makeCtx({
			select: ["编辑档位…", "新建档位…", "手输 provider/model…", "low ●"], // 新档缺省思考档 low→行带 ●,桩须与 levelRows 同形
			input: ["夜班", "zai-coding-cn/glm-5.3-flash"],
			confirm: [true],
		});
		await run("", ctx, configPath);
		expect(loadTierConfig(configPath).档位.find((t) => t.名 === "夜班")?.provider).toBe("zai-coding-cn");
	});

	it("部门默认流:改部门→选档→写回 部门默认 字段", async () => {
		const { configPath } = setupConfig();
		const ctx = makeCtx({
			select: ["编辑部门默认…", "测试部", "快"],
			confirm: [true],
		});
		await run("", ctx, configPath);
		expect(loadTierConfig(configPath).部门默认).toEqual({ 测试部: "快" });
		expect(ctx.notifications.at(-1)?.message).toContain("部门默认已写回:测试部=快");
	});

	it("部门默认·清除:选（清除）→写回后键删除", async () => {
		const { configPath } = setupConfig();
		const ctx = makeCtx({
			select: ["编辑部门默认…", "测试部", "（清除该部门默认）"],
			confirm: [true],
		});
		await run("", ctx, configPath);
		expect(loadTierConfig(configPath).部门默认).toEqual({});
	});
});
