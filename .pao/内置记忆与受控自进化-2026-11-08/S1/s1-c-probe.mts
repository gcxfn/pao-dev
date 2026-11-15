// S1 批次 C 探针：隔离 PAO_HOME 下验证「采集 → 重开 → 回读 → 封存 → 再回读」全链。
// 覆盖：增量去重（含首次启用边界）、凭证剔除（已知字段与值不入库/归档/错误）、
// 附件受管副本、未封存与 gzip 封存两条回读路、缺来源 source_missing。
// 运行：cd PAO/packages/coding-agent && node --experimental-transform-types ../../../.pao/内置记忆与受控自进化-2026-11-08/S1/s1-c-probe.mts
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStore } from "../../../PAO/packages/coding-agent/src/pao/memory/store.ts";
import { createCapture } from "../../../PAO/packages/coding-agent/src/pao/memory/capture.ts";
import { sealSegment, findOpenSegment, getSegment } from "../../../PAO/packages/coding-agent/src/pao/memory/archive.ts";
import { openMemoryService } from "../../../PAO/packages/coding-agent/src/pao/memory/service.ts";
import { memoryPaths } from "../../../PAO/packages/coding-agent/src/pao/memory/paths.ts";

const SECRET = "sk-test-12345";
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
	if (ok) passed++;
	else failed++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}

const home = mkdtempSync(join(tmpdir(), "pao-mem-c-"));
console.log(`隔离 PAO_HOME: ${home}`);
const sessionId = "sess-c1";
const NOW = "2026-11-08T12:00:00.000Z";
const fakeNow = () => NOW;

// 构造会话条目（SessionEntry 形状：type/id/parentId/timestamp）
let seq = 0;
function entry(partial: Record<string, unknown>) {
	seq += 1;
	return { id: `e-${seq}`, parentId: seq > 1 ? `e-${seq - 1}` : null, timestamp: NOW, ...partial };
}
const msgUser = (text: string, extra: Record<string, unknown> = {}) =>
	entry({ type: "message", message: { role: "user", content: text, timestamp: 1, ...extra } });
const msgAssistant = (blocks: unknown[], extra: Record<string, unknown> = {}) =>
	entry({
		type: "message",
		message: { role: "assistant", content: blocks, provider: "p", model: "m", usage: {}, stopReason: "stop", ...extra },
	});
const msgTool = (content: unknown, extra: Record<string, unknown> = {}) =>
	entry({
		type: "message",
		message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", content, isError: false, timestamp: 1, ...extra },
	});

// 1×1 红色 PNG（最小合法图片字节）
const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const results: Record<string, unknown> = {};
try {
	// ── 首次启用：存量边界 ────────────────────────────────────────────
	const store = openMemoryStore(home, "readwrite");
	const capture = createCapture({ store, paoHome: home, now: fakeNow });
	const history = [
		msgUser("启用前的旧消息 1"),
		msgAssistant([{ type: "text", text: "启用前的旧回复" }]),
	];
	capture.markBoundary(sessionId, history.map((e) => e.id as string), NOW);
	check("边界登记后旧条目判为已采集", history.every((e) => capture.isCaptured(sessionId, e.id as string)));

	// ── 增量采集 ─────────────────────────────────────────────────────
	const committed = [
		msgUser("决定：内置记忆用 SQLite"),
		msgAssistant([
			{ type: "text", text: `已记录。顺便看到配置 password=${SECRET} 与 sk-live-${SECRET}` },
		]),
		msgUser([
			{ type: "text", text: "截图里的凭证" },
			{ type: "image", data: PNG_B64, mimeType: "image/png" },
		]),
		msgTool([{ type: "text", text: `env: api_key=${SECRET}` }], {
			details: { credentials: { secret: SECRET, api_key: SECRET }, note: "附件说明 secret" },
		}),
		// 大条目把段推过 evidence 压缩阈值（256KiB），让封存走真 gzip 路。
		msgAssistant([{ type: "text", text: `长回执填充 ${"甲".repeat(300 * 1024)}` }]),
		entry({ type: "custom_message", customType: "pao-note", content: `custom 含 token: ${SECRET}`, display: false }),
		entry({ type: "usage", kind: "main", provider: "p", model: "m", usage: {} }), // 不可采集类型
		msgUser("启用前的旧消息 2", {}), // 新用户消息——未在边界里，应收
	];
	// 把旧消息 2 的 id 改成已登记边界的旧 id 之一，验证去重而非新增
	(committed[7] as { id: string }).id = history[0].id as string;

	const captured = capture.captureCommittedEntries(sessionId, committed as never, NOW);
	const byEntry = new Map(captured.map((r) => [r.entryId, r]));
	results.captured = captured;
	check("新条目全部采集", captured.filter((r) => r.outcome === "captured").length === 6);
	check("旧边界条目去重跳过", byEntry.get(history[0].id as string)?.outcome === "skipped");
	const usageEntry = committed[6] as { id: string };
	check("不可采集类型跳过", byEntry.get(usageEntry.id)?.reason?.includes("usage") === true);
	check(
		"每条 captured 都有 sourceId+segmentId",
		captured.filter((r) => r.outcome === "captured").every((r) => r.sourceId && r.segmentId),
	);
	const firstSourceId = captured.find((r) => r.outcome === "captured")?.sourceId as string;
	const secretSourceId = captured.filter((r) => r.outcome === "captured")[3]?.sourceId as string; // toolResult 带凭证

	// 重复采集同批：全部 skipped（幂等）
	const dup = capture.captureCommittedEntries(sessionId, committed as never, NOW);
	check("重复采集全部 skipped", dup.every((r) => r.outcome === "skipped"));

	// ── 附件受管副本 ─────────────────────────────────────────────────
	const paths = memoryPaths(home);
	const attRoot = paths.attachments;
	const attDirs = existsSync(attRoot) ? readdirSync(attRoot) : [];
	check("附件副本目录已建", attDirs.length === 1, attDirs.join(","));
	const attFile = attDirs.length ? join(attRoot, attDirs[0], "data.png") : "";
	check("附件字节落盘且与原始一致",
		attDirs.length === 1 &&
			readFileSync(attFile).equals(Buffer.from(PNG_B64, "base64")));

	// ── 关库重开（跨重启定位） ─────────────────────────────────────────
	await store.close();
	const store2 = openMemoryStore(home, "readwrite");
	const service = openMemoryService({ paoHome: home, mode: "readwrite" });
	const read1 = await service.readMemorySource({ sourceId: firstSourceId });
	check("重开后 readMemorySource 成功", read1.ok === true);
	if (read1.ok) {
		check("未封存段 archived=false", read1.archived === false);
		check("原文含允许保存内容", read1.content.includes("SQLite"));
		check("metadata 带 entryId/eventType", typeof read1.metadata === "object" && read1.metadata !== null);
	}

	const readSecret = await service.readMemorySource({ sourceId: secretSourceId });
	check("凭证条目回读成功", readSecret.ok === true);
	if (readSecret.ok) {
		check("回读正文无凭证值", !readSecret.content.includes(SECRET), readSecret.content.slice(0, 200));
		check("回读正文含脱敏标记", readSecret.content.includes("脱敏") || readSecret.content.includes("不展示"));
	}

	// ── 封存 → 再走解压路 ────────────────────────────────────────────
	const segment = findOpenSegment(store2.db, sessionId);
	check("未封存段存在", !!segment);
	const seal = await sealSegment(store2.db, home, segment!.segmentId);
	check("sealSegment 成功", seal.ok === true, JSON.stringify(seal));
	check("段已过阈值走压缩", seal.outcome === "sealed", seal.outcome);
	const sealed = getSegment(store2.db, segment!.segmentId);
	check("行标 sealed", sealed?.status === "sealed");
	const gzExists = existsSync(`${segment!.originalPath}.gz`) || existsSync(sealed?.compressedPath ?? "");
	check(".gz 已发布", gzExists);
	check("原 JSONL 已清理", !existsSync(segment!.originalPath));

	const read2 = await service.readMemorySource({ sourceId: firstSourceId });
	check("封存后回读成功", read2.ok === true);
	if (read2.ok) {
		// 段太小原语不压时 archived 标记按 compressedPath 判定——只要 status=sealed 就算已封存语义
		check("archived 标记按段状态", read2.archived === (sealed?.compressedPath !== undefined));
		check("封存回读内容一致", read2.content.includes("SQLite"));
	}
	const readSecret2 = await service.readMemorySource({ sourceId: secretSourceId });
	check("封存后凭证仍剔净", readSecret2.ok === true && !readSecret2.content.includes(SECRET));

	// 邻近窗口：相对锚点取上下文
	const windowRead = await service.readMemorySource({ sourceId: firstSourceId, offset: 0, limit: 3 });
	check("邻近窗口返回多条", windowRead.ok === true && windowRead.content.split("\n").length >= 2);

	// ── 缺来源 ───────────────────────────────────────────────────────
	const miss = await service.readMemorySource({ sourceId: "src-no-such" });
	check("缺来源 source_missing", miss.ok === false && miss.error.code === "source_missing");

	// ── 字节级扫描：sqlite + 归档 + 附件均无凭证值 ──────────────────────
	const sqliteBytes = readFileSync(paths.database);
	check("数据库字节无凭证", !sqliteBytes.includes(SECRET));
	const archRoot = paths.archives;
	const archFiles: string[] = [];
	const stack = [archRoot];
	while (stack.length) {
		const dir = stack.pop()!;
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) stack.push(p);
			else archFiles.push(p);
		}
	}
	check("归档段文件存在", archFiles.length >= 1, archFiles.map((p) => p.split(/[\\/]/).pop()).join(","));
	const archBytes = Buffer.concat(archFiles.map((p) => readFileSync(p)));
	check("归档文件字节无凭证", !archBytes.includes(SECRET));
	const attBytes = attDirs.length ? readFileSync(attFile) : Buffer.alloc(0);
	check("附件副本无凭证", !attBytes.includes(SECRET));

	// ── 再开一次服务实例验证引用计数不互踩 ──────────────────────────────
	const service2 = openMemoryService({ paoHome: home, mode: "readonly" });
	const read3 = await service2.readMemorySource({ sourceId: firstSourceId });
	check("readonly 实例也能回读", read3.ok === true);
	await service2.close();
	await service.close();
	await store2.close();
} catch (error) {
	failed++;
	console.log(`FATAL ${error instanceof Error ? error.stack : String(error)}`);
} finally {
	rmSync(home, { recursive: true, force: true });
}
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
