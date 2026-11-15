/** 显式返修保留原卡；普通改状态仍不能重开已交付终态。 */
import { dirname } from "node:path";
import { writeFileAtomic } from "../shared/atomic.ts";
import { readCard, serializeCard } from "./cardfile.ts";
import { checkTransition, checkWriterAuthority } from "./statemachine.ts";
import type { CardStatus, ParsedCard } from "./types.ts";

function reopen(input: {
	card: ParsedCard;
	operator: string;
	oldMarker: string;
	newMarker: string;
	reason: string;
	time: string;
	heading: string;
	allowedStatuses: readonly CardStatus[];
}): void {
	const latest = readCard(input.card.path);
	if (
		latest.frontmatter.attempt !== input.card.frontmatter.attempt ||
		latest.frontmatter.status !== input.card.frontmatter.status ||
		!input.reason.trim() ||
		!input.heading.trim() ||
		!input.oldMarker.trim() ||
		!input.newMarker.trim() ||
		latest.body.split(input.oldMarker).length !== 2 ||
		(input.newMarker !== input.oldMarker && latest.body.includes(input.newMarker))
	)
		throw new Error("返修卡的尝试、状态或流程身份已改变；保留现场核查");
	if (!input.allowedStatuses.includes(latest.frontmatter.status))
		throw new Error(`返修入口不接受 ${latest.frontmatter.status} 状态卡`);
	checkWriterAuthority(latest.frontmatter, input.operator, "unclaimed");
	// 已交付卡不能走普通状态机；专用返修入口仍须沿用原卡累计尝试上限。
	checkTransition({
		from: latest.frontmatter.status === "delivered" ? "failed" : latest.frontmatter.status,
		to: "unclaimed",
		尝试: latest.frontmatter.attempt,
		卡号: latest.card_no,
		卡目录: dirname(latest.path),
	});
	latest.frontmatter.status = "unclaimed";
	delete latest.frontmatter.completed;
	const reopenedBody = latest.body.replace(input.oldMarker, input.newMarker);
	const body = `${reopenedBody.trimEnd()}\n\n## ${input.heading} ${input.time}\n- 原因: ${JSON.stringify(input.reason)}\n- 保留尝试: ${latest.frontmatter.attempt}；下次实际启动才递增\n`;
	writeFileAtomic(latest.path, serializeCard(latest.frontmatter, body));
}

export function reopenForReview(input: {
	card: ParsedCard;
	operator: string;
	oldMarker: string;
	newMarker: string;
	reason: string;
	time: string;
}): void {
	reopen({
		card: input.card,
		operator: input.operator,
		oldMarker: input.oldMarker,
		newMarker: input.newMarker,
		reason: input.reason,
		time: input.time,
		heading: "审核返修",
		allowedStatuses: ["delivered"],
	});
}

/** 当前节点轮次内显式重开原卡；不改流程标记、轮次、attempt、预算或历史。 */
export function reopenOriginalCard(input: {
	card: ParsedCard;
	operator: string;
	oldMarker: string;
	newMarker: string;
	reason: string;
	time: string;
}): void {
	reopen({
		card: input.card,
		operator: input.operator,
		oldMarker: input.oldMarker,
		newMarker: input.newMarker,
		reason: input.reason,
		time: input.time,
		heading: "原卡返修",
		allowedStatuses: ["delivered", "failed"],
	});
}
