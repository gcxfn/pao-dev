/**
 * §21 /状态 先行区单测：任务区/部门区/用量区/后台值守区四段结构、空态、
 * 后台区三态（空闲/计数/未接入）、数据源同源（renderAllQueues/renderDeptPanels 复用不新造）、
 * 命令注册与 worker 角色门控（与 /队列 同款口径）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { listPaoSubcommands, resetPaoSubcommandsForTest } from "../../src/pao/command-router.ts";
import { formatRegistry } from "../../src/pao/dept/registry.ts";
import { registerStatusCommand, renderStatusPage } from "../../src/pao/status/index.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-status-"));
	tempDirs.push(dir);
	return dir;
}

function capturePi() {
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const messages: { customType: string; text: string }[] = [];
	const pi = {
		registerCommand: (
			name: string,
			options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> },
		) => commands.set(name, options),
		registerTool: () => {},
		on: () => {},
		registerMessageRenderer: () => {},
		sendMessage: (message: { customType: string; content: { text: string }[] }) =>
			messages.push({ customType: message.customType, text: message.content[0].text }),
	} as unknown as ExtensionAPI;
	resetPaoSubcommandsForTest();
	const runSub = async (name: string, args = "", ctx: unknown = {}) => {
		const sub = listPaoSubcommands(pi).find((entry) => entry.name === name);
		if (!sub) throw new Error(`子命令 ${name} 未注册`);
		await sub.run(pi, args, ctx);
	};
	return { commands, messages, pi, runSub };
}

describe("renderStatusPage 三段结构（§21 先行区）", () => {
	it("有部门注册表：任务区＋部门区（待验证与⚠️）＋未做区说明三段", async () => {
		const home = tempDir();
		// 部门注册表＋库目录（待验证 1 条＋教训区 ⚠️ 1 行）
		mkdirSync(join(home, "部门", "测试部", "知识库", "待验证"), { recursive: true });
		writeFileSync(
			join(home, "部门", "注册表.md"),
			formatRegistry([{ 名字: "测试部", 标签: ["qa"], 库路径: "部门/测试部/知识库" }]),
			"utf8",
		);
		writeFileSync(join(home, "部门", "测试部", "知识库", "待验证", "候选1.md"), "内容", "utf8");
		mkdirSync(join(home, "部门", "测试部", "知识库", "教训"), { recursive: true });
		writeFileSync(join(home, "部门", "测试部", "知识库", "教训", "子索引.md"), "- 条目 ⚠️ 需复核\n- 正常条目", "utf8");
		const text = await renderStatusPage(home);
		expect(text).toContain("── 任务区");
		expect(text).toContain("尚无服务过的项目记录"); // renderAllQueues 同源空态
		expect(text).toContain("── 部门区");
		expect(text).toContain("测试部");
		expect(text).toContain("待验证 1 条");
		expect(text).toContain("教训 1");
		expect(text).toContain("── 用量区（跨会话累计 · 用量账.jsonl）──");
		expect(text).toContain("尚无跨会话账");
		expect(text).toContain("── 后台/值守区 ──");
		expect(text).toContain("后台扇出:未接入");
	});

	it("空 PAO_HOME：任务区空态＋部门区空态说明,不抛错", async () => {
		const text = await renderStatusPage(tempDir());
		expect(text).toContain("尚无服务过的项目记录");
		expect(text).toContain("尚无部门注册");
		expect(text).toContain("尚无跨会话账");
		expect(text).toContain("── 后台/值守区 ──");
	});

	it("分区读失败互不拖垮（paoHome 不可解析路径时逐区降级行）", async () => {
		const text = await renderStatusPage(join(tempDir(), "不存在"));
		expect(text).toContain("任务区");
		expect(text).toContain("部门区");
	});
});

describe("后台区三态（§21 接入：fanout 运行态计数）", () => {
	it("全零：空闲说明行＋R25 运行态标注", async () => {
		const text = await renderStatusPage(tempDir(), { in_flight: 0, completed_unread: 0 });
		expect(text).toContain("○ 后台扇出:空闲"); // 二批图形化：空闲行首 ○
		expect(text).toContain("pao_fanout background:true 受理后");
		expect(text).toContain("R25");
		expect(text).toContain("值守区:随 §16.2 桌面在场调度（M3）");
	});

	it("在途/完成未读非零：计数行如实显示", async () => {
		const text = await renderStatusPage(tempDir(), { in_flight: 2, completed_unread: 1 });
		expect(text).toContain("◉ 后台扇出:在途 2 批 · 完成未读 1 批"); // 二批图形化：在途行首 ◉
		expect(text).toContain("完成摘要下一轮自动注入");
		expect(text).toContain("重启归零");
	});

	it("未接入（后台计数未传）：如实标注,不冒充空闲", async () => {
		const text = await renderStatusPage(tempDir());
		expect(text).toContain("◌ 后台扇出:未接入"); // 二批图形化：未接入行首 ◌
	});

	it("registerStatusCommand 带 后台计数：handler 输出含计数行", async () => {
		const captured = capturePi();
		registerStatusCommand(captured.pi, {
			resolvePaoHome: () => tempDir(),
			后台计数: () => ({ in_flight: 1, completed_unread: 0 }),
		});
		await captured.runSub("status", "", {});
		expect(captured.messages[0].text).toContain("后台扇出:在途 1 批");
	});
});

describe("/pao status 子命令注册与角色门控", () => {
	it("registerStatusCommand：挂 status 子命令,run 渲染全文 sendMessage（customType pao-status）", async () => {
		const home = tempDir();
		const captured = capturePi();
		registerStatusCommand(captured.pi, { resolvePaoHome: () => home });
		const sub = listPaoSubcommands(captured.pi).find((entry) => entry.name === "status");
		expect(sub).toBeDefined();
		expect(sub?.description).toContain("纯读");
		await sub?.run(captured.pi, "", {});
		expect(captured.messages).toHaveLength(1);
		expect(captured.messages[0].customType).toBe("pao-status");
		expect(captured.messages[0].text).toContain("── 任务区");
	});

	it("接线门控：主控/部长装 /pao 与 status 子命令,worker 不装", async () => {
		const home = tempDir();
		const { default: paoExtension } = await import("../../src/pao/index.ts");
		for (const role of ["", "部长"]) {
			vi.stubEnv("PAO_ROLE", role);
			const captured = capturePi();
			paoExtension(captured.pi, { resolvePaoHome: () => home });
			expect(captured.commands.has("pao")).toBe(true);
		}
		vi.stubEnv("PAO_ROLE", "worker");
		const workerCaptured = capturePi();
		paoExtension(workerCaptured.pi, { resolvePaoHome: () => home });
		expect(workerCaptured.commands.has("pao")).toBe(false);
	});
});
