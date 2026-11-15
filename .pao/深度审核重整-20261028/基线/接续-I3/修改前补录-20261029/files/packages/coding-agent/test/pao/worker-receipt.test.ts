import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	absorbEvent,
	buildSummary,
	createEventState,
	diagnoseWorkerFinalReceipt,
	parseWorkerFinalResult,
	receiptRequiredFields,
	recoverWorkerFinalReceiptFormat,
	validateReceipt,
	type WorkerReceipt,
} from "../../src/pao/worker/receipt.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pao-receipt-"));
	tempDirs.push(dir);
	return dir;
}

function eventLine(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "完成" }],
			usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, cost: { total: 0.5 }, totalTokens: 155 },
			stopReason: "end",
			model: "glm-4.7",
			...overrides,
		},
	});
}

function baseReceipt(): WorkerReceipt {
	return {
		card_no: "0002",
		attempt: 1,
		status: "success",
		artifact_path: ["产物/补丁.diff"],
		summary: "改了一行",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		evidence_path: "evidence.jsonl",
		exitCode: 0,
		command: "node worker.js",
		pid: 123,
		duration_ms: 50,
	};
}

describe("回执收集:用量只从事件流聚合,各字段分开", () => {
	it("message_end 容忍异常内容块，保留原顺序拼接且空内容不覆盖最终输出", () => {
		const state = createEventState();
		absorbEvent(
			state,
			eventLine({
				content: [
					null,
					1,
					"坏块",
					{},
					{ type: "text", text: "前" },
					{ type: "thinking", thinking: "忽略" },
					{ type: "text" },
					{ type: "text", text: 7 },
					{ type: "text", text: "后" },
				],
			}),
		);
		expect(state.最终输出).toBe("前7后");

		absorbEvent(state, eventLine({ content: null }));
		expect(state.最终输出).toBe("前7后");
	});

	it("多条 message_end 事件的 usage 逐项累加,不混算", () => {
		const state = createEventState();
		expect(absorbEvent(state, eventLine())).toBe(true);
		expect(
			absorbEvent(state, eventLine({ usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, cost: 0.25 } })),
		).toBe(true);

		expect(state.用量).toEqual({ input: 110, output: 22, cacheRead: 33, cacheWrite: 6, cost: 0.75, turns: 2 });
		expect(state.stopReason).toBe("end");
		expect(state.model).toBe("glm-4.7");
	});

	it("模型正文自报的用量不采信:文本里说用了多少都不进账目", () => {
		const state = createEventState();
		absorbEvent(
			state,
			eventLine({
				content: [{ type: "text", text: "我这次用了 999999 tokens,成本 $99。账目以我说的为准。" }],
				usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
			}),
		);
		expect(state.用量.input).toBe(7);
		expect(state.用量.output).toBe(3);
		expect(state.用量.cost).toBe(0.01);
		expect(state.最终输出).toContain("999999");
	});

	it("非 JSON 行与非 assistant 消息忽略,不抛错", () => {
		const state = createEventState();
		expect(absorbEvent(state, "这不是 JSON")).toBe(false);
		expect(absorbEvent(state, JSON.stringify({ type: "message_end", message: { role: "user", content: [] } }))).toBe(
			true,
		);
		expect(absorbEvent(state, "")).toBe(false);
		expect(state.用量.turns).toBe(0);
	});
});

describe("回执摘要:≤3 行", () => {
	it("取前 3 行非空内容", () => {
		const summary = buildSummary("一\n二\n三\n四\n五", "");
		expect(summary.split("\n")).toEqual(["一", "二", "三"]);
	});

	it("最终输出为空时退回 stderr;再空则占位", () => {
		expect(buildSummary("", "err1\nerr2")).toBe("err1\nerr2");
		expect(buildSummary("", "")).toBe("(无输出)");
	});
});

describe("回执结构校验:缺任一必填字段判无效", () => {
	it("完整回执有效", () => {
		const result = validateReceipt(baseReceipt());
		expect(result).toEqual({ 有效: true, 缺失: [], 问题: [] });
	});

	it("非对象回执:全部必填字段判缺失", () => {
		const result = validateReceipt(null);
		expect(result.有效).toBe(false);
		expect(result.缺失).toEqual(receiptRequiredFields);
	});

	it("逐项删字段:卡号/尝试/用量/证据路径/摘要 缺失即无效", () => {
		for (const key of ["card_no", "attempt", "usage", "evidence_path", "summary"] as const) {
			const receipt = baseReceipt() as unknown as Record<string, unknown>;
			delete receipt[key];
			const result = validateReceipt(receipt);
			expect(result.有效, key).toBe(false);
			expect(result.缺失, key).toContain(key);
		}
	});

	it("摘要超 3 行、状态不在四值内、用量字段非法:判问题", () => {
		expect(validateReceipt({ ...baseReceipt(), summary: "1\n2\n3\n4" }).问题).toContain("summary 超过 3 行");
		expect(validateReceipt({ ...baseReceipt(), status: "部分完成" }).问题).toContain("status");
		expect(validateReceipt({ ...baseReceipt(), usage: { ...baseReceipt().usage, cost: -1 } }).问题).toContain(
			"usage.cost 不是非负数",
		);
	});

	it("产物路径必须是字符串数组", () => {
		expect(validateReceipt({ ...baseReceipt(), artifact_path: "产物" }).问题).toContain("artifact_path");
		expect(validateReceipt({ ...baseReceipt(), artifact_path: [] }).有效).toBe(true);
	});
});

describe("最终回执格式诊断:严格入口不放宽", () => {
	const strict = JSON.stringify({
		result: "success",
		artifact_path: [],
		summary: "完成",
		任务态: "completed",
	});

	it("前后说明包着唯一 json 围栏时，正式解析仍拒收，诊断保留原始证据并识别同一对象", () => {
		const raw = `执行结果如下：\n\`\`\`json\n${strict}\n\`\`\`\n以上为回执。`;
		expect(() => parseWorkerFinalResult(raw, process.cwd())).toThrow("缺少有效 JSON");
		const diagnosis = diagnoseWorkerFinalReceipt(raw, process.cwd());
		expect(diagnosis.kind).toBe("fenced");
		if (diagnosis.kind !== "fenced") expect.unreachable();
		expect(diagnosis.rawText).toBe(raw);
		expect(diagnosis.receiptText).toBe(strict);
		expect(diagnosis.parsed).toMatchObject({ result: "success", summary: "完成", 任务态: "completed" });
	});

	it("唯一 json 回执围栏可以与普通命令代码块并存", () => {
		const raw = `检查命令：\n\`\`\`\ncd /app && npm test\n\`\`\`\n最终回执：\n\`\`\`json\n${strict}\n\`\`\`\n以上。`;
		expect(() => parseWorkerFinalResult(raw, process.cwd())).toThrow("缺少有效 JSON");
		const diagnosis = diagnoseWorkerFinalReceipt(raw, process.cwd());
		expect(diagnosis).toMatchObject({
			kind: "fenced",
			rawText: raw,
			receiptText: strict,
			parsed: { result: "success", artifact_path: [], summary: "完成", 任务态: "completed" },
			strictError: expect.stringContaining("缺少有效 JSON"),
		});
	});

	it("普通说明里的 CSS 花括号和命令示例 JSON 不算额外回执候选", () => {
		const raw = `检查片段：<style>a{color:red} /* url(javascript:x) */ b{margin:0}</style>；属性 [onerror]。\n命令：\n\`\`\`sh\necho '{"ok":true}'\n\`\`\`\n最终回执：\n\`\`\`json\n${strict}\n\`\`\``;
		expect(diagnoseWorkerFinalReceipt(raw, process.cwd())).toMatchObject({
			kind: "fenced",
			receiptText: strict,
			parsed: { result: "success", artifact_path: [], summary: "完成" },
		});
	});

	it("普通说明和行内代码中的多个 CSS 空规则不计候选，唯一 json 围栏仍可恢复", () => {
		const raw = `规则边界 \`{}\`，片段 <style>a{}</style>，另一处 \`b{}\`。\n最终回执：\n\`\`\`json\n${strict}\n\`\`\``;
		expect(diagnoseWorkerFinalReceipt(raw, process.cwd())).toMatchObject({
			kind: "fenced",
			receiptText: strict,
			parsed: { result: "success", artifact_path: [], summary: "完成" },
		});
		expect(() => diagnoseWorkerFinalReceipt("```json\n{}\n```", process.cwd())).toThrow("严格 schema");
		expect(() => diagnoseWorkerFinalReceipt("```\n{}\n```", process.cwd())).toThrow("严格 schema");
		expect(() =>
			diagnoseWorkerFinalReceipt(`空对象 {"result":success}\n\`\`\`json\n${strict}\n\`\`\``, process.cwd()),
		).toThrow("找到 2 个");
		expect(() =>
			diagnoseWorkerFinalReceipt(`\`\`\`\n{"result":success}\n\`\`\`\n\`\`\`json\n${strict}\n\`\`\``, process.cwd()),
		).toThrow("找到 2 个");
	});

	it("普通说明、多个非回执代码块和唯一裸 JSON 可以并存", () => {
		const raw = `先看命令：\n\`\`\`sh\nprintf '%s\\n' ok\n\`\`\`\n再看向量：\n~~~text\n[不是 JSON]\n~~~\n最终：\n${strict}\n以上。`;
		expect(diagnoseWorkerFinalReceipt(raw, process.cwd())).toMatchObject({
			kind: "bare",
			receiptText: strict,
			parsed: { result: "success", artifact_path: [], summary: "完成" },
		});
	});

	it("普通说明文字包着唯一完整裸对象时，严格入口仍拒收，同次诊断按 bare 恢复全部自报字段", () => {
		const rich = {
			result: "success",
			artifact_path: [],
			summary: '完成 {花括号}、[方括号] 与 "转义引号" 检查',
			任务态: "completed",
			verification: [
				{
					条件: "核对嵌套对象 {verification}",
					结论: "pass",
					证据: '证据含 "{大括号}"、[]、\\反斜杠\\ 和 "引号"',
				},
			],
			changes: [{ 路径: "src/[demo]/{demo}.ts", 类型: "modified", 说明: '改动说明含 [] 和 "引号"' }],
		};
		const receiptText = JSON.stringify(rich);
		const raw = `执行结果如下：\n${receiptText}\n以上为回执。`;
		expect(() => parseWorkerFinalResult(raw, process.cwd())).toThrow("缺少有效 JSON");
		const diagnosis = diagnoseWorkerFinalReceipt(raw, process.cwd());
		expect(diagnosis).toMatchObject({
			kind: "bare",
			rawText: raw,
			receiptText,
			strictError: expect.stringContaining("缺少有效 JSON"),
		});
		expect(diagnosis.parsed).toEqual(rich);
		expect(recoverWorkerFinalReceiptFormat(raw, process.cwd())).toMatchObject({
			kind: "bare",
			parsed: rich,
			receiptText,
		});
	});

	it("围栏外每个明确像 JSON 的尝试都计候选，坏候选不能因解析失败被跳过；内层字段数组不重复计数", () => {
		const inlineRaw = `执行结果如下。${strict}以上为回执。`;
		expect(diagnoseWorkerFinalReceipt(inlineRaw, process.cwd())).toMatchObject({
			kind: "bare",
			rawText: inlineRaw,
			receiptText: strict,
			parsed: { result: "success", artifact_path: [], summary: "完成" },
		});
		const malformed = [
			'说明{"result":success}',
			"说明{'result':success}",
			"说明[{result:success}]",
			'说明[,"result"]',
			"说明[1e,2]",
			"说明[truex]",
		];
		for (const beforeFence of malformed) {
			expect(() =>
				diagnoseWorkerFinalReceipt(`${beforeFence}\n\`\`\`json\n${strict}\n\`\`\``, process.cwd()),
			).toThrow("找到 2 个");
		}
		const cwd = tempDir();
		writeFileSync(join(cwd, "a.txt"), "a", "utf8");
		writeFileSync(join(cwd, "b.txt"), "b", "utf8");
		const rich = {
			result: "success",
			artifact_path: ["a.txt", "b.txt"],
			summary: "嵌套结构",
			verification: [{ 条件: "检查", 结论: "pass", 证据: "证据" }],
			changes: [
				{ 路径: "a.txt", 类型: "created" },
				{ 路径: "b.txt", 类型: "modified" },
			],
		};
		const receiptText = JSON.stringify(rich);
		const raw = `执行结果：${receiptText}以上。`;
		expect(diagnoseWorkerFinalReceipt(raw, cwd)).toMatchObject({
			kind: "bare",
			receiptText,
			parsed: rich,
		});
	});

	it("普通说明中的 CSS、HTML 花括号和未标语言 shell 判断不计候选，并测试围栏边界", () => {
		const shellRaw = `检查命令：\n\`\`\`\n[ "$status" -eq 0 ]\n\`\`\`\n最终回执：\n\`\`\`json\n${strict}\n\`\`\``;
		expect(diagnoseWorkerFinalReceipt(shellRaw, process.cwd())).toMatchObject({
			kind: "fenced",
			receiptText: strict,
		});
		const raw = `<style>.a{color:red}.b{margin:0}</style><div data-x="{demo}">x</div> 普通数组 [demo] 和对象 {demo}。\n\`\`\`\n[ "$status" -eq 0 ] && { echo ok; }\n\`\`\`\n回执：${strict}`;
		expect(diagnoseWorkerFinalReceipt(raw, process.cwd())).toMatchObject({
			kind: "bare",
			receiptText: strict,
		});
		expect(() =>
			diagnoseWorkerFinalReceipt(`\`\`\`json\nnot-json\n\`\`\`\n\`\`\`json\n${strict}\n\`\`\``, process.cwd()),
		).toThrow("找到 2 个");
		expect(
			diagnoseWorkerFinalReceipt(
				`\`\`\`\n[ "$status" -eq 0 ]\n\`\`\`\n\`\`\`json\n${strict}\n\`\`\``,
				process.cwd(),
			),
		).toMatchObject({ kind: "fenced", receiptText: strict });
		expect(() =>
			diagnoseWorkerFinalReceipt(`\`\`\`\n{"result":success}\n\`\`\`\n\`\`\`json\n${strict}\n\`\`\``, process.cwd()),
		).toThrow("找到 2 个");
	});

	it("围栏外明确像 JSON 的数组尝试都计候选，普通括号说明不计，残缺值直接失败", () => {
		expect(() => diagnoseWorkerFinalReceipt(`说明[[1,2]]\n\`\`\`json\n${strict}\n\`\`\``, process.cwd())).toThrow(
			"找到 2 个",
		);
		expect(() =>
			diagnoseWorkerFinalReceipt(`说明[{"nested":true}]\n\`\`\`json\n${strict}\n\`\`\``, process.cwd()),
		).toThrow("找到 2 个");
		expect(() => diagnoseWorkerFinalReceipt(`说明[1,2]\n\`\`\`json\n${strict}\n\`\`\``, process.cwd())).toThrow(
			"找到 2 个",
		);
		expect(diagnoseWorkerFinalReceipt(`说明[方括号]\n\`\`\`json\n${strict}\n\`\`\``, process.cwd())).toMatchObject({
			kind: "fenced",
			receiptText: strict,
		});
		expect(() => diagnoseWorkerFinalReceipt(`说明{"result":"success"`, process.cwd())).toThrow("结构未闭合");
		expect(() => diagnoseWorkerFinalReceipt(`说明{"result":"success"]`, process.cwd())).toThrow("结构符不配对");
	});

	it("围栏边界只计数完整且明确的回执候选", () => {
		const nested = `\`\`\`json\n\`\`\`json\n${strict}\n\`\`\`\n\`\`\``;
		expect(() => diagnoseWorkerFinalReceipt(nested, process.cwd())).toThrow("嵌套代码围栏");
		const unclosed = `完成：\n\`\`\`json\n${strict}`;
		expect(() => diagnoseWorkerFinalReceipt(unclosed, process.cwd())).toThrow("围栏未闭合");
		const malformedDollar = `\`\`\`\n$status\n\`\`\`\n\`\`\`json\n${strict}\n\`\`\``;
		expect(diagnoseWorkerFinalReceipt(malformedDollar, process.cwd())).toMatchObject({
			kind: "fenced",
			receiptText: strict,
		});
		const unlabelledShell = `\`\`\`\n[ "$status" -eq 0 ]\n\`\`\`\n\`\`\`json\n${strict}\n\`\`\``;
		expect(diagnoseWorkerFinalReceipt(unlabelledShell, process.cwd())).toMatchObject({
			kind: "fenced",
			receiptText: strict,
		});
		const pseudo = `完成：\`\`\`json ${strict} \`\`\``;
		expect(() => diagnoseWorkerFinalReceipt(pseudo, process.cwd())).toThrow("伪代码围栏");
	});

	it.each([
		["多个裸对象", `完成：\n${strict}\n另一个：\n${strict}`, "找到 2 个"],
		["同一行两个裸对象", `${strict} ${strict}`, "找到 2 个"],
		["数组包装", `完成：[${strict}]`, "最终回执必须为对象"],
		["数组说明在前", `完成：["说明", ${strict}]`, "最终回执必须为对象"],
		["数组说明在后", `完成：[${strict}, "说明"]`, "最终回执必须为对象"],
		["嵌套数组", `完成：[["说明", ${strict}]]`, "最终回执必须为对象"],
		["残缺对象", '完成：{"result":"success","artifact_path":[],"summary":"未闭合"', "结构未闭合"],
		["未闭合围栏", `完成：\n\`\`\`json\n${strict}`, "围栏未闭合"],
		["嵌套围栏", `\`\`\`json\n\`\`\`json\n${strict}\n\`\`\`\n\`\`\``, "嵌套代码围栏"],
		["伪围栏", `完成：\`\`\`json ${strict} \`\`\`。`, "伪代码围栏"],
		["坏 JSON", '完成：{"result":success,"artifact_path":[],"summary":"键未加引号"}', "缺少有效 JSON"],
		["坏 schema", '完成：{"result":"success","artifact_path":[],"summary":"x","changes":"bad"}', "严格 schema"],
		["缺字段", '完成：{"result":"success","artifact_path":[]}', "summary"],
		["额外结构化包装", `完成：{"receipt":${strict}}`, "result"],
		[
			"声明产物不存在",
			'完成：{"result":"success","artifact_path":["不存在-r32-裸对象.txt"],"summary":"虚报"}',
			"产物不存在",
		],
		["failed 缺失败事实", '完成：{"result":"failed","artifact_path":[],"summary":"失败"}', "failure_type"],
		["unknown 缺失败事实", '完成：{"result":"unknown","artifact_path":[],"summary":"未知"}', "failure_type"],
	])("%s时拒绝裸对象恢复", (_name, raw, message) => {
		expect(() => diagnoseWorkerFinalReceipt(raw, process.cwd())).toThrow(message);
		expect(recoverWorkerFinalReceiptFormat(raw, process.cwd())).toBeUndefined();
	});

	it("多个 JSON 候选、围栏 schema 错误或缺少回执都拒绝恢复", () => {
		expect(() =>
			diagnoseWorkerFinalReceipt(`\`\`\`json\n${strict}\n\`\`\`\n\`\`\`json\n${strict}\n\`\`\``, process.cwd()),
		).toThrow("找到 2 个");
		expect(() =>
			diagnoseWorkerFinalReceipt(
				`\`\`\`json\n${strict}\n\`\`\`\n\`\`\`json\n{"result":success}\n\`\`\``,
				process.cwd(),
			),
		).toThrow("找到 2 个");
		expect(() =>
			diagnoseWorkerFinalReceipt(
				`\`\`\`json\n${strict}\n\`\`\`\n伪回执：{"result":success,"artifact_path":[],"summary":"坏"}`,
				process.cwd(),
			),
		).toThrow("找到 2 个");
		expect(() =>
			diagnoseWorkerFinalReceipt(
				'```json\n{"result":"success","artifact_path":[],"summary":"x","changes":"bad"}\n```',
				process.cwd(),
			),
		).toThrow("严格 schema");
		expect(diagnoseWorkerFinalReceipt(strict, process.cwd())).toMatchObject({ kind: "strict", rawText: strict });
	});

	it("恢复时仍核验声明产物真实存在；字符串中的括号、转义引号和嵌套结构原样解析", () => {
		const cwd = tempDir();
		writeFileSync(join(cwd, "真实产物.txt"), "ok", "utf8");
		const rich = {
			result: "success",
			artifact_path: ["真实产物.txt"],
			summary: '完成 {花括号}、[方括号] 与 "转义引号"',
			任务态: "completed",
			verification: [
				{
					条件: "核对 {verification:[嵌套]}",
					结论: "pass",
					证据: '证据含 "引号"、[]、{花括号}、\\\\反斜杠\\\\',
				},
				{ 条件: "changes 嵌套", 结论: "pass", 证据: '{"路径":"demo"}' },
			],
			changes: [
				{
					路径: "src/[demo]/{demo}.ts",
					类型: "modified",
					说明: '改动含 []、{} 与 "引号"',
				},
			],
		};
		const raw = `命令：\n\`\`\`sh\nnpm test\n\`\`\`\n回执：\n\`\`\`json\n${JSON.stringify(rich)}\n\`\`\``;
		expect(diagnoseWorkerFinalReceipt(raw, cwd)).toMatchObject({
			kind: "fenced",
			parsed: rich,
		});
		rmSync(join(cwd, "真实产物.txt"));
		expect(() => diagnoseWorkerFinalReceipt(raw, cwd)).toThrow("产物不存在");
		expect(recoverWorkerFinalReceiptFormat(raw, cwd)).toBeUndefined();
	});

	it("runner 恢复 helper 只返回唯一围栏或唯一裸对象候选及原错误，不把严格成功或坏 schema 当恢复", () => {
		const raw = `执行结果如下：\n\`\`\`json\n${strict}\n\`\`\`\n以上为回执。`;
		expect(recoverWorkerFinalReceiptFormat(raw, process.cwd())).toMatchObject({
			kind: "fenced",
			parsed: { result: "success", summary: "完成" },
			rawText: raw,
			receiptText: strict,
			strictError: expect.stringContaining("缺少有效 JSON"),
		});
		expect(recoverWorkerFinalReceiptFormat(strict, process.cwd())).toBeUndefined();
		expect(
			recoverWorkerFinalReceiptFormat(
				'```json\n{"result":"success","artifact_path":[],"summary":"x","changes":"bad"}\n```',
				process.cwd(),
			),
		).toBeUndefined();
		expect(
			recoverWorkerFinalReceiptFormat(`\`\`\`json\n${strict}\n\`\`\`\n\`\`\`json\n${strict}\n\`\`\``, process.cwd()),
		).toBeUndefined();
	});
});
