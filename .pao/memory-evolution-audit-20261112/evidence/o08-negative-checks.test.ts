/**
 * O08 独立复核：任务书验收口径中未被现有用例直接断言的反面场景。
 *
 * 1) 浏览不记执行：resolve 成果版本后不交回执 → artifact_uses 必须为空。
 *    （复用归因只挂在回执边界；resolve 只读不记 use。）
 * 2) 登记失败只补登记不重跑：登记回调抛异常 → 回执仍落定（已记录），
 *    工具返回留痕，不抛、不重跑；artifact_versions 可为空但回执在卡上。
 * 3) 存量无前推回执如实「结果待核」：无 verdict 前缀的 receipt_ref →
 *    decodeArtifactReceiptRef 给 verdict=undefined（页面显示有回执/结果待核），
 *    不冒充已验证。fail 前缀 → verdict=fail（失败不显示成功）。
 *
 * 运行：cd packages/coding-agent && node ../../node_modules/vitest/vitest.mjs run <this> --maxWorkers=1
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@pao/ai";
import { afterEach, describe, expect, it } from "vitest";

import type { ExtensionAPI, ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createCard, loadCard } from "../../src/pao/cards/index.ts";
import { registerCardTools } from "../../src/pao/cards/tools.ts";
import {
	makeRegisterReceiptArtifacts,
	type ArtifactRegistrationDeps,
} from "../../src/pao/memory/artifact-registration.ts";
import { decodeArtifactReceiptRef } from "../../src/pao/memory/artifacts.ts";
import { registerBuiltinMemory, type BuiltinMemoryRegistration } from "../../src/pao/memory/tools.ts";
import { openMemoryStore } from "../../src/pao/memory/store.ts";

const roots: string[] = [];
const AT = "2026-11-15T10:00:00.000Z";

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of roots.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Windows SQLite 句柄释放晚于 close。
		}
	}
});

interface RegisteredTool {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: ExtensionToolContext,
	) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

interface Fixture {
	home: string;
	project: string;
	cardsDir: string;
	pi: ExtensionAPI;
	tools: Map<string, RegisteredTool>;
	registration: BuiltinMemoryRegistration;
	sessionManager: SessionManager;
	ctx: ExtensionToolContext;
	close: () => Promise<void>;
}

function makeFixture(brokenRegister = false): Fixture {
	const root = tempDir("pao-o08-neg-");
	const home = join(root, "home");
	const project = join(root, "project");
	const cardsDir = join(project, ".pao", "卡");
	const sessions = join(root, "sessions");
	mkdirSync(join(home, "pao配置"), { recursive: true });
	mkdirSync(cardsDir, { recursive: true });
	mkdirSync(sessions, { recursive: true });

	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		registerCommand: () => undefined,
		sendMessage: () => undefined,
		appendEntry: () => undefined,
		on: () => () => undefined,
		getAllTools: () => [...tools.values()],
	} as unknown as ExtensionAPI;

	const registration = registerBuiltinMemory(pi, { paoHome: home });
	const deps: ArtifactRegistrationDeps = { registration: () => registration, pi, paoHome: () => home };

	registerCardTools(pi, {
		resolveCardsDir: () => cardsDir,
		registerReceiptArtifacts: brokenRegister
			? async () => {
					throw new Error("登记服务模拟崩溃");
				}
			: makeRegisterReceiptArtifacts(deps),
	});

	const sessionManager = SessionManager.create(project, sessions, { id: "o08-neg-session" });
	const ctx = { cwd: project, sessionManager } as unknown as ExtensionToolContext;
	return {
		home,
		project,
		cardsDir,
		pi,
		tools,
		registration,
		sessionManager,
		ctx,
		close: async () => {
			await registration.close();
		},
	};
}

function commitToolCallEntry(fx: Fixture, toolName: string, toolCallId: string, args: Record<string, unknown>): void {
	fx.sessionManager.appendMessage(
		fauxAssistantMessage([fauxToolCall(toolName, args as never, { id: toolCallId })], {
			timestamp: Date.now(),
		}),
	);
}

async function runTool(
	fx: Fixture,
	name: string,
	params: Record<string, unknown>,
	toolCallId = `call-${name}-1`,
): Promise<string> {
	commitToolCallEntry(fx, name, toolCallId, params);
	const tool = fx.tools.get(name);
	if (!tool) throw new Error(`工具未注册:${name}`);
	const result = await tool.execute(toolCallId, params, undefined, undefined, fx.ctx);
	return result.content.map((part) => part.text).join("\n");
}

async function seedArtifact(fx: Fixture): Promise<string> {
	const srcPath = join(fx.project, "前序成果.txt");
	writeFileSync(srcPath, "前序内容");
	const store = openMemoryStore(fx.home, "readwrite");
	try {
		store.db
			.prepare(
				`INSERT INTO sources (source_id, session_id, entry_id, event_type, captured_at)
				 VALUES ('src-seed', 'sess-seed', 'e-seed', 'user', ?)`,
			)
			.run(AT);
	} finally {
		store.close();
	}
	const registered = await fx.registration.service.registerArtifact({
		name: "可复用成果",
		scope: { projectId: "p1" },
		files: [{ name: "前序成果.txt", path: srcPath }],
		sourceIds: ["src-seed"],
		createdAt: AT,
	});
	expect(registered.ok).toBe(true);
	if (!registered.ok) throw new Error("seed failed");
	return registered.versions[0]!.versionId;
}

describe("O08 反面场景复核", () => {
	it("浏览不记执行：resolve 后无回执 → artifact_uses 空", async () => {
		const fx = makeFixture();
		try {
			const versionId = await seedArtifact(fx);
			const text = await runTool(fx, "pao_memory_resolve_artifact", { version_id: versionId });
			expect(text).toContain("成果:");
			const store = openMemoryStore(fx.home, "readwrite");
			try {
				const n = store.db
					.prepare("SELECT COUNT(*) AS n FROM artifact_uses WHERE version_id = ?")
					.get(versionId) as { n: number };
				expect(n.n).toBe(0);
			} finally {
				store.close();
			}
		} finally {
			await fx.close();
		}
	});

	it("登记失败只补登记不重跑：回调抛异常 → 回执落定 + 留痕，工具不抛", async () => {
		const fx = makeFixture(true);
		try {
			await createCard(fx.cardsDir, {
				目标: "登记失败场景",
				部门: "核心机制",
				验收: "回执落定",
				创建: "2026-11-15 10:00",
			});
			await runTool(fx, "pao_change_status", {
				cards_dir: fx.cardsDir,
				card_ref: 1,
				operator: "部长A",
				new_status: "in_progress",
			});
			const artifactPath = join(fx.project, "产物.txt");
			writeFileSync(artifactPath, "内容");
			const text = await runTool(fx, "pao_submit_receipt", {
				cards_dir: fx.cardsDir,
				card_ref: 1,
				attempt: 1,
				result: "完成",
				summary: "产物落盘",
				artifact_path: [artifactPath],
			});
			// 回执仍落定 + 工具文本含登记失败留痕。
			expect(text).toContain("回执已追加");
			expect(text).toContain("成果登记失败");
			expect(text).toContain("登记服务模拟崩溃");
			// 卡上回执真的写进去了（回执不被登记异常阻断）。
			const card = loadCard(fx.cardsDir, 1);
			expect(card.body).toContain("产物.txt");
			// 且没有半成品版本行。
			const store = openMemoryStore(fx.home, "readwrite");
			try {
				const n = store.db.prepare("SELECT COUNT(*) AS n FROM artifact_versions").get() as { n: number };
				expect(n.n).toBe(0);
			} finally {
				store.close();
			}
		} finally {
			await fx.close();
		}
	});

	it("失败/无前推如实：fail 前缀不冒充成功；无前推行=结果待核", async () => {
		// fail 前缀 → verdict=fail（页面显示验证未过，禁止标成功）。
		const failDec = decodeArtifactReceiptRef("fail:回执:卡0001.md#尝试1");
		expect(failDec.verdict).toBe("fail");
		expect(failDec.receiptRef).toBe("回执:卡0001.md#尝试1");
		// 存量无前推行 → verdict=undefined + ref 原样（页面「有回执/结果待核」）。
		const legacy = decodeArtifactReceiptRef("回执:旧卡.md#尝试1");
		expect(legacy.verdict).toBeUndefined();
		expect(legacy.receiptRef).toBe("回执:旧卡.md#尝试1");
		// 空/无回执 → 皆 undefined（页面「未验证」）。
		expect(decodeArtifactReceiptRef(null).verdict).toBeUndefined();
		expect(decodeArtifactReceiptRef(null).receiptRef).toBeUndefined();
	});
});
