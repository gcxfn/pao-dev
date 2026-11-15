/**
 * M1-04 todo 边界(G1-12 的一部分):rpiv-todo 只管单会话执行步骤,
 * 卡片(src/pao/cards)是跨会话任务唯一真相,todo 不得成为第二套任务进度。
 *
 * 验证对象是本机真实安装的 @juicesharp/rpiv-todo(用户级 pi 包,官方路径安装);
 * 未安装时这些用例跳过——边界约束不依赖包存在,存在时必须持续成立。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendReceipt, changeCardStatus, createCard, loadCard } from "../../src/pao/cards/index.ts";

/** 用户级 pi 包安装位置(pi install npm:... 落 ~/.pi/agent/npm/node_modules) */
const TODO_PKG_DIR = join(homedir(), ".pi", "agent", "npm", "node_modules", "@juicesharp", "rpiv-todo");
const TODO_PKG_INDEX = join(TODO_PKG_DIR, "index.ts");
const TODO_PKG_TODO_TS = join(TODO_PKG_DIR, "todo.ts");
const hasTodoPkg = existsSync(TODO_PKG_INDEX);

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-todo-"));
	tempDirs.push(dir);
	return dir;
}

describe.skipIf(!hasTodoPkg)("rpiv-todo 安装面(官方 pi 包路径)", () => {
	it("包已按官方路径安装且版本/许可证合规(记档:MIT @ 2.12.0)", () => {
		const manifest = JSON.parse(readFileSync(join(TODO_PKG_DIR, "package.json"), "utf8"));
		expect(manifest.name).toBe("@juicesharp/rpiv-todo");
		expect(manifest.license).toBe("MIT");
		expect(manifest.pi?.extensions).toContain("./index.ts");
	});

	it("注册面盘点:单工具 todo、/todos 命令,无 pao_ 命名冲突,不注册虚拟模型/MCP(间接入口检查)", () => {
		const indexSource = readFileSync(TODO_PKG_INDEX, "utf8");
		const todoSource = readFileSync(TODO_PKG_TODO_TS, "utf8");
		// 工具与命令(来自包源码常量与注册调用)
		expect(todoSource).toContain("name: TOOL_NAME");
		expect(indexSource).toContain("registerTodosCommand");
		// 不碰 PAO 命名空间与路由/生态入口
		expect(indexSource).not.toMatch(/registerVirtualModel/);
		expect(indexSource).not.toMatch(/registerMcpServer/);
		expect(indexSource).not.toMatch(/name:\s*"pao_/);
		expect(todoSource).not.toMatch(/name:\s*"pao_/);
		// 工具名就是 "todo"(tool/types.ts 常量),不与 pao_ 工具冲突
		expect(readFileSync(join(TODO_PKG_DIR, "tool", "types.ts"), "utf8")).toContain('TOOL_NAME = "todo"');
	});

	it("todo 状态不落盘:包内状态为会话内存槽+对话重放,无文件写入(不成为第二套跨会话真相)", () => {
		for (const rel of ["state/store.ts", "state/state.ts", "todo.ts"]) {
			const source = readFileSync(join(TODO_PKG_DIR, rel), "utf8");
			expect(source).not.toMatch(/writeFileSync|writeFile\(|fs\.promises\.writeFile/);
		}
	});
});

describe("卡片是跨会话任务唯一真相(pao 侧边界)", () => {
	it("建卡+交回执全程只在卡目录留下卡文件与计数器,无 todo 旁路存储", async () => {
		const workspace = tempDir();
		const cardDir = join(workspace, ".pao", "卡");
		const counterPath = join(workspace, ".pao", "卡号.txt");
		const card = await createCard(
			cardDir,
			{
				目标: "旁路文件检查",
				部门: "核心机制",
				验收: "无旁路文件",
				创建: "2026-10-02 12:00",
			},
			{ counterPath },
		);
		// 认领(尝试 0→1)后 worker 才能交回执;全程仍只有卡文件与计数器
		changeCardStatus(loadCard(cardDir, card.card_no), {
			操作者: "主控",
			to: "in_progress",
			时间: "2026-10-02 12:03",
		});
		appendReceipt(loadCard(cardDir, card.card_no), { 尝试号: 1, 时间: "2026-10-02 12:05", 结果: "完成" });

		const files = readdirSync(workspace, { recursive: true }).map(String);
		const bypass = files.filter((f) => /todo/i.test(f));
		expect(bypass).toEqual([]);
		expect(files.some((f) => f.includes(card.filename))).toBe(true);

		// 卡文件自身承载全部进度:状态由 owner 迁移记录在卡上,回执只追加
		const cardText = readFileSync(card.path, "utf8");
		expect(cardText).toContain("status: in_progress"); // 回执不改状态,owner 才改
		expect(cardText).toContain("## 回执 尝试1");
	});
});
