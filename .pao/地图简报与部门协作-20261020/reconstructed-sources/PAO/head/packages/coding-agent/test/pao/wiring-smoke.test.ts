/**
 * 接线冒烟(卡0001-0005 之外的接线层):总入口把各模块注册齐、缺档位配置不阻断、
 * /pao 路由与钩子把部门面板拼进渲染。真实 pi 会话加载的验证在接线 build 后以 CLI 冒烟补充。
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createCard } from "../../src/pao/cards/index.ts";
import { renderQueue } from "../../src/pao/cards/render.ts";
import { listPaoSubcommands, resetPaoSubcommandsForTest } from "../../src/pao/command-router.ts";
import paoExtension, { defaultCardsDir, renderDeptPanels } from "../../src/pao/index.ts";
import type { InspectionReport } from "../../src/pao/knowledge/inspect.ts";
import { patrolAfterInspect } from "../../src/pao/patrol/index.ts";
import { BRAND_SPINNER_FRAMES, BRAND_SPINNER_INTERVAL_MS } from "../../src/pao/ui/brand.ts";

/** 记录型 mock:够断言注册齐全与钩子行为即可 */
function mockPi() {
	const tools: string[] = [];
	const commands: string[] = [];
	const events: string[] = [];
	const messageRenderers: string[] = [];
	const commandDefs = new Map<
		string,
		{ handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown }
	>();
	const messages: { customType: string; text: string }[] = [];
	[];
	// 真实 pi 语义:同一事件多 handler 依次收（品牌指示器与首跑清单都挂 session_start）
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const indicators: Array<{ frames?: string[]; intervalMs?: number } | undefined> = [];
	return {
		tools,
		commands,
		commandDefs,
		messages,
		events,
		handlers,
		indicators,
		messageRenderers,
		pi: {
			registerTool: (tool: { name: string }) => void tools.push(tool.name),
			registerCommand: (
				name: string,
				def: {
					handler: (args: string, ctx: unknown) => Promise<void>;
					getArgumentCompletions?: (prefix: string) => unknown;
				},
			) => {
				commands.push(name);
				commandDefs.set(name, def);
			},
			registerVirtualModel: () => undefined,
			registerMessageRenderer: (customType: string) => void messageRenderers.push(customType),
			on: (event: string, handler?: (event: unknown, ctx: unknown) => unknown) => {
				events.push(event);
				if (handler) handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			sendMessage: (message: { customType: string; content: { text: string }[] }) =>
				void messages.push({ customType: message.customType, text: message.content[0]?.text ?? "" }),
		},
	};
}

const tempRoot = mkdtempSync(join(tmpdir(), "pao-wiring-"));
afterAll(() => {
	rmSync(tempRoot, { recursive: true, force: true });
});

describe("pao 接线冒烟", () => {
	it("总入口注册全部工具与命令(卡片/知识/worker/协作/建部),档位缺配置不抛", async () => {
		const mock = mockPi();
		expect(() => paoExtension(mock.pi as never, { resolvePaoHome: () => tempRoot })).not.toThrow();
		for (const name of [
			"pao_create_card",
			"pao_submit_receipt",
			"pao_change_status",
			"pao_query_queue",
			"pao_collab_relay",
			"pao_inventory",
			"pao_stop_background",
			"pao_query_kb",
			"pao_restricted_query",
			"pao_ingest_kb",
			"pao_inspect_kb",
			"pao_create_dept",
			"pao_fanout",
			"pao_spawn_minister",
			"pao_dismiss_minister",
			// S8 会话 todo(全角色注册,不进任何 SKIPPED 清单)
			"todo_write",
		]) {
			expect(mock.tools).toContain(name);
		}
		// 命令统一(2026-10-03):唯一 pao 命令;中文命令名全删。例外:S8-TUI1 /todo 常驻摘要的
		// 展开/收起切换(英文命令名,全角色,计划 §S8 条 6 授权的折叠展开交互入口)。
		expect(mock.commands).toEqual(["todo", "pao"]);
		resetPaoSubcommandsForTest();
		paoExtension(mock.pi as never, { resolvePaoHome: () => tempRoot });
		expect(
			listPaoSubcommands(mock.pi as never)
				.map((sub) => sub.name)
				.sort(),
		).toEqual([
			"collab",
			"context",
			"flow",
			"memory",
			"model",
			"pano",
			"pending",
			"preflight",
			"queue",
			"recipe-del",
			"runtime",
			"status",
		]);
		// 品牌指示器:session_start 时把加载动画帧换成 pao 字母循环;
		// 首跑清单(§16.1)同事件挂载——fire 全部 handler 两件都该活
		const sessionStarts = mock.handlers.get("session_start") ?? [];
		expect(sessionStarts.length).toBeGreaterThanOrEqual(2);
		for (const handler of sessionStarts) {
			await handler(undefined, {
				sessionManager: { getSessionId: () => "wiring-smoke", getBranch: () => [], getEntries: () => [] },
				ui: {
					setStatus: vi.fn(),
					notify: vi.fn(),
					setWorkingIndicator: (o?: { frames?: string[]; intervalMs?: number }) => void mock.indicators.push(o),
				},
			});
		}
		for (const handler of mock.handlers.get("session_shutdown") ?? [])
			await handler(undefined, {
				ui: {},
				sessionManager: { getSessionId: () => "wiring-smoke", getEntries: () => [] },
			});
		expect(mock.indicators).toContainEqual({
			frames: [...BRAND_SPINNER_FRAMES],
			intervalMs: BRAND_SPINNER_INTERVAL_MS,
		});
		// 面板渲染器(美化·一批):5 个既有 customType + 全景(三批接线前先占位标签)
		for (const customType of [
			"pao-status",
			"pao-queue",
			"pao-workflow",
			"pao-firstrun",
			"pao-dispatch",
			"pao-panorama",
			"pao-panel",
		]) {
			expect(mock.messageRenderers).toContain(customType);
		}
		// 档位配置缺失:工厂不抛(接线层 catch 后警告),警告路径已被 not.toThrow 覆盖
	});

	it("缺 PAO_HOME 不连坐 pao 命令与 model 子命令(2026-10-03 真机教训:裸起时 tiers 抛错曾把 model 命令连坐跳过)", () => {
		const mock = mockPi();
		resetPaoSubcommandsForTest();
		expect(() =>
			paoExtension(mock.pi as never, {
				resolvePaoHome: () => {
					throw new Error(
						"缺少环境变量 PAO_HOME(使用现场根目录,应含「部门/」与「pao配置/」;开发仓与使用现场是两个仓库)",
					);
				},
			}),
		).not.toThrow();
		// pao 命令与 model 子命令独立注册:注册本身零配置依赖,缺配置由 run 内兜底报错
		expect(mock.commands).toContain("pao");
		expect(listPaoSubcommands(mock.pi as never).map((sub) => sub.name)).toContain("model");
	});

	it("pao 命令路由:裸敲开面板占位;未知子命令报可用清单;已知子命令分发", async () => {
		const mock = mockPi();
		resetPaoSubcommandsForTest();
		paoExtension(mock.pi as never, { resolvePaoHome: () => tempRoot });
		const pao = mock.commandDefs.get("pao");
		expect(pao).toBeDefined();
		// 裸敲:面板占位页(customType pao-panel,列出子命令)
		await pao!.handler("", { ui: {} });
		expect(mock.messages[0].customType).toBe("pao-panel");
		expect(mock.messages[0].text).toContain("queue");
		// 未知子命令:无 notify 时经 sendMessage 发帮助文本
		await pao!.handler("不存在", { ui: {} });
		expect(mock.messages[1].text).toContain("未知的 pao 子命令");
		expect(mock.messages[1].text).toContain("queue");
		// 未知子命令:有 notify 时走 notify
		const notify = vi.fn();
		await pao!.handler("不存在2", { ui: { notify } });
		expect(notify).toHaveBeenCalledOnce();
		// 补全:敲 /pao 弹出子命令项
		const completions = pao!.getArgumentCompletions?.("") as { value: string }[] | null;
		expect(completions?.map((item) => item.value)).toContain("queue");
	});

	it("部门面板:注册表有部门时输出 待验证积压 与 ⚠️;无注册表返回空", async () => {
		expect(await renderDeptPanels(join(tempRoot, "不存在"))).toEqual([]);
		const home = join(tempRoot, "home1");
		const lib = join(home, "部门", "测试部", "知识库");
		mkdirSync(join(lib, "待验证"), { recursive: true });
		writeFileSync(join(lib, "待验证", "候选1.md"), "# 钩子\n", "utf8");
		writeFileSync(join(lib, "待验证", "候选2.md"), "# 钩子\n", "utf8");
		mkdirSync(join(lib, "教训"), { recursive: true });
		writeFileSync(join(lib, "教训", "子索引.md"), "# 教训 子索引\n\n- [a](a.md) — 钩子 ⚠️ 超期未核\n", "utf8");
		writeFileSync(
			join(home, "部门", "注册表.md"),
			"| 名字 | 能力标签 | 库路径 |\n| --- | --- | --- |\n| 测试部 | 测试 | 部门/测试部/知识库 |\n",
			"utf8",
		);
		const panels = await renderDeptPanels(home);
		expect(panels).toHaveLength(1);
		expect(panels[0]).toContain("⚠ - 测试部:待验证 2 条"); // 二批图形化：有积压行首 ⚠
		expect(panels[0]).toContain("教训 1");
	});

	it("appendQueueSections 拼接:/pao queue 渲染 = 卡片队列 + 部门面板(接线结构与钩子行为)", async () => {
		const cardsDir = join(tempRoot, "cards");
		mkdirSync(cardsDir, { recursive: true });
		await createCard(cardsDir, { 目标: "接线冒烟", 部门: "核心机制", 验收: "面板拼上", 创建: "2026-10-02 03:00" });
		const home = join(tempRoot, "home2");
		const lib = join(home, "部门", "示例部", "知识库");
		mkdirSync(join(lib, "待验证"), { recursive: true });
		writeFileSync(join(lib, "待验证", "候选.md"), "# 钩子\n", "utf8");
		writeFileSync(
			join(home, "部门", "注册表.md"),
			"| 名字 | 能力标签 | 库路径 |\n| --- | --- | --- |\n| 示例部 | 示例 | 部门/示例部/知识库 |\n",
			"utf8",
		);
		const panels = await renderDeptPanels(home);
		const combined = [renderQueue([]), ...panels].join("\n\n");
		expect(combined).toContain("队列为空");
		expect(combined).toContain("部门知识面板");
		// 钩子注入路径在 tools.ts 已有实现;此处验证接线层的拼装约定
		expect(defaultCardsDir(join(tempRoot, "proj"))).toBe(join(tempRoot, "proj", ".pao", "卡"));
	});

	it("巡库卡接线:注册表部门过阈值落卡到本部卡目录;不在注册表只提示;未过阈值无提示", async () => {
		const home = join(tempRoot, "home3");
		const cardsDir = join(tempRoot, "cards3");
		mkdirSync(cardsDir, { recursive: true });
		mkdirSync(join(home, "部门"), { recursive: true });
		writeFileSync(
			join(home, "部门", "注册表.md"),
			"| 名字 | 能力标签 | 库路径 |\n| --- | --- | --- |\n| 测试部 | 测试 | 部门/测试部/知识库 |\n",
			"utf8",
		);
		const afterInspect = patrolAfterInspect(
			() => home,
			() => cardsDir,
		);
		const reportOf = (n: number): InspectionReport => ({
			findings: Array.from({ length: n }, (_, i) => ({
				flagged: true,
				problems: ["超期未核"],
				relPath: `教训/e${i}.md`,
			})),
			flaggedCount: n,
		});

		// 未过阈值(3 < 5):无提示,不落卡
		expect(await afterInspect(reportOf(3), join(home, "部门", "测试部", "知识库"))).toBeUndefined();
		expect(readdirSync(cardsDir)).toHaveLength(0);

		// 过阈值(6 ≥ 5)且库在注册表:落巡库卡到本部卡目录
		const hit = await afterInspect(reportOf(6), join(home, "部门", "测试部", "知识库"));
		expect(hit).toContain("已落巡库卡");
		const files = readdirSync(cardsDir);
		expect(files).toHaveLength(1);
		expect(files[0]).toContain("巡库");

		// 幂等:再巡一次仍只有一张
		const again = await afterInspect(reportOf(7), join(home, "部门", "测试部", "知识库"));
		expect(again).toContain("不重复落卡");
		expect(readdirSync(cardsDir)).toHaveLength(1);

		// 库不在注册表:只提示不落卡
		const unknown = await afterInspect(reportOf(6), join(tempRoot, "野库"));
		expect(unknown).toContain("不在部门注册表");
	});
});
