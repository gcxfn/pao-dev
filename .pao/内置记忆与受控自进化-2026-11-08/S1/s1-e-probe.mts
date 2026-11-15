// S1 批次 E 探针：隔离 PAO_HOME 下验证「builtin 接线 → 三工具调用链」。
// 覆盖：registerMemory(供应商="builtin") 走内置路、registerCapture 挂上、
// pao_memory_write→getMemory→pao_memory_forget(stopped)→pao_memory_recall 如实降级、
// confirm 门、取消检查点、session_shutdown 统一收尾。
// mock 边界：ExtensionAPI 只 mock registerTool/on（捕获工具定义与事件处理器），
// 工具 ctx 只 mock cwd/sessionManager.getSessionId/signal——不经过真实会话/事件宿主，
// turn_end/agent_settled 采集链由 C 批探针覆盖，本探针只验证接线与工具语义。
// 运行：cd PAO/packages/coding-agent && node --experimental-transform-types ../../../.pao/内置记忆与受控自进化-2026-11-08/S1/s1-e-probe.mts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerMemory, BUILTIN_MEMORY_PROVIDER } from "../../../PAO/packages/coding-agent/src/pao/memory/index.ts";
import { openMemoryService } from "../../../PAO/packages/coding-agent/src/pao/memory/service.ts";
import { MemoryVendorManager } from "../../../PAO/packages/coding-agent/src/pao/memory/memory-vendor.ts";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) passed++;
	else failed++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}

const home = mkdtempSync(join(tmpdir(), "pao-mem-e-"));
console.log(`隔离 PAO_HOME: ${home}`);
const cwd = "D:\\AI\\workspace\\pao-dev";
const sessionId = "sess-e1";

// ── mock pi：捕获注册的工具与事件处理器 ──────────────────────────────
const tools = new Map<string, { execute: Function; name: string }>();
const handlers = new Map<string, Function[]>();
const pi = {
	registerTool(tool: { name: string; execute: Function }) {
		tools.set(tool.name, tool);
	},
	on(event: string, handler: Function) {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
		return () => {
			const idx = (handlers.get(event) ?? []).indexOf(handler);
			if (idx >= 0) handlers.get(event)!.splice(idx, 1);
		};
	},
};

// ── mock 工具执行上下文 ──────────────────────────────────────────────
const ctx = {
	cwd,
	sessionManager: {
		getSessionId: () => sessionId,
		getEntry: () => undefined,
		getBranch: () => [],
	},
};

async function callTool(name: string, params: unknown, signal?: AbortSignal) {
	const tool = tools.get(name);
	if (!tool) throw new Error(`工具未注册:${name}`);
	return await tool.execute(`tc-${Math.random().toString(36).slice(2, 8)}`, params, signal, undefined, ctx);
}

try {
	// ── 配置：供应商 = builtin ─────────────────────────────────────────
	mkdirSync(join(home, "pao配置"), { recursive: true });
	writeFileSync(
		join(home, "pao配置", "记忆供应商.json"),
		JSON.stringify({ 供应商: BUILTIN_MEMORY_PROVIDER, 参数: {} }),
		"utf8",
	);

	const registration = registerMemory(pi as never, { resolvePaoHome: () => home });
	check("builtin 配置返回注册结果", registration !== undefined);
	check("不是供应商管理器实例", !(registration instanceof MemoryVendorManager));
	check("三工具已注册", ["pao_memory_write", "pao_memory_recall", "pao_memory_forget"].every((n) => tools.has(n)));
	check("session_shutdown 已挂", (handlers.get("session_shutdown") ?? []).length >= 1);
	check("turn_end/agent_settled 采集已挂", (handlers.get("turn_end") ?? []).length >= 1 && (handlers.get("agent_settled") ?? []).length >= 1);
	check("库文件已建", existsSync(join(home, "memory", "memory.sqlite")));

	// ── 写入 ─────────────────────────────────────────────────────────
	const wrote = await callTool("pao_memory_write", { content: "决定:内置记忆用 SQLite" });
	check("写入成功", wrote.isError !== true && wrote.content[0].text.includes("已写入"), wrote.content[0].text);
	const idMatch = /mem-[0-9a-f-]+/.exec(wrote.content[0].text);
	check("返回记忆 ID", idMatch !== null, wrote.content[0].text);
	const memoryId = idMatch?.[0] ?? "";

	// ── 同实例 getMemory 回读（同一服务引用） ────────────────────────────
	const service = (registration as { service?: ReturnType<typeof openMemoryService> }).service;
	check("注册结果携带服务实例", service !== undefined);
	const got = await service!.getMemory({ id: memoryId });
	check("getMemory 回读成功", got.ok === true);
	if (got.ok) {
		check("kind=experience", got.memory.kind === "experience");
		check("evidenceKind=user_statement", got.memory.content.evidenceKind === "user_statement");
		check("confirmation=confirmed", got.memory.content.confirmation === "confirmed");
		check("scope.projectId 是规范全路径", got.memory.scope.projectId === cwd.toLowerCase(), got.memory.scope.projectId);
		check("scope.sessionId 来自 ctx", got.memory.scope.sessionId === sessionId);
		check("usageState=active", got.memory.usageState === "active");
		check("来源摘要含 toolcall entryId", got.sourceSummaries.some((s) => s.entryId.startsWith("toolcall-")), JSON.stringify(got.sourceSummaries));
		check("来源 eventType=toolcall", got.sourceSummaries.every((s) => s.eventType === "toolcall"));
	}

	// ── 忘却：confirm 门 ─────────────────────────────────────────────
	const refused = await callTool("pao_memory_forget", { memory_id: memoryId, confirm: false });
	check("confirm=false 拒绝", refused.content[0].text.includes("拒绝") || refused.content[0].text.includes("授权"));
	const afterRefuse = await service!.getMemory({ id: memoryId });
	check("拒绝后仍 active", afterRefuse.ok === true && afterRefuse.memory.usageState === "active");

	const forgot = await callTool("pao_memory_forget", { memory_id: memoryId, confirm: true });
	check(
		"停用成功且口径正确",
		forgot.isError !== true && forgot.content[0].text.includes("停用") && forgot.content[0].text.includes("可恢复"),
		forgot.content[0].text,
	);
	const afterForget = await service!.getMemory({ id: memoryId });
	check("usageState=stopped", afterForget.ok === true && afterForget.memory.usageState === "stopped");
	check("停用产生新修订", afterForget.ok === true && afterForget.memory.currentRevision === 2);

	// ── 召回：如实报「语义召回尚未启用」 ──────────────────────────────
	const recalled = await callTool("pao_memory_recall", { query: "SQLite" });
	check("召回不报成功", recalled.content[0].text.includes("尚未启用"), recalled.content[0].text);
	check("召回不伪装空成功", !recalled.content[0].text.includes("无命中") || recalled.content[0].text.includes("尚未启用"));

	// ── 忘却不存在 ID：如实失败 ────────────────────────────────────────
	const forgotMissing = await callTool("pao_memory_forget", { memory_id: "mem-no-such", confirm: true });
	check("不存在 ID 报失败", forgotMissing.isError === true);

	// ── 取消检查点：写入前已 aborted ──────────────────────────────────
	const ctl = new AbortController();
	ctl.abort();
	const cancelled = await callTool("pao_memory_write", { content: "不应写入" }, ctl.signal);
	check("取消标记", cancelled.details?.cancelled === true);
	check("取消文本如实", cancelled.content[0].text.includes("取消"));

	// ── session_shutdown 收尾：服务关闭、采集卸载 ──────────────────────
	const shutdowns = handlers.get("session_shutdown") ?? [];
	for (const h of shutdowns) await h();
	check("服务已关闭", (registration as { service?: { opened?: boolean } }).service?.opened === false);
	check("采集钩子已卸载", (handlers.get("turn_end") ?? []).length === 0 && (handlers.get("agent_settled") ?? []).length === 0);

	// 重复关闭幂等
	for (const h of shutdowns) await h();
	check("重复 shutdown 幂等", true);

	// ── 配置缺失：静默不装 ────────────────────────────────────────────
	const home2 = mkdtempSync(join(tmpdir(), "pao-mem-e2-"));
	const registration2 = registerMemory(pi as never, { resolvePaoHome: () => home2 });
	check("无配置静默不装", registration2 === undefined);
	rmSync(home2, { recursive: true, force: true });
} catch (error) {
	failed++;
	console.log(`FATAL ${error instanceof Error ? error.stack : String(error)}`);
} finally {
	rmSync(home, { recursive: true, force: true });
}
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
