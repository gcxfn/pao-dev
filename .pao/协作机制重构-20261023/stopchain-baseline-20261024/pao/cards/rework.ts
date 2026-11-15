/** 审核范围内的返修保留原卡；普通改状态仍不能重开已交付终态。 */
import { writeFileAtomic } from "../shared/atomic.ts";
import { readCard, serializeCard } from "./cardfile.ts";
import { checkTransition, checkWriterAuthority } from "./statemachine.ts";
import type { ParsedCard } from "./types.ts";

export function reopenForReview(input: {
	card: ParsedCard;
	operator: string;
	oldMarker: string;
	newMarker: string;
	reason: string;
	time: string;
}): void {
	const latest = readCard(input.card.path);
	if (
		latest.frontmatter.attempt !== input.card.frontmatter.attempt ||
		latest.frontmatter.status !== input.card.frontmatter.status ||
		!input.reason.trim() ||
		!latest.body.includes(input.oldMarker)
	)
		throw new Error("返修卡的尝试、状态或流程身份已改变；保留现场核查");
	if (latest.frontmatter.status !== "delivered") throw new Error("审核返修仅重开已交付卡");
	checkWriterAuthority(latest.frontmatter, input.operator, "unclaimed");
	// 沿用原卡累计尝试上限，不能用新轮次或新卡绕过。
	checkTransition({ from: "failed", to: "unclaimed", 尝试: latest.frontmatter.attempt });
	latest.frontmatter.status = "unclaimed";
	delete latest.frontmatter.completed;
	const body = `${latest.body.replace(input.oldMarker, input.newMarker).trimEnd()}\n\n## 审核返修 ${input.time}\n- 原因: ${JSON.stringify(input.reason)}\n- 保留尝试: ${latest.frontmatter.attempt}；下次实际启动才递增\n`;
	writeFileAtomic(latest.path, serializeCard(latest.frontmatter, body));
}
