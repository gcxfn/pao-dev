import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCard, readCard } from "../../src/pao/cards/cardfile.ts";
import { changeCardStatus } from "../../src/pao/cards/statemachine.ts";
import { appendDispatchReceipt } from "../../src/pao/worker/dispatch-core.ts";
import type { WorkerReceipt } from "../../src/pao/worker/receipt.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runningCard() {
	const root = mkdtempSync(join(tmpdir(), "pao-dispatch-recovery-evidence-"));
	roots.push(root);
	const cardsDir = join(root, ".pao", "任务", "卡");
	mkdirSync(cardsDir, { recursive: true });
	const card = await createCard(cardsDir, {
		目标: "验证恢复证据落卡",
		部门: "测试",
		验收: "完成",
		创建: "2026-10-22 10:00",
	});
	return changeCardStatus(card, { 操作者: "测试", to: "in_progress", 时间: "2026-10-22 10:01" });
}

function receipt(evidencePath: string, recoveryEvidencePath: string): WorkerReceipt {
	return {
		card_no: "0001",
		attempt: 1,
		status: "success",
		artifact_path: [],
		summary: "格式恢复审计",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		evidence_path: evidencePath,
		receipt_format_recovery: {
			strict_error: "原始最后消息含说明文字",
			evidence_path: recoveryEvidencePath,
		},
		exitCode: 0,
		command: "offline",
		pid: -1,
		duration_ms: 1,
	} as WorkerReceipt & {
		receipt_format_recovery: { strict_error: string; evidence_path: string };
	};
}

describe("appendDispatchReceipt 格式恢复证据", () => {
	it("在事件流证据外追加恢复说明中的真实 JSON 证据，不改卡身份", async () => {
		const card = await runningCard();
		const evidenceDir = join(card.path, "..", "worker-evidence");
		mkdirSync(evidenceDir, { recursive: true });
		const workerEvidence = join(evidenceDir, "full.jsonl");
		const recoveryEvidence = join(evidenceDir, "recovery.json");
		writeFileSync(workerEvidence, `${JSON.stringify({ type: "message_end" })}\n`, "utf8");
		writeFileSync(
			recoveryEvidence,
			`${JSON.stringify({
				card_no: "0001",
				attempt: 1,
				strict_error: "原始最后消息含说明文字",
				original_evidence: workerEvidence,
				candidate_rule: "唯一完整 json 围栏",
			})}\n`,
			"utf8",
		);
		const outcome = await appendDispatchReceipt(
			card,
			receipt(workerEvidence, recoveryEvidence),
		);

		expect(outcome).toEqual({ kind: "已记录", 待审: true });
		const fresh = readCard(card.path);
		expect(fresh.frontmatter.status).toBe("in_progress");
		expect(fresh.frontmatter.attempt).toBe(1);
		expect(fresh.receipts[0]).toMatchObject({
			attempt: 1,
			result: "success",
			evidence: [workerEvidence, recoveryEvidence],
		});
		expect(existsSync(recoveryEvidence)).toBe(true);
		expect(JSON.parse(readFileSync(recoveryEvidence, "utf8"))).toMatchObject({
			card_no: "0001",
			attempt: 1,
			original_evidence: workerEvidence,
		});
	});

	it("格式恢复回执仍经过原产物守卫，失败时不写卡", async () => {
		const card = await runningCard();
		const invalid = {
			...receipt("worker-evidence/full.jsonl", "worker-evidence/recovery.json"),
			artifact_path: ["不存在.txt"],
		};

		await expect(appendDispatchReceipt(card, invalid)).rejects.toThrow("回执产物路径不存在");
		expect(readCard(card.path).receipts).toHaveLength(0);
	});
});
